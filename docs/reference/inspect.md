# Inspect and validate a skeleton

Use `spine_inspect_project` for a capped inventory and `spine_inspect_animation` for a clip's duration, timelines, and keys. The project response includes `inventoryResourceUri` for the full inventory.

```json
{"path":"/path/to/character.json","maxItems":25}
```

Pass the example to `spine_inspect_project`; inspect a time range with `spine_inspect_animation`:

```json
{"path":"/path/to/character.json","animation":"walk","from":0,"to":1,"target":"arm"}
```

Use `spine_search_project` to find a bone, slot, animation, timeline, or asset without reading all JSON. Before renaming or removing one, call `spine_reference_graph` for known references:

```json
{"path":"/path/to/character.json","kind":"bone","name":"arm"}
```

Call `spine_validate_data({"path":"/path/to/character.json","checkAssets":true})` for diagnostics. If images live elsewhere, pass `imagesDir` to `spine_inspect_assets`. Inspection accepts other versions; editing supports tested Spine 4.2/4.3 JSON exports.

Next: [Stage JSON edits](edit-json.md). Exact tool fields: [FUNCTIONS.md](../../FUNCTIONS.md).
