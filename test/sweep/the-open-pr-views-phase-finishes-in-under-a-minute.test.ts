/**
 * W1-T12530 — THE OPEN-PR VIEWS PHASE OF THE LIGHT SWEEP FINISHES IN UNDER A MINUTE ON A 25-PR BOARD.
 *
 * On the host, the views phase took 235 s to 1,907 s of each light pass on 2026-11-14. The phase now names
 * the time of each stage, runs the per-PR reads of one stage together under the pacer, and reuses a per-PR
 * answer from the last pass while the PR head, the base tip and the check rollup are unchanged.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { createGhCallPacer, createPlanFilingFileCache, type GhCallPacer, type PlanFilingFileCache } from "#src/lib/open-prs-rest.js";
import type { Plan } from "#src/lib/plan.js";
import type { CiFailure, SweepDeps } from "#src/lib/sweep.js";
import {
  buildOpenPrViewsAsync, createOpenPrStageReuse, fetchOpenPrsWithPostedIdsAsync, type OpenPrStageReuse,
} from "#src/lib/tick-read-worker.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { buildSweepLightHook } from "#test/helpers/run-task-test.js";

/** Read from the clock: the list read ages a pull request by `updated_at` against sweep.staleDays. */
const OPENED_AT = new Date().toISOString();
const NO_PLAN: Plan = { tasks: [], byId: new Map() };
const RED = new Set([1, 2, 3]);
const EVIDENCE: CiFailure[] = [{ name: "ci-gate", logTail: "not ok 1", conclusion: "FAILURE" }];

/** A fake GitHub with 25 open PRs. PRs 1-3 are red, so each also has a CI-failure evidence read. */
function board(opts: { delayMs?: number } = {}) {
  const heads = new Map<number, string>(Array.from({ length: 25 }, (_, i) => [i + 1, `head-${i + 1}-a`]));
  const runIds = new Map<number, number>();
  let baseTip: string | undefined = "main-a";
  const failing = new Set<string>();
  const reviews = new Map<number, unknown>();
  const reads: string[] = [];
  const evidenceReads: string[] = [];
  const row = (n: number) => ({
    number: n, html_url: `https://github.com/o/r/pull/${n}`, state: "open", draft: false, title: `fix: ${n}`,
    body: `Remudero-Task: W1-T${n}`, updated_at: OPENED_AT, created_at: OPENED_AT,
    head: { ref: `run-W1-T${n}-1`, sha: heads.get(n) },
  });
  const prOfHead = (path: string) => [...heads].find(([, sha]) => path.includes(`/${sha}/`))?.[0];
  const answer = (path: string): unknown => {
    if (failing.has(path)) throw new Error(`gh: ${path} unavailable`);
    if (path.includes("/pulls?") && path.includes("state=open")) return [...heads.keys()].map(row);
    if (path.includes("/check-runs")) {
      const n = prOfHead(path)!;
      const conclusion = RED.has(n) ? "failure" : "success";
      return { check_runs: [{ id: runIds.get(n) ?? 100 + n, name: "ci-gate", status: "completed", conclusion }] };
    }
    if (path.endsWith("/status")) return { statuses: [] };
    if (path.endsWith("/git/ref/heads/main")) {
      if (baseTip === undefined) throw new Error("gh: main unavailable");
      return { object: { sha: baseTip } };
    }
    if (path.includes("/files")) return [{ filename: "src/a.ts" }];
    const review = /\/pulls\/(\d+)\/reviews\?/.exec(path);
    if (review) return reviews.get(Number(review[1])) ?? [];
    const single = /\/pulls\/(\d+)$/.exec(path);
    if (single) return { ...row(Number(single[1])), mergeable: true, mergeable_state: "clean" };
    return [];
  };
  const fetchAsync = async (args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    reads.push(path);
    if (opts.delayMs) await sleep(opts.delayMs);
    return answer(path);
  };
  const fetchCiFailureEvidenceAsync = async () => {
    evidenceReads.push("evidence");
    if (opts.delayMs) await sleep(opts.delayMs);
    return EVIDENCE;
  };
  return {
    heads, runIds, failing, reviews, reads, evidenceReads, fetchAsync, fetchCiFailureEvidenceAsync,
    setBaseTip: (sha: string | undefined) => { baseTip = sha; },
    /** Reads that name one PR, after the list stage: everything but the list, its rollups and the base tip. */
    perPrReads: () => reads.filter((path) => /\/pulls\/\d+/.test(path)),
  };
}

type Board = ReturnType<typeof board>;

function setup(b: Board, opts: { reuse?: boolean; cache?: PlanFilingFileCache } = {}) {
  const ledger = writeLedger();
  const stageReuse: OpenPrStageReuse | undefined = opts.reuse === false ? undefined : createOpenPrStageReuse();
  const deps = {
    requiredContexts: () => ["ci-gate"], readCiGateRequired: () => [], readMainPlan: () => NO_PLAN,
    fetchAsync: b.fetchAsync, fetchCiFailureEvidenceAsync: b.fetchCiFailureEvidenceAsync,
    planFilingFileCache: opts.cache ?? createPlanFilingFileCache(),
    ...(stageReuse ? { stageReuse } : {}),
  };
  /** One pass, with the read counts cleared first. */
  const pass = (more: Partial<Parameters<typeof buildOpenPrViewsAsync>[3]> = {}) => {
    b.reads.length = 0;
    b.evidenceReads.length = 0;
    return buildOpenPrViewsAsync("o", "r", ledger.path, { ...deps, ...more });
  };
  return { deps, pass, cleanup: () => rmSync(ledger.dir, { recursive: true, force: true }) };
}

/** The plan-filing file lists have their own cache by exact head (W1-T2864), three misses a pass. */
async function warm(b: Board, pass: () => Promise<unknown>) {
  for (let i = 0; i < 12; i++) {
    await pass();
    if (!b.reads.some((path) => path.includes("/files"))) return;
  }
  assert.fail("the plan-filing file cache did not fill");
}

test("W1-T12530 criterion 1: the light pass timing row names the time of each views stage", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t12530-"));
  const repo = "r12530";
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_SHARED_READ_GAP_MS"] as const;
  const oldEnv = keys.map((key) => [key, process.env[key]] as const);
  const pull = {
    number: 1253001, html_url: `https://github.com/o/${repo}/pull/1253001`, state: "open", draft: false, title: "fix: x",
    body: "Remudero-Task: W1-T1253001", updated_at: OPENED_AT, created_at: OPENED_AT,
    head: { ref: "run-W1-T1253001-1", sha: "head-c1" },
  };
  const gh = ghShim([
    { when: "state=open", stdout: JSON.stringify([pull]) },
    { when: "check-runs", stdout: JSON.stringify({ check_runs: [{ id: 1, name: "ci-gate", status: "completed", conclusion: "success" }] }) },
    { when: "protection", stdout: JSON.stringify({ checks: [{ context: "ci-gate" }] }) },
    { when: "/status", stdout: "{\"statuses\":[]}" },
    { when: "git/ref/heads/main", stdout: JSON.stringify({ object: { sha: "main-c1" } }) },
    { when: "/files", stdout: JSON.stringify([{ filename: "src/a.ts" }]) },
    { when: "/pulls/1253001", stdout: JSON.stringify({ ...pull, mergeable_state: "clean" }) },
    { when: "", stdout: "[]" },
  ], { kind: "t12530" });
  process.env.PATH = `${gh.dir}:${process.env.PATH ?? ""}`;
  process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  const logs: Array<Record<string, unknown>> = [];
  const rows: Array<Record<string, unknown>> = [];
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "T12530", readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); }, readLedgerUnion: () => ({ complete: true, lines: rows }),
    readActiveWorkerCount: () => 0, arm: () => assert.fail("unexpected arm"), postReview: () => {},
    close: () => assert.fail("unexpected close"), dispatchFix: () => assert.fail("unexpected fix"),
    escalate: () => assert.fail("unexpected escalation"),
    readLiveState: (p) => ({ ok: true, state: "OPEN", headSha: p.headSha }), rereadPrAtAct: async (p) => p,
  };
  try {
    const hook = buildSweepLightHook("o", repo, { root } as never, effects.ledgerPath, "T12530", NO_PLAN,
      (step, extra) => { logs.push({ step, ...extra }); }, undefined, () => false, () => NO_PLAN, undefined, undefined,
      { effects: () => effects, readCompare: async () => ({ ahead_by: 0, files: [] }) });
    await hook({ reviewOnly: true, scope: "idle" });
    const timing = logs.filter((row) => row.step === "sweep_light.pre_review_timing");
    assert.equal(timing.length, 1, JSON.stringify(logs.filter((row) => String(row.step).includes("error"))));
    assert.equal(timing[0]!.views_source, "own_read");
    const stages = timing[0]!.open_pr_view_stages_ms as Record<string, number>;
    for (const stage of ["open_pr_list", "base_tip", "ledger_read", "plan_read", "plan_filing_files", "merge_states",
      "review_queue_holds", "ci_failures", "views"]) {
      assert.equal(typeof stages[stage], "number", `${stage} in ${JSON.stringify(stages)}`);
      assert.ok(stages[stage]! >= 0, stage);
    }
    assert.ok(gh.calls().some((call) => call.includes(`repos/o/${repo}/pulls/1253001`)), "positive control: the own read ran");
  } finally {
    // A posted review frees a lane, and its refill reads the views after the hook returns. Its paced reads wait
    // 1.5 s with no `gh` call open, so wait until none is open and none starts for 2 s before PATH is restored.
    for (let quiet = 0, rounds = 0; quiet < 40 && rounds < 600; rounds++) {
      const before = gh.events().length;
      await sleep(50);
      const after = gh.events();
      const open = after.filter((e) => e.phase === "start").length - after.filter((e) => e.phase === "end").length;
      quiet = open === 0 && after.length === before ? quiet + 1 : 0;
    }
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(gh.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T12530 criterion 1: the stage times name the slow stage", async () => {
  const b = board();
  const { pass, cleanup } = setup(b);
  try {
    const slowMerge = async (args: string[]): Promise<unknown> => {
      if (/\/pulls\/\d+$/.test(args[1] ?? "")) await sleep(150);
      return b.fetchAsync(args);
    };
    const stagesMs: Record<string, number> = {};
    await pass({ fetchAsync: slowMerge, stagesMs });
    assert.ok(stagesMs.merge_states! >= 140, JSON.stringify(stagesMs));
    const others = Object.entries(stagesMs).filter(([stage]) => stage !== "merge_states");
    assert.ok(others.every(([, ms]) => ms < stagesMs.merge_states!), JSON.stringify(stagesMs));
  } finally { cleanup(); }
});

test("W1-T12530 criterion 2: an unchanged board makes no per-PR read; one moved head reads that PR only", async () => {
  const b = board();
  const cache = createPlanFilingFileCache();
  const warmer = setup(b, { reuse: false, cache });
  await warm(b, warmer.pass);
  warmer.cleanup();
  const { pass, cleanup } = setup(b, { cache });
  try {
    const before = await pass();
    assert.ok(b.perPrReads().length >= 25, `positive control: the first pass read each PR: ${b.perPrReads().length}`);
    assert.equal(b.evidenceReads.length, RED.size, "positive control: each red PR's evidence was read");

    const again = await pass();
    assert.deepEqual(b.perPrReads(), [], "the second pass made no per-PR read");
    assert.equal(b.evidenceReads.length, 0, "the second pass read no CI-failure evidence");
    assert.deepEqual(again, before, "the views are the same");

    // The tick read hands the list in: then only the base tip is read.
    const rows = await fetchOpenPrsWithPostedIdsAsync("o", "r", b.fetchAsync, undefined);
    await pass({ openPrRows: rows });
    assert.deepEqual(b.reads, ["repos/o/r/git/ref/heads/main"], "with the list handed in, no PR is read");

    b.heads.set(7, "head-7-b");
    const moved = await pass();
    assert.ok(b.perPrReads().length > 0, "the moved PR was read");
    assert.ok(b.perPrReads().every((path) => /\/pulls\/7(\/|$)/.test(path)), b.perPrReads().join(" "));
    assert.equal(moved.find((view) => view.prNumber === 7)?.headSha, "head-7-b");
  } finally { cleanup(); }
});

test("W1-T12530 criterion 3: a change to the head, base tip or rollup reads again; a failed or unreadable input is not reused", async () => {
  const b = board();
  const cache = createPlanFilingFileCache();
  const { pass, cleanup } = setup(b, { cache });
  try {
    await warm(b, pass);
    await pass();
    await pass();
    assert.deepEqual(b.perPrReads(), [], "positive control: the unchanged pass reused every answer");

    b.setBaseTip("main-b");
    await pass();
    const merged = new Set(b.perPrReads().filter((path) => /\/pulls\/\d+$/.test(path)));
    assert.equal(merged.size, 25, "a new base tip reads every PR's merge state again");

    b.runIds.set(20, 920);
    await pass();
    assert.deepEqual(b.perPrReads(), ["repos/o/r/pulls/20"], "a changed rollup reads that PR again");
    assert.equal(b.evidenceReads.length, 0);
    b.runIds.set(2, 902);
    await pass();
    assert.deepEqual(b.perPrReads(), ["repos/o/r/pulls/2"], "a red PR whose rollup changed is read again");
    assert.equal(b.evidenceReads.length, 1, "and its new CI-failure evidence is read");

    b.setBaseTip(undefined);
    await pass();
    assert.ok(b.perPrReads().filter((path) => /\/pulls\/\d+$/.test(path)).length === 25,
      "an unreadable base tip reuses nothing");
    b.setBaseTip("main-b");

    b.failing.add("repos/o/r/pulls/11");
    await pass();
    b.failing.delete("repos/o/r/pulls/11");
    await pass();
    assert.ok(b.perPrReads().includes("repos/o/r/pulls/11"), "a failed read is read again next pass");
    assert.ok(b.perPrReads().every((path) => /\/pulls\/11(\/|$)/.test(path)), b.perPrReads().join(" "));

    b.failing.add("repos/o/r/commits/head-12-a/check-runs?per_page=100");
    for (let i = 0; i < 2; i++) await pass();
    assert.ok(b.perPrReads().includes("repos/o/r/pulls/12"), "a PR whose rollup is unreadable is read every pass");
    b.failing.clear();

    // The review hydrator used to discard an unreadable listing as undefined, which the stage
    // cache mistook for a successful empty listing. Recovery must be visible on the next pass.
    b.heads.set(7, "head-7-c");
    b.reviews.set(7, { message: "malformed review listing" });
    const unreadable = await pass();
    assert.equal(unreadable.find((view) => view.prNumber === 7)?.reviewQueueHold, undefined);
    assert.ok(b.perPrReads().includes("repos/o/r/pulls/7/reviews?per_page=100"),
      "positive control: the malformed review listing was read");
    b.reviews.set(7, [{ id: 707, user: { login: "human", type: "User" }, state: "CHANGES_REQUESTED",
      commit_id: "head-7-c", submitted_at: "2026-11-14T01:00:00Z" }]);
    const recovered = await pass();
    assert.ok(b.perPrReads().includes("repos/o/r/pulls/7/reviews?per_page=100"),
      "unchanged inputs must retry an unreadable review listing");
    assert.equal(recovered.find((view) => view.prNumber === 7)?.reviewQueueHold?.kind, "changes-requested");
    const freshAfterRecovery = setup(b, { reuse: false, cache });
    try {
      assert.deepEqual(recovered, await freshAfterRecovery.pass(), "recovered cached view equals a fresh build");
    } finally { freshAfterRecovery.cleanup(); }

    // invariant:no-stale-view — the reused views equal a fresh build for the same inputs.
    await pass();
    const reused = await pass();
    assert.deepEqual(b.perPrReads(), []);
    const fresh = setup(b, { reuse: false, cache });
    try {
      assert.deepEqual(reused, await fresh.pass(), "a view built from reused answers equals a fresh one");
    } finally { fresh.cleanup(); }
  } finally { cleanup(); }
});

test("W1-T12530 criterion 4: the per-PR reads of one stage run together under the pacer", async () => {
  const b = board({ delayMs: 200 });
  const { pass, cleanup } = setup(b, { reuse: false });
  let waits = 0;
  const inner = createGhCallPacer({ minGapMs: 5 });
  const pacer: GhCallPacer = { ...inner, waitAsync: async () => { waits += 1; await inner.waitAsync!(); } };
  try {
    const started = performance.now();
    const views = await pass({ pacer });
    const elapsed = performance.now() - started;
    assert.equal(views.length, 25, "positive control: every PR was built");
    const serialMs = (b.reads.length + b.evidenceReads.length) * 200;
    assert.ok(b.perPrReads().length >= 25, `positive control: ${b.perPrReads().length} per-PR reads`);
    assert.ok(elapsed < serialMs / 4, `${Math.round(elapsed)} ms against ${serialMs} ms serial`);
    assert.ok(waits >= b.perPrReads().length + 50, `every per-PR read waited on the pacer: ${waits}`);
  } finally { cleanup(); }
});
