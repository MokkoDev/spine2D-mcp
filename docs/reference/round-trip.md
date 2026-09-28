# Edit an existing Spine project

Use `spine_round_trip_edit` when the source is a `.spine` project and editor fidelity needs checking. It exports JSON, stages the requested operations, imports a **new** project, re-exports data, validates it, and renders before and after frames. The source project remains unchanged.

Save JSON export settings in Spine with `class: "export-json"` and **Nonessential data** enabled. For a single-skeleton JSON preview or final delivery, a PNG settings file such as `{ "class": "export-png", "fps": 30 }` is enough; the server fills the required animation and skin selectors. When rendering an existing native project with several skeletons, select one with `spine_render_preview`'s `skeleton` input or saved settings. A licensed Spine CLI, source images, and a display with OpenGL are required.

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

Read `motionReview`, `contactSheetUri`, PNG `pairs`, `importedProject.path`, and the run manifest. Pass `imagesDir` when the exported image path does not resolve beside the project. On Linux, set `display` if the server lacks `DISPLAY`. For manual steps, use `spine_export_data` → staged JSON edit → `spine_import_data` → `spine_render_preview`.

For JSON only, start with [Start here](start-here.md). Exact fields: [FUNCTIONS.md](../../FUNCTIONS.md).

## Final delivery from reviewed JSON

Once the JSON has been reviewed and committed, call `spine_finalize_animation` to create the native project and both previews in one run:

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

The tool imports a new `.spine` project, re-exports its JSON, and requires semantic fidelity with the reviewed source. It selects the imported skeleton name for PNG rendering even if the saved settings refer to an older project. It renders the final project, samples a contact sheet, and builds a standalone HTML Web Player preview from the verified re-export. If `atlasPath` is omitted, it packs an atlas from the image directory. Use `imagesDir` if the source JSON's image path cannot be resolved. Deliver `projectPath`, `htmlPath`, and `contactSheetPath` from the same result. The response includes a compact animation summary and sampled frame URIs; the complete manifest retains timeline and render details. A failed run has `failure.json` and does not report success. The generated project and previews live in a new run directory; existing files are not replaced.
