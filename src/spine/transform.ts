import { applyEdits, modify } from "jsonc-parser";

import type { KeyChange } from "./bulk.js";
import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { collectTimelines, curveChannelCount, keyTime, timelinePath, type JsonPath, type Timeline } from "./timelines.js";
import { cloneAnimationText, reverseBoneAnimationText } from "./variant.js";

type JsonRecord = Record<string, unknown>;
export interface TransformAnimationOperation {
  kind: "transform_animation";
  mode: "mirror" | "combine" | "variant" | "reverse" | "segment";
  newAnimation: string;
  sourceAnimation?: string;
  firstAnimation?: string;
  secondAnimation?: string;
  secondStart?: number;
  bonePairs?: [string, string][];
  eventMap?: Record<string, string>;
  timeScale?: number;
  startAt?: number;
  duration?: number;
  from?: number;
  to?: number;
}
export interface TransformAnimationSummary {
  kind: "transform_animation";
  mode: TransformAnimationOperation["mode"];
  newAnimation: string;
  sourceAnimations: string[];
  timelines: number;
  keys: number;
  duration: number;
  mirroredBones?: number;
  mirroredChannels?: number;
  shiftedKeys?: number;
  mergedEvents?: number;
  reviewHints?: string[];
  requestedDuration?: number;
  boundaryKeys?: number;
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}
function animations(document: SpineDocument): JsonRecord {
  if (!record(document.data.animations)) throw new SpineError("INVALID_ANIMATIONS", "Animations must be an object.");
  return document.data.animations;
}
function source(animations: JsonRecord, name: unknown): JsonRecord {
  if (!nonempty(name) || !record(animations[name])) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${String(name)} was not found.`);
  }
  return animations[name] as JsonRecord;
}
function destination(animations: JsonRecord, name: string): void {
  if (!nonempty(name)) throw new SpineError("INVALID_NAME", "A nonempty new animation name is required.");
  if (Object.hasOwn(animations, name)) throw new SpineError("ANIMATION_EXISTS", `Animation ${name} already exists.`);
}
function finite(value: number, description: string): number {
  if (!Number.isFinite(value) || value < 0) throw new SpineError("TIME_OVERFLOW", `${description} produced an invalid time.`);
  return Number(value.toPrecision(12));
}
function put(document: SpineDocument, name: string, animation: JsonRecord, summary: TransformAnimationSummary) {
  const path: JsonPath = ["animations", name];
  const edits = modify(document.text, path, animation, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } });
  return { text: applyEdits(document.text, edits),
    changes: [{ path: timelinePath(path), before: null, after: animation } satisfies KeyChange], summary };
}
function duration(timelines: Timeline[]): number {
  return timelines.reduce((longest, timeline) => Math.max(longest,
    ...timeline.keys.map((key, index) => keyTime(key, [...timeline.path, index]))), 0);
}
function stats(animationName: string, animation: JsonRecord) {
  const timelines = collectTimelines(animationName, animation);
  return { timelines: timelines.length, keys: timelines.reduce((sum, timeline) => sum + timeline.keys.length, 0),
    duration: duration(timelines) };
}
function at(root: JsonRecord, parts: string[]): unknown {
  return parts.reduce<unknown>((value, part) => record(value) ? value[part] : undefined, root);
}
function set(root: JsonRecord, parts: string[], value: unknown): void {
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    if (parent[part] === undefined) parent[part] = {};
    if (!record(parent[part])) throw new SpineError("INVALID_DATA", `Timeline parent ${part} is not an object.`);
    parent = parent[part] as JsonRecord;
  }
  parent[parts.at(-1)!] = value;
}
function unset(root: JsonRecord, parts: string[]): void {
  const chain: JsonRecord[] = [root];
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    if (!record(parent[part])) return;
    parent = parent[part] as JsonRecord;
    chain.push(parent);
  }
  delete parent[parts.at(-1)!];
  for (let index = chain.length - 1; index > 0; index -= 1) {
    if (Object.keys(chain[index]).length) break;
    delete chain[index - 1][parts[index - 1]];
  }
}
function shiftedKeys(timeline: Timeline, offset: number): JsonRecord[] {
  return timeline.keys.map((key, index) => {
    const result = structuredClone(key);
    const time = finite(keyTime(key, [...timeline.path, index]) + offset, "Combining animation");
    if (time !== 0 || key.time !== undefined) result.time = time;
    if (Array.isArray(key.curve)) {
      if (key.curve.length === 0 || key.curve.length % 4 !== 0
        || !key.curve.every((part) => typeof part === "number" && Number.isFinite(part))) {
        throw new SpineError("UNSUPPORTED_CURVE", `Cannot shift curve at ${timelinePath([...timeline.path, index, "curve"])}.`);
      }
      const curve = [...key.curve] as number[];
      for (let control = 0; control < curve.length; control += 4) {
        curve[control] = finite(curve[control] + offset, "Combining Bézier control");
        curve[control + 2] = finite(curve[control + 2] + offset, "Combining Bézier control");
      }
      result.curve = curve;
    }
    return result;
  });
}
function combine(document: SpineDocument, operation: TransformAnimationOperation) {
  const all = animations(document);
  const firstName = operation.firstAnimation;
  const secondName = operation.secondAnimation;
  const first = source(all, firstName);
  const second = source(all, secondName);
  if (firstName === secondName) throw new SpineError("INVALID_COMBINATION", "Choose two different source animations.");
  destination(all, operation.newAnimation);
  const secondStart = operation.secondStart ?? 0;
  if (!Number.isFinite(secondStart) || secondStart < 0) {
    throw new SpineError("INVALID_START_TIME", "secondStart must be finite and nonnegative.");
  }
  const output = structuredClone(first);
  const secondTimelines = collectTimelines(secondName!, second);
  const conflicts: string[] = [];
  let shifted = 0;
  let mergedEvents = 0;
  for (const timeline of secondTimelines) {
    const parts = timeline.path.slice(2).map(String);
    const incoming = shiftedKeys(timeline, secondStart);
    shifted += incoming.length;
    const existing = at(output, parts);
    if (existing === undefined) {
      set(output, parts, incoming);
    } else if (timeline.section === "events" && Array.isArray(existing)) {
      const combined = [...existing, ...incoming].map((key, index) => ({ key, index }));
      combined.sort((left, right) => Number((left.key as JsonRecord).time ?? 0)
        - Number((right.key as JsonRecord).time ?? 0) || left.index - right.index);
      set(output, parts, combined.map((item) => item.key));
      mergedEvents += incoming.length;
    } else {
      conflicts.push(timelinePath(["animations", firstName!, ...parts]));
    }
  }
  if (conflicts.length) {
    throw new SpineError("TIMELINE_CONFLICT", "Both clips key the same timeline; resolve those tracks before combining.",
      { timelines: conflicts });
  }
  const computed = stats(operation.newAnimation, output);
  return put(document, operation.newAnimation, output, { kind: "transform_animation", mode: "combine",
    newAnimation: operation.newAnimation, sourceAnimations: [firstName!, secondName!],
    ...computed, shiftedKeys: shifted, mergedEvents,
    reviewHints: ["Combined tracks play in parallel. Review the pose where their motion overlaps."],
  });
}

function mirror(document: SpineDocument, operation: TransformAnimationOperation) {
  const all = animations(document);
  const sourceName = operation.sourceAnimation;
  const original = source(all, sourceName);
  destination(all, operation.newAnimation);
  const timelines = collectTimelines(sourceName!, original);
  const unsupported = timelines.filter((timeline) => !["bones", "events"].includes(timeline.section)
    || timeline.section === "bones" && !["rotate", "translate", "translatex", "translatey", "scale", "scalex", "scaley",
      "shear", "shearx", "sheary", "inherit"].includes(timeline.type));
  if (unsupported.length) throw new SpineError("UNSUPPORTED_MIRROR_TIMELINE", "Mirroring currently supports bone transform and event timelines.",
    { timelines: unsupported.map((timeline) => timelinePath(timeline.path)) });
  const available = new Set((Array.isArray(document.data.bones) ? document.data.bones : [])
    .flatMap((bone) => record(bone) && typeof bone.name === "string" ? [bone.name] : []));
  const pairs = operation.bonePairs ?? [];
  const mapping = new Map<string, string>();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(nonempty) || pair[0] === pair[1]
      || !available.has(pair[0]) || !available.has(pair[1]) || mapping.has(pair[0]) || mapping.has(pair[1])) {
      throw new SpineError("INVALID_BONE_PAIRS", "Bone pairs must be distinct existing left/right bone names.");
    }
    mapping.set(pair[0], pair[1]);
    mapping.set(pair[1], pair[0]);
  }
  const output = structuredClone(original);
  if (record(output.bones)) output.bones = {};
  let mirroredChannels = 0;
  for (const timeline of timelines) {
    if (timeline.section !== "bones") continue;
    const target = mapping.get(timeline.target) ?? timeline.target;
    const signs = timeline.type === "rotate" || timeline.type === "translatex"
      || timeline.type === "shearx" || timeline.type === "sheary" ? [-1]
      : timeline.type === "translate" ? [-1, 1]
        : timeline.type === "shear" ? [-1, -1] : [1, 1];
    const keys = timeline.keys.map((key, index) => {
      const transformed = structuredClone(key);
      const negativeFields = timeline.type === "rotate" ? ["value", "angle"]
        : ["translatex", "shearx", "sheary"].includes(timeline.type) ? ["value"]
          : timeline.type === "translate" ? ["x"]
            : timeline.type === "shear" ? ["x", "y"] : [];
      if (timeline.type === "rotate" && key.value !== undefined && key.angle !== undefined) {
        throw new SpineError("INVALID_KEY_VALUE", `Rotate key has both value and angle at ${timelinePath([...timeline.path, index])}.`);
      }
      for (const field of negativeFields) {
        if (transformed[field] === undefined) continue;
        if (typeof transformed[field] !== "number" || !Number.isFinite(transformed[field])) {
          throw new SpineError("INVALID_KEY_VALUE", `Nonfinite ${field} value at ${timelinePath([...timeline.path, index])}.`);
        }
        transformed[field] = -(transformed[field] as number);
        mirroredChannels += 1;
      }
      if (Array.isArray(key.curve)) {
        const expected = timeline.type === "translate" || timeline.type === "scale" || timeline.type === "shear" ? 8 : 4;
        if (key.curve.length !== expected || !key.curve.every((part) => typeof part === "number" && Number.isFinite(part))) {
          throw new SpineError("UNSUPPORTED_CURVE", `Cannot mirror curve at ${timelinePath([...timeline.path, index, "curve"])}.`);
        }
        const curve = [...key.curve] as number[];
        for (let channel = 0; channel < expected / 4; channel += 1) {
          if (signs[channel] !== -1) continue;
          curve[channel * 4 + 1] *= -1;
          curve[channel * 4 + 3] *= -1;
        }
        transformed.curve = curve;
      }
      return transformed;
    });
    set(output, ["bones", target, timeline.type], keys);
  }
  if (operation.eventMap) {
    const defined = record(document.data.events) ? document.data.events : {};
    if (Object.entries(operation.eventMap).some(([from, to]) => !nonempty(from) || !nonempty(to)
      || !Object.hasOwn(defined, from) || !Object.hasOwn(defined, to))) {
      throw new SpineError("INVALID_EVENT_MAP", "Event mappings need existing source and destination event definitions.");
    }
    if (Array.isArray(output.events)) output.events.forEach((event) => {
      if (record(event) && typeof event.name === "string" && operation.eventMap![event.name]) {
        event.name = operation.eventMap![event.name];
      }
    });
  }
  const computed = stats(operation.newAnimation, output);
  return put(document, operation.newAnimation, output, { kind: "transform_animation", mode: "mirror",
    newAnimation: operation.newAnimation, sourceAnimations: [sourceName!], ...computed,
    mirroredBones: mapping.size / 2, mirroredChannels,
    reviewHints: ["Mirroring flips animation offsets; setup poses and artwork need a symmetric rig for a visual mirror."],
  });
}

function boneFields(type: string, previous: JsonRecord, next: JsonRecord): { names: string[]; base: number } {
  if (type === "rotate") {
    if (previous.value !== undefined && previous.angle !== undefined
      || next.value !== undefined && next.angle !== undefined) {
      throw new SpineError("INVALID_KEY_VALUE", "Rotate keys cannot contain both value and angle.");
    }
    return { names: [previous.value !== undefined || next.value !== undefined ? "value" : "angle"], base: 0 };
  }
  return { names: ["translate", "scale", "shear"].includes(type) ? ["x", "y"] : ["value"],
    base: type.startsWith("scale") ? 1 : 0 };
}
function channelValue(key: JsonRecord, field: string, type: string, base: number): number {
  const raw = type === "rotate" ? key.value ?? key.angle ?? base : key[field] ?? base;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new SpineError("INVALID_KEY_VALUE", "Bone key needs finite channel values.");
  return raw;
}
function mix(left: number, right: number, fraction: number): number {
  return left + (right - left) * fraction;
}
type Point = [number, number];
function between(left: Point, right: Point, fraction: number): Point {
  return [mix(left[0], right[0], fraction), mix(left[1], right[1], fraction)];
}
function splitBezier(p0: Point, p1: Point, p2: Point, p3: Point, time: number) {
  const cubicX = (u: number) => {
    const v = 1 - u;
    return v * v * v * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u * u * u * p3[0];
  };
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (cubicX(middle) < time) low = middle;
    else high = middle;
  }
  const u = (low + high) / 2;
  const a = between(p0, p1, u);
  const b = between(p1, p2, u);
  const c = between(p2, p3, u);
  const d = between(a, b, u);
  const e = between(b, c, u);
  const middle = between(d, e, u);
  return { value: middle[1], left: [a, d] as [Point, Point], right: [e, c] as [Point, Point] };
}
function insertBoneBoundary(keys: JsonRecord[], type: string, time: number): "split" | "held" | "none" {
  if (keys.length === 0) return "none";
  const keyTimes = keys.map((key, index) => keyTime(key, [index]));
  if (keyTimes.includes(time) || time < keyTimes[0]) return "none";
  const last = keyTimes.at(-1)!;
  if (time > last) {
    const previous = keys.at(-1)!;
    const held: JsonRecord = { ...previous, time };
    delete held.curve;
    keys.push(held);
    return "held";
  }
  const index = keyTimes.findIndex((value) => value > time) - 1;
  if (index < 0) return "none";
  const previous = keys[index];
  const next = keys[index + 1];
  const spec = boneFields(type, previous, next);
  const curve = previous.curve;
  const inserted: JsonRecord = { time };
  if (curve === "stepped") {
    for (const field of spec.names) inserted[field] = channelValue(previous, field, type, spec.base);
    inserted.curve = "stepped";
  } else if (curve === undefined) {
    const fraction = (time - keyTimes[index]) / (keyTimes[index + 1] - keyTimes[index]);
    for (const field of spec.names) inserted[field] = mix(channelValue(previous, field, type, spec.base),
      channelValue(next, field, type, spec.base), fraction);
  } else if (Array.isArray(curve) && curve.length === spec.names.length * 4
    && curve.every((part) => typeof part === "number" && Number.isFinite(part))) {
    const leftCurve: number[] = [];
    const rightCurve: number[] = [];
    for (const [channel, field] of spec.names.entries()) {
      const offset = channel * 4;
      const x1 = curve[offset] as number;
      const x2 = curve[offset + 2] as number;
      if (x1 < keyTimes[index] || x1 > x2 || x2 > keyTimes[index + 1]) {
        throw new SpineError("UNSUPPORTED_CURVE", "Bézier controls must be ordered within their segment for extraction.");
      }
      const split = splitBezier(
        [keyTimes[index], channelValue(previous, field, type, spec.base)],
        [x1, curve[offset + 1] as number], [x2, curve[offset + 3] as number],
        [keyTimes[index + 1], channelValue(next, field, type, spec.base)], time);
      inserted[field] = split.value;
      leftCurve.push(split.left[0][0], split.left[0][1], split.left[1][0], split.left[1][1]);
      rightCurve.push(split.right[0][0], split.right[0][1], split.right[1][0], split.right[1][1]);
    }
    previous.curve = leftCurve;
    inserted.curve = rightCurve;
  } else {
    throw new SpineError("UNSUPPORTED_CURVE", "Cannot split an unsupported bone curve.");
  }
  keys.splice(index + 1, 0, inserted);
  return "split";
}
function windowKeys(timeline: Timeline, from: number, to: number): { keys: JsonRecord[]; boundaryKeys: number } {
  const keys = timeline.keys.map((key) => structuredClone(key));
  const numericBone = timeline.section === "bones" && ["rotate", "translate", "translatex", "translatey",
    "scale", "scalex", "scaley", "shear", "shearx", "sheary"].includes(timeline.type);
  let boundaryKeys = 0;
  if (numericBone) {
    if (insertBoneBoundary(keys, timeline.type, from) !== "none") boundaryKeys += 1;
    if (insertBoneBoundary(keys, timeline.type, to) !== "none") boundaryKeys += 1;
  } else if (timeline.section !== "events") {
    const channelCount = curveChannelCount(timeline);
    for (const boundary of [from, to]) {
      const crossing = keys.findIndex((key, index) => index + 1 < keys.length
        && keyTime(key, [index]) < boundary && boundary < keyTime(keys[index + 1], [index + 1]));
      if (crossing >= 0 && channelCount !== 0 && keys[crossing].curve !== "stepped") {
        throw new SpineError("UNSUPPORTED_SEGMENT_BOUNDARY",
          "A continuous non-bone timeline crosses the segment boundary; add a boundary key first.",
          { path: timelinePath([...timeline.path, crossing]), time: boundary });
      }
    }
  }
  let selected: JsonRecord[];
  if (timeline.section === "events") {
    selected = keys.filter((key, index) => {
      const time = keyTime(key, [...timeline.path, index]);
      return time >= from && time <= to;
    });
  } else {
    let beforeIndex = -1;
    for (let index = 0; index < keys.length; index += 1) {
      if (keyTime(keys[index], [...timeline.path, index]) <= from) beforeIndex = index;
      else break;
    }
    selected = beforeIndex < 0 ? [] : [keys[beforeIndex]];
    for (let index = beforeIndex + 1; index < keys.length; index += 1) {
      const time = keyTime(keys[index], [...timeline.path, index]);
      if (time > to) break;
      selected.push(keys[index]);
    }
  }
  selected = selected.map((key) => {
    const transformed = { ...key };
    const originalTime = keyTime(key, timeline.path);
    transformed.time = finite(originalTime < from ? 0 : originalTime - from, "Extracting segment");
    if (Array.isArray(key.curve)) {
      const curve = [...key.curve] as number[];
      for (let index = 0; index < curve.length; index += 4) {
        curve[index] = finite(curve[index] - from, "Extracting Bézier control");
        curve[index + 2] = finite(curve[index + 2] - from, "Extracting Bézier control");
      }
      transformed.curve = curve;
    }
    return transformed;
  });
  if (selected.length && timeline.section !== "events") delete selected.at(-1)!.curve;
  return { keys: selected, boundaryKeys };
}
function segment(document: SpineDocument, operation: TransformAnimationOperation) {
  const all = animations(document);
  const sourceName = operation.sourceAnimation;
  const original = source(all, sourceName);
  destination(all, operation.newAnimation);
  const from = operation.from;
  const to = operation.to;
  if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) || !Number.isFinite(to)
    || from < 0 || to <= from) {
    throw new SpineError("INVALID_SEGMENT_RANGE", "Segment needs finite times with 0 ≤ from < to.");
  }
  const output = structuredClone(original);
  const timelines = collectTimelines(sourceName!, original);
  let boundaryKeys = 0;
  for (const timeline of timelines) {
    const parts = timeline.path.slice(2).map(String);
    const window = windowKeys(timeline, from, to);
    boundaryKeys += window.boundaryKeys;
    if (window.keys.length) set(output, parts, window.keys);
    else unset(output, parts);
  }
  const computed = stats(operation.newAnimation, output);
  const requestedDuration = finite(to - from, "Extracting segment duration");
  return put(document, operation.newAnimation, output, { kind: "transform_animation", mode: "segment",
    newAnimation: operation.newAnimation, sourceAnimations: [sourceName!], ...computed,
    requestedDuration, boundaryKeys,
    reviewHints: computed.duration < requestedDuration ? ["No pose key reaches the requested end; Spine uses the last key as clip duration."] : [],
  });
}

export function transformAnimationText(document: SpineDocument, operation: TransformAnimationOperation) {
  const fieldsByMode: Record<TransformAnimationOperation["mode"], string[]> = {
    mirror: ["sourceAnimation", "bonePairs", "eventMap"],
    combine: ["firstAnimation", "secondAnimation", "secondStart"],
    variant: ["sourceAnimation", "timeScale", "startAt"],
    reverse: ["sourceAnimation", "duration"],
    segment: ["sourceAnimation", "from", "to"],
  };
  if (!fieldsByMode[operation.mode]) {
    throw new SpineError("INVALID_TRANSFORM_MODE", "Transform mode must be mirror, combine, variant, reverse, or segment.");
  }
  const allowed = new Set(["kind", "mode", "newAnimation", ...fieldsByMode[operation.mode]]);
  const unexpected = Object.entries(operation).filter(([field, value]) => value !== undefined && !allowed.has(field));
  if (unexpected.length) {
    throw new SpineError("INVALID_TRANSFORM_OPTIONS", `Fields ${unexpected.map(([field]) => field).join(", ")} do not apply to ${operation.mode}.`);
  }
  if (operation.mode === "combine") return combine(document, operation);
  if (operation.mode === "mirror") return mirror(document, operation);
  if (operation.mode === "segment") return segment(document, operation);
  if (operation.mode === "variant") {
    const result = cloneAnimationText(document, { kind: "clone_animation", sourceAnimation: operation.sourceAnimation!,
      newAnimation: operation.newAnimation, timeScale: operation.timeScale, startAt: operation.startAt });
    return { ...result, summary: { kind: "transform_animation", mode: "variant", newAnimation: operation.newAnimation,
      sourceAnimations: [operation.sourceAnimation!], timelines: result.summary.timelines,
      keys: result.summary.keys, duration: result.summary.afterDuration } satisfies TransformAnimationSummary };
  }
  if (operation.mode === "reverse") {
    const result = reverseBoneAnimationText(document, { kind: "reverse_bone_animation", sourceAnimation: operation.sourceAnimation!,
      newAnimation: operation.newAnimation, duration: operation.duration });
    return { ...result, summary: { kind: "transform_animation", mode: "reverse", newAnimation: operation.newAnimation,
      sourceAnimations: [operation.sourceAnimation!], timelines: result.summary.boneTimelines + (result.summary.events ? 1 : 0),
      keys: result.summary.keys, duration: result.summary.duration } satisfies TransformAnimationSummary };
  }
  throw new SpineError("INVALID_TRANSFORM_MODE", "Transform mode must be mirror, combine, variant, reverse, or segment.");
}
