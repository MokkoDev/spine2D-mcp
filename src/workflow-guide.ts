export const SERVER_INSTRUCTIONS = [
  "Start with spine_workflow_guide({goal:'choose'}) when the requested Spine workflow is unclear.",
  "Use spine_inspect_project and spine_inspect_animation to identify JSON targets; use spine_capabilities with an area or query to find specialized tools.",
  "For an existing .spine project needing edit, import, and visual verification, use spine_round_trip_edit. For coordinated edits to skeleton JSON, use spine_preview_edit; a named edit tool is simpler for one operation.",
  "All JSON edit tools stage a change. Review its diagnostics and diff, then call spine_commit_edit with the returned editId to save it.",
  "Use spine_render_preview for an existing file, spine_render_staged_edit for one staged result, and spine_compare_previews to compare before and after a staged edit.",
].join(" ");

const WORKFLOWS = {
  inspect: {
    useWhen: "Understand a skeleton JSON or diagnose its structure before editing.",
    primaryTools: ["spine_inspect_project", "spine_inspect_animation", "spine_validate_data"],
    needs: ["Spine skeleton JSON path"],
    steps: ["spine_inspect_project to see rig and animation names.",
      "spine_inspect_animation for keys in a chosen clip; spine_validate_data for structural diagnostics.",
      "Use spine_search_project or spine_reference_graph when locating a name or its references."],
  },
  create_project: {
    useWhen: "Create a new skeleton JSON or a new .spine project from scratch.",
    primaryTools: ["spine_create_skeleton", "spine_create_project"],
    needs: ["new output path", "Spine 4.2 or 4.3 version", "licensed Spine CLI only for a .spine project"],
    steps: ["spine_create_skeleton for JSON-only work, or spine_create_project when a new .spine file is required.",
      "spine_preview_edit to stage the rig, attachments, and initial animation together.",
      "spine_commit_edit after reviewing the diff and diagnostics."],
  },
  round_trip: {
    useWhen: "Edit an existing .spine project and verify the new project in one call.",
    primaryTools: ["spine_round_trip_edit"],
    needs: [".spine project", "saved JSON export settings with nonessential: true",
      "saved PNG export settings", "animation name", "edit operations", "licensed Spine CLI and display/OpenGL"],
    steps: ["spine_round_trip_edit exports, stages, imports a new project, re-exports, validates, and renders both versions.",
      "Read contactSheetUri and pairs, then inspect importedProject.path and the run manifest."],
  },
  new_motion: {
    useWhen: "Generate a new idle, blink, breathing, walk, run, recoil, or follow-through clip from a rig.",
    primaryTools: ["spine_generate_motion"],
    needs: ["Spine 4.2 or 4.3 skeleton JSON", "mapped rig bones or slot", "recipe parameters"],
    steps: ["spine_inspect_project to find valid rig names.", "spine_generate_motion to stage the clip.",
      "spine_render_staged_edit for frames; spine_analyze_motion_quality for walk/run contact intervals.",
      "spine_commit_edit after reviewing the diff and frames."],
  },
  edit_json: {
    useWhen: "Make a coordinated JSON edit without running the full .spine round trip.",
    primaryTools: ["spine_preview_edit", "spine_commit_edit"],
    needs: ["Spine 4.2 or 4.3 skeleton JSON", "one or more edit operations"],
    steps: ["spine_inspect_project and spine_inspect_animation to find targets.",
      "Use a named spine edit tool for one operation, or spine_preview_edit to stage up to 20 related operations together.",
      "spine_compare_previews when PNG export settings and a licensed Spine CLI are available.",
      "spine_commit_edit to save the selected stage."],
  },
  reuse_pose: {
    useWhen: "Capture a pose and apply it to another animation or compatible rig.",
    primaryTools: ["spine_save_pose", "spine_apply_pose"],
    needs: ["source skeleton JSON and animation", "sample time", "target skeleton JSON and animation"],
    steps: ["spine_save_pose and spine_apply_pose for bone transforms plus slot attachments.",
      "Use spine_save_bone_pose and spine_apply_bone_pose for bone channels only, or the mesh pose pair for deform timelines.",
      "Review the staged diff, then spine_commit_edit."],
  },
  review_motion: {
    useWhen: "Check a rendered clip, especially loop seams and foot contact.",
    primaryTools: ["spine_check_animation", "spine_render_preview", "spine_analyze_motion_quality"],
    needs: ["skeleton JSON", "animation", "licensed Spine CLI and display/OpenGL for rendered checks"],
    steps: ["spine_check_animation for structural diagnostics without rendering.",
      "spine_render_preview or spine_render_staged_edit to obtain previewId when visual checks are needed.",
      "spine_analyze_motion_quality for contact drift hints; inspect the PNG frames yourself."],
  },
  batch_export: {
    useWhen: "Repeat saved export settings or animation edits across projects.",
    primaryTools: ["spine_manage_export_profile", "spine_run_export_profile", "spine_batch_job"],
    needs: ["export settings or selected project/animation targets"],
    steps: ["spine_manage_export_profile to save data, media, or atlas settings; spine_run_export_profile to produce a hashed run.",
      "spine_batch_job to stage or commit one supported edit across selected JSON projects."],
  },
} as const;

export type WorkflowGoal = "choose" | keyof typeof WORKFLOWS;

export function workflowGuide(goal: WorkflowGoal = "choose") {
  if (goal === "choose") return { startHere: "Choose by source file and desired output, then call the matching goal for steps.",
    workflows: Object.entries(WORKFLOWS).map(([name, guide]) => ({ name, useWhen: guide.useWhen, primaryTools: guide.primaryTools })) };
  return { goal, ...WORKFLOWS[goal] };
}
