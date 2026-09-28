import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PNG } from "pngjs";

import { skeletonText } from "../dist/spine/create.js";

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
    await writeFile(previewSettingsPath, JSON.stringify({
      class: "export-png", exportType: "animation", skeletonType: "single", skeleton: "rig",
      animationType: "single", animation: "turn", skinType: "current", skinNone: false,
      renderImages: true, renderBones: false, scale: 100, fps: 4, lastFrame: false,
      rangeStart: 0, rangeEnd: 2, packAtlas: null, output: "", id: -1, input: "", open: false,
    }));
    await client.connect(transport);
    const response = await client.callTool({ name: "spine_finalize_animation", arguments: {
      dataPath, dataSettingsPath, previewSettingsPath, outputDir: join(directory, "deliveries"),
      editorVersion: version, animation: "turn", samples: 3,
    } });
    assert.equal(response.isError, undefined, response.content?.[0]?.text);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.verified, true);
    assert.equal(result.fidelity.differenceCount, 0);
    assert.ok(result.projectPath.endsWith(".spine"));
    assert.ok(result.frameCount >= 3);
    assert.equal(result.sampledIndices.length, 3);
    assert.match(await readFile(result.htmlPath, "utf8"), /new spine\.SpinePlayer/);
    assert.deepEqual((await readFile(result.contactSheetPath)).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));
    const html = await client.readResource({ uri: result.playerUri });
    assert.equal(html.contents[0].mimeType, "text/html");
    const sheet = await client.readResource({ uri: result.contactSheetUri });
    assert.equal(sheet.contents[0].mimeType, "image/png");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.status, "complete");
    assert.equal(manifest.assets.atlas.generated, true);
    assert.equal(createHash("sha256").update(await readFile(dataPath)).digest("hex"), sourceHash);
  } finally {
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
