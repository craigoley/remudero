import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mailboxEscalationClass,
  mailboxMarkRead,
  mailboxMarkResolved,
  mailboxThreadKey,
  mailboxUnreadCount,
  mailboxVisibleThreads,
} from "../src/lib/console-shell-script.js";
import { renderShellHtml } from "../src/lib/serve.js";

const HTML = renderShellHtml();

function sectionHtml(id: string): string {
  const start = HTML.indexOf(`<section id="${id}"`);
  assert.notEqual(start, -1, `#${id} must render`);
  const end = HTML.indexOf("\n</section>", start);
  assert.notEqual(end, -1, `#${id} must close`);
  return HTML.slice(start, end + "\n</section>".length);
}

function elementHtml(id: string): string {
  const re = new RegExp(`<[^>]+id="${id}"[\\s\\S]*?</[^>]+>`);
  const match = HTML.match(re);
  assert.ok(match, `#${id} must render`);
  return match[0];
}

function largestScriptBlock(): string {
  const scripts = Array.from(HTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g), (m) => m[1]);
  assert.ok(scripts.length > 0, "the shell must emit a client script");
  return scripts.reduce((largest, script) => (script.length > largest.length ? script : largest), "");
}

test("W1-T3157: the mailbox renders as its own tab-owned section rather than inside needs-me", () => {
  const mailbox = sectionHtml("mailbox-section");
  const needsMe = sectionHtml("needs-me");

  assert.match(mailbox, /data-owner-tab="decisions"/, "the mailbox section must be owned by a real tab");
  assert.match(mailbox, /<h2><span>Mailbox<\/span><\/h2>/);
  assert.match(mailbox, /<div id="mailbox" class="mailbox" aria-label="Mailbox"><\/div>/);
  assert.doesNotMatch(needsMe, /\bid="mailbox"\b/, "needs-me must not own the mailbox list");
  assert.doesNotMatch(needsMe, /mailbox-heading/, "needs-me must not carry a nested mailbox heading");
  assert.ok(
    HTML.indexOf('<section id="mailbox-section"') < HTML.indexOf('<section id="needs-me"'),
    "mailbox must render before the long needs-me/backlog rows",
  );
});

test("W1-T3157: the unread count is reachable from the tab strip without opening the mailbox section", () => {
  const tabs = elementHtml("console-tabs");
  const decisionsButton = elementHtml("tab-decisions");

  assert.match(decisionsButton, /id="mailbox-unread-count"/, "the badge must live in the visible tab strip");
  assert.match(tabs, /id="mailbox-unread-count"/);
  assert.doesNotMatch(sectionHtml("mailbox-section"), /id="mailbox-unread-count"/);
  assert.doesNotThrow(
    () => new Function(largestScriptBlock()),
    "the rendered client script must stay parseable after moving the badge",
  );
});

test("W1-T3157: the needs-me list rows and controls stay in their original section", () => {
  const needsMe = sectionHtml("needs-me");

  assert.match(needsMe, /id="needs-me-toggle"[\s\S]*?aria-controls="needs-me-body"/);
  assert.match(needsMe, /<ul id="needs-me-list" class="row-list">/);
  assert.match(needsMe, /<span id="needs-me-backlog-summary" class="section-summary">/);
  assert.match(
    needsMe,
    /<ul id="needs-me-backlog-list" class="row-list" aria-label="verify: human backlog, no action required"><\/ul>/,
  );
  assert.ok(
    needsMe.indexOf('id="needs-me-list"') < needsMe.indexOf('id="needs-me-backlog-list"'),
    "the actionable needs-me rows must still render before the verify: human backlog",
  );
});

test("W1-T3157: mailbox thread keys and read/resolved state survive the placement move", () => {
  const threadId = mailboxThreadKey("W1-T9001", mailboxEscalationClass("[BLOCKED] W1-T9001: blocked"));
  const threads = [{ threadId }, { threadId: mailboxThreadKey("W1-T9002", "GRILL") }];

  assert.equal(threadId, "thread:W1-T9001::BLOCKED::");
  assert.deepEqual(mailboxMarkRead([], threadId), [threadId]);
  assert.equal(mailboxUnreadCount(threads, [threadId]), 1);
  assert.deepEqual(mailboxVisibleThreads(threads, mailboxMarkResolved([], threadId), false), [threads[1]]);
});
