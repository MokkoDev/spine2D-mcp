# Reuse and review motion

Inspect the source clip first with `spine_inspect_animation`. To make a slower copy while preserving the original, stage a clone:

```json
{"path":"/path/to/character.json","sourceAnimation":"walk","newAnimation":"walk-slow","timeScale":2}
```

Pass this to `spine_clone_animation`. For movement between rigs, `spine_retarget_animation` checks target references and accepts `maps` for names that differ. For a sampled bone and slot pose, use `spine_save_pose` followed by `spine_apply_pose`; the bone-only and mesh-pose pairs handle narrower data. Each apply action stages an edit for review and commit.

For loop closure, call `spine_make_loop` on a repeating clip with time-zero pose keys. Check its discontinuity report, then render the staged result. `spine_check_animation` works without rendering; `spine_analyze_motion_quality` can add rendered contact drift hints using a `previewId`.

Follow the [preview and commit guide](preview-commit.md) before saving. Exact mapping and pose fields: [FUNCTIONS.md](../../FUNCTIONS.md).
