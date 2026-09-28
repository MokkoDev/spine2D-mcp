import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";

import { analyzeContacts, analyzeFootContacts } from "../dist/spine/contact.js";

async function frame(path, left, width = 32, top = 7) {
  const png = new PNG({ width, height: 16 });
  for (let y = top; y < top + 3; y += 1) {
    for (let x = left; x < left + 3; x += 1) {
      png.data.set([255, 0, 0, 255], (y * width + x) * 4);
    }
  }
  await writeFile(path, PNG.sync.write(png));
}

test("contact analysis reports visible foot drift and missing contact pixels as review hints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-contact-"));
  try {
    const paths = [3, 7, 11, 15].map((_, index) => join(directory, `frame-${index}.png`));
    await Promise.all([3, 7, 11, 15].map((left, index) => frame(paths[index], left)));
    const contact = { name: "leftFoot", fromFrame: 0, toFrame: 3,
      x: 0, y: 0.25, width: 0.75, height: 0.5, driftThresholdPixels: 4 };
    const moving = await analyzeFootContacts(paths, [contact]);
    assert.equal(moving.contacts[0].sampledFrames, 4);
    assert.equal(moving.contacts[0].maxDriftPixels, 12);
    assert.ok(moving.hints.some((hint) => hint.code === "POSSIBLE_FOOT_SLIDE"));
    const empty = await analyzeFootContacts(paths, [{ ...contact, x: 0.8, width: 0.2 }]);
    assert.equal(empty.contacts[0].sampledFrames, 0);
    assert.ok(empty.hints.some((hint) => hint.code === "CONTACT_REGION_EMPTY"));
    await Promise.all(paths.map((path) => frame(path, 3)));
    const stable = await analyzeFootContacts(paths, [contact]);
    assert.equal(stable.contacts[0].maxDriftPixels, 0);
    assert.deepEqual(stable.hints, []);
    await assert.rejects(analyzeFootContacts(paths, [{ ...contact, x: 0.9, width: 0.2 }]),
      { code: "INVALID_CONTACT_REGION" });
    await frame(paths[3], 3, 40);
    await assert.rejects(analyzeFootContacts(paths, [contact]), { code: "VARIABLE_CANVAS" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("named contacts measure region penetration and tracked point drift without body-part assumptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-contact-"));
  try {
    const paths = [0, 1, 2].map((index) => join(directory, `frame-${index}.png`));
    await Promise.all([7, 9, 11].map((top, index) => frame(paths[index], 3, 32, top)));
    const results = await analyzeContacts(paths, [
      { name: "body-shell", fromFrame: 0, toFrame: 2,
        target: { kind: "region", x: 0, y: 0.25, width: 0.5, height: 0.75 },
        driftThresholdPixels: 1, groundY: 10 / 16, penetrationThresholdPixels: 1,
        minimumPenetratingPixels: 2 },
      { name: "wheel-contact", fromFrame: 0, toFrame: 2,
        target: { kind: "point", positions: [
          { frame: 0, x: 5 / 32, y: 8 / 16 },
          { frame: 1, x: 9 / 32, y: 10 / 16 },
          { frame: 2, x: 13 / 32, y: 11 / 16 },
        ] },
        driftThresholdPixels: 3, groundY: 10 / 16, penetrationThresholdPixels: 0.5 },
    ]);
    assert.equal(results.contacts[0].maxDriftPixels, 0);
    assert.equal(results.contacts[0].maxPenetrationPixels, 3.5);
    assert.equal(results.contacts[0].worstPenetrationFrame, 2);
    assert.equal(results.contacts[0].penetrationFrameCount, 2);
    assert.equal(results.contacts[1].maxDriftPixels, 8);
    assert.equal(results.contacts[1].maxPenetrationPixels, 1);
    assert.ok(results.hints.some((hint) => hint.code === "GROUND_PENETRATION" && hint.path === "/contacts/body-shell"));
    assert.ok(results.hints.some((hint) => hint.code === "CONTACT_DRIFT" && hint.path === "/contacts/wheel-contact"));
    assert.ok(!results.hints.some((hint) => hint.code === "CONTACT_DRIFT" && hint.path === "/contacts/body-shell"));
    await assert.rejects(analyzeContacts(paths, [{ name: "invalid", fromFrame: 0, toFrame: 2,
      target: { kind: "region", x: 0, y: 0, width: 1, height: 1 } }]), { code: "INVALID_CONTACT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
