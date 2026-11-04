#!/bin/zsh
set -euo pipefail
workspace_root="$(cd "$(dirname "$0")/../.." && pwd)"
native_root="$workspace_root/_system/native"
output_app="${1:-$workspace_root/EchoPaper.app}"
bundle_id="local.echopaper.workbench"
if [[ -e "$output_app" ]]; then
  existing_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$output_app/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$existing_id" != "$bundle_id" ]]; then
    print -u2 "拒绝覆盖已有的无关应用：$output_app"
    exit 1
  fi
fi
node_path="$(command -v node || true)"
if [[ -z "$node_path" && -x "$HOME/.local/bin/node" ]]; then node_path="$HOME/.local/bin/node"; fi
if [[ -z "$node_path" ]]; then print -u2 '找不到 Node.js。'; exit 1; fi
build_root="$(mktemp -d "${TMPDIR:-/tmp}/echopaper-native.XXXXXX")"
trap 'rm -rf "$build_root"' EXIT
stage_app="$build_root/EchoPaper.app"
mkdir -p "$stage_app/Contents/MacOS" "$stage_app/Contents/Resources" "$native_root/EchoPaper.iconset"
/usr/bin/xcrun clang -fobjc-arc -fno-modules -O2 -mmacosx-version-min=13.0 -framework AppKit "$native_root/Icon.m" -o "$build_root/icon-generator"
"$build_root/icon-generator" "$native_root/EchoPaper.iconset"
/usr/bin/iconutil -c icns "$native_root/EchoPaper.iconset" -o "$native_root/EchoPaper.icns"
cp "$native_root/EchoPaper.icns" "$stage_app/Contents/Resources/EchoPaper.icns"
/usr/bin/xcrun clang -fobjc-arc -fno-modules -O2 -mmacosx-version-min=13.0 -framework AppKit "$native_root/EchoPaper.m" -o "$stage_app/Contents/MacOS/EchoPaper"
/usr/bin/python3 - "$stage_app/Contents/Info.plist" "$workspace_root" "$node_path" <<'PY'
import plistlib, sys
info = {
    'CFBundleName': 'EchoPaper', 'CFBundleDisplayName': 'EchoPaper',
    'CFBundleIdentifier': 'local.echopaper.workbench', 'CFBundleExecutable': 'EchoPaper',
    'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': '1.0', 'CFBundleVersion': '3',
    'CFBundleIconFile': 'EchoPaper.icns', 'LSMinimumSystemVersion': '13.0',
    'NSHighResolutionCapable': True, 'NSPrincipalClass': 'NSApplication',
    'NSHumanReadableCopyright': 'EchoPaper · Local paper writing workspace',
    'NSDesktopFolderUsageDescription': 'EchoPaper 需要访问桌面上的文章工作目录，以启动本地编辑和 LaTeX 编译服务。',
    'EchoPaperWorkspaceRoot': sys.argv[2], 'EchoPaperNodePath': sys.argv[3],
}
with open(sys.argv[1], 'wb') as stream: plistlib.dump(info, stream, sort_keys=False)
PY
/usr/bin/codesign --force --sign - "$stage_app"
if [[ -d "$output_app" ]]; then
  previous_directory="$native_root/previous"
  mkdir -p "$previous_directory"
  legacy_app="$previous_directory/EchoPaper.app"
  if [[ -e "$legacy_app" ]]; then
    previous_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$legacy_app/Contents/Info.plist" 2>/dev/null || true)"
    if [[ "$previous_id" != "$bundle_id" ]]; then print -u2 "备份位置已有无关应用：$legacy_app"; exit 1; fi
    /usr/bin/ditto -c -k --keepParent "$legacy_app" "$previous_directory/EchoPaper-legacy.zip"
    /usr/bin/python3 - "$legacy_app" <<'PY'
import shutil, sys
shutil.rmtree(sys.argv[1])
PY
  fi
  /usr/bin/ditto -c -k --keepParent "$output_app" "$previous_directory/EchoPaper.zip"
  /usr/bin/python3 - "$output_app" <<'PY'
import shutil, sys
shutil.rmtree(sys.argv[1])
PY
fi
mkdir -p "$(dirname "$output_app")"
mv "$stage_app" "$output_app"
/usr/bin/touch "$output_app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$output_app" || true
print "EchoPaper 已构建：$output_app"
