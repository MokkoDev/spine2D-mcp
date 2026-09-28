import type { SpineDocument } from "./document.js";
import { requireEditableVersion } from "./document.js";
import { SpineError } from "./errors.js";
import type { SetKeyframeOperation } from "./keyframe.js";
import { collectTimelines, keyTime, timelinePath, type Timeline } from "./timelines.js";
import { validateDocument } from "./validate.js";

type JsonRecord = Record<string, unknown>;

const CHANNELS: Record<string, { fields: string[]; base: number }> = {
  rotate: { fields: ["value"], base: 0 },
  translate: { fields: ["x", "y"], base: 0 },
  translatex: { fields: ["value"], base: 0 },
  translatey: { fields: ["value"], base: 0 },
  scale: { fields: ["x", "y"], base: 1 },
  scalex: { fields: ["value"], base: 1 },
  scaley: { fields: ["value"], base: 1 },
  shear: { fields: ["x", "y"], base: 0 },
  shearx: { fields: ["value"], base: 0 },
  sheary: { fields: ["value"], base: 0 },
};

export interface BonePoseEntry {
  bone: string;
  timelineType: string;
  values: Record<string, number>;
}

export interface SavedBonePose {
  name: string;
  sourcePath: string;
  sourceHash: string;
  sourceVersion: string;
  animation: string;
  time: number;
  entries: BonePoseEntry[];
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numeric(key: JsonRecord, type: string, field: string, fallback: number, path: string): number {
  const value = type === "rotate" ? key.value ?? key.angle ?? fallback : key[field] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SpineError("INVALID_KEY_VALUE", `Expected a finite ${field} value at ${path}.`);
  }
  return value;
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

function bezierValue(time: number, t0: number, t1: number, v0: number, v1: number, curve: number[], offset: number): number {
  const x1 = curve[offset];
  const y1 = curve[offset + 1];
  const x2 = curve[offset + 2];
  const y2 = curve[offset + 3];
  if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < t0 || x1 > x2 || x2 > t1) {
    throw new SpineError("UNSUPPORTED_CURVE", "Bézier time controls must remain ordered inside their key segment for pose sampling.");
  }
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const mid = (low + high) / 2;
    if (cubic(t0, x1, x2, t1, mid) < time) low = mid;
    else high = mid;
  }
  return cubic(v0, y1, y2, v1, (low + high) / 2);
}

export function sampleBoneTimeline(timeline: Timeline | undefined, type: string, time: number): Record<string, number> {
  const spec = CHANNELS[type];
  if (!spec) throw new SpineError("UNSUPPORTED_POSE_TIMELINE", `Bone ${type} timeline cannot be sampled as a numeric pose.`);
  if (!Number.isFinite(time) || time < 0) throw new SpineError("INVALID_KEY_TIME", "Pose time must be finite and nonnegative.");
  const baseline = Object.fromEntries(spec.fields.map((field) => [field, spec.base]));
  if (!timeline || timeline.keys.length === 0) return baseline;
  let index = -1;
  for (let candidate = 0; candidate < timeline.keys.length; candidate += 1) {
    const keyAt = keyTime(timeline.keys[candidate], [...timeline.path, candidate]);
    if (keyAt <= time) index = candidate;
    else break;
  }
  if (index < 0) return baseline;
  const key = timeline.keys[index];
  const keyPath = timelinePath([...timeline.path, index]);
  const fromTime = keyTime(key, [...timeline.path, index]);
  const next = timeline.keys[index + 1];
  if (!next) return Object.fromEntries(spec.fields.map((field) => [field, numeric(key, type, field, spec.base, keyPath)]));
  const toTime = keyTime(next, [...timeline.path, index + 1]);
  if (toTime <= fromTime || time === fromTime || key.curve === "stepped") {
    return Object.fromEntries(spec.fields.map((field) => [field, numeric(key, type, field, spec.base, keyPath)]));
  }
  const curve = key.curve;
  if (curve !== undefined && (!Array.isArray(curve) || curve.length !== spec.fields.length * 4)) {
    throw new SpineError("UNSUPPORTED_CURVE", `Cannot sample curve at ${timelinePath([...timeline.path, index, "curve"])}.`);
  }
  const values: Record<string, number> = {};
  for (const [channel, field] of spec.fields.entries()) {
    const from = numeric(key, type, field, spec.base, keyPath);
    const to = numeric(next, type, field, spec.base, timelinePath([...timeline.path, index + 1]));
    const value = Array.isArray(curve)
      ? bezierValue(time, fromTime, toTime, from, to, curve as number[], channel * 4)
      : from + (to - from) * ((time - fromTime) / (toTime - fromTime));
    if (!Number.isFinite(value)) throw new SpineError("VALUE_OVERFLOW", `Pose interpolation overflowed at ${keyPath}.`);
    values[field] = Number(value.toPrecision(12));
  }
  return values;
}

function checkedDocument(document: SpineDocument): void {
  requireEditableVersion(document);
  const diagnostics = validateDocument(document);
  if (diagnostics.some((item) => item.severity === "error")) {
    throw new SpineError("VALIDATION_FAILED", "Skeleton data has validation errors.", { diagnostics });
  }
}

export function captureBonePose(document: SpineDocument, animation: string, time: number, name: string,
  bones?: string[]): SavedBonePose {
  checkedDocument(document);
  if (!name.trim()) throw new SpineError("INVALID_NAME", "Pose name must be nonempty.");
  if (!Number.isFinite(time) || time < 0) throw new SpineError("INVALID_KEY_TIME", "Pose time must be finite and nonnegative.");
  const animations = document.data.animations;
  if (!record(animations) || !Object.hasOwn(animations, animation)) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${animation} was not found.`);
  }
  const boneNames = new Set((Array.isArray(document.data.bones) ? document.data.bones : [])
    .filter(record).map((bone) => bone.name).filter((bone): bone is string => typeof bone === "string"));
  if (bones) {
    if (bones.length === 0 || new Set(bones).size !== bones.length || bones.some((bone) => !boneNames.has(bone))) {
      throw new SpineError("INVALID_POSE_BONES", "Selected pose bones must be distinct names in the source skeleton.");
    }
  }
  const selected = bones ? new Set(bones) : undefined;
  const timelines = collectTimelines(animation, animations[animation]);
  const entries: BonePoseEntry[] = [];
  for (const timeline of timelines) {
    if (timeline.section !== "bones" || selected && !selected.has(timeline.target)) continue;
    if (!CHANNELS[timeline.type]) {
      throw new SpineError("UNSUPPORTED_POSE_TIMELINE", `Bone ${timeline.target} has unsupported pose timeline ${timeline.type}.`);
    }
    entries.push({ bone: timeline.target, timelineType: timeline.type,
      values: sampleBoneTimeline(timeline, timeline.type, time) });
    if (entries.length > 256) {
      throw new SpineError("POSE_TOO_LARGE", "A pose may contain at most 256 transform timelines; select fewer bones.");
    }
  }
  if (entries.length === 0) throw new SpineError("NO_POSE_CHANNELS", "No supported bone transform timelines match this pose request.");
  return { name, sourcePath: document.path, sourceHash: document.hash, sourceVersion: document.version,
    animation, time, entries };
}

export function poseApplyOperations(document: SpineDocument, pose: SavedBonePose, animation: string, time: number,
  blend = 1, boneMap: Record<string, string> = {}, curvePolicy: "reject" | "linearize" = "reject") {
  checkedDocument(document);
  if (!animation.trim()) throw new SpineError("INVALID_NAME", "Target animation name must be nonempty.");
  if (!Number.isFinite(time) || time < 0) throw new SpineError("INVALID_KEY_TIME", "Pose application time must be finite and nonnegative.");
  if (!Number.isFinite(blend) || blend <= 0 || blend > 1) throw new SpineError("INVALID_BLEND", "Pose blend must be greater than zero and at most one.");
  if (document.version.match(/^\d+\.\d+/)?.[0] !== pose.sourceVersion.match(/^\d+\.\d+/)?.[0]) {
    throw new SpineError("VERSION_MISMATCH", "Pose transfer currently requires matching Spine major and minor versions.");
  }
  const sourceBones = new Set(pose.entries.map((entry) => entry.bone));
  if (Object.keys(boneMap).some((name) => !sourceBones.has(name))) {
    throw new SpineError("INVALID_BONE_MAP", "Bone map contains a source bone that is not in the saved pose.");
  }
  const targetBones = new Set((Array.isArray(document.data.bones) ? document.data.bones : [])
    .filter(record).map((bone) => bone.name).filter((bone): bone is string => typeof bone === "string"));
  const unmapped = [...sourceBones].filter((bone) => !targetBones.has(boneMap[bone] ?? bone));
  if (unmapped.length > 0) throw new SpineError("UNMAPPED_BONES", "Pose bones are missing in the target skeleton.", { unmapped });
  const targetAnimations = record(document.data.animations) ? document.data.animations : {};
  const existing = Object.hasOwn(targetAnimations, animation);
  const timelines = existing ? collectTimelines(animation, targetAnimations[animation]) : [];
  const operations: ({ kind: "upsert_animation"; name: string } | SetKeyframeOperation)[] = [];
  if (!existing) operations.push({ kind: "upsert_animation", name: animation });
  const targets = new Set<string>();
  for (const entry of pose.entries) {
    const target = boneMap[entry.bone] ?? entry.bone;
    const key = `${target}\0${entry.timelineType}`;
    if (targets.has(key)) throw new SpineError("DUPLICATE_POSE_TARGET", `More than one pose channel maps to ${target} ${entry.timelineType}.`);
    targets.add(key);
    const timeline = timelines.find((item) => item.section === "bones" && item.target === target && item.type === entry.timelineType);
    const current = sampleBoneTimeline(timeline, entry.timelineType, time);
    const values = Object.fromEntries(Object.entries(entry.values).map(([field, value]) => {
      const next = current[field] + (value - current[field]) * blend;
      if (!Number.isFinite(next)) throw new SpineError("VALUE_OVERFLOW", `Pose blend overflowed for ${target} ${entry.timelineType}.`);
      return [field, Number(next.toPrecision(12))];
    }));
    operations.push({ kind: "set_keyframe", animation,
      selector: { section: "bones", target, timelineType: entry.timelineType }, time, values, curvePolicy });
  }
  return { operations, sourceBones: sourceBones.size, channels: pose.entries.length, mappedBones: Object.fromEntries([...sourceBones]
    .map((bone) => [bone, boneMap[bone] ?? bone])) };
}
