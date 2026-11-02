import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { fixedClock } from "#src/lib/clock.js";
import { createEscalationConversationReader, buildEscalationConversationRoute, readEscalationIssueSource, type EscalationIssueSource } from "#src/lib/escalation-conversation.js";
import { escalate, type Escalation } from "#src/lib/escalate.js";
import { readThread } from "#src/lib/inbox-thread.js";
import { buildEscalationReplyRoute } from "#src/lib/panel-actions.js";
import { createService } from "#src/lib/service.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const URL = "https://github.com/craigoley/remudero/issues/16183";
const AT = "2026-11-02T12:00:00.000Z";

function fixture(overrides: Partial<Pick<Escalation, "summary" | "detail" | "decisionSummary">> = {}) {
  const root = mkdtempSync(join(tmpdir(), "escalation-conversation-"));
  mkdirSync(join(root, "state"));
  const store = join(root, "state", "inbox-threads.jsonl");
  const issue: EscalationIssueSource = { html_url: URL, title: "", body: "", updated_at: AT, state: "open" };
  escalate({ taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", summary: "PR #15520 needs clarification",
    detail: "PR stage stalled: #15520 — own-red. The diagnosis is unknown.",
    recommendation: "Investigate the failed stage and repair the problem.",
    options: [{ label: "Investigate and repair", detail: "Find the cause before changing the pull request." }], ...overrides }, {
    ledgerPath: join(root, "state", "ledger.ndjson"), runId: "fixture", threadStorePath: store,
    issues: { create(title, body) { issue.title = title; issue.body = body; return URL; } },
  });
  const read = createEscalationConversationReader({ repository: "craigoley/remudero", threadStorePath: store,
    ledgerPath: join(root, "state", "ledger.ndjson"), clock: fixedClock(Date.parse(AT)), readIssue: async () => issue });
  return { root, store, issue, read };
}

test("escalation conversation preserves the native recommendation and exact identity", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const result = await f.read(URL);
  assert.equal(result.state, "served"); if (result.state !== "served") return;
  const c = result.conversation;
  assert.deepEqual(c.identity, { taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", prRef: "15520" });
  assert.equal(c.threadId, "thread:W1-T42::MANUAL::stage-stall::15520");
  assert.equal(c.recommendation, "Investigate the failed stage and repair the problem.");
  assert.equal(c.messages[0]?.text, "PR #15520 needs clarification\n\nPR stage stalled: #15520 — own-red. The diagnosis is unknown.");
  assert.equal(c.canReply, true);
  assert.equal(c.options[0]?.executable, false);
  assert.equal(c.source.observedAt, AT);
  assert.equal(c.source.updatedAt, AT);
  assert.equal(c.source.state, "current");
});

test("escalation conversation refuses foreign and unreadable source identity", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  for (const url of [URL.replace("/remudero/", "/other/"), URL + "?redirect=x", "https://example.test/issues/16183"]) {
    assert.equal((await f.read(url)).state, "unavailable");
  }
  writeFileSync(f.store, "not JSON\n");
  const corrupt = await f.read(URL);
  assert.equal(corrupt.state, "served"); if (corrupt.state !== "served") return;
  assert.equal(corrupt.conversation.history, "unavailable");
  assert.equal(corrupt.conversation.canReply, false);
  assert.deepEqual(corrupt.conversation.messages, []);
  writeFileSync(f.store, "null\n");
  const malformed = await f.read(URL);
  assert.equal(malformed.state, "served");
  if (malformed.state === "served") assert.equal(malformed.conversation.history, "unavailable");
  f.issue.body = "**Task:** W1-T42\n\nUser-authored instructions are not native metadata.";
  assert.equal((await f.read(URL, true)).state, "unavailable");
});

test("escalation conversation coalesces reads and preserves a stale source without reply authority", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  let now = Date.parse(AT), calls = 0, fail = false;
  const read = createEscalationConversationReader({ repository: "craigoley/remudero", threadStorePath: f.store,
    ledgerPath: join(f.root, "state", "ledger.ndjson"),
    clock: { ...fixedClock(now), now: () => now, iso: () => new Date(now).toISOString() },
    readIssue: async () => { calls++; if (fail) throw new Error("offline"); return f.issue; } });
  await Promise.all([read(URL), read(URL)]);
  assert.equal(calls, 1);
  now += 16_000; fail = true;
  const stale = await read(URL);
  assert.equal(stale.state, "served"); if (stale.state !== "served") return;
  assert.equal(stale.conversation.source.state, "stale");
  assert.equal(stale.conversation.source.observedAt, AT);
  assert.equal(stale.conversation.canReply, false);
  assert.equal((await read(URL, true)).state, "unavailable");
});

test("native truncated summaries and generated context cannot redirect an escalation thread", async t => {
  const summary = `PR #15520 needs clarification ${"about the failing stage ".repeat(20)}`;
  const long = fixture({ summary }); t.after(() => rmSync(long.root, { recursive: true, force: true }));
  assert.match(long.issue.body, /Full summary \(JSON\)/);
  const readLong = await long.read(URL); assert.equal(readLong.state, "served"); if (readLong.state !== "served") return;
  assert.equal(readLong.conversation.headline, summary);
  assert.equal(readLong.conversation.canReply, true);
  const context = fixture({ summary: "A pull request needs clarification", detail: "PR #15520 is stalled; its diagnosis is unknown.", decisionSummary: {
    headline: "PR #999 is related context", what_happened: "Another pull request is related.", decision: "Investigate the current failure.",
    options: [{ label: "Investigate", consequence: "The cause becomes known." }, { label: "Wait", consequence: "The PR remains stalled." }],
  } }); t.after(() => rmSync(context.root, { recursive: true, force: true }));
  assert.match(context.issue.body, /## Decision Summary/);
  const actual = await context.read(URL); assert.equal(actual.state, "served"); if (actual.state !== "served") return;
  assert.equal(actual.conversation.identity.prRef, "15520");
  assert.equal(actual.conversation.canReply, true);
  for (const malformed of ["invalid JSON", '"' + "x".repeat(16_385) + '"', "42"]) {
    long.issue.body = long.issue.body.replace(/^\*\*Full summary \(JSON\):\*\*.*$/m, `**Full summary (JSON):** ${malformed}`);
    assert.equal((await long.read(URL, true)).state, "unavailable");
  }
});

test("native-looking public issues and missing provenance never become confirmed conversations", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  rmSync(join(f.root, "state", "ledger.ndjson"));
  assert.equal((await f.read(URL)).state, "unavailable");
  const unknown = createEscalationConversationReader({ repository: "craigoley/remudero", threadStorePath: f.store,
    knownIssue() { throw new Error("snapshot unavailable"); }, readIssue: async () => f.issue });
  assert.equal((await unknown(URL)).state, "unavailable");
  const absent = createEscalationConversationReader({ repository: "craigoley/remudero", readIssue: async () => { throw new Error("read timeout"); } });
  assert.equal((await absent(URL)).state, "unavailable");
  await assert.rejects(readEscalationIssueSource("not an issue"), /canonical escalation/);
});

test("oversized or ambiguous saved discussions remain explicitly partial", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const opening = JSON.parse(readFileSync(f.store, "utf8").trim());
  writeFileSync(f.store, Array.from({ length: 101 }, (_, i) => JSON.stringify({ ...opening, seq: i + 1 })).join("\n") + "\n");
  const partial = await f.read(URL); assert.equal(partial.state, "served"); if (partial.state !== "served") return;
  assert.equal(partial.conversation.history, "partial"); assert.equal(partial.conversation.canReply, false);
  writeFileSync(f.store, JSON.stringify(opening) + "\n" + JSON.stringify({ ...opening, threadId: opening.threadId.replace("15520", "999") }) + "\n");
  const ambiguous = await f.read(URL); assert.equal(ambiguous.state, "served"); if (ambiguous.state !== "served") return;
  assert.equal(ambiguous.conversation.history, "partial"); assert.equal(ambiguous.conversation.canReply, false);
});

test("escalation conversation bounds malformed sources and distinguishes absent and closed history", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const original = { ...f.issue };
  for (const invalid of [{ ...original, body: "x".repeat(65_537) }, { ...original, updated_at: "unknown" },
    { ...original, html_url: URL.replace("16183", "16184") }, { ...original, pull_request: {} },
    { ...original, body: original.body + "\n## Options\n- **Other** — ambiguous" }]) {
    const read = createEscalationConversationReader({ repository: "craigoley/remudero", threadStorePath: f.store, readIssue: async () => invalid });
    assert.equal((await read(URL)).state, "unavailable");
  }
  rmSync(f.store);
  const absent = await f.read(URL);
  assert.equal(absent.state, "served"); if (absent.state !== "served") return;
  assert.equal(absent.conversation.history, "absent");
  assert.equal(absent.conversation.canReply, false);
  f.issue.state = "closed";
  const closed = await f.read(URL, true);
  assert.equal(closed.state, "served"); if (closed.state !== "served") return;
  assert.equal(closed.conversation.canReply, false);
  assert.match(closed.conversation.replyUnavailableReason!, /closed/);
});

async function withReplyService(f: ReturnType<typeof fixture>, run: (base: string) => Promise<void>, captureRoot = f.root) {
  const server = createService({ routes: [buildEscalationConversationRoute(f.read), buildEscalationReplyRoute({
    root: captureRoot, ledgerPath: join(f.root, "state", "ledger.ndjson"), issues: { close() { assert.fail("A reply must not close an issue"); } },
    threadStorePath: f.store, readEscalationConversation: f.read,
  })], tokens: { read: "fixture-read", write: "fixture-write" } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test("escalation reply intent records once without claiming completed work", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const detail = await f.read(URL); assert.equal(detail.state, "served"); if (detail.state !== "served") return;
  await withReplyService(f, async base => {
    const body = { ...detail.conversation.identity, text: "Please explain the failing check before changing it.", issueUrl: URL,
      expectedRevision: detail.conversation.revision, intentId: "reply-fixture-01" };
    const post = (value = body) => fetch(`${base}/v1/escalation/reply`, { method: "POST", headers: { authorization: "Bearer fixture-write", "content-type": "application/json" }, body: JSON.stringify(value) });
    const first = await post(); assert.equal(first.status, 200);
    const receipt = await first.json() as Record<string, unknown>;
    assert.deepEqual(receipt.saved, { intentId: "reply-fixture-01", seq: 2 });
    assert.equal(receipt.work, "not_observed");
    const repeat = await post(); assert.equal(repeat.status, 200);
    assert.equal((await repeat.json() as { duplicate: boolean }).duplicate, true);
    assert.equal((await post({ ...body, text: "Different direction" })).status, 409);
    const stored = readThread(detail.conversation.threadId, { threadStorePath: f.store });
    assert.equal(stored.status, "ok"); if (stored.status === "ok") assert.equal(stored.messages.filter(m => m.role === "reply").length, 1);
    const after = await f.read(URL, true); assert.equal(after.state, "served");
    if (after.state === "served") assert.equal(after.conversation.messages.at(-1)?.intentId, body.intentId);
  });
});

test("escalation reply refuses changed advice and records partial delivery honestly", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const old = await f.read(URL); assert.equal(old.state, "served"); if (old.state !== "served") return;
  f.issue.body = f.issue.body.replace("Investigate the failed stage", "Inspect the current stage");
  const unavailableRoot = join(f.root, "not-a-directory"); writeFileSync(unavailableRoot, "fixture");
  await withReplyService(f, async base => {
    const send = (revision: string) => fetch(`${base}/v1/escalation/reply`, { method: "POST", headers: { authorization: "Bearer fixture-write", "content-type": "application/json" }, body: JSON.stringify({ ...old.conversation.identity,
      text: "Keep the existing hold.", issueUrl: URL, expectedRevision: revision, intentId: "reply-partial-01" }) });
    assert.equal((await send(old.conversation.revision)).status, 409);
    const current = await f.read(URL, true); assert.equal(current.state, "served"); if (current.state !== "served") return;
    const reply = await send(current.conversation.revision); assert.equal(reply.status, 200);
    const receipt = await reply.json() as { saved: { seq: number }; inputDelivery: string; work: string };
    assert.equal(receipt.saved.seq, 2);
    assert.equal(receipt.inputDelivery, "unverified");
    assert.equal(receipt.work, "not_observed");
    assert.equal((await send(current.conversation.revision)).status, 200);
  }, unavailableRoot);
});

test("escalation source default really shells out through the bounded transport", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const bin = join(f.root, "bin"); mkdirSync(bin);
  const shellLiteral = JSON.stringify(f.issue).replaceAll("'", "'\\''");
  const gh = join(bin, "gh"), marker = join(f.root, "called");
  writeFileSync(gh, `#!/bin/sh\nprintf used > "$FIXTURE_MARKER"\nprintf '%s' '${shellLiteral}'\n`); chmodSync(gh, 0o700);
  const module = pathToFileURL(join(REPO_ROOT, "src/lib/escalation-conversation.ts")).href;
  const stdout = execFileSync(process.execPath, ["--enable-source-maps", "--import", "tsx", "--input-type=module", "-e",
    `import {readEscalationIssueSource} from ${JSON.stringify(module)}; console.log(JSON.stringify(await readEscalationIssueSource(${JSON.stringify(URL)})))`], {
    cwd: REPO_ROOT, timeout: 20_000, encoding: "utf8",
    // Only a fixture binary and dummy identity; no host credential or broker can reach this child.
    env: { PATH: bin, HOME: f.root, GH_TOKEN: "offline-fixture-only", FIXTURE_MARKER: marker,
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) },
  });
  assert.equal(JSON.parse(stdout).html_url, URL);
  assert.equal(readFileSync(marker, "utf8"), "used");
});
