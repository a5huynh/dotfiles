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
