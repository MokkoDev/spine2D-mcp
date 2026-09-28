import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { replaceKeyframeText } from "../dist/spine/replace-keyframe.js";
import { validateDocument } from "../dist/spine/validate.js";

const fixture = {
  skeleton: { spine: "4.3.75" },
  bones: [{ name: "root" }, { name: "arm", parent: "root" }],
  animations: { punch: { bones: { arm: { rotate: [
    { value: 0, curve: [0.1, 0, 0.4, 40] },
    { time: 0.5, value: 40, curve: [0.6, 40, 0.9, 90] },
    { time: 1, value: 90 },
  ] } } } },
};

const operation = { kind: "replace_keyframe", animation: "punch", bone: "arm",
  timelineType: "rotate", time: 0.5, values: { value: 50 }, easing: "ease_in_out" };

function document() {
  return parseDocument("/tmp/replace-keyframe-fixture.json", JSON.stringify(fixture));
}

test("replacing a key updates value and outgoing preset while clearing the stale incoming curve", () => {
  const result = replaceKeyframeText(document(), operation);
  const after = parseDocument("/tmp/replace-keyframe-fixture.json", result.text);
  const keys = after.data.animations.punch.bones.arm.rotate;
  assert.equal(keys[0].curve, undefined);
  assert.equal(keys[1].value, 50);
  assert.deepEqual(keys[1].curve, [0.71, 50, 0.79, 90]);
  assert.equal(keys[2].value, 90);
  assert.equal(result.summary.incomingCurveReset, true);
  assert.equal(result.summary.outgoingEasingChanged, true);
  assert.equal(result.summary.changed, true);
  assert.deepEqual(validateDocument(after), []);
});

test("replacement requires an existing nonfinal key and validates custom easing", () => {
  assert.throws(() => replaceKeyframeText(document(), { ...operation, time: 0.25 }), { code: "KEY_NOT_FOUND" });
  assert.throws(() => replaceKeyframeText(document(), { ...operation, time: 1 }), { code: "NO_NEXT_KEY" });
  assert.throws(() => replaceKeyframeText(document(), { ...operation, values: {} }), { code: "INVALID_KEY_VALUES" });
  assert.throws(() => replaceKeyframeText(document(), { ...operation, easing: "bezier" }), { code: "INVALID_CURVE_CONTROLS" });
});

test("replacement stages the combined edit without modifying the source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-replace-keyframe-"));
  const path = join(directory, "skeleton.json");
  const source = JSON.stringify(fixture);
  await writeFile(path, source);
  try {
    const edits = new EditStore();
    const stage = await edits.preview(path, [operation]);
    assert.equal(stage.summaries[0].kind, "replace_keyframe");
    assert.equal(stage.diagnostics.length, 0);
    assert.equal(await readFile(path, "utf8"), source);
    const after = parseDocument(path, edits.snapshot(stage.editId).afterText);
    assert.equal(after.data.animations.punch.bones.arm.rotate[1].value, 50);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
