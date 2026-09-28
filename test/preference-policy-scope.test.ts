// W1-T3895 acceptance: "a learned preference records principal scope, repository scope, source
// decisions, sample floor, confidence, freshness, and expiry".
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP } from "../src/lib/ledger.js";
import { buildOperatorAgentRoutes, OPERATOR_AGENT_DECISION_STEP, OPERATOR_AGENT_PROPOSAL_STEP } from "../src/lib/operator-agent.js";
import {
  inferPreferenceHypothesis,
  preferenceDecisionSamples,
  PREFERENCE_EXPIRY_MS,
  PREFERENCE_FRESHNESS_MS,
  PREFERENCE_SAMPLE_FLOOR,
  validatePreferenceEffect,
  validatePreferenceScope,
} from "../src/lib/preference-policy.js";
import { createService } from "../src/lib/service.js";

const READ = "pref-scope-read";
const WRITE = "pref-scope-write";
const T0 = Date.now();
const SCOPE = { principalId: "user_123", repository: "owner/repo" };

async function startServer(clock: { ms: number }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-pref-scope-"));
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
  return { ledgerPath, call, close: () => (server.close(), rmSync(root, { recursive: true, force: true })) };
}

function seed(ledgerPath: string, repo: string, category: string, decisions: string[], at: number, prefix: string): void {
  const rows = decisions.flatMap((decision, i) => {
    const proposalId = `${prefix}-${i}`;
    const iso = new Date(at + i * 1_000).toISOString();
    const proposal = { proposalId, repo, proposalText: "t", confidence: 0.5, reasoning: "r", category, status: "pending", createdAt: iso, evidence: [] };
    return [{ step: OPERATOR_AGENT_PROPOSAL_STEP, proposal }, { step: OPERATOR_AGENT_DECISION_STEP, proposal_id: proposalId, decision, at: iso }];
  });
  appendFileSync(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("a hypothesis records its principal and repository scope, source decisions, sample floor, confidence, freshness and expiry", () => {
  const at = (offset: number) => new Date(T0 - offset).toISOString();
  const decisions = [
    ...["accepted", "accepted", "accepted", "accepted", "accepted", "rejected"].map((decision, i) => ({
      decisionRef: `dec-fix-${i}`,
      proposalId: `fix-${i}`,
      category: "fix",
      decision,
      at: at((i + 2) * 60_000),
    })),
    { decisionRef: "dec-scale", proposalId: "scale-0", category: "scale", decision: "accepted", at: at(60_000) },
  ];
  const preference = inferPreferenceHypothesis({ scope: { ...SCOPE, surface: "agent-summary" }, effect: { kind: "ordering", value: "fix" }, decisions, now: T0 });

  assert.equal(preference.version, "operator-preference-v1");
  assert.deepEqual(preference.scope, { principalId: "user_123", repository: "owner/repo", surface: "agent-summary" });
  assert.deepEqual(preference.evidence.decisions.map((ref) => ref.decisionRef), ["dec-fix-0", "dec-fix-1", "dec-fix-2", "dec-fix-3", "dec-fix-4", "dec-fix-5"]);
  assert.equal(preference.evidence.sampleSize, 6);
  assert.equal(preference.evidence.supporting, 5);
  assert.equal(preference.evidence.contradicting, 1);
  assert.equal(preference.evidence.sampleFloor, PREFERENCE_SAMPLE_FLOOR);
  assert.equal(preference.measurability, "measured");
  assert.equal(preference.confidence, 0.83);
  assert.equal(preference.observedAt, new Date(T0).toISOString());
  assert.equal(preference.evidence.newestDecisionAt, at(120_000));
  assert.equal(preference.freshUntil, new Date(T0 - 120_000 + PREFERENCE_FRESHNESS_MS).toISOString());
  assert.equal(preference.expiresAt, new Date(T0 + PREFERENCE_EXPIRY_MS).toISOString());
  assert.equal(preference.mode, "shadow");
  assert.match(preference.explanation, /5 of 6 recent operator decisions support this/);
});

test("scope and effect validation refuses what the vocabulary does not name", () => {
  assert.equal(validatePreferenceScope({ principalId: "user_123" }), null);
  assert.equal(validatePreferenceScope({ ...SCOPE, surface: "" }), null);
  assert.equal(validatePreferenceScope("owner/repo"), null);
  assert.deepEqual(validatePreferenceScope({ principalId: " user_123 ", repository: "owner/repo ", surface: " rows " }), { ...SCOPE, surface: "rows" });
  assert.deepEqual(validatePreferenceEffect({ kind: "notification-style", value: "digest" }), { kind: "notification-style", value: "digest" });
  assert.equal(validatePreferenceEffect({ kind: "notification-style", value: "loud" }), null);
  assert.equal(validatePreferenceEffect({ kind: "grant-capability", value: "merge" }), null);
  assert.equal(validatePreferenceEffect({ kind: "ordering", value: "" }), null);
  assert.equal(validatePreferenceEffect(null), null);
});

test("decision samples are drawn only from the preference's repository", () => {
  const history = [
    { proposalId: "a", repo: "owner/repo", category: "fix", decisionHistory: [{ decision: "accepted", at: new Date(T0).toISOString() }] },
    { proposalId: "b", repo: "owner/other", category: "fix", decisionHistory: [{ decision: "accepted", at: new Date(T0).toISOString() }] },
  ];
  assert.deepEqual(preferenceDecisionSamples(history, "owner/repo").map((ref) => ref.proposalId), ["a"]);
});

test("the propose and read routes ledger and serve a scoped hypothesis in the console's projection", async () => {
  const clock = { ms: T0 };
  const h = await startServer(clock);
  try {
    seed(h.ledgerPath, "owner/repo", "fix", ["accepted", "accepted", "accepted", "accepted", "accepted", "more-info"], T0 - 3_600_000, "fix");
    seed(h.ledgerPath, "owner/other", "fix", ["rejected", "rejected", "rejected", "rejected", "rejected"], T0 - 3_600_000, "other");

    const proposed = await h.call("POST", "/v1/operator-agent/preferences/propose", { scope: { ...SCOPE, surface: "agent-summary" }, effect: { kind: "ordering", value: "fix" } });
    assert.equal(proposed.status, 201);
    assert.equal(proposed.body.existing, false);
    const id = proposed.body.preference.preferenceId as string;

    const row = readFileSync(h.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((r) => r.step === OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP);
    assert.equal(row.preference.preferenceId, id);
    assert.deepEqual(row.preference.scope, { ...SCOPE, surface: "agent-summary" });
    assert.equal(row.preference.evidence.sampleSize, 5, "other-repository rejections and a more-info decision do not measure ordering");
    assert.equal(row.preference.confidence, 1);

    const listed = await h.call("GET", "/v1/operator-agent/preferences?repository=owner%2Frepo&principalId=user_123");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.source, "ledger");
    assert.equal(listed.body.stale, false);
    const [projection] = listed.body.preferences;
    assert.equal(projection.version, "preference-hypothesis-v1");
    assert.deepEqual(projection.scope, { ...SCOPE, surface: "agent-summary" });
    assert.equal(projection.evidence.sampleFloor, PREFERENCE_SAMPLE_FLOOR);
    assert.equal(projection.evidence.freshness, "verified");
    assert.equal(projection.evidence.anchors.length, 5);
    assert.deepEqual(projection.confidence, { value: 1, source: "ledger:operator-agent-decisions", sampleFloor: PREFERENCE_SAMPLE_FLOOR });
    assert.equal(projection.freshness, "verified");
    assert.equal(projection.expiresAt, new Date(T0 + PREFERENCE_EXPIRY_MS).toISOString());
    assert.equal(projection.lifecycle, "proposed");
    assert.deepEqual(projection.application, { state: "shadow", effect: "Show fix proposals first.", nonAuthorityGuarantee: "presentation_only", reason: "proposed" });
    assert.equal(projection.source, "rmd:core:/v1/operator-agent/preferences#ledger");

    const again = await h.call("POST", "/v1/operator-agent/preferences/propose", { scope: { ...SCOPE, surface: "agent-summary" }, effect: { kind: "ordering", value: "fix" } });
    assert.equal(again.status, 200);
    assert.equal(again.body.existing, true);
    assert.equal(again.body.preference.preferenceId, id);

    const sameSurface = await h.call("GET", "/v1/operator-agent/preferences?repository=owner%2Frepo&principalId=user_123&surface=agent-summary");
    assert.equal(sameSurface.body.preferences.length, 1);
    const otherSurface = await h.call("GET", "/v1/operator-agent/preferences?repository=owner%2Frepo&principalId=user_123&surface=inbox");
    assert.equal(otherSurface.body.preferences.length, 0);
    const otherPrincipal = await h.call("GET", "/v1/operator-agent/preferences?repository=owner%2Frepo&principalId=user_456");
    assert.equal(otherPrincipal.body.preferences.length, 0);
    const otherRepository = await h.call("GET", "/v1/operator-agent/preferences?repository=owner%2Fother&principalId=user_123");
    assert.equal(otherRepository.body.preferences.length, 0);

    const unscoped = await h.call("GET", "/v1/operator-agent/preferences?repository=owner%2Frepo");
    assert.equal(unscoped.status, 400);
    const clientConfidence = await h.call("POST", "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "ordering", value: "fix" }, confidence: 0.99 });
    assert.equal(clientConfidence.status, 400);
    assert.match(clientConfidence.body.detail, /confidence/);
    assert.equal((await h.call("POST", "/v1/operator-agent/preferences/propose", { scope: { principalId: "user_123" }, effect: { kind: "ordering", value: "fix" } })).status, 400);
    assert.equal((await h.call("POST", "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "raise-budget", value: "100" } })).status, 400);
    assert.equal((await h.call("POST", "/v1/operator-agent/preferences/propose", [])).status, 400);
  } finally {
    h.close();
  }
});
