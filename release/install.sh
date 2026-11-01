#!/bin/sh
# Add the WorldBuilder Level Editor to your applications menu, from wherever this folder is.
#   ./install.sh               add it (run it again if you move the folder)
#   ./install.sh --uninstall   take it out again
set -e
here=$(cd "$(dirname "$0")" && pwd)
share=${XDG_DATA_HOME:-$HOME/.local/share}
desktop="$share/applications/worldbuilder-editor.desktop"
icon="$share/icons/hicolor/256x256/apps/worldbuilder-editor.png"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$desktop" "$icon"
  echo "Removed the WorldBuilder Level Editor from the applications menu."
  exit 0
fi

mkdir -p "$(dirname "$desktop")" "$(dirname "$icon")"
cp "$here/data/icon.png" "$icon"
cat >"$desktop" <<END
[Desktop Entry]
Type=Application
Name=WorldBuilder Level Editor
Comment=Edit missions for LEGO World Builder and World Builder 2
Exec="$here/worldbuilder-editor" %f
Icon=worldbuilder-editor
Terminal=false
Categories=Game;
END
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$share/applications" >/dev/null 2>&1 || true
echo "Added the WorldBuilder Level Editor to the applications menu."
