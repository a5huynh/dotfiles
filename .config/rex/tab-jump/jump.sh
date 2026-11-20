#!/usr/bin/env bash
# Fuzzy-search every tab in every Rex session and jump to the one you pick.
# Opened in a floating pane by the tab_jump action in ../init.lua (ctrl+b y).
# A port of ../../herdr/plugins/tab-jump/jump.sh: rows show agent status,
# `session › tab` and the folder, with a live preview of the tab's output.
#
# Entrypoints:
#   jump.sh            the picker
#   jump.sh --rows     print the TSV rows and exit
#
# REX_TAB_JUMP_SNAPSHOT=file.json replaces the live snapshot (rows.lua's output),
# so the rendering and sorting can be checked offline with no Rex server.
set -euo pipefail

# The floating pane closes the instant this exits, taking stderr with it.
if [ -n "${REX_TAB_JUMP_DEBUG:-}" ]; then
    exec 2>>"${TMPDIR:-/tmp}/rex-tab-jump.log"
    echo "=== $(date) session=${REX_SESSION:-?} arg=${1:-} ===" >&2
    set -x
fi

here="$(cd "$(dirname "$0")" && pwd)"

snapshot() {
    if [ -n "${REX_TAB_JUMP_SNAPSHOT:-}" ]; then
        cat "$REX_TAB_JUMP_SNAPSHOT"
    else
        rex do "$here/rows.lua" --json
    fi
}

rows() {
    snapshot | jq -r --arg home "$HOME" --arg cur "${REX_SESSION:-}" '
      def pad($n): . + (" " * ([$n - (. | length), 0] | max));
      def clip($n): if (. | length) > $n then .[:$n - 1] + "…" else . end;
      def shorten: if startswith($home) then "~" + .[($home | length):] else . end;

      # Same attention order as herdr: the two states that want you, then busy,
      # then quiet, then tabs with no agent at all.
      {"blocked": 0, "error": 0, "done": 1, "working": 2, "idle": 3} as $rank

      | map(
          # Rex names an unnamed tab "Window <8 hex>", which says nothing; the
          # terminal title (e.g. pi'"'"'s "π - <dir>") is the better fallback.
          (if (.window | test("^Window [0-9a-f]{8}$")) and (.title != "")
           then .title else .window end) as $tab
          | . + {
              rank: ($rank[.status] // 4),
              key:  "\(.snum).\(.wnum)",
              cur:  (.here and .session_id == $cur),
              name: ("\(.session) › \($tab)" | clip(40)),
              dir:  (.cwd | shorten)
            })
      | sort_by([.rank, .snum, .wnum])
      | (map(.key  | length) | max // 0) as $wkey
      | (map(.name | length) | max // 0) as $wname
      | .[]
      | (if   .status == "idle"    then "\u001b[38;2;158;206;106m●"
         elif .status == "working" then "\u001b[38;2;224;175;104m◐"
         elif .status == "blocked" then "\u001b[38;2;247;118;142m▲"
         elif .status == "error"   then "\u001b[38;2;247;118;142m✗"
         elif .status == "done"    then "\u001b[38;2;125;207;255m✓"
         else "\u001b[38;2;86;95;137m○" end) as $dot
      | [ "\($dot)\u001b[0m "
          + "\u001b[38;2;86;95;137m\(.key | pad($wkey))\u001b[0m "
          + (if .cur then "\u001b[38;2;122;162;247m" else "\u001b[0m" end)
          + "\(.name | pad($wname))\u001b[0m  "
          + "\u001b[38;2;169;177;214m\(.dir)\u001b[0m",
          .session_id, .window_id, .block_id ]
      | @tsv'
}

if [ "${1:-}" = --rows ]; then
    rows
    exit 0
fi

for dep in jq fzf; do
    command -v "$dep" >/dev/null 2>&1 && continue
    printf 'tab-jump: %s not found in PATH\n(press any key)\n' "$dep" >&2
    read -r -n 1 -s
    exit 1
done

list=$(rows)
[ -n "$list" ] || exit 0

# Bottom-anchored preview, as in the herdr version: fzf draws a preview from its
# first line, so feed it exactly as many lines as the window is tall. nowrap is
# part of that -- a wrapped line would push the newest output off the bottom.
# --with-shell because $SHELL is fish and the preview is POSIX sh.
pick=$(
    printf '%s\n' "$list" | fzf \
        --with-shell='sh -c' \
        --ansi \
        --delimiter='\t' \
        --with-nth=1 \
        --layout=reverse \
        --info=inline \
        --border=none \
        --prompt='jump › ' \
        --pointer='▌' \
        --header='enter jump · ctrl-r refresh preview · esc cancel' \
        --header-first \
        --color='fg+:#c0caf5,bg+:#292e42,hl:#7aa2f7,hl+:#7aa2f7,prompt:#7aa2f7,pointer:#7aa2f7,header:#565f89,border:#3b4261' \
        --preview-window='down,60%,border-top,nowrap' \
        --bind='ctrl-r:refresh-preview' \
        --preview='rex capture -s {2} -b {4} --trim --unwrap --format vt 2>/dev/null | tail -n "${FZF_PREVIEW_LINES:-40}"'
) || exit 0

session_id=$(cut -f2 <<<"$pick")
window_id=$(cut -f3 <<<"$pick")
block_id=$(cut -f4 <<<"$pick")
[ -n "$block_id" ] || exit 0

# Another session has to be shown by the app itself, which only takes actions
# from the CLI with Remote Control on (Settings > Rex Server). Within the current
# session a server-side focus is enough.
if [ "$session_id" != "${REX_SESSION:-}" ]; then
    if ! err=$(rex do session.select session_id="$session_id" window_id="$window_id" 2>&1); then
        printf '%s\n(press any key)\n' "$err" >&2
        read -r -n 1 -s
        exit 1
    fi
fi
rex focus -s "$session_id" "$block_id" >/dev/null
