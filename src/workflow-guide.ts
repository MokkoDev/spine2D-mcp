export const CLEANUP_GUIDANCE = "After work and any pending review finish, remove temporary files unless useful later.";
export const RIG_ASSEMBLY_RULE = "For new or revised rigs from separate images, connect every nonroot part to a parent landmark, place art and joints, set draw order, and save the full draft with spine_save_rig_draft. An unconnected starter manifest is not ready for review.";
export const RIG_CONFIRMATION_RULE = "Show the connected preview, editable review link, bone hierarchy, joints, attachment placement, and draw order. Ask whether the user approves the rig shown, including any edits they save in that linked editor before replying; then end your turn. While awaiting a reply, do not build, poll, sleep, or keep the turn active. A new user message approving after the last save authorizes spine_build_rig_from_landmarks with spine_preview_rig's reviewId. Valid editor saves keep that reviewId current if the source PNGs are unchanged. Changes outside the editor or after approval require a new preview and approval. A draft, tool result, or elapsed time is not approval.";
export const RIG_READY_NEXT_ACTION = `Call spine_preview_rig and inspect the setup and bend snapshots. ${RIG_CONFIRMATION_RULE}`;
export const RIG_INCOMPLETE_NEXT_ACTION = `Use the returned manifest and sourceHash. ${RIG_ASSEMBLY_RULE} Resolve all connection and build errors. ${RIG_READY_NEXT_ACTION}`;

export const SERVER_INSTRUCTIONS = [
  "Read spine-docs://reference/start-here; use spine_search_reference for task guides, spine_workflow_guide({goal:'choose'}) for workflows, and spine_capabilities for tools.",
  "For separate-image rigs, connect and preview the full draft; show it, ask approval, then end your turn. While awaiting approval, do not build, poll, or sleep. The user may edit and save in the linked browser editor; build the last saved rig only after a new user message approves it. Other changes require a new preview.",
  "For JSON edits, review the staged edit's diagnostics and net diff; revise with spine_preview_edit and baseEditId if needed, then commit the chosen editId.",
  "Use spine_round_trip_edit for existing .spine projects; use spine_finalize_animation for reviewed JSON delivery.",
  CLEANUP_GUIDANCE,
].join(" ");

const WORKFLOWS = {
  inspect: {
    useWhen: "Inspect skeleton JSON or diagnose its structure before editing.",
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
    steps: ["For separate images, use rig_review. Multi-part JSON commits and imports require a build from a reviewed preview in this server session.",
      "Use spine_create_skeleton for JSON or spine_create_project for a new .spine file.",
      "Stage the rig, attachments, and initial animation together with spine_preview_edit.",
      "Review diff and diagnostics, then spine_commit_edit."],
  },
  rig_review: {
    useWhen: "Place joints on PNG parts and assemble a rig for a native .spine project.",
    primaryTools: ["spine_start_rig_review", "spine_save_rig_draft", "spine_validate_rig_manifest", "spine_preview_rig", "spine_build_rig_from_landmarks"],
    needs: ["PNG images directory", "Spine 4.2 or 4.3 version", "output directory", "licensed Spine CLI for a .spine project and atlas"],
    steps: ["spine_start_rig_review inventories PNGs and opens the local editor; starter parts may be unconnected.",
      "Use its manifest and sourceHash. The editor autosaves and supports Undo/Redo; individual landmarks and draw order need no separate confirmation.",
      RIG_ASSEMBLY_RULE,
      "Reload the editor URL after MCP draft saves; resolve all validation errors. Browser edits must show Saved before chat approval.",
      RIG_READY_NEXT_ACTION],
  },
  round_trip: {
    useWhen: "Edit an existing .spine project, including rig structure, and verify a new sibling project.",
    primaryTools: ["spine_round_trip_edit"],
    needs: [".spine project", "saved JSON export settings with nonessential: true",
      "saved PNG export settings", "animation name", "edit operations", "licensed Spine CLI and display/OpenGL"],
    steps: ["Pass the source project and edit operations; add outputProjectPath for a new .spine sibling.",
      "spine_round_trip_edit exports the source, stages edits, reports rigDiff, imports, re-exports, and renders both versions.",
      "Inspect rigDiff, fidelity, contactSheetUri, pairs, and the run manifest. The source stays unchanged; imported siblings may omit editor-only project details."],
  },
  final_delivery: {
    useWhen: "Deliver reviewed JSON as a native .spine project and two previews.",
    primaryTools: ["spine_finalize_animation"],
    needs: ["reviewed Spine JSON", "saved JSON and PNG export settings", "animation name",
      "images or an atlas", "licensed Spine CLI and display/OpenGL"],
    steps: ["After review and commit, call spine_finalize_animation with the JSON path and export settings.",
      "It verifies the re-export, renders frames, and creates a contact sheet and HTML player in a new project.",
      "Replacing a matching original requires replaceExistingProject: true and creates a backup; JSON import can lose editor-only project details.",
      "Deliver projectPath, htmlPath, and contactSheetPath together; inspect previewReview hints and full manifest review when needed."],
  },
  new_motion: {
    useWhen: "Generate a new idle, blink, breathing, walk, run, recoil, or follow-through clip from a rig.",
    primaryTools: ["spine_generate_motion"],
    needs: ["Spine 4.2 or 4.3 skeleton JSON", "mapped rig bones or slot", "recipe parameters"],
    steps: ["spine_inspect_project to find valid rig names.", "spine_generate_motion to stage the clip.",
      "Render with spine_render_staged_edit. For a walk or run, pass the returned motion.gaitReview to spine_analyze_motion_quality with previewId and editId; inspect its inferred foot targets and stance windows.",
      "Revise the staged result with spine_preview_edit using baseEditId; render each revision and review its net diff.",
      "spine_commit_edit with only the chosen editId after reviewing its diff and frames."],
  },
  edit_json: {
    useWhen: "Make a coordinated JSON edit without running the full .spine round trip.",
    primaryTools: ["spine_preview_edit", "spine_commit_edit"],
    needs: ["Spine 4.2 or 4.3 skeleton JSON", "one or more edit operations"],
    steps: ["spine_inspect_project and spine_inspect_animation to find targets.",
      "For rig changes from separate images, follow the rig_review workflow before committing.",
      "Use a named spine edit tool for one operation, or spine_preview_edit to stage up to 20 related operations together.",
      "spine_compare_previews when PNG export settings and a licensed Spine CLI are available.",
      "For later edits, switch from named tools to spine_preview_edit with baseEditId; render revisions and review the net diff.",
      "spine_commit_edit to save only the chosen editId."],
  },
  reuse_pose: {
    useWhen: "Capture a pose and apply it to another animation or compatible rig.",
    primaryTools: ["spine_save_pose", "spine_apply_pose"],
    needs: ["source skeleton JSON and animation", "sample time", "target skeleton JSON and animation"],
    steps: ["spine_save_pose and spine_apply_pose for bone transforms plus slot attachments.",
      "Use the bone, mesh, or constraint pose pairs for those specific channels; spine_capture_constraint_pose and spine_apply_constraint_pose map constraint names by type.",
      "Review the staged diff, then spine_commit_edit."],
  },
  review_motion: {
    useWhen: "Check a rendered clip, especially loop seams and contact with the ground.",
    primaryTools: ["spine_check_animation", "spine_render_preview", "spine_analyze_motion_quality"],
    needs: ["skeleton JSON", "animation", "licensed Spine CLI and display/OpenGL for rendered checks"],
    steps: ["spine_check_animation for structural diagnostics without rendering.",
      "spine_render_preview or spine_render_staged_edit to obtain previewId when visual checks are needed.",
      "spine_analyze_motion_quality for rig-attached or visual contact hints; gaitReview can estimate walk or run foot plants from the leg bones. Inspect the PNG frames yourself."],
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
