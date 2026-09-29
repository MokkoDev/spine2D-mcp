import { readFile } from "node:fs/promises";

export const REFERENCE_PAGES = [
  { slug: "start-here", title: "Start here: inspect, edit, preview, commit", description: "Short tutorial for the common staged JSON workflow.", keywords: "quickstart tutorial inspect edit preview commit" },
  { slug: "inspect", title: "Inspect and validate a skeleton", description: "Find animations, keys, assets, and references before editing.", keywords: "inspect search validate animation bones slots assets references" },
  { slug: "edit-json", title: "Stage JSON edits", description: "Retime, author keys, and combine validated operations.", keywords: "edit stage preview_edit retime keyframe curve animation" },
  { slug: "preview-commit", title: "Preview and commit an edit", description: "Read diffs, render staged frames, compare, and save with history.", keywords: "diff diagnostics render compare preview commit history" },
  { slug: "round-trip", title: "Edit and deliver a Spine project", description: "Export, import, verify, and deliver a new .spine project with previews.", keywords: "spine project cli export import nonessential round trip final delivery html contact sheet" },
  { slug: "create-rig", title: "Create a skeleton and rig", description: "Create JSON, add bones and attachments, or assemble PNG parts.", keywords: "create skeleton rig bones slots attachments landmarks png" },
  { slug: "reuse-motion", title: "Reuse and review motion", description: "Clone or retarget animation, transfer poses, and check loops.", keywords: "motion pose constraint retarget clone loop quality review" },
  { slug: "production", title: "Batch and export workflows", description: "Save export profiles and run batch edits.", keywords: "batch export profile atlas production" },
] as const;

export type ReferencePage = typeof REFERENCE_PAGES[number];

export function referenceUri(slug: string): string {
  return `spine-docs://reference/${slug}`;
}

export async function readReferencePage(slug: ReferencePage["slug"]): Promise<string> {
  return readFile(new URL(`../docs/reference/${slug}.md`, import.meta.url), "utf8");
}

export async function searchReference(query: string, limit = 8) {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (terms.length === 0) return [];
  const matches = await Promise.all(REFERENCE_PAGES.map(async (page) => {
    const body = await readReferencePage(page.slug);
    const heading = `${page.title} ${page.description} ${page.keywords}`.toLowerCase();
    const content = body.toLowerCase();
    if (!terms.every((term) => heading.includes(term) || content.includes(term))) return undefined;
    const score = terms.reduce((sum, term) => sum + (heading.includes(term) ? 3 : 0) + (content.includes(term) ? 1 : 0), 0);
    const first = terms.map((term) => content.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, first - 60);
    const excerpt = body.slice(start, start + 180).replace(/\s+/g, " ").trim();
    return { slug: page.slug, title: page.title, description: page.description, uri: referenceUri(page.slug), excerpt, score };
  }));
  return matches.filter((match): match is NonNullable<typeof match> => match !== undefined)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit).map(({ score: _score, ...match }) => match);
}
