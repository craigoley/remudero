import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { fixedClock } from "#src/lib/clock.js";
import { ciFrictionGardenSpec } from "#src/lib/ci-friction-gardener.js";
import { FLOW_LADDER, flowGardenSpec, ladderGardenSpec } from "#src/lib/flow-remedy-gardener.js";
import { runFlowGardener } from "#src/lib/flow-gardener.js";
import { gateGardenSpec, loadGateProbes } from "#src/lib/gate-gardener.js";
import {
  GardenMintBudget, GardenMintTimedOutError, prepareGardenTaskIds, runGarden, runGardenAsync,
  type GardenCheckout, type GardenerDeps, type GardenSpec, type GardenTaskIdMinter,
} from "#src/lib/gardener.js";
import { fileConsumerVia } from "#src/lib/host-resource-gardener.js";
import { hotFileGardenSpec } from "#src/lib/hot-file-gardener.js";
import { scoutGardenSpec } from "#src/lib/scout-gardener.js";
import { LoopBoundedChildTimeout } from "#src/lib/loop-bounded-child.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ciLearningTaskIdMinter } from "#src/run-task.js";

const NOW = Date.now();
const HOUR = 3_600_000;
const PR = "https://github.com/acme/remudero/pull/99";
const action = { class: "file" as const, target: "fixture", reason: "file the remedy" };
type Spec = GardenSpec<"file", number, typeof action, GardenCheckout>;

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-mint-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  const landings: Array<{ paths: string[] }> = [];
  let disposed = 0;
  const ws: GardenCheckout = { root, branch: "scout-garden-fixture", land: (landing) => { landings.push(landing); return PR; }, dispose: () => { disposed++; } };
  const deps: GardenerDeps = {
    repoRoot: root, stateDir: join(root, "state"), clock: fixedClock(NOW), seed: 1,
    openWorkspace: () => ws, mergedPlanLint: () => undefined,
    log: (step, fields) => { rows.push({ step, fields }); },
  };
  const put = (path: string, text = "// fixture\n") => {
    mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text);
  };
  put("src/lib/owner.ts"); put("test/fixture.test.ts"); put("deploy/rmd-host-cleanup.sh"); put("src/lib/sweep.ts");
  return { root, ws, deps, rows, landings, put, disposed: () => disposed };
}

function spec(mint: GardenTaskIdMinter): Spec {
  return {
    name: "mint-fixture", classes: ["file"], cheapFingerprint: () => "cheap", inventory: () => 1,
    fingerprint: () => "full", metric: () => ({ trials: 0, successes: 0 }), candidates: () => [action], scorecard: () => ({}),
    prepare: (ws, plan, async) => prepareGardenTaskIds(ws, plan.actions.length, mint, async),
    apply: (ws, _plan, _card, ids) => {
      assert.deepEqual(ids, ["W1-T9001"]);
      writeFileSync(join(ws.root, "change.txt"), ids![0]!);
      return { paths: ["change.txt"], title: "chore(plan): file fixture", body: "fixture" };
    },
  };
}

function asyncOnly(ids: string[]) {
  const branches: string[] = [];
  const mint = Object.assign(() => { throw new Error("sync minter reached the daemon loop"); }, {
    async: async (branch: string) => { branches.push(branch); await new Promise((r) => setTimeout(r, 5)); return ids.shift()!; },
  });
  return { mint, branches };
}

function flowRegressionRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 10; i++) {
    const merged = NOW - (i < 6 ? (2 + i % 5) * 24 * HOUR : (i - 5) * HOUR);
    const ready = (i < 6 ? 10 : 30) * 60_000;
    const task_id = `W1-T${8000 + i}`, pr_url = `https://github.com/acme/remudero/pull/${8000 + i}`;
    rows.push({ step: "pr.opened", task_id, run_id: `${task_id}-1`, pr_url, ts: new Date(merged - 45 * 60_000).toISOString(), plan_only: true, head_sha: `head${i}` },
      { step: "review.posted", task_id, pr_url, state: "success", ts: new Date(merged - ready).toISOString(), head_sha: `head${i}` },
      { step: "pr.terminal", pr_url, state: "merged", merged_at: new Date(merged).toISOString(), ts: new Date(merged + 1000).toISOString() });
  }
  return rows;
}

test("W1-T7742: a runGardenAsync pass reserves its task id through the async minter and never the sync one", async (t) => {
  const f = fixture(t);
  const { mint, branches } = asyncOnly(["W1-T9001"]);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    assert.equal((await runGardenAsync(spec(mint), f.deps)).prUrl, PR);
    assert.ok(ticks > 0);
    assert.deepEqual(branches, [f.ws.branch]);
    assert.equal(f.disposed(), 1);
    assert.equal(readFileSync(join(f.root, "change.txt"), "utf8"), "W1-T9001");
  } finally { clearInterval(timer); }
  const sync = fixture(t);
  let called = 0;
  assert.equal(runGarden(spec(() => { called++; return "W1-T9001"; }), sync.deps).prUrl, PR);
  assert.equal(called, 1, "the CLI still prepares synchronously");
});

test("W1-T7742: every minting gardener files with the async-minted id while the sync minter throws", async (t) => {
  const f = fixture(t);
  const ids = Array.from({ length: 8 }, (_, i) => `W1-T${9001 + i}`);
  const expected = [...ids];
  const { mint, branches } = asyncOnly(ids);
  const search = { filesContaining: () => [{ file: "src/lib/owner.ts", hits: 1 }], fileExists: () => true };
  const ci = ciFrictionGardenSpec(f.deps, {
    ledgerRecords: () => [], planState: () => ({ tasks: [] }), ownerSearch: search, mintTaskId: mint,
    gateFireRates: () => ({ status: "measured", prsScanned: 19, gates: [{ gate: "reviewer-unmet", prs: 19, runs: 26, redRuns: 26, refusals: 26, repaired: 26, overridden: 0, minutes: 465, redMinutes: 465, redPrs: 19 }], neverFired: [], alwaysFired: [] }),
  });
  const ciActions = ci.candidates(ci.inventory(), () => 0);
  assert.equal(ciActions.length, 1);
  const ciPlan = { actions: ciActions, acting: [ciActions[0]!.class] };
  const ciHeld = await ci.prepare!(f.ws, ciPlan, true);
  const ciLanding = ci.apply(f.ws, ciPlan, {}, ciHeld)!;
  assert.match(readFileSync(join(f.root, ciLanding.paths[0]!), "utf8"), /W1-T9001/);
  assert.deepEqual(await ci.prepare!(f.ws, { actions: [{ ...ciActions[0]!, decision: { kind: "escalate", why: "no remedy" } }], acting: ciPlan.acting }, true), []);

  f.put("scripts/source-size-baseline.json", "{}\n");
  const hot = hotFileGardenSpec(f.deps, { ledgerRecords: () => [], mainHistory: () => [], planOrigins: () => [], mintTaskId: mint });
  const hotAction = { class: "split-per-entry" as const, target: "scripts/source-size-baseline.json", reason: "conflicts", origin: "hot-file:scripts/source-size-baseline.json", price: { file: "scripts/source-size-baseline.json", minutes: 30, recordedMinutes: 30, inferredMinutes: 0, rounds: 2, prs: 2 } };
  const hotPlan = { actions: [hotAction], acting: [hotAction.class] };
  const hotHeld = await hot.prepare!(f.ws, hotPlan, true);
  assert.match(readFileSync(join(f.root, hot.apply(f.ws, hotPlan, {}, hotHeld)!.paths[0]!), "utf8"), /W1-T9002/);

  const ladder = flowGardenSpec(f.deps, { owner: "acme", repo: "remudero", mintTaskId: mint, ownerSearch: search, ledgerRecords: () => [], planState: () => ({ tasks: [] }), prOutcomes: () => new Map() });
  const ladderAction = { class: "draft" as const, target: "escalated:fixture", reason: "recurring", origin: "flow-blocker:escalated:fixture", rung: 1, price: { key: "escalated:fixture", hours: 2, prs: 2, owners: ["NONE"] }, charges: [], population: [2] };
  const ladderPlan = { actions: [ladderAction], acting: [ladderAction.class] };
  const ladderHeld = await ladder.prepare!(f.ws, ladderPlan, true);
  assert.match(readFileSync(join(f.root, ladder.apply(f.ws, ladderPlan, {}, ladderHeld)!.paths[0]!), "utf8"), /W1-T9003/);
  assert.deepEqual(await ladder.prepare!(f.ws, { actions: [{ ...ladderAction, escalation: "needs a person" }], acting: ["draft"] }, true), []);

  const gate = gateGardenSpec(f.deps, await loadGateProbes(process.cwd()), { mintTaskId: mint, admissionViolations: () => [] });
  const gateAction = { class: "defuse" as const, target: "expiring-fixture:test/fixture.test.ts", reason: "expires soon", file: "test/fixture.test.ts", edit: { kind: "defuse" as const, leadDays: 21, urgent: true, finding: { file: "test/fixture.test.ts", line: 1, stamp: new Date(NOW).toISOString(), field: "ts", threshold: "30 days", expiresAt: NOW + HOUR, daysLeft: 1 } } };
  const gatePlan = { actions: [gateAction], acting: [gateAction.class] };
  const gateHeld = await gate.prepare!(f.ws, gatePlan, true);
  assert.match(readFileSync(join(f.root, gate.apply(f.ws, gatePlan, {}, gateHeld)!.paths[0]!), "utf8"), /W1-T9004/);
  assert.deepEqual(await gate.prepare!(f.ws, { actions: [{ class: "refresh", target: "fixture", reason: "refresh", file: "fixture", edit: { kind: "row", key: "fixture", to: 0 } }], acting: ["refresh"] }, true), []);

  const scout = scoutGardenSpec(f.deps, { mintTaskId: mint });
  const scoutPlan = { actions: ["widget.failed", "widget.unhealthy"].map(step => ({ class: "file-uncovered-symptom" as const, target: step, reason: "recurs", origin: `scout:${step}`, symptom: { step, older: 2, newer: 3, total: 5, files: ["src/lib/owner.ts"] } })), acting: ["file-uncovered-symptom" as const] };
  const scoutHeld = await scout.prepare!(f.ws, scoutPlan, true);
  assert.deepEqual(scoutHeld, ["W1-T9005", "W1-T9006"]);
  assert.equal(scout.apply(f.ws, scoutPlan, {}, scoutHeld)!.paths.length, 2);

  await fileConsumerVia(async () => ({ ...f.ws, land: async (landing) => f.ws.land(landing), dispose: async () => f.ws.dispose() }), mint, f.deps.log)({ host: "azure", device: "root", consumer: "worktrees", origin: "host-resource:azure:worktrees", attribution: { consumer: "worktrees", growthKbPerHour: 800000, share: 0.8, spanHours: 72, points: 144, janitorPasses: 12 } });
  assert.match(readFileSync(join(f.root, f.landings.at(-1)!.paths[0]!), "utf8"), /W1-T9007/);

  const flow = await runFlowGardener(f.deps, { mintTaskId: mint, readLedger: () => ({ ok: true, rows: flowRegressionRows(), unread: [] }), readCi: async () => undefined, planTasks: () => [] });
  assert.equal(flow.filed.length, 1);
  assert.match(readFileSync(join(f.root, f.landings.at(-1)!.paths[0]!), "utf8"), /W1-T9008/);
  assert.equal(branches.length, expected.length);
  assert.ok(branches.every(branch => branch === f.ws.branch));
});

test("W1-T7742: an admission shadow proposal reserves no task id before apply", async (t) => {
  const f = fixture(t);
  mkdirSync(f.deps.stateDir, { recursive: true });
  let syncMints = 0, asyncMints = 0;
  const mint = Object.assign(() => { syncMints++; throw new Error("shadow proposal must not reserve"); }, {
    async: async () => { asyncMints++; throw new Error("shadow proposal must not reserve"); },
  });
  const cause = `admission-${"a".repeat(64)}`;
  const proposal = { class: "draft" as const, target: cause, reason: "shadow proposal", origin: `admission-flow:${cause}`,
    rung: 1, price: { key: cause, hours: 2, prs: 2, owners: ["admission-shadow"] },
    charges: [], population: [1, 2], admissionShadow: true };
  const shadow = ladderGardenSpec(f.deps, { kind: FLOW_LADDER, sources: { mintTaskId: mint },
    inventory: () => ({ next: proposal, charges: [], episodes: [], priced: [proposal.price], candidates: [proposal.price], ladder: [] }) });
  const plan = { actions: [proposal], acting: ["draft" as const] };
  assert.deepEqual(await shadow.prepare!(f.ws, plan, true), []);
  assert.deepEqual(shadow.prepare!(f.ws, plan, false), []);
  const result = await runGardenAsync(shadow, f.deps);
  assert.equal(result.ran, true);
  assert.equal(result.prUrl, undefined);
  assert.equal(syncMints, 0);
  assert.equal(asyncMints, 0);
  assert.equal(f.landings.length, 0);
  assert.equal(f.disposed(), 1);
  assert.equal(existsSync(join(f.root, "plan", "tasks.d")), false);
  const intent = JSON.parse(readFileSync(join(f.deps.stateDir, "admission-flow-shadow-intents", `${cause}-remedy.json`), "utf8"));
  assert.equal(intent.permission, "not-granted");
  assert.equal(intent.effect, "remedy");
  assert.equal(f.rows.filter(row => row.step === "admission_flow.proposal_shadow").length, 1);
});

test("W1-T7742: a mint past its bound is abandoned and writes a mint_timed_out row naming the elapsed time and the bound", { timeout: 1000 }, async (t) => {
  const f = fixture(t);
  let now = 0;
  const mint = ciLearningTaskIdMinter(f.root, undefined, async (_file, _args, options) => {
    now = 25;
    throw new LoopBoundedChildTimeout("node reservation", options.timeout, { signal: "SIGKILL" });
  }, { budget: new GardenMintBudget(() => 25), clock: { now: () => now } });
  const s = spec(mint);
  await runGardenAsync(s, f.deps);
  assert.equal(existsSync(join(f.root, "change.txt")), false);
  assert.equal(f.landings.length, 0);
  assert.equal(f.disposed(), 1);
  const event = f.rows.find(row => row.step === "garden.mint_timed_out")!;
  assert.equal(event.fields?.spec, s.name);
  assert.equal(event.fields?.bound_ms, 25);
  assert.ok(Number(event.fields?.elapsed_ms) >= 25);
  assert.equal(existsSync(join(f.deps.stateDir, `${s.name}-gardener.json`)), false, "no completed fingerprint or retry backoff is recorded");
  const retry = asyncOnly(["W1-T9001"]);
  assert.equal((await runGardenAsync(spec(retry.mint), f.deps)).prUrl, PR, "the next pass retries the same inputs");
});

test("W1-T7742: a flow mint timeout retries on the next pass with the same inputs", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  const mint = Object.assign(() => assert.fail("sync mint reached the flow pass"), {
    async: async () => {
      if (++attempts === 1) throw new GardenMintTimedOutError(25, 25);
      return "W1-T9001";
    },
  });
  const sources = { mintTaskId: mint, readLedger: () => ({ ok: true as const, rows: flowRegressionRows(), unread: [] }), readCi: async () => undefined, planTasks: () => [] };
  const first = await runFlowGardener(f.deps, sources);
  assert.deepEqual(first.filed, []);
  assert.equal(f.landings.length, 0);
  assert.equal(existsSync(join(f.root, "plan", "tasks.d")), false);
  assert.deepEqual(f.rows.find(row => row.step === "garden.mint_timed_out")?.fields,
    { spec: "flow", elapsed_ms: 25, bound_ms: 25 });
  assert.equal(f.disposed(), 1);
  const retry = await runFlowGardener(f.deps, sources);
  assert.equal(attempts, 2);
  assert.equal(retry.filed.length, 1);
  assert.equal(f.landings.length, 1);
  assert.equal(f.disposed(), 2);
  assert.match(readFileSync(join(f.root, f.landings[0]!.paths[0]!), "utf8"), /W1-T9001/);
});

test("W1-T7742: the mint bound scales with observed mint durations and starts from the poll interval", async () => {
  let poll = 120;
  const budget = new GardenMintBudget(() => poll);
  assert.equal(budget.boundMs(), 120);
  poll = 240; assert.equal(budget.boundMs(), 240);
  budget.observe(10); assert.equal(budget.boundMs(), 30);
  budget.observe(50); assert.equal(budget.boundMs(), 150);
  for (let i = 0; i < 32; i++) budget.observe(5);
  assert.equal(budget.boundMs(), 15, "older durations age out");
  let clock = 0;
  const observed: number[] = [];
  const adaptive = new GardenMintBudget(() => 200);
  const mint = ciLearningTaskIdMinter("/fixture", undefined, async (_file, _args, opts) => {
    observed.push(opts.timeout); clock += 20;
    return { stdout: JSON.stringify({ id: "W1-T9001", rows: [] }) };
  }, { budget: adaptive, clock: { now: () => clock } });
  await mint.async("fixture"); await mint.async("fixture");
  assert.deepEqual(observed, [200, 60], "real minter options consume the learned bound");
});

test("W1-T9703: a late successful mint is filed", async (t) => {
  for (const elapsed of [25, 26]) {
    const f = fixture(t);
    const budget = new GardenMintBudget(() => 25);
    let now = 0;
    const mint = ciLearningTaskIdMinter(f.root, undefined, async () => {
      now = elapsed;
      return { stdout: JSON.stringify({ id: "W1-T9001", sha: "a".repeat(40), rows: [] }) };
    }, { budget, clock: { now: () => now } });
    const s = spec(mint);
    const result = await runGardenAsync(s, f.deps);
    assert.equal(result.prUrl, PR, "a finished mint is filed however late a held loop observed it");
    assert.equal(readFileSync(join(f.root, "change.txt"), "utf8"), "W1-T9001");
    assert.equal(f.landings.length, 1);
    assert.equal(f.rows.some(row => row.step === "garden.mint_timed_out"), false);
    assert.equal(mint.heldSha("W1-T9001"), "a".repeat(40), "the reservation is held for a refused filing to release");
    assert.equal(budget.boundMs(), 3 * elapsed, "a late success is observed, not discarded");
  }
});

test("W1-T7742: the initial mint deadline reads injected policy unless the daemon supplies its cadence", async (t) => {
  const f = fixture(t);
  const bounds: number[] = [];
  let pollIntervalMs = 1200;
  const execute = async (_file: string, _args: string[], opts: { timeout: number }) => {
    bounds.push(opts.timeout);
    return { stdout: JSON.stringify({ id: "W1-T9001", rows: [] }) };
  };
  const mint = ciLearningTaskIdMinter(f.root, undefined, execute, {
    clock: fixedClock(0), loadPolicy: () => ({ values: { pollIntervalMs } }),
  });
  await mint.async(f.ws.branch!);
  pollIntervalMs = 2400;
  await mint.async(f.ws.branch!);
  const override = fixture(t);
  const daemonMint = ciLearningTaskIdMinter(override.root, undefined, execute, {
    clock: fixedClock(0), pollIntervalMs: () => 1800,
    loadPolicy: () => assert.fail("an explicit daemon cadence must bypass policy reads"),
  });
  await daemonMint.async(override.ws.branch!);
  assert.deepEqual(bounds, [1200, 2400, 1800]);
});

test("W1-T7742: an expired reservation child is killed while the loop stays responsive", async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "started");
  const preload = join(f.root, "hold-reservation-child.mjs");
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    setInterval(() => {}, 1000);
    await new Promise(() => {});`);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ?? ""} --import=${pathToFileURL(preload).href}`;
  const budget = new GardenMintBudget(() => 500);
  const mint = ciLearningTaskIdMinter(f.root, undefined, undefined, { budget });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    await assert.rejects(mint.async("fixture"), GardenMintTimedOutError);
    assert.ok(ticks > 0);
    assert.ok(existsSync(marker), "the child really started");
    const pid = Number(readFileSync(marker, "utf8"));
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("the expired child survived cancellation");
  } finally {
    clearInterval(timer);
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});

test("W1-T7742: transport and child timeout reports stay distinct from other mint failures", async () => {
  for (const failure of [{ code: "ETIMEDOUT" }, { killed: true }]) {
    const mint = ciLearningTaskIdMinter("/fixture", undefined, async () => { throw failure; }, { budget: new GardenMintBudget(() => 200) });
    await assert.rejects(mint.async("fixture"), GardenMintTimedOutError);
  }
  const childTimeout = ciLearningTaskIdMinter("/fixture", undefined, async () => ({ stdout: JSON.stringify({ error: "expired", timedOut: true, rows: [] }) }), { budget: new GardenMintBudget(() => 200) });
  await assert.rejects(childTimeout.async("fixture"), GardenMintTimedOutError);
  const refused = new Error("origin refused the claim");
  const mint = ciLearningTaskIdMinter("/fixture", undefined, async () => { throw refused; }, { budget: new GardenMintBudget(() => 200) });
  await assert.rejects(mint.async("fixture"), error => error === refused);
});

test("W1-T7742: the CLI minter bounds its synchronous reservation spawns", (t) => {
  const f = fixture(t);
  f.put("plan/tasks.yaml", "[]\n");
  const bounds: number[] = [];
  t.mock.method(childProcess, "spawnSync", (_file: string, _args: string[], options: { timeout: number; killSignal: string }) => {
    bounds.push(options.timeout);
    assert.equal(options.killSignal, "SIGKILL");
    return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("expired"), { code: "ETIMEDOUT" }) };
  });
  t.mock.method(childProcess, "execFileSync", () => { throw new Error("external commands are disabled in this fixture"); });
  syncBuiltinESMExports();
  try {
    const mint = ciLearningTaskIdMinter(f.root, undefined, undefined, { budget: new GardenMintBudget(() => 250), clock: fixedClock(0) });
    assert.throws(() => mint("fixture"), GardenMintTimedOutError);
    assert.ok(bounds.length > 0);
    assert.ok(bounds.every(bound => bound === 250));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("W1-T7742: partial scout preparation writes no shards and releases the workspace", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  const mint = Object.assign(() => assert.fail("sync mint"), { async: async () => { if (++attempts === 2) throw new GardenMintTimedOutError(50, 50); return "W1-T9010"; } });
  const s = spec(mint);
  s.prepare = (ws, _plan, async) => prepareGardenTaskIds(ws, 2, mint, async);
  await runGardenAsync(s, f.deps);
  assert.equal(attempts, 2);
  assert.equal(existsSync(join(f.root, "change.txt")), false);
  assert.equal(f.disposed(), 1);
  assert.equal(f.landings.length, 0);
  assert.deepEqual(await prepareGardenTaskIds({ branch: undefined }, 0, mint, true), []);
  assert.throws(() => prepareGardenTaskIds({}, 1, mint), /no branch/);
});

test("W1-T7742: a refused defuse batch reserves no task ids", async (t) => {
  const f = fixture(t);
  const { mint, branches } = asyncOnly(["W1-T9001", "W1-T9002"]);
  const actions = ["test/fixture.test.ts", "test/other.test.ts"].map(file => ({
    class: "defuse" as const, target: `expiring-fixture:${file}`, reason: "expires soon", file,
    edit: { kind: "defuse" as const, leadDays: 21, urgent: true, finding: {
      file, line: 1, stamp: new Date(NOW).toISOString(), field: "ts", threshold: "30 days",
      expiresAt: NOW + HOUR, daysLeft: 1,
    } },
  }));
  const gate = gateGardenSpec(f.deps, await loadGateProbes(process.cwd()), {
    mintTaskId: mint, admissionViolations: task => task.files?.includes("test/other.test.ts") ? ["fixture refused"] : [],
  });
  gate.classes = ["defuse"];
  gate.cheapFingerprint = () => "cheap";
  gate.inventory = () => ({ candidates: actions, tally: { trials: 0, successes: 0 } });
  gate.inventoryAsync = async () => gate.inventory();
  gate.fingerprint = () => "full";
  gate.candidates = () => actions;
  gate.scorecard = () => ({});
  await runGardenAsync(gate, f.deps);
  assert.deepEqual(branches, [], "admission must finish before the first reservation");
  assert.equal(existsSync(join(f.root, "plan", "tasks.d")), false);
  assert.equal(f.landings.length, 0);
  assert.equal(f.disposed(), 1);
  assert.match(String(f.rows.find(row => row.step === "gate.garden_filing_failed")?.fields?.reason), /fixture refused/);
});
