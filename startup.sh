#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
entry_point="$project_dir/dist/index.js"
cli_path_file="$project_dir/.spine2d-mcp-cli-path"

if [[ ! -f "$entry_point" ]]; then
  printf 'Spine2D MCP is not built. Run %s/install.sh first.\n' "$project_dir" >&2
  exit 1
fi

node_bin="${SPINE2D_MCP_NODE:-}"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  node_bin="$(command -v node || true)"
fi
if [[ -z "$node_bin" ]]; then
  printf 'Node.js is required to start Spine2D MCP.\n' >&2
  exit 1
fi

if [[ -z "${SPINE_CLI_PATH:-}" && -f "$cli_path_file" ]]; then
  IFS= read -r SPINE_CLI_PATH < "$cli_path_file" || true
  export SPINE_CLI_PATH
fi

cd -- "$project_dir"
exec "$node_bin" "$entry_point"
