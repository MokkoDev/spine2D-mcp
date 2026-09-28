import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";

import { importData } from "../dist/spine/cli.js";
import { skeletonText } from "../dist/spine/create.js";
import { runExportProfile, saveExportProfile } from "../dist/spine/profile.js";

test("licensed Spine 4.2 and 4.3 run data and media export profiles", { timeout: 240_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for profile export tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-profile-cli-"));
  try {
    await mkdir(join(directory, "images"));
    const png = new PNG({ width: 10, height: 10 });
    png.data.fill(255);
    await writeFile(join(directory, "images", "shape.png"), PNG.sync.write(png));
    for (const version of ["4.2", "4.3"]) {
      const skeletonName = `rig-${version}`;
      const inputPath = join(directory, `${skeletonName}.json`);
      const projectPath = join(directory, `${skeletonName}.spine`);
      const dataPath = join(directory, `${skeletonName}-data.export.json`);
      const mediaPath = join(directory, `${skeletonName}-media.export.json`);
      const data = JSON.parse(skeletonText(version));
      data.slots.push({ name: "art", bone: "root", attachment: "shape" });
      data.skins[0].attachments.art = { shape: { type: "region", width: 10, height: 10 } };
      data.animations.wave = { bones: { root: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 20 }] } } };
      await writeFile(inputPath, `${JSON.stringify(data, null, 2)}\n`);
      await importData(inputPath, projectPath, skeletonName, version, 120_000);
      await writeFile(dataPath, JSON.stringify({ class: "export-json", extension: ".json", format: "JSON",
        prettyPrint: true, nonessential: true, cleanUp: false, packAtlas: null,
        packSource: "attachments", packTarget: "single", warnings: true, version: null, all: true,
        output: "", id: -1, input: "", open: false }));
      await writeFile(mediaPath, JSON.stringify({ class: "export-png", exportType: "animation",
        skeletonType: "single", skeleton: skeletonName, animationType: "single", animation: "wave",
        skinType: "current", skinNone: false, renderImages: true, renderBones: false,
        scale: 100, fps: 10, lastFrame: false, rangeStart: 0, rangeEnd: 1,
        packAtlas: null, output: "", id: -1, input: "", open: false }));
      await saveExportProfile(directory, `release${version.replace(".", "")}`, version, version,
        { data: dataPath, media: mediaPath });
      const result = await runExportProfile(directory, `release${version.replace(".", "")}`,
        projectPath, join(directory, "outputs"));
      assert.ok(result.results.data && result.results.media);
      assert.ok(result.outputs.some((entry) => entry.path.endsWith(".json")));
      const pngOutput = result.outputs.find((entry) => entry.path.endsWith(".png"));
      assert.ok(pngOutput);
      assert.deepEqual((await readFile(pngOutput.path)).subarray(0, 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(JSON.parse(await readFile(result.manifestPath, "utf8")).runtimeVersion, version);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
