/**
 * W1-T9065 — THE FLEET LANE'S `rmd approve` RUNS IN AN ORIGIN/MAIN TREE, AND A REFUSED SELF-SYNC IS A LEDGER ROW.
 *
 * The daemon's checkout is detached and behind origin/main, so every lane approve spawned there died at
 * the CLI's self-sync guard ("refusing to auto-sync ... DETACHED HEAD") with no ledger row, while the lane
 * counted it as filed. The fixtures below build exactly that: a bare origin, a daemon checkout detached at
 * an older sha, and origin/main moved ahead with a plan task only main has. The gateway's spawn is
 * recorded, and the REAL `checkCliFreshness` is run in the recorded cwd with the recorded env.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { checkCliFreshness, type SelfSyncResult } from "../src/lib/self-sync.js";
import { loadPlan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fleetLaneStorePath, readFleetLaneStore, triageFleetLane, triageFleetLaneAsync, writeClassificationSnapshot, type DecisionStore, type FleetLaneDeps } from "../src/lib/fleet-lane.js";
import { ratifyCliGateway } from "../src/lib/panel-graph.js";
import { fleetRatifyGateway, freshOriginMainTreeRunner, main, selfSyncRefusalSink } from "../src/run-task.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY, type GitRepo } from "./helpers/git-repo.js";

function scratch(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w9065-${kind}-`));
}

function identify(repo: GitRepo): void {
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
}

const PLAN = (ids: string[]) =>
  ids.map((id) => `- id: ${id}\n  title: "task ${id}"\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n`).join("");

/** A bare origin, a daemon checkout detached at the first commit, and origin/main one commit ahead
 *  whose plan alone holds W1-T2 — the shape deploy/entrypoint.sh leaves the daemon in after a merge. */
function outageFixture(): { daemon: GitRepo; baseSha: string; mainSha: string } {
  const origin = gitRepo({ bare: true, kind: "w9065-origin" });
  const author = gitRepo({ kind: "w9065-author" });
  identify(author);
  mkdirSync(join(author.dir, "bin"));
  mkdirSync(join(author.dir, "plan"));
  writeFileSync(join(author.dir, "bin", "rmd"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(author.dir, "bin", "rmd"), 0o755);
  writeFileSync(join(author.dir, ".gitignore"), "node_modules\n");
  writeFileSync(join(author.dir, "plan", "tasks.yaml"), PLAN(["W1-T1"]));
  author.git("add", "-A");
  author.git("commit", "-q", "-m", "base");
  author.addRemote("origin", origin.dir);
  author.git("push", "-q", "origin", "main");
  const baseSha = author.git("rev-parse", "HEAD");
  const daemon = gitRepo({ cloneFrom: origin.dir, kind: "w9065-daemon" });
  identify(daemon);
  daemon.git("checkout", "-q", "--detach");
  writeFileSync(join(author.dir, "plan", "tasks.yaml"), PLAN(["W1-T1", "W1-T2"]));
  author.git("commit", "-q", "-am", "main moves: W1-T2 filed");
  author.git("push", "-q", "origin", "main");
  return { daemon, baseSha, mainSha: author.git("rev-parse", "HEAD") };
}

type Spawned = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; child: EventEmitter & { pid?: number; unref(): void } };

/** A spawn that records what the gateway would have run, and a child the test exits by hand. */
function recordingSpawn(pid: number | undefined) {
  const calls: Spawned[] = [];
  let notify: (s: Spawned) => void = () => {};
  const spawned = new Promise<Spawned>((resolve) => { notify = resolve; });
  const spawn = ((command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
    const child = Object.assign(new EventEmitter(), { pid, unref: () => {} });
    const call = { command, args, cwd: options.cwd, env: options.env, child };
    calls.push(call);
    notify(call);
    return child;
  }) as never;
  return { calls, spawned, spawn };
}

/** The real freshness check, minus the CI markers a hosted runner sets (they would answer "guarded"). */
function realFreshness(dir: string, env: NodeJS.ProcessEnv): SelfSyncResult {
  const { CI: _ci, GITHUB_ACTIONS: _gha, ...local } = env;
  return checkCliFreshness(dir, local, { warn: () => {}, say: () => {}, reexec: () => assert.fail("must never re-exec") });
}

function withoutGuard(t: TestContext): void {
  const prior = process.env.RMD_SELF_SYNC_DONE;
  delete process.env.RMD_SELF_SYNC_DONE;
  t.after(() => {
    if (prior !== undefined) process.env.RMD_SELF_SYNC_DONE = prior;
  });
}

function readRows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function laneApproveInFixture(t: TestContext) {
  withoutGuard(t);
  const fx = outageFixture();
  const state = scratch("state");
  const ledgerPath = join(state, "ledger.ndjson");
  const rec = recordingSpawn(4242);
  const gateway = fleetRatifyGateway(fx.daemon.dir, join(state, "logs"), ledgerPath, { worktreeRoot: join(scratch("trees"), "worktrees"), spawn: rec.spawn });
  const done = gateway.approve("P-ready");
  const call = await rec.spawned;
  return { fx, ledgerPath, gateway, done, call };
}

test("W1-T9065: a lane approve from a detached behind checkout runs at origin/main", { timeout: 60_000 }, async (t) => {
  const { fx, ledgerPath, gateway, done, call } = await laneApproveInFixture(t);
  // POSITIVE CONTROL: the daemon's own checkout reproduces the outage — the real check refuses there.
  const inDaemon = realFreshness(fx.daemon.dir, {});
  assert.equal(inDaemon.status, "refused");
  assert.equal(inDaemon.status === "refused" && inDaemon.reason, "off-main");

  assert.deepEqual(call.args, ["approve", "P-ready"]);
  assert.equal(call.env.RMD_SELF_SYNC_DONE, "1");
  assert.notEqual(call.cwd, fx.daemon.dir);
  assert.equal(execFileSync("git", ["-C", call.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), fx.mainSha, "the child's tree is AT origin/main");
  // The real check, in the recorded cwd with the recorded env, does not refuse...
  assert.notEqual(realFreshness(call.cwd, call.env).status, "refused");
  // ...and the skip is safe, not a bypass: without the guard the same tree is not behind at all.
  const { RMD_SELF_SYNC_DONE: _guard, ...unguarded } = call.env;
  assert.ok(["up-to-date", "worktree"].includes(realFreshness(call.cwd, unguarded).status));
  assert.equal(gateway.inFlight("P-ready"), true, "the hand-off holds its tree while the child runs");

  call.child.emit("exit", 0, null);
  await done;
  assert.equal(gateway.inFlight("P-ready"), false);
  const rows = readRows(ledgerPath).filter((r) => r.task_id === "P-ready");
  assert.deepEqual(rows.map((r) => r.step), ["ratify.cli_started", "ratify.cli_exited"]);
  assert.equal(rows[0]!.pid, 4242);
  assert.equal(rows[1]!.code, 0);
  assert.equal(rows[1]!.sha, fx.mainSha);
});

test("W1-T9065: the approve child reads the origin/main plan", { timeout: 60_000 }, async (t) => {
  const { fx, done, call } = await laneApproveInFixture(t);
  // approveCommand classifies with loadPlan(join(repoRoot, "plan", "tasks.yaml")), repoRoot being the
  // tree its bin/rmd lives in — so the child's plan is the one in the recorded cwd.
  assert.equal(call.command, join(call.cwd, "bin", "rmd"));
  assert.equal(loadPlan(join(fx.daemon.dir, "plan", "tasks.yaml")).byId.has("W1-T2"), false, "control: the stale checkout lacks it");
  assert.equal(loadPlan(join(call.cwd, "plan", "tasks.yaml")).byId.has("W1-T2"), true);
  assert.notEqual(fx.baseSha, fx.mainSha);
  call.child.emit("exit", 1, null);
  await done;
});

class ProcessExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

test("W1-T9065: a refused self-sync writes a self_sync.refused row", async (t) => {
  withoutGuard(t);
  const fx = outageFixture();
  const home = scratch("home");
  const root = join(home, "Remudero-root");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = priorHome; });
  t.mock.method(process, "exit", ((code?: number): never => { throw new ProcessExitCalled(code); }) as typeof process.exit);
  t.mock.method(console, "error", () => {});
  const argv = process.argv;
  process.argv = ["node", "run-task.js", "approve", "P-refused"];
  t.after(() => { process.argv = argv; });

  let caught: unknown;
  await main({ checkFreshness: (_root, env, deps) => checkCliFreshness(fx.daemon.dir, { ...env, CI: "", GITHUB_ACTIONS: "" }, deps) })
    .catch((e) => { caught = e; });
  assert.ok(caught instanceof ProcessExitCalled && caught.code === 1, "the gate still refuses");
  const row = readRows(join(root, "state", "ledger.ndjson")).find((r) => r.step === "self_sync.refused");
  assert.ok(row, "the refusal is a ledger row");
  assert.equal(row.task_id, "P-refused");
  assert.equal(row.verb, "approve");
  assert.equal(row.reason, "off-main");
  assert.equal(row.detached, true);
  assert.equal(row.old_sha, fx.baseSha);
  assert.equal(row.new_sha, fx.mainSha);
});

// ── the lane's hand-off check ───────────────────────────────────────────────────────────────────

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function laneState(ids: string[], store: DecisionStore = {}) {
  const stateDir = scratch("lane");
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: ids.map((id) => ({ id, summary: id, evidenceAnchors: [] })) }));
  writeFileSync(join(stateDir, "inbox-drafts.json"), JSON.stringify(Object.fromEntries(ids.map((id) => [id, { proposalId: id, fragmentYaml: "[]", stampLine: "", anchorFingerprint: "" }]))));
  writeClassificationSnapshot(stateDir, ids.map((proposalId) => ({ proposalId, state: "ready" })));
  writeFileSync(fleetLaneStorePath(stateDir), JSON.stringify(store));
  writeFileSync(ledgerPath, "");
  const approved: string[] = [];
  const write = (step: string, taskId: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "R", task_id: taskId, step, ...extra }) + "\n", { flag: "a" });
  const deps = (more: Partial<FleetLaneDeps> = {}): FleetLaneDeps => ({
    stateDir, ledgerPath, mergedLastDay: () => 5, approve: (id) => { approved.push(id); }, handoffInFlight: () => false, isPidAlive: () => false, ...more,
  });
  return { stateDir, ledgerPath, approved, write, deps, rows: () => readRows(ledgerPath) };
}

const ID = "adoption:symbol-no-caller:src/lib/ledger.ts:ledgerRowActor";

test("W1-T9065: an approve with no outcome row is recorded and retried", () => {
  const lane = laneState([ID], { [ID]: { decision: "file", ts: new Date(Date.now() - 60_000).toISOString(), handoff: "pending" } });
  lane.write("ratify.cli_started", ID, { verb: "approve", pid: 999_999, sha: SHA_A, log: "approve-x.log" });
  lane.write("ratify.cli_exited", ID, { verb: "approve", code: 1, signal: null, sha: SHA_A, log: "approve-x.log" });

  const first = triageFleetLane(lane.deps({ originMainSha: () => SHA_A }));
  const unrecorded = lane.rows().filter((r) => r.step === "fleet_lane.approve_unrecorded");
  assert.equal(unrecorded.length, 1, "the hand-off that left no outcome is named");
  assert.equal(unrecorded[0]!.code, 1);
  assert.equal(unrecorded[0]!.log, "approve-x.log");
  assert.deepEqual(first.filed, [ID], "and the finding is offered again at once, not a day later");
  assert.deepEqual(lane.approved, [ID]);

  // The retry fails the same way at the same sha: it is recorded, and now waits for main to move.
  lane.write("ratify.cli_exited", ID, { verb: "approve", code: 1, signal: null, sha: SHA_A, log: "approve-y.log" });
  const second = triageFleetLane(lane.deps({ originMainSha: () => SHA_A }));
  assert.equal(lane.rows().filter((r) => r.step === "fleet_lane.approve_unrecorded").at(-1)!.count, 2);
  assert.deepEqual(second.filed, [], "a deterministic failure cannot spin at one sha");
  assert.deepEqual(triageFleetLane(lane.deps({ originMainSha: () => { throw new Error("no git"); } })).filed, [], "an unreadable main is not a moved one");
  assert.deepEqual(triageFleetLane(lane.deps({ originMainSha: () => SHA_B })).filed, [ID], "main moved: retried");
});

test("W1-T9065: a failed hand-off does not spend pace room", () => {
  const gone = "adoption:symbol-no-caller:src/lib/gone.ts:x";
  const lane = laneState([ID], { [gone]: { decision: "file", ts: new Date(Date.now() - 60_000).toISOString(), handoff: "pending" } });
  lane.write("ratify.cli_exited", gone, { verb: "approve", code: 1, signal: null, sha: SHA_A, log: "approve-g.log" });
  const pass = triageFleetLane(lane.deps({ mergedLastDay: () => 1 }));
  assert.deepEqual(pass.filed, [ID], "the one slot the day's pace allows is not spent on a hand-off that never ran");
  assert.equal(pass.room, 0);
  assert.deepEqual(readFleetLaneStore(lane.stateDir)[gone]!.unrecorded, { sha: SHA_A, count: 1 });
});

test("W1-T9065: a hand-off with an outcome row, or one still running, keeps its hold", async () => {
  const ids = ["P-out", "P-running", "P-live-pid", "P-lost", "P-dead-pid"];
  const ts = new Date(Date.now() - 60_000).toISOString();
  const lane = laneState(ids, Object.fromEntries(ids.map((id) => [id, { decision: "file" as const, ts, handoff: "pending" as const, unrecorded: { sha: SHA_A, count: 1 } }])));
  lane.write("ratify.approve_refused", "P-out", { reason: "not ready" });
  lane.write("ratify.cli_started", "P-live-pid", { verb: "approve", pid: 7, sha: SHA_A });
  lane.write("ratify.cli_started", "P-dead-pid", { verb: "approve", pid: 8, sha: SHA_A, log: "approve-d.log" });
  const pass = await triageFleetLaneAsync(lane.deps({
    mergedLastDay: () => 0,
    handoffInFlight: (id) => id === "P-running",
    isPidAlive: (pid) => pid === 7,
  }));
  assert.deepEqual(pass.filed, []);
  const store = readFleetLaneStore(lane.stateDir);
  assert.deepEqual(store["P-out"], { decision: "file", ts }, "an outcome row settles it and clears the failure memory");
  for (const id of ["P-running", "P-live-pid"]) assert.equal(store[id]!.handoff, "pending", `${id} is still running`);
  assert.deepEqual(lane.rows().filter((r) => r.step === "fleet_lane.approve_unrecorded").map((r) => r.task_id).sort(), ["P-dead-pid", "P-lost"]);
  assert.deepEqual(store["P-dead-pid"]!.unrecorded, { sha: SHA_A, count: 2 });
  assert.deepEqual(store["P-lost"]!.unrecorded, { count: 1 });
});

test("W1-T9065: without a gateway to ask, a hand-off with no rows is left alone", () => {
  const lane = laneState(["P-quiet"], { "P-quiet": { decision: "file", ts: new Date(Date.now() - 60_000).toISOString(), handoff: "pending" } });
  triageFleetLane(lane.deps({ handoffInFlight: undefined }));
  assert.equal(readFleetLaneStore(lane.stateDir)["P-quiet"]!.handoff, "pending");
});

// ── the gateway's failure arms ──────────────────────────────────────────────────────────────────

test("W1-T9065: a hand-off that cannot reach origin/main writes ratify.handoff_failed and spawns nothing", async () => {
  const state = scratch("gw");
  const ledgerPath = join(state, "ledger.ndjson");
  const rec = recordingSpawn(4242);
  const gateway = fleetRatifyGateway(scratch("nowhere"), join(state, "logs"), ledgerPath, {
    spawn: rec.spawn, mainTip: async () => { throw new Error("fatal: unable to access 'https://x-access-token:ghs_secret@github.com/o/r'"); },
  });
  await gateway.reframe("P-r", "cite it");
  assert.equal(rec.calls.length, 0);
  const row = readRows(ledgerPath).find((r) => r.step === "ratify.handoff_failed")!;
  assert.equal(row.verb, "reframe");
  assert.doesNotMatch(String(row.reason), /ghs_secret/, "credentials never reach the ledger");
});

test("W1-T9065: a tree that stops being exact, or a spawn that errors, is a recorded hand-off failure", { timeout: 60_000 }, async () => {
  const state = scratch("gw2");
  const ledgerPath = join(state, "ledger.ndjson");
  const tree = scratch("tree");
  let inspections = 0;
  const seams = {
    mainTip: async () => SHA_A, addWorktree: () => assert.fail("a reusable tree is not cut again"), prepareWorktree: () => true,
    withWorktreeLease: <T>(_path: string, action: () => Promise<T>) => action(), worktreeRoot: tree, git: () => "",
  };
  const changed = fleetRatifyGateway(tree, join(state, "logs"), ledgerPath, { ...seams, inspectExistingWorktree: () => (inspections++ === 0 ? "reusable" : "unsafe") });
  await changed.approve("P-moved");
  const erroring = recordingSpawn(undefined);
  const failing = fleetRatifyGateway(tree, join(state, "logs"), ledgerPath, { ...seams, inspectExistingWorktree: () => "reusable", spawn: erroring.spawn });
  const done = failing.approve("P-enoent");
  (await erroring.spawned).child.emit("error", new Error("spawn ENOENT"));
  await done;
  const failed = readRows(ledgerPath).filter((r) => r.step === "ratify.handoff_failed");
  assert.deepEqual(failed.map((r) => r.task_id), ["P-moved", "P-enoent"]);
  assert.match(String(failed[0]!.reason), /no longer an exact clean detached checkout/);
  assert.equal(readRows(ledgerPath).some((r) => r.step === "ratify.cli_started"), false, "no pid, no start row");
});

test("W1-T9065: a gateway row the ledger refuses lands on stderr as one JSON line", async (t) => {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { lines.push(String(chunk)); return true; });
  const gateway = ratifyCliGateway(scratch("r"), scratch("logs"), {
    ledgerPath: "/nonexistent-w9065/ledger.ndjson",
    freshTree: freshOriginMainTreeRunner("/nonexistent", { git: () => "", addWorktree: () => {}, worktreeRoot: "/nonexistent", mainTip: async () => { throw new Error("offline"); } }),
  });
  await gateway.approve("P-stderr");
  t.mock.restoreAll();
  const row = JSON.parse(lines.find((l) => l.includes("ratify.handoff_failed"))!) as Record<string, unknown>;
  assert.equal(row.task_id, "P-stderr");
  assert.match(String(row.ledger_error), /REFUSED|ENOENT|EACCES|EROFS/);
});

test("W1-T9065: the CLI refusal sink falls back to the default root, and to stderr", (t) => {
  const home = scratch("bare-home");
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = priorHome; });
  selfSyncRefusalSink("lint-plan", []).log!("self_sync.refused", { reason: "dirty", count: 2 });
  const row = readRows(join(home, "Remudero", "state", "ledger.ndjson"))[0]!;
  assert.equal(row.task_id, "CLI");
  assert.equal(row.verb, "lint-plan");
  assert.equal("detached" in row, false, "only an off-main refusal knows whether HEAD was detached");

  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { lines.push(String(chunk)); return true; });
  t.mock.method(console, "error", () => {});
  const sink = selfSyncRefusalSink(undefined, [], () => "/nonexistent-w9065/ledger.ndjson");
  sink.warn!("rmd is behind origin/main but this checkout is on branch `x`, not `main`");
  sink.log!("self_sync.refused", { reason: "off-main" });
  t.mock.restoreAll();
  const fallback = JSON.parse(lines.find((l) => l.includes("self_sync.refused"))!) as Record<string, unknown>;
  assert.equal(fallback.verb, "(none)");
  assert.equal(fallback.detached, false);
});
