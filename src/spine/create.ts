import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { importData } from "./cli.js";
import { parseDocument, requireEditableVersion } from "./document.js";
import { SpineError } from "./errors.js";
import { validateDocument } from "./validate.js";

export interface SkeletonOptions {
  rootBoneName?: string;
  fps?: number;
  imagesPath?: string;
  audioPath?: string;
}

function validateVersion(version: string): void {
  if (!/^4\.(?:2|3)(?:\.\d+)?$/.test(version)) {
    throw new SpineError("UNSUPPORTED_VERSION", "New skeletons require a Spine 4.2 or 4.3 version, optionally with a numeric patch version.");
  }
}

export function skeletonText(version: string, options: SkeletonOptions = {}): string {
  validateVersion(version);
  const rootBoneName = options.rootBoneName ?? "root";
  if (typeof rootBoneName !== "string" || !rootBoneName.trim()) throw new SpineError("INVALID_NAME", "Root bone name must be nonempty.");
  const fps = options.fps ?? 30;
  if (!Number.isInteger(fps) || fps < 1 || fps > 240) throw new SpineError("INVALID_FPS", "Skeleton FPS must be an integer from 1 to 240.");
  const imagesPath = options.imagesPath ?? "./images/";
  const audioPath = options.audioPath;
  for (const [field, value] of [["imagesPath", imagesPath], ["audioPath", audioPath]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.includes("\0"))) {
      throw new SpineError("INVALID_PATH", `${field} must be a nonempty path without NUL characters.`);
    }
  }
  const data = {
    skeleton: { spine: version, fps, images: imagesPath, ...(audioPath === undefined ? {} : { audio: audioPath }) },
    bones: [{ name: rootBoneName }],
    slots: [],
    skins: [{ name: "default", attachments: {} }],
    animations: {},
  };
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const document = parseDocument("/new-skeleton.json", text);
  requireEditableVersion(document);
  const diagnostics = validateDocument(document);
  if (diagnostics.some((item) => item.severity === "error")) {
    throw new SpineError("VALIDATION_FAILED", "Generated skeleton data failed validation.", { diagnostics });
  }
  return text;
}

async function requireNewPath(path: string, extension: string): Promise<string> {
  const full = resolve(path);
  if (extname(full).toLowerCase() !== extension) throw new SpineError("INVALID_OUTPUT_PATH", `Output path must end in ${extension}.`);
  try {
    await access(full, constants.F_OK);
    throw new SpineError("OUTPUT_EXISTS", `Output already exists: ${full}.`);
  } catch (error) {
    if (error instanceof SpineError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return full;
}

async function linkNew(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SpineError("OUTPUT_EXISTS", `Output already exists: ${destination}.`);
    throw error;
  }
}

export async function createSkeletonData(dataPath: string, version: string, options: SkeletonOptions = {}) {
  const text = skeletonText(version, options);
  const output = await requireNewPath(dataPath, ".json");
  await mkdir(dirname(output), { recursive: true });
  const temporary = join(dirname(output), `.spine2d-skeleton-${randomUUID()}.json`);
  try {
    await writeFile(temporary, text, { flag: "wx" });
    await linkNew(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  const document = parseDocument(output, text);
  return { dataPath: output, version, rootBoneName: options.rootBoneName ?? "root", sourceHash: document.hash };
}

export interface CreateProjectInput extends SkeletonOptions {
  outputProjectPath: string;
  dataPath?: string;
  editorVersion: string;
  spineVersion?: string;
  skeletonName?: string;
  timeoutMs?: number;
}

export async function createProject(input: CreateProjectInput) {
  const outputProjectPath = await requireNewPath(input.outputProjectPath, ".spine");
  const dataPath = await requireNewPath(input.dataPath ?? join(dirname(outputProjectPath), `${basename(outputProjectPath, ".spine")}.json`), ".json");
  if (dirname(dataPath) !== dirname(outputProjectPath)) {
    throw new SpineError("INVALID_OUTPUT_PATH", "The JSON data path must be beside the new .spine project so relative asset paths remain consistent.");
  }
  const version = input.spineVersion ?? input.editorVersion;
  const text = skeletonText(version, input);
  const skeletonName = input.skeletonName ?? basename(outputProjectPath, ".spine");
  if (!skeletonName.trim()) throw new SpineError("INVALID_NAME", "Skeleton name must be nonempty.");
  await mkdir(dirname(outputProjectPath), { recursive: true });
  const temporary = join(dirname(outputProjectPath), `.spine2d-create-${randomUUID()}.json`);
  let imported = false;
  try {
    await writeFile(temporary, text, { flag: "wx" });
    const result = await importData(temporary, outputProjectPath, skeletonName, input.editorVersion, input.timeoutMs);
    imported = true;
    await linkNew(temporary, dataPath);
    return { dataPath, outputProjectPath, sourceHash: result.sourceHash, version,
      skeletonName, rootBoneName: input.rootBoneName ?? "root", cli: result.cli };
  } catch (error) {
    if (imported) await rm(outputProjectPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
