#!/bin/sh
# Marks the zellij tab running this Claude Code session with a bell icon
# while Claude is waiting for input, and clears it when the user responds.
#
# Modes (first argument):
#   track  - remember which tab this session lives in, then clear the icon.
#            Wired to SessionStart/UserPromptSubmit: the user is necessarily
#            focused on Claude's tab when typing into it, so the focused tab
#            reported by `current-tab-info` is the right one. This self-heals
#            the mapping on every interaction.
#   notify - prepend the icon to the remembered tab's name (Stop/Notification/
#            PermissionRequest).
#   clear  - strip the icon from the remembered tab's name (SessionEnd,
#            PostToolUse so the icon drops once a permission is approved).
#
# Uses `rename-tab-by-id` (zellij >= 0.43): plain `rename-tab` acts on the
# user's *focused* tab, which is the wrong tab exactly when the icon matters.

[ -n "$ZELLIJ" ] && [ -n "$ZELLIJ_SESSION_NAME" ] && [ -n "$ZELLIJ_PANE_ID" ] || exit 0

ICON="🔔"
MODE="${1:-notify}"
STATE_DIR="${TMPDIR:-/tmp}/claude-zellij-tabs"
STATE_FILE="$STATE_DIR/${ZELLIJ_SESSION_NAME}-${ZELLIJ_PANE_ID}"

# Tab name is read fresh from zellij on every call (never cached) so a tab
# the user renamed mid-session keeps its new name.
tab_name_by_id() {
    zellij action list-tabs 2>/dev/null \
        | awk -v id="$1" '$1 == id { sub(/^[0-9]+[ \t]+[0-9]+[ \t]+/, ""); print; exit }'
}

case "$MODE" in
    track)
        mkdir -p "$STATE_DIR"
        tab_id=$(zellij action current-tab-info 2>/dev/null | awk '/^id:/ { print $2 }')
        [ -n "$tab_id" ] || exit 0
        echo "$tab_id" > "$STATE_FILE"
        ;;
esac

tab_id=$(cat "$STATE_FILE" 2>/dev/null)
[ -n "$tab_id" ] || exit 0

name=$(tab_name_by_id "$tab_id")
[ -n "$name" ] || exit 0
base=${name#"$ICON "}

case "$MODE" in
    notify)
        [ "$name" = "$ICON $base" ] || zellij action rename-tab-by-id "$tab_id" "$ICON $base" 2>/dev/null
        ;;
    track|clear)
        [ "$name" = "$base" ] || zellij action rename-tab-by-id "$tab_id" "$base" 2>/dev/null
        ;;
esac

exit 0
