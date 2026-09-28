import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { collectTimelines, keyTime, timelinePath } from "./timelines.js";

type JsonRecord = Record<string, unknown>;
type ElementType = "bone" | "slot" | "skin" | "attachment" | "constraint" | "event" | "animation";

export interface ProjectEntry {
  kind: ElementType | "timeline" | "asset";
  name: string;
  path: string;
  detail?: string;
}

export interface Reference {
  path: string;
  relation: string;
}

function object(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => object(item) !== undefined) : [];
}

function ptr(...parts: (string | number)[]): string {
  return `/${parts.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

export function projectEntries(document: SpineDocument): ProjectEntry[] {
  const entries: ProjectEntry[] = [];
  const root = document.data;
  for (const [index, bone] of records(root.bones).entries()) {
    if (typeof bone.name === "string") entries.push({ kind: "bone", name: bone.name, path: ptr("bones", index) });
  }
  for (const [index, slot] of records(root.slots).entries()) {
    if (typeof slot.name === "string") entries.push({ kind: "slot", name: slot.name, path: ptr("slots", index) });
  }
  for (const { constraint, path, type } of constraintEntries(root)) {
    if (typeof constraint.name === "string") entries.push({ kind: "constraint", name: constraint.name, path, detail: type });
  }
  for (const [skinIndex, skin] of records(root.skins).entries()) {
    if (typeof skin.name === "string") entries.push({ kind: "skin", name: skin.name, path: ptr("skins", skinIndex) });
    for (const [slot, byName] of Object.entries(object(skin.attachments) ?? {})) {
      for (const [name, attachmentValue] of Object.entries(object(byName) ?? {})) {
        const path = ptr("skins", skinIndex, "attachments", slot, name);
        const attachment = object(attachmentValue) ?? {};
        entries.push({ kind: "attachment", name, path, detail: `${String(skin.name ?? "")}/${slot} (${String(attachment.type ?? "region")})` });
        if (attachment.type === undefined || attachment.type === "region" || attachment.type === "mesh" || (attachment.type === "linkedmesh" && typeof attachment.path === "string")) {
          entries.push({ kind: "asset", name: String(attachment.path ?? name), path, detail: `${String(skin.name ?? "")}/${slot}` });
        }
      }
    }
  }
  for (const name of Object.keys(object(root.events) ?? {})) entries.push({ kind: "event", name, path: ptr("events", name) });
  for (const [name, animation] of Object.entries(object(root.animations) ?? {})) {
    entries.push({ kind: "animation", name, path: ptr("animations", name) });
    try {
      for (const timeline of collectTimelines(name, animation)) {
        entries.push({ kind: "timeline", name: `${name}/${timeline.section}/${timeline.target}/${timeline.type}`, path: timelinePath(timeline.path), detail: `${timeline.keys.length} keys` });
      }
    } catch {
      // Inspection is available for unfamiliar exports; editing still rejects them.
    }
  }
  return entries;
}

function constraintEntries(root: JsonRecord): { constraint: JsonRecord; path: string; type: string }[] {
  return [
    ...records(root.constraints).map((constraint, index) => ({ constraint, path: ptr("constraints", index), type: String(constraint.type ?? "") })),
    ...["ik", "transform", "path", "physics"].flatMap((type) => records(root[type]).map((constraint, index) => ({ constraint, path: ptr(type, index), type }))),
  ];
}

export function inspectProject(document: SpineDocument, maxItems = 25) {
  const entries = projectEntries(document);
  const kinds = ["bone", "slot", "skin", "attachment", "constraint", "event", "animation", "timeline", "asset"] as const;
  const inventory: Record<string, { count: number; names: string[]; truncated: boolean }> = {};
  for (const kind of kinds) {
    const names = entries.filter((entry) => entry.kind === kind).map((entry) => entry.name);
    inventory[kind] = { count: names.length, names: names.slice(0, maxItems), truncated: names.length > maxItems };
  }
  return {
    path: document.path,
    version: document.version,
    sourceHash: document.hash,
    inventory,
    timelineTypes: [...new Set(entries.filter((entry) => entry.kind === "timeline").map((entry) => entry.name.split("/").at(-1)))].sort(),
  };
}

export function searchProject(document: SpineDocument, query: string, kind?: ProjectEntry["kind"], limit = 50) {
  const term = query.toLocaleLowerCase();
  const matches = projectEntries(document).filter((entry) =>
    (!kind || entry.kind === kind) && `${entry.name} ${entry.detail ?? ""}`.toLocaleLowerCase().includes(term),
  );
  return { total: matches.length, matches: matches.slice(0, limit), truncated: matches.length > limit };
}

function compactKey(key: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(key).map(([field, value]) => {
    if (Array.isArray(value) && value.length > 16) {
      return [field, { length: value.length, sample: value.slice(0, 8) }];
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return [field, { fields: Object.keys(value) }];
    }
    return [field, value];
  }));
}

export function inspectAnimation(document: SpineDocument, name: string, from?: number, to?: number, maxKeys = 50, targetFilter?: string, maxTimelines = 100) {
  const animation = object(document.data.animations)?.[name];
  if (!animation) throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${name} was not found.`);
  const timelines = collectTimelines(name, animation);
  let duration = 0;
  let totalKeys = 0;
  for (const timeline of timelines) {
    timeline.keys.forEach((key, index) => {
      duration = Math.max(duration, keyTime(key, [...timeline.path, index]));
      totalKeys += 1;
    });
  }
  const matching = timelines.filter((timeline) => !targetFilter || timeline.target.toLocaleLowerCase().includes(targetFilter.toLocaleLowerCase()));
  const visible = matching.slice(0, maxTimelines);
  let remaining = maxKeys;
  let omittedKeys = 0;
  const summaries = visible.map((timeline) => {
    const selected: { time: number; value: JsonRecord }[] = [];
    let countInRange = 0;
    timeline.keys.forEach((key, index) => {
      const time = keyTime(key, [...timeline.path, index]);
      if ((from === undefined || time >= from) && (to === undefined || time <= to)) {
        countInRange += 1;
        if (remaining > 0) {
          selected.push({ time, value: compactKey(key) });
          remaining -= 1;
        } else {
          omittedKeys += 1;
        }
      }
    });
    return {
      section: timeline.section,
      target: timeline.target,
      type: timeline.type,
      keyCount: timeline.keys.length,
      keysInRange: countInRange,
      keys: selected,
    };
  });
  return {
    name, duration, timelineCount: timelines.length, matchingTimelineCount: matching.length, keyCount: totalKeys,
    from: from ?? 0, to: to ?? duration, timelines: summaries,
    timelinesTruncated: matching.length > maxTimelines, keysTruncated: omittedKeys > 0,
  };
}

export function referenceGraph(document: SpineDocument, kind: ElementType, name: string): { kind: ElementType; name: string; references: Reference[]; coverage: string } {
  const refs: Reference[] = [];
  const add = (path: string, relation: string) => refs.push({ path, relation });
  const root = document.data;
  const bones = records(root.bones);
  const slots = records(root.slots);
  const skins = records(root.skins);
  const constraints = constraintEntries(root);
  const animations = object(root.animations) ?? {};

  if (kind === "bone") {
    bones.forEach((bone, index) => { if (bone.parent === name) add(ptr("bones", index, "parent"), "child parent"); });
    slots.forEach((slot, index) => { if (slot.bone === name) add(ptr("slots", index, "bone"), "slot bone"); });
    const boneIndex = bones.findIndex((bone) => bone.name === name);
    skins.forEach((skin, skinIndex) => {
      if (Array.isArray(skin.bones)) skin.bones.forEach((bone, i) => { if (bone === name || object(bone)?.name === name) add(ptr("skins", skinIndex, "bones", i), "skin bone"); });
      for (const [slot, byName] of Object.entries(object(skin.attachments) ?? {})) {
        for (const [attachmentName, value] of Object.entries(object(byName) ?? {})) {
          const attachment = object(value);
          const uvs = attachment?.uvs;
          const vertices = attachment?.vertices;
          const count = attachment?.type === "mesh" && Array.isArray(uvs) ? uvs.length / 2
            : ["boundingbox", "path", "clipping"].includes(String(attachment?.type)) ? Number(attachment?.vertexCount) : 0;
          if (boneIndex < 0 || !Number.isSafeInteger(count) || count < 1 || !Array.isArray(vertices)
            || vertices.length === count * 2) continue;
          let cursor = 0;
          for (let vertex = 0; vertex < count && cursor < vertices.length; vertex += 1) {
            const weightCount = vertices[cursor++];
            if (typeof weightCount !== "number" || !Number.isInteger(weightCount) || weightCount < 1) break;
            for (let i = 0; i < weightCount && cursor + 3 < vertices.length; i += 1) {
              if (vertices[cursor] === boneIndex) add(ptr("skins", skinIndex, "attachments", slot, attachmentName, "vertices", cursor), "attachment weight");
              cursor += 4;
            }
          }
        }
      }
    });
  }
  if (kind === "slot") {
    skins.forEach((skin, index) => { if (Object.hasOwn(object(skin.attachments) ?? {}, name)) add(ptr("skins", index, "attachments", name), "skin attachments"); });
    skins.forEach((skin, skinIndex) => {
      for (const [slot, byName] of Object.entries(object(skin.attachments) ?? {})) {
        for (const [attachmentName, value] of Object.entries(object(byName) ?? {})) {
          if (object(value)?.end === name) add(ptr("skins", skinIndex, "attachments", slot, attachmentName, "end"), "clipping end slot");
        }
      }
    });
  }
  if (kind === "attachment") {
    slots.forEach((slot, index) => { if (slot.attachment === name) add(ptr("slots", index, "attachment"), "setup attachment"); });
    skins.forEach((skin, skinIndex) => {
      for (const [slot, byName] of Object.entries(object(skin.attachments) ?? {})) {
        for (const [attachmentName, value] of Object.entries(object(byName) ?? {})) {
          const reference = /^4\.3(?:\.|$)/.test(document.version) ? "source" : "parent";
          if (object(value)?.type === "linkedmesh" && object(value)?.[reference] === name) {
            add(ptr("skins", skinIndex, "attachments", slot, attachmentName, reference), "linked mesh source");
          }
        }
      }
    });
  }
  if (kind === "skin") {
    skins.forEach((skin, skinIndex) => {
      for (const [slot, byName] of Object.entries(object(skin.attachments) ?? {})) {
        for (const [attachmentName, value] of Object.entries(object(byName) ?? {})) {
          if (object(value)?.type === "linkedmesh" && object(value)?.skin === name) {
            add(ptr("skins", skinIndex, "attachments", slot, attachmentName, "skin"), "linked mesh source skin");
          }
        }
      }
    });
  }
  if (kind === "constraint") {
    skins.forEach((skin, skinIndex) => {
      for (const type of ["constraints", "ik", "transform", "path", "physics"]) {
        const values = skin[type];
        if (Array.isArray(values)) values.forEach((constraint, index) => {
          if (constraint === name || object(constraint)?.name === name) add(ptr("skins", skinIndex, type, index), "skin constraint");
        });
      }
    });
  }
  constraints.forEach(({ constraint, path, type }) => {
    if (kind === "bone" || kind === "slot") {
      const targetKind = type === "path" ? "slot" : "bone";
      if (kind === targetKind && constraint.target === name) add(`${path}/target`, "constraint target");
      if (kind === "slot" && type === "path" && constraint.slot === name) add(`${path}/slot`, "constraint target slot");
      if (kind === "bone" && constraint.source === name) add(`${path}/source`, "constraint source");
      if (kind === "bone" && constraint.bone === name) add(`${path}/bone`, "constraint bone");
      if (kind === "bone" && Array.isArray(constraint.bones)) constraint.bones.forEach((bone, i) => { if (bone === name) add(`${path}/bones/${i}`, "constraint bone"); });
    }
  });
  for (const [animationName, animation] of Object.entries(animations)) {
    let timelines;
    try { timelines = collectTimelines(animationName, animation); } catch { continue; }
    for (const timeline of timelines) {
      const base = timelinePath(timeline.path);
      if (kind === "bone" && timeline.section === "bones" && timeline.target === name) add(base, "bone timeline");
      if (kind === "slot" && timeline.section === "slots" && timeline.target === name) add(base, "slot timeline");
      if (kind === "constraint" && ["ik", "transform", "path", "physics"].includes(timeline.section) && timeline.target === name) add(base, "constraint timeline");
      if ((kind === "skin" || kind === "slot" || kind === "attachment") && ["attachments", "deform"].includes(timeline.section)) {
        const parts = timeline.path;
        if ((kind === "skin" && parts[3] === name) || (kind === "slot" && parts[4] === name) || (kind === "attachment" && parts[5] === name)) add(base, "attachment timeline");
      }
      timeline.keys.forEach((key, index) => {
        if (kind === "event" && timeline.section === "events" && key.name === name) add(ptr(...timeline.path, index, "name"), "event key");
        if (kind === "attachment" && timeline.section === "slots" && timeline.type === "attachment" && key.name === name) add(ptr(...timeline.path, index, "name"), "attachment key");
        if (kind === "slot" && ["drawOrder", "draworder"].includes(timeline.section) && Array.isArray(key.offsets)) {
          key.offsets.forEach((offset, i) => { if (object(offset)?.slot === name) add(ptr(...timeline.path, index, "offsets", i, "slot"), "draw order key"); });
        }
      });
    }
  }
  return { kind, name, references: refs, coverage: "Known Spine 4.2 and 4.3 JSON reference fields" };
}
