import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeBoardSnapshot, deriveReviewState, type BoardDeps } from "../src/lib/board.js";
import { buildBatchedGithub, type GitHub, type PrRef } from "../src/lib/status.js";
import { renderShellHtml } from "../src/lib/serve.js";
import type { Plan, Task } from "../src/lib/plan.js";

// ── W1-T914 (feedback fb-1784901239119-1be356 clause c / fb-1784919225707-0fab8b) ──────────
//
// SOURCE-VERIFIED AT FILING (plan/tasks.d/W1-T914-…yaml): `reviewState` appeared in ZERO
// console files — src/lib/serve.ts's row templates emitted only `prLink` (a bare `#<n>`
// anchor), and src/lib/board.ts's `BoardRow` carried no review field of any kind. A PR that
// passed review, one whose review was still running, and one whose review had failed all
// rendered byte-identically. This suite proves the fix renders the THREE named states plus the
// two "not a state GitHub actually reported" cases (absent, unreadable) — five outcomes total,
// never collapsed into each other — at BOTH the data layer (lib/board.ts's `computeBoardSnapshot`/
// `deriveReviewState`, bound to `GitHub.reviewState`, status.ts) and the render layer
// (lib/serve.ts's `prLink`/`reviewBadge`, extracted from the served shell exactly like the
// existing W1-T182/W1-T346 row-template proofs).

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
  const dir = mkdtempSync(join(tmpdir(), "rmd-review3state-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
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

function prOpenedLine(taskId: string, prUrl: string): string {
  return JSON.stringify({ ts: "2026-08-17T10:00:00.000Z", task_id: taskId, step: "pr.opened", pr_url: prUrl }) + "\n";
}

// ── DATA LAYER: lib/board.ts binds BoardRow.reviewState to GitHub.reviewState ──────────────

test("W1-T914: computeBoardSnapshot renders reviewed-green, reviewed-red and review-in-progress as three DISTINCT states off the SAME GitHub.reviewState read — pending is never collapsed into success", () => {
  const ledgerPath = tmpLedgerPath();
  appendFileSync(
    ledgerPath,
    prOpenedLine("A", "https://github.com/o/r/pull/1") +
      prOpenedLine("B", "https://github.com/o/r/pull/2") +
      prOpenedLine("C", "https://github.com/o/r/pull/3"),
  );
  const byRef: Record<string, PrRef> = {
    "https://github.com/o/r/pull/1": { number: 1, url: "https://github.com/o/r/pull/1", state: "OPEN" },
    "https://github.com/o/r/pull/2": { number: 2, url: "https://github.com/o/r/pull/2", state: "OPEN" },
    "https://github.com/o/r/pull/3": { number: 3, url: "https://github.com/o/r/pull/3", state: "OPEN" },
  };
  const reviewByUrl: Record<string, "success" | "failure" | "pending"> = {
    "https://github.com/o/r/pull/1": "success",
    "https://github.com/o/r/pull/2": "failure",
    "https://github.com/o/r/pull/3": "pending",
  };
  const github = fakeGitHub({ reviewState: (prUrl) => reviewByUrl[prUrl] }, byRef);
  const deps: BoardDeps = { plan: planOf([task({ id: "A" }), task({ id: "B" }), task({ id: "C" })]), ledgerPath, github };

  const rows = computeBoardSnapshot(deps).tasks;
  const A = rows.find((r) => r.taskId === "A")!;
  const B = rows.find((r) => r.taskId === "B")!;
  const C = rows.find((r) => r.taskId === "C")!;

  assert.equal(A.reviewState, "success");
  assert.equal(B.reviewState, "failure");
  assert.equal(C.reviewState, "pending");
  // The falsifier this task exists to kill: a PR whose review is running must never read as
  // "success" — a live-but-unfinished review is not a green review.
  assert.notEqual(C.reviewState, "success");
  assert.notEqual(C.reviewState, B.reviewState);
  assert.notEqual(A.reviewState, B.reviewState);
});

test("W1-T914: a head carrying NO remudero-review renders as absent (\"none\") — never pending, never green", () => {
  const ledgerPath = tmpLedgerPath();
  appendFileSync(ledgerPath, prOpenedLine("D", "https://github.com/o/r/pull/4"));
  const byRef: Record<string, PrRef> = { "https://github.com/o/r/pull/4": { number: 4, url: "https://github.com/o/r/pull/4", state: "OPEN" } };
  // A real, successful read that genuinely found no `remudero-review` context — the honest
  // "none" a real combined-status read returns, not a guess.
  const github = fakeGitHub({ reviewState: () => "none" }, byRef);
  const row = computeBoardSnapshot({ plan: planOf([task({ id: "D" })]), ledgerPath, github }).tasks.find((r) => r.taskId === "D")!;

  assert.equal(row.reviewState, "none");
  assert.notEqual(row.reviewState, "pending");
  assert.notEqual(row.reviewState, "success");
});

test("W1-T914: a gateway that does not implement GitHub.reviewState at all (predates W1-T913/W1-T914) degrades to \"none\", never a fabricated pending or green", () => {
  // deriveReviewState is the pure seam computeBoardSnapshot binds to — exercised directly so
  // this covers every caller of it, not only computeBoardSnapshot's own plumbing.
  const github = fakeGitHub(); // no `reviewState` method at all — an older fixture/gateway
  assert.equal(deriveReviewState("https://github.com/o/r/pull/9", github), "none");
});

test("W1-T914: a row with NO PR at all carries no reviewState — nothing to render, never a fabricated state", () => {
  const github = fakeGitHub();
  assert.equal(deriveReviewState(undefined, github), undefined);

  const ledgerPath = tmpLedgerPath(); // no pr.opened line for this task at all
  const row = computeBoardSnapshot({ plan: planOf([task({ id: "E" })]), ledgerPath, github }).tasks.find((r) => r.taskId === "E")!;
  assert.equal(row.reviewState, undefined);
});

test("W1-T914 CANNOT-READ IS NOT A STATE: a failed GitHub read renders as \"unreadable\" — never \"none\" (absent) and never a stale green/red", () => {
  // (i) GitHub.reviewState itself reports the failure by returning undefined, and readFailed()
  // confirms it was a real outage, not a clean "not found".
  const failedRead = fakeGitHub({ reviewState: () => undefined, readFailed: () => true });
  assert.equal(deriveReviewState("https://github.com/o/r/pull/5", failedRead), "unreadable");

  // (ii) GitHub.reviewState THROWS outright (an unguarded gateway) — still "unreadable", never
  // an uncaught exception taking down the whole snapshot.
  const throwingRead = fakeGitHub({
    reviewState: () => {
      throw new Error("gh: rate limited");
    },
    readFailed: () => true,
  });
  assert.equal(deriveReviewState("https://github.com/o/r/pull/6", throwingRead), "unreadable");

  // (iii) the SAME undefined result WITHOUT a confirmed readFailed (this exact prUrl just
  // couldn't be resolved against a healthy gateway) degrades to "none", not "unreadable" —
  // the failure/absence split stays real, not "every undefined means outage".
  const healthyButUnresolved = fakeGitHub({ reviewState: () => undefined, readFailed: () => false });
  assert.equal(deriveReviewState("https://github.com/o/r/pull/7", healthyButUnresolved), "none");

  // End-to-end through computeBoardSnapshot: the row-level signal and the snapshot's own
  // `github_unreachable` header flag come off the SAME `readFailed()` observation, so they can
  // never disagree about whether GitHub is having a bad day.
  const ledgerPath = tmpLedgerPath();
  appendFileSync(ledgerPath, prOpenedLine("F", "https://github.com/o/r/pull/8"));
  const byRef: Record<string, PrRef> = { "https://github.com/o/r/pull/8": { number: 8, url: "https://github.com/o/r/pull/8", state: "OPEN" } };
  const outage = fakeGitHub(
    {
      reviewState: () => {
        throw new Error("ENOBUFS");
      },
      readFailed: () => true,
    },
    byRef,
  );
  const snap = computeBoardSnapshot({ plan: planOf([task({ id: "F" })]), ledgerPath, github: outage });
  const row = snap.tasks.find((r) => r.taskId === "F")!;
  assert.equal(row.reviewState, "unreadable");
  assert.notEqual(row.reviewState, "none");
  assert.notEqual(row.reviewState, "success");
  assert.equal(snap.github_unreachable, true, "the row's unreadable state and the header's outage banner share ONE observation");
});

// ── BOUND TO THE EXISTING vocabulary + combined-status read, not a second derivation ───────
//
// buildBatchedGithub (status.ts) is the REAL GitHub.reviewState implementer the console uses.
// Proven here over an INJECTED `exec`, so the exact wire shape it reads is pinned: the combined
// commit-status endpoint (`commits/<ref>/status`) open-prs-rest.ts's own `combinedStatusRestArgs`
// documents as "where `remudero-review` ... lives" — the SAME endpoint run-task.ts's sweep-side
// `reviewStateFromRollup`/`buildOpenPrViews` already reads — never a second, independently-shaped
// GitHub call or a second state vocabulary invented for the console alone.

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

test("W1-T914: buildBatchedGithub.reviewState reads the combined-status endpoint (commits/<ref>/status) and matches the SAME 'remudero-review' context the merge gate posts — a differently-named context is ignored, never mistaken for the review", () => {
  const prUrl = "https://github.com/owner/repo/pull/42";
  const { exec, calls } = fakeGhExec({
    openRows: [openPrRow(42, "run-W1-T1-100")],
    closedRows: [],
    combinedStatusByRef: {
      "run-W1-T1-100": {
        statuses: [
          { context: "ci", state: "success" }, // a DIFFERENT context — must be ignored
          { context: "remudero-review", state: "pending" },
        ],
      },
    },
  });
  const github = buildBatchedGithub("owner", "repo", { exec });

  assert.equal(github.reviewState?.(prUrl), "pending");
  const statusCall = calls.find((c) => (c[1] ?? "").includes("/commits/"));
  assert.ok(statusCall, "must read the combined commit-status endpoint");
  assert.match(statusCall![1], /^repos\/owner\/repo\/commits\/run-W1-T1-100\/status$/, "the SAME shape open-prs-rest.ts's combinedStatusRestArgs documents");
});

test("W1-T914: buildBatchedGithub.reviewState maps success/failure/error and an empty rollup to the sweep's own reviewState vocabulary (success/failure/none)", () => {
  const cases: Array<{ prState: string; expected: "success" | "failure" | "none" }> = [
    { prState: "success", expected: "success" },
    { prState: "failure", expected: "failure" },
    { prState: "error", expected: "failure" },
  ];
  for (const { prState, expected } of cases) {
    const { exec } = fakeGhExec({
      openRows: [openPrRow(1, "run-W1-T1-1")],
      closedRows: [],
      combinedStatusByRef: { "run-W1-T1-1": { statuses: [{ context: "remudero-review", state: prState }] } },
    });
    const github = buildBatchedGithub("owner", "repo", { exec });
    assert.equal(github.reviewState?.("https://github.com/owner/repo/pull/1"), expected, `state ${prState}`);
  }
  // No `remudero-review` entry at all in an otherwise-real rollup -> "none", never synthesised
  // from the endpoint's own top-level roll-up-of-a-rollup state (open-prs-rest.ts's own rule).
  const { exec } = fakeGhExec({
    openRows: [openPrRow(2, "run-W1-T2-1")],
    closedRows: [],
    combinedStatusByRef: { "run-W1-T2-1": { statuses: [{ context: "ci", state: "success" }] } },
  });
  const github = buildBatchedGithub("owner", "repo", { exec });
  assert.equal(github.reviewState?.("https://github.com/owner/repo/pull/2"), "none");
});

test("W1-T914: buildBatchedGithub.reviewState returns undefined (unreadable) when the combined-status read itself throws, never a guessed state", () => {
  const { exec } = fakeGhExec({ openRows: [openPrRow(3, "run-W1-T3-1")], closedRows: [] });
  const throwingExec = (args: string[]): string => {
    if ((args[1] ?? "").includes("/commits/")) throw new Error("gh: rate limited");
    return exec(args);
  };
  const github = buildBatchedGithub("owner", "repo", { exec: throwingExec });
  assert.equal(github.reviewState?.("https://github.com/owner/repo/pull/3"), undefined);
});

// ── RENDER LAYER: lib/serve.ts's prLink/reviewBadge, extracted from the served shell exactly
// like the existing W1-T182/W1-T346 row-template proofs (test/serve.test.ts) — proven over the
// ACTUAL rendered output, not merely that a field is threaded through. ──────────────────────

function extractPrLinkRenderer(): (t: Record<string, unknown>) => string {
  const html = renderShellHtml();
  const parts = {
    REVIEW_STATE_LABELS: html.match(/const REVIEW_STATE_LABELS = \{[\s\S]*?\};/)?.[0],
    reviewBadge: html.match(/function reviewBadge\(state\) \{[\s\S]*?\n  \}/)?.[0],
    prLink: html.match(/function prLink\(t\) \{[\s\S]*?\n  \}/)?.[0],
  };
  for (const [name, src] of Object.entries(parts)) assert.ok(src, `${name} must exist in the shell's inline script`);
  return new Function(
    `${parts.REVIEW_STATE_LABELS}\n${parts.reviewBadge}\n${parts.prLink}\nreturn prLink(arguments[0]);`,
  ) as (t: Record<string, unknown>) => string;
}

test("W1-T914 RENDER: prLink renders reviewed-green, reviewed-red and review-in-progress with THREE distinct CSS classes/labels — pending never carries the success class or label", () => {
  const prLink = extractPrLinkRenderer();

  const success = prLink({ prUrl: "https://github.com/o/r/pull/1", prNumber: 1, reviewState: "success" });
  const failure = prLink({ prUrl: "https://github.com/o/r/pull/1", prNumber: 1, reviewState: "failure" });
  const pending = prLink({ prUrl: "https://github.com/o/r/pull/1", prNumber: 1, reviewState: "pending" });

  assert.match(success, /class="review-dot review-success"/);
  assert.match(success, /review passed/);
  assert.match(failure, /class="review-dot review-failure"/);
  assert.match(failure, /review failed/);
  assert.match(pending, /class="review-dot review-pending"/);
  assert.match(pending, /review pending/);

  // The falsifier: a pending review must never render with the success class or label.
  assert.doesNotMatch(pending, /review-success/);
  assert.doesNotMatch(pending, /review passed/);
  assert.doesNotMatch(failure, /review-success/);
});

test("W1-T914 RENDER: an absent review (\"none\") and an unreadable read each render their OWN distinct badge — never re-using the pending or success badge", () => {
  const prLink = extractPrLinkRenderer();

  const none = prLink({ prUrl: "https://github.com/o/r/pull/2", prNumber: 2, reviewState: "none" });
  const unreadable = prLink({ prUrl: "https://github.com/o/r/pull/2", prNumber: 2, reviewState: "unreadable" });

  assert.match(none, /class="review-dot review-none"/);
  assert.match(none, /not yet reviewed/);
  assert.doesNotMatch(none, /review-pending/);
  assert.doesNotMatch(none, /review-success/);

  assert.match(unreadable, /class="review-dot review-unreadable"/);
  assert.match(unreadable, /review status unreadable/);
  assert.doesNotMatch(unreadable, /review-none/);
  assert.doesNotMatch(unreadable, /review-success/);
});

test("W1-T914 RENDER: a row with a PR but no reviewState (an older snapshot payload) renders the bare link, byte-identical to before this task — and a row with no PR renders nothing", () => {
  const prLink = extractPrLinkRenderer();
  assert.equal(prLink({ prUrl: "https://github.com/o/r/pull/3", prNumber: 3 }), ' · <a href="https://github.com/o/r/pull/3" target="_blank" rel="noreferrer">#3</a>');
  assert.equal(prLink({}), "");
});
