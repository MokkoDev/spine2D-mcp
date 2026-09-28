# Start here: inspect → edit → preview → commit

Use this path for a Spine 4.2 or 4.3 skeleton JSON export. JSON inspection and editing work without the Spine CLI. Rendering needs a licensed Spine CLI, source images, and a display with OpenGL.

For rigging, show the proposed bone hierarchy, joint positions, attachment placement, and draw order. Ask the user to confirm before applying rig changes unless they already confirmed those details. Use the rig review tools when applicable.

1. Inspect the target: `spine_inspect_project({"path":"/path/to/character.json"})`, then `spine_inspect_animation({"path":"/path/to/character.json","animation":"walk"})` if editing a clip.
2. Stage one change with a named tool, such as `spine_retime_animation({"path":"/path/to/character.json","animation":"walk","scale":1.5})`. For related changes, use `spine_preview_edit` with `operations`. The source JSON stays untouched.
3. Read the returned `diagnostics`, `changes`, and `diffResourceUri` (`spine-edit://.../changes`). Resolve errors or stage a revised choice. If rendering is available, call `spine_compare_previews({"editId":"<editId>","settingsPath":"/path/to/preview.export.json","outputDir":"/path/to/review","animation":"walk","samples":6})` and read its contact sheet and PNG pairs.
4. Save the chosen stage with `spine_commit_edit({"editId":"<editId>"})`. Commit checks the source hash and stores before and after copies plus a manifest under `.spine2d-mcp/history/` beside the JSON.

For an existing `.spine` project that must return to the editor, use `spine_round_trip_edit` and saved JSON export settings with **Nonessential data** enabled. It creates a new project and visual comparison.

Find one detailed guide with `spine_search_reference({"query":"retime animation"})`, then fetch its slug with `spine_get_reference` or read the returned `spine-docs://reference/...` resource. Use `spine_capabilities` to find a specialized typed tool; [FUNCTIONS.md](../../FUNCTIONS.md) lists exact inputs and limits.
