import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { nextRunnable, type MergedSet } from "../src/lib/drain.js";
import {
  buildBatchedGithub,
  classifyGhFailure,
  deriveStatus,
  dispatchesWithoutNewOwnedPr,
  ghGateway,
  isDispatchBreakerTripped,
  projectPlan,
  DEFAULT_MAX_TASK_DISPATCHES,
  type BatchedPr,
  type GitHub,
  type PrRef,
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
  /** W1-T155: auto-merge-armed per PR url. Absent url ⇒ not armed. */
  autoMergeByUrl?: Record<string, boolean>;
  /** W1-T119: simulates every underlying `gh` call in this snapshot having failed. */
  readFailed?: boolean;
}): GitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readFailed() {
      calls.push("readFailed");
      return opts.readFailed ?? false;
    },
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
  const proj = deriveStatus(task(), { ledgerPath, github });
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
  const proj = deriveStatus(task(), { ledgerPath, github });
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
  const proj = deriveStatus(task(), { ledgerPath, github });
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
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.needsHuman, undefined, "a redispatch since the escalation supersedes it");
  assert.equal(proj.phase, "recon", "and the task is genuinely back in flight");
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
    ["recon", [{ task_id: "recon", step: "run.start" }]],
    ["implement", [{ task_id: "implement", step: "run.start" }, { task_id: "implement", step: "recon.done" }]],
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
  for (const [id] of scenarios) {
    projections[id] = deriveStatus(task({ id }), { ledgerPath, github });
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
