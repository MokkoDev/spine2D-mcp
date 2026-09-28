#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
startup="$project_dir/startup.sh"
server_name="spine2d-mcp"

for program in codex claude; do
  if ! command -v "$program" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$program" >&2
    exit 1
  fi
done

# Refuse to remove a same-named server registered from another checkout.
codex_registered=0
if codex_details="$(codex mcp get --json "$server_name" 2>/dev/null)"; then
  if [[ "$codex_details" != *"$startup"* ]]; then
    printf 'Codex entry %s points elsewhere; leaving it untouched.\n' "$server_name" >&2
    exit 1
  fi
  codex_registered=1
fi

claude_registered=0
if claude_details="$(claude mcp get "$server_name" 2>/dev/null)"; then
  if [[ "$claude_details" != *"$startup"* ]]; then
    printf 'Claude entry %s points elsewhere; leaving it untouched.\n' "$server_name" >&2
    exit 1
  fi
  claude_registered=1
fi

if (( codex_registered )); then
  codex mcp remove "$server_name"
fi
if (( claude_registered )); then
  claude mcp remove --scope user "$server_name"
fi

rm -rf -- "$project_dir/dist" "$project_dir/node_modules"
printf 'Uninstalled %s from Codex and Claude Code and removed build files and dependencies.\n' "$server_name"
