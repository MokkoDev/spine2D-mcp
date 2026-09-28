#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
startup="$project_dir/startup.sh"
server_name="spine2d-mcp"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  printf 'Usage: %s\n' "$0"
  printf 'Enter a directory when prompted to remove that scope; press Enter to remove global registrations and build files.\n'
  exit 0
fi
if (( $# != 0 )); then
  printf 'Usage: %s (enter the scope directory at the prompt)\n' "$0" >&2
  exit 1
fi
printf 'MCP scope directory (Enter for global): '
IFS= read -r scope_input || true
if [[ ! -t 0 ]]; then printf '\n'; fi
if [[ -n "$scope_input" ]]; then
  scope_dir="$(cd -- "$scope_input" && pwd -P)" || exit 1
  bash "$project_dir/scripts/mcp_scope.sh" uninstall "$scope_dir" "$server_name" "$startup"
  exit 0
fi

# A registration can still point at this project after the checkout is moved.
# Ask before removing any same-named registration from a different path.
confirm_registration() {
  local client="$1"
  local registered_startup="$2"
  local answer
  if [[ "$registered_startup" == "$startup" ]]; then
    return 0
  fi
  printf '%s entry %s points to %s, not %s. Remove it? [y/N] ' \
    "$client" "$server_name" "$registered_startup" "$startup" >&2
  if ! IFS= read -r answer; then
    printf '\n' >&2
    return 1
  fi
  [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]]
}

for program in codex claude; do
  if ! command -v "$program" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$program" >&2
    exit 1
  fi
done

codex_registered=0
if codex_details="$(cd / && codex mcp get "$server_name" 2>/dev/null)"; then
  codex_startup="$(printf '%s\n' "$codex_details" | sed -n 's/^  command: //p' | head -n 1)"
  if ! confirm_registration Codex "$codex_startup"; then
    printf 'Cancelled; no registrations were removed.\n' >&2
    exit 1
  fi
  codex_registered=1
fi

claude_registered=0
if claude_details="$(cd / && claude mcp get "$server_name" 2>/dev/null)"; then
  claude_startup="$(printf '%s\n' "$claude_details" | sed -n 's/^  Command: //p' | head -n 1)"
  if ! confirm_registration Claude "$claude_startup"; then
    printf 'Cancelled; no registrations were removed.\n' >&2
    exit 1
  fi
  claude_registered=1
fi

if (( codex_registered )); then
  (cd / && codex mcp remove "$server_name")
fi
if (( claude_registered )); then
  (cd / && claude mcp remove --scope user "$server_name")
fi

rm -rf -- "$project_dir/dist" "$project_dir/node_modules"
printf 'Uninstalled %s from Codex and Claude Code and removed build files and dependencies.\n' "$server_name"
