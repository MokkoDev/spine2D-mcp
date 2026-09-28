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
import { buildMotionOperations } from "../dist/spine/motion.js";

test("licensed Spine 4.2 and 4.3 import all generated motion recipes", { timeout: 240_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for motion import tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-motion-cli-"));
  try {
    const imagesDir = join(directory, "images");
    await mkdir(imagesDir);
    const png = new PNG({ width: 10, height: 10 });
    png.data.fill(255);
    for (const name of ["open", "closed"]) await writeFile(join(imagesDir, `${name}.png`), PNG.sync.write(png));
    for (const version of ["4.2", "4.3"]) {
      const path = join(directory, `rig-${version}.json`);
      const data = JSON.parse(skeletonText(version));
      for (const name of ["chest", "leftLeg", "rightLeg", "leftArm", "rightArm", "tail"]) {
        data.bones.push({ name, parent: "root" });
      }
      data.slots.push({ name: "eyes", bone: "root", attachment: "open" });
      data.skins[0].attachments.eyes = {
        open: { type: "region", width: 10, height: 10 },
        closed: { type: "region", width: 10, height: 10 },
      };
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
      const document = await readDocument(path);
      const recipes = [
        { type: "idle", bone: "root", duration: 2 },
        { type: "breathing", bone: "chest", duration: 2 },
        { type: "blink", slot: "eyes", openAttachment: "open", closedAttachment: "closed", duration: 1 },
        { type: "walk", leftLeg: "leftLeg", rightLeg: "rightLeg", leftArm: "leftArm", rightArm: "rightArm", rootBone: "root", duration: 1 },
        { type: "run", leftLeg: "leftLeg", rightLeg: "rightLeg", duration: 0.6 },
        { type: "recoil", bone: "chest", duration: 0.6 },
        { type: "follow_through", primaryBone: "chest", secondaryBone: "tail", duration: 1 },
      ];
      const operations = recipes.flatMap((recipe) => buildMotionOperations(document, recipe.type, recipe).operations);
      const edits = new EditStore();
      const stage = await edits.preview(path, operations);
      await edits.commit(stage.editId);
      assert.deepEqual(Object.keys((await readDocument(path)).data.animations), recipes.map((recipe) => recipe.type));
      const projectPath = join(directory, `rig-${version}.spine`);
      try { await importData(path, projectPath, `rig-${version}`, version, 120_000); }
      catch (error) {
        console.error(`Spine ${version} motion import failed:`, error.details?.stdout?.slice(-2500), error.details?.stderr?.slice(-2500));
        throw error;
      }
      assert.ok((await readFile(projectPath)).length > 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
