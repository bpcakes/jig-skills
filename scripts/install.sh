#!/bin/sh
set -eu

usage() {
    cat <<'EOF'
Usage: scripts/install.sh codex|claude [--force] [--dest directory] [skill-name...]

Installs skills from this repository's plugins into the selected agent's skill directory.
If no skill names are provided, all compatible skills are installed.
In that mode, without --force, an incompatible dependency skips only its dependents.
--dest selects the skills directory directly, overriding the agent default.
--force replaces selected skills. An automatic dependency is never overwritten;
name the dependency explicitly with --force to replace a differing copy.
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

required_dependency() {
    case "$1" in
        review-fix-loop) printf '%s\n' comprehensive-review ;;
        comprehensive-review) printf '%s\n' review-fix-loop ;;
        audit-common) ;;
        *)
            if [ -f "$plugins_dir/jig-privacy-audit/skills/$1/SKILL.md" ]; then
                printf '%s\n' audit-common
            fi
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

# Validate all requested targets before copying or replacing anything.
for skill in "$@"; do
    case "$skill" in
        ''|*[!a-z0-9-]*|-*)
            printf 'Invalid skill name: %s\n' "$skill" >&2
            exit 1
            ;;
    esac
    find_skill_source "$skill" >/dev/null
    if [ "$target_agent" = "claude" ] && is_codex_only_skill "$skill"; then
        printf 'Unsupported for Claude direct install: %s\n' "$skill" >&2
        exit 1
    fi
done

automatic_dependencies=
skipped_dependents=
explicit_skills=" $* "
# Resolve the entire dependency closure before checking compatibility. In
# particular, the two review entrypoints depend on each other's bundled code.
while :; do
    added=0
    for skill in "$@"; do
        dependency=$(required_dependency "$skill")
        if [ -z "$dependency" ]; then continue; fi
        case " $* " in *" $dependency "*) continue ;; esac
        find_skill_source "$dependency" >/dev/null
        automatic_dependencies="$automatic_dependencies $dependency"
        set -- "$dependency" "$@"
        added=1
        printf 'Required dependency: %s (matching existing copy is preserved)\n' "$dependency"
    done
    if [ "$added" -eq 0 ]; then break; fi
done
for dependency in review-fix-loop comprehensive-review audit-common; do
    dependents=
    selected_dependency=0
    for skill in "$@"; do
        case "$explicit_skills" in *" $dependency "*) selected_dependency=1 ;; esac
        if [ "$(required_dependency "$skill")" = "$dependency" ]; then
            dependents="$dependents $skill"
        fi
    done
    if [ -z "$dependents" ]; then continue; fi
    dependency_source=$(find_skill_source "$dependency")
    dependency_target="$dest/$dependency"
    if [ -e "$dependency_target" ] || [ -L "$dependency_target" ]; then
        if ! diff -qr "$dependency_source" "$dependency_target" >/dev/null 2>&1; then
            if [ "$install_all" -eq 1 ] && [ "$force" -eq 0 ]; then
                skipped_dependents="$skipped_dependents$dependents"
            elif [ "$selected_dependency" -ne 1 ] || [ "$force" -ne 1 ]; then
                printf 'Existing %s differs from this checkout; these skills require the matching copy:%s\n' "$dependency" "$dependents" >&2
                printf 'No skills were changed. To replace these copies, select %s and the dependent skills explicitly with --force (and the same --dest, if used).\n' "$dependency" >&2
                exit 1
            fi
        fi
    fi
done

mkdir -p "$dest"

for skill in "$@"; do
    case " $skipped_dependents " in
        *" $skill "*)
            printf 'Skipping %s: existing %s differs from this checkout; continuing with other skills.\n' "$skill" "$(required_dependency "$skill")" >&2
            continue
            ;;
    esac

    source=$(find_skill_source "$skill")
    target="$dest/$skill"

    if [ -e "$target" ] || [ -L "$target" ]; then
        case " $automatic_dependencies " in
            *" $skill "*)
                printf 'Keeping matching dependency: %s\n' "$skill"
                continue
                ;;
        esac
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
