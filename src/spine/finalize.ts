import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { inspectAssets } from "./assets.js";
import { exportData, importData, packAtlas, renderPreview } from "./cli.js";
import { readDocument, type SpineDocument } from "./document.js";
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
  existingProjectPath?: string;
  replaceExistingProject?: boolean;
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

function withoutAnimation(document: SpineDocument, animation: string): SpineDocument {
  const animations = document.data.animations as Record<string, unknown> | undefined;
  return { ...document, data: { ...document.data, animations: Object.fromEntries(
    Object.entries(animations ?? {}).filter(([name]) => name !== animation)) } };
}

async function publishExistingProject(existingPath: string, expectedHash: string,
  importedPath: string, importedHash: string, runDir: string): Promise<string> {
  const backupPath = join(runDir, "existing-project-before.spine");
  const temporaryPath = join(dirname(existingPath), `.spine2d-finalize-${randomUUID()}.spine`);
  if (await hashFile(existingPath) !== expectedHash) {
    throw new SpineError("SOURCE_CHANGED", "The existing Spine project changed during finalization.");
  }
  await copyFile(existingPath, backupPath, constants.COPYFILE_EXCL);
  if (await hashFile(backupPath) !== expectedHash) {
    throw new SpineError("SOURCE_CHANGED", "The existing Spine project changed while its backup was created.");
  }
  try {
    await copyFile(importedPath, temporaryPath, constants.COPYFILE_EXCL);
    if (await hashFile(temporaryPath) !== importedHash || await hashFile(existingPath) !== expectedHash) {
      throw new SpineError("SOURCE_CHANGED", "A Spine project changed before the existing project could be updated.");
    }
    await rename(temporaryPath, existingPath);
    return backupPath;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function finalizeAnimation(input: FinalizeAnimationInput) {
  const source = await readDocument(input.dataPath);
  const sourceDiagnostics = validateDocument(source);
  if (sourceDiagnostics.some((item) => item.severity === "error")) {
    throw new SpineError("VALIDATION_FAILED", "The reviewed JSON has validation errors.", { diagnostics: sourceDiagnostics });
  }
  const reviewedAnimation = inspectAnimation(source, input.animation);
  const siblingProjectPath = resolve(dirname(source.path), `${basename(source.path, extname(source.path))}.spine`);
  if (input.existingProjectPath && !input.replaceExistingProject) {
    throw new SpineError("REPLACEMENT_NOT_SELECTED", "Set replaceExistingProject to replace the selected project after verification.");
  }
  const selectedProjectPath = resolve(input.existingProjectPath ?? siblingProjectPath);
  if (extname(selectedProjectPath).toLowerCase() !== ".spine") {
    throw new SpineError("INVALID_PROJECT_PATH", "An existing project path must end in .spine.");
  }
  const selectedProjectStat = await lstat(selectedProjectPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (input.replaceExistingProject && !selectedProjectStat) {
    throw new SpineError("PROJECT_NOT_FOUND", `Spine project does not exist: ${selectedProjectPath}.`);
  }
  if (input.replaceExistingProject && selectedProjectStat && (!selectedProjectStat.isFile() || selectedProjectStat.isSymbolicLink())) {
    throw new SpineError("INVALID_PROJECT_PATH", "The existing Spine project must be a regular file.",
      { projectPath: selectedProjectPath });
  }
  const existingProjectPath = input.replaceExistingProject && selectedProjectStat ? selectedProjectPath : undefined;
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
  let publishedBackupPath: string | undefined;
  let importedProjectHash: string | undefined;
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

    let existingProjectHash: string | undefined;
    if (existingProjectPath) {
      step = "verify-existing-project";
      const projectImages = isAbsolute(configuredImages) ? resolve(configuredImages)
        : resolve(dirname(existingProjectPath), configuredImages);
      const projectAssets = await inspectAssets(source, projectImages);
      if (projectAssets.missingCount) {
        throw new SpineError("MISSING_IMAGES", "The existing project would have missing attachment images.",
          { projectPath: existingProjectPath, imagesDir: projectImages,
            missingCount: projectAssets.missingCount, missing: projectAssets.missing });
      }
      existingProjectHash = await hashFile(existingProjectPath);
      const existingExport = await exportData(existingProjectPath, dataSettingsPath, runDir,
        input.editorVersion, input.timeoutMs);
      if (existingExport.files.length !== 1 || basename(existingExport.files[0], ".json") !== skeletonName) {
        throw new SpineError("EXISTING_PROJECT_MISMATCH",
          "The existing project must contain exactly the skeleton named by the reviewed JSON.",
          { projectPath: existingProjectPath, exportedFiles: existingExport.files });
      }
      const existingDocument = await readDocument(existingExport.files[0]);
      const existingDiagnostics = validateDocument(existingDocument);
      if (existingDiagnostics.some((item) => item.severity === "error")) {
        throw new SpineError("VALIDATION_FAILED", "The existing project exported invalid JSON.",
          { diagnostics: existingDiagnostics });
      }
      const compatibility = compareSemanticFidelity(
        withoutAnimation(source, input.animation), withoutAnimation(existingDocument, input.animation));
      if (compatibility.differenceCount) {
        throw new SpineError("EXISTING_PROJECT_MISMATCH",
          "The existing project differs from the reviewed JSON outside the selected animation.",
          { projectPath: existingProjectPath, compatibility });
      }
    }

    step = "import";
    await importData(reviewedJsonPath, projectPath, skeletonName,
      input.editorVersion, input.timeoutMs);
    const projectHash = await hashFile(projectPath);
    importedProjectHash = projectHash;

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
    if (existingProjectPath && existingProjectHash) {
      step = "publish-existing-project";
      publishedBackupPath = await publishExistingProject(existingProjectPath, existingProjectHash,
        projectPath, projectHash, runDir);
    }
    const manifestPath = join(runDir, "manifest.json");
    const manifest = { schemaVersion: 1, runId: randomUUID(), status: "complete",
      completedAt: new Date().toISOString(), editorVersion: input.editorVersion,
      reviewedJson: { path: source.path, sha256: source.hash },
      importedJson: { path: reviewedJsonPath, sha256: await hashFile(reviewedJsonPath) },
      project: { path: existingProjectPath ?? projectPath, sha256: projectHash,
        mode: existingProjectPath ? "updated" : "created", previousSha256: existingProjectHash,
        backupPath: publishedBackupPath },
      importedProject: { path: projectPath, sha256: projectHash },
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
    if (publishedBackupPath && existingProjectPath && importedProjectHash
      && await hashFile(existingProjectPath).catch(() => undefined) === importedProjectHash) {
      const restorePath = join(dirname(existingProjectPath), `.spine2d-restore-${randomUUID()}.spine`);
      try {
        await copyFile(publishedBackupPath, restorePath, constants.COPYFILE_EXCL);
        await rename(restorePath, existingProjectPath);
      } finally {
        await rm(restorePath, { force: true }).catch(() => undefined);
      }
    }
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
