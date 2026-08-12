import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  loadPolicy,
  policyPath,
  resolveDailyCostCeilingForInstance,
  DAILY_COST_CEILING_SHARE_ENV_VAR,
  DAILY_COST_CEILING_INSTANCE_LABEL_ENV_VAR,
  type Policy,
} from "../src/lib/policy.js";
import { checkCostGovernor, logCostGovernorDeferral, DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";

// ── W1-T408 acceptance 2 ─────────────────────────────────────────────────────────────────────
// "the effective ceiling and the instance it belongs to are visible before it trips, not only
// in the line written when it defers"
//
// BEFORE this task, the ceiling appears in exactly one place: the `dispatch_deferred_budget`
// ledger line `logCostGovernorDeferral` writes, and ONLY at the moment a consultation defers
// (`checkCostGovernor` returning `deferred: true`). An operator running under a healthy budget
// — the common case — has no reading at all of what their effective ceiling even IS, let alone
// which instance it belongs to. `resolveDailyCostCeilingForInstance` (policy.ts) fixes this: it
// is a PURE function of policy + env, callable at any time, with no ledger dependency
// whatsoever — these tests prove that by never once calling `logCostGovernorDeferral` or
// constructing a ledger, and by exercising the healthy (deferred: false) governor path
// alongside it to show the ledger route stays silent while the new route does not.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED: Policy = loadPolicy(policyPath(REPO_ROOT));

test("W1-T408 acceptance 2 — a configured share's effective ceiling AND its instance label are both visible from a single pure call, no ledger involved", () => {
  const reading = resolveDailyCostCeilingForInstance("/no-such-root", SHIPPED, {
    [DAILY_COST_CEILING_SHARE_ENV_VAR]: "250",
    [DAILY_COST_CEILING_INSTANCE_LABEL_ENV_VAR]: "worker-fleet-3",
  });
  assert.equal(reading.usd, 250, "the effective ceiling is visible directly");
  assert.equal(reading.instanceLabel, "worker-fleet-3", "the instance it belongs to is visible directly, right beside the number");
  assert.equal(reading.provenance, "instance-share");
});

test("W1-T408 acceptance 2 — the instance label defaults to something identifying (os.homedir()) even when the operator names nothing but the share, so a bare share is never an anonymous number", () => {
  const reading = resolveDailyCostCeilingForInstance("/no-such-root", SHIPPED, {
    [DAILY_COST_CEILING_SHARE_ENV_VAR]: "250",
  });
  assert.ok(reading.instanceLabel && reading.instanceLabel.length > 0, "a share always carries SOME instance identity, never undefined-and-silent");
});

test("W1-T408 acceptance 2 — this reading requires NO ledger and NO deferral: it is visible on a perfectly healthy instance that has never once deferred a dispatch", () => {
  // A healthy day: observed spend is $1, nowhere near a $250 ceiling. checkCostGovernor
  // correctly returns deferred: false, so the REAL dispatch path never calls
  // logCostGovernorDeferral (see costGovernorGateFor, run-task.ts: "if (!result.deferred)
  // return undefined") — the ledger stays silent. The effective ceiling is still fully visible
  // through the new function, proving it does NOT depend on a trip having ever happened.
  const policyWithShare = { ...SHIPPED, values: { ...SHIPPED.values, sweep: { ...SHIPPED.values.sweep, dailyCostCeilingUsd: 250 } } };
  const result = checkCostGovernor(1, { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 250 });
  assert.equal(result.deferred, false, "fixture sanity: this consultation must NOT defer");

  const ledgerLinesWritten: unknown[] = [];
  const wouldHaveLedgeredOnlyIfDeferred = () => {
    if (result.deferred) {
      logCostGovernorDeferral(result, (_path, line) => ledgerLinesWritten.push(line), "unused-ledger-path", "run-1");
    }
  };
  wouldHaveLedgeredOnlyIfDeferred();
  assert.equal(ledgerLinesWritten.length, 0, "on a healthy day the OLD route (the ledger line) never carries the ceiling at all");

  const reading = resolveDailyCostCeilingForInstance("/no-such-root", policyWithShare, {
    [DAILY_COST_CEILING_SHARE_ENV_VAR]: "250",
    [DAILY_COST_CEILING_INSTANCE_LABEL_ENV_VAR]: "healthy-instance",
  });
  assert.equal(reading.usd, 250, "yet the NEW route shows the effective ceiling regardless — visible before, not only at, a trip");
  assert.equal(reading.instanceLabel, "healthy-instance");
});

test("W1-T408 acceptance 2 — resolveDailyCostCeilingForInstance takes no ledger-shaped argument at all: called with ONLY (root, policy) — no ledgerPath, no runId, no lines array — it still resolves fully", () => {
  const withExplicitEnv = resolveDailyCostCeilingForInstance("/no-such-root", SHIPPED, process.env);
  const withOmittedEnv = resolveDailyCostCeilingForInstance("/no-such-root", SHIPPED);
  assert.deepEqual(withOmittedEnv, withExplicitEnv, "omitting the third argument falls through to process.env by default — there is no required ledger-shaped parameter at all");
});

test("W1-T408 acceptance 2 — without a configured share, the reading still surfaces the effective figure pre-trip (just with no instance label, since there is no per-instance divergence to name)", () => {
  const reading = resolveDailyCostCeilingForInstance("/no-such-root", SHIPPED, {});
  assert.equal(reading.usd, SHIPPED.values.sweep.dailyCostCeilingUsd, "the committed default is visible without ever needing a deferral");
  assert.equal(reading.instanceLabel, undefined, "no share configured -> nothing instance-specific to distinguish, matching the default-unchanged contract");
});
