import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Escalation } from "../src/lib/escalate.js";
import { loadPlan, loadPlanQuarantiningDuplicates, PlanError } from "../src/lib/plan.js";
import { withTempDir } from "../src/lib/tmp.js";
import { loadDaemonPlan } from "../src/run-task.js";

// W1-T4409 — on 2026-09-23 a CONSOLE-T60 declared by two shards made the console daemon exit at boot
// for three hours, and the daemon that would have merged the fold PR was the one down.

function task(id: string, dependsOn: string[] = []): string {
  return `- id: ${id}\n  title: task ${id}\n  repo: remudero-console\n  type: implement\n  depends_on: [${dependsOn.join(", ")}]\n  status: queued\n`;
}

/** A monolith plus shards where C-T60 is declared twice and C-T61 depends on it. */
function writeCollidingPlan(dir: string): string {
  const plan = join(dir, "tasks.yaml");
  writeFileSync(plan, task("C-T1") + task("C-T2", ["C-T1"]));
  mkdirSync(join(dir, "tasks.d"));
  writeFileSync(join(dir, "tasks.d", "C-T60-first.yaml"), task("C-T60"));
  writeFileSync(join(dir, "tasks.d", "C-T60-second.yaml"), task("C-T60"));
  writeFileSync(join(dir, "tasks.d", "C-T61-after.yaml"), task("C-T61", ["C-T60"]));
  writeFileSync(join(dir, "tasks.d", "C-T62-unrelated.yaml"), task("C-T62"));
  return plan;
}

test("a plan with a duplicate id loads with both declarations quarantined and every other task intact", async () => {
  await withTempDir("dup-plan", (dir) => {
    const path = writeCollidingPlan(dir);
    const { plan, quarantined } = loadPlanQuarantiningDuplicates(path);

    assert.deepEqual(
      plan.tasks.map((t) => t.id),
      ["C-T1", "C-T2", "C-T62"],
    );
    assert.equal(plan.byId.has("C-T60"), false, "neither declaration of the duplicate stays in the plan");
    assert.deepEqual(quarantined, [
      {
        id: "C-T60",
        files: [join(dir, "tasks.d", "C-T60-first.yaml"), join(dir, "tasks.d", "C-T60-second.yaml")],
        reason: "duplicate_id",
      },
      { id: "C-T61", files: [join(dir, "tasks.d", "C-T61-after.yaml")], reason: "depends_on_quarantined" },
    ]);
  });
});

test("a clean plan loads unchanged through the quarantining loader", async () => {
  await withTempDir("dup-plan-clean", (dir) => {
    const path = join(dir, "tasks.yaml");
    writeFileSync(path, task("C-T1") + task("C-T2", ["C-T1"]));
    const { plan, quarantined } = loadPlanQuarantiningDuplicates(path);
    assert.deepEqual(quarantined, []);
    assert.deepEqual(plan.tasks.map((t) => t.id), loadPlan(path).tasks.map((t) => t.id));
  });
});

test("the quarantining loader still refuses a dependency no file declares", async () => {
  await withTempDir("dup-plan-unknown-dep", (dir) => {
    const path = join(dir, "tasks.yaml");
    writeFileSync(path, task("C-T1", ["C-T404"]));
    assert.throws(() => loadPlanQuarantiningDuplicates(path), /depends_on unknown task 'C-T404'/);
  });
});

test("loadPlan itself still refuses a duplicate id", async () => {
  await withTempDir("dup-plan-strict", (dir) => {
    const path = writeCollidingPlan(dir);
    assert.throws(
      () => loadPlan(path),
      (e: unknown) => e instanceof PlanError && /duplicate task id 'C-T60'/.test(e.message),
    );
  });
});

test("the daemon keeps sweeping with a quarantined duplicate and escalates it once", async () => {
  await withTempDir("dup-plan-daemon", (dir) => {
    const path = writeCollidingPlan(dir);
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const raised: Escalation[] = [];

    const plan = loadDaemonPlan(
      path,
      (step, extra) => rows.push({ step, extra }),
      (e) => {
        raised.push(e);
        return "https://github.com/craigoley/remudero-console/issues/1";
      },
    );

    assert.deepEqual(plan.tasks.map((t) => t.id), ["C-T1", "C-T2", "C-T62"], "the daemon gets a plan to run");
    assert.deepEqual(raised.map((e) => e.taskId), ["C-T60"], "one escalation for the duplicate, none for its dependent");
    assert.equal(raised[0]!.recommendation, "remove-duplicate");
    assert.match(raised[0]!.detail, /C-T60-first\.yaml[\s\S]*C-T60-second\.yaml/);
    assert.deepEqual(
      rows.map((r) => [r.step, r.extra?.id]),
      [
        ["plan.duplicate_quarantined", "C-T60"],
        ["plan.duplicate_escalated", "C-T60"],
        ["plan.duplicate_quarantined", "C-T61"],
      ],
    );
  });
});

test("a failed escalation is ledgered and the daemon still gets its plan", async () => {
  await withTempDir("dup-plan-escalation-fails", (dir) => {
    const path = writeCollidingPlan(dir);
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const plan = loadDaemonPlan(
      path,
      (step, extra) => rows.push({ step, extra }),
      () => {
        throw new Error("gh unreachable");
      },
    );
    assert.equal(plan.byId.has("C-T62"), true);
    const failed = rows.find((r) => r.step === "plan.duplicate_escalation_failed");
    assert.deepEqual(failed?.extra, { id: "C-T60", reason: "gh unreachable" });
  });
});
