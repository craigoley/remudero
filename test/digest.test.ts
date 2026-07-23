import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildDigest,
  buildMarkerAwareDigest,
  collectSince,
  consoleCardUrl,
  defaultDigestSinceIso,
  renderDigest,
  renderRundownPush,
  resolveMarkerAwareSince,
  sendDigest,
  sendMarkerAwareDigest,
  sendRundown,
  summarize,
} from "../src/lib/digest.js";
import type { RundownLine } from "../src/lib/drain.js";
import type { NotifyChannel } from "../src/lib/notify.js";
import { escalate, type Escalation, type IssueGateway } from "../src/lib/escalate.js";
import { createLastSeenStore } from "../src/lib/last-seen.js";
import { buildRecapEvents } from "../src/lib/recap.js";
import type { Plan, Task } from "../src/lib/plan.js";

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

// ── W1-T144: console push — deep links + the drain-rundown push ──────────────────────────────

test("consoleCardUrl: a HASH route naming exactly the given task id, tolerating a trailing slash on the base", () => {
  assert.equal(consoleCardUrl("http://100.64.1.2:4317", "W1-T3"), "http://100.64.1.2:4317/#task=W1-T3");
  assert.equal(consoleCardUrl("http://100.64.1.2:4317/", "W1-T3"), "http://100.64.1.2:4317/#task=W1-T3");
});

test("consoleCardUrl: percent-encodes the task id so a link for task X can never collide with another id", () => {
  assert.equal(consoleCardUrl("http://localhost:4317", "W1/T3"), "http://localhost:4317/#task=W1%2FT3");
});

test("consoleCardUrl (falsifier): links for two different task ids are never equal, and each names ONLY its own id", () => {
  const a = consoleCardUrl("http://localhost:4317", "W1-T3");
  const b = consoleCardUrl("http://localhost:4317", "W1-T9");
  assert.notEqual(a, b);
  assert.match(a, /task=W1-T3$/);
  assert.doesNotMatch(a, /W1-T9/);
});

test("renderDigest: with no consoleBaseUrl, the escalations line renders EXACTLY as before W1-T144 (no link appended)", () => {
  const s = summarize(LINES, "2026-07-14T00:00:00.000Z");
  const text = renderDigest(s);
  assert.match(text, /escalations: \[BLOCKED\] W1-T3 — https:\/\/github\.com\/craigoley\/remudero\/issues\/5$/m);
});

test("renderDigest: a consoleBaseUrl appends that task's console deep link to its escalation line", () => {
  const s = summarize(LINES, "2026-07-14T00:00:00.000Z");
  const text = renderDigest(s, "http://100.64.1.2:4317");
  assert.match(
    text,
    /escalations: \[BLOCKED\] W1-T3 — https:\/\/github\.com\/craigoley\/remudero\/issues\/5 — http:\/\/100\.64\.1\.2:4317\/#task=W1-T3/,
  );
});

test("buildDigest/sendDigest: consoleBaseUrl threads through to the delivered text", () => {
  const path = ledgerFile(LINES);
  const viaBuild = buildDigest(path, "2026-07-14T00:00:00.000Z", "http://100.64.1.2:4317");
  assert.match(viaBuild, /#task=W1-T3/);

  const channel = fakeChannel();
  const sent = sendDigest(path, "2026-07-14T00:00:00.000Z", { channel, ledgerPath: path, runId: "D-1", taskId: "DIGEST" }, "http://100.64.1.2:4317");
  assert.equal(channel.sent[0], sent);
  assert.match(sent, /#task=W1-T3/);
});

const RUNDOWN_LINES: RundownLine[] = [
  { taskId: "W1-T1", outcome: "merged" },
  { taskId: "W1-T2", outcome: "blocked", detail: "W1-T2 → blocked_ci" },
  { taskId: "W1-T3", outcome: "escalated", escalation: { issueUrl: "https://github.com/craigoley/remudero/issues/5", class: "BLOCKED" } },
];

test("renderRundownPush: merged stays a bare confirmation; blocked/escalated each carry the console deep link for THEIR OWN task", () => {
  const text = renderRundownPush(RUNDOWN_LINES, "http://100.64.1.2:4317");
  assert.match(text, /merged     : W1-T1$/m);
  assert.doesNotMatch(text.split("\n").find((l) => l.includes("W1-T1")) ?? "", /#task=/);
  assert.match(text, /blocked    : W1-T2 — W1-T2 → blocked_ci — http:\/\/100\.64\.1\.2:4317\/#task=W1-T2/);
  assert.match(
    text,
    /escalated  : W1-T3 — \[BLOCKED\] https:\/\/github\.com\/craigoley\/remudero\/issues\/5 — http:\/\/100\.64\.1\.2:4317\/#task=W1-T3/,
  );
});

test("renderRundownPush: nothing attempted renders the same empty state as the pull-view renderRundown", () => {
  assert.match(renderRundownPush([], "http://localhost:4317"), /\(no tasks attempted\)/);
});

test("sendRundown: delivers over the SAME notify() emit path as sendDigest — one code path, not a second transport", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-digest-rundown-"));
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, "");
  const channel = fakeChannel();
  const text = sendRundown(RUNDOWN_LINES, "http://100.64.1.2:4317", { channel, ledgerPath: path, runId: "DRAIN-1", taskId: "DRAIN" });
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0], text);
  assert.match(text, /#task=W1-T2/);
  assert.match(text, /#task=W1-T3/);
  // notify() itself ledgers `notify.sent` — the same trace a digest send leaves — proving
  // this went through the identical emit path, not a bespoke sender.
  const ledgerLines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(ledgerLines.some((l) => l.step === "notify.sent" && l.task_id === "DRAIN"));
});

// ── W1-T144 acceptance (round-1 fix): "an escalation created with NO console open reaches the
// operator's channel within one digest cycle" — an INTEGRATION test wired end-to-end through
// escalate() (lib/escalate.ts, a fake IssueGateway standing in for GitHub — the escalation
// never opens or touches any console/browser session) and sendDigest (lib/digest.ts) over an
// INJECTED digest/channel sink (fakeChannel's `.sent` array). The sink is GROUND TRUTH: every
// assertion below reads the ACTUAL message text the channel received, never a boolean/log-line
// "it was sent" flag — the companion falsifier proves a claim of reaching the operator that
// isn't backed by a real ledgered escalation never shows up in that sink. ─────────────────────

test("INTEGRATION: escalate() a needs-human with NO live console reaches the operator's channel within ONE digest cycle, over an injected sink naming the task + reason", () => {
  const path = ledgerFile([]); // fresh ledger — no console session ever opened against it
  const issues: IssueGateway = { create: () => "https://github.com/craigoley/remudero/issues/42" };
  const escalation: Escalation = {
    class: "BLOCKED",
    taskId: "W1-T99",
    summary: "two strikes exhausted on CI",
    detail: "the diagnose-armed retry still failed CI — needs a human call.",
    options: [{ label: "retry", detail: "resume with a fresh worker" }],
    recommendation: "retry",
  };
  // escalate() itself: opens the needs-human issue against the fake gateway + ledgers it.
  // No console is open anywhere in this call — it touches only the gateway and the ledger file.
  const issueUrl = escalate(escalation, { issues, ledgerPath: path, runId: "ESCALATE-1" });

  // The NEXT digest cycle: sendDigest re-reads the SAME ledger and delivers over an INJECTED
  // NotifyChannel sink — never Messages.app/osascript inside a test.
  const sink = fakeChannel();
  const sinceIso = "2020-01-01T00:00:00.000Z"; // window opens well before the escalation
  const delivered = sendDigest(path, sinceIso, { channel: sink, ledgerPath: path, runId: "DIGEST-1", taskId: "DIGEST" });

  // GROUND TRUTH: the sink actually received exactly one message, and that message NAMES the
  // task and the reason it needed a human — reading the real array content, not a flag.
  assert.equal(sink.sent.length, 1, "the sink must have actually received a send, not merely a log line claiming it did");
  assert.equal(sink.sent[0], delivered);
  assert.match(sink.sent[0], /W1-T99/, "the pushed message must name the escalated task");
  assert.match(sink.sent[0], /BLOCKED/, "the pushed message must name the escalation class/reason");
  assert.ok(sink.sent[0].includes(issueUrl), "the pushed message must carry the escalation's own issue link");
});

test("INTEGRATION falsifier: a task NEVER actually escalated never appears in the sink — a fabricated 'reached' with no real send FAILS this exact assertion", () => {
  const path = ledgerFile([]); // nothing escalated, nothing sent — there is no real event to fake
  const sink = fakeChannel();
  sendDigest(path, "2020-01-01T00:00:00.000Z", { channel: sink, ledgerPath: path, runId: "DIGEST-2", taskId: "DIGEST" });
  assert.equal(sink.sent.length, 1); // a digest cycle still fires once, even with nothing to report
  // The sink is ground truth, not a log line: it can only ever contain what notify() actually
  // sent, so a task that was never escalated can never fraudulently show up as "reached".
  assert.doesNotMatch(sink.sent[0], /W1-T99/, "a task that was never escalated must never appear as though it reached the operator");
});

// ── W1-T163: the digest becomes MARKER-AWARE, sharing lib/last-seen.ts's per-token marker with
// the console recap (lib/recap.ts) — "push and pull tell ONE story." ─────────────────────────

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function lastSeenTmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-digest-marker-"));
  return join(dir, "last-seen.json");
}

test("defaultDigestSinceIso: exactly 24h before the given nowIso — the pre-marker fallback, unchanged", () => {
  assert.equal(defaultDigestSinceIso("2026-07-21T12:00:00.000Z"), "2026-07-20T12:00:00.000Z");
});

test("resolveMarkerAwareSince: a never-seen token falls back to the 24h default; a seen token uses ITS marker", () => {
  const store = createLastSeenStore(lastSeenTmpPath());
  const nowIso = "2026-07-21T12:00:00.000Z";
  assert.equal(resolveMarkerAwareSince(store, "tok-a", nowIso), defaultDigestSinceIso(nowIso));

  store.advance("tok-a", "2026-07-21T09:00:00.000Z");
  assert.equal(resolveMarkerAwareSince(store, "tok-a", nowIso), "2026-07-21T09:00:00.000Z");
});

test(
  "W1-T163 acceptance: a digest and a console recap built from the SAME per-token marker over the SAME ledger cover the IDENTICAL event set — a digest computed off a different/stale window would disagree",
  () => {
    const plan = planOf([task({ id: "W1-T1", title: "one" }), task({ id: "W1-T2", title: "two" })]);
    const marker = "2026-07-20T00:00:00.000Z";
    const lines = [
      { ts: "2026-07-19T00:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged" }, // BEFORE the marker
      { ts: "2026-07-20T01:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged" },
      { ts: "2026-07-20T02:00:00.000Z", step: "verdict", task_id: "W1-T2", verdict: "blocked_ci" },
      {
        ts: "2026-07-20T03:00:00.000Z",
        step: "escalation.issue_opened",
        task_id: "W1-T2",
        class: "BLOCKED",
        issue_url: "https://github.com/craigoley/remudero/issues/9",
      },
    ];
    const path = ledgerFile(lines);

    const store = createLastSeenStore(lastSeenTmpPath());
    const tokenId = "operator-token";
    store.advance(tokenId, marker); // the console already advanced this token's marker to `marker`

    // The PULL: the console recap, off the SAME marker.
    const recapEvents = buildRecapEvents(lines, resolveMarkerAwareSince(store, tokenId, "irrelevant-if-marker-present"), plan);

    // The PUSH: a marker-aware digest for the SAME token, over the SAME ledger.
    const digestSince = resolveMarkerAwareSince(store, tokenId, "irrelevant-if-marker-present");
    const digestSummary = summarize(readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)), digestSince);

    // Same window: the digest's own sinceIso is literally the recap's marker.
    assert.equal(digestSince, marker);

    // Same event set: every merged/blocked/escalated task the recap saw, the digest saw too --
    // and NEITHER saw the before-marker W1-T1 merge.
    assert.deepEqual(
      recapEvents.filter((e) => e.kind === "merged").map((e) => e.taskId),
      digestSummary.merged,
    );
    assert.deepEqual(
      recapEvents.filter((e) => e.kind === "blocked").map((e) => e.taskId),
      digestSummary.blocked.map((b) => b.taskId),
    );
    assert.deepEqual(
      recapEvents.filter((e) => e.kind === "escalated").map((e) => e.taskId),
      digestSummary.escalations.map((e) => e.taskId),
    );
  },
);

test("sendMarkerAwareDigest: sends off the token's CURRENT marker (or the 24h default on a first-ever send), then ADVANCES that marker to nowIso", () => {
  const lines = [{ ts: "2026-07-14T09:00:00.000Z", step: "verdict", task_id: "W1-T7", verdict: "merged" }];
  const path = ledgerFile(lines);
  const store = createLastSeenStore(lastSeenTmpPath());
  const channel = fakeChannel();
  const nowIso = "2026-07-14T10:00:00.000Z";

  const text = sendMarkerAwareDigest(path, store, "tok-a", { channel, ledgerPath: path, runId: "DIGEST-1", taskId: "DIGEST" }, nowIso);
  assert.equal(channel.sent[0], text);
  assert.match(text, /merged: W1-T7/); // first-ever send used the 24h-ago default, which covers this line

  assert.equal(store.get("tok-a"), nowIso, "sending must advance THIS token's marker to nowIso");

  // A SECOND send, right after, with no new activity: the marker now excludes the line above.
  const secondNow = "2026-07-14T11:00:00.000Z";
  const secondText = sendMarkerAwareDigest(path, store, "tok-a", { channel, ledgerPath: path, runId: "DIGEST-2", taskId: "DIGEST" }, secondNow);
  assert.match(secondText, /merged: \(none\)/, "the second send's window opens at the first send's nowIso, which is after the only merge");
});

test("buildMarkerAwareDigest: a read-only preview — resolves the SAME sinceIso sendMarkerAwareDigest would, but never advances the marker", () => {
  const lines = [{ ts: "2026-07-14T09:00:00.000Z", step: "verdict", task_id: "W1-T7", verdict: "merged" }];
  const path = ledgerFile(lines);
  const store = createLastSeenStore(lastSeenTmpPath());
  const nowIso = "2026-07-14T10:00:00.000Z";

  const preview = buildMarkerAwareDigest(path, store, "tok-a", nowIso);
  assert.match(preview.text, /merged: W1-T7/);
  assert.equal(preview.sinceIso, defaultDigestSinceIso(nowIso));
  assert.equal(store.get("tok-a"), undefined, "a dry-run preview must never mutate the marker");

  // Rebuilding the preview again is byte-identical -- proving nothing was consumed/advanced.
  const again = buildMarkerAwareDigest(path, store, "tok-a", nowIso);
  assert.equal(again.text, preview.text);
});
