import type { SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { inspectAssets } from "./assets.js";
import { collectTimelines, keyTime, timelinePath } from "./timelines.js";
import { decodePreviewPng } from "./visual.js";

export interface AnimationHint {
  code: string;
  severity: "warning" | "review";
  path: string;
  message: string;
}

export interface PreviewAnalysisOptions {
  maxFrames?: number;
  alphaThreshold?: number;
  areaJumpRatio?: number;
  fixedCanvas?: boolean;
  edgeMargin?: number;
}

export interface FrameMetric {
  index: number;
  width: number;
  height: number;
  visiblePixels: number;
  visibleFraction: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
}

export async function analyzePreview(paths: string[], options: PreviewAnalysisOptions = {}) {
  if (paths.length === 0) throw new SpineError("PREVIEW_NOT_FOUND", "Preview has no frames to analyze.");
  const maxFrames = options.maxFrames ?? 24;
  const alphaThreshold = options.alphaThreshold ?? 16;
  const areaJumpRatio = options.areaJumpRatio ?? 2.5;
  const edgeMargin = options.edgeMargin ?? 1;
  if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 60) {
    throw new SpineError("INVALID_ANALYSIS", "maxFrames must be an integer from 1 to 60.");
  }
  if (!Number.isInteger(alphaThreshold) || alphaThreshold < 1 || alphaThreshold > 255) {
    throw new SpineError("INVALID_ANALYSIS", "alphaThreshold must be an integer from 1 to 255.");
  }
  if (!Number.isFinite(areaJumpRatio) || areaJumpRatio <= 1) {
    throw new SpineError("INVALID_ANALYSIS", "areaJumpRatio must be greater than 1.");
  }
  if (!Number.isInteger(edgeMargin) || edgeMargin < 0 || edgeMargin > 32) {
    throw new SpineError("INVALID_ANALYSIS", "edgeMargin must be an integer from 0 to 32.");
  }
  const count = Math.min(paths.length, maxFrames);
  const indices = Array.from({ length: count }, (_unused, sample) =>
    count === 1 ? 0 : Math.round(sample * (paths.length - 1) / (count - 1)));
  const frames: FrameMetric[] = [];
  const hints: AnimationHint[] = [];
  let totalPixels = 0;
  for (const index of indices) {
    const image = await decodePreviewPng(paths[index]);
    totalPixels += image.width * image.height;
    if (totalPixels > 100_000_000) {
      throw new SpineError("PREVIEW_TOO_LARGE", "Preview analysis exceeds the 100 million pixel work limit.");
    }
    if (options.fixedCanvas && frames.length > 0
      && (image.width !== frames[0].width || image.height !== frames[0].height)) {
      throw new SpineError("VARIABLE_CANVAS", "Edge checks require every analyzed frame to use the same canvas dimensions.");
    }
    let visiblePixels = 0;
    let left = image.width;
    let top = image.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        if (image.data[(y * image.width + x) * 4 + 3] < alphaThreshold) continue;
        visiblePixels += 1;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    const bounds = visiblePixels === 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
    frames.push({ index, width: image.width, height: image.height, visiblePixels,
      visibleFraction: Number((visiblePixels / (image.width * image.height)).toFixed(6)), bounds });
    if (!bounds) {
      hints.push({ code: "BLANK_FRAME", severity: "warning", path: `/frames/${index}`,
        message: "This rendered frame has no visible pixels above the alpha threshold." });
    } else if (options.fixedCanvas) {
      const sides = [
        left <= edgeMargin ? "left" : undefined,
        top <= edgeMargin ? "top" : undefined,
        right >= image.width - 1 - edgeMargin ? "right" : undefined,
        bottom >= image.height - 1 - edgeMargin ? "bottom" : undefined,
      ].filter((side): side is string => side !== undefined);
      if (sides.length > 0) hints.push({ code: "FRAME_EDGE_CONTACT", severity: "review", path: `/frames/${index}`,
        message: `Visible art touches the ${sides.join(", ")} canvas edge${sides.length === 1 ? "" : "s"}; check for clipping.` });
    }
    const previous = frames.at(-2);
    if (previous && previous.visiblePixels > 0 && visiblePixels > 0) {
      const adjacent = index === previous.index + 1;
      const ratio = Math.max(previous.visiblePixels, visiblePixels) / Math.min(previous.visiblePixels, visiblePixels);
      if (ratio >= areaJumpRatio) hints.push({ code: adjacent ? "VISIBLE_AREA_JUMP" : "VISIBLE_AREA_CHANGE",
        severity: "review", path: `/frames/${index}`,
        message: `Visible pixel count changed ${ratio.toFixed(2)}× from analyzed frame ${previous.index}; review for an attachment or camera change.` });
      if (options.fixedCanvas && previous.bounds && bounds) {
        const oldX = previous.bounds.x + previous.bounds.width / 2;
        const oldY = previous.bounds.y + previous.bounds.height / 2;
        const newX = bounds.x + bounds.width / 2;
        const newY = bounds.y + bounds.height / 2;
        const jump = Math.hypot(newX - oldX, newY - oldY) / Math.hypot(image.width, image.height);
        if (jump >= 0.25) hints.push({ code: adjacent ? "FRAME_POSITION_JUMP" : "FRAME_POSITION_CHANGE",
          severity: "review", path: `/frames/${index}`,
          message: `Visible center moved ${(jump * 100).toFixed(1)}% of the canvas diagonal from analyzed frame ${previous.index}.` });
      }
    }
  }
  return { frameCount: paths.length, sampledCount: frames.length, samplesTruncated: paths.length > frames.length,
    alphaThreshold, areaJumpRatio, fixedCanvas: options.fixedCanvas ?? false,
    checksPerformed: ["blank rendered frames", "visible area jumps", ...(options.fixedCanvas ? ["canvas edge contact", "position jumps"] : [])],
    frames, hints };
}

export async function checkAnimation(
  document: SpineDocument,
  animationName: string,
  options: { loop?: boolean; loopTolerance?: number; flashSeconds?: number; deformThreshold?: number; checkAssets?: boolean },
) {
  const animations = document.data.animations;
  if (!animations || typeof animations !== "object" || Array.isArray(animations) || !Object.hasOwn(animations, animationName)) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${animationName} was not found.`);
  }
  const timelines = collectTimelines(animationName, (animations as Record<string, unknown>)[animationName]);
  const hints: AnimationHint[] = [];
  const add = (code: string, severity: AnimationHint["severity"], path: string, message: string) => hints.push({ code, severity, path, message });
  let motionDuration = 0;
  let eventCount = 0;
  for (const timeline of timelines) {
    const times = timeline.keys.map((key, index) => keyTime(key, [...timeline.path, index]));
    if (timeline.section !== "events") motionDuration = Math.max(motionDuration, ...times, 0);
    else eventCount += timeline.keys.length;
    if (options.loop && timeline.keys.length > 1) {
      const first = timeline.keys[0];
      const last = timeline.keys.at(-1)!;
      const numericFields = Object.keys(first).filter((field) => field !== "time" && field !== "curve" && typeof first[field] === "number" && typeof last[field] === "number");
      for (const field of numericFields) {
        const delta = Math.abs((first[field] as number) - (last[field] as number));
        if (delta > (options.loopTolerance ?? 0.001)) {
          add("LOOP_DISCONTINUITY", "warning", timelinePath(timeline.path), `${field} differs by ${delta.toPrecision(4)} between the first and last keys.`);
        }
      }
      if (timeline.section === "slots" && timeline.type === "attachment" && first.name !== last.name) {
        add("LOOP_ATTACHMENT_MISMATCH", "warning", timelinePath(timeline.path), "The first and last attachment keys select different attachments.");
      }
    }
    if (timeline.section === "slots" && timeline.type === "attachment" && timeline.keys.length >= 3) {
      for (let index = 1; index < timeline.keys.length - 1; index += 1) {
        const previous = timeline.keys[index - 1].name;
        const current = timeline.keys[index].name;
        const next = timeline.keys[index + 1].name;
        if (previous === next && previous !== current && times[index + 1] - times[index] < (options.flashSeconds ?? 1 / 30)) {
          add("ATTACHMENT_FLASH", "warning", timelinePath([...timeline.path, index]), `Attachment ${String(current)} is shown briefly before returning to ${String(previous)}.`);
        }
      }
    }
    if ((timeline.section === "attachments" || timeline.section === "deform") && timeline.type === "deform") {
      timeline.keys.forEach((key, index) => {
        if (Array.isArray(key.vertices) && key.vertices.some((value) => typeof value === "number" && Math.abs(value) > (options.deformThreshold ?? 1000))) {
          add("EXTREME_DEFORM", "review", timelinePath([...timeline.path, index]), "Deform vertex offsets exceed the review threshold.");
        }
      });
    }
  }
  for (const timeline of timelines.filter((item) => item.section === "events")) {
    timeline.keys.forEach((key, index) => {
      const time = keyTime(key, [...timeline.path, index]);
      if (motionDuration > 0 && time > motionDuration) {
        add("EVENT_AFTER_MOTION", "review", timelinePath([...timeline.path, index]), `Event ${String(key.name)} occurs after the last motion key.`);
      }
    });
  }
  if (options.checkAssets) {
    const assets = await inspectAssets(document);
    for (const missing of assets.missing) {
      add("MISSING_IMAGE", "warning", `/assets/${missing.slot}/${missing.attachment}`, `Image ${missing.image} was not found.`);
    }
  }
  return {
    animation: animationName,
    motionDuration,
    eventCount,
    checksPerformed: ["loop endpoint values", "attachment flashes", "event timing", "large deform offsets", ...(options.checkAssets ? ["missing images"] : [])],
    checksUnavailable: ["off-canvas motion", "rendered mesh appearance", "foot sliding"],
    hints,
  };
}
