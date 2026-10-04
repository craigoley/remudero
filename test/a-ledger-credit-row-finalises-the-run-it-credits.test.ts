// W1-T3088: the sweep's credit backfill appends a `verdict.merged` row keyed on the SWEEP's own
// run_id, so `gatherRuns` used to drop it as a torn fragment and a run that merged gate-side still
// reduced to `blocked_ci` in every calibration table. The reader now indexes those rows by pr_url
// (task_id only for a row with no pr_url) and reduces the run they credit to `merged`, keeping the
// observed verdict, while `shippedSince` still runs the P9 head-branch assert on it.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildGather,
  censusMergeStateFrom,
  gatherRuns,
  infrastructureEvents,
  ledgerCreditDiscrepancies,
  ledgerCreditIndex,
  loadMastMapping,
  mastCategoryDistribution,
  mergedSince,
  parseLedger,
  renderGather,
  shippedSince,
  taskDefectCounts,
  type ShippedGithub,
} from "../src/lib/retro.js";

const REAL_MAPPING = loadMastMapping(join(process.cwd(), "plan", "mast-mapping.yaml"));

const TASK = "W1-T9001";
const RUN = `${TASK}-1788000000000`;
const OWN_BRANCH = `run-${RUN}`;
const PR = "https://github.com/o/r/pull/9001";
const OTHER_PR = "https://github.com/o/r/pull/9002";
const SWEEP_RUN = "DAEMON-1788000500000";
const CREDIT_TS = "2026-09-08T01:00:00.000Z";

function runLines(runId: string, taskId: string, verdict: string, prUrl: string | undefined, startTs = "2026-09-07T20:00:00.000Z"): string[] {
  return [
    JSON.stringify({ ts: startTs, run_id: runId, task_id: taskId, step: "run.start", type: "implement", task_class: "code" }),
    ...(prUrl ? [JSON.stringify({ ts: "2026-09-07T20:30:00.000Z", run_id: runId, task_id: taskId, step: "pr.opened", pr_url: prUrl })] : []),
    JSON.stringify({ ts: "2026-09-07T21:00:00.000Z", run_id: runId, task_id: taskId, step: "verdict", verdict, cost_usd: 4, ...(prUrl ? { pr_url: prUrl } : {}) }),
  ];
}

/** The sweep's OWN shape, verbatim from `runCreditBackfill` — run_id is the SWEEP's id. */
function creditRow(taskId: string, prUrl: string | undefined, prNumber = 9001): string {
  return JSON.stringify({
    ts: CREDIT_TS,
    run_id: SWEEP_RUN,
    task_id: taskId,
    step: "verdict.merged",
    verdict: "merged",
    pr_number: prNumber,
    ...(prUrl ? { pr_url: prUrl } : {}),
    source: "sweep.credit_backfill",
  });
}

const CREDITED_LEDGER = [...runLines(RUN, TASK, "blocked_ci", PR), creditRow(TASK, PR)].join("\n");
const FOREIGN_CREDIT_LEDGER = [...runLines(RUN, TASK, "blocked_ci", PR), creditRow(TASK, OTHER_PR, 9002)].join("\n");

function gatewayWithHead(head: string | undefined): ShippedGithub & { trailerLookups: string[] } {
  const g = {
    trailerLookups: [] as string[],
    findMergedByTrailer(taskId: string) {
      g.trailerLookups.push(taskId);
      return null;
    },
    headRefName: () => head,
  };
  return g;
}

test("a run whose own verdict row reads blocked_ci and whose pr_url is named by a later verdict.merged backfill row reduces to merged, with the observed verdict retained", () => {
  const runs = gatherRuns(parseLedger(CREDITED_LEDGER));
  assert.equal(runs.length, 1, "the DAEMON-* fragment is still not a run of its own");
  const [r] = runs;
  assert.equal(r.runId, RUN);
  assert.equal(r.verdict, "merged");
  assert.equal(r.verdictSource, "ledger-credit");
  assert.equal(r.observedVerdict, "blocked_ci");
  assert.equal(r.creditMatch, "pr_url");
  assert.equal(r.creditTs, CREDIT_TS);
  assert.equal(r.prUrl, PR);
  assert.equal(r.costUsd, 4, "cost still comes off the run's own verdict line");
});

test("the index keys a credit row by pr_url, and by task_id only when the row carries no pr_url", () => {
  const idx = ledgerCreditIndex(parseLedger([creditRow(TASK, PR), creditRow("W1-T9002", undefined)].join("\n")));
  assert.deepEqual([...idx.byPrUrl.keys()], [PR]);
  assert.deepEqual([...idx.byTaskId.keys()], ["W1-T9002"]);
  assert.equal(idx.byTaskId.has(TASK), false, "a row WITH a pr_url never enters the task_id fallback");
});

test("a verdict.merged row naming a different pr_url for the same task does not credit this run", () => {
  const runs = gatherRuns(parseLedger(FOREIGN_CREDIT_LEDGER));
  assert.equal(runs.length, 1);
  const [r] = runs;
  assert.equal(r.verdict, "blocked_ci", "the falsifier: a foreign pr_url leaves the run blocked_ci");
  assert.equal(r.verdictSource, undefined);
  assert.equal(r.observedVerdict, undefined);
  assert.equal(mergedSince(runs, undefined).length, 0);
  assert.deepEqual(ledgerCreditDiscrepancies(runs, undefined), []);
});

test("with two runs of one task, only the run whose own pr_url the credit row names is credited", () => {
  const RUN_B = `${TASK}-1788000100000`;
  const ledger = [
    ...runLines(RUN, TASK, "blocked_ci", PR),
    ...runLines(RUN_B, TASK, "blocked_ci", OTHER_PR, "2026-09-07T22:00:00.000Z"),
    creditRow(TASK, OTHER_PR, 9002),
  ].join("\n");
  const runs = gatherRuns(parseLedger(ledger));
  const byId = new Map(runs.map((r) => [r.runId, r]));
  assert.equal(byId.get(RUN)?.verdict, "blocked_ci");
  assert.equal(byId.get(RUN_B)?.verdict, "merged");
  assert.equal(byId.get(RUN_B)?.verdictSource, "ledger-credit");
});

test("a credit row with no pr_url falls back to task_id and is LABELLED as such", () => {
  const ledger = [...runLines(RUN, TASK, "blocked_ci", PR), creditRow(TASK, undefined)].join("\n");
  const runs = gatherRuns(parseLedger(ledger));
  const [r] = runs;
  assert.equal(r.verdict, "merged");
  assert.equal(r.creditMatch, "task_id");
  const lines = ledgerCreditDiscrepancies(runs, undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /matched by task_id/);
  assert.match(lines[0], /verdictSource=ledger-credit/);
});

test("a run already merged, already_satisfied or task_already_merged is left exactly as observed", () => {
  for (const v of ["merged", "already_satisfied", "task_already_merged"]) {
    const ledger = [...runLines(RUN, TASK, v, PR), creditRow(TASK, PR)].join("\n");
    const [r] = gatherRuns(parseLedger(ledger));
    assert.equal(r.verdict, v);
    assert.equal(r.verdictSource, undefined, `${v} needs no ledger credit`);
  }
});

test("a run with no pr_url of its own is not credited by a row that has one — nothing to match", () => {
  const ledger = [...runLines(RUN, TASK, "blocked_ci", undefined), creditRow(TASK, PR)].join("\n");
  const [r] = gatherRuns(parseLedger(ledger));
  assert.equal(r.verdict, "blocked_ci");
  assert.equal(r.verdictSource, undefined);
});

test("the calibration tables and mergedSince count the ledger-credited run as merged without any GitHub gateway supplied", () => {
  const g = buildGather({ ledgerNdjson: CREDITED_LEDGER, learningsMd: "", mastMapping: REAL_MAPPING });
  assert.deepEqual(g.verdicts, { merged: 1 });
  assert.equal(g.mergedSince.length, 1);
  assert.equal(g.mergedSince[0].runId, RUN);
  assert.equal(g.byType.find((t) => t.type === "implement")?.merged, 1);
  const cls = g.byClass.find((c) => c.taskClass === "code");
  assert.equal(cls?.merged, 1);
  assert.equal(cls?.mergedForDenominator, 1, "the shipped denominator counts it too");
  assert.deepEqual(g.shipped.map((s) => [s.runId, s.source]), [[RUN, "ledger"]]);
  assert.equal(g.githubUnavailable, undefined);
  // The census treats it as merged: excluded, never a failure category, never `reconciled`.
  assert.deepEqual(g.mast.byCategory, {});
  assert.deepEqual(g.mast.unmapped, {});
  assert.deepEqual(g.mast.reconciled, []);
  assert.deepEqual(g.taskDefectCounts, {});
  assert.deepEqual(g.infrastructureEvents, []);
  // Named ONCE in the Discrepancies section, as a ledger credit rather than a GitHub read.
  assert.equal(g.discrepancies.length, 1);
  assert.match(g.discrepancies[0], new RegExp(`^${TASK} \\(${RUN}\\): ledger verdict=blocked_ci`));
  assert.match(g.discrepancies[0], /credited from the ledger \(verdictSource=ledger-credit\), not from GitHub/);
  const text = renderGather(g);
  assert.match(text, /## Discrepancies \(ledger vs GitHub — every gate-side addition, ledger-credited merge and rejected foreign trailer\)/);
  const section = text.split("## Discrepancies")[1].split("\n## ")[0];
  assert.equal(section.split(RUN).length - 1, 1, "the reduced run is named exactly once in Discrepancies");
});

test("the same corpus without the credit row is a verification failure — the credit row is load-bearing", () => {
  const g = buildGather({ ledgerNdjson: runLines(RUN, TASK, "blocked_ci", PR).join("\n"), learningsMd: "", mastMapping: REAL_MAPPING });
  assert.deepEqual(g.verdicts, { blocked_ci: 1 });
  assert.equal(g.mergedSince.length, 0);
  assert.equal(g.byType.find((t) => t.type === "implement")?.merged, 0);
  assert.deepEqual(g.mast.byCategory, { verification: 1 });
  assert.deepEqual(g.discrepancies, []);
});

test("shippedSince still runs the P9 head-branch assert on a ledger-credited run and never pays the trailer read for it", () => {
  const runs = gatherRuns(parseLedger(CREDITED_LEDGER));
  const own = gatewayWithHead(OWN_BRANCH);
  const okay = shippedSince(runs, undefined, own);
  assert.deepEqual(own.trailerLookups, [], "no REST rediscovery of a fact the ledger holds");
  assert.equal(okay.shipped.length, 1);
  assert.equal(okay.shipped[0].source, "ledger");
  assert.equal(okay.shipped[0].prUrl, PR);
  assert.match(okay.shipped[0].annotation ?? "", /verdictSource=ledger-credit/);
  assert.match(okay.shipped[0].annotation ?? "", /matched by pr_url/);
  assert.match(okay.shipped[0].annotation ?? "", /run observed blocked_ci/);
  assert.deepEqual(okay.discrepancies, [], "shippedSince itself adds no line; buildGather names the credit once");

  const foreign = gatewayWithHead("run-W1-T0000-1");
  const rejected = shippedSince(runs, undefined, foreign);
  assert.deepEqual(foreign.trailerLookups, []);
  assert.equal(rejected.shipped.length, 0, "a foreign head is REJECTED exactly as a native ledger merge would be");
  assert.equal(rejected.discrepancies.length, 1);
  assert.match(rejected.discrepancies[0], /REJECTED — ledger claims/);
  assert.match(rejected.discrepancies[0], new RegExp(OWN_BRANCH));
});

test("with a gateway, the ledger-credited run is shipped as ledger, named once in Discrepancies, and excluded by the census as merged", () => {
  const github = gatewayWithHead(OWN_BRANCH);
  const g = buildGather({ ledgerNdjson: CREDITED_LEDGER, learningsMd: "", mastMapping: REAL_MAPPING, github });
  assert.deepEqual(g.shipped.map((s) => [s.runId, s.source]), [[RUN, "ledger"]]);
  assert.equal(g.discrepancies.length, 1);
  assert.match(g.discrepancies[0], /credited from the ledger/);
  assert.equal(g.mast.mergeStateSource, "github");
  assert.deepEqual(g.mast.byCategory, {});
  assert.deepEqual(g.mast.reconciled, [], "credited, so excluded as merged rather than reconciled");
  const text = renderGather(g);
  const section = text.split("## Discrepancies")[1].split("\n## ")[0];
  assert.equal(section.split(RUN).length - 1, 1);
  assert.match(text, /ledger-credited gate-side merge \(verdictSource=ledger-credit/);

  // The census helpers agree when called directly with the join #4509 built.
  const runs = gatherRuns(parseLedger(CREDITED_LEDGER));
  const state = censusMergeStateFrom(g.shipped, github, undefined);
  assert.equal(state.creditedRunIds.has(RUN), true);
  const dist = mastCategoryDistribution(runs, REAL_MAPPING, state);
  assert.deepEqual(dist.byCategory, {});
  assert.deepEqual(dist.reconciled, []);
  assert.deepEqual(infrastructureEvents(runs, REAL_MAPPING, state), []);
  assert.deepEqual(taskDefectCounts(runs, REAL_MAPPING, state), {});
});

test("the marker window scopes the discrepancy line exactly as it scopes shippedSince", () => {
  const runs = gatherRuns(parseLedger(CREDITED_LEDGER));
  assert.equal(ledgerCreditDiscrepancies(runs, "2026-09-07T19:00:00.000Z").length, 1);
  assert.equal(ledgerCreditDiscrepancies(runs, "2026-09-07T20:00:00.000Z").length, 0, "strictly after, like shippedSince");
});
