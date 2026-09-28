import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

import { exportData, exportMedia, packAtlas } from "./cli.js";
import { readDocument } from "./document.js";
import { SpineError } from "./errors.js";

type JsonRecord = Record<string, unknown>;
type SettingKind = "data" | "media" | "atlas";
type SettingsPaths = Partial<Record<SettingKind, string>>;
export interface ExportProfile {
  schemaVersion: 1;
  name: string;
  editorVersion: "4.2" | "4.3";
  runtimeVersion: string;
  savedAt: string;
  settings: Partial<Record<SettingKind, JsonRecord>>;
  settingsHashes: Partial<Record<SettingKind, string>>;
}

const MEDIA_CLASSES = new Set(["export-png", "export-jpg", "export-jpeg", "export-gif", "export-apng",
  "export-psd", "export-avi", "export-mov", "export-webm"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SETTINGS_BYTES = 1024 * 1024;

function object(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function location(workspaceDir: string, name?: string): string {
  if (!workspaceDir.trim()) throw new SpineError("INVALID_PROFILE_DIRECTORY", "A workspace directory is required.");
  const folder = join(resolve(workspaceDir), ".spine2d-mcp", "profiles");
  if (name === undefined) return folder;
  if (!NAME.test(name)) throw new SpineError("INVALID_PROFILE_NAME", "Profile name must use 1–64 letters, digits, underscores, or hyphens.");
  return join(folder, `${name}.json`);
}
function checkVersion(editorVersion: unknown, runtimeVersion: unknown): asserts editorVersion is "4.2" | "4.3" {
  if (editorVersion !== "4.2" && editorVersion !== "4.3") {
    throw new SpineError("UNSUPPORTED_VERSION", "Export profiles currently support Spine editor 4.2 or 4.3.");
  }
  if (typeof runtimeVersion !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(runtimeVersion)
    || runtimeVersion.match(/^\d+\.\d+/)?.[0] !== editorVersion) {
    throw new SpineError("PROFILE_VERSION_MISMATCH", "The target runtime must match the editor major and minor version.");
  }
}
function checkSettings(kind: SettingKind, value: unknown): JsonRecord {
  if (!object(value)) throw new SpineError("INVALID_PROFILE_SETTINGS", `${kind} settings must be a JSON object.`);
  if (kind === "data" && (value.class !== "export-json" || value.nonessential !== true)) {
    throw new SpineError("UNSAFE_EXPORT_SETTINGS", "Data profiles require class export-json and nonessential: true.");
  }
  if (kind === "media" && !MEDIA_CLASSES.has(String(value.class))) {
    throw new SpineError("UNSUPPORTED_EXPORT_SETTINGS", "Media profiles require a supported Spine image or video export class.");
  }
  return value;
}
function checkDataVersion(settings: JsonRecord | undefined, runtimeVersion: string): void {
  if (!settings || settings.version === null || settings.version === undefined || settings.version === "") return;
  if (typeof settings.version !== "string"
    || settings.version.match(/^\d+\.\d+/)?.[0] !== runtimeVersion.match(/^\d+\.\d+/)?.[0]) {
    throw new SpineError("PROFILE_VERSION_MISMATCH", "Saved JSON export version must match the target runtime major and minor version.");
  }
}
async function readSettings(kind: SettingKind, path: string): Promise<{ value: JsonRecord; settingsHash: string }> {
  let content: Buffer;
  try { content = await readFile(resolve(path)); }
  catch { throw new SpineError("PROFILE_SETTINGS_READ_FAILED", `Cannot read ${kind} settings at ${resolve(path)}.`); }
  if (content.length > MAX_SETTINGS_BYTES) throw new SpineError("PROFILE_SETTINGS_TOO_LARGE", `${kind} settings exceed 1 MB.`);
  let parsed: unknown;
  try { parsed = JSON.parse(content.toString("utf8")); }
  catch { throw new SpineError("INVALID_PROFILE_SETTINGS", `${kind} settings are not valid JSON.`); }
  const value = checkSettings(kind, parsed);
  return { value, settingsHash: hash(JSON.stringify(value)) };
}
function profileSummary(profile: ExportProfile, profilePath: string) {
  return { profilePath, name: profile.name, editorVersion: profile.editorVersion,
    runtimeVersion: profile.runtimeVersion, savedAt: profile.savedAt,
    steps: Object.keys(profile.settings), settingsHashes: profile.settingsHashes };
}
async function existingDirectory(path: string): Promise<void> {
  if (!(await stat(resolve(path)).catch(() => undefined))?.isDirectory()) {
    throw new SpineError("WORKSPACE_NOT_FOUND", `Workspace directory does not exist: ${resolve(path)}.`);
  }
}

export async function saveExportProfile(workspaceDir: string, name: string, editorVersion: "4.2" | "4.3",
  runtimeVersion: string, settingsPaths: SettingsPaths) {
  const profilePath = location(workspaceDir, name);
  await existingDirectory(workspaceDir);
  checkVersion(editorVersion, runtimeVersion);
  const kinds: SettingKind[] = ["data", "media", "atlas"];
  if (!kinds.some((kind) => settingsPaths[kind])) {
    throw new SpineError("EMPTY_EXPORT_PROFILE", "Provide at least one data, media, or atlas settings path.");
  }
  const settings: ExportProfile["settings"] = {};
  const settingsHashes: ExportProfile["settingsHashes"] = {};
  for (const kind of kinds) {
    const path = settingsPaths[kind];
    if (!path) continue;
    const loaded = await readSettings(kind, path);
    settings[kind] = loaded.value;
    settingsHashes[kind] = loaded.settingsHash;
  }
  checkDataVersion(settings.data, runtimeVersion);
  const profile: ExportProfile = { schemaVersion: 1, name, editorVersion, runtimeVersion,
    savedAt: new Date().toISOString(), settings, settingsHashes };
  await mkdir(location(workspaceDir), { recursive: true });
  try { await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SpineError("PROFILE_EXISTS", `Export profile ${name} already exists.`);
    }
    throw error;
  }
  return profileSummary(profile, profilePath);
}

async function load(workspaceDir: string, name: string): Promise<{ profile: ExportProfile; profilePath: string; profileHash: string }> {
  const profilePath = location(workspaceDir, name);
  let content: string;
  try { content = await readFile(profilePath, "utf8"); }
  catch { throw new SpineError("PROFILE_NOT_FOUND", `Export profile ${name} was not found.`); }
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new SpineError("INVALID_EXPORT_PROFILE", `Export profile ${name} is not valid JSON.`); }
  if (!object(parsed) || parsed.schemaVersion !== 1 || parsed.name !== name || !object(parsed.settings)
    || !object(parsed.settingsHashes) || typeof parsed.savedAt !== "string") {
    throw new SpineError("INVALID_EXPORT_PROFILE", `Export profile ${name} has an invalid structure.`);
  }
  checkVersion(parsed.editorVersion, parsed.runtimeVersion);
  const settings = parsed.settings as ExportProfile["settings"];
  if (!["data", "media", "atlas"].some((kind) => settings[kind as SettingKind])) {
    throw new SpineError("INVALID_EXPORT_PROFILE", `Export profile ${name} has no settings.`);
  }
  for (const kind of ["data", "media", "atlas"] as SettingKind[]) {
    if (settings[kind] === undefined) continue;
    checkSettings(kind, settings[kind]);
    if (parsed.settingsHashes[kind] !== hash(JSON.stringify(settings[kind]))) {
      throw new SpineError("PROFILE_SETTINGS_CHANGED", `Saved ${kind} settings no longer match the profile snapshot hash.`);
    }
  }
  checkDataVersion(settings.data, parsed.runtimeVersion as string);
  return { profile: parsed as unknown as ExportProfile, profilePath, profileHash: hash(content) };
}
export async function getExportProfile(workspaceDir: string, name: string) {
  const { profile, profilePath, profileHash } = await load(workspaceDir, name);
  return { ...profileSummary(profile, profilePath), profileHash, settings: profile.settings };
}
export async function listExportProfiles(workspaceDir: string) {
  const folder = location(workspaceDir);
  await existingDirectory(workspaceDir);
  const entries = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const profiles = [];
  for (const entry of entries.filter((item) => item.endsWith(".json") && NAME.test(item.slice(0, -5))).sort()) {
    const name = entry.slice(0, -5);
    const { profile, profilePath } = await load(workspaceDir, name);
    profiles.push(profileSummary(profile, profilePath));
  }
  return { workspaceDir: resolve(workspaceDir), profiles };
}
export async function deleteExportProfile(workspaceDir: string, name: string) {
  const { profilePath } = await load(workspaceDir, name);
  await unlink(profilePath);
  return { profilePath, deleted: true };
}

async function hashFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}
async function imageHashes(imagesDir: string): Promise<{ path: string; sha256: string }[]> {
  const root = resolve(imagesDir);
  const files: string[] = [];
  async function visit(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".png") files.push(path);
    }
  }
  await visit(root);
  return await Promise.all(files.sort().map(async (path) => ({ path: relative(root, path), sha256: await hashFile(path) })));
}
export async function runExportProfile(workspaceDir: string, name: string, inputPath: string | undefined,
  outputDir: string, imagesDir?: string, atlasName?: string, timeoutMs?: number) {
  const { profile, profileHash } = await load(workspaceDir, name);
  if ((profile.settings.data || profile.settings.media) && (!inputPath || !(await stat(resolve(inputPath)).catch(() => undefined))?.isFile())) {
    throw new SpineError("INPUT_NOT_FOUND", "Data or media export needs an existing project or data file.");
  }
  if (profile.settings.atlas && (!imagesDir || !(await stat(resolve(imagesDir)).catch(() => undefined))?.isDirectory())) {
    throw new SpineError("IMAGES_DIR_NOT_FOUND", "Atlas export needs an existing images directory.");
  }
  if (inputPath && extname(inputPath).toLowerCase() === ".json") {
    const document = await readDocument(inputPath);
    if (document.version.match(/^\d+\.\d+/)?.[0] !== profile.editorVersion) {
      throw new SpineError("PROFILE_VERSION_MISMATCH", `Input JSON version ${document.version} does not match profile editor version ${profile.editorVersion}.`);
    }
  }
  const inputHash = inputPath ? await hashFile(inputPath) : undefined;
  const atlasInputs = profile.settings.atlas ? await imageHashes(imagesDir!) : undefined;
  const outputRoot = resolve(outputDir);
  await mkdir(outputRoot, { recursive: true });
  const runDir = await mkdtemp(join(outputRoot, "spine-profile-"));
  try {
    const settingsDir = join(runDir, "settings");
    await mkdir(settingsDir);
    const settingsPaths: SettingsPaths = {};
    for (const kind of ["data", "media", "atlas"] as SettingKind[]) {
      if (!profile.settings[kind]) continue;
      settingsPaths[kind] = join(settingsDir, `${kind}.json`);
      await writeFile(settingsPaths[kind]!, `${JSON.stringify(profile.settings[kind], null, 2)}\n`, { flag: "wx" });
    }
    const results: Record<string, unknown> = {};
    const outputs: string[] = [];
    if (settingsPaths.data) {
      const result = await exportData(inputPath!, settingsPaths.data, join(runDir, "data"), profile.editorVersion, timeoutMs);
      results.data = { exportDir: result.exportDir, files: result.files, exitCode: result.cli.exitCode };
      outputs.push(...result.files);
    }
    if (settingsPaths.media) {
      const result = await exportMedia(inputPath!, settingsPaths.media, join(runDir, "media"), profile.editorVersion, undefined, timeoutMs);
      results.media = { mediaDir: result.mediaDir, files: result.files, exitCode: result.cli.exitCode };
      outputs.push(...result.files);
    }
    if (settingsPaths.atlas) {
      const result = await packAtlas(imagesDir!, join(runDir, "atlas"), atlasName ?? profile.name,
        profile.editorVersion, settingsPaths.atlas, timeoutMs);
      results.atlas = { atlasDir: result.atlasDir, atlasFiles: result.atlasFiles,
        textureFiles: result.textureFiles, exitCode: result.cli.exitCode };
      outputs.push(...result.atlasFiles, ...result.textureFiles);
    }
    if (inputPath && await hashFile(inputPath) !== inputHash
      || imagesDir && atlasInputs && JSON.stringify(await imageHashes(imagesDir)) !== JSON.stringify(atlasInputs)) {
      throw new SpineError("SOURCE_CHANGED", "An export input changed while the profile was running.");
    }
    const manifest = { name: profile.name, editorVersion: profile.editorVersion,
      runtimeVersion: profile.runtimeVersion, profileHash, settingsHashes: profile.settingsHashes,
      inputPath: inputPath ? resolve(inputPath) : undefined, inputHash,
      imagesDir: imagesDir ? resolve(imagesDir) : undefined, atlasInputs, createdAt: new Date().toISOString(),
      results, outputs: await Promise.all(outputs.map(async (path) => ({ path, sha256: await hashFile(path) }))) };
    const manifestPath = join(runDir, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    return { runDir, manifestPath, name: profile.name, editorVersion: profile.editorVersion,
      runtimeVersion: profile.runtimeVersion, profileHash, steps: Object.keys(results),
      outputCount: manifest.outputs.length,
      ...(manifest.outputs.length <= 8 ? { outputPaths: manifest.outputs.map((entry) => entry.path) } : {}) };
  } catch (error) {
    await rm(runDir, { recursive: true, force: true });
    throw error;
  }
}
