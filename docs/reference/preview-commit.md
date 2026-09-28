# Preview and commit an edit

Every JSON edit response includes `diagnostics` and `diffResourceUri`. Read that URI with MCP `resources/read` to inspect the complete change list, especially when the response truncates `changes`. Stage a revised edit if the result needs adjustment.

With a licensed Spine CLI, saved PNG export settings, source images, and a display with OpenGL, compare a staged animation before committing:

```json
{"editId":"<editId>","settingsPath":"/path/to/preview.export.json","outputDir":"/path/to/review","animation":"walk","samples":6}
```

Pass this to `spine_compare_previews`. Read `contactSheetUri` and the `pairs[].sideBySideUri` PNG resources. Use `spine_render_staged_edit` with the same core inputs when only after frames are needed. `spine_analyze_preview` can flag blank frames or visible area changes using a returned `previewId`.

Commit the chosen stage:

```json
{"editId":"<editId>"}
```

Pass this to `spine_commit_edit`. It refuses to overwrite a source that changed after staging. A successful commit stores exact before and after copies plus a manifest in `.spine2d-mcp/history/` beside the JSON. Stages persist for seven days. If commit reports `COMMIT_FINALIZATION_FAILED`, retry the same `editId`.

For direct PNG review of an existing file, use `spine_render_preview` with `inputPath`, `settingsPath`, `outputDir`, and `animation`. Exact fields: [FUNCTIONS.md](../../FUNCTIONS.md).
