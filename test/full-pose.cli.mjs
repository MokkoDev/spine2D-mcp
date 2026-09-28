import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";

import { importData } from "../dist/spine/cli.js";
import { skeletonText } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { applyPoseOperations, capturePose } from "../dist/spine/full-pose.js";

test("licensed Spine 4.2 and 4.3 import mirrored bone and slot poses", { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for full pose import tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-full-pose-cli-"));
  try {
    await mkdir(join(directory, "images"));
    const png = new PNG({ width: 10, height: 10 });
    png.data.fill(255);
    for (const name of ["open", "closed"]) await writeFile(join(directory, "images", `${name}.png`), PNG.sync.write(png));
    for (const version of ["4.2", "4.3"]) {
      const path = join(directory, `rig-${version}.json`);
      const data = JSON.parse(skeletonText(version));
      data.bones.push({ name: "left", parent: "root" }, { name: "right", parent: "root" });
      data.slots.push({ name: "eyes", bone: "root", attachment: "open" });
      data.skins[0].attachments.eyes = {
        open: { type: "region", width: 10, height: 10 },
        closed: { type: "region", width: 10, height: 10 },
      };
      data.animations.wave = {
        bones: {
          left: { rotate: [{ time: 0, value: 5 }, { time: 1, value: 20 }] },
          right: { rotate: [{ time: 0, value: -5 }, { time: 1, value: -20 }] },
        },
        slots: { eyes: { attachment: [{ time: 0, name: "open" }, { time: 0.5, name: "closed" }] } },
      };
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
      const source = await readDocument(path);
      const pose = capturePose(source, "wave", 0.75, "mirror");
      const prepared = applyPoseOperations(source, pose, "posed", 0.25, { mirrorPairs: [["left", "right"]] });
      const edits = new EditStore();
      const stage = await edits.preview(path, prepared.operations);
      await edits.commit(stage.editId);
      const projectPath = join(directory, `rig-${version}.spine`);
      try { await importData(path, projectPath, `rig-${version}`, version, 120_000); }
      catch (error) {
        console.error(`Spine ${version} pose import failed:`, error.details?.stdout?.slice(-2500), error.details?.stderr?.slice(-2500));
        throw error;
      }
      assert.ok((await readFile(projectPath)).length > 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
