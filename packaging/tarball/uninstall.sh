#!/usr/bin/env sh
set -eu

BIN_DIR="${NUTSHELL_INSTALL_BIN:-}"
if [ -z "$BIN_DIR" ]; then
  BIN_DIR=$(dirname "$(command -v nutshell 2>/dev/null || printf '%s/.local/bin/nutshell' "$HOME")")
fi

if command -v nutshell >/dev/null 2>&1; then
  nutshell launchd uninstall >/dev/null 2>&1 || true
fi

rm -f "$BIN_DIR/nutshell"

echo "Removed Nutshell command and launchd job."
echo "Kept config and data:"
echo "  $HOME/nutconfig.jsonc"
echo "  $HOME/Nutshell"
