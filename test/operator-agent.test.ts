import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import {
  buildOperatorAgentRoutes,
  createOperatorAgentMemorySource,
  readOperatorAgentHistory,
  OPERATOR_AGENT_PROPOSAL_STEP,
  type OperatorAgentMemorySource,
  type OperatorAgentProposal,
} from "../src/lib/operator-agent.js";

const READ_TOKEN = "operator-agent-read-token";
const WRITE_TOKEN = "operator-agent-write-token";

/** W1-T3270's rule, applied here: anything the SERVICE ages against the wall clock has to be
 *  stamped from the wall clock. `expiresAt` was the fixed literal "2026-09-20T10:00:00.000Z", and
 *  `buildOperatorAgentHistory` marks a proposal `expired` on `Date.parse(expiresAt) <= now` with
 *  `now` defaulting to the REAL clock. The two cases below that do not inject a clock therefore
 *  went red the moment that instant passed — 10:00Z on 2026-09-20, with no diff involved — because
 *  a proposal they need LIVE started reading `expired` and the decision route answered 409 instead
 *  of 200. The census cannot catch this one: it scans `lastActivityAt` stamps, and this is an
 *  `expiresAt`.
 *
 *  The offsets are what the cases actually depend on, so they are what is preserved: created a day
 *  behind, expiring a day ahead. The expiry case derives its injected clock from `expiresAt`
 *  instead of naming an instant, so "after expiry" stays true by construction rather than by
 *  coincidence of the calendar. */
const FIXTURE_DAY_MS = 24 * 60 * 60 * 1000;

function fixture(): { ledgerPath: string; proposal: OperatorAgentProposal } {
  const root = mkdtempSync(join(tmpdir(), "rmd-operator-agent-"));
  const nowMs = Date.now();
  const createdAt = new Date(nowMs - FIXTURE_DAY_MS).toISOString();
  const expiresAt = new Date(nowMs + FIXTURE_DAY_MS).toISOString();
  mkdirSync(join(root, "state"), { recursive: true });
  return {
    ledgerPath: join(root, "state", "ledger.ndjson"),
    proposal: {
      proposalId: "operator-agent:repo:scale:queue-pressure",
      repo: "owner/repo",
      proposalText: "Increase the worker pool for owner/repo.",
      confidence: 0.96,
      reasoning: "The queue and p50 latency crossed the conservative threshold together.",
      category: "scale",
      status: "pending",
      createdAt,
      expiresAt,
      evidence: [{
        label: "Queued tasks",
        value: "8",
        source: "run-ledger",
        observedAt: createdAt,
        freshness: "verified",
      }],
    },
  };
}

async function withService<T>(ledgerPath: string, fn: (base: string) => Promise<T>, now?: () => number, memory?: OperatorAgentMemorySource): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildOperatorAgentRoutes({ ledgerPath, now, memory }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function post(base: string, path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(base: string, token: string): Promise<Response> {
  return fetch(`${base}/v1/operator-agent/proposals`, { headers: { authorization: `Bearer ${token}` } });
}

function getSettings(base: string, token: string): Promise<Response> {
  return fetch(`${base}/v1/operator-agent/settings`, { headers: { authorization: `Bearer ${token}` } });
}

test("operator-agent routes keep reads separate from writes and persist proposal decisions in the ledger", async () => {
  const { ledgerPath, proposal } = fixture();
  await withService(ledgerPath, async (base) => {
    assert.equal((await get(base, READ_TOKEN)).status, 200);
    assert.equal((await post(base, "/v1/operator-agent/proposals", READ_TOKEN, { proposal })).status, 403);

    const registered = await post(base, "/v1/operator-agent/proposals", WRITE_TOKEN, { proposal });
    assert.equal(registered.status, 201);
    assert.equal((await post(base, "/v1/operator-agent/proposals", WRITE_TOKEN, { proposal })).status, 200);

    const moreInfo = await post(base, "/v1/operator-agent/proposals/decision", WRITE_TOKEN, {
      proposalId: proposal.proposalId,
      decision: "more-info",
      note: "Show the queue window next time.",
    });
    assert.equal(moreInfo.status, 200);

    const accepted = await post(base, "/v1/operator-agent/proposals/decision", WRITE_TOKEN, {
      proposalId: proposal.proposalId,
      decision: "accepted",
    });
    assert.equal(accepted.status, 200);

    const history = (await (await get(base, READ_TOKEN)).json()) as {
      source: string;
      proposals: Array<{ status: string; outcome?: unknown; decisionHistory: Array<{ decision: string }> }>;
    };
    assert.equal(history.source, "ledger");
    assert.equal(history.proposals[0]?.status, "accepted");
    assert.deepEqual(history.proposals[0]?.decisionHistory.map((entry) => entry.decision), ["more-info", "accepted"]);
    assert.equal(history.proposals[0]?.outcome, undefined);

    const outcome = await post(base, "/v1/operator-agent/proposals/outcome", WRITE_TOKEN, {
      proposalId: proposal.proposalId,
      outcome: { summary: "Queue latency fell after the pool change.", helped: true, observedAt: "2026-09-19T11:00:00.000Z" },
    });
    assert.equal(outcome.status, 200);

    const afterOutcome = (await (await get(base, READ_TOKEN)).json()) as { proposals: Array<{ outcome?: { helped?: boolean } }> };
    assert.equal(afterOutcome.proposals[0]?.outcome?.helped, true);
  });

  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(lines.map((line) => line.step), [
    "panel.operator_agent_proposal",
    "panel.operator_agent_decision",
    "panel.operator_agent_decision",
    "panel.operator_agent_outcome",
  ]);
  assert.equal(lines[1]?.proposal_id, proposal.proposalId);
});

test("unit test: operator-agent reads use the refreshed memory snapshot without a synchronous union read", async () => {
  const { ledgerPath, proposal } = fixture();
  const memory: OperatorAgentMemorySource = {
    current: () => ({ state: "ready", asOf: "2026-09-21T00:00:00.000Z", rows: [{ step: OPERATOR_AGENT_PROPOSAL_STEP, proposal }] }),
    record: () => assert.fail("a read must not record or rescan the ledger"),
  };

  await withService(ledgerPath, async (base) => {
    const response = await get(base, READ_TOKEN);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { proposals: OperatorAgentProposal[] };
    assert.deepEqual(body.proposals.map((item) => item.proposalId), [proposal.proposalId]);
  }, undefined, memory);
});

test("unit test: a cold operator-agent snapshot is unavailable rather than an observed empty ledger", async () => {
  const { ledgerPath } = fixture();
  const memory: OperatorAgentMemorySource = {
    current: () => ({ state: "cold", asOf: null, rows: [] }),
    record: () => assert.fail("cold state must reject writes before recording a receipt"),
  };

  await withService(ledgerPath, async (base) => {
    const proposals = await get(base, READ_TOKEN);
    assert.equal(proposals.status, 503);
    assert.deepEqual(await proposals.json(), {
      error: "unavailable",
      source: "operator-agent-memory",
      detail: "the first background ledger refresh has not completed; no verified operator-agent history is available",
    });
    const settings = await getSettings(base, READ_TOKEN);
    assert.equal(settings.status, 503);
  }, undefined, memory);
});

test("unit test: operator-agent writes invalidate the snapshot for read-after-write", async () => {
  const { ledgerPath, proposal } = fixture();
  const memory = createOperatorAgentMemorySource(() => ({ state: "ready", asOf: "2026-09-21T00:00:00.000Z", rows: [] }));

  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/operator-agent/proposals", WRITE_TOKEN, { proposal })).status, 201);
    const response = await get(base, READ_TOKEN);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { proposals: OperatorAgentProposal[] };
    assert.equal(body.proposals[0]?.proposalId, proposal.proposalId);
  }, undefined, memory);
});

test("reads the default operator-agent settings when no settings row exists; persists a valid operator-agent settings update in the ledger", async () => {
  const { ledgerPath } = fixture();
  await withService(ledgerPath, async (base) => {
    const defaults = await getSettings(base, READ_TOKEN);
    assert.equal(defaults.status, 200);
    assert.deepEqual(await defaults.json(), { settings: { enabled: true, confidenceThreshold: 0.9 }, source: "default" });

    assert.equal((await post(base, "/v1/operator-agent/settings", READ_TOKEN, { settings: { enabled: false, confidenceThreshold: 0.95 } })).status, 403);
    const persisted = await post(base, "/v1/operator-agent/settings", WRITE_TOKEN, { settings: { enabled: false, confidenceThreshold: 0.95 } });
    assert.equal(persisted.status, 200);
    assert.deepEqual(await persisted.json(), { settings: { enabled: false, confidenceThreshold: 0.95 }, source: "ledger", updatedAt: "2026-09-19T10:00:00.000Z" });

    const afterWrite = await getSettings(base, READ_TOKEN);
    assert.equal(afterWrite.status, 200);
    assert.deepEqual(await afterWrite.json(), { settings: { enabled: false, confidenceThreshold: 0.95 }, source: "ledger" });
  }, () => Date.parse("2026-09-19T10:00:00.000Z"));

  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines[0]?.step, "panel.operator_agent_settings");
});

test("refuses an operator-agent confidence threshold outside the bounded range", async () => {
  const { ledgerPath } = fixture();
  await withService(ledgerPath, async (base) => {
    for (const confidenceThreshold of [0.89, 1, "0.95"]) {
      const response = await post(base, "/v1/operator-agent/settings", WRITE_TOKEN, { settings: { enabled: true, confidenceThreshold } });
      assert.equal(response.status, 400);
    }
  });
  assert.equal(existsSync(ledgerPath), false);
});

test("operator-agent decision refuses unknown and terminal proposals before writing", async () => {
  const { ledgerPath, proposal } = fixture();
  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/operator-agent/proposals/decision", WRITE_TOKEN, { proposalId: proposal.proposalId, decision: "accepted" })).status, 404);
    assert.equal((await post(base, "/v1/operator-agent/proposals", WRITE_TOKEN, { proposal })).status, 201);
    assert.equal((await post(base, "/v1/operator-agent/proposals/decision", WRITE_TOKEN, { proposalId: proposal.proposalId, decision: "rejected" })).status, 200);
    const terminal = await post(base, "/v1/operator-agent/proposals/decision", WRITE_TOKEN, { proposalId: proposal.proposalId, decision: "accepted" });
    assert.equal(terminal.status, 409);
  });
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
});

test("operator-agent rejects malformed registration, decision, and outcome payloads before writing", async () => {
  const { ledgerPath, proposal } = fixture();
  await withService(ledgerPath, async (base) => {
    const malformedRegistrations: unknown[] = [
      null,
      {},
      { proposal: { ...proposal, category: "unknown" } },
      { proposal: { ...proposal, status: "accepted" } },
      { proposal: { ...proposal, createdAt: "not-a-date" } },
      { proposal: { ...proposal, expiresAt: "not-a-date" } },
      { proposal: { ...proposal, confidence: 2 } },
      { proposal: { ...proposal, evidence: [null] } },
      { proposal: { ...proposal, evidence: [{ ...proposal.evidence[0], freshness: "unknown" }] } },
    ];
    for (const body of malformedRegistrations) {
      assert.equal((await post(base, "/v1/operator-agent/proposals", WRITE_TOKEN, body)).status, 400);
    }

    const malformedDecisions: unknown[] = [
      null,
      {},
      { proposalId: "", decision: "accepted" },
      { proposalId: proposal.proposalId, decision: "unknown" },
      { proposalId: proposal.proposalId, decision: "accepted", note: "" },
    ];
    for (const body of malformedDecisions) {
      assert.equal((await post(base, "/v1/operator-agent/proposals/decision", WRITE_TOKEN, body)).status, 400);
    }

    const malformedOutcomes: unknown[] = [
      null,
      {},
      { proposalId: "", outcome: {} },
      { proposalId: proposal.proposalId, outcome: {} },
      { proposalId: proposal.proposalId, outcome: { summary: "done", observedAt: "not-a-date" } },
      { proposalId: proposal.proposalId, outcome: { summary: "done", observedAt: proposal.createdAt, helped: "yes" } },
      { proposalId: proposal.proposalId, outcome: { summary: "done", observedAt: proposal.createdAt, evidence: "not-an-array" } },
      { proposalId: proposal.proposalId, outcome: { summary: "done", observedAt: proposal.createdAt, evidence: [""] } },
    ];
    for (const body of malformedOutcomes) {
      assert.equal((await post(base, "/v1/operator-agent/proposals/outcome", WRITE_TOKEN, body)).status, 400);
    }

    assert.equal((await post(base, "/v1/operator-agent/proposals", WRITE_TOKEN, { proposal })).status, 201);
    assert.equal((await post(base, "/v1/operator-agent/proposals", WRITE_TOKEN, {
      proposal: { ...proposal, proposalText: "A different proposal with the same id." },
    })).status, 409);
  });
  assert.equal(existsSync(ledgerPath), true);
  assert.equal(readFileSync(ledgerPath, "utf8").trim().split("\n").length, 1);
});

test("operator-agent expires pending proposals, preserves rejected history, and ignores malformed ledger rows", async () => {
  const { ledgerPath, proposal } = fixture();
  const rejected = { ...proposal, proposalId: "operator-agent:repo:fix:rejected", expiresAt: undefined };
  // DERIVED FROM THE FIXTURE, not an instant: this case needs a clock strictly AFTER `expiresAt`,
  // and saying so in terms of `expiresAt` keeps that true however the fixture is stamped.
  const expiresAtMs = Date.parse(proposal.expiresAt ?? "");
  assert.ok(Number.isFinite(expiresAtMs), "the fixture must carry a parseable expiresAt for this case to age past it");
  const now = () => expiresAtMs + 14 * 60 * 60 * 1000;
  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/operator-agent/proposals", WRITE_TOKEN, { proposal })).status, 201);
    assert.equal((await post(base, "/v1/operator-agent/proposals", WRITE_TOKEN, { proposal: rejected })).status, 201);

    const expired = (await (await get(base, READ_TOKEN)).json()) as { proposals: Array<{ proposalId: string; status: string }> };
    assert.equal(expired.proposals.find((item) => item.proposalId === proposal.proposalId)?.status, "expired");

    assert.equal((await post(base, "/v1/operator-agent/proposals/decision", WRITE_TOKEN, {
      proposalId: proposal.proposalId,
      decision: "accepted",
    })).status, 409);
    assert.equal((await post(base, "/v1/operator-agent/proposals/outcome", WRITE_TOKEN, {
      proposalId: proposal.proposalId,
      outcome: { summary: "too late", observedAt: "2026-09-21T00:00:00.000Z" },
    })).status, 409);
    assert.equal((await post(base, "/v1/operator-agent/proposals/outcome", WRITE_TOKEN, {
      proposalId: "missing",
      outcome: { summary: "not found", observedAt: "2026-09-21T00:00:00.000Z" },
    })).status, 404);

    assert.equal((await post(base, "/v1/operator-agent/proposals/decision", WRITE_TOKEN, {
      proposalId: rejected.proposalId,
      decision: "rejected",
    })).status, 200);
    assert.equal((await post(base, "/v1/operator-agent/proposals/outcome", WRITE_TOKEN, {
      proposalId: rejected.proposalId,
      outcome: { summary: "not applied", helped: false, observedAt: "2026-09-21T00:00:00.000Z", evidence: ["operator held"] },
    })).status, 409);
  }, now);

  appendFileSync(ledgerPath, `${JSON.stringify({ step: "panel.operator_agent_decision", proposal_id: proposal.proposalId, decision: "unknown", at: proposal.createdAt })}\n`);
  appendFileSync(ledgerPath, `${JSON.stringify({ step: "panel.operator_agent_decision", proposal_id: proposal.proposalId, decision: "accepted", at: "not-a-date" })}\n`);
  appendFileSync(ledgerPath, `${JSON.stringify({ step: "panel.operator_agent_outcome", proposal_id: proposal.proposalId, outcome: { summary: "", observedAt: proposal.createdAt } })}\n`);
  const history = readOperatorAgentHistory({ ledgerPath, now });
  assert.equal(history.find((item) => item.proposalId === proposal.proposalId)?.status, "expired");
  assert.equal(history.find((item) => item.proposalId === "operator-agent:repo:fix:rejected")?.status, "rejected");
});
