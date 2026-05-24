# Nutshell

Nutshell is a local personal trace ingestion runtime. It pulls Apple Notes, YouTube activity, Apple Podcasts listening history, and Twitter/X data into one local store with one health command, one background job, and rebuildable daily projections.

It is standalone. It does not require Hermes, BirdClaw, prior generated archives, or machine-specific historical stores.

## Product Defaults

- Command: `nutshell`
- User config: `~/nutconfig.jsonc`
- Data root: `~/Nutshell/`
- Store: `~/Nutshell/nutshell.sqlite`
- Logs: `~/Nutshell/logs/`
- Launchd label: `com.winterfell.nutshell`

`~/nutconfig.jsonc` controls storage location, enabled plugins, sync schedule, browser profile settings, backfill cutoff, and per-plugin settings.

## Install

Supported release paths:

```bash
bun install -g nutshell
brew install nutshell
tar -xzf nutshell-<version>-darwin-<arch>.tar.gz && ./install.sh
```

All supported installs must put `nutshell` in PATH. The background job must run that same installed executable, not Bun, zsh, Codex, or a development checkout.

The Bun/npm package ships the compiled `bin/nutshell` executable. It does not install runtime JavaScript dependencies; source packages used to build the binary are development dependencies only.

During local development:

```bash
bun install
bun run dev -- help
bun run build:compile
./bin/nutshell help
```

## Commands

The normal CLI surface is intentionally small:

```bash
nutshell init
nutshell plugins
nutshell sync [source|all] [--mode recent|backfill] [--collection name] [--since date] [--until date] [--dry-run] [--json]
nutshell import [youtube|twitter] --path <provider-export> [--dry-run] [--json]
nutshell enrich twitter [--limit N] [--json]
nutshell health [--json]
nutshell query [--source source] [--since date] [--until date] [--type type] [--json]
nutshell day YYYY-MM-DD [--json|--markdown]
nutshell dashboard [--no-open] [--host 127.0.0.1] [--port 0]
nutshell launchd install|uninstall|status [--json]
```

There are no normal CLI commands for old-system migration, legacy status, preserved exports, waivers, canonical imports, repair plans, or provider-internal step management.

## Backfill

Backfill defaults to six calendar months before the run date. The cutoff is configurable globally and per source in `~/nutconfig.jsonc`.

Approved historical imports:

- YouTube: official Google Takeout or Google Data Portability export for YouTube/My Activity.
- Twitter/X: official X.com archive export.

Examples:

```bash
nutshell import youtube --path ~/Downloads/takeout.zip --dry-run --json
nutshell import youtube --path ~/Downloads/takeout.zip --json
nutshell import twitter --path ~/Downloads/twitter-archive.zip --dry-run --json
nutshell import twitter --path ~/Downloads/twitter-archive.zip --json
```

No other historical import source is accepted.

## Health And Permissions

```bash
nutshell health
nutshell health --json
```

Health checks data-root writability, disk free space, SQLite quick_check, lock presence, launchd state, plugin auth/dependency checks, rate-limit markers, configured backfill coverage, source freshness, and projection freshness.

If macOS blocks access to Apple Podcasts or Apple Notes, health must say which permission is missing in plain language. Production permission grants should be made to the installed `nutshell` app or command, not to Bun, zsh, Codex, or a temporary build path.

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

It shows health, launchd state, lock/storage status, recent daily records, source detail panels, safe sync controls, projection rebuild, diagnostics copying, and a guarded settings editor for `~/nutconfig.jsonc`. Config saves validate first, create a timestamped backup, and report the changed fields.

## Scheduling

```bash
nutshell launchd install
nutshell launchd status --json
nutshell launchd uninstall
```

The launchd job runs:

```bash
nutshell sync all --mode recent --json
```

The runtime decides which plugins are enabled and due. There are not separate launchd jobs per source.

## Release Verification

Before a release is considered production-ready, verify each install path in a clean environment:

- `bun install -g nutshell`
- Homebrew formula install plus `brew test nutshell` and `brew services start nutshell`
- Tarball copy/install flow without Bun installed

For each path, verify `command -v nutshell`, `nutshell --version`, `nutshell init`, `nutshell health`, manual sync, launchd install/status, restart survival, upgrade survival, and permission persistence.

The repeatable local certification command is:

```bash
bun run certify:release -- --include-launchd --include-homebrew --live-permission-check
```

That command builds the release, verifies the Bun package install, verifies the standalone tarball including launchd registration, verifies the Homebrew formula including `brew test` and `brew services start`, runs a Homebrew reinstall check, and confirms the installed Homebrew binary can still read the live Apple Notes and Apple Podcasts sources on the current Mac. It restores the normal Nutshell launchd job afterward.

Two release gates still require an actual Mac session rather than a script shortcut:

- Fresh macOS user: install from each supported path in a new user account, then run `bun run certify:fresh-user -- --live-permission-check` before creating any Nutshell state. The check fails if `~/nutconfig.jsonc` or `~/Nutshell/` already exists.
- Reboot: reboot after granting permissions, then run `bun run certify:post-reboot -- --live-permission-check`. The check fails unless launchd is loaded, the daemon uses the installed `nutshell`, health is clean, sync works, and protected Apple sources are still readable.

## Development

```bash
bun install
bun run typecheck
bun test
bun run lint
bun run build
bun run build:compile
bun run build:tarball
bun run certify:release -- --include-launchd --include-homebrew --live-permission-check
bun run certify:post-reboot -- --live-permission-check
bun run certify:fresh-user -- --live-permission-check
```

Production sync must not shell out to BirdClaw, Hermes listening-history, `yt-dlp`, `curl`, `sqlite3`, or Playwright unless a future explicit product decision changes that dependency policy.
