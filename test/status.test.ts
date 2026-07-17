import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { nextRunnable, type MergedSet } from "../src/lib/drain.js";
import { deriveStatus, type GitHub, type PrRef } from "../src/lib/status.js";

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
}): GitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prByRef(ref) {
      calls.push(`prByRef:${ref}`);
      return opts.byRef?.[String(ref)] ?? null;
    },
    findMergedByTrailer(taskId) {
      calls.push(`trailer:${taskId}`);
      return opts.byTrailer?.[taskId] ?? null;
    },
    headRefName(prUrl) {
      calls.push(`headRefName:${prUrl}`);
      return opts.headRefByUrl?.[prUrl];
    },
    prBody(prUrl) {
      calls.push(`prBody:${prUrl}`);
      return opts.bodyByUrl?.[prUrl];
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

// ── W1-T76 (absorbs P21): the blocked_review FIX RUNG amends the SAME
// run-<taskId>-<epochMs> branch — never a fix/* branch. This is the SAME
// ownership-assert as the foreign-branch case above, exercised with the
// EXACT head shape the fix rung is forbidden from ever producing.
test("source (c) ownership-assert: a fix/* head is REJECTED — the fix rung must amend the run branch, never a fix/* branch (W1-T76)", () => {
  const github = fakeGitHub({
    byTrailer: { "W1-TX": { number: 134, url: "u/134", state: "MERGED" } },
    // A real, merged PR carrying the task's own trailer — but opened from a
    // hand-authored fix/* branch rather than this task's own run branch (the
    // #134 shape LEARNINGS/MASTER-PLAN name as the live cascade this assert
    // guards against: a fix/* credit would strand every dependent behind it).
    headRefByUrl: { "u/134": "fix/w1tx-style" },
    bodyByUrl: { "u/134": "Remudero-Task: W1-TX\n" },
  });
  const proj = deriveStatus(task({ id: "W1-TX" }), { ledgerPath: ledgerFile([]), github });
  assert.equal(proj.source, "none", "a fix/* head must never be creditable, even with an anchored trailer");
  assert.equal(proj.merged, false);
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

test("W1-T75 un-credit direction: a correction naming an actual_pr_url that GitHub cannot resolve (closed/absent) SUPREMELY derives NOT merged — it never falls through to rung (c)'s otherwise-valid trailer credit", () => {
  const fixture = ownedTrailerFixture("W1-TX", "W1-TX-1730000000000");
  const github = fakeGitHub({
    byTrailer: { "W1-TX": { number: 12, url: "u/12", state: "MERGED" } },
    headRefByUrl: { "u/12": fixture.headRefName },
    bodyByUrl: { "u/12": fixture.body },
    // byRef deliberately omits "u/99": gh cannot resolve the correction's target.
  });
  const ledgerPath = ledgerFile([
    { step: "correction.provenance", task_id: "W1-TX", claimed_pr_url: "u/12", actual_pr_url: "u/99" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.source, "correction");
  assert.equal(proj.merged, false);
  assert.ok(!github.calls.includes("trailer:W1-TX"), "supreme correction must short-circuit before rung (c) is ever consulted");
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
  assert.deepEqual(proj.rejected_candidates, [{ pr: "u/128", reason: "head-branch-not-owned" }]);
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
