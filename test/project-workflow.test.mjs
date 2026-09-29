import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { skeletonText } from "../dist/spine/create.js";
import { EditStore } from "../dist/spine/edit.js";
import { finalizeAnimation } from "../dist/spine/finalize.js";
import { roundTripEdit } from "../dist/spine/roundtrip.js";

test("project edit output must be a new sibling of the verified source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine-project-workflow-"));
  const projectPath = join(directory, "source.spine");
  try {
    await writeFile(projectPath, "source");
    const input = { projectPath, dataSettingsPath: "unused", previewSettingsPath: "unused",
      outputDir: join(directory, "runs"), editorVersion: "4.3", animation: "idle",
      operations: [{ kind: "upsert_bone", name: "root", values: { length: 10 } }] };
    for (const outputProjectPath of [projectPath, join(directory, "other", "new.spine"),
      join(directory, "new.json")]) {
      await assert.rejects(roundTripEdit({ ...input, outputProjectPath }, new EditStore()),
        { code: "INVALID_OUTPUT_PATH" });
    }
    const occupied = join(directory, "occupied.spine");
    await writeFile(occupied, "existing");
    await assert.rejects(roundTripEdit({ ...input, outputProjectPath: occupied }, new EditStore()),
      { code: "OUTPUT_EXISTS" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSON finalization needs an explicit replacement choice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine-finalize-choice-"));
  const dataPath = join(directory, "source.json");
  const existingProjectPath = join(directory, "source.spine");
  try {
    const data = JSON.parse(skeletonText("4.3"));
    data.animations.idle = {};
    await writeFile(dataPath, JSON.stringify(data));
    await writeFile(existingProjectPath, "source");
    const input = { dataPath, dataSettingsPath: "unused", previewSettingsPath: "unused",
      outputDir: join(directory, "runs"), editorVersion: "4.3", animation: "idle" };
    await assert.rejects(finalizeAnimation({ ...input, existingProjectPath }),
      { code: "REPLACEMENT_NOT_SELECTED" });
    await assert.rejects(finalizeAnimation({ ...input, replaceExistingProject: true,
      existingProjectPath: join(directory, "missing.spine") }), { code: "PROJECT_NOT_FOUND" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
