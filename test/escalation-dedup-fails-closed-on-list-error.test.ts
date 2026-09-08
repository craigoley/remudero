/**
 * test/escalation-dedup-fails-closed-on-list-error.test.ts — W1-T2912.
 *
 * THE DEFECT. `findDuplicateEscalation` (src/lib/escalate.ts) returned `undefined` for THREE
 * distinct situations: no open issue matches, the gateway has no `listOpen`, and `listOpen` threw.
 * `escalate()`/`escalateWithJudge()` treated every `undefined` as "no duplicate — create one". So a
 * REST outage (while the GraphQL `create` mutation still works, W1-T1024) reads as "no match" on
 * every tick, and files a fresh `needs-human` issue per tick for the length of the outage — flooding
 * the very channel escalation exists to keep legible.
 *
 * THE FIX. `escalate()`/`escalateWithJudge()` now consult `lookupDuplicateEscalation` (unexported),
 * whose result distinguishes `{ kind: "unreadable" }` from `{ kind: "none" }`/`{ kind: "found" }`. On
 * `unreadable` they refuse to create, append an `escalation.dedup_unreadable` ledger row carrying the
 * error text, and return `""` — never a real issue URL. The next tick's read retries; the condition
 * being escalated is durable and will still be there.
 *
 * `findDuplicateEscalation` itself is DELIBERATELY UNCHANGED: it is also the fix rung's pre-strike
 * false-block probe (run-task.ts), which relies on a throwing `listOpen` staying fail-open so an
 * unreadable surface never itself manufactures a stand-down (see the comment at that call site).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { escalate, type Escalation, type IssueGateway, type OpenIssue } from "../src/lib/escalate.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-escalate-dedup-")), "ledger.ndjson");
}

function readLedger(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-T2912",
    summary: "REST surface unreadable while GraphQL create still works",
    detail: "listOpen is throwing on every tick during the outage.",
    options: [{ label: "wait", detail: "wait for the REST surface to recover." }],
    recommendation: "wait",
    ...over,
  };
}

/** Records every `create()` call and lets the test wire `listOpen` to throw or to answer. */
function recordingIssueStore(): IssueGateway & { creates: Array<{ title: string; body: string }> } {
  const creates: Array<{ title: string; body: string }> = [];
  return {
    creates,
    create(title, body) {
      creates.push({ title, body });
      return `https://github.com/craigoley/remudero/issues/${creates.length}`;
    },
  };
}

test("W1-T2912: a listOpen that THROWS on every tick produces zero creates and one ledger row per tick, never a duplicate issue", () => {
  const path = ledgerPath();
  const store = recordingIssueStore();
  store.listOpen = (): OpenIssue[] => {
    throw new Error("gh: HTTP 502 (REST surface down)");
  };

  const first = escalate(escalation(), { issues: store, ledgerPath: path, runId: "RUN-1" });
  const second = escalate(escalation(), { issues: store, ledgerPath: path, runId: "RUN-2" });

  assert.equal(first, "", "no issue was opened on an unreadable dedup read");
  assert.equal(second, "", "the second tick refuses to create too — the read is retried, not remembered");
  assert.equal(store.creates.length, 0, "a failed dedup read must refuse to create, never file a duplicate");

  const rows = readLedger(path);
  assert.equal(rows.length, 2, "one escalation.dedup_unreadable ledger row per tick, so the next read is retried");
  for (const row of rows) {
    assert.equal(row.step, "escalation.dedup_unreadable");
    assert.equal(row.task_id, "W1-T2912");
    assert.match(String(row.error), /HTTP 502/, "the ledger row carries the read's own error text");
  }
});

test("W1-T2912 control: a listOpen that returns an empty list (a genuinely readable surface with no match) still creates exactly once", () => {
  const path = ledgerPath();
  const store = recordingIssueStore();
  store.listOpen = (): OpenIssue[] => [];

  const url = escalate(escalation(), { issues: store, ledgerPath: path, runId: "RUN-1" });

  assert.ok(url, "a readable surface with no duplicate open issue still files the escalation");
  assert.equal(store.creates.length, 1, "exactly one create — the empty-list control is a genuine no-match, not an outage");

  const rows = readLedger(path);
  assert.equal(rows.filter((r) => r.step === "escalation.dedup_unreadable").length, 0, "a readable empty list is never dedup_unreadable");
});
