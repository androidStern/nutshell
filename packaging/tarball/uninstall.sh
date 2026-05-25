#!/usr/bin/env sh
set -eu

BIN_DIR="${NUTSHELL_INSTALL_BIN:-}"
if [ -z "$BIN_DIR" ]; then
  BIN_DIR=$(dirname "$(command -v nutshell 2>/dev/null || printf '%s/.local/bin/nutshell' "$HOME")")
fi
APP_DIR="${NUTSHELL_INSTALL_APP_DIR:-$HOME/Applications}"

rm -f "$BIN_DIR/nutshell"
rm -rf "$APP_DIR/Nutshell.app"

echo "Removed Nutshell command."
echo "Removed Nutshell.app from $APP_DIR if it was installed there."
echo "Kept config and data:"
echo "  $HOME/nutconfig.jsonc"
echo "  $HOME/Nutshell"
