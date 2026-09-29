# Create a skeleton and rig

## Assemble a rig from separate PNGs

`spine_start_rig_review` opens the browser editor and returns a starter manifest and `sourceHash`; starter parts may be unconnected in a tray. Give each nonroot part a parent landmark, place art and joints, set draw order, and call `spine_save_rig_draft` with the full manifest and `sourceHash`. Reload the editor URL, resolve `spine_validate_rig_manifest` errors, then inspect `spine_preview_rig` setup and bend snapshots.

Show the assembled character, editable review link, bone hierarchy, joints, attachment placement, and draw order. Ask approval of the shown rig, including any changes the user saves in that linked editor before replying, then **end the turn**. Do not call another tool, poll, sleep, or wait in the same turn. A draft, tool result, or elapsed time is not approval.

The user may adjust the rig in the browser editor after this prompt. Once it shows **Saved** and no build errors, their **new approval message** covers that saved version. Call `spine_build_rig_from_landmarks` with the original `reviewId`; valid saves from the linked editor update its revision while source PNGs remain unchanged. The server cannot read chat approval, so honor the reply. Changes outside that editor, changed PNGs, or edits after approval require another preview and approval. Tool inputs: [FUNCTIONS.md](../../FUNCTIONS.md).

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

Review diagnostics and diff, then `spine_commit_edit` for simple or animation-only data. Multi-part rig structure commits, `spine_import_data`, and `spine_finalize_animation` require a matching build from a reviewed preview in the current server session; use the workflow above for separate images. `spine_create_project` creates starting JSON and a `.spine` snapshot.

To add a clip and keys, follow [Stage JSON edits](edit-json.md).
