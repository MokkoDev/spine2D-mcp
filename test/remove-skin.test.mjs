import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createSkeletonData } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { referenceGraph } from "../dist/spine/inspect.js";
import { validateDocument } from "../dist/spine/validate.js";

const geometry = { uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 16, 0, 0, 16],
  triangles: [0, 1, 2], hull: 3 };

test("named-skin removal blocks external linked meshes and animation timelines, then stages coordinated cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-remove-skin-"));
  const path = join(directory, "rig.json");
  try {
    await createSkeletonData(path, "4.3");
    const edits = new EditStore();
    const setup = await edits.preview(path, [
      { kind: "upsert_slot", name: "body", bone: "root" },
      { kind: "upsert_skin", name: "alternate" },
      { kind: "upsert_attachment", skin: "alternate", slot: "body", name: "shirt", attachmentType: "mesh", values: geometry },
      { kind: "upsert_attachment", skin: "default", slot: "body", name: "copy", attachmentType: "linkedmesh",
        values: { skin: "alternate", parent: "shirt" } },
    ]);
    await edits.commit(setup.editId);
    const data = JSON.parse(await readFile(path, "utf8"));
    data.animations.flex = { attachments: { alternate: { body: { shirt: {
      deform: [{ vertices: [0, 0, 0, 0, 0, 0] }],
    } } } } };
    await writeFile(path, `${JSON.stringify(data)}\n`);
    assert.deepEqual(validateDocument(await readDocument(path)), []);
    assert.ok(referenceGraph(await readDocument(path), "skin", "alternate").references
      .some((reference) => reference.path === "/skins/0/attachments/body/copy/skin"));
    await assert.rejects(edits.preview(path, [{ kind: "remove_skin", name: "alternate" }]), (error) => {
      assert.equal(error.code, "SKIN_IN_USE");
      assert.deepEqual(error.details.references, [
        "/animations/flex/attachments/alternate/body/shirt/deform",
        "/skins/0/attachments/body/copy/skin",
      ]);
      return true;
    });
    const original = await readFile(path, "utf8");
    const cleanup = await edits.preview(path, [
      { kind: "delete_keyframe", animation: "flex", selector: { section: "attachments", skin: "alternate",
        slot: "body", attachment: "shirt", timelineType: "deform" }, time: 0 },
      { kind: "remove_attachment", skin: "default", slot: "body", name: "copy" },
      { kind: "remove_skin", name: "alternate" },
    ]);
    assert.deepEqual(cleanup.diagnostics, []);
    assert.equal(await readFile(path, "utf8"), original);
    await edits.commit(cleanup.editId);
    const after = await readDocument(path);
    assert.deepEqual(after.data.skins.map((skin) => skin.name), ["default"]);
    assert.deepEqual(validateDocument(after), []);
    await assert.rejects(edits.preview(path, [{ kind: "remove_skin", name: "default" }]), { code: "INVALID_DEFAULT_SKIN" });
    await assert.rejects(edits.preview(path, [{ kind: "remove_skin", name: "alternate" }]), { code: "MISSING_SKIN" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("skin removal checks setup attachments and path constraints even when another named skin has the same key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-remove-skin-path-"));
  const path = join(directory, "rig.json");
  try {
    await createSkeletonData(path, "4.2");
    const edits = new EditStore();
    const route = { vertexCount: 6, vertices: [0, 0, 0, 0, 8, 0, 16, 0, 24, 0, 24, 0], lengths: [8, 24] };
    const setup = await edits.preview(path, [
      { kind: "upsert_slot", name: "route", bone: "root", values: { attachment: "path" } },
      { kind: "upsert_skin", name: "alpha" },
      { kind: "upsert_skin", name: "beta" },
      { kind: "upsert_attachment", skin: "alpha", slot: "route", name: "path", attachmentType: "path", values: route },
      { kind: "upsert_attachment", skin: "beta", slot: "route", name: "path", attachmentType: "path", values: route },
      { kind: "upsert_constraint", constraintType: "path", name: "follow", edition: "professional",
        bones: ["root"], target: "route" },
    ]);
    await edits.commit(setup.editId);
    await assert.rejects(edits.preview(path, [{ kind: "remove_skin", name: "alpha" }]), (error) => {
      assert.equal(error.code, "SKIN_IN_USE");
      assert.ok(error.details.references.includes("/slots/0/attachment"));
      assert.ok(error.details.references.includes("/path/0/target"));
      return true;
    });
    const clear = await edits.preview(path, [
      { kind: "upsert_slot", name: "route", values: { attachment: null } },
      { kind: "remove_skin", name: "alpha" },
    ]).catch((error) => error);
    assert.equal(clear.code, "SKIN_IN_USE");
    assert.ok(clear.details.references.includes("/path/0/target"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
