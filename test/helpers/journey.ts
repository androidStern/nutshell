import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSON5 from "json5";
import type { JsonObject } from "../../src/core/types";
import type { SetupReport } from "../../src/setup/types";

// Golden-journey harness (goal criterion 20): drives the REAL interactive
// binary (`bun src/cli.ts setup --json`) through a pseudo-terminal using
// /usr/bin/expect, against a fully hermetic per-journey HOME/root and a fake
// Nutshell.app bundle.
//
// The fake app bundle deliberately has NO Contents/Info.plist:
// runNutshellAppCommand() direct-execs Contents/MacOS/Nutshell when the plist
// is missing, so every app-identity call (status, __probe, enable-sync,
// register-agent, the smoke sync) lands in a scripted shell stub instead of
// LaunchServices. Probe responses are sequenced files under
// <tmp>/probe-state/<source>.<n>.json consumed via a per-source call counter,
// which lets a journey script "fails on call 1, passes on call 2" without
// mutating state mid-run.

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

// The CLI prints the setup report as JSON; Date fields arrive as ISO strings.
// Derived from the runtime SetupReport type so the shapes cannot drift apart.
type Jsonified<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Jsonified<T[K]> } : T;
export type SetupReportJson = Jsonified<SetupReport>;

export interface JourneyStep {
  // Plain ASCII substring of the real binary's output to wait for. Matched
  // exactly by expect against the raw (ANSI-bearing) stream, so it must be a
  // contiguous run of message text — keep it short and distinctive.
  waitFor: string;
  // Key(s) to type once the awaited text rendered. "enter" submits the
  // prompt's current value, "down-enter" moves a select one option down and
  // submits, "no" answers a clack confirm with the n key.
  send?: "enter" | "down-enter" | "no";
}

export interface JourneyRunResult {
  exitCode: number;
  // Full pty capture with ANSI escapes stripped and \r\n normalized to \n.
  text: string;
  // The --json setup report printed by the CLI after the interactive flow.
  report: SetupReportJson;
}

interface FakeAppStatus {
  fullDiskAccess: "granted" | "not granted";
  agent: "enabled" | "notRegistered";
  backgroundSync: "enabled" | "disabled";
}

// One sync report the fake app prints for `sync all --json` (the smoke sync):
// 2 + 1 records across two sources, overall ok.
const FAKE_SYNC_REPORT = {
  status: "ok",
  sources: [
    { source: "youtube", status: "ok", commit: { insertedRecords: 2 } },
    { source: "podcasts", status: "ok", commit: { insertedRecords: 1 } },
  ],
};

export const SMOKE_SYNC_OK_MESSAGE = "smoke sync ok: 3 records across 2 sources";

const SEND_KEYS: Record<NonNullable<JourneyStep["send"]>, string> = {
  enter: "\\r",
  "down-enter": "\\033\\[B\\r",
  no: "n",
};

// Pattern-per-step timeout. Generous for CI, but short enough that a stuck
// journey reports the exact unmatched pattern well before bun's test timeout.
const EXPECT_STEP_TIMEOUT_SECONDS = 10;

export class GoldenJourney {
  readonly home: string;
  readonly root: string;
  readonly configPath: string;
  readonly appPath: string;
  readonly stateDir: string;
  private runs = 0;

  constructor(name: string) {
    this.home = mkdtempSync(join(tmpdir(), `nutshell-golden-${name}-`));
    this.root = join(this.home, "Nutshell");
    this.configPath = join(this.home, "nutconfig.jsonc");
    this.appPath = join(this.home, "Nutshell.app");
    this.stateDir = join(this.home, "probe-state");
    mkdirSync(this.stateDir, { recursive: true });
    this.writeFakeApp();
    this.writeAppStatus({ fullDiskAccess: "granted", agent: "enabled", backgroundSync: "enabled" });
    writeFileSync(join(this.stateDir, "sync-report.json"), `${JSON.stringify(FAKE_SYNC_REPORT)}\n`);
  }

  cleanup(): void {
    rmSync(this.home, { recursive: true, force: true });
  }

  writeAppStatus(status: FakeAppStatus): void {
    const body = [
      `Full Disk Access: ${status.fullDiskAccess}`,
      `Agent status: ${status.agent}`,
      `Background sync: ${status.backgroundSync}`,
      `Data root: ${this.root}`,
    ].join("\n");
    writeFileSync(join(this.stateDir, "app-status.txt"), `${body}\n`);
  }

  // Probe response served for the nth __probe call for this source. Calls
  // beyond the highest written n keep getting the highest one; sources with no
  // responses written probe clean (zero findings).
  writeProbeResponse(source: string, call: number, findings: JsonObject[]): void {
    writeFileSync(join(this.stateDir, `${source}.${call}.json`), `${JSON.stringify({ source, findings }, null, 2)}\n`);
  }

  probeCount(source: string): number {
    const path = join(this.stateDir, `${source}.count`);
    if (!existsSync(path)) return 0;
    return Number(readFileSync(path, "utf8").trim());
  }

  // Every invocation of the fake app executable, one line of args per call.
  appCalls(): string[] {
    const path = join(this.stateDir, "calls.log");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  }

  readConfig(): JsonObject {
    return JSON5.parse(readFileSync(this.configPath, "utf8")) as JsonObject;
  }

  pluginSetup(source: string): JsonObject {
    const config = this.readConfig();
    const plugins = asObject(config.plugins, "plugins");
    const plugin = asObject(plugins[source], `plugins.${source}`);
    return asObject(plugin.setup, `plugins.${source}.setup`);
  }

  async runSetup(steps: JourneyStep[]): Promise<JourneyRunResult> {
    this.runs += 1;
    const scriptPath = join(this.home, `journey-run-${this.runs}.exp`);
    writeFileSync(scriptPath, expectScript(process.execPath, steps));
    const proc = Bun.spawn(["/usr/bin/expect", "-f", scriptPath], {
      cwd: REPO_ROOT,
      env: this.env(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const text = stripAnsi(stdout);
    if (exitCode === 98 || exitCode === 99) {
      throw new Error(
        `expect harness ${exitCode === 99 ? "timed out" : "hit eof"} driving the setup pty.\n${stderr.trim()}\nLast output:\n${text.slice(-2_000)}`,
      );
    }
    return { exitCode, text, report: parseReportJson(text) };
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.HOME = this.home;
    env.NUTSHELL_ROOT = this.root;
    env.NUTSHELL_CONFIG = this.configPath;
    env.NUTSHELL_APP_PATH = this.appPath;
    // Plain output keeps expect patterns and text assertions simple. Clack
    // still emits cursor-control escapes; stripAnsi removes those.
    env.NO_COLOR = "1";
    env.TERM = "xterm-256color";
    delete env.FORCE_COLOR;
    delete env.NUTSHELL_APP_BUNDLE_ID;
    delete env.NUTSHELL_DISABLE_APP_HANDOFF;
    delete env.NUTSHELL_COMMAND;
    return env;
  }

  private writeFakeApp(): void {
    const dir = join(this.appPath, "Contents", "MacOS");
    mkdirSync(dir, { recursive: true });
    const executable = join(dir, "Nutshell");
    writeFileSync(executable, fakeAppScript(this.stateDir));
    chmodSync(executable, 0o755);
  }
}

// A signed-out probe finding shaped exactly like the real youtube_signed_out
// catalog entry (state/fix/confirm authored at the source), minus the url so
// the retry select renders the two-verb [Retry, Skip] form deterministically.
export function signedOutFinding(): JsonObject {
  return {
    level: "critical",
    source: "youtube",
    code: "youtube_signed_out",
    message: "YouTube browser session is signed out",
    detail: {},
    observedAt: "2026-06-10T08:00:00.000Z",
    guidance: {
      state: "needs_auth",
      fix: "Open youtube.com in Chrome and sign into your Google account, then retry.",
      confirm: "nutshell doctor youtube",
    },
  };
}

function fakeAppScript(stateDir: string): string {
  return `#!/bin/sh
# Fake Nutshell.app executable for golden-journey tests. Direct-exec'd by the
# CLI because the bundle has no Info.plist. Reads all behavior from files the
# test writes under the probe-state directory.
set -eu
STATE_DIR=${shellQuote(stateDir)}
printf '%s\\n' "$*" >> "$STATE_DIR/calls.log"
cmd="\${1:-}"
case "$cmd" in
  status)
    cat "$STATE_DIR/app-status.txt"
    ;;
  __probe)
    source="$2"
    count_file="$STATE_DIR/$source.count"
    count=0
    if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    response=""
    i=$count
    while [ "$i" -ge 1 ]; do
      if [ -f "$STATE_DIR/$source.$i.json" ]; then response="$STATE_DIR/$source.$i.json"; break; fi
      i=$((i - 1))
    done
    if [ -n "$response" ]; then cat "$response"; else printf '{"source":"%s","findings":[]}\\n' "$source"; fi
    ;;
  sync)
    cat "$STATE_DIR/sync-report.json"
    ;;
  enable-sync|register-agent)
    ;;
  *)
    echo "fake Nutshell.app: unexpected command: $*" >&2
    exit 64
    ;;
esac
`;
}

function expectScript(bunPath: string, steps: JourneyStep[]): string {
  const lines: string[] = [
    `set timeout ${EXPECT_STEP_TIMEOUT_SECONDS}`,
    "match_max 100000",
    // Wide pty so clack never soft-wraps prompt or note lines; wrapped lines
    // would break substring matching here and in the test's text assertions.
    `set stty_init "rows 50 columns 220"`,
    "log_user 1",
    `spawn {${bunPath}} {src/cli.ts} setup --json`,
    "proc await {pattern} {",
    "  expect {",
    "    -ex $pattern {}",
    `    timeout { puts stderr "JOURNEY-TIMEOUT waiting for: $pattern"; exit 99 }`,
    `    eof { puts stderr "JOURNEY-EOF waiting for: $pattern"; exit 98 }`,
    "  }",
    "}",
  ];
  for (const step of steps) {
    lines.push(`await {${tclSafePattern(step.waitFor)}}`);
    if (step.send) lines.push(`send -- "${SEND_KEYS[step.send]}"`);
  }
  lines.push(
    `expect { eof {} timeout { puts stderr "JOURNEY-TIMEOUT waiting for: eof"; exit 99 } }`,
    "catch wait result",
    "exit [lindex $result 3]",
  );
  return `${lines.join("\n")}\n`;
}

function tclSafePattern(pattern: string): string {
  if (/[{}\\\u0000-\u001f\u0080-\uffff]/.test(pattern) || !pattern.trim()) {
    throw new Error(`expect pattern must be plain brace-free ASCII: ${JSON.stringify(pattern)}`);
  }
  return pattern;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Covers CSI sequences (colors, cursor movement, hide/show), simple ESC
// commands (cursor save/restore), and OSC strings — everything clack and
// sisteransi emit.
const ANSI_PATTERN = /\u001b(?:\[[0-9;?]*[A-Za-z]|\][^\u0007]*\u0007|[78=>DEHM])/g;

export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_PATTERN, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

// The CLI prints the setup report with JSON.stringify(report, null, 2) after
// the interactive flow, so the report is the last top-level "{" block of the
// pty capture. A journey without a report is a harness bug — fail loudly.
function parseReportJson(text: string): SetupReportJson {
  const lines = text.split("\n");
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] === "{") {
      start = index;
      break;
    }
  }
  if (start < 0) throw new Error(`setup --json report not found in pty output:\n${text.slice(-2_000)}`);
  const block = lines.slice(start).join("\n");
  const end = block.lastIndexOf("}");
  if (end < 0) throw new Error(`setup --json report is truncated:\n${block.slice(-2_000)}`);
  return JSON.parse(block.slice(0, end + 1)) as SetupReportJson;
}

function asObject(value: unknown, label: string): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  throw new Error(`expected ${label} to be an object in the committed config`);
}
