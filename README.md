# Spine2D MCP

An MCP server for inspecting Spine 2D animation data and making staged, validated edits. The current editing workflow supports retiming, type-checked keyframe edits, bulk key edits, loop closure, bone curve editing, animation transforms, parameterized motion recipes, and batch jobs in tested Spine 4.2 and 4.3 JSON exports. Saved export profiles can rerun data, media, and atlas exports with a hash manifest. An interactive Web Player preview can package exported JSON and atlas assets into a standalone HTML file. The full tool catalog and current limits are in [FUNCTIONS.md](FUNCTIONS.md).

## Requirements

- Node.js 20 or newer
- npm
- Codex CLI and Claude Code CLI for automatic registration

Spine is not required for skeleton JSON creation, inspection, or editing. Creating a `.spine` project and PNG preview rendering require a licensed Spine installation; rendering also needs a windowing system with OpenGL.

## Install for Codex and Claude Code

```sh
./install.sh
```

The installer asks for the Spine CLI executable or installation directory. Press Enter to skip it if you only need JSON tools. For a noninteractive install, provide the path in the environment:

```sh
SPINE_CLI_PATH=/absolute/path/to/Spine.sh ./install.sh
```

The installer saves the selected path in `.spine2d-mcp-cli-path` beside `startup.sh`. Later launches through `startup.sh` read that file unless `SPINE_CLI_PATH` is set explicitly in the launch environment. Rerun `./install.sh` to change the path; Enter keeps the saved value and `-` clears it. The installer runs `npm ci` and the test suite, then registers `spine2d-mcp` with Codex and Claude Code. Claude uses user scope, so the server is available in all Claude Code projects. Both clients launch this checkout's absolute `startup.sh` path. Rerunning the installer keeps matching registrations; it stops if that name belongs to another server.

To remove the registrations, generated build, and installed dependencies:

```sh
./uninstall.sh
```

Keep this checkout at the same path while the server is registered. Restart an open Codex or Claude Code session after installing or uninstalling so it refreshes its MCP server list.

## Manual development

```sh
npm ci
npm run build
npm test
./startup.sh
```

`startup.sh` waits for an MCP client on standard input. Standard output is reserved for MCP messages. For local development, use `npm run dev` instead of building first.

The offline suite runs with `npm test`. Pinned official Spine 4.2 and 4.3 JSON regression fixtures run with `npm run test:examples` (downloads on demand). To verify actual import, nonessential JSON export, constraint authoring, PNG rendering, saved-settings media export, animation cleanup, and staged rendering with a licensed Spine CLI, run:

```sh
SPINE_CLI_PATH=/absolute/path/to/Spine npm run test:cli
```

The real CLI test downloads the pinned official Spineboy JSON and images, works only in a temporary directory, and needs a display/OpenGL for PNG rendering. It passed locally with Spine 4.3 Professional.

Configure a local MCP client to launch the built server with a command like this (replace the path with your checkout's absolute path):

```json
{
  "mcpServers": {
    "spine2d": {
      "command": "node",
      "args": ["/absolute/path/to/Spine2DMcp/dist/index.js"]
    }
  }
}
```

Callable tools include skeleton and project creation, project inspection and validation, staged rig and animation edits, animation transforms and motion recipes, reusable poses, batch jobs, CLI import/export and atlas operations, export profiles, PNG preview rendering, and an interactive Web Player preview. See [FUNCTIONS.md](FUNCTIONS.md) for exact tool names, inputs, and limits.

## Start with a workflow

Call `spine_workflow_guide` with `goal: "choose"` for a short menu. Use `round_trip` to edit an existing `.spine` project with visual proof, `new_motion` to create a clip from a rig, `edit_json` for staged JSON work, `review_motion` for rendered checks, or `batch_export` for repeatable production work.

For an existing project, `spine_round_trip_edit` handles export, edit, import, re-export, validation, and visual comparison in one call:

```json
{
  "projectPath": "/path/to/character.spine",
  "dataSettingsPath": "/path/to/data.export.json",
  "previewSettingsPath": "/path/to/preview.export.json",
  "outputDir": "/path/to/review-runs",
  "editorVersion": "4.3",
  "animation": "walk",
  "operations": [{ "kind": "retime_animation", "animation": "walk", "scale": 1.5 }],
  "samples": 6
}
```

The data settings must enable **Nonessential data**. The tool creates a new `.spine` project, re-exported JSON, a hashed manifest, and a side-by-side contact sheet. It leaves the source project unchanged. It copies the project's images folder into the run when needed; pass `imagesDir` if the exported image path does not resolve beside the project. Rendering needs a display and OpenGL. Review `motionReview` hints and the PNG pairs before using the new project. [Spine's import guide](https://en.esotericsoftware.com/spine-import) explains why Nonessential data matters for editor reimport.

## Create a new project

Call `spine_create_skeleton` with a new JSON path and Spine version to create an editable root-bone skeleton without the editor. With a licensed Spine CLI, call `spine_create_project` with a new `.spine` path and `editorVersion: "4.3"` to create both the project and an adjacent JSON file. Neither tool overwrites existing files.

Put a PNG at `images/hand.png` beside the JSON, then stage a complete setup and animation with `spine_preview_edit`:

```json
{
  "path": "/path/to/character.json",
  "operations": [
    { "kind": "upsert_bone", "name": "arm", "parent": "root", "values": { "length": 40 } },
    { "kind": "upsert_slot", "name": "hand", "bone": "arm", "values": { "attachment": "hand" } },
    { "kind": "upsert_region_attachment", "skin": "default", "slot": "hand", "name": "hand", "values": { "path": "hand", "width": 32, "height": 32 } },
    { "kind": "upsert_animation", "name": "wave" },
    { "kind": "set_keyframe", "animation": "wave", "selector": { "section": "bones", "target": "arm", "timelineType": "rotate" }, "time": 0, "values": { "value": -20 } },
    { "kind": "set_keyframe", "animation": "wave", "selector": { "section": "bones", "target": "arm", "timelineType": "rotate" }, "time": 1, "values": { "value": 20 } }
  ]
}
```

Review the diff and diagnostics, then call `spine_commit_edit` with its `editId`. Call `spine_import_data` to make a new `.spine` project from the edited JSON; the `.spine` file made by `spine_create_project` remains the initial snapshot. Render the imported project with `spine_render_preview` and saved PNG export settings. The setup tools are also callable individually and each returns a staged edit. `spine_upsert_skin` creates additional skins and `spine_remove_skin` deletes unused named skins; `spine_upsert_event` defines event defaults before event keys are added. `spine_upsert_attachment` authors typed attachments, `spine_remove_attachment` checks references before removal, and `spine_set_mesh_geometry` and `spine_set_mesh_weights` edit mesh topology and bone influences. `spine_upsert_constraint` creates or updates IK, transform, path, and physics constraints for Spine Professional.

## Retime a Spine 4.2 or 4.3 animation

1. Export a skeleton as JSON with **Nonessential data** enabled if you intend to import it back into the editor.
2. Call `spine_inspect_project` and `spine_inspect_animation` to find the clip and its current duration.
3. Call `spine_retime_animation` with `{ "path": "/path/to/skeleton.json", "animation": "walk", "scale": 2 }`. This stages a version-aware change and reports the key and curve times that will change. You can also stage several retimes together with `spine_preview_edit`.
4. Review the diagnostics and diff. With a local Spine installation, call `spine_render_staged_edit` or `spine_compare_previews` using the `editId` and saved PNG settings to inspect the proposed motion. The comparison returns a contact sheet, side-by-side pairs, and pixel difference measurements. Preview another parameter choice if needed.
5. Call `spine_commit_edit` with the chosen `editId`. The server checks that the source has not changed, saves exact before and after copies plus a manifest under `.spine2d-mcp/history/`, and replaces the JSON file.

For coordinated key changes, call `spine_bulk_keys` with selected animations and timelines. For example, `{ "path": "/path/to/skeleton.json", "animations": ["walk", "run"], "action": "move", "section": "events", "delta": 0.1 }` stages a 0.1 second event shift in both clips. Review the returned diff and commit its `editId` in the same way. The function catalog describes all six actions and their limits.

To create a separate clip variant, call `spine_clone_animation` with a source and unused destination name. For example, `{ "path": "/path/to/skeleton.json", "sourceAnimation": "walk", "newAnimation": "walk-slow", "timeScale": 2 }` stages a slower copy while leaving `walk` intact. You can put the clone and follow-up key edits in one `spine_preview_edit` batch.

For a bone-motion clip with time-zero keys, call `spine_reverse_bone_animation` with its source and a new animation name. It stages a reversed clip with reflected Bézier curves and event times. The tool reports unsupported discrete or non-bone timelines so you can choose a compatible clip; render the staged result before committing.

To transfer a clip between skeletons, call `spine_retarget_animation` with source and target JSON paths, source and new animation names, and any names that differ in `maps`. For example, `maps: { "bones": { "arm": "wing" }, "events": { "beat": "impact" } }` maps two references; names not listed retain their spelling. The tool reports all missing or incompatible references before it stages a target edit. Review its diff and a render, then commit with `spine_commit_edit`. The source animation is unchanged.

To reuse a keyed bone pose, call `spine_save_bone_pose` with a source animation and time. Then call `spine_apply_bone_pose` with its `poseId`, a target skeleton JSON path, animation name, and time. The tool stages the transform keys and reports missing bone mappings before any commit. Use `boneMap` when source and target bones have different names, and `blend` to mix with the target animation's current channel values. For a pose that includes slot attachment state, use `spine_save_pose` and `spine_apply_pose`; these also support bone mirroring, per-channel offsets, and compatible rig mappings. For mesh deformation, use `spine_save_mesh_pose` and `spine_apply_mesh_pose` to sample a source clip and stage compatible deform keys with optional blending. Constraint pose channels are not yet captured.

For a repeating clip with keys at time zero, call `spine_make_loop` with its path and animation name. The staged result copies the start pose to the loop end, eases supported bone transform timelines, and reports discontinuities and visual review hints. Render and compare the staged clip before committing; the loop tool requires a time-zero key on each pose timeline and reports that requirement if it is missing. Pass a rendered `previewId` to `spine_analyze_preview` for blank-frame and visible-area checks, or add it to `spine_check_animation` to combine those checks with timeline diagnostics.

For an existing bone key, call `spine_set_curve` with its animation, bone, transform timeline, exact key time, and interpolation mode. For Bézier easing, pass normalized `controls: [0.25, 0, 0.75, 1]`. The tool stages the curve change for review and commit.

To add or update a key, call `spine_set_keyframe` with a timeline selector, time, and type-specific values. For example, `{ "path": "/path/to/skeleton.json", "animation": "walk", "selector": { "section": "bones", "target": "arm", "timelineType": "rotate" }, "time": 0.5, "values": { "value": 25 } }` stages a rotation key. `spine_delete_keyframe` removes a selected key, and both tools keep source JSON unchanged until commit. The selector and value formats are detailed in [FUNCTIONS.md](FUNCTIONS.md).

The staged result includes a `diffResourceUri` for the full time diff. For MCP launches through `startup.sh`, set the Spine CLI path with `./install.sh`; if the saved path is empty, the server looks for Spine on `PATH`. For direct development runs, set `SPINE_CLI_PATH` or put Spine on `PATH`. `spine_export_data` requires current saved JSON export settings (`class: "export-json"`) with **Nonessential data** enabled; `spine_import_data` imports validated JSON into a new `.spine` file. For a preview, save PNG export settings and call `spine_render_preview` with the JSON or project path, settings path, output directory, and animation name. Current `class: "export-png"` settings and legacy `class: "images"` PNG settings are accepted. On Linux, the MCP process needs access to an X display with OpenGL. If its environment lacks `DISPLAY`, pass `"display": ":0"` (or the correct display name) to `spine_render_preview`, `spine_render_staged_edit`, `spine_compare_previews`, or `spine_round_trip_edit`. Returned `spine-preview://` resources contain PNG frames. Pass the returned `previewId` to `spine_contact_sheet` to see sampled frames in one image. Rendering also requires the images referenced by the skeleton.

Edit stages persist for seven days across server restarts in `~/.local/state/spine2d-mcp/stages/`; set `SPINE_MCP_STATE_DIR` to use another directory. Commit history stays beside the JSON source. If a manifest cannot be finalized after a source replacement, `spine_commit_edit` reports `COMMIT_FINALIZATION_FAILED` and the same `editId` can be retried. The current validator targets known 4.2 and 4.3 data; use the round-trip tool or a separate Spine import to verify editor fidelity for production assets.

## Intended Spine workflow

Authoring tools edit Spine skeleton JSON. The CLI adapter supports project info, JSON export/import, saved-settings media export, atlas packing and unpacking, and PNG previews. The Spine CLI does not expose the editor's internal editing actions on an open `.spine` project. When exporting data that will be imported back into Spine, enable **Nonessential data** to retain editor information that is otherwise omitted.

- [Spine CLI](https://en.esotericsoftware.com/spine-command-line-interface)
- [Spine JSON format](https://en.esotericsoftware.com/spine-json-format)
- [Spine import guide](https://en.esotericsoftware.com/spine-import)
