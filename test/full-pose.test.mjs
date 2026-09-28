import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { skeletonText } from "../dist/spine/create.js";
import { parseDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { applyPoseOperations, capturePose } from "../dist/spine/full-pose.js";
import { validateDocument } from "../dist/spine/validate.js";

function sourceFixture(version = "4.3") {
  const data = JSON.parse(skeletonText(version));
  data.bones.push({ name: "left", parent: "root" }, { name: "right", parent: "root" });
  data.slots.push({ name: "eyes", bone: "root", attachment: "open" });
  data.skins[0].attachments.eyes = { open: {}, closed: {} };
  data.animations.wave = {
    bones: {
      left: { rotate: [{ time: 0, value: 10 }, { time: 1, value: 20 }] },
      right: { rotate: [{ time: 0, value: -5 }, { time: 1, value: -15 }] },
    },
    slots: { eyes: { attachment: [{ time: 0, name: "open" }, { time: 0.5, name: "closed" }] } },
  };
  return parseDocument("/tmp/full-pose-source.json", `${JSON.stringify(data, null, 2)}\n`);
}

test("full pose captures bone and slot state, mirrors and offsets bone channels, and stages atomically", async () => {
  const source = sourceFixture();
  const pose = capturePose(source, "wave", 0.75, "half-strike");
  assert.equal(pose.boneEntries.length, 2);
  assert.deepEqual(pose.slotEntries, [{ slot: "eyes", attachment: "closed" }]);
  const prepared = applyPoseOperations(source, pose, "posed", 0.2, {
    mirrorPairs: [["left", "right"]], offsets: { right: { rotate: { value: 5 } } },
  });
  assert.equal(prepared.summary.mirroredPairs, 1);
  assert.equal(prepared.summary.slotsApplied, 1);
  const directory = await mkdtemp(join(tmpdir(), "spine2d-full-pose-"));
  const path = join(directory, "rig.json");
  try {
    await writeFile(path, source.text);
    const store = new EditStore();
    const staged = await store.preview(path, prepared.operations);
    assert.deepEqual(staged.diagnostics, []);
    assert.equal(await readFile(path, "utf8"), source.text);
    const after = parseDocument(path, store.snapshot(staged.editId).afterText);
    assert.equal(after.data.animations.posed.bones.left.rotate[0].value, 12.5);
    assert.equal(after.data.animations.posed.bones.right.rotate[0].value, -12.5);
    assert.equal(after.data.animations.posed.slots.eyes.attachment[0].name, "closed");
    assert.deepEqual(validateDocument(after), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("full pose maps onto a compatible rig and makes discrete blend policy explicit", async () => {
  const source = sourceFixture();
  const pose = capturePose(source, "wave", 0.75, "transfer");
  const targetData = structuredClone(source.data);
  targetData.bones[1].name = "wingLeft";
  targetData.bones[2].name = "wingRight";
  targetData.slots[0].name = "visor";
  targetData.slots[0].attachment = "openTarget";
  targetData.skins[0].attachments = { visor: { openTarget: {}, closedTarget: {} } };
  targetData.animations = {};
  const target = parseDocument("/tmp/full-pose-target.json", JSON.stringify(targetData));
  assert.deepEqual(validateDocument(target), []);
  const mapped = applyPoseOperations(target, pose, "transferred", 0, {
    boneMap: { left: "wingLeft", right: "wingRight" }, slotMap: { eyes: "visor" },
    attachmentMap: { eyes: { closed: "closedTarget" } },
  });
  // The operation list can be reviewed before any file is changed.
  assert.ok(mapped.operations.some((operation) => operation.kind === "set_keyframe"
    && operation.selector.section === "slots" && operation.values.name === "closedTarget"));
  assert.equal(mapped.summary.mappedBones.left, "wingLeft");
  assert.equal(mapped.summary.mappedSlots.eyes, "visor");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-full-pose-map-"));
  const path = join(directory, "target.json");
  try {
    await writeFile(path, target.text);
    const store = new EditStore();
    const staged = await store.preview(path, mapped.operations);
    const after = parseDocument(path, store.snapshot(staged.editId).afterText);
    assert.equal(after.data.animations.transferred.bones.wingLeft.rotate[0].value, 17.5);
    assert.equal(after.data.animations.transferred.slots.visor.attachment[0].name, "closedTarget");
    assert.deepEqual(validateDocument(after), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.throws(() => applyPoseOperations(target, pose, "transferred", 0, { blend: 0.5 }),
    { code: "DISCRETE_BLEND_UNSUPPORTED" });
  const blended = applyPoseOperations(target, pose, "transferred", 0, {
    blend: 0.5, applySlots: false, boneMap: { left: "wingLeft", right: "wingRight" },
  });
  assert.equal(blended.summary.slotsApplied, 0);
  assert.equal(blended.summary.reviewHints.length, 1);
  assert.throws(() => applyPoseOperations(target, pose, "transferred", 0, {
    offsets: { left: { translate: { x: 5 } } },
  }), { code: "INVALID_POSE_OFFSET" });
});

test("full pose can capture selected setup slot state before its first animation key", () => {
  const source = sourceFixture();
  const pose = capturePose(source, "wave", 0.25, "before-blink", undefined, ["eyes"]);
  assert.deepEqual(pose.slotEntries, [{ slot: "eyes", attachment: "open" }]);
  assert.throws(() => capturePose(source, "wave", 0.25, "bad", ["missing"]),
    { code: "INVALID_POSE_SELECTION" });
});
