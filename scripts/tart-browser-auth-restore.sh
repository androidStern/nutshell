#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/tart-browser-auth-restore.sh <vm-name> <snapshot-name>

Restores a private Chrome auth snapshot from:
  ~/Documents/NutshellRehearsalShare/auth-profiles/<snapshot-name>

The VM must be running with:
  --dir=share:$HOME/Documents/NutshellRehearsalShare

Set NUTSHELL_VM_PASSWORD if the Tart guest keychain password is not "admin".
After restore, reboot or stop/start the VM, unlock the desktop, then run authenticated checks.

Restored auth is for downstream debug only; it cannot satisfy clean release-pass proof.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -ne 2 ]]; then
  usage
  exit $([[ $# -ne 2 ]] && echo 2 || echo 0)
fi

vm_name="$1"
snapshot_name="$2"
host_snapshot="${HOME}/Documents/NutshellRehearsalShare/auth-profiles/${snapshot_name}"
guest_snapshot="/Volumes/My Shared Files/share/auth-profiles/${snapshot_name}"
guest_password="${NUTSHELL_VM_PASSWORD:-admin}"
guest_snapshot_q="$(printf '%q' "$guest_snapshot")"
guest_password_q="$(printf '%q' "$guest_password")"

if ! command -v tart >/dev/null 2>&1; then
  echo "tart is required" >&2
  exit 127
fi

for required in chrome-profile.tgz login.keychain-db chrome-safe-storage-password.txt manifest.json; do
  if [[ ! -f "${host_snapshot}/${required}" ]]; then
    echo "missing ${host_snapshot}/${required}" >&2
    exit 1
  fi
done

tart exec "$vm_name" /bin/zsh -lc "$(cat <<SCRIPT
set -euo pipefail

guest_snapshot=${guest_snapshot_q}
guest_password=${guest_password_q}
stamp=\$(date -u +%Y%m%dT%H%M%SZ)
profile_root="\$HOME/Library/Application Support/Google"
keychain_dir="\$HOME/Library/Keychains"
keychain="\$keychain_dir/login.keychain-db"
safe_storage_dir="\$HOME/Nutshell/.private"
safe_storage_password_file="\$safe_storage_dir/chrome-safe-storage-password"

/usr/bin/osascript -e 'tell application "Google Chrome" to quit' >/dev/null 2>&1 || true
sleep 4
pkill -x "Google Chrome" >/dev/null 2>&1 || true

mkdir -p "\$profile_root" "\$keychain_dir"
if [[ -d "\$profile_root/Chrome" ]]; then
  mv "\$profile_root/Chrome" "\$profile_root/Chrome.pre-auth-restore-\$stamp"
fi
if [[ -f "\$keychain" ]]; then
  cp "\$keychain" "\$keychain.pre-auth-restore-\$stamp"
fi

tar -C "\$profile_root" -xzf "\$guest_snapshot/chrome-profile.tgz"
cp "\$guest_snapshot/login.keychain-db" "\$keychain"
chmod 600 "\$keychain"
mkdir -p "\$safe_storage_dir"
cp "\$guest_snapshot/chrome-safe-storage-password.txt" "\$safe_storage_password_file"
chmod 600 "\$safe_storage_password_file"

security list-keychains -d user -s "\$keychain" /Library/Keychains/System.keychain
security default-keychain -s "\$keychain"
security login-keychain -s "\$keychain" || true
security unlock-keychain -p "\$guest_password" "\$keychain"
security set-keychain-settings -lut 21600 "\$keychain"
security set-generic-password-partition-list -a Chrome -s "Chrome Safe Storage" -S apple-tool:,apple: -k "\$guest_password" "\$keychain" >/tmp/nutshell-auth-restore-partition-list.txt 2>&1 || true
security find-generic-password -a Chrome -s "Chrome Safe Storage" "\$keychain" >/tmp/nutshell-auth-restore-safe-storage-metadata.txt 2>&1 || true

echo "restored Chrome profile and login keychain from \$guest_snapshot"
echo "installed private Chrome Safe Storage password at \$safe_storage_password_file"
echo "reboot or stop/start this VM before judging restored auth"
SCRIPT
)"

echo
echo "Restored private auth profile '${snapshot_name}' into ${vm_name}."
echo "Next: reboot or stop/start the VM, unlock the desktop, then run the authenticated verifier."
