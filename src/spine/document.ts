import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { SpineError, requireObject } from "./errors.js";

export interface SpineDocument {
  path: string;
  text: string;
  data: Record<string, unknown>;
  version: string;
  hash: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parseDocument(path: string, text: string): SpineDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SpineError("INVALID_JSON", `Cannot parse Spine JSON: ${String(error)}`);
  }
  const data = requireObject(parsed, "/");
  const skeleton = requireObject(data.skeleton, "/skeleton");
  if (typeof skeleton.spine !== "string" || skeleton.spine.length === 0) {
    throw new SpineError("MISSING_VERSION", "The skeleton.spine export version is missing.");
  }
  return { path: resolve(path), text, data, version: skeleton.spine, hash: sha256(text) };
}

export async function readDocument(path: string): Promise<SpineDocument> {
  const resolved = resolve(path);
  let text: string;
  try {
    text = await readFile(resolved, "utf8");
  } catch (error) {
    throw new SpineError("READ_FAILED", `Cannot read ${resolved}: ${String(error)}`);
  }
  return parseDocument(resolved, text);
}

export function requireEditableVersion(document: SpineDocument): void {
  if (!/^4\.(?:2|3)(?:\.|$)/.test(document.version)) {
    throw new SpineError(
      "UNSUPPORTED_VERSION",
      `Editing is supported for tested Spine 4.2 and 4.3 JSON only; found ${document.version}.`,
      { version: document.version, supported: ["4.2", "4.3"] },
    );
  }
}
