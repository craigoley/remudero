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
// The rest drive each degraded arm of the reader, its real `gh` gateway, and the sweep wiring.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";
import { buildSweepHook } from "../src/run-task.js";
import {
  ghEscalationAnswerGateway,
  readEscalationAnswers,
  type EscalationAnswerGateway,
  type EscalationIssueComment,
} from "../src/lib/escalation-answers.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";

const CLOCK_MS = Date.UTC(2026, 8, 24, 12, 0, 0);

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}operator-reply-`));
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

function ownerComment(id: number, body: string): EscalationIssueComment {
  return { id, body, authorLogin: "craigoley", authorAssociation: "OWNER", authorType: "User" };
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
  const gateway = fakeGateway(issue, [ownerComment(9001, "retry")]);

  const result = readEscalationAnswers(root, "RUN-1", gateway, { ledgerPath }, fixedClock(CLOCK_MS));
  assert.deepEqual(result, { accepted: 1, ignored: 0, unreadable: 0 });

  const stored = readQuestionsStore(root);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].task, e.taskId);
  assert.equal(stored[0].answer, "retry");
  assert.equal(stored[0].origin, "issue#501:comment:9001");
  assert.equal(stored[0].ts, fixedClock(CLOCK_MS).iso(), "the answer is stamped through the injected Clock");

  // Acknowledged with a reaction, never a posted comment.
  assert.deepEqual(gateway.reacted, [9001]);

  // The fix rung's OWN read (lib/sweep.ts) sees it.
  const evidence = operatorVerdictEvidence(e.taskId, [], readQuestionsStore(root));
  assert.ok(evidence, "operatorVerdictEvidence must produce steering evidence from the recorded answer");
  assert.equal(evidence!.constraint, "retry");

  // Idempotent per comment id — a re-poll of the same comment creates nothing new.
  const second = readEscalationAnswers(root, "RUN-2", gateway, { ledgerPath }, fixedClock(CLOCK_MS));
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

  const result = readEscalationAnswers(root, "RUN-1", gateway, { ledgerPath });
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
  const botResult = readEscalationAnswers(root, "RUN-2", botGateway, { ledgerPath });
  assert.equal(botResult.accepted, 0);
  assert.equal(botResult.ignored, 1);
  assert.deepEqual(readQuestionsStore(root), []);
});

// ── 3: a console escalation reply steers the fix rung ─────────────────────────────────────────

const READ_TOKEN = "reply-read-token";
const WRITE_TOKEN = "reply-write-token";

function threadStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}operator-reply-threads-`)), "threads.jsonl");
}

function depsFor(root: string, path: string): PanelActionDeps {
  return {
    root,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    issues: { close: () => {} },
    threadStorePath: path,
    clock: fixedClock(CLOCK_MS),
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
  assert.equal(stored[0].ts, fixedClock(CLOCK_MS).iso(), "the console answer is stamped through the injected Clock");

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

// ── the reader's degraded arms ─────────────────────────────────────────────────────────────────

test("W1-T4471: an unreadable issue list is counted as unreadable, never as nothing new", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const gateway: EscalationAnswerGateway = {
    listOpen: () => {
      throw new Error("gh api: HTTP 502");
    },
    listComments: () => assert.fail("no comments are read when the list itself failed"),
    reactPlusOne: () => assert.fail("nothing is acknowledged when the list itself failed"),
  };
  assert.deepEqual(readEscalationAnswers(root, "RUN-1", gateway, { ledgerPath }), { accepted: 0, ignored: 0, unreadable: 1 });
  assert.deepEqual(readQuestionsStore(root), []);
});

test("W1-T4471: one unreadable issue is counted and skipped while the next issue's reply still lands", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const broken: OpenIssue = { number: 601, url: "u601", body: renderIssueBody(escalation({ taskId: "W1-T9601" })) };
  const healthy: OpenIssue = { number: 602, url: "u602", body: renderIssueBody(escalation({ taskId: "W1-T9602" })) };
  const gateway: EscalationAnswerGateway = {
    listOpen: () => [broken, healthy],
    listComments: (n) => {
      if (n === 601) throw new Error("gh api: HTTP 404");
      return [ownerComment(9602, "abandon")];
    },
    reactPlusOne: () => {},
  };
  const result = readEscalationAnswers(root, "RUN-1", gateway, { ledgerPath });
  assert.deepEqual(result, { accepted: 1, ignored: 0, unreadable: 1 });
  assert.deepEqual(readQuestionsStore(root).map((r) => [r.task, r.answer]), [["W1-T9602", "abandon"]]);
});

test("W1-T4471: a failed acknowledgement reaction never un-lands the answer", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const issue: OpenIssue = { number: 701, url: "u701", body: renderIssueBody(escalation()) };
  const gateway: EscalationAnswerGateway = {
    listOpen: () => [issue],
    listComments: () => [ownerComment(9701, "retry")],
    reactPlusOne: () => {
      throw new Error("gh api: HTTP 403");
    },
  };
  assert.deepEqual(readEscalationAnswers(root, "RUN-1", gateway, { ledgerPath }), { accepted: 1, ignored: 0, unreadable: 0 });
  assert.equal(readQuestionsStore(root).length, 1);
  assert.ok(readLedgerLines(ledgerPath).some((l) => l.step === "panel.question_answered" && l.origin === "issue#701:comment:9701"));
});

test("W1-T4471: a reply naming no option is recorded verbatim, a blank reply and a task-less issue record nothing", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const writes: Array<Record<string, unknown>> = [];
  const taskless: OpenIssue = { number: 801, url: "u801", body: "no task line in this body" };
  const issue: OpenIssue = { number: 802, url: "u802", body: renderIssueBody(escalation({ taskId: "W1-T9802" })) };
  const listed: number[] = [];
  const gateway: EscalationAnswerGateway = {
    listOpen: () => [taskless, issue],
    listComments: (n) => {
      listed.push(n);
      return [ownerComment(9801, "   "), ownerComment(9802, "  keep the flake quarantine, then rerun  ")];
    },
    reactPlusOne: () => {},
  };
  const result = readEscalationAnswers(root, "RUN-1", gateway, {
    ledgerPath,
    writeLedger: (_path, line) => {
      writes.push(line as Record<string, unknown>);
    },
  });
  assert.deepEqual(result, { accepted: 1, ignored: 0, unreadable: 0 });
  assert.deepEqual(listed, [802], "an issue with no recoverable task is never even read");
  assert.deepEqual(readQuestionsStore(root).map((r) => r.answer), ["keep the flake quarantine, then rerun"]);
  assert.deepEqual(writes.map((w) => w.step), ["panel.question_answered"], "the injected ledger writer receives the row");
  assert.equal(existsSync(ledgerPath), false, "an injected writer replaces the default append");
});

test("W1-T4471: a torn line in the question store is skipped and its good origins still dedupe", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(
    questionsStorePath(root),
    '{"ts":"t","task":"W1-T9401","answer":"retry","origin":"issue#901:comment:9901"}\n{"torn\n',
  );
  const issue: OpenIssue = { number: 901, url: "u901", body: renderIssueBody(escalation()) };
  const result = readEscalationAnswers(root, "RUN-1", fakeGateway(issue, [ownerComment(9901, "retry")]), { ledgerPath });
  assert.deepEqual(result, { accepted: 0, ignored: 0, unreadable: 0 });
});

// ── the real `gh` gateway (a PATH shim, never the network) ─────────────────────────────────────

async function withShim<T>(routes: GhShimRoute[], fn: (calls: () => string[]) => T | Promise<T>): Promise<T> {
  const shim = ghShim(routes, { kind: "operator-reply-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  try {
    return await fn(() => shim.calls());
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

test("W1-T4471: ghEscalationAnswerGateway reads issues and comments over REST and reacts with +1", async () => {
  const issues = JSON.stringify([{ number: 11, html_url: "u11", state: "open", title: "t", body: "**Task:** W1-T9011" }]);
  const comments = JSON.stringify([
    { id: 5, body: "retry", author_association: "OWNER", user: { login: "craigoley", type: "User" } },
    { id: 6, user: null },
  ]);
  await withShim(
    [
      { when: "issues/11/comments", stdout: comments },
      { when: "issues?labels=needs-question", stdout: issues },
    ],
    (calls) => {
      const gateway = ghEscalationAnswerGateway("o", "r");
      assert.deepEqual(
        gateway.listOpen("needs-question").map((i) => [i.number, i.body]),
        [[11, "**Task:** W1-T9011"]],
      );
      assert.deepEqual(gateway.listComments(11), [
        { id: 5, body: "retry", authorLogin: "craigoley", authorAssociation: "OWNER", authorType: "User" },
        { id: 6, body: "", authorLogin: "", authorAssociation: "NONE", authorType: "User" },
      ]);
      gateway.reactPlusOne(5);
      assert.ok(calls().some((c) => c.includes("repos/o/r/issues/comments/5/reactions") && c.includes("content=+1")));
      assert.ok(!calls().some((c) => c.includes("body=")), "never posts a comment");
    },
  );
});

test("W1-T4471: ghEscalationAnswerGateway refuses a comments page that is not a JSON array", async () => {
  await withShim([{ when: "issues/12/comments", stdout: JSON.stringify({ message: "Not Found" }) }], () => {
    assert.throws(() => ghEscalationAnswerGateway("o", "r").listComments(12), /expected a JSON array page/);
  });
});

// ── the sweep wiring ──────────────────────────────────────────────────────────────────────────

async function runSweepWith(gateway: EscalationAnswerGateway): Promise<Array<{ step: string; extra: Record<string, unknown> }>> {
  const root = tmpRoot();
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await withShim([{ when: "", stdout: "[]" }], async () => {
    const hook = buildSweepHook(
      "o",
      "r",
      { root, claudeBin: "/bin/true" } as Config,
      join(root, "ledger.ndjson"),
      "DAEMON-TEST",
      { tasks: [], byId: new Map() },
      (step, extra = {}) => logs.push({ step, extra }),
      undefined, // tmpMaxAgeMs
      undefined, // github
      undefined, // pacer
      undefined, // workerStallMs
      undefined, // mainHealthRung
      undefined, // snapshotCache
      undefined, // reviewerCodeRecoveryOrIsMerged
      undefined, // isMergedOrReadMainPlan
      undefined, // readMainPlan
      undefined, // targetCheckoutRoot
      undefined, // planAccessor
      gateway,
    );
    await assert.doesNotReject(hook());
  });
  return logs;
}

test("W1-T4471: the sweep names an unreadable owner-reply poll and carries on", async () => {
  const logs = await runSweepWith({
    listOpen: () => {
      throw new Error("gh api: HTTP 502");
    },
    listComments: () => [],
    reactPlusOne: () => {},
  });
  const entry = logs.find((l) => l.step === "escalation_answers.unreadable");
  assert.deepEqual(entry?.extra, { accepted: 0, ignored: 0, unreadable: 1 });
  assert.ok(!logs.some((l) => l.step === "escalation_answers.error"));
});

test("W1-T4471: the sweep contains a reader that throws and carries on", async () => {
  const logs = await runSweepWith({
    listOpen: () => [{ number: 21, url: "u21", body: "**Task:** W1-T9021" }],
    // A malformed row (not a comment object) throws past the reader's own read boundaries.
    listComments: () => [null as unknown as EscalationIssueComment],
    reactPlusOne: () => {},
  });
  assert.ok(logs.some((l) => l.step === "escalation_answers.error"), "the throw is named, not swallowed silently");
  assert.ok(!logs.some((l) => l.step === "escalation_answers.unreadable"));
});
