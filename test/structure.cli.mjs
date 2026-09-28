import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { importData } from "../dist/spine/cli.js";
import { skeletonText } from "../dist/spine/create.js";
import { EditStore } from "../dist/spine/edit.js";

test("licensed Spine editor imports reordered global draw-order keys in 4.2 and 4.3", { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for editor import tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-structure-cli-"));
  try {
    for (const version of ["4.2", "4.3"]) {
      const path = join(directory, `order-${version}.json`);
      const data = JSON.parse(skeletonText(version));
      data.bones.push({ name: "spare", parent: "root" });
      data.slots = ["a", "b", "c"].map((name) => ({ name, bone: "root" }));
      data.animations.wave = { drawOrder: [{ time: 0, offsets: [{ slot: "a", offset: 2 }] }, { time: 1 }] };
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
      const edits = new EditStore();
      const stage = await edits.preview(path, [
        { kind: "remove_bone", name: "spare" },
        { kind: "reorder_slots", names: ["c", "a", "b"], animationPolicy: "preserve" },
        { kind: "rename_element", elementType: "slot", name: "a", newName: "front" },
        { kind: "rename_element", elementType: "animation", name: "wave", newName: "motion" },
      ]);
      await edits.commit(stage.editId);
      const project = join(directory, `order-${version}.spine`);
      try {
        await importData(path, project, `order-${version}`, version, 120_000);
      } catch (error) {
        console.error(`Spine ${version} structure import failed:`, error.details?.stdout?.slice(-2500), error.details?.stderr?.slice(-2500));
        throw error;
      }
      assert.ok((await readFile(project)).length > 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
