import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { exportData, importData } from "../dist/spine/cli.js";
import { skeletonText } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { validateDocument } from "../dist/spine/validate.js";

test("licensed Spine editor imports authored constraints and definition removals in 4.2 and 4.3", { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH to run editor constraint integration tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-constraint-cli-"));
  try {
    for (const version of ["4.2", "4.3"]) {
      const path = join(directory, `rig-${version}.json`);
      const data = JSON.parse(skeletonText(version));
      data.bones.push({ name: "arm", parent: "root", length: 40 }, { name: "goal", parent: "root", x: 30 });
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
      const edits = new EditStore();
      const stage = await edits.preview(path, [
        { kind: "upsert_constraint", constraintType: "ik", name: "aim", edition: "professional",
          bones: ["arm"], target: "goal", values: { mix: 0.75 } },
        { kind: "upsert_constraint", constraintType: "transform", name: "follow", edition: "professional",
          bones: ["arm"], target: "goal", values: version === "4.3"
            ? { properties: ["rotate", "x"], mixRotate: 0.5 } : { mixRotate: 0.5 } },
        { kind: "upsert_constraint", constraintType: "physics", name: "sway", edition: "professional",
          bone: "arm", values: { rotate: 1, limit: 300, fps: 30 } },
        { kind: "upsert_event", name: "beat", values: { int: 1 } },
        { kind: "upsert_animation", name: "wave" },
        { kind: "set_keyframe", animation: "wave", selector: { section: "events" },
          time: 0.25, values: { name: "beat" } },
      ]);
      assert.deepEqual(stage.diagnostics, []);
      await edits.commit(stage.editId);
      const authored = await readDocument(path);
      assert.deepEqual(validateDocument(authored), []);
      const project = join(directory, `rig-${version}.spine`);
      try {
        await importData(path, project, `rig-${version}`, version, 120_000);
      } catch (error) {
        console.error(`Spine ${version} constraint import failed:`, error.details?.stdout?.slice(-2500), error.details?.stderr?.slice(-2500));
        throw error;
      }
      assert.ok((await readFile(project)).length > 0);
      const settings = join(directory, `export-${version}.json`);
      await writeFile(settings, JSON.stringify({ class: "export-json", extension: ".json", format: "JSON",
        prettyPrint: true, nonessential: true, cleanUp: false, packAtlas: null,
        packSource: "attachments", packTarget: "single", warnings: true, version: null,
        all: true, output: "", id: -1, input: "", open: false }));
      const exported = await exportData(project, settings, directory, version, 120_000);
      assert.equal(exported.files.length, 1);
      const roundTrip = await readDocument(exported.files[0]);
      assert.deepEqual(validateDocument(roundTrip), []);
      const constraints = version === "4.3" ? roundTrip.data.constraints
        : [...(roundTrip.data.ik ?? []), ...(roundTrip.data.transform ?? []), ...(roundTrip.data.physics ?? [])];
      assert.ok(constraints.some((item) => item.name === "aim"));
      assert.ok(constraints.some((item) => item.name === "follow"));
      assert.ok(constraints.some((item) => item.name === "sway"));
      assert.equal(roundTrip.data.animations.wave.events[0].name, "beat");
      const removed = await edits.preview(path, [
        { kind: "remove_animation", name: "wave" },
        { kind: "remove_event", name: "beat" },
        { kind: "remove_constraint", constraintType: "ik", name: "aim" },
      ]);
      await edits.commit(removed.editId);
      const remaining = await readDocument(path);
      assert.deepEqual(validateDocument(remaining), []);
      const remainingConstraints = version === "4.3" ? remaining.data.constraints
        : [...(remaining.data.ik ?? []), ...(remaining.data.transform ?? []), ...(remaining.data.physics ?? [])];
      assert.ok(!remainingConstraints.some((item) => item.name === "aim"));
      assert.equal(remaining.data.animations.wave, undefined);
      assert.equal(remaining.data.events.beat, undefined);
      const projectAfterRemoval = join(directory, `rig-removed-${version}.spine`);
      await importData(path, projectAfterRemoval, `rig-removed-${version}`, version, 120_000);
      assert.ok((await readFile(projectAfterRemoval)).length > 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("licensed Spine editor imports a new path constraint on official 4.2 and 4.3 rigs", { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH to run editor constraint integration tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-path-constraint-cli-"));
  const fixtures = [
    { version: "4.2", commit: "e7dc1435fa4a0083ab431f1b28e083c14a1f5c68",
      hash: "4186a992f79d73e79d677f25bfeb9db9bd26b97c288088f4530d7bedca497a6c" },
    { version: "4.3", commit: "7ce5d0daac13268fa3ed68eb174c2822ef2692c9",
      hash: "cfb7b608a784eb9e5d0167691236b5a536e03872ed8b01293400d554f0847fc7" },
  ];
  try {
    for (const fixture of fixtures) {
      const url = `https://raw.githubusercontent.com/EsotericSoftware/spine-runtimes/${fixture.commit}/examples/vine/export/vine-pro.json`;
      const response = await fetch(url);
      assert.equal(response.ok, true);
      const original = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash("sha256").update(original).digest("hex"), fixture.hash);
      const path = join(directory, `vine-${fixture.version}.json`);
      await writeFile(path, original);
      const current = await readDocument(path);
      assert.deepEqual(validateDocument(current), []);
      const oldPath = fixture.version === "4.3" ? current.data.constraints.find((item) => item.type === "path")
        : current.data.path[0];
      const edits = new EditStore();
      const stage = await edits.preview(path, [{ kind: "upsert_constraint", constraintType: "path",
        name: "vine-path-copy", edition: "professional", bones: oldPath.bones,
        target: fixture.version === "4.3" ? oldPath.slot : oldPath.target,
        values: { rotateMode: "chain" } }]);
      assert.deepEqual(stage.diagnostics, []);
      await edits.commit(stage.editId);
      const project = join(directory, `vine-${fixture.version}.spine`);
      try {
        await importData(path, project, `vine-${fixture.version}`, fixture.version, 120_000);
      } catch (error) {
        console.error(`Spine ${fixture.version} path import failed:`, error.details?.stdout?.slice(-2500), error.details?.stderr?.slice(-2500));
        throw error;
      }
      assert.ok((await readFile(project)).length > 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
