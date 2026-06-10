# Nutshell

Nutshell is a local personal trace ingestion runtime. It pulls Apple Notes, YouTube activity, Apple Podcasts listening history, and Twitter/X data into one local store with one health command, one background job, and rebuildable daily projections.

It is standalone. It does not require Hermes, BirdClaw, prior generated archives, or machine-specific historical stores.

## Product Defaults

- Command: `nutshell`
- User config: `~/nutconfig.jsonc`
- Data root: `~/Nutshell/`
- Store: `~/Nutshell/nutshell.sqlite`
- Secrets: `~/Nutshell/secrets.json`
- Logs: `~/Nutshell/logs/`
- macOS app bundle: installed by the release path; Homebrew stores it inside the
  `nutshell` prefix, and the tarball installer defaults to `~/Applications/Nutshell.app`
- app-owned agent label: `com.winterfell.nutshell.agent`

`~/nutconfig.jsonc` controls storage location, enabled plugins, sync schedule, browser profile settings, backfill cutoff, and per-plugin settings. Secret values do not belong in this file. Plugin secrets are stored through the namespaced Nutshell secret store with strict local file permissions.

## Install

Supported release paths on macOS install the app bundle and put a thin `nutshell`
control command in PATH:

```bash
brew install androidStern/nutshell/nutshell
tar -xzf nutshell-<version>-darwin-<arch>.tar.gz && ./install.sh
```

The npm/Bun registry path (`bun install -g nutshell`) is deferred and not
currently published or validated; do not use it as an install path.

The background sync must be owned by `Nutshell.app`, not by Bun, zsh, Codex, a
Homebrew Cellar executable, or a development checkout. Protected macOS reads
should happen through the app-owned agent after Full Disk Access is granted.

The Bun/npm package ships the compiled `bin/nutshell` executable. It does not install runtime JavaScript dependencies; source packages used to build the binary are development dependencies only.

During local development:

```bash
bun install
bun run dev -- help
bun run build:compile
bun run install:macos-app
./bin/nutshell help
```

## Commands

The normal CLI surface is intentionally small:

```bash
nutshell setup
nutshell sync [all|source] [--json]
nutshell health [--json]
nutshell dashboard [--no-open] [--host 127.0.0.1] [--port 0]
nutshell doctor [source] [--json]
nutshell import <source> <archive-path> [--dry-run] [--json]
```

Source names accept obvious aliases: `x` for `twitter`, `notes` for
`apple_notes`, `podcast` for `podcasts`. An unknown name lists the valid ones.
`sync` prints a human summary (skipped sources first, with their fix); pass
`--json` for the machine report.

`nutshell setup` is the normal first-run path and the one canonical fix-it
flow — it is safe to re-run anytime. It asks which sources to enable, sorts
out app permissions, verifies each source with its real probe, offers optional
provider archive imports, enables the app-owned background agent, and finishes
with one bounded smoke sync through the app so the final summary reports a
real result. Full ingestion happens after setup, in the background.

Hidden app/helper commands may exist inside the packaged app, but they are not the normal user workflow. There are no normal CLI commands for old-system migration, legacy status, preserved exports, waivers, canonical imports, repair plans, pending imports, or provider-internal step management.

## Onboarding

Run:

```bash
nutshell setup
```

Setup is TUI-first. The flow:

1. First run: choose which sources to enable. Re-run: setup opens with a
   status table refreshed by real probes (current truth, not stored state) and
   offers to fix only what fails — no intro ceremony, no re-selection.
2. App permission step, before any source verification: on macOS, source
   probes run through the `Nutshell.app` identity, so Full Disk Access is
   sorted out first via the permission window.
3. Each selected source is verified with its own real probe — one loop, three
   verbs: probe, retry (optionally opening the sign-in page), or skip. A
   failing probe shows what is wrong in plain words plus the exact fix and the
   command that confirms it. Nothing polls and nothing times out while you
   read; probes themselves are bounded.
4. `ready` means proven: a source is recorded ready only when its probe
   passed. Skipping records the honest state (`needs login`,
   `needs permission`, `blocked`) with the fix attached, and the final summary
   prints the comeback command. Disabled means you chose not to sync a source.

Plugins own their probes, fix text, and archive support:

- Apple Notes owns Notes.app automation checks.
- Apple Podcasts owns local database access checks.
- YouTube and Twitter/X own browser-session verification and official
  provider-export import support.

Auth state is measured, never stored: the probe setup uses is the same probe
`doctor`, `health`, and the scheduler use. If you skip a source and sign in
days later, the next scheduled sync probes, heals the status, and ingests —
no setup re-run required.

Rerun setup any time:

```bash
nutshell setup
```

## Backfill

Backfill defaults to six calendar months before the run date. The cutoff is configurable globally and per source in `~/nutconfig.jsonc`.

Approved historical imports:

- YouTube: official Google Takeout or Google Data Portability export for YouTube/My Activity.
- Twitter/X: official X.com archive export.

Examples:

```bash
nutshell import youtube ~/Downloads/takeout.zip --dry-run --json
nutshell import youtube ~/Downloads/takeout.zip --json
nutshell import twitter ~/Downloads/twitter-archive.zip --dry-run --json
nutshell import twitter ~/Downloads/twitter-archive.zip --json
```

If the provider export is not ready during setup, there is no pending import state to manage. Request the export from the provider, wait for the email/download, then run the matching `nutshell import ...` command later.

No other historical import source is accepted.

## Secrets

The first-version secret store is a local file:

```text
~/Nutshell/secrets.json
```

Nutshell creates the parent directory with mode `0700` and the secret file with mode `0600`. Plugins access only their own namespace through the core secret-store interface. Core does not understand plugin-local keys such as browser profile, session, token, or refresh token.

Browser-session plugins should store browser/profile references when possible. They should not copy browser cookies into config or logs. If a plugin has no reasonable alternative and must store a token or cookie, it must use the secret store.

The dashboard, health output, and logs redact secret-looking keys and token strings.

## Health And Permissions

```bash
nutshell health
nutshell health --json
```

Health checks data-root writability, disk free space, SQLite quick_check, lock presence, app-owned background agent state, Full Disk Access state, plugin auth/dependency checks, rate-limit markers, configured backfill coverage, source freshness, and projection freshness.

Every problem finding carries its own fix: a user-state classification
(`needs_auth`, `needs_permission`, `blocked_bug`, …), the concrete human
action, and the command that confirms it — rendered on every surface (health,
doctor, sync output, setup summary, dashboard). Doctor output is
root-cause-first: when the app or Full Disk Access is missing, that leads and
downstream permission symptoms collapse into one line instead of four. Sources
waiting on a provider export keep a standing line with the exact import
command until the import completes.

If macOS blocks access to Apple Podcasts, browser cookie stores, or Apple Notes,
the production fix is Full Disk Access for `Nutshell.app`. Do not grant access to
Bun, zsh, Codex, Terminal, Homebrew Cellar paths, or temporary build products.

Exit codes:

- `0` for ok
- `1` for warnings
- `2` for critical failures
- `69` for unavailable dependency/auth
- `75` for temporary failure such as active lock or rate limit

## Dashboard

```bash
nutshell dashboard
nutshell dashboard --no-open
```

The dashboard starts a local server on `127.0.0.1` with an ephemeral port, prints the URL, and opens the browser unless `--no-open` is passed. It is served by the installed Nutshell command itself; there is no dev server, cloud service, Hermes job, or separate UI process.

It shows health, app-owned background status, lock/storage status, recent daily records, source detail panels, safe sync controls, projection rebuild, diagnostics copying, and a guarded settings editor for `~/nutconfig.jsonc`. Config saves validate first, create a timestamped backup, and report the changed fields.

## Scheduling

`Nutshell.app` registers an app-owned background agent through ServiceManagement
(`SMAppService`). The agent runs from inside the signed app bundle and invokes
the bundled `nutshell-core` executable. It will not sync until Full Disk Access is
granted and `enable-sync` has created the local enable marker.

`nutshell setup` handles the normal background-agent registration and enablement from the terminal flow, then runs one bounded smoke sync through the app identity and reports its real result. The macOS permission helper window is permission-only: it opens Full Disk Access, provides a draggable app icon so the user does not have to manually hunt through `/Applications`, and tells the user to return to the terminal once access is granted.

The scheduler self-heals degraded sources: each scheduled run gives a degraded
source one bounded probe — a passing probe flips it back to ready and syncs;
a failing probe refreshes the stored finding and skips the expensive sync.
Provider rate limits back off instead of probing.

Do not use a raw shell-owned background job for production macOS protected-data sync.

## Release Verification

Before a release is considered production-ready, verify each install path in a clean environment:

- Homebrew install plus `nutshell setup`
- Tarball copy/install flow without Bun installed

Release validation runs as split gates with three-way failure verdicts
(`product_fail`, `harness_fail`, `fixture_stale`); a stale auth fixture queues
a gate instead of failing the candidate, and a release is never declared
validated while a required gate is queued. See
`docs/release-validation-gates.md` for the gate list, fixture preflight, and
the snapshot keep-alive job.

For each path, verify `command -v nutshell`, `nutshell --version`, `nutshell setup`,
Full Disk Access onboarding, manual sync, restart survival, upgrade survival, and
permission persistence.

The repeatable local certification command is:

```bash
bun run certify:release
```

That command must verify the app-owned agent path, not an old raw shell-owned path.
It should fail if protected sync is owned by Bun, Terminal, Codex, Homebrew
Cellar paths, or `~/.local/bin/nutshell`.

The full first-user release rehearsal is documented in
`docs/fresh-install-release-rehearsal.md`. It uses a disposable macOS test
environment, verifies a clean baseline with no prior Nutshell state or browser
auth, installs from the published artifact, exercises setup and app permissions,
imports official provider archives, runs foreground and background sync, and
records the result with:

```bash
bun run rehearse:run -- \
  --release-id <tag-or-artifact-id> \
  --install-source <public-install-source> \
  --x-archive <zip> \
  --youtube-export <zip> \
  --podcasts-seed <sqlite>
```

Existing rehearsal evidence must pass the aggregate report audit before it counts:

```bash
bun run rehearse:audit-report -- --report ~/fresh-install-report.json
```

Use a fresh report path per attempt. The runner refuses to append a new full
attempt into an existing report unless `--force-new-report` is used to archive
the previous evidence first.

Two release gates still require an actual Mac session rather than a script shortcut:

- Fresh macOS user: install from each supported path in a new user account, run `nutshell setup`, and verify no prior `~/nutconfig.jsonc` or `~/Nutshell/` state was required.
- Reboot: reboot after granting permissions, then verify the app-owned background agent is enabled, health is clean, sync works, and protected Apple sources are still readable.

## Development

```bash
bun install
bun run typecheck
bun test
bun run lint
bun run build
bun run build:compile
bun run build:macos-app
bun run install:macos-app
bun run build:tarball
bun run certify:release
```

Production sync must not shell out to BirdClaw, Hermes listening-history, `yt-dlp`, `curl`, `sqlite3`, or Playwright unless a future explicit product decision changes that dependency policy.
