import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { readDocument, requireEditableVersion } from "./document.js";
import { SpineError } from "./errors.js";
import { validateDocument } from "./validate.js";

export interface PlayerPreviewInput {
  skeletonPath: string;
  atlasPath: string;
  outputDir: string;
  animation?: string;
  skin?: string;
  scale?: number;
  premultipliedAlpha?: boolean;
  debugBones?: boolean;
  runtimeJsPath?: string;
  runtimeCssPath?: string;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function pages(atlas: string): string[] {
  const lines = atlas.split(/\r?\n/).map((line) => line.trim());
  return [...new Set(lines.filter((line, index) =>
    (index === 0 || lines[index - 1] === "") && !line.includes(":") && /\.(?:png|jpe?g|webp)$/i.test(line)))];
}
function within(folder: string, path: string): boolean {
  const result = relative(folder, path);
  return Boolean(result) && !isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`);
}
function mime(path: string): string {
  const extension = extname(path).toLowerCase();
  return extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
}
function safeScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export async function createPlayerPreview(input: PlayerPreviewInput) {
  const document = await readDocument(input.skeletonPath);
  requireEditableVersion(document);
  const diagnostics = validateDocument(document);
  if (diagnostics.some((item) => item.severity === "error")) {
    throw new SpineError("VALIDATION_FAILED", "The skeleton has validation errors and cannot be previewed safely.", { diagnostics });
  }
  if (input.animation && !Object.hasOwn(document.data.animations ?? {}, input.animation)) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${input.animation} was not found.`);
  }
  if (input.skin && !(Array.isArray(document.data.skins) && document.data.skins.some((skin) =>
    skin !== null && typeof skin === "object" && !Array.isArray(skin) && skin.name === input.skin))) {
    throw new SpineError("SKIN_NOT_FOUND", `Skin ${input.skin} was not found.`);
  }
  const scale = input.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 10) {
    throw new SpineError("INVALID_PLAYER_SCALE", "Player scale must be greater than zero and at most ten.");
  }
  if (Boolean(input.runtimeJsPath) !== Boolean(input.runtimeCssPath)) {
    throw new SpineError("INVALID_PLAYER_RUNTIME", "Provide both local player JavaScript and CSS paths, or neither.");
  }
  const atlasPath = resolve(input.atlasPath);
  let atlas: Buffer;
  try { atlas = await readFile(atlasPath); }
  catch { throw new SpineError("ATLAS_NOT_FOUND", `Atlas file was not found: ${atlasPath}.`); }
  const pageNames = pages(atlas.toString("utf8"));
  if (!pageNames.length) throw new SpineError("INVALID_ATLAS", "The atlas has no supported texture pages.");
  const atlasFolder = dirname(atlasPath);
  const pageData: { name: string; path: string; bytes: Buffer }[] = [];
  for (const name of pageNames) {
    const path = resolve(atlasFolder, name);
    if (!within(atlasFolder, path)) {
      throw new SpineError("INVALID_ATLAS_PAGE", `Atlas page ${name} must be inside its atlas directory.`);
    }
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch { throw new SpineError("ATLAS_PAGE_NOT_FOUND", `Atlas page ${name} was not found.`); }
    pageData.push({ name, path, bytes });
  }
  const skeletonBytes = Buffer.from(document.text);
  const totalBytes = skeletonBytes.length + atlas.length + pageData.reduce((sum, page) => sum + page.bytes.length, 0);
  if (totalBytes > 64 * 1024 * 1024) {
    throw new SpineError("PLAYER_BUNDLE_TOO_LARGE", "Embedded skeleton, atlas, and textures exceed 64 MB.");
  }
  const version = document.version.match(/^\d+\.\d+/)?.[0];
  if (version !== "4.2" && version !== "4.3") {
    throw new SpineError("UNSUPPORTED_VERSION", "Web player previews support Spine 4.2 and 4.3 exports.");
  }
  const data: Record<string, string> = {
    [basename(document.path)]: `data:application/json;base64,${skeletonBytes.toString("base64")}`,
    [basename(atlasPath)]: `data:application/octet-stream;base64,${atlas.toString("base64")}`,
  };
  for (const page of pageData) data[page.name] = `data:${mime(page.name)};base64,${page.bytes.toString("base64")}`;
  const useLocal = Boolean(input.runtimeJsPath);
  const runtimeRoot = `https://unpkg.com/@esotericsoftware/spine-player@${version}.*/dist`;
  const jsSource = useLocal ? "./spine-player.js" : `${runtimeRoot}/iife/spine-player.min.js`;
  const cssSource = useLocal ? "./spine-player.css" : `${runtimeRoot}/spine-player.min.css`;
  const config = { skeleton: basename(document.path), atlas: basename(atlasPath), rawDataURIs: data,
    ...(input.animation ? { animation: input.animation } : {}), ...(input.skin ? { skin: input.skin } : {}),
    scale, showControls: true, interactive: true,
    ...(input.premultipliedAlpha !== undefined ? { premultipliedAlpha: input.premultipliedAlpha } : {}),
    ...(input.debugBones ? { debug: { bones: true } } : {}) };
  const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>Spine animation preview</title>\n<link rel="stylesheet" href="${cssSource}">\n<style>html,body{margin:0;width:100%;height:100%;background:#1e1e23}#spine-player{width:100%;height:100%;min-height:480px}</style>\n<script src="${jsSource}"></script>\n</head>\n<body>\n<div id="spine-player"></div>\n<script>new spine.SpinePlayer("spine-player", ${safeScript(config)});</script>\n</body>\n</html>\n`;
  const outputRoot = resolve(input.outputDir);
  await mkdir(outputRoot, { recursive: true });
  const playerDir = await mkdtemp(join(outputRoot, "spine-player-"));
  try {
    const runtimeFiles: { name: string; sha256: string }[] = [];
    if (useLocal) {
      for (const [path, target] of [[input.runtimeJsPath!, "spine-player.js"],
        [input.runtimeCssPath!, "spine-player.css"]] as const) {
        if (!(await stat(resolve(path)).catch(() => undefined))?.isFile()) {
          throw new SpineError("PLAYER_RUNTIME_NOT_FOUND", `Local player runtime file was not found: ${resolve(path)}.`);
        }
        const bytes = await readFile(resolve(path));
        if (bytes.length > 10 * 1024 * 1024) {
          throw new SpineError("PLAYER_RUNTIME_TOO_LARGE", "A local player runtime file exceeds 10 MB.");
        }
        await copyFile(resolve(path), join(playerDir, target));
        runtimeFiles.push({ name: target, sha256: hash(bytes) });
      }
    }
    const htmlPath = join(playerDir, "index.html");
    const manifestPath = join(playerDir, "manifest.json");
    await writeFile(htmlPath, html, { flag: "wx" });
    const manifest = { skeletonPath: document.path, skeletonHash: document.hash, atlasPath, atlasHash: hash(atlas),
      pageHashes: pageData.map((page) => ({ name: page.name, path: page.path, sha256: hash(page.bytes) })),
      playerVersion: version, runtimeSource: useLocal ? "local" : "cdn",
      runtimeJs: jsSource, runtimeCss: cssSource, runtimeFiles, animation: input.animation,
      skin: input.skin, scale, premultipliedAlpha: input.premultipliedAlpha, debugBones: input.debugBones ?? false,
      htmlHash: hash(Buffer.from(html)), createdAt: new Date().toISOString() };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    return { playerDir, htmlPath, manifestPath, atlasPages: pageNames, ...manifest };
  } catch (error) {
    await rm(playerDir, { recursive: true, force: true });
    throw error;
  }
}
