export const CLEANUP_GUIDANCE = "After the work and any pending review are complete, remove temporary files and folders unless they will be useful later.";
export const RIG_ASSEMBLY_RULE = "For a new or revised rig made from separate images, attach every part to a parent landmark, place its art and joints, set draw order, and save the complete draft with spine_save_rig_draft. An unconnected starter manifest is not ready for review.";
export const RIG_CONFIRMATION_RULE = "Show the connected preview, editable review link, bone hierarchy, joints, attachment placement, and draw order to the user. End the turn and wait for a new user message explicitly confirming the complete rig before building or committing it. A saved draft, tool result, or elapsed time is not confirmation. Do not do other work while waiting.";
export const RIG_READY_NEXT_ACTION = `Call spine_preview_rig and inspect the setup and bend snapshots. ${RIG_CONFIRMATION_RULE}`;
export const RIG_INCOMPLETE_NEXT_ACTION = `Use the returned manifest and sourceHash. ${RIG_ASSEMBLY_RULE} Resolve all connection and build errors. ${RIG_READY_NEXT_ACTION}`;

export const SERVER_INSTRUCTIONS = [
  "Read spine-docs://reference/start-here for the short inspect, edit, preview, commit tutorial.",
  "Use spine_search_reference to find a task page; fetch it with spine_get_reference or MCP resources/read.",
  "Call spine_workflow_guide({goal:'choose'}) if the workflow is unclear, or spine_capabilities to find a specialized typed tool.",
  CLEANUP_GUIDANCE,
  RIG_ASSEMBLY_RULE,
  RIG_READY_NEXT_ACTION,
  "For related JSON changes, spine_preview_edit stages a validated edit. Review diagnostics and diff before spine_commit_edit saves it.",
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
    steps: ["For rigging from separate images, select the rig_review workflow.",
      "spine_create_skeleton for JSON-only work, or spine_create_project when a new .spine file is required.",
      "spine_preview_edit to stage the rig, attachments, and initial animation together.",
      "spine_commit_edit after reviewing the diff and diagnostics."],
  },
  rig_review: {
    useWhen: "Place joints on separate PNG body parts, assemble a character, and create a native .spine project.",
    primaryTools: ["spine_start_rig_review", "spine_save_rig_draft", "spine_validate_rig_manifest", "spine_preview_rig", "spine_build_rig_from_landmarks"],
    needs: ["PNG images directory", "Spine 4.2 or 4.3 version", "output directory", "licensed Spine CLI for a .spine project and atlas"],
    steps: ["spine_start_rig_review inventories PNGs and opens the local part and assembly editor. Its starter manifest may have unconnected parts.",
      "Use the returned manifest and sourceHash. The editor autosaves and supports Undo and Redo. No separate confirmation is needed for individual landmarks or draw order.",
      RIG_ASSEMBLY_RULE,
      "Reload the editor URL after saving.",
      "Resolve all validation errors.",
      RIG_READY_NEXT_ACTION,
      "After confirmation, spine_build_rig_from_landmarks creates new JSON and optionally a native .spine project."],
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
      "For rig changes from separate images, follow the rig_review workflow before committing.",
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
  if (goal === "choose") return { startHere: "Read spine-docs://reference/start-here, then choose by source file and desired output. For rigging from separate images, select rig_review. Use spine_search_reference for detailed examples.",
    cleanupGuidance: CLEANUP_GUIDANCE,
    workflows: Object.entries(WORKFLOWS).map(([name, guide]) => ({ name, useWhen: guide.useWhen, primaryTools: guide.primaryTools })) };
  return { goal, ...WORKFLOWS[goal], cleanupGuidance: CLEANUP_GUIDANCE };
}
