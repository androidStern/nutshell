// Criterion-19 state matrix (setup-onboarding-and-feedback-loops-goal.md §6 Layer 1):
// each built-in source × every taxonomy state its real probe (check()) can
// express → exactly the expected finding code, the finding's own guidance
// (state + fix + confirm), and the doctor exit-code mapping for that finding
// set. Every arrangement drives the real plugin check() through its existing
// injection seams (constructor-injected collectors/sources, prototype-patched
// BirdClient.check, local sqlite/json fixtures) — no live network, no real
// user data, no installed app.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthFinding, HealthReport, JsonObject, PluginContext, UserState } from "../src/core/types";
import { exitCodeForHealth, reportStatus } from "../src/health/health";
import { APPLE_NOTES_FINDINGS } from "../src/plugins/builtin/apple-notes/findings";
import type { NotesSource } from "../src/plugins/builtin/apple-notes/jxa-source";
import { AppleNotesPlugin } from "../src/plugins/builtin/apple-notes/plugin";
import { PODCASTS_FINDINGS } from "../src/plugins/builtin/podcasts/findings";
import { PodcastsPlugin } from "../src/plugins/builtin/podcasts/plugin";
import { BirdClient } from "../src/plugins/builtin/twitter/bird-client";
import { TWITTER_FINDINGS } from "../src/plugins/builtin/twitter/findings";
import { TwitterPlugin } from "../src/plugins/builtin/twitter/plugin";
import { YOUTUBE_FINDINGS } from "../src/plugins/builtin/youtube/findings";
import { YouTubePlugin } from "../src/plugins/builtin/youtube/plugin";

setDefaultTimeout(15_000);

const originalBirdCheck = BirdClient.prototype.check;

afterEach(() => {
  BirdClient.prototype.check = originalBirdCheck;
});

type MatrixSource = "youtube" | "twitter" | "podcasts" | "apple_notes";

// A row either expects exactly one problem finding with a taxonomy state, or
// "verified": a passing probe with zero findings (the state setup records as
// proven-ready). Discriminated on expectedCode.
type MatrixRow =
  | {
      source: MatrixSource;
      state: UserState;
      expectedCode: string;
      expectedExitCode: 1 | 2;
      arrange: () => Promise<HealthFinding[]>;
    }
  | {
      source: MatrixSource;
      state: "verified";
      expectedCode: null;
      expectedExitCode: 0;
      arrange: () => Promise<HealthFinding[]>;
    };

const APPLE_NOTES_FIXTURE = join(import.meta.dir, "fixtures", "apple-notes-state-matrix.json");

const MATRIX: MatrixRow[] = [
  // ---- youtube ----
  {
    source: "youtube",
    state: "needs_auth",
    expectedCode: "youtube_signed_out",
    expectedExitCode: 2,
    arrange: async () => {
      // Collector error text for missing/unusable Google cookies in Chrome.
      const plugin = new YouTubePlugin(async () => {
        throw new Error("Google browser cookies were not usable for My Activity; warnings=no Google session cookies in profile");
      });
      return plugin.check(youtubeContext());
    },
  },
  {
    source: "youtube",
    state: "needs_permission",
    expectedCode: "youtube_keychain_blocked",
    expectedExitCode: 2,
    arrange: async () => {
      // Chrome Safe Storage / macOS Keychain block: signed in, but cookies
      // cannot be decrypted. Never classified as an auth problem.
      const plugin = new YouTubePlugin(async () => {
        throw new Error("Timed out after 10000ms reading Chrome Safe Storage from macOS Keychain.");
      });
      return plugin.check(youtubeContext());
    },
  },
  {
    source: "youtube",
    state: "needs_auth",
    expectedCode: "youtube_session_unverifiable",
    expectedExitCode: 2,
    arrange: async () => {
      // Google interposed an identity-verification page (multi-account /
      // device-binding); the user can finish that browser verification in
      // Chrome and retry.
      const plugin = new YouTubePlugin(async () => {
        throw new Error("Google could not establish a My Activity session: it served an identity-verification page for this account");
      });
      return plugin.check(youtubeContext());
    },
  },
  {
    source: "youtube",
    state: "blocked_bug",
    expectedCode: "youtube_activity_unreadable",
    expectedExitCode: 2,
    arrange: async () => {
      // Page loaded activity cards but nothing parseable came out.
      const plugin = new YouTubePlugin(async () => ({
        items: [],
        scroll: youtubeScroll({ loadedCardCount: 3, reachedCutoff: true }),
      }));
      return plugin.check(youtubeContext());
    },
  },
  {
    source: "youtube",
    state: "blocked_bug",
    expectedCode: "youtube_access_mode_unsupported",
    expectedExitCode: 2,
    arrange: async () => {
      const plugin = new YouTubePlugin(async () => {
        throw new Error("collector must not run for an unsupported access mode");
      });
      return plugin.check(youtubeContext({ accessMode: "browser_dom" }));
    },
  },
  {
    source: "youtube",
    state: "verified",
    expectedCode: null,
    expectedExitCode: 0,
    arrange: async () => {
      const plugin = new YouTubePlugin(async () => ({
        items: [
          {
            source: "fixture",
            date_key: "20260609",
            happened_at: "2026-06-09T12:00:00.000Z",
            product: "YouTube",
            verb: "Watched",
            title: "Recent video",
            title_url: "https://youtube.com/watch?v=recent-video",
            raw_text: "Watched Recent video",
          },
        ],
        scroll: youtubeScroll({ loadedCardCount: 1, reachedCutoff: true }),
      }));
      return plugin.check(youtubeContext());
    },
  },

  // ---- twitter ----
  // The plugin builds BirdClient internally; per the established pattern in
  // test/twitter-plugin.test.ts, the seam is BirdClient.prototype.check
  // (restored in afterEach). The BirdClient constructor is lazy — nothing
  // touches cookies or the network until a method runs.
  {
    source: "twitter",
    state: "needs_auth",
    expectedCode: "twitter_signed_out",
    expectedExitCode: 2,
    arrange: twitterCheckArrange({ ok: false, text: "401 unauthorized: login required", rateLimited: false, authFailed: true }),
  },
  {
    source: "twitter",
    state: "needs_permission",
    expectedCode: "twitter_keychain_blocked",
    expectedExitCode: 2,
    arrange: twitterCheckArrange({
      ok: false,
      text: "Timed out after 10000ms reading Chrome Safe Storage from macOS Keychain.",
      rateLimited: false,
      authFailed: false,
    }),
  },
  {
    source: "twitter",
    state: "blocked_bug",
    expectedCode: "twitter_rate_limited",
    expectedExitCode: 2,
    arrange: twitterCheckArrange({ ok: false, text: "429 too many requests", rateLimited: true, authFailed: false }),
  },
  {
    source: "twitter",
    state: "blocked_bug",
    expectedCode: "twitter_session_check_failed",
    expectedExitCode: 2,
    arrange: twitterCheckArrange({ ok: false, text: "X current user check timed out after 30000ms", rateLimited: false, authFailed: false }),
  },
  {
    source: "twitter",
    state: "verified",
    expectedCode: null,
    expectedExitCode: 0,
    arrange: twitterCheckArrange({ ok: true, text: "authenticated as state_matrix", rateLimited: false, authFailed: false }),
  },

  // ---- podcasts ----
  {
    source: "podcasts",
    state: "ready_empty",
    expectedCode: "podcasts_db_missing",
    expectedExitCode: 2,
    arrange: async () =>
      withTempDir("nutshell-state-matrix-podcasts-", async (root) => {
        // No Apple Podcasts library exists at any configured path.
        const dbPath = join(root, "MTLibrary.sqlite");
        return new PodcastsPlugin().check(podcastsContext(root, dbPath));
      }),
  },
  {
    source: "podcasts",
    state: "needs_permission",
    expectedCode: "podcasts_full_disk_access_required",
    expectedExitCode: 2,
    arrange: async () =>
      withTempDir("nutshell-state-matrix-podcasts-", async (root) => {
        // chmod 000 makes the open/read probe fail with EACCES — the plugin's
        // documented permission-denied path (probePodcastFileAccess).
        const dbPath = join(root, "MTLibrary.sqlite");
        writeFileSync(dbPath, "SQLite format 3 ");
        chmodSync(dbPath, 0o000);
        try {
          return await new PodcastsPlugin().check(podcastsContext(root, dbPath));
        } finally {
          chmodSync(dbPath, 0o600);
        }
      }),
  },
  {
    source: "podcasts",
    state: "blocked_bug",
    expectedCode: "podcasts_db_probe_failed",
    expectedExitCode: 2,
    arrange: async () =>
      withTempDir("nutshell-state-matrix-podcasts-", async (root) => {
        // Schema-drifted sqlite: readable database without the MTLibrary tables.
        const dbPath = join(root, "MTLibrary.sqlite");
        const db = new Database(dbPath, { create: true });
        db.exec("create table unrelated (id integer primary key)");
        db.close();
        return new PodcastsPlugin().check(podcastsContext(root, dbPath));
      }),
  },
  {
    source: "podcasts",
    state: "verified",
    expectedCode: null,
    expectedExitCode: 0,
    arrange: async () =>
      withTempDir("nutshell-state-matrix-podcasts-", async (root) => {
        // Minimal valid MTLibrary-shaped sqlite (same shape as podcasts.test.ts).
        const dbPath = join(root, "MTLibrary.sqlite");
        const db = new Database(dbPath, { create: true });
        db.exec("create table ZMTEPISODE (Z_PK integer primary key); create table ZMTPODCAST (Z_PK integer primary key)");
        db.close();
        return new PodcastsPlugin().check(podcastsContext(root, dbPath));
      }),
  },

  // ---- apple_notes ----
  {
    source: "apple_notes",
    state: "needs_permission",
    expectedCode: "apple_notes_automation_permission_required",
    expectedExitCode: 2,
    arrange: async () => {
      // Probe error matching isAppleNotesPermissionError (automation denial).
      const denied: NotesSource = {
        async scanMetadata() {
          throw new Error("Not authorized to send Apple events to Notes.");
        },
        async fetchBodies() {
          return new Map();
        },
      };
      return new AppleNotesPlugin(() => denied).check(pluginContext({}));
    },
  },
  {
    source: "apple_notes",
    state: "blocked_bug",
    expectedCode: "apple_notes_access_failed",
    expectedExitCode: 2,
    arrange: async () => {
      // Non-permission probe failure.
      const broken: NotesSource = {
        async scanMetadata() {
          throw new Error("osascript timed out after 45000 ms");
        },
        async fetchBodies() {
          return new Map();
        },
      };
      return new AppleNotesPlugin(() => broken).check(pluginContext({}));
    },
  },
  {
    source: "apple_notes",
    state: "blocked_bug",
    expectedCode: "apple_notes_fixture_missing",
    expectedExitCode: 2,
    arrange: async () =>
      withTempDir("nutshell-state-matrix-notes-", async (root) =>
        new AppleNotesPlugin().check(pluginContext({ source: "fixture", fixturePath: join(root, "missing-notes-fixture.json") })),
      ),
  },
  {
    source: "apple_notes",
    state: "verified",
    expectedCode: null,
    expectedExitCode: 0,
    arrange: async () => new AppleNotesPlugin().check(pluginContext({ source: "fixture", fixturePath: APPLE_NOTES_FIXTURE })),
  },
];

for (const row of MATRIX) {
  const label = row.expectedCode ? `${row.state} (${row.expectedCode})` : "verified (zero findings)";
  test(`state matrix: ${row.source} ${label}`, async () => {
    const findings = await row.arrange();

    if (row.expectedCode === null) {
      expect(findings).toEqual([]);
    } else {
      expect(findings.map((finding) => finding.code)).toEqual([row.expectedCode]);
      const finding = findings[0];
      if (!finding) throw new Error("unreachable: asserted exactly one finding above");
      expect(finding.source).toBe(row.source);
      expect(finding.guidance?.state).toBe(row.state);
      expect((finding.guidance?.fix ?? "").length).toBeGreaterThan(0);
      expect((finding.guidance?.confirm ?? "").length).toBeGreaterThan(0);
    }

    // Doctor exit-code mapping for this finding set: critical->2, warning->1, none->0.
    expect(doctorExitCode(findings)).toBe(row.expectedExitCode);
  });
}

// Codes from each catalog that check() cannot emit, so they have no matrix
// row. Every entry carries the reason; adding a new code to a catalog without
// either a matrix row or an entry here fails the completeness test below, so
// future codes force an explicit matrix decision.
const EXCLUDED_CODES: Record<MatrixSource, Record<string, string>> = {
  youtube: {
    youtube_provider_export_required: "sync(mode=backfill)-only: demands an official Google export import; check() never walks the backfill path",
    youtube_sync_failed: "sync-only fallback for unclassified sync errors; check() maps the same failures to signed_out/keychain_blocked/activity_unreadable",
    youtube_cursor_loop: "sync-only collector paging telemetry; the bounded probe reports unreadable activity instead",
    youtube_cutoff_not_reached: "sync-only collector paging telemetry; the bounded probe reports unreadable activity instead",
    youtube_stagnation: "sync-only collector paging telemetry",
    youtube_unexpected_empty: "sync-only: the probe maps loaded-cards-but-no-items to youtube_activity_unreadable",
  },
  twitter: {
    twitter_collection_failed: "sync-only: per-collection ingest failure",
    twitter_following_incomplete: "sync-only: following snapshot pagination telemetry",
    twitter_provider_export_required: "sync(mode=backfill)-only: demands an official X archive import",
    x_archive_import_issue: "importProviderExport-only: archive parsing problem",
    twitter_enrichment_rate_limited: "enrich()-only: enrichment queue backoff",
    twitter_enrichment_pending: "enrich()/health-only: enrichment queue status",
    twitter_enrichment_failed: "enrich()/health-only: enrichment queue status",
    twitter_enrichment_partial: "enrich()-only: partial enrichment batch",
  },
  podcasts: {
    podcasts_permission_blocked: "health-checks-only: derived from stored sync state (src/health/checks.ts), never emitted by check()",
    podcasts_db_read_timeout: "check()-emittable only when the file-read probe overruns its budget; timing-dependent, not deterministically arrangeable",
    podcasts_db_timeout: "check()-emittable only when the sqlite worker probe times out; timing-dependent, not deterministically arrangeable",
    podcasts_db_read_failed: "check()-emittable only for a non-permission read failure on an existing file; platform-dependent to arrange, blocked_bug covered by podcasts_db_probe_failed",
    podcasts_sync_failed: "sync-only: retry-exhausted ingest failure",
    podcasts_backfill_failed: "sync(mode=backfill)-only: retry-exhausted backfill failure",
  },
  apple_notes: {
    osascript_missing: "check()-emittable only when osascript is absent from PATH; environment state that cannot be arranged in-process",
    apple_notes_metadata_scan_failed: "sync-only: non-permission metadata scan failure (check() maps probe failures to apple_notes_access_failed)",
    apple_notes_body_fetch_failed: "sync-only: body export failure",
    apple_notes_body_failed: "sync-only: per-note body fetch failure",
    apple_notes_scan_guard: "sync-only: tombstone-detection guard",
    apple_notes_runtime_budget_exhausted: "sync-only: run budget telemetry",
  },
};

const CATALOGS = {
  youtube: YOUTUBE_FINDINGS,
  twitter: TWITTER_FINDINGS,
  podcasts: PODCASTS_FINDINGS,
  apple_notes: APPLE_NOTES_FINDINGS,
} as const;

test("state matrix completeness: every catalog code for these sources has a matrix row or an explicit exclusion", () => {
  for (const source of Object.keys(CATALOGS) as MatrixSource[]) {
    const catalog = CATALOGS[source];
    const catalogCodes: string[] = catalog.codes();
    const matrixCodes = new Set<string>();
    for (const row of MATRIX) {
      if (row.source === source && row.expectedCode !== null) matrixCodes.add(row.expectedCode);
    }
    const excluded = EXCLUDED_CODES[source];

    // Matrix rows only reference real catalog codes.
    for (const code of matrixCodes) {
      expect(catalog.has(code), `${source}: matrix row code ${code} is not in the catalog`).toBe(true);
    }
    // Exclusions are real codes, carry a reason, and do not overlap matrix rows.
    for (const [code, reason] of Object.entries(excluded)) {
      expect(catalog.has(code), `${source}: excluded code ${code} is not in the catalog (stale exclusion)`).toBe(true);
      expect(reason.length, `${source}: exclusion for ${code} needs a reason`).toBeGreaterThan(0);
      expect(matrixCodes.has(code), `${source}: ${code} is both a matrix row and an exclusion`).toBe(false);
    }
    // Every code makes a matrix decision: row or commented exclusion.
    for (const code of catalogCodes) {
      const covered = matrixCodes.has(code) || Object.hasOwn(excluded, code);
      expect(covered, `${source}: catalog code ${code} has neither a matrix row nor an exclusion entry`).toBe(true);
    }

    // Every taxonomy state the catalog can express through check() (i.e. via a
    // non-excluded code) appears in at least one matrix row for this source.
    const rowStates = new Set(MATRIX.filter((row) => row.source === source).map((row) => row.state));
    for (const [code, spec] of Object.entries(catalog.specs)) {
      if (Object.hasOwn(excluded, code)) continue;
      expect(rowStates.has(spec.state), `${source}: probe-emittable state ${spec.state} (${code}) has no matrix row`).toBe(true);
    }
  }
});

test("state matrix rows agree with catalog levels on the doctor exit code", () => {
  for (const row of MATRIX) {
    if (row.expectedCode === null) {
      expect(row.expectedExitCode, `${row.source} verified row must map to exit 0`).toBe(0);
      continue;
    }
    const entry = Object.entries(CATALOGS[row.source].specs).find(([code]) => code === row.expectedCode);
    if (!entry) throw new Error(`${row.source}/${row.expectedCode}: matrix row code is not in the catalog`);
    const expected = entry[1].level === "critical" ? 2 : 1;
    expect(row.expectedExitCode, `${row.source}/${row.expectedCode}: exit code must follow the catalog level`).toBe(expected);
  }
});

function doctorExitCode(findings: HealthFinding[]): number {
  // The doctor command computes its exit code with exitCodeForHealth over a
  // report whose status is derived from the findings (src/cli.ts). Only the
  // findings-derived status matters for the mapping; the rest is inert shape.
  const report: HealthReport = {
    status: reportStatus(findings),
    checkedAt: new Date("2026-06-10T12:00:00.000Z"),
    findings,
    backfill: [],
    app: {
      installed: true,
      path: "",
      executable: "",
      fullDiskAccess: "unknown",
      backgroundSync: "unknown",
      agent: "unknown",
      dataRoot: null,
      raw: "",
    },
    scheduler: {
      intervalSeconds: 0,
      lastRunAt: null,
      nextRunAt: null,
      lastAgentEventAt: null,
      lastAgentMessage: null,
      source: "unavailable",
    },
  };
  return exitCodeForHealth(report);
}

function twitterCheckArrange(result: { ok: boolean; text: string; rateLimited: boolean; authFailed: boolean }): () => Promise<HealthFinding[]> {
  return async () => {
    BirdClient.prototype.check = async () => result;
    try {
      return await new TwitterPlugin().check(pluginContext({ accountId: "acct_primary", collections: ["likes"] }));
    } finally {
      BirdClient.prototype.check = originalBirdCheck;
    }
  };
}

function youtubeContext(config: JsonObject = {}): PluginContext {
  return pluginContext({ accessMode: "myactivity_http", httpMaxPages: 2, cookieTimeoutMs: 1_000, ...config });
}

function podcastsContext(root: string, dbPath: string): PluginContext {
  return pluginContext({ dbPath, checkTimeoutMs: 2_000 }, root);
}

function youtubeScroll(overrides: JsonObject = {}): JsonObject {
  return {
    driver: "fixture",
    pages: 1,
    maxPages: 1,
    reachedCutoff: true,
    stoppedForStagnation: false,
    stoppedForCursorLoop: false,
    stoppedForExhaustion: false,
    loadedCardCount: 0,
    nextCursor: null,
    ...overrides,
  };
}

async function withTempDir<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function pluginContext(config: JsonObject, root = "/tmp/nutshell-state-matrix"): PluginContext {
  return {
    root,
    config,
    logger: { event() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    now: () => new Date("2026-06-10T12:00:00.000Z"),
    records: {
      async query() {
        return { records: [], total: 0, limit: 0, offset: 0 };
      },
    },
    async writeArtifact() {
      return { path: "", contentHash: "", mimeType: null, bytes: 0 };
    },
  };
}
