import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { readRigManifest, validateRigManifest } from "./landmark-rig.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function rigSignature(document: SpineDocument): string {
  const data = document.data;
  const skeleton = object(data.skeleton);
  return createHash("sha256").update(JSON.stringify({
    version: document.version,
    images: skeleton.images,
    bones: data.bones ?? [], slots: data.slots ?? [], skins: data.skins ?? [],
    ik: data.ik ?? [], transform: data.transform ?? [], path: data.path ?? [], physics: data.physics ?? [],
    constraints: data.constraints ?? [],
  })).digest("hex");
}

function imagePaths(document: SpineDocument): Set<string> {
  const names = new Set<string>();
  for (const skin of Array.isArray(document.data.skins) ? document.data.skins : []) {
    for (const attachments of Object.values(object(object(skin).attachments))) {
      for (const [name, value] of Object.entries(object(attachments))) {
        const attachment = object(value);
        const type = attachment.type;
        if (type !== undefined && type !== "region" && type !== "mesh" && type !== "linkedmesh") continue;
        const path = typeof attachment.path === "string" ? attachment.path : name;
        names.add(path.toLowerCase().endsWith(".png") ? path : `${path}.png`);
      }
    }
  }
  return names;
}

export function attachmentCount(document: SpineDocument): number {
  return imagePaths(document).size;
}

export async function rigArtifactFingerprint(document: SpineDocument): Promise<string> {
  const imagesPath = object(document.data.skeleton).images;
  const imagesDir = resolve(dirname(document.path), typeof imagesPath === "string" ? imagesPath : "./images/");
  const images: [string, string][] = [];
  for (const name of [...imagePaths(document)].sort()) {
    const path = resolve(imagesDir, name);
    if (path !== imagesDir && !path.startsWith(`${imagesDir}/`))
      throw new SpineError("INVALID_IMAGE_PATH", `Image path leaves the images directory: ${name}.`);
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch { throw new SpineError("RIG_IMAGE_CHANGED", `A reviewed rig image is missing: ${path}.`); }
    images.push([name, createHash("sha256").update(bytes).digest("hex")]);
  }
  return createHash("sha256").update(JSON.stringify({ rig: rigSignature(document), imagesDir, images })).digest("hex");
}

export async function requireReviewedRig(document: SpineDocument, reviewed: ReadonlySet<string>): Promise<void> {
  if (attachmentCount(document) < 2) return;
  if (reviewed.size && reviewed.has(await rigArtifactFingerprint(document).catch(() => ""))) return;
  throw new SpineError("RIG_REVIEW_REQUIRED",
    "This multi-part rig has no matching reviewed build in this server session. Assemble and preview it, obtain the user's approval in chat, then build it with the preview reviewId.",
    { path: document.path, attachmentCount: attachmentCount(document) });
}

export async function rigReviewFingerprint(manifestPath: string): Promise<string> {
  const path = resolve(manifestPath);
  const manifest = await readRigManifest(path);
  const checked = await validateRigManifest(manifest, path);
  if (!checked.valid) throw new SpineError("INVALID_RIG_MANIFEST", "Complete the rig before requesting review.", { diagnostics: checked.diagnostics });
  const images = [...checked.images.values()].map(({ image, sha256 }) => [image, sha256]).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify({ manifest, images })).digest("hex");
}
