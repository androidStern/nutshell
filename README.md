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
bun install -g nutshell
brew install androidStern/nutshell/nutshell
tar -xzf nutshell-<version>-darwin-<arch>.tar.gz && ./install.sh
```

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
nutshell sync [all|plugin] [--json]
nutshell health [--json]
nutshell dashboard [--no-open] [--host 127.0.0.1] [--port 0]
nutshell doctor [plugin] [--json]
nutshell import <plugin> <archive-path> [--dry-run] [--json]
```

`nutshell setup` is the normal first-run path. It asks which plugins to enable, runs bounded plugin-owned auth and permission checks, offers optional provider archive imports, and enables the app-owned background agent. It does not run ingestion during setup; the initial data sync is handed off to the background agent or to `nutshell sync`.

Hidden app/helper commands may exist inside the packaged app, but they are not the normal user workflow. There are no normal CLI commands for old-system migration, legacy status, preserved exports, waivers, canonical imports, repair plans, pending imports, or provider-internal step management.

## Onboarding

Run:

```bash
nutshell setup
```

Setup is TUI-first. It uses plugins to run source-specific setup:

- Apple Notes owns Notes.app automation checks and repair guidance.
- Apple Podcasts owns local database access checks and permission guidance.
- YouTube owns browser-session verification and official Google export import support.
- Twitter/X owns browser-session verification and official X archive import support.

If one selected plugin fails, setup keeps going. The failed plugin is marked `degraded`, not disabled. Disabled means the user chose not to run a plugin. Degraded means the user selected it but Nutshell cannot safely sync it yet.

Core setup is only the coordinator. Plugins own their own setup checks, and core setup enforces an outer timeout around each plugin so setup cannot hang forever. Full backlog ingestion is not a setup step.

Rerun setup any time:

```bash
nutshell setup
```

Health and scheduled sync respect setup state. A degraded plugin is reported clearly and is not treated as healthy by background sync.

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

`nutshell setup` handles the normal background-agent registration and enablement from the terminal flow. The macOS permission helper window is permission-only: it opens Full Disk Access, provides a draggable app icon so the user does not have to manually hunt through `/Applications`, and tells the user to return to the terminal once access is granted.

Do not use a raw shell-owned background job for production macOS protected-data sync.

## Release Verification

Before a release is considered production-ready, verify each install path in a clean environment:

- `bun install -g nutshell`
- Homebrew install plus `nutshell setup`
- Tarball copy/install flow without Bun installed

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
