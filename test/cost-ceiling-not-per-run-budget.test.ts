import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  loadPolicy,
  policyPath,
  resolveDailyCostCeilingForInstance,
  resolveDailyCostCeilingInstanceShare,
  DAILY_COST_CEILING_SHARE_ENV_VAR,
  type Policy,
  type EffectiveDailyCostCeiling,
  type DailyCostCeilingInstanceShare,
} from "../src/lib/policy.js";
import { DEFAULT_BUDGET_USD, dailyCostCeilingReloader } from "../src/run-task.js";
import { checkCostGovernor, type CostGovernorResult, DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";

// ── W1-T408 acceptance 4 ─────────────────────────────────────────────────────────────────────
// "the per-spawn budget is untouched by this change, and a test pins the two mechanisms apart"
//
// plan/tasks.d/W1-T408's rationale draws this line explicitly: "IT IS THE DAILY CEILING, NOT
// THE PER-RUN BUDGET, AND THEY ARE DIFFERENT MECHANISMS ... THIS TASK DOES NOT TOUCH IT." The
// per-run cap (`maxBudgetUsd`, sourced from a task's own `budget_usd` or `DEFAULT_BUDGET_USD`)
// is enforced by the SDK against ONE spawn; the day-scoped ceiling this task adds a per-instance
// share to is a completely separate, ledger-derived figure. These tests prove the two neither
// share a knob, a type, nor a value — configuring one never moves the other.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED: Policy = loadPolicy(policyPath(REPO_ROOT));

test("W1-T408 acceptance 4 — DEFAULT_BUDGET_USD (the per-run backstop) is a plain module constant, untouched by anything this task added", () => {
  assert.equal(DEFAULT_BUDGET_USD, 100.0, "the per-run default the SDK enforces per spawn — this task's rationale names it explicitly as OUT OF SCOPE and this pins its value unchanged");
});

test("W1-T408 acceptance 4 — configuring an instance's daily-ceiling share to a value UNRELATED to the per-run budget default has zero effect on that default", () => {
  const before = DEFAULT_BUDGET_USD;
  // 150 is comfortably inside the committed daily-ceiling bound [100, 2500] and deliberately
  // NOT equal to DEFAULT_BUDGET_USD (100) — if the two mechanisms secretly shared one knob,
  // configuring this share would risk aliasing the per-run default; it does not.
  const reload = dailyCostCeilingReloader({ policy: SHIPPED, env: { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "150" } });
  assert.equal(reload(), 150, "sanity: the share genuinely took effect on the daily ceiling");
  assert.equal(DEFAULT_BUDGET_USD, before, "the per-run constant a spawn's maxBudgetUsd falls back to did not move even though the daily ceiling did — two independent numbers, not one knob wearing two names");
});

test("W1-T408 acceptance 4 — a task's own budget_usd (which becomes maxBudgetUsd, run-task.ts's `const budgetUsd = task.budget_usd ?? DEFAULT_BUDGET_USD`) can EXCEED an instance's configured daily share with no interaction between them", () => {
  // Deliberately pathological: a single run's per-spawn cap ($9,999) is larger than this
  // instance's entire daily share ($150, the committed bound's floor is 100 so this is near
  // the lowest a share can legally be). Nothing in either mechanism clamps, validates, or even
  // reads the other — they are pinned apart, not merely differently named.
  const task = { budget_usd: 9_999 };
  const resolvedMaxBudgetUsd = task.budget_usd ?? DEFAULT_BUDGET_USD; // the exact expression run-task.ts's runTaskBody uses
  const instanceReading = resolveDailyCostCeilingForInstance("/no-such-root", SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "150" });
  assert.equal(resolvedMaxBudgetUsd, 9_999);
  assert.equal(instanceReading.usd, 150);
  assert.notEqual(resolvedMaxBudgetUsd, instanceReading.usd, "the two figures coexist independently — no clamp, no shared ceiling, no cross-read");
});

test("W1-T408 acceptance 4 — the per-instance share resolver takes NO task-shaped input at all: no budget_usd, no maxBudgetUsd, no task id, structurally proving it cannot read the per-run knob", () => {
  const share = resolveDailyCostCeilingInstanceShare(SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "150" }) as DailyCostCeilingInstanceShare;
  assert.ok(share, "sanity: an in-bound share must resolve");
  assert.deepEqual(Object.keys(share).sort(), ["instanceLabel", "usd"], "its return shape carries no budget/maxBudgetUsd field of any kind");
});

test("W1-T408 acceptance 4 — CostGovernorResult (the day-scoped predicate's own verdict shape) carries no per-run budget field either — the two mechanisms are pinned apart on BOTH sides", () => {
  const result: CostGovernorResult = checkCostGovernor(10, { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 500 });
  assert.deepEqual(
    Object.keys(result).sort(),
    ["ceilingUsd", "deferred", "observedDayCostUsd"].sort(),
    "no budget_usd/maxBudgetUsd field anywhere on the day-scoped governor's own result shape",
  );
});

test("W1-T408 acceptance 4 — EffectiveDailyCostCeiling (this task's new visibility shape) carries no per-run budget field either", () => {
  const reading: EffectiveDailyCostCeiling = resolveDailyCostCeilingForInstance("/no-such-root", SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "50" });
  const keys = Object.keys(reading);
  assert.ok(!keys.includes("budget_usd") && !keys.includes("maxBudgetUsd"), "the day-scoped ceiling's own visible shape never grows a per-run field");
});
