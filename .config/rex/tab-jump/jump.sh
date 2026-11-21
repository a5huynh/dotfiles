#!/usr/bin/env bash
# Fuzzy-search every tab in every Rex session and jump to the one you pick.
# Opened in a floating pane by the tab_jump action in ../init.lua (ctrl+b y).
# A port of ../../herdr/plugins/tab-jump/jump.sh. Each row:
#   status + age (or what a blocked agent waits for) · key · session › tab ·
#   task (pane label) · folder · listening ports
#
# Entrypoints:
#   jump.sh            the picker
#   jump.sh --rows     print the TSV rows and exit
#
# REX_TAB_JUMP_SNAPSHOT=file.json replaces the live snapshot (rows.lua's output),
# so the rendering and sorting can be checked offline with no Rex server, and
# REX_TAB_JUMP_NOW=<epoch> pins the clock the ages are measured against.
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
    snapshot | jq -r --arg home "$HOME" --arg cur "${REX_SESSION:-}" \
        --argjson now "${REX_TAB_JUMP_NOW:-$(date +%s)}" '
      def pad($n): . + (" " * ([$n - (. | length), 0] | max));
      def clip($n): if (. | length) > $n then .[:$n - 1] + "…" else . end;
      def shorten: if startswith($home) then "~" + .[($home | length):] else . end;
      def c($rgb): "\u001b[38;2;\($rgb)m\(.)\u001b[0m";

      # Rex stamps reports like 2026-11-20T23:28:23.194065-08:00, which jq'"'"'s
      # fromdateiso8601 rejects (fraction, offset), so parse it by hand.
      def epoch:
        (capture("^(?<dt>\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(\\.\\d+)?(?<tz>Z|[+-]\\d{2}:\\d{2})$") // null) as $m
        | if $m == null then null
          else ($m.dt + "Z" | fromdateiso8601)
               - (if $m.tz == "Z" then 0
                  else ($m.tz[0:1] + "1" | tonumber)
                       * (($m.tz[1:3] | tonumber) * 3600 + ($m.tz[4:6] | tonumber) * 60) end)
          end;
      def ago:
        if . == null then ""
        else ([$now - ., 0] | max) as $s
          | if   $s < 60    then "\($s | floor)s"
            elif $s < 3600  then "\($s / 60 | floor)m"
            elif $s < 86400 then "\($s / 3600 | floor)h"
            else "\($s / 86400 | floor)d" end
        end;

      # Same attention order as herdr: the two states that want you, then busy,
      # then quiet, then tabs with no agent at all.
      {"blocked": 0, "error": 0, "done": 1, "working": 2, "idle": 3} as $rank

      | map(
          # A tab Rex named itself ("Window <8 hex>") is identified by what runs
          # in it instead. The task is the pane label pi sets from the first
          # prompt (session-title.ts), else the terminal title -- but not pi'"'"'s
          # default "π - <dir>", which the folder column already says.
          (if (.window | test("^Window [0-9a-f]{8}$"))
           then (if .program != "" then .program else "tab \(.wnum)" end)
           else .window end) as $tab
          | (if (.label != "" and .label != "shell") then .label
             elif (.title != "" and (.title | startswith("π - ") | not)) then .title
             else "" end) as $task
          | . + {
              rank:  ($rank[.status] // 4),
              key:   "\(.snum).\(.wnum)",
              cur:   (.here and .session_id == $cur),
              name:  ("\(.session) › \($tab)" | clip(32)),
              task:  ($task | clip(40)),
              dir:   (.cwd | shorten),
              # Blocked says what it is waiting for; everything else, for how long.
              when:  (if .status == "blocked" and .kind != "" then .kind
                      elif .status == "" then ""
                      else (.updated_at | epoch | ago) end),
              ports: ((.ports | if type == "array" then . else [] end) | map(":\(.)") | join(" "))
            })
      | sort_by([.rank, .snum, .wnum])
      | (map(.when | length) | max // 0) as $wwhen
      | (map(.key  | length) | max // 0) as $wkey
      | (map(.name | length) | max // 0) as $wname
      | (map(.task | length) | max // 0) as $wtask
      | .[]
      | (if   .status == "idle"    then "158;206;106" | [., "●"]
         elif .status == "working" then "224;175;104" | [., "◐"]
         elif .status == "blocked" then "247;118;142" | [., "▲"]
         elif .status == "error"   then "247;118;142" | [., "✗"]
         elif .status == "done"    then "125;207;255" | [., "✓"]
         else "86;95;137" | [., "○"] end) as [$rgb, $dot]
      | .cur as $here | .status as $st
      | [ ($dot | c($rgb)) + " "
          + ((.when | pad($wwhen)) | c(if $st == "blocked" then $rgb else "86;95;137" end)) + " "
          + ((.key | pad($wkey)) | c("86;95;137")) + " "
          + ((.name | pad($wname)) | if $here then c("122;162;247") else . end) + "  "
          + ((.task | pad($wtask)) | c("169;177;214")) + "  "
          + (.dir | c("86;95;137"))
          + (if .ports != "" then "  " + (.ports | c("115;218;202")) else "" end),
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

pick=$(
    printf '%s\n' "$list" | fzf \
        --ansi \
        --delimiter='\t' \
        --with-nth=1 \
        --layout=reverse \
        --info=inline \
        --border=none \
        --prompt='jump › ' \
        --pointer='▌' \
        --header='enter jump · esc cancel' \
        --header-first \
        --color='fg+:#c0caf5,bg+:#292e42,hl:#7aa2f7,hl+:#7aa2f7,prompt:#7aa2f7,pointer:#7aa2f7,header:#565f89'
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
