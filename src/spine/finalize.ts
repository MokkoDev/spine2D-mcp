import { createHash, randomUUID } from "node:crypto";
import { cp, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { inspectAssets } from "./assets.js";
import { exportData, importData, packAtlas, renderPreview } from "./cli.js";
import { readDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { compareSemanticFidelity } from "./fidelity.js";
import { inspectAnimation } from "./inspect.js";
import { createPlayerPreview } from "./player.js";
import { analyzePreview } from "./quality.js";
import { validateDocument } from "./validate.js";
import { createFrameContactSheet } from "./visual.js";

export interface FinalizeAnimationInput {
  dataPath: string;
  dataSettingsPath: string;
  previewSettingsPath: string;
  outputDir: string;
  editorVersion: "4.2" | "4.3";
  animation: string;
  atlasPath?: string;
  imagesDir?: string;
  skin?: string;
  fps?: number;
  display?: string;
  samples?: number;
  timeoutMs?: number;
  runtimeJsPath?: string;
  runtimeCssPath?: string;
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function inside(folder: string, path: string): boolean {
  const offset = relative(folder, path);
  return offset === "" || offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

async function copyImages(configured: string, source: string, targetJson: string, runDir: string): Promise<string> {
  const destination = isAbsolute(configured) ? resolve(configured) : resolve(dirname(targetJson), configured);
  if (destination === source) return destination;
  if (!inside(runDir, destination)) {
    throw new SpineError("UNSAFE_IMAGE_PATH", "The JSON image path would leave the finalization run directory.",
      { configuredImages: configured, resolvedPath: destination });
  }
  if ((await stat(destination).catch(() => undefined))?.isDirectory()) return destination;
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  return destination;
}

export async function finalizeAnimation(input: FinalizeAnimationInput) {
  const source = await readDocument(input.dataPath);
  const sourceDiagnostics = validateDocument(source);
  if (sourceDiagnostics.some((item) => item.severity === "error")) {
    throw new SpineError("VALIDATION_FAILED", "The reviewed JSON has validation errors.", { diagnostics: sourceDiagnostics });
  }
  const reviewedAnimation = inspectAnimation(source, input.animation);
  const configured = (source.data.skeleton as Record<string, unknown> | undefined)?.images;
  const configuredImages = typeof configured === "string" ? configured : "./images/";
  const sourceImages = resolve(input.imagesDir ?? (isAbsolute(configuredImages)
    ? configuredImages : resolve(dirname(source.path), configuredImages)));
  const assets = await inspectAssets(source, sourceImages);
  if (assets.missingCount) {
    throw new SpineError("MISSING_IMAGES", "The reviewed JSON refers to missing attachment images.",
      { imagesDir: sourceImages, missing: assets.missing, missingCount: assets.missingCount });
  }
  if (assets.referenceCount && !(await stat(sourceImages).catch(() => undefined))?.isDirectory()) {
    throw new SpineError("IMAGES_NOT_FOUND", `Image directory does not exist: ${sourceImages}.`);
  }
  if (!Number.isSafeInteger(input.samples ?? 6) || (input.samples ?? 6) < 1 || (input.samples ?? 6) > 12) {
    throw new SpineError("INVALID_COMPARISON", "A contact sheet requires 1–12 samples.");
  }
  const outputRoot = resolve(input.outputDir);
  if (inside(sourceImages, outputRoot) && (await stat(sourceImages).catch(() => undefined))?.isDirectory()) {
    throw new SpineError("INVALID_OUTPUT_PATH", "Finalization output must be outside the source images directory.");
  }
  await mkdir(outputRoot, { recursive: true });
  const runDir = await mkdtemp(join(outputRoot, "spine-final-"));
  let step = "prepare";
  try {
    const projectDir = join(runDir, "project");
    await mkdir(projectDir);
    const skeletonName = basename(source.path, extname(source.path));
    const reviewedJsonPath = join(projectDir, basename(source.path));
    const projectPath = join(projectDir, `${skeletonName}.spine`);
    const dataSettingsPath = join(runDir, "data.export.json");
    const previewSettingsPath = join(runDir, "preview.export.json");
    await copyFile(source.path, reviewedJsonPath);
    await copyFile(resolve(input.dataSettingsPath), dataSettingsPath);
    await copyFile(resolve(input.previewSettingsPath), previewSettingsPath);
    const previewSettings = JSON.parse(await readFile(previewSettingsPath, "utf8")) as Record<string, unknown>;
    const effectivePreviewSettingsPath = join(runDir, "preview-effective.export.json");
    await writeFile(effectivePreviewSettingsPath, `${JSON.stringify({ ...previewSettings,
      rangeStart: -1, rangeEnd: -1, frameStart: -1, frameEnd: -1 }, null, 2)}\n`, { flag: "wx" });
    if (assets.referenceCount) await copyImages(configuredImages, sourceImages, reviewedJsonPath, runDir);

    step = "import";
    await importData(reviewedJsonPath, projectPath, skeletonName,
      input.editorVersion, input.timeoutMs);
    const projectHash = await hashFile(projectPath);

    step = "verify-export";
    const exported = await exportData(projectPath, dataSettingsPath, runDir, input.editorVersion, input.timeoutMs);
    if (exported.files.length !== 1) {
      throw new SpineError("MULTIPLE_SKELETONS", "The final project must re-export exactly one skeleton JSON file.",
        { exportedFiles: exported.files });
    }
    const reexported = await readDocument(exported.files[0]);
    const diagnostics = validateDocument(reexported);
    if (diagnostics.some((item) => item.severity === "error")) {
      throw new SpineError("VALIDATION_FAILED", "The final project re-exported invalid JSON.", { diagnostics });
    }
    const fidelity = compareSemanticFidelity(source, reexported);
    const finalAnimation = inspectAnimation(reexported, input.animation);
    if (fidelity.differenceCount || Math.abs(finalAnimation.duration - reviewedAnimation.duration) > 1e-4
      || finalAnimation.timelineCount !== reviewedAnimation.timelineCount
      || finalAnimation.keyCount !== reviewedAnimation.keyCount) {
      throw new SpineError("EXPORT_FIDELITY_FAILED", "The final project re-export differs from the reviewed JSON.",
        { fidelity, reviewedAnimation, finalAnimation });
    }
    if (assets.referenceCount) {
      const exportedImages = await copyImages(configuredImages, sourceImages, reexported.path, runDir);
      const exportedAssets = await inspectAssets(reexported, exportedImages);
      if (exportedAssets.missingCount) {
        throw new SpineError("MISSING_IMAGES", "The final export has missing attachment images.",
          { missing: exportedAssets.missing, missingCount: exportedAssets.missingCount });
      }
    }

    step = "render";
    const rendered = await renderPreview({ inputPath: projectPath, settingsPath: effectivePreviewSettingsPath,
      outputDir: runDir, animation: input.animation, skeleton: skeletonName, skin: input.skin, fps: input.fps,
      display: input.display, editorVersion: input.editorVersion, timeoutMs: input.timeoutMs });
    await writeFile(effectivePreviewSettingsPath, `${JSON.stringify(rendered.effectiveSettings, null, 2)}\n`);
    const review = await analyzePreview(rendered.frames.map((frame) => frame.path));
    const count = Math.min(input.samples ?? 6, rendered.frames.length);
    const sampledIndices = Array.from({ length: count }, (_, index) => Math.round(
      (count === 1 ? 0 : index / (count - 1)) * (rendered.frames.length - 1)));
    const sheet = await createFrameContactSheet(sampledIndices.map((index) => rendered.frames[index].path), runDir);

    step = "html-preview";
    const atlas = input.atlasPath ? { atlasPath: resolve(input.atlasPath), generated: false }
      : { atlasPath: (await packAtlas(sourceImages, runDir,
        basename(source.path, extname(source.path)).replace(/[^A-Za-z0-9_-]/g, "_") || "skeleton",
        input.editorVersion, undefined, input.timeoutMs)).atlasFiles[0], generated: true };
    const player = await createPlayerPreview({ skeletonPath: reexported.path, atlasPath: atlas.atlasPath,
      outputDir: runDir, animation: input.animation, skin: input.skin,
      runtimeJsPath: input.runtimeJsPath, runtimeCssPath: input.runtimeCssPath });

    step = "complete";
    if (await hashFile(source.path) !== source.hash || await hashFile(projectPath) !== projectHash
      || await hashFile(reexported.path) !== reexported.hash) {
      throw new SpineError("SOURCE_CHANGED", "A finalization input or output changed while the workflow ran.");
    }
    const manifestPath = join(runDir, "manifest.json");
    const manifest = { schemaVersion: 1, runId: randomUUID(), status: "complete",
      completedAt: new Date().toISOString(), editorVersion: input.editorVersion,
      reviewedJson: { path: source.path, sha256: source.hash },
      importedJson: { path: reviewedJsonPath, sha256: await hashFile(reviewedJsonPath) },
      project: { path: projectPath, sha256: projectHash },
      reexported: { path: reexported.path, sha256: reexported.hash, diagnostics, fidelity },
      animation: { name: input.animation, reviewed: reviewedAnimation, final: finalAnimation },
      settings: { data: { path: dataSettingsPath, sha256: await hashFile(dataSettingsPath) },
        preview: { path: previewSettingsPath, sha256: await hashFile(previewSettingsPath) },
        effectivePreview: { path: effectivePreviewSettingsPath, sha256: await hashFile(effectivePreviewSettingsPath) } },
      assets: { sourceImages, referenceCount: assets.referenceCount, atlas },
      rendered: { frameCount: rendered.frames.length, previewDir: rendered.previewDir,
        sampledIndices, contactSheetPath: sheet.path, contactSheetWidth: sheet.width,
        contactSheetHeight: sheet.height, review },
      html: { path: player.htmlPath, sha256: player.htmlHash, runtimeSource: player.runtimeSource,
        playerManifestPath: player.manifestPath } };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    return { runDir, manifestPath, manifest, rendered, sheet, player };
  } catch (error) {
    await writeFile(join(runDir, "failure.json"), `${JSON.stringify({ status: "failed", step,
      failedAt: new Date().toISOString(), code: error instanceof SpineError ? error.code : "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error) }, null, 2)}\n`).catch(() => undefined);
    if (error instanceof SpineError) {
      throw new SpineError(error.code, error.message,
        { ...(error.details && typeof error.details === "object" ? error.details : {}), runDir, failedStep: step });
    }
    throw new SpineError("FINALIZATION_FAILED", `Animation finalization failed during ${step}.`,
      { runDir, failedStep: step, reason: String(error) });
  }
}
