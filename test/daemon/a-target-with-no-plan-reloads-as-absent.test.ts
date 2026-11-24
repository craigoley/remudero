import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import type { Plan } from "#src/lib/plan.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
// Through the shared helper, never a new direct importer of src/run-task.ts.
import { dedicatedTargetPlanReloader } from "#test/helpers/run-task-test.js";

// W1-T14585 — a dedicated daemon for a target repository with NO plan asked origin/main for its
// plan tree every tick, failed every tick, and wrote one `daemon.plan_reload_failed` row per tick,
// forever. These tests drive the reloader's REAL git defaults against a real origin and a real clone,
// through the real `runDaemon` tick loop, so every ledger row they count is one production writes.

const PLAN = "- id: A\n  title: a\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n";

type Row = { step: string; extra?: Record<string, unknown> };

/** A bare origin, a working checkout that pushes to it, and the daemon's own clone of it. */
function target(t: TestContext): { origin: GitRepo; work: GitRepo; clone: GitRepo; push: (message: string) => void } {
  const origin = gitRepo({ bare: true, kind: "w1t14585-origin", scope: t });
  const work = gitRepo({ kind: "w1t14585-work", scope: t });
  work.addRemote("origin", origin.dir);
  work.git("push", "-q", "origin", "main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "w1t14585-clone", scope: t });
  const push = (message: string) => {
    work.git("add", "-A");
    work.git("commit", "-q", "--allow-empty", "-m", message);
    work.git("push", "-q", "origin", "main");
  };
  return { origin, work, clone, push };
}

/** `ticks` real `runDaemon` ticks over the reloader; `between(i)` runs after tick i's reload. */
async function tick(reloadPlan: () => Promise<Plan | null>, rows: Row[], ticks: number, between: (i: number) => void = () => {}) {
  const log = (step: string, extra?: Record<string, unknown>) => {
    rows.push({ step, extra });
  };
  let n = 0;
  await runDaemon(
    { tasks: [], byId: new Map() },
    {
      ...hostIndependentDaemonDeps(),
      // Every task reads as merged, so a reloaded plan never dispatches: these ticks only reload.
      refreshMerged: () => () => true,
      checkStop: () => (n >= ticks ? "tick cap" : undefined),
      reloadPlan: async () => {
        try {
          return await reloadPlan();
        } finally {
          between(n);
          n += 1;
        }
      },
      runOne: async () => {
        throw new Error("a merged task never dispatches");
      },
      sleep: async () => {},
      log,
    } as unknown as DaemonDeps,
    {},
  );
  assert.equal(n, ticks, `control: the loop ran ${ticks} reload ticks`);
}

const count = (rows: Row[], step: string) => rows.filter((r) => r.step === step).length;

test("W1-T14585: a target with no plan reloads as absent", async (t) => {
  const { work, clone, push } = target(t);
  const rows: Row[] = [];
  const planPath = join(clone.dir, "plan", "tasks.yaml");
  const reloads: Array<Plan | null> = [];
  const reloader = dedicatedTargetPlanReloader({ isSelf: false, planPath }, (step, extra) => rows.push({ step, extra }))!;
  const recording = async () => {
    const r = await reloader();
    reloads.push(r);
    return r;
  };

  // Ticks 0-2: origin/main has never held a plan.
  await tick(recording, rows, 3);
  assert.equal(count(rows, "daemon.plan_reload_failed"), 0, `no plan is not a failure — rows: ${JSON.stringify(rows)}`);
  assert.equal(count(rows, "daemon.plan_absent"), 1, "one plan_absent row when the state is first seen, not one per tick");
  assert.deepEqual(rows.find((r) => r.step === "daemon.plan_absent")!.extra, { ref: "origin/main", path: "plan" });
  assert.deepEqual(reloads[0], { tasks: [], byId: new Map() }, "the absent plan is reported as an empty plan");
  assert.deepEqual(reloads.slice(1), [null, null], "and stays quiet while it stays absent");

  // A plan arrives, then is deleted again: one more plan_absent row, for the one state change.
  rows.length = 0;
  reloads.length = 0;
  await tick(recording, rows, 4, (i) => {
    if (i === 0) {
      mkdirSync(join(work.dir, "plan"), { recursive: true });
      writeFileSync(join(work.dir, "plan", "tasks.yaml"), PLAN);
      push("file a plan");
    }
    if (i === 1) {
      rmSync(join(work.dir, "plan"), { recursive: true, force: true });
      push("delete the plan");
    }
  });
  assert.equal(count(rows, "daemon.plan_reload_failed"), 0, `rows: ${JSON.stringify(rows)}`);
  assert.equal(reloads[0], null, "still absent before the plan is pushed");
  assert.deepEqual(reloads[1]?.tasks.map((t) => t.id), ["A"], "a plan that appears is loaded");
  assert.deepEqual(reloads[2], { tasks: [], byId: new Map() }, "a deleted plan reloads as absent");
  assert.equal(reloads[3], null);
  assert.equal(count(rows, "daemon.plan_absent"), 1, "absent after present writes exactly one row");
  assert.equal(existsSync(join(clone.dir, "plan")), false, "the deletion reset the daemon's checkout");
});

test("W1-T14585: an unreadable target plan still logs plan_reload_failed", async (t) => {
  // (a) A plan that is present but does not parse fails, as on origin/main.
  {
    const { work, clone, push } = target(t);
    mkdirSync(join(work.dir, "plan"), { recursive: true });
    writeFileSync(join(work.dir, "plan", "tasks.yaml"), PLAN);
    push("file a plan");
    clone.git("pull", "-q", "origin", "main");
    const rows: Row[] = [];
    const reloader = dedicatedTargetPlanReloader({ isSelf: false, planPath: join(clone.dir, "plan", "tasks.yaml") }, (step, extra) => rows.push({ step, extra }))!;
    await tick(reloader, rows, 2, (i) => {
      if (i === 0) {
        writeFileSync(join(work.dir, "plan", "tasks.yaml"), "- id: [unterminated\n");
        push("break the plan");
      }
    });
    assert.equal(count(rows, "daemon.plan_reload_failed"), 1, `a present, unparseable plan fails — rows: ${JSON.stringify(rows)}`);
    assert.equal(count(rows, "daemon.plan_absent"), 0, "and is never reported as absent");
  }
  // (b) A git failure that is not a missing path fails EVERY tick, never as absent. The fetch
  // succeeds, but maps `main` to another name, so `origin/main` itself no longer resolves.
  {
    const { clone } = target(t);
    clone.git("config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/elsewhere");
    clone.git("update-ref", "-d", "refs/remotes/origin/main");
    clone.git("fetch", "-q", "origin");
    assert.match(clone.git("rev-parse", "--verify", "refs/remotes/origin/elsewhere"), /^[0-9a-f]{40}$/, "control: the fetch succeeds");
    const rows: Row[] = [];
    const reloader = dedicatedTargetPlanReloader({ isSelf: false, planPath: join(clone.dir, "plan", "tasks.yaml") }, (step, extra) => rows.push({ step, extra }))!;
    await tick(reloader, rows, 3);
    const failed = rows.filter((r) => r.step === "daemon.plan_reload_failed");
    assert.equal(failed.length, 3, `rows: ${JSON.stringify(rows)}`);
    assert.ok(failed.every((r) => /origin\/main/.test(String(r.extra?.reason))), "each failure names the unresolved ref");
    assert.equal(count(rows, "daemon.plan_absent"), 0, "a broken ref is a failure, not an absent plan");
  }
});
