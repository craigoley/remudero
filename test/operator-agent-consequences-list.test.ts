// test/operator-agent-consequences-list.test.ts — W1-T4104: the console's /approvals page reads
// GET /v1/operator-agent/consequences; core served only the preflight, so the page 404'd. These
// tests drive the REAL preflight route to create pending approvals, then read them back through the
// list route exactly as the console does (bearer read token, JSON body with a `consequences` array).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import { createService } from "../src/lib/service.js";
import { appendPanelLedger } from "../src/lib/panel-actions.js";
import {
  buildOperatorAgentRoutes,
  MAX_PENDING_CONSEQUENCES,
  OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP,
  OPERATOR_AGENT_CONSEQUENCES_SOURCE,
  type PendingConsequenceRead,
} from "../src/lib/operator-agent.js";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const READ_TOKEN = "consequences-list-read-token";
const WRITE_TOKEN = "consequences-list-write-token";
const LIST = "/v1/operator-agent/consequences";

async function withServer(fn: (ctx: { base: string; ledgerPath: string }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rmd-consequences-list-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: buildOperatorAgentRoutes({ ledgerPath, now: () => NOW }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({ base, ledgerPath });
  } finally {
    server.close();
  }
}

async function preflight(base: string, action: unknown): Promise<number> {
  const res = await fetch(`${base}/v1/operator-agent/consequence/preflight`, {
    method: "POST",
    headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  await res.text();
  return res.status;
}

async function readList(base: string): Promise<{ status: number; body: PendingConsequenceRead }> {
  const res = await fetch(`${base}${LIST}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
  return { status: res.status, body: (await res.json()) as PendingConsequenceRead };
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

function irreversibleAction(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    consequenceClass: "irreversible",
    target: { identity: `db:${id}`, source: "trusted" },
    requiredApprovers: 1,
    irreversible: {
      affectedResource: "table:orders",
      recoveryAvailable: false,
      recoveryStatement: "dropping this table cannot be undone",
      rollbackUnavailableReason: "no backup snapshot exists",
      confirmationNonce: "nonce-1",
      confirmationExpiresAt: iso(1_800_000),
    },
    ...overrides,
  };
}

test("pending consequence approvals are listed read-only and bounded", async () => {
  await withServer(async ({ base, ledgerPath }) => {
    // Pending: refused for missing approvers (financial + irreversible), and stale evidence later.
    assert.equal(await preflight(base, financialAction("cq-fin")), 409);
    assert.equal(
      await preflight(base, irreversibleAction("cq-irr", { evidence: [{ label: "row count", observedAt: iso(-10_000), maxAgeSeconds: 3_600 }] })),
      409,
    );
    // NOT pending: approved (ready), a dead refusal (over ceiling), and a reversible action.
    assert.equal(
      await preflight(base, financialAction("cq-ready", { approvals: [{ approverId: "operator:alice", approvedAt: iso(-1_000), source: "trusted" }] })),
      200,
    );
    assert.equal(await preflight(base, financialAction("cq-over", { financial: { ...financialAction("x").financial, amount: 500 } })), 409);
    assert.equal(await preflight(base, { id: "cq-rev", consequenceClass: "reversible", target: { identity: "svc", source: "trusted" }, requiredApprovers: 0 }), 200);

    const first = await readList(base);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.consequences.map((c) => c.consequenceId).sort(), ["cq-fin", "cq-irr"]);
    const fin = first.body.consequences.find((c) => c.consequenceId === "cq-fin")!;
    // The exact consequence-v1 shape the console's normalizedConsequenceRecord accepts.
    assert.deepEqual(fin, {
      consequenceId: "cq-fin",
      classes: ["financial"],
      target: "vendor:cq-fin",
      amountUsd: 40,
      currency: "USD",
      ceilingUsd: 100,
      coolingOffMs: 0,
      coolingOffUntil: iso(-60_000),
      expiresAt: iso(3_600_000),
      approverRequired: true,
      recoveryStatement: fin.recoveryStatement,
      freshness: "verified",
      observedAt: iso(0),
      receipts: [],
      source: OPERATOR_AGENT_CONSEQUENCES_SOURCE,
    });
    assert.ok(fin.recoveryStatement.length > 0 && fin.recoveryStatement.length <= 1_000);
    const irr = first.body.consequences.find((c) => c.consequenceId === "cq-irr")!;
    assert.equal(irr.recoveryStatement, "dropping this table cannot be undone");
    assert.equal(irr.amountUsd, undefined);
    assert.equal(irr.currency, undefined);
    assert.equal(first.body.source, "ledger");
    assert.equal(first.body.generatedAt, iso(0));
    assert.equal(first.body.truncated, false);
    assert.equal(first.body.total, 2);

    // READ-ONLY: a read appends nothing to the ledger, and a second read answers the same list.
    const ledgerBefore = readFileSync(ledgerPath, "utf8");
    const second = await readList(base);
    assert.equal(readFileSync(ledgerPath, "utf8"), ledgerBefore);
    assert.deepEqual(second.body, first.body);

    // A later READY preflight for the same action takes it out of the queue — latest row wins.
    assert.equal(
      await preflight(base, financialAction("cq-fin", { approvals: [{ approverId: "operator:bob", approvedAt: iso(-1_000), source: "trusted" }] })),
      200,
    );
    assert.deepEqual((await readList(base)).body.consequences.map((c) => c.consequenceId), ["cq-irr"]);

    // A pending row written before W1-T4104 carries no projection: counted, never invented.
    appendPanelLedger(ledgerPath, OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP, "cq-legacy", "test", {
      action_id: "cq-legacy",
      consequence_class: "financial",
      ready: false,
      at: iso(0),
      code: "missing-approvers",
      reason: "legacy",
    });
    // BOUNDED: more pending rows than the max answers exactly the max, flagged truncated.
    const approval = { target: "vendor:bulk", expiresAt: iso(60_000), approverRequired: true, recoveryStatement: "none" };
    for (let i = 0; i < MAX_PENDING_CONSEQUENCES + 5; i++) {
      appendPanelLedger(ledgerPath, OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP, `cq-bulk-${i}`, "test", {
        action_id: `cq-bulk-${i}`,
        consequence_class: "irreversible",
        ready: false,
        at: iso(-i),
        code: "missing-approvers",
        reason: "bulk",
        approval,
      });
    }
    // An expired one is not pending any more.
    appendPanelLedger(ledgerPath, OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP, "cq-expired", "test", {
      action_id: "cq-expired",
      consequence_class: "irreversible",
      ready: false,
      at: iso(0),
      code: "missing-approvers",
      reason: "expired",
      approval: { ...approval, expiresAt: iso(-1) },
    });
    const bounded = (await readList(base)).body;
    assert.equal(bounded.consequences.length, MAX_PENDING_CONSEQUENCES);
    assert.equal(bounded.max, MAX_PENDING_CONSEQUENCES);
    assert.equal(bounded.total, MAX_PENDING_CONSEQUENCES + 6);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.unprojected, 1);
    assert.ok(!bounded.consequences.some((c) => c.consequenceId === "cq-expired" || c.consequenceId === "cq-legacy"));
  });
});

test("an empty approval queue answers an empty list with its read time", async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await readList(base);
    assert.equal(status, 200);
    assert.deepEqual(body, {
      state: "verified",
      consequences: [],
      source: "ledger",
      generatedAt: iso(0),
      max: MAX_PENDING_CONSEQUENCES,
      total: 0,
      truncated: false,
      unprojected: 0,
    });
  });
});

test("pending evidence past its own freshness bound is listed stale, not verified", async () => {
  await withServer(async ({ base }) => {
    // Evidence observed 50s ago with a 60s bound passes preflight now; the list re-reads at NOW so
    // it is verified. A row whose evidence bound already passed at NOW reads stale.
    assert.equal(
      await preflight(base, irreversibleAction("cq-fresh", { evidence: [{ label: "quote", observedAt: iso(-50_000), maxAgeSeconds: 60 }] })),
      409,
    );
    assert.equal(
      await preflight(base, irreversibleAction("cq-edge", { evidence: [{ label: "quote", observedAt: iso(-60_000), maxAgeSeconds: 60 }] })),
      409,
    );
    const byId = new Map((await readList(base)).body.consequences.map((c) => [c.consequenceId, c.freshness]));
    assert.equal(byId.get("cq-fresh"), "verified");
    assert.equal(byId.get("cq-edge"), "stale");
  });
});

test("the consequence list refuses a write verb by name", async () => {
  await withServer(async ({ base }) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${base}${LIST}`, {
        method,
        headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ consequenceId: "cq-x", action: "approve" }),
      });
      assert.equal(res.status, 405, `${method} must be refused, not 404/200`);
      assert.equal(res.headers.get("allow"), "GET");
      const body = (await res.json()) as { error: string; method: string; path: string; detail: string };
      assert.equal(body.error, "read_only");
      assert.equal(body.method, method);
      assert.equal(body.path, LIST);
      assert.match(body.detail, new RegExp(`^${method} /v1/operator-agent/consequences refused`));
    }
    // Nothing was recorded by the refused writes: the queue is still empty.
    assert.deepEqual((await readList(base)).body.consequences, []);
  });
});
