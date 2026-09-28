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
import { applyMeshPoseOperations, captureMeshPose } from "../dist/spine/mesh-pose.js";

test("licensed Spine 4.2 and 4.3 import sampled mesh poses", { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for mesh pose import tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mesh-pose-cli-"));
  try {
    await mkdir(join(directory, "images"));
    const png = new PNG({ width: 16, height: 16 });
    png.data.fill(255);
    await writeFile(join(directory, "images", "sheet.png"), PNG.sync.write(png));
    for (const version of ["4.2", "4.3"]) {
      const path = join(directory, `mesh-${version}.json`);
      const data = JSON.parse(skeletonText(version));
      data.slots.push({ name: "body", bone: "root", attachment: "sheet" });
      data.skins[0].attachments.body = { sheet: { type: "mesh", uvs: [0, 0, 1, 0, 1, 1],
        triangles: [0, 1, 2], vertices: [0, 0, 16, 0, 16, 16], hull: 3,
        width: 16, height: 16 } };
      const keys = [{ time: 0, vertices: [0, 0, 0, 0, 0, 0] },
        { time: 1, offset: 2, vertices: [2, 4] }];
      data.animations.warp = version === "4.2"
        ? { deform: { default: { body: { sheet: keys } } } }
        : { attachments: { default: { body: { sheet: { deform: keys } } } } };
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
      const source = await readDocument(path);
      const pose = captureMeshPose(source, "warp", 0.5, "middle");
      const edits = new EditStore();
      const prepared = applyMeshPoseOperations(source, pose, "reused", 0.2);
      const stage = await edits.preview(path, prepared.operations);
      await edits.commit(stage.editId);
      const projectPath = join(directory, `mesh-${version}.spine`);
      try { await importData(path, projectPath, `mesh-${version}`, version, 120_000); }
      catch (error) {
        console.error(`Spine ${version} mesh pose import failed:`, error.details?.stdout?.slice(-2000), error.details?.stderr?.slice(-2000));
        throw error;
      }
      assert.ok((await readFile(projectPath)).length > 0);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
