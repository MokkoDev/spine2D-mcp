# Agent guide

## Start here

For Spine 4.2/4.3 skeleton JSON, follow [inspect → edit → preview → commit](docs/reference/start-here.md). In MCP, read `spine-docs://reference/start-here` or call `spine_get_reference` with `slug: "start-here"`. Use `spine_search_reference` for a task guide, then fetch its slug or resource URI. Use `spine_workflow_guide` with `goal: "choose"` when unsure of the workflow; `spine_capabilities` finds tools. [FUNCTIONS.md](FUNCTIONS.md) lists exact inputs, outputs, and limits. Only **Implemented** tools are registered.

## Project map

This is a Node.js 20+ TypeScript stdio server. `src/index.ts` starts it; `src/server.ts` registers tools and resources; `src/catalog.ts` lists capabilities; `src/reference.ts` serves guides; `src/workflow-guide.ts` defines task sequences. `src/spine/document.ts`, `validate.ts`, and `edit.ts` handle parsing, validation, and staged persistence. Edit `src/`, not generated `dist/`.

`docs/reference/` covers inspection, JSON editing, preview/commit, `.spine` round trips, rig creation, motion reuse, and batch/export work. [FUNCTIONS.md](FUNCTIONS.md) covers specialized operations.

## Editing rules

JSON creation, inspection, and editing work without Spine; edits support tested Spine 4.2/4.3 JSON exports. Stage edits, review diagnostics and diff, then commit the chosen stage. [Preview and commit](docs/reference/preview-commit.md) covers persistence, history, and retries.

Creating or importing `.spine` projects and rendering PNGs require a licensed Spine CLI; rendering also needs images and an OpenGL display. [Round trips](docs/reference/round-trip.md) covers reimport settings, candidate review, and delivery to a matching project. Supporting clients can defer MCP tool schemas while the stdio server keeps typed tools; see [client setup](README.md#deferred-tool-search-in-supporting-clients).

## Keep model-visible text concise

Cut filler and repetition from model-visible instructions, tool/resource descriptions, results, diagnostics, and docs. Preserve behavior, limits, identifiers, examples, recovery steps, MCP schemas, and result fields. Centralize rules; link or reuse them elsewhere. Keep server instructions short because clients may repeat them per tool. Compare word counts; favor clarity over brevity.

Runtime rig assembly and confirmation wording belongs in `src/workflow-guide.ts`; the human procedure belongs in [Create a skeleton and rig](docs/reference/create-rig.md). Other entry points should link or reuse the runtime wording. Keep browser/server placement calculations in `calculateRigPlacements` and draft checks in `src/spine/rig-review.ts`. Keep catalog purposes short and searchable; describe tool inputs and limits in registrations. Update callers when shared rules change.

## Development

Run `npm ci` and `npm test`; tests build first. `npm run dev` starts TypeScript directly. `npm run test:examples` downloads pinned official Spine 4.2/4.3 JSON fixtures. With a licensed CLI and OpenGL display, run `SPINE_CLI_PATH=/absolute/path/to/Spine npm run test:cli`; it uses a temporary directory and pinned Spineboy data/images. Follow the [README](README.md#install) for installation and registration; keep the registered checkout path stable.
