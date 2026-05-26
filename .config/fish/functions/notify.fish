function notify --argument-names msg --description "display a notification"
    osascript -e "display notification \"$msg\" with title \"Success\""
    # todo: handle other os's?
end
