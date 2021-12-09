#!/bin/bash
set -e;
# Make sure .config folder exists
mkdir -p $HOME/.config;

# Link fish config
if [ -d "$HOME/.config/fish" ]; then
    echo "-> fish folder already exists, skipping";
else
    echo "-> linking fish config folder";
    ln -s $PWD/.config/fish $HOME/.config;
fi

# Installs/updates fisher, fish plugin manager
fish -c "curl -sL https://git.io/fisher | source && fisher install jorgebucaran/fisher";

# Copies fish_plugins file to config folder and installs fish plugins
cp $PWD/.config/fish/fish_plugins $HOME/.config/fish;
fish -c "fisher update";

# Copies over custom functions
cp $PWD/.config/fish/functions/*.fish $HOME/.config/fish/functions