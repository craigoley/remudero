import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { buildSweepEffects, buildSweepLightHook } from "#src/run-task.js";
import { LightPassPreReviewTiming, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { ghShim } from "#test/helpers/gh-shim.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let settled = false;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve: (value: T) => { settled = true; resolve(value); }, get settled() { return settled; } };
}

function pr(prNumber: number, ready = false): OpenPrView {
  return { prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`,
    headSha: `head-${prNumber}`, headRefName: `run-W1-T${prNumber}-1`, lastActivityAt: new Date().toISOString(), reviewState: ready ? "success" : "none",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, mergeState: "clean",
    changedFiles: ["src/subject.ts"] };
}

function fixture(prs: OpenPrView[]) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t9918-"));
  const shim = ghShim([{ when: "", stdout: "[]" }]);
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_SHARED_READ_GAP_MS"] as const;
  const oldEnv = keys.map((key) => [key, process.env[key]] as const);
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  const rows: Array<Record<string, unknown>> = prs.filter((p) => p.reviewState === "success").map((p) => ({
    step: "review.posted", task_id: p.taskId, pr_url: p.prUrl, head_sha: p.headSha,
    state: "success", capped: false, plan_only: false,
  }));
  const logs: Array<Record<string, unknown>> = [];
  const arms: number[] = [];
  const updates: number[] = [];
  const reviewed: number[] = [];
  let clock = 0;
  let main = "main-1";
  const compares: string[][] = [];
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "T9918", readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); }, readLedgerUnion: () => ({ complete: true, lines: rows }),
    readActiveWorkerCount: () => 0, arm: (p) => { arms.push(p.prNumber); return "armed"; },
    postReview: (p) => { reviewed.push(p.prNumber); }, close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"), escalate: () => assert.fail("unexpected escalation"),
    readMainTip: async () => main, readLiveState: (p) => ({ ok: true, state: "OPEN", headSha: p.headSha }),
    rereadPrAtAct: async (p) => p,
    readActionsStatusSummary: async () => { clock += 11; return { components: [], incidents: [] }; },
    readBranchProtectionStrict: async () => { clock += 13; return false; },
    updateBranch: (p) => { clock += 17; updates.push(p.prNumber); return "updated"; },
  };
  const io: NonNullable<Parameters<typeof buildSweepLightHook>[12]> = {
    openPrViews: async () => { clock += 3; return prs; },
    effects: () => effects,
    readCompare: async (args: string[]) => {
      clock += 7;
      compares.push(args);
      return { ahead_by: 2, files: [{ filename: "src/subject.ts" }] };
    },
    clock: { now: () => clock },
  };
  const hook = () => buildSweepLightHook("o", "r", { root } as never, effects.ledgerPath, "T9918",
    { tasks: [], byId: new Map() } as never, (step, extra) => { logs.push({ step, ...extra }); },
    undefined, undefined, undefined, undefined, undefined, io);
  return { prs, rows, logs, arms, updates, reviewed, effects, io, compares, hook, shim,
    advance: (ms: number) => { clock += ms; },
    main: (sha: string) => { main = sha; },
    cleanup: () => {
      for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(shim.dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } };
}

test("W1-T9918: a light pass ledgers each pre-review phase duration", async (t) => {
  const f = fixture([pr(991801, true)]);
  f.effects.readMainTip = async () => { f.advance(19); return "main-1"; };
  f.effects.readLedger = () => { f.advance(5); return f.rows.slice(); };
  try {
    await f.hook()();
    assert.deepEqual(f.logs.filter((r) => r.step === "sweep_light.error"), []);
    const timing = f.logs.filter((r) => r.step === "sweep_light.pre_review_timing");
    assert.equal(timing.length, 1);
    const phases = timing[0]!.phase_ms as Record<string, number>;
    assert.deepEqual(phases, { open_pr_views: 3, main_tip: 19, compare: 7, ready_ledger: 5,
      ready_actions: 11, ready_value_gate: 13, ready_update: 17, refresh_admission: 5,
      armed_ratchet_rejudge: 0, review_selection_ledger: 0 });
    assert.equal(timing[0]!.compare_count, 1);
    assert.deepEqual(timing[0]!.compare_reads, [{ pr_number: 991801, head_sha: "head-991801",
      main_sha: "main-1", cache_hit: false, outcome: "read", elapsed_ms: 7 }]);
    assert.ok(Number.isFinite(timing[0]!.sync_on_loop_ms));
    t.diagnostic(JSON.stringify(timing[0]));
    assert.deepEqual(f.updates, [991801]);
    assert.deepEqual(f.arms, [], "the refreshed snapshot cannot arm");
    assert.deepEqual(f.reviewed, []);
  } finally { f.cleanup(); }

  const blocking = fixture([pr(991803)]);
  delete blocking.io.clock;
  let blockedMs = 0;
  blocking.effects.readLedger = () => {
    if (blockedMs === 0) {
      const start = performance.now();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
      blockedMs = performance.now() - start;
    }
    return blocking.rows.slice();
  };
  try {
    await blocking.hook()();
    assert.ok(blocking.rows.some((row) => row.step === "sweep.review_eligible"));
    const rows = blocking.logs.filter((row) => row.step === "sweep_light.pre_review_timing");
    assert.equal(rows.length, 1);
    assert.ok(Number(rows[0]!.sync_on_loop_ms) >= blockedMs, JSON.stringify(rows[0]));
    assert.ok(Number((rows[0]!.phase_ms as Record<string, number>).review_selection_ledger) >= blockedMs,
      "the blocking read before eligibility must be attributed to its phase");
    t.diagnostic(JSON.stringify({ ...rows[0], injected_block_ms: blockedMs }));
  } finally { blocking.cleanup(); }
});

test("W1-T9918: a non-ready PR is review-eligible before the ready refresh settles", async (t) => {
  for (const held of ["main_tip", "compare", "actions", "value_gate", "admission"] as const) {
    const f = fixture([pr(991811, true), pr(991812)]);
    const gate = deferred<void>();
    const entered = deferred<void>();
    if (held === "main_tip") {
      f.effects.readMainTip = async () => { entered.resolve(); await gate.promise; return "main-1"; };
      f.io.readCompare = async () => ({ ahead_by: 0, files: [] });
    }
    if (held === "compare") f.io.readCompare = async (args) => {
      f.compares.push(args); entered.resolve(); await gate.promise;
      return { ahead_by: 0, files: [] };
    };
    if (held === "actions") f.effects.readActionsStatusSummary = async () => {
      entered.resolve(); await gate.promise; return { components: [], incidents: [] };
    };
    if (held === "value_gate") {
      f.effects.readBranchProtectionStrict = async () => {
        entered.resolve(); await gate.promise; return false;
      };
    }
    if (held === "admission") {
      f.rows.push({ step: "sweep.base_red.refresh_admission", waiting: [{ pr_number: 991811,
        head_sha: f.prs[0]!.headSha, arm: "base-red", held_since: new Date().toISOString(),
        refresh_row: { run_id: "old", task_id: "W1-T991811", step: "sweep.base_red.refreshed" } }] });
      f.io.readCompare = async () => ({ ahead_by: 0, files: [] });
      f.effects.readLiveHeadSha = async () => { entered.resolve(); await gate.promise; return "updated-head"; };
    }
    const running = f.hook()();
    try {
      await t.waitFor(() => entered.settled, { interval: 1, timeout: 2000 });
      await turn();
      assert.equal(gate.settled, false);
      assert.ok(f.rows.some((r) => r.step === "sweep.review_eligible" && r.pr_number === 991812), held);
      assert.deepEqual(f.arms, [], "a ready head cannot arm while its distance/refresh is pending");
    } finally {
      gate.resolve(); await running; f.cleanup();
    }
    if (held === "compare" || held === "main_tip") assert.deepEqual(f.arms, [991811], JSON.stringify({ rows: f.rows, logs: f.logs }));
    else assert.deepEqual(f.updates, [991811], "the same overlap winner is refreshed");
  }

  const armed = { ...pr(991813), autoMergeArmed: true, checksState: "pending" as const };
  const f = fixture([pr(991814, true), armed, pr(991815)]);
  const gate = deferred<void>();
  const entered = deferred<void>();
  const judged: number[] = [];
  f.io.readCompare = async () => ({ ahead_by: 0, files: [] });
  f.effects.readActionsStatusSummary = async () => {
    entered.resolve(); await gate.promise; return { components: [], incidents: [] };
  };
  f.effects.readMergedRatchets = async (view) => {
    judged.push(view.prNumber);
    return { verdict: "crossing", reason: "two ratchet changes cross the ceiling together",
      rows: [], counted: ["comment-load"], uncounted: [] };
  };
  const running = f.hook()();
  try {
    await t.waitFor(() => entered.settled, { interval: 1, timeout: 2000 });
    await turn();
    assert.equal(gate.settled, false);
    assert.ok(f.rows.some((row) => row.step === "sweep.review_eligible" && row.pr_number === 991815));
    assert.deepEqual(f.arms, [], "ready arms still wait for the whole-snapshot refresh");
    gate.resolve(); await running;
    assert.deepEqual(judged, [991813], "only the whole-snapshot owner judges the armed PR");
    assert.deepEqual(f.updates, [991813], "the original armed-ratchet refresh winner is preserved");
    assert.deepEqual(f.rows.filter((row) => row.step === "sweep.ratchet_judge.decided")
      .map((row) => row.remedy), ["update-branch"]);
    assert.deepEqual(f.arms, [991814]);
    assert.deepEqual(f.logs.filter((row) => row.step === "sweep_light.error"), []);
  } finally { gate.resolve(); await running; f.cleanup(); }
});

test("W1-T9918: an unchanged head and main reuse their compare off the loop", async (t) => {
  const f = fixture([pr(991821, true)]);
  f.effects.updateBranch = undefined;
  const gate = deferred<void>();
  const entered = deferred<void>();
  f.io.readCompare = async (args) => {
    f.compares.push(args); entered.resolve(); await gate.promise;
    return { ahead_by: 0, files: [] };
  };
  const hook = f.hook();
  const first = hook();
  try {
    await t.waitFor(() => entered.settled, { interval: 1, timeout: 2000 });
    await turn();
    assert.deepEqual(f.arms, []);
    gate.resolve(); await first;
    await hook();
    assert.equal(f.compares.length, 1);
    const memoTiming = f.logs.filter((r) => r.step === "sweep_light.pre_review_timing").at(-1)!;
    assert.equal(memoTiming.compare_count, 0);
    assert.equal((memoTiming.compare_reads as Array<Record<string, unknown>>)[0]!.cache_hit, true);
    assert.ok(f.compares[0]!.includes("repos/o/r/compare/head-991821...main-1"));
    f.main("main-2"); await hook();
    assert.equal(f.compares.length, 2, "moving main invalidates the pair");
    f.prs[0]!.headSha = "next-head"; await hook();
    assert.equal(f.compares.length, 3, "moving the head invalidates the pair");
    f.prs.splice(0); await hook();
    f.prs.push(pr(991821, true)); await hook();
    assert.equal(f.compares.length, 4, "a closed PR retains no memo");
  } finally { gate.resolve(); await first; f.cleanup(); }
});

test("W1-T9918: the default compare transport leaves the loop available while its child is running", async (t) => {
  const f = fixture([pr(991831, true)]);
  delete f.io.readCompare;
  f.shim.addRoute({ when: "compare/", delaySeconds: 0.2, stdout: JSON.stringify({ ahead_by: 0, files: [] }) });
  let settled = false;
  const running = f.hook()().finally(() => { settled = true; });
  try {
    await t.waitFor(() => f.shim.events().some((e) => e.phase === "start" && e.args.some((a) => a.includes("compare/"))),
      { interval: 1, timeout: 2000 });
    await turn();
    assert.equal(settled, false);
    assert.equal(f.shim.events().filter((e) => e.phase === "end" && e.args.some((a) => a.includes("compare/"))).length, 0);
    assert.deepEqual(f.arms, []);
    await running;
    assert.deepEqual(f.arms, [991831]);
    assert.deepEqual(f.logs.filter((r) => r.step === "sweep_light.error"), []);
  } finally { await running; f.cleanup(); }
});

test("W1-T9918: the default ready value-gate read leaves the loop available", async (t) => {
  const f = fixture([pr(991832, true), pr(991833)]);
  f.io.effects = (deps) => ({ ...f.effects,
    readBranchProtectionStrict: buildSweepEffects(deps).readBranchProtectionStrict });
  const endpoint = "branches/main/protection/required_status_checks";
  f.shim.addRoute({ when: endpoint, delaySeconds: 0.2, stdout: JSON.stringify({ strict: false }) });
  let settled = false;
  const running = f.hook()().finally(() => { settled = true; });
  try {
    await t.waitFor(() => f.shim.events().some((e) => e.phase === "start" && e.args.some((a) => a.includes(endpoint))),
      { interval: 1, timeout: 2000 });
    await turn();
    assert.equal(settled, false);
    assert.equal(f.shim.events().filter((e) => e.phase === "end" && e.args.some((a) => a.includes(endpoint))).length, 0);
    assert.ok(f.rows.some((r) => r.step === "sweep.review_eligible" && r.pr_number === 991833));
    assert.deepEqual(f.arms, [], "the ready PR still waits for its value gate");
    await running;
    assert.deepEqual(f.updates, [991832]);
    assert.deepEqual(f.logs.filter((r) => r.step === "sweep_light.error"), []);
  } finally { await running; f.cleanup(); }
});

test("W1-T9918: unreadable compares are attributed and retried instead of memoized", async () => {
  for (const response of ["throw", "malformed", "missing-files", "truncated"] as const) {
    const f = fixture([pr(991841, true)]);
    f.effects.updateBranch = undefined;
    let calls = 0;
    f.io.readCompare = async () => {
      calls++;
      if (response === "throw") throw new Error("compare unavailable");
      if (response === "malformed") return { ahead_by: "unknown" };
      return { ahead_by: 2, ...(response === "truncated"
        ? { files: Array.from({ length: 300 }, () => ({ filename: "src/subject.ts" })) } : {}) };
    };
    try {
      const hook = f.hook(); await hook(); await hook();
      assert.equal(calls, response === "throw" || response === "malformed" ? 2 : 1, response);
      const timing = f.logs.filter((r) => r.step === "sweep_light.pre_review_timing")[0]!;
      const row = (timing.compare_reads as Array<Record<string, unknown>>)[0]!;
      assert.equal(row.outcome, response === "throw" ? "error" : response === "malformed" ? "unreadable" : "read");
      if (response === "throw") assert.match(String(row.error), /compare unavailable/);
      if (response === "throw" || response === "malformed") {
        assert.deepEqual(f.arms, [], "unknown distance cannot arm");
        assert.ok(f.rows.some((r) => r.step === "sweep.disposed" && r.pr_number === 991841 &&
          String(r.stand_down_reason).includes("distance is unreadable")), "a held head still receives its disposition");
      }
    } finally { f.cleanup(); }
  }
});

test("W1-T9918: an unreadable main tip uses an uncached async compare and preserves non-ready eligibility", async () => {
  const f = fixture([pr(991851, true), pr(991852)]);
  f.effects.readMainTip = async () => undefined;
  f.io.readCompare = async (args) => { f.compares.push(args); return { ahead_by: 0, files: [] }; };
  try {
    const hook = f.hook(); await hook(); await hook();
    assert.ok(f.rows.some((r) => r.step === "sweep.review_eligible" && r.pr_number === 991852));
    assert.equal(f.logs.filter((r) => r.step === "sweep_light.pre_review_timing").length, 2);
    const timing = f.logs.find((r) => r.step === "sweep_light.pre_review_timing")!;
    assert.equal((timing.compare_reads as Array<Record<string, unknown>>)[0]!.main_sha, null);
    assert.equal(f.compares.length, 2);
    assert.ok(f.compares.every((args) => args.includes("repos/o/r/compare/head-991851...main")));
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.arms, [991851]);
  } finally { f.cleanup(); }
});

test("W1-T9918: a rejected main-tip reader is attributed before the uncached compare", async () => {
  const f = fixture([pr(991861, true)]);
  f.effects.readMainTip = async () => { throw new Error("main tip unreadable"); };
  try {
    await f.hook()();
    assert.match(String(f.logs.find((r) => r.step === "sweep_light.main_tip_unreadable")?.error), /main tip unreadable/);
    assert.equal(f.compares.length, 1);
    assert.equal(f.logs.filter((r) => r.step === "sweep_light.pre_review_timing").length, 1);
  } finally { f.cleanup(); }
});

test("W1-T9918: synchronous on-loop timing follows owned continuations and excludes sibling work", async () => {
  const timing = new LightPassPreReviewTiming();
  const gate = deferred<void>();
  const cell = new Int32Array(new SharedArrayBuffer(4));
  let ownedMs = 0;
  const block = (ms: number) => {
    const start = performance.now();
    Atomics.wait(cell, 0, 0, ms);
    return performance.now() - start;
  };
  const start = performance.now();
  const running = timing.run(async () => {
    ownedMs += block(15);
    await gate.promise;
    ownedMs += block(15);
  });
  const siblingMs = block(60);
  gate.resolve(); await running;
  const elapsed = performance.now() - start;
  const row = timing.finish();
  assert.ok(Number(row.sync_on_loop_ms) >= ownedMs * 0.9, JSON.stringify(row));
  assert.ok(Number(row.sync_on_loop_ms) < elapsed - siblingMs * 0.9, JSON.stringify(row));
});
