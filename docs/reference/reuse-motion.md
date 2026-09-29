# Reuse and review motion

Inspect the source clip first with `spine_inspect_animation`. To make a slower copy while preserving the original, stage a clone:

```json
{"path":"/path/to/character.json","sourceAnimation":"walk","newAnimation":"walk-slow","timeScale":2}
```

Pass this to `spine_clone_animation`. For movement between rigs, `spine_retarget_animation` checks target references and accepts `maps` for names that differ. For a sampled bone and slot pose, use `spine_save_pose` followed by `spine_apply_pose`; the bone-only, mesh-pose, and constraint-pose pairs handle their respective channels. Capture constraint values with `spine_capture_constraint_pose`, then use `spine_apply_constraint_pose` with type-specific name maps when target constraint names differ. Each apply action stages an edit for review and commit.

For loop closure, call `spine_make_loop` on a repeating clip with time-zero pose keys. Check its discontinuity report, then render the staged result. `spine_check_animation` works without rendering; `spine_analyze_motion_quality` can add rig-attached plant, touch, or roll contact checks and visual contact estimates using a `previewId`.

For a generated walk or run, pass `motion.gaitReview`, rendered `previewId`, and staged `editId` to `spine_analyze_motion_quality`. It selects the distal bone tip below each leg, estimates stance windows, and checks sliding and penetration in Spine units. The result lists inferred targets, windows, and ground line. Override them with `leftFoot`, `rightFoot`, `leftStance`, `rightStance`, or `groundY` for different artwork contact points; inspect frames before treating a hint as a defect.

Follow [Preview and commit](preview-commit.md) before saving. [FUNCTIONS.md](../../FUNCTIONS.md) lists exact mapping, pose, and gait fields.
