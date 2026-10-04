import assert from "node:assert/strict";
import { test } from "node:test";
import { closureByClass, mergeRateCell, renderClosureByClass } from "../src/lib/retro-closure.js";
import { buildGather, gatherRuns, parseLedger, shippedSince, type LedgerRecord, type ShippedGithub } from "../src/lib/retro.js";
import { ghShim } from "./helpers/gh-shim.js";

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

test("the default github merge-time read shells out and reports unreadable timestamps", () => {
  const shim = ghShim([{ when: "pr view", stdout: after }]);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath ?? ""}`;
  try {
    const runs = gatherRuns(parseLedger(ledger([
      { ts: before, step: "run.start", run_id: "old", task_id: "W1-T-old", type: "implement", task_class: "src" },
      { ts: before, step: "verdict", run_id: "old", verdict: "blocked_review" },
    ])));
    const github: ShippedGithub = { findMergedByTrailer: () => ({ number: 12, url }), headRefName: () => "run-old" };
    assert.equal(shippedSince(runs, marker, github).shipped.length, 1);
    assert.ok(shim.calls().some((call) => call.includes("--json mergedAt")));
    shim.addRoute({ when: "pr view", stdout: "null" });
    const missing = shippedSince(runs, marker, github);
    assert.equal(missing.shipped.length, 0);
    assert.ok(missing.discrepancies.some((reason) => /merge time.*unknown/i.test(reason)));
    shim.addRoute({ when: "pr view", exit: 1, stderr: "merge-time read unavailable" });
    const failed = shippedSince(runs, marker, github);
    assert.equal(failed.shipped.length, 0);
    assert.ok(failed.discrepancies.some((reason) => reason.includes("merge-time read unavailable")));
  } finally {
    process.env.PATH = savedPath;
  }
});
