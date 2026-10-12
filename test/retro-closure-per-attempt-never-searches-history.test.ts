import assert from "node:assert/strict";
import { test } from "node:test";
import { closureByClass, mergeRateCell, renderClosureByClass } from "../src/lib/retro-closure.js";
import { buildGather, gatherRuns, parseLedger, shippedSince, type LedgerRecord, type ShippedGithub } from "../src/lib/retro.js";

const before = "2026-10-01T00:00:00.000Z";
const marker = "2026-10-01T02:00:00.000Z";
const after = "2026-10-01T03:00:00.000Z";
const url = "https://github.com/o/r/pull/12";

function ledger(rows: LedgerRecord[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

function attempt(runId: string, taskClass = "src", startTs = after) {
  return { runId, taskId: `W1-${runId}`, startTs, taskClass, verdict: "blocked_ci", costUsd: 2 };
}

test("W1-T5113: the closure rate is merges over dispatched attempts, not over the open backlog", () => {
  const runs = Array.from({ length: 10 }, (_, i) => attempt(`T${i}`));
  const shipped = runs.slice(0, 5).map(({ runId, taskId }) => ({ runId, taskId }));
  const [row] = closureByClass([...runs, attempt("T-old", "src", before)], shipped, Array(650).fill("src"), marker);
  assert.deepEqual(row.mergeRate, { kind: "rate", value: 0.5, merged: 5, denominator: 10 });
  assert.equal(row.open, 650);
  assert.equal(row.costPerMerge, 4);
  assert.equal(mergeRateCell(row.mergeRate), "0.5 (5 of 10 attempts)");
  assert.match(renderClosureByClass([row]), /5 of 10 attempts/);
  assert.deepEqual(closureByClass(runs, shipped, [], marker)[0].mergeRate, row.mergeRate);
});

test("W1-T5113: a merge inside the window is credited even when its run started before the window", () => {
  const rows: LedgerRecord[] = [
    { ts: before, run_id: "old", task_id: "W1-T-old", step: "run.start", type: "implement", task_class: "src" },
    { ts: before, run_id: "old", step: "verdict", verdict: "blocked_review", cost_usd: 9, pr_url: url },
    ...Array.from({ length: 5 }, (_, i) => ({ ts: after, run_id: `new-${i}`, task_id: `W1-T${i}`, step: "run.start", type: "implement", task_class: "src" })),
  ];
  const github = {
    findMergedByTrailer: (taskId: string) => taskId === "W1-T-old" ? { number: 12, url, mergedAt: after } : null,
    headRefName: () => "run-old",
    mergedCommits: () => [{ date: after, message: "feat: old\n\nRemudero-Task: W1-T-old" }],
  };
  const gathered = buildGather({ ledgerNdjson: ledger(rows), learningsMd: "", sinceTs: marker, github, openTaskClasses: Array(650).fill("src"), maxRunsPerPass: 1 });
  assert.equal(gathered.shipped.length, 1);
  assert.equal(gathered.shipped[0].source, "github");
  const [row] = gathered.closureByClass;
  assert.equal(row.taskClass, "src");
  assert.equal(row.merged, 1);
  assert.deepEqual(row.mergeRate, { kind: "rate", value: 0.2, merged: 1, denominator: 5 });
  assert.equal(row.lastMergeTs, after);
  assert.match(renderClosureByClass([row]), /1 of 5 attempts/);
  const atMarker = { ...github, findMergedByTrailer: () => ({ number: 12, url, mergedAt: marker }) };
  assert.equal(shippedSince(gatherRuns(rows), marker, atMarker).shipped.length, 0);
  const sameInstant = { ...github, findMergedByTrailer: () => ({ number: 12, url, mergedAt: "2026-10-01T02:00:00Z" }) };
  assert.equal(shippedSince(gatherRuns(rows), marker, sameInstant).shipped.length, 0);
  const oldMerge = { ...github, findMergedByTrailer: () => ({ number: 12, url, mergedAt: before }) };
  assert.equal(shippedSince(gatherRuns(rows), marker, oldMerge).shipped.length, 0);
  const foreign = { ...github, headRefName: () => "someone-else" };
  assert.equal(shippedSince(gatherRuns(rows), marker, foreign).shipped.length, 0);
});

test("filings remain the alternative denominator and thin attempt populations name their counts", () => {
  const runs = [attempt("T0"), attempt("T1"), attempt("T-marker", "src", marker)];
  const shipped = [{ runId: "T0", taskId: "W1-T0" }];
  const [thin] = closureByClass(runs, shipped, Array(650).fill("src"), marker);
  assert.deepEqual(thin.mergeRate, { kind: "refused", merged: 1, denominator: 2, floor: 5 });
  assert.match(renderClosureByClass([thin]), /1 of 2 attempts/);
  const filings = [...Array.from({ length: 5 }, () => ({ taskClass: "src", filedTs: after })), { taskClass: "src", filedTs: marker }];
  const [filed] = closureByClass(runs, shipped, [], marker, filings);
  assert.deepEqual(filed.mergeRate, { kind: "rate", value: 0.2, merged: 1, denominator: 5 });
  assert.match(renderClosureByClass([filed]), /1 of 5 filings/);
  const [empty] = closureByClass([], shipped, ["src"], marker);
  assert.equal(empty.mergeRate.kind, "refused");
  assert.equal(empty.mergeRate.denominator, 0);
});

test("ledger merge events scope native and sweep credits by merge time", () => {
  for (const verdict of ["merged", "blocked_review"]) {
    const rows: LedgerRecord[] = [
      { ts: before, step: "run.start", run_id: "old", task_id: "W1-T-old", task_class: "docs", type: "implement" },
      { ts: verdict === "merged" ? after : before, step: "verdict", run_id: "old", verdict, pr_url: url, cost_usd: 3 },
      ...(verdict === "merged" ? [] : [{ ts: after, step: "verdict.merged", run_id: "sweep", task_id: "W1-T-old", pr_url: url }]),
    ];
    const result = buildGather({ ledgerNdjson: ledger(rows), learningsMd: "", sinceTs: marker });
    assert.equal(result.shipped.length, 1);
    assert.equal(result.shipped[0].source, "ledger");
    assert.equal(result.closureByClass[0].taskClass, "docs");
    assert.equal(result.closureByClass[0].lastMergeTs, after);
    assert.equal(result.closureByClass[0].mergeRate.denominator, 0);
    const github: ShippedGithub = { findMergedByTrailer: () => null, headRefName: () => "run-old" };
    assert.equal(shippedSince(gatherRuns(rows), marker, github).shipped.length, 1);
    if (verdict === "blocked_review") {
      assert.ok(result.discrepancies.some((reason) => reason.includes("ledger-credited gate-side merge") || reason.includes("ledger's own verdict.merged credit row")));
    }
    rows.filter((row) => row.ts === after).forEach((row) => { row.ts = marker; });
    assert.equal(buildGather({ ledgerNdjson: ledger(rows), learningsMd: "", sinceTs: marker }).shipped.length, 0);
  }
});

test("closure credits join by task when the credited run is absent and use merge-time boundaries", () => {
  const runs = Array.from({ length: 5 }, (_, i) => attempt(`T${i}`, "docs"));
  const shipped = [
    { runId: "absent", taskId: runs[0].taskId, mergeTs: after },
    { runId: runs[1].runId, taskId: runs[1].taskId, mergeTs: marker },
    { runId: runs[2].runId, taskId: runs[2].taskId, mergeTs: before },
  ];
  const [row] = closureByClass(runs, shipped, [], marker);
  assert.equal(row.taskClass, "docs");
  assert.equal(row.merged, 1);
  assert.equal(row.lastMergeTs, after);
});

test("a ledger merge with unknown time is named instead of being scoped by run start", () => {
  const [run] = gatherRuns(parseLedger(ledger([
    { ts: after, step: "run.start", run_id: "new", task_id: "W1-T-new", type: "implement" },
    { step: "verdict", run_id: "new", verdict: "merged", pr_url: url },
  ])));
  const result = shippedSince([run], marker, { findMergedByTrailer: () => null, headRefName: () => "run-new" });
  assert.equal(result.shipped.length, 0);
  assert.ok(result.discrepancies.some((reason) => reason.includes("ledger merge time is unknown")));
});


interface Counting extends ShippedGithub {
  trailerSearches: string[];
  headLookups: string[];
}

function counting(over: Partial<ShippedGithub> & { mergedAt?: string } = {}): Counting {
  const trailerSearches: string[] = [];
  const headLookups: string[] = [];
  return {
    trailerSearches,
    headLookups,
    findMergedByTrailer: (taskId) => {
      trailerSearches.push(taskId);
      return { number: 12, url, ...(over.mergedAt ? { mergedAt: over.mergedAt } : {}) };
    },
    headRefName: (prUrl) => {
      headLookups.push(prUrl);
      return "run-" + (prUrl.split("/").at(-1) ?? "");
    },
    ...(over.mergedCommits ? { mergedCommits: over.mergedCommits } : {}),
  };
}

function history(): LedgerRecord[] {
  const rows: LedgerRecord[] = [];
  for (let i = 0; i < 400; i += 1) {
    const prUrl = `https://github.com/o/r/pull/${1000 + i}`;
    rows.push({ ts: before, run_id: `p${i}`, task_id: `W1-P${i}`, step: "run.start", type: "implement", task_class: "src" });
    // Half were merged by their own run before the marker, half ended without a merge.
    rows.push(i % 2 === 0
      ? { ts: before, run_id: `p${i}`, step: "verdict", verdict: "merged", pr_url: prUrl, cost_usd: 1 }
      : { ts: before, run_id: `p${i}`, step: "verdict", verdict: "blocked_ci", cost_usd: 1 });
  }
  for (let i = 0; i < 2; i += 1) {
    rows.push({ ts: after, run_id: `n${i}`, task_id: `W1-N${i}`, step: "run.start", type: "implement", task_class: "src" });
    rows.push({ ts: after, run_id: `n${i}`, step: "verdict", verdict: "blocked_ci", cost_usd: 1 });
  }
  return rows;
}

test("with 400 pre-marker runs and 2 post-marker runs, shippedSince makes at most 2 trailer searches and no head lookup for a pre-marker merge", () => {
  const github = counting({ mergedCommits: () => [] });
  const result = shippedSince(gatherRuns(history()), marker, github);
  assert.ok(github.trailerSearches.length <= 2, `trailer searches: ${github.trailerSearches.length}`);
  assert.deepEqual([...github.trailerSearches].sort(), ["W1-N0", "W1-N1"]);
  assert.deepEqual(github.headLookups.filter((u) => /\/pull\/1\d\d\d$/.test(u)), []);
  assert.equal(github.headLookups.length, 2);
  // Each post-marker run resolves to the one PR above, whose own-branch head is "run-12", never theirs.
  assert.equal(result.shipped.length, 0);
});

test("a pre-marker run merged after the marker is still credited, with its merge time, and the closure rate reads merges over dispatched attempts", () => {
  const rows = history();
  // p1 ended blocked_ci before the marker but its PR merged gate-side after it; p2 is ledger-merged after it.
  const merged = [{ date: after, message: "feat: p1\n\nRemudero-Task: W1-P1" }];
  const base = counting({ mergedCommits: () => merged });
  const github: Counting = { ...base, findMergedByTrailer: (taskId) => {
    base.trailerSearches.push(taskId);
    return taskId === "W1-P1" ? { number: 5, url: "https://github.com/o/r/pull/5" } : null;
  }, headRefName: (prUrl) => { base.headLookups.push(prUrl); return prUrl.endsWith("/5") ? "run-p1" : "run-n0"; } };
  const result = shippedSince(gatherRuns(rows), marker, github);
  assert.deepEqual(result.shipped.map((s) => s.taskId), ["W1-P1"]);
  assert.equal(result.shipped[0].source, "github");
  assert.equal(result.shipped[0].mergeTs, after);
  assert.ok(base.trailerSearches.length <= 3, `trailer searches: ${base.trailerSearches.length}`);
  assert.deepEqual(base.headLookups.filter((u) => /\/pull\/1\d\d\d$/.test(u)), []);
  const runs = gatherRuns(rows);
  const [row] = closureByClass(runs, result.shipped, [], marker);
  assert.deepEqual(row.mergeRate, { kind: "refused", merged: 1, denominator: 2, floor: 5 });
  assert.match(renderClosureByClass([row]), /1 of 2 attempts/);
});

test("a pre-marker ledger merge dated after the marker is a candidate and one dated before it makes no gateway call", () => {
  const rows = history();
  rows.push({ ts: before, run_id: "late", task_id: "W1-LATE", step: "run.start", type: "implement", task_class: "src" });
  rows.push({ ts: after, run_id: "late", step: "verdict", verdict: "merged", pr_url: "https://github.com/o/r/pull/1003", cost_usd: 1 });
  const github = counting({ mergedCommits: () => [] });
  const result = shippedSince(gatherRuns(rows), marker, github);
  assert.deepEqual(github.headLookups.filter((u) => u.endsWith("/1003")), ["https://github.com/o/r/pull/1003"]);
  assert.deepEqual(github.headLookups.filter((u) => /\/pull\/1\d\d\d$/.test(u) && !u.endsWith("/1003")), []);
  assert.ok(result.discrepancies.some((d) => d.includes("W1-LATE") && d.includes("REJECTED")), "the stub's head is run-1003, never run late's branch");
});

test("a gateway without mergedCommits degrades to runs started after the marker and never throws", () => {
  const github = counting();
  assert.doesNotThrow(() => shippedSince(gatherRuns(history()), marker, github));
  assert.ok(github.trailerSearches.length <= 2);
});

test("a throwing mergedCommits is named in the discrepancies and does not widen the candidate set", () => {
  const github = counting({ mergedCommits: () => { throw new Error("git log unavailable"); } });
  const result = shippedSince(gatherRuns(history()), marker, github);
  assert.ok(github.trailerSearches.length <= 2);
  assert.ok(result.discrepancies.some((d) => d.includes("git log unavailable")));
});

test("without a marker every run is a candidate and the merge time is not required", () => {
  const github = counting({ mergedCommits: () => [] });
  shippedSince(gatherRuns(history()), undefined, github);
  assert.equal(github.trailerSearches.length, 202); // 200 non-merged pre-marker runs and the 2 new ones
});
