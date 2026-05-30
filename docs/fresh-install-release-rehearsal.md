# Fresh Install Release Rehearsal

This rehearsal proves the released Nutshell artifact works for a real first-time user. It is not a source-tree smoke test. The supported isolation strategy is a disposable macOS VM restored from a known baseline snapshot. Tart or VirtualBuddy are acceptable VM managers. A separate macOS test account is a fallback only if the clean-state verifier passes before install.

The rehearsal has two environments:

1. Host Mac: used only to build/publish releases and create private test seeds such as a safe Apple Podcasts database snapshot.
2. Test Mac: the clean environment where the public artifact is installed and exercised through the normal user flow.

Private seed files must stay outside git. Do not commit Apple Podcasts databases, X archives, Google exports, browser profiles, or rehearsal reports with private account data.

## Host Preflight

Before restoring or creating the test Mac, verify that the host Mac has the ingredients needed for the rehearsal:

```bash
cd /path/to/nutshell
bun run rehearse:preflight-host -- \
  --x-archive /path/to/twitter-archive.zip \
  --youtube-export /path/to/google-or-youtube-export.zip \
  --podcasts-seed /path/to/MTLibrary.sqlite \
  --report ~/fresh-install-host-preflight.json
```

This preflight must pass before a release rehearsal is scheduled. It checks for macOS, Homebrew, a disposable macOS VM manager such as Tart or VirtualBuddy, at least 50 GiB of free disk by default, the official X archive, the official Google/YouTube export, and a SQLite-readable Apple Podcasts seed.

If the team deliberately uses a clean macOS test account instead of a VM, pass `--allow-test-account-fallback`. That only skips the VM-manager check. The test account still must pass the clean-state verifier before install, including no Nutshell install, no Nutshell Full Disk Access grant, and no Google or X cookies in the configured browser profile.

## Baseline

Restore the test Mac to a snapshot with:

1. Homebrew and Chrome installed.
2. No Nutshell command on `PATH`.
3. No `/Applications/Nutshell.app`.
4. No `~/Applications/Nutshell.app`.
5. No `~/nutconfig.jsonc`.
6. No `~/Nutshell`.
7. No loaded `com.winterfell.nutshell.agent`.
8. No Google or X login in the Chrome profile that Nutshell will use.
9. Enough free disk space for the VM image, provider archives, Apple Podcasts seed, release install, and rehearsal logs. Treat less than 50 GiB free as not ready for a full VM rehearsal.

Verify the baseline:

```bash
git clone https://github.com/androidStern/nutshell.git
cd nutshell
bun install
bun run rehearse:verify-clean -- --reset-privacy --report ~/fresh-install-report.json
```

`--reset-privacy` intentionally clears the Nutshell Full Disk Access grant in the disposable environment. Do not run this on a machine whose current Nutshell install you are trying to preserve.

## Podcast Seed

On the host Mac, create a SQLite-safe snapshot of the real Apple Podcasts database:

```bash
cd /path/to/nutshell
bun run rehearse:snapshot-podcasts -- --out ~/NutshellRehearsal/seeds/MTLibrary.sqlite --force
```

Copy that snapshot into the test Mac together with its generated provenance file:

```text
MTLibrary.sqlite
MTLibrary.sqlite.snapshot.json
```

Place the snapshot where the test config will point the Podcasts plugin, or let the orchestrated runner stage it at the test user's normal Apple Podcasts database path.

Do not use `cp` on the live source database as the seed creation method. The snapshot command uses SQLite `VACUUM INTO`, which gives the rehearsal a consistent database image.
The rehearsal rejects a Podcasts seed that does not have the `.snapshot.json` provenance file showing `method: "sqlite_vacuum_into"`.

## Install

Install from the same published path a normal user will use. For the Homebrew path:

```bash
brew install androidStern/nutshell/nutshell
```

Then verify the installed product:

```bash
bun run rehearse:verify-installed -- --report ~/fresh-install-report.json --append
```

The installed command must be on `PATH`, the version must match the release, and health must see the installed app bundle.

## One-Pass Rehearsal Runner

The phase commands above are useful when manually debugging one part of the flow. The release gate should normally use the orchestrated runner:

```bash
bun run rehearse:run -- \
  --reset-privacy \
  --expected-version 0.1.10 \
  --release-id v0.1.10 \
  --install-source androidStern/nutshell/nutshell \
  --x-archive /path/to/twitter-archive.zip \
  --youtube-export /path/to/google-or-youtube-export.zip \
  --podcasts-seed /path/to/MTLibrary.sqlite \
  --report ~/fresh-install-report.json
```

`--reset-privacy` is intentionally required in the disposable test environment so the rehearsal can prove no old Full Disk Access grant is being reused. Do not run that flag on a machine whose current Nutshell install you want to preserve.

The runner performs the same checks in order: local release checks, clean baseline verification, published install, installed-product verification, pre-permission Full Disk Access check, signed-out YouTube and X proof, manual browser-login handoff, authenticated proof, Apple Podcasts seed staging, normal `nutshell setup`, official archive imports, Apple Notes handoff, foreground sync, scheduled background sync, and final dashboard-backed verification.

The report audit requires release identity evidence. Pass `--release-id` for the release tag or artifact identifier being rehearsed. Pass `--install-source` when the public artifact source is not obvious from the install command.

The setup phase must prove the loaded background service is app-owned. The loaded launch agent must resolve to `Nutshell.app/Contents/Library/LaunchServices/NutshellAgent` and must not point at Bun, Terminal, a shell, a repo-local script, `~/.local/bin/nutshell`, or a Homebrew Cellar executable.

The browser-login handoff opens the configured browser, not an arbitrary default browser, so the user signs into the same browser profile that Nutshell will read. The setup phase attaches to the terminal so the normal TUI remains visible. The runner stops on the first failing phase and appends every phase to the report. A successful run ends by auditing the aggregate report so a release cannot pass if any required phase, final source proof, scheduler proof, dashboard proof, or permission proof is missing. Preserve the report after a failure.

The runner refuses to start if the `--report` path already exists. That prevents a retry from mixing an old failed attempt with a new attempt. Use a new report path for each attempt, or pass `--force-new-report` to archive the existing report next to the new one before the run starts.

The install command must identify a published user-facing source. A tapped Homebrew formula such as `brew install androidStern/nutshell/nutshell`, a published package install, or a release URL is acceptable. A local formula file, `bun run src/cli.ts`, a repo-local script, or a path under the development checkout is rejected.

## Signed-Out Proof

Before logging into Google or X in the test Chrome profile, verify signed-out behavior:

```bash
bun run rehearse:verify-unauthenticated -- --report ~/fresh-install-report.json --append
```

This phase must fail YouTube and Twitter as explicit auth failures. Empty successful data is a release blocker.

## Setup And Login

Run setup through the normal product flow:

```bash
nutshell setup
```

Enable the plugins under test. When YouTube and Twitter need browser auth, sign into Google and X in the configured Chrome profile. When the macOS helper opens, grant Full Disk Access to `Nutshell.app`, return to the terminal, and enable the background service from the terminal prompt.

After login, verify browser auth:

```bash
bun run rehearse:verify-authenticated -- --report ~/fresh-install-report.json --append
```

## Official Archive Imports

Run imports only from official provider exports. The orchestrated runner does this automatically when `--x-archive` and `--youtube-export` are provided. Manual phase runs can use:

```bash
nutshell import twitter ~/Downloads/twitter-archive.zip --json
nutshell import youtube ~/Downloads/google-or-youtube-export.zip --json
```

Skip the YouTube import only if the release does not claim YouTube historical import support for this rehearsal. Do not use Hermes archives, BirdClaw databases, old daily JSON files, old Nutshell stores, or handmade fake archives.

## Sync Proof

Run a foreground sync:

```bash
nutshell sync all --json
```

Then wait for one scheduled background sync. The final health check must show a known last sync and a known next sync.

Run the final verifier:

```bash
bun run rehearse:verify-final -- --report ~/fresh-install-report.json --append
```

This verifier checks:

1. `Nutshell.app` is installed.
2. Full Disk Access is granted to `Nutshell.app`.
3. The app-owned agent is enabled.
4. Background sync is enabled.
5. Scheduler last and next sync times are known.
6. Final health is `ok` with no findings. A warning is not a pass.
7. The canonical store has records for YouTube, Apple Podcasts, Apple Notes, and Twitter/X.
8. The canonical store has the expected record shape for each source: YouTube watched or searched activity, `podcast.listened`, Apple Notes note records, and Twitter/X authored/bookmarked/liked/following activity.
9. The foreground sync report proves live source ingestion separately from provider archive imports. Archive-imported records alone do not satisfy the YouTube or Twitter recent-ingestion proof.
10. The report includes record counts and timestamp ranges by source and by record type.
11. The dashboard starts from the installed command and serves trace data.
12. The dashboard API shows trace records for every enabled source in the visible dashboard window.

## Pass Condition

The release rehearsal passes only when every report phase is `pass` and the final report proves records exist for all enabled sources. A warning, unknown scheduler time, stale lock, disabled agent, missing Full Disk Access grant, auth failure, empty dashboard, or zero records for an enabled source is a release blocker.

Audit an existing report explicitly before using it as release evidence:

```bash
bun run rehearse:audit-report -- --report ~/fresh-install-report.json --append
```

The audit must pass. If it fails, the report is incomplete release evidence even if one of the earlier phase commands passed.

If a rough edge appears, preserve `~/fresh-install-report.json` and the Nutshell logs before retrying:

```text
~/Nutshell/logs/
~/fresh-install-report.json
```

## Cleanup And Retry

The normal cleanup procedure is to restore the disposable test Mac to the baseline snapshot. That is the only cleanup path that proves the next attempt is clean.

If a VM snapshot is not available, the fallback cleanup must remove all of the following before `verify-clean` can pass:

1. The installed `nutshell` command.
2. `/Applications/Nutshell.app`.
3. `~/Applications/Nutshell.app`.
4. `~/nutconfig.jsonc`.
5. `~/Nutshell`.
6. Any `*nutshell*.plist` under `~/Library/LaunchAgents`.
7. Any loaded launchd services whose printed user-domain state contains `nutshell`.
8. Google and X cookies from the configured browser profile.
9. The Nutshell Full Disk Access grant, reset with `tccutil reset SystemPolicyAllFiles com.winterfell.nutshell`.

After fallback cleanup, rerun:

```bash
bun run rehearse:verify-clean -- --reset-privacy --report ~/fresh-install-report.json
```

Do not call fallback cleanup equivalent to a clean release rehearsal unless that verifier passes.

Do not repair a failed rehearsal by patching the installed app in place. Fix the product, publish a new artifact, restore the clean baseline, and rerun the rehearsal from the beginning.
