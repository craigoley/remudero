// test/a-digest-reaches-a-surface-the-operator-reads.test.ts - W1-T3156.
//
// The daily digest already writes state/inbox-digests.json. This suite proves the console reads
// that exact store and renders its entries through the existing mailbox surface.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { renderConsoleShellScript } from "../src/lib/console-shell-script.js";
import {
  CONSOLE_INBOX_DIGEST_LIMIT,
  buildInboxDigestsRoute,
  readConsoleInboxDigests,
  renderShellHtml,
} from "../src/lib/serve.js";
import { inboxDigestsPath } from "../src/lib/digest.js";

const HTML = renderShellHtml();

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
  buildMailboxThreads: (tasks: unknown, replies: unknown, digests?: unknown) => unknown[] | null;
  mailboxHtml: (
    tasks: unknown,
    replies: unknown,
    readIds: string[],
    resolvedIds: string[],
    includeResolved: boolean,
    existingRowsHtml: string,
    digests?: unknown,
  ) => string;
}

function mailboxHarness(): Mailbox {
  const factory = new Function(
    [
      "var hasWriteScope = true;",
      renderConsoleShellScript(),
      clientFn("writeGateAttrs"),
      clientConst("MAILBOX_SENDER"),
      clientFn("buildMailboxThreads"),
      clientFn("mailboxThreadsHtml"),
      clientFn("mailboxHtml"),
      "return { buildMailboxThreads: buildMailboxThreads, mailboxHtml: mailboxHtml };",
    ].join("\n"),
  ) as () => Mailbox;
  return factory();
}

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

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-inbox-digests-"));
}

function writeDigests(root: string, entries: Array<{ ts: string; text: string }>): void {
  const path = inboxDigestsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2));
}

async function routeBody(root: string, limit?: number): Promise<unknown> {
  let body = "";
  let status = 0;
  const route = buildInboxDigestsRoute({ root, limit });
  await route.handler(
    {} as never,
    {
      writeHead(code: number) {
        status = code;
      },
      end(payload: string) {
        body = payload;
      },
    } as never,
    {} as never,
  );
  assert.equal(status, 200);
  return JSON.parse(body) as unknown;
}

test("W1-T3156: a stored digest appears in the console mailbox", () => {
  const { buildMailboxThreads, mailboxHtml } = mailboxHarness();
  const digests = {
    entries: [{ ts: "2026-09-08T06:17:27.164Z", text: "daily digest: 3 merged, 1 blocked" }],
    omitted: 0,
  };

  const threads = buildMailboxThreads([], [], digests) as Array<{
    threadId: string;
    taskId: string;
    messages: Array<{ role: string; sender: string; body: string }>;
  }>;
  assert.equal(threads.length, 1);
  assert.equal(threads[0].threadId, "digest:2026-09-08T06:17:27.164Z");
  assert.equal(threads[0].taskId, "Daily digest");
  assert.equal(threads[0].messages[0].role, "digest");
  assert.equal(threads[0].messages[0].sender, "Daily digest");
  assert.equal(threads[0].messages[0].body, "daily digest: 3 merged, 1 blocked");

  const html = mailboxHtml([], [], [], [], false, "", digests);
  assert.match(html, /daily digest: 3 merged, 1 blocked/);
  assert.doesNotMatch(html, /class="mailbox-reply"/, "digest threads do not render escalation reply controls");
});

test("W1-T3156: digests and escalations coexist without changing the escalation thread", () => {
  const { buildMailboxThreads, mailboxHtml } = mailboxHarness();
  const tasks = [taskRow()];
  const replies = [replyEntry()];

  const before = buildMailboxThreads(tasks, replies) as Array<{ taskId: string; threadId: string; messages: unknown[]; issueUrl: string }>;
  const after = buildMailboxThreads(tasks, replies, {
    entries: [{ ts: "2026-01-02T00:00:00.000Z", text: "daily digest: newest report" }],
    omitted: 0,
  }) as Array<{ taskId: string; threadId: string; messages: unknown[]; issueUrl: string }>;

  const escalationBefore = before.find((thread) => thread.taskId === "W1-T9001");
  const escalationAfter = after.find((thread) => thread.taskId === "W1-T9001");
  assert.deepEqual(escalationAfter, escalationBefore);
  assert.ok(after.some((thread) => thread.taskId === "Daily digest"));

  const html = mailboxHtml(tasks, replies, [], [], false, "", {
    entries: [{ ts: "2026-01-02T00:00:00.000Z", text: "daily digest: newest report" }],
    omitted: 0,
  });
  assert.match(html, /daily digest: newest report/);
  assert.match(html, /the frobnicator needs a widget/);
  assert.match(html, /retry once more, the flake looks like ci noise/);
});

test("W1-T3156: the digest reader is bounded and states how many older reports it omitted", async () => {
  const root = tmpRoot();
  const entries = Array.from({ length: CONSOLE_INBOX_DIGEST_LIMIT + 2 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return { ts: `2026-09-${n}T00:00:00.000Z`, text: `daily digest ${n}` };
  });
  writeDigests(root, entries);

  const snap = await routeBody(root);
  assert.deepEqual(snap, {
    entries: entries.slice(2),
    omitted: 2,
  });

  const { mailboxHtml } = mailboxHarness();
  const html = mailboxHtml([], [], [], [], false, "", snap);
  assert.match(html, /2 older daily digests omitted/);
  assert.doesNotMatch(html, /daily digest 01/);
  assert.doesNotMatch(html, /daily digest 02/);
  assert.match(html, /daily digest 03/);
  assert.match(html, /daily digest 12/);
});

test("W1-T3156: absent or unparseable digest storage renders no digests and throws nothing", async () => {
  const absentRoot = tmpRoot();
  assert.deepEqual(readConsoleInboxDigests(absentRoot), { entries: [], omitted: 0 });
  assert.deepEqual(await routeBody(absentRoot), { entries: [], omitted: 0 });

  const brokenRoot = tmpRoot();
  mkdirSync(dirname(inboxDigestsPath(brokenRoot)), { recursive: true });
  writeFileSync(inboxDigestsPath(brokenRoot), "{not json");
  assert.deepEqual(readConsoleInboxDigests(brokenRoot), { entries: [], omitted: 0 });
  assert.deepEqual(await routeBody(brokenRoot), { entries: [], omitted: 0 });

  const { mailboxHtml } = mailboxHarness();
  assert.match(mailboxHtml([], [], [], [], false, "", readConsoleInboxDigests(brokenRoot)), /no open threads/);
});
