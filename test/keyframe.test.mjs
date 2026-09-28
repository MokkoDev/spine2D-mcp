import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { deleteKeyframeText, setKeyframeText } from "../dist/spine/keyframe.js";
import { validateDocument } from "../dist/spine/validate.js";

const fixture = {
  skeleton: { spine: "4.3.75" },
  bones: [{ name: "root" }, { name: "arm", parent: "root" }],
  slots: [{ name: "body", bone: "root", attachment: "body" }, { name: "hand", bone: "arm" }],
  skins: [{ name: "default", attachments: { body: { body: { width: 2, height: 2 } } } }],
  constraints: [{ type: "physics", name: "spring", bone: "root" }],
  events: { tap: {}, clap: {} },
  animations: { swing: {
    bones: { arm: { rotate: [{ value: 0, curve: [0.25, 0, 0.75, 90] }, { time: 1, value: 90 }] } },
    events: [{ time: 0.5, name: "tap" }, { time: 0.5, name: "clap" }],
  } },
};

function document(data = fixture) {
  return parseDocument("/tmp/keyframe-fixture.json", `${JSON.stringify(data, null, 2)}\n`);
}

function set(source, selector, time, values, curvePolicy) {
  return setKeyframeText(source, { kind: "set_keyframe", animation: "swing", selector, time, values, curvePolicy });
}

function del(source, selector, time, eventName) {
  return deleteKeyframeText(source, { kind: "delete_keyframe", animation: "swing", selector, time, eventName });
}

test("typed key editing creates timelines for bones, slots, physics, and draw order", () => {
  let current = document();
  const operations = [
    [{ section: "bones", target: "arm", timelineType: "translate" }, 0, { x: 4, y: -2 }],
    [{ section: "slots", target: "body", timelineType: "rgba" }, 0, { color: "ff00ffff" }],
    [{ section: "slots", target: "body", timelineType: "attachment" }, 0, { name: "body" }],
    [{ section: "physics", target: "spring", timelineType: "wind" }, 0, { value: 0.5 }],
    [{ section: "drawOrder" }, 0, { offsets: [{ slot: "body", offset: 1 }, { slot: "hand", offset: -1 }] }],
  ];
  for (const [selector, time, values] of operations) {
    const result = set(current, selector, time, values);
    assert.equal(result.summary.action, "inserted");
    current = parseDocument("/tmp/keyframe-fixture.json", result.text);
  }
  assert.deepEqual(validateDocument(current), []);
  assert.equal(current.data.animations.swing.bones.arm.translate[0].x, 4);
  assert.equal(current.data.animations.swing.physics.spring.wind[0].value, 0.5);
  assert.equal(current.data.animations.swing.slots.body.rgba[0].color, "ff00ffff");
  assert.equal(current.data.animations.swing.drawOrder.length, 1);
});

test("inserting inside a Bézier segment requires explicit curve handling", () => {
  const selector = { section: "bones", target: "arm", timelineType: "rotate" };
  assert.throws(() => set(document(), selector, 0.5, { value: 45 }), { code: "CURVE_SPLIT_REQUIRED" });
  const result = set(document(), selector, 0.5, { value: 45 }, "linearize");
  const current = parseDocument("/tmp/keyframe-fixture.json", result.text);
  assert.equal(result.summary.curveResets, 1);
  assert.deepEqual(current.data.animations.swing.bones.arm.rotate.map((key) => key.time ?? 0), [0, 0.5, 1]);
  assert.equal(Object.hasOwn(current.data.animations.swing.bones.arm.rotate[0], "curve"), false);
  assert.deepEqual(validateDocument(current), []);
  const removed = del(current, selector, 0.5);
  assert.deepEqual(JSON.parse(removed.text).animations.swing.bones.arm.rotate.map((key) => key.time ?? 0), [0, 1]);
});

test("updating a keyed value clears both adjacent Bézier segments only when requested", () => {
  const curved = structuredClone(fixture);
  curved.animations.swing.bones.arm.rotate = [
    { value: 0, curve: [0.1, 0, 0.4, 40] },
    { time: 0.5, value: 40, curve: [0.6, 40, 0.9, 90] },
    { time: 1, value: 90 },
  ];
  const selector = { section: "bones", target: "arm", timelineType: "rotate" };
  const original = document(curved);
  assert.throws(() => set(original, selector, 0.5, { value: 50 }),
    { code: "CURVE_VALUE_EDIT_REQUIRES_LINEARIZE" });
  const result = set(original, selector, 0.5, { value: 50 }, "linearize");
  assert.equal(result.summary.curveResets, 2);
  const after = parseDocument("/tmp/keyframe-fixture.json", result.text);
  const keys = after.data.animations.swing.bones.arm.rotate;
  assert.equal(keys[0].curve, undefined);
  assert.equal(keys[1].curve, undefined);
  assert.equal(keys[1].value, 50);
  assert.deepEqual(validateDocument(after), []);
  assert.equal(set(original, selector, 0.5, { value: 40 }).summary.curveResets, 0);
});

test("event keys at the same time require a name for deletion and preserve unrelated events", () => {
  const selector = { section: "events" };
  assert.throws(() => del(document(), selector, 0.5), { code: "AMBIGUOUS_KEY" });
  const result = del(document(), selector, 0.5, "tap");
  assert.deepEqual(JSON.parse(result.text).animations.swing.events, [{ time: 0.5, name: "clap" }]);
  const updated = set(parseDocument("/tmp/keyframe-fixture.json", result.text), selector, 0.5, { name: "clap", int: 2 });
  assert.equal(updated.summary.action, "updated");
  assert.deepEqual(JSON.parse(updated.text).animations.swing.events, [{ time: 0.5, name: "clap", int: 2 }]);
  const missing = set(document(), selector, 0.7, { name: "missing" });
  assert.ok(validateDocument(parseDocument("/tmp/keyframe-fixture.json", missing.text)).some((item) => item.code === "MISSING_EVENT"));
});

test("deleting the final key prunes its timeline and clears affected Bézier data", () => {
  const selector = { section: "bones", target: "arm", timelineType: "rotate" };
  const last = del(document(), selector, 1);
  assert.equal(last.summary.curveResets, 1);
  const oneKey = parseDocument("/tmp/keyframe-fixture.json", last.text);
  assert.equal(Object.hasOwn(oneKey.data.animations.swing.bones.arm.rotate[0], "curve"), false);
  const none = del(oneKey, selector, 0);
  assert.equal(Object.hasOwn(JSON.parse(none.text).animations.swing, "bones"), false);
  assert.deepEqual(validateDocument(parseDocument("/tmp/keyframe-fixture.json", none.text)), []);
});

test("staged key batches stay atomic when a later operation is invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-keyframe-"));
  const path = join(directory, "skeleton.json");
  const source = `${JSON.stringify(fixture)}\n`;
  await writeFile(path, source);
  try {
    const edits = new EditStore();
    await assert.rejects(edits.preview(path, [
      { kind: "set_keyframe", animation: "swing", selector: { section: "bones", target: "arm", timelineType: "scale" }, time: 0, values: { x: 1.2, y: 1.2 } },
      { kind: "set_keyframe", animation: "swing", selector: { section: "slots", target: "body", timelineType: "rgba" }, time: 0, values: { color: "not-hex" } },
    ]), { code: "INVALID_KEY_VALUE" });
    assert.equal(await readFile(path, "utf8"), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
