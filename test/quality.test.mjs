import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";

import { analyzePreview } from "../dist/spine/quality.js";

async function frame(path, width, height, rectangle) {
  const png = new PNG({ width, height });
  if (rectangle) {
    for (let y = rectangle.y; y < rectangle.y + rectangle.height; y += 1) {
      for (let x = rectangle.x; x < rectangle.x + rectangle.width; x += 1) {
        const offset = (y * width + x) * 4;
        png.data.set([255, 80, 20, 255], offset);
      }
    }
  }
  await writeFile(path, PNG.sync.write(png));
}

test("preview analysis finds blank frames, area jumps, and fixed-canvas edge contact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-quality-"));
  const paths = Array.from({ length: 4 }, (_unused, index) => join(directory, `frame-${index}.png`));
  try {
    await frame(paths[0], 20, 20, { x: 8, y: 8, width: 2, height: 2 });
    await frame(paths[1], 20, 20, { x: 17, y: 8, width: 2, height: 2 });
    await frame(paths[2], 20, 20, { x: 8, y: 8, width: 12, height: 12 });
    await frame(paths[3], 20, 20, null);
    const result = await analyzePreview(paths, { fixedCanvas: true, areaJumpRatio: 3 });
    assert.equal(result.frameCount, 4);
    assert.equal(result.sampledCount, 4);
    assert.equal(result.frames[0].visiblePixels, 4);
    assert.deepEqual(result.frames[3].bounds, null);
    const codes = new Set(result.hints.map((hint) => hint.code));
    for (const code of ["BLANK_FRAME", "VISIBLE_AREA_JUMP", "FRAME_EDGE_CONTACT", "FRAME_POSITION_JUMP"]) {
      assert.ok(codes.has(code), `Expected ${code}.`);
    }
    const sampled = await analyzePreview(paths, { maxFrames: 2 });
    assert.deepEqual(sampled.frames.map((item) => item.index), [0, 3]);
    assert.equal(sampled.samplesTruncated, true);
    assert.ok(!sampled.hints.some((hint) => hint.code === "FRAME_EDGE_CONTACT"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixed-canvas checks reject preview sequences with changing dimensions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-quality-variable-"));
  const first = join(directory, "first.png");
  const second = join(directory, "second.png");
  try {
    await frame(first, 8, 8, { x: 2, y: 2, width: 2, height: 2 });
    await frame(second, 10, 8, { x: 2, y: 2, width: 2, height: 2 });
    await assert.rejects(analyzePreview([first, second], { fixedCanvas: true }), { code: "VARIABLE_CANVAS" });
    const result = await analyzePreview([first, second]);
    assert.equal(result.sampledCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
