import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PNG } from "pngjs";

import { skeletonText } from "../dist/spine/create.js";
import { exportData, importData } from "../dist/spine/cli.js";

const serverPath = new URL("../startup.sh", import.meta.url).pathname;

for (const version of ["4.2", "4.3"]) test(`MCP finalizes Spine ${version} JSON with a verified project, HTML preview, and contact sheet`, { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for finalization CLI tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-finalize-cli-"));
  const sourceDir = join(directory, "source");
  const imagesDir = join(directory, "Assets");
  const dataPath = join(sourceDir, "rig.json");
  const dataSettingsPath = join(directory, "data.export.json");
  const previewSettingsPath = join(directory, "preview.export.json");
  const client = new Client({ name: "finalize-test", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: serverPath,
    env: { ...process.env, SPINE_MCP_STATE_DIR: join(directory, "state") } });
  try {
    await mkdir(sourceDir);
    await mkdir(imagesDir);
    const png = new PNG({ width: 16, height: 16 });
    png.data.fill(255);
    await writeFile(join(imagesDir, "sheet.png"), PNG.sync.write(png));
    const data = JSON.parse(skeletonText(version));
    data.skeleton.images = "../Assets/";
    data.slots.push({ name: "body", bone: "root", attachment: "sheet" });
    data.skins[0].attachments.body = { sheet: { type: "region", width: 16, height: 16 } };
    data.animations.turn = { bones: { root: { rotate: [
      { time: 0, value: 0 }, { time: 1, value: 45 },
    ] } } };
    await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);
    const sourceHash = createHash("sha256").update(await readFile(dataPath)).digest("hex");
    await writeFile(dataSettingsPath, JSON.stringify({
      class: "export-json", extension: ".json", format: "JSON", prettyPrint: true,
      nonessential: true, cleanUp: false, packAtlas: null, packSource: "attachments",
      packTarget: "single", warnings: true, version: null, all: true,
      output: "", id: -1, input: "", open: false,
    }));
    // A minimal saved preset with a stale skeleton selection must still render
    // the new project imported from rig.json.
    await writeFile(previewSettingsPath, JSON.stringify({
      class: "export-png", animations: ["turn"], skeletonType: "single",
      skeleton: "old-rig", fps: 4,
    }));
    await client.connect(transport);
    const response = await client.callTool({ name: "spine_finalize_animation", arguments: {
      dataPath, dataSettingsPath, previewSettingsPath, outputDir: join(directory, "deliveries"),
      editorVersion: version, animation: "turn", samples: 3,
    } });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const result = response.structuredContent;
    assert.equal(result.verified, true);
    assert.equal(result.projectMode, "created");
    assert.equal(result.fidelity.differenceCount, 0);
    assert.ok(result.projectPath.endsWith(".spine"));
    assert.ok(result.frameCount >= 3);
    assert.equal(result.frames.length, 3);
    assert.equal(result.animation.name, "turn");
    assert.equal(result.animation.keyCount, 2);
    assert.equal(result.previewReview.frames, undefined);
    assert.ok(JSON.stringify(result).length < 6000);
    assert.match(await readFile(result.htmlPath, "utf8"), /new spine\.SpinePlayer/);
    assert.deepEqual((await readFile(result.contactSheetPath)).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));
    const html = await client.readResource({ uri: result.playerUri });
    assert.equal(html.contents[0].mimeType, "text/html");
    const sheet = await client.readResource({ uri: result.contactSheetUri });
    assert.equal(sheet.contents[0].mimeType, "image/png");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.status, "complete");
    assert.ok(manifest.rendered.review.frames.length >= 3);
    assert.equal(manifest.assets.atlas.generated, true);
    const effectivePreview = JSON.parse(await readFile(manifest.settings.effectivePreview.path, "utf8"));
    assert.equal(effectivePreview.skeleton, "rig");
    assert.equal(effectivePreview.skinType, "current");
    assert.equal(effectivePreview.animation, "turn");
    assert.equal(createHash("sha256").update(await readFile(dataPath)).digest("hex"), sourceHash);

    const baseline = structuredClone(data);
    delete baseline.animations.turn;
    const baselinePath = join(sourceDir, "baseline.json");
    const projectDir = version === "4.2" ? join(directory, "alternate") : sourceDir;
    await mkdir(projectDir, { recursive: true });
    const existingProjectPath = join(projectDir, "rig.spine");
    const existingProjectInput = version === "4.2" ? { existingProjectPath } : {};
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    await importData(baselinePath, existingProjectPath, "rig", version, 120_000);
    const beforeProject = await readFile(existingProjectPath);
    if (version === "4.3") {
      const siblingResponse = await client.callTool({ name: "spine_finalize_animation", arguments: {
        dataPath, dataSettingsPath, previewSettingsPath, outputDir: join(directory, "sibling-deliveries"),
        editorVersion: version, animation: "turn", samples: 3,
      } });
      assert.equal(siblingResponse.isError, undefined, JSON.stringify(siblingResponse.structuredContent));
      assert.equal(siblingResponse.structuredContent.projectMode, "created");
      assert.notEqual(siblingResponse.structuredContent.projectPath, existingProjectPath);
      assert.deepEqual(await readFile(existingProjectPath), beforeProject);
    }
    const updatedResponse = await client.callTool({ name: "spine_finalize_animation", arguments: {
      dataPath, dataSettingsPath, previewSettingsPath, outputDir: join(directory, "updated-deliveries"),
      editorVersion: version, animation: "turn", samples: 3, replaceExistingProject: true, ...existingProjectInput,
    } });
    assert.equal(updatedResponse.isError, undefined, JSON.stringify(updatedResponse.structuredContent));
    const updated = updatedResponse.structuredContent;
    assert.equal(updated.projectMode, "updated");
    assert.equal(updated.projectPath, existingProjectPath);
    assert.deepEqual(await readFile(updated.backupPath), beforeProject);
    const exportedUpdated = await exportData(existingProjectPath, dataSettingsPath,
      join(directory, "verify-updated"), version, 120_000);
    assert.ok(JSON.parse(await readFile(exportedUpdated.files[0], "utf8")).animations.turn);

    const isolatedDir = join(directory, "isolated", "nested");
    const isolatedProjectPath = join(isolatedDir, "rig.spine");
    await mkdir(isolatedDir, { recursive: true });
    await copyFile(existingProjectPath, isolatedProjectPath);
    const missingImages = await client.callTool({ name: "spine_finalize_animation", arguments: {
      dataPath, dataSettingsPath, previewSettingsPath, outputDir: join(directory, "missing-images-deliveries"),
      editorVersion: version, animation: "turn", samples: 3,
      existingProjectPath: isolatedProjectPath, replaceExistingProject: true,
    } });
    assert.equal(missingImages.isError, true);
    assert.equal(missingImages.structuredContent.code, "MISSING_IMAGES");

    const updatedHash = createHash("sha256").update(await readFile(existingProjectPath)).digest("hex");
    const incompatible = structuredClone(data);
    incompatible.bones[0].x = 5;
    await writeFile(dataPath, `${JSON.stringify(incompatible, null, 2)}\n`);
    try {
      const mismatch = await client.callTool({ name: "spine_finalize_animation", arguments: {
        dataPath, dataSettingsPath, previewSettingsPath, outputDir: join(directory, "mismatch-deliveries"),
        editorVersion: version, animation: "turn", samples: 3, replaceExistingProject: true, ...existingProjectInput,
      } });
      assert.equal(mismatch.isError, true);
      assert.equal(mismatch.structuredContent.code, "EXISTING_PROJECT_MISMATCH");
      assert.equal(createHash("sha256").update(await readFile(existingProjectPath)).digest("hex"), updatedHash);
    } finally {
      await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);
    }
  } finally {
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
