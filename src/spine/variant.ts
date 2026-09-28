import { applyEdits, modify } from "jsonc-parser";

import type { KeyChange } from "./bulk.js";
import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { collectTimelines, curveChannelCount, keyTime, timelinePath } from "./timelines.js";

export interface CloneAnimationOperation {
  kind: "clone_animation";
  sourceAnimation: string;
  newAnimation: string;
  timeScale?: number;
  startAt?: number;
}

export interface CloneAnimationSummary {
  kind: "clone_animation";
  sourceAnimation: string;
  newAnimation: string;
  beforeDuration: number;
  afterDuration: number;
  timelines: number;
  keys: number;
  curveControls: number;
}

export interface ReverseBoneAnimationOperation {
  kind: "reverse_bone_animation";
  sourceAnimation: string;
  newAnimation: string;
  duration?: number;
}

export interface ReverseBoneAnimationSummary {
  kind: "reverse_bone_animation";
  sourceAnimation: string;
  newAnimation: string;
  duration: number;
  boneTimelines: number;
  keys: number;
  anchorKeys: number;
  events: number;
  curveControls: number;
}

function finiteTime(value: number, description: string): number {
  if (!Number.isFinite(value) || value < 0) throw new SpineError("TIME_OVERFLOW", `${description} produced an invalid time.`);
  return Number(value.toPrecision(12));
}

export function cloneAnimationText(document: SpineDocument, operation: CloneAnimationOperation): {
  text: string; changes: KeyChange[]; summary: CloneAnimationSummary;
} {
  const { sourceAnimation, newAnimation } = operation;
  if (!sourceAnimation?.trim() || !newAnimation?.trim()) {
    throw new SpineError("INVALID_NAME", "Source and destination animation names must be nonempty.");
  }
  const animations = document.data.animations;
  if (!animations || typeof animations !== "object" || Array.isArray(animations)
    || !Object.hasOwn(animations, sourceAnimation)) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${sourceAnimation} was not found.`);
  }
  if (Object.hasOwn(animations, newAnimation)) {
    throw new SpineError("ANIMATION_EXISTS", `Animation ${newAnimation} already exists.`);
  }
  const timeScale = operation.timeScale ?? 1;
  const startAt = operation.startAt ?? 0;
  if (!Number.isFinite(timeScale) || timeScale <= 0 || !Number.isFinite(startAt) || startAt < 0) {
    throw new SpineError("INVALID_TRANSFORM", "timeScale must be positive and startAt must be nonnegative.");
  }
  const source = (animations as Record<string, unknown>)[sourceAnimation];
  const timelines = collectTimelines(sourceAnimation, source);
  const cloned = structuredClone(source) as Record<string, unknown>;
  let beforeDuration = 0;
  let afterDuration = 0;
  let keys = 0;
  let curveControls = 0;
  for (const timeline of timelines) {
    let output: unknown = cloned;
    for (const part of timeline.path.slice(2)) {
      if (output === null || typeof output !== "object" || Array.isArray(output)) {
        throw new SpineError("INVALID_DATA", `Cannot locate cloned timeline ${timelinePath(timeline.path)}.`);
      }
      output = (output as Record<string, unknown>)[String(part)];
    }
    if (!Array.isArray(output) || output.length !== timeline.keys.length) {
      throw new SpineError("INVALID_DATA", `Cannot locate cloned timeline ${timelinePath(timeline.path)}.`);
    }
    for (let index = 0; index < timeline.keys.length; index += 1) {
      const original = timeline.keys[index];
      const clonedKey = output[index] as Record<string, unknown>;
      const oldTime = keyTime(original, [...timeline.path, index]);
      const newTime = finiteTime(startAt + oldTime * timeScale, "Cloning animation");
      beforeDuration = Math.max(beforeDuration, oldTime);
      afterDuration = Math.max(afterDuration, newTime);
      keys += 1;
      if (newTime !== 0 || original.time !== undefined) clonedKey.time = newTime;
      const curve = original.curve;
      if (curve === undefined || curve === "stepped") continue;
      if (!Array.isArray(curve) || curve.length === 0 || curve.length % 4 !== 0
        || !curve.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new SpineError("UNSUPPORTED_CURVE", `Cannot clone curve at ${timelinePath([...timeline.path, index, "curve"])}.`);
      }
      const adjusted = [...curve] as number[];
      for (let control = 0; control < adjusted.length; control += 4) {
        adjusted[control] = finiteTime(startAt + adjusted[control] * timeScale, "Cloning Bézier control");
        adjusted[control + 2] = finiteTime(startAt + adjusted[control + 2] * timeScale, "Cloning Bézier control");
        curveControls += 2;
      }
      clonedKey.curve = adjusted;
    }
  }
  const edits = modify(document.text, ["animations", newAnimation], cloned,
    { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } });
  return {
    text: applyEdits(document.text, edits),
    changes: [{ path: timelinePath(["animations", newAnimation]), before: null, after: cloned }],
    summary: { kind: "clone_animation", sourceAnimation, newAnimation, beforeDuration, afterDuration,
      timelines: timelines.length, keys, curveControls },
  };
}

/** Reverse continuous bone motion and event times into a new clip. Discrete state needs separate rules. */
export function reverseBoneAnimationText(document: SpineDocument, operation: ReverseBoneAnimationOperation): {
  text: string; changes: KeyChange[]; summary: ReverseBoneAnimationSummary;
} {
  const { sourceAnimation, newAnimation } = operation;
  if (!sourceAnimation?.trim() || !newAnimation?.trim()) {
    throw new SpineError("INVALID_NAME", "Source and destination animation names must be nonempty.");
  }
  const animations = document.data.animations;
  if (!animations || typeof animations !== "object" || Array.isArray(animations)
    || !Object.hasOwn(animations, sourceAnimation)) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${sourceAnimation} was not found.`);
  }
  if (Object.hasOwn(animations, newAnimation)) {
    throw new SpineError("ANIMATION_EXISTS", `Animation ${newAnimation} already exists.`);
  }
  const source = (animations as Record<string, unknown>)[sourceAnimation];
  const timelines = collectTimelines(sourceAnimation, source);
  const unsupported = timelines.filter((timeline) =>
    timeline.section !== "events" && (timeline.section !== "bones" || !curveChannelCount(timeline)));
  if (unsupported.length > 0) {
    throw new SpineError("UNSUPPORTED_REVERSE_TIMELINE",
      "This reverse operation supports continuous bone transforms and events; other timelines need state-aware reversal.",
      { timelines: unsupported.map((timeline) => timelinePath(timeline.path)) });
  }
  const boneTimelines = timelines.filter((timeline) => timeline.section === "bones");
  if (boneTimelines.length === 0) {
    throw new SpineError("NO_BONE_TIMELINES", "The source animation has no continuous bone motion to reverse.");
  }
  const missingStarts = boneTimelines.filter((timeline) =>
    keyTime(timeline.keys[0], [...timeline.path, 0]) !== 0);
  if (missingStarts.length > 0) {
    throw new SpineError("MISSING_START_KEY", "Every reversed bone timeline needs a time-zero key.",
      { timelines: missingStarts.map((timeline) => timelinePath(timeline.path)) });
  }
  let longest = 0;
  for (const timeline of timelines) {
    for (const [index, key] of timeline.keys.entries()) {
      longest = Math.max(longest, keyTime(key, [...timeline.path, index]));
    }
  }
  const duration = operation.duration ?? longest;
  if (!Number.isFinite(duration) || duration <= 0 || duration < longest) {
    throw new SpineError("INVALID_REVERSE_DURATION", "Reverse duration must be positive and cover every key.",
      { longest, duration });
  }
  const cloned = structuredClone(source) as Record<string, unknown>;
  let keys = 0;
  let anchorKeys = 0;
  let events = 0;
  let curveControls = 0;
  for (const timeline of timelines) {
    let parent: unknown = cloned;
    const parts = timeline.path.slice(2);
    for (const part of parts.slice(0, -1)) {
      if (parent === null || typeof parent !== "object" || Array.isArray(parent)) {
        throw new SpineError("INVALID_DATA", `Cannot locate cloned timeline ${timelinePath(timeline.path)}.`);
      }
      parent = (parent as Record<string, unknown>)[String(part)];
    }
    if (parent === null || typeof parent !== "object" || Array.isArray(parent)) {
      throw new SpineError("INVALID_DATA", `Cannot locate cloned timeline ${timelinePath(timeline.path)}.`);
    }
    const leaf = String(parts.at(-1));
    if (!Array.isArray((parent as Record<string, unknown>)[leaf])) {
      throw new SpineError("INVALID_DATA", `Cannot locate cloned timeline ${timelinePath(timeline.path)}.`);
    }
    const reversed = timeline.keys.map((oldKey, index) => {
      const newKey = structuredClone(oldKey);
      newKey.time = finiteTime(duration - keyTime(oldKey, [...timeline.path, index]), "Reversing animation");
      delete newKey.curve;
      return newKey;
    }).reverse();
    keys += reversed.length;
    if (timeline.section === "events") {
      events += reversed.length;
      (parent as Record<string, unknown>)[leaf] = reversed;
      continue;
    }
    const channelCount = curveChannelCount(timeline)!;
    for (let originalIndex = 0; originalIndex < timeline.keys.length - 1; originalIndex += 1) {
      const oldCurve = timeline.keys[originalIndex].curve;
      if (oldCurve === undefined) continue;
      if (oldCurve === "stepped") {
        throw new SpineError("UNSUPPORTED_REVERSE_CURVE", "A stepped segment cannot be reversed exactly as a continuous timeline.",
          { path: timelinePath([...timeline.path, originalIndex, "curve"]) });
      }
      if (!Array.isArray(oldCurve) || oldCurve.length !== channelCount * 4
        || !oldCurve.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new SpineError("UNSUPPORTED_CURVE", `Cannot reverse curve at ${timelinePath([...timeline.path, originalIndex, "curve"])}.`);
      }
      const nextReversed = reversed[timeline.keys.length - 2 - originalIndex];
      const adjusted: number[] = [];
      for (let offset = 0; offset < oldCurve.length; offset += 4) {
        adjusted.push(finiteTime(duration - (oldCurve[offset + 2] as number), "Reversing Bézier control"),
          oldCurve[offset + 3] as number,
          finiteTime(duration - (oldCurve[offset] as number), "Reversing Bézier control"),
          oldCurve[offset + 1] as number);
        curveControls += 2;
      }
      nextReversed.curve = adjusted;
    }
    const finalOldTime = keyTime(timeline.keys.at(-1)!, [...timeline.path, timeline.keys.length - 1]);
    if (finalOldTime < duration) {
      const anchor = structuredClone(timeline.keys.at(-1)!);
      anchor.time = 0;
      delete anchor.curve;
      reversed.unshift(anchor);
      anchorKeys += 1;
      keys += 1;
    }
    (parent as Record<string, unknown>)[leaf] = reversed;
  }
  const edits = modify(document.text, ["animations", newAnimation], cloned,
    { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } });
  return {
    text: applyEdits(document.text, edits),
    changes: [{ path: timelinePath(["animations", newAnimation]), before: null, after: cloned }],
    summary: { kind: "reverse_bone_animation", sourceAnimation, newAnimation, duration,
      boneTimelines: boneTimelines.length, keys, anchorKeys, events, curveControls },
  };
}
