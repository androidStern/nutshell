# Nutshell Agent Notes

## Product Model

Nutshell is a local sync engine for building a user-owned digital trace that LLM agents can query.

It is not "a YouTube/X/Notes/Podcasts app." Those are built-in plugins, not the product boundary. Third-party plugins are expected, so core product copy and core logic must describe generic sources/plugins unless it is intentionally documenting a built-in plugin.

## Plugin Boundary

Core owns:
- CLI shape and generic UX
- setup orchestration
- automatic sync scheduling
- local storage and projections
- health/report rendering
- dashboard shell
- reset/import command plumbing
- generic plugin contracts

Plugins own:
- source-specific auth
- source-specific permissions
- provider/browser/session details
- source-specific smoke checks
- source-specific sync/import behavior
- source-specific findings, recovery copy, and setup text

Do not move plugin-specific knowledge into core to make a flow pass. Core may call plugin contract methods; it should not know how YouTube, X, Notes, Podcasts, or future third-party sources authenticate or verify themselves.

## Product Language

Use:
- "Nutshell syncs configured sources"
- "plugins"
- "sources"
- "automatic sync"
- "local digital trace"
- "for LLM agents to query"

Avoid as primary user-facing language:
- hardcoded lists of built-in sources in generic core copy
- "background service"
- "agent" except diagnostics/release internals
- "app-owned" except diagnostics/release internals
- implementation commands as normal user instructions

## macOS App And Permissions

Protected macOS reads must go through `Nutshell.app`, not Bun, Terminal, Codex, Homebrew Cellar binaries, or repo-local scripts.

Normal stable app path for local/dev installs is:

```bash
~/Applications/Nutshell.app
```

Homebrew may store an app bundle in its prefix, but the CLI should use/promote a stable user app path for permissions.

For host-machine cleanup before a true Homebrew/tarball install test, use:

```bash
scripts/cleanup-local-machine-state.sh
```

It is dry-run by default; pass `--execute` only after reviewing what it will remove. The script deliberately does not run broad privacy resets such as `tccutil reset AppleEvents` or `sfltool resetbtm`, and it does not edit TCC databases with SQL. It removes install artifacts, app bundles, launch plists, package caches/logs, and reports remaining macOS permission/identity metadata so the user can decide whether a broader reset is acceptable.

## Install Paths

Real user install paths are Homebrew and tarball.

Bun commands are development/build tooling only. Do not treat `bun run ...` as a user install path or release validation path.

## Testing Rule

Do not add test-only shortcuts that make the product appear to work. If a test needs auth, permissions, or app identity, validate through the same product path a user would use, or clearly mark it as a fixture/unit test.

Reset must only clear Nutshell-owned local state. It must not delete Chrome login, Keychain items, macOS permissions, or browser profiles.

## Communication

Use domain-first, plain language. Explain what changed, what remains broken, and what the user can test. Avoid terse internal jargon.
