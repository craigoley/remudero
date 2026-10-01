import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { fixedClock } from "../src/lib/clock.js";
import { createService } from "../src/lib/service.js";
import { buildOperatorAgentRoutes } from "../src/lib/operator-agent.js";
import { FOLLOW_UP_POLICY_VERSION, appendFollowUpCandidate, type FollowUpCandidate } from "../src/lib/follow-up-policy.js";

const READ_TOKEN = "follow-up-decision-read-token";
const WRITE_TOKEN = "follow-up-decision-write-token";
const NOW = Date.parse("2026-09-21T11:00:00.000Z");
const PATH = "/v1/operator-agent/follow-ups/decision";

const candidate: FollowUpCandidate = {
  version: FOLLOW_UP_POLICY_VERSION,
  candidateId: "follow-up:thread-1",
  sourceEvent: "operator_agent.outcome_observed",
  workstream: "repo/experiment",
  reason: "The accepted experiment has no observed outcome yet.",
  freshness: "verified",
  dependency: "owner response",
  deduplicationKey: "repo/experiment:outcome",
  maxAttempts: 2,
  owner: "operator@example.test",
  nextQuestion: "Would you like to record the observed outcome?",
  createdAt: "2026-09-21T10:00:00.000Z",
};

async function withRoute(fn: (base: string, ledgerPath: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rmd-follow-up-decision-"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  appendFollowUpCandidate({ ledgerPath, now: fixedClock(Date.parse(candidate.createdAt)) }, candidate);
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildOperatorAgentRoutes({ ledgerPath, now: () => NOW }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, ledgerPath);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function decide(base: string, body: unknown, token = WRITE_TOKEN): Promise<Response> {
  return fetch(`${base}${PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readFollowUps(base: string): Promise<Array<{ state: string; snoozedUntil?: string; receipt?: { completed: boolean; answered?: boolean } }>> {
  const response = await fetch(`${base}/v1/operator-agent/follow-ups`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
  return ((await response.json()) as { followUps: Array<{ state: string; snoozedUntil?: string; receipt?: { completed: boolean; answered?: boolean } }> }).followUps;
}

const ledgerLines = (ledgerPath: string): number => readFileSync(ledgerPath, "utf8").trim().split("\n").length;

test("W1-T5070: a snoozed follow-up reads back as snoozed through the follow-ups read route", async () => {
  await withRoute(async (base) => {
    const until = new Date(NOW + 3_600_000).toISOString();
    assert.equal((await decide(base, { followUpId: candidate.candidateId, action: "snooze", until }, READ_TOKEN)).status, 403);
    const response = await decide(base, { followUpId: candidate.candidateId, action: "snooze", until });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; followUpId: string; action: string; at: string; receipt: { contactState: string } };
    assert.deepEqual({ ok: body.ok, followUpId: body.followUpId, action: body.action, at: body.at }, {
      ok: true,
      followUpId: candidate.candidateId,
      action: "snooze",
      at: new Date(NOW).toISOString(),
    });
    assert.equal(body.receipt.contactState, "snoozed");
    const [read] = await readFollowUps(base);
    assert.equal(read.state, "snoozed");
    assert.equal(read.snoozedUntil, until);
  });
});

test("W1-T5070: a control on a terminal follow-up is refused with a conflict and appends nothing", async () => {
  await withRoute(async (base, ledgerPath) => {
    assert.equal((await decide(base, { followUpId: candidate.candidateId, action: "reject" })).status, 200);
    assert.equal((await readFollowUps(base))[0].state, "rejected");
    const before = ledgerLines(ledgerPath);
    const until = new Date(NOW + 3_600_000).toISOString();
    for (const body of [
      { followUpId: candidate.candidateId, action: "snooze", until },
      { followUpId: candidate.candidateId, action: "answer", answer: "done" },
    ]) {
      assert.equal((await decide(base, body)).status, 409);
    }
    assert.equal(ledgerLines(ledgerPath), before);
  });
});

test("W1-T5070: a snooze without a future until is a conflict, an unknown id is not found, a bad body is invalid", async () => {
  await withRoute(async (base, ledgerPath) => {
    const before = ledgerLines(ledgerPath);
    const past = new Date(NOW - 1000).toISOString();
    assert.equal((await decide(base, { followUpId: candidate.candidateId, action: "snooze", until: past })).status, 409);
    assert.equal((await decide(base, { followUpId: "follow-up:nope", action: "reject" })).status, 404);
    assert.equal((await decide(base, { followUpId: candidate.candidateId, action: "complete" })).status, 400);
    assert.equal((await decide(base, { followUpId: candidate.candidateId, action: "answer" })).status, 400);
    assert.equal((await decide(base, { action: "reject" })).status, 400);
    assert.equal(ledgerLines(ledgerPath), before);
  });
});

test("W1-T5070: an answer appends a receipt row and never marks the follow-up completed", async () => {
  await withRoute(async (base, ledgerPath) => {
    const before = ledgerLines(ledgerPath);
    const response = await decide(base, { followUpId: candidate.candidateId, action: "answer", answer: "Recorded the outcome." });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { receipt: { contactState: string; deliveryState?: string } };
    assert.equal(body.receipt.contactState, "answered");
    assert.equal(body.receipt.deliveryState, "delivered");
    assert.equal(ledgerLines(ledgerPath), before + 1);
    const row = JSON.parse(readFileSync(ledgerPath, "utf8").trim().split("\n").at(-1)!) as { step: string; candidate_id: string };
    assert.equal(row.step, "panel.follow_up_receipt");
    assert.equal(row.candidate_id, candidate.candidateId);
    const [read] = await readFollowUps(base);
    assert.equal(read.receipt?.answered, true);
    assert.equal(read.receipt?.completed, false);
    assert.notEqual(read.state, "accepted");
  });
});

test("W1-T5070: revoke and a note-carrying reject land as a control row the read folds as rejected", async () => {
  await withRoute(async (base, ledgerPath) => {
    assert.equal((await decide(base, { followUpId: candidate.candidateId, action: "revoke", note: "not mine" })).status, 200);
    const row = JSON.parse(readFileSync(ledgerPath, "utf8").trim().split("\n").at(-1)!) as { step: string; control: string; reason: string };
    assert.deepEqual({ step: row.step, control: row.control, reason: row.reason }, { step: "panel.follow_up_control", control: "revoke", reason: "not mine" });
    assert.equal((await readFollowUps(base))[0].state, "rejected");
  });
});
