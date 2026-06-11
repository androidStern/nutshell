# Post-Permission Snapshot Session

One staged human session, roughly 20 minutes, run by Andrew. It produces the post-permission VM snapshot that the permissions gate and the live-sync/dashboard gate in `docs/release-validation-gates.md` consume mechanically afterwards. The GUI clicks below are the one place human clicking is legitimate: they build a frozen fixture. They are never themselves release-pass evidence.

Everywhere this doc says `<release-candidate>`, substitute the version under test (for example `0.1.23`). Everywhere it says `<YYYYMMDD>`, substitute today's date.

## Preconditions (host)

1. The stable auth-present snapshot exists. Use the newest keepalive promotion if one exists (`tart list | grep keepalive`), otherwise the base:

   ```text
   nutshell-authpresent-sequoia-google-x-20260610
   ```

2. `<release-candidate>` is published on the public install path (the `androidStern/nutshell` Homebrew tap). If the tap serves a different version than the candidate, stop — fix the release first.
3. Clone and start the VM **with graphics** (no `--no-graphics`; this session is GUI work):

   ```bash
   tart clone nutshell-authpresent-sequoia-google-x-20260610 nutshell-postperm-staging
   tart run \
     --dir=repo:/path/to/nutshell-repo \
     --dir=share:$HOME/Documents/NutshellRehearsalShare \
     nutshell-postperm-staging
   ```

4. Guest account is `admin` / `admin`; the login keychain password is also `admin`.
5. Confirm the clone source is the proven auth-present snapshot, never a dirty failed-rehearsal VM (gates doc hard rule).

## Inside the VM (numbered, ~20 minutes)

1. (~3 min) Install the release candidate via the public install path, in Terminal:

   ```bash
   brew install androidStern/nutshell/nutshell
   nutshell --version
   ```

   The version printed must be `<release-candidate>`. If it is not, stop the session; this is the wrong artifact.

2. (~1 min) Run `nutshell setup` in Terminal. Proceed through the intro and plugin selection, keeping all four built-in sources enabled. Stop at the permission step.

3. (~3 min) Permission step. Setup opens the Nutshell permission window and the System Settings Full Disk Access pane. Drag the Nutshell app icon into the Full Disk Access list and turn its switch on.

4. (<1 min) Back in the Terminal setup flow, choose **"I granted it — check again"**. Expect `✓ Full Disk Access granted`. If it still reports missing, redo step 3; do not continue past a failing check.

5. (~2 min) YouTube and X probes run next. macOS shows Keychain prompts for **Chrome Safe Storage**. For every such prompt: enter the keychain password `admin` and click **"Always Allow"** (not "Allow"). Expect both probes to pass — this snapshot is already signed into Google My Activity and X. If a probe fails despite visible sign-in, that is `blocked_bug`; stop and freeze, do not click through anything else.

6. (<1 min) Notes probe. macOS shows an automation prompt ("Nutshell.app would like to control Notes" or similar). Click **OK / Allow**.

7. (~4 min) Open Notes.app and create exactly three notes with these titles and bodies (gates assert on the titles verbatim):

   | Title | Body |
   | --- | --- |
   | `Nutshell rehearsal note one` | `Seeded during the post-permission session — one.` |
   | `Nutshell rehearsal note two` | `Seeded during the post-permission session — two.` |
   | `Nutshell rehearsal note three` | `Seeded during the post-permission session — three.` |

   Quit Notes when done. (Creating these any time before shutdown is fine; gates run their own sync afterwards.)

8. (0 min) Podcasts: do **not** open Podcasts.app and do not sign into an Apple ID. The live-sync gate stages the SQLite-safe Podcasts seed (`rehearsal-seeds/MTLibrary.sqlite`) through the harness instead — see the seed-staging notes in `docs/vm-rehearsal-operations-playbook.md` and `docs/fresh-install-release-rehearsal.md`.

9. (~1 min) Continue setup to the end: enable automatic sync when offered and let the bounded connection check run. Expect exit code 0 and per-source verified states in the final summary.

10. (~2 min, optional sanity) Run `nutshell doctor` once and confirm no permission findings appear. The binding verification is the host one-liner below, not this glance.

## Exit steps (host)

1. Inside the VM: quit Chrome if it is open (cookies flush on quit), then Apple menu → Shut Down. Wait for the `tart run` process/window on the host to exit.
2. Promote with the naming convention `nutshell-postperm-sequoia-<YYYYMMDD>`:

   ```bash
   tart rename nutshell-postperm-staging nutshell-postperm-sequoia-<YYYYMMDD>
   ```

3. Verify before declaring the snapshot good — clone it, boot headless, run doctor inside, expect zero `needs_permission` findings:

   ```bash
   SNAP=nutshell-postperm-sequoia-<YYYYMMDD>; \
   tart clone "$SNAP" postperm-verify-tmp && \
   (tart run --no-graphics postperm-verify-tmp >/tmp/postperm-verify.log 2>&1 &) && \
   tart ip postperm-verify-tmp --wait 180 >/dev/null && sleep 45 && \
   tart exec postperm-verify-tmp /bin/zsh -lc 'nutshell doctor --json' | \
     bun -e 'const r = await new Response(Bun.stdin.stream()).json(); const bad = r.findings.filter((f) => f.guidance?.state === "needs_permission"); if (bad.length) { console.error(JSON.stringify(bad, null, 2)); process.exit(1); } console.log("post-permission snapshot clean");'; \
   tart stop postperm-verify-tmp; tart delete postperm-verify-tmp
   ```

   `post-permission snapshot clean` on stdout means the snapshot is good. Any `needs_permission` finding means a step above was missed: delete the snapshot and redo the session from a fresh clone — do not patch the VM in place.

4. Record the new snapshot name in the Permissions gate section of `docs/release-validation-gates.md`.

## What NOT to do

- Do not log into anything new — no Google, X, Apple ID, or any other account. The auth state must remain exactly the seeded one.
- Do not update macOS or Chrome (no Software Update, no `chrome://settings/help`).
- Do not run `nutshell sync` manually; setup only runs the bounded connection check and automatic sync handles ingestion. Gates run their own syncs from clones.
- Do not reuse a dirty failed-rehearsal VM as the starting point (gates doc rule). Only a clone of the proven auth-present snapshot.
- Do not click through any prompt not listed above. An unexpected prompt means something is wrong: record it, stop, and freeze the session.
- Do not grant permissions to Terminal, Bun, or anything other than `Nutshell.app`. The gate asserts the grants belong to the app.
