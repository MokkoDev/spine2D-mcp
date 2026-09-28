import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { importData } from "../dist/spine/cli.js";
import { skeletonText } from "../dist/spine/create.js";
import { EditStore } from "../dist/spine/edit.js";

test("licensed Spine editor imports combined, mirrored, and segmented clips in 4.2 and 4.3", { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for transform import tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-transform-cli-"));
  try {
    for (const version of ["4.2", "4.3"]) {
      const path = join(directory, `rig-${version}.json`);
      const data = JSON.parse(skeletonText(version));
      data.bones.push({ name: "left", parent: "root" }, { name: "right", parent: "root" });
      data.events = { step: {} };
      data.animations.wave = { bones: { left: { rotate: [
        { time: 0, value: 0, curve: [0.25, 5, 0.75, 15] }, { time: 1, value: 20 },
      ] } }, events: [{ time: 0.5, name: "step" }] };
      data.animations.sway = { bones: { right: { translate: [
        { time: 0, x: 0, y: 0 }, { time: 1, x: 10, y: 0 },
      ] } } };
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
      const edits = new EditStore();
      const stage = await edits.preview(path, [
        { kind: "transform_animation", mode: "combine", firstAnimation: "wave", secondAnimation: "sway",
          secondStart: 0.5, newAnimation: "combined" },
        { kind: "transform_animation", mode: "mirror", sourceAnimation: "combined",
          bonePairs: [["left", "right"]], newAnimation: "mirrored" },
        { kind: "transform_animation", mode: "segment", sourceAnimation: "combined",
          from: 0.2, to: 0.8, newAnimation: "middle" },
      ]);
      await edits.commit(stage.editId);
      const project = join(directory, `rig-${version}.spine`);
      try {
        await importData(path, project, `rig-${version}`, version, 120_000);
      } catch (error) {
        console.error(`Spine ${version} transform import failed:`, error.details?.stdout?.slice(-2500), error.details?.stderr?.slice(-2500));
        throw error;
      }
      assert.ok((await readFile(project)).length > 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
