import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseDocument, readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { sampleBoneTimeline } from "../dist/spine/pose.js";
import { collectTimelines } from "../dist/spine/timelines.js";
import { validateDocument } from "../dist/spine/validate.js";
import { reverseBoneAnimationText } from "../dist/spine/variant.js";

const fixture = {
  skeleton: { spine: "4.3.26" },
  bones: [{ name: "root" }, { name: "arm", parent: "root" }],
  slots: [],
  skins: [{ name: "default", attachments: {} }],
  events: { beat: {} },
  animations: { wave: {
    bones: {
      root: { rotate: [{ value: 4 }, { time: 0.5, value: 12 }] },
      arm: {
        rotate: [{ value: -20, curve: [0.2, -15, 0.8, 15], custom: "retain" }, { time: 1, value: 20 }],
        translate: [{ x: 0, y: 2, curve: [0.2, 1, 0.8, 9, 0.3, 2, 0.7, 6] },
          { time: 1, x: 10, y: 8 }],
      },
    },
    events: [{ time: 0.3, name: "beat" }, { time: 1.5, name: "beat" }],
  } },
};

function document(data = fixture) {
  return parseDocument("/tmp/reverse-bones.json", `${JSON.stringify(data, null, 2)}\n`);
}

test("reversed bone motion samples match source motion backward, including Bézier curves and held endings", () => {
  const source = document();
  const result = reverseBoneAnimationText(source, { kind: "reverse_bone_animation",
    sourceAnimation: "wave", newAnimation: "wave-reversed" });
  const after = parseDocument(source.path, result.text);
  assert.deepEqual(validateDocument(after), []);
  assert.deepEqual(after.data.animations.wave, fixture.animations.wave);
  assert.equal(result.summary.duration, 1.5);
  assert.equal(result.summary.boneTimelines, 3);
  assert.equal(result.summary.anchorKeys, 3);
  assert.equal(result.summary.events, 2);
  assert.equal(result.summary.curveControls, 6);
  const reversed = after.data.animations["wave-reversed"];
  assert.deepEqual(reversed.events.map((key) => key.time), [0, 1.2]);
  assert.deepEqual(reversed.bones.arm.rotate[1].curve, [0.7, 15, 1.3, -15]);
  assert.equal(reversed.bones.arm.rotate.at(-1).custom, "retain");

  const sourceTimelines = collectTimelines("wave", source.data.animations.wave);
  const reversedTimelines = collectTimelines("wave-reversed", reversed);
  for (const original of sourceTimelines.filter((timeline) => timeline.section === "bones")) {
    const backward = reversedTimelines.find((timeline) => timeline.section === "bones"
      && timeline.target === original.target && timeline.type === original.type);
    assert.ok(backward);
    for (const time of [0, 0.1, 0.4, 0.5, 0.75, 1, 1.25, 1.5]) {
      const forwardValues = sampleBoneTimeline(original, original.type, 1.5 - time);
      const backwardValues = sampleBoneTimeline(backward, backward.type, time);
      for (const field of Object.keys(forwardValues)) {
        assert.ok(Math.abs(forwardValues[field] - backwardValues[field]) < 0.00000001,
          `${original.target}/${original.type}/${field} at ${time}`);
      }
    }
  }
});

test("reverse rejects unrepresentable discrete state, stepped curves, and missing start keys", () => {
  const operation = { kind: "reverse_bone_animation", sourceAnimation: "wave", newAnimation: "backward" };
  const discrete = structuredClone(fixture);
  discrete.animations.wave.slots = { hand: { attachment: [{ name: "hand" }] } };
  assert.throws(() => reverseBoneAnimationText(document(discrete), operation),
    { code: "UNSUPPORTED_REVERSE_TIMELINE" });
  const stepped = structuredClone(fixture);
  stepped.animations.wave.bones.arm.rotate[0].curve = "stepped";
  assert.throws(() => reverseBoneAnimationText(document(stepped), operation),
    { code: "UNSUPPORTED_REVERSE_CURVE" });
  const lateStart = structuredClone(fixture);
  lateStart.animations.wave.bones.arm.rotate[0].time = 0.1;
  assert.throws(() => reverseBoneAnimationText(document(lateStart), operation),
    { code: "MISSING_START_KEY" });
  assert.throws(() => reverseBoneAnimationText(document(), { ...operation, duration: 1 }),
    { code: "INVALID_REVERSE_DURATION" });
});

test("reversing stages a new clip without changing the source until commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-reverse-"));
  const path = join(directory, "skeleton.json");
  const original = `${JSON.stringify(fixture, null, 2)}\n`;
  await writeFile(path, original);
  try {
    const edits = new EditStore();
    const stage = await edits.preview(path, [{ kind: "reverse_bone_animation",
      sourceAnimation: "wave", newAnimation: "wave-reversed" }]);
    assert.equal(stage.summaries[0].kind, "reverse_bone_animation");
    assert.deepEqual(stage.diagnostics, []);
    assert.equal(await readFile(path, "utf8"), original);
    await edits.commit(stage.editId);
    const after = await readDocument(path);
    assert.deepEqual(validateDocument(after), []);
    assert.ok(after.data.animations["wave-reversed"]);
    assert.deepEqual(after.data.animations.wave, fixture.animations.wave);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
