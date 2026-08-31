// test/the-console-reads-like-a-mailbox.test.ts — W1-T2497.
//
// THE DEFECT: the console (serve.ts) already fetches escalation rows (GET /v1/status) and their
// answers (GET /v1/feedback, POST /v1/escalation/reply — W1-T2496) but never joins them into
// anything an operator would recognise as a conversation: `needsMeTaskRowHtml` renders one flat
// row per open escalation and nothing groups a reply underneath the concern it answers, tracks
// what has been read, or lets a resolved concern drop out of view without erasing it.
//
// THE FIX is a new client-side rendering layer, MAILBOX (serve.ts), built the SAME two-tier way
// W1-T2489 drew the plan→task→PR graph: an inner function (`mailboxThreadsHtml`) that draws an
// ALREADY-BUILT thread list and renders NOTHING it cannot read, wrapped by `mailboxHtml`, which
// degrades to the console's own pre-existing NEEDS ME rows whenever the inner draw comes back
// empty. `buildMailboxThreads` groups the two already-fetched feeds (GET /v1/status's escalation
// rows, GET /v1/feedback's `origin: "ui"` replies, joined by the `thread_id` POST
// /v1/escalation/reply already derives) into ordered conversations — NO NEW ROUTE (this task's
// own NOT-IN-SCOPE line), no thread-store file read from the browser at all.
//
// EXTRACTED VERBATIM from the REAL served script, never a reimplementation — the SAME `new
// Function` extraction discipline test/the-console-draws-the-graph-it-computes.test.ts (W1-T2489)
// already established (learnings#probe-must-exercise-the-real-consuming-client: a hand-copied
// stand-in would prove nothing about what the shell actually ships).
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderShellHtml } from "../src/lib/serve.js";

const HTML = renderShellHtml();

// ── extraction (verbatim from the shipped shell) ────────────────────────────────────────────

function clientFn(name: string): string {
  const re = new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}");
  const src = HTML.match(re)?.[0];
  assert.ok(src, `the shell's inline script must define ${name}()`);
  return src as string;
}

function clientConst(name: string): string {
  const re = new RegExp("const " + name + " = [^;]+;");
  const src = HTML.match(re)?.[0];
  assert.ok(src, `the shell's inline script must define ${name}`);
  return src as string;
}

interface Mailbox {
  buildMailboxThreads: (tasks: unknown, replies: unknown) => unknown[] | null;
  mailboxVisibleThreads: (threads: unknown[], resolvedIds: string[], includeResolved: boolean) => unknown[];
  mailboxUnreadCount: (threads: unknown[], readIds: string[]) => number;
  mailboxMarkRead: (readIds: string[], threadId: string) => string[];
  mailboxMarkResolved: (resolvedIds: string[], threadId: string) => string[];
  mailboxThreadsHtml: (threads: unknown, readIds?: string[]) => string;
  mailboxHtml: (
    tasks: unknown,
    replies: unknown,
    readIds: string[],
    resolvedIds: string[],
    includeResolved: boolean,
    existingRowsHtml: string,
  ) => string;
}

/** A fresh sandbox around the REAL mailbox functions + their real collaborators (escapeHtml,
 *  writeGateAttrs), extracted verbatim — mirrors test/the-console-draws-the-graph-it-computes
 *  .test.ts's journeyHarness for the same reason: a sandbox holding only mailboxHtml throws
 *  "escapeHtml is not defined" before any assertion below can run. `writeGateAttrs` reads the
 *  free variable `hasWriteScope` (module scope in the real shell) rather than a parameter — the
 *  harness declares it as a plain `var` so the extracted source runs unmodified. */
function mailboxHarness(): Mailbox {
  const factory = new Function(
    [
      "var hasWriteScope = true;",
      clientFn("escapeHtml"),
      clientFn("writeGateAttrs"),
      clientConst("MAILBOX_SENDER"),
      clientFn("mailboxEscalationClass"),
      clientFn("mailboxThreadKey"),
      clientFn("buildMailboxThreads"),
      clientFn("mailboxVisibleThreads"),
      clientFn("mailboxUnreadCount"),
      clientFn("mailboxMarkRead"),
      clientFn("mailboxMarkResolved"),
      clientFn("mailboxThreadsHtml"),
      clientFn("mailboxHtml"),
      "return { buildMailboxThreads: buildMailboxThreads, mailboxVisibleThreads: mailboxVisibleThreads, " +
        "mailboxUnreadCount: mailboxUnreadCount, mailboxMarkRead: mailboxMarkRead, " +
        "mailboxMarkResolved: mailboxMarkResolved, mailboxThreadsHtml: mailboxThreadsHtml, mailboxHtml: mailboxHtml };",
    ].join("\n"),
  ) as () => Mailbox;
  return factory();
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

function taskRow(over: Record<string, unknown> = {}) {
  return {
    taskId: "W1-T9001",
    needsHuman: true,
    escalationTitle: "[BLOCKED] W1-T9001: the frobnicator needs a widget",
    escalationIssueUrl: "https://github.com/o/r/issues/9",
    escalationOpenedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function replyEntry(over: Record<string, unknown> = {}) {
  return {
    id: "FB1",
    ts: "2026-01-01T01:00:00.000Z",
    raw: "retry once more, the flake looks like ci noise",
    thread_id: "thread:W1-T9001::BLOCKED::-::-",
    ...over,
  };
}

// ── (1) threads render ordered by their latest message ─────────────────────────────────────────

test("W1-T2497: buildMailboxThreads orders threads by their OWN latest message, not by escalation-open time or fetch order", () => {
  const { buildMailboxThreads } = mailboxHarness();
  const tasks = [
    taskRow({ taskId: "W1-T9001", escalationTitle: "[BLOCKED] W1-T9001: old concern, opened first", escalationOpenedAt: "2026-01-01T00:00:00.000Z" }),
    taskRow({ taskId: "W1-T9002", escalationTitle: "[BLOCKED] W1-T9002: newer concern, opened second", escalationOpenedAt: "2026-01-02T00:00:00.000Z" }),
  ];
  // A reply just landed on the FIRST (older) escalation, well after the second one opened —
  // its thread must now sort above the second's, because ITS latest message is the newest.
  const replies = [replyEntry({ thread_id: "thread:W1-T9001::BLOCKED::-::-", ts: "2026-01-03T00:00:00.000Z" })];
  const threads = buildMailboxThreads(tasks, replies) as Array<{ taskId: string }>;
  assert.equal(threads.length, 2);
  assert.equal(threads[0].taskId, "W1-T9001", "the thread with the freshest reply sorts first, like an email inbox");
  assert.equal(threads[1].taskId, "W1-T9002");
});

// ── (2) the unread indicator counts threads rather than events ─────────────────────────────────

test("W1-T2497: mailboxUnreadCount counts THREADS, never messages -- a thread with three unread replies is still one unread thread", () => {
  const { buildMailboxThreads, mailboxUnreadCount } = mailboxHarness();
  const tasks = [taskRow()];
  const replies = [
    replyEntry({ id: "FB1", ts: "2026-01-01T01:00:00.000Z" }),
    replyEntry({ id: "FB2", ts: "2026-01-01T02:00:00.000Z" }),
    replyEntry({ id: "FB3", ts: "2026-01-01T03:00:00.000Z" }),
  ];
  const threads = buildMailboxThreads(tasks, replies) as Array<{ messages: unknown[] }>;
  assert.equal(threads[0].messages.length, 4, "one escalation message + three replies");
  assert.equal(mailboxUnreadCount(threads, []), 1, "four EVENTS on one THREAD must still count as one unread thread");
  // A second, distinct thread makes the count two, not five.
  const twoThreads = buildMailboxThreads(
    [taskRow(), taskRow({ taskId: "W1-T9002", escalationTitle: "[MANUAL] W1-T9002: a second concern" })],
    replies,
  ) as unknown[];
  assert.equal(mailboxUnreadCount(twoThreads, []), 2);
});

// ── (3) a thread shows every message in order with its sender's display name ───────────────────

test("W1-T2497: mailboxThreadsHtml draws every message on a thread, in order, each carrying its sender's display name", () => {
  const { buildMailboxThreads, mailboxThreadsHtml } = mailboxHarness();
  const tasks = [taskRow()];
  const replies = [
    replyEntry({ id: "FB1", ts: "2026-01-01T02:00:00.000Z", raw: "second reply, sent later" }),
    replyEntry({ id: "FB2", ts: "2026-01-01T01:00:00.000Z", raw: "first reply, sent earlier" }),
  ];
  const threads = buildMailboxThreads(tasks, replies);
  const html = mailboxThreadsHtml(threads, []);
  assert.match(html, /the frobnicator needs a widget/, "the original escalation message renders");
  assert.match(html, /first reply, sent earlier/);
  assert.match(html, /second reply, sent later/);
  assert.match(html, />Fleet</, "the escalation's own message is attributed to its sender's display name");
  const youCount = (html.match(/>You</g) || []).length;
  assert.equal(youCount, 2, "both replies are attributed to the operator's own display name");
  // ORDER: earlier reply's text must precede the later reply's text in the rendered markup.
  const earlierAt = html.indexOf("first reply, sent earlier");
  const laterAt = html.indexOf("second reply, sent later");
  assert.ok(earlierAt >= 0 && laterAt > earlierAt, "messages render chronologically, not fetch/insertion order");
});

// ── (4) opening a thread marks it read and the indicator drops by one ──────────────────────────

test("W1-T2497: mailboxMarkRead + mailboxUnreadCount -- opening a thread marks it read and the indicator drops by exactly one", () => {
  const { buildMailboxThreads, mailboxUnreadCount, mailboxMarkRead } = mailboxHarness();
  const tasks = [
    taskRow({ taskId: "W1-T9001", escalationTitle: "[BLOCKED] W1-T9001: concern one" }),
    taskRow({ taskId: "W1-T9002", escalationTitle: "[MANUAL] W1-T9002: concern two" }),
  ];
  const threads = buildMailboxThreads(tasks, []) as Array<{ threadId: string }>;
  let readIds: string[] = [];
  assert.equal(mailboxUnreadCount(threads, readIds), 2);
  readIds = mailboxMarkRead(readIds, threads[0].threadId);
  assert.equal(mailboxUnreadCount(threads, readIds), 1, "opening one thread drops the indicator by exactly one");
  assert.equal(mailboxUnreadCount(threads, mailboxMarkRead(readIds, threads[0].threadId)), 1, "opening the SAME thread again is idempotent");
});

// ── (5) a resolved thread is hidden from the default view and is not deleted ───────────────────

test("W1-T2497: mailboxVisibleThreads hides a resolved thread from the default view -- but includeResolved proves it was never deleted", () => {
  const { buildMailboxThreads, mailboxVisibleThreads, mailboxMarkResolved } = mailboxHarness();
  const tasks = [
    taskRow({ taskId: "W1-T9001", escalationTitle: "[BLOCKED] W1-T9001: concern one" }),
    taskRow({ taskId: "W1-T9002", escalationTitle: "[MANUAL] W1-T9002: concern two" }),
  ];
  const threads = buildMailboxThreads(tasks, []) as Array<{ threadId: string; taskId: string }>;
  const resolvedIds = mailboxMarkResolved([], threads[0].threadId);
  const defaultView = mailboxVisibleThreads(threads, resolvedIds, false) as Array<{ taskId: string }>;
  assert.equal(defaultView.length, 1, "the resolved thread is hidden from the default view");
  assert.equal(defaultView[0].taskId, "W1-T9002");
  const withResolved = mailboxVisibleThreads(threads, resolvedIds, true) as Array<{ taskId: string }>;
  assert.equal(withResolved.length, 2, "asking to include resolved threads still finds it -- nothing was deleted");
  assert.ok(withResolved.some((t) => t.taskId === "W1-T9001"));
});

// ── (6) an unreachable thread store degrades to the existing rows rather than a blank panel ────

test("W1-T2497: mailboxHtml degrades to the existing NEEDS ME rows, verbatim, when the feeds it reads come back a shape it cannot use", () => {
  const { mailboxHtml } = mailboxHarness();
  const existingRowsHtml = '<li class="row needs-human"><span class="task-id">W1-T9001</span></li>';
  const malformedInputs: Array<[unknown, unknown]> = [
    ["not-an-array", []],
    [null, []],
    [undefined, "not-an-array-either"],
  ];
  for (const [tasks, replies] of malformedInputs) {
    const html = mailboxHtml(tasks, replies, [], [], false, existingRowsHtml);
    assert.equal(html, existingRowsHtml, `unreachable input ${JSON.stringify(tasks)} must degrade to the existing rows verbatim`);
  }
  // A genuinely healthy, empty inbox (well-formed empty arrays) is NOT "unreachable" -- it must
  // render its own honest empty state, not silently borrow the (also-empty) existing rows.
  const healthyEmpty = mailboxHtml([], [], [], [], false, existingRowsHtml);
  assert.notEqual(healthyEmpty, existingRowsHtml);
  assert.match(healthyEmpty, /no open threads/);
});

// ── (7) the rendered shell's client script still parses and loads nothing over the network ─────

test("W1-T2497: the rendered shell's entire inline <script> still parses -- the backtick/${} hazard this file's own rationale names (client JS lives inside a backtick template literal; a stray backtick or unescaped ${} terminates it with a parse error naming no cause)", () => {
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(HTML)?.[1];
  assert.ok(script, "the shell must still emit its inline <script>");
  assert.doesNotThrow(() => new Function(script as string), "the full client script must remain syntactically valid JS");
});

test("W1-T2497: the mailbox loads no script or stylesheet over the network -- inline in the SAME markup/stylesheet the shell already ships", () => {
  assert.doesNotMatch(HTML, /<script\s[^>]*\bsrc=/i, "no externally-loaded script");
  assert.doesNotMatch(HTML, /<link[^>]*\brel=["']?stylesheet["']?[^>]*\bhref=/i, "no externally-loaded stylesheet");
  assert.match(HTML, /id="mailbox"/, "the mailbox mount point ships in the shell");
});

// ── (8) removing the degradation path makes the unreachable-store case render nothing ──────────

test("W1-T2497: mailboxThreadsHtml called on its OWN (no mailboxHtml wrapper) renders NOTHING for an unreachable shape -- proving the existing-rows fallback in mailboxHtml, not mailboxThreadsHtml itself, is what keeps the panel non-blank", () => {
  const { buildMailboxThreads, mailboxThreadsHtml } = mailboxHarness();
  // The SAME malformed shapes claim 6 proved degrade correctly THROUGH the wrapper -- called
  // through the inner function alone (buildMailboxThreads feeding straight into
  // mailboxThreadsHtml, without mailboxHtml's own "|| existingRowsHtml" fallback line), they
  // must render literally nothing.
  assert.equal(mailboxThreadsHtml(buildMailboxThreads("not-an-array", [])), "");
  assert.equal(mailboxThreadsHtml(buildMailboxThreads(null, [])), "");
  assert.equal(mailboxThreadsHtml(null), "", "a non-array threads value alone, with no wrapper, draws nothing");
  assert.equal(mailboxThreadsHtml(undefined), "");
});

// ── grouping correctness: prefix match on (taskId, class), never event-level thread ids ────────

test("W1-T2497: buildMailboxThreads only attaches a reply to the escalation whose (taskId, class) it names -- a reply for a different task or class never bleeds into this thread", () => {
  const { buildMailboxThreads } = mailboxHarness();
  const tasks = [taskRow({ taskId: "W1-T9001", escalationTitle: "[BLOCKED] W1-T9001: concern one" })];
  const replies = [
    replyEntry({ id: "FB1", thread_id: "thread:W1-T9001::BLOCKED::-::-" }), // matches
    replyEntry({ id: "FB2", thread_id: "thread:W1-T9002::BLOCKED::-::-" }), // different task
    replyEntry({ id: "FB3", thread_id: "thread:W1-T9001::MANUAL::-::-" }), // different class
  ];
  const threads = buildMailboxThreads(tasks, replies) as Array<{ messages: Array<{ role: string }> }>;
  assert.equal(threads.length, 1);
  const replyMessages = threads[0].messages.filter((m) => m.role === "reply");
  assert.equal(replyMessages.length, 1, "only the matching (taskId, class) reply attaches to this thread");
});
