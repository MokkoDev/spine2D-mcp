import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PNG } from "pngjs";

import { SERVER_NAME, SERVER_VERSION, TOOL_AREAS, TOOL_CATALOG } from "../dist/catalog.js";

const serverPath = fileURLToPath(new URL("../startup.sh", import.meta.url));

function solidPng(rgba) {
  const png = new PNG({ width: 1, height: 1 });
  png.data.set(rgba);
  return PNG.sync.write(png).toString("base64");
}

const fixture = {
  skeleton: { spine: "4.3.75-beta", images: "./images/", fps: 30 },
  bones: [{ name: "root" }, { name: "arm", parent: "root" }],
  slots: [{ name: "hand", bone: "arm", attachment: "hand" }],
  skins: [{ name: "default", attachments: { hand: { hand: { width: 16, height: 16 } } } }],
  events: { footstep: {} },
  animations: {
    walk: {
      bones: { arm: { rotate: [
        { value: 0, curve: [0.1, 0, 0.3, 20] },
        { time: 0.5, value: 20 },
      ] } },
      slots: { hand: { attachment: [{ name: "hand" }, { time: 0.5, name: "hand" }] } },
      events: [{ time: 0.25, name: "footstep" }],
    },
  },
};

async function connect(extraEnv = {}) {
  const client = new Client({ name: "spine2d-mcp-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: serverPath, env: { ...process.env, ...extraEnv } });
  await client.connect(transport);
  return client;
}

function parseTextResult(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("stdio MCP handshake exposes and calls only implemented tools", { timeout: 20_000 }, async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      TOOL_CATALOG.filter((tool) => tool.status === "implemented")
        .map((tool) => tool.name)
        .sort(),
    );
    assert.match(client.getInstructions(), /spine_workflow_guide/);
    assert.match(client.getInstructions(), /spine_preview_edit/);

    const { resources } = await client.listResources();
    assert.ok(resources.some((resource) => resource.uri === "spine-docs://reference/start-here"));
    const start = await client.readResource({ uri: "spine-docs://reference/start-here" });
    assert.match(start.contents[0].text, /inspect → edit → preview → commit/);
    const referenceMatches = parseTextResult(await client.callTool({ name: "spine_search_reference", arguments: { query: "retime animation" } }));
    assert.ok(referenceMatches.pages.some((page) => page.uri === "spine-docs://reference/edit-json"));
    const detail = await client.readResource({ uri: "spine-docs://reference/edit-json" });
    assert.match(detail.contents[0].text, /spine_retime_animation/);
    const fetched = parseTextResult(await client.callTool({ name: "spine_get_reference", arguments: { slug: "edit-json" } }));
    assert.equal(fetched.markdown, detail.contents[0].text);
    const referenceTool = tools.find((tool) => tool.name === "spine_search_reference");
    assert.equal(referenceTool.inputSchema.properties.query.type, "string");

    const status = parseTextResult(await client.callTool({ name: "spine_status", arguments: {} }));
    assert.equal(status.name, SERVER_NAME);
    assert.equal(status.version, SERVER_VERSION);
    assert.equal(status.transport, "stdio");
    assert.equal(status.spineIntegration, "json+cli");
    assert.deepEqual(status.supportedSpineVersions, ["4.2", "4.3"]);
    assert.equal(typeof status.cli.available, "boolean");

    const capabilities = parseTextResult(
      await client.callTool({ name: "spine_capabilities", arguments: {} }),
    );
    assert.deepEqual(capabilities.tools, TOOL_CATALOG);
    assert.deepEqual([...new Set(TOOL_CATALOG.map((tool) => tool.area))].sort(), [...TOOL_AREAS].sort());
    assert.ok(capabilities.tools.some((tool) => tool.status === "planned"));
    assert.ok(capabilities.areas.some((area) => area.name === "Visual review" && area.count > 0));
    const visualTools = parseTextResult(await client.callTool({ name: "spine_capabilities", arguments: {
      area: "Visual review", status: "implemented",
    } }));
    assert.ok(visualTools.tools.length > 0);
    assert.ok(visualTools.tools.every((tool) => tool.area === "Visual review" && tool.status === "implemented"));
    const poseTools = parseTextResult(await client.callTool({ name: "spine_capabilities", arguments: { query: "pose" } }));
    assert.ok(poseTools.tools.some((tool) => tool.name === "spine_save_pose"));
    assert.ok(poseTools.tools.every((tool) => `${tool.name} ${tool.purpose} ${tool.area}`.toLowerCase().includes("pose")));
    const menu = parseTextResult(await client.callTool({ name: "spine_workflow_guide", arguments: { goal: "choose" } }));
    assert.ok(menu.workflows.every((item) => item.primaryTools.length > 0
      && item.primaryTools.every((name) => tools.some((tool) => tool.name === name))));
    const guide = parseTextResult(await client.callTool({ name: "spine_workflow_guide", arguments: { goal: "round_trip" } }));
    assert.equal(guide.goal, "round_trip");
    assert.deepEqual(guide.primaryTools, ["spine_round_trip_edit"]);
    assert.ok(guide.steps.some((step) => step.includes("spine_round_trip_edit")));
  } finally {
    await client.close();
  }
});

test("MCP creates a minimal skeleton that inspection can read", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-new-"));
  const path = join(directory, "new-character.json");
  const client = await connect();
  try {
    const created = parseTextResult(await client.callTool({ name: "spine_create_skeleton", arguments: {
      dataPath: path, version: "4.3", rootBoneName: "root", fps: 24,
    } }));
    assert.equal(created.dataPath, path);
    const inventory = parseTextResult(await client.callTool({ name: "spine_inspect_project", arguments: { path } }));
    assert.equal(inventory.inventory.bone.count, 1);
    assert.equal(inventory.version, "4.3");
    const duplicate = await client.callTool({ name: "spine_create_skeleton", arguments: { dataPath: path, version: "4.3" } });
    assert.equal(duplicate.isError, true);
    assert.equal(JSON.parse(duplicate.content[0].text).code, "OUTPUT_EXISTS");
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP stages a new rig and animation as one edit", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-rig-"));
  const path = join(directory, "character.json");
  const client = await connect();
  try {
    parseTextResult(await client.callTool({ name: "spine_create_skeleton", arguments: { dataPath: path, version: "4.3" } }));
    const stage = parseTextResult(await client.callTool({ name: "spine_preview_edit", arguments: { path, operations: [
      { kind: "upsert_bone", name: "arm", parent: "root", values: { length: 40 } },
      { kind: "upsert_slot", name: "hand", bone: "arm", values: { attachment: "hand" } },
      { kind: "upsert_region_attachment", skin: "default", slot: "hand", name: "hand", values: { path: "hand", width: 32, height: 32 } },
      { kind: "upsert_skin", name: "alternate" },
      { kind: "upsert_event", name: "beat", values: { int: 1 } },
      { kind: "upsert_animation", name: "wave" },
      { kind: "set_keyframe", animation: "wave", selector: { section: "bones", target: "arm", timelineType: "rotate" },
        time: 0, values: { value: -20 } },
      { kind: "set_keyframe", animation: "wave", selector: { section: "bones", target: "arm", timelineType: "rotate" },
        time: 1, values: { value: 20 } },
      { kind: "set_keyframe", animation: "wave", selector: { section: "events" }, time: 0.5, values: { name: "beat" } },
    ] } }));
    assert.equal(stage.summaries.length, 9);
    assert.deepEqual(stage.diagnostics, []);
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: stage.editId } }));
    const data = JSON.parse(await readFile(path, "utf8"));
    assert.equal(data.skins[0].attachments.hand.hand.width, 32);
    assert.equal(data.skins[1].name, "alternate");
    assert.equal(data.events.beat.int, 1);
    assert.equal(data.animations.wave.bones.arm.rotate.length, 2);
    const essentialConstraint = await client.callTool({ name: "spine_upsert_constraint", arguments: {
      path, constraintType: "ik", name: "aim", edition: "essential", bones: ["arm"], target: "root",
    } });
    assert.equal(essentialConstraint.isError, true);
    assert.equal(JSON.parse(essentialConstraint.content[0].text).code, "UNSUPPORTED_EDITION");
    const constraint = parseTextResult(await client.callTool({ name: "spine_upsert_constraint", arguments: {
      path, constraintType: "ik", name: "aim", edition: "professional", bones: ["arm"], target: "root",
      values: { mix: 0.25 },
    } }));
    assert.equal(constraint.summaries[0].kind, "upsert_constraint");
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: constraint.editId } }));
    assert.equal(JSON.parse(await readFile(path, "utf8")).constraints[0].mix, 0.25);
    const variant = parseTextResult(await client.callTool({ name: "spine_clone_animation", arguments: {
      path, sourceAnimation: "wave", newAnimation: "wave-slow", timeScale: 2, startAt: 0.25,
    } }));
    assert.equal(variant.summaries[0].afterDuration, 2.25);
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: variant.editId } }));
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations["wave-slow"].bones.arm.rotate[1].time, 2.25);
    const pose = parseTextResult(await client.callTool({ name: "spine_save_bone_pose", arguments: {
      path, animation: "wave", time: 0.5, name: "mid-wave",
    } }));
    assert.equal(pose.channelCount, 1);
    const poseResource = await client.readResource({ uri: pose.poseResourceUri });
    assert.equal(JSON.parse(poseResource.contents[0].text).entries[0].values.value, 0);
    const applied = parseTextResult(await client.callTool({ name: "spine_apply_bone_pose", arguments: {
      poseId: pose.poseId, path, animation: "wave-slow", time: 1.5,
    } }));
    assert.equal(applied.channelCount, 1);
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: applied.editId } }));
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations["wave-slow"].bones.arm.rotate[1].value, 0);
    const reversed = parseTextResult(await client.callTool({ name: "spine_reverse_bone_animation", arguments: {
      path, sourceAnimation: "wave", newAnimation: "wave-reversed",
    } }));
    assert.equal(reversed.summaries[0].kind, "reverse_bone_animation");
    assert.deepEqual(reversed.diagnostics, []);
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: reversed.editId } }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).animations["wave-reversed"].bones.arm.rotate
      .map((key) => key.value), [20, -20]);
    const targetPath = join(directory, "retarget.json");
    await writeFile(targetPath, JSON.stringify({ skeleton: { spine: "4.3" },
      bones: [{ name: "root" }, { name: "wing", parent: "root" }], slots: [],
      skins: [{ name: "default", attachments: {} }], events: { beat: { int: 1 } }, animations: {} }));
    const transferred = parseTextResult(await client.callTool({ name: "spine_retarget_animation", arguments: {
      sourcePath: path, targetPath, sourceAnimation: "wave", newAnimation: "wing-wave",
      maps: { bones: { arm: "wing" } },
    } }));
    assert.equal(transferred.summaries[0].kind, "retarget_animation");
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: transferred.editId } }));
    assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")).animations["wing-wave"].bones.wing.rotate
      .map((key) => key.value), [-20, 20]);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP stages and commits a typed mesh with named bone weights", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-mesh-"));
  const path = join(directory, "character.json");
  const client = await connect();
  try {
    parseTextResult(await client.callTool({ name: "spine_create_skeleton", arguments: { dataPath: path, version: "4.3" } }));
    const setup = parseTextResult(await client.callTool({ name: "spine_preview_edit", arguments: { path, operations: [
      { kind: "upsert_bone", name: "arm", parent: "root" },
      { kind: "upsert_slot", name: "body", bone: "root" },
    ] } }));
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: setup.editId } }));
    const mesh = parseTextResult(await client.callTool({ name: "spine_upsert_attachment", arguments: {
      path, skin: "default", slot: "body", name: "shirt", attachmentType: "mesh",
      values: { path: "shirt", uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 16, 0, 0, 16],
        triangles: [0, 1, 2], hull: 3, width: 16, height: 16 },
    } }));
    assert.equal(mesh.summaries[0].vertexCount, 3);
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: mesh.editId } }));
    const weights = parseTextResult(await client.callTool({ name: "spine_set_mesh_weights", arguments: {
      path, skin: "default", slot: "body", name: "shirt",
      influences: Array.from({ length: 3 }, () => [
        { bone: "root", x: 0, y: 0, weight: 0.5 }, { bone: "arm", x: 0, y: 0, weight: 0.5 },
      ]),
    } }));
    assert.equal(weights.summaries[0].weighted, true);
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: weights.editId } }));
    const geometry = parseTextResult(await client.callTool({ name: "spine_set_mesh_geometry", arguments: {
      path, skin: "default", slot: "body", name: "shirt",
      uvs: [0, 0, 1, 0, 0, 1], vertices: [1, 1, 17, 1, 1, 17], triangles: [0, 1, 2], hull: 3,
    } }));
    assert.equal(geometry.summaries[0].weighted, false);
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: geometry.editId } }));
    const attachment = JSON.parse(await readFile(path, "utf8")).skins[0].attachments.body.shirt;
    assert.deepEqual(attachment.vertices, [1, 1, 17, 1, 1, 17]);
    const removed = parseTextResult(await client.callTool({ name: "spine_remove_attachment", arguments: {
      path, skin: "default", slot: "body", name: "shirt",
    } }));
    assert.equal(removed.summaries[0].action, "removed");
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: removed.editId } }));
    assert.equal(JSON.parse(await readFile(path, "utf8")).skins[0].attachments.body, undefined);
    const addedSkin = parseTextResult(await client.callTool({ name: "spine_upsert_skin", arguments: {
      path, name: "alternate",
    } }));
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: addedSkin.editId } }));
    const removedSkin = parseTextResult(await client.callTool({ name: "spine_remove_skin", arguments: {
      path, name: "alternate",
    } }));
    assert.equal(removedSkin.summaries[0].action, "removed");
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: removedSkin.editId } }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).skins.map((skin) => skin.name), ["default"]);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP exposes staged constraint, event, and animation removal", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-remove-"));
  const path = join(directory, "character.json");
  const client = await connect();
  try {
    parseTextResult(await client.callTool({ name: "spine_create_skeleton", arguments: { dataPath: path, version: "4.3" } }));
    const setup = parseTextResult(await client.callTool({ name: "spine_preview_edit", arguments: { path, operations: [
      { kind: "upsert_bone", name: "arm", parent: "root" },
      { kind: "upsert_bone", name: "goal", parent: "root" },
      { kind: "upsert_constraint", constraintType: "ik", name: "aim", edition: "professional", bones: ["arm"], target: "goal" },
      { kind: "upsert_event", name: "beat" },
      { kind: "upsert_animation", name: "wave" },
    ] } }));
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: setup.editId } }));
    for (const [tool, arguments_] of [
      ["spine_remove_constraint", { constraintType: "ik", name: "aim" }],
      ["spine_remove_event", { name: "beat" }],
      ["spine_remove_animation", { name: "wave" }],
    ]) {
      const stage = parseTextResult(await client.callTool({ name: tool, arguments: { path, ...arguments_ } }));
      assert.equal(stage.summaries[0].action, "removed");
      parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: stage.editId } }));
    }
    const data = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(data.constraints, []);
    assert.deepEqual(data.events, {});
    assert.deepEqual(data.animations, {});
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspect, validate, stage, and commit a full animation retime", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-"));
  const path = join(directory, "character.json");
  const original = `${JSON.stringify(fixture, null, 2)}\n`;
  await writeFile(path, original);
  const client = await connect();
  try {
    const inspect = parseTextResult(await client.callTool({ name: "spine_inspect_project", arguments: { path } }));
    assert.equal(inspect.inventory.bone.count, 2);
    assert.equal(inspect.inventory.animation.count, 1);
    const inventoryResource = await client.readResource({ uri: inspect.inventoryResourceUri });
    const fullInventory = JSON.parse(inventoryResource.contents[0].text);
    assert.ok(fullInventory.entries.some((entry) => entry.kind === "bone" && entry.name === "arm"));

    const search = parseTextResult(await client.callTool({ name: "spine_search_project", arguments: { path, query: "arm", kind: "bone" } }));
    assert.equal(search.total, 1);
    const references = parseTextResult(await client.callTool({ name: "spine_reference_graph", arguments: { path, kind: "bone", name: "arm" } }));
    assert.ok(references.references.some((reference) => reference.relation === "slot bone"));
    assert.ok(references.references.some((reference) => reference.relation === "bone timeline"));

    const animation = parseTextResult(await client.callTool({ name: "spine_inspect_animation", arguments: { path, animation: "walk", from: 0.2, to: 0.5 } }));
    assert.equal(animation.duration, 0.5);
    assert.equal(animation.timelineCount, 3);
    const quality = parseTextResult(await client.callTool({ name: "spine_check_animation", arguments: { path, animation: "walk", loop: true } }));
    assert.ok(quality.hints.some((hint) => hint.code === "LOOP_DISCONTINUITY"));
    assert.ok(quality.checksUnavailable.includes("foot sliding"));
    const validation = parseTextResult(await client.callTool({ name: "spine_validate_data", arguments: { path } }));
    assert.equal(validation.valid, true);
    assert.deepEqual(validation.diagnostics, []);
    await mkdir(join(directory, "images"));
    await writeFile(join(directory, "images", "hand.png"), "fixture");
    await writeFile(join(directory, "images", "unused.png"), "fixture");
    const atlasPath = join(directory, "character.atlas");
    await writeFile(atlasPath, "missing-page.png\nsize: 1, 1\n");
    const assets = parseTextResult(await client.callTool({ name: "spine_inspect_assets", arguments: { path, atlasPath } }));
    assert.equal(assets.missingCount, 0);
    assert.deepEqual(assets.unused, ["unused.png"]);
    assert.deepEqual(assets.atlas.missingPages, ["missing-page.png"]);

    const preview = parseTextResult(await client.callTool({ name: "spine_retime_animation", arguments: { path, animation: "walk", scale: 2, requestId: "retime-walk" } }));
    assert.equal(preview.summaries[0].beforeDuration, 0.5);
    assert.equal(preview.summaries[0].afterDuration, 1);
    assert.equal(preview.diagnostics.length, 0);
    assert.equal(await readFile(path, "utf8"), original);
    const repeat = parseTextResult(await client.callTool({ name: "spine_retime_animation", arguments: { path, animation: "walk", scale: 2, requestId: "retime-walk" } }));
    assert.equal(repeat.editId, preview.editId);
    const diffResource = await client.readResource({ uri: preview.diffResourceUri });
    const fullDiff = JSON.parse(diffResource.contents[0].text);
    assert.equal(fullDiff.editId, preview.editId);
    assert.equal(fullDiff.changes.length, preview.changeCount);

    const committed = parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: preview.editId } }));
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.equal(after.animations.walk.bones.arm.rotate[1].time, 1);
    assert.deepEqual(after.animations.walk.bones.arm.rotate[0].curve, [0.2, 0, 0.6, 20]);
    assert.equal(after.animations.walk.events[0].time, 0.5);
    assert.equal(await readFile(committed.backupPath, "utf8"), original);
    const manifest = JSON.parse(await readFile(committed.manifestPath, "utf8"));
    assert.equal(manifest.status, "committed");
    assert.equal(manifest.operations[0].kind, "retime_animation");
    const repeatCommit = parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: preview.editId } }));
    assert.deepEqual(repeatCommit, committed);

    const bulk = parseTextResult(await client.callTool({ name: "spine_bulk_keys", arguments: {
      path, animations: ["walk"], action: "move", section: "events", delta: 0.1,
    } }));
    assert.equal(bulk.summaries[0].kind, "bulk_keys");
    assert.equal(bulk.summaries[0].keysSelected, 1);
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations.walk.events[0].time, 0.5);
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: bulk.editId } }));
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations.walk.events[0].time, 0.6);

    const loop = parseTextResult(await client.callTool({ name: "spine_make_loop", arguments: { path, animation: "walk" } }));
    assert.equal(loop.summaries[0].kind, "make_loop");
    assert.equal(loop.summaries[0].seamIssuesAfter, 0);
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations.walk.bones.arm.rotate.at(-1).value, 20);
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: loop.editId } }));
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations.walk.bones.arm.rotate.at(-1).value, 0);

    const curve = parseTextResult(await client.callTool({ name: "spine_set_curve", arguments: {
      path, animation: "walk", bone: "arm", timelineType: "rotate", time: 0,
      mode: "bezier", controls: [0.25, 0, 0.75, 1],
    } }));
    assert.equal(curve.summaries[0].kind, "set_curve");
    assert.equal(curve.summaries[0].channels, 1);
    assert.equal(curve.changeCount, 1);
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: curve.editId } }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).animations.walk.bones.arm.rotate[0].curve, [0.25, 0, 0.75, 0]);

    const key = parseTextResult(await client.callTool({ name: "spine_set_keyframe", arguments: {
      path, animation: "walk", selector: { section: "bones", target: "arm", timelineType: "translate" },
      time: 0, values: { x: 5, y: -3 },
    } }));
    assert.equal(key.summaries[0].action, "inserted");
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: key.editId } }));
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations.walk.bones.arm.translate[0].x, 5);
    const deleted = parseTextResult(await client.callTool({ name: "spine_delete_keyframe", arguments: {
      path, animation: "walk", selector: { section: "bones", target: "arm", timelineType: "translate" }, time: 0,
    } }));
    assert.equal(deleted.summaries[0].keysAfter, 0);
    parseTextResult(await client.callTool({ name: "spine_commit_edit", arguments: { editId: deleted.editId } }));
    assert.equal(Object.hasOwn(JSON.parse(await readFile(path, "utf8")).animations.walk.bones.arm, "translate"), false);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PNG preview invokes configured Spine CLI and exposes a frame resource", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-cli-"));
  const mockCli = join(directory, "Spine.sh");
  const settingsPath = join(directory, "png.export.json");
  const inputPath = join(directory, "character.json");
  const png = Buffer.from(solidPng([255, 0, 0, 255]), "base64");
  const projectData = structuredClone(fixture);
  projectData.animations.idle = {};
  await writeFile(inputPath, JSON.stringify(projectData));
  await writeFile(settingsPath, JSON.stringify({ class: "images", imageType: "PNG", animationType: "all", fps: 30, bones: true }));
  await writeFile(mockCli, `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst args = process.argv.slice(2);\nconst output = args[args.indexOf("--output") + 1];\nconst settings = JSON.parse(fs.readFileSync(args[args.indexOf("--export") + 1], "utf8"));\nif (settings.class !== "export-png" || settings.animation !== "walk" || settings.animationType !== "single" || settings.renderBones !== true || settings.rangeStart !== 2 || settings.rangeEnd !== 4 || process.env.DISPLAY !== ":42") process.exit(2);\nfs.writeFileSync(path.join(output, "walk-0002.png"), Buffer.from("${png.toString("base64")}", "base64"));\n`);
  await chmod(mockCli, 0o755);
  const client = await connect({ SPINE_CLI_PATH: directory });
  try {
    const result = parseTextResult(await client.callTool({ name: "spine_render_preview", arguments: { inputPath, settingsPath, outputDir: directory, animation: "walk", frameStart: 2, frameEnd: 4, display: ":42" } }));
    assert.equal(result.frameCount, 1);
    assert.equal(result.source.sourcePath, inputPath);
    assert.match(result.source.sourceHash, /^[0-9a-f]{64}$/);
    assert.equal(result.cli.exitCode, 0);
    const resource = await client.readResource({ uri: result.frames[0].uri });
    assert.equal(resource.contents[0].mimeType, "image/png");
    assert.deepEqual(Buffer.from(resource.contents[0].blob, "base64"), png);
    const sheet = parseTextResult(await client.callTool({ name: "spine_contact_sheet", arguments: { previewId: result.previewId } }));
    assert.deepEqual(sheet.sampledIndices, [0]);
    const sheetResource = await client.readResource({ uri: sheet.contactSheetUri });
    const sheetPng = PNG.sync.read(Buffer.from(sheetResource.contents[0].blob, "base64"));
    assert.equal(sheetPng.width, sheet.width);
    assert.equal(sheetPng.height, sheet.height);
    const analysis = parseTextResult(await client.callTool({ name: "spine_analyze_preview", arguments: { previewId: result.previewId } }));
    assert.equal(analysis.frames[0].visiblePixels, 1);
    assert.deepEqual(analysis.source, result.source);
    assert.deepEqual(analysis.hints, []);
    const combined = parseTextResult(await client.callTool({ name: "spine_check_animation", arguments: {
      path: inputPath, animation: "walk", previewId: result.previewId,
    } }));
    assert.equal(combined.visual.previewId, result.previewId);
    assert.equal(combined.checkedSource.sha256, result.source.sourceHash);
    assert.ok(combined.checksPerformed.includes("blank rendered frames"));
    const motion = parseTextResult(await client.callTool({ name: "spine_analyze_motion_quality", arguments: {
      path: inputPath, animation: "walk", previewId: result.previewId,
    } }));
    assert.equal(motion.previewId, result.previewId);
    const missingPreview = await client.callTool({ name: "spine_analyze_motion_quality", arguments: {
      path: inputPath, animation: "walk", contactRegions: [{ name: "foot", fromFrame: 0,
        toFrame: 1, x: 0, y: 0, width: 1, height: 1, driftThresholdPixels: 2 }],
    } });
    assert.equal(JSON.parse(missingPreview.content[0].text).code, "PREVIEW_REQUIRED");
    const mismatched = await client.callTool({ name: "spine_check_animation", arguments: {
      path: inputPath, animation: "idle", previewId: result.previewId,
    } });
    assert.equal(mismatched.isError, true);
    assert.equal(JSON.parse(mismatched.content[0].text).code, "PREVIEW_ANIMATION_MISMATCH");
    const otherPath = join(directory, "other.json");
    await writeFile(otherPath, JSON.stringify(projectData));
    for (const name of ["spine_check_animation", "spine_analyze_motion_quality"]) {
      const wrongFile = await client.callTool({ name, arguments: {
        path: otherPath, animation: "walk", previewId: result.previewId,
      } });
      assert.equal(wrongFile.isError, true);
      assert.equal(JSON.parse(wrongFile.content[0].text).code, "PREVIEW_SOURCE_MISMATCH");
    }
    projectData.bones[1].length = 42;
    await writeFile(inputPath, JSON.stringify(projectData));
    const changedSource = await client.callTool({ name: "spine_check_animation", arguments: {
      path: inputPath, animation: "walk", previewId: result.previewId,
    } });
    assert.equal(changedSource.isError, true);
    assert.equal(JSON.parse(changedSource.content[0].text).code, "PREVIEW_SOURCE_MISMATCH");
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PNG preview rejects a source changed during rendering", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-preview-source-"));
  const inputPath = join(directory, "rig.json");
  const settingsPath = join(directory, "png.export.json");
  const mockCli = join(directory, "fake-spine");
  const png = solidPng([255, 255, 255, 255]);
  await writeFile(inputPath, JSON.stringify(fixture));
  await writeFile(settingsPath, JSON.stringify({ class: "export-png" }));
  await writeFile(mockCli, `#!/usr/bin/env node\nconst fs=require("node:fs");const path=require("node:path");const args=process.argv.slice(2);const input=args[args.indexOf("--input")+1];const output=args[args.indexOf("--output")+1];fs.appendFileSync(input,"\\n");fs.writeFileSync(path.join(output,"frame.png"),Buffer.from("${png}","base64"));\n`);
  await chmod(mockCli, 0o755);
  const client = await connect({ SPINE_CLI_PATH: mockCli });
  try {
    const result = await client.callTool({ name: "spine_render_preview", arguments: {
      inputPath, settingsPath, outputDir: directory, animation: "walk",
    } });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, "PREVIEW_SOURCE_CHANGED");
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith("spine-preview-")));
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PNG preview reports an unavailable graphics display clearly", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-display-"));
  const mockCli = join(directory, "Spine.sh");
  const inputPath = join(directory, "character.json");
  const settingsPath = join(directory, "preview.export.json");
  await writeFile(inputPath, JSON.stringify(fixture));
  await writeFile(settingsPath, JSON.stringify({ class: "export-png" }));
  await writeFile(mockCli, "#!/usr/bin/env node\nprocess.stdout.write('No X11 DISPLAY variable was set, but this program performed an operation which requires it.\\nERROR: Unable to create the OpenGL display.\\n'); process.exit(1);\n");
  await chmod(mockCli, 0o755);
  const client = await connect({ SPINE_CLI_PATH: mockCli });
  try {
    const result = await client.callTool({ name: "spine_render_preview", arguments: {
      inputPath, settingsPath, outputDir: directory, animation: "walk",
    } });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.content[0].text);
    assert.equal(error.code, "SPINE_DISPLAY_UNAVAILABLE");
    assert.match(error.message, /DISPLAY/);
    assert.equal(error.details.exitCode, 1);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("staged edit renders and compares before/after without changing source", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-compare-"));
  const path = join(directory, "character.json");
  const settingsPath = join(directory, "png.export.json");
  const mockCli = join(directory, "fake-spine");
  const original = JSON.stringify(fixture);
  const beforePngBase64 = solidPng([255, 0, 0, 255]);
  const afterPngBase64 = solidPng([0, 0, 255, 255]);
  await writeFile(path, original);
  await writeFile(settingsPath, JSON.stringify({ class: "export-png" }));
  await writeFile(mockCli, `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst args = process.argv.slice(2);\nconst output = args[args.indexOf("--output") + 1];\nconst input = args[args.indexOf("--input") + 1];\nconst settings = JSON.parse(fs.readFileSync(args[args.indexOf("--export") + 1], "utf8"));\nif (settings.animation !== "walk") process.exit(2);\nconst png = input.includes("-after.json") ? "${afterPngBase64}" : "${beforePngBase64}";\nfor (let i = 0; i < 2; i++) fs.writeFileSync(path.join(output, "frame-" + i + ".png"), Buffer.from(png, "base64"));\n`);
  await chmod(mockCli, 0o755);
  const client = await connect({ SPINE_CLI_PATH: mockCli });
  try {
    const preview = parseTextResult(await client.callTool({ name: "spine_retime_animation", arguments: { path, animation: "walk", scale: 2 } }));
    const staged = parseTextResult(await client.callTool({ name: "spine_render_staged_edit", arguments: { editId: preview.editId, settingsPath, outputDir: directory, animation: "walk" } }));
    assert.equal(staged.frameCount, 2);
    assert.equal(staged.afterHash, preview.afterHash);
    assert.deepEqual(staged.source, { kind: "stage", editId: preview.editId,
      sourcePath: path, afterHash: preview.afterHash });
    const missingEditId = await client.callTool({ name: "spine_check_animation", arguments: {
      path, animation: "walk", previewId: staged.previewId,
    } });
    assert.equal(missingEditId.isError, true);
    assert.equal(JSON.parse(missingEditId.content[0].text).code, "PREVIEW_SOURCE_MISMATCH");
    const stagedCheck = parseTextResult(await client.callTool({ name: "spine_check_animation", arguments: {
      path, animation: "walk", previewId: staged.previewId, editId: preview.editId,
    } }));
    assert.equal(stagedCheck.motionDuration, 1);
    assert.equal(stagedCheck.visual.editId, preview.editId);
    assert.equal(stagedCheck.checkedSource.sha256, preview.afterHash);
    const stagedMotion = parseTextResult(await client.callTool({ name: "spine_analyze_motion_quality", arguments: {
      path, animation: "walk", previewId: staged.previewId, editId: preview.editId,
    } }));
    assert.equal(stagedMotion.motionDuration, 1);
    assert.equal(stagedMotion.checkedSource.editId, preview.editId);
    const comparison = parseTextResult(await client.callTool({ name: "spine_compare_previews", arguments: { editId: preview.editId, settingsPath, outputDir: directory, animation: "walk", samples: 2 } }));
    assert.ok(comparison.beforePreviewId);
    assert.ok(comparison.afterPreviewId);
    const beforeCheck = parseTextResult(await client.callTool({ name: "spine_check_animation", arguments: {
      path, animation: "walk", previewId: comparison.beforePreviewId,
    } }));
    assert.equal(beforeCheck.motionDuration, 0.5);
    assert.equal(comparison.pairs.length, 2);
    assert.equal(comparison.pairs[0].progress, 0);
    assert.equal(comparison.pairs[1].progress, 1);
    assert.equal(comparison.pairs[0].meanAbsoluteDifference, 0.666667);
    assert.equal(comparison.pairs[0].changedPixelPercent, 100);
    const frame = await client.readResource({ uri: comparison.pairs[1].after.uri });
    assert.equal(frame.contents[0].mimeType, "image/png");
    const pairImage = await client.readResource({ uri: comparison.pairs[0].sideBySideUri });
    const pairedPng = PNG.sync.read(Buffer.from(pairImage.contents[0].blob, "base64"));
    assert.equal(pairedPng.width, 6);
    assert.deepEqual([...pairedPng.data.subarray(0, 4)], [255, 0, 0, 255]);
    assert.deepEqual([...pairedPng.data.subarray(20, 24)], [0, 0, 255, 255]);
    const sheet = await client.readResource({ uri: comparison.contactSheetUri });
    const sheetPng = PNG.sync.read(Buffer.from(sheet.contents[0].blob, "base64"));
    assert.equal(sheetPng.width, comparison.contactSheetWidth);
    assert.equal(sheetPng.height, comparison.contactSheetHeight);
    assert.ok(sheetPng.height > pairedPng.height);
    assert.equal(await readFile(path, "utf8"), original);
    assert.ok(!(await readdir(directory)).some((name) => name.includes("-before.json") || name.includes("-after.json")));
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI project info, nonessential JSON export, and safe import", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-roundtrip-"));
  const mockCli = join(directory, "fake-spine");
  const dataPath = join(directory, "character.json");
  const settingsPath = join(directory, "json.export.json");
  const outputProjectPath = join(directory, "imported.spine");
  await writeFile(dataPath, JSON.stringify(fixture));
  await writeFile(settingsPath, JSON.stringify({ class: "export-json", nonessential: true }));
  await writeFile(mockCli, `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst args = process.argv.slice(2);\nif (args[0] !== "--update" || args[1] !== "4.3.xx") process.exit(4);\nconst input = args[args.indexOf("--input") + 1];\nconst output = args[args.indexOf("--output") + 1];\nif (args.includes("--import")) fs.writeFileSync(output, "fake Spine project");\nelse if (args.includes("--export")) { const settings = JSON.parse(fs.readFileSync(args[args.indexOf("--export") + 1], "utf8")); if (settings.class !== "export-json" || settings.nonessential !== true) process.exit(5); fs.copyFileSync(input, path.join(output, "character.json")); }\nelse console.log("Licensed to: Test Person <test@example.com>\\nProject: character; animations: walk");\n`);
  await chmod(mockCli, 0o755);
  const client = await connect({ SPINE_CLI_PATH: mockCli });
  try {
    const info = parseTextResult(await client.callTool({ name: "spine_project_info", arguments: { inputPath: dataPath, editorVersion: "4.3.xx" } }));
    assert.match(info.stdout, /animations: walk/);
    assert.doesNotMatch(info.stdout, /Test Person|test@example.com/);
    const exported = parseTextResult(await client.callTool({ name: "spine_export_data", arguments: { projectPath: dataPath, settingsPath, outputDir: directory, editorVersion: "4.3.xx" } }));
    assert.equal(exported.files.length, 1);
    assert.deepEqual(JSON.parse(await readFile(exported.files[0], "utf8")), fixture);
    const imported = parseTextResult(await client.callTool({ name: "spine_import_data", arguments: { dataPath, outputProjectPath, editorVersion: "4.3.xx" } }));
    assert.equal(imported.outputProjectPath, outputProjectPath);
    assert.equal(await readFile(outputProjectPath, "utf8"), "fake Spine project");
    const duplicate = await client.callTool({ name: "spine_import_data", arguments: { dataPath, outputProjectPath, editorVersion: "4.3.xx" } });
    assert.equal(duplicate.isError, true);
    assert.equal(parseTextResult({ ...duplicate, isError: undefined }).code, "OUTPUT_EXISTS");
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("staged edit detects source changes and rejects unsafe versions", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-"));
  const path = join(directory, "character.json");
  await writeFile(path, JSON.stringify(fixture));
  const client = await connect();
  try {
    const preview = parseTextResult(await client.callTool({ name: "spine_preview_edit", arguments: { path, operations: [{ kind: "retime_animation", animation: "walk", scale: 0.5 }] } }));
    await writeFile(path, `${JSON.stringify(fixture)}\n`);
    const changed = await client.callTool({ name: "spine_commit_edit", arguments: { editId: preview.editId } });
    assert.equal(changed.isError, true);
    assert.equal(parseTextResult({ ...changed, isError: undefined }).code, "SOURCE_CHANGED");

    const unsupported = structuredClone(fixture);
    unsupported.skeleton.spine = "4.1.99";
    await writeFile(path, JSON.stringify(unsupported));
    const rejected = await client.callTool({ name: "spine_retime_animation", arguments: { path, animation: "walk", scale: 2 } });
    assert.equal(rejected.isError, true);
    assert.equal(parseTextResult({ ...rejected, isError: undefined }).code, "UNSUPPORTED_VERSION");
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("function document covers each catalog entry exactly once", async () => {
  const markdown = await readFile(new URL("../FUNCTIONS.md", import.meta.url), "utf8");
  const documented = [...markdown.matchAll(/^\| `(spine_[a-z_]+)` \|/gm)].map((match) => match[1]);
  assert.deepEqual(documented.sort(), TOOL_CATALOG.map((tool) => tool.name).sort());
});

test("MCP saves and inspects an export profile through its public schema", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-profile-"));
  const settingsPath = join(directory, "data.export.json");
  await writeFile(settingsPath, JSON.stringify({ class: "export-json", nonessential: true }));
  const client = await connect();
  try {
    const saved = parseTextResult(await client.callTool({ name: "spine_manage_export_profile", arguments: {
      workspaceDir: directory, action: "save", name: "release", editorVersion: "4.3",
      runtimeVersion: "4.3", settingsPaths: { data: settingsPath },
    } }));
    assert.deepEqual(saved.steps, ["data"]);
    const listed = parseTextResult(await client.callTool({ name: "spine_manage_export_profile", arguments: {
      workspaceDir: directory, action: "list",
    } }));
    assert.equal(listed.profiles[0].name, "release");
    const loaded = parseTextResult(await client.callTool({ name: "spine_manage_export_profile", arguments: {
      workspaceDir: directory, action: "get", name: "release",
    } }));
    assert.equal(loaded.settings.data.nonessential, true);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP starts and reports a staged batch through its public schema", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-batch-"));
  const path = join(directory, "rig.json");
  await writeFile(path, JSON.stringify(fixture));
  const client = await connect();
  try {
    const started = parseTextResult(await client.callTool({ name: "spine_batch_job", arguments: {
      action: "start", targets: [{ path, animations: ["walk"] }],
      operation: { kind: "retime_animation", scale: 2 },
    } }));
    assert.match(started.jobId, /^[0-9a-f-]{36}$/);
    let status = started;
    for (let attempt = 0; attempt < 50 && status.status === "running"; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
      status = parseTextResult(await client.callTool({ name: "spine_batch_job", arguments: {
        action: "status", jobId: started.jobId,
      } }));
    }
    assert.equal(status.status, "completed");
    assert.equal(status.items[0].status, "staged");
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations.walk.bones.arm.rotate[1].time, 0.5);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP stages a generated motion clip through its public recipe schema", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-motion-"));
  const path = join(directory, "rig.json");
  const original = JSON.stringify(fixture);
  await writeFile(path, original);
  const client = await connect();
  try {
    const staged = parseTextResult(await client.callTool({ name: "spine_generate_motion", arguments: {
      path, newAnimation: "hit", recipe: { type: "recoil", bone: "arm", duration: 0.6,
        angleDegrees: -30 },
    } }));
    assert.equal(staged.motion.recipe, "recoil");
    assert.equal(staged.motion.timelines, 1);
    assert.equal(staged.structuralReview.animation, "hit");
    assert.ok(staged.reviewNext.some((step) => step.includes("spine_render_staged_edit")));
    assert.deepEqual(staged.diagnostics, []);
    assert.equal(await readFile(path, "utf8"), original);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP saves and stages a bone and slot pose through its public schema", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-full-pose-"));
  const path = join(directory, "rig.json");
  await writeFile(path, JSON.stringify(fixture));
  const client = await connect();
  try {
    const saved = parseTextResult(await client.callTool({ name: "spine_save_pose", arguments: {
      path, animation: "walk", time: 0.25, name: "step-pose",
    } }));
    assert.equal(saved.boneChannels, 1);
    assert.equal(saved.slots[0].slot, "hand");
    const resource = await client.readResource({ uri: saved.poseResourceUri });
    assert.equal(JSON.parse(resource.contents[0].text).name, "step-pose");
    const staged = parseTextResult(await client.callTool({ name: "spine_apply_pose", arguments: {
      poseId: saved.poseId, path, animation: "posed", time: 0.5,
    } }));
    assert.equal(staged.pose.slotsApplied, 1);
    assert.deepEqual(staged.diagnostics, []);
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations.posed, undefined);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP saves a mesh pose resource and stages its deform key", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-mesh-pose-"));
  const path = join(directory, "rig.json");
  const data = structuredClone(fixture);
  data.skins[0].attachments.hand.sheet = { type: "mesh", uvs: [0, 0, 1, 0, 1, 1],
    triangles: [0, 1, 2], vertices: [0, 0, 10, 0, 10, 10], hull: 3 };
  data.animations.walk.attachments = { default: { hand: { sheet: { deform: [
    { time: 0, offset: 2, vertices: [2, 4] },
  ] } } } };
  await writeFile(path, JSON.stringify(data));
  const client = await connect();
  try {
    const saved = parseTextResult(await client.callTool({ name: "spine_save_mesh_pose", arguments: {
      path, animation: "walk", time: 0, name: "sheet-pose",
    } }));
    assert.equal(saved.meshCount, 1);
    const resource = await client.readResource({ uri: saved.poseResourceUri });
    assert.deepEqual(JSON.parse(resource.contents[0].text).entries[0].values, [0, 0, 2, 4, 0, 0]);
    const staged = parseTextResult(await client.callTool({ name: "spine_apply_mesh_pose", arguments: {
      poseId: saved.poseId, path, animation: "posed", time: 0.5,
    } }));
    assert.equal(staged.pose.meshCount, 1);
    assert.deepEqual(staged.diagnostics, []);
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations.posed, undefined);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP restarts can read and commit a durable staged edit", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-stage-restart-"));
  const path = join(directory, "rig.json");
  await writeFile(path, JSON.stringify(fixture));
  const env = { SPINE_MCP_STATE_DIR: join(directory, "state") };
  let first = await connect(env);
  try {
    const stage = parseTextResult(await first.callTool({ name: "spine_retime_animation", arguments: {
      path, animation: "walk", scale: 2, requestId: "restart-test",
    } }));
    await first.close();
    first = await connect(env);
    const diff = await first.readResource({ uri: stage.diffResourceUri });
    assert.equal(JSON.parse(diff.contents[0].text).editId, stage.editId);
    const committed = parseTextResult(await first.callTool({ name: "spine_commit_edit", arguments: { editId: stage.editId } }));
    assert.equal(JSON.parse(await readFile(committed.manifestPath, "utf8")).status, "committed");
  } finally {
    await first.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP creates an interactive Web Player HTML resource", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-player-"));
  const skeletonPath = join(directory, "rig.json");
  const atlasPath = join(directory, "rig.atlas");
  await writeFile(skeletonPath, JSON.stringify(fixture));
  await writeFile(atlasPath, "rig.png\nsize: 1, 1\n");
  await writeFile(join(directory, "rig.png"), Buffer.from(solidPng([255, 255, 255, 255]), "base64"));
  const client = await connect();
  try {
    const preview = parseTextResult(await client.callTool({ name: "spine_web_player_preview", arguments: {
      skeletonPath, atlasPath, outputDir: join(directory, "player"), animation: "walk", debugBones: true,
    } }));
    assert.equal(preview.playerVersion, "4.3");
    assert.deepEqual(preview.atlasPages, ["rig.png"]);
    const resource = await client.readResource({ uri: preview.playerUri });
    assert.match(resource.contents[0].text, /new spine\.SpinePlayer/);
    assert.equal(resource.contents[0].text, await readFile(preview.htmlPath, "utf8"));
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP reviews visible foot drift from a rendered two-frame contact interval", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mcp-contact-"));
  const mockCli = join(directory, "Spine.sh");
  const settingsPath = join(directory, "png.export.json");
  const inputPath = join(directory, "rig.json");
  const frames = [];
  for (const footX of [1, 4]) {
    const png = new PNG({ width: 8, height: 8 });
    for (let y = 4; y < 6; y += 1) {
      for (let x = footX; x < footX + 2; x += 1) {
        png.data.set([255, 255, 255, 255], (y * 8 + x) * 4);
      }
    }
    frames.push(PNG.sync.write(png).toString("base64"));
  }
  await writeFile(inputPath, JSON.stringify(fixture));
  await writeFile(settingsPath, JSON.stringify({ class: "export-png", animationType: "all", fps: 30 }));
  await writeFile(mockCli, `#!/usr/bin/env node\nconst fs=require("node:fs");const path=require("node:path");const args=process.argv.slice(2);const out=args[args.indexOf("--output")+1];fs.writeFileSync(path.join(out,"walk-0000.png"),Buffer.from("${frames[0]}","base64"));fs.writeFileSync(path.join(out,"walk-0001.png"),Buffer.from("${frames[1]}","base64"));\n`);
  await chmod(mockCli, 0o755);
  const client = await connect({ SPINE_CLI_PATH: directory });
  try {
    const preview = parseTextResult(await client.callTool({ name: "spine_render_preview", arguments: {
      inputPath, settingsPath, outputDir: directory, animation: "walk",
    } }));
    assert.equal(preview.frameCount, 2);
    const result = parseTextResult(await client.callTool({ name: "spine_analyze_motion_quality", arguments: {
      path: inputPath, animation: "walk", previewId: preview.previewId,
      contactRegions: [{ name: "leftFoot", fromFrame: 0, toFrame: 1,
        x: 0, y: 0.25, width: 1, height: 0.75, driftThresholdPixels: 1 }],
    } }));
    assert.equal(result.contact.regions[0].maxDriftPixels, 3);
    assert.ok(result.hints.some((hint) => hint.code === "POSSIBLE_FOOT_SLIDE"));
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
