# Stage JSON edits

Use a named edit tool for one action. For a coordinated change, `spine_preview_edit` stages 1–20 operations atomically and validates the result. Both return an `editId`, diagnostics, and `diffResourceUri`; neither writes the source JSON.

To slow a whole clip by 50%, call `spine_retime_animation`:

```json
{"path":"/path/to/character.json","animation":"walk","scale":1.5}
```

To create a clip and add two keys in one stage, call `spine_preview_edit`:

```json
{
  "path": "/path/to/character.json",
  "operations": [
    {"kind":"upsert_animation","name":"wave"},
    {"kind":"set_keyframe","animation":"wave","selector":{"section":"bones","target":"arm","timelineType":"rotate"},"time":0,"values":{"value":-20}},
    {"kind":"set_keyframe","animation":"wave","selector":{"section":"bones","target":"arm","timelineType":"rotate"},"time":1,"values":{"value":20}}
  ]
}
```

Inspect targets first with `spine_inspect_project` and `spine_inspect_animation`. For a single existing key, `spine_set_keyframe`, `spine_delete_keyframe`, and `spine_set_curve` are more direct. For multiple timelines or clips, see `spine_bulk_keys`. Operation shapes and supported timeline values are in [FUNCTIONS.md](../../FUNCTIONS.md).

Next: [Preview and commit](preview-commit.md).
