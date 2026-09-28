import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createSkeletonData } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { validateDocument } from "../dist/spine/validate.js";

test("an atomic rig batch creates a visible bone, slot, region, and animation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-rig-"));
  const path = join(directory, "character.json");
  try {
    await createSkeletonData(path, "4.3");
    const original = await readFile(path, "utf8");
    const edits = new EditStore();
    const preview = await edits.preview(path, [
      { kind: "upsert_bone", name: "arm", parent: "root", values: { x: 10, y: 5, length: 40 } },
      { kind: "upsert_slot", name: "hand", bone: "arm", values: { attachment: "hand", blend: "normal" } },
      { kind: "upsert_region_attachment", skin: "default", slot: "hand", name: "hand",
        values: { path: "hand", width: 32, height: 32, x: 8, y: 4 } },
      { kind: "upsert_animation", name: "wave" },
      { kind: "set_keyframe", animation: "wave", selector: { section: "bones", target: "arm", timelineType: "rotate" },
        time: 0, values: { value: -20 } },
      { kind: "set_keyframe", animation: "wave", selector: { section: "bones", target: "arm", timelineType: "rotate" },
        time: 1, values: { value: 20 } },
    ]);
    assert.deepEqual(preview.diagnostics, []);
    assert.equal(preview.summaries.length, 6);
    assert.equal(await readFile(path, "utf8"), original);
    await edits.commit(preview.editId);
    const document = await readDocument(path);
    assert.deepEqual(validateDocument(document), []);
    assert.equal(document.data.bones[1].parent, "root");
    assert.equal(document.data.slots[0].attachment, "hand");
    assert.equal(document.data.skins[0].attachments.hand.hand.width, 32);
    assert.equal(document.data.animations.wave.bones.arm.rotate.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rig edits preserve unknown fields and reject missing references and unsafe values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-rig-errors-"));
  const path = join(directory, "character.json");
  try {
    await createSkeletonData(path, "4.3");
    const data = JSON.parse(await readFile(path, "utf8"));
    data.bones[0].icon = "custom-editor-value";
    await writeFile(path, `${JSON.stringify(data)}\n`);
    const edits = new EditStore();
    await assert.rejects(edits.preview(path, [{ kind: "upsert_bone", name: "child", parent: "missing" }]), { code: "MISSING_BONE" });
    await assert.rejects(edits.preview(path, [{ kind: "upsert_slot", name: "hand", bone: "missing" }]), { code: "MISSING_BONE" });
    const changed = await edits.preview(path, [{ kind: "upsert_bone", name: "root", values: { x: 5 } }]);
    await edits.commit(changed.editId);
    assert.equal(JSON.parse(await readFile(path, "utf8")).bones[0].icon, "custom-editor-value");
    assert.equal(JSON.parse(await readFile(path, "utf8")).bones[0].x, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("skin and event definitions compose with attachments and event keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-skin-event-"));
  const path = join(directory, "character.json");
  try {
    await createSkeletonData(path, "4.3");
    const edits = new EditStore();
    const stage = await edits.preview(path, [
      { kind: "upsert_slot", name: "body", bone: "root", values: { attachment: "shirt" } },
      { kind: "upsert_skin", name: "alternate" },
      { kind: "upsert_region_attachment", skin: "alternate", slot: "body", name: "shirt", values: { width: 16, height: 16 } },
      { kind: "upsert_event", name: "beat", values: { int: 2, float: 0.25, string: "hit" } },
      { kind: "upsert_animation", name: "wave" },
      { kind: "set_keyframe", animation: "wave", selector: { section: "events" }, time: 0.5, values: { name: "beat" } },
    ]);
    assert.deepEqual(stage.diagnostics, []);
    await edits.commit(stage.editId);
    const document = await readDocument(path);
    assert.equal(document.data.skins[1].attachments.body.shirt.width, 16);
    assert.equal(document.data.events.beat.int, 2);
    assert.deepEqual(validateDocument(document), []);
    const updated = await edits.preview(path, [
      { kind: "upsert_skin", name: "alternate", values: { bones: ["root"] } },
      { kind: "upsert_event", name: "beat", values: { float: 0.5 } },
    ]);
    await edits.commit(updated.editId);
    const after = (await readDocument(path)).data;
    assert.equal(after.skins[1].attachments.body.shirt.width, 16);
    assert.deepEqual(after.skins[1].bones, ["root"]);
    assert.equal(after.events.beat.int, 2);
    assert.equal(after.events.beat.float, 0.5);
    await assert.rejects(edits.preview(path, [{ kind: "upsert_skin", name: "bad", values: { bones: ["root", "root"] } }]),
      { code: "INVALID_SKIN_VALUE" });
    await assert.rejects(edits.preview(path, [{ kind: "upsert_skin", name: "default", values: { bones: ["root"] } }]),
      { code: "INVALID_DEFAULT_SKIN" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("skeleton metadata changes preserve unknown editor fields and can clear audio", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-metadata-"));
  const path = join(directory, "character.json");
  try {
    await createSkeletonData(path, "4.3");
    const data = JSON.parse(await readFile(path, "utf8"));
    data.skeleton.editorCustom = "keep";
    await writeFile(path, `${JSON.stringify(data)}\n`);
    const edits = new EditStore();
    const stage = await edits.preview(path, [{ kind: "set_skeleton_metadata",
      values: { images: "./art/", audio: "./sounds/", fps: 60 } }]);
    await edits.commit(stage.editId);
    const after = (await readDocument(path)).data.skeleton;
    assert.equal(after.editorCustom, "keep");
    assert.equal(after.images, "./art/");
    assert.equal(after.audio, "./sounds/");
    assert.equal(after.fps, 60);
    const clear = await edits.preview(path, [{ kind: "set_skeleton_metadata", values: { audio: null } }]);
    await edits.commit(clear.editId);
    assert.equal(Object.hasOwn((await readDocument(path)).data.skeleton, "audio"), false);
    await assert.rejects(edits.preview(path, [{ kind: "set_skeleton_metadata", values: { fps: 0 } }]), { code: "INVALID_FPS" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
