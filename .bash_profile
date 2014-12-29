export SVN_EDITOR=subl
export EDITOR=vim

export PATH="/usr/local/bin:/usr/local/sbin:~/bin:$PATH"

# Setup Docker host
export DOCKER_HOST=tcp://$(boot2docker ip 2>/dev/null):2376
export DOCKER_CERT_PATH=~/.boot2docker/certs/boot2docker-vm
export DOCKER_TLS_VERIFY=1

# Setup GOPATH
export GOPATH="/usr/local/golang"

#-------------------------------------------------------------------------------
# If we have the sdcv tool installed, create a "define" function to make
# calling it super easy
#-------------------------------------------------------------------------------
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
# Setup Python & virtualenvwrapper
#-------------------------------------------------------------------------------
export WORKON_HOME=~/.pyenvs
export PROJECT_HOME=$HOME/Documents/Current\ Work
source /usr/local/bin/virtualenvwrapper.sh

#-------------------------------------------------------------------------------
# Setup a nice terminal prompt
#-------------------------------------------------------------------------------
# Load up handy-dandy git prompt functions
source /Library/Developer/CommandLineTools/usr/share/git-core/git-prompt.sh
export PS1="\[$(tput bold)\]\w\$(__git_ps1)\n\[$(tput setaf 1)\]> \[$(tput sgr0)\]"

#-------------------------------------------------------------------------------
# Setup some nice autocompletion functionality
#-------------------------------------------------------------------------------

# SSH Config tab completion
complete -W "$(grep '^Host' ~/.ssh/config | sort -u | sed s/Host\ //)" ssh scp sftp

# Git autocompletetion
if [ -f ~/.git-completion.bash ]; then
    . ~/.git-completion.bash
fi

# Pyenv autoccompletion
export PYENV_ROOT=/usr/local/opt/pyenv
if which pyenv > /dev/null; then eval "$(pyenv init -)"; fi
if which pyenv-virtualenv-init > /dev/null; then eval "$(pyenv virtualenv-init -)"; fi
