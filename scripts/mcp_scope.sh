#!/usr/bin/env bash
set -euo pipefail

# Register one server in a directory and its existing nested Git repositories.
# Codex and Claude own the TOML/JSON MCP entries; this script handles project roots.
action="${1:-}"
scope="${2:-}"
server_name="${3:-}"
startup="${4:-}"
node_path="${5:-}"
root_marker='.mcp-scope-root'

fail() { printf 'MCP scope: %s\n' "$*" >&2; exit 1; }
[[ "$action" == install || "$action" == uninstall ]] || fail 'Expected install or uninstall'
[[ -n "$scope" && -n "$startup" ]] || fail 'Missing scope or startup path'
[[ "$server_name" == spine2d-mcp || "$server_name" == godot-mcp ]] || fail 'Unknown server name'
scope="$(cd -- "$scope" && pwd -P)" || fail 'Scope directory does not exist'
[[ "$scope" != / ]] || fail 'The filesystem root cannot be a scope'
user_codex_dir="${CODEX_HOME:-$HOME/.codex}"
user_codex_config="$user_codex_dir/config.toml"
scope_codex_config="$scope/.codex/config.toml"
[[ ! -L "$scope/.codex" && ! -L "$scope_codex_config" ]] || fail "Refusing to edit a symbolic link under $scope/.codex"
[[ ! -L "$scope/$root_marker" ]] || fail "Refusing to edit a symbolic link: $scope/$root_marker"

for program in codex claude git find awk; do
  command -v "$program" >/dev/null 2>&1 || fail "Required command not found: $program"
done

toml_quote() {
  local value="$1"
  [[ "$value" != *$'\n'* ]] || fail 'Newlines in scope paths are unsupported'
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

confirm_other() {
  local config="$1" registered="$2" answer
  [[ "$registered" == "$startup" ]] && return 0
  printf '%s defines %s as %s, not %s. Remove it? [y/N] ' \
    "$config" "$server_name" "$registered" "$startup" >&2
  IFS= read -r answer || true
  [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]] || fail 'Cancelled; no scoped registrations were removed'
}

# A nested Git project is its own Codex project root. Reuse the scope config
# through a symlink, or edit an existing local config with the Codex CLI.
git_roots=()
while IFS= read -r -d '' git_entry; do
  git_roots+=("${git_entry%/.git}")
done < <(find "$scope" \( -name .git -print0 -prune \) -o \
  \( -name .godot -o -name .codex -o -name node_modules -o -name bin -o -name obj \) -prune)

codex_dirs=()
if [[ -e "$scope_codex_config" ]]; then
  [[ ! -L "$scope_codex_config" ]] || fail "Refusing to edit a symbolic link: $scope_codex_config"
  codex_dirs+=("$scope")
elif [[ "$action" == install ]]; then
  [[ ! -e "$scope/.codex" || -d "$scope/.codex" ]] || fail "$scope/.codex is a file"
  codex_dirs+=("$scope")
fi
for repo in "${git_roots[@]}"; do
  [[ "$repo" != "$scope" ]] || continue
  [[ ! -L "$repo/.codex" ]] || fail "Refusing to edit a symbolic link: $repo/.codex"
  config="$repo/.codex/config.toml"
  if [[ -L "$config" ]]; then
    [[ "$(readlink -f -- "$config")" == "$scope_codex_config" ]] || fail "$config points to another config"
  elif [[ -e "$config" ]]; then
    codex_dirs+=("$repo")
  elif [[ "$action" == install ]]; then
    [[ ! -e "$repo/.codex" || -d "$repo/.codex" ]] || fail "$repo/.codex is a file"
  fi
done

# Check every Codex entry before changing any server config.
codex_to_change=()
for directory in "${codex_dirs[@]}"; do
  if details="$(cd / && CODEX_HOME="$directory/.codex" codex mcp get "$server_name" 2>/dev/null)"; then
    registered="$(sed -n 's/^  command: //p' <<< "$details" | head -n 1)"
    if [[ "$action" == install ]]; then
      [[ "$registered" == "$startup" ]] || fail "$directory already defines a different $server_name server"
    else
      confirm_other "$directory/.codex/config.toml" "$registered"
      codex_to_change+=("$directory")
    fi
  elif [[ "$action" == install ]]; then
    codex_to_change+=("$directory")
  fi
done

claude_present=false
if [[ -L "$scope/.mcp.json" ]]; then
  fail "Refusing to edit a symbolic link: $scope/.mcp.json"
fi
if [[ -f "$scope/.mcp.json" ]] && details="$(cd "$scope" && claude mcp get "$server_name" 2>/dev/null)"; then
  if grep -Fq 'Scope: Project config' <<< "$details"; then
    registered="$(sed -n 's/^  Command: //p' <<< "$details" | head -n 1)"
    if [[ "$action" == install ]]; then
      [[ "$registered" == "$startup" ]] || fail "$scope/.mcp.json already defines a different $server_name server"
    else
      confirm_other "$scope/.mcp.json" "$registered"
    fi
    claude_present=true
  fi
fi

toml_project_header() { printf '[projects.%s]' "$(toml_quote "$1")"; }

prepare_user_codex_config() {
  [[ ! -L "$user_codex_config" ]] || fail "Refusing to edit a symbolic link: $user_codex_config"
  mkdir -p -- "$user_codex_dir"
  work_config="$(mktemp "$user_codex_dir/.mcp-scope-config.XXXXXX")"
  trap '[[ -z "${work_config:-}" ]] || rm -f -- "$work_config"' EXIT
  if [[ -f "$user_codex_config" ]]; then
    cp -p -- "$user_codex_config" "$work_config"
  else
    chmod 600 "$work_config"
  fi

  marker_line="$(grep -E '^project_root_markers[[:space:]]*=' "$work_config" || true)"
  if [[ -z "$marker_line" ]]; then
    next_config="$(mktemp "$user_codex_dir/.mcp-scope-config.XXXXXX")"
    awk -v marker='project_root_markers = [".git", ".mcp-scope-root"]' '
      !added && /^[[:space:]]*\[/ {print marker; print ""; added=1}
      {print}
      END {if (!added) print marker}
    ' "$work_config" > "$next_config"
    cat "$next_config" > "$work_config"
    rm -f -- "$next_config"
  elif [[ "$marker_line" != *"\"$root_marker\""* ]]; then
    [[ "$marker_line" != *$'\n'* && "$marker_line" == *']'* ]] || fail "Cannot update project_root_markers in $user_codex_config"
    marker_prefix="${marker_line%%]*}"
    marker_suffix="${marker_line#*]}"
    marker_values="${marker_prefix#*[}"
    if [[ -z "${marker_values//[[:space:]]/}" ]]; then
      replacement="${marker_prefix}\".git\", \"$root_marker\"]${marker_suffix}"
    else
      replacement="${marker_prefix}, \"$root_marker\"]${marker_suffix}"
    fi
    next_config="$(mktemp "$user_codex_dir/.mcp-scope-config.XXXXXX")"
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "$marker_line" ]]; then
        printf '%s\n' "$replacement"
      else
        printf '%s\n' "$line"
      fi
    done < "$work_config" > "$next_config"
    cat "$next_config" > "$work_config"
    rm -f -- "$next_config"
  fi

  for directory in "$scope" "${git_roots[@]}"; do
    header="$(toml_project_header "$directory")"
    if grep -Fxq -- "$header" "$work_config"; then
      trust="$(awk -v header="$header" '
        $0 == header {inside=1; next}
        inside && /^[[:space:]]*\[/ {exit}
        inside && /^[[:space:]]*trust_level[[:space:]]*=/ {print; exit}
      ' "$work_config")"
      [[ "$trust" =~ ^[[:space:]]*trust_level[[:space:]]*=[[:space:]]*\"trusted\"[[:space:]]*$ ]] ||
        fail "$directory already has a non-trusted Codex setting"
    else
      printf '\n%s\ntrust_level = "trusted"\n' "$header" >> "$work_config"
    fi
  done

  # Validate the complete TOML with Codex before replacing the user config.
  validation_home="$(mktemp -d "$user_codex_dir/.mcp-scope-validate.XXXXXX")"
  cp -- "$work_config" "$validation_home/config.toml"
  if ! (cd / && CODEX_HOME="$validation_home" codex mcp list --json >/dev/null 2>&1); then
    rm -f -- "$validation_home/config.toml"
    rmdir -- "$validation_home"
    fail "Cannot safely update $user_codex_config"
  fi
  rm -f -- "$validation_home/config.toml"
  rmdir -- "$validation_home"
  if [[ ! -f "$user_codex_config" ]] || ! cmp -s -- "$work_config" "$user_codex_config"; then
    mv -- "$work_config" "$user_codex_config"
    work_config=''
  fi
}

ignore_generated_config() {
  local directory="$1" repo relative pattern exclude current
  repo="$(git -C "$directory" rev-parse --show-toplevel 2>/dev/null)" || return 0
  exclude="$(git -C "$repo" rev-parse --git-path info/exclude)" || return 0
  [[ "$exclude" == /* ]] || exclude="$repo/$exclude"
  relative="${directory#"$repo"}"
  pattern="$relative/.codex/"
  [[ -f "$exclude" ]] || : > "$exclude"
  grep -Fxq -- "$pattern" "$exclude" || printf '%s\n' "$pattern" >> "$exclude"
  if [[ "$directory" == "$scope" ]]; then
    pattern="$relative/$root_marker"
    grep -Fxq -- "$pattern" "$exclude" || printf '%s\n' "$pattern" >> "$exclude"
  fi
}

if [[ "$action" == install ]]; then
  prepare_user_codex_config
  [[ -z "${work_config:-}" ]] || rm -f -- "$work_config"
  for directory in "${codex_to_change[@]}"; do
    mkdir -p -- "$directory/.codex"
    if [[ -n "$node_path" ]]; then
      (cd / && CODEX_HOME="$directory/.codex" codex mcp add "$server_name" --env "SPINE2D_MCP_NODE=$node_path" -- "$startup")
    else
      (cd / && CODEX_HOME="$directory/.codex" codex mcp add "$server_name" -- "$startup")
    fi
  done
  if [[ "$claude_present" == false ]]; then
    if [[ -n "$node_path" ]]; then
      (cd "$scope" && claude mcp add --scope project --transport stdio "$server_name" -e "SPINE2D_MCP_NODE=$node_path" -- "$startup")
    else
      (cd "$scope" && claude mcp add --scope project --transport stdio "$server_name" -- "$startup")
    fi
  fi
  : > "$scope/$root_marker"
  for repo in "${git_roots[@]}"; do
    [[ "$repo" != "$scope" ]] || continue
    config="$repo/.codex/config.toml"
    if [[ ! -e "$config" && ! -L "$config" ]]; then
      mkdir -p -- "$repo/.codex"
      ln -s -- "$scope_codex_config" "$config"
    fi
  done
  ignore_generated_config "$scope"
  for repo in "${git_roots[@]}"; do ignore_generated_config "$repo"; done
  printf 'Scoped %s to %s and %s existing Git repositories\n' "$server_name" "$scope" "${#git_roots[@]}"
else
  for directory in "${codex_to_change[@]}"; do
    (cd / && CODEX_HOME="$directory/.codex" codex mcp remove "$server_name")
  done
  if [[ "$claude_present" == true ]]; then
    (cd "$scope" && claude mcp remove --scope project "$server_name")
  fi
  printf 'Removed %s from %s; shared runtime and Codex trust settings retained\n' "$server_name" "$scope"
fi
