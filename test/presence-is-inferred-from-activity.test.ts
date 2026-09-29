// test/presence-is-inferred-from-activity.test.ts — W1-T4674.
//
// AWAY IS A MANUAL FLAG THE OPERATOR FORGETS: presenceMode() (escalate.ts) now infers attended vs
// away from the operator's own recent activity when the AWAY flag is unset, instead of assuming
// attended forever. The manual flag still overrides outright when set. See src/lib/presence.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { awayFilePath, presenceMode, setPresenceMode } from "../src/lib/escalate.js";
import {
  COLD_START_LEASE_MS,
  inferPresenceFromActivity,
  inferOperatorPresence,
  learnLeaseMs,
  replyLatenciesMs,
  type ActivityEvent,
} from "../src/lib/presence.js";

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-presence-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  return root;
}

function ledgerPath(root: string): string {
  return join(root, "state", "ledger.ndjson");
}

// ── Acceptance claim 1 ────────────────────────────────────────────────────────────────────────

test("W1-T4674: recent operator activity reads as attended without the manual flag", () => {
  const root = tmpRoot();
  try {
    assert.equal(existsSync(awayFilePath(root)), false, "the manual flag is never set in this test");
    // A one-tap answer-link click, just now — one of the four activity sources (W1-T2696).
    appendLedger(ledgerPath(root), { run_id: "W1-T4674-TEST", task_id: "W1-T1", step: "escalation.answered_by_link" });
    assert.equal(presenceMode(root), "attended", "recent operator activity infers attended with no flag file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4674: stale activity older than the learned lease reads as away without the manual flag", () => {
  const root = tmpRoot();
  try {
    const t0 = Date.now();
    const iso = (msAgo: number) => new Date(t0 - msAgo).toISOString();
    // Two answered escalations establish a short learned lease (median reply latency ~4.5 min,
    // so the lease is 3x that, well under an hour).
    appendLedger(ledgerPath(root), { run_id: "W1-T4674-TEST", task_id: "W1-T1", step: "escalation.issue_opened", ts: iso(120 * 60 * 1000) });
    appendLedger(ledgerPath(root), { run_id: "W1-T4674-TEST", task_id: "W1-T1", step: "escalation.answered_by_link", ts: iso(115 * 60 * 1000) });
    appendLedger(ledgerPath(root), { run_id: "W1-T4674-TEST", task_id: "W1-T2", step: "escalation.issue_opened", ts: iso(90 * 60 * 1000) });
    appendLedger(ledgerPath(root), { run_id: "W1-T4674-TEST", task_id: "W1-T2", step: "panel.question_answered", ts: iso(86 * 60 * 1000) });
    // The newest activity of any kind is still that 86-minutes-ago answer — long past a lease
    // measured in minutes.
    assert.equal(presenceMode(root), "away", "activity far older than the learned lease infers away, no flag needed");

    // A single fresh console write (a "panel." write, no comment-style origin) brings it back.
    appendLedger(ledgerPath(root), { run_id: "W1-T4674-TEST", task_id: "W1-T3", step: "panel.escalation_replied" });
    assert.equal(presenceMode(root), "attended", "one fresh activity event restores attended immediately");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Acceptance claim 2 ────────────────────────────────────────────────────────────────────────

test("W1-T4674: the manual flag overrides the inferred state", () => {
  const root = tmpRoot();
  try {
    appendLedger(ledgerPath(root), { run_id: "W1-T4674-TEST", task_id: "W1-T1", step: "escalation.answered_by_link" });
    assert.equal(presenceMode(root), "attended", "sanity: recent activity infers attended before the flag is touched");
    setPresenceMode(root, "away");
    assert.equal(presenceMode(root), "away", "the manual AWAY flag overrides the inferred attended state");
    setPresenceMode(root, "attended");
    assert.equal(presenceMode(root), "attended", "clearing the flag falls back to inference, which still reads attended");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Acceptance claim 3 (grep-only, escalate.ts's call site) — exercised end-to-end above ────────

test("W1-T4674: a cold root with no activity history at all still infers attended (the safe default)", () => {
  const root = tmpRoot();
  try {
    assert.equal(presenceMode(root), "attended", "no activity ever recorded fails to attended, same as before this task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Unit coverage for presence.ts's pure helpers ────────────────────────────────────────────────

test("inferPresenceFromActivity: attended iff the newest event is within the lease of now", () => {
  const now = new Date("2026-09-29T12:00:00.000Z");
  const events: ActivityEvent[] = [{ source: "console_write", at: "2026-09-29T11:50:00.000Z" }];
  assert.equal(inferPresenceFromActivity(events, now, 15 * 60 * 1000), "attended");
  assert.equal(inferPresenceFromActivity(events, now, 5 * 60 * 1000), "away");
  assert.equal(inferPresenceFromActivity([], now, 15 * 60 * 1000), "attended", "no events ever recorded is the safe default");
});

test("learnLeaseMs: 3x the median reply latency, clamped to a sane floor and ceiling", () => {
  assert.equal(learnLeaseMs([]), COLD_START_LEASE_MS, "no history yet falls back to the cold-start lease");
  const tenMin = 10 * 60 * 1000;
  assert.equal(learnLeaseMs([tenMin, 2 * tenMin, 3 * tenMin]), 3 * (2 * tenMin), "3x the median of an odd-length sample");
  assert.equal(learnLeaseMs([1000]), 5 * 60 * 1000, "a freak near-instant reply is floored, never a near-zero lease");
  assert.equal(learnLeaseMs([100 * 60 * 60 * 1000]), 24 * 60 * 60 * 1000, "a freak day-long reply is capped, never an indefinite lease");
});

test("replyLatenciesMs: pairs an escalation's opened/answered ledger lines by task id", () => {
  const root = tmpRoot();
  try {
    const t0 = Date.now();
    const iso = (msAgo: number) => new Date(t0 - msAgo).toISOString();
    appendLedger(ledgerPath(root), { run_id: "W1-T4674-TEST", task_id: "W1-T1", step: "escalation.issue_opened", ts: iso(10 * 60 * 1000) });
    appendLedger(ledgerPath(root), { run_id: "W1-T4674-TEST", task_id: "W1-T1", step: "escalation.answered_by_link", ts: iso(7 * 60 * 1000) });
    // An opened escalation with no answer yet contributes nothing.
    appendLedger(ledgerPath(root), { run_id: "W1-T4674-TEST", task_id: "W1-T2", step: "escalation.issue_opened", ts: iso(2 * 60 * 1000) });
    const latencies = replyLatenciesMs(root);
    assert.deepEqual(latencies, [3 * 60 * 1000]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inferOperatorPresence: an injected operator-commit reader counts as activity too", () => {
  const root = tmpRoot();
  try {
    const now = new Date();
    assert.equal(
      inferOperatorPresence(root, now, { recentOperatorCommitsAt: () => [now.toISOString()] }),
      "attended",
      "a just-now operator commit is recent activity even with an otherwise-empty ledger",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
