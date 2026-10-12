#!/bin/sh
set -eu

usage() {
    cat <<'EOF'
Usage: scripts/install.sh codex|claude [--force] [--dest directory] [skill-name...]

Installs skills from this repository's plugins into the selected agent's skill directory.
If no skill names are provided, all compatible skills are installed.
In that mode, an incompatible dependency skips its dependents unless selected for replacement.
--dest selects the skills directory directly, overriding the agent default.
--force replaces selected skills. An automatic dependency is never overwritten;
name the dependency explicitly with --force to replace a differing copy.
herdr-orchestrate also installs Herdr's skill from the local `herdr --skill`.
The Herdr binary must already be installed. Select `herdr` to install only that skill.
EOF
}

is_codex_only_skill() {
    case "$1" in
        comprehensive-review|review-fix-loop|herdr-orchestrate)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

find_skill_source() {
    if [ "$1" = "herdr" ]; then
        printf '%s\n' "$herdr_stage/herdr"
        return 0
    fi
    for candidate in "$plugins_dir"/*/skills/"$1"; do
        if [ -d "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    printf 'Unknown skill: %s\n' "$1" >&2
    return 1
}

required_dependencies() {
    case "$1" in
        herdr-orchestrate) printf '%s\n' 'review-fix-loop herdr' ;;
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
    if [ "$skill" != "herdr" ]; then find_skill_source "$skill" >/dev/null; fi
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
        for dependency in $(required_dependencies "$skill"); do
            case " $* " in *" $dependency "*) continue ;; esac
            if [ "$dependency" != "herdr" ]; then find_skill_source "$dependency" >/dev/null; fi
            automatic_dependencies="$automatic_dependencies $dependency"
            set -- "$dependency" "$@"
            added=1
            printf 'Required dependency: %s (matching existing copy is preserved)\n' "$dependency"
        done
    done
    if [ "$added" -eq 0 ]; then break; fi
done

# Herdr ships a release-matched, self-contained skill. Stage it locally so a
# missing/failed export cannot truncate an installed copy or leave a partial
# orchestration installation. This reads no session and installs no executable.
herdr_stage=
case " $* " in
    *" herdr "*)
        herdr_stage=$(mktemp -d "${TMPDIR:-/tmp}/jig-install-herdr.XXXXXX")
        trap 'rm -rf "$herdr_stage"' 0
        trap 'exit 1' HUP INT TERM
        mkdir "$herdr_stage/herdr"
        if command -v herdr >/dev/null 2>&1 &&
            herdr --skill >"$herdr_stage/herdr/SKILL.md" &&
            awk '
                NR == 1 { if ($0 != "---") exit 1; next }
                !closed && /^---$/ { closed = 1; next }
                !closed && /^name: *herdr *$/ { name = 1 }
                !closed && /^description: *[^[:space:]]/ { description = 1 }
                closed && /[^[:space:]]/ { body = 1 }
                END { if (!name || !description || !closed || !body) exit 1 }
            ' "$herdr_stage/herdr/SKILL.md"; then
            :
        elif [ "$install_all" -eq 1 ]; then
            skipped_dependents="$skipped_dependents herdr"
            printf 'Herdr skill unavailable: install a Herdr binary supporting `herdr --skill` and rerun for herdr-orchestrate.\n' >&2
        else
            printf 'Cannot install Herdr skill: install a Herdr binary supporting `herdr --skill` and rerun. No skills were changed.\n' >&2
            exit 1
        fi
        ;;
esac

for dependency in review-fix-loop comprehensive-review audit-common herdr; do
    case " $skipped_dependents " in *" $dependency "*) continue ;; esac
    dependents=
    selected_dependency=0
    for skill in "$@"; do
        case "$explicit_skills" in *" $dependency "*) selected_dependency=1 ;; esac
        case " $(required_dependencies "$skill") " in
            *" $dependency "*) dependents="$dependents $skill" ;;
        esac
    done
    if [ -z "$dependents" ]; then continue; fi
    dependency_source=$(find_skill_source "$dependency")
    dependency_target="$dest/$dependency"
    dependency_origin='this checkout'
    if [ -e "$dependency_target" ] || [ -L "$dependency_target" ]; then
        # Herdr's export is one file; preserve any supplementary local files.
        if [ "$dependency" = "herdr" ]; then
            dependency_origin='the installed Herdr binary'
            dependency_source="$dependency_source/SKILL.md"
            dependency_target="$dependency_target/SKILL.md"
        fi
        if ! diff -qr "$dependency_source" "$dependency_target" >/dev/null 2>&1; then
            if [ "$install_all" -eq 1 ] && { [ "$force" -eq 0 ] || [ "$selected_dependency" -ne 1 ]; }; then
                skipped_dependents="$skipped_dependents$dependents"
                if [ "$dependency" = "herdr" ]; then
                    skipped_dependents="$skipped_dependents herdr"
                fi
            elif [ "$selected_dependency" -ne 1 ] || [ "$force" -ne 1 ]; then
                printf 'Existing %s differs from %s; these skills require the matching copy:%s\n' "$dependency" "$dependency_origin" "$dependents" >&2
                printf 'No skills were changed. To replace these copies, select %s and the dependent skills explicitly with --force (and the same --dest, if used).\n' "$dependency" >&2
                exit 1
            fi
        fi
    fi
done

# A dependency skipped because one of its own dependencies is incompatible
# cannot support a new dependent. Propagate before copying any directories.
while :; do
    added=0
    for skill in "$@"; do
        case " $skipped_dependents " in *" $skill "*) continue ;; esac
        for dependency in $(required_dependencies "$skill"); do
            case " $skipped_dependents " in
                *" $dependency "*)
                    skipped_dependents="$skipped_dependents $skill"
                    added=1
                    break
                    ;;
            esac
        done
    done
    if [ "$added" -eq 0 ]; then break; fi
done

mkdir -p "$dest"

for skill in "$@"; do
    case " $skipped_dependents " in
        *" $skill "*)
            if [ "$skill" = "herdr" ]; then
                printf 'Skipping herdr: its export is unavailable or the existing skill differs; continuing with other skills.\n' >&2
            else
                printf 'Skipping %s: required dependency (%s) is incompatible or unavailable; continuing with other skills.\n' "$skill" "$(required_dependencies "$skill")" >&2
            fi
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
