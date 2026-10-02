#!/usr/bin/env bash
# Fuzzy-search every tab in the session and jump to the one you pick.
# Runs inside a herdr plugin popup pane; see herdr-plugin.toml.
#
# Sort order:
#   TAB_JUMP_SORT=<status|position|name|cwd>   initial order (default: status)
#   ctrl-s inside the picker cycles through them
#
# ctrl-t sends the highlighted tab to another workspace (see move.sh).
#
# Internal entrypoints, used by fzf's reload binding:
#   --rows [SORT]   print the TSV rows for one sort order and exit
#   --cycle         print the fzf actions that advance to the next sort order
set -euo pipefail

# Ordered, so --cycle can walk it. First entry is also the fallback for an
# unrecognised TAB_JUMP_SORT or an unparseable prompt.
SORTS=(status position name cwd)

# A plugin pane's stderr dies with its pty, so failures are otherwise invisible.
# Reproduce with: herdr plugin pane open --plugin tab-jump --entrypoint picker \
#   --env TAB_JUMP_DEBUG=1
if [ -n "${TAB_JUMP_DEBUG:-}" ]; then
    exec 2>>"${TMPDIR:-/tmp}/tab-jump.log"
    echo "=== $(date) pane=${HERDR_PANE_ID:-?} arg=${1:-} tty=$(tty || echo none) ===" >&2
    set -x
fi

herdr="${HERDR_BIN_PATH:-herdr}"

# fzf re-invokes this script to change the sort, so it needs its own absolute
# path: $0 is already absolute (herdr plugin link records an absolute root),
# but normalise anyway in case it is run by hand from the plugin directory.
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

sort_valid() {
    local s
    for s in "${SORTS[@]}"; do [ "$s" = "${1:-}" ] && return 0; done
    return 1
}

next_sort() {
    local i
    for i in "${!SORTS[@]}"; do
        if [ "${SORTS[$i]}" = "${1:-}" ]; then
            echo "${SORTS[$(((i + 1) % ${#SORTS[@]}))]}"
            return
        fi
    done
    echo "${SORTS[0]}"
}

# Offline testing, mirroring TAB_STATUS_SNAPSHOT in the tab-status plugin:
#   TAB_JUMP_SNAPSHOT=file.json ./jump.sh --rows status
snapshot() {
    if [ -n "${TAB_JUMP_SNAPSHOT:-}" ]; then
        cat "$TAB_JUMP_SNAPSHOT"
    else
        "$herdr" api snapshot
    fi
}

rows_for() {
    snapshot | jq -r --arg home "$HOME" --arg sort "$1" '
      def pad($n): . + (" " * ([$n - (. | length), 0] | max));
      def clip($n): if (. | length) > $n then .[:$n - 1] + "…" else . end;
      def shorten: if startswith($home) then "~" + .[($home | length):] else . end;

      # The tab-status plugin writes its marker into the tab *label*, since
      # the herdr tab bar has no status field of its own. Without stripping it a
      # marked tab shows its glyph twice -- once in the status column below,
      # once inside its own name -- so let the dot carry the signal. This also
      # buys back two columns of real name, and keeps the `name` sort from
      # clustering every marked tab together under ▲/✓ instead of by name.
      # The list mirrors GLYPHS in plugins/tab-status/mark.sh: add, never remove.
      # `as $m` is load-bearing: a bare startswith(.) inside select() would
      # resolve `.` to the piped-in label rather than the glyph, so every label
      # would match itself and lose its first two characters.
      def unmark:
        . as $l
        | ([ ("▲ ", "✓ ") as $m | select($l | startswith($m)) | $m ] | first) as $hit
        | if $hit then $l[($hit | length):] else $l end;

      # Agent priority. The two states that want you come first, and they are
      # exactly the two that plugins/tab-status marks in the tab bar -- herdr
      # considers an agent to want attention when it "finishes or is blocked".
      # Then the ones that are busy, then the ones that are not, then unknown.
      {"blocked": 0, "done": 1, "working": 2, "idle": 3} as $rank

      | .result.snapshot as $s
      | ($s.workspaces | INDEX(.workspace_id))          as $ws
      | ($s.panes | group_by(.tab_id) | INDEX(.[0].tab_id)) as $panes

      | [ $s.tabs[]
          | . as $t
          | $ws[$t.workspace_id]                        as $w
          | ($panes[$t.tab_id] // [])                   as $p
          | (($p | map(select(.agent != null)) | first) // ($p | first)) as $lead
          | ($t.agent_status // "")                     as $status
          | {
              tab_id:  $t.tab_id,
              pane_id: ($lead.pane_id // ""),
              wsnum:   ($w.number // 0),
              tabnum:  ($t.number // 0),
              key:     "\($w.number // 0).\($t.number)",
              here:    ($t.tab_id == $s.focused_tab_id),
              status:  $status,
              rank:    ($rank[$status] // 4),
              name:    ("\($w.label // $t.workspace_id) › \(($t.label // $t.tab_id) | unmark)" | clip(34)),
              title:   (($lead.terminal_title_stripped // "") | clip(46)),
              cwd:     (($lead.cwd // "") | shorten)
            }
        ]

      # Every order tie-breaks on workspace/tab number, so the list is stable
      # across reloads and a workspace stays contiguous inside a status group.
      # Note "position" is a real sort rather than the identity: `api snapshot`
      # returns tabs in no particular order, so leaving them alone looks random.
      | sort_by(
          if   $sort == "status" then [.rank, .wsnum, .tabnum]
          elif $sort == "name"   then [(.name | ascii_downcase), .wsnum, .tabnum]
          elif $sort == "cwd"    then [(.cwd  | ascii_downcase), .wsnum, .tabnum]
          else                        [.wsnum, .tabnum] end
        )

      | (map(.key  | length) | max // 0)  as $wkey
      | (map(.name | length) | max // 0)  as $wname
      | (map(.title| length) | max // 0)  as $wtitle

      | .[]
      | (if   .status == "idle"    then "\u001b[38;2;158;206;106m●"
         elif .status == "working" then "\u001b[38;2;224;175;104m◐"
         elif .status == "blocked" then "\u001b[38;2;247;118;142m▲"
         elif .status == "done"    then "\u001b[38;2;125;207;255m✓"
         else "\u001b[38;2;86;95;137m○" end) as $dot

      | [ "\($dot)\u001b[0m "
          + "\u001b[38;2;86;95;137m\(.key | pad($wkey))\u001b[0m "
          + (if .here then "\u001b[38;2;122;162;247m" else "\u001b[0m" end)
          + "\(.name | pad($wname))\u001b[0m  "
          + "\u001b[38;2;169;177;214m\(.title | pad($wtitle))\u001b[0m  "
          + "\u001b[38;2;86;95;137m\(.cwd)\u001b[0m",
          .tab_id,
          .pane_id
        ]
      | @tsv
    '
}

# fzf exports the live prompt to its child processes, so the prompt *is* the
# sort state -- no lockfile and no scratch file to leak. Keep the emitted
# change-prompt in sync with --prompt below, since this parses it back out.
cycle() {
    local cur next
    cur=$(printf '%s' "${FZF_PROMPT:-}" | awk '{print $2}')
    sort_valid "$cur" || cur=""
    next=$(next_sort "$cur")
    printf 'reload("%s" --rows %s)+change-prompt(jump %s › )' "$self" "$next" "$next"
}

sort_mode="${TAB_JUMP_SORT:-${SORTS[0]}}"
sort_valid "$sort_mode" || sort_mode="${SORTS[0]}"

case "${1:-}" in
    --rows)
        arg="${2:-$sort_mode}"
        sort_valid "$arg" || arg="${SORTS[0]}"
        rows_for "$arg"
        exit 0
        ;;
    --cycle)
        cycle
        exit 0
        ;;
esac

# The popup vanishes the instant this script exits, so a bare failure here would
# be invisible. Report it on the pane and wait for a keypress instead.
for dep in jq fzf; do
    command -v "$dep" >/dev/null 2>&1 && continue
    printf 'tab-jump: %s not found in PATH\n(press any key)\n' "$dep" >&2
    read -r -n 1 -s
    exit 1
done

# Second stage of ctrl-t: pick a destination workspace. Prints move.sh's summary
# on success; returns non-zero when cancelled or when the move fails, after
# showing the error and waiting for a key (the popup would otherwise swallow it).
send_tab() {
    local tab_id="$1" info rows header out query pick dest label
    info=$(snapshot | jq -c --arg t "$tab_id" '
        .result.snapshot as $s
        | ($s.tabs[] | select(.tab_id == $t)) as $tab
        | ($s.workspaces[] | select(.workspace_id == $tab.workspace_id)) as $src
        | {
            tab: ($tab.label // $tab.tab_id),
            src: ($src.label // $src.workspace_id),
            last: ([$s.tabs[] | select(.workspace_id == $tab.workspace_id)] | length) == 1,
            rows: (
              [ $s.workspaces[]
                | select(.workspace_id != $tab.workspace_id)
                | "\u001b[38;2;86;95;137m\(.number)\u001b[0m \(.label // .workspace_id)\t\(.workspace_id)" ]
              + ["\u001b[38;2;158;206;106m+\u001b[0m new workspace\t--new"]
            )
          }') || return 1
    [ -n "$info" ] || return 1

    rows=$(jq -r '.rows[]' <<<"$info")
    header="send $(jq -r '.tab' <<<"$info") from $(jq -r '.src' <<<"$info") · type a new name to create a workspace"
    # Moving the last pane out of a workspace closes it.
    [ "$(jq -r '.last' <<<"$info")" = true ] &&
        header+=$'\n\033[38;2;224;175;104m'"last tab in $(jq -r '.src' <<<"$info") -- that workspace will close"$'\033[0m'

    # accept-or-print-query: with no match fzf prints just the query, so a
    # second output line means "picked a row" and a lone line means "create a
    # workspace with this name".
    out=$(
        printf '%s\n' "$rows" | fzf \
            --ansi \
            --delimiter='\t' \
            --with-nth=1 \
            --layout=reverse \
            --info=hidden \
            --border=none \
            --print-query \
            --bind='enter:accept-or-print-query' \
            --prompt='send to › ' \
            --pointer='▌' \
            --header="$header" \
            --header-first \
            --color='fg+:#c0caf5,bg+:#292e42,hl:#7aa2f7,hl+:#7aa2f7,prompt:#7aa2f7,pointer:#7aa2f7,header:#565f89'
    ) || return 1
    query=$(sed -n 1p <<<"$out")
    pick=$(sed -n 2p <<<"$out")

    if [ -n "$pick" ]; then
        dest=$(cut -f2 <<<"$pick")
        label=""
    else
        [ -n "$query" ] || return 1
        dest="--new"
        label="$query"
    fi

    if ! out=$("$(dirname "$self")/move.sh" "$tab_id" "$dest" ${label:+"$label"} 2>&1); then
        printf '%s\n(press any key)\n' "$out" >&2
        read -r -n 1 -s
        return 1
    fi
    printf '%s' "$out" | tail -n 1
}

header_keys='enter jump · ctrl-t send to workspace · ctrl-s sort · ctrl-r refresh preview · esc cancel'
notice=""

while :; do

rows=$(rows_for "$sort_mode")

[ -n "$rows" ] || exit 0

# --with-shell is required, not tidiness: fzf runs child processes with `$SHELL -c`,
# which here is fish, and the preview below is POSIX sh. (The give-away is fish
# reporting `${ is not a valid variable`.)
#
# ctrl-s re-runs this script rather than re-sorting the rows fzf already holds,
# which means changing the sort also refetches the snapshot -- it doubles as a
# refresh of the list, where ctrl-r refreshes only the preview.
#
# The preview is bottom-anchored so you see what the tab was last doing. fzf always
# renders a preview from its first line, so "scroll to the end" is really "feed it
# exactly as many lines as the window is tall" -- hence tail -n $FZF_PREVIEW_LINES
# (which fzf exports as the window's true height). `nowrap` is part of the same
# mechanism, not cosmetic: with wrapping on, one long line renders as several rows
# and pushes that many lines of the newest output back off the bottom.
out=$(
    printf '%s\n' "$rows" | fzf \
        --with-shell='sh -c' \
        --ansi \
        --delimiter='\t' \
        --with-nth=1 \
        --layout=reverse \
        --info=inline \
        --border=none \
        --prompt="jump $sort_mode › " \
        --pointer='▌' \
        --header="${notice:+$notice$'\n'}$header_keys" \
        --header-first \
        --expect=ctrl-t \
        --color='fg+:#c0caf5,bg+:#292e42,hl:#7aa2f7,hl+:#7aa2f7,prompt:#7aa2f7,pointer:#7aa2f7,header:#565f89,border:#3b4261' \
        --preview-window='down,60%,border-top,nowrap' \
        --bind='ctrl-r:refresh-preview' \
        --bind="ctrl-s:transform:\"$self\" --cycle" \
        --preview="[ -n {3} ] && \"$herdr\" pane read {3} --source recent-unwrapped --lines 200 --format ansi 2>/dev/null | tail -n \"\${FZF_PREVIEW_LINES:-40}\""
) || exit 0

key=$(sed -n 1p <<<"$out")
tab_id=$(sed -n 2p <<<"$out" | cut -f2)
[ -n "$tab_id" ] || exit 0

# A send loops back to the list (refreshed, with the result on top) so several
# tabs can be moved in one go; enter falls through to the jump.
[ "$key" = ctrl-t ] || break
notice=$(send_tab "$tab_id") || notice=""
[ -n "$notice" ] && notice=$'\033[38;2;158;206;106m'"$notice"$'\033[0m'

done

# Focusing has to happen *after* this popup is torn down (the teardown restores
# focus to the pane that was active before, which would undo the jump), so it
# runs in a child that outlives us. Two non-obvious requirements:
#
#   1. `set -m`. The popup pane is a session leader and herdr kills its whole
#      process group on close. A plain `... &` from a non-interactive shell
#      stays in that group and dies before it ever runs; job control is what
#      puts the child in a process group of its own.
#   2. Verify, don't just retry-on-error. `tab focus` reports success even when
#      the teardown immediately steals focus back, so re-read the snapshot and
#      go again until the jump actually sticks.
jump() {
    sleep 0.15
    for _ in 1 2 3 4 5; do
        "$herdr" tab focus "$tab_id" >/dev/null 2>&1 || true
        sleep 0.15
        [ "$("$herdr" api snapshot 2>/dev/null |
              jq -r '.result.snapshot.focused_tab_id // ""')" = "$tab_id" ] && return 0
    done
    return 1
}

set -m
if [ -n "${TAB_JUMP_DEBUG:-}" ]; then
    jump >>"${TMPDIR:-/tmp}/tab-jump.log" 2>&1 &
else
    jump >/dev/null 2>&1 &
fi
disown

exit 0
