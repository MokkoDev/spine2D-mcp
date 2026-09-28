import { applyEdits, modify } from "jsonc-parser";

import type { KeyChange } from "./bulk.js";
import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { collectTimelines, timelinePath, type JsonPath } from "./timelines.js";

type JsonRecord = Record<string, unknown>;

export interface UpsertBoneOperation {
  kind: "upsert_bone";
  name: string;
  parent?: string;
  values?: {
    x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number;
    shearX?: number; shearY?: number; length?: number; inherit?: string;
    skin?: boolean; color?: string;
  };
}

export interface UpsertSlotOperation {
  kind: "upsert_slot";
  name: string;
  bone?: string;
  values?: { attachment?: string | null; color?: string; dark?: string; blend?: "normal" | "additive" | "multiply" | "screen" };
}

export interface UpsertRegionAttachmentOperation {
  kind: "upsert_region_attachment";
  skin: string;
  slot: string;
  name: string;
  values: {
    name?: string; path?: string; x?: number; y?: number; rotation?: number;
    scaleX?: number; scaleY?: number; width?: number; height?: number; color?: string;
  };
}

export interface UpsertAnimationOperation {
  kind: "upsert_animation";
  name: string;
}

export interface UpsertSkinOperation {
  kind: "upsert_skin";
  name: string;
  values?: { bones?: string[]; ik?: string[]; transform?: string[]; path?: string[]; physics?: string[]; constraints?: string[] };
}

export interface RemoveSkinOperation {
  kind: "remove_skin";
  name: string;
}

export interface UpsertEventOperation {
  kind: "upsert_event";
  name: string;
  values?: { int?: number; float?: number; string?: string; audio?: string; volume?: number; balance?: number };
}

export interface SetSkeletonMetadataOperation {
  kind: "set_skeleton_metadata";
  values: { images?: string; audio?: string | null; fps?: number };
}

export interface UpsertConstraintOperation {
  kind: "upsert_constraint";
  constraintType: "ik" | "transform" | "path" | "physics";
  name: string;
  edition: "professional" | "essential";
  bones?: string[];
  target?: string;
  bone?: string;
  values?: JsonRecord;
}

export type RigOperation = UpsertBoneOperation | UpsertSlotOperation | UpsertRegionAttachmentOperation
  | UpsertAnimationOperation | UpsertSkinOperation | UpsertEventOperation | SetSkeletonMetadataOperation
  | UpsertConstraintOperation | RemoveSkinOperation;

export interface RigSummary {
  kind: RigOperation["kind"];
  name: string;
  action: "created" | "updated" | "unchanged" | "removed";
  path: string;
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function name(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new SpineError("INVALID_NAME", `${field} must be a nonempty name.`);
  return value;
}

function finite(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SpineError("INVALID_SETUP_VALUE", `${field} must be a finite number.`);
}

function color(value: unknown, field: string, digits: number): void {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(value)) {
    throw new SpineError("INVALID_SETUP_VALUE", `${field} must be a ${digits}-digit hexadecimal color.`);
  }
}

function replaceSection(document: SpineDocument, section: string, value: unknown): string {
  const edits = modify(document.text, [section], value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } });
  return applyEdits(document.text, edits);
}

function result(document: SpineDocument, section: string, after: unknown, path: JsonPath, beforeValue: unknown, afterValue: unknown,
  kind: RigOperation["kind"], itemName: string): { text: string; changes: KeyChange[]; summary: RigSummary } {
  const changed = JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
  const action: RigSummary["action"] = !changed ? "unchanged" : beforeValue === undefined ? "created" : "updated";
  return {
    text: changed ? replaceSection(document, section, after) : document.text,
    changes: changed ? [{ path: timelinePath(path), before: beforeValue ?? null, after: afterValue }] : [],
    summary: { kind, name: itemName, action, path: timelinePath(path) },
  };
}

const TRANSFORM_PROPERTIES = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"] as const;

function constraintValueFields(type: UpsertConstraintOperation["constraintType"], version43: boolean) {
  const numbers: Record<UpsertConstraintOperation["constraintType"], string[]> = {
    ik: ["mix", "softness"],
    transform: ["rotation", "x", "y", "scaleX", "scaleY", "shearY", "mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"],
    path: ["rotation", "position", "spacing", "mixRotate", "mixX", "mixY"],
    physics: ["x", "y", "rotate", "scaleX", "shearX", "limit", "inertia", "strength", "damping", "mass", "wind", "gravity", "mix"],
  };
  const booleans: Record<UpsertConstraintOperation["constraintType"], string[]> = {
    ik: ["bendPositive", "compress", "stretch", "uniform", "skin"],
    transform: ["local", "relative", "skin"],
    path: ["skin"],
    physics: ["skin", "inertiaGlobal", "strengthGlobal", "dampingGlobal", "massGlobal", "windGlobal", "gravityGlobal", "mixGlobal"],
  };
  return { numbers: numbers[type], booleans: booleans[type],
    modes: type === "path" ? { positionMode: ["fixed", "percent"], spacingMode: ["length", "fixed", "percent"],
      rotateMode: ["tangent", "chain", "chainScale"] } : {},
    properties: type === "transform" && version43 };
}

function validateConstraintValues(operation: UpsertConstraintOperation, version43: boolean): JsonRecord {
  const values = operation.values ?? {};
  if (!record(values)) throw new SpineError("INVALID_CONSTRAINT_VALUE", "Constraint values must be an object.");
  const allowed = constraintValueFields(operation.constraintType, version43);
  const validated: JsonRecord = {};
  for (const [field, value] of Object.entries(values)) {
    if (allowed.numbers.includes(field)) {
      finite(value, field);
      if (["softness", "limit", "strength"].includes(field) && Number(value) < 0
        || field === "mass" && Number(value) <= 0
        || ["mix", "inertia", "damping", "x", "y", "rotate", "scaleX", "shearX"].includes(field)
          && operation.constraintType === "physics" && (Number(value) < 0 || Number(value) > 1)
        || field === "mix" && operation.constraintType === "ik" && (Number(value) < 0 || Number(value) > 1)) {
        throw new SpineError("INVALID_CONSTRAINT_VALUE", `${field} is outside its supported range.`);
      }
      validated[field] = value;
    } else if (allowed.booleans.includes(field)) {
      if (typeof value !== "boolean") throw new SpineError("INVALID_CONSTRAINT_VALUE", `${field} must be boolean.`);
      validated[field] = value;
    } else if (field === "fps" && operation.constraintType === "physics") {
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 240) {
        throw new SpineError("INVALID_CONSTRAINT_VALUE", "Physics fps must be an integer from 1 to 240.");
      }
      validated[field] = value;
    } else if (field === "order" && !version43) {
      if (!Number.isSafeInteger(value) || Number(value) < 0) throw new SpineError("INVALID_CONSTRAINT_VALUE", "Constraint order must be a nonnegative integer.");
      validated[field] = value;
    } else if (field in allowed.modes) {
      if (!allowed.modes[field as keyof typeof allowed.modes]?.includes(String(value))) {
        throw new SpineError("INVALID_CONSTRAINT_VALUE", `${field} is not a supported path mode.`);
      }
      validated[field] = value;
    } else if (field === "properties" && allowed.properties) {
      if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length
        || !value.every((item) => TRANSFORM_PROPERTIES.includes(item))) {
        throw new SpineError("INVALID_CONSTRAINT_VALUE", "Transform properties must be distinct supported channels.");
      }
      validated.properties = Object.fromEntries(value.map((channel: string) => [channel,
        { to: { [channel]: ["scaleX", "scaleY"].includes(channel) ? {} : { max: 100 } } }]));
    } else {
      throw new SpineError("INVALID_CONSTRAINT_FIELD", `${field} is not supported for ${operation.constraintType} constraints in Spine ${version43 ? "4.3" : "4.2"}.`);
    }
  }
  return validated;
}

export function upsertConstraintText(document: SpineDocument, operation: UpsertConstraintOperation) {
  name(operation.name, "Constraint name");
  if (operation.edition !== "professional") {
    throw new SpineError("UNSUPPORTED_EDITION", "Creating or editing constraints requires Spine Professional.");
  }
  const version43 = /^4\.3(?:\.|$)/.test(document.version);
  const section = version43 ? "constraints" : operation.constraintType;
  const incompatible = version43 ? ["ik", "transform", "path", "physics"] : ["constraints"];
  if (incompatible.some((field) => Array.isArray(document.data[field]) && document.data[field].length > 0)) {
    throw new SpineError("MIXED_CONSTRAINT_FORMAT", `Spine ${version43 ? "4.3" : "4.2"} constraints need one version-specific section layout.`);
  }
  const raw = document.data[section] ?? [];
  if (!Array.isArray(raw) || !raw.every(record)) throw new SpineError("INVALID_CONSTRAINTS", `${section} must be an array of objects.`);
  const entries = raw as JsonRecord[];
  const index = entries.findIndex((item) => item.name === operation.name && (!version43 || item.type === operation.constraintType));
  if (version43 && entries.some((item) => item.name === operation.name && item.type !== operation.constraintType)) {
    throw new SpineError("CONSTRAINT_TYPE_CONFLICT", `Constraint ${operation.name} already exists with another type.`);
  }
  const before = index < 0 ? undefined : entries[index];
  const bones = new Set((Array.isArray(document.data.bones) ? document.data.bones : [])
    .filter(record).flatMap((item) => typeof item.name === "string" ? [item.name] : []));
  const slots = new Set((Array.isArray(document.data.slots) ? document.data.slots : [])
    .filter(record).flatMap((item) => typeof item.name === "string" ? [item.name] : []));
  const after: JsonRecord = { ...(before ?? {}), ...(version43 ? { type: operation.constraintType } : {}), name: operation.name };
  if (operation.constraintType === "physics") {
    if (operation.bones !== undefined || operation.target !== undefined) {
      throw new SpineError("INVALID_CONSTRAINT_TARGET", "Physics constraints use one bone and no target.");
    }
    const bone = operation.bone ?? after.bone;
    if (typeof bone !== "string" || !bones.has(bone)) throw new SpineError("MISSING_BONE", `Physics bone ${String(bone)} does not exist.`);
    after.bone = bone;
  } else {
    if (operation.bone !== undefined) throw new SpineError("INVALID_CONSTRAINT_TARGET", "This constraint uses bones and a target.");
    const selectedBones = operation.bones ?? after.bones;
    const maximum = operation.constraintType === "ik" ? 2 : 256;
    if (!Array.isArray(selectedBones) || selectedBones.length < 1 || selectedBones.length > maximum
      || new Set(selectedBones).size !== selectedBones.length || !selectedBones.every((bone) => typeof bone === "string" && bones.has(bone))) {
      throw new SpineError("INVALID_CONSTRAINT_BONES", `Select ${operation.constraintType === "ik" ? "one or two" : "one or more"} distinct existing bones.`);
    }
    after.bones = [...selectedBones];
    const targetField = version43 && operation.constraintType === "transform" ? "source"
      : version43 && operation.constraintType === "path" ? "slot" : "target";
    const target = operation.target ?? after[targetField];
    const available = operation.constraintType === "path" ? slots : bones;
    if (typeof target !== "string" || !available.has(target)) {
      throw new SpineError(operation.constraintType === "path" ? "MISSING_SLOT" : "MISSING_BONE",
        `Constraint target ${String(target)} does not exist.`);
    }
    after[targetField] = target;
    if (operation.constraintType === "path") {
      const pathAttachment = Array.isArray(document.data.skins) && document.data.skins.some((skin) =>
        record(skin) && record(skin.attachments) && record(skin.attachments[target])
        && Object.values(skin.attachments[target] as JsonRecord).some((item) => record(item) && item.type === "path"));
      if (!pathAttachment) throw new SpineError("MISSING_PATH_ATTACHMENT", `Slot ${target} needs a path attachment before it can be a path constraint target.`);
    }
  }
  Object.assign(after, validateConstraintValues(operation, version43));
  if (operation.constraintType === "transform" && version43 && !record(after.properties)) {
    throw new SpineError("MISSING_TRANSFORM_PROPERTIES", "A Spine 4.3 transform constraint needs active properties.");
  }
  if (!version43 && after.order === undefined) {
    const all = ["ik", "transform", "path", "physics"].flatMap((field) =>
      (Array.isArray(document.data[field]) ? document.data[field] : []).filter(record));
    after.order = all.reduce((maximum, item) => Math.max(maximum, typeof item.order === "number" ? item.order : -1), -1) + 1;
  }
  if (!version43 && typeof after.order === "number") {
    const occupied = ["ik", "transform", "path", "physics"].flatMap((field) =>
      (Array.isArray(document.data[field]) ? document.data[field] : []).filter(record))
      .some((item) => item !== before && item.order === after.order);
    if (occupied) throw new SpineError("CONSTRAINT_ORDER_CONFLICT", `Constraint order ${after.order} is already used.`);
  }
  const updated = entries.map((entry) => structuredClone(entry));
  if (index < 0) updated.push(after);
  else updated[index] = after;
  const path: JsonPath = [section, index < 0 ? updated.length - 1 : index];
  return result(document, section, updated, path, before, after, operation.kind, operation.name);
}

export function upsertBoneText(document: SpineDocument, operation: UpsertBoneOperation) {
  name(operation.name, "Bone name");
  const bones = document.data.bones;
  if (!Array.isArray(bones) || !bones.every(record)) throw new SpineError("INVALID_BONES", "Skeleton bones must be an array of objects.");
  const index = bones.findIndex((bone) => bone.name === operation.name);
  const before = index < 0 ? undefined : bones[index];
  if (index < 0 && !operation.parent) throw new SpineError("MISSING_PARENT", "A new nonroot bone needs a parent bone.");
  if (index === 0 && operation.parent !== undefined) throw new SpineError("ROOT_HAS_PARENT", "The root bone cannot be reparented.");
  if (operation.parent !== undefined && !bones.some((bone) => bone.name === operation.parent)) {
    throw new SpineError("MISSING_BONE", `Parent bone ${operation.parent} does not exist.`);
  }
  const values = operation.values ?? {};
  for (const [field, value] of Object.entries(values)) {
    if (["x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY", "length"].includes(field)) {
      finite(value, field);
      if (field === "length" && Number(value) < 0) throw new SpineError("INVALID_SETUP_VALUE", "Bone length cannot be negative.");
    } else if (field === "skin") {
      if (typeof value !== "boolean") throw new SpineError("INVALID_SETUP_VALUE", "Bone skin must be boolean.");
    } else if (field === "color") color(value, field, 8);
    else if (field === "inherit") {
      if (typeof value !== "string" || !["normal", "onlyTranslation", "noRotationOrReflection", "noScale", "noScaleOrReflection"].some((mode) => mode.toLowerCase() === value.toLowerCase())) {
        throw new SpineError("INVALID_SETUP_VALUE", "Bone inherit mode is not recognized.");
      }
    } else throw new SpineError("INVALID_SETUP_FIELD", `Unsupported bone setup field: ${field}.`);
  }
  const after = { ...(before ?? {}), name: operation.name,
    ...(operation.parent === undefined ? {} : { parent: operation.parent }), ...values };
  const updated = bones.map((bone) => structuredClone(bone));
  if (index < 0) updated.push(after);
  else updated[index] = after;
  const path: JsonPath = ["bones", index < 0 ? updated.length - 1 : index];
  return result(document, "bones", updated, path, before, after, operation.kind, operation.name);
}

export function upsertSlotText(document: SpineDocument, operation: UpsertSlotOperation) {
  name(operation.name, "Slot name");
  const slots = document.data.slots ?? [];
  if (!Array.isArray(slots) || !slots.every(record)) throw new SpineError("INVALID_SLOTS", "Skeleton slots must be an array of objects.");
  const index = slots.findIndex((slot) => slot.name === operation.name);
  const before = index < 0 ? undefined : slots[index];
  const bone = operation.bone ?? before?.bone;
  if (typeof bone !== "string" || !Array.isArray(document.data.bones) || !document.data.bones.some((item) => record(item) && item.name === bone)) {
    throw new SpineError("MISSING_BONE", `Slot bone ${String(bone)} does not exist.`);
  }
  const values = operation.values ?? {};
  for (const [field, value] of Object.entries(values)) {
    if (field === "attachment") {
      if (value !== null && (typeof value !== "string" || !value)) throw new SpineError("INVALID_SETUP_VALUE", "Slot attachment must be a name or null.");
    } else if (field === "color") color(value, field, 8);
    else if (field === "dark") color(value, field, 6);
    else if (field === "blend") {
      if (!["normal", "additive", "multiply", "screen"].includes(String(value))) throw new SpineError("INVALID_SETUP_VALUE", "Slot blend mode is not recognized.");
    } else throw new SpineError("INVALID_SETUP_FIELD", `Unsupported slot setup field: ${field}.`);
  }
  const after: JsonRecord = { ...(before ?? {}), name: operation.name, bone, ...values };
  if (values.attachment === null) delete after.attachment;
  const updated = slots.map((slot) => structuredClone(slot));
  if (index < 0) updated.push(after);
  else updated[index] = after;
  const path: JsonPath = ["slots", index < 0 ? updated.length - 1 : index];
  return result(document, "slots", updated, path, before, after, operation.kind, operation.name);
}

export function upsertRegionAttachmentText(document: SpineDocument, operation: UpsertRegionAttachmentOperation) {
  name(operation.skin, "Skin name");
  name(operation.slot, "Slot name");
  name(operation.name, "Attachment name");
  if (!Array.isArray(document.data.slots) || !document.data.slots.some((slot) => record(slot) && slot.name === operation.slot)) {
    throw new SpineError("MISSING_SLOT", `Slot ${operation.slot} does not exist.`);
  }
  const skins = document.data.skins;
  if (!Array.isArray(skins) || !skins.every(record)) throw new SpineError("INVALID_SKINS", "Skeleton skins must be an array of objects.");
  const index = skins.findIndex((skin) => skin.name === operation.skin);
  if (index < 0) throw new SpineError("MISSING_SKIN", `Skin ${operation.skin} does not exist.`);
  const selected = skins[index];
  const attachments = record(selected.attachments) ? selected.attachments : {};
  const bySlot = record(attachments[operation.slot]) ? attachments[operation.slot] as JsonRecord : {};
  const before = bySlot[operation.name];
  if (before !== undefined && (!record(before) || before.type !== undefined && before.type !== "region")) {
    throw new SpineError("ATTACHMENT_TYPE_CONFLICT", "An existing non-region attachment cannot be replaced by a region edit.");
  }
  const values = operation.values;
  if (!record(values)) throw new SpineError("INVALID_ATTACHMENT", "Region values must be an object.");
  for (const [field, value] of Object.entries(values)) {
    if (["x", "y", "rotation", "scaleX", "scaleY", "width", "height"].includes(field)) {
      finite(value, field);
      if (["width", "height"].includes(field) && Number(value) <= 0) throw new SpineError("INVALID_SETUP_VALUE", `${field} must be positive.`);
    } else if (field === "path" || field === "name") {
      if (typeof value !== "string" || !value || value.includes("\0")) throw new SpineError("INVALID_SETUP_VALUE", `Region ${field} must be a nonempty name or path.`);
    } else if (field === "color") color(value, field, 8);
    else throw new SpineError("INVALID_SETUP_FIELD", `Unsupported region attachment field: ${field}.`);
  }
  const after = { ...(record(before) ? before : {}), type: "region", ...values };
  if (typeof after.width !== "number" || after.width <= 0 || typeof after.height !== "number" || after.height <= 0) {
    throw new SpineError("MISSING_ATTACHMENT_SIZE", "A region attachment needs positive width and height.");
  }
  const updated = skins.map((skin) => structuredClone(skin));
  const skin = updated[index];
  if (!record(skin.attachments)) skin.attachments = {};
  const outputAttachments = skin.attachments as JsonRecord;
  if (!record(outputAttachments[operation.slot])) Object.defineProperty(outputAttachments, operation.slot,
    { value: {}, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(outputAttachments[operation.slot] as JsonRecord, operation.name,
    { value: after, writable: true, enumerable: true, configurable: true });
  const path: JsonPath = ["skins", index, "attachments", operation.slot, operation.name];
  return result(document, "skins", updated, path, before, after, operation.kind, operation.name);
}

export function upsertAnimationText(document: SpineDocument, operation: UpsertAnimationOperation) {
  name(operation.name, "Animation name");
  const animations = document.data.animations ?? {};
  if (!record(animations)) throw new SpineError("INVALID_ANIMATIONS", "Animations must be an object.");
  const before = animations[operation.name];
  if (before !== undefined && !record(before)) throw new SpineError("INVALID_ANIMATION", `Animation ${operation.name} is not an object.`);
  const after = before ?? {};
  const updated = structuredClone(animations);
  Object.defineProperty(updated, operation.name, { value: after, writable: true, enumerable: true, configurable: true });
  const path: JsonPath = ["animations", operation.name];
  return result(document, "animations", updated, path, before, after, operation.kind, operation.name);
}

export function upsertSkinText(document: SpineDocument, operation: UpsertSkinOperation) {
  name(operation.name, "Skin name");
  const skins = document.data.skins;
  if (!Array.isArray(skins) || !skins.every(record)) throw new SpineError("INVALID_SKINS", "Skeleton skins must be an array of objects.");
  const index = skins.findIndex((skin) => skin.name === operation.name);
  const before = index < 0 ? undefined : skins[index];
  const values = operation.values ?? {};
  if (operation.name === "default" && Object.values(values).some((entries) => Array.isArray(entries) && entries.length > 0)) {
    throw new SpineError("INVALID_DEFAULT_SKIN", "Only named skins may have skin bones or constraints.");
  }
  for (const [field, value] of Object.entries(values)) {
    if (!["bones", "ik", "transform", "path", "physics", "constraints"].includes(field) || !Array.isArray(value)
      || !value.every((item) => typeof item === "string" && item.trim()) || new Set(value).size !== value.length) {
      throw new SpineError("INVALID_SKIN_VALUE", `${field} must be an array of unique names.`);
    }
  }
  const after = { ...(before ?? {}), name: operation.name, ...values,
    ...(before === undefined ? { attachments: {} } : {}) };
  const updated = skins.map((skin) => structuredClone(skin));
  if (index < 0) updated.push(after);
  else updated[index] = after;
  const path: JsonPath = ["skins", index < 0 ? updated.length - 1 : index];
  return result(document, "skins", updated, path, before, after, operation.kind, operation.name);
}

export function removeSkinText(document: SpineDocument, operation: RemoveSkinOperation) {
  name(operation.name, "Skin name");
  if (operation.name === "default") throw new SpineError("INVALID_DEFAULT_SKIN", "The default skin cannot be removed.");
  const skins = document.data.skins;
  if (!Array.isArray(skins) || !skins.every(record)) throw new SpineError("INVALID_SKINS", "Skeleton skins must be an array of objects.");
  const index = skins.findIndex((skin) => skin.name === operation.name);
  if (index < 0) throw new SpineError("MISSING_SKIN", `Skin ${operation.name} does not exist.`);
  const before = skins[index];
  const defaultSkin = skins.find((skin) => skin.name === "default");
  const defaultAttachments = record(defaultSkin?.attachments) ? defaultSkin.attachments : {};
  const removedAttachments = record(before.attachments) ? before.attachments : {};
  const refs: string[] = [];
  const add = (path: JsonPath) => refs.push(timelinePath(path));
  const root = document.data;
  const animations = record(root.animations) ? root.animations : {};
  const timelines = Object.entries(animations).flatMap(([animationName, animation]) => collectTimelines(animationName, animation));
  for (const timeline of timelines) {
    if ((timeline.section === "attachments" || timeline.section === "deform") && timeline.path[3] === operation.name) {
      add(timeline.path);
    }
  }
  skins.forEach((skin, skinIndex) => {
    if (skinIndex === index || !record(skin.attachments)) return;
    for (const [slot, attachments] of Object.entries(skin.attachments)) {
      if (!record(attachments)) continue;
      for (const [attachmentName, attachment] of Object.entries(attachments)) {
        if (record(attachment) && attachment.type === "linkedmesh" && attachment.skin === operation.name) {
          add(["skins", skinIndex, "attachments", slot, attachmentName, "skin"]);
        }
      }
    }
  });
  for (const [slot, attachments] of Object.entries(removedAttachments)) {
    if (!record(attachments)) continue;
    const fallback = record(defaultAttachments[slot]) ? defaultAttachments[slot] as JsonRecord : {};
    for (const attachmentName of Object.keys(attachments)) {
      if (Object.hasOwn(fallback, attachmentName)) continue;
      if (Array.isArray(root.slots)) root.slots.forEach((item, slotIndex) => {
        if (record(item) && item.name === slot && item.attachment === attachmentName) add(["slots", slotIndex, "attachment"]);
      });
      for (const timeline of timelines) {
        if (timeline.section === "slots" && timeline.target === slot && timeline.type === "attachment") {
          timeline.keys.forEach((key, keyIndex) => {
            if (key.name === attachmentName) add([...timeline.path, keyIndex, "name"]);
          });
        }
      }
    }
    const removesPath = Object.values(attachments).some((attachment) => record(attachment) && attachment.type === "path");
    const hasDefaultPath = Object.values(fallback).some((attachment) => record(attachment) && attachment.type === "path");
    if (removesPath && !hasDefaultPath) {
      for (const section of ["path", "constraints"] as const) {
        const entries = Array.isArray(root[section]) ? root[section] as JsonRecord[] : [];
        entries.forEach((constraint, constraintIndex) => {
          if (section === "constraints" && constraint.type !== "path") return;
          const field = section === "constraints" ? "slot" : "target";
          if (constraint[field] === slot) add([section, constraintIndex, field]);
        });
      }
    }
  }
  if (refs.length > 0) {
    const references = [...new Set(refs)];
    throw new SpineError("SKIN_IN_USE", `Skin ${operation.name} is still referenced.`,
      { references: references.slice(0, 100), referenceCount: references.length });
  }
  const updated = skins.filter((_, skinIndex) => skinIndex !== index);
  const path: JsonPath = ["skins", index];
  const edits = modify(document.text, ["skins"], updated,
    { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } });
  return { text: applyEdits(document.text, edits),
    changes: [{ path: timelinePath(path), before, after: null } satisfies KeyChange],
    summary: { kind: "remove_skin", name: operation.name, action: "removed", path: timelinePath(path) } satisfies RigSummary };
}

export function upsertEventText(document: SpineDocument, operation: UpsertEventOperation) {
  name(operation.name, "Event name");
  const events = document.data.events ?? {};
  if (!record(events)) throw new SpineError("INVALID_EVENTS", "Event definitions must be an object.");
  const before = Object.hasOwn(events, operation.name) ? events[operation.name] : undefined;
  if (before !== undefined && !record(before)) throw new SpineError("INVALID_EVENT", `Event ${operation.name} is not an object.`);
  const values = operation.values ?? {};
  for (const [field, value] of Object.entries(values)) {
    if (field === "int") {
      if (!Number.isSafeInteger(value)) throw new SpineError("INVALID_EVENT_VALUE", "Event int must be a safe integer.");
    } else if (["float", "volume", "balance"].includes(field)) finite(value, field);
    else if (["string", "audio"].includes(field)) {
      if (typeof value !== "string" || value.includes("\0")) throw new SpineError("INVALID_EVENT_VALUE", `Event ${field} must be a string without NUL characters.`);
    } else throw new SpineError("INVALID_EVENT_VALUE", `Unsupported event definition field: ${field}.`);
  }
  const after = { ...(record(before) ? before : {}), ...values };
  const updated = structuredClone(events);
  Object.defineProperty(updated, operation.name, { value: after, writable: true, enumerable: true, configurable: true });
  const path: JsonPath = ["events", operation.name];
  return result(document, "events", updated, path, before, after, operation.kind, operation.name);
}

export function setSkeletonMetadataText(document: SpineDocument, operation: SetSkeletonMetadataOperation) {
  const before = document.data.skeleton;
  if (!record(before)) throw new SpineError("INVALID_SKELETON", "Skeleton metadata must be an object.");
  const values = operation.values;
  if (!record(values) || Object.keys(values).length === 0) {
    throw new SpineError("EMPTY_EDIT", "Provide at least one skeleton metadata value.");
  }
  for (const [field, value] of Object.entries(values)) {
    if (field === "fps") {
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 240) {
        throw new SpineError("INVALID_FPS", "Skeleton FPS must be an integer from 1 to 240.");
      }
    } else if (field === "audio" && value === null) {
      continue;
    } else if (field === "audio" || field === "images") {
      if (typeof value !== "string" || !value || value.includes("\0")) {
        throw new SpineError("INVALID_PATH", `${field} must be a nonempty path without NUL characters.`);
      }
    } else throw new SpineError("INVALID_METADATA_FIELD", `Unsupported skeleton metadata field: ${field}.`);
  }
  const after = { ...before, ...values };
  if (values.audio === null) delete after.audio;
  const path: JsonPath = ["skeleton"];
  return result(document, "skeleton", after, path, before, after, operation.kind, "skeleton");
}
