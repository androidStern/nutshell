# Rehearsal Browser Auth Seeds

Browser auth seeds exist to avoid repeatedly asking the user to complete Google and X login while testing downstream fresh-install phases. They are private test inputs, like provider exports and Podcasts snapshots.

They can establish the auth-present browser state only after the same run has proven the clean signed-out state. They do not excuse product failures: if doctors or sync cannot use the restored cookies/keychain through the installed product, the run is blocked.

## What Must Be Saved

Saving only the Chrome profile is not enough. Chrome cookies on macOS are encrypted with the `Chrome Safe Storage` item in the user's login keychain. A reusable seed may preserve:

- `~/Library/Application Support/Google/Chrome`
- `~/Library/Keychains/login.keychain-db`

Do not save the raw `Chrome Safe Storage` password into a fixture file or teach the product to read that file. That was attempted in `v0.1.20` and rejected because it bypasses the real user install behavior this rehearsal is supposed to validate.

The seed must stay outside git. The current private seed location is:

```text
~/Documents/NutshellRehearsalShare/auth-profiles/
```

The v0.1.16 run captured:

```text
~/Documents/NutshellRehearsalShare/auth-profiles/chrome-google-x-20260610-0039
```

## Capture

Launch the Tart VM with the standard host share:

```bash
tart run \
  --dir=repo:/path/to/nutshell \
  --dir=share:$HOME/Documents/NutshellRehearsalShare \
  <vm-name>
```

After Google My Activity and X are visibly signed in in VM Chrome, capture the seed:

```bash
scripts/tart-browser-auth-snapshot.sh <vm-name> <snapshot-name>
```

The script quits Chrome, writes `chrome-profile.tgz`, copies `login.keychain-db`, and writes a manifest under the shared `auth-profiles` directory.

## Restore

Use restored auth only after the release flow has already proven the signed-out state in the same clean VM attempt. Record it as `browser-auth-seed-restore`, not as `browser-login-handoff`.

Start the target Tart VM with the same host share, then run:

```bash
scripts/tart-browser-auth-restore.sh <vm-name> <snapshot-name>
```

If the guest password is not the Tart default `admin`, set:

```bash
NUTSHELL_VM_PASSWORD=<guest-password> scripts/tart-browser-auth-restore.sh <vm-name> <snapshot-name>
```

After restore, reboot or stop/start the VM, unlock the desktop, record the restore phase, and verify auth through the product surface:

```bash
bun run scripts/fresh-install-rehearsal.ts record-auth-seed-restore \
  --browser-auth-seed <snapshot-name> \
  --report <fresh-install-report.json> \
  --append
```

If `nutshell doctor youtube --json` or `nutshell doctor twitter --json` still reports Chrome Safe Storage or keychain timeout, the restored profile is not valid product evidence. Fix the product's normal Keychain/browser behavior or the VM fixture restore path before continuing.

## Current Product Bug

The `v0.1.16` public rehearsal failed after visible Google and X login because the app-owned doctor still timed out reading Chrome Safe Storage through the macOS keychain. Report:

```text
~/Documents/NutshellRehearsalShare/reports/fresh-install-report-strict-v0.1.16-tart-run-20260609a.failed-frozen.json
```

Product terms: signed-in browser-backed sources are in a valid user state, but Nutshell cannot read the browser session without an unresolved `security`/Chrome Safe Storage keychain prompt. That is `blocked_bug`, not `needs_auth`.
