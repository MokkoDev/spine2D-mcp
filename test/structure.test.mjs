import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { skeletonText } from "../dist/spine/create.js";
import { parseDocument, readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { referenceGraph } from "../dist/spine/inspect.js";
import { validateDocument } from "../dist/spine/validate.js";

function drawOrder(setup, key) {
  if (!key.offsets) return setup;
  const order = Array(setup.length);
  const unchanged = [];
  let original = 0;
  for (const offset of key.offsets) {
    const index = setup.indexOf(offset.slot);
    while (original < index) unchanged.push(setup[original++]);
    order[original + offset.offset] = setup[original++];
  }
  while (original < setup.length) unchanged.push(setup[original++]);
  for (let i = order.length - 1; i >= 0; i--) if (!order[i]) order[i] = unchanged.pop();
  return order;
}

for (const version of ["4.2", "4.3"]) {
  test(`Spine ${version} preserves keyed global draw order when setup slots are reordered`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "spine2d-order-"));
    const path = join(directory, "order.json");
    try {
      const data = JSON.parse(skeletonText(version));
      data.slots = ["a", "b", "c"].map((name) => ({ name, bone: "root" }));
      data.animations.wave = { drawOrder: [
        { time: 0, offsets: [{ slot: "a", offset: 2 }] },
        { time: 0.5, offsets: [{ slot: "b", offset: -1 }] },
        { time: 1 },
      ] };
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
      const original = await readFile(path, "utf8");
      const oldOrder = data.animations.wave.drawOrder.map((key) => drawOrder(["a", "b", "c"], key));
      const edits = new EditStore();
      await assert.rejects(edits.preview(path, [{ kind: "reorder_slots", names: ["c", "a", "b"] }]),
        { code: "DRAW_ORDER_IN_USE" });
      await assert.rejects(edits.preview(path, [{ kind: "reorder_slots", names: ["c", "a", "a"] }]),
        { code: "INVALID_SLOT_ORDER" });
      assert.equal(await readFile(path, "utf8"), original);
      const stage = await edits.preview(path, [{ kind: "reorder_slots", names: ["c", "a", "b"], animationPolicy: "preserve" }]);
      assert.equal(stage.summaries[0].rewrittenDrawOrderKeys, 3);
      await edits.commit(stage.editId);
      const after = await readDocument(path);
      assert.deepEqual(after.data.slots.map((slot) => slot.name), ["c", "a", "b"]);
      assert.deepEqual(after.data.animations.wave.drawOrder.map((key) => drawOrder(["c", "a", "b"], key)), oldOrder);
      assert.deepEqual(validateDocument(after), []);
      const repeat = await edits.preview(path, [{ kind: "reorder_slots", names: ["c", "a", "b"] }]);
      assert.equal(repeat.summaries[0].action, "unchanged");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`Spine ${version} removes unused bone and slot, remapping weighted mesh and polygon indices`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "spine2d-structure-"));
    const path = join(directory, "rig.json");
    try {
      const data = JSON.parse(skeletonText(version));
      data.bones.push({ name: "spare", parent: "root" }, { name: "target", parent: "root" });
      data.slots.push({ name: "art", bone: "target" }, { name: "unused", bone: "root" });
      const vertices = [1, 2, 0, 0, 1, 1, 2, 10, 0, 1, 1, 2, 0, 10, 1];
      data.skins[0].attachments.art = {
        triangle: { type: "mesh", uvs: [0, 0, 1, 0, 0, 1], vertices, triangles: [0, 1, 2], hull: 3 },
        bounds: { type: "boundingbox", vertexCount: 3, vertices: [...vertices] },
      };
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
      const edits = new EditStore();
      const source = await readFile(path, "utf8");
      const stage = await edits.preview(path, [
        { kind: "remove_slot", name: "unused" },
        { kind: "remove_bone", name: "spare" },
      ]);
      assert.equal(stage.summaries[1].remappedWeights, 6);
      assert.equal(await readFile(path, "utf8"), source);
      await edits.commit(stage.editId);
      const after = await readDocument(path);
      assert.deepEqual(after.data.bones.map((bone) => bone.name), ["root", "target"]);
      assert.deepEqual(after.data.slots.map((slot) => slot.name), ["art"]);
      assert.equal(after.data.skins[0].attachments.art.triangle.vertices[1], 1);
      assert.equal(after.data.skins[0].attachments.art.bounds.vertices[1], 1);
      assert.deepEqual(validateDocument(after), []);
      assert.ok(referenceGraph(after, "bone", "target").references.some((reference) =>
        reference.path === "/skins/0/attachments/art/bounds/vertices/1"));
      const broken = structuredClone(after.data);
      broken.skins[0].attachments.art.bounds.vertices[1] = 99;
      assert.ok(validateDocument(parseDocument(path, JSON.stringify(broken))).some((diagnostic) =>
        diagnostic.code === "MISSING_BONE" && diagnostic.path === "/skins/0/attachments/art/bounds/vertices/1"));
      await assert.rejects(edits.preview(path, [{ kind: "remove_bone", name: "root" }]), { code: "ROOT_BONE" });
      await assert.rejects(edits.preview(path, [{ kind: "remove_bone", name: "target" }]), (error) => {
        assert.equal(error.code, "BONE_IN_USE");
        assert.ok(error.details.references.includes("/slots/0/bone"));
        assert.ok(error.details.references.includes("/skins/0/attachments/art/bounds/vertices/1"));
        return true;
      });
      await assert.rejects(edits.preview(path, [{ kind: "remove_slot", name: "art" }]), (error) => {
        assert.equal(error.code, "SLOT_IN_USE");
        assert.ok(error.details.references.includes("/skins/0/attachments/art"));
        return true;
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
