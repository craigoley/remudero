/**
 * W1-T9297 — the fix-progress judge sees the red it rules on.
 *
 * On 2026-10-13 the judge escalated #11444 at round_count 0, reasoning that its checkout held no check output
 * for the PR. Its working directory is the daemon's own worktree, not the PR head, so the input is the only
 * place the red can be read. These tests drive `buildFixProgressInput` and the production judge's prompt
 * through a fake spawn.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixProgressInput as buildBase, failureEvidenceOf, resolveFixProgress } from "#src/lib/fix-progress-judge.js";
import { buildFixProgressInput, productionFixProgressJudge, runSweep, type SweepDeps } from "#src/lib/sweep.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";

const TAIL = [
  "2026-10-13T19:04:01.000Z # Subtest: coverage floor",
  "2026-10-13T19:04:01.100Z not ok 3 - the ratchet refuses a file below its floor",
  "2026-10-13T19:04:01.200Z   at test/coverage-ratchet.test.ts:44:3",
  "2026-10-13T19:04:01.300Z # fail 1",
].join("\n");

const facts = (extra: Partial<Parameters<typeof buildFixProgressInput>[0]> = {}) => ({
  taskId: "W1-T9057", prNumber: 11444, headSha: "d0dd658", currentRed: ["coverage-shard (5/8)"], ledger: [], ...extra,
});

test("W1-T9297: the judge input carries the failing check evidence", () => {
  const input = buildFixProgressInput(facts({
    ciFailures: [{ name: "coverage-shard (5/8)", logTail: TAIL, tailSource: "log" }] }));
  assert.equal(input.failureEvidence?.supplied, true);
  const checks = input.failureEvidence?.checks ?? [];
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.check, "coverage-shard (5/8)");
  assert.deepEqual(checks[0]!.tests, ["the ratchet refuses a file below its floor"]);
  assert.equal(checks[0]!.signature, "test/coverage-ratchet.test.ts");
  assert.equal(checks[0]!.tail_source, "log");
  assert.match(checks[0]!.excerpt ?? "", /not ok 3 - the ratchet refuses a file below its floor/);
  assert.doesNotMatch(checks[0]!.excerpt ?? "", /2026-10-13T/, "timestamps are stripped");
  // The base builder carries the same evidence.
  assert.deepEqual(buildBase(facts({ ciFailures: [{ name: "coverage-shard (5/8)", logTail: TAIL, tailSource: "log" }] })).failureEvidence,
    input.failureEvidence);
});

test("W1-T9297: absent failure evidence is recorded as absent with why, never as an empty list", () => {
  const none = buildFixProgressInput(facts());
  assert.deepEqual(none.failureEvidence, { supplied: false, reason: "the caller supplied no CI failure evidence for this head" });
  const empty = failureEvidenceOf([]);
  assert.equal(empty.supplied, false);
  assert.equal(empty.checks, undefined);
  const unreadable = failureEvidenceOf([{ name: "ci-shard (1/8)", logTail: "", logUnavailable: { kind: "fetch-failed", detail: "502" } }]);
  assert.equal(unreadable.supplied, false);
  assert.match((unreadable as { reason: string }).reason, /none with a readable log: ci-shard \(1\/8\) \(fetch-failed: 502\)/);
  assert.equal(unreadable.checks?.[0]?.unavailable, "fetch-failed: 502");
  const blank = failureEvidenceOf([{ name: "x", logTail: "  \n" }]);
  assert.equal(blank.checks?.[0]?.unavailable, "empty log tail");
});

test("W1-T9297: evidence is bounded per check and falls back to the log's tail for an unmarked failure", () => {
  const many = Array.from({ length: 9 }, (_, i) => `not ok ${i + 1} - failing title ${i}`).join("\n");
  const check = failureEvidenceOf([{ name: "big", logTail: `${many}\n${"x".repeat(5000)}` }]).checks![0]!;
  assert.equal(check.tests.length, 5);
  assert.ok((check.excerpt ?? "").length <= 600);
  const plain = failureEvidenceOf([{ name: "lint", logTail: "step one\nstep two\nstep three" }]).checks![0]!;
  assert.equal(plain.signature, null);
  assert.match(plain.excerpt ?? "", /step three/);
});

test("W1-T9297: the judge prompt says its checkout is not the PR head", async () => {
  const prompts: string[] = [];
  const spawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    prompts.push(args.prompt);
    return { text: 'FIX_PROGRESS: {"verdict":"continue","reason":"round one can act"}' } as never;
  };
  const judge = productionFixProgressJudge({ cwd: ".", settingsFile: "settings/worker.json",
    mount: { model: "test-model", effort: "low", maxTurns: 1, contextBudget: 10000 }, spawn });
  const input = buildFixProgressInput(facts({
    ciFailures: [{ name: "coverage-shard (5/8)", logTail: TAIL, tailSource: "log" }] }));
  const verdict = await judge(input);
  assert.equal(verdict?.verdict, "continue");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /working directory is NOT the PR head/);
  assert.match(prompts[0]!, /failureEvidence field of the input below IS the evidence/);
  assert.match(prompts[0]!, /missing history is not a loop/);
  assert.match(prompts[0]!, /the ratchet refuses a file below its floor/);
  assert.match(prompts[0]!, /test\/coverage-ratchet\.test\.ts/);
});


test("the real sweep progress judge receives the current semantic refusal, not only its claim", async () => {
  const reason = "The delegated scope matcher changed its approved literal despite a passing mechanical check.";
  const taskId = "W1-T9297", claim = "the matcher preserves its approved literal";
  const rows: Record<string, unknown>[] = [
    { task_id: taskId, step: "fix.dispatch", round_id: "semantic-round", head_sha: "head-before",
      ci_failures: [{ check: `review:${claim}` }] },
    { task_id: taskId, step: "fix.done", round_id: "semantic-round", head_sha: "head-before",
      fix_outcome: "NO_CHANGE", subtype: "success" },
  ];
  let captured: unknown, calls = 0, dispatched = 0;
  const deps: SweepDeps = { ledgerPath: "/unused/semantic-progress", runId: "semantic-progress-observation",
    now: () => Date.now(), readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async input => { calls++; captured = input; return undefined; },
    arm: () => {}, close: () => {}, escalate: () => {}, dispatchFix: () => { dispatched++; } };
  await runSweep([{ prNumber: 9297, prUrl: "https://github.com/o/r/pull/9297", taskId,
    headSha: "head-current", checksState: "green", reviewState: "failure", priorStrikes: 1,
    autoMergeArmed: false, lastActivityAt: new Date().toISOString(),
    unmetCriteria: [{ claim, proof: "unit test: scope matching keeps the approved literal", met: false,
      floorMet: true, reason, proof_exec: "executed_pass" }] }], deps);
  assert.equal(calls, 1, "the real semantic-failure route reaches the progress judge");
  assert.equal(dispatched, 0, "an unavailable judgment grants no repair attempt");
  assert.ok(JSON.stringify(captured).includes(reason), "the judge needs the current semantic diagnosis, not a CI absence report");
  assert.deepEqual(rows.find(row => row.step === "fix.progress_judged")?.review_failure_evidence,
    { supplied: true, criteria: 1 }, "the receipt distinguishes held review findings from absent CI logs");
});


test("semantic findings retain bounded diagnostics without exposing hidden criteria", () => {
  const common = { proof: "unit test: a literal proof", met: false, proof_exec: "executed_fail", reason: "r".repeat(1000) };
  const input = buildBase(facts({ reviewFailures: [
    { ...common, claim: "public", proofFailureOutput: "o".repeat(1000), loadError: "e".repeat(1000) },
    { ...common, claim: "hidden-control-secret", holdout: true },
    { ...common, claim: "already met", met: true },
  ] }));
  assert.equal(input.reviewFailureEvidence?.length, 1);
  assert.equal(input.reviewFailureEvidence![0]!.reason.length, 600);
  assert.equal(input.reviewFailureEvidence![0]!.output?.length, 600);
  assert.equal(input.reviewFailureEvidence![0]!.loadError?.length, 600);
  assert.doesNotMatch(JSON.stringify(input), /hidden-control-secret|already met/);
  assert.equal(buildBase(facts()).reviewFailureEvidence, undefined, "legacy CI-only inputs retain their identity");
});

test("a changed semantic diagnosis cannot reuse a progress verdict behind an unchanged excerpt", async () => {
  const criterion = { claim: "preserve literal", proof: "unit test: literal", met: false, proof_exec: "executed_pass" };
  const input = (suffix: string) => buildBase(facts({ reviewFailures: [{ ...criterion, reason: "r".repeat(600) + suffix }] }));
  const first = input("old finding"), changed = input("new finding");
  assert.equal(first.reviewFailureEvidence?.length, 1, "the diagnosis is present before testing its cache identity");
  assert.equal(first.reviewFailureEvidence![0]!.reason, changed.reviewFailureEvidence![0]!.reason,
    "the bounded excerpt alone cannot distinguish the diagnoses");
  const rows: Record<string, unknown>[] = [];
  let calls = 0;
  const opts = { reviewInputDigest: "exact-input", contractRevision: "exact-contract", judge: async () => {
    calls++; return { verdict: "continue" as const, reason: "controlled judgment" }; } };
  const result = await resolveFixProgress(first, rows, opts);
  rows.push({ ...result.receipt, ...result.decision, pr_number: first.prNumber, head_sha: first.headSha,
    ts: "2026-01-01T00:00:00.000Z" });
  assert.equal((await resolveFixProgress(first, rows, opts)).receipt.step, "fix.progress_reused");
  assert.equal(calls, 1);
  assert.equal((await resolveFixProgress(changed, rows, opts)).receipt.step, "fix.progress_judged");
  assert.equal(calls, 2, "new full evidence earns a new judgment, not an inherited continue");
});
