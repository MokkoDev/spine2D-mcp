import { createHash, randomUUID } from "node:crypto";
import { cp, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { inspectAssets } from "./assets.js";
import { exportData, importData, renderPreview } from "./cli.js";
import { analyzeFootContacts, type ContactRegion } from "./contact.js";
import { readDocument } from "./document.js";
import { EditStore, type EditOperation } from "./edit.js";
import { SpineError } from "./errors.js";
import { inspectAnimation } from "./inspect.js";
import { analyzePreview, checkAnimation } from "./quality.js";
import { validateDocument } from "./validate.js";
import { createVisualComparison } from "./visual.js";

export interface RoundTripInput {
  projectPath: string;
  dataSettingsPath: string;
  previewSettingsPath: string;
  outputDir: string;
  editorVersion: "4.2" | "4.3";
  animation: string;
  afterAnimation?: string;
  operations: EditOperation[];
  imagesDir?: string;
  skin?: string;
  frameStart?: number;
  frameEnd?: number;
  fps?: number;
  renderBones?: boolean;
  display?: string;
  samples?: number;
  timeoutMs?: number;
  checkLoop?: boolean;
  contactRegions?: ContactRegion[];
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  return hash(await readFile(path));
}

function inside(folder: string, path: string): boolean {
  const offset = relative(folder, path);
  return offset === "" || offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

async function prepareImages(document: Awaited<ReturnType<typeof readDocument>>,
  sourceProject: string, runDir: string, suppliedImagesDir?: string) {
  const skeleton = document.data.skeleton as Record<string, unknown>;
  const configured = typeof skeleton.images === "string" ? skeleton.images : "./images/";
  const destination = isAbsolute(configured) ? resolve(configured) : resolve(dirname(document.path), configured);
  if ((await stat(destination).catch(() => undefined))?.isDirectory()) {
    return { imagesDir: destination, assetSource: destination, copied: false };
  }
  const source = suppliedImagesDir ? resolve(suppliedImagesDir) : resolve(dirname(sourceProject), configured);
  if (!(await stat(source).catch(() => undefined))?.isDirectory()) {
    const assets = await inspectAssets(document, source);
    if (assets.referenceCount) {
      throw new SpineError("IMAGES_NOT_FOUND", `Image directory ${source} is missing; pass imagesDir for this project.`,
        { imagesDir: source, referencedAttachments: assets.referenceCount });
    }
    return { imagesDir: destination, assetSource: source, copied: false };
  }
  if (!inside(runDir, destination)) {
    throw new SpineError("UNSAFE_IMAGE_PATH", "The exported JSON points outside the round-trip run directory. Use a project with a local images path.",
      { configuredImages: configured, resolvedPath: destination });
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  return { imagesDir: destination, assetSource: source, copied: true };
}

export async function roundTripEdit(input: RoundTripInput, edits: EditStore) {
  const projectPath = resolve(input.projectPath);
  if (extname(projectPath).toLowerCase() !== ".spine" || !(await stat(projectPath).catch(() => undefined))?.isFile()) {
    throw new SpineError("PROJECT_NOT_FOUND", `Spine project does not exist: ${projectPath}.`);
  }
  if (!input.operations.length || input.operations.length > 20) {
    throw new SpineError("INVALID_ROUND_TRIP", "The round trip requires 1–20 edit operations.");
  }
  if (!Number.isSafeInteger(input.samples ?? 6) || (input.samples ?? 6) < 1 || (input.samples ?? 6) > 12) {
    throw new SpineError("INVALID_COMPARISON", "Visual comparison needs 1–12 samples.");
  }
  await mkdir(resolve(input.outputDir), { recursive: true });
  const runDir = await mkdtemp(join(resolve(input.outputDir), "spine-round-trip-"));
  const manifestPath = join(runDir, "manifest.json");
  const startedAt = new Date().toISOString();
  let step = "settings";
  try {
    const dataSettingsPath = join(runDir, "data.export.json");
    const previewSettingsPath = join(runDir, "preview.export.json");
    await copyFile(resolve(input.dataSettingsPath), dataSettingsPath);
    await copyFile(resolve(input.previewSettingsPath), previewSettingsPath);
    const sourceProjectHash = await hashFile(projectPath);
    const dataSettingsHash = await hashFile(dataSettingsPath);
    const previewSettingsHash = await hashFile(previewSettingsPath);
    // Spine 4.2 treats an explicit saved range differently from 4.3 and may
    // export only frame zero. Render the full clip, then select the requested
    // frame indices ourselves so a multi-frame comparison remains possible.
    let effectivePreviewSettingsPath = previewSettingsPath;
    if (input.editorVersion === "4.2") {
      let settings: Record<string, unknown>;
      try { settings = JSON.parse(await readFile(previewSettingsPath, "utf8")) as Record<string, unknown>; }
      catch { throw new SpineError("INVALID_EXPORT_SETTINGS", "Saved preview settings are not valid JSON."); }
      effectivePreviewSettingsPath = join(runDir, "preview-effective.export.json");
      await writeFile(effectivePreviewSettingsPath,
        `${JSON.stringify({ ...settings, rangeStart: -1, rangeEnd: -1, frameStart: -1, frameEnd: -1 }, null, 2)}\n`, { flag: "wx" });
    }

    step = "export-original";
    const exported = await exportData(projectPath, dataSettingsPath, runDir, input.editorVersion, input.timeoutMs);
    if (exported.files.length !== 1) {
      throw new SpineError("MULTIPLE_SKELETONS", "Round-trip editing requires a project that exports exactly one skeleton JSON file.",
        { exportedFiles: exported.files });
    }
    const source = await readDocument(exported.files[0]);
    const sourceDiagnostics = validateDocument(source);
    if (sourceDiagnostics.some((item) => item.severity === "error")) {
      throw new SpineError("VALIDATION_FAILED", "The original project exported invalid JSON.", { diagnostics: sourceDiagnostics });
    }
    const assets = await prepareImages(source, projectPath, runDir, input.imagesDir);
    const assetCheck = await inspectAssets(source, assets.imagesDir);
    if (assetCheck.missingCount) {
      throw new SpineError("MISSING_IMAGES", "The exported skeleton has missing attachment images.",
        { imagesDir: assets.imagesDir, missingCount: assetCheck.missingCount, missing: assetCheck.missing });
    }

    step = "stage-edit";
    const stage = await edits.preview(source.path, input.operations);
    const snapshot = edits.snapshot(stage.editId);
    const stagedJsonPath = join(dirname(source.path), `${basename(source.path, ".json")}-staged.json`);
    await writeFile(stagedJsonPath, snapshot.afterText, { flag: "wx" });

    step = "import-edited";
    const importedProjectPath = join(dirname(source.path), "edited.spine");
    const imported = await importData(stagedJsonPath, importedProjectPath,
      basename(source.path, ".json"), input.editorVersion, input.timeoutMs);

    step = "reexport-edited";
    const reexported = await exportData(importedProjectPath, dataSettingsPath, runDir, input.editorVersion, input.timeoutMs);
    if (reexported.files.length !== 1) {
      throw new SpineError("MULTIPLE_SKELETONS", "The imported project did not re-export exactly one skeleton JSON file.",
        { exportedFiles: reexported.files });
    }
    const reexportedDocument = await readDocument(reexported.files[0]);
    const reexportedDiagnostics = validateDocument(reexportedDocument);
    if (reexportedDiagnostics.some((item) => item.severity === "error")) {
      throw new SpineError("VALIDATION_FAILED", "The imported project re-exported invalid JSON.", { diagnostics: reexportedDiagnostics });
    }
    const reexportAssets = await prepareImages(reexportedDocument, importedProjectPath, runDir, assets.imagesDir);
    const reexportAssetCheck = await inspectAssets(reexportedDocument, reexportAssets.imagesDir);
    if (reexportAssetCheck.missingCount) {
      throw new SpineError("MISSING_IMAGES", "The re-exported skeleton has missing attachment images.",
        { imagesDir: reexportAssets.imagesDir, missingCount: reexportAssetCheck.missingCount,
          missing: reexportAssetCheck.missing });
    }
    const beforeAnimation = inspectAnimation(source, input.animation);
    const stagedAnimation = inspectAnimation(await readDocument(stagedJsonPath), input.afterAnimation ?? input.animation);
    const afterAnimation = inspectAnimation(reexportedDocument, input.afterAnimation ?? input.animation);
    const fidelity = { durationDelta: Number((afterAnimation.duration - stagedAnimation.duration).toPrecision(8)),
      timelineCountDelta: afterAnimation.timelineCount - stagedAnimation.timelineCount,
      keyCountDelta: afterAnimation.keyCount - stagedAnimation.keyCount,
      reviewNeeded: Math.abs(afterAnimation.duration - stagedAnimation.duration) > 1e-4
        || afterAnimation.timelineCount !== stagedAnimation.timelineCount
        || afterAnimation.keyCount !== stagedAnimation.keyCount };

    step = "render-before";
    const renderOptions = { settingsPath: effectivePreviewSettingsPath, outputDir: runDir,
      skin: input.skin,
      frameStart: input.editorVersion === "4.2" ? undefined : input.frameStart,
      frameEnd: input.editorVersion === "4.2" ? undefined : input.frameEnd,
      fps: input.fps, renderBones: input.renderBones, display: input.display, editorVersion: input.editorVersion,
      timeoutMs: input.timeoutMs };
    const beforeRaw = await renderPreview({ ...renderOptions, inputPath: source.path, animation: input.animation });
    step = "render-after";
    const afterRaw = await renderPreview({ ...renderOptions, inputPath: importedProjectPath,
      animation: input.afterAnimation ?? input.animation });
    const selectedFrames = <T>(frames: T[]): T[] => input.editorVersion === "4.2"
      ? frames.slice(input.frameStart ?? 0, input.frameEnd === undefined ? undefined : input.frameEnd + 1) : frames;
    const before = { ...beforeRaw, frames: selectedFrames(beforeRaw.frames) };
    const after = { ...afterRaw, frames: selectedFrames(afterRaw.frames) };
    if (!before.frames.length || !after.frames.length) {
      throw new SpineError("INVALID_RANGE", "The requested frame range contains no rendered frames.");
    }
    step = "compare";
    const count = Math.min(input.samples ?? 6, before.frames.length, after.frames.length);
    const sampled = Array.from({ length: count }, (_, index) => {
      const progress = count === 1 ? 0 : index / (count - 1);
      return { progress, beforeIndex: Math.round(progress * (before.frames.length - 1)),
        afterIndex: Math.round(progress * (after.frames.length - 1)) };
    });
    const comparison = await createVisualComparison(sampled.map(({ beforeIndex, afterIndex }) => ({
      beforePath: before.frames[beforeIndex].path, afterPath: after.frames[afterIndex].path,
    })), runDir);
    step = "motion-review";
    const structural = await checkAnimation(reexportedDocument, input.afterAnimation ?? input.animation,
      { loop: input.checkLoop ?? false });
    const previewReview = await analyzePreview(after.frames.map((frame) => frame.path));
    const contacts = input.contactRegions?.length
      ? await analyzeFootContacts(after.frames.map((frame) => frame.path), input.contactRegions) : undefined;
    if (await hashFile(projectPath) !== sourceProjectHash) {
      throw new SpineError("SOURCE_CHANGED", "The source .spine project changed during the round trip.");
    }
    const manifest = { schemaVersion: 1, runId: randomUUID(), status: "complete", startedAt,
      completedAt: new Date().toISOString(), editorVersion: input.editorVersion,
      sourceProject: { path: projectPath, sha256: sourceProjectHash },
      settings: { data: { path: dataSettingsPath, sha256: dataSettingsHash },
        preview: { path: previewSettingsPath, sha256: previewSettingsHash },
        effectivePreview: { path: effectivePreviewSettingsPath,
          sha256: await hashFile(effectivePreviewSettingsPath) } },
      assets: { ...assets, missingCount: assetCheck.missingCount },
      edit: { editId: stage.editId, operations: input.operations, sourceJsonPath: source.path,
        sourceHash: stage.sourceHash, stagedJsonPath, stagedHash: stage.afterHash,
        changeCount: stage.changeCount, diagnostics: stage.diagnostics },
      importedProject: { path: importedProjectPath, sha256: await hashFile(importedProjectPath) },
      reexported: { path: reexportedDocument.path, sha256: reexportedDocument.hash,
        diagnostics: reexportedDiagnostics, imagesDir: reexportAssets.imagesDir,
        missingImages: reexportAssetCheck.missingCount },
      animation: { beforeName: input.animation, afterName: input.afterAnimation ?? input.animation,
        before: beforeAnimation, staged: stagedAnimation, after: afterAnimation, fidelity },
      motionReview: { structural, preview: previewReview, contacts,
        hints: [...structural.hints, ...previewReview.hints, ...(contacts?.hints ?? []),
          ...(fidelity.reviewNeeded ? [{ code: "ROUND_TRIP_TIMELINE_CHANGE", severity: "review" as const,
            path: `/animations/${input.afterAnimation ?? input.animation}`,
            message: "The imported project re-exported a different duration, timeline count, or key count from the staged JSON." }] : [])] },
      visual: { samples: sampled, beforeFrameCount: before.frames.length,
        afterFrameCount: after.frames.length, comparisonDir: comparison.directory,
        contactSheetPath: comparison.contactSheetPath,
        pairs: comparison.frames.map((frame, index) => ({ progress: sampled[index].progress,
          beforePath: before.frames[sampled[index].beforeIndex].path,
          afterPath: after.frames[sampled[index].afterIndex].path,
          sideBySidePath: frame.path, meanAbsoluteDifference: frame.meanAbsoluteDifference,
          changedPixelPercent: frame.changedPixelPercent })) },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    return { runDir, manifestPath, manifest, stage, before, after, comparison };
  } catch (error) {
    await writeFile(join(runDir, "failure.json"), `${JSON.stringify({ status: "failed", step,
      failedAt: new Date().toISOString(), code: error instanceof SpineError ? error.code : "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error) }, null, 2)}\n`).catch(() => undefined);
    if (error instanceof SpineError) {
      throw new SpineError(error.code, error.message,
        { ...(error.details && typeof error.details === "object" ? error.details : {}), runDir, failedStep: step });
    }
    throw new SpineError("ROUND_TRIP_FAILED", `The round trip failed during ${step}.`,
      { runDir, failedStep: step, reason: String(error) });
  }
}
