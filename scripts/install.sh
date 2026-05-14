#!/bin/sh
set -eu

usage() {
    cat <<'EOF'
Usage: scripts/install.sh codex|claude [--force] [skill-name...]

Installs skills from this repository's plugins into the selected agent's skill directory.
If no skill names are provided, all compatible skills are installed.
EOF
}

is_codex_only_skill() {
    case "$1" in
        comprehensive-review)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

if [ "$#" -lt 1 ]; then
    usage
    exit 2
fi

target_agent=$1
shift

case "$target_agent" in
    codex)
        dest="${CODEX_HOME:-$HOME/.codex}/skills"
        restart_message="Restart Codex to pick up new skills."
        ;;
    claude)
        dest="${CLAUDE_HOME:-$HOME/.claude}/skills"
        restart_message="Restart Claude to pick up new skills."
        ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        usage
        exit 2
        ;;
esac

force=0
if [ "${1:-}" = "--force" ]; then
    force=1
    shift
fi

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
plugins_dir="$repo_root/plugins"

if [ "$#" -eq 0 ]; then
    set -- $(find "$plugins_dir" -path '*/skills/*/SKILL.md' -type f \
        -exec sh -c 'for file do basename "$(dirname "$file")"; done' sh {} + | sort)
    if [ "$target_agent" = "claude" ]; then
        filtered=
        for skill in "$@"; do
            if is_codex_only_skill "$skill"; then
                continue
            fi
            filtered="$filtered $skill"
        done
        # shellcheck disable=SC2086
        set -- $filtered
    fi
fi

mkdir -p "$dest"

for skill in "$@"; do
    if [ "$target_agent" = "claude" ] && is_codex_only_skill "$skill"; then
        printf 'Unsupported for Claude direct install: %s\n' "$skill" >&2
        exit 1
    fi

    source=
    for candidate in "$plugins_dir"/*/skills/"$skill"; do
        if [ -d "$candidate" ]; then
            source=$candidate
            break
        fi
    done

    target="$dest/$skill"

    if [ -z "$source" ]; then
        printf 'Unknown skill: %s\n' "$skill" >&2
        exit 1
    fi

    if [ -e "$target" ]; then
        if [ "$force" -eq 1 ]; then
            rm -rf "$target"
        else
            printf 'Skipping existing skill: %s\n' "$skill"
            continue
        fi
    fi

    cp -R "$source" "$target"
    printf 'Installed %s -> %s\n' "$skill" "$target"
done

printf '%s\n' "$restart_message"
