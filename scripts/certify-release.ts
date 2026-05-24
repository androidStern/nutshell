import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type CertStatus = "pass" | "fail" | "skipped";

interface CertStep {
  name: string;
  status: CertStatus;
  detail: Record<string, unknown>;
}

const repo = resolve(import.meta.dir, "..");
const args = new Set(process.argv.slice(2));
const includeHomebrew = args.has("--include-homebrew");
const includeLaunchd = args.has("--include-launchd");
const livePermissionCheck = args.has("--live-permission-check");
const postRebootCheck = args.has("--post-reboot-check");
const freshUserCheck = args.has("--fresh-user-check");
const tmp = mkdtempSync(join(tmpdir(), "nutshell-certify-"));
const report: CertStep[] = [];
const userHome = process.env.HOME || "";

let restoreCommand: string | null = null;
let exitCode = 1;

try {
  restoreCommand = await installedNutshell();
  if (postRebootCheck) {
    await certifyPostReboot();
  } else if (freshUserCheck) {
    await certifyFreshUser();
  } else {
    await certifyLocalhostAvailable();
    await certifyBuild();
    await certifyTarballContents();
    await certifyBunInstall();
    await certifyTarballInstall();
    await certifyHomebrew();
    await certifyNormalLaunchdRestored();
  }
  const failed = report.filter((step) => step.status === "fail");
  exitCode = failed.length ? 1 : 0;
} catch (error) {
  report.push({ name: "unexpected certification crash", status: "fail", detail: { error: String(error) } });
  await restoreLaunchd();
} finally {
  writeReport();
  const failed = report.filter((step) => step.status === "fail");
  process.stdout.write(`${JSON.stringify({ status: failed.length ? "fail" : "pass", report }, null, 2)}\n`);
}

process.exit(exitCode);

async function certifyLocalhostAvailable(): Promise<void> {
  await step("localhost server bind is available for dashboard certification", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    try {
      const url = `http://127.0.0.1:${server.port}/`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`localhost preflight returned HTTP ${response.status}`);
      return { url, status: response.status };
    } finally {
      server.stop(true);
    }
  });
}

async function certifyBuild(): Promise<void> {
  await step("build and tests", async () => {
    await run(["bun", "run", "typecheck"]);
    await run(["bun", "test"]);
    await run(["bun", "run", "lint"]);
    await run(["bun", "run", "build"]);
    await run(["bun", "run", "build:compile"]);
    const signature = await codeSignatureReport(join(repo, "bin", "nutshell"));
    if (requiresStableSignature() && !signature.stableRequirement) {
      throw new Error(`compiled Nutshell binary does not have a stable macOS code-signing identity: ${signature.designatedRequirement}`);
    }
    await run(["bun", "run", "build:tarball"], {
      NUTSHELL_RELEASE_BASE_URL: `file://${join(repo, "dist", "release")}`,
    });
    mkdirSync(join(tmp, "pack"), { recursive: true });
    await run(["bun", "pm", "pack", "--destination", join(tmp, "pack")]);
    const packageManifest = JSON.parse(await runText(["tar", "-xOzf", packageTarballPath(), "package/package.json"])) as {
      dependencies?: Record<string, unknown>;
      files?: string[];
    };
    if (packageManifest.dependencies && Object.keys(packageManifest.dependencies).length) {
      throw new Error("Bun package must not declare runtime dependencies because it installs the compiled binary");
    }
    const packageListing = await runText(["tar", "-tzf", packageTarballPath()]);
    if (!packageListing.includes("package/bin/nutshell")) throw new Error("Bun package missing compiled bin/nutshell");
    if (packageListing.includes("package/src/")) throw new Error("Bun package should not include source files");
    return {
      binary: join(repo, "bin", "nutshell"),
      signature,
      tarball: tarballPath(),
      packageTarball: packageTarballPath(),
    };
  });
}

async function certifyTarballContents(): Promise<void> {
  await step("tarball has standalone binary, installer, uninstaller, checksums, and docs", async () => {
    const tarball = tarballPath();
    const listing = await runText(["tar", "-tzf", tarball]);
    const required = ["bin/nutshell", "install.sh", "uninstall.sh", "README.md", "manifest.json"];
    for (const item of required) {
      if (!listing.includes(`/${item}`)) throw new Error(`tarball missing ${item}`);
    }
    const manifest = JSON.parse(await runText(["tar", "-xOzf", tarball, `${releaseDirName()}/manifest.json`])) as {
      files: Array<{ path: string; sha256: string; size: number }>;
    };
    for (const item of required.filter((path) => path !== "manifest.json")) {
      const file = manifest.files.find((entry) => entry.path === item);
      if (!file?.sha256 || !file.size) throw new Error(`manifest missing checksum for ${item}`);
    }
    if (!existsSync(`${tarball}.sha256`)) throw new Error("external tarball .sha256 file is missing");
    const formula = readFileSync(join(repo, "dist", "release", "homebrew", "nutshell.rb"), "utf8");
    if (formula.includes("example.invalid")) throw new Error("generated Homebrew formula contains placeholder URL");
    return { tarball, files: required, formula: join(repo, "dist", "release", "homebrew", "nutshell.rb") };
  });
}

async function certifyBunInstall(): Promise<void> {
  await step("bun global install from package tarball", async () => {
    const root = join(tmp, "bun-install");
    const home = join(root, "home");
    const bunInstall = join(root, "bun");
    mkdirSync(home, { recursive: true });
    await run(["bun", "install", "-g", packageTarballPath()], {
      HOME: home,
      BUN_INSTALL: bunInstall,
      PATH: `${join(bunInstall, "bin")}:${process.env.PATH ?? ""}`,
    });
    const env = { HOME: home, BUN_INSTALL: bunInstall, PATH: `${join(bunInstall, "bin")}:${process.env.PATH ?? ""}` };
    const command = (await runText(["sh", "-lc", "command -v nutshell"], env)).trim();
    const version = (await runText(["nutshell", "--version"], env)).trim();
    await run(["nutshell", "init"], env);
    const health = await healthJson(["nutshell", "health", "--json"], env);
    const dashboard = await certifyDashboardLaunch("nutshell", env);
    if (!existsSync(join(home, "nutconfig.jsonc"))) throw new Error("nutconfig.jsonc was not created");
    if (!existsSync(join(home, "Nutshell"))) throw new Error("Nutshell data root was not created");
    return { command, version, healthStatus: health.status, dashboard, config: join(home, "nutconfig.jsonc"), root: join(home, "Nutshell") };
  });
}

async function certifyTarballInstall(): Promise<void> {
  if (!includeLaunchd) {
    skip("tarball installer registers launchd", { reason: "pass --include-launchd to modify the user launchd domain" });
    return;
  }
  await step("tarball installer copies stable command and registers launchd", async () => {
    const root = join(tmp, "tarball-install");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const extract = join(root, "extract");
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(extract, { recursive: true });
    await uninstallCurrentLaunchd();
    await run(["tar", "-xzf", tarballPath(), "-C", extract, "--strip-components", "1"]);
    const env = { HOME: home, NUTSHELL_INSTALL_BIN: bin, PATH: `${bin}:${process.env.PATH ?? ""}` };
    await run([join(extract, "install.sh")], env);
    await run(["mv", extract, `${extract}-moved`]);
    const command = (await runText(["sh", "-lc", "command -v nutshell"], env)).trim();
    const version = (await runText(["nutshell", "--version"], env)).trim();
    const launchd = await jsonCommand(["nutshell", "launchd", "status", "--json"], env);
    if (!String(launchd.program).includes(`${bin}/nutshell`)) throw new Error("launchd does not point at installed tarball command");
    const dashboard = await certifyDashboardLaunch("nutshell", env);
    await run([join(`${extract}-moved`, "uninstall.sh")], env);
    return { command, version, dashboard, launchdProgram: launchd.program, configKept: existsSync(join(home, "nutconfig.jsonc")), dataKept: existsSync(join(home, "Nutshell")) };
  });
}

async function certifyHomebrew(): Promise<void> {
  if (!includeHomebrew) {
    skip("Homebrew install, test, service, and reinstall", { reason: "pass --include-homebrew to modify Homebrew and launchd state" });
    return;
  }
  await step("Homebrew install, test, service, and reinstall", async () => {
    const tap = "winterfell/nutshell-certify";
    await uninstallCurrentLaunchd();
    await run(["brew", "uninstall", "--formula", "nutshell"], {}, true);
    await run(["brew", "untap", tap], {}, true);
    await run(["brew", "tap-new", tap], { HOMEBREW_NO_AUTO_UPDATE: "1" });
    const tapRepo = (await runText(["brew", "--repository", tap], { HOMEBREW_NO_AUTO_UPDATE: "1" })).trim();
    await run(["cp", join(repo, "dist", "release", "homebrew", "nutshell.rb"), join(tapRepo, "Formula", "nutshell.rb")]);
    await run(["brew", "install", `${tap}/nutshell`], { HOMEBREW_NO_AUTO_UPDATE: "1" });
    const command = (await runText(["sh", "-lc", "PATH=/opt/homebrew/bin:/usr/bin:/bin command -v nutshell"])).trim();
    const version = (await runText(["sh", "-lc", "PATH=/opt/homebrew/bin:/usr/bin:/bin nutshell --version"])).trim();
    await run(["brew", "test", `${tap}/nutshell`], { HOMEBREW_NO_AUTO_UPDATE: "1" });
    const dashboard = await certifyDashboardLaunch(command, { PATH: "/opt/homebrew/bin:/usr/bin:/bin" });
    await run(["brew", "services", "start", `${tap}/nutshell`], { HOMEBREW_NO_AUTO_UPDATE: "1" });
    await sleep(2000);
    const service = JSON.parse(await runText(["brew", "services", "info", `${tap}/nutshell`, "--json"], { HOMEBREW_NO_AUTO_UPDATE: "1" })) as Array<Record<string, unknown>>;
    if (service[0]?.running !== true || service[0]?.loaded !== true) throw new Error("Homebrew service is not running and loaded");
    if (!String(service[0]?.command ?? "").includes("/opt/homebrew/opt/nutshell/bin/nutshell")) throw new Error("Homebrew service does not use the stable opt command");
    await run(["brew", "services", "stop", `${tap}/nutshell`], { HOMEBREW_NO_AUTO_UPDATE: "1" }, true);
    await waitForNoLock();
    const beforeConfig = fileSha(join(userHome, "nutconfig.jsonc"));
    const beforeStoreSize = fileSize(join(userHome, "Nutshell", "nutshell.sqlite"));
    await run(["brew", "reinstall", `${tap}/nutshell`], { HOMEBREW_NO_AUTO_UPDATE: "1" });
    const afterConfig = fileSha(join(userHome, "nutconfig.jsonc"));
    const afterStoreSize = fileSize(join(userHome, "Nutshell", "nutshell.sqlite"));
    const liveChecks = livePermissionCheck ? await runHomebrewLiveChecks(command) : { skipped: true };
    await run(["brew", "services", "stop", `${tap}/nutshell`], { HOMEBREW_NO_AUTO_UPDATE: "1" }, true);
    await run(["brew", "uninstall", "--formula", "nutshell"], { HOMEBREW_NO_AUTO_UPDATE: "1" }, true);
    await run(["brew", "untap", tap], { HOMEBREW_NO_AUTO_UPDATE: "1" }, true);
    return {
      command,
      version,
      dashboard,
      service: service[0],
      configPreserved: beforeConfig === afterConfig,
      storePreserved: beforeStoreSize === afterStoreSize,
      liveChecks,
    };
  });
}

async function certifyPostReboot(): Promise<void> {
  await step("post-reboot daemon, health, and permission persistence", async () => {
    if (!restoreCommand) throw new Error("nutshell is not installed in PATH");
    const version = (await runText([restoreCommand, "--version"])).trim();
    const signature = await codeSignatureReport(restoreCommand);
    if (requiresStableSignature() && !signature.stableRequirement) {
      throw new Error(`installed Nutshell binary does not have a stable macOS code-signing identity: ${signature.designatedRequirement}`);
    }
    const launchd = await jsonCommand([restoreCommand, "launchd", "status", "--json"]);
    if (launchd.loaded !== true) throw new Error("Nutshell launchd job is not loaded");
    if (launchd.program !== restoreCommand) {
      throw new Error(`Nutshell launchd job points at ${String(launchd.program)} instead of ${restoreCommand}`);
    }
    const rebootProof = await launchdRebootProof(String(launchd.plistPath ?? ""));
    if (!rebootProof.plistPredatesCurrentBoot) {
      throw new Error(
        `Nutshell launchd persistence has not been proven after the current boot; plist modified at ${rebootProof.plistModifiedAt}, current boot at ${rebootProof.bootedAt}`,
      );
    }
    await waitForNoLock();
    const sync = await jsonCommand([restoreCommand, "sync", "all", "--mode", "recent", "--json"]);
    if (sync.status !== "ok") throw new Error(`post-reboot sync returned ${String(sync.status)}`);
    await waitForNoLock();
    const health = await healthJson([restoreCommand, "health", "--json"]);
    if (health.status !== "ok") throw new Error(`post-reboot health returned ${String(health.status)}`);
    const liveChecks = livePermissionCheck ? await runInstalledLiveChecks(restoreCommand) : { skipped: true };
    return {
      version,
      signature,
      launchd: {
        status: launchd.status,
        program: launchd.program,
        lastExitCode: launchd.lastExitCode,
        plistPath: launchd.plistPath,
        rebootProof,
      },
      sync: { status: sync.status, sources: sourceStatuses(sync) },
      health: { status: health.status, findings: Array.isArray(health.findings) ? health.findings.length : null },
      liveChecks,
    };
  });
}

async function certifyFreshUser(): Promise<void> {
  await step("fresh macOS user first-run install surface", async () => {
    if (!restoreCommand) throw new Error("nutshell is not installed in PATH");
    const configPath = join(userHome, "nutconfig.jsonc");
    const rootPath = join(userHome, "Nutshell");
    if (existsSync(configPath) || existsSync(rootPath)) {
      throw new Error(
        `this is not a fresh Nutshell user state; ${configPath} or ${rootPath} already exists`,
      );
    }
    const command = (await runText(["sh", "-lc", "command -v nutshell"])).trim();
    const version = (await runText([restoreCommand, "--version"])).trim();
    const help = await runText([restoreCommand, "help"]);
    if (help.includes("--root")) throw new Error("help leaks --root into the normal user surface");
    await run([restoreCommand, "init"]);
    if (!existsSync(configPath)) throw new Error("fresh user init did not create ~/nutconfig.jsonc");
    if (!existsSync(rootPath)) throw new Error("fresh user init did not create ~/Nutshell");
    const health = await healthJson([restoreCommand, "health", "--json"]);
    assertPermissionFindingsAreActionable(health);
    const liveProbe = livePermissionCheck ? await runInstalledLiveChecks(restoreCommand, true) : { skipped: true };
    return {
      command,
      version,
      configPath,
      rootPath,
      health: { status: health.status, findings: Array.isArray(health.findings) ? health.findings.length : null },
      liveProbe,
    };
  });
}

async function certifyNormalLaunchdRestored(): Promise<void> {
  await step("normal Nutshell launchd job restored", async () => {
    await restoreLaunchd();
    if (!restoreCommand) return { restored: false, reason: "no pre-existing nutshell command was found" };
    const status = await jsonCommand([restoreCommand, "launchd", "status", "--json"]);
    if (status.loaded !== true) throw new Error("normal Nutshell launchd job is not loaded after certification cleanup");
    if (status.program !== restoreCommand) {
      throw new Error(`normal Nutshell launchd job points at ${String(status.program)} instead of ${restoreCommand}`);
    }
    return {
      restored: true,
      status: status.status,
      program: status.program,
      lastExitCode: status.lastExitCode,
    };
  });
}

async function runHomebrewLiveChecks(command: string): Promise<Record<string, unknown>> {
  const env = { NUTSHELL_CONFIG: join(userHome, "nutconfig.jsonc"), PATH: "/opt/homebrew/bin:/usr/bin:/bin" };
  const podcasts = await jsonCommand([command, "sync", "podcasts", "--mode", "recent", "--json"], env);
  assertPermissionFindingsAreActionable(podcasts);
  const notes = await jsonCommand([command, "sync", "apple_notes", "--mode", "recent", "--json"], env);
  assertPermissionFindingsAreActionable(notes);
  return {
    podcasts: sourceStatuses(podcasts),
    appleNotes: sourceStatuses(notes),
  };
}

async function runInstalledLiveChecks(command: string, allowPermissionFindings = false): Promise<Record<string, unknown>> {
  const podcasts = await jsonCommand([command, "sync", "podcasts", "--mode", "recent", "--json"]);
  assertPermissionFindingsAreActionable(podcasts);
  if (!allowPermissionFindings && podcasts.status !== "ok") throw new Error(`podcasts live check returned ${String(podcasts.status)}`);
  const notes = await jsonCommand([command, "sync", "apple_notes", "--mode", "recent", "--json"]);
  assertPermissionFindingsAreActionable(notes);
  if (!allowPermissionFindings && notes.status !== "ok") throw new Error(`Apple Notes live check returned ${String(notes.status)}`);
  return {
    podcasts: sourceStatuses(podcasts),
    appleNotes: sourceStatuses(notes),
  };
}

function assertPermissionFindingsAreActionable(reportJson: Record<string, unknown>): void {
  const findings = findingsFromReport(reportJson);
  for (const finding of findings) {
    const code = String(finding.code ?? "");
    if (!/permission|required|auth|denied/i.test(code)) continue;
    const message = String(finding.message ?? "");
    const detail = finding.detail && typeof finding.detail === "object" && !Array.isArray(finding.detail) ? (finding.detail as Record<string, unknown>) : {};
    const nextAction = String(detail.nextAction ?? "");
    const text = `${message} ${nextAction}`;
    if (!/System Settings|Full Disk Access|Automation|Privacy & Security/i.test(text) || !/nutshell/i.test(text)) {
      throw new Error(`permission finding ${code} is not actionable enough: ${text}`);
    }
  }
}

function findingsFromReport(reportJson: Record<string, unknown>): Array<Record<string, unknown>> {
  const direct = Array.isArray(reportJson.findings) ? reportJson.findings : [];
  const sources = Array.isArray(reportJson.sources) ? reportJson.sources : [];
  const nested = sources.flatMap((source) => {
    const sourceObject = source && typeof source === "object" && !Array.isArray(source) ? (source as Record<string, unknown>) : {};
    return Array.isArray(sourceObject.findings) ? sourceObject.findings : [];
  });
  return [...direct, ...nested].filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
}

async function step(name: string, runStep: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    const detail = await runStep();
    report.push({ name, status: "pass", detail });
  } catch (error) {
    report.push({ name, status: "fail", detail: { error: String(error) } });
  }
}

function skip(name: string, detail: Record<string, unknown>): void {
  report.push({ name, status: "skipped", detail });
}

async function run(cmd: string[], env: Record<string, string> = {}, allowFailure = false): Promise<void> {
  const result = await runResult(cmd, env);
  if (!allowFailure && result.code !== 0) throw new Error(`${cmd.join(" ")} failed\n${result.stdout}${result.stderr}`);
}

async function runText(cmd: string[], env: Record<string, string> = {}): Promise<string> {
  const result = await runResult(cmd, env);
  if (result.code !== 0) throw new Error(`${cmd.join(" ")} failed\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

async function runResult(cmd: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function jsonCommand(cmd: string[], env: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const result = await runResult(cmd, env);
  if (result.code > 2) throw new Error(`${cmd.join(" ")} failed\n${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function healthJson(cmd: string[], env: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const result = await runResult(cmd, env);
  if (result.code > 2) throw new Error(`${cmd.join(" ")} failed\n${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function certifyDashboardLaunch(command: string, env: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const proc = Bun.spawn([command, "dashboard", "--no-open", "--port", "0"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  try {
    const url = await readFirstStdoutLine(proc.stdout, 10_000);
    if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) {
      throw new Error(`dashboard did not print a localhost URL: ${url}`);
    }
    const root = await fetch(url);
    if (!root.ok) throw new Error(`dashboard root returned HTTP ${root.status}`);
    const html = await root.text();
    if (!html.includes("Your trace, organized by day")) throw new Error("dashboard root did not render the expected UI");
    const configResponse = await fetch(new URL("/api/config", url));
    if (!configResponse.ok) throw new Error(`dashboard config API returned HTTP ${configResponse.status}`);
    const config = (await configResponse.json()) as Record<string, unknown>;
    return {
      url,
      rootRendered: true,
      configPath: config.path ?? null,
      root: config.root ?? null,
    };
  } catch (error) {
    const stderr = await Promise.race([new Response(proc.stderr).text(), sleep(1000).then(() => "")]);
    throw new Error(`${String(error)}${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
  } finally {
    proc.kill();
    await proc.exited.catch(() => undefined);
  }
}

async function readFirstStdoutLine(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const readLoop = async () => {
    while (!text.includes("\n")) {
      const result = await reader.read();
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
    const line = text.trim().split("\n")[0] ?? "";
    if (!line) throw new Error("dashboard printed no URL");
    return line;
  };
  return Promise.race([
    readLoop(),
    sleep(timeoutMs).then(() => {
      throw new Error("timed out waiting for dashboard URL");
    }),
  ]);
}

async function installedNutshell(): Promise<string | null> {
  const preferred = join(userHome, ".local", "bin", "nutshell");
  if (existsSync(preferred)) return preferred;
  const result = await runResult(["sh", "-lc", "command -v nutshell"]);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function codeSignatureReport(path: string): Promise<Record<string, unknown> & { stableRequirement: boolean; designatedRequirement: string }> {
  if (process.platform !== "darwin") {
    return { platform: process.platform, stableRequirement: true, designatedRequirement: "not applicable" };
  }
  const details = await runResult(["codesign", "-dv", "--verbose=4", path]);
  const requirement = await runResult(["codesign", "-dr", "-", path]);
  const combinedDetails = `${details.stdout}${details.stderr}`;
  const combinedRequirement = `${requirement.stdout}${requirement.stderr}`;
  const designatedRequirement = combinedRequirement
    .split("\n")
    .find((line) => line.includes("designated =>"))
    ?.replace(/^.*designated =>\s*/, "")
    .trim() || "";
  const identifier = combinedDetails.match(/^Identifier=(.+)$/m)?.[1]?.trim() || null;
  const authority = combinedDetails.match(/^Authority=(.+)$/m)?.[1]?.trim() || null;
  const teamIdentifier = combinedDetails.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null;
  const stableRequirement = requirement.code === 0 && Boolean(identifier) && Boolean(teamIdentifier) && !/^cdhash\s/.test(designatedRequirement);
  return { path, identifier, authority, teamIdentifier, designatedRequirement, stableRequirement };
}

async function launchdRebootProof(plistPath: string): Promise<Record<string, unknown>> {
  if (!plistPath || !existsSync(plistPath)) throw new Error(`Nutshell launchd plist is missing at ${plistPath || "<unknown>"}`);
  const bootedAt = await currentBootTime();
  const plistModifiedAt = statSync(plistPath).mtime;
  return {
    plistPath,
    bootedAt: bootedAt.toISOString(),
    plistModifiedAt: plistModifiedAt.toISOString(),
    plistPredatesCurrentBoot: plistModifiedAt.getTime() < bootedAt.getTime(),
  };
}

async function currentBootTime(): Promise<Date> {
  const raw = await runText(["sysctl", "-n", "kern.boottime"]);
  const match = raw.match(/sec\s*=\s*(\d+)/);
  if (!match?.[1]) throw new Error(`could not parse macOS boot time from sysctl output: ${raw.trim()}`);
  return new Date(Number(match[1]) * 1000);
}

async function uninstallCurrentLaunchd(): Promise<void> {
  if (!restoreCommand) return;
  await run([restoreCommand, "launchd", "uninstall"], {}, true);
}

async function restoreLaunchd(): Promise<void> {
  if (includeHomebrew) {
    await run(["brew", "services", "stop", "winterfell/nutshell-certify/nutshell"], { HOMEBREW_NO_AUTO_UPDATE: "1" }, true).catch(() => undefined);
    await run(["brew", "uninstall", "--formula", "nutshell"], { HOMEBREW_NO_AUTO_UPDATE: "1" }, true).catch(() => undefined);
    await run(["brew", "untap", "winterfell/nutshell-certify"], { HOMEBREW_NO_AUTO_UPDATE: "1" }, true).catch(() => undefined);
  }
  if (restoreCommand && existsSync(restoreCommand)) {
    await run([restoreCommand, "launchd", "install"], {}, true).catch(() => undefined);
  }
}

function writeReport(): void {
  mkdirSync(join(repo, "dist", "release"), { recursive: true });
  writeFileSync(join(repo, "dist", "release", "certification-report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2)}\n`);
}

function tarballPath(): string {
  return join(repo, "dist", "release", `${releaseDirName()}.tar.gz`);
}

function releaseDirName(): string {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  return `nutshell-${pkg.version}-${process.platform === "darwin" ? "darwin" : process.platform}-${process.arch}`;
}

function packageTarballPath(): string {
  const files = readdirSync(join(tmp, "pack")).filter((file) => file.endsWith(".tgz"));
  if (!files.length) throw new Error("package tarball was not generated");
  return join(tmp, "pack", files[0]!);
}

function fileSha(path: string): string | null {
  if (!existsSync(path)) return null;
  return Bun.hash(readFileSync(path)).toString(16);
}

function fileSize(path: string): number | null {
  if (!existsSync(path)) return null;
  return readFileSync(path).byteLength;
}

function sourceStatuses(reportJson: Record<string, unknown>): Array<Record<string, unknown>> {
  const sources = Array.isArray(reportJson.sources) ? reportJson.sources : [];
  return sources.map((source) => {
    const item = source as Record<string, unknown>;
    return { source: item.source, status: item.status, metrics: item.metrics };
  });
}

function requiresStableSignature(): boolean {
  return process.platform === "darwin" && process.env.NUTSHELL_CODESIGN !== "skip";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForNoLock(): Promise<void> {
  const lockPath = join(userHome, "Nutshell", "run.lock");
  for (let i = 0; i < 24; i += 1) {
    if (!existsSync(lockPath)) return;
    if (removeStaleLock(lockPath)) return;
    await sleep(2500);
  }
  throw new Error(`timed out waiting for ${lockPath} to clear`);
}

function removeStaleLock(lockPath: string): boolean {
  try {
    const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
    if (!payload.pid || !pidAlive(payload.pid)) {
      unlinkSync(lockPath);
      return true;
    }
  } catch {
    try {
      unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
