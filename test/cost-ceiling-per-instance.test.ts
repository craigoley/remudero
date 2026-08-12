import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  loadPolicy,
  policyPath,
  resolveDailyCostCeiling,
  resolveDailyCostCeilingForInstance,
  resolveDailyCostCeilingInstanceShare,
  DAILY_COST_CEILING_SHARE_ENV_VAR,
  DAILY_COST_CEILING_INSTANCE_LABEL_ENV_VAR,
  type Policy,
} from "../src/lib/policy.js";
import { dailyCostCeilingReloader } from "../src/run-task.js";

// ── W1-T408 acceptance 1 ─────────────────────────────────────────────────────────────────────
// "the day-scoped ceiling is configurable per instance, so an operator running several can
// divide one number between them"
//
// plan/tasks.d/W1-T408's rationale is explicit that the fix is NOT cross-instance coordination
// (there is no shared dollar figure anywhere to coordinate against) — it is a per-instance knob
// the OPERATOR divides: two containers, each configured to 250, spend what one at the committed
// 500 used to spend alone. These tests prove that knob exists, is per-instance (env-scoped, not
// a shared file), and actually reaches the LIVE governor input `dailyCostCeilingReloader` feeds
// `costGovernorGateFor` (run-task.ts).

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED: Policy = loadPolicy(policyPath(REPO_ROOT));

test("W1-T408 acceptance 1 — resolveDailyCostCeilingInstanceShare reads a configured share off its own env var, separate from the committed default", () => {
  const share = resolveDailyCostCeilingInstanceShare(SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "250" });
  assert.ok(share, "a well-formed, in-bound share must resolve");
  assert.equal(share!.usd, 250);
  assert.notEqual(250, SHIPPED.values.sweep.dailyCostCeilingUsd, "fixture value must differ from the committed default to prove it is NOT just reading that row");
});

test("W1-T408 acceptance 1 — TWO instances configured with different shares of the SAME committed policy get DIFFERENT effective ceilings", () => {
  const root = "/irrelevant-for-this-test"; // no state/ override involved
  const instanceA = resolveDailyCostCeilingForInstance(root, SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "250" });
  const instanceB = resolveDailyCostCeilingForInstance(root, SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "150" });
  assert.equal(instanceA.usd, 250);
  assert.equal(instanceB.usd, 150);
  assert.notEqual(
    instanceA.usd,
    instanceB.usd,
    "each instance's OWN env divides the fleet ceiling independently — this is what makes the arithmetic true again (2 instances at 250+150=400 < one instance's own 500, not 2x500)",
  );
  assert.equal(instanceA.provenance, "instance-share");
  assert.equal(instanceB.provenance, "instance-share");
});

test("W1-T408 acceptance 1 — the share is READ FROM ENV, not from a shared file: two DIFFERENT env objects against the SAME root/policy never collide", () => {
  // Deliberately the SAME root and SAME policy for both reads — only env differs. If the share
  // were sourced from a file under `root` (like the state/ override), both reads would see the
  // SAME value; because it is env-scoped, they diverge, exactly mirroring two real containers
  // that share no state directory (plan/tasks.d/W1-T408: "the unit of isolation is the
  // INSTANCE, keyed off HOME").
  const sameRoot = "/tmp/not-actually-read";
  const a = resolveDailyCostCeilingForInstance(sameRoot, SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "100" });
  const b = resolveDailyCostCeilingForInstance(sameRoot, SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "400" });
  assert.equal(a.usd, 100);
  assert.equal(b.usd, 400);
});

test("W1-T408 acceptance 1 — a configured share is validated against the SAME committed sweep.dailyCostCeilingUsd bound the override store uses, never a second hand-copied {min, max}", () => {
  const bound = SHIPPED.bounds["sweep.dailyCostCeilingUsd"];
  assert.ok(bound, "fixture assumption: the shipped policy carries this bound");
  const tooHigh = resolveDailyCostCeilingInstanceShare(SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: String(bound.max + 1) });
  const tooLow = resolveDailyCostCeilingInstanceShare(SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: String(bound.min - 1) });
  assert.equal(tooHigh, undefined, "a share above the committed bound is refused (ignored), never clamped or accepted");
  assert.equal(tooLow, undefined, "a share below the committed bound is refused (ignored), never clamped or accepted");
  const inBound = resolveDailyCostCeilingInstanceShare(SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: String(bound.min) });
  assert.ok(inBound, "the bound's own min is itself in-bound and must resolve");
});

test("W1-T408 acceptance 1 — a configured share reaches THE LIVE GOVERNOR INPUT: dailyCostCeilingReloader's returned closure resolves to the per-instance share, not the committed default", () => {
  const deps = { policy: SHIPPED, env: { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "177" } };
  const reload = dailyCostCeilingReloader(deps);
  assert.equal(reload(), 177, "the SAME closure costGovernorGateFor consults for THE LIVE CEILING now reflects this instance's configured share");
  assert.notEqual(177, SHIPPED.values.sweep.dailyCostCeilingUsd, "fixture value must genuinely differ from the committed default it is overriding");
});

test("W1-T408 acceptance 1 — dailyCostCeilingReloader resolves the share fresh on EVERY call, exactly like it already does for `deps.policy` (W1-T331's own discipline, extended to env)", () => {
  const deps: { policy?: Policy; env?: NodeJS.ProcessEnv } = { policy: SHIPPED, env: { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "160" } };
  const reload = dailyCostCeilingReloader(deps);
  assert.equal(reload(), 160);
  deps.env = { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "180" };
  assert.equal(reload(), 180, "a share changed between two calls of the SAME reloader changes what it returns — never a value captured once at construction");
});

test("W1-T408 acceptance 1 — an operator can literally divide a committed ceiling in half across two instances and the two shares sum back to the original", () => {
  const committed = SHIPPED.values.sweep.dailyCostCeilingUsd;
  const half = committed / 2;
  const instanceA = resolveDailyCostCeilingForInstance("/root-a", SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: String(half) });
  const instanceB = resolveDailyCostCeilingForInstance("/root-b", SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: String(half) });
  assert.equal(instanceA.usd + instanceB.usd, committed, "two instances configured to divide the committed ceiling spend, in total, exactly what one instance used to spend alone");
});
