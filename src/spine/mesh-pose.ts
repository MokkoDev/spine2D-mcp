import { requireEditableVersion, sha256, type SpineDocument } from "./document.js";
import type { EditOperation } from "./edit.js";
import { SpineError } from "./errors.js";
import { collectTimelines, keyTime, timelinePath, type Timeline } from "./timelines.js";
import { validateDocument } from "./validate.js";

type JsonRecord = Record<string, unknown>;
type MeshLocation = { skin: string; slot: string; attachment: string };

export interface MeshPoseEntry extends MeshLocation {
  geometryHash: string;
  weighted: boolean;
  boneOrder: string[];
  coordinateCount: number;
  values: number[];
}

export interface SavedMeshPose {
  name: string;
  sourcePath: string;
  sourceHash: string;
  sourceVersion: string;
  animation: string;
  time: number;
  entries: MeshPoseEntry[];
}

export interface MeshPoseMaps {
  skins?: Record<string, string>;
  slots?: Record<string, string>;
  attachments?: Record<string, Record<string, string>>;
  bones?: Record<string, string>;
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checked(document: SpineDocument): void {
  requireEditableVersion(document);
  const diagnostics = validateDocument(document).filter((item) => item.severity === "error");
  if (diagnostics.length) throw new SpineError("VALIDATION_FAILED", "Skeleton data has validation errors.", { diagnostics });
}

function animation(document: SpineDocument, name: string): JsonRecord {
  const animations = document.data.animations;
  if (!record(animations) || !record(animations[name])) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${name} was not found.`);
  }
  return animations[name] as JsonRecord;
}

function mesh(document: SpineDocument, location: MeshLocation): JsonRecord {
  const skin = (Array.isArray(document.data.skins) ? document.data.skins : [])
    .find((item) => record(item) && item.name === location.skin) as JsonRecord | undefined;
  const slots = skin?.attachments;
  const names = record(slots) ? slots[location.slot] : undefined;
  const value = record(names) ? names[location.attachment] : undefined;
  if (!record(value)) throw new SpineError("MESH_NOT_FOUND", `Mesh ${location.skin}/${location.slot}/${location.attachment} was not found.`);
  if (value.type !== "mesh") {
    throw new SpineError("UNSUPPORTED_MESH_POSE_ATTACHMENT", "Mesh poses require direct mesh attachments; linked meshes need their source mesh timeline.");
  }
  return value;
}

function boneOrder(document: SpineDocument): string[] {
  return (Array.isArray(document.data.bones) ? document.data.bones : []).filter(record)
    .map((bone) => String(bone.name));
}

function meshShape(document: SpineDocument, location: MeshLocation) {
  const value = mesh(document, location);
  const uvs = value.uvs as number[];
  const vertices = value.vertices as number[];
  const weighted = vertices.length !== uvs.length;
  let coordinateCount = vertices.length;
  if (weighted) {
    let cursor = 0;
    let influences = 0;
    for (let vertex = 0; vertex < uvs.length / 2; vertex++) {
      const count = vertices[cursor];
      if (!Number.isSafeInteger(count) || count < 1 || cursor + 1 + 4 * count > vertices.length) {
        throw new SpineError("INVALID_MESH", "The weighted mesh influence layout is invalid.");
      }
      influences += count;
      cursor += 1 + 4 * count;
    }
    if (cursor !== vertices.length) throw new SpineError("INVALID_MESH", "The weighted mesh has extra influence data.");
    coordinateCount = influences * 2;
  }
  if (coordinateCount < 2 || coordinateCount > 65_536) {
    throw new SpineError("POSE_TOO_LARGE", "A mesh pose needs between 2 and 65,536 coordinates per mesh.");
  }
  return { geometryHash: sha256(JSON.stringify([value.uvs, value.vertices, value.triangles, value.hull])),
    weighted, boneOrder: weighted ? boneOrder(document) : [], coordinateCount };
}

function location(timeline: Timeline): MeshLocation {
  return { skin: String(timeline.path[3]), slot: String(timeline.path[4]), attachment: String(timeline.path[5]) };
}

function dense(key: JsonRecord, count: number): number[] {
  const result = Array<number>(count).fill(0);
  const offset = Number(key.offset ?? 0);
  const values = Array.isArray(key.vertices) ? key.vertices as number[] : [];
  for (let index = 0; index < values.length; index++) result[offset + index] = values[index];
  return result;
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

function factor(curve: unknown, ratio: number): number {
  if (curve === "stepped") return 0;
  if (curve === undefined) return ratio;
  if (!Array.isArray(curve) || curve.length !== 4 || curve.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new SpineError("UNSUPPORTED_CURVE", "A mesh deform curve must have four finite controls.");
  }
  const [x1, y1, x2, y2] = curve as number[];
  if (x1 < 0 || x1 > x2 || x2 > 1) throw new SpineError("UNSUPPORTED_CURVE", "Mesh deform curve time controls must be ordered in [0, 1].");
  let low = 0; let high = 1;
  for (let index = 0; index < 48; index++) {
    const mid = (low + high) / 2;
    if (cubic(0, x1, x2, 1, mid) < ratio) low = mid;
    else high = mid;
  }
  return cubic(0, y1, y2, 1, (low + high) / 2);
}

export function sampleMeshTimeline(timeline: Timeline | undefined, time: number, count: number): number[] {
  if (!Number.isFinite(time) || time < 0) throw new SpineError("INVALID_KEY_TIME", "Pose time must be finite and nonnegative.");
  if (!timeline) return Array<number>(count).fill(0);
  let index = -1;
  for (let candidate = 0; candidate < timeline.keys.length; candidate++) {
    if (keyTime(timeline.keys[candidate], [...timeline.path, candidate]) <= time) index = candidate;
    else break;
  }
  if (index < 0) return Array<number>(count).fill(0);
  const key = timeline.keys[index];
  const from = dense(key, count);
  const next = timeline.keys[index + 1];
  if (!next) return from;
  const t0 = keyTime(key, [...timeline.path, index]);
  const t1 = keyTime(next, [...timeline.path, index + 1]);
  if (time === t0 || t1 <= t0) return from;
  const to = dense(next, count);
  const alpha = factor(key.curve, (time - t0) / (t1 - t0));
  return from.map((value, coordinate) => Number((value + (to[coordinate] - value) * alpha).toPrecision(12)));
}

export function captureMeshPose(document: SpineDocument, animationName: string, time: number, name: string): SavedMeshPose {
  checked(document);
  if (!name.trim()) throw new SpineError("INVALID_NAME", "Pose name must be nonempty.");
  const timelines = collectTimelines(animationName, animation(document, animationName))
    .filter((item) => (item.section === "attachments" || item.section === "deform") && item.type === "deform");
  if (!timelines.length) throw new SpineError("NO_POSE_CHANNELS", "This animation has no mesh deform timelines.");
  if (timelines.length > 128) throw new SpineError("POSE_TOO_LARGE", "A mesh pose can contain at most 128 deform timelines.");
  let totalCoordinates = 0;
  const entries = timelines.map((timeline) => {
    const target = location(timeline);
    const shape = meshShape(document, target);
    totalCoordinates += shape.coordinateCount;
    return { ...target, ...shape, values: sampleMeshTimeline(timeline, time, shape.coordinateCount) };
  });
  if (totalCoordinates > 262_144) throw new SpineError("POSE_TOO_LARGE", "A mesh pose can contain at most 262,144 coordinates.");
  return { name, sourcePath: document.path, sourceHash: document.hash, sourceVersion: document.version,
    animation: animationName, time, entries };
}

function mapped(map: Record<string, string> | undefined, name: string): string {
  return map && Object.hasOwn(map, name) ? map[name] : name;
}

export function applyMeshPoseOperations(document: SpineDocument, pose: SavedMeshPose,
  animationName: string, time: number, blend = 1, maps: MeshPoseMaps = {},
  curvePolicy: "reject" | "linearize" = "reject") {
  checked(document);
  if (!animationName.trim()) throw new SpineError("INVALID_NAME", "Target animation name must be nonempty.");
  if (!Number.isFinite(time) || time < 0) throw new SpineError("INVALID_KEY_TIME", "Pose time must be finite and nonnegative.");
  if (!Number.isFinite(blend) || blend <= 0 || blend > 1) throw new SpineError("INVALID_BLEND", "Blend must be greater than zero and at most one.");
  if (document.version.match(/^\d+\.\d+/)?.[0] !== pose.sourceVersion.match(/^\d+\.\d+/)?.[0]) {
    throw new SpineError("VERSION_MISMATCH", "Mesh pose transfer requires matching Spine major and minor versions.");
  }
  const sourceSkins = new Set(pose.entries.map((entry) => entry.skin));
  const sourceSlots = new Set(pose.entries.map((entry) => entry.slot));
  for (const name of Object.keys(maps.skins ?? {})) if (!sourceSkins.has(name)) throw new SpineError("INVALID_POSE_MAP", `Source skin ${name} is not in this pose.`);
  for (const name of Object.keys(maps.slots ?? {})) if (!sourceSlots.has(name)) throw new SpineError("INVALID_POSE_MAP", `Source slot ${name} is not in this pose.`);
  for (const [slot, names] of Object.entries(maps.attachments ?? {})) {
    if (!sourceSlots.has(slot)) throw new SpineError("INVALID_POSE_MAP", `Source slot ${slot} is not in this pose.`);
    for (const name of Object.keys(names)) {
      if (!pose.entries.some((entry) => entry.slot === slot && entry.attachment === name)) {
        throw new SpineError("INVALID_POSE_MAP", `Source attachment ${slot}/${name} is not in this pose.`);
      }
    }
  }
  const targetAnimations = record(document.data.animations) ? document.data.animations : {};
  const targetAnimation = record(targetAnimations[animationName]) ? targetAnimations[animationName] : undefined;
  const existing = targetAnimation ? collectTimelines(animationName, targetAnimation) : [];
  const operations: EditOperation[] = [];
  if (!targetAnimation) operations.push({ kind: "upsert_animation", name: animationName });
  const used = new Set<string>();
  const mappedMeshes: { source: MeshLocation; target: MeshLocation }[] = [];
  for (const entry of pose.entries) {
    const target = { skin: mapped(maps.skins, entry.skin), slot: mapped(maps.slots, entry.slot),
      attachment: mapped(maps.attachments?.[entry.slot], entry.attachment) };
    const identity = JSON.stringify(target);
    if (used.has(identity)) throw new SpineError("POSE_MAP_COLLISION", `Several mesh pose entries map to ${target.skin}/${target.slot}/${target.attachment}.`);
    used.add(identity);
    const shape = meshShape(document, target);
    if (shape.geometryHash !== entry.geometryHash || shape.weighted !== entry.weighted
      || shape.coordinateCount !== entry.coordinateCount
      || entry.weighted && JSON.stringify(entry.boneOrder.map((name) => mapped(maps.bones, name))) !== JSON.stringify(shape.boneOrder)) {
      throw new SpineError("INCOMPATIBLE_MESH", `Target mesh ${target.skin}/${target.slot}/${target.attachment} has different geometry or weighted bone order.`);
    }
    const timeline = existing.find((item) => (item.section === "attachments" || item.section === "deform")
      && item.type === "deform" && item.path[3] === target.skin && item.path[4] === target.slot
      && item.path[5] === target.attachment);
    const current = blend === 1 ? [] : sampleMeshTimeline(timeline, time, entry.coordinateCount);
    const values = blend === 1 ? entry.values : entry.values.map((value, index) =>
      Number((current[index] + (value - current[index]) * blend).toPrecision(12)));
    const section = timeline?.section === "attachments" || timeline?.section === "deform"
      ? timeline.section : (/^4\.2(?:\.|$)/.test(document.version) ? "deform" : "attachments");
    operations.push({ kind: "set_keyframe", animation: animationName,
      selector: { section, skin: target.skin, slot: target.slot, attachment: target.attachment,
        ...(section === "attachments" ? { timelineType: "deform" } : {}) },
      time, values: { offset: 0, vertices: values }, curvePolicy });
    mappedMeshes.push({ source: { skin: entry.skin, slot: entry.slot, attachment: entry.attachment }, target });
  }
  return { operations, summary: { poseName: pose.name, animation: animationName, time, blend,
    meshCount: pose.entries.length, coordinateCount: pose.entries.reduce((sum, entry) => sum + entry.coordinateCount, 0),
    mappedMeshes, sourceHash: pose.sourceHash, sourceVersion: pose.sourceVersion } };
}
