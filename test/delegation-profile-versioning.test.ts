// W1-T3878 acceptance: "profile changes create linked replacements and never mutate the original
// authorization history". A replacement is the next revision with its own id and `replaces` link;
// the original stays exactly as issued (and authoritative) until the replacement is accepted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import {
  buildDelegationReplacement,
  DELEGATION_DECISION_LEDGER_STEP,
  DELEGATION_PROFILE_LEDGER_STEP,
  foldDelegationProfiles,
} from "../src/lib/delegation-profile.js";
import { OPERATOR_AGENT_ACTION_RECEIPT_STEP } from "../src/lib/operator-agent.js";
import {
  at,
  builtProfile,
  CLOCK,
  DAY,
  DELEGATION_ID,
  HOUR,
  issueAndAccept,
  NOW_MS,
  postJson,
  profileInput,
  readProfiles,
  rowsAt,
  tempStatePath,
  withDelegationService,
} from "./helpers/delegation-profile-fixture.js";

test("W1-T3878: a replacement is a linked new revision and never mutates the original", () => {
  const original = builtProfile();
  const snapshot = JSON.stringify(original);
  const later = fixedClock(NOW_MS + DAY);
  const replaced = buildDelegationReplacement(original, { budget: { costUsd: 50, durationMinutes: 240 } }, later);
  assert.ok(replaced.ok, JSON.stringify(replaced));
  assert.equal(JSON.stringify(original), snapshot, "the original is byte-identical after a replacement is built");
  assert.equal(replaced.profile.delegationId, `${DELEGATION_ID}@r2`);
  assert.equal(replaced.profile.revision, 2);
  assert.equal(replaced.profile.replaces, DELEGATION_ID);
  assert.deepEqual(replaced.profile.budget, { costUsd: 50, durationMinutes: 240 });
  assert.equal(replaced.profile.createdAt, later.iso());
  assert.equal(replaced.profile.expiresAt, at(DAY + 7 * DAY), "the predecessor's lifetime, counted from now");
  assert.deepEqual(replaced.profile.scope, original.scope, "every field the change does not name carries over");

  const third = buildDelegationReplacement(replaced.profile, { expiresAt: at(3 * DAY) }, later);
  assert.ok(third.ok, JSON.stringify(third));
  assert.equal(third.profile.delegationId, `${DELEGATION_ID}@r3`, "the revision suffix is replaced, never stacked");
  assert.equal(third.profile.replaces, `${DELEGATION_ID}@r2`);
  assert.equal(third.profile.expiresAt, at(3 * DAY));

  const long = builtProfile({ delegationId: "d".repeat(160) });
  const longReplacement = buildDelegationReplacement(long, undefined, CLOCK);
  assert.ok(longReplacement.ok);
  assert.equal(longReplacement.profile.delegationId.length, 160, "a derived id stays inside the id bound");
});

test("W1-T3878: a replacement may never change the delegation's identity", () => {
  const original = builtProfile();
  for (const field of ["scope", "principal", "link", "delegationId", "revision", "createdAt", "revocationRef"]) {
    const refused = buildDelegationReplacement(original, { [field]: "changed" }, CLOCK);
    assert.equal(!refused.ok && refused.code, "immutable-field", field);
    assert.equal(!refused.ok && refused.field, field);
  }
  assert.equal((buildDelegationReplacement(original, "wider please", CLOCK) as { code: string }).code, "not-an-object");
  assert.equal((buildDelegationReplacement(original, { riskTier: "destructive", transcript: "..." }, CLOCK) as { code: string }).code, "forbidden-field");
  assert.equal((buildDelegationReplacement(original, { budget: { costUsd: -5, durationMinutes: 10 } }, CLOCK) as { code: string }).code, "missing-budget");
});

test("W1-T3878: replacing over HTTP appends a linked profile and leaves the original's history intact", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    await issueAndAccept(base);
    const before = rowsAt(path).find((row) => row.step === DELEGATION_PROFILE_LEDGER_STEP);
    const replaced = await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: DELEGATION_ID, note: "Rotate before expiry.", changes: { budget: { costUsd: 40, durationMinutes: 120 } } });
    assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
    // The console reads `at` and `lifecycleState` (as durableState): the ORIGINAL stays active.
    assert.equal(replaced.body.delegationId, DELEGATION_ID);
    assert.equal(replaced.body.replacementId, `${DELEGATION_ID}@r2`);
    assert.equal(replaced.body.at, CLOCK.iso());
    assert.equal(replaced.body.lifecycleState, "active");
    assert.equal((replaced.body.profile as { approval: { state: string } }).approval.state, "pending");

    const byId = async (id: string) => (await readProfiles(base)).find((profile) => profile.delegationId === id);
    let original = await byId(DELEGATION_ID);
    let replacement = await byId(`${DELEGATION_ID}@r2`);
    assert.equal(original?.delegationId, DELEGATION_ID);
    assert.equal(original?.status, "active", "the original stays authoritative until the replacement is accepted");
    assert.equal(original?.pendingReplacement, `${DELEGATION_ID}@r2`);
    assert.deepEqual(original?.receipts, [
      { kind: "accept", at: CLOCK.iso() },
      { kind: "replace", at: CLOCK.iso(), note: "Rotate before expiry." },
    ]);
    assert.equal(replacement?.status, "pending");
    assert.equal(replacement?.replaces, DELEGATION_ID);

    const twice = await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: DELEGATION_ID });
    assert.equal(twice.status, 409, "one pending replacement at a time");
    assert.match(String(twice.body.detail), /already being replaced/);

    const accepted = await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: `${DELEGATION_ID}@r2`, decision: "accepted" });
    assert.equal(accepted.status, 200);
    original = await byId(DELEGATION_ID);
    replacement = await byId(`${DELEGATION_ID}@r2`);
    assert.equal(replacement?.status, "active");
    assert.equal(original?.status, "superseded");
    assert.equal(original?.lifecycleState, "revoked", "a superseded profile may no longer act");
    assert.deepEqual(original?.revocation, { reason: `superseded by ${DELEGATION_ID}@r2`, revokedAt: CLOCK.iso() });
    assert.deepEqual(original?.approval, { state: "approved", decidedAt: CLOCK.iso() }, "the original's own approval record is untouched");
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: DELEGATION_ID })).status, 409, "a superseded profile cannot be replaced again");
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: DELEGATION_ID, decision: "revoked" })).status, 409, "nor revoked after the fact");

    const chained = await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: `${DELEGATION_ID}@r2` });
    assert.equal(chained.status, 201);
    assert.equal(chained.body.replacementId, `${DELEGATION_ID}@r3`);

    const after = rowsAt(path).filter((row) => row.step === DELEGATION_PROFILE_LEDGER_STEP && row.task_id === DELEGATION_ID);
    assert.deepEqual(after, [before], "the original's issuance row is the only one and is unchanged");
  });
});

test("W1-T3878: a replacement cannot be accepted once the profile it replaces is revoked, and bad replace requests are refused", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: DELEGATION_ID })).status, 404);
    await issueAndAccept(base);
    const identity = await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: DELEGATION_ID, changes: { scope: { kind: "repository", repository: "owner/other" } } });
    assert.equal(identity.status, 400);
    assert.equal(identity.body.code, "immutable-field");
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: "" })).status, 400);
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: DELEGATION_ID, note: "n".repeat(321) })).status, 400);

    assert.equal((await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: DELEGATION_ID })).status, 201);
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: DELEGATION_ID, decision: "revoked", note: "Scope was wrong." })).status, 200);
    const orphan = await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: `${DELEGATION_ID}@r2`, decision: "accepted" });
    assert.equal(orphan.status, 409);
    assert.match(String(orphan.body.detail), /was revoked/);
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: DELEGATION_ID })).status, 409, "a revoked profile cannot be replaced");

    // A pre-existing profile already holding the derived replacement id blocks the replacement.
    await issueAndAccept(base, { delegationId: "delegation:squatted" });
    assert.equal((await postJson(base, "/v1/operator-agent/delegations", { profile: profileInput({ delegationId: "delegation:squatted@r2" }) })).status, 201);
    assert.equal((await postJson(base, "/v1/operator-agent/delegations/replace", { delegationId: "delegation:squatted" })).status, 409);
  });
});

test("W1-T3878: the fold keeps the first record per id and ignores malformed or orphaned rows", () => {
  const original = builtProfile();
  const replacement = buildDelegationReplacement(original, {}, CLOCK);
  assert.ok(replacement.ok);
  const rows = [
    { step: DELEGATION_DECISION_LEDGER_STEP, delegation_id: DELEGATION_ID, decision: "accepted", at: at(0) },
    { step: DELEGATION_PROFILE_LEDGER_STEP, profile: original },
    { step: DELEGATION_PROFILE_LEDGER_STEP, profile: { ...original, purpose: "A later row can never rewrite the first." } },
    { step: DELEGATION_PROFILE_LEDGER_STEP, profile: { ...original, delegationId: "delegation:broken", scope: undefined } },
    { step: DELEGATION_DECISION_LEDGER_STEP, delegation_id: DELEGATION_ID, decision: "accepted", at: "not a time" },
    { step: DELEGATION_DECISION_LEDGER_STEP, delegation_id: "delegation:unknown", decision: "accepted", at: at(HOUR) },
    { step: DELEGATION_DECISION_LEDGER_STEP, delegation_id: DELEGATION_ID, decision: "accepted", at: at(HOUR), note: "first acceptance" },
    { step: DELEGATION_DECISION_LEDGER_STEP, delegation_id: DELEGATION_ID, decision: "accepted", at: at(2 * HOUR) },
    { step: DELEGATION_DECISION_LEDGER_STEP, delegation_id: DELEGATION_ID, decision: "maybe", at: at(2 * HOUR) },
    { step: DELEGATION_PROFILE_LEDGER_STEP, profile: replacement.profile },
    { step: DELEGATION_PROFILE_LEDGER_STEP, profile: { ...replacement.profile, delegationId: `${DELEGATION_ID}@x`, revocationRef: `/v1/operator-agent/delegations/decision#${DELEGATION_ID}@x` } },
    { step: OPERATOR_AGENT_ACTION_RECEIPT_STEP, delegation_id: DELEGATION_ID, delegation_cost_usd: 3, receipt: { outcome: "in-progress" } },
    { step: OPERATOR_AGENT_ACTION_RECEIPT_STEP, delegation_id: DELEGATION_ID, delegation_cost_usd: 99, receipt: { outcome: "refused" } },
    { step: OPERATOR_AGENT_ACTION_RECEIPT_STEP, delegation_id: DELEGATION_ID, delegation_cost_usd: -4, receipt: { outcome: "in-progress" } },
    { step: OPERATOR_AGENT_ACTION_RECEIPT_STEP, delegation_id: "delegation:unknown", delegation_cost_usd: 5, receipt: { outcome: "in-progress" } },
    { step: OPERATOR_AGENT_ACTION_RECEIPT_STEP, receipt: { outcome: "in-progress" } },
  ];
  const states = foldDelegationProfiles(rows, OPERATOR_AGENT_ACTION_RECEIPT_STEP);
  assert.deepEqual(states.map((state) => state.profile.delegationId).sort(), [DELEGATION_ID, `${DELEGATION_ID}@r2`, `${DELEGATION_ID}@x`].sort());
  const first = states.find((state) => state.profile.delegationId === DELEGATION_ID);
  assert.equal(first?.profile.purpose, original.purpose);
  assert.equal(first?.acceptedAt, at(HOUR), "a decision before the profile exists, or with no valid time, is ignored; the first acceptance stands");
  assert.deepEqual(first?.receipts, [
    { kind: "accept", at: at(HOUR), note: "first acceptance" },
    { kind: "replace", at: CLOCK.iso(), note: `replaced by ${DELEGATION_ID}@r2` },
  ]);
  assert.equal(first?.pendingReplacement, `${DELEGATION_ID}@r2`, "only the first replacement links");
  assert.equal(first?.spentCostUsd, 3, "only admitted, non-negative spend counts");
});
