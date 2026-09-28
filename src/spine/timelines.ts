import { SpineError, requireArray, requireObject } from "./errors.js";

export type JsonPath = (string | number)[];

export interface Timeline {
  path: JsonPath;
  section: string;
  target: string;
  type: string;
  keys: Record<string, unknown>[];
}

const DIRECT_SECTIONS = new Set(["events", "drawOrder", "draworder"]);
const ONE_LEVEL_SECTIONS = new Set(["ik", "transform"]);
const TWO_LEVEL_SECTIONS = new Set(["bones", "slots", "path", "physics", "slider"]);
const THREE_LEVEL_SECTIONS = new Set(["deform"]);
const FOUR_LEVEL_SECTIONS = new Set(["attachments"]);

function pointer(path: JsonPath): string {
  return `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

export function collectTimelines(animationName: string, animationValue: unknown): Timeline[] {
  const root = requireObject(animationValue, `/animations/${animationName}`);
  const timelines: Timeline[] = [];

  function add(section: string, target: string, type: string, path: JsonPath, value: unknown): void {
    const keys = requireArray(value, pointer(path)).map((key, index) =>
      requireObject(key, pointer([...path, index])),
    );
    timelines.push({ path, section, target, type, keys });
  }

  for (const [section, value] of Object.entries(root)) {
    const base: JsonPath = ["animations", animationName, section];
    if (DIRECT_SECTIONS.has(section)) {
      add(section, "", section, base, value);
    } else if (ONE_LEVEL_SECTIONS.has(section)) {
      for (const [target, keys] of Object.entries(requireObject(value, pointer(base)))) {
        add(section, target, section, [...base, target], keys);
      }
    } else if (TWO_LEVEL_SECTIONS.has(section)) {
      for (const [target, types] of Object.entries(requireObject(value, pointer(base)))) {
        for (const [type, keys] of Object.entries(requireObject(types, pointer([...base, target])))) {
          add(section, target, type, [...base, target, type], keys);
        }
      }
    } else if (THREE_LEVEL_SECTIONS.has(section)) {
      for (const [skin, slots] of Object.entries(requireObject(value, pointer(base)))) {
        for (const [slot, attachments] of Object.entries(requireObject(slots, pointer([...base, skin])))) {
          for (const [attachment, keys] of Object.entries(requireObject(attachments, pointer([...base, skin, slot])))) {
            add(section, `${skin}/${slot}/${attachment}`, section, [...base, skin, slot, attachment], keys);
          }
        }
      }
    } else if (FOUR_LEVEL_SECTIONS.has(section)) {
      for (const [skin, slots] of Object.entries(requireObject(value, pointer(base)))) {
        for (const [slot, attachments] of Object.entries(requireObject(slots, pointer([...base, skin])))) {
          for (const [attachment, types] of Object.entries(requireObject(attachments, pointer([...base, skin, slot])))) {
            for (const [type, keys] of Object.entries(requireObject(types, pointer([...base, skin, slot, attachment])))) {
              add(section, `${skin}/${slot}/${attachment}`, type, [...base, skin, slot, attachment, type], keys);
            }
          }
        }
      }
    } else {
      throw new SpineError(
        "UNSUPPORTED_TIMELINE",
        `Timeline section ${section} is not supported for safe edits.`,
        { path: pointer(base) },
      );
    }
  }
  return timelines;
}

export function keyTime(key: Record<string, unknown>, path: JsonPath): number {
  const time = key.time ?? 0;
  if (typeof time !== "number" || !Number.isFinite(time) || time < 0) {
    throw new SpineError("INVALID_KEY_TIME", `Invalid key time at ${pointer(path)}.`, { path: pointer(path) });
  }
  return time;
}

export function timelinePath(path: JsonPath): string {
  return pointer(path);
}

/** Number of Bézier value channels in tested Spine 4.2/4.3 timeline types. Zero means discrete. */
export function curveChannelCount(timeline: Pick<Timeline, "section" | "type">): number | undefined {
  if (["events", "drawOrder", "draworder"].includes(timeline.section)) return 0;
  if (timeline.section === "bones") {
    if (["rotate", "translatex", "translatey", "scalex", "scaley", "shearx", "sheary"].includes(timeline.type)) return 1;
    if (["translate", "scale", "shear"].includes(timeline.type)) return 2;
    if (timeline.type === "inherit") return 0;
  }
  if (timeline.section === "slots") {
    return ({ attachment: 0, rgba: 4, rgb: 3, alpha: 1, rgba2: 7, rgb2: 6 } as Record<string, number>)[timeline.type];
  }
  if (timeline.section === "ik") return 2;
  if (timeline.section === "transform") return 6;
  if (timeline.section === "path") return ({ position: 1, spacing: 1, mix: 3 } as Record<string, number>)[timeline.type];
  if (timeline.section === "physics") {
    if (timeline.type === "reset") return 0;
    if (["inertia", "strength", "damping", "mass", "wind", "gravity", "mix"].includes(timeline.type)) return 1;
  }
  if (timeline.section === "slider" && ["time", "mix"].includes(timeline.type)) return 1;
  if (timeline.section === "deform") return 1;
  if (timeline.section === "attachments") {
    return ({ deform: 1, sequence: 0 } as Record<string, number>)[timeline.type];
  }
  return undefined;
}
