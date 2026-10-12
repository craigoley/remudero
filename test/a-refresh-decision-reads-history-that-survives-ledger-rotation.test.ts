import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DECISION_RELEVANT_LEDGER_STEPS, MAX_RETAINED_LINES_PER_STEP, appendLedger, rotateLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { resolveLedgerUnion } from "../src/lib/ledger-union.js";
import { assessRefreshClearance, type BaseProbeFile } from "../src/lib/base-reproduction.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";

// @source-text-subject: the retention census resolves deciding step comparisons in source text.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STEPS = ["fix.base_refreshed", "sweep.base_red.refresh", "sweep.base_fixed.refresh", "refresh.clearance"];
type Row = Record<string, unknown>;
const NOW = Date.UTC(2026, 9, 12, 15);
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const PR = 10190;
const HEAD = "4".repeat(40);
const MAIN = "3".repeat(40);
const FILE = "test/ci-parity.test.ts";
const CHECK = "coverage-shard (4/8)";

function refreshSteps(sources: readonly string[], constants: readonly string[]): Set<string> {
  const values = new Map<string, string>();
  for (const source of constants) {
    for (const match of source.matchAll(/\bexport\s+const\s+(\w+)\s*=\s*(["'])([^"']+)\2/g)) values.set(match[1], match[3]);
  }
  const steps = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/\.step\s*(?:===|!==)\s*(?:(["'])([^"']+)\1|(\w+))/g)) {
      const value = match[2] ?? values.get(match[3]);
      if (value?.includes("refresh")) steps.add(value);
    }
  }
  return steps;
}

function census(): Set<string> {
  const sources = readdirSync(join(ROOT, "src"), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
    .map(entry => readFileSync(join(entry.parentPath, entry.name), "utf8"));
  return refreshSteps(["src/lib/sweep.ts", "src/run-task.ts", "src/lib/base-reproduction.ts"]
    .map(path => readFileSync(join(ROOT, path), "utf8")), sources);
}

test("W1-T8533: every step a refresh decision reads is in the retention set", () => {
  const steps = census();
  for (const step of STEPS) assert.ok(steps.has(step), `positive control: ${step}`);
  assert.deepEqual([...steps].filter(step => !DECISION_RELEVANT_LEDGER_STEPS.has(step)), []);
});

test("W1-T8533: the refresh census finds the four known steps and reports an unretained one", () => {
  const steps = census();
  for (const step of STEPS) assert.ok(steps.has(step), `positive control: ${step}`);
  const fake = 'export const NEW_REFRESH_STEP = "sweep.new.refresh";';
  const fixture = 'row.step === NEW_REFRESH_STEP; row.step !== "refresh.literal";';
  assert.deepEqual([...refreshSteps([fixture], [fake])].filter(step => !DECISION_RELEVANT_LEDGER_STEPS.has(step)),
    ["sweep.new.refresh", "refresh.literal"]);
  assert.deepEqual([...refreshSteps(['row.step !== NEW_REFRESH_STEP'], [fake])], ["sweep.new.refresh"]);
});

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-W1-T8533-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.ndjson");
  const write = (rows: Row[]) => writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const rotate = (rows: Row[]) => {
    write([...rows, ...Array.from({ length: 100 }, (_, n) => ({ step: "ci.polling", run_id: `noise-${n}`, detail: "x".repeat(100) }))]);
    const rotation = rotateLedger(path, { ceilingBytes: 10_000, smoothingWindowMs: 0, now: () => new Date(NOW) });
    assert.equal(rotation.rotated, true);
    assert.ok(rotation.archivePath);
    return rotation;
  };
  return { dir, path, write, rotate };
}

function redPr(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return { prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: "W1-T8533",
    reviewState: "pending", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    createdAt: at(60), lastActivityAt: at(1), headSha: HEAD, headRefName: "run-W1-T8533-1", autoMergeArmed: false,
    ciFailures: [{ name: CHECK, logTail: `not ok 3 - ${FILE}` }], ...overrides };
}
const prior = (head = "1".repeat(40)): Row => ({ ts: at(30), run_id: "prior", task_id: "W1-T8533",
  step: "sweep.base_fixed.refresh", pr_number: PR, head_sha: head, outcome: "updated", test_files: [FILE], check_names: [CHECK] });
const liveWindow = (): Row[] => STEPS.map(step => ({ ts: at(120), step, pr_number: 6000, head_sha: "peer" }));
const health = (): Row => ({ ts: at(1), step: "main.health.observed", sha: MAIN, state: "undetermined" });

function harness(path: string, extra: Partial<SweepDeps> = {}) {
  const refreshed: number[] = [];
  const fixed: number[] = [];
  const merged: number[] = [];
  const escalations: string[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, postReview: async () => {},
    escalate: (_pr, reason) => { escalations.push(reason); },
    dispatchFix: pr => { fixed.push(pr.prNumber); },
    updateBranch: pr => { refreshed.push(pr.prNumber); return "updated"; },
    reproduceFailingTestsOnMain: async (_pr, files) => files.map(file => ({ file, outcome: "passes", duration_ms: 1, cached: false })),
    readTestImportClosure: async () => new Map([[FILE, new Set([FILE])]]),
    ledgerPath: path, runId: "W1-T8533-test", now: () => NOW, readMainTip: () => MAIN,
    appendLine: (ledger, row) => appendLedger(ledger, row),
    behindMainByPr: new Map([[PR, 2]]), ...extra,
  };
  const probe = (outcome: BaseProbeFile["outcome"]) => async (_pr: OpenPrView, files: readonly string[]) => {
    merged.push(PR);
    return files.map(file => ({ file, outcome, duration_ms: 1, cached: false }));
  };
  const run = async (pr = redPr()) => {
    const peer = redPr({ prNumber: 6000, prUrl: "https://github.com/acme/remudero/pull/6000", taskId: "W1-T6000",
      headRefName: "run-W1-T6000-1", checksState: "green", reviewState: "success", ciFailures: [] });
    await runSweep([pr, peer], deps, DEFAULT_SWEEP_POLICY);
  };
  const clearance = () => readLedgerLines(path).findLast(row => row.step === "refresh.clearance" && row.pr_number === PR);
  return { deps, refreshed, fixed, merged, escalations, probe, run, clearance };
}

test("W1-T8533: a refresh row survives rotation and still refuses a second refresh on the same red", async t => {
  const f = fixture(t);
  f.rotate([...liveWindow(), prior(), health()]);
  assert.ok(readLedgerLines(f.path).some(row => row.step === "sweep.base_fixed.refresh" && row.pr_number === PR));
  const h = harness(f.path);
  h.deps.reproduceFailingTestsOnMerge = h.probe("passes");
  await h.run();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.fixed, [PR]);
  assert.deepEqual(h.merged, []);
  assert.equal(h.clearance()?.evidence, "repeat");
  assert.equal(h.clearance()?.history, "live");
});

test("W1-T8533: a PR older than the live window reads its refresh history from the rotations", async t => {
  const f = fixture(t);
  const capped = Array.from({ length: MAX_RETAINED_LINES_PER_STEP }, (_, n) => ({ ...prior(), ts: at(20), pr_number: 20000 + n }));
  f.rotate([prior(), ...capped, health()]);
  assert.equal(readLedgerLines(f.path).some(row => row.step === "sweep.base_fixed.refresh" && row.pr_number === PR), false);
  let reads = 0;
  const h = harness(f.path, { readRefreshLedgerUnion: (dir, pattern, fs, options) => {
    reads++;
    assert.equal(dir, f.dir);
    assert.equal(pattern, `"pr_number":${PR}[,}]`);
    assert.ok(options);
    assert.deepEqual(options.step, STEPS);
    return resolveLedgerUnion(dir, pattern, fs, options);
  } });
  h.deps.reproduceFailingTestsOnMerge = h.probe("passes");
  await h.run();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.fixed, [PR]);
  assert.deepEqual(h.merged, []);
  assert.equal(h.clearance()?.evidence, "repeat");
  assert.equal(h.clearance()?.history, "union");
  assert.equal(reads, 1, "all decisions for this PR share one union read per pass");
});

test("W1-T8533: convergence-shed refresh history still prevents a second refresh", async t => {
  const f = fixture(t);
  const bloat = Array.from({ length: 20 }, (_, n) => ({ ts: at(20), step: "run.start",
    run_id: `bloat-${n}`, task_id: `W1-BLOAT-${n}`, detail: "x".repeat(1000) }));
  assert.ok(bloat.length < MAX_RETAINED_LINES_PER_STEP, "the per-step cap cannot cause this loss");
  f.rotate([prior(), ...bloat, health()]);
  const live = readLedgerLines(f.path);
  assert.ok(live.some(row => row.step === "ledger.rotation_shed"), "the convergence pass shed retained rows");
  assert.equal(live.some(row => row.step === "sweep.base_fixed.refresh" && row.pr_number === PR), false);
  const h = harness(f.path);
  h.deps.reproduceFailingTestsOnMerge = h.probe("passes");
  await h.run();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.fixed, [PR]);
  assert.deepEqual(h.merged, []);
  assert.equal(h.clearance()?.evidence, "repeat");
  assert.equal(h.clearance()?.history, "union");
});

test("W1-T8533: an unreadable refresh history is named and never read as no prior refresh", async t => {
  const f = fixture(t);
  f.write([health()]);
  const unread = join(f.dir, "ledger.2026-10-12T14-00-00-000Z.ndjson.gz");
  writeFileSync(unread, "not gzip");
  const h = harness(f.path);
  await h.run();
  assert.deepEqual(h.refreshed, [], "neither history nor a trial merge proves a refresh can help");
  assert.deepEqual(h.fixed, [PR]);
  assert.equal(h.clearance()?.history, "unreadable");
  assert.deepEqual(h.clearance()?.unread, [unread]);
  assert.equal(h.clearance()?.refresh, false);
  assert.match(String(h.clearance()?.reason), /history.*unreadable/);
});

test("W1-T8533: a covered live window avoids the union, including the no-prior-refresh case", async t => {
  const f = fixture(t);
  f.write([...liveWindow(), health()]);
  writeFileSync(join(f.dir, "ledger.unknown"), "unclassified");
  const h = harness(f.path, { readRefreshLedgerUnion: () => { assert.fail("the live window covers this PR"); } });
  h.deps.reproduceFailingTestsOnMerge = h.probe("passes");
  await h.run();
  assert.deepEqual(h.refreshed, [PR]);
  assert.equal(h.clearance()?.history, "live");
});

test("W1-T8533: an invalid live timestamp cannot vouch for a PR's history", async t => {
  const f = fixture(t);
  f.rotate([prior()]);
  f.write([...liveWindow().map(row => row.step === "sweep.base_fixed.refresh" ? { ...row, ts: "invalid" } : row), health()]);
  const h = harness(f.path);
  h.deps.reproduceFailingTestsOnMerge = h.probe("passes");
  await h.run();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.merged, []);
  assert.equal(h.clearance()?.history, "union");
  assert.equal(h.clearance()?.evidence, "repeat");
});

test("W1-T8533: a clearance refusal survives a real rotation and still prevents probing", async t => {
  const f = fixture(t);
  f.rotate([...liveWindow(), { ts: at(30), step: "refresh.clearance", pr_number: PR,
    head_sha: HEAD, main_sha: MAIN, test_files: [FILE], refresh: false, evidence: "merged-probe" }, health()]);
  assert.equal(readLedgerLines(f.path).findLast(row => row.step === "refresh.clearance" && row.pr_number === PR)?.refresh, false);
  const h = harness(f.path, { readRefreshLedgerUnion: () => { assert.fail("the retained live window covers this PR"); } });
  h.deps.reproduceFailingTestsOnMerge = h.probe("passes");
  await h.run();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.merged, []);
  assert.deepEqual(h.fixed, [PR]);
});

test("W1-T8533: unreadable history still uses main-delta and trial-merge evidence", async t => {
  for (const evidence of ["prefilter", "merged-probe"] as const) {
    const f = fixture(t);
    f.write([health()]);
    const h = harness(f.path, evidence === "prefilter"
      ? { readRedBaseRefreshFacts: async () => ({ behindBy: 2, baseChangedFiles: ["plan/tasks.yaml"] }) } : {});
    h.deps.reproduceFailingTestsOnMerge = h.probe("passes");
    await h.run();
    assert.equal(h.clearance()?.history, "unreadable");
    assert.equal(h.clearance()?.evidence, evidence);
    assert.deepEqual(h.refreshed, evidence === "prefilter" ? [] : [PR]);
    assert.deepEqual(h.merged, evidence === "prefilter" ? [] : [PR]);
  }
});

test("test/a-refresh-decision-reads-history-that-survives-ledger-rotation.test.ts", async () => {
  const decision = await assessRefreshClearance({ failingTestFiles: [FILE], reach: undefined, priorRefresh: undefined }, undefined);
  assert.equal(decision.refresh, false);
  assert.match(decision.reason, /history.*unreadable/);
});

test("W1-T8533: missing creation time and a missing step both require union history", async t => {
  for (const pr of [redPr({ createdAt: undefined }), redPr({ createdAt: "invalid" }), redPr()]) {
    const f = fixture(t);
    f.rotate([prior(), health()]);
    f.write([...liveWindow().filter(row => row.step !== "refresh.clearance"), health()]);
    const h = harness(f.path);
    h.deps.reproduceFailingTestsOnMerge = h.probe("passes");
    await h.run(pr);
    assert.deepEqual(h.refreshed, []);
    assert.equal(h.clearance()?.history, "union");
    assert.equal(h.clearance()?.evidence, "repeat");
  }
});

test("W1-T8533: archived refusals are folded before probing and same-head refreshes before the base-red arm", async t => {
  const f = fixture(t);
  f.rotate([{ ts: at(30), step: "refresh.clearance", pr_number: PR, head_sha: HEAD, main_sha: MAIN,
    test_files: [FILE], refresh: false, evidence: "merged-probe" }]);
  f.write([health()]);
  const h = harness(f.path);
  h.deps.reproduceFailingTestsOnMerge = h.probe("passes");
  await h.run();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.merged, []);
  assert.deepEqual(h.fixed, [PR]);

  const g = fixture(t);
  g.rotate([prior(HEAD)]);
  g.write([{ ...health(), state: "green" }, { ts: at(30), step: "sweep.base_red.stood_down",
    pr_number: PR, head_sha: HEAD, check_name: CHECK }]);
  const base = harness(g.path);
  await base.run();
  assert.deepEqual(base.refreshed, [], "the once-per-head base-red arm also sees the archived refresh");
  assert.deepEqual(base.fixed, [PR]);
});

test("W1-T8533: incomplete and throwing unions name their sources and retain independent evidence", async t => {
  for (const kind of ["unread", "unclassified", "throws"] as const) {
    const f = fixture(t);
    f.write([health()]);
    const source = join(f.dir, "ledger.unknown");
    let reads = 0;
    const h = harness(f.path, { readRefreshLedgerUnion: () => {
      reads++;
      if (kind === "throws") throw new Error("history source disappeared");
      return { stateDir: f.dir, archiveFiles: [source], archiveCount: 1, liveFileRead: true, ok: true,
        unread: kind === "unread" ? [source] : [], unclassified: kind === "unclassified" ? [source] : [], matches: [] };
    } });
    h.deps.reproduceFailingTestsOnMerge = h.probe("fails");
    await h.run();
    assert.deepEqual(h.refreshed, []);
    assert.deepEqual(h.merged, [PR]);
    assert.equal(reads, 1);
    const row = h.clearance();
    assert.equal(row?.history, "unreadable");
    assert.equal(row?.evidence, "merged-probe");
    if (kind === "throws") {
      assert.deepEqual(row?.unread, [f.dir]);
      assert.match(String(row?.history_reason), /history source disappeared/);
    } else assert.deepEqual(row?.[kind], [source]);
  }
});

test("W1-T8533: a readable empty union proves absence and preserves the complete-history decision", async t => {
  const f = fixture(t);
  f.rotate([{ ts: at(30), step: "ci.polling", pr_number: PR + 1 }]);
  f.write([health()]);
  const h = harness(f.path);
  await h.run();
  assert.deepEqual(h.refreshed, [PR]);
  assert.equal(h.clearance()?.history, "union");
  assert.equal(h.clearance()?.evidence, "unrunnable");
});

test("W1-T8533: the stalled-stage arm reads its once-per-head outcome from the archive", async t => {
  const f = fixture(t);
  f.rotate([prior(HEAD)]);
  f.write([health(), { ts: at(50), run_id: "old", task_id: "W1-T8533", step: "sweep.disposed",
    pr_number: PR, head_sha: HEAD, disposition: "blocked-fixable", acted: false, blocker: "own-red", blocker_since: at(50) },
  { ts: at(20), step: "sweep.base_reproduction", pr_number: PR, head_sha: HEAD, main_sha: MAIN, verdict: "clear",
    files: [{ file: FILE, outcome: "passes", duration_ms: 1, cached: false }] }]);
  const h = harness(f.path, { actionable: () => false });
  h.deps.reproduceFailingTestsOnMerge = h.probe("passes");
  await h.run();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.merged, []);
  assert.deepEqual(h.escalations, []);
  const stuck = readLedgerLines(f.path).findLast(row => row.step === "pr.stuck" && row.pr_number === PR);
  assert.equal(stuck?.diagnosis, "fixed-on-main");
  assert.equal(stuck?.refresh_outcome, "updated");
});

test("W1-T8533: a fileless red with unknown history requires independent path evidence", async () => {
  for (const reach of [undefined, { counted: [], complete: true }]) {
    const result = await assessRefreshClearance({ failingTestFiles: [], reach, priorRefresh: undefined }, undefined);
    assert.equal(result.refresh, false);
    assert.equal(result.evidence, "fileless");
    assert.match(result.reason, /history.*unreadable/);
  }
  const reached = await assessRefreshClearance({ failingTestFiles: [], reach: { counted: [FILE], complete: true },
    priorRefresh: undefined }, undefined);
  assert.equal(reached.refresh, true);
  assert.deepEqual(reached.countedPaths, [FILE]);
  const complete = await assessRefreshClearance({ failingTestFiles: [], reach: undefined, priorRefresh: false }, undefined);
  assert.equal(complete.refresh, true);
});

test("W1-T8533: an inconclusive trial merge cannot refresh on unknown history alone", async () => {
  const other = "test/other.test.ts";
  const files = [FILE, other];
  const probes = [
    undefined,
    async () => { throw new Error("trial merge setup failed"); },
    async () => Object.assign([], { reason: "probe refused", setup_error: "merge conflict" }),
    async () => [{ file: FILE, outcome: "unrunnable" as const, duration_ms: 1, cached: false }],
    async () => [
      { file: FILE, outcome: "fails" as const, duration_ms: 1, cached: false },
      { file: other, outcome: "passes" as const, duration_ms: 1, cached: false },
    ],
  ];
  for (const probe of probes) {
    for (const reach of [undefined, { counted: [], complete: false }]) {
      const decision = await assessRefreshClearance({ failingTestFiles: files, reach, priorRefresh: undefined }, probe);
      assert.equal(decision.refresh, false);
      assert.match(decision.reason, /history.*unreadable/);
    }
    const reached = await assessRefreshClearance({ failingTestFiles: files,
      reach: { counted: [FILE], complete: true }, priorRefresh: undefined }, probe);
    assert.equal(reached.refresh, true, "main's changed paths provide independent evidence");
    const known = await assessRefreshClearance({ failingTestFiles: files, reach: undefined, priorRefresh: false }, probe);
    assert.equal(known.refresh, true, "complete history preserves the existing decision");
  }
});

test("W1-T8533: the sweep records an inconclusive probe with unreadable history and dispatches a fix", async t => {
  const f = fixture(t);
  f.write([health()]);
  const h = harness(f.path);
  h.deps.reproduceFailingTestsOnMerge = h.probe("unrunnable");
  await h.run();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.fixed, [PR]);
  assert.deepEqual(h.merged, [PR]);
  const row = h.clearance();
  assert.equal(row?.history, "unreadable");
  assert.equal(row?.merged_verdict, "unrunnable");
  assert.equal(row?.refresh, false);
  assert.match(String(row?.reason), /history.*unreadable/);
});

test("W1-T8533: the green-main base-red arm cannot treat unreadable refresh history as absence", async t => {
  for (const evidence of ["none", "delta", "probe"] as const) {
    const f = fixture(t);
    f.write([{ ...health(), state: "green" }, { ts: at(30), step: "sweep.base_red.stood_down",
      pr_number: PR, head_sha: HEAD, check_name: CHECK }]);
    const h = harness(f.path, evidence === "delta" ? {
      readRedBaseRefreshFacts: async () => ({ behindBy: 2, baseChangedFiles: [FILE] }),
    } : {});
    if (evidence === "probe") h.deps.reproduceFailingTestsOnMerge = h.probe("passes");
    await h.run();
    assert.deepEqual(h.refreshed, evidence === "none" ? [] : [PR]);
    assert.equal(h.clearance()?.history, "unreadable");
    assert.equal(h.clearance()?.arm, "base-red");
    assert.equal(h.clearance()?.refresh, evidence !== "none");
  }
});
