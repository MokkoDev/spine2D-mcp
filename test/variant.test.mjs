import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseDocument, readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { validateDocument } from "../dist/spine/validate.js";
import { cloneAnimationText } from "../dist/spine/variant.js";

const fixture = {
  skeleton: { spine: "4.3.26" },
  bones: [{ name: "root" }, { name: "arm", parent: "root" }],
  slots: [{ name: "hand", bone: "arm", attachment: "hand" }],
  skins: [{ name: "default", attachments: { hand: { hand: { width: 16, height: 16 } } } }],
  events: { beat: {} },
  animations: {
    wave: {
      bones: { arm: { rotate: [
        { value: -20, curve: [0.25, -20, 0.75, 20], custom: "keep" },
        { time: 1, value: 20 },
      ] } },
      slots: { hand: { attachment: [{ name: "hand" }, { time: 0.5, name: "hand" }] } },
      events: [{ time: 0.25, name: "beat" }],
      drawOrder: [{ time: 0.75, offsets: [{ slot: "hand", offset: 0 }] }],
    },
  },
};

test("cloned animation scales and shifts keys and Bézier time controls without changing its source", () => {
  const source = parseDocument("/tmp/variant.json", `${JSON.stringify(fixture, null, 2)}\n`);
  const transformed = cloneAnimationText(source, { kind: "clone_animation",
    sourceAnimation: "wave", newAnimation: "wave-slow", timeScale: 2, startAt: 0.25 });
  const document = parseDocument(source.path, transformed.text);
  assert.deepEqual(validateDocument(document), []);
  const oldClip = document.data.animations.wave;
  const newClip = document.data.animations["wave-slow"];
  assert.deepEqual(oldClip, fixture.animations.wave);
  assert.deepEqual(newClip.bones.arm.rotate.map((key) => key.time), [0.25, 2.25]);
  assert.deepEqual(newClip.bones.arm.rotate[0].curve, [0.75, -20, 1.75, 20]);
  assert.equal(newClip.bones.arm.rotate[0].custom, "keep");
  assert.deepEqual(newClip.slots.hand.attachment.map((key) => key.time), [0.25, 1.25]);
  assert.equal(newClip.events[0].time, 0.75);
  assert.equal(newClip.drawOrder[0].time, 1.75);
  assert.equal(transformed.summary.timelines, 4);
  assert.equal(transformed.summary.keys, 6);
  assert.equal(transformed.summary.curveControls, 2);
});

test("clone operation stages a new variant and rejects duplicate names atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-variant-"));
  const path = join(directory, "character.json");
  const original = `${JSON.stringify(fixture, null, 2)}\n`;
  await writeFile(path, original);
  try {
    const edits = new EditStore();
    await assert.rejects(edits.preview(path, [{ kind: "clone_animation",
      sourceAnimation: "wave", newAnimation: "wave" }]), { code: "ANIMATION_EXISTS" });
    await assert.rejects(edits.preview(path, [{ kind: "clone_animation",
      sourceAnimation: "missing", newAnimation: "new" }]), { code: "ANIMATION_NOT_FOUND" });
    const stage = await edits.preview(path, [{ kind: "clone_animation",
      sourceAnimation: "wave", newAnimation: "wave-fast", timeScale: 0.5 }]);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(stage.summaries[0].afterDuration, 0.5);
    await edits.commit(stage.editId);
    assert.equal((await readDocument(path)).data.animations["wave-fast"].bones.arm.rotate[1].time, 0.5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
