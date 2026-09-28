import { findNodeAtLocation, parseTree } from "jsonc-parser";

import type { KeyChange } from "./bulk.js";
import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { collectTimelines, keyTime, timelinePath, type Timeline } from "./timelines.js";

export interface SetCurveOperation {
  kind: "set_curve";
  animation: string;
  bone: string;
  timelineType: "rotate" | "translate" | "scale" | "shear";
  time: number;
  mode: CurveMode;
  controls?: number[];
}

export type CurveMode = "linear" | "stepped" | "bezier" | "ease_in" | "ease_out" | "ease_in_out";

export const EASING_PRESETS = {
  ease_in: [0.42, 0, 1, 1],
  ease_out: [0, 0, 0.58, 1],
  ease_in_out: [0.42, 0, 0.58, 1],
} as const;

export interface CurveSummary {
  kind: "set_curve";
  animation: string;
  bone: string;
  timelineType: SetCurveOperation["timelineType"];
  time: number;
  nextTime: number;
  mode: SetCurveOperation["mode"];
  channels: number;
  changed: boolean;
}

interface Channel { field: string; defaultValue: number }

function channels(timeline: Timeline, key: Record<string, unknown>, next: Record<string, unknown>): Channel[] {
  if (timeline.type === "rotate") {
    if (key.value !== undefined && key.angle !== undefined || next.value !== undefined && next.angle !== undefined) {
      throw new SpineError("UNSUPPORTED_CURVE", "A rotate key cannot contain both value and angle fields.");
    }
    const field = key.value !== undefined || next.value !== undefined ? "value" : "angle";
    if (field === "value" && (key.angle !== undefined || next.angle !== undefined)) {
      throw new SpineError("UNSUPPORTED_CURVE", "Adjacent rotate keys use different value fields.");
    }
    return [{ field, defaultValue: 0 }];
  }
  const defaultValue = timeline.type === "scale" ? 1 : 0;
  return [{ field: "x", defaultValue }, { field: "y", defaultValue }];
}

function numericValue(key: Record<string, unknown>, channel: Channel, path: string): number {
  const value = key[channel.field] ?? channel.defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SpineError("INVALID_KEY_VALUE", `Expected a finite ${channel.field} value at ${path}.`);
  }
  return value;
}

export function setCurveText(document: SpineDocument, operation: SetCurveOperation): { text: string; changes: KeyChange[]; summary: CurveSummary } {
  if (!Number.isFinite(operation.time) || operation.time < 0) throw new SpineError("INVALID_KEY_TIME", "Curve key time must be finite and nonnegative.");
  const animations = document.data.animations as Record<string, unknown> | undefined;
  if (!animations || !Object.hasOwn(animations, operation.animation)) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${operation.animation} was not found.`);
  }
  const timelines = collectTimelines(operation.animation, animations[operation.animation]);
  const timeline = timelines.find((item) => item.section === "bones" && item.target === operation.bone && item.type === operation.timelineType);
  if (!timeline) throw new SpineError("TIMELINE_NOT_FOUND", `Bone ${operation.bone} has no ${operation.timelineType} timeline in ${operation.animation}.`);
  const matching = timeline.keys.map((key, index) => keyTime(key, [...timeline.path, index]) === operation.time ? index : -1).filter((index) => index >= 0);
  if (matching.length === 0) throw new SpineError("KEY_NOT_FOUND", `No ${operation.timelineType} key exists at time ${operation.time}.`);
  if (matching.length > 1) throw new SpineError("AMBIGUOUS_KEY", `Multiple ${operation.timelineType} keys exist at time ${operation.time}.`);
  const index = matching[0];
  if (index === timeline.keys.length - 1) throw new SpineError("NO_NEXT_KEY", "The last key has no outgoing interpolation segment.");
  const key = timeline.keys[index];
  const next = timeline.keys[index + 1];
  const nextTime = keyTime(next, [...timeline.path, index + 1]);
  if (nextTime <= operation.time) throw new SpineError("CURVE_TIME_CONFLICT", "The next key must be later to define an interpolation segment.");
  const channelList = channels(timeline, key, next);
  let after: string | number[] | undefined;
  if (operation.mode === "bezier" || operation.mode in EASING_PRESETS) {
    if (operation.mode !== "bezier" && operation.controls !== undefined) {
      throw new SpineError("INVALID_CURVE_CONTROLS", "Named easing presets do not accept controls.");
    }
    const controls = operation.mode === "bezier" ? operation.controls : EASING_PRESETS[operation.mode as keyof typeof EASING_PRESETS];
    if (!controls || controls.length !== 4 || !controls.every((value) => typeof value === "number" && Number.isFinite(value))
      || controls[0] < 0 || controls[0] > controls[2] || controls[2] > 1) {
      throw new SpineError("INVALID_CURVE_CONTROLS", "Bézier controls must be [x1, y1, x2, y2], with finite values and 0 ≤ x1 ≤ x2 ≤ 1.");
    }
    const span = nextTime - operation.time;
    after = channelList.flatMap((channel) => {
      const path = timelinePath([...timeline.path, index]);
      const fromValue = numericValue(key, channel, path);
      const toValue = numericValue(next, channel, timelinePath([...timeline.path, index + 1]));
      const range = toValue - fromValue;
      return [
        operation.time + span * controls[0], fromValue + range * controls[1],
        operation.time + span * controls[2], fromValue + range * controls[3],
      ].map((value) => Number(value.toPrecision(12)));
    });
    if (!after.every(Number.isFinite)) throw new SpineError("CURVE_OVERFLOW", "Bézier controls produced a nonfinite value.");
  } else {
    if (operation.controls !== undefined) throw new SpineError("INVALID_CURVE_CONTROLS", "Controls are only accepted for Bézier interpolation.");
    after = operation.mode === "stepped" ? "stepped" : undefined;
  }
  const before = key.curve;
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  const curvePath = timelinePath([...timeline.path, index, "curve"]);
  let text = document.text;
  if (changed) {
    const tree = parseTree(document.text);
    const node = tree && findNodeAtLocation(tree, [...timeline.path, index]);
    if (!node || node.type !== "object") throw new SpineError("INVALID_DATA", `Key object was not found at ${timelinePath([...timeline.path, index])}.`);
    const updated = { ...key };
    if (after === undefined) delete updated.curve;
    else updated.curve = after;
    text = document.text.slice(0, node.offset) + JSON.stringify(updated) + document.text.slice(node.offset + node.length);
  }
  return {
    text,
    changes: changed ? [{ path: curvePath, before: before ?? null, after: after ?? null }] : [],
    summary: { kind: "set_curve", animation: operation.animation, bone: operation.bone, timelineType: operation.timelineType,
      time: operation.time, nextTime, mode: operation.mode, channels: channelList.length, changed },
  };
}
