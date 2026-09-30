import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createBoardSnapshotCache, type BoardDeps } from "../src/lib/board.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { assessGatewayCheckout, gateStaleCodeExit, type StaleCodeExitDeps } from "../src/lib/serve.js";
import { readServePlanAtRef, reloadServePlan, SERVE_PLAN_RELOADABLE_PATHS, type PlanRead } from "../src/lib/serve-plan-reload.js";
import { serveRestartRelevant, type ChangedPathsRead } from "../src/lib/serve-restart-relevance.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { gitRepo } from "./helpers/git-repo.js";

// W1-T4481: a plan-only advance reloads serve's plan in place instead of restarting it.

const BOOT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, title: `title ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0, ...over };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function gateWith(read: ChangedPathsRead, extra: Partial<StaleCodeExitDeps> = {}) {
  const exits: number[] = [];
  const logs: string[] = [];
  const gate = gateStaleCodeExit({
    bootSha: BOOT,
    resolveCurrentSha: () => NEW,
    exit: (code) => exits.push(code),
    log: (step) => logs.push(step),
    scheduleRecheck: () => () => {},
    resolveCommitsBehind: () => 1,
    changedPathsSince: () => read,
    ...extra,
  });
  return { gate, exits, logs };
}

test("a plan-only merge does not make serve restart", async () => {
  const reloads: string[] = [];
  const rec = gateWith(
    { changedPaths: ["plan/tasks.d/W1-T9-x.yaml", "plan/tasks.yaml"] },
    { reloadPlan: async (ref) => (reloads.push(ref), true) },
  );
  await rec.gate.recheck();
  await settle();
  await rec.gate.recheck();
  await settle();
  assert.deepEqual(rec.exits, [], "the plan is reloaded in place, so the restart buys a cold read and nothing else");
  assert.deepEqual(reloads, [NEW], "reloaded once at the advanced sha, not once a minute");
  assert.equal(serveRestartRelevant(["plan/tasks.d/W1-T9-x.yaml"]), false);
  assert.deepEqual(SERVE_PLAN_RELOADABLE_PATHS, ["plan/tasks.yaml", "plan/tasks.d/"]);
});

test("a plan merge that also touches src still restarts serve", async () => {
  const reloads: string[] = [];
  const mixed = gateWith(
    { changedPaths: ["plan/tasks.d/W1-T9-x.yaml", "src/lib/serve.ts"] },
    { reloadPlan: async (ref) => (reloads.push(ref), true) },
  );
  await mixed.gate.recheck();
  await settle();
  assert.deepEqual(mixed.exits, [0]);
  const policy = gateWith({ changedPaths: ["plan/policy.yaml"] }, { reloadPlan: async (ref) => (reloads.push(ref), true) });
  await policy.gate.recheck();
  await settle();
  assert.deepEqual(policy.exits, [0], "plan/policy.yaml is read once at boot, so it still restarts");
  for (const path of ["plan/decisions.d/x.yaml", "plan/claims.yaml", "plan/policy.yaml"]) {
    assert.equal(serveRestartRelevant(["plan/tasks.d/a.yaml", path]), true, path);
  }
  assert.deepEqual(reloads, [], "a diff that restarts never reloads first");
});

test("a plan-only advance swaps the served plan in place", async () => {
  const before = planOf([task("W1-T1")]);
  const after = planOf([task("W1-T1"), task("W1-T2")]);
  const board = { plan: before };
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const rec = gateWith(
    { changedPaths: ["plan/tasks.d/W1-T2-x.yaml"] },
    { reloadPlan: (ref) => reloadServePlan(board, "/nonexistent", ref, { read: async () => ({ plan: after, quarantined: [] }), log: (s, e) => logs.push([s, e]) }) },
  );
  await rec.gate.recheck();
  await settle();
  await settle();
  assert.equal(board.plan, after, "one assignment installs the plan at the advanced sha");
  assert.deepEqual(rec.exits, []);
  const reloaded = logs.find(([step]) => step === "serve.plan_reloaded");
  assert.equal(reloaded?.[1]?.ref, NEW);
  assert.equal(reloaded?.[1]?.tasks, 2);
  assert.equal(typeof reloaded?.[1]?.elapsedMs, "number");
});

test("the board snapshot drops rows from the replaced plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-serve-plan-reload-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const deps: BoardDeps = { plan: planOf([task("W1-T1"), task("W1-T2", { title: "old title" })]), ledgerPath, github: fakeGitHub({}) };
  const cache = createBoardSnapshotCache();
  assert.deepEqual(cache.get(deps).tasks.map((row) => row.taskId).sort(), ["W1-T1", "W1-T2"]);
  deps.plan = planOf([task("W1-T2", { title: "new title" }), task("W1-T3")]);
  const rows = cache.get(deps).tasks;
  assert.deepEqual(rows.map((row) => row.taskId).sort(), ["W1-T2", "W1-T3"], "W1-T1 left the plan and must leave the board");
  assert.equal(rows.find((row) => row.taskId === "W1-T2")?.title, "new title", "a memoised projection is not served for a replaced task");
});

test("a failed plan reload keeps the old plan serving", async () => {
  const before = planOf([task("W1-T1")]);
  const board = { plan: before };
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  let attempts = 0;
  const rec = gateWith(
    { changedPaths: ["plan/tasks.d/W1-T2-x.yaml"] },
    {
      reloadPlan: (ref) =>
        reloadServePlan(board, "/nonexistent", ref, {
          read: async () => {
            attempts += 1;
            throw new Error("git exploded");
          },
          log: (s, e) => logs.push([s, e]),
        }),
    },
  );
  await rec.gate.recheck();
  await settle();
  await settle();
  assert.equal(board.plan, before, "the previous plan is still serving");
  assert.deepEqual(rec.exits, [], "a bad plan does not become a restart: a restarted serve would read the same one");
  const failed = logs.find(([step]) => step === "serve.plan_reload_failed");
  assert.equal(failed?.[1]?.ref, NEW);
  assert.match(String(failed?.[1]?.reason), /git exploded/);
  await rec.gate.recheck();
  await settle();
  assert.equal(attempts, 2, "the ref was not recorded as loaded, so the next check retries");
});

test("a duplicate id in a reloaded serve plan is quarantined", async () => {
  const repo = gitRepo({ kind: "serve-plan-reload" });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  const record = (id: string, title: string, deps = "[]") =>
    `- id: ${id}\n  title: "${title}"\n  repo: remudero\n  depends_on: ${deps}\n  type: implement\n  verify: auto\n  risk: medium\n  status: queued\n  attempts: 0\n`;
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), record("W1-T1", "monolith"));
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T2-a.yaml"), record("W1-T2", "first"));
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T2-b.yaml"), record("W1-T2", "second"));
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T3-c.yaml"), record("W1-T3", "child", '["W1-T2"]'));
  repo.git("add", "plan");
  repo.git("commit", "--quiet", "-m", "plan");
  const ref = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "not: [valid");
  const read = await readServePlanAtRef(repo.dir, ref);
  assert.deepEqual(read.plan.tasks.map((t) => t.id), ["W1-T1"], "the duplicated id and its dependent are held out; the working tree is never read");
  assert.deepEqual(read.quarantined.map((q) => [q.id, q.reason]).sort(), [["W1-T2", "duplicate_id"], ["W1-T3", "depends_on_quarantined"]]);

  const board = { plan: planOf([]) };
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  assert.equal(await reloadServePlan(board, repo.dir, ref, { log: (s, e) => logs.push([s, e]) }), true);
  assert.deepEqual(board.plan.tasks.map((t) => t.id), ["W1-T1"]);
  const quarantined = logs.find(([step]) => step === "serve.plan_quarantined");
  assert.deepEqual(quarantined?.[1]?.ids, ["W1-T2", "W1-T3"]);
  assert.ok(logs.some(([step]) => step === "serve.plan_reloaded"));
  const missing: PlanRead | undefined = await readServePlanAtRef(repo.dir, "deadbeef").catch(() => undefined);
  assert.equal(missing, undefined, "an unreadable ref throws rather than yielding an empty plan");
});

test("a plan-only advance of the gateway checkout reloads at origin's sha instead of restarting", async () => {
  const assess = (diff: string) =>
    assessGatewayCheckout({
      repoDir: "/nonexistent",
      env: {},
      fetch: async () => {},
      git: (args) => {
        if (args[0] === "rev-parse") return args[1] === "HEAD" ? `${BOOT}\n` : `${NEW}\n`;
        if (args[0] === "diff") return diff;
        if (args[0] === "rev-list") return "1\n";
        return "";
      },
    });
  const planOnly = await assess("plan/tasks.d/W1-T2-x.yaml\n");
  assert.equal(planOnly.restartDue, false);
  assert.equal(planOnly.reloadPlanAt, NEW);
  const mixed = await assess("plan/tasks.d/W1-T2-x.yaml\nsrc/lib/serve.ts\n");
  assert.equal(mixed.restartDue, true);
  assert.equal(mixed.reloadPlanAt, undefined);
  assert.equal((await assess("docs/a.md\n")).reloadPlanAt, undefined);

  const reloads: string[] = [];
  const rec = gateWith({ changedPaths: ["docs/a.md"] }, {
    resolveCurrentSha: () => BOOT,
    assessCheckout: async () => planOnly,
    reloadPlan: async (ref) => (reloads.push(ref), true),
  });
  await rec.gate.recheck();
  assert.deepEqual(reloads, [NEW]);
  assert.deepEqual(rec.exits, []);
});
