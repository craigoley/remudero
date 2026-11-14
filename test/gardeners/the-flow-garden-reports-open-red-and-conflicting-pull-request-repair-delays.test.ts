// W1-T12547 — the daily flow pass reports every open red or conflicting PR with its open age and the delay to
// its first and latest fix round, and files one remedy when one has waited past the bound.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import {
  FLOW_FILINGS_PER_DAY_MAX, FLOW_OPEN_REPAIR_AGES_STEP, FLOW_OPEN_REPAIR_WAIT_BOUND_MS, FLOW_REPORT_FILE, FLOW_STATE_FILE,
  openQueueWindow, openRepairAges, runFlowGardener,
  type FlowGardenSources, type FlowOpenQueuePr, type FlowOpenQueueRead, type FlowOpenRepairAge, type FlowOpenRepairAges,
} from "#src/lib/flow-gardener.js";
import { flowGardenPass } from "#src/lib/garden-registry.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { lintTask } from "#src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(ms).toISOString();
/** Where the pass's ledger read begins: nine days before now. */
const LEDGER_FROM = NOW - 9 * DAY;

const pr = (number: number, createdAtMs: number, checksState: string, mergeable: string, headRefName = `run-W1-T${number}-1`): FlowOpenQueuePr =>
  ({ number, createdAtMs, updatedAtMs: NOW, headSha: `head-${number}`, headRefName, checksState, mergeable });

/** #505 opened before the ledger read; #501 red with one round; #502 conflicting with none; #503 both, young;
 *  #504 green; #506 red on an operator branch, joined by pr_number. */
function openCohort(now = NOW): FlowOpenQueuePr[] {
  return [
    pr(501, now - 3 * HOUR, "FAILURE", "MERGEABLE"),
    pr(502, now - 2 * HOUR, "SUCCESS", "CONFLICTING"),
    pr(503, now - 30 * MIN, "ERROR", "CONFLICTING"),
    pr(504, now - 5 * HOUR, "SUCCESS", "MERGEABLE"),
    pr(505, now - 10 * DAY, "ERROR", "MERGEABLE"),
    pr(506, now - 40 * MIN, "FAILURE", "UNKNOWN", "codex/operator-fix"),
  ];
}

function census(over: Partial<FlowOpenQueueRead> = {}, now = NOW): FlowOpenQueueRead {
  return { ok: true, complete: true, observedAtMs: now, windowMs: openQueueWindow(now), open: openCohort(now), window: [], ...over };
}

function fixRows(now = NOW): Array<Record<string, unknown>> {
  return [
    // #501's round: dispatched an hour after it opened, ended 90 minutes ago. Joined by the run branch's task id.
    { ts: at(now - 2 * HOUR), run_id: "DAEMON-1", task_id: "W1-T501", step: "fix.dispatch", head_sha: "head-501" },
    { ts: at(now - 90 * MIN), run_id: "DAEMON-1", task_id: "W1-T501", step: "fix.done", head_sha: "head-501" },
    // A round of another task and a round before #501 opened never count for it.
    { ts: at(now - 100 * MIN), run_id: "DAEMON-1", task_id: "W1-T777", step: "fix.dispatch", head_sha: "head-777" },
    { ts: at(now - 4 * HOUR), run_id: "DAEMON-1", task_id: "W1-T501", step: "fix.dispatch", head_sha: "older-head" },
    // #506 has no run branch: its round joins by pr_number.
    { ts: at(now - 20 * MIN), run_id: "DAEMON-1", task_id: "SWEEP", step: "fix.dispatch", pr_number: 506, head_sha: "head-506" },
  ];
}

const byPr = (report: FlowOpenRepairAges) => new Map(report.prs.map((p) => [p.pr, p] as const));

function harness(opts: { rows?: Array<Record<string, unknown>>; census?: () => Promise<FlowOpenQueueRead>; ledgerOk?: boolean;
  plan?: () => Array<{ id: string; origin?: string; status?: string }> } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-open-repair-`));
  mkdirSync(join(root, "state"), { recursive: true });
  // The remedy's owner is on main, as the files a machine filing declares must be for lint-plan's admission.
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "src", "lib", "sweep.ts"), "// fixture\n");
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const events: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let clockMs = NOW;
  const deps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    get clock() { return fixedClock(clockMs); },
    openWorkspace: () => ({
      root, branch: "flow-garden-1",
      land: (o: { paths: string[]; title: string; body: string }) => (landed.push(o), `https://github.com/acme/remudero/pull/${9900 + landed.length}`),
      dispose: () => {},
    }),
    log: (step: string, extra: Record<string, unknown> = {}) => { events.push({ step, extra }); },
  };
  let minted = 0;
  const sources: FlowGardenSources = {
    readLedger: () => ({ ok: opts.ledgerOk ?? true, rows: opts.rows ?? fixRows(clockMs), unread: opts.ledgerOk === false ? ["/state/ledger.gz"] : [] }),
    readOpenQueue: opts.census ?? (async () => census({}, clockMs)),
    readCi: async () => undefined,
    planTasks: opts.plan ?? (() => []),
    mintTaskId: () => `W1-T98${String(++minted).padStart(2, "0")}`,
  };
  const steps = (step: string) => events.filter((e) => e.step === step);
  const repair = () => steps(FLOW_OPEN_REPAIR_AGES_STEP).at(-1)?.extra as FlowOpenRepairAges | undefined;
  return { root, deps, sources, landed, steps, repair, setClock: (ms: number) => { clockMs = ms; },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("W1-T12547 criterion 1: every open red or conflicting PR gets one row with its kind, open age and fix-round delays", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  await runFlowGardener(h.deps, h.sources);
  assert.equal(h.steps(FLOW_OPEN_REPAIR_AGES_STEP).length, 1, "the pass writes one flow.open_repair_ages row");
  const report = h.repair()!;
  assert.equal(report.status, "OBSERVED");
  assert.equal(report.bound_ms, FLOW_OPEN_REPAIR_WAIT_BOUND_MS);
  assert.equal(FLOW_OPEN_REPAIR_WAIT_BOUND_MS, 60 * MIN);
  const rows = byPr(report);
  assert.deepEqual([...rows.keys()].sort(), [501, 502, 503, 505, 506], "the green PR is left out; the conflicting one is not");
  assert.deepEqual(rows.get(501), { pr: 501, kind: "red", task_id: "W1-T501", open_age_ms: 3 * HOUR, first_round_delay_ms: HOUR,
    since_latest_round_ms: 90 * MIN, wait_ms: 90 * MIN, over_bound: true } satisfies FlowOpenRepairAge);
  assert.deepEqual(rows.get(502), { pr: 502, kind: "conflict", task_id: "W1-T502", open_age_ms: 2 * HOUR, first_round_delay_ms: null,
    first_round: "no_round_yet", since_latest_round_ms: null, wait_ms: 2 * HOUR, over_bound: true, reason: "no_round_yet" } satisfies FlowOpenRepairAge);
  assert.equal(rows.get(503)!.kind, "both");
  assert.equal(rows.get(503)!.over_bound, false, "30 minutes is inside the bound");
  assert.equal(rows.get(506)!.first_round_delay_ms, 20 * MIN, "a PR with no run branch joins its rounds by pr_number");
  assert.equal(rows.get(506)!.task_id, null);
  // Falsifier control: the same census with the conflict cleared has no row for #502.
  const cleared = openRepairAges(census({ open: openCohort().map((p) => p.number === 502 ? { ...p, mergeable: "MERGEABLE" } : p) }), fixRows(), NOW, LEDGER_FROM);
  assert.equal(byPr(cleared).has(502), false);
});

test("W1-T12547 criterion 2: a PR opened before the ledger read with no fix row in the read reads unread, never zero", () => {
  const report = openRepairAges(census(), fixRows(), NOW, LEDGER_FROM);
  const old = byPr(report).get(505)!;
  assert.equal(old.reason, "unread");
  assert.equal(old.first_round, "unread");
  assert.equal(old.first_round_delay_ms, null, "no first-round delay is invented");
  assert.equal(old.since_latest_round_ms, null);
  assert.equal(old.wait_ms, null, "the wait is unread, not ten days and not zero");
  assert.equal(old.over_bound, false, "an unread figure never qualifies a PR for the remedy");
  assert.equal(report.unread, 1);
  // Control: a round in the read makes the latest round known; the first round may predate the read, so it stays unread.
  const withRound = openRepairAges(census(), [...fixRows(), { ts: at(NOW - 3 * HOUR), task_id: "W1-T505", step: "fix.done" }], NOW, LEDGER_FROM);
  const known = byPr(withRound).get(505)!;
  assert.equal(known.reason, undefined);
  assert.equal(known.first_round, "unread");
  assert.equal(known.since_latest_round_ms, 3 * HOUR);
  assert.equal(known.wait_ms, 3 * HOUR);
  assert.equal(known.over_bound, true);
});

test("W1-T12547 criterion 3: a wait past 60 minutes files one remedy through the filing path, once while open and inside the daily cap", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const pass = await runFlowGardener(h.deps, h.sources);
  assert.deepEqual(pass.filed, ["open-repair-wait"]);
  assert.equal(h.landed.length, 1, "one remedy for the wait, not one per PR");
  assert.equal(h.landed[0]!.title, "chore(plan): file the open repair wait");
  const shard = readFileSync(join(h.root, h.landed[0]!.paths[0]!), "utf8");
  assert.match(shard, /origin: "flow-regression:open-repair-wait"/);
  assert.match(shard, /#501 \(red\): open 180 min, first fix round after 60 min, waiting 90 min/);
  assert.match(shard, /#502 \(conflict\): open 120 min, first fix round not yet, waiting 120 min/);
  assert.ok(shard.indexOf("#501 (red)") < shard.indexOf("#502 (conflict)"), "oldest first");
  assert.doesNotMatch(shard, /#503|#505|#506/, "PRs inside the bound and unread PRs are not named");
  const task = loadPlanFromYaml(shard, "remedy.yaml").tasks[0]!;
  assert.equal(task.id, "W1-T9801");
  assert.equal(lintTask(task).ok, true, "the remedy passes the task linter");
  assert.deepEqual(h.steps("flow.regression_filed")[0]!.extra.slowest, [501, 502]);

  // The next day, the remedy is still open: it is not filed again.
  h.setClock(NOW + DAY);
  await runFlowGardener(h.deps, h.sources);
  assert.equal(h.landed.length, 1, "an open remedy is never filed twice");
  assert.deepEqual(h.steps("flow.regression_open").map((e) => e.extra), [{ key: "open-repair-wait", task_id: "W1-T9801" }]);
});

test("W1-T12547 criterion 3: the remedy waits for the daily cap and is not filed for a wait inside the bound", async (t) => {
  const capped = harness();
  t.after(capped.cleanup);
  const day = at(NOW).slice(0, 10);
  writeFileSync(join(capped.deps.stateDir, FLOW_STATE_FILE),
    JSON.stringify({ filings: Array.from({ length: FLOW_FILINGS_PER_DAY_MAX }, (_, i) => ({ day, key: `code:stage_${i}:all` })) }));
  await runFlowGardener(capped.deps, capped.sources);
  assert.equal(capped.landed.length, 0);
  assert.deepEqual(capped.steps("flow.filing_deferred").map((e) => e.extra), [{ key: "open-repair-wait", bound: FLOW_FILINGS_PER_DAY_MAX }]);

  const young = harness({ census: async () => census({ open: openCohort().filter((p) => p.number === 503 || p.number === 506) }) });
  t.after(young.cleanup);
  await runFlowGardener(young.deps, young.sources);
  assert.equal(young.repair()!.over_bound, 0);
  assert.equal(young.landed.length, 0, "no PR past the bound, no remedy");
});

test("W1-T12547 criterion 4: an unread, incomplete or stale census, or an incomplete ledger read, writes UNKNOWN with its reason and files nothing", async (t) => {
  const cases: Array<[string, Parameters<typeof harness>[0]]> = [
    ["census-page-cap-exceeded", { census: async () => census({ complete: false, reason: "census-page-cap-exceeded" }) }],
    ["incomplete-census", { census: async () => census({ ok: false, complete: false }) }],
    ["stale-census", { census: async () => census({ observedAtMs: NOW - 7 * HOUR }) }],
    ["census-read-failed", { census: async () => { throw new Error("GraphQL down"); } }],
    ["ledger-incomplete", { ledgerOk: false }],
  ];
  for (const [reason, opts] of cases) {
    const h = harness(opts);
    t.after(h.cleanup);
    await runFlowGardener(h.deps, h.sources);
    const report = h.repair();
    assert.equal(report?.status, "UNKNOWN", reason);
    assert.equal(report?.reason, reason);
    assert.equal(report?.prs.length, 0, `${reason}: no figures from an unusable read`);
    assert.equal(h.landed.length, 0, `${reason}: nothing is filed`);
  }
});

test("W1-T12547 criterion 5: the flow report file lists each open red or conflicting PR with its ages, oldest first", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  await runFlowGardener(h.deps, h.sources);
  const md = readFileSync(join(h.deps.stateDir, FLOW_REPORT_FILE), "utf8");
  assert.match(md, /## Open red or conflicting pull requests/);
  assert.match(md, /Status OBSERVED \(complete-census\)\. Bound 60 min\./);
  assert.match(md, /\| #501 \| red \| 180 \| 60 \| 90 \| 90 \| yes \|/);
  assert.match(md, /\| #502 \| conflict \| 120 \| no round yet \| - \| 120 \| yes \|/);
  assert.match(md, /\| #505 \| red \| 14400 \| unread \| unread \| unread \| no \|/);
  const order = [505, 501, 502, 506, 503].map((n) => md.indexOf(`| #${n} |`));
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "oldest first");
  assert.doesNotMatch(md, /\| #504 \|/, "a green PR is not listed");
});

test("W1-T12547: the registered production flow pass reports open repair ages from its own census and ledger reads", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-open-repair-registry-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  writeLedger([{ ts: at(NOW - 2 * HOUR), run_id: "DAEMON-1", task_id: "W1-T501", step: "fix.dispatch", head_sha: "head-501" }], { dir: stateDir });
  const node = (p: FlowOpenQueuePr) => ({ number: p.number, createdAt: at(p.createdAtMs), updatedAt: at(p.updatedAtMs), headRefOid: p.headSha,
    headRefName: p.headRefName, isDraft: false, mergeable: p.mergeable, commits: { nodes: [{ commit: { oid: p.headSha, statusCheckRollup: { state: p.checksState } } }] } });
  const open = [pr(501, NOW - 3 * HOUR, "FAILURE", "MERGEABLE"), pr(504, NOW - HOUR, "SUCCESS", "MERGEABLE")];
  const empty = { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  const body = { data: { repository: { pullRequests: { totalCount: open.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: open.map(node) } },
    created: empty, closed: empty } };
  const events: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const pass = flowGardenPass({ stateDir, repoRoot: root, clock: fixedClock(NOW),
    openWorkspace: () => ({ root, branch: "test", land: () => "", dispose: () => {} }),
    log: (step, extra = {}) => events.push({ step, extra }),
  }, "acme", "remudero", () => "W1-T11111", {
    readJson: async (args) => (args[1] === "graphql" ? body : { workflow_runs: [] }),
    admission: { owner: "acme", repo: "remudero" },
  });
  await pass();
  const report = events.find((e) => e.step === FLOW_OPEN_REPAIR_AGES_STEP)?.extra as FlowOpenRepairAges | undefined;
  assert.equal(report?.status, "OBSERVED");
  assert.deepEqual(report?.prs.map((p) => [p.pr, p.kind, p.first_round_delay_ms, p.wait_ms, p.over_bound]), [[501, "red", HOUR, 2 * HOUR, true]]);
  assert.match(readFileSync(join(stateDir, FLOW_REPORT_FILE), "utf8"), /\| #501 \| red \| 180 \| 60 \| 120 \| 120 \| yes \|/);
});
