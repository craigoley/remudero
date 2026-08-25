import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeBoardSnapshot, deriveReviewState, type BoardDeps } from "../src/lib/board.js";
import { buildBatchedGithub, type GitHub, type PrRef } from "../src/lib/status.js";
import type { Plan, Task } from "../src/lib/plan.js";

// ── W1-T2235 ─────────────────────────────────────────────────────────────────────────────────
//
// SOURCE-VERIFIED AT FILING: `GitHub.reviewState` (status.ts) computed `terminal =
// entry.state !== "OPEN"` but consulted it ONLY as a modifier on a `reviewStateCache` HIT — a
// terminal row with no cache entry (every terminal row, on the very first paint that ever asks
// about it) fell straight through to a network call keyed on `entry.headRefName`, a BRANCH NAME
// GitHub deletes the moment the PR merges. That call 404s; the `catch` returns `undefined` and
// caches nothing; so the SAME row re-fails on every single paint, forever. `board.ts`'s
// `deriveReviewState` then turned that per-row failure into `"none"` (a determinate "no review
// posted" verdict) whenever the broader PR-list fetch had itself succeeded — a 404 laundered
// into a verdict, at scale (733 of 2206 rows, operator-measured).
//
// This suite proves the fix: a terminal row's `.state` is checked BEFORE any cache lookup and
// BEFORE any network call, returns `"not-applicable"` directly, and never issues the combined-
// status REST call at all — while an OPEN row's review state is untouched: still fetched, still
// expires every `ttlMs`, and a genuine read failure on an OPEN row still renders `"unreadable"`,
// never `"none"`.

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued", // decorative — never trusted
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function tmpLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-terminal-review-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

function prOpenedLine(taskId: string, prUrl: string): string {
  return JSON.stringify({ ts: "2026-08-17T10:00:00.000Z", task_id: taskId, step: "pr.opened", pr_url: prUrl }) + "\n";
}

/** Minimal REQUIRED-method GitHub fixture (the four non-optional methods), extended per test. */
function fakeGitHub(over: Partial<GitHub> = {}, byRef: Record<string, PrRef> = {}): GitHub {
  return {
    prByRef: (ref) => byRef[String(ref)] ?? null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    ...over,
  };
}

// ── DATA LAYER: board.ts renders "not-applicable", never "none", for a terminal row ────────

test("W1-T2235: a MERGED row renders 'not-applicable', never 'none' — deriveReviewState and computeBoardSnapshot agree", () => {
  const github = fakeGitHub({ reviewState: () => "not-applicable" });
  assert.equal(deriveReviewState("https://github.com/o/r/pull/1", github), "not-applicable");
  assert.notEqual(deriveReviewState("https://github.com/o/r/pull/1", github), "none");

  const ledgerPath = tmpLedgerPath();
  appendFileSync(ledgerPath, prOpenedLine("A", "https://github.com/o/r/pull/1"));
  const byRef: Record<string, PrRef> = { "https://github.com/o/r/pull/1": { number: 1, url: "https://github.com/o/r/pull/1", state: "MERGED" } };
  const snap = computeBoardSnapshot({
    plan: planOf([task({ id: "A" })]),
    ledgerPath,
    github: fakeGitHub({ reviewState: () => "not-applicable" }, byRef),
  });
  const row = snap.tasks.find((r) => r.taskId === "A")!;
  assert.equal(row.reviewState, "not-applicable");
  assert.notEqual(row.reviewState, "none");
});

// ── GATEWAY LAYER: buildBatchedGithub — the real implementer the console uses ───────────────

function fakeGhExec(fixtures: {
  openRows?: unknown[];
  closedRows?: unknown[];
  combinedStatusByRef?: Record<string, { statuses?: Array<{ context?: string; state?: string }> }>;
}): { exec: (args: string[]) => string; calls: string[][] } {
  const calls: string[][] = [];
  const exec = (args: string[]): string => {
    calls.push(args);
    const path = args[1] ?? "";
    if (path.includes("/pulls?state=open")) return JSON.stringify(fixtures.openRows ?? []);
    if (path.includes("/pulls?state=closed")) return JSON.stringify(fixtures.closedRows ?? []);
    const refMatch = path.match(/\/commits\/([^/]+)\/status$/);
    if (refMatch) return JSON.stringify(fixtures.combinedStatusByRef?.[refMatch[1]] ?? { statuses: [] });
    throw new Error(`unfixtured gh api call: ${path}`);
  };
  return { exec, calls };
}

function openPrRow(number: number, headRef: string) {
  return {
    number,
    html_url: `https://github.com/owner/repo/pull/${number}`,
    state: "open",
    head: { ref: headRef, sha: `sha-${number}` },
    body: "",
    auto_merge: null,
    title: "t",
    updated_at: "2026-08-17T00:00:00.000Z",
  };
}

function mergedPrRow(number: number, headRef: string) {
  return {
    number,
    html_url: `https://github.com/owner/repo/pull/${number}`,
    state: "closed",
    merged: true,
    merged_at: "2026-08-10T00:00:00.000Z",
    // The branch GitHub deletes on merge — a REAL call keyed on this 404s, which is exactly the
    // defect: a fixed correctly-fixed gateway must never even attempt it.
    head: { ref: headRef, sha: `sha-${number}` },
    body: "",
    auto_merge: null,
    title: "t",
    updated_at: "2026-08-17T00:00:00.000Z",
  };
}

function closedUnmergedPrRow(number: number, headRef: string) {
  return {
    number,
    html_url: `https://github.com/owner/repo/pull/${number}`,
    state: "closed",
    merged: false,
    merged_at: null,
    head: { ref: headRef, sha: `sha-${number}` },
    body: "",
    auto_merge: null,
    title: "t",
    updated_at: "2026-08-17T00:00:00.000Z",
  };
}

function statusCalls(calls: string[][]): string[][] {
  return calls.filter((c) => (c[1] ?? "").includes("/commits/"));
}

test("W1-T2235: a MERGED row's reviewState is 'not-applicable' and issues ZERO combined-status calls, on a cold cache AND on a second (warm) read past the TTL", () => {
  const prUrl = "https://github.com/owner/repo/pull/42";
  const { exec, calls } = fakeGhExec({
    openRows: [],
    closedRows: [mergedPrRow(42, "run-W1-T331-deleted-branch")],
    // Deliberately NO fixture for the combined-status endpoint — a real gateway keyed on the
    // deleted branch would 404 here; this proves the call is never attempted at all.
  });
  let nowMs = 1_000_000;
  const github = buildBatchedGithub("owner", "repo", { exec, now: () => nowMs, ttlMs: 15_000 });

  // Cold: nothing cached yet, first ask about this row.
  assert.equal(github.reviewState?.(prUrl), "not-applicable");
  assert.equal(statusCalls(calls).length, 0, "a terminal row must not reach the network on a cold cache");

  // Warm: well past ttlMs, exactly the repeated-paint case the defect re-storms on.
  nowMs += 200_000;
  assert.equal(github.reviewState?.(prUrl), "not-applicable");
  assert.equal(statusCalls(calls).length, 0, "a terminal row must not reach the network on a warm read either");
});

test("W1-T2235: a CLOSED (unmerged) row is ALSO 'not-applicable' with zero status calls — the guard is state !== OPEN, not merged-only", () => {
  const prUrl = "https://github.com/owner/repo/pull/43";
  const { exec, calls } = fakeGhExec({
    openRows: [],
    closedRows: [closedUnmergedPrRow(43, "run-W1-T332-deleted-branch")],
  });
  const github = buildBatchedGithub("owner", "repo", { exec, ttlMs: 15_000 });

  assert.equal(github.reviewState?.(prUrl), "not-applicable");
  assert.equal(statusCalls(calls).length, 0);
});

test("W1-T2235: the number of per-row status calls for a board of ALL-terminal rows is zero, end to end through computeBoardSnapshot", () => {
  const rows = [
    mergedPrRow(1, "run-A-1"),
    mergedPrRow(2, "run-B-1"),
    closedUnmergedPrRow(3, "run-C-1"),
    mergedPrRow(4, "run-D-1"),
    closedUnmergedPrRow(5, "run-E-1"),
  ];
  const { exec, calls } = fakeGhExec({ openRows: [], closedRows: rows });
  const github = buildBatchedGithub("owner", "repo", { exec, ttlMs: 15_000 });

  const ledgerPath = tmpLedgerPath();
  const taskIds = ["A", "B", "C", "D", "E"];
  for (let i = 0; i < rows.length; i++) {
    appendFileSync(ledgerPath, prOpenedLine(taskIds[i], `https://github.com/owner/repo/pull/${i + 1}`));
  }
  const snap = computeBoardSnapshot({ plan: planOf(taskIds.map((id) => task({ id }))), ledgerPath, github });

  for (const id of taskIds) {
    const row = snap.tasks.find((r) => r.taskId === id)!;
    assert.equal(row.reviewState, "not-applicable", `task ${id} must render not-applicable`);
    assert.notEqual(row.reviewState, "none");
  }
  assert.equal(statusCalls(calls).length, 0, "a board of entirely terminal rows must make zero per-row status calls");
});

// ── THE OPEN-ROW PATH: untouched — still fetched, still expires every TTL ───────────────────

test("W1-T2235: an OPEN PR's review state is STILL fetched over the network and STILL expires every poll interval — the terminal-row fix does not freeze a live row", () => {
  const prUrl = "https://github.com/owner/repo/pull/7";
  let currentState = "pending";
  const { exec, calls } = fakeGhExec({
    openRows: [openPrRow(7, "run-W1-T7-1")],
    closedRows: [],
  });
  // Wrap exec so the combined-status fixture can change between calls (GitHub posting a new
  // result), proving a SECOND, LIVE read happens past the TTL rather than a frozen memo. Every
  // call is still recorded into the SAME `calls` array `statusCalls` inspects below.
  const liveExec = (args: string[]): string => {
    calls.push(args);
    const path = args[1] ?? "";
    if (path.match(/\/commits\/run-W1-T7-1\/status$/)) {
      return JSON.stringify({ statuses: [{ context: "remudero-review", state: currentState }] });
    }
    return exec(args);
  };
  let nowMs = 1_000_000;
  const github = buildBatchedGithub("owner", "repo", { exec: liveExec, now: () => nowMs, ttlMs: 15_000 });

  assert.equal(github.reviewState?.(prUrl), "pending");
  assert.equal(statusCalls(calls).length, 1, "first ask about an OPEN row must fetch");

  // Within the TTL: the memo is honoured, no second call.
  nowMs += 5_000;
  assert.equal(github.reviewState?.(prUrl), "pending");
  assert.equal(statusCalls(calls).length, 1, "an OPEN row's memo is honoured WITHIN the TTL");

  // Past the TTL, and GitHub has since posted a real outcome: the row must re-fetch and pick it up.
  currentState = "success";
  nowMs += 20_000;
  assert.equal(github.reviewState?.(prUrl), "success");
  assert.equal(statusCalls(calls).length, 2, "an OPEN row's review state must re-fetch past ttlMs, unlike a terminal row");
});

test("W1-T2235: a failed status read on an OPEN row still renders 'unreadable', never 'none' and never 'not-applicable'", () => {
  // The gateway's own read fails (undefined) and the broader GitHub channel is confirmed down —
  // deriveReviewState's existing failure/absence split (board.ts) must still apply to an OPEN
  // row exactly as before; the new terminal short-circuit must not intercept this path.
  const failedRead = fakeGitHub({ reviewState: () => undefined, readFailed: () => true });
  const state = deriveReviewState("https://github.com/o/r/pull/9", failedRead);
  assert.equal(state, "unreadable");
  assert.notEqual(state, "none");
  assert.notEqual(state, "not-applicable");

  // End to end: buildBatchedGithub.reviewState on a real OPEN row whose combined-status call
  // throws (rate limit, transport error) returns undefined — never a guessed "not-applicable".
  const { exec } = fakeGhExec({ openRows: [openPrRow(8, "run-W1-T8-1")], closedRows: [] });
  const throwingExec = (args: string[]): string => {
    if ((args[1] ?? "").includes("/commits/")) throw new Error("gh: rate limited");
    return exec(args);
  };
  const github = buildBatchedGithub("owner", "repo", { exec: throwingExec, ttlMs: 15_000 });
  assert.equal(github.reviewState?.("https://github.com/owner/repo/pull/8"), undefined);
});
