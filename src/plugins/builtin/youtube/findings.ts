import { CLI_NAME, CONFIG_FILENAME } from "../../../core/product";
import { FindingCatalog } from "../../../health/guidance";

const DOCTOR_YOUTUBE = `${CLI_NAME} doctor youtube`;

// One code = one user state = one fix. Probe and sync failures are classified
// at the source (signed out vs keychain vs everything else) so each code maps
// to exactly one human action.
export const YOUTUBE_FINDINGS = new FindingCatalog("youtube", {
  youtube_signed_out: {
    level: "critical",
    state: "needs_auth",
    fix: "Sign into your Google account at youtube.com in Chrome, then retry.",
    confirm: DOCTOR_YOUTUBE,
    url: "https://www.youtube.com",
    sample: "You're not signed into Google in Chrome.",
  },
  youtube_session_unverifiable: {
    level: "critical",
    state: "blocked_bug",
    // Google interposes an identity-verification page on programmatic access
    // to some established/multi-account sessions; cookies are valid but a
    // server-side request can't satisfy the device/session binding. The
    // reliable route for YouTube history is the official export.
    fix: `Recent YouTube sync can't establish a session for this Google account — Google served an identity-verification page. Import your history from Google Takeout instead: \`${CLI_NAME} import youtube <google-export.zip> --json\`. If you use multiple Google accounts in this browser, set plugins.youtube.authUser in ~/${CONFIG_FILENAME} to the right account index (0 = first).`,
    confirm: DOCTOR_YOUTUBE,
    sample: "Google served an identity-verification page instead of My Activity for this account; recent YouTube sync cannot establish a session.",
  },
  youtube_keychain_blocked: {
    level: "critical",
    state: "needs_permission",
    fix: "Allow Nutshell to use Chrome Safe Storage in the macOS Keychain prompt, then retry.",
    confirm: DOCTOR_YOUTUBE,
    sample:
      "YouTube browser session is signed in, but macOS blocked access to Chrome Safe Storage. Allow Nutshell.app to use Chrome Safe Storage in Keychain, then try again.",
  },
  youtube_activity_unreadable: {
    level: "critical",
    state: "blocked_bug",
    fix: `Run \`${DOCTOR_YOUTUBE}\` to retry. If it keeps failing, Google My Activity changed its page format and Nutshell needs an update — report this issue.`,
    confirm: DOCTOR_YOUTUBE,
    sample: "YouTube browser session loaded activity cards but parsed no usable items.",
  },
  youtube_access_mode_unsupported: {
    level: "critical",
    state: "blocked_bug",
    fix: `Set plugins.youtube.accessMode to "myactivity_http" in ~/${CONFIG_FILENAME}, then retry.`,
    confirm: DOCTOR_YOUTUBE,
    sample: "Only direct My Activity HTTP sync is supported",
  },
  youtube_provider_export_required: {
    level: "warning",
    state: "ready_empty",
    fix: `Request your YouTube history from Google Takeout (takeout.google.com), then run \`${CLI_NAME} import youtube <google-export.zip> --json\` with the downloaded archive.`,
    confirm: `${CLI_NAME} import youtube <google-export.zip> --json`,
    sample: "YouTube historical backfill requires an official Google export import",
  },
  youtube_sync_failed: {
    level: "critical",
    state: "blocked_bug",
    fix: `Run \`${CLI_NAME} sync youtube\` to retry. If it keeps failing, report the error in the finding detail — Nutshell hit an unexpected failure.`,
    confirm: DOCTOR_YOUTUBE,
    sample: "YouTube sync failed",
  },
  youtube_cursor_loop: {
    level: "critical",
    state: "blocked_bug",
    fix: `Run \`${CLI_NAME} sync youtube\` to retry. If the cursor loops again, Google My Activity paging changed and Nutshell needs an update — report this issue.`,
    confirm: DOCTOR_YOUTUBE,
    sample: "YouTube collector cursor looped before cutoff",
  },
  youtube_cutoff_not_reached: {
    level: "critical",
    state: "blocked_bug",
    fix: `Run \`${CLI_NAME} sync youtube\` to retry; the collector resumes and continues toward the cutoff. If it never reaches the cutoff, report this issue.`,
    confirm: DOCTOR_YOUTUBE,
    sample: "YouTube collector did not reach cutoff",
  },
  youtube_stagnation: {
    level: "warning",
    state: "blocked_bug",
    fix: "No action needed — the next scheduled sync continues automatically.",
    confirm: DOCTOR_YOUTUBE,
    sample: "YouTube collector stopped for stagnation",
  },
  youtube_unexpected_empty: {
    level: "critical",
    state: "blocked_bug",
    fix: `Run \`${CLI_NAME} sync youtube\` to retry. If activity still parses empty, Google My Activity changed its item format and Nutshell needs an update — report this issue.`,
    confirm: DOCTOR_YOUTUBE,
    sample: "YouTube parsed no items despite loaded cards",
  },
});
