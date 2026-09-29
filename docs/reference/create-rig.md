# Create a skeleton and rig

## Assemble a rig from separate PNGs

Use `spine_start_rig_review` to open the browser editor and receive the starter manifest and `sourceHash`. Its starter manifest may leave parts unconnected in a tray. Assign every nonroot part a parent landmark, place all art and joints, set draw order, and call `spine_save_rig_draft` with the full assembled manifest and `sourceHash`. Reload the editor URL to see the connected character. Use `spine_validate_rig_manifest` to resolve errors, then `spine_preview_rig` to inspect the setup and bend snapshots.

Show the assembled character, editable review link, bone hierarchy, joints, attachment placement, and draw order to the user. Call `spine_confirm_rig_review` with the `reviewId` from `spine_preview_rig`. The MCP client must obtain explicit user approval; unsupported clients and declined prompts leave the rig unapproved. Pass that same `reviewId` to `spine_build_rig_from_landmarks` only after confirmation returns `approved: true`. Changing the manifest or a PNG invalidates the preview and confirmation. A saved draft, tool result, or elapsed time is not approval. See [FUNCTIONS.md](../../FUNCTIONS.md) for tool inputs.

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

Read diagnostics and diff, then call `spine_commit_edit` for simple or animation-only data. Multi-part rig structure changes are blocked at commit. For characters assembled from separate images, use the review workflow above. `spine_import_data` and `spine_finalize_animation` also require a rig approved and built in the current server session. `spine_create_project` can create an empty starting JSON and `.spine` snapshot.

To add a clip and keys, follow [Stage JSON edits](edit-json.md).
