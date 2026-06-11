import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type StepStatus = "pass" | "fail" | "skip";

interface BattleStep {
  name: string;
  status: StepStatus;
  detail: Record<string, unknown>;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface InstalledProduct {
  temp: string;
  home: string;
  root: string;
  config: string;
  binDir: string;
  appDir: string;
  cli: string;
  app: string;
  appExecutable: string;
}

const repo = resolve(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "nutshell-battle-"));
const report: BattleStep[] = [];
let installed: InstalledProduct | null = null;

await step("release tarball installs into a clean user home", async () => {
  installed = await installReleaseTarball();
  return {
    home: installed.home,
    cli: installed.cli,
    app: installed.app,
    appIncluded: existsSync(installed.appExecutable),
  };
});

await step("installed command is on PATH and exposes the public CLI", async () => {
  const product = requireInstalled();
  const env = productEnv(product);
  const which = await runText(["sh", "-lc", "command -v nutshell"], env);
  const version = await runText(["nutshell", "--version"], env);
  const help = await runText(["nutshell", "help"], env);
  for (const expected of ["nutshell setup", "nutshell status", "nutshell sync", "nutshell sync pause", "nutshell reset", "nutshell dashboard", "nutshell doctor", "nutshell import"]) {
    if (!help.includes(expected)) throw new Error(`help is missing ${expected}`);
  }
  for (const forbidden of forbiddenPublicCommands()) {
    if (help.includes(forbidden)) throw new Error(`help exposes removed command surface: ${forbidden}`);
  }
  return { which: which.trim(), version: version.trim(), helpLines: help.trim().split("\n").length };
});

await step("removed commands still fail through the installed command", async () => {
  const product = requireInstalled();
  const env = productEnv(product);
  const commands = [
    ["nutshell", "init"],
    ["nutshell", "launchd", "status"],
    ["nutshell", "launchd", "install"],
    ["nutshell", "launchd", "uninstall"],
    ["nutshell", "enrich", "twitter", "--json"],
    ["nutshell", "migrate", "current"],
    ["nutshell", "legacy", "status"],
    ["nutshell", "backfill", "waive", "youtube"],
    ["nutshell", "import", "canonical", "--source", "podcasts", "--path", "anything"],
  ];
  const failures: Array<{ command: string; code: number }> = [];
  for (const command of commands) {
    const result = await run(command, env, 30_000);
    if (result.code === 0) throw new Error(`removed command succeeded: ${command.join(" ")}`);
    failures.push({ command: command.join(" "), code: result.code });
  }
  return { checked: failures.length, failures };
});

await step("health runs against the installed product without live plugin side effects", async () => {
  const product = requireInstalled();
  const result = await run(["nutshell", "health", "--json"], productEnv(product), 60_000);
  const parsed = parseJson(result.stdout);
  const app = objectAt(parsed, "app");
  const health = stringAt(parsed, "status");
  if (!app.installed) throw new Error("health did not inspect the installed app helper");
  if (stringAt(app, "path") !== product.app) throw new Error("health inspected a different app path");
  return { exitCode: result.code, health, app: summarizeApp(app) };
});

await step("dashboard server boots from the installed command and serves product APIs", async () => {
  const product = requireInstalled();
  const dashboard = await startDashboard(product);
  try {
    const status = await fetchJson(new URL("/api/status", dashboard.url).toString());
    const sources = await fetchJson(new URL("/api/sources", dashboard.url).toString());
    const health = objectAt(status, "health");
    const app = objectAt(status, "app");
    if (stringAt(status, "product") !== "nutshell") throw new Error("dashboard status has the wrong product name");
    if (!app.installed) throw new Error("dashboard status did not include the app helper");
    if (!Array.isArray(sources.sources) || sources.sources.length !== 0) {
      throw new Error("dashboard test config should have no enabled live plugins");
    }
    return { url: dashboard.url, health: stringAt(health, "status"), app: summarizeApp(app) };
  } finally {
    await dashboard.stop();
  }
});

await step("installed app helper reports its protected-access state", async () => {
  if (process.platform !== "darwin") return skip("macOS app helper only exists on Darwin");
  const product = requireInstalled();
  const status = await runText([product.appExecutable, "status"], productEnv(product), 30_000);
  for (const expected of ["App:", "Bundle ID:", "Agent status:", "Full Disk Access:", "Background sync:", "Data root:"]) {
    if (!status.includes(expected)) throw new Error(`app status is missing ${expected}`);
  }
  return parseAppStatus(status);
});

await step("installed app owns explicit protected sync commands", async () => {
  if (process.platform !== "darwin") return skip("protected sync command only runs on Darwin");
  const product = requireInstalled();
  const env = protectedProductEnv(product);
  const status = parseAppStatus(await runText([product.appExecutable, "status"], env, 30_000));
  if (status.fullDiskAccess !== "granted") {
    if (process.env.NUTSHELL_BATTLE_REQUIRE_PROTECTED === "1") {
      throw new Error("Full Disk Access is not granted to the installed app helper");
    }
    return skip("Full Disk Access is not granted; set NUTSHELL_BATTLE_REQUIRE_PROTECTED=1 to fail instead of skip");
  }

  const sources = ["podcasts", "apple_notes"];
  const results: Array<Record<string, unknown>> = [];
  for (const source of sources) {
    const result = await run([product.appExecutable, "__sync-once", source], env, 180_000);
    if (result.code !== 0) throw new Error(`${source} protected sync command failed\n${result.stdout}${result.stderr}`);
    const sync = parseJson(result.stdout);
    if (stringAt(sync, "status") === "critical") throw new Error(`${source} protected sync command returned critical`);
    const sourceReports = Array.isArray(sync.sources) ? sync.sources : [];
    const sourceReport = sourceReports.find((item) => objectAt(item, "").source === source || (item && typeof item === "object" && "source" in item && item.source === source));
    results.push({
      source,
      status: stringAt(sync, "status"),
      sourceStatus: sourceReport && typeof sourceReport === "object" && "status" in sourceReport ? sourceReport.status : "unknown",
      exitCode: result.code,
    });
  }
  return { fullDiskAccess: status.fullDiskAccess, syncs: results };
});

writeReport();
const failed = report.filter((item) => item.status === "fail");
process.stdout.write(`${JSON.stringify({ status: failed.length ? "fail" : "pass", reportPath: reportPath(), report }, null, 2)}\n`);
if (!failed.length) rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);

async function step(name: string, fn: () => Promise<Record<string, unknown> | Skipped>): Promise<void> {
  try {
    const detail = await fn();
    if (detail instanceof Skipped) report.push({ name, status: "skip", detail: { reason: detail.reason } });
    else report.push({ name, status: "pass", detail });
  } catch (error) {
    report.push({ name, status: "fail", detail: { error: String(error instanceof Error ? error.stack ?? error.message : error) } });
  }
}

class Skipped {
  constructor(readonly reason: string) {}
}

function skip(reason: string): Skipped {
  return new Skipped(reason);
}

async function installReleaseTarball(): Promise<InstalledProduct> {
  const tarball = releaseTarballPath();
  if (!existsSync(tarball)) throw new Error(`release tarball is missing: ${tarball}. Run bun run certify:release first.`);
  const extractDir = join(tmp, "extract");
  mkdirSync(extractDir, { recursive: true });
  await runOk(["tar", "-xzf", tarball, "-C", extractDir], {}, 60_000);
  const stage = join(extractDir, basename(tarball, ".tar.gz"));
  const home = join(tmp, "home");
  const root = join(home, "Nutshell");
  const config = join(home, "nutconfig.jsonc");
  const binDir = join(home, ".local", "bin");
  const appDir = join(home, "Applications");
  mkdirSync(home, { recursive: true });
  await runOk(["sh", join(stage, "install.sh")], { HOME: home, NUTSHELL_INSTALL_BIN: binDir, NUTSHELL_INSTALL_APP_DIR: appDir, PATH: `${binDir}:${process.env.PATH ?? ""}` }, 60_000);
  const product: InstalledProduct = {
    temp: tmp,
    home,
    root,
    config,
    binDir,
    appDir,
    cli: join(binDir, "nutshell"),
    app: join(appDir, "Nutshell.app"),
    appExecutable: join(appDir, "Nutshell.app", "Contents", "MacOS", "Nutshell"),
  };
  writeBattleConfig(product);
  if (!existsSync(product.cli)) throw new Error("installed CLI is missing");
  if (process.platform === "darwin" && !existsSync(product.appExecutable)) throw new Error("installed app helper is missing");
  return product;
}

function writeBattleConfig(product: InstalledProduct): void {
  mkdirSync(product.root, { recursive: true });
  writeFileSync(
    product.config,
    `${JSON.stringify(
      {
        version: 1,
        scheduler: { intervalSeconds: 900 },
        storage: { root: product.root },
        app: { path: product.app },
        dashboard: { remoteMedia: false },
        plugins: {
          youtube: { enabled: false },
          podcasts: { enabled: false },
          apple_notes: { enabled: false },
          twitter: { enabled: false },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function requireInstalled(): InstalledProduct {
  if (!installed) throw new Error("release tarball was not installed");
  return installed;
}

function productEnv(product: InstalledProduct): Record<string, string> {
  return {
    HOME: product.home,
    PATH: `${product.binDir}:${process.env.PATH ?? ""}`,
    NUTSHELL_ROOT: product.root,
    NUTSHELL_CONFIG: product.config,
    NUTSHELL_APP_PATH: product.app,
  };
}

function protectedProductEnv(product: InstalledProduct): Record<string, string> {
  return {
    ...productEnv(product),
    HOME: process.env.HOME ?? product.home,
  };
}

async function startDashboard(product: InstalledProduct): Promise<{ url: string; stop(): Promise<void> }> {
  const port = freePort();
  const url = `http://127.0.0.1:${port}/`;
  const proc = Bun.spawn(["nutshell", "dashboard", "--no-open", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...productEnv(product) },
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  await waitForDashboardApi(url, proc, 30_000);
  return {
    url,
    async stop() {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, delay(2_000)]);
      if (!(await exited(proc))) proc.kill("SIGKILL");
      const stdout = await stdoutPromise.catch(() => "");
      const stderr = await stderrPromise.catch(() => "");
      if (stdout.trim()) {
        report.push({ name: "dashboard stdout", status: "pass", detail: { stdout: stdout.trim() } });
      }
      if (stderr.trim()) {
        report.push({ name: "dashboard stderr", status: "pass", detail: { stderr: stderr.trim() } });
      }
    },
  };
}

async function waitForDashboardApi(url: string, proc: Bun.Subprocess<"ignore", "pipe", "pipe">, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exited(proc)) break;
    try {
      await fetchJson(new URL("/api/status", url).toString());
      return;
    } catch {
      await delay(250);
    }
  }
  proc.kill("SIGKILL");
  throw new Error(`dashboard did not answer /api/status within ${timeoutMs}ms at ${url}`);
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

async function runOk(cmd: string[], env: Record<string, string> = {}, timeoutMs = 30_000): Promise<CommandResult> {
  const result = await run(cmd, env, timeoutMs);
  if (result.code !== 0) throw new Error(`${cmd.join(" ")} failed with ${result.code}\n${result.stdout}${result.stderr}`);
  return result;
}

async function runText(cmd: string[], env: Record<string, string> = {}, timeoutMs = 30_000): Promise<string> {
  const result = await runOk(cmd, env, timeoutMs);
  return result.stdout;
}

async function run(cmd: string[], env: Record<string, string> = {}, timeoutMs = 30_000): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

async function exited(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<boolean> {
  const result = await Promise.race([proc.exited.then(() => true), delay(0).then(() => false)]);
  return result;
}

function freePort(): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  const port = server.port;
  server.stop(true);
  if (typeof port !== "number") throw new Error("Bun did not allocate a dashboard test port");
  return port;
}

function parseJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("expected JSON output, received empty output");
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`expected JSON output but parsing failed: ${String(error)}\n${trimmed.slice(0, 500)}`);
  }
}

function parseAppStatus(raw: string): Record<string, string> {
  return {
    app: valueAfter(raw, "App"),
    bundleId: valueAfter(raw, "Bundle ID"),
    agentStatus: valueAfter(raw, "Agent status"),
    fullDiskAccess: valueAfter(raw, "Full Disk Access"),
    backgroundSync: valueAfter(raw, "Background sync"),
    dataRoot: valueAfter(raw, "Data root"),
  };
}

function summarizeApp(app: Record<string, unknown>): Record<string, unknown> {
  return {
    installed: app.installed,
    fullDiskAccess: app.fullDiskAccess,
    backgroundSync: app.backgroundSync,
    agent: app.agent,
    path: app.path,
  };
}

function valueAfter(raw: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  if (key === "" && value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const child = (value as Record<string, unknown>)[key];
  if (!child || typeof child !== "object" || Array.isArray(child)) return {};
  return child as Record<string, unknown>;
}

function stringAt(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "string" ? child : "";
}

function releaseTarballPath(): string {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  const platform = process.platform === "darwin" ? "darwin" : process.platform;
  return join(repo, "dist", "release", `nutshell-${pkg.version}-${platform}-${process.arch}.tar.gz`);
}

function forbiddenPublicCommands(): string[] {
  return ["init", "launchd", "migrate", "legacy", "waive", "preserve", "canonical", "repair-plan", "enrich"];
}

function reportPath(): string {
  return join(repo, "dist", "release", "battle-test-report.json");
}

function writeReport(): void {
  mkdirSync(join(repo, "dist", "release"), { recursive: true });
  writeFileSync(reportPath(), `${JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2)}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
