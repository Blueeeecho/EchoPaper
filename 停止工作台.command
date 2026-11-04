#!/bin/zsh
set -e
cd -- "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
node _system/scripts/control.mjs stop
