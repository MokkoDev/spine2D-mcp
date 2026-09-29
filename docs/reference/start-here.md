# Start here: inspect → edit → preview → commit

For Spine 4.2/4.3 skeleton JSON, inspection and editing need no Spine CLI. Rendering needs a licensed CLI, source images, and an OpenGL display.

For separate-image rigs, follow [Create a skeleton and rig](create-rig.md), including review and approval.

1. Inspect: `spine_inspect_project({"path":"/path/to/character.json"})`; for a clip, also call `spine_inspect_animation({"path":"/path/to/character.json","animation":"walk"})`.
2. Stage: `spine_retime_animation({"path":"/path/to/character.json","animation":"walk","scale":1.5})`, or combine related `operations` with `spine_preview_edit`. The source stays unchanged.
3. Review `diagnostics` and any `netChanges`; `netDiffResourceUri` holds the full source-to-result diff, `diffResourceUri` the step history, and `stageResourceUri` large edits' full summaries. Revise with `spine_preview_edit` and `baseEditId`; each revision has a new `editId`. If rendering is available, call `spine_compare_previews({"editId":"<editId>","settingsPath":"/path/to/preview.export.json","outputDir":"/path/to/review","animation":"walk","samples":6})` for each candidate; inspect its contact sheet and PNG pairs. See [Preview and commit](preview-commit.md).
4. Commit the chosen stage with `spine_commit_edit({"editId":"<editId>"})`. It checks the source hash and stores before/after copies and a manifest under `.spine2d-mcp/history/` beside the JSON.

For an existing `.spine` project or final delivery of reviewed JSON as a native project, HTML preview, and contact sheet, follow [Edit an existing Spine project](round-trip.md). `spine_finalize_animation` updates a matching sibling `.spine` project if present.

Find focused guides with `spine_search_reference({"query":"retime animation"})`; fetch a slug with `spine_get_reference` or read its `spine-docs://reference/...` resource. Find tools with `spine_capabilities`; [FUNCTIONS.md](../../FUNCTIONS.md) lists inputs and limits.
