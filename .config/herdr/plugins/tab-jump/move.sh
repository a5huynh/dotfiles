#!/usr/bin/env bash
# Move a whole tab -- every pane, its split layout, labels and zoom -- into
# another workspace. herdr has no tab move, only `pane move`, so this replays
# the tab's layout tree one pane at a time.
#
#   move.sh [--dry-run] <tab_id> <workspace_id>
#   move.sh [--dry-run] <tab_id> --new [WORKSPACE_LABEL]
#
# Offline testing:
#   TAB_JUMP_SNAPSHOT=snap.json TAB_JUMP_LAYOUT=layout.json ./move.sh --dry-run w1:t1 w2
# where layout.json is a `layout.export` response.
set -euo pipefail

if [ -n "${TAB_JUMP_DEBUG:-}" ]; then
    exec 2>>"${TMPDIR:-/tmp}/tab-jump.log"
    echo "=== $(date) move.sh $* ===" >&2
    set -x
fi

herdr="${HERDR_BIN_PATH:-herdr}"

dry=""
if [ "${1:-}" = "--dry-run" ]; then dry=1; shift; fi

tab_id="${1:-}"
dest="${2:-}"
new_label="${3:-}"
if [ -z "$tab_id" ] || [ -z "$dest" ]; then
    echo "usage: move.sh [--dry-run] <tab_id> <workspace_id|--new [LABEL]>" >&2
    exit 2
fi

die() { echo "tab-jump: $*" >&2; exit 1; }

snapshot() {
    if [ -n "${TAB_JUMP_SNAPSHOT:-}" ]; then cat "$TAB_JUMP_SNAPSHOT"; else "$herdr" api snapshot; fi
}

# The CLI has no `layout export`, and `pane layout` flattens the splits into a
# list that cannot be turned back into a tree, so ask the socket directly. This
# is read-only; every mutation below still goes through the CLI.
export_layout() {
    if [ -n "${TAB_JUMP_LAYOUT:-}" ]; then cat "$TAB_JUMP_LAYOUT"; return; fi
    [ -S "${HERDR_SOCKET_PATH:-}" ] || return 1
    command -v nc >/dev/null 2>&1 || return 1
    printf '{"id":"tab-jump","method":"layout.export","params":{"tab_id":"%s"}}\n' "$tab_id" |
        nc -U -w 2 "$HERDR_SOCKET_PATH"
}

snap=$(snapshot)
info=$(printf '%s' "$snap" | jq -c --arg t "$tab_id" --arg d "$dest" '
    .result.snapshot as $s
    | ($s.tabs[] | select(.tab_id == $t)) as $tab
    | {
        label:   ($tab.label // ""),
        src:     $tab.workspace_id,
        src_tabs: ([$s.tabs[] | select(.workspace_id == $tab.workspace_id)] | length),
        dest_ok: ($d == "--new" or any($s.workspaces[]; .workspace_id == $d)),
        dest_label: (($s.workspaces[] | select(.workspace_id == $d) | .label) // ""),
        panes:   [$s.panes[] | select(.tab_id == $t) | .pane_id]
      }
') || true
[ -n "$info" ] || die "tab $tab_id not found"

tab_label=$(jq -r '.label' <<<"$info")
# A tab-status marker belongs on the tab label, which keeps it (pane.moved is
# not a tab-status trigger, so stripping it would leave a done tab unmarked),
# but not in a workspace name derived from it. Same glyph list as `unmark` in
# jump.sh and GLYPHS in plugins/tab-status/mark.sh.
bare_label=$tab_label
for m in "▲ " "✓ "; do bare_label=${bare_label#"$m"}; done
src=$(jq -r '.src' <<<"$info")
[ "$(jq -r '.dest_ok' <<<"$info")" = true ] || die "workspace $dest not found"
[ "$dest" != "$src" ] || die "tab is already in that workspace"
[ "$(jq '.panes | length' <<<"$info")" -gt 0 ] || die "tab $tab_id has no panes"

# One op per line, tab-separated:
#   first  <pane>
#   split  <pane> <target> <direction> <ratio>
#   label  <pane> <label>
#   zoom   <pane>
#
# The region a split node covers is always held by its *first* leaf: the root's
# first leaf is moved first, and every `split` places the second subtree's first
# leaf. So a pre-order walk can split leaf(first) to place leaf(second), then
# recurse into each half, and every split lands inside a region that already
# exists. Ratios carry over unchanged: both `layout.export` and `pane move
# --ratio` give the share of the *first* pane.
ops=$(export_layout 2>/dev/null | jq -r '
    def leaf: if .type == "pane" then .pane_id else (.first | leaf) end;
    def splits:
        if .type == "pane" then empty
        else ["split", (.second | leaf), (.first | leaf), .direction, (.ratio | tostring)],
             (.first | splits), (.second | splits)
        end;
    .result.layout
    | ["first", (.root | leaf)],
      (.root | splits),
      (.root | .. | objects | select(.type? == "pane" and (.label // "") != "") | ["label", .pane_id, .label]),
      (if .zoomed and .focused_pane_id then ["zoom", .focused_pane_id] else empty end)
    | @tsv
' 2>/dev/null) || ops=""

# Without a layout tree the tab still moves; it just loses its arrangement.
if [ -z "$ops" ]; then
    echo "tab-jump: layout export unavailable, panes will be placed side by side" >&2
    ops=$(jq -r '
        .panes as $p
        | ["first", $p[0]],
          (range(1; $p | length) as $i | ["split", $p[$i], $p[$i - 1], "right", "0.5"])
        | @tsv
    ' <<<"$info")
fi

# old pane id -> new pane id. Moving a pane into another workspace gives it a
# new id, and every later split has to target the *new* one. Bash 3.2 (macOS's
# /bin/bash) has no associative arrays, hence a newline-separated string.
# Dry-run output only. Bash 3.2's printf %q escapes every non-ASCII byte.
show() {
    local a out="herdr"
    for a in "$@"; do
        case "$a" in
            *[!A-Za-z0-9_./:=-]* | "") out+=" '${a//\'/\'\\\'\'}'" ;;
            *) out+=" $a" ;;
        esac
    done
    echo "$out"
}

map=""
new_tab=""
new_id() { printf '%s\n' "$map" | awk -F'\t' -v k="$1" '$1 == k { print $2; exit }'; }

run_move() {
    local old="$1"; shift
    if [ -n "$dry" ]; then
        show pane move "$old" "$@"
        map+="$old"$'\t'"new($old)"$'\n'
        new_tab="<new tab>"
        return
    fi
    local out id
    out=$("$herdr" pane move "$old" "$@" --no-focus 2>&1) || true
    # A refused move is not an error: herdr answers success with
    # `changed: false` and a `reason` (e.g. zoomed_tab), and echoes the pane
    # back where it was. Trusting the pane id alone reports a move that never
    # happened.
    id=$(jq -r '.result.move_result | select(.changed != false) | .pane.pane_id // empty' \
        <<<"$out" 2>/dev/null) || id=""
    if [ -z "$id" ]; then
        local msg
        msg=$(jq -r '.error.message // .result.move_result.reason // empty' <<<"$out" 2>/dev/null) || msg=""
        die "moving pane $old failed: ${msg:-$out}"
    fi
    map+="$old"$'\t'"$id"$'\n'
    new_tab=$(jq -r '.result.move_result.pane.tab_id' <<<"$out")
}

run() {
    if [ -n "$dry" ]; then show "$@"; return; fi
    "$herdr" "$@" >/dev/null
}

# herdr refuses to move a pane out of a zoomed tab (reason: zoomed_tab), so
# unzoom the source first; the `zoom` op re-applies it at the destination.
# Keyed on pane count rather than the `zoom` op so the no-layout fallback, which
# cannot see zoom state, is covered too.
if [ "$(jq '.panes | length' <<<"$info")" -gt 1 ]; then
    run pane zoom "$(jq -r '.panes[0]' <<<"$info")" --off
fi

count=0
while IFS=$'\t' read -r op a b c d; do
    case "$op" in
        first)
            if [ "$dest" = "--new" ]; then
                args=(--new-workspace)
                ws_label="${new_label:-$bare_label}"
                [ -n "$ws_label" ] && args+=(--label "$ws_label")
                [ -n "$tab_label" ] && args+=(--tab-label "$tab_label")
            else
                args=(--new-tab --workspace "$dest")
                [ -n "$tab_label" ] && args+=(--label "$tab_label")
            fi
            run_move "$a" "${args[@]}"
            count=$((count + 1))
            ;;
        split)
            target=$(new_id "$b")
            [ -n "$target" ] || die "layout references unplaced pane $b"
            run_move "$a" --tab "$new_tab" --target-pane "$target" --split "$c" --ratio "$d"
            count=$((count + 1))
            ;;
        label) run pane rename "$(new_id "$a")" "$b" ;;
        zoom)  run pane zoom "$(new_id "$a")" --on ;;
        *) continue ;;
    esac
done <<<"$ops"

where=$(jq -r '.dest_label' <<<"$info")
[ "$dest" = "--new" ] && where="new workspace ${new_label:-$bare_label}"
echo "moved ${tab_label:-$tab_id} → ${where:-$dest} ($count pane$([ "$count" = 1 ] || echo s))"
