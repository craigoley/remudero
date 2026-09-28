// W1-T3878 acceptance: "the profile contract contains no raw prompt, credential, transcript, or
// browser-owned measurement". A forbidden field is REFUSED by name wherever it is nested, a
// credential-shaped value is refused, an unknown field never reaches the record, and neither the
// ledger row nor the read route carries anything outside the named contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDelegationProfile,
  DELEGATION_NON_AUTHORITATIVE_FIELD_RE,
  DELEGATION_PROFILE_LEDGER_STEP,
  findNonAuthoritativeSignal,
  foldDelegationProfiles,
} from "../src/lib/delegation-profile.js";
import { OPERATOR_AGENT_ACTION_RECEIPT_STEP } from "../src/lib/operator-agent.js";
import {
  builtProfile,
  CLOCK,
  DELEGATION_ID,
  issueAndAccept,
  postJson,
  profileInput,
  readProfiles,
  rowsAt,
  tempStatePath,
  withDelegationService,
} from "./helpers/delegation-profile-fixture.js";

/** Every key the public projection may carry — the contract, named. */
const CONTRACT_KEYS = [
  "version", "delegationId", "revision", "replaces", "principal", "purpose", "link", "scope", "dataClasses", "capabilities",
  "capabilitySummary", "riskTier", "actionRiskCeiling", "budget", "notification", "approvalLevel", "humanDecision",
  "fallbackOwner", "createdAt", "expiresAt", "revocationRef", "approval", "lifecycleState", "status", "revocation",
  "supersededBy", "pendingReplacement", "spentCostUsd", "receipts", "observedAt", "freshness",
];

test("W1-T3878: the profile contract contains no raw prompt, credential, transcript, or browser-owned measurement", () => {
  const forbidden: Array<[Record<string, unknown>, string, string]> = [
    [{ prompt: "Do whatever the user asked earlier." }, "forbidden-field", "prompt"],
    [{ rawTranscript: "..." }, "forbidden-field", "rawTranscript"],
    [{ transcript: ["turn 1"] }, "forbidden-field", "transcript"],
    [{ credentials: { token: "x" } }, "forbidden-field", "credentials"],
    [{ link: { flowId: "flow:canary", apiKey: "k" } }, "forbidden-field", "link.apiKey"],
    [{ browser_timing: 12 }, "forbidden-field", "browser_timing"],
    [{ webVitals: { lcp: 1.2 } }, "forbidden-field", "webVitals"],
    [{ modelOutput: "I am sure." }, "forbidden-field", "modelOutput"],
    [{ purpose: "Deploy with Bearer abcdefghijklmnop" }, "secret-value", "purpose"],
    [{ capabilitySummary: "uses ghp_abcdefghijklmnopqrstuvwxyz" }, "secret-value", "capabilitySummary"],
    [{ dataClasses: ["logs", "password: hunter2"] }, "secret-value", "dataClasses.1"],
  ];
  for (const [overrides, code, field] of forbidden) {
    const built = buildDelegationProfile(profileInput(overrides), { clock: CLOCK });
    assert.equal(!built.ok && built.code, code, JSON.stringify(overrides));
    assert.equal(!built.ok && built.field, field, JSON.stringify(overrides));
  }

  const extra = buildDelegationProfile(profileInput({ daemonUrl: "https://internal.example", notes: "free text" }), { clock: CLOCK });
  assert.ok(extra.ok);
  assert.deepEqual(Object.keys(extra.profile).filter((key) => !CONTRACT_KEYS.includes(key)), [], "an unnamed field never reaches the record");

  // A hand-edited ledger row carrying a forbidden field never enters the projection.
  const tampered = { ...builtProfile({ delegationId: "delegation:tampered" }), transcript: "leaked" };
  const states = foldDelegationProfiles([{ step: DELEGATION_PROFILE_LEDGER_STEP, profile: tampered }, { step: DELEGATION_PROFILE_LEDGER_STEP, profile: builtProfile() }], OPERATOR_AGENT_ACTION_RECEIPT_STEP);
  assert.deepEqual(states.map((state) => state.profile.delegationId), [DELEGATION_ID]);
});

test("W1-T3878: DELEGATION_NON_AUTHORITATIVE_FIELD_RE names confidence, remembered approval, and UI state and nothing else", () => {
  for (const key of ["confidence", "modelConfidence", "model_confidence", "confidenceScore", "priorApproval", "previous_approvals", "rememberedApproval", "cachedApproval", "clientApproval", "uiState", "ui_state"]) {
    assert.equal(DELEGATION_NON_AUTHORITATIVE_FIELD_RE.test(key), true, key);
  }
  for (const key of ["approval", "approvalLevel", "humanDecision", "state", "confident", "decision", "budget"]) {
    assert.equal(DELEGATION_NON_AUTHORITATIVE_FIELD_RE.test(key), false, key);
  }
  assert.equal(findNonAuthoritativeSignal({ a: [{ b: { uiState: 1 } }] }), "a.0.b.uiState");
  assert.equal(findNonAuthoritativeSignal(["confidence"]), undefined, "an array element is a value, never a key");
  assert.equal(findNonAuthoritativeSignal("confidence"), undefined);
  let deep: Record<string, unknown> = { confidence: 1 };
  for (let depth = 0; depth < 10; depth += 1) deep = { nested: deep };
  assert.equal(findNonAuthoritativeSignal(deep), undefined, "the scan is depth-bounded");
});

test("W1-T3878: neither the ledger nor the read route carries anything outside the named contract", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    const leaked = await postJson(base, "/v1/operator-agent/delegations", { profile: profileInput({ prompt: "private conversation text" }) });
    assert.equal(leaked.status, 400);
    assert.equal(leaked.body.code, "forbidden-field");
    const leakedDecision = await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: DELEGATION_ID, decision: "accepted", credentials: "bearer-secret" });
    assert.equal(leakedDecision.status, 400);
    assert.match(String(leakedDecision.body.detail), /^forbidden-field/);
    await issueAndAccept(base, { daemonUrl: "https://internal.example" });
    const [profile] = await readProfiles(base);
    assert.ok(profile);
    assert.deepEqual(Object.keys(profile).filter((key) => !CONTRACT_KEYS.includes(key)), []);
    assert.equal(JSON.stringify(profile).includes("internal.example"), false);
  });
  const row = rowsAt(path).find((candidate) => candidate.step === DELEGATION_PROFILE_LEDGER_STEP);
  assert.ok(row);
  assert.deepEqual(Object.keys(row.profile as object).filter((key) => !CONTRACT_KEYS.includes(key)), []);
  assert.equal(JSON.stringify(rowsAt(path)).includes("private conversation text"), false, "a refused body is never ledgered");
});
