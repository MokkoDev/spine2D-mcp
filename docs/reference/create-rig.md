# Create a skeleton and rig

Before creating or changing a rig, show the proposed bone hierarchy, joint positions, attachment placement, and draw order. End your turn and wait for a new user message explicitly confirming the rig before applying changes or doing further work, unless the user already confirmed those details. A saved draft or rendered preview does not replace confirmation.

Create editable JSON without Spine using `spine_create_skeleton`:

```json
{"dataPath":"/path/to/character.json","version":"4.3","rootBoneName":"root"}
```

Put a PNG at `/path/to/images/hand.png`, then stage setup and a clip with `spine_preview_edit`:

```json
{
  "path":"/path/to/character.json",
  "operations":[
    {"kind":"upsert_bone","name":"arm","parent":"root","values":{"length":40}},
    {"kind":"upsert_slot","name":"hand","bone":"arm","values":{"attachment":"hand"}},
    {"kind":"upsert_region_attachment","skin":"default","slot":"hand","name":"hand","values":{"path":"hand","width":32,"height":32}},
    {"kind":"upsert_animation","name":"wave"},
    {"kind":"set_keyframe","animation":"wave","selector":{"section":"bones","target":"arm","timelineType":"rotate"},"time":0,"values":{"value":-20}},
    {"kind":"set_keyframe","animation":"wave","selector":{"section":"bones","target":"arm","timelineType":"rotate"},"time":1,"values":{"value":20}}
  ]
}
```

Read diagnostics and diff, then call `spine_commit_edit`. With a licensed CLI, `spine_import_data` creates a new `.spine` project from the committed JSON. `spine_create_project` can instead create the initial JSON and `.spine` snapshot in one call; later JSON edits still need import into a new project.

For independently cropped PNG body parts, use `spine_start_rig_review` to arrange landmarks in the browser. Unconnected parts appear in a separate tray until assigned a parent. Present the resulting rig to the user and end your turn. After the user confirms it in a new message, use `spine_validate_rig_manifest`, `spine_preview_rig`, then `spine_build_rig_from_landmarks`. See [FUNCTIONS.md](../../FUNCTIONS.md) for those inputs.
