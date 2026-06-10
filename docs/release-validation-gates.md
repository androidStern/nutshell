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

Important rule: if Chrome is visibly signed in and Nutshell still fails because of Chrome Safe Storage, Keychain, cookie decryption, or a browser handoff timeout, that is `blocked_bug`. It is not `needs_auth`, and it is not a release pass.

## Hard Rules

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

Use a dedicated auth-present VM snapshot, not a dirty failed rehearsal VM. The snapshot should contain Chrome signed into Google My Activity and X, with no Nutshell app, config, data root, or agent. Start from that snapshot, install the public release path, then run:

```bash
bun run rehearse:verify-authenticated -- --report <report.json> --append
```

Pass means both cookie probes and `nutshell doctor youtube --json` / `nutshell doctor twitter --json` work with no Chrome Safe Storage or Keychain timeout warnings.

If a macOS prompt appears during this gate, stop and record it. Do not click through prompts as the harness and call that a pass.

### 4. Permissions Gate

Purpose: prove missing permissions are reported as permissions, and granted permissions belong to `Nutshell.app`.

This gate covers:

- Full Disk Access missing before setup
- Full Disk Access granted to `Nutshell.app`
- Notes automation missing before approval
- Notes automation granted to `Nutshell.app`
- app-owned background agent target, not Bun, Terminal, Homebrew Cellar, or a raw CLI

### 5. Live Sync And Dashboard Gate

Purpose: prove auth-present live sync and the reader-facing dashboard, separate from archive imports.

Pass means:

- foreground `nutshell sync all --json` emits live YouTube records
- foreground sync emits live X records
- Podcasts reads the SQLite-safe snapshot through the normal plugin path
- Notes reads a visible note through `Nutshell.app`
- scheduled app-owned background sync records last and next run times
- final health is `ok`
- dashboard API/page show nonzero records for YouTube, Podcasts, Notes, and X

## Final Fresh-Install Rehearsal

Only after the gates above are stable should the team run the one-pass fresh-install rehearsal. The final pass condition remains one clean public install run with clean baseline, missing-auth proof, present-auth proof, official imports, permissions, foreground sync, scheduled app-owned sync, health, and dashboard.

If any gate exposes a product bug, freeze the report, fix code separately, publish a new artifact, and restart the affected gate from a clean state. Do not patch the installed app in place.
