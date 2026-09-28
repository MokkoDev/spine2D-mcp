# Batch and export workflows

Use an export profile for repeatable CLI data, media, or atlas settings. `spine_manage_export_profile` saves a snapshot of selected settings:

```json
{"workspaceDir":"/path/to/workspace","action":"save","name":"runtime-43","editorVersion":"4.3","runtimeVersion":"4.3","settingsPaths":{"data":"/path/to/data.export.json"}}
```

Run the saved profile with `spine_run_export_profile` and an `inputPath` project plus a new `outputDir`. The run reports output hashes and a manifest. Data export settings must use `class: "export-json"` and `nonessential: true` for editor reimport.

For the same animation operation across JSON projects, use `spine_batch_job` with `action: "start"`:

```json
{"action":"start","targets":[{"path":"/path/to/hero.json","animations":["walk","run"]}],"operation":{"kind":"retime_animation","scale":1.2}}
```

The default `commit: false` returns stages for review and individual `spine_commit_edit` calls. Use `action: "status"` with the returned `jobId` to inspect progress; `cancel` stops before the next project. Cross-project commits can be partial when `commit: true`. Exact profile and batch limits: [FUNCTIONS.md](../../FUNCTIONS.md).
