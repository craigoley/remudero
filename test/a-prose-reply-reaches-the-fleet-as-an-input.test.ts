import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import {
  buildEscalationReplyRoute,
  buildEscalationMarkHandledRoute,
  buildAnswerQuestionRoute,
  type IssueCloser,
  type PanelActionDeps,
} from "../src/lib/panel-actions.js";
import { readFeedbackEntry, listFeedback, FEEDBACK_STATUSES, isValidFeedbackOrigin } from "../src/lib/feedback.js";
import { appendThreadMessage, deriveThreadId, readThread, type ThreadIdentity } from "../src/lib/inbox-thread.js";

// ── W1-T2496: forty console routes shipped and not one let a human answer an escalation in
// prose. `/v1/escalation/mark-handled` dismisses (no words); `/v1/questions/answer` answers a
// structured QUESTION contract (not an escalation); the only way to say something back was to
// file feedback naming no message and no thread. This suite proves the new
// `POST /v1/escalation/reply` route closes that gap WITHOUT opening a new one: the reply reuses
// the existing feedback/triage pipeline (never a new store), can never dispatch, ratify, arm a
// merge, or comment on GitHub, and refuses outright rather than filing unattached when the
// thread it names was never actually raised.
//
// Acceptance (plan/tasks.d/W1-T2496-...yaml), each proven by name below:
//   1. a prose reply on a thread lands as a feedback entry carrying that thread id
//   2. the entry is the same record shape triage already consumes
//   3. a reply dispatches no task, ratifies nothing and arms no merge
//   4. a reply naming no existing thread is refused rather than filed unattached
//   5. the existing dismiss route keeps its current behaviour exactly
//   6. the route requires the same write scope the other write routes require
//   7. nothing on this path comments on a GitHub issue
//   8. granting a reply the power to dispatch makes the refusal assertion fail

const READ_TOKEN = "reply-read-token";
const WRITE_TOKEN = "reply-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-escalation-reply-"));
}

function threadStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-escalation-reply-threads-")), "threads.jsonl");
}

function fakeIssueCloser(): IssueCloser & { closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    close(issueUrl: string) {
      closed.push(issueUrl);
    },
  };
}

function depsFor(root: string, path: string, issues: IssueCloser = fakeIssueCloser()): PanelActionDeps {
  return { root, ledgerPath: join(root, "state", "ledger.ndjson"), issues, threadStorePath: path };
}

async function withService<T>(routes: ReturnType<typeof buildEscalationReplyRoute>[], fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes });
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

function identity(over: Partial<ThreadIdentity> = {}): ThreadIdentity {
  return { taskId: "W1-T9101", class: "BLOCKED", ...over };
}

function replyBody(over: Record<string, unknown> = {}) {
  return { taskId: "W1-T9101", class: "BLOCKED", text: "retry once more, the flake looks like ci noise", ...over };
}

/** Seed a thread with a single escalation message, the precondition every reply needs. */
function raisedThread(path: string, id: ThreadIdentity = identity()): string {
  return appendThreadMessage(id, "escalation", "the retry still failed CI", { threadStorePath: path });
}

// ── 1: a prose reply on a thread lands as a feedback entry carrying that thread id ───────────

test("a prose reply on a raised thread lands as a feedback entry carrying that thread id", async () => {
  const root = tmpRoot();
  const path = threadStorePath();
  const threadId = raisedThread(path);

  await withService([buildEscalationReplyRoute(depsFor(root, path))], async (base) => {
    const res = await post(base, "/v1/escalation/reply", WRITE_TOKEN, replyBody());
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; threadId: string; feedback: { id: string; thread_id?: string | null } };
    assert.equal(body.threadId, threadId);
    assert.equal(body.feedback.thread_id, threadId);

    // Filed for real, at the durable path -- readable back byte for byte.
    const entry = readFeedbackEntry(root, body.feedback.id);
    assert.equal(entry.thread_id, threadId);
    assert.equal(entry.raw, "retry once more, the flake looks like ci noise");
  });

  // The reply is also on the thread itself -- appended, never a side record only feedback knows.
  const read = readThread(threadId, { threadStorePath: path });
  assert.equal(read.status, "ok");
  assert.deepEqual(read.status === "ok" && read.messages.map((m) => m.role), ["escalation", "reply"]);
});

// ── 2: the entry is the same record shape triage already consumes ────────────────────────────

test("the filed entry is a plain FeedbackEntry -- the exact shape rmd triage / listFeedback already read", async () => {
  const root = tmpRoot();
  const path = threadStorePath();
  raisedThread(path);

  await withService([buildEscalationReplyRoute(depsFor(root, path))], async (base) => {
    const res = await post(base, "/v1/escalation/reply", WRITE_TOKEN, replyBody());
    assert.equal(res.status, 200);
  });

  const all = listFeedback(root);
  assert.equal(all.length, 1);
  const entry = all[0];
  // Every §7B field a triage reader already depends on is present and well-formed -- nothing
  // about this entry is a bespoke shape only this route understands.
  assert.ok(typeof entry.id === "string" && entry.id.length > 0);
  assert.ok(typeof entry.ts === "string");
  assert.equal(entry.status, "new");
  assert.ok((FEEDBACK_STATUSES as readonly string[]).includes(entry.status));
  assert.ok(isValidFeedbackOrigin(entry.origin));
  assert.equal(entry.proposal_pr, null);
  assert.deepEqual(entry.attachments, []);
  assert.equal(entry.reply_to, null); // the OTHER reply edge (W1-T2278, feedback->feedback) is untouched
  assert.ok(typeof entry.thread_id === "string" && entry.thread_id.length > 0);
});

// ── 4: a reply naming no existing thread is refused rather than filed unattached ──────────────

test("a reply naming a thread that was never raised is refused, and files nothing", async () => {
  const root = tmpRoot();
  const path = threadStorePath(); // never seeded -- no escalation ever raised this identity

  await withService([buildEscalationReplyRoute(depsFor(root, path))], async (base) => {
    const res = await post(base, "/v1/escalation/reply", WRITE_TOKEN, replyBody({ taskId: "W1-T-NEVER-RAISED" }));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail: string };
    assert.match(body.detail, /names no existing escalation/);
  });

  assert.deepEqual(listFeedback(root), []);
  // The thread store itself gained nothing either -- a refusal writes NOTHING, on either side.
  const read = readThread(deriveThreadId({ taskId: "W1-T-NEVER-RAISED", class: "BLOCKED" }), { threadStorePath: path });
  assert.equal(read.status, "ok");
  assert.equal(read.status === "ok" && read.messages.length, 0);
});

test("a reply with no thread store configured at all is refused the same way -- never guesses a thread exists", async () => {
  const root = tmpRoot();
  const deps: PanelActionDeps = { root, ledgerPath: join(root, "state", "ledger.ndjson"), issues: fakeIssueCloser() }; // no threadStorePath

  await withService([buildEscalationReplyRoute(deps)], async (base) => {
    const res = await post(base, "/v1/escalation/reply", WRITE_TOKEN, replyBody());
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail: string };
    assert.match(body.detail, /no thread store configured/);
  });
  assert.deepEqual(listFeedback(root), []);
});

test("a reply naming a thread that only a torn/unreadable store carries is refused, not treated as empty", async () => {
  const root = tmpRoot();
  const path = threadStorePath();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, "not json at all\n");

  await withService([buildEscalationReplyRoute(depsFor(root, path))], async (base) => {
    const res = await post(base, "/v1/escalation/reply", WRITE_TOKEN, replyBody());
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail: string };
    assert.match(body.detail, /cannot be read/);
  });
  assert.deepEqual(listFeedback(root), []);
});

// ── 5: the existing dismiss route keeps its current behaviour exactly ────────────────────────

test("POST /v1/escalation/mark-handled is untouched by this task -- still closes the issue and ledgers exactly as before", async () => {
  const root = tmpRoot();
  const path = threadStorePath();
  const issues = fakeIssueCloser();
  const deps = depsFor(root, path, issues);

  await withService([buildEscalationMarkHandledRoute(deps)], async (base) => {
    const res = await post(base, "/v1/escalation/mark-handled", WRITE_TOKEN, {
      taskId: "W1-T9101",
      issueUrl: "https://github.com/craigoley/remudero/issues/9101",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; taskId: string; issueUrl: string };
    assert.deepEqual(body, { ok: true, taskId: "W1-T9101", issueUrl: "https://github.com/craigoley/remudero/issues/9101" });
  });
  assert.deepEqual(issues.closed, ["https://github.com/craigoley/remudero/issues/9101"]);
  // A dismiss files no feedback -- it never did, and this task must not change that.
  assert.deepEqual(listFeedback(root), []);
});

// ── 6: the route requires the same write scope the other write routes require ────────────────

test("POST /v1/escalation/reply is write-scoped, tier low -- exactly what the other escalation routes require", async () => {
  const root = tmpRoot();
  const path = threadStorePath();
  raisedThread(path);
  const deps = depsFor(root, path);

  const replyRoute = buildEscalationReplyRoute(deps);
  const markHandledRoute = buildEscalationMarkHandledRoute(deps);
  const answerRoute = buildAnswerQuestionRoute(deps);
  assert.equal(replyRoute.scope, "write");
  assert.equal(replyRoute.scope, markHandledRoute.scope);
  assert.equal(replyRoute.tier, "low");
  assert.equal(replyRoute.tier, markHandledRoute.tier);
  assert.equal(replyRoute.tier, answerRoute.tier);

  await withService([replyRoute], async (base) => {
    const res = await post(base, "/v1/escalation/reply", READ_TOKEN, replyBody());
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string; required_scope: string };
    assert.equal(body.error, "forbidden");
    assert.equal(body.required_scope, "write");
  });
  // A rejected caller's request produced no side effect at all.
  assert.deepEqual(listFeedback(root), []);
});

// ── 3, 7, 8: a reply is an input, never a command -- static proof over the actual source ─────
//
// Behavioural coverage (above) proves this route never calls `issues.close` on a successful
// reply; this proves the STRONGER, whole-function claim -- the handler names NO dispatch
// primitive, NO ratify gateway, and NO issue-comment/close/create call anywhere in its body, not
// merely on the one path the tests above happened to exercise.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function readSrc(relPath: string): string {
  return readFileSync(join(REPO_ROOT, "src", relPath), "utf8");
}

function extractRouteBody(src: string): string {
  const fnMatch = /export function buildEscalationReplyRoute\(deps: PanelActionDeps\): Route \{[\s\S]*?\n\}\n/.exec(src);
  assert.ok(fnMatch, "buildEscalationReplyRoute must exist in src/lib/panel-actions.ts");
  return fnMatch![0];
}

/** Every primitive that would let a reply dispatch a task, ratify a proposal, arm a merge, or
 *  comment on/close/create a GitHub issue on the operator's behalf. */
const FORBIDDEN_POWER = /requestKick\(|requestDrainNow\(|requestPause\(|resumeFleet\(|ratify\.(approve|reframe)\(|gh\s+pr\s+(merge|close)|deps\.issues\.(close|create)\(|classifyProposal\(/;

test("buildEscalationReplyRoute's body names no dispatch primitive, no ratify gateway, and no GitHub issue action", () => {
  const body = extractRouteBody(readSrc("lib/panel-actions.ts"));
  assert.doesNotMatch(body, FORBIDDEN_POWER);
  // Positive control: the check itself must actually see the three calls this route DOES make,
  // proving it isn't vacuously passing on an empty/mis-extracted body.
  assert.match(body, /appendThreadMessage\(/);
  assert.match(body, /captureFeedback\(/);
  assert.match(body, /ledgerPanelAction\(/);
});

test("granting a reply the power to dispatch makes the refusal assertion fail", () => {
  const body = extractRouteBody(readSrc("lib/panel-actions.ts"));
  assert.doesNotMatch(body, FORBIDDEN_POWER); // the real, shipped handler passes

  // Control case: if this handler regressed to auto-kicking the escalated task the moment a
  // human's reply lands -- exactly the "prose arriving over a network route widens what the
  // fleet will act on unattended" failure this task's rationale forbids -- the SAME check must
  // catch it. It does: injecting the call the real body never makes flips the assertion.
  const mutated = body.replace(
    'appendThreadMessage(identity, "reply", input.text',
    'requestKick(input.taskId); appendThreadMessage(identity, "reply", input.text',
  );
  assert.notEqual(mutated, body, "the mutation must actually change the body, or this control proves nothing");
  assert.match(mutated, FORBIDDEN_POWER);
});
