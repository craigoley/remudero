import { visibleCriteria, type AcceptanceCriterion, type Task } from "./plan.js";

/**
 * One compaction event observed in an SDK message stream (MASTER-PLAN §8B:
 * "Compaction is a SAFETY NET, never a strategy... it WILL fire (observed
 * mean 19.8 turns, tasks at 36+), and today we do not even MEASURE it").
 * Mirrors the SDK's own `SDKCompactBoundaryMessage.compact_metadata` shape
 * (sdk.d.ts 0.3.210 ground truth: `{type:"system", subtype:"compact_boundary"}`)
 * — camelCase here to match `WorkerResult`'s own field-naming convention;
 * `workerLedgerFields` (worker.ts) re-exposes it verbatim on the ledger line.
 */
export interface CompactionEvent {
  trigger: "manual" | "auto";
  preTokens: number;
  postTokens?: number;
  durationMs?: number;
}

/**
 * Scan a raw SDK message stream for `compact_boundary` system messages. Pure
 * and total over `type`/`subtype` string checks — any other message shape
 * (the vast majority of a stream) is silently skipped, so a RECORDED test
 * fixture never needs to be a complete/valid stream to be scannable.
 * `collectWorkerResult` (worker.ts) calls this LIVE, per message, on every
 * real worker spawn — this is not fixture-only plumbing.
 */
export function detectCompactionEvents(messages: unknown[]): CompactionEvent[] {
  const events: CompactionEvent[] = [];
  for (const raw of messages) {
    const msg = raw as { type?: string; subtype?: string; compact_metadata?: unknown };
    if (msg?.type !== "system" || msg.subtype !== "compact_boundary") continue;
    const meta = (msg.compact_metadata ?? {}) as {
      trigger?: string;
      pre_tokens?: number;
      post_tokens?: number;
      duration_ms?: number;
    };
    const event: CompactionEvent = {
      trigger: meta.trigger === "manual" ? "manual" : "auto",
      preTokens: typeof meta.pre_tokens === "number" ? meta.pre_tokens : 0,
    };
    if (typeof meta.post_tokens === "number") event.postTokens = meta.post_tokens;
    if (typeof meta.duration_ms === "number") event.durationMs = meta.duration_ms;
    events.push(event);
  }
  return events;
}

/**
 * One compaction ATTEMPT that FAILED (W1-T2245). `sdk.d.ts:4684` ground truth (0.3.233):
 * `SDKStatusMessage` (`{type:"system", subtype:"status"}`) carries `compact_result?: 'success' |
 * 'failed'` and `compact_error?: string` — a channel `detectCompactionEvents` above NEVER reads,
 * because it matches only `subtype:"compact_boundary"`. A compaction that fails emits no boundary
 * message, so before this it produced NO event, NO `quality_suspect`, NO row — indistinguishable
 * from a call that never attempted compaction at all. `error` is the SDK's own `compact_error`
 * string when present; absent (never guessed) when the status message carried none.
 */
export interface CompactionFailure {
  error?: string;
}

/**
 * Scan a raw SDK message stream for `{type:"system", subtype:"status"}` messages whose
 * `compact_result` reads `"failed"`. Same discipline as {@link detectCompactionEvents}: pure,
 * total over `type`/`subtype`/`compact_result` string checks, any other message shape silently
 * skipped. `collectWorkerResult` (worker.ts) calls this LIVE, per message, alongside the boundary
 * detector — this reads an existing channel already arriving in the stream; it adds no SDK option
 * and changes no spawn behaviour.
 */
export function detectCompactionFailures(messages: unknown[]): CompactionFailure[] {
  const failures: CompactionFailure[] = [];
  for (const raw of messages) {
    const msg = raw as { type?: string; subtype?: string; compact_result?: string; compact_error?: string };
    if (msg?.type !== "system" || msg.subtype !== "status" || msg.compact_result !== "failed") continue;
    const failure: CompactionFailure = {};
    if (typeof msg.compact_error === "string") failure.error = msg.compact_error;
    failures.push(failure);
  }
  return failures;
}

/**
 * A call/run is QUALITY-SUSPECT (MASTER-PLAN §8B) the moment ONE compaction
 * fired — its acceptance proofs must be re-verified against repo state
 * (W1-T3F), never trusted from a possibly-lossy REPORT.
 */
export function isQualitySuspect(events: CompactionEvent[]): boolean {
  return events.length > 0;
}

/**
 * The COMMIT MESSAGE contract — ONE literal shared by every prompt that asks a worker
 * to commit (the implement OUTPUT CONTRACT above, and `renderFixPrompt`'s fix-rung
 * footer in run-task.ts), so the two can never drift.
 *
 * WHY IT EXISTS: `commitlint` is a REQUIRED check. It does NOT lint the base..head commit
 * range — W1-T129 relocated the gate to the PR TITLE ALONE (this repo squash-merges every
 * PR via `COMMIT_OR_PR_TITLE`, so branch commits never reach main and linting them failed
 * PRs over history that would never exist post-merge), and W1-T351 made that a LIVE
 * `gh pr view` read in ci.yml rather than a stale opened-event snapshot. Verified against
 * ci.yml (job `commitlint`, step "the PR title — read LIVE via `gh pr view`"): the only
 * base..head mention left in that file is the comment explaining the relocation. A
 * malformed TITLE still blocks the merge exactly like a failing test — there is no husky,
 * no `core.hooksPath`, no `commit-msg` hook, so nothing local catches it first, and the
 * W1-T76 fix rung has no move for a CI-check failure and escalates a SPEC question instead
 * (#304, #306, #406, #427/#428). Because GitHub's `COMMIT_OR_PR_TITLE` squash title falls
 * back to a lone commit's own subject when a PR has exactly ONE commit, the rules below
 * govern BOTH the PR title and your run's FINAL commit subject — earlier checkpoint
 * (`wip:`) commits are additional history that a squash-merge discards, not a linted
 * artifact.
 *
 * The rules below are MEASURED against the real CLI (see test/commit-message.test.ts),
 * not inferred. In particular there is NO acronym exemption: `SSE stream severed`,
 * `URL round-trips` and `FIND layer …` are all REJECTED by `subject-case`.
 */
export function commitMessageContractLines(): string[] {
  return [
    "- COMMIT MESSAGE — `commitlint` is a REQUIRED check, but it lints ONLY the PR TITLE (read",
    "  LIVE via `gh pr view`, W1-T351) — NOT every commit on the branch. This repo squash-merges",
    "  every PR, so branch commits never reach main; that is also why `wip:` checkpoint commits",
    "  (see CHECKPOINT AS YOU GO, above) never block a merge. A malformed TITLE still blocks the",
    "  merge exactly like a failing test, so these rules govern the PR title AND your run's FINAL",
    "  commit subject (a lone-commit PR's squash title falls back to that commit's own subject):",
    "  * Conventional Commits: `type(scope): subject` — type is one of build|chore|ci|docs|",
    "    feat|fix|perf|refactor|revert|style|test, lower-case.",
    "  * The header (that whole first line) must be <= 100 CHARACTERS. Count characters, not",
    "    bytes — an em-dash is 3 bytes but 1 character. Put detail in the body, not the header.",
    "  * Start the subject LOWER-CASE. There is NO acronym exemption — `SSE stream severed`",
    "    and `URL round-trips` are both REJECTED. Lower-case it (`sse …`) or reword. No final `.`.",
    "  * Wrap every BODY line at <= 100 characters, with a blank line after the header.",
    "  * Example: `feat(serve): add fuzzy search to the board (W1-T157)`",
    // W1-T1012: THE TRAILER'S HOME, CORRECTED. Until this line the contract taught a worker
    // ONLY that the `Remudero-Task: <id>` trailer belongs in the PR body — and this repo's
    // `gh pr merge --squash` (no `--subject`/`--body`) composes the squashed commit from the
    // BRANCH'S OWN COMMITS and discards the PR body outright, so a trailer written only there
    // never reaches origin/main (measured: 373 of 538 trailered merges, 69%). The harness now
    // appends the trailer to this commit itself, right before opening the PR
    // (`appendTaskTrailerToCommit`, run-task.ts), idempotently — so the two bullets below are
    // a safety net (a worker that writes it first pays no second amend), not a new obligation.
    "  * The `Remudero-Task: <id>` trailer belongs on THIS COMMIT too, not only the PR body —",
    "    the squash-merge keeps this commit and discards the PR body, so a trailer written only",
    "    into the body never reaches origin/main.",
  ];
}

/**
 * The hard-constraints block, shared VERBATIM by the initial prompt
 * (`renderImplementPrompt`, run-task.ts) and the post-compaction ANCHOR
 * (`renderAnchorBlock`, below) — ONE source of literal text so the two can
 * never drift apart, and the anchor is provably byte-identical to what the
 * worker was told at turn 0 (never re-derived, never paraphrased).
 */
/**
 * THE BODY-VERSUS-DIFF CONTRACT (impl-FV) — shared VERBATIM by the implement contract above and by
 * the fix rung (`renderFixPrompt`, run-task.ts), the two prompts whose worker authors a PR body.
 * Shared for the same reason {@link commitMessageContractLines} is: two literals of one rule drift.
 *
 * WHY THIS EXISTS. `bodyContradictsDiff` (lib/review.ts) folds into `judgeReview`'s state, so a
 * contradiction is a REQUIRED-check failure with no floor to fall back on — and until now NO prompt
 * in this repository mentioned it (recon-FT). It landed 2026-07-31; its zero observed failures are
 * its AGE, not compliance. It exists for a measured reason: #974 claimed one file over a 3-file
 * diff, and #1025's claim rode a -515-line source revert that silently reverted three merged PRs.
 *
 * WHY IT STATES THE RULE RATHER THAN A WORD LIST. The check is deliberately SUBJECT-SENSITIVE —
 * both predicates are anchored (`claimsChangesetContext` backward, `noClaimIsAboutChangeset`
 * forward) precisely so a sentence about something OTHER than the changeset stays silent. A "never
 * write these words" instruction would be false, would make bodies worse, and would still not stop
 * the failures, because the ones that fired were about subject, not vocabulary.
 */
export function bodyVsDiffContractLines(): string[] {
  return [
    "- YOUR PR BODY IS CHECKED AGAINST YOUR OWN DIFF: a body that contradicts its changeset FAILS",
    "  remudero-review outright, with no proof or keyword floor to fall back on. The rule is about a",
    "  SENTENCE'S SUBJECT, never a word blacklist — if the subject is YOUR CHANGESET it must be true",
    "  of it, and the identical words about anything else are deliberately ignored. Three shapes:",
    "  (1) `exactly N file(s)` — read only when tied to the changeset by a `:` list after it or a",
    "  changeset word ('changed'/'touches'/'diff'/'this PR') earlier in the SAME sentence; N must",
    "  equal your real file count and every file you name must be in the diff. (2) `no <path>` —",
    "  read when the next word on that line is a changeset word, OR when nothing follows it on that",
    "  line; that path must really be absent ('no bugs' is ignored — not a path). (3) the hyphenated",
    "  shorthands `plan-only`/`data-only` — read as a claim when they are the SUBJECT of the line:",
    "  used as a label (`Plan-only: …`), predicated with a linking verb (`this is plan-only`), or",
    "  beside a changeset word in the same sentence. Naming one inside a path, or describing another",
    "  PR with it, is ignored — but if you predicate it of YOUR diff it must be literally true.",
    "  RE-CHECK AFTER EVERY PUSH — a body written against an earlier diff goes stale silently.",
  ];
}

/**
 * REMOVED (W1-T295 added it, W1-T464 removed it): a WORKER-facing contract line telling a
 * worker to run `rmd preflight --ci-parity` before its first push. `ciParityContractLines()`
 * used to live here and was spread into both `outputContractLines` (below) and the fix rung's
 * footer (`renderFixPrompt`, run-task.ts).
 *
 * WHY IT'S GONE. Re-measured on the Azure host's full ledger (W1-T464's shard): the
 * orchestrator's handling of a failed worker preflight (`run-task.ts`) has NO branch, NO early
 * return, NO gate — it logs `preflight.failed` and keeps going, so the two prompt lines below
 * never stopped a push. Of the 17 `preflight.failed` rows on that host, only 2 were genuine
 * (the other 15 were `test/preflight.test.ts`'s fake spawn writing into the worker's tree, a
 * defect W1-T455 owns, not evidence of the gate firing); of those 2, one was UNDECIDABLE (CI
 * never ran on a superseded sha) and the other was WRONG (CI passed 21/22 checks, 1 neutral,
 * on the identical sha the preflight had flagged). Earned cost: 0. It also was NOT cheap: one
 * `--ci-parity` pass runs ~15-17 minutes (a 4-6 minute non-coverage suite plus a ~10 minute
 * coverage suite plus 21 cheaper steps) against a ~61-minute lane — roughly a quarter of it,
 * paid on every implement and every fix-rung round, for a check that could not have blocked
 * anything even when it was wrong.
 *
 * WHAT THIS DOES NOT REMOVE. `rmd preflight --ci-parity` remains a fully intact CLI verb
 * (lib/ci-parity.ts, docs/cli-reference.md) — it is the HAND route's own gate (W1-T221 built
 * the verb, W1-T294 added the flag), and an operator making a hand-authored push is a
 * different caller with different economics: no `blocked_ci` fix rung runs behind them if CI
 * catches something after the fact. Only the WORKER's obligation to run it pre-push is gone;
 * a worker that pushes now and lets CI judge is not unprotected — `blocked_ci` is a
 * first-class, non-halting verdict (`src/lib/drain.ts`) whose fix rung already exists for
 * exactly this case.
 *
 * The base `rmd preflight` (no flags) — commitlint, `tsc --noEmit`, and the commit-message
 * checks — is untouched by this shard; it was never part of this contract to begin with (see
 * `commitMessageContractLines`, above, for the one piece of it a worker IS told about).
 */

/**
 * THE ROLE SENTENCE — the one thing `renderImplementPrompt` never said.
 *
 * MEASURED (state/recon-implement-acts-as-recon.md, re-derived at db4e110): `renderReconPrompt`'s
 * FIRST SENTENCE is "You are a RECON worker. Do NOT modify anything." The implement prompt opened
 * with the literal string "# CONTEXT" and contained no role assignment anywhere — no "implement",
 * no "build", no "you". There is no system prompt on either spawn (`systemPrompt`/
 * `appendSystemPrompt` have zero occurrences in run-task.ts and worker.ts), so the prompt text was
 * the ONLY thing distinguishing the two roles, and it did not.
 *
 * WHAT THE WORKER SAW INSTEAD. `# TASK` renders `task.prompt ?? task.title`, and zero task records
 * carry `prompt:`, so it is always the title — which for a well-written shard is a DIAGNOSIS in the
 * same register a recon report is written in. Above it, the CONTEXT block is recon's own OBSERVED
 * lines, each stamped `[src: recon#<taskId>]`. A worker reading top-down met a colleague's findings
 * and a statement of a defect, and was never addressed as the one who fixes it. Five dispatches
 * across the two best-specified tasks in the plan ended in recon reports; one filed its own
 * assignment as a `task:` follow-up, which is the only output grammar the contract actually teaches
 * (`parseFollowups` accepts exactly research|task|action — there is no type meaning "I did it").
 *
 * WHY IT LIVES HERE rather than in run-task.ts. This module is where the literal text SHARED
 * between the turn-0 prompt and the post-compaction anchor lives, and the role has to survive a
 * compaction: the runs that failed ran 43-109 turns, which is the regime where the anchor exists to
 * matter at all. ONE constant, rendered at the head of {@link renderAnchorBlock} and at the head of
 * `renderImplementPrompt` — so the two can never drift, exactly as the output contract already
 * cannot.
 *
 * IT IS NOT RENDERED BY RECON. `outputContractLines` and `renderAnchorBlock` have exactly two
 * consumers between them, both on the implement path; `renderReconPrompt` renders neither. That
 * asymmetry IS the fix — a role sentence both spawns carried would distinguish nothing.
 *
 * DELIBERATELY BEFORE `# CONTEXT` in the prompt. `extractContext` (lib/provenance.ts) scans from
 * the first `CONTEXT` heading to the next heading, so text above it is outside the provenance
 * linter's region and needs no `[src:]` — while a bullet added INSIDE that block would need one on
 * every block, and `assertProvenance` throws at render time.
 */
export const IMPLEMENT_ROLE_LINES: readonly string[] = [
  "You are an IMPLEMENT worker: YOU write the code in this run.",
  "The change described under TASK is yours to MAKE NOW — not to investigate, summarise, or file as",
  "follow-up work for someone else to do. Recon has already run; anything under CONTEXT is its",
  "report TO you, not your assignment. A run that ends in a report with no diff has FAILED, however",
  "accurate the report.",
];

export function outputContractLines(taskId: string): string[] {
  return [
    "# OUTPUT CONTRACT",
    "- Make ONLY the change described in TASK; one concern.",
    // W1-T502: THE CADENCE INSTRUCTION. Until this line, the contract taught exactly one
    // terminal act ("stage the changed file(s) and commit", below) — for the whole life of a
    // run, everything a worker produced existed ONLY as dirty files and index entries in its
    // worktree, which `reapStaleWorktrees` (worker.ts) `rm -rf`s without `git worktree prune`
    // the moment it judges the run terminal. A linked worktree shares the PARENT CLONE's object
    // store and refs — only HEAD and the index are per-worktree — so a commit made in here
    // writes its objects into the parent's `.git/objects` and moves `refs/heads/<branch>`, both
    // outside the reaper's reach; an uncheckpointed wipe leaves index archaeology or nothing, a
    // checkpointed one leaves `git log <branch>`. These commits cost main NOTHING (see COMMIT
    // MESSAGE below): this repo squash-merges every PR, so `wip:` commits never reach main.
    "- CHECKPOINT AS YOU GO: after each meaningful unit of work — a test newly green, a decision",
    "  taken, an approach abandoned — commit everything on THIS run's branch with subject",
    "  `wip: <what>` and a body carrying a `[remudero-context]` block: one line each for decided /",
    "  remaining / failed. This worktree is reapable and its dirty files are your ONLY copy of the",
    "  work until you commit it — checkpoints land in the parent clone's shared object store and",
    "  survive a worktree wipe; nothing else does. Checkpoints are ADDITIONAL commits, never a",
    "  substitute for the terminal commit below.",
    // W1-T105 — the operator's requirement, verbatim: "ensure that if any
    // implementations come back with follow-up research, actions, tasks, etc —
    // they get added to the plan." Anything discovered that is OUT OF SCOPE for
    // this one concern goes HERE, never into the diff; the retro's follow-up
    // harvest (lib/retro.ts) mines this section into cited proposal candidates.
    "- FOLLOW-UPS (optional): anything you discover that is OUT OF SCOPE for this",
    "  one concern — a research question, a follow-up task, or an action someone",
    "  should take — goes in a '## Follow-ups' section of your REPORT, NEVER into",
    "  the diff. One typed entry per line, its own one-line why included inline:",
    "  `research: <what, and why>` | `task: <what, and why>` | `action: <what, and why>`.",
    "- If a filename/approach choice is needed, FIRST emit a DECISION_REQUEST",
    "  (exactly two options, one marked RECOMMENDED, a reversibility note) and STOP.",
    // W1-T272: the output contract's third exit. Before this, a worker that correctly found
    // the task's acceptance ALREADY TRUE on origin/main had no PR-less exit that didn't halt
    // the drain (`no_pr` is the only PR-less verdict, and it stops the drain as anomalous) —
    // so five separate runs each manufactured a no-op closure PR just to comply. This line
    // gives that honest finding a sanctioned exit, gated on NAMING the merged PR that already
    // did the work: an unverifiable "already done" claim is refused (falls through to `no_pr`,
    // unchanged) exactly as it should be — see run-task.ts's `resolveAlreadySatisfied`.
    "- If the task's acceptance is ALREADY SATISFIED on origin/main — nothing left to change —",
    "  say so and STOP without opening a PR: end your REPORT with a line",
    "  `ALREADY_SATISFIED: <the PR number or url that already merged and satisfies this task>`.",
    `  That PR must actually be MERGED and its body must carry \`Remudero-Task: ${taskId}\` for`,
    "  THIS task, or the claim is refused and treated as if you had opened no PR at all.",
    "- Otherwise: stage the changed file(s) and commit.",
    // W1-T465: THE MECHANISM, NOT JUST THE PROHIBITION. Five runs on the mini and three on Azure
    // backgrounded a long job (`--ci-parity` is 15-17 minutes) and ENDED THE TURN expecting a
    // wake-up; all eight produced `no_pr` with `commits_ahead: 0` and `subtype: "success"`, and the
    // three Azure ones alone cost $49.36. NOTHING IN ANY PROMPT TAUGHT THIS — the worker inferred it
    // from the harness's real backgrounding affordance, which genuinely DOES notify in an
    // INTERACTIVE session and cannot reach a headless run. So the reason is stated with the rule: a
    // prohibition whose mechanism is absent gets re-derived away by the next model that reasons
    // about it, and a worker facing a fifteen-minute job will background it anyway. No polling
    // helper exists in this repo to cite (measured), so the SHAPE is spelled out rather than named.
    "- NEVER background a long job and then end your turn to wait for it. THERE IS NO NOTIFICATION",
    "  CHANNEL in this run: nothing will wake you when a background task finishes, and the run ENDS",
    "  the moment you stop issuing tool calls — your work is discarded with it, however far you got.",
    "  If you background anything, POLL it yourself and keep issuing tool calls until it is done,",
    "  e.g. `until [ -f /tmp/done ]; do sleep 20; done` — or simply run the command in the",
    "  foreground and wait for it to return.",
    "  Then: `git push origin HEAD` (NOT `-u` — the shared .git/config is",
    "  outside the sandbox write scope, WS-0 FF10f), and open a PR with an EXPLICIT, conventional",
    "  `--title` rather than deriving one: checkpointing (above) means a multi-commit run branch",
    "  is normal, and `gh pr create --fill` derives a multi-commit PR's title from the BRANCH",
    "  NAME, which is not a conventional subject. Pass it yourself, e.g. `gh pr create --title",
    "  \"type(scope): subject\" --fill --base main`.",
    ...commitMessageContractLines(),
    `- Include this exact trailer as the LAST line of the PR body: Remudero-Task: ${taskId}`,
    // W1-T81/T82 class (PRs #677/#683): a correct, fully-tested PR still FAILED review because
    // its body did not engage each acceptance PROOF — remudero-review executes each proof and,
    // when a proof is not executable, judges the body against that proof's own text (a keyword
    // floor). This guidance lived ONLY in the fix rung (renderFixPrompt), so every first attempt
    // on a prose-proof task predictably stalled at review. Stated here, at turn 0, the first PR
    // clears the floor. Same requirement the fix rung repeats — kept in sync deliberately.
    "- Your PR body MUST substantiate EVERY task acceptance criterion: for each, say how the",
    "  diff satisfies it and NAME the test or grep that proves it. remudero-review executes each",
    "  proof and, when a proof is not executable, judges your body against that proof's own text —",
    "  a body that does not engage each proof is scored UNMET even when the work is correct.",
    ...bodyVsDiffContractLines(),
    "- End with a REPORT whose LAST line is exactly: PR_URL: <the pull request url>",
  ];
}

/**
 * The ANCHOR block (MASTER-PLAN §8B): "the task goal, acceptance criteria,
 * and hard constraints are re-injected VERBATIM after any compaction — never
 * handed to a summarizer, never paraphrased." Built ONCE per run and reused
 * byte-identical for every compaction event in that run (see
 * `anchorReinjections`) — deliberately excludes the volatile CONTEXT block
 * (recon/matched-learnings, §8A Tier 1/3), which a compaction is free to
 * lose; only the three §8B-named anchor components survive it.
 *
 * W1-T166: the "acceptance criteria" component is filtered through
 * {@link visibleCriteria} — this re-injects into the SAME worker's own
 * context, so a `holdout: true` criterion belongs here exactly as little as
 * it belongs in the turn-0 prompt: never re-injected, never re-derived, never
 * shown, across a compaction any more than before one.
 */
export function renderAnchorBlock(
  task: Pick<Task, "id" | "title" | "prompt" | "acceptance">,
  runId: string,
): string {
  const goal = (task.prompt ?? task.title).split("${RUN_ID}").join(runId).split("${TASK_ID}").join(task.id);
  const criteria = visibleCriteria(task.acceptance ?? [])
    .map((c: AcceptanceCriterion) => `- claim: ${c.claim}\n  proof: ${c.proof}`)
    .join("\n");
  return [
    ...IMPLEMENT_ROLE_LINES,
    "",
    "# ANCHOR (re-injected verbatim after compaction — MASTER-PLAN §8B)",
    "",
    "## GOAL",
    goal,
    "",
    "## ACCEPTANCE CRITERIA",
    criteria || "(none declared)",
    "",
    ...outputContractLines(task.id),
  ].join("\n");
}

/**
 * Given a message stream and the run's pre-built anchor block, return the
 * continuation message a duplex spawn sends after EACH compaction event —
 * always `anchor`, unchanged, never re-derived/re-summarized per event. A
 * stream with N compactions yields N byte-identical entries. Wiring this
 * into an actual in-flight (streaming-input) spawn — so a LIVE compaction
 * gets re-anchored mid-run — is W1-T12e's operator-golden drill; this module
 * proves the detection + anchor mapping are correct over a recorded stream
 * fixture (verify:auto), per the W1-T36 redesign note (Rules 18/20).
 */
export function anchorReinjections(messages: unknown[], anchor: string): string[] {
  return detectCompactionEvents(messages).map(() => anchor);
}
