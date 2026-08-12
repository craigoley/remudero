import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  loadPolicy,
  policyPath,
  resolveDailyCostCeiling,
  resolveDailyCostCeilingForInstance,
  resolveDailyCostCeilingInstanceShare,
  writeDailyCostCeilingOverride,
  clearDailyCostCeilingOverride,
  DAILY_COST_CEILING_SHARE_ENV_VAR,
  type Policy,
} from "../src/lib/policy.js";
import { dailyCostCeilingReloader, resolveRepoRoot } from "../src/run-task.js";

// ── W1-T408 acceptance 3 ─────────────────────────────────────────────────────────────────────
// "an instance with no explicit share behaves exactly as it does today, so a single-instance
// operator sees no change"
//
// plan/tasks.d/W1-T408's note is explicit: "AN UNSET SHARE MUST BEHAVE EXACTLY AS TODAY. A
// single-instance operator must see no change of any kind ... The new knob is a DIVISION the
// operator opts into, never a new default." These tests pin that: with the env var absent,
// blank, or otherwise not a configured share, `resolveDailyCostCeilingForInstance` returns
// EXACTLY what `resolveDailyCostCeiling` already returned — same fields, same values, no new
// keys appearing — and the real, wired `dailyCostCeilingReloader` is unaffected too.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED: Policy = loadPolicy(policyPath(REPO_ROOT));

function overrideRoot(): string {
  return mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t408-default-unchanged-"));
}

test("W1-T408 acceptance 3 — resolveDailyCostCeilingInstanceShare returns undefined when the env var is simply absent", () => {
  assert.equal(resolveDailyCostCeilingInstanceShare(SHIPPED, {}), undefined);
});

test("W1-T408 acceptance 3 — resolveDailyCostCeilingInstanceShare returns undefined when the env var is blank/whitespace-only (an operator who half-configures it is treated as unset, not as a crash)", () => {
  assert.equal(resolveDailyCostCeilingInstanceShare(SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "" }), undefined);
  assert.equal(resolveDailyCostCeilingInstanceShare(SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "   " }), undefined);
});

test("W1-T408 acceptance 3 — resolveDailyCostCeilingForInstance with an unset share returns a value DEEP-EQUAL to resolveDailyCostCeiling's own reading (no new fields, no changed fields)", () => {
  const root = overrideRoot();
  try {
    const before = resolveDailyCostCeiling(root, SHIPPED);
    const after = resolveDailyCostCeilingForInstance(root, SHIPPED, {});
    assert.deepEqual(after, before, "byte-for-byte the same object shape and values — a single-instance operator sees NO change of any kind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T408 acceptance 3 — this holds even with a REAL state/ override in effect: an unset share never disturbs the override precedence rule this task did not touch", () => {
  const root = overrideRoot();
  try {
    writeDailyCostCeilingOverride(root, 900, SHIPPED);
    const before = resolveDailyCostCeiling(root, SHIPPED);
    const after = resolveDailyCostCeilingForInstance(root, SHIPPED, {});
    assert.deepEqual(after, before);
    assert.equal(after.usd, 900);
    assert.equal(after.provenance, "overridden", "provenance stays 'overridden', never 'instance-share', when no share is configured");
  } finally {
    clearDailyCostCeilingOverride(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T408 acceptance 3 — the REAL, wired dailyCostCeilingReloader is unaffected: with no env override supplied, it reads the checked-in plan/policy.yaml exactly as it did before this task", () => {
  const reload = dailyCostCeilingReloader();
  assert.equal(reload(), SHIPPED.values.sweep.dailyCostCeilingUsd);
});

test("W1-T408 acceptance 3 — dailyCostCeilingReloader with an explicit deps.env that carries no share var behaves identically to omitting deps.env entirely", () => {
  const withoutEnvDep = dailyCostCeilingReloader({ policy: SHIPPED });
  const withEmptyEnvDep = dailyCostCeilingReloader({ policy: SHIPPED, env: {} });
  assert.equal(withoutEnvDep(), withEmptyEnvDep());
  assert.equal(withEmptyEnvDep(), SHIPPED.values.sweep.dailyCostCeilingUsd);
});

test("W1-T408 acceptance 3 — a malformed share value (non-numeric, or out of the committed bound) is IGNORED, resolving exactly as unset — never a thrown error, never a clamp", () => {
  const root = overrideRoot();
  try {
    const before = resolveDailyCostCeiling(root, SHIPPED);
    const nonNumeric = resolveDailyCostCeilingForInstance(root, SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: "not-a-number" });
    const bound = SHIPPED.bounds["sweep.dailyCostCeilingUsd"];
    const outOfBound = resolveDailyCostCeilingForInstance(root, SHIPPED, { [DAILY_COST_CEILING_SHARE_ENV_VAR]: String(bound!.max * 10) });
    assert.deepEqual(nonNumeric, before);
    assert.deepEqual(outOfBound, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T408 acceptance 3 — resolveRepoRoot construction used by real production callers is untouched by this task (sanity: the reloader's root resolution is orthogonal to the share)", () => {
  const root = resolveRepoRoot(process.argv.slice(2), process.cwd());
  assert.equal(typeof root, "string");
  assert.ok(root.length > 0);
});
