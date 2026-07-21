import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDigest, collectSince, renderDigest, sendDigest, summarize } from "../src/lib/digest.js";
import type { NotifyChannel } from "../src/lib/notify.js";

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-digest-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function fakeChannel(): NotifyChannel & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: (m) => sent.push(m) };
}

const LINES = [
  { ts: "2026-07-13T00:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged", cost_usd: 1.5 },
  { ts: "2026-07-14T09:00:00.000Z", step: "verdict", task_id: "W1-T7", verdict: "merged", cost_usd: 2.25 },
  {
    ts: "2026-07-14T10:00:00.000Z",
    step: "verdict",
    task_id: "W1-T3",
    verdict: "blocked_ci",
    pr_url: "https://github.com/craigoley/remudero/pull/22",
    cost_usd: 0.75,
  },
  {
    ts: "2026-07-14T10:05:00.000Z",
    step: "escalation.issue_opened",
    task_id: "W1-T3",
    class: "BLOCKED",
    issue_url: "https://github.com/craigoley/remudero/issues/5",
  },
];

test("collectSince keeps only lines at/after the marker", () => {
  const kept = collectSince(LINES, "2026-07-14T00:00:00.000Z");
  assert.equal(kept.length, 3);
  assert.ok(kept.every((l) => (l.ts as string) >= "2026-07-14T00:00:00.000Z"));
});

test("summarize buckets merged/blocked/escalations and sums notional cost, ignoring stale lines", () => {
  const s = summarize(LINES, "2026-07-14T00:00:00.000Z");
  assert.deepEqual(s.merged, ["W1-T7"]);
  assert.deepEqual(s.blocked, [{ taskId: "W1-T3", verdict: "blocked_ci", prUrl: "https://github.com/craigoley/remudero/pull/22" }]);
  assert.deepEqual(s.escalations, [{ taskId: "W1-T3", class: "BLOCKED", issueUrl: "https://github.com/craigoley/remudero/issues/5" }]);
  // 2.25 + 0.75, NOT the stale 1.5 from the prior day.
  assert.equal(s.costUsd, 3.0);
});

test("buildDigest reads the ledger file and renders merged/blocked/escalations/cost", () => {
  const path = ledgerFile(LINES);
  const text = buildDigest(path, "2026-07-14T00:00:00.000Z");
  assert.match(text, /merged: W1-T7/);
  assert.match(text, /blocked: W1-T3 \(blocked_ci/);
  assert.match(text, /escalations: \[BLOCKED\] W1-T3/);
  assert.match(text, /notional cost: \$3\.00/);
});

test("W1-T178: review.downgrade_suppressed lines are counted and surfaced in the rendered digest", () => {
  const lines = [
    ...LINES,
    {
      ts: "2026-07-14T10:10:00.000Z",
      step: "review.downgrade_suppressed",
      task_id: "W1-T3",
      head_sha: "1fbea36",
      predecessor_state: "success",
      suppressed_state: "failure",
      floor_state: "success",
    },
  ];
  const s = summarize(lines, "2026-07-14T00:00:00.000Z");
  assert.equal(s.verdictDowngradesSuppressed, 1);
  const path = ledgerFile(lines);
  const text = buildDigest(path, "2026-07-14T00:00:00.000Z");
  assert.match(text, /verdict downgrades suppressed: 1/);
});

test("an empty window renders (none) rather than blank sections", () => {
  const path = ledgerFile(LINES);
  const text = buildDigest(path, "2027-01-01T00:00:00.000Z");
  assert.match(text, /merged: \(none\)/);
  assert.match(text, /blocked: \(none\)/);
  assert.match(text, /escalations: \(none\)/);
});

// ── W1-T112: the inbox's ready count is SOFT-COMPOSED into the digest ─────────────────────

test("summarize: an inbox.polled line inside the window folds its InboxPollSummary in, latest wins", () => {
  const lines = [
    ...LINES,
    { ts: "2026-07-14T09:30:00.000Z", step: "inbox.polled", inbox: { ready: 1 } },
    { ts: "2026-07-14T11:00:00.000Z", step: "inbox.polled", inbox: { ready: 4 } },
  ];
  const s = summarize(lines, "2026-07-14T00:00:00.000Z");
  assert.deepEqual(s.inbox, { ready: 4 });
});

test("summarize: no inbox.polled line inside the window leaves `inbox` undefined", () => {
  const s = summarize(LINES, "2026-07-14T00:00:00.000Z");
  assert.equal(s.inbox, undefined);
});

test("renderDigest: an inbox summary present renders 'inbox: N ready'", () => {
  const lines = [...LINES, { ts: "2026-07-14T09:30:00.000Z", step: "inbox.polled", inbox: { ready: 2 } }];
  const path = ledgerFile(lines);
  const text = buildDigest(path, "2026-07-14T00:00:00.000Z");
  assert.match(text, /inbox: 2 ready/);
});

test("renderDigest: with no inbox.polled line, the digest renders BYTE-IDENTICAL to before this field existed (no inbox line at all)", () => {
  const withoutInbox = buildDigest(ledgerFile(LINES), "2026-07-14T00:00:00.000Z");
  assert.doesNotMatch(withoutInbox, /inbox:/);
  const rebuilt = renderDigest(summarize(LINES, "2026-07-14T00:00:00.000Z"));
  assert.equal(withoutInbox, rebuilt);
});

test("renderDigest: GOLDEN full-text render with `inbox` absent — the exact pre-W1-T112 shape, byte for byte", () => {
  const s = summarize(LINES, "2026-07-14T00:00:00.000Z");
  assert.equal(s.inbox, undefined, "precondition: no inbox.polled line in this fixture's window");
  const text = renderDigest(s);
  assert.equal(
    text,
    [
      "Remudero daily digest — since 2026-07-14T00:00:00.000Z",
      "merged: W1-T7",
      "blocked: W1-T3 (blocked_ci — https://github.com/craigoley/remudero/pull/22)",
      "escalations: [BLOCKED] W1-T3 — https://github.com/craigoley/remudero/issues/5",
      "alerts: (no poll this window)",
      "issues reviewed: (no poll this window)",
      "verdict downgrades suppressed: 0",
      "notional cost: $3.00",
    ].join("\n"),
  );
});

test("renderDigest: GOLDEN full-text render with `inbox` present — the SAME lines plus exactly one 'inbox: N ready' line, in place", () => {
  const s = summarize(LINES, "2026-07-14T00:00:00.000Z");
  const withInbox = { ...s, inbox: { ready: 2 } };
  const text = renderDigest(withInbox);
  assert.equal(
    text,
    [
      "Remudero daily digest — since 2026-07-14T00:00:00.000Z",
      "merged: W1-T7",
      "blocked: W1-T3 (blocked_ci — https://github.com/craigoley/remudero/pull/22)",
      "escalations: [BLOCKED] W1-T3 — https://github.com/craigoley/remudero/issues/5",
      "alerts: (no poll this window)",
      "issues reviewed: (no poll this window)",
      "inbox: 2 ready",
      "verdict downgrades suppressed: 0",
      "notional cost: $3.00",
    ].join("\n"),
  );
});

// ── W1-T112 review-gate proof, restated as ONE combined fixture (round-2 fix): "digest render
// with an inbox summary present includes 'inbox: N ready'; with the inbox module absent renders
// byte-identical to today" — both halves of that sentence asserted together here, in addition to
// the more granular/golden tests above. ───────────────────────────────────────────────────────

test("digest render with an inbox summary present includes 'inbox: N ready'; with the inbox module absent renders byte-identical to today", () => {
  const s = summarize(LINES, "2026-07-14T00:00:00.000Z");

  // "today" = the digest as it renders with no inbox.polled snapshot in the window at all —
  // `inbox` is `undefined` on the summary, exactly as every digest rendered before this feature.
  assert.equal(s.inbox, undefined, "precondition: the inbox module never polled inside this window");
  const today = renderDigest(s);
  assert.doesNotMatch(today, /inbox:/, "no inbox line at all when the module is absent from the window");

  // Re-rendering the SAME summary, unchanged, is byte-identical — the absent-inbox render is
  // deterministic and stable, not just "no inbox substring" by accident.
  assert.equal(renderDigest(summarize(LINES, "2026-07-14T00:00:00.000Z")), today);

  // Now with an inbox summary present: the SAME lines, plus exactly one 'inbox: N ready' line.
  const withInbox = renderDigest({ ...s, inbox: { ready: 5 } });
  assert.match(withInbox, /inbox: 5 ready/);
  assert.equal(withInbox, today.replace("issues reviewed: (no poll this window)", "issues reviewed: (no poll this window)\ninbox: 5 ready"));
});

test("sendDigest delivers the built text over the notify channel and ledgers it", () => {
  const path = ledgerFile(LINES);
  const channel = fakeChannel();
  const text = sendDigest(path, "2026-07-14T00:00:00.000Z", { channel, ledgerPath: path, runId: "DIGEST-1", taskId: "DIGEST" });
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0], text);
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.step === "notify.sent"));
});
