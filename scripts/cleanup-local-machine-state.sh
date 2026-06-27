#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/cleanup-local-machine-state.sh [options]

Conservative host cleanup for preparing this Mac for a true Nutshell install test.
Dry-run is the default; pass --execute to make changes.

Options:
  --execute                    Apply file/package/launchd cleanup. Default is dry-run.
  --include-data               Also remove ~/nutconfig.jsonc and ~/Nutshell.
  --include-backups            Also remove old local Nutshell backup/rehearsal folders.
  --include-repo-dist          Also remove this repo's dist/ build outputs.
  --reset-bundle-permissions   Run bundle-scoped tccutil resets for com.winterfell.* only.
  --help                       Show this help.

Deliberately not performed:
  - No `tccutil reset AppleEvents` because it resets Automation for every app.
  - No `sfltool resetbtm` because it resets Background Items metadata globally.
  - No direct SQL writes to TCC databases.
  - No browser profile, Keychain, Chrome Safe Storage, Google/X login, or provider data cleanup.

The script reports remaining TCC, launchd override, Background Task Management,
LaunchServices, and filesystem references at the end so stale macOS metadata is visible.
EOF
}

NUTSHELL_PATTERN='nutshell|NutshellAgent|NutshellProbe|com\.winterfell\.nutshell|com\.winterfell\.NutshellProbe|homebrew\.mxcl\.nutshell'

EXECUTE=0
INCLUDE_DATA=0
INCLUDE_BACKUPS=0
INCLUDE_REPO_DIST=0
RESET_BUNDLE_PERMISSIONS=0

for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    --include-data) INCLUDE_DATA=1 ;;
    --include-backups) INCLUDE_BACKUPS=1 ;;
    --include-repo-dist) INCLUDE_REPO_DIST=1 ;;
    --reset-bundle-permissions) RESET_BUNDLE_PERMISSIONS=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_ID="$(id -u)"
HOME_DIR="${HOME:?HOME is required}"

say() {
  printf '%s\n' "$*"
}

run() {
  if [ "$EXECUTE" -eq 1 ]; then
    say "+ $*"
    "$@"
  else
    say "DRY-RUN: $*"
  fi
}

run_sh() {
  if [ "$EXECUTE" -eq 1 ]; then
    say "+ sh -c $*"
    sh -c "$*"
  else
    say "DRY-RUN: sh -c $*"
  fi
}

remove_path() {
  local path="$1"
  [ -e "$path" ] || return 0
  case "$path" in
    /Applications/*|/Library/*)
      run sudo rm -rf "$path"
      ;;
    *)
      run rm -rf "$path"
      ;;
  esac
}

remove_file() {
  local path="$1"
  [ -e "$path" ] || return 0
  case "$path" in
    /Applications/*|/Library/*)
      run sudo rm -f "$path"
      ;;
    *)
      run rm -f "$path"
      ;;
  esac
}

section() {
  printf '\n== %s ==\n' "$1"
}

section "Mode"
if [ "$EXECUTE" -eq 1 ]; then
  say "Applying cleanup changes."
else
  say "Dry-run only. Pass --execute to make changes."
fi

section "Stop active app-owned helper"
APP_EXEC="$HOME_DIR/Applications/Nutshell.app/Contents/MacOS/Nutshell"
if [ -x "$APP_EXEC" ]; then
  run "$APP_EXEC" disable-sync || true
  run "$APP_EXEC" unregister-agent || true
fi
run launchctl bootout "gui/$USER_ID/com.winterfell.nutshell.agent" 2>/dev/null || true
run launchctl remove com.winterfell.nutshell.agent 2>/dev/null || true

section "Uninstall package paths"
if command -v brew >/dev/null 2>&1; then
  run brew uninstall --force androidstern/nutshell/nutshell || true
  run brew uninstall --force nutshell || true
  run brew cleanup --prune=all nutshell || true
else
  say "brew not found; skipping Homebrew uninstall."
fi

section "Remove app bundles"
remove_path "$HOME_DIR/Applications/Nutshell.app"
for path in "$HOME_DIR"/Applications/Nutshell.app.stale-*; do
  [ -e "$path" ] && remove_path "$path"
done
remove_path /Applications/Nutshell.app

section "Remove launch plists"
for path in \
  "$HOME_DIR"/Library/LaunchAgents/com.winterfell.nutshell*.plist \
  "$HOME_DIR"/Library/LaunchAgents/homebrew.mxcl.nutshell.plist \
  /Library/LaunchAgents/com.winterfell.nutshell*.plist \
  /Library/LaunchDaemons/com.winterfell.nutshell*.plist; do
  [ -e "$path" ] && remove_file "$path"
done

section "Remove package caches and logs"
for path in \
  "$HOME_DIR"/Library/Caches/Homebrew/nutshell--*.tar.gz \
  "$HOME_DIR"/Library/Caches/Homebrew/downloads/*nutshell* \
  "$HOME_DIR"/Library/Logs/Homebrew/nutshell \
  "$HOME_DIR"/Library/Logs/NutshellProbe.out.log \
  "$HOME_DIR"/Library/Logs/NutshellProbe.err.log \
  "$HOME_DIR"/Library/Logs/NutshellProbeClean.out.log \
  "$HOME_DIR"/Library/Logs/NutshellProbeClean.err.log; do
  [ -e "$path" ] && remove_path "$path"
done

if [ "$INCLUDE_DATA" -eq 1 ]; then
  section "Remove Nutshell user data"
  remove_file "$HOME_DIR/nutconfig.jsonc"
  remove_path "$HOME_DIR/Nutshell"
else
  section "Keep Nutshell user data"
  say "Skipping ~/nutconfig.jsonc and ~/Nutshell. Pass --include-data to remove them."
fi

if [ "$INCLUDE_BACKUPS" -eq 1 ]; then
  section "Remove old local backup/rehearsal folders"
  for path in \
    "$HOME_DIR"/Nutshell-*-backup-* \
    "$HOME_DIR"/nutshell-preinstall-backup-* \
    "$HOME_DIR"/Nutshell.preinstall-backup-* \
    "$HOME_DIR"/Documents/NutshellRehearsalShare; do
    [ -e "$path" ] && remove_path "$path"
  done
else
  section "Keep backup/rehearsal folders"
  say "Skipping local backups, rehearsal share, Tart VMs, and VirtualBuddy VMs."
fi

if [ "$INCLUDE_REPO_DIST" -eq 1 ]; then
  section "Remove repo build outputs"
  remove_path "$REPO_ROOT/dist"
else
  section "Keep repo build outputs"
  say "Skipping $REPO_ROOT/dist. Pass --include-repo-dist to remove local dev app registrations at the source."
fi

if [ "$RESET_BUNDLE_PERMISSIONS" -eq 1 ]; then
  section "Bundle-scoped TCC reset"
  for bundle in com.winterfell.nutshell com.winterfell.NutshellProbe com.winterfell.NutshellProbeClean; do
    run tccutil reset All "$bundle" || true
  done
else
  section "Keep permission databases unchanged"
  say 'Skipping TCC changes. This script never runs broad `tccutil reset AppleEvents`.'
fi

section "Rebuild LaunchServices user app index"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  run "$LSREGISTER" -r -domain user
else
  say "lsregister not found at expected path."
fi

section "Verification: install paths"
command -v nutshell || true
if command -v brew >/dev/null 2>&1; then
  brew list --versions nutshell androidstern/nutshell/nutshell 2>/dev/null || true
  brew services list 2>/dev/null | grep -Ei 'nutshell' || true
fi

section "Verification: apps and plists"
find "$HOME_DIR/Applications" /Applications -maxdepth 1 -iname 'Nutshell.app*' -print 2>/dev/null || true
find "$HOME_DIR/Library/LaunchAgents" /Library/LaunchAgents /Library/LaunchDaemons \
  -maxdepth 1 \( -iname '*nutshell*.plist' -o -iname '*Nutshell*.plist' \) -print 2>/dev/null || true

section "Verification: launchd and processes"
launchctl print "gui/$USER_ID/com.winterfell.nutshell.agent" 2>&1 | sed -n '1,20p' || true
launchctl print-disabled "gui/$USER_ID" 2>/dev/null | grep -Ei "$NUTSHELL_PATTERN" || true
ps -axco pid,comm 2>/dev/null | grep -Ei 'Nutshell|nutshell' || true
ps -axww -o pid=,command= 2>/dev/null | grep -E 'com\.winterfell\.nutshell|NutshellAgent|/Nutshell\.app/|/bin/nutshell( |$)' | grep -v 'grep -E' || true

section "Verification: permission metadata"
for db in "$HOME_DIR/Library/Application Support/com.apple.TCC/TCC.db" "/Library/Application Support/com.apple.TCC/TCC.db"; do
  if [ -r "$db" ]; then
    say "TCC DB: $db"
    sqlite3 "$db" \
      "select service, client, client_type, auth_value, indirect_object_identifier from access where lower(client) like '%nutshell%' or client in ('com.winterfell.nutshell','com.winterfell.NutshellProbe','com.winterfell.NutshellProbeClean') or lower(indirect_object_identifier) like '%nutshell%' order by service, client;" \
      2>/dev/null || true
  else
    say "TCC DB unreadable or missing: $db"
  fi
done

section "Verification: Background Task Management"
if command -v sfltool >/dev/null 2>&1; then
  sfltool dumpbtm 2>/dev/null | grep -Ei -C 3 "$NUTSHELL_PATTERN" || true
fi

section "Verification: LaunchServices registrations"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -dump 2>/dev/null | grep -Ei -C 2 "$NUTSHELL_PATTERN" | sed -n '1,160p' || true
fi

section "Done"
if [ "$EXECUTE" -eq 1 ]; then
  say "Cleanup actions completed. Review verification sections for macOS metadata that requires a broader reset or manual GUI cleanup."
else
  say "Dry-run completed. No changes were made."
fi
