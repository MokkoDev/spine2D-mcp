import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";

import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { collectTimelines, keyTime, timelinePath, type Timeline } from "./timelines.js";

export type BulkAction = "move" | "scale" | "duplicate" | "delete" | "offset" | "quantize";

export interface BulkKeysOperation {
  kind: "bulk_keys";
  animation: string;
  action: BulkAction;
  section?: string;
  target?: string;
  timelineType?: string;
  from?: number;
  to?: number;
  delta?: number;
  factor?: number;
  anchor?: number;
  grid?: number;
  field?: string;
  amount?: number;
}

export interface KeyChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface BulkSummary {
  kind: "bulk_keys";
  animation: string;
  action: BulkAction;
  timelines: number;
  keysSelected: number;
  keysBefore: number;
  keysAfter: number;
}

interface Entry {
  key: Record<string, unknown>;
  origin: number;
  time: number;
  selected: boolean;
  duplicate?: boolean;
}

function finite(value: number | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SpineError("INVALID_BULK_ARGUMENT", `${field} must be a finite number.`);
  }
  return value;
}

function setTime(entry: Entry, time: number, timeline: Timeline): number {
  if (!Number.isFinite(time) || time < 0) {
    throw new SpineError("INVALID_KEY_TIME", `Bulk edit produced an invalid time at ${timelinePath(timeline.path)}.`);
  }
  const normalized = Number(time.toPrecision(12));
  entry.time = normalized;
  if (normalized !== 0 || entry.key.time !== undefined) entry.key.time = normalized;
  return normalized;
}

function reflowCurves(before: Entry[], after: Entry[], timeline: Timeline, changes: KeyChange[]): void {
  after.forEach((entry, index) => {
    const source = before[entry.origin];
    const curve = source.key.curve;
    const newNext = after[index + 1];
    if (newNext && newNext.origin === entry.origin && (entry.duplicate || newNext.duplicate)) {
      if (curve !== undefined) {
        delete entry.key.curve;
        changes.push({ path: timelinePath([...timeline.path, index, "curve"]), before: curve, after: null });
      }
      return;
    }
    if (curve === undefined || curve === "stepped") return;
    if (!Array.isArray(curve) || curve.length === 0 || curve.length % 4 !== 0 || !curve.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new SpineError("UNSUPPORTED_CURVE", `Cannot edit curve at ${timelinePath([...timeline.path, entry.origin, "curve"])}.`);
    }
    const oldNext = before[entry.origin + 1];
    if (!newNext) return;
    if (!oldNext) {
      delete entry.key.curve;
      changes.push({ path: timelinePath([...timeline.path, index, "curve"]), before: curve, after: null });
      return;
    }
    const oldSpan = oldNext.time - source.time;
    const newSpan = newNext.time - entry.time;
    if (oldSpan <= 0 || newSpan <= 0) {
      throw new SpineError("CURVE_TIME_CONFLICT", `A Bézier segment has zero or negative duration at ${timelinePath(timeline.path)}.`);
    }
    const adjusted = [...curve] as number[];
    for (let control = 0; control < curve.length; control += 4) {
      for (const offset of [0, 2]) {
        const location = control + offset;
        const original = curve[location] as number;
        const next = entry.time + ((original - source.time) / oldSpan) * newSpan;
        if (!Number.isFinite(next)) throw new SpineError("TIME_OVERFLOW", "Bézier control time overflowed.");
        const normalized = Number(next.toPrecision(12));
        adjusted[location] = normalized;
        if (!Object.is(original, normalized)) changes.push({ path: timelinePath([...timeline.path, index, "curve", location]), before: original, after: normalized });
      }
    }
    entry.key.curve = adjusted;
  });
}

export function bulkKeysText(document: SpineDocument, operation: BulkKeysOperation): { text: string; changes: KeyChange[]; summary: BulkSummary } {
  const animations = document.data.animations;
  if (!animations || typeof animations !== "object" || Array.isArray(animations) || !Object.hasOwn(animations, operation.animation)) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${operation.animation} was not found.`);
  }
  const from = operation.from ?? 0;
  const to = operation.to ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(from) || from < 0 || to < from || (operation.to !== undefined && !Number.isFinite(to))) {
    throw new SpineError("INVALID_RANGE", "Bulk key range must be finite, nonnegative, and ordered.");
  }
  const action = operation.action;
  const delta = ["move", "duplicate"].includes(action) ? finite(operation.delta, "delta") : undefined;
  const factor = action === "scale" ? finite(operation.factor, "factor") : undefined;
  const anchor = action === "scale" ? finite(operation.anchor ?? 0, "anchor") : undefined;
  const grid = action === "quantize" ? finite(operation.grid, "grid") : undefined;
  const amount = action === "offset" ? finite(operation.amount, "amount") : undefined;
  if (factor !== undefined && factor <= 0) throw new SpineError("INVALID_BULK_ARGUMENT", "factor must be greater than zero.");
  if (grid !== undefined && grid <= 0) throw new SpineError("INVALID_BULK_ARGUMENT", "grid must be greater than zero.");
  if (action === "duplicate" && delta === 0) throw new SpineError("INVALID_BULK_ARGUMENT", "duplicate delta cannot be zero.");
  if (action === "offset" && (!operation.field || ["time", "curve", "vertices", "offsets"].includes(operation.field))) {
    throw new SpineError("INVALID_BULK_ARGUMENT", "offset requires a scalar numeric key field other than time or curve data.");
  }
  const timelines = collectTimelines(operation.animation, (animations as Record<string, unknown>)[operation.animation]);
  const matched = timelines.filter((timeline) =>
    (operation.section === undefined || timeline.section === operation.section)
    && (operation.target === undefined || timeline.target === operation.target)
    && (operation.timelineType === undefined || timeline.type === operation.timelineType));
  if (matched.length === 0) throw new SpineError("TIMELINE_NOT_FOUND", "No timeline matches the bulk key selector.");
  const rootNode = parseTree(document.text);
  if (!rootNode) throw new SpineError("INVALID_JSON", "Cannot locate JSON syntax tree for bulk editing.");
  const changes: KeyChange[] = [];
  const replacements: { offset: number; length: number; text: string }[] = [];
  const removedTimelines: Timeline["path"][] = [];
  let keysSelected = 0;
  let keysBefore = 0;
  let keysAfter = 0;
  let editedTimelines = 0;

  for (const timeline of matched) {
    const firstChange = changes.length;
    const before: Entry[] = timeline.keys.map((key, index) => {
      const time = keyTime(key, [...timeline.path, index]);
      return { key, origin: index, time, selected: time >= from && time <= to };
    });
    const selected = before.filter((entry) => entry.selected);
    if (selected.length === 0) continue;
    editedTimelines += 1;
    keysSelected += selected.length;
    keysBefore += before.length;
    let after: Entry[] = before.map((entry) => ({ ...entry, key: structuredClone(entry.key) }));
    if (action === "offset") {
      if (before.some((entry) => Array.isArray(entry.key.curve))) {
        throw new SpineError("UNSUPPORTED_CURVE_VALUE_EDIT", `Numeric offsets on Bézier timelines need value-control updates: ${timelinePath(timeline.path)}.`);
      }
      after.forEach((entry) => {
        if (!entry.selected) return;
        const field = operation.field!;
        const previous = entry.key[field];
        if (typeof previous !== "number" || !Number.isFinite(previous)) {
          throw new SpineError("NON_NUMERIC_KEY_FIELD", `${field} is not a numeric field at ${timelinePath([...timeline.path, entry.origin])}.`);
        }
        const next = previous + amount!;
        if (!Number.isFinite(next)) throw new SpineError("VALUE_OVERFLOW", `Numeric offset overflowed at ${timelinePath([...timeline.path, entry.origin, field])}.`);
        entry.key[field] = next;
        if (!Object.is(previous, next)) changes.push({ path: timelinePath([...timeline.path, entry.origin, field]), before: previous, after: next });
      });
    } else if (action === "delete") {
      after = after.filter((entry) => !entry.selected);
      selected.forEach((entry) => changes.push({ path: timelinePath([...timeline.path, entry.origin]), before: entry.key, after: null }));
    } else if (action === "duplicate") {
      const copies = after.filter((entry) => entry.selected).map((entry) => {
        const copy: Entry = { ...entry, key: structuredClone(entry.key), duplicate: true };
        setTime(copy, entry.time + delta!, timeline);
        return copy;
      });
      after.push(...copies);
      after.sort((left, right) => left.time - right.time || Number(Boolean(left.duplicate)) - Number(Boolean(right.duplicate)) || left.origin - right.origin);
      after.forEach((entry, index) => {
        if (entry.duplicate) changes.push({ path: timelinePath([...timeline.path, index]), before: null, after: entry.key });
      });
    } else {
      after.forEach((entry) => {
        if (!entry.selected) return;
        const previous = entry.time;
        let next: number;
        if (action === "move") next = previous + delta!;
        else if (action === "scale") next = anchor! + (previous - anchor!) * factor!;
        else next = Number((Math.round(previous / grid!) * grid!).toPrecision(12));
        const normalized = setTime(entry, next, timeline);
        if (!Object.is(previous, normalized)) changes.push({ path: timelinePath([...timeline.path, entry.origin, "time"]), before: previous, after: normalized });
      });
    }
    if (action !== "offset") {
      for (let index = 1; index < after.length; index += 1) {
        const previous = after[index - 1];
        const current = after[index];
        const preexistingTie = !previous.duplicate && !current.duplicate && before[previous.origin].time === before[current.origin].time;
        const conflict = current.time < previous.time
          || (timeline.section !== "events" && current.time === previous.time && !preexistingTie);
        if (conflict) throw new SpineError("KEY_ORDER_CONFLICT", `Bulk edit creates crossed or coincident keys at ${timelinePath(timeline.path)}.`);
      }
      if (action === "delete" || action === "duplicate" || after.some((entry) => !Object.is(entry.time, before[entry.origin].time))) {
        reflowCurves(before, after, timeline, changes);
      }
    }
    keysAfter += after.length;
    if (changes.length === firstChange) continue;
    if (after.length === 0) {
      removedTimelines.push(timeline.path);
      continue;
    }
    const node = findNodeAtLocation(rootNode, timeline.path);
    if (!node || node.type !== "array") throw new SpineError("INVALID_DATA", `Timeline array was not found at ${timelinePath(timeline.path)}.`);
    replacements.push({ offset: node.offset, length: node.length, text: JSON.stringify(after.map((entry) => entry.key)) });
  }
  if (keysSelected === 0) throw new SpineError("NO_KEYS_SELECTED", "No keys match the requested time range.");
  replacements.sort((left, right) => right.offset - left.offset);
  let text = document.text;
  for (const replacement of replacements) {
    text = text.slice(0, replacement.offset) + replacement.text + text.slice(replacement.offset + replacement.length);
  }
  for (const path of removedTimelines) {
    text = applyEdits(text, modify(text, path, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  return { text, changes, summary: { kind: "bulk_keys", animation: operation.animation, action, timelines: editedTimelines, keysSelected, keysBefore, keysAfter } };
}
