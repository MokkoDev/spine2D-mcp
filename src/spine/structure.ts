import { applyEdits, modify } from "jsonc-parser";

import type { KeyChange } from "./bulk.js";
import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { referenceGraph } from "./inspect.js";
import { collectTimelines, timelinePath, type JsonPath } from "./timelines.js";

type JsonRecord = Record<string, unknown>;
export interface RemoveBoneOperation { kind: "remove_bone"; name: string }
export interface RemoveSlotOperation { kind: "remove_slot"; name: string }
export interface ReorderSlotsOperation {
  kind: "reorder_slots";
  names: string[];
  animationPolicy?: "reject" | "preserve";
}
export type StructureOperation = RemoveBoneOperation | RemoveSlotOperation | ReorderSlotsOperation;
export interface StructureSummary {
  kind: StructureOperation["kind"];
  action: "removed" | "reordered" | "unchanged";
  path: string;
  name?: string;
  remappedWeights?: number;
  rewrittenDrawOrderKeys?: number;
}

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function checkName(name: string): void {
  if (typeof name !== "string" || !name.trim() || name.includes("\0")) {
    throw new SpineError("INVALID_NAME", "A nonempty name is required.");
  }
}
function entries(document: SpineDocument, section: "bones" | "slots"): JsonRecord[] {
  const value = document.data[section];
  if (!Array.isArray(value) || !value.every(record)) {
    throw new SpineError(`INVALID_${section.toUpperCase()}`, `${section} must be an array of objects.`);
  }
  return value;
}
function change(text: string, path: JsonPath, before: unknown, after: unknown, changes: KeyChange[]): string {
  if (JSON.stringify(before) === JSON.stringify(after)) return text;
  changes.push({ path: timelinePath(path), before, after });
  return applyEdits(text, modify(text, path, after, { formattingOptions }));
}
function inUse(code: string, item: string, paths: string[]): never {
  const references = [...new Set(paths)];
  throw new SpineError(code, `${item} is still referenced.`,
    { references: references.slice(0, 100), referenceCount: references.length });
}
function animations(document: SpineDocument): [string, JsonRecord][] {
  const value = document.data.animations;
  return record(value) ? Object.entries(value).filter((entry): entry is [string, JsonRecord] => record(entry[1])) : [];
}
function drawOrderTimelines(document: SpineDocument) {
  return animations(document).flatMap(([name, animation]) => collectTimelines(name, animation)
    .filter((timeline) => timeline.section === "drawOrder" || timeline.section === "draworder"));
}
function ensureNoFolderDrawOrder(document: SpineDocument): void {
  const paths = animations(document).flatMap(([name, animation]) =>
    Object.hasOwn(animation, "drawOrderFolder") ? [`/animations/${name.replaceAll("~", "~0").replaceAll("/", "~1")}/drawOrderFolder`] : []);
  if (paths.length) throw new SpineError("UNSUPPORTED_DRAW_ORDER_FOLDER", "Folder draw-order timelines cannot be safely rewritten.", { references: paths });
}

function decodeDrawOrder(setup: string[], key: JsonRecord, path: JsonPath): string[] {
  if (key.offsets === undefined) return [...setup];
  if (!Array.isArray(key.offsets) || key.offsets.length > setup.length) {
    throw new SpineError("INVALID_DRAW_ORDER", `Invalid offsets at ${timelinePath(path)}.`);
  }
  const order = Array<string | undefined>(setup.length).fill(undefined);
  const unchanged: string[] = [];
  let original = 0;
  for (const offset of key.offsets) {
    if (!record(offset) || typeof offset.slot !== "string" || !Number.isSafeInteger(offset.offset)) {
      throw new SpineError("INVALID_DRAW_ORDER", `Invalid offset at ${timelinePath(path)}.`);
    }
    const index = setup.indexOf(offset.slot);
    if (index < original) throw new SpineError("INVALID_DRAW_ORDER", `Offsets must follow setup slot order at ${timelinePath(path)}.`);
    while (original < index) unchanged.push(setup[original++]);
    const destination = original + Number(offset.offset);
    if (destination < 0 || destination >= setup.length || order[destination] !== undefined) {
      throw new SpineError("INVALID_DRAW_ORDER", `Offset destination is invalid at ${timelinePath(path)}.`);
    }
    order[destination] = setup[original++];
  }
  while (original < setup.length) unchanged.push(setup[original++]);
  for (let index = order.length - 1; index >= 0; index -= 1) {
    if (order[index] === undefined) order[index] = unchanged.pop();
  }
  if (unchanged.length || order.some((slot) => slot === undefined)) {
    throw new SpineError("INVALID_DRAW_ORDER", `Offsets do not form a slot order at ${timelinePath(path)}.`);
  }
  return order as string[];
}

function encodeDrawOrder(setup: string[], desired: string[]): { slot: string; offset: number }[] | undefined {
  if (setup.every((slot, index) => slot === desired[index])) return undefined;
  const positions = new Map(desired.map((slot, index) => [slot, index]));
  if (positions.size !== setup.length || setup.some((slot) => !positions.has(slot))) {
    throw new SpineError("INVALID_DRAW_ORDER", "The preserved order is not a slot permutation.");
  }
  // The runtime assigns each offset in setup order. Including every slot makes any permutation unambiguous.
  return setup.map((slot, index) => ({ slot, offset: positions.get(slot)! - index }));
}

export function reorderSlotsText(document: SpineDocument, operation: ReorderSlotsOperation) {
  ensureNoFolderDrawOrder(document);
  const slots = entries(document, "slots");
  const oldNames = slots.map((slot) => String(slot.name));
  if (slots.length > 2048 || !Array.isArray(operation.names) || operation.names.length !== slots.length
    || new Set(operation.names).size !== slots.length || oldNames.some((name) => !operation.names.includes(name))) {
    throw new SpineError("INVALID_SLOT_ORDER", "Provide every existing slot name exactly once (at most 2048 slots).");
  }
  if (oldNames.every((name, slotIndex) => name === operation.names[slotIndex])) {
    return { text: document.text, changes: [] as KeyChange[], summary: {
      kind: "reorder_slots", action: "unchanged", path: "/slots", rewrittenDrawOrderKeys: 0,
    } satisfies StructureSummary };
  }
  const index = new Map(slots.map((slot) => [String(slot.name), slot]));
  const reordered = operation.names.map((name) => index.get(name)!);
  const timelines = drawOrderTimelines(document);
  if (timelines.some((timeline) => timeline.keys.length > 0) && (operation.animationPolicy ?? "reject") === "reject") {
    inUse("DRAW_ORDER_IN_USE", "Setup slot order", timelines.filter((timeline) => timeline.keys.length > 0).map((timeline) => timelinePath(timeline.path)));
  }
  const changes: KeyChange[] = [];
  let text = document.text;
  let rewrittenDrawOrderKeys = 0;
  for (const timeline of timelines) {
    timeline.keys.forEach((key, keyIndex) => {
      const path = [...timeline.path, keyIndex];
      const desired = decodeDrawOrder(oldNames, key, path);
      const offsets = encodeDrawOrder(operation.names, desired);
      const next = { ...key };
      if (offsets) next.offsets = offsets;
      else delete next.offsets;
      if (JSON.stringify(key) !== JSON.stringify(next)) {
        text = change(text, path, key, next, changes);
        rewrittenDrawOrderKeys += 1;
      }
    });
  }
  text = change(text, ["slots"], slots, reordered, changes);
  return { text, changes, summary: { kind: "reorder_slots", action: changes.length ? "reordered" : "unchanged",
    path: "/slots", rewrittenDrawOrderKeys } satisfies StructureSummary };
}

function weightedAttachmentVertices(attachment: JsonRecord): { vertices: number[]; count: number } | undefined {
  if (!["mesh", "boundingbox", "path", "clipping"].includes(String(attachment.type))) return undefined;
  const vertices = attachment.vertices;
  if (!Array.isArray(vertices) || !vertices.every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
  const count = attachment.type === "mesh" && Array.isArray(attachment.uvs)
    ? attachment.uvs.length / 2 : Number(attachment.vertexCount);
  if (!Number.isSafeInteger(count) || count < 1 || vertices.length === count * 2) return undefined;
  return { vertices, count };
}

export function removeBoneText(document: SpineDocument, operation: RemoveBoneOperation) {
  checkName(operation.name);
  const bones = entries(document, "bones");
  const index = bones.findIndex((bone) => bone.name === operation.name);
  if (index < 0) throw new SpineError("MISSING_BONE", `Bone ${operation.name} does not exist.`);
  if (index === 0) throw new SpineError("ROOT_BONE", "The root bone cannot be removed.");
  const references = referenceGraph(document, "bone", operation.name).references.map((reference) => reference.path);
  const remaps: { path: JsonPath; before: number[]; after: number[]; count: number }[] = [];
  const skins = Array.isArray(document.data.skins) ? document.data.skins : [];
  skins.forEach((skin, skinIndex) => {
    if (!record(skin) || !record(skin.attachments)) return;
    for (const [slot, byName] of Object.entries(skin.attachments)) {
      if (!record(byName)) continue;
      for (const [attachmentName, attachment] of Object.entries(byName)) {
        if (!record(attachment)) continue;
        const weighted = weightedAttachmentVertices(attachment);
        if (!weighted) continue;
        const after = [...weighted.vertices];
        let cursor = 0;
        let count = 0;
        for (let vertex = 0; vertex < weighted.count; vertex += 1) {
          const influences = after[cursor++];
          if (!Number.isSafeInteger(influences) || influences < 1 || cursor + influences * 4 > after.length) {
            throw new SpineError("INVALID_WEIGHT_ENCODING", `Invalid weighted vertices in skin ${skinIndex}, slot ${slot}, attachment ${attachmentName}.`);
          }
          for (let influence = 0; influence < influences; influence += 1) {
            const path: JsonPath = ["skins", skinIndex, "attachments", slot, attachmentName, "vertices", cursor];
            const boneIndex = after[cursor];
            if (!Number.isSafeInteger(boneIndex) || boneIndex < 0 || boneIndex >= bones.length) {
              throw new SpineError("INVALID_WEIGHT_ENCODING", `Invalid bone index at ${timelinePath(path)}.`);
            }
            if (boneIndex === index) references.push(timelinePath(path));
            if (boneIndex > index) { after[cursor] = boneIndex - 1; count += 1; }
            cursor += 4;
          }
        }
        if (cursor !== after.length) throw new SpineError("INVALID_WEIGHT_ENCODING", "Weighted vertices have trailing values.");
        if (count) remaps.push({ path: ["skins", skinIndex, "attachments", slot, attachmentName, "vertices"],
          before: weighted.vertices, after, count });
      }
    }
  });
  if (references.length) inUse("BONE_IN_USE", `Bone ${operation.name}`, references);
  const changes: KeyChange[] = [];
  let text = document.text;
  for (const remap of remaps) text = change(text, remap.path, remap.before, remap.after, changes);
  text = change(text, ["bones"], bones, bones.filter((_, boneIndex) => boneIndex !== index), changes);
  return { text, changes, summary: { kind: "remove_bone", name: operation.name, action: "removed",
    path: `/bones/${index}`, remappedWeights: remaps.reduce((sum, remap) => sum + remap.count, 0) } satisfies StructureSummary };
}

export function removeSlotText(document: SpineDocument, operation: RemoveSlotOperation) {
  checkName(operation.name);
  ensureNoFolderDrawOrder(document);
  const slots = entries(document, "slots");
  const index = slots.findIndex((slot) => slot.name === operation.name);
  if (index < 0) throw new SpineError("MISSING_SLOT", `Slot ${operation.name} does not exist.`);
  const references = referenceGraph(document, "slot", operation.name).references.map((reference) => reference.path);
  for (const timeline of drawOrderTimelines(document)) {
    if (timeline.keys.length) references.push(timelinePath(timeline.path));
  }
  if (references.length) inUse("SLOT_IN_USE", `Slot ${operation.name}`, references);
  const changes: KeyChange[] = [];
  const text = change(document.text, ["slots"], slots, slots.filter((_, slotIndex) => slotIndex !== index), changes);
  return { text, changes, summary: { kind: "remove_slot", name: operation.name, action: "removed",
    path: `/slots/${index}` } satisfies StructureSummary };
}
