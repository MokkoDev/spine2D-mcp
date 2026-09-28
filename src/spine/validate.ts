import { existsSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";

import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { collectTimelines, curveChannelCount, keyTime, timelinePath } from "./timelines.js";

export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
  suggestion?: string;
}

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => object(item) !== undefined) : [];
}

function pointer(...parts: (string | number)[]): string {
  return `/${parts.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function finiteNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

export function validateDocument(document: SpineDocument, checkAssets = false): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const add = (code: string, path: string, message: string, suggestion?: string, severity: "error" | "warning" = "error") =>
    diagnostics.push({ code, severity, path, message, ...(suggestion ? { suggestion } : {}) });
  const root = document.data;
  const bones = records(root.bones);
  const slots = records(root.slots);
  const skins = records(root.skins);
  const constraints = [
    ...records(root.constraints).map((constraint, index) => ({ constraint, path: pointer("constraints", index), type: String(constraint.type ?? "") })),
    ...["ik", "transform", "path", "physics"].flatMap((type) => records(root[type]).map((constraint, index) => ({ constraint, path: pointer(type, index), type }))),
  ];
  const animations = object(root.animations) ?? {};
  const eventDefs = object(root.events) ?? {};
  const imageAssets: { slot: string; name: string; path: string }[] = [];
  const attachmentLookup = new Map<string, JsonRecord>();
  const linkedMeshes: { path: string; skin: string; slot: string; parent: unknown; sourceSkin: unknown; refField: string }[] = [];

  if (!/^4\.(?:2|3)(?:\.|$)/.test(document.version)) {
    add("UNSUPPORTED_VERSION", "/skeleton/spine", `Spine ${document.version} has not been tested for edits.`, "Use a tested 4.2 or 4.3 export or inspect without editing.");
  }
  if (!Array.isArray(root.bones) || bones.length !== root.bones.length || bones.length === 0) {
    add("INVALID_BONES", "/bones", "Expected a nonempty array of bone objects.");
  }
  for (const [field, value] of [["slots", root.slots], ["skins", root.skins], ["constraints", root.constraints], ["ik", root.ik], ["transform", root.transform], ["path", root.path], ["physics", root.physics]] as const) {
    if (value !== undefined && (!Array.isArray(value) || records(value).length !== value.length)) {
      add("INVALID_SECTION", `/${field}`, `${field} must be an array of objects.`);
    }
  }
  for (const [field, value] of [["animations", root.animations], ["events", root.events]] as const) {
    if (value !== undefined && !object(value)) add("INVALID_SECTION", `/${field}`, `${field} must be an object.`);
  }

  const boneIndex = new Map<string, number>();
  bones.forEach((bone, index) => {
    const path = pointer("bones", index);
    if (typeof bone.name !== "string" || bone.name.length === 0) {
      add("INVALID_NAME", `${path}/name`, "Bone name must be a nonempty string.");
      return;
    }
    if (boneIndex.has(bone.name)) {
      add("DUPLICATE_BONE", `${path}/name`, `Duplicate bone ${bone.name}.`);
    } else {
      boneIndex.set(bone.name, index);
    }
  });
  const parents = new Map(bones.filter((bone) => typeof bone.name === "string").map((bone) => [bone.name as string, bone.parent]));
  for (const [name] of parents) {
    const seen = new Set<string>();
    let current: unknown = name;
    while (typeof current === "string" && parents.has(current)) {
      if (seen.has(current)) {
        add("BONE_CYCLE", pointer("bones", boneIndex.get(name) ?? 0), `Bone ${name} is in a parent cycle.`, "Remove a parent link to make a rooted tree.");
        break;
      }
      seen.add(current);
      current = parents.get(current);
    }
  }
  bones.forEach((bone, index) => {
    if (index === 0 && bone.parent !== undefined) {
      add("ROOT_HAS_PARENT", pointer("bones", index, "parent"), "The first bone must be the root bone.");
    }
    if (index > 0 && typeof bone.parent !== "string") {
      add("MISSING_PARENT", pointer("bones", index, "parent"), "A nonroot bone needs a parent.");
    }
    if (typeof bone.parent === "string") {
      const parentIndex = boneIndex.get(bone.parent);
      if (parentIndex === undefined) {
        add("MISSING_BONE", pointer("bones", index, "parent"), `Parent bone ${bone.parent} does not exist.`);
      } else if (parentIndex >= index) {
        add("BONE_ORDER", pointer("bones", index, "parent"), "Parent bone must appear before its child.", "Reorder bones in parent-first order.");
      }
    }
  });

  const slotNames = new Set<string>();
  slots.forEach((slot, index) => {
    const path = pointer("slots", index);
    if (typeof slot.name !== "string" || !slot.name) {
      add("INVALID_NAME", `${path}/name`, "Slot name must be a nonempty string.");
    } else if (slotNames.has(slot.name)) {
      add("DUPLICATE_SLOT", `${path}/name`, `Duplicate slot ${slot.name}.`);
    } else {
      slotNames.add(slot.name);
    }
    if (typeof slot.bone !== "string" || !boneIndex.has(slot.bone)) {
      add("MISSING_BONE", `${path}/bone`, `Slot bone ${String(slot.bone)} does not exist.`);
    }
  });

  const skinNames = new Set<string>();
  const attachments = new Map<string, Set<string>>();
  skins.forEach((skin, skinIndex) => {
    const skinPath = pointer("skins", skinIndex);
    if (typeof skin.name !== "string" || !skin.name) {
      add("INVALID_NAME", `${skinPath}/name`, "Skin name must be a nonempty string.");
      return;
    }
    if (skinNames.has(skin.name)) add("DUPLICATE_SKIN", `${skinPath}/name`, `Duplicate skin ${skin.name}.`);
    skinNames.add(skin.name);
    const bySlot = object(skin.attachments) ?? {};
    for (const [slotName, byNameValue] of Object.entries(bySlot)) {
      const slotPath = pointer("skins", skinIndex, "attachments", slotName);
      if (!slotNames.has(slotName)) add("MISSING_SLOT", slotPath, `Attachment slot ${slotName} does not exist.`);
      const byName = object(byNameValue);
      if (!byName) {
        add("INVALID_ATTACHMENTS", slotPath, "Expected an attachment map.");
        continue;
      }
      for (const [name, rawAttachment] of Object.entries(byName)) {
        const path = pointer("skins", skinIndex, "attachments", slotName, name);
        const attachment = object(rawAttachment);
        if (!attachment) {
          add("INVALID_ATTACHMENT", path, "Expected an attachment object.");
          continue;
        }
        const known = attachments.get(slotName) ?? new Set<string>();
        known.add(name);
        attachments.set(slotName, known);
        attachmentLookup.set(JSON.stringify([skin.name, slotName, name]), attachment);
        const type = attachment.type ?? "region";
        if (type === "linkedmesh") {
          const refField = /^4\.3(?:\.|$)/.test(document.version) ? "source" : "parent";
          linkedMeshes.push({ path, skin: skin.name, slot: slotName, parent: attachment[refField], sourceSkin: attachment.skin, refField });
        }
        if (type === "region" || type === "mesh" || (type === "linkedmesh" && typeof attachment.path === "string")) {
          imageAssets.push({ slot: slotName, name, path: String(attachment.path ?? name) });
        }
        if (type === "mesh") {
          const uvs = attachment.uvs;
          const triangles = attachment.triangles;
          const vertices = attachment.vertices;
          if (!finiteNumbers(uvs) || uvs.length < 6 || uvs.length % 2 !== 0) {
            add("INVALID_MESH_UVS", `${path}/uvs`, "Mesh UVs must be an even-length numeric array of at least three vertices.");
          }
          if (!finiteNumbers(vertices)) {
            add("INVALID_MESH_VERTICES", `${path}/vertices`, "Mesh vertices must be numeric.");
          }
          if (!finiteNumbers(triangles) || triangles.length % 3 !== 0) {
            add("INVALID_MESH_TRIANGLES", `${path}/triangles`, "Mesh triangles must be numeric triples.");
          } else if (finiteNumbers(uvs)) {
            const count = uvs.length / 2;
            triangles.forEach((vertex, i) => {
              if (!Number.isInteger(vertex) || vertex < 0 || vertex >= count) {
                add("MESH_TRIANGLE_RANGE", `${path}/triangles/${i}`, `Triangle index ${vertex} is outside the mesh vertex range.`);
              }
            });
          }
          if (finiteNumbers(uvs) && finiteNumbers(vertices) && vertices.length !== uvs.length) {
            let cursor = 0;
            for (let vertex = 0; vertex < uvs.length / 2; vertex += 1) {
              const weightCount = vertices[cursor];
              if (!Number.isInteger(weightCount) || weightCount < 1 || cursor + 1 + 4 * weightCount > vertices.length) {
                add("INVALID_MESH_WEIGHTS", `${path}/vertices/${cursor}`, "Weighted vertex encoding is invalid.");
                break;
              }
              cursor += 1;
              for (let weight = 0; weight < weightCount; weight += 1) {
                const bone = vertices[cursor];
                if (!Number.isInteger(bone) || bone < 0 || bone >= bones.length) {
                  add("MISSING_BONE", `${path}/vertices/${cursor}`, `Weighted mesh bone index ${bone} does not exist.`);
                }
                cursor += 4;
              }
            }
            if (cursor !== vertices.length) {
              add("INVALID_MESH_WEIGHTS", `${path}/vertices`, "Weighted vertices do not match the mesh vertex count.");
            }
          }
        }
        if (["boundingbox", "path", "clipping"].includes(String(type))) {
          const count = attachment.vertexCount;
          const vertices = attachment.vertices;
          if (!Number.isSafeInteger(count) || Number(count) < 3) {
            add("INVALID_VERTEX_COUNT", `${path}/vertexCount`, "Polygon vertex count must be an integer of at least three.");
          } else if (!finiteNumbers(vertices)) {
            add("INVALID_POLYGON_VERTICES", `${path}/vertices`, "Polygon vertices must be finite numbers.");
          } else if (vertices.length !== Number(count) * 2) {
            let cursor = 0;
            for (let vertex = 0; vertex < Number(count); vertex += 1) {
              const weightCount = vertices[cursor];
              if (!Number.isSafeInteger(weightCount) || weightCount < 1 || cursor + 1 + 4 * weightCount > vertices.length) {
                add("INVALID_POLYGON_WEIGHTS", `${path}/vertices/${cursor}`, "Weighted polygon encoding is invalid.");
                break;
              }
              cursor += 1;
              for (let weight = 0; weight < weightCount; weight += 1) {
                const bone = vertices[cursor];
                if (!Number.isSafeInteger(bone) || bone < 0 || bone >= bones.length) {
                  add("MISSING_BONE", `${path}/vertices/${cursor}`, `Weighted polygon bone index ${bone} does not exist.`);
                }
                cursor += 4;
              }
            }
            if (cursor !== vertices.length) {
              add("INVALID_POLYGON_WEIGHTS", `${path}/vertices`, "Weighted vertices do not match the polygon vertex count.");
            }
          }
        }
        if (type === "clipping" && typeof attachment.end === "string" && !slotNames.has(attachment.end)) {
          add("MISSING_SLOT", `${path}/end`, `Clipping end slot ${attachment.end} does not exist.`);
        }
      }
    }
  });
  slots.forEach((slot, index) => {
    if (typeof slot.name === "string" && typeof slot.attachment === "string" && !attachments.get(slot.name)?.has(slot.attachment)) {
      add("MISSING_ATTACHMENT", pointer("slots", index, "attachment"), `Setup attachment ${slot.attachment} does not exist in slot ${slot.name}.`);
    }
  });

  const constraintNames = new Map<string, Set<string>>();
  constraints.forEach(({ constraint, path, type }) => {
    const name = typeof constraint.name === "string" ? constraint.name : "";
    if (!type || !name) add("INVALID_CONSTRAINT", path, "Constraint needs a type and name.");
    const names = constraintNames.get(type) ?? new Set<string>();
    if (names.has(name)) add("DUPLICATE_CONSTRAINT", `${path}/name`, `Duplicate ${type} constraint ${name}.`);
    names.add(name);
    constraintNames.set(type, names);
    if (type === "physics" && typeof constraint.bone !== "string") {
      add("INVALID_CONSTRAINT", `${path}/bone`, "Physics constraint needs one bone.");
    }
    if (["ik", "transform", "path"].includes(type)
      && (!Array.isArray(constraint.bones) || constraint.bones.length === 0)) {
      add("INVALID_CONSTRAINT", `${path}/bones`, `${type} constraint needs constrained bones.`);
    }
    if (Array.isArray(constraint.bones)) {
      constraint.bones.forEach((bone, boneIndexInConstraint) => {
        if (typeof bone !== "string" || !boneIndex.has(bone)) {
          add("MISSING_BONE", `${path}/bones/${boneIndexInConstraint}`, `Constraint bone ${String(bone)} does not exist.`);
        }
      });
    }
    if (typeof constraint.bone === "string" && !boneIndex.has(constraint.bone)) {
      add("MISSING_BONE", `${path}/bone`, `Constraint bone ${constraint.bone} does not exist.`);
    }
    if (type === "path" && typeof constraint.slot === "string" && !slotNames.has(constraint.slot)) {
      add("MISSING_SLOT", `${path}/slot`, `Path constraint slot ${constraint.slot} does not exist.`);
    }
    const modern = /^4\.3(?:\.|$)/.test(document.version);
    const targetField = type === "path" && modern ? "slot"
      : type === "transform" && modern ? "source" : "target";
    if (["ik", "transform", "path"].includes(type) && typeof constraint[targetField] !== "string") {
      add("INVALID_CONSTRAINT", `${path}/${targetField}`, `${type} constraint needs a ${targetField}.`);
    }
    if (type === "path") {
      const slot = constraint.slot ?? constraint.target;
      if (typeof slot === "string" && slotNames.has(slot) && !skins.some((skin) => {
        const bySlot = object(object(skin.attachments)?.[slot]);
        return bySlot && Object.values(bySlot).some((entry) => object(entry)?.type === "path");
      })) {
        add("MISSING_PATH_ATTACHMENT", `${path}/${targetField}`, `Path constraint target slot ${slot} has no path attachment.`);
      }
    }
    for (const field of ["target", "source"] as const) {
      const target = constraint[field];
      if (typeof target !== "string") continue;
      const valid = type === "path" && field === "target" ? slotNames.has(target) : boneIndex.has(target);
      if (!valid) add(type === "path" && field === "target" ? "MISSING_SLOT" : "MISSING_BONE", `${path}/${field}`, `${field} ${target} does not exist.`);
    }
  });

  skins.forEach((skin, skinIndex) => {
    const skinPath = pointer("skins", skinIndex);
    if (skin.bones !== undefined && !Array.isArray(skin.bones)) add("INVALID_SKIN_BONES", `${skinPath}/bones`, "Skin bones must be an array.");
    if (Array.isArray(skin.bones)) skin.bones.forEach((entry, index) => {
      const name = typeof entry === "string" ? entry : object(entry)?.name;
      if (typeof name !== "string" || !boneIndex.has(name)) {
        add("MISSING_BONE", pointer("skins", skinIndex, "bones", index), `Skin bone ${String(name)} does not exist.`);
      }
    });
    for (const type of ["ik", "transform", "path", "physics", "constraints"] as const) {
      const values = skin[type];
      if (values === undefined) continue;
      if (!Array.isArray(values)) {
        add("INVALID_SKIN_CONSTRAINTS", `${skinPath}/${type}`, "Skin constraints must be an array.");
        continue;
      }
      values.forEach((entry, index) => {
        const name = typeof entry === "string" ? entry : object(entry)?.name;
        const explicitType = type === "constraints" ? object(entry)?.type : type;
        const found = typeof name === "string" && (typeof explicitType === "string"
          ? constraintNames.get(explicitType)?.has(name)
          : [...constraintNames.values()].some((names) => names.has(name)));
        if (!found) add("MISSING_CONSTRAINT", pointer("skins", skinIndex, type, index), `Skin constraint ${String(name)} does not exist.`);
      });
    }
  });
  linkedMeshes.forEach(({ path, slot, parent, sourceSkin, refField }) => {
    const skin = typeof sourceSkin === "string" ? sourceSkin : "default";
    const source = typeof parent === "string" ? attachmentLookup.get(JSON.stringify([skin, slot, parent])) : undefined;
    if (!source || (source.type !== "mesh" && source.type !== "linkedmesh")) {
      add("MISSING_LINKED_MESH_PARENT", `${path}/${refField}`, `Linked mesh source ${String(parent)} was not found as a mesh in skin ${skin}, slot ${slot}.`);
    }
  });

  function deformCapacity(skin: string, slot: string, name: string, visited = new Set<string>()): number | undefined {
    const id = JSON.stringify([skin, slot, name]);
    if (visited.has(id)) return undefined;
    visited.add(id);
    const attachment = attachmentLookup.get(id);
    if (!attachment) return undefined;
    if (attachment.type === "linkedmesh") {
      const ref = /^4\.3(?:\.|$)/.test(document.version) ? attachment.source : attachment.parent;
      return typeof ref === "string"
        ? deformCapacity(typeof attachment.skin === "string" ? attachment.skin : "default", slot, ref, visited)
        : undefined;
    }
    if (attachment.type !== "mesh" || !finiteNumbers(attachment.uvs) || !finiteNumbers(attachment.vertices)) return undefined;
    const uvs = attachment.uvs;
    const vertices = attachment.vertices;
    if (vertices.length === uvs.length) return vertices.length;
    let cursor = 0;
    let influences = 0;
    for (let vertex = 0; vertex < uvs.length / 2; vertex++) {
      const count = vertices[cursor];
      if (!Number.isInteger(count) || count < 1 || cursor + 1 + 4 * count > vertices.length) return undefined;
      influences += count;
      cursor += 1 + 4 * count;
    }
    return cursor === vertices.length ? influences * 2 : undefined;
  }

  for (const [animationName, animationValue] of Object.entries(animations)) {
    const animation = object(animationValue);
    if (!animation) {
      add("INVALID_ANIMATION", pointer("animations", animationName), "Expected an animation object.");
      continue;
    }
    try {
      for (const timeline of collectTimelines(animationName, animation)) {
        const base = timelinePath(timeline.path);
        if (timeline.keys.length === 0) {
          add("EMPTY_TIMELINE", base, "An empty animation timeline cannot be imported by Spine.", "Remove the timeline property instead of leaving an empty key array.");
        }
        if (timeline.section === "bones" && !boneIndex.has(timeline.target)) {
          add("MISSING_BONE", base, `Animation bone ${timeline.target} does not exist.`);
        }
        if (timeline.section === "slots" && !slotNames.has(timeline.target)) {
          add("MISSING_SLOT", base, `Animation slot ${timeline.target} does not exist.`);
        }
        if (["ik", "transform", "path", "physics", "slider"].includes(timeline.section) && !constraintNames.get(timeline.section)?.has(timeline.target)) {
          add("MISSING_CONSTRAINT", base, `Animation constraint ${timeline.target} does not exist.`);
        }
        if (timeline.section === "attachments" || timeline.section === "deform") {
          const skin = String(timeline.path[3]);
          const slot = String(timeline.path[4]);
          const attachment = String(timeline.path[5]);
          if (!skinNames.has(skin)) add("MISSING_SKIN", base, `Animation skin ${skin} does not exist.`);
          if (!slotNames.has(slot)) add("MISSING_SLOT", base, `Animation slot ${slot} does not exist.`);
          if (!attachments.get(slot)?.has(attachment)) add("MISSING_ATTACHMENT", base, `Animation attachment ${attachment} does not exist.`);
        }
        let previous = -1;
        timeline.keys.forEach((key, index) => {
          const path = [...timeline.path, index];
          let time: number;
          try {
            time = keyTime(key, path);
          } catch (error) {
            const issue = error as SpineError;
            add(issue.code, timelinePath(path), issue.message);
            return;
          }
          if (time < previous) add("UNSORTED_KEYS", timelinePath(path), "Key times must be nondecreasing.", "Sort keys by time.");
          previous = time;
          if (key.curve !== undefined) {
            const channels = curveChannelCount(timeline);
            if (channels === 0) {
              add("INVALID_CURVE", `${timelinePath(path)}/curve`, "This discrete timeline cannot have interpolation curves.");
            } else if (key.curve !== "stepped" && (!finiteNumbers(key.curve) || key.curve.length === 0 || key.curve.length % 4 !== 0)) {
              add("INVALID_CURVE", `${timelinePath(path)}/curve`, "Curve must be 'stepped' or numeric control-point groups of four.");
            } else if (channels !== undefined && Array.isArray(key.curve) && key.curve.length !== channels * 4) {
              add("INVALID_CURVE_CHANNELS", `${timelinePath(path)}/curve`, `${timeline.section} ${timeline.type} needs ${channels} Bézier channel group(s), each with four numbers.`);
            }
          }
          if (timeline.section === "events" && (typeof key.name !== "string" || !Object.hasOwn(eventDefs, key.name))) {
            add("MISSING_EVENT", `${timelinePath(path)}/name`, `Animation event ${String(key.name)} is not defined.`);
          }
          if (timeline.section === "slots" && timeline.type === "attachment" && typeof key.name === "string" && !attachments.get(timeline.target)?.has(key.name)) {
            add("MISSING_ATTACHMENT", `${timelinePath(path)}/name`, `Attachment ${key.name} does not exist in slot ${timeline.target}.`);
          }
          if ((timeline.section === "attachments" || timeline.section === "deform") && timeline.type === "deform") {
            const skin = String(timeline.path[3]);
            const slot = String(timeline.path[4]);
            const attachment = String(timeline.path[5]);
            const source = attachmentLookup.get(JSON.stringify([skin, slot, attachment]));
            if (source && source.type !== "mesh" && source.type !== "linkedmesh") {
              add("INVALID_DEFORM_ATTACHMENT", timelinePath(path), "Deform keys require a mesh or linked mesh attachment.");
            }
            const offset = key.offset ?? 0;
            if (!Number.isSafeInteger(offset) || Number(offset) < 0) add("INVALID_DEFORM_OFFSET", `${timelinePath(path)}/offset`, "Deform offset must be a nonnegative integer.");
            if (key.vertices !== undefined) {
              if (!finiteNumbers(key.vertices)) {
                add("INVALID_DEFORM_VERTICES", `${timelinePath(path)}/vertices`, "Deform vertices must be finite numbers.");
              } else {
                const capacity = deformCapacity(skin, slot, attachment);
                if (capacity !== undefined && typeof offset === "number" && offset + key.vertices.length > capacity) {
                  add("DEFORM_VERTEX_RANGE", `${timelinePath(path)}/vertices`, `Deform values exceed the ${capacity}-coordinate mesh range.`);
                }
              }
            } else if (key.offset !== undefined) {
              add("INVALID_DEFORM_OFFSET", `${timelinePath(path)}/offset`, "A deform offset requires vertices.");
            }
          }
          if ((timeline.section === "drawOrder" || timeline.section === "draworder") && Array.isArray(key.offsets)) {
            key.offsets.forEach((offset, offsetIndex) => {
              const item = object(offset);
              if (item && typeof item.slot === "string" && !slotNames.has(item.slot)) {
                add("MISSING_SLOT", pointer(...path, "offsets", offsetIndex, "slot"), `Draw order slot ${item.slot} does not exist.`);
              }
            });
          }
        });
      }
    } catch (error) {
      if (error instanceof SpineError) {
        add(error.code, (object(error.details)?.path as string | undefined) ?? pointer("animations", animationName), error.message);
      } else {
        throw error;
      }
    }
  }

  if (checkAssets) {
    const skeleton = object(root.skeleton) ?? {};
    const images = typeof skeleton.images === "string" ? skeleton.images : "./images/";
    const imagesDir = isAbsolute(images) ? images : join(dirname(document.path), images);
    for (const asset of imageAssets) {
      const candidates = extname(asset.path)
        ? [join(imagesDir, asset.path)]
        : [".png", ".jpg", ".jpeg", ".webp"].map((extension) => join(imagesDir, `${asset.path}${extension}`));
      if (!candidates.some((candidate) => existsSync(candidate))) {
        add("MISSING_IMAGE", `/assets/${asset.slot}/${asset.name}`, `Image ${asset.path} was not found under ${imagesDir}.`, "Check the attachment path and image directory.", "warning");
      }
    }
  }

  return diagnostics;
}
