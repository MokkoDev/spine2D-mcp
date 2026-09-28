# Create a skeleton and rig

## Assemble a rig from separate PNGs

Use `spine_start_rig_review` to open the browser editor and receive the starter manifest and `sourceHash`. Its starter manifest may leave parts unconnected in a tray. Assign every nonroot part a parent landmark, place all art and joints, set draw order, and call `spine_save_rig_draft` with the full assembled manifest and `sourceHash`. Reload the editor URL to see the connected character. Use `spine_validate_rig_manifest` to resolve errors, then `spine_preview_rig` to inspect the setup and bend snapshots.

Show that assembled character, the editable review link, bone hierarchy, joints, attachment placement, and draw order to the user. End your turn and wait for a new message explicitly confirming the complete rig before calling `spine_build_rig_from_landmarks` or committing rig changes. A saved draft, tool result, or elapsed time is not confirmation; do no other work while waiting. See [FUNCTIONS.md](../../FUNCTIONS.md) for tool inputs.

## Create a skeleton directly

Create editable JSON without Spine using `spine_create_skeleton`:

```json
{"dataPath":"/path/to/character.json","version":"4.3","rootBoneName":"root"}
```

Put a PNG at `/path/to/images/hand.png`, then stage the setup with `spine_preview_edit`:

```json
{
  "path":"/path/to/character.json",
  "operations":[
    {"kind":"upsert_bone","name":"arm","parent":"root","values":{"length":40}},
    {"kind":"upsert_slot","name":"hand","bone":"arm","values":{"attachment":"hand"}},
    {"kind":"upsert_region_attachment","skin":"default","slot":"hand","name":"hand","values":{"path":"hand","width":32,"height":32}}
  ]
}
```

Read diagnostics and diff, then call `spine_commit_edit`. With a licensed CLI, `spine_import_data` creates a new `.spine` project from the committed JSON. `spine_create_project` can instead create the initial JSON and `.spine` snapshot in one call; later JSON edits still need import into a new project.

To add a clip and keys, follow [Stage JSON edits](edit-json.md).
