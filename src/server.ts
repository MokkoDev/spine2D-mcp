import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_AREAS,
  TOOL_CATALOG,
  TOOL_NAMES,
} from "./catalog.js";
import { parseDocument, readDocument } from "./spine/document.js";
import { createProject, createSkeletonData } from "./spine/create.js";
import { inspectAssets } from "./spine/assets.js";
import { BatchJobStore } from "./spine/batch.js";
import { analyzeFootContacts } from "./spine/contact.js";
import { cleanupAnimations, exportData, exportMedia, findSpineCli, importData, packAtlas, projectInfo, renderPreview, unpackAtlas } from "./spine/cli.js";
import { EditStore } from "./spine/edit.js";
import { SpineError } from "./spine/errors.js";
import { applyPoseOperations, capturePose, type SavedPose } from "./spine/full-pose.js";
import { applyMeshPoseOperations, captureMeshPose, type SavedMeshPose } from "./spine/mesh-pose.js";
import { buildMotionOperations } from "./spine/motion.js";
import { createPlayerPreview } from "./spine/player.js";
import { roundTripEdit } from "./spine/roundtrip.js";
import { inspectAnimation, inspectProject, projectEntries, referenceGraph, searchProject } from "./spine/inspect.js";
import { captureBonePose, poseApplyOperations, type SavedBonePose } from "./spine/pose.js";
import { deleteExportProfile, getExportProfile, listExportProfiles, runExportProfile, saveExportProfile } from "./spine/profile.js";
import { analyzePreview, checkAnimation } from "./spine/quality.js";
import { validateDocument } from "./spine/validate.js";
import { createFrameContactSheet, createVisualComparison } from "./spine/visual.js";
import { SERVER_INSTRUCTIONS, workflowGuide } from "./workflow-guide.js";

function jsonResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

async function runTool(action: () => Promise<Record<string, unknown>>) {
  try {
    return jsonResult(await action());
  } catch (error) {
    const issue = error instanceof SpineError
      ? error
      : new SpineError("INTERNAL_ERROR", "The operation failed unexpectedly.");
    if (!(error instanceof SpineError)) console.error(error);
    return {
      ...jsonResult({ code: issue.code, message: issue.message, ...(issue.details === undefined ? {} : { details: issue.details }) }),
      isError: true,
    };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  }, { instructions: SERVER_INSTRUCTIONS });
  const edits = new EditStore();
  const batches = new BatchJobStore(edits);
  type PreviewSource = { kind: "file"; sourcePath: string; sourceHash: string }
    | { kind: "derived"; sourcePath: string; sourceHash: string; renderPath: string; renderHash: string }
    | { kind: "stage"; editId: string; sourcePath: string; afterHash: string };
  type PreviewEntry = { frames: string[]; animation?: string; source?: PreviewSource };
  const previews = new Map<string, PreviewEntry>();
  const inventories = new Map<string, Record<string, unknown>>();
  const poses = new Map<string, SavedBonePose>();
  const fullPoses = new Map<string, SavedPose>();
  const meshPoses = new Map<string, SavedMeshPose>();
  const players = new Map<string, string>();

  async function hashFile(path: string): Promise<string> {
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch { throw new SpineError("INPUT_NOT_FOUND", `Preview input cannot be read: ${path}.`); }
    return createHash("sha256").update(bytes).digest("hex");
  }

  async function verifyRenderedInput(result: Awaited<ReturnType<typeof renderPreview>>,
    sourcePath: string, sourceHash: string): Promise<void> {
    const actualHash = await hashFile(sourcePath).catch(() => undefined);
    if (actualHash === sourceHash) return;
    await rm(result.previewDir, { recursive: true, force: true }).catch(() => undefined);
    throw new SpineError("PREVIEW_SOURCE_CHANGED", "The preview input changed while Spine rendered it.", { sourcePath });
  }

  function publishFrames(paths: string[], animation?: string, source?: PreviewSource): string {
    const previewId = randomUUID();
    previews.set(previewId, { frames: paths, animation, source });
    if (previews.size > 20) {
      const expired = previews.keys().next().value!;
      previews.delete(expired);
    }
    return previewId;
  }

  function publishPreview(result: Awaited<ReturnType<typeof renderPreview>>, source: PreviewSource) {
    const previewId = publishFrames(result.frames.map((frame) => frame.path), result.animation, source);
    return {
      previewId,
      animation: result.animation,
      source,
      previewDir: result.previewDir,
      frameCount: result.frames.length,
      frames: result.frames.slice(0, 100).map((frame, index) => ({ name: frame.name, uri: `spine-preview://${previewId}/${index}` })),
      framesTruncated: result.frames.length > 100,
      cli: { executable: result.cli.executable, exitCode: result.cli.exitCode, stdout: result.cli.stdout.slice(0, 4000), stderr: result.cli.stderr.slice(0, 4000) },
    };
  }

  async function previewForCheck(path: string, animation: string, previewId?: string, editId?: string) {
    const snapshot = editId ? edits.snapshot(editId) : undefined;
    if (snapshot && resolve(path) !== snapshot.sourcePath) {
      throw new SpineError("PREVIEW_SOURCE_MISMATCH", "The supplied path is not the staged edit's source path.",
        { sourcePath: snapshot.sourcePath, suppliedPath: resolve(path), editId });
    }
    const document = snapshot ? parseDocument(snapshot.sourcePath, snapshot.afterText) : await readDocument(path);
    if (!previewId) return { document, frames: undefined };
    const preview = previews.get(previewId);
    if (!preview?.animation) throw new SpineError("PREVIEW_NOT_FOUND", `Preview ${previewId} is unavailable as a rendered animation in this server session.`);
    if (preview.animation !== animation) {
      throw new SpineError("PREVIEW_ANIMATION_MISMATCH", `Preview ${previewId} was not rendered for animation ${animation}.`);
    }
    const source = preview.source;
    const matchesFile = !snapshot && (source?.kind === "file" || source?.kind === "derived")
      && source.sourcePath === document.path && source.sourceHash === document.hash;
    const matchesStage = source?.kind === "stage" && source.sourcePath === document.path
      && source.afterHash === document.hash && (!snapshot || source.editId === editId);
    if (!matchesFile && !matchesStage) {
      throw new SpineError("PREVIEW_SOURCE_MISMATCH",
        "The preview was rendered from a different skeleton or version. Use its source JSON or supply the matching staged editId.",
        { previewId, source, suppliedPath: document.path, suppliedHash: document.hash, ...(editId ? { editId } : {}) });
    }
    return { document, frames: preview.frames };
  }

  async function withStageFiles<T>(editId: string, action: (beforePath: string, afterPath: string, snapshot: ReturnType<EditStore["snapshot"]>) => Promise<T>): Promise<T> {
    const snapshot = edits.snapshot(editId);
    const folder = dirname(snapshot.sourcePath);
    const name = basename(snapshot.sourcePath, ".json");
    const unique = randomUUID();
    const beforePath = join(folder, `.${name}-${unique}-before.json`);
    const afterPath = join(folder, `.${name}-${unique}-after.json`);
    try {
      await writeFile(beforePath, snapshot.beforeText, { flag: "wx" });
      await writeFile(afterPath, snapshot.afterText, { flag: "wx" });
      return await action(beforePath, afterPath, snapshot);
    } finally {
      await Promise.all([rm(beforePath, { force: true }), rm(afterPath, { force: true })]);
    }
  }

  server.registerTool(
    TOOL_NAMES.status,
    {
      description: "Report Spine2D MCP server health and integration state.",
      inputSchema: z.object({}),
    },
    async () => {
      let cli: { available: boolean; executable?: string } = { available: false };
      try { cli = { available: true, executable: await findSpineCli() }; } catch { /* Optional CLI. */ }
      return jsonResult({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        transport: "stdio",
        spineIntegration: "json+cli",
        cli,
        supportedSpineVersions: ["4.2", "4.3"],
      });
    },
  );

  server.registerTool(
    TOOL_NAMES.workflowGuide,
    { description: "Start here when a Spine task could use several tools. Choose by source and outcome; get the recommended entry tools and steps.",
      inputSchema: z.object({ goal: z.enum(["choose", "inspect", "create_project", "round_trip", "new_motion", "edit_json", "reuse_pose", "review_motion", "batch_export"]).optional() }) },
    async ({ goal }) => runTool(async () => workflowGuide(goal)),
  );

  server.registerTool(
    TOOL_NAMES.capabilities,
    {
      description: "Find specialized Spine tools by category or search term. Use spine_workflow_guide for an end-to-end task.",
      inputSchema: z.object({ area: z.enum(TOOL_AREAS).optional(),
        query: z.string().trim().min(1).max(100).optional(), status: z.enum(["implemented", "planned"]).optional() }),
    },
    async ({ area, query, status }) => {
      const needle = query?.toLowerCase();
      const tools = TOOL_CATALOG.filter((tool) => (!area || tool.area === area)
        && (!status || tool.status === status)
        && (!needle || `${tool.name} ${tool.purpose} ${tool.area}`.toLowerCase().includes(needle)));
      return jsonResult({ tools, areas: TOOL_AREAS.map((name) => ({ name,
        count: TOOL_CATALOG.filter((tool) => tool.area === name && tool.status === "implemented").length })) });
    },
  );

  server.registerTool(
    "spine_inspect_project",
    {
      description: "Summarize the bones, slots, skins, attachments, constraints, events, assets, and timelines in a Spine JSON export.",
      inputSchema: z.object({ path: z.string().min(1), maxItems: z.number().int().min(1).max(100).optional() }),
    },
    async ({ path, maxItems }) => runTool(async () => {
      const document = await readDocument(path);
      const inventoryId = randomUUID();
      const inventory = { path: document.path, sourceHash: document.hash, entries: projectEntries(document) };
      inventories.set(inventoryId, inventory);
      if (inventories.size > 20) inventories.delete(inventories.keys().next().value!);
      return { ...inspectProject(document, maxItems), inventoryResourceUri: `spine-project://${inventoryId}/inventory` };
    }),
  );

  server.registerTool(
    "spine_search_project",
    {
      description: "Search named elements and assets in a Spine JSON export without returning the entire file.",
      inputSchema: z.object({
        path: z.string().min(1),
        query: z.string().min(1),
        kind: z.enum(["bone", "slot", "skin", "attachment", "constraint", "event", "animation", "timeline", "asset"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
    async ({ path, query, kind, limit }) => runTool(async () => searchProject(await readDocument(path), query, kind, limit)),
  );

  server.registerTool(
    "spine_reference_graph",
    {
      description: "Find known Spine 4.2 and 4.3 JSON references to a named element before editing it.",
      inputSchema: z.object({
        path: z.string().min(1),
        kind: z.enum(["bone", "slot", "skin", "attachment", "constraint", "event", "animation"]),
        name: z.string().min(1),
      }),
    },
    async ({ path, kind, name }) => runTool(async () => referenceGraph(await readDocument(path), kind, name)),
  );

  server.registerTool(
    "spine_inspect_animation",
    {
      description: "Inspect animation timelines and keys, optionally within a time range.",
      inputSchema: z.object({
        path: z.string().min(1),
        animation: z.string().min(1),
        from: z.number().finite().nonnegative().optional(),
        to: z.number().finite().nonnegative().optional(),
        maxKeys: z.number().int().min(0).max(200).optional(),
        target: z.string().min(1).optional(),
        maxTimelines: z.number().int().min(1).max(200).optional(),
      }),
    },
    async ({ path, animation, from, to, maxKeys, target, maxTimelines }) => runTool(async () => {
      if (from !== undefined && to !== undefined && to < from) throw new SpineError("INVALID_RANGE", "to must be greater than or equal to from.");
      return inspectAnimation(await readDocument(path), animation, from, to, maxKeys, target, maxTimelines);
    }),
  );

  const previewAnalysisOptions = {
    maxFrames: z.number().int().min(1).max(60).optional(),
    alphaThreshold: z.number().int().min(1).max(255).optional(),
    areaJumpRatio: z.number().finite().gt(1).optional(),
    fixedCanvas: z.boolean().optional(),
    edgeMargin: z.number().int().min(0).max(32).optional(),
  };

  server.registerTool(
    "spine_check_animation",
    {
      description: "Review one animation's timeline structure; optionally combine it with an existing previewId. Use spine_analyze_motion_quality for foot contact regions.",
      inputSchema: z.object({
        path: z.string().min(1),
        animation: z.string().min(1),
        loop: z.boolean().optional(),
        loopTolerance: z.number().finite().nonnegative().optional(),
        flashSeconds: z.number().finite().positive().optional(),
        deformThreshold: z.number().finite().positive().optional(),
        checkAssets: z.boolean().optional(),
        previewId: z.uuid().optional(),
        editId: z.uuid().optional(),
        ...previewAnalysisOptions,
      }),
    },
    async ({ path, animation, previewId, editId, maxFrames, alphaThreshold, areaJumpRatio, fixedCanvas, edgeMargin, ...options }) => runTool(async () => {
      const { document, frames } = await previewForCheck(path, animation, previewId, editId);
      const structural = await checkAnimation(document, animation, options);
      if (!previewId) return structural;
      const visual = await analyzePreview(frames!, { maxFrames, alphaThreshold, areaJumpRatio, fixedCanvas, edgeMargin });
      return { ...structural, checkedSource: { path: document.path, sha256: document.hash,
        ...(editId ? { editId } : {}) },
        checksPerformed: [...structural.checksPerformed, ...visual.checksPerformed],
        hints: [...structural.hints, ...visual.hints], visual: { previewId, ...(editId ? { editId } : {}), ...visual } };
    }),
  );

  server.registerTool(
    TOOL_NAMES.analyzeMotionQuality,
    {
      description: "Review one animation and measure visible foot drift in selected contact regions of a rendered preview. Use spine_check_animation for structural checks alone.",
      inputSchema: z.object({ path: z.string().min(1), animation: z.string().min(1),
        loop: z.boolean().optional(), deformThreshold: z.number().finite().positive().optional(),
        checkAssets: z.boolean().optional(), previewId: z.uuid().optional(), editId: z.uuid().optional(),
        contactRegions: z.array(z.object({ name: z.string().min(1),
          fromFrame: z.number().int().nonnegative(), toFrame: z.number().int().nonnegative(),
          x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
          width: z.number().finite().gt(0).max(1), height: z.number().finite().gt(0).max(1),
          driftThresholdPixels: z.number().finite().positive() })).min(1).max(8).optional(),
        alphaThreshold: z.number().int().min(1).max(255).optional(),
        minimumVisiblePixels: z.number().int().min(1).max(10000).optional() }),
    },
    async ({ path, animation, previewId, editId, contactRegions, alphaThreshold, minimumVisiblePixels, ...options }) => runTool(async () => {
      if (contactRegions && !previewId) {
        throw new SpineError("PREVIEW_REQUIRED", "Contact regions require a rendered previewId.");
      }
      const { document, frames } = await previewForCheck(path, animation, previewId, editId);
      const structural = await checkAnimation(document, animation, options);
      if (!previewId) return structural;
      const checkedSource = { path: document.path, sha256: document.hash, ...(editId ? { editId } : {}) };
      if (!contactRegions) return { ...structural, previewId, checkedSource };
      const contact = await analyzeFootContacts(frames!, contactRegions, { alphaThreshold, minimumVisiblePixels });
      return { ...structural,
        checkedSource,
        checksPerformed: [...structural.checksPerformed, "visible foot drift in selected contact regions"],
        checksUnavailable: structural.checksUnavailable.filter((check) => check !== "foot sliding"),
        hints: [...structural.hints, ...contact.hints],
        contact: { previewId, frameCount: contact.frameCount, alphaThreshold: contact.alphaThreshold,
          minimumVisiblePixels: contact.minimumVisiblePixels, regions: contact.contacts } };
    }),
  );

  server.registerTool(
    "spine_analyze_preview",
    {
      description: "Analyze an existing previewId's PNG frames for blanks and visible-area changes. Use spine_check_animation to combine this with timeline diagnostics.",
      inputSchema: z.object({ previewId: z.uuid(), ...previewAnalysisOptions }),
    },
    async ({ previewId, ...options }) => runTool(async () => {
      const preview = previews.get(previewId);
      if (!preview) throw new SpineError("PREVIEW_NOT_FOUND", `Preview ${previewId} is unavailable in this server session.`);
      return { previewId, ...(preview.source ? { source: preview.source } : {}),
        ...await analyzePreview(preview.frames, options) };
    }),
  );

  server.registerTool(
    "spine_validate_data",
    {
      description: "Validate Spine JSON structure, references, animation keys, mesh data, and optionally image paths.",
      inputSchema: z.object({ path: z.string().min(1), checkAssets: z.boolean().optional() }),
    },
    async ({ path, checkAssets }) => runTool(async () => {
      const document = await readDocument(path);
      const diagnostics = validateDocument(document, checkAssets);
      return { path: document.path, version: document.version, sourceHash: document.hash, valid: !diagnostics.some((item) => item.severity === "error"), diagnostics };
    }),
  );

  server.registerTool(
    "spine_inspect_assets",
    {
      description: "List referenced, missing, and unused images and check texture atlas page files.",
      inputSchema: z.object({
        path: z.string().min(1),
        imagesDir: z.string().min(1).optional(),
        atlasPath: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    },
    async ({ path, imagesDir, atlasPath, limit }) => runTool(async () => inspectAssets(await readDocument(path), imagesDir, atlasPath, limit)),
  );

  server.registerTool(
    "spine_project_info",
    {
      description: "Read Spine CLI project or exported data information.",
      inputSchema: z.object({ inputPath: z.string().min(1), editorVersion: z.string().min(1).optional(), timeoutMs: z.number().int().min(1_000).max(600_000).optional() }),
    },
    async ({ inputPath, editorVersion, timeoutMs }) => runTool(async () => ({ ...(await projectInfo(inputPath, editorVersion, timeoutMs)) })),
  );

  const createOptions = {
    rootBoneName: z.string().min(1).optional(),
    fps: z.number().int().min(1).max(240).optional(),
    imagesPath: z.string().min(1).optional(),
    audioPath: z.string().min(1).optional(),
  };

  server.registerTool(
    "spine_create_skeleton",
    {
      description: "Create new minimal Spine 4.2 or 4.3 skeleton JSON with a root bone and default skin; never overwrite a file.",
      inputSchema: z.object({ dataPath: z.string().min(1), version: z.string().min(1), ...createOptions }),
    },
    async ({ dataPath, version, ...options }) => runTool(async () => ({ ...(await createSkeletonData(dataPath, version, options)) })),
  );

  server.registerTool(
    "spine_create_project",
    {
      description: "Create minimal skeleton JSON and import it into a new .spine project with the licensed Spine CLI; never overwrite outputs.",
      inputSchema: z.object({
        outputProjectPath: z.string().min(1), dataPath: z.string().min(1).optional(),
        editorVersion: z.enum(["4.2", "4.3"]), spineVersion: z.string().min(1).optional(),
        skeletonName: z.string().min(1).optional(), timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
        ...createOptions,
      }),
    },
    async (input) => runTool(async () => {
      const result = await createProject(input);
      return { dataPath: result.dataPath, outputProjectPath: result.outputProjectPath, sourceHash: result.sourceHash,
        version: result.version, skeletonName: result.skeletonName, rootBoneName: result.rootBoneName,
        cli: { executable: result.cli.executable, exitCode: result.cli.exitCode,
          stdout: result.cli.stdout.slice(0, 4000), stderr: result.cli.stderr.slice(0, 4000) } };
    }),
  );

  server.registerTool(
    "spine_export_data",
    {
      description: "Export an existing .spine project to reimportable JSON using saved settings. Use spine_export_media for images or video.",
      inputSchema: z.object({ projectPath: z.string().min(1), settingsPath: z.string().min(1), outputDir: z.string().min(1), editorVersion: z.string().min(1), timeoutMs: z.number().int().min(1_000).max(600_000).optional() }),
    },
    async ({ projectPath, settingsPath, outputDir, editorVersion, timeoutMs }) => runTool(async () => {
      const result = await exportData(projectPath, settingsPath, outputDir, editorVersion, timeoutMs);
      return { inputPath: result.inputPath, exportDir: result.exportDir, files: result.files, cli: { executable: result.cli.executable, exitCode: result.cli.exitCode, stdout: result.cli.stdout.slice(0, 4000), stderr: result.cli.stderr.slice(0, 4000) } };
    }),
  );

  server.registerTool(
    "spine_export_media",
    {
      description: "Export images or video from a Spine project or data file using saved settings. Use spine_export_data for reimportable skeleton JSON; rendering needs a display and OpenGL.",
      inputSchema: z.object({ inputPath: z.string().min(1), settingsPath: z.string().min(1), outputDir: z.string().min(1),
        editorVersion: z.enum(["4.2", "4.3"]), fileName: z.string().min(1).optional(),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional() }),
    },
    async ({ inputPath, settingsPath, outputDir, editorVersion, fileName, timeoutMs }) => runTool(async () => {
      const result = await exportMedia(inputPath, settingsPath, outputDir, editorVersion, fileName, timeoutMs);
      return { inputPath: result.inputPath, settingsPath: result.settingsPath,
        mediaClass: result.mediaClass, mediaDir: result.mediaDir, files: result.files,
        cli: { executable: result.cli.executable, exitCode: result.cli.exitCode,
          stdout: result.cli.stdout.slice(0, 4000), stderr: result.cli.stderr.slice(0, 4000) } };
    }),
  );

  server.registerTool(
    "spine_import_data",
    {
      description: "Validate Spine 4.2 or 4.3 JSON and import it into a new .spine project without overwriting an existing file.",
      inputSchema: z.object({ dataPath: z.string().min(1), outputProjectPath: z.string().min(1), editorVersion: z.string().min(1), skeletonName: z.string().min(1).optional(), timeoutMs: z.number().int().min(1_000).max(600_000).optional() }),
    },
    async ({ dataPath, outputProjectPath, editorVersion, skeletonName, timeoutMs }) => runTool(async () => {
      const result = await importData(dataPath, outputProjectPath, skeletonName, editorVersion, timeoutMs);
      return { dataPath: result.dataPath, outputProjectPath: result.outputProjectPath, sourceHash: result.sourceHash, cli: { executable: result.cli.executable, exitCode: result.cli.exitCode, stdout: result.cli.stdout.slice(0, 4000), stderr: result.cli.stderr.slice(0, 4000) } };
    }),
  );

  server.registerTool(
    "spine_cleanup_animations",
    {
      description: "Run Spine animation cleanup on a sibling copy and save the result as a new .spine project.",
      inputSchema: z.object({ projectPath: z.string().min(1), outputProjectPath: z.string().min(1),
        editorVersion: z.enum(["4.2", "4.3"]), timeoutMs: z.number().int().min(1_000).max(600_000).optional() }),
    },
    async ({ projectPath, outputProjectPath, editorVersion, timeoutMs }) => runTool(async () => {
      const result = await cleanupAnimations(projectPath, outputProjectPath, editorVersion, timeoutMs);
      return { projectPath: result.projectPath, outputProjectPath: result.outputProjectPath,
        sourceHash: result.sourceHash, outputHash: result.outputHash, changed: result.changed,
        cli: { executable: result.cli.executable, exitCode: result.cli.exitCode,
          stdout: result.cli.stdout.slice(0, 4000), stderr: result.cli.stderr.slice(0, 4000) } };
    }),
  );

  server.registerTool(
    "spine_pack_atlas",
    {
      description: "Pack PNG images into a new Spine atlas directory with default or saved pack settings.",
      inputSchema: z.object({ imagesDir: z.string().min(1), outputDir: z.string().min(1),
        name: z.string().min(1), editorVersion: z.enum(["4.2", "4.3"]),
        settingsPath: z.string().min(1).optional(), timeoutMs: z.number().int().min(1_000).max(600_000).optional() }),
    },
    async ({ imagesDir, outputDir, name, editorVersion, settingsPath, timeoutMs }) => runTool(async () => {
      const result = await packAtlas(imagesDir, outputDir, name, editorVersion, settingsPath, timeoutMs);
      return { imagesDir: result.imagesDir, atlasDir: result.atlasDir, name: result.name,
        atlasFiles: result.atlasFiles, textureFiles: result.textureFiles,
        cli: { executable: result.cli.executable, exitCode: result.cli.exitCode,
          stdout: result.cli.stdout.slice(0, 4000), stderr: result.cli.stderr.slice(0, 4000) } };
    }),
  );

  server.registerTool(
    "spine_unpack_atlas",
    {
      description: "Unpack a Spine texture atlas into a new PNG image directory.",
      inputSchema: z.object({ atlasPath: z.string().min(1), outputDir: z.string().min(1),
        editorVersion: z.enum(["4.2", "4.3"]), timeoutMs: z.number().int().min(1_000).max(600_000).optional() }),
    },
    async ({ atlasPath, outputDir, editorVersion, timeoutMs }) => runTool(async () => {
      const result = await unpackAtlas(atlasPath, outputDir, editorVersion, timeoutMs);
      return { atlasPath: result.atlasPath, unpackDir: result.unpackDir, images: result.images,
        cli: { executable: result.cli.executable, exitCode: result.cli.exitCode,
          stdout: result.cli.stdout.slice(0, 4000), stderr: result.cli.stderr.slice(0, 4000) } };
    }),
  );

  server.registerTool(
    TOOL_NAMES.manageExportProfile,
    {
      description: "Save, list, inspect, or delete a repeatable Spine export profile with settings snapshots and editor/runtime compatibility checks.",
      inputSchema: z.object({ workspaceDir: z.string().min(1), action: z.enum(["save", "list", "get", "delete"]),
        name: z.string().min(1).optional(), editorVersion: z.enum(["4.2", "4.3"]).optional(),
        runtimeVersion: z.string().min(1).optional(),
        settingsPaths: z.object({ data: z.string().min(1).optional(), media: z.string().min(1).optional(),
          atlas: z.string().min(1).optional() }).strict().optional() }),
    },
    async ({ workspaceDir, action, name, editorVersion, runtimeVersion, settingsPaths }) => runTool(async () => {
      if (action === "list") return await listExportProfiles(workspaceDir);
      if (!name) throw new SpineError("INVALID_PROFILE_NAME", "Profile name is required for this action.");
      if (action === "get") return await getExportProfile(workspaceDir, name);
      if (action === "delete") return await deleteExportProfile(workspaceDir, name);
      if (!editorVersion || !runtimeVersion || !settingsPaths) {
        throw new SpineError("INVALID_PROFILE_INPUT", "Saving a profile needs editorVersion, runtimeVersion, and settingsPaths.");
      }
      return await saveExportProfile(workspaceDir, name, editorVersion, runtimeVersion, settingsPaths);
    }),
  );

  server.registerTool(
    TOOL_NAMES.runExportProfile,
    {
      description: "Run a saved export profile into a new output directory and return its reproducibility manifest.",
      inputSchema: z.object({ workspaceDir: z.string().min(1), name: z.string().min(1),
        inputPath: z.string().min(1).optional(), imagesDir: z.string().min(1).optional(),
        atlasName: z.string().min(1).optional(), outputDir: z.string().min(1),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional() }),
    },
    async ({ workspaceDir, name, inputPath, outputDir, imagesDir, atlasName, timeoutMs }) => runTool(async () =>
      await runExportProfile(workspaceDir, name, inputPath, outputDir, imagesDir, atlasName, timeoutMs)),
  );

  const retimeOperationSchema = z.object({
    kind: z.literal("retime_animation"),
    animation: z.string().min(1),
    scale: z.number().finite().positive(),
  });
  const bulkOperationSchema = z.object({
    kind: z.literal("bulk_keys"),
    animation: z.string().min(1),
    action: z.enum(["move", "scale", "duplicate", "delete", "offset", "quantize"]),
    section: z.string().min(1).optional(),
    target: z.string().optional(),
    timelineType: z.string().min(1).optional(),
    from: z.number().finite().nonnegative().optional(),
    to: z.number().finite().nonnegative().optional(),
    delta: z.number().finite().optional(),
    factor: z.number().finite().positive().optional(),
    anchor: z.number().finite().optional(),
    grid: z.number().finite().positive().optional(),
    field: z.string().min(1).optional(),
    amount: z.number().finite().optional(),
  });
  const loopOperationSchema = z.object({
    kind: z.literal("make_loop"),
    animation: z.string().min(1),
    duration: z.number().finite().positive().optional(),
    smooth: z.boolean().optional(),
    tolerance: z.number().finite().nonnegative().optional(),
  });
  const curveOperationSchema = z.object({
    kind: z.literal("set_curve"),
    animation: z.string().min(1),
    bone: z.string().min(1),
    timelineType: z.enum(["rotate", "translate", "scale", "shear"]),
    time: z.number().finite().nonnegative(),
    mode: z.enum(["linear", "stepped", "bezier"]),
    controls: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
  });
  const keyframeSelectorSchema = z.object({
    section: z.enum(["bones", "slots", "ik", "transform", "path", "physics", "slider", "attachments", "deform", "events", "drawOrder"]),
    target: z.string().min(1).optional(),
    timelineType: z.string().min(1).optional(),
    skin: z.string().min(1).optional(),
    slot: z.string().min(1).optional(),
    attachment: z.string().min(1).optional(),
  });
  const setKeyframeOperationSchema = z.object({
    kind: z.literal("set_keyframe"), animation: z.string().min(1), selector: keyframeSelectorSchema,
    time: z.number().finite().nonnegative(), values: z.record(z.string(), z.unknown()),
    curvePolicy: z.enum(["reject", "linearize"]).optional(),
  });
  const deleteKeyframeOperationSchema = z.object({
    kind: z.literal("delete_keyframe"), animation: z.string().min(1), selector: keyframeSelectorSchema,
    time: z.number().finite().nonnegative(), eventName: z.string().min(1).optional(),
  });
  const boneValuesSchema = z.object({
    x: z.number().finite().optional(), y: z.number().finite().optional(), rotation: z.number().finite().optional(),
    scaleX: z.number().finite().optional(), scaleY: z.number().finite().optional(),
    shearX: z.number().finite().optional(), shearY: z.number().finite().optional(),
    length: z.number().finite().nonnegative().optional(), inherit: z.string().min(1).optional(),
    skin: z.boolean().optional(), color: z.string().min(1).optional(),
  }).strict();
  const slotValuesSchema = z.object({
    attachment: z.string().min(1).nullable().optional(), color: z.string().min(1).optional(),
    dark: z.string().min(1).optional(), blend: z.enum(["normal", "additive", "multiply", "screen"]).optional(),
  }).strict();
  const regionValuesSchema = z.object({
    name: z.string().min(1).optional(), path: z.string().min(1).optional(), x: z.number().finite().optional(), y: z.number().finite().optional(),
    rotation: z.number().finite().optional(), scaleX: z.number().finite().optional(), scaleY: z.number().finite().optional(),
    width: z.number().finite().positive().optional(), height: z.number().finite().positive().optional(),
    color: z.string().min(1).optional(),
  }).strict();
  const upsertBoneOperationSchema = z.object({
    kind: z.literal("upsert_bone"), name: z.string().min(1), parent: z.string().min(1).optional(),
    values: boneValuesSchema.optional(),
  });
  const removeBoneOperationSchema = z.object({ kind: z.literal("remove_bone"), name: z.string().min(1) });
  const removeSlotOperationSchema = z.object({ kind: z.literal("remove_slot"), name: z.string().min(1) });
  const reorderSlotsOperationSchema = z.object({ kind: z.literal("reorder_slots"),
    names: z.array(z.string().min(1)).max(2048), animationPolicy: z.enum(["reject", "preserve"]).optional() });
  const renameElementOperationSchema = z.object({ kind: z.literal("rename_element"),
    elementType: z.enum(["bone", "slot", "skin", "event", "animation", "constraint", "attachment"]),
    name: z.string().min(1), newName: z.string().min(1),
    constraintType: z.enum(["ik", "transform", "path", "physics"]).optional(),
    slot: z.string().min(1).optional() });
  const cleanupCurvesOperationSchema = z.object({ kind: z.literal("cleanup_curves"),
    animation: z.string().min(1), mode: z.enum(["simplify", "smooth"]),
    bone: z.string().min(1).optional(),
    timelineTypes: z.array(z.enum(["rotate", "translate", "translatex", "translatey", "scale", "scalex", "scaley",
      "shear", "shearx", "sheary"])).min(1).max(10).optional(),
    tolerance: z.number().finite().nonnegative().optional(),
    protectedTimes: z.array(z.number().finite().nonnegative()).max(256).optional() });
  const upsertSlotOperationSchema = z.object({
    kind: z.literal("upsert_slot"), name: z.string().min(1), bone: z.string().min(1).optional(),
    values: slotValuesSchema.optional(),
  });
  const constraintValuesSchema = z.object({
    skin: z.boolean().optional(), order: z.number().int().nonnegative().optional(),
    mix: z.number().finite().optional(), softness: z.number().finite().optional(),
    bendPositive: z.boolean().optional(), compress: z.boolean().optional(), stretch: z.boolean().optional(), uniform: z.boolean().optional(),
    rotation: z.number().finite().optional(), x: z.number().finite().optional(), y: z.number().finite().optional(),
    scaleX: z.number().finite().optional(), scaleY: z.number().finite().optional(), shearY: z.number().finite().optional(),
    mixRotate: z.number().finite().optional(), mixX: z.number().finite().optional(), mixY: z.number().finite().optional(),
    mixScaleX: z.number().finite().optional(), mixScaleY: z.number().finite().optional(), mixShearY: z.number().finite().optional(),
    local: z.boolean().optional(), relative: z.boolean().optional(),
    properties: z.array(z.enum(["rotate", "x", "y", "scaleX", "scaleY", "shearY"])).min(1).optional(),
    positionMode: z.enum(["fixed", "percent"]).optional(), spacingMode: z.enum(["length", "fixed", "percent"]).optional(),
    rotateMode: z.enum(["tangent", "chain", "chainScale"]).optional(), position: z.number().finite().optional(),
    spacing: z.number().finite().optional(), rotate: z.number().finite().optional(), shearX: z.number().finite().optional(),
    limit: z.number().finite().optional(), fps: z.number().int().min(1).max(240).optional(),
    inertia: z.number().finite().optional(), strength: z.number().finite().optional(), damping: z.number().finite().optional(),
    mass: z.number().finite().optional(), wind: z.number().finite().optional(), gravity: z.number().finite().optional(),
    inertiaGlobal: z.boolean().optional(), strengthGlobal: z.boolean().optional(), dampingGlobal: z.boolean().optional(),
    massGlobal: z.boolean().optional(), windGlobal: z.boolean().optional(), gravityGlobal: z.boolean().optional(),
    mixGlobal: z.boolean().optional(),
  }).strict();
  const upsertConstraintOperationSchema = z.object({ kind: z.literal("upsert_constraint"),
    constraintType: z.enum(["ik", "transform", "path", "physics"]), name: z.string().min(1),
    edition: z.enum(["professional", "essential"]), bones: z.array(z.string().min(1)).min(1).max(256).optional(),
    target: z.string().min(1).optional(), bone: z.string().min(1).optional(), values: constraintValuesSchema.optional() });
  const removeConstraintOperationSchema = z.object({ kind: z.literal("remove_constraint"),
    constraintType: z.enum(["ik", "transform", "path", "physics"]), name: z.string().min(1) });
  const upsertRegionOperationSchema = z.object({
    kind: z.literal("upsert_region_attachment"), skin: z.string().min(1), slot: z.string().min(1),
    name: z.string().min(1), values: regionValuesSchema,
  });
  const attachmentSelectorSchema = {
    skin: z.string().min(1), slot: z.string().min(1), name: z.string().min(1),
  };
  const attachmentValuesSchema = z.object({
    name: z.string().min(1).optional(), path: z.string().min(1).optional(),
    x: z.number().finite().optional(), y: z.number().finite().optional(), rotation: z.number().finite().optional(),
    scaleX: z.number().finite().optional(), scaleY: z.number().finite().optional(),
    width: z.number().finite().positive().optional(), height: z.number().finite().positive().optional(),
    color: z.string().regex(/^[0-9a-fA-F]{8}$/).optional(),
    uvs: z.array(z.number().finite()).max(200000).optional(),
    vertices: z.array(z.number().finite()).max(500000).optional(),
    triangles: z.array(z.number().int().nonnegative()).max(300000).optional(),
    hull: z.number().int().nonnegative().optional(),
    edges: z.array(z.number().int().nonnegative()).max(300000).optional(),
    skin: z.string().min(1).optional(), parent: z.string().min(1).optional(), deform: z.boolean().optional(),
    vertexCount: z.number().int().nonnegative().optional(), lengths: z.array(z.number().finite()).max(100000).optional(),
    closed: z.boolean().optional(), constantSpeed: z.boolean().optional(), end: z.string().min(1).optional(),
  }).strict();
  const upsertAttachmentOperationSchema = z.object({ kind: z.literal("upsert_attachment"),
    ...attachmentSelectorSchema, attachmentType: z.enum(["region", "mesh", "linkedmesh", "boundingbox", "path", "point", "clipping"]),
    values: attachmentValuesSchema });
  const setMeshGeometryOperationSchema = z.object({ kind: z.literal("set_mesh_geometry"), ...attachmentSelectorSchema,
    uvs: z.array(z.number().finite()).min(6).max(200000),
    vertices: z.array(z.number().finite()).min(6).max(200000),
    triangles: z.array(z.number().int().nonnegative()).min(3).max(300000), hull: z.number().int().min(3) });
  const setMeshWeightsOperationSchema = z.object({ kind: z.literal("set_mesh_weights"), ...attachmentSelectorSchema,
    influences: z.array(z.array(z.object({ bone: z.string().min(1), x: z.number().finite(), y: z.number().finite(),
      weight: z.number().finite().positive() }).strict()).min(1).max(256)).min(3).max(100000) });
  const removeAttachmentOperationSchema = z.object({ kind: z.literal("remove_attachment"), ...attachmentSelectorSchema });
  const upsertAnimationOperationSchema = z.object({ kind: z.literal("upsert_animation"), name: z.string().min(1) });
  const removeAnimationOperationSchema = z.object({ kind: z.literal("remove_animation"), name: z.string().min(1) });
  const upsertSkinOperationSchema = z.object({ kind: z.literal("upsert_skin"), name: z.string().min(1),
    values: z.object({ bones: z.array(z.string().min(1)).optional(), ik: z.array(z.string().min(1)).optional(),
      transform: z.array(z.string().min(1)).optional(), path: z.array(z.string().min(1)).optional(),
      physics: z.array(z.string().min(1)).optional(), constraints: z.array(z.string().min(1)).optional() }).strict().optional() });
  const removeSkinOperationSchema = z.object({ kind: z.literal("remove_skin"), name: z.string().min(1) });
  const upsertEventOperationSchema = z.object({ kind: z.literal("upsert_event"), name: z.string().min(1),
    values: z.object({ int: z.number().int().optional(), float: z.number().finite().optional(),
      string: z.string().optional(), audio: z.string().optional(), volume: z.number().finite().optional(),
      balance: z.number().finite().optional() }).strict().optional() });
  const removeEventOperationSchema = z.object({ kind: z.literal("remove_event"), name: z.string().min(1) });
  const setSkeletonMetadataOperationSchema = z.object({ kind: z.literal("set_skeleton_metadata"),
    values: z.object({ images: z.string().min(1).optional(), audio: z.string().min(1).nullable().optional(),
      fps: z.number().int().min(1).max(240).optional() }).strict() });
  const cloneAnimationOperationSchema = z.object({ kind: z.literal("clone_animation"),
    sourceAnimation: z.string().min(1), newAnimation: z.string().min(1),
    timeScale: z.number().finite().positive().optional(), startAt: z.number().finite().nonnegative().optional() });
  const reverseBoneAnimationOperationSchema = z.object({ kind: z.literal("reverse_bone_animation"),
    sourceAnimation: z.string().min(1), newAnimation: z.string().min(1),
    duration: z.number().finite().positive().optional() });
  const transformAnimationOperationSchema = z.object({ kind: z.literal("transform_animation"),
    mode: z.enum(["mirror", "combine", "variant", "reverse", "segment"]), newAnimation: z.string().min(1),
    sourceAnimation: z.string().min(1).optional(),
    firstAnimation: z.string().min(1).optional(), secondAnimation: z.string().min(1).optional(),
    secondStart: z.number().finite().nonnegative().optional(),
    bonePairs: z.array(z.tuple([z.string().min(1), z.string().min(1)])).max(128).optional(),
    eventMap: z.record(z.string(), z.string().min(1)).optional(),
    timeScale: z.number().finite().positive().optional(), startAt: z.number().finite().nonnegative().optional(),
    duration: z.number().finite().positive().optional(),
    from: z.number().finite().nonnegative().optional(), to: z.number().finite().positive().optional() });
  const retargetMapsSchema = z.object({
    bones: z.record(z.string(), z.string().min(1)).optional(),
    slots: z.record(z.string(), z.string().min(1)).optional(),
    skins: z.record(z.string(), z.string().min(1)).optional(),
    attachments: z.record(z.string(), z.record(z.string(), z.string().min(1))).optional(),
    events: z.record(z.string(), z.string().min(1)).optional(),
    constraints: z.record(z.string(), z.record(z.string(), z.string().min(1))).optional(),
  }).strict();
  const retargetAnimationOperationSchema = z.object({ kind: z.literal("retarget_animation"),
    sourcePath: z.string().min(1), sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourceAnimation: z.string().min(1), newAnimation: z.string().min(1),
    maps: retargetMapsSchema.optional() });
  const operationSchema = z.discriminatedUnion("kind", [retimeOperationSchema, bulkOperationSchema, loopOperationSchema,
    curveOperationSchema, setKeyframeOperationSchema, deleteKeyframeOperationSchema,
    upsertBoneOperationSchema, removeBoneOperationSchema, upsertSlotOperationSchema,
    removeSlotOperationSchema, reorderSlotsOperationSchema, renameElementOperationSchema,
    cleanupCurvesOperationSchema, upsertConstraintOperationSchema,
    removeConstraintOperationSchema,
    upsertRegionOperationSchema, upsertAttachmentOperationSchema, setMeshGeometryOperationSchema,
    setMeshWeightsOperationSchema, removeAttachmentOperationSchema, upsertAnimationOperationSchema,
    removeAnimationOperationSchema, upsertSkinOperationSchema, removeSkinOperationSchema, upsertEventOperationSchema,
    removeEventOperationSchema,
    setSkeletonMetadataOperationSchema, cloneAnimationOperationSchema,
    reverseBoneAnimationOperationSchema, transformAnimationOperationSchema, retargetAnimationOperationSchema]);

  const batchOperationSchema = z.discriminatedUnion("kind", [
    retimeOperationSchema.omit({ animation: true }),
    loopOperationSchema.omit({ animation: true }),
    cleanupCurvesOperationSchema.omit({ animation: true }),
  ]);
  server.registerTool(
    TOOL_NAMES.batchJob,
    {
      description: "Stage or commit one retime, loop, or curve cleanup operation across several JSON projects; inspect or cancel job progress. Use export profiles for repeated data/media/atlas exports.",
      inputSchema: z.object({ action: z.enum(["start", "status", "cancel"]), jobId: z.uuid().optional(),
        targets: z.array(z.object({ path: z.string().min(1), animations: z.array(z.string().min(1)).min(1).max(20) }))
          .min(1).max(20).optional(),
        operation: batchOperationSchema.optional(), commit: z.boolean().optional(), stopOnError: z.boolean().optional() }),
    },
    async ({ action, jobId, targets, operation, commit, stopOnError }) => runTool(async () => {
      if (action === "status" || action === "cancel") {
        if (!jobId) throw new SpineError("INVALID_BATCH_INPUT", `${action} requires jobId.`);
        return action === "cancel" ? batches.cancel(jobId) : batches.get(jobId);
      }
      if (!targets || !operation) throw new SpineError("INVALID_BATCH_INPUT", "start requires targets and operation.");
      return batches.start({ targets, operation, commit, stopOnError });
    }),
  );

  const motionDuration = z.number().finite().min(0.1).max(60);
  const motionRecipeSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("idle"), bone: z.string().min(1), duration: motionDuration,
      swayDegrees: z.number().finite().min(0).max(45).optional(),
      bobDistance: z.number().finite().min(0).max(1000).optional() }),
    z.object({ type: z.literal("breathing"), bone: z.string().min(1), duration: motionDuration,
      amount: z.number().finite().min(0.001).max(0.5).optional() }),
    z.object({ type: z.literal("blink"), slot: z.string().min(1), openAttachment: z.string().min(1),
      closedAttachment: z.string().min(1), duration: motionDuration,
      at: z.number().finite().positive().optional(), hold: z.number().finite().positive().optional() }),
    z.object({ type: z.enum(["walk", "run"]), leftLeg: z.string().min(1), rightLeg: z.string().min(1),
      leftArm: z.string().min(1).optional(), rightArm: z.string().min(1).optional(),
      rootBone: z.string().min(1).optional(), duration: motionDuration,
      strideDegrees: z.number().finite().min(1).max(90).optional(),
      bobDistance: z.number().finite().min(0).max(1000).optional() }),
    z.object({ type: z.literal("recoil"), bone: z.string().min(1), duration: motionDuration,
      angleDegrees: z.number().finite().min(-180).max(180).optional() }),
    z.object({ type: z.literal("follow_through"), primaryBone: z.string().min(1),
      secondaryBone: z.string().min(1), duration: motionDuration,
      angleDegrees: z.number().finite().min(-180).max(180).optional(),
      lag: z.number().finite().min(0.01).max(0.3).optional() }),
  ]);
  server.registerTool(
    TOOL_NAMES.generateMotion,
    {
      description: "Generate a new idle, breathing, blink, walk, run, recoil, or follow-through clip from recipe parameters. Use spine_preview_edit to author specific keys instead.",
      inputSchema: z.object({ path: z.string().min(1), newAnimation: z.string().min(1),
        recipe: motionRecipeSchema, requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, newAnimation, recipe, requestId }) => runTool(async () => {
      const document = await readDocument(path);
      const generated = buildMotionOperations(document, newAnimation, recipe);
      const stage = await edits.preview(path, generated.operations, requestId);
      if (stage.sourceHash !== document.hash) {
        throw new SpineError("SOURCE_CHANGED", "The rig changed while the motion recipe was being staged. Try again.");
      }
      const stagedDocument = parseDocument(path, edits.snapshot(stage.editId).afterText);
      const loop = ["idle", "breathing", "blink", "walk", "run"].includes(recipe.type);
      const structuralReview = await checkAnimation(stagedDocument, newAnimation, { loop });
      return { ...stage, motion: generated.summary, structuralReview,
        reviewNext: ["Render the staged edit with spine_render_staged_edit.",
          ...(recipe.type === "walk" || recipe.type === "run"
            ? ["Inspect contact intervals with spine_analyze_motion_quality; foot drift is a review hint, so check the rendered frames."]
            : ["Inspect the rendered frames before committing."])],
      };
    }),
  );

  server.registerTool(
    "spine_preview_edit",
    {
      description: "Stage up to 20 coordinated edits to one skeleton JSON as one validated change. For one simple operation, use its named spine edit tool; save either result with spine_commit_edit.",
      inputSchema: z.object({
        path: z.string().min(1),
        operations: z.array(operationSchema).min(1).max(20),
        requestId: z.string().min(1).max(128).optional(),
      }),
    },
    async ({ path, operations, requestId }) => runTool(async () => ({ ...(await edits.preview(path, operations, requestId)) })),
  );

  server.registerTool(
    TOOL_NAMES.roundTripEdit,
    {
      description: "Use for an existing .spine project when edits need import and visual verification. Export, stage, import a new project, then compare staged and re-exported data and rendered frames.",
      inputSchema: z.object({ projectPath: z.string().min(1), dataSettingsPath: z.string().min(1),
        previewSettingsPath: z.string().min(1), outputDir: z.string().min(1),
        editorVersion: z.enum(["4.2", "4.3"]), animation: z.string().min(1),
        afterAnimation: z.string().min(1).optional(), operations: z.array(operationSchema).min(1).max(20),
        imagesDir: z.string().min(1).optional(), skin: z.string().min(1).optional(),
        frameStart: z.number().int().nonnegative().optional(), frameEnd: z.number().int().nonnegative().optional(),
        fps: z.number().int().min(1).max(120).optional(), renderBones: z.boolean().optional(),
        display: z.string().min(1).max(255).optional(),
        samples: z.number().int().min(1).max(12).optional(), checkLoop: z.boolean().optional(),
        contactRegions: z.array(z.object({ name: z.string().min(1),
          fromFrame: z.number().int().nonnegative(), toFrame: z.number().int().nonnegative(),
          x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
          width: z.number().finite().gt(0).max(1), height: z.number().finite().gt(0).max(1),
          driftThresholdPixels: z.number().finite().positive() })).min(1).max(8).optional(),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional() }),
    },
    async (input) => runTool(async () => {
      const result = await roundTripEdit(input, edits);
      const beforePublished = publishPreview(result.before, { kind: "file",
        sourcePath: result.manifest.edit.sourceJsonPath, sourceHash: result.manifest.edit.sourceHash });
      const afterPublished = publishPreview(result.after, { kind: "derived",
        sourcePath: result.manifest.reexported.path, sourceHash: result.manifest.reexported.sha256,
        renderPath: result.manifest.importedProject.path, renderHash: result.manifest.importedProject.sha256 });
      const comparisonId = publishFrames([...result.comparison.frames.map((frame) => frame.path),
        result.comparison.contactSheetPath]);
      const samples = result.manifest.visual.samples;
      return { runDir: result.runDir, manifestPath: result.manifestPath,
        editId: result.stage.editId, diffResourceUri: result.stage.diffResourceUri,
        sourceProject: result.manifest.sourceProject,
        sourceJsonPath: result.manifest.edit.sourceJsonPath,
        stagedJsonPath: result.manifest.edit.stagedJsonPath,
        importedProject: result.manifest.importedProject,
        reexported: result.manifest.reexported,
        changeCount: result.stage.changeCount, changes: result.stage.changes,
        changesTruncated: result.stage.changesTruncated, diagnostics: result.stage.diagnostics,
        animation: result.manifest.animation,
        motionReview: result.manifest.motionReview,
        beforePreviewId: beforePublished.previewId, afterPreviewId: afterPublished.previewId,
        beforeFrameCount: result.before.frames.length, afterFrameCount: result.after.frames.length,
        contactSheetUri: `spine-preview://${comparisonId}/${samples.length}`,
        comparisonDir: result.comparison.directory,
        pairs: samples.map(({ progress, beforeIndex, afterIndex }, index) => ({
          progress, beforeUri: `spine-preview://${beforePublished.previewId}/${beforeIndex}`,
          afterUri: `spine-preview://${afterPublished.previewId}/${afterIndex}`,
          sideBySideUri: `spine-preview://${comparisonId}/${index}`,
          meanAbsoluteDifference: result.comparison.frames[index].meanAbsoluteDifference,
          changedPixelPercent: result.comparison.frames[index].changedPixelPercent,
        })) };
    }),
  );

  server.registerTool(
    "spine_retime_animation",
    {
      description: "Stage one whole-animation retime. Use spine_preview_edit when retiming must be combined atomically with other edits; spine_commit_edit saves the chosen stage.",
      inputSchema: z.object({ path: z.string().min(1), animation: z.string().min(1), scale: z.number().finite().positive(), requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, animation, scale, requestId }) => runTool(async () => ({ ...(await edits.preview(path, [{ kind: "retime_animation", animation, scale }], requestId)) })),
  );

  server.registerTool(
    "spine_clone_animation",
    {
      description: "Clone one animation with all key and Bézier times scaled or shifted. Use spine_transform_animation for mirror, combine, or segment extraction.",
      inputSchema: z.object({ path: z.string().min(1), ...cloneAnimationOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "clone_animation", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_reverse_bone_animation",
    {
      description: "Stage a reversed bone-motion variant with reflected Bézier curves and event times. Requires time-zero bone keys and no discrete or non-bone pose timelines.",
      inputSchema: z.object({ path: z.string().min(1), ...reverseBoneAnimationOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "reverse_bone_animation", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_transform_animation",
    {
      description: "Transform an animation by mirroring, combining, extracting a segment, or applying a variant transform. Use spine_clone_animation for a plain timed copy.",
      inputSchema: z.object({ path: z.string().min(1), ...transformAnimationOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "transform_animation", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_retarget_animation",
    {
      description: "Map a source animation's bone, slot, skin, attachment, event, and constraint references into a target skeleton and stage a new clip. Reports every unmapped reference before staging.",
      inputSchema: z.object({ targetPath: z.string().min(1), sourcePath: z.string().min(1),
        sourceAnimation: z.string().min(1), newAnimation: z.string().min(1),
        maps: retargetMapsSchema.optional(), requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ targetPath, sourcePath, sourceAnimation, newAnimation, maps, requestId }) => runTool(async () => {
      const source = await readDocument(sourcePath);
      return { ...(await edits.preview(targetPath, [{ kind: "retarget_animation", sourcePath: source.path,
        sourceHash: source.hash, sourceAnimation, newAnimation, maps }], requestId)) };
    }),
  );

  server.registerTool(
    "spine_save_bone_pose",
    {
      description: "Save bone transform channels only as a session pose. Use spine_save_pose when slot attachment state matters, or spine_save_mesh_pose for mesh deforms.",
      inputSchema: z.object({ path: z.string().min(1), animation: z.string().min(1),
        time: z.number().finite().nonnegative(), name: z.string().min(1),
        bones: z.array(z.string().min(1)).min(1).max(256).optional() }),
    },
    async ({ path, animation, time, name, bones }) => runTool(async () => {
      const pose = captureBonePose(await readDocument(path), animation, time, name, bones);
      const poseId = randomUUID();
      poses.set(poseId, pose);
      if (poses.size > 20) poses.delete(poses.keys().next().value!);
      return { poseId, poseResourceUri: `spine-pose://${poseId}/data`, name: pose.name,
        sourcePath: pose.sourcePath, sourceHash: pose.sourceHash, sourceVersion: pose.sourceVersion,
        animation: pose.animation, time: pose.time, channelCount: pose.entries.length,
        boneCount: new Set(pose.entries.map((entry) => entry.bone)).size,
        channels: pose.entries.slice(0, 50), channelsTruncated: pose.entries.length > 50 };
    }),
  );

  server.registerTool(
    "spine_apply_bone_pose",
    {
      description: "Stage sampled bone transform values into a compatible skeleton animation with optional blending and bone mapping.",
      inputSchema: z.object({ poseId: z.uuid(), path: z.string().min(1), animation: z.string().min(1),
        time: z.number().finite().nonnegative(), blend: z.number().finite().gt(0).max(1).optional(),
        boneMap: z.record(z.string(), z.string().min(1)).optional(),
        curvePolicy: z.enum(["reject", "linearize"]).optional(),
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ poseId, path, animation, time, blend, boneMap, curvePolicy, requestId }) => runTool(async () => {
      const pose = poses.get(poseId);
      if (!pose) throw new SpineError("POSE_NOT_FOUND", `Pose ${poseId} is unavailable in this server session.`);
      const prepared = poseApplyOperations(await readDocument(path), pose, animation, time, blend, boneMap, curvePolicy);
      return { poseId, mapping: prepared.mappedBones, sourceBoneCount: prepared.sourceBones,
        channelCount: prepared.channels, ...(await edits.preview(path, prepared.operations, requestId)) };
    }),
  );

  server.registerTool(
    TOOL_NAMES.savePose,
    {
      description: "Save a session pose containing bone transforms and slot attachments. Use spine_save_bone_pose for bone-only data or spine_save_mesh_pose for mesh deforms.",
      inputSchema: z.object({ path: z.string().min(1), animation: z.string().min(1),
        time: z.number().finite().nonnegative(), name: z.string().min(1),
        bones: z.array(z.string().min(1)).min(1).max(256).optional(),
        slots: z.array(z.string().min(1)).min(1).max(256).optional() }),
    },
    async ({ path, animation, time, name, bones, slots }) => runTool(async () => {
      const pose = capturePose(await readDocument(path), animation, time, name, bones, slots);
      const poseId = randomUUID();
      fullPoses.set(poseId, pose);
      if (fullPoses.size > 20) fullPoses.delete(fullPoses.keys().next().value!);
      return { poseId, poseResourceUri: `spine-full-pose://${poseId}/data`, name: pose.name,
        sourcePath: pose.sourcePath, sourceHash: pose.sourceHash, sourceVersion: pose.sourceVersion,
        animation: pose.animation, time: pose.time, boneChannels: pose.boneEntries.length,
        slots: pose.slotEntries, skippedTimelines: pose.skippedTimelines.slice(0, 50),
        skippedTruncated: pose.skippedTimelines.length > 50 };
    }),
  );

  server.registerTool(
    TOOL_NAMES.applyPose,
    {
      description: "Stage a saved bone and slot pose in a compatible skeleton with blending, mirror pairs, per-channel offsets, and mappings.",
      inputSchema: z.object({ poseId: z.uuid(), path: z.string().min(1), animation: z.string().min(1),
        time: z.number().finite().nonnegative(), blend: z.number().finite().gt(0).max(1).optional(),
        boneMap: z.record(z.string(), z.string().min(1)).optional(),
        slotMap: z.record(z.string(), z.string().min(1)).optional(),
        attachmentMap: z.record(z.string(), z.record(z.string(), z.string().min(1))).optional(),
        mirrorPairs: z.array(z.tuple([z.string().min(1), z.string().min(1)])).max(128).optional(),
        offsets: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.number().finite()))).optional(),
        applySlots: z.boolean().optional(), curvePolicy: z.enum(["reject", "linearize"]).optional(),
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ poseId, path, animation, time, requestId, ...options }) => runTool(async () => {
      const pose = fullPoses.get(poseId);
      if (!pose) throw new SpineError("POSE_NOT_FOUND", `Pose ${poseId} is unavailable in this server session.`);
      const document = await readDocument(path);
      const prepared = applyPoseOperations(document, pose, animation, time, options);
      const stage = await edits.preview(path, prepared.operations, requestId);
      if (stage.sourceHash !== document.hash) {
        throw new SpineError("SOURCE_CHANGED", "The target rig changed while the pose was being staged. Try again.");
      }
      return { poseId, pose: prepared.summary, ...stage };
    }),
  );

  server.registerTool(
    TOOL_NAMES.saveMeshPose,
    {
      description: "Sample an animation's direct mesh deform timelines at a time and save their geometry fingerprints and values in this server session.",
      inputSchema: z.object({ path: z.string().min(1), animation: z.string().min(1),
        time: z.number().finite().nonnegative(), name: z.string().min(1) }),
    },
    async ({ path, animation, time, name }) => runTool(async () => {
      const pose = captureMeshPose(await readDocument(path), animation, time, name);
      const poseId = randomUUID();
      meshPoses.set(poseId, pose);
      if (meshPoses.size > 20) meshPoses.delete(meshPoses.keys().next().value!);
      return { poseId, poseResourceUri: `spine-mesh-pose://${poseId}/data`, name: pose.name,
        sourcePath: pose.sourcePath, sourceHash: pose.sourceHash, sourceVersion: pose.sourceVersion,
        animation: pose.animation, time: pose.time, meshCount: pose.entries.length,
        coordinateCount: pose.entries.reduce((sum, entry) => sum + entry.coordinateCount, 0),
        meshes: pose.entries.map(({ skin, slot, attachment, geometryHash, weighted }) =>
          ({ skin, slot, attachment, geometryHash, weighted })) };
    }),
  );

  server.registerTool(
    TOOL_NAMES.applyMeshPose,
    {
      description: "Stage a saved mesh deform pose on geometry-compatible meshes with optional name mapping and blending.",
      inputSchema: z.object({ poseId: z.uuid(), path: z.string().min(1), animation: z.string().min(1),
        time: z.number().finite().nonnegative(), blend: z.number().finite().gt(0).max(1).optional(),
        maps: z.object({ skins: z.record(z.string(), z.string().min(1)).optional(),
          slots: z.record(z.string(), z.string().min(1)).optional(),
          attachments: z.record(z.string(), z.record(z.string(), z.string().min(1))).optional(),
          bones: z.record(z.string(), z.string().min(1)).optional() }).optional(),
        curvePolicy: z.enum(["reject", "linearize"]).optional(),
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ poseId, path, animation, time, blend, maps, curvePolicy, requestId }) => runTool(async () => {
      const pose = meshPoses.get(poseId);
      if (!pose) throw new SpineError("POSE_NOT_FOUND", `Mesh pose ${poseId} is unavailable in this server session.`);
      const document = await readDocument(path);
      const prepared = applyMeshPoseOperations(document, pose, animation, time, blend, maps, curvePolicy);
      const stage = await edits.preview(path, prepared.operations, requestId);
      if (stage.sourceHash !== document.hash) throw new SpineError("SOURCE_CHANGED", "The target rig changed while the mesh pose was being staged.");
      return { poseId, pose: prepared.summary, ...stage };
    }),
  );

  server.registerTool(
    "spine_bulk_keys",
    {
      description: "Stage a coordinated bulk key edit across selected animations and timelines. Changes are validated before commit.",
      inputSchema: z.object({
        path: z.string().min(1),
        animations: z.array(z.string().min(1)).min(1).max(20),
        ...bulkOperationSchema.omit({ kind: true, animation: true }).shape,
        requestId: z.string().min(1).max(128).optional(),
      }),
    },
    async ({ path, animations, requestId, ...options }) => runTool(async () => {
      if (new Set(animations).size !== animations.length) throw new SpineError("DUPLICATE_ANIMATION", "Each animation may appear only once in a bulk key request.");
      const operations = animations.map((animation) => ({ kind: "bulk_keys" as const, animation, ...options }));
      return { ...(await edits.preview(path, operations, requestId)) };
    }),
  );

  server.registerTool(
    "spine_make_loop",
    {
      description: "Stage a shared loop end pose, ease supported scalar seams, and report before/after discontinuities.",
      inputSchema: z.object({
        path: z.string().min(1),
        animation: z.string().min(1),
        duration: z.number().finite().positive().optional(),
        smooth: z.boolean().optional(),
        tolerance: z.number().finite().nonnegative().optional(),
        requestId: z.string().min(1).max(128).optional(),
      }),
    },
    async ({ path, animation, duration, smooth, tolerance, requestId }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "make_loop", animation, duration, smooth, tolerance }], requestId)),
    })),
  );

  server.registerTool(
    "spine_set_curve",
    {
      description: "Stage linear, stepped, or normalized Bézier easing on an existing bone transform key.",
      inputSchema: z.object({ path: z.string().min(1), ...curveOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "set_curve", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_cleanup_curves",
    {
      description: "Stage bounded-error bone key simplification or monotone Bézier smoothing while keeping protected key times.",
      inputSchema: z.object({ path: z.string().min(1), ...cleanupCurvesOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "cleanup_curves", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_set_keyframe",
    {
      description: "Stage an insert or update of one typed animation key, including new timelines, with validation and explicit Bézier handling.",
      inputSchema: z.object({ path: z.string().min(1), ...setKeyframeOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "set_keyframe", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_delete_keyframe",
    {
      description: "Stage deletion of one animation key, prune an empty timeline, and reset a changed Bézier segment.",
      inputSchema: z.object({ path: z.string().min(1), ...deleteKeyframeOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "delete_keyframe", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_upsert_bone",
    {
      description: "Stage creation or setup-pose update of a bone, preserving its other exported fields.",
      inputSchema: z.object({ path: z.string().min(1), ...upsertBoneOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "upsert_bone", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_remove_bone",
    {
      description: "Stage removal of an unused non-root bone and remap weighted attachment indices after it.",
      inputSchema: z.object({ path: z.string().min(1), ...removeBoneOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "remove_bone", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_upsert_slot",
    {
      description: "Stage creation or setup-pose update of a slot on an existing bone.",
      inputSchema: z.object({ path: z.string().min(1), ...upsertSlotOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "upsert_slot", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_remove_slot",
    {
      description: "Stage removal of a slot after checking skin, animation, constraint, clipping, and draw-order references.",
      inputSchema: z.object({ path: z.string().min(1), ...removeSlotOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "remove_slot", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_reorder_slots",
    {
      description: "Stage a complete setup slot order. Use animationPolicy preserve to rewrite global draw-order keys to keep their visible order.",
      inputSchema: z.object({ path: z.string().min(1), ...reorderSlotsOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "reorder_slots", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_rename_element",
    {
      description: "Stage a bone, slot, skin, event, animation, constraint, or slot-wide attachment rename with known references updated atomically.",
      inputSchema: z.object({ path: z.string().min(1), ...renameElementOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "rename_element", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_upsert_constraint",
    {
      description: "Stage an IK, transform, path, or physics constraint using the Spine 4.2 or 4.3 data layout. Requires a Professional edition declaration.",
      inputSchema: z.object({ path: z.string().min(1), ...upsertConstraintOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "upsert_constraint", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_remove_constraint",
    {
      description: "Stage removal of an unused IK, transform, path, or physics constraint from the matching Spine version layout.",
      inputSchema: z.object({ path: z.string().min(1), ...removeConstraintOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "remove_constraint", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_upsert_region_attachment",
    {
      description: "Stage a simple image region attachment in a skin and slot. Use spine_upsert_attachment for meshes, clipping, paths, and other attachment types.",
      inputSchema: z.object({ path: z.string().min(1), ...upsertRegionOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "upsert_region_attachment", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_upsert_attachment",
    {
      description: "Stage a typed region, mesh, linked mesh, bounding box, path, point, or clipping attachment. Use spine_upsert_region_attachment for simple image regions.",
      inputSchema: z.object({ path: z.string().min(1), ...upsertAttachmentOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "upsert_attachment", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_set_mesh_geometry",
    {
      description: "Stage unweighted mesh UVs, vertices, triangles, and hull. Checks linked meshes and deform timelines.",
      inputSchema: z.object({ path: z.string().min(1), ...setMeshGeometryOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "set_mesh_geometry", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_set_mesh_weights",
    {
      description: "Stage complete mesh influences by bone name. Each vertex's weights must sum to one.",
      inputSchema: z.object({ path: z.string().min(1), ...setMeshWeightsOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "set_mesh_weights", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_remove_attachment",
    {
      description: "Stage deletion of an unused attachment. Reports setup, timeline, linked mesh, and path constraint references before removal.",
      inputSchema: z.object({ path: z.string().min(1), ...removeAttachmentOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "remove_attachment", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_upsert_animation",
    {
      description: "Stage creation of an empty animation without changing an existing animation.",
      inputSchema: z.object({ path: z.string().min(1), ...upsertAnimationOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "upsert_animation", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_remove_animation",
    {
      description: "Stage deletion of one named animation, including all its keys and timelines.",
      inputSchema: z.object({ path: z.string().min(1), ...removeAnimationOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "remove_animation", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_upsert_skin",
    {
      description: "Stage creation or setup update of a skin while preserving existing attachments.",
      inputSchema: z.object({ path: z.string().min(1), ...upsertSkinOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "upsert_skin", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_remove_skin",
    {
      description: "Stage deletion of a named skin after checking animation, linked mesh, setup, and path constraint references.",
      inputSchema: z.object({ path: z.string().min(1), ...removeSkinOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "remove_skin", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_upsert_event",
    {
      description: "Stage creation or default-value update of an animation event definition.",
      inputSchema: z.object({ path: z.string().min(1), ...upsertEventOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "upsert_event", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_remove_event",
    {
      description: "Stage deletion of an event definition after checking animation event keys.",
      inputSchema: z.object({ path: z.string().min(1), ...removeEventOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "remove_event", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_set_skeleton_metadata",
    {
      description: "Stage skeleton image path, audio path, or frame rate changes while preserving editor metadata.",
      inputSchema: z.object({ path: z.string().min(1), ...setSkeletonMetadataOperationSchema.omit({ kind: true }).shape,
        requestId: z.string().min(1).max(128).optional() }),
    },
    async ({ path, requestId, ...operation }) => runTool(async () => ({
      ...(await edits.preview(path, [{ kind: "set_skeleton_metadata", ...operation }], requestId)),
    })),
  );

  server.registerTool(
    "spine_commit_edit",
    {
      description: "Commit a staged edit if the source file is unchanged, preserving a backup and change manifest.",
      inputSchema: z.object({ editId: z.uuid() }),
    },
    async ({ editId }) => runTool(async () => ({ ...(await edits.commit(editId)) })),
  );

  server.registerTool(
    TOOL_NAMES.webPlayerPreview,
    {
      description: "Create a standalone interactive Spine Web Player HTML preview with embedded JSON, atlas, and texture pages.",
      inputSchema: z.object({ skeletonPath: z.string().min(1), atlasPath: z.string().min(1),
        outputDir: z.string().min(1), animation: z.string().min(1).optional(),
        skin: z.string().min(1).optional(), scale: z.number().finite().gt(0).max(10).optional(),
        premultipliedAlpha: z.boolean().optional(), debugBones: z.boolean().optional(),
        runtimeJsPath: z.string().min(1).optional(), runtimeCssPath: z.string().min(1).optional() }),
    },
    async (input) => runTool(async () => {
      const result = await createPlayerPreview(input);
      const playerId = randomUUID();
      players.set(playerId, result.htmlPath);
      if (players.size > 20) players.delete(players.keys().next().value!);
      return { playerId, playerUri: `spine-player://${playerId}/html`, ...result };
    }),
  );

  server.registerTool(
    "spine_render_preview",
    {
      description: "Render an existing JSON or .spine file to PNG frames. Use spine_render_staged_edit for an uncommitted editId; requires Spine CLI and OpenGL display.",
      inputSchema: z.object({
        inputPath: z.string().min(1),
        settingsPath: z.string().min(1),
        outputDir: z.string().min(1),
        animation: z.string().min(1),
        skeleton: z.string().min(1).optional(),
        skin: z.string().min(1).optional(),
        frameStart: z.number().int().nonnegative().optional(),
        frameEnd: z.number().int().nonnegative().optional(),
        fps: z.number().int().min(1).max(120).optional(),
        renderBones: z.boolean().optional(),
        display: z.string().min(1).max(255).optional(),
        editorVersion: z.string().min(1).optional(),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
      }),
    },
    async (args) => runTool(async () => {
      const sourcePath = resolve(args.inputPath);
      const sourceHash = await hashFile(sourcePath);
      const result = await renderPreview(args);
      await verifyRenderedInput(result, sourcePath, sourceHash);
      return publishPreview(result, { kind: "file", sourcePath, sourceHash });
    }),
  );

  const stagedRenderOptions = {
    editId: z.uuid(), settingsPath: z.string().min(1), outputDir: z.string().min(1), animation: z.string().min(1),
    skeleton: z.string().min(1).optional(), skin: z.string().min(1).optional(),
    fps: z.number().int().min(1).max(120).optional(), renderBones: z.boolean().optional(),
    display: z.string().min(1).max(255).optional(),
    editorVersion: z.string().min(1).optional(), timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  };

  server.registerTool(
    "spine_render_staged_edit",
    {
      description: "Render one uncommitted editId to PNG frames. Use spine_compare_previews for before/after pairs; requires Spine CLI and OpenGL display.",
      inputSchema: z.object(stagedRenderOptions),
    },
    async ({ editId, ...options }) => runTool(async () => withStageFiles(editId, async (_beforePath, afterPath, snapshot) => {
      const result = await renderPreview({ ...options, inputPath: afterPath });
      await verifyRenderedInput(result, afterPath, snapshot.afterHash);
      return { editId, afterHash: snapshot.afterHash,
        ...publishPreview(result, { kind: "stage", editId, sourcePath: snapshot.sourcePath,
          afterHash: snapshot.afterHash }) };
    })),
  );

  server.registerTool(
    "spine_compare_previews",
    {
      description: "Compare before and after PNG frames for one staged editId, with contact sheet and pixel differences. Use spine_render_staged_edit for after-only frames; requires Spine CLI and OpenGL display.",
      inputSchema: z.object({ ...stagedRenderOptions, samples: z.number().int().min(1).max(12).optional() }),
    },
    async ({ editId, samples, ...options }) => runTool(async () => withStageFiles(editId, async (beforePath, afterPath, snapshot) => {
      const before = await renderPreview({ ...options, inputPath: beforePath });
      let after;
      try { after = await renderPreview({ ...options, inputPath: afterPath }); }
      catch (error) {
        await rm(before.previewDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      try {
        await verifyRenderedInput(before, beforePath, snapshot.sourceHash);
        await verifyRenderedInput(after, afterPath, snapshot.afterHash);
      } catch (error) {
        await Promise.all([
          rm(before.previewDir, { recursive: true, force: true }),
          rm(after.previewDir, { recursive: true, force: true }),
        ]);
        throw error;
      }
      const count = Math.min(samples ?? 6, before.frames.length, after.frames.length, 12);
      const selected = Array.from({ length: count }, (_unused, index) => {
        const progress = count === 1 ? 0 : index / (count - 1);
        const beforeIndex = Math.round(progress * (before.frames.length - 1));
        const afterIndex = Math.round(progress * (after.frames.length - 1));
        return { progress, beforeIndex, afterIndex };
      });
      let visual: Awaited<ReturnType<typeof createVisualComparison>>;
      try {
        visual = await createVisualComparison(selected.map(({ beforeIndex, afterIndex }) => ({
          beforePath: before.frames[beforeIndex].path,
          afterPath: after.frames[afterIndex].path,
        })), options.outputDir);
      } catch (error) {
        await Promise.all([
          rm(before.previewDir, { recursive: true, force: true }),
          rm(after.previewDir, { recursive: true, force: true }),
        ]);
        throw error;
      }
      const beforePublished = publishPreview(before, { kind: "file",
        sourcePath: snapshot.sourcePath, sourceHash: snapshot.sourceHash });
      const afterPublished = publishPreview(after, { kind: "stage", editId,
        sourcePath: snapshot.sourcePath, afterHash: snapshot.afterHash });
      const comparisonId = publishFrames([...visual.frames.map((frame) => frame.path), visual.contactSheetPath]);
      const pairs = selected.map(({ progress, beforeIndex, afterIndex }, index) => ({
        progress,
        before: { index: beforeIndex, uri: `spine-preview://${beforePublished.previewId}/${beforeIndex}` },
        after: { index: afterIndex, uri: `spine-preview://${afterPublished.previewId}/${afterIndex}` },
        sideBySideUri: `spine-preview://${comparisonId}/${index}`,
        width: visual.frames[index].width,
        height: visual.frames[index].height,
        meanAbsoluteDifference: visual.frames[index].meanAbsoluteDifference,
        changedPixelPercent: visual.frames[index].changedPixelPercent,
      }));
      return {
        editId, sourceHash: snapshot.sourceHash, afterHash: snapshot.afterHash,
        beforePreviewId: beforePublished.previewId, afterPreviewId: afterPublished.previewId,
        pairing: "normalized-frame-progress", beforeFrameCount: before.frames.length, afterFrameCount: after.frames.length,
        beforePreviewDir: before.previewDir, afterPreviewDir: after.previewDir,
        comparisonDir: visual.directory,
        contactSheetUri: `spine-preview://${comparisonId}/${count}`,
        contactSheetWidth: visual.contactSheetWidth,
        contactSheetHeight: visual.contactSheetHeight,
        comparisonLayout: "Each row is a sample; before is left, after is right. Images are centered on a shared checkerboard canvas.",
        differenceMetric: "Mean absolute RGB difference after alpha compositing, normalized to 0–1. Changed pixel percent uses an 8/255 channel threshold.",
        pairs, changeSummary: snapshot.summaries,
      };
    })),
  );

  server.registerTool(
    "spine_contact_sheet",
    {
      description: "Create a sampled PNG contact sheet from frames returned by a preview tool in this server session.",
      inputSchema: z.object({ previewId: z.uuid(), samples: z.number().int().min(1).max(12).optional() }),
    },
    async ({ previewId, samples }) => runTool(async () => {
      const frames = previews.get(previewId)?.frames;
      if (!frames || frames.length === 0) throw new SpineError("PREVIEW_NOT_FOUND", "The preview does not exist in this server session.");
      const count = Math.min(samples ?? 6, frames.length);
      const indices = Array.from({ length: count }, (_unused, index) =>
        Math.round((count === 1 ? 0 : index / (count - 1)) * (frames.length - 1)));
      const sheet = await createFrameContactSheet(indices.map((index) => frames[index]), dirname(frames[0]));
      const sheetId = publishFrames([sheet.path]);
      return {
        sourcePreviewId: previewId,
        frameCount: frames.length,
        sampledIndices: indices,
        contactSheetUri: `spine-preview://${sheetId}/0`,
        contactSheetPath: sheet.path,
        width: sheet.width,
        height: sheet.height,
        layout: "Frames run from top to bottom in sampled time order.",
      };
    }),
  );

  server.registerResource(
    "project-inventory",
    new ResourceTemplate("spine-project://{inventoryId}/inventory", { list: undefined }),
    { title: "Full Spine project inventory", mimeType: "application/json" },
    async (uri, { inventoryId }) => {
      const inventory = inventories.get(String(inventoryId));
      if (!inventory) throw new SpineError("INVENTORY_NOT_FOUND", "The inventory does not exist in this server session.");
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(inventory) }] };
    },
  );

  server.registerResource(
    "staged-edit-changes",
    new ResourceTemplate("spine-edit://{editId}/changes", { list: undefined }),
    { title: "Full staged edit diff", mimeType: "application/json" },
    async (uri, { editId }) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(edits.changes(String(editId))) }],
    }),
  );

  server.registerResource(
    "saved-bone-pose",
    new ResourceTemplate("spine-pose://{poseId}/data", { list: undefined }),
    { title: "Saved Spine bone pose", mimeType: "application/json" },
    async (uri, { poseId }) => {
      const pose = poses.get(String(poseId));
      if (!pose) throw new SpineError("POSE_NOT_FOUND", "The pose does not exist in this server session.");
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(pose) }] };
    },
  );

  server.registerResource(
    "saved-pose",
    new ResourceTemplate("spine-full-pose://{poseId}/data", { list: undefined }),
    { title: "Saved Spine bone and slot pose", mimeType: "application/json" },
    async (uri, { poseId }) => {
      const pose = fullPoses.get(String(poseId));
      if (!pose) throw new SpineError("POSE_NOT_FOUND", "The pose does not exist in this server session.");
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(pose) }] };
    },
  );

  server.registerResource(
    "saved-mesh-pose",
    new ResourceTemplate("spine-mesh-pose://{poseId}/data", { list: undefined }),
    { title: "Saved Spine mesh deform pose", mimeType: "application/json" },
    async (uri, { poseId }) => {
      const pose = meshPoses.get(String(poseId));
      if (!pose) throw new SpineError("POSE_NOT_FOUND", "The mesh pose does not exist in this server session.");
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(pose) }] };
    },
  );

  server.registerResource(
    "web-player-html",
    new ResourceTemplate("spine-player://{playerId}/html", { list: undefined }),
    { title: "Interactive Spine Web Player HTML", mimeType: "text/html" },
    async (uri, { playerId }) => {
      const path = players.get(String(playerId));
      if (!path) throw new SpineError("PLAYER_NOT_FOUND", "The player preview is unavailable in this server session.");
      return { contents: [{ uri: uri.href, mimeType: "text/html", text: await readFile(path, "utf8") }] };
    },
  );

  server.registerResource(
    "preview-frame",
    new ResourceTemplate("spine-preview://{previewId}/{index}", { list: undefined }),
    { title: "Rendered Spine preview frame", mimeType: "image/png" },
    async (uri, { previewId, index }) => {
      const path = previews.get(String(previewId))?.frames[Number(index)];
      if (!path) throw new SpineError("PREVIEW_NOT_FOUND", "The preview frame does not exist in this server session.");
      return { contents: [{ uri: uri.href, mimeType: "image/png", blob: (await readFile(path)).toString("base64") }] };
    },
  );

  return server;
}
