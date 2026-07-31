import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeRecentActivity, createRecentActivityCache, type BoardDeps } from "../src/lib/board.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { renderShellHtml } from "../src/lib/serve.js";
import type { GitHub, PrRef } from "../src/lib/status.js";

/**
 * THE INCIDENT THIS FILE EXISTS FOR, 2026-07-31.
 *
 * The operator clicked Run on W1-T152 — a task he had credited as merged an hour earlier, and
 * which the console still showed as queued because the GraphQL budget was exhausted and
 * merged-ness had become underivable. The pipeline worked perfectly: the marker was written, the
 * daemon consumed it inside a minute, and refused it correctly. The refusal is in the ledger,
 * verbatim:
 *
 *   {"ts":"2026-07-31T11:18:10.571Z","run_id":"DAEMON-1785471859126","task_id":"DAEMON",
 *    "step":"console.kick_refused","task":"W1-T152","origin":"b72da2b71047",
 *    "reason":"already merged — stale kick"}
 *
 * He saw NOTHING — no error, no entry, no explanation — and reported the console as broken.
 * `POST /v1/drain/kick` returns 200 for "marker dropped", so the HTTP layer cannot carry this: the
 * POST genuinely succeeded and only the asynchronous refusal held the information. The activity
 * feed is the only surface that can show it, and `computeRecentActivity` dropped the line because
 * the daemon stamps its own pseudo-id (`task_id: "DAEMON"`) on everything it emits.
 *
 * TWO FILTERS had to be crossed, not one — the second is easy to miss:
 *   1. the `!task` guard, which drops every pseudo-id line; and
 *   2. `classifyLine`'s `default: return undefined`, which is ALREADY a step allowlist.
 * Removing (1) alone would have changed nothing, because (2) would still have dropped the step.
 *
 * THE NOISE LOCK is as important as the fix. Measured over the ledger unioned across all 661
 * rotations — 4,156,857 lines spanning 411 hours — SWEEP emits 1,461 lines/hour, DAEMON 413/hour
 * and SERVE 228/hour, and 71% of DAEMON's own traffic is `dispatch.indeterminate`. Against that,
 * `console.kick_refused` occurs FOUR times in the entire history. The allowlist is what keeps the
 * ratio that way, and the tests below assert both halves.
 */

function task(over: Partial<Task> = {}): Task {
  return { id: "W1-TX", title: "t", repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0, ...over };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function fakeGitHub(byRef: Record<string, PrRef> = {}): GitHub {
  return { prByRef: (ref) => byRef[String(ref)] ?? null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
}

function tmpLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-refusals-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

/** Append NDJSON lines and project the feed, exactly as `GET /v1/recent` does. */
function feedOf(plan: Plan, lines: Array<Record<string, unknown>>) {
  const ledgerPath = tmpLedgerPath();
  appendFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub() };
  return computeRecentActivity(deps, createRecentActivityCache());
}

/** The REAL line, byte-for-byte off the live ledger (state/ledger.ndjson, 2026-07-31). */
const LIVE_REFUSAL = {
  ts: "2026-07-31T11:18:10.571Z",
  run_id: "DAEMON-1785471859126",
  task_id: "DAEMON",
  step: "console.kick_refused",
  task: "W1-T152",
  origin: "b72da2b71047",
  reason: "already merged — stale kick",
};

// ── VALIDATION 5: the refusal appears, and says something a human can act on ──────────────────

test("a DAEMON-attributed refusal of an operator Run appears in the feed, naming the task the operator clicked", () => {
  const plan = planOf([task({ id: "W1-T152", title: "keep rmd serve alive across reboots" })]);

  const feed = feedOf(plan, [LIVE_REFUSAL]);

  assert.equal(feed.length, 1, "the refusal is projected — before W1-T266 this was 0");
  assert.equal(feed[0].verb, "run-refused");
  // The id comes from `line.task`, NOT `line.task_id`: the daemon owns task_id and stamps its own
  // pseudo-id there. A row reading "DAEMON" would name the lane instead of the operator's task.
  assert.equal(feed[0].taskId, "W1-T152");
  assert.equal(feed[0].title, "keep rmd serve alive across reboots", "the plan title, so the row says WHAT was refused");
  assert.equal(feed[0].detail, "already merged — stale kick", "the daemon's own reason, verbatim");
  assert.equal(feed[0].ts, "2026-07-31T11:18:10.571Z");
});

test("the rendered row reads as a reply to the operator: the client labels run-refused as Run refused", () => {
  const shell = renderShellHtml();

  // The projection above supplies verb + detail + title; these two maps are what turn them into
  // the sentence on screen. Asserted here rather than assumed because the verb is a NEW member of
  // a closed union and the client's lookups both fall back silently (`?? e.verb`, `?? "queued"`),
  // so a missing entry would render a raw slug and no test would notice.
  assert.match(shell, /"run-refused": "Run refused"/, "verb label");
  assert.match(shell, /"run-refused": "blocked"/, "badge key — a refused Run reuses the blocked dot");
  assert.match(shell, /"run-started": "Run started"/);
  assert.match(shell, /"run-started": "running"/);
});

test("a refusal naming a task that is not in the plan still renders, falling back to the bare id", () => {
  // `refuse("unknown task id")` fires for exactly this case, and it is the one refusal where the
  // task genuinely cannot be looked up — dropping it would re-create the silence for the operator
  // most likely to be confused.
  const feed = feedOf(planOf([task({ id: "W1-T1" })]), [{ ...LIVE_REFUSAL, task: "W1-T999", reason: "unknown task id" }]);

  assert.equal(feed.length, 1);
  assert.equal(feed[0].taskId, "W1-T999");
  assert.equal(feed[0].title, "W1-T999", "no plan task ⇒ the id itself is the title, never an empty cell");
  assert.equal(feed[0].detail, "unknown task id");
});

test("a successful console Run also resolves, so an absent row never has to be interpreted", () => {
  const plan = planOf([task({ id: "W1-T152", title: "keep rmd serve alive across reboots" })]);

  const feed = feedOf(plan, [{ ...LIVE_REFUSAL, step: "console.kick_dispatched", reason: undefined }]);

  assert.equal(feed[0].verb, "run-started");
  assert.equal(feed[0].taskId, "W1-T152");
  assert.equal(feed[0].detail, "dispatched from the console");
});

// ── THE LENGTH BOUND — a real 4KB reason exists in the live ledger ────────────────────────────

test("a refusal reason is bounded at 120 characters with a visible ellipsis, so one row cannot swallow the feed", () => {
  // Not hypothetical: `assertRunnable` echoes a blocked task's whole note, and the live ledger's
  // W1-T201 refusal at 2026-07-31T11:31:40.551Z carries ~4,000 characters of FILED diagnosis.
  const huge = `task W1-T201 is blocked: ${"x".repeat(4000)}`;
  const feed = feedOf(planOf([task({ id: "W1-T201", title: "retro trigger" })]), [{ ...LIVE_REFUSAL, task: "W1-T201", reason: huge }]);

  const detail = feed[0].detail ?? "";
  assert.equal(detail.length, 121, "120 characters plus the ellipsis");
  assert.ok(detail.endsWith("…"), "truncation is VISIBLE — a cut reason must not read as a short one");
  assert.ok(detail.startsWith("task W1-T201 is blocked: "), "the informative head survives");
  // A short reason is untouched — the bound must not mangle the common case.
  const short = feedOf(planOf([task({ id: "W1-T152" })]), [LIVE_REFUSAL]);
  assert.equal(short[0].detail, "already merged — stale kick");
  assert.ok(!(short[0].detail ?? "").endsWith("…"));
});

test("a refusal carrying no reason at all still says so, rather than rendering an empty parenthesis", () => {
  const feed = feedOf(planOf([task({ id: "W1-T152" })]), [{ ...LIVE_REFUSAL, reason: undefined }]);
  assert.equal(feed[0].detail, "no reason recorded");
});

// ── VALIDATION 6: THE NOISE LOCK ──────────────────────────────────────────────────────────────

test("NOISE LOCK: the high-frequency daemon and sweep lanes still produce ZERO feed rows", () => {
  const plan = planOf([task({ id: "W1-T152", title: "keep rmd serve alive across reboots" })]);
  // Every step below is real, and these are the volumes measured over the unioned ledger
  // (4,156,857 lines / 411 hours). If the pseudo-id guard were removed rather than narrowed to an
  // allowlist, THIS is what the operator's feed would fill with.
  const noise = [
    { ts: "2026-07-31T11:00:00Z", task_id: "DAEMON", step: "board_gateway.fetch_ok", prCount: 687 },
    { ts: "2026-07-31T11:00:01Z", task_id: "DAEMON", step: "board_gateway.fetch_bytes", bytes: 2888862 },
    { ts: "2026-07-31T11:00:02Z", task_id: "DAEMON", step: "board_gateway.issue_fetch_ok", issueCount: 79 },
    { ts: "2026-07-31T11:00:03Z", task_id: "DAEMON", step: "dispatch.indeterminate", task: "W1-T5" },
    { ts: "2026-07-31T11:00:04Z", task_id: "DAEMON", step: "daemon.idle" },
    { ts: "2026-07-31T11:00:05Z", task_id: "DAEMON", step: "daemon.headroom", enforced: false },
    { ts: "2026-07-31T11:00:06Z", task_id: "SWEEP", step: "sweep.dispose", pr: 1005 },
    { ts: "2026-07-31T11:00:07Z", task_id: "SWEEP", step: "sweep.summary", disposed: 3 },
    { ts: "2026-07-31T11:00:08Z", task_id: "SERVE", step: "serve.request", path: "/v1/status" },
    { ts: "2026-07-31T11:00:09Z", task_id: "RETRO", step: "retro.gather" },
  ];

  assert.deepEqual(feedOf(plan, noise), [], "not one of these ten reaches the feed");

  // And the refusal still gets through the SAME scan that rejected all ten.
  const mixed = feedOf(plan, [...noise, LIVE_REFUSAL, ...noise]);
  assert.equal(mixed.length, 1, "twenty noise lines around it change nothing");
  assert.equal(mixed[0].verb, "run-refused");
});

test("NOISE LOCK: the allowlist is exactly two steps — no other console step leaks in", () => {
  const plan = planOf([task({ id: "W1-T152" })]);
  // `console.kick_requested` is deliberately NOT surfaced: the button's own arm-then-confirm state
  // already shows the operator their click. Echoing the request adds a row without adding
  // information, and the thing that was missing was always the RESOLUTION.
  const others = [
    { ts: "2026-07-31T11:00:00Z", task_id: "W1-T152", step: "console.kick_requested", armed: true },
    { ts: "2026-07-31T11:00:01Z", task_id: "PANEL", step: "console.drain_requested", armed: true },
    { ts: "2026-07-31T11:00:02Z", task_id: "DAEMON", step: "console.drain_consumed", origin: "x" },
  ];
  assert.deepEqual(feedOf(plan, others), []);
});

// ── VALIDATION 7: THE LIVE INCIDENT, REPLAYED ─────────────────────────────────────────────────

test("REPLAY: the real 11:18:10.571Z W1-T152 refusal now projects into the feed the operator was watching", () => {
  const plan = planOf([task({ id: "W1-T152", title: "keep rmd serve alive across reboots" })]);
  // The exact sequence of that morning: the console kick, then the daemon's refusal 12s later,
  // embedded in the daemon chatter that was running the whole time.
  const feed = feedOf(plan, [
    { ts: "2026-07-31T11:17:58.875Z", task_id: "W1-T152", step: "console.kick_requested", armed: true },
    { ts: "2026-07-31T11:18:00.000Z", task_id: "DAEMON", step: "dispatch.indeterminate", task: "W1-T152" },
    { ts: "2026-07-31T11:18:05.000Z", task_id: "DAEMON", step: "board_gateway.fetch_ok", prCount: 687 },
    LIVE_REFUSAL,
  ]);

  assert.equal(feed.length, 1, "one row, from four ledger lines");
  const row = feed[0];
  // This is the sentence, in the order recentRowHtml assembles it:
  //   [blocked dot] W1-T152  Run refused (already merged — stale kick) — keep rmd serve alive… · 3h ago
  assert.equal(row.verb, "run-refused");
  assert.equal(row.taskId, "W1-T152");
  assert.equal(row.detail, "already merged — stale kick");
  assert.equal(row.title, "keep rmd serve alive across reboots");
  assert.equal(row.ts, "2026-07-31T11:18:10.571Z");
});
