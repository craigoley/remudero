import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HOST_GAP_REREVIEW_STEP, REFUSED_POST_HOST_GAP_REREVIEW_STEP,
  hostGapProgressInput, hostGapRereviewFacts, hostGapRereviewWaitMs, planHostGapRereview, runSweep,
  type OpenPrView, type SweepDeps,
} from "@/lib/sweep.js";
import { reviewOptionFlags, reviewOptionsFromFlags } from "@/run-task.js";

const MIN = 60_000, NOW = Date.parse("2026-10-19T12:00:00Z");
const at = (ago: number): string => new Date(NOW - ago * MIN).toISOString();
const HEAD = "a".repeat(40), DIGEST = "v2:current-input", URL = "https://github.com/acme/remudero/pull/10221";
const id = (n: number): string => `review-PR10221-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pr = (): OpenPrView => ({ prNumber: 10221, prUrl: URL, taskId: "W1-T10221", headSha: HEAD,
  headRefName: "run-W1-T10221-1", reviewInputDigest: DIGEST, checksState: "green", reviewState: "success",
  unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: at(50), ciFailures: [] });
const criterion = { claim: "proof", proof: "unit test: an actual title", met: true,
  reason: "host unavailable", proof_exec: "not_executable", proof_skip: "runner-absent" };
const admitted = (n: number, ago: number, hostGap: boolean): Record<string, unknown> => ({
  ts: at(ago), step: "sweep.review_admitted", run_id: "one-daemon-run", task_id: "W1-T10221",
  pr_number: 10221, pr_url: URL, head_sha: HEAD, review_input_digest: DIGEST,
  review_run_id: id(n), host_gap_rereview: hostGap, skips: ["runner-absent"],
});
const posted = (n: number, ago: number): Record<string, unknown> => ({
  ts: at(ago), step: "review.posted", run_id: id(n), task_id: "W1-T10221", pr_url: URL,
  head_sha: HEAD, review_input_digest: DIGEST, state: "success", capped: true, plan_only: false,
  decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [criterion] },
});
const request = (ago: number, ordinal = 1, step = HOST_GAP_REREVIEW_STEP): Record<string, unknown> => ({
  ts: at(ago), step, run_id: "one-daemon-run", task_id: "W1-T10221", pr_number: 10221,
  pr_url: URL, head_sha: HEAD, review_input_digest: DIGEST, review_key: `${URL}@${HEAD}`,
  rereview_ordinal: ordinal, skips: ["runner-absent"], host_gap: "runner-absent",
});
const baseline = (): Record<string, unknown>[] => [admitted(0, 40, false), posted(0, 30)];
const state = (facts: ReturnType<typeof hostGapRereviewFacts>) => ({ history: facts.history,
  skips: ["runner-absent"], lastReviewAtMs: facts.lastReviewAtMs, observedReviewMs: facts.observedReviewMs ?? 10 * MIN,
  nowMs: NOW });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test("denied and duplicate host-gap requests are not completed review rounds", async () => {
  const rows = [...baseline(), request(20), request(19), request(5, 2),
    { ts: at(4), step: "sweep.disposed", run_id: "one-daemon-run", task_id: "W1-T10221", pr_number: 10221,
      head_sha: HEAD, disposition: "post-review", acted: false,
      stand_down_reason: "not admitted this pass: semantic post-review admission bound 0" }];
  for (const marker of [HOST_GAP_REREVIEW_STEP, REFUSED_POST_HOST_GAP_REREVIEW_STEP]) {
    const inputRows = rows.map(r => r.step === HOST_GAP_REREVIEW_STEP ? { ...r, step: marker } : r);
    const facts = hostGapRereviewFacts(pr(), inputRows);
    assert.equal(facts.history.length, 0, "request demand is not admitted/completed work, on either route");
    assert.equal(facts.observedReviewMs, 10 * MIN, "a denied request cannot become a review start");
    const input = hostGapProgressInput(pr(), state(facts));
    assert.equal(input.rounds.length, 0);
    assert.equal(input.strikesSpent, 0);
    assert.equal(input.signals.noOpRounds, 0);
    assert.equal((await planHostGapRereview(state(facts), { input })).kind, "rereview");
  }
});

test("admitted host-gap attempts grow pacing once and preserve live ownership", async () => {
  const first = admitted(1, 20, true), second = admitted(2, 20, true);
  const rows = [...baseline(), request(25), first, posted(1, 16), { ...first }, posted(1, 16),
    request(24), second, posted(2, 15)];
  const facts = hostGapRereviewFacts(pr(), rows);
  assert.equal(facts.history.length, 2, "two distinct attempt IDs count even within one daemon run and timestamp");
  const input = hostGapProgressInput(pr(), state(facts));
  assert.equal(input.rounds.length, 2);
  assert.ok(input.rounds.every(r => r.completed === true));
  assert.equal(input.signals.noOpRounds, 2);
  assert.equal(hostGapRereviewWaitMs(facts.observedReviewMs!, 2), 30 * MIN);
  assert.equal((await planHostGapRereview(state(facts), { input })).kind, "hold");

  const liveRows = baseline(), entered = deferred(), release = deferred();
  let calls = 0, handedRunId: string | undefined;
  const deps: SweepDeps = { ledgerPath: "/unused/host-gap-attempts", runId: "one-daemon-run", now: () => NOW,
    readLedger: () => liveRows, appendLine: (_path, row) => { liveRows.push({ ts: at(0), ...row }); },
    postReview: async (_pr, _mode, runId?: string) => { calls++; handedRunId = runId; entered.resolve(); await release.promise; },
    dispatchFix: () => { throw Error("a host gap must not dispatch body repair"); },
    arm: () => { throw Error("a capped host gap must not arm"); },
    close: () => {}, escalate: () => {},
  };
  const running = runSweep([pr()], deps);
  try {
    await Promise.race([entered.promise, running.then(() => { throw Error("first review never reached its effect"); })]);
    assert.match(handedRunId ?? "", /^review-PR10221-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const again = await runSweep([pr()], { ...deps, runId: "another-daemon-pass" });
    assert.equal(calls, 1, "a live same-input review owns the slot; no second effect");
    assert.ok(again.actions.every(a => !a.acted));
    const admission = liveRows.find(r => r.step === "sweep.review_admitted");
    assert.equal(admission?.review_run_id, handedRunId);
    assert.equal(admission?.host_gap_rereview, true);
    const inFlight = hostGapProgressInput(pr(), state(hostGapRereviewFacts(pr(), liveRows)));
    assert.equal(inFlight.signals.noOpRounds, 0, "an admitted unfinished attempt is not a completed no-op");
    assert.equal(inFlight.signals.incompleteRounds, 1);
  } finally { release.resolve(); await running; }
});

test("host-gap history separates changed inputs and incomplete legacy evidence", () => {
  const rows = [...baseline(), request(25), admitted(1, 20, true), posted(1, 15)];
  assert.equal(hostGapRereviewFacts({ ...pr(), headSha: "b".repeat(40) }, rows).history.length, 0);
  assert.equal(hostGapRereviewFacts({ ...pr(), reviewInputDigest: "v2:different-input" }, rows).history.length, 0);
  assert.deepEqual(hostGapRereviewFacts(pr(), [...rows].reverse()), hostGapRereviewFacts(pr(), rows),
    "request append order is not attempt attribution");
  const legacy = hostGapRereviewFacts(pr(), [request(20), { ...admitted(1, 19, true), review_run_id: undefined }, posted(1, 15)]);
  assert.equal(legacy.history.length, 0);
  assert.equal((legacy as unknown as { attribution: { state: string } }).attribution.state, "incomplete");
  const unfinished = hostGapRereviewFacts(pr(), [admitted(2, 10, true)]);
  const input = hostGapProgressInput(pr(), state(unfinished));
  assert.equal(input.rounds.filter(r => r.completed).length, 0);
  assert.equal(input.signals.noOpRounds, 0);
  assert.equal(input.signals.incompleteRounds, 1);

  const options = reviewOptionsFromFlags(["--execution-mode", "semantic", "--review-attempt-run-id", id(3)]);
  assert.equal((options as unknown as { reviewAttemptRunId?: string }).reviewAttemptRunId, id(3));
  const flags = reviewOptionFlags(options);
  assert.equal(flags[flags.indexOf("--review-attempt-run-id") + 1], id(3), "fresh-tree review keeps the admitted identity");
  assert.equal((reviewOptionsFromFlags(["--review-attempt-run-id", "review-PR10221-../../bad"]) as unknown as { reviewAttemptRunId?: string }).reviewAttemptRunId,
    undefined, "an unbounded/path-shaped identity is not attribution");
});
