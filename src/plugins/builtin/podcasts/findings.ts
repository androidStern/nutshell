import { CLI_NAME, PRODUCT_NAME } from "../../../core/product";
import { FindingCatalog } from "../../../health/guidance";

const CONFIRM = `${CLI_NAME} doctor podcasts`;

export const PODCASTS_FINDINGS = new FindingCatalog("podcasts", {
  podcasts_db_missing: {
    level: "critical",
    state: "ready_empty",
    fix: `Open the Apple Podcasts app and play any episode to create the local library, then retry. If you do not use Apple Podcasts, disable this source in ${CLI_NAME} setup.`,
    confirm: CONFIRM,
    sample: "Apple Podcasts database is missing",
  },
  podcasts_full_disk_access_required: {
    level: "critical",
    state: "needs_permission",
    fix: `Grant Full Disk Access to ${PRODUCT_NAME}.app — rerun ${CLI_NAME} setup, or open System Settings → Privacy & Security → Full Disk Access and turn on ${PRODUCT_NAME}.`,
    confirm: CONFIRM,
    sample: "Apple Podcasts database is blocked by macOS privacy permissions",
  },
  podcasts_permission_blocked: {
    level: "critical",
    state: "needs_permission",
    fix: `Grant Full Disk Access to ${PRODUCT_NAME}.app — rerun ${CLI_NAME} setup, or open System Settings → Privacy & Security → Full Disk Access and turn on ${PRODUCT_NAME}.`,
    confirm: CONFIRM,
    sample: "Apple Podcasts sync is paused until app-data permission is fixed",
  },
  podcasts_db_read_timeout: {
    level: "warning",
    state: "blocked_bug",
    fix: "No action needed — the next scheduled sync retries automatically. If this keeps happening, quit the Apple Podcasts app so the library database is not busy, then retry.",
    confirm: CONFIRM,
    sample: "Apple Podcasts database read probe timed out",
  },
  podcasts_db_read_failed: {
    level: "warning",
    state: "blocked_bug",
    fix: "No action needed — the next scheduled sync retries automatically. If it keeps failing, quit and reopen the Apple Podcasts app, then retry.",
    confirm: CONFIRM,
    sample: "Apple Podcasts database could not be read",
  },
  podcasts_db_timeout: {
    level: "warning",
    state: "blocked_bug",
    fix: "No action needed — the next scheduled sync retries automatically. If timeouts persist, quit the Apple Podcasts app so the library database is not busy, then retry.",
    confirm: CONFIRM,
    sample: "Apple Podcasts database probe timed out",
  },
  podcasts_db_probe_failed: {
    level: "critical",
    state: "blocked_bug",
    fix: `Update ${PRODUCT_NAME} to the latest version — an Apple Podcasts update may have changed the library format — then retry.`,
    confirm: CONFIRM,
    sample: "Apple Podcasts database probe failed",
  },
  podcasts_sync_failed: {
    level: "warning",
    state: "blocked_bug",
    fix: "No action needed — the next scheduled sync retries automatically. If it keeps failing, quit the Apple Podcasts app and retry.",
    confirm: CONFIRM,
    sample: "Apple Podcasts sync failed after retries",
  },
  podcasts_backfill_failed: {
    level: "warning",
    state: "blocked_bug",
    fix: `Run ${CLI_NAME} sync podcasts --mode backfill to retry the backfill. If it keeps failing, quit the Apple Podcasts app first so the library database is not busy.`,
    confirm: CONFIRM,
    sample: "Apple Podcasts backfill failed after retries",
  },
});
