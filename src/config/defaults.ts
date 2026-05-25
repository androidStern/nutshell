import type { JsonObject, SyncBudget } from "../core/types";
import { DEFAULT_ROOT } from "../core/product";

export { DEFAULT_ROOT };

export const DEFAULT_SYNC_BUDGET: SyncBudget = {
  maxRuntimeMs: 5 * 60 * 1000,
  maxRequests: null,
  minDelayMs: 0,
  stopOnRateLimit: true,
};

export const DEFAULT_CONFIG: JsonObject = {
  version: 1,
  scheduler: {
    intervalSeconds: 900,
  },
  storage: {
    root: "~/Nutshell",
  },
  app: {
    path: "",
  },
  runtime: {
    lockHeartbeatMs: 30_000,
    staleLockMs: 10 * 60 * 1000,
    projectionAfterSync: true,
    enrichmentAfterSync: true,
    enrichmentMaxRequests: 10,
    enrichmentMaxRuntimeMs: 120_000,
    enrichmentMinDelayMs: 1_000,
    enrichmentStopOnRateLimit: true,
    diskWarningBytes: 2_000_000_000,
    diskCriticalBytes: 500_000_000,
    projectionStaleMs: 24 * 60 * 60 * 1000,
  },
  backfill: {
    lookbackMonths: 6,
    cutoffDate: "",
    cutoffDates: {},
  },
  store: {
    sqlitePath: "nutshell.sqlite",
  },
  dashboard: {
    remoteMedia: true,
  },
  google: {
    youtube: {
      clientSecretPath: "",
      clientId: "",
      clientSecret: "",
      redirectUri: "http://localhost",
      apiKey: "",
      tokenPath: "",
      downloadDir: "",
    },
  },
  plugins: {
    youtube: {
      enabled: true,
      accessMode: "myactivity_http",
      cookieBrowser: "chrome",
      cookieProfile: "",
      cookieTimeoutMs: 30_000,
      overlapHours: 48,
      httpMaxPages: 10,
    },
    podcasts: {
      enabled: true,
      dbPath:
        "~/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite",
      alternateDbPaths: [],
      overlapHours: 48,
      limit: 500,
      backfillLimit: 10_000,
      attempts: 3,
      timeoutMs: 10_000,
      checkTimeoutMs: 3_000,
    },
    apple_notes: {
      enabled: true,
      source: "applescript",
      fixturePath: "",
      batchSize: 25,
      maxRunMs: 240_000,
      osascriptTimeoutMs: 180_000,
      includeFolders: [],
      excludeFolders: ["Recently Deleted"],
      includeShared: true,
      includeLockedMetadataOnly: true,
      tombstoneAfterMissingScans: 3,
      pruneDeleted: false,
      writeRawHtml: true,
    },
    twitter: {
      enabled: true,
      accountId: "acct_primary",
      accountUserId: "",
      accountHandle: "",
      cookieBrowser: "chrome",
      cookieProfile: "",
      cookieTimeoutMs: 30_000,
      timeoutMs: 30_000,
      collections: ["bookmarks", "likes", "authored", "following"],
      maxPages: 50,
      recentMaxPages: 3,
      pageSize: 20,
      followingPageSize: 100,
      followingSnapshotTtlMs: 6 * 60 * 60 * 1000,
      delayMs: 10_000,
      saturationPages: 1,
      recentSeedPages: 1,
    },
  },
};
