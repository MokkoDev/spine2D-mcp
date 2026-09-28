import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cleanupCurvesText } from "../dist/spine/cleanup-curves.js";
import { skeletonText } from "../dist/spine/create.js";
import { parseDocument, readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { sampleBoneTimeline } from "../dist/spine/pose.js";
import { collectTimelines } from "../dist/spine/timelines.js";
import { validateDocument } from "../dist/spine/validate.js";

function doc(keys, type = "rotate") {
  const data = JSON.parse(skeletonText("4.3"));
  data.bones.push({ name: "arm", parent: "root" });
  data.animations.move = { bones: { arm: { [type]: keys } } };
  return parseDocument("/tmp/cleanup.json", `${JSON.stringify(data, null, 2)}\n`);
}
function timeline(document, type = "rotate") {
  return collectTimelines("move", document.data.animations.move).find((item) => item.type === type);
}

test("simplification removes redundant linear keys and respects protected accents and metadata", () => {
  const source = doc([
    { time: 0, value: 0 }, { time: 1, value: 10 }, { time: 2, value: 20 },
    { time: 3, value: 30, editorTag: "keep" }, { time: 4, value: 40 }, { time: 5, value: 50 },
  ]);
  const result = cleanupCurvesText(source, { kind: "cleanup_curves", animation: "move", mode: "simplify",
    protectedTimes: [2] });
  const edited = parseDocument(source.path, result.text);
  assert.deepEqual(edited.data.animations.move.bones.arm.rotate.map((key) => key.time), [0, 2, 3, 5]);
  assert.equal(result.summary.keysRemoved, 2);
  assert.equal(result.summary.maxErrorBound, 0);
  assert.deepEqual(validateDocument(edited), []);
});

test("simplification bounds Bézier motion error and keeps stepped segments", () => {
  const source = doc([
    { time: 0, value: 0, curve: [0.25, 2.5, 0.75, 7.5] },
    { time: 1, value: 10, curve: [1.25, 15, 1.75, 20] },
    { time: 2, value: 20, curve: "stepped" },
    { time: 3, value: 20 },
  ]);
  const strict = cleanupCurvesText(source, { kind: "cleanup_curves", animation: "move", mode: "simplify", tolerance: 0 });
  assert.deepEqual(JSON.parse(strict.text).animations.move.bones.arm.rotate.map((key) => key.time), [0, 1, 2, 3]);
  const relaxed = cleanupCurvesText(source, { kind: "cleanup_curves", animation: "move", mode: "simplify", tolerance: 5 });
  const edited = parseDocument(source.path, relaxed.text);
  assert.deepEqual(edited.data.animations.move.bones.arm.rotate.map((key) => key.time), [0, 2, 3]);
  assert.ok(relaxed.summary.maxErrorBound <= 5);
  assert.equal(edited.data.animations.move.bones.arm.rotate[0].curve, undefined);
  assert.equal(edited.data.animations.move.bones.arm.rotate[1].curve, "stepped");
  for (let time = 0; time <= 2; time += 0.01) {
    const original = sampleBoneTimeline(timeline(source), "rotate", time).value;
    const after = sampleBoneTimeline(timeline(edited), "rotate", time).value;
    assert.ok(Math.abs(original - after) <= relaxed.summary.maxErrorBound + 1e-7);
  }
});

test("paired bone channels share the simplification bound and receive separate smoothing controls", () => {
  const source = doc([
    { time: 0, x: 0, y: 0 }, { time: 1, x: 10, y: 7 }, { time: 2, x: 20, y: 10 },
  ], "translate");
  const strict = cleanupCurvesText(source, { kind: "cleanup_curves", animation: "move", mode: "simplify", tolerance: 1 });
  assert.equal(JSON.parse(strict.text).animations.move.bones.arm.translate.length, 3);
  const relaxed = cleanupCurvesText(source, { kind: "cleanup_curves", animation: "move", mode: "simplify", tolerance: 2 });
  assert.equal(JSON.parse(relaxed.text).animations.move.bones.arm.translate.length, 2);
  assert.equal(relaxed.summary.maxErrorBound, 2);
  const eased = cleanupCurvesText(source, { kind: "cleanup_curves", animation: "move", mode: "smooth" });
  assert.equal(JSON.parse(eased.text).animations.move.bones.arm.translate[0].curve.length, 8);
});

test("smoothing keeps key values, monotone channels, protected accents, and stepped keys", () => {
  const source = doc([
    { time: 0, value: 0 }, { time: 1, value: 10 },
    { time: 2, value: 20 }, { time: 3, value: 30, curve: "stepped" },
    { time: 4, value: 30 },
  ]);
  const result = cleanupCurvesText(source, { kind: "cleanup_curves", animation: "move", mode: "smooth",
    protectedTimes: [1] });
  const edited = parseDocument(source.path, result.text);
  const keys = edited.data.animations.move.bones.arm.rotate;
  assert.deepEqual(keys.map((key) => key.value), [0, 10, 20, 30, 30]);
  assert.equal(keys[3].curve, "stepped");
  assert.equal(keys[0].curve[1], 0);
  assert.equal(keys[0].curve[3], 10);
  assert.ok(result.summary.curvesUpdated >= 2);
  let previous = 0;
  for (let time = 0; time <= 3; time += 0.05) {
    const current = sampleBoneTimeline(timeline(edited), "rotate", time).value;
    assert.ok(current >= previous - 1e-8 && current <= 30 + 1e-8);
    previous = current;
  }
  assert.deepEqual(validateDocument(edited), []);
});

test("curve cleanup stages atomically and rejects conflicting key times", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-cleanup-curves-"));
  const path = join(directory, "rig.json");
  try {
    const source = doc([{ time: 0, value: 0 }, { time: 1, value: 10 }, { time: 2, value: 20 }]);
    await writeFile(path, source.text);
    const edits = new EditStore();
    const before = await readFile(path, "utf8");
    const stage = await edits.preview(path, [{ kind: "cleanup_curves", animation: "move", mode: "simplify" }]);
    assert.equal(stage.summaries[0].keysRemoved, 1);
    assert.equal(await readFile(path, "utf8"), before);
    await edits.commit(stage.editId);
    assert.deepEqual((await readDocument(path)).data.animations.move.bones.arm.rotate.map((key) => key.time), [0, 2]);
    await assert.rejects(edits.preview(path, [
      { kind: "cleanup_curves", animation: "move", mode: "smooth", tolerance: 1 },
    ]), { code: "INVALID_TOLERANCE" });
    const tied = doc([{ time: 0, value: 0 }, { time: 0, value: 1 }, { time: 1, value: 2 }]);
    assert.throws(() => cleanupCurvesText(tied, { kind: "cleanup_curves", animation: "move", mode: "smooth" }),
      { code: "CURVE_TIME_CONFLICT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
