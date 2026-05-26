default:
    @just --list

# Install everything in the Brewfile (taps, brews, casks)
bootstrap:
    brew bundle --file="{{justfile_directory()}}/Brewfile"

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
install: install-fish install-vim install-git install-zed

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
