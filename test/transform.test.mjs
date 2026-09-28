import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { skeletonText } from "../dist/spine/create.js";
import { parseDocument, readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { sampleBoneTimeline } from "../dist/spine/pose.js";
import { collectTimelines } from "../dist/spine/timelines.js";
import { transformAnimationText } from "../dist/spine/transform.js";
import { validateDocument } from "../dist/spine/validate.js";

function fixture(version = "4.3") {
  const data = JSON.parse(skeletonText(version));
  data.bones.push({ name: "left", parent: "root" }, { name: "right", parent: "root" });
  data.events = { leftStep: {}, rightStep: {} };
  data.animations.swing = {
    bones: {
      left: { rotate: [{ time: 0, value: 10, curve: [0.25, 10, 0.75, 20] }, { time: 1, value: 20 }] },
      right: { translate: [{ time: 0, x: 5, y: 2 }, { time: 1, x: 10, y: 3 }] },
    },
    events: [{ time: 0.5, name: "leftStep" }],
  };
  data.animations.bounce = {
    bones: { left: { translate: [{ time: 0, x: 1, y: 0,
      curve: [0.25, 1.25, 0.75, 1.75, 0.25, 0, 0.75, 0] }, { time: 1, x: 2, y: 0 }] } },
    events: [{ time: 0.25, name: "rightStep" }],
  };
  return parseDocument("/tmp/transform.json", `${JSON.stringify(data, null, 2)}\n`);
}

for (const version of ["4.2", "4.3"]) {
  test(`Spine ${version} combines disjoint tracks and merges shifted events`, () => {
    const source = fixture(version);
    const result = transformAnimationText(source, { kind: "transform_animation", mode: "combine",
      firstAnimation: "swing", secondAnimation: "bounce", secondStart: 1, newAnimation: "combo" });
    const after = parseDocument(source.path, result.text);
    const combo = after.data.animations.combo;
    assert.equal(combo.bones.left.rotate[0].value, 10);
    assert.equal(combo.bones.left.translate[0].time, 1);
    assert.deepEqual(combo.bones.left.translate[0].curve, [1.25, 1.25, 1.75, 1.75, 1.25, 0, 1.75, 0]);
    assert.deepEqual(combo.events.map((event) => [event.time, event.name]),
      [[0.5, "leftStep"], [1.25, "rightStep"]]);
    assert.equal(result.summary.duration, 2);
    assert.deepEqual(validateDocument(after), []);
    const conflicting = structuredClone(source.data);
    conflicting.animations.bounce.bones.left.rotate = [{ time: 0, value: 3 }];
    const bad = parseDocument(source.path, JSON.stringify(conflicting));
    assert.throws(() => transformAnimationText(bad, { kind: "transform_animation", mode: "combine",
      firstAnimation: "swing", secondAnimation: "bounce", newAnimation: "combo" }), (error) => {
      assert.equal(error.code, "TIMELINE_CONFLICT");
      assert.deepEqual(error.details.timelines, ["/animations/swing/bones/left/rotate"]);
      return true;
    });
  });

  test(`Spine ${version} mirrors mapped bone motion and event names`, () => {
    const source = fixture(version);
    const result = transformAnimationText(source, { kind: "transform_animation", mode: "mirror",
      sourceAnimation: "swing", newAnimation: "mirrored", bonePairs: [["left", "right"]],
      eventMap: { leftStep: "rightStep" } });
    const after = parseDocument(source.path, result.text);
    const mirrored = after.data.animations.mirrored;
    assert.deepEqual(mirrored.bones.right.rotate.map((key) => key.value), [-10, -20]);
    assert.deepEqual(mirrored.bones.right.rotate[0].curve, [0.25, -10, 0.75, -20]);
    assert.deepEqual(mirrored.bones.left.translate.map((key) => [key.x, key.y]), [[-5, 2], [-10, 3]]);
    assert.equal(mirrored.events[0].name, "rightStep");
    assert.equal(result.summary.mirroredBones, 1);
    assert.deepEqual(validateDocument(after), []);
    assert.throws(() => transformAnimationText(source, { kind: "transform_animation", mode: "mirror",
      sourceAnimation: "swing", newAnimation: "bad", bonePairs: [["left", "missing"]] }),
    { code: "INVALID_BONE_PAIRS" });
    assert.throws(() => transformAnimationText(source, { kind: "transform_animation", mode: "mirror",
      sourceAnimation: "swing", newAnimation: "bad", secondStart: 1 }),
    { code: "INVALID_TRANSFORM_OPTIONS" });
  });

  test(`Spine ${version} extracts exact bone motion across Bézier and linear boundaries`, () => {
    const source = fixture(version);
    const result = transformAnimationText(source, { kind: "transform_animation", mode: "segment",
      sourceAnimation: "swing", newAnimation: "middle", from: 0.2, to: 0.8 });
    const after = parseDocument(source.path, result.text);
    const originalTracks = collectTimelines("swing", source.data.animations.swing);
    const extractedTracks = collectTimelines("middle", after.data.animations.middle);
    for (const target of ["left", "right"]) {
      const type = target === "left" ? "rotate" : "translate";
      const original = originalTracks.find((track) => track.section === "bones" && track.target === target);
      const extracted = extractedTracks.find((track) => track.section === "bones" && track.target === target);
      assert.ok(original && extracted);
      for (const localTime of [0, 0.1, 0.3, 0.45, 0.6]) {
        const beforeValue = sampleBoneTimeline(original, type, localTime + 0.2);
        const afterValue = sampleBoneTimeline(extracted, type, localTime);
        for (const field of Object.keys(beforeValue)) {
          assert.ok(Math.abs(beforeValue[field] - afterValue[field]) < 1e-8,
            `${target}.${field} differs at ${localTime}: ${beforeValue[field]} vs ${afterValue[field]}`);
        }
      }
    }
    assert.deepEqual(after.data.animations.middle.events.map((key) => [key.time, key.name]), [[0.3, "leftStep"]]);
    assert.equal(result.summary.boundaryKeys, 4);
    assert.equal(result.summary.requestedDuration, 0.6);
    assert.deepEqual(validateDocument(after), []);
    assert.deepEqual(source.data.animations.swing.bones.left.rotate[0].curve, [0.25, 10, 0.75, 20]);
  });
}

test("segment carries discrete state, filters events, and reports non-bone curve limits", () => {
  const data = structuredClone(fixture().data);
  data.slots = [{ name: "hand", bone: "left", attachment: "open" }];
  data.skins = [{ name: "default", attachments: { hand: { open: {}, closed: {} } } }];
  data.animations.swing.slots = { hand: { attachment: [
    { time: 0, name: "open" }, { time: 0.4, name: "closed" }, { time: 0.9, name: "open" },
  ] } };
  data.animations.swing.events.push({ time: 0.95, name: "rightStep" });
  const source = parseDocument("/tmp/discrete-transform.json", JSON.stringify(data));
  assert.deepEqual(validateDocument(source), []);
  const result = transformAnimationText(source, { kind: "transform_animation", mode: "segment",
    sourceAnimation: "swing", newAnimation: "late", from: 0.6, to: 1 });
  const after = parseDocument(source.path, result.text);
  assert.deepEqual(after.data.animations.late.slots.hand.attachment,
    [{ time: 0, name: "closed" }, { time: 0.3, name: "open" }]);
  assert.deepEqual(after.data.animations.late.events, [{ time: 0.35, name: "rightStep" }]);
  assert.deepEqual(validateDocument(after), []);
  data.animations.swing.slots.hand.alpha = [
    { time: 0, value: 0.2, curve: [0.25, 0.3, 0.75, 0.7] }, { time: 1, value: 0.8 },
  ];
  const unsupported = parseDocument(source.path, JSON.stringify(data));
  assert.throws(() => transformAnimationText(unsupported, { kind: "transform_animation", mode: "segment",
    sourceAnimation: "swing", newAnimation: "late", from: 0.6, to: 1 }), (error) => {
    assert.equal(error.code, "UNSUPPORTED_SEGMENT_BOUNDARY");
    assert.equal(error.details.path, "/animations/swing/slots/hand/alpha/0");
    return true;
  });
});

test("segment reports when requested duration cannot be represented by retained keys", () => {
  const data = structuredClone(fixture().data);
  data.animations.eventOnly = { events: [{ time: 0.3, name: "leftStep" }] };
  const source = parseDocument("/tmp/event-transform.json", JSON.stringify(data));
  const result = transformAnimationText(source, { kind: "transform_animation", mode: "segment",
    sourceAnimation: "eventOnly", newAnimation: "window", from: 0.2, to: 0.8 });
  assert.equal(result.summary.duration, 0.1);
  assert.equal(result.summary.requestedDuration, 0.6);
  assert.equal(result.summary.reviewHints.length, 1);
  assert.deepEqual(validateDocument(parseDocument(source.path, result.text)), []);
  assert.throws(() => transformAnimationText(source, { kind: "transform_animation", mode: "segment",
    sourceAnimation: "eventOnly", newAnimation: "bad", from: 1, to: 0.5 }),
  { code: "INVALID_SEGMENT_RANGE" });
});

test("variant and reverse modes use the established time and bone-motion transformations", () => {
  const source = fixture();
  const variant = transformAnimationText(source, { kind: "transform_animation", mode: "variant",
    sourceAnimation: "swing", newAnimation: "slow", timeScale: 2, startAt: 0.5 });
  assert.equal(variant.summary.mode, "variant");
  assert.equal(JSON.parse(variant.text).animations.slow.bones.left.rotate[1].time, 2.5);
  const reversed = transformAnimationText(source, { kind: "transform_animation", mode: "reverse",
    sourceAnimation: "swing", newAnimation: "backward" });
  assert.equal(reversed.summary.mode, "reverse");
  assert.deepEqual(validateDocument(parseDocument(source.path, reversed.text)), []);
});

test("transform variants stage atomically with unchanged source animations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-transform-"));
  const path = join(directory, "rig.json");
  try {
    const source = fixture();
    await writeFile(path, source.text);
    const before = await readFile(path, "utf8");
    const edits = new EditStore();
    const stage = await edits.preview(path, [
      { kind: "transform_animation", mode: "combine", firstAnimation: "swing", secondAnimation: "bounce",
        newAnimation: "combo" },
      { kind: "transform_animation", mode: "mirror", sourceAnimation: "combo", newAnimation: "combo-mirror",
        bonePairs: [["left", "right"]] },
    ]);
    assert.equal(stage.summaries.length, 2);
    assert.equal(await readFile(path, "utf8"), before);
    await edits.commit(stage.editId);
    const after = await readDocument(path);
    assert.ok(after.data.animations.swing && after.data.animations.bounce);
    assert.ok(after.data.animations.combo && after.data.animations["combo-mirror"]);
    assert.deepEqual(validateDocument(after), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
