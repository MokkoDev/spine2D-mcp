import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";

import { skeletonText } from "../dist/spine/create.js";
import { createPlayerPreview } from "../dist/spine/player.js";

for (const version of ["4.2", "4.3"]) {
  test(`Spine ${version} player bundles valid skeleton, atlas, and texture data into HTML`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "spine2d-player-"));
    try {
      const skeletonPath = join(directory, "rig.json");
      const atlasPath = join(directory, "rig.atlas");
      const png = new PNG({ width: 1, height: 1 });
      png.data.set([255, 255, 255, 255]);
      const texture = PNG.sync.write(png);
      const data = JSON.parse(skeletonText(version));
      data.animations.wave = { bones: { root: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 20 }] } } };
      await writeFile(skeletonPath, JSON.stringify(data));
      await writeFile(atlasPath, "rig.png\nsize: 1, 1\nfilter: Linear, Linear\nrepeat: none\n");
      await writeFile(join(directory, "rig.png"), texture);
      const result = await createPlayerPreview({ skeletonPath, atlasPath,
        outputDir: join(directory, "out"), animation: "wave", skin: "default", debugBones: true });
      assert.equal(result.playerVersion, version);
      assert.deepEqual(result.atlasPages, ["rig.png"]);
      const html = await readFile(result.htmlPath, "utf8");
      assert.match(html, new RegExp(`spine-player@${version.replace(".", "\\.")}\\.\\*`));
      const match = html.match(/new spine\.SpinePlayer\("spine-player", (.*)\);<\/script>/);
      assert.ok(match);
      const config = JSON.parse(match[1]);
      assert.equal(config.animation, "wave");
      assert.equal(config.skin, "default");
      assert.equal(config.debug.bones, true);
      assert.deepEqual(Buffer.from(config.rawDataURIs["rig.png"].split(",")[1], "base64"), texture);
      assert.deepEqual(JSON.parse(Buffer.from(config.rawDataURIs["rig.json"].split(",")[1], "base64")), data);
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
      assert.equal(manifest.skeletonHash, result.skeletonHash);
      assert.match(manifest.pageHashes[0].sha256, /^[0-9a-f]{64}$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("player rejects missing inputs and keeps failed local-runtime bundles out of outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-player-errors-"));
  try {
    const skeletonPath = join(directory, "rig.json");
    const atlasPath = join(directory, "rig.atlas");
    const outputDir = join(directory, "out");
    const data = JSON.parse(skeletonText("4.3"));
    data.animations.wave = {};
    await writeFile(skeletonPath, JSON.stringify(data));
    await writeFile(atlasPath, "rig.png\nsize: 1, 1\n");
    await assert.rejects(createPlayerPreview({ skeletonPath, atlasPath, outputDir }),
      { code: "ATLAS_PAGE_NOT_FOUND" });
    await writeFile(atlasPath, "../outside.png\nsize: 1, 1\n");
    await assert.rejects(createPlayerPreview({ skeletonPath, atlasPath, outputDir }),
      { code: "INVALID_ATLAS_PAGE" });
    await writeFile(atlasPath, "rig.png\nsize: 1, 1\n");
    await writeFile(join(directory, "rig.png"), "png");
    await assert.rejects(createPlayerPreview({ skeletonPath, atlasPath, outputDir, animation: "missing" }),
      { code: "ANIMATION_NOT_FOUND" });
    const jsPath = join(directory, "spine-player.js");
    await writeFile(jsPath, "window.spine = {};");
    await mkdir(outputDir);
    await assert.rejects(createPlayerPreview({ skeletonPath, atlasPath, outputDir,
      runtimeJsPath: jsPath, runtimeCssPath: join(directory, "missing.css") }),
    { code: "PLAYER_RUNTIME_NOT_FOUND" });
    assert.deepEqual(await readdir(outputDir), []);
    const cssPath = join(directory, "spine-player.css");
    await writeFile(cssPath, "body{}\n");
    const local = await createPlayerPreview({ skeletonPath, atlasPath, outputDir,
      runtimeJsPath: jsPath, runtimeCssPath: cssPath });
    assert.equal(local.runtimeSource, "local");
    assert.equal(await readFile(join(local.playerDir, "spine-player.js"), "utf8"), "window.spine = {};");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
