import { findNodeAtLocation, parseTree } from "jsonc-parser";

import type { KeyChange } from "./bulk.js";
import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { curveChannelCount, keyTime, timelinePath, type JsonPath } from "./timelines.js";

type JsonRecord = Record<string, unknown>;

export interface KeyframeSelector {
  section: "bones" | "slots" | "ik" | "transform" | "path" | "physics" | "slider" | "attachments" | "deform" | "events" | "drawOrder";
  target?: string;
  timelineType?: string;
  skin?: string;
  slot?: string;
  attachment?: string;
}

export interface SetKeyframeOperation {
  kind: "set_keyframe";
  animation: string;
  selector: KeyframeSelector;
  time: number;
  values: JsonRecord;
  curvePolicy?: "reject" | "linearize";
}

export interface DeleteKeyframeOperation {
  kind: "delete_keyframe";
  animation: string;
  selector: KeyframeSelector;
  time: number;
  eventName?: string;
}

export interface KeyframeSummary {
  kind: "set_keyframe" | "delete_keyframe";
  animation: string;
  timeline: string;
  time: number;
  action: "inserted" | "updated" | "deleted";
  keysBefore: number;
  keysAfter: number;
  curveResets: number;
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new SpineError("INVALID_TIMELINE_SELECTOR", `${field} must be a nonempty name.`);
  return value;
}

function timelineParts(document: SpineDocument, selector: KeyframeSelector): string[] {
  const { section, timelineType } = selector;
  if (section === "events" || section === "drawOrder") return [section];
  if (section === "attachments") {
    if (!["deform", "sequence"].includes(String(timelineType))) throw new SpineError("UNSUPPORTED_TIMELINE_TYPE", "Attachment timeline type must be deform or sequence.");
    return [section, requiredName(selector.skin, "skin"), requiredName(selector.slot, "slot"), requiredName(selector.attachment, "attachment"), timelineType!];
  }
  if (section === "deform") {
    if (timelineType !== undefined) throw new SpineError("INVALID_TIMELINE_SELECTOR", "Legacy deform timelines do not use timelineType.");
    return [section, requiredName(selector.skin, "skin"), requiredName(selector.slot, "slot"), requiredName(selector.attachment, "attachment")];
  }
  const target = requiredName(selector.target, "target");
  if (section === "ik" || section === "transform") {
    if (timelineType !== undefined) throw new SpineError("INVALID_TIMELINE_SELECTOR", `${section} timelines do not use timelineType.`);
    return [section, target];
  }
  const types: Record<string, string[]> = {
    bones: ["rotate", "translate", "translatex", "translatey", "scale", "scalex", "scaley", "shear", "shearx", "sheary", "inherit"],
    slots: ["attachment", "rgba", "rgb", "alpha", "rgba2", "rgb2"],
    path: ["position", "spacing", "mix"],
    physics: ["reset", "inertia", "strength", "damping", "mass", "wind", "gravity", "mix"],
    slider: ["time", "mix"],
  };
  if (!types[section]?.includes(String(timelineType))) {
    throw new SpineError("UNSUPPORTED_TIMELINE_TYPE", `${section} timeline type ${String(timelineType)} is not supported for key editing.`);
  }
  if (section === "slider" && !/^4\.3(?:\.|$)/.test(document.version)) {
    throw new SpineError("UNSUPPORTED_VERSION", "Slider timelines require Spine 4.3.");
  }
  return [section, target, timelineType!];
}

function numeric(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function validateValues(document: SpineDocument, selector: KeyframeSelector, values: JsonRecord, newKey: boolean): void {
  if (!record(values)) throw new SpineError("INVALID_KEY_VALUES", "Key values must be an object.");
  const { section, timelineType } = selector;
  const type = timelineType ?? section;
  const scalarBone = ["rotate", "translatex", "translatey", "scalex", "scaley", "shearx", "sheary"].includes(type);
  const pairedBone = ["translate", "scale", "shear"].includes(type);
  let allowed: Record<string, "number" | "integer" | "boolean" | "string" | "nullableName" | "rgba" | "rgb" | "vertices" | "offsets" | "inherit" | "sequenceMode">;
  if (section === "bones" && scalarBone) allowed = { value: "number" };
  else if (section === "bones" && pairedBone) allowed = { x: "number", y: "number" };
  else if (section === "bones" && type === "inherit") allowed = { inherit: "inherit" };
  else if (section === "slots" && type === "attachment") allowed = { name: "nullableName" };
  else if (section === "slots" && type === "rgba") allowed = { color: "rgba" };
  else if (section === "slots" && type === "rgb") allowed = { color: "rgb" };
  else if (section === "slots" && type === "alpha") allowed = { value: "number" };
  else if (section === "slots" && type === "rgba2") allowed = { light: "rgba", dark: "rgb" };
  else if (section === "slots" && type === "rgb2") allowed = { light: "rgb", dark: "rgb" };
  else if (section === "ik") allowed = { mix: "number", softness: "number", bendPositive: "boolean", compress: "boolean", stretch: "boolean" };
  else if (section === "transform") allowed = { mixRotate: "number", mixX: "number", mixY: "number", mixScaleX: "number", mixScaleY: "number", mixShearY: "number" };
  else if (section === "path" && ["position", "spacing"].includes(type)) allowed = { value: "number" };
  else if (section === "path" && type === "mix") allowed = { mixRotate: "number", mixX: "number", mixY: "number" };
  else if (section === "physics" && type === "reset") allowed = {};
  else if (section === "physics" || section === "slider") allowed = { value: "number" };
  else if ((section === "attachments" || section === "deform") && type === "deform") allowed = { offset: "integer", vertices: "vertices" };
  else if (section === "attachments" && type === "sequence") allowed = { mode: "sequenceMode", index: "integer", delay: "number" };
  else if (section === "events") allowed = { name: "string", int: "integer", float: "number", string: "string", volume: "number", balance: "number" };
  else if (section === "drawOrder") allowed = { offsets: "offsets" };
  else throw new SpineError("UNSUPPORTED_TIMELINE_TYPE", `${section} ${type} is not supported for key editing.`);

  for (const [field, value] of Object.entries(values)) {
    const kind = allowed[field];
    if (!kind) throw new SpineError("INVALID_KEY_FIELD", `${field} is not a supported value field for ${section} ${type}.`);
    let valid = false;
    if (kind === "number") valid = numeric(value);
    else if (kind === "integer") valid = Number.isSafeInteger(value) && (field !== "offset" && field !== "index" || Number(value) >= 0);
    else if (kind === "boolean") valid = typeof value === "boolean";
    else if (kind === "string") valid = typeof value === "string" && (field !== "name" || value.length > 0);
    else if (kind === "nullableName") valid = value === null || typeof value === "string" && value.length > 0;
    else if (kind === "rgba") valid = typeof value === "string" && /^[0-9a-fA-F]{8}$/.test(value);
    else if (kind === "rgb") valid = typeof value === "string" && /^[0-9a-fA-F]{6}$/.test(value);
    else if (kind === "vertices") valid = Array.isArray(value) && value.every(numeric);
    else if (kind === "inherit") valid = typeof value === "string" && ["normal", "onlyTranslation", "noRotationOrReflection", "noScale", "noScaleOrReflection"].some((name) => name.toLowerCase() === value.toLowerCase());
    else if (kind === "sequenceMode") valid = typeof value === "string" && ["hold", "once", "loop", "pingpong", "onceReverse", "loopReverse", "pingpongReverse"].some((name) => name.toLowerCase() === value.toLowerCase());
    else if (kind === "offsets") valid = Array.isArray(value) && value.every((entry) => record(entry) && typeof entry.slot === "string" && entry.slot.length > 0 && Number.isSafeInteger(entry.offset));
    if (!valid) throw new SpineError("INVALID_KEY_VALUE", `${field} is invalid for ${section} ${type}.`);
  }
  if (newKey && section === "slots" && ["rgba", "rgb"].includes(type) && values.color === undefined) throw new SpineError("MISSING_KEY_VALUE", "A new color key needs color.");
  if (newKey && section === "slots" && ["rgba2", "rgb2"].includes(type) && (values.light === undefined || values.dark === undefined)) throw new SpineError("MISSING_KEY_VALUE", "A new two-color key needs light and dark.");
  if (newKey && section === "events" && values.name === undefined) throw new SpineError("MISSING_KEY_VALUE", "A new event key needs name.");
  if ((section === "attachments" || section === "deform") && type === "deform" && values.offset !== undefined && values.vertices === undefined) throw new SpineError("INVALID_KEY_VALUE", "Deform offset needs vertices in the same key.");
  if (section === "drawOrder" && Array.isArray(values.offsets)) {
    const slots = Array.isArray(document.data.slots) ? document.data.slots as JsonRecord[] : [];
    const slotIndices = new Map(slots.map((slot, index) => [slot.name, index]));
    let previous = -1;
    const shifted = new Set<number>();
    for (const entry of values.offsets as JsonRecord[]) {
      const index = slotIndices.get(entry.slot);
      if (index === undefined || index <= previous) throw new SpineError("INVALID_DRAW_ORDER", "Draw order offsets must reference slots in setup order without repeats.");
      const result = index + Number(entry.offset);
      if (result < 0 || result >= slots.length || shifted.has(result)) throw new SpineError("INVALID_DRAW_ORDER", "A draw order offset moves a slot outside the slot range or into another moved slot.");
      shifted.add(result);
      previous = index;
    }
  }
}

function animationData(document: SpineDocument, name: string): JsonRecord {
  const animations = document.data.animations;
  if (!record(animations) || !Object.hasOwn(animations, name) || !record(animations[name])) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${name} was not found.`);
  }
  return animations[name] as JsonRecord;
}

function getTimeline(animation: JsonRecord, parts: string[]): JsonRecord[] | undefined {
  let current: unknown = animation;
  for (const part of parts) {
    if (!record(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  if (!Array.isArray(current) || !current.every(record)) throw new SpineError("INVALID_DATA", `Timeline ${parts.join("/")} is not a key array.`);
  return current;
}

function setTimeline(animation: JsonRecord, parts: string[], keys: JsonRecord[] | undefined): void {
  let current: JsonRecord = animation;
  const parents: JsonRecord[] = [animation];
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(current, part)) Object.defineProperty(current, part, { value: {}, writable: true, enumerable: true, configurable: true });
    if (!record(current[part])) throw new SpineError("INVALID_DATA", `Timeline parent ${part} is not an object.`);
    current = current[part] as JsonRecord;
    parents.push(current);
  }
  const leaf = parts.at(-1)!;
  if (keys === undefined) {
    delete current[leaf];
    for (let index = parents.length - 1; index > 0; index--) {
      if (Object.keys(parents[index]).length > 0) break;
      delete parents[index - 1][parts[index - 1]];
    }
  } else Object.defineProperty(current, leaf, { value: keys, writable: true, enumerable: true, configurable: true });
}

function replaceAnimation(document: SpineDocument, name: string, animation: JsonRecord): string {
  const tree = parseTree(document.text);
  const node = tree && findNodeAtLocation(tree, ["animations", name]);
  if (!node || node.type !== "object") throw new SpineError("INVALID_JSON", `Cannot locate animation ${name} in JSON text.`);
  return document.text.slice(0, node.offset) + JSON.stringify(animation) + document.text.slice(node.offset + node.length);
}

function matchingIndices(keys: JsonRecord[], time: number, section: string, eventName?: string): number[] {
  return keys.flatMap((key, index) => keyTime(key, [index]) === time && (section !== "events" || eventName === undefined || key.name === eventName) ? [index] : []);
}

function requireTime(time: number): void {
  if (!Number.isFinite(time) || time < 0) throw new SpineError("INVALID_KEY_TIME", "Key time must be finite and nonnegative.");
}

function cloneAnimation(document: SpineDocument, name: string): JsonRecord {
  return structuredClone(animationData(document, name));
}

export function setKeyframeText(document: SpineDocument, operation: SetKeyframeOperation): { text: string; changes: KeyChange[]; summary: KeyframeSummary } {
  requireTime(operation.time);
  const parts = timelineParts(document, operation.selector);
  const animation = cloneAnimation(document, operation.animation);
  const keys = getTimeline(animation, parts) ?? [];
  const timeline: JsonPath = ["animations", operation.animation, ...parts];
  const eventName = operation.selector.section === "events" ? operation.values.name : undefined;
  if (operation.selector.section === "events" && (typeof eventName !== "string" || eventName.length === 0)) {
    throw new SpineError("MISSING_KEY_VALUE", "An event key needs a name to identify it at its time.");
  }
  const matches = matchingIndices(keys, operation.time, operation.selector.section, typeof eventName === "string" ? eventName : undefined);
  if (matches.length > 1) throw new SpineError("AMBIGUOUS_KEY", `More than one key matches ${timelinePath(timeline)} at ${operation.time}.`);
  if (operation.selector.section !== "events" && matches.length === 0 && matchingIndices(keys, operation.time, operation.selector.section).length > 0) {
    throw new SpineError("AMBIGUOUS_KEY", `A key already exists at ${operation.time}.`);
  }
  const oldIndex = matches[0];
  validateValues(document, operation.selector, operation.values, oldIndex === undefined);
  const changes: KeyChange[] = [];
  let curveResets = 0;
  let action: KeyframeSummary["action"];
  if (oldIndex !== undefined) {
    const before = structuredClone(keys[oldIndex]);
    const valueChanged = Object.entries(operation.values).some(([field, value]) =>
      JSON.stringify(before[field]) !== JSON.stringify(value));
    if (valueChanged) {
      for (const affected of [oldIndex - 1, oldIndex]) {
        if (affected < 0 || !Array.isArray(keys[affected].curve)) continue;
        if (operation.curvePolicy !== "linearize") {
          throw new SpineError("CURVE_VALUE_EDIT_REQUIRES_LINEARIZE",
            "Updating a value on a Bézier segment needs curvePolicy: linearize or new curve controls.",
            { timeline: timelinePath(timeline), time: operation.time });
        }
        const prior = keys[affected].curve;
        delete keys[affected].curve;
        changes.push({ path: timelinePath([...timeline, affected, "curve"]), before: prior, after: null });
        curveResets++;
      }
    }
    keys[oldIndex] = { ...keys[oldIndex], ...structuredClone(operation.values), time: operation.time };
    action = "updated";
    if (JSON.stringify(before) !== JSON.stringify(keys[oldIndex])) changes.push({ path: timelinePath([...timeline, oldIndex]), before, after: keys[oldIndex] });
  } else {
    const index = keys.findIndex((key, keyIndex) => keyTime(key, [...timeline, keyIndex]) > operation.time);
    const insertIndex = index < 0 ? keys.length : index;
    const previous = keys[insertIndex - 1];
    if (previous && Array.isArray(previous.curve)) {
      if (operation.curvePolicy !== "linearize") {
        throw new SpineError("CURVE_SPLIT_REQUIRED", "Inserting inside a Bézier segment needs curvePolicy: linearize or a curve split operation.", { timeline: timelinePath(timeline), previousTime: keyTime(previous, [...timeline, insertIndex - 1]) });
      }
      const before = previous.curve;
      delete previous.curve;
      changes.push({ path: timelinePath([...timeline, insertIndex - 1, "curve"]), before, after: null });
      curveResets++;
    }
    const key = { ...structuredClone(operation.values), time: operation.time };
    keys.splice(insertIndex, 0, key);
    changes.push({ path: timelinePath([...timeline, insertIndex]), before: null, after: key });
    action = "inserted";
  }
  setTimeline(animation, parts, keys);
  return { text: changes.length === 0 ? document.text : replaceAnimation(document, operation.animation, animation), changes,
    summary: { kind: "set_keyframe", animation: operation.animation, timeline: timelinePath(timeline), time: operation.time,
      action, keysBefore: keys.length - (action === "inserted" ? 1 : 0), keysAfter: keys.length, curveResets } };
}

export function deleteKeyframeText(document: SpineDocument, operation: DeleteKeyframeOperation): { text: string; changes: KeyChange[]; summary: KeyframeSummary } {
  requireTime(operation.time);
  const parts = timelineParts(document, operation.selector);
  const animation = cloneAnimation(document, operation.animation);
  const keys = getTimeline(animation, parts);
  const timeline: JsonPath = ["animations", operation.animation, ...parts];
  if (!keys) throw new SpineError("TIMELINE_NOT_FOUND", `Timeline ${timelinePath(timeline)} was not found.`);
  const matches = matchingIndices(keys, operation.time, operation.selector.section, operation.eventName);
  if (matches.length === 0) throw new SpineError("KEY_NOT_FOUND", `No key was found at ${operation.time} on ${timelinePath(timeline)}.`);
  if (matches.length > 1) throw new SpineError("AMBIGUOUS_KEY", "More than one event key shares this time; provide eventName.");
  const index = matches[0];
  const before = structuredClone(keys[index]);
  const changes: KeyChange[] = [{ path: timelinePath([...timeline, index]), before, after: null }];
  const keysBefore = keys.length;
  keys.splice(index, 1);
  let curveResets = 0;
  if (index > 0 && Array.isArray(keys[index - 1].curve)) {
    const curve = keys[index - 1].curve;
    delete keys[index - 1].curve;
    changes.push({ path: timelinePath([...timeline, index - 1, "curve"]), before: curve, after: null });
    curveResets = 1;
  }
  setTimeline(animation, parts, keys.length > 0 ? keys : undefined);
  return { text: replaceAnimation(document, operation.animation, animation), changes,
    summary: { kind: "delete_keyframe", animation: operation.animation, timeline: timelinePath(timeline), time: operation.time,
      action: "deleted", keysBefore, keysAfter: keys.length, curveResets } };
}
