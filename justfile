default:
    @just --list

# Install everything in the Brewfile (taps, brews, casks)
bootstrap:
    brew bundle --file="{{justfile_directory()}}/Brewfile"

# Symlink everything into $HOME
install: install-fish install-vim install-tmux install-git install-bash install-zed

install-fish:
    ./scripts/setup_fish.sh

install-vim:
    @just _link "{{justfile_directory()}}/.vimrc" "$HOME/.vimrc"
    @just _link "{{justfile_directory()}}/.vim" "$HOME/.vim"

install-tmux:
    @just _link "{{justfile_directory()}}/.tmux.conf" "$HOME/.tmux.conf"

install-git:
    @just _link "{{justfile_directory()}}/.gitconfig" "$HOME/.gitconfig"
    @just _link "{{justfile_directory()}}/.gitignore_global" "$HOME/.gitignore_global"

install-bash:
    @just _link "{{justfile_directory()}}/.bash_profile" "$HOME/.bash_profile"

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
