#!/usr/bin/env bash
# Counts the agents open in each workspace and reports the number as workspace
# metadata, which ../../config.toml renders as a `$agents` token in the spaces
# sidebar. Invoked by herdr on startup and on pane add/remove/move events; see
# herdr-plugin.toml.
#
#   --dry-run   print the metadata writes that would happen, change nothing
#   --clear     clear the token everywhere (uninstall)
#
# Debug trace:
#   SPACE_AGENTS_DEBUG=1  append a `set -x` log to $TMPDIR/space-agents.log
# Offline testing:
#   SPACE_AGENTS_SNAPSHOT=file.json  read a snapshot from disk instead of herdr
set -euo pipefail

# Prefixed onto the count so it does not read as a workspace number, which the
# sidebar also shows. herdr's own glyph vocabulary is no help here: it is
# ◉ blocked / ● done / ○ idle, all of which are *status* marks, so borrowing
# one would claim a state rather than a quantity -- ● in particular already
# means "done" both in herdr and in plugins/tab-jump/jump.sh. `·` is used by
# herdr purely as a separator, is single-width, and needs no Nerd Font.
#
# Single-width is the constraint, as in plugins/tab-status: sidebar_width is 32
# and an emoji would cost 2 cells of a name field that is already tight.
#
# Drop this on herdr 0.9.0. It adds value-based `rules` to sidebar tokens, but
# gt/lt are numeric and "·7" does not parse as a number -- the rules validate
# fine and then never match. A bare count plus threshold colors disambiguates
# better than a glyph and costs one column less. See CLAUDE.md.
PREFIX="${SPACE_AGENTS_PREFIX-}"
[ -n "$PREFIX" ] || PREFIX="·"

# Identifies us as the reporting source so our tokens can be cleared again
# without disturbing metadata reported by anything else. Must be ASCII
# alphanumerics, colon, dot, underscore or hyphen, 80 chars or fewer.
SOURCE="space-agents"

herdr="${HERDR_BIN_PATH:-herdr}"
dry_run=0
clear_all=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) dry_run=1 ;;
        --clear)   clear_all=1 ;;
        *) echo "space-agents: unknown argument: $arg" >&2; exit 2 ;;
    esac
done

if [ -n "${SPACE_AGENTS_DEBUG:-}" ]; then
    exec 2>>"${TMPDIR:-/tmp}/space-agents.log"
    echo "=== $(date) dry_run=$dry_run clear=$clear_all ===" >&2
    set -x
fi

command -v jq >/dev/null 2>&1 || {
    echo "space-agents: jq not found in PATH" >&2
    exit 1
}

snapshot() {
    if [ -n "${SPACE_AGENTS_SNAPSHOT:-}" ]; then
        cat "$SPACE_AGENTS_SNAPSHOT"
    else
        "$herdr" api snapshot
    fi
}

# Counts are always derived from a live snapshot and never cached, so this is
# idempotent and self-healing: a missed event costs nothing beyond a stale
# number until the next run.
#
# The snapshot reports each workspace's *current* tokens, so the desired value
# is diffed against what is already displayed and unchanged workspaces emit no
# row at all. That matters because every row below costs one socket round-trip:
# without the diff, a burst of pane events would rewrite identical metadata for
# every workspace in the session.
reconcile() {
    snapshot | jq -r --arg prefix "$PREFIX" --argjson clear "$clear_all" '
      .result.snapshot as $s
      # An agent whose pane is not in a workspace has a null workspace_id, and
      # from_entries would choke on it as a key.
      | ( [ $s.agents[]? | select(.workspace_id != null) ]
          | group_by(.workspace_id)
          | map({ key: .[0].workspace_id, value: length })
          | from_entries ) as $counts
      | $s.workspaces[]?
      | .workspace_id as $ws
      | select($ws != null)
      | ( if $clear == 1 then 0 else ($counts[$ws] // 0) end ) as $n
      # A workspace with no agents reports no token rather than a "0": the
      # spaces list is mostly plain shells, and a column of zeroes is noise
      # that would bury the counts that matter.
      | ( if $n > 0 then $prefix + ($n | tostring) else "" end ) as $want
      | ( .tokens.agents // "" ) as $have
      | select($want != $have)
      | [ $ws, $want ] | @tsv
    '
}

apply() {
    while IFS=$'\t' read -r ws want; do
        [ -n "$ws" ] || continue
        if [ "$dry_run" -eq 1 ]; then
            printf 'would set  %-6s  %s\n' "$ws" "${want:-<clear>}"
        elif [ -n "$want" ]; then
            "$herdr" workspace report-metadata "$ws" \
                --source "$SOURCE" --token "agents=$want" >/dev/null 2>&1 || true
        else
            # Deliberately no --ttl-ms anywhere in this script. A TTL would make
            # the count silently vanish from a workspace that simply had not
            # changed recently; clearing explicitly is the uninstall path.
            "$herdr" workspace report-metadata "$ws" \
                --source "$SOURCE" --clear-token agents >/dev/null 2>&1 || true
        fi
    done < <(reconcile)
}

if [ "$dry_run" -eq 1 ]; then
    apply
    exit 0
fi

# Coalescing lock, as in plugins/tab-status/mark.sh. Closing a workspace full of
# agents fires a burst of pane.closed/pane.exited events, and overlapping runs
# would issue redundant metadata writes from stale snapshots. A skipped run
# loses nothing because every run recounts the *whole* session from a fresh
# snapshot -- it only has to be re-run once more afterwards, which RERUN asks
# for.
LOCK="${TMPDIR:-/tmp}/herdr-space-agents.lock"
RERUN="$LOCK/rerun"

if ! mkdir "$LOCK" 2>/dev/null; then
    # A lock whose owner died would otherwise wedge this forever.
    lock_pid=$(cat "$LOCK/pid" 2>/dev/null || echo "")
    if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -rf "$LOCK"
        mkdir "$LOCK" 2>/dev/null || exit 0
    else
        : >"$RERUN" 2>/dev/null || true
        exit 0
    fi
fi
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

apply
while [ -e "$RERUN" ]; do
    rm -f "$RERUN"
    apply
done
