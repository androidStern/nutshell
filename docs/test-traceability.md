# Test Traceability Audit

Audit date: 2026-06-10. Satisfies honest-setup #21: every test in `test/*.test.ts` traces to an
acceptance criterion (this goal or a predecessor) or a documented invariant. Unanchored tests were
rewritten or removed with the reason recorded here; nothing was removed merely to green the suite.

Out of scope (created concurrently, audited by their own layer): `test/state-matrix.test.ts`,
`test/golden-journeys.test.ts`, `test/helpers/**`.

## Reference keys

| Key | Source |
| --- | --- |
| honest-setup #N | `setup-onboarding-and-feedback-loops-goal.md` §7 criterion N (§8 = no-go list) |
| truthful-baseline #N | `nutshell-truthful-product-baseline-goal.md` §2 criterion N |
| drift-fix #N | `nutshell-architecture-drift-fix-goal.md` §2 criterion N |
| onboarding §X | `onboarding-refactor-goal.md` named section (unnumbered criteria) |
| auto-enrich #N | `twitter-enrich.md` §2 criterion N |
| x-enrichment | `tweet-refactor.md` (tweet enrichment cache + display contract) |
| enrich-idempotency | `tweet-refactor-v2.md` (reimport must not resurrect terminal enrichment; generic record reader) |
| dashboard goal | `dash.md` |
| gates doc | `docs/release-validation-gates.md` (incl. six-state taxonomy), `docs/fresh-install-release-rehearsal.md` |
| store-identity invariant | records unique by source/kind/type/sourceId; observations unique by source/fingerprint; CAS checkpoints (truthful-baseline §4.6, drift-fix #25) |
| no-unbounded-waits invariant | honest-setup §8: no polling-for-login, no unbounded waits, bounded probes/budgets |
| regression: X | guards a previously shipped bug; no goal criterion, but behavior is a promise users hit |

## test/app-status.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| app-owned core commands do not recursively open another app instance | truthful-baseline #15; regression: app handoff recursing inside app identity | anchored |
| app status parser preserves app-owned permission and agent states | truthful-baseline #12; drift-fix #15 | anchored |
| app discovery ignores stale configured paths when an installed app exists | truthful-baseline #13; drift-fix #16 | anchored |
| app discovery prefers the current Homebrew app over an older configured Cellar app | truthful-baseline #13; drift-fix #16 | anchored |
| stable app installer promotes the current Homebrew app into user Applications | truthful-baseline #14 | anchored |
| stable app installer refreshes an older stable app from the current Homebrew app | truthful-baseline #14; regression: stale stable app after brew upgrade | anchored |

## test/apple-notes.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| apple notes fixture sync emits note records and artifacts | onboarding §Apple Notes; truthful-baseline §4 blast-radius 9 (fixture parsing preserved) | anchored |
| apple notes automation denial returns an explicit permission finding | truthful-baseline #16; honest-setup #10 | anchored |
| apple notes health probe fails closed on automation denial | drift-fix #18; truthful-baseline #16 | anchored |
| apple notes health probe reports non-permission failures as access failed | onboarding §Apple Notes (classify denial vs timeout); honest-setup #6 | anchored |
| apple notes health probe uses lightweight app access when available | honest-setup §3 (bounded real probe, not full scan) | anchored |
| apple notes stops body export cleanly when the run budget is exhausted | no-unbounded-waits invariant (SyncBudget); honest-setup #10 | anchored |
| apple notes prioritizes never-exported notes before previously failed body exports | regression: failed bodies starving never-exported notes (convergence) | anchored |
| apple notes does not rewrite unchanged note artifacts | store-identity invariant (idempotent re-sync, no artifact churn) | anchored |
| apple notes drains body backlog across safe chunks within one run | regression: body backlog never converging in one run | anchored |
| apple notes splits oversized body exports into safe chunks | regression: oversized AppleScript body batches failing | anchored |
| apple notes partial runs do not tombstone missing notes | store-identity invariant (partial run must not destroy state) | anchored |
| apple notes parses bulk AppleScript metadata rows | truthful-baseline §4 blast-radius 9 (plugin fixture parsing preserved) | anchored |
| apple notes parses AppleScript body rows | truthful-baseline §4 blast-radius 9 | anchored |

## test/browser-cookies.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| macOS Chrome reader decrypts cookies with supplied Safe Storage password | honest-setup §8 (no password files; app-provided password bridge, v0.1.22) | anchored |
| browser cookie reader uses app-provided Chrome Safe Storage password on macOS (skipIf non-darwin) | honest-setup §8; honest-setup #2 (probe through app identity) | anchored |
| macOS Chrome reader reports a bounded Keychain timeout | no-unbounded-waits invariant; regression: unbounded Keychain hang fixed in v0.1.22 | anchored |
| macOS Chrome reader can use a bounded Keychain password result | no-unbounded-waits invariant | anchored |

## test/cli-surface.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| help exposes only the minimal product CLI | truthful-baseline #1; drift-fix #1; honest-setup #17 | anchored |
| old machine-specific commands are not accepted | truthful-baseline #2; drift-fix #2 | anchored |
| version command uses the public nutshell name | duplicate-weaker of "version command matches package version" (exact match subsumes name prefix) | removed |
| version command matches package version | drift-fix §1 outcome 4 (public surface incl. `version`); regression: binary/package version drift | anchored |
| packaged macOS protected commands hand off to Nutshell.app | truthful-baseline #15; drift-fix §1 outcomes 1–2 | anchored |
| subcommand help is side-effect free | truthful-baseline #2 (no side effects); honest-setup #17 (help is static, no I/O) | anchored |
| invalid numeric flags fail before runtime state is created | truthful-baseline #2 (usage failure without side effects) | anchored |

## test/config.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| default config is JSONC and points storage at the Nutshell data root | onboarding §Config Draft (`nutconfig.jsonc`, data root) | anchored |
| root can be resolved from nutconfig.jsonc without a command-line root | onboarding §Config Draft; truthful-baseline §4 blast-radius 10 (no machine-specific defaults) | anchored |

## test/dashboard.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| dashboard status API uses app-owned health and config model | truthful-baseline #11; drift-fix #9 | anchored |
| dashboard status API exposes the next scheduled background sync before the first source run | drift-fix §1 outcome 6 (health/dashboard same truth); regression: unknown next sync before first run | anchored |
| dashboard days API returns deterministic grouped records and truncated note excerpts | dashboard goal (day view contract) | anchored |
| dashboard renders Twitter cards from cached enrichment without widget network code | x-enrichment (no render-time fetch; normalized display payloads) | anchored |
| dashboard diagnostics and config APIs redact secret-looking local data | truthful-baseline #24; drift-fix #23 | anchored |
| dashboard config save validates and creates a backup before writing | dashboard goal (safe controls) | anchored |
| dashboard config validation failure does not write | dashboard goal; fail-fast invariant (no partial config writes) | anchored |
| dashboard raw config save treats placeholder text as ordinary local config | regression: redaction placeholder blocking legitimate config saves | anchored |
| dashboard sync action uses runtime plugins and returns source status | dashboard goal (safe controls through runtime) | anchored |
| dashboard server starts on a local port without opening a browser (skipIf no localhost bind) | dashboard goal CLI contract (`--no-open`, local HTTP); honest-setup #26 | anchored |
| compiled dashboard binary includes bundled UI assets when binary exists | dashboard goal (distributable single binary, no dev server) | anchored |

## test/doctor-output.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| a missing-FDA root cause leads and collapses downstream permission findings into one line | honest-setup #12 | anchored |
| a single blocked source check renders the singular caused-by line | honest-setup #12 | anchored |
| without a prerequisite root cause, permission findings render normally with fix/then lines | honest-setup #11, #12 | anchored |
| pending backfill renders the standing line with the exact import command | honest-setup #16 | anchored |
| completed backfill renders the complete line | honest-setup #16 | anchored |
| doctor resolves the x alias to twitter on the real binary | honest-setup #13 | anchored |
| doctor with an unknown source exits nonzero and lists valid sources | honest-setup #13 | anchored |

## test/finding-guidance.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| every spec carries a valid state, a concrete fix, and a runnable confirm command | honest-setup #10; §9 (no "see docs" boilerplate) | anchored |
| codes are unique across all catalogs | honest-setup #10 (fix authored once at the source) | anchored |
| make() attaches guidance derived from the spec | honest-setup #10 | anchored |
| health/doctor text (renders fix+confirm for every emittable problem finding) | honest-setup #11 | anchored |
| sync text | honest-setup #11, #14 | anchored |
| setup summary | honest-setup #11 | anchored |
| dashboard payload preserves guidance through JSON serialization | honest-setup #11 | anchored |
| dashboard frontend renders guidance fix and confirm | honest-setup #11 | anchored |
| setup config persistence round-trips guidance | honest-setup #5, #11 (stored finding keeps its fix) | anchored |
| no raw finding construction outside catalog modules | honest-setup #10 (enforcement: findings must come from catalogs) | anchored |

## test/fresh-install-rehearsal.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| clean-state verifier fails on reused local Nutshell state | gates doc (clean preflight); honest-setup §8 (no dirty VMs/fixtures) | anchored |
| clean-state verifier rejects leftover browser auth cookies | gates doc (clean preflight) | anchored |
| clean-state verifier rejects stale Nutshell launch agent plists | gates doc; drift-fix #7 (no raw launchd remnants) | anchored |
| clean-state verifier treats missing Full Disk Access bundle as clean | gates doc; regression: tccutil "no such bundle" misread as failure | anchored |
| unauthenticated verifier requires source-specific auth failures | gates doc (signed-out gate); honest-setup #6 | anchored |
| authenticated verifier classifies cookies plus keychain timeout as product bug | honest-setup #6 (signed-in-but-keychain-blocked is blocked_bug, not needs_auth); gates doc | anchored |
| authenticated verifier classifies unreadable cookies plus keychain timeout as product bug | honest-setup #6; gates doc | anchored |
| authenticated verifier ignores unrelated system permission findings | gates doc (auth-gate scoping); regression: harness failed auth gate on missing FDA (PROGRESS 20260610b) | anchored |
| source-state classifier separates auth permission empty data and records | gates doc six-state taxonomy; honest-setup §3 | anchored |
| podcast snapshot uses SQLite and produces a readable copy | gates doc (Podcasts seed DB provenance); honest-setup §8 (no dirty fixtures) | anchored |
| host preflight passes when the release rehearsal inputs are present | gates doc (host preflight) | anchored |
| host preflight fails before a rehearsal when required host inputs are missing | gates doc (fail before, not during) | anchored |
| local provider import gate requires official inputs and canonical records without VM UI | honest-setup #22 (CLI-only gates); truthful-baseline #5 | anchored |
| local provider import gate rejects a missing YouTube export | gates doc; truthful-baseline #28 (no proof, no pass) | anchored |
| final verifier fails when scheduler times are unknown or a source has no records | gates doc (live-sync/dashboard gate); honest-setup #26 | anchored |
| final verifier rejects warning health even when required records exist | gates doc (final state must be clean) | anchored |
| aggregate report audit fails when a required phase is missing | gates doc (evidence contract) | anchored |
| aggregate report audit fails when final dashboard proof is incomplete | gates doc; honest-setup #26 | anchored |
| aggregate report audit fails when provider import proof is incomplete | gates doc | anchored |
| aggregate report audit accepts declared auth seed restore instead of repeated browser login | gates doc (auth-present snapshot path) | anchored |
| aggregate report audit rejects both manual browser login and auth seed restore in one final report | gates doc (one auth path per rehearsal) | anchored |
| aggregate report audit rejects browser login before setup | gates doc (release-flow order) | anchored |
| aggregate report audit rejects diagnostic actions as release proof | honest-setup #22 (no side-channel pass evidence) | anchored |
| aggregate report audit rejects skipped checks in a final report | gates doc; honest-setup §8 (no skipping to green) | anchored |
| aggregate report audit fails when podcast seed staging proof is incomplete | gates doc | anchored |
| aggregate report audit fails when release identity evidence is missing | gates doc (evidence contract) | anchored |
| aggregate report audit fails when final health JSON evidence is missing | gates doc | anchored |
| aggregate report audit fails when installed app path evidence is missing | gates doc; truthful-baseline #14 | anchored |
| aggregate report audit passes only when every release rehearsal proof is present | gates doc; honest-setup #30 (`rehearse:audit-report`) | anchored |
| full rehearsal runner refuses to mix a new attempt into an existing report | honest-setup §8 (no building on dirty failed-rehearsal state) | anchored |
| append report preserves an existing single-phase report | gates doc (phased report tooling contract) | anchored |

## test/google-takeout-youtube.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| google takeout youtube import commits official archive evidence and can close the historical gap | truthful-baseline #5; drift-fix #24; onboarding §Archive Import | anchored |
| google takeout youtube import accepts a direct Data Portability JSON object | onboarding §YouTube (validate Takeout/Data Portability formats) | anchored |

## test/health.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| health marks configured cutoff coverage complete when records reach the cutoff | onboarding §Health (coverage vs configured cutoff) | anchored |
| health reports incomplete coverage without provider export or current-source records | honest-setup #16; onboarding §Health (coverage info, not failure) | anchored |
| health includes the latest source finding when a recent run is partial | onboarding §Health; truthful-baseline §1 (no quiet fake success) | anchored |
| health treats initial partial backfill convergence as warning, not critical | regression: normal convergence flagged critical | anchored |
| health does not present stale source findings after a newer successful run | honest-setup §3 (auth state measured, never stored); regression: stale findings after recovery | anchored |
| health reports stale runtime locks as critical | onboarding §Health (stale locks); honest-setup #10 | anchored |
| health reports degraded setup state without running the plugin probe | onboarding §Degraded Plugin Policy (show degraded reason; no hammering) | anchored |
| health reports app-owned background and permission status | truthful-baseline #10; drift-fix #8 | anchored |
| health reports the next background sync from the agent log before any source run exists | drift-fix #8; regression: unknown scheduler state before first run | anchored |
| source-scoped health runs only the requested plugin probe | truthful-baseline #23; drift-fix #10 | anchored |
| health uses app-owned run history for local OS sources instead of terminal probes | honest-setup #2 (probes execute through app identity); truthful-baseline §3.5 | anchored |
| health warns when a local OS source has not yet run through the app | truthful-baseline §3.2 (missing proof is not ok) | anchored |
| health probes local OS sources directly when running inside the app identity | honest-setup #2 | anchored |
| backfillStatusFromStore reports the same coverage as a full health evaluation | honest-setup §3 (same probe/same truth on every surface) | anchored |

## test/identity.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| stable fingerprints ignore object key order | store-identity invariant | anchored |
| youtube fingerprint is stable for identical activity | store-identity invariant (no duplicate accumulation across overlap windows) | anchored |
| youtube event identity keeps repeated URL events distinct by activity detail | store-identity invariant; regression: repeated watches collapsed into one event | anchored |
| podcast identity prefers guid and includes listen time | store-identity invariant | anchored |
| twitter timestamps reject Unix epoch placeholders | regression: 1970 epoch placeholders polluting the timeline | anchored |

## test/install-script.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| tarball installer copies CLI and app without removed commands | drift-fix #3, #4; truthful-baseline #14 | anchored |
| homebrew packaging does not define raw protected-data service | drift-fix #5; truthful-baseline #15 | anchored |

## test/podcasts.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| podcasts health check probes the local database schema | truthful-baseline #17 | anchored |
| podcasts health check reports schema drift | truthful-baseline #17; honest-setup #10 | anchored |
| podcasts health check reports a missing database with guidance | truthful-baseline #17; honest-setup #10 | anchored |
| podcasts recent sync reports a missing database as podcasts_db_missing | truthful-baseline #17 | anchored |
| podcasts health check can use an alternate database path | onboarding §Apple Podcasts (open current Podcasts DB); regression: containerized DB path | anchored |
| podcasts recent sync can read from an alternate database path | onboarding §Apple Podcasts; regression: containerized DB path | anchored |

## test/runtime.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| runtime runs fake plugin through lock, store, and projection | truthful-baseline §7.7 (runtime/store path); store-identity invariant | anchored |
| runtime automatically enriches after a successful source sync commit | auto-enrich #1, #3, #4 | anchored |
| runtime preserves normal sync commit when automatic enrichment fails | auto-enrich #2, #8 | anchored |
| runtime does not run automatic enrichment when source sync fails before commit | auto-enrich #7 | anchored |
| runtime dry-run sync does not run automatic enrichment or mutate the store | auto-enrich #9; truthful-baseline #20 | anchored |
| runtime plugin context exposes a generic canonical record reader | enrich-idempotency (approved design: generic read API) | anchored |
| runtime refreshes projections after import and enrichment mutations | drift-fix #25 (projections are disposable views, refreshed after commit) | anchored |
| scheduled sync probes a degraded plugin and skips when the probe still fails | honest-setup #15 | anchored |
| scheduled sync self-heals a degraded plugin when the probe passes | honest-setup #15 | anchored |
| scheduled sync backs off rate-limited sources instead of probing | honest-setup §5 (rate-limit findings follow backoff, not probing) | anchored |
| a scheduled sync failing on auth marks the source degraded for the next run | honest-setup §5; onboarding §Degraded Plugin Policy | anchored |
| sync dry-run blocks artifact writes before filesystem mutation | drift-fix #11; truthful-baseline #20 | anchored |
| provider import dry-run blocks artifact writes and leaves store untouched | drift-fix #12; truthful-baseline #20 | anchored |

## test/secret-store.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| secret store isolates plugin namespaces and writes with strict file modes | onboarding §Secret Store (0700/0600, namespace isolation) | anchored |
| secret store commits are atomic at the plugin namespace interface | onboarding §Secret Store (atomic writes) | anchored |
| secret store recovers stale lock files | onboarding §Secret Store (file locking) | anchored |
| secret store reports a live lock instead of corrupting writes | onboarding §Secret Store; fail-fast invariant | anchored |
| redaction removes secret-looking fields and inline token strings | truthful-baseline #24; onboarding §Secret Store (redaction) | anchored |

## test/setup-runtime.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| setup permission handoff timeout defaults to a real user window and can be overridden | no-unbounded-waits invariant (bounded, user-scale permission handoff) | anchored |
| setup marks selected plugins ready without source-specific core steps | onboarding §Core Setup Runtime; honest-setup #18 | anchored |
| setup isolates a degraded plugin and keeps other selected plugins ready | truthful-baseline #6; onboarding §Setup Flow (continue after one plugin fails) | anchored |
| setup enforces a core-owned timeout around plugin setup | no-unbounded-waits invariant; honest-setup #10 (timeout finding carries guidance) | anchored |
| setup preserves disabled as a user choice distinct from degraded | onboarding §Product Decisions (disabled ≠ degraded) | anchored |
| setup can skip archive import without creating pending state | onboarding §Archive Import; honest-setup §8 (no pending-import state) | anchored |
| setup can run a plugin-owned archive import immediately | onboarding §Archive Import; truthful-baseline #6 | anchored |
| cancelled setup does not commit the config draft | honest-setup #9; onboarding §Config Draft | anchored |
| setup does not mark plugins ready when secret commit fails | truthful-baseline #7; drift-fix #13 | anchored |
| setup asks a plugin for its summary exactly once | truthful-baseline #8; drift-fix #14 | anchored |
| setup records protected sources as degraded instead of probing them in-process when the app is missing | honest-setup #2 (app missing is the honest root cause; no terminal-identity probing) | anchored |
| setup enables background sync through the installed app helper | onboarding §Background Agent Handoff; truthful-baseline #15 | anchored |
| setup opens the app permission window before any plugin probe and before enabling background sync | honest-setup #2 (ordering) | anchored |
| setup refuses to claim handoff when app-owned status stays disabled | onboarding §Background Agent Handoff (failure explicit); truthful-baseline §1 | anchored |
| setup runs one bounded smoke sync through the app identity and reports its real result | honest-setup #8 | anchored |
| a smoke sync that fails to run is reported honestly and degrades the setup report | honest-setup #8 (failure appears; exit 1) | anchored |
| declining the background service skips the smoke sync with an honest message | honest-setup §4.5–6 (smoke sync only when agent enabled) | anchored |
| an already-imported archive renders imported and is not re-offered | honest-setup #7 | anchored |
| setup retries a failing probe and records ready only after it passes | honest-setup #3, #4 | anchored |
| skipping a failing probe records degraded with the probe finding and exits 1 | honest-setup #5 | anchored |
| the probe loop opens the guidance url and re-verifies on the open-and-retry choice | honest-setup §3 (retry may open a URL; no polling) | anchored |
| a plugin whose probe always fails is never recorded ready | honest-setup §8 no-go 1 (no ready without passing probe) | anchored |
| a third-party plugin with its own verify completes fail-retry-pass through the generic loop | honest-setup #18; onboarding §Third-Party Plugins | anchored |
| re-run setup reviews current truth and walks only failing sources through the loop | honest-setup #1 | anchored |
| re-run setup exit records review truth without walking the plugin loop | honest-setup #1; §4 re-run behavior | anchored |
| a probe that never resolves is bounded by the core timeout and recorded honestly | no-unbounded-waits invariant; honest-setup #4 | anchored |

## test/store.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| store commit is idempotent for records and observations | store-identity invariant | anchored |
| store query filters by sourceIds as a generic record field | enrich-idempotency (generic read API; no Twitter semantics in store) | anchored |
| store persists finding guidance and surfaces it in the health snapshot | honest-setup #10 (guidance survives persistence) | anchored |
| store migration adds guidance_json to databases created before the column existed | drift-fix §4 blast-radius 8 (migrations tested, no record loss) | anchored |

## test/sync-reporter.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| formatSyncText renders skipped sources first with fix/then guidance lines | honest-setup #14 | anchored |
| formatSyncText renders per-source lines and the final status for an all-ok report | honest-setup §5 (foreground sync surface) | anchored |
| formatSyncText renders problem findings with guidance under a degraded source line | honest-setup #11, #14 | anchored |

## test/twitter-plugin.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| twitter backfill refuses live transport and requires official X archive import | truthful-baseline #5; drift-fix #24; onboarding §Twitter/X | anchored |
| twitter finding catalog attaches actionable guidance to every code | duplicate-weaker of finding-guidance "every spec carries a valid state, a concrete fix, and a runnable confirm command" (iterates all plugin catalogs incl. TWITTER_FINDINGS with stronger assertions) | removed |
| twitter auth check fails closed even when account identity is configured | truthful-baseline #19; drift-fix #19 | anchored |
| twitter health probe reports Chrome Safe Storage as a permission block | honest-setup #6 (keychain block is needs_permission, never needs_auth) | anchored |
| twitter health probe reports signed-out sessions as needs_auth | honest-setup #6 | anchored |
| twitter health probe reports non-auth session check failures as blocked bug | honest-setup #6 | anchored |
| twitter health probe reports rate limits without a duplicate session finding | honest-setup §5 (one deduped finding); onboarding §Twitter/X (classify rate limits) | anchored |
| twitter internal timeout override fails closed when Bird library shape changes | drift-fix #21 | anchored |
| twitter recent sync skips fresh following snapshots during scheduled all-collection runs | onboarding §Degraded Plugin Policy spirit (no provider hammering); bounded scheduled collection | anchored |
| twitter recent sync forces following snapshot when explicitly requested | counterpart of TTL skip: explicit collection request overrides freshness (plugin collection contract) | anchored |
| twitter recent sync caps scheduled page walks | no-unbounded-waits invariant (bounded page budget) | anchored |
| twitter recent seed establishes likes baseline without timeline events | regression: first likes sync flooding the timeline with fake same-day events | anchored |
| twitter recent collection events stay on the collection sync day | x-enrichment (timeline truthfulness: tweet date vs collection date) | anchored |
| twitter recent sync does not refresh known like events into today | regression: known likes re-dated to today on every run | anchored |
| twitter live sync enqueues tweet enrichment and writes display payloads | x-enrichment (required data flow) | anchored |
| twitter live sync skips terminal enrichment records and keeps retryable targets | enrich-idempotency | anchored |
| twitter live sync merges duplicate primary, quoted, and reply enrichment targets | x-enrichment (one Twitter-owned queue, deduped) | anchored |
| twitter enrichment queue lookup handles large mixed terminal and retryable batches | regression: SQLite parameter-limit breakage on large queues (batches ≤ 400) | anchored |
| twitter enrichment stores cached tweet display data and clears completed queue items | x-enrichment | anchored |
| twitter enrichment rate limits stop the current run and schedule retry | auto-enrich #5 | anchored |
| generic runtime and store modules do not encode twitter enrichment semantics | enrich-idempotency (plugin boundary); honest-setup §8 (no source-specific core) | anchored |
| production twitter paths do not shell out to Bird CLI or BirdClaw | truthful-baseline #4; drift-fix #20 | anchored |

## test/x-archive-import.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| x archive import commits official archive records | truthful-baseline #5; onboarding §Archive Import | anchored |
| x archive import flags a bad archive path with import guidance | onboarding §Import flow (validation failure explicit); honest-setup #10 | anchored |
| scheduled twitter sync drains queued enrichment by configured limit | auto-enrich #3, #4 | anchored |
| scheduled twitter enrichment stops immediately on rate limit and persists retry state | auto-enrich #5 | anchored |
| scheduled twitter enrichment commits successes while keeping temporary failures queued | auto-enrich #6 | anchored |
| scheduled twitter sync dry-run leaves queued enrichment untouched | auto-enrich #9; truthful-baseline #20 | anchored |
| x archive reimport does not resurrect terminal enrichment queue items | enrich-idempotency (the bug that goal exists for) | anchored |
| x archive reimport skips terminal statuses but preserves retryable statuses | enrich-idempotency | anchored |

## test/youtube-plugin.test.ts

| Test | Traces to | Verdict |
| --- | --- | --- |
| youtube recent sync uses My Activity overlap and emits canonical events | drift-fix §6 (collection technique preserved); store-identity invariant | anchored |
| youtube historical backfill refuses live collection and requires official Google export import | truthful-baseline #5; onboarding §YouTube | anchored |
| youtube health probe fails closed on unexpected empty access | truthful-baseline #18; drift-fix #17 | anchored |
| youtube health probe reports collector auth exceptions instead of crashing | truthful-baseline #18; honest-setup #6 (needs_auth classification) | anchored |
| youtube health probe reports Chrome Safe Storage as a permission block | honest-setup #6 | anchored |

## Removals

| Test | File | Reason |
| --- | --- | --- |
| version command uses the public nutshell name | test/cli-surface.test.ts | Duplicate coverage with strictly weaker assertion: "version command matches package version" asserts exact `nutshell <pkg.version>` output, which subsumes the name-prefix check. No promise is lost. |
| twitter finding catalog attaches actionable guidance to every code | test/twitter-plugin.test.ts | Duplicate coverage with strictly weaker assertions: finding-guidance's catalog test iterates every plugin catalog (including TWITTER_FINDINGS) and asserts state ∈ taxonomy, fix ≥ 20 chars and non-boilerplate, confirm starts with the CLI name, https urls. No promise is lost. |

## Gaps

Criteria with no in-process test coverage in the audited files. Listed for later layers; not written here.

| Gap | Criterion | Note |
| --- | --- | --- |
| State matrix | honest-setup #19 | Owned by `test/state-matrix.test.ts`, created concurrently; not audited here. |
| Golden journeys | honest-setup #20 | Owned by `test/golden-journeys.test.ts`, created concurrently; not audited here. |
| Re-run status table renders taxonomy language | honest-setup #1 (partial) | Re-run resume/loop behavior is tested in setup-runtime; no test asserts the opening status table uses the six-state taxonomy words. Golden-journey layer. |
| "Verification deferred" no-ops proven gone | honest-setup #3 (partial) | Probe-loop behavior is tested; no static/behavioral test proves built-in plugins no longer ship deferred no-op `setup.run`/`setup.verify`. |
| Cancelled setup leaves secrets unchanged | honest-setup #9 (partial) | The cancelled-setup test asserts config bytes are unchanged but does not assert the secret file is untouched. |
| Doctor with no argument | honest-setup #13 (partial) | Alias and unknown-name paths are tested; bare `nutshell doctor` (no argument) is not. |
| Repeated failures refresh one deduped finding | honest-setup #15 (partial) | Single-run probe-skip-and-refresh is tested; multi-run dedup (no finding spam across repeated scheduled runs) is not asserted. |
| `fixture_stale` preflight verdict | honest-setup #23 | No code or test references `fixture_stale`. Layer 3 gate work. |
| Session keep-alive job | honest-setup #24 | No coverage. Layer 3 gate work. |
| Post-permission snapshot gate (both assertions) | honest-setup #25 | No coverage. Layer 3 gate work (requires the staged human session snapshot). |
| Gate failure labels (`product_fail`/`harness_fail`/`fixture_stale`) | honest-setup #27 | Rehearsal reports use `blockerKind` but the three-way labeling contract is untested. Layer 3 gate work. |
| Layer-4 checklist wiring | honest-setup #30 | Docs/process layer, not a unit test. |
