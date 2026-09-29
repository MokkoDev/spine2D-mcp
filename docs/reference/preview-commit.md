# Preview and commit an edit

JSON edit responses include `diagnostics`, `diffResourceUri`, and `netDiffResourceUri`. Small results include up to 100 newest step `changes` and `netChanges` from source to selected stage; large results omit both arrays and provide `stageResourceUri` for all summaries. Read `diffResourceUri` for full step history and `netDiffResourceUri` for the complete net diff: 0 → 30 → 10 appears as 0 → 10. `beforeExists: false` or `afterExists: false` distinguishes a missing property from `null`. Revise if needed.

To build on an uncommitted stage, call `spine_preview_edit` with its `editId` as `baseEditId` and the next 1–20 operations:

```json
{"path":"/path/to/character.json","baseEditId":"<previous editId>","operations":[{"kind":"set_keyframe","animation":"walk","selector":{"section":"bones","target":"arm","timelineType":"rotate"},"time":0.5,"values":{"value":30}}]}
```

Each revision gets a new `editId`; branches can share a base. Results include complete operation and change history from the unchanged source. The base must exist, belong to the same file, and match its source hash. `requestId` identifies the full request, including `baseEditId`; reuse on another branch returns `IDEMPOTENCY_CONFLICT`.

After a named edit tool, revise with `spine_preview_edit` and `baseEditId`. Retrying the same `requestId`, `baseEditId`, and operations returns the child even if its parent expired; a new child needs an available parent.

With a licensed Spine CLI, saved PNG settings, source images, and an OpenGL display, compare before committing:

```json
{"editId":"<editId>","settingsPath":"/path/to/preview.export.json","outputDir":"/path/to/review","animation":"walk","samples":6}
```

Pass the example to `spine_compare_previews`; inspect `contactSheetUri` and `pairs[].sideBySideUri`. Use `spine_render_staged_edit` with the same core inputs for after frames only. `spine_analyze_preview` flags blank frames or visible area changes using a returned `previewId`.

Render each candidate with its own `editId`. Pass that same `editId` to `spine_check_animation` or `spine_analyze_motion_quality` when reviewing its rendered `previewId`.

Commit the chosen stage:

```json
{"editId":"<editId>"}
```

Pass the example to `spine_commit_edit`. It rejects a source changed after staging. Success stores exact before/after copies and a manifest in `.spine2d-mcp/history/` beside the JSON. Stages last seven days. On `COMMIT_FINALIZATION_FAILED`, retry the same `editId`.

Commit only the selected revision. Its history includes its full operation chain; other branches remain staged and cannot overwrite the committed file.

For direct PNG review of an existing file, call `spine_render_preview` with `inputPath`, `settingsPath`, `outputDir`, and `animation`. Exact fields: [FUNCTIONS.md](../../FUNCTIONS.md).
