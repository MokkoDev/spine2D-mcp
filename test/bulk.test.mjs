import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bulkKeysText } from "../dist/spine/bulk.js";
import { parseDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { validateDocument } from "../dist/spine/validate.js";

const fixture = {
  skeleton: { spine: "4.3.26" },
  bones: [{ name: "root" }, { name: "arm", parent: "root" }],
  slots: [{ name: "hand", bone: "arm", attachment: "hand" }],
  skins: [{ name: "default", attachments: { hand: { hand: {} } } }],
  events: { step: {} },
  animations: {
    walk: {
      bones: { arm: { rotate: [{ value: 0, curve: [0.2, 0, 0.8, 90] }, { time: 1, value: 90 }] } },
      slots: { hand: { attachment: [{ name: "hand" }, { time: 0.5, name: "hand" }] } },
      events: [{ time: 0.25, name: "step", float: 1 }, { time: 0.75, name: "step", float: 2 }],
      drawOrder: [{ time: 0.5, offsets: [{ slot: "hand", offset: 0 }] }],
    },
    run: { events: [{ time: 0.2, name: "step" }] },
  },
};

function edit(operation) {
  const source = parseDocument("/tmp/bulk-keys-fixture.json", `${JSON.stringify(fixture, null, 2)}\n`);
  const result = bulkKeysText(source, { kind: "bulk_keys", animation: "walk", ...operation });
  const after = parseDocument(source.path, result.text);
  assert.deepEqual(validateDocument(after), []);
  return { result, data: after.data };
}

test("bulk time edits keep events, attachments, draw order, and absolute Bézier controls aligned", () => {
  const moved = edit({ action: "move", delta: 0.25 });
  const walk = moved.data.animations.walk;
  assert.deepEqual(walk.bones.arm.rotate.map((key) => key.time), [0.25, 1.25]);
  assert.deepEqual(walk.bones.arm.rotate[0].curve, [0.45, 0, 1.05, 90]);
  assert.deepEqual(walk.events.map((key) => key.time), [0.5, 1]);
  assert.deepEqual(walk.slots.hand.attachment.map((key) => key.time), [0.25, 0.75]);
  assert.equal(walk.drawOrder[0].time, 0.75);
  assert.equal(moved.result.summary.timelines, 4);
  assert.equal(moved.result.summary.keysSelected, 7);

  const scaled = edit({ action: "scale", section: "bones", factor: 2 });
  assert.equal(scaled.data.animations.walk.bones.arm.rotate[1].time, 2);
  assert.deepEqual(scaled.data.animations.walk.bones.arm.rotate[0].curve, [0.4, 0, 1.6, 90]);
});

test("bulk duplicate, delete, offset, and quantize retain valid key order and values", () => {
  const selector = { section: "events", from: 0.25, to: 0.25 };
  const duplicated = edit({ action: "duplicate", delta: 0.25, ...selector });
  assert.deepEqual(duplicated.data.animations.walk.events.map((key) => key.time), [0.25, 0.5, 0.75]);
  assert.equal(duplicated.data.animations.walk.events[1].float, 1);
  const curvedCopy = edit({ action: "duplicate", delta: 0.5, section: "bones", from: 0, to: 0 });
  const rotation = curvedCopy.data.animations.walk.bones.arm.rotate;
  assert.deepEqual(rotation.map((key) => key.time ?? 0), [0, 0.5, 1]);
  assert.equal(rotation[0].curve, undefined);
  assert.deepEqual(rotation[1].curve, [0.6, 0, 0.9, 90]);

  const deleted = edit({ action: "delete", ...selector });
  assert.deepEqual(deleted.data.animations.walk.events.map((key) => key.time), [0.75]);
  const allDeleted = edit({ action: "delete", section: "events" });
  assert.equal(Object.hasOwn(allDeleted.data.animations.walk, "events"), false);

  const offset = edit({ action: "offset", field: "float", amount: 0.5, ...selector });
  assert.deepEqual(offset.data.animations.walk.events.map((key) => key.float), [1.5, 2]);

  const quantized = edit({ action: "quantize", section: "events", grid: 0.5 });
  assert.deepEqual(quantized.data.animations.walk.events.map((key) => key.time), [0.5, 1]);
});

test("validator flags empty timelines that Spine cannot import", () => {
  const invalid = structuredClone(fixture);
  invalid.animations.walk.events = [];
  const document = parseDocument("/tmp/empty-timeline.json", JSON.stringify(invalid));
  assert.ok(validateDocument(document).some((item) => item.code === "EMPTY_TIMELINE" && item.path === "/animations/walk/events"));
});

test("bulk staging is atomic across animations and rejects unsafe changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-bulk-"));
  const path = join(directory, "character.json");
  const original = JSON.stringify(fixture, null, 2);
  await writeFile(path, original);
  try {
    const store = new EditStore();
    await assert.rejects(store.preview(path, [
      { kind: "bulk_keys", animation: "walk", action: "move", section: "events", delta: 0.1 },
      { kind: "bulk_keys", animation: "walk", action: "offset", section: "bones", field: "value", amount: 5 },
    ]), (error) => error.code === "UNSUPPORTED_CURVE_VALUE_EDIT");
    assert.equal(await readFile(path, "utf8"), original);
    await assert.rejects(store.preview(path, [{ kind: "bulk_keys", animation: "walk", action: "move", section: "bones", from: 0, to: 0, delta: 2 }]),
      (error) => error.code === "KEY_ORDER_CONFLICT");

    const preview = await store.preview(path, [
      { kind: "bulk_keys", animation: "walk", action: "move", section: "events", delta: 0.1 },
      { kind: "bulk_keys", animation: "run", action: "move", section: "events", delta: 0.1 },
    ]);
    assert.equal(preview.summaries.length, 2);
    assert.equal(await readFile(path, "utf8"), original);
    const committed = await store.commit(preview.editId);
    assert.equal(await readFile(committed.backupPath, "utf8"), original);
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.equal(after.animations.walk.events[0].time, 0.35);
    assert.equal(after.animations.run.events[0].time, 0.3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("large key changes stay compact in tool output and complete in the diff resource", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-bulk-preview-"));
  const path = join(directory, "character.json");
  const source = structuredClone(fixture);
  source.animations.walk.events[0].note = "x".repeat(5000);
  await writeFile(path, JSON.stringify(source));
  try {
    const store = new EditStore();
    const preview = await store.preview(path, [{ kind: "bulk_keys", animation: "walk", action: "duplicate", section: "events", from: 0.25, to: 0.25, delta: 0.1 }]);
    assert.equal(preview.changeValuesTruncated, true);
    assert.ok(preview.changes.some((change) => change.after?.omitted === true));
    const complete = store.changes(preview.editId);
    assert.ok(complete.changes.some((change) => change.after?.note?.length === 5000));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
