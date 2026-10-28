// W1-T9729 — a retirement that names its superseding task keeps its origin held until that task lands.
// Live case 2026-10-15: #12091 retired W1-T9668 "superseded by W1-T9551" (unmerged then) at 18:28Z, and the
// flake-incident gardener re-filed the same origin as W1-T9707 at 19:38Z: it read any `retirement:` as closed,
// and the superseding id lived only in a YAML comment.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "#src/lib/clock.js";
import { flakeIncidentOrigin, runFlakeIncidentGardener } from "#src/lib/flake-incident-gardener.js";
import { runFlowGardener, type FlowGardenSources } from "#src/lib/flow-gardener.js";
import { gateGardenSpec, loadGateProbes } from "#src/lib/gate-gardener.js";
import { loadPlanFromYaml, PlanError, retirementHoldsOrigin, type Task } from "#src/lib/plan.js";
import { lintPlan, lintTask } from "#src/lib/task-linter.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const FILE = "test/a-ci-friction-cause-owned-by-a-test-alone-escalates-as-no-owner.test.ts";
const TITLE = "W1-T9503: a cause owned by a test alone escalates as no-owner";
const ORIGIN = flakeIncidentOrigin(FILE, TITLE);
const NOW = Date.parse("2026-10-15T20:00:00Z");
const HOUR = 3_600_000;

type Row = Record<string, unknown>;
type PlanTaskLite = { id: string; origin?: string; status?: string; retirement?: string; superseded_by?: string };

const retiredRecord = (superseded_by?: string): PlanTaskLite =>
  ({ id: "W1-T9668", origin: ORIGIN, status: "blocked", retirement: "retired", ...(superseded_by ? { superseded_by } : {}) });

/** The flake-incident gardener over a real git checkout: W1-T9668 filed two hours ago, then three fresh PRs. */
function flakeHarness() {
  const repo = gitRepo({ kind: "w1-t9729-flake" });
  const root = repo.dir;
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, FILE, ".."), { recursive: true });
  writeFileSync(join(root, FILE), "");
  const ledger = join(root, "state", "ledger.ndjson");
  const log = (step: string, extra: Row = {}, ts = NOW) => {
    appendFileSync(ledger, JSON.stringify({ ts: new Date(ts).toISOString(), step, ...extra }) + "\n");
  };
  log("flake_incident.filed", { origin: ORIGIN, task_id: "W1-T9668", file: FILE, title: TITLE, prs: [11949, 12019, 12039], run_ids: [100, 101, 102] }, NOW - 2 * HOUR);
  for (const pr of [12100, 12101, 12102]) {
    log("test.flake_retry", {
      file: FILE, ci_run_id: pr * 10, shard: 3, source: "selector-shadow", retry_outcome: "recovered",
      head_sha: `head-${pr}`, base_sha: `base-${pr}`, pr_numbers: [pr], titles: [TITLE],
    }, NOW - HOUR);
  }
  const landed: Array<{ paths: string[]; title: string }> = [];
  const deps = {
    stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(NOW), log,
    openWorkspace: () => ({
      root, branch: "selector-shadow-garden-1",
      land: (opts: { paths: string[]; title: string; body: string }) => (landed.push(opts), `https://github.com/acme/remudero/pull/${30000 + landed.length}`),
      dispose: () => {},
    }),
  };
  let minted = 0;
  const sources = (plan: PlanTaskLite[], isLanded?: (id: string) => boolean) => ({
    mintTaskId: () => `W1-T97${String(++minted).padStart(2, "0")}`,
    readChangedPaths: () => ["src/lib/unrelated.ts"],
    planTasks: () => plan,
    readSource: () => "",
    ...(isLanded ? { isLanded } : {}),
  });
  const rows = (step: string): Row[] => readFileSync(ledger, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Row).filter((r) => r.step === step);
  return { repo, deps, sources, landed, rows };
}

/** Points origin/main at HEAD, so the default landed reading has the ref it reads. */
function publishMain(repo: GitRepo): void {
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
}

test("W1-T9729: a retirement superseded by an unlanded task holds its flake origin", async () => {
  const h = flakeHarness();
  const asked: string[] = [];
  await runFlakeIncidentGardener(h.deps, h.sources([retiredRecord("W1-T9551")], (id) => (asked.push(id), false)));
  assert.equal(h.landed.length, 0, "the origin is held by the unlanded superseding task, so nothing is re-filed");
  assert.deepEqual(asked, ["W1-T9551"]);
  assert.deepEqual(h.rows("flake_incident.skipped").map((r) => r.reason), ["superseded-by W1-T9551"]);
  // A second pass says it once.
  await runFlakeIncidentGardener(h.deps, h.sources([retiredRecord("W1-T9551")], () => false));
  assert.equal(h.rows("flake_incident.skipped").length, 1);
  assert.equal(h.landed.length, 0);
});

test("W1-T9729: a landed or unnamed superseding task reopens the origin", async () => {
  const landedPass = flakeHarness();
  await runFlakeIncidentGardener(landedPass.deps, landedPass.sources([retiredRecord("W1-T9551")], () => true));
  assert.equal(landedPass.landed.length, 1, "once the superseding task lands, the origin files as before W1-T9729");
  const unnamed = flakeHarness();
  await runFlakeIncidentGardener(unnamed.deps, unnamed.sources([retiredRecord()], () => assert.fail("no superseding task to ask about")));
  assert.equal(unnamed.landed.length, 1, "a retirement with no superseded_by still reopens its origin (positive control)");
  assert.equal(unnamed.rows("flake_incident.skipped").length, 0);
});

test("W1-T9729: the default landed reading is the superseding task's trailer on origin/main", async () => {
  const held = flakeHarness();
  held.repo.git("commit", "--quiet", "--allow-empty", "-m", "fix: another task\n\nRemudero-Task: W1-T95510");
  publishMain(held.repo);
  await runFlakeIncidentGardener(held.deps, held.sources([retiredRecord("W1-T9551")]));
  assert.equal(held.landed.length, 0, "a trailer for another id is not this task landing");
  assert.deepEqual(held.rows("flake_incident.skipped").map((r) => r.reason), ["superseded-by W1-T9551"]);

  const landed = flakeHarness();
  landed.repo.git("commit", "--quiet", "--allow-empty", "-m", "fix(flake-incident): route a no-recovery red (W1-T9551)\n\nRemudero-Task: W1-T9551");
  publishMain(landed.repo);
  await runFlakeIncidentGardener(landed.deps, landed.sources([retiredRecord("W1-T9551")]));
  assert.equal(landed.landed.length, 1, "the merged trailer on origin/main is what lands the superseding task");

  const unread = flakeHarness();
  await runFlakeIncidentGardener(unread.deps, unread.sources([retiredRecord("W1-T9551")]));
  assert.equal(unread.landed.length, 0, "an unreadable landed reading holds the origin rather than re-filing it");
  assert.match(String(unread.rows("flake_incident.filing_failed")[0]?.error), /origin\/main/);
});

// --- the flow gardener -----------------------------------------------------------------------------

const MIN = 60_000;
const DAY = 24 * HOUR;
const FLOW_NOW = Date.parse("2026-10-06T12:00:00.000Z");
const FLOW_ORIGIN = "flow-regression:plan:ready_to_merged:full";
const prUrl = (n: number) => `https://github.com/acme/remudero/pull/${n}`;
const at = (ms: number) => new Date(ms).toISOString();

/** The rows one merged plan-only PR leaves, as the live ledger writes them. */
function planPrRows(n: number, mergedMs: number, ttm: number, ready: number): Row[] {
  const task = `W1-T${n}`;
  const opened = mergedMs - ttm * MIN;
  const readyMs = mergedMs - ready * MIN;
  const key = `input:${n}:0`;
  return [
    { ts: at(opened), run_id: `${task}-1`, task_id: task, step: "pr.opened", pr_url: prUrl(n), head_sha: `${n}head`, plan_only: true },
    { ts: at(opened + MIN), run_id: "DAEMON-1", task_id: task, step: "sweep.review_eligible", pr_number: n, pr_url: prUrl(n), head_sha: `${n}head`, review_key: key },
    { ts: at(opened + 3 * MIN), run_id: "DAEMON-1", task_id: task, step: "sweep.review_admitted", pr_number: n, pr_url: prUrl(n), head_sha: `${n}head`, review_key: key },
    { ts: at(readyMs), run_id: `review-PR${n}-1`, task_id: task, step: "review.posted", state: "success", pr_url: prUrl(n), head_sha: `${n}head` },
    { ts: at(readyMs + 1000), run_id: `review-PR${n}-1`, task_id: task, step: "automerge.armed", pr_number: n, pr_url: prUrl(n), head_sha: `${n}head` },
    { ts: at(mergedMs + MIN), run_id: "DAEMON-1", task_id: "SWEEP", step: "pr.terminal", pr_number: n, pr_url: prUrl(n), state: "merged", merged_at: at(mergedMs) },
  ];
}

/** Six baseline plan PRs (ready-to-merged 10 min) and four current ones whose stage has doubled. */
function slowPlanCorpus(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 6; i++) rows.push(...planPrRows(8000 + i, FLOW_NOW - (2 + (i % 5)) * DAY, 30, 10));
  [20, 25, 30, 40].forEach((ready, i) => rows.push(...planPrRows(9100 + i, FLOW_NOW - (i + 1) * HOUR, 45, ready)));
  return rows;
}

function flowHarness(plan: PlanTaskLite[], isLanded: FlowGardenSources["isLanded"]) {
  const repo = gitRepo({ kind: "w1-t9729-flow" });
  const root = repo.dir;
  mkdirSync(join(root, "state"), { recursive: true });
  for (const owner of ["src/lib/sweep.ts", ".github/workflows/ci.yml"]) {
    mkdirSync(join(root, owner, ".."), { recursive: true });
    writeFileSync(join(root, owner), "// fixture\n");
  }
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const events: Array<{ step: string; extra: Row }> = [];
  const deps = {
    stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(FLOW_NOW),
    openWorkspace: () => ({
      root, branch: "flow-garden-1",
      land: (o: { paths: string[]; title: string; body: string }) => (landed.push(o), prUrl(9900 + landed.length)),
      dispose: () => {},
    }),
    log: (step: string, extra: Row = {}) => { events.push({ step, extra }); },
  };
  let minted = 0;
  const sources: FlowGardenSources = {
    readLedger: () => ({ ok: true, rows: slowPlanCorpus(), unread: [] }),
    readCi: async () => ({ minutes: 20, doneMs: FLOW_NOW - 30 * DAY }),
    planTasks: () => plan,
    mintTaskId: () => `W1-T97${String(++minted).padStart(2, "0")}`,
    ...(isLanded ? { isLanded } : {}),
  };
  return { repo, deps, sources, landed, steps: (step: string) => events.filter((e) => e.step === step) };
}

const flowRetired = (superseded_by?: string): PlanTaskLite =>
  ({ id: "W1-T5000", origin: FLOW_ORIGIN, status: "blocked", retirement: "retired", ...(superseded_by ? { superseded_by } : {}) });

test("W1-T9729: the flow gardener holds a superseded origin", async () => {
  const held = flowHarness([flowRetired("W1-T6001")], () => false);
  await runFlowGardener(held.deps, held.sources);
  assert.equal(held.landed.length, 0, "an unlanded superseding task keeps the regression open");
  assert.equal(held.steps("flow.regression_open")[0]?.extra.task_id, "W1-T6001");

  const landed = flowHarness([flowRetired("W1-T6001")], async () => true);
  await runFlowGardener(landed.deps, landed.sources);
  assert.equal(landed.landed.length, 1, "a landed superseding task reopens the regression");

  const unnamed = flowHarness([flowRetired()], () => assert.fail("no superseding task to ask about"));
  await runFlowGardener(unnamed.deps, unnamed.sources);
  assert.equal(unnamed.landed.length, 1, "a retirement with no superseded_by reads as closed, as before");
});

test("W1-T9729: the flow gardener reads landing from origin/main and defers when it cannot", async () => {
  const byDefault = flowHarness([flowRetired("W1-T6001")], undefined);
  byDefault.repo.git("commit", "--quiet", "--allow-empty", "-m", "fix: the superseding task\n\nRemudero-Task: W1-T6001");
  publishMain(byDefault.repo);
  await runFlowGardener(byDefault.deps, byDefault.sources);
  assert.equal(byDefault.landed.length, 1, "the default reading finds the merged trailer");

  const unread = flowHarness([flowRetired("W1-T6001")], () => { throw new Error("git log failed"); });
  const pass = await runFlowGardener(unread.deps, unread.sources);
  assert.equal(unread.landed.length, 0);
  assert.deepEqual(pass.filed, []);
  assert.deepEqual(unread.steps("flow.input_unreadable").map((e) => e.extra), [{ input: "landed", error: "git log failed" }]);
});

// --- the gate gardener -----------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GATE_NOW = Date.parse("2026-10-04T00:00:00Z");
const GATE_FILE = "test/fixture.test.ts";
const GATE_ORIGIN = `expiring-fixture:${GATE_FILE}`;

async function gateHarness(supersededLanded: boolean) {
  const repo = gitRepo({ kind: "w1-t9729-gate" });
  const put = (path: string, text: string) => {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  const stamp = new Date(GATE_NOW - 16 * DAY).toISOString();
  put(GATE_FILE, `const row = {\n  lastActivityAt: "${stamp}",\n};\n`);
  put("scripts/source-size-baseline.json", "{}\n");
  put("scripts/comment-load-baseline.json", "{}\n");
  put("scripts/learnings-budget-baseline.json", '{"measuredChars":0,"measuredActiveEntries":0}\n');
  put(".github/workflows/ci-gate.yml", 'jobs:\n  ci-gate:\n    env:\n      REQUIRED: >-\n        [\n        "ci"\n        ]\n      ADVISORY: >-\n        [\n        "dashboard"\n        ]\n');
  put("plan/tasks.yaml", "[]\n");
  const record = (id: string, extra: string) =>
    `- id: ${id}\n  title: defuse fixture ${id}\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: human\n  risk: low\n  attempts: 0\n${extra}`;
  put("plan/tasks.d/defuse.yaml",
    record("W1-T5999", `  status: blocked\n  retirement: retired\n  superseded_by: W1-T5998\n  origin: ${GATE_ORIGIN}\n`) +
    record("W1-T5998", "  status: queued\n  origin: operator\n"));
  put("test/expiring-fixture-census.test.ts", "export {};\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", supersededLanded ? "fix: defuse it\n\nRemudero-Task: W1-T5998" : "seed census fixture");
  publishMain(repo);
  mkdirSync(join(repo.dir, "state"));
  for (const c of ["tighten", "refresh", "demote"]) put(`state/GATE_OFF-${c}`, "");
  const rows: Array<{ step: string; extra?: Row }> = [];
  const deps = {
    repoRoot: repo.dir, stateDir: join(repo.dir, "state"), clock: fixedClock(GATE_NOW), seed: 1,
    log: (step: string, extra?: Row) => rows.push({ step, extra }),
    openWorkspace: () => ({ root: repo.dir, branch: "run-unfiled-1", land: () => "https://github.com/acme/remudero/pull/1", dispose: () => {} }),
  };
  const sources = { thresholdDays: 30, openOrigins: () => [] as string[], runSuite: (_file: string, shiftDays: number) => shiftDays < 1 };
  const spec = gateGardenSpec(deps, await loadGateProbes(ROOT), sources);
  return { defuse: spec.inventory().candidates.filter((a) => a.class === "defuse"), rows };
}

test("W1-T9729: the gate gardener's defuse lane holds a superseded origin", async () => {
  const held = await gateHarness(false);
  assert.equal(held.defuse.length, 0, "the retired record's unlanded superseding task covers the fixture");
  assert.equal(held.rows.filter((r) => r.step === "gate_garden.defuse_deferred").length, 1);
  const reopened = await gateHarness(true);
  assert.equal(reopened.defuse.length, 1, "once the superseding task lands, the fixture is filed again");
});

// --- the field and the linter ----------------------------------------------------------------------

const shard = (extra: string, more = "") =>
  `- id: W1-T1\n  title: a retired task\n  repo: remudero\n  depends_on: []\n  type: implement\n  status: blocked\n  origin: operator\n${extra}` +
  `- id: W1-T2\n  title: the superseding task\n  repo: remudero\n  depends_on: []\n  type: implement\n  origin: operator\n${more}`;

test("W1-T9729: the linter refuses a superseded_by it cannot honour", () => {
  const plan = loadPlanFromYaml(shard("  retirement: retired\n  superseded_by: W1-T2\n"), "plan/tasks.d/w1-t1.yaml");
  const retired = plan.byId.get("W1-T1")!;
  assert.equal(retired.superseded_by, "W1-T2", "the loader keeps the field");
  assert.deepEqual(lintPlan(plan).get("W1-T1")!.violations.filter((v) => v.check === "superseded-by"), [], "a retired record naming a plan task is accepted");

  const unretired = { ...plan.byId.get("W1-T2")!, superseded_by: "W1-T1" } as Task;
  const refused = lintTask(unretired).violations.filter((v) => v.check === "superseded-by");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.severity, "block");
  assert.match(refused[0]!.message, /no `retirement:`/);

  const unknown = { tasks: [{ ...retired, superseded_by: "W1-T404" }], byId: new Map([["W1-T1", { ...retired, superseded_by: "W1-T404" }]]) };
  const missing = lintPlan(unknown).get("W1-T1")!;
  assert.equal(missing.ok, false);
  assert.match(missing.violations.find((v) => v.check === "superseded-by")!.message, /W1-T404, which is not in the plan/);

  assert.throws(() => loadPlanFromYaml(shard("  retirement: retired\n  superseded_by: W1-T404\n"), "x"),
    (e: unknown) => e instanceof PlanError && /superseded_by unknown task 'W1-T404'/.test(e.message));
  assert.throws(() => loadPlanFromYaml(shard("  retirement: retired\n  superseded_by: [W1-T2]\n"), "x"),
    (e: unknown) => e instanceof PlanError && /superseded_by must be a task id/.test(e.message));
});

test("W1-T9729: the predicate holds only a retirement whose superseding task has not landed", () => {
  assert.equal(retirementHoldsOrigin({ retirement: "retired", superseded_by: "W1-T2" }, () => false), true);
  assert.equal(retirementHoldsOrigin({ retirement: "retired", superseded_by: "W1-T2" }, () => true), false);
  assert.equal(retirementHoldsOrigin({ retirement: "retired" }, () => false), false);
  assert.equal(retirementHoldsOrigin({ superseded_by: "W1-T2" }, () => false), false, "only a retirement hands its origin on");
});
