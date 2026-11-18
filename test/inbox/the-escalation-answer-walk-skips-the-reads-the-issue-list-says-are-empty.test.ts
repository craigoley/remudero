// W1-T13688: the escalation answer walk read every open needs-question issue's comments and reactions, one paged
// REST read each, although the issue list row already gives both counts. On 2026-11-18, 159 of the walk's 267
// per-issue reads answered an empty list. A list row that gives exactly 0 now skips that read; any other count reads.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { renderIssueBody, type Escalation } from "#src/lib/escalate.js";
import {
  ghEscalationAnswerGateway,
  readEscalationAnswers,
  type EscalationAnswerGateway,
  type EscalationAnswerResult,
  type EscalationIssueComment,
  type EscalationIssueReaction,
  type ListedIssue,
} from "#src/lib/escalation-answers.js";
import { fixedClock } from "#src/lib/clock.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";

const OWNER = "craigoley";
const CLOCK = fixedClock(Date.UTC(2026, 10, 18, 12, 0, 0));
const FB_ID = "fb-1795000000000-a1b2c3";

function escalation(taskId: string, cls: Escalation["class"] = "BLOCKED"): Escalation {
  return {
    class: cls, taskId, summary: "two strikes exhausted", detail: "the retry still failed CI.",
    options: [{ label: "retry", detail: "resume the run" }, { label: "abandon", detail: "drop the task" }],
    recommendation: "retry",
  };
}

function issue(number: number, counts: Partial<Pick<ListedIssue, "listedComments" | "listedReactions">>, taskId = `W1-T${number}`,
  cls: Escalation["class"] = "BLOCKED"): ListedIssue {
  return { number, url: `https://github.com/o/r/issues/${number}`, body: renderIssueBody(escalation(taskId, cls)), ...counts };
}

const ownerComment = (id: number, body: string): EscalationIssueComment =>
  ({ id, body, authorLogin: OWNER, authorAssociation: "OWNER", authorType: "User" });
const strangerComment = (id: number, body: string): EscalationIssueComment =>
  ({ id, body, authorLogin: "someone", authorAssociation: "NONE", authorType: "User" });
const ownerReaction = (id: number, content: string): EscalationIssueReaction =>
  ({ id, content, authorLogin: OWNER, authorType: "User" });

/** A gateway that lists `issues` and answers each per-issue read from the maps, counting every read. */
function gateway(issues: ListedIssue[], comments: Map<number, EscalationIssueComment[]>,
  reactions: Map<number, EscalationIssueReaction[]>) {
  const commentReads: number[] = [];
  const reactionReads: number[] = [];
  const g: EscalationAnswerGateway = {
    ownerLogin: OWNER,
    listOpen: async () => issues,
    listComments: async (n) => { commentReads.push(n); return comments.get(n) ?? []; },
    listReactions: async (n) => { reactionReads.push(n); return reactions.get(n) ?? []; },
    reactPlusOne: () => {},
    reactPlusOneOnIssue: () => {},
  };
  return { g, commentReads, reactionReads };
}

function tmp(t: TestContext, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w13688-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One pass in a fresh root; the rows it writes, without the random pass id and reply id. */
async function pass(t: TestContext, g: EscalationAnswerGateway, feedback = false): Promise<{ result: EscalationAnswerResult;
  rows: Record<string, unknown>[] }> {
  const root = tmp(t, "root");
  mkdirSync(join(root, "state"));
  const rows: Record<string, unknown>[] = [];
  const deps: Parameters<typeof readEscalationAnswers>[3] = {
    ledgerPath: join(root, "state", "ledger.ndjson"),
    writeLedger: (_path, row) => { const { pass_id: _p, reply_id: _r, ...rest } = row as Record<string, unknown>; rows.push(rest); },
  };
  if (feedback) {
    const inboxRoot = tmp(t, "inbox");
    mkdirSync(join(root, "plan", "feedback"), { recursive: true });
    writeFileSync(join(root, "plan", "feedback", `${FB_ID}.yaml`), stringifyYaml({
      id: FB_ID, ts: "2026-11-18T00:00:00.000Z", raw: "the copy reads wrong", attachments: [], origin: "cli",
      status: "grilling", reply_to: null, proposal_pr: null, summary: null, answered_by: null,
    }));
    deps.feedback = { root, inboxRoot, feedbackLand: {} };
  }
  const result = await readEscalationAnswers(root, "RUN-13688", g, deps, CLOCK);
  return { result, rows };
}

const strip = (issues: ListedIssue[]): ListedIssue[] =>
  issues.map(({ listedComments: _c, listedReactions: _r, ...rest }) => rest);

test("W1-T13688 criterion 1: a list row with 0 comments and 0 reactions sends neither read and acts as two empty reads", async t => {
  const issues = [issue(101, { listedComments: 0, listedReactions: 0 }), issue(102, { listedComments: 0 }),
    issue(103, { listedReactions: 0 })];
  const comments = new Map([[103, [ownerComment(31, "retry")]]]);
  const reactions = new Map([[102, [ownerReaction(21, "+1")]]]);
  const skipped = gateway(issues, comments, reactions);
  const got = await pass(t, skipped.g);
  assert.deepEqual(skipped.commentReads, [103], "only the issue whose row gives a non-zero or no comment count is read");
  assert.deepEqual(skipped.reactionReads, [102]);
  const read = gateway(strip(issues), comments, reactions);
  const want = await pass(t, read.g);
  assert.deepEqual(read.commentReads, [101, 102, 103], "control: with no counts every issue is read");
  assert.deepEqual(got.result, want.result);
  assert.deepEqual(got.rows, want.rows);
  assert.equal(got.result.accepted, 2, "the comment on 103 and the reaction on 102 still land");
});

test("W1-T13688 criterion 2: a list row with 1 or more comments or reactions still reads them, with the same rows", async t => {
  const issues = [issue(201, { listedComments: 2, listedReactions: 1 })];
  const comments = new Map([[201, [strangerComment(41, "retry"), ownerComment(42, "abandon")]]]);
  const reactions = new Map([[201, [ownerReaction(51, "+1")]]]);
  const counted = gateway(issues, comments, reactions);
  const got = await pass(t, counted.g);
  assert.deepEqual(counted.commentReads, [201]);
  assert.deepEqual(counted.reactionReads, [201]);
  const want = await pass(t, gateway(strip(issues), comments, reactions).g);
  assert.deepEqual(got.result, want.result);
  assert.deepEqual(got.result, { accepted: 2, ignored: 1, unreadable: 0 });
  assert.deepEqual(got.rows, want.rows);
  assert.deepEqual(got.rows.map(r => [r.step, r.origin, r.reason]), [
    ["escalation_answer.ignored", "issue#201:comment:41", "not-owner"],
    ["panel.question_answered", "issue#201:comment:42", undefined],
    ["panel.question_answered", "issue#201:reaction:51", undefined],
  ]);
});

test("W1-T13688 criterion 3: a missing or odd count reads both lists as before", async t => {
  const odd: unknown[] = [undefined, null, -1, 0.5, "0", Number.NaN, -0.0001, Number.MAX_SAFE_INTEGER + 2, {}];
  const issues = odd.map((count, i) => issue(300 + i, { listedComments: count, listedReactions: count }));
  const g = gateway(issues, new Map(), new Map());
  await pass(t, g.g);
  assert.deepEqual(g.commentReads, issues.map(i => i.number));
  assert.deepEqual(g.reactionReads, issues.map(i => i.number));
  // A gateway that gives no counts at all, as every existing test double does.
  const plain = gateway(strip(issues), new Map(), new Map());
  await pass(t, plain.g);
  assert.deepEqual(plain.commentReads, issues.map(i => i.number));
  assert.deepEqual(plain.reactionReads, issues.map(i => i.number));
});

test("W1-T13688 criterion 4: a feedback grill issue whose reads are skipped answers its record as empty reads do", async t => {
  const grill = (counts: Partial<ListedIssue>) => issue(401, counts, `TRIAGE-${FB_ID}`, "GRILL");
  // 0 comments and 0 reactions: no answer, no feedback row, exactly as two empty reads.
  const none = gateway([grill({ listedComments: 0, listedReactions: 0 })], new Map(), new Map());
  const got = await pass(t, none.g, true);
  const want = await pass(t, gateway([grill({})], new Map(), new Map()).g, true);
  assert.equal(none.commentReads.length + none.reactionReads.length, 0);
  assert.deepEqual(got, want);
  // 0 comments and one owner reaction: the skipped comment read still hands the reaction answer to the record.
  const reactions = new Map([[401, [ownerReaction(61, "+1")]]]);
  const half = gateway([grill({ listedComments: 0, listedReactions: 1 })], new Map(), reactions);
  const gotHalf = await pass(t, half.g, true);
  const wantHalf = await pass(t, gateway([grill({})], new Map(), reactions).g, true);
  assert.equal(half.commentReads.length, 0);
  assert.deepEqual(gotHalf, wantHalf);
  assert.ok(gotHalf.rows.some(r => String(r.step).startsWith("escalation_answer.feedback_")),
    "the grilled feedback record is answered from the reaction");
});

test("W1-T13688 criterion 5: the real gateway reads the counts off the list and sends no read for an empty issue", async t => {
  const list = JSON.stringify([
    { number: 501, html_url: "https://github.com/o/r/issues/501", state: "open", title: "a", comments: 0,
      reactions: { total_count: 0 }, body: renderIssueBody(escalation("W1-T501")) },
    { number: 502, html_url: "https://github.com/o/r/issues/502", state: "open", title: "b", comments: 2,
      reactions: { total_count: 1 }, body: renderIssueBody(escalation("W1-T502")) },
  ]);
  const routes: GhShimRoute[] = [
    { when: "issues/502/comments", stdout: JSON.stringify([
      { id: 71, body: "retry", author_association: "OWNER", user: { login: OWNER, type: "User" } },
      { id: 72, body: "hello", author_association: "NONE", user: { login: "someone", type: "User" } }]) },
    { when: "issues/502/reactions", stdout: JSON.stringify([{ id: 81, content: "+1", user: { login: "o", type: "User" } }]) },
    { when: "issues?labels=needs-question", stdout: list },
    { when: "", stdout: "[]" },
  ];
  const shim = ghShim(routes, { kind: "w13688-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const got = await pass(t, ghEscalationAnswerGateway("o", "r"));
  const calls = shim.calls();
  assert.ok(calls.some(c => c.includes("issues?labels=needs-question")), "the list is read");
  assert.ok(!calls.some(c => c.includes("issues/501/comments") || c.includes("issues/501/reactions")),
    `no per-issue read for #501: ${calls.join(" | ")}`);
  assert.ok(calls.some(c => c.includes("repos/o/r/issues/502/comments?per_page=100")));
  assert.ok(calls.some(c => c.includes("repos/o/r/issues/502/reactions?per_page=100")));
  assert.deepEqual(got.result, { accepted: 2, ignored: 1, unreadable: 0 });
});
