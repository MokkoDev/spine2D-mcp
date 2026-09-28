# Agent guide

## Start here

For a Spine 4.2 or 4.3 skeleton JSON export, follow [the short inspect → edit → preview → commit tutorial](docs/reference/start-here.md). In an MCP client, read `spine-docs://reference/start-here` or call `spine_get_reference` with `slug: "start-here"`.

Use `spine_search_reference` to find one task-specific guide, then fetch that page by slug or resource URI. Call `spine_workflow_guide` with `goal: "choose"` when the right workflow is unclear. `spine_capabilities` finds specialized tools; [FUNCTIONS.md](FUNCTIONS.md) gives exact inputs, outputs, and limits. Only tools marked **Implemented** are registered.

## Project map

Spine2D MCP is a Node.js 20+ TypeScript stdio server. `src/index.ts` starts it; `src/server.ts` registers typed MCP tools and resources; `src/catalog.ts` lists capabilities; `src/reference.ts` serves the task guides; `src/workflow-guide.ts` provides task sequences. `src/spine/document.ts`, `validate.ts`, and `edit.ts` handle parsing, validation, and staged persistence. Edit `src/`, not generated `dist/`.

The guides in `docs/reference/` cover inspection, JSON edits, preview and commit, existing `.spine` project round trips, rig creation, motion reuse, and production batch/export work. The full function catalog covers the other specialized operations.

## Editing rules

JSON creation, inspection, and editing work without Spine. Editing is limited to tested Spine 4.2 and 4.3 JSON exports. All JSON edits stage first. Read `diagnostics` and `diffResourceUri`, then call `spine_commit_edit` with the chosen `editId`. Commit checks the source hash and stores exact before and after copies plus a manifest in `.spine2d-mcp/history/` beside the JSON. Stages persist for seven days in `~/.local/state/spine2d-mcp/stages/`, or under `SPINE_MCP_STATE_DIR`. Retry a `COMMIT_FINALIZATION_FAILED` edit with the same ID.

Creating or importing `.spine` projects and rendering PNGs require a licensed Spine CLI. Rendering also needs images and a display with OpenGL. For editor reimport, use saved JSON export settings with `class: "export-json"` and `nonessential: true`. The CLI cannot edit an open `.spine` project; export JSON and import the edited data into a **new** project. Use `spine_round_trip_edit` to check production editor fidelity and visual changes.

Supporting clients can defer MCP tool schema loading; the stdio server keeps its typed tools. See the [client setup notes](README.md#deferred-tool-search-in-supporting-clients).

## Development and verification

Run `npm ci` and `npm test` for ordinary development; `npm test` builds first. `npm run dev` starts the TypeScript server directly. `npm run test:examples` downloads pinned official Spine 4.2 and 4.3 JSON fixtures. With a licensed CLI and a display with OpenGL, run `SPINE_CLI_PATH=/absolute/path/to/Spine npm run test:cli`; it uses a temporary directory and pinned Spineboy data and images.

`install.sh` runs `npm ci` and the offline tests, then registers this checkout's `startup.sh` with Codex and Claude Code. It prompts for a scope directory: an empty answer uses global client registration; a directory writes project MCP config there and in existing nested Git repositories. `uninstall.sh` uses the same prompt. Scoped install uses Bash and Git and marks the scope's Git repositories trusted in Codex. Claude Code may ask for project MCP approval on first use. It saves an optional CLI path in `.spine2d-mcp-cli-path`. Keep the checkout path stable while registered. The generated `.codex/` directory is Git ignored.
