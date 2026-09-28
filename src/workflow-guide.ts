export type WorkflowGoal = "choose" | "round_trip" | "new_motion" | "edit_json" | "review_motion" | "batch_export";

const WORKFLOWS = {
  round_trip: {
    useWhen: "Edit an existing .spine project and verify the new project in one call.",
    needs: [".spine project", "saved JSON export settings with nonessential: true",
      "saved PNG export settings", "animation name", "edit operations", "licensed Spine CLI and display/OpenGL"],
    steps: ["spine_round_trip_edit exports, stages, imports a new project, re-exports, validates, and renders both versions.",
      "Read contactSheetUri and pairs, then inspect importedProject.path and the run manifest."],
  },
  new_motion: {
    useWhen: "Generate a new idle, blink, breathing, walk, run, recoil, or follow-through clip from a rig.",
    needs: ["Spine 4.2 or 4.3 skeleton JSON", "mapped rig bones or slot", "recipe parameters"],
    steps: ["spine_inspect_project to find valid rig names.", "spine_generate_motion to stage the clip.",
      "spine_render_staged_edit for frames; spine_analyze_motion_quality for walk/run contact intervals.",
      "spine_commit_edit after reviewing the diff and frames."],
  },
  edit_json: {
    useWhen: "Make a coordinated JSON edit without running the full .spine round trip.",
    needs: ["Spine 4.2 or 4.3 skeleton JSON", "one or more edit operations"],
    steps: ["spine_inspect_project and spine_inspect_animation to find targets.",
      "spine_preview_edit to stage and validate up to 20 operations.",
      "spine_compare_previews when PNG export settings and a licensed Spine CLI are available.",
      "spine_commit_edit to save the selected stage."],
  },
  review_motion: {
    useWhen: "Check a rendered clip, especially loop seams and foot contact.",
    needs: ["skeleton JSON", "animation", "rendered preview ID", "contact regions for foot review"],
    steps: ["spine_render_preview or spine_render_staged_edit to obtain previewId.",
      "spine_analyze_motion_quality to combine structural checks with contact drift hints.",
      "Inspect the PNG frames; image-region drift cannot prove foot planting."],
  },
  batch_export: {
    useWhen: "Repeat saved export settings or animation edits across projects.",
    needs: ["export settings or selected project/animation targets"],
    steps: ["spine_manage_export_profile to save data, media, or atlas settings; spine_run_export_profile to produce a hashed run.",
      "spine_batch_job to stage or commit one supported edit across selected JSON projects."],
  },
} as const;

export function workflowGuide(goal: WorkflowGoal = "choose") {
  if (goal === "choose") return { startHere: "Choose the task that matches your source and desired output.",
    workflows: Object.entries(WORKFLOWS).map(([name, guide]) => ({ name, useWhen: guide.useWhen })) };
  return { goal, ...WORKFLOWS[goal] };
}
