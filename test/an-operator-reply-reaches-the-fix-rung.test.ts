// test/an-operator-reply-reaches-the-fix-rung.test.ts — W1-T4471
//
// BEFORE THIS TASK: a reply on the GitHub issue an escalation opened was never read; the
// console's `POST /v1/escalation/reply` filed feedback but never wrote `plan/questions.ndjson`
// (the ONE store `operatorVerdictEvidence`, lib/sweep.ts, reads each fix-rung pass); and the
// issue itself never said how to answer. This suite proves all three are closed:
//   1. the repository owner's GitHub-issue reply lands in `plan/questions.ndjson` and is visible
//      to `operatorVerdictEvidence` — the fix rung's own read.
//   2. a reply from anyone but the repository owner (or a bot posting under that association) is
//      counted, ledgered, and its TEXT never reaches the question store (G-6).
//   3. a console `/v1/escalation/reply` also lands in that same store, so a GitHub reply and a
//      console reply steer the fix rung identically.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildEscalationReplyRoute, type PanelActionDeps } from "../src/lib/panel-actions.js";
import { appendThreadMessage, type ThreadIdentity } from "../src/lib/inbox-thread.js";
import { readLedgerLines } from "../src/lib/status.js";
import { operatorVerdictEvidence } from "../src/lib/sweep.js";
import { renderIssueBody, type Escalation, type OpenIssue } from "../src/lib/escalate.js";
import {
  readEscalationAnswers,
  type EscalationAnswerGateway,
  type EscalationIssueComment,
} from "../src/lib/escalation-answers.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-operator-reply-"));
}

function questionsStorePath(root: string): string {
  return join(root, "plan", "questions.ndjson");
}

function readQuestionsStore(root: string): Array<Record<string, unknown>> {
  const path = questionsStorePath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-T9401",
    summary: "two strikes exhausted",
    detail: "the diagnose-armed retry still failed CI.",
    options: [
      { label: "retry", detail: "resume the run with a fresh worker" },
      { label: "abandon", detail: "drop the task and re-plan" },
    ],
    recommendation: "retry",
    ...over,
  };
}

/** A fake {@link EscalationAnswerGateway} whose `listOpen` returns one fixed issue, whose
 *  `listComments` is scripted per test, and which records every `reactPlusOne` call. */
function fakeGateway(issue: OpenIssue, comments: EscalationIssueComment[]): EscalationAnswerGateway & { reacted: number[] } {
  const reacted: number[] = [];
  return {
    reacted,
    listOpen: () => [issue],
    listComments: () => comments,
    reactPlusOne: (commentId) => {
      reacted.push(commentId);
    },
  };
}

// ── 1: the repository owner's reply on an escalation lands in the question store ─────────────

test("W1-T4471: the repository owner's reply on an escalation lands in the question store", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const e = escalation();
  const issue: OpenIssue = { number: 501, url: "https://github.com/craigoley/remudero/issues/501", body: renderIssueBody(e) };
  const comment: EscalationIssueComment = {
    id: 9001,
    body: "retry",
    authorLogin: "craigoley",
    authorAssociation: "OWNER",
    authorType: "User",
  };
  const gateway = fakeGateway(issue, [comment]);

  const result = readEscalationAnswers({ root, ledgerPath, runId: "RUN-1", issues: gateway });
  assert.equal(result.accepted, 1);
  assert.equal(result.ignored, 0);

  const stored = readQuestionsStore(root);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].task, e.taskId);
  assert.equal(stored[0].answer, "retry");
  assert.equal(stored[0].origin, "issue#501:comment:9001");

  // Acknowledged with a reaction, never a posted comment.
  assert.deepEqual(gateway.reacted, [9001]);

  // The fix rung's OWN read (lib/sweep.ts) sees it.
  const evidence = operatorVerdictEvidence(e.taskId, [], readQuestionsStore(root));
  assert.ok(evidence, "operatorVerdictEvidence must produce steering evidence from the recorded answer");
  assert.equal(evidence!.constraint, "retry");

  // Idempotent per comment id — a re-poll of the same comment creates nothing new.
  const second = readEscalationAnswers({ root, ledgerPath, runId: "RUN-2", issues: gateway });
  assert.equal(second.accepted, 0);
  assert.equal(readQuestionsStore(root).length, 1);
});

// ── 2: a reply from anyone but the repository owner is ignored ───────────────────────────────

test("W1-T4471: a reply from anyone but the repository owner is ignored", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const e = escalation();
  const issue: OpenIssue = { number: 502, url: "https://github.com/craigoley/remudero/issues/502", body: renderIssueBody(e) };
  const publicText = "PUBLIC-COMMENTER-SECRET-TEXT-must-never-reach-the-question-store";
  const nonOwner: EscalationIssueComment = {
    id: 9002,
    body: publicText,
    authorLogin: "rando",
    authorAssociation: "CONTRIBUTOR",
    authorType: "User",
  };
  const gateway = fakeGateway(issue, [nonOwner]);

  const result = readEscalationAnswers({ root, ledgerPath, runId: "RUN-1", issues: gateway });
  assert.equal(result.accepted, 0);
  assert.equal(result.ignored, 1);

  // The falsifier this task names: drop the author_association check and this text lands.
  assert.deepEqual(readQuestionsStore(root), []);
  assert.deepEqual(gateway.reacted, []);

  // Counted (ledgered), but the comment's own TEXT never reaches the ledger either (G-6).
  const lines = readLedgerLines(ledgerPath).filter((l) => l.step === "escalation_answer.ignored");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].task_id, e.taskId);
  assert.equal(lines[0].author_association, "CONTRIBUTOR");
  const ledgerRaw = readFileSync(ledgerPath, "utf8");
  assert.ok(!ledgerRaw.includes(publicText), "the ignored comment's own text must never reach the ledger");

  // The fix rung sees nothing to steer by.
  assert.equal(operatorVerdictEvidence(e.taskId, [], readQuestionsStore(root)), undefined);

  // A bot posting under the OWNER association is refused too — G-6 excludes automation, not just
  // the public.
  const bot: EscalationIssueComment = {
    id: 9003,
    body: "retry",
    authorLogin: "remudero-bot",
    authorAssociation: "OWNER",
    authorType: "Bot",
  };
  const botGateway = fakeGateway(issue, [bot]);
  const botResult = readEscalationAnswers({ root, ledgerPath, runId: "RUN-2", issues: botGateway });
  assert.equal(botResult.accepted, 0);
  assert.equal(botResult.ignored, 1);
  assert.deepEqual(readQuestionsStore(root), []);
});

// ── 3: a console escalation reply steers the fix rung ─────────────────────────────────────────

const READ_TOKEN = "reply-read-token";
const WRITE_TOKEN = "reply-write-token";

function threadStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-operator-reply-threads-")), "threads.jsonl");
}

function depsFor(root: string, path: string): PanelActionDeps {
  return {
    root,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    issues: { close: () => {} },
    threadStorePath: path,
  };
}

async function withService<T>(deps: PanelActionDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: [buildEscalationReplyRoute(deps)] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function post(base: string, path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("W1-T4471: a console escalation reply steers the fix rung", async () => {
  const root = tmpRoot();
  const path = threadStorePath();
  const identity: ThreadIdentity = { taskId: "W1-T9402", class: "BLOCKED" };
  appendThreadMessage(identity, "escalation", "the retry still failed CI", { threadStorePath: path });

  await withService(depsFor(root, path), async (base) => {
    const res = await post(base, "/v1/escalation/reply", WRITE_TOKEN, {
      taskId: "W1-T9402",
      class: "BLOCKED",
      text: "retry once more, the flake looks like ci noise",
    });
    assert.equal(res.status, 200);
  });

  const stored = readQuestionsStore(root);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].task, "W1-T9402");
  assert.equal(stored[0].answer, "retry once more, the flake looks like ci noise");

  // The SAME evidence read the GitHub-comment path proves above — a console reply steers the
  // fix rung exactly like a GitHub reply does.
  const evidence = operatorVerdictEvidence("W1-T9402", [], stored);
  assert.ok(evidence);
  assert.equal(evidence!.constraint, "retry once more, the flake looks like ci noise");

  const lines = readLedgerLines(join(root, "state", "ledger.ndjson")).filter((l) => l.step === "panel.escalation_replied");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].flows_to, "plan/questions.ndjson");
  assert.equal(lines[0].recorded_to_question_store, true);
});
