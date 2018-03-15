function fish_prompt --description "Customize terminal prompt"
    # Add a newline between prompt and results above.
    echo ""
    _env_hints

    #
    # User
    set --local user (id -un $USER)
    __print_color $SCHEME_PRIMARY "$user"

    #
    # Hostname
    set --local host_name (hostname -s)
    __print_color $SCHEME_GREY " at "
    __print_color $SCHEME_SECONDARY "$host_name"

    #
    # Current working directory
    set --local pwd_string (prompt_pwd)
    __print_color $SCHEME_GREY " in "
    __print_color $SCHEME_PURP "$pwd_string"

    echo ""
    __print_color $SCHEME_PRIMARY "> "
end
