import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { importData } from "../dist/spine/cli.js";
import { skeletonText } from "../dist/spine/create.js";
import { EditStore } from "../dist/spine/edit.js";

test("licensed Spine editor imports simplified and smoothed bone curves in 4.2 and 4.3", { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for curve import tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-curve-cli-"));
  try {
    for (const version of ["4.2", "4.3"]) {
      const path = join(directory, `curve-${version}.json`);
      const data = JSON.parse(skeletonText(version));
      data.bones.push({ name: "arm", parent: "root" });
      data.animations.move = { bones: { arm: {
        rotate: [
          { time: 0, value: 0 }, { time: 0.5, value: 10 },
          { time: 1, value: 20 }, { time: 1.5, value: 22 },
        ],
        translate: [
          { time: 0, x: 0, y: 0 }, { time: 1, x: 10, y: 5 },
          { time: 2, x: 20, y: 10 },
        ],
      } } };
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
      const edits = new EditStore();
      const stage = await edits.preview(path, [
        { kind: "cleanup_curves", animation: "move", mode: "simplify", timelineTypes: ["rotate", "translate"],
          protectedTimes: [1.5] },
        { kind: "cleanup_curves", animation: "move", mode: "smooth", timelineTypes: ["rotate", "translate"] },
      ]);
      assert.equal(stage.summaries[0].keysRemoved, 2);
      await edits.commit(stage.editId);
      const project = join(directory, `curve-${version}.spine`);
      try {
        await importData(path, project, `curve-${version}`, version, 120_000);
      } catch (error) {
        console.error(`Spine ${version} curve import failed:`, error.details?.stdout?.slice(-2500), error.details?.stderr?.slice(-2500));
        throw error;
      }
      assert.ok((await readFile(project)).length > 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
