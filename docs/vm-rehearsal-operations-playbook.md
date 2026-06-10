# VM Rehearsal Operations Playbook

This file captures operational lessons from the strict Nutshell fresh-install rehearsal. Read it before operating the VirtualBuddy VM again.

## Current Known VM Facts

- VirtualBuddy VM names seen on the host:
  - `Nutshell Clean Baseline`
  - `Nutshell Rehearsal 0.1.12`
- Test user: `nutshelltest`
- Test user password and keychain password: `nutshelltest`
- Host input folder: `~/Documents/NutshellRehearsalShare`
- Public product under test for the next strict attempt: `v0.1.19`
- Do not trust a VM name that says "Clean Baseline". Verify clean state from inside the VM before claiming clean evidence.

## Hard Rules

1. Do not claim a clean rehearsal because the VM name says clean. A clean run starts only after `verify-clean` passes in the test environment.
2. Do not use Terminal, SSH, copied files, or host-side commands as product pass evidence. They can be diagnostic or harness plumbing only.
3. If the VM is dirty and no snapshot restore exists, use the documented fallback cleanup, then run `verify-clean`. If `verify-clean` fails, freeze the attempt.
4. If any product bug appears after a clean baseline, freeze the report, fix the product separately, publish a new artifact, and restart from clean.
5. Do not enter the user's Google, X, Apple, or other personal credentials. Stop and get the user's attention for those handoffs.

## Tart Gates

Use Tart when VirtualBuddy GUI control is unreliable.

- Clean base created on 2026-06-09: `nutshell-strict-sequoia-base-20260609`, cloned from `ghcr.io/cirruslabs/macos-sequoia-base:latest`.
- Tart default guest account for this base is `admin` / `admin`. The keychain password is also `admin`.
- Shared folders mount at `/Volumes/My Shared Files`. With `--dir="repo:/path/to/repo" --dir="share:$HOME/Documents/NutshellRehearsalShare"`, the guest sees `/Volumes/My Shared Files/repo` and `/Volumes/My Shared Files/share`.
- Install harness prerequisites in each clean attempt clone before product checks: `brew install bun` and `brew install --cask google-chrome`.
- Use `tart exec -i -t ...` with a real host PTY for interactive setup. In Codex, set `tty: true` on the host `exec_command`. Non-PTY `tart exec` can let `nutshell setup` return without a real Full Disk Access handoff.
- Do not reuse an attempt VM after a failed product or harness phase. Freeze its report, stop it, and clone a new attempt from the clean Tart base.
- Chrome may request the VM login keychain for `Chrome Safe Storage`; enter `admin` and choose `Always Allow`. If this is not granted, authenticated browser checks can fail with keychain/Safe Storage warnings instead of proving source auth.
- Do not make the user repeat Google/X login for every clean VM. After the run proves signed-out behavior, use `docs/rehearsal-browser-auth-seeds.md` and the Tart auth seed scripts to restore the private Chrome profile plus login keychain, then record `browser-auth-seed-restore` before authenticated checks.
- If `nutshell doctor`, `nutshell health`, or `nutshell sync` reads protected/browser state from a Tart exec or terminal-owned process instead of `Nutshell.app`, freeze the attempt. The public CLI is expected to hand these protected commands to the installed app wrapper on macOS.
- macOS launchctl may report the app-owned agent through ServiceManagement as `program identifier = Contents/Library/LaunchServices/NutshellAgent` plus `parent bundle identifier = com.winterfell.nutshell`, not as a full `Nutshell.app/...` path. That is valid app-owned evidence; raw CLI/Bun/Homebrew Cellar targets are not.

## Tart UI Control Lessons

- Host `cliclick` is the reliable fallback for Tart UI when Computer Use or guest AppleScript cannot bind to the guest session.
- `screencapture` images are Retina pixels, while `cliclick` uses screen points. Divide screenshot coordinates by 2 before clicking.
- Before clicking a permission dialog, activate Tart and capture the screen: `osascript -e 'tell application "Tart" to activate'` then `screencapture -x /tmp/nutshell-tart-screen.png`.
- Use ImageMagick crops or pixel inspection to identify the actual button/control, then click once. Do not keep guessing coordinates.
- The Tart guest-agent/System Events prompt is a VM-control permission, not Nutshell product evidence. The user has approved it for rehearsal operations, but guest AppleScript can still fail with assistive-access errors. If that happens, dismiss the prompt and use host `cliclick` plus screenshots.
- For the Full Disk Access file picker, the path-entry sequence has worked: focus Tart, press `cmd+shift+g`, type `/Users/admin/Applications/Nutshell.app`, press return, select `Nutshell`, and click Open.

## VirtualBuddy Gates

- VirtualBuddy may prompt for host Documents access before opening a VM bundle. That is a VM-manager permission, not a Nutshell product permission. Ask the user to allow it unless they have already explicitly allowed it.
- The VM may boot to a macOS login screen. Use `nutshelltest` for the test user password.
- A VM can be logged in and still not expose SSH. Do not assume SSH exists.
- `systemsetup -setremotelogin on` from the VM Terminal can fail with:

```text
setremotelogin: Turning Remote Login on or off requires Full Disk Access privileges.
```

That means Terminal in the VM lacks Full Disk Access. Granting Terminal Full Disk Access is harness plumbing only and must be recorded as diagnostic, not product evidence.

## Text Entry Lessons

Computer Use click actions and host AppleScript typing are not reliable enough for complex shell commands in this VM.

Observed failures:

- Host clipboard paste into the VM Terminal typed only `v` instead of pasting the clipboard.
- Direct `osascript` typing works for simple lowercase text such as `echo vm terminal focus`.
- Special characters are unsafe through direct typing. A command containing `http://192.168.64.1:8765/package.json` was mangled into separate shell tokens, causing `curl` and `zsh` errors.
- Shift-modified characters are unsafe. A host keycode attempt for `:` produced `;` in the guest.
- The VM can slip into a state where VirtualBuddy is frontmost and the guest desktop is visible, but guest dock clicks and guest Finder keyboard shortcuts do not open apps. Do not continue guessing coordinates in that state.
- Host dock clicks can accidentally act on the host instead of the VM if VirtualBuddy focus is lost. Always confirm the host menu bar says `VirtualBuddy` immediately before interpreting a click as a guest action.

Operational rule: do not type complex commands into the VM Terminal unless the exact text path has been tested in that session. Prefer a reliable transport first: working SSH, a verified shared folder, or a verified browser/download path.

## Shared Folder Lessons

The VM config may show a shared folder for `~/Documents/NutshellRehearsalShare`, but the guest can still show only:

```text
/Volumes/Guest/VirtualBuddyGuest.app
```

`/Volumes/Guest` is the VirtualBuddy guest tools image, not proof that the host rehearsal share is mounted. Before relying on a shared folder, run `ls /Volumes` and `ls /Volumes/<expected-share>` inside the VM and capture evidence.

If the host share is not mounted:

1. Do not assume the config is enough.
2. Try launching `/Volumes/Guest/VirtualBuddyGuest.app` only after Terminal focus is confirmed.
3. Recheck `/Volumes`.
4. If the share still does not appear, use another transport and record the shared-folder failure.

## Clean Baseline Procedure

Use this sequence before running product checks:

1. Host preflight must pass with official X archive, official Google/YouTube export, and SQLite-safe Podcasts seed.
2. Open or restore the VM. For Tart, clone a new attempt from `nutshell-strict-sequoia-base-20260609`.
3. Log in as the VM test user (`nutshelltest` for VirtualBuddy, `admin` for the current Tart base).
4. Inspect for dirty state before running anything:
   - visible Nutshell setup window
   - existing `Nutshell.app`
   - existing `~/Nutshell`
   - existing `~/nutconfig.jsonc`
   - existing `com.winterfell.nutshell.agent`
   - browser auth state
5. If any dirty state exists, do not continue as a clean run. Find a real snapshot restore or run fallback cleanup.
6. Run `bun run rehearse:verify-clean -- --reset-privacy --report <new-report>`.
7. Only a passing `verify-clean` allows install and auth phases to proceed.

## Harness Lessons

- Local release checks can dirty the test user's home by creating `~/nutconfig.jsonc` and `~/Nutshell`. Run them with an isolated temporary `HOME`, but do not set `NUTSHELL_CONFIG` or `NUTSHELL_ROOT`; unit tests assert default config behavior.
- In setup, skip provider imports. The strict rehearsal proves official X and Google/YouTube imports in the dedicated import phase.
- If setup fails only because the harness rejects valid ServiceManagement launchctl evidence, freeze that attempt as a harness failure, patch the harness, and restart from a clean clone.
- Attempt `nutshell-strict-attempt-v0.1.14-20260609e` failed after user-completed Google/X login because Chrome Safe Storage keychain reads timed out from the product browser-auth path. Preserve `~/Documents/NutshellRehearsalShare/reports/fresh-install-report-strict-v0.1.14-tart-run-20260609e.failed-frozen.json` as a failed `0.1.14` rehearsal. The fix is not to patch that VM; publish a new artifact and start a new clean clone.
- Attempt `nutshell-strict-attempt-v0.1.15-20260609a` failed at `published-install`: Homebrew installed formula `0.1.15`, but the installed command printed `nutshell 0.1.14` because `PRODUCT_VERSION` was still hardcoded. Preserve `~/Documents/NutshellRehearsalShare/reports/fresh-install-report-strict-v0.1.15-tart-run-20260609a.failed-frozen.json` as a failed published-artifact attempt. Release certification now checks source, compiled, and package-installed CLI versions against `package.json`.
- Attempt `nutshell-strict-attempt-v0.1.16-20260609a` failed at `authenticated-browser-state`: Google and X were visibly signed in, but both browser cookie probes and doctors timed out reading Chrome Safe Storage through the macOS keychain. Preserve `~/Documents/NutshellRehearsalShare/reports/fresh-install-report-strict-v0.1.16-tart-run-20260609a.failed-frozen.json` as a failed published-artifact attempt. Private auth seed captured at `~/Documents/NutshellRehearsalShare/auth-profiles/chrome-google-x-20260610-0039`.
- Attempt `nutshell-strict-attempt-v0.1.17-20260610a` failed at `setup-flow`: clean baseline, public Homebrew install, installed version/app visibility, pre-permission state, and signed-out YouTube/X behavior passed, but the CLI setup's Full Disk Access handoff timed out before the user/agent finished granting FDA. Preserve `~/Documents/NutshellRehearsalShare/reports/fresh-install-report-strict-v0.1.17-tart-run-20260610a.failed-frozen.json`. The fix is a longer permission handoff timeout in `v0.1.18`; do not reuse this VM as pass evidence.
- Attempt `nutshell-strict-attempt-v0.1.18-20260610a` failed at `installed-product`: clean baseline and public Homebrew install passed, but the first installed `nutshell health --json` app handoff returned without a result file. Preserve `~/Documents/NutshellRehearsalShare/reports/fresh-install-report-strict-v0.1.18-tart-run-20260610a.failed-frozen.json`. The fix is app-owned status inspection without recursive Launch Services app opens plus a short result-file grace wait in `v0.1.19`.

## Attention Triggers

Stop and get the user's attention for:

- Google login in VM Chrome.
- X login in VM Chrome.
- Full Disk Access grant to `Nutshell.app`.
- Notes Automation prompt for `Nutshell.app`.
- Any prompt for the user's real Apple, Google, X, or password-manager credentials.
- Any VM-manager permission prompt that changes host app permissions, unless already explicitly allowed.

Use chat first. If the user asked to be interrupted aggressively, also send a macOS notification and email.

## Current Strict Attempt State

- The next strict attempt must use public `v0.1.19` after the app handoff result-file fix is published.
- Fresh Tart attempt `nutshell-strict-attempt-v0.1.17-20260610a` is frozen failed. It passed clean state, public install, installed product checks, pre-permission state, and signed-out YouTube/X auth behavior, then failed at `setup-flow` because the FDA handoff timed out. Frozen report: `~/Documents/NutshellRehearsalShare/reports/fresh-install-report-strict-v0.1.17-tart-run-20260610a.failed-frozen.json`.
- Fresh Tart attempt `nutshell-strict-attempt-v0.1.18-20260610a` is frozen failed. It passed host preflight, VM local checks, clean state, and public Homebrew install, then failed because the first installed app handoff did not write command JSON. Frozen report: `~/Documents/NutshellRehearsalShare/reports/fresh-install-report-strict-v0.1.18-tart-run-20260610a.failed-frozen.json`.
- Reusable auth-present seed is available at `~/Documents/NutshellRehearsalShare/auth-profiles/chrome-google-x-20260610-0039`. Use it only after the same run proves signed-out behavior, then record `browser-auth-seed-restore`.

## Historical VirtualBuddy State

- Official Google/YouTube export was found in Downloads and copied to `~/Documents/NutshellRehearsalShare/archives/google-youtube-export.zip`.
- Strict host preflight passed and wrote `dist/rehearsal/fresh-install-report-strict-preflight-20260609.json`.
- Tart attempt `nutshell-strict-attempt-v0.1.14-20260609e` is frozen failed at authenticated browser proof after visible Google/X login. The report was copied to `~/Documents/NutshellRehearsalShare/reports/fresh-install-report-strict-v0.1.14-tart-run-20260609e.failed-frozen.json`.
- `Nutshell Clean Baseline` is not currently clean. It booted with Nutshell already installed and a Nutshell setup/FDA window open.
- There is no separate VirtualBuddy snapshot file for `Nutshell Clean Baseline`; it is one dirty `Disk.img`.
- User granted permission to give VM Terminal Full Disk Access as diagnostic harness plumbing, but the VM UI became unreliable before that could be completed. Attempts to open guest System Settings/Terminal through dock clicks and Finder keyboard shortcuts did not work after refocus.
- Do not proceed to product pass checks until a real clean restore or fallback cleanup plus `verify-clean` succeeds.
