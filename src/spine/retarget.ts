import { applyEdits, modify } from "jsonc-parser";

import type { KeyChange } from "./bulk.js";
import { requireEditableVersion, type SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { collectTimelines, timelinePath, type Timeline } from "./timelines.js";
import { validateDocument } from "./validate.js";

type JsonRecord = Record<string, unknown>;

export interface RetargetMaps {
  bones?: Record<string, string>;
  slots?: Record<string, string>;
  skins?: Record<string, string>;
  attachments?: Record<string, Record<string, string>>;
  events?: Record<string, string>;
  constraints?: Record<string, Record<string, string>>;
}

export interface RetargetAnimationOperation {
  kind: "retarget_animation";
  sourcePath: string;
  sourceHash: string;
  sourceAnimation: string;
  newAnimation: string;
  maps?: RetargetMaps;
}

export interface RetargetIssue {
  kind: string;
  source: string;
  target: string;
  path: string;
  reason: string;
}

export interface RetargetSummary {
  kind: "retarget_animation";
  sourcePath: string;
  sourceHash: string;
  sourceVersion: string;
  sourceAnimation: string;
  newAnimation: string;
  timelines: number;
  keys: number;
  mapped: Record<string, number>;
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(record) : [];
}

function names(value: unknown): Set<string> {
  return new Set(records(value).flatMap((item) => typeof item.name === "string" ? [item.name] : []));
}

function mapped(map: Record<string, string> | undefined, source: string): string {
  return map && Object.hasOwn(map, source) ? map[source] : source;
}

function attachmentName(maps: RetargetMaps, sourceSlot: string, sourceName: string): string {
  return mapped(maps.attachments?.[sourceSlot], sourceName);
}

function attachment(document: SpineDocument, skin: string, slot: string, name: string): JsonRecord | undefined {
  for (const item of records(document.data.skins)) {
    if (item.name !== skin) continue;
    const found = (item.attachments as JsonRecord | undefined)?.[slot];
    const value = record(found) ? found[name] : undefined;
    return record(value) ? value : undefined;
  }
  return undefined;
}

function attachmentInAnySkin(document: SpineDocument, slot: string, name: string): boolean {
  return records(document.data.skins).some((skin) => typeof skin.name === "string"
    && attachment(document, skin.name, slot, name) !== undefined);
}

function constraintNames(document: SpineDocument, type: string): Set<string> {
  return new Set([
    ...records(document.data.constraints).filter((item) => item.type === type),
    ...records(document.data[type]),
  ].flatMap((item) => typeof item.name === "string" ? [item.name] : []));
}

function eventDefaults(value: unknown): string {
  const definition = record(value) ? value : {};
  const defaults: JsonRecord = { int: 0, float: 0, string: null, audio: null, volume: 1, balance: 0 };
  const normalized = Object.fromEntries(Object.entries(defaults).map(([field, fallback]) =>
    [field, definition[field] ?? fallback]));
  const extras = Object.fromEntries(Object.entries(definition)
    .filter(([field]) => !Object.hasOwn(defaults, field)).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify({ normalized, extras });
}

function compatibleDeform(sourceAttachment: JsonRecord, targetAttachment: JsonRecord,
  source: SpineDocument, target: SpineDocument, maps: RetargetMaps): boolean {
  if ((sourceAttachment.type ?? "region") !== "mesh" || (targetAttachment.type ?? "region") !== "mesh") return false;
  if (!Array.isArray(sourceAttachment.uvs) || !Array.isArray(sourceAttachment.vertices)
    || !Array.isArray(targetAttachment.uvs) || !Array.isArray(targetAttachment.vertices)) return false;
  if (!["uvs", "vertices", "triangles", "hull"].every((field) =>
    JSON.stringify(sourceAttachment[field] ?? null) === JSON.stringify(targetAttachment[field] ?? null))) return false;
  const weighted = sourceAttachment.vertices.length !== sourceAttachment.uvs.length;
  if (!weighted) return true;
  const sourceBones = records(source.data.bones).map((bone) => mapped(maps.bones, String(bone.name)));
  const targetBones = records(target.data.bones).map((bone) => String(bone.name));
  return JSON.stringify(sourceBones) === JSON.stringify(targetBones);
}

function setTimeline(animation: JsonRecord, path: string[], keys: JsonRecord[]): void {
  let current = animation;
  for (const part of path.slice(0, -1)) {
    if (!Object.hasOwn(current, part)) Object.defineProperty(current, part,
      { value: Object.create(null), enumerable: true, writable: true, configurable: true });
    current = current[part] as JsonRecord;
  }
  const leaf = path.at(-1)!;
  if (Object.hasOwn(current, leaf)) {
    throw new SpineError("RETARGET_COLLISION", `Multiple source timelines map to ${timelinePath(["animations", "<target>", ...path])}.`);
  }
  Object.defineProperty(current, leaf, { value: keys, enumerable: true, writable: true, configurable: true });
}

export function retargetAnimationText(target: SpineDocument, source: SpineDocument,
  operation: RetargetAnimationOperation): { text: string; changes: KeyChange[]; summary: RetargetSummary } {
  requireEditableVersion(source);
  requireEditableVersion(target);
  const sourceErrors = validateDocument(source).filter((item) => item.severity === "error");
  if (sourceErrors.length > 0) throw new SpineError("VALIDATION_FAILED", "Source skeleton has validation errors.", { diagnostics: sourceErrors });
  if (source.hash !== operation.sourceHash) {
    throw new SpineError("SOURCE_CHANGED", "Source animation JSON changed before transfer was staged.",
      { expectedHash: operation.sourceHash, actualHash: source.hash });
  }
  if (source.version.match(/^\d+\.\d+/)?.[0] !== target.version.match(/^\d+\.\d+/)?.[0]) {
    throw new SpineError("VERSION_MISMATCH", "Animation transfer requires matching Spine major and minor versions.");
  }
  if (!operation.sourceAnimation?.trim() || !operation.newAnimation?.trim()) {
    throw new SpineError("INVALID_NAME", "Source and destination animation names must be nonempty.");
  }
  const sourceAnimations = record(source.data.animations) ? source.data.animations : {};
  const targetAnimations = record(target.data.animations) ? target.data.animations : {};
  if (!Object.hasOwn(sourceAnimations, operation.sourceAnimation)) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${operation.sourceAnimation} was not found in the source.`);
  }
  if (Object.hasOwn(targetAnimations, operation.newAnimation)) {
    throw new SpineError("ANIMATION_EXISTS", `Animation ${operation.newAnimation} already exists in the target.`);
  }
  const maps = operation.maps ?? {};
  const sourceBones = names(source.data.bones);
  const sourceSlots = names(source.data.slots);
  const sourceSkins = names(source.data.skins);
  const sourceEvents = record(source.data.events) ? source.data.events : {};
  const targetBones = names(target.data.bones);
  const targetSlots = names(target.data.slots);
  const targetSkins = names(target.data.skins);
  const targetEvents = new Set(Object.keys(record(target.data.events) ? target.data.events : {}));
  const issues: RetargetIssue[] = [];
  const used = new Map<string, Set<string>>();
  function verifyMap(kind: string, entries: Record<string, string> | undefined,
    available: Set<string>, path: string[]): void {
    for (const [oldName, newName] of Object.entries(entries ?? {})) {
      if (!available.has(oldName)) issues.push({ kind, source: oldName, target: newName,
        path: timelinePath([...path, oldName]), reason: "Mapping source element was not found." });
    }
  }
  verifyMap("bone", maps.bones, sourceBones, ["maps", "bones"]);
  verifyMap("slot", maps.slots, sourceSlots, ["maps", "slots"]);
  verifyMap("skin", maps.skins, sourceSkins, ["maps", "skins"]);
  verifyMap("event", maps.events, new Set(Object.keys(sourceEvents)), ["maps", "events"]);
  for (const [sourceSlot, entries] of Object.entries(maps.attachments ?? {})) {
    if (!sourceSlots.has(sourceSlot)) {
      issues.push({ kind: "attachment", source: sourceSlot, target: "", path: timelinePath(["maps", "attachments", sourceSlot]),
        reason: "Mapping source slot was not found." });
      continue;
    }
    for (const [oldName, newName] of Object.entries(entries)) {
      if (!attachmentInAnySkin(source, sourceSlot, oldName)) issues.push({ kind: "attachment",
        source: `${sourceSlot}/${oldName}`, target: newName,
        path: timelinePath(["maps", "attachments", sourceSlot, oldName]), reason: "Mapping source attachment was not found." });
    }
  }
  for (const [section, entries] of Object.entries(maps.constraints ?? {})) {
    verifyMap("constraint", entries, constraintNames(source, section), ["maps", "constraints", section]);
  }
  function check(kind: string, sourceName: string, targetName: string, path: string, exists: boolean): string {
    const group = used.get(kind) ?? new Set<string>();
    group.add(`${sourceName}\0${targetName}`);
    used.set(kind, group);
    if (!targetName || !exists) issues.push({ kind, source: sourceName, target: targetName, path,
      reason: targetName ? "Target element was not found." : "Mapped target name is empty." });
    return targetName;
  }
  const clip: JsonRecord = Object.create(null);
  const timelines = collectTimelines(operation.sourceAnimation, sourceAnimations[operation.sourceAnimation]);
  let keys = 0;
  for (const timeline of timelines) {
    const section = timeline.section;
    const path = timelinePath(timeline.path);
    const output = structuredClone(timeline.keys);
    let suffix: string[];
    if (section === "bones") {
      const name = mapped(maps.bones, timeline.target);
      check("bone", timeline.target, name, path, targetBones.has(name));
      suffix = [section, name, timeline.type];
    } else if (section === "slots") {
      const slot = mapped(maps.slots, timeline.target);
      check("slot", timeline.target, slot, path, targetSlots.has(slot));
      suffix = [section, slot, timeline.type];
      if (timeline.type === "attachment") for (const [index, key] of output.entries()) {
        if (typeof key.name !== "string") continue;
        const name = attachmentName(maps, timeline.target, key.name);
        check("attachment", `${timeline.target}/${key.name}`, `${slot}/${name}`,
          timelinePath([...timeline.path, index, "name"]), targetSlots.has(slot) && attachmentInAnySkin(target, slot, name));
        key.name = name;
      }
    } else if (["ik", "transform", "path", "physics", "slider"].includes(section)) {
      const name = mapped(maps.constraints?.[section], timeline.target);
      check("constraint", `${section}/${timeline.target}`, `${section}/${name}`, path, constraintNames(target, section).has(name));
      suffix = [section, name, ...(section === "ik" || section === "transform" ? [] : [timeline.type])];
    } else if (section === "attachments" || section === "deform") {
      const sourceSkin = String(timeline.path[3]);
      const sourceSlot = String(timeline.path[4]);
      const sourceAttachment = String(timeline.path[5]);
      const skin = mapped(maps.skins, sourceSkin);
      const slot = mapped(maps.slots, sourceSlot);
      const name = attachmentName(maps, sourceSlot, sourceAttachment);
      check("skin", sourceSkin, skin, path, targetSkins.has(skin));
      check("slot", sourceSlot, slot, path, targetSlots.has(slot));
      const targetAttachment = attachment(target, skin, slot, name);
      check("attachment", `${sourceSkin}/${sourceSlot}/${sourceAttachment}`, `${skin}/${slot}/${name}`,
        path, targetAttachment !== undefined);
      const sourceAttachmentData = attachment(source, sourceSkin, sourceSlot, sourceAttachment);
      if (targetAttachment && sourceAttachmentData && (section === "deform" || timeline.type === "deform")
        && !compatibleDeform(sourceAttachmentData, targetAttachment, source, target, maps)) {
        issues.push({ kind: "deform", source: `${sourceSkin}/${sourceSlot}/${sourceAttachment}`,
          target: `${skin}/${slot}/${name}`, path, reason: "Mesh geometry or weighted bone order differs; deform keys cannot be transferred safely." });
      }
      if (targetAttachment && sourceAttachmentData && timeline.type === "sequence"
        && JSON.stringify(sourceAttachmentData.sequence ?? null) !== JSON.stringify(targetAttachment.sequence ?? null)) {
        issues.push({ kind: "sequence", source: `${sourceSkin}/${sourceSlot}/${sourceAttachment}`,
          target: `${skin}/${slot}/${name}`, path, reason: "Attachment sequence definitions differ." });
      }
      suffix = section === "deform" ? [section, skin, slot, name] : [section, skin, slot, name, timeline.type];
    } else if (section === "events") {
      suffix = [section];
      for (const [index, key] of output.entries()) {
        const oldName = String(key.name);
        const name = mapped(maps.events, oldName);
        check("event", oldName, name, timelinePath([...timeline.path, index, "name"]), targetEvents.has(name));
        const targetDefinitions = record(target.data.events) ? target.data.events : {};
        if (targetEvents.has(name) && eventDefaults(sourceEvents[oldName]) !== eventDefaults(targetDefinitions[name])) {
          issues.push({ kind: "event", source: oldName, target: name,
            path: timelinePath([...timeline.path, index, "name"]),
            reason: "Source and target event defaults differ; omitted event payload fields would change meaning." });
        }
        key.name = name;
      }
    } else if (section === "drawOrder" || section === "draworder") {
      suffix = [section];
      const sourceSlots = records(source.data.slots).map((item) => String(item.name));
      const mappedOrder = sourceSlots.map((name) => mapped(maps.slots, name));
      const targetOrder = records(target.data.slots).map((item) => String(item.name));
      if (JSON.stringify(mappedOrder) !== JSON.stringify(targetOrder)) {
        issues.push({ kind: "drawOrder", source: sourceSlots.join(","), target: targetOrder.join(","), path,
          reason: "Draw-order offsets require the mapped source and target setup slot orders to match exactly." });
      }
      for (const [index, key] of output.entries()) {
        if (!Array.isArray(key.offsets)) continue;
        for (const [offsetIndex, value] of key.offsets.entries()) {
          if (!record(value) || typeof value.slot !== "string") continue;
          const name = mapped(maps.slots, value.slot);
          check("slot", value.slot, name, timelinePath([...timeline.path, index, "offsets", offsetIndex, "slot"]),
            targetSlots.has(name));
          value.slot = name;
        }
      }
    } else {
      throw new SpineError("UNSUPPORTED_TIMELINE", `Cannot retarget timeline ${path}.`);
    }
    setTimeline(clip, suffix, output);
    keys += output.length;
  }
  if (issues.length > 0) {
    throw new SpineError("UNMAPPED_REFERENCES", "Animation transfer has unmapped or incompatible references.",
      { issueCount: issues.length, issues: issues.slice(0, 100), issuesTruncated: issues.length > 100 });
  }
  const edits = modify(target.text, ["animations", operation.newAnimation], clip,
    { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } });
  return { text: applyEdits(target.text, edits),
    changes: [{ path: timelinePath(["animations", operation.newAnimation]), before: null, after: clip }],
    summary: { kind: "retarget_animation", sourcePath: source.path, sourceHash: source.hash,
      sourceVersion: source.version, sourceAnimation: operation.sourceAnimation, newAnimation: operation.newAnimation,
      timelines: timelines.length, keys,
      mapped: Object.fromEntries([...used].map(([kind, references]) => [kind, references.size])) } };
}
