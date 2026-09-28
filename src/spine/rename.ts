import { applyEdits, modify } from "jsonc-parser";

import type { KeyChange } from "./bulk.js";
import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { timelinePath, type JsonPath } from "./timelines.js";

type JsonRecord = Record<string, unknown>;
type ConstraintType = "ik" | "transform" | "path" | "physics";
export interface RenameElementOperation {
  kind: "rename_element";
  elementType: "bone" | "slot" | "skin" | "event" | "animation" | "constraint" | "attachment";
  name: string;
  newName: string;
  constraintType?: ConstraintType;
  slot?: string;
}
export interface RenameSummary {
  kind: "rename_element";
  elementType: RenameElementOperation["elementType"];
  name: string;
  newName: string;
  action: "renamed" | "unchanged";
  referenceUpdates: number;
}

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}
function pointer(path: JsonPath): string { return timelinePath(path); }

export function renameElementText(document: SpineDocument, operation: RenameElementOperation) {
  const { elementType, name, newName, constraintType } = operation;
  if (!validName(name) || !validName(newName)) throw new SpineError("INVALID_NAME", "Old and new names must be nonempty and cannot contain NUL.");
  if (elementType === "constraint" && !["ik", "transform", "path", "physics"].includes(String(constraintType))) {
    throw new SpineError("INVALID_CONSTRAINT_TYPE", "A constraint rename needs constraintType.");
  }
  if (elementType === "attachment" && !validName(operation.slot)) {
    throw new SpineError("INVALID_SLOT", "An attachment rename needs slot.");
  }
  const data = structuredClone(document.data);
  let text = document.text;
  const changes: KeyChange[] = [];
  let referenceUpdates = 0;
  const get = (path: JsonPath): unknown => path.reduce<unknown>((value, part) =>
    record(value) || Array.isArray(value) ? (value as JsonRecord)[part] : undefined, data);
  const set = (path: JsonPath, after: unknown, reference = true) => {
    const before = get(path);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const parent = get(path.slice(0, -1));
    const last = path.at(-1)!;
    if (!record(parent) && !Array.isArray(parent)) throw new SpineError("INVALID_REFERENCE", `Cannot update ${pointer(path)}.`);
    if (after === undefined) delete (parent as JsonRecord)[last];
    else (parent as JsonRecord)[last] = after;
    text = applyEdits(text, modify(text, path, after, { formattingOptions }));
    changes.push({ path: pointer(path), before: before ?? null, after: after ?? null });
    if (reference) referenceUpdates += 1;
  };
  const move = (parentPath: JsonPath, oldKey: string, newKey: string, reference = true) => {
    const parent = get(parentPath);
    if (!record(parent) || !Object.hasOwn(parent, oldKey)) return;
    if (Object.hasOwn(parent, newKey)) {
      throw new SpineError("NAME_CONFLICT", `${newKey} already exists at ${pointer(parentPath)}.`);
    }
    const value = parent[oldKey];
    set([...parentPath, newKey], value, reference);
    set([...parentPath, oldKey], undefined, reference);
  };
  const scanAnimations = (action: (animation: JsonRecord, path: JsonPath) => void) => {
    if (!record(data.animations)) return;
    for (const [animationName, animation] of Object.entries(data.animations)) {
      if (record(animation)) action(animation, ["animations", animationName]);
    }
  };
  const scanSkins = (action: (skin: JsonRecord, path: JsonPath) => void) => {
    if (!Array.isArray(data.skins)) return;
    data.skins.forEach((skin, index) => { if (record(skin)) action(skin, ["skins", index]); });
  };
  const scanConstraints = (action: (constraint: JsonRecord, path: JsonPath, type: ConstraintType) => void) => {
    for (const section of ["constraints", "ik", "transform", "path", "physics"] as const) {
      const list = data[section];
      if (!Array.isArray(list)) continue;
      list.forEach((item, index) => {
        if (!record(item)) return;
        const type = section === "constraints" ? item.type : section;
        if (["ik", "transform", "path", "physics"].includes(String(type))) {
          action(item, [section, index], type as ConstraintType);
        }
      });
    }
  };
  const namedIndex = (list: unknown, key: string): number =>
    Array.isArray(list) ? list.findIndex((item) => record(item) && item.name === key) : -1;
  const checkExists = (exists: boolean) => {
    if (!exists) throw new SpineError("ELEMENT_NOT_FOUND", `${elementType} ${name} does not exist.`);
  };
  const checkConflict = (exists: boolean) => {
    if (exists) throw new SpineError("NAME_CONFLICT", `${elementType} ${newName} already exists.`);
  };

  if (elementType === "bone") {
    const index = namedIndex(data.bones, name);
    checkExists(index >= 0);
    checkConflict(namedIndex(data.bones, newName) >= 0 && newName !== name);
    if (name !== newName) {
      set(["bones", index, "name"], newName, false);
      (data.bones as JsonRecord[]).forEach((bone, i) => { if (bone.parent === name) set(["bones", i, "parent"], newName); });
      (Array.isArray(data.slots) ? data.slots : []).forEach((slot, i) => {
        if (record(slot) && slot.bone === name) set(["slots", i, "bone"], newName);
      });
      scanSkins((skin, path) => {
        if (!Array.isArray(skin.bones)) return;
        skin.bones.forEach((bone, i) => {
          if (bone === name) set([...path, "bones", i], newName);
          else if (record(bone) && bone.name === name) set([...path, "bones", i, "name"], newName);
        });
      });
      scanConstraints((constraint, path, type) => {
        if (Array.isArray(constraint.bones)) constraint.bones.forEach((bone, i) => {
          if (bone === name) set([...path, "bones", i], newName);
        });
        for (const field of ["bone", "source", ...(type === "path" ? [] : ["target"])]) {
          if (constraint[field] === name) set([...path, field], newName);
        }
      });
      scanAnimations((animation, path) => {
        if (record(animation.bones)) move([...path, "bones"], name, newName);
      });
    }
  } else if (elementType === "slot") {
    const index = namedIndex(data.slots, name);
    checkExists(index >= 0);
    checkConflict(namedIndex(data.slots, newName) >= 0 && newName !== name);
    if (name !== newName) {
      set(["slots", index, "name"], newName, false);
      scanSkins((skin, path) => {
        if (record(skin.attachments)) {
          move([...path, "attachments"], name, newName);
          for (const [slot, byName] of Object.entries(skin.attachments)) {
            if (!record(byName)) continue;
            for (const [attachmentName, attachment] of Object.entries(byName)) {
              if (record(attachment) && attachment.type === "clipping" && attachment.end === name) {
                set([...path, "attachments", slot, attachmentName, "end"], newName);
              }
            }
          }
        }
      });
      scanConstraints((constraint, path, type) => {
        if (type !== "path") return;
        for (const field of ["target", "slot"]) {
          if (constraint[field] === name) set([...path, field], newName);
        }
      });
      scanAnimations((animation, path) => {
        if (record(animation.slots)) move([...path, "slots"], name, newName);
        for (const section of ["deform", "attachments"] as const) {
          if (!record(animation[section])) continue;
          for (const [skinName, skinMap] of Object.entries(animation[section])) {
            if (record(skinMap)) move([...path, section, skinName], name, newName);
          }
        }
        for (const section of ["drawOrder", "draworder"] as const) {
          const keys = animation[section];
          if (!Array.isArray(keys)) continue;
          keys.forEach((key, keyIndex) => {
            if (!record(key) || !Array.isArray(key.offsets)) return;
            key.offsets.forEach((offset, offsetIndex) => {
              if (record(offset) && offset.slot === name) {
                set([...path, section, keyIndex, "offsets", offsetIndex, "slot"], newName);
              }
            });
          });
        }
      });
    }
  } else if (elementType === "skin") {
    const index = namedIndex(data.skins, name);
    checkExists(index >= 0);
    if (name === "default") throw new SpineError("DEFAULT_SKIN", "The default skin cannot be renamed.");
    checkConflict(namedIndex(data.skins, newName) >= 0 && newName !== name);
    if (name !== newName) {
      set(["skins", index, "name"], newName, false);
      scanSkins((skin, path) => {
        if (!record(skin.attachments)) return;
        for (const [slot, byName] of Object.entries(skin.attachments)) {
          if (!record(byName)) continue;
          for (const [attachmentName, attachment] of Object.entries(byName)) {
            if (record(attachment) && attachment.type === "linkedmesh" && attachment.skin === name) {
              set([...path, "attachments", slot, attachmentName, "skin"], newName);
            }
          }
        }
      });
      scanAnimations((animation, path) => {
        for (const section of ["deform", "attachments"] as const) {
          if (record(animation[section])) move([...path, section], name, newName);
        }
      });
    }
  } else if (elementType === "event") {
    checkExists(record(data.events) && Object.hasOwn(data.events, name));
    checkConflict(record(data.events) && Object.hasOwn(data.events, newName) && newName !== name);
    if (name !== newName) {
      move(["events"], name, newName, false);
      scanAnimations((animation, path) => {
        if (!Array.isArray(animation.events)) return;
        animation.events.forEach((event, index) => {
          if (record(event) && event.name === name) set([...path, "events", index, "name"], newName);
        });
      });
    }
  } else if (elementType === "animation") {
    checkExists(record(data.animations) && Object.hasOwn(data.animations, name));
    checkConflict(record(data.animations) && Object.hasOwn(data.animations, newName) && newName !== name);
    if (name !== newName) move(["animations"], name, newName, false);
  } else if (elementType === "attachment") {
    const slotName = operation.slot!;
    checkExists(namedIndex(data.slots, slotName) >= 0);
    let found = false;
    let conflict = false;
    scanSkins((skin) => {
      const byName = record(skin.attachments) ? skin.attachments[slotName] : undefined;
      if (record(byName)) {
        found ||= Object.hasOwn(byName, name);
        conflict ||= newName !== name && Object.hasOwn(byName, newName);
      }
    });
    checkExists(found);
    checkConflict(conflict);
    if (name !== newName) {
      const slotIndex = namedIndex(data.slots, slotName);
      if ((data.slots as JsonRecord[])[slotIndex].attachment === name) {
        set(["slots", slotIndex, "attachment"], newName);
      }
      scanSkins((skin, path) => {
        if (!record(skin.attachments)) return;
        for (const [slot, byName] of Object.entries(skin.attachments)) {
          if (!record(byName) || slot !== slotName) continue;
          for (const [attachmentName, attachment] of Object.entries(byName)) {
            if (!record(attachment) || attachment.type !== "linkedmesh") continue;
            for (const field of ["parent", "source"]) {
              if (attachment[field] === name) {
                set([...path, "attachments", slot, attachmentName, field], newName);
              }
            }
          }
          move([...path, "attachments", slot], name, newName);
        }
      });
      scanAnimations((animation, path) => {
        const slotTimelines = record(animation.slots) ? animation.slots[slotName] : undefined;
        if (record(slotTimelines) && Array.isArray(slotTimelines.attachment)) {
          slotTimelines.attachment.forEach((key, keyIndex) => {
            if (record(key) && key.name === name) {
              set([...path, "slots", slotName, "attachment", keyIndex, "name"], newName);
            }
          });
        }
        for (const section of ["deform", "attachments"] as const) {
          const skins = animation[section];
          if (!record(skins)) continue;
          for (const [skinName, slots] of Object.entries(skins)) {
            const attachments = record(slots) ? slots[slotName] : undefined;
            if (record(attachments)) move([...path, section, skinName, slotName], name, newName);
          }
        }
      });
    }
  } else {
    const type = constraintType!;
    const defs: { path: JsonPath; type: ConstraintType }[] = [];
    let conflict = false;
    scanConstraints((constraint, path, actualType) => {
      if (constraint.name === name && actualType === type) defs.push({ path, type: actualType });
      if (constraint.name === newName && newName !== name) conflict = true;
    });
    checkExists(defs.length === 1);
    checkConflict(conflict);
    if (name !== newName) {
      set([...defs[0].path, "name"], newName, false);
      scanSkins((skin, path) => {
        for (const section of [type, "constraints"] as const) {
          const memberships = skin[section];
          if (!Array.isArray(memberships)) continue;
          memberships.forEach((item, index) => {
            if (item === name) set([...path, section, index], newName);
            else if (record(item) && item.name === name && (item.type === undefined || item.type === type)) {
              set([...path, section, index, "name"], newName);
            }
          });
        }
      });
      scanAnimations((animation, path) => {
        if (record(animation[type])) move([...path, type], name, newName);
      });
    }
  }

  return { text, changes, summary: { kind: "rename_element", elementType, name, newName,
    action: name === newName ? "unchanged" : "renamed", referenceUpdates } satisfies RenameSummary };
}
