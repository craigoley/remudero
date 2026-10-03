// W1-T5474: the config gardener's 60-day ledger union read is bounded to the steps its inventory
// prices (CONFIG_GARDEN_LEDGER_STEPS), its inventory is unchanged by every row outside that set, and
// the garden child heap cap that waited on this drops to 2048 MB.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import * as gardener from "../src/lib/config-gardener.js";
import * as registry from "../src/lib/garden-registry.js";
import type { GardenerDeps } from "../src/lib/gardener.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "../src/lib/learnings.js";
import { readLedgerUnionRecordsSync } from "../src/lib/ledger-union.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const NOW_MS = Date.parse("2026-10-01T12:00:00.000Z");
const WINDOW = { rotationWindowMs: 60 * 24 * 3600 * 1000, minRotations: 4 };
const steps = (): readonly string[] => gardener.CONFIG_GARDEN_LEDGER_STEPS;
const at = (minute: number): string => fixedClock(NOW_MS - 3 * 24 * 3600 * 1000 + minute * 60_000).iso();
const WEIGHTS: Record<string, number> = { "fact-a": 900, "fact-b": 450, "fact-c": 120 };

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5474-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const garden: GardenerDeps = {
    stateDir, repoRoot: root, log: () => {}, clock: fixedClock(NOW_MS),
    openWorkspace: () => ({ root, land: () => undefined, dispose: () => {} }),
  };
  return { stateDir, garden };
}

/** A realistic step mix: settled runs, credited runs settled only through each fallback step, call rows
 *  for the cache-hit mix, and the rows of steps outside the set every run and daemon cycle also writes. */
function corpus(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let m = 0;
  let calls = 0;
  const call = () => ({ model: "opus", effort: "high", tokens: { cacheRead: 1000 * ++calls + 37 * calls * calls, input: 90 + calls, cacheCreation: 40 } });
  const noise = (runId: string) => [
    { step: "worker.activity", run_id: runId, tool: "Bash", detail: "x".repeat(120), ts: at(m++) },
    { step: "run.running_long", run_id: runId, elapsed_ms: 900_000, ts: at(m++) },
    { step: "retro.preflight_failed", run_id: runId, model: "opus", effort: "low", reason: "no tokens on this row", ts: at(m++) },
  ];
  const start = (runId: string, cls: string) => ({ step: "run.start", run_id: runId, task_id: `W1-T${runId.slice(1)}`, type: "implement", risk: "low", task_class: cls, ts: at(m++) });
  for (let i = 0; i < 6; i++) {
    const id = `r${100 + i}`;
    const url = `https://github.com/acme/remudero/pull/${100 + i}`;
    rows.push(start(id, i % 2 ? "src" : "test"), ...noise(id),
      { step: "learnings.injected", run_id: id, budget_chars: DEFAULT_KNOWLEDGE_BUDGET_CHARS, dropped: Object.keys(WEIGHTS).slice(0, 1 + (i % 3)), ts: at(m++) },
      { step: "learnings.injected", run_id: id, budget_chars: 4000, dropped: ["fact-a"], ts: at(m++) },
      { step: "recon.done", run_id: id, num_turns: 3 + i, cost_usd: 0.4, ...call(), ts: at(m++) },
      { step: "implement.done", run_id: id, num_turns: 20 + i, cost_usd: 2 + i, ...call(), ts: at(m++) },
      ...(i === 0 ? [{ step: "implement.resumed", run_id: id, num_turns: 5, cost_usd: 1, ...call(), ts: at(m++) }] : []),
      { step: "pr.opened", run_id: id, pr_url: url, ts: at(m++) },
      { step: "verdict", run_id: id, task_id: `W1-T${100 + i}`, verdict: i === 5 ? "failed" : "merged", cost_usd: 3 + i, ...call(), ts: at(m++) },
      ...(i === 4 ? [{ step: "correction.provenance", run_id: id, actual_pr_url: `${url}0`, ts: at(m++) }] : []),
      { step: "sweep.disposed", run_id: "sweep-1", pr_url: url, disposition: "green", ts: at(m++) });
  }
  // r105 failed but a later merge credits it.
  rows.push({ step: "verdict.merged", run_id: "sweep-1", pr_url: "https://github.com/acme/remudero/pull/105", ts: at(m++) });
  const fallback = (group: readonly string[], field: "cost_usd" | "pr_url", offset: number) => group.forEach((step, i) => {
    const id = `r${offset + i}`;
    const url = `https://github.com/acme/remudero/pull/${offset + i}`;
    rows.push(start(id, "src"), ...noise(id), { step, run_id: id, ...(field === "cost_usd" ? { cost_usd: 0.25 + i / 100 } : { pr_url: url }), ts: at(m++) });
    if (field === "cost_usd") rows.push({ step: "pr.opened", run_id: id, pr_url: url, ts: at(m++) });
    rows.push({ step: "verdict.merged", run_id: "sweep-1", pr_url: url, ts: at(m++) });
  });
  fallback(["cost.anomaly", "containment.probe", "isolation.probe", "risk_judge.decision", "budget.warning"], "cost_usd", 200);
  fallback(["report.followups", "pr.head_provider", "dispatch.blocked_independent", "automerge.armed", "automerge.arm_skipped",
    "automerge.arm_failed", "automerge.clean_status_direct_merge", "review.posted", "review.pending_posted",
    "review.unwired_advisory", "review.post_refused", "review.stood_down", "acceptance.repaired", "trailer_stamp.failed"], "pr_url", 300);
  for (const step of ["review.reviewer", "inbox.draft_synthesized", "triage.synthesized", "retro.synthesized", "retro.preflight_repair",
    "fix.done", "fix.commit_line_answered", "census_push.strike", "plan.synthesized", "diagnose.worker_done"]) {
    rows.push({ step, run_id: `brain-${step}`, cost_usd: 0.1, ...call(), ts: at(m++) });
  }
  rows.push({ step: "ci.polling", run_id: "daemon", attempt: 1, ts: at(m++) }, { step: "followup.harvested", run_id: "daemon", body: "y".repeat(200), ts: at(m++) });
  return rows;
}

const sources = (rows?: Array<Record<string, unknown>>): gardener.ConfigGardenSources => ({
  ...(rows ? { ledgerRows: () => rows } : {}), entryWeights: () => WEIGHTS, mountRecommendations: () => [],
});

function recordingReader() {
  const calls: Array<Parameters<typeof readLedgerUnionRecordsSync>[1]> = [];
  const returned: Array<Record<string, unknown>> = [];
  const reader: typeof readLedgerUnionRecordsSync = (dir, options, fs) => {
    calls.push(options);
    const result = readLedgerUnionRecordsSync(dir, options, fs);
    returned.push(...result.rows);
    return result;
  };
  return { calls, returned, reader };
}

test("the-config-gardener-reads-only-the-ledger-steps-it-prices.test.ts: the read is filtered to CONFIG_GARDEN_LEDGER_STEPS and the inventory equals the unfiltered read's", (t) => {
  const f = fixture(t);
  const rows = corpus();
  const third = Math.floor(rows.length / 3);
  writeLedger(rows.slice(2 * third), { dir: f.stateDir, rotations: [
    { at: fixedClock(NOW_MS - 2 * 24 * 3600 * 1000).iso(), gz: true, rows: rows.slice(0, third) },
    { at: fixedClock(NOW_MS - 24 * 3600 * 1000).iso(), rows: rows.slice(third, 2 * third) },
  ] });

  const rec = recordingReader();
  const filtered = gardener.configInventory(f.garden, sources(), rec.reader);
  assert.equal(rec.calls.length, 1, "one bounded union read per inventory");
  assert.deepEqual(rec.calls[0]?.step, steps(), "the read passes the step set itself");
  assert.equal(rec.calls[0]?.refuseIncomplete, true, "a bounded read still refuses an incomplete union");
  assert.deepEqual([rec.calls[0]?.rotationWindowMs, rec.calls[0]?.minRotations], [WINDOW.rotationWindowMs, WINDOW.minRotations], "the same 60-day window");
  const kept = new Set(rec.returned.map((r) => String(r.step)));
  assert.deepEqual([...kept].filter((s) => !steps().includes(s)), [], "no row outside the set is materialised");

  const everything = readLedgerUnionRecordsSync(f.stateDir, WINDOW).rows;
  assert.ok(everything.length > rec.returned.length && everything.some((r) => r.step === "worker.activity"), "positive control: the corpus holds rows outside the set");
  assert.equal(rec.returned.length, everything.filter((r) => steps().includes(String(r.step))).length, "every in-set row is read");
  const unfiltered = gardener.configInventory(f.garden, sources(everything));
  assert.ok(filtered.runs.length > 20 && filtered.cap?.derivation.pressure !== undefined && filtered.cap.derivation.cacheHitRatioUsed !== undefined, "positive control: runs, pressure and the cache mix are all measured");
  assert.deepEqual(filtered, unfiltered);
});

test("every step in CONFIG_GARDEN_LEDGER_STEPS changes the inventory when its rows are dropped", (t) => {
  const f = fixture(t);
  const rows = corpus();
  const whole = gardener.configInventory(f.garden, sources(rows));
  assert.deepEqual(gardener.configInventory(f.garden, sources(rows.filter((r) => steps().includes(String(r.step))))), whole, "rows outside the set are inert");
  assert.ok(steps().length > 30, "positive control: the set is populated");
  const inert = steps().filter((step) => {
    const without = gardener.configInventory(f.garden, sources(rows.filter((r) => r.step !== step)));
    return JSON.stringify(without) === JSON.stringify(whole);
  });
  assert.deepEqual(inert, [], "a step whose rows change nothing is either missing from the fixture or not read");
});

test("the config gardener's bounded read refuses an incomplete ledger union", (t) => {
  const f = fixture(t);
  writeLedger([{ step: "run.start", run_id: "r1", ts: at(0) }], { dir: f.stateDir });
  writeFileSync(join(f.stateDir, "ledger.2026-09-30T00-00-00-000Z.ndjson.gz"), "not a gzip archive");
  assert.throws(() => gardener.configInventory(f.garden, sources()), /config gardener: incomplete ledger union: .*ledger\.2026-09-30/);
  assert.throws(() => gardener.readConfigGardenLedgerRows(f.stateDir), /config gardener: incomplete ledger union/);
});

test("the garden child heap cap is 2048 MB once the config garden's read is filtered", () => {
  assert.equal(registry.GARDEN_CHILD_HEAP_LIMIT_MB, 2048);
});

/** One child, one read, under a bounded heap: the heap above the post-import baseline at its peak
 *  (sampled on every materialised row) and what stays retained after a full GC. */
function measureRead(stateDir: string, mode: "filtered" | "unfiltered", scratch: string) {
  const src = (p: string) => pathToFileURL(resolve("src/lib", p)).href;
  const script = join(scratch, `measure-${mode}.mjs`);
  writeFileSync(script, [
    `import { getHeapStatistics } from "node:v8";`,
    `import { readConfigGardenLedgerRows } from ${JSON.stringify(src("config-gardener.ts"))};`,
    `import { readLedgerUnionRecordsSync } from ${JSON.stringify(src("ledger-union.ts"))};`,
    `globalThis.gc(); const base = getHeapStatistics().used_heap_size; let peak = base;`,
    `const sample = () => { const u = getHeapStatistics().used_heap_size; if (u > peak) peak = u; };`,
    `const reader = (dir, o, fs) => readLedgerUnionRecordsSync(dir, { ...o, ${mode === "unfiltered" ? "step: undefined, " : ""}onRecord: sample }, fs);`,
    `const rows = readConfigGardenLedgerRows(${JSON.stringify(stateDir)}, reader);`,
    `sample(); globalThis.gc(); const retained = getHeapStatistics().used_heap_size - base;`,
    `console.log(JSON.stringify({ rows: rows.length, peakMb: (peak - base) / 1048576, retainedMb: retained / 1048576 }));`,
  ].join("\n"));
  const out = spawnSync(process.execPath, ["--import", "tsx", "--expose-gc", "--max-old-space-size=512", script], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim().split("\n").at(-1)!) as { rows: number; peakMb: number; retainedMb: number };
}

test("the filtered read's peak heap on a realistic synthetic ledger is a small fraction of the unfiltered read's", (t) => {
  const f = fixture(t);
  // The live 60-day mix (2026-10-03): 6.9% of rows are in the set, ~420 bytes a row. 7 of every 100 here.
  const units = 1500;
  const perRotation: Array<Array<Record<string, unknown>>> = [[], [], [], []];
  for (let u = 0; u < units; u++) {
    const id = `run-${u}`;
    const ts = at(u);
    const bucket = perRotation[u % 4]!;
    bucket.push(
      { step: "run.start", run_id: id, task_id: `W1-T${u}`, type: "implement", risk: "low", task_class: "src", ts },
      { step: "learnings.injected", run_id: id, budget_chars: DEFAULT_KNOWLEDGE_BUDGET_CHARS, dropped: ["fact-a", "fact-b"], injected: ["fact-c"], ts },
      { step: "implement.done", run_id: id, num_turns: 40, cost_usd: 2.5, model: "opus", effort: "high", tokens: { cacheRead: 900_000, input: 1200, cacheCreation: 40_000, output: 9000 }, ts },
      { step: "pr.opened", run_id: id, pr_url: `https://github.com/acme/remudero/pull/${u}`, ts },
      { step: "verdict", run_id: id, task_id: `W1-T${u}`, verdict: "merged", cost_usd: 3.1, pr_url: `https://github.com/acme/remudero/pull/${u}`, ts },
      { step: "review.posted", run_id: id, pr_url: `https://github.com/acme/remudero/pull/${u}`, verdict: "approve", ts },
      { step: "cost.anomaly", run_id: id, cost_usd: 3.1, class_p90: 2.2, ts },
    );
    for (let n = 0; n < 93; n++) {
      bucket.push({ step: ["worker.activity", "run.running_long", "worker.turns", "worker.state", "sweep.disposed", "ci.polling"][n % 6], run_id: n % 6 === 4 ? "sweep" : id, seq: n, detail: `${"activity ".repeat(38)}${u}:${n}`, ts });
    }
  }
  const tail = perRotation.pop()!;
  writeLedger(tail, { dir: f.stateDir, rotations: perRotation.map((rows, i) => ({ at: fixedClock(NOW_MS - (3 - i) * 24 * 3600 * 1000).iso(), gz: true, rows })) });

  const filtered = measureRead(f.stateDir, "filtered", f.stateDir);
  const unfiltered = measureRead(f.stateDir, "unfiltered", f.stateDir);
  t.diagnostic(`synthetic ledger ${units * 100} rows: filtered ${filtered.rows} rows peak ${filtered.peakMb.toFixed(1)} MB retained ${filtered.retainedMb.toFixed(1)} MB; unfiltered ${unfiltered.rows} rows peak ${unfiltered.peakMb.toFixed(1)} MB retained ${unfiltered.retainedMb.toFixed(1)} MB`);
  assert.equal(unfiltered.rows, units * 100, "positive control: the unfiltered read materialises every row");
  assert.equal(filtered.rows, units * 7);
  assert.ok(filtered.retainedMb < unfiltered.retainedMb * 0.15, `retained ${filtered.retainedMb} MB filtered vs ${unfiltered.retainedMb} MB unfiltered`);
  assert.ok(filtered.peakMb < unfiltered.peakMb * 0.5, `peak ${filtered.peakMb} MB filtered vs ${unfiltered.peakMb} MB unfiltered`);
});
