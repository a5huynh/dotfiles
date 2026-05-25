#!/bin/bash
set -e;

echo "-> Checking for homebrew";
if ! command -v brew &> /dev/null; then
    echo "-> Installing homebrew";
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
    echo "-> Homebrew is already installed";
fi