import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { skeletonText } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { validateDocument } from "../dist/spine/validate.js";

for (const version of ["4.2", "4.3"]) {
  test(`Spine ${version} renames rig and animation references together`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "spine2d-rename-"));
    const path = join(directory, "rig.json");
    try {
      const data = JSON.parse(skeletonText(version));
      data.bones.push({ name: "arm", parent: "root" }, { name: "goal", parent: "arm" });
      data.slots.push({ name: "hand", bone: "arm", attachment: "image" }, { name: "other", bone: "root" });
      data.skins[0].attachments.hand = { image: { type: "region", width: 10, height: 10 } };
      data.skins.push({ name: "alternate", bones: ["arm"], attachments: {},
        ...(version === "4.3" ? { constraints: ["aim"] } : { ik: ["aim"] }) });
      if (version === "4.3") data.constraints = [{ name: "aim", type: "ik", bones: ["arm"], target: "goal" }];
      else data.ik = [{ name: "aim", order: 0, bones: ["arm"], target: "goal" }];
      data.events = { beat: { int: 1 } };
      data.animations.wave = {
        bones: { arm: { rotate: [{ time: 0, value: 10 }] } },
        slots: { hand: { attachment: [{ time: 0, name: "image" }] } },
        ik: { aim: [{ time: 0, mix: 0.5 }] },
        events: [{ time: 0.25, name: "beat" }],
        drawOrder: [{ time: 0, offsets: [{ slot: "hand", offset: 1 }] }],
      };
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
      assert.deepEqual(validateDocument(await readDocument(path)), []);
      const edits = new EditStore();
      const source = await readFile(path, "utf8");
      const stage = await edits.preview(path, [
        { kind: "rename_element", elementType: "bone", name: "arm", newName: "wing" },
        { kind: "rename_element", elementType: "slot", name: "hand", newName: "feather" },
        { kind: "rename_element", elementType: "skin", name: "alternate", newName: "costume" },
        { kind: "rename_element", elementType: "event", name: "beat", newName: "hit" },
        { kind: "rename_element", elementType: "constraint", constraintType: "ik", name: "aim", newName: "point" },
        { kind: "rename_element", elementType: "animation", name: "wave", newName: "fly" },
      ]);
      assert.deepEqual(stage.diagnostics, []);
      assert.ok(stage.summaries.every((summary) => summary.action === "renamed"));
      assert.equal(await readFile(path, "utf8"), source);
      await edits.commit(stage.editId);
      const after = await readDocument(path);
      assert.deepEqual(validateDocument(after), []);
      assert.equal(after.data.bones[1].name, "wing");
      assert.equal(after.data.bones[2].parent, "wing");
      assert.equal(after.data.slots[0].name, "feather");
      assert.equal(after.data.slots[0].bone, "wing");
      assert.ok(after.data.skins[0].attachments.feather.image);
      assert.equal(after.data.skins[1].name, "costume");
      assert.deepEqual(after.data.skins[1].bones, ["wing"]);
      assert.deepEqual(version === "4.3" ? after.data.skins[1].constraints : after.data.skins[1].ik, ["point"]);
      assert.equal((version === "4.3" ? after.data.constraints[0] : after.data.ik[0]).name, "point");
      assert.equal(after.data.animations.fly.bones.wing.rotate[0].value, 10);
      assert.equal(after.data.animations.fly.slots.feather.attachment[0].name, "image");
      assert.equal(after.data.animations.fly.ik.point[0].mix, 0.5);
      assert.equal(after.data.animations.fly.events[0].name, "hit");
      assert.equal(after.data.animations.fly.drawOrder[0].offsets[0].slot, "feather");
      await assert.rejects(edits.preview(path, [
        { kind: "rename_element", elementType: "bone", name: "wing", newName: "goal" },
      ]), { code: "NAME_CONFLICT" });
      await assert.rejects(edits.preview(path, [
        { kind: "rename_element", elementType: "skin", name: "default", newName: "base" },
      ]), { code: "DEFAULT_SKIN" });
      const noop = await edits.preview(path, [
        { kind: "rename_element", elementType: "animation", name: "fly", newName: "fly" },
      ]);
      assert.equal(noop.summaries[0].action, "unchanged");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`Spine ${version} renames one slot's attachment key across skins and linked meshes`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "spine2d-rename-attachment-"));
    const path = join(directory, "rig.json");
    try {
      const data = JSON.parse(skeletonText(version));
      data.slots.push({ name: "art", bone: "root", attachment: "shape" });
      data.skins[0].attachments.art = {
        shape: { type: "mesh", uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 10, 0, 0, 10],
          triangles: [0, 1, 2], hull: 3 },
      };
      data.skins.push({ name: "alternate", attachments: { art: {
        shape: { type: "region", width: 10, height: 10 },
        copy: { type: "linkedmesh", skin: "default", [version === "4.3" ? "source" : "parent"]: "shape" },
      } } });
      data.animations.show = { slots: { art: { attachment: [{ time: 0, name: "shape" }] } } };
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
      assert.deepEqual(validateDocument(await readDocument(path)), []);
      const edits = new EditStore();
      const stage = await edits.preview(path, [{ kind: "rename_element", elementType: "attachment",
        slot: "art", name: "shape", newName: "picture" }]);
      await edits.commit(stage.editId);
      const after = await readDocument(path);
      assert.deepEqual(validateDocument(after), []);
      assert.equal(after.data.slots[0].attachment, "picture");
      assert.ok(after.data.skins[0].attachments.art.picture);
      assert.ok(after.data.skins[1].attachments.art.picture);
      assert.equal(after.data.skins[1].attachments.art.copy[version === "4.3" ? "source" : "parent"], "picture");
      assert.equal(after.data.animations.show.slots.art.attachment[0].name, "picture");
      await assert.rejects(edits.preview(path, [{ kind: "rename_element", elementType: "attachment",
        slot: "art", name: "picture", newName: "copy" }]), { code: "NAME_CONFLICT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
