import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseDocument, readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { captureBonePose, poseApplyOperations } from "../dist/spine/pose.js";
import { validateDocument } from "../dist/spine/validate.js";

const sourceData = {
  skeleton: { spine: "4.3.26" },
  bones: [{ name: "root" }, { name: "arm", parent: "root" }],
  slots: [],
  skins: [{ name: "default", attachments: {} }],
  animations: { wave: { bones: { arm: {
    rotate: [{ value: 0, curve: [0.25, 0, 0.75, 0] }, { time: 1, value: 100 }],
    translate: [{ x: 0, y: 0, curve: "stepped" }, { time: 1, x: 10, y: 20 }],
    scale: [{ x: 1, y: 1 }, { time: 1, x: 2, y: 0.5 }],
  } } } },
};

const targetData = {
  skeleton: { spine: "4.3.26" },
  bones: [{ name: "root" }, { name: "wing", parent: "root" }],
  slots: [],
  skins: [{ name: "default", attachments: {} }],
  animations: { idle: { bones: { wing: {
    rotate: [{ value: 20 }, { time: 1, value: 40 }],
  } } } },
};

test("bone pose capture evaluates linear, stepped, and Bézier channels", () => {
  const source = parseDocument("/tmp/pose-source.json", JSON.stringify(sourceData));
  const pose = captureBonePose(source, "wave", 0.5, "mid-wave");
  assert.equal(pose.entries.length, 3);
  assert.equal(pose.entries.find((entry) => entry.timelineType === "rotate").values.value, 12.5);
  assert.deepEqual(pose.entries.find((entry) => entry.timelineType === "translate").values, { x: 0, y: 0 });
  assert.deepEqual(pose.entries.find((entry) => entry.timelineType === "scale").values, { x: 1.5, y: 0.75 });
  assert.equal(pose.sourceHash, source.hash);
  assert.deepEqual(validateDocument(source), []);
});

test("mapped bone pose blends into a target animation and remains staged until commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-pose-"));
  const path = join(directory, "target.json");
  const original = `${JSON.stringify(targetData, null, 2)}\n`;
  await writeFile(path, original);
  try {
    const source = parseDocument(join(directory, "source.json"), JSON.stringify(sourceData));
    const pose = captureBonePose(source, "wave", 0.5, "mid-wave");
    const target = await readDocument(path);
    assert.throws(() => poseApplyOperations(target, pose, "idle", 0.5), { code: "UNMAPPED_BONES" });
    const prepared = poseApplyOperations(target, pose, "idle", 0.5, 0.5, { arm: "wing" });
    assert.equal(prepared.channels, 3);
    const edits = new EditStore();
    const stage = await edits.preview(path, prepared.operations);
    assert.deepEqual(stage.diagnostics, []);
    assert.equal(await readFile(path, "utf8"), original);
    await edits.commit(stage.editId);
    const after = await readDocument(path);
    assert.deepEqual(validateDocument(after), []);
    assert.equal(after.data.animations.idle.bones.wing.rotate[1].value, 21.25);
    assert.deepEqual(after.data.animations.idle.bones.wing.scale[0], { x: 1.25, y: 0.875, time: 0.5 });
    const changedVersion = structuredClone(targetData);
    changedVersion.skeleton.spine = "4.2.26";
    assert.throws(() => poseApplyOperations(parseDocument(path, JSON.stringify(changedVersion)), pose, "idle", 0.5,
      1, { arm: "wing" }), { code: "VERSION_MISMATCH" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pose insertion inside a Bézier segment needs explicit curve reset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-pose-curve-"));
  const path = join(directory, "target.json");
  const curved = structuredClone(targetData);
  curved.animations.idle.bones.wing.rotate[0].curve = [0.25, 20, 0.75, 40];
  await writeFile(path, JSON.stringify(curved));
  try {
    const pose = captureBonePose(parseDocument(join(directory, "source.json"), JSON.stringify(sourceData)),
      "wave", 0.5, "mid-wave");
    const target = await readDocument(path);
    const edits = new EditStore();
    const rejected = poseApplyOperations(target, pose, "idle", 0.5, 1, { arm: "wing" });
    await assert.rejects(edits.preview(path, rejected.operations), { code: "CURVE_SPLIT_REQUIRED" });
    const accepted = poseApplyOperations(target, pose, "idle", 0.5, 1, { arm: "wing" }, "linearize");
    const stage = await edits.preview(path, accepted.operations);
    assert.equal(stage.summaries[0].curveResets, 1);
    await edits.commit(stage.editId);
    const after = (await readDocument(path)).data.animations.idle.bones.wing.rotate;
    assert.equal(after[0].curve, undefined);
    assert.equal(after[1].value, 12.5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
