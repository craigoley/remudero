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
 * WHY IT EXISTS: `commitlint` is a REQUIRED check that lints the WHOLE base..head range
 * and runs ONLY in CI — there is no husky, no `core.hooksPath`, no `commit-msg` hook, so
 * nothing local tells a committer their message is malformed. The first signal is a red
 * required check on an open PR, where the W1-T76 fix rung has no move for a CI-check
 * failure and escalates a SPEC question instead (#304, #306, #406, #427/#428).
 *
 * The rules below are MEASURED against the real CLI (see test/commit-message.test.ts),
 * not inferred. In particular there is NO acronym exemption: `SSE stream severed`,
 * `URL round-trips` and `FIND layer …` are all REJECTED by `subject-case`.
 */
export function commitMessageContractLines(): string[] {
  return [
    "- COMMIT MESSAGE — `commitlint` is a REQUIRED check and lints EVERY commit on the PR,",
    "  so a malformed message blocks the merge exactly like a failing test:",
    "  * Conventional Commits: `type(scope): subject` — type is one of build|chore|ci|docs|",
    "    feat|fix|perf|refactor|revert|style|test, lower-case.",
    "  * The header (that whole first line) must be <= 100 CHARACTERS. Count characters, not",
    "    bytes — an em-dash is 3 bytes but 1 character. Put detail in the body, not the header.",
    "  * Start the subject LOWER-CASE. There is NO acronym exemption — `SSE stream severed`",
    "    and `URL round-trips` are both REJECTED. Lower-case it (`sse …`) or reword. No final `.`.",
    "  * Wrap every BODY line at <= 100 characters, with a blank line after the header.",
    "  * Example: `feat(serve): add fuzzy search to the board (W1-T157)`",
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
    "  shorthands `plan-only`/`data-only` — matched ANYWHERE whatever the subject, so never write",
    "  either unless it is literally true of your diff.",
    "  RE-CHECK AFTER EVERY PUSH — a body written against an earlier diff goes stale silently.",
  ];
}

/**
 * THE CI-PARITY-BEFORE-FIRST-PUSH CONTRACT (W1-T295) — shared VERBATIM by the implement
 * contract (`outputContractLines`, below) and the fix rung's footer (`renderFixPrompt`,
 * run-task.ts), the same two prompts {@link commitMessageContractLines} and
 * {@link bodyVsDiffContractLines} already keep in sync — for the same reason: two copies of
 * one rule drift (PR #427/#428, where the commit-message rule reached only the implement
 * lane and a fix worker paid for the gap).
 *
 * WHY IT EXISTS. `outputContractLines` went straight from "stage, commit, push" to opening
 * the PR with nothing said about reaching green first. CLAUDE.md's "Before you push" section
 * records the coverage ratchet alone blocking three consecutive PRs on their first push, each
 * costing an amend, a force-push and a CI round-trip — a cost paid in strikes, since a red
 * first push spends a fix-rung attempt on infrastructure discovery instead of a review
 * finding. That prose lived only in a doc a worker is never shown; W1-T294 gives it a command
 * (`rmd preflight --ci-parity`, mirroring every CI job — see lib/ci-parity.ts) and this
 * function is what makes a worker RUN it before the first push rather than after a check goes
 * red on GitHub.
 *
 * ONCE, NOT PER COMMIT: this is about the FIRST push only — the fix rung already amends the
 * same PR, and a "before every push" reading would be ignored or cost more than it saves.
 */
export function ciParityContractLines(): string[] {
  return [
    "- BEFORE THE FIRST PUSH, run `rmd preflight --ci-parity` (mirrors every CI job) and reach a",
    "  PASS: fix whatever step it names — do not push to find out whether a required check is red.",
  ];
}

export function outputContractLines(taskId: string): string[] {
  return [
    "# OUTPUT CONTRACT",
    "- Make ONLY the change described in TASK; one concern.",
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
    "- Otherwise: stage the changed file(s), commit, then run",
    ...ciParityContractLines(),
    "  Only once that passes: `git push origin HEAD` (NOT `-u` — the shared .git/config is",
    "  outside the sandbox write scope, WS-0 FF10f), and open a PR with `gh pr create --fill",
    "  --base main`.",
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
