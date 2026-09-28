import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cleanupAnimations, importData } from "../dist/spine/cli.js";
import { skeletonText } from "../dist/spine/create.js";

test("licensed Spine editor cleans a copy of 4.2 and 4.3 projects", { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for editor cleanup tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-cleanup-cli-"));
  try {
    for (const version of ["4.2", "4.3"]) {
      const dataPath = join(directory, `rig-${version}.json`);
      const projectPath = join(directory, `rig-${version}.spine`);
      const outputProjectPath = join(directory, `rig-${version}-clean.spine`);
      const data = JSON.parse(skeletonText(version));
      data.bones.push({ name: "arm", parent: "root" });
      data.animations.wave = { bones: { arm: { rotate: [
        { time: 0, value: 0 }, { time: 0.5, value: 0 }, { time: 1, value: 15 },
      ] } } };
      await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);
      await importData(dataPath, projectPath, `rig-${version}`, version, 120_000);
      const before = await readFile(projectPath);
      await assert.rejects(cleanupAnimations(projectPath, projectPath, version), { code: "INVALID_OUTPUT_PATH" });
      const result = await cleanupAnimations(projectPath, outputProjectPath, version, 120_000);
      assert.equal(result.cli.exitCode, 0);
      assert.ok(result.sourceHash.length === 64 && result.outputHash.length === 64);
      assert.deepEqual(await readFile(projectPath), before);
      assert.ok((await readFile(outputProjectPath)).length > 0);
      await assert.rejects(cleanupAnimations(projectPath, outputProjectPath, version), { code: "OUTPUT_EXISTS" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
