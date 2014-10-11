export SVN_EDITOR=subl
export EDITOR=vim

export PATH="/usr/local/bin:/usr/local/sbin:~/bin:$PATH"

# Setup Docker host
export DOCKER_HOST=tcp://$(boot2docker ip 2>/dev/null):2375

# Setup GOPATH
export GOPATH="/usr/local/golang"

#-------------------------------------------------------------------------------
# Setup Python & virtualenvwrapper
#-------------------------------------------------------------------------------
export PYTHONPATH="/usr/local/lib/python2.7/site-packages:$PYTHONPATH"
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
if which pyenv > /dev/null; then eval "$(pyenv init -)"; fi
export PYENV_ROOT=/usr/local/opt/pyenv
