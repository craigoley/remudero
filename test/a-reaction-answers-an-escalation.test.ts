// test/a-reaction-answers-an-escalation.test.ts — W1-T4676
//
// BEFORE THIS TASK: answering a needs-question escalation needed a TYPED comment
// (test/an-operator-reply-reaches-the-fix-rung.test.ts, W1-T4471) — a phone push notification
// took the operator straight to the issue, but nothing there could be answered with one tap. This
// suite proves the escalation issue's OWN `+1`/`-1` reaction now answers it too:
//   1. the repository owner's thumbs-up accepts the issue's own recommended option.
//   2. the repository owner's thumbs-down declines it, recorded distinctly.
//   3. the fleet's own acknowledgement reaction (posted back on the SAME issue once a reaction
//      answer lands) is never read back as a second answer — nor is anyone else's reaction.
//   4. a reaction that isn't a vote (`heart`, `rocket`, …) is skipped, exactly like a reply
//      naming no option — no NEW crash, no accepted answer.
//   5. idempotent per reaction id, degraded reads counted as `unreadable`, and the real `gh`
//      gateway's REST shape — the same disciplines W1-T4471 already proved for comments.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { operatorVerdictEvidence } from "../src/lib/sweep.js";
import { renderIssueBody, type Escalation, type OpenIssue } from "../src/lib/escalate.js";
import { readLedgerLines } from "../src/lib/status.js";
import { fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  ghEscalationAnswerGateway,
  isOwnerReaction,
  reactionAnswerText,
  readEscalationAnswers,
  type EscalationAnswerGateway,
  type EscalationIssueReaction,
} from "../src/lib/escalation-answers.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";

const CLOCK_MS = Date.UTC(2026, 8, 29, 12, 0, 0);
const OWNER_LOGIN = "craigoley";
const FLEET_LOGIN = "remudero-fleet[bot]";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reaction-answer-`));
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
    taskId: "W1-T9501",
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

function ownerReaction(id: number, content: string): EscalationIssueReaction {
  return { id, content, authorLogin: OWNER_LOGIN, authorType: "User" };
}

function fleetReaction(id: number, content: string): EscalationIssueReaction {
  return { id, content, authorLogin: FLEET_LOGIN, authorType: "Bot" };
}

/** A fake {@link EscalationAnswerGateway} whose `listOpen` returns one fixed issue, whose
 *  `listReactions` is scripted per test, and which records every acknowledgement call. */
function fakeGateway(
  issue: OpenIssue,
  reactions: EscalationIssueReaction[],
): EscalationAnswerGateway & { reactedOnIssue: number[] } {
  const reactedOnIssue: number[] = [];
  return {
    reactedOnIssue,
    ownerLogin: OWNER_LOGIN,
    listOpen: () => [issue],
    listComments: () => [],
    listReactions: () => reactions,
    reactPlusOne: () => assert.fail("a reaction answer never reacts to a comment"),
    reactPlusOneOnIssue: (issueNumber) => {
      reactedOnIssue.push(issueNumber);
    },
  };
}

// ── 1: the owner's thumbs-up accepts the recommended option ───────────────────────────────────

test("W1-T4676: the owner's thumbs-up accepts the recommended option", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const e = escalation();
  const issue: OpenIssue = { number: 1001, url: "https://github.com/craigoley/remudero/issues/1001", body: renderIssueBody(e) };
  const gateway = fakeGateway(issue, [ownerReaction(5001, "+1")]);

  const result = readEscalationAnswers(root, "RUN-1", gateway, { ledgerPath }, fixedClock(CLOCK_MS));
  assert.deepEqual(result, { accepted: 1, ignored: 0, unreadable: 0 });

  const stored = readQuestionsStore(root);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].task, e.taskId);
  assert.equal(stored[0].answer, "retry", "the recommended option's own label is recorded");
  assert.equal(stored[0].origin, "issue#1001:reaction:5001");
  assert.equal(stored[0].ts, fixedClock(CLOCK_MS).iso(), "the answer is stamped through the injected Clock");

  // Acknowledged with a reaction on the SAME issue, never a posted comment or a comment reaction.
  assert.deepEqual(gateway.reactedOnIssue, [1001]);

  // The fix rung's OWN read (lib/sweep.ts) sees it.
  const evidence = operatorVerdictEvidence(e.taskId, [], readQuestionsStore(root));
  assert.ok(evidence, "operatorVerdictEvidence must produce steering evidence from the recorded answer");
  assert.equal(evidence!.constraint, "retry");

  // Idempotent per reaction id — a re-poll of the same reaction creates nothing new.
  const second = readEscalationAnswers(root, "RUN-2", gateway, { ledgerPath }, fixedClock(CLOCK_MS));
  assert.equal(second.accepted, 0);
  assert.equal(readQuestionsStore(root).length, 1);
});

// ── 2: the owner's thumbs-down declines it, recorded distinctly ───────────────────────────────

test("W1-T4676: the owner's thumbs-down declines the recommended option", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const e = escalation();
  const issue: OpenIssue = { number: 1002, url: "u1002", body: renderIssueBody(e) };
  const gateway = fakeGateway(issue, [ownerReaction(5002, "-1")]);

  const result = readEscalationAnswers(root, "RUN-1", gateway, { ledgerPath });
  assert.deepEqual(result, { accepted: 1, ignored: 0, unreadable: 0 });

  const stored = readQuestionsStore(root);
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].answer, "retry", "a decline is never recorded as if it were an accept");
  assert.match(stored[0].answer as string, /retry/, "the declined option is still named, for context");
  assert.match(stored[0].answer as string, /no/i, "a decline reads unambiguously as a refusal");
  assert.equal(stored[0].origin, "issue#1002:reaction:5002");

  // The fix rung reads a decline as its own distinct constraint, never the accepted label.
  const evidence = operatorVerdictEvidence(e.taskId, [], stored);
  assert.ok(evidence);
  assert.notEqual(evidence!.constraint, "retry");
});

// ── 3: the fleet's own reaction (and anyone else's) is never read as an answer ─────────────────

test("W1-T4676: the fleet's own reaction is never read as an answer", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const e = escalation();
  const issue: OpenIssue = { number: 1003, url: "u1003", body: renderIssueBody(e) };
  // The owner's own +1 sits alongside the fleet's own acknowledgement +1 (posted back on this
  // SAME issue once an earlier reaction answer landed) and a third party's +1 — only the owner's
  // counts.
  const gateway = fakeGateway(issue, [
    ownerReaction(5003, "+1"),
    fleetReaction(5004, "+1"),
    { id: 5005, content: "+1", authorLogin: "rando", authorType: "User" },
  ]);

  const result = readEscalationAnswers(root, "RUN-1", gateway, { ledgerPath });
  assert.deepEqual(result, { accepted: 1, ignored: 0, unreadable: 0 }, "exactly the owner's reaction is accepted");

  const stored = readQuestionsStore(root);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].origin, "issue#1003:reaction:5003", "only the owner's own reaction id is ever recorded");

  // Re-polling with the SAME table (the fleet's ack and the third party's +1 persist on GitHub
  // forever) still lands nothing new — neither is EVER read as an answer, not just skipped once.
  const second = readEscalationAnswers(root, "RUN-2", gateway, { ledgerPath });
  assert.deepEqual(second, { accepted: 0, ignored: 0, unreadable: 0 });
  assert.equal(readQuestionsStore(root).length, 1);

  // A bot posting under the OWNER's own login is refused too — the same defense-in-depth as the
  // comment reader (G-6 excludes automation, not just a login mismatch).
  const botUnderOwnerLogin: EscalationIssueReaction = { id: 5006, content: "+1", authorLogin: OWNER_LOGIN, authorType: "Bot" };
  const root2 = tmpRoot();
  const gateway2 = fakeGateway({ ...issue, number: 1004 }, [botUnderOwnerLogin]);
  const result2 = readEscalationAnswers(root2, "RUN-1", gateway2, { ledgerPath: join(root2, "state", "ledger.ndjson") });
  assert.deepEqual(result2, { accepted: 0, ignored: 0, unreadable: 0 });
  assert.deepEqual(readQuestionsStore(root2), []);

  // Direct unit coverage of the predicate itself.
  assert.equal(isOwnerReaction(ownerReaction(1, "+1"), OWNER_LOGIN), true);
  assert.equal(isOwnerReaction(fleetReaction(2, "+1"), OWNER_LOGIN), false);
  assert.equal(isOwnerReaction(botUnderOwnerLogin, OWNER_LOGIN), false, "a bot under the owner's own login is still refused");
  assert.equal(isOwnerReaction({ id: 3, content: "+1", authorLogin: "CraigOley", authorType: "User" }, OWNER_LOGIN), true, "case-insensitive");
});

// ── 4: a non-vote reaction is skipped, like a reply naming no option ───────────────────────────

test("W1-T4676: a reaction that isn't a vote is skipped and records nothing", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const e = escalation();
  const issue: OpenIssue = { number: 1005, url: "u1005", body: renderIssueBody(e) };
  const gateway = fakeGateway(issue, [ownerReaction(5007, "heart")]);

  const result = readEscalationAnswers(root, "RUN-1", gateway, { ledgerPath });
  assert.deepEqual(result, { accepted: 0, ignored: 0, unreadable: 0 });
  assert.deepEqual(readQuestionsStore(root), []);
  assert.deepEqual(gateway.reactedOnIssue, []);

  // Direct unit coverage: only +1/-1 ever produce recorded text; anything else, or an issue with
  // no recoverable recommendation, is `undefined`.
  assert.equal(reactionAnswerText("heart", issue.body ?? ""), undefined);
  assert.equal(reactionAnswerText("+1", "no recommendation heading in this body"), undefined);
  assert.equal(reactionAnswerText("+1", issue.body ?? ""), "retry");
  assert.match(reactionAnswerText("-1", issue.body ?? "") ?? "", /retry/);
});

// ── 5: a gateway with no reaction surface at all reads zero reactions, never crashes ───────────

test("W1-T4676: a gateway that omits listReactions/ownerLogin reads zero issue-level reactions", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const e = escalation();
  const issue: OpenIssue = { number: 1006, url: "u1006", body: renderIssueBody(e) };
  const legacyGateway: EscalationAnswerGateway = {
    listOpen: () => [issue],
    listComments: () => [],
    reactPlusOne: () => assert.fail("never reached"),
  };
  assert.deepEqual(readEscalationAnswers(root, "RUN-1", legacyGateway, { ledgerPath }), { accepted: 0, ignored: 0, unreadable: 0 });
  assert.deepEqual(readQuestionsStore(root), []);
});

// ── the degraded read: a failed reaction list is counted, never mistaken for "nothing new" ─────

test("W1-T4676: an unreadable reaction list is counted as unreadable and the issue's comments still land", () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const e = escalation();
  const issue: OpenIssue = { number: 1007, url: "u1007", body: renderIssueBody(e) };
  const gateway: EscalationAnswerGateway = {
    ownerLogin: OWNER_LOGIN,
    listOpen: () => [issue],
    listComments: () => [{ id: 6001, body: "retry", authorLogin: OWNER_LOGIN, authorAssociation: "OWNER", authorType: "User" }],
    listReactions: () => {
      throw new Error("gh api: HTTP 502");
    },
    reactPlusOne: () => {},
  };
  const result = readEscalationAnswers(root, "RUN-1", gateway, { ledgerPath });
  assert.deepEqual(result, { accepted: 1, ignored: 0, unreadable: 1 });
  assert.deepEqual(readQuestionsStore(root).map((r) => r.origin), ["issue#1007:comment:6001"]);
});

// ── the real `gh` gateway (a PATH shim, never the network) ─────────────────────────────────────

async function withShim<T>(routes: GhShimRoute[], fn: (calls: () => string[]) => T | Promise<T>): Promise<T> {
  const shim = ghShim(routes, { kind: "reaction-answer-gh" });
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

test("W1-T4676: ghEscalationAnswerGateway reads issue reactions over REST and acknowledges with +1 on the issue", async () => {
  const reactions = JSON.stringify([
    { id: 7001, content: "+1", user: { login: "craigoley", type: "User" } },
    { id: 7002, user: null },
  ]);
  await withShim([{ when: "issues/31/reactions", stdout: reactions }], (calls) => {
    const gateway = ghEscalationAnswerGateway("o", "r");
    assert.equal(gateway.ownerLogin, "o");
    assert.deepEqual(gateway.listReactions!(31), [
      { id: 7001, content: "+1", authorLogin: "craigoley", authorType: "User" },
      { id: 7002, content: "", authorLogin: "", authorType: "User" },
    ]);
    gateway.reactPlusOneOnIssue!(31);
    assert.ok(calls().some((c) => c.includes("repos/o/r/issues/31/reactions") && c.includes("content=+1")));
    assert.ok(!calls().some((c) => c.includes("body=")), "never posts a comment");
    assert.ok(
      !calls().some((c) => c.includes("issues/comments/") && c.includes("content=+1")),
      "an issue-level acknowledgement never reacts to a comment",
    );
  });
});

test("W1-T4676: ghEscalationAnswerGateway refuses a reactions page that is not a JSON array", async () => {
  await withShim([{ when: "issues/32/reactions", stdout: JSON.stringify({ message: "Not Found" }) }], () => {
    assert.throws(() => ghEscalationAnswerGateway("o", "r").listReactions!(32), /expected a JSON array page/);
  });
});
