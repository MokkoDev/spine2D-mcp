# Create a skeleton and rig

## Assemble a rig from separate PNGs

Use `spine_start_rig_review` to open the browser editor and receive the starter manifest and `sourceHash`. Its starter manifest may leave parts unconnected in a tray. Assign every nonroot part a parent landmark, place all art and joints, set draw order, and call `spine_save_rig_draft` with the full assembled manifest and `sourceHash`. Reload the editor URL to see the connected character. Use `spine_validate_rig_manifest` to resolve errors, then `spine_preview_rig` to inspect the setup and bend snapshots.

Show the assembled character, editable review link, bone hierarchy, joints, attachment placement, and draw order to the user. Ask whether they approve this exact rig, then **end the turn**. Do not call another tool, poll, sleep, or keep the turn open while waiting. A saved draft, tool result, or elapsed time is not approval.

After a **new user message** explicitly approves the unchanged rig, call `spine_build_rig_from_landmarks` with the `reviewId` from `spine_preview_rig`. The server checks that the manifest and source PNGs still match the preview; it cannot inspect the user's chat reply, so the agent must honor that reply before building. If the user asks for changes or the manifest or a PNG changes, revise and preview again. See [FUNCTIONS.md](../../FUNCTIONS.md) for tool inputs.

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

Read diagnostics and diff, then call `spine_commit_edit` for simple or animation-only data. Multi-part rig structure changes are blocked at commit. For characters assembled from separate images, use the review workflow above. `spine_import_data` and `spine_finalize_animation` also require a matching build from a reviewed preview in the current server session. `spine_create_project` can create an empty starting JSON and `.spine` snapshot.

To add a clip and keys, follow [Stage JSON edits](edit-json.md).
