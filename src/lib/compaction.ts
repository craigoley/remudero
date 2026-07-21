import type { AcceptanceCriterion, Task } from "./plan.js";

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
export function outputContractLines(taskId: string): string[] {
  return [
    "# OUTPUT CONTRACT",
    "- Make ONLY the change described in TASK; one concern.",
    "- If a filename/approach choice is needed, FIRST emit a DECISION_REQUEST",
    "  (exactly two options, one marked RECOMMENDED, a reversibility note) and STOP.",
    "- Otherwise: stage the changed file(s), commit, then run",
    "  `git push origin HEAD` (NOT `-u` — the shared .git/config is outside the sandbox",
    "  write scope, WS-0 FF10f), and open a PR with `gh pr create --fill --base main`.",
    ...commitMessageContractLines(),
    `- Include this exact trailer as the LAST line of the PR body: Remudero-Task: ${taskId}`,
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
 */
export function renderAnchorBlock(
  task: Pick<Task, "id" | "title" | "prompt" | "acceptance">,
  runId: string,
): string {
  const goal = (task.prompt ?? task.title).split("${RUN_ID}").join(runId).split("${TASK_ID}").join(task.id);
  const criteria = (task.acceptance ?? [])
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
