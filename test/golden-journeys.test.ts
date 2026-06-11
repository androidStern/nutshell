import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { JsonObject } from "../src/core/types";
import { CONNECTION_CHECK_OK_MESSAGE, GoldenJourney, signedOutFinding, type JourneyStep } from "./helpers/journey";

setDefaultTimeout(15_000);

// Goal criterion 20 (Layer 2 golden journeys): scripted end-to-end runs of the
// real interactive binary — `bun src/cli.ts setup --json` driven through a
// pseudo-terminal by /usr/bin/expect — asserting on output text, the report
// JSON / exit code, and the committed nutconfig.jsonc. Each journey runs in an
// isolated temp HOME with a fake Nutshell.app stub (see test/helpers/journey.ts),
// so nothing touches live providers, real user data, or an installed app.

const ALL_SOURCES = ["youtube", "podcasts", "apple_notes", "twitter"] as const;

const YOUTUBE_IMPORT_COMMAND = "nutshell import youtube <google-export.zip> --json";

describe.skipIf(process.platform !== "darwin")("golden journeys: real interactive setup over a pty", () => {
  test("journey 1: first run, every source verifies, automatic sync + connection check succeed", async () => {
    const journey = new GoldenJourney("all-pass");
    try {
      const steps: JourneyStep[] = [
        { waitFor: "Choose which sources", send: "enter" },
        { waitFor: "YouTube My Activity verified" },
        { waitFor: "Import Google YouTube export now?", send: "no" },
        { waitFor: "Apple Podcasts verified" },
        { waitFor: "Apple Notes verified" },
        { waitFor: "Twitter/X verified" },
        { waitFor: "Import official X archive now?", send: "no" },
        { waitFor: "Setup complete" },
      ];
      const result = await journey.runSetup(steps);

      expect(result.exitCode).toBe(0);
      expect(result.report.status).toBe("ok");
      for (const source of ALL_SOURCES) {
        const plugin = result.report.plugins.find((item) => item.source === source);
        expect(plugin?.status).toBe("ready");
        expect(plugin?.findings).toEqual([]);
      }
      expect(result.report.backgroundAgent.ok).toBe(true);
      expect(result.report.backgroundAgent.message).toBe("automatic sync enabled");
      expect(result.report.syncHandoff).toMatchObject({ attempted: true, ok: true, message: CONNECTION_CHECK_OK_MESSAGE });

      // Output: each source proves itself, the connection check ran, and the final
      // summary declares full verification.
      expect(result.text).toContain("✓ YouTube My Activity verified");
      expect(result.text).toContain("✓ Apple Podcasts verified");
      expect(result.text).toContain("✓ Apple Notes verified");
      expect(result.text).toContain("✓ Twitter/X verified");
      expect(result.text).toContain("Checking connections");
      expect(result.text).toContain("YouTube My Activity — verified");
      expect(result.text).toContain("All selected sources are verified.");

      // Config state: all sources enabled and proven ready by one probe each,
      // and the connection check went through the app identity.
      for (const source of ALL_SOURCES) {
        expect(journey.probeCount(source)).toBe(1);
        const config = journey.readConfig();
        expect(pluginConfig(config, source).enabled).toBe(true);
        expect(journey.pluginSetup(source).status).toBe("ready");
      }
      expect(journey.appCalls()).toContain("sync all --smoke --json");
    } finally {
      journey.cleanup();
    }
  });

  test("journey 2: not logged in, retry after signing in, source verifies", async () => {
    const journey = new GoldenJourney("retry-pass");
    try {
      // First probe: signed out with needs_auth guidance. Second probe: clean.
      journey.writeProbeResponse("youtube", 1, [signedOutFinding()]);
      journey.writeProbeResponse("youtube", 2, []);

      const steps: JourneyStep[] = [
        { waitFor: "Choose which sources", send: "enter" },
        { waitFor: "needs login" },
        { waitFor: "What do you want to do?", send: "enter" }, // Retry (first option)
        { waitFor: "YouTube My Activity verified" },
        { waitFor: "Import Google YouTube export now?", send: "no" },
        { waitFor: "Import official X archive now?", send: "no" },
        { waitFor: "Setup complete" },
      ];
      const result = await journey.runSetup(steps);

      expect(result.exitCode).toBe(0);
      expect(result.report.status).toBe("ok");
      expect(result.report.plugins.find((item) => item.source === "youtube")?.status).toBe("ready");

      // The failure rendered honestly, with the finding's own fix text.
      expect(result.text).toContain("YouTube browser session is signed out");
      expect(result.text).toContain("Fix: Open youtube.com in Chrome and sign into your Google account, then retry.");
      // The interactive loop intentionally omits the confirm command — Retry is
      // the check; the command lives on doctor/health instead.
      expect(result.text).not.toContain("Check: nutshell doctor youtube");
      expect(result.text).toContain("✓ YouTube My Activity verified");

      // Exactly two probes: the failing one and the retry that passed.
      expect(journey.probeCount("youtube")).toBe(2);
      expect(journey.pluginSetup("youtube").status).toBe("ready");
      expect(journey.pluginSetup("youtube").findings).toEqual([]);
    } finally {
      journey.cleanup();
    }
  });

  test("journey 3: skip a failing source, re-run resumes on that source only", async () => {
    const journey = new GoldenJourney("skip-resume");
    try {
      journey.writeProbeResponse("youtube", 1, [signedOutFinding()]);

      const firstRun = await journey.runSetup([
        { waitFor: "Choose which sources", send: "enter" },
        { waitFor: "needs login" },
        { waitFor: "What do you want to do?", send: "down-enter" }, // Skip for now
        { waitFor: "Twitter/X verified" },
        { waitFor: "Import official X archive now?", send: "no" },
        { waitFor: "Setup complete" },
      ]);

      // Run 1: honest degraded state, exit 1, comeback command printed.
      expect(firstRun.exitCode).toBe(1);
      expect(firstRun.report.status).toBe("warning");
      const skipped = firstRun.report.plugins.find((item) => item.source === "youtube");
      expect(skipped?.status).toBe("degraded");
      expect(skipped?.findings[0]?.code).toBe("youtube_signed_out");
      expect(firstRun.text).toContain("Nutshell setup"); // first-run intro shown
      expect(firstRun.text).toContain("✗ YouTube My Activity — needs login");
      expect(firstRun.text).toContain("Finish anytime: rerun nutshell setup");
      expect(journey.probeCount("youtube")).toBe(1);

      // Config between runs: the skipped source is recorded degraded WITH the
      // finding's guidance, so any surface can replay the exact fix.
      const storedSetup = journey.pluginSetup("youtube");
      expect(storedSetup.status).toBe("degraded");
      const storedFinding = (storedSetup.findings as JsonObject[])[0]!;
      expect(storedFinding.code).toBe("youtube_signed_out");
      expect(storedFinding.guidance).toMatchObject({
        state: "needs_auth",
        fix: "Open youtube.com in Chrome and sign into your Google account, then retry.",
        confirm: "nutshell doctor youtube",
      });
      for (const source of ["podcasts", "apple_notes", "twitter"]) {
        expect(journey.pluginSetup(source).status).toBe("ready");
      }

      // "User signs in" between runs: the third youtube probe passes. The
      // review probe (call 2) still fails, so the table shows current truth.
      journey.writeProbeResponse("youtube", 3, []);

      const secondRun = await journey.runSetup([
        { waitFor: "of 4 sources working" },
        { waitFor: "What do you want to do?", send: "enter" }, // Fix YouTube My Activity now
        { waitFor: "needs login" },
        { waitFor: "What do you want to do?", send: "enter" }, // Retry
        { waitFor: "YouTube My Activity verified" },
        { waitFor: "Import Google YouTube export now?", send: "no" },
        { waitFor: "Setup complete" },
      ]);

      expect(secondRun.exitCode).toBe(0);
      expect(secondRun.report.status).toBe("ok");
      expect(secondRun.report.plugins.find((item) => item.source === "youtube")?.status).toBe("ready");

      // Re-run resumed: probed status table, fix offer for the failing source
      // only — no intro ceremony, no re-selection, no re-walk of the others.
      expect(secondRun.text).toContain("3 of 4 sources working");
      expect(secondRun.text).toContain("✗ YouTube My Activity — needs login");
      expect(secondRun.text).toContain("Fix YouTube My Activity now");
      expect(secondRun.text).not.toContain("Nutshell setup\n"); // intro title absent
      expect(secondRun.text).not.toContain("Choose which sources");
      // The already-verified sources appear as verified in the re-run table and
      // are never walked through the fix loop (probe accounting below confirms).
      expect(secondRun.text).toContain("✓ Apple Podcasts — verified");
      expect(secondRun.text).toContain("✓ Apple Notes — verified");
      expect(secondRun.text).toContain("✓ Twitter/X — verified");

      // Probe accounting proves "resumes on that source only": every source
      // got exactly one review probe; only youtube got a setup retry probe.
      expect(journey.probeCount("youtube")).toBe(3);
      expect(journey.probeCount("podcasts")).toBe(2);
      expect(journey.probeCount("apple_notes")).toBe(2);
      expect(journey.probeCount("twitter")).toBe(2);

      expect(journey.pluginSetup("youtube").status).toBe("ready");
      expect(journey.pluginSetup("youtube").findings).toEqual([]);
    } finally {
      journey.cleanup();
    }
  });

  test("journey 4: import-later — decline the archive offer, keep the comeback command, skip the import", async () => {
    const journey = new GoldenJourney("import-later");
    try {
      const result = await journey.runSetup([
        { waitFor: "Choose which sources", send: "enter" },
        { waitFor: "YouTube My Activity verified" },
        { waitFor: "Import Google YouTube export now?", send: "no" },
        { waitFor: "Import later" },
        { waitFor: "Import official X archive now?", send: "no" },
        { waitFor: "Setup complete" },
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.report.status).toBe("ok");
      const youtube = result.report.plugins.find((item) => item.source === "youtube");
      expect(youtube?.status).toBe("ready");
      expect(youtube?.archiveImport).toBe("skipped");
      expect(youtube?.importCommand).toBe(YOUTUBE_IMPORT_COMMAND);

      // The offer carried the later-command, the decline printed it again, and
      // the final summary keeps the standing backfill-pending line.
      expect(result.text).toContain("If you do not have it yet, run this later:");
      expect(result.text).toContain("Import later");
      expect(result.text).toContain(YOUTUBE_IMPORT_COMMAND);
      expect(result.text).toContain(`history import pending — when your export arrives: ${YOUTUBE_IMPORT_COMMAND}`);

      // No import ran against the fake app, and the source is still ready.
      expect(journey.appCalls().some((call) => call.startsWith("import"))).toBe(false);
      expect(journey.pluginSetup("youtube").status).toBe("ready");
    } finally {
      journey.cleanup();
    }
  });

  test("journey 5: decline automatic sync — honest summary, no enable calls, no connection check", async () => {
    const journey = new GoldenJourney("decline-agent");
    try {
      // Agent not yet registered, so setup must actually ask.
      journey.writeAppStatus({ fullDiskAccess: "granted", agent: "notRegistered", backgroundSync: "disabled" });

      const result = await journey.runSetup([
        { waitFor: "Choose which sources", send: "enter" },
        { waitFor: "Import Google YouTube export now?", send: "no" },
        { waitFor: "Import official X archive now?", send: "no" },
        { waitFor: "enable automatic sync now?", send: "no" },
        { waitFor: "Setup complete" },
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.report.status).toBe("ok");
      expect(result.report.backgroundAgent).toMatchObject({
        attempted: true,
        ok: true,
        message: "left paused by user choice",
      });
      expect(result.report.syncHandoff).toMatchObject({
        attempted: false,
        ok: true,
        message: "initial sync not scheduled; automatic sync was not enabled",
      });

      expect(result.text).toContain("Automatic sync: left paused by user choice");
      expect(result.text).not.toContain("Checking connections");

      // Declining means the app was never asked to enable anything or sync.
      const calls = journey.appCalls();
      expect(calls.some((call) => call.startsWith("enable-sync"))).toBe(false);
      expect(calls.some((call) => call.startsWith("register-agent"))).toBe(false);
      expect(calls.some((call) => call.startsWith("sync"))).toBe(false);

      for (const source of ALL_SOURCES) {
        expect(journey.pluginSetup(source).status).toBe("ready");
      }
    } finally {
      journey.cleanup();
    }
  });
});

function pluginConfig(config: JsonObject, source: string): JsonObject {
  const plugins = config.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) throw new Error("config has no plugins object");
  const plugin = (plugins as JsonObject)[source];
  if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) throw new Error(`config has no plugins.${source} object`);
  return plugin as JsonObject;
}
