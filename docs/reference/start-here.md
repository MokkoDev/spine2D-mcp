# Start here: inspect → edit → preview → commit

Use this path for a Spine 4.2 or 4.3 skeleton JSON export. JSON inspection and editing work without the Spine CLI. Rendering needs a licensed Spine CLI, source images, and a display with OpenGL.

For rigging from separate images, follow [Create a skeleton and rig](create-rig.md), including its review and confirmation step.

1. Inspect the target: `spine_inspect_project({"path":"/path/to/character.json"})`, then `spine_inspect_animation({"path":"/path/to/character.json","animation":"walk"})` if editing a clip.
2. Stage one change with a named tool, such as `spine_retime_animation({"path":"/path/to/character.json","animation":"walk","scale":1.5})`. For related changes, use `spine_preview_edit` with `operations`. The source JSON stays untouched.
3. Read the returned `diagnostics` and `netChanges`; use `netDiffResourceUri` for the complete source-to-result diff and `diffResourceUri` for step history. To revise an uncommitted stage, call `spine_preview_edit` with its `editId` as `baseEditId`; each revision gets a new `editId`. If rendering is available, call `spine_compare_previews({"editId":"<editId>","settingsPath":"/path/to/preview.export.json","outputDir":"/path/to/review","animation":"walk","samples":6})` for each candidate and read its contact sheet and PNG pairs. See [Preview and commit](preview-commit.md).
4. Save the chosen stage with `spine_commit_edit({"editId":"<editId>"})`. Commit checks the source hash and stores before and after copies plus a manifest under `.spine2d-mcp/history/` beside the JSON.

For an existing `.spine` project that must return to the editor, follow [Edit an existing Spine project](round-trip.md).
For final delivery of a reviewed JSON animation with a native project, HTML preview, and contact sheet, use `spine_finalize_animation` as described in that guide. It updates a matching sibling `.spine` project when one exists.

Find one detailed guide with `spine_search_reference({"query":"retime animation"})`, then fetch its slug with `spine_get_reference` or read the returned `spine-docs://reference/...` resource. Use `spine_capabilities` to find a specialized typed tool; [FUNCTIONS.md](../../FUNCTIONS.md) lists exact inputs and limits.
