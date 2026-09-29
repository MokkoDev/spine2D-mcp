import type { SpineDocument } from "./document.js";
import { requireEditableVersion } from "./document.js";
import type { EditOperation } from "./edit.js";
import { SpineError } from "./errors.js";
import { collectTimelines, keyTime, timelinePath, type Timeline } from "./timelines.js";
import { validateDocument } from "./validate.js";

type JsonRecord = Record<string, unknown>;
type ConstraintType = "ik" | "transform" | "path" | "physics";
type Selection = Partial<Record<ConstraintType, string[]>>;
type Mapping = Partial<Record<ConstraintType, Record<string, string>>>;
type Value = number | boolean;

export interface ConstraintPoseEntry {
  type: ConstraintType;
  constraint: string;
  timelineType: string;
  values: Record<string, Value>;
  signature: string;
}

export interface SavedConstraintPose {
  name: string;
  sourcePath: string;
  sourceHash: string;
  sourceVersion: string;
  animation: string;
  time: number;
  entries: ConstraintPoseEntry[];
  skippedTimelines: string[];
}

const TYPES: ConstraintType[] = ["ik", "transform", "path", "physics"];
const NUMERIC: Record<ConstraintType, Record<string, string[]>> = {
  ik: { ik: ["mix", "softness"] },
  transform: { transform: ["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"] },
  path: { position: ["value"], spacing: ["value"], mix: ["mixRotate", "mixX", "mixY"] },
  physics: Object.fromEntries(["inertia", "strength", "damping", "mass", "wind", "gravity", "mix"]
    .map((name) => [name, ["value"]])),
};
const DISCRETE: Record<ConstraintType, Record<string, string[]>> = {
  ik: { ik: ["bendPositive", "compress", "stretch"] }, transform: {}, path: {}, physics: {},
};

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checked(document: SpineDocument): void {
  requireEditableVersion(document);
  const diagnostics = validateDocument(document);
  if (diagnostics.some((item) => item.severity === "error")) {
    throw new SpineError("VALIDATION_FAILED", "Skeleton data has validation errors.", { diagnostics });
  }
}

function animation(document: SpineDocument, name: string): JsonRecord {
  const animations = document.data.animations;
  if (!record(animations) || !record(animations[name])) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${name} was not found.`);
  }
  return animations[name] as JsonRecord;
}

function definitions(document: SpineDocument, type: ConstraintType): Map<string, JsonRecord> {
  const version43 = /^4\.3(?:\.|$)/.test(document.version);
  const section = version43 ? document.data.constraints : document.data[type];
  return new Map((Array.isArray(section) ? section : []).filter(record)
    .filter((item) => !version43 || item.type === type)
    .filter((item) => typeof item.name === "string")
    .map((item) => [item.name as string, item]));
}

function signature(type: ConstraintType, definition: JsonRecord, version: string): string {
  const bones = Array.isArray(definition.bones) ? definition.bones.length : 0;
  if (type === "ik") return JSON.stringify([type, bones]);
  if (type === "physics") return JSON.stringify([type, ...["inertia", "strength", "damping", "mass",
    "wind", "gravity", "mix"].map((field) => Boolean(definition[`${field}Global`]))]);
  if (type === "path") return JSON.stringify([type, bones, definition.positionMode ?? "percent",
    definition.spacingMode ?? "length", definition.rotateMode ?? "tangent"]);
  if (/^4\.3(?:\.|$)/.test(version)) {
    const properties = record(definition.properties) ? definition.properties : {};
    const topology = Object.entries(properties).map(([from, property]) =>
      [from, record(property) && record(property.to) ? Object.keys(property.to).sort() : []])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));
    return JSON.stringify([type, bones, topology, Boolean(definition.localSource),
      Boolean(definition.localTarget), Boolean(definition.additive), Boolean(definition.clamp)]);
  }
  return JSON.stringify([type, bones, Boolean(definition.local), Boolean(definition.relative)]);
}

function keyFallback(type: ConstraintType, timelineType: string, field: string, key: JsonRecord): Value {
  if (field === "bendPositive") return true;
  if (field === "compress" || field === "stretch") return false;
  if (field === "mixY" && (type === "transform" || type === "path")) return Number(key.mixX ?? 1);
  if (field === "mixScaleY" && type === "transform") return Number(key.mixScaleX ?? 1);
  if (field === "softness" || timelineType === "position" || timelineType === "spacing") return 0;
  if (type === "physics" && timelineType !== "mix") return 0;
  return 1;
}

function keyValue(key: JsonRecord, type: ConstraintType, timelineType: string, field: string): Value {
  const value = key[field] ?? keyFallback(type, timelineType, field, key);
  if (typeof value !== (DISCRETE[type][timelineType]?.includes(field) ? "boolean" : "number")
    || typeof value === "number" && !Number.isFinite(value)) {
    throw new SpineError("INVALID_KEY_VALUE", `${type}/${timelineType}/${field} has an invalid value.`);
  }
  return value as Value;
}

function setupValue(definition: JsonRecord, type: ConstraintType, timelineType: string, field: string): Value {
  if (field === "value") {
    const physicsDefaults: Record<string, number> = { inertia: 0.5, strength: 100,
      damping: 0.85, mass: 1, wind: 0, gravity: 0, mix: 1 };
    const fallback = type === "physics" ? physicsDefaults[timelineType] : 0;
    return typeof definition[timelineType] === "number" ? definition[timelineType] as number : fallback;
  }
  return keyValue(definition, type, timelineType, field);
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

function interpolate(curve: unknown, channel: number, time: number, t0: number, t1: number,
  from: number, to: number): number {
  if (curve === "stepped") return from;
  if (curve === undefined) return from + (to - from) * ((time - t0) / (t1 - t0));
  if (!Array.isArray(curve) || curve.length < (channel + 1) * 4) {
    throw new SpineError("UNSUPPORTED_CURVE", "Constraint curve has missing channel controls.");
  }
  const [x1, y1, x2, y2] = curve.slice(channel * 4, channel * 4 + 4);
  if (![x1, y1, x2, y2].every((item) => typeof item === "number" && Number.isFinite(item))
    || x1 < t0 || x1 > x2 || x2 > t1) {
    throw new SpineError("UNSUPPORTED_CURVE", "Constraint curve controls must be finite and ordered within their key segment.");
  }
  let low = 0; let high = 1;
  for (let step = 0; step < 48; step++) {
    const mid = (low + high) / 2;
    if (cubic(t0, x1, x2, t1, mid) < time) low = mid;
    else high = mid;
  }
  return cubic(from, y1, y2, to, (low + high) / 2);
}

function sample(timeline: Timeline | undefined, definition: JsonRecord, type: ConstraintType,
  timelineType: string, time: number): Record<string, Value> {
  const numeric = NUMERIC[type][timelineType];
  const discrete = DISCRETE[type][timelineType] ?? [];
  if (!numeric) throw new SpineError("UNSUPPORTED_POSE_TIMELINE", `${type}/${timelineType} cannot be sampled as a constraint pose.`);
  const fields = [...numeric, ...discrete];
  const keys = timeline?.keys ?? [];
  let index = -1;
  for (let candidate = 0; candidate < keys.length; candidate++) {
    if (keyTime(keys[candidate], [...timeline!.path, candidate]) <= time) index = candidate;
    else break;
  }
  if (index < 0) return Object.fromEntries(fields.map((field) => [field, setupValue(definition, type, timelineType, field)]));
  const fromKey = keys[index];
  const nextKey = keys[index + 1];
  const fromTime = keyTime(fromKey, [...timeline!.path, index]);
  const nextTime = nextKey ? keyTime(nextKey, [...timeline!.path, index + 1]) : undefined;
  const values: Record<string, Value> = {};
  for (const [channel, field] of numeric.entries()) {
    const from = keyValue(fromKey, type, timelineType, field) as number;
    const to = nextKey ? keyValue(nextKey, type, timelineType, field) as number : from;
    const value = nextTime !== undefined && time > fromTime && nextTime > fromTime
      ? interpolate(fromKey.curve, channel, time, fromTime, nextTime, from, to) : from;
    if (!Number.isFinite(value)) throw new SpineError("VALUE_OVERFLOW", `Sampling ${type}/${timelineType}/${field} overflowed.`);
    values[field] = Number(value.toPrecision(12));
  }
  for (const field of discrete) values[field] = keyValue(fromKey, type, timelineType, field);
  return values;
}

export function captureConstraintPose(document: SpineDocument, animationName: string, time: number,
  name: string, selection: Selection = {}): SavedConstraintPose {
  checked(document);
  if (!name.trim()) throw new SpineError("INVALID_NAME", "Pose name must be nonempty.");
  if (!Number.isFinite(time) || time < 0) throw new SpineError("INVALID_KEY_TIME", "Pose time must be finite and nonnegative.");
  const source = animation(document, animationName);
  const selected = new Map<ConstraintType, Set<string>>();
  for (const [type, names] of Object.entries(selection) as [ConstraintType, string[]][]) {
    const available = definitions(document, type);
    if (!TYPES.includes(type) || !Array.isArray(names) || names.length < 1
      || new Set(names).size !== names.length || names.some((item) => !available.has(item))) {
      throw new SpineError("INVALID_POSE_SELECTION", `Selected ${type} constraints must be distinct existing names.`);
    }
    selected.set(type, new Set(names));
  }
  const entries: ConstraintPoseEntry[] = [];
  const skippedTimelines: string[] = [];
  for (const timeline of collectTimelines(animationName, source)) {
    const type = timeline.section as ConstraintType;
    if (!TYPES.includes(type) || selected.has(type) && !selected.get(type)!.has(timeline.target)) continue;
    if (type === "physics" && timeline.target === "" || !NUMERIC[type][timeline.type]) {
      skippedTimelines.push(timelinePath(timeline.path));
      continue;
    }
    const definition = definitions(document, type).get(timeline.target);
    if (!definition) throw new SpineError("MISSING_CONSTRAINT", `${type} constraint ${timeline.target} was not found.`);
    entries.push({ type, constraint: timeline.target, timelineType: timeline.type,
      values: sample(timeline, definition, type, timeline.type, time),
      signature: signature(type, definition, document.version) });
    if (entries.length > 256) throw new SpineError("POSE_TOO_LARGE", "A constraint pose may contain at most 256 timelines.");
  }
  for (const [type, names] of selected) {
    const available = definitions(document, type);
    for (const constraint of names) {
      const definition = available.get(constraint)!;
      for (const timelineType of Object.keys(NUMERIC[type])) {
        if (entries.some((entry) => entry.type === type && entry.constraint === constraint && entry.timelineType === timelineType)) continue;
        entries.push({ type, constraint, timelineType,
          values: sample(undefined, definition, type, timelineType, time),
          signature: signature(type, definition, document.version) });
        if (entries.length > 256) throw new SpineError("POSE_TOO_LARGE", "A constraint pose may contain at most 256 timelines.");
      }
    }
  }
  if (!entries.length) throw new SpineError("NO_POSE_CHANNELS", "No supported constraint pose timelines match this request.", { skippedTimelines });
  return { name, sourcePath: document.path, sourceHash: document.hash, sourceVersion: document.version,
    animation: animationName, time, entries, skippedTimelines };
}

export function applyConstraintPoseOperations(document: SpineDocument, pose: SavedConstraintPose,
  animationName: string, time: number, options: { maps?: Mapping; blend?: number;
    curvePolicy?: "reject" | "linearize" } = {}) {
  checked(document);
  if (!animationName.trim()) throw new SpineError("INVALID_NAME", "Target animation name must be nonempty.");
  if (!Number.isFinite(time) || time < 0) throw new SpineError("INVALID_KEY_TIME", "Pose time must be finite and nonnegative.");
  if (document.version.match(/^\d+\.\d+/)?.[0] !== pose.sourceVersion.match(/^\d+\.\d+/)?.[0]) {
    throw new SpineError("VERSION_MISMATCH", "Constraint pose transfer requires matching Spine major and minor versions.");
  }
  const blend = options.blend ?? 1;
  if (!Number.isFinite(blend) || blend <= 0 || blend > 1) {
    throw new SpineError("INVALID_BLEND", "Blend must be greater than zero and at most one.");
  }
  if (blend !== 1 && pose.entries.some((entry) => Object.values(entry.values).some((value) => typeof value === "boolean"))) {
    throw new SpineError("DISCRETE_BLEND_UNSUPPORTED", "IK bend, compress, and stretch states need blend: 1.");
  }
  const sourceNames = new Map(TYPES.map((type) => [type, new Set(pose.entries.filter((entry) => entry.type === type)
    .map((entry) => entry.constraint))]));
  for (const [type, mapping] of Object.entries(options.maps ?? {}) as [ConstraintType, Record<string, string>][]) {
    if (!TYPES.includes(type) || Object.keys(mapping).some((name) => !sourceNames.get(type)!.has(name))) {
      throw new SpineError("INVALID_POSE_MAP", `Map for ${type} names a constraint outside this pose.`);
    }
  }
  const targetAnimations = record(document.data.animations) ? document.data.animations : {};
  const targetAnimation = record(targetAnimations[animationName]) ? targetAnimations[animationName] : undefined;
  const timelines = targetAnimation ? collectTimelines(animationName, targetAnimation) : [];
  const operations: EditOperation[] = targetAnimation ? [] : [{ kind: "upsert_animation", name: animationName }];
  const mapped: Partial<Record<ConstraintType, Record<string, string>>> = {};
  const used = new Set<string>();
  const mappedSources = new Map<string, string>();
  const incompatible: { type: ConstraintType; source: string; target: string; reason: string }[] = [];
  for (const entry of pose.entries) {
    const target = options.maps?.[entry.type]?.[entry.constraint] ?? entry.constraint;
    const targetId = `${entry.type}\0${target}`;
    const priorSource = mappedSources.get(targetId);
    if (priorSource && priorSource !== entry.constraint) {
      throw new SpineError("DUPLICATE_POSE_TARGET", `${priorSource} and ${entry.constraint} both map to ${entry.type}/${target}.`);
    }
    mappedSources.set(targetId, entry.constraint);
    const id = `${entry.type}\0${target}\0${entry.timelineType}`;
    if (used.has(id)) throw new SpineError("DUPLICATE_POSE_TARGET", `More than one pose channel maps to ${target} ${entry.timelineType}.`);
    used.add(id);
    const definition = definitions(document, entry.type).get(target);
    if (!definition || signature(entry.type, definition, document.version) !== entry.signature) {
      if (!incompatible.some((item) => item.type === entry.type && item.source === entry.constraint && item.target === target)) {
        incompatible.push({ type: entry.type, source: entry.constraint, target,
          reason: definition ? "constraint setup differs" : "target constraint is missing" });
      }
      continue;
    }
    (mapped[entry.type] ??= {})[entry.constraint] = target;
    const timeline = timelines.find((item) => item.section === entry.type && item.target === target && item.type === entry.timelineType);
    const current = sample(timeline, definition, entry.type, entry.timelineType, time);
    const values: Record<string, Value> = {};
    for (const [field, value] of Object.entries(entry.values)) {
      const next = typeof value === "number" ? (current[field] as number) + (value - (current[field] as number)) * blend : value;
      if (typeof next === "number" && !Number.isFinite(next)) {
        throw new SpineError("VALUE_OVERFLOW", `Blending ${entry.type}/${target}/${field} overflowed.`);
      }
      values[field] = typeof next === "number" ? Number(next.toPrecision(12)) : next;
    }
    operations.push({ kind: "set_keyframe", animation: animationName,
      selector: { section: entry.type, target, ...(entry.type === "ik" || entry.type === "transform" ? {} : { timelineType: entry.timelineType }) },
      time, values, curvePolicy: options.curvePolicy ?? "reject" });
  }
  if (incompatible.length) throw new SpineError("INCOMPATIBLE_CONSTRAINT_POSE",
    "Some mapped constraints are missing or have incompatible setups.", { incompatible });
  return { operations, summary: { poseName: pose.name, animation: animationName, time, blend,
    channelCount: pose.entries.length, mapped, compatibility: { compatible: true,
      checkedConstraints: [...new Set(pose.entries.map((entry) => `${entry.type}/${entry.constraint}`))].length },
    skippedTimelines: pose.skippedTimelines } };
}
