#!/bin/sh
set -eu

usage() {
    cat <<'EOF'
Usage: scripts/install.sh codex|claude [--force] [--dest directory] [skill-name...]

Installs skills from this repository's plugins into the selected agent's skill directory.
If no skill names are provided, all compatible skills are installed.
In that mode, without --force, an incompatible review-fix-loop dependency skips
only that loop.
--dest selects the skills directory directly, overriding the agent default.
--force replaces selected skills. An automatic dependency is never overwritten;
name comprehensive-review explicitly with --force to replace a differing copy.
EOF
}

is_codex_only_skill() {
    case "$1" in
        comprehensive-review|review-fix-loop)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

find_skill_source() {
    for candidate in "$plugins_dir"/*/skills/"$1"; do
        if [ -d "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    printf 'Unknown skill: %s\n' "$1" >&2
    return 1
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
while [ "$#" -gt 0 ]; do
    case "$1" in
        --force)
            force=1
            shift
            ;;
        --dest)
            if [ "$#" -lt 2 ] || [ -z "$2" ]; then
                printf 'Missing directory for --dest\n' >&2
                exit 2
            fi
            case "$2" in
                --*)
                    printf 'Missing directory for --dest\n' >&2
                    exit 2
                    ;;
            esac
            dest=$2
            shift 2
            ;;
        --*)
            printf 'Unknown option: %s\n' "$1" >&2
            exit 2
            ;;
        *) break ;;
    esac
done

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
plugins_dir="$repo_root/plugins"

install_all=0
if [ "$#" -eq 0 ]; then
    install_all=1
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

needs_comprehensive=0
has_comprehensive=0
for skill in "$@"; do
    case "$skill" in
        review-fix-loop)
            needs_comprehensive=1
            ;;
        comprehensive-review)
            has_comprehensive=1
            ;;
    esac
done
automatic_comprehensive=0
skip_review_fix_loop=0
if [ "$target_agent" = "codex" ] && [ "$needs_comprehensive" -eq 1 ]; then
    dependency_source=$(find_skill_source comprehensive-review)
    dependency_target="$dest/comprehensive-review"
    if [ -e "$dependency_target" ] || [ -L "$dependency_target" ]; then
        if ! diff -qr "$dependency_source" "$dependency_target" >/dev/null 2>&1; then
            if [ "$install_all" -eq 1 ] && [ "$force" -eq 0 ]; then
                skip_review_fix_loop=1
            elif [ "$has_comprehensive" -ne 1 ] || [ "$force" -ne 1 ]; then
                printf '%s\n' \
                    'Existing comprehensive-review differs from this checkout; review-fix-loop requires the matching copy.' \
                    'No skills were changed. To replace both copies, select comprehensive-review and review-fix-loop explicitly with --force (and the same --dest, if used).' >&2
                exit 1
            fi
        fi
    fi
    if [ "$has_comprehensive" -eq 0 ]; then
        automatic_comprehensive=1
        set -- comprehensive-review "$@"
        printf 'Required dependency: comprehensive-review (matching existing copy is preserved)\n'
    fi
fi

mkdir -p "$dest"

for skill in "$@"; do
    if [ "$skill" = "review-fix-loop" ] && [ "$skip_review_fix_loop" -eq 1 ]; then
        printf 'Skipping review-fix-loop: existing comprehensive-review differs from this checkout; continuing with other skills.\n' >&2
        continue
    fi
    if [ "$target_agent" = "claude" ] && is_codex_only_skill "$skill"; then
        printf 'Unsupported for Claude direct install: %s\n' "$skill" >&2
        exit 1
    fi

    source=$(find_skill_source "$skill")
    target="$dest/$skill"

    if [ -e "$target" ] || [ -L "$target" ]; then
        if [ "$skill" = "comprehensive-review" ] && [ "$automatic_comprehensive" -eq 1 ]; then
            printf 'Keeping matching dependency: %s\n' "$skill"
            continue
        fi
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
