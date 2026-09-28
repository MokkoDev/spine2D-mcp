import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDocument } from "../dist/spine/document.js";
import { compareSemanticFidelity } from "../dist/spine/fidelity.js";

const base = {
  skeleton: { spine: "4.3.12", hash: "old", x: 0, y: 0, width: 10, height: 10 },
  bones: [{ name: "root" }, { name: "arm", parent: "root", rotation: 20 }],
  slots: [{ name: "hand", bone: "arm", attachment: "hand" }],
  skins: [{ name: "default", attachments: { hand: { hand: { type: "region", width: 32, height: 32 } } } }],
  events: { beat: { int: 2 } },
  animations: {
    wave: {
      bones: { arm: { rotate: [
        { time: 0, value: -20, curve: [0.25, -10, 0.75, 10] },
        { time: 1, value: 20 },
      ] } },
      events: [{ time: 0.5, name: "beat" }],
    },
  },
};

function document(data) {
  return parseDocument("/tmp/rig.json", JSON.stringify(data));
}

function compare(other, first = base) {
  return compareSemanticFidelity(document(first), document(other));
}

test("semantic fidelity allows documented defaults, export metadata, formatting, and decimal rounding", () => {
  const exported = structuredClone(base);
  exported.skeleton = { spine: "4.3.99", hash: "new", x: 2, y: 3, width: 20, height: 30, fps: 30 };
  exported.bones[1].scaleX = 1;
  exported.slots[0].color = "ffffffff";
  exported.skins[0].attachments.hand.hand.path = "hand";
  exported.skins[0].attachments.hand.hand.x = 0;
  exported.skins[0].attachments.hand.hand.color = "ffffffff";
  exported.events.beat.string = null;
  exported.animations.wave.bones.arm.rotate[0].value = -19.99996;
  exported.animations.wave.events[0].int = 2;
  const reordered = JSON.parse(JSON.stringify(exported));
  reordered.bones[1] = { scaleX: 1, rotation: 20, parent: "root", name: "arm" };
  const result = compare(reordered);
  assert.equal(result.differenceCount, 0);
  assert.equal(result.differencesTruncated, false);
});

test("semantic fidelity reports key value, curve, reference, and setup changes despite equal counts", () => {
  const changed = structuredClone(base);
  changed.bones[1].rotation = 21;
  changed.slots[0].bone = "root";
  changed.skins[0].attachments.hand.hand.width = 31;
  changed.animations.wave.bones.arm.rotate[0].value = -19;
  changed.animations.wave.bones.arm.rotate[0].curve[1] = -9;
  changed.animations.wave.events[0].name = "other";
  const result = compare(changed);
  assert.equal(result.differenceCount, 6);
  assert.deepEqual(result.differences.map((item) => item.path), [
    "/animations/wave/bones/arm/rotate/0/curve/1",
    "/animations/wave/bones/arm/rotate/0/value",
    "/animations/wave/events/0/name",
    "/bones/1/rotation",
    "/skins/0/attachments/hand/hand/width",
    "/slots/0/bone",
  ]);
  assert.deepEqual(result.differences.find((item) => item.path.endsWith("/curve/1")),
    { path: "/animations/wave/bones/arm/rotate/0/curve/1", staged: "-10", reexported: "-9" });
});

test("semantic fidelity preserves array order and reports additions or removals", () => {
  const changed = structuredClone(base);
  changed.bones.reverse();
  changed.animations.wave.bones.arm.rotate.pop();
  const result = compare(changed);
  assert.ok(result.differences.some((item) => item.path === "/bones/0/name"));
  assert.ok(result.differences.some((item) => item.path === "/animations/wave/bones/arm/rotate/length"));
});

test("semantic fidelity does not allow a different Spine minor version or a nondefault omission", () => {
  const changed = structuredClone(base);
  changed.skeleton.spine = "4.2.99";
  changed.bones[1].rotation = 0;
  changed.animations.wave.bones.arm.rotate[0].curve = "stepped";
  const result = compare(changed);
  assert.deepEqual(result.differences.map((item) => item.path), [
    "/animations/wave/bones/arm/rotate/0/curve",
    "/bones/1/rotation",
    "/skeleton/spine",
  ]);
});

test("semantic fidelity allows the implicit empty default skin and escapes pointer names", () => {
  const empty = structuredClone(base);
  empty.skins = [{ name: "default", attachments: {} }];
  const reexported = structuredClone(empty);
  delete reexported.skins;
  assert.equal(compare(reexported, empty).differenceCount, 0);

  const named = structuredClone(base);
  named.animations["wave/alt"] = structuredClone(named.animations.wave);
  named.animations["wave/alt"].bones.arm.rotate[0].value = 3;
  const result = compare(named);
  assert.ok(result.differences.some((item) => item.path === "/animations/wave~1alt"));
});

test("semantic fidelity checks other animations and unfamiliar setup properties", () => {
  const staged = structuredClone(base);
  staged.animations.idle = { bones: { arm: { rotate: [{ value: 5 }] } } };
  staged.bones[1].customEditorFlag = "keep";
  const reexported = structuredClone(staged);
  reexported.animations.idle.bones.arm.rotate[0].value = 6;
  delete reexported.bones[1].customEditorFlag;
  assert.deepEqual(compare(reexported, staged).differences.map((item) => item.path), [
    "/animations/idle/bones/arm/rotate/0/value", "/bones/1/customEditorFlag",
  ]);
});

test("semantic fidelity accepts equivalent constant curves and an omitted clear-attachment name", () => {
  const original = structuredClone(base);
  original.animations.wave.bones.arm.rotate = [
    { time: 0, value: 10 }, { time: 0.5, value: 10, curve: [0.6, 10, 0.8, 10] },
    { time: 1, value: 10 },
  ];
  original.animations.wave.slots = { hand: { attachment: [{ time: 0.5, name: null }] } };
  const exported = structuredClone(original);
  exported.animations.wave.bones.arm.rotate[0].curve = "stepped";
  exported.animations.wave.bones.arm.rotate[1].curve = "stepped";
  delete exported.animations.wave.slots.hand.attachment[0].name;
  assert.equal(compare(exported, original).differenceCount, 0);
  exported.animations.wave.bones.arm.rotate[1].value = 11;
  assert.ok(compare(exported, original).differenceCount > 0);
});
