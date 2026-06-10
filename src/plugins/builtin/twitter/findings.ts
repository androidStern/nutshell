import { CLI_NAME } from "../../../core/product";
import { chromeSafeStorageAccessMessage } from "../../../browser/access-errors";
import { FindingCatalog } from "../../../health/guidance";

const DOCTOR_TWITTER = `${CLI_NAME} doctor twitter`;
const IMPORT_TWITTER = `${CLI_NAME} import twitter <x-archive.zip> --json`;

// One code = one user state = one fix. Every problem finding the Twitter/X
// plugin can emit is declared here so guidance travels with the finding.
export const TWITTER_FINDINGS = new FindingCatalog("twitter", {
  twitter_signed_out: {
    level: "critical",
    state: "needs_auth",
    fix: "Open x.com in Chrome and sign in, then retry.",
    confirm: DOCTOR_TWITTER,
    url: "https://x.com",
    sample: "X browser session is signed out",
  },
  twitter_keychain_blocked: {
    level: "critical",
    state: "needs_permission",
    fix:
      "Open Keychain Access, find the Chrome Safe Storage item, and allow Nutshell.app to use it (or click Always Allow when macOS prompts), then retry.",
    confirm: DOCTOR_TWITTER,
    sample: chromeSafeStorageAccessMessage("X"),
  },
  twitter_session_check_failed: {
    level: "critical",
    state: "blocked_bug",
    fix: "Retry shortly — this is usually a temporary X or network failure. The finding detail shows what X returned.",
    confirm: DOCTOR_TWITTER,
    sample: "X browser session check failed",
  },
  twitter_rate_limited: {
    level: "critical",
    state: "blocked_bug",
    fix: "Wait for the X rate limit to reset, then retry; Nutshell backs off automatically.",
    confirm: DOCTOR_TWITTER,
    sample: "X reported a rate limit",
  },
  twitter_collection_failed: {
    level: "critical",
    state: "blocked_bug",
    fix: `Run \`${CLI_NAME} sync twitter --mode recent\` to retry the failed collection; the finding detail shows the error X returned.`,
    confirm: DOCTOR_TWITTER,
    sample: "Twitter bookmarks sync failed",
  },
  twitter_following_incomplete: {
    level: "critical",
    state: "blocked_bug",
    fix: `Run \`${CLI_NAME} sync twitter --mode recent\` again so the following snapshot can finish; if it keeps stopping early, raise the twitter maxPages setting in your config.`,
    confirm: DOCTOR_TWITTER,
    sample: "Following snapshot did not reach cursor exhaustion",
  },
  twitter_provider_export_required: {
    level: "warning",
    state: "ready_empty",
    fix:
      "Download your archive from x.com (Settings > Your account > Download an archive of your data), then import it with the import command.",
    confirm: IMPORT_TWITTER,
    sample: "Twitter/X historical backfill requires an official X archive import",
  },
  x_archive_import_issue: {
    level: "warning",
    state: "blocked_bug",
    fix:
      "Check that the path points to the official X archive zip downloaded from x.com Settings (Your account > Download an archive of your data), then run the import again.",
    confirm: IMPORT_TWITTER,
    sample: "No tweets, likes, bookmarks, or following rows were parsed from the X archive",
  },
  twitter_enrichment_rate_limited: {
    level: "critical",
    state: "blocked_bug",
    fix: "Wait for the X rate limit to reset; Nutshell backs off and retries queued tweets automatically on the next scheduled sync.",
    confirm: DOCTOR_TWITTER,
    sample: "Twitter enrichment is rate limited",
  },
  twitter_enrichment_pending: {
    level: "warning",
    state: "blocked_bug",
    fix: "No action needed — queued tweets are enriched automatically on the next scheduled sync.",
    confirm: DOCTOR_TWITTER,
    sample: "Twitter enrichment has queued tweets that are not ready for dashboard rendering",
  },
  twitter_enrichment_failed: {
    level: "warning",
    state: "blocked_bug",
    fix: "No action needed — failed tweets are retried automatically on the next scheduled sync.",
    confirm: DOCTOR_TWITTER,
    sample: "Twitter enrichment has retryable failures",
  },
  twitter_enrichment_partial: {
    level: "warning",
    state: "blocked_bug",
    fix: "No action needed — failed tweets are retried automatically on the next scheduled sync.",
    confirm: DOCTOR_TWITTER,
    sample: "Some Twitter enrichment requests failed temporarily",
  },
});
