import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";

import { analyzeFootContacts } from "../dist/spine/contact.js";

async function frame(path, left, width = 32) {
  const png = new PNG({ width, height: 16 });
  for (let y = 7; y < 10; y += 1) {
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
