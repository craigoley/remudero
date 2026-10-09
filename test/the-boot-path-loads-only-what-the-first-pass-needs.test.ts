import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { daemonCommand, type auditedLifetimeTalliesFromArchives } from "../src/run-task.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { runnableCandidates } from "../src/lib/drain.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const PROOF = "test/the-boot-path-loads-only-what-the-first-pass-needs.test.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}boot-needs-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "Remudero");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return { home, root, stateDir, planPath, plan: loadPlan(planPath) };
}

async function capture(t: Parameters<typeof fixture>[0], loadLifetimeHistory?: typeof auditedLifetimeTalliesFromArchives) {
  const f = fixture(t);
  const previousHome = process.env.HOME;
  process.env.HOME = f.home;
  let wired: DaemonDeps | undefined;
  try {
    assert.equal(await daemonCommand(["--allow-self-target", "--plan", f.planPath, "--max", "0"], {
      loadLifetimeHistory,
      runDaemon: async (_plan, deps) => {
        wired = deps;
        return { attempted: [], merged: [], stopReason: "max_reached", costUsd: 0, ticks: 0 };
      },
    }), 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.ok(wired);
  return { ...f, wired };
}

test(`${PROOF}: boot builds no lifetime history until selection asks, then shares one build`, async (t) => {
  let builds = 0;
  let holdBuild = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const f = await capture(t, async () => {
    builds++;
    if (holdBuild) await held;
    return { history: { tallyFor: () => ({ starts: 2, capacityBlocked: 0 }) },
      unavailableReason: undefined, archiveCount: 1, records: 2, unread: [] };
  });
  assert.equal(builds, 0, "boot must not invoke the history producer");
  assert.doesNotMatch(readFileSync(join(f.stateDir, "ledger.ndjson"), "utf8"), /dispatch\.lifetime_history_loaded/);
  assert.equal(typeof f.wired.prepareSelection, "function", "the real command wires lazy selection preparation");
  holdBuild = true;
  const first = f.wired.prepareSelection!();
  const second = f.wired.prepareSelection!();
  await Promise.resolve();
  assert.equal(builds, 1, "concurrent first requests share the pending build");
  release();
  await Promise.all([first, second]);
  for (let pass = 0; pass < 2; pass++) {
    await f.wired.prepareSelection!();
    let pressure = 0;
    assert.equal(runnableCandidates(f.plan, () => false, 1, {
      beginSelectionPass: f.wired.beginSelectionPass,
      isLifetimeCapExceeded: f.wired.isLifetimeCapExceeded,
      onLifetimePressure: () => { pressure++; },
    })[0]?.id, "A");
    assert.equal(pressure, 1, "selection uses the archived history on every pass");
  }
  assert.equal(builds, 1, "later selections reuse this process's history");
});

test(`${PROOF}: selection awaits history before consulting its synchronous predicates`, async (t) => {
  const events: string[] = [];
  const f = fixture(t);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const running = runDaemon(f.plan, {
    refreshMerged: () => () => false,
    prepareSelection: async () => { events.push("history-start"); await held; events.push("history-ready"); },
    isLifetimeCapExceeded: () => { events.push("predicate"); return false; },
    runOne: async (id) => ({ taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" }),
    sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
  }, { max: 1, headroomEnabled: false });
  try {
    for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["history-start"]);
  } finally {
    release();
    await running;
  }
  assert.deepEqual(events, ["history-start", "history-ready", "predicate"]);
});

for (const outcome of ["available", "unavailable", "rejected"] as const) {
  test(`${PROOF}: ${outcome} history is loaded once and its outcome remains observable`, async (t) => {
    let builds = 0;
    const f = await capture(t, outcome === "available" ? undefined : async () => {
      builds++;
      if (outcome === "rejected") throw new Error("history scan failed");
      return { history: undefined, unavailableReason: "archive_unreadable", archiveCount: 1, records: 0, unread: ["broken.ndjson"] };
    });
    const prepare = f.wired.prepareSelection;
    assert.equal(typeof prepare, "function");
    if (outcome === "available") {
      writeFileSync(join(f.stateDir, "ledger.2026-10-04T00-00-00-000Z.ndjson"),
        JSON.stringify({ step: "run.start", task_id: "A", run_id: "archive-A", ts: "2026-10-04T00:00:00Z" }) + "\n");
    }
    if (outcome === "rejected") {
      await assert.rejects(prepare!(), /history scan failed/);
      await assert.rejects(prepare!(), /history scan failed/);
    } else {
      await prepare!();
      await prepare!();
      const rows = readFileSync(join(f.stateDir, "ledger.ndjson"), "utf8").trim().split("\n").map((row) => JSON.parse(row));
      const history = rows.filter((row) => row.step === `dispatch.lifetime_history_${outcome === "available" ? "loaded" : "unavailable"}`);
      assert.equal(history.length, 1);
      if (outcome === "unavailable") {
        assert.equal(history[0].reason, "archive_unreadable");
        assert.deepEqual(history[0].unread_archives, ["broken.ndjson"]);
        assert.equal(f.wired.isLifetimeCapExceeded!("A"), false);
      }
    }
    if (outcome !== "available") assert.equal(builds, 1);
  });
}

for (const end of ["settled", "failed", "backstop", "exit"] as const) {
  test(`${PROOF}: knowledge gardening waits for the full pass (${end})`, async (t) => {
    const f = fixture(t);
    // A malformed state makes the gardener's first attempted pass observable without corpus work.
    writeFileSync(join(f.stateDir, "knowledge-gardener.json"), "invalid json");
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let stop = false;
    const running = runDaemon(f.plan, {
      refreshMerged: () => () => false,
      runOne: async (id) => { stop = true; return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" }; },
      sweep: async () => { events.push("full-start"); await held; events.push("full-settled"); if (end === "failed") throw new Error("full pass failed"); },
      sweepLight: async () => { events.push("light"); },
      knowledgeGardener: { repoRoot: f.root, stateDir: f.stateDir,
        openWorkspace: () => { throw new Error("fixture must never open a workspace"); },
        log: (step, row) => { assert.equal(step, "knowledge.gardener_failed"); assert.ok(row?.error); events.push("knowledge-start"); } },
      checkStop: () => stop ? "fixture exit" : undefined,
      sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
      log: (step) => { if (step === "daemon.boot_gate.opened") { events.push("gate-open"); if (end === "backstop") release(); } },
    }, { max: end === "exit" ? 0 : 1, headroomEnabled: false, pollIntervalMs: 60_000,
      bootCadenceGateBoundMs: end === "backstop" ? 1 : 60_000, sweepWallClockBoundMs: 60_000 });
    try {
      for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      if (end !== "backstop") assert.ok(!events.includes("knowledge-start"), `gardener ran before settlement: ${events}`);
    } finally {
      release();
      await running;
    }
    if (end === "exit") assert.ok(!events.includes("knowledge-start"), "shutdown must not start deferred work");
    else {
      assert.equal(events.filter((event) => event === "knowledge-start").length, 1);
      assert.ok(events.indexOf("full-settled") < events.indexOf("knowledge-start"), String(events));
      assert.ok(events.includes("light"), "a knowledge-only gate still admits the boot review");
    }
  });
}
