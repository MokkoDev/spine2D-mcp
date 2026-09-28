import { applyEdits, modify } from "jsonc-parser";

import type { KeyChange } from "./bulk.js";
import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { collectTimelines, keyTime, timelinePath, type Timeline } from "./timelines.js";

type JsonRecord = Record<string, unknown>;
const NUMERIC_TYPES = new Set(["rotate", "translate", "translatex", "translatey", "scale", "scalex", "scaley",
  "shear", "shearx", "sheary"]);
export interface CleanupCurvesOperation {
  kind: "cleanup_curves";
  animation: string;
  mode: "simplify" | "smooth";
  bone?: string;
  timelineTypes?: string[];
  tolerance?: number;
  protectedTimes?: number[];
}
export interface CleanupCurvesSummary {
  kind: "cleanup_curves";
  animation: string;
  mode: CleanupCurvesOperation["mode"];
  timelines: number;
  timelinesChanged: number;
  keysRemoved: number;
  curvesUpdated: number;
  maxErrorBound?: number;
  protectedTimes: number[];
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(type: string): { names: string[]; base: number } {
  return { names: ["translate", "scale", "shear"].includes(type) ? ["x", "y"] : ["value"],
    base: type.startsWith("scale") ? 1 : 0 };
}
function value(key: JsonRecord, type: string, field: string, base: number, path: string): number {
  if (type === "rotate" && key.value !== undefined && key.angle !== undefined) {
    throw new SpineError("INVALID_KEY_VALUE", `Rotate key has both value and angle at ${path}.`);
  }
  const raw = type === "rotate" ? key.value ?? key.angle ?? base : key[field] ?? base;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new SpineError("INVALID_KEY_VALUE", `Nonfinite ${field} value at ${path}.`);
  }
  return raw;
}
function times(timeline: Timeline): number[] {
  const result = timeline.keys.map((key, index) => keyTime(key, [...timeline.path, index]));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index] <= result[index - 1]) {
      throw new SpineError("CURVE_TIME_CONFLICT", `Bone timeline needs strictly increasing key times at ${timelinePath(timeline.path)}.`);
    }
  }
  return result;
}
function channelValues(timeline: Timeline): number[][] {
  const spec = fields(timeline.type);
  return spec.names.map((field) => timeline.keys.map((key, index) =>
    value(key, timeline.type, field, spec.base, timelinePath([...timeline.path, index]))));
}
function curveAt(timeline: Timeline, index: number): number[] | "stepped" | undefined {
  const curve = timeline.keys[index].curve;
  if (curve === undefined || curve === "stepped") return curve;
  const channels = fields(timeline.type).names.length;
  if (!Array.isArray(curve) || curve.length !== channels * 4
    || !curve.every((part) => typeof part === "number" && Number.isFinite(part))) {
    throw new SpineError("UNSUPPORTED_CURVE", `Curve at ${timelinePath([...timeline.path, index, "curve"])} is not a supported bone transform curve.`);
  }
  return curve as number[];
}
function errorBound(timeline: Timeline, keyTimes: number[], channels: number[][], left: number, right: number): number {
  let maximum = 0;
  const start = keyTimes[left];
  const span = keyTimes[right] - start;
  for (let segment = left; segment < right; segment += 1) {
    const curve = curveAt(timeline, segment);
    if (curve === "stepped") return Number.POSITIVE_INFINITY;
    for (let channel = 0; channel < channels.length; channel += 1) {
      const values = channels[channel];
      const line = (time: number) => values[left] + (values[right] - values[left]) * ((time - start) / span);
      maximum = Math.max(maximum, Math.abs(values[segment] - line(keyTimes[segment])),
        Math.abs(values[segment + 1] - line(keyTimes[segment + 1])));
      if (Array.isArray(curve)) {
        const offset = channel * 4;
        const cx1 = curve[offset];
        const cx2 = curve[offset + 2];
        if (cx1 < keyTimes[segment] || cx1 > cx2 || cx2 > keyTimes[segment + 1]) {
          throw new SpineError("UNSUPPORTED_CURVE", `Curve controls are outside their segment at ${timelinePath([...timeline.path, segment, "curve"])}.`);
        }
        // Cubic Bézier curves lie inside their control-point convex hull. Subtracting the
        // candidate line at each control time gives a conservative bound at every time.
        maximum = Math.max(maximum, Math.abs(curve[offset + 1] - line(cx1)),
          Math.abs(curve[offset + 3] - line(cx2)));
      }
    }
  }
  return maximum;
}
function removable(key: JsonRecord, type: string): boolean {
  const allowed = new Set(["time", "curve", ...fields(type).names, ...(type === "rotate" ? ["angle"] : [])]);
  return Object.keys(key).every((field) => allowed.has(field));
}
function simplify(timeline: Timeline, tolerance: number, protectedTimes: Set<number>) {
  const keyTimes = times(timeline);
  const channels = channelValues(timeline);
  if (keyTimes.length < 3) return { keys: timeline.keys, removed: 0, curvesUpdated: 0, maxErrorBound: 0 };
  const kept = keyTimes.map((_, index) => index);
  let removed = 0;
  let progress = true;
  while (progress) {
    progress = false;
    for (let position = 1; position < kept.length - 1; position += 1) {
      const index = kept[position];
      if (protectedTimes.has(keyTimes[index]) || !removable(timeline.keys[index], timeline.type)) continue;
      const bound = errorBound(timeline, keyTimes, channels, kept[position - 1], kept[position + 1]);
      if (bound <= tolerance) {
        kept.splice(position, 1);
        removed += 1;
        progress = true;
        position -= 1;
      }
    }
  }
  let maxErrorBound = 0;
  let curvesUpdated = 0;
  const result = kept.map((index) => ({ ...timeline.keys[index] }));
  for (let position = 0; position < kept.length - 1; position += 1) {
    if (kept[position + 1] === kept[position] + 1) continue;
    maxErrorBound = Math.max(maxErrorBound, errorBound(timeline, keyTimes, channels, kept[position], kept[position + 1]));
    if (result[position].curve !== undefined) {
      delete result[position].curve;
      curvesUpdated += 1;
    }
  }
  return { keys: result, removed, curvesUpdated, maxErrorBound };
}
function harmonicSlope(left: number, right: number, leftSpan: number, rightSpan: number): number {
  if (left === 0 || right === 0 || Math.sign(left) !== Math.sign(right)) return 0;
  const w1 = 2 * rightSpan + leftSpan;
  const w2 = rightSpan + 2 * leftSpan;
  return (w1 + w2) / (w1 / left + w2 / right);
}
function smooth(timeline: Timeline, protectedTimes: Set<number>) {
  const keyTimes = times(timeline);
  const channels = channelValues(timeline);
  const keys = timeline.keys.map((key) => ({ ...key }));
  if (keys.length < 2) return { keys, removed: 0, curvesUpdated: 0, maxErrorBound: 0 };
  const slopes = channels.map((values) => values.map((_, index) => {
    if (index === 0 || index === values.length - 1 || protectedTimes.has(keyTimes[index])) return 0;
    if (curveAt(timeline, index - 1) === "stepped" || curveAt(timeline, index) === "stepped") return 0;
    const leftSpan = keyTimes[index] - keyTimes[index - 1];
    const rightSpan = keyTimes[index + 1] - keyTimes[index];
    return harmonicSlope((values[index] - values[index - 1]) / leftSpan,
      (values[index + 1] - values[index]) / rightSpan, leftSpan, rightSpan);
  }));
  let curvesUpdated = 0;
  for (let index = 0; index < keys.length - 1; index += 1) {
    if (curveAt(timeline, index) === "stepped") continue;
    const span = keyTimes[index + 1] - keyTimes[index];
    const controls = channels.flatMap((values, channel) => [
      keyTimes[index] + span / 3,
      values[index] + slopes[channel][index] * span / 3,
      keyTimes[index + 1] - span / 3,
      values[index + 1] - slopes[channel][index + 1] * span / 3,
    ].map((number) => Number(number.toPrecision(12))));
    if (!controls.every(Number.isFinite)) throw new SpineError("CURVE_OVERFLOW", "Smoothing produced nonfinite controls.");
    if (JSON.stringify(keys[index].curve) !== JSON.stringify(controls)) {
      keys[index].curve = controls;
      curvesUpdated += 1;
    }
  }
  return { keys, removed: 0, curvesUpdated, maxErrorBound: 0 };
}

export function cleanupCurvesText(document: SpineDocument, operation: CleanupCurvesOperation) {
  if (operation.mode !== "simplify" && operation.mode !== "smooth") {
    throw new SpineError("INVALID_CLEANUP_MODE", "Curve cleanup mode must be simplify or smooth.");
  }
  const tolerance = operation.tolerance ?? 0;
  if (!Number.isFinite(tolerance) || tolerance < 0 || operation.mode === "smooth" && operation.tolerance !== undefined) {
    throw new SpineError("INVALID_TOLERANCE", "Simplification tolerance must be finite and nonnegative; smoothing does not use it.");
  }
  const protectedList = operation.protectedTimes ?? [];
  if (!Array.isArray(protectedList) || protectedList.length > 256
    || protectedList.some((time) => !Number.isFinite(time) || time < 0)) {
    throw new SpineError("INVALID_PROTECTED_TIMES", "Protected times must contain at most 256 finite nonnegative times.");
  }
  const protectedTimes = new Set(protectedList);
  const requestedTypes = operation.timelineTypes ? new Set(operation.timelineTypes) : undefined;
  if (requestedTypes && (requestedTypes.size !== operation.timelineTypes!.length
    || [...requestedTypes].some((type) => !NUMERIC_TYPES.has(type)))) {
    throw new SpineError("INVALID_TIMELINE_TYPES", "Select distinct supported numeric bone timeline types.");
  }
  const animations = document.data.animations;
  if (!record(animations) || !Object.hasOwn(animations, operation.animation)) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${operation.animation} was not found.`);
  }
  const timelines = collectTimelines(operation.animation, animations[operation.animation]).filter((timeline) =>
    timeline.section === "bones" && NUMERIC_TYPES.has(timeline.type)
    && (operation.bone === undefined || timeline.target === operation.bone)
    && (!requestedTypes || requestedTypes.has(timeline.type)));
  if (timelines.length === 0) throw new SpineError("NO_TIMELINES", "No matching numeric bone transform timelines were found.");
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  const changes: KeyChange[] = [];
  let text = document.text;
  let keysRemoved = 0;
  let curvesUpdated = 0;
  let maxErrorBound = 0;
  let timelinesChanged = 0;
  for (const timeline of timelines) {
    const result = operation.mode === "simplify" ? simplify(timeline, tolerance, protectedTimes)
      : smooth(timeline, protectedTimes);
    if (JSON.stringify(timeline.keys) === JSON.stringify(result.keys)) continue;
    text = applyEdits(text, modify(text, timeline.path, result.keys, { formattingOptions }));
    changes.push({ path: timelinePath(timeline.path), before: timeline.keys, after: result.keys });
    timelinesChanged += 1;
    keysRemoved += result.removed;
    curvesUpdated += result.curvesUpdated;
    maxErrorBound = Math.max(maxErrorBound, result.maxErrorBound);
  }
  return { text, changes, summary: {
    kind: "cleanup_curves", animation: operation.animation, mode: operation.mode,
    timelines: timelines.length, timelinesChanged, keysRemoved, curvesUpdated,
    ...(operation.mode === "simplify" ? { maxErrorBound } : {}),
    protectedTimes: [...protectedTimes].sort((a, b) => a - b),
  } satisfies CleanupCurvesSummary };
}
