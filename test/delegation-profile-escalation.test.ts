// W1-T3878 acceptance: "a prior approval or model confidence cannot authorize a higher-risk action
// than the profile permits". Authority is DERIVED from the profile's ceiling and the action's own
// durable approval: an operator approval does not lift the ceiling, a confidence or remembered
// approval field is refused by name, and a replacement never inherits its predecessor's acceptance.
// High-risk and irreversible actions stay human-gated inside an accepted profile.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAutomationAction, type AutomationActionReceipt } from "../src/lib/automation-action.js";
import { buildDelegationProfile, delegationEligibility } from "../src/lib/delegation-profile.js";
import {
  actionBody,
  at,
  builtProfile,
  CLOCK,
  DELEGATION_ID,
  HEALTHY,
  issueAndAccept,
  postJson,
  profileInput,
  readProfiles,
  stateOf,
  tempStatePath,
  validAction,
  withDelegationService,
} from "./helpers/delegation-profile-fixture.js";

const APPROVED = { decision: "approved" as const, decidedBy: "operator:owner", decidedAt: at(0) };

test("W1-T3878: a prior approval or model confidence cannot authorize a higher-risk action than the profile permits", () => {
  const medium = stateOf(builtProfile({ riskTier: "medium" }));
  const high = validAction({ risk: "high", approval: { policy: "human" } });
  const findings = delegationEligibility({ state: medium, action: high, approval: APPROVED, clock: CLOCK });
  assert.deepEqual(findings.map((finding) => finding.code), ["delegation-risk-exceeds-profile"], "an operator-approved action still cannot exceed the profile's ceiling");
  const step = evaluateAutomationAction({ action: high, observations: HEALTHY, receipts: [], approval: APPROVED, clock: CLOCK, eligibility: findings });
  assert.equal(step.disposition, "refused");
  assert.equal(step.receipt.code, "delegation-risk-exceeds-profile");

  const production = stateOf(builtProfile({ riskTier: "production" }));
  const financial = validAction({ risk: "financial", approval: { policy: "human" } });
  assert.deepEqual(delegationEligibility({ state: production, action: financial, approval: APPROVED, clock: CLOCK }).map((f) => f.code), ["delegation-risk-exceeds-profile"], "critical tiers never stand in for each other");

  const confident = buildDelegationProfile(profileInput({ modelConfidence: 0.99 }), { clock: CLOCK });
  assert.equal(!confident.ok && confident.code, "non-authoritative-signal", "a profile cannot carry a confidence as authority");
  const remembered = buildDelegationProfile(profileInput({ budget: { costUsd: 5, durationMinutes: 60, priorApproval: true } }), { clock: CLOCK });
  assert.equal(!remembered.ok && remembered.field, "budget.priorApproval");
});

test("W1-T3878: high-risk and irreversible actions stay human-gated inside an accepted profile", () => {
  const profile = stateOf(builtProfile());
  const gate = (overrides: Record<string, unknown>, approval?: typeof APPROVED, state = profile) =>
    delegationEligibility({ state, action: validAction(overrides), ...(approval ? { approval } : {}), clock: CLOCK }).map((finding) => finding.code);
  assert.deepEqual(gate({ risk: "production", approval: { policy: "human" } }), ["delegation-human-gate-required"]);
  assert.deepEqual(gate({ risk: "production", approval: { policy: "human" } }, APPROVED), [], "the action's OWN operator approval passes the gate");
  assert.deepEqual(gate({ rollback: { mode: "irreversible", refusal: "Traffic cannot be un-shifted." } }), ["delegation-human-gate-required"], "an irreversible low-risk action is gated too");
  const eachAction = stateOf(builtProfile({ approvalLevel: "each-action" }));
  assert.deepEqual(gate({}, undefined, eachAction), ["delegation-human-gate-required"]);
  assert.deepEqual(gate({}, APPROVED, eachAction), []);
  assert.deepEqual(gate({}, { ...APPROVED, decision: "rejected" as never }, eachAction), ["delegation-human-gate-required"]);
});

test("W1-T3878: the execution path refuses a confidence or remembered approval and never carries acceptance to a replacement", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    await issueAndAccept(base, { riskTier: "medium" });
    const high = actionBody({ risk: "high", approval: { policy: "human" } });
    assert.equal((await postJson(base, "/v1/operator-agent/actions", { action: high })).status, 201);
    assert.equal((await postJson(base, "/v1/operator-agent/actions/decision", { actionId: "action:deploy:canary", decision: "approved" })).status, 200);
    const escalated = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary", observations: HEALTHY, delegationId: DELEGATION_ID });
    assert.equal(escalated.status, 409);
    assert.equal((escalated.body.receipt as AutomationActionReceipt).code, "delegation-risk-exceeds-profile");
    const operatorPath = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary", observations: HEALTHY, dryRun: true });
    assert.equal(operatorPath.body.disposition, "dry-run", "the same approved action is fine on the operator's own path");

    for (const signal of [{ modelConfidence: 0.99 }, { confidence: 1 }, { priorApproval: true }, { context: { uiState: "approved" } }]) {
      const refused = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary", observations: HEALTHY, delegationId: DELEGATION_ID, ...signal });
      assert.equal(refused.status, 400, JSON.stringify(signal));
      assert.match(String(refused.body.detail), /^non-authoritative-signal/);
    }
    const decided = await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: DELEGATION_ID, decision: "accepted", rememberedApproval: true });
    assert.equal(decided.status, 400);

    // Rotate the profile: its replacement is pending, whatever the predecessor's acceptance said.
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: DELEGATION_ID, changes: { riskTier: "high" } })).status, 201);
    const unaccepted = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary", observations: HEALTHY, delegationId: `${DELEGATION_ID}@r2` });
    assert.equal((unaccepted.body.receipt as AutomationActionReceipt).code, "delegation-profile-not-approved", "a remembered acceptance never carries to a replacement");
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: `${DELEGATION_ID}@r2`, decision: "accepted" })).status, 200);
    const allowed = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: "action:deploy:canary", observations: HEALTHY, delegationId: `${DELEGATION_ID}@r2` });
    assert.equal(allowed.status, 202, "only the operator's acceptance of the wider replacement lifts the ceiling");
  });
});

test("W1-T3878: the decision route accepts only a pending profile and treats revocation as terminal", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: DELEGATION_ID, decision: "accepted" })).status, 404);
    assert.equal((await postJson(base, "/v1/operator-agent/delegations", { profile: profileInput() })).status, 201);
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: DELEGATION_ID, decision: "approve" })).status, 400);
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/decision", { decision: "accepted" })).status, 400);
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/decision", "accepted")).status, 400);
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: DELEGATION_ID, decision: "accepted", note: 7 })).status, 400);

    const accepted = await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: DELEGATION_ID, decision: "accepted", note: "Approved by operator." });
    assert.equal(accepted.status, 200);
    assert.deepEqual(
      { decision: accepted.body.decision, at: accepted.body.at, lifecycleState: accepted.body.lifecycleState, approval: accepted.body.approval },
      { decision: "accepted", at: CLOCK.iso(), lifecycleState: "active", approval: "approved" },
    );
    assert.equal(typeof accepted.body.decidedBy, "string", "the decider is the verified identity, never a body field");
    const again = await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: DELEGATION_ID, decision: "accepted" });
    assert.equal(again.status, 409);
    assert.match(String(again.body.detail), /only a pending profile can be accepted/);

    await issueAndAccept(base, { delegationId: "delegation:second" });
    const pending = await postJson(base, "/v1/operator-agent/delegations", { profile: profileInput({ delegationId: "delegation:pending" }) });
    assert.equal(pending.status, 201);
    const denied = await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: "delegation:pending", decision: "revoked" });
    assert.equal(denied.body.approval, "denied", "revoking a pending profile denies it");
    assert.equal(denied.body.lifecycleState, "revoked");
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: "delegation:pending", decision: "revoked" })).status, 409);
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: "delegation:pending", decision: "accepted" })).status, 409, "a denied profile is never accepted later");
    const profiles = await readProfiles(base);
    const deniedView = profiles.find((profile) => profile.delegationId === "delegation:pending");
    assert.deepEqual(deniedView?.approval, { state: "denied", decidedAt: CLOCK.iso() });
    assert.deepEqual(deniedView?.receipts, [{ kind: "revoke", at: CLOCK.iso() }]);
    assert.deepEqual(deniedView?.revocation, { reason: "revoked by operator", revokedAt: CLOCK.iso() });
    const first = profiles.find((profile) => profile.delegationId === DELEGATION_ID);
    assert.deepEqual(first?.receipts, [{ kind: "accept", at: CLOCK.iso(), note: "Approved by operator." }]);
  });
});
