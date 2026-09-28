#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
startup="$project_dir/startup.sh"
server_name="spine2d-mcp"
cli_path_file="$project_dir/.spine2d-mcp-cli-path"

for program in node npm codex claude; do
  if ! command -v "$program" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$program" >&2
    exit 1
  fi
done

# Check both clients before changing either registration. Existing entries with
# this name must point at this checkout, so another server is never replaced.
codex_registered=0
if codex_details="$(codex mcp get --json "$server_name" 2>/dev/null)"; then
  if [[ "$codex_details" != *"$startup"* ]]; then
    printf 'Codex already has a different MCP server named %s.\n' "$server_name" >&2
    exit 1
  fi
  codex_registered=1
fi

claude_registered=0
if claude_details="$(claude mcp get "$server_name" 2>/dev/null)"; then
  if [[ "$claude_details" != *"$startup"* ]]; then
    printf 'Claude already has a different MCP server named %s.\n' "$server_name" >&2
    exit 1
  fi
  claude_registered=1
fi

saved_cli=""
if [[ -f "$cli_path_file" ]]; then
  IFS= read -r saved_cli < "$cli_path_file" || true
fi
requested_cli="${SPINE_CLI_PATH:-$saved_cli}"
if [[ -t 0 && -z "${SPINE_CLI_PATH:-}" ]]; then
  if [[ -n "$saved_cli" ]]; then
    printf 'Spine CLI executable or directory [%s] (Enter to keep, - to clear): ' "$saved_cli"
  else
    printf 'Spine CLI executable or directory (Enter to skip): '
  fi
  IFS= read -r answer
  if [[ "$answer" == "-" ]]; then
    requested_cli=""
  elif [[ -n "$answer" ]]; then
    requested_cli="$answer"
  fi
fi

spine_cli=""
if [[ -n "$requested_cli" ]]; then
  if [[ -d "$requested_cli" ]]; then
    for name in Spine.sh Spine Spine.com; do
      if [[ -f "$requested_cli/$name" && -x "$requested_cli/$name" ]]; then
        spine_cli="$(realpath -- "$requested_cli/$name")"
        break
      fi
    done
    if [[ -z "$spine_cli" ]]; then
      printf 'No Spine CLI executable found in: %s\n' "$requested_cli" >&2
      exit 1
    fi
  elif [[ -f "$requested_cli" && -x "$requested_cli" ]]; then
    spine_cli="$(realpath -- "$requested_cli")"
  else
    printf 'Spine CLI path is not an executable or directory: %s\n' "$requested_cli" >&2
    exit 1
  fi
fi

cd -- "$project_dir"
npm ci
npm test

node_bin="$(command -v node)"
codex_env_args=(--env "SPINE2D_MCP_NODE=$node_bin")
claude_env_args=(-e "SPINE2D_MCP_NODE=$node_bin")
codex_added=0
if (( ! codex_registered )); then
  codex mcp add "$server_name" "${codex_env_args[@]}" -- "$startup"
  codex_added=1
fi

if (( ! claude_registered )); then
  if ! claude mcp add --scope user "$server_name" "${claude_env_args[@]}" -- "$startup"; then
    if (( codex_added )); then
      codex mcp remove "$server_name" || true
    fi
    printf 'Claude registration failed. Any new Codex registration was rolled back.\n' >&2
    exit 1
  fi
fi

printf '%s\n' "$spine_cli" > "$cli_path_file"

printf 'Installed %s for Codex and Claude Code.\n' "$server_name"
if [[ -n "$spine_cli" ]]; then
  printf 'Spine CLI path saved for startup.sh: %s\n' "$spine_cli"
else
  printf 'No Spine CLI path saved; JSON-only tools are available.\n'
fi
