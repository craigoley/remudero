// test/worker/a-run-child-releases-its-setup-before-the-agent-wait.test.ts — run children peak, then sit idle and swapped.
//
// OBSERVED 2026-10-19 (logs-8864/mempress-*): idle run-task children held about 1.9 GB of swap. The W1-T9338 run child peaked
// at 915 MB and held 48 MB resident and 565 MB in swap while it waited on its agent; an automated retro child peaked at
// 1.58 GB. Both inherited NODE_OPTIONS without the daemon's growth percent, and the run child kept its whole parsed plan
// through every wait. These tests drive the REAL runChildMain and runTask against a local git origin, the real
// spawnRunChild and the real retro adapter; each one fails at the parent commit.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import type { Config } from "#src/lib/config.js";
import type { ProbeExecResult } from "#src/lib/containment.js";
import { applyDaemonMemoryPolicy, DEFAULT_DAEMON_MEMORY_POLICY } from "#src/lib/daemon-memory-policy.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "#src/lib/isolation.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { LearnedReservation } from "#src/lib/host-memory-learning.js";
import { runAutomatedRetroSubprocess } from "#src/lib/retro-subprocess.js";
import { RUN_CHILD_SPAWNED_STEP, spawnRunChild, writePlanSnapshot, type SpawnRunChildPorts } from "#src/lib/run-child.js";
import { RUN_CHILD_SCHEMA, runDir, writeSpec, type RunChildProbe } from "#src/lib/run-child-contract.js";
import type { GitHub } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { ContainedProcess, ContainedSpawnOptions } from "#src/lib/worker-containment.js";
import { runChildMain } from "#src/run-child-main.js";
import { runTask } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const TASK_ID = "T-CHILD-HEAP";
const SHA = "b".repeat(40);
const HASH = "a".repeat(64);
const GEN = { containerId: "c", initStart: "i" };
const scratch: string[] = [];
const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}child-heap-${label}-`));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const TASK = {
  id: TASK_ID, title: "a run child lets go of its plan before it waits", repo: "remudero", type: "implement", verify: "auto",
  risk: "medium", files: ["src/lib/daemon.ts"], origin: "test", status: "queued", depends_on: [],
};
/** Other tasks, so the snapshot is a plan and not just the run's own task. */
const OTHERS = Array.from({ length: 200 }, (_, i) => ({ ...TASK, id: `T-OTHER-${i}`, title: `another task ${i} ${"x".repeat(200)}` }));

const OFFLINE_GITHUB: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
const containmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });
const isolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });
const noSignals = { on() {}, off() {} };
const probe: RunChildProbe = { process: () => ({ state: "alive", start: "proc:1" }), generation: () => GEN };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A bare origin carrying the task, the clone runTask builds from, and a run directory whose spec names the plan snapshot. */
function runChildFixture(): { config: Config; dir: string; ledger: string } {
  const root = tmp("root");
  const origin = gitRepo({ bare: true, kind: "child-heap-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "child-heap-seed" });
  mkdirSync(join(seed.dir, "plan"), { recursive: true });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"),
    `- id: ${TASK_ID}\n  title: t\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  files: [src/lib/daemon.ts]\n  origin: test\n  status: queued\n`);
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "HEAD:main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const repo = join(root, "repos", "remudero");
  seed.git("clone", "-q", origin.dir, repo);
  seed.git("-C", repo, "config", "user.email", "fixture@remudero.invalid");
  seed.git("-C", repo, "config", "user.name", "remudero test fixture");
  const state = join(root, "state");
  const runId = "run-child-heap";
  const dir = runDir(state, runId);
  mkdirSync(dir, { recursive: true });
  const snapshot = writePlanSnapshot(state, [...OTHERS, TASK]);
  writeSpec(dir, {
    schema: RUN_CHILD_SCHEMA, taskId: TASK_ID, runId, instance: "i", engine: { sourceHash: HASH, sha: SHA },
    planSnapshotPath: snapshot.path, reservationId: "reservation-1", options: { allowStale: false },
  });
  return { config: { claudeBin: "/bin/true", root, installRoot: process.cwd() }, dir, ledger: join(state, "ledger.ndjson") };
}

function rowsOf(ledger: string, step: string): Array<Record<string, unknown>> {
  let text = "";
  try { text = readFileSync(ledger, "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.step === step);
}

/** Runs the real child entry over the real runTask; the agent spawn records what it sees and ends the run. */
async function runToFirstAgentWait(
  atWait: (planRef: WeakRef<object> | undefined, ledger: string) => Promise<void>,
  deps: { atAgentWait?: () => Promise<never> } = {},
): Promise<{ code: number; ledger: string }> {
  const fx = runChildFixture();
  let planRef: WeakRef<object> | undefined;
  const code = await withLiveWritesAllowed(() => runChildMain(["--run-dir", fx.dir], {
    signals: noSignals, probe, env: {}, stderr: () => {}, loadRunPath: async () => ({}), ...deps,
    runTask: (taskId, options) => runTask(taskId, {
      ...options,
      config: fx.config, github: OFFLINE_GITHUB, containmentExec, isolationExec,
      planSnapshot: (o: { allowStale?: boolean }) => {
        const synced = (options.planSnapshot as (o: { allowStale?: boolean }) => { plan: object; staleDispatch: boolean })(o);
        planRef = new WeakRef(synced.plan);
        return synced;
      },
      spawn: async () => {
        await atWait(planRef, fx.ledger);
        throw new Error("the test ends the run at its first agent wait");
      },
    }),
  }));
  return { code, ledger: fx.ledger };
}

test("a run child's parsed plan is collectable when its first agent wait starts", { timeout: 120_000 }, async () => {
  setFlagsFromString("--expose-gc"); // TESTS ONLY: production collects through vm.measureMemory (src/lib/agent-wait-heap.ts)
  const gc = runInNewContext("gc") as () => void;
  let reachable: boolean | undefined;
  let sawPlan = false;
  await runToFirstAgentWait(async (planRef) => {
    sawPlan = planRef !== undefined;
    for (let i = 0; i < 8 && planRef?.deref() !== undefined; i++) {
      await sleep(10);
      gc();
    }
    reachable = planRef?.deref() !== undefined;
  });
  assert.equal(sawPlan, true, "the run read its plan through the run child's snapshot seam");
  assert.equal(reachable, false, "neither the child entry nor runTask still holds the whole plan once the agent wait starts");
});

test("a run child ledgers its heap before and after the collection at each agent wait", { timeout: 120_000 }, async () => {
  let row: Record<string, unknown> | undefined;
  await runToFirstAgentWait(async (_planRef, ledger) => {
    for (let i = 0; i < 200 && row === undefined; i++) {
      await sleep(25);
      row = rowsOf(ledger, "run.agent_wait_heap")[0];
    }
  });
  assert.ok(row, "the wait's collection is ledgered");
  assert.equal(row.waiting_on, "recon");
  for (const field of ["heap_used_before_bytes", "heap_used_after_bytes", "heap_total_after_bytes", "rss_after_bytes", "max_rss_bytes", "collect_ms"]) {
    assert.equal(typeof row[field], "number", `${field} is measured: ${JSON.stringify(row)}`);
  }
  assert.ok((row.max_rss_bytes as number) >= (row.rss_after_bytes as number) - 4096 * 1024, "the high-water mark is at least the resident size");
  assert.ok((row.heap_used_after_bytes as number) > 0);
});

test("a failed collection at an agent wait is ledgered with its error and the run goes on", { timeout: 120_000 }, async () => {
  let row: Record<string, unknown> | undefined;
  let waited = false;
  await runToFirstAgentWait(async (_planRef, ledger) => {
    waited = true;
    for (let i = 0; i < 200 && row === undefined; i++) {
      await sleep(25);
      row = rowsOf(ledger, "run.agent_wait_heap")[0];
    }
  }, { atAgentWait: () => Promise.reject(new Error("measureMemory unavailable")) });
  assert.equal(waited, true, "the agent still spawned");
  assert.deepEqual({ waiting_on: row?.waiting_on, error: row?.error }, { waiting_on: "recon", error: "measureMemory unavailable" });
});

// ── the daemon's growth percent reaches the children it starts ────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  pid: number | undefined = 424_242;
  unref(): void {}
}

test("a run child and an automated retro child start under the daemon's heap growth percent", async () => {
  const applied = applyDaemonMemoryPolicy({ ...DEFAULT_DAEMON_MEMORY_POLICY, heapGrowingPercent: 50 }, { setFlags: () => {}, env: {} });
  assert.deepEqual(applied.child_node_args, ["--heap-growing-percent=50"]);

  const root = tmp("spawn");
  const state = join(root, "state");
  mkdirSync(join(state, "engines", HASH), { recursive: true });
  writeFileSync(join(state, "engines", HASH, "engine.json"), JSON.stringify({ sha: SHA, sourceHash: HASH, builtAt: Date.now() }));
  const rows: Array<Record<string, unknown>> = [];
  let argv: readonly string[] = [];
  const reservation = { id: "reservation-1", bindRoot: () => {}, releaseOccupancy: () => {} } as unknown as LearnedReservation;
  const ports: SpawnRunChildPorts = {
    mainSha: async () => SHA, engine: { isCurrent: () => true }, reserve: async () => reservation, pollMs: 20, abort: { pollMs: 20 },
    probe, watch: false, spawn: (_command, args) => { argv = args; return new FakeChild() as never; },
  };
  const launched = await spawnRunChild({
    taskId: "T-1", stateRoot: state, repoDir: root, root, options: { skipGitSync: false },
    plan: async () => ({ plan: { tasks: [TASK] } }), log: (step, extra) => { rows.push({ step, ...extra }); },
  }, ports);
  assert.ok(launched.started, JSON.stringify(launched));
  launched.detach();
  launched.settled.catch(() => {});
  assert.equal(argv[0], "--heap-growing-percent=50", `the run child's node flags lead its argv: ${JSON.stringify(argv)}`);
  assert.deepEqual(rows.find((row) => row.step === RUN_CHILD_SPAWNED_STEP)?.node_args, ["--heap-growing-percent=50"]);

  let options: ContainedSpawnOptions | undefined;
  const telemetry: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  await runAutomatedRetroSubprocess({ fire: true, reason: "days", mergesSinceMarker: 0, daysSinceMarker: 9 }, {
    spawn: (received) => {
      options = received;
      queueMicrotask(() => child.emit("exit", 0, null));
      return { process: child, pid: process.pid + 10_000 } as unknown as ContainedProcess;
    },
    teardown: () => {},
    log: (step, extra = {}) => telemetry.push({ step, extra }),
  });
  assert.ok(options?.args.includes("--heap-growing-percent=50"), `the retro child's argv carries the growth percent: ${JSON.stringify(options?.args)}`);
  assert.deepEqual(telemetry.find((row) => row.step === "daemon.retro_subprocess.start")?.extra.node_args, ["--heap-growing-percent=50"]);
});
