import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";

import { exportData, importData, packAtlas, renderPreview, unpackAtlas } from "../dist/spine/cli.js";
import { createProject } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { inspectAnimation } from "../dist/spine/inspect.js";
import { captureBonePose, poseApplyOperations } from "../dist/spine/pose.js";
import { analyzePreview } from "../dist/spine/quality.js";
import { validateDocument } from "../dist/spine/validate.js";
import { createFrameContactSheet, createVisualComparison } from "../dist/spine/visual.js";

const commit = "7ce5d0daac13268fa3ed68eb174c2822ef2692c9";
const fixtureHash = "da21eb38c5c1bb5fa5d8569d6ffeec9e4f1976ee4c260bcc709c6f32ade1c9b9";
const repository = "https://raw.githubusercontent.com/EsotericSoftware/spine-runtimes";
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");

async function download(path) {
  const response = await fetch(`${repository}/${commit}/${path}`);
  assert.equal(response.ok, true, `Failed to download ${path}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

test("licensed Spine CLI imports, exports, and renders an edited official example", { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH to the licensed Spine executable before running test:cli.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-cli-integration-"));
  const source = join(directory, "spineboy-ess.json");
  const project = join(directory, "spineboy.spine");
  const jsonSettings = join(directory, "data.export.json");
  const pngSettings = join(directory, "preview.export.json");
  try {
    const fresh = await createProject({ outputProjectPath: join(directory, "fresh.spine"), editorVersion: "4.3", fps: 24 });
    assert.equal(fresh.cli.exitCode, 0);
    assert.deepEqual(validateDocument(await readDocument(fresh.dataPath)), []);
    assert.ok((await readFile(fresh.outputProjectPath)).length > 0);
    const fresh42 = await createProject({ outputProjectPath: join(directory, "fresh42.spine"), editorVersion: "4.2" });
    assert.equal(fresh42.cli.exitCode, 0);
    assert.deepEqual(validateDocument(await readDocument(fresh42.dataPath)), []);

    const original = await download("examples/spineboy/export/spineboy-ess.json");
    assert.equal(createHash("sha256").update(original).digest("hex"), fixtureHash);
    await writeFile(source, original);
    const treeResponse = await fetch(`https://api.github.com/repos/EsotericSoftware/spine-runtimes/git/trees/${commit}?recursive=1`, { headers: { "User-Agent": "Spine2DMcp-integration-test" } });
    assert.equal(treeResponse.ok, true);
    const tree = await treeResponse.json();
    const images = tree.tree.filter((entry) => entry.path.startsWith("examples/spineboy/images/") && entry.path.endsWith(".png"));
    assert.ok(images.length > 0);
    await mkdir(join(directory, "images"));
    await Promise.all(images.map(async (entry) => writeFile(join(directory, "images", entry.path.split("/").at(-1)), await download(entry.path))));

    const imported = await importData(source, project, "spineboy", "4.3", 120_000);
    assert.equal(imported.cli.exitCode, 0);
    await writeFile(jsonSettings, JSON.stringify({
      class: "export-json", extension: ".json", format: "JSON", prettyPrint: true,
      nonessential: true, cleanUp: false, packAtlas: null, packSource: "attachments",
      packTarget: "single", warnings: true, version: null, all: true,
      output: "", id: -1, input: "", open: false,
    }));
    const exported = await exportData(project, jsonSettings, directory, "4.3", 120_000);
    assert.equal(exported.files.length, 1);
    const roundTrip = await readDocument(exported.files[0]);
    assert.deepEqual(validateDocument(roundTrip), []);
    assert.equal(inspectAnimation(roundTrip, "walk").duration, inspectAnimation(await readDocument(source), "walk").duration);

    await writeFile(pngSettings, JSON.stringify({
      class: "export-png", exportType: "animation", skeletonType: "single", skeleton: "spineboy",
      animationType: "single", animation: "walk", skinType: "current", skinNone: false,
      renderImages: true, renderBones: false, scale: 100, fps: 15, lastFrame: false,
      rangeStart: 0, rangeEnd: 2, packAtlas: null, output: "", id: -1, input: "", open: false,
    }));
    const handImage = new PNG({ width: 32, height: 32 });
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const offset = (y * 32 + x) * 4;
        handImage.data.set([255, x * 6, y * 6, 255], offset);
      }
    }
    await writeFile(join(directory, "images", "hand.png"), PNG.sync.write(handImage));
    await writeFile(join(directory, "images", "alternate-hand.png"), PNG.sync.write(handImage));
    const packInput = join(directory, "pack-images");
    await mkdir(packInput);
    await writeFile(join(packInput, "hand.png"), PNG.sync.write(handImage));
    await assert.rejects(packAtlas(packInput, join(packInput, "out"), "hands", "4.3"), { code: "INVALID_OUTPUT_PATH" });
    const packed = await packAtlas(packInput, directory, "hands", "4.3");
    assert.ok(packed.atlasFiles.length > 0);
    assert.ok(packed.textureFiles.length > 0);
    assert.deepEqual((await readFile(packed.textureFiles[0])).subarray(0, 8), pngSignature);
    await assert.rejects(unpackAtlas(packed.atlasFiles[0], join(packed.atlasDir, "unpacked"), "4.3"),
      { code: "INVALID_OUTPUT_PATH" });
    const unpacked = await unpackAtlas(packed.atlasFiles[0], directory, "4.3");
    assert.ok(unpacked.images.length > 0);
    assert.deepEqual((await readFile(unpacked.images[0])).subarray(0, 8), pngSignature);
    const freshEdits = new EditStore();
    const freshStage = await freshEdits.preview(fresh.dataPath, [
      { kind: "upsert_bone", name: "arm", parent: "root", values: { x: 10, y: 5, length: 40 } },
      { kind: "upsert_slot", name: "hand", bone: "arm", values: { attachment: "hand" } },
      { kind: "upsert_skin", name: "base" },
      { kind: "upsert_region_attachment", skin: "base", slot: "hand", name: "hand",
        values: { path: "hand", width: 32, height: 32, x: 8 } },
      { kind: "upsert_skin", name: "alternate" },
      { kind: "upsert_region_attachment", skin: "alternate", slot: "hand", name: "hand",
        values: { name: "alternate-hand", path: "alternate-hand", width: 32, height: 32, x: 8, color: "ffffffff" } },
      { kind: "upsert_event", name: "beat", values: { int: 1, string: "wave" } },
      { kind: "upsert_animation", name: "wave" },
      { kind: "set_keyframe", animation: "wave", selector: { section: "bones", target: "arm", timelineType: "rotate" },
        time: 0, values: { value: -20 } },
      { kind: "set_keyframe", animation: "wave", selector: { section: "bones", target: "arm", timelineType: "rotate" },
        time: 1, values: { value: 20 } },
      { kind: "set_keyframe", animation: "wave", selector: { section: "events" },
        time: 0.5, values: { name: "beat" } },
      { kind: "set_curve", animation: "wave", bone: "arm", timelineType: "rotate", time: 0,
        mode: "bezier", controls: [0.25, 0, 0.75, 1] },
      { kind: "clone_animation", sourceAnimation: "wave", newAnimation: "wave-slow", timeScale: 2, startAt: 0.25 },
    ]);
    assert.deepEqual(freshStage.diagnostics, []);
    await freshEdits.commit(freshStage.editId);
    const freshDocument = await readDocument(fresh.dataPath);
    assert.deepEqual(validateDocument(freshDocument), []);
    assert.equal(inspectAnimation(freshDocument, "wave-slow").duration, 2.25);
    assert.deepEqual(freshDocument.data.animations["wave-slow"].bones.arm.rotate[0].curve,
      [0.75, -20, 1.75, 20]);
    const savedPose = captureBonePose(freshDocument, "wave", 0.5, "mid-wave");
    const poseEdit = poseApplyOperations(freshDocument, savedPose, "wave-slow", 1.5,
      1, {}, "linearize");
    const poseStage = await freshEdits.preview(fresh.dataPath, poseEdit.operations);
    assert.equal(poseStage.summaries[0].curveResets, 1);
    await freshEdits.commit(poseStage.editId);
    const posedDocument = await readDocument(fresh.dataPath);
    assert.deepEqual(validateDocument(posedDocument), []);
    assert.equal(posedDocument.data.animations["wave-slow"].bones.arm.rotate[1].value, savedPose.entries[0].values.value);
    const reverseStage = await freshEdits.preview(fresh.dataPath, [{ kind: "reverse_bone_animation",
      sourceAnimation: "wave", newAnimation: "wave-reversed" }]);
    assert.deepEqual(reverseStage.diagnostics, []);
    await freshEdits.commit(reverseStage.editId);
    assert.deepEqual(validateDocument(await readDocument(fresh.dataPath)), []);
    const transferBase = await createProject({ outputProjectPath: join(directory, "target-rig.spine"), editorVersion: "4.3" });
    const transferEdits = new EditStore();
    const targetRigStage = await transferEdits.preview(transferBase.dataPath, [
      { kind: "upsert_bone", name: "wing", parent: "root", values: { length: 40, x: 10 } },
      { kind: "upsert_slot", name: "claw", bone: "wing", values: { attachment: "hand" } },
      { kind: "upsert_skin", name: "base" },
      { kind: "upsert_region_attachment", skin: "base", slot: "claw", name: "hand",
        values: { path: "hand", width: 32, height: 32, x: 8 } },
      { kind: "upsert_event", name: "beat", values: { int: 1, string: "wave" } },
    ]);
    await transferEdits.commit(targetRigStage.editId);
    const transferSource = await readDocument(fresh.dataPath);
    const transferStage = await transferEdits.preview(transferBase.dataPath, [{ kind: "retarget_animation",
      sourcePath: fresh.dataPath, sourceHash: transferSource.hash, sourceAnimation: "wave",
      newAnimation: "wing-wave", maps: { bones: { arm: "wing" } } }]);
    assert.deepEqual(transferStage.diagnostics, []);
    await transferEdits.commit(transferStage.editId);
    assert.deepEqual(validateDocument(await readDocument(transferBase.dataPath)), []);
    const transferredProject = join(directory, "transferred-rig.spine");
    await importData(transferBase.dataPath, transferredProject, "target-rig", "4.3", 120_000);
    const freshRigProject = join(directory, "fresh-rig.spine");
    try {
      await importData(fresh.dataPath, freshRigProject, "fresh", "4.3", 120_000);
    } catch (error) {
      console.error("Fresh rig import failed:", error.details?.stdout?.slice(-1500), error.details?.stderr?.slice(-1500));
      throw error;
    }
    const freshPreview = await renderPreview({ inputPath: freshRigProject, settingsPath: pngSettings,
      outputDir: directory, skeleton: "fresh", skin: "base", animation: "wave", frameStart: 0, frameEnd: 15, editorVersion: "4.3" });
    assert.ok(freshPreview.frames.length >= 2);
    const freshFrame = PNG.sync.read(await readFile(freshPreview.frames[0].path));
    assert.ok(freshFrame.data.some((_value, index) => index % 4 === 3 && freshFrame.data[index] > 0),
      "The created rig should render visible pixels.");
    const freshAnalysis = await analyzePreview(freshPreview.frames.map((item) => item.path));
    assert.equal(freshAnalysis.sampledCount, freshPreview.frames.length);
    assert.ok(freshAnalysis.frames.every((frame) => frame.visiblePixels > 0));
    const slowPreview = await renderPreview({ inputPath: freshRigProject, settingsPath: pngSettings,
      outputDir: directory, skeleton: "fresh", skin: "base", animation: "wave-slow",
      frameStart: 0, frameEnd: 15, editorVersion: "4.3" });
    assert.ok(slowPreview.frames.length >= 2);
    assert.deepEqual((await readFile(slowPreview.frames[0].path)).subarray(0, 8), pngSignature);
    const reversePreview = await renderPreview({ inputPath: freshRigProject, settingsPath: pngSettings,
      outputDir: directory, skeleton: "fresh", skin: "base", animation: "wave-reversed",
      frameStart: 0, frameEnd: 15, editorVersion: "4.3" });
    assert.ok(reversePreview.frames.length >= 2);
    assert.deepEqual((await readFile(reversePreview.frames[0].path)).subarray(0, 8), pngSignature);
    const transferPreview = await renderPreview({ inputPath: transferredProject, settingsPath: pngSettings,
      outputDir: directory, skeleton: "target-rig", skin: "base", animation: "wing-wave",
      frameStart: 0, frameEnd: 15, editorVersion: "4.3" });
    assert.ok(transferPreview.frames.length >= 2);
    const transferFrame = PNG.sync.read(await readFile(transferPreview.frames[0].path));
    assert.ok(transferFrame.data.some((_value, index) => index % 4 === 3 && transferFrame.data[index] > 0));
    const preview = await renderPreview({ inputPath: project, settingsPath: pngSettings, outputDir: directory, animation: "walk", frameStart: 0, frameEnd: 2, editorVersion: "4.3" });
    assert.equal(preview.frames.length, 3);
    assert.deepEqual((await readFile(preview.frames[0].path)).subarray(0, 8), pngSignature);
    assert.match(preview.cli.stdout, /Licensed to: \[redacted\]/);
    const previewSheet = await createFrameContactSheet([preview.frames[0].path, preview.frames[2].path], directory);
    assert.deepEqual((await readFile(previewSheet.path)).subarray(0, 8), pngSignature);

    const edits = new EditStore();
    const staged = await edits.preview(source, [{ kind: "retime_animation", animation: "walk", scale: 1.5 }]);
    assert.equal(staged.diagnostics.length, 0);
    const afterPath = join(directory, ".staged-spineboy.json");
    await writeFile(afterPath, edits.snapshot(staged.editId).afterText);
    try {
      const afterPreview = await renderPreview({ inputPath: afterPath, settingsPath: pngSettings, outputDir: directory, animation: "walk", frameStart: 0, frameEnd: 2, editorVersion: "4.3" });
      assert.equal(afterPreview.frames.length, 3);
      assert.deepEqual((await readFile(afterPreview.frames[0].path)).subarray(0, 8), pngSignature);
      const comparison = await createVisualComparison([
        { beforePath: preview.frames[0].path, afterPath: afterPreview.frames[0].path },
        { beforePath: preview.frames[2].path, afterPath: afterPreview.frames[2].path },
      ], directory);
      assert.equal(comparison.frames.length, 2);
      assert.ok(comparison.frames.every((frame) => frame.meanAbsoluteDifference >= 0 && frame.meanAbsoluteDifference <= 1));
      assert.ok(comparison.frames.every((frame) => frame.changedPixelPercent >= 0 && frame.changedPixelPercent <= 100));
      assert.deepEqual((await readFile(comparison.contactSheetPath)).subarray(0, 8), pngSignature);
    } finally {
      await rm(afterPath, { force: true });
    }
    assert.deepEqual(await readFile(source), original);
    const committed = await edits.commit(staged.editId);
    assert.deepEqual(await readFile(committed.backupPath), original);
    assert.deepEqual(validateDocument(await readDocument(source)), []);

    const firstEventTime = (await readDocument(source)).data.animations.walk.events[0].time ?? 0;
    const bulk = await edits.preview(source, [{ kind: "bulk_keys", animation: "walk", action: "move", delta: 0.1 }]);
    const bulkPath = join(directory, ".bulk-spineboy.json");
    await writeFile(bulkPath, edits.snapshot(bulk.editId).afterText);
    try {
      const bulkPreview = await renderPreview({ inputPath: bulkPath, settingsPath: pngSettings, outputDir: directory, animation: "walk", frameStart: 0, frameEnd: 2, editorVersion: "4.3" });
      assert.equal(bulkPreview.frames.length, 3);
      assert.deepEqual((await readFile(bulkPreview.frames[0].path)).subarray(0, 8), pngSignature);
    } finally {
      await rm(bulkPath, { force: true });
    }
    await edits.commit(bulk.editId);
    const edited = await readDocument(source);
    assert.ok(Math.abs(edited.data.animations.walk.events[0].time - firstEventTime - 0.1) < 0.000001);
    assert.deepEqual(validateDocument(edited), []);

    const editedProject = join(directory, "edited.spine");
    await importData(source, editedProject, "spineboy", "4.3", 120_000);
    const editedExport = await exportData(editedProject, jsonSettings, directory, "4.3", 120_000);
    const reimported = await readDocument(editedExport.files[0]);
    assert.deepEqual(validateDocument(reimported), []);
    assert.ok(Math.abs(reimported.data.animations.walk.events[0].time - edited.data.animations.walk.events[0].time) < 0.000001);

    const loop = await edits.preview(source, [{ kind: "make_loop", animation: "idle" }]);
    assert.equal(loop.summaries[0].seamIssuesAfter, 0);
    const loopPath = join(directory, ".loop-spineboy.json");
    await writeFile(loopPath, edits.snapshot(loop.editId).afterText);
    try {
      const loopPreview = await renderPreview({ inputPath: loopPath, settingsPath: pngSettings, outputDir: directory, animation: "idle", frameStart: 0, frameEnd: 2, editorVersion: "4.3" });
      assert.equal(loopPreview.frames.length, 3);
      assert.deepEqual((await readFile(loopPreview.frames[0].path)).subarray(0, 8), pngSignature);
      await importData(loopPath, join(directory, "loop.spine"), "spineboy", "4.3", 120_000);
    } catch (error) {
      console.error("Loop CLI integration failure:", error.code, error.details?.stdout?.slice(-1200), error.details?.stderr?.slice(-1200));
      throw error;
    } finally {
      await rm(loopPath, { force: true });
    }

    const walkBones = (await readDocument(source)).data.animations.walk.bones;
    const [curveBone, curveTimeline] = Object.entries(walkBones).find(([_name, timelines]) => timelines.rotate?.length >= 2) ?? [];
    assert.ok(curveBone, "Official Spineboy walk needs a bone rotation segment for the curve import check.");
    const curveKeyTime = curveTimeline.rotate[0].time ?? 0;
    const curveStage = await edits.preview(source, [{ kind: "set_curve", animation: "walk", bone: curveBone,
      timelineType: "rotate", time: curveKeyTime, mode: "bezier", controls: [0.25, 0, 0.75, 1] }]);
    assert.equal(curveStage.diagnostics.filter((item) => item.severity === "error").length, 0);
    const curvePath = join(directory, ".curve-spineboy.json");
    await writeFile(curvePath, edits.snapshot(curveStage.editId).afterText);
    try {
      await importData(curvePath, join(directory, "curve.spine"), "spineboy", "4.3", 120_000);
    } finally {
      await rm(curvePath, { force: true });
    }

    const keyDocument = await readDocument(source);
    const walk = keyDocument.data.animations.walk;
    const freeBone = keyDocument.data.bones.find((bone) => !Object.hasOwn(walk.bones?.[bone.name] ?? {}, "translate"))?.name;
    const defaultSkin = keyDocument.data.skins.find((skin) => skin.name === "default");
    const attachment = keyDocument.data.slots.find((slot) =>
      typeof slot.attachment === "string" && defaultSkin?.attachments?.[slot.name]?.[slot.attachment]);
    const eventName = Object.keys(keyDocument.data.events ?? {})[0];
    assert.ok(freeBone && attachment && eventName, "Official Spineboy fixture needs a free bone timeline, setup attachment, and event.");
    const end = inspectAnimation(keyDocument, "walk").duration;
    const keyStage = await edits.preview(source, [
      { kind: "set_keyframe", animation: "walk", selector: { section: "bones", target: freeBone, timelineType: "translate" },
        time: end + 0.2, values: { x: 1, y: -2 } },
      { kind: "set_keyframe", animation: "walk", selector: { section: "slots", target: attachment.name, timelineType: "attachment" },
        time: end + 0.25, values: { name: attachment.attachment } },
      { kind: "set_keyframe", animation: "walk", selector: { section: "events" },
        time: end + 0.3, values: { name: eventName } },
      { kind: "set_keyframe", animation: "walk", selector: { section: "drawOrder" },
        time: end + 0.35, values: {} },
    ]);
    assert.equal(keyStage.diagnostics.filter((item) => item.severity === "error").length, 0);
    const keyPath = join(directory, ".keys-spineboy.json");
    await writeFile(keyPath, edits.snapshot(keyStage.editId).afterText);
    try {
      await importData(keyPath, join(directory, "keys.spine"), "spineboy", "4.3", 120_000);
    } finally {
      await rm(keyPath, { force: true });
    }

    const proSource = join(directory, "spineboy-pro.json");
    const proBytes = await download("examples/spineboy/export/spineboy-pro.json");
    assert.equal(createHash("sha256").update(proBytes).digest("hex"), "24ccffc13e334e721dfd427ee2b8aea05c25b59167b5fb0bb0f9685e11d2a7d3");
    await writeFile(proSource, proBytes);
    const proDocument = await readDocument(proSource);
    const deformEntry = Object.entries(proDocument.data.animations.hoverboard.attachments).flatMap(([skin, slots]) =>
      Object.entries(slots).flatMap(([slot, attachments]) =>
        Object.entries(attachments).flatMap(([attachment, timelines]) =>
          Array.isArray(timelines.deform) ? [{ skin, slot, attachment }] : []))).at(0);
    assert.ok(deformEntry, "Official Spineboy Pro hoverboard needs a deform timeline.");
    const proEnd = inspectAnimation(proDocument, "hoverboard").duration;
    const deformStage = await edits.preview(proSource, [{ kind: "set_keyframe", animation: "hoverboard",
      selector: { section: "attachments", ...deformEntry, timelineType: "deform" },
      time: proEnd + 0.1, values: { offset: 1, vertices: [0.1] } }]);
    assert.equal(deformStage.diagnostics.filter((item) => item.severity === "error").length, 0);
    const deformPath = join(directory, ".deform-spineboy-pro.json");
    await writeFile(deformPath, edits.snapshot(deformStage.editId).afterText);
    try {
      const deformProject = join(directory, "deform.spine");
      await importData(deformPath, deformProject, "spineboy", "4.3", 120_000);
      const deformPreview = await renderPreview({ inputPath: deformProject, settingsPath: pngSettings,
        outputDir: directory, animation: "hoverboard", frameStart: 0, frameEnd: 2, editorVersion: "4.3" });
      assert.equal(deformPreview.frames.length, 3);
      assert.deepEqual((await readFile(deformPreview.frames[0].path)).subarray(0, 8), pngSignature);
    } finally {
      await rm(deformPath, { force: true });
    }
  } catch (error) {
    console.error("CLI integration failure:", error.code, error.details?.stdout?.slice(-2500),
      error.details?.stderr?.slice(-2500));
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
