// W1-T11175: the plan-reconcile landing refused every write set from 2026-10-27, because flipping an
// operator-released shard from queued to merged read as a changed approved contract.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { operatorReleaseContractChanged, operatorReleasePin, RELEASE_LIFECYCLE_STATUSES } from "#src/lib/operator-release.js";
import { buildMeasurementCadenceRow, buildPlanReconcileCadenceInput, planReconcileCadence, planReconcileLintHold, type PlanReconcileLint } from "#src/lib/measurement-cadence.js";
import { planReconcileLanding } from "#src/lib/feedback-landing.js";
import { loadPlan, mergePlanBlobs, TASK_STATUSES, type Task } from "#src/lib/plan.js";
import { reconcilePlan } from "#src/lib/plan-reconcile.js";
import { lintPlan } from "#src/lib/task-linter.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const PLAN_DIR = join(REPO_ROOT, "plan");
const SHARD_DIR = join(PLAN_DIR, "tasks.d");
const PINNED_FLIP_SET = ["W1-T10431", "W1-T10787", "W1-T10829", "W1-T10874", "W1-T10898", "W1-T10917", "W1-T10942", "W1-T10970"];
const STATUS_LINE = /^ {2}status: \S+[ \t]*$/m;

type Shard = { taskId: string; path: string; text: string };

function mainShards(): Shard[] {
  const out: Shard[] = [];
  for (const name of readdirSync(SHARD_DIR).sort()) {
    if (!name.endsWith(".yaml")) continue;
    const path = join(SHARD_DIR, name);
    const text = readFileSync(path, "utf8");
    const id = text.match(/^- id: (\S+)/m)?.[1];
    if (id) out.push({ taskId: id, path, text });
  }
  assert.ok(out.length > 1000, `read only ${out.length} shard(s) from ${SHARD_DIR}`);
  return out;
}

/** Each named shard as it read before its build merged: `status: queued`, whatever main says now. */
function asQueued(shards: Shard[], ids: readonly string[]): Shard[] {
  const wanted = new Set(ids);
  return shards.map((s) => (wanted.has(s.taskId) ? { ...s, text: s.text.replace(STATUS_LINE, "  status: queued") } : s));
}

/** The whole plan on main, every shard file the loader reads, with `shards` read in place of their files. */
function planOf(shards: readonly Shard[]) {
  const monolith = join(PLAN_DIR, "tasks.yaml");
  const byPath = new Map(shards.map((s) => [s.path, s.text]));
  const files = readdirSync(SHARD_DIR).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => join(SHARD_DIR, f));
  return mergePlanBlobs([{ label: monolith, text: readFileSync(monolith, "utf8") }, ...files.map((path) => ({ label: path, text: byPath.get(path) ?? readFileSync(path, "utf8") }))]);
}

function blockingRules(plan: ReturnType<typeof planOf>, ids: ReadonlySet<string>): Map<string, Set<string>> {
  const results = lintPlan(plan, () => ({}), ids);
  return new Map([...ids].map((id) => [id, new Set((results.get(id)?.violations ?? []).filter((v) => v.severity === "block").map((v) => v.check))]));
}

function pinnedTask(id: string): Task {
  const task = loadPlan(join(PLAN_DIR, "tasks.yaml")).byId.get(id);
  assert.ok(task, `${id} is on main`);
  assert.match(task!.risk_ruling?.operator_release_pin ?? "", /^[0-9a-f]{64}$/, `${id} carries an operator release pin`);
  return { ...task!, status: "queued" };
}

test("W1-T11175 criterion 1: a status flip leaves an operator release pin valid, and a contract edit does not", () => {
  assert.deepEqual([...RELEASE_LIFECYCLE_STATUSES], [...TASK_STATUSES], "the release pin's status set mirrors plan.ts's");
  for (const id of ["W1-T10431", "W1-T10970"]) {
    const onMain = pinnedTask(id);
    const writtenAfter: Task = { ...onMain, risk_ruling: { ...onMain.risk_ruling!, operator_release_pin: operatorReleasePin(onMain) } };
    for (const [label, task] of [["the pin on main", onMain], ["a pin written by this build", writtenAfter]] as const) {
      assert.equal(operatorReleaseContractChanged(task), false, `${id}, ${label}, as queued`);
      for (const status of TASK_STATUSES) {
        assert.equal(operatorReleaseContractChanged({ ...task, status }), false, `${id}, ${label}: status ${status} is bookkeeping`);
      }
      const merged: Task = { ...task, status: "merged" };
      const edits: Array<[string, Task]> = [
        ["title", { ...merged, title: `${merged.title} (edited)` }],
        ["files", { ...merged, files: [...(merged.files ?? []), "src/lib/an-added-file.ts"] }],
        ["acceptance", { ...merged, acceptance: [...(merged.acceptance ?? []), { claim: "an added claim", proof: "grep: added in src/lib/plan.ts" }] }],
        ["design", { ...merged, design: `${merged.design ?? ""}\nan added design step` }],
      ];
      for (const [field, edited] of edits) {
        assert.equal(operatorReleaseContractChanged(edited), true, `${id}, ${label}: an edit to ${field} still reads changed`);
      }
    }
  }
});

test("W1-T11175 criterion 2: reconciling every shard on main with the pinned flip set adds no blocking operator-release-contract violation", () => {
  const shards = asQueued(mainShards(), PINNED_FLIP_SET);
  const credited = new Set(PINNED_FLIP_SET);
  const { writes } = reconcilePlan(shards, (id) => credited.has(id));
  assert.deepEqual(writes.map((w) => w.taskId).sort(), [...PINNED_FLIP_SET].sort(), "every pinned shard is in the write set");
  const written = new Map(writes.map((w) => [w.taskId, w.text]));
  const ids = new Set(written.keys());
  const before = blockingRules(planOf(shards), ids);
  const after = blockingRules(planOf(shards.map((s) => ({ ...s, text: written.get(s.taskId) ?? s.text }))), ids);
  for (const id of ids) {
    assert.ok(!after.get(id)!.has("operator-release-contract"), `${id}'s flip reads as a changed operator contract`);
    const gained = [...after.get(id)!].filter((rule) => !before.get(id)!.has(rule));
    assert.deepEqual(gained, [], `${id}'s flip makes its shard newly violate, so the shard census would grow`);
  }
  const production = planReconcileLintHold()(REPO_ROOT, shards, writes);
  assert.deepEqual(production.held, [], "the production hold, linting as the shard census does, holds none of them");
  assert.equal(production.landable.length, PINNED_FLIP_SET.length);
});

test("W1-T11175 criterion 3: the production landing lands every lint-clean flip, holds the rest by rule, and still throws on any other refusal", () => {
  const all = mainShards();
  const others = all.filter((s) => /^ {2}status: queued[ \t]*$/m.test(s.text) && !/^ {2}retirement:/m.test(s.text) && !PINNED_FLIP_SET.includes(s.taskId)).slice(0, 3).map((s) => s.taskId);
  assert.equal(others.length, 3, "three more queued shards to reach the landing threshold");
  const flipSet = [...PINNED_FLIP_SET, ...others];
  const shards = asQueued(all, flipSet);
  const victim = others[0];
  const realLint: PlanReconcileLint = (plan, only) => lintPlan(plan, () => ({}), only);
  const victimBreaksOnMerge: PlanReconcileLint = (plan, only, root) => {
    const results = realLint(plan, only, root);
    const task = plan.byId.get(victim);
    if (task?.status === "merged") {
      const prior = results.get(victim) ?? { ok: true, violations: [] };
      results.set(victim, { ok: false, violations: [...prior.violations, { check: "operator-release-contract", severity: "block", message: "fixture" }] });
    }
    return results;
  };
  // buildPlanReconcileProductionInput's own composition, built here because one more importer of the CLI
  // entry grows the affected-suite reach ratchet; only its land bridge and the lint are injected.
  const build = (lint: PlanReconcileLint, landed: string[][], refusal?: string) => {
    const landing = planReconcileLanding(REPO_ROOT, () => ({}), (_root, inputs) => {
      landed.push(inputs.map((i) => i.relPath));
      return refusal ? { landed: false, files: [], error: refusal } : { landed: true, files: inputs.map((i) => i.relPath) };
    });
    return buildPlanReconcileCadenceInput({ checkoutRoot: REPO_ROOT, readShards: () => shards, creditedMergedIds: () => new Set(flipSet), land: landing.land, lint });
  };

  const landed: string[][] = [];
  const report = planReconcileCadence(build(victimBreaksOnMerge, landed));
  assert.equal(report.drift, flipSet.length);
  assert.equal(report.status, "landed");
  assert.deepEqual(report.held, [{ taskId: victim, rule: "operator-release-contract" }]);
  assert.equal(landed.length, 1, "one landing for the landable flips");
  const pathOf = new Map(shards.map((s) => [s.taskId, s.path.slice(REPO_ROOT.length + 1)]));
  assert.deepEqual(landed[0].sort(), flipSet.filter((id) => id !== victim).map((id) => pathOf.get(id)!).sort());
  const row = buildMeasurementCadenceRow({ planReconcile: report } as Parameters<typeof buildMeasurementCadenceRow>[0]);
  assert.deepEqual((row.plan_reconcile as { held?: unknown }).held, [{ taskId: victim, rule: "operator-release-contract" }], "the ran row names each held task and its rule");

  const everyFlipBreaks: PlanReconcileLint = (plan, only, root) => {
    const results = realLint(plan, only, root);
    for (const id of only) if (plan.byId.get(id)?.status === "merged") results.set(id, { ok: false, violations: [{ check: "operator-release-contract", severity: "block", message: "fixture" }] });
    return results;
  };
  const none: string[][] = [];
  const allHeld = planReconcileCadence(build(everyFlipBreaks, none));
  assert.equal(allHeld.status, "reported", "zero landable writes is reported, not thrown");
  assert.equal(allHeld.held?.length, flipSet.length);
  assert.deepEqual(none, [], "nothing reaches the landing bridge");

  assert.throws(() => planReconcileCadence(build(realLint, [], "simulated preflight refusal")), /simulated preflight refusal/, "W1-T9695: any other refusal still throws");
});
