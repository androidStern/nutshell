import { resolve } from "node:path";
import { expandHome } from "../config/config";
import { DEFAULT_APP_PATH } from "../core/product";
import { appExecutable, inspectNutshellApp, runNutshellAppCommand } from "../macos/app-status";
import { runProcess } from "../runtime/process";
import type { HostCapabilities, HostRunResult, MacAppStatus } from "./types";

const DEFAULT_APP = DEFAULT_APP_PATH;

export class DefaultHostCapabilities implements HostCapabilities {
  constructor(private readonly appPath: string = DEFAULT_APP) {}

  readonly macos =
    process.platform === "darwin"
      ? {
          openPrivacyPane: async (pane?: string) => {
            const target = pane ? privacyUrl(pane) : "x-apple.systempreferences:com.apple.preference.security?Privacy";
            await this.openUrl(target);
          },
          showNutshellPermissionWindow: async () => {
            await this.openApp(this.appPath);
          },
          appStatus: async () => {
            const status = await inspectNutshellApp({ root: "", path: "", data: { app: { path: this.appPath } } });
            return {
              installed: status.installed,
              path: status.path,
              fullDiskAccess: status.fullDiskAccess,
              backgroundSync: status.backgroundSync,
              agent: status.agent,
              raw: status.raw,
            };
          },
        }
      : undefined;

  async openUrl(url: string): Promise<void> {
    const command = process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
    await runProcess([command, url], { timeoutMs: 30_000 });
  }

  async revealPath(path: string): Promise<void> {
    const resolved = resolve(expandHome(path));
    if (process.platform === "darwin") await runProcess(["/usr/bin/open", "-R", resolved], { timeoutMs: 30_000 });
    else await runProcess(["/usr/bin/open", resolved], { timeoutMs: 30_000 });
  }

  async openApp(pathOrBundleId: string): Promise<void> {
    if (pathOrBundleId.includes("/")) {
      await runProcess(["/usr/bin/open", resolve(expandHome(pathOrBundleId))], { timeoutMs: 30_000 });
      return;
    }
    await runProcess(["/usr/bin/open", "-a", pathOrBundleId], { timeoutMs: 30_000 });
  }

  async chooseFile(input: { title: string; allowedExtensions?: string[] }): Promise<string | null> {
    if (process.platform !== "darwin") return null;
    const extensions = input.allowedExtensions?.length
      ? ` of type {${input.allowedExtensions.map((item) => JSON.stringify(item.replace(/^\./, ""))).join(", ")}}`
      : "";
    const script = `POSIX path of (choose file with prompt ${JSON.stringify(input.title)}${extensions})`;
    const result = await runProcess(["/usr/bin/osascript", "-e", script], { timeoutMs: 5 * 60_000 });
    if (result.code !== 0) return null;
    return result.stdout.trim() || null;
  }

  async run(input: { command: string; args: string[]; timeoutMs?: number }): Promise<HostRunResult> {
    const appPath = resolve(expandHome(this.appPath));
    if (process.platform === "darwin" && input.command === appExecutable(appPath)) {
      const result = await runNutshellAppCommand(appPath, input.args, input.timeoutMs ?? 30_000);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    }
    return runProcess([input.command, ...input.args], { timeoutMs: input.timeoutMs ?? 30_000 });
  }
}

function privacyUrl(pane: string): string {
  const normalized = pane.toLowerCase();
  if (normalized.includes("automation")) return "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";
  if (normalized.includes("full") || normalized.includes("disk")) return "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
  return "x-apple.systempreferences:com.apple.preference.security?Privacy";
}
