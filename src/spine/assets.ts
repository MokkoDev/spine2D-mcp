import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function pathStem(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const extension = extname(normalized).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp"].includes(extension)
    ? normalized.slice(0, -extension.length).toLowerCase()
    : normalized.toLowerCase();
}

async function listImages(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  async function visit(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && [".png", ".jpg", ".jpeg", ".webp"].includes(extname(entry.name).toLowerCase())) {
        files.push(relative(directory, full).split(sep).join("/"));
      }
    }
  }
  await visit(directory);
  return files.sort();
}

export async function inspectAssets(document: SpineDocument, overrideImagesDir?: string, atlasPath?: string, limit = 100) {
  const skeleton = object(document.data.skeleton) ?? {};
  const configuredImages = typeof skeleton.images === "string" ? skeleton.images : "./images/";
  const imagesDir = overrideImagesDir
    ? resolve(overrideImagesDir)
    : isAbsolute(configuredImages) ? configuredImages : resolve(dirname(document.path), configuredImages);
  const references: { skin: string; slot: string; attachment: string; image: string }[] = [];
  const skins = Array.isArray(document.data.skins) ? document.data.skins : [];
  for (const skinValue of skins) {
    const skin = object(skinValue);
    if (!skin) continue;
    for (const [slotName, attachments] of Object.entries(object(skin.attachments) ?? {})) {
      for (const [name, value] of Object.entries(object(attachments) ?? {})) {
        const attachment = object(value);
        if (!attachment) continue;
        const type = attachment.type ?? "region";
        if (type !== "region" && type !== "mesh" && !(type === "linkedmesh" && typeof attachment.path === "string")) continue;
        references.push({ skin: String(skin.name ?? ""), slot: slotName, attachment: name, image: String(attachment.path ?? name) });
      }
    }
  }
  const images = await listImages(imagesDir);
  const byStem = new Map(images.map((file) => [pathStem(file), file]));
  const missing = references.filter((reference) => !byStem.has(pathStem(reference.image)));
  const used = new Set(references.map((reference) => pathStem(reference.image)));
  const unused = images.filter((file) => !used.has(pathStem(file)));
  let atlas: { path: string; pages: string[]; missingPages: string[] } | undefined;
  if (atlasPath) {
    const fullPath = resolve(atlasPath);
    let text: string;
    try { text = await readFile(fullPath, "utf8"); }
    catch (error) { throw new SpineError("ATLAS_READ_FAILED", `Cannot read atlas ${fullPath}: ${String(error)}`); }
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const pages = [...new Set(lines.filter((line, index) =>
      (index === 0 || lines[index - 1] === "") && !line.includes(":") && /\.(?:png|jpe?g|webp)$/i.test(line),
    ))];
    atlas = { path: fullPath, pages, missingPages: pages.filter((page) => !existsSync(resolve(dirname(fullPath), page))) };
  }
  return {
    imagesDir,
    referenceCount: references.length,
    references: references.slice(0, limit),
    referencesTruncated: references.length > limit,
    imageCount: images.length,
    missingCount: missing.length,
    missing: missing.slice(0, limit),
    unusedCount: unused.length,
    unused: unused.slice(0, limit),
    resultsTruncated: missing.length > limit || unused.length > limit,
    ...(atlas ? { atlas } : {}),
  };
}
