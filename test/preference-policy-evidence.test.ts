// W1-T3895 acceptance: "preference evidence is linked to bounded operator decisions and never
// stores raw prompts or transcripts".
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATOR_PREFERENCE_EVENT_LEDGER_STEP, OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP } from "../src/lib/ledger.js";
import { buildOperatorAgentRoutes, OPERATOR_AGENT_DECISION_STEP, OPERATOR_AGENT_PROPOSAL_STEP } from "../src/lib/operator-agent.js";
import {
  inferPreferenceHypothesis,
  preferenceDecisionSamples,
  validateOperatorPreference,
  validatePreferenceDecisionRef,
} from "../src/lib/preference-policy.js";
import { createService } from "../src/lib/service.js";

const READ = "pref-evidence-read";
const WRITE = "pref-evidence-write";
const T0 = Date.now();
const SCOPE = { principalId: "user_123", repository: "owner/repo" };
const RAW = "RAW-PRIVATE-PROMPT-7f3a";

async function startServer(clock: { ms: number }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-pref-evidence-"));
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

/** Proposals whose text and reasoning, and decisions whose notes, all carry the raw sentinel. */
function seedWithRawText(ledgerPath: string, decisions: string[], at: number): void {
  const rows = decisions.flatMap((decision, i) => {
    const proposalId = `raw-${i}`;
    const iso = new Date(at + i * 1_000).toISOString();
    const proposal = { proposalId, repo: SCOPE.repository, proposalText: `${RAW} text`, confidence: 0.5, reasoning: `${RAW} reasoning`, category: "fix", status: "pending", createdAt: iso, evidence: [] };
    return [{ step: OPERATOR_AGENT_PROPOSAL_STEP, proposal }, { step: OPERATOR_AGENT_DECISION_STEP, proposal_id: proposalId, decision, at: iso, note: `${RAW} note` }];
  });
  appendFileSync(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("decision samples carry only identity, category, verdict and time — never a note or proposal text", () => {
  const history = [
    {
      proposalId: "p1",
      repo: "owner/repo",
      category: "fix",
      proposalText: `${RAW} text`,
      reasoning: `${RAW} reasoning`,
      decisionHistory: [{ decision: "accepted", at: new Date(T0).toISOString(), note: `${RAW} note` }],
    },
  ];
  const [sample] = preferenceDecisionSamples(history, "owner/repo");
  assert.deepEqual(Object.keys(sample!).sort(), ["at", "category", "decision", "decisionRef", "proposalId"]);
  assert.match(sample!.decisionRef, /^dec-[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(sample).includes(RAW), false);
  assert.equal(preferenceDecisionSamples(history, "owner/repo")[0]!.decisionRef, sample!.decisionRef, "a decision reference is stable");
});

test("a sample carrying a raw prompt or transcript is refused whole and never enters the hypothesis", () => {
  const good = (i: number) => ({ decisionRef: `dec-${i}`, proposalId: `p-${i}`, category: "fix", decision: "accepted", at: new Date(T0 - i * 1_000).toISOString() });
  const decisions = [good(1), good(2), good(3), good(4), good(5), { ...good(6), rawPrompt: RAW }, { ...good(7), transcriptText: RAW }];
  const preference = inferPreferenceHypothesis({ scope: SCOPE, effect: { kind: "ordering", value: "fix" }, decisions, now: T0 });
  assert.equal(preference.evidence.refusedSamples, 2);
  assert.equal(preference.evidence.sampleSize, 5);
  assert.equal(JSON.stringify(preference).includes(RAW), false);

  assert.equal(validatePreferenceDecisionRef({ ...good(1), note: RAW }), null);
  assert.equal(validatePreferenceDecisionRef({ ...good(1), decision: "approved" }), null);
  assert.equal(validatePreferenceDecisionRef({ ...good(1), at: "yesterday" }), null);
  assert.equal(validatePreferenceDecisionRef({ ...good(1), category: "" }), null);
  assert.equal(validatePreferenceDecisionRef([good(1)]), null);

  // A ledgered record whose evidence smuggles a note is refused at read, not trusted.
  const tampered = JSON.parse(JSON.stringify(preference));
  assert.ok(validateOperatorPreference(tampered));
  tampered.evidence.decisions[0].note = RAW;
  assert.equal(validateOperatorPreference(tampered), null);
  assert.equal(validateOperatorPreference({ ...preference, evidence: { ...preference.evidence, sampleSize: -1 } }), null);
});

test("the ledger holds decision references and digests, never the raw text the operator typed", async () => {
  const clock = { ms: T0 };
  const h = await startServer(clock);
  try {
    seedWithRawText(h.ledgerPath, ["accepted", "accepted", "accepted", "accepted", "rejected"], T0 - 3_600_000);
    const refused = await h.call("POST", "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "ordering", value: "fix" }, rawPrompt: RAW });
    assert.equal(refused.status, 400);

    const proposed = await h.call("POST", "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "ordering", value: "fix" } });
    assert.equal(proposed.status, 201);
    const id = proposed.body.preference.preferenceId as string;

    const corrected = await h.call("POST", "/v1/operator-agent/preferences/correct", {
      action: "correct",
      preferenceId: id,
      scope: SCOPE,
      correction: `${RAW} correction`,
      note: `${RAW} note`,
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.body.hasNote, true);
    assert.match(corrected.body.correctionDigest, /^[0-9a-f]{32}$/);

    const rows = readFileSync(h.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const preferenceRows = rows.filter((row) => row.step === OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP || row.step === OPERATOR_PREFERENCE_EVENT_LEDGER_STEP);
    assert.equal(preferenceRows.length, 2);
    assert.equal(JSON.stringify(preferenceRows).includes(RAW), false, "no proposal text, reasoning, note, or correction reaches a preference row");

    const [proposedRow] = preferenceRows;
    const decisionIds = proposedRow.preference.evidence.decisions.map((ref: { proposalId: string }) => ref.proposalId).sort();
    assert.deepEqual(decisionIds, ["raw-0", "raw-1", "raw-2", "raw-3", "raw-4"], "every evidence entry links to a ledgered operator decision");

    const listed = await h.call("GET", "/v1/operator-agent/preferences?repository=owner%2Frepo&principalId=user_123");
    assert.deepEqual(
      listed.body.preferences[0].evidence.anchors.sort(),
      proposedRow.preference.evidence.decisions.map((ref: { decisionRef: string }) => ref.decisionRef).sort(),
    );
    assert.equal(JSON.stringify(listed.body).includes(RAW), false);
  } finally {
    h.close();
  }
});
