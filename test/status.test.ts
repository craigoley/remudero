import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { nextRunnable, type MergedSet } from "../src/lib/drain.js";
import { DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS, type GhCallPacer } from "../src/lib/open-prs-rest.js";
import {
  buildBatchedGithub,
  classifyGhFailure,
  createLedgerTailCache,
  deriveStatus,
  dispatchesWithoutNewOwnedPr,
  ghGateway,
  isDispatchBreakerTripped,
  projectPlan,
  proofGrepTargets,
  findSupersessionEvidence,
  buildGitLogSupersessionSearch,
  readLedgerLines,
  readLedgerTail,
  resetDefaultGhCallPacerForTest,
  DEFAULT_MAX_TASK_DISPATCHES,
  type BatchedIssue,
  type BatchedPr,
  type GitHub,
  type PrRef,
  type SupersessionCommit,
  type SupersessionSearch,
} from "../src/lib/status.js";

/** A minimal task; fields not under test get sensible defaults. */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued", // decorative — deriveStatus must NOT trust this
    attempts: 0,
    ...over,
  };
}

/** A fake GitHub gateway driven by fixture maps. */
function fakeGitHub(opts: {
  byRef?: Record<string, PrRef>;
  byTrailer?: Record<string, PrRef>;
  /** headRefName per PR url — rung (c)'s ownership-assert. */
  headRefByUrl?: Record<string, string>;
  /** raw PR body per PR url — rung (c)'s anchored-trailer verify. */
  bodyByUrl?: Record<string, string>;
  /** W1-T256: merged PRs per taskId matched by HEAD BRANCH (`run-<taskId>-*`), rung (c2)'s corroboration. */
  byHeadBranch?: Record<string, PrRef[]>;
  /** W1-T155: auto-merge-armed per PR url. Absent url ⇒ not armed. */
  autoMergeByUrl?: Record<string, boolean>;
  /** W1-T119: simulates every underlying `gh` call in this snapshot having failed. */
  readFailed?: boolean;
  /** W1-T182: escalation issue state/title per `issue_url` — absent url ⇒ null (not found/unreadable). */
  issuesByUrl?: Record<string, { state: string; title?: string } | null>;
  /** W1-T182: simulates the issue-fetch specifically failing (independent of the PR-fetch `readFailed`). */
  issueReadFailed?: boolean;
}): GitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readFailed() {
      calls.push("readFailed");
      return opts.readFailed ?? false;
    },
    issueByUrl(url) {
      calls.push(`issueByUrl:${url}`);
      return opts.issuesByUrl?.[url] ?? null;
    },
    issueReadFailed() {
      calls.push("issueReadFailed");
      return opts.issueReadFailed ?? false;
    },
    prByRef(ref) {
      calls.push(`prByRef:${ref}`);
      return opts.byRef?.[String(ref)] ?? null;
    },
    findMergedByTrailer(taskId) {
      calls.push(`trailer:${taskId}`);
      return opts.byTrailer?.[taskId] ?? null;
    },
    findMergedByHeadBranch(taskId) {
      calls.push(`headBranch:${taskId}`);
      // Mirror the real gateway: a FAILED read returns null (→ W1-T119); a healthy
      // gateway with no matching branch returns [] (a genuine no-such-branch).
      if (opts.readFailed) return null;
      return opts.byHeadBranch?.[taskId] ?? [];
    },
    listMergedHeadBranches() {
      calls.push("listMergedHeadBranches");
      // W1-T257 batched form: null on a failed read (→ W1-T119), else every merged PR with a head
      // ref. Seeded from the SAME byHeadBranch fixture map (flattened) so a test drives both paths.
      if (opts.readFailed) return null;
      return opts.byHeadBranch ? Object.values(opts.byHeadBranch).flat() : [];
    },
    headRefName(prUrl) {
      calls.push(`headRefName:${prUrl}`);
      return opts.headRefByUrl?.[prUrl];
    },
    prBody(prUrl) {
      calls.push(`prBody:${prUrl}`);
      return opts.bodyByUrl?.[prUrl];
    },
    autoMergeArmed(prUrl) {
      calls.push(`autoMergeArmed:${prUrl}`);
      return opts.autoMergeByUrl?.[prUrl] ?? false;
    },
  };
}

/** A well-formed own-branch head ref + exactly-anchored body for `taskId`/`runId`. */
function ownedTrailerFixture(taskId: string, runId: string) {
  return {
    headRefName: `run-${runId}`,
    body: `Implements ${taskId}.\n\nRemudero-Task: ${taskId}\n`,
  };
}

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-status-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

test("source (a): ledger pr.opened resolves via the PR's GitHub state", () => {
  const url = "https://github.com/craigoley/remudero/pull/7";
  const github = fakeGitHub({ byRef: { [url]: { number: 7, url, state: "MERGED" } } });
  const ledgerPath = ledgerFile([
    { step: "run.start", task_id: "W1-TX" },
    { step: "pr.opened", task_id: "W1-TX", pr_url: url },
  ]);
  const proj = deriveStatus(task({ id: "W1-TX" }), { ledgerPath, github });
  assert.equal(proj.source, "ledger");
  assert.equal(proj.merged, true);
  assert.equal(proj.status, "merged");
  assert.equal(proj.prNumber, 7);
});

test("source (a): the LAST pr.opened wins when a task was retried", () => {
  const older = "https://github.com/craigoley/remudero/pull/7";
  const newer = "https://github.com/craigoley/remudero/pull/9";
  const github = fakeGitHub({
    byRef: {
      [older]: { number: 7, url: older, state: "CLOSED" },
      [newer]: { number: 9, url: newer, state: "MERGED" },
    },
  });
  const ledgerPath = ledgerFile([
    { step: "pr.opened", task_id: "W1-TX", pr_url: older },
    { step: "pr.opened", task_id: "W1-TX", pr_url: newer },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.prNumber, 9);
  assert.equal(proj.merged, true);
});

// ── P29(i): SIBLING CREDIT — the W1-T1 redispatch-storm shape ──────────────
// PR #255 (an EARLIER run) merged; every LATER run's own ledger `pr.opened`
// line (a different, unmerged/closed PR) kept resolving at rung (a) FIRST and
// returning unconditionally, so rung (c)'s trailer search — which would have
// found #255 — was never reached again. ~130 dispatches / ~$130 / ~10h, five
// hours of it AFTER the real merge (MASTER-PLAN P29).

test("P29(i) sibling credit: a LATER run's own CLOSED PR (rung a's last pr.opened) does not mask an EARLIER sibling run's merged, owned, anchored trailer credit", () => {
  const laterOwnClosedPr = "https://github.com/craigoley/remudero/pull/300"; // this (latest) run's own, failed attempt
  const fixture = ownedTrailerFixture("W1-T1", "W1-T1-1784460723173"); // the EARLIER sibling run whose PR actually merged
  const github = fakeGitHub({
    byRef: { [laterOwnClosedPr]: { number: 300, url: laterOwnClosedPr, state: "CLOSED" } },
    byTrailer: { "W1-T1": { number: 255, url: "u/255", state: "MERGED" } },
    headRefByUrl: { "u/255": fixture.headRefName },
    bodyByUrl: { "u/255": fixture.body },
  });
  const ledgerPath = ledgerFile([
    // Many redispatches' own ledger lines, all AFTER the sibling's #255 merged,
    // each pointing at a DIFFERENT PR of THIS run's own (never #255 itself) —
    // the exact "last one wins" masking shape.
    { step: "pr.opened", task_id: "W1-T1", pr_url: laterOwnClosedPr },
  ]);
  const proj = deriveStatus(task({ id: "W1-T1" }), { ledgerPath, github });
  assert.equal(proj.source, "trailer", "the sibling's merged trailer PR credits the task, not rung (a)'s own closed PR");
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 255, "credited via the SIBLING run's PR (#255), never the later run's own #300");
});

test("P29(i) sibling credit composed with nextRunnable: once credited via a sibling, the task is EXCLUDED and dispatches NOTHING further", () => {
  const plan: Plan = { tasks: [task({ id: "W1-T1" })], byId: new Map([["W1-T1", task({ id: "W1-T1" })]]) };
  const fixture = ownedTrailerFixture("W1-T1", "W1-T1-1784460723173");
  const github = fakeGitHub({
    byRef: { "u/300": { number: 300, url: "u/300", state: "CLOSED" } },
    byTrailer: { "W1-T1": { number: 255, url: "u/255", state: "MERGED" } },
    headRefByUrl: { "u/255": fixture.headRefName },
    bodyByUrl: { "u/255": fixture.body },
  });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "W1-T1", pr_url: "u/300" }]);
  const isMerged: MergedSet = (id) => deriveStatus(plan.byId.get(id)!, { ledgerPath, github }).merged;
  assert.equal(isMerged("W1-T1"), true);
  assert.equal(nextRunnable(plan, isMerged), undefined, "credited once — nextRunnable never re-selects it");
});

test("P29(i) falsifier: a FOREIGN branch carrying the trailer is still NOT credited even though rung (a)'s own PR is closed — the ownership-assert is preserved, never loosened", () => {
  const ownClosedPr = "https://github.com/craigoley/remudero/pull/300";
  const github = fakeGitHub({
    byRef: { [ownClosedPr]: { number: 300, url: ownClosedPr, state: "CLOSED" } },
    byTrailer: { "W1-T1": { number: 999, url: "u/999", state: "MERGED" } },
    // A real, merged PR carrying the trailer — but from a FOREIGN/unrelated branch,
    // never this task's own run-<taskId>-* shape.
    headRefByUrl: { "u/999": "run-W1-T2-1784000000000" },
    bodyByUrl: { "u/999": "Remudero-Task: W1-T1\n" },
  });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "W1-T1", pr_url: ownClosedPr }]);
  const proj = deriveStatus(task({ id: "W1-T1" }), { ledgerPath, github });
  assert.equal(proj.merged, false, "a foreign-branch trailer hit must never credit, even to escape a masked closed PR");
  assert.equal(proj.source, "ledger", "falls back to rung (a)'s own (non-merged) resolution — the foreign hit is simply rejected, not substituted");
});

// ── W1-T116: a VERIFIED-MERGED credit outranks an open-PR ledger claim ─────
// The live W1-T1 149x incident: `pr: 2` (GitHub-confirmed MERGED) alongside a
// LATER dispatch's ledger `pr.opened` row for #258 (GitHub-confirmed OPEN).
// Rung (a) resolved #258 first and, pre-fix, that non-merged `ownResult`
// suppressed rung (b) outright — the merged `pr: 2` credit was never even
// looked up, so the task stayed "running" forever and kept getting
// re-dispatched. 153 run.start lines for W1-T1 on 2026-07-19, 97 of them
// AFTER #258 was opened — ~$174, 41% of a day's task spend (MASTER-PLAN §3).

test("W1-T116: a verified-merged pr-field credit outranks a ledger row claiming an open PR — the live W1-T1 fixture settles", () => {
  const openedPr = "https://github.com/craigoley/remudero/pull/258"; // rung (a): the LATER dispatch's own PR, still open
  const github = fakeGitHub({
    byRef: {
      [openedPr]: { number: 258, url: openedPr, state: "OPEN" },
      "2": { number: 2, url: "https://github.com/craigoley/remudero/pull/2", state: "MERGED" },
    },
  });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "W1-T1", pr_url: openedPr }]);
  const proj = deriveStatus(task({ id: "W1-T1", pr: 2 }), { ledgerPath, github });
  assert.equal(proj.source, "pr-field", "the verified-merged pr: field credits the task, not rung (a)'s own open PR");
  assert.equal(proj.merged, true);
  assert.equal(proj.status, "merged");
  assert.equal(proj.prNumber, 2, "credited via the MERGED pr: 2, never the open #258 the ledger's own row points at");

  // Composed with the dispatcher (drain.ts's nextRunnable, same idiom as P29(i)'s
  // sibling-credit composition above): a merged credit means `isMerged` reports
  // true, so nextRunnable's very first check excludes the task — it is NEVER
  // re-dispatched.
  const plan: Plan = { tasks: [task({ id: "W1-T1", pr: 2 })], byId: new Map([["W1-T1", task({ id: "W1-T1", pr: 2 })]]) };
  const isMerged: MergedSet = (id) => deriveStatus(plan.byId.get(id)!, { ledgerPath, github }).merged;
  assert.equal(nextRunnable(plan, isMerged), undefined, "settled work is excluded — never re-dispatched");
});

test("W1-T116: dedup is intact — a genuinely-running task (no settled credit anywhere) is still reported running, not merged", () => {
  const openedPr = "u/258";
  const github = fakeGitHub({ byRef: { [openedPr]: { number: 258, url: openedPr, state: "OPEN" } } });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "W1-T1", pr_url: openedPr }]);
  // No correction, no `pr:` field, no merged trailer/head-branch hit anywhere.
  const proj = deriveStatus(task({ id: "W1-T1" }), { ledgerPath, github });
  assert.equal(proj.status, "running");
  assert.equal(proj.merged, false);
  assert.equal(proj.source, "ledger", "falls back to rung (a)'s own open-PR resolution — the dedup signal drain.ts's isOpenPr guard (W1-T80) relies on to skip a duplicate dispatch");
  assert.equal(proj.prNumber, 258);
});

test("W1-T116 regression lock: a correction wins over both a verified-merged pr-field and an open-PR ledger row present TOGETHER, in both the credit and the un-credit direction", () => {
  // This is the exact acceptance-1 fixture (rung (a) open #258 + a verified-merged
  // `pr: 2`) PLUS a correction retargeting the credit to #9 — the new composite
  // shape this task's fix makes reachable for the first time (pre-fix, rung (b)
  // was never even consulted once rung (a) had an `ownResult`, so a correction
  // racing a would-be-merged pr-field couldn't previously be exercised together).
  const rungAUrl = "u/258";
  const prFieldUrl = "u/2";
  const correctedUrl = "u/9";
  const github = fakeGitHub({
    byRef: {
      [rungAUrl]: { number: 258, url: rungAUrl, state: "OPEN" },
      "2": { number: 2, url: prFieldUrl, state: "MERGED" },
      [correctedUrl]: { number: 9, url: correctedUrl, state: "MERGED" },
    },
  });
  const ledgerPath = ledgerFile([
    { step: "pr.opened", task_id: "W1-T1", pr_url: rungAUrl },
    { step: "correction.provenance", task_id: "W1-T1", claimed_pr_url: prFieldUrl, actual_pr_url: correctedUrl },
  ]);
  const proj = deriveStatus(task({ id: "W1-T1", pr: 2 }), { ledgerPath, github });
  // CREDIT direction: #9 — which NEITHER rung (a) nor (b) would ever have found —
  // is credited, purely on the correction's say-so.
  assert.equal(proj.source, "correction");
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 9, "credited via the correction's actual_pr_url, not either underlying rung");
  // UN-CREDIT direction: #2 — which rung (b) WOULD have credited merged, per this
  // very task's own fix — is superseded, never surfacing as the reported PR.
  assert.notEqual(proj.prNumber, 2, "the pr: field's own (would-be-merged) PR is superseded by the correction, not reported");
  // SUPREME, unconditionally: neither weaker rung is even queried once a
  // correction exists — correction resolution short-circuits before any `gh` call.
  assert.ok(!github.calls.includes("prByRef:2"), "rung (b) must never even be queried once a correction exists");
  assert.ok(!github.calls.includes(`prByRef:${rungAUrl}`), "rung (a) must never even be queried once a correction exists");
});

test("source (b): explicit pr: field resolves when there is no ledger entry", () => {
  const github = fakeGitHub({ byRef: { "3": { number: 3, url: "u/3", state: "MERGED" } } });
  const ledgerPath = ledgerFile([{ step: "run.start", task_id: "OTHER" }]);
  const proj = deriveStatus(task({ id: "W1-T1B", pr: 3 }), { ledgerPath, github });
  assert.equal(proj.source, "pr-field");
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 3);
});

test("source (c): a merged PR carrying the Remudero-Task trailer resolves when owned + anchored", () => {
  const fixture = ownedTrailerFixture("W1-TX", "W1-TX-1730000000000");
  const github = fakeGitHub({
    byTrailer: { "W1-TX": { number: 12, url: "u/12", state: "MERGED" } },
    headRefByUrl: { "u/12": fixture.headRefName },
    bodyByUrl: { "u/12": fixture.body },
  });
  const ledgerPath = ledgerFile([]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.source, "trailer");
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 12);
});

test("source (c) ownership-assert: a trailer hit whose head branch is a FOREIGN/unrelated branch is rejected (the W1-T20c false-credit class)", () => {
  const github = fakeGitHub({
    byTrailer: { "W1-T20c": { number: 12, url: "u/12", state: "MERGED" } },
    // The PR is real and merged, but it was opened from W1-T20's branch, not
    // W1-T20c's — a sibling/foreign task, not this task's own run.
    headRefByUrl: { "u/12": "run-W1-T20-1730000000000" },
    bodyByUrl: { "u/12": "Remudero-Task: W1-T20c\n" },
  });
  const proj = deriveStatus(task({ id: "W1-T20c" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "none");
  assert.equal(proj.merged, false);
});

// ── W1-T256: an EMPTY trailer search is INDETERMINATE, not authoritative ──────
// Rung (c)'s `findMergedByTrailer` is GitHub's eventually-consistent BODY full-text
// search. An exit-0 EMPTY result for an ALREADY-MERGED task fell straight through to
// source:"none", re-dispatching it against its own merged PR — four spurious re-dispatches
// on 2026-07-24 alone (W1-T1, W1-T12a ×2, W1-T99). Rung (c2) corroborates with a
// deterministic HEAD-BRANCH read (`run-<taskId>-*`) before concluding none.

test("W1-T256 rung (c2): an EMPTY trailer search + a merged, OWNED head-branch hit resolves merged — the false none that re-dispatched W1-T12a is gone", () => {
  const url = "https://github.com/craigoley/remudero/pull/61";
  const github = fakeGitHub({
    byTrailer: {}, // exit-0 EMPTY: the eventually-consistent body search missed the merged PR
    byHeadBranch: { "W1-T12a": [{ number: 61, url, state: "MERGED", headRefName: "run-W1-T12a-1784124446138" }] },
  });
  const proj = deriveStatus(task({ id: "W1-T12a" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.merged, true, "the head-branch corroboration credits the merged PR the body search missed");
  assert.equal(proj.source, "head-branch");
  assert.equal(proj.status, "merged");
  assert.equal(proj.prNumber, 61);
});

test("W1-T256 rung (c2): a head-branch hit whose branch is NOT run-<taskId>-* is rejected — ownership is re-asserted exactly as rung (c) does", () => {
  const github = fakeGitHub({
    byTrailer: {},
    // A merged PR surfaced by the head-ref match but on a foreign/hand branch — never credited.
    byHeadBranch: { "W1-T12a": [{ number: 61, url: "u/61", state: "MERGED", headRefName: "fix/w1-t12a-hand" }] },
  });
  const proj = deriveStatus(task({ id: "W1-T12a" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.merged, false, "a non-owned head branch is never credited, even on a head-ref hit");
  assert.equal(proj.source, "none");
});

test("W1-T256 rung (c2): EMPTY on BOTH the trailer search AND the head-branch read is genuinely none — never a false merged", () => {
  const github = fakeGitHub({ byTrailer: {}, byHeadBranch: {} }); // both exit-0 empty, gateway healthy
  const proj = deriveStatus(task({ id: "W1-T77" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.merged, false);
  assert.equal(proj.source, "none");
  assert.ok(!proj.indeterminate, "a healthy double-empty is a confirmed absence, not indeterminate");
});

test("W1-T256 rung (c2): a FAILED head-branch read (gh throttled) defers via the EXISTING W1-T119 indeterminate skip — never a confirmed none", () => {
  const github = fakeGitHub({ readFailed: true, byTrailer: {} }); // every gh call fails
  const proj = deriveStatus(task({ id: "W1-T80" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.indeterminate, true, "an unreadable gateway defers, not a confirmed not-merged");
  assert.equal(proj.merged, false);
  assert.equal(proj.source, "throttled");
});

// ── W1-T257: the rung (c2) corroboration is BATCHED — ONE merged-PR head-ref list per
// projection, not one gh call per uncredited task (#737's per-task multiplier; five 07-23
// GraphQL exhaustions). projectPlan matches run-<taskId>-\d+ CLIENT-SIDE from the single fetch.

test("W1-T257: ONE batched head-branch list resolves MULTIPLE uncredited tasks in a single projection — no per-task head-branch call fires", () => {
  const github = fakeGitHub({
    byTrailer: {}, // every trailer search empty — under #737 each task would make its OWN head-ref fetch
    byHeadBranch: {
      "W1-T12a": [{ number: 61, url: "u/61", state: "MERGED", headRefName: "run-W1-T12a-1784124446138" }],
      "W1-T99": [{ number: 729, url: "u/729", state: "MERGED", headRefName: "run-W1-T99-1784913918134" }],
    },
  });
  const tasks: Task[] = [task({ id: "W1-T12a" }), task({ id: "W1-T99" }), task({ id: "W1-T500" })];
  const plan: Plan = { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
  const byId = projectPlan(plan, { ledgerPath: ledgerFile([]), github });
  assert.equal(byId.get("W1-T12a")?.merged, true, "the merged run branch is credited from the batch");
  assert.equal(byId.get("W1-T12a")?.source, "head-branch");
  assert.equal(byId.get("W1-T99")?.merged, true, "a SECOND task is resolved from the SAME batch");
  assert.equal(byId.get("W1-T99")?.source, "head-branch");
  assert.equal(byId.get("W1-T500")?.merged, false, "a task with no run branch is genuinely none");
  assert.equal(byId.get("W1-T500")?.source, "none");
  assert.equal(
    github.calls.filter((c) => c === "listMergedHeadBranches").length,
    1,
    "exactly ONE batched fetch backs all three tasks — not one per uncredited task",
  );
  assert.equal(
    github.calls.filter((c) => c.startsWith("headBranch:")).length,
    0,
    "NO per-task head-branch fetch fires when the batch succeeded",
  );
});

test("W1-T257: a FAILED batched head-branch read defers via W1-T119 (indeterminate) for every task — never a false none", () => {
  const github = fakeGitHub({ readFailed: true, byTrailer: {} }); // the batched list fetch fails
  const tasks: Task[] = [task({ id: "W1-T12a" }), task({ id: "W1-T99" })];
  const plan: Plan = { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
  const byId = projectPlan(plan, { ledgerPath: ledgerFile([]), github });
  for (const id of ["W1-T12a", "W1-T99"]) {
    assert.equal(byId.get(id)?.indeterminate, true, `${id}: a failed batched read defers, never a confirmed none`);
    assert.equal(byId.get(id)?.merged, false);
    assert.notEqual(byId.get(id)?.source, "none", `${id}: a failed batched read must NEVER read as a confirmed none`);
  }
});

// ── W1-T76's fix/* rejection, SUPERSEDED for MERGED PRs by the 2026-07-30 operator ruling. ──
// The doctrine this test encoded ("never weaken the assert to accommodate a fix/* head") was
// written when the branch NAME was the only ownership signal. The operator has ruled that an
// exactly-anchored trailer on a MERGED PR is itself sufficient evidence of credit. This is a
// DELIBERATE doctrine change, not an accommodation: W1-T64's real merged PR #115 is
// `fix/w1t64-both-tests` with a correct anchored trailer, and refusing it stranded the task
// permanently (recon-AO). The fix rung's own workflow is unaffected — it still amends the run
// branch, which still credits via ownsBranch. What changed is that a hand branch no longer
// VETOES. Non-merged fix/* PRs are still refused (see the trap 2 tests).
test("ruling supersedes W1-T76: a MERGED fix/* head with an anchored trailer now credits", () => {
  const github = fakeGitHub({
    byTrailer: { "W1-TX": { number: 134, url: "u/134", state: "MERGED" } },
    headRefByUrl: { "u/134": "fix/w1tx-style" },
    bodyByUrl: { "u/134": "Remudero-Task: W1-TX\n" },
  });
  const proj = deriveStatus(task({ id: "W1-TX" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "trailer", "a merged, anchored-trailer fix/* PR credits under the ruling");
  assert.equal(proj.merged, true);
});

test("source (c) ownership-assert: an unresolved head ref fails CLOSED, never credited", () => {
  const github = fakeGitHub({
    byTrailer: { "W1-TX": { number: 12, url: "u/12", state: "MERGED" } },
    bodyByUrl: { "u/12": "Remudero-Task: W1-TX\n" },
    // headRefByUrl deliberately omitted: gh could not resolve it.
  });
  const proj = deriveStatus(task(), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "none");
  assert.equal(proj.merged, false);
});

test("source (c) anchored-trailer verify: a search hit whose body names a DIFFERENT (prefix-sharing) task id is rejected", () => {
  const fixture = ownedTrailerFixture("W1-T20", "W1-T20c-1730000000000");
  const github = fakeGitHub({
    byTrailer: { "W1-T20c": { number: 12, url: "u/12", state: "MERGED" } },
    headRefByUrl: { "u/12": fixture.headRefName },
    // GitHub's fuzzy search matched "W1-T20c" against a body whose trailer
    // actually reads "W1-T20" — the unrelated parent task, never anchored.
    bodyByUrl: { "u/12": fixture.body },
  });
  const proj = deriveStatus(task({ id: "W1-T20c" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "none");
  assert.equal(proj.merged, false);
});

test("source (c) correction-awareness (pure debunk, no replacement named): a correction.provenance line naming only claimed_pr_url blocks that exact credit, even though ownership + anchor would otherwise pass", () => {
  const fixture = ownedTrailerFixture("W1-TX", "W1-TX-1730000000000");
  const github = fakeGitHub({
    byTrailer: { "W1-TX": { number: 12, url: "u/12", state: "MERGED" } },
    headRefByUrl: { "u/12": fixture.headRefName },
    bodyByUrl: { "u/12": fixture.body },
  });
  // No actual_pr_url -> latestActualPrUrl (the SUPREME rung, W1-T75) sees no
  // correction and this falls through to rung (c), whose debunkedTrailerUrls
  // still rejects the exact named claimed_pr_url.
  const ledgerPath = ledgerFile([
    { step: "correction.provenance", task_id: "W1-TX", claimed_pr_url: "u/12" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.source, "none");
  assert.equal(proj.merged, false);
});

test("W1-T130 SUPREME OFFLINE: a correction naming an actual_pr_url derives MERGED unconditionally, with ZERO gateway calls — GitHub is never asked to resolve/confirm/contradict it, so no throttle or error can demote it back to dispatchable", () => {
  const fixture = ownedTrailerFixture("W1-TX", "W1-TX-1730000000000");
  const github = fakeGitHub({
    byTrailer: { "W1-TX": { number: 12, url: "u/12", state: "MERGED" } },
    headRefByUrl: { "u/12": fixture.headRefName },
    bodyByUrl: { "u/12": fixture.body },
    // byRef deliberately omits "u/99": if it were ever consulted, gh could not
    // resolve the correction's target — proving the read is off the path
    // entirely, not merely tolerant of this particular failure.
  });
  const ledgerPath = ledgerFile([
    { step: "correction.provenance", task_id: "W1-TX", claimed_pr_url: "u/12", actual_pr_url: "u/99" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.source, "correction");
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 99); // decoration parsed from the ref's own text, never re-resolved
  assert.deepEqual(github.calls, [], "a correction-credited task must be honoured with ZERO gateway calls");
});

test("precedence: ledger (a) is consulted before pr: (b)", () => {
  const url = "https://github.com/craigoley/remudero/pull/7";
  const github = fakeGitHub({
    byRef: {
      [url]: { number: 7, url, state: "MERGED" },
      "99": { number: 99, url: "u/99", state: "CLOSED" },
    },
  });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "W1-TX", pr_url: url }]);
  const proj = deriveStatus(task({ pr: 99 }), { ledgerPath, github });
  assert.equal(proj.source, "ledger");
  assert.equal(proj.prNumber, 7);
  assert.ok(!github.calls.includes("prByRef:99"), "must not fall through to pr: when ledger resolves");
});

test("an OPEN PR derives not-merged (dependency gate stays closed)", () => {
  const github = fakeGitHub({ byRef: { "5": { number: 5, url: "u/5", state: "OPEN" } } });
  const proj = deriveStatus(task({ pr: 5 }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.merged, false);
  assert.equal(proj.status, "running");
});

test("no GitHub evidence -> not merged, source none (decorative status ignored)", () => {
  const github = fakeGitHub({});
  // yaml says merged, but GitHub has nothing: derivation must NOT trust yaml.
  const proj = deriveStatus(task({ status: "merged" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "none");
  assert.equal(proj.merged, false);
});

test("W1-T119: a failed GitHub read defers (source throttled), never a confirmed not-merged", () => {
  // Same fixture as the "no evidence" case above (every rung resolves nothing) EXCEPT
  // the gateway reports its reads actually failed (rate-limited/errored), not that
  // GitHub was consulted and came back empty. The false `source: "none"` here is
  // exactly what mis-filed W1-T116 as not-merged.
  const github = fakeGitHub({ readFailed: true });
  const proj = deriveStatus(task({ status: "merged" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "throttled");
  assert.equal(proj.merged, false);
});

test("W1-T119: a gateway with no readFailed method at all (every pre-W1-T119 fixture) degrades fail-soft to source none", () => {
  // No `readFailed` property whatsoever — mirrors every GitHub fixture written before
  // this method existed. Must behave exactly as before: `none`, never throw.
  const bareGithub: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
  const proj = deriveStatus(task({ status: "merged" }), { ledgerPath: ledgerFile([]), github: bareGithub });
  assert.equal(proj.source, "none");
  assert.equal(proj.merged, false);
});

// ── W1-T119 round 2: the CLASSIFIED reason (design (i)) — exit status + stderr ─────────

test("classifyGhFailure: a rate-limit exit status + stderr classifies as rate_limit", () => {
  assert.equal(classifyGhFailure(1, "gh: API rate limit exceeded for user ID 123456. (HTTP 403)"), "rate_limit");
});

test("classifyGhFailure: an auth-failure stderr classifies as auth", () => {
  assert.equal(classifyGhFailure(1, "gh: authentication required — run `gh auth login`"), "auth");
});

test("classifyGhFailure: a transport/network stderr classifies as transport", () => {
  assert.equal(classifyGhFailure(1, "dial tcp: lookup api.github.com: getaddrinfo ENOTFOUND"), "transport");
});

test("classifyGhFailure: an unrecognized stderr still classifies as unknown, never as absent — the fail-closed direction", () => {
  assert.equal(classifyGhFailure(1, "gh: something unexpected happened"), "unknown");
});

// ── W1-T1004: a plan-only FILING PR must never credit the task it just filed ──────────────────
// Both merged-credit rungs — rung (c)'s trailer search and rung (c2)'s head-branch corroboration
// — read the ledger's own `pr.opened{plan_only:true}` marker (the SAME positive record
// run-task.ts's `isPlanOnlyFilingPr` reads, mirrored here rather than imported so this task never
// has to declare src/run-task.ts). The marker is written ONLY by the retro/triage/`rmd plan`
// filing flows — a task's own ordinary implement run opens its PR via a plain `pr.opened` line
// that never carries the field — so the four cases below are decided by that one ledger line,
// never by reading the diff.

test("W1-T1004: a filing pull request carrying a trailer does not credit its task", () => {
  // The #1475/W1-T403 shape: a plan-only FILING run opened this PR from a hand-named branch, and
  // the filed task's id ended up as the PR's trailer. The filing flow's own `pr.opened` ledger
  // line carries `plan_only: true` for this exact pr_url.
  const url = "https://github.com/craigoley/remudero/pull/1475";
  const github = fakeGitHub({
    byTrailer: { "W1-T403": { number: 1475, url, state: "MERGED" } },
    headRefByUrl: { [url]: "claude/file-w1-t403" },
    bodyByUrl: { [url]: "Remudero-Task: W1-T403\n" },
  });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "TRIAGE-1", pr_url: url, plan_only: true }]);
  const proj = deriveStatus(task({ id: "W1-T403" }), { ledgerPath, github });
  assert.equal(proj.merged, false, "a plan-only filing PR must not credit the task it filed");
  assert.equal(proj.status, "queued");
  assert.equal(proj.source, "none");
  assert.deepEqual(proj.rejected_candidates, [{ pr: url, reason: "plan-only-changeset" }]);
});

test("W1-T1004: an implementation pull request carrying a trailer still credits its task", () => {
  // Same shape as above (trailer, hand-named branch, MERGED) EXCEPT the ledger's `pr.opened` line
  // for this pr_url carries no `plan_only` field at all — the shape a task's own ordinary
  // implement run produces (run-task.ts:6550). The credit must stand: this task is not refused
  // by a marker some OTHER pr_url or run happened to write.
  const url = "https://github.com/craigoley/remudero/pull/1709";
  const github = fakeGitHub({
    byTrailer: { "W1-T404": { number: 1709, url, state: "MERGED" } },
    headRefByUrl: { [url]: "claude/implement-w1-t404" },
    bodyByUrl: { [url]: "Remudero-Task: W1-T404\n" },
  });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "W1-T404", pr_url: url }]);
  const proj = deriveStatus(task({ id: "W1-T404" }), { ledgerPath, github });
  assert.equal(proj.merged, true, "an implementation PR's trailer credit is unaffected by the new refusal");
  assert.equal(proj.source, "trailer");
  assert.equal(proj.prNumber, 1709);
});

test("W1-T1004: a filing pull request on a run branch does not credit its task", () => {
  // The hole rationale (5) names: a filing PR dispatched from the task's OWN `run-<taskId>-*`
  // worktree sits on that task's own run branch, so `ownsOwnRunBranch` would otherwise wave it
  // through as "an implementation by construction" without ever reading the ledger. No trailer
  // search hit at all here (byTrailer empty) — this credit can ONLY come from rung (c2)'s
  // head-branch corroboration, the rung rationale (5) says "has no guard at all".
  const url = "https://github.com/craigoley/remudero/pull/2099";
  const github = fakeGitHub({
    byTrailer: {},
    byHeadBranch: {
      "W1-T968": [{ number: 2099, url, state: "MERGED", headRefName: "run-W1-T968-1787000000000" }],
    },
  });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "W1-T968", pr_url: url, plan_only: true }]);
  const proj = deriveStatus(task({ id: "W1-T968" }), { ledgerPath, github });
  assert.equal(proj.merged, false, "a filing PR on the task's own run branch must not credit it");
  assert.equal(proj.source, "none");
});

test("W1-T1004: a filing whose own deliverable is plan text still credits its task", () => {
  // The W1-T426/W1-T314 shape (rationale (2)): the task's OWN declared deliverable genuinely is
  // plan text, built by its own dispatched run — so its `pr.opened` ledger line carries no
  // `plan_only` field (the ordinary implement-run shape), even though the PR itself only touches
  // plan/**. Credited via the SAME rung (c2) head-branch path as the refusal test above, proving
  // the new guard discriminates rather than refusing everything on that rung.
  const url = "https://github.com/craigoley/remudero/pull/1293";
  const github = fakeGitHub({
    byTrailer: {},
    byHeadBranch: {
      "W1-T314": [{ number: 1293, url, state: "MERGED", headRefName: "run-W1-T314-1786000000000" }],
    },
  });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "W1-T314", pr_url: url }]);
  const proj = deriveStatus(task({ id: "W1-T314" }), { ledgerPath, github });
  assert.equal(proj.merged, true, "a task whose genuine deliverable is plan text is still credited");
  assert.equal(proj.source, "head-branch");
  assert.equal(proj.prNumber, 1293);
});

test("W1-T119: a throttled read is classified unavailable and never reads as not-merged — unit test over an injected gateway whose read fails with a rate-limit exit status and stderr: deriveStatus returns an indeterminate projection carrying the classified reason, and asserts NOT merged=false/source=none, the exact shape that mis-filed W1-T116", () => {
  // INJECTED GATEWAY: the real `ghGateway` implementation, with its raw `gh`
  // exec swapped for a fake that THROWS the exact shape a rate-limited `gh`
  // invocation throws on the real system — a non-zero exit status plus the
  // stderr text GitHub actually returns under quota exhaustion. Pre-W1-T119,
  // `stdio: [ignore, pipe, ignore]` discarded that stderr entirely — the one
  // place a rate-limit/auth/transport message appears — so every rung's null
  // collapsed into the SAME `source: "none"` a genuine absence produces: the
  // false reading that mis-filed W1-T116 as not-merged when GitHub had never
  // actually been consulted.
  const rateLimitError = Object.assign(new Error("Command failed: gh pr view"), {
    status: 1,
    stderr: "gh: API rate limit exceeded for user ID 123456. (HTTP 403)",
  });
  const github = ghGateway("craigoley", "remudero", {
    exec: () => {
      throw rateLimitError;
    },
  });
  const proj = deriveStatus(task({ pr: 5, status: "merged" }), { ledgerPath: ledgerFile([]), github });
  // deriveStatus returns an INDETERMINATE projection CARRYING THE CLASSIFIED REASON:
  assert.equal(proj.source, "throttled");
  assert.equal(proj.indeterminate, true);
  assert.equal(proj.unavailableReason, "rate_limit");
  assert.equal(proj.merged, false);
  // ...and asserts NOT merged=false/source=none — the exact shape that mis-filed W1-T116.
  // `proj.source` is statically "throttled" here (asserted above), so it can never equal
  // "none" — the type system itself now rules out the mis-filed shape for this path.
  const src: string = proj.source;
  assert.notEqual(src, "none", "a throttled read must NEVER collapse to the merged=false/source=none shape a genuine absence produces");
});

// ── W1-T119 round 2: a genuinely-absent PR still resolves as absent — no fail-closed stall ──

test("an injected gateway returning a clean not-found (zero-exit, empty result) yields the same not-merged projection it does today, and the indeterminate path is asserted NOT taken", () => {
  // Same real `ghGateway`, but the injected exec behaves like a real
  // SUCCESSFUL `gh` call that simply found nothing — zero exit, valid JSON,
  // an empty/null result — never throwing. Must resolve exactly as an
  // ordinary absence always has: no fail-closed stall on ordinary evidence.
  const github = ghGateway("craigoley", "remudero", { exec: () => "null" });
  const proj = deriveStatus(task({ pr: 5, status: "merged" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "none");
  assert.equal(proj.merged, false);
  assert.equal(proj.indeterminate, undefined, "the indeterminate path must NOT be taken for a clean not-found");
  assert.equal(proj.unavailableReason, undefined);
  assert.equal(github.readFailed?.(), false);
});

test("W1-T256: the REAL ghGateway.findMergedByHeadBranch queries merged PRs by the structured head:run-<taskId>- ref (NOT the body index), and credits an owned hit end-to-end", () => {
  // W1-T523: the search transport moved off `gh pr list --search` (GraphQL) onto `gh api
  // search/issues?q=...` (REST) — the query-qualifier language (`in:body`/`head:`) is unchanged,
  // only the argv shape carrying it is, so this asserts the SAME corroboration behavior against
  // the NEW shape rather than the old one.
  const capturedQueries: string[] = [];
  const github = ghGateway("craigoley", "remudero", {
    exec: (args) => {
      const arg1 = typeof args[1] === "string" ? args[1] : "";
      if (args[0] === "api" && arg1.startsWith("search/issues?q=")) {
        const q = decodeURIComponent(arg1.slice("search/issues?q=".length).split("&")[0]);
        capturedQueries.push(q);
        if (q.includes("in:body")) return JSON.stringify({ items: [] }); // eventually-consistent body search MISSED it
        if (q.includes("head:")) {
          // the deterministic head-ref search finds this task's own merged run PR (headRefName
          // rides in on a bounded follow-up single-PR REST read — search/issues carries no head).
          return JSON.stringify({
            items: [{ number: 61, html_url: "u/61", state: "closed", pull_request: { merged_at: "2026-01-01T00:00:00Z" } }],
          });
        }
        return JSON.stringify({ items: [] });
      }
      if (args[0] === "api" && arg1 === "repos/craigoley/remudero/pulls/61") {
        return JSON.stringify({ number: 61, html_url: "u/61", head: { ref: "run-W1-T12a-1784124446138" } });
      }
      return JSON.stringify({ items: [] });
    },
  });
  const proj = deriveStatus(task({ id: "W1-T12a" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.merged, true, "the empty body search is corroborated by the head-ref read");
  assert.equal(proj.source, "head-branch");
  assert.equal(proj.prNumber, 61);
  assert.ok(
    capturedQueries.some((q) => q.includes("head:run-W1-T12a-")),
    `expected a head:run-W1-T12a- ref search (structured, not in:body); saw ${JSON.stringify(capturedQueries)}`,
  );
});

test("a ledger PR that 404s falls through to the next source", () => {
  const url = "https://github.com/craigoley/remudero/pull/7";
  const fixture = ownedTrailerFixture("W1-TX", "W1-TX-1730000000000");
  // prByRef returns null for the ledger url (deleted PR), but the trailer resolves.
  const github = fakeGitHub({
    byTrailer: { "W1-TX": { number: 8, url: "u/8", state: "MERGED" } },
    headRefByUrl: { "u/8": fixture.headRefName },
    bodyByUrl: { "u/8": fixture.body },
  });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "W1-TX", pr_url: url }]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.source, "trailer");
  assert.equal(proj.prNumber, 8);
});

// ── W1-T69: the FOUR acceptance criteria (deriveStatus crediting integrity, P16) ──────────

test("W1-T69 C1: a foreign plan PR (head=plan/*, body QUOTES the trailer in prose) never credits — rejected_candidates NAMES it with a reason", () => {
  // The exact 2026-07-16 W1-T20c shape: a plan/ratify PR whose body discusses the
  // trailer mid-prose; GitHub's fuzzy body search surfaces it, but it is not this
  // task's own run-branch. It must not credit — and the rejection must be LEGIBLE.
  const github = fakeGitHub({
    byTrailer: { "W1-T20c": { number: 128, url: "u/128", state: "MERGED" } },
    headRefByUrl: { "u/128": "plan/renumber-duplicate-p21" }, // NOT run-W1-T20c-<N>
    bodyByUrl: { "u/128": "This PR discusses the `Remudero-Task: W1-T20c` trailer mid-prose." },
  });
  const proj = deriveStatus(task({ id: "W1-T20c" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "none");
  assert.equal(proj.merged, false);
  // REASON STRING UPDATED by the 2026-07-30 trailer-credit ruling, NOT the outcome: this body
  // mentions the trailer MID-PROSE, so `hasAnchoredTrailer` was already false and the refusal is
  // unchanged (source=none, merged=false — asserted above). What changed is truthfulness: the old
  // ternary tested the branch FIRST and so blamed "head-branch-not-owned" when the real cause was
  // the unanchored trailer. The reason now mirrors the accept test's own order of refusal.
  assert.deepEqual(proj.rejected_candidates, [{ pr: "u/128", reason: "trailer-not-anchored" }]);
});

test("W1-T69 C2: a genuine run PR (anchored trailer + run-<taskId>-N head) credits exactly as today — source=trailer, nothing rejected", () => {
  const github = fakeGitHub({
    byTrailer: { "W1-TX": { number: 12, url: "u/12", state: "MERGED" } },
    headRefByUrl: { "u/12": "run-W1-TX-1784000000000" },
    bodyByUrl: { "u/12": "Implements it.\n\nRemudero-Task: W1-TX\n" },
  });
  const proj = deriveStatus(task({ id: "W1-TX" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "trailer");
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 12);
  assert.equal(proj.rejected_candidates, undefined); // a clean credit rejects nothing
});

test("W1-T69 C3: a correction.provenance line credits the actual_pr_url (B), OVERRIDING the search hit (A) — the #80→#91 shape", () => {
  const A = "u/80"; // the mis-attributed PR the search still turns up
  const B = "u/91"; // the operator's corrected, real PR
  const github = fakeGitHub({
    byTrailer: { "W1-TX": { number: 80, url: A, state: "MERGED" } }, // search returns A
    byRef: { [B]: { number: 91, url: B, state: "MERGED" } }, // B is a real merged PR
    // A would even pass ownership+anchor — the correction still overrides it.
    headRefByUrl: { [A]: "run-W1-TX-1730000000000" },
    bodyByUrl: { [A]: "Remudero-Task: W1-TX\n" },
  });
  const ledgerPath = ledgerFile([
    { step: "correction.provenance", task_id: "W1-TX", claimed_pr_url: A, actual_pr_url: B, by: "operator", reason: "misattributed" },
  ]);
  const proj = deriveStatus(task({ id: "W1-TX" }), { ledgerPath, github });
  assert.equal(proj.source, "correction");
  assert.equal(proj.prNumber, 91); // credits B, never A
  assert.equal(proj.merged, true);
});

test("W1-T69 C4: a dependent task is NOT runnable when its dependency's only merge evidence is a foreign-body match", () => {
  const t20c = task({ id: "W1-T20c", depends_on: [] });
  const t20d = task({ id: "W1-T20d", depends_on: ["W1-T20c"] });
  // Declare W1-T20d FIRST so a pass only happens by SKIPPING it on an unmet dep.
  const plan: Plan = { tasks: [t20d, t20c], byId: new Map([["W1-T20c", t20c], ["W1-T20d", t20d]]) };
  // W1-T20c's ONLY GitHub evidence is a foreign plan PR quoting its trailer -> deriveStatus = none.
  const github = fakeGitHub({
    byTrailer: { "W1-T20c": { number: 128, url: "u/128", state: "MERGED" } },
    headRefByUrl: { "u/128": "plan/some-plan-branch" },
    bodyByUrl: { "u/128": "mentions Remudero-Task: W1-T20c in prose only" },
  });
  const ledgerPath = ledgerFile([]);
  const isMerged: MergedSet = (id) => deriveStatus(plan.byId.get(id)!, { ledgerPath, github }).merged;
  assert.equal(isMerged("W1-T20c"), false); // the foreign-body match did NOT credit the linter task
  // W1-T20c IS runnable (not merged, no deps); W1-T20d is NOT (its sole dep is uncredited) —
  // nextRunnable picks W1-T20c even though W1-T20d is declared first.
  assert.equal(nextRunnable(plan, isMerged)?.id, "W1-T20c");
});

// ── W1-T75 (ratifies P9): operator corrections are SUPREME — hoisted above rung (a) ──────

test("W1-T75: the canonical W1-T20c/#134 stranding — a correction credits a merged PR on a fix/* head even though the LAST pr.opened line is a CLOSED superseded run", () => {
  const closedRunPr = "https://github.com/craigoley/remudero/pull/125"; // rung (a): the closed, superseded run
  const handFixPr = "https://github.com/craigoley/remudero/pull/134"; // the operator's correction target: a fix/* PR
  const github = fakeGitHub({
    byRef: {
      [closedRunPr]: { number: 125, url: closedRunPr, state: "CLOSED" },
      [handFixPr]: { number: 134, url: handFixPr, state: "MERGED" },
    },
    // #134 is a hand-authored fix/* PR — it would FAIL the run-branch ownership
    // assert if it were ever subjected to it (design point 2: it must not be).
    headRefByUrl: { [handFixPr]: "fix/w1t20c-style" },
  });
  const ledgerPath = ledgerFile([
    { step: "pr.opened", task_id: "W1-T20c", pr_url: closedRunPr },
    { step: "correction.provenance", task_id: "W1-T20c", claimed_pr_url: closedRunPr, actual_pr_url: handFixPr },
  ]);

  const proj = deriveStatus(task({ id: "W1-T20c" }), { ledgerPath, github });
  assert.equal(proj.source, "correction");
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 134);
  assert.ok(!github.calls.includes("headRefName:" + handFixPr), "a correction is DECLARED credit — never re-subjected to the ownership assert");

  // REGRESSION LOCK: the identical fixture WITHOUT the correction line derives
  // NOT merged — rung (a) resolves to the CLOSED run and nothing else is
  // consulted, exactly today's (pre-fix) stranding.
  const noCorrectionLedger = ledgerFile([{ step: "pr.opened", task_id: "W1-T20c", pr_url: closedRunPr }]);
  const projNoCorrection = deriveStatus(task({ id: "W1-T20c" }), { ledgerPath: noCorrectionLedger, github });
  assert.equal(projNoCorrection.merged, false);
  assert.equal(projNoCorrection.source, "ledger");
});

test("W1-T75: a correction beats a LIVE rung (a) ledger line (an OPEN pr.opened, not merely a closed/stale one)", () => {
  const rungAUrl = "u/50";
  const correctedUrl = "u/51";
  const github = fakeGitHub({
    byRef: {
      [rungAUrl]: { number: 50, url: rungAUrl, state: "OPEN" },
      [correctedUrl]: { number: 51, url: correctedUrl, state: "MERGED" },
    },
  });
  const ledgerPath = ledgerFile([
    { step: "pr.opened", task_id: "W1-TX", pr_url: rungAUrl },
    { step: "correction.provenance", task_id: "W1-TX", claimed_pr_url: rungAUrl, actual_pr_url: correctedUrl },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.source, "correction");
  assert.equal(proj.merged, true);
  assert.ok(!github.calls.includes(`prByRef:${rungAUrl}`), "rung (a) must never even be queried once a correction exists");
});

test("W1-T75: a correction beats rung (b)'s explicit pr: field", () => {
  const correctedUrl = "u/61";
  const github = fakeGitHub({
    byRef: {
      "60": { number: 60, url: "u/60", state: "MERGED" }, // the pr: field's target — would credit if reached
      [correctedUrl]: { number: 61, url: correctedUrl, state: "MERGED" },
    },
  });
  const ledgerPath = ledgerFile([
    { step: "correction.provenance", task_id: "W1-TX", claimed_pr_url: "u/60", actual_pr_url: correctedUrl },
  ]);
  const proj = deriveStatus(task({ pr: 60 }), { ledgerPath, github });
  assert.equal(proj.source, "correction");
  assert.equal(proj.prNumber, 61);
  assert.ok(!github.calls.includes("prByRef:60"), "rung (b) must never even be queried once a correction exists");
});

// ── buildBatchedGithub: one fetch backs all methods (the board-hang fix) ──────────────────────────

test("buildBatchedGithub: N method calls trigger ONE fetch (O(1)), refreshing only after the TTL", () => {
  let fetchCalls = 0;
  let clock = 1000;
  const gh = buildBatchedGithub("o", "r", {
    ttlMs: 100,
    now: () => clock,
    fetchAll: () => {
      fetchCalls++;
      return [];
    },
  });
  // 200 method calls within the TTL window -> exactly ONE fetch (the pre-fix gateway made one gh
  // subprocess PER call — this is the O(N)->O(1) proof at the gateway level).
  for (let i = 0; i < 200; i++) gh.findMergedByTrailer(`W1-T${i}`);
  assert.equal(fetchCalls, 1);
  clock += 150; // past the 100ms TTL
  gh.findMergedByTrailer("W1-T0");
  assert.equal(fetchCalls, 2); // refreshed -> the board stays live
});

test("buildBatchedGithub.findMergedByTrailer matches the ANCHORED trailer line, never a substring", () => {
  const prs: BatchedPr[] = [
    { number: 10, url: "u10", state: "MERGED", headRefName: "run-W1-T15-x", body: "work\nRemudero-Task: W1-T15\n" },
    { number: 20, url: "u20", state: "MERGED", headRefName: "run-W1-T1-y", body: "work\nRemudero-Task: W1-T1\n" },
  ];
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => prs });
  // "W1-T1" must NOT mis-select the "W1-T15" PR (a naive .includes("Remudero-Task: W1-T1") would).
  assert.equal(gh.findMergedByTrailer("W1-T1")?.number, 20);
  assert.equal(gh.findMergedByTrailer("W1-T15")?.number, 10);
  assert.equal(gh.findMergedByTrailer("W1-T999"), null);
});

test("buildBatchedGithub.prByRef resolves by url and by number; headRefName/prBody read the index", () => {
  const prs: BatchedPr[] = [
    { number: 42, url: "https://github.com/o/r/pull/42", state: "OPEN", headRefName: "run-W1-T7-z", body: "b42" },
  ];
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => prs });
  assert.equal(gh.prByRef("https://github.com/o/r/pull/42")?.state, "OPEN");
  assert.equal(gh.prByRef(42)?.number, 42);
  assert.equal(gh.prByRef(999), null);
  assert.equal(gh.headRefName("https://github.com/o/r/pull/42"), "run-W1-T7-z");
  assert.equal(gh.prBody("https://github.com/o/r/pull/42"), "b42");
});

test("buildBatchedGithub.findMergedByTrailer returns the NEWEST (highest-number) merged PR on a duplicate trailer", () => {
  const prs: BatchedPr[] = [
    { number: 5, url: "old", state: "MERGED", body: "Remudero-Task: W1-T3\n" },
    { number: 9, url: "new", state: "MERGED", body: "Remudero-Task: W1-T3\n" },
    { number: 7, url: "openone", state: "OPEN", body: "Remudero-Task: W1-T3\n" }, // OPEN is not "merged"
  ];
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => prs });
  assert.equal(gh.findMergedByTrailer("W1-T3")?.url, "new");
});

// ── buildBatchedGithub.warm (W1-T154): the pre-warm hook lib/serve.ts's boot sequence calls ────
//
// "PRE-WARM: build + fetch the batched gateway at serve BOOT and refresh it in the BACKGROUND on
// its TTL, so the first request serves from a warm cache and never pays the cold fetch" — proven
// here at the gateway level (lib/serve.ts's prewarmBoardGithub is proven separately, against the
// assembled server, in test/serve.test.ts): `.warm()` forces the SAME lazy fetch every OTHER
// method already triggers, so a caller (boot) can force it BEFORE any request/method call, and a
// periodic caller (a background timer) re-forces it once the TTL has actually elapsed — exactly
// {@link buildBatchedGithub}'s existing `now()`-driven TTL check, no separate "force" branch.

test("buildBatchedGithub.warm(): forces the fetch immediately, with NO query method called first", () => {
  let fetchCalls = 0;
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => { fetchCalls++; return []; } });
  assert.equal(fetchCalls, 0, "sanity: the fetch is still lazy until warm()/a query forces it");
  gh.warm?.();
  assert.equal(fetchCalls, 1, "warm() must force the fetch NOW — the whole point of a boot-time pre-warm");
});

test("buildBatchedGithub.warm(): a SECOND warm() within the TTL does not refetch; past the TTL it does (background-refresh semantics)", () => {
  let fetchCalls = 0;
  let clock = 1000;
  const gh = buildBatchedGithub("o", "r", {
    ttlMs: 100,
    now: () => clock,
    fetchAll: () => { fetchCalls++; return []; },
  });
  gh.warm?.();
  assert.equal(fetchCalls, 1);
  gh.warm?.(); // still within the TTL -- a background timer ticking faster than the TTL must not spam `gh`
  assert.equal(fetchCalls, 1);
  clock += 150; // past the 100ms TTL -- the NEXT background tick's warm() call
  gh.warm?.();
  assert.equal(fetchCalls, 2, "a warm() call past the TTL must refresh — this backs the background-refresh timer");
});

test("buildBatchedGithub.warm(): after warming, the FIRST query method resolves with ZERO additional fetches (the request path is never cold)", () => {
  let fetchCalls = 0;
  const prs: BatchedPr[] = [{ number: 1, url: "u1", state: "MERGED", body: "Remudero-Task: W1-T9\n" }];
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => { fetchCalls++; return prs; } });
  gh.warm?.();
  assert.equal(fetchCalls, 1);
  // The first real "request" (a query method) after warm() -- must serve from the already-warm
  // cache, not trigger its own fetch (the falsifier: "a first request that triggers the cold
  // fetch FAILS").
  assert.equal(gh.findMergedByTrailer("W1-T9")?.number, 1);
  assert.equal(fetchCalls, 1, "the first query after warm() must add ZERO fetches");
});

// ── P29(ii): the per-task dispatch CIRCUIT BREAKER — §9's per-WORKER runaway
// tripwire's per-TASK dual (the W1-T1 storm tripped no per-run budget cap
// because no single RUN ran away; the whole TASK did, across ~130 runs).

test("P29(ii) dispatchesWithoutNewOwnedPr: counts run.start lines for a task, resetting to 0 on a NEW pr.opened line", () => {
  const lines = [
    { task_id: "W1-T29", step: "run.start" },
    { task_id: "W1-T29", step: "run.start" },
    { task_id: "OTHER", step: "run.start" }, // a different task must never contribute
    { task_id: "W1-T29", step: "pr.opened", pr_url: "u/1" }, // forward progress — resets the streak
    { task_id: "W1-T29", step: "run.start" },
  ];
  assert.equal(dispatchesWithoutNewOwnedPr(lines, "W1-T29"), 1, "only the ONE run.start after the reset counts");
});

test("P29(ii) dispatchesWithoutNewOwnedPr: a task never dispatched at all counts zero", () => {
  assert.equal(dispatchesWithoutNewOwnedPr([], "W1-T29"), 0);
});

test("P29(ii) isDispatchBreakerTripped: trips at exactly N dispatches with no new owned PR, not N-1 (the seeded W1-T1/W1-T29 shape)", () => {
  const runStartsOnly = (taskId: string, n: number) =>
    Array.from({ length: n }, () => ({ task_id: taskId, step: "run.start" }));
  const nMinus1 = runStartsOnly("W1-T1", DEFAULT_MAX_TASK_DISPATCHES - 1);
  const n = runStartsOnly("W1-T1", DEFAULT_MAX_TASK_DISPATCHES);
  assert.equal(isDispatchBreakerTripped(nMinus1, "W1-T1"), false, "N-1 dispatches must not trip the breaker yet");
  assert.equal(isDispatchBreakerTripped(n, "W1-T1"), true, "the Nth dispatch with no new owned PR trips it");
});

test("P29(ii) isDispatchBreakerTripped: a policy-data override (rule 2) changes the cap with zero code changes", () => {
  const twoDispatches = [
    { task_id: "W1-T1", step: "run.start" },
    { task_id: "W1-T1", step: "run.start" },
  ];
  assert.equal(isDispatchBreakerTripped(twoDispatches, "W1-T1"), false, "under the DEFAULT cap, 2 dispatches is not tripped");
  assert.equal(isDispatchBreakerTripped(twoDispatches, "W1-T1", 2), true, "an overridden cap of 2 trips at exactly 2");
});

// ── W1-T155: the board projection's FULL status taxonomy (in-flight+phase, blocked,
// needs-human, armed-awaiting-merge) + startedAt/elapsed, joined from the ledger run state ──

test("W1-T155: in-flight recon phase — a bare run.start yields status=running, phase=recon, startedAt from the run.start ts", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([{ ts: "2026-07-20T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" }]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-07-20T10:00:05.000Z") });
  assert.equal(proj.merged, false);
  assert.equal(proj.status, "running");
  assert.equal(proj.phase, "recon");
  assert.equal(proj.startedAt, "2026-07-20T10:00:00.000Z");
  assert.equal(proj.elapsedMs, 5000);
});

test("W1-T155: in-flight implement phase — recon.done advances the phase past recon", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([
    { ts: "2026-07-20T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { ts: "2026-07-20T10:01:00.000Z", run_id: "r1", task_id: "W1-TX", step: "recon.done" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-07-20T10:01:05.000Z") });
  assert.equal(proj.status, "running");
  assert.equal(proj.phase, "implement");
});

test("W1-T155: in-flight review phase — implement.done (PR not yet opened) advances the phase to review", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([
    { ts: "2026-07-20T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { ts: "2026-07-20T10:01:00.000Z", run_id: "r1", task_id: "W1-TX", step: "recon.done" },
    { ts: "2026-07-20T10:02:00.000Z", run_id: "r1", task_id: "W1-TX", step: "implement.done" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-07-20T10:02:05.000Z") });
  assert.equal(proj.status, "running");
  assert.equal(proj.phase, "review");
});

test("W1-T155: in-flight review phase — an OPEN pr.opened also puts a task in review, WITH the resolved PR attached", () => {
  const url = "https://github.com/craigoley/remudero/pull/50";
  const github = fakeGitHub({ byRef: { [url]: { number: 50, url, state: "OPEN" } } });
  const ledgerPath = ledgerFile([
    { ts: "2026-07-20T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "pr.opened", pr_url: url },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.status, "running");
  assert.equal(proj.phase, "review");
  assert.equal(proj.prUrl, url);
});

test("W1-T155: in-flight fix-rung phase — fix.dispatch advances the phase to fix-rung", () => {
  const url = "https://github.com/craigoley/remudero/pull/51";
  const github = fakeGitHub({ byRef: { [url]: { number: 51, url, state: "OPEN" } } });
  const ledgerPath = ledgerFile([
    { ts: "2026-07-20T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "pr.opened", pr_url: url },
    { run_id: "r1", task_id: "W1-TX", step: "fix.dispatch" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.status, "running");
  assert.equal(proj.phase, "fix-rung");
});

test("W1-T155: fix.resolved returns the phase to review (post-fix re-check), not back to fix-rung", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([
    { ts: "2026-07-20T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "fix.dispatch" },
    { run_id: "r1", task_id: "W1-TX", step: "fix.resolved" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-07-20T10:00:05.000Z") });
  assert.equal(proj.phase, "review");
});

test("W1-T155: a stale/earlier phase is NEVER reported — a NEW run.start resets to recon, even though the OLDER run reached fix-rung", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([
    // Run 1: reached fix-rung, then concluded (verdict) — stale history.
    { ts: "2026-07-20T09:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "fix.dispatch" },
    { run_id: "r1", task_id: "W1-TX", step: "verdict", verdict: "blocked_review" },
    // Run 2: a fresh redispatch, only just started.
    { ts: "2026-07-20T11:00:00.000Z", run_id: "r2", task_id: "W1-TX", step: "run.start" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-07-20T11:00:30.000Z") });
  assert.equal(proj.phase, "recon", "the CURRENT run's phase, not the stale/earlier run's fix-rung");
  assert.equal(proj.startedAt, "2026-07-20T11:00:00.000Z", "the CURRENT run's own start, not the earlier run's");
  assert.equal(proj.elapsedMs, 30_000);
});

test("W1-T155: a verdict line ends the in-flight run — no phase/startedAt/elapsed once concluded (and no GitHub evidence follows)", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([
    { ts: "2026-07-20T09:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "recon.done" },
    { run_id: "r1", task_id: "W1-TX", step: "verdict", verdict: "blocked_transient" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.status, "queued");
  assert.equal(proj.phase, undefined);
  assert.equal(proj.startedAt, undefined);
  assert.equal(proj.elapsedMs, undefined);
});

test("W1-T155: blocked (a CLOSED PR) is never overridden by a phase, even if the ledger also shows an unresolved run.start", () => {
  const url = "https://github.com/craigoley/remudero/pull/52";
  const github = fakeGitHub({ byRef: { [url]: { number: 52, url, state: "CLOSED" } } });
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "pr.opened", pr_url: url },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.status, "blocked");
  assert.equal(proj.phase, undefined);
});

test("W1-T155: merged is terminal — phase/needsHuman/armedAwaitingMerge never attach even when the ledger has an escalation and an unresolved run.start", () => {
  const url = "https://github.com/craigoley/remudero/pull/53";
  const github = fakeGitHub({ byRef: { [url]: { number: 53, url, state: "MERGED" } }, autoMergeByUrl: { [url]: true } });
  const ledgerPath = ledgerFile([
    { run_id: "r0", task_id: "W1-TX", step: "escalation.issue_opened", issue_url: "https://github.com/o/r/issues/1" },
    { run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "pr.opened", pr_url: url },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.status, "merged");
  assert.equal(proj.merged, true);
  assert.equal(proj.phase, undefined);
  assert.equal(proj.needsHuman, undefined);
  assert.equal(proj.armedAwaitingMerge, undefined);
});

test("W1-T155: needs-human — an escalation.issue_opened with no LATER run.start", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "fix.dispatch" },
    { run_id: "r1", task_id: "W1-TX", step: "fix.exhausted" },
    { run_id: "r1", task_id: "W1-TX", step: "escalation.issue_opened", issue_url: "https://github.com/o/r/issues/9", class: "BLOCKED" },
    { run_id: "r1", task_id: "W1-TX", step: "verdict", verdict: "blocked_review" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.needsHuman, true);
});

test("W1-T155: needs-human is superseded by a NEW run.start since the escalation — the task was redispatched", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "escalation.issue_opened", issue_url: "https://github.com/o/r/issues/9", class: "BLOCKED" },
    { run_id: "r1", task_id: "W1-TX", step: "verdict", verdict: "blocked_review" },
    { ts: "2026-07-20T12:00:00.000Z", run_id: "r2", task_id: "W1-TX", step: "run.start" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-07-20T12:00:05.000Z") });
  assert.equal(proj.needsHuman, undefined, "a redispatch since the escalation supersedes it");
  assert.equal(proj.phase, "recon", "and the task is genuinely back in flight");
});

// ── W1-T182: NEEDS ME joins LIVE escalation state, not ledger history ───────────────────────

test("W1-T182: a CLOSED escalation does not render — the join reflects live state, not ledger history", () => {
  // The exact operator fixture: #393/#395/#401 were each closed by hand after the ledger's
  // last line for the task was still `escalation.issue_opened` — the OLD `hasOpenEscalation`
  // returned true from that ledger shape alone, forever, because the ledger is append-only.
  const issueUrl = "https://github.com/o/r/issues/393";
  const github = fakeGitHub({ issuesByUrl: { [issueUrl]: { state: "CLOSED", title: "[BLOCKED] W1-TX: stuck" } } });
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.needsHuman, undefined, "a CONFIRMED closed issue must clear the row");
  assert.equal(proj.escalationIssueUrl, undefined);
});

// W1-T182 round 3: this test's NAME is the acceptance criterion's own dialect proof text,
// VERBATIM (plan/tasks.yaml, "unit test: a task whose escalation issue reads OPEN remains
// needsHuman and renders. FALSIFIER: ..."), so `--test-name-pattern` (review.ts's dialect
// executor, W1-T72) matches and RUNS this exact test rather than reporting zero matches ⇒ fail.
// Round 1/2 named this test with paraphrased prose that never matched the proof's own pattern,
// so the mechanical floor's dialect executor found zero real matches and reported
// "proof executed and FAILED" every round regardless of behavior — a naming defect, not a
// behavioral one. Body unchanged from round 1/2: an issue read CONFIRMED OPEN still renders.
test(
  "W1-T182: a task whose escalation issue reads OPEN remains needsHuman and renders. " +
    "FALSIFIER: a change that keys the section off anything that also drops genuinely open " +
    "escalations, which would silently empty the operator's work list — the more dangerous " +
    "direction of this bug",
  () => {
    const issueUrl = "https://github.com/o/r/issues/9";
    const github = fakeGitHub({
      issuesByUrl: { [issueUrl]: { state: "OPEN", title: "[BLOCKED] W1-TX: needs a decision" } },
    });
    const ledgerPath = ledgerFile([
      { run_id: "r1", task_id: "W1-TX", step: "run.start" },
      { run_id: "r1", task_id: "W1-TX", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" },
    ]);
    const proj = deriveStatus(task(), { ledgerPath, github });
    assert.equal(proj.needsHuman, true, "a CONFIRMED open escalation must still render — the fix must not drop live work");
    assert.equal(proj.escalationIssueUrl, issueUrl, "a direct link, never a URL the operator must supply");
    assert.equal(proj.escalationTitle, "[BLOCKED] W1-TX: needs a decision");
    assert.equal(proj.escalationUnverified, undefined, "a CONFIRMED open read is not unverified");
  },
);

// W1-T182 round 3: same naming fix as the OPEN test above — this test's NAME is now the
// acceptance criterion's own dialect proof text VERBATIM (plan/tasks.yaml, "unit test: a
// seeded issue-state read failure retains the row and flags it unverified rather than
// dropping it. FALSIFIER: ..."), so review.ts's `--test-name-pattern` dialect executor
// (W1-T72) actually finds and runs this test instead of reporting zero matches ⇒ fail.
// Body unchanged from round 1/2: an unreadable issue state (no issueByUrl support at all)
// fails closed — the row stays, marked unverified.
test(
  "W1-T182: a seeded issue-state read failure retains the row and flags it unverified " +
    "rather than dropping it. FALSIFIER: dropping rows on a read failure, which during a " +
    "GitHub outage would show an empty NEEDS ME section and tell the operator there is " +
    "nothing to do",
  () => {
    const issueUrl = "https://github.com/o/r/issues/9";
    // Every pre-W1-T182 GitHub fixture — a literal object with none of this task's new methods.
    const bareGithub: GitHub = {
      prByRef: () => null,
      findMergedByTrailer: () => null,
      headRefName: () => undefined,
      prBody: () => undefined,
    };
    const ledgerPath = ledgerFile([
      { run_id: "r1", task_id: "W1-TX", step: "run.start" },
      { run_id: "r1", task_id: "W1-TX", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" },
    ]);
    const proj = deriveStatus(task(), { ledgerPath, github: bareGithub });
    assert.equal(proj.needsHuman, true, "an unreadable state must never silently empty the operator's work list");
    assert.equal(proj.escalationUnverified, true);
    assert.equal(proj.escalationIssueUrl, issueUrl);
  },
);

test("W1-T182: an UNREADABLE issue state (issueByUrl implemented but this url unresolved) also fails closed", () => {
  const issueUrl = "https://github.com/o/r/issues/9";
  const github = fakeGitHub({ issuesByUrl: {}, issueReadFailed: true }); // simulates a failed batched fetch
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.needsHuman, true);
  assert.equal(proj.escalationUnverified, true);
});

test("W1-T182: buildBatchedGithub resolves escalation issue state through ONE batched `gh issue list` fetch, not one call per escalated row", () => {
  let issueFetchCalls = 0;
  const issues: BatchedIssue[] = Array.from({ length: 44 }, (_, i) => ({
    number: i,
    url: `https://github.com/o/r/issues/${i}`,
    state: i === 0 ? "OPEN" : "CLOSED",
    title: `[BLOCKED] W1-T${i}: stuck`,
  }));
  const github = buildBatchedGithub("o", "r", {
    fetchAll: () => [],
    fetchAllIssues: () => {
      issueFetchCalls++;
      return issues;
    },
  });
  const tasks: Task[] = Array.from({ length: 44 }, (_, i) => task({ id: `W1-T${i}` }));
  const plan: Plan = { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
  const ledgerPath = ledgerFile(
    tasks.map((t, i) => ({
      task_id: t.id,
      step: "escalation.issue_opened",
      run_id: `r${i}`,
      issue_url: `https://github.com/o/r/issues/${i}`,
      class: "BLOCKED",
    })),
  );
  const byId = projectPlan(plan, { ledgerPath, github });
  assert.equal(byId.get("W1-T0")?.needsHuman, true, "the one OPEN issue still renders");
  assert.equal(byId.get("W1-T1")?.needsHuman, undefined, "every CLOSED issue is dropped");
  assert.equal(byId.get("W1-T43")?.needsHuman, undefined);
  assert.equal(issueFetchCalls, 1, "ONE batched issue fetch backs all 44 escalated rows, never O(N)");
});

test("W1-T182: buildBatchedGithub's issueByUrl fails closed (issueReadFailed=true) when the batched issue fetch itself throws", () => {
  const github = buildBatchedGithub("o", "r", {
    fetchAll: () => [],
    fetchAllIssues: () => {
      throw Object.assign(new Error("rate limited"), { status: 1, stderr: "API rate limit exceeded" });
    },
  });
  assert.equal(github.issueByUrl?.("https://github.com/o/r/issues/1"), null);
  assert.equal(github.issueReadFailed?.(), true);
});

test("W1-T182: an escalation.issue_opened line with NO issue_url (malformed/pre-W1-T8 ledger shape) still renders needsHuman, unverified — the absence of a join target never suppresses the row", () => {
  const github = fakeGitHub({}); // issueByUrl would never even be called — there's no url to look up
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "escalation.issue_opened" }, // no issue_url field at all
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.needsHuman, true);
  assert.equal(proj.escalationUnverified, true);
  assert.equal(proj.escalationIssueUrl, undefined);
});

test("W1-T182: an OPEN escalation renders regardless of the issue-state casing convention (\"OPEN\" or lowercase \"open\") -- two conventions genuinely coexist in this repo (gh issue view/list use uppercase; issues-intake.ts's gh api reader already sees lowercase)", () => {
  const issueUrl = "https://github.com/o/r/issues/9";
  for (const state of ["OPEN", "open", "Open"]) {
    const github = fakeGitHub({ issuesByUrl: { [issueUrl]: { state, title: "needs a decision" } } });
    const ledgerPath = ledgerFile([
      { run_id: "r1", task_id: "W1-TX", step: "run.start" },
      { run_id: "r1", task_id: "W1-TX", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" },
    ]);
    const proj = deriveStatus(task(), { ledgerPath, github });
    assert.equal(proj.needsHuman, true, `state=${state} must still render`);
    assert.equal(proj.escalationUnverified, undefined, `state=${state} is a CONFIRMED open read, not unverified`);
  }
});

test("W1-T182: a CLOSED escalation drops the row regardless of casing (\"CLOSED\" or lowercase \"closed\")", () => {
  const issueUrl = "https://github.com/o/r/issues/393";
  for (const state of ["CLOSED", "closed", "Closed"]) {
    const github = fakeGitHub({ issuesByUrl: { [issueUrl]: { state } } });
    const ledgerPath = ledgerFile([
      { run_id: "r1", task_id: "W1-TX", step: "run.start" },
      { run_id: "r1", task_id: "W1-TX", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" },
    ]);
    const proj = deriveStatus(task(), { ledgerPath, github });
    assert.equal(proj.needsHuman, undefined, `state=${state} must clear the row`);
  }
});

test("W1-T182: a THROWING issueByUrl (a gateway/fixture that raises instead of failing soft) never crashes deriveStatus -- fails closed, keeps the row, marks it unverified", () => {
  const issueUrl = "https://github.com/o/r/issues/9";
  const throwingGithub: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    issueByUrl: () => {
      throw new Error("gh issue view: rate limited");
    },
  };
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" },
  ]);
  assert.doesNotThrow(() => deriveStatus(task(), { ledgerPath, github: throwingGithub }));
  const proj = deriveStatus(task(), { ledgerPath, github: throwingGithub });
  assert.equal(proj.needsHuman, true);
  assert.equal(proj.escalationUnverified, true);
});

test("W1-T182: buildBatchedGithub's issueByUrl also resolves by a bare issue NUMBER, mirroring prByRef's flexible ref resolution", () => {
  const github = buildBatchedGithub("o", "r", {
    fetchAll: () => [],
    fetchAllIssues: () => [{ number: 9, url: "https://github.com/o/r/issues/9", state: "OPEN", title: "t" }],
  });
  assert.deepEqual(github.issueByUrl?.("9"), { state: "OPEN", title: "t" });
  assert.deepEqual(github.issueByUrl?.("https://github.com/o/r/issues/9"), { state: "OPEN", title: "t" });
});

test("W1-T155: armed-awaiting-merge — an OPEN PR the batched gateway reports as auto-merge-armed", () => {
  const url = "https://github.com/craigoley/remudero/pull/60";
  const github = fakeGitHub({ byRef: { [url]: { number: 60, url, state: "OPEN" } }, autoMergeByUrl: { [url]: true } });
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "pr.opened", pr_url: url },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.status, "running");
  assert.equal(proj.armedAwaitingMerge, true);
});

test("W1-T155: an OPEN PR NOT armed for auto-merge never sets armedAwaitingMerge", () => {
  const url = "https://github.com/craigoley/remudero/pull/61";
  const github = fakeGitHub({ byRef: { [url]: { number: 61, url, state: "OPEN" } } }); // autoMergeByUrl omitted
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "pr.opened", pr_url: url },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.status, "running");
  assert.equal(proj.armedAwaitingMerge, undefined);
});

test("W1-T155: a GitHub gateway with no autoMergeArmed method at all (every pre-W1-T155 fixture) degrades fail-soft — never armed, never throws", () => {
  const url = "https://github.com/craigoley/remudero/pull/62";
  const bareGithub: GitHub = {
    prByRef: (ref) => (String(ref) === url ? { number: 62, url, state: "OPEN" } : null),
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { run_id: "r1", task_id: "W1-TX", step: "pr.opened", pr_url: url },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github: bareGithub });
  assert.equal(proj.status, "running");
  assert.equal(proj.armedAwaitingMerge, undefined);
});

test("W1-T155: a full-taxonomy projection over a mixed fixture yields a DISTINCT outcome for every state — in-flight (each phase), blocked, needs-human, armed-awaiting-merge, merged, queued", () => {
  const openUrl = "https://github.com/craigoley/remudero/pull/70";
  const armedUrl = "https://github.com/craigoley/remudero/pull/71";
  const closedUrl = "https://github.com/craigoley/remudero/pull/72";
  const mergedUrl = "https://github.com/craigoley/remudero/pull/73";
  const github = fakeGitHub({
    byRef: {
      [openUrl]: { number: 70, url: openUrl, state: "OPEN" },
      [armedUrl]: { number: 71, url: armedUrl, state: "OPEN" },
      [closedUrl]: { number: 72, url: closedUrl, state: "CLOSED" },
      [mergedUrl]: { number: 73, url: mergedUrl, state: "MERGED" },
    },
    autoMergeByUrl: { [armedUrl]: true },
  });

  const projections: Record<string, ReturnType<typeof deriveStatus>> = {};
  const scenarios: Array<[string, Array<Record<string, unknown>>]> = [
    ["recon", [{ task_id: "recon", step: "run.start", ts: "2026-07-20T09:00:00.000Z" }]],
    [
      "implement",
      [
        { task_id: "implement", step: "run.start", ts: "2026-07-20T09:00:00.000Z" },
        { task_id: "implement", step: "recon.done", ts: "2026-07-20T09:01:00.000Z" },
      ],
    ],
    ["review", [{ task_id: "review", step: "run.start" }, { task_id: "review", step: "pr.opened", pr_url: openUrl }]],
    [
      "fixrung",
      [
        { task_id: "fixrung", step: "run.start" },
        { task_id: "fixrung", step: "pr.opened", pr_url: openUrl },
        { task_id: "fixrung", step: "fix.dispatch" },
      ],
    ],
    ["blocked", [{ task_id: "blocked", step: "pr.opened", pr_url: closedUrl }]],
    [
      "needshuman",
      [
        { task_id: "needshuman", step: "run.start" },
        { task_id: "needshuman", step: "escalation.issue_opened", issue_url: "https://github.com/o/r/issues/1" },
        { task_id: "needshuman", step: "verdict", verdict: "blocked_review" },
      ],
    ],
    ["armed", [{ task_id: "armed", step: "run.start" }, { task_id: "armed", step: "pr.opened", pr_url: armedUrl }]],
    ["merged", [{ task_id: "merged", step: "pr.opened", pr_url: mergedUrl }]],
    ["queued", []],
  ];
  const ledgerPath = ledgerFile(scenarios.flatMap(([, lines]) => lines));
  // Close enough to "recon"'s and "implement"'s own ts fixtures to stay inside the
  // liveness bound (W1-T179) -- their in-flight-without-a-PR shape is exactly what that
  // bound gates, so a stale `now` here would silently orphan them instead of testing phase.
  const now = () => Date.parse("2026-07-20T09:02:00.000Z");
  for (const [id] of scenarios) {
    projections[id] = deriveStatus(task({ id }), { ledgerPath, github, now });
  }

  assert.deepEqual(
    { status: projections.recon.status, phase: projections.recon.phase },
    { status: "running", phase: "recon" },
  );
  assert.deepEqual(
    { status: projections.implement.status, phase: projections.implement.phase },
    { status: "running", phase: "implement" },
  );
  assert.deepEqual(
    { status: projections.review.status, phase: projections.review.phase },
    { status: "running", phase: "review" },
  );
  assert.deepEqual(
    { status: projections.fixrung.status, phase: projections.fixrung.phase },
    { status: "running", phase: "fix-rung" },
  );
  assert.equal(projections.blocked.status, "blocked");
  assert.equal(projections.needshuman.needsHuman, true);
  assert.equal(projections.armed.armedAwaitingMerge, true);
  assert.equal(projections.merged.status, "merged");
  assert.equal(projections.queued.status, "queued");

  // Every one of these nine is a genuinely DISTINCT combination — never two collapsing
  // onto the exact same (status, phase, needsHuman, armedAwaitingMerge, merged) tuple.
  const keyOf = (p: (typeof projections)[string]) =>
    JSON.stringify([p.status, p.phase ?? null, p.needsHuman ?? false, p.armedAwaitingMerge ?? false, p.merged]);
  const keys = Object.values(projections).map(keyOf);
  assert.equal(new Set(keys).size, keys.length, "every scenario must project to a DISTINCT taxonomy tuple");
});

test("W1-T155: the full-taxonomy projection over N tasks still makes O(1) gateway fetches (the board-fix invariant, preserved)", () => {
  let fetchCalls = 0;
  const prs: BatchedPr[] = Array.from({ length: 20 }, (_, i) => ({
    number: i,
    url: `u${i}`,
    state: "OPEN",
    autoMergeRequest: i % 2 === 0 ? { enabledAt: "x" } : null,
  }));
  const github = buildBatchedGithub("o", "r", {
    fetchAll: () => {
      fetchCalls++;
      return prs;
    },
  });
  const tasks: Task[] = Array.from({ length: 20 }, (_, i) =>
    task({ id: `W1-T${i}`, pr: i }),
  );
  const plan: Plan = { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
  const ledgerPath = ledgerFile(
    tasks.map((t, i) => ({ task_id: t.id, step: "run.start", run_id: `r${i}` })),
  );
  const byId = projectPlan(plan, { ledgerPath, github });
  assert.equal(byId.size, 20);
  // Every even-indexed task's `pr:` field resolves an OPEN PR with autoMergeRequest set —
  // armedAwaitingMerge must be derivable WITHOUT a second `gh` call per task.
  assert.equal(byId.get("W1-T0")?.armedAwaitingMerge, true);
  assert.equal(byId.get("W1-T1")?.armedAwaitingMerge, undefined);
  assert.equal(fetchCalls, 1, "ONE batched fetch backs the entire N-task projection, not O(N)");
});

// ── W1-T181: the LIVE OUTAGE fix — maxBuffer, a MARKED failure (never a bare []), and
//    observability (classified reason + logging) on the batched board gateway ────────────────

test("classifyGhFailure: an ENOBUFS code classifies as buffer_overflow even with a null status and empty stderr — the EXACT shape execFileSync throws once stdout crosses maxBuffer", () => {
  // Reproduced live (W1-T181): a maxBuffer overflow is raised by Node itself, which kills the
  // child BEFORE `gh` gets a chance to write to stderr or exit normally — status is null and
  // stderr is "". Before this branch existed, that shape fell through every stderr-text regex
  // and classified "unknown", which is exactly why the 2026-07-20 outage surfaced nowhere.
  assert.equal(classifyGhFailure(null, "", "ENOBUFS"), "buffer_overflow");
  assert.equal(classifyGhFailure(undefined, undefined, "ENOBUFS"), "buffer_overflow");
  // A real rate-limit/auth/transport failure must still classify as before when code is absent.
  assert.equal(classifyGhFailure(1, "gh: API rate limit exceeded for user ID 123456. (HTTP 403)"), "rate_limit");
});

test("W1-T181: the batched fetch survives a payload larger than Node's 1 MiB execFileSync default and resolves merged state — reproduces the outage's exact trigger (a body-heavy, N-PRs-wide payload) via an injected exec", () => {
  const PR_COUNT = 700;
  const prs: BatchedPr[] = Array.from({ length: PR_COUNT }, (_, i) => ({
    number: i,
    url: `u${i}`,
    state: i % 2 === 0 ? "MERGED" : "OPEN",
    headRefName: `run-W1-T${i}-1`,
    body: "x".repeat(2000) + `\nRemudero-Task: W1-T${i}\n`,
  }));
  const raw = JSON.stringify(prs);
  assert.ok(
    Buffer.byteLength(raw, "utf8") > 1_048_576,
    "sanity: the seeded payload must actually exceed Node's 1 MiB execFileSync default — the outage's exact trigger",
  );
  const gh = buildBatchedGithub("o", "r", { exec: () => raw });
  // FALSIFIER: pre-W1-T181, execFileSync's default maxBuffer would have thrown ENOBUFS on a
  // payload this size, the catch would have swallowed it and returned [], and both assertions
  // below would fail (findMergedByTrailer -> null, readFailed() -> true).
  assert.equal(gh.findMergedByTrailer("W1-T350")?.number, 350);
  assert.equal(gh.readFailed?.(), false);
});

test("W1-T181: a FAILED batched fetch surfaces a MARKED failure (readFailed/readFailureReason), distinguishable from a genuinely empty PR set — never a bare []", () => {
  // A genuinely empty repo: fetchAll succeeds with zero PRs. Must NOT read as failed.
  const emptyRepo = buildBatchedGithub("o", "r", { fetchAll: () => [] });
  assert.equal(emptyRepo.findMergedByTrailer("W1-T1"), null);
  assert.equal(emptyRepo.readFailed?.(), false, "a real zero-PR repo must never be marked as a failed read");
  assert.equal(emptyRepo.readFailureReason?.(), undefined);

  // The SAME bare-[] outward shape (findMergedByTrailer -> null), but produced by a THROWING
  // fetch — an ENOBUFS-shaped error from the injected `exec`, the real default codepath. This
  // must be TELLABLE APART from the empty-repo case above via readFailed()/readFailureReason().
  const enobufsError = Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS", status: null, stderr: "" });
  const outage = buildBatchedGithub("o", "r", { exec: () => { throw enobufsError; } });
  assert.equal(outage.findMergedByTrailer("W1-T1"), null);
  assert.equal(outage.readFailed?.(), true, "a thrown fetch must mark the read as failed");
  assert.equal(outage.readFailureReason?.(), "buffer_overflow");
});

test("W1-T181: an INJECTED fetchAll that throws (not just the default execFileSync path) is caught and marked, never crashes the caller — the catch now wraps fetchAll() itself, not only the default implementation", () => {
  // FALSIFIER (pre-W1-T181): the try/catch lived ONLY inside the default execFileSync-based
  // fetchAll. An injected fetchAll — every unit-test fixture, and any future caller-supplied
  // implementation — that throws propagated UNCAUGHT out of index() and therefore every GitHub
  // method this gateway returns, crashing the caller instead of degrading to a marked failure.
  const rateLimitError = Object.assign(new Error("Command failed: gh pr list"), {
    status: 1,
    stderr: "gh: API rate limit exceeded for user ID 123456. (HTTP 403)",
  });
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => {
      throw rateLimitError;
    },
  });
  assert.doesNotThrow(() => gh.findMergedByTrailer("W1-T1"));
  assert.equal(gh.findMergedByTrailer("W1-T1"), null);
  assert.equal(gh.readFailed?.(), true);
  assert.equal(gh.readFailureReason?.(), "rate_limit");
});

// ── W1-T468: the board gateway's two REST reads (PR list + issue list) are the FIRST two of the
// daemon tick's three-call burst that trips GitHub's secondary rate limit. `opts.pacer` gates
// each real fetch through a shared `GhCallPacer` so this gateway cannot fire either read without
// waiting its turn — see lib/open-prs-rest.ts's `GhCallPacer`/`paceGhEntry` doc for the mechanism
// and run-task.ts's `buildSweepHook`/`buildOpenPrViews` for the third (sweep enumeration) site. ──

test("W1-T468: buildBatchedGithub's PR-list fetch waits its turn on an injected pacer and reports a clean result back", () => {
  const calls: string[] = [];
  const pacer: GhCallPacer = {
    wait: () => calls.push("wait"),
    recordResult: (rateLimited) => calls.push(`result:${rateLimited}`),
  };
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => [], pacer });
  gh.findMergedByTrailer("W1-T1");
  assert.deepEqual(calls, ["wait", "result:false"], "the pacer gates the real fetch and is told it succeeded");
});

test("W1-T468: a rate-limit-classified PR-list failure is reported back to the pacer as rateLimited=true, so a LATER guarded call slows down", () => {
  const calls: string[] = [];
  const pacer: GhCallPacer = {
    wait: () => calls.push("wait"),
    recordResult: (rateLimited) => calls.push(`result:${rateLimited}`),
  };
  const rateLimitError = Object.assign(new Error("Command failed: gh pr list"), {
    status: 1,
    stderr: "gh: API rate limit exceeded for user ID 123456. (HTTP 403)",
  });
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => { throw rateLimitError; }, pacer });
  assert.doesNotThrow(() => gh.findMergedByTrailer("W1-T1"));
  // W1-T1007: a rate-limit-classified refusal no longer rethrows after ONE report — paceGhEntry
  // now retries the same refused call, bounded by DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS (4),
  // reporting rateLimited=true on every one of the bounded attempts (this fixture's `fetchAll`
  // always throws, so every attempt is refused) before finally giving up. This `pacer` fixture
  // implements only `wait`/`recordResult` — no `sleepSync` — so paceGhEntry's optional-chained
  // backoff wait is a no-op here and this stays instantaneous; see GhCallPacer.sleepSync's own
  // doc (lib/open-prs-rest.ts) for why a fixture written before that task can never hang on it.
  const expected = Array.from({ length: DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS }, () => ["wait", "result:true"]).flat();
  assert.deepEqual(calls, expected, "a rate-limit-classified throw reports rateLimited=true on every bounded attempt, never false");
});

test("W1-T468: a NON-rate-limit PR-list failure reports back rateLimited=false, so an unrelated outage never widens the pacer's gap", () => {
  const calls: string[] = [];
  const pacer: GhCallPacer = {
    wait: () => calls.push("wait"),
    recordResult: (rateLimited) => calls.push(`result:${rateLimited}`),
  };
  const authError = Object.assign(new Error("Command failed: gh pr list"), { status: 1, stderr: "gh: not logged in" });
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => { throw authError; }, pacer });
  assert.doesNotThrow(() => gh.findMergedByTrailer("W1-T1"));
  assert.deepEqual(calls, ["wait", "result:false"], "an auth failure is not a rate-limit signal");
});

test("W1-T468: buildBatchedGithub's issue-list fetch is paced through the SAME pacer instance as the PR-list fetch", () => {
  const calls: string[] = [];
  const pacer: GhCallPacer = {
    wait: () => calls.push("wait"),
    recordResult: (rateLimited) => calls.push(`result:${rateLimited}`),
  };
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => [], fetchAllIssues: () => [], pacer });
  gh.issueByUrl?.("https://github.com/o/r/issues/1");
  assert.deepEqual(calls, ["wait", "result:false"], "the issue fetch is gated and reported exactly like the PR fetch");
});

test("W1-T468: omitting the pacer still runs the fetch exactly once — W1-T1005 changed WHO paces an unpaced gateway, never how many times its fetch fires", () => {
  let fetchCalls = 0;
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => { fetchCalls++; return []; } });
  gh.findMergedByTrailer("W1-T1");
  assert.equal(fetchCalls, 1, "the fetch still runs exactly once with no pacer wired");
});

// ── W1-T1005: `paceGhEntry` opens `if (!pacer) return call()`, so a construction that omits
// `opts.pacer` used to run completely unpaced — no throw, no ledger row, no degraded mode, and
// (per the task's own rationale) 15 of 16 real gateway constructions omitted it. These four
// prove `buildBatchedGithub` now defaults `opts.pacer` to a MODULE-SCOPED shared instance instead
// of leaving that construction to discover the secondary limit on its own — reached via
// `resetDefaultGhCallPacerForTest` (test-only; see its own doc in lib/status.ts) so each test
// controls exactly which pacer the DEFAULT resolves to, independent of the ~140 other tests in
// this file that also build unpaced gateways. Every test restores the default to `undefined` in a
// `finally`, so a later, unrelated test still gets the file's own once-lazily-created real default
// rather than a stale fake left behind here. ──

test("W1-T1005: a gateway built with no pacer is paced by default", () => {
  const calls: string[] = [];
  const fakeDefault: GhCallPacer = {
    wait: () => calls.push("wait"),
    recordResult: (rateLimited) => calls.push(`result:${rateLimited}`),
  };
  resetDefaultGhCallPacerForTest(fakeDefault);
  try {
    // NO `pacer` in opts — this is the exact construction shape that, pre-W1-T1005, left
    // `opts.pacer` `undefined` all the way into `paceGhEntry`, which takes its `if (!pacer)`
    // branch and never touches a pacer at all.
    const gh = buildBatchedGithub("o", "r", { fetchAll: () => [] });
    gh.findMergedByTrailer("W1-T1");
    assert.deepEqual(
      calls,
      ["wait", "result:false"],
      "an unpaced construction's real fetch is gated through the default pacer, not run bare",
    );
  } finally {
    resetDefaultGhCallPacerForTest(undefined);
  }
});

test("W1-T1005: an explicitly supplied pacer is not replaced by the default", () => {
  const defaultCalls: string[] = [];
  const explicitCalls: string[] = [];
  const fakeDefault: GhCallPacer = {
    wait: () => defaultCalls.push("wait"),
    recordResult: (rateLimited) => defaultCalls.push(`result:${rateLimited}`),
  };
  const explicitPacer: GhCallPacer = {
    wait: () => explicitCalls.push("wait"),
    recordResult: (rateLimited) => explicitCalls.push(`result:${rateLimited}`),
  };
  resetDefaultGhCallPacerForTest(fakeDefault);
  try {
    const gh = buildBatchedGithub("o", "r", { fetchAll: () => [], pacer: explicitPacer });
    gh.findMergedByTrailer("W1-T1");
    assert.deepEqual(explicitCalls, ["wait", "result:false"], "the explicit pacer gates the real fetch");
    assert.deepEqual(defaultCalls, [], "the default the caller never asked for is never touched");
  } finally {
    resetDefaultGhCallPacerForTest(undefined);
  }
});

test("W1-T1005: two gateways in one process share one pacer", () => {
  const calls: string[] = [];
  const sharedFake: GhCallPacer = {
    wait: () => calls.push("wait"),
    recordResult: (rateLimited) => calls.push(`result:${rateLimited}`),
  };
  resetDefaultGhCallPacerForTest(sharedFake);
  try {
    // Two SEPARATE buildBatchedGithub constructions, neither given a pacer — exactly the shape
    // design (ii) falsifies: "a fresh pacer per construction would restore exactly today's
    // defect under a new name: three politely-spaced gateways that each know only about
    // themselves still collide at second zero."
    const ghA = buildBatchedGithub("o", "r-a", { fetchAll: () => [] });
    const ghB = buildBatchedGithub("o", "r-b", { fetchAll: () => [] });
    ghA.findMergedByTrailer("W1-T1");
    ghB.findMergedByTrailer("W1-T1");
    assert.deepEqual(
      calls,
      ["wait", "result:false", "wait", "result:false"],
      "both gateways' real fetches are gated through the SAME default instance, in order — a " +
        "per-construction default would leave the second gateway's `calls` entries missing here",
    );
  } finally {
    resetDefaultGhCallPacerForTest(undefined);
  }
});

test("W1-T1005: a rate-limited call widens the gap for the other gateway too", () => {
  // A minimal STATEFUL fake — not the real `createGhCallPacer` — deliberately: the arithmetic
  // behind widening/narrowing the gap is `GhCallPacer`'s own semantics, already owned by
  // test/open-prs-rest.test.ts's `paceGhEntry` suite (per this task's own file-scoping note).
  // What THIS gateway-level test must prove is narrower and different: that gateway B's `wait()`
  // observes the widened state gateway A's `recordResult` set, which only holds if both routed
  // through the identical shared instance.
  //
  // NOT asserted on a fixed count of gateway A's own `wait()`/`recordResult()` calls: W1-T1007
  // added a bounded RETRY loop inside `paceGhEntry` itself, so one rate-limited `fetchAll` now
  // drives several wait()/recordResult(true) rounds on gateway A alone before it gives up — a
  // count this test must stay agnostic to, since that retry count is `paceGhEntry`'s own policy,
  // not this gateway-sharing test's concern.
  let widened = false;
  const widenedAtWait: boolean[] = [];
  const recordedRateLimited: boolean[] = [];
  const sharedFake: GhCallPacer = {
    wait: () => widenedAtWait.push(widened),
    recordResult: (rateLimited) => {
      recordedRateLimited.push(rateLimited);
      if (rateLimited) widened = true;
    },
  };
  resetDefaultGhCallPacerForTest(sharedFake);
  try {
    const rateLimitError = Object.assign(new Error("Command failed: gh pr list"), {
      status: 1,
      stderr: "gh: API rate limit exceeded for user ID 123456. (HTTP 403)",
    });
    const ghA = buildBatchedGithub("o", "r-a", {
      fetchAll: () => {
        throw rateLimitError;
      },
    });
    assert.doesNotThrow(() => ghA.findMergedByTrailer("W1-T1"), "a classified rate-limit failure is caught, not rethrown");
    assert.equal(widenedAtWait[0], false, "gateway A's very first wait() had not observed any widening yet");
    assert.ok(recordedRateLimited.includes(true), "at least one of gateway A's attempts recorded rateLimited=true");
    const ghB = buildBatchedGithub("o", "r-b", { fetchAll: () => [] });
    ghB.findMergedByTrailer("W1-T1");
    assert.equal(
      widenedAtWait[widenedAtWait.length - 1],
      true,
      "gateway B's wait() — the very next one after A's rate-limit result was recorded — saw the " +
        "gap already widened, proving the two share one pacer's state",
    );
  } finally {
    resetDefaultGhCallPacerForTest(undefined);
  }
});

test("W1-T1005: resetDefaultGhCallPacerForTest(undefined) really clears the shared default, not just this test's fake", () => {
  // Every test above resets to `undefined` in its own `finally`, but none of them proves that
  // reset actually TAKES: if `resetDefaultGhCallPacerForTest(undefined)` were a no-op, a stale
  // fake from an earlier test would silently keep answering later ones and this whole suite
  // would still pass green while `buildBatchedGithub` quietly leaked test state into every
  // caller after it — the same class of "no throw, no signal" failure this task exists to close,
  // just moved into the test double instead of production. Prove it directly: seed a fake, clear
  // it, and confirm the NEXT unpaced construction never reaches the cleared fake at all.
  const staleFakeCalls: string[] = [];
  const staleFake: GhCallPacer = {
    wait: () => staleFakeCalls.push("wait"),
    recordResult: (rateLimited) => staleFakeCalls.push(`result:${rateLimited}`),
  };
  resetDefaultGhCallPacerForTest(staleFake);
  resetDefaultGhCallPacerForTest(undefined);
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => [] });
  gh.findMergedByTrailer("W1-T1");
  assert.deepEqual(
    staleFakeCalls,
    [],
    "the cleared fake never sees another call — reset(undefined) really drops the module's " +
      "reference to it rather than leaving it installed",
  );
});

test("W1-T181: a batched-gateway fetch FAILURE projects indeterminate/throttled through deriveStatus — never the bare merged=false/source=none shape a genuine absence produces (the signal W1-T179's github_unobservable marking is designed to consume)", () => {
  // FALSIFIER, measured live on 2026-07-20: with the pre-fix catch, the batched gateway read
  // merged 0/212 with 207 indeterminate and the board reported every task queued, while the
  // repo actually had 290 merged PRs — because the failure collapsed to the SAME shape as a
  // genuinely empty result. This proves the fix end-to-end through the real precedence chain.
  const enobufsError = Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS", status: null, stderr: "" });
  const github = buildBatchedGithub("o", "r", { exec: () => { throw enobufsError; } });
  const proj = deriveStatus(task({ id: "W1-T1", status: "merged" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "throttled");
  assert.equal(proj.indeterminate, true);
  assert.equal(proj.unavailableReason, "buffer_overflow");
  assert.equal(proj.merged, false);
  assert.notEqual(
    proj.source,
    "none",
    "a gateway failure must never collapse to the ordinary-absence shape — that is the exact bug that produced merged 0/212 on 2026-07-20",
  );
});

// ── W1-T179: the two criteria PR #374 amended onto the already-merged W1-T155, orphaned
// (nothing could ever dispatch them) until this task gave them a dispatchable home ──────────

test("W1-T179: MONOTONIC UNDER DARKNESS — a gateway fetch FAILURE never regresses a credited (merged) task to queued; it keeps the last-good status and marks it github_unobservable(since <t>)", () => {
  // FALSIFIER (the 12:24->12:58 fail-open): a merged task with PR links rendered queued with
  // empty PR cells the instant a gateway read failed. previousProjection is what a caller
  // (projectPlan's own cache read, or a long-lived server's last snapshot) hands back.
  const enobufsError = Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS", status: null, stderr: "" });
  const github = buildBatchedGithub("o", "r", {
    exec: () => {
      throw enobufsError;
    },
  });
  const previouslyMerged = {
    taskId: "W1-T1",
    status: "merged" as const,
    merged: true,
    source: "trailer" as const,
    prNumber: 365,
    prUrl: "https://github.com/craigoley/remudero/pull/365",
    prState: "MERGED",
  };
  const proj = deriveStatus(task({ id: "W1-T1" }), {
    ledgerPath: ledgerFile([]),
    github,
    previousProjection: (taskId) => (taskId === "W1-T1" ? previouslyMerged : undefined),
    now: () => Date.parse("2026-07-20T12:58:00.000Z"),
  });
  assert.equal(proj.status, "merged", "statuses move only FORWARD across an observation gap — never back to queued");
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 365);
  assert.equal(proj.prUrl, previouslyMerged.prUrl);
  assert.equal(proj.indeterminate, true, "the gap is still marked -- this is not a silent downgrade, it is MARKED unobservable");
  assert.equal(proj.unavailableReason, "buffer_overflow");
  assert.equal(proj.githubUnobservableSince, "2026-07-20T12:58:00.000Z", "since <t> -- the instant this gap was first observed");
});

test("W1-T179: consecutive darkness reads report the SAME github_unobservable(since <t>) -- a LATER failed read never resets the clock", () => {
  const enobufsError = Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS", status: null, stderr: "" });
  const github = buildBatchedGithub("o", "r", {
    exec: () => {
      throw enobufsError;
    },
  });
  const alreadyDarkSince = "2026-07-20T12:24:00.000Z";
  const previouslyDark = {
    taskId: "W1-T1",
    status: "merged" as const,
    merged: true,
    source: "trailer" as const,
    prNumber: 365,
    indeterminate: true as const,
    unavailableReason: "buffer_overflow" as const,
    githubUnobservableSince: alreadyDarkSince,
  };
  const proj = deriveStatus(task({ id: "W1-T1" }), {
    ledgerPath: ledgerFile([]),
    github,
    previousProjection: () => previouslyDark,
    now: () => Date.parse("2026-07-20T12:58:00.000Z"),
  });
  assert.equal(proj.githubUnobservableSince, alreadyDarkSince, "the START of the gap, not the time of THIS read");
});

test("W1-T179: the NEXT successful gateway read clears the github_unobservable marking", () => {
  const url = "https://github.com/craigoley/remudero/pull/365";
  const fixture = ownedTrailerFixture("W1-T1", "W1-T1-1784460723173");
  const github = fakeGitHub({
    byTrailer: { "W1-T1": { number: 365, url, state: "MERGED" } },
    headRefByUrl: { [url]: fixture.headRefName },
    bodyByUrl: { [url]: fixture.body },
  });
  const previouslyDark = {
    taskId: "W1-T1",
    status: "merged" as const,
    merged: true,
    source: "trailer" as const,
    indeterminate: true as const,
    unavailableReason: "buffer_overflow" as const,
    githubUnobservableSince: "2026-07-20T12:24:00.000Z",
  };
  const proj = deriveStatus(task({ id: "W1-T1" }), {
    ledgerPath: ledgerFile([]),
    github,
    previousProjection: () => previouslyDark,
  });
  assert.equal(proj.status, "merged");
  assert.equal(proj.indeterminate, undefined, "a successful read clears the darkness stamp");
  assert.equal(proj.githubUnobservableSince, undefined);
});

test("W1-T179: with NO prior observation to fall back on (a task never before seen), a gateway failure still marks throttled/queued -- there is nothing to keep monotonic", () => {
  const enobufsError = Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS", status: null, stderr: "" });
  const github = buildBatchedGithub("o", "r", {
    exec: () => {
      throw enobufsError;
    },
  });
  const proj = deriveStatus(task({ id: "W1-T-NEW" }), {
    ledgerPath: ledgerFile([]),
    github,
    previousProjection: () => undefined,
  });
  assert.equal(proj.status, "queued");
  assert.equal(proj.source, "throttled");
  assert.equal(proj.indeterminate, true);
  assert.equal(proj.githubUnobservableSince, undefined);
});

test("W1-T179: projectPlan is monotonic under darkness FOR FREE across two sequential calls sharing a cachePath -- no caller wiring required", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-status-cache-"));
  const cachePath = join(dir, "status.json");
  const ledgerPath = ledgerFile([]);
  const url = "https://github.com/craigoley/remudero/pull/365";
  const t1 = task({ id: "W1-T1" });
  const plan: Plan = { tasks: [t1], byId: new Map([[t1.id, t1]]) };

  // Cycle 1: GitHub is reachable and credits the task.
  const fixture = ownedTrailerFixture("W1-T1", "W1-T1-1784460723173");
  const healthyGithub = fakeGitHub({
    byTrailer: { "W1-T1": { number: 365, url, state: "MERGED" } },
    headRefByUrl: { [url]: fixture.headRefName },
    bodyByUrl: { [url]: fixture.body },
  });
  const first = projectPlan(plan, { ledgerPath, github: healthyGithub }, cachePath);
  assert.equal(first.get("W1-T1")?.status, "merged");

  // Cycle 2: the SAME cachePath, a gateway that has since gone dark, and NO explicit
  // previousProjection wired by the caller -- projectPlan must read its own prior write.
  const enobufsError = Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS", status: null, stderr: "" });
  const darkGithub = buildBatchedGithub("o", "r", {
    exec: () => {
      throw enobufsError;
    },
  });
  const second = projectPlan(plan, { ledgerPath, github: darkGithub }, cachePath);
  const proj = second.get("W1-T1");
  assert.equal(proj?.status, "merged", "the credited task must NOT regress to queued across the two projectPlan calls");
  assert.equal(proj?.indeterminate, true);
});

// ── W1-T179: LIVENESS BOUND -- 'running' requires recent ledger activity OR an open PR ──────

test("W1-T179: LIVENESS BOUND -- a dispatched task with no terminal verdict, no open PR, and NO recent ledger activity is unknown/orphaned, never running (the W1-T1 crash-era spin-loop fixture: 27h21m, no PR, no fresh ledger activity)", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([{ ts: "2026-07-19T09:00:00.000Z", run_id: "r1", task_id: "W1-T1", step: "run.start" }]);
  const proj = deriveStatus(task({ id: "W1-T1" }), {
    ledgerPath,
    github,
    now: () => Date.parse("2026-07-20T12:21:00.000Z"), // ~27h21m later
  });
  assert.notEqual(proj.status, "running", "the falsifier: an orphaned dispatch rendered as running");
  assert.equal(proj.orphaned, true);
});

test("W1-T179: LIVENESS BOUND -- ledger activity inside the bound still renders running, with no orphaned flag", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([{ ts: "2026-07-20T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" }]);
  const proj = deriveStatus(task(), {
    ledgerPath,
    github,
    now: () => Date.parse("2026-07-20T10:05:00.000Z"),
    livenessBoundMs: 10 * 60_000,
  });
  assert.equal(proj.status, "running");
  assert.equal(proj.orphaned, undefined);
});

test("W1-T179: LIVENESS BOUND -- activity OUTSIDE the (injected, short) bound orphans a task even minutes after its last ledger line", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([{ ts: "2026-07-20T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" }]);
  const proj = deriveStatus(task(), {
    ledgerPath,
    github,
    now: () => Date.parse("2026-07-20T10:05:00.000Z"),
    livenessBoundMs: 60_000, // 1 minute -- the 5-minute-old run.start blows past it
  });
  assert.equal(proj.status, "queued");
  assert.equal(proj.orphaned, true);
});

test("W1-T179: LIVENESS BOUND -- an OPEN PR keeps a dispatch running regardless of ledger silence; the bound never applies to GitHub-backed evidence", () => {
  const url = "https://github.com/craigoley/remudero/pull/80";
  const github = fakeGitHub({ byRef: { [url]: { number: 80, url, state: "OPEN" } } });
  const ledgerPath = ledgerFile([
    { ts: "2026-07-19T09:00:00.000Z", run_id: "r1", task_id: "W1-T1", step: "run.start" },
    { run_id: "r1", task_id: "W1-T1", step: "pr.opened", pr_url: url },
  ]);
  const proj = deriveStatus(task({ id: "W1-T1" }), {
    ledgerPath,
    github,
    now: () => Date.parse("2026-07-20T12:21:00.000Z"), // ~27h21m later, well past any reasonable bound
  });
  assert.equal(proj.status, "running");
  assert.equal(proj.orphaned, undefined, "an open PR is independent, stronger evidence -- never subject to the ledger-silence bound");
});

test("W1-T181: a successful batched fetch logs its payload byte size and PR count via the injectable log hook", () => {
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  // W1-T265: the enumeration is REST now, so one fetch is SEVERAL requests (the open half, then
  // the closed delta) and `bytes` is their SUM. The criterion is unchanged — the payload size
  // must stay observable before the ceiling is crossed — but it is now the size of the whole
  // fetch, not of a single `gh pr list` response.
  const openPage = JSON.stringify([{ number: 1, url: "https://api.github.com/repos/o/r/pulls/1", html_url: "u1", state: "open", merged: false, head: { ref: "b" }, updated_at: "2026-07-24T00:00:00Z" }]);
  const emptyPage = "[]";
  const argvs: string[][] = [];
  const gh = buildBatchedGithub("o", "r", {
    exec: (args) => {
      argvs.push(args);
      return (args[1] ?? "").includes("state=open") ? openPage : emptyPage;
    },
    log: (event, extra) => events.push([event, extra]),
  });
  gh.warm?.();
  // W1-T2323: ONE ROW PER HALF, because the halves are now fetched on their own clocks — so the
  // criterion this test exists for (the payload size must stay observable before the ceiling is
  // crossed) is the SUM across the rows of one refresh, exactly as `bytes` was already the sum
  // across the requests of one walk. Nothing observable was lost; it arrives in two rows instead
  // of one, and each row now names which half it is.
  const bytesEvents = events.filter(([e]) => e === "board_gateway.fetch_bytes");
  assert.ok(bytesEvents.length > 0, "a successful fetch must log its payload byte size — the ceiling must be observable before it is crossed");
  const prArgvs = argvs.filter((a) => (a[1] ?? "").includes("/pulls"));
  const sum = (key: string) => bytesEvents.reduce((n, [, extra]) => n + Number(extra?.[key] ?? 0), 0);
  assert.equal(sum("bytes"), Buffer.byteLength(openPage, "utf8") + Buffer.byteLength(emptyPage, "utf8") * (prArgvs.length - 1));
  // W1-T265 adds the request count to the same event: the whole claim of the REST migration is
  // that a refresh stays at 2 requests, so it is measured in the ledger rather than asserted once
  // in a test and never observed again.
  assert.equal(sum("restCalls"), prArgvs.length);
  assert.deepEqual(bytesEvents.map(([, extra]) => extra?.half), ["open", "closed"], "and each row names its half");
  for (const [, extra] of bytesEvents) {
    assert.equal(extra?.mode, "full", "the first fetch has no cache to delta against");
    assert.equal(extra?.truncated, false);
  }
  const okEvent = events.find(([e]) => e === "board_gateway.fetch_ok");
  assert.ok(okEvent, "a successful fetch must also log fetch_ok");
  assert.equal(okEvent?.[1]?.prCount, 1);
});

test("W1-T181: a FAILED batched fetch logs LOUDLY — console.error fires AND the injectable log hook names the classified reason", (t) => {
  const errorSpy = t.mock.method(console, "error", () => {});
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  const enobufsError = Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS", status: null, stderr: "" });
  const gh = buildBatchedGithub("o", "r", {
    exec: () => {
      throw enobufsError;
    },
    log: (event, extra) => events.push([event, extra]),
  });
  gh.warm?.();
  const failEvent = events.find(([e]) => e === "board_gateway.fetch_failed");
  assert.ok(failEvent, "a failed fetch must log fetch_failed");
  assert.equal(failEvent?.[1]?.reason, "buffer_overflow");
  // FALSIFIER: the 2026-07-20 outage ran for HOURS with serve.log containing ZERO error lines —
  // console.error must fire independently of whether a caller ever wires `opts.log`.
  assert.ok(errorSpy.mock.calls.length >= 1, "a failed fetch must ALSO be loud on console.error, independent of the injectable log hook");
  assert.match(String(errorSpy.mock.calls[0].arguments[0]), /buffer_overflow/);
});

// ── W1-T187 criterion 4 — "deriveStatus still works standalone, with no pre-read lines
// supplied" — proven HERE, in this file, per the task's own `files:` list (plan/tasks.yaml),
// rather than only in the separate test/w1-t187-*.test.ts corpus suite. The W1-T187 fix
// (status.ts's `projectPlan`) hoists ONE ledger read and hands every task the SAME
// already-parsed array via an overriding `readLedger` on an internal `effectiveDeps` copy —
// `deriveStatus`'s own body/signature are untouched, and the `deps` object every OTHER caller
// (board.ts's SSE stream, run-task.ts, correct.ts) already owns is never mutated by that
// hoist, only spread into a fresh object local to `projectPlan`.
//
// Two independent proofs, deliberately NOT circular:
//  (a) below, `deriveStatus(task, deps)` is called with a bare `deps` literal that has no
//      `readLedger` key at all — exactly what every one of the ~50 pre-existing calls above in
//      THIS file already do, and every one of them is UNCHANGED by this task and still passes.
//      The exact values asserted below are hand-computed from the fixture, never re-derived
//      via `projectPlan` — so a regression that broke BOTH paths identically could not hide here.
//  (b) the second test below cross-checks that same standalone call against a hand-built,
//      minimal (non-corpus) multi-task `projectPlan` call over an IDENTICAL fixture, proving
//      the projectPlan-level hoist changed nothing observable for a per-task caller.
test("W1-T187 criterion 4: deriveStatus(task, deps) with NO `readLedger` key on `deps` at all still resolves via the default reader, unchanged by the projectPlan-level hoist", () => {
  const url = "https://github.com/craigoley/remudero/pull/187";
  const github = fakeGitHub({ byRef: { [url]: { number: 187, url, state: "MERGED" } } });
  const ledgerPath = ledgerFile([
    { step: "run.start", task_id: "W1-T187X", run_id: "r1" },
    { step: "pr.opened", task_id: "W1-T187X", run_id: "r1", pr_url: url },
  ]);
  // `deps` below is a bare object literal -- no `readLedger` property in sight, not even
  // `readLedger: undefined` -- the exact "no pre-read lines supplied" shape the criterion names.
  const deps = { ledgerPath, github };
  const proj = deriveStatus(task({ id: "W1-T187X" }), deps);
  assert.equal(proj.taskId, "W1-T187X");
  assert.equal(proj.source, "ledger");
  assert.equal(proj.merged, true);
  assert.equal(proj.status, "merged");
  assert.equal(proj.prNumber, 187);
  assert.equal(proj.prUrl, url);
});

test("W1-T187 criterion 4: standalone deriveStatus (no readLedger override) matches the SAME task's projection inside a hoisted projectPlan pass, over a hand-built (non-corpus) multi-task fixture", () => {
  const mergedUrl = "https://github.com/craigoley/remudero/pull/1871";
  const openUrl = "https://github.com/craigoley/remudero/pull/1872";
  const github = fakeGitHub({
    byRef: {
      [mergedUrl]: { number: 1871, url: mergedUrl, state: "MERGED" },
      [openUrl]: { number: 1872, url: openUrl, state: "OPEN" },
    },
  });
  const ledgerPath = ledgerFile([
    { step: "run.start", task_id: "W1-T187A", run_id: "a1" },
    { step: "pr.opened", task_id: "W1-T187A", run_id: "a1", pr_url: mergedUrl },
    { step: "run.start", task_id: "W1-T187B", run_id: "b1" },
    { step: "pr.opened", task_id: "W1-T187B", run_id: "b1", pr_url: openUrl },
    { step: "run.start", task_id: "W1-T187C", run_id: "c1" }, // queued/no-PR bucket
  ]);
  const deps = { ledgerPath, github };
  const plan: Plan = {
    tasks: [task({ id: "W1-T187A" }), task({ id: "W1-T187B" }), task({ id: "W1-T187C" })],
    byId: new Map(),
  };
  plan.byId = new Map(plan.tasks.map((t) => [t.id, t]));

  const hoisted = projectPlan(plan, deps);
  for (const t of plan.tasks) {
    const standalone = deriveStatus(t, deps); // deliberately the SAME bare `deps`, no override
    assert.deepEqual(standalone, hoisted.get(t.id), `${t.id}: standalone deriveStatus diverged from the hoisted projectPlan result`);
  }
  // Sanity: the fixture actually exercises distinct buckets, not three identical rows.
  assert.equal(hoisted.get("W1-T187A")?.status, "merged");
  assert.equal(hoisted.get("W1-T187B")?.status, "running");
  assert.equal(hoisted.get("W1-T187C")?.status, "queued");
});

// ── W1-T184: readLedgerTail — the INCREMENTAL ledger reader lib/board.ts's per-poll routes
// (createBoardSnapshotCache, computeRecentActivity, buildStatusStream) hold onto across calls so
// an unchanged/append-only ledger never costs a full re-read+re-parse of the whole file. ─────────

test("readLedgerTail: reads new lines incrementally as the file grows; an unchanged file returns the SAME cached array reference", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-status-tail-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  const cache = createLedgerTailCache();

  assert.deepEqual(readLedgerTail(p, cache), []);
  const empty = readLedgerTail(p, cache);
  assert.equal(empty, readLedgerTail(p, cache), "unchanged file -> the SAME array reference back");

  appendFileSync(p, JSON.stringify({ step: "a" }) + "\n");
  const afterA = readLedgerTail(p, cache);
  assert.deepEqual(afterA, [{ step: "a" }]);
  assert.equal(afterA, readLedgerTail(p, cache), "still the same array reference, unchanged since the last read");

  appendFileSync(p, JSON.stringify({ step: "b" }) + "\n");
  const afterB = readLedgerTail(p, cache);
  assert.deepEqual(afterB, [{ step: "a" }, { step: "b" }]);
  assert.equal(afterB, afterA, "the SAME array, appended to in place -- never rebuilt from scratch");
});

test("readLedgerLines: malformed JSON on a line is dropped (never fabricated as {}) and logged loud, never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-status-lines-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "not json at all\n" + JSON.stringify({ step: "ok" }) + "\n");
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (msg: string) => logged.push(msg);
  try {
    assert.deepEqual(readLedgerLines(p), [{ step: "ok" }], "the torn line is dropped, not fabricated as a phantom {}");
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 1, "the torn line is surfaced via console.error, not silently swallowed");
  assert.match(logged[0], /not json at all/);
});

test("readLedgerTail: a not-yet-newline-terminated partial write is buffered, not parsed until the newline lands", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-status-tail-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  const cache = createLedgerTailCache();

  const full = JSON.stringify({ step: "run.start", task_id: "W1-T1" });
  appendFileSync(p, full.slice(0, 10)); // an incomplete write mid-line, no trailing "\n" yet
  assert.deepEqual(readLedgerTail(p, cache), [], "a partial, not-yet-newline-terminated line is never parsed early");

  appendFileSync(p, full.slice(10) + "\n"); // the rest of the line lands
  assert.deepEqual(readLedgerTail(p, cache), [{ step: "run.start", task_id: "W1-T1" }]);
});

test("readLedgerTail: malformed JSON on a line is dropped (never fabricated as {}) and logged loud, never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-status-tail-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "not json at all\n" + JSON.stringify({ step: "ok" }) + "\n");
  const cache = createLedgerTailCache();
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (msg: string) => logged.push(msg);
  try {
    assert.deepEqual(readLedgerTail(p, cache), [{ step: "ok" }], "the torn line is dropped, not fabricated as a phantom {}");
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 1, "the torn line is surfaced via console.error, not silently swallowed");
  assert.match(logged[0], /not json at all/);
});

test("readLedgerTail: a file shorter than last observed (rotation/truncation) rescans from byte 0 rather than throwing or slicing negative", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-status-tail-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, [{ step: "a" }, { step: "b" }, { step: "c" }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const cache = createLedgerTailCache();
  assert.deepEqual(readLedgerTail(p, cache), [{ step: "a" }, { step: "b" }, { step: "c" }]);

  writeFileSync(p, JSON.stringify({ step: "fresh" }) + "\n"); // simulates rotation -- a shorter file
  assert.deepEqual(readLedgerTail(p, cache), [{ step: "fresh" }], "degrades safely: rescans from scratch, never a negative-length read");
});

test("readLedgerTail: a missing file returns []; once it appears, subsequent reads pick up its content", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-status-tail-"));
  const p = join(dir, "ledger.ndjson");
  const cache = createLedgerTailCache();
  assert.deepEqual(readLedgerTail(p, cache), []);
  writeFileSync(p, JSON.stringify({ step: "a" }) + "\n");
  assert.deepEqual(readLedgerTail(p, cache), [{ step: "a" }]);
});

// ── 2026-07-30 OPERATOR RULING: an exactly-anchored trailer on a MERGED PR credits, ─────────
// ── regardless of the head branch's NAME; only a branch claiming ANOTHER task vetoes. ────────
//
// Ground truth this replaces (recon-AO, all OBSERVED): seven merged, correctly-trailered PRs
// were refused credit on branch-name shape alone, stranding their tasks `queued` forever,
// re-dispatching them, and tripping P29(ii)'s breaker. W1-T258 burned $3.40 ending in
// `verdict: pr_attribution_failed`. The escalation reconciler keys on the same `merged` flag,
// so the defect also made retiring its own escalations impossible.

test("ruling: a merged PR with an anchored trailer credits from a hand-named branch the old assert vetoed", () => {
  // W1-T258's EXACT live case: head `feat-api-key-overflow`, anchored trailer, MERGED (PR #766).
  const github = fakeGitHub({
    byTrailer: { "W1-T258": { number: 766, url: "u/766", state: "MERGED" } },
    headRefByUrl: { "u/766": "feat-api-key-overflow" },
    bodyByUrl: { "u/766": "Implements the overflow valve.\n\nRemudero-Task: W1-T258\n" },
  });
  const proj = deriveStatus(task({ id: "W1-T258" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "trailer");
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 766);
  assert.equal(proj.rejected_candidates, undefined);
});

test("ruling: a merged PR on the BARE run-taskId branch form credits even without the epoch suffix", () => {
  // W1-T152's own merged PR #793: head `run-W1-T152`, which lacks only the `-<epochMs>` suffix.
  const github = fakeGitHub({
    byTrailer: { "W1-T152": { number: 793, url: "u/793", state: "MERGED" } },
    headRefByUrl: { "u/793": "run-W1-T152" },
    bodyByUrl: { "u/793": "Adds the serve plist generator.\n\nRemudero-Task: W1-T152\n" },
  });
  const proj = deriveStatus(task({ id: "W1-T152" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "trailer");
  assert.equal(proj.merged, true);
});

test("negative control: a merged PR whose anchored trailer names a DIFFERENT task never credits", () => {
  // THE most important guard in this change. The fuzzy body search surfaces a merged PR that
  // genuinely carries an anchored trailer — for someone else's task. Crediting it would mark
  // work done that this task never did.
  const github = fakeGitHub({
    byTrailer: { "W1-T900": { number: 55, url: "u/55", state: "MERGED" } },
    headRefByUrl: { "u/55": "feat-unrelated-work" },
    bodyByUrl: { "u/55": "Implements something else.\n\nRemudero-Task: W1-T901\n" },
  });
  const proj = deriveStatus(task({ id: "W1-T900" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.merged, false);
  assert.notEqual(proj.source, "trailer");
  assert.deepEqual(proj.rejected_candidates, [{ pr: "u/55", reason: "trailer-not-anchored" }]);
});

test("trap 1 forward: a run branch belonging to W1-T152 never credits the prefix-sharing W1-T15", () => {
  const github = fakeGitHub({
    byTrailer: { "W1-T15": { number: 60, url: "u/60", state: "MERGED" } },
    headRefByUrl: { "u/60": "run-W1-T152-1785348476091" },
    bodyByUrl: { "u/60": "Body carries a trailer for the SHORT id.\n\nRemudero-Task: W1-T15\n" },
  });
  const proj = deriveStatus(task({ id: "W1-T15" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.merged, false);
  assert.notEqual(proj.source, "trailer");
  assert.deepEqual(proj.rejected_candidates, [{ pr: "u/60", reason: "branch-claims-other-task" }]);
});

test("trap 1 reverse: a run branch belonging to W1-T15 never credits the longer W1-T152", () => {
  const github = fakeGitHub({
    byTrailer: { "W1-T152": { number: 61, url: "u/61", state: "MERGED" } },
    headRefByUrl: { "u/61": "run-W1-T15-1785348476091" },
    bodyByUrl: { "u/61": "Body carries a trailer for the LONG id.\n\nRemudero-Task: W1-T152\n" },
  });
  const proj = deriveStatus(task({ id: "W1-T152" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.merged, false);
  assert.notEqual(proj.source, "trailer");
  assert.deepEqual(proj.rejected_candidates, [{ pr: "u/61", reason: "branch-claims-other-task" }]);
});

test("trap 2 open: an OPEN PR with a correct anchored trailer on a foreign branch never credits", () => {
  // The relaxation is scoped to MERGED. Crediting an open PR would mark work done that never
  // landed — a worse failure than the bug this fixes.
  const github = fakeGitHub({
    byTrailer: { "W1-T700": { number: 70, url: "u/70", state: "OPEN" } },
    headRefByUrl: { "u/70": "feat-still-in-progress" },
    bodyByUrl: { "u/70": "Work in progress.\n\nRemudero-Task: W1-T700\n" },
  });
  const proj = deriveStatus(task({ id: "W1-T700" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.merged, false);
  assert.notEqual(proj.source, "trailer");
});

test("trap 2 closed: a CLOSED-UNMERGED PR with a correct anchored trailer on a foreign branch never credits", () => {
  const github = fakeGitHub({
    byTrailer: { "W1-T701": { number: 71, url: "u/71", state: "CLOSED" } },
    headRefByUrl: { "u/71": "feat-abandoned" },
    bodyByUrl: { "u/71": "Abandoned.\n\nRemudero-Task: W1-T701\n" },
  });
  const proj = deriveStatus(task({ id: "W1-T701" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.merged, false);
  assert.notEqual(proj.source, "trailer");
});

test("ruling scope: an unreadable head ref still fails CLOSED on a merged anchored-trailer PR", () => {
  // W1-T119, UNCHANGED by the ruling and deliberately re-asserted here. An absent head ref is a
  // read that FAILED, not a branch carrying no claim. The ruling removed the veto power of a
  // branch NAME we can SEE; it did not make an unreadable one creditable. (I initially got this
  // wrong and the pre-existing doctrine test at "an unresolved head ref fails CLOSED" caught it.)
  const github = fakeGitHub({
    byTrailer: { "W1-T800": { number: 80, url: "u/80", state: "MERGED" } },
    bodyByUrl: { "u/80": "Landed.\n\nRemudero-Task: W1-T800\n" },
  });
  const proj = deriveStatus(task({ id: "W1-T800" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.merged, false);
  assert.notEqual(proj.source, "trailer");
});

// -- W1-T485: SUBSTANCE THAT SHIPPED UNDER ANOTHER TASK'S TRAILER ----------------------------
//
// THE ROUTE NO CREDIT SOURCE COVERS. The projection resolves a merge through five sources
// (trailer, ledger, head-branch, pr-field, correction) and every one of them credits the task the
// PR NAMES. When a PR names task A correctly and ships task B's substance, B is credited by
// nobody and sits in the decision queue indefinitely -- measured twice: #1758 shipped W1-T467's
// substance under `Remudero-Task: W1-T466`, and #1777 shipped W1-T472's under
// `Remudero-Task: W1-T464` three hours AFTER W1-T458's advisory went live and correctly stayed
// silent, because a task WAS resolved. These tests pin that boundary from both sides.

/** A search whose answers are fixture-driven, keyed `symbol@path`. */
function fakeSearch(byKey: Record<string, readonly SupersessionCommit[] | null>): SupersessionSearch {
  return (symbol, path) => byKey[`${symbol}@${path}`] ?? [];
}

const T472 = () =>
  task({
    id: "W1-T472",
    files: ["src/lib/compaction.ts", "test/ci-parity-contract.test.ts"],
    acceptance: [
      {
        claim: "the worker no longer runs the parity preflight",
        proof: "grep: preflight --ci-parity in src/lib/compaction.ts",
      },
    ],
  });

const T472_KEY = "preflight --ci-parity@src/lib/compaction.ts";

test("W1-T485: a task whose substance shipped under ANOTHER task's trailer is named", () => {
  const evidence = findSupersessionEvidence(
    T472(),
    fakeSearch({
      [T472_KEY]: [
        {
          sha: "e26f928",
          subject: "fix(compaction): stop making workers run rmd preflight --ci-parity",
          trailerTaskId: "W1-T464",
        },
      ],
    }),
  );
  assert.equal(evidence?.creditedTaskId, "W1-T464", "the report must name the task that WAS credited");
  assert.equal(evidence?.sha, "e26f928");
  assert.equal(evidence?.symbol, "preflight --ci-parity", "and the task's own proof symbol that matched");
  assert.equal(evidence?.path, "src/lib/compaction.ts", "inside a path the task itself declared");
});

test("W1-T485: a task with no evidence of supersession is NOT named", () => {
  assert.equal(
    findSupersessionEvidence(T472(), fakeSearch({})),
    undefined,
    "a symbol nothing shipped must produce no row -- a report that names everyone is muted within a day",
  );
});

test("W1-T485: a commit carrying THIS task's OWN trailer is credit, not supersession", () => {
  // The projection's `trailer` source already resolves this. Reporting it here would name every
  // task that ever merged, which is the fastest possible way to make the report worthless.
  assert.equal(
    findSupersessionEvidence(
      T472(),
      fakeSearch({
        [T472_KEY]: [
          { sha: "aaa1111", subject: "fix(compaction): drop the parity preflight", trailerTaskId: "W1-T472" },
        ],
      }),
    ),
    undefined,
  );
});

test("W1-T485: a commit carrying NO trailer is left to W1-T458's advisory, not double-reported", () => {
  assert.equal(
    findSupersessionEvidence(
      T472(),
      fakeSearch({ [T472_KEY]: [{ sha: "bbb2222", subject: "fix: drop the parity preflight" }] }),
    ),
    undefined,
    "`unresolved_task_scope` (lib/review.ts) already fires on a diff that resolves no task",
  );
});

test("W1-T485: a FAILED search is not evidence of absence -- and never evidence of presence", () => {
  const nullSearch: SupersessionSearch = () => null;
  assert.equal(findSupersessionEvidence(T472(), nullSearch), undefined, "a null read must not fabricate a row");
});

test("W1-T506: proofGrepTargets pairs every symbol (grep: or unit test:) with every declared path", () => {
  const t = task({
    id: "W1-TX",
    files: ["src/lib/a.ts", "src/lib/b.ts"],
    acceptance: [
      { claim: "declared-shape grep", proof: "grep: SENTINEL_ALPHA in src/lib/a.ts" },
      { claim: "a path-less grep still carries a symbol now", proof: "grep: SENTINEL_DELTA" },
      { claim: "a unit-test proof carries a symbol too", proof: "unit test: exercises the sentinel path" },
      { claim: "prose with no dialect prefix yields nothing", proof: "the thing behaves correctly" },
    ],
  });
  assert.deepEqual(proofGrepTargets(t), [
    { symbol: "SENTINEL_ALPHA", path: "src/lib/a.ts" },
    { symbol: "SENTINEL_ALPHA", path: "src/lib/b.ts" },
    { symbol: "SENTINEL_DELTA", path: "src/lib/a.ts" },
    { symbol: "SENTINEL_DELTA", path: "src/lib/b.ts" },
    { symbol: "exercises the sentinel path", path: "src/lib/a.ts" },
    { symbol: "exercises the sentinel path", path: "src/lib/b.ts" },
  ]);
});

test("W1-T506: a task declaring no files yields no targets, whatever its proofs say", () => {
  const t = task({ id: "W1-TX", files: [], acceptance: [{ claim: "c", proof: "grep: SENTINEL in src/lib/a.ts" }] });
  assert.deepEqual(proofGrepTargets(t), []);
});

// -- W1-T506: REACH IS NO LONGER GATED ON A SINGLE PROOF DIALECT -----------------------------
//
// W1-T485's detector only ever examined a `grep:` proof whose OWN body named a path already in
// `files:` -- both of its motivating cases (W1-T467, W1-T472) are entirely `unit test:` proofs and
// were therefore invisible to it, and the house filing convention is moving FURTHER toward
// `unit test:` and away from `grep:`. These four pin the widened reach and the two latent-precision
// fixes rationale (5)/design (iv) of this task's shard required alongside it.

test("a task whose proofs are all unit tests is reachable by the supersession search", () => {
  const t = task({
    id: "W1-TY",
    files: ["src/lib/only-unit.ts"],
    acceptance: [{ claim: "only a unit test proof", proof: "unit test: exercises the new behavior" }],
  });
  assert.ok(
    proofGrepTargets(t).length > 0,
    "a task carrying only unit-test proofs must still yield at least one search target",
  );
  const evidence = findSupersessionEvidence(
    t,
    fakeSearch({
      "exercises the new behavior@src/lib/only-unit.ts": [
        { sha: "c0ffee1", subject: "feat: land the sentinel behavior", trailerTaskId: "W1-T900" },
      ],
    }),
  );
  assert.equal(
    evidence?.creditedTaskId,
    "W1-T900",
    "an all-unit-test task's substance must be discoverable, not structurally invisible",
  );
});

test("the supersession search is not gated on a single proof dialect", () => {
  const grepOnly = task({
    id: "W1-TZ1",
    files: ["src/lib/g.ts"],
    acceptance: [{ claim: "g", proof: "grep: GREP_SYMBOL in src/lib/g.ts" }],
  });
  const unitOnly = task({
    id: "W1-TZ2",
    files: ["src/lib/u.ts"],
    acceptance: [{ claim: "u", proof: "unit test: UNIT_SYMBOL" }],
  });
  assert.ok(proofGrepTargets(grepOnly).length > 0, "a grep: proof still yields a target");
  assert.ok(
    proofGrepTargets(unitOnly).length > 0,
    "a unit test: proof yields a target too -- the same function, the same reach, no dialect check between them",
  );
});

test("a task already credited merged is never reported as superseded", () => {
  const evidence = findSupersessionEvidence(
    T472(),
    fakeSearch({
      [T472_KEY]: [{ sha: "e26f928", subject: "s", trailerTaskId: "W1-T464" }],
    }),
    { merged: true },
  );
  assert.equal(
    evidence,
    undefined,
    "a task the merged union already credits must never be reported, regardless of the caller",
  );
});

test("the search prefers the commit that introduced the symbol", () => {
  const evidence = findSupersessionEvidence(
    T472(),
    fakeSearch({
      // git log order: newest first. The LATEST touch (W1-T900) must lose to the commit that
      // actually introduced the symbol (W1-T464), which git log reports LAST.
      [T472_KEY]: [
        { sha: "newest1", subject: "fix: a later touch of the same symbol", trailerTaskId: "W1-T900" },
        { sha: "oldest1", subject: "feat: original introduction of the symbol", trailerTaskId: "W1-T464" },
      ],
    }),
  );
  assert.equal(evidence?.creditedTaskId, "W1-T464", "the introducing commit must be credited, not the latest editor");
  assert.equal(evidence?.sha, "oldest1");
});

test("W1-T485: the projection attaches supersededBy to an UNMERGED task and changes nothing else", () => {
  const t = T472();
  const before = JSON.stringify(t);
  const plan: Plan = { tasks: [t], byId: new Map([[t.id, t]]) };
  const byId = projectPlan(plan, {
    ledgerPath: ledgerFile([]),
    github: fakeGitHub({}),
    supersessionSearch: fakeSearch({
      [T472_KEY]: [
        {
          sha: "e26f928",
          subject: "fix(compaction): stop making workers run rmd preflight --ci-parity",
          trailerTaskId: "W1-T464",
        },
      ],
    }),
  });
  const p = byId.get("W1-T472");
  assert.equal(p?.supersededBy?.creditedTaskId, "W1-T464");
  // AN OBSERVATION, NEVER A VERDICT. The three fields anything downstream gates on are untouched,
  // and the Task object itself is not mutated -- the projection is machine-owned and tasks.yaml is
  // never rewritten, which is exactly what a "fix the shard status" reading would have broken.
  assert.equal(p?.merged, false, "merged must not move");
  assert.equal(p?.status, "queued", "status must not move");
  assert.equal(p?.source, "none", "the credit source must not move");
  assert.equal(JSON.stringify(t), before, "the Task object itself must be untouched");
});

test("W1-T485: no search dep supplied means no field, and no search is ever called", () => {
  let calls = 0;
  const counting: SupersessionSearch = () => {
    calls++;
    return [];
  };
  const t = T472();
  const plan: Plan = { tasks: [t], byId: new Map([[t.id, t]]) };
  const bare = projectPlan(plan, { ledgerPath: ledgerFile([]), github: fakeGitHub({}) });
  assert.equal(bare.get("W1-T472")?.supersededBy, undefined, "absent dep means absent field");
  // ...and the opt-in path really is the only thing that spends a subprocess: with the dep supplied
  // the search IS consulted. Without this half the assertion above would also pass if the feature
  // were simply dead code.
  projectPlan(plan, { ledgerPath: ledgerFile([]), github: fakeGitHub({}), supersessionSearch: counting });
  assert.ok(calls > 0, "supplying the dep must actually drive the search");
});

test("W1-T485: a MERGED task is skipped -- its credit is the projection's own business", () => {
  const t = task({
    id: "W1-T12a",
    files: ["src/lib/compaction.ts"],
    acceptance: [{ claim: "c", proof: "grep: preflight --ci-parity in src/lib/compaction.ts" }],
  });
  const plan: Plan = { tasks: [t], byId: new Map([[t.id, t]]) };
  const byId = projectPlan(plan, {
    ledgerPath: ledgerFile([]),
    github: fakeGitHub({
      byHeadBranch: {
        "W1-T12a": [{ number: 61, url: "u/61", state: "MERGED", headRefName: "run-W1-T12a-1784124446138" }],
      },
    }),
    supersessionSearch: fakeSearch({
      [T472_KEY]: [{ sha: "e26f928", subject: "s", trailerTaskId: "W1-T464" }],
    }),
  });
  assert.equal(byId.get("W1-T12a")?.merged, true);
  assert.equal(byId.get("W1-T12a")?.supersededBy, undefined, "a credited task is not a supersession suspect");
});

test("W1-T485: the git-log search parses trailers, and a throwing exec yields null rather than an empty list", () => {
  const NUL = String.fromCharCode(0);
  const RS = String.fromCharCode(30);
  const search = buildGitLogSupersessionSearch({
    exec: (args) => {
      assert.ok(args.includes("-Spreflight --ci-parity"), `the pickaxe must carry the symbol: ${args.join(" ")}`);
      assert.ok(args.includes("--") && args.includes("src/lib/compaction.ts"), "and bound the search to the path");
      return [
        `e26f928${NUL}fix(compaction): stop making workers run rmd preflight --ci-parity${NUL}Remudero-Task: W1-T464\n`,
        `aaa1111${NUL}feat: unrelated${NUL}no trailer here\n`,
      ].join(RS);
    },
  });
  const got = search("preflight --ci-parity", "src/lib/compaction.ts");
  assert.equal(got?.length, 2);
  assert.equal(got?.[0]?.trailerTaskId, "W1-T464");
  assert.equal(got?.[1]?.trailerTaskId, undefined, "a body with no trailer must not invent one");

  const broken = buildGitLogSupersessionSearch({
    exec: () => {
      throw new Error("fatal: bad revision");
    },
  });
  assert.equal(broken("x", "y"), null, "a failed read is null, never an empty list");
});

// THE DEFAULT `exec` LEAF, DRIVEN FOR REAL. Every test above injects `exec`, which leaves the
// production `execFileSync` arrow and its catch arm unreachable -- the measured shape from #977/#978
// ("when every test injects a fake, the seam's DEFAULT implementation and each catch arm are
// unreachable"). These two drive the real `git log` in this repository: read-only, no network, and
// asserting only what cannot drift -- that a symbol certain to exist resolves to at least one
// commit, and that an unresolvable ref yields `null` rather than an empty list.
test("W1-T485: the DEFAULT exec really shells out to git, and a bad ref degrades to null not []", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const real = buildGitLogSupersessionSearch({ ref: "HEAD", cwd: repoRoot });
  const hits = real("export function projectPlan", "src/lib/status.ts");
  assert.notEqual(hits, null, "a readable ref must not report a failed read");
  assert.ok((hits ?? []).length > 0, "a symbol that is in the file must resolve to at least one commit");
  assert.ok(
    (hits ?? []).every((c) => /^[0-9a-f]{7,40}$/.test(c.sha)),
    "every record must carry a real sha, so the record split is not silently mis-parsing",
  );

  const bad = buildGitLogSupersessionSearch({ ref: "refs/heads/xyzzy-no-such-ref", cwd: repoRoot });
  assert.equal(
    bad("export function projectPlan", "src/lib/status.ts"),
    null,
    "an unresolvable ref is a FAILED READ -- returning [] here would read as `no evidence` and is the fail-open direction",
  );
});
