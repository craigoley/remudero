// W1-T5904 — the flow gardener measures each PR stage from the ledger and GitHub once a day, compares
// it with a 7-day baseline per PR class, and files ONE follow-up per stage that slowed past the factor.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  FLOW_FILINGS_PER_DAY_MAX,
  FLOW_REGRESSION_FACTOR,
  FLOW_REPORT_FILE,
  flowCiReader,
  flowPassDue,
  readFlowLedger,
  runFlowGardener,
  type FlowGardenSources,
  type FlowStageStat,
} from "../src/lib/flow-gardener.js";
import { flowGardenPass, gardenSchedule, REGISTERED_GARDEN_NAMES } from "../src/lib/garden-registry.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { lintTask } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const URL = (n: number) => `https://github.com/acme/remudero/pull/${n}`;
const at = (ms: number) => new Date(ms).toISOString();

type Row = Record<string, unknown>;

interface PrSpec {
  n: number;
  cls: "plan" | "code" | "gardener";
  mergedMs: number;
  /** Minutes from open to merge. */
  ttm: number;
  /** Minutes from the last successful review to merge. */
  ready: number;
  armSurface?: "light";
  /** [eligible→admitted minutes, surface] per review admission. */
  reviews?: Array<[number, "light" | "full" | undefined]>;
  heads?: number;
  updates?: number;
  fixes?: number;
}

/** The ledger rows one merged PR leaves, in the shapes the live ledger writes them. */
function prRows(p: PrSpec): Row[] {
  const task = `W1-T${p.n}`;
  const opened = p.mergedMs - p.ttm * MIN;
  const runId = p.cls === "gardener" ? "GARDEN-plan-1" : `${task}-1`;
  const heads = Array.from({ length: p.heads ?? 1 }, (_, i) => `${p.n}head${i}`);
  const rows: Row[] = [];
  if (p.cls === "gardener") {
    rows.push({ ts: at(opened), run_id: runId, task_id: "DAEMON", step: "plan.miss_filed", pr_url: URL(p.n) });
  } else {
    rows.push({ ts: at(opened), run_id: runId, task_id: task, step: "pr.opened", pr_url: URL(p.n), head_sha: heads[0], ...(p.cls === "plan" ? { plan_only: true } : {}) });
  }
  (p.reviews ?? [[2, undefined]]).forEach(([wait, surface], i) => {
    const eligible = opened + (i + 1) * MIN;
    const key = `input:${p.n}:${i}`;
    const s = surface === undefined ? {} : { surface };
    rows.push({ ts: at(eligible), run_id: "DAEMON-1", task_id: task, step: "sweep.review_eligible", pr_number: p.n, pr_url: URL(p.n), head_sha: heads.at(-1), review_key: key, ...s });
    rows.push({ ts: at(eligible + wait * MIN), run_id: "DAEMON-1", task_id: task, step: "sweep.review_admitted", pr_number: p.n, pr_url: URL(p.n), head_sha: heads.at(-1), review_key: key, ...s });
  });
  heads.slice(1).forEach((head, i) => rows.push({ ts: at(opened + (i + 2) * MIN), run_id: "DAEMON-1", task_id: task, step: "sweep.disposed", pr_number: p.n, head_sha: head, arm_surface: p.armSurface ?? "full" }));
  for (let i = 0; i < (p.updates ?? 0); i++) {
    rows.push({ ts: at(opened + 3 * MIN), run_id: "DAEMON-1", task_id: task, step: "sweep.update_branch.updated", pr_number: p.n, pr_url: URL(p.n), head_sha: heads.at(-1) });
  }
  for (let i = 0; i < (p.fixes ?? 0); i++) rows.push({ ts: at(opened + 4 * MIN), run_id: "DAEMON-1", task_id: task, step: "fix.dispatch", head_sha: heads.at(-1) });
  const readyMs = p.mergedMs - p.ready * MIN;
  rows.push({ ts: at(readyMs), run_id: `review-PR${p.n}-1`, task_id: task, step: "review.posted", state: "success", pr_url: URL(p.n), head_sha: heads.at(-1) });
  rows.push({ ts: at(readyMs + 1000), run_id: `review-PR${p.n}-1`, task_id: task, step: "automerge.armed", pr_number: p.n, pr_url: URL(p.n), head_sha: heads.at(-1) });
  if (p.armSurface) rows.push({ ts: at(readyMs + 2000), run_id: "DAEMON-1", task_id: task, step: "sweep.disposed", pr_number: p.n, pr_url: URL(p.n), head_sha: heads.at(-1), arm_surface: p.armSurface });
  rows.push({ ts: at(p.mergedMs + MIN), run_id: "DAEMON-1", task_id: "SWEEP", step: "pr.terminal", pr_number: p.n, pr_url: URL(p.n), state: "merged", merged_at: at(p.mergedMs) });
  return rows;
}

/** Six baseline PRs per class (merged 2..6 days ago) and four current ones (merged in the last hours). */
function corpus(over: { planReady?: number[]; codeReady?: number[]; codeTtm?: number[] } = {}): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 6; i++) {
    const mergedMs = NOW - (2 + (i % 5)) * DAY;
    rows.push(...prRows({ n: 8000 + i, cls: "plan", mergedMs, ttm: 30, ready: 10 }));
    rows.push(...prRows({ n: 8100 + i, cls: "code", mergedMs, ttm: 40, ready: 5, reviews: [[3, "full"]] }));
  }
  const planReady = over.planReady ?? [20, 25, 30, 40];
  const codeReady = over.codeReady ?? [5, 5, 6, 4];
  const codeTtm = over.codeTtm ?? [42, 41, 44, 40];
  for (let i = 0; i < 4; i++) {
    const mergedMs = NOW - (i + 1) * HOUR;
    rows.push(...prRows({ n: 9100 + i, cls: "plan", mergedMs, ttm: 45, ready: planReady[i]! }));
    rows.push(...prRows({ n: 9200 + i, cls: "code", mergedMs, ttm: codeTtm[i]!, ready: codeReady[i]!, reviews: [[4, "full"]] }));
  }
  return rows;
}

function harness(rows: Row[], opts: { clockMs?: number; plan?: () => Array<{ id: string; origin?: string; status?: string; retirement?: string }> } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-gardener-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const events: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let clockMs = opts.clockMs ?? NOW;
  const deps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    get clock() { return fixedClock(clockMs); },
    openWorkspace: () => ({
      root,
      branch: "flow-garden-1",
      land: (o: { paths: string[]; title: string; body: string }) => (landed.push(o), URL(9900 + landed.length)),
      dispose: () => {},
    }),
    log: (step: string, extra: Record<string, unknown> = {}) => { events.push({ step, extra }); },
    // lint-plan refuses today's flow follow-up (verify: human outside every parked machine shape, a new
    // test file admission does not allow, and a sizing span its shard name does not own), so the real
    // landing guard records a filing failure. These cases test what follows a landing, so the guard
    // stands down here; the refusal is its own defect.
    landingRefusal: () => undefined,
  };
  let minted = 0;
  const ciReads: string[] = [];
  const sources: FlowGardenSources = {
    readLedger: () => ({ ok: true, rows, unread: [] }),
    readCi: async (headSha) => {
      ciReads.push(headSha);
      return { minutes: 20, doneMs: NOW - 30 * DAY };
    },
    planTasks: opts.plan ?? (() => []),
    mintTaskId: () => `W1-T97${String(++minted).padStart(2, "0")}`,
  };
  const steps = (step: string) => events.filter((e) => e.step === step);
  const stat = (key: string): FlowStageStat | undefined =>
    (steps("flow.report").at(-1)?.extra.stages as FlowStageStat[] | undefined)?.find((s) => s.key === key);
  return {
    root, landed, events, deps, sources, steps, stat, ciReads,
    setClock: (ms: number) => { clockMs = ms; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("the flow gardener's real landing guard records a follow-up lint-plan refuses as a filing failure, never a PR", async (t) => {
  const h = harness(corpus());
  t.after(h.cleanup);
  const { landingRefusal: _standDown, ...guarded } = h.deps;
  await runFlowGardener(guarded, h.sources);
  assert.equal(h.landed.length, 0, "a refused follow-up never opens its PR");
  assert.match(String(h.steps("flow.filing_failed")[0]?.extra.error), /machine-filing admission/);
  void _standDown;
});

test("over a fixture ledger the flow gardener reports per-class stage p50/p90 and baselines and files one follow-up for a doubled plan ready-to-merged stage naming its three slowest PRs", async (t) => {
  const h = harness(corpus());
  t.after(h.cleanup);
  const pass = await runFlowGardener(h.deps, h.sources);
  assert.equal(pass.ran, true);

  const ready = h.stat("plan:ready_to_merged:full");
  assert.deepEqual(ready?.current, { n: 4, p50: 25, p90: 40 });
  assert.deepEqual(ready?.baseline, { n: 6, p50: 10, p90: 10, source: "rolling" });
  assert.equal(ready?.regressed, true);
  // A stable stage beside it: plan time-to-merge 45 against 30 is under the factor.
  assert.deepEqual(h.stat("plan:time_to_merge:all")?.current, { n: 4, p50: 45, p90: 45 });
  assert.equal(h.stat("plan:time_to_merge:all")?.regressed, false);
  assert.equal(h.stat("code:ready_to_merged:full")?.regressed, false);

  assert.equal(h.landed.length, 1, "exactly one follow-up is filed");
  assert.match(h.landed[0]!.title, /^chore\(plan\): file the plan ready_to_merged flow regression/);
  const shard = readFileSync(join(h.root, h.landed[0]!.paths[0]!), "utf8");
  assert.match(shard, /origin: "flow-regression:plan:ready_to_merged:full"/);
  assert.match(shard, /#9103 \(40 min\), #9102 \(30 min\), #9101 \(25 min\)/, "the three slowest PRs are named, slowest first");
  assert.doesNotMatch(shard, /#9100 \(20 min\)/, "only three are named");
  assert.match(shard, /p50 25 min against a 10 min baseline/);
  const task = loadPlanFromYaml(shard, "flow.yaml").tasks[0]!;
  assert.equal(task.id, "W1-T9701");
  assert.equal(lintTask(task).ok, true, "the filed record passes the task linter");
  assert.match(h.landed[0]!.body, /## Acceptance/);

  const filed = h.steps("flow.regression_filed");
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.extra.key, "plan:ready_to_merged:full");
  assert.equal(filed[0]!.extra.task_id, "W1-T9701");
  assert.equal(filed[0]!.extra.filing_pr, URL(9901));
  assert.deepEqual(filed[0]!.extra.slowest, [9103, 9102, 9101]);
  const report = h.steps("flow.report")[0]!.extra;
  assert.deepEqual(report.regressions, ["plan:ready_to_merged:full"]);
  assert.equal(report.prs_current, 8);
  assert.equal(report.prs_baseline, 12);
  const md = readFileSync(join(h.deps.stateDir, FLOW_REPORT_FILE), "utf8");
  assert.match(md, /\| plan \| ready_to_merged \| full \| 4 \| 25 \| 40 \| 10 \| 10 \| rolling \| REGRESSED \|/);
});

test("a stage with an open follow-up is not re-filed, and a stage whose follow-up merged is filed again", async (t) => {
  const h = harness(corpus());
  t.after(h.cleanup);
  await runFlowGardener(h.deps, h.sources);
  assert.equal(h.landed.length, 1);
  // The next UTC day: the filing PR is still open, so the plan has no such task yet.
  h.setClock(NOW + 13 * HOUR);
  await runFlowGardener(h.deps, h.sources);
  assert.equal(h.landed.length, 1, "an open filing is not re-filed");
  assert.equal(h.steps("flow.regression_open").at(-1)?.extra.task_id, "W1-T9701");
  // A day later the task is in the plan and queued: still open.
  h.setClock(NOW + 37 * HOUR);
  h.sources.planTasks = () => [{ id: "W1-T9701", origin: "flow-regression:plan:ready_to_merged:full", status: "queued" }];
  const late = corpus().map((r) => ({ ...r }));
  for (const r of late) if (typeof r.ts === "string") r.ts = at(Date.parse(r.ts) + 30 * HOUR);
  for (const r of late) if (typeof r.merged_at === "string") r.merged_at = at(Date.parse(r.merged_at) + 30 * HOUR);
  h.sources.readLedger = () => ({ ok: true, rows: late, unread: [] });
  await runFlowGardener(h.deps, h.sources);
  assert.equal(h.landed.length, 1, "a queued follow-up is open");
  assert.equal(h.steps("flow.regression_open").length, 2);
  // Its build merged and the stage is still slow: one new follow-up.
  h.setClock(NOW + 61 * HOUR);
  h.sources.planTasks = () => [{ id: "W1-T9701", origin: "flow-regression:plan:ready_to_merged:full", status: "done" }];
  for (const r of late) if (typeof r.ts === "string") r.ts = at(Date.parse(r.ts) + 24 * HOUR);
  for (const r of late) if (typeof r.merged_at === "string") r.merged_at = at(Date.parse(r.merged_at) + 24 * HOUR);
  await runFlowGardener(h.deps, h.sources);
  assert.equal(h.landed.length, 2, "a merged follow-up whose stage is still slow is filed again");
});

test("an open follow-up found only in the plan (no state) is not re-filed", async (t) => {
  const h = harness(corpus(), { plan: () => [{ id: "W1-T5000", origin: "flow-regression:plan:ready_to_merged:full", status: "queued" }] });
  t.after(h.cleanup);
  await runFlowGardener(h.deps, h.sources);
  assert.equal(h.landed.length, 0);
  assert.equal(h.steps("flow.regression_open")[0]?.extra.task_id, "W1-T5000");
});

test("a stage inside the tolerance files nothing", async (t) => {
  // 19 min against a 10 min baseline is under the factor of two.
  const h = harness(corpus({ planReady: [17, 19, 19, 19] }));
  t.after(h.cleanup);
  assert.equal(FLOW_REGRESSION_FACTOR, 2);
  await runFlowGardener(h.deps, h.sources);
  assert.equal(h.stat("plan:ready_to_merged:full")?.current?.p50, 19);
  assert.equal(h.stat("plan:ready_to_merged:full")?.regressed, false);
  assert.equal(h.landed.length, 0);
  assert.deepEqual(h.steps("flow.report")[0]!.extra.regressions, []);
});

test("a pass runs once per UTC day, and its due probe says so", async (t) => {
  const h = harness(corpus({ planReady: [10, 10, 10, 10] }));
  t.after(h.cleanup);
  assert.equal(flowPassDue(h.deps.stateDir, h.deps.clock), true);
  await runFlowGardener(h.deps, h.sources);
  assert.equal(flowPassDue(h.deps.stateDir, h.deps.clock), false);
  const again = await runFlowGardener(h.deps, h.sources);
  assert.equal(again.ran, false);
  assert.equal(h.steps("flow.report").length, 1, "a second pass the same day reports nothing");
  h.setClock(NOW + 13 * HOUR);
  assert.equal(flowPassDue(h.deps.stateDir, h.deps.clock), true);
});

test("each stage is measured from the ledger rows, with the review surface and arm surface splits", async (t) => {
  const rows: Row[] = [];
  for (let i = 0; i < 3; i++) {
    const mergedMs = NOW - (i + 1) * HOUR;
    rows.push(...prRows({ n: 9300 + i, cls: "code", mergedMs, ttm: 60 + i, ready: 7, heads: 3, updates: 2, fixes: 1, reviews: [[5, "light"], [11, undefined]] }));
    rows.push(...prRows({ n: 9400 + i, cls: "code", mergedMs, ttm: 50, ready: 3, armSurface: "light", reviews: [[1, "light"]] }));
    rows.push(...prRows({ n: 9500 + i, cls: "gardener", mergedMs, ttm: 20, ready: 2 }));
  }
  // A PR whose only merge evidence is a backfill stamped at write time is not measured.
  rows.push({ ts: at(NOW - 5 * DAY), run_id: "W1-T9600-1", task_id: "W1-T9600", step: "pr.opened", pr_url: URL(9600) });
  rows.push({ ts: at(NOW - HOUR), run_id: "DAEMON-1", task_id: "SWEEP", step: "pr.terminal", pr_number: 9600, pr_url: URL(9600), state: "merged" });
  rows.push({ ts: at(NOW - HOUR), run_id: "DAEMON-1", task_id: "W1-T9600", step: "verdict.merged", pr_number: 9600, pr_url: URL(9600), source: "sweep.credit_backfill" });
  const h = harness(rows);
  t.after(h.cleanup);
  await runFlowGardener(h.deps, h.sources);
  assert.deepEqual(h.stat("code:time_to_merge:all")?.current, { n: 6, p50: 50, p90: 62 });
  assert.deepEqual(h.stat("code:ci_wall_clock:all")?.current, { n: 6, p50: 20, p90: 20 });
  assert.deepEqual(h.stat("code:review_queue_wait:light")?.current, { n: 6, p50: 1, p90: 5 });
  assert.deepEqual(h.stat("code:review_queue_wait:full")?.current, { n: 3, p50: 11, p90: 11 }, "an admission with no surface is full");
  assert.deepEqual(h.stat("code:ready_to_merged:full")?.current, { n: 3, p50: 7, p90: 7 });
  assert.deepEqual(h.stat("code:ready_to_merged:light")?.current, { n: 3, p50: 3, p90: 3 });
  assert.deepEqual(h.stat("code:pushes:all")?.current, { n: 6, p50: 1, p90: 3 });
  assert.deepEqual(h.stat("code:branch_updates:all")?.current, { n: 6, p50: 0, p90: 2 });
  assert.deepEqual(h.stat("code:fix_rounds:all")?.current, { n: 6, p50: 0, p90: 1 });
  assert.deepEqual(h.stat("gardener:time_to_merge:all")?.current, { n: 3, p50: 20, p90: 20 }, "a GARDEN- run's PR is the gardener class");
  // No 7-day history: code time-to-merge falls back to the operator's measured seed, the others have none.
  assert.deepEqual(h.stat("code:time_to_merge:all")?.baseline, { p50: 38, p90: 120, source: "seed-2026-10-05" });
  assert.equal(h.stat("code:pushes:all")?.baseline, undefined);
  assert.equal(h.landed.length, 0, "a stage with no baseline files nothing");
});

test("the per-day bound caps filings and names what it held back", async (t) => {
  // Three regressions: plan ready, code ready and code time-to-merge.
  const h = harness(corpus({ codeReady: [15, 20, 25, 30], codeTtm: [90, 95, 100, 120] }));
  t.after(h.cleanup);
  assert.equal(FLOW_FILINGS_PER_DAY_MAX, 2);
  await runFlowGardener(h.deps, h.sources);
  assert.equal(h.steps("flow.report")[0]!.extra.regressions instanceof Array, true);
  assert.equal((h.steps("flow.report")[0]!.extra.regressions as string[]).length, 3);
  assert.equal(h.landed.length, 2);
  assert.equal(h.steps("flow.filing_deferred").length, 1);
  assert.equal(h.steps("flow.filing_deferred")[0]!.extra.bound, FLOW_FILINGS_PER_DAY_MAX);
  // The next day the held-back stage is filed; the two filed ones are open.
  h.setClock(NOW + 13 * HOUR);
  await runFlowGardener(h.deps, h.sources);
  assert.equal(h.landed.length, 3);
});

test("unreadable inputs are named: the ledger stops the pass, a CI read, the plan and the state do not", async (t) => {
  const h = harness(corpus());
  t.after(h.cleanup);
  h.sources.readLedger = () => ({ ok: false, rows: [], unread: ["/state/ledger.2026-10-05.ndjson.gz"] });
  const stopped = await runFlowGardener(h.deps, h.sources);
  assert.equal(stopped.ran, false);
  assert.deepEqual(h.steps("flow.input_unreadable")[0]?.extra, { input: "ledger", unread: ["/state/ledger.2026-10-05.ndjson.gz"] });
  assert.equal(h.steps("flow.report").length, 0);
  assert.equal(flowPassDue(h.deps.stateDir, h.deps.clock), true, "an unread ledger leaves the day due");

  h.sources.readLedger = () => ({ ok: true, rows: corpus(), unread: [] });
  h.sources.readCi = async (sha) => { if (sha === "9103head0") throw new Error("HTTP 502"); return undefined; };
  h.sources.planTasks = () => { throw new Error("plan/tasks.d: duplicate key"); };
  await writeFile(join(h.deps.stateDir, "flow-gardener.json"), "{not json");
  assert.equal(flowPassDue(h.deps.stateDir, h.deps.clock), true, "a corrupt state is due, so the pass can name it");
  await runFlowGardener(h.deps, h.sources);
  const named = h.steps("flow.input_unreadable").map((e) => e.extra.input);
  assert.deepEqual(named, ["ledger", "state", "github", "plan"]);
  assert.match(String(h.steps("flow.input_unreadable")[2]!.extra.first_error), /HTTP 502/);
  assert.equal(h.steps("flow.report")[0]!.extra.ci_unread, 1);
  assert.equal(h.landed.length, 0, "an unreadable plan files nothing");
  assert.equal(flowPassDue(h.deps.stateDir, h.deps.clock), true, "the day stays due until its filings could be decided");
});

test("a filing that fails is ledgered with its error and the pass completes", async (t) => {
  const h = harness(corpus());
  t.after(h.cleanup);
  h.deps.openWorkspace = () => ({ root: h.root, branch: "", land: () => URL(1), dispose: () => {} });
  await runFlowGardener(h.deps, h.sources);
  assert.match(String(h.steps("flow.filing_failed")[0]?.extra.error), /no branch/);
  assert.equal(h.steps("flow.report").length, 1);
});

test("GitHub reads are bounded per pass and cached across passes", async (t) => {
  const h = harness(corpus({ planReady: [10, 10, 10, 10] }));
  t.after(h.cleanup);
  await runFlowGardener(h.deps, h.sources, { ghReadsPerPass: 5 });
  assert.equal(h.ciReads.length, 5);
  const first = h.steps("flow.report")[0]!.extra;
  assert.equal(first.ci_read, 5);
  assert.equal(first.ci_skipped, 15);
  assert.ok(h.ciReads.every((sha) => /^9[12]0\dhead0$/.test(sha)), "the current window is read first");
  h.setClock(NOW + 13 * HOUR);
  await runFlowGardener(h.deps, h.sources, { ghReadsPerPass: 5 });
  assert.equal(new Set(h.ciReads).size, 10, "a cached PR is not read again");
});

test("the daemon's garden registry runs the flow gardener once a day off its loop", async (t) => {
  assert.ok((REGISTERED_GARDEN_NAMES as readonly string[]).includes("flow"));
  assert.ok(gardenSchedule("flow").intervalFor(1_000) >= HOUR, "a daily garden does not spawn every poll");
  const h = harness([]);
  t.after(h.cleanup);
  const ledger = corpus({ planReady: [10, 10, 10, 10] }).map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(join(h.deps.stateDir, "ledger.ndjson"), ledger);
  const reads: string[][] = [];
  const pass = flowGardenPass(h.deps, "acme", "remudero", () => "W1-T9799", {
    readJson: async (args) => (reads.push(args), { workflow_runs: [] }),
  });
  assert.equal(pass.due(), true);
  await pass();
  assert.equal(h.steps("flow.report").length, 1, "the registered pass reads the real ledger and reports");
  assert.equal(h.steps("flow.report")[0]!.extra.prs_current, 8);
  assert.ok(reads.length > 0 && reads[0]!.join(" ").includes("repos/acme/remudero/actions/workflows/ci.yml/runs?head_sha="));
  assert.equal(pass.due(), false);
  // A pass that throws is recorded under the garden's own failure step.
  const refusing = {
    ...h.deps,
    clock: fixedClock(NOW + DAY),
    log: (step: string, extra: Record<string, unknown> = {}) => {
      if (step === "flow.report") throw new Error("ledger refused the report");
      h.deps.log(step, extra);
    },
  };
  const broken = flowGardenPass(refusing, "acme", "remudero", () => "W1-T9799", { readJson: async () => ({ workflow_runs: [] }) });
  await broken();
  assert.match(String(h.steps("flow.gardener_failed")[0]?.extra.error), /ledger refused the report/);
  // The default reads (the gh transport) over an empty ledger: nothing to read, an empty report.
  const empty = join(h.root, "empty-state");
  mkdirSync(empty);
  await flowGardenPass({ ...h.deps, stateDir: empty }, "acme", "remudero", () => "W1-T9799")();
  assert.equal(h.steps("flow.report").at(-1)?.extra.prs_current, 0);
  assert.equal(h.steps("flow.report").at(-1)?.extra.ci_read, 0);
  assert.equal(h.steps("flow.gardener_failed").length, 1);
});

test("real run: the default ledger reader keeps the flow rows and an arm-surface disposition only", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-ledger-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const rows = [
    { ts: at(now - HOUR), step: "pr.opened", pr_url: URL(1) },
    { ts: at(now - HOUR), step: "sweep.disposed", pr_number: 1, blocker: "awaiting-ci" },
    { ts: at(now - HOUR), step: "sweep.disposed", pr_number: 1, arm_surface: "light" },
    { ts: at(now - HOUR), step: "garden.pass", name: "flow" },
    { ts: at(now - HOUR), run_id: "GARDEN-plan-1", task_id: "DAEMON", step: "plan.scorecard", pr_url: URL(3) },
    { ts: at(now - HOUR), run_id: "GARDEN-hot-file-1", task_id: "DAEMON", step: "hot-file.scorecard", pr_url: null },
    { ts: at(now - 20 * DAY), step: "pr.opened", pr_url: URL(2) },
  ];
  await writeFile(join(root, "ledger.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const read = readFlowLedger(root, at(now - 9 * DAY));
  assert.equal(read.ok, true);
  assert.deepEqual(read.rows.map((r) => [r.step, r.pr_url ?? r.arm_surface]), [["pr.opened", URL(1)], ["sweep.disposed", "light"], ["plan.scorecard", URL(3)]]);
});

test("real run: the default CI reader asks GitHub through the gh transport", async (t) => {
  const cache = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-gh-cache-`));
  const shim = ghShim([
    { when: "head_sha=abc", stdout: JSON.stringify({ workflow_runs: [
      { status: "completed", conclusion: "success", run_started_at: "2026-10-06T10:00:00Z", updated_at: "2026-10-06T10:22:00Z" },
      { status: "completed", conclusion: "failure", run_started_at: "2026-10-06T09:00:00Z", updated_at: "2026-10-06T09:30:00Z" },
    ] }) },
    { when: "head_sha=none", stdout: JSON.stringify({ workflow_runs: [{ status: "in_progress", conclusion: null }] }) },
    { when: "head_sha=bad", stdout: "null" },
  ], { kind: "flow-ci" });
  const saved = { path: process.env.PATH, xdg: process.env.XDG_CACHE_HOME };
  process.env.PATH = `${shim.dir}:${saved.path ?? ""}`;
  process.env.XDG_CACHE_HOME = cache;
  t.after(() => {
    process.env.PATH = saved.path;
    if (saved.xdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved.xdg;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });
  const read = flowCiReader("acme", "remudero");
  assert.deepEqual(await read("abc"), { minutes: 22, doneMs: Date.parse("2026-10-06T10:22:00Z") });
  assert.equal(await read("none"), undefined, "no completed green run is no reading");
  await assert.rejects(read("bad"), /no CI runs/);
  assert.ok(shim.calls().some((c) => c.includes("repos/acme/remudero/actions/workflows/ci.yml/runs?head_sha=abc")));
});

test("real run: the default plan, clock and due probe read the real checkout and wall clock", async (t) => {
  const h = harness([]);
  t.after(h.cleanup);
  const now = Date.now();
  const rows: Row[] = [];
  for (let i = 0; i < 6; i++) rows.push(...prRows({ n: 8000 + i, cls: "plan", mergedMs: now - (2 + (i % 5)) * DAY, ttm: 30, ready: 10 }));
  for (let i = 0; i < 4; i++) rows.push(...prRows({ n: 9100 + i, cls: "plan", mergedMs: now - (i + 1) * HOUR, ttm: 45, ready: 40 }));
  const { clock: _fixed, ...unclocked } = h.deps;
  const { planTasks: _plan, ...unplanned } = h.sources;
  unplanned.readLedger = () => ({ ok: true, rows, unread: [] });
  await runFlowGardener({ ...unclocked, repoRoot: process.cwd() }, unplanned);
  assert.equal(h.landed.length, 1, "the real plan has no open flow follow-up for this stage");
  assert.equal(flowPassDue(h.deps.stateDir), false, "the system clock's day has run");
  void [_fixed, _plan];
});
