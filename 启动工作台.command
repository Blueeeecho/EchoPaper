#!/bin/zsh
set -e
cd -- "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  print '未找到 Node.js。请安装 Node.js 22 或更新版本后重新打开。'
  read -r '?按回车键关闭。'
  exit 1
fi
node _system/scripts/control.mjs start
