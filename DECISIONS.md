# DECISIONS

Append-only log of machine-side auto-choose resolutions (MASTER-PLAN §4). Every
`DECISION_REQUEST` a worker emits is resolved to its RECOMMENDED option by the
control plane, recorded here with a rationale and a rollback pointer, and the
worker session is resumed with the choice. The PR boundary makes nearly every
decision reversible.

<!-- Entries below are appended verbatim by the runner. -->

## 2026-07-20 — OPERATOR DECISION: WS-2 deferral, overnight posture, P34 family

*Operator-authored, not a machine auto-choose resolution. This file's other entries are
`DECISION_REQUEST` resolutions written by the control plane; this one is recorded by hand at the
operator's instruction and is marked so the two are never confused.*

- **WS-2 second-repo expansion is DEFERRED** until remudero is substantially built. The criterion is
  explicit and operator-judged, not a metric: **the console is feature-rich and looks good.**
  Post-train priority is therefore the CONSOLE FEATURE ARC — W1-T183 (density/IA), W1-T184
  (ledger-first rendering), W1-T163 (since-you-last-checked recap), W1-T159 (glance strip) — NOT
  expansion to a second repo. Rationale: the 2026-07-20 operating day showed the observation surface
  is the fleet's best defect classifier (six defects found by an operator looking at a screen, none
  by gates), so a second repo before the surface is trustworthy multiplies unobserved work.
- **Overnight posture: RUN FREE, no quiet hours.** Verified against live state at recording time —
  `isQuietHours` false, `isPaused` false, `isStopped` false, and no `state/QUIET_HOURS` marker, so
  the recorded posture matches the actual configuration rather than merely asserting it. NOTE from
  source (lib/fleet-control.ts:24): `setQuietHours` "only flips the flag a future consumer reads" —
  nothing consumes it today, so quiet hours is currently a no-op in either position. The posture is
  recorded as intent; it is not yet an enforced control.
- **The P34 envelope governs once its mechanism lands** — not before. Until then the control surface
  is what it is today: gates, escalations, and the console. P34 was reframed twice on 2026-07-20
  (ledgered `ratify.reframed` at 01:16:11 and 01:25:15) and its cached draft is invalidated, so the
  next `rmd inbox` pass redrafts the mechanism against the ratified envelope.
- **W1-T167 (model routing by task class) is to be PULLED FORWARD into the P34 mechanism family when
  the redraft files.** Recorded as a pending action, not performed: no reframe moves a task, and the
  redraft has not run. W1-T167 is queued and unmoved as of this entry.
- **KNOWN CAVEAT for the redraft — W1-T173 (inbox draft-rung fence stripping) is UNBUILT.** If the
  Architect returns a a markdown yaml code fence, draft the rung dead-ends. Remedy: hand-strip the fences and
  proceed; that occurrence is itself another fixture for W1-T173, which should be recorded on the
  task when it happens rather than only worked around.
- Rollback: none required — this entry records intent and defers work. Reversing the WS-2 deferral is
  a plan-order decision, not a code change.

## 2026-07-14T10:49:50.570Z — WS-0 spike filename
- Options: docs/spike.md | docs/spike-hello.md (RECOMMENDED) | docs/spike.md | docs/spike-hello.md (RECOMMENDED)
- Chosen (RECOMMENDED, auto): `docs/spike-hello.md`
- Rationale: auto-choose resolves DECISION_REQUEST to the RECOMMENDED option (§4).
- Rollback: revert the sandbox PR.

## 2026-07-19T00:00:00.000Z — W1-T1 re-dispatch (third occurrence): already-satisfied, no-op close
- Options: (A) close as already-satisfied, no functional code change (RECOMMENDED) | (B) force a
  cosmetic edit to `src/run-task.ts` or `src/spike.ts` just to produce a non-empty diff
- Chosen (RECOMMENDED, auto): Option A — no functional code change.
- Rationale: `src/run-task.ts` (4,343 lines) was already extracted from the WS-0 spike
  (`src/spike.ts`, 308 lines, which today holds only the sandbox smoke-test proto-runner and no
  proto-runner logic left to extract) in commit `83ff9a8` ("WS-1 T1: rmd run-task — the
  proto-runner"), merged as `remudero` PR #2. `plan/tasks.yaml`'s own W1-T1 entry already carries
  `pr: 2  # merged PR #2 -> deriveStatus resolves this task as merged`, and ~250 PRs (through
  `50ffe06`, W1-T47) have built on `run-task.ts` since. At dispatch time `HEAD` equaled
  `origin/main` (`50ffe06`) with a clean tree — there was nothing to extract, diff, or PR. This is
  also the THIRD time this exact task has been re-dispatched: two earlier no-op closures
  (`d61c66e`, `83272b1`, on abandoned `run-W1-T1-*` branches never merged to `main`) already
  reached the same conclusion and named the likely root cause — `tasks.yaml`'s `status: queued`
  field is documented in the same file as "decorative — real merge-state is DERIVED FROM GITHUB"
  (see file header + `lib/status.ts`), so a dispatcher keying off that decorative field instead of
  GitHub-derived status re-queues an already-merged task. Fixing that dispatcher logic is outside
  this task's one-concern scope (this task is the extraction, not the dispatcher) and is left for a
  separate task against the dispatch/drain path.
- Rollback: revert this PR (removes only this DECISIONS.md entry; no runtime code touched).
## 2026-07-14T14:10:10.612Z — W1-T1C (W1-T1C-1784038021919)
- Options: -- | *Concern:** W1-T1C's design describes the full reviewer (pure verdict logic + a *live* fresh-context REVIEW worker that posts `remudero-review` to a real PR head sha). The OUTPUT CONTRACT mandates **one concern per PR**, and the design itself factors the falsifier as a **unit fixture** and calls enforcement "a separate concern." So the scope of *this* PR needs a choice. Both options are revert-the-PR reversible; the difference is whether run-task.ts's orchestration loop changes. | **Option A (RECOMMENDED):** Land the JUDGE as a pure, TDD-strict library only — a new `src/lib/review.ts` exporting `reviewVerdict(criteria, diff, report, transcript)` (per-criterion verdicts + overall `success`/`failure`) plus a `postReviewStatus()` gh helper for `context=remudero-review`, and `test/review.test.ts` recording the falsifier fixtures: (a) a diff that passes tests but ignores a stated acceptance criterion → `failure`; (b) test theater (assertions that assert nothing) → `failure`; (c) a responsive + proof-pasted criterion → `success`. **No run-task.ts wiring.** Purely additive; one concern (the reviewer *can judge*); satisfies acceptance claim 2 as a committed unit and lays the exact surface the live worker (claim 1) and W1-T1D call. Reversible: additive new files only — revert the PR. | **Option B:** All of Option A **plus** wiring a fresh read-only REVIEW worker into `src/run-task.ts` after CI goes green, spawning it with a fresh context to run the judge and `POST` `remudero-review` live to the PR head sha (claims 1 & 3 end-to-end). Larger; mutates the orchestration loop in the same PR, mixing "the judge exists" with "the runner invokes it." Reversible: revert the PR, but it changes run-loop behavior.
- Chosen (RECOMMENDED, auto): Option A
- Rollback: revert the PR.

## 2026-07-14T15:13:00.429Z — W1-T1D (W1-T1D-1784041866665)
- Options: -- | *DECISION_REQUEST — what file should this bootstrap PR carry?** | **Option A — `docs/review-gate.md` (new doc)** ✅ **RECOMMENDED** | **Option B — edit the comment in `src/lib/review.ts:24`** | *Reversibility:** Both are docs/comment-only and trivially revertible with a follow-up commit; neither touches runtime behavior or the live branch protection (that is the separate post-merge API step). Choosing A vs B does not lock in anything irreversible.
- Chosen (RECOMMENDED, auto): **Option A — `docs/review-gate.md` (new doc)** ✅ ****
- Rollback: revert the PR.

## 2026-07-14T19:54:14.167Z — W1-T19 (W1-T19-1784058693259)
- Options: The design says "give each LEARNINGS entry a subsystem: tag and files: (globs)" and "match the task's repo/files" — but today LEARNINGS.md is human prose with [PR #8]-style provenance and no machine-readable tags, and MASTER-PLAN (line 312) reserves LEARNINGS narrative for humans/the Architect to edit. | The Task type (src/lib/plan.ts) has no files/subsystem field, and every task's repo is just remudero, so there is no existing per-task signal to match globs against. | DECISION_REQUEST: Where does the machine-readable LEARNINGS source-of-truth live (the thing Promptsmith parses + matches per task)? | Option A : New structured plan/learnings.yaml — each entry { id, subsystem, files:[globs], fact, src } — parsed by a new src/lib/learnings.ts; the prose LEARNINGS.md stays the human/Architect-owned narrative (MASTER-PLAN governance) and is left untouched. Tasks match via a new optional files:[globs] field on the Task schema, defaulting to a repo-wide glob when absent. Injected entries render as - <fact> [src: learnings#<id>], char-capped by the knowledge budget. | Option B: Inline machine tags inside the existing LEARNINGS.md — append a parseable marker per bullet (<!-- id:… subsystem:… files:… -->) and parse LEARNINGS.md directly as a single source of truth; re-tag every existing entry.
- Chosen (RECOMMENDED, auto): Option A
- Rollback: revert the PR.

## 2026-07-15T15:15:53.070Z — W1-T15 (W1-T15-1784128468444)
- Options: Task W1-T15 (plan-sync is an in-repo PR flow — never scp again) explicitly allows either location for the doc — the acceptance criterion literally reads "the doc (CONTRIBUTING or docs/plan-sync.md) exists." I need to pick one before writing. | Option A — docs/plan-sync.md (new file), linked from CONTRIBUTING.md — | Reversibility: trivial — it's a new file plus a link; git revert cleanly undoes it with no effect on other docs. | Option B — Fold into CONTRIBUTING.md only (no new file) | Reversibility: equally trivial — a diff to one existing file, revertible.
- Chosen (RECOMMENDED, auto): Option A — docs/plan-sync.md (new file), linked from CONTRIBUTING.md —
- Rollback: revert the PR.

## 2026-07-15T21:39:45.987Z — W1-T54b (W1-T54b-1784151420811)
- Options: Context (verified against the installed repo, not assumed): The live proof this task calls for already happened. Ledger evidence (/Users/craigoleyagent/Remudero/state/ledger.ndjson) and live GitHub state show a prior run of this exact task (W1-T54b-1784149952116, the one MASTER-PLAN records as having "walled at 81/80 mid-live-campaign") actually executed rmd dep-review 80 and rmd dep-review 81 against the two real parked Dependabot PRs before running out of turns — it just never got to write up/ship the evidence: | PR #80 (patch bump, @anthropic-ai/claude-agent-sdk): dep-review.decided → arm, remudero-review=success posted ("patch dependency bump, confined + gates green"), auto-merge armed, PR #80 MERGED (verified live: state: MERGED, commit status remudero-review: success). | PR #81 (major bump, @types/node 22→26): dep-review.decided → escalate, remudero-review=failure posted, [issue #89](https://github.com/craigoley/remudero/issues/89) opened (class MANUAL, carries the release notes, recommendation "merge"), PR #81 still OPEN, not merged (verified live). | Option A — New docs/dep-review.md . The dep-review lane (W1-T54) shipped with zero documentation — docs/ has ci-gate.md and review-gate.md but nothing describing rmd dep-review, its three/four-way verdict, or the manifest allowlist. Write a dedicated doc mirroring the structure of those two (mechanics + a ## Live-proof evidence (W1-T54b) section with the #80/#81 evidence above, ledger timestamps, and links). Gives the lane the same documentation floor its siblings have, in the same place a future reader would look for it. | Reversible: yes — a new file, trivially deletable/mergeable later. | Option B — Append to existing docs/review-gate.md. That file already has a "What each check proves" section covering remudero-review generally, and its own ## Live-proof evidence (W1-T24b) precedent. Add a ## Live-proof evidence (W1-T54b) section there instead of a new file. | Reversible: yes — an additive section, easy to excise or move into its own file later.
- Chosen (RECOMMENDED, auto): Option A — New docs/dep-review.md . The dep-review lane (W1-T54) shipped with zero documentation — docs/ has ci-gate.md and review-gate.md but nothing describing rmd dep-review, its three/four-way verdict, or the manifest allowlist. Write a dedicated doc mirroring the structure of those two (mechanics + a ## Live-proof evidence (W1-T54b) section with the #80/#81 evidence above, ledger timestamps, and links). Gives the lane the same documentation floor its siblings have, in the same place a future reader would look for it.
- Rollback: revert the PR.

## 2026-07-18T01:36:59.535Z — W1-T28 (W1-T28-1784338299097)
- Options: Context: MASTER-PLAN §5 Tier 1 calls for "Containment probe as a REQUIRED check — on any diff touching sandbox / deny-floor / env" (the empirical guarantee, since static validation alone can silently drop containment — WS-0 FF10a). The repo already has the probe logic (src/lib/containment.ts + test/containment.test.ts, from W1-T2) and an authoritative path-trigger definition for this exact category (CONTAINMENT_PATH_PATTERNS / containmentTrigger() in src/lib/specialist-panel.ts, used today by the advisory Layer-4 specialist panel). What's missing is wiring this as a required, deterministic CI gate (Tier 1, not the advisory specialist). The fork is over what the new required job actually does when a diff matches: | Option A — Lightweight reaffirmation . Add an unconditional containment-probe job to ci.yml (same "always-registers, internally diff-scoped" shape as lint-plan/depcruise, avoiding the synthwatch #102 deadlock class ci-gate.yml is built around). It computes the PR's changed paths, reuses the existing containmentTrigger() to detect a match, and if matched, runs the deterministic test/containment.test.ts suite as an explicit, dedicated required assertion (no network, no secrets, no live worker spawn — same fail-closed logic already unit-tested). Add "containment-probe" to ci-gate.yml's REQUIRED array. Cost: ~free, no new infra. Reversible: revert the two workflow-file edits. | Option B — True empirical live probe. The job actually spawns a real sandboxed Claude worker (probeContainment's real executor) against the PR's actual settings/worker.json + hooks/, proving the literal empirical guarantee described in containment.ts's docstring rather than re-running unit tests with injected fakes. Requires provisioning a new ANTHROPIC_API_KEY (or OAuth) GitHub Actions secret, resolving/installing the claude CLI binary in the runner, and incurs real per-PR spend on every sandbox/hooks/env/deny-floor diff. Harder to reverse cheaply (new secret + billing surface + runner setup), and is exactly the kind of secret-provisioning decision Standing rule 8 reserves for escalation rather than unilateral action.
- Chosen (RECOMMENDED, auto): Option A — Lightweight reaffirmation . Add an unconditional containment-probe job to ci.yml (same "always-registers, internally diff-scoped" shape as lint-plan/depcruise, avoiding the synthwatch #102 deadlock class ci-gate.yml is built around). It computes the PR's changed paths, reuses the existing containmentTrigger() to detect a match, and if matched, runs the deterministic test/containment.test.ts suite as an explicit, dedicated required assertion (no network, no secrets, no live worker spawn — same fail-closed logic already unit-tested). Add "containment-probe" to ci-gate.yml's REQUIRED array. Cost: ~free, no new infra. Reversible: revert the two workflow-file edits.
- Rollback: revert the PR.

## 2026-07-18T13:14:01.019Z — W1-T96 (W1-T96-1784379675195)
- Options: Option A — : scope mutate to a small, curated set of pure-logic modules, starting with src/lib/classify.ts. I already have a complete, real Stryker JSON report for it from the pilot run (mutation score 75.93%: 70 killed, 12 timeout, 26 survived, 0 no-coverage, 0 errors) — I'd use that as the recorded baseline. This keeps the CI job to ~5 minutes (safely inside ci-gate's 15-minute window) while still being a genuine, falsifiable gate (a real .mjs/.json mutation report, not a stub). Reversible: widening scope later is a one-line glob change in stryker.conf.json + re-running Stryker to recapture the baseline — no script or CI-wiring changes needed. | Option B — mutate the full src//.ts tree for maximum thoroughness. Not viable today: ~4 hours per run, which either deadlocks ci-gate (fails-closed after 15 min) or requires also raising that ceiling repo-wide (a separate, riskier change affecting every other required check's timeout), plus I can't even establish the baseline number in this session's budget. Would need a custom Stryker runner plugin (coverage-per-mutant test filtering for node --test) as prerequisite work — a separate task.
- Chosen (RECOMMENDED, auto): Option A — : scope mutate to a small, curated set of pure-logic modules, starting with src/lib/classify.ts. I already have a complete, real Stryker JSON report for it from the pilot run (mutation score 75.93%: 70 killed, 12 timeout, 26 survived, 0 no-coverage, 0 errors) — I'd use that as the recorded baseline. This keeps the CI job to ~5 minutes (safely inside ci-gate's 15-minute window) while still being a genuine, falsifiable gate (a real .mjs/.json mutation report, not a stub). Reversible: widening scope later is a one-line glob change in stryker.conf.json + re-running Stryker to recapture the baseline — no script or CI-wiring changes needed.
- Rollback: revert the PR.

## 2026-07-19T00:03:31.766Z — W1-T31 (W1-T31-1784419251648)
- Options: Context: W1-T31 requires (1) a CI gate (commitlint) that blocks non–Conventional-Commits messages, and (2) a CHANGELOG.md generator that reads commit history and computes a semver bump (feat:→minor, fix:→patch, BREAKING CHANGE→major), replacing 0.0.0-pre-alpha. The task's design field fixes the behavior but not the tooling, and two materially different implementations satisfy it: | Option A — : commitlint + commit-and-tag-version | Lint gate: @commitlint/cli + @commitlint/config-conventional, run as a new CI job over PR commits. | Generation: commit-and-tag-version (the actively-maintained fork of the now-archived standard-version) — a single tool that reads Conventional Commits, computes the bump, rewrites package.json's version, and prepends CHANGELOG.md. Invoked with --skip.commit --skip.tag (or --dry-run for the acceptance proof) so it only edits files — no auto-commit/tag/push — keeping publication gated behind the normal PR flow per the design note. | Why : one well-tested library owns the bump algorithm (prerelease/breaking-change edge cases already solved upstream); minimal custom code to write and maintain; the acceptance proof (feat: → new minor section) is a one-command demo. | Option B — commitlint + hand-rolled script | Same lint gate. | Generation: a new scripts/changelog.mjs built directly on the lower-level conventional-changelog-core + conventional- -bump libraries, hand-wiring the bump→version→CHANGELOG logic ourselves instead of adopting an all-in-one CLI's conventions (tag templates, release-commit format, etc.). | Trade-off: more code we own and must test ourselves, in exchange for zero inherited behavior from an all-in-one release tool. | Reversibility (both options): Purely additive — two new devDependencies, one new CI job, one new npm script, one generated CHANGELOG.md. No git history rewrite, no tags pushed, no npm publish. A follow-up PR can remove the tooling cleanly at any time.
- Chosen (RECOMMENDED, auto): Option A — : commitlint + commit-and-tag-version
- Rollback: revert the PR.

## 2026-07-19T01:26:13.397Z — W1-T34 (W1-T34-1784424135876)
- Options: Context: W1-T34 ("SELF-VERIFYING LEARNINGS") asks that a learnings entry may carry an assertion: (a shell command that must exit 0), and a failing assertion must auto-quarantine the entry so the injector (src/lib/learnings.ts) never selects it — until re-verification restores it. I read the existing precedent closely (plan/claims.yaml + scripts/claims-check.mjs for stateless CI assertions; learnings/index.json + scripts/generate-learnings-index.mjs --check for the generate-and-gate-on-staleness pattern used by the W1-T33 supersession work already in this corpus). Those two precedents point to genuinely different architectures for where the quarantine state lives, and the task's own wording ("lifecycle flips", "re-verification restores it") is compatible with either. I need to pick one before writing code. | Option A — Persisted quarantine, generate-and-check (mirrors the W1-T33 index pattern). . | Reversibility: fully reversible — quarantine is just a committed YAML field flip; reverting the triggering change and re-running npm run learnings-assert flips it back, same as any other generated-file gate in this repo. | Option B — Live computed quarantine, no persisted state. | Reversibility: also reversible (nothing persisted to revert), but it puts arbitrary corpus-authored shell execution on the hot path of ordinary prompt assembly (perf + a new side-effect/security surface on a function that is today pure), which is a bigger behavioral change than the task's "auto-quarantine" framing implies.
- Chosen (RECOMMENDED, auto): Option A — Persisted quarantine, generate-and-check (mirrors the W1-T33 index pattern). .
- Rollback: revert the PR.

## 2026-07-19T05:20:09.806Z — W1-T46 (W1-T46-1784438173119)
- Options: Context: W1-T46 replaces rmd drain/daemon v1's blunt STOP-ON-BLOCK with reasoning that sorts a block into one of three buckets: TRANSIENT (retry), INDEPENDENT-FAILURE (skip its dependent subtree + continue + flag), or GENUINE BLOCKER (pause + escalate). The transient case is unambiguous (reuse classify.ts's classifyFailure). The split between INDEPENDENT-FAILURE and GENUINE BLOCKER is not — the plan schema (plan.ts) has no "criticality" or "importance" field, and the task's own acceptance criteria describe the two cases with different wording ("a self-contained failure whose dependents do not need it" vs. "a task its dependents transitively need") that admits two materially different implementations. | Option A — Dependents-exist binary rule . Compute the blocked task's transitive dependents in the DAG (a new transitiveDependents(plan, taskId) in plan.ts/daemon.ts). Zero transitive dependents ⇒ INDEPENDENT-FAILURE: skip just that task (mark it blocked/flagged in the summary+ledger), continue draining everything else. One or more transitive dependents ⇒ GENUINE BLOCKER: pause and escalate — no dependent subtree is ever silently skipped. This is deterministic, requires no new plan-schema fields, matches the acceptance criteria's literal wording ("self-contained" = no dependents at all), and keeps the codebase's existing fail-closed bias ("never continue into the gap" holds absolutely: any real downstream need always escalates to a human, never gets quietly skipped). | Reversible: yes — pure logic in one new module + daemon/drain wiring; a later task can add a criticality signal (e.g. weighing --until) without touching callers. | Option B — Critical-path rule. Additionally weigh whether the dependent subtree contains the drain's --until target or covers all remaining runnable work; a non-trivial dependent subtree can still be classified INDEPENDENT-FAILURE (and its whole subtree skipped+flagged) if it's judged non-critical to the current goal. This satisfies the design blurb's literal "skip that subtree" phrasing for non-trivial subtrees, but requires inventing an unspecified "criticality" heuristic not present anywhere in the plan schema, is materially riskier to get wrong (a real downstream need could be silently skipped), and weakens the "never continue into the gap" invariant that the rest of this codebase treats as absolute. | Reversible: harder — once shipped, dependent code/tests encode the heuristic; walking it back means re-classifying past skip decisions.
- Chosen (RECOMMENDED, auto): Option A — Dependents-exist binary rule . Compute the blocked task's transitive dependents in the DAG (a new transitiveDependents(plan, taskId) in plan.ts/daemon.ts). Zero transitive dependents ⇒ INDEPENDENT-FAILURE: skip just that task (mark it blocked/flagged in the summary+ledger), continue draining everything else. One or more transitive dependents ⇒ GENUINE BLOCKER: pause and escalate — no dependent subtree is ever silently skipped. This is deterministic, requires no new plan-schema fields, matches the acceptance criteria's literal wording ("self-contained" = no dependents at all), and keeps the codebase's existing fail-closed bias ("never continue into the gap" holds absolutely: any real downstream need always escalates to a human, never gets quietly skipped).
- Rollback: revert the PR.

## 2026-07-19T07:25:52.424Z — W1-T1 (W1-T1-1784445806357)
- Options: src/run-task.ts already exists (4,343 lines) and is exactly what W1-T1 asks for: a proto-runner extracted from src/spike.ts that drives rmd run-task <id> through recon → prompt → implement → PR, built on src/lib/ (worker.ts, config.ts, etc.) without orchestration logic leaking into lib. | Git history confirms the extraction happened in commit 83ff9a8 — "WS-1 T1: rmd run-task — the proto-runner" — and every later commit (3bc4b88 drain, a0db5cc/1522058 W1-T62 fixes, 46ab123/fe13575 self-sync, up through 50ffe06 command registry, W1-T47) builds on top of it. | git merge-base --is-ancestor 83ff9a8 HEAD returns true: that commit is an ancestor of the current branch tip. It is not pending work — it's already merged into main and this branch (run-W1-T1-1784445806357, tracking origin/main) already contains it. | src/spike.ts still exists by design, not as leftover duplication: CONTRIBUTING.md explicitly refers to it as "the scratch spike script (src/spike.ts)" distinct from the real runner, and its own header comment says "Uses lib only; no orchestration logic leaks into lib" — i.e. it was already cleaned up as part of the extraction, not left as a copy to be re-extracted. | Working tree is clean (git status -sb shows no modified/staged/untracked files), so there is nothing to stage.
- Chosen (RECOMMENDED, auto): src/run-task.ts already exists (4,343 lines) and is exactly what W1-T1 asks for: a proto-runner extracted from src/spike.ts that drives rmd run-task <id> through recon → prompt → implement → PR, built on src/lib/ (worker.ts, config.ts, etc.) without orchestration logic leaking into lib.
- Rollback: revert the PR.

## 2026-07-19T08:19:55.164Z — W1-T1 (W1-T1-1784449062870)
- Options: src/spike.ts is the WS-0 spike (7985d6a, "WS-0 spike: prove the Remudero primitive loop end-to-end"). It already imports only from ./lib/worker.js — it has zero proto-runner logic embedded in it, and zero coupling to run-task.ts. | src/run-task.ts already exists as a fully-built, independent 4344-line module — literally headed by its own comment: // ── The proto-runner (WS-1 T1). Reads ONE tasks.yaml entry and runs the loop: recon → provenance-linted prompt → implement → PR → merge → verdict, ledgering every step. | test/run-task.test.ts (1382 lines) already exercises it extensively. | Git history confirms the extraction already happened, in its own PR, merged to main long before this worktree existed: | git status is clean; there is no leftover coupling, no duplicated logic between the two files, nothing to move.
- Chosen (RECOMMENDED, auto): src/spike.ts is the WS-0 spike (7985d6a, "WS-0 spike: prove the Remudero primitive loop end-to-end"). It already imports only from ./lib/worker.js — it has zero proto-runner logic embedded in it, and zero coupling to run-task.ts.
- Rollback: revert the PR.

## 2026-07-19T08:29:23.029Z — W1-T1 (W1-T1-1784449628323)
- Options: Findings: | plan/tasks.yaml (line 64-84) shows W1-T1 = "Extract run-task.ts from the spike lib (the proto-runner)" with pr: 2 and a comment noting deriveStatus resolves this task as merged — status is derived from GitHub, not the decorative status: queued field. | src/run-task.ts (4343 lines) already exists as its own module, fully separated from src/spike.ts (308 lines, the original WS-0 spike). | Its origin commit, 83ff9a8 "WS-1 T1: rmd run-task — the proto-runner", is literally titled as this extraction and is an ancestor of current HEAD (confirmed via git merge-base --is-ancestor). | 54 subsequent commits (through W1-T6, T8, T9c, T11, up to today's 50ffe06) have built on top of that same src/run-task.ts, so it's not just present but load-bearing for the rest of the repo's history.
- Chosen (RECOMMENDED, auto): Findings:
- Rollback: revert the PR.

## 2026-07-19T09:50:18.252Z — W1-T1 (W1-T1-1784454477520)
- Options: What the task asks for: "Extract run-task.ts from the spike lib (the proto-runner)." | What's actually in the repo (main, clean working tree): | src/spike.ts and src/run-task.ts are already separate, both tracked, both already on main. | git log --diff-filter=A -- src/run-task.ts shows exactly one creation commit: 83ff9a8 WS-1 T1: rmd run-task — the proto-runner — i.e., this extraction already happened as its own commit. | src/spike.ts was created earlier and separately (7985d6a WS-0 spike: prove the Remudero primitive loop end-to-end) and contains no run-task logic — it's a one-shot WS-0 proof script using lib/worker.ts only. | There is no remaining "spike lib" — src/lib/ has 37 modules (worker.ts, drain.ts, daemon.ts, plan.ts, retro.ts, escalate.ts, etc.), none of which hold proto-runner logic still living inside spike.ts. | MASTER-PLAN.md corroborates this: "L1 — DONE (2026-07-15): proto-runner — run-task.ts … It executed WS-1's entire own task list" and "WS-1 — Proto-runner → daemon — SHIPPED & COMPLETE 2026-07-15." run-task.ts has since grown to 194KB across ~47 subsequent tasks (drain, daemon, digest, escalate, retro, review, help registry, etc.) built on top of that extraction. | Conclusion: The extraction this task describes was completed long ago in this repo's history, and run-task.ts has since evolved far beyond a fresh extraction. There is no diff to make that would satisfy "make ONLY the change described in TASK" — attempting to re-derive run-task.ts from spike.ts now would either be a no-op or destructively regress 40+ tasks of subsequent work. Per standing rule 8 (proceed autonomously, escalate only when the plan requires it), this isn't a case needing a DECISION_REQUEST (no filename/approach ambiguity) — it's a stale/duplicate task assignment against current repo state.
- Chosen (RECOMMENDED, auto): What the task asks for: "Extract run-task.ts from the spike lib (the proto-runner)."
- Rollback: revert the PR.

## 2026-07-19T10:38:56.720Z — W1-T1 (W1-T1-1784457367501)
- Options: What TASK asked for: "Extract run-task.ts from the spike lib (the proto-runner)." | What's actually in the repo (HEAD 50ffe06, clean tree, current branch already tracks origin/main): | src/spike.ts (308 lines) is the one-shot WS-0 proof script — hardcoded sandbox repo, recon/probe/decision/implement flow. It contains no generalized runner logic to extract. | src/run-task.ts (4343 lines) already exists as the fully generalized, standalone proto-runner — bin/rmd dispatches straight to it (exec tsx src/run-task.ts "$@"), and it now backs the entire command registry (W1-T47), drain, daemon, review, sweep, etc. | git log --reverse -- src/run-task.ts shows the extraction happened in commit 83ff9a8, "WS-1 T1: rmd run-task — the proto-runner" (2026-07-14), whose message matches this task word-for-word: "Generalizes the WS-0 spike loop into rmd run-task <id> ... This is the last hand-authored task." | plan/tasks.yaml confirms it: the W1-T1 entry already carries pr: 2 (merged) and hand_built: true # L0. | 246 commits have landed on top of that extraction since, up through 50ffe06 (command registry) — the runner has been in continuous production use. | Action taken: none. No commit, no push, no PR — the repo already satisfies this task's acceptance criteria (merged PR, src/lib unchanged/lifted, settings validated before spawn — all shipped in 83ff9a8). | Recommendation: this looks like a stale re-dispatch of an already-merged L0 task from the queue/scheduler. Worth flagging to whoever re-enqueued W1-T1 so the drain/daemon doesn't keep re-offering completed hand-built tasks.
- Chosen (RECOMMENDED, auto): What TASK asked for: "Extract run-task.ts from the spike lib (the proto-runner)."
- Rollback: revert the PR.

## 2026-07-19T10:42:33.718Z — W1-T1 (W1-T1-1784457601815)
- Options: plan/tasks.yaml W1-T1 already carries pr: 2 # merged PR #2 -> deriveStatus resolves this task as merged. | git log --follow -- src/run-task.ts shows its origin commit is 83ff9a8 "WS-1 T1: rmd run-task — the proto-runner", followed by 18 more commits (fleet control, escalation, drain, review gate, fix rungs, etc.) built directly on top of it. | git merge-base --is-ancestor 83ff9a8 HEAD confirms that commit is already in this branch's history. | src/spike.ts today contains only the WS-0 sandbox-proof script (worktree/recon/probe/decision-round-trip demo) — it has no proto-runner logic left to extract; that logic already lives in src/run-task.ts (4,344 lines) and 25+ src/lib/.ts modules. | Options: | No-op / report stale dispatch . Make no code changes, push nothing, open no PR. Report that W1-T1 is already merged (PR #2) and this dispatch is stale/duplicate, likely from plan/tasks.yaml's decorative status: queued field being read instead of the GitHub-derived status. Reversibility: trivial — no changes exist to revert; the throwaway branch/worktree can simply be discarded. | Force a synthetic diff anyway (e.g. cosmetic comment shuffle in run-task.ts/spike.ts) just to produce something committable and satisfy the contract's push/PR steps. Reversibility: poor — run-task.ts is a heavily-built-upon, load-bearing file with 11+ dependent tasks layered on it; any edit risks an unreviewed, purposeless change landing on main and creates review/merge noise for zero functional value. | : No-op / report stale dispatch. | Reversibility: trivial (no changes made).
- Chosen (RECOMMENDED, auto): No-op / report stale dispatch . Make no code changes, push nothing, open no PR. Report that W1-T1 is already merged (PR #2) and this dispatch is stale/duplicate, likely from plan/tasks.yaml's decorative status: queued field being read instead of the GitHub-derived status. Reversibility: trivial — no changes exist to revert; the throwaway branch/worktree can simply be discarded.
- Rollback: revert the PR.

## 2026-07-19T10:47:20.626Z — W1-T1 (W1-T1-1784457870059)
- Options: git log --diff-filter=A -- src/run-task.ts → the file was created in commit 83ff9a8, titled "WS-1 T1: rmd run-task — the proto-runner", commit message: "Generalizes the WS-0 spike loop into rmd run-task <id>... src/run-task.ts — the loop; auto-choose via session resume, push without -u (FF10f), poll + squash-merge." | plan/tasks.yaml line 64-79 has an entry id: W1-T1, title: Extract run-task.ts from the spike lib (the proto-runner), hand_built: true # L0 — the last task written by hand; everything after rides this — i.e. this is the very first task, explicitly marked as already hand-built. | src/spike.ts (308 lines) is the original WS-0 one-shot spike script; src/run-task.ts (4,343 lines) is the fully generalized, extensively-built-upon extraction with its own 1,382-line test suite (test/run-task.test.ts) covering far more than the original acceptance criteria (fix rungs, CI gating, ownership guards, drain/daemon integration, etc.). | git rev-parse HEAD origin/main are identical (50ffe06), and git status --short --branch shows a clean tree with zero commits ahead of origin/main. There is nothing to diff, stage, or commit. | Option A : Close W1-T1 as already satisfied — make no code change, open no PR, report the evidence above back to the dispatcher so it stops re-issuing this task. | Option B: Force a trivial/cosmetic commit (e.g. a comment noting the historical extraction) purely to produce a PR and satisfy the contract's PR_URL requirement.
- Chosen (RECOMMENDED, auto): Option A — Reversibility: both are trivially reversible (Option A creates nothing to undo; Option B would need a follow-up revert of a spurious commit on a file 250+ tasks depend on). Stopping now rather than guessing which the dispatcher wants.
- Rollback: revert the PR.

## 2026-07-19T11:27:59.782Z — W1-T1 (W1-T1-1784460332634)
- Options: No action taken — this task is already complete upstream. | src/spike.ts (the "proto-runner" spike) still exists in the repo — it's the original one-shot WS-0 script (recon worker → containment probe → DECISION_REQUEST implement worker → PR/merge), exactly as TASK describes it. | src/run-task.ts already exists as a fully-built, ~4300-line module (runTask, runReview, drain, CLI dispatch, etc.), imported by dozens of tests (test/run-task.test.ts, test/task-linter-wiring.test.ts, test/mounts-wiring.test.ts, test/isolation-wiring.test.ts, test/help-registry.test.ts, and more). This is the extraction the task describes. | plan/tasks.yaml shows id: W1-T1 (title: "Extract run-task.ts from the spike lib (the proto-runner)") already carries pr: 2 — per the file's own header, task status is GitHub-derived, not the decorative status: queued field, so this task resolves as merged. | Local git history confirms it: 83ff9a8 WS-1 T1: rmd run-task — the proto-runner, merged via 25d1af0 Merge pull request #2 from craigoley/ws1/t1-proto-runner. Everything currently on main (through PR #247) was built on top of that extraction. | MASTER-PLAN.md independently corroborates: L1 — DONE (2026-07-15): proto-runner — run-task.ts, one tasks.yaml entry in, recon → ....
- Chosen (RECOMMENDED, auto): No action taken — this task is already complete upstream.
- Rollback: revert the PR.

## 2026-07-19T11:48:37.213Z — W1-T1 (W1-T1-1784461571091)
- Options: src/spike.ts (308 lines) is the standalone WS-0 primitive-loop proof script — it imports only from src/lib/worker.ts and contains no task-loop/proto-runner logic to extract. | src/run-task.ts (4343 lines) already exists as its own file, fully built out (recon → prompt → implement → PR → merge → ledger), far beyond the original extraction. | git status --short --branch shows a clean tree on run-W1-T1-1784461571091 tracking origin/main, with 50ffe06 as the tip — many commits past 83ff9a8. | No commit made, no PR opened — the task was already delivered in PR #2 (commit 83ff9a8).
- Chosen (RECOMMENDED, auto): src/spike.ts (308 lines) is the standalone WS-0 primitive-loop proof script — it imports only from src/lib/worker.ts and contains no task-loop/proto-runner logic to extract.
- Rollback: revert the PR.

## 2026-07-19T17:30:02.421Z — W1-T1 (W1-T1-1784482070789)
- Options: Context: This exact task (W1-T1: "Extract run-task.ts from the spike lib") has already been dispatched three prior times and closed as a no-op each time — most recently in commit bca5cd0 (PR #255, merged), which is also the current HEAD and origin/main in this worktree. The extraction happened for real back in commit 83ff9a8 (remudero PR #2): src/run-task.ts (4,343 lines) already holds the full proto-runner (recon → prompt → implement → PR, per its own header comment at line 147-149), and src/spike.ts (308 lines) today holds only the WS-0 sandbox smoke-test, with no runner logic left in it to extract. plan/tasks.yaml's own W1-T1 entry carries pr: 2 (already-merged). Working tree is clean; there is no diff to make. | (A) Close as already-satisfied, no functional code change — append a DECISIONS.md entry recording this as the fourth no-op re-dispatch, commit, push, open PR with the Remudero-Task: W1-T1 trailer. Consistent with the three prior closures; touches no runtime code. | (B) Force a cosmetic edit to src/run-task.ts or src/spike.ts just to produce a non-empty code diff — rejected three times already; manufactures a fake "extraction" against files that need no change, violating "one concern" and inviting exactly the kind of pointless diff the prior closures declined to make. | Reversibility: Both are low-risk single-file/doc changes revertible by reverting the PR. Option A is the safer default (no runtime code touched, matches established precedent).
- Chosen (RECOMMENDED, auto): (A) Close as already-satisfied, no functional code change — append a DECISIONS.md entry recording this as the fourth no-op re-dispatch, commit, push, open PR with the Remudero-Task: W1-T1 trailer. Consistent with the three prior closures; touches no runtime code.
- Rollback: revert the PR.

## 2026-07-20T08:35:34.757Z — W1-T55 (W1-T55-1784536098982)
- Options: Context: W1-T55 (plan/tasks.yaml:2546-2569) specifies building src/lib/ops.ts: a poller that reads code-scanning/Dependabot/secret-scanning alerts "via gh api for the managed repo set," surfaces counts+ages in the digest, and escalates new criticals with ledger-keyed dedup. I confirmed the shipped primitives to reuse (src/lib/digest.ts, src/lib/escalate.ts, ledger-dedup pattern from src/lib/sweep.ts) and the fail-soft gh api gateway pattern (src/lib/status.ts:377-410, src/lib/trace.ts:44-66). | The gap: "the managed repo set" is referenced only in prose (MASTER-PLAN.md:1127, plan/tasks.yaml:2558) — no code, config field, or file defines which repos that is. I need to pick how v0 resolves it, since that shapes the function signature and CLI flags of ops.ts. | Option A — Scope v0 to the current repo only (self, via resolveOwnerRepo()), . | Option B — Invent a "managed repo set" convention now (e.g. derive the distinct repo: values out of plan/tasks.yaml, or add a new config field) and poll all of them in v0.
- Chosen (RECOMMENDED, auto): Option A — Scope v0 to the current repo only (self, via resolveOwnerRepo()), .
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-20T09:01:25.826Z — W1-T57 (W1-T57-1784537673948)
- Options: Question: Where/how should the "managed repo set" (the list of owner/repo strings W1-T57 polls for issues) be configured? | Option A — : dedicated config file .remudero/managed-repos.json | Reversibility: trivial — it's an additive JSON file and one new reader function; deleting or renaming it later touches only that one module. | Option B — extend settings/worker.json with a new managedRepos: string[] key | Reversibility: moderate — later splitting it back out means a schema migration on a file other modules also read.
- Chosen (RECOMMENDED, auto): Option A — : dedicated config file .remudero/managed-repos.json
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-20T10:27:07.051Z — W1-T66 (W1-T66-1784542790860)
- Options: TokenPermissions (alerts #5, #6, #7, #8): codeql.yml, semgrep.yml, osv-scanner.yml, osv-scanner-pr.yml each declare security-events: write at the top level of the workflow. Fix is unambiguous and already precedented in this repo (scorecard.yml does exactly this): shrink top-level permissions: to the minimum (e.g. contents: read), and move the write escalation down to job-level only. No decision needed here — I'll do this as part of either option below. | PinnedDependencies (alert #2): semgrep.yml's run: pip install "semgrep==1.167.0" step is a pip command, not a uses:/image reference — the task's design text ("pin by SHA/digest... see whether it is an action or an image") assumed a form that doesn't match what's on disk. Two structurally different fixes exist, with real tradeoffs: | Option A — : switch the job to the official pinned container image. | Option B — keep pip, hash-lock the install.
- Chosen (RECOMMENDED, auto): Option A — : switch the job to the official pinned container image.
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-20 — DISTRIBUTION ARCHITECTURE (three tiers)
Operator direction record (not an auto-choose resolution): how the console + harness are distributed.
- **Tier 1 (NOW): self-hosted console.** Runs on the user's OWN machine, served over their tailnet/localhost.
  No accounts, no hosted backend. The public website is docs/marketing ONLY and NEVER connects to user instances.
- **Tier 2 (DEFERRED): hosted relay for remote access.** The agent initiates an OUTBOUND tunnel; the website
  brokers authenticated browser sessions to it (the Nabu Casa / Home Assistant Cloud pattern). NO inbound ports on
  the user's machine. The precondition is already true BY CONSTRUCTION: the api-client + the no-hand-rolled-fetch
  gate (W3-T1c) mean the console already talks to a URL-configurable backend, so a relay is a transparent proxy —
  W1-T139's "no same-origin assumptions" review criterion keeps it that way with zero console rework.
- **Tier 3 (with §6 packaging): global knowledge exchange.** A stateless, opt-in POST of scrubbed insights UP + a
  pull of a versioned, HASH-PINNED artifact DOWN. No persistent connection. Inherits the layered-knowledge shape
  (P32 — the rmd-global layer).
- Rollback: revert this record; no runtime code is bound by it (a direction record, reversible).

## 2026-07-20 — DEFERRED: optional macOS menu-bar daemon-status glanceable
An optional macOS menu-bar item showing daemon status at a glance (tiny, hits `GET /v1/status`) MAY be filed later
against a felt need — NOT now. The PWA console (W1-T139) covers the surface; a menu-bar glanceable is a native
affordance to add ONLY if the web console proves insufficient for at-a-glance status. Recorded so it is not
re-proposed as new; it is a known, deferred option.
- Rollback: revert this record.

## 2026-07-20T11:52:09.590Z — W1-T131 (W1-T131-1784548049093)
- Options: Task: Test fixtures leak one temp dir per fixture per run (mkdtempSync(join(tmpdir(), "<prefix>-")) in ~32 test files / ~60 call sites, none paired with cleanup — confirmed via comm diff against files containing rmSync). Mutation testing (Stryker) re-runs the suite per mutant, multiplying this into the reported 202,830 dirs / 14G. This is a different leak from the one src/lib/tmp.ts (W1-T115) already fixed — that module hardens rmd's own production runtime temp-dir usage; nothing in it touches test fixtures, which each hand-roll their own mkdtempSync call with no cleanup at all. | Option 1 — Global per-process sweep at exit | Reversibility: trivial — delete the one setup file and drop the one --import flag; no other file touched. | Option 2 — Explicit shared helper + touch every fixture | Reversibility: reversible but heavier — a single large mechanical commit touching 32 files; any new fixture added later that forgets the helper silently reintroduces the leak (no backstop).
- Chosen (RECOMMENDED, auto): Option 1 — Global per-process sweep at exit
- Risk: high (explicit reversibility caveat in the decision text)
- Rollback: revert the PR.

## 2026-07-21 — REJECTED: an ad-hoc second checkout / daemon (~/Remudero/remudero-2)
Operator direction record. To raise throughput, a second checkout + a second `rmd daemon` was
considered and REJECTED. Two UN-governed dispatchers recreate the 23-PR runaway class (the W1-T1
storm), and concurrent plan appends WITHOUT sharding recreate the DIRTY-cascade class (plan-file
conflicts). The fast path IS the safe path here, and it's two small builds away: W1-T121 (WIP
governor — bound dispatch) + W1-T122 (plan sharding — conflict-free concurrent filings), then P19's
N parallel dispatch lanes bounded by the governor's WIP limit (start N=2), with T80 dedup + T149
circuit-breaker as the per-task guards. Both prerequisites pulled to the immediate drain front.
- Rollback: n/a (a direction record; no runtime is bound to it).

## 2026-07-20T20:36:14.454Z — W1-T156 (W1-T156-1784579460422)
- Options: Context: W1-T156 depends on W1-T155 ("live-state DATA — full status taxonomy … MONOTONIC under darkness … github_unobservable"). I verified src/lib/status.ts from source: W1-T155 is not actually implemented despite the plan listing it as a merged dependency. derivePrPrecedence's failed-read fallback (lines 596–605) still does exactly the bug W1-T155's own rationale names as the falsifier: on a GitHub read failure it returns status: "queued", source: "throttled", indeterminate: true — i.e. a previously-merged/credited task can regress to queued on a transient outage, with no persistent "last-good" retention and no github_unobservable(since <t>) field. Only the older W1-T119 indeterminate/unavailableReason sparse fields exist. | Option A — : Scope W1-T156 strictly to its own files (src/lib/serve.ts). Build every UI+TRUST mechanic (live-ticking elapsed, delta-driven SSE via header-authed fetch streaming — mirroring packages/api-client's subscribeStatus pattern — in-place DOM patching preserving node identity/selection, reduced-motion/aria-live, and the reconnecting→N-failures→stale error lifecycle) against the projection fields that exist today. For the "GitHub unreachable" stamp, key it off the existing per-task indeterminate/source:"throttled" signal (real data, already flowing) rather than a new field. This faithfully renders whatever the projection says — including the still-buggy regression-to-queued if/when it fires upstream — but does not touch status.ts/board.ts. | Reversibility: fully additive. A future W1-T155 PR adding a real githubUnobservable/last-good field is a small follow-up wire-in here; nothing in this PR needs to be undone. | Option B — Also fix the monotonic-under-darkness + last-good-cache gap in status.ts/board.ts inside this same PR, so criterion 6 is end-to-end provably true. | Reversibility: harder — this duplicates/preempts W1-T155's own declared file scope, and risks a direct merge conflict if W1-T155 is independently dispatched/in-flight on the same files.
- Chosen (RECOMMENDED, auto): Option A — : Scope W1-T156 strictly to its own files (src/lib/serve.ts). Build every UI+TRUST mechanic (live-ticking elapsed, delta-driven SSE via header-authed fetch streaming — mirroring packages/api-client's subscribeStatus pattern — in-place DOM patching preserving node identity/selection, reduced-motion/aria-live, and the reconnecting→N-failures→stale error lifecycle) against the projection fields that exist today. For the "GitHub unreachable" stamp, key it off the existing per-task indeterminate/source:"throttled" signal (real data, already flowing) rather than a new field. This faithfully renders whatever the projection says — including the still-buggy regression-to-queued if/when it fires upstream — but does not touch status.ts/board.ts.
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-20T22:31:09.231Z — W1-T128 (W1-T128-1784586484416)
- Options: Task W1-T128 names two fix directions in its own design field (i): "Replace character-blocklist REFUSAL with EXECUTION IN THE EXISTING SANDBOX, or adopt a structured proof format with explicit cmd/expect fields." I verified the current mechanism in src/lib/review.ts — UNSAFE_FENCE_CHARS_RE = /[;&\$<>\n]/ refuses any dialect body (grep: … / unit test: …) containing those characters, even though execution goes through execFileSync with an argv array (never a shell), so those characters can't actually cause injection — the blocklist is refusing safety it already has by construction. This is a genuine approach fork with different blast radii, so per the output contract I'm stopping here instead of picking one. | Option 1 — Narrow the character blocklist . Since execFile never invokes a shell, ;, &, , $, <, > are inert as shell metacharacters — the real remaining hazards are path traversal (.., already separately checked) and literal glob expansion (, already separately refused). Stop refusing a dialect body just because ordinary prose contains a semicolon; keep refusing only what's actually unsafe for the argv it becomes. Surgical change confined to parseDialectGrep/parseTestTarget in src/lib/review.ts plus new tests in test/proof-execution.test.ts covering the four acceptance fixtures (101→N executable, a genuine fail still fails, the W1-T38 over-cap fixture, the #234 semicolon regression). Reversible: revert the regex/parsing diff; dialect proofs simply stop executing again — no schema or data migration, nothing else in the plan format changes. | Option 2 — New structured proof format (cmd:/expect: fields). Add a second, parallel dialect that sidesteps prose-parsing entirely. Requires extending the AcceptanceCriterion schema, teaching plan-authoring (Architect prompts/tooling) to emit the new shape, and either migrating or permanently stranding the 126 existing dialect-prefixed criteria already committed in plan/tasks.yaml/tasks.d/. Touches schema + authoring + review.ts. Not cleanly reversible once new-format criteria exist in the live plan (a second migration would be needed to back out).
- Chosen (RECOMMENDED, auto): Option 1 — Narrow the character blocklist . Since execFile never invokes a shell, ;, &, , $, <, > are inert as shell metacharacters — the real remaining hazards are path traversal (.., already separately checked) and literal glob expansion (, already separately refused). Stop refusing a dialect body just because ordinary prose contains a semicolon; keep refusing only what's actually unsafe for the argv it becomes. Surgical change confined to parseDialectGrep/parseTestTarget in src/lib/review.ts plus new tests in test/proof-execution.test.ts covering the four acceptance fixtures (101→N executable, a genuine fail still fails, the W1-T38 over-cap fixture, the #234 semicolon regression). Reversible: revert the regex/parsing diff; dialect proofs simply stop executing again — no schema or data migration, nothing else in the plan format changes.
- Risk: high (explicit reversibility caveat in the decision text)
- Rollback: revert the PR.

## 2026-07-21T01:18:25.612Z — W1-T136 (W1-T136-1784596357757)
- Options: Context: No shared "gate-compliant plan-PR emitter" exists today. retro and approve each build commits/PR bodies independently — approve's RatifyGateway.createRatificationBranch/openPlanPr (src/lib/inbox.ts + src/run-task.ts:5440-5482) splices payload.stampLine raw and unwrapped into the commit body (the live #387 defect) and opens a PR with no Acceptance block at all; retro (src/run-task.ts:2772-3053) delegates commit-authoring to a free-text-prompted LLM worker with no plan-index regen. plan-architect.ts and triage.ts each independently hand-roll a similar-but-not-identical pattern (header-only use of shapeCommitMessage, a hand-built single-bullet Acceptance block, no plan-index regen, no body-line wrapping). Building the shared emitter requires picking where it lives. | Option A — New module src/lib/plan-pr-emitter.ts | Option B — Extend src/lib/commit-message.ts in place | Reversibility: Both options are low-risk/high-reversibility — no data migration, no external contract change; either can be reverted with a single commit revert since nothing outside this repo depends on the new module's name or location yet.
- Chosen (RECOMMENDED, auto): Option A — New module src/lib/plan-pr-emitter.ts
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-23T02:26:36.818Z — W1-T144 (W1-T144-1784773326360)
- Options: Context: W1-T144 requires each pushed escalation/rundown line to carry a deep link that "resolves to the specific task card." The design note in plan/tasks.yaml (lines 4256-4262) explicitly leaves the addressing scheme open — "e.g. /#task=<id> or the serve route that renders that card" — and tells the implementer to choose after verifying source. I verified both candidates in src/lib/serve.ts / src/lib/task-card.ts: | GET /v1/task?id=<id> (task-card.ts) is a live, working route today — but it's scope: "read" (service.ts), meaning it 401s without a bearer token baked into the URL, and it returns raw JSON, not the rendered card UI. | /#task=<id> is a hash fragment: never sent to the server, so it can layer on top of whatever bookmarked/token-bearing console URL the operator already has open, and it's the natural SPA-router shape for "open straight to this card" — but no client-side code reads that hash yet (out of scope here per the task's own files: list, which excludes serve.ts). | Option A — Hash-route link (<consoleBaseUrl>/#task=<taskId>) — | Option B — Direct API route link (<consoleBaseUrl>/v1/task?id=<taskId>)
- Chosen (RECOMMENDED, auto): Option A — Hash-route link (<consoleBaseUrl>/#task=<taskId>) —
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-23T04:42:16.940Z — W1-T243 (W1-T243-1784781455828)
- Options: Task: W1-T243 — the feedback inbox has no commit bridge. captureFeedback() (src/lib/feedback.ts:205) writes plan/feedback/<id>.yaml as an untracked file in whatever checkout called it (5 call sites: run-task.ts CLI, ops.ts alert poller, issues-intake.ts, panel-graph.ts, panel-skill-run.ts). rmd triage (run-task.ts:6041-6064) deliberately reads the entry from a fresh origin/main worktree — so it never sees the file until a human manually git adds + commits + PRs it (confirmed pattern: dc527ad, 46bf1b7, f113636). plan/tasks.yaml:2720-2802 already specs this fix in detail and explicitly presents design options rather than a prescription, with the constraint that whichever ships must land through a gated PR (never a direct push to main) and must not make capture network-dependent (local write stays the durable buffer even if landing fails). | Option A — Land-on-capture . Add one choke-point helper (e.g. landFeedback() in feedback.ts, called right after the writeFileSync at line 226) that best-effort opens or amends a single shared chore(feedback): land pending filings PR against origin/main whenever a capture happens. Local write always succeeds first and is authoritative; if git/gh/network is unavailable, landing silently no-ops and the file just waits for the next successful attempt (manual rmd feedback land or a later capture). rmd triage's exit-2 message is updated to check the operator checkout for an unlanded copy of the id and report "pending landing (PR #N)" instead of the current indistinguishable "no such feedback entry." This directly automates the exact manual pattern already used in dc527ad/46bf1b7, so entries land within minutes of capture regardless of whether any daemon is running. | Reversibility: fully reversible — one new function plus one new call in each of the 5 sites (or one call inside the shared write helper) and one message-branch change in triage; deleting the helper call restores current (broken) behavior with no data loss, since the local file write is unchanged. | Option B — Daemon landing rung. Add a new rung to the existing serve/drain daemon loop (same shape as the recent atomic drafts-rung / retro-marker rungs) that periodically scans plan/feedback/.yaml in its own checkout and batches any unlanded entries into a gated PR. Fits the "daemon is sole writer" pattern used elsewhere in this repo, but triage stays broken until the next rung tick and the PR merges, and any machine/environment that captures feedback without the daemon running (e.g. a bare CLI box, CI) waits forever with no path to land. | Reversibility: also reversible — a new rung can be removed from the daemon's rung list — but it leaves a live gap (silent indefinite wait with no daemon) that Option A does not have.
- Chosen (RECOMMENDED, auto): Option A — Land-on-capture . Add one choke-point helper (e.g. landFeedback() in feedback.ts, called right after the writeFileSync at line 226) that best-effort opens or amends a single shared chore(feedback): land pending filings PR against origin/main whenever a capture happens. Local write always succeeds first and is authoritative; if git/gh/network is unavailable, landing silently no-ops and the file just waits for the next successful attempt (manual rmd feedback land or a later capture). rmd triage's exit-2 message is updated to check the operator checkout for an unlanded copy of the id and report "pending landing (PR #N)" instead of the current indistinguishable "no such feedback entry." This directly automates the exact manual pattern already used in dc527ad/46bf1b7, so entries land within minutes of capture regardless of whether any daemon is running.
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-24T16:04:50.262Z — W1-T12a (W1-T12a-1784908800976)
- Options: Task W1-T12a ("Daemon core — scheduler loop") is already fully implemented and merged — this dispatch is stale/duplicate. | git log --diff-filter=A -- src/lib/daemon.ts → created in commit 76ef4ba, "W1-T12a: daemon core - scheduler loop (DAG select to dispatch) (#61)". | gh pr view 61: state: MERGED, mergedAt: 2026-07-15T14:17:51Z, body ends with the trailer Remudero-Task: W1-T12a. | plan/tasks.yaml's own header (lines 1–9) states status is decorative: "STATUS IS DERIVED FROM GITHUB — this file is never machine-rewritten... real merge-state is DERIVED FROM GITHUB by deriveStatus(taskId), in precedence: ... (c) a merged PR whose body carries the trailer Remudero-Task: <id>." Precedence (c) is satisfied here — the YAML's status: queued at line 5904 is stale bookkeeping, not the true state. | The acceptance criterion itself — "given an injected clock + injected runner, the loop selects and dispatches tasks in dependency order and stops on STOP/Pause/headroom-exhausted" — is implemented in src/lib/daemon.ts's runDaemon (checks checkStop → checkPause → headroom → nextRunnable DAG selection, exactly as specced) and proven in test/daemon.test.ts (1290 lines) with tests literally named "dispatches in dependency order (DAG)...", "STOP: checked first, every tick...", "PAUSE (drain-and-hold)...", "headroom: a near-limit reading is an IN-PROCESS idle heartbeat..." — no real overnight run or worker spawn involved, matching the proof requirement verbatim. | It's wired into rmd daemon in src/run-task.ts, and extended by 15+ follow-on tasks since (W1-T12b/c, W1-T46, W1-T77, W1-T80, W1-T115, W1-T149, W1-T155, W1-T177, #472, #477, W1-T197, #543, W1-T235, W1-T215). | git status --short --branch on this worktree is clean against origin/main — there is no diff to make. | This is a documented recurring class: DECISIONS.md (lines 121–157) records the identical situation for W1-T1 (dispatched multiple times after PR #2 already merged it), each time resolved the same way. | Options: | A. No-op / report stale dispatch. Make no code changes, push nothing, open no PR. Report that W1-T12a is already merged (PR #61, 2026-07-15) and this dispatch is stale/duplicate — sourced from plan/tasks.yaml's decorative status: queued field being read instead of the GitHub-derived status. Reversibility: trivial — no changes made, nothing to revert. | B. Force a synthetic/cosmetic diff (e.g., a comment edit in daemon.ts) purely to produce something committable and satisfy the contract's push/PR mechanics. Reversibility: poor — daemon.ts is a heavily-built-upon, load-bearing scheduler core with 10+ dependent follow-on tasks layered directly on it; a purposeless edit risks unreviewed noise on a critical-path file, and would misrepresent to remudero-review that this PR satisfies acceptance criteria that were actually satisfied 9 days earlier by PR #61.
- Chosen (RECOMMENDED, auto): A. No-op / report stale dispatch. Make no code changes, push nothing, open no PR. Report that W1-T12a is already merged (PR #61, 2026-07-15) and this dispatch is stale/duplicate — sourced from plan/tasks.yaml's decorative status: queued field being read instead of the GitHub-derived status. Reversibility: trivial — no changes made, nothing to revert.
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-24T16:05:27.000Z — W1-T12a re-dispatch: already-satisfied, no-op close
- Options: (A) close as already-satisfied, no functional code change (RECOMMENDED) | (B) force a
  cosmetic edit to `src/lib/daemon.ts` or `src/run-task.ts` just to produce a non-empty diff
- Chosen (RECOMMENDED, auto): Option A — no functional code change.
- Rationale: `src/lib/daemon.ts`'s `runDaemon` (the scheduler loop: DAG-select via `nextRunnable`,
  reused from `drain.ts`; W1-T11 fleet-control STOP/PAUSE gates; the `headroom.ts` HeadroomTracker;
  drain/inflight locking owned by the CLI wiring) was already built and merged in commit `76ef4ba`
  ("W1-T12a: daemon core - scheduler loop (DAG select to dispatch)", `remudero` PR #61, merged
  2026-07-15T14:17:51Z, body trailer `Remudero-Task: W1-T12a`). `plan/tasks.yaml`'s own header
  documents `status:` as decorative/initial-state only — real merge-state is DERIVED FROM GITHUB by
  `deriveStatus`, in precedence including "(c) a merged PR whose body carries the trailer
  `Remudero-Task: <id>`" — which PR #61 satisfies, even though the W1-T12a entry (line 5904) still
  reads `status: queued`. The acceptance criterion ("given an injected clock + injected runner, the
  loop selects and dispatches tasks in dependency order and stops on STOP / Pause / headroom-exhausted
  ... unit tests over a fake plan + fake runner ... NO real overnight run, NO real worker spawns") is
  proven today by `test/daemon.test.ts` (1290 lines), with tests named exactly for each condition
  (`"dispatches in dependency order (DAG)..."`, `"STOP: checked first, every tick..."`, `"PAUSE
  (drain-and-hold)..."`, `"headroom: a near-limit reading is an IN-PROCESS idle heartbeat..."`). 15+
  follow-on tasks have built directly on this module since (W1-T12b/c, W1-T46, W1-T77, W1-T80,
  W1-T115, W1-T149, W1-T155, W1-T177, #472, #477, W1-T197, #543, W1-T235, W1-T215). At dispatch time
  `HEAD` matched `origin/main` with a clean tree — nothing to implement, diff, or PR against the task's
  actual files. This is the same re-dispatch class already recorded for W1-T1 (see the 2026-07-19
  entries above): a dispatcher keying off `tasks.yaml`'s decorative `status: queued` field instead of
  GitHub-derived status re-queues an already-merged task. Fixing that dispatcher logic is outside this
  task's one-concern scope and is left for a separate task against the dispatch/drain path.
- Rollback: revert this PR (removes only this DECISIONS.md entry; no runtime code touched).

## 2026-07-24T17:28:49.000Z — W1-T99 (W1-T99-1784913918134)
- Options: Task W1-T99 ("Escalation transport resilience — ensure labels exist, and ONE failed action never kills the sweep (the first live escalation's crash)") is already fully implemented and merged — this dispatch is stale/duplicate. | git log shows the fix already sitting on this worktree's own HEAD ancestry: commit 78488ef, "fix(escalate): provision labels before create, isolate sweep action throws (W1-T99) (#729)". | gh pr view 729: state: MERGED, mergedAt: 2026-07-24T17:24:34Z, body ends with the trailer Remudero-Task: W1-T99. | git status --short --branch on this worktree is clean against origin/main — there is no diff to make. | All three of tasks.yaml's own acceptance criteria (line 9548) are satisfied by code + tests already on HEAD: (1) "a missing label no longer loses the escalation or crashes anything" — src/lib/escalate.ts's escalate() now loops `wanted` labels through `deps.issues.ensureLabel` before create() and drops (never throws on) a label that fails provisioning, noting the drop in both the issue body and the `degraded_labels` ledger field; proven by test/escalate.test.ts's "escalate: ensureLabel is called for every wanted label BEFORE create" and "escalate: a gateway with no ensureLabel behaves exactly as before (back-compat)". (2) "one PR's action failure isolates — the sweep reconciles the rest" — src/lib/sweep.ts's runSweep wraps each disposition action per-PR, ledgers a distinct `sweep.action_failed` (pr, disposition, error) line on a throw, and continues; proven verbatim by test/sweep.test.ts's "runSweep: a 3-PR fixture where the MIDDLE PR's escalate throws -> sweep.action_failed ledgered for it, the other two reconcile, summary counts the failure" (asserts summary.actionsFailed === 1, exactly one sweep.action_failed line, and the other two PRs still act). (3) "the canonical crash is the regression fixture" — proven by test/sweep.test.ts's "runSweep: the canonical 2026-07-17 crash fixture — a single ambiguous PR whose gateway throws label-not-found never escapes runSweep, and the question payload still reached an issue via ENSURE-LABELS+DEGRADE" (asserts summary.actionsFailed === 0, the question was generated, and the issue opened with degraded_labels: ["escalation-blocked"]). Ran `npx tsx --test test/escalate.test.ts test/sweep.test.ts` on this worktree: 91/91 pass, 0 fail. | This is the same documented recurring class DECISIONS.md already records for W1-T1 and W1-T12a (task dispatched again after its own PR already merged, sourced from tasks.yaml's decorative `status: queued` field rather than the GitHub-derived truth). | Options: | A. No-op / report stale dispatch. Make no code changes to escalate.ts/sweep.ts, push nothing beyond this decision log, open no code PR. Report that W1-T99 is already merged (PR #729, 2026-07-24) and this dispatch is stale/duplicate. Reversibility: trivial — no functional changes made, nothing to revert. | B. Force a synthetic/cosmetic diff (e.g., a comment tweak in escalate.ts or sweep.ts) purely to produce something committable and satisfy the contract's push/PR mechanics. Reversibility: poor — both files are the exact load-bearing transport/reconciler this task's own incident concerns, already covered by 91 passing tests; a purposeless edit risks unreviewed noise on a critical-path file and would misrepresent to remudero-review that this PR satisfies acceptance criteria actually satisfied minutes earlier by PR #729.
- Chosen (RECOMMENDED, auto): A. No-op / report stale dispatch. Make no code changes to escalate.ts/sweep.ts, push nothing beyond this decision log, open no code PR. Report that W1-T99 is already merged (PR #729, 2026-07-24) and this dispatch is stale/duplicate — sourced from plan/tasks.yaml's decorative status: queued field being read instead of the GitHub-derived status. Reversibility: trivial — no functional changes made, nothing to revert.
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-24T18:31:25.000Z — W1-T256: deriveStatus rung (c) empty-search-as-authoritative (SUPERSEDES the 07-24 W1-T12a/W1-T99 closure rationale)
- SUPERSEDES the mechanism stated in the two 2026-07-24 W1-T12a entries (16:04:50, 16:05:27) and the W1-T99 entry (17:28:49) above. Those closures blamed `plan/tasks.yaml`'s decorative `status: queued` field. That is WRONG: the daemon does NOT dispatch off the decorative field — `nextRunnable` (src/lib/drain.ts:111) keys off the GitHub-derived `MergedSet`, and `t.status` is read only for `"blocked"` (drain.ts:113). The re-dispatches were a GitHub-derivation defect, not a stale-bookkeeping one.
- ACTUAL MECHANISM: `deriveStatus` rung (c) (src/lib/status.ts) credits a merged task via `findMergedByTrailer`, which runs GitHub's EVENTUALLY-CONSISTENT body full-text search (`gh pr list --state merged --search '"Remudero-Task: <id>" in:body'`). `ghGateway.tryJson` sets its `failed` flag ONLY on a non-zero `gh` exit; an exit-0 EMPTY result from a transient search miss parses cleanly, so `findMergedByTrailer` returns null, rung (c) is skipped, `readFailed()` is false (no W1-T119 defer), and control falls to the terminal `source:"none"`, `merged:false` (status.ts:1017). That confirmed-not-merged made `isMerged(taskId)` false and `nextRunnable` dispatched the already-merged task. A single search miss demoted an already-merged task to dispatchable.
- RECON (the one check): W1-T12a's `pr.opened` for PR #61 SURVIVES in the LIVE ledger (`{"ts":"2026-07-15T14:15:01.909Z",...,"step":"pr.opened",...pull/61}`), NOT only in a rotated archive. So this was NOT a rotation-retention gap feeding an empty rung (a) — rung (a)'s ledger evidence is intact; the failure is purely GitHub-read-side in rung (c). COMPANION CONSIDERATION (cited, NOT changed here): if ledger rotation ever evicts a task's `pr.opened` line, rung (a) goes dark too and the same false-none returns via a different door — a rotation-retention concern for a separate task, deliberately out of this PR's scope.
- FIX (this PR): rung (c2) HEAD-BRANCH CORROBORATION. An exit-0-empty trailer search is now treated as INDETERMINATE, never authoritative. Before concluding `source:"none"`, `deriveStatus` corroborates with a DETERMINISTIC, non-body-index read — `findMergedByHeadBranch` enumerates merged PRs whose head branch is `run-<taskId>-*` (`gh pr list --state merged --search 'head:run-<id>-'`, a structured ref match), re-asserting `run-<taskId>-\d+` ownership on each candidate exactly as rung (c) re-verifies the trailer. Empty on BOTH the trailer search AND the head-branch read is genuinely none; search-empty-but-branch-hit resolves merged via the branch; a `gh` failure on the corroboration returns null and defers via the existing W1-T119 indeterminate skip.
- COST OF THE BUG: four spurious re-dispatches on 2026-07-24 alone — W1-T1, W1-T12a (×2, PRs #61-era + the no-op #725), and W1-T99 (#729 already merged) — each a no-op PR against an already-merged task.
- Rollback: revert this PR — restores the empty-search-as-authoritative behavior (src/lib/status.ts + test/status.test.ts only; no schema or CLI surface touched).

## 2026-07-25T14:25:37.000Z — W1-T7 re-dispatch: already-satisfied, no-op close
- Options: (A) close as already-satisfied, no functional code change, record the closure in
  DECISIONS.md (RECOMMENDED) | (B) make no PR at all, report the finding only, since
  `plan/tasks.yaml`'s own `note` field already documents the restructure in full
- Chosen (RECOMMENDED, auto): Option A — no functional code change, DECISIONS.md entry as the
  audit trail.
- Rationale: W1-T7 (`plan/tasks.yaml` line 5836) carries exactly one acceptance criterion —
  "network/5xx/CI-flake retries consume NO strike; deterministic failures do", proof "classifier
  unit tests over recorded failure fixtures" — and it already reads `satisfied_by: "#48"`.
  `gh pr view 48`: title "W1-T7: transient-vs-strike classifier + diagnose-then-retry", state
  MERGED (2026-07-15T00:37:34Z), body ends with the trailer `Remudero-Task: W1-T7`, and its
  checklist records `npm test` 182/182 passing including 8 new cases in
  `test/classify.test.ts`. Both `src/lib/classify.ts` (12,358 B) and `test/classify.test.ts`
  (11,186 B) are present on this worktree's `HEAD`, confirming the shipped code is live, not
  just claimed. The task's own `note` field records a 2026-07-25 operator-ruled Architect
  restructure (plan-only PR #764, commit `825b751`, already an ancestor of this branch's `HEAD`):
  the former second criterion (two-strikes DIAGNOSE dispatch) was moved VERBATIM to W1-T7B
  because `runDiagnoseThenRetry` (`classify.ts:204`) has ZERO production call site — confirmed
  by `grep -rn runDiagnoseThenRetry src test`, which finds only its own definition, a comment
  reference in `flight-judge.ts:367`, and its own test file; W1-T7B (`plan/tasks.yaml` line
  7731, `depends_on: [W1-T7]`) carries that criterion forward. With criterion 1 satisfied by a
  merged, trailer-carrying PR and criterion 2 relocated to a dependent task, W1-T7 has no open
  acceptance criterion left to implement. `git status --short` is clean and this worktree's
  `HEAD` matches `origin/main` — there is no diff to make against `classify.ts` or its tests for
  this dispatch. Unlike the earlier W1-T12a/W1-T99 no-op closures (which blamed a since-fixed
  `deriveStatus` defect, W1-T256 above), this closure rests on the task's own already-merged
  restructure record, not on a GitHub-derivation gap.
- Rollback: revert this PR — removes only this DECISIONS.md entry; no runtime code touched.

## 2026-07-28 — OPERATOR RULING: the headroom governor ships ENABLED by default (SUPERSEDES fb-1784894405468-a4153e's DEFAULT clause; its flag architecture stands)

*Operator-authored, not a machine auto-choose resolution — recorded by hand at the operator's
instruction and marked so, exactly as the 2026-07-20 entry above.*

- **THE RULING.** `resolveHeadroomEnabled` (src/lib/config.ts, built by W1-T259 / PR #768 under ruling
  fb-1784894405468-a4153e) shipped with an inherited default of **false** — governor OFF unless a config
  field or `RMD_HEADROOM_ENABLED` turned it on. That default is REVERSED to **true**, in the operator's
  words: *"most people would prefer rmd to efficiently manage their tokens rather than eat into extra
  spend."* The product default protects the subscription window; **opting into overflow is the deliberate
  act**, expressed by setting `headroom.enabled: false` (or `RMD_HEADROOM_ENABLED=0`), never inherited
  from a permissive default.
- **SCOPE — the default clause ONLY.** a4153e's mechanism is kept verbatim and is NOT reopened: ONE switch
  gates all headroom-based dispatch gating (the live W1-T197 idle curve; the ratified-but-unbuilt W1-T249
  reserve gate when it lands); the env var overrides config in BOTH directions; DISABLED still means
  headroom is READ and LEDGERED every cycle with `enforced:false` (telemetry without enforcement) and an
  unreadable read is absent telemetry, never a hold; ENABLED still enforces the time-aware curve unchanged;
  and clause 4 stands — imputed dollars gate nothing, the per-run turn limit and `budget_usd` tripwire
  remain the runaway guards. The `runDaemon` library default was already TRUE and is untouched; what
  changed is that an unconfigured install now agrees with it instead of contradicting it.
- **THIS HOST IS UNCHANGED IN BEHAVIOUR.** The credits-burst posture a4153e ruled for is retained, but it
  is now carried EXPLICITLY: `~/.config/remudero/config.json` gains `"headroom": {"enabled": false}`. The
  live `rmd daemon` therefore still resolves the governor OFF here (validated at ruling time: the resolver
  over this host's on-disk config returns `false`). The operator's willingness to exceed 100% of the weekly
  window is now a recorded opt-out rather than an inherited silence.
- **DOCUMENTED FUTURE HOME.** W1-T252's `plan/policy.yaml` row for `headroom.enabled` is documented with
  the same default, **true** (plan/tasks.yaml, W1-T252 design), so the interim config carrier and the
  eventual policy row cannot disagree when the substrate lands.
- **FALSIFIER RETARGETED.** The a4153e falsifier (`test/daemon.test.ts`) no longer proves "the default
  does not gate" — it proves **disabled-by-config does not gate**: it resolves the posture through the real
  `resolveHeadroomEnabled` over an explicitly opted-out config and asserts no idle tick and no sleep. The
  default itself is asserted directly in `test/config.test.ts` (default ON; explicit config false honored;
  env wins both ways).
- Rollback: revert this PR — restores the `?? false` default in `resolveHeadroomEnabled` and this entry.
  This host's behaviour is unaffected either way while its config carries the explicit `false`; removing
  that config line is the separate, deliberate act of re-inheriting the default.

## 2026-07-29T18:12:27.342Z — W1-T202 (W1-T202-1785348476091)
- Options: Context: W1-T202 requires the shell to hold the write token client-side instead of the URL. The task's own design text flags the storage choice as "the real decision," stating both trade-offs explicitly but not mandating one, and the output contract requires me to escalate an approach choice like this rather than pick silently. | Option A — sessionStorage . Token is entered once via a prompt/paste UI and held only for the tab's lifetime; a closed tab or new tab requires re-pasting. Matches the design's own "safest" framing, and fits this task's origin (a security fix for a leaked write credential) — minimizes the window a stolen/XSS'd origin can exfiltrate the token, and dies automatically with the session rather than lingering on disk indefinitely. | Option B — localStorage. Token persists across tab closes and browser restarts, so the operator pastes it once ever (until manually cleared) rather than once per tab. More convenient, but any script that achieves XSS on this origin — now or via a future dependency — gets a standing, indefinitely-lived write credential rather than one bounded to a session. | Reversibility: Both are pure client-side storage calls swapped for each other (window.sessionStorage window.localStorage) behind the same read/write/clear helper functions the shell will use — switching later is a small, low-risk diff with no data migration and no server-side changes, since service.ts's token comparison is unaffected either way.
- Chosen (RECOMMENDED, auto): Option A — sessionStorage . Token is entered once via a prompt/paste UI and held only for the tab's lifetime; a closed tab or new tab requires re-pasting. Matches the design's own "safest" framing, and fits this task's origin (a security fix for a leaked write credential) — minimizes the window a stolen/XSS'd origin can exfiltrate the token, and dies automatically with the session rather than lingering on disk indefinitely.
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-29T23:43:38.196Z — W1-T248 (W1-T248-1785368126719)
- Options: Context. I've read the full W1-T248 acceptance list (plan/tasks.yaml:12037-12096), flight-judge.ts (W1-T21), risk-score.ts (W1-T22), mounts.ts/mounts.yaml, and had a research pass locate the actual dispatch-decision site in run-task.ts. Findings that bear on this fork: | All 6 acceptance criteria for W1-T248 name their proof as unit test: test/risk-judge.test.ts — none reference run-task.ts behavior or an integration test. | The two directly-analogous predecessor modules in this exact codebase — flight-judge.ts (W1-T21, a Layer-2 process judge) and risk-score.ts (W1-T22, a deterministic diff scorer) — both shipped fully built and unit-tested but deliberately UNWIRED into run-task.ts's live merge path. risk-score.ts's own module doc says outright: "Wiring scoreRisk/planRiskGate into the live run-task.ts pipeline... is follow-on integration work... same build-order note (MASTER-PLAN §4B 'Build order')." Neither is referenced anywhere in run-task.ts today (confirmed by grep). | The actual dispatch-decision site would be run-task.ts:3700-3710 (resolveAutoMergeArm(review, tddStrict, cappedOverride, log) → if (!armDecision.arm) { ...escalate... }) — a live hot path inside a 10,713-line file with an existing, presumably large, test surface. Gating it with a real judge spawn requires threading DI deps through that call site so existing tests aren't broken by a live LLM call, new config/mount plumbing, and care not to regress the existing arm/escalate logic. | W1-T248's own files: list does include src/run-task.ts (unlike W1-T21/W1-T22's tasks), and its rationale frames the judge as "the control this envelope adds ON that [dispatch] path" — genuine textual support for wiring it now. | Option A — Ship risk-judge.ts fully built + unit-tested; wire ONE minimal live call at the existing arm-gate | Reversibility: clean — a follow-up PR deleting the new file and the one call site (plus its import line) fully reverts; no data/schema changes, no migrations. | Option B — Ship risk-judge.ts only, fully unwired, matching the W1-T21/W1-T22 precedent to the letter | Reversibility: trivial — nothing in run-task.ts changes, so there's nothing to revert there; only the new module/test files exist.
- Chosen (RECOMMENDED, auto): Option A — Ship risk-judge.ts fully built + unit-tested; wire ONE minimal live call at the existing arm-gate
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-30 — W1-T262 re-dispatch: already-satisfied, no-op close

- Options: (A) close as already-satisfied, no functional code change, record the closure in
  DECISIONS.md (RECOMMENDED) | (B) make no PR at all, report the finding only, leaving no audit
  trail explaining why `plan/tasks.d/W1-T262-console-header-freshness-honesty.yaml` sits at
  `status: queued` / `attempts: 0` despite its work already shipping.
- Chosen (RECOMMENDED): Option A — no functional code change, DECISIONS.md entry as the audit
  trail, following the precedent set for W1-T7/#772, W1-T12a/#725, and W1-T99/#731.
- Rationale: this worktree's dispatch was cut for a five-criterion `implement` task
  (`src/lib/board.ts`, `src/lib/console-freshness.ts`, `src/lib/serve.ts`), but every criterion is
  already merged and passing at `HEAD`. `git merge-base --is-ancestor 6d6c5c7 HEAD` confirms
  `6d6c5c7` — "fix(serve): one coherent freshness model for the console header (W1-T262) (#777)" —
  is on `main` and an ancestor of this branch's `HEAD` (`fa766be`); its subject and body name
  W1-T262 and enumerate the same five fixtures this task's acceptance list does (three-chip
  co-display, impossible arithmetic, `$0.000`/0-turns-as-fact, 0-merged-during-outage,
  header-vs-NOW-row disagreement). It carries no separate `Remudero-Task:` trailer line — the
  task id is embedded in the commit subject and PR number instead — so provenance here is by
  subject-line match plus the code/test correspondence below, not a trailer grep.
  `src/lib/console-freshness.ts` (the pure `formatStamp`/`resolveFreshness` module) and
  `test/console-freshness.test.ts` are both live on `HEAD`; `npx tsx --test
  test/console-freshness.test.ts` runs all 7 cases green, covering criteria 1 (the three modes are
  mutually exclusive — a fresh/connected pane can never also read stale) and 2 (`formatStamp`
  derives absolute time and relative age from one instant + one clock, timezone labeled).
  `src/lib/board.ts` carries `liveSpendPending` (:88), `counts.merged_known` (:102, :214),
  `github_unreachable` (:109), `isRunningRow` (:200), and `counts.running: tasks.filter
  (isRunningRow).length` (:210) — the same predicate `renderNow` filters NOW's rows on.
  `npx tsx --test test/board.test.ts` runs all 48 cases green, including the named
  fb-…c124f9 fixtures: line 184 (`liveSpendPending` true when no spend line has landed, never a
  defined `liveSpendUsd:0`/`liveTurns:0`), line 210 (`github_unreachable`/`counts.merged_known`
  false during an unreachable read, so merged reads UNKNOWN, never 0), and lines 226-236
  (`counts.running` equals `rows.filter(isRunningRow).length` exactly, never a header count the
  rendered rows disagree with). `src/lib/serve.ts` mirrors the same tested logic: :1115-1122
  refuses to raise the STALE banner while data delivered inside `STALE_DATA_AGE_MS` on ANY
  transport (mirrors `resolveFreshness`'s fresh-implies-live invariant), :1531-1532 renders
  "no data yet" on `t.liveSpendPending` rather than a zeroed spend/turns line, and :1142 renders
  "merged: unknown (GitHub unreachable)" rather than 0. `git status --porcelain` is empty and this
  worktree's `HEAD` matches `origin/main` — there is no diff to make against `board.ts`,
  `console-freshness.ts`, or `serve.ts` for this dispatch. Per `src/lib/plan.ts:101-105` and
  `src/lib/status.ts:20-59`, a task's `status:` field is decorative/initial-state only (real
  merge-state is GitHub-derived and never written back), and per `src/lib/review.ts:2906-2932`
  (Standing rule 15) `satisfied_by` is Architect-only — a worker-added one fails review — so
  neither `plan/tasks.d/W1-T262-console-header-freshness-honesty.yaml`'s `status` field nor its
  acceptance criteria are touched by this PR.
- Rollback: revert this PR — removes only this DECISIONS.md entry; no runtime code touched.

## 2026-07-30T21:46:06.014Z — W1-T191 (W1-T191-1785447447781)
- Options: What I verified from source first (per the design note's own instruction to distrust its account): | repoRoot (run-task.ts:486) is the daemon's own checkout — the orchestrator process's root, not the worker's worktree. The DECISIONS.md append at run-task.ts:3406 happens in the orchestrator, between spawning the worker and resuming it; the worker's own resume prompt (run-task.ts:3429-3432) never mentions this file, so it isn't picked up by the worker's own commit today. | Option (c) — derive from the ledger — is not viable as scoped: state/ledger.ndjson is itself gitignored (.gitignore: state/) and never committed. Deriving DECISIONS.md from it wouldn't fix durability at all unless the ledger (or an extract) were also made git-durable — which is just option (b) with extra steps. And the logged line (run-task.ts:3414) only carries {chosen, recorded, risk_band}, not the full option text. (c) is ruled out. | Option (a) as literally written — move the append into the worker's worktree so it rides the worker's own PR — is disqualified by the design's own stated risk: DECISIONS.md stays one shared, growing file: two concurrent worker PRs each appending a line at end-of-file, merged sequentially, is the textbook git append-conflict case (this is exactly why W1-T122 sharded plan/tasks.yaml instead of leaving it a shared list). That directly fails acceptance criterion 2 ("concurrent resolutions cannot conflict"), so (a)-as-stated can't be the whole fix. | Option 1 — : shard per decision + generalize the existing feedback-landing bridge. | Option 2 — single shared log via read-modify-write retry against origin/main's current tip. | Recommendation: Option 1. It's the same shape already proven for site 2, avoids the conflict class entirely rather than mitigating it with retries, and matches the design note's own preference ("two writes drift, one source does not" / W1-T122 precedent).
- Chosen (RECOMMENDED, auto): Option 1. Reversibility: both options are pure code changes with no destructive migration; Option 1 is strictly easier to unwind since it never touches the existing DECISIONS.md content.
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-30T22:41:47.711Z — W1-T195 (W1-T195-1785450852779)
- Options: Context. escalate() already dedupes on (taskId, PR number) scraped from free text (W1-T104). This task's design mandates a stricter key: (PR number, head sha, cause class). I read every real call site of escalate() that fires from the two rungs named in the rationale (fix-rung exhaustion — src/run-task.ts ~L2481, and the clarification/blocked-ambiguous rung — src/run-task.ts ~L7234, wired through sweep.ts's DISPOSITION_RULES). Neither embeds a full head sha in its summary/detail text consistently (one false-block branch embeds a truncated 7-char sha; the two rungs named in the rationale embed none), and their cause-class wording differs by code path ("blocked_review fix rung exhausted" vs. DISPOSITION_RULES' "required checks red — ci-log fix, strike …" / "review failing with no actionable unmet criteria"). Escalation has no headSha/cause field today. Two ways to close that gap: | Option A — . Structured optional fields. Add headSha?: string and cause?: string to the Escalation interface in escalate.ts; populate them at the two real call sites that motivated this task (the fix-rung exhaustion escalate in run-task.ts, using review.headSha; the clarification-rung escalate in run-task.ts's buildSweepEffects, using pr.headSha + a small reason→cause-class normalizer so both rungs emit the same three values: review/ci/conflict). escalate()'s dedup key becomes (taskId, prRef, headSha, cause), matching a dimension only when both sides supply it (so callers that never populate it keep today's (taskId, prRef) behavior, never regressing W1-T104). This is the only version that actually fixes the six real pairs in the rationale, not just contrived unit tests. Reversible: both fields are optional and additive; dropping them later is a no-op for every caller that doesn't set them. | Option B — Pure content-scraping, no caller changes. Stay inside escalate.ts + test/escalate.test.ts only (matching the task's literal files: list and W1-T104's precedent): add regex extraction for a sha-looking token and a keyword classifier (/review/, /ci|checks/, /conflict/) over existing summary+detail text. Reversible: contained to one file, trivial to swap for Option A later — but it is a cosmetic fix: the two rungs in the rationale don't currently write a sha into text at all, so escalate() would still collapse them without ever checking sha, and unit tests proving the sha/cause split would only pass because the test — not any real caller — puts the sha in the text.
- Chosen (RECOMMENDED, auto): Option A — . Structured optional fields. Add headSha?: string and cause?: string to the Escalation interface in escalate.ts; populate them at the two real call sites that motivated this task (the fix-rung exhaustion escalate in run-task.ts, using review.headSha; the clarification-rung escalate in run-task.ts's buildSweepEffects, using pr.headSha + a small reason→cause-class normalizer so both rungs emit the same three values: review/ci/conflict). escalate()'s dedup key becomes (taskId, prRef, headSha, cause), matching a dimension only when both sides supply it (so callers that never populate it keep today's (taskId, prRef) behavior, never regressing W1-T104). This is the only version that actually fixes the six real pairs in the rationale, not just contrived unit tests. Reversible: both fields are optional and additive; dropping them later is a no-op for every caller that doesn't set them.
- Risk: medium (medium-risk signal in the decision text)
- Rollback: revert the PR.

## 2026-07-31 — W1-T201 re-dispatch: already-satisfied, no-op close (OPERATOR-RULED)

*Operator-ruled closure, recorded at the operator's instruction — not a machine auto-choose
resolution, and marked so in the manner of the 2026-07-20 and 2026-07-28 entries above.*

- Options: (A) close as already-satisfied, no functional code change, record the closure here and
  file the one genuine residual as its own task (RECOMMENDED, and the operator's ruling) | (B) park
  W1-T201 — rejected: parking preserves a task whose title and rationale ("`retroCommand`'s only
  caller is the CLI", "R10 could not fire through 70 merges") are now empirically FALSE, and a
  future implementer reading it would rebuild what already runs
- Chosen (RECOMMENDED): Option A — no functional code change, this DECISIONS.md entry as the audit
  trail, following the precedent set for W1-T7/#772, W1-T12a/#725, W1-T99/#731 and most recently
  W1-T262 (2026-07-30, the entry immediately above this one).
- Rationale: W1-T201 (`plan/tasks.d/W1-T201-retro-cadence-trigger.yaml`) asks to wire a
  merges/days-thresholded, integrity-gated retro trigger into the daemon poll loop, keyed so one
  threshold crossing fires one retro. **W1-T160 shipped exactly that as PR #853**, and it has fired
  unattended TWICE in production — both lines quoted verbatim from the unioned ledger (661 files,
  4,154,616 lines): `{"ts":"2026-07-29T16:04:27.148Z","run_id":"DAEMON-1785340932816","task_id":"DAEMON","step":"retro_triggered","reason":"merges","merges_since_marker":94,"days_since_marker":8.268563831018518}`
  followed by `retro.marker.advanced` at 16:23:16.698Z (which became PR #883), and
  `{"ts":"2026-07-31T00:00:24.683Z","run_id":"DAEMON-1785455116417","task_id":"DAEMON","step":"retro_triggered","reason":"merges","merges_since_marker":25,"days_since_marker":1.3170398958333334}`
  followed by `retro.marker.advanced` at 00:17:05.069Z (PR #974). The second firing at EXACTLY the
  25-merge threshold, with the marker advancing 17 minutes later, is criterion 3's idempotence
  observed in production rather than argued. Criterion-by-criterion at `2c8dff2`: (1) and (2) the
  daemon-path firing — `src/lib/daemon.ts:1282` `if (deps.checkRetroTrigger)`, `:1290`
  `log("retro_triggered", …)`, `:1299` `await deps.runRetroTrigger(decision)`; (3) idempotence keyed
  to the marker — `src/run-task.ts:5234-5242` reads `state/last-retro.json` and recomputes
  `mergesSinceMarker` via `shippedSince`, so the marker advance closes the window; (5) the integrity
  gate — `checkRetroIntegrity` (`src/lib/retro.ts:2377`), imported at `src/run-task.ts:233` and
  documented at `:5286-5288`, aborting to `retro_aborted_integrity`; (6) fail-soft — `daemon.ts:1301`
  `log("daemon.retro_trigger.run_failed", …)`, and that line appears ONCE in the live ledger
  (2026-07-29T16:25:16.647Z, a GraphQL rate-limit throw), so the path is exercised, not merely
  present. **Criterion 4 is the one thing that did NOT ship**: `src/run-task.ts:5243` calls
  `evaluateRetroTrigger(mergesSinceMarker, marker?.ts, now)` with NO fourth argument, so the
  parameter defaults to `defaultRetroTriggerPolicy()` (`src/lib/retro.ts:2315`) and the live
  thresholds are the source literals `DEFAULT_RETRO_MERGES_THRESHOLD = 25` (`retro.ts:2299`) and
  `DEFAULT_RETRO_DAYS_THRESHOLD = 7` (`retro.ts:2304`); `plan/policy.yaml` carries no `retro` key at
  all. That residual is filed as **W1-T264** (`plan/tasks.d/W1-T264-retro-cadence-policy-data.yaml`)
  rather than appended to W1-T252/W1-T253, because both of those merged on 2026-07-30 (#901, #921)
  and `postMergeAmendmentViolations` (`src/lib/task-linter.ts:735`, W1-T180) blocks amending a merged
  task's criteria.
- THE MECHANISM, and why this entry alone does not stop the re-dispatch: `status:` is decorative —
  `plan/tasks.yaml`'s own header says so, and `isDispatchEligible` (`src/lib/drain.ts:123`) reads
  `t.status` at exactly one place, `:127`, and only for the value `"blocked"`. The real gate is
  `:125` `if (isMerged(t.id)) return false;`, fed by the GitHub-derived projection. W1-T201 can never
  satisfy any derivation rung on its own: rung (c) needs a merged PR whose body carries
  `Remudero-Task: W1-T201`, and the PR that shipped this work — #853 — carries a `W1-T160` trailer,
  so **no trailer could ever have credited it**. This is the case `rmd correct` exists for: the
  sanctioned operator-correction writer (P9 / W1-T75) appends a `correction.provenance` line that is
  SUPREME over every rung (`src/lib/status.ts:875`). It is a state mutation, so it is the operator's
  to run, and it is NOT run by this PR. The exact command is in
  `state/impl-BQ-close-t201.md`. (A plan-only alternative exists — an explicit `pr: 853` field on the
  task feeds deriveStatus rung (b), `src/lib/status.ts:1098` — but it asserts #853 IS W1-T201's PR,
  which is not literally true and leaves no reason string; the correction line records the operator's
  judgement and why, which is better provenance for a cross-task credit.)
- Per `src/lib/plan.ts:41-45`, `satisfied_by` is ARCHITECT-ONLY and a worker-added one fails review,
  and per the header above `status:` is never written back — so, exactly as in the W1-T262 closure,
  **neither W1-T201's `status` field nor its acceptance criteria are touched by this PR.**
- Rollback: revert this PR — removes only this DECISIONS.md entry and the new W1-T264 shard; no
  runtime code touched, and no ledger line written.

## 2026-07-31 — W1-T254 re-dispatch: already-satisfied, no-op close (OPERATOR-RULED)

*Operator-ruled closure, recorded at the operator's instruction — not a machine auto-choose
resolution, and marked so in the manner of the 2026-07-20 and 2026-07-31 (W1-T201) entries above.*

- Options: (A) close as already-satisfied, no functional code change, record the closure here
  (RECOMMENDED, and the operator's ruling) | (B) re-diff `src/lib/daemon.ts`, `src/lib/sweep.ts`,
  `src/run-task.ts` and the two test files as if the task were unstarted — rejected: the target
  state already exists identically on this branch, so a "reimplementation" is either a no-op diff
  or a hand-authored variant risking drift from a tested, merged, `risk:high` concurrency mechanism
  for zero behavioral gain.
- Chosen (RECOMMENDED): Option A — no functional code change, this DECISIONS.md entry as the audit
  trail, following the precedent set for W1-T7/#772, W1-T12a/#725, W1-T99/#731, W1-T262
  (2026-07-30), and most recently W1-T201/#993 (2026-07-31, the entry immediately above this one).
- Rationale: W1-T254 (`plan/tasks.yaml:64-134`) asks for a restricted light-sweep ticker while
  `runOne` is in flight, outcome-keyed post-review dedup, per-PR throw containment, and attempt
  ledgering + a dry-run tag. **PR #720 (commit `15a2168`) shipped exactly that**, is already an
  ancestor of this worktree's HEAD (`git merge-base --is-ancestor 15a2168 HEAD` → true), and its
  body carries the trailer `Remudero-Task: W1-T254`. Criterion-by-criterion:
  1. **Outcome-keyed dedup** — `src/lib/sweep.ts`'s `priorActionsFromLedger` derives `postReviewed`
     from `review.posted`/`review.post_refused` lines keyed `taskId@headSha`, never from
     `sweep.disposed acted:true`. Proof: `test/sweep.test.ts:1873` "runSweep: post-review dedup is
     outcome-keyed — a prior acted:true dispose with no posted/refused verdict for that head still
     retries; a refusal for the head dedups (W1-T254)".
  2. **Per-PR throw containment** — the action switch in `runSweep` (`src/lib/sweep.ts`) is wrapped
     per-PR in try/catch; on throw `acted=false` and `action_error` is set on both the returned
     `SweepAction` and the `sweep.disposed` ledger line, and the loop continues. Proof:
     `test/sweep.test.ts:2101` "runSweep: a throwing action does not abort the pass — later PRs
     still reconcile and the throwing PR is attributed (W1-T254)".
  3. **Light-sweep ticker** — `src/lib/daemon.ts`'s `runDaemon` starts an interval on the injected
     clock (`DaemonDeps.sweepLight`, doc at `daemon.ts:638-660`, wiring at `:1412-1429`) around the
     `runOne` call, cleared once it settles; `src/run-task.ts:6639-6655` wires `buildSweepLightHook`
     with `actionable: (d) => d === "post-review"` (`run-task.ts:8633`), restricting the concurrent
     pass to the deterministic re-post only. Proof: `test/daemon.test.ts:1883` "W1-T254: the light
     sweep runs while runOne is in flight, so a green PR with an absent review re-posts within one
     poll interval (the #707 fix)".
  4. **Attempt ledgering + dry-run tag** — `buildSweepEffects.postReview` (`src/run-task.ts:8218-
     8227`) logs `sweep.post_review.attempt` before calling `reviewCommand`, then
     `sweep.post_review.done`/`.failed`; `runSweep`'s `sweep.dispose` line is tagged `dry_run: true`
     under `--dry-run`. Proof: `grep -n "sweep.post_review.attempt in src/run-task.ts" →
     src/run-task.ts:8227`.
  Live verification in this worktree, not just historical trust: after `npm ci` (sandboxed run hit
  `EPERM`/`EBADENGINE` writing outside the allowed cache path; a plain retry outside the sandbox
  succeeded), `node --test` over `test/sweep.test.ts` + `test/daemon.test.ts` → **216 + 86 tests, 0
  failures**, including the three named above.
- THE MECHANISM, and why this case differs from W1-T201's: `status:` is decorative (every entry in
  `plan/tasks.yaml` reads `status: queued` regardless of merge state) and `isDispatchEligible`
  (`src/lib/drain.ts:127`) reads it only for `"blocked"`; the real gate is `isMerged` at
  `drain.ts:125`, fed by the GitHub-derived, trailer-scanning projection. Unlike W1-T201 (whose
  shipping PR #853 carried an unrelated `W1-T160` trailer and so could never be credited without an
  `rmd correct` state mutation), **PR #720 already carries the exact `Remudero-Task: W1-T254`
  trailer** — the standard trailer-derived rung already resolves `isMerged("W1-T254")` true with no
  operator correction needed. This entry records the closure only; it performs no state mutation.
- Per `src/lib/plan.ts:41-45`, `satisfied_by` is ARCHITECT-ONLY and a worker-added one fails review,
  and per the file header above `status:` is never written back — so, exactly as in the W1-T201 and
  W1-T262 closures, **neither W1-T254's `status` field nor its acceptance criteria are touched by
  this PR.**
- Rollback: revert this PR — removes only this DECISIONS.md entry; no runtime code touched, and no
  ledger line written.

## 2026-07-31 — W1-T254 re-dispatch (second occurrence): already-satisfied, no-op close

- Options: (A) close as already-satisfied, no functional code change, record the closure here
  (RECOMMENDED) | (B) re-diff `src/lib/daemon.ts`, `src/lib/sweep.ts`, `src/run-task.ts` and the two
  test files as if the task were unstarted — rejected for the same reason as the entry immediately
  above: the target state already exists identically on this branch, so a "reimplementation" is
  either a no-op diff or a hand-authored variant risking drift from a tested, merged, `risk:high`
  concurrency mechanism for zero behavioral gain.
- Chosen (RECOMMENDED, auto): Option A — no functional code change, this DECISIONS.md entry as the
  audit trail, following the precedent set by the entry directly above (2026-07-31, PR #1007) and,
  before that, W1-T7/#772, W1-T12a/#725, W1-T99/#731, W1-T262 (2026-07-30), and W1-T201/#993.
- Rationale: this is the SAME task (`plan/tasks.yaml:64-134`) re-dispatched a second time on the
  same day the prior closure (commit `e8ef9f6`, PR #1007) landed. Nothing changed between the two
  dispatches: `git merge-base --is-ancestor 15a2168 HEAD` still resolves true (PR #720's commit
  `15a2168` is still an ancestor of this worktree's HEAD), and the four acceptance criteria still
  hold against the identical code:
  1. **Outcome-keyed dedup** — `src/lib/sweep.ts`'s `priorActionsFromLedger` still derives
     `postReviewed` from `review.posted`/`review.post_refused` lines, never from
     `sweep.disposed acted:true`. Proof: `test/sweep.test.ts:1873` "runSweep: post-review dedup is
     outcome-keyed — a prior acted:true dispose with no posted/refused verdict for that head still
     retries; a refusal for the head dedups (W1-T254)" — still present, still passes.
  2. **Per-PR throw containment** — the action switch in `runSweep` is still wrapped per-PR in
     try/catch, `acted=false` plus `action_error` on throw, loop continues. Proof:
     `test/sweep.test.ts:2101` "runSweep: a throwing action does not abort the pass — later PRs
     still reconcile and the throwing PR is attributed (W1-T254)" — still present, still passes.
  3. **Light-sweep ticker** — `src/lib/daemon.ts`'s `runDaemon` still starts the injected-clock
     interval (`DaemonDeps.sweepLight`, doc `daemon.ts:638-660`, wiring `:1412-1429`) around the
     `runOne` call; `src/run-task.ts:6643` still wires `buildSweepLightHook` with
     `actionable: (d) => d === "post-review"`. Proof: `test/daemon.test.ts:1883` "W1-T254: the light
     sweep runs while runOne is in flight, so a green PR with an absent review re-posts within one
     poll interval (the #707 fix)" — still present, still passes.
  4. **Attempt ledgering + dry-run tag** — `buildSweepEffects.postReview` (`src/run-task.ts:8218-
     8227`) still logs `sweep.post_review.attempt` before `reviewCommand`, then
     `sweep.post_review.done`/`.failed`. Proof: `grep -n "sweep.post_review.attempt"
     src/run-task.ts` → `src/run-task.ts:8227`, unchanged.
  Live re-verification in THIS invocation (not a re-read of the prior entry): `npm ci` outside the
  sandbox (node_modules was absent in this worker's copy of the worktree), then
  `node --test --import tsx --import ./test/setup/tmp-hygiene.ts test/sweep.test.ts` → **216
  tests, 0 failures**, and the same command over `test/daemon.test.ts` → **86 tests, 0 failures**,
  matching the prior entry's counts exactly.
- THE MECHANISM (unchanged from the entry above): `status:` in `plan/tasks.yaml` is decorative
  (`isDispatchEligible`, `src/lib/drain.ts:127`, reads it only for `"blocked"`); the real dispatch
  gate is `isMerged` (`drain.ts:125`). PR #720 already carries the exact trailer
  `Remudero-Task: W1-T254`, so the standard trailer-derived rung resolves `isMerged("W1-T254")` true
  with no operator correction needed — yet the dispatcher issued this task a second time regardless.
  **Follow-up worth filing separately:** the dispatcher does not appear to consult `isMerged` (or
  this file's growing run of already-satisfied closures) before re-issuing a task inside the same
  day as its own closure PR merged — a cheap pre-dispatch `isMerged` check would avoid this whole
  class of redundant re-dispatch, of which W1-T254 alone now has two same-day instances and W1-T1
  had four historically.
- Per `src/lib/plan.ts:41-45`, `satisfied_by` is ARCHITECT-ONLY and a worker-added one fails review,
  and per the file header above `status:` is never written back — so, exactly as in every prior
  closure in this file, neither W1-T254's `status` field nor its acceptance criteria are touched by
  this PR.
- Rollback: revert this PR — removes only this DECISIONS.md entry; no runtime code touched, and no
  ledger line written.

## 2026-07-31 — W1-T254 re-dispatch (third occurrence): already-satisfied, no-op close

- Options: (A) close as already-satisfied, no functional code change, record the closure here
  (RECOMMENDED) | (B) re-diff `src/lib/daemon.ts`, `src/lib/sweep.ts`, `src/run-task.ts` and the two
  test files as if the task were unstarted — rejected for the same reason as both entries above:
  the target state already exists identically on this branch, so a "reimplementation" is either a
  no-op diff or a hand-authored variant risking drift from a tested, merged, `risk:high` concurrency
  mechanism for zero behavioral gain.
- Chosen (RECOMMENDED, auto): Option A — no functional code change, this DECISIONS.md entry as the
  audit trail, following the precedent set by the two entries directly above (2026-07-31, PR #1007
  and PR #1012) and, before that, W1-T7/#772, W1-T12a/#725, W1-T99/#731, W1-T262 (2026-07-30), and
  W1-T201/#993.
- Rationale: this is the SAME task (`plan/tasks.yaml:64-134`) re-dispatched a THIRD time, this
  worktree (`run-W1-T254-1785509104304`) built on top of a HEAD that already contains both prior
  no-op closures (`e8ef9f6`/#1007, `ed92da8`/#1012). Nothing changed between dispatches:
  `git merge-base --is-ancestor 15a2168 HEAD` still resolves true (PR #720's commit `15a2168` is
  still an ancestor of this worktree's HEAD, `e7f9864`), and the four acceptance criteria still hold
  against the identical code:
  1. **Outcome-keyed dedup** — `src/lib/sweep.ts`'s `priorActionsFromLedger` still derives
     `postReviewed` from `review.posted`/`review.post_refused` lines (`sweep.ts:1858-1865`), never
     from `sweep.disposed acted:true`. Proof: `test/sweep.test.ts:1873` "runSweep: post-review dedup
     is outcome-keyed — a prior acted:true dispose with no posted/refused verdict for that head
     still retries; a refusal for the head dedups (W1-T254)" — still present, still passes.
  2. **Per-PR throw containment** — the action switch in `runSweep` is still wrapped per-PR in
     try/catch, `acted=false` plus `action_error` on throw, loop continues (`sweep.ts:2241-2310`).
     Proof: `test/sweep.test.ts:2101` "runSweep: a throwing action does not abort the pass — later
     PRs still reconcile and the throwing PR is attributed (W1-T254)" — still present, still passes.
  3. **Light-sweep ticker** — `src/lib/daemon.ts`'s `runDaemon` still starts the injected-clock
     interval (`DaemonDeps.sweepLight`, doc `daemon.ts:638-660`, wiring `:1412-1429`) around the
     `runOne` call; `src/run-task.ts:6643` still wires `buildSweepLightHook` with
     `actionable: (d) => d === "post-review"`. Proof: `test/daemon.test.ts:1883` "W1-T254: the light
     sweep runs while runOne is in flight, so a green PR with an absent review re-posts within one
     poll interval (the #707 fix)" — still present, still passes.
  4. **Attempt ledgering + dry-run tag** — `buildSweepEffects.postReview` (`src/run-task.ts:8224-
     8238`) still logs `sweep.post_review.attempt` before `reviewCommand`, then
     `sweep.post_review.done`/`.failed`. Proof: `grep -n "sweep.post_review.attempt"
     src/run-task.ts` → `src/run-task.ts:8233`, unchanged.
  Live re-verification in THIS invocation (fresh worktree, `node_modules` absent — sandboxed
  `npm ci` hit `EPERM` on the root-owned `.npm` cache dir, a plain retry outside the sandbox
  succeeded): `node --test` (via `npx vitest run`, whose TAP passthrough surfaces the underlying
  `node:test` results) over `test/sweep.test.ts` → **130 tests, 0 failures**, and over
  `test/daemon.test.ts` → **86 tests, 0 failures**, including the four named acceptance tests.
- THE MECHANISM (unchanged from the two entries above): `status:` in `plan/tasks.yaml` is decorative
  (`isDispatchEligible`, `src/lib/drain.ts:127`, reads it only for `"blocked"`); the real dispatch
  gate is `isMerged` (`drain.ts:125`). PR #720 already carries the exact trailer
  `Remudero-Task: W1-T254`, so the standard trailer-derived rung resolves `isMerged("W1-T254")` true
  with no operator correction needed — yet the dispatcher issued this task a THIRD time regardless,
  on top of a HEAD that already contained both prior no-op closures. **This raises the standing
  follow-up from the #1012 entry from a hypothesis to a confirmed pattern**: W1-T254 now has three
  same-day re-dispatch instances (the first two already closed, this the third), the dispatcher does
  not consult `isMerged` (or this file's own closure history) before re-issuing, and the cost is not
  hypothetical — three full worker sessions (worktree + `npm ci` + test run + PR) spent reconfirming
  an unchanged fact.
- Per `src/lib/plan.ts:41-45`, `satisfied_by` is ARCHITECT-ONLY and a worker-added one fails review,
  and per the file header above `status:` is never written back — so, exactly as in every prior
  closure in this file, neither W1-T254's `status` field nor its acceptance criteria are touched by
  this PR.
- Rollback: revert this PR — removes only this DECISIONS.md entry; no runtime code touched, and no
  ledger line written.

## 2026-07-31 — W1-T254 re-dispatch (fourth occurrence): already-satisfied, no-op close

- Options: (A) close as already-satisfied, no functional code change, record the closure here
  (RECOMMENDED) | (B) re-diff `src/lib/daemon.ts`, `src/lib/sweep.ts`, `src/run-task.ts` and the two
  test files as if the task were unstarted — rejected for the same reason as all three entries
  above: the target state already exists identically on this branch, so a "reimplementation" is
  either a no-op diff or a hand-authored variant risking drift from a tested, merged, `risk:high`
  concurrency mechanism for zero behavioral gain.
- Chosen (RECOMMENDED, auto): Option A — no functional code change, this DECISIONS.md entry as the
  audit trail, following the precedent set by the three entries directly above (2026-07-31, PR
  #1007, PR #1012, and PR #1013) and, before those, W1-T7/#772, W1-T12a/#725, W1-T99/#731, W1-T262
  (2026-07-30), and W1-T201/#993.
- Rationale: this is the SAME task (`plan/tasks.yaml:64-134`) re-dispatched a FOURTH time, this
  worktree (`run-W1-T254-1785510118197`) built on top of a HEAD that already contains all three
  prior no-op closures (`e8ef9f6`/#1007, `ed92da8`/#1012, `b9f7733`/#1013). Nothing changed between
  dispatches: `git merge-base --is-ancestor 15a2168 HEAD` still resolves true (PR #720's commit
  `15a2168` is still an ancestor of this worktree's HEAD, `c0bfd13`), and the four acceptance
  criteria still hold against the identical code:
  1. **Outcome-keyed dedup** — `src/lib/sweep.ts`'s `priorActionsFromLedger` still derives
     `postReviewed` from `review.posted`/`review.post_refused` lines, never from
     `sweep.disposed acted:true`. Proof: `test/sweep.test.ts` subtest "runSweep: post-review dedup
     is outcome-keyed — a prior acted:true dispose with no posted/refused verdict for that head
     still retries; a refusal for the head dedups (W1-T254)" — still present, still passes (`ok
     108` of 130).
  2. **Per-PR throw containment** — the action switch in `runSweep` is still wrapped per-PR in
     try/catch, `acted=false` plus `action_error` on throw, loop continues. Proof:
     `test/sweep.test.ts` subtest "runSweep: a throwing action does not abort the pass — later PRs
     still reconcile and the throwing PR is attributed (W1-T254)" — still present, still passes
     (`ok 122` of 130).
  3. **Light-sweep ticker** — `src/lib/daemon.ts`'s `runDaemon` still starts the injected-clock
     interval (`DaemonDeps.sweepLight`) around the `runOne` call; `src/run-task.ts` still wires
     `buildSweepLightHook` with `actionable: (d) => d === "post-review"`. Proof:
     `test/daemon.test.ts` subtest "W1-T254: the light sweep runs while runOne is in flight, so a
     green PR with an absent review re-posts within one poll interval (the #707 fix)" — still
     present, still passes (`ok 75` of 86).
  4. **Attempt ledgering + dry-run tag** — `buildSweepEffects.postReview` still logs
     `sweep.post_review.attempt` before `reviewCommand`, then `sweep.post_review.done`/`.failed`.
     Proof: `grep -n "sweep.post_review.attempt" src/run-task.ts` → `src/run-task.ts:8233`,
     unchanged.
  Live re-verification in THIS invocation (fresh worktree, `node_modules` absent — sandboxed
  `npm ci` hit the same root-owned `.npm` cache `EPERM` as the prior three closures, a plain retry
  outside the sandbox succeeded): `npx vitest run` (whose TAP passthrough surfaces the underlying
  `node:test` results) over `test/sweep.test.ts` → **130 tests, 0 failures**, and over
  `test/daemon.test.ts` → **86 tests, 0 failures**, including all four named acceptance tests
  above.
- THE MECHANISM (unchanged from the three entries above): `status:` in `plan/tasks.yaml` is
  decorative (`isDispatchEligible`, `src/lib/drain.ts:127`, reads it only for `"blocked"`); the
  real dispatch gate is `isMerged` (`drain.ts:125`). PR #720 already carries the exact trailer
  `Remudero-Task: W1-T254`, so the standard trailer-derived rung resolves `isMerged("W1-T254")`
  true with no operator correction needed — yet the dispatcher issued this task a FOURTH time
  regardless, on top of a HEAD that already contained all three prior no-op closures. This is now
  four same-day re-dispatch instances of the identical task, confirming (rather than merely
  raising) the standing follow-up from the #1007/#1012/#1013 entries: the dispatcher does not
  consult `isMerged` (or this file's own closure history) before re-issuing, and the cost compounds
  — four full worker sessions (worktree + `npm ci` + test run + PR) now spent reconfirming an
  unchanged fact. This follow-up is filed as a `task:` item in this PR's description rather than
  re-litigated further here, since restating it a fifth time in this file would itself become part
  of the waste it describes.
- Per `src/lib/plan.ts:41-45`, `satisfied_by` is ARCHITECT-ONLY and a worker-added one fails
  review, and per the file header above `status:` is never written back — so, exactly as in every
  prior closure in this file, neither W1-T254's `status` field nor its acceptance criteria are
  touched by this PR.
- Rollback: revert this PR — removes only this DECISIONS.md entry; no runtime code touched, and no
  ledger line written.

## 2026-07-31 — W1-T254 re-dispatch (fifth occurrence): already-satisfied, no-op close

- Options: (A) close as already-satisfied, no functional code change, record the closure here
  (RECOMMENDED) | (B) reimplement as if unstarted — rejected for the same reason as all four
  entries above: the target state already exists identically on this branch.
- Chosen (RECOMMENDED, auto): Option A, following the four entries directly above (PR #1007,
  #1012, #1013, #1015) and the same-day precedent chain before those.
- Re-verified in THIS worktree (`run-W1-T254-1785511012213`, HEAD `430a2c1`, which already
  contains all four prior no-op closures): `git merge-base --is-ancestor 15a2168 HEAD` → true;
  `npx vitest run test/sweep.test.ts` → 130 tests, 0 failures, including "runSweep: post-review
  dedup is outcome-keyed … (W1-T254)" and "runSweep: a throwing action does not abort the pass …
  (W1-T254)"; `npx vitest run test/daemon.test.ts` → 86 tests, 0 failures, including "W1-T254: the
  light sweep runs while runOne is in flight … (the #707 fix)"; `grep -n
  "sweep.post_review.attempt" src/run-task.ts` → `src/run-task.ts:8233`, unchanged. All four
  acceptance criteria still hold against the identical, unchanged code.
- THE MECHANISM (unchanged, now five same-day instances): `status:` in `plan/tasks.yaml` is
  decorative; the real gate `isDispatchEligible` (`src/lib/drain.ts:123-125`) already calls
  `isMerged(t.id)` and short-circuits when true, and `deriveStatus`'s trailer rung
  (`src/lib/status.ts:1016`) already credits PR #720's `Remudero-Task: W1-T254` trailer. Both
  should make this task ineligible for dispatch — so whatever re-issued this task a fifth time is
  not going through this repo's own `nextRunnable`/`isDispatchEligible` path, or is going through
  it with a stale/uncached merged-set. Filed as a `task:` follow-up in this PR's description (not
  re-litigated further here, per the fourth entry's own note) rather than investigated in this PR,
  since diagnosing the outer dispatcher is a different concern from W1-T254's sweep-reliability
  scope.
- Per `src/lib/plan.ts:41-45`, `satisfied_by` is ARCHITECT-ONLY and a worker-added one fails
  review, and per the file header above `status:` is never written back — so, exactly as in every
  prior closure in this file, neither W1-T254's `status` field nor its acceptance criteria are
  touched by this PR.
- Rollback: revert this PR — removes only this DECISIONS.md entry; no runtime code touched, and no
  ledger line written.

## 2026-08-04 — RULING: daemon parallelism stays at N=1 (no parallel dispatch lanes)

No entry in this file, MASTER-PLAN.md, or plan/tasks.yaml has ever ruled on **daemon parallelism**
— i.e. the in-process lane width of `rmd daemon`'s own dispatch loop (`runDaemon`,
`src/lib/daemon.ts`). P19 (RATIFIED 2026-07-20 -> W1-T170/T171/T172, all shipped 2026-07-30) is
frequently misread as having answered this, because it did ship "N parallel dispatch lanes bounded
by the queue governor's WIP limit (N=2)" — but that lane machinery
(`partitionByFileOverlap`/`runDrainLanes`, `src/lib/drain.ts`) lives entirely under `rmd drain`.
None of W1-T170/T171/T172's declared files ever touched `daemon.ts`, and P19 is now CLOSED with its
design prose deleted. `runDaemon` today is still one `for (;;)` loop that calls `nextRunnable` once
per tick and `await`s a single `runOne` to completion before looping again — N=1, unchanged. So the
daemon half of this question was never decided, only never built, and every re-derivation of it
starts from a MASTER-PLAN sentence that has never been true of `daemon.ts`.

**Ruling: daemon-side dispatch stays at N=1.** `rmd daemon` does not adopt drain's multi-lane
machinery. Three falsifiable blockers, each checkable against source rather than taken on trust:

1. **The keychain.** `workerKeychainPaths` (`src/lib/worker-home.ts`) derives its keychain-db,
   password, account and expiry paths from the state dir plus an optional account label — never
   from a run id. Concurrent daemon lanes on one account would share one keychain, and the failure
   would present as flaky auth, not as an obvious concurrency bug. W1-T170's own note already
   flagged this as unvalidated, and it still is.
2. **The plan-reload invariant.** `runDaemon`'s periodic re-read of `plan/tasks.yaml` is safe today
   for a reason the code states in its own comment: `runOne` is awaited to completion before the
   loop returns, so a reload can never land under an in-flight task. With N>1 lanes that invariant
   is simply false, and it would break SILENTLY — nothing fails loudly when it does.
3. **The deploy idle gate.** `daemonIsIdle` (`src/lib/deployer.ts`) is a conjunction over global
   worker/inflight/worktree counters, so it waits for the WHOLE fleet to go quiet. More lanes make
   a common idle window rarer, and the failure mode — unbounded deploy latency whose only symptom
   is nothing happening — is strictly worse to diagnose than merely slow throughput.

General argument alongside the three blockers: a refused run costs the same at N=1 and N=2, so
parallelism multiplies waste as readily as work, and `partitionByFileOverlap` is fail-closed on
undeclared scope — a task with an empty or absent `files:` list takes a lane alone regardless of
lane count, so many nominally-2-lane passes collapse back to one in practice anyway.

**What reopens this ruling:** either of two measurements neither recon that raised this question
could take, because both need a production ledger no single container run has. (a) The distribution
of idle gaps between dispatches, which decides whether a second daemon lane would starve the deploy
idle gate. (b) Daemon throughput itself — dispatches per day, mean run duration, idle fraction, and
the fraction of dispatches producing no merged PR — which decides whether lane width is even the
binding constraint. Either measurement landing against this ruling reopens this ruling; absent
that, re-deriving the answer from scratch again is wasted work this entry is meant to stop.

Not in scope here: building daemon-side lanes, moving N, or the W1-T325 `dispatchLanes` policy row
(a prerequisite for ever ACTING on a different answer, not for this ruling to stand).

- Rollback: revert this PR — removes only this DECISIONS.md entry; no runtime code touched, and no
  ledger line written.

## 2026-08-04 — AMENDMENT: the ruling above is OVERRIDDEN; build daemon parallelism

**The operator has overridden the N=1 ruling.** The entry above is not deleted, because its three
blockers are the engineering work; it is superseded as a *decision* and retained as an *obstacle
list*. This amendment records why, on the entry's own terms.

**Its reopening condition has been met.** The ruling named exactly two measurements that would
reopen it and said neither recon could take them for want of a production ledger. Both are now in
hand, measured on the ledger 2026-08-04:

- **Idle-gap distribution.** 20 consecutive dispatch gaps of **45–90 minutes** against runs of
  ~25 minutes — the daemon is idle roughly **60%** of the time. The question of whether a second
  lane would starve the deploy has an answer, and it is that the capacity is there.
- **Throughput.** **226 `run.start` against 39 merged verdicts.** Ample idle capacity, and a merge
  rate near 17%.

The second number cuts both ways and is recorded here so it cannot be discovered later: roughly
five of every six dispatches do not merge, so a second lane buys about twice the throughput **and**
about twice the refused runs, twice the `no_pr`, and twice the spend on work that does not land.
The cost governor fired for the first time ever at $152.28 on the day this was measured. Lane width
is therefore a spend decision as much as a throughput one, which is why the capability ships dark
(W1-T343, default 1) and the flip is its own evidenced task (W1-T344).

**Blocker (1), the keychain, is narrower than stated — and was observed not to bite.** Two runs
overlapped on 2026-08-04 (`W1-T314-1785856070318` and `W1-T320-1785855748631`, ~15:11–15:5x) on the
same account label and the same keychain paths, both completing with no auth failure. Re-derived
from source, that is explained rather than lucky: `ensureWorkerKeychain`'s steady-state path is
read-only (its own comment: "no credential read, no extra unlock"), the password write is already
race-safe via `flag: "wx"` with the loser converging on the winner's password (the CodeQL
js/file-system-race fix, whose comment names "daemon boot racing a spawn"), and every call ends in
an *idempotent* `unlock-keychain` plus settings re-pin. The pair proves concurrent **steady-state**
runs are safe; it proves nothing about provisioning, because neither run provisioned. The real
hazard is one lane re-provisioning — which deletes and recreates the store — while another holds it
mid-run. That is a lock around one branch (**W1-T339**), not per-run keychains: provisioning copies
from the *login* keychain, so per-run derivation would break the cold-boot property the design
exists to protect.

**Blocker (2), the plan-reload invariant, loses one leg of two.** The safety argument was (a) one
observation point per tick and (b) `runOne` awaited to completion. Only (b) fails at N>1. Because
`plan = fresh` is a *reassignment* and not a mutation, a lane holding its own reference is
unaffected; the hazard is a lane re-reading the mutable binding after a reload and being judged
against a blob it was not selected under. The fix is a snapshot per dispatch batch — leg (a)
generalised (**W1-T340**), not a read barrier and not moving the reload.

**Blocker (3), the deploy idle gate, is confirmed and needs a bound rather than a condition.**
`daemonIsIdle` is still a conjunction over global counters and there is still **no ceiling** on how
long a deploy may be deferred. A merged fix that cannot deploy is worse than slow throughput, so
**W1-T341** adds a maximum deferral after which the deploy proceeds anyway, plus visibility *during*
the wait — the failure's defining property is silence.

**A FOURTH obstacle the ruling did not name.** Both governors are evaluated **once per tick**,
before dispatch: `checkCostGovernor` and `checkQueueGovernor` each guard their own deferral in the
tick body. At N=1 per-tick and per-dispatch coincide; at N=2 one reading admits two dispatches, and
a lane's spend is not observed until it lands. Both predicates gained daemon callers only recently
(W1-T317, W1-T321). **W1-T342** moves admission to the dispatch.

**One honest limit on "the operator can flip it".** `sweep.dispatchLanes` is a bounded policy row
(W1-T325), but `DEFAULT_SWEEP_POLICY` is a module-level const built at *import*, so a running daemon
holds its boot value. Flipping lanes needs a policy edit plus a daemon **restart** — cheaper than a
source change, a PR, CI and a deploy, but not live. Making such reads live is W1-T331 and is
deliberately not a prerequisite here.

**The chain:** W1-T339, W1-T340, W1-T341 and W1-T342 are independent of each other and each is
correct at N=1; all four gate **W1-T343** (wire `runDaemon` to drain's existing `runDrainLanes`,
default 1), which gates **W1-T344** (raise the default). The daemon adopts drain's lane machinery —
`runDrainLanes`, `partitionByFileOverlap`, already live under `rmd drain` and fail-closed on
undeclared scope — rather than growing a second implementation. Two lanes cannot take one task:
`acquireInflightLock` is per-task `openSync(..., "wx")`, create-or-fail with no TOCTOU gap, and
W1-T343 must prove that rather than assume it.

- Rollback: revert this PR — removes only this amendment, restoring the N=1 ruling above as the
  operative decision; no runtime code touched, and no ledger line written.

## 2026-08-11 — W1-T413 re-dispatch: already-satisfied, no-op close

- Options: (A) close as already-satisfied, no functional code change, record the closure in
  DECISIONS.md and supply the missing `Remudero-Task: W1-T413` trailer this PR itself carries
  (RECOMMENDED) | (B) re-touch `src/lib/status.ts` / `test/trailer-credit-plan-only.test.ts` with a
  cosmetic edit purely to manufacture a non-empty diff against the files this task's shard
  declares — rejected: the code and its test are already byte-identical to what the shard's design
  specifies, so any edit there would be either a revert-in-disguise or unrelated scope creep, the
  same objection the W1-T1/#255 precedent recorded for an equivalent forced edit.
- Chosen (RECOMMENDED, auto): Option A — no functional code change; this entry is the audit trail.
- Rationale: All three of this shard's acceptance claims are satisfied on `origin/main` at this
  worktree's `HEAD` (`c530960`). `PR #1527` — "fix(status): refuse a plan-scope-only PR's trailer
  credit so a filing cannot mark a task built", merged 2026-08-10 — added exactly the design's
  predicate: `isPlanOnlyChangeset` (`src/lib/status.ts`) calls `isInPlanScope`
  (`src/lib/plan-architect.ts`) rather than re-deriving plan scope, `deriveStatus`'s rung (c) gates
  a would-be trailer credit on `planOnlyRefusal` (skipped for free via `ownsOwnRunBranch` before any
  file-list read), a merged PR refused this way is surfaced as
  `rejected_candidates: [{ reason: "plan-only-changeset" }]` rather than dropped, and both
  `ghGateway` and `buildBatchedGithub` grew an optional `changedFiles(prUrl)` read that degrades to
  "credit as today" (clause (vi)'s fail-open direction) when the gateway cannot report it or omits
  it entirely. `PR #1567` — "fix(review): the plan-only arm reads what the shorthand modifies, not
  its sentence", merged 2026-08-11 — is a narrower follow-on to `src/lib/review.ts`'s unrelated
  body-vs-diff contradiction check and does not change `status.ts`'s logic. `npx tsx --test
  test/trailer-credit-plan-only.test.ts` (run outside this sandbox — `tsx --test`'s own IPC pipe
  hits `EPERM` inside it, a sandbox restriction unrelated to the suite) passes 17/17, covering all
  three claims by name: "a merged plan-only PR no longer credits its trailered task, and names
  plan-only-changeset as the reason" (claim 1), "a merged PR touching a path outside plan scope
  still credits, so the fix cannot strand real work" (claim 2), and "a gateway that cannot report
  changed files still credits, so a read failure never un-merges finished work" (claim 3). `git
  status --porcelain` was empty and this worktree's `HEAD` matched `origin/main` before this commit
  — there is no diff to make against `src/lib/status.ts` or its test.
  What is NOT already true, and is the actual reason this worktree was dispatched: neither #1527's
  nor #1567's PR body carries the literal `Remudero-Task: W1-T413` line — #1527's `gh pr view
  --json body` text mentions "W1-T413" only in prose (never as its own `Remudero-Task: W1-T413`
  line; that exact line lives only in the squash-merge COMMIT message, which
  `deriveStatus`/`findMergedByTrailer`'s `gh pr list --search '"Remudero-Task: W1-T413" in:body'`
  never reads), and #1567's body says so explicitly ("No `Remudero-Task:` trailer, deliberately").
  Confirmed live: `gh pr list --repo craigoley/remudero --state merged --search '"Remudero-Task:
  W1-T413" in:body'` returns `[]`. So the fix this task describes is fully built and tested, but no
  merged PR has ever anchored the credit — the task reads `source: "none"`, never `"trailer"`, and
  stays dispatchable forever without one. This PR supplies that missing anchor: pushed from this
  worktree's own `run-W1-T413-1786505609224` branch, `ownsOwnRunBranch` credits it on sight (the
  same free pre-filter #1527 added), regardless of `DECISIONS.md` not being in `isInPlanScope`'s
  scope either way. Precedent: W1-T7/#772, W1-T12a/#725, W1-T99/#731, W1-T262/#946, W1-T201/#993,
  and W1-T254's five closures (#1007, #1012, #1013, #1015, #1016). Neither the shard's `status:`
  field nor its `acceptance:` block is touched — `status:` is decorative/never machine-rewritten
  (`plan/tasks.yaml`'s own header) and `satisfied_by` is Architect-only (Standing rule 15).
- Rollback: revert this PR — removes only this DECISIONS.md entry; no runtime code touched.

## 2026-08-11 — PROPOSAL (AWAITING RATIFICATION): keep the harness Apache-2.0; put the licence boundary at the relay

**Operator direction record (not an auto-choose resolution, and NOT a ratification).** The operator
directed this licence analysis in two briefs and supplied the constraint it solves; he has **not**
ratified the recommendation below, and the W1-T352 provenance floor is satisfied by that direction
record rather than by a `Chosen (RECOMMENDED, auto)` stamp — this entry is **not** a machine
auto-choose and must not be read as one.

*Session-authored PROPOSAL, not a ruling and not a machine auto-choose. Licence choice is an operator
act; a session may recommend and may not record. **This PR no longer moves the licence.** It changes
exactly one file — this one — so merging it records the reasoning and leaves `LICENSE`, `README.md`
and `package.json` untouched. The FSL commit it previously carried is still in the branch history if
the operator decides the other way.*

**THIS IS NOT LEGAL ADVICE.** It is a source-derived options memo written by an agent. Everything
below turns on copyright ownership, prior publication and EU regulatory scope, and warrants a
lawyer's review **before** any licence position is presented publicly as settled.

### This proposal REVERSES the recommendation this PR opened with

The first draft recommended relicensing to FSL-1.1-ALv2. It rested on the operator's brief assuming
the repository was **private** — inferred from `GH_TOKEN` being needed for a fetch. It is **public**,
and has been Apache-2.0 since 37 minutes after the initial commit. The first draft already carried
that correction, but drew the wrong conclusion from it: it treated the forward-only moat as still
worth buying. Re-argued against the measured facts below, it is not. The correction **weakens** the
case for FSL rather than merely qualifying it.

### The constraint being solved

Operator's words: build in public, but nobody takes the source and runs a competing business.

### Q1 — how much is already out, and therefore unreachable (measured at `4c48872a`)

A forward relicense governs future releases only. Apache-2.0 is irrevocable, so **everything
published to date stays Apache-2.0 forever for anyone who has it**, and anyone may fork today's tree
and continue under Apache-2.0 indefinitely. No retraction is possible. What that leaves exposed:

| fact | value | query |
|---|---|---|
| visibility / age | **public**, created 2026-07-14 — **28 days** | `gh api repos/craigoley/remudero` |
| commits on `main` | **1,152** | `git rev-list --count origin/main` |
| `LICENSE` | Apache-2.0 since `7985d6a`, 37 min after `3e118dd3` | `git log --diff-filter=A -- LICENSE` |
| forks / stars / watchers / network | **0 / 0 / 0 / 0** | `gh api repos/craigoley/remudero` |
| unique **viewers**, 14d | **7** (1,004 views) | `gh api …/traffic/views` |
| referrers | `github.com` only, **4 uniques** | `gh api …/traffic/popular/referrers` |
| npm | **never published** — 404 | `npm view remudero` |

**The clone figure looks alarming and is not.** `traffic/clones` reports **33,633 clones / 1,262
uniques**, but the same window shows only **7 unique viewers**, and the repository has logged
**17,005 workflow runs**. A GitHub Actions checkout is a clone and each runner presents a fresh
address, so the clone count is dominated by the project's **own CI and fleet automation**. The
7-unique-viewer figure is the human discriminator, and it is the one to believe.

**So: the snapshot is legally unrecoverable, and observably nobody has taken it.** Those are two
different statements and both matter. The urgency argument in the first draft — a window narrowing
with every week of visibility — is not supported: there is no observed adopter to lose and no
observed forker to pre-empt.

### Q2 — is the forward relicense still available? (yes, and this is the strongest fact for it)

| author | commits | note |
|---|---|---|
| `Craig Oley` / `cao825` — one email, `craigoley@gmail.com` | **1,138** | the operator |
| `dependabot[bot]` | 7 | version bumps only |
| `claude[bot]` | 5 | GitHub App, operator-instructed |
| `Claude <noreply@anthropic.com>` | 1 | agent commit in the operator's own checkout |

Queries: `git log origin/main --format='%an <%ae>' | sort | uniq -c`, and
`gh api 'search/issues?q=repo:craigoley/remudero+type:pr+-author:cao825'`.

Of **1,211 pull requests, 14 are not the operator's** — and **every one has `user.type == "Bot"`**
(9 `dependabot[bot]`, 5 `claude[bot]`), verified by listing them rather than by inference. **There
are no outside human contributors.** Ownership is not the blocker; the option is genuinely open.

The one thing to flag rather than assume: `dependabot[bot]` is a **third-party-operated** bot, not
the operator's agent. Its 7 commits touch only `package.json`, `package-lock.json` and version pins
in `.github/workflows/*.yml` — mechanical version bumps carrying no original expression. That is a
lawyer's call to confirm, not a session's, but it is the whole of the third-party surface.

### Q3 — the three options, argued against each other

**(A) Relicense the harness to FSL-1.1-ALv2.** *(the first draft's recommendation)*

*For:* the trajectory is real and was measured. The tree is **261,079 lines across 725 files** in
`src|test|scripts`. In the last **14 days**: 598 commits, **480 of 725 files touched**, **+126,856
lines — about 49% of today's tree**. In the last **7**: 259 commits, 266 files, +52,996. A fork taken
today is materially behind within weeks, so FSL-from-here would protect a great deal even though it
protects none of the snapshot.

*Against, and this is why it is not recommended:*

1. **The velocity argument cannot carry the horizon it is argued over.** The repository is **28 days
   old**, so *every* commit falls inside any 30-day window and the churn ratio is measuring a
   project's first month, not its steady state. Early velocity decays. Projecting six months from a
   28-day sample is precisely the forward-quoted number this repo's own discipline refuses.
2. **It contradicts a standing plan commitment, which the first draft did not cite.**
   MASTER-PLAN §6A states that contributions to the core "stay under Apache-2.0 and are **never
   relicensed**", calls this a "**one-way door, accepted knowingly**", records that "the BSL/SSPL
   escape hatch Elastic/Redis/MongoDB used is **CLOSED to us** — that is the point", notes each of
   those relicensings "cost enormous trust", and directs that "we publish the never-relicense
   commitment as a **CONTRACT** (README + GOVERNANCE.md), not an internal note." **FSL-on-the-harness
   is that exact manoeuvre.** §6A also fixes the commercial boundary: the full loop — daemon, CLI,
   containment, principles engine, retros, campaigns, control panel, MCP — is "**free forever**", and
   Pro "may only ever be *hosted convenience* (relay/sync, portfolio views, team seats, org-brain
   sync)". **D-8** independently forbids premature paywalling. Option A reverses both.
3. The costs stand as previously recorded: not OSI-approved, so the project may not call itself Open
   Source; no CLA or DCO exists today, so a future relicense (**including the FSL's own promised
   Apache-2.0 conversion**) would need every later outside contributor's agreement; EU instruments
   (AI Act, Cyber Resilience Act) attach exemptions to FOSS status the FSL lacks — **flagged, not
   analysed**; GitHub drops the recognised-licence badge; and `package.json` loses its SPDX
   identifier for `SEE LICENSE IN LICENSE`.

**(B) Keep Apache-2.0 and do nothing else.**

*For:* simplest; keeps OSI status, the licence badge, the SPDX field and the EU FOSS hooks; avoids
the CLA problem entirely; costs nothing.

*Against:* it leaves the stated constraint unanswered. If the business is **hosting**, Apache-2.0
permits a competitor to host the same harness — the Elastic/AWS problem — and doing nothing is a
decision to accept that risk without naming where the defence lives.

**(C) Keep the harness Apache-2.0; put the licence boundary at the relay and hosted code. —
RECOMMENDED.**

The commercial surface in the plan is already the relay, not the harness: §6A's Pro is "hosted
convenience (relay/sync, portfolio views, team seats, org-brain sync)", and **D-11** puts accounts
"at the relay only", with the instance dialling **out**. **That code does not exist yet.** No relay
source is in the tree; `W1-T430` (identity-provider seam) and `W1-T431` (outbound relay client v0)
are both `status: queued`. Verified: `git ls-tree -r --name-only origin/main | grep -i relay` returns
two plan shards and one unrelated test.

So the boundary can be drawn where it actually defends revenue, on code that is **born** under
whatever licence is chosen, with **no irrevocability problem, no relicensing event, no trust cost, no
CLA retrofit, no OSI loss and no EU FOSS forfeiture**. It answers option B's objection — a competitor
may host the harness but not the relay, accounts, sync or portfolio layer — while keeping §6A's
never-relicense contract intact. **It costs nothing today and forecloses nothing**: if the operator
later judges the harness itself must be protected, option A remains available for as long as
ownership stays consolidated, which Q2 shows it does.

Option C is not a compromise between A and B. It is the position MASTER-PLAN §6A already describes,
which the first draft failed to check before proposing to reverse it.

### What this proposal does NOT decide

- **The relay's own licence.** Option C says *where* the boundary goes, not what sits on the far side
  of it. FSL, a proprietary licence, or source-available-with-conversion are all still open, and the
  choice can wait until `W1-T431` is dispatched.
- **CLA or DCO, and when.** §6A recommends DCO and records the one-way-door consequence. Still an
  operator act; unchanged by this entry, and cheap only until a first outside patch lands.
- **The licensor name** — `LICENSE` reads `Copyright 2026 Craig Oley`; if a company is to hold it,
  better settled before any publication push.
- **Whether to publish the never-relicense contract now.** §6A says README + GOVERNANCE.md; neither
  exists in that form today, and shipping it is a separate change.

### Naming note, carried forward

`FSL-1.1-Apache-2.0` is the licence's **former** spelling; upstream (`getsentry/fsl.software`) serves
that path as a redirect to **`FSL-1.1-ALv2`**, which is the current name and what the reverted commit
used. Recorded so the next reader does not re-derive it.

- Rollback: revert this PR — removes only this entry. No licence file, no runtime code and no gate is
  touched by it, and no ledger line is written.

## 2026-08-12 — RELAY AUTH MODEL (Tier 2): the relay asserts the human, the instance decides — AWAITING RATIFICATION

Operator direction record (not an auto-choose resolution): the goal is to reach the console at
remudero.com seamlessly, starting from "go to an IP" if that is what today allows. D-11 already
settles the TRANSPORT — each cell dials out with an enrollment token, no inbound ports, the relay a
transparent proxy over the §7A console contract. It does not settle AUTH. **The auth model below is
RECOMMENDED, not ruled; three named questions at the end are open and are the operator's alone.**

### The two identity paths that exist today, read from source at `a143003`

`grantedScopes` (`src/lib/service.ts`) dispatches over an ordered `IdentityProvider[]`; the first
provider to recognise a request wins, and `undefined` means "not my credential, try the next" rather
than a denial.

- **`bearer-token`** — constant-time compare (`safeEqual`) against `state/service-tokens.json`'s two
  values; `tokens.write` grants `read`+`write`, `tokens.read` grants `read`. The `?token=` query
  fallback is honoured only where `Route.allowQueryToken` is set, which is the HTML shell alone.
- **`tailscale-identity`** — and this is the answer that decides the rest. It is NOT a source IP and
  NOT a `Tailscale-User-Login` header. `identityGrantedScopes` applies two gates: (1) INTERFACE —
  `req.socket.localAddress !== identity.trustedLocalAddress` returns `undefined`, so a header
  arriving on any other bound address is never consulted; (2) ALLOWLIST — the
  **`tailscale-app-capabilities`** request header, JSON-parsed, must carry `identity.capability` as
  an own property. On success it returns `READ_WRITE` — **the full grant, unconditionally, with no
  tier**.

**So the tailnet path is already a claim trusted BECAUSE OF THE CHANNEL IT ARRIVED ON**: a header
that anything able to reach the trusted local address could set, believed because only Tailscale
Serve is supposed to reach it. A relay-asserted identity is structurally the same object. That is
not an argument against it — it is the observation that the repo has already accepted this shape
once, deliberately, with the interface gate as its containment.

### The transport, and what it forecloses

`rmd up` prints `console: http://<host>:<port>/?token=<read token>` (`src/run-task.ts`). Plaintext,
with a credential in the URL. Standing rule 24 says a secret "never travels in a URL, because URLs
are copied, screenshotted, bookmarked, proxied and restored by session-restore"; R-5 is the recorded
fixture, and its fix downgraded the embedded value from the WRITE token to the READ token rather
than removing the shape. That is tolerable on loopback and a tailnet. **It forecloses direct
internet exposure entirely** — no TLS, and a credential that survives in history, referrer headers
and screenshots. Whatever reaches remudero.com cannot be this URL.

### The model: (b), the relay asserts the human; the instance decides what that identity may do

**(a) THE RELAY HOLDS THE INSTANCE TOKEN AND INJECTS IT** is simpler and is rejected here. It
concentrates every cell's `write` credential in one hosted service, so a relay compromise is a fleet
compromise, and it makes the relay's own logs a place fleet-control credentials exist. It also
contradicts §6A's promise that core stays self-hosted in the way that matters most: the instance
would no longer be the thing that decides.

**(b) IS RECOMMENDED.** The relay asserts WHO the human is; the instance decides what that identity
may do, trusting the assertion because the connection was established OUTBOUND with the enrollment
secret. The instance keeps the authorization decision, which is exactly where §6A wants it.

**AND THE FINDING IS THAT (b) NEEDS NO NEW AUTH MODEL — ONLY THE SEAM, WHICH LANDED TODAY.**
W1-T430's `IdentityProvider` merged this morning as #1636 (trailer-credited, branch
`run-W1-T430-1786542951973`). Its own doc already names the adopter: the two built-ins are wired
first "and appends any `ServiceOptions.providers` after them, so a future grantor (e.g. **W1-T431's
relay-brokered browser session**) attaches without this dispatch changing." A relay-asserted
identity is a THIRD `IdentityProvider` — one `grant(req, allowQueryToken)` returning a scope set —
and `grantedScopes`'s loop is, in its own words, "the ENTIRE gate". Nothing in the auth dispatch
needs to be designed; it needs to be implemented.

### W1-T404 is a SECURITY PREREQUISITE, not an ordering one

`Scope` is `read | write`, and both existing grantors hand back the full `write` set. Over the
internet that means a browser session that can add an operator note can also move the daily budget
ceiling, execute a skill against the operator's checkout and halt the fleet. On a tailnet that is a
tolerated blast radius; through a public relay it is not.

W1-T404's shard now carries the 2026-08-11 rulings — THREE TIERS (option (c)) and a declared list
plus a `ci-parity:drift`-shaped completeness check — and its `design:` records what remains: "(iv)
STILL OPEN — THE SECOND FACTOR IS THE ONE REMAINING OPERATOR RULING". The shard states its own flip
condition: "WHAT WOULD MAKE IT DISPATCHABLE — exactly one ruling, on design (iv) … When that lands,
flip `verify:` to auto; no other field needs to change." The three options it lists, with its own
ergonomics constraint applied, are (a) a separately-issued high-tier token, (b) time-boxed
elevation, (c) a server-issued action-bound confirm nonce. **One ruling, and W1-T404 dispatches.**

### The staged path, each step with its prerequisite

| step | prerequisite | state |
|---|---|---|
| W1-T430 — the identity seam | none | **MERGED today (#1636)** |
| W1-T404 — write tiers | one ruling: the second factor | queued, `verify: human`, otherwise buildable |
| W1-T431 — dial-out relay client | W1-T430 | **now unblocked**, `verify: auto`, clean at `lint-plan`; testable against a loopback stub with NO hosting |
| single-tenant relay, no accounts | W1-T431 | not filed |
| accounts + a relay-asserted `IdentityProvider` | the above + W1-T404 | not filed |
| portfolio across cells | accounts | explicitly out of W1-T431's scope |

**INTERIM, for tomorrow.** An SSH tunnel (`ssh -L 4317:127.0.0.1:4317`) needs nothing built and
forecloses nothing; it is the honest answer for one operator on one machine. Tailscale on the Azure
VM is the better interim, and Q1's answer prices it: because the check is an *interface* gate on
`req.socket.localAddress` plus a header Serve injects, the container must be able to bind the
address Tailscale Serve targets — so it needs host networking or a userspace `tailscaled` inside the
container, not merely an installed client on the host. Neither interim requires the relay to exist.

**THE SHORTCUT, PRICED RATHER THAN ASSUMED.** A tunnel product (Cloudflare Tunnel or similar) gives
a real domain, TLS and human auth TODAY and forecloses nothing later. Its cost is a third party in
the trust path, terminating TLS and seeing every console response. §6A's no-telemetry posture
deserves an explicit ruling on that rather than arriving as a default because it was convenient.
**This entry does not take that decision.**

### Three things this record NAMES as open rather than resolving

1. **A TRANSPARENT PROXY TERMINATING TLS READS EVERY CONSOLE RESPONSE.** §6A promises core stays
   self-hosted. A relay that terminates TLS sees plan state, verdicts, costs and operator notes in
   clear. "Transparent proxy" describes the protocol, not the confidentiality. Either the relay is
   trusted with that, or the console contract grows an end-to-end encrypted mode; the tension is
   real and is stated here rather than bent quietly.
2. **ENROLLMENT TOKEN LIFECYCLE.** W1-T431 covers issuance and says "rotation is re-enrollment".
   Revocation and decommissioning a cell are unaddressed: what invalidates a token when a machine is
   lost, and what a revoked cell's portfolio row shows.
3. **THE OFFLINE CASE.** A cell not dialed in must render OFFLINE, not as an error. Measured: the
   console models no such state today — every `offline` occurrence under `src/lib/` is about git or
   network failure in feedback landing, none about a cell's reachability. This is a new state for
   the §7A contract, and W1-T414's read/unreadable/absent discipline is the shape it should follow.

### Filed with this record: nothing

No task is filed. W1-T430 landed today, W1-T431 is already unblocked and points the right way, and
W1-T404 needs a ruling rather than a task. A new task beside them would make the plan worse. **The
ordering IS the finding**, and it is now: rule the second factor → W1-T404 → W1-T431 → relay.

- Rollback: revert this PR — removes only this entry. No task record, no runtime code, no gate and
  no generated artifact is touched by it, and no ledger line is written.

## 2026-08-14 — RULING: publish the console at console.remudero.com behind Cloudflare, accepting that Cloudflare reads it (OPERATOR-RULED)

*Operator-ruled closure, recorded at the operator's instruction. This entry decides the question the
2026-08-12 relay auth entry named and deliberately left open; it takes no other decision.*

### What this closes

The **2026-08-12 — RELAY AUTH MODEL (Tier 2)** entry ratified model (b) and then refused a second
ruling in as many words:

> **THE SHORTCUT, PRICED RATHER THAN ASSUMED.** A tunnel product (Cloudflare Tunnel or similar) gives
> a real domain, TLS and human auth TODAY and forecloses nothing later. Its cost is a third party in
> the trust path, terminating TLS and seeing every console response. §6A's no-telemetry posture
> deserves an explicit ruling on that rather than arriving as a default because it was convenient.
> **This entry does not take that decision.**

That entry also listed the same tension first among the three things it named as open: *"A
TRANSPARENT PROXY TERMINATING TLS READS EVERY CONSOLE RESPONSE … Either the relay is trusted with
that, or the console contract grows an end-to-end encrypted mode."* **This entry takes that decision,
and closes that open question #1.** The two are meant to be read as a pair; the 2026-08-12 entry is
correct as written and is not amended.

### The ruling

The console is published at **`console.remudero.com`**, behind Cloudflare Tunnel with Cloudflare
Access as the human auth layer.

**Cloudflare terminates TLS and can therefore see every console response in clear** — plan state,
task verdicts, costs, operator notes. That is the cost, stated plainly rather than discovered later.

**It is accepted deliberately, not by default.** The 2026-08-12 entry's objection was not that the
cost was unknown but that it risked being paid silently because the path was convenient. It is paid
here on the record.

### Why the cost is acceptable

**The same content already sits with GitHub.** The repository, the PR bodies and the shard text
already carry plan state, verdicts, costs and operator notes, hosted by a third party under exactly
this arrangement. Cloudflare sees a SUBSET of what GitHub already holds. What is bought with it is a
hosted identity layer — human auth, TLS and a real domain — that the fleet would otherwise have to
build and secure itself, and building an auth surface badly is the larger risk of the two.

**§6A's scope, stated as the reasoning rather than as a caveat.** §6A's no-telemetry posture governs
what the fleet **SENDS UNPROMPTED**. It does not govern what a transport the operator chose observes
while serving a request the operator made. Those are different properties, and conflating them would
forbid every hosted dependency the project already relies on, GitHub included. The posture is intact:
nothing new is emitted on its own initiative.

### The tailnet path is not retired, and an Access provider cannot weaken it

The unmediated tailnet path remains available as a fallback. Re-derived from `src/lib/service.ts`
rather than assumed:

- `ServiceOptions.identity` and `ServiceOptions.providers` are **separate fields**. `identity` carries
  the tailnet grantor; `providers` is the W1-T430 seam, documented as "consulted AFTER the two
  built-in grantors above (tailnet identity, then the bearer token)". Attaching a provider does not
  reach the `identity` field at all.
- `grantedScopes` loops the providers and returns on the first truthy grant, falling through
  otherwise — an `undefined` return means "not my credential, try the next", never a denial.

**So a Cloudflare Access `IdentityProvider` is purely ADDITIVE.** It adds a way in; it removes none,
and it cannot deny a request another grantor would have allowed. If the hosted path is ever
unacceptable, withdrawing it is subtraction, not redesign.

### What this entry does NOT decide

The DNS mechanism. `remudero.com` remains the marketing site and the console is a subdomain of it,
but HOW that subdomain is delegated — a nameserver move versus a partial/CNAME setup, and which
Cloudflare plan each requires — is not ruled here. A recon raised a plan-gating constraint on the
partial path that could not be verified today, and recording an unverified constraint as ruled is
exactly the failure this pair of entries exists to avoid. The subdomain is settled; the mechanism is
an implementation question for whoever sets it up.

Open questions 2 (enrollment token lifecycle) and 3 (the offline case) from the 2026-08-12 entry
remain open and are untouched by this ruling.

### Filed with this record: nothing

No task is filed. This is a ruling on a question already named in the record, not new work; W1-T404's
write tiers remain the security prerequisite for exposing the console to anything beyond the operator,
and that ordering is unchanged by where the console is published.

- Rollback: revert this PR — removes only this entry. No task record, no runtime code, no gate and
  no generated artifact is touched by it, and no ledger line is written.

## 2026-08-15 — RULING: the Spanish name is the brand, the Americanized vocabulary is the interface (OPERATOR-RULED)

*Operator-ruled direction record, recorded at the operator's instruction.* The repository, the binary
(`rmd`) and `remudero.com` do not change. What changes is the words the console shows a person.

### The line, and it is the whole safety of this ruling

**Console strings and documentation are free to change. Ledger step names, function names and file
paths are not.** Those are query keys: renaming one breaks every historical question anyone can ask
of the record, silently and permanently. A button reading differently breaks nothing.

Concretely, and this ruling binds future work to it: routes such as `/v1/drain/run` are an API
contract; `state/drain.lock` is read by the daemon, the entrypoint and every runbook; ledger steps
and function names are how the ledger is queried and the code is navigated. **A diff that renames one
of those in the name of vocabulary is a failed change, not a judgement call.**

### The measurement that justifies confining this to the surface

Re-derived from `src/lib/serve.ts` and `src/`, with an invented control term reading 0 in both:

| term | rendered in `serve.ts` | across `src/` |
|---|---|---|
| `cell` | 0 | 19 |
| `ratchet` | 0 | 116 |
| `shard` | 3 | 166 |
| `rung` | 4 | 693 |
| `drain` | 55 | 627 |

**The abstract words are substrate, not interface.** `cell` and `ratchet` are never rendered at all;
`rung` renders four times against 693 uses in source. Renaming them would be a large, risky diff that
no operator would ever see the benefit of. They are therefore explicitly OUT of scope for vocabulary
work, now and later.

### What is already correct, so nobody "fixes" it

`mount` is genuine ranch English used correctly — a cowboy's mount is the set of horses he rides, and
the fleet already says `mount sonnet/high`. `lane`, `gate`, `ledger` and `sweep` are already concrete
and stay. **These are not candidates for renaming.**

### The one surface word that is wrong, and the word that replaces it

`drain` renders 55 times in `src/lib/serve.ts` — the most-rendered vocabulary word on the console —
and it points backwards. To anyone who did not build this, *drain* means empty, or shut down. It in
fact **dispatches queued work: it starts things.**

**It becomes `gather`.** A gather is the attested ranch act of bringing scattered stock in so it can
be worked, used as both verb and noun ("the gather"). It is chosen over `roundup` because it is a
plain verb in active voice, where `roundup` is a noun pressed into service as one — and because the
same word carries the button, the confirmation and the empty state, so the action keeps one name
through the whole flow.

Applied to the rendered strings only: the UP NEXT button and its confirm step, the empty-state text,
and the write-access status sentence. Routes, the lock file, identifiers, CSS hooks, data attributes
and ledger steps are untouched and were asserted byte-identical.

### The standing rule for every future term

**Every proposed word must be attested ranch English with a source. An invented Western-sounding word
is worse than the abstract one it replaces.** The researched vocabulary available: *remuda* (the herd
of spare mounts a crew remounts from), *wrangler* (the Americanized *remudero*), *cavvy* (the Plains
corruption of *caballada*), *string* (the horses assigned to one rider), *mount*, *rep* (a
neighbouring outfit's representative who cuts out his own brand), and *cattle guard*.

### And the register, which already exists here but not in the product

The voice this asks for is already written in this repository every day — the plain-language
paragraph that closes every recon report. Plain, friendly, and explained without being dumbed down.
It has simply never reached the console. Future surface work should sound like that paragraph.

- Rollback: revert this PR — removes only this entry and the rendered strings it names. No task
  record, no route, no lock file, no ledger step and no generated artifact is touched by it.

## 2026-08-16 — RULING: the fleet gates on IRREVERSIBILITY, not on outwardness (W1-T919)

**THE PRINCIPLE.** What earns a gate is whether an act can be taken back, not whether it reaches
outside this machine. Outwardness is a proxy that mis-sorts in both directions: opening an issue is
outward and trivially reversible; deleting a branch is local and not.

**AND THE FENCE IS NOT MISSING A MERGE — THE FIRST DRAFT OF THIS ENTRY SAID IT WAS, AND THAT WAS
WRONG.** Measured at origin/main: `assertLiveWriteAllowed` guards four acts — `gh-issue-create`,
`gh-pr-create`, `gh-pr-merge`, `git-push` — and ALL THREE merge invocations in `realArmDeps`
(`src/run-task.ts`) are immediately preceded by `assertLiveWriteAllowed("gh-pr-merge", …)`: the
`--auto` arm, the clean-status direct merge, and `--disable-auto`. `ghPrMergeSquash`
(`src/lib/worker.ts`) gates the same way. The omission claim is recorded here only because a ruling
that rested on it would have been false in its most quotable sentence.

**THE REAL FINDING IS NARROWER AND SHARPER: ARMING DEFERS AN IRREVERSIBLE ACT PAST THE FENCE.**
`gh pr merge --auto` does not merge. It hands the merge to GitHub, which performs it LATER — when
the checks go green, with no local gate traversed AT THAT MOMENT. The fence is crossed once, at
arming time, by a process that then exits; the irreversible act happens afterwards, unattended, on
someone else's schedule. So the gate is real but its coverage is POINT-IN-TIME, and the act it
authorises is not.

**REVERSIBILITY, MEASURED WITH A CONTROL THAT DISCRIMINATES.** Closing a pull request is fully
reversible and merging is not, and the head branch is the evidence: **#1873 (closed, unmerged)
still has `fix/loadplan-enoent-shard-race` on origin; #1874 (merged) has no
`fix/loadplan-enoent-race` at all** — `--delete-branch` took it. One pair, opposite outcomes,
same query. An earlier attempt at this measurement used a single branch and could not tell branch
survival from branch survival-in-general; it is recorded as insufficient rather than quietly
replaced.

**THE FALSIFIER THIS RULING MUST SURVIVE, AND IT IS WHY NOTHING HERE AUTHORISES AUTOMATIC CLOSURE.**
**IDENTITY ALONE IS NEVER SUFFICIENT.** #1873 and #1874 carried byte-identical titles and identical
file lists and were created 74 seconds apart — and the one that merged was chosen by an ARGUED
difference, not a mechanical one. A detector keyed on identity would have closed the better pull
request. Any future disposition built on this ruling must therefore act on a REASON, never on a
match, and this entry must not be read as "duplicates may be closed automatically."

**WHAT THIS ENTRY DOES NOT DO.** It does not amend `assertLiveWriteAllowed`, add an act to its list,
or change any disposition. The ruling comes first; the disposition follows behind it, cites this
entry, and carries its own evidence.

## 2026-08-16 — RULING: sessions may READ with `az vm run-command`, never MUTATE, and must DISCLOSE — recorded as ADVICE, not as a control (OPERATOR-RULED)

*Operator-ruled direction record, recorded at the operator's instruction.* The wording — sessions may
READ, never MUTATE, and must DISCLOSE — is the operator's, as is the ruling that it be recorded as
advice rather than built as a control. The measurements below were gathered to support that decision,
not to make it; this entry is not a machine auto-choose resolution and is not stamped as one.

**THE RULING.** A session may use `az vm run-command` for READ-ONLY inspection of the fleet host, must
DISCLOSE every such use in its report, and must never use it to mutate. It is not authorised for any
act that changes state on the VM.

**AND THIS ENTRY IS ADVISORY, WHICH IS THE POINT OF WRITING IT DOWN RATHER THAN THE WEAKNESS OF IT.**
Nothing refuses this verb, measured at origin/main: `hooks/deny-floor.sh` carries **0** rules naming
`az` or `azure` against a positive control of **4** naming `gh`; **0** tracked files name
`vm run-command` against a control of **9** naming `az `; and this file carried **0** lines on it
across **1,426** before this entry. So the rule binds only because a session reads it. That is the
same unenforced-prose class CLAUDE.md's own header warns about, and recording it as if it were a
control would be worse than naming the exposure honestly. **THE GUARD DOES NOT EXIST; THE NORM IS ALL
THERE IS.**

**WHY IT IS WORTH KEEPING ANYWAY.** It is the only route to the host that survives an SSH outage or a
Docker API failure, needs no inbound port, and on 2026-08-15 it answered a question four pull requests
were blocked on: worker liveness read **2, not 0**, so the shortcut everyone had assumed would have
killed live work. A capability that earns its keep is not made safer by going unmentioned.

**THE EXPOSURE, MEASURED.** A session inherits the operator's own login. `~/.azure/azureProfile.json`
names `CraigOley@gmail.com`, `type: user`, whose role assignment is **Owner at SUBSCRIPTION scope** —
not VM scope, not resource-group scope. The MSAL cache is mode **600** owned by `craigoleyagent`, the
account every lane runs as, and it holds a **RefreshToken that silently re-mints**: its mtime moved
during the recon that produced this entry, from reads that never prompted for anything. The Activity
Log's own claims name `appid 04b07795-8ddb-461a-bbee-02f9e1bf7b46` — the Azure CLI's public client —
with `authnmethodsreferences: pwd,mfa`. **SO MFA PROTECTED THE SIGN-IN AND DOES NOT PROTECT EACH USE.**

**THE GOOD NEWS, RECORDED SO IT IS NOT RE-INVESTIGATED: THE EXPOSURE RUNS ONE WAY.** The VM carries
**no managed identity** — IMDS's token endpoint returns HTTP **400** `Identity not found` against a
positive control of HTTP **200** on the instance endpoint, and the control-plane `identity` block is
`null`. A compromised worker therefore cannot reach the control plane from inside the box. The risk is
the cached login on disk, not the machine's own credentials.

**WHAT THE LOG DOES NOT CARRY, WHICH IS HOW MUCH WEIGHT THE DISCLOSURE NORM ACTUALLY BEARS.** Twelve
invocations in thirty hours are recorded, and the **COMMAND TEXT IS ABSENT FROM EVERY ROW** — the union
of every `properties` key across all of them is `entity`, `eventCategory`, `hierarchy`, `message`,
`serviceRequestId`, `statusCode`, with `description` empty throughout. **A READ-ONLY USE AND A
DESTRUCTIVE ONE ARE THEREFORE INDISTINGUISHABLE AFTER THE FACT.** Worse for attribution, the `ipaddr`
claim carries the operator's home address rather than the VM's, so the record points at the wrong
origin. Read them through the ARM REST `eventtypes/management` endpoint: `az monitor activity-log list`
returned **2 events and 0 runCommand** over the same window where REST returned **49 and 36**.

**A FIGURE FROM THE COMMISSIONING BRIEF, CORRECTED.** The audit trail is NOT shorter than the fleet's
own record. The Activity Log's 90-day default **OUTLIVES** the ledger's retained union, which spans
**8 days** (2026-08-08 → 2026-08-16). Nothing exports the Activity Log, so 90 days is what there is —
but it is the longer of the two, not the shorter.

**HOW THIS SITS WITH W1-T919.** That ruling's axis — the fleet gates on IRREVERSIBILITY, not on
outwardness — makes this the **MOST GATE-WORTHY CAPABILITY ANY LANE CURRENTLY HOLDS**: arbitrary root,
unbounded blast radius, and no reversibility whatever for a destructive command. **BUT IT DOES NOT
DECIDE THIS CASE**, and this entry does not pretend otherwise: W1-T919 says in terms that it "does not
amend `assertLiveWriteAllowed`, add an act to its list, or change any disposition." The axis tells you
how to weigh this verb; it does not fence it. That is why this is a separate entry rather than a
corollary.

**THE OPEN QUESTION, NAMED AND NOT ANSWERED HERE.** Whether the daemon account should hold a
purpose-scoped principal instead of the operator's personal login. Nothing in this entry revokes or
narrows the operator's own access — he needs it. The question is only whether a *session* should
inherit it, and that is a decision about provisioning, not about this verb.

**Rollback:** delete this entry. It changes no behaviour, so nothing else moves.

## 2026-08-18 — RULING: remudero is BRING-YOUR-OWN-SUBSCRIPTION; customers are a direction, not a current target (OPERATOR-RULED)

*Operator-ruled direction record, recorded at the operator's instruction. It records intent and takes
no architectural decision of its own; the shape below is a direction, not a design.*

**THE NEAR-TERM GOAL IS THE BEST POSSIBLE HARNESS FOR ONE OPERATOR.** In the operator's words: *"If we
make an amazing harness that works this well for me, the sales should come easy."*

**THE OPERATIVE CONSTRAINT, AND THE MOST IMPORTANT LINE IN THIS ENTRY: DO NOT FORECLOSE THAT
DIRECTION; DO NOT BUILD FOR IT YET.**

**THE SHAPE, WHEN IT COMES.** Per-customer VMs on the operator's Azure — the VM is the isolation
boundary, not tenancy inside one process. The customer supplies their own Claude Code subscription
credential and their own GitHub PAT directly into their own VM, so the operator never holds either
credential in transit. Billing is on compute, not on inference. Claude Code first; other harnesses
later, and pay-as-you-go via API and OpenRouter is a later phase. The model router is the multiplier —
the daemon choosing model, effort and turn budget is what lets one subscription carry a fleet, and it
is the seam through which cheap open models later augment it.

**TWO QUESTIONS ARE OPEN, AND NEITHER BLOCKS ANYTHING TODAY.** (1) Whether Anthropic permits a third
party operating infrastructure that customers authenticate subscriptions into. Running Claude Code on
one's own remote server is permitted — it is Anthropic's own product, built for scripted use, and
`claude setup-token` issues a one-year OAuth token scoped to inference only for exactly that. The
third-party-host shape is a different question and needs an answer from Anthropic, not from a session.
(2) Whether subscription rate limits carry a fleet-shaped workload below Max 20x. The operator has
measured his own case and does not hit caps on Max 20x while running a fleet that notionally spent $184
in a day — that is one operator, one fleet, one 20x plan, and lower tiers are unmeasured. Both are
recorded so a later reader does not treat either as decided.

**WHAT THIS SUPERSEDES.** MASTER-PLAN §6's open-core stance lists *"Pro candidates (post-traction, not
before WS-6): hosted relay/sync for mobile push without self-managed tailnet, multi-project portfolio
views, team/multi-operator seats, hosted question inbox, hosted org-brain sync…"* That describes hosted
multi-operator convenience layered on one operator's infrastructure — a different shape from one
isolated VM per customer carrying the customer's own credential. **The list is superseded as the
commercial shape and is NOT deleted**: standing rule 21 governs amendment, so §6 is cited and marked
in place.

**IT SETTLES A QUESTION A RECON COULD NOT.** A 2026-08-18 recon found the three-stage arc already
recorded in four places and flagged one thing the documents could not resolve: *"whether the operator
considers §6A's Pro list the same thing as 'others use and pay'."* The answer is **no**. (That
quotation is verbatim; the list it names sits in §6, not §6A.)

**`billing_mode` IS PLANNED, NOT ORPHANED.** Derived in `src/lib/env.ts` as `engaged ? "api" :
"subscription"`, with 0 sites comparing or switching on it against a control of 36 occurrences in
`src/`, every value reading `subscription`. MASTER-PLAN §9 already assigns it two consumers — metering
when `billing_mode == api`, and the conditional cap guard where *"no dollar cap is VALID ONLY while
`billing_mode == subscription`."* Under this ruling it is the BYO-subscription-versus-pay-as-you-go
axis. **Do not retire it as a built-and-unread field.**

**THE WS-2 GATE IS UNCHANGED.** Second-repo expansion still waits until *"the console is feature-rich
and looks good"* — operator-judged, not a metric. This ruling changes the destination, not that gate.

**ONE CONSEQUENCE, NAMED AND NOT SCOPED IN.** The fleet authors every PR as `cao825, User` — the
operator's own account — so under bring-your-own-subscription a customer's fleet would author as the
customer, and their gate config would be editable by their own fleet exactly as his is today. W1-T990
(#2136) files that; this entry only names it.

**Rollback:** delete this entry and the §6 pointer. It changes no behaviour, so nothing else moves.

## 2026-08-18 — RULING: `src/run-task.ts` stays one file and the fleet accepts ONE EFFECTIVE DISPATCH LANE (W1-T471) (OPERATOR-RULED)

*Operator-ruled architecture record, recorded at the operator's instruction.* The ruling — one
effective lane is accepted, splitting is refused, re-scoping is refused — is the operator's. The
measurements below were gathered to support that decision, not to make it, and W1-T471's own shard
states in terms that it *"does not propose splitting the file"* and records its three options *"with
their evidence and NOT ranked."* This entry supplies the ranking the shard withheld.

**THE RULING.** `src/run-task.ts` is not split. Tasks are not re-scoped to avoid declaring it. The
fleet runs with one effective dispatch lane, and that is an accepted operating condition rather than
an outstanding defect.

**SPLITTING IS REFUSED, AND THE FILE'S OWN STRUCTURE IS THE REASON.** The eleven section banners do
not correspond to separable concerns. Assigning every top-level definition to its enclosing section
and counting identifier references that cross a boundary gives **640 cross-section references**, with
**128 of 368 symbols (35%) referenced from outside the section that defines them**. `main`, `repoRoot`
and `ledgerPathFor` are each reached from **seven of the ten other sections**; `USAGE` from six;
`waitForCiGreen` and `runReview` from five. Exactly one section has no traffic in either direction and
it owns zero definitions — a banner above a taxonomy, not a concern. A split along those lines would
have to break 640 references and re-home a foundation most of the file calls. That is a large
judgement, not a mechanical refactor, and it is declined.

**RE-SCOPING IS REFUSED, AND THE OVER-DECLARATION IS IN THE WRONG PLACE TO HELP.** Over ten trailered
merges, 16 of 55 declared paths (29%) went untouched — but **13 of those 16 are test files**. Declared
`src/` paths are touched **15 of 17 times (88%)**, and on the hot file itself `src/run-task.ts` is 4/5.
Trimming defensive `files:` therefore recovers parallelism only at the margins: it would not have
unblocked the deferred lanes, because their collisions are on source files those tasks genuinely edit.
Anyone proposing a `files:` audit as the remedy should be shown this paragraph first.

**THE MEASURED COST — A QUEUE, NOT A LEAK.** `dispatch.serialized` carries **30 distinct rows** over
**8 days** (2026-08-05 → 2026-08-12), every one `reason: file-overlap`, with **`src/run-task.ts` named
in 21 of 30 (70%)**. **Every one of the 30 deferrals resolved — zero starvation.** The wait a deferral
actually cost, joined to each task's next `run.start`: **median 44.4 minutes**, mean 53.6, range
2.2–154.4. Summed, **26.8 deferred lane-hours across the window — about 3.4 a day — of which 21.4
hours (80%) are attributable to this one file.** Nothing is lost; work is delayed and then runs. That
distinction is the ruling's whole basis, and a later reader should not restate the 3.4 hours as
throughput the fleet failed to deliver.

**THE FALSIFIER, WHICH RE-OPENS THIS RULING WITHOUT FURTHER ARGUMENT.** Either of two observations
converts the queue into a leak: **a deferral that never resolves** — a task deferred and never
subsequently started — **or a median wait that crosses the length of a lane's own run**. The first
means starvation has begun; the second means a lane spends longer waiting than working, at which point
the delay is throughput the fleet did not deliver. Either one re-opens the question and this entry
stops governing.

**WHAT THIS ENDS: THE RITUAL SENTENCE IS NO LONGER REQUIRED.** In the absence of a ruling, shards began
carrying the sentence *"THE W1-T471 SERIALISATION COST IS ACCEPTED IN WRITING"* as a condition of
declaring the file. It reads on **six shards on `origin/main`** — first appearing 2026-08-16, with four
of the six landing on 2026-08-18 — and on two more in PRs open as this is written, three of the eight
authored in a single session tonight. **That is a convention that grew because nobody had ruled, and
the ruling is now here: the phrase is NOT required, and a new shard declaring `src/run-task.ts` should
simply declare it.** The existing occurrences are left in place — standing rule 21 governs amendment,
and they are accurate statements of a cost this entry has now accepted on the fleet's behalf. What
ends is the obligation, not the text.

**PROVENANCE, STATED BECAUSE A COUNT IS ONLY A CLAIM ABOUT ITS CORPUS.** Every figure above is this
host's retained ledger union (all three file forms, deduplicated on the full line; positive control
`sweep.pass` = 1,897; negative control, a non-existent path, 0 rows). W1-T471's shard records that an
Azure census reported the same total of 30 over a **different population and different days**, which is
why the per-path split is stated as this host's and not as the fleet's. `src/run-task.ts` is declared
by **224 of 632 task records** at `6495ebe8`.

**WHAT THIS ENTRY DOES NOT DO.** It does not close W1-T471, whose shard remains `status: queued` at
`verify: human`; closing or retiring it is a separate act. It moves no mount, cap or threshold, changes
no dispatch code, and takes no position on `partitionByFileOverlap`'s behaviour, which is correct as
written — the collisions it reports are real.

**Rollback:** delete this entry. It changes no behaviour, so nothing else moves; the ritual sentence
would then be neither required nor forbidden, exactly as before.
## 2026-08-19 — RULING: five automation rulings — the fleet files, arms and merges without asking (OPERATOR-RULED)

*Operator-ruled record, recorded at the operator's instruction.* The five rulings below are the
operator's; the measurements were gathered to support them, not to make them. The through-line is
automation: each says what the fleet may now do without asking.

**1 — THE FLEET KEEPS FILING ITS OWN BACKLOG. NO CAP.** Filed-versus-implementation-merged per UTC
day reads 21/24, 30/30, 27/30, 28/30, 21/18, 31/15, 9/9. Filing tracks the build rate; the one gap is
2026-08-18, the night main was red for an hour. There is no runaway to govern, and `plan/policy.yaml`
bounds only `autoTriage`. THE WATCH METRIC IS SHARDS BUILT VERSUS SHARDS FILED, never shards filed
against nothing — today reads 8 merged and 0 built, which is noise at one day and a signal at a week.

**2 — RMD ARMS AND MERGES EVERY GREEN, REVIEWED PR, INCLUDING HAND-FILED ONES.** The operator's
words: *"rmd daemon should do this automatically, if everything is green. I don't want hand-filed PRs
to require this."* W1-T1027 files the mechanism; its design is not restated here. THIS WIDENS WHICH
PRs ARE CONSIDERED, NOT WHAT IS PERMITTED: an irreversible diff, a non-green PR, a draft, and a
CAPPED verdict without a ledgered override still never arm. That clause may not be softened by an
implementer. `sweep.armSessionPrs` already exists in `plan/policy.yaml` at `true` (W1-T516, #1890) —
no new flag. The console toggle is a later sibling, blocked on W1-T996's Access-JWT grant.

**3 — `/v1/inbox/approve` STAYS `tier: "high"`.** Its own reason holds: *"W1-T404: HIGH — moves code
(hands off to a detached rmd spawn: ratify/merge)"*. This file already ratifies gating on
irreversibility rather than outwardness, and Access proves who you are, not that a merge is
reversible. So after W1-T996 lands, reframe and mark-handled work from a browser and approve does
not. THAT IS THE INTENDED OUTCOME, NOT A GAP.

**4 — THE RISK JUDGE'S COVERAGE IS DEFERRED UNTIL W1-T1027 BUILDS, THEN REVISITED.** `runRiskJudge`
has one production call site, inside `runTask`, so the review, sweep, triage and operator lanes never
reach it; 259 of 475 PRs since 2026-08-08 carry a head shape that never enters `runTask`. THE
QUESTION CHANGED BECAUSE RULING 2 CHANGED IT: that majority was tolerable while it needed the
operator's hand, and under ruling 2 it becomes the half that self-merges. Deferred, not decided. The
trigger is W1-T1027 building — not a date.

**5 — `mergeConflictAdmissionEnabled` STAYS FALSE.** Re-affirmed unchanged.
`isPureConcurrentAddition` cannot return false on an add/add collision, because there is no
merge-base version and both deletion counts are structurally zero. There is also no supply to act on:
no open PR is currently dirty.

**THREE MEASUREMENT CORRECTIONS, RECORDED SO NOBODY RE-DERIVES THE ALARM.** (i) THE 63-ITEM
ESCALATION BACKLOG IS GONE — two open, both under two days, with closed rows showing a steady drain;
a console figure from 2026-08-18 is stale. (ii) `status:` IS 100% DECORATIVE, NOT MOSTLY — all 583
credited tasks read `status:` other than `done`. W1-T367 ruled it stale by design; this confirms it
absolutely, and any reader using that field for merge state is wrong by construction. (iii) NO SINGLE
CREDIT PATH SUFFICES — all four together credit 583 of 643, with marginal contributions of 12 ids
found only by the `run-<id>-<epoch>` head ref (including W1-T447), 2 only by the PR-body trailer, 1
only by the commit trailer, and 0 only by the subject suffix.

**AND ONE STRUCTURAL FINDING, NAMED AND NOT SCOPED IN.** A `type: manual` task can never be credited,
so it can never satisfy a credit-based `depends_on`. W1-T12d is the live instance: PR #69 records
*"W1-T12d commissioning (verify:human done); mark WS-1 COMPLETE"*, it reads `status: done`, and it is
uncredited by all four paths — because no worker built it, so no trailer, head ref or subject suffix
exists to find. It blocks W1-T165, which blocks W1-T188; W12-T1 blocks W1-T49 the same way. That is
three of roughly fifteen dispatchable tasks parked on a paperwork gap rather than on work. Recorded
as an observation and a candidate shard; whether manual completion should be assertable is its own
concern and is not decided here.

## 2026-08-19 — RULING: W1-T472 and W1-T446 take the efficient option WITH telemetry; the site splits, the console does not (OPERATOR-RULED)

*Operator-ruled record, recorded at the operator's instruction.* The three rulings are the operator's;
the measurements were taken to serve them, not to make them. `W1-T472` and `W1-T446` are re-banded to
`verify: auto` on the same authorisation.

**1 — W1-T472: TAKE WHICHEVER OPTION REMOVES THE MOST COST WHILE PRESERVING THE SIGNAL**, on two
conditions. (i) IT MUST BE REVERSIBLE, and reversibility is a COMPLETION CONDITION: an option that
cannot be undone without re-deriving evidence that no longer exists is outside this ruling. (ii)
TELEMETRY SHIPS IN THE SAME CHANGE, recording what the removed path would have done.
**THE MEASUREMENT REFUTES THE FREE-DROP PREMISE AND IS RECORDED SO NOBODY RE-DERIVES IT.** The
`--ci-parity` preflight HAS gone red: `preflight.failed` reads 27 rows, 27 distinct after deduping on
the full line, across 24 distinct tasks — against a same-invocation positive control of 39
`preflight.binary_pin` rows, and all three ledger forms read explicitly. The reds name real checks
(`commitlint`, `ci:test`, `coverage-ratchet:test-with-coverage`). So "drop it" and "gate it" do NOT
cost the same and neither is free. HONEST LIMIT: every row falls on 2026-08-12, which is essentially
the whole window in which this host dispatched after the preflight shipped; the rate is unmeasured,
the existence is not.
**AND CONDITION (i) BITES ON ONE OPTION, WHICH IS RECORDED AS A FINDING RATHER THAN A CHOICE:**
dropping the worker preflight also stops `preflightSummaryPath` being written, so the evidence a later
reversal would need is destroyed by the removal itself. A builder must establish reversibility for
whichever option they take, and say so.

**2 — W1-T446: RELAX THE GUARD, MEASURE, REVERSE ON EVIDENCE.** `checkCliFreshness` refuses only on
paths the incoming fast-forward would actually write. Each time the relaxed guard PERMITS something
the strict one would have refused, it emits a row carrying the path and the reason, so the relaxation
is reversible on evidence rather than on feel. The shard's own note says why this needed a ruling:
*"design (i) is a policy question about relaxing a safety guard and no linter can settle it."*

**THE CLAUSE THAT BINDS BOTH, AND MAY NOT BE SOFTENED.** THE TELEMETRY IS NOT OPTIONAL AND SHIPS IN
THE SAME CHANGE — a relaxation with no record of what it allowed cannot be reversed. NAME THE READER
IN THE CHANGE, or the row is the next built-and-unread mechanism; twelve have merged green with no
consumer and a thirteenth was found on 2026-08-18. THE OPERATOR READING THE LEDGER IS A LEGITIMATE
ANSWER — an unstated reader is not. And if either step must survive rotation to be read, it needs
`DECISION_RELEVANT_LEDGER_STEPS` membership (`src/lib/ledger.ts`) IN THE SAME CHANGE; that omission
has already cost this repo twice.
**THE TELEMETRY IS AN OPERATOR-AUTHORISED ADDITION TO EACH TASK'S SCOPE.** Rule 15 forbids a worker
adding it unbidden, so it is sanctioned here and a builder should treat it as in scope.

**3 — W12-T1: THE SITE IS A SEPARATE REPOSITORY. THE CONSOLE IS NOT.** The console stays in
`remudero` because it is not a website — it is `rmd serve`, a verb of the harness. Splitting it would
make the daemon depend on another repository's build, and a worker changing `src/lib/service.ts`
could not see the routes that consume it; one repository also gives agents one canonical instruction
set, which this repo has in `CLAUDE.md`. The marketing site is genuinely separate: it shares no code
with the harness and ships on its own cadence. **THE ANSWER IS THE SAME WHETHER OR NOT `remudero`
GOES PRIVATE**, because a public site cannot live in a private repo — so `W12-T1` does not wait on the
open-core decision. `W12-T1` is therefore REAL WORK IN A REPOSITORY THAT DOES NOT EXIST YET, not a
paperwork gap, and `W1-T49` waits on it legitimately. If W1-T49 is wanted sooner, the edge is the
thing to question, not the site.

**AND THE FIELD EDIT THAT SHIPS WITH THIS.** `W1-T12d` gains `pr: 69` in `plan/tasks.yaml` — the
sanctioned channel `deriveStatus` already reads for "(b) explicit `pr:` field (hand-executed,
pre-ledger)", with `StatusSource` carrying `"pr-field"` and three records already using it. PR #69
records the commissioning and carries `Remudero-Task: W1-T12D-RECORD`, a synthetic id its author chose
so the record would not credit; that instinct was right and the trailer stays as written.
**MEASURED, NOT ASSUMED, AND IT UNPARKS ONE TASK RATHER THAN TWO.** Driven through
`isDispatchEligible`'s own refusal reasons: `W1-T165` moves from `unmet-deps` to OFFERED. `W1-T188`
does NOT — it declares `depends_on: [W1-T187, W1-T165]`, and W1-T165 is now merely dispatchable, not
merged; it unparks when W1-T165 ships. This does nothing for `W12-T1` (whose `prByRef` resolves against
this repo only) or `W1-T12e` (whose drill has not happened and will produce no PR, and which refuses at
`verify-not-auto` rather than `unmet-deps`). W1-T1029 (#2207) files that class.

## 2026-08-19 — RULING: the risk judge's value is UNTESTED, not disproven — W1-T478 and W1-T1031 build before it is ruled on (OPERATOR-RULED)

*Operator-ruled record, recorded at the operator's instruction.* The ruling is the operator's; the
measurements below were taken to serve it, not to make it. This entry records a MEASUREMENT and a
sequencing decision. It does not rule on whether the risk judge stays.

**THE MEASUREMENT.** Re-derived 2026-08-19 at `origin/main` `3b4dcf2e` over the full ledger union
(per-form control first: 0 `.gz`, 9 plain rotations, 1 live, deduped on the full line to 110,378 rows):

    risk_judge.decision      78      proceed 66 (84.6%)  escalate 12 (15.4%)
    risk_judge.escalated     12      merged anyway 12    prevented 0

**TWELVE ESCALATIONS, TWELVE MERGES, NOTHING PREVENTED.** The previously carried figure — 10
escalations, 9 merged, 0 prevented — is superseded: the two then-outstanding PRs have since merged,
taking the merge rate from 90% to 100%. **THE RATE IS RISING, NOT STEADY:** 1 on 08-09, 1 on 08-13,
3 on 08-14, 2 on 08-17, and **5 on 2026-08-19 alone**.

**EVERY ONE TRACES TO ONE OF TWO ALREADY-FILED CAUSES. NONE IS A GENUINE HIGH-RISK FINDING.**

**(a) FIVE — an unparseable response recorded as a maximum-confidence finding (W1-T478).** W1-T456
(#1766), W1-T464 (#1777), W1-T935 (#2027), W1-T940 (#2033), W1-T188 (#2234), each carrying the
identical single reason *"judge output carried no parseable RISK_VERDICT — failing closed (never
silent-proceed)"* at `verdict: high, confidence: 1`. Every escalating decision at confidence exactly
1.00 is one of these five. **THEY NAME NO FINDING**, so there is nothing to read a diff against.
W1-T478 carries `attempts: 0` and was never implemented, yet `state/status.json` reads it `merged` —
credited by **#1784, a plan-only filing commit** resolved through the head-branch rung. It is
outstanding work that does not look outstanding.

**(b) SEVEN — reasoning from the description rather than the diff (W1-T1031, `attempts: 0`).**
W1-T398 (#1505), W1-T451 (#1722), W1-T496 (#1844), W1-T963 (#2204), W1-T975 (#2212), W1-T1020
(#2214), W1-T983 (#2230), at confidence 0.70–0.92. Their reasons open *"The CANDIDATE CHANGE
describes…"*, *"Description states…"*, *"The change description explicitly identifies…"* — quoting the
prose, never the diff. W1-T1031's own filed title states the mechanism: *"THE RISK JUDGE IS GIVEN A
DESCRIPTION AND A FILE LIST AND NOTHING ELSE, SO A CHANGE THAT NAMES THE DEFECT IT REMOVES READS AS A
CHANGE THAT INTRODUCES [it]."*

**THE INVERSION IS LITERAL, AND THE DIFFS WERE READ RATHER THAN INFERRED FROM THE ESCALATION TEXT.**
#1505 was escalated for *"an unauthenticated header-trust vulnerability … enabling complete
authentication bypass"* and its diff ADDS a required `serve.trustedProxy` declaration that REFUSES
startup when `identityCapability` is set without it — it closes the hazard it was flagged for. #1722
was escalated for *"unspent nonces are never deleted … unbounded Map growth"* and ADDS
`CONFIRM_NONCE_TTL_MS` with a sweep-on-issue `pending.delete(staleNonce)`. #2214 was escalated for an
arm reason asserting a full PASS over a partial verdict and ADDS the `partial-pass` class that stops
exactly that. Same shape for #1844, #2204 and #2230: each subject is a `fix`/`feat` for the very
condition quoted back as the risk.

**COST, OBSERVED.** `$96.95` of run spend on the twelve blocked runs (median `$6.29`, mean `$8.08`),
all twelve ending `verdict: blocked, reason: "risk judge escalated"`; **12 escalation issues** opened
(#1506, #1723, #1768, #1778, #1845, #2028, #2034, #2206, #2215, #2216, #2231, #2238); and **8 of 12
followed by a `daemon.start` within ten minutes — 7 of the last 7** (control: 151 `daemon.start` rows).
Human time to read a diff, merge and close an issue is real and is NOT quantified here. The
drain-halt mechanism is likewise not verifiable from the ledger — no step carries a literal `stopped`
key; what is observable is the `verdict: blocked` on all twelve.

**WHY THIS IS NOT A VERDICT ON THE JUDGE. THE VALUE IS UNTESTED, NOT DISPROVEN — AND THE DISTINCTION
IS THE WHOLE POINT OF THIS ENTRY.** A zero-prevention record would condemn the judge only if it had
ever been in a position to prevent something. **IT HAS NEVER BEEN GIVEN A DIFF.** Five escalations
carried no finding at all, and seven read a prose description of a defect being removed. No escalation
in the corpus rests on the change itself, so the twelve merges measure the INPUT, not the judgement.

**AND THE SET CONTAINS ONE CHANGE THAT PLAUSIBLY WARRANTED A STOP, WHICH THE JUDGE DID NOT FIND.**
#2212 merged carrying `wip` in its subject and its own body reading *"remaining: full test suite
running in background to check for collateral breakage; PR body/push still to do"*. It WAS escalated —
for *"creating a permanent bypass around the one predicate a refusal can ever live in"*, which is the
defect that PR CLOSES (it moves the `armAutoMergeAtOpen` call behind ci-green, review-pass, the capped
gate and the risk judge). The self-declared incompleteness appears nowhere in the judge's reasons. It
was stopped by accident, for the wrong cause, and merged anyway. A second, weaker case (#2234, a
squashed `chore(wip)` with a body-verification remainder) was escalated by the unparseable arm — again
no finding.

**THE RULING. W1-T478 AND W1-T1031 BUILD BEFORE THE JUDGE'S VALUE IS RULED ON.** Both are filed, both
are unbuilt, and between them they account for all twelve escalations. Ruling on a mechanism whose
input is known-broken would rule on the input, not the mechanism. Nothing here disables the judge,
retunes its threshold, or changes its escalation path; no such change is authorised by this entry.
W1-T478's phantom `merged` status is noted as a scheduling hazard — it will not surface as
outstanding work on its own — and is not corrected here.

**WHAT THIS ENTRY DOES NOT DO.** It does not close W1-T478 or W1-T1031, whose shards remain
`status: queued`. It does not rule that the judge earns its keep, nor that it does not. It records
that the question is currently unanswerable and names the two builds that would make it answerable.

## 2026-09-02 — VERIFICATION: the bring-your-own-subscription ruling's two open questions, re-read against Anthropic's primary Claude Code pages (SESSION-RECORDED, NOT A RULING)

*Session-recorded at the operator's instruction ("go ahead with the follow-up work identified",
2026-09-02) — not a machine auto-choose resolution and not a ruling. It decides nothing. It records
what four pages under code.claude.com/docs said when read on 2026-09-02, verbatim, so the 2026-08-18
ruling's two open questions are held against primary text instead of search results. Every line below
that is not a quotation is marked as this session's reading and carries no legal weight; the ruling's
own answer stands — the questions are the operator's to put to Anthropic.*

**WHY THIS WAS CHECKED.** The 2026-09-01 direction refresh found the ruling's economic premise resting
on search results: a mid-2026 change said to move headless (`claude -p` / Agent SDK) usage out of the
interactive subscription limits into a separate credit pool. Nothing primary had confirmed it. Both
open questions were re-read against the pages below.

**OPEN QUESTION (2), METERING — THE PREMISE IS NOT IN THE PRIMARY TEXT.** No page under
code.claude.com/docs states a separate headless or SDK pool. What the primary pages do state:

- Legal and compliance (`/docs/en/legal-and-compliance`): *"Advertised usage limits for Pro and Max
  plans assume ordinary, individual usage of Claude Code and the Agent SDK."*
- Authentication (`/docs/en/authentication`), on `claude setup-token`: *"This token authenticates
  with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan. It can only make
  model requests"*; and on `CLAUDE_CODE_OAUTH_TOKEN`: *"Use this for CI pipelines and scripts where
  browser login isn't available."*
- Agent SDK cost tracking (`/docs/en/agent-sdk/cost-tracking`): *"On a Claude subscription within
  your plan's included usage, you get the 1-hour TTL on your own turns … and Claude Code drops those
  turns to the 5-minute TTL once you're drawing on usage credits."*
- Manage costs (`/docs/en/costs`): *"Per-developer costs vary widely based on model selection,
  codebase size, and usage patterns such as running multiple instances or automation."* and *"The
  lifetime is an hour on a subscription and drops to five minutes once you're drawing on usage
  credits."*
- The Claude Code changelog (github.com/anthropics/claude-code, CHANGELOG.md, read through
  v2.1.258) carries no entry decoupling SDK or `-p` usage from plan limits.

Third-party write-ups (search-sourced, not primary) describe a June 15 2026 change to a separate
monthly SDK credit that was announced and then paused, with SDK, `-p` and third-party-app usage
still drawing on the subscription. This entry does not rely on them; it records only that the primary
pages are consistent with that account and inconsistent with the premise as the refresh boxed it.

SESSION READING: subscription-metered SDK and headless use is the documented shape today, and the
advertised limits are stated to assume ordinary, individual usage. "A single subscription carries a
fleet" is therefore a claim about headroom inside limits advertised for a different usage pattern —
not a claim the docs make. The router and the headroom governor remain the mitigation the ruling
names, and the 1h→5min cache-TTL cliff on usage credits is a cost the ruling's model should carry.

**OPEN QUESTION (1), THE THIRD-PARTY-HOST SHAPE — THE PRIMARY TEXT NOW ADDRESSES IT, WITH CONDITIONS
AND ONE DISTINCTION THE RULING DID NOT DRAW.** Legal and compliance (`/docs/en/legal-and-compliance`),
verbatim:

- *"Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or
  services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our
  Commercial Terms of Service and complying with the conditions below: The Claude Code binary must
  not be modified. … Customers may not pay for, resell, or intermediate Claude usage on their end
  users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription
  plan credentials, or 3P inference provider credential … That usage is billed directly to the end
  user under their own agreement with Anthropic"*
- *"OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and
  Enterprise subscription plans and is designed to support ordinary use of Claude Code and other
  native Anthropic applications."*
- *"Developers building products or services that interact with Claude's capabilities, including
  those using the Agent SDK, should use API key authentication … Anthropic does not permit
  third-party developers to offer Claude.ai login into their own applications, or to route requests
  through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not
  collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude
  account must complete through Anthropic's own flow."*
- *"Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their
  own Claude subscription, including where a platform hosts Claude Code as described under Can
  customers offer Claude Code in their products? above."*
- *"Anthropic reserves the right to take measures to enforce these restrictions and may do so without
  prior notice."*
- Agent SDK overview (`/docs/en/agent-sdk/overview`): *"Unless previously approved, Anthropic does
  not allow third party developers to offer claude.ai login or rate limits for their products,
  including agents built on the Claude Agent SDK. Use the API key authentication methods described in
  the Quickstart instead."*

THE DISTINCTION: the hosted-platform carve-out is written for the UNMODIFIED CLAUDE CODE BINARY that
the end user signs into themselves. The fleet's workers do not run that binary — `spawnWorker`
(`src/lib/worker.ts`) calls `query()` from `@anthropic-ai/claude-agent-sdk` (`^0.3.241` in
package.json at this reading) — so the fleet is an agent built on the Agent SDK, the case the SDK
overview's note routes through prior approval. The ruling's mechanism — a customer pastes a
`setup-token` credential into a VM the operator provisions — also has to be read against "may not
collect, store, or intermediate Claude.ai credentials or session tokens", because the token is at rest
on infrastructure the operator runs even when it never transits the operator's hands.

SESSION READING, NOT A CONCLUSION: (i) for the OPERATOR'S OWN fleet on the operator's own
subscription, the pages contemplate SDK use on a plan and state that the limits assume ordinary,
individual usage — a fleet sits outside the stated assumption, not inside a stated prohibition;
(ii) for the CUSTOMER shape the ruling describes, the primary text makes prior approval under the
Commercial Terms the path, and the docs' own pointer for it is *"contact sales"*. Both remain the
operator's action, exactly as the ruling recorded; what changed with this reading is that the question
can now be put to Anthropic in Anthropic's own terms, naming the SDK rather than the binary.

**WHAT THIS ENTRY DOES NOT DO.** It does not amend the ruling, retire `billing_mode`, change
W1-T992's criteria, or move any gate. It does not assert what Anthropic would answer. The pages were
read through the session's egress proxy on 2026-09-02; support.claude.com and anthropic.com/legal were
not reachable from it, so the Consumer and Commercial Terms themselves are cited only by the docs' own
links and were not read.

**Rollback:** delete this entry. It changes no behaviour.
