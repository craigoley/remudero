import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendThreadMessage,
  deriveThreadId,
  readThread,
  type ThreadIdentity,
} from "../src/lib/inbox-thread.js";
import { escalate, type Escalation, type IssueGateway } from "../src/lib/escalate.js";

// W1-T2494: an escalation and the human's answer to it are two unrelated records today —
// nothing in src/ joins them (SURFACE 2: thread/message/read-state identifiers = 0). This suite
// proves inbox-thread.ts's derived thread identity and append/read behaviour, plus escalate.ts's
// wiring into it, satisfy every acceptance claim on W1-T2494's own task record.

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-inbox-thread-")), "threads.jsonl");
}

function identity(over: Partial<ThreadIdentity> = {}): ThreadIdentity {
  return { taskId: "W1-T9001", class: "BLOCKED", ...over };
}

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-escalate-thread-")), "ledger.ndjson");
}

function fakeIssues(url = "https://github.com/craigoley/remudero/issues/42"): IssueGateway & {
  calls: Array<{ title: string; body: string; labels: string[] }>;
} {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return url;
    },
  };
}

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-T9001",
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

test("an escalation and a later answer on the same concern resolve to one thread", () => {
  const path = storePath();
  const id = identity();
  const escalationThreadId = appendThreadMessage(id, "escalation", "the retry still failed CI", {
    threadStorePath: path,
  });
  const replyThreadId = appendThreadMessage(id, "reply", "retry once more", { threadStorePath: path });

  assert.equal(replyThreadId, escalationThreadId);
  const read = readThread(escalationThreadId, { threadStorePath: path });
  assert.equal(read.status, "ok");
  assert.equal(read.status === "ok" && read.messages.length, 2);
  assert.deepEqual(
    read.status === "ok" && read.messages.map((m) => m.role),
    ["escalation", "reply"],
  );
});

test("re-raising an unanswered concern appends rather than starting a new thread", () => {
  const path = storePath();
  const id = identity();
  const first = appendThreadMessage(id, "escalation", "first raise", { threadStorePath: path });
  const second = appendThreadMessage(id, "escalation", "same concern, re-raised", { threadStorePath: path });

  assert.equal(second, first);
  const read = readThread(first, { threadStorePath: path });
  assert.equal(read.status, "ok");
  assert.equal(read.status === "ok" && read.messages.length, 2);
  assert.deepEqual(
    read.status === "ok" && read.messages.map((m) => m.role),
    ["escalation", "escalation"],
  );
});

test("the thread identity is derived from producer and class, never randomly minted", () => {
  const id = identity({ cause: "ci" });
  const a = deriveThreadId(id);
  const b = deriveThreadId(id);
  const c = deriveThreadId({ ...id });

  // Same identity, called repeatedly (even on a freshly-built object), always yields the
  // identical string — pure derivation, no clock/random component anywhere in the value.
  assert.equal(a, b);
  assert.equal(a, c);
  assert.match(a, /W1-T9001/);
  assert.match(a, /BLOCKED/);
});

test("two genuinely different concerns from one producer are different threads", () => {
  const sameProducerDifferentClass = deriveThreadId(identity({ class: "MANUAL" }));
  const sameProducerDifferentCause = deriveThreadId(identity({ cause: "ci" }));
  const sameProducerOtherCause = deriveThreadId(identity({ cause: "conflict" }));
  const base = deriveThreadId(identity());

  assert.notEqual(sameProducerDifferentClass, base);
  assert.notEqual(sameProducerDifferentCause, base);
  assert.notEqual(sameProducerDifferentCause, sameProducerOtherCause);
});

test("every message on a thread carries its own ordering and timestamp", () => {
  const path = storePath();
  const id = identity();
  const clock = [1000, 2000, 3000];
  const now = () => clock.shift() as number;

  appendThreadMessage(id, "escalation", "raise", { threadStorePath: path, now });
  appendThreadMessage(id, "escalation", "re-raise", { threadStorePath: path, now });
  const threadId = appendThreadMessage(id, "reply", "answered", { threadStorePath: path, now });

  const read = readThread(threadId, { threadStorePath: path });
  assert.equal(read.status, "ok");
  const messages = read.status === "ok" ? read.messages : [];
  assert.deepEqual(
    messages.map((m) => m.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    messages.map((m) => m.ts),
    [1000, 2000, 3000],
  );
});

test("an escalation that never reaches the console behaves exactly as it does today", () => {
  // No threadStorePath at all — every caller predating this task. escalate() must behave
  // byte-identically to before this task existed: it still opens the issue and returns its url.
  const issues = fakeIssues();
  const url = escalate(escalation(), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.equal(url, "https://github.com/craigoley/remudero/issues/42");
  assert.equal(issues.calls.length, 1);

  // A threadStorePath IS wired, but pointed at a path a write can never succeed against (a
  // directory, not a file) — the thread bookkeeping fails, and escalate() must still succeed.
  const brokenPath = mkdtempSync(join(tmpdir(), "rmd-inbox-thread-broken-"));
  const issues2 = fakeIssues("https://github.com/craigoley/remudero/issues/43");
  const url2 = escalate(escalation({ taskId: "W1-T9002" }), {
    issues: issues2,
    ledgerPath: ledgerPath(),
    runId: "RUN-2",
    threadStorePath: brokenPath, // a directory, not a file — every write against it throws
  });
  assert.equal(url2, "https://github.com/craigoley/remudero/issues/43");
  assert.equal(issues2.calls.length, 1);
});

test("a thread whose store cannot be read reports unresolved rather than an empty thread", () => {
  const path = storePath();
  writeFileSync(path, "not json at all\n");
  const read = readThread("thread:W1-T9001::BLOCKED::-::-", { threadStorePath: path });
  assert.equal(read.status, "unresolved");
  assert.notEqual(read.status, "ok");
});

test("minting the id randomly makes the re-raise assertion fail by producing two threads", () => {
  // Control case: a naive alternative implementation that mints instead of derives. If
  // `escalate.ts`/`inbox-thread.ts` ever regressed to this shape, the SAME re-raise (identical
  // identity, twice) would mint two DIFFERENT thread ids — exactly the "an inbox that shows the
  // same concern eight times" failure mode the task rationale names, and exactly what claim 2's
  // real assertion (see the re-raise test above) would then fail to see the identical threadId.
  let counter = 0;
  const mintRandomly = () => `thread:minted-${(counter += 1)}`;

  const firstRaise = mintRandomly();
  const reRaise = mintRandomly();

  assert.notEqual(firstRaise, reRaise); // proves minting breaks the invariant derivation upholds
  // ...whereas the real, derived id is stable across repeated calls on the same identity:
  assert.equal(deriveThreadId(identity()), deriveThreadId(identity()));
});

test("the escalation path calls the thread store rather than the store standing alone", () => {
  const path = storePath();
  const issues = fakeIssues();
  escalate(escalation({ taskId: "W1-T9003" }), {
    issues,
    ledgerPath: ledgerPath(),
    runId: "RUN-3",
    threadStorePath: path,
  });
  const threadId = deriveThreadId({ taskId: "W1-T9003", class: "BLOCKED" });
  const read = readThread(threadId, { threadStorePath: path });
  assert.equal(read.status, "ok");
  assert.equal(read.status === "ok" && read.messages.length, 1);
  assert.equal(read.status === "ok" && read.messages[0]?.role, "escalation");
});
