#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_BIN="$ROOT_DIR/bin/nutshell"
BIN_DIR="${NUTSHELL_INSTALL_BIN:-$HOME/.local/bin}"
SOURCE_APP="$ROOT_DIR/Nutshell.app"
APP_DIR="${NUTSHELL_INSTALL_APP_DIR:-$HOME/Applications}"
APP_PATH="$APP_DIR/Nutshell.app"

if [ ! -x "$SOURCE_BIN" ]; then
  echo "Nutshell installer could not find an executable at $SOURCE_BIN" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
cp "$SOURCE_BIN" "$BIN_DIR/nutshell"
chmod 0755 "$BIN_DIR/nutshell"

if [ -d "$SOURCE_APP" ]; then
  mkdir -p "$APP_DIR"
  rm -rf "$APP_PATH"
  if command -v ditto >/dev/null 2>&1; then
    ditto --noextattr --noqtn "$SOURCE_APP" "$APP_PATH"
  else
    cp -R "$SOURCE_APP" "$APP_PATH"
  fi
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "Installed Nutshell to $BIN_DIR, but that directory is not in PATH." >&2
    echo "Add this to your shell profile, then open a new terminal:" >&2
    echo "  export PATH=\"$BIN_DIR:\$PATH\"" >&2
    ;;
esac

echo "Installed Nutshell at $BIN_DIR/nutshell"
if [ -d "$APP_PATH" ]; then
  echo "Installed Nutshell.app at $APP_PATH"
else
  echo "Nutshell.app was not included in this tarball; install the macOS app before enabling protected-data sync." >&2
fi
echo "Config: $HOME/nutconfig.jsonc"
echo "Data: $HOME/Nutshell"
echo "Next: run 'nutshell setup'"
