# Stage JSON edits

Use a named edit tool for one action. For a coordinated change, `spine_preview_edit` stages 1–20 operations atomically and validates the result. Both return an `editId`, diagnostics, `diffResourceUri` for step history, and `netDiffResourceUri` for the source-to-result diff; neither writes the source JSON. For revisions after a named tool, use `spine_preview_edit` with that stage's `editId` as `baseEditId`.

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

Inspect targets first with `spine_inspect_project` and `spine_inspect_animation`. For one existing bone key's value and outgoing easing, use `spine_replace_keyframe` with `values` and an `easing` preset such as `ease_out`; it clears an affected incoming Bézier curve in the same stage. For curve-only edits, use `spine_set_curve` with `mode: "ease_in"`, `"ease_out"`, or `"ease_in_out"` without controls. `spine_set_keyframe` handles inserts and other timeline types; `spine_delete_keyframe` removes a key. For multiple timelines or clips, see `spine_bulk_keys`. Operation shapes and supported timeline values are in [FUNCTIONS.md](../../FUNCTIONS.md).

Next: [Preview and commit](preview-commit.md).
