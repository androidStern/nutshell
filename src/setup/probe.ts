import { existsSync } from "node:fs";
import type { HealthFinding, PluginContext, TraceLogger } from "../core/types";
import { PRODUCT_NAME } from "../core/product";
import type { TraceConfig } from "../config/config";
import { pluginConfig } from "../config/config";
import { guidanceFromJson } from "../health/guidance";
import { systemFinding } from "../health/system-findings";
import { appExecutable, ensureStableAppPath, runNutshellAppCommand } from "../macos/app-status";
import type { TracePlugin } from "../plugins/interface";
import { redactText } from "../core/redaction";
import { setupFinding } from "./setup-findings";

// Bounded by the Swift app's __probe timeout (120s) plus launch overhead.
const APP_PROBE_TIMEOUT_MS = 150_000;

// Generic plugin verification for setup. On macOS with the app installed, the
// probe runs through the Nutshell.app identity (hidden `__probe` bridge), so
// Keychain, automation, and Full Disk Access attach to the app — never to the
// terminal. The probe itself is always the plugin's own check().
export interface SetupProber {
  probe(plugin: TracePlugin, signal: AbortSignal): Promise<HealthFinding[]>;
}

export class DefaultSetupProber implements SetupProber {
  constructor(
    private readonly config: TraceConfig,
    private readonly logger: TraceLogger,
  ) {}

  async probe(plugin: TracePlugin, signal: AbortSignal): Promise<HealthFinding[]> {
    if (process.platform !== "darwin") {
      return plugin.check(probePluginContext(this.config, plugin, this.logger, signal));
    }
    const appPath = ensureStableAppPath(this.config);
    if (!existsSync(appExecutable(appPath))) {
      return [
        systemFinding(
          "nutshell_app_missing",
          plugin.manifest.id,
          `${PRODUCT_NAME}.app is not installed, so ${plugin.manifest.displayName} cannot be verified yet`,
          { appPath },
        ),
      ];
    }
    const result = await runNutshellAppCommand(appPath, ["__probe", plugin.manifest.id, "--json"], APP_PROBE_TIMEOUT_MS);
    const findings = parseProbeFindings(result.stdout);
    if (findings) return findings;
    return [
      setupFinding(
        "plugin_probe_unavailable",
        plugin.manifest.id,
        `${plugin.manifest.displayName} could not be probed through ${PRODUCT_NAME}.app`,
        {
          code: result.code,
          timedOut: result.timedOut,
          stderr: redactText(result.stderr.slice(-800)),
          stdout: redactText(result.stdout.slice(-400)),
        },
      ),
    ];
  }
}

export function parseProbeFindings(stdout: string): HealthFinding[] | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as { findings?: unknown };
    if (!Array.isArray(parsed.findings)) return null;
    const findings: HealthFinding[] = [];
    for (const raw of parsed.findings) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const record = raw as { [key: string]: unknown };
      if (typeof record.level !== "string" || typeof record.code !== "string" || typeof record.message !== "string") return null;
      const guidance = record.guidance ? guidanceFromJson(record.guidance as never) : undefined;
      findings.push({
        level: record.level as HealthFinding["level"],
        source: typeof record.source === "string" ? record.source : "system",
        code: record.code,
        message: record.message,
        detail: (record.detail ?? {}) as HealthFinding["detail"],
        observedAt: typeof record.observedAt === "string" ? new Date(record.observedAt) : new Date(),
        ...(guidance ? { guidance } : {}),
      });
    }
    return findings;
  } catch {
    return null;
  }
}

export function probePluginContext(config: TraceConfig, plugin: TracePlugin, logger: TraceLogger, signal: AbortSignal): PluginContext {
  return {
    root: config.root,
    config: pluginConfig(config, plugin.manifest.id),
    logger,
    signal,
    now: () => new Date(),
    records: {
      query: async () => ({ records: [], total: 0, limit: 0, offset: 0 }),
    },
    writeArtifact: async () => {
      throw new Error("probe cannot write artifacts");
    },
  };
}
