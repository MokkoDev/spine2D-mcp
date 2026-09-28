import { findNodeAtLocation, parseTree } from "jsonc-parser";

import type { KeyChange } from "./bulk.js";
import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { collectTimelines, keyTime, timelinePath, type Timeline } from "./timelines.js";

type JsonRecord = Record<string, unknown>;

export interface MakeLoopOperation {
  kind: "make_loop";
  animation: string;
  duration?: number;
  smooth?: boolean;
  tolerance?: number;
}

export interface LoopSeamIssue {
  path: string;
  field: string;
  before: unknown;
  start: unknown;
}

export interface LoopSummary {
  kind: "make_loop";
  animation: string;
  duration: number;
  poseTimelines: number;
  timelinesChanged: number;
  closingKeysAdded: number;
  timelinesSmoothed: number;
  seamIssueCountBefore: number;
  seamIssuesBefore: LoopSeamIssue[];
  seamIssuesTruncated: boolean;
  seamIssuesAfter: number;
  reviewHintCount: number;
  reviewHints: string[];
  reviewHintsTruncated: boolean;
}

function pose(key: JsonRecord): JsonRecord {
  const result: JsonRecord = {};
  for (const [field, value] of Object.entries(key)) {
    if (field !== "time" && field !== "curve") result[field] = value;
  }
  return result;
}

function equal(left: unknown, right: unknown, tolerance: number): boolean {
  if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) <= tolerance;
  return JSON.stringify(left) === JSON.stringify(right);
}

function reportValue(value: unknown): unknown {
  if (Array.isArray(value)) return { type: "array", length: value.length, sample: value.slice(0, 4) };
  if (value !== null && typeof value === "object") return { type: "object", fields: Object.keys(value) };
  if (typeof value === "string" && value.length > 100) return `${value.slice(0, 100)}…`;
  return value ?? null;
}

interface Channel { field: string; defaultValue: number }

function curveChannels(timeline: Timeline, key: JsonRecord): Channel[] | undefined {
  if (timeline.section !== "bones") return undefined;
  if (timeline.type === "rotate") {
    if (typeof key.value === "number") return [{ field: "value", defaultValue: 0 }];
    if (typeof key.angle === "number") return [{ field: "angle", defaultValue: 0 }];
  }
  if (timeline.type === "translate" || timeline.type === "shear") {
    return [{ field: "x", defaultValue: 0 }, { field: "y", defaultValue: 0 }];
  }
  if (timeline.type === "scale") {
    return [{ field: "x", defaultValue: 1 }, { field: "y", defaultValue: 1 }];
  }
  return undefined;
}

function easeCurve(fromTime: number, fromValue: number, toTime: number, toValue: number): number[] {
  const span = toTime - fromTime;
  if (span <= 0) throw new SpineError("LOOP_TIME_CONFLICT", "A loop seam needs a positive duration for its final segment.");
  return [
    Number((fromTime + span / 3).toPrecision(12)), fromValue,
    Number((toTime - span / 3).toPrecision(12)), toValue,
  ];
}

function channelValue(key: JsonRecord, channel: Channel): number | undefined {
  const value = key[channel.field] ?? channel.defaultValue;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function easeChannels(channels: Channel[], from: JsonRecord, to: JsonRecord, fromTime: number, toTime: number): number[] | undefined {
  const result: number[] = [];
  for (const channel of channels) {
    const fromValue = channelValue(from, channel);
    const toValue = channelValue(to, channel);
    if (fromValue === undefined || toValue === undefined) return undefined;
    result.push(...easeCurve(fromTime, fromValue, toTime, toValue));
  }
  return result;
}

export function makeLoopText(document: SpineDocument, operation: MakeLoopOperation): { text: string; changes: KeyChange[]; summary: LoopSummary } {
  const animations = document.data.animations;
  if (!animations || typeof animations !== "object" || Array.isArray(animations) || !Object.hasOwn(animations, operation.animation)) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${operation.animation} was not found.`);
  }
  const timelines = collectTimelines(operation.animation, (animations as Record<string, unknown>)[operation.animation]);
  const poseTimelines = timelines.filter((timeline) => timeline.section !== "events" && timeline.keys.length > 0);
  if (poseTimelines.length === 0) throw new SpineError("NO_POSE_TIMELINES", "The animation has no keyed pose timeline to close.");
  const longest = poseTimelines.reduce((maximum, timeline) =>
    Math.max(maximum, keyTime(timeline.keys.at(-1)!, [...timeline.path, timeline.keys.length - 1])), 0);
  const duration = operation.duration ?? longest;
  const tolerance = operation.tolerance ?? 0.001;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new SpineError("INVALID_LOOP_ARGUMENT", "Loop duration must be positive and tolerance nonnegative.");
  }
  if (longest > duration) throw new SpineError("LOOP_RANGE_CONFLICT", "A pose key falls after the requested loop duration.", { longest, duration });
  const missingStarts = poseTimelines.filter((timeline) => keyTime(timeline.keys[0], [...timeline.path, 0]) !== 0).map((timeline) => timelinePath(timeline.path));
  if (missingStarts.length > 0) {
    throw new SpineError("MISSING_START_KEY", "Every pose timeline needs a key at time zero to close the full animated pose safely.", { timelines: missingStarts });
  }
  const tree = parseTree(document.text);
  if (!tree) throw new SpineError("INVALID_JSON", "Cannot locate JSON syntax tree for loop editing.");
  const replacements: { offset: number; length: number; text: string }[] = [];
  const changes: KeyChange[] = [];
  const reviewHints: string[] = [];
  const seamIssuesBefore: LoopSeamIssue[] = [];
  let timelinesChanged = 0;
  let closingKeysAdded = 0;
  let timelinesSmoothed = 0;

  for (const timeline of poseTimelines) {
    const path = timelinePath(timeline.path);
    const keys = timeline.keys.map((key) => structuredClone(key));
    const first = keys[0];
    const lastIndex = keys.length - 1;
    const last = keys[lastIndex];
    const lastTime = keyTime(last, [...timeline.path, lastIndex]);
    const firstPose = pose(first);
    const lastPose = pose(last);
    for (const field of new Set([...Object.keys(firstPose), ...Object.keys(lastPose)])) {
      if (!equal(firstPose[field], lastPose[field], tolerance)) {
        seamIssuesBefore.push({ path, field, before: reportValue(lastPose[field]), start: reportValue(firstPose[field]) });
      }
    }

    const close: JsonRecord = { ...structuredClone(firstPose), time: duration };
    if (lastTime === duration) {
      if (!equal(firstPose, lastPose, tolerance)) {
        changes.push({ path: timelinePath([...timeline.path, lastIndex]), before: last, after: close });
        keys[lastIndex] = close;
      }
    } else {
      keys.push(close);
      closingKeysAdded += 1;
      changes.push({ path: timelinePath([...timeline.path, keys.length - 1]), before: null, after: close });
    }

    const channels = curveChannels(timeline, first);
    if (operation.smooth !== false && channels && keys.length >= 2) {
      const previousIndex = keys.length - 2;
      const previous = keys[previousIndex];
      const previousTime = keyTime(previous, [...timeline.path, previousIndex]);
      const curve = easeChannels(channels, previous, close, previousTime, duration);
      if (curve) {
        const oldCurve = previous.curve;
        if (!equal(oldCurve, curve, 0)) {
          previous.curve = curve;
          changes.push({ path: timelinePath([...timeline.path, previousIndex, "curve"]), before: oldCurve ?? null, after: curve });
        }
        if (previousIndex > 0) {
          const next = keys[1];
          const nextTime = keyTime(next, [...timeline.path, 1]);
          if (first.curve !== "stepped") {
            const oldStartCurve = first.curve;
            const startCurve = Array.isArray(oldStartCurve) && oldStartCurve.length === channels.length * 4
              ? [...oldStartCurve]
              : easeChannels(channels, first, next, 0, nextTime);
            if (startCurve) {
              channels.forEach((channel, index) => { startCurve[index * 4 + 1] = channelValue(first, channel)!; });
              if (!equal(oldStartCurve, startCurve, 0)) {
                first.curve = startCurve;
                changes.push({ path: timelinePath([...timeline.path, 0, "curve"]), before: oldStartCurve ?? null, after: startCurve });
              }
            }
          }
        }
        timelinesSmoothed += 1;
      } else {
        reviewHints.push(`${path}: easing was skipped because a transform channel is not numeric.`);
      }
    } else if (operation.smooth !== false && keys.length > 1) {
      reviewHints.push(`${path}: verify the transition visually; automatic easing supports bone rotation, translation, scale, and shear timelines.`);
    }
    if (!equal(pose(keys[0]), pose(keys.at(-1)!), 0)) {
      throw new SpineError("LOOP_SEAM_UNRESOLVED", `The loop seam still differs at ${path}.`);
    }
    if (changes.some((change) => change.path === path || change.path.startsWith(`${path}/`))) {
      const node = findNodeAtLocation(tree, timeline.path);
      if (!node || node.type !== "array") throw new SpineError("INVALID_DATA", `Timeline array was not found at ${path}.`);
      replacements.push({ offset: node.offset, length: node.length, text: JSON.stringify(keys) });
      timelinesChanged += 1;
    }
  }
  const events = timelines.find((timeline) => timeline.section === "events");
  if (events?.keys.some((key, index) => keyTime(key, [...events.path, index]) >= duration)) {
    reviewHints.push("Events at or after the loop end may fire twice or be skipped by playback; review event timing.");
  }
  replacements.sort((left, right) => right.offset - left.offset);
  let text = document.text;
  for (const replacement of replacements) {
    text = text.slice(0, replacement.offset) + replacement.text + text.slice(replacement.offset + replacement.length);
  }
  return {
    text, changes,
    summary: { kind: "make_loop", animation: operation.animation, duration, poseTimelines: poseTimelines.length, timelinesChanged,
      closingKeysAdded, timelinesSmoothed,
      seamIssueCountBefore: seamIssuesBefore.length, seamIssuesBefore: seamIssuesBefore.slice(0, 100), seamIssuesTruncated: seamIssuesBefore.length > 100,
      seamIssuesAfter: 0, reviewHintCount: reviewHints.length, reviewHints: reviewHints.slice(0, 25), reviewHintsTruncated: reviewHints.length > 25 },
  };
}
