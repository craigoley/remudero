// test/operator-agent-consequences-decision.test.ts — W1-T4120 acceptance (4):
//   "an approve with a valid nonce is ledgered and the item leaves the pending list"
//   "a refuse is ledgered with its reason and shows as a receipt"
//   "a decision without a valid nonce is refused"
//   "a decision on an expired or unknown consequence is refused by name"
//
// The console's Approve/Refuse buttons POST /v1/operator-agent/consequences/decision. It is a
// HIGH-tier route, so every call here goes through the SAME server-side second factor
// write-tier-second-factor.test.ts already proves for other HIGH-tier routes: a bare bearer
// token with no `X-Confirm-Nonce` is refused outright, never reaching the handler.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import { createService, createConfirmNonceStore, makeConfirmNonceRoute, type IdentityProvider } from "../src/lib/service.js";
import {
  buildOperatorAgentRoutes,
  OPERATOR_AGENT_CONSEQUENCE_DECISION_STEP,
  OPERATOR_AGENT_CONSEQUENCES_DECISION_PATH,
  type PendingConsequenceRead,
} from "../src/lib/operator-agent.js";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const LIST = "/v1/operator-agent/consequences";
const DECISION = OPERATOR_AGENT_CONSEQUENCES_DECISION_PATH;

// A single credential that satisfies read+write at write-tier HIGH (write-tier-second-factor.test.ts's
// own precedent) -- every call in this suite authenticates the same way, so any refusal proved
// below is specifically the NONCE check, never a scope/tier shortfall.
const HIGH_HEADER = "x-high-grant";
const HIGH_SECRET = "consequences-decision-high-secret";
const HIGH_AUTH = { [HIGH_HEADER]: HIGH_SECRET };
const highGrantProvider: IdentityProvider = {
  name: "test-consequences-decision-high-provider",
  grant: (req) => (req.headers[HIGH_HEADER] === HIGH_SECRET ? new Set(["read", "write"] as const) : undefined),
  writeTier: "high",
};

async function withServer<T>(fn: (ctx: { base: string; ledgerPath: string }) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rmd-consequences-decision-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const store = createConfirmNonceStore();
  const server = createService({
    tokens: { read: "unused-read-token", write: "unused-write-token" },
    routes: [makeConfirmNonceRoute(store), ...buildOperatorAgentRoutes({ ledgerPath, now: () => NOW })],
    enforceWriteTiers: true,
    confirmNonces: store,
    providers: [highGrantProvider],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn({ base, ledgerPath });
  } finally {
    server.close();
  }
}

function financialAction(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    consequenceClass: "financial",
    target: { identity: `vendor:${id}`, source: "trusted" },
    requiredApprovers: 1,
    financial: {
      amount: 40,
      currency: "USD",
      perActionCeiling: 100,
      aggregateCeiling: 1_000,
      aggregateSpentBefore: 0,
      quoteExpiresAt: iso(3_600_000),
      coolingOffSeconds: 0,
      coolingOffStartedAt: iso(-60_000),
    },
    ...overrides,
  };
}

async function preflight(base: string, action: unknown): Promise<number> {
  const res = await fetch(`${base}/v1/operator-agent/consequence/preflight`, {
    method: "POST",
    headers: { ...HIGH_AUTH, "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  await res.text();
  return res.status;
}

async function readList(base: string): Promise<PendingConsequenceRead> {
  const res = await fetch(`${base}${LIST}`, { headers: HIGH_AUTH });
  return (await res.json()) as PendingConsequenceRead;
}

/** Issues a nonce for exactly this body via `POST /v1/confirm`, then presents it -- the real,
 *  two-step round trip every HIGH-tier caller (the console included) must make. */
async function decide(base: string, body: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(body);
  const issued = await fetch(`${base}/v1/confirm`, {
    method: "POST",
    headers: { ...HIGH_AUTH, "content-type": "application/json" },
    body: JSON.stringify({ method: "POST", path: DECISION, payload }),
  });
  assert.equal(issued.status, 200);
  const { nonce } = (await issued.json()) as { nonce: string };
  return fetch(`${base}${DECISION}`, {
    method: "POST",
    headers: { ...HIGH_AUTH, "content-type": "application/json", "x-confirm-nonce": nonce },
    body: payload,
  });
}

test("W1-T4120 (1): an approve with a valid nonce is ledgered and the item leaves the pending list", async () => {
  await withServer(async ({ base, ledgerPath }) => {
    assert.equal(await preflight(base, financialAction("cq-approve")), 409);
    assert.deepEqual((await readList(base)).consequences.map((c) => c.consequenceId), ["cq-approve"]);

    const res = await decide(base, { consequenceId: "cq-approve", decision: "approve", reason: "reviewed and cleared by finance" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; consequenceId: string; decision: string; receipt: Record<string, unknown> };
    assert.equal(body.ok, true);
    assert.equal(body.consequenceId, "cq-approve");
    assert.equal(body.decision, "approve");
    assert.equal(body.receipt.consequenceId, "cq-approve");
    assert.equal(body.receipt.decision, "approve");
    assert.equal(body.receipt.reason, "reviewed and cleared by finance");

    // Cleared: gone from the pending list.
    assert.deepEqual((await readList(base)).consequences, []);

    // Ledgered: a decision row with the right step, actor-bound id, and the reason.
    const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const decisionRow = rows.find((row) => row.step === OPERATOR_AGENT_CONSEQUENCE_DECISION_STEP);
    assert.ok(decisionRow, "a decision row must be appended to the ledger");
    assert.equal(decisionRow.consequence_id, "cq-approve");
    assert.equal(decisionRow.decision, "approve");
    assert.equal(decisionRow.reason, "reviewed and cleared by finance");
  });
});

test("W1-T4120 (2): a refuse is ledgered with its reason and shows as a receipt", async () => {
  await withServer(async ({ base, ledgerPath }) => {
    assert.equal(await preflight(base, financialAction("cq-refuse")), 409);

    const res = await decide(base, { consequenceId: "cq-refuse", decision: "refuse", reason: "vendor identity could not be verified" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; decision: string; receipt: Record<string, unknown> };
    assert.equal(body.ok, true);
    assert.equal(body.decision, "refuse");
    assert.equal(body.receipt.decision, "refuse");
    assert.equal(body.receipt.reason, "vendor identity could not be verified");
    assert.equal(typeof body.receipt.decidedBy, "string");
    assert.equal(typeof body.receipt.decidedAt, "string");

    // A refusal also clears the item -- it has been decided, not left open.
    assert.deepEqual((await readList(base)).consequences, []);

    const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const decisionRow = rows.find((row) => row.step === OPERATOR_AGENT_CONSEQUENCE_DECISION_STEP);
    assert.ok(decisionRow);
    assert.equal(decisionRow.decision, "refuse");
    assert.equal(decisionRow.reason, "vendor identity could not be verified");
    assert.equal(decisionRow.receipt.reason, "vendor identity could not be verified");
  });
});

test("W1-T4120 (3): a decision without a valid nonce is refused", async () => {
  await withServer(async ({ base, ledgerPath }) => {
    assert.equal(await preflight(base, financialAction("cq-no-nonce")), 409);
    const ledgerBefore = readFileSync(ledgerPath, "utf8");

    // No X-Confirm-Nonce header at all.
    const bare = await fetch(`${base}${DECISION}`, {
      method: "POST",
      headers: { ...HIGH_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ consequenceId: "cq-no-nonce", decision: "approve", reason: "looks fine" }),
    });
    assert.equal(bare.status, 403);
    assert.equal(((await bare.json()) as { error: string }).error, "confirm_nonce_required");

    // A garbage nonce is refused the same way.
    const garbage = await fetch(`${base}${DECISION}`, {
      method: "POST",
      headers: { ...HIGH_AUTH, "content-type": "application/json", "x-confirm-nonce": "not-a-real-nonce" },
      body: JSON.stringify({ consequenceId: "cq-no-nonce", decision: "approve", reason: "looks fine" }),
    });
    assert.equal(garbage.status, 403);

    // Nothing was recorded, and the item is still pending.
    assert.equal(readFileSync(ledgerPath, "utf8"), ledgerBefore);
    assert.deepEqual((await readList(base)).consequences.map((c) => c.consequenceId), ["cq-no-nonce"]);
  });
});

test("W1-T4120 (4): a decision on an unknown consequence is refused by name", async () => {
  await withServer(async ({ base }) => {
    const res = await decide(base, { consequenceId: "cq-never-existed", decision: "approve", reason: "n/a" });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, "not_found");
    assert.match(body.detail, /cq-never-existed/);
  });
});

test("W1-T4120 (4): a decision on an expired consequence is refused by name", async () => {
  await withServer(async ({ base }) => {
    // A financial preflight whose quote has already expired at NOW never enters the pending list.
    assert.equal(
      await preflight(base, financialAction("cq-expired", { financial: { ...financialAction("cq-expired").financial, quoteExpiresAt: iso(-1) } })),
      409,
    );
    assert.deepEqual((await readList(base)).consequences, []);

    const res = await decide(base, { consequenceId: "cq-expired", decision: "approve", reason: "n/a" });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, "not_found");
    assert.match(body.detail, /cq-expired/);
  });
});

test("W1-T4120: a decision on an already-decided consequence is refused by name, not double-ledgered", async () => {
  await withServer(async ({ base, ledgerPath }) => {
    assert.equal(await preflight(base, financialAction("cq-twice")), 409);
    const first = await decide(base, { consequenceId: "cq-twice", decision: "approve", reason: "first pass" });
    assert.equal(first.status, 200);

    const ledgerAfterFirst = readFileSync(ledgerPath, "utf8");
    const second = await decide(base, { consequenceId: "cq-twice", decision: "refuse", reason: "second pass" });
    assert.equal(second.status, 404);
    assert.equal(readFileSync(ledgerPath, "utf8"), ledgerAfterFirst, "a decision on an already-decided item must write nothing");
  });
});
