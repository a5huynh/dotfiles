default:
    @just --list

# Install Homebrew (if missing) then everything in the Brewfile
bootstrap: bootstrap-homebrew
    brew bundle --file="{{justfile_directory()}}/Brewfile"

# Install Homebrew via the official installer if it's not already present
bootstrap-homebrew:
    #!/usr/bin/env bash
    set -euo pipefail
    if command -v brew &> /dev/null; then
        echo "-> Homebrew is already installed"
    else
        echo "-> Installing Homebrew"
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi

# Install fish/vim plugins (run AFTER `just install` — plugin managers read from $HOME)
bootstrap-plugins: bootstrap-fish-plugins bootstrap-vim-plugins

bootstrap-fish-plugins:
    fish -c "fisher update"

bootstrap-vim-plugins:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d "$HOME/.vim/bundle/Vundle.vim" ]; then
        echo "-> cloning Vundle"
        git clone https://github.com/VundleVim/Vundle.vim.git "$HOME/.vim/bundle/Vundle.vim"
    fi
    vim +PluginInstall +qall

# Symlink everything into $HOME
install: install-fish install-vim install-git install-zed install-zellij

install-fish:
    @mkdir -p "$HOME/.config"
    @just _link "{{justfile_directory()}}/.config/fish" "$HOME/.config/fish"

install-vim:
    @mkdir -p "{{justfile_directory()}}/.vim/backup" "{{justfile_directory()}}/.vim/tmp"
    @just _link "{{justfile_directory()}}/.vimrc" "$HOME/.vimrc"
    @just _link "{{justfile_directory()}}/.vim" "$HOME/.vim"

install-git:
    @just _link "{{justfile_directory()}}/.gitconfig" "$HOME/.gitconfig"
    @just _link "{{justfile_directory()}}/.gitignore_global" "$HOME/.gitignore_global"

# Symlink Zed config (individual files — Zed writes runtime state alongside)
install-zed:
    @mkdir -p "$HOME/.config/zed"
    @just _link "{{justfile_directory()}}/.config/zed/settings.json" "$HOME/.config/zed/settings.json"
    @just _link "{{justfile_directory()}}/.config/zed/themes" "$HOME/.config/zed/themes"

# Symlink Zellij config (config.kdl + layouts/ — plugins/ stays untracked, it's runtime)
install-zellij:
    @mkdir -p "$HOME/.config/zellij"
    @just _link "{{justfile_directory()}}/.config/zellij/config.kdl" "$HOME/.config/zellij/config.kdl"
    @just _link "{{justfile_directory()}}/.config/zellij/layouts" "$HOME/.config/zellij/layouts"

# Internal: idempotent symlink. Skips if the target already exists.
_link source target:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -e "{{target}}" ] || [ -L "{{target}}" ]; then
        echo "-> {{target}} already exists, skipping"
    else
        echo "-> linking {{target}}"
        ln -s "{{source}}" "{{target}}"
    fi
