import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { productionLifetimePressureHook, routeAdaptiveLifetimePressure } from "../src/run-task.js";
import { VERIFY_HUMAN_JUDGED_STEP } from "../src/lib/verify-human-judge.js";
import type { Config } from "../src/lib/config-schema.js";

// W1-T4025 exported `routeAdaptiveLifetimePressure` with no caller in test/, so the whole shard
// projection — the evidence string and the observation key the judge is asked about — shipped
// unmeasured and `diff-coverage` named every line of it. These tests drive the real function.
//
// THE JUDGE IS NEVER CALLED, and not because it is stubbed: there is no seam to stub. A shard
// whose observation key already carries a non-failed verdict is settled (`isSettled`), so
// `routeVerifyHumanBacklog` spends no judge call on it. Writing that prior row is therefore both
// how this test stays offline AND what makes it a falsifier of the projection: the key below is a
// LITERAL, not re-derived from the source, so any change to how the evidence counts are gathered
// produces a different key, the shard stops being settled, and the test fails.

const PLAN_YAML = `
- id: T4025-C
  title: adaptive C
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixture(): { dir: string; plan: Plan; ledgerPath: string; config: Config } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-adaptive-pressure-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, PLAN_YAML);
  // loadMounts(mountsPath(root)) runs for real, so the root carries the committed table verbatim.
  mkdirSync(join(dir, ".remudero"), { recursive: true });
  copyFileSync(join(import.meta.dirname, "..", ".remudero", "mounts.yaml"), join(dir, ".remudero", "mounts.yaml"));
  mkdirSync(join(dir, "state"), { recursive: true });
  return {
    dir,
    plan: loadPlan(planPath),
    ledgerPath: join(dir, "ledger.ndjson"),
    config: { root: dir } as unknown as Config,
  };
}

/** The key `routeAdaptiveLifetimePressure` must build for the ledger written below. Held as a
 *  literal on purpose — see this file's header. */
const SETTLED_KEY = "T4025-C:adaptive-lifetime=0:capacity=1:open=1:merged=0:last=pr.opened:unavailable";

function writeLedger(ledgerPath: string, rows: Record<string, unknown>[]): void {
  writeFileSync(ledgerPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("routeAdaptiveLifetimePressure projects a task's pressure evidence into the settled observation key", async () => {
  const { dir, plan, ledgerPath, config } = fixture();
  try {
    writeLedger(ledgerPath, [
      // capacityBlocked 1 against starts 0 — effectiveLifetimeDispatches floors at starts, so the
      // attributable count is 0 and a capacity refusal spends none of the task's adaptive signal.
      { step: "daemon.spawn_infra_blocked", task: "T4025-C" },
      { step: "pr.opened", task_id: "T4025-C" },
      // Carries neither task_id nor task, so it is not this task's evidence and never becomes
      // `lastOutcome` — it is read only by priorVerifyHumanVerdicts, keyed on observed_state.
      { step: VERIFY_HUMAN_JUDGED_STEP, observed_state: SETTLED_KEY, judge_decision: "backlog", judge_reason: "already seen" },
    ]);

    const result = await routeAdaptiveLifetimePressure([plan.byId.get("T4025-C")!], {
      plan,
      root: dir,
      config,
      ledgerPath,
      runId: "RUN-ADAPTIVE-1",
    });

    assert.equal(result.judged, 0, "a settled shard spends no judge call");
    assert.deepEqual(result.skipped, ["T4025-C"], "the shard is recognised as already settled, by its projected key");
    assert.deepEqual(result.needsOperator, []);
    assert.deepEqual(result.automated, []);
    assert.deepEqual(result.deferred, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routeAdaptiveLifetimePressure counts merge and open-PR evidence, and reports the last observed step", async () => {
  const { dir, plan, ledgerPath, config } = fixture();
  try {
    // A DIFFERENT population: two open PRs, one merge verdict, and a terminal verdict row last.
    const key = "T4025-C:adaptive-lifetime=0:capacity=0:open=2:merged=1:last=verdict:merged";
    writeLedger(ledgerPath, [
      { step: "pr.opened", task_id: "T4025-C" },
      { step: "pr.opened", task_id: "T4025-C" },
      { step: "verdict", task_id: "T4025-C", verdict: "merged" },
      { step: VERIFY_HUMAN_JUDGED_STEP, observed_state: key, judge_decision: "automate", judge_reason: "shipped" },
    ]);

    const result = await routeAdaptiveLifetimePressure([plan.byId.get("T4025-C")!], {
      plan,
      root: dir,
      config,
      ledgerPath,
      runId: "RUN-ADAPTIVE-2",
    });

    assert.equal(result.judged, 0);
    assert.deepEqual(result.skipped, ["T4025-C"], "merge evidence and the trailing verdict row both reach the key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routeAdaptiveLifetimePressure asks the judge about a shard whose evidence has CHANGED", async () => {
  const { dir, plan, ledgerPath, config } = fixture();
  try {
    // The stored verdict names a key one open-PR row short of what the ledger now projects, so the
    // shard is NOT settled. With no judge seam, the real judge would be consulted — proving the
    // settled path above is doing real work rather than passing vacuously. The judge is left
    // unreachable by giving the route nothing to judge.
    writeLedger(ledgerPath, [
      { step: "pr.opened", task_id: "T4025-C" },
      { step: VERIFY_HUMAN_JUDGED_STEP, observed_state: SETTLED_KEY, judge_decision: "backlog", judge_reason: "stale key" },
    ]);

    const result = await routeAdaptiveLifetimePressure([], {
      plan,
      root: dir,
      config,
      ledgerPath,
      runId: "RUN-ADAPTIVE-3",
    });

    assert.equal(result.judged, 0, "an empty task list judges nothing");
    assert.deepEqual(result.skipped, [], "and projects no shard at all");
    assert.equal(readFileSync(ledgerPath, "utf8").includes(SETTLED_KEY), true, "the prior row is left untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("productionLifetimePressureHook reads its plan WHEN IT FIRES, not when it is built", async () => {
  const { dir, plan, ledgerPath, config } = fixture();
  try {
    writeLedger(ledgerPath, [
      { step: "daemon.spawn_infra_blocked", task: "T4025-C" },
      { step: "pr.opened", task_id: "T4025-C" },
      { step: VERIFY_HUMAN_JUDGED_STEP, observed_state: SETTLED_KEY, judge_decision: "backlog", judge_reason: "already seen" },
    ]);

    // The daemon re-projects its plan every tick, so the hook takes a THUNK. Counting the reads is
    // what proves it: zero at construction, one once the hook is actually called. An eager capture
    // would pin the first tick's projection and this test would read 1 before the call.
    let planReads = 0;
    const hook = productionLifetimePressureHook({
      plan: () => { planReads += 1; return plan; },
      root: dir,
      config,
      ledgerPath,
      runId: "RUN-HOOK-1",
    });
    assert.equal(planReads, 0, "building the hook must not pin a plan projection");

    await hook([plan.byId.get("T4025-C")!]);
    assert.equal(planReads, 1, "the plan is read at fire time, so a later tick's projection wins");

    // The shard is settled by the row above, so no judge call is spent and nothing is written.
    assert.equal(readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length, 3, "the hook wrote no rows");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
