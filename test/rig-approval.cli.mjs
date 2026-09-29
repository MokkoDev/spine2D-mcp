import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PNG } from "pngjs";

function result(response) {
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
  return response.structuredContent;
}

test("reviewed two-image rig builds and finalizes a native Spine project", { timeout: 180_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH for CLI tests.");
  const folder = await mkdtemp(join(tmpdir(), "spine-rig-approval-cli-"));
  const client = new Client({ name: "rig-approval-cli-test", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: new URL("../startup.sh", import.meta.url).pathname,
    env: { ...process.env, SPINE_MCP_STATE_DIR: join(folder, "state") } });
  try {
    const imagesDir = join(folder, "images");
    await mkdir(imagesDir);
    const png = new PNG({ width: 24, height: 40 });
    for (let y = 1; y < 39; y++) for (let x = 3; x < 21; x++) png.data.set([70, 140, 220, 255], (y * 24 + x) * 4);
    for (const name of ["body", "head"]) await writeFile(join(imagesDir, `${name}.png`), PNG.sync.write(png));
    await client.connect(transport);
    const started = result(await client.callTool({ name: "spine_start_rig_review", arguments: {
      imagesDir, outputDir: join(folder, "review"), editorVersion: "4.2",
    } }));
    const draft = structuredClone(started.manifest);
    const body = draft.parts.find((part) => part.id === "body"), head = draft.parts.find((part) => part.id === "head");
    draft.root = { part: "body", landmark: body.pivot, world: [0, 40] };
    body.parent = null;
    head.parent = { part: "body", landmark: body.tip };
    draft.drawOrder = ["body", "head"];
    result(await client.callTool({ name: "spine_save_rig_draft", arguments: {
      manifestPath: started.manifestPath, sourceHash: started.sourceHash, draft,
    } }));
    const preview = result(await client.callTool({ name: "spine_preview_rig", arguments: {
      manifestPath: started.manifestPath, outputDir: join(folder, "previews"),
    } }));
    const dataPath = join(folder, "rig.json"), projectPath = join(folder, "rig.spine");
    const built = result(await client.callTool({ name: "spine_build_rig_from_landmarks", arguments: {
      manifestPath: started.manifestPath, reviewId: preview.reviewId,
      outputDataPath: dataPath, outputProjectPath: projectPath, editorVersion: "4.2",
    } }));
    assert.equal(built.outputProjectPath, projectPath);
    assert.ok((await readFile(projectPath)).length > 100);
    const motion = result(await client.callTool({ name: "spine_preview_edit", arguments: { path: dataPath, operations: [
      { kind: "upsert_animation", name: "walk" },
      { kind: "set_keyframe", animation: "walk", selector: { section: "bones", target: "part:head", timelineType: "rotate" }, time: 0, values: { value: 0 } },
      { kind: "set_keyframe", animation: "walk", selector: { section: "bones", target: "part:head", timelineType: "rotate" }, time: 0.5, values: { value: 15 } },
      { kind: "set_keyframe", animation: "walk", selector: { section: "bones", target: "part:head", timelineType: "rotate" }, time: 1, values: { value: 0 } },
    ] } }));
    result(await client.callTool({ name: "spine_commit_edit", arguments: { editId: motion.editId } }));
    const dataSettingsPath = join(folder, "data.export.json"), previewSettingsPath = join(folder, "preview.export.json");
    await writeFile(dataSettingsPath, JSON.stringify({ class: "export-json", extension: ".json", format: "JSON", prettyPrint: true,
      nonessential: true, cleanUp: false, packAtlas: null, packSource: "attachments", packTarget: "single",
      warnings: true, version: null, all: true, output: "", id: -1, input: "", open: false }));
    await writeFile(previewSettingsPath, JSON.stringify({ class: "export-png", animations: ["walk"], skeletonType: "single", skeleton: "rig", fps: 4 }));
    const finalized = result(await client.callTool({ name: "spine_finalize_animation", arguments: {
      dataPath, dataSettingsPath, previewSettingsPath, outputDir: join(folder, "delivery"),
      imagesDir, editorVersion: "4.2", animation: "walk", display: process.env.DISPLAY || ":0", samples: 3,
    } }));
    assert.equal(finalized.verified, true);
    assert.equal(finalized.fidelity.differenceCount, 0);
    assert.ok((await readFile(finalized.projectPath)).length > 100);
  } finally { await client.close().catch(() => undefined); await rm(folder, { recursive: true, force: true }); }
});
