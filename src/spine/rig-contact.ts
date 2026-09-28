import * as spine42 from "spine-core-42";
import * as spine43 from "spine-core-43";

import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import type { AnimationHint } from "./quality.js";

type Point = { x: number; y: number };
type RigTarget = { kind: "bonePoint"; bone: string; x: number; y: number }
  | { kind: "attachmentShape"; slot: string; attachment: string; vertexIndices?: number[] };

export interface RigContact {
  name: string;
  mode: "plant" | "touch" | "roll";
  fromFrame: number;
  toFrame: number;
  target: RigTarget;
  surface: { point: Point; normal: Point };
  slipThreshold?: number;
  penetrationThreshold?: number;
  rollingRadius?: number;
}

export interface RigPreviewTiming {
  fps: number;
  frameStart: number;
  frameCount: number;
  skin?: string;
}

type Runtime = { version: "4.2" | "4.3"; skeleton: any; state: any; physics: any };

function fakeRegion42(): spine42.TextureRegion {
  const region = new spine42.TextureRegion();
  region.width = region.height = region.originalWidth = region.originalHeight = 1;
  region.u2 = region.v2 = 1;
  return region;
}

function loader42(): spine42.AttachmentLoader {
  return {
    newRegionAttachment: (_skin, name, path) => {
      const attachment = new spine42.RegionAttachment(name, path);
      attachment.region = fakeRegion42();
      return attachment;
    },
    newMeshAttachment: (_skin, name, path) => {
      const attachment = new spine42.MeshAttachment(name, path);
      attachment.region = fakeRegion42();
      return attachment;
    },
    newBoundingBoxAttachment: (_skin, name) => new spine42.BoundingBoxAttachment(name),
    newPathAttachment: (_skin, name) => new spine42.PathAttachment(name),
    newPointAttachment: (_skin, name) => new spine42.PointAttachment(name),
    newClippingAttachment: (_skin, name) => new spine42.ClippingAttachment(name),
  };
}

function fakeRegion43(): spine43.TextureRegion {
  const region = new spine43.TextureRegion();
  region.width = region.height = region.originalWidth = region.originalHeight = 1;
  region.u2 = region.v2 = 1;
  return region;
}

function fillSequence43(sequence: spine43.Sequence): void {
  for (let index = 0; index < sequence.regions.length; index += 1) sequence.regions[index] = fakeRegion43();
}

function loader43(): spine43.AttachmentLoader {
  return {
    newRegionAttachment: (_skin, _placeholder, name, _path, sequence) => {
      fillSequence43(sequence);
      return new spine43.RegionAttachment(name, sequence);
    },
    newMeshAttachment: (_skin, _placeholder, name, _path, sequence) => {
      fillSequence43(sequence);
      return new spine43.MeshAttachment(name, sequence);
    },
    newBoundingBoxAttachment: (_skin, _placeholder, name) => new spine43.BoundingBoxAttachment(name),
    newPathAttachment: (_skin, _placeholder, name) => new spine43.PathAttachment(name),
    newPointAttachment: (_skin, _placeholder, name) => new spine43.PointAttachment(name),
    newClippingAttachment: (_skin, _placeholder, name) => new spine43.ClippingAttachment(name),
  };
}

function runtimeData42(source: Record<string, unknown>): Record<string, unknown> {
  const data = structuredClone(source);
  const animations = data.animations as Record<string, any> | undefined;
  for (const animation of Object.values(animations ?? {})) {
    if (!animation.deform) continue;
    animation.attachments ??= {};
    for (const [skin, slots] of Object.entries(animation.deform as Record<string, any>)) {
      animation.attachments[skin] ??= {};
      for (const [slot, attachments] of Object.entries(slots as Record<string, any>)) {
        animation.attachments[skin][slot] ??= {};
        for (const [name, keys] of Object.entries(attachments as Record<string, any>)) {
          animation.attachments[skin][slot][name] ??= {};
          animation.attachments[skin][slot][name].deform = keys;
        }
      }
    }
    delete animation.deform;
  }
  return data;
}

function loadRuntime(document: SpineDocument, animation: string, skin?: string): Runtime {
  const version = document.version.startsWith("4.2") ? "4.2"
    : document.version.startsWith("4.3") ? "4.3" : undefined;
  if (!version) throw new SpineError("UNSUPPORTED_VERSION", "Rig contact checks support Spine 4.2 and 4.3 JSON exports.");
  try {
    if (version === "4.2") {
      const data = new spine42.SkeletonJson(loader42()).readSkeletonData(runtimeData42(document.data));
      const skeleton = new spine42.Skeleton(data);
      if (skin) { skeleton.setSkinByName(skin); skeleton.setSlotsToSetupPose(); }
      const state = new spine42.AnimationState(new spine42.AnimationStateData(data));
      state.setAnimation(0, animation, false);
      return { version, skeleton, state, physics: spine42.Physics.update };
    }
    const data = new spine43.SkeletonJson(loader43()).readSkeletonData(document.data);
    const skeleton = new spine43.Skeleton(data);
    if (skin) { skeleton.setSkin(skin); skeleton.setupPoseSlots(); }
    const state = new spine43.AnimationState(new spine43.AnimationStateData(data));
    state.setAnimation(0, animation, false);
    return { version, skeleton, state, physics: spine43.Physics.update };
  } catch (error) {
    throw new SpineError("RIG_CONTACT_RUNTIME_ERROR", `The Spine runtime could not load the rig: ${String(error)}`);
  }
}

function finitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function checkContacts(contacts: RigContact[], timing: RigPreviewTiming): void {
  if (!Number.isFinite(timing.fps) || timing.fps <= 0 || !Number.isInteger(timing.frameStart)
    || timing.frameStart < 0 || !Number.isInteger(timing.frameCount) || timing.frameCount < 1) {
    throw new SpineError("PREVIEW_TIMING_UNAVAILABLE", "Rig contacts require a preview with valid FPS and frame range metadata.");
  }
  if (contacts.length < 1 || contacts.length > 8
    || new Set(contacts.map((contact) => contact.name)).size !== contacts.length) {
    throw new SpineError("INVALID_RIG_CONTACT", "Provide 1–8 distinctly named rig contacts.");
  }
  for (const contact of contacts) {
    if (!contact.name.trim() || !Number.isInteger(contact.fromFrame) || !Number.isInteger(contact.toFrame)
      || contact.fromFrame < 0 || contact.toFrame < contact.fromFrame
      || contact.toFrame >= timing.frameCount || contact.toFrame - contact.fromFrame >= 60) {
      throw new SpineError("INVALID_RIG_CONTACT", "Contact names must be nonempty and frame intervals must contain 1–60 preview frames.");
    }
    if (!finitePoint(contact.surface.point) || !finitePoint(contact.surface.normal)
      || Math.hypot(contact.surface.normal.x, contact.surface.normal.y) < 1e-9) {
      throw new SpineError("INVALID_RIG_CONTACT", "The surface needs a finite point and a nonzero normal toward free space.");
    }
    if (contact.penetrationThreshold !== undefined
      && (!Number.isFinite(contact.penetrationThreshold) || contact.penetrationThreshold < 0)) {
      throw new SpineError("INVALID_RIG_CONTACT", "penetrationThreshold must be nonnegative Spine units.");
    }
    if (contact.mode === "touch") {
      if (contact.slipThreshold !== undefined || contact.rollingRadius !== undefined) {
        throw new SpineError("INVALID_RIG_CONTACT", "Touch contacts check penetration only.");
      }
    } else if (!Number.isFinite(contact.slipThreshold) || contact.slipThreshold! < 0) {
      throw new SpineError("INVALID_RIG_CONTACT", "Plant and roll contacts need a nonnegative slipThreshold in Spine units.");
    }
    if (contact.mode === "roll") {
      if (contact.target.kind !== "bonePoint" || !Number.isFinite(contact.rollingRadius)
        || contact.rollingRadius! <= 0) {
        throw new SpineError("INVALID_RIG_CONTACT", "Roll contacts need a bone point at the wheel center and a positive rollingRadius.");
      }
    } else if (contact.rollingRadius !== undefined) {
      throw new SpineError("INVALID_RIG_CONTACT", "rollingRadius is only used for roll contacts.");
    }
    if (contact.target.kind === "bonePoint") {
      if (!contact.target.bone || !Number.isFinite(contact.target.x) || !Number.isFinite(contact.target.y)) {
        throw new SpineError("INVALID_RIG_CONTACT", "Bone points need a bone name and finite local coordinates.");
      }
    } else {
      if (!contact.target.slot || !contact.target.attachment
        || (contact.target.vertexIndices !== undefined
          && (!contact.target.vertexIndices.length || contact.target.vertexIndices.length > 256
            || new Set(contact.target.vertexIndices).size !== contact.target.vertexIndices.length
            || contact.target.vertexIndices.some((index) => !Number.isInteger(index) || index < 0)))) {
        throw new SpineError("INVALID_RIG_CONTACT", "Attachment shapes need a slot, attachment, and optional distinct vertex indices.");
      }
    }
  }
}

function attachmentVertices(runtime: Runtime, slot: any, attachment: any): Point[] {
  let values: number[];
  if (runtime.version === "4.2") {
    if (attachment instanceof spine42.RegionAttachment) {
      values = new Array(8);
      attachment.computeWorldVertices(slot, values, 0, 2);
    } else if (attachment instanceof spine42.MeshAttachment) {
      if (attachment.worldVerticesLength > 20_000) throw new SpineError("RIG_CONTACT_TOO_LARGE", "An attachment exceeds 10000 vertices.");
      values = new Array(attachment.worldVerticesLength);
      attachment.computeWorldVertices(slot, 0, values.length, values, 0, 2);
    } else throw new SpineError("UNSUPPORTED_CONTACT_ATTACHMENT", "Attachment contacts require a region or mesh attachment.");
  } else if (attachment instanceof spine43.RegionAttachment) {
    values = new Array(8);
    attachment.computeWorldVertices(slot, attachment.getOffsets(slot.appliedPose), values, 0, 2);
  } else if (attachment instanceof spine43.MeshAttachment) {
    if (attachment.worldVerticesLength > 20_000) throw new SpineError("RIG_CONTACT_TOO_LARGE", "An attachment exceeds 10000 vertices.");
    values = new Array(attachment.worldVerticesLength);
    attachment.computeWorldVertices(runtime.skeleton, slot, 0, values.length, values, 0, 2);
  } else throw new SpineError("UNSUPPORTED_CONTACT_ATTACHMENT", "Attachment contacts require a region or mesh attachment.");
  const points: Point[] = [];
  for (let index = 0; index < values.length; index += 2) points.push({ x: values[index], y: values[index + 1] });
  return points;
}

function readTarget(runtime: Runtime, contact: RigContact): { points: Point[]; angle?: number } | undefined {
  const target = contact.target;
  if (target.kind === "bonePoint") {
    const bone = runtime.skeleton.findBone(target.bone);
    if (!bone) throw new SpineError("RIG_CONTACT_TARGET_NOT_FOUND", `Bone ${target.bone} was not found.`);
    const pose = runtime.version === "4.3" ? bone.appliedPose : bone;
    return { points: [{ x: pose.a * target.x + pose.b * target.y + pose.worldX,
      y: pose.c * target.x + pose.d * target.y + pose.worldY }],
    angle: Math.atan2(pose.c, pose.a) };
  }
  const slot = runtime.skeleton.findSlot(target.slot);
  if (!slot) throw new SpineError("RIG_CONTACT_TARGET_NOT_FOUND", `Slot ${target.slot} was not found.`);
  const expected = runtime.skeleton.getAttachment(slot.data.index, target.attachment);
  if (!expected) throw new SpineError("RIG_CONTACT_TARGET_NOT_FOUND", `Attachment ${target.attachment} was not found in slot ${target.slot}.`);
  const active = runtime.version === "4.3" ? slot.appliedPose.getAttachment() : slot.getAttachment();
  if (active !== expected) return undefined;
  const vertices = attachmentVertices(runtime, slot, active);
  const indices = target.vertexIndices ?? vertices.map((_point, index) => index);
  if (indices.some((index) => index >= vertices.length)) {
    throw new SpineError("INVALID_RIG_CONTACT", `A vertex index is outside attachment ${target.attachment}.`);
  }
  return { points: indices.map((index) => vertices[index]) };
}

function round(value: number): number { return Number(value.toFixed(6)); }
function pointer(name: string): string { return `/rigContacts/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`; }

export function analyzeRigContacts(document: SpineDocument, animation: string,
  timing: RigPreviewTiming, contacts: RigContact[]) {
  checkContacts(contacts, timing);
  const skins = document.data.skins;
  const skinCount = Array.isArray(skins) ? skins.length
    : skins && typeof skins === "object" ? Object.keys(skins).length : 0;
  if (!timing.skin && skinCount > 1) {
    throw new SpineError("PREVIEW_SKIN_UNAVAILABLE",
      "Rig contacts need a preview rendered with an explicit skin when the JSON contains multiple skins.");
  }
  const runtime = loadRuntime(document, animation, timing.skin);
  const samples = contacts.map(() => [] as { frame: number; time: number; x: number; y: number;
    penetration: number; tangent: number; vertexCount: number; angle?: number; slip?: number }[]);
  const missing = contacts.map(() => [] as number[]);
  const normals = contacts.map((contact) => {
    const length = Math.hypot(contact.surface.normal.x, contact.surface.normal.y);
    return { x: contact.surface.normal.x / length, y: contact.surface.normal.y / length };
  });
  const lastFrame = Math.max(...contacts.map((contact) => contact.toFrame));
  const lastStep = timing.frameStart + lastFrame;
  if (lastStep > 10000) throw new SpineError("RIG_CONTACT_TOO_LARGE", "Rig contact sampling exceeds 10000 animation steps.");
  try {
    for (let step = 0; step <= lastStep; step += 1) {
      if (step > 0) {
        runtime.skeleton.update(1 / timing.fps);
        runtime.state.update(1 / timing.fps);
      }
      runtime.state.apply(runtime.skeleton);
      runtime.skeleton.updateWorldTransform(runtime.physics);
      const frame = step - timing.frameStart;
      if (frame < 0) continue;
      for (const [index, contact] of contacts.entries()) {
        if (frame < contact.fromFrame || frame > contact.toFrame) continue;
        const target = readTarget(runtime, contact);
        if (!target) { missing[index].push(frame); continue; }
        const normal = normals[index];
        const tangent = { x: -normal.y, y: normal.x };
        const center = { x: target.points.reduce((sum, point) => sum + point.x, 0) / target.points.length,
          y: target.points.reduce((sum, point) => sum + point.y, 0) / target.points.length };
        const minDistance = Math.min(...target.points.map((point) =>
          (point.x - contact.surface.point.x) * normal.x + (point.y - contact.surface.point.y) * normal.y));
        const penetration = Math.max(0, contact.mode === "roll"
          ? contact.rollingRadius! - minDistance : -minDistance);
        const tangentPosition = (center.x - contact.surface.point.x) * tangent.x
          + (center.y - contact.surface.point.y) * tangent.y;
        samples[index].push({ frame, time: step / timing.fps, x: round(center.x), y: round(center.y),
          penetration: round(penetration), tangent: round(tangentPosition), vertexCount: target.points.length,
          ...(contact.mode === "roll" ? { angle: target.angle } : {}) });
      }
    }
  } catch (error) {
    if (error instanceof SpineError) throw error;
    throw new SpineError("RIG_CONTACT_RUNTIME_ERROR", `The Spine runtime could not sample the animation: ${String(error)}`);
  }

  const hints: AnimationHint[] = [];
  const results = contacts.map((contact, index) => {
    const entries = samples[index];
    const first = entries[0];
    let maxSlip = 0;
    let maxPenetration = 0;
    let worstPenetrationFrame: number | null = null;
    let cumulativeAngle = 0;
    let previousAngle = first?.angle;
    for (const entry of entries) {
      if (entry.penetration > maxPenetration) {
        maxPenetration = entry.penetration;
        worstPenetrationFrame = entry.frame;
      }
      if (contact.mode === "roll" && first && entry.angle !== undefined && previousAngle !== undefined) {
        let delta = entry.angle - previousAngle;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        cumulativeAngle += delta;
        previousAngle = entry.angle;
        entry.slip = round(entry.tangent - first.tangent - contact.rollingRadius! * cumulativeAngle);
        maxSlip = Math.max(maxSlip, Math.abs(entry.slip));
      } else if (contact.mode === "plant" && first) {
        entry.slip = round(entry.tangent - first.tangent);
        maxSlip = Math.max(maxSlip, Math.abs(entry.slip));
      }
    }
    if (missing[index].length) hints.push({ code: "RIG_CONTACT_MISSING", severity: "review", path: pointer(contact.name),
      message: `${contact.name} was unavailable in ${missing[index].length} contact frame(s).` });
    if (maxPenetration > (contact.penetrationThreshold ?? 0)) {
      hints.push({ code: "SURFACE_PENETRATION", severity: "review", path: pointer(contact.name),
        message: `${contact.name} penetrated the surface by ${maxPenetration.toFixed(3)} Spine units at frame ${worstPenetrationFrame}.` });
    }
    if (contact.mode !== "touch" && entries.length >= 2 && maxSlip > contact.slipThreshold!) {
      hints.push({ code: contact.mode === "roll" ? "ROLL_SLIP" : "CONTACT_SLIDE",
        severity: "review", path: pointer(contact.name),
        message: `${contact.name} ${contact.mode === "roll" ? "rolling residual" : "moved"} ${maxSlip.toFixed(3)} Spine units along the surface.` });
    }
    return { name: contact.name, mode: contact.mode, basis: "rig-geometry", target: contact.target,
      surface: { point: contact.surface.point, normal: normals[index] },
      fromFrame: contact.fromFrame, toFrame: contact.toFrame,
      slipThreshold: contact.slipThreshold, penetrationThreshold: contact.penetrationThreshold ?? 0,
      rollingRadius: contact.rollingRadius, sampledFrames: entries.length, missingFrames: missing[index],
      maxPenetration: round(maxPenetration), worstPenetrationFrame,
      ...(contact.mode === "touch" ? {} : { maxSlip: round(maxSlip) }), samples: entries };
  });
  return { frameCount: timing.frameCount, fps: timing.fps, frameStart: timing.frameStart,
    units: "Spine", contacts: results, hints };
}
