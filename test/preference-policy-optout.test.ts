// W1-T3895 acceptance: "operators can opt out or delete a preference and receive a durable receipt".
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DECISION_RELEVANT_LEDGER_STEPS, OPERATOR_PREFERENCE_EVENT_LEDGER_STEP, OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP } from "../src/lib/ledger.js";
import { buildOperatorAgentRoutes, OPERATOR_AGENT_DECISION_STEP, OPERATOR_AGENT_PROPOSAL_STEP } from "../src/lib/operator-agent.js";
import { createService } from "../src/lib/service.js";

const READ = "pref-optout-read";
const WRITE = "pref-optout-write";
const T0 = Date.now();
const SCOPE = { principalId: "user_123", repository: "owner/repo" };
const LIST = "/v1/operator-agent/preferences?repository=owner%2Frepo&principalId=user_123";

async function startServer(ledgerPath: string, clock: { ms: number }) {
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
  return { call, close: () => server.close() };
}

function stateDir(): { root: string; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-pref-optout-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const rows = Array.from({ length: 5 }, (_, i) => {
    const proposal = { proposalId: `p-${i}`, repo: "owner/repo", proposalText: "t", confidence: 0.5, reasoning: "r", category: "fix", status: "pending", createdAt: new Date(T0 - 60_000).toISOString(), evidence: [] };
    return [{ step: OPERATOR_AGENT_PROPOSAL_STEP, proposal }, { step: OPERATOR_AGENT_DECISION_STEP, proposal_id: `p-${i}`, decision: "accepted", at: new Date(T0 - 60_000 + i).toISOString() }];
  }).flat();
  writeFileSync(ledgerPath, "");
  appendFileSync(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { root, ledgerPath };
}

test("preference rows survive ledger rotation, so an opt-out or deletion cannot be forgotten", () => {
  assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has(OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP), true);
  assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has(OPERATOR_PREFERENCE_EVENT_LEDGER_STEP), true);
});

test("opting out returns a durable linked receipt, stays visible, blocks acceptance and re-learning, and is idempotent", async () => {
  const clock = { ms: T0 };
  const { root, ledgerPath } = stateDir();
  const h = await startServer(ledgerPath, clock);
  try {
    const proposed = await h.call("POST", "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "ordering", value: "fix" } });
    const id = proposed.body.preference.preferenceId as string;

    const optOut = await h.call("POST", "/v1/operator-agent/preferences/opt-out", { action: "opt-out", preferenceId: id, scope: SCOPE, requestId: "opt-r1" });
    assert.equal(optOut.status, 200);
    assert.equal(optOut.body.ok, true);
    assert.equal(optOut.body.lifecycle, "opted_out");
    assert.equal(optOut.body.previousLifecycle, "proposed");
    assert.equal(optOut.body.linkedTo, id);
    assert.match(optOut.body.receiptId, /^prefrcpt-[0-9a-f]{20}$/);
    assert.equal(optOut.body.at, new Date(T0).toISOString());

    const ledgered = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.step === OPERATOR_PREFERENCE_EVENT_LEDGER_STEP);
    assert.equal(ledgered.length, 1);
    assert.equal(ledgered[0].event.receiptId, optOut.body.receiptId);

    const replay = await h.call("POST", "/v1/operator-agent/preferences/opt-out", { preferenceId: id, scope: SCOPE, requestId: "opt-r1" });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.receiptId, optOut.body.receiptId, "a repeated requestId returns the original receipt");
    const again = await h.call("POST", "/v1/operator-agent/preferences/opt-out", { preferenceId: id, scope: SCOPE });
    assert.equal(again.body.code, "opted_out");

    const listed = await h.call("GET", LIST);
    assert.equal(listed.body.preferences[0].lifecycle, "opted_out", "an opt-out is shown, never hidden");
    assert.equal(listed.body.preferences[0].application.state, "not_applied");
    assert.deepEqual(listed.body.preferences[0].receipts, [{ receiptId: optOut.body.receiptId, action: "opt-out", lifecycle: "opted_out", at: optOut.body.at }]);

    const accept = await h.call("POST", "/v1/operator-agent/preferences/accept", { preferenceId: id, scope: SCOPE });
    assert.equal(accept.status, 409);
    assert.equal(accept.body.code, "opted_out");
    const relearn = await h.call("POST", "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "ordering", value: "scale" } });
    assert.equal(relearn.status, 409);
    assert.equal(relearn.body.code, "opted_out");
  } finally {
    h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("deletion returns a linked receipt, withholds the evidence, is terminal, and survives a restart", async () => {
  const clock = { ms: T0 };
  const { root, ledgerPath } = stateDir();
  const first = await startServer(ledgerPath, clock);
  let id = "";
  let optOutReceipt = "";
  try {
    const proposed = await first.call("POST", "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "ordering", value: "fix" } });
    id = proposed.body.preference.preferenceId as string;
    optOutReceipt = (await first.call("POST", "/v1/operator-agent/preferences/opt-out", { preferenceId: id, scope: SCOPE })).body.receiptId;
    clock.ms = T0 + 1_000;
    const deleted = await first.call("POST", "/v1/operator-agent/preferences/delete", { action: "delete", preferenceId: id, scope: SCOPE });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.lifecycle, "deleted");
    assert.equal(deleted.body.previousLifecycle, "opted_out");
    assert.equal(deleted.body.previousReceiptId, optOutReceipt);
    assert.notEqual(deleted.body.receiptId, optOutReceipt);
  } finally {
    first.close();
  }

  const restarted = await startServer(ledgerPath, clock);
  try {
    const [projection] = (await restarted.call("GET", LIST)).body.preferences;
    assert.equal(projection.lifecycle, "deleted");
    assert.equal(projection.evidence.summary, "withheld after deletion");
    assert.equal(projection.evidence.anchors, undefined);
    assert.match(projection.explanation, /Deleted by the operator/);
    assert.deepEqual(projection.receipts.map((r: { action: string }) => r.action), ["opt-out", "delete"]);

    for (const action of ["accept", "reject", "opt-out", "delete"]) {
      const after = await restarted.call("POST", `/v1/operator-agent/preferences/${action}`, { preferenceId: id, scope: SCOPE });
      assert.equal(after.status, 409, action);
      assert.equal(after.body.code, "already_deleted");
    }
  } finally {
    restarted.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an action names an existing preference in its own scope, on its own route, with bounded fields", async () => {
  const clock = { ms: T0 };
  const { root, ledgerPath } = stateDir();
  const h = await startServer(ledgerPath, clock);
  try {
    const id = (await h.call("POST", "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "ordering", value: "fix" } })).body.preference.preferenceId as string;
    const missing = await h.call("POST", "/v1/operator-agent/preferences/delete", { preferenceId: "pref-nope", scope: SCOPE });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "not_found");
    const otherScope = await h.call("POST", "/v1/operator-agent/preferences/delete", { preferenceId: id, scope: { ...SCOPE, principalId: "user_456" } });
    assert.equal(otherScope.status, 409);
    assert.equal(otherScope.body.code, "scope_mismatch");

    const invalid: unknown[] = [
      [],
      { action: "delete", preferenceId: id, scope: SCOPE, authority: { approve: true } },
      { action: "accept", preferenceId: id, scope: SCOPE },
      { preferenceId: id },
      { preferenceId: id, scope: SCOPE, note: "" },
      { preferenceId: id, scope: SCOPE, requestId: "" },
      { preferenceId: id, scope: SCOPE, correction: "" },
    ];
    for (const body of invalid) {
      assert.equal((await h.call("POST", "/v1/operator-agent/preferences/opt-out", body)).status, 400, JSON.stringify(body));
    }
    const withCorrection = await h.call("POST", "/v1/operator-agent/preferences/opt-out", { preferenceId: id, scope: SCOPE, correction: "stop learning this" });
    assert.equal(withCorrection.status, 200);
    assert.match(withCorrection.body.correctionDigest, /^[0-9a-f]{32}$/);
  } finally {
    h.close();
    rmSync(root, { recursive: true, force: true });
  }
});
