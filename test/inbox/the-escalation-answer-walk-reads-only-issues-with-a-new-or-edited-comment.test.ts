// W1-T13710: the full sweep's escalation answer walk read the comments of about 107 open needs-question issues one at
// a time, at the 1.5 s read gap (p50 166 s, p90 929 s). One `issues/comments?since=` read a walk now names the issues
// with a comment created or edited since the last walk; an issue it does not name, whose listed comment count is the
// count of its kept read, is not read again.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { renderIssueBody, type Escalation } from "#src/lib/escalate.js";
import {
  ghEscalationAnswerGateway,
  readEscalationAnswers,
  type CommentsSinceRead,
  type EscalationAnswerGateway,
  type EscalationAnswerResult,
  type EscalationIssueComment,
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

function issue(number: number, listedComments: unknown, taskId = `W1-T${number}`, cls: Escalation["class"] = "BLOCKED"): ListedIssue {
  return { number, url: `https://github.com/o/r/issues/${number}`, body: renderIssueBody(escalation(taskId, cls)),
    listedComments, listedReactions: 0 };
}

const ownerComment = (id: number, body: string): EscalationIssueComment =>
  ({ id, body, authorLogin: OWNER, authorAssociation: "OWNER", authorType: "User" });
const strangerComment = (id: number, body: string): EscalationIssueComment =>
  ({ id, body, authorLogin: "someone", authorAssociation: "NONE", authorType: "User" });
const botComment = (id: number, body: string): EscalationIssueComment =>
  ({ id, body, authorLogin: "fleet[bot]", authorAssociation: "NONE", authorType: "Bot" });

/** The state one walk reads: the open list and each issue's comments. Tests change it between walks. */
interface World {
  issues: ListedIssue[];
  comments: Map<number, EscalationIssueComment[]>;
}

/** A gateway over `world`, counting each comment read; `since` answers the since read when given. */
function gateway(world: World, since?: (since: string | undefined) => CommentsSinceRead) {
  const commentReads: number[][] = [];
  const sinceArgs: (string | undefined)[] = [];
  const g: EscalationAnswerGateway = {
    ownerLogin: OWNER,
    listOpen: async () => { commentReads.push([]); return world.issues; },
    listComments: async (n) => {
      commentReads.at(-1)!.push(n);
      const got = world.comments.get(n);
      if (got === undefined) throw new Error(`fixture: issue ${n} is unreadable`);
      return got.map(c => ({ ...c }));
    },
    reactPlusOne: () => {},
    ...(since === undefined ? {} : {
      listCommentsSince: async (value: string | undefined) => { sinceArgs.push(value); return since(value); },
    }),
  };
  return { g, commentReads, sinceArgs };
}

function tmp(t: TestContext, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w13710-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One root that several walks share; each walk gives its result and the rows it wrote (no random ids). */
function root(t: TestContext, feedback = false) {
  const dir = tmp(t, "root");
  mkdirSync(join(dir, "state"));
  mkdirSync(join(dir, "plan"));
  const deps: Parameters<typeof readEscalationAnswers>[3] = { ledgerPath: join(dir, "state", "ledger.ndjson") };
  let rows: Record<string, unknown>[] = [];
  deps.writeLedger = (_path, row) => { const { pass_id: _p, reply_id: _r, ...rest } = row as Record<string, unknown>; rows.push(rest); };
  if (feedback) {
    const inboxRoot = tmp(t, "inbox");
    mkdirSync(join(dir, "plan", "feedback"), { recursive: true });
    writeFileSync(join(dir, "plan", "feedback", `${FB_ID}.yaml`), stringifyYaml({
      id: FB_ID, ts: "2026-11-18T00:00:00.000Z", raw: "the copy reads wrong", attachments: [], origin: "cli",
      status: "grilling", reply_to: null, proposal_pr: null, summary: null, answered_by: null,
    }));
    deps.feedback = { root: dir, inboxRoot, feedbackLand: {} };
  }
  return {
    dir,
    questions: () => existsSync(join(dir, "plan", "questions.ndjson")) ? readFileSync(join(dir, "plan", "questions.ndjson"), "utf8") : "",
    async walk(g: EscalationAnswerGateway): Promise<{ result: EscalationAnswerResult; rows: Record<string, unknown>[] }> {
      rows = [];
      const result = await readEscalationAnswers(dir, "RUN-13710", g, deps, CLOCK);
      return { result, rows };
    },
  };
}

const NOTHING_NEW = (): CommentsSinceRead => ({ issueNumbers: [] });
const FIRST = (value: string | undefined): CommentsSinceRead =>
  value === undefined ? { newestUpdatedAt: "2026-11-18T09:00:00Z" } : { issueNumbers: [] };

test("W1-T13710 criterion 1: a later walk does not read an unnamed issue whose count is unchanged, with the same rows", async t => {
  const world = (): World => ({
    issues: [issue(101, 3), issue(102, 1, `TRIAGE-${FB_ID}`, "GRILL")],
    comments: new Map([
      [101, [strangerComment(11, "abandon"), botComment(12, "noise"), ownerComment(13, "retry")]],
      [102, [ownerComment(21, "retry, but only the test")]],
    ]),
  });
  const skipping = gateway(world(), FIRST);
  const control = gateway(world());
  const a = root(t, true);
  const b = root(t, true);
  const got = [await a.walk(skipping.g), await a.walk(skipping.g), await a.walk(skipping.g)];
  const want = [await b.walk(control.g), await b.walk(control.g), await b.walk(control.g)];
  assert.deepEqual(skipping.commentReads, [[101, 102], [], []], "only the first walk reads the comments");
  assert.deepEqual(control.commentReads, [[101, 102], [101, 102], [101, 102]], "control: with no since read every walk reads");
  assert.deepEqual(got.map(w => w.result), want.map(w => w.result));
  assert.deepEqual(got.map(w => w.rows), want.map(w => w.rows));
  assert.equal(a.questions(), b.questions());
  assert.deepEqual(got[1].result, { accepted: 0, ignored: 2, unreadable: 0 });
  assert.ok(got[0].rows.some(r => r.step === "escalation_answer.feedback_applied"), "the grilled record is answered");
});


test("W1-T13710 criterion 2: an issue the since read names is read again, and an answer edited into a comment lands", async t => {
  const make = (): World => ({
    issues: [issue(201, 1), issue(202, 1), issue(203, 1), issue(204, 1)],
    comments: new Map([
      [201, [ownerComment(31, "  ")]],
      [202, [ownerComment(32, "  ")]],
      [203, [ownerComment(33, "  ")]],
      [204, [ownerComment(34, "Still open as of 2026-11-18 (issue-revalidation garden, run 1)")]],
    ]),
  });
  const skippingWorld = make();
  const controlWorld = make();
  const skipping = gateway(skippingWorld, value => value === undefined ? { newestUpdatedAt: "2026-11-18T09:00:00Z" }
    : { issueNumbers: [201, 202, 204, 999], newestUpdatedAt: "2026-11-18T09:10:00Z" });
  const control = gateway(controlWorld);
  const a = root(t);
  const b = root(t);
  await a.walk(skipping.g);
  await b.walk(control.g);
  for (const world of [skippingWorld, controlWorld]) {
    world.comments.set(201, [ownerComment(31, "retry")]); // edited in place: the count stays 1
    world.comments.set(202, [ownerComment(35, "abandon")]); // one deleted, one new: the count stays 1
    world.comments.set(204, [ownerComment(34, "retry")]); // the fleet's text, edited into an answer
  }
  const got = await a.walk(skipping.g);
  const want = await b.walk(control.g);
  assert.deepEqual(skipping.commentReads[1], [201, 202, 204], "every named issue is read; 203 is not named");
  assert.deepEqual(got, want);
  assert.equal(a.questions(), b.questions());
  const landed = a.questions().trim().split("\n").map(line => JSON.parse(line) as { origin: string; answer: string });
  assert.deepEqual(landed.map(q => [q.origin, q.answer]), [
    ["issue#201:comment:31", "retry"], ["issue#202:comment:35", "abandon"], ["issue#204:comment:34", "retry"],
  ]);
});

test("W1-T13710 criterion 3: a walk with no kept read, a changed count or a failed since read reads as before", async t => {
  const c = (id: number) => strangerComment(id, "hello");
  const world: World = {
    issues: [issue(301, 1), issue(302, 2), issue(303, 0), issue(305, undefined)],
    comments: new Map([[301, [c(1)]], [302, [c(2), c(3)]], [303, []], [305, [c(5)]]]),
  };
  let fail = false;
  let named: number[] = [];
  const g = gateway(world, value => {
    if (fail) throw new Error("fixture: the since read failed");
    return { issueNumbers: named, newestUpdatedAt: value ?? "2026-11-18T09:00:00Z" };
  });
  const r = root(t);
  await r.walk(g.g);
  assert.deepEqual(g.commentReads[0], [301, 302, 305], "the first walk reads every issue; 303 lists 0 (W1-T13688)");
  world.issues = [issue(301, 1), issue(302, 3), issue(303, 0), issue(304, 1), issue(305, undefined)];
  world.comments.set(302, [c(2), c(3), c(6)]);
  world.comments.set(304, [c(4)]);
  await r.walk(g.g);
  assert.deepEqual(g.commentReads[1], [302, 304, 305], "a changed count, an issue with no kept read and no listed count read");
  fail = true;
  const failed = await r.walk(g.g);
  assert.deepEqual(g.commentReads[2], [301, 302, 304, 305], "a failed since read reads every issue");
  assert.equal(failed.result.unreadable, 0, "a failed since read is not an unreadable issue");
  fail = false;
  await r.walk(g.g);
  assert.deepEqual(g.commentReads[3], [305]);
  // A failed comment read keeps no read, so the next walk reads that issue although nothing names it.
  named = [301];
  const kept301 = world.comments.get(301)!;
  world.comments.delete(301);
  assert.equal((await r.walk(g.g)).result.unreadable, 1);
  named = [];
  world.comments.set(301, kept301);
  await r.walk(g.g);
  assert.deepEqual(g.commentReads[5], [301, 305]);

  // No since kept yet (the first since read failed): kept reads exist, but the next walk still reads every issue.
  let firstFails = true;
  const noSince = gateway({ issues: [issue(321, 1)], comments: new Map([[321, [c(21)]]]) }, () => {
    if (firstFails) { firstFails = false; throw new Error("fixture: the first since read failed"); }
    return { issueNumbers: [], newestUpdatedAt: "2026-11-18T09:00:00Z" };
  });
  const rs = root(t);
  for (let i = 0; i < 3; i++) await rs.walk(noSince.g);
  assert.deepEqual(noSince.sinceArgs, [undefined, undefined, "2026-11-18T09:00:00Z"]);
  assert.deepEqual(noSince.commentReads, [[321], [321], []], "a walk with no stored since reads every issue");

  // The real gateway: a since read it cannot parse rejects, and that walk reads every issue.
  const list = JSON.stringify([311, 312].map(number => ({ number, html_url: `https://github.com/o/r/issues/${number}`,
    state: "open", title: "q", comments: 1, reactions: { total_count: 0 }, body: renderIssueBody(escalation(`W1-T${number}`)) })));
  let sinceAnswer = "[]";
  const sent: string[] = [];
  const real = ghEscalationAnswerGateway("o", "r", async args => {
    sent.push(args[1]);
    if (args[1].includes("issues?labels=")) return list;
    if (args[1].includes("issues/comments?sort=updated")) return JSON.stringify([{ updated_at: "2026-11-18T09:00:00Z", issue_url: "x" }]);
    if (args[1].includes("issues/comments?since=")) return sinceAnswer;
    return JSON.stringify([{ id: 9, body: "  ", author_association: "OWNER", user: { login: OWNER, type: "User" } }]);
  });
  const perIssue = () => sent.filter(path => /issues\/\d+\/comments/.test(path)).length;
  const rr = root(t);
  await rr.walk(real);
  assert.equal(perIssue(), 2);
  for (const bad of ['{"message":"Bad credentials"}', JSON.stringify([{ updated_at: "2026-11-18T09:01:00Z" }]),
    JSON.stringify([{ issue_url: "https://api.github.com/repos/o/r/issues/311" }]), "[{"]) {
    sinceAnswer = bad;
    await assert.rejects(async () => real.listCommentsSince!("2026-11-18T09:00:00Z"));
    const before = perIssue();
    await rr.walk(real);
    assert.equal(perIssue() - before, 2, `a since read of ${bad} reads every issue`);
  }
  sinceAnswer = "[]";
  const before = perIssue();
  await rr.walk(real);
  assert.equal(perIssue() - before, 0, "control: a since read that parses and names nothing reads no issue");
});

test("W1-T13710 criterion 4: the since comes only from updated_at values GitHub gave, never from the host clock", async t => {
  const answers: (CommentsSinceRead | Error)[] = [
    { newestUpdatedAt: "2026-11-18T09:00:00Z" }, { issueNumbers: [] },
    { issueNumbers: [401], newestUpdatedAt: "2026-11-18T09:30:00Z" }, new Error("fixture: read failed"), { issueNumbers: [] },
  ];
  const g = gateway({ issues: [issue(401, 1)], comments: new Map([[401, [strangerComment(1, "x")]]]) }, () => {
    const next = answers.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  const r = root(t);
  for (let i = 0; i < 5; i++) await r.walk(g.g);
  assert.deepEqual(g.sinceArgs, [undefined, "2026-11-18T09:00:00Z", "2026-11-18T09:00:00Z", "2026-11-18T09:30:00Z",
    "2026-11-18T09:30:00Z"], "an empty or failed read keeps the previous since");
  assert.ok(!g.sinceArgs.includes(CLOCK.iso()));

  // The real gateway: the first read asks GitHub for its newest comment; a since read walks every page.
  const sent: string[][] = [];
  let raw = "";
  const real = ghEscalationAnswerGateway("o", "r", async args => { sent.push(args); return raw; });
  raw = JSON.stringify([{ updated_at: "2026-11-18T08:59:59Z", issue_url: "https://api.github.com/repos/o/r/issues/7" }]);
  assert.deepEqual(await real.listCommentsSince!(undefined), { newestUpdatedAt: "2026-11-18T08:59:59Z" });
  assert.deepEqual(sent[0], ["api", "repos/o/r/issues/comments?sort=updated&direction=desc&per_page=1"]);
  raw = JSON.stringify([{ updated_at: "2026-11-18T09:20:00Z", issue_url: "https://api.github.com/repos/o/r/issues/7" }]) + "\n" +
    JSON.stringify([{ updated_at: "2026-11-18T09:05:00Z", issue_url: "https://api.github.com/repos/o/r/issues/8" },
      { updated_at: "2026-11-18T09:40:00Z", issue_url: "https://api.github.com/repos/o/r/issues/9" }]);
  assert.deepEqual(await real.listCommentsSince!("2026-11-18T08:59:59Z"),
    { issueNumbers: [7, 8, 9], newestUpdatedAt: "2026-11-18T09:40:00Z" }, "the newest across every page");
  assert.deepEqual(sent[1], ["api", "repos/o/r/issues/comments?since=2026-11-18T08%3A59%3A59Z&per_page=100", "--paginate"]);
  raw = "[]";
  assert.deepEqual(await real.listCommentsSince!("2026-11-18T09:40:00Z"), { issueNumbers: [], newestUpdatedAt: undefined });
});

test("W1-T13710 criterion 5: through the real gateway and gh, a walk sends one since read and reads only the edited issue", async t => {
  const dir = tmp(t, "answers");
  const sinceFile = join(dir, "since.json");
  const a501File = join(dir, "501.json");
  const comment = (id: number, body: string) => ({ id, body, author_association: "OWNER", updated_at: "2026-11-18T08:00:00Z",
    user: { login: OWNER, type: "User" } });
  writeFileSync(a501File, JSON.stringify([comment(71, "  ")]));
  const list = JSON.stringify([501, 502].map(number => ({ number, html_url: `https://github.com/o/r/issues/${number}`,
    state: "open", title: "q", comments: 1, reactions: { total_count: 0 }, body: renderIssueBody(escalation(`W1-T${number}`)) })));
  const routes: GhShimRoute[] = [
    { when: "issues/comments?since=", stdoutFile: sinceFile },
    { when: "issues/comments?sort=updated", stdout: JSON.stringify([{ updated_at: "2026-11-18T09:00:00Z",
      issue_url: "https://api.github.com/repos/o/r/issues/999" }]) },
    { when: "issues/501/comments", stdoutFile: a501File },
    { when: "issues/502/comments", stdout: JSON.stringify([comment(72, "retry")]) },
    { when: "issues?labels=needs-question", stdout: list },
    { when: "", stdout: "[]" },
  ];
  const shim = ghShim(routes, { kind: "w13710-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const r = root(t);
  const real = ghEscalationAnswerGateway("o", "r");
  const walk = async () => {
    const start = shim.calls().length;
    const got = await r.walk(real);
    const calls = shim.calls().slice(start);
    return { got, since: calls.filter(call => call.includes("issues/comments?since=")),
      reads: calls.filter(call => /issues\/\d+\/comments/.test(call)) };
  };
  const first = await walk();
  assert.equal(first.reads.length, 2, "the first walk reads both issues");
  assert.equal(first.got.result.accepted, 1);
  writeFileSync(sinceFile, "[]");
  const unchanged = await walk();
  assert.equal(unchanged.since.length, 1, "one since read");
  assert.ok(unchanged.since[0].includes("since=2026-11-18T09%3A00%3A00Z"), unchanged.since[0]);
  assert.deepEqual(unchanged.reads, [], "no issue read when nothing changed");
  writeFileSync(sinceFile, JSON.stringify([{ id: 71, updated_at: "2026-11-18T09:05:00Z",
    issue_url: "https://api.github.com/repos/o/r/issues/501" }]));
  writeFileSync(a501File, JSON.stringify([{ ...comment(71, "abandon"), updated_at: "2026-11-18T09:05:00Z" }]));
  const edited = await walk();
  assert.equal(edited.since.length, 1);
  assert.ok(edited.since[0].includes("since=2026-11-18T09%3A00%3A00Z"), "an empty answer kept the since");
  assert.equal(edited.reads.length, 1);
  assert.ok(edited.reads[0].includes("repos/o/r/issues/501/comments?per_page=100"), edited.reads[0]);
  assert.deepEqual(edited.got.result, { accepted: 1, ignored: 0, unreadable: 0 });
  assert.match(r.questions(), /"origin":"issue#501:comment:71"/);
});
