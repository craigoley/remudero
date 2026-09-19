import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import {
  buildOperatorAgentRoutes,
  type OperatorAgentProposal,
} from "../src/lib/operator-agent.js";

const READ_TOKEN = "operator-agent-read-token";
const WRITE_TOKEN = "operator-agent-write-token";

function fixture(): { ledgerPath: string; proposal: OperatorAgentProposal } {
  const root = mkdtempSync(join(tmpdir(), "rmd-operator-agent-"));
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
      createdAt: "2026-09-19T10:00:00.000Z",
      expiresAt: "2026-09-20T10:00:00.000Z",
      evidence: [{
        label: "Queued tasks",
        value: "8",
        source: "run-ledger",
        observedAt: "2026-09-19T10:00:00.000Z",
        freshness: "verified",
      }],
    },
  };
}

async function withService<T>(ledgerPath: string, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildOperatorAgentRoutes({ ledgerPath }) });
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
