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
    fix: "Open youtube.com in Chrome and sign into your Google account, then retry.",
    confirm: DOCTOR_YOUTUBE,
    url: "https://www.youtube.com",
    sample:
      "YouTube browser session is signed out of Google. Sign into Google My Activity in the configured Chrome profile and try again.",
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
