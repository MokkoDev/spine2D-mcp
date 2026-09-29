# Edit an existing Spine project

For an existing `.spine` project, use `spine_round_trip_edit` for animation or rig edits. It exports and validates the source, stages edits, reports a rig diff, imports a new project, re-exports, validates, and renders before/after frames. Pass `outputProjectPath` to publish a new sibling after fidelity checks. The source stays unchanged.

Save JSON settings in Spine with `class: "export-json"` and **Nonessential data** enabled. For a single-skeleton round trip, JSON preview, or delivery, PNG settings such as `{ "class": "export-png", "fps": 30 }` suffice; the server selects the exported skeleton and animation. For a native project with multiple skeletons, select one through `spine_render_preview`'s `skeleton` input or saved settings. Rendering needs a licensed Spine CLI, source images, and an OpenGL display.

```json
{
  "projectPath":"/path/to/character.spine",
  "outputProjectPath":"/path/to/character-edited.spine",
  "dataSettingsPath":"/path/to/data.export.json",
  "previewSettingsPath":"/path/to/preview.export.json",
  "outputDir":"/path/to/review-runs",
  "editorVersion":"4.3",
  "animation":"walk",
  "operations":[{"kind":"retime_animation","animation":"walk","scale":1.5},{"kind":"upsert_bone","name":"arm","values":{"length":24}}],
  "samples":6
}
```

Inspect `rigDiff`, `animation.fidelity`, `motionReview.hints`, `contactSheetUri`, PNG `pairs`, `projectPath`, and the run manifest; full review is at `motionReview.reviewResourceUri`. The sibling is published only when the re-export matches the staged JSON and rendering succeeds. Without `outputProjectPath`, the imported project stays in the run directory for inspection. Pass `imagesDir` if the exported image path does not resolve beside the project. On Linux, pass `display` if the server lacks `DISPLAY`. Use this workflow for established projects; direct `spine_import_data` still applies the multipart rig review guard to standalone JSON.

Spine JSON [does not store every editor-only project detail](https://en.esotericsoftware.com/forum/d/17135-losslessly-exporting-to-json-and-back). The delivered sibling is an imported project, so inspect it in Spine before choosing to replace the source. Spine's CLI [cannot import an animation directly into an existing skeleton](https://en.esotericsoftware.com/forum/d/29779-animation-import-from-json-file).

For JSON only, see [Start here](start-here.md). Exact fields: [FUNCTIONS.md](../../FUNCTIONS.md).

## Final delivery from reviewed JSON

After reviewing and committing JSON, `spine_finalize_animation` creates a new native project and both previews:

```json
{
  "dataPath":"/path/to/character.json",
  "dataSettingsPath":"/path/to/data.export.json",
  "previewSettingsPath":"/path/to/preview.export.json",
  "outputDir":"/path/to/deliveries",
  "editorVersion":"4.3",
  "animation":"punch",
  "atlasPath":"/path/to/character.atlas"
}
```

Finalization leaves any existing project untouched by default. To deliberately replace one, pass `replaceExistingProject: true`, plus `existingProjectPath` if the target is not beside the JSON. The target must exist and export the same skeleton, matching reviewed JSON outside the selected animation; attachment images must resolve from its location. The tool imports, verifies, and renders before replacement, and backs up the previous project in the run directory. A mismatch leaves it unchanged. Replacement uses a JSON rebuild, so it can lose editor-only details; prefer the sibling project workflow above for edits to an established project.

The tool renders PNGs with the imported skeleton name even if saved settings name an older project. It creates a contact sheet and standalone HTML Web Player from the verified re-export. Without `atlasPath`, it packs images into an atlas; use `imagesDir` if the source JSON image path cannot resolve. Deliver `projectPath`, `htmlPath`, and `contactSheetPath` together. The response includes `projectMode` (`created` or `updated` when replacement was requested), backup path when updated, compact animation summary, and sampled frame URIs. The manifest retains timeline/render details; failures leave `failure.json` and do not report success.
