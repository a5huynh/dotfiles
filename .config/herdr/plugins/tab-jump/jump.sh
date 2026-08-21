#!/usr/bin/env bash
# Fuzzy-search every tab in the session and jump to the one you pick.
# Runs inside a herdr plugin popup pane; see herdr-plugin.toml.
set -euo pipefail

# A plugin pane's stderr dies with its pty, so failures are otherwise invisible.
# Reproduce with: herdr plugin pane open --plugin tab-jump --entrypoint picker \
#   --env TAB_JUMP_DEBUG=1
if [ -n "${TAB_JUMP_DEBUG:-}" ]; then
    exec 2>>"${TMPDIR:-/tmp}/tab-jump.log"
    echo "=== $(date) pane=${HERDR_PANE_ID:-?} tty=$(tty || echo none) ===" >&2
    set -x
fi

herdr="${HERDR_BIN_PATH:-herdr}"

# The popup vanishes the instant this script exits, so a bare failure here would
# be invisible. Report it on the pane and wait for a keypress instead.
for dep in jq fzf; do
    command -v "$dep" >/dev/null 2>&1 && continue
    printf 'tab-jump: %s not found in PATH\n(press any key)\n' "$dep" >&2
    read -r -n 1 -s
    exit 1
done

rows=$("$herdr" api snapshot | jq -r --arg home "$HOME" '
  def pad($n): . + (" " * ([$n - (. | length), 0] | max));
  def clip($n): if (. | length) > $n then .[:$n - 1] + "…" else . end;
  def shorten: if startswith($home) then "~" + .[($home | length):] else . end;

  .result.snapshot as $s
  | ($s.workspaces | INDEX(.workspace_id))          as $ws
  | ($s.panes | group_by(.tab_id) | INDEX(.[0].tab_id)) as $panes

  | [ $s.tabs[]
      | . as $t
      | $ws[$t.workspace_id]                        as $w
      | ($panes[$t.tab_id] // [])                   as $p
      | (($p | map(select(.agent != null)) | first) // ($p | first)) as $lead
      | {
          tab_id:  $t.tab_id,
          pane_id: ($lead.pane_id // ""),
          key:     "\($w.number // 0).\($t.number)",
          here:    ($t.tab_id == $s.focused_tab_id),
          status:  ($t.agent_status // ""),
          name:    ("\($w.label // $t.workspace_id) › \($t.label // $t.tab_id)" | clip(34)),
          title:   (($lead.terminal_title_stripped // "") | clip(46)),
          cwd:     (($lead.cwd // "") | shorten)
        }
    ]
  | (map(.key  | length) | max // 0)  as $wkey
  | (map(.name | length) | max // 0)  as $wname
  | (map(.title| length) | max // 0)  as $wtitle

  | .[]
  | (if   .status == "idle"    then "\u001b[38;2;158;206;106m●"
     elif .status == "working" then "\u001b[38;2;224;175;104m◐"
     elif .status == "blocked" then "\u001b[38;2;247;118;142m▲"
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
')

[ -n "$rows" ] || exit 0

# --with-shell is required, not tidiness: fzf runs child processes with `$SHELL -c`,
# which here is fish, and the preview below is POSIX sh. (The give-away is fish
# reporting `${ is not a valid variable`.)
#
# The preview is bottom-anchored so you see what the tab was last doing. fzf always
# renders a preview from its first line, so "scroll to the end" is really "feed it
# exactly as many lines as the window is tall" -- hence tail -n $FZF_PREVIEW_LINES
# (which fzf exports as the window's true height). `nowrap` is part of the same
# mechanism, not cosmetic: with wrapping on, one long line renders as several rows
# and pushes that many lines of the newest output back off the bottom.
selection=$(
    printf '%s\n' "$rows" | fzf \
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
        --preview="[ -n {3} ] && \"$herdr\" pane read {3} --source recent-unwrapped --lines 200 --format ansi 2>/dev/null | tail -n \"\${FZF_PREVIEW_LINES:-40}\""
) || exit 0

tab_id=$(printf '%s' "$selection" | cut -f2)
[ -n "$tab_id" ] || exit 0

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
