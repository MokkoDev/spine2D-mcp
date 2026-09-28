import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";

import { exportMedia } from "../dist/spine/cli.js";
import { skeletonText } from "../dist/spine/create.js";

test("licensed Spine editor exports saved-settings PNG media from 4.2 and 4.3 data", { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for editor media tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-media-cli-"));
  try {
    await mkdir(join(directory, "images"));
    const png = new PNG({ width: 10, height: 10 });
    png.data.fill(255);
    await writeFile(join(directory, "images", "shape.png"), PNG.sync.write(png));
    for (const version of ["4.2", "4.3"]) {
      const inputPath = join(directory, `rig-${version}.json`);
      const settingsPath = join(directory, `media-${version}.json`);
      const data = JSON.parse(skeletonText(version));
      data.slots.push({ name: "art", bone: "root", attachment: "shape" });
      data.skins[0].attachments.art = { shape: { type: "region", width: 10, height: 10 } };
      data.animations.wave = { bones: { root: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 20 }] } } };
      await writeFile(inputPath, `${JSON.stringify(data, null, 2)}\n`);
      await writeFile(settingsPath, JSON.stringify({
        class: "export-png", exportType: "animation", skeletonType: "single", skeleton: `rig-${version}`,
        animationType: "single", animation: "wave", skinType: "current", skinNone: false,
        renderImages: true, renderBones: false, scale: 100, fps: 10, lastFrame: false,
        rangeStart: 0, rangeEnd: 1, packAtlas: null, output: "", id: -1, input: "", open: false,
      }));
      await assert.rejects(exportMedia(inputPath, settingsPath, directory, version, "../bad.png"),
        { code: "INVALID_MEDIA_NAME" });
      const result = await exportMedia(inputPath, settingsPath, directory, version, undefined, 120_000);
      assert.equal(result.mediaClass, "export-png");
      assert.ok(result.files.some((file) => file.endsWith(".png")));
      const first = result.files.find((file) => file.endsWith(".png"));
      assert.deepEqual((await readFile(first)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
