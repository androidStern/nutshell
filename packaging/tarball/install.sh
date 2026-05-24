#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_BIN="$ROOT_DIR/bin/nutshell"
BIN_DIR="${NUTSHELL_INSTALL_BIN:-}"

if [ ! -x "$SOURCE_BIN" ]; then
  echo "Nutshell installer could not find an executable at $SOURCE_BIN" >&2
  exit 1
fi

if [ -z "$BIN_DIR" ]; then
  OLD_IFS=$IFS
  IFS=:
  for dir in $PATH; do
    if [ -n "$dir" ] && [ -d "$dir" ] && [ -w "$dir" ]; then
      case "$dir" in
        /bin|/usr/bin|/sbin|/usr/sbin) ;;
        *) BIN_DIR=$dir; break ;;
      esac
    fi
  done
  IFS=$OLD_IFS
fi

if [ -z "$BIN_DIR" ]; then
  BIN_DIR="$HOME/.local/bin"
fi

mkdir -p "$BIN_DIR"
cp "$SOURCE_BIN" "$BIN_DIR/nutshell"
chmod 0755 "$BIN_DIR/nutshell"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "Installed Nutshell to $BIN_DIR, but that directory is not in PATH." >&2
    echo "Add this to your shell profile, then open a new terminal:" >&2
    echo "  export PATH=\"$BIN_DIR:\$PATH\"" >&2
    exit 1
    ;;
esac

"$BIN_DIR/nutshell" init >/dev/null
"$BIN_DIR/nutshell" launchd install >/dev/null

echo "Installed Nutshell at $BIN_DIR/nutshell"
echo "Config: $HOME/nutconfig.jsonc"
echo "Data: $HOME/Nutshell"
