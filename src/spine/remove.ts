import { applyEdits, modify } from "jsonc-parser";

import type { KeyChange } from "./bulk.js";
import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { collectTimelines, timelinePath, type JsonPath } from "./timelines.js";

type JsonRecord = Record<string, unknown>;
type ConstraintType = "ik" | "transform" | "path" | "physics";
export interface RemoveConstraintOperation {
  kind: "remove_constraint";
  constraintType: ConstraintType;
  name: string;
}
export interface RemoveEventOperation { kind: "remove_event"; name: string }
export interface RemoveAnimationOperation { kind: "remove_animation"; name: string }
export type RemoveOperation = RemoveConstraintOperation | RemoveEventOperation | RemoveAnimationOperation;
export interface RemoveSummary {
  kind: RemoveOperation["kind"];
  name: string;
  action: "removed";
  path: string;
  constraintType?: ConstraintType;
  timelineCount?: number;
  keyCount?: number;
}

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function named(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}
function checkName(value: unknown): asserts value is string {
  if (!named(value)) throw new SpineError("INVALID_NAME", "A nonempty name is required.");
}
function allTimelines(document: SpineDocument) {
  const animations = record(document.data.animations) ? document.data.animations : {};
  return Object.entries(animations).flatMap(([name, animation]) => collectTimelines(name, animation));
}
function inUse(code: string, item: string, references: JsonPath[]): never {
  const pointers = [...new Set(references.map(timelinePath))];
  throw new SpineError(code, `${item} is still referenced.`,
    { references: pointers.slice(0, 100), referenceCount: pointers.length });
}
function removed(document: SpineDocument, path: JsonPath, before: unknown, summary: RemoveSummary,
  sectionReplacement?: { section: string; value: unknown }) {
  const edits = sectionReplacement
    ? modify(document.text, [sectionReplacement.section], sectionReplacement.value, { formattingOptions })
    : modify(document.text, path, undefined, { formattingOptions });
  return { text: applyEdits(document.text, edits),
    changes: [{ path: timelinePath(path), before, after: null } satisfies KeyChange], summary };
}

export function removeConstraintText(document: SpineDocument, operation: RemoveConstraintOperation) {
  checkName(operation.name);
  const modern = /^4\.3(?:\.|$)/.test(document.version);
  const section = modern ? "constraints" : operation.constraintType;
  const incompatible = modern ? ["ik", "transform", "path", "physics"] : ["constraints"];
  if (incompatible.some((field) => Array.isArray(document.data[field]) && document.data[field].length > 0)) {
    throw new SpineError("MIXED_CONSTRAINT_FORMAT", "Constraint sections do not match the Spine export version.");
  }
  const entries = document.data[section] ?? [];
  if (!Array.isArray(entries) || !entries.every(record)) throw new SpineError("INVALID_CONSTRAINTS", `${section} must be an array of objects.`);
  const index = entries.findIndex((item) => item.name === operation.name && (!modern || item.type === operation.constraintType));
  if (index < 0) throw new SpineError("MISSING_CONSTRAINT", `${operation.constraintType} constraint ${operation.name} does not exist.`);
  const references: JsonPath[] = [];
  const skins = Array.isArray(document.data.skins) ? document.data.skins : [];
  skins.forEach((skin, skinIndex) => {
    if (!record(skin)) return;
    for (const field of [operation.constraintType, "constraints"] as const) {
      const memberships = skin[field];
      if (!Array.isArray(memberships)) continue;
      memberships.forEach((membership, memberIndex) => {
        if (membership === operation.name || record(membership) && membership.name === operation.name
          && (membership.type === undefined || membership.type === operation.constraintType)) {
          references.push(["skins", skinIndex, field, memberIndex]);
        }
      });
    }
  });
  for (const timeline of allTimelines(document)) {
    if (timeline.section === operation.constraintType && timeline.target === operation.name) references.push(timeline.path);
  }
  if (references.length > 0) inUse("CONSTRAINT_IN_USE", `${operation.constraintType} constraint ${operation.name}`, references);
  const path: JsonPath = [section, index];
  return removed(document, path, entries[index], {
    kind: "remove_constraint", name: operation.name, action: "removed", path: timelinePath(path),
    constraintType: operation.constraintType,
  }, { section, value: entries.filter((_, itemIndex) => itemIndex !== index) });
}

export function removeEventText(document: SpineDocument, operation: RemoveEventOperation) {
  checkName(operation.name);
  const events = document.data.events ?? {};
  if (!record(events)) throw new SpineError("INVALID_EVENTS", "Event definitions must be an object.");
  if (!Object.hasOwn(events, operation.name)) throw new SpineError("MISSING_EVENT", `Event ${operation.name} does not exist.`);
  const references: JsonPath[] = [];
  for (const timeline of allTimelines(document)) {
    if (timeline.section !== "events") continue;
    timeline.keys.forEach((key, index) => {
      if (key.name === operation.name) references.push([...timeline.path, index, "name"]);
    });
  }
  if (references.length > 0) inUse("EVENT_IN_USE", `Event ${operation.name}`, references);
  const path: JsonPath = ["events", operation.name];
  return removed(document, path, events[operation.name],
    { kind: "remove_event", name: operation.name, action: "removed", path: timelinePath(path) });
}

export function removeAnimationText(document: SpineDocument, operation: RemoveAnimationOperation) {
  checkName(operation.name);
  const animations = document.data.animations ?? {};
  if (!record(animations)) throw new SpineError("INVALID_ANIMATIONS", "Animations must be an object.");
  if (!Object.hasOwn(animations, operation.name)) throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${operation.name} does not exist.`);
  const animation = animations[operation.name];
  if (!record(animation)) throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${operation.name} does not exist.`);
  const timelines = collectTimelines(operation.name, animation);
  const path: JsonPath = ["animations", operation.name];
  return removed(document, path, animation, {
    kind: "remove_animation", name: operation.name, action: "removed", path: timelinePath(path),
    timelineCount: timelines.length, keyCount: timelines.reduce((sum, timeline) => sum + timeline.keys.length, 0),
  });
}
