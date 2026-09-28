import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createSkeletonData } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { validateDocument } from "../dist/spine/validate.js";

const geometry = { uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  vertices: [-16, -16, 16, -16, 16, 16, -16, 16], triangles: [0, 1, 2, 2, 3, 0], hull: 4 };

test("typed attachments and mesh weights stage atomically and preserve editor fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mesh-"));
  const path = join(directory, "rig.json");
  try {
    await createSkeletonData(path, "4.3");
    const edits = new EditStore();
    const original = await readFile(path, "utf8");
    const stage = await edits.preview(path, [
      { kind: "upsert_bone", name: "arm", parent: "root", values: { x: 8 } },
      { kind: "upsert_slot", name: "body", bone: "root", values: { attachment: "shirt" } },
      { kind: "upsert_attachment", skin: "default", slot: "body", name: "shirt", attachmentType: "mesh",
        values: { path: "shirt", ...geometry, width: 32, height: 32 } },
      { kind: "upsert_attachment", skin: "default", slot: "body", name: "target", attachmentType: "point",
        values: { x: 5, y: 3, rotation: 90 } },
      { kind: "upsert_attachment", skin: "default", slot: "body", name: "hitbox", attachmentType: "boundingbox",
        values: { vertexCount: 3, vertices: [-5, -5, 5, -5, 0, 5] } },
      { kind: "upsert_attachment", skin: "default", slot: "body", name: "mask", attachmentType: "clipping",
        values: { vertexCount: 3, vertices: [-5, -5, 5, -5, 0, 5], end: "body" } },
      { kind: "upsert_attachment", skin: "default", slot: "body", name: "shirt-copy", attachmentType: "linkedmesh",
        values: { parent: "shirt", path: "shirt", deform: false } },
    ]);
    assert.deepEqual(stage.diagnostics, []);
    assert.equal(await readFile(path, "utf8"), original);
    await edits.commit(stage.editId);
    const data = JSON.parse(await readFile(path, "utf8"));
    data.skins[0].attachments.body.shirt.editorNote = "retain";
    await writeFile(path, `${JSON.stringify(data)}\n`);
    const weighted = await edits.preview(path, [{ kind: "set_mesh_weights", skin: "default", slot: "body", name: "shirt",
      influences: Array.from({ length: 4 }, (_, i) => [
        { bone: "root", x: geometry.vertices[2 * i], y: geometry.vertices[2 * i + 1], weight: 0.5 },
        { bone: "arm", x: geometry.vertices[2 * i] - 8, y: geometry.vertices[2 * i + 1], weight: 0.5 },
      ]) }]);
    assert.equal(weighted.summaries[0].weighted, true);
    await edits.commit(weighted.editId);
    const after = await readDocument(path);
    assert.deepEqual(validateDocument(after), []);
    assert.deepEqual(after.data.skins[0].attachments.body.shirt.vertices.slice(0, 9), [2, 0, -16, -16, 0.5, 1, -24, -16, 0.5]);
    assert.equal(after.data.skins[0].attachments.body.shirt.editorNote, "retain");
    await assert.rejects(edits.preview(path, [{ kind: "set_mesh_weights", skin: "default", slot: "body", name: "shirt",
      influences: Array.from({ length: 4 }, () => [{ bone: "arm", x: 0, y: 0, weight: 0.8 }]) }]), { code: "INVALID_MESH_WEIGHTS" });
    await assert.rejects(edits.preview(path, [{ kind: "set_mesh_geometry", skin: "default", slot: "body", name: "shirt",
      uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], hull: 3 }]),
    { code: "MESH_TOPOLOGY_IN_USE" });
    const deformed = JSON.parse(await readFile(path, "utf8"));
    deformed.animations.flex = { attachments: { default: { body: { shirt: {
      deform: [{ time: 0, vertices: Array(16).fill(0) }],
    } } } } };
    await writeFile(path, `${JSON.stringify(deformed)}\n`);
    assert.deepEqual(validateDocument(await readDocument(path)), []);
    await assert.rejects(edits.preview(path, [{ kind: "set_mesh_weights", skin: "default", slot: "body", name: "shirt",
      influences: Array.from({ length: 4 }, () => [{ bone: "root", x: 0, y: 0, weight: 1 }]) }]),
    { code: "MESH_DEFORM_IN_USE" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mesh edits protect deform timelines and reject incomplete topology", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mesh-deform-"));
  const path = join(directory, "rig.json");
  try {
    await createSkeletonData(path, "4.2");
    const edits = new EditStore();
    const stage = await edits.preview(path, [
      { kind: "upsert_bone", name: "arm", parent: "root" },
      { kind: "upsert_slot", name: "body", bone: "root", values: { attachment: "shirt" } },
      { kind: "upsert_attachment", skin: "default", slot: "body", name: "shirt", attachmentType: "mesh",
        values: geometry },
    ]);
    await edits.commit(stage.editId);
    const data = JSON.parse(await readFile(path, "utf8"));
    data.animations.wave = { deform: { default: { body: { shirt: [{ time: 0, vertices: [0, 0, 0, 0, 0, 0, 0, 0] }] } } } };
    await writeFile(path, `${JSON.stringify(data)}\n`);
    assert.deepEqual(validateDocument(await readDocument(path)), []);
    await assert.rejects(edits.preview(path, [{ kind: "set_mesh_weights", skin: "default", slot: "body", name: "shirt",
      influences: Array.from({ length: 4 }, () => [
        { bone: "root", x: 0, y: 0, weight: 0.5 }, { bone: "arm", x: 0, y: 0, weight: 0.5 }]) }]),
    { code: "MESH_DEFORM_IN_USE" });
    await assert.rejects(edits.preview(path, [{ kind: "upsert_attachment", skin: "default", slot: "body", name: "shirt",
      attachmentType: "mesh", values: { triangles: [0, 1, 9] } }]), { code: "INVALID_MESH_TRIANGLES" });
    const moved = await edits.preview(path, [{ kind: "set_mesh_geometry", skin: "default", slot: "body", name: "shirt",
      ...geometry, vertices: geometry.vertices.map((value) => value + 1) }]);
    assert.equal(moved.summaries[0].vertexCount, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
