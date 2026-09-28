// W1-T3895 acceptance: "stale, insufficient, expired, corrected, and unmeasurable preferences stop
// applying".
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOperatorAgentRoutes, OPERATOR_AGENT_DECISION_STEP, OPERATOR_AGENT_PROPOSAL_STEP } from "../src/lib/operator-agent.js";
import {
  applyScopedPreference,
  evaluatePreference,
  inferPreferenceHypothesis,
  PREFERENCE_EXPIRY_MS,
  PREFERENCE_FRESHNESS_MS,
  projectOperatorPreference,
  transitionPreference,
  type OperatorPreference,
  type PreferenceEvent,
  type PreferenceLifecycle,
  type PreferenceState,
} from "../src/lib/preference-policy.js";
import { createService } from "../src/lib/service.js";

const READ = "pref-expiry-read";
const WRITE = "pref-expiry-write";
const T0 = Date.now();
const SCOPE = { principalId: "user_123", repository: "owner/repo" };

function hypothesis(count: number, kind: "ordering" | "notification-style" = "ordering"): OperatorPreference {
  const decisions = Array.from({ length: count }, (_, i) => ({
    decisionRef: `d-${i}`,
    proposalId: `p-${i}`,
    category: "fix",
    decision: "accepted",
    at: new Date(T0 - (i + 1) * 60_000).toISOString(),
  }));
  return inferPreferenceHypothesis({ scope: SCOPE, effect: kind === "ordering" ? { kind, value: "fix" } : { kind, value: "digest" }, decisions, now: T0 });
}

function withEvent(preference: OperatorPreference, lifecycle: PreferenceLifecycle, now: number): PreferenceState {
  const event: PreferenceEvent = { receiptId: `r-${lifecycle}`, preferenceId: preference.preferenceId, action: "accept", lifecycle, previousLifecycle: "proposed", at: new Date(T0).toISOString(), scope: SCOPE };
  return evaluatePreference(preference, [event], now);
}

const items = [{ id: "scale", category: "scale", authority: { checked: true, actionable: true } }, { id: "fix", category: "fix", authority: { checked: true, actionable: true } }];
const order = (state: PreferenceState) => applyScopedPreference({ scope: SCOPE, items, preferences: [state] }).items.map((i) => i.id);

test("control: an accepted, measured, fresh, unexpired preference applies", () => {
  const state = withEvent(hypothesis(6), "accepted", T0);
  assert.equal(state.applies, true);
  assert.equal(state.reason, "accepted");
  assert.deepEqual(order(state), ["fix", "scale"]);
  assert.equal((projectOperatorPreference(state).application as { state: string }).state, "applied");
});

test("stale evidence stops an accepted preference and cannot be accepted", () => {
  const preference = hypothesis(6);
  const stale = withEvent(preference, "accepted", Date.parse(preference.freshUntil) + 1);
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.applies, false);
  assert.equal(stale.reason, "stale");
  assert.deepEqual(order(stale), ["scale", "fix"]);
  const proposedButStale = evaluatePreference(preference, [], Date.parse(preference.freshUntil) + 1);
  assert.deepEqual(transitionPreference(proposedButStale, "accept"), { ok: false, code: "stale_evidence", detail: "cannot accept a proposed preference (proposed)" });
  assert.equal(Date.parse(preference.freshUntil), T0 - 60_000 + PREFERENCE_FRESHNESS_MS, "freshness runs from the newest measuring decision");
});

test("an insufficient sample is unmeasurable, has no confidence, and never applies even if accepted", () => {
  const preference = hypothesis(3);
  assert.equal(preference.measurability, "insufficient");
  assert.equal(preference.confidence, null);
  const state = withEvent(preference, "accepted", T0);
  assert.equal(state.lifecycle, "unmeasurable");
  assert.equal(state.reason, "insufficient");
  assert.deepEqual(order(state), ["scale", "fix"]);
  assert.deepEqual((projectOperatorPreference(state).confidence as Record<string, unknown>), { value: 0, source: "insufficient", sampleFloor: 5 });
  assert.equal(transitionPreference(state, "accept").ok, false);
  assert.match(preference.explanation, /Only 3 of the 5-decision sample floor/);
});

test("an effect no decision measures is unmeasurable, never a default", () => {
  const preference = hypothesis(8, "notification-style");
  assert.equal(preference.measurability, "unmeasurable");
  assert.equal(preference.evidence.sampleSize, 0);
  const state = withEvent(preference, "accepted", T0);
  assert.equal(state.reason, "unmeasurable");
  assert.equal(applyScopedPreference({ scope: SCOPE, items, preferences: [state] }).notificationStyle, undefined);
  assert.match(preference.explanation, /No bounded operator decision measures this effect/);
});

test("an expired preference stops applying and cannot be accepted", () => {
  const preference = hypothesis(6);
  const expired = withEvent(preference, "accepted", T0 + PREFERENCE_EXPIRY_MS);
  assert.equal(expired.lifecycle, "expired");
  assert.equal(expired.applies, false);
  assert.deepEqual(order(expired), ["scale", "fix"]);
  assert.equal((transitionPreference(evaluatePreference(preference, [], T0 + PREFERENCE_EXPIRY_MS), "accept") as { code: string }).code, "invalid_transition");
});

test("a corrected or rejected preference stops applying", () => {
  const preference = hypothesis(6);
  for (const lifecycle of ["corrected", "rejected"] as const) {
    const state = withEvent(preference, lifecycle, T0);
    assert.equal(state.applies, false);
    assert.equal(state.reason, lifecycle);
    assert.deepEqual(order(state), ["scale", "fix"]);
    assert.equal((projectOperatorPreference(state).application as { state: string }).state, "not_applied");
  }
  assert.equal((transitionPreference(withEvent(preference, "corrected", T0), "reject") as { code: string }).code, "invalid_transition");
});

test("through the routes, accept then correct stops application, and a re-proposal links to what it supersedes", async () => {
  const clock = { ms: T0 };
  const root = mkdtempSync(join(tmpdir(), "rmd-pref-expiry-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const server = createService({ tokens: { read: READ, write: WRITE }, routes: buildOperatorAgentRoutes({ ledgerPath, now: () => clock.ms }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${method === "GET" ? READ : WRITE}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  try {
    const rows = Array.from({ length: 5 }, (_, i) => {
      const proposal = { proposalId: `p-${i}`, repo: "owner/repo", proposalText: "t", confidence: 0.5, reasoning: "r", category: "fix", status: "pending", createdAt: new Date(T0 - 60_000).toISOString(), evidence: [] };
      return [{ step: OPERATOR_AGENT_PROPOSAL_STEP, proposal }, { step: OPERATOR_AGENT_DECISION_STEP, proposal_id: `p-${i}`, decision: "accepted", at: new Date(T0 - 60_000 + i).toISOString() }];
    }).flat();
    appendFileSync(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    const unmeasurable = await call("POST", "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "notification-style", value: "digest" } });
    assert.equal(unmeasurable.body.preference.lifecycle, "unmeasurable");
    const refused = await call("POST", "/v1/operator-agent/preferences/accept", { preferenceId: unmeasurable.body.preference.preferenceId, scope: SCOPE });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "invalid_transition");

    const first = await call("POST", "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "ordering", value: "fix" } });
    const id = first.body.preference.preferenceId as string;
    const accept = await call("POST", "/v1/operator-agent/preferences/accept", { action: "accept", preferenceId: id, scope: SCOPE });
    assert.equal(accept.body.lifecycle, "accepted");
    const correct = await call("POST", "/v1/operator-agent/preferences/correct", { preferenceId: id, scope: SCOPE, correction: "prefer scale during incidents" });
    assert.equal(correct.body.lifecycle, "corrected");
    assert.equal(correct.body.previousReceiptId, accept.body.receiptId, "the correction links to the acceptance it overrides");
    const noCorrection = await call("POST", "/v1/operator-agent/preferences/correct", { preferenceId: id, scope: SCOPE });
    assert.equal(noCorrection.status, 400);
    const rejectCorrected = await call("POST", "/v1/operator-agent/preferences/reject", { preferenceId: id, scope: SCOPE });
    assert.equal(rejectCorrected.status, 409);

    const listed = await call("GET", "/v1/operator-agent/preferences?repository=owner%2Frepo&principalId=user_123");
    const projection = listed.body.preferences.find((p: { preferenceId: string }) => p.preferenceId === id);
    assert.equal(projection.lifecycle, "corrected");
    assert.equal(projection.application.state, "not_applied");
    assert.deepEqual(projection.receipts.map((r: { action: string }) => r.action), ["accept", "correct"]);

    clock.ms = T0 + 1_000;
    const second = await call("POST", "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "ordering", value: "fix" } });
    assert.equal(second.status, 201);
    assert.notEqual(second.body.preference.preferenceId, id);
    assert.equal(second.body.preference.supersedes, id, "the new hypothesis links to the corrected one");
    const [secondRow] = (await call("GET", "/v1/operator-agent/preferences?repository=owner%2Frepo&principalId=user_123")).body.preferences.filter(
      (p: { preferenceId: string }) => p.preferenceId === second.body.preference.preferenceId,
    );
    assert.equal(secondRow.lifecycle, "proposed");

    const rejected = await call("POST", "/v1/operator-agent/preferences/reject", { preferenceId: second.body.preference.preferenceId, scope: SCOPE, note: "not now" });
    assert.equal(rejected.body.lifecycle, "rejected");
    assert.equal(rejected.body.hasNote, true);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
