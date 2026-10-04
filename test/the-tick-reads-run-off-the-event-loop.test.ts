import test from "node:test";
import assert from "node:assert/strict";
import { Worker, MessageChannel } from "node:worker_threads";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startReadPlane, startReadPlaneTelemetry, freezeReadGeneration } from "../src/lib/read-plane.js";
import { createTickReadProducer, buildBoardReviewDaemonHooks, applyTickCreditUpdates, buildDaemonReadRefresher } from "../src/run-task.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { loadPlan } from "../src/lib/plan.js";
import { runDaemon } from "../src/lib/daemon.js";
import { defaultCreditStorePath, loadCreditStore } from "../src/lib/status.js";
import { runSweep, type OpenPrView } from "../src/lib/sweep.js";
import { runReadPlaneWorker, readPlaneWorkerInput } from "../src/lib/read-plane.worker.js";
import { boardOpenSnapshotPath } from "../src/lib/board-snapshot-cache.js";

function fixture() {
  const root = makeTempDir("read-plane");
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, `
- id: A
  title: a
  repo: r
  type: implement
  files: [src/a.ts]
  depends_on: []
  status: queued
- id: B
  title: b
  repo: r
  type: implement
  files: [src/b.ts]
  depends_on: []
  status: queued
`);
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  return { plan: loadPlan(planPath), options: { owner: "o", repo: "r",
    config: { root, claudeBin: process.execPath }, ledgerPath, checkoutRoot: root } };
}

function fixtureReader() {
  const { plan, options } = fixture();
  const calls: string[] = [];
  let listed: number[] = [1, 2];
  let changedFiles = ["src/b.ts"];
  const fileReads: string[] = [];
  const pull = (number: number, merged = false) => ({ number, html_url: `https://github.com/o/r/pull/${number}`,
    state: merged ? "closed" : "open", merged_at: merged ? new Date().toISOString() : null,
    title: `fix(read): implement ${number}`, body: merged ? "" : "Remudero-Task: A",
    head: { ref: `run-${number === 3 ? "B" : "A"}-${number}`, sha: `sha${number}` },
    created_at: new Date(Date.now() - 60_000).toISOString(), updated_at: new Date().toISOString(), draft: false });
  const io: Parameters<typeof createTickReadProducer>[1] = {
    fetch: (args) => {
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      calls.push(path);
      if (path.includes("/pulls?") && path.includes("state=open")) return listed.map((n) => pull(n));
      if (path.includes("/pulls?") && path.includes("state=closed")) return [pull(3, true)];
      if (path.includes("/issues?")) return [];
      if (path.includes("/check-runs")) return { check_runs: [{ id: 1, name: "advisory", status: "completed", conclusion: "failure" }] };
      if (path.endsWith("/status")) return { statuses: [{ context: "ci-gate", state: "success" }] };
      if (path.includes("/files")) return [{ filename: "src/a.ts" }];
      if (path.includes("/actions/runs")) return { workflow_runs: [] };
      if (path.includes("/compare/")) return { ahead_by: 2 };
      if (/\/pulls\/\d+$/.test(path)) return { ...pull(Number(path.split("/").at(-1))), mergeable_state: "clean" };
      throw new Error(`unexpected read ${args.join(" ")}`);
    },
    changedFilesFetch: async (number) => { fileReads.push(number); return changedFiles; },
    commitTrailerIndex: () => new Map(), evidenceRootFor: () => undefined,
    issues: { create: () => { throw new Error("write in read plane"); }, listOpen: () => [{
      number: 9, url: "https://github.com/o/r/issues/9", title: "resolved b", body: "**Task:** B",
    }] },
    viewsDeps: { requiredContexts: () => ["ci-gate"], readCiGateRequired: () => [], fetchCiFailureEvidence: () => [] },
  };
  return { plan, options, io, calls, setListed: (next: number[]) => { listed = next; },
    setFiles: (next: string[]) => { changedFiles = next; },
    fileReads: (number: string) => fileReads.filter((n) => n === number).length };
}

const workerUrl = new URL("../src/run-task.ts", import.meta.url);
const spawnReader = () => new Worker(`
  const { parentPort } = require('node:worker_threads');
  const { execFileSync } = require('node:child_process');
  parentPort.on('message', ({ generation, input }) => {
    if (input.crash) process.exit(1);
    execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 150)']);
    parentPort.postMessage({ generation, facts: { prs: input.prs } });
  });
`, { eval: true });

test("W1-T4075: the tick reads run off the main thread while a timer keeps firing", async () => {
  const plane = startReadPlane({ workerUrl, workerInput: {}, spawn: spawnReader,
    inline: (input: { prs: number[] }) => {
      execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 150)"]);
      return { prs: input.prs };
    }, log: () => {} });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const generation = await plane.read({ prs: [1, 2] });
    assert.equal(generation.source, "worker");
    assert.ok(ticks >= 5, `timer fired ${ticks} times`);
    assert.deepEqual(generation.facts.prs, [1, 2]);
    assert.throws(() => generation.facts.prs.push(3), TypeError);
  } finally { clearInterval(timer); await plane.stop(); }
});

test("W1-T4075: one generation serves sweep and board review and credit with one open-PR read", async () => {
  const fixture = fixtureReader();
  const produce = createTickReadProducer(fixture.options, fixture.io);
  const beganAt = Date.now();
  const facts = await produce({ plan: fixture.plan });
  const persisted = JSON.parse(readFileSync(boardOpenSnapshotPath(fixture.options.config.root, "o", "r"), "utf8"));
  assert.ok(Date.parse(persisted.savedAt) >= beganAt && Date.parse(persisted.savedAt) <= Date.now(),
    "the gateway's logical generation clock cannot leak into a durable wall-clock timestamp");
  assert.equal(fixture.calls.filter((path) => path.includes("/pulls?") && path.includes("state=open")).length, 1);
  assert.deepEqual(facts.openPrViews.map((pr) => pr.prNumber), [1, 2]);
  assert.deepEqual(facts.boardItems.map((pr) => pr.id).sort(), ["#1", "#2"]);
  assert.ok(facts.boardItems.every((pr) => pr.redCheckCount === 1), "all-rollup red checks survive");
  assert.equal(new Map(facts.projection).get("B")?.merged, true);
  assert.ok(facts.creditCandidates.some((candidate) => candidate.taskId === "B"));
  assert.equal(facts.escalationCandidates[0]?.derived.merged, true);
  assert.deepEqual([...facts.behindMainByPr.values()], [2, 2]);
  freezeReadGeneration(facts);
  assert.throws(() => { facts.openPrViews[0].priorStrikes++; }, TypeError);
  assert.throws(() => facts.behindMainByPr.clear(), TypeError);
  const workingViews = structuredClone(facts.openPrViews);
  workingViews[0].priorStrikes++;
  assert.equal(facts.openPrViews[0].priorStrikes, 0);
  const storePath = defaultCreditStorePath(fixture.options.ledgerPath);
  assert.equal(existsSync(storePath), false, "the producer cannot persist material merge credit");
  const conflicts: string[] = [];
  applyTickCreditUpdates(facts, fixture.options.ledgerPath, (step) => conflicts.push(step));
  assert.ok(loadCreditStore(storePath).B);
  applyTickCreditUpdates(facts, fixture.options.ledgerPath, (step) => conflicts.push(step));
  assert.deepEqual(conflicts, ["read_plane.credit_write_conflict"]);
  const beforeCheck = fixture.calls.length;
  let reconciled: unknown;
  const hooks = buildBoardReviewDaemonHooks({ config: fixture.options.config, checkItems: () => facts.boardItems,
    items: () => { throw new Error("duplicate board read"); },
    reconcile: ({ items }) => { reconciled = items; return { retiredProposalIds: ["P1"], retired: [] }; },
    build: ({ items }) => {
      assert.equal(items, facts.boardItems);
      return { generatedAt: "", fire: true, reason: "shared generation", oldestOpenAgeHours: 0,
        redCount: 0, unhandledEscalationCount: 0, itemsConsidered: items.length,
        itemsExcludedAsSelfProduced: 0, proposalIds: [] };
    },
  });
  await hooks.prefetchBoardReview();
  assert.deepEqual(hooks.checkBoardReview().retiredProposalIds, ["P1"]);
  assert.equal(reconciled, facts.boardItems);
  assert.equal((await hooks.runBoardReview()).itemsConsidered, facts.boardItems.length);
  assert.equal(fixture.calls.length, beforeCheck);
  fixture.setListed([2]);
  const next = await produce({ plan: fixture.plan, previousProjection: facts.projection });
  assert.deepEqual(next.openPrViews.map((pr) => pr.prNumber), [2]);
  assert.deepEqual(facts.openPrViews.map((pr) => pr.prNumber), [1, 2]);
  const restarted = createTickReadProducer(fixture.options, fixture.io);
  const filesBefore = fixture.fileReads("3");
  await restarted({ plan: fixture.plan });
  assert.ok(filesBefore > 0, "the terminal file list was actually read");
  assert.equal(fixture.fileReads("3"), filesBefore, "terminal changed files survive a worker restart");
  const statusPath = join(fixture.options.config.root, "state", "status.json");
  let published = 0;
  let invalidated = 0;
  const refresh = buildDaemonReadRefresher({
    read: async (request) => {
      assert.deepEqual(request.previousProjection, facts.projection);
      return freezeReadGeneration({ generation: 3, source: "worker" as const, facts: next });
    }, plan: () => fixture.plan, previous: () => new Map(facts.projection),
    invalidate: () => { invalidated++; }, publish: () => { published++; },
    ledgerPath: fixture.options.ledgerPath, statusPath, log: () => {},
  });
  const merged = await refresh();
  assert.equal(merged("B"), true);
  assert.equal(merged("A"), false);
  assert.equal(published, 1);
  assert.equal(invalidated, 1);
  assert.equal(JSON.parse(readFileSync(statusPath, "utf8")).tasks.B.merged, true);
});

test("W1-T4075: the default worker bootstrap hosts the read-only worker protocol", async () => {
  const entry = new URL("../src/lib/read-plane.worker.ts", import.meta.url).href;
  const source = `const { runReadPlaneWorker } = await import(${JSON.stringify(entry)});
    runReadPlaneWorker((input) => ({ prs: input.prs })); // .ts`;
  const plane = startReadPlane({ workerUrl: new URL(`data:text/javascript,${encodeURIComponent(source)}`),
    workerInput: {}, inline: (): { prs: number[] } => { throw new Error("unexpected fallback"); }, log: () => {} });
  try {
    const [first, second] = await Promise.all([plane.read({ prs: [1] }), plane.read({ prs: [2] })]);
    assert.equal(first.source, "worker");
    assert.equal(second.source, "worker");
    assert.equal(second.generation, first.generation + 1);
    assert.deepEqual(first.facts.prs, [1]);
    assert.deepEqual(second.facts.prs, [2]);
  } finally { await plane.stop(); }
});

test("W1-T4075: the worker port reports failed reads without terminating later generations", async () => {
  assert.equal(readPlaneWorkerInput(), undefined);
  assert.throws(() => runReadPlaneWorker(() => ({})), /requires a worker port/);
  const { port1, port2 } = new MessageChannel();
  runReadPlaneWorker((input: { fail: boolean }) => {
    if (input.fail) throw new Error("read unavailable");
    return { ready: true };
  }, port1);
  try {
    let reply = once(port2, "message");
    port2.postMessage({ generation: 1, input: { fail: true } });
    assert.deepEqual((await reply)[0], { generation: 1, error: "Error: read unavailable" });
    reply = once(port2, "message");
    port2.postMessage({ generation: 2, input: { fail: false } });
    assert.deepEqual((await reply)[0], { generation: 2, facts: { ready: true } });
  } finally { port1.close(); port2.close(); }
});

test("W1-T4075: warming a terminal file list cannot turn a plan filing into durable credit", async () => {
  const fixture = fixtureReader();
  fixture.setFiles(["plan/tasks.d/B.yaml"]);
  const facts = await createTickReadProducer(fixture.options, fixture.io)({ plan: fixture.plan });
  assert.ok(fixture.fileReads("3") > 0);
  assert.equal(new Map(facts.projection).get("B")?.merged, false);
  assert.equal(facts.creditCandidates.some((candidate) => candidate.taskId === "B"), false);
  assert.equal(facts.creditUpdates.some((update) => update.id === "B"), false);
});

test("W1-T4075: a crashed read-plane worker degrades to inline reads and disposes every PR", async () => {
  const rows: Array<Record<string, unknown> | undefined> = [];
  const plane = startReadPlane({ workerUrl, workerInput: {}, spawn: spawnReader,
    inline: (input: { prs: number[]; crash?: boolean }) => ({ prs: input.prs }),
    log: (_step, row) => rows.push(row) });
  try {
    const failed = await plane.read({ prs: [1, 2, 3], crash: true });
    const { options } = fixture();
    const prs: OpenPrView[] = failed.facts.prs.map((number) => ({ prNumber: number,
      prUrl: `https://github.com/o/r/pull/${number}`, taskId: "A", headSha: `sha${number}`,
      reviewState: "pending", checksState: "pending", unmetCriteria: [], priorStrikes: 0,
      lastActivityAt: new Date().toISOString(), autoMergeArmed: false }));
    const unexpected = () => { throw new Error("pending PR cannot spend an action"); };
    const summary = await runSweep(prs, { ledgerPath: options.ledgerPath, runId: "TEST",
      arm: unexpected, close: unexpected, dispatchFix: unexpected, escalate: unexpected,
      readActiveWorkerCount: () => 0 });
    assert.deepEqual(summary.actions.map((action) => action.prNumber), [1, 2, 3]);
    assert.equal(summary.noneCount, 0);
    assert.equal(failed.source, "inline");
    assert.match(String(rows[0]?.reason), /exited: 1/);
    const healed = await plane.read({ prs: [4] });
    assert.equal(healed.source, "worker");
    assert.equal(healed.generation, failed.generation + 1);
    assert.deepEqual(failed.facts.prs, [1, 2, 3]);
  } finally { await plane.stop(); }
});

test("W1-T4075: daemon alive reports the loop delay of a block shorter than the interval", async () => {
  const telemetry = startReadPlaneTelemetry();
  try {
    const { plan } = fixture();
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    let merged = false;
    await runDaemon(plan, {
      refreshMerged: () => { throw new Error("unexpected inline projection"); },
      refreshMergedAsync: async () => (id) => merged && id === "A",
      runOne: async (id) => {
        await delay(30);
        execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 100)"]);
        await delay(440);
        merged = true;
        return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" };
      },
      readLoopTelemetry: telemetry.sample, sweepLight: async () => {},
      sleep: async (ms) => { await delay(ms); },
      log: (step, extra) => rows.push({ step, extra }),
    }, { max: 1, headroomEnabled: false, pollIntervalMs: 400 });
    const alive = rows.find((row) => row.step === "daemon.alive")!.extra!;
    assert.ok(Number(alive.loop_delay_max_ms) >= 80);
    // The ~100ms block plus a child node's startup measured 126-197ms on a loaded 8-core host, so a
    // 200ms interval left no margin; 400ms keeps the block shorter than the interval it is
    // reported within (the property under test) without racing the host's spawn latency.
    assert.ok(Number(alive.loop_delay_max_ms) < 400);
    assert.ok(Number(alive.loop_delay_p99_ms) >= 80);
    assert.ok(Number(alive.sync_spawn_ms) >= 80);
    await delay(20);
    assert.equal(telemetry.sample().sync_spawn_ms, 0);
  } finally { telemetry.stop(); }
});

test("W1-T4075: an unavailable worker falls back with its reason and inline failure stays visible", async () => {
  const reasons: string[] = [];
  const plane = startReadPlane({ workerUrl, workerInput: {},
    spawn: () => { throw new Error("worker unavailable"); },
    inline: () => { throw new Error("inline unavailable"); },
    log: (_step, row) => reasons.push(String(row?.reason)) });
  await assert.rejects(plane.read({ prs: [1] }), /inline unavailable/);
  assert.deepEqual(reasons, ["Error: worker unavailable"]);
  await plane.stop();
  await assert.rejects(plane.read({ prs: [2] }), /read plane stopped/);
});
