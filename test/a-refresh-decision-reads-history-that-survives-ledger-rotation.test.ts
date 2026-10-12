// @source-text-subject: the refresh census inventories literal and constant ledger-step reads.
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DECISION_RELEVANT_LEDGER_STEPS, MAX_RETAINED_LINES_PER_STEP, rotateLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { assessRefreshClearance, refusedRefreshClearancesFromLedger } from "../src/lib/base-reproduction.js";

type Row = Record<string, unknown>;
const KNOWN = ["fix.base_refreshed", "sweep.base_red.refresh", "sweep.base_fixed.refresh", "refresh.clearance"];
const PR = 8533;
const MAIN = "3".repeat(40);
const HEAD = "4".repeat(40);
const FILE = "test/example.test.ts";
const CHECK = "ci";
const ROOT = new URL("../", import.meta.url);

function sourceTree(dir: URL): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    return entry.isDirectory() ? sourceTree(path) : entry.name.endsWith(".ts") ? [readFileSync(path, "utf8")] : [];
  });
}

function refreshSteps(consumers: readonly string[], declarations: readonly string[]): Set<string> {
  const constants = new Map<string, string>();
  for (const text of declarations) {
    for (const match of text.matchAll(/export\s+const\s+(\w+)\s*=\s*(["'])([^"']+)\2/g)) {
      constants.set(match[1], match[3]);
    }
  }
  const steps = new Set<string>();
  for (const text of consumers) {
    for (const match of text.matchAll(/\.step\s*(?:===|!==)\s*(?:(["'])([^"']+)\1|([A-Za-z_$][\w$]*))/g)) {
      const value = match[2] ?? constants.get(match[3]);
      if (value?.includes("refresh")) steps.add(value);
    }
  }
  return steps;
}

function census(): Set<string> {
  return refreshSteps(["src/lib/sweep.ts", "src/run-task.ts", "src/lib/base-reproduction.ts"]
    .map(path => readFileSync(new URL(path, ROOT), "utf8")), sourceTree(new URL("src/", ROOT)));
}

test("W1-T8533: every step a refresh decision reads is in the retention set", () => {
  const missing = [...census()].filter(step => !DECISION_RELEVANT_LEDGER_STEPS.has(step));
  assert.deepEqual(missing, [], `unretained refresh reads: ${missing.join(", ")}`);
});

test("W1-T8533: the refresh census finds the four known steps and reports an unretained one", () => {
  const found = census();
  for (const step of KNOWN) assert.ok(found.has(step), `census missed ${step}`);
  const fixture = 'export const NEW_REFRESH_STEP = "new.unretained.refresh";';
  const missing = [...refreshSteps(['row.step === NEW_REFRESH_STEP; row.step !== "literal.refresh";'], [fixture])]
    .filter(step => !DECISION_RELEVANT_LEDGER_STEPS.has(step));
  assert.deepEqual(missing, ["new.unretained.refresh", "literal.refresh"]);
});

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-refresh-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const now = Date.now();
  const stamp = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const row = (extra: Row, minutes = 60): Row => ({ ts: stamp(minutes), run_id: "fixture", task_id: "W1-T8533", ...extra });
  const prior = row({ step: "sweep.base_fixed.refresh", pr_number: PR, head_sha: "1".repeat(40),
    outcome: "updated", test_files: [FILE], check_names: [CHECK] });
  const coverage = KNOWN.map((step, index) => row({ step, pr_number: 9000 + index, head_sha: HEAD, outcome: "skipped" }, 120));
  const health = row({ step: "main.health.observed", sha: MAIN, state: "undetermined" }, 1);
  const rotate = (rows: Row[]) => {
    const noise = Array.from({ length: 100 }, (_, n) => row({ step: "ci.polling", detail: "x".repeat(300), n }, 1));
    writeFileSync(ledgerPath, [...rows, ...noise].map(line => JSON.stringify(line)).join("\n") + "\n");
    const rotated = rotateLedger(ledgerPath, { ceilingBytes: 20_000, smoothingWindowMs: 0 });
    assert.equal(rotated.rotated, true);
    assert.ok(rotated.archivePath);
    return rotated.archivePath!;
  };
  const refreshed: number[] = [];
  const fixed: number[] = [];
  const probes: number[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, postReview: async () => {}, escalate: () => {},
    dispatchFix: pr => { fixed.push(pr.prNumber); },
    updateBranch: pr => { refreshed.push(pr.prNumber); return "updated"; },
    reproduceFailingTestsOnMain: async (_pr, files) => files.map(file => ({ file, outcome: "passes", duration_ms: 1, cached: false })),
    reproduceFailingTestsOnMerge: async (pr, files) => {
      probes.push(pr.prNumber);
      return files.map(file => ({ file, outcome: "passes", duration_ms: 1, cached: false }));
    },
    readTestImportClosure: async () => new Map([[FILE, new Set([FILE])]]),
    behindMainByPr: new Map([[PR, 2]]), ledgerPath, runId: "W1-T8533-test", now: () => now, readMainTip: () => MAIN,
  };
  const pr: OpenPrView = {
    prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: "W1-T8533",
    reviewState: "pending", checksState: "red", unmetCriteria: [], priorStrikes: 0, lastActivityAt: stamp(1),
    createdAt: stamp(90), headSha: HEAD, headRefName: "run-W1-T8533-1", autoMergeArmed: false,
    ciFailures: [{ name: CHECK, logTail: `not ok 1 - ${FILE}` }],
  };
  const peer: OpenPrView = { ...pr, prNumber: 6000, prUrl: "https://github.com/acme/remudero/pull/6000",
    taskId: "W1-T6000", headRefName: "run-W1-T6000-1", checksState: "green", reviewState: "success", ciFailures: [] };
  const pass = (over: Partial<OpenPrView> = {}) => runSweep([{ ...pr, ...over }, peer], deps, DEFAULT_SWEEP_POLICY);
  const clearance = () => readLedgerLines(ledgerPath).findLast(line => line.step === "refresh.clearance" && line.pr_number === PR);
  return { dir, ledgerPath, stamp, row, prior, coverage, health, rotate, refreshed, fixed, probes, deps, pr, pass, clearance };
}

test("W1-T8533: a refresh row survives rotation and still refuses a second refresh on the same red", async t => {
  const h = fixture(t);
  const archive = h.rotate([...h.coverage, h.prior, h.health]);
  assert.ok(readLedgerLines(h.ledgerPath).some(line => line.step === "sweep.base_fixed.refresh" && line.pr_number === PR));
  // A covered PR must not consult even a corrupt archive.
  writeFileSync(archive, "unreadable gzip");
  await h.pass();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.fixed, [PR]);
  assert.equal(h.clearance()?.evidence, "repeat");
  assert.equal(h.clearance()?.history, "live");
});

test("W1-T8533: a PR older than the live window reads its refresh history from the rotations", async t => {
  const h = fixture(t);
  const newer = Array.from({ length: MAX_RETAINED_LINES_PER_STEP }, (_, index) => h.row({
    step: "sweep.base_fixed.refresh", pr_number: 10_000 + index, head_sha: HEAD, outcome: "updated", test_files: [FILE],
  }, 30));
  h.rotate([h.prior, ...newer, h.health]);
  assert.equal(readLedgerLines(h.ledgerPath).some(line => line.step === "sweep.base_fixed.refresh" && line.pr_number === PR), false);
  await h.pass();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.fixed, [PR]);
  assert.equal(h.clearance()?.evidence, "repeat");
  assert.equal(h.clearance()?.history, "union");
});

test("W1-T8533: an unreadable refresh history is named and never read as no prior refresh", async t => {
  for (const failure of ["corrupt", "unclassified", "absent"] as const) {
    const h = fixture(t);
    const archive = h.rotate([h.health]);
    let unreadSource: string;
    if (failure === "corrupt") { writeFileSync(archive, "broken gzip"); unreadSource = archive; }
    else if (failure === "unclassified") { unreadSource = join(h.dir, "ledger.unknown"); writeFileSync(unreadSource, "{}\n"); }
    else { rmSync(archive); unreadSource = h.dir; }
    h.deps.reproduceFailingTestsOnMerge = undefined;
    await h.pass();
    assert.deepEqual(h.refreshed, [], failure);
    assert.deepEqual(h.fixed, [PR]);
    assert.equal(h.clearance()?.history, "unreadable");
    assert.equal(h.clearance()?.refresh, false);
    assert.ok((h.clearance()?.unread_sources as string[]).includes(unreadSource));
    assert.match(String(h.clearance()?.reason), /history/i);
  }
});

test("W1-T8533: an unreadable history still uses the prefilter and a readable merged probe", async t => {
  for (const outcome of ["passes", "fails", "unrunnable"] as const) {
    const h = fixture(t);
    const archive = h.rotate([h.health]);
    writeFileSync(archive, "broken gzip");
    h.deps.reproduceFailingTestsOnMerge = async (pr, files) => {
      h.probes.push(pr.prNumber);
      return files.map(file => ({ file, outcome, duration_ms: 1, cached: false }));
    };
    await h.pass({ createdAt: undefined });
    assert.deepEqual(h.probes, [PR]);
    assert.deepEqual(h.refreshed, outcome === "passes" ? [PR] : []);
    assert.equal(h.clearance()?.history, "unreadable");
    assert.equal(h.clearance()?.merged_verdict, outcome === "passes" ? "clear" : outcome === "fails" ? "reproduced" : "unrunnable");
  }
  const h = fixture(t);
  h.rotate([h.health]);
  h.deps.readRedBaseRefreshFacts = async () => ({ behindBy: 2, baseChangedFiles: ["plan/unrelated.yaml"] });
  await h.pass();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.probes, []);
  assert.equal(h.clearance()?.history, "union");
  assert.equal(h.clearance()?.evidence, "prefilter");
});

test("W1-T8533: an archived refusal memo is reused without probing", async t => {
  const h = fixture(t);
  h.rotate([h.row({ step: "refresh.clearance", pr_number: PR, head_sha: HEAD, main_sha: MAIN,
    refresh: false, evidence: "merged-probe", test_files: [FILE] }), h.health]);
  writeFileSync(h.ledgerPath, JSON.stringify(h.health) + "\n");
  await h.pass();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.fixed, [PR]);
});

test("W1-T8533: refresh history is read once per PR per pass and reused by the clearance", async t => {
  const h = fixture(t);
  h.deps.readLedgerUnion = () => ({ complete: true, lines: [] });
  const archive = h.rotate([h.prior, h.health]);
  writeFileSync(h.ledgerPath, JSON.stringify(h.health) + "\n");
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    if (args[0] === archive) reads++;
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await h.pass();
  assert.equal(reads, 1, "the refresh candidate and its clearance share one union read");
  assert.equal(h.clearance()?.history, "union");
  assert.deepEqual(h.refreshed, []);
});

test("W1-T8533: the union restores the once-per-head refresh guard", async t => {
  const h = fixture(t);
  h.rotate([{ ...h.prior, head_sha: HEAD, outcome: "head-moved" }, h.health]);
  writeFileSync(h.ledgerPath, JSON.stringify(h.health) + "\n");
  await h.pass();
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.fixed, [PR]);
});

test("W1-T8533: incomplete history cannot authorize a fileless, partial or failed probe refresh", async () => {
  const fileless = await assessRefreshClearance({ failingTestFiles: [], reach: undefined, priorRefresh: undefined }, undefined);
  assert.equal(fileless.refresh, false);
  assert.equal(fileless.evidence, "fileless");
  assert.match(fileless.reason, /history is unreadable/);
  const files = [FILE, "test/second.test.ts"];
  const partial = await assessRefreshClearance({ failingTestFiles: files, reach: undefined, priorRefresh: undefined }, async () =>
    files.map((file, index) => ({ file, outcome: index === 0 ? "fails" : "passes", duration_ms: 1, cached: false })));
  assert.equal(partial.refresh, false);
  assert.equal(partial.evidence, "partial");
  assert.match(partial.reason, /history is unreadable/);
  const failed = await assessRefreshClearance({ failingTestFiles: [FILE], reach: undefined, priorRefresh: undefined }, async () => {
    throw new Error("merge setup refused");
  });
  assert.equal(failed.refresh, false);
  assert.equal(failed.evidence, "unrunnable");
  assert.match(failed.reason, /merge setup refused/);
});

test("W1-T8533: the base-red arm cannot refresh on an unreadable history without merge evidence", async t => {
  const h = fixture(t);
  const archive = h.rotate([
    h.row({ step: "sweep.base_red.stood_down", pr_number: PR, head_sha: HEAD, check_name: CHECK }),
    h.row({ step: "main.health.observed", sha: MAIN, state: "green", failing_checks: [] }, 1),
  ]);
  writeFileSync(archive, "broken gzip");
  h.deps.reproduceFailingTestsOnMerge = undefined;
  await h.pass();
  assert.deepEqual(h.refreshed, []);
  assert.equal(h.clearance()?.arm, "base-red");
  assert.equal(h.clearance()?.history, "unreadable");
  assert.equal(h.clearance()?.refresh, false);
});

test("W1-T8533: unreadable history alone never becomes a settled refusal memo", () => {
  for (const evidence of ["fileless", "partial", "unrunnable", "repeat", "prefilter", "merged-probe"]) {
    const row = { step: "refresh.clearance", pr_number: PR, head_sha: HEAD, main_sha: MAIN,
      refresh: false, test_files: [FILE], history: "unreadable", evidence };
    const memo = refusedRefreshClearancesFromLedger([row]);
    assert.equal(memo.size, ["repeat", "prefilter", "merged-probe"].includes(evidence) ? 1 : 0, evidence);
    assert.equal(refusedRefreshClearancesFromLedger([{ ...row, history: "live" }]).size, 1, evidence);
  }
});

test("W1-T8533: a complete live history preserves the unwired-probe fallback", async t => {
  const h = fixture(t);
  h.rotate([...h.coverage, h.health]);
  h.deps.reproduceFailingTestsOnMerge = undefined;
  await h.pass();
  assert.deepEqual(h.refreshed, [PR]);
  assert.deepEqual(h.fixed, []);
  assert.equal(h.clearance()?.history, "live");
  assert.equal(h.clearance()?.evidence, "unrunnable");
  assert.equal(h.clearance()?.refresh, true);
});

test("W1-T8533: a complete history preserves the main-green base-red refresh", async t => {
  const h = fixture(t);
  h.rotate([...h.coverage,
    h.row({ step: "sweep.base_red.stood_down", pr_number: PR, head_sha: HEAD, check_name: CHECK }),
    h.row({ step: "main.health.observed", sha: MAIN, state: "green", failing_checks: [] }, 1),
  ]);
  h.deps.reproduceFailingTestsOnMerge = undefined;
  await h.pass();
  assert.deepEqual(h.refreshed, [PR]);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.fixed, []);
});
