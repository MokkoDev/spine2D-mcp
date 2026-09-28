import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDocument } from "../dist/spine/document.js";
import { makeLoopText } from "../dist/spine/loop.js";
import { checkAnimation } from "../dist/spine/quality.js";
import { validateDocument } from "../dist/spine/validate.js";

const fixture = {
  skeleton: { spine: "4.3.26" },
  bones: [{ name: "root" }, { name: "arm", parent: "root" }],
  slots: [{ name: "hand", bone: "arm", attachment: "open" }],
  skins: [{ name: "default", attachments: { hand: { open: {}, closed: {} } } }],
  events: { beat: {} },
  animations: {
    idle: {
      bones: { arm: { rotate: [
        { value: 0, curve: [0.1, 2, 0.3, 20] },
        { time: 0.5, value: 20 },
        { time: 1, value: 5 },
      ] } },
      slots: { hand: { attachment: [
        { name: "open" },
        { time: 0.5, name: "closed" },
      ] } },
      events: [{ time: 0.5, name: "beat" }],
    },
  },
};

test("make_loop closes numeric and discrete pose timelines and eases scalar seams", async () => {
  const original = parseDocument("/tmp/loop.json", JSON.stringify(fixture, null, 2));
  const edited = makeLoopText(original, { kind: "make_loop", animation: "idle" });
  const after = parseDocument(original.path, edited.text);
  assert.deepEqual(validateDocument(after), []);
  const clip = after.data.animations.idle;
  assert.equal(edited.summary.duration, 1);
  assert.equal(edited.summary.seamIssuesAfter, 0);
  assert.equal(edited.summary.timelinesSmoothed, 1);
  assert.equal(edited.summary.closingKeysAdded, 1);
  assert.equal(clip.bones.arm.rotate.at(-1).value, 0);
  assert.equal(clip.slots.hand.attachment.at(-1).time, 1);
  assert.equal(clip.slots.hand.attachment.at(-1).name, "open");
  assert.deepEqual(clip.bones.arm.rotate[1].curve, [0.666666666667, 20, 0.833333333333, 0]);
  assert.equal(clip.bones.arm.rotate[0].curve[1], 0);
  const checks = await checkAnimation(after, "idle", { loop: true });
  assert.ok(!checks.hints.some((hint) => hint.code === "LOOP_DISCONTINUITY" || hint.code === "LOOP_ATTACHMENT_MISMATCH"));
});

test("make_loop rejects incomplete start poses and incompatible ranges", () => {
  const source = structuredClone(fixture);
  source.animations.idle.bones.arm.rotate[0].time = 0.2;
  const document = parseDocument("/tmp/loop-missing-start.json", JSON.stringify(source));
  assert.throws(() => makeLoopText(document, { kind: "make_loop", animation: "idle" }), (error) => error.code === "MISSING_START_KEY");
  const valid = parseDocument("/tmp/loop-range.json", JSON.stringify(fixture));
  assert.throws(() => makeLoopText(valid, { kind: "make_loop", animation: "idle", duration: 0.75 }), (error) => error.code === "LOOP_RANGE_CONFLICT");
});

test("loop easing keeps both Bézier channels for one-axis translate and scale keys", () => {
  const source = structuredClone(fixture);
  source.animations.idle.bones.arm.scale = [{ x: 0.8 }, { time: 0.5, x: 1.2 }];
  source.animations.idle.bones.arm.translate = [{ x: 10 }];
  const document = parseDocument("/tmp/loop-axis.json", JSON.stringify(source));
  const edited = parseDocument(document.path, makeLoopText(document, { kind: "make_loop", animation: "idle" }).text);
  assert.deepEqual(validateDocument(edited), []);
  const { scale, translate } = edited.data.animations.idle.bones.arm;
  assert.equal(scale[1].curve.length, 8);
  assert.deepEqual(scale[1].curve.slice(4), [0.666666666667, 1, 0.833333333333, 1]);
  assert.equal(translate[0].curve.length, 8);
  assert.deepEqual(translate[0].curve.slice(4), [0.333333333333, 0, 0.666666666667, 0]);
});
