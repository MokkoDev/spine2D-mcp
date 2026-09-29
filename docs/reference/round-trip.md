# Edit an existing Spine project

For a `.spine` source requiring editor fidelity checks, `spine_round_trip_edit` exports JSON, stages edits, imports a **new** project, re-exports, validates, and renders before/after frames. The source stays unchanged.

Save JSON settings in Spine with `class: "export-json"` and **Nonessential data** enabled. For single-skeleton JSON preview or delivery, PNG settings such as `{ "class": "export-png", "fps": 30 }` suffice; the server fills animation and skin selectors. For a native project with multiple skeletons, select one through `spine_render_preview`'s `skeleton` input or saved settings. Rendering needs a licensed Spine CLI, source images, and an OpenGL display.

```json
{
  "projectPath":"/path/to/character.spine",
  "dataSettingsPath":"/path/to/data.export.json",
  "previewSettingsPath":"/path/to/preview.export.json",
  "outputDir":"/path/to/review-runs",
  "editorVersion":"4.3",
  "animation":"walk",
  "operations":[{"kind":"retime_animation","animation":"walk","scale":1.5}],
  "samples":6
}
```

Inspect `motionReview.hints`, `contactSheetUri`, PNG `pairs`, `projectPath`, and the run manifest; full review is at `motionReview.reviewResourceUri`. Pass `imagesDir` if the exported image path does not resolve beside the project. On Linux, pass `display` if the server lacks `DISPLAY`. Manual sequence: `spine_export_data` → staged JSON edit → `spine_import_data` → `spine_render_preview`.

For JSON only, see [Start here](start-here.md). Exact fields: [FUNCTIONS.md](../../FUNCTIONS.md).

## Final delivery from reviewed JSON

After reviewing and committing JSON, `spine_finalize_animation` updates a matching native project and creates both previews:

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

Finalization selects a sibling `.spine` project with the JSON basename, or `existingProjectPath` for a matching project elsewhere. It exports that project and requires all data outside the selected animation to match reviewed JSON; attachment images must resolve from the project's location. It imports, verifies, and renders the update before replacing the original; the previous project is backed up in the run directory. Without a matching project, it creates one there. A mismatch leaves the existing project unchanged.

The tool renders PNGs with the imported skeleton name even if saved settings name an older project. It creates a contact sheet and standalone HTML Web Player from the verified re-export. Without `atlasPath`, it packs images into an atlas; use `imagesDir` if the source JSON image path cannot resolve. Deliver `projectPath`, `htmlPath`, and `contactSheetPath` together. The response includes `projectMode` (`updated` or `created`), backup path when updated, compact animation summary, and sampled frame URIs. The manifest retains timeline/render details; failures leave `failure.json` and do not report success.
