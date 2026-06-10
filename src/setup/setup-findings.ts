import type { HealthFinding, SourceId } from "../core/types";
import { CLI_NAME } from "../core/product";
import { FindingCatalog, guidanceFromSpec } from "../health/guidance";
import { finding } from "../plugins/interface";

const SETUP = `${CLI_NAME} setup`;

// One code = one user state = one fix. Every problem finding the setup runtime
// can emit is declared here so guidance travels with the finding.
export const SETUP_FINDINGS = new FindingCatalog("system", {
  plugin_setup_timeout: {
    level: "critical",
    state: "blocked_bug",
    fix: `Rerun ${CLI_NAME} setup — the setup step is bounded and can be retried.`,
    confirm: SETUP,
    sample: "Twitter/X setup timed out",
  },
  plugin_setup_failed: {
    level: "critical",
    state: "blocked_bug",
    fix: `Rerun ${CLI_NAME} setup; the finding detail shows the error that stopped this source.`,
    confirm: SETUP,
    sample: "Twitter/X setup failed",
  },
  setup_archive_import_failed: {
    level: "critical",
    state: "blocked_bug",
    fix: `Check the archive file path and rerun the printed ${CLI_NAME} import command.`,
    confirm: `${CLI_NAME} health`,
    sample: "twitter archive import failed",
  },
});

export type SetupFindingCode = Parameters<typeof SETUP_FINDINGS.make>[0];

// Setup findings keep the plugin id as their source, so they cannot go through
// SETUP_FINDINGS.make — this helper attaches the spec's guidance while
// preserving the per-plugin source.
export function setupFinding(
  code: SetupFindingCode,
  source: SourceId,
  message: string,
  detail: HealthFinding["detail"] = {},
): HealthFinding {
  const spec = SETUP_FINDINGS.spec(code);
  return finding(spec.level, source, code, message, detail, new Date(), guidanceFromSpec(spec));
}
