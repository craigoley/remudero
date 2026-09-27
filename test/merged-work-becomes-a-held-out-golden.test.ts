import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyCriterionDiscrimination,
  deriveGoldenCorpus,
  goldenTaskFromCorpusItem,
  heldOutLeaks,
  mergeCreditsFromLedger,
  scoreCorpusReplay,
  type GoldenCorpusItem,
  type MergeCredit,
} from "../src/lib/golden-corpus.js";
import { REPLAY_CORPUS_BOUND, drawReplaySample, replayIdleGate } from "../src/lib/replay-harness.js";
import { SEEDED_GOLDENS } from "../src/lib/replay.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";

// ── W1-T4619 ──────────────────────────────────────────────────────────────────────────────────
//
// MEASURED: review.posted records per-criterion proof_exec with W1-T362 merge-base discrimination
// for every PR, so every merged task whose proofs FAILED at base and PASSED at head is a graded,
// dated, repository-specific item with an executable scorer — and the golden-replay leg's corpus
// was three hand-seeded goldens. These tests pin the derivation (only fully-discriminating merged
// work enters), the hold-out (the scorer never reaches a dispatch), the scoring rule (unmeasurable
// is never a pass) and the idle-only gate (replay never competes with dispatch).

const DISCRIMINATES =
  "proof executed and PASSED on the PR head (test: x) — NOTE: also re-run against the PR's merge-base and did NOT pass there " +
  "(absent, no-match, or a genuine failure); the proof discriminates, executed_pass stands";
const BASE_UNKNOWN =
  "proof executed and PASSED on the PR head (test: x) — NOTE: re-run against the PR's merge-base for staleness could not complete " +
  "(base_unknown, an environment gap: the base run itself could not execute); executed_pass stands, downgrade withheld — no discrimination was measured";
const GREP_PASS = "proof executed and PASSED on the PR head (grep: foo( in src/lib/x.ts)";

interface Crit {
  proof: string;
  proof_exec: string;
  reason: string;
  holdout?: boolean;
}

function reviewLine(taskId: string, ts: string, criteria: Crit[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts,
    step: "review.posted",
    task_id: taskId,
    state: "success",
    head_sha: `head-${taskId}`,
    pr_url: `https://github.com/o/r/pull/${taskId.length}`,
    merge_base_sha: `base-${taskId}`,
    proof_exec: criteria.map((c) => c.proof_exec),
    decision_verdict: {
      state: "success",
      criteria: criteria.map((c, i) => ({ claim: `claim ${i} of ${taskId}`, met: true, ...c })),
    },
    ...extra,
  };
}

const testProof = (id: string): Crit => ({ proof: `unit test: test/${id}.test.ts`, proof_exec: "executed_pass", reason: DISCRIMINATES });
const grepProof = (id: string): Crit => ({ proof: `grep: ${id}Symbol( in src/lib/${id}.ts`, proof_exec: "executed_pass", reason: GREP_PASS });

const NOW = Date.parse("2026-09-27T00:00:00Z");
const credit = (mergedAt: string): MergeCredit => ({ mergedAt, source: "ledger" });

test("a merged task whose EVERY executable proof failed at base and passed at head enters the dated held-out corpus", () => {
  const lines = [reviewLine("T-GOOD", "2026-09-20T10:00:00Z", [testProof("good"), grepProof("good")])];
  const merged = new Map([["T-GOOD", credit("2026-09-20T11:00:00Z")]]);
  const { items, excluded } = deriveGoldenCorpus({ reviewLines: lines, merged, nowMs: NOW });
  assert.deepEqual(excluded, []);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.taskId, "T-GOOD");
  assert.equal(item.baseSha, "base-T-GOOD", "the base sha is the merge-base the review measured discrimination against");
  assert.equal(item.headSha, "head-T-GOOD");
  assert.equal(item.mergedAt, "2026-09-20T11:00:00.000Z");
  assert.equal(item.heldOut, true);
  assert.deepEqual(
    item.proofs.map((p) => p.proof),
    ["unit test: test/good.test.ts", "grep: goodSymbol( in src/lib/good.ts"],
  );
  assert.equal(item.freshness.ageDays, 6, "freshness is dated from the merge, in whole days");
});

test("unmerged work, a stale proof, an unmeasurable proof, an unmeasured base or a missing merge base keeps a task OUT, each named", () => {
  const lines = [
    reviewLine("T-OPEN", "2026-09-20T10:00:00Z", [testProof("open")]),
    reviewLine("T-STALE", "2026-09-20T10:00:00Z", [testProof("stale"), { ...grepProof("stale"), proof_exec: "executed_stale" }]),
    reviewLine("T-PROSE", "2026-09-20T10:00:00Z", [testProof("prose"), { proof: "the thing works", proof_exec: "not_executable", reason: "prose" }]),
    reviewLine("T-BASEUNK", "2026-09-20T10:00:00Z", [{ ...testProof("baseunk"), reason: BASE_UNKNOWN }]),
    reviewLine("T-NOBASE", "2026-09-20T10:00:00Z", [testProof("nobase")], { merge_base_sha: undefined }),
    reviewLine("T-EMPTY", "2026-09-20T10:00:00Z", []),
    reviewLine("T-FAIL", "2026-09-20T10:00:00Z", [{ ...testProof("fail"), proof_exec: "executed_fail" }]),
  ];
  const merged = new Map(
    ["T-STALE", "T-PROSE", "T-BASEUNK", "T-NOBASE", "T-EMPTY", "T-FAIL", "T-NOREVIEW"].map((id) => [id, credit("2026-09-21T00:00:00Z")] as const),
  );
  const { items, excluded } = deriveGoldenCorpus({ reviewLines: lines, merged, nowMs: NOW });
  assert.deepEqual(items, [], "no partially-discriminating, unmeasurable or unmerged task may enter");
  const why = new Map(excluded.map((e) => [e.taskId, e.reason]));
  assert.equal(why.has("T-OPEN"), false, "an unmerged task is not a candidate at all — it is not a coverage gap");
  assert.match(why.get("T-STALE")!, /executed_stale/);
  assert.match(why.get("T-PROSE")!, /unmeasurable/);
  assert.match(why.get("T-BASEUNK")!, /no discrimination was measured/);
  assert.match(why.get("T-NOBASE")!, /merge base/);
  assert.match(why.get("T-EMPTY")!, /no criteria/);
  assert.match(why.get("T-FAIL")!, /executed_fail/);
  assert.match(why.get("T-NOREVIEW")!, /no review\.posted/);
});

test("the review judged is the last one posted at or before the merge, never a later re-review", () => {
  const lines = [
    reviewLine("T-LATE", "2026-09-20T09:00:00Z", [testProof("late")]),
    reviewLine("T-LATE", "2026-09-22T09:00:00Z", [{ ...testProof("late"), proof_exec: "executed_stale" }]),
  ];
  const merged = new Map([["T-LATE", credit("2026-09-20T10:00:00Z")]]);
  const { items } = deriveGoldenCorpus({ reviewLines: lines, merged, nowMs: NOW });
  assert.equal(items.length, 1);
});

test("classifyCriterionDiscrimination reads only recorded evidence", () => {
  assert.equal(classifyCriterionDiscrimination({ proof: "unit test: x", proof_exec: "executed_pass", reason: DISCRIMINATES }, true).discriminated, true);
  assert.equal(classifyCriterionDiscrimination({ proof: "unit test: x", proof_exec: "executed_pass", reason: BASE_UNKNOWN }, true).discriminated, false);
  assert.equal(classifyCriterionDiscrimination({ proof: "grep: a in b", proof_exec: "executed_pass", reason: GREP_PASS }, false).discriminated, false);
  assert.equal(classifyCriterionDiscrimination({ proof: "unit test: x", proof_exec: "exec_error", reason: "" }, true).discriminated, false);
});

test("the corpus is freshest-first, and post-cutoff freshness is recorded when a cutoff is given", () => {
  const lines = [
    reviewLine("T-OLD", "2026-08-01T00:00:00Z", [testProof("old")]),
    reviewLine("T-NEW", "2026-09-25T00:00:00Z", [testProof("new")]),
  ];
  const merged = new Map([
    ["T-OLD", credit("2026-08-01T01:00:00Z")],
    ["T-NEW", credit("2026-09-25T01:00:00Z")],
  ]);
  const { items } = deriveGoldenCorpus({ reviewLines: lines, merged, nowMs: NOW, trainingCutoff: "2026-09-01T00:00:00Z" });
  assert.deepEqual(items.map((i) => i.taskId), ["T-NEW", "T-OLD"]);
  assert.equal(items[0]!.freshness.postCutoff, true);
  assert.equal(items[1]!.freshness.postCutoff, false);
});

test("merge credit comes from the ledger's own credit rows, dated by the row", () => {
  const credits = mergeCreditsFromLedger([
    { ts: "2026-09-20T11:00:00Z", step: "verdict", verdict: "merged", task_id: "T-A" },
    { ts: "2026-09-21T11:00:00Z", step: "verdict.merged", task_id: "T-B" },
    { ts: "2026-09-21T11:00:00Z", step: "verdict", verdict: "blocked", task_id: "T-C" },
  ]);
  assert.deepEqual([...credits.keys()].sort(), ["T-A", "T-B"]);
  assert.equal(credits.get("T-A")!.mergedAt, "2026-09-20T11:00:00.000Z");
});

function goodItem(): GoldenCorpusItem {
  const lines = [reviewLine("T-GOOD", "2026-09-20T10:00:00Z", [testProof("good"), grepProof("good")])];
  const tasks = new Map([["T-GOOD", { type: "implement", verify: "auto", files: ["src/lib/good.ts", "test/good.test.ts"] }]]);
  return deriveGoldenCorpus({ reviewLines: lines, merged: new Map([["T-GOOD", credit("2026-09-20T11:00:00Z")]]), nowMs: NOW, tasks }).items[0]!;
}

test("a corpus item's scorer never enters what a replay dispatch sees", () => {
  const item = goodItem();
  const golden = goldenTaskFromCorpusItem(item);
  assert.ok(golden, "an item with a known task spec converts to a replayable golden");
  const dispatched = JSON.stringify(golden);
  for (const p of item.proofs) assert.equal(dispatched.includes(p.proof), false, `proof leaked into the dispatch: ${p.proof}`);
  assert.deepEqual(heldOutLeaks(dispatched, [item]), []);
  assert.deepEqual(heldOutLeaks(`worker prompt ... ${item.proofs[0]!.proof} ...`, [item]), ["T-GOOD"]);
});

test("scores are the task's own proofs, and a proof that cannot execute is unmeasurable, never a pass", () => {
  const item = goodItem();
  assert.equal(scoreCorpusReplay(item, ["pass", "pass"]).verdict, "pass");
  assert.equal(scoreCorpusReplay(item, ["pass", "fail"]).verdict, "fail");
  assert.equal(scoreCorpusReplay(item, ["pass", "unmeasurable"]).verdict, "unmeasurable");
  assert.equal(scoreCorpusReplay(item, ["pass"]).verdict, "unmeasurable", "a missing outcome is unmeasured, not a pass");
});

const HEADROOM: UsageSnapshot = { billingMode: "subscription", session: { percentUsed: 20 }, weekly: [{ label: "all models", percentUsed: 40 }] };
const QUIET = { state: "up" as const, quiet: true as const };

test("replay runs only when the fleet is idle (quiet mode) and headroom is measured", () => {
  assert.equal(replayIdleGate({ liveness: QUIET, headroom: HEADROOM }).enabled, true);
  assert.equal(replayIdleGate({ liveness: { state: "up" }, headroom: HEADROOM }).enabled, false, "a sweeping fleet is dispatching");
  assert.equal(replayIdleGate({ headroom: HEADROOM }).enabled, false, "unmeasured idleness is not idle");
  assert.equal(replayIdleGate({ liveness: QUIET }).enabled, false, "unmeasured headroom is not headroom");
  const spent: UsageSnapshot = { ...HEADROOM, session: { percentUsed: 99 } };
  assert.match(replayIdleGate({ liveness: QUIET, headroom: spent }).reason, /session/);
  assert.equal(replayIdleGate({ liveness: { state: "down", quiet: true }, headroom: HEADROOM }).enabled, false);
});

test("the bounded, opt-in replay draws its sample from the derived corpus, and seeded goldens still work", () => {
  const lines = ["A", "B", "C", "D"].map((id, i) => reviewLine(`T-${id}`, `2026-09-2${i}T00:00:00Z`, [testProof(id)]));
  const merged = new Map(["A", "B", "C", "D"].map((id, i) => [`T-${id}`, credit(`2026-09-2${i}T01:00:00Z`)] as const));
  const tasks = new Map(["A", "B", "C", "D"].map((id) => [`T-${id}`, { type: "implement", verify: "auto", files: [`src/${id}.ts`] }] as const));
  const idle = { liveness: QUIET, headroom: HEADROOM };
  const corpus = { reviewLines: lines, merged, nowMs: NOW, tasks };

  const refused = drawReplaySample({ argv: [], idle, source: { kind: "derived", corpus } });
  assert.equal(refused.enabled, false, "no spend by default: replay stays opt-in");
  assert.deepEqual(refused.goldens, []);

  const busy = drawReplaySample({ argv: ["--confirm-spend"], idle: { liveness: { state: "up" }, headroom: HEADROOM }, source: { kind: "derived", corpus } });
  assert.equal(busy.enabled, false);
  assert.deepEqual(busy.goldens, []);

  const drawn = drawReplaySample({ argv: ["--confirm-spend"], idle, source: { kind: "derived", corpus } });
  assert.equal(drawn.enabled, true);
  assert.equal(drawn.goldens.length, REPLAY_CORPUS_BOUND, "the sample is bounded");
  assert.deepEqual(drawn.goldens.map((g) => g.task.id), ["T-D", "T-C", "T-B"], "freshest first");
  assert.deepEqual(drawn.items.map((i) => i.taskId), ["T-D", "T-C", "T-B"], "each golden keeps its held-out scorer beside it");

  const seeded = drawReplaySample({ argv: ["--confirm-spend"], idle, source: { kind: "seeded" } });
  assert.equal(seeded.enabled, true);
  assert.deepEqual(seeded.goldens, SEEDED_GOLDENS.slice(0, REPLAY_CORPUS_BOUND));
});
