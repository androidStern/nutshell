# Final Release Rehearsal — Layer-4 Human Checklist

This is the human pass. By the time you run it, layers 1–3 (in-process tests,
golden journeys, VM gates) have already passed for the release candidate — this
checklist should be boring. If anything here surprises you, the release is not
ready: freeze the report, file the failure with a verdict
(`product_fail` / `harness_fail` / `fixture_stale`), and fix code separately.

Record every step's evidence with the rehearsal tooling so the run survives
audit:

```bash
bun run rehearse:run -- \
  --release-id v<version> \
  --install-source "brew install androidStern/nutshell/nutshell" \
  --x-archive <official-x-archive.zip> \
  --youtube-export <official-google-export.zip> \
  --podcasts-seed <MTLibrary.sqlite-with-provenance>
bun run rehearse:audit-report -- --report <fresh-report-path>.json
```

Use a fresh report path per attempt. Do not append a new attempt into an old
report without `--force-new-report`.

## A. Fresh install (disposable VM or clean machine)

- [ ] Clean baseline proven: no `nutshell` on PATH, no `Nutshell.app`, no
      `~/nutconfig.jsonc`, no `~/Nutshell/`, agent not loaded, no useful TCC
      grants. (`rehearse:run` records this as the clean-state phase.)
- [ ] Install from the published artifact (tapped Homebrew formula or
      published tarball — never the dev checkout).
- [ ] `command -v nutshell` resolves to the installed command;
      `nutshell --version` prints the release version.
- [ ] `nutshell setup`: source selection → permission window opens → grant
      Full Disk Access to `Nutshell.app` (and only it) → each selected source
      verifies with its probe (sign into Chrome / approve prompts as asked) →
      background service enabled → smoke sync reports a real result.
- [ ] Final summary: every selected source `verified`; anything else shows an
      honest state with a fix line — a surprise here is a release blocker.
- [ ] `nutshell dashboard` shows app installed, agent enabled, access granted,
      last and next sync populated, and nonzero records after the first sync.

## B. Fresh macOS user account (same machine)

- [ ] Create a new macOS user, log in as them, install from the published
      artifact, run `nutshell setup`.
- [ ] Verify no prior `~/nutconfig.jsonc` or `~/Nutshell/` state was required
      and no state leaked from the other account.

## C. Reboot persistence

- [ ] After permissions are granted and the agent is enabled: reboot.
- [ ] Background agent still enabled (`nutshell health` schedule line),
      health clean, `nutshell sync` works, protected Apple sources still read
      with no new permission prompts.

## D. Sign-off

- [ ] `bun run rehearse:audit-report` passes on the recorded report — no
      failed phases, no queued gates, release evidence complete.
- [ ] Update `PROGRESS.txt` with the release id, report paths, and verdicts.

What NOT to do: no clicking through prompts as pass evidence, no manual fixes
beyond what setup explicitly asks for, no reusing dirty VMs, no calling a
warning "expected" without writing down why it is outside the changed surface.
