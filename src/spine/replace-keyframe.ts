import type { KeyChange } from "./bulk.js";
import { setCurveText, type CurveMode, type SetCurveOperation } from "./curve.js";
import { parseDocument, type SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { setKeyframeText } from "./keyframe.js";
import { collectTimelines, keyTime } from "./timelines.js";

export interface ReplaceKeyframeOperation {
  kind: "replace_keyframe";
  animation: string;
  bone: string;
  timelineType: SetCurveOperation["timelineType"];
  time: number;
  values: Record<string, unknown>;
  easing: CurveMode;
  controls?: SetCurveOperation["controls"];
}

export interface ReplaceKeyframeSummary {
  kind: "replace_keyframe";
  animation: string;
  bone: string;
  timelineType: ReplaceKeyframeOperation["timelineType"];
  time: number;
  nextTime: number;
  easing: CurveMode;
  channels: number;
  incomingCurveReset: boolean;
  outgoingEasingChanged: boolean;
  changed: boolean;
}

export function replaceKeyframeText(document: SpineDocument, operation: ReplaceKeyframeOperation):
  { text: string; changes: KeyChange[]; summary: ReplaceKeyframeSummary } {
  const animations = document.data.animations as Record<string, unknown> | undefined;
  if (!animations || !Object.hasOwn(animations, operation.animation)) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${operation.animation} was not found.`);
  }
  const timeline = collectTimelines(operation.animation, animations[operation.animation]).find((item) =>
    item.section === "bones" && item.target === operation.bone && item.type === operation.timelineType);
  if (!timeline) throw new SpineError("TIMELINE_NOT_FOUND", `Bone ${operation.bone} has no ${operation.timelineType} timeline in ${operation.animation}.`);
  const matches = timeline.keys.flatMap((key, index) =>
    keyTime(key, [...timeline.path, index]) === operation.time ? [index] : []);
  if (matches.length === 0) throw new SpineError("KEY_NOT_FOUND", `No ${operation.timelineType} key exists at time ${operation.time}.`);
  if (matches.length > 1) throw new SpineError("AMBIGUOUS_KEY", `Multiple ${operation.timelineType} keys exist at time ${operation.time}.`);
  if (matches[0] === timeline.keys.length - 1) throw new SpineError("NO_NEXT_KEY", "The last key has no outgoing easing to replace.");
  if (!operation.values || typeof operation.values !== "object" || Array.isArray(operation.values)
    || Object.keys(operation.values).length === 0) {
    throw new SpineError("INVALID_KEY_VALUES", "Replacing a key requires at least one value field.");
  }

  const key = setKeyframeText(document, { kind: "set_keyframe", animation: operation.animation,
    selector: { section: "bones", target: operation.bone, timelineType: operation.timelineType },
    time: operation.time, values: operation.values, curvePolicy: "linearize" });
  const curve = setCurveText(parseDocument(document.path, key.text), { kind: "set_curve",
    animation: operation.animation, bone: operation.bone, timelineType: operation.timelineType,
    time: operation.time, mode: operation.easing, controls: operation.controls });
  const changes = [...key.changes, ...curve.changes].reduce<KeyChange[]>((result, change) => {
    const existing = result.find((entry) => entry.path === change.path);
    if (existing) existing.after = change.after;
    else result.push({ ...change });
    return result;
  }, []).filter((change) => JSON.stringify(change.before) !== JSON.stringify(change.after));
  const previous = timeline.keys[matches[0] - 1];
  const incomingCurveReset = Array.isArray(previous?.curve) && key.summary.curveResets > 0;
  const outgoingAnimations = parseDocument(document.path, curve.text).data.animations as Record<string, unknown>;
  const outgoingEasingChanged = JSON.stringify(timeline.keys[matches[0]].curve) !==
    JSON.stringify(collectTimelines(operation.animation, outgoingAnimations[operation.animation]).find((item) =>
      item.section === "bones" && item.target === operation.bone && item.type === operation.timelineType)!.keys[matches[0]].curve);
  return { text: curve.text, changes,
    summary: { kind: "replace_keyframe", animation: operation.animation, bone: operation.bone,
      timelineType: operation.timelineType, time: operation.time, nextTime: curve.summary.nextTime,
      easing: operation.easing, channels: curve.summary.channels, incomingCurveReset, outgoingEasingChanged,
      changed: curve.text !== document.text } };
}
