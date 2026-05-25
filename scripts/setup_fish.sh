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
if [ -d "$HOME/.config/fish/functions/fisher.fish" ]; then
    echo "-> installing fisher, fish plugin manager";
    fish -c "curl -sL https://git.io/fisher | source && fisher install jorgebucaran/fisher";
else
    echo "-> fish plugin manager already installed, skipping";
fi

# Copies fish_plugins file to config folder and installs fish plugins
echo "-> install/updating fish plugins";
cp -n $PWD/.config/fish/fish_plugins $HOME/.config/fish || true;
fish -c "fisher update";

# Copies over custom functions but doesn't overwrite existing ones.
echo "-> installing custom functions";
cp -n $PWD/.config/fish/functions/*.fish $HOME/.config/fish/functions || true;