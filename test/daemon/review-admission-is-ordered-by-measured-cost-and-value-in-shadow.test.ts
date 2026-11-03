import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOpenPrViewsAsync } from "#src/lib/tick-read-worker.js";
import {
  needsPersonPredicate, needsPersonToMerge, orderPendingReviews, orderPendingReviewsNeedsPersonLast, reviewHistoryFromLedger, reviewOrderShadow,
  reviewPriority, selectReviewAdmissions,
} from "#src/lib/sweep.js";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, runSweepLightPass, type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";

// W1-T11153. Measured by W1-T10992's recon (#16312): the oldest-first review head could not merge without a person
// in 333 of 709 light passes and took the only slot in 40 of them; refills used a snapshot a median 16.3 min old.

const NOW = Date.parse("2026-11-03T02:00:00Z");
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function eventually(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(message);
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function pr(n: number, minutesOld: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: `head-${n}`, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    createdAt: new Date(NOW - 60_000 * minutesOld).toISOString(),
    ...over,
  };
}

/** The sweep's own record that it filed a needs-human question about this PR at this head. */
function escalatedAt(view: OpenPrView): Record<string, unknown> {
  return { step: "sweep.disposed", pr_number: view.prNumber, head_sha: view.headSha, acted: true,
    disposition: "blocked-ambiguous", reason: "fix report requests a scope amendment: src/run-task.ts",
    ts: new Date(NOW - 30 * 60_000).toISOString() };
}

const oneLane = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };

test("a review that needs a person is admitted only after every eligible review that does not", () => {
  const held = pr(1, 300);
  const ready = pr(2, 10);
  const ledger = [escalatedAt(held)];
  assert.match(needsPersonToMerge(held, ledger) ?? "", /needs-human escalation is open at head head-1/);
  assert.equal(needsPersonToMerge(ready, ledger), undefined);

  const needsPerson = needsPersonPredicate(ledger);
  const picked = selectReviewAdmissions([held, ready], oneLane, NOW, undefined, 1, undefined, needsPerson).spawning;
  assert.deepEqual(picked.map((p) => p.prNumber), [2], "the mergeable review takes the only slot");
  assert.deepEqual(selectReviewAdmissions([held, ready], oneLane, NOW, undefined, 1).spawning.map((p) => p.prNumber), [1],
    "positive control: oldest-first alone picks the head that needs a person");
  assert.deepEqual(selectReviewAdmissions([held], oneLane, NOW, undefined, 1, undefined, needsPerson).spawning.map((p) => p.prNumber), [1],
    "with nothing else eligible it is admitted as today");
  assert.deepEqual(orderPendingReviewsNeedsPersonLast([{ pr: held }, { pr: ready }], needsPerson).map((job) => job.pr.prNumber), [2, 1],
    "the full pass orders the same way");
  assert.deepEqual(orderPendingReviews([{ pr: held }, { pr: ready }]).map((job) => job.pr.prNumber), [1, 2],
    "the predicate-free order is still oldest-first");
});

test("a standing CHANGES_REQUESTED at the head needs a person; an answered escalation or another head does not", () => {
  const held = pr(3, 100, { reviewQueueHold: { kind: "changes-requested", headSha: "head-3",
    holds: [{ login: "cao825", reviewId: 7, commitId: "head-3", submittedAt: "" }] } });
  assert.match(needsPersonToMerge(held, []) ?? "", /CHANGES_REQUESTED review from cao825/);
  const reviewedHeld = pr(6, 100, { scannerBlocker: { ...held.reviewQueueHold!, headSha: "head-6" } as OpenPrView["scannerBlocker"] });
  assert.match(needsPersonToMerge(reviewedHeld, []) ?? "", /CHANGES_REQUESTED review from cao825/,
    "an already-reviewed PR's scanner-read hold counts the same");
  const moved = pr(4, 100);
  assert.equal(needsPersonToMerge(moved, [{ ...escalatedAt(moved), head_sha: "older-head" }]), undefined,
    "an escalation at an older head says nothing about this one");
  const answered = pr(5, 100, { pendingAnswer: { constraint: "re-dispatch with the reviewer's notes" } });
  assert.equal(needsPersonToMerge(answered, [escalatedAt(answered)]), undefined, "an unspent operator answer releases it");
});

/** The production (async) view producer the light pass reads, over one green PR awaiting review, with the given review listing. */
async function producedReviewQueueView(reviews: unknown[]): Promise<{ view: OpenPrView; reviewReads: number }> {
  const head = "c0ffee0000000000000000000000000000000001";
  const url = "https://github.com/craigoley/remudero/pull/16500";
  let reviewReads = 0;
  const fetch = (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/pulls\?state=open/.test(path)) {
      return [{ number: 16500, html_url: url, head: { ref: "run-W1-T1-1", sha: head }, created_at: "2026-11-02T20:00:00Z",
        updated_at: "2026-11-02T21:00:00Z", body: "Remudero-Task: W1-T1", auto_merge: null, draft: false, state: "open" }];
    }
    if (path.includes("/check-runs")) {
      return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success", started_at: "2026-11-02T20:10:00Z", completed_at: "2026-11-02T20:20:00Z" }] };
    }
    if (path.endsWith(`/commits/${head}/status`)) return { statuses: [] };
    if (path.endsWith("/pulls/16500")) return { mergeable: true, mergeable_state: "blocked", head: { sha: head } };
    if (path.includes("/pulls/16500/reviews")) { reviewReads++; return reviews; }
    return [];
  };
  const dir = mkdtempSync(join(tmpdir(), "rmd-review-queue-hold-"));
  try {
    const path = join(dir, "rows.ndjson");
    writeFileSync(path, "");
    const views = await buildOpenPrViewsAsync("craigoley", "remudero", path, {
      fetchAsync: async (args) => fetch(args), readRequiredContextsAsync: async () => ["ci-gate"],
      readMainPlan: () => ({ tasks: [], byId: new Map() }),
    });
    assert.equal(views.length, 1);
    return { view: views[0], reviewReads };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the open-PR read takes a review-queue PR's human CHANGES_REQUESTED hold, which no other read covers", async () => {
  const changesRequested = { id: 9, state: "CHANGES_REQUESTED", commit_id: "older", submitted_at: "2026-11-02T20:30:00Z",
    user: { login: "cao825", type: "User" } };
  const { view, reviewReads } = await producedReviewQueueView([changesRequested]);
  assert.equal(view.checksState, "green");
  assert.notEqual(view.reviewState, "success");
  assert.equal(view.scannerBlocker, undefined, "the scanner read covers only reviewed PRs");
  assert.equal(reviewReads, 1);
  assert.equal(view.reviewQueueHold?.kind, "changes-requested");
  assert.match(needsPersonToMerge(view, []) ?? "", /CHANGES_REQUESTED review from cao825/);

  const approved = (await producedReviewQueueView([{ ...changesRequested, state: "APPROVED" }])).view;
  assert.equal(approved.reviewQueueHold, undefined, "positive control: no standing hold, nothing to queue behind");
  assert.equal(needsPersonToMerge(approved, []), undefined);
  const bot = (await producedReviewQueueView([{ ...changesRequested, user: { login: "remudero-fleet[bot]", type: "Bot" } }])).view;
  assert.equal(bot.reviewQueueHold, undefined, "a bot's review is never a person's hold");
});

test("a light pass names why a review that needs a person was queued behind the others", async () => {
  const held = pr(1, 300);
  const ready = pr(2, 10);
  const rows: Record<string, unknown>[] = [];
  const started: number[] = [];
  const release = gate();
  const deps: SweepDeps = {
    ledgerPath: "/unused", runId: "needs-person", now: () => NOW,
    readLedger: () => [escalatedAt(held)], appendLine: (_p, row) => { rows.push(row as Record<string, unknown>); },
    readActiveWorkerCount: () => 0, arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (p) => { started.push(p.prNumber); await release.promise; },
  };
  try {
    await runSweepLightPass([held, ready], deps, oneLane);
    await eventually(() => started.length === 1, "no review started");
    assert.deepEqual(started, [2]);
    const disposed = rows.find((r) => r.step === "sweep.disposed" && r.pr_number === 1);
    assert.match(String(disposed?.stand_down_reason), /queued behind reviews that need no person: a needs-human escalation/);
  } finally {
    release.resolve();
    await drainInFlightReviews({ boundMs: 1000 });
  }
});

test("W1-T11153 criterion 2: a refill re-reads the open PRs, so a review that became eligible after the snapshot is not jumped", async () => {
  let clock = NOW;
  const first = pr(1, 50);
  const younger = pr(2, 20);
  const lateOlder = pr(3, 90); // older by its admission key, eligible only after the pass-start snapshot
  const rows: Record<string, unknown>[] = [];
  const started: number[] = [];
  const holds = new Map<number, ReturnType<typeof gate>>();
  const hold = (n: number) => { if (!holds.has(n)) holds.set(n, gate()); return holds.get(n)!; };
  let reads = 0;
  const deps: SweepDeps = {
    ledgerPath: "/unused", runId: "fresh-refill", now: () => clock,
    readLedger: () => [], appendLine: (_p, row) => { rows.push(row as Record<string, unknown>); },
    readActiveWorkerCount: () => 0, arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (p) => { started.push(p.prNumber); await hold(p.prNumber).promise; },
    readOpenPrsForRefill: async () => { reads++; return [first, younger, lateOlder]; },
  };
  try {
    // The late PR is absent from the pass-start snapshot (it was opened, or left draft, after the read).
    await runSweepLightPass([first, younger], deps, oneLane);
    await eventually(() => started.length === 1, "no review started");
    assert.deepEqual(started, [1]);
    clock = NOW + 30_000; // seconds after the snapshot: the refill still reads the queue at refill time
    hold(1).resolve();
    await eventually(() => started.length === 2, "the freed lane stayed empty");
    assert.deepEqual(started, [1, 3], "the late-eligible older PR is admitted ahead of the younger one");
    assert.equal(reads, 1);
    const refilled = rows.find((r) => r.step === "sweep.review_refilled");
    assert.equal(refilled?.pr_number, 3);
    assert.equal(refilled?.view_age_ms, 0, "the refill row records the age of the view it used");
    assert.equal(refilled?.snapshot_age_ms, 30_000);
  } finally {
    for (const n of [1, 2, 3]) hold(n).resolve();
    await drainInFlightReviews({ boundMs: 1000 });
  }
});

test("a refill keeps its view when the re-read fails, and does not retry GitHub for the rest of the pass", async () => {
  let clock = NOW;
  const rows: Record<string, unknown>[] = [];
  const logged: string[] = [];
  const started: number[] = [];
  const holds = new Map<number, ReturnType<typeof gate>>();
  const hold = (n: number) => { if (!holds.has(n)) holds.set(n, gate()); return holds.get(n)!; };
  let reads = 0;
  const deps: SweepDeps = {
    ledgerPath: "/unused", runId: "refill-reuse", now: () => clock,
    readLedger: () => [], appendLine: (_p, row) => { rows.push(row as Record<string, unknown>); },
    log: (step) => { logged.push(step); },
    readActiveWorkerCount: () => 0, arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (p) => { started.push(p.prNumber); await hold(p.prNumber).promise; },
    readOpenPrsForRefill: async () => { reads++; throw new Error("gh read failed"); },
  };
  try {
    await runSweepLightPass([pr(1, 50), pr(2, 40), pr(3, 30)], deps, oneLane);
    await eventually(() => started.length === 1, "no review started");
    clock = NOW + 30_000;
    hold(1).resolve();
    await eventually(() => started.length === 2, "the freed lane stayed empty");
    assert.equal(reads, 1, "the refill read the queue at refill time");
    assert.ok(logged.includes("sweep.review_refill.view_unreadable"));
    clock = NOW + 120_000;
    hold(2).resolve();
    await eventually(() => started.length === 3, "a failed re-read left the lane empty");
    assert.deepEqual(started, [1, 2, 3], "the refills run from the older view");
    assert.equal(reads, 1, "one failed read is not retried once per refill");
    const refilled = rows.filter((r) => r.step === "sweep.review_refilled");
    assert.deepEqual(refilled.map((r) => r.view_age_ms), [30_000, 120_000], "the rows show the older view's age");
  } finally {
    for (const n of [1, 2, 3]) hold(n).resolve();
    await drainInFlightReviews({ boundMs: 1000 });
  }
});

function reviewed(n: number, head: string, startMin: number, minutes: number, state: "success" | "failure",
  proofs: number, planOnly = false): Record<string, unknown>[] {
  const url = `https://github.com/o/r/pull/${n}`;
  return [
    { step: "review.pending_posted", pr_url: url, head_sha: head, ts: new Date(NOW - startMin * 60_000).toISOString() },
    { step: "review.posted", pr_url: url, head_sha: head, state, decision_verdict: { planOnly },
      proof_exec: Array.from({ length: proofs }, () => "pass"), ts: new Date(NOW - (startMin - minutes) * 60_000).toISOString() },
  ];
}
const body = (proofs: number) => "Acceptance:\n" + Array.from({ length: proofs }, (_, i) => `- claim ${i} | grep: x${i} in src/a.ts`).join("\n");

test("W1-T11153 criterion 3: the shadow order ranks measured value per lane-minute plus aged wait, and never decides a pick", async () => {
  const ledger = [
    ...reviewed(101, "a", 600, 0.5, "success", 1), ...reviewed(102, "a", 590, 0.5, "success", 1),
    ...reviewed(103, "a", 580, 20, "failure", 6), ...reviewed(103, "b", 500, 20, "failure", 6),
    ...reviewed(104, "a", 480, 20, "success", 6), ...reviewed(105, "a", 400, 1, "success", 0, true),
    { step: "sweep.disposed", pr_number: 103, pr_url: "https://github.com/o/r/pull/103", loop_decision: { route: "close-and-rebuild" } },
  ];
  const history = reviewHistoryFromLedger(ledger);
  assert.equal(history.episodes.length, 6);
  assert.equal(history.failsByPrUrl.get("https://github.com/o/r/pull/103"), 2);
  const heavy = pr(103, 35, { body: body(6) }); // older, slow class, two prior FAILs, close-and-rebuild route
  const light = pr(106, 30, { body: body(1) }); // younger, fast class, no FAILs
  const heavyTerms = reviewPriority(heavy, history, NOW)!;
  const lightTerms = reviewPriority(light, history, NOW)!;
  assert.ok(heavyTerms.cost_ms > lightTerms.cost_ms, JSON.stringify([heavyTerms, lightTerms]));
  assert.ok(lightTerms.value > heavyTerms.value);
  assert.equal(heavyTerms.wait_ms, 35 * 60_000);

  const shadow = reviewOrderShadow([heavy, light], [heavy], history, NOW, 1);
  assert.deepEqual(shadow.actual, [103]);
  assert.deepEqual(shadow.shadow, [106], "the cost/value order would pick the cheap, likely PASS first");
  assert.equal(shadow.terms.length, 2);
  assert.equal(shadow.would_wait_ms["106"], 0);
  assert.equal(shadow.would_wait_ms["103"], lightTerms.cost_ms);

  const unknown = reviewOrderShadow([heavy, light], [heavy], reviewHistoryFromLedger([]), NOW, 1);
  assert.deepEqual(unknown.shadow, [103], "with no history for a class the shadow order equals the actual order");
  const newestFirst = reviewOrderShadow([light, heavy], [heavy], reviewHistoryFromLedger([]), NOW, 1);
  assert.deepEqual(newestFirst.shadow, [103], "it follows the actual picks, not the order the candidates were listed in");
  assert.deepEqual(newestFirst.would_wait_ms, { "103": 0, "106": 0 });
  const twoLanes = reviewOrderShadow([light, heavy], [heavy, light], reviewHistoryFromLedger([]), NOW, 2);
  assert.deepEqual(twoLanes.shadow, [103, 106]);

  // In a light pass the row is written beside the actual pick, and the pick is still oldest-first.
  const rows: Record<string, unknown>[] = [];
  const started: number[] = [];
  const release = gate();
  const deps: SweepDeps = {
    ledgerPath: "/unused", runId: "shadow", now: () => NOW,
    readLedger: () => ledger, appendLine: (_p, row) => { rows.push(row as Record<string, unknown>); },
    readActiveWorkerCount: () => 0, arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (p) => { started.push(p.prNumber); await release.promise; },
  };
  try {
    await runSweepLightPass([heavy, light], deps, oneLane);
    await eventually(() => started.length === 1, "no review started");
    assert.deepEqual(started, [103], "the shadow order never decides a pick");
    const row = rows.find((r) => r.step === "sweep.review_order_shadow");
    assert.deepEqual(row?.actual, [103]);
    assert.deepEqual(row?.shadow, [106]);
    assert.equal(row?.width, 1);
  } finally {
    release.resolve();
    await drainInFlightReviews({ boundMs: 1000 });
  }
});
