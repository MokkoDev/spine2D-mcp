# Preview and commit an edit

Every JSON edit response includes `diagnostics`, `diffResourceUri`, and `netDiffResourceUri`. `changes` is the step history and shows the newest 100 entries with `changesOffset` indicating where that slice begins. Read `diffResourceUri` with MCP `resources/read` for the complete history. `netChanges` compares the original source with the selected stage's final JSON, so a value edited from 0 to 30 to 10 appears as 0 to 10. A net change uses `beforeExists: false` or `afterExists: false` when a property is missing, distinguishing absence from an explicit `null`. Read `netDiffResourceUri` for the complete source-to-result diff when the response truncates `netChanges` or a value. Stage a revised edit if the result needs adjustment.

To build on an uncommitted stage, call `spine_preview_edit` with its `editId` as `baseEditId` and the next 1–20 operations:

```json
{"path":"/path/to/character.json","baseEditId":"<previous editId>","operations":[{"kind":"set_keyframe","animation":"walk","selector":{"section":"bones","target":"arm","timelineType":"rotate"},"time":0.5,"values":{"value":30}}]}
```

Each call returns a new `editId`. Revisions can branch from the same stage, and each result includes the complete operation and change history from the original file. The source JSON remains untouched. The base stage must still exist, belong to the same file, and match its current source hash. A `requestId` identifies the complete request, including `baseEditId`; reusing it for another branch returns `IDEMPOTENCY_CONFLICT`.

For later steps after a named edit tool, switch to `spine_preview_edit` with `baseEditId`. A retry using the same `requestId`, `baseEditId`, and operations returns the existing child stage even if its parent has expired; creating a new child requires the parent to remain available.

With a licensed Spine CLI, saved PNG export settings, source images, and a display with OpenGL, compare a staged animation before committing:

```json
{"editId":"<editId>","settingsPath":"/path/to/preview.export.json","outputDir":"/path/to/review","animation":"walk","samples":6}
```

Pass this to `spine_compare_previews`. Read `contactSheetUri` and the `pairs[].sideBySideUri` PNG resources. Use `spine_render_staged_edit` with the same core inputs when only after frames are needed. `spine_analyze_preview` can flag blank frames or visible area changes using a returned `previewId`.

Render each candidate with its own `editId`. Pass that same `editId` to `spine_check_animation` or `spine_analyze_motion_quality` when reviewing its rendered `previewId`.

Commit the chosen stage:

```json
{"editId":"<editId>"}
```

Pass this to `spine_commit_edit`. It refuses to overwrite a source that changed after staging. A successful commit stores exact before and after copies plus a manifest in `.spine2d-mcp/history/` beside the JSON. Stages persist for seven days. If commit reports `COMMIT_FINALIZATION_FAILED`, retry the same `editId`.

Commit only the selected revision. Its history includes every operation in its chain; other branches remain staged and cannot overwrite the newly committed file.

For direct PNG review of an existing file, use `spine_render_preview` with `inputPath`, `settingsPath`, `outputDir`, and `animation`. Exact fields: [FUNCTIONS.md](../../FUNCTIONS.md).
