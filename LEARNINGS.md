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

## The gate teaches (why CI/review broke, and how the block reads back)

- A lib function that EAGERLY calls `loadConfig()` (which shells `which claude`) FAILS IN CI, where the claude binary is absent. Resolve config LAZILY so injected-executor tests never touch it. The trap is STRUCTURAL — it applies to every future lib function, not just `containment.ts`. [PR #18, W1-T2]
- The reviewer's first live refusal (W1-T2 / PR #18) was CORRECT: the worker shipped an excellent HALF of the task (schema validation at the spawn boundary), wrote a confident PR body describing only that half, and passed CI 64/64. Static validation proves a settings file is WELL-FORMED; it never proves the sandbox ENGAGED — two criteria, two guarantees. Green checks are not evidence. [PR #18]
- When blocked by an acceptance gate, the one move that is NEVER available is editing the acceptance criteria to match the diff. Workers have write access to `plan/tasks.yaml`, so the prohibition must be STATED in every prompt, not assumed. [session doctrine]
- A gate that says only "no" costs a human round-trip on every block; a gate that NAMES the gap feeds straight back into the loop. The W1-T2 refusal said "1 criterion/criteria unmet" without saying WHICH — so `remudero-review` now names the first unmet criterion in the status description (full list in the ledger + PR comment). [this PR]

## Safety limits vs. work limits

- A limit set NEAR the expected cost of the work is a WORK LIMIT, not a safety limit. Safety limits must sit an ORDER OF MAGNITUDE above the expected value so they only fire on pathology. This error was made TWICE — `maxTurns` (18 vs. ~36 needed) and `budget_usd` ($4 vs. ~$4 needed, W1-T3 killed mid-work). Set safety limits by asking "what number can ONLY mean something is broken?", never "what should this cost?". [W1-T3, PR #8]
- Calibration data (W1-T5 mounts.yaml) comes from OBSERVED runs, never from a guess in a chat. Observed so far: hello-world $0.41 · reviewer subsystem $2.26 · gate wiring $1.28 · containment probe ~$2.0 · W1-T3 was still working at $3.57 / 36 turns when its guessed $4 cap killed it. [W1-T3, PR #8]

## Clients, contract & repo shape

- Tauri v2 targets 5 platforms from ONE codebase (Linux/macOS/Windows/Android/iOS; iOS renders in WKWebView), is independently security-audited (Radically Open Security), and has official App Store distribution guides; binaries are ~3–5 MB vs Electron ~150 MB. BUT its maintainers explicitly say **mobile is NOT a first-class citizen** — treat desktop as mature and mobile as young. [research 2026-07-14]
- Tauri's notification plugin is **LOCAL notifications**. Whether it supports **APNs REMOTE push is UNVERIFIED** — never assume remote push from a "notifications" plugin listing; a task must verify it before any design depends on it. (Remudero sidesteps this: push is an adapter concern — GitHub-mobile/ntfy/iMessage — not an app concern.) [research 2026-07-14]
- **Repo shape follows CONTRACT COUPLING**: everything that consumes the daemon API lives in ONE repo so a breaking change fails CI across all consumers atomically, in one PR; everything else (docs/site, commons, pro) lives OUTSIDE. Contract coupling decides repo shape — nothing else (D-5). [research 2026-07-14]

## Task specification & the reviewer's blind spot

- A task whose criteria span multiple subsystems COLLIDES with one-concern-per-PR and is undeliverable. The worker's only honest moves are: do one concern and be blocked, or escalate. Decompose by CONCERN, never by convenience. Architect error, three occurrences: T1C (4 deliverables), T1D (orphaned call site), W1-T3 (4 subsystems). [PR #22, W1-T3]
- The reviewer judges DIFF + REPORT, never REPO STATE. A criterion satisfied by an EARLIER PR is permanently unsatisfiable by a later one. Its floor is keyword-matching the report against the proof text — crude and fail-closed by design, but it produces false positives on already-done work. (Fixes: `satisfied_by` is the manual patch; W1-T3F makes the reviewer OBSERVE repo state, the real fix.) [PR #22, W1-T3]
- Rule 15 held under pressure: blocked by 4 unmet criteria, the worker did NOT edit them. It scoped down, cited one-concern, disclosed the decision, and accepted the block. That is the behavior we want. [PR #22]

## Documentation & the read/verify side of knowledge

- Docs split by AUTOMATABILITY: changelogs, API refs, and interface specs are structured-in → structured-out and CAN be generated; conceptual guides, troubleshooting, and architecture decisions CANNOT — they need context absent from the codebase and must be written by a human. [research 2026-07-14]
- The governance that stops "shipping garbage at the speed of light" is to SEPARATE GENERATION FROM PUBLICATION: the machine generates and STAGES; the gate and the human APPROVE. (This is exactly what `rmd retro` does — deterministic gather + Architect synthesis staged as a gated plan PR.) [research 2026-07-14]
- Docs-as-code FAILS because it assumes humans will notice when documentation falls behind. The missing piece is the AWARENESS LAYER connecting a change to the docs it falsified — make it a reviewer-rubric obligation (W1-T30), not a hope. [research 2026-07-14]
- GitHub's repo-scoped agentic memory (Jan 2026) uses JUST-IN-TIME VERIFICATION with PRECISE CITATIONS TO CODE LOCATIONS, scoped to the repo, and lifted PR merge rates 83% → 90%. This validates provenance-tagged, repo-scoped learnings — and the READ side (inject them at prompt time) is exactly what we were missing (W1-T19). [research 2026-07-14]

## Context engineering & the knowledge architecture

- The core principle of context engineering: find the SMALLEST SET OF HIGH-SIGNAL TOKENS that maximize the likelihood of the desired outcome — context is a precious, FINITE resource, not a place to dump everything known. [research 2026-07-14, Anthropic "Effective context engineering"] [subsystem: knowledge · files: src/lib/learnings.ts, src/run-task.ts]
- Claude Code's OWN model is HYBRID: CLAUDE.md dropped in up front + glob/grep for JUST-IN-TIME retrieval, which "effectively bypasses the issues of stale indexing" — prefer retrieval (the plan is grep-able) over injecting whole files. [research 2026-07-14] [subsystem: knowledge · files: src/lib/learnings.ts, src/run-task.ts]
- Compaction's sharp failure mode: a summary that DROPS a critical fact is WORSE than no summary, because later steps trust it and cannot recover what was lost. Tune compaction for RECALL first, then precision; mitigate with ANCHORED SUMMARIZATION (goal/constraints/plan kept verbatim) and WRITE-BEFORE-COMPACT (externalize durable facts before the summary runs). [research 2026-07-14] [subsystem: context · files: src/lib/retro.ts, src/run-task.ts]
- A compacted message is REMOVED from the window and recoverable ONLY IF IT WAS STORED — durable findings must be written out (scratch file / ledger) as they are discovered, not held in-context. [research 2026-07-14] [subsystem: context · files: src/lib/retro.ts, src/run-task.ts]
- CACHE ECONOMICS: prompt caches key on EXACT PREFIX BYTES — any edit early in the context invalidates the cache for EVERYTHING after it; cache reads price at ~1/10th of fresh input. Assemble prompts STABLE-FIRST, VOLATILE-LAST. [research 2026-07-14] [subsystem: context · files: src/lib/learnings.ts, src/run-task.ts]
- Harnesses encode assumptions about what Claude cannot do on its own, and those assumptions GO STALE as models improve — question them frequently; a guard load-bearing at one model version can become dead weight at the next. [research 2026-07-14] [subsystem: retro · files: src/lib/retro.ts]

## Agent SDK tools & the feedback front door

- The Agent SDK ships BUILT-IN tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, AskUserQuestion, Monitor, Agent/subagents); declaring them in `allowedTools` is enough, and `allowedTools` DOUBLES AS A SECURITY BOUNDARY — the agent cannot use a tool you don't list. [research 2026-07-14, Agent SDK docs] [subsystem: sdk-tools · files: src/lib/worker.ts, src/run-task.ts]
- `AskUserQuestion` is a BUILT-IN tool: Claude asks the user multiple-choice questions when uncertain — this IS the grill mechanism, natively. ★ UNVERIFIED whether it functions HEADLESSLY or only with a human at the terminal; the intake design branches on the answer — verify before wiring (W1-T42). [research 2026-07-14] [subsystem: feedback · files: src/run-task.ts]
- `WebSearch` is SERVER-SIDE (Anthropic's, the same engine Claude chat uses) ⇒ an Architect can research WITHOUT opening the sandbox's `allowedDomains`. ★ UNVERIFIED whether `WebFetch` is likewise server-side or a LOCAL fetch — that decides whether WebFetch touches containment (W1-T41). [research 2026-07-14] [subsystem: sdk-tools · files: src/lib/worker.ts, src/run-task.ts]
- SECURITY PRECEDENT: `claude-code-action` DISABLES WebSearch/WebFetch BY DEFAULT — fetched content is a prompt-injection surface. Grant them to the Architect only; implement workers never get them. [research 2026-07-14] [subsystem: sdk-tools · files: src/lib/worker.ts, settings/worker.json]

## Browser automation & the design-review profile

- Playwright is cross-browser (Chromium/Firefox/WebKit), headless-native, CI-native, with both MCP and CLI for agents. Its MCP uses ACCESSIBILITY-TREE snapshots (2-5KB structured YAML) not screenshots (500KB-2MB images) — 10-100x cheaper in tokens for structural work. The CLI saves compact YAML snapshots (~4x fewer tokens) but REQUIRES SHELL ACCESS; MCP is the sandboxed-client path. [research 2026-07-14] [subsystem: design-review · files: settings/worker.json, src/lib/containment.ts]
- ★ SECURITY: Playwright's `browser_run_code_unsafe` runs ARBITRARY JS in the Playwright server — it is RCE-EQUIVALENT and "only for trusted MCP clients." A bypass-mode worker is not that: HARD-DENY it in every worker profile. [research 2026-07-14] [subsystem: design-review · files: settings/worker.json]
- Playwright needs a real browser with NETWORK EGRESS — incompatible with the locked worker `allowedDomains` UNLESS a dedicated Design-Review profile EXPLICITLY allowlists the browser/target domains. Browser egress is a per-skill grant, never global. [research 2026-07-14] [subsystem: design-review · files: settings/worker.json, src/lib/containment.ts]
- Screenshots blow up token usage (500KB-2MB each) — request them "only when necessary," for artifacts a human must eyeball; use accessibility-tree snapshots for everything structural. [research 2026-07-14] [subsystem: design-review · files: src/lib/containment.ts]

## Documentation as a gated artifact

- Docs are a GATED ARTIFACT, split by automatability: GENERATED docs (rmd --help, CLI reference, API ref, CHANGELOG) drift from code unless CI enforces byte-equality (regenerate + diff = RED) — the anti-rot mechanism; AUTHORED docs (concept/architecture/troubleshooting) are reviewer-gated (the docs rubric). ONE command registry feeds rmd --help + the GitHub /docs + the website — never three hand-copies. [research 2026-07-14] [subsystem: docs · files: src/run-task.ts, docs]
