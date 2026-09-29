import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { exportData, importData } from "../dist/spine/cli.js";
import { captureConstraintPose, applyConstraintPoseOperations } from "../dist/spine/constraint-pose.js";
import { skeletonText } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { validateDocument } from "../dist/spine/validate.js";

test("licensed Spine imports and reexports transferred IK, transform, path, and physics poses in 4.2 and 4.3",
  { timeout: 300_000 }, async () => {
    assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for constraint pose editor tests.");
    const directory = await mkdtemp(join(tmpdir(), "spine2d-constraint-pose-cli-"));
    try {
      for (const version of ["4.2", "4.3"]) {
        const data = JSON.parse(skeletonText(version));
        data.bones.push({ name: "arm", parent: "root", length: 40 }, { name: "goal", parent: "root", x: 30 });
        data.slots.push({ name: "route-slot", bone: "root", attachment: "route" });
        data.skins[0].attachments["route-slot"] = { route: {
          type: "path", closed: false, constantSpeed: true, vertexCount: 6,
          vertices: [0, 0, 0, 0, 8, 0, 16, 0, 24, 0, 24, 0], lengths: [8, 24],
        } };
        const path = join(directory, `rig-${version}.json`);
        await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
        const edits = new EditStore();
        const created = await edits.preview(path, [
          { kind: "upsert_constraint", constraintType: "ik", name: "aim", edition: "professional",
            bones: ["arm"], target: "goal" },
          { kind: "upsert_constraint", constraintType: "transform", name: "follow", edition: "professional",
            bones: ["arm"], target: "goal", values: version === "4.3" ? { properties: ["rotate", "x"] } : {} },
          { kind: "upsert_constraint", constraintType: "path", name: "route", edition: "professional",
            bones: ["arm"], target: "route-slot" },
          { kind: "upsert_constraint", constraintType: "physics", name: "sway", edition: "professional",
            bone: "arm", values: { rotate: 1 } },
          { kind: "upsert_animation", name: "source" },
          { kind: "set_keyframe", animation: "source", selector: { section: "ik", target: "aim" },
            time: 0, values: { mix: 0.2 } },
          { kind: "set_keyframe", animation: "source", selector: { section: "ik", target: "aim" },
            time: 1, values: { mix: 0.8 } },
          { kind: "set_keyframe", animation: "source", selector: { section: "transform", target: "follow" },
            time: 0, values: { mixRotate: 0.6, mixX: 0.3 } },
          { kind: "set_keyframe", animation: "source", selector: { section: "path", target: "route", timelineType: "position" },
            time: 0, values: { value: 5 } },
          { kind: "set_keyframe", animation: "source", selector: { section: "physics", target: "sway", timelineType: "wind" },
            time: 0, values: { value: 2 } },
        ]);
        assert.deepEqual(created.diagnostics, []);
        await edits.commit(created.editId);
        const source = await readDocument(path);
        const pose = captureConstraintPose(source, "source", 0.5, "constraint-pose");
        assert.deepEqual(new Set(pose.entries.map((entry) => entry.type)), new Set(["ik", "transform", "path", "physics"]));
        const prepared = applyConstraintPoseOperations(source, pose, "posed", 0.25);
        const staged = await edits.preview(path, prepared.operations);
        assert.deepEqual(staged.diagnostics, []);
        await edits.commit(staged.editId);
        assert.deepEqual(validateDocument(await readDocument(path)), []);

        const project = join(directory, `rig-${version}.spine`);
        try { await importData(path, project, `rig-${version}`, version, 120_000); }
        catch (error) {
          console.error(`Spine ${version} pose import failed:`, error.details?.stdout?.slice(-2500), error.details?.stderr?.slice(-2500));
          throw error;
        }
        assert.ok((await readFile(project)).length > 0);
        const settings = join(directory, `export-${version}.json`);
        await writeFile(settings, JSON.stringify({ class: "export-json", extension: ".json", format: "JSON",
          prettyPrint: true, nonessential: true, cleanUp: false, packAtlas: null,
          packSource: "attachments", packTarget: "single", warnings: true, version: null,
          all: true, output: "", id: -1, input: "", open: false }));
        let exported;
        try { exported = await exportData(project, settings, directory, version, 120_000); }
        catch (error) {
          console.error(`Spine ${version} pose export failed:`, error.details?.stdout?.slice(-2500), error.details?.stderr?.slice(-2500));
          throw error;
        }
        assert.equal(exported.files.length, 1);
        const roundTrip = await readDocument(exported.files[0]);
        assert.deepEqual(validateDocument(roundTrip), []);
        const clip = roundTrip.data.animations.posed;
        assert.equal(clip.ik.aim[0].mix, 0.5);
        assert.equal(clip.transform.follow[0].mixRotate, 0.6);
        assert.equal(clip.path.route.position[0].value, 5);
        assert.equal(clip.physics.sway.wind[0].value, 2);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
