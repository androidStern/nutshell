import { CLI_NAME, CONFIG_FILENAME } from "../../../core/product";
import { FindingCatalog } from "../../../health/guidance";

const CONFIRM = `${CLI_NAME} doctor apple_notes`;

export const APPLE_NOTES_FINDINGS = new FindingCatalog("apple_notes", {
  apple_notes_automation_permission_required: {
    level: "critical",
    state: "needs_permission",
    fix: "If a macOS prompt appears, click Allow. If no prompt appears, open System Settings > Privacy & Security > Automation and allow Nutshell to control Notes, then retry.",
    confirm: CONFIRM,
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
    sample: "Apple Notes is blocked by macOS automation permissions",
  },
  apple_notes_access_failed: {
    level: "critical",
    state: "blocked_bug",
    fix: "Open Notes.app to confirm it launches normally, then retry. The error detail identifies the cause if it keeps failing.",
    confirm: CONFIRM,
    sample: "Apple Notes access could not be verified.",
  },
  osascript_missing: {
    level: "critical",
    state: "blocked_bug",
    fix: "Run Nutshell from a standard macOS terminal where the built-in osascript tool is on the PATH, then retry.",
    confirm: CONFIRM,
    sample: "osascript is not available",
  },
  apple_notes_fixture_missing: {
    level: "critical",
    state: "blocked_bug",
    fix: `Restore the fixture file at the configured path, or point the apple_notes fixturePath in ${CONFIG_FILENAME} at an existing file, then retry.`,
    confirm: CONFIRM,
    sample: "Apple Notes fixture is missing",
  },
  apple_notes_metadata_scan_failed: {
    level: "critical",
    state: "blocked_bug",
    fix: `Quit and reopen Notes.app, then run \`${CLI_NAME} sync apple_notes\` again. The error detail identifies the cause if it keeps failing.`,
    confirm: CONFIRM,
    sample: "Apple Notes metadata scan failed",
  },
  apple_notes_body_fetch_failed: {
    level: "critical",
    state: "blocked_bug",
    fix: `Quit and reopen Notes.app, then run \`${CLI_NAME} sync apple_notes\` again to retry the note body export.`,
    confirm: CONFIRM,
    sample: "Apple Notes body export failed",
  },
  apple_notes_body_failed: {
    level: "warning",
    state: "blocked_bug",
    fix: "No action needed — the failed note bodies are retried automatically on the next sync.",
    confirm: CONFIRM,
    sample: "Apple Notes body fetch failed",
  },
  apple_notes_scan_guard: {
    level: "warning",
    state: "blocked_bug",
    fix: "No action needed — tombstone detection was skipped defensively; the next full scan rechecks.",
    confirm: CONFIRM,
    sample: "Metadata scan saw suspiciously few notes; missing detection skipped",
  },
  apple_notes_runtime_budget_exhausted: {
    level: "warning",
    state: "blocked_bug",
    fix: "No action needed — the next scheduled sync continues where this one stopped.",
    confirm: CONFIRM,
    sample: "Apple Notes run budget was exhausted before body export completed",
  },
});
