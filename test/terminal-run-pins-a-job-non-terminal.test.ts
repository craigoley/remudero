import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  DISPOSITION_RULES,
  deriveDisposition,
  stalledRunReason,
  type OpenPrView,
  type WorkflowRunObservation,
} from "../src/lib/sweep.js";

/**
 * W1-T2340 — the `followUpFiled` shard for W1-T2327's falsified criterion 1. Corrected
 * discriminator: a job whose STATUS is non-terminal inside a run whose CONCLUSION is terminal —
 * not an absence of jobs, which measurement on #2974 falsified (four `startup_failure` runs
 * scheduled SIX jobs between them, three already green). A check-runs read alone never exposes a
 * run's own conclusion; {@link stalledRunReason} is the join over the run listing that does.
 */

function basePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/craigoley/remudero/pull/1",
    headSha: "abcdef0123456789abcdef0123456789abcdef01",
    lastActivityAt: "2026-08-27T00:00:00Z",
    reviewState: "none",
    checksState: "pending",
    ...over,
  } as OpenPrView;
}

function run(over: Partial<WorkflowRunObservation> = {}): WorkflowRunObservation {
  return { conclusion: "success", jobs: [{ status: "completed" }], ...over };
}

// ── acceptance 1 — a job pinned non-terminal inside a terminal run reads stalled, not pending ──

test("stalledRunReason: a job still \"queued\" inside a run whose conclusion is \"startup_failure\" is named — the #2974 shape", () => {
  const runs: WorkflowRunObservation[] = [run({ conclusion: "startup_failure", jobs: [{ status: "queued" }] })];
  const reason = stalledRunReason(runs);
  assert.notEqual(reason, undefined, "a job pinned non-terminal by a concluded run must be named");
  assert.match(reason ?? "", /startup_failure/);
});

test("deriveDisposition: a pending PR carrying that stalled run escalates as blocked-ambiguous, reason says 'stalled, not pending'", () => {
  const pr = basePr({
    checksState: "pending",
    workflowRuns: [run({ conclusion: "startup_failure", jobs: [{ status: "queued" }] })],
  });
  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, Date.parse("2026-08-27T00:00:00Z"));
  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /stalled, not pending/);
});

// ── acceptance 2 — a terminal run with every job terminal keeps today's reading ─────────────────

test("stalledRunReason: a run whose conclusion is terminal AND every job is completed reports nothing — unchanged", () => {
  const runs: WorkflowRunObservation[] = [run({ conclusion: "success", jobs: [{ status: "completed" }, { status: "completed" }] })];
  assert.equal(stalledRunReason(runs), undefined);
});

test("deriveDisposition: that same fully-concluded head does NOT hit the new row — falls through to the ordinary pending machinery", () => {
  const pr = basePr({
    checksState: "pending",
    workflowRuns: [run({ conclusion: "success", jobs: [{ status: "completed" }] })],
  });
  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, Date.parse("2026-08-27T00:00:00Z"));
  assert.doesNotMatch(result.reason, /stalled, not pending/);
});

// ── acceptance 3 — no threshold: the function reads only the run listing, no policy/now clock ───

test("stalledRunReason: takes exactly one parameter — no policy, no now, no ceiling to tune", () => {
  assert.equal(stalledRunReason.length, 1, "a concluded run cannot become 'more concluded' with time — there is nothing to wait out");
});

test("stalledRunReason: the SAME stuck-job input reports identically however far apart it is called — no clock, no accumulating state", () => {
  const runs: WorkflowRunObservation[] = [run({ conclusion: "cancelled", jobs: [{ status: "in_progress" }] })];
  const first = stalledRunReason(runs);
  const second = stalledRunReason(runs);
  assert.equal(first, second);
  assert.notEqual(first, undefined);
});

// ── acceptance 4 — a job non-terminal inside a run still in progress is untouched ───────────────

test("stalledRunReason: a job still \"queued\" inside a run with NO conclusion yet (still running) is not named — work in flight reads as in flight", () => {
  const runs: WorkflowRunObservation[] = [run({ conclusion: undefined, jobs: [{ status: "queued" }] })];
  assert.equal(stalledRunReason(runs), undefined);
});

test("stalledRunReason: an empty-string conclusion is treated the same as undefined — still in progress", () => {
  const runs: WorkflowRunObservation[] = [run({ conclusion: "", jobs: [{ status: "in_progress" }] })];
  assert.equal(stalledRunReason(runs), undefined);
});

// ── acceptance 5 — the join reads the run listing; a check-runs-shaped read alone cannot see it ─

test("stalledRunReason: undefined runs (the run listing could not be fetched) reports nothing — fails toward not-stalled, never invents a stall", () => {
  assert.equal(stalledRunReason(undefined), undefined);
});

test("stalledRunReason: the discriminator needs the RUN's own conclusion, a field no check-runs rollup entry carries — the SAME job status alone (no conclusion given) never trips it", () => {
  // The only way to trip this function is to supply the run-level `conclusion` field — a
  // check-runs-only reader has no such field to hand it, so it can never see this shape.
  const noConclusion: WorkflowRunObservation[] = [{ jobs: [{ status: "queued" }] }];
  const withConclusion: WorkflowRunObservation[] = [{ conclusion: "failure", jobs: [{ status: "queued" }] }];
  assert.equal(stalledRunReason(noConclusion), undefined);
  assert.notEqual(stalledRunReason(withConclusion), undefined);
});

// ── acceptance 6 — a cancelled or abandoned run pinning a job is caught too, not only startup_failure ─

test("stalledRunReason: conclusion \"cancelled\" pinning a job is named, not only \"startup_failure\"", () => {
  const runs: WorkflowRunObservation[] = [run({ conclusion: "cancelled", jobs: [{ status: "in_progress" }] })];
  assert.notEqual(stalledRunReason(runs), undefined);
});

test("stalledRunReason: an arbitrary/abandoned terminal conclusion (e.g. \"failure\") pinning a job is named too — the join does not special-case one conclusion string", () => {
  const runs: WorkflowRunObservation[] = [run({ conclusion: "failure", jobs: [{ status: "waiting" }] })];
  assert.notEqual(stalledRunReason(runs), undefined);
});

test("stalledRunReason: multiple runs — an EARLIER healthy, fully-terminal run does not mask a LATER one pinning a job", () => {
  const runs: WorkflowRunObservation[] = [
    run({ conclusion: "success", jobs: [{ status: "completed" }] }),
    run({ conclusion: "cancelled", jobs: [{ status: "queued" }] }),
  ];
  const reason = stalledRunReason(runs);
  assert.notEqual(reason, undefined);
  assert.match(reason ?? "", /cancelled/);
});

// ── acceptance 7 — nothing added paces, throttles or sleeps a call ──────────────────────────────

test("stalledRunReason: returns synchronously — not a Promise, so nothing awaits/sleeps inside it", () => {
  const runs: WorkflowRunObservation[] = [run({ conclusion: "cancelled", jobs: [{ status: "queued" }] })];
  const result = stalledRunReason(runs);
  assert.equal(typeof result, "string", "a synchronous return is a plain string, never a Promise to await");
});

test("stalledRunReason: schedules no timer of its own — global setTimeout/setInterval call counts are unchanged across the call", () => {
  let timeoutCalls = 0;
  let intervalCalls = 0;
  const realTimeout = global.setTimeout;
  const realInterval = global.setInterval;
  // @ts-expect-error — instrumenting for the duration of this one assertion only
  global.setTimeout = (...args: unknown[]) => {
    timeoutCalls++;
    // @ts-expect-error node:test's global typings don't need to match exactly here
    return realTimeout(...args);
  };
  // @ts-expect-error — instrumenting for the duration of this one assertion only
  global.setInterval = (...args: unknown[]) => {
    intervalCalls++;
    // @ts-expect-error node:test's global typings don't need to match exactly here
    return realInterval(...args);
  };
  try {
    stalledRunReason([run({ conclusion: "startup_failure", jobs: [{ status: "queued" }] })]);
  } finally {
    global.setTimeout = realTimeout;
    global.setInterval = realInterval;
  }
  assert.equal(timeoutCalls, 0);
  assert.equal(intervalCalls, 0);
});

// ── the disposition row is ordered correctly relative to its neighbours ─────────────────────────

test("DISPOSITION_RULES: the stalled-run row is ordered BEFORE the datable checks-pending WAIT row — named immediately, never waiting out the pending ceiling", () => {
  const stalledIdx = DISPOSITION_RULES.findIndex((r) => {
    const pr = basePr({ checksState: "pending", workflowRuns: [run({ conclusion: "startup_failure", jobs: [{ status: "queued" }] })] });
    return r.when(pr, DEFAULT_SWEEP_POLICY, 0, Date.parse("2026-08-27T00:00:00Z"));
  });
  const waitIdx = DISPOSITION_RULES.findIndex((r) => {
    const pr = basePr({ checksState: "pending", checksPendingSince: "2026-08-26T23:59:00Z" } as Partial<OpenPrView>);
    return r.when(pr, DEFAULT_SWEEP_POLICY, 0, Date.parse("2026-08-27T00:00:00Z"));
  });
  assert.ok(stalledIdx >= 0, "the stalled-run row must match its own fixture");
  assert.ok(waitIdx >= 0, "the datable-pending WAIT row must match its own fixture");
  assert.ok(stalledIdx < waitIdx, "stalled-run row must be ordered before the WAIT row");
});
