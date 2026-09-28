# Agent guide

## Start here

For a Spine 4.2 or 4.3 skeleton JSON export, follow [the short inspect → edit → preview → commit tutorial](docs/reference/start-here.md). In an MCP client, read `spine-docs://reference/start-here` or call `spine_get_reference` with `slug: "start-here"`.

Use `spine_search_reference` to find one task-specific guide, then fetch that page by slug or resource URI. Call `spine_workflow_guide` with `goal: "choose"` when the right workflow is unclear. `spine_capabilities` finds specialized tools; [FUNCTIONS.md](FUNCTIONS.md) gives exact inputs, outputs, and limits. Only tools marked **Implemented** are registered.

## Project map

Spine2D MCP is a Node.js 20+ TypeScript stdio server. `src/index.ts` starts it; `src/server.ts` registers typed MCP tools and resources; `src/catalog.ts` lists capabilities; `src/reference.ts` serves the task guides; `src/workflow-guide.ts` provides task sequences. `src/spine/document.ts`, `validate.ts`, and `edit.ts` handle parsing, validation, and staged persistence. Edit `src/`, not generated `dist/`.

The guides in `docs/reference/` cover inspection, JSON edits, preview and commit, existing `.spine` project round trips, rig creation, motion reuse, and production batch/export work. The full function catalog covers the other specialized operations.

## Editing rules

JSON creation, inspection, and editing work without Spine. Editing is limited to tested Spine 4.2 and 4.3 JSON exports. Stage JSON edits, review diagnostics and diff, then commit the selected stage. [Preview and commit](docs/reference/preview-commit.md) describes persistence, history, and retry behavior.

Creating or importing `.spine` projects and rendering PNGs require a licensed Spine CLI. Rendering also needs images and a display with OpenGL. [Edit an existing Spine project](docs/reference/round-trip.md) documents reimport settings, review candidates, and final delivery to a matching existing project.

Supporting clients can defer MCP tool schema loading; the stdio server keeps its typed tools. See the [client setup notes](README.md#deferred-tool-search-in-supporting-clients).

## Keep guidance in one place

Give each rule, procedure, and example one authoritative home for its audience. Runtime rig assembly and confirmation wording lives in `src/workflow-guide.ts`; the human-facing procedure lives in [Create a skeleton and rig](docs/reference/create-rig.md). Other entry points should give a short pointer or use the exported runtime wording instead of copying the full sequence. Keep browser and server placement calculations in `calculateRigPlacements` and common draft checks in `src/spine/rig-review.ts`. The capability catalog may keep short searchable purposes, while tool registrations describe their inputs and limits. Link to the detailed guide when a second audience needs context, and update all callers when a shared rule changes.

## Development and verification

Run `npm ci` and `npm test` for ordinary development; `npm test` builds first. `npm run dev` starts the TypeScript server directly. `npm run test:examples` downloads pinned official Spine 4.2 and 4.3 JSON fixtures. With a licensed CLI and a display with OpenGL, run `SPINE_CLI_PATH=/absolute/path/to/Spine npm run test:cli`; it uses a temporary directory and pinned Spineboy data and images.

For installation and registration details, follow the [README](README.md#install). Keep the checkout path stable while registered.
