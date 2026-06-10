# Nutshell Release Update Contract

This document is the release playbook for shipping a Nutshell update. It is not a product requirements document. It exists to keep each update reproducible, to force real install testing before a release is called deliverable, and to prevent release-specific shortcuts from becoming product architecture.

## Purpose

A release is only deliverable when a fresh user can install the published artifact, run setup, grant the intended macOS permission to `Nutshell.app`, enable the app-owned background agent, open the dashboard, and see the system syncing.

Do not treat "the app explains why it is not syncing" as a release success condition. Error reporting is necessary, but a release candidate still has to prove that the intended happy path works.

## Approved Dependency Fence

Nutshell must not depend on Hermes, BirdClaw, old local archives, old plists, old launch agents, old machine-specific stores, or machine-specific paths.

Nutshell must also not add any package, external command, service, daemon, browser automation framework, provider helper, local database tool, or release tool outside the approved lists below unless the dependency policy is deliberately updated in the same change. If a dependency is not listed here, it is banned for the release.

Approved direct runtime package dependency:

1. `@clack/prompts` at `^1.4.0`.

Approved direct development and build package dependencies:

1. `@steipete/bird` at `0.8.0`.
2. `@steipete/sweet-cookie` at `0.3.0`.
3. `@types/bun` at `latest`.
4. `@types/yauzl` at `^2.10.3`.
5. `json5` at `^2.2.3`.
6. `typescript` at `^5.9.3`.
7. `yauzl` at `^3.3.1`.

Approved locked transitive package dependencies, only as dependencies of the direct packages above:

1. `@clack/core`.
2. `@steipete/sweet-cookie@0.1.0`, as the nested dependency of `@steipete/bird`.
3. `@types/node`.
4. `buffer-crc32`.
5. `bun-types`.
6. `commander`.
7. `fast-string-truncated-width`.
8. `fast-string-width`.
9. `fast-wrap-ansi`.
10. `kleur`.
11. `pend`.
12. `sisteransi`.
13. `undici-types`.

Approved host tools for local development, packaging, and release rehearsal:

1. `bun`.
2. `git`.
3. `gh`.
4. `brew`.
5. POSIX shell tools used by the installer and build scripts: `sh`, `chmod`, `cp`, `mkdir`, `rm`, `tar`, and `test`.
6. macOS build and signing tools already used by the project: `xcrun`, `swiftc`, `codesign`, `security`, `xattr`, and `ditto`.

Approved product runtime external CLI dependencies: none.

The product runtime must not shell out to Hermes, BirdClaw, `bird`, `yt-dlp`, `curl`, `sqlite3`, Playwright, Python, Node, npm, Homebrew services, or raw launchd scripts for ingestion. Bun built-ins, bundled code, the bundled `Nutshell.app`, and macOS system APIs are the intended runtime boundary.

## Release Steps

1. Start from a clean worktree. If the worktree is dirty, identify whether the change belongs to the release. Do not release with unrelated local edits.

2. Read the diff as a release risk assessment. Identify whether the update touches setup, permissions, packaging, background sync, dashboard health, plugin sync, import, storage, signing, or install paths. Any touched area must be included in smoke testing.

3. Confirm the dependency fence. Compare `package.json`, `bun.lock`, build scripts, installer scripts, and plugin transport code against the approved dependency lists in this document. If a new dependency appears, stop and either remove it or update this document as an explicit product decision.

4. Run the automated verification suite from the repository root:

   ```bash
   bun install
   bun run typecheck
   bun test
   bun run lint
   bun run build
   bun run build:compile
   bun run build:macos-app
   bun run build:tarball
   bun run certify:release
   ```

5. Inspect the generated release artifact. The tarball must contain the compiled `nutshell` command, `Nutshell.app`, the app icon, the setup background video, installer scripts, `VERSION`, and `manifest.json`. The generated Homebrew formula must point at the same version and SHA as the tarball.

6. Publish the tag and release asset only after local certification passes. The release asset SHA and the formula SHA must match exactly.

7. Update the tapped Homebrew formula. The install command for a normal user must be the tapped formula path, not a local formula file. Homebrew rejects arbitrary formula paths that are not in a tap, so a local formula-path test is not a valid Homebrew release rehearsal.

8. Run install rehearsals from the published artifacts, not from the development checkout. The supported release paths are Homebrew and tarball install. The global Bun/npm package path is deferred (not published or validated) until npm publishing resumes as an explicit decision.

9. Run setup from the installed command. During setup, verify that the permissions helper is `Nutshell.app`, that Full Disk Access is granted to `Nutshell.app`, and that background sync is enabled by the terminal setup flow after the helper window is closed.

10. Prove actual sync. Run an immediate sync or wait for the scheduled app-owned background sync, then verify that each enabled source touched by the release produced records or updated source run state successfully. If the release touches a plugin, that plugin must be exercised against the real source, not only fixtures.

11. Open the dashboard from the installed command. The dashboard must show the app installed, agent enabled, access granted, lock clear, storage ok, last sync populated after a sync, and next sync populated from the app-owned scheduler.

12. Reboot once for a release that touches install, permissions, background sync, signing, app bundle layout, or health scheduling. After reboot, verify that the app-owned agent remains enabled, the dashboard still sees next sync, and protected local sources still read without prompting for access again.

## Required Pre-Delivery Testing

An agent must not call a release deliverable until it has produced evidence for the following:

1. The automated suite passed.

2. The release tarball was built and its SHA was recorded.

3. The Homebrew formula points to the published tarball URL and exact SHA.

4. A Homebrew install from the tapped public source was run on a clean local install state.

5. A tarball install from the generated tarball was run on a clean local install state.

6. (Deferred while the npm path is out of scope) A Bun global install from the published package path.

7. `command -v nutshell` resolves to the installed release command, not the development checkout.

8. `nutshell --version` prints the release version.

9. `nutshell setup` completes from the installed command.

10. Full Disk Access is granted to `Nutshell.app`, not to Bun, Terminal, Codex, the Homebrew Cellar executable, or a temporary build product.

11. The background agent is registered and enabled through `Nutshell.app`.

12. A real sync succeeds for every enabled source in the smoke account after setup.

13. The dashboard launches from the installed command and reports a non-unknown next scheduled sync once the agent is enabled.

14. No macOS protected-data prompt appears during normal background sync after permissions are granted.

15. No old local state is required for setup, sync, health, or dashboard to work.

## Gotchas Learned So Far

Homebrew install testing must use a tap. Installing a raw local formula path is not equivalent to a user install and can fail before testing the product at all.

Full Disk Access must belong to `Nutshell.app`. If Bun, Terminal, Codex, a Homebrew Cellar binary, or a development build touches protected data, macOS can prompt for the wrong process and the permission will not prove the production app works.

Old app bundles can confound permission testing. If an old agent or old app path is still running, macOS can re-add an old no-icon app entry to Full Disk Access immediately after removal. Clean rehearsals must remove stale agents and stop stale processes before judging permission behavior.

Setup must not run full ingestion as a hidden setup step. Setup should coordinate plugin checks, permissions, archive import prompts, and background-agent enablement. Backlog ingestion belongs to sync and import.

The permissions helper should not be the place where background sync is enabled. The helper's job is to guide Full Disk Access. The terminal setup flow should verify permissions after the helper closes and then ask whether to enable the background service.

The dashboard cannot derive next sync only from source run history. A fresh install may have no source run yet. Next sync must come from the app-owned scheduler state, agent logs, or schedule calculation.

The background agent can start before sync is enabled. It must poll quickly while disabled or missing access, then log its next scheduled sync once enabled. Otherwise a fresh install can show `NEXT UNKNOWN` even though the agent is loaded.

Provider archive import tests must use provider exports when importer behavior changes. Dry runs and fixtures are not enough to prove a production archive import path.

Apple Podcasts release seeds must be created with the rehearsal snapshot command, not a raw file copy. The snapshot command writes `MTLibrary.sqlite.snapshot.json`; the rehearsal should reject a seed without that provenance file.

YouTube, Podcasts, Notes, and X each fail differently. A release that touches one of these plugins must run that plugin against the real source it claims to support. Do not generalize success from a different plugin.

Warnings are useful for diagnosis, but warnings are not release success. If a warning is expected during a rehearsal, the release note must identify why it is outside the changed surface and why it does not block the release.

## No-Go Paths

Do not ship from a development checkout and call it a release test.

Do not test only `bun run src/cli.ts`. The release must be tested through the installed `nutshell` command.

Do not use old Hermes, BirdClaw, old archives, previous Nutshell data, previous config files, previous plists, or previous TCC grants to make a release appear healthy.

Do not grant permissions to any process other than `Nutshell.app` for production protected-data sync.

Do not add a new external CLI, daemon, browser automation system, database tool, package manager service, or provider helper without explicitly updating the dependency fence.

Do not add release-only commands to the normal user workflow to paper over a packaging or sync problem.

Do not hide a failed source behind a passing health summary.

Do not treat `NEXT UNKNOWN`, stale source run state, stale lock state, or a missing app-owned agent as acceptable in a clean successful install.

Do not declare importer changes done without running at least one real provider export through the installed release command.

Do not publish a formula whose version, URL, or SHA does not match the release artifact.

## Clean Install Rehearsal

A clean install rehearsal means the test starts without installed Nutshell binaries, installed `Nutshell.app` bundles, registered Nutshell agents, previous Nutshell config, previous Nutshell data, old app-owned enable markers, stale launch agents, stale app processes, or useful preexisting TCC grants.

Before running the install command, remove or move aside:

1. Installed `nutshell` commands from the tested install path.
2. Installed `Nutshell.app` copies from `/Applications`, `~/Applications`, and package-manager prefixes.
3. Registered `com.winterfell.nutshell.agent` state.
4. Live `Nutshell` and `NutshellAgent` processes.
5. `~/nutconfig.jsonc`.
6. `~/Nutshell`.
7. Nutshell-related Full Disk Access grants that can be removed without disrupting the current experiment.

After the install command, do not patch the local system by hand except for the user-facing permission action that setup explicitly asks for. If the rehearsal requires a hidden manual fix, the release is not ready.

## Release Notes Contract

Each bugfix release must include release notes with these facts:

1. What user-visible failure was fixed.
2. What root cause was found.
3. What changed in the shipped product.
4. Which install paths were rehearsed from published artifacts.
5. Which real sources synced successfully during smoke testing.
6. Whether reboot persistence was tested.
7. Whether any warnings remained and why they did or did not block the release.
8. Whether the dependency fence changed.

## Resumption Contract

If a future agent resumes release work mid-flight, it must first determine which phase the release is in:

1. Code changed but not certified.
2. Certified locally but not packaged.
3. Packaged but not published.
4. Published but not installed from public artifacts.
5. Installed but not synced.
6. Synced but not reboot-tested.
7. Reboot-tested and ready for release notes.

The resuming agent must not skip ahead based on prior claims. It must re-check the latest worktree state, package version, release artifact, formula SHA, installed command path, app-owned agent state, dashboard health, and sync evidence before declaring the release complete.
