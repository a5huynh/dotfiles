# Place any environment variables initialization here.
set -x PYENV_ROOT ~/.pyenv
# Disable virtualenv prompt
set -x PYENV_VIRTUALENV_DISABLE_PROMPT 1
set -x VIRTUAL_ENV_DISABLE_PROMPT 1

# Setting up cargo (rustlang) env.
if [ -f $HOME/.cargo/env ];
    source $HOME/.cargo/env;
end
