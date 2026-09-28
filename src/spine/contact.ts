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

export interface NamedContact {
  name: string;
  fromFrame: number;
  toFrame: number;
  target: { kind: "region"; x: number; y: number; width: number; height: number }
    | { kind: "point"; positions: { frame: number; x: number; y: number }[] };
  driftThresholdPixels?: number;
  groundY?: number;
  penetrationThresholdPixels?: number;
  minimumPenetratingPixels?: number;
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

function checkNamedContact(contact: NamedContact, frameCount: number): void {
  if (!contact.name.trim()) throw new SpineError("INVALID_CONTACT", "Contact name must be nonempty.");
  positiveInteger(contact.fromFrame, "fromFrame", 0, frameCount - 1);
  positiveInteger(contact.toFrame, "toFrame", contact.fromFrame, Math.min(frameCount - 1, contact.fromFrame + 59));
  if (contact.driftThresholdPixels === undefined && contact.groundY === undefined) {
    throw new SpineError("INVALID_CONTACT", "Enable driftThresholdPixels or provide groundY for a penetration check.");
  }
  if (contact.driftThresholdPixels !== undefined
    && (!Number.isFinite(contact.driftThresholdPixels) || contact.driftThresholdPixels <= 0)) {
    throw new SpineError("INVALID_CONTACT", "driftThresholdPixels must be positive.");
  }
  if (contact.groundY !== undefined && (!Number.isFinite(contact.groundY) || contact.groundY < 0 || contact.groundY > 1)) {
    throw new SpineError("INVALID_CONTACT", "groundY must be a normalized frame coordinate from 0 to 1.");
  }
  if (contact.penetrationThresholdPixels !== undefined
    && (contact.groundY === undefined || !Number.isFinite(contact.penetrationThresholdPixels)
      || contact.penetrationThresholdPixels < 0)) {
    throw new SpineError("INVALID_CONTACT", "penetrationThresholdPixels requires groundY and must be nonnegative.");
  }
  if (contact.minimumPenetratingPixels !== undefined
    && (contact.target.kind !== "region" || contact.groundY === undefined
      || !Number.isInteger(contact.minimumPenetratingPixels)
      || contact.minimumPenetratingPixels < 1 || contact.minimumPenetratingPixels > 10000)) {
    throw new SpineError("INVALID_CONTACT", "minimumPenetratingPixels requires a region and groundY and must be 1–10000.");
  }
  if (contact.target.kind === "region") {
    const { x, y, width, height } = contact.target;
    if (![x, y, width, height].every(Number.isFinite)
      || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
      throw new SpineError("INVALID_CONTACT", "Contact region bounds must be positive normalized coordinates inside the frame.");
    }
  } else {
    const positions = contact.target.positions;
    if (!positions.length || positions.length > 60 || new Set(positions.map((position) => position.frame)).size !== positions.length) {
      throw new SpineError("INVALID_CONTACT", "A point contact needs 1–60 positions with distinct frame numbers.");
    }
    for (const position of positions) {
      if (!Number.isInteger(position.frame) || position.frame < contact.fromFrame || position.frame > contact.toFrame
        || !Number.isFinite(position.x) || !Number.isFinite(position.y)
        || position.x < 0 || position.x > 1 || position.y < 0 || position.y > 1) {
        throw new SpineError("INVALID_CONTACT", "Point positions must use frames in the contact interval and normalized frame coordinates.");
      }
    }
  }
}

export async function analyzeContacts(paths: string[], contacts: NamedContact[], options: ContactOptions = {}) {
  if (!paths.length) throw new SpineError("PREVIEW_NOT_FOUND", "Contact analysis needs rendered preview frames.");
  if (contacts.length < 1 || contacts.length > 8
    || new Set(contacts.map((contact) => contact.name)).size !== contacts.length) {
    throw new SpineError("INVALID_CONTACT", "Provide 1–8 distinctly named contacts.");
  }
  const alphaThreshold = options.alphaThreshold ?? 16;
  const minimumVisiblePixels = options.minimumVisiblePixels ?? 4;
  positiveInteger(alphaThreshold, "alphaThreshold", 1, 255);
  positiveInteger(minimumVisiblePixels, "minimumVisiblePixels", 1, 10000);
  contacts.forEach((contact) => checkNamedContact(contact, paths.length));

  const hints: AnimationHint[] = [];
  const results = [];
  let dimensions: { width: number; height: number } | undefined;
  let workPixels = 0;
  let decodedPixels = 0;
  for (const contact of contacts) {
    const samples: { frame: number; x: number; y: number; visiblePixels?: number;
      penetrationPixels?: number; penetratingPixels?: number }[] = [];
    const missingFrames: number[] = [];
    const positions = contact.target.kind === "point"
      ? new Map(contact.target.positions.map((position) => [position.frame, position])) : undefined;
    const penetrationThresholdPixels = contact.penetrationThresholdPixels ?? 0;
    const minimumPenetratingPixels = contact.minimumPenetratingPixels ?? 1;
    let maxPenetrationPixels = 0;
    let maxFlaggedPenetrationPixels = 0;
    let worstPenetrationFrame: number | null = null;
    let penetrationFrameCount = 0;
    for (let frame = contact.fromFrame; frame <= contact.toFrame; frame += 1) {
      const image = await decodePreviewPng(paths[frame]);
      decodedPixels += image.width * image.height;
      if (decodedPixels > 100_000_000) {
        throw new SpineError("PREVIEW_TOO_LARGE", "Contact analysis exceeds the 100 million decoded pixel limit.");
      }
      if (dimensions && (image.width !== dimensions.width || image.height !== dimensions.height)) {
        throw new SpineError("VARIABLE_CANVAS", "Contact checks require a fixed-size preview canvas.");
      }
      dimensions = { width: image.width, height: image.height };
      const groundPixels = contact.groundY === undefined ? undefined : contact.groundY * image.height;
      let x = 0;
      let y = 0;
      let visiblePixels: number | undefined;
      let penetrationPixels = 0;
      let penetratingPixels = 0;
      if (contact.target.kind === "point") {
        const position = positions!.get(frame);
        if (!position) { missingFrames.push(frame); continue; }
        x = position.x * image.width;
        y = position.y * image.height;
        if (groundPixels !== undefined) {
          penetrationPixels = Math.max(0, y - groundPixels);
          penetratingPixels = penetrationPixels > penetrationThresholdPixels ? 1 : 0;
        }
      } else {
        const target = contact.target;
        const left = Math.floor(target.x * image.width);
        const top = Math.floor(target.y * image.height);
        const right = Math.min(image.width, Math.ceil((target.x + target.width) * image.width));
        const bottom = Math.min(image.height, Math.ceil((target.y + target.height) * image.height));
        if (right <= left || bottom <= top) {
          throw new SpineError("INVALID_CONTACT", "Contact region covers no pixels at the preview resolution.");
        }
        workPixels += (right - left) * (bottom - top);
        if (workPixels > 100_000_000) {
          throw new SpineError("PREVIEW_TOO_LARGE", "Contact analysis exceeds the 100 million pixel work limit.");
        }
        let xSum = 0;
        let ySum = 0;
        visiblePixels = 0;
        for (let row = top; row < bottom; row += 1) {
          for (let column = left; column < right; column += 1) {
            if (image.data[(row * image.width + column) * 4 + 3] < alphaThreshold) continue;
            visiblePixels += 1;
            xSum += column + 0.5;
            ySum += row + 0.5;
            if (groundPixels !== undefined) {
              const depth = Math.max(0, row + 0.5 - groundPixels);
              penetrationPixels = Math.max(penetrationPixels, depth);
              if (depth > penetrationThresholdPixels) penetratingPixels += 1;
            }
          }
        }
        if (visiblePixels < minimumVisiblePixels) { missingFrames.push(frame); continue; }
        x = xSum / visiblePixels;
        y = ySum / visiblePixels;
      }
      samples.push({ frame, x, y, ...(visiblePixels === undefined ? {} : { visiblePixels }),
        ...(groundPixels === undefined ? {} : {
          penetrationPixels: Number(penetrationPixels.toFixed(3)), penetratingPixels }) });
      if (penetrationPixels > maxPenetrationPixels) {
        maxPenetrationPixels = penetrationPixels;
        worstPenetrationFrame = frame;
      }
      if (groundPixels !== undefined && penetratingPixels >= minimumPenetratingPixels) {
        penetrationFrameCount += 1;
        maxFlaggedPenetrationPixels = Math.max(maxFlaggedPenetrationPixels, penetrationPixels);
      }
    }
    const first = samples[0];
    let maxDriftPixels = 0;
    let traveledPixels = 0;
    for (const [index, sample] of samples.entries()) {
      if (first) maxDriftPixels = Math.max(maxDriftPixels, Math.abs(sample.x - first.x));
      if (index > 0) traveledPixels += Math.abs(sample.x - samples[index - 1].x);
    }
    const hintPath = `/contacts/${contact.name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (missingFrames.length) hints.push({ code: "CONTACT_SAMPLE_MISSING", severity: "review", path: hintPath,
      message: `${missingFrames.length} frame(s) have no usable ${contact.target.kind} sample.` });
    if (contact.driftThresholdPixels !== undefined && samples.length >= 2
      && maxDriftPixels > contact.driftThresholdPixels) {
      hints.push({ code: "CONTACT_DRIFT", severity: "review", path: hintPath,
        message: `${contact.name} moved ${maxDriftPixels.toFixed(1)} px along the ground during the selected contact interval.` });
    }
    if (contact.groundY !== undefined && penetrationFrameCount > 0) {
      hints.push({ code: "GROUND_PENETRATION", severity: "review", path: hintPath,
        message: `${contact.name} extended ${maxFlaggedPenetrationPixels.toFixed(1)} px below the ground line; ${penetrationFrameCount} frame(s) exceeded the tolerance.` });
    }
    results.push({ name: contact.name, fromFrame: contact.fromFrame, toFrame: contact.toFrame,
      target: contact.target.kind === "region" ? contact.target : { kind: "point" },
      ...(contact.driftThresholdPixels === undefined ? {} : { driftThresholdPixels: contact.driftThresholdPixels }),
      ...(contact.groundY === undefined ? {} : { groundY: contact.groundY,
        penetrationThresholdPixels, minimumPenetratingPixels: contact.target.kind === "region" ? minimumPenetratingPixels : undefined }),
      sampledFrames: samples.length, missingFrames, samples,
      ...(contact.driftThresholdPixels === undefined ? {} : {
        maxDriftPixels: Number(maxDriftPixels.toFixed(3)), traveledPixels: Number(traveledPixels.toFixed(3)) }),
      ...(contact.groundY === undefined ? {} : { maxPenetrationPixels: Number(maxPenetrationPixels.toFixed(3)),
        worstPenetrationFrame, penetrationFrameCount }) });
  }
  return { frameCount: paths.length, alphaThreshold, minimumVisiblePixels, contacts: results, hints };
}
