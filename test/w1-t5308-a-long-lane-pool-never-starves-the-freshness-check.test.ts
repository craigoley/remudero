import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, type DaemonFreshness } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ciWaitFreshness, waitForCiGreen, type RunResult } from "../src/run-task.js";

const ADVANCE: Extract<DaemonFreshness, { stale: true }> = {
  stale: true,
  oldSha: "a".repeat(40),
  newSha: "b".repeat(40),
  installNeeded: true,
  changes: [{ sha: "b".repeat(40), files: ["src/lib/daemon.ts"] }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function result(id: string, handedOff = false): RunResult {
  return { taskId: id, runId: id, merged: !handedOff, verdict: handedOff ? "handed_off" : "merged", costUsd: 0.5 };
}

function harness(externalWait = false, lightPass = false, max?: number, backgroundSweep = false) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}lane-pool-freshness-`));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, ["A", "B", "C"].map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`,
  ).join(""));
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const started: string[] = [];
  const ready = deferred<void>();
  const finished: string[] = [];
  const gates = new Map(["A", "B"].map((id) => [id, deferred<void>()]));
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  const sweep = deferred<void>();
  let advance: DaemonFreshness = { stale: false };
  let visible: DaemonFreshness = { stale: false };
  let stop = false;
  let pause = false;
  let complete = false;
  const run = runDaemon(loadPlan(path), {
    refreshMerged: () => () => false,
    checkStop: () => stop ? "fixture cleanup" : undefined,
    checkPause: () => pause ? "operator pause" : undefined,
    checkFreshness: () => { visible = advance; return visible; },
    sleep: () => {
      if (stop) return Promise.resolve();
      const sleep = deferred<void>();
      sleeps.push(sleep);
      return sleep.promise;
    },
    ...(lightPass ? { sweepLight: async () => {} } : {}),
    ...(backgroundSweep ? { sweep: () => sweep.promise } : {}),
    runInstall: () => logs.push({ step: "install" }),
    log: (step, extra) => logs.push({ step, extra }),
    runOne: async (id) => {
      started.push(id);
      if (started.length === 2) ready.resolve();
      await gates.get(id)?.promise;
      if (externalWait) {
        const outcome = await waitForCiGreen("https://github.com/acme/remudero/pull/1", (step, extra) => logs.push({ step: `${id}:${step}`, extra }), 0, {
          requiredContexts: () => ["ci"],
          readJson: async (args) => {
            const request = args.join(" ");
            if (request.includes("/pulls/1")) return { number: 1, state: "open", head: { sha: "c".repeat(40) } };
            if (request.includes("/check-runs")) return { check_runs: [{ name: "ci", status: "in_progress" }] };
            if (request.includes("/status")) return { statuses: [] };
            throw new Error(`unexpected request: ${request}`);
          },
          // Models the refreshed origin refs; the production hook samples freshness only on entry.
          externalWaitFreshness: ciWaitFreshness(() => visible),
          sleep: async () => { throw new Error("the next external-wait boundary must yield before polling again"); },
        });
        assert.equal(outcome.state, "freshness_handoff");
      }
      finished.push(id);
      return result(id, externalWait);
    },
  }, { laneCount: 2, pollIntervalMs: 10, max });
  void run.then(() => { complete = true; });
  return {
    logs, started, finished, run, ready: ready.promise,
    advance: (value: DaemonFreshness = ADVANCE) => { advance = value; },
    pause: () => { pause = true; },
    release: (id: string) => gates.get(id)?.resolve(),
    releaseSweep: () => sweep.resolve(),
    tick: async () => { await flush(); sleeps.shift()?.resolve(); await flush(); await flush(); },
    cleanup: async () => {
      stop = true;
      advance = ADVANCE;
      visible = ADVANCE;
      sweep.resolve();
      for (const gate of gates.values()) gate.resolve();
      for (let i = 0; i < 20 && !complete; i++) {
        for (const sleep of sleeps.splice(0)) sleep.resolve();
        await flush();
      }
      await run;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("W1-T5308: a code advance seen while lanes are in flight is acted on without waiting for the pool", async () => {
  const h = harness(false, false, 2);
  try {
    await h.ready;
    assert.deepEqual(h.started, ["A", "B"]);
    h.advance();
    await h.tick();
    assert.deepEqual(h.finished, [], "the freshness read cannot depend on a lane settling");
    assert.ok(h.logs.some((row) => row.step === "daemon.freshness_decision" && row.extra?.action === "restart" && row.extra.busy === true));
    assert.equal(h.logs.some((row) => row.step === "install"), false, "install waits for the admitted pool");
    h.advance({ stale: false }); // the decision must survive a later non-stale read and --max
    h.release("B");
    await flush();
    assert.deepEqual(h.started, ["A", "B"], "a restart closes refill before the pool settles");
    h.release("A");
    const summary = await h.run;
    assert.equal(summary.stopReason, "stale");
    assert.equal(summary.costUsd, 1, "settled lanes are accounted before restart");
    assert.ok(h.logs.findIndex((row) => row.step === "dispatch.settled_set") < h.logs.findIndex((row) => row.step === "install"));
    assert.equal(h.logs.filter((row) => row.step === "daemon_selfrestart_for_freshness").length, 1);
  } finally { await h.cleanup(); }
});

test("W1-T5308: in-flight runs are asked to yield at their external-wait boundary and their lanes settle on their own", async () => {
  const h = harness(true, true);
  try {
    await h.ready;
    h.advance();
    await h.tick();
    assert.ok(h.logs.some((row) => row.step === "daemon.freshness_decision" && row.extra?.action === "restart"));
    assert.deepEqual(h.finished, [], "live workers remain live until they enter their external wait");
    h.release("B");
    await flush();
    assert.deepEqual(h.finished, ["B"], "B yields on its own while A keeps working");
    assert.deepEqual(h.started, ["A", "B"], "a handoff does not reopen admission");
    assert.equal(h.logs.some((row) => row.step === "daemon_selfrestart_for_freshness"), false);
    h.release("A");
    assert.equal((await h.run).stopReason, "stale");
    for (const id of ["A", "B"]) {
      const boundary = h.logs.findIndex((row) => row.step === `${id}:run.awaiting_external`);
      const yieldAt = h.logs.findIndex((row) => row.step === `${id}:run.freshness_handoff`);
      assert.ok(boundary >= 0 && yieldAt > boundary);
      assert.equal(h.logs[yieldAt]?.extra?.new_sha, ADVANCE.newSha);
    }
  } finally { await h.cleanup(); }
});

test("W1-T5308: a low-weight advance preserves refill while the daemon is busy", async () => {
  const h = harness(false, true, 3);
  try {
    await h.ready;
    h.advance({ ...ADVANCE, changes: [{ sha: ADVANCE.newSha, files: ["src/lib/inbox.ts"] }] });
    await h.tick();
    assert.ok(h.logs.some((row) => row.step === "daemon.freshness_decision" && row.extra?.action === "defer"));
    h.release("B");
    await flush();
    assert.deepEqual(h.started, ["A", "B", "C"]);
    h.release("A");
    assert.equal((await h.run).stopReason, "max_reached");
  } finally { await h.cleanup(); }
});

test("W1-T5308: an operator pause wins over an in-flight freshness restart", async () => {
  const h = harness(false, true, 2);
  try {
    await h.ready;
    h.pause();
    h.advance();
    await h.tick();
    assert.equal(h.logs.some((row) => row.step === "daemon.freshness_decision"), false);
    h.release("A");
    h.release("B");
    assert.equal((await h.run).stopReason, "max_reached");
  } finally { await h.cleanup(); }
});

for (const lightPass of [true, false]) test(`W1-T5308: dispatch polls freshness with a background sweep in flight (light pass: ${lightPass})`, async () => {
  const h = harness(false, lightPass, undefined, true);
  try {
    await h.ready;
    assert.deepEqual(h.started, ["A", "B"]);
    h.advance();
    await h.tick();
    assert.ok(h.logs.some((row) => row.step === "daemon.freshness_decision" && row.extra?.action === "restart"));
    h.release("A");
    h.release("B");
    await flush();
    assert.equal(h.logs.some((row) => row.step === "daemon_selfrestart_for_freshness"), false, "the existing drain still waits for the full pass");
    h.releaseSweep();
    assert.equal((await h.run).stopReason, "stale");
  } finally { await h.cleanup(); }
});

test("W1-T5308: a fresh in-flight ticker keeps admitting ordinary lane refills", async () => {
  const h = harness(false, true, 3);
  try {
    await h.ready;
    await h.tick();
    assert.equal(h.logs.some((row) => row.step === "daemon.freshness_decision"), false);
    h.release("B");
    await flush();
    assert.deepEqual(h.started, ["A", "B", "C"]);
    h.release("A");
    assert.equal((await h.run).stopReason, "max_reached");
  } finally { await h.cleanup(); }
});
