#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/tart-browser-auth-snapshot.sh <vm-name> [snapshot-name]

Captures the running Tart VM's Google Chrome auth profile into the host share:
  ~/Documents/NutshellRehearsalShare/auth-profiles/<snapshot-name>

The VM must be running with:
  --dir=share:$HOME/Documents/NutshellRehearsalShare

This stores private browser cookies and the VM login keychain. Keep it outside git.
Restored auth is for downstream debug only; it cannot satisfy clean release-pass proof.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit $([[ $# -lt 1 || $# -gt 2 ]] && echo 2 || echo 0)
fi

vm_name="$1"
snapshot_name="${2:-chrome-google-x-$(date -u +%Y%m%dT%H%M%SZ)}"
guest_share="/Volumes/My Shared Files/share"
guest_snapshot="${guest_share}/auth-profiles/${snapshot_name}"
guest_snapshot_q="$(printf '%q' "$guest_snapshot")"

if ! command -v tart >/dev/null 2>&1; then
  echo "tart is required" >&2
  exit 127
fi

tart exec "$vm_name" /bin/zsh -lc "$(cat <<SCRIPT
set -euo pipefail

guest_snapshot=${guest_snapshot_q}
mkdir -p "\$guest_snapshot"

/usr/bin/osascript -e 'tell application "Google Chrome" to quit' >/dev/null 2>&1 || true
sleep 4
pkill -x "Google Chrome" >/dev/null 2>&1 || true

profile_root="\$HOME/Library/Application Support/Google"
keychain="\$HOME/Library/Keychains/login.keychain-db"

if [[ ! -d "\$profile_root/Chrome" ]]; then
  echo "Chrome profile not found at \$profile_root/Chrome" >&2
  exit 1
fi

if [[ ! -f "\$keychain" ]]; then
  echo "login keychain not found at \$keychain" >&2
  exit 1
fi

tar \\
  --exclude="Chrome/Crashpad" \\
  --exclude="Chrome/Default/Cache" \\
  --exclude="Chrome/Default/Code Cache" \\
  --exclude="Chrome/Default/GPUCache" \\
  --exclude="Chrome/Default/GrShaderCache" \\
  --exclude="Chrome/Default/ShaderCache" \\
  --exclude="Chrome/Default/Service Worker/CacheStorage" \\
  --exclude="Chrome/Default/Service Worker/ScriptCache" \\
  -C "\$profile_root" -czf "\$guest_snapshot/chrome-profile.tgz" Chrome

cp "\$keychain" "\$guest_snapshot/login.keychain-db"
security find-generic-password -a Chrome -s "Chrome Safe Storage" "\$keychain" > "\$guest_snapshot/chrome-safe-storage-metadata.txt" 2>&1 || true

created_at=\$(date -u +%Y-%m-%dT%H:%M:%SZ)
guest_user=\$(whoami)
cat > "\$guest_snapshot/manifest.json" <<EOF
{
  "kind": "nutshell-vm-browser-auth-profile",
  "createdAt": "\$created_at",
  "sourceVm": "${vm_name}",
  "guestUser": "\$guest_user",
  "browser": "Google Chrome",
  "profileArchive": "chrome-profile.tgz",
  "keychainFile": "login.keychain-db",
  "accounts": ["Google My Activity", "X"],
  "intendedUse": "private debug restore only; not clean release-pass evidence"
}
EOF

ls -lh "\$guest_snapshot"
SCRIPT
)"

echo
echo "Captured private auth profile:"
echo "  ~/Documents/NutshellRehearsalShare/auth-profiles/${snapshot_name}"
