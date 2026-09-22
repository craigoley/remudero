import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "./helpers/git-repo.js";
import { daemonCommand, planReloader } from "../src/run-task.js";
import type { DaemonDeps } from "../src/lib/daemon.js";
import type { Plan } from "../src/lib/plan.js";

function planYaml(ids: string[]): string {
  return ids
    .map((id) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`)
    .join("");
}

// daemon plan reload reads origin/main without checkout mutation.
test("daemon plan reload reads the observed main ref in test/daemon-plan-rebinds-from-main.test.ts", () => {
  const repo = gitRepo({ kind: "plan-main-ref" });
  try {
    const planPath = join(repo.dir, "plan", "tasks.yaml");
    mkdirSync(join(repo.dir, "plan"), { recursive: true });
    writeFileSync(planPath, planYaml(["OLD"]));
    repo.git("add", "plan/tasks.yaml");
    repo.git("commit", "-q", "-m", "old plan");
    const oldHead = repo.git("rev-parse", "HEAD");
    repo.git("update-ref", "refs/remotes/origin/main", oldHead);

    writeFileSync(planPath, planYaml(["NEW-FROM-MAIN"]));
    repo.git("add", "plan/tasks.yaml");
    repo.git("commit", "-q", "-m", "new plan");
    const newHead = repo.git("rev-parse", "HEAD");
    repo.git("reset", "--hard", "-q", oldHead);

    const beforeWorkingTree = readFileSync(planPath, "utf8");
    const beforeHead = repo.git("rev-parse", "HEAD");
    const reload = planReloader({ isSelf: true, planPath }, false, () => {});
    assert.ok(reload);
    assert.equal(reload!(), null, "the boot sha is recorded without a duplicate reload");
    repo.git("update-ref", "refs/remotes/origin/main", newHead);
    const fresh = reload!();
    assert.deepEqual(fresh?.tasks.map((task) => task.id), ["NEW-FROM-MAIN"]);
    assert.equal(repo.git("rev-parse", "HEAD"), beforeHead, "reload does not move HEAD");
    assert.equal(readFileSync(planPath, "utf8"), beforeWorkingTree, "reload leaves the checkout untouched");
  } finally {
    repo.cleanup();
  }
});

test("daemon plan reload retries an unreadable main ref in test/daemon-plan-rebinds-from-main.test.ts", () => {
  let sha = "boot-sha";
  let attempts = 0;
  const reload = planReloader(
    { isSelf: true, planPath: "/rmd/plan/tasks.yaml" },
    false,
    () => {},
    {
      treeSha: () => sha,
      load: () => {
        attempts++;
        if (attempts === 1) throw new Error("main ref temporarily unreadable");
        return { tasks: [{ id: "RETRIED" }] } as unknown as Plan;
      },
    },
  );
  assert.ok(reload);
  assert.equal(reload!(), null);
  sha = "moved-sha";
  assert.throws(() => reload!(), /temporarily unreadable/);
  const fresh = reload!();
  assert.equal(fresh?.tasks[0]?.id, "RETRIED", "the same ref is retried after a transient failure");
  assert.equal(attempts, 2);
});

test("daemon sweep hooks rebind to a reloaded plan in test/daemon-plan-rebinds-from-main.test.ts", async () => {
  const seen: Plan[] = [];
  let next: Plan | null = null;
  const initial = { tasks: [], byId: new Map() } as unknown as Plan;
  const updated = { tasks: [], byId: new Map([["RELOADED", {}]]) } as unknown as Plan;
  const { runDaemon } = await import("../src/lib/daemon.js");
  let ticks = 0;
  await runDaemon(
    initial,
    {
      refreshMerged: (plan: Plan | undefined) => {
        seen.push(plan ?? initial);
        return () => false;
      },
      reloadPlan: () => {
        if (next === null) {
          next = updated;
          return next;
        }
        return null;
      },
      checkStop: () => (++ticks > 2 ? "done" : undefined),
      runOne: async () => ({ taskId: "none", merged: true }) as never,
      sleep: async () => {},
    } as never,
    { max: 1 },
  );
  assert.ok(seen.some((plan) => plan === updated), "a later sweep/projection receives the reloaded plan");
});

test("daemon command wires the plan-reload callback in test/daemon-plan-rebinds-from-main.test.ts", async () => {
  const home = join(tmpdir(), `rmd-plan-reload-${process.pid}-${Date.now()}`);
  const root = join(home, "Remudero");
  const planPath = join(home, "tasks.yaml");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  const oldCi = process.env.CI;
  process.env.HOME = home;
  process.env.CI = "1";
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps) => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.equal(typeof captured?.onPlanReload, "function");
    captured?.onPlanReload?.({ tasks: [], byId: new Map() } as unknown as Plan);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCi === undefined) delete process.env.CI;
    else process.env.CI = oldCi;
    rmSync(home, { recursive: true, force: true });
  }
});
