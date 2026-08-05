/**
 * THE INFLIGHT-LOCK LIVENESS DISJUNCT (deriveStatus's third arm beside hasOpenPr/recentActivity).
 *
 * WHY THIS FILE EXISTS SEPARATELY (CLAUDE.md's coverage rule): every assertion here is
 * coverage-load-bearing for the new branch in `deriveStatus`, and `test/run-task.test.ts`
 * intermittently crashes at FILE level under --experimental-test-coverage, which would zero the
 * record for anything appended there.
 *
 * THE TWO DIRECTIONS, both asserted:
 *   - a genuinely-live run that has gone QUIET past the 30-minute ledger bound must render as
 *     RUNNING (the defect: it rendered as nothing);
 *   - a lock whose holder pid is DEAD must NOT render as running (the defect this fix must not
 *     reintroduce — a lock file outlives its process, so trusting the lock alone would resurrect
 *     the "dead run rendered live" bug in the very surface being changed).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { deriveStatus, type DeriveDeps, type GitHub } from "../src/lib/status.js";
import { readInflightLock } from "../src/lib/inflight-lock.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import type { Plan, Task } from "../src/lib/plan.js";

const READ_TOKEN = "inflight-anchor-read-token";
const WRITE_TOKEN = "inflight-anchor-write-token";

const TASK: Task = { id: "W1-T900", title: "quiet but alive", repo: "remudero", type: "implement" } as Task;

/** A gateway that knows nothing: no PR for any ref, no merged trailer, no head branch, no body.
 *  Deliberately the WORST case for this rung — with no GitHub evidence at all, `hasOpenPr` is
 *  false, so the lock disjunct is the only thing that can make a run render as running. */
function noGitHub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

/** A dispatched run that opened and never closed, whose last ledger line is DELIBERATELY older
 *  than DEFAULT_LIVENESS_BOUND_MS — so `recentActivity` is false and only the lock can rescue it. */
function quietRunLines(taskId: string): Array<Record<string, unknown>> {
  const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString(); // 3h ago
  return [
    { ts: old, run_id: "r-quiet", task_id: taskId, step: "run.start" },
    { ts: old, run_id: "r-quiet", task_id: taskId, step: "recon.done" },
  ];
}

function depsFor(over: Partial<DeriveDeps> = {}): DeriveDeps {
  return {
    ledgerPath: "/nonexistent/ledger.ndjson",
    github: noGitHub(),
    readLedger: () => quietRunLines(TASK.id),
    ...over,
  };
}

test("a quiet in-flight run whose lock holder is ALIVE renders as running, not orphaned", () => {
  const p = deriveStatus(TASK, depsFor({
    inflightHolder: () => ({ pid: 4242 }),
    isPidAlive: (pid) => pid === 4242,
  }));
  assert.equal(p.status, "running", "a live lock must rescue a run the ledger bound gave up on");
  assert.equal(p.phase, "implement");
  assert.notEqual(p.orphaned, true);
});

test("a quiet in-flight run whose lock holder pid is DEAD stays orphaned and never renders running", () => {
  const p = deriveStatus(TASK, depsFor({
    inflightHolder: () => ({ pid: 65304 }), // the observed W1-T1.lock holder, dead for two days
    isPidAlive: () => false,
  }));
  assert.notEqual(p.status, "running", "a stale lock must not resurrect the dead-run-rendered-live defect");
  assert.equal(p.orphaned, true);
});

test("with NO inflightHolder wired the rung is skipped entirely — prior two-disjunct behaviour is unchanged", () => {
  const p = deriveStatus(TASK, depsFor());
  assert.equal(p.orphaned, true, "absent the dep, a quiet run is orphaned exactly as before");
  assert.notEqual(p.status, "running");
});

test("a HELD lock does not invent running-ness for a task whose ledger shows no open run", () => {
  // The bound of the change, asserted: the disjunct only ever rescues a run the ledger already
  // considers in flight. A lock beside a CLOSED run must not reopen it.
  const closed = [
    { ts: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), run_id: "r1", task_id: TASK.id, step: "run.start" },
    { ts: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), run_id: "r1", task_id: TASK.id, step: "verdict" },
  ];
  const p = deriveStatus(TASK, depsFor({
    readLedger: () => closed,
    inflightHolder: () => ({ pid: process.pid }),
  }));
  assert.notEqual(p.status, "running", "a terminal-closed run stays closed regardless of a stray lock");
});

// ── ROUTE LEVEL: the server assembled the production way, the RENDERED value asserted ────────
//
// A deriving-function test cannot see a wrong count in a rendered board (this repo's documented
// trap), so these two assemble `buildServeServer` exactly as `rmd serve` does and read the count
// off `GET /v1/status`'s real JSON body.

function serveDeps(root: string, over: Partial<ServeDeps["board"]> = {}): ServeDeps {
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, quietRunLines(TASK.id).map((l) => JSON.stringify(l)).join("\n") + "\n");
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  const planYaml = `- id: ${TASK.id}\n  title: "${TASK.title}"\n  repo: ${TASK.repo}\n  type: ${TASK.type}\n`;
  writeFileSync(planPath, planYaml);
  // The REAL loader, not a hand-built object: `computeBoardSnapshot` joins titles through
  // `plan.byId`, which only `loadPlanFromYaml` populates. A literal `{ tasks: [...] }` throws
  // inside the board and would have been a fixture bug masquerading as a route failure.
  const plan: Plan = loadPlanFromYaml(planYaml, planPath);
  const inflightDir = join(root, "state", "inflight");
  return {
    // The SAME expression run-task.ts's production wiring uses — a real readInflightLock over a
    // real lock directory, never a fake holder, so this exercises the wiring and not a stand-in.
    board: { plan, ledgerPath, github: noGitHub(), inflightHolder: (id) => readInflightLock(inflightDir, id), ...over },
    panelGraph: {
      root, planPath, ledgerPath,
      github: { prByRef: () => null } as never,
      statusGithub: noGitHub(),
      ratify: { approve() {}, reframe() {} },
    },
    ledgerPath,
    issues: { close: async () => {} } as never,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
  } as ServeDeps;
}

function writeLock(root: string, taskId: string, pid: number): void {
  const dir = join(root, "state", "inflight");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${taskId}.lock`),
    JSON.stringify({ pid, run_id: "r-quiet", host: "test", startedAt: new Date().toISOString() }, null, 2),
  );
}

async function statusBody(deps: ServeDeps): Promise<{ counts: { running: number }; tasks: Array<{ taskId: string; status: string }> }> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { Authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(res.status, 200);
    return (await res.json()) as never;
  } finally {
    server.close();
  }
}

test("RENDERED: a quiet run holding a live lock is counted running by GET /v1/status", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-inflight-anchor-live-"));
  const deps = serveDeps(root);
  // `process.pid` is unarguably alive, and NO isPidAlive override is passed — this arm exercises
  // the REAL defaultIsPidAlive (kill(pid,0)) through the real lock reader.
  writeLock(root, TASK.id, process.pid);
  const body = await statusBody(deps);
  assert.equal(body.counts.running, 1, "the rendered header count, not the deriving function's return");
  assert.equal(body.tasks.find((t) => t.taskId === TASK.id)?.status, "running");
});

test("RENDERED: the same quiet run with a DEAD lock holder is counted 0 running by GET /v1/status", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-inflight-anchor-dead-"));
  // Deterministic dead-holder arm: the probe is injected here rather than racing a real pid's
  // reuse, while the live arm above keeps the real probe honest.
  const deps = serveDeps(root, { isPidAlive: () => false });
  writeLock(root, TASK.id, 65304);
  const body = await statusBody(deps);
  assert.equal(body.counts.running, 0, "a stale lock must not inflate the rendered running count");
  assert.notEqual(body.tasks.find((t) => t.taskId === TASK.id)?.status, "running");
});
