import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { acquireDrainLock } from "#src/lib/drain-lock.js";
import type { DaemonDeps, DaemonSummary } from "#src/lib/daemon.js";
import type { Plan } from "#src/lib/plan.js";

type Deps = NonNullable<Parameters<typeof daemonCommand>[1]>;
type Row = Record<string, unknown> & { step: string };
const stopped: DaemonSummary = { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };

function generationFor(n: number, plan: unknown, task: string) {
  const now = Date.now();
  return { generation: n, source: "inline", publishedAtMs: now, settledAtMs: now, facts: {
    plan, projection: [[task, { taskId: task, merged: true, status: "merged", source: "credit" }]], openBranches: [], creditUpdates: [] } };
}

/** A daemon on a temporary root. Only the read plane's thread is replaced: the early read, its use by the
 *  first tick and its release are the production code in daemonCommand. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}first-tick-read-`));
  mkdirSync(join(root, "state"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const lock = join(root, "state", "drain.lock");
  const rows = (): Row[] => {
    const path = join(root, "state", "ledger.ndjson");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row) : [];
  };
  const state = { childModeRead: false, planes: 0, stops: 0 };
  const reads: Array<{ plan: unknown; lockHeld: boolean; steps: string[]; childModeRead: boolean }> = [];
  const answers: Array<(input: { plan: unknown }, n: number) => Promise<unknown>> = [];
  const startReadPlane = (() => {
    state.planes++;
    return {
      read: (input: { plan: unknown }) => {
        reads.push({ plan: input.plan, lockHeld: existsSync(lock), steps: rows().map((row) => row.step), childModeRead: state.childModeRead });
        const answer = answers[reads.length - 1] ?? ((given: { plan: unknown }, n: number) => Promise.resolve(generationFor(n, given.plan, "W1-T1")));
        return answer(input, reads.length);
      },
      stop: async () => { state.stops++; },
    };
  }) as never;
  const deps: Deps = {
    config: { root, claudeBin: "/bin/true" }, repoRoot: REPO_ROOT,
    startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
    checkPause: () => undefined, checkStop: () => undefined,
    readRunChildMode: () => { state.childModeRead = true; return "off"; },
    runDaemon: async () => stopped,
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
    wireSweepWake: () => ({ sleep: async () => "timeout", acknowledge: () => {}, close: () => {} }),
    startGitCredentialSocket: async () => undefined,
    startMemoryCensus: () => () => {},
    startReadPlane,
  };
  return {
    root, lock, rows, reads, answers, state,
    firstTickRows: () => rows().filter((row) => row.step === "daemon.first_tick_read"),
    run: (overrides: Deps = {}, args: string[] = []) =>
      daemonCommand(["--allow-self-target", "--plan", planPath, ...args], { ...deps, ...overrides }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("W1-T12239 criterion 1: the read starts after the mint and the plan load, before the lifetime history, the lock and the adoption", async () => {
  const f = fixture();
  let releaseMint!: () => void;
  const ready = new Promise<void>((resolve) => { releaseMint = resolve; });
  let releaseRead!: () => void;
  const held = new Promise<void>((resolve) => { releaseRead = resolve; });
  f.answers[0] = async (input, n) => { await held; return generationFor(n, input.plan, "W1-T1"); };
  let loopPlan: Plan | undefined;
  try {
    const running = f.run({
      startGithubAppRefresh: () => ({ armed: true, ready, stop: () => {} }),
      runDaemon: async (plan, deps: DaemonDeps) => {
        loopPlan = plan;
        assert.equal(f.reads.length, 1, "the early read started before the loop");
        assert.ok(f.rows().some((row) => row.step === "daemon.start"), "daemon.start was not held behind the read");
        releaseRead();
        assert.equal((await deps.refreshMergedAsync!(plan))("W1-T1"), true);
        return stopped;
      },
    });
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(f.reads.length, 0, "no read before the token mint settles");
    releaseMint();
    assert.equal(await running, 0);
    const [early] = f.reads;
    assert.ok(early);
    assert.equal(early.plan, loopPlan, "the read is made for the plan the loop is given");
    assert.equal(early.lockHeld, false, "the read started before the daemon lock");
    assert.equal(early.childModeRead, false, "the read started before the adoption of run children");
    for (const step of ["dispatch.lifetime_history_loaded", "dispatch.lifetime_history_unavailable", "daemon.start"]) {
      assert.equal(early.steps.includes(step), false, `the read started before ${step}`);
    }
    assert.ok(early.steps.includes("daemon.target"), "positive control: the boot rows before the read are visible");
  } finally {
    f.cleanup();
  }
});

test("W1-T12239 criterion 2: the first tick uses the early read and asks for no second one", async () => {
  const f = fixture();
  try {
    assert.equal(await f.run({
      runDaemon: async (plan, deps: DaemonDeps) => {
        const merged = await deps.refreshMergedAsync!(plan);
        assert.equal(merged("W1-T1"), true, "refreshMergedAsync returns the early read");
        assert.equal(f.reads.length, 1, "the first tick asked for no second read");
        await deps.refreshMergedAsync!(plan);
        assert.equal(f.reads.length, 2, "a later tick reads as before");
        return stopped;
      },
    }), 0);
    const [row, ...more] = f.firstTickRows();
    assert.equal(more.length, 0);
    assert.equal(row?.source, "early");
    assert.equal(typeof row?.first_tick_read_ms, "number");
    assert.equal(typeof row?.first_tick_read_overlap_ms, "number");
  } finally {
    f.cleanup();
  }
});

test("W1-T12239 criterion 3: a plan that changed before the first tick gets a new read", async () => {
  const f = fixture();
  f.answers[1] = async (input, n) => generationFor(n, input.plan, "W1-T2");
  try {
    assert.equal(await f.run({
      runDaemon: async (plan, deps: DaemonDeps) => {
        const fresh = { ...plan } as Plan;
        deps.onPlanReload?.(fresh);
        const merged = await deps.refreshMergedAsync!(fresh);
        assert.equal(f.reads.length, 2, "the first tick asked for a new read");
        assert.equal(f.reads[1]?.plan, fresh, "the new read is made for the changed plan");
        assert.equal(merged("W1-T2"), true);
        assert.equal(merged("W1-T1"), false, "the early read is not used");
        return stopped;
      },
    }), 0);
    assert.deepEqual(f.firstTickRows().map((row) => row.source), ["plan_changed"]);
  } finally {
    f.cleanup();
  }
});

test("W1-T12239 criterion 4: a failed early read leaves the first tick to read as before, and the daemon starts", async () => {
  const f = fixture();
  f.answers[0] = async () => { throw new Error("early read refused by fixture"); };
  f.answers[1] = async (input, n) => generationFor(n, input.plan, "W1-T2");
  let started = false;
  try {
    assert.equal(await f.run({
      runDaemon: async (plan, deps: DaemonDeps) => {
        started = true;
        const merged = await deps.refreshMergedAsync!(plan);
        assert.equal(f.reads.length, 2);
        assert.equal(merged("W1-T2"), true, "the first tick used its own read");
        return stopped;
      },
    }), 0);
    assert.equal(started, true);
    const rows = f.firstTickRows();
    assert.equal(rows.length, 1, "one row names the failed early read");
    assert.equal(rows[0]?.source, "early_failed");
    assert.equal(rows[0]?.reason, "early read refused by fixture");
  } finally {
    f.cleanup();
  }
});

test("W1-T12239 criterion 5: a refused lock or a start under STOP closes the worker and reads no more", async () => {
  const refused = fixture();
  const holder = acquireDrainLock(refused.lock);
  try {
    assert.equal(await refused.run(), 1, "a second daemon is refused the lock");
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(refused.reads.length, 1, "only the early read was made");
    assert.equal(refused.state.stops, 1, "the refused daemon closed its worker");
  } finally {
    holder.release();
    refused.cleanup();
  }
  const underStop = fixture();
  try {
    // The production loop: its first tick reads STOP and returns before it reads, so no early read is started.
    assert.equal(await underStop.run({ runDaemon: undefined, checkStop: () => "fixture stop" }), 0);
    for (let i = 0; i < 5; i++) await flush();
    assert.ok(underStop.rows().some((row) => row.step === "daemon.stop"), "positive control: the real loop saw STOP");
    assert.equal(underStop.reads.length, 0, "no read was made");
    assert.equal(underStop.state.stops, 1, "the stopped daemon closed its worker");
    assert.equal(underStop.firstTickRows().length, 0, "no tick asked for a read");
  } finally {
    underStop.cleanup();
  }
});

test("W1-T12239 criterion 6: a dry run starts no worker and makes no early read", async () => {
  const f = fixture();
  // The preview's own board read, unchanged by this task, answers from a stub.
  const gh = ghShim([{ when: "pulls?state=", stdout: "[]" }], { kind: "first-tick-read-dry-run-gh" });
  const path = process.env.PATH;
  process.env.PATH = `${gh.dir}:${path ?? ""}`;
  try {
    assert.equal(await f.run({}, ["--dry-run"]), 0);
    assert.ok(gh.calls().length > 0, "positive control: the preview ran its board read");
    assert.equal(f.state.planes, 0, "no read plane was started");
    assert.equal(f.reads.length, 0);
  } finally {
    process.env.PATH = path;
    rmSync(gh.dir, { recursive: true, force: true });
    f.cleanup();
  }
});
