# Edit an existing Spine project

Use `spine_round_trip_edit` when the source is a `.spine` project and editor fidelity needs checking. It exports JSON, stages the requested operations, imports a **new** project, re-exports data, validates it, and renders before and after frames. The source project remains unchanged.

Save JSON export settings in Spine with `class: "export-json"` and **Nonessential data** enabled. Save PNG export settings too. A licensed Spine CLI, source images, and a display with OpenGL are required.

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
