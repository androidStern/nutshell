# Goal: Reproducible Fresh Install Release Rehearsal

## 1. Outcome Statement

Nutshell must have a reproducible release rehearsal that proves a real user can install the published app from a clean macOS environment, complete setup, grant permissions to `Nutshell.app`, enable the app-owned background sync, authenticate the supported browser-backed services, import official provider archives, sync all enabled sources, and view the dashboard with real trace data.

The rehearsal must run in an isolated macOS test environment, preferably a disposable virtual machine restored from a known baseline snapshot. The baseline must not contain an existing Nutshell install, Nutshell config, Nutshell data root, Nutshell launch agent, Nutshell Full Disk Access grant, X cookies, Google cookies, or copied data from prior local systems.

The rehearsal may use the user's own Apple ID inside the test environment. The rehearsal must not require creating a separate Apple ID. Apple Podcasts realism may be achieved by copying a consistent snapshot of the user's Apple Podcasts listening database into the test environment, but that snapshot is test input only. The product must still read it through the normal Apple Podcasts plugin path.

The rehearsal must produce a durable, machine-readable report proving what was installed, which artifact it came from, what clean-state checks passed before install, which setup steps ran, which permissions were granted, which background agent was enabled, which plugins authenticated, which imports ran, which syncs ran, which records were produced, and which dashboard checks passed.

## 2. Acceptance Criteria

1. A documented fresh-install rehearsal flow exists in the repository. A cold-start agent can follow it without relying on this conversation. The documentation names the supported VM or isolation strategy, the baseline state, the seed inputs, the install commands, the setup steps, the sync checks, the dashboard checks, the cleanup procedure, and the generated report path.

2. The rehearsal uses the published install path. Installing by running local source files, invoking `bun run src/cli.ts`, using an unpublished local formula, or manually copying build outputs into place does not satisfy this goal. The install must come from the same public Homebrew or release artifact path that a normal user would use.

3. The rehearsal starts from a clean baseline and verifies that baseline before installation. The verification must prove that `nutshell` is not on `PATH`, `/Applications/Nutshell.app` is absent, the configured Nutshell data root is absent, `~/nutconfig.jsonc` is absent, no Nutshell launch agent is loaded, and the test environment does not already have active X or Google auth cookies in the browser profile that Nutshell will use.

4. The rehearsal must explicitly test the unauthenticated browser state before login. In that state, the YouTube and Twitter checks must fail as auth failures, not as empty successful syncs. This phase must not be counted as a successful product sync. It only proves that the product does not silently treat signed-out browser state as valid data.

5. The rehearsal must then create an authenticated browser state intentionally. The user may sign into Google and X manually in the test browser profile. After login, `nutshell doctor youtube --json` and `nutshell doctor twitter --json` must no longer report auth-cookie-missing or signed-out findings.

6. The rehearsal must test Apple Podcasts with realistic local data. The host-side snapshot step must create a consistent copy of the Apple Podcasts SQLite database using Bun or SQLite-safe backup semantics. A raw copy of a live SQLite file is not acceptable. The copied database and any related private seed files must stay outside git and must never be committed.

7. The copied Apple Podcasts database must be placed in the test environment so the installed product reads it through the normal Apple Podcasts plugin path. A test-only plugin, fake records, direct insertion into Nutshell's canonical store, or reading the host database directly from the test environment does not satisfy this criterion.

8. The rehearsal must prove Apple Podcasts ingestion by producing at least one canonical podcast listen record from the seeded database. The report must include the count of podcast listen records after sync and the timestamp range covered by those records.

9. The rehearsal must prove Apple Notes ingestion with real Notes.app data in the test environment. The test environment must contain at least one accessible note created or visible during the rehearsal, and Nutshell must sync it as an Apple Notes record without relying on old Hermes stores or any local archive from the host.

10. The rehearsal must prove YouTube recent ingestion with real authenticated browser data. The test environment must contain at least one recent YouTube activity item visible to Google My Activity, and Nutshell must sync at least one YouTube record from that authenticated source.

11. The rehearsal must prove Twitter/X recent ingestion with real authenticated browser data. The test environment must contain at least one recent X activity item that the Twitter plugin can access, and Nutshell must sync at least one Twitter record from that authenticated source.

12. The rehearsal must prove official archive import for every archive import feature that the release claims. The Twitter import must use an official X archive export. The YouTube import must use an official Google or YouTube export if the release claims YouTube historical import support. Provider exports are allowed test inputs. Hermes archives, BirdClaw databases, old Nutshell databases, old local daily JSON files, and manually prepared fake archives are not allowed.

13. The setup flow must be exercised through the normal user path. The user may interact with the TUI, the macOS permission helper window, System Settings, browser login pages, and file pickers. The rehearsal must not bypass setup by hand-writing config, directly loading launch agents, directly editing the Nutshell database, or directly granting permissions to a different executable.

14. Full Disk Access must be granted to `Nutshell.app`, not to Bun, Terminal, Codex, a shell, or a temporary build executable. The report must identify the installed app path and the app bundle identifier that received permission.

15. Background sync must be enabled through the app-owned path. The loaded launch agent must point at `Nutshell.app` or the installed app-owned helper, not at a raw Bun command, repo-local script, Terminal shell, or old plist.

16. After setup completes and one foreground sync plus one background-triggered sync have run, `nutshell health --json` from the installed command must report the app installed, background agent enabled, Full Disk Access granted, no active stale lock, a known last sync timestamp, and a known next sync timestamp.

17. The dashboard must be opened from the installed command. The dashboard must show health/status data, source cards, and actual trace records for YouTube, Apple Podcasts, Apple Notes, and Twitter/X. It is not enough for the dashboard server to start with empty data.

18. The rehearsal must generate a report at a documented path such as `dist/rehearsal/fresh-install-report.json`. The report must include the installed Nutshell version, install source, git tag or release identifier, clean-state check results, plugin auth results, import results, sync results, record counts by source, background agent status, dashboard URL, and links or paths to logs captured during the run.

19. A release cannot be marked deliverable if the rehearsal requires undocumented manual intervention, hidden local files, old machine-specific stores, old launch agents, old auth cookies, or commands outside the public user-facing flow.

20. If any rough edge appears during the rehearsal, the agent must stop and record it as a product or release-process bug before declaring the release tested. A workaround may be documented for diagnosis, but a workaround is not a pass.

## 3. Anti-Patterns To Avoid

1. Do not test on the developer's dirty host machine and call it clean. That appears fast, but existing app permissions, launch agents, browser cookies, data roots, and old installs can hide broken onboarding and broken scheduling.

2. Do not treat a warning, critical health result, or empty sync as acceptable because the message is understandable. The release rehearsal exists to prove the system actually installs, authenticates, syncs, and displays data.

3. Do not bypass browser auth by reusing old Chrome cookies from the host. The test must prove both signed-out behavior and intentional signed-in behavior in the test environment.

4. Do not grant Full Disk Access to the wrong executable. Granting access to Bun, Terminal, Codex, or a repo-local executable can make a local test pass while the installed background app fails for users.

5. Do not read or import Hermes, BirdClaw, old listening-history archives, old Nutshell stores, old plists, or any other historical system from the host. Those paths are machine-specific shortcuts and violate the portability goal.

6. Do not copy a live SQLite database with `cp` while Apple Podcasts may be writing to it. That can create a corrupt or inconsistent test seed. Use a SQLite-safe snapshot method.

7. Do not commit private seed data. Apple Podcasts databases, official X archives, Google exports, browser profiles, logs containing account identifiers, and screenshots containing private data must stay untracked.

8. Do not add new product runtime dependencies to make the rehearsal easier. Any new dependency outside the currently approved dependency set must be explicitly justified and approved before implementation.

9. Do not invent hidden CLI commands for the rehearsal. The rehearsal should use public commands and external test harness scripts. If a command is not appropriate for normal users, it should not become part of the normal CLI surface.

10. Do not mock plugins, seed canonical records directly, or special-case the test inputs. The goal is to prove the installed product path, not to prove that a fake store can be populated.

## 4. Blast Radius

1. The public user experience must be preserved. The normal user should still interact with `nutshell setup`, `nutshell sync`, `nutshell health`, `nutshell doctor`, `nutshell import`, and `nutshell dashboard`. The rehearsal may add test harness scripts or documentation, but it must not expand the normal CLI surface with release-only implementation commands.

2. Plugin encapsulation must be preserved. Core setup may orchestrate plugin checks and setup callbacks, but it must not learn source-specific auth details for YouTube, Twitter, Apple Notes, or Apple Podcasts as part of the rehearsal work.

3. App-owned background sync must be preserved. Any fix discovered during rehearsal must continue to launch background sync through the installed app bundle or app-owned helper, not through a shell, Terminal, Bun, Codex, or a repo-local script.

4. Provider archive rules must be preserved. Historical import may use official provider exports only. The rehearsal must not reintroduce migrations from Hermes, BirdClaw, old local archives, or other machine-specific systems.

5. Existing automated tests must be preserved or strengthened. Failing tests must not be deleted, weakened, or skipped to make the release rehearsal pass.

6. Private local data must remain local. The rehearsal may use untracked local seed inputs, but the repository must not gain committed private databases, archives, browser profiles, account identifiers, or logs.

7. The dashboard and health output may be used as verification surfaces, but their product behavior should not be changed unless the rehearsal exposes a concrete bug.

## 5. Architectural Context

Nutshell is a local personal trace ingestion system distributed as a Bun/TypeScript CLI plus a macOS app bundle. The CLI is the user entrypoint. The app bundle is the permission-bearing background owner on macOS. The plugins own their own auth, setup, import, sync, and health checks. The runtime coordinates plugins, commits records to the canonical store, manages locking, runs projections, and reports health.

The fresh-install rehearsal must sit outside the product runtime. It is a release validation harness, not another ingestion subsystem. Its job is to prepare an isolated machine, install the published artifact, drive the normal user flow, provide user-approved seed inputs, and collect proof. It must not become a second implementation path for syncing.

The browser-backed plugins currently depend on browser session state. A clean release rehearsal therefore needs two browser states: first, a signed-out state that proves auth failures are detected; second, a signed-in state that proves real sync works after the user logs in. The rehearsal must not collapse those two states into one.

Apple Podcasts is different from browser-backed sources because Nutshell reads a local SQLite library database. A realistic test can use a snapshot of the user's actual Apple Podcasts database, copied into the isolated environment as test seed data. The installed product must still read the database through the same local path or configured plugin path it uses for normal users.

Apple Notes is different from Apple Podcasts because Notes.app access is mediated by macOS automation and app permissions. The rehearsal should use Notes.app inside the test environment with at least one accessible real note. It must not import notes from old Hermes mirrors or markdown exports.

Official provider exports are allowed for historical backfill. The X archive and Google/YouTube export are direct provider artifacts and are valid release-test inputs. Old local stores are not provider artifacts and are not valid release-test inputs.

## 6. Scope Boundary

This goal does not require creating a second Apple ID. The user may sign into the test environment with the user's own Apple ID if iCloud or Notes sync is needed.

This goal does not require fully automating Apple ID login, Google login, or X login. Those steps may remain manual because they are user-authentication steps. The rehearsal must make them explicit, bounded, and repeatable.

This goal does not require building a cloud CI fleet for macOS. A local disposable macOS VM or an equivalently isolated macOS test account is acceptable if it can be restored to a clean baseline and if the clean-state checks are automated.

This goal does not require solving unrelated product-health issues such as Apple Notes backlog convergence, Twitter enrichment throughput, dashboard polish, or noisy health copy unless those issues prevent the fresh-install rehearsal from passing.

This goal does not require storing private test seeds in the repository. The repository should document where local seed files live and how to recreate them, but private seed files must remain untracked.

This goal does not permit new migration paths from old local systems. If a future agent believes migration support is needed, that must be proposed as a separate goal and must not be added to this release rehearsal.

## 7. Verification Strategy

1. Before running the fresh-install rehearsal, run the normal local release checks from the source tree: `bun run typecheck`, `bun test`, `bun run lint`, `bun run build:compile`, and `bun run certify:release`. If any command fails, the release rehearsal must not proceed.

2. Publish or identify the release artifact that a real user will install. The rehearsal must record the artifact source, release tag, package version, formula source, and installed binary path.

3. Restore the macOS test environment to its baseline snapshot. Run the clean-state verifier before installing anything. The verifier must fail if it finds a Nutshell binary, app bundle, data root, config file, launch agent, Full Disk Access grant, or active Google/X auth state in the configured browser profile.

4. Install Nutshell from the public release path. Verify that `which nutshell` points to the installed command, `nutshell --version` matches the released version, and the installed app bundle path exists.

5. Run `nutshell setup` through the normal user path. During setup, first prove unauthenticated YouTube and Twitter checks fail as auth failures. Then sign into Google and X in the configured browser profile and prove the plugin doctors pass.

6. Grant Full Disk Access only to `Nutshell.app` through the macOS permission helper flow. Enable background sync through the normal setup flow. Verify that the launch agent is loaded and points at the installed app-owned target.

7. Provide test seed inputs. Place the official X archive and official Google/YouTube export where the setup/import flow can select them. Place the Apple Podcasts SQLite-safe snapshot in the test environment so the normal Apple Podcasts plugin can read it. Create or expose at least one accessible Apple Note in Notes.app.

8. Run the normal import and sync flows. Use `nutshell import twitter <official-x-archive.zip> --json` for X historical import. Use `nutshell import youtube <official-google-export.zip> --json` if YouTube historical import is part of the release. Run `nutshell sync all --json` from the installed command. Wait for one scheduled background sync and verify that it records a known last sync and next sync.

9. Verify record production. The canonical store must contain at least one record for YouTube, Apple Podcasts, Apple Notes, and Twitter/X. The report must include counts by source and enough timestamps to prove the records came from the current rehearsal inputs.

10. Open the dashboard from the installed command and verify that it displays the synced records and status for all enabled sources. Capture a screenshot or browser-check artifact and reference it from the rehearsal report.

11. Run `nutshell health --json` from the installed command after foreground and background syncs. The report must include the full health JSON. Unknown last sync, unknown next sync, stale lock, missing app, missing access, disabled agent, auth failures, or zero records for enabled sources are release blockers.

12. Save the final rehearsal report and relevant logs under the documented report directory. The final answer for a release test must name the report path and summarize pass/fail by source.

## 8. Resumption Contract

A resuming agent must first determine whether a previous rehearsal is in progress, failed, or complete. The agent must inspect the documented report directory, the VM baseline state, the installed Nutshell version inside the test environment, and any untracked seed directory before taking action.

If a previous rehearsal failed, the resuming agent must preserve the failure report and logs before cleaning or retrying. The resuming agent must not overwrite evidence of a failed release test.

If the test environment is not at the baseline snapshot, the resuming agent must restore or recreate the baseline before claiming a clean install. Manual deletion from the host machine is not a substitute for the clean baseline unless the clean-state verifier proves every required clean condition.

If private seed files are missing, the resuming agent must stop and state which seed input is missing. It must not replace missing real inputs with fake records, old local stores, or committed fixtures.

If an installed version is older than the release being tested, the resuming agent must remove the old install in the test environment, restore the baseline, and reinstall from the published artifact. It must not patch the installed app in place.

If the rehearsal exposes a product bug, the resuming agent must record the bug, stop the release-test claim, and only then decide whether to implement a fix under a separate goal. A passing rehearsal is only valid when the installed released product completes the documented flow without hidden local dependencies or undocumented workarounds.
