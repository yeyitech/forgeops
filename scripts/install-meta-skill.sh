#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Install ForgeOps skill into one or more Agent skill roots.

Usage:
  scripts/install-meta-skill.sh [options]
  scripts/install-forgeops-skill.sh [options]

Options:
  --agent <name>         Target built-in agent: codex | claude | gemini
                         Repeatable. Defaults to: codex + claude
  --all                  Same as: --agent codex --agent claude --agent gemini
  --skills-root <dir>    Custom skill root. Installs to <dir>/<skill-name>/SKILL.md
                         Repeatable for arbitrary agents.
  --target <file>        Explicit SKILL.md target path. Repeatable.
  --source <path>        Source SKILL.md (default: ./FORGEOPS_META_SKILL.md)
  --skill-name <name>    Override skill folder name (default: parsed from frontmatter name)
  --mode <copy|link>     copy (default) or symlink install
  --force                Allow replacing non-symlink destination in link mode
  --dry-run              Print planned writes without touching files
  --help                 Show this help

Built-in roots:
  codex  -> ${CODEX_HOME:-$HOME/.codex}/skills
  claude -> ${CLAUDE_HOME:-$HOME/.claude}/skills
  gemini -> ${GEMINI_HOME:-$HOME/.gemini}/skills
EOF
}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

to_abs_path() {
  local input="$1"
  if [[ "$input" == /* ]]; then
    printf '%s\n' "$input"
    return
  fi
  printf '%s/%s\n' "$(pwd)" "$input"
}

agent_root() {
  local agent="$1"
  case "$agent" in
    codex) printf '%s\n' "${CODEX_HOME:-$HOME/.codex}/skills" ;;
    claude) printf '%s\n' "${CLAUDE_HOME:-$HOME/.claude}/skills" ;;
    gemini) printf '%s\n' "${GEMINI_HOME:-$HOME/.gemini}/skills" ;;
    *) return 1 ;;
  esac
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_PATH="${REPO_ROOT}/FORGEOPS_META_SKILL.md"
SKILL_NAME="${FORGEOPS_SKILL_NAME:-${FORGEOPS_META_SKILL_NAME:-}}"
MODE="copy"
DRY_RUN=0
FORCE=0

declare -a AGENTS=()
declare -a CUSTOM_SKILL_ROOTS=()
declare -a CUSTOM_TARGETS=()

has_agent() {
  local candidate="$1"
  local item
  if [ "${#AGENTS[@]}" -eq 0 ]; then
    return 1
  fi
  for item in "${AGENTS[@]}"; do
    if [ "$item" = "$candidate" ]; then
      return 0
    fi
  done
  return 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent)
      value="${2:-}"
      if [ -z "$value" ]; then
        fail "Missing value for --agent"
      fi
      case "$value" in
        codex|claude|gemini)
          if ! has_agent "$value"; then
            AGENTS+=("$value")
          fi
          ;;
        *)
          fail "Unsupported agent: $value (use codex|claude|gemini or --skills-root/--target)"
          ;;
      esac
      shift 2
      ;;
    --all)
      for value in codex claude gemini; do
        if ! has_agent "$value"; then
          AGENTS+=("$value")
        fi
      done
      shift
      ;;
    --skills-root)
      value="${2:-}"
      if [ -z "$value" ]; then
        fail "Missing value for --skills-root"
      fi
      CUSTOM_SKILL_ROOTS+=("$(to_abs_path "$value")")
      shift 2
      ;;
    --target)
      value="${2:-}"
      if [ -z "$value" ]; then
        fail "Missing value for --target"
      fi
      CUSTOM_TARGETS+=("$(to_abs_path "$value")")
      shift 2
      ;;
    --source)
      value="${2:-}"
      if [ -z "$value" ]; then
        fail "Missing value for --source"
      fi
      SOURCE_PATH="$(to_abs_path "$value")"
      shift 2
      ;;
    --skill-name)
      value="${2:-}"
      if [ -z "$value" ]; then
        fail "Missing value for --skill-name"
      fi
      SKILL_NAME="$value"
      shift 2
      ;;
    --mode)
      value="${2:-}"
      if [ "$value" != "copy" ] && [ "$value" != "link" ]; then
        fail "Invalid --mode: $value (expected copy|link)"
      fi
      MODE="$value"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

if [ "${#AGENTS[@]}" -eq 0 ] && [ "${#CUSTOM_SKILL_ROOTS[@]}" -eq 0 ] && [ "${#CUSTOM_TARGETS[@]}" -eq 0 ]; then
  AGENTS=("codex" "claude")
fi

if [ ! -f "$SOURCE_PATH" ]; then
  fail "Source skill file not found: $SOURCE_PATH"
fi

if [ -z "$SKILL_NAME" ]; then
  SKILL_NAME="$(
    awk '
      BEGIN { in_header = 0 }
      /^---[[:space:]]*$/ {
        if (in_header == 0) { in_header = 1; next }
        else { exit }
      }
      in_header == 1 && $1 == "name:" {
        print $2
        exit
      }
    ' "$SOURCE_PATH"
  )"
fi

if [ -z "$SKILL_NAME" ]; then
  SKILL_NAME="forgeops"
fi

declare -a DEST_LABELS=()
declare -a DEST_PATHS=()

add_destination() {
  local label="$1"
  local file_path="$2"
  local i
  for i in "${!DEST_PATHS[@]}"; do
    if [ "${DEST_PATHS[$i]}" = "$file_path" ]; then
      return
    fi
  done
  DEST_LABELS+=("$label")
  DEST_PATHS+=("$file_path")
}

if [ "${#AGENTS[@]}" -gt 0 ]; then
  for agent in "${AGENTS[@]}"; do
    root="$(agent_root "$agent")" || fail "Cannot resolve skill root for agent: $agent"
    add_destination "$agent" "${root}/${SKILL_NAME}/SKILL.md"
  done
fi

if [ "${#CUSTOM_SKILL_ROOTS[@]}" -gt 0 ]; then
  for root in "${CUSTOM_SKILL_ROOTS[@]}"; do
    add_destination "custom-root" "${root}/${SKILL_NAME}/SKILL.md"
  done
fi

if [ "${#CUSTOM_TARGETS[@]}" -gt 0 ]; then
  for target in "${CUSTOM_TARGETS[@]}"; do
    add_destination "custom-target" "$target"
  done
fi

if [ "${#DEST_PATHS[@]}" -eq 0 ]; then
  fail "No install target resolved."
fi

printf 'Source: %s\n' "$SOURCE_PATH"
printf 'Skill name: %s\n' "$SKILL_NAME"
printf 'Mode: %s\n' "$MODE"
if [ "$DRY_RUN" -eq 1 ]; then
  printf 'Dry-run: true\n'
fi
printf '\n'

for i in "${!DEST_PATHS[@]}"; do
  label="${DEST_LABELS[$i]}"
  dest="${DEST_PATHS[$i]}"
  dest_dir="$(dirname "$dest")"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] (%s) %s -> %s\n' "$label" "$SOURCE_PATH" "$dest"
    continue
  fi

  mkdir -p "$dest_dir"
  if [ "$MODE" = "copy" ]; then
    cp -f "$SOURCE_PATH" "$dest"
  else
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      if [ "$FORCE" -ne 1 ] && [ ! -L "$dest" ]; then
        fail "Destination exists and is not a symlink: $dest (use --force or --mode copy)"
      fi
      rm -f "$dest"
    fi
    ln -s "$SOURCE_PATH" "$dest"
  fi
  printf '[ok] (%s) installed -> %s\n' "$label" "$dest"
done
