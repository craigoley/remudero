/**
 * test/a-failed-run-the-corpus-had-nothing-to-say-about-is-counted.test.ts — W1-T4243.
 *
 * One cadence rung measures knowledge over a multi-week ledger union: where the corpus is SILENT
 * (failed runs whose injected row matched zero learnings, by code area) and what the knowledge it has
 * DOES (W1-T4241's outcome fold, cumulated). It ledgers one `knowledge.measured` row the digest renders.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { renderKnowledgeMeasured, summarize } from "../src/lib/digest.js";
import { foldKnowledgeGaps, KNOWLEDGE_MEASURED_STEP, knowledgeArea } from "../src/lib/knowledge-gaps.js";
import {
  buildMeasurementCadenceRow,
  KNOWLEDGE_MEASUREMENT_WINDOW_DAYS,
  runKnowledgeMeasurement,
  runMeasurementCadenceReport,
} from "../src/lib/measurement-cadence.js";

type Row = Record<string, unknown>;
const NOW = new Date("2026-09-23T12:00:00.000Z");
const daysAgo = (d: number, minute = 0) => new Date(NOW.getTime() - d * 86_400_000 + minute * 60_000).toISOString();

/** One run of `taskId`: its injected row (silent = matched nothing), its fix rungs, its verdict. */
function run(runId: string, taskId: string, opts: { silent: boolean; verdict?: string; fixes?: number; masked?: boolean; ts?: string }): Row[] {
  const ts = opts.ts ?? daysAgo(1);
  const rows: Row[] = [
    {
      ts,
      run_id: runId,
      task_id: taskId,
      step: "learnings.injected",
      matched: opts.silent ? 0 : 1,
      matched_ids: opts.silent ? [] : ["L"],
      dropped: [],
      masked: opts.masked ?? false,
    },
  ];
  for (let i = 0; i < (opts.fixes ?? 0); i++) rows.push({ ts, run_id: runId, task_id: taskId, step: "fix.dispatch" });
  if (opts.verdict !== undefined) rows.push({ ts, run_id: runId, task_id: taskId, step: "verdict", verdict: opts.verdict });
  return rows;
}

/** `n` runs of one task, the first `silentCount` of them silent, all with the given verdict. */
function runs(tag: string, taskId: string, n: number, silentCount: number, verdict: string): Row[] {
  return Array.from({ length: n }, (_, i) => run(`${tag}-${i}`, taskId, { silent: i < silentCount, verdict })).flat();
}

test("W1-T4243: a failed silent run is a miss in every area its task files touch, once per area", () => {
  const files = new Map([["T1", ["src/lib/a.ts", "src/lib/b.ts", "test/a.test.ts"]]]);
  const r = foldKnowledgeGaps(run("r1", "T1", { silent: true, verdict: "blocked_ci" }), files, { floor: 1 });
  assert.equal(r.runs, 1);
  assert.deepEqual(
    r.areas.map((a) => [a.area, a.failed, a.silentFailed, a.clean]),
    [
      ["src/lib", 1, 1, 0],
      ["test", 1, 1, 0],
    ],
    "two files in src/lib count that area once, and test/ is its own area",
  );
  assert.equal(knowledgeArea("src/run-task.ts"), "src");
  assert.equal(knowledgeArea("package.json"), "package.json");
  assert.equal(knowledgeArea("./src/lib/x.ts"), "src/lib");
});

test("W1-T4243: silence that tracks failure is blind; silence everywhere is no-association, never blind", () => {
  const files = new Map([
    ["BLIND", ["src/lib/x.ts"]],
    ["QUIET", ["docs/x.md"]],
    ["SPOKEN", ["scripts/x.mjs"]],
    ["THIN", ["deploy/x.sh"]],
  ]);
  const rows = [
    // Failed runs got nothing 8 of 10 times; clean runs 1 of 10.
    ...runs("b-fail", "BLIND", 10, 8, "blocked_ci"),
    ...runs("b-ok", "BLIND", 10, 1, "merged"),
    // THE FALSIFIER: every run, clean or failed, matched nothing. Ranking by raw zero-match count would
    // call this blind; silence here does not separate outcomes.
    ...runs("q-fail", "QUIET", 10, 10, "blocked_ci"),
    ...runs("q-ok", "QUIET", 10, 10, "merged"),
    // Failed runs almost always got something.
    ...runs("s-fail", "SPOKEN", 10, 0, "blocked_ci"),
    ...runs("s-ok", "SPOKEN", 10, 5, "merged"),
    // Below the floor in one group.
    ...runs("t-fail", "THIN", 2, 2, "blocked_ci"),
    ...runs("t-ok", "THIN", 10, 0, "merged"),
  ];
  const verdicts = Object.fromEntries(foldKnowledgeGaps(rows, files).areas.map((a) => [a.area, a.verdict]));
  assert.deepEqual(verdicts, { "deploy": "unmeasurable", "docs": "no-association", "scripts": "covered", "src/lib": "blind" });
});

test("W1-T4243: masked, verdict-less, unreadable and unmapped runs are excluded and counted, never dropped", () => {
  const files = new Map([
    ["T1", ["src/lib/a.ts"]],
    ["NOFILES", []],
  ]);
  const rows = [
    ...run("ok", "T1", { silent: false, verdict: "merged" }),
    // Merged only after a fix rung: not clean_single_strike, so it is a FAILED run here.
    ...run("fixed", "T1", { silent: true, verdict: "merged", fixes: 1 }),
    // A wipe-test arm B saw no learnings BY DESIGN — counting it as silent would invent a gap.
    ...run("masked", "T1", { silent: true, verdict: "blocked_ci", masked: true }),
    ...run("inflight", "T1", { silent: true }),
    ...run("gone", "W1-T0000", { silent: true, verdict: "blocked_ci" }),
    ...run("nofiles", "NOFILES", { silent: true, verdict: "blocked_ci" }),
    { ts: daysAgo(1), run_id: "torn", task_id: "T1", step: "learnings.injected" },
    { ts: daysAgo(1), run_id: "torn", task_id: "T1", step: "verdict", verdict: "merged" },
  ];
  const r = foldKnowledgeGaps(rows, files, { floor: 1 });
  assert.equal(r.excludedMasked, 1);
  assert.equal(r.excludedNoVerdict, 1);
  assert.equal(r.excludedUnreadable, 1, "a row with neither matched_ids nor matched cannot say whether it was silent");
  assert.equal(r.unmapped, 1, "a task id missing from the plan is counted, not dropped");
  assert.equal(r.noFiles, 1);
  assert.equal(r.runs, 2);
  assert.deepEqual(
    r.areas.map((a) => [a.area, a.clean, a.failed, a.silentFailed]),
    [["src/lib", 1, 1, 1]],
  );
});

function stateWithArchives(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-knowledge-measured-"));
  const line = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  // 40 days old: outside the window, in an archive rotated 39 days ago.
  writeFileSync(
    join(dir, "ledger.2026-08-15T00-00-00-000Z.ndjson.gz"),
    gzipSync(Buffer.from(line(run("old", "T1", { silent: true, verdict: "blocked_ci", ts: daysAgo(40) })))),
  );
  // 20 and 10 days old: inside the window, far outside a one-day digest read.
  writeFileSync(
    join(dir, "ledger.2026-09-04T00-00-00-000Z.ndjson.gz"),
    gzipSync(Buffer.from(line(run("d20", "T1", { silent: true, verdict: "blocked_ci", ts: daysAgo(20) })))),
  );
  writeFileSync(
    join(dir, "ledger.2026-09-14T00-00-00-000Z.ndjson"),
    line([...run("d10", "T1", { silent: false, verdict: "merged", ts: daysAgo(10) }), { ts: daysAgo(10), run_id: "x", step: "noise" }]),
  );
  // A torn write matches the step filter but cannot parse; the read skips it, never fails on it.
  writeFileSync(
    join(dir, "ledger.ndjson"),
    line(run("live", "T1", { silent: true, verdict: "blocked_ci", ts: daysAgo(0, -5) })) + '{"step":"verdict","run_id":"torn"\n',
  );
  return dir;
}

test("W1-T4243: without an injected plan the rung loads the checkout's own plan, and refuses without one", () => {
  const dir = stateWithArchives();
  try {
    // The real plan at this checkout: W1-T4243's own record declares files, so its runs map to areas.
    const rows = (d: string) => run(`real-${d}`, "W1-T4243", { silent: true, verdict: "blocked_ci", ts: daysAgo(2) });
    writeFileSync(join(dir, "ledger.ndjson"), rows("a").map((r) => JSON.stringify(r)).join("\n") + "\n");
    const m = runKnowledgeMeasurement({ stateDir: dir, now: NOW, checkoutDir: process.cwd() });
    assert.equal(m.status, "measured", m.refusedReason);
    assert.equal(m.gaps?.unmapped, 2, "T1 is not a real task id: d20 and d10 are counted as unmapped");
    assert.equal(m.gaps?.runs, 1, "the W1-T4243 run resolves through the loaded plan");

    const noCheckout = runKnowledgeMeasurement({ stateDir: dir, now: NOW });
    assert.equal(noCheckout.status, "refused");
    assert.match(noCheckout.refusedReason ?? "", /plan unreadable: no checkoutDir/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4243: the rung reads the multi-week union, keeps its window, and refuses rather than reading zero", () => {
  const dir = stateWithArchives();
  try {
    const taskFiles = () => new Map([["T1", ["src/lib/a.ts"]]]);
    const m = runKnowledgeMeasurement({ stateDir: dir, now: NOW, taskFiles });
    assert.equal(m.status, "measured");
    assert.equal(KNOWLEDGE_MEASUREMENT_WINDOW_DAYS, 30);
    // d20, d10 and live are inside 30 days; `old` is not. A one-day read would see only `live`.
    assert.equal(m.gaps?.runs, 3, "a 30-day fixture must not be under-counted by a short window");
    assert.deepEqual(
      m.gaps?.areas.map((a) => [a.area, a.clean, a.failed, a.silentFailed]),
      [["src/lib", 1, 2, 2]],
    );
    assert.ok(m.archiveCount >= 3);
    assert.ok(m.window.from < m.window.to);
    assert.equal(m.outcomes?.runs, 0, "no contested propensities in this fixture: the fold reads zero runs, not an error");

    const empty = mkdtempSync(join(tmpdir(), "rmd-knowledge-empty-"));
    try {
      const refused = runKnowledgeMeasurement({ stateDir: empty, now: NOW, taskFiles });
      assert.equal(refused.status, "refused");
      assert.match(refused.refusedReason ?? "", /ledger union unreadable/);
      assert.equal(refused.gaps, undefined);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const noPlan = runKnowledgeMeasurement({
      stateDir: dir,
      now: NOW,
      taskFiles: () => {
        throw new Error("plan/tasks.yaml unreadable");
      },
    });
    assert.equal(noPlan.status, "refused");
    assert.match(noPlan.refusedReason ?? "", /plan unreadable: plan\/tasks\.yaml unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4243: the measurement cadence ledgers ONE knowledge.measured row, and the digest renders it", () => {
  const dir = stateWithArchives();
  const written: Row[] = [];
  try {
    const result = runMeasurementCadenceReport({
      stateDir: dir,
      cwd: dir,
      escalate: false,
      now: NOW,
      gitLog: () => {
        throw new Error("no git history in this fixture");
      },
      knowledge: {
        taskFiles: () => new Map([["T1", ["src/lib/a.ts"]]]),
        writeLedgerLine: (row) => written.push(row),
      },
    });
    assert.equal(result.knowledge?.status, "measured");
    assert.equal(written.length, 1);
    assert.equal(written[0]!.step, KNOWLEDGE_MEASURED_STEP);
    assert.equal(KNOWLEDGE_MEASURED_STEP, "knowledge.measured");
    // The report has its own row family, so the measurement_cadence.ran row does not carry it twice.
    assert.equal("knowledge" in buildMeasurementCadenceRow(result), false);

    const without = runMeasurementCadenceReport({
      stateDir: dir,
      cwd: dir,
      escalate: false,
      now: NOW,
      gitLog: () => {
        throw new Error("no git history in this fixture");
      },
    });
    assert.equal(without.knowledge, undefined, "opt-in: no writer supplied, no rung");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const row = { ...written[0]!, ts: daysAgo(0), run_id: "KNOWLEDGE-MEASUREMENT-1", task_id: "KNOWLEDGE" };
  const s = summarize([row] as never[], daysAgo(1));
  assert.ok(s.knowledgeMeasured, "the digest picks up the latest knowledge.measured row in its window");
  const line = renderKnowledgeMeasured(s.knowledgeMeasured!);
  assert.match(line, /^knowledge \(30d, 3 run\(s\)/);
  assert.match(line, /blind: none/);
  assert.match(line, /unmeasurable 1/);
  assert.equal(summarize([], daysAgo(1)).knowledgeMeasured, undefined);

  const refusedRow = { ts: daysAgo(0), run_id: "K", task_id: "KNOWLEDGE", step: "knowledge.measured", status: "refused", refused_reason: "ledger union unreadable: no rotation corpus" };
  assert.match(renderKnowledgeMeasured(summarize([refusedRow] as never[], daysAgo(1)).knowledgeMeasured!), /refused: ledger union unreadable/);
});
