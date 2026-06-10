# Release Validation Gates

This is the reset after the failed monolithic VM rehearsals. Do not start with "run the whole VM flow again." Prove the product in smaller gates first, then do one final fresh-install rehearsal only after those gates are boring.

## Product Behavior

The product has to explain each source in user terms:

- `not_configured`: the user did not turn this source on.
- `needs_auth`: the user is not signed in to the provider or browser profile.
- `needs_permission`: macOS or the app is missing a permission.
- `ready_empty`: the source is reachable, but there is no provider data in scope.
- `ready_with_data`: the source is reachable and produced canonical records.
- `blocked_bug`: the user state should work, but Nutshell cannot inspect or sync it.

These states are machine-readable. Every problem finding carries `finding.guidance.state` with one of these values, plus `fix` and `confirm` text authored at the source. Gates assert on the field, not on prose.

Important rule: if Chrome is visibly signed in and Nutshell still fails because of Chrome Safe Storage, Keychain, cookie decryption, or a browser handoff timeout, that is `blocked_bug`. It is not `needs_auth`, and it is not a release pass.

## Verdicts

Every gate report labels each failure with exactly one verdict:

- `product_fail`: the installed product misbehaved. Freeze the report, fix code separately, publish a new artifact, restart the gate from a clean state.
- `harness_fail`: the gate machinery broke — VM boot, share mount, exec transport, probe plumbing. Fix the harness and rerun. The candidate is not implicated.
- `fixture_stale`: a fixture the gate depends on (auth-present cookies, seeds) is no longer healthy. The gate queues for after a fixture refresh; all other work proceeds.

Rules:

- `fixture_stale` queues the gate, it does not fail the candidate. It is not a pass either.
- A release is never declared validated while a required gate is queued.
- Do not blur the verdicts. A product bug discovered while a fixture is stale is still `product_fail`; a stale fixture discovered by a crashing harness is still `fixture_stale` once the harness is fixed.

## Hard Rules

- Gates run from cloned snapshots, driven over SSH/CLI (`tart exec`) only.
- No computer-use or coordinate clicking as the main harness.
- UI clicking can only be a manual handoff or diagnostic action. It cannot make a phase pass.
- No private Chrome Safe Storage password file. `v0.1.20` tried that and was rejected.
- Do not build auth fixtures from dirty failed release VMs.
- Do not let archive/import records stand in for live signed-in sync records.
- Do not skip YouTube import while the release claims `nutshell import youtube <provider-export>`.
- Private archives, browser profiles, logs, and reports stay outside git.

## Gates Before The Final VM Rehearsal

### 1. Local Import Gate

Purpose: prove official X and Google/YouTube export imports without any VM UI or browser auth.

Run:

```bash
bun run rehearse:verify-imports-local -- \
  --x-archive ~/Documents/NutshellRehearsalShare/archives/twitter-archive.zip \
  --youtube-export ~/Documents/NutshellRehearsalShare/archives/google-youtube-export.zip \
  --root ~/Documents/NutshellRehearsalShare/import-gates/local-provider-imports \
  --report ~/Documents/NutshellRehearsalShare/reports/local-provider-imports.json
```

Pass means:

- official X archive path exists
- official Google/YouTube export path exists
- `nutshell import twitter ... --json` succeeds in an isolated root
- `nutshell import youtube ... --json` succeeds in an isolated root
- canonical Twitter/X records exist
- canonical YouTube records exist

This gate does not prove browser auth, live sync, permissions, scheduler, health, or dashboard.

### 2. Signed-Out Browser Gate

Purpose: prove a clean user who is not signed in gets a clear "needs login" result.

Run only after clean-state proof in the target test environment:

```bash
bun run rehearse:verify-unauthenticated -- --report <report.json> --append
```

Pass means YouTube and X doctors return source-specific auth findings. Generic critical, empty success, keychain mystery, or missing JSON is a failure.

### 3. Stable Signed-In Browser Gate

Purpose: prove the installed product can use an already-authenticated Chrome profile without rebuilding auth inside a failed release attempt.

Use a dedicated auth-present VM snapshot, not a dirty failed rehearsal VM. The snapshot should contain Chrome signed into Google My Activity and X, with no Nutshell app, config, data root, or agent. Clone the newest `-keepalive-<YYYYMMDD>` promotion when one exists, otherwise the base snapshot.

Fixture preflight: before any product assertion, the gate verifies the cloned snapshot's cookie fixture is healthy — Google auth cookies (`SAPISID` or `__Secure-1PSID`) and X `auth_token` present and decryptable through the keychain-backed cookie path. Preflight failure records verdict `fixture_stale`, queues the gate, and does not fail the candidate. Fix: run `scripts/snapshot-keepalive.sh`, or the manual re-login in `docs/rehearsal-browser-auth-seeds.md` if the keep-alive also reports stale. Product assertions never run against a stale fixture.

Start from the preflighted clone, install the public release path, then run:

```bash
bun run rehearse:verify-authenticated -- --report <report.json> --append
```

Pass means both cookie probes and `nutshell doctor youtube --json` / `nutshell doctor twitter --json` work with no Chrome Safe Storage or Keychain timeout warnings.

If a macOS prompt appears during this gate, stop and record it. Do not click through prompts as the harness and call that a pass.

Current proven snapshot:

- VM snapshot: `nutshell-authpresent-sequoia-google-x-20260610`
- Public release tested: `v0.1.22`
- Passing report: `~/Documents/NutshellRehearsalShare/reports/signedin-gate-v0.1.22-20260610c.json`
- Baseline proof before install: no Nutshell command/app/config/data/agent/tap, Chrome Safe Storage readable, Google auth cookies present, X auth cookies present.

### 4. Permissions Gate

Purpose: prove missing permissions are reported as permissions, and granted permissions belong to `Nutshell.app`.

The post-permission snapshot is produced once by the staged ~20-minute human session in `docs/post-permission-snapshot-session.md` (naming: `nutshell-postperm-sequoia-<YYYYMMDD>`). That session is the only human clicking in this gate's lifecycle; it builds a frozen fixture, it is not pass evidence. The gate itself asserts both states mechanically, over SSH/CLI from clones:

- pre-permission state (clone of the auth-present snapshot with the release candidate installed, no grants): doctor reports the per-source pre-state contract below.
- post-permission state (clone of the post-permission snapshot): probes pass clean, with the grants owned by `Nutshell.app`.

Pre-state contract per source (encoded from the v0.1.23 frozen evidence): the system-level Full Disk Access root cause (`nutshell_app_full_disk_access_missing` or `nutshell_app_missing`) must be present with `needs_permission` guidance; `apple_notes` must report a source-level `needs_permission` finding with non-empty fix/confirm (AppleEvent -1712 consent timeouts classify as `apple_notes_automation_permission_required`); `podcasts` must report either `needs_permission` or its honest no-library state (`podcasts_db_missing`, `guidance.state: ready_empty`) — FDA-related podcasts findings only appear when a protected library exists, and a fresh VM has none; `youtube` and `twitter` are not FDA-gated, because Chrome's cookie store is not Full-Disk-Access-protected — they may genuinely pass pre-grant, and the gate only requires that any finding they emit carries guidance.

This gate covers:

- Full Disk Access missing before setup
- Full Disk Access granted to `Nutshell.app`
- Notes automation missing before approval
- Notes automation granted to `Nutshell.app`
- app-owned background agent target, not Bun, Terminal, Homebrew Cellar, or a raw CLI

### 5. Live Sync And Dashboard Gate

Purpose: prove auth-present live sync and the reader-facing dashboard, separate from archive imports.

Runs headlessly from a clone of the post-permission snapshot (`docs/post-permission-snapshot-session.md`), with the same cookie fixture preflight as the signed-in gate: stale cookies record `fixture_stale` and queue the gate.

Pass means:

- foreground `nutshell sync all --json` emits live YouTube records
- foreground sync emits live X records
- Podcasts reads the SQLite-safe snapshot through the normal plugin path
- Notes reads a visible note through `Nutshell.app`
- scheduled app-owned background sync records last and next run times
- final health is `ok`
- dashboard API/page show nonzero records for YouTube, Podcasts, Notes, and X

## Session Keep-Alive

`scripts/snapshot-keepalive.sh` keeps the auth-present snapshot's sessions alive instead of letting them rot. It clones the snapshot, boots it headless, opens Chrome on `myactivity.google.com` and `x.com` so both sessions refresh themselves, quits Chrome cleanly so cookies flush, verifies inside the VM that the cookies are present and decryptable (the same sweet-cookie/keychain path the gates use), and on a verified pass promotes the clone as `<snapshot>-keepalive-<YYYYMMDD>`, deleting the previous dated promotion. The base snapshot is never renamed or deleted.

Exit codes: `0` refreshed and promoted, `70` `HARNESS FAIL` (tart/boot/exec plumbing), `75` `FIXTURE STALE` (prints the manual re-login steps from `docs/rehearsal-browser-auth-seeds.md`). A `75` means Andrew must re-login; until then, dependent gates record `fixture_stale` and queue.

Run it weekly. Scheduling is an operator action, not something the repo configures. Sample cron line (a launchd agent with `StartCalendarInterval` is equivalent):

```cron
0 9 * * 1 /path/to/nutshell-repo/scripts/snapshot-keepalive.sh >> $HOME/Documents/NutshellRehearsalShare/keepalive/cron.log 2>&1
```

Failures must notify — at minimum cron mail or a monitored log. A keep-alive that fails silently defeats its purpose; the next gate run would discover the rot at the worst time.

## Final Fresh-Install Rehearsal

Only after the gates above are stable should the team run the one-pass fresh-install rehearsal. The final pass condition remains one clean public install run with clean baseline, missing-auth proof, present-auth proof, official imports, permissions, foreground sync, scheduled app-owned sync, health, and dashboard.

If any gate exposes a product bug (`product_fail`), freeze the report, fix code separately, publish a new artifact, and restart the affected gate from a clean state. Do not patch the installed app in place. Harness breakage (`harness_fail`) is fixed and rerun without implicating the candidate; stale fixtures (`fixture_stale`) queue the gate behind a fixture refresh and never fail the candidate by themselves.
