#!/usr/bin/env bash
# Prefixes a marker onto the label of any tab whose agent is blocked (waiting
# on you), and strips it once the agent moves on. Invoked by herdr on
# pane.agent_status_changed; see herdr-plugin.toml.
#
#   --dry-run   print the renames that would happen, change nothing
#
# Uninstall (strip every marker):
#   TAB_STATUS_MARKS='{}' ./mark.sh
#
# Debug trace:
#   TAB_STATUS_DEBUG=1  append a `set -x` log to $TMPDIR/tab-status.log
# Offline testing:
#   TAB_STATUS_SNAPSHOT=file.json  read a snapshot from disk instead of herdr
set -euo pipefail

# Which statuses get a marker, and which glyph. Both of these are "the agent is
# waiting on you" -- herdr's own toast fires when an agent "finishes or is
# blocked" -- and `done` is by far the more common of the two, so marking only
# `blocked` would light up almost never. Statuses absent from this map (idle,
# working, unknown) are deliberately unmarked: a glyph on every tab is just a
# worse sidebar.
#
# Single-width glyphs on purpose -- herdr draws its own tab row and a 2-cell
# emoji misaligns it. ▲ matches the blocked glyph in plugins/tab-jump/jump.sh.
# Overridable so there is a clean uninstall path: markers live in the tab
# *label*, so unlinking the plugin would otherwise strand them there forever.
#   TAB_STATUS_MARKS='{}' ./mark.sh   # strip every marker, mark nothing
MARKS="${TAB_STATUS_MARKS-}"
[ -n "$MARKS" ] || MARKS='{"blocked":"▲","done":"✓"}'

# Every glyph this script may ever have written, used only for *stripping*.
# It has to be independent of MARKS: deriving the strip set from MARKS means
# TAB_STATUS_MARKS='{}' has nothing to strip with, so the uninstall path would
# silently leave every marker in place. Add to this list, never remove.
GLYPHS='["▲","✓"]'

herdr="${HERDR_BIN_PATH:-herdr}"
dry_run=0
[ "${1:-}" = "--dry-run" ] && dry_run=1

if [ -n "${TAB_STATUS_DEBUG:-}" ]; then
    exec 2>>"${TMPDIR:-/tmp}/tab-status.log"
    echo "=== $(date) dry_run=$dry_run ===" >&2
    set -x
fi

command -v jq >/dev/null 2>&1 || {
    echo "tab-status: jq not found in PATH" >&2
    exit 1
}

snapshot() {
    if [ -n "${TAB_STATUS_SNAPSHOT:-}" ]; then
        cat "$TAB_STATUS_SNAPSHOT"
    else
        "$herdr" api snapshot
    fi
}

# Labels are always derived from a live snapshot and never cached, so a tab you
# rename mid-session keeps its new name. Strip-then-maybe-prefix makes this
# idempotent: running twice cannot double-mark, and an interrupted run leaves
# nothing to repair.
reconcile() {
    snapshot | jq -r --argjson marks "$MARKS" --argjson glyphs "$GLYPHS" '
      (($glyphs + ($marks | to_entries | map(.value)))
       | unique | map(. + " ")) as $prefixes
      | .result.snapshot as $s
      | $s.tabs[]
      | (.label // "") as $label
      # `. as $p` is load-bearing: inside startswith(...) a bare `.` would
      # resolve to the piped input ($label), making every label match itself
      # and silently amputating the first two characters of every tab name.
      | ([$prefixes[] | . as $p | select($label | startswith($p)) | $p] | first) as $found
      | (if $found then $label[($found | length):] else $label end) as $bare
      | select($bare != "")
      # Never mark the tab you are already looking at. `done` fires every time
      # an agent finishes a turn, so the focused tab would wear a marker almost
      # constantly and dilute the signal on tabs that actually need you. This is
      # also why the manifest hooks tab.focused/workspace.focused: without them
      # the marker would linger until the next status change.
      | (if .tab_id == $s.focused_tab_id
         then null
         else ($marks[.agent_status // ""] // null) end) as $glyph
      | (if $glyph then $glyph + " " + $bare else $bare end) as $want
      | select($want != $label)
      | [.tab_id, $label, $want] | @tsv
    '
}

apply() {
    while IFS=$'\t' read -r tab_id old new; do
        [ -n "$tab_id" ] || continue
        if [ "$dry_run" -eq 1 ]; then
            printf 'would rename  %-10s  %-34s -> %s\n' "$tab_id" "$old" "$new"
        else
            "$herdr" tab rename "$tab_id" "$new" >/dev/null 2>&1 || true
        fi
    done < <(reconcile)
}

if [ "$dry_run" -eq 1 ]; then
    apply
    exit 0
fi

# Coalescing lock. 23 agents changing state produce bursts of events, and
# overlapping renames would fight each other. A skipped run loses nothing
# because every run reconciles the *whole* tab list from a fresh snapshot --
# it only has to be re-run once more afterwards, which is what RERUN requests.
LOCK="${TMPDIR:-/tmp}/herdr-tab-status.lock"
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
