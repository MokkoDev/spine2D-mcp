import type { SpineDocument } from "./document.js";
import type { EditOperation } from "./edit.js";
import { SpineError } from "./errors.js";

type JsonRecord = Record<string, unknown>;
type BoneTimeline = "rotate" | "translate" | "scale";
type MotionKey = { time: number; values: JsonRecord };
type MotionTrack = { bone: string; type: BoneTimeline; keys: MotionKey[] };

export type MotionRecipe =
  | { type: "idle"; bone: string; duration: number; swayDegrees?: number; bobDistance?: number }
  | { type: "breathing"; bone: string; duration: number; amount?: number }
  | { type: "blink"; slot: string; openAttachment: string; closedAttachment: string;
      duration: number; at?: number; hold?: number }
  | { type: "walk" | "run"; leftLeg: string; rightLeg: string; leftArm?: string; rightArm?: string;
      rootBone?: string; duration: number; strideDegrees?: number; bobDistance?: number }
  | { type: "recoil"; bone: string; duration: number; angleDegrees?: number }
  | { type: "follow_through"; primaryBone: string; secondaryBone: string; duration: number;
      angleDegrees?: number; lag?: number };

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function round(value: number): number {
  if (!Number.isFinite(value)) throw new SpineError("MOTION_VALUE_OVERFLOW", "Motion recipe produced a nonfinite number.");
  return Number(value.toPrecision(12));
}
function inRange(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new SpineError("INVALID_MOTION_PARAMETER", `${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}
function requireBones(document: SpineDocument, names: string[]): void {
  const bones = new Set((Array.isArray(document.data.bones) ? document.data.bones : [])
    .filter(record).map((bone) => bone.name).filter((name): name is string => typeof name === "string"));
  if (new Set(names).size !== names.length || names.some((name) => !bones.has(name))) {
    throw new SpineError("INVALID_MOTION_BONES", "Motion bones must be distinct existing bone names.");
  }
}
function timed(duration: number, fractions: number[], values: JsonRecord[]): MotionKey[] {
  return fractions.map((fraction, index) => ({ time: round(duration * fraction), values: values[index] }));
}
function rotation(bone: string, duration: number, fractions: number[], values: number[]): MotionTrack {
  return { bone, type: "rotate", keys: timed(duration, fractions, values.map((value) => ({ value: round(value) }))) };
}
function translation(bone: string, duration: number, fractions: number[], yValues: number[]): MotionTrack {
  return { bone, type: "translate", keys: timed(duration, fractions,
    yValues.map((y) => ({ x: 0, y: round(y) }))) };
}
function checkTracks(tracks: MotionTrack[]): void {
  for (const track of tracks) {
    for (let index = 1; index < track.keys.length; index += 1) {
      if (track.keys[index].time <= track.keys[index - 1].time) {
        throw new SpineError("MOTION_TIME_CONFLICT", "Motion key times must be strictly increasing.");
      }
    }
  }
}
function trackOperations(animation: string, tracks: MotionTrack[]): EditOperation[] {
  const operations: EditOperation[] = [];
  for (const track of tracks) {
    for (const key of track.keys) {
      operations.push({ kind: "set_keyframe", animation,
        selector: { section: "bones", target: track.bone, timelineType: track.type },
        time: key.time, values: key.values });
    }
    for (const key of track.keys.slice(0, -1)) {
      operations.push({ kind: "set_curve", animation, bone: track.bone,
        timelineType: track.type, time: key.time, mode: "bezier",
        controls: [0.33, 0, 0.67, 1] });
    }
  }
  return operations;
}
function defaultAttachments(document: SpineDocument, slot: string): JsonRecord {
  const slots = Array.isArray(document.data.slots) ? document.data.slots : [];
  if (!slots.some((item) => record(item) && item.name === slot)) {
    throw new SpineError("MOTION_SLOT_NOT_FOUND", `Slot ${slot} does not exist.`);
  }
  const skins = Array.isArray(document.data.skins) ? document.data.skins : [];
  const skin = skins.find((item) => record(item) && item.name === "default") as JsonRecord | undefined;
  const all = skin && record(skin.attachments) ? skin.attachments : {};
  return record(all[slot]) ? all[slot] as JsonRecord : {};
}

export function buildMotionOperations(document: SpineDocument, newAnimation: string, recipe: MotionRecipe) {
  if (typeof newAnimation !== "string" || !newAnimation.trim()) {
    throw new SpineError("INVALID_NAME", "A new animation name is required.");
  }
  if (record(document.data.animations) && Object.hasOwn(document.data.animations, newAnimation)) {
    throw new SpineError("ANIMATION_EXISTS", `Animation ${newAnimation} already exists.`);
  }
  const duration = inRange(recipe.duration, "duration", 0.1, 60);
  const operations: EditOperation[] = [{ kind: "upsert_animation", name: newAnimation }];
  const tracks: MotionTrack[] = [];
  const reviewHints: string[] = [];
  let slotKeys = 0;

  if (recipe.type === "idle") {
    requireBones(document, [recipe.bone]);
    const sway = inRange(recipe.swayDegrees ?? 3, "swayDegrees", 0, 45);
    const bob = inRange(recipe.bobDistance ?? 2, "bobDistance", 0, 1000);
    if (sway === 0 && bob === 0) throw new SpineError("EMPTY_MOTION", "Idle needs sway or bob motion.");
    if (sway) tracks.push(rotation(recipe.bone, duration, [0, 0.25, 0.5, 0.75, 1], [0, sway, 0, -sway, 0]));
    if (bob) tracks.push(translation(recipe.bone, duration, [0, 0.25, 0.5, 0.75, 1], [0, bob, 0, -bob * 0.25, 0]));
  } else if (recipe.type === "breathing") {
    requireBones(document, [recipe.bone]);
    const amount = inRange(recipe.amount ?? 0.04, "amount", 0.001, 0.5);
    tracks.push({ bone: recipe.bone, type: "scale", keys: timed(duration, [0, 0.5, 1],
      [{ x: 1, y: 1 }, { x: round(1 - amount * 0.3), y: round(1 + amount) }, { x: 1, y: 1 }]) });
  } else if (recipe.type === "blink") {
    const attachments = defaultAttachments(document, recipe.slot);
    if (!Object.hasOwn(attachments, recipe.openAttachment) || !Object.hasOwn(attachments, recipe.closedAttachment)
      || recipe.openAttachment === recipe.closedAttachment) {
      throw new SpineError("MOTION_ATTACHMENT_NOT_FOUND", "Blink needs distinct open and closed attachments in the default skin.");
    }
    const at = inRange(recipe.at ?? duration * 0.45, "at", 0.001, duration - 0.001);
    const hold = inRange(recipe.hold ?? duration * 0.08, "hold", 0.001, duration - at - 0.001);
    const keys = [{ time: 0, name: recipe.openAttachment }, { time: round(at), name: recipe.closedAttachment },
      { time: round(at + hold), name: recipe.openAttachment }, { time: round(duration), name: recipe.openAttachment }];
    if (keys.some((key, index) => index > 0 && key.time <= keys[index - 1].time)) {
      throw new SpineError("MOTION_TIME_CONFLICT", "Blink key times must be strictly increasing.");
    }
    for (const key of keys) operations.push({ kind: "set_keyframe", animation: newAnimation,
      selector: { section: "slots", target: recipe.slot, timelineType: "attachment" },
      time: key.time, values: { name: key.name } });
    slotKeys = keys.length;
    reviewHints.push("Choose the default skin or a compatible skin when previewing this blink.");
  } else if (recipe.type === "walk" || recipe.type === "run") {
    const names = [recipe.leftLeg, recipe.rightLeg, recipe.leftArm, recipe.rightArm, recipe.rootBone]
      .filter((name): name is string => name !== undefined);
    requireBones(document, names);
    if (Boolean(recipe.leftArm) !== Boolean(recipe.rightArm)) {
      throw new SpineError("INVALID_MOTION_BONES", "Provide both arm bones or neither arm bone.");
    }
    const stride = inRange(recipe.strideDegrees ?? (recipe.type === "walk" ? 25 : 45), "strideDegrees", 1, 90);
    const bob = inRange(recipe.bobDistance ?? (recipe.type === "walk" ? 2 : 5), "bobDistance", 0, 1000);
    const phase = [0, 0.25, 0.5, 0.75, 1];
    tracks.push(rotation(recipe.leftLeg, duration, phase, [stride, 0, -stride, 0, stride]));
    tracks.push(rotation(recipe.rightLeg, duration, phase, [-stride, 0, stride, 0, -stride]));
    if (recipe.leftArm && recipe.rightArm) {
      tracks.push(rotation(recipe.leftArm, duration, phase, [-stride * 0.5, 0, stride * 0.5, 0, -stride * 0.5]));
      tracks.push(rotation(recipe.rightArm, duration, phase, [stride * 0.5, 0, -stride * 0.5, 0, stride * 0.5]));
    }
    if (recipe.rootBone && bob) tracks.push(translation(recipe.rootBone, duration, phase, [0, bob, 0, bob, 0]));
    reviewHints.push("Check foot contact and sliding against the artwork; these recipes animate local bone rotation only.");
  } else if (recipe.type === "recoil") {
    requireBones(document, [recipe.bone]);
    const angle = inRange(recipe.angleDegrees ?? -25, "angleDegrees", -180, 180);
    if (angle === 0) throw new SpineError("EMPTY_MOTION", "Recoil angle must be nonzero.");
    tracks.push(rotation(recipe.bone, duration, [0, 0.12, 0.55, 1], [0, angle, -angle * 0.12, 0]));
  } else if (recipe.type === "follow_through") {
    requireBones(document, [recipe.primaryBone, recipe.secondaryBone]);
    const angle = inRange(recipe.angleDegrees ?? 20, "angleDegrees", -180, 180);
    if (angle === 0) throw new SpineError("EMPTY_MOTION", "Follow-through angle must be nonzero.");
    const lag = inRange(recipe.lag ?? 0.18, "lag", 0.01, 0.3);
    tracks.push(rotation(recipe.primaryBone, duration, [0, 0.25, 0.6, 1], [0, angle, 0, 0]));
    tracks.push(rotation(recipe.secondaryBone, duration, [0, 0.25 + lag, 0.6 + lag, 1],
      [0, angle * 0.6, 0, 0]));
    reviewHints.push("Review the secondary bone's timing and setup pose in a rendered preview.");
  } else {
    throw new SpineError("UNSUPPORTED_MOTION_RECIPE", "Unknown motion recipe.");
  }

  checkTracks(tracks);
  operations.push(...trackOperations(newAnimation, tracks));
  return { operations, summary: { recipe: recipe.type, newAnimation, duration,
    timelines: tracks.length + (slotKeys ? 1 : 0), keys: tracks.reduce((count, track) => count + track.keys.length, slotKeys),
    bones: tracks.map((track) => track.bone), reviewHints } };
}
