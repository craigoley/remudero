// test/an-evidence-gap-becomes-work.test.ts — W1-T4622: an evidence gap becomes work.
//
// Acceptance (plan/tasks.d/W1-T4622-an-evidence-gap-becomes-work.yaml):
//   - a lane whose coverage of a required evidence field falls below its trailing baseline gets
//     one dedup-keyed follow-up, and the gardener never gates a PR
//   - the new module is wired into its production caller (grep: runEvidenceCoverageGardener( in
//     src/run-task.ts)
//
// Every test writes only under its own mkdtemp root: no real ledger, no real state dir.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import type { Clock } from "../src/lib/clock.js";
import {
  benchmarkEvidenceByLane,
  daemonEvidenceCoverageDeps,
  EVIDENCE_COVERAGE_DROP_TOLERANCE,
  EVIDENCE_COVERAGE_MAX_FILINGS_PER_PASS,
  EVIDENCE_COVERAGE_MIN_DENOMINATOR,
  EVIDENCE_COVERAGE_PASS_INTERVAL_MS,
  evidenceCoverageFollowupId,
  evidenceCoverageStatePath,
  feedbackEvidenceCoverageFiler,
  judgeCoverageCell,
  laneFieldCoverage,
  runEvidenceCoverageGardener,
  startEvidenceCoverageGardener,
  type EvidenceCoverageDeps,
  type EvidenceCoverageFollowup,
} from "../src/lib/evidence-coverage-gardener.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { feedbackEntryPath } from "../src/lib/feedback.js";
import { ledgerLivePath } from "../src/lib/ledger-union.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { daemonCommand } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const T0 = Date.parse("2026-09-27T00:00:00.000Z");

function tmpState(): string {
  return mkdtempSync(join(tmpdir(), "rmd-evidence-coverage-"));
}

function clockAt(ref: { t: number }): Clock {
  return { now: () => ref.t, date: () => new Date(ref.t), iso: () => new Date(ref.t).toISOString() };
}

type Row = Record<string, unknown>;

function assignment(lane: string, id: string): Row {
  return {
    ts: "2026-09-26T12:00:00.000Z",
    step: "worker.assignment",
    lane,
    run_id: `run-${id}`,
    worker_assignment: { id, requested: { model: "sonnet" }, selected: { provider: "anthropic", model: "claude-x", effort: "high" } },
  };
}

function attempt(lane: string, id: string, opts: { served?: boolean } = {}): Row {
  return {
    ts: "2026-09-26T12:05:00.000Z",
    step: "worker.attempt",
    lane,
    run_id: `run-${id}`,
    selection_assignment_id: id,
    success: true,
    ...(opts.served === false ? {} : { served_model: "claude-x" }),
    tokens: { input: 10, output: 20 },
    worker_duration_ms: 1000,
    billing_mode: "api",
    total_cost_usd: 0.01,
  };
}

/** `n` joined calls in `lane`; the first `unserved` of them carry no served model. */
function calls(lane: string, n: number, unserved = 0, prefix = lane): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `${prefix}-${i}`;
    rows.push(assignment(lane, id), attempt(lane, id, { served: i >= unserved }));
  }
  return rows;
}

function harness(overrides: Partial<EvidenceCoverageDeps> = {}) {
  const ref = { t: T0 };
  const stateDir = tmpState();
  const rows: { current: Row[] } = { current: [] };
  const filed: EvidenceCoverageFollowup[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps: EvidenceCoverageDeps = {
    stateDir,
    readRows: () => ({ ok: true, rows: rows.current }),
    file: (followup) => {
      filed.push(followup);
    },
    log: (step, extra) => logs.push({ step, extra }),
    clock: clockAt(ref),
    ...overrides,
  };
  const pass = () => runEvidenceCoverageGardener(deps);
  const advance = () => {
    ref.t += EVIDENCE_COVERAGE_PASS_INTERVAL_MS;
  };
  return { ref, stateDir, rows, filed, logs, deps, pass, advance };
}

// ── the acceptance criterion ────────────────────────────────────────────────────────────────

test("a coverage drop below the lane's trailing baseline files exactly one dedup-keyed follow-up naming lane, field, denominator and first-seen time", () => {
  const h = harness();
  h.rows.current = calls("fix", 30);
  const first = h.pass();
  assert.equal(first.ran, true);
  assert.equal(h.filed.length, 0, "a healthy lane files nothing; its coverage becomes the baseline");

  h.advance();
  const firstSeen = new Date(h.ref.t).toISOString();
  h.rows.current = calls("fix", 30, 20);
  const second = h.pass();
  assert.equal(h.filed.length, 1, "one gap, one follow-up");
  const [followup] = h.filed;
  assert.equal(followup.id, "evidence-coverage-fix-served-model");
  assert.equal(followup.action, "file");
  assert.equal(followup.lane, "fix");
  assert.equal(followup.field, "servedModel");
  assert.match(followup.raw, /lane `fix`/);
  assert.match(followup.raw, /field `servedModel`/);
  assert.match(followup.raw, /10\/30 joined worker calls/);
  assert.match(followup.raw, /trailing baseline 100\.0%/);
  assert.ok(followup.raw.includes(`First seen: ${firstSeen}`));
  assert.match(followup.raw, /never gates a PR/);
  assert.deepEqual(second.gaps.map((g) => `${g.lane}/${g.field}/${g.kind}`), ["fix/servedModel/below-baseline"]);
  assert.deepEqual(second.filed, ["evidence-coverage-fix-served-model"]);
  const filedLog = h.logs.find((l) => l.step === "evidence_coverage.filed");
  assert.equal(filedLog?.extra?.id, "evidence-coverage-fix-served-model");
});

test("a repeat pass over a persisting gap updates the same follow-up rather than filing a duplicate, and keeps the first-seen time", () => {
  const h = harness();
  h.rows.current = calls("fix", 30);
  h.pass();
  h.advance();
  const firstSeen = new Date(h.ref.t).toISOString();
  h.rows.current = calls("fix", 30, 20);
  h.pass();

  h.advance();
  h.rows.current = calls("fix", 40, 30);
  const third = h.pass();
  assert.equal(h.filed.length, 2);
  assert.equal(h.filed[1].id, h.filed[0].id, "the dedup key is stable across passes");
  assert.equal(h.filed[1].action, "update");
  assert.ok(h.filed[1].raw.includes(`First seen: ${firstSeen}`), "the first-seen time survives the update");
  assert.match(h.filed[1].raw, /10\/40 joined worker calls/);
  assert.deepEqual(third.updated, [h.filed[0].id]);

  h.advance();
  const fourth = h.pass();
  assert.equal(h.filed.length, 2, "an unchanged gap is not re-filed");
  assert.deepEqual(fourth.filed, []);
  assert.deepEqual(fourth.updated, []);
  assert.equal(fourth.gaps.length, 1, "the gap is still reported while it persists");
});

test("the baseline is held while a gap is open, and a recovered lane clears the gap", () => {
  const h = harness();
  h.rows.current = calls("fix", 30);
  h.pass();
  h.advance();
  h.rows.current = calls("fix", 30, 20);
  h.pass();
  const state = JSON.parse(readFileSync(evidenceCoverageStatePath(h.stateDir), "utf8"));
  assert.equal(state.cells["fix/servedModel"].baseline, 1, "a gap never lowers the baseline it is judged against");

  h.advance();
  h.rows.current = calls("fix", 30);
  const recovered = h.pass();
  assert.deepEqual(recovered.gaps, []);
  assert.ok(h.logs.some((l) => l.step === "evidence_coverage.recovered" && l.extra?.field === "servedModel"));
  const after = JSON.parse(readFileSync(evidenceCoverageStatePath(h.stateDir), "utf8"));
  assert.equal(after.cells["fix/servedModel"].gap, undefined);
});

test("a thin lane is reported insufficient and files nothing, even with zero coverage", () => {
  const h = harness();
  h.rows.current = calls("thin", EVIDENCE_COVERAGE_MIN_DENOMINATOR - 1, EVIDENCE_COVERAGE_MIN_DENOMINATOR - 1);
  const result = h.pass();
  assert.equal(h.filed.length, 0);
  assert.deepEqual(result.gaps, []);
  assert.ok(result.insufficient.some((c) => c.lane === "thin" && c.field === "servedModel"));
});

test("a field absent from a sufficient lane is a gap on the first pass, with no baseline needed", () => {
  const h = harness();
  const rows: Row[] = [];
  for (let i = 0; i < 25; i += 1) rows.push({ ts: "2026-09-26T12:00:00.000Z", step: "verdict", lane: "review", run_id: `r-${i}`, model: "claude-x", success: true });
  h.rows.current = rows;
  const result = h.pass();
  assert.deepEqual(result.gaps.map((g) => `${g.lane}/${g.field}/${g.kind}`), ["review/assignment/absent"]);
  assert.equal(h.filed.length, 1);
  assert.match(h.filed[0].raw, /0\/25 terminal worker results/);
  assert.match(h.filed[0].raw, /absent/);
});

test("a filer failure is logged, never thrown, and the gap is retried on the next pass", () => {
  let fail = true;
  const attempts: EvidenceCoverageFollowup[] = [];
  const h = harness({
    file: (followup) => {
      attempts.push(followup);
      if (fail) throw new Error("landing unreachable");
    },
  });
  h.rows.current = calls("fix", 30);
  h.pass();
  h.advance();
  h.rows.current = calls("fix", 30, 20);
  const failed = h.pass();
  assert.deepEqual(failed.failed, ["evidence-coverage-fix-served-model"]);
  assert.deepEqual(failed.filed, []);
  const log = h.logs.find((l) => l.step === "evidence_coverage.filing_failed");
  assert.equal(log?.extra?.id, "evidence-coverage-fix-served-model");
  assert.match(String(log?.extra?.error), /landing unreachable/);

  fail = false;
  h.advance();
  const retried = h.pass();
  assert.deepEqual(retried.filed, ["evidence-coverage-fix-served-model"]);
  assert.equal(attempts[1].action, "file", "a follow-up never filed is filed, not updated");
});

test("a pass inside the cadence interval is skipped without reading the ledger", () => {
  let reads = 0;
  const h = harness({
    readRows: () => {
      reads += 1;
      return { ok: true, rows: [] };
    },
  });
  h.pass();
  const again = h.pass();
  assert.equal(again.ran, false);
  assert.equal(again.skipped, "not-due");
  assert.equal(reads, 1);
});

test("the gardener's own source failure is visible and becomes one dedup-keyed repair follow-up", () => {
  const h = harness({ readRows: () => ({ ok: false, reason: "ledger union incomplete: 1 unread" }) });
  const first = h.pass();
  assert.equal(first.sourceUnavailable, "ledger union incomplete: 1 unread");
  assert.equal(h.filed.length, 1);
  assert.equal(h.filed[0].id, "evidence-coverage-gardener-source");
  assert.match(h.filed[0].raw, /ledger union incomplete: 1 unread/);
  assert.ok(h.logs.some((l) => l.step === "evidence_coverage.source_unavailable"));

  h.advance();
  h.pass();
  assert.equal(h.filed.length, 1, "the same source failure is not re-filed");

  const thrown = harness({
    readRows: () => {
      throw new Error("EIO reading rotation");
    },
  });
  const result = thrown.pass();
  assert.match(String(result.sourceUnavailable), /EIO reading rotation/);
  assert.equal(thrown.filed[0].id, "evidence-coverage-gardener-source");

  h.deps.readRows = () => ({ ok: true, rows: [] });
  h.advance();
  h.pass();
  assert.ok(h.logs.some((l) => l.step === "evidence_coverage.source_recovered"));
});

test("a systemic gap files at most the per-pass cap and defers the rest to the next pass", () => {
  const h = harness();
  const rows: Row[] = [];
  const lanes = EVIDENCE_COVERAGE_MAX_FILINGS_PER_PASS + 2;
  for (let l = 0; l < lanes; l += 1) {
    for (let i = 0; i < 25; i += 1) rows.push({ ts: "2026-09-26T12:00:00.000Z", step: "worker.attempt", lane: `lane-${l}`, run_id: `r-${l}-${i}` });
  }
  h.rows.current = rows;
  const first = h.pass();
  assert.equal(first.filed.length, EVIDENCE_COVERAGE_MAX_FILINGS_PER_PASS);
  assert.equal(first.deferred, 2);
  h.advance();
  const second = h.pass();
  assert.equal(second.filed.length, 2);
  assert.equal(new Set(h.filed.map((f) => f.id)).size, lanes, "every lane gets exactly one follow-up");
});

test("an unreadable state file restarts from an empty baseline and says so", () => {
  const h = harness();
  mkdirSync(h.stateDir, { recursive: true });
  writeFileSync(evidenceCoverageStatePath(h.stateDir), "{not json");
  const result = h.pass();
  assert.equal(result.ran, true);
  assert.ok(h.logs.some((l) => l.step === "evidence_coverage.state_unreadable"));
});

// ── the pure pieces ─────────────────────────────────────────────────────────────────────────

test("judgeCoverageCell separates insufficient, healthy, below-baseline and absent", () => {
  assert.deepEqual(judgeCoverageCell({ observed: 0, denominator: EVIDENCE_COVERAGE_MIN_DENOMINATOR - 1 }, 1), { kind: "insufficient" });
  assert.deepEqual(judgeCoverageCell({ observed: 0, denominator: 20 }, undefined), { kind: "gap", gap: "absent" });
  assert.deepEqual(judgeCoverageCell({ observed: 18, denominator: 20 }, undefined), { kind: "healthy", ratio: 0.9 });
  assert.deepEqual(judgeCoverageCell({ observed: 18, denominator: 20 }, 0.9 + EVIDENCE_COVERAGE_DROP_TOLERANCE - 0.01), { kind: "healthy", ratio: 0.9 });
  assert.deepEqual(judgeCoverageCell({ observed: 10, denominator: 20 }, 0.9), { kind: "gap", gap: "below-baseline" });
});

test("benchmarkEvidenceByLane joins terminals to their assignment's lane and keeps unjoined ones in their own", () => {
  const rows: Row[] = [
    { ts: "2026-09-26T11:00:00.000Z", step: "run.start", run_id: "run-typed", type: "implement", task_class: "code", risk: "low" },
    { ...assignment("x", "typed"), lane: undefined },
    attempt("other", "typed"),
    { ...attempt("other", "typed") },
    { ts: "2026-09-26T12:00:00.000Z", step: "verdict", run_id: "run-typed", selection_assignment_id: "typed", success: false },
    assignment("fix", "dup"),
    assignment("fix", "dup"),
    { ts: "2026-09-26T12:00:00.000Z", step: "worker.assignment", lane: "fix", worker_assignment: { id: "bad" } },
    { ts: "2026-09-26T12:00:00.000Z", step: "worker.attempt", lane: "fix", selection_assignment_id: "orphan", assignment_observed: false },
    { ts: "2026-09-26T12:00:00.000Z", step: "worker.attempt", run_id: "nobody", selection_assignment_id: "unmatched" },
    { ts: "2026-09-26T12:00:00.000Z", step: "verdict", lane: "fix" },
  ];
  const byLane = benchmarkEvidenceByLane(rows, "2026-09-27T00:00:00.000Z");
  const implement = byLane.get("implement");
  assert.equal(implement?.assignments, 1, "a row with no lane takes its run's type");
  assert.equal(implement?.joinedTerminalOutcomes, 1, "the attempt joins the assignment's lane, not its own");
  assert.equal(implement?.outcomes.success, 1, "an attempt wins over the run's verdict");
  assert.equal(byLane.get("other")?.duplicates.terminalRows, 1);
  const fix = byLane.get("fix");
  assert.equal(fix?.duplicates.assignmentRows, 1);
  assert.equal(fix?.sourceRows.invalidAssignments, 1);
  assert.equal(fix?.sourceRows.terminalsWithoutAssignmentId, 1);
  assert.equal(byLane.get("unknown")?.terminalsWithoutAssignment, 1);
  const coverage = laneFieldCoverage(implement!);
  assert.deepEqual(coverage.assignment, { observed: 1, denominator: 1 });
  assert.deepEqual(coverage.servedModel, { observed: 1, denominator: 1 });
});

test("the follow-up id is a stable, path-safe dedup key", () => {
  assert.equal(evidenceCoverageFollowupId("fix", "servedModel"), "evidence-coverage-fix-served-model");
  assert.equal(evidenceCoverageFollowupId("Fix Lane/2", "cost"), "evidence-coverage-fix-lane-2-cost");
  assert.equal(evidenceCoverageFollowupId("***", "tokens"), "evidence-coverage-unknown-tokens");
});

// ── the production seams ────────────────────────────────────────────────────────────────────

test("the feedback filer captures a new follow-up once and lands an update without resetting its status", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-evidence-coverage-root-"));
  const gitCalls: string[][] = [];
  const git = (args: string[]): string => {
    gitCalls.push(args);
    throw new Error("offline in this fixture");
  };
  const gh = (): string => {
    throw new Error("offline in this fixture");
  };
  const file = feedbackEvidenceCoverageFiler(root, { git, gh });
  file({ id: "evidence-coverage-fix-cost", action: "file", lane: "fix", field: "cost", raw: "first body" });
  const path = feedbackEntryPath(root, "evidence-coverage-fix-cost");
  assert.ok(existsSync(path));
  const entry = parseYaml(readFileSync(path, "utf8"));
  assert.equal(entry.raw, "first body");
  assert.equal(entry.status, "new");

  gitCalls.length = 0;
  file({ id: "evidence-coverage-fix-cost", action: "update", lane: "fix", field: "cost", raw: "second body" });
  assert.ok(gitCalls.length > 0, "an update goes through the landing path, never a local rewrite of a tracked entry");
  assert.equal(parseYaml(readFileSync(path, "utf8")).raw, "first body");
});

test("the daemon deps read the windowed ledger union and refuse an incomplete one", () => {
  const stateDir = tmpState();
  writeFileSync(
    ledgerLivePath(stateDir),
    [
      JSON.stringify(assignment("fix", "a1")),
      JSON.stringify({ ts: "2026-09-26T12:00:00.000Z", step: "noise", lane: "fix" }),
      JSON.stringify({ ts: "2026-09-01T12:00:00.000Z", step: "worker.attempt", lane: "fix" }),
    ].join("\n") + "\n",
  );
  const deps = daemonEvidenceCoverageDeps({ stateDir, root: stateDir, log: () => {} });
  const read = deps.readRows("2026-09-20T00:00:00.000Z");
  assert.equal(read.ok, true);
  assert.deepEqual(read.ok ? read.rows.map((r) => r.step) : [], ["worker.assignment"]);

  writeFileSync(join(stateDir, "ledger.2026-09-26T00-00-00-000Z.ndjson.gz"), "not gzip");
  const broken = deps.readRows("2026-09-20T00:00:00.000Z");
  assert.equal(broken.ok, false);
  assert.match(broken.ok ? "" : broken.reason, /1 unread/);
});

test("the starter runs a pass at once, logs a failed pass, and stops", () => {
  const logs: string[] = [];
  let runs = 0;
  const garden = startEvidenceCoverageGardener(
    () => {
      runs += 1;
      throw new Error("boom");
    },
    (step) => logs.push(step),
    60 * 60 * 1000,
  );
  garden.stop();
  assert.equal(runs, 1);
  assert.deepEqual(logs, ["evidence_coverage.gardener_failed"]);
});

test("the daemon starts the evidence-coverage gardener among its gardens", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const gardens = source.indexOf("gardens: [");
  const call = source.indexOf("runEvidenceCoverageGardener(daemonEvidenceCoverageDeps(");
  const sre = source.indexOf("startSreLane(", gardens);
  assert.ok(gardens > 0 && call > gardens && call < sre, "the call sits inside the daemon's gardens list");
  assert.match(source, /startEvidenceCoverageGardener\(\s*\(\) => runEvidenceCoverageGardener\(/);
});

test("a self-hosting daemon's eighth garden runs an evidence-coverage pass against its own state dir", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4622-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, d): Promise<DaemonSummary> => {
        captured = d;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    // plan, gate, test, config, export, ci-friction, selector-shadow, then this gardener.
    const start = captured?.gardens?.[7];
    assert.ok(start, "an eighth garden is wired after the selector-shadow gardener");
    start!(60 * 60 * 1000).stop();
    const state = JSON.parse(readFileSync(evidenceCoverageStatePath(join(root, "state")), "utf8"));
    assert.equal(typeof state.lastPassAt, "string", "the pass ran at once and recorded itself in the daemon's state dir");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
