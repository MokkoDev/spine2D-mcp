import { SpineError } from "./errors.js";
import type { AnimationHint } from "./quality.js";
import { decodePreviewPng } from "./visual.js";

export interface ContactRegion {
  name: string;
  fromFrame: number;
  toFrame: number;
  x: number;
  y: number;
  width: number;
  height: number;
  driftThresholdPixels: number;
}
export interface ContactOptions {
  alphaThreshold?: number;
  minimumVisiblePixels?: number;
}

function positiveInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SpineError("INVALID_CONTACT_REGION", `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
}
function checkRegion(region: ContactRegion, frameCount: number): void {
  if (!region.name.trim()) throw new SpineError("INVALID_CONTACT_REGION", "Contact region name must be nonempty.");
  positiveInteger(region.fromFrame, "fromFrame", 0, frameCount - 1);
  positiveInteger(region.toFrame, "toFrame", region.fromFrame + 1, Math.min(frameCount - 1, region.fromFrame + 59));
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite)
    || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
    || region.x + region.width > 1 || region.y + region.height > 1) {
    throw new SpineError("INVALID_CONTACT_REGION", "Contact bounds must be positive normalized coordinates inside the frame.");
  }
  if (!Number.isFinite(region.driftThresholdPixels) || region.driftThresholdPixels <= 0) {
    throw new SpineError("INVALID_CONTACT_REGION", "driftThresholdPixels must be positive.");
  }
}

export async function analyzeFootContacts(paths: string[], regions: ContactRegion[], options: ContactOptions = {}) {
  if (!paths.length) throw new SpineError("PREVIEW_NOT_FOUND", "Contact analysis needs rendered preview frames.");
  if (regions.length < 1 || regions.length > 8 || new Set(regions.map((region) => region.name)).size !== regions.length) {
    throw new SpineError("INVALID_CONTACT_REGION", "Provide 1–8 distinctly named contact regions.");
  }
  const alphaThreshold = options.alphaThreshold ?? 16;
  const minimumVisiblePixels = options.minimumVisiblePixels ?? 4;
  positiveInteger(alphaThreshold, "alphaThreshold", 1, 255);
  positiveInteger(minimumVisiblePixels, "minimumVisiblePixels", 1, 10000);
  regions.forEach((region) => checkRegion(region, paths.length));
  const hints: AnimationHint[] = [];
  const results = [];
  let workPixels = 0;
  for (const region of regions) {
    let dimensions: { width: number; height: number } | undefined;
    const centers: { frame: number; x: number; y: number; visiblePixels: number }[] = [];
    const missingFrames: number[] = [];
    for (let frame = region.fromFrame; frame <= region.toFrame; frame += 1) {
      const image = await decodePreviewPng(paths[frame]);
      if (dimensions && (image.width !== dimensions.width || image.height !== dimensions.height)) {
        throw new SpineError("VARIABLE_CANVAS", "Foot contact checks require a fixed-size preview canvas.");
      }
      dimensions = { width: image.width, height: image.height };
      const left = Math.floor(region.x * image.width);
      const top = Math.floor(region.y * image.height);
      const right = Math.min(image.width, Math.ceil((region.x + region.width) * image.width));
      const bottom = Math.min(image.height, Math.ceil((region.y + region.height) * image.height));
      if (right <= left || bottom <= top) {
        throw new SpineError("INVALID_CONTACT_REGION", "Contact bounds cover no pixels at the preview resolution.");
      }
      workPixels += (right - left) * (bottom - top);
      if (workPixels > 100_000_000) {
        throw new SpineError("PREVIEW_TOO_LARGE", "Contact analysis exceeds the 100 million pixel work limit.");
      }
      let visiblePixels = 0;
      let xSum = 0;
      let ySum = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          if (image.data[(y * image.width + x) * 4 + 3] < alphaThreshold) continue;
          visiblePixels += 1;
          xSum += x + 0.5;
          ySum += y + 0.5;
        }
      }
      if (visiblePixels < minimumVisiblePixels) missingFrames.push(frame);
      else centers.push({ frame, x: xSum / visiblePixels, y: ySum / visiblePixels, visiblePixels });
    }
    const first = centers[0];
    let maxDriftPixels = 0;
    let traveledPixels = 0;
    for (const [index, center] of centers.entries()) {
      if (first) maxDriftPixels = Math.max(maxDriftPixels, Math.hypot(center.x - first.x, center.y - first.y));
      if (index > 0) traveledPixels += Math.hypot(center.x - centers[index - 1].x, center.y - centers[index - 1].y);
    }
    if (missingFrames.length) hints.push({ code: "CONTACT_REGION_EMPTY", severity: "review",
      path: `/contacts/${region.name}`, message: `${missingFrames.length} contact frame(s) have too few visible pixels in the selected region.` });
    if (centers.length >= 2 && maxDriftPixels > region.driftThresholdPixels) {
      hints.push({ code: "POSSIBLE_FOOT_SLIDE", severity: "review", path: `/contacts/${region.name}`,
        message: `Visible foot center moved ${maxDriftPixels.toFixed(1)} px during the selected contact interval.` });
    }
    results.push({ name: region.name, fromFrame: region.fromFrame, toFrame: region.toFrame,
      bounds: { x: region.x, y: region.y, width: region.width, height: region.height },
      driftThresholdPixels: region.driftThresholdPixels, sampledFrames: centers.length,
      missingFrames, maxDriftPixels: Number(maxDriftPixels.toFixed(3)),
      traveledPixels: Number(traveledPixels.toFixed(3)), centers });
  }
  return { frameCount: paths.length, alphaThreshold, minimumVisiblePixels, contacts: results, hints };
}
