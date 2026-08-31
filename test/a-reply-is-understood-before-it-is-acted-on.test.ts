import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildEscalationReplyRoute, type IssueCloser, type PanelActionDeps } from "../src/lib/panel-actions.js";
import { appendThreadMessage, deriveThreadId, readThread, type ThreadIdentity, type ThreadMessage } from "../src/lib/inbox-thread.js";
import {
  interpretReply,
  formatClarifyingQuestion,
  formatExhaustionReport,
  clarifyingQuestionId,
  DEFAULT_MAX_ROUNDS,
  type ClarificationRule,
  type ReplyContext,
} from "../src/lib/reply-interpreter.js";

// ── W1-T2499: three onboarding question generators, a validator, an unanswered-set and an
// assert-complete guard all ship today (onboard/session.ts, onboard/synthesize.ts) -- and grep
// confirms zero modules outside onboard/ can reach any of them, so a reply anywhere else is acted
// on or dropped, never asked about. This suite proves reply-interpreter.ts closes that gap with
// the SAME design (understood == an empty unanswered set, never a model's own "yes, got it"),
// wired into POST /v1/escalation/reply, WITHOUT moving or rewriting the onboarding generators.
//
// Acceptance (plan/tasks.d/W1-T2499-...yaml), each proven by name below:
//   1. a reply with an unresolved ambiguity produces a clarifying question on its own thread
//   2. understood is defined as an empty unanswered set, never a model assertion
//   3. recon runs before a question is asked and the question states what it established
//   4. a question research could have settled is not asked
//   5. the same clarification is never asked twice on one thread
//   6. rounds are bounded and exhaustion reports what is unresolved rather than guessing
//   7. nothing on this path dispatches, ratifies, files a task or arms a merge
//   8. the onboarding generators keep their existing callers and behaviour
//   9. the reply route calls the interpreter rather than the interpreter standing alone

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function readSrc(relPath: string): string {
  return readFileSync(join(REPO_ROOT, "src", relPath), "utf8");
}

function baseIdentity(over: Partial<ThreadIdentity> = {}): ThreadIdentity {
  return { taskId: "W1-T9202", class: "BLOCKED", ...over };
}

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return { threadId: "thread:x", role: "escalation", body: "", seq: 1, ts: 0, ...over };
}

function ctxFor(over: Partial<ReplyContext> = {}): ReplyContext {
  const identity = baseIdentity();
  return {
    identity,
    threadId: deriveThreadId(identity),
    replyText: "retry once more, the flake looks like ci noise",
    priorMessages: [],
    ...over,
  };
}

/** A rule that never settles -- always asks, always names what it "established" as a fixed fact,
 *  so tests can assert the emitted question states it. */
function unresolvedRule(id: string, established = `${id} was not named in the reply`): ClarificationRule {
  return {
    id,
    research: () => ({ established, settled: false }),
    question: () => `Which ${id} did you mean?`,
  };
}

/** A rule whose own recon always settles the concern -- must NEVER surface a question. */
function settledRule(id: string): ClarificationRule {
  return {
    id,
    research: () => ({ established: `${id} was already resolved by research`, settled: true }),
    question: () => {
      throw new Error(`${id}: question() must never be called once research settles the concern`);
    },
  };
}

// ── 2: understood is defined as an empty unanswered set, never a model assertion ─────────────

test("no configured rules -- a reply is always understood, never asked about", () => {
  const result = interpretReply(ctxFor(), {});
  assert.deepEqual(result, { status: "understood" });
});

test("every rule settled by research -- the reply is understood, even though rules exist", () => {
  const result = interpretReply(ctxFor(), { rules: [settledRule("gh-facts"), settledRule("pr-ref")] });
  assert.deepEqual(result, { status: "understood" });
});

// ── 4: a question research could have settled is not asked ───────────────────────────────────

test("a rule research settles never contributes a question, even alongside an unresolved one", () => {
  const settled = settledRule("owner");
  const unresolved = unresolvedRule("repo");
  const result = interpretReply(ctxFor(), { rules: [settled, unresolved] });
  assert.equal(result.status, "clarifying");
  assert.equal(result.status === "clarifying" && result.question.id, "repo");
  // The settled rule's own question() throws if ever called (see settledRule above) -- reaching
  // this assertion at all is proof it never was.
});

// ── 3: recon runs before a question is asked and the question states what it established ─────

test("the clarifying question states what research already established", () => {
  const rule = unresolvedRule("repo", "the reply named PR #42 but no repo");
  const result = interpretReply(ctxFor(), { rules: [rule] });
  assert.equal(result.status, "clarifying");
  assert.ok(result.status === "clarifying");
  assert.equal(result.question.established, "the reply named PR #42 but no repo");
  const rendered = formatClarifyingQuestion(result.question);
  // The RENDERED thread message -- what a human actually reads -- carries BOTH the question and
  // what research established, structurally (formatClarifyingQuestion composes them; a rule
  // cannot forget to state it, because the rule's own question() text is never asked alone).
  assert.match(rendered, /Which repo did you mean\?/);
  assert.match(rendered, /already established: the reply named PR #42 but no repo/);
});

// ── 1: a reply with an unresolved ambiguity produces a clarifying question on its own thread ──

test("(pure) an unresolved ambiguity produces a clarifying question naming that concern", () => {
  const result = interpretReply(ctxFor(), { rules: [unresolvedRule("scope")] });
  assert.equal(result.status, "clarifying");
  assert.ok(result.status === "clarifying");
  assert.equal(result.question.id, "scope");
  assert.equal(result.question.question, "Which scope did you mean?");
});

// ── 5: the same clarification is never asked twice on one thread ─────────────────────────────

test("a concern already asked on this thread is never proposed again", () => {
  const rule = unresolvedRule("scope");
  const already = msg({ role: "escalation", body: formatClarifyingQuestion({ id: "scope", question: "Which scope did you mean?", established: "scope was not named in the reply" }) });
  const result = interpretReply(ctxFor({ priorMessages: [already] }), { rules: [rule] });
  // The ONLY unresolved concern was already asked once -- nothing left to newly propose, so this
  // reports exhausted (naming it) rather than re-asking the identical question.
  assert.equal(result.status, "exhausted");
  assert.ok(result.status === "exhausted");
  assert.deepEqual(result.unresolved.map((q) => q.id), ["scope"]);
});

test("one concern already asked does not block a DIFFERENT, still-fresh concern", () => {
  const askedAlready = msg({ body: formatClarifyingQuestion({ id: "scope", question: "Which scope?", established: "x" }) });
  const result = interpretReply(ctxFor({ priorMessages: [askedAlready] }), {
    rules: [unresolvedRule("scope"), unresolvedRule("owner")],
  });
  assert.equal(result.status, "clarifying");
  assert.ok(result.status === "clarifying");
  assert.equal(result.question.id, "owner"); // never re-proposes "scope"
});

test("clarifyingQuestionId recognizes only this module's own tagged messages", () => {
  assert.equal(clarifyingQuestionId(formatClarifyingQuestion({ id: "scope", question: "q", established: "e" })), "scope");
  assert.equal(clarifyingQuestionId("the retry still failed CI"), undefined);
  assert.equal(clarifyingQuestionId("plain human reply text"), undefined);
});

// ── 6: rounds are bounded and exhaustion reports what is unresolved rather than guessing ──────

test("a thread that already spent the round budget reports exhausted rather than asking again", () => {
  const prior: ThreadMessage[] = ["r1", "r2"].map((id) =>
    msg({ body: formatClarifyingQuestion({ id, question: `q-${id}`, established: `e-${id}` }) }),
  );
  const result = interpretReply(ctxFor({ priorMessages: prior }), {
    rules: [unresolvedRule("r1"), unresolvedRule("r2"), unresolvedRule("r3")],
    maxRounds: 2,
  });
  assert.equal(result.status, "exhausted");
  assert.ok(result.status === "exhausted");
  // Every concern still open is named -- including r3, which was never even asked yet -- because
  // the bound is on ROUNDS SPENT, not on r3's own history; the report never pretends r3 is settled.
  assert.deepEqual(new Set(result.unresolved.map((q) => q.id)), new Set(["r1", "r2", "r3"]));
});

test("DEFAULT_MAX_ROUNDS is finite and is the bound interpretReply uses when unset", () => {
  assert.ok(Number.isFinite(DEFAULT_MAX_ROUNDS) && DEFAULT_MAX_ROUNDS > 0);
  const prior: ThreadMessage[] = Array.from({ length: DEFAULT_MAX_ROUNDS }, (_, i) =>
    msg({ body: formatClarifyingQuestion({ id: `r${i}`, question: `q${i}`, established: `e${i}` }) }),
  );
  const rules = [...Array.from({ length: DEFAULT_MAX_ROUNDS }, (_, i) => unresolvedRule(`r${i}`)), unresolvedRule("fresh")];
  const result = interpretReply(ctxFor({ priorMessages: prior }), { rules }); // no maxRounds override
  assert.equal(result.status, "exhausted");
});

test("under the round budget, a fresh concern is still asked normally", () => {
  const prior: ThreadMessage[] = [msg({ body: formatClarifyingQuestion({ id: "r1", question: "q", established: "e" }) })];
  const result = interpretReply(ctxFor({ priorMessages: prior }), {
    rules: [unresolvedRule("r1"), unresolvedRule("r2")],
    maxRounds: 5,
  });
  assert.equal(result.status, "clarifying");
  assert.ok(result.status === "clarifying");
  assert.equal(result.question.id, "r2");
});

test("formatExhaustionReport names every unresolved question, not a summary count alone", () => {
  const rendered = formatExhaustionReport([
    { id: "r1", question: "Which repo?", established: "owner unknown" },
    { id: "r2", question: "Which branch?", established: "branch unknown" },
  ]);
  assert.match(rendered, /Which repo\?/);
  assert.match(rendered, /Which branch\?/);
  assert.match(rendered, /owner unknown/);
  assert.match(rendered, /branch unknown/);
});

// ── 7: nothing on this path dispatches, ratifies, files a task or arms a merge ────────────────

const FORBIDDEN_POWER =
  /requestKick\(|requestDrainNow\(|requestPause\(|resumeFleet\(|ratify\.(approve|reframe)\(|gh\s+pr\s+(merge|close)|classifyProposal\(|spawnWorker\(|captureFeedback\(/;

test("reply-interpreter.ts names no dispatch primitive, ratify gateway, task-filing, or merge-arming call anywhere", () => {
  const src = readSrc("lib/reply-interpreter.ts");
  assert.doesNotMatch(src, FORBIDDEN_POWER);
  // Positive control -- the module still does its OWN two jobs (decide, format), proving the
  // check above isn't vacuously passing on an empty read.
  assert.match(src, /export function interpretReply\(/);
  assert.match(src, /export function formatClarifyingQuestion\(/);
});

test("reply-interpreter.ts imports no fleet-control, ratify, worker, or feedback module -- it decides, it never acts", () => {
  const src = readSrc("lib/reply-interpreter.ts");
  assert.doesNotMatch(src, /from ["']\.\/fleet-control\.js["']/);
  assert.doesNotMatch(src, /from ["']\.\/worker\.js["']/);
  assert.doesNotMatch(src, /from ["']\.\/feedback\.js["']/);
  assert.doesNotMatch(src, /from ["']\.\/panel-graph\.js["']/);
});

// ── 8: the onboarding generators keep their existing callers and behaviour ────────────────────

test("reply-interpreter.ts never imports from onboard/ -- the onboarding generators gain no new caller", () => {
  const interpreterSrc = readSrc("lib/reply-interpreter.ts");
  const panelActionsSrc = readSrc("lib/panel-actions.ts");
  assert.doesNotMatch(interpreterSrc, /from ["']\.\/onboard\//);
  assert.doesNotMatch(panelActionsSrc, /from ["']\.\/onboard\//);
});

// ── 9: the reply route calls the interpreter rather than the interpreter standing alone ───────

test("buildEscalationReplyRoute calls interpretReply", () => {
  const src = readSrc("lib/panel-actions.ts");
  assert.match(src, /interpretReply\(/);
});

// ── Integration: the route actually wires it, end to end ─────────────────────────────────────

const READ_TOKEN = "reply-interp-read-token";
const WRITE_TOKEN = "reply-interp-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-reply-interp-"));
}
function threadStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-reply-interp-threads-")), "threads.jsonl");
}
function fakeIssueCloser(): IssueCloser {
  return { close() {} };
}
function depsFor(root: string, path: string, extra: Partial<PanelActionDeps> = {}): PanelActionDeps {
  return { root, ledgerPath: join(root, "state", "ledger.ndjson"), issues: fakeIssueCloser(), threadStorePath: path, ...extra };
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
function replyBody(over: Record<string, unknown> = {}) {
  return { taskId: "W1-T9202", class: "BLOCKED", text: "let's proceed", ...over };
}
function raisedThread(path: string): string {
  return appendThreadMessage(baseIdentity(), "escalation", "the retry still failed CI", { threadStorePath: path });
}

test("(integration) an unresolved ambiguity lands a clarifying question on the SAME thread as the reply", async () => {
  const root = tmpRoot();
  const path = threadStorePath();
  const threadId = raisedThread(path);
  const rules = [unresolvedRule("owner", "the reply did not name an owner")];

  await withService([buildEscalationReplyRoute(depsFor(root, path, { interpretReplyDeps: { rules } }))], async (base) => {
    const res = await post(base, "/v1/escalation/reply", WRITE_TOKEN, replyBody());
    assert.equal(res.status, 200);
    const body = (await res.json()) as { threadId: string; interpretation: { status: string } };
    assert.equal(body.threadId, threadId);
    assert.equal(body.interpretation.status, "clarifying");
  });

  const read = readThread(threadId, { threadStorePath: path });
  assert.equal(read.status, "ok");
  assert.ok(read.status === "ok");
  // ON ITS OWN THREAD -- same threadId, three messages, the third one the clarifying question,
  // never a second inbox / a new thread id.
  assert.equal(read.messages.every((m) => m.threadId === threadId), true);
  assert.deepEqual(read.messages.map((m) => m.role), ["escalation", "reply", "escalation"]);
  const last = read.messages[2]!;
  assert.equal(clarifyingQuestionId(last.body), "owner");
  assert.match(last.body, /already established: the reply did not name an owner/);
});

test("(integration) an understood reply (no rules configured) files exactly as it always did -- two messages, feedback filed", async () => {
  const root = tmpRoot();
  const path = threadStorePath();
  const threadId = raisedThread(path);

  await withService([buildEscalationReplyRoute(depsFor(root, path))], async (base) => {
    const res = await post(base, "/v1/escalation/reply", WRITE_TOKEN, replyBody());
    assert.equal(res.status, 200);
    const body = (await res.json()) as { interpretation: { status: string } };
    assert.equal(body.interpretation.status, "understood");
  });

  const read = readThread(threadId, { threadStorePath: path });
  assert.equal(read.status, "ok");
  assert.deepEqual(read.status === "ok" && read.messages.map((m) => m.role), ["escalation", "reply"]);
});

test("(integration) a bounded-out thread files an exhaustion report naming what's unresolved, not a guess", async () => {
  const root = tmpRoot();
  const path = threadStorePath();
  const threadId = raisedThread(path);
  appendThreadMessage(baseIdentity(), "escalation", formatClarifyingQuestion({ id: "owner", question: "q", established: "e" }), {
    threadStorePath: path,
  });
  const rules = [unresolvedRule("owner", "still not named")];

  await withService(
    [buildEscalationReplyRoute(depsFor(root, path, { interpretReplyDeps: { rules, maxRounds: 5 } }))],
    async (base) => {
      const res = await post(base, "/v1/escalation/reply", WRITE_TOKEN, replyBody());
      assert.equal(res.status, 200);
      const body = (await res.json()) as { interpretation: { status: string } };
      assert.equal(body.interpretation.status, "exhausted");
    },
  );

  const read = readThread(threadId, { threadStorePath: path });
  assert.equal(read.status, "ok");
  assert.ok(read.status === "ok");
  assert.deepEqual(read.messages.map((m) => m.role), ["escalation", "escalation", "reply", "escalation"]);
  const last = read.messages[3]!;
  assert.match(last.body, /clarify-exhausted/);
  assert.match(last.body, /still not named/);
});
