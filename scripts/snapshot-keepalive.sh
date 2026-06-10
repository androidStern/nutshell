#!/usr/bin/env bash
set -euo pipefail

# scripts/snapshot-keepalive.sh
#
# Session keep-alive for the auth-present Tart snapshot (goal criterion 24).
# Clones the snapshot, boots it headless, opens Chrome on
# https://myactivity.google.com and https://x.com so the Google/X sessions
# refresh themselves like a living browser, quits Chrome cleanly so cookies
# flush to disk, verifies the cookie fixture is still healthy (cookies present
# AND decryptable through the keychain), and on verified success promotes the
# refreshed clone as <snapshot>-keepalive-<YYYYMMDD>.
#
# The original snapshot is NEVER renamed or deleted.
#
# Guest requirements (same harness pattern as the signed-in gate; see
# docs/vm-rehearsal-operations-playbook.md and docs/rehearsal-browser-auth-seeds.md):
#   - Tart guest agent in the snapshot so `tart exec` works (cirruslabs macOS
#     base images ship it).
#   - bun installed in the guest (`brew install bun`, a documented harness
#     prerequisite of the snapshot lineage).
#   - This repo mounted into the guest via `--dir=repo:<repo-root>` (this
#     script passes the mount). The cookie probe imports
#     `src/browser/cookies.ts` (sweet-cookie + macOS keychain) from the share,
#     the same probe path the rehearsal baseline proof uses, so a pass proves
#     cookies are present and decryptable, not merely that files exist.
#   - `bun install` must have been run on the host repo so `node_modules/`
#     exists in the share.
#
# Exit codes:
#   0   session refreshed, fixture verified, promoted (unless --no-promote)
#   2   usage error
#   70  HARNESS FAIL (tart missing, clone/boot/exec failure, guest missing bun/share)
#   75  FIXTURE STALE (cookies missing or not decryptable; manual re-login required)

DEFAULT_SNAPSHOT="nutshell-authpresent-sequoia-google-x-20260610"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<USAGE
Usage:
  scripts/snapshot-keepalive.sh [snapshot-name] [options]

Options:
  --snapshot <name>   Auth-present snapshot to refresh
                      (default: ${DEFAULT_SNAPSHOT})
  --workdir <dir>     Host directory for logs
                      (default: \$HOME/Documents/NutshellRehearsalShare/keepalive)
  --repo <dir>        Repo root mounted into the guest as repo:
                      (default: ${DEFAULT_REPO_DIR})
  --promote           Promote the verified clone to <snapshot>-keepalive-<YYYYMMDD>
                      (default: on)
  --no-promote        Verify and refresh only; delete the clone afterwards
  --dry-run           Print the plan without running any tart command
  -h, --help          Show this help

Exit codes: 0 ok, 2 usage, 70 HARNESS FAIL, 75 FIXTURE STALE.
USAGE
}

SNAPSHOT="${DEFAULT_SNAPSHOT}"
WORKDIR="${HOME}/Documents/NutshellRehearsalShare/keepalive"
REPO_DIR="${DEFAULT_REPO_DIR}"
PROMOTE=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --snapshot)
      [[ $# -ge 2 ]] || { echo "--snapshot requires a value" >&2; exit 2; }
      SNAPSHOT="$2"
      shift 2
      ;;
    --workdir)
      [[ $# -ge 2 ]] || { echo "--workdir requires a value" >&2; exit 2; }
      WORKDIR="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || { echo "--repo requires a value" >&2; exit 2; }
      REPO_DIR="$2"
      shift 2
      ;;
    --promote)
      PROMOTE=1
      shift
      ;;
    --no-promote)
      PROMOTE=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --*)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      SNAPSHOT="$1"
      shift
      ;;
  esac
done

TMP_VM="${SNAPSHOT}-keepalive-tmp"
DATE_TAG="$(date +%Y%m%d)"
PROMOTED_NAME="${SNAPSHOT}-keepalive-${DATE_TAG}"
RUN_LOG="${WORKDIR}/tart-run-${SNAPSHOT}-${DATE_TAG}-$$.log"

step() { printf '[keepalive] %s\n' "$*"; }

harness_fail() {
  printf 'HARNESS FAIL: %s\n' "$*" >&2
  exit 70
}

vm_exists() {
  tart list --quiet --source local 2>/dev/null | grep -Fxq "$1"
}

PROMOTED=0
VM_CREATED=0
VM_STARTED=0
VM_STOPPED=0
TART_RUN_PID=""

# shellcheck disable=SC2329  # invoked indirectly via the EXIT trap
cleanup() {
  local code=$?
  trap - EXIT
  if [[ "${PROMOTED}" -eq 0 && "${VM_CREATED}" -eq 1 ]]; then
    if [[ "${VM_STARTED}" -eq 1 && "${VM_STOPPED}" -eq 0 ]]; then
      step "cleanup: stopping ${TMP_VM}"
      tart stop --timeout 30 "${TMP_VM}" >/dev/null 2>&1 || true
    fi
    if vm_exists "${TMP_VM}"; then
      step "cleanup: deleting tmp clone ${TMP_VM}"
      tart delete "${TMP_VM}" >/dev/null 2>&1 || true
    fi
  fi
  if [[ -n "${TART_RUN_PID}" ]] && kill -0 "${TART_RUN_PID}" 2>/dev/null; then
    wait "${TART_RUN_PID}" 2>/dev/null || true
  fi
  exit "${code}"
}
trap cleanup EXIT

fixture_stale() {
  cat >&2 <<STALE
======================================================================
FIXTURE STALE: ${SNAPSHOT} no longer holds healthy Google/X cookies
======================================================================
The keepalive clone is being stopped and deleted. The base snapshot was
NOT modified. Per docs/release-validation-gates.md, the signed-in and
live-sync gates must record verdict fixture_stale and stay queued until
the fixture is repaired; this does not fail the release candidate.

Manual re-login (see docs/rehearsal-browser-auth-seeds.md):
  1. tart clone ${SNAPSHOT} ${SNAPSHOT}-relogin
  2. tart run --dir=repo:${REPO_DIR} ${SNAPSHOT}-relogin     # with graphics
  3. In VM Chrome, Andrew signs into https://myactivity.google.com and
     https://x.com (never the agent; never new accounts).
  4. Approve the Chrome Safe Storage keychain prompt with the guest
     password ("admin" on the Tart base) and click "Always Allow".
  5. Quit Chrome, shut the VM down cleanly, then verify:
       scripts/snapshot-keepalive.sh --snapshot ${SNAPSHOT}-relogin --no-promote
  6. On a verified pass: tart rename ${SNAPSHOT}-relogin to a new dated
     auth-present snapshot name and update docs/release-validation-gates.md
     and docs/rehearsal-browser-auth-seeds.md to point at it.
STALE
  exit 75
}

# Guest scripts. Quoted heredocs: nothing here expands on the host.

read -r -d '' GUEST_PREFLIGHT <<'EOS' || true
set -euo pipefail
if ! command -v bun >/dev/null 2>&1; then
  echo "GUEST_MISSING: bun (brew install bun in the snapshot lineage per the playbook)" >&2
  exit 1
fi
if [[ ! -d "/Applications/Google Chrome.app" ]]; then
  echo "GUEST_MISSING: Google Chrome.app" >&2
  exit 1
fi
if [[ ! -f "/Volumes/My Shared Files/repo/src/browser/cookies.ts" ]]; then
  echo "GUEST_MISSING: repo share at /Volumes/My Shared Files/repo (pass --repo with the nutshell repo root)" >&2
  exit 1
fi
if [[ ! -d "/Volumes/My Shared Files/repo/node_modules/@steipete/sweet-cookie" ]]; then
  echo "GUEST_MISSING: node_modules in the repo share (run bun install on the host repo first)" >&2
  exit 1
fi
echo "guest-preflight-ok"
EOS

read -r -d '' GUEST_OPEN_CHROME <<'EOS' || true
set -euo pipefail
open -a "Google Chrome" "https://myactivity.google.com"
sleep 3
open -a "Google Chrome" "https://x.com"
echo "chrome-opened"
EOS

read -r -d '' GUEST_QUIT_CHROME <<'EOS' || true
set -euo pipefail
/usr/bin/osascript -e 'quit app "Google Chrome"'
for _ in {1..30}; do
  if ! pgrep -x "Google Chrome" >/dev/null; then
    echo "chrome-quit-clean"
    exit 0
  fi
  sleep 1
done
echo "chrome did not exit within 30s of quit; forcing pkill (cookie flush may be incomplete)" >&2
pkill -x "Google Chrome" || true
sleep 3
echo "chrome-quit-forced"
EOS

read -r -d '' GUEST_COOKIE_PROBE <<'EOS' || true
set -euo pipefail
probe_file="/tmp/nutshell-keepalive-cookie-probe-$$.ts"
cat > "$probe_file" <<'TS'
// Keepalive fixture-health probe. Runs inside the guest via bun, importing the
// repo's real cookie path (sweet-cookie + macOS keychain) from the repo share.
// Prints exactly one verdict sentinel; the host script keys off it.
const repo = "/Volumes/My Shared Files/repo";
const { readBrowserCookies } = await import(`${repo}/src/browser/cookies.ts`);

const checks: Array<{
  label: string;
  request: { url: string; origins: string[]; names: string[]; timeoutMs: number };
  required: (names: string[]) => boolean;
}> = [
  {
    label: "google",
    request: {
      url: "https://myactivity.google.com/",
      origins: ["https://myactivity.google.com", "https://accounts.google.com"],
      names: ["SAPISID", "__Secure-1PSID"],
      timeoutMs: 30_000,
    },
    required: (names) => names.includes("SAPISID") || names.includes("__Secure-1PSID"),
  },
  {
    label: "x",
    request: {
      url: "https://x.com/",
      origins: ["https://x.com", "https://twitter.com"],
      names: ["auth_token"],
      timeoutMs: 30_000,
    },
    required: (names) => names.includes("auth_token"),
  },
];

let healthy = true;
for (const check of checks) {
  try {
    const result = await readBrowserCookies(check.request);
    const names = result.cookies
      .filter((cookie: { value: string }) => cookie.value.length > 0)
      .map((cookie: { name: string }) => cookie.name);
    for (const warning of result.warnings) console.error(`${check.label} warning: ${warning}`);
    console.log(`${check.label} cookies: ${names.join(", ") || "none"}`);
    if (!check.required(names)) {
      console.error(`${check.label}: required auth cookies missing`);
      healthy = false;
    }
  } catch (error) {
    console.error(`${check.label} cookie read failed (present-but-undecryptable counts as stale): ${error}`);
    healthy = false;
  }
}

console.log(healthy ? "KEEPALIVE_COOKIES_HEALTHY" : "KEEPALIVE_COOKIES_STALE");
TS
bun "$probe_file"
rm -f "$probe_file"
EOS

if [[ "${DRY_RUN}" -eq 1 ]]; then
  step "DRY RUN — no tart commands will be executed"
  step "base snapshot:   ${SNAPSHOT}"
  step "tmp clone:       ${TMP_VM}"
  step "repo mount:      --dir=repo:${REPO_DIR}"
  step "run log:         ${RUN_LOG}"
  if [[ "${PROMOTE}" -eq 1 ]]; then
    step "promote:         on -> ${PROMOTED_NAME} (previous ${SNAPSHOT}-keepalive-<YYYYMMDD> promotions deleted first)"
  else
    step "promote:         off (verify only; tmp clone deleted afterwards)"
  fi
  step "flow:            clone -> run --no-graphics -> wait ip/exec/gui -> guest preflight"
  step "                 -> open Chrome (myactivity.google.com, x.com) -> 45s refresh"
  step "                 -> quit Chrome cleanly -> in-VM sweet-cookie probe -> promote or delete"
  exit 0
fi

command -v tart >/dev/null 2>&1 || harness_fail "tart is required (expected at /opt/homebrew/bin/tart)"
[[ -d "${REPO_DIR}/src/browser" ]] || harness_fail "--repo ${REPO_DIR} does not look like the nutshell repo root"
vm_exists "${SNAPSHOT}" || harness_fail "snapshot ${SNAPSHOT} not found in 'tart list'"

mkdir -p "${WORKDIR}"

if vm_exists "${TMP_VM}"; then
  step "deleting leftover tmp clone ${TMP_VM} from a previous run"
  tart stop --timeout 5 "${TMP_VM}" >/dev/null 2>&1 || true
  tart delete "${TMP_VM}"
fi

step "cloning ${SNAPSHOT} -> ${TMP_VM} (APFS copy-on-write)"
tart clone "${SNAPSHOT}" "${TMP_VM}"
VM_CREATED=1

step "booting ${TMP_VM} headless (log: ${RUN_LOG})"
tart run --no-graphics --dir="repo:${REPO_DIR}" "${TMP_VM}" >"${RUN_LOG}" 2>&1 &
TART_RUN_PID=$!
VM_STARTED=1

step "waiting for ${TMP_VM} to obtain an IP (up to 180s)"
if ! tart ip "${TMP_VM}" --wait 180 >/dev/null 2>&1; then
  harness_fail "VM did not obtain an IP within 180s; see ${RUN_LOG}"
fi

step "waiting for guest agent exec readiness (up to 120s)"
exec_ready=0
for _ in {1..24}; do
  if tart exec "${TMP_VM}" /bin/zsh -lc 'echo guest-exec-ready' >/dev/null 2>&1; then
    exec_ready=1
    break
  fi
  sleep 5
done
[[ "${exec_ready}" -eq 1 ]] || harness_fail "tart exec did not become ready within 120s; see ${RUN_LOG}"

step "waiting for the guest GUI session (Finder) (up to 120s)"
gui_ready=0
for _ in {1..24}; do
  if tart exec "${TMP_VM}" /bin/zsh -lc 'pgrep -x Finder >/dev/null' >/dev/null 2>&1; then
    gui_ready=1
    break
  fi
  sleep 5
done
[[ "${gui_ready}" -eq 1 ]] || harness_fail "guest GUI session did not appear within 120s; 'open -a' needs a logged-in desktop"

step "running guest preflight (bun, Chrome, repo share, node_modules)"
if ! tart exec "${TMP_VM}" /bin/zsh -lc "${GUEST_PREFLIGHT}"; then
  harness_fail "guest preflight failed; see GUEST_MISSING line above"
fi

step "opening Chrome on https://myactivity.google.com and https://x.com"
if ! tart exec "${TMP_VM}" /bin/zsh -lc "${GUEST_OPEN_CHROME}"; then
  harness_fail "could not open Chrome in the guest"
fi

step "letting Chrome refresh both sessions for 45s"
sleep 45

step "quitting Chrome cleanly so cookies flush to disk"
if ! tart exec "${TMP_VM}" /bin/zsh -lc "${GUEST_QUIT_CHROME}"; then
  harness_fail "could not quit Chrome in the guest"
fi
sleep 5

step "verifying cookie fixture health inside the VM (sweet-cookie + keychain)"
probe_output=""
if ! probe_output="$(tart exec "${TMP_VM}" /bin/zsh -lc "${GUEST_COOKIE_PROBE}" 2>&1)"; then
  printf '%s\n' "${probe_output}"
  harness_fail "cookie probe could not run in the guest (bun/import failure, not a fixture verdict)"
fi
printf '%s\n' "${probe_output}"

if grep -q "KEEPALIVE_COOKIES_STALE" <<<"${probe_output}"; then
  fixture_stale
elif ! grep -q "KEEPALIVE_COOKIES_HEALTHY" <<<"${probe_output}"; then
  harness_fail "cookie probe produced no verdict sentinel"
fi
step "cookie fixture verified healthy (Google SAPISID/__Secure-1PSID and X auth_token decryptable)"

step "stopping ${TMP_VM}"
tart stop --timeout 60 "${TMP_VM}"
VM_STOPPED=1
wait "${TART_RUN_PID}" 2>/dev/null || true
TART_RUN_PID=""

if [[ "${PROMOTE}" -eq 0 ]]; then
  step "--no-promote: deleting verified tmp clone ${TMP_VM}"
  tart delete "${TMP_VM}"
  step "OK: ${SNAPSHOT} session refreshed and verified (no promotion requested)"
  exit 0
fi

step "deleting previous keepalive promotions of ${SNAPSHOT} (the base snapshot is never touched)"
while IFS= read -r old_vm; do
  [[ -n "${old_vm}" ]] || continue
  [[ "${old_vm}" == "${SNAPSHOT}" ]] && continue
  step "deleting previous promotion ${old_vm}"
  tart delete "${old_vm}"
done < <(tart list --quiet --source local | grep -E "^${SNAPSHOT}-keepalive-[0-9]{8}$" || true)

step "promoting ${TMP_VM} -> ${PROMOTED_NAME}"
tart rename "${TMP_VM}" "${PROMOTED_NAME}"
PROMOTED=1

step "OK: promoted refreshed auth-present snapshot"
echo "PROMOTED: ${PROMOTED_NAME}"
exit 0
