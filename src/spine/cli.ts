import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { SpineError, requireObject } from "./errors.js";
import { readDocument, requireEditableVersion } from "./document.js";
import { validateDocument } from "./validate.js";

export interface CliResult {
  executable: string;
  arguments: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

function sanitizeCliOutput(output: string): string {
  const lines = output.split(/\r?\n/);
  const sanitized: string[] = [];
  let skipHolderLines = 0;
  for (const line of lines) {
    if (/^\s*Licensed to\s*:/i.test(line)) {
      sanitized.push("Licensed to: [redacted]");
      skipHolderLines = /^\s*Licensed to\s*:\s*$/i.test(line) ? 2 : 0;
      continue;
    }
    if (skipHolderLines > 0) {
      skipHolderLines -= 1;
      continue;
    }
    sanitized.push(line.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]"));
  }
  return sanitized.join("\n");
}

async function executable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findSpineCli(): Promise<string> {
  const names = process.platform === "win32" ? ["Spine.com", "Spine.exe"] : ["Spine.sh", "Spine"];
  if (process.env.SPINE_CLI_PATH) {
    const configured = resolve(process.env.SPINE_CLI_PATH);
    if (await executable(configured)) return configured;
    for (const name of names) {
      const candidate = join(configured, name);
      if (await executable(candidate)) return candidate;
    }
    throw new SpineError("SPINE_CLI_UNAVAILABLE", `Configured Spine CLI executable or directory was not found: ${configured}.`);
  }
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    if (!folder) continue;
    for (const name of names) {
      const candidate = join(folder, name);
      if (await executable(candidate)) return candidate;
    }
  }
  throw new SpineError("SPINE_CLI_UNAVAILABLE", "Spine CLI was not found. Set SPINE_CLI_PATH to the Spine command line executable.");
}

export async function runSpineCli(args: string[], timeoutMs = 120_000, editorVersion?: string,
  display?: string): Promise<CliResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new SpineError("INVALID_TIMEOUT", "CLI timeout must be between 1,000 and 600,000 ms.");
  }
  if (editorVersion && !/^(?:\d+\.\d+(?:\.(?:\d+|xx))?|stable|latest|lateststable|latestbeta)$/.test(editorVersion)) {
    throw new SpineError("INVALID_VERSION", `Invalid Spine editor version: ${editorVersion}.`);
  }
  if (display !== undefined && (!display || display.length > 255 || display.includes("\0"))) {
    throw new SpineError("INVALID_DISPLAY", "display must be a nonempty X11 display name without NUL bytes.");
  }
  const executablePath = await findSpineCli();
  const allArgs = editorVersion ? ["--update", editorVersion, ...args] : args;
  return new Promise<CliResult>((resolveResult, rejectResult) => {
    const child = spawn(executablePath, allArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      env: display === undefined ? process.env : { ...process.env, DISPLAY: display } });
    let stdout = "";
    let stderr = "";
    let completed = false;
    const limit = 2 * 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill();
      finish(new SpineError("SPINE_CLI_TIMEOUT", `Spine CLI exceeded ${timeoutMs} ms.`, { arguments: allArgs }));
    }, timeoutMs);
    const finish = (error?: SpineError, code?: number) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (error) rejectResult(error);
      else resolveResult({ executable: executablePath, arguments: allArgs, stdout: sanitizeCliOutput(stdout), stderr: sanitizeCliOutput(stderr), exitCode: code ?? 0 });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > limit) {
        child.kill();
        finish(new SpineError("SPINE_CLI_OUTPUT_LIMIT", "Spine CLI stdout exceeded 2 MB."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > limit) {
        child.kill();
        finish(new SpineError("SPINE_CLI_OUTPUT_LIMIT", "Spine CLI stderr exceeded 2 MB."));
      }
    });
    child.on("error", (error) => finish(new SpineError("SPINE_CLI_START_FAILED", `Cannot start Spine CLI: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const details = { stdout: sanitizeCliOutput(stdout).slice(-4000), stderr: sanitizeCliOutput(stderr).slice(-4000),
          arguments: allArgs, exitCode: code };
        if (/Unable to create the OpenGL display|Error initializing the OpenGL display|No X11 DISPLAY variable|awt\.Headless/i.test(`${stdout}\n${stderr}`)) {
          finish(new SpineError("SPINE_DISPLAY_UNAVAILABLE",
            "Spine could not open an OpenGL display. Set DISPLAY for the MCP server or pass display to the render tool; the display must be accessible and support OpenGL.", details));
        } else finish(new SpineError("SPINE_CLI_FAILED", `Spine CLI exited with code ${String(code)}.`, details));
      }
      else finish(undefined, code ?? 0);
    });
  });
}

async function filesUnder(path: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

export async function projectInfo(inputPath: string, editorVersion?: string, timeoutMs?: number) {
  const cli = await runSpineCli(["--input", resolve(inputPath)], timeoutMs, editorVersion);
  return { inputPath: resolve(inputPath), stdout: cli.stdout, stderr: cli.stderr, executable: cli.executable, exitCode: cli.exitCode };
}

export async function exportData(inputPath: string, settingsPath: string, outputDir: string, editorVersion: string, timeoutMs?: number) {
  const settingsText = await readFile(resolve(settingsPath), "utf8").catch((error: unknown) => {
    throw new SpineError("EXPORT_SETTINGS_READ_FAILED", `Cannot read export settings: ${String(error)}`);
  });
  let parsed: unknown;
  try { parsed = JSON.parse(settingsText); }
  catch { throw new SpineError("INVALID_EXPORT_SETTINGS", "Saved Spine export settings are not valid JSON."); }
  const settings = requireObject(parsed, "/exportSettings");
  if (settings.class !== "export-json" || settings.nonessential !== true) {
    throw new SpineError("UNSAFE_EXPORT_SETTINGS", "Current Spine JSON export settings must use class export-json and enable nonessential data for editor reimport.");
  }
  const outputRoot = resolve(outputDir);
  await mkdir(outputRoot, { recursive: true });
  const exportDir = await mkdtemp(join(outputRoot, "spine-data-export-"));
  try {
    const cli = await runSpineCli(["--input", resolve(inputPath), "--output", exportDir, "--export", resolve(settingsPath)], timeoutMs, editorVersion);
    const files = (await filesUnder(exportDir)).filter((file) => extname(file).toLowerCase() === ".json");
    if (files.length === 0) throw new SpineError("NO_EXPORT_OUTPUT", "Spine CLI completed without creating JSON data files.", { stdout: cli.stdout, stderr: cli.stderr });
    return { inputPath: resolve(inputPath), exportDir, files, cli };
  } catch (error) {
    await rm(exportDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

const mediaExtensions: Record<string, string> = {
  "export-png": ".png", "export-jpg": ".jpg", "export-jpeg": ".jpg",
  "export-gif": ".gif", "export-apng": ".png", "export-psd": ".psd",
  "export-avi": ".avi", "export-mov": ".mov", "export-webm": ".webm",
};

export async function exportMedia(inputPath: string, settingsPath: string, outputDir: string,
  editorVersion: string, fileName?: string, timeoutMs?: number) {
  const input = resolve(inputPath);
  if (!(await stat(input).catch(() => undefined))?.isFile()
    || ![".spine", ".json", ".skel"].includes(extname(input).toLowerCase())) {
    throw new SpineError("INPUT_NOT_FOUND", `Spine project or data input does not exist: ${input}.`);
  }
  let settings: Record<string, unknown>;
  try {
    settings = requireObject(JSON.parse(await readFile(resolve(settingsPath), "utf8")), "/exportSettings");
  } catch {
    throw new SpineError("INVALID_EXPORT_SETTINGS", "Saved Spine media export settings must be readable JSON.");
  }
  const mediaClass = settings.class;
  const extension = typeof mediaClass === "string" ? mediaExtensions[mediaClass] : undefined;
  if (!extension) {
    throw new SpineError("UNSUPPORTED_EXPORT_SETTINGS", "Saved settings must use a supported Spine image or video export class.");
  }
  if (fileName && (!/^[^/\\\0]+$/.test(fileName) || fileName === "." || fileName === ".."
    || extname(fileName).toLowerCase() !== extension)) {
    throw new SpineError("INVALID_MEDIA_NAME", `fileName must be one filename ending in ${extension}.`);
  }
  const outputRoot = resolve(outputDir);
  await mkdir(outputRoot, { recursive: true });
  const mediaDir = await mkdtemp(join(outputRoot, "spine-media-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "spine2d-media-settings-"));
  try {
    const temporarySettings = join(settingsDir, "media.export.json");
    await writeFile(temporarySettings, `${JSON.stringify({ ...settings, open: false }, null, 2)}\n`);
    const single = !["export-png", "export-jpg", "export-jpeg"].includes(mediaClass as string);
    const destination = fileName || single ? join(mediaDir, fileName ?? `export${extension}`) : mediaDir;
    const cli = await runSpineCli(["--input", input, "--output", destination, "--export", temporarySettings],
      timeoutMs, editorVersion);
    const files = await filesUnder(mediaDir);
    if (files.length === 0) {
      throw new SpineError("NO_MEDIA_OUTPUT", "Spine CLI completed without creating media files.",
        { stdout: cli.stdout, stderr: cli.stderr });
    }
    return { inputPath: input, settingsPath: resolve(settingsPath), mediaClass,
      mediaDir, files, cli };
  } catch (error) {
    await rm(mediaDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(settingsDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function packAtlas(imagesDir: string, outputDir: string, name: string, editorVersion: string,
  settingsPath?: string, timeoutMs?: number) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)) {
    throw new SpineError("INVALID_ATLAS_NAME", "Atlas name must use 1–128 letters, digits, underscores, or hyphens and start with a letter or digit.");
  }
  const input = resolve(imagesDir);
  if (!(await stat(input).catch(() => undefined))?.isDirectory()) {
    throw new SpineError("IMAGES_DIR_NOT_FOUND", `Image directory does not exist: ${input}.`);
  }
  if (!(await filesUnder(input)).some((file) => extname(file).toLowerCase() === ".png")) {
    throw new SpineError("NO_INPUT_IMAGES", `Image directory has no PNG files: ${input}.`);
  }
  const outputRoot = resolve(outputDir);
  const outputRelative = relative(input, outputRoot);
  if (!outputRelative || outputRelative === "." || (!isAbsolute(outputRelative)
    && !outputRelative.startsWith(`..${sep}`) && outputRelative !== "..")) {
    throw new SpineError("INVALID_OUTPUT_PATH", "Atlas output directory must be outside the input image directory.");
  }
  if (settingsPath) {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(resolve(settingsPath), "utf8")); }
    catch { throw new SpineError("INVALID_PACK_SETTINGS", "Saved Spine pack settings must be readable JSON."); }
    requireObject(parsed, "/packSettings");
  }
  await mkdir(outputRoot, { recursive: true });
  const atlasDir = await mkdtemp(join(outputRoot, "spine-atlas-"));
  try {
    const cli = await runSpineCli(["--input", input, "--output", atlasDir, "--name", name,
      "--pack", settingsPath ? resolve(settingsPath) : name], timeoutMs, editorVersion);
    const files = await filesUnder(atlasDir);
    const atlasFiles = files.filter((file) => extname(file).toLowerCase() === ".atlas");
    const textureFiles = files.filter((file) => extname(file).toLowerCase() === ".png");
    if (atlasFiles.length === 0 || textureFiles.length === 0) {
      throw new SpineError("NO_ATLAS_OUTPUT", "Spine CLI completed without creating an atlas and texture PNG.",
        { stdout: cli.stdout, stderr: cli.stderr });
    }
    return { imagesDir: input, atlasDir, name, atlasFiles, textureFiles, cli };
  } catch (error) {
    await rm(atlasDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function unpackAtlas(atlasPath: string, outputDir: string, editorVersion: string, timeoutMs?: number) {
  const atlas = resolve(atlasPath);
  if (extname(atlas).toLowerCase() !== ".atlas" || !(await stat(atlas).catch(() => undefined))?.isFile()) {
    throw new SpineError("ATLAS_NOT_FOUND", `Atlas file does not exist: ${atlas}.`);
  }
  const inputDir = dirname(atlas);
  const outputRoot = resolve(outputDir);
  const outputRelative = relative(inputDir, outputRoot);
  if (!outputRelative || outputRelative === "." || (!isAbsolute(outputRelative)
    && !outputRelative.startsWith(`..${sep}`) && outputRelative !== "..")) {
    throw new SpineError("INVALID_OUTPUT_PATH", "Unpacked images must be written outside the atlas input directory.");
  }
  await mkdir(outputRoot, { recursive: true });
  const unpackDir = await mkdtemp(join(outputRoot, "spine-unpacked-"));
  try {
    const cli = await runSpineCli(["--input", inputDir, "--output", unpackDir, "--unpack", atlas], timeoutMs, editorVersion);
    const images = (await filesUnder(unpackDir)).filter((file) => extname(file).toLowerCase() === ".png");
    if (images.length === 0) {
      throw new SpineError("NO_UNPACK_OUTPUT", "Spine CLI completed without creating unpacked PNG files.",
        { stdout: cli.stdout, stderr: cli.stderr });
    }
    return { atlasPath: atlas, unpackDir, images, cli };
  } catch (error) {
    await rm(unpackDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function importData(dataPath: string, outputProjectPath: string, skeletonName: string | undefined, editorVersion: string, timeoutMs?: number) {
  const document = await readDocument(dataPath);
  requireEditableVersion(document);
  const diagnostics = validateDocument(document);
  if (diagnostics.some((item) => item.severity === "error")) {
    throw new SpineError("VALIDATION_FAILED", "The JSON export has validation errors and cannot be imported safely.", { diagnostics });
  }
  const majorMinor = document.version.match(/^(\d+\.\d+)/)?.[1];
  const requestedMajorMinor = editorVersion.match(/^(\d+\.\d+)(?:\.|$)/)?.[1];
  if (!majorMinor || requestedMajorMinor !== majorMinor) {
    throw new SpineError("VERSION_MISMATCH", `JSON version ${document.version} does not match requested editor version ${editorVersion}.`);
  }
  const outputPath = resolve(outputProjectPath);
  if (extname(outputPath).toLowerCase() !== ".spine") throw new SpineError("INVALID_OUTPUT_PATH", "Imported project output must end in .spine.");
  try {
    await access(outputPath, constants.F_OK);
    throw new SpineError("OUTPUT_EXISTS", `Project output already exists: ${outputPath}.`);
  } catch (error) {
    if (error instanceof SpineError) throw error;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryProject = join(dirname(outputPath), `.spine2d-import-${randomUUID()}.spine`);
  const args = ["--input", document.path, "--output", temporaryProject, "--import", ...(skeletonName ? [skeletonName] : [])];
  try {
    const cli = await runSpineCli(args, timeoutMs, editorVersion);
    await access(temporaryProject, constants.F_OK).catch(() => { throw new SpineError("NO_IMPORT_OUTPUT", "Spine CLI completed without creating the requested project."); });
    try {
      await link(temporaryProject, outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SpineError("OUTPUT_EXISTS", `Project output already exists: ${outputPath}.`);
      throw error;
    }
    return { dataPath: document.path, outputProjectPath: outputPath, sourceHash: document.hash, cli };
  } finally {
    await rm(temporaryProject, { force: true }).catch(() => undefined);
  }
}

export async function cleanupAnimations(projectPath: string, outputProjectPath: string, editorVersion: string, timeoutMs?: number) {
  const source = resolve(projectPath);
  const output = resolve(outputProjectPath);
  if (extname(source).toLowerCase() !== ".spine" || !(await stat(source).catch(() => undefined))?.isFile()) {
    throw new SpineError("PROJECT_NOT_FOUND", `Spine project does not exist: ${source}.`);
  }
  if (extname(output).toLowerCase() !== ".spine" || output === source) {
    throw new SpineError("INVALID_OUTPUT_PATH", "Cleanup output must be a different .spine project path.");
  }
  try {
    await access(output, constants.F_OK);
    throw new SpineError("OUTPUT_EXISTS", `Project output already exists: ${output}.`);
  } catch (error) {
    if (error instanceof SpineError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const before = await readFile(source);
  const inputHash = createHash("sha256").update(before).digest("hex");
  await mkdir(dirname(output), { recursive: true });
  const temporary = join(dirname(source), `.spine2d-clean-${randomUUID()}.spine`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    if (!before.equals(await readFile(temporary))) {
      throw new SpineError("SOURCE_CHANGED", "Project changed while preparing animation cleanup.");
    }
    const cli = await runSpineCli(["--input", temporary, "--clean"], timeoutMs, editorVersion);
    const cleaned = await readFile(temporary);
    try {
      await link(temporary, output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SpineError("OUTPUT_EXISTS", `Project output already exists: ${output}.`);
      throw error;
    }
    return { projectPath: source, outputProjectPath: output, sourceHash: inputHash,
      outputHash: createHash("sha256").update(cleaned).digest("hex"), changed: !before.equals(cleaned), cli };
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export interface RenderPreviewInput {
  inputPath: string;
  settingsPath: string;
  outputDir: string;
  animation: string;
  skeleton?: string;
  skin?: string;
  frameStart?: number;
  frameEnd?: number;
  fps?: number;
  renderBones?: boolean;
  display?: string;
  editorVersion?: string;
  timeoutMs?: number;
}

export async function renderPreview(input: RenderPreviewInput) {
  const settingsText = await readFile(resolve(input.settingsPath), "utf8").catch((error: unknown) => {
    throw new SpineError("EXPORT_SETTINGS_READ_FAILED", `Cannot read export settings: ${String(error)}`);
  });
  let parsed: unknown;
  try { parsed = JSON.parse(settingsText); }
  catch { throw new SpineError("INVALID_EXPORT_SETTINGS", "Saved Spine export settings are not valid JSON."); }
  const settings = requireObject(parsed, "/exportSettings");
  if (settings.class !== "export-png" && settings.class !== "images") {
    throw new SpineError("UNSUPPORTED_EXPORT_SETTINGS", "Preview rendering requires PNG export settings (class: export-png or legacy images).");
  }
  if (settings.class === "images" && settings.imageType !== undefined
    && (typeof settings.imageType !== "string" || settings.imageType.toUpperCase() !== "PNG")) {
    throw new SpineError("UNSUPPORTED_EXPORT_SETTINGS", "Legacy image export settings must use imageType: PNG for a PNG preview.");
  }
  if (input.frameStart !== undefined && input.frameEnd !== undefined && input.frameEnd < input.frameStart) {
    throw new SpineError("INVALID_RANGE", "frameEnd must be greater than or equal to frameStart.");
  }
  // Spine uses the JSON filename as the skeleton name when loading exported data.
  // Staged previews use temporary filenames, so saved project selections cannot
  // be reused for those inputs.
  const sourceExtension = extname(input.inputPath).toLowerCase();
  const skeleton = sourceExtension === ".json" ? basename(input.inputPath, extname(input.inputPath)) : input.skeleton;
  const configured = {
    ...settings,
    class: "export-png",
    exportType: "animation",
    animationType: "single",
    animation: input.animation,
    renderImages: true,
    open: false,
    ...(skeleton ? { skeletonType: "single", skeleton } : {}),
    ...(input.skin ? { skinType: "single", skin: input.skin }
      : settings.class === "images" && typeof settings.skin === "string" && settings.skin.toLowerCase() !== "current"
        ? { skinType: "single", skin: settings.skin } : {}),
    ...(input.frameStart === undefined ? {} : { rangeStart: input.frameStart }),
    ...(input.frameEnd === undefined ? {} : { rangeEnd: input.frameEnd }),
    ...(input.fps === undefined ? {} : { fps: input.fps }),
    ...(input.renderBones === undefined
      ? settings.class === "images" && typeof settings.bones === "boolean" ? { renderBones: settings.bones } : {}
      : { renderBones: input.renderBones }),
  };
  const outputRoot = resolve(input.outputDir);
  await mkdir(outputRoot, { recursive: true });
  const previewDir = await mkdtemp(join(outputRoot, "spine-preview-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "spine2d-export-settings-"));
  const temporarySettings = join(settingsDir, "preview.export.json");
  try {
    await writeFile(temporarySettings, `${JSON.stringify(configured, null, 2)}\n`);
    const cli = await runSpineCli(["--input", resolve(input.inputPath), "--output", previewDir, "--export", temporarySettings], input.timeoutMs, input.editorVersion, input.display);
    const files = await filesUnder(previewDir);
    const frameOrder = new Intl.Collator(undefined, { numeric: true });
    const images = files.filter((file) => extname(file).toLowerCase() === ".png")
      .sort((left, right) => frameOrder.compare(left, right));
    if (images.length === 0) throw new SpineError("NO_RENDER_OUTPUT", "Spine CLI completed without creating PNG preview files.", { stdout: cli.stdout, stderr: cli.stderr });
    const fps = typeof configured.fps === "number" && Number.isFinite(configured.fps) && configured.fps > 0
      ? configured.fps : undefined;
    const frameStart = typeof configured.rangeStart === "number" && Number.isInteger(configured.rangeStart)
      && configured.rangeStart >= 0 ? configured.rangeStart : 0;
    const skin = configured.skinType === "single" && typeof configured.skin === "string" ? configured.skin : undefined;
    return {
      inputPath: resolve(input.inputPath), animation: input.animation, previewDir,
      frames: images.map((path) => ({ path, name: basename(path) })),
      frameTimes: fps === undefined ? undefined : images.map((_path, index) => (frameStart + index) / fps),
      fps,
      frameStart,
      skin,
      cli: { executable: cli.executable, exitCode: cli.exitCode, stdout: cli.stdout, stderr: cli.stderr },
    };
  } catch (error) {
    await rm(previewDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(settingsDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
