import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PNG } from "pngjs";

import { importData } from "../dist/spine/cli.js";
import { skeletonText } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { validateDocument } from "../dist/spine/validate.js";

const serverPath = new URL("../startup.sh", import.meta.url).pathname;

for (const version of ["4.2", "4.3"]) test(`MCP round trips a Spine ${version} project through edit, import, re-export, validation, and visual comparison`, { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for round-trip CLI tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-round-trip-cli-"));
  const sourceJson = join(directory, "rig.json");
  const projectPath = join(directory, "rig.spine");
  const dataSettingsPath = join(directory, "data.export.json");
  const previewSettingsPath = join(directory, "preview.export.json");
  const client = new Client({ name: "round-trip-test", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: serverPath,
    env: { ...process.env, SPINE_MCP_STATE_DIR: join(directory, "state") } });
  try {
    await mkdir(join(directory, "images"));
    const png = new PNG({ width: 16, height: 16 });
    png.data.fill(255);
    await writeFile(join(directory, "images", "sheet.png"), PNG.sync.write(png));
    const data = JSON.parse(skeletonText(version));
    data.slots.push({ name: "body", bone: "root", attachment: "sheet" });
    data.skins[0].attachments.body = { sheet: { type: "region", width: 16, height: 16 } };
    data.animations.turn = { bones: { root: { rotate: [
      { time: 0, value: 0 }, { time: 1, value: 45 },
    ] } } };
    const originalJson = `${JSON.stringify(data, null, 2)}\n`;
    await writeFile(sourceJson, originalJson);
    await importData(sourceJson, projectPath, "rig", version, 120_000);
    const originalProject = await readFile(projectPath);
    await writeFile(dataSettingsPath, JSON.stringify({
      class: "export-json", extension: ".json", format: "JSON", prettyPrint: true,
      nonessential: true, cleanUp: false, packAtlas: null, packSource: "attachments",
      packTarget: "single", warnings: true, version: null, all: true,
      output: "", id: -1, input: "", open: false,
    }));
    await writeFile(previewSettingsPath, JSON.stringify({
      class: "export-png", exportType: "animation", skeletonType: "single", skeleton: "rig",
      animationType: "single", animation: "turn", skinType: "current", skinNone: false,
      renderImages: true, renderBones: false, scale: 100, fps: 4, lastFrame: false,
      rangeStart: 0, rangeEnd: 2, packAtlas: null, output: "", id: -1, input: "", open: false,
      frameStart: 0, frameEnd: 2, editorVersion: version,
    }));
    await client.connect(transport);
    const response = await client.callTool({ name: "spine_round_trip_edit", arguments: {
      projectPath, dataSettingsPath, previewSettingsPath, outputDir: join(directory, "runs"),
      editorVersion: version, animation: "turn", imagesDir: join(directory, "images"),
      operations: [{ kind: "retime_animation", animation: "turn", scale: 2 }],
      frameStart: 0, frameEnd: 2, samples: 2,
    } });
    assert.equal(response.isError, undefined, response.content?.[0]?.text);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.changeCount, 1);
    assert.equal(result.animation.before.duration, 1);
    assert.equal(result.animation.after.duration, 2);
    assert.equal(result.animation.fidelity.reviewNeeded, false);
    assert.equal(result.animation.fidelity.semantic.differenceCount, 0);
    assert.equal(result.pairs.length, 2);
    assert.equal(result.motionReview.structural.animation, "turn");
    assert.ok(result.motionReview.preview.sampledCount >= 2);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.status, "complete");
    assert.equal(manifest.settings.data.path.includes(result.runDir), true);
    assert.equal(manifest.assets.copied, true);
    assert.equal((await readFile(projectPath)).equals(originalProject), true);
    assert.deepEqual(validateDocument(await readDocument(result.reexported.path)), []);
    const afterCheck = await client.callTool({ name: "spine_check_animation", arguments: {
      path: result.reexported.path, animation: "turn", previewId: result.afterPreviewId,
    } });
    assert.equal(afterCheck.isError, undefined, afterCheck.content?.[0]?.text);
    const sheet = await client.readResource({ uri: result.contactSheetUri });
    assert.equal(sheet.contents[0].mimeType, "image/png");
    assert.ok(sheet.contents[0].blob?.length > 0);
  } finally {
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
