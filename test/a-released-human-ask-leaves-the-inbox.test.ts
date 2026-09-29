import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { classifyAllProposalsMemo, buildPanelGraphRoutes, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { inboxThreadId, type ThreadMessage } from "../src/lib/inbox-thread.js";
import { listThreadViews, type InboxThreadItem } from "../src/lib/inbox-responder.js";
import { createService } from "../src/lib/service.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const HUMAN = "verify-human:W1-T216";
const OTHER = "verify-human:W1-T217";
const RULING = "ruling:operator-choice";
const UNKNOWN = "new-producer:incomplete";

function fixture(): { deps: PanelGraphDeps; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-inbox-attention-"));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, ["W1-T216", "W1-T217"].map((id) => `
- id: ${id}
  title: "a controlled task"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  risk: high
  status: queued
  attempts: 0
  files: [test/controlled-task.test.ts]
  acceptance:
    - claim: "a controlled check"
      proof: "unit test: controlled check"
`).join(""));
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({
    proposals: [HUMAN, OTHER, RULING, UNKNOWN].map((id) => ({ id, summary: `Current question about ${id}`, evidenceAnchors: [] })),
  }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  return {
    ledgerPath,
    deps: {
      root,
      inboxRoot: root,
      planPath,
      ledgerPath,
      github: { prView: () => null },
      statusGithub: fakeGitHub(),
      ratify: { approve: () => undefined, reframe: () => undefined },
      inboxMainSha: () => "a".repeat(40),
    },
  };
}

function release(path: string, taskId: string, released = "verify-human") {
  appendFileSync(path, JSON.stringify({ step: "ratify.approved", task_id: taskId, released }) + "\n");
}

async function threads(deps: PanelGraphDeps): Promise<Array<{ proposalId: string; attention: string; waitingOn: string }>> {
  const server = createService({ tokens: { read: "read-token", write: "write-token" }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox/threads`, {
      headers: { authorization: "Bearer read-token" },
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { threads: Array<{ proposalId: string; attention: string; waitingOn: string }> }).threads;
  } finally {
    server.close();
  }
}

test("W1-T4738: a release receipt retires only its exact verify-human ask without erasing history", async () => {
  const world = fixture();
  release(world.ledgerPath, "W1-T216");
  const classified = classifyAllProposalsMemo(world.deps);
  assert.equal(classified.classifications.find((row) => row.proposalId === HUMAN)?.state, "retired");
  assert.equal(classified.classifications.find((row) => row.proposalId === OTHER)?.state, "not_ready");
  assert.ok(classified.proposals.some((row) => row.id === HUMAN), "history stays in the registry");
  const visible = await threads(world.deps);
  assert.ok(!visible.some((row) => row.proposalId === HUMAN));
  assert.ok(visible.some((row) => row.proposalId === OTHER));
  assert.ok(visible.some((row) => row.proposalId === RULING));
});

test("W1-T4738: release receipt invalidates the inbox memo", () => {
  const world = fixture();
  const before = classifyAllProposalsMemo(world.deps);
  assert.equal(before.classifications.find((row) => row.proposalId === HUMAN)?.state, "not_ready");
  release(world.ledgerPath, "W1-T216");
  const after = classifyAllProposalsMemo(world.deps);
  assert.notStrictEqual(after, before);
  assert.equal(after.classifications.find((row) => row.proposalId === HUMAN)?.state, "retired");
  assert.equal(after.classifications.find((row) => row.proposalId === OTHER)?.state, "not_ready");
});

test("W1-T4738: no release evidence keeps the ask visible", async () => {
  const world = fixture();
  release(world.ledgerPath, "W1-T216", "some-other-purpose");
  release(world.ledgerPath, "W1-T999");
  const visible = await threads(world.deps);
  assert.ok(visible.some((row) => row.proposalId === HUMAN));
  assert.ok(visible.some((row) => row.proposalId === OTHER));
});

test("W1-T4738: last speaker is not the attention state", () => {
  const plain = { headline: "A question", whatHappened: "It happened.", whatWeNeed: "Review it.", ifNothingHappens: "It waits.", options: [], source: "template" } as InboxThreadItem["plain"];
  const items: InboxThreadItem[] = [
    { proposalId: UNKNOWN, summary: "incomplete", plain, state: "notReady" },
    { proposalId: "new-producer:drafting", summary: "drafting", plain, state: "drafting" },
    { proposalId: HUMAN, summary: "security judgement", plain, state: "notReady" },
    { proposalId: RULING, summary: "operator ruling", plain, state: "ready" },
  ];
  const views = listThreadViews(items, new Map(), {});
  assert.ok(views.every((view) => view.waitingOn === "operator"), "last-speaker is unchanged");
  assert.equal(views.find((view) => view.proposalId === UNKNOWN)?.attention, "in_progress");
  assert.equal(views.find((view) => view.proposalId === "new-producer:drafting")?.attention, "in_progress");
  assert.equal(views.find((view) => view.proposalId === HUMAN)?.attention, "decision", "a real human-only security ask stays visible");
  assert.equal(views.find((view) => view.proposalId === RULING)?.attention, "decision");
  assert.equal(inboxThreadId(HUMAN), views.find((view) => view.proposalId === HUMAN)?.threadId);
});

test("W1-T4738: a direct question needs a reply while a declined conversation remains history", () => {
  const plain = { headline: "A question", whatHappened: "It happened.", whatWeNeed: "Review it.", ifNothingHappens: "It waits.", options: [], source: "template" } as InboxThreadItem["plain"];
  const questionId = "new-producer:question";
  const declinedId = "new-producer:declined";
  const operatorId = "new-producer:operator-replied";
  const items: InboxThreadItem[] = [
    { proposalId: questionId, summary: "question", plain, state: "notReady" },
    { proposalId: declinedId, summary: "declined", plain, state: "declined" },
    { proposalId: operatorId, summary: "reply", plain, state: "ready" },
  ];
  const message = (proposalId: string, role: ThreadMessage["role"], extra?: ThreadMessage["extra"]): ThreadMessage => ({
    threadId: inboxThreadId(proposalId), role, body: "What now?", seq: 1, ts: 1, ...(extra ? { extra } : {}),
  });
  const stored = new Map([
    [inboxThreadId(questionId), [message(questionId, "escalation", { question: true })]],
    [inboxThreadId(declinedId), [message(declinedId, "escalation")]],
    [inboxThreadId(operatorId), [message(operatorId, "reply")]],
  ]);
  const views = listThreadViews(items, stored, {});
  assert.equal(views.find((view) => view.proposalId === questionId)?.attention, "reply");
  assert.equal(views.find((view) => view.proposalId === declinedId)?.attention, "history");
  assert.equal(views.find((view) => view.proposalId === operatorId)?.attention, "awaiting_daemon");
});
