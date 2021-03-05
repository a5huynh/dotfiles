function _env_hints --description "Prompt hits for git, pyenv etc."
    # Bullet point icon
    set --local bullet '\U2022'
    # Git icon
    set --local lambda '\U03BB'
    # Snake icon for pyenv
    set --local snake '\U0001F40D'

    #
    # Current Git branch
    if git_is_repo
        set --local br_name (git_branch_name)
        set --local git_status (git_ahead '+' '-' '±' '✓')

        __print_color $SCHEME_INFO "$lambda $br_name "
        __print_color $SCHEME_GREY "($git_status)"
        # Only print bullet if there is virtualenv
        if set --query VIRTUAL_ENV
            __print_color $SCHEME_GREY " $bullet "
        end
    end

    #
    # Are we in a virtualenv?
    if set --query VIRTUAL_ENV
        # Get the version via pyenv.
        set --global --export PYENV_VERSION (pyenv version-name)
        # Determine the python version in the pyenv
        set --local py_version (python --version 2>&1)

        __print_color $SCHEME_INFO "$snake  $PYENV_VERSION "
        __print_color $SCHEME_GREY "($py_version)"
    end

    # Add a newline after the env hints
    echo ""
end
