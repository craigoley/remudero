# LEARNINGS — durable, provenance-tagged ground truth

The knowledge pipeline (WS-8) starts here, now. Every line is one fact the fleet
paid to discover, tagged with the run/PR that proved it. Rules:

- **One fact per line. Each cites its source.** No fact without provenance.
- These are *installed-version / empirical* truths — the kind a prompt is wrong
  about (Standing rule 7: distrust the prompt over the installed version). When
  one is contradicted by a later probe, append the correction with its own
  provenance; never silently edit history.
- Promptsmith injects the matching entries into a rendered prompt as cited
  CONTEXT (W1-T19), so a worker inherits what we already learned.

## Isolation & containment

- Claude Code's Bash-tool snapshot sources `$HOME/.zshrc` via `os.homedir()`; `ZDOTDIR` is IGNORED — worker shell isolation must set `CLAUDE_CODE_SHELL` (the rc filename follows the shell), not ZDOTDIR. [PR #8]
- The current `CLAUDE_CODE_SHELL=/bin/bash` isolation works only because `~/.bashrc` is ABSENT on this machine — an accident of this host, not construction; a populated `~/.bashrc` would silently isolate nothing. [PR #8 → W1-T17/T18]
- Worker settings that fail schema validation are SILENTLY IGNORED under `claude -p` — a typo drops containment without erroring, so containment must be validated before spawn AND probed after. [WS-0]
- The SDK's `SandboxSettingsSchema` is `$loose` and silently strips unknown keys; validating against it alone PASSES a misplaced key (e.g. `allowedDomains` at the sandbox root) — validate shape explicitly, don't trust the schema to reject. [PR #6 / W1-T1]

## Ledger, budget & the SDK envelope

- The Agent SDK yields the `type:"result"` envelope (`num_turns`, `total_cost_usd`, `subtype`) and THEN throws from the iterator on an error subtype — read the envelope before the catch, or a failed run looks free. [PR #8]
- `maxBudgetUsd` is checked BETWEEN turns: a $0.01 budget produced $0.21 of real spend. It is a circuit breaker with up to one turn of overshoot, NOT a hard cap — set budgets with headroom. [PR #8]

## Host, self-update & spawn failures

- Claude Code runs a BACKGROUND SELF-UPDATER that `npm install`s into the global prefix (`~/.npm-global`) mid-session; a worker spawn that lands in npm's unlink/relink window finds no binary and dies with ENOENT, which the SDK misreports as "native binary not found". Every live `claude` process has its own updater ⇒ a thundering herd of concurrent global installs under fleet concurrency. The same prefix also holds the `openclaw` CLI. Disable per worker (`DISABLE_AUTOUPDATER=1`, confirm empirically) and retry ENOENT-class spawns. [DIAGNOSIS.md, run W1-T1C-1784038021919]
- The SDK's "native binary not found" message fires iff `existsSync(exe) === false`; a bad/missing `cwd` yields a DIFFERENT message ("exists but failed to launch"). The message is DIAGNOSTIC — read which branch fired before theorizing. [DIAGNOSIS.md, run W1-T1C-1784038021919]
- An `ls -l` taken AFTER a failure may show an already-REPAIRED state (the updater finished): timestamp your evidence with BIRTHTIME (`stat -f %SB`), not mere existence — the binary present post-mortem was born 8m after the crash, which is what named the race. [this session; the Architect first mistook the repaired state as "unchanged"]

## Acceptance, gates & the call site

- A doc that DESCRIBES a mechanism is never proof the mechanism EXISTS. PR #12 shipped `docs/review-gate.md`, passed CI, reported `verdict=merged`, and did NONE of its job (protection unchanged, no status ever posted). Acceptance proofs must be OBSERVABLE SYSTEM STATE — `gh api` output, a status object, a grep of the call site — never a file that talks about it. [PR #12/#13, this session]
- Splitting a task can ORPHAN its call site: T1C built the reviewer, T1D was to enforce it, and NEITHER owned `run-task.ts` CALLING it — the reviewer existed, fully tested, and was dead code for two PRs. When you split a task, name the integration point (the call site) as an explicit deliverable of one side. [PR #12/#13, this session]
- A required check must be posted by the ORCHESTRATOR, not solely by a worker: a crashed worker leaves the check ABSENT, and an absent required check blocks the merge forever (fail-closed becomes fail-stuck). The runner posts `remudero-review` unconditionally after judging; the fresh worker is advisory. [PR #13, this session]
- A required check with NO poster is a permanent DEADLOCK, so a manual/hand-run PR needs an escape hatch that invokes the SAME judge by hand (`rmd review <n>`) — never a `--force` bypass. Recovery if protection is ever misconfigured: `gh api --method PATCH repos/<owner>/<repo>/branches/main/protection/required_status_checks -F strict=false -f 'contexts[]=ci'`. [PR #13/this PR]

## CI gates & the fleet quality bar (operator fleet, hard-won)

- A required-check context is the **JOB NAME**, not the workflow file/string — branch protection keys on the job, so renaming the job silently un-requires the check. [operator fleet: SynthWatch/neon-drift/OleyArcade]
- A **conditionally-skipped required check DEADLOCKS merge forever** (a `paths:`/`if:`-gated job that doesn't run reads as "expected, pending", never green). The fix is ONE always-runs **CI-gate aggregator** job that `needs:` every sub-job; make only the aggregator the required context. [operator fleet: SynthWatch/neon-drift/OleyArcade]
- **"0 violations" from a newly-added strict gate is SUSPICIOUS until FALSIFIED** with a planted probe that MUST fail (the neon-drift `_probe(x)` lesson) — an inactive gate and a clean gate report identically. [operator fleet: SynthWatch/neon-drift/OleyArcade]
- **Green tests that kill no mutants are test theater;** a mutation-testing baseline (Stryker for TS) is the falsifier coverage % cannot provide. [operator fleet: SynthWatch/neon-drift/OleyArcade]
- A **MAJOR dependency bump once caused a 28-minute production outage** ⇒ majors are EXCLUDED from auto-merge and carry a Dependabot `version-update:semver-major` ignore-rule; only minors/patches auto-merge behind the full gate. [operator fleet: SynthWatch/neon-drift/OleyArcade]
- **CodeQL default setup must be DISABLED when using an explicit CodeQL workflow** — the two conflict and both become unreliable. [operator fleet: SynthWatch/neon-drift/OleyArcade]
