import type { HealthFinding, JsonObject, SourceId } from "../core/types";
import { CLI_NAME, PRODUCT_NAME } from "../core/product";
import { finding } from "../plugins/interface";
import { FindingCatalog, guidanceFromJson, guidanceFromSpec } from "./guidance";

const HEALTH = `${CLI_NAME} status`;
const DOCTOR = `${CLI_NAME} doctor`;

// One code = one user state = one fix. Every problem finding the core runtime
// and health checks emit (source "system", or a plugin source for findings the
// core raises on a plugin's behalf) is declared here so guidance travels with
// the finding.
export const SYSTEM_FINDINGS = new FindingCatalog("system", {
  nutshell_app_missing: {
    level: "critical",
    state: "needs_permission",
    fix: `Reinstall ${PRODUCT_NAME} (brew reinstall ${CLI_NAME} or the tarball installer), then rerun ${CLI_NAME} setup.`,
    confirm: HEALTH,
    sample: `${PRODUCT_NAME}.app is not installed or could not be found`,
  },
  nutshell_app_full_disk_access_missing: {
    level: "critical",
    state: "needs_permission",
    fix: `Rerun ${CLI_NAME} setup to open the permission window, or grant Full Disk Access to ${PRODUCT_NAME}.app in System Settings → Privacy & Security.`,
    confirm: HEALTH,
    sample: `${PRODUCT_NAME}.app does not have Full Disk Access`,
  },
  nutshell_app_full_disk_access_unknown: {
    level: "warning",
    state: "blocked_bug",
    fix: `Open ${PRODUCT_NAME}.app once so it can report its permission status, then run ${CLI_NAME} status again.`,
    confirm: HEALTH,
    sample: `${PRODUCT_NAME}.app Full Disk Access could not be determined`,
  },
  nutshell_agent_requires_approval: {
    level: "warning",
    state: "needs_permission",
    fix: `Approve ${PRODUCT_NAME} in System Settings → General → Login Items & Extensions.`,
    confirm: HEALTH,
    sample: `${PRODUCT_NAME} automatic sync requires approval`,
  },
  nutshell_agent_not_enabled: {
    level: "warning",
    state: "needs_permission",
    fix: `Run ${CLI_NAME} sync resume to enable automatic sync.`,
    confirm: HEALTH,
    sample: `${PRODUCT_NAME} automatic sync is not enabled`,
  },
  nutshell_background_sync_disabled: {
    level: "warning",
    state: "needs_permission",
    fix: `Run ${CLI_NAME} sync resume to turn automatic sync back on.`,
    confirm: HEALTH,
    sample: `${PRODUCT_NAME} automatic sync is paused`,
  },
  lock_active: {
    level: "warning",
    state: "blocked_bug",
    fix: `Another ${PRODUCT_NAME} process is running — wait for it to finish, then retry.`,
    confirm: HEALTH,
    sample: "A runtime lock is active",
  },
  lock_stale: {
    level: "critical",
    state: "blocked_bug",
    fix: `Rerun the command; ${PRODUCT_NAME} recovers stale locks automatically.`,
    confirm: HEALTH,
    sample: "A stale runtime lock exists",
  },
  root_missing: {
    level: "critical",
    state: "blocked_bug",
    fix: `Rerun ${CLI_NAME} setup to recreate the ${PRODUCT_NAME} data root, then run ${CLI_NAME} sync.`,
    confirm: HEALTH,
    sample: `${PRODUCT_NAME} data root is missing`,
  },
  root_not_directory: {
    level: "critical",
    state: "blocked_bug",
    fix: `Move the file occupying the ${PRODUCT_NAME} data root path aside, then rerun ${CLI_NAME} setup.`,
    confirm: HEALTH,
    sample: `${PRODUCT_NAME} data root is not a directory`,
  },
  root_not_writable: {
    level: "critical",
    state: "blocked_bug",
    fix: `Restore write permission on the ${PRODUCT_NAME} data root folder for your user (the path is in the finding detail), then retry.`,
    confirm: HEALTH,
    sample: `${PRODUCT_NAME} data root is not writable`,
  },
  root_write_test_cleanup_failed: {
    level: "warning",
    state: "blocked_bug",
    fix: "Delete the leftover write-test file named in the finding detail; syncs continue normally either way.",
    confirm: HEALTH,
    sample: `${PRODUCT_NAME} data root is writable, but health could not remove its temporary write test file`,
  },
  sqlite_quick_check: {
    level: "critical",
    state: "blocked_bug",
    fix: `Move the trace database aside so ${PRODUCT_NAME} can rebuild it on the next sync, then re-import your provider exports.`,
    confirm: HEALTH,
    sample: "SQLite quick_check failed",
  },
  disk_free_low: {
    level: "warning",
    state: "blocked_bug",
    fix: "Free up disk space on this volume.",
    confirm: HEALTH,
    sample: `${PRODUCT_NAME} data root disk free space is low`,
  },
  disk_free_unknown: {
    level: "warning",
    state: "blocked_bug",
    fix: `Check that the ${PRODUCT_NAME} data root volume is mounted and readable, then run ${CLI_NAME} status again.`,
    confirm: HEALTH,
    sample: `${PRODUCT_NAME} data root disk free space could not be checked`,
  },
  projections_missing: {
    level: "warning",
    state: "blocked_bug",
    fix: `Run ${CLI_NAME} sync to rebuild projections.`,
    confirm: HEALTH,
    sample: "Projection directory is missing",
  },
  projection_missing: {
    level: "warning",
    state: "blocked_bug",
    fix: `Run ${CLI_NAME} sync to rebuild projections.`,
    confirm: HEALTH,
    sample: "dashboard projection is missing",
  },
  projection_stale: {
    level: "warning",
    state: "blocked_bug",
    fix: `Run ${CLI_NAME} sync to rebuild projections.`,
    confirm: HEALTH,
    sample: "dashboard projection is stale",
  },
  last_run_failed: {
    level: "critical",
    state: "blocked_bug",
    fix: `Run ${CLI_NAME} doctor for the source named in this finding to see the exact blocker, then follow its fix.`,
    confirm: DOCTOR,
    sample: "twitter last sync failed",
  },
  last_run_partial: {
    level: "warning",
    state: "blocked_bug",
    fix: "No action needed — the next scheduled sync continues where the last one stopped.",
    confirm: DOCTOR,
    sample: "twitter last sync was partial",
  },
  backfill_incomplete: {
    level: "warning",
    state: "ready_empty",
    fix: "Request your history export from the provider and import it when it arrives; the exact import command is in this finding's detail.",
    confirm: HEALTH,
    sample: "twitter coverage is incomplete for the configured cutoff",
  },
  backfill_partial: {
    level: "warning",
    state: "ready_empty",
    fix: "Request the provider export and import it when it arrives; the exact import command is in this finding's detail.",
    confirm: HEALTH,
    sample: "twitter coverage is partial for the configured cutoff",
  },
  plugin_setup_degraded: {
    level: "critical",
    state: "blocked_bug",
    fix: `Rerun ${CLI_NAME} setup to repair this source.`,
    confirm: DOCTOR,
    sample: "Twitter/X setup is degraded",
  },
  plugin_check_crashed: {
    level: "critical",
    state: "blocked_bug",
    fix: `Run ${CLI_NAME} doctor for this source to retry; if it keeps crashing, report the error in the finding detail — this is a ${PRODUCT_NAME} bug.`,
    confirm: DOCTOR,
    sample: "Plugin health check crashed",
  },
  app_owned_sync_not_verified: {
    level: "warning",
    state: "blocked_bug",
    fix: `Run ${CLI_NAME} sync once, or wait for the next automatic sync.`,
    confirm: HEALTH,
    sample: "Apple Notes has not been verified by an app-owned sync yet",
  },
  plugin_runtime_error: {
    level: "critical",
    state: "blocked_bug",
    fix: `Run ${CLI_NAME} sync for this source to retry; if it keeps failing, report the error in the finding detail — this is a ${PRODUCT_NAME} bug.`,
    confirm: DOCTOR,
    sample: "twitter failed before commit",
  },
  plugin_smoke_runtime_error: {
    level: "critical",
    state: "blocked_bug",
    fix: `Run ${CLI_NAME} doctor for this source; if the connection check keeps failing, report the error in the finding detail — this is a ${PRODUCT_NAME} bug.`,
    confirm: DOCTOR,
    sample: "Twitter/X connection check failed",
  },
  plugin_enrichment_runtime_error: {
    level: "critical",
    state: "blocked_bug",
    fix: `Run ${CLI_NAME} sync for this source to retry enrichment; if it keeps failing, report the error in the finding detail — this is a ${PRODUCT_NAME} bug.`,
    confirm: DOCTOR,
    sample: "twitter enrichment failed",
  },
});

export type SystemFindingCode = Parameters<typeof SYSTEM_FINDINGS.make>[0];

// Some catalog findings are raised by the core on a plugin's behalf
// (last_run_failed, plugin_setup_degraded, ...). They keep the plugin id as
// their source, so they cannot go through SYSTEM_FINDINGS.make — this helper
// attaches the spec's guidance while preserving the caller's source.
export function systemFinding(
  code: SystemFindingCode,
  source: HealthFinding["source"],
  message: string,
  detail: HealthFinding["detail"] = {},
  observedAt = new Date(),
): HealthFinding {
  const spec = SYSTEM_FINDINGS.spec(code);
  return finding(spec.level, source, code, message, detail, observedAt, guidanceFromSpec(spec));
}

// Setup findings persisted in the config carry their guidance as plain JSON.
// Re-validate it through guidanceFromJson when re-surfacing them so the stored
// fix text survives the round-trip and invalid shapes are dropped.
// Stored setup findings (config-draft shape: no source key, ISO observedAt)
// rebuilt as real HealthFindings for surfaces that render them directly.
export function healthFindingsFromStored(source: SourceId, stored: JsonObject[]): HealthFinding[] {
  return stored.flatMap((item) => {
    if (typeof item.code !== "string" || typeof item.message !== "string") return [];
    const guidance = guidanceFromJson(item.guidance ?? null);
    const level = item.level === "warning" || item.level === "ok" ? item.level : "critical";
    return [
      {
        level,
        source,
        code: item.code,
        message: item.message,
        detail: (item.detail ?? {}) as HealthFinding["detail"],
        observedAt: typeof item.observedAt === "string" ? new Date(item.observedAt) : new Date(),
        ...(guidance ? { guidance } : {}),
      } satisfies HealthFinding,
    ];
  });
}

export function restoredSetupFindings(stored: JsonObject[]): JsonObject[] {
  return stored.map((item) => {
    const guidance = guidanceFromJson(item.guidance ?? null);
    const restored: JsonObject = { ...item };
    if (guidance) {
      restored.guidance = {
        state: guidance.state,
        fix: guidance.fix,
        confirm: guidance.confirm,
        ...(guidance.url ? { url: guidance.url } : {}),
      };
    } else {
      delete restored.guidance;
    }
    return restored;
  });
}
