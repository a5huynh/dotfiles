export SVN_EDITOR=subl
export EDITOR=vim

#--------------------------------------------------------------------------------
# Useful aliases
#--------------------------------------------------------------------------------
alias g='git'
alias d='docker'
alias ll="ls -Alhtr"
alias cl='clear'

# Make sure all our local bin folders in the path
if [[ "$PATH" != *"~/bin"* ]]; then
    export PATH="~/.local/lib/aws/bin:/usr/local/bin:/usr/local/sbin:~/bin:$PATH"
fi

# Setup GOPATH
export GOPATH="/usr/local/golang"

# Make sure gopath is in our path
if [[ "$PATH" != *"/usr/local/golang"* ]]; then
    export PATH="/usr/local/golang/bin:$PATH"
fi

#-------------------------------------------------------------------------------
# If we have the sdcv tool installed, create a "define" function to make
# calling it super easy
#-------------------------------------------------------------------------------
export STARDICT_DATA_DIR="/usr/local/share/stardict";
define () {
    if command -v sdcv > /dev/null; then
        # -0 show UTF-8 output
        # -c show colorized output
        sdcv -0c "$@"
    else
        echo "You need to install sdcv."
    fi
}
#-------------------------------------------------------------------------------
# Setup a nice terminal prompt
#-------------------------------------------------------------------------------
export PS1="\[$(tput bold)\]\w\$(__git_ps1)\n\[$(tput setaf 1)\]> \[$(tput sgr0)\]"

#-------------------------------------------------------------------------------
# Setup some nice autocompletion functionality
#-------------------------------------------------------------------------------

# SSH Config tab completion
if [ -f $HOME/.ssh/config ]; then
    complete -W "$(grep '^Host' ~/.ssh/config | sort -u | sed s/Host\ //)" ssh scp sftp
fi

# Git autocompletetion
if [ -f ~/.git-completion.bash ]; then
    . ~/.git-completion.bash
fi

# Pyenv setup and autocompletion
export PYENV_ROOT=~/.pyenv
if which pyenv > /dev/null; then eval "$(pyenv init -)"; fi
if which pyenv-virtualenv-init > /dev/null; then eval "$(pyenv virtualenv-init -)"; fi
