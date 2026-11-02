import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendThreadMessage, appendThreadReplyOnce, deriveThreadId, readThread } from "#src/lib/inbox-thread.js";
import { escalationThreadIdentity, escalationReplySubmissionKey, recordEscalationIntakeOutcome } from "#src/lib/escalation-correspondence.js";
import type { FeedbackEntry } from "#src/lib/feedback.js";
import { mergeFeedbackRecord } from "#src/lib/feedback-record-merge.js";
import { parse, stringify } from "yaml";
import { createServer, type Socket } from "node:net";
import { ghBrokerDir } from "#src/lib/gh-read-broker-client.js";
import { createEscalationConversationReader, readEscalationIssueSource } from "#src/lib/escalation-conversation.js";
import { fixedClock } from "#src/lib/clock.js";
import { readEscalationQuestionFeedback } from "#src/lib/escalation-correspondence.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { buildEscalationReplyRoute } from "#src/lib/panel-actions.js";
import { createService } from "#src/lib/service.js";
import { readQueuedFeedbackRecords } from "#src/lib/feedback-landing.js";
import type { AddressInfo } from "node:net";

function fixture(t: { after: (f: () => void) => void }, answered = true) {
  const root = mkdtempSync(join(tmpdir(), "rmd-escalation-correspondence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deps = { threadStorePath: join(root, "threads.jsonl"), repository: "craigoley/remudero", now: () => 1793621400000 };
  const identity = { taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", prRef: "15520" };
  const threadId = deriveThreadId(identity), issueUrl = "https://github.com/craigoley/remudero/issues/16183";
  appendThreadMessage(identity, "escalation", "PR #15520 needs clarification\n\nPR #15520 is stalled.", deps);
  const intentId = "reply-fixture-001", text = "Investigate Linux first.";
  if (answered) appendThreadReplyOnce(identity, text, intentId, deps, { escalation: { issueUrl, revision: "a".repeat(64) } });
  const entry: FeedbackEntry = { id: "fb-fixture-001", ts: "2026-11-02T12:10:00Z", raw: text, attachments: [], origin: "ui", status: "new",
    proposal_pr: null, thread_id: threadId, submission_key: escalationReplySubmissionKey(threadId, intentId, issueUrl) };
  const messages = () => { const r = readThread(threadId, deps); assert.equal(r.status, "ok"); return r.status === "ok" ? r.messages : []; };
  return { root, deps, identity, entry, messages };
}

test("an intake response ends the ask while work remains pending", t => {
  const f = fixture(t);
  const result = recordEscalationIntakeOutcome(f.entry, { action: "propose", publicationPr: "https://github.com/craigoley/remudero/pull/16230", detail: "A bounded investigation is proposed." }, f.deps);
  assert.equal(result.state, "recorded");
  const last = f.messages().at(-1)!;
  assert.equal(last.role, "escalation"); assert.equal(last.extra?.question, false);
  assert.match(last.body, /waiting for review/); assert.match(last.body, /no more input/);
  assert.doesNotMatch(last.body, /repair completed|work is complete/i);
});

test("a later intake question reopens the original escalation thread", t => {
  const f = fixture(t);
  const result = recordEscalationIntakeOutcome(f.entry, { action: "grill", publicationPr: "https://github.com/craigoley/remudero/pull/16230",
    questionIssueUrl: "https://github.com/craigoley/remudero/issues/16231", detail: "Which Linux version should I compare?" }, f.deps);
  assert.equal(result.state, "recorded");
  const last = f.messages().at(-1)!;
  assert.equal(last.threadId, f.entry.thread_id); assert.equal(last.extra?.question, true);
  assert.match(last.body, /Which Linux version/);
});

test("escalation intake outcome replay preserves one causal response", t => {
  const f = fixture(t);
  const outcome = { action: "propose" as const, publicationPr: "https://github.com/craigoley/remudero/pull/16230", detail: "An investigation is proposed." };
  assert.equal(recordEscalationIntakeOutcome(f.entry, outcome, f.deps).state, "recorded");
  assert.equal(recordEscalationIntakeOutcome(f.entry, outcome, f.deps).state, "existing");
  assert.equal(f.messages().length, 3);
  assert.equal(recordEscalationIntakeOutcome(f.entry, { ...outcome, publicationPr: "https://github.com/craigoley/remudero/pull/999" }, f.deps).state, "unknown");
  assert.equal(f.messages().length, 3);
  const g = fixture(t);
  assert.equal(recordEscalationIntakeOutcome(g.entry, { action: "error", reason: "The publication failed." }, g.deps).state, "unknown");
  assert.equal(recordEscalationIntakeOutcome({ ...g.entry, raw: "A different answer" }, outcome, g.deps).state, "unknown");
  assert.equal(recordEscalationIntakeOutcome(g.entry, { ...outcome, publicationPr: "https://github.com/craigoley/other/pull/1" }, g.deps).state, "unknown");
  assert.equal(g.messages().length, 2);
});

test("a delayed intake response cannot end a newer ask", t => {
  const f = fixture(t);
  appendThreadReplyOnce(f.identity, "Investigate macOS instead.", "new-answer-002", f.deps,
    { escalation: { issueUrl: "https://github.com/craigoley/remudero/issues/16183", revision: "b".repeat(64) } });
  assert.equal(recordEscalationIntakeOutcome(f.entry, { action: "propose", publicationPr: "https://github.com/craigoley/remudero/pull/16230", detail: "Earlier investigation." }, f.deps).state, "unknown");
  assert.equal(f.messages().length, 3); assert.equal(f.messages().at(-1)?.role, "reply");
});

test("feedback landing preserves immutable escalation input identity through a status advance", t => {
  const f = fixture(t), upstream = stringify(f.entry);
  const local = { ...f.entry, status: "proposed", submission_key: undefined, thread_id: undefined };
  const result = mergeFeedbackRecord(upstream, stringify(local));
  assert.equal(result.kind, "take-local");
  assert.ok(result.kind === "take-local" && result.content);
  const retained = parse(result.content!);
  assert.equal(retained.submission_key, f.entry.submission_key); assert.equal(retained.thread_id, f.entry.thread_id);
  assert.equal(mergeFeedbackRecord(upstream, stringify({ ...f.entry, status: "grilling", submission_key: "another-input" })).kind, "refuse");
});

test("a fresh escalation read revalidates through the native broker", { timeout: 10_000 }, async t => {
  const cache = mkdtempSync("/tmp/rmd-cbf-"); t.after(() => rmSync(cache, { recursive: true, force: true }));
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cache })!;
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "heartbeat"), "60\n");
  const requests: Array<{ fresh?: boolean; args: string[] }> = [], clients = new Set<Socket>();
  let ordinaryClient: Socket | undefined;
  let ordinaryArrived!: () => void;
  const arrived = new Promise<void>(resolve => { ordinaryArrived = resolve; });
  const reply = (client: Socket, body: unknown) => client.end(JSON.stringify({ type: "result", stdout: JSON.stringify(body), stderr: "", exitCode: 0, outcome: "upstream-200" }) + "\n");
  const server = createServer(client => {
    clients.add(client); client.on("close", () => clients.delete(client)); let body = "";
    client.on("data", bytes => {
      body += bytes.toString(); if (!body.includes("\n")) return;
      const request = JSON.parse(body.trim()) as { fresh?: boolean; args: string[] }; requests.push(request);
      if (request.args.some(arg => arg.includes("contents/plan/feedback/"))) reply(client, { encoding: "base64", content: Buffer.from(stringify({ id: "fb-native", raw: "Question", status: "grilling" })).toString("base64") });
      else if (request.fresh === true) reply(client, { state: "fresh" });
      else { ordinaryClient = client; ordinaryArrived(); }
    });
  });
  await new Promise<void>(resolve => server.listen(join(dir, "broker.sock"), resolve));
  const saved = { cache: process.env.RMD_GH_CACHE_HOME, path: process.env.PATH };
  const shim = ghShim([{ when: "", exit: 1, stderr: "Unexpected direct gh process" }]);
  process.env.RMD_GH_CACHE_HOME = cache; process.env.PATH = `${shim.dir}:${saved.path ?? ""}`;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = "https://github.com/craigoley/remudero/issues/16183";
    const ordinary = readEscalationIssueSource(url);
    await arrived;
    // Test-only backstop releases this fixture's withheld result if fresh coalescing regresses.
    backstop = setTimeout(() => { if (ordinaryClient) reply(ordinaryClient, { state: "ordinary" }); }, 2000);
    assert.deepEqual(await readEscalationIssueSource(url, true), { state: "fresh" });
    clearTimeout(backstop); backstop = undefined;
    reply(ordinaryClient!, { state: "ordinary" }); assert.deepEqual(await ordinary, { state: "ordinary" });
    assert.equal((await readEscalationQuestionFeedback("craigoley/remudero", "fb-native", true)).id, "fb-native");
    assert.equal(requests.length, 3); assert.equal(requests[1]?.fresh, true); assert.equal(requests[2]?.fresh, true);
    assert.equal(shim.calls().length, 0);
  } finally {
    if (backstop) clearTimeout(backstop);
    for (const client of clients) client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (saved.cache === undefined) delete process.env.RMD_GH_CACHE_HOME; else process.env.RMD_GH_CACHE_HOME = saved.cache;
    process.env.PATH = saved.path; rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("fresh conversation guards cannot join or be overwritten by an older service read", async t => {
  const f = fixture(t), issueUrl = "https://github.com/craigoley/remudero/issues/16183";
  const source = { html_url: issueUrl, title: "[MANUAL] W1-T42: Question", state: "open", updated_at: "2026-11-02T12:10:00Z",
    body: "**Class:** MANUAL\n**Task:** W1-T42\n**Cause:** stage-stall\n\nAn investigation is needed.\n\n## Options\n- **Investigate** — Find the cause.\n\n## Recommendation\nOld recommendation" };
  let release!: (value: unknown) => void, arrived!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  const old = new Promise<unknown>(resolve => { release = resolve; });
  const reader = createEscalationConversationReader({ repository: f.deps.repository, threadStorePath: f.deps.threadStorePath,
    clock: fixedClock(1793621400000), knownIssue: () => true,
    readIssue: async (_url, fresh) => { if (fresh) return { ...source, body: source.body.replace("Old recommendation", "New recommendation") }; arrived(); return old; } });
  const ordinary = reader(issueUrl); await started;
  const backstop = setTimeout(() => release(source), 2000);
  try {
    const fresh = await reader(issueUrl, true); assert.equal(fresh.state, "served");
    assert.ok(fresh.state === "served"); assert.equal(fresh.conversation.recommendation, "New recommendation");
    release(source); await ordinary;
    const cached = await reader(issueUrl); assert.ok(cached.state === "served"); assert.equal(cached.conversation.recommendation, "New recommendation");
  } finally { clearTimeout(backstop); release(source); await ordinary; }
});

for (const failedCapture of [false, true]) test(`concurrent identical escalation replies preserve one input when capture ${failedCapture ? "fails" : "succeeds"}`, { timeout: 10_000 }, async t => {
  const f = fixture(t, false), issueUrl = "https://github.com/craigoley/remudero/issues/16183";
  if (failedCapture) { mkdirSync(join(f.root, "plan")); writeFileSync(join(f.root, "plan", "feedback"), "Capture is blocked in this fixture."); }
  const reader = createEscalationConversationReader({ repository: f.deps.repository, threadStorePath: f.deps.threadStorePath,
    knownIssue: () => true, readIssue: async () => ({ html_url: issueUrl, title: "[MANUAL] W1-T42: PR #15520 needs clarification", state: "open", updated_at: "2026-11-02T12:10:00Z",
      body: "**Class:** MANUAL\n**Task:** W1-T42\n**Cause:** stage-stall\n\nPR #15520 is stalled.\n\n## Options\n- **Investigate** — Find the cause.\n\n## Recommendation\nInvestigate first." }) });
  const initial = await reader(issueUrl); assert.ok(initial.state === "served"); assert.equal(initial.conversation.canReply, true);
  let arrivals = 0, release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const service = createService({ tokens: { write: "fixture-write" }, routes: [buildEscalationReplyRoute({ root: f.root,
    ledgerPath: join(f.root, "ledger.ndjson"), threadStorePath: f.deps.threadStorePath, issues: { close() { assert.fail("A reply cannot close an issue"); } },
    readEscalationConversation: async (url, fresh) => { const result = await reader(url, fresh); if (++arrivals === 2) release(); await both; return result; } })] });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${(service.address() as AddressInfo).port}/v1/escalation/reply`;
    const send = () => fetch(endpoint, { method: "POST", headers: { authorization: "Bearer fixture-write", "content-type": "application/json" },
      body: JSON.stringify({ ...f.identity, issueUrl, expectedRevision: initial.conversation.revision, intentId: "concurrent-answer-01", text: "Investigate Linux first." }) });
    const responses = await Promise.all([send(), send()]);
    for (const response of responses) { assert.equal(response.status, 200); const receipt = await response.json() as { saved: {seq: number}; work: string }; assert.equal(receipt.saved.seq, 2); assert.equal(receipt.work, "not_observed"); }
    assert.equal(f.messages().filter(message => message.role === "reply").length, 1);
    if (failedCapture) {
      assert.equal(readQueuedFeedbackRecords(f.root).size, 0); rmSync(join(f.root, "plan", "feedback"));
      const recovered = await send(); assert.equal(recovered.status, 200); await recovered.arrayBuffer();
    }
    assert.equal(readQueuedFeedbackRecords(f.root).size, 1);
  } finally { release(); service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); }
});


test("correspondence preserves every bounded native task identity including a single colon", () => {
  const identity = { taskId: "PR:15520", class: "MANUAL", cause: "stage-stall", prRef: "15520" };
  assert.deepEqual(escalationThreadIdentity(deriveThreadId(identity)), identity);
  assert.deepEqual(escalationThreadIdentity(deriveThreadId({ taskId: "A".repeat(256), class: "GRILL" })), { taskId: "A".repeat(256), class: "GRILL" });
  for (const invalid of ["other:W1-T42::MANUAL::-::-", "thread:W1-T42::UNKNOWN::-::-", "thread:W1-T42::MANUAL::other::-",
    "thread:W1-T42::MANUAL::-::0", "thread:W1-T42::MANUAL::-", "thread:W1-T42::MANUAL::-::-::extra",
    "thread:bad task::MANUAL::-::-", `thread:${"A".repeat(257)}::MANUAL::-::-`, "thread:bad\u0000task::MANUAL::-::-"])
    assert.equal(escalationThreadIdentity(invalid), undefined, JSON.stringify(invalid));
});
