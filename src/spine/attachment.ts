import { applyEdits, modify } from "jsonc-parser";

import type { KeyChange } from "./bulk.js";
import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { collectTimelines, timelinePath, type JsonPath } from "./timelines.js";

type JsonRecord = Record<string, unknown>;
type AttachmentType = "region" | "mesh" | "linkedmesh" | "boundingbox" | "path" | "point" | "clipping";
interface Selector { skin: string; slot: string; name: string }
export interface UpsertAttachmentOperation extends Selector {
  kind: "upsert_attachment";
  attachmentType: AttachmentType;
  values: JsonRecord;
}
export interface SetMeshGeometryOperation extends Selector {
  kind: "set_mesh_geometry";
  uvs: number[];
  vertices: number[];
  triangles: number[];
  hull: number;
}
export interface MeshInfluence { bone: string; x: number; y: number; weight: number }
export interface SetMeshWeightsOperation extends Selector {
  kind: "set_mesh_weights";
  influences: MeshInfluence[][];
}
export interface RemoveAttachmentOperation extends Selector { kind: "remove_attachment" }
export type AttachmentOperation = UpsertAttachmentOperation | SetMeshGeometryOperation | SetMeshWeightsOperation | RemoveAttachmentOperation;
export interface AttachmentSummary {
  kind: AttachmentOperation["kind"];
  name: string;
  skin: string;
  slot: string;
  action: "created" | "updated" | "unchanged";
  path: string;
  vertexCount?: number;
  weighted?: boolean;
}
export interface RemoveAttachmentSummary {
  kind: "remove_attachment";
  name: string;
  skin: string;
  slot: string;
  action: "removed";
  path: string;
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(code: string, message: string): never { throw new SpineError(code, message); }
function numbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((n) => typeof n === "number" && Number.isFinite(n));
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}
function selected(document: SpineDocument, selector: Selector) {
  if (![selector.skin, selector.slot, selector.name].every(nonempty)) fail("INVALID_NAME", "Skin, slot, and attachment names must be nonempty.");
  if (!Array.isArray(document.data.slots) || !document.data.slots.some((slot) => record(slot) && slot.name === selector.slot)) {
    fail("MISSING_SLOT", `Slot ${selector.slot} does not exist.`);
  }
  const skins = Array.isArray(document.data.skins) ? document.data.skins : [];
  const index = skins.findIndex((skin) => record(skin) && skin.name === selector.skin);
  if (index < 0) fail("MISSING_SKIN", `Skin ${selector.skin} does not exist.`);
  const attachment = (skins[index] as JsonRecord).attachments;
  const bySlot = record(attachment) ? attachment[selector.slot] : undefined;
  const before = record(bySlot) ? bySlot[selector.name] : undefined;
  return { before, path: ["skins", index, "attachments", selector.slot, selector.name] as JsonPath };
}
function finish(document: SpineDocument, operation: AttachmentOperation, path: JsonPath, before: unknown, after: JsonRecord) {
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  const action: AttachmentSummary["action"] = !changed ? "unchanged" : before === undefined ? "created" : "updated";
  const uvs = after.type === "mesh" && numbers(after.uvs) ? after.uvs : undefined;
  const summary: AttachmentSummary = { kind: operation.kind, name: operation.name, skin: operation.skin,
    slot: operation.slot, action, path: timelinePath(path),
    ...(uvs ? { vertexCount: uvs.length / 2, weighted: numbers(after.vertices) && after.vertices.length > uvs.length } : {}) };
  const edits = changed ? modify(document.text, path, after, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }) : [];
  return { text: changed ? applyEdits(document.text, edits) : document.text,
    changes: changed ? [{ path: timelinePath(path), before: before ?? null, after } satisfies KeyChange] : [], summary };
}
function validateVertices(vertices: unknown, count: number) {
  if (!numbers(vertices) || vertices.length < count * 2) fail("INVALID_MESH_VERTICES", "Vertices must be finite coordinate pairs or a complete weighted encoding.");
  if (vertices.length === count * 2) return false;
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const influences = vertices[cursor++];
    if (!Number.isInteger(influences) || influences < 1 || cursor + 4 * influences > vertices.length) {
      fail("INVALID_MESH_WEIGHTS", `Vertex ${i} has an invalid influence count.`);
    }
    let total = 0;
    for (let j = 0; j < influences; j += 1) {
      const boneIndex = vertices[cursor];
      const weight = vertices[cursor + 3];
      if (!Number.isInteger(boneIndex) || boneIndex < 0 || weight <= 0) fail("INVALID_MESH_WEIGHTS", `Vertex ${i} has an invalid bone index or weight.`);
      total += weight;
      cursor += 4;
    }
    if (Math.abs(total - 1) > 0.001) fail("INVALID_MESH_WEIGHTS", `Vertex ${i} weights must total 1.`);
  }
  if (cursor !== vertices.length) fail("INVALID_MESH_WEIGHTS", "Weighted encoding has trailing values.");
  return true;
}
function validateMesh(attachment: JsonRecord) {
  const uvs = attachment.uvs;
  const triangles = attachment.triangles;
  if (!numbers(uvs) || uvs.length < 6 || uvs.length % 2 !== 0) fail("INVALID_MESH_UVS", "Mesh UVs need at least three numeric pairs.");
  const count = uvs.length / 2;
  if (!numbers(triangles) || triangles.length < 3 || triangles.length % 3 !== 0
    || triangles.some((index) => !Number.isInteger(index) || index < 0 || index >= count)) {
    fail("INVALID_MESH_TRIANGLES", "Mesh triangles need valid vertex-index triples.");
  }
  if (!Number.isInteger(attachment.hull) || (attachment.hull as number) < 3 || (attachment.hull as number) > count) {
    fail("INVALID_MESH_HULL", "Mesh hull must be an integer from 3 to the vertex count.");
  }
  if (attachment.edges !== undefined && (!numbers(attachment.edges) || attachment.edges.length % 2 !== 0
    || attachment.edges.some((index) => !Number.isInteger(index) || index < 0 || index >= count * 2 || index % 2 !== 0))) {
    fail("INVALID_MESH_EDGES", "Mesh edges need valid coordinate-offset pairs.");
  }
  validateVertices(attachment.vertices, count);
}
function validateAttachment(type: AttachmentType, attachment: JsonRecord) {
  const fields: Record<AttachmentType, string[]> = {
    region: ["name", "path", "x", "y", "rotation", "scaleX", "scaleY", "width", "height", "color"],
    mesh: ["name", "path", "uvs", "triangles", "vertices", "hull", "edges", "color", "width", "height"],
    linkedmesh: ["name", "path", "skin", "parent", "source", "deform", "color", "width", "height"],
    boundingbox: ["name", "vertexCount", "vertices", "color"],
    path: ["name", "closed", "constantSpeed", "lengths", "vertexCount", "vertices", "color"],
    point: ["name", "x", "y", "rotation", "color"],
    clipping: ["name", "end", "vertexCount", "vertices", "color"],
  };
  for (const [field, value] of Object.entries(attachment)) {
    if (field === "type") continue;
    if (!fields[type].includes(field)) continue; // Preserve unfamiliar editor fields on updates.
    if (["x", "y", "rotation", "scaleX", "scaleY", "width", "height"].includes(field)) {
      if (typeof value !== "number" || !Number.isFinite(value) || (["width", "height"].includes(field) && value <= 0)) fail("INVALID_ATTACHMENT_VALUE", `${field} must be a finite${["width", "height"].includes(field) ? " positive" : ""} number.`);
    } else if (["name", "path", "skin", "parent", "source", "end"].includes(field) && !nonempty(value)) {
      fail("INVALID_ATTACHMENT_VALUE", `${field} must be a nonempty string.`);
    } else if (field === "color" && (typeof value !== "string" || !/^[0-9a-fA-F]{8}$/.test(value))) {
      fail("INVALID_ATTACHMENT_VALUE", "color must be eight hexadecimal digits.");
    } else if (["closed", "constantSpeed", "deform"].includes(field) && typeof value !== "boolean") {
      fail("INVALID_ATTACHMENT_VALUE", `${field} must be boolean.`);
    }
  }
  if (type === "region" && (!attachment.width || !attachment.height)) fail("MISSING_ATTACHMENT_SIZE", "A region needs positive width and height.");
  if (type === "mesh") validateMesh(attachment);
  if (type === "linkedmesh" && !nonempty(attachment.parent) && !nonempty(attachment.source)) {
    fail("MISSING_MESH_PARENT", "A linked mesh needs a source mesh name.");
  }
  if (["boundingbox", "path", "clipping"].includes(type)) {
    const count = attachment.vertexCount;
    if (!Number.isInteger(count) || Number(count) < 3) fail("INVALID_VERTEX_COUNT", `${type} needs at least three vertices.`);
    validateVertices(attachment.vertices, Number(count));
    if (type === "path" && (!numbers(attachment.lengths) || attachment.lengths.length === 0)) fail("INVALID_PATH_LENGTHS", "A path needs numeric curve lengths.");
  }
}
function meshDependencies(document: SpineDocument, selector: Selector): { linked: boolean; deform: boolean } {
  const skins = Array.isArray(document.data.skins) ? document.data.skins : [];
  const dependents = new Set([JSON.stringify([selector.skin, selector.slot, selector.name])]);
  for (const skin of skins) {
    if (!record(skin) || !record(skin.attachments) || !record(skin.attachments[selector.slot])) continue;
    for (const [name, attachment] of Object.entries(skin.attachments[selector.slot] as JsonRecord)) {
      if (record(attachment) && attachment.type === "linkedmesh"
        && (attachment.parent ?? attachment.source) === selector.name && (attachment.skin ?? "default") === selector.skin) {
        dependents.add(JSON.stringify([skin.name, selector.slot, name]));
      }
    }
  }
  const animations = record(document.data.animations) ? document.data.animations : {};
  const deform = Object.entries(animations).some(([animationName, animation]) =>
    collectTimelines(animationName, animation).some((timeline) =>
      (timeline.section === "deform" || timeline.section === "attachments") && timeline.type === "deform"
      && dependents.has(JSON.stringify(timeline.path.slice(3, 6)))));
  return { linked: dependents.size > 1, deform };
}
function guardMeshChange(document: SpineDocument, selector: Selector, before: unknown, after: JsonRecord) {
  if (!record(before) || before.type !== "mesh" || !numbers(before.uvs) || !numbers(before.vertices)) return;
  const oldCount = before.uvs.length / 2;
  const newCount = (after.uvs as number[]).length / 2;
  const oldWeighted = before.vertices.length > before.uvs.length;
  const newWeighted = (after.vertices as number[]).length > (after.uvs as number[]).length;
  const capacity = (vertices: number[], count: number, weighted: boolean) => {
    if (!weighted) return count * 2;
    let cursor = 0;
    let influences = 0;
    for (let vertex = 0; vertex < count; vertex += 1) {
      const influenceCount = vertices[cursor];
      influences += influenceCount;
      cursor += 1 + influenceCount * 4;
    }
    return influences * 2;
  };
  const oldCapacity = capacity(before.vertices, oldCount, oldWeighted);
  const newCapacity = capacity(after.vertices as number[], newCount, newWeighted);
  const dependencies = meshDependencies(document, selector);
  if (oldCount !== newCount && (dependencies.linked || dependencies.deform)) {
    fail("MESH_TOPOLOGY_IN_USE", "Vertex count cannot change while linked meshes or deform timelines use this mesh.");
  }
  if (dependencies.deform && oldCapacity !== newCapacity) {
    fail("MESH_DEFORM_IN_USE", "The mesh's deform capacity cannot change while deform timelines use it.");
  }
}
export function upsertAttachmentText(document: SpineDocument, operation: UpsertAttachmentOperation) {
  const { before, path } = selected(document, operation);
  if (before !== undefined && (!record(before) || (before.type ?? "region") !== operation.attachmentType)) {
    fail("ATTACHMENT_TYPE_CONFLICT", "An existing attachment cannot be changed to a different type.");
  }
  if (!record(operation.values)) fail("INVALID_ATTACHMENT", "Attachment values must be an object.");
  const allowed: Record<AttachmentType, string[]> = {
    region: ["name", "path", "x", "y", "rotation", "scaleX", "scaleY", "width", "height", "color"],
    mesh: ["name", "path", "uvs", "triangles", "vertices", "hull", "edges", "color", "width", "height"],
    linkedmesh: ["name", "path", "skin", "parent", "source", "deform", "color", "width", "height"],
    boundingbox: ["name", "vertexCount", "vertices", "color"],
    path: ["name", "closed", "constantSpeed", "lengths", "vertexCount", "vertices", "color"],
    point: ["name", "x", "y", "rotation", "color"],
    clipping: ["name", "end", "vertexCount", "vertices", "color"],
  };
  for (const field of Object.keys(operation.values)) if (!allowed[operation.attachmentType].includes(field)) fail("INVALID_ATTACHMENT_FIELD", `${field} is not valid for ${operation.attachmentType}.`);
  const after: JsonRecord = { ...(record(before) ? before : {}), type: operation.attachmentType, ...operation.values };
  if (operation.attachmentType === "linkedmesh") {
    if (nonempty(operation.values.parent) && nonempty(operation.values.source)
      && operation.values.parent !== operation.values.source) fail("INVALID_ATTACHMENT_VALUE", "parent and source must refer to the same mesh.");
    const ref = operation.values.parent ?? operation.values.source ?? after.parent ?? after.source;
    if (/^4\.3(?:\.|$)/.test(document.version)) { after.source = ref; delete after.parent; }
    else { after.parent = ref; delete after.source; }
  }
  validateAttachment(operation.attachmentType, after);
  if (operation.attachmentType === "mesh") guardMeshChange(document, operation, before, after);
  return finish(document, operation, path, before, after);
}
export function setMeshGeometryText(document: SpineDocument, operation: SetMeshGeometryOperation) {
  const { before, path } = selected(document, operation);
  if (!record(before) || before.type !== "mesh") fail("MISSING_MESH", "The selected attachment must be a mesh.");
  const after = { ...before, uvs: operation.uvs, vertices: operation.vertices, triangles: operation.triangles, hull: operation.hull };
  validateMesh(after);
  if (operation.vertices.length !== operation.uvs.length) fail("INVALID_MESH_VERTICES", "Geometry editing accepts unweighted x/y pairs; use set_mesh_weights for influences.");
  guardMeshChange(document, operation, before, after);
  return finish(document, operation, path, before, after);
}
export function setMeshWeightsText(document: SpineDocument, operation: SetMeshWeightsOperation) {
  const { before, path } = selected(document, operation);
  if (!record(before) || before.type !== "mesh" || !numbers(before.uvs)) fail("MISSING_MESH", "The selected attachment must be a mesh.");
  if (!Array.isArray(operation.influences) || operation.influences.length !== before.uvs.length / 2) {
    fail("INVALID_MESH_WEIGHTS", "Provide one influence list per mesh vertex.");
  }
  const bones = Array.isArray(document.data.bones) ? document.data.bones : [];
  const boneIndex = new Map(bones.map((bone, index) => [bone.name, index]));
  const vertices: number[] = [];
  operation.influences.forEach((influences, vertex) => {
    if (!Array.isArray(influences) || influences.length === 0) fail("INVALID_MESH_WEIGHTS", `Vertex ${vertex} needs at least one influence.`);
    const names = new Set<string>();
    let total = 0;
    vertices.push(influences.length);
    for (const influence of influences) {
      const index = boneIndex.get(influence.bone);
      if (index === undefined) fail("MISSING_BONE", `Influence bone ${influence.bone} does not exist.`);
      if (names.has(influence.bone)) fail("INVALID_MESH_WEIGHTS", `Vertex ${vertex} repeats bone ${influence.bone}.`);
      names.add(influence.bone);
      if (![influence.x, influence.y, influence.weight].every((value) => typeof value === "number" && Number.isFinite(value))
        || influence.weight <= 0) fail("INVALID_MESH_WEIGHTS", `Vertex ${vertex} has an invalid influence.`);
      total += influence.weight;
      vertices.push(index, influence.x, influence.y, influence.weight);
    }
    if (Math.abs(total - 1) > 0.001) fail("INVALID_MESH_WEIGHTS", `Vertex ${vertex} weights must total 1.`);
  });
  const after = { ...before, vertices };
  validateMesh(after);
  guardMeshChange(document, operation, before, after);
  return finish(document, operation, path, before, after);
}

export function removeAttachmentText(document: SpineDocument, operation: RemoveAttachmentOperation) {
  const { before, path } = selected(document, operation);
  if (!record(before)) fail("MISSING_ATTACHMENT", `Attachment ${operation.name} does not exist in skin ${operation.skin}, slot ${operation.slot}.`);
  const skins = document.data.skins as JsonRecord[];
  const targetSkinIndex = path[1] as number;
  const defaultSkin = skins.find((skin) => skin.name === "default");
  const remainingName = operation.skin !== "default" && record(defaultSkin?.attachments)
    && record(defaultSkin.attachments[operation.slot])
    && Object.hasOwn(defaultSkin.attachments[operation.slot] as JsonRecord, operation.name);
  const refField = /^4\.3(?:\.|$)/.test(document.version) ? "source" : "parent";
  const references: string[] = [];
  const add = (reference: JsonPath) => references.push(timelinePath(reference));

  if (!remainingName && Array.isArray(document.data.slots)) {
    document.data.slots.forEach((slot, index) => {
      if (record(slot) && slot.name === operation.slot && slot.attachment === operation.name) add(["slots", index, "attachment"]);
    });
  }
  skins.forEach((skin, skinIndex) => {
    if (!record(skin.attachments) || !record(skin.attachments[operation.slot])) return;
    for (const [name, value] of Object.entries(skin.attachments[operation.slot] as JsonRecord)) {
      if (skinIndex === targetSkinIndex && name === operation.name) continue;
      if (record(value) && value.type === "linkedmesh" && value[refField] === operation.name
        && (value.skin ?? "default") === operation.skin) {
        add(["skins", skinIndex, "attachments", operation.slot, name, refField]);
      }
    }
  });
  const animations = record(document.data.animations) ? document.data.animations : {};
  for (const [animationName, animation] of Object.entries(animations)) {
    for (const timeline of collectTimelines(animationName, animation)) {
      if ((timeline.section === "attachments" || timeline.section === "deform")
        && timeline.path[3] === operation.skin && timeline.path[4] === operation.slot
        && timeline.path[5] === operation.name) add(timeline.path);
      if (!remainingName && timeline.section === "slots" && timeline.target === operation.slot
        && timeline.type === "attachment") {
        timeline.keys.forEach((key, index) => {
          if (key.name === operation.name) add([...timeline.path, index, "name"]);
        });
      }
    }
  }
  if (before.type === "path") {
    const anotherPath = operation.skin !== "default" && record(defaultSkin?.attachments)
      && record(defaultSkin.attachments[operation.slot])
      && Object.values(defaultSkin.attachments[operation.slot] as JsonRecord).some((value) => record(value) && value.type === "path");
    if (!anotherPath) {
      const paths = [
        ...((Array.isArray(document.data.path) ? document.data.path : []) as JsonRecord[])
          .map((constraint, index) => ({ constraint, path: ["path", index] as JsonPath })),
        ...((Array.isArray(document.data.constraints) ? document.data.constraints : []) as JsonRecord[])
          .map((constraint, index) => ({ constraint, path: ["constraints", index] as JsonPath })),
      ];
      for (const entry of paths) {
        if (!record(entry.constraint) || entry.constraint.type !== "path" && entry.path[0] !== "path") continue;
        const field = entry.path[0] === "constraints" ? "slot" : "target";
        if (entry.constraint[field] === operation.slot) add([...entry.path, field]);
      }
    }
  }
  if (references.length > 0) {
    throw new SpineError("ATTACHMENT_IN_USE", `Attachment ${operation.name} is still referenced.`,
      { references: references.slice(0, 100), referenceCount: references.length });
  }
  const bySlot = (skins[targetSkinIndex].attachments as JsonRecord)[operation.slot] as JsonRecord;
  const removePath = Object.keys(bySlot).length === 1 ? path.slice(0, -1) : path;
  const edits = modify(document.text, removePath, undefined,
    { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } });
  const summary: RemoveAttachmentSummary = { kind: "remove_attachment", name: operation.name,
    skin: operation.skin, slot: operation.slot, action: "removed", path: timelinePath(path) };
  return { text: applyEdits(document.text, edits),
    changes: [{ path: timelinePath(path), before, after: null } satisfies KeyChange], summary };
}
