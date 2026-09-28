// W1-T3878 acceptance: "missing, stale, expired, revoked, and over-budget profiles produce distinct
// refusals". Each is refused under its own code, at the pure eligibility seam AND through the
// operator-agent execution path, where the refusal enters the action's own preflight.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { evaluateAutomationAction, type AutomationActionReceipt } from "../src/lib/automation-action.js";
import { delegationEligibility, delegationLifecycleState, delegationProfileStatus } from "../src/lib/delegation-profile.js";
import { OPERATOR_AGENT_ACTION_RECEIPT_STEP } from "../src/lib/operator-agent.js";
import {
  actionBody,
  at,
  builtProfile,
  CLOCK,
  DAY,
  DELEGATION_ID,
  HEALTHY,
  HOUR,
  issueAndAccept,
  MINUTE,
  NOW_MS,
  postJson,
  readProfiles,
  rowsAt,
  stateOf,
  tempStatePath,
  validAction,
  withDelegationService,
} from "./helpers/delegation-profile-fixture.js";

const codesFor = (input: Parameters<typeof delegationEligibility>[0]) => delegationEligibility(input).map((finding) => finding.code);

test("W1-T3878: missing, stale, expired, revoked, and over-budget profiles produce distinct refusals", () => {
  const profile = builtProfile();
  const action = validAction();
  const refusals = {
    missing: codesFor({ state: undefined, action, clock: CLOCK }),
    stale: codesFor({ state: stateOf(profile, { supersededBy: `${DELEGATION_ID}@r2`, supersededAt: at(0) }), action, clock: CLOCK }),
    expired: codesFor({ state: stateOf(profile), action, clock: fixedClock(NOW_MS + 7 * DAY) }),
    revoked: codesFor({ state: stateOf(profile, { revokedAt: at(0), revokedReason: "revoked by operator" }), action, clock: CLOCK }),
    overDuration: codesFor({ state: stateOf(profile, { acceptedAt: at(-241 * MINUTE) }), action, clock: CLOCK }),
    overCost: codesFor({ state: stateOf(profile, { spentCostUsd: 20 }), action, estimatedCostUsd: 6, clock: CLOCK }),
  };
  assert.deepEqual(refusals, {
    missing: ["delegation-profile-missing"],
    stale: ["delegation-profile-stale"],
    expired: ["delegation-profile-expired"],
    revoked: ["delegation-profile-revoked"],
    overDuration: ["delegation-profile-over-budget"],
    overCost: ["delegation-profile-over-budget"],
  });
  assert.equal(new Set(Object.values(refusals).flat()).size, 5, "five distinct refusal codes");
  assert.deepEqual(codesFor({ state: stateOf(profile, { spentCostUsd: 20 }), action, estimatedCostUsd: 5, clock: CLOCK }), [], "exactly spending the budget is allowed");
  assert.deepEqual(codesFor({ state: stateOf(profile, { acceptedAt: at(-240 * MINUTE) }), action, clock: CLOCK }), [], "exactly the duration budget is allowed");
  assert.deepEqual(codesFor({ state: stateOf(profile, { approval: "pending", decidedAt: undefined, acceptedAt: undefined }), action, clock: CLOCK }), ["delegation-profile-not-approved"]);
  const denied = stateOf(profile, { approval: "denied", acceptedAt: undefined, revokedAt: at(0) });
  assert.deepEqual(codesFor({ state: denied, action, clock: CLOCK }), ["delegation-profile-revoked"], "a profile revoked before acceptance is denied, and refused as revoked");
  assert.equal(delegationProfileStatus(denied, CLOCK), "denied");
  assert.deepEqual(["pending", "active", "denied", "revoked", "superseded", "expired"].map((status) => delegationLifecycleState(status as "active")), ["active", "active", "revoked", "revoked", "revoked", "expired"]);
});

test("W1-T3878: the delegated execution path refuses by profile and admits only within budget", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    assert.equal((await postJson(base, "/v1/operator-agent/actions", { action: actionBody() })).status, 201);
    const missing = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary", observations: HEALTHY, delegationId: DELEGATION_ID });
    assert.equal(missing.status, 409);
    assert.equal((missing.body.receipt as AutomationActionReceipt).code, "delegation-profile-missing");
    assert.equal((missing.body.receipt as AutomationActionReceipt).preflight, "refused");

    await issueAndAccept(base);
    const preflight = await postJson(base, "/v1/operator-agent/actions/preflight", { actionId: "action:deploy:canary", observations: HEALTHY, delegationId: DELEGATION_ID, estimatedCostUsd: 26 });
    assert.equal(preflight.status, 200);
    assert.deepEqual((preflight.body.preflight as { findings: Array<{ code: string }> }).findings.map((finding) => finding.code), ["delegation-profile-over-budget"]);
    assert.equal((await postJson(base, "/v1/operator-agent/actions/preflight", { actionId: "action:deploy:canary", observations: HEALTHY }).then((r) => (r.body.preflight as { outcome: string }).outcome)), "ready", "an operator request names no delegation");

    const admitted = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary", observations: HEALTHY, delegationId: DELEGATION_ID, estimatedCostUsd: 20 });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    const usage = rowsAt(path).filter((row) => row.step === OPERATOR_AGENT_ACTION_RECEIPT_STEP && row.delegation_id === DELEGATION_ID);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.delegation_cost_usd, 20);
    assert.equal((await readProfiles(base))[0]?.spentCostUsd, 20);

    const second = actionBody({ actionId: "action:deploy:canary:2", idempotencyKey: "idem:deploy:canary:2" });
    assert.equal((await postJson(base, "/v1/operator-agent/actions", { action: second })).status, 201);
    const overBudget = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary:2", observations: HEALTHY, delegationId: DELEGATION_ID, estimatedCostUsd: 6 });
    assert.equal(overBudget.status, 409);
    assert.equal((overBudget.body.receipt as AutomationActionReceipt).code, "delegation-profile-over-budget");
    const free = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary:2", observations: HEALTHY, delegationId: DELEGATION_ID, dryRun: true });
    assert.equal(free.status, 200, "a dry run with no declared cost fits the remaining budget");
    assert.equal(free.body.disposition, "dry-run");
    assert.equal((await readProfiles(base))[0]?.spentCostUsd, 20, "a dry run charges nothing");

    const revoked = await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: DELEGATION_ID, decision: "revoked", note: "Budget review." });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.lifecycleState, "revoked");
    const afterRevoke = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary:2", observations: HEALTHY, delegationId: DELEGATION_ID });
    assert.equal((afterRevoke.body.receipt as AutomationActionReceipt).code, "delegation-profile-revoked");
    const [profile] = await readProfiles(base);
    assert.deepEqual(profile?.revocation, { reason: "Budget review.", revokedAt: CLOCK.iso() });

    assert.equal((await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary", delegationId: "" })).status, 400);
    assert.equal((await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary", delegationId: DELEGATION_ID, estimatedCostUsd: -1 })).status, 400);
    assert.equal((await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary", delegationId: DELEGATION_ID, estimatedCostUsd: "5" })).status, 400);
  });
});

test("W1-T3878: an expired or superseded profile refuses the execution path under its own code", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    await issueAndAccept(base, { expiresAt: at(HOUR) });
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: DELEGATION_ID })).status, 201);
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: `${DELEGATION_ID}@r2`, decision: "accepted" })).status, 200);
    assert.equal((await postJson(base, "/v1/operator-agent/actions", { action: actionBody() })).status, 201);
    const stale = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary", observations: HEALTHY, delegationId: DELEGATION_ID });
    assert.equal((stale.body.receipt as AutomationActionReceipt).code, "delegation-profile-stale");
  });
  await withDelegationService(path, async (base) => {
    const [replacement] = (await readProfiles(base)).filter((profile) => profile.delegationId === `${DELEGATION_ID}@r2`);
    assert.equal(replacement?.lifecycleState, "expired");
    const later = actionBody({ actionId: "action:deploy:canary:later", idempotencyKey: "idem:later", createdAt: at(HOUR), expiresAt: at(3 * HOUR) });
    assert.equal((await postJson(base, "/v1/operator-agent/actions", { action: later })).status, 201);
    const expired = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary:later", observations: [], delegationId: `${DELEGATION_ID}@r2` });
    assert.equal(expired.status, 409);
    assert.equal((expired.body.receipt as AutomationActionReceipt).code, "delegation-profile-expired", "the profile refusal outranks the missing observation");
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: `${DELEGATION_ID}@r2`, decision: "revoked" })).status, 200, "an expired profile can still be revoked");
  }, NOW_MS + 2 * HOUR);
});

test("W1-T3878: evaluateAutomationAction treats every eligibility finding as a refusal", () => {
  const action = validAction();
  const clean = evaluateAutomationAction({ action, observations: HEALTHY, receipts: [], clock: CLOCK, eligibility: [] });
  assert.equal(clean.disposition, "admitted");
  const smuggled = evaluateAutomationAction({ action, observations: HEALTHY, receipts: [], clock: CLOCK, eligibility: [{ outcome: "stale", code: "delegation-profile-stale", detail: "superseded" }] });
  assert.equal(smuggled.disposition, "refused");
  assert.equal(smuggled.receipt.preflight, "refused", "a non-refused finding is coerced to refused, never read as stale-but-retryable");
  assert.equal(smuggled.receipt.code, "delegation-profile-stale");
});
