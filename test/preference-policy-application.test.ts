// W1-T3895 acceptance: "a preference can affect presentation or ordering but cannot grant authority
// or bypass a refusal".
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP } from "../src/lib/ledger.js";
import { buildOperatorAgentRoutes, OPERATOR_AGENT_DECISION_STEP, OPERATOR_AGENT_PROPOSAL_STEP } from "../src/lib/operator-agent.js";
import {
  applyScopedPreference,
  evaluatePreference,
  foldOperatorPreferences,
  inferPreferenceHypothesis,
  type OperatorPreference,
  type PreferenceEffect,
  type PreferenceState,
} from "../src/lib/preference-policy.js";
import { createService } from "../src/lib/service.js";

const READ = "pref-application-read";
const WRITE = "pref-application-write";
const T0 = Date.now();
const SCOPE = { principalId: "user_123", repository: "owner/repo" };

function measured(effect: PreferenceEffect, supporting = 5, scope = SCOPE): OperatorPreference {
  const decision = (i: number, accepted: boolean) => ({
    decisionRef: `d-${i}`,
    proposalId: `p-${i}`,
    category: effect.kind === "ordering" ? effect.value : "fix",
    decision: effect.kind === "clarification-wording" ? (accepted === (effect.value === "detailed") ? "more-info" : "accepted") : accepted ? "accepted" : "rejected",
    at: new Date(T0 - (i + 1) * 60_000).toISOString(),
  });
  const decisions = Array.from({ length: 6 }, (_, i) => decision(i, i < supporting));
  return inferPreferenceHypothesis({ scope, effect, decisions, now: T0 });
}

function accepted(preference: OperatorPreference): PreferenceState {
  const event = { receiptId: `r-${preference.preferenceId}`, preferenceId: preference.preferenceId, action: "accept" as const, lifecycle: "accepted" as const, previousLifecycle: "proposed" as const, at: new Date(T0).toISOString(), scope: preference.scope };
  return evaluatePreference(preference, [event], T0);
}

const item = (id: string, category: string, actionable: boolean, refusal?: string) => ({
  id,
  category,
  authority: { checked: true, actionable, ...(refusal ? { refusal } : {}) },
});

test("an accepted ordering preference reorders actionable items and leaves a refused item, and its refusal, where it was", () => {
  const items = [item("scale-1", "scale", true), item("fix-refused", "fix", false, "emergency-stop-active"), item("optimize-1", "optimize", true), item("fix-1", "fix", true)];
  const before = JSON.parse(JSON.stringify(items));
  const result = applyScopedPreference({ scope: SCOPE, items, preferences: [accepted(measured({ kind: "ordering", value: "fix" }))] });

  assert.deepEqual(result.items.map((i) => i.id), ["fix-1", "fix-refused", "scale-1", "optimize-1"]);
  assert.equal(result.items[1], items[1], "the refused item is the same object in the same slot");
  assert.deepEqual(result.items.map((i) => i.authority).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), before.map((i: { authority: unknown }) => i.authority).sort((a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  assert.deepEqual(JSON.parse(JSON.stringify(items)), before, "the caller's items and verdicts are not mutated");
  assert.deepEqual(Object.keys(result).sort(), ["applied", "items", "skipped"], "the result has no capability, budget, approval, or refusal field to widen");
});

test("presentation preferences choose the strongest style and wording; nothing applies before authority is checked", () => {
  const styleWeak = accepted(measured({ kind: "clarification-wording", value: "concise" }, 5));
  const styleStrong = accepted(measured({ kind: "clarification-wording", value: "detailed" }, 6));
  const other = accepted(measured({ kind: "ordering", value: "scale" }, 5, { principalId: "user_456", repository: "owner/repo" }));
  const items = [item("a", "fix", true)];
  const result = applyScopedPreference({ scope: SCOPE, items, preferences: [styleWeak, styleStrong, other] });
  assert.equal(result.clarificationWording, "detailed");
  assert.equal(result.notificationStyle, undefined);
  assert.deepEqual(result.skipped, [{ preferenceId: other.preference.preferenceId, reason: "scope_mismatch" }]);

  const unchecked = applyScopedPreference({
    scope: SCOPE,
    items: [item("scale-1", "scale", true), { id: "fix-1", category: "fix", authority: { checked: false, actionable: true } }],
    preferences: [accepted(measured({ kind: "ordering", value: "fix" }))],
  });
  assert.deepEqual(unchecked.items.map((i) => i.id), ["scale-1", "fix-1"]);
  assert.deepEqual(unchecked.applied, []);
  assert.equal(unchecked.skipped[0]!.reason, "authority_unchecked");
});

test("an effect that would widen authority is refused at read and skipped by name if handed in directly", () => {
  const good = measured({ kind: "ordering", value: "fix" });
  const widening = { ...good, preferenceId: "pref-widen", effect: { kind: "grant-capability", value: "merge" } } as unknown as OperatorPreference;
  const folded = foldOperatorPreferences(
    [
      { step: OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP, preference: widening },
      { step: OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP, preference: good },
    ],
    T0,
  );
  assert.deepEqual(folded.map((state) => state.preference.preferenceId), [good.preferenceId], "a ledger row naming grant-capability is never read");

  const forced = { ...accepted(good), preference: widening };
  const result = applyScopedPreference({ scope: SCOPE, items: [item("a", "fix", true)], preferences: [forced] });
  assert.deepEqual(result.skipped, [{ preferenceId: "pref-widen", reason: "authority_effect_forbidden" }]);
  assert.deepEqual(result.applied, []);
});

test("the operator-agent proposals read applies preferences only after authority and emergency-stop refusal", async () => {
  const clock = { ms: T0 };
  const root = mkdtempSync(join(tmpdir(), "rmd-pref-application-"));
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
  const proposal = (proposalId: string, category: string, confidence: number, at: number) => ({
    proposalId,
    repo: "owner/repo",
    proposalText: "t",
    confidence,
    reasoning: "r",
    category,
    status: "pending",
    createdAt: new Date(at).toISOString(),
    evidence: [],
  });
  try {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => [
        { step: OPERATOR_AGENT_PROPOSAL_STEP, proposal: proposal(`decided-${i}`, "fix", 0.1, T0 - 3_600_000) },
        { step: OPERATOR_AGENT_DECISION_STEP, proposal_id: `decided-${i}`, decision: "accepted", at: new Date(T0 - 3_600_000 + i).toISOString() },
      ]).flat(),
      { step: OPERATOR_AGENT_PROPOSAL_STEP, proposal: proposal("pending-scale", "scale", 0.99, T0) },
      { step: OPERATOR_AGENT_PROPOSAL_STEP, proposal: proposal("pending-fix", "fix", 0.5, T0) },
    ];
    appendFileSync(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const pendingOrder = (body: Record<string, any>) => body.proposals.map((p: { proposalId: string }) => p.proposalId).filter((id: string) => id.startsWith("pending"));

    const plain = await call("GET", "/v1/operator-agent/proposals");
    assert.equal(plain.body.presentation, undefined);
    assert.deepEqual(pendingOrder(plain.body), ["pending-scale", "pending-fix"]);

    const proposed = await call("POST", "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "ordering", value: "fix" } });
    const id = proposed.body.preference.preferenceId as string;
    const shadow = await call("GET", "/v1/operator-agent/proposals?principalId=user_123&repository=owner%2Frepo");
    assert.deepEqual(pendingOrder(shadow.body), ["pending-scale", "pending-fix"], "a shadow-mode proposal changes nothing");
    assert.deepEqual(shadow.body.presentation.skipped, [{ preferenceId: id, reason: "proposed" }]);

    assert.equal((await call("POST", "/v1/operator-agent/preferences/accept", { preferenceId: id, scope: SCOPE })).status, 200);
    const applied = await call("GET", "/v1/operator-agent/proposals?principalId=user_123&repository=owner%2Frepo");
    assert.deepEqual(pendingOrder(applied.body), ["pending-fix", "pending-scale"]);
    assert.deepEqual(applied.body.presentation.applied, [id]);
    assert.deepEqual(applied.body.presentation.refusals, []);
    assert.deepEqual(applied.body.presentation.scope, SCOPE);

    const stop = await call("POST", "/v1/operator-agent/emergency/stop", {
      scope: "repository",
      scopeTarget: "owner/repo",
      reason: "incident",
      issuedBy: "operator",
      clearPolicy: "explicit-clear-required",
      incidentReceiptId: "incident-1",
    });
    assert.equal(stop.status, 201);
    const refused = await call("GET", "/v1/operator-agent/proposals?principalId=user_123&repository=owner%2Frepo");
    assert.deepEqual(pendingOrder(refused.body), ["pending-scale", "pending-fix"], "an accepted preference cannot lift a refused proposal");
    assert.ok(refused.body.presentation.refusals.some((r: { proposalId: string; code: string }) => r.proposalId === "pending-fix" && r.code === "emergency-stop-active"));

    assert.equal((await call("GET", "/v1/operator-agent/proposals?principalId=user_123")).status, 400);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
