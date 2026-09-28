import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PNG } from "pngjs";

import { importData } from "./cli.js";
import { parseDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { validateDocument, type Diagnostic } from "./validate.js";

export type Point = [number, number];
export interface RigPart {
  id: string; image: string; width: number; height: number; sha256: string;
  parent: { part: string; landmark: string } | null;
  pivot: string; tip: string; landmarks: Record<string, Point>;
  setupRotationDeg: number;
}
export interface RigManifest {
  schemaVersion: 1; spineVersion: "4.2" | "4.3"; imagesDir: string;
  root: { part: string; landmark: string; world: Point };
  parts: RigPart[]; drawOrder: string[];
}
export interface RigDiagnostic { code: string; severity: "error" | "warning"; path: string; message: string }
export interface ImageInfo { image: string; width: number; height: number; sha256: string; opaqueBounds: [number, number, number, number] | null; alpha: Buffer }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const obj = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validPoint = (p: unknown): p is Point => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n));
const safeImage = (name: string) => !!name && !isAbsolute(name) && !name.split(/[\\/]/).includes("..") && !name.includes("\0") && /\.png$/i.test(name);
const fixed = (n: number) => Math.abs(n) < 1e-10 ? 0 : Number(n.toFixed(9));
const rad = (deg: number) => deg * Math.PI / 180;
const deg = (radians: number) => radians * 180 / Math.PI;
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const rotate = (a: Point, angle: number): Point => [a[0] * Math.cos(angle) - a[1] * Math.sin(angle), a[0] * Math.sin(angle) + a[1] * Math.cos(angle)];
const centered = (p: Point, part: RigPart): Point => [p[0] - part.width / 2, part.height / 2 - p[1]];
const ptr = (...parts: (string | number)[]) => `/${parts.map((p) => String(p).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;

export async function readImageInfo(imagesDir: string, image: string): Promise<ImageInfo> {
  if (!safeImage(image)) throw new SpineError("INVALID_IMAGE_PATH", `Invalid PNG path: ${image}.`);
  const base = resolve(imagesDir);
  const path = resolve(base, image);
  const rel = relative(base, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new SpineError("INVALID_IMAGE_PATH", `Image escapes its images directory: ${image}.`);
  const bytes = await readFile(path).catch(() => { throw new SpineError("IMAGE_NOT_FOUND", `Image not found: ${path}.`); });
  let png: PNG;
  try { png = PNG.sync.read(bytes); }
  catch { throw new SpineError("INVALID_IMAGE", `Cannot decode PNG: ${path}.`); }
  let x0 = png.width, y0 = png.height, x1 = -1, y1 = -1;
  const alpha = Buffer.alloc(png.width * png.height);
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const a = png.data[(y * png.width + x) * 4 + 3]; alpha[y * png.width + x] = a;
    if (a > 16) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  return { image, width: png.width, height: png.height, sha256: hash(bytes), opaqueBounds: x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1], alpha };
}
export async function inventoryImages(imagesDir: string): Promise<ImageInfo[]> {
  const base = resolve(imagesDir);
  if (!(await stat(base).catch(() => undefined))?.isDirectory()) throw new SpineError("IMAGES_DIR_NOT_FOUND", `Images directory not found: ${base}.`);
  const names: string[] = [];
  async function visit(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && /\.png$/i.test(entry.name)) names.push(relative(base, full).split(sep).join("/"));
    }
  }
  await visit(base);
  names.sort((a, b) => a.localeCompare(b));
  if (!names.length) throw new SpineError("NO_IMAGES", `No PNGs found in ${base}.`);
  return Promise.all(names.map((name) => readImageInfo(base, name)));
}
export async function suggestRigManifest(imagesDir: string, manifestPath: string, version: "4.2" | "4.3"): Promise<RigManifest> {
  const images = await inventoryImages(imagesDir);
  const used = new Set<string>();
  const parts = images.map((image) => {
    let id = basename(image.image).replace(/\.png$/i, "").replace(/[^a-zA-Z0-9_.-]/g, "_");
    if (!id) id = "part";
    const stem = id; let i = 2;
    while (used.has(id)) id = `${stem}_${i++}`;
    used.add(id);
    const bounds = image.opaqueBounds ?? [0, 0, image.width, image.height];
    const x = (bounds[0] + bounds[2]) / 2;
    return { id, image: image.image, width: image.width, height: image.height, sha256: image.sha256,
      parent: null, pivot: "pivot", tip: "tip", landmarks: { pivot: [x, bounds[1]] as Point, tip: [x, bounds[3]] as Point },
      setupRotationDeg: 0 } satisfies RigPart;
  });
  const rel = relative(dirname(resolve(manifestPath)), resolve(imagesDir)).split(sep).join("/");
  return { schemaVersion: 1, spineVersion: version, imagesDir: rel || ".",
    root: { part: parts[0].id, landmark: "pivot", world: [0, parts[0].height] }, parts,
    drawOrder: parts.map((p) => p.id) };
}
export async function readRigManifest(path: string): Promise<RigManifest> {
  const full = resolve(path);
  let data: unknown;
  try { data = JSON.parse(await readFile(full, "utf8")); }
  catch (error) { throw new SpineError("MANIFEST_READ_FAILED", `Cannot read rig manifest ${full}: ${String(error)}`); }
  if (!obj(data)) throw new SpineError("INVALID_RIG_MANIFEST", "Rig manifest must be a JSON object.");
  return data as unknown as RigManifest;
}
export function imageDirectory(manifest: RigManifest, manifestPath: string): string {
  return resolve(dirname(resolve(manifestPath)), String(manifest.imagesDir ?? ""));
}
function nearOpaque(image: ImageInfo, point: Point, radius = 8): boolean {
  const minX = Math.max(0, Math.floor(point[0] - radius)), maxX = Math.min(image.width - 1, Math.ceil(point[0] + radius));
  const minY = Math.max(0, Math.floor(point[1] - radius)), maxY = Math.min(image.height - 1, Math.ceil(point[1] + radius));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++)
    if (image.alpha[y * image.width + x] > 16 && Math.hypot(x + .5 - point[0], y + .5 - point[1]) <= radius) return true;
  return false;
}
export async function validateRigManifest(manifest: RigManifest, path: string) {
  const diagnostics: RigDiagnostic[] = [];
  const issue = (code: string, at: string, message: string, severity: "error" | "warning" = "error") => diagnostics.push({ code, severity, path: at, message });
  if (manifest.schemaVersion !== 1) issue("INVALID_SCHEMA_VERSION", "/schemaVersion", "Expected schemaVersion 1.");
  if (manifest.spineVersion !== "4.2" && manifest.spineVersion !== "4.3") issue("UNSUPPORTED_VERSION", "/spineVersion", "Use Spine 4.2 or 4.3.");
  if (typeof manifest.imagesDir !== "string" || !manifest.imagesDir || manifest.imagesDir.includes("\0")) issue("INVALID_IMAGES_DIR", "/imagesDir", "imagesDir must be a nonempty path.");
  const parts = Array.isArray(manifest.parts) ? manifest.parts : [];
  if (!parts.length) issue("NO_PARTS", "/parts", "Add at least one PNG part.");
  const ids = new Map<string, RigPart>();
  const imageDir = imageDirectory(manifest, path);
  const images = new Map<string, ImageInfo>();
  for (const [i, part] of parts.entries()) {
    const at = ptr("parts", i);
    if (!obj(part) || typeof part.id !== "string" || !part.id.trim()) { issue("INVALID_PART", at, "Part needs a nonempty id."); continue; }
    if (ids.has(part.id)) issue("DUPLICATE_PART", `${at}/id`, `Duplicate part ${part.id}.`);
    ids.set(part.id, part);
    if (typeof part.image !== "string" || !safeImage(part.image)) issue("INVALID_IMAGE_PATH", `${at}/image`, "Image must be a PNG path inside imagesDir.");
    else {
      try {
        const image = await readImageInfo(imageDir, part.image);
        images.set(part.id, image);
        if (part.width !== image.width || part.height !== image.height) issue("STALE_IMAGE_DIMENSIONS", at, `${part.image} dimensions changed; review landmarks.`);
        if (part.sha256 !== image.sha256) issue("STALE_IMAGE_HASH", `${at}/sha256`, `${part.image} changed; review its landmarks.`);
      } catch (error) { issue(error instanceof SpineError ? error.code : "IMAGE_READ_FAILED", `${at}/image`, String(error instanceof Error ? error.message : error)); }
    }
    if (!obj(part.landmarks) || !Object.keys(part.landmarks).length) issue("MISSING_LANDMARKS", `${at}/landmarks`, "Part needs landmarks.");
    else for (const [name, point] of Object.entries(part.landmarks)) {
      if (!validPoint(point)) issue("INVALID_LANDMARK", `${at}/landmarks/${name}`, "Landmark needs two finite coordinates.");
      else if (point[0] < 0 || point[1] < 0 || point[0] > part.width || point[1] > part.height)
        issue("LANDMARK_OUTSIDE_CANVAS", `${at}/landmarks/${name}`, "Landmark lies outside the PNG canvas.");
    }
    if (typeof part.pivot !== "string" || !obj(part.landmarks) || !validPoint(part.landmarks[part.pivot])) issue("MISSING_PIVOT", `${at}/pivot`, "Pivot must name a landmark.");
    if (typeof part.tip !== "string" || !obj(part.landmarks) || !validPoint(part.landmarks[part.tip])) issue("MISSING_TIP", `${at}/tip`, "Tip must name a landmark.");
    if (obj(part.landmarks) && validPoint(part.landmarks[part.pivot]) && validPoint(part.landmarks[part.tip])
      && Math.hypot(part.landmarks[part.pivot][0] - part.landmarks[part.tip][0], part.landmarks[part.pivot][1] - part.landmarks[part.tip][1]) < 0.5)
      issue("DEGENERATE_BONE", `${at}/tip`, "Pivot and tip must define a nonzero bone.");
    if (typeof part.setupRotationDeg !== "number" || !Number.isFinite(part.setupRotationDeg)) issue("INVALID_ROTATION", `${at}/setupRotationDeg`, "Setup rotation must be finite.");
  }
  if (!obj(manifest.root) || typeof manifest.root.part !== "string" || !ids.has(manifest.root.part)) issue("INVALID_ROOT", "/root/part", "Root part is missing.");
  else {
    const rootPart = ids.get(manifest.root.part)!;
    if (!obj(rootPart.landmarks) || !validPoint(rootPart.landmarks[manifest.root.landmark])) issue("MISSING_ROOT_LANDMARK", "/root/landmark", "Root landmark is missing.");
    if (rootPart.pivot !== manifest.root.landmark) issue("ROOT_PIVOT_MISMATCH", "/root/landmark", "Root landmark must match the root part pivot.");
    if (rootPart.parent !== null) issue("ROOT_HAS_PARENT", "/root/part", "Root part cannot have a parent.");
    if (!validPoint(manifest.root.world)) issue("INVALID_ROOT_WORLD", "/root/world", "Root world position needs two finite numbers.");
  }
  for (const [i, part] of parts.entries()) {
    if (!obj(part) || typeof part.id !== "string" || !part.id) continue;
    if (part.id === manifest.root?.part) continue;
    const parent = part.parent;
    if (!obj(parent) || typeof parent.part !== "string" || typeof parent.landmark !== "string") { issue("UNRESOLVED_CONNECTION", ptr("parts", i, "parent"), "Connect this part to a parent landmark."); continue; }
    const source = ids.get(parent.part);
    if (!source || !obj(source.landmarks) || !validPoint(source.landmarks[parent.landmark])) issue("UNRESOLVED_CONNECTION", ptr("parts", i, "parent"), "Parent part or landmark is missing.");
  }
  for (const part of parts) {
    if (!obj(part) || typeof part.id !== "string") continue;
    const seen = new Set<string>(); let current: RigPart | undefined = part;
    while (current) {
      if (seen.has(current.id)) { issue("PART_CYCLE", `/parts`, `Connection cycle includes ${current.id}.`); break; }
      seen.add(current.id);
      current = current.parent ? ids.get(current.parent.part) : undefined;
    }
  }
  if (!Array.isArray(manifest.drawOrder) || manifest.drawOrder.length !== parts.length || new Set(manifest.drawOrder).size !== parts.length || parts.some((p) => !obj(p) || typeof p.id !== "string" || !manifest.drawOrder.includes(p.id)))
    issue("INVALID_DRAW_ORDER", "/drawOrder", "Draw order must contain every part id exactly once.");
  for (const [i, part] of parts.entries()) {
    if (!obj(part) || typeof part.id !== "string") continue;
    const image = images.get(part.id); if (!image || !obj(part.landmarks)) continue;
    const pivot = part.landmarks[part.pivot];
    if (validPoint(pivot) && !nearOpaque(image, pivot)) issue("PIVOT_FAR_FROM_ART", ptr("parts", i, "pivot"), `${part.id} pivot is over transparent padding; visually review the joint.`, "warning");
  }
  if (!diagnostics.some((d) => d.severity === "error")) {
    for (const [i, part] of parts.entries()) {
      if (!part.parent) continue;
      let worst = 0, worstPose = "setup";
      for (const [label, rotation] of [["setup", 0], ["−30°", -30], ["+30°", 30]] as const) {
        const placed = new Map(assembleRig(manifest, { [part.id]: rotation }).map((p) => [p.id, p]));
        const parent = placed.get(part.parent.part)!, child = placed.get(part.id)!;
        const gap = opaqueSeamDistance(images.get(part.parent.part)!, parent, images.get(part.id)!, child);
        if (gap > worst) { worst = gap; worstPose = label; }
      }
      if (worst > 8) issue("SEAM_GAP", ptr("parts", i, "parent"),
        `${part.id} may show a ${worst.toFixed(1)} px art gap at ${worstPose}; inspect the bend snapshots.`, "warning");
    }
  }
  return { manifestPath: resolve(path), valid: !diagnostics.some((d) => d.severity === "error"), diagnostics,
    errors: diagnostics.filter((d) => d.severity === "error"), visualWarnings: diagnostics.filter((d) => d.severity === "warning"), images };
}
export interface PartPlacement { id: string; pivot: Point; tip: Point; center: Point; boneAngleDeg: number; imageAngleDeg: number; landmarks: Record<string, Point> }
function opaqueSeamDistance(parentImage: ImageInfo, parent: PartPlacement, childImage: ImageInfo, child: PartPlacement): number {
  const joint = child.pivot;
  function points(image: ImageInfo, placement: PartPlacement): Point[] {
    const angle = rad(placement.imageAngleDeg), co = Math.cos(angle), si = Math.sin(angle);
    const found: Point[] = [];
    for (let y = 1; y < image.height; y += 3) for (let x = 1; x < image.width; x += 3) {
      if (image.alpha[y * image.width + x] <= 16) continue;
      const dx = x + .5 - image.width / 2, dy = image.height / 2 - y - .5;
      const p: Point = [placement.center[0] + dx * co - dy * si, placement.center[1] + dx * si + dy * co];
      if (Math.hypot(p[0] - joint[0], p[1] - joint[1]) <= 30) found.push(p);
    }
    return found;
  }
  const a = points(parentImage, parent), b = points(childImage, child);
  if (!a.length || !b.length) return 30;
  let min = 30;
  for (const p of a) for (const q of b) min = Math.min(min, Math.hypot(p[0] - q[0], p[1] - q[1]));
  return min;
}
export function assembleRig(manifest: RigManifest, rotations: Record<string, number> = {}): PartPlacement[] {
  const byId = new Map(manifest.parts.map((part) => [part.id, part]));
  const done = new Map<string, PartPlacement>();
  function place(id: string): PartPlacement {
    const prior = done.get(id); if (prior) return prior;
    const part = byId.get(id); if (!part) throw new SpineError("INVALID_RIG_MANIFEST", `Unknown part ${id}.`);
    const parent = part.parent ? place(part.parent.part) : undefined;
    const B = parent ? parent.landmarks[part.parent!.landmark] : manifest.root.world;
    const phi = rad(part.setupRotationDeg + (rotations[id] ?? 0) + (parent ? parent.imageAngleDeg - byId.get(parent.id)!.setupRotationDeg : 0));
    const C = sub(B, rotate(centered(part.landmarks[part.pivot], part), phi));
    const landmarks = Object.fromEntries(Object.entries(part.landmarks).map(([name, p]) => [name, add(C, rotate(centered(p, part), phi))])) as Record<string, Point>;
    const T = landmarks[part.tip];
    const result = { id, pivot: B, tip: T, center: C, boneAngleDeg: deg(Math.atan2(T[1] - B[1], T[0] - B[0])), imageAngleDeg: deg(phi), landmarks };
    done.set(id, result); return result;
  }
  return manifest.parts.map((part) => place(part.id));
}
export function compileRig(manifest: RigManifest, manifestPath: string, outputDataPath: string) {
  const placements = assembleRig(manifest);
  const byId = new Map(placements.map((p) => [p.id, p]));
  const partById = new Map(manifest.parts.map((p) => [p.id, p]));
  const bones: Record<string, unknown>[] = [{ name: "root" }];
  const emitted = new Set<string>();
  function emit(id: string) {
    if (emitted.has(id)) return;
    const part = partById.get(id)!; if (part.parent) emit(part.parent.part);
    const placement = byId.get(id)!;
    const parent = part.parent ? byId.get(part.parent.part)! : undefined;
    const parentAngle = parent ? rad(parent.boneAngleDeg) : 0;
    const origin = parent ? parent.pivot : [0, 0] as Point;
    const local = rotate(sub(placement.pivot, origin), -parentAngle);
    const dx = placement.tip[0] - placement.pivot[0], dy = placement.tip[1] - placement.pivot[1];
    bones.push({ name: `part:${id}`, parent: parent ? `part:${parent.id}` : "root", x: fixed(local[0]), y: fixed(local[1]),
      rotation: fixed(placement.boneAngleDeg - (parent?.boneAngleDeg ?? 0)), length: fixed(Math.hypot(dx, dy)) });
    emitted.add(id);
  }
  for (const part of manifest.parts) emit(part.id);
  const slots = manifest.drawOrder.map((id) => ({ name: `slot:${id}`, bone: `part:${id}`, attachment: id }));
  const attachments: Record<string, unknown> = {};
  for (const part of manifest.parts) {
    const p = byId.get(part.id)!;
    const local = rotate(sub(p.center, p.pivot), -rad(p.boneAngleDeg));
    attachments[`slot:${part.id}`] = { [part.id]: { type: "region", path: part.image.replace(/\.png$/i, ""),
      x: fixed(local[0]), y: fixed(local[1]), rotation: fixed(p.imageAngleDeg - p.boneAngleDeg), width: part.width, height: part.height } };
  }
  let imagePath = relative(dirname(resolve(outputDataPath)), imageDirectory(manifest, manifestPath)).split(sep).join("/");
  if (!imagePath) imagePath = ".";
  if (!imagePath.endsWith("/")) imagePath += "/";
  const data = { skeleton: { spine: manifest.spineVersion, fps: 30, images: imagePath }, bones, slots,
    skins: [{ name: "default", attachments }], animations: {} };
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const document = parseDocument(outputDataPath, text);
  const diagnostics = validateDocument(document);
  if (diagnostics.some((d) => d.severity === "error")) throw new SpineError("RIG_COMPILE_FAILED", "Compiled Spine JSON failed validation.", { diagnostics });
  return { text, document, placements, diagnostics };
}
export async function buildRigFromLandmarks(input: { manifestPath: string; outputDataPath: string; outputProjectPath?: string; editorVersion: "4.2" | "4.3" }) {
  const manifestPath = resolve(input.manifestPath), outputDataPath = resolve(input.outputDataPath);
  const manifest = await readRigManifest(manifestPath);
  const checked = await validateRigManifest(manifest, manifestPath);
  if (!checked.valid) throw new SpineError("INVALID_RIG_MANIFEST", "Fix rig manifest errors before building.", { diagnostics: checked.diagnostics });
  if (manifest.spineVersion !== input.editorVersion) throw new SpineError("VERSION_MISMATCH", "Manifest and editor versions must match.");
  if (extname(outputDataPath).toLowerCase() !== ".json") throw new SpineError("INVALID_OUTPUT_PATH", "Rig data output must end in .json.");
  if (input.outputProjectPath && extname(input.outputProjectPath).toLowerCase() !== ".spine") throw new SpineError("INVALID_OUTPUT_PATH", "Rig project output must end in .spine.");
  if (input.outputProjectPath && resolve(input.outputProjectPath) === outputDataPath) throw new SpineError("INVALID_OUTPUT_PATH", "Data and project outputs must differ.");
  for (const path of [outputDataPath, input.outputProjectPath].filter((p): p is string => Boolean(p)))
    if (await access(path, constants.F_OK).then(() => true, () => false)) throw new SpineError("OUTPUT_EXISTS", `Output already exists: ${path}.`);
  const result = compileRig(manifest, manifestPath, outputDataPath);
  await mkdir(dirname(outputDataPath), { recursive: true });
  const temp = join(dirname(outputDataPath), `.spine2d-rig-${randomUUID()}.json`);
  let projectCreated = false;
  try {
    await writeFile(temp, result.text, { flag: "wx" });
    let cli: Awaited<ReturnType<typeof importData>>["cli"] | undefined;
    if (input.outputProjectPath) {
      const project = await importData(temp, input.outputProjectPath, basename(input.outputProjectPath, ".spine"), input.editorVersion);
      cli = project.cli; projectCreated = true;
    }
    const rechecked = await validateRigManifest(manifest, manifestPath);
    const latest = await readRigManifest(manifestPath);
    if (!rechecked.valid || JSON.stringify(latest) !== JSON.stringify(manifest))
      throw new SpineError("RIG_INPUT_CHANGED", "Rig manifest or images changed during build.", { diagnostics: rechecked.diagnostics });
    try { await link(temp, outputDataPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SpineError("OUTPUT_EXISTS", `Output already exists: ${outputDataPath}.`); throw error; }
    return { manifestPath, outputDataPath, ...(input.outputProjectPath ? { outputProjectPath: resolve(input.outputProjectPath) } : {}),
      sourceHash: result.document.hash, diagnostics: [...checked.visualWarnings, ...result.diagnostics] as (RigDiagnostic | Diagnostic)[],
      placements: result.placements, ...(cli ? { cli: { executable: cli.executable, exitCode: cli.exitCode, stdout: cli.stdout.slice(0, 4000), stderr: cli.stderr.slice(0, 4000) } } : {}) };
  } catch (error) {
    if (projectCreated && input.outputProjectPath) await rm(input.outputProjectPath, { force: true }).catch(() => undefined);
    throw error;
  } finally { await rm(temp, { force: true }).catch(() => undefined); }
}
