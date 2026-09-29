# Spine2D MCP

An MCP server for inspecting and editing Spine 2D animations.

## Requirements

- Node.js 20 or newer and npm
- Codex CLI and Claude Code CLI for the installer

Spine is optional for JSON work. Creating `.spine` projects and rendering PNG previews need a licensed Spine installation; rendering also needs a display with OpenGL.

## Install

```sh
./install.sh
```

The installer asks for a scope directory. Press Enter for global registration, or enter a directory such as `/work/Projects/Gamedev` to make the server available only there and in its subdirectories, including existing nested Git repositories.

When asked, enter the Spine executable or installation directory. On the first install, press Enter to skip it if you only need JSON tools. On later runs, Enter keeps the saved path and `-` clears it. For an unattended install, set the path first:

```sh
SPINE_CLI_PATH=/absolute/path/to/Spine.sh ./install.sh
```

The installer registers this checkout with Codex and Claude Code. Keep its path stable and restart open client sessions. Scoped installation needs Bash, Git, Codex, and Claude Code. It creates `.codex/config.toml` and `.mcp.json` in the chosen directory, links Codex config in existing nested Git repositories, and trusts them in Codex. Claude Code may request first-use approval. Git ignores the generated `.codex/` directory. Rerun the scoped installer after adding a nested Git repository.

Run `./uninstall.sh` and press Enter to remove global registrations and build files, or enter a directory to remove only this server from that scope. Scoped uninstall keeps the runtime because another scope may use it.

## Run

Open Codex or Claude Code and use the registered `spine2d-mcp` server. For another MCP client, run `npm ci` and `npm run build`, then set its server command to this checkout's absolute `startup.sh` path. Set `SPINE_CLI_PATH` in that client if you need Spine tools.

For local development, run:

```sh
npm ci
npm run dev
```

The server waits for an MCP client on standard input. To run the built version, use `npm run build` followed by `./startup.sh`.

## Start here

Read the [start-here guide](docs/reference/start-here.md) or `spine-docs://reference/start-here` for inspect, edit, preview, and commit. Find focused examples with `spine_search_reference`, then fetch a slug through `spine_get_reference` or its resource URI. `spine_workflow_guide` with `goal: "choose"` selects an entry path; `spine_capabilities` finds tools. [FUNCTIONS.md](FUNCTIONS.md) lists schemas and limits.

For final delivery, `spine_finalize_animation` takes reviewed JSON, updates a matching `.spine` project if present, and returns sampled frames, a contact sheet, and an HTML player. See the [delivery guide](docs/reference/round-trip.md#final-delivery-from-reviewed-json).

### Deferred tool search in supporting clients

The server publishes typed schemas for every tool. Clients choose eager loading or tool search. For an OpenAI Responses API client connected to a **remote** deployment (or Secure MCP Tunnel), configure MCP with `tool_search`:

```json
{
  "tools": [
    {"type":"tool_search"},
    {"type":"mcp","server_label":"spine2d-mcp","server_description":"Inspect, stage, preview, and commit Spine 4.2/4.3 skeleton edits; includes task guides and reference search.","server_url":"https://YOUR-MCP-ENDPOINT/mcp","defer_loading":true}
  ]
}
```

`defer_loading` is a **client request setting**, not a server flag. Local `startup.sh` uses stdio and cannot be a `server_url`; Codex and Claude Code registrations use their own loading behavior. See the [OpenAI tool search guide](https://developers.openai.com/api/docs/guides/tools-tool-search) and [MCP server guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).
