import type { SpineDocument } from "./document.js";
import { requireEditableVersion } from "./document.js";
import type { EditOperation } from "./edit.js";
import { SpineError } from "./errors.js";
import { poseApplyOperations, sampleBoneTimeline, type BonePoseEntry, type SavedBonePose } from "./pose.js";
import { collectTimelines, keyTime, timelinePath } from "./timelines.js";
import { validateDocument } from "./validate.js";

type JsonRecord = Record<string, unknown>;
const BONE_TYPES = new Set(["rotate", "translate", "translatex", "translatey", "scale", "scalex", "scaley",
  "shear", "shearx", "sheary"]);
export interface SavedPose {
  name: string;
  sourcePath: string;
  sourceHash: string;
  sourceVersion: string;
  animation: string;
  time: number;
  boneEntries: BonePoseEntry[];
  slotEntries: { slot: string; attachment: string | null }[];
  skippedTimelines: string[];
}
export interface ApplyPoseOptions {
  blend?: number;
  boneMap?: Record<string, string>;
  slotMap?: Record<string, string>;
  attachmentMap?: Record<string, Record<string, string>>;
  mirrorPairs?: [string, string][];
  offsets?: Record<string, Record<string, Record<string, number>>>;
  applySlots?: boolean;
  curvePolicy?: "reject" | "linearize";
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function valid(document: SpineDocument): void {
  requireEditableVersion(document);
  const diagnostics = validateDocument(document);
  if (diagnostics.some((item) => item.severity === "error")) {
    throw new SpineError("VALIDATION_FAILED", "Skeleton data has validation errors.", { diagnostics });
  }
}
function selectedNames(available: Set<string>, requested: string[] | undefined, kind: string): Set<string> | undefined {
  if (requested === undefined) return undefined;
  if (requested.length < 1 || new Set(requested).size !== requested.length
    || requested.some((name) => !available.has(name))) {
    throw new SpineError("INVALID_POSE_SELECTION", `Selected ${kind} must be distinct existing names.`);
  }
  return new Set(requested);
}
function animation(document: SpineDocument, name: string): JsonRecord {
  const animations = document.data.animations;
  if (!record(animations) || !record(animations[name])) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${name} was not found.`);
  }
  return animations[name] as JsonRecord;
}
function slots(document: SpineDocument): JsonRecord[] {
  return (Array.isArray(document.data.slots) ? document.data.slots : []).filter(record);
}
function bones(document: SpineDocument): Set<string> {
  return new Set((Array.isArray(document.data.bones) ? document.data.bones : []).filter(record)
    .map((bone) => bone.name).filter((name): name is string => typeof name === "string"));
}

export function capturePose(document: SpineDocument, animationName: string, time: number, name: string,
  selectedBones?: string[], selectedSlots?: string[]): SavedPose {
  valid(document);
  if (!name.trim()) throw new SpineError("INVALID_NAME", "Pose name must be nonempty.");
  if (!Number.isFinite(time) || time < 0) throw new SpineError("INVALID_KEY_TIME", "Pose time must be finite and nonnegative.");
  const source = animation(document, animationName);
  const boneSelection = selectedNames(bones(document), selectedBones, "bones");
  const setupSlots = slots(document);
  const slotNames = new Set(setupSlots.map((slot) => slot.name).filter((item): item is string => typeof item === "string"));
  const slotSelection = selectedNames(slotNames, selectedSlots, "slots");
  const timelines = collectTimelines(animationName, source);
  const boneEntries: SavedPose["boneEntries"] = [];
  const slotEntries: SavedPose["slotEntries"] = [];
  const skippedTimelines: string[] = [];
  for (const timeline of timelines) {
    if (timeline.section === "bones" && (!boneSelection || boneSelection.has(timeline.target))) {
      if (BONE_TYPES.has(timeline.type)) {
        boneEntries.push({ bone: timeline.target, timelineType: timeline.type,
          values: sampleBoneTimeline(timeline, timeline.type, time) });
      } else skippedTimelines.push(timelinePath(timeline.path));
    } else if (timeline.section !== "slots" && timeline.section !== "bones") {
      skippedTimelines.push(timelinePath(timeline.path));
    } else if (timeline.section === "slots" && timeline.type !== "attachment") {
      skippedTimelines.push(timelinePath(timeline.path));
    }
  }
  const attachmentTimelines = new Map(timelines.filter((timeline) => timeline.section === "slots" && timeline.type === "attachment")
    .map((timeline) => [timeline.target, timeline]));
  for (const setup of setupSlots) {
    const slot = setup.name as string;
    if (slotSelection ? !slotSelection.has(slot) : !attachmentTimelines.has(slot)) continue;
    let attachment = typeof setup.attachment === "string" ? setup.attachment : null;
    const timeline = attachmentTimelines.get(slot);
    if (timeline) {
      timeline.keys.forEach((key, index) => {
        if (keyTime(key, [...timeline.path, index]) <= time) attachment = typeof key.name === "string" ? key.name : null;
      });
    }
    slotEntries.push({ slot, attachment });
  }
  if (boneEntries.length + slotEntries.length === 0) {
    throw new SpineError("NO_POSE_CHANNELS", "No supported bone or slot pose channels match this request.");
  }
  if (boneEntries.length > 256 || slotEntries.length > 256) {
    throw new SpineError("POSE_TOO_LARGE", "A pose may contain at most 256 bone timelines and 256 slots.");
  }
  return { name, sourcePath: document.path, sourceHash: document.hash, sourceVersion: document.version,
    animation: animationName, time, boneEntries, slotEntries, skippedTimelines };
}

function mirroredBone(name: string, pairs: [string, string][], sourceBones: Set<string>): string {
  for (const [left, right] of pairs) {
    if (!sourceBones.has(left) || !sourceBones.has(right)) {
      throw new SpineError("INVALID_MIRROR_PAIRS", "Mirror pairs must name bones captured in the pose.");
    }
    if (name === left) return right;
    if (name === right) return left;
  }
  return name;
}
function mirrorValue(type: string, field: string, value: number): number {
  if (type === "rotate" || type === "translatex" || type === "shearx" || type === "sheary"
    || type === "translate" && field === "x" || type === "shear") return -value;
  return value;
}
function defaultAttachments(document: SpineDocument, slot: string): Set<string> {
  const skins = Array.isArray(document.data.skins) ? document.data.skins : [];
  const defaultSkin = skins.find((skin) => record(skin) && skin.name === "default") as JsonRecord | undefined;
  const all = defaultSkin && record(defaultSkin.attachments) ? defaultSkin.attachments : {};
  return new Set(record(all[slot]) ? Object.keys(all[slot]) : []);
}

export function applyPoseOperations(document: SpineDocument, pose: SavedPose, animationName: string, time: number,
  options: ApplyPoseOptions = {}) {
  valid(document);
  if (!animationName.trim()) throw new SpineError("INVALID_NAME", "Target animation name must be nonempty.");
  if (!Number.isFinite(time) || time < 0) throw new SpineError("INVALID_KEY_TIME", "Pose application time must be finite and nonnegative.");
  if (document.version.match(/^\d+\.\d+/)?.[0] !== pose.sourceVersion.match(/^\d+\.\d+/)?.[0]) {
    throw new SpineError("VERSION_MISMATCH", "Pose transfer requires matching Spine major and minor versions.");
  }
  const blend = options.blend ?? 1;
  if (!Number.isFinite(blend) || blend <= 0 || blend > 1) {
    throw new SpineError("INVALID_BLEND", "Pose blend must be greater than zero and at most one.");
  }
  const applySlots = options.applySlots ?? true;
  if (applySlots && pose.slotEntries.length && blend !== 1) {
    throw new SpineError("DISCRETE_BLEND_UNSUPPORTED", "Attachment states cannot be blended; use blend: 1 or applySlots: false.");
  }
  const sourceBones = new Set(pose.boneEntries.map((entry) => entry.bone));
  const pairs = options.mirrorPairs ?? [];
  const paired = new Set<string>();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === pair[1]
      || !sourceBones.has(pair[0]) || !sourceBones.has(pair[1])
      || paired.has(pair[0]) || paired.has(pair[1])) {
      throw new SpineError("INVALID_MIRROR_PAIRS", "Mirror pairs must be distinct captured bones.");
    }
    paired.add(pair[0]); paired.add(pair[1]);
  }
  const mirroredEntries = pose.boneEntries.map((entry) => ({ ...entry,
    bone: mirroredBone(entry.bone, pairs, sourceBones),
    values: Object.fromEntries(Object.entries(entry.values).map(([field, value]) =>
      [field, pairs.length ? mirrorValue(entry.timelineType, field, value) : value])) }));
  const transformed = new Set(mirroredEntries.map((entry) => entry.bone));
  const offsets = options.offsets ?? {};
  for (const [bone, types] of Object.entries(offsets)) {
    if (!transformed.has(bone) || !record(types) || Object.entries(types).some(([type, fields]) => {
      const available = mirroredEntries.find((entry) => entry.bone === bone && entry.timelineType === type);
      return !available || !record(fields) || Object.entries(fields).some(([field, value]) =>
        !Object.hasOwn(available.values, field) || typeof value !== "number" || !Number.isFinite(value));
    })) {
      throw new SpineError("INVALID_POSE_OFFSET", "Offsets must name captured bones and finite channel values.");
    }
  }
  for (const entry of mirroredEntries) {
    for (const [field, offset] of Object.entries(offsets[entry.bone]?.[entry.timelineType] ?? {})) {
      entry.values[field] += offset;
    }
  }
  let operations: EditOperation[] = [];
  let mappedBones: Record<string, string> = {};
  if (mirroredEntries.length) {
    const synthetic: SavedBonePose = { name: pose.name, sourcePath: pose.sourcePath,
      sourceHash: pose.sourceHash, sourceVersion: pose.sourceVersion, animation: pose.animation,
      time: pose.time, entries: mirroredEntries };
    const applied = poseApplyOperations(document, synthetic, animationName, time, blend,
      options.boneMap ?? {}, options.curvePolicy ?? "reject");
    operations = applied.operations;
    mappedBones = applied.mappedBones;
  }
  const slotMap = options.slotMap ?? {};
  const attachmentMap = options.attachmentMap ?? {};
  const poseSlots = new Set(pose.slotEntries.map((entry) => entry.slot));
  if (Object.keys(slotMap).some((slot) => !poseSlots.has(slot))
    || Object.keys(attachmentMap).some((slot) => !poseSlots.has(slot))) {
    throw new SpineError("INVALID_SLOT_MAP", "Slot and attachment maps must name slots in the saved pose.");
  }
  const mappedSlots: Record<string, string> = {};
  if (applySlots) {
    const targetSlots = new Set(slots(document).map((slot) => slot.name).filter((name): name is string => typeof name === "string"));
    const used = new Set<string>();
    for (const entry of pose.slotEntries) {
      const target = slotMap[entry.slot] ?? entry.slot;
      if (!targetSlots.has(target) || used.has(target)) {
        throw new SpineError("UNMAPPED_SLOTS", `Mapped slot ${target} is missing or used twice.`);
      }
      used.add(target);
      const name = entry.attachment === null ? null : attachmentMap[entry.slot]?.[entry.attachment] ?? entry.attachment;
      if (name !== null && !defaultAttachments(document, target).has(name)) {
        throw new SpineError("UNMAPPED_ATTACHMENTS", `Attachment ${name} is missing in default skin slot ${target}.`);
      }
      mappedSlots[entry.slot] = target;
      operations.push({ kind: "set_keyframe", animation: animationName,
        selector: { section: "slots", target, timelineType: "attachment" }, time, values: { name } });
    }
  }
  if (!operations.length) throw new SpineError("NO_POSE_CHANNELS", "Pose application selected no channels.");
  const targetAnimations = record(document.data.animations) ? document.data.animations : {};
  if (!Object.hasOwn(targetAnimations, animationName) && operations[0].kind !== "upsert_animation") {
    operations.unshift({ kind: "upsert_animation", name: animationName });
  }
  return { operations, summary: { poseName: pose.name, animation: animationName, time, blend,
    boneChannels: mirroredEntries.length, slotsApplied: applySlots ? pose.slotEntries.length : 0,
    mappedBones, mappedSlots, mirroredPairs: pairs.length, offsets: Object.keys(offsets).length,
    reviewHints: !applySlots && pose.slotEntries.length ? ["Slot attachment states were skipped."] : [] } };
}
