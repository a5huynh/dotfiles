default:
    @just --list

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

# Symlink individual files — Zed writes runtime state (conversations, prompts DB)
# into ~/.config/zed, so we don't link the whole directory.
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
