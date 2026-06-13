function clearbell --description 'Strip the Claude-waiting 🔔 from the focused zellij tab'
    if test -z "$ZELLIJ"
        echo "clearbell: not inside zellij" >&2
        return 1
    end
    set -l info (zellij action current-tab-info)
    set -l id (string match -gr '^id: (\d+)' -- $info)
    set -l name (string match -gr '^name: (.*)' -- $info)
    if test -z "$id"
        echo "clearbell: could not read current tab" >&2
        return 1
    end
    zellij action rename-tab-by-id $id (string replace -r '^🔔 ' '' -- $name)
end
