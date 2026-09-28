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

When asked, enter the Spine executable or installation directory. On the first install, press Enter to skip it if you only need JSON tools. On later runs, Enter keeps the saved path and `-` clears it. For an unattended install, set the path first:

```sh
SPINE_CLI_PATH=/absolute/path/to/Spine.sh ./install.sh
```

The installer registers this checkout with Codex and Claude Code. Keep the checkout at the same path, and restart any open client session after installing.

## Run

Open Codex or Claude Code and use the registered `spine2d-mcp` server. For another MCP client, run `npm ci` and `npm run build`, then set its server command to this checkout's absolute `startup.sh` path. Set `SPINE_CLI_PATH` in that client if you need Spine tools.

For local development, run:

```sh
npm ci
npm run dev
```

The server waits for an MCP client on standard input. To run the built version, use `npm run build` followed by `./startup.sh`.
