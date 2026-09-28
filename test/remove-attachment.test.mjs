import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createSkeletonData } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { validateDocument } from "../dist/spine/validate.js";

const mesh = { uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 16, 0, 0, 16],
  triangles: [0, 1, 2], hull: 3 };

test("attachment removal reports exact references and composes with cleanup in one staged batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-remove-attachment-"));
  const path = join(directory, "rig.json");
  try {
    await createSkeletonData(path, "4.3");
    const edits = new EditStore();
    const setup = await edits.preview(path, [
      { kind: "upsert_slot", name: "body", bone: "root", values: { attachment: "shirt" } },
      { kind: "upsert_attachment", skin: "default", slot: "body", name: "shirt", attachmentType: "mesh", values: mesh },
      { kind: "upsert_attachment", skin: "default", slot: "body", name: "copy", attachmentType: "linkedmesh",
        values: { parent: "shirt" } },
      { kind: "upsert_attachment", skin: "default", slot: "body", name: "marker", attachmentType: "point", values: { x: 2 } },
    ]);
    await edits.commit(setup.editId);
    const withAnimation = JSON.parse(await readFile(path, "utf8"));
    withAnimation.animations.wave = { slots: { body: { attachment: [{ name: "shirt" }] } },
      attachments: { default: { body: { shirt: { deform: [{ vertices: [0, 0, 0, 0, 0, 0] }] } } } } };
    await writeFile(path, `${JSON.stringify(withAnimation)}\n`);
    assert.deepEqual(validateDocument(await readDocument(path)), []);
    const original = await readFile(path, "utf8");
    await assert.rejects(edits.preview(path, [{ kind: "remove_attachment", skin: "default", slot: "body", name: "shirt" }]),
      (error) => {
        assert.equal(error.code, "ATTACHMENT_IN_USE");
        assert.deepEqual(error.details.references, [
          "/slots/0/attachment", "/skins/0/attachments/body/copy/source",
          "/animations/wave/slots/body/attachment/0/name", "/animations/wave/attachments/default/body/shirt/deform",
        ]);
        return true;
      });
    await assert.rejects(edits.preview(path, [
      { kind: "remove_attachment", skin: "default", slot: "body", name: "copy" },
      { kind: "remove_attachment", skin: "default", slot: "body", name: "shirt" },
    ]), { code: "ATTACHMENT_IN_USE" });
    assert.equal(await readFile(path, "utf8"), original);
    const cleanup = await edits.preview(path, [
      { kind: "upsert_slot", name: "body", values: { attachment: null } },
      { kind: "delete_keyframe", animation: "wave", selector: { section: "slots", target: "body", timelineType: "attachment" }, time: 0 },
      { kind: "delete_keyframe", animation: "wave", selector: { section: "attachments", skin: "default", slot: "body",
        attachment: "shirt", timelineType: "deform" }, time: 0 },
      { kind: "remove_attachment", skin: "default", slot: "body", name: "copy" },
      { kind: "remove_attachment", skin: "default", slot: "body", name: "shirt" },
    ]);
    assert.deepEqual(cleanup.diagnostics, []);
    assert.equal(await readFile(path, "utf8"), original);
    await edits.commit(cleanup.editId);
    const after = await readDocument(path);
    assert.deepEqual(validateDocument(after), []);
    assert.equal(after.data.slots[0].attachment, undefined);
    assert.deepEqual(Object.keys(after.data.skins[0].attachments.body), ["marker"]);
    const marker = await edits.preview(path, [{ kind: "remove_attachment", skin: "default", slot: "body", name: "marker" }]);
    assert.equal(marker.summaries[0].action, "removed");
    await edits.commit(marker.editId);
    assert.equal(after.data.skins[0].attachments.body.marker.type, "point");
    assert.equal((await readDocument(path)).data.skins[0].attachments.body, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("attachment removal preserves a default-skin fallback and protects a path constraint target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-remove-path-"));
  const path = join(directory, "rig.json");
  try {
    await createSkeletonData(path, "4.2");
    const edits = new EditStore();
    const setup = await edits.preview(path, [
      { kind: "upsert_slot", name: "route", bone: "root", values: { attachment: "route" } },
      { kind: "upsert_attachment", skin: "default", slot: "route", name: "route", attachmentType: "path",
        values: { vertexCount: 6, vertices: [0, 0, 0, 0, 8, 0, 16, 0, 24, 0, 24, 0], lengths: [8, 24] } },
      { kind: "upsert_skin", name: "other" },
      { kind: "upsert_attachment", skin: "other", slot: "route", name: "route", attachmentType: "path",
        values: { vertexCount: 6, vertices: [0, 0, 0, 0, 8, 0, 16, 0, 24, 0, 24, 0], lengths: [8, 24] } },
      { kind: "upsert_constraint", constraintType: "path", name: "follow", edition: "professional",
        bones: ["root"], target: "route" },
    ]);
    await edits.commit(setup.editId);
    const variant = await edits.preview(path, [{ kind: "remove_attachment", skin: "other", slot: "route", name: "route" }]);
    await edits.commit(variant.editId);
    const restored = await edits.preview(path, [{ kind: "upsert_attachment", skin: "other", slot: "route", name: "route",
      attachmentType: "path", values: { vertexCount: 6,
        vertices: [0, 0, 0, 0, 8, 0, 16, 0, 24, 0, 24, 0], lengths: [8, 24] } }]);
    await edits.commit(restored.editId);
    await assert.rejects(edits.preview(path, [{ kind: "remove_attachment", skin: "default", slot: "route", name: "route" }]),
      (error) => {
        assert.equal(error.code, "ATTACHMENT_IN_USE");
        assert.ok(error.details.references.includes("/slots/0/attachment"));
        assert.ok(error.details.references.includes("/path/0/target"));
        return true;
      });
    await assert.rejects(edits.preview(path, [
      { kind: "upsert_slot", name: "route", values: { attachment: null } },
      { kind: "remove_attachment", skin: "default", slot: "route", name: "route" },
    ]), (error) => {
      assert.equal(error.code, "ATTACHMENT_IN_USE");
      assert.ok(error.details.references.includes("/path/0/target"));
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
