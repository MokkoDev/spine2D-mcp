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

The installer registers this checkout with Codex and Claude Code. Keep the checkout at the same path, and restart any open client session after installing.
Scoped installation uses Bash, Git, Codex, and Claude Code. It creates local `.codex/config.toml` and `.mcp.json` files in the chosen directory, adds Codex config links in existing nested Git repositories, and trusts those repositories in Codex. Claude Code may ask you to approve a new project MCP server the first time you use it. The generated `.codex/` directory is ignored by Git. Rerun the scoped installer after adding a new nested Git repository.

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

Follow the [start-here guide](docs/reference/start-here.md) or read its MCP resource `spine-docs://reference/start-here` for the inspect, edit, preview, and commit sequence. Call `spine_search_reference` with a task or tool name, then fetch the returned slug with `spine_get_reference` or read its resource URI for focused examples. `spine_workflow_guide` with `goal: "choose"` gives task-based entry points; `spine_capabilities` finds specialized typed tools. [FUNCTIONS.md](FUNCTIONS.md) is the full schema and limits catalog.

For final animation delivery, `spine_finalize_animation` takes reviewed JSON, updates a matching existing `.spine` project when present, and returns sampled frame links, a contact sheet, and an HTML player preview in one result. See the [final delivery guide](docs/reference/round-trip.md#final-delivery-from-reviewed-json).

### Deferred tool search in supporting clients

The MCP server continues to publish typed schemas for every implemented tool. A client controls whether those schemas enter the model context eagerly or through tool search. For an OpenAI Responses API client connected to a **remote** deployment of this server (or a Secure MCP Tunnel), configure the MCP tool and `tool_search` together:

```json
{
  "tools": [
    {"type":"tool_search"},
    {"type":"mcp","server_label":"spine2d-mcp","server_description":"Inspect, stage, preview, and commit Spine 4.2/4.3 skeleton edits; includes task guides and reference search.","server_url":"https://YOUR-MCP-ENDPOINT/mcp","defer_loading":true}
  ]
}
```

`defer_loading` is a **client request setting**, not a server registration flag. The local `startup.sh` is a stdio server; it cannot be used as `server_url` directly. Codex and Claude Code registrations made by `install.sh` use their own MCP loading behavior. See the [OpenAI tool search guide](https://developers.openai.com/api/docs/guides/tools-tool-search) and [MCP server guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).
