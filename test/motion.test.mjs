import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { skeletonText } from "../dist/spine/create.js";
import { parseDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { buildMotionOperations } from "../dist/spine/motion.js";
import { collectTimelines } from "../dist/spine/timelines.js";
import { validateDocument } from "../dist/spine/validate.js";

function fixture(version = "4.3") {
  const data = JSON.parse(skeletonText(version));
  for (const name of ["chest", "leftLeg", "rightLeg", "leftArm", "rightArm", "tail"]) {
    data.bones.push({ name, parent: "root" });
  }
  data.slots.push({ name: "eyes", bone: "root", attachment: "open" });
  data.skins[0].attachments.eyes = { open: {}, closed: {} };
  return parseDocument("/tmp/motion.json", `${JSON.stringify(data, null, 2)}\n`);
}
const recipes = [
  { type: "idle", bone: "root", duration: 2, swayDegrees: 4, bobDistance: 3 },
  { type: "breathing", bone: "chest", duration: 2, amount: 0.06 },
  { type: "blink", slot: "eyes", openAttachment: "open", closedAttachment: "closed", duration: 1,
    at: 0.45, hold: 0.08 },
  { type: "walk", leftLeg: "leftLeg", rightLeg: "rightLeg", leftArm: "leftArm", rightArm: "rightArm",
    rootBone: "root", duration: 1, strideDegrees: 25, bobDistance: 2 },
  { type: "run", leftLeg: "leftLeg", rightLeg: "rightLeg", duration: 0.6,
    strideDegrees: 45, bobDistance: 0 },
  { type: "recoil", bone: "chest", duration: 0.6, angleDegrees: -30 },
  { type: "follow_through", primaryBone: "chest", secondaryBone: "tail", duration: 1,
    angleDegrees: 25, lag: 0.2 },
];

for (const version of ["4.2", "4.3"]) {
  test(`Spine ${version} motion recipes stage valid looping or one-shot animation clips`, async () => {
    const document = fixture(version);
    assert.deepEqual(validateDocument(document), []);
    for (const recipe of recipes) {
      const generated = buildMotionOperations(document, recipe.type, recipe);
      assert.equal(generated.summary.recipe, recipe.type);
      assert.ok(generated.summary.keys >= 3);
      assert.equal(generated.operations[0].kind, "upsert_animation");
      const directory = await mkdtemp(join(tmpdir(), "spine2d-motion-"));
      const path = join(directory, "rig.json");
      try {
        await writeFile(path, document.text);
        const store = new EditStore();
        const staged = await store.preview(path, generated.operations);
        assert.deepEqual(staged.diagnostics, []);
        assert.equal(await readFile(path, "utf8"), document.text);
        const output = JSON.parse(store.snapshot(staged.editId).afterText);
        const clip = output.animations[recipe.type];
        assert.ok(clip);
        const tracks = collectTimelines(recipe.type, clip);
        assert.equal(tracks.length, generated.summary.timelines);
        if (recipe.type === "blink") {
          assert.deepEqual(clip.slots.eyes.attachment.map((key) => key.name),
            ["open", "closed", "open", "open"]);
        } else {
          for (const track of tracks) {
            assert.equal(track.keys[0].time ?? 0, 0);
            assert.equal(track.keys.at(-1).time, recipe.duration);
            const first = { ...track.keys[0] };
            const last = { ...track.keys.at(-1) };
            delete first.time;
            delete last.time;
            delete first.curve;
            delete last.curve;
            assert.deepEqual(last, first);
          }
        }
        assert.deepEqual(validateDocument(parseDocument(path, store.snapshot(staged.editId).afterText)), []);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
}

test("motion recipes reject unsafe or unavailable rig inputs before staging", () => {
  const document = fixture();
  assert.throws(() => buildMotionOperations(document, "bad", { type: "walk", leftLeg: "leftLeg",
    rightLeg: "leftLeg", duration: 1 }), { code: "INVALID_MOTION_BONES" });
  assert.throws(() => buildMotionOperations(document, "bad", { type: "blink", slot: "eyes",
    openAttachment: "open", closedAttachment: "missing", duration: 1 }),
  { code: "MOTION_ATTACHMENT_NOT_FOUND" });
  assert.throws(() => buildMotionOperations(document, "bad", { type: "blink", slot: "eyes",
    openAttachment: "open", closedAttachment: "closed", duration: 1, at: 0.9, hold: 0.2 }),
  { code: "INVALID_MOTION_PARAMETER" });
});
