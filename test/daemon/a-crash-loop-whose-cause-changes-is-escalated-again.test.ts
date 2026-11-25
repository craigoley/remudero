// W1-T14733 — a crash loop's incident names what it stops on, and a new cause is a new incident.
//
// 2026-11-24: the remudero-ops daemon crash-looped for about 23 hours. It stopped first on one dangling cross-repo
// depends_on, then, with no clean exit between, on another. The learned sentinel saw every exit but folded both causes
// into one incident whose title named neither, posting about five comments per boot, and nobody noticed for 13.5 hours.
// These tests replay that shape through the real sentinel and the real ledger.

import assert from "node:assert/strict";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { classifyEndedDaemonProcesses } from "#src/lib/daemon.js";
import {
  CRASHLOOP_STATUS_MARKER,
  GITHUB_ISSUE_TITLE_LIMIT,
  LEARNED_CRASHLOOP_SUMMARY,
  learnedCrashLoopSummary,
  runDaemonCrashSentinel,
  writeCrashLoopStatus,
  type CrashSentinelCtx,
} from "#src/lib/escalation-catalogue.js";
import type { IssueComment, IssueGateway } from "#src/lib/escalate.js";
import { systemClock } from "#src/lib/clock.js";
import { drainEscalationSpool, escalationSpoolDir } from "#src/lib/host-escalation-spool.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const MIN = 60_000;
const FIRST_CAUSE = "W1-T14555: task W1-T13392: depends_on unknown task 'W1-T13902'";
const SECOND_CAUSE = "W1-T14555: task W1-T10052: depends_on unknown task 'W1-T9710'";
const iso = (ms: number): string => new Date(ms).toISOString();
const START = Date.parse("2026-11-23T12:00:00.000Z");

/** A gateway that can list and edit comments, as the live one can. `edits` and `posts` count each kind of write. */
function gateway(opts: { editable?: boolean; failPost?: boolean; failList?: boolean } = {}) {
  const created: Array<{ title: string; body: string }> = [];
  const comments: IssueComment[] = [];
  const posts: Array<{ url: string; body: string }> = [];
  const edits: Array<{ id: number; body: string }> = [];
  const closed: Array<{ url: string; comment: string }> = [];
  const issues: IssueGateway = {
    create(title, body) { created.push({ title, body }); return `https://github.com/o/r/issues/${created.length}`; },
    comment(url, body) {
      if (opts.failPost) throw new Error("HTTP 502");
      posts.push({ url, body });
      comments.push({ id: comments.length + 1, body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    },
    closeWithComment(url, comment) { closed.push({ url, comment }); },
    ...(opts.editable === false ? {} : {
      listCommentsSince: () => { if (opts.failList) throw new Error("HTTP 500 on list"); return [...comments]; },
      editComment: (id: number, body: string) => { edits.push({ id, body }); comments[id - 1] = { ...comments[id - 1]!, body }; },
    }),
  };
  return { issues, created, posts, edits, closed };
}

function lines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}
const row = (path: string, r: Record<string, unknown>) => appendFileSync(path, JSON.stringify(r) + "\n");

/** One process: its boot and ticks, then a clean stale summary or an error summary naming `cause`. */
function process_(path: string, runId: string, at: number, lifetimeMs: number, cause?: string): void {
  row(path, { ts: iso(at), run_id: runId, task_id: "DAEMON", step: "daemon.boot" });
  for (let t = MIN; t <= lifetimeMs; t += MIN) row(path, { ts: iso(at + t), run_id: runId, task_id: "DAEMON", step: "daemon.tick" });
  const end = { ts: iso(at + lifetimeMs), run_id: runId, task_id: "DAEMON" };
  if (cause === undefined) { row(path, { ...end, step: "daemon.summary", stopReason: "stale" }); return; }
  row(path, { ...end, step: "daemon.summary", stopReason: "error", stopDetail: cause });
  row(path, { ...end, step: "daemon.process.exit", exit_code: 1, clean_exit: false });
}

/** A boot: the sentinel judges the tail as the daemon's pre-boot snapshot would; its own rows take the boot's time. */
function boot(path: string, runId: string, at: number, issues: IssueGateway) {
  const ctx: CrashSentinelCtx = { owner: "o", repo: "r", ledgerPath: path, runId, issues };
  const before = lines(path);
  const result = runDaemonCrashSentinel(before, iso(at), ctx);
  const after = lines(path);
  for (const r of after.slice(before.length)) r.ts = iso(at);
  writeFileSync(path, after.map((r) => JSON.stringify(r) + "\n").join(""));
  return result;
}

/** Six clean processes of 50-100 minutes teach the learned lifetime; returns when the next process boots. */
function healthy(path: string, issues: IssueGateway): number {
  let at = START;
  [50, 60, 70, 80, 90, 100].forEach((m, i) => { boot(path, `DAEMON-h${i}`, at, issues); process_(path, `DAEMON-h${i}`, at, m * MIN); at += m * MIN + 30_000; });
  return at;
}

/** `count` one-minute crash processes stopping on `cause`, each booted (and judged) in turn. */
function loop(path: string, prefix: string, from: number, count: number, cause: string, issues: IssueGateway): number {
  let at = from;
  for (let i = 0; i < count; i++) { boot(path, `${prefix}${i}`, at, issues); process_(path, `${prefix}${i}`, at, MIN, cause); at += 2 * MIN; }
  return at;
}

test("W1-T14733 criterion 1: an open incident whose newest exit stops on a different cause is closed naming it, and the new cause is raised as its own incident", (t) => {
  const path = writeLedger([], { scope: t }).path;
  const g = gateway();
  let at = loop(path, "DAEMON-a", healthy(path, g.issues), 3, FIRST_CAUSE, g.issues);
  assert.equal(g.created.length, 1, "the first cause raised one incident");
  at = loop(path, "DAEMON-b", at, 1, SECOND_CAUSE, g.issues);
  const verdict = boot(path, "DAEMON-after", at, g.issues);
  assert.equal(verdict.summary?.incident, "reescalated");
  assert.equal(g.created.length, 2, "THE CLAIM: the new cause is a new incident");
  assert.ok(g.created[1]!.title.includes(SECOND_CAUSE));
  assert.equal(g.closed.length + lines(path).filter((r) => r.step === "daemon.crashloop.cleared").length > 0, true, "the old incident is cleared");
  const cleared = lines(path).find((r) => r.step === "daemon.crashloop.cleared")!;
  assert.match(String(cleared.reason), /the stop cause changed to "W1-T14555: task W1-T10052/);
  assert.equal(cleared.run_first, "DAEMON-a0");
  const escalated = lines(path).filter((r) => r.step === "daemon.crashloop.escalated");
  assert.deepEqual(escalated.map((r) => [r.run_first, r.cause]), [["DAEMON-a0", FIRST_CAUSE], ["DAEMON-b0", SECOND_CAUSE]]);
  assert.equal(verdict.incident?.runFirst, "DAEMON-b0");

  // The same cause again is the same incident: no third issue.
  loop(path, "DAEMON-c", at, 2, SECOND_CAUSE, g.issues);
  assert.equal(g.created.length, 2);
});

test("W1-T14733 criterion 2: the incident's title names the cause its exits share, and each abnormal-exit row records its process's stop_detail", (t) => {
  const path = writeLedger([], { scope: t }).path;
  const g = gateway();
  loop(path, "DAEMON-a", healthy(path, g.issues), 3, FIRST_CAUSE, g.issues);
  assert.equal(g.created[0]!.title, `[BLOCKED] DAEMON: ${LEARNED_CRASHLOOP_SUMMARY} — ${FIRST_CAUSE}`, "THE CLAIM");
  assert.match(g.created[0]!.body, /Stopped on: W1-T14555: task W1-T13392/);
  const abnormal = lines(path).filter((r) => r.step === "daemon.crash.abnormal_exit");
  assert.deepEqual(abnormal.map((r) => r.stop_detail), [FIRST_CAUSE, FIRST_CAUSE]);
  assert.equal(classifyEndedDaemonProcesses(lines(path), iso(Date.now())).length, 1, "only the newest process is still unjudged");

  assert.equal(learnedCrashLoopSummary(null), LEARNED_CRASHLOOP_SUMMARY, "an exit that names no cause keeps the causeless title");
  const long = learnedCrashLoopSummary(`x${"y".repeat(400)}\n  z`);
  assert.equal(`[BLOCKED] DAEMON: ${long}`.length, GITHUB_ISSUE_TITLE_LIMIT, "a long cause is cut only at GitHub's own title limit");
  assert.ok(long.endsWith("…"));
  assert.equal(learnedCrashLoopSummary("a\n  b"), `${LEARNED_CRASHLOOP_SUMMARY} — a b`, "the cause is one line");
});

test("W1-T14733 criterion 3: each further exit with the same cause edits the incident's one status comment", (t) => {
  const path = writeLedger([], { scope: t }).path;
  const g = gateway();
  const at = loop(path, "DAEMON-a", healthy(path, g.issues), 3, FIRST_CAUSE, g.issues);
  loop(path, "DAEMON-b", at, 4, FIRST_CAUSE, g.issues);
  assert.equal(g.posts.length, 1, "THE CLAIM: one status comment is posted");
  assert.ok(g.edits.length >= 3, "and each later boot edits it in place");
  assert.ok(g.posts[0]!.body.includes(CRASHLOOP_STATUS_MARKER("DAEMON-a0")));
  assert.match(g.edits.at(-1)!.body, /newest DAEMON-b2; stopped on: W1-T14555: task W1-T13392/);
  const updated = lines(path).filter((r) => r.step === "daemon.crashloop.updated");
  assert.deepEqual([...new Set(updated.map((r) => r.status_comment))].sort(), ["edited", "posted"]);

  await_fallbacks: {
    // A gateway that cannot edit posts; a failed list posts and names the error; a refused post is spooled.
    const open = { runFirst: "DAEMON-x", issueUrl: "https://github.com/o/r/issues/9" };
    const ctx: CrashSentinelCtx = { owner: "o", repo: "r", ledgerPath: path, runId: "DAEMON-x" };
    assert.equal(writeCrashLoopStatus(gateway({ editable: false }).issues, open, "b", ctx).outcome, "posted");
    const listFailed = writeCrashLoopStatus(gateway({ failList: true }).issues, open, "b", ctx);
    assert.deepEqual([listFailed.outcome, listFailed.error], ["posted", "status edit: HTTP 500 on list"]);
    const spooled = writeCrashLoopStatus(gateway({ failPost: true, editable: false }).issues, open, "b", ctx);
    assert.deepEqual([spooled.outcome, spooled.queued, spooled.delivered, spooled.error], ["spooled", true, false, "status post: HTTP 502"]);
    const bare = writeCrashLoopStatus({ create: () => "u" }, open, "b", ctx);
    assert.equal(bare.outcome, "spooled", "a gateway with no comment port spools");
    const unwritten = writeCrashLoopStatus({ create: () => "u" }, open, "b", { ...ctx, ledgerPath: "/dev/null/ledger.ndjson" });
    assert.equal(unwritten.outcome, "unwritten");
    assert.match(unwritten.error!, /^status spool: /);
    break await_fallbacks;
  }
});

test("W1-T14733 criterion 4: a cause change with no clean exit between re-escalates at the new cause's first exit, and a boot with many undelivered exits makes one status write", async (t) => {
  const path = writeLedger([], { scope: t }).path;
  const stateDir = dirname(path);
  const spooledStatus = () => readdirSync(escalationSpoolDir(stateDir)).filter((n) => n.startsWith("comment-crashloop-status-") && n.endsWith(".json"));
  const g = gateway();
  let at = loop(path, "DAEMON-a", healthy(path, g.issues), 3, FIRST_CAUSE, g.issues);
  // Twenty boots whose status writes were refused: each refusal REPLACES the incident's one spooled status.
  const REFUSED = 20;
  const refusing = gateway({ failPost: true, editable: false });
  at = loop(path, "DAEMON-p", at, REFUSED, FIRST_CAUSE, { ...refusing.issues, create: g.issues.create });
  const undelivered = lines(path).filter((r) => r.step === "daemon.crashloop.updated" && r.delivered === false);
  assert.equal(undelivered.length, REFUSED, "every refused boot left its exit undelivered");
  assert.equal(spooledStatus().length, 1, "THE CLAIM: twenty undelivered exits hold ONE spooled status, not twenty comments");
  const spooledBody = String(JSON.parse(readFileSync(join(escalationSpoolDir(stateDir), spooledStatus()[0]!), "utf8")).body);
  assert.match(spooledBody, /newest DAEMON-p18;/, "the spooled status is the newest refusal's");

  // The next boot with a working gateway: one status write, and the stale spooled copy is withdrawn, not posted.
  const before = g.posts.length + g.edits.length;
  boot(path, "DAEMON-q", at, g.issues);
  assert.equal(g.posts.length + g.edits.length - before, 1, "THE CLAIM: one status write for the incident");
  assert.equal(g.posts.length, 1, "the first status write is a post");
  assert.match(String(g.posts.at(-1)?.body), /23 short exits in the trailing run, first DAEMON-a0, newest DAEMON-p19;/, "naming the newest exit");
  assert.deepEqual(spooledStatus(), [], "the direct write withdrew the spooled status");
  const drained: string[] = [];
  const poster = { escalate: async () => "", close: async () => {}, comment: async (_u: string, b: string) => { drained.push(b); }, clock: systemClock };
  await drainEscalationSpool(stateDir, poster);
  assert.deepEqual(drained, [], "so the drain posts nothing more");

  // Twenty refusals whose spool write ALSO fails (a file stands where the spool directory goes): each exit stays
  // pending with queued false, and the next working boot folds them all into one write that names the newest exit.
  {
    const p2 = writeLedger([], { scope: t }).path;
    const g2 = gateway();
    let at2 = loop(p2, "DAEMON-a", healthy(p2, g2.issues), 3, FIRST_CAUSE, g2.issues);
    writeFileSync(escalationSpoolDir(dirname(p2)), "not a directory");
    at2 = loop(p2, "DAEMON-w", at2, REFUSED, FIRST_CAUSE, { ...refusing.issues, create: g2.issues.create });
    const latest = new Map<unknown, Record<string, unknown>>();
    for (const r of lines(p2)) if (r.step === "daemon.crashloop.updated") latest.set(r.prior_run_id, r);
    assert.equal([...latest.values()].filter((r) => r.delivered === false && r.queued === false).length, REFUSED, "every exit is pending and unspooled");
    boot(p2, "DAEMON-w-after", at2, g2.issues);
    assert.equal(g2.posts.length + g2.edits.length, 1, "THE CLAIM: one status write folds twenty pending exits");
    assert.match(g2.posts[0]!.body, /23 short exits in the trailing run, first DAEMON-a0, newest DAEMON-w19;/, "naming the newest exit, not the oldest pending one");
    assert.match(g2.posts[0]!.body, /- DAEMON-w19: booted/, "and quoting the newest exit's evidence");
    const folded = lines(p2).filter((r) => r.step === "daemon.crashloop.updated" && r.run_id === "DAEMON-w-after");
    assert.equal(folded.length, REFUSED + 1, "every pending exit and this boot's newest one are delivered by that write");
    assert.ok(folded.every((r) => r.delivered === true));
  }

  // Twenty refusals with no direct write after them: the drain posts the one spooled status, once.
  at = loop(path, "DAEMON-r", at, REFUSED, FIRST_CAUSE, { ...refusing.issues, create: g.issues.create });
  await drainEscalationSpool(stateDir, poster);
  assert.equal(drained.length, 1, "THE CLAIM: the drain makes one status write for twenty undelivered exits");
  assert.match(drained[0]!, /newest DAEMON-r18;/);
  at = loop(path, "DAEMON-u", at, 1, FIRST_CAUSE, g.issues);

  // The cause switches with no clean exit between: the run continues, the incident does not.
  const created = g.created.length;
  boot(path, "DAEMON-s0", at, g.issues);
  process_(path, "DAEMON-s0", at, MIN, SECOND_CAUSE);
  assert.equal(g.created.length, created, "no new incident before the new cause has exited");
  const verdict = boot(path, "DAEMON-s1", at + 2 * MIN, g.issues);
  assert.equal(verdict.summary?.incident, "reescalated", "re-escalated at the boot that judges the new cause's first exit");
  assert.equal(g.created.length, created + 1);
  const escalated = lines(path).filter((r) => r.step === "daemon.crashloop.escalated");
  assert.deepEqual(escalated.map((r) => [r.run_first, r.run_newest, r.cause]),
    [["DAEMON-a0", "DAEMON-a1", FIRST_CAUSE], ["DAEMON-s0", "DAEMON-s0", SECOND_CAUSE]], "the new incident starts at the new cause's first exit");
  assert.equal(escalated[1]!.run_length, 3 + REFUSED + REFUSED + 1 + 1, "the run itself is unbroken: 3 + 20 + 20 + 1 exits on the first cause, then the second cause's first");
});

test("W1-T14733 criterion 5: invariant:a-healthy-instance-is-quiet — clean processes at their learned lifetime open, re-escalate and comment nothing", (t) => {
  const path = writeLedger([], { scope: t }).path;
  const g = gateway();
  let at = healthy(path, g.issues);
  for (let i = 0; i < 6; i++) { boot(path, `DAEMON-k${i}`, at, g.issues); process_(path, `DAEMON-k${i}`, at, 75 * MIN); at += 76 * MIN; }
  const verdict = boot(path, "DAEMON-end", at, g.issues);
  assert.equal(verdict.summary?.incident, "none");
  assert.deepEqual([g.created.length, g.posts.length, g.edits.length, g.closed.length], [0, 0, 0, 0]);
  assert.equal(lines(path).some((r) => String(r.step).startsWith("daemon.crashloop.")), false);
});
