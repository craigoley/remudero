// test/trailer-surface-union.test.ts — W1-T2387.
//
// THE DEFECT. `appendTaskTrailerToCommit` (run-task.ts) amends a worker's own tip commit with
// `Remudero-Task: <id>` UNCONDITIONALLY — no author touches it. `renderBody` (plan-pr-emitter.ts)
// only writes the trailer into the PR BODY when a caller passes `taskId`, hand-written and
// skippable. `findMergedByTrailer`/`findMergedByTrailerAll` (src/lib/status.ts) read the BODY
// ONLY, so a merged PR whose author never hand-wrote the body line ships uncredited and is
// re-dispatched until someone notices — MEASURED 2026-08-27: 16 merged PRs carry the trailer in
// the commit and not the body, 9 credited nowhere else.
//
// THE FIX, PROVEN HERE. Both real implementers of `findMergedByTrailer`/`findMergedByTrailerAll`
// (`ghGateway`, `buildBatchedGithub`) now fall back to a `CommitTrailerLookup` — an anchored,
// task-id-shaped read of ORIGIN/MAIN's own commit history — whenever the body search genuinely
// finds nothing (never when it fails, and never overriding an answer the body already gave). It
// is a UNION: it can only ADD a credit the body-only read would have missed, never withdraw one.
//
// THE HAZARD IT MUST NOT WALK INTO. `appendTaskTrailerToCommit`'s SECOND call site (run-task.ts,
// W1-T1012's Architect path) passes a RUN id, not a task id — its own commit carries
// `Remudero-Task: <runId>` (shaped `DAEMON-<epochMs>`), anchored exactly like a real trailer. The
// negative arm below pins that a run-id-shaped trailer can never be mistaken for a task credit.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhCallPacer } from "../src/lib/open-prs-rest.js";
import {
  buildBatchedGithub,
  buildCommitTrailerLookup,
  commitTrailerTaskId,
  ghGateway,
  parseCommitTrailerCredits,
  type BatchedPr,
  type CommitTrailerLookup,
} from "../src/lib/status.js";

const NUL = String.fromCharCode(0);
const RS = String.fromCharCode(30);

/** Builds a `git log --format="%H%x00%s%x00%b%x1e"`-shaped dump from {sha, subject, body} records,
 *  newest-first (git log's own order) — the exact shape {@link parseCommitTrailerCredits} parses. */
function gitLogDump(records: Array<{ sha: string; subject: string; body: string }>): string {
  return records.map((r) => `${r.sha}${NUL}${r.subject}${NUL}${r.body}${RS}`).join("");
}

// ── The task-id grammar guard, isolated (the falsifier's own negative arm) ─────────────────────

test("W1-T2387: commitTrailerTaskId credits a task-id-shaped trailer and rejects a run-id-shaped one", () => {
  assert.equal(commitTrailerTaskId("fix(x): thing\n\nRemudero-Task: W1-T2387\n"), "W1-T2387");
  assert.equal(commitTrailerTaskId("fix(x): thing\n\nRemudero-Task: T42\n"), "T42");
  // FALSIFIER: appendTaskTrailerToCommit's Architect call site writes `Remudero-Task: <runId>`
  // where runId is shaped `DAEMON-<epochMs>` — remove the task-id-shape check and this starts
  // returning "DAEMON-1787845578879" instead of undefined.
  assert.equal(
    commitTrailerTaskId("chore: architect run\n\nRemudero-Task: DAEMON-1787845578879\n"),
    undefined,
    "a run-id-shaped trailer value must never be read as a credited task id",
  );
  assert.equal(commitTrailerTaskId("no trailer here at all"), undefined);
  assert.equal(commitTrailerTaskId(undefined), undefined);
});

test("W1-T2387: parseCommitTrailerCredits joins a squash commit's trailer to its own (#N) suffix, and a run-id-shaped trailer credits NO task at all", () => {
  const dump = gitLogDump([
    { sha: "aaa1111", subject: "fix(status): add the union fallback (#4242)", body: "Remudero-Task: W1-T2387\n" },
    // A run-id trailer, exactly appendTaskTrailerToCommit's Architect-path shape — must be
    // excluded from the parsed credits entirely, not merely fail to match SOME OTHER taskId.
    { sha: "bbb2222", subject: "chore: daemon architect sweep (#4200)", body: "Remudero-Task: DAEMON-1787845578879\n" },
    { sha: "ccc3333", subject: "feat: unrelated, no PR suffix", body: "Remudero-Task: W1-T9\n" },
    { sha: "ddd4444", subject: "docs: no trailer at all (#4100)", body: "just prose\n" },
  ]);
  const credits = parseCommitTrailerCredits(dump);
  assert.deepEqual(
    credits,
    [{ taskId: "W1-T2387", prNumber: 4242, sha: "aaa1111" }],
    "only the anchored, task-id-shaped, (#N)-suffixed commit yields a credit",
  );
  // FALSIFIER: removing the grammar guard would insert {taskId: "DAEMON-1787845578879", prNumber:
  // 4200} into this list — assert its absence directly, not merely that OUR taskId is missing.
  assert.ok(
    !credits.some((c) => c.taskId.startsWith("DAEMON-")),
    "no task is credited from a run-id-shaped trailer, whatever its value",
  );
});

test("W1-T2387: buildCommitTrailerLookup reads git log AT MOST ONCE per instance, however many taskIds are looked up — no per-task fetch", () => {
  let execCalls = 0;
  const lookup = buildCommitTrailerLookup({
    exec: () => {
      execCalls++;
      return gitLogDump([{ sha: "aaa", subject: "fix: x (#10)", body: "Remudero-Task: W1-T1\n" }]);
    },
  });
  for (let i = 0; i < 50; i++) lookup.get(`W1-T${i}`);
  assert.equal(execCalls, 1, "50 lookups on one instance must cost exactly one local git log, not 50");
  assert.equal(lookup.get("W1-T1"), 10);
});

test("W1-T2387: buildCommitTrailerLookup degrades to an empty lookup (never throws) when the local git read fails", () => {
  const lookup = buildCommitTrailerLookup({
    exec: () => {
      throw new Error("fatal: not a git repository");
    },
  });
  assert.equal(lookup.get("W1-T1"), undefined);
});

// ── ghGateway: the REST-backed implementer (status.ts:~4160-ish) ───────────────────────────────

/** A minimal REST search-issues response for `ghGateway`'s body-search `exec`. */
function searchResponse(items: Array<{ number: number; html_url: string }>): string {
  return JSON.stringify({
    items: items.map((it) => ({ ...it, state: "closed", pull_request: { merged_at: "2026-01-01T00:00:00Z" } })),
  });
}

function isBodySearch(args: string[]): boolean {
  const arg1 = typeof args[1] === "string" ? args[1] : "";
  return args[0] === "api" && arg1.startsWith("search/issues?q=") && decodeURIComponent(arg1).includes("in:body");
}

test("W1-T2387: ghGateway.findMergedByTrailer credits a task from the COMMIT surface when the body search finds nothing", () => {
  const commitTrailer: CommitTrailerLookup = { get: (taskId) => (taskId === "W1-T2387" ? 4242 : undefined) };
  const github = ghGateway("craigoley", "remudero", {
    exec: (args) => (isBodySearch(args) ? searchResponse([]) : searchResponse([])),
    commitTrailer,
  });
  const hit = github.findMergedByTrailer("W1-T2387");
  assert.equal(hit?.number, 4242);
  assert.equal(hit?.url, "https://github.com/craigoley/remudero/pull/4242");
  assert.equal(hit?.state, "MERGED");
  // The negative case: no commit credit and no body credit -> genuinely null.
  assert.equal(github.findMergedByTrailer("W1-T999"), null);
});

test("W1-T2387: ghGateway.findMergedByTrailerAll ALSO unions in the commit-only credit when the body search comes back empty", () => {
  const commitTrailer: CommitTrailerLookup = { get: (taskId) => (taskId === "W1-T2387" ? 4242 : undefined) };
  const github = ghGateway("craigoley", "remudero", { exec: () => searchResponse([]), commitTrailer });
  const hits = github.findMergedByTrailerAll?.("W1-T2387");
  assert.deepEqual(hits?.map((h) => h.number), [4242]);
});

test("W1-T2387: ghGateway.findMergedByTrailer — the BODY surface is consulted FIRST and its answer is UNCHANGED; the commit surface is never even queried", () => {
  let commitLookups = 0;
  const commitTrailer: CommitTrailerLookup = {
    get: () => {
      commitLookups++;
      return 99999; // if this were consulted, it would (wrongly) override the body's own answer
    },
  };
  const github = ghGateway("craigoley", "remudero", {
    exec: (args) => (isBodySearch(args) ? searchResponse([{ number: 55, html_url: "u/55" }]) : searchResponse([])),
    commitTrailer,
  });
  const hit = github.findMergedByTrailer("W1-T2387");
  assert.equal(hit?.number, 55, "the body hit stands — today's answer is unchanged where the body already answers");
  assert.equal(commitLookups, 0, "the commit surface must not be consulted at all once the body already answered");
});

test("W1-T2387: ghGateway.findMergedByTrailer — a FAILED body read stays null and does NOT fall through to the commit surface", () => {
  let commitLookups = 0;
  const commitTrailer: CommitTrailerLookup = { get: () => { commitLookups++; return 4242; } };
  const outageError = Object.assign(new Error("Command failed: gh api"), { status: 1, stderr: "gh: API rate limit exceeded. (HTTP 403)" });
  const github = ghGateway("craigoley", "remudero", {
    exec: () => { throw outageError; },
    commitTrailer,
  });
  assert.equal(github.findMergedByTrailer("W1-T2387"), null, "a genuinely failed read must stay null, never masked by a commit-surface guess");
  assert.equal(commitLookups, 0, "a failed body read must never be treated as an empty one");
});

test("W1-T2387: ghGateway.findMergedByTrailer — a run-id-shaped commit trailer credits NO task, end to end", () => {
  // The REAL parsing path: a local git log carrying only a run-id-shaped trailer, exactly
  // appendTaskTrailerToCommit's Architect call site's own shape.
  const commitTrailer = buildCommitTrailerLookup({
    exec: () =>
      gitLogDump([{ sha: "bbb2222", subject: "chore: daemon architect sweep (#4200)", body: "Remudero-Task: DAEMON-1787845578879\n" }]),
  });
  const github = ghGateway("craigoley", "remudero", { exec: () => searchResponse([]), commitTrailer });
  assert.equal(github.findMergedByTrailer("W1-T2387"), null);
  assert.equal(github.findMergedByTrailer("DAEMON-1787845578879"), null, "even a literal lookup by the run id itself credits nothing");
});

// ── buildBatchedGithub: the batched/cached implementer (status.ts:~5190-ish) ────────────────────

test("W1-T2387: buildBatchedGithub.findMergedByTrailer credits a task from the COMMIT surface when no merged PR's BODY carries it", () => {
  const prs: BatchedPr[] = [{ number: 10, url: "u10", state: "MERGED", body: "work, no trailer at all" }];
  const commitTrailer: CommitTrailerLookup = { get: (taskId) => (taskId === "W1-T2387" ? 4242 : undefined) };
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => prs, commitTrailer });
  const hit = gh.findMergedByTrailer("W1-T2387");
  assert.equal(hit?.number, 4242);
  assert.equal(hit?.url, "https://github.com/o/r/pull/4242");
  assert.equal(hit?.state, "MERGED");
});

test("W1-T2387: buildBatchedGithub.findMergedByTrailer prefers the richer already-fetched row when the commit-credited PR is ALSO in the batched index", () => {
  const prs: BatchedPr[] = [{ number: 4242, url: "u4242", state: "MERGED", title: "the real PR", body: "no anchored trailer here" }];
  const commitTrailer: CommitTrailerLookup = { get: () => 4242 };
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => prs, commitTrailer });
  const hit = gh.findMergedByTrailer("W1-T2387");
  assert.equal(hit?.url, "u4242", "the already-fetched row (with its title) is used rather than a synthesized stub");
  assert.equal(hit?.title, "the real PR");
});

test("W1-T2387: buildBatchedGithub — the BODY index is consulted FIRST and its answer is UNCHANGED; the commit surface is never queried", () => {
  let commitLookups = 0;
  const prs: BatchedPr[] = [{ number: 55, url: "u55", state: "MERGED", body: "work\nRemudero-Task: W1-T2387\n" }];
  const commitTrailer: CommitTrailerLookup = { get: () => { commitLookups++; return 99999; } };
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => prs, commitTrailer });
  const hit = gh.findMergedByTrailer("W1-T2387");
  assert.equal(hit?.number, 55, "the body hit stands, unchanged");
  assert.equal(commitLookups, 0, "no commit-surface lookup when the body already answered");
});

test("W1-T2387: buildBatchedGithub — a FAILED fetch stays null/failed and never falls through to the commit surface", () => {
  let commitLookups = 0;
  const commitTrailer: CommitTrailerLookup = { get: () => { commitLookups++; return 4242; } };
  const enobufsError = Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS", status: null, stderr: "" });
  const gh = buildBatchedGithub("o", "r", { exec: () => { throw enobufsError; }, commitTrailer });
  assert.equal(gh.findMergedByTrailer("W1-T2387"), null);
  assert.equal(gh.readFailed?.(), true);
  assert.equal(commitLookups, 0, "an outage must never be papered over by a commit-surface guess");
});

test("W1-T2387: buildBatchedGithub.findMergedByTrailerAll unions in the commit-only credit exactly when the body filter is empty", () => {
  const prs: BatchedPr[] = [{ number: 1, url: "u1", state: "MERGED", body: "no trailer" }];
  const commitTrailer: CommitTrailerLookup = { get: (taskId) => (taskId === "W1-T2387" ? 4242 : undefined) };
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => prs, commitTrailer });
  assert.deepEqual(gh.findMergedByTrailerAll?.("W1-T2387")?.map((h) => h.number), [4242]);
  assert.deepEqual(gh.findMergedByTrailerAll?.("W1-T999"), [], "genuinely no credit anywhere stays an empty array, never null");
});

test("W1-T2387: a run-id-shaped commit trailer credits NO task via buildBatchedGithub either", () => {
  const commitTrailer = buildCommitTrailerLookup({
    exec: () => gitLogDump([{ sha: "bbb", subject: "chore: architect (#77)", body: "Remudero-Task: DAEMON-1787845578879\n" }]),
  });
  const prs: BatchedPr[] = [{ number: 1, url: "u1", state: "MERGED", body: "no trailer" }];
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => prs, commitTrailer });
  assert.equal(gh.findMergedByTrailer("W1-T2387"), null);
});

// ── OMITTED `commitTrailer` ⇒ ABSENT ⇒ SKIP, so pre-existing callers are byte-for-byte unaffected ──

test("W1-T2387: omitting opts.commitTrailer leaves both gateways behaving EXACTLY as before this task — no default git shell-out, ever", () => {
  const ghNoCommit = ghGateway("craigoley", "remudero", { exec: () => searchResponse([]) });
  assert.equal(ghNoCommit.findMergedByTrailer("W1-T2387"), null);

  const prs: BatchedPr[] = [{ number: 1, url: "u1", state: "MERGED", body: "no trailer" }];
  const batchedNoCommit = buildBatchedGithub("o", "r", { fetchAll: () => prs });
  assert.equal(batchedNoCommit.findMergedByTrailer("W1-T2387"), null);
});

// ── W1-T2387: nothing added paces, throttles or sleeps a call ───────────────────────────────────

test("W1-T2387: resolving a task through the commit-surface fallback touches the gh-call pacer NO differently than an ordinary body-hit resolution — the fallback adds no pacing, throttling or sleep", () => {
  const baselineCalls: string[] = [];
  const baselinePacer: GhCallPacer = {
    wait: () => baselineCalls.push("wait"),
    recordResult: (rateLimited) => baselineCalls.push(`result:${rateLimited}`),
  };
  const baseline = buildBatchedGithub("o", "r", { fetchAll: () => [], pacer: baselinePacer });
  baseline.findMergedByTrailer("W1-T1");

  const fallbackCalls: string[] = [];
  const fallbackPacer: GhCallPacer = {
    wait: () => fallbackCalls.push("wait"),
    recordResult: (rateLimited) => fallbackCalls.push(`result:${rateLimited}`),
  };
  const prs: BatchedPr[] = [{ number: 1, url: "u1", state: "MERGED", body: "no trailer" }];
  const withFallback = buildBatchedGithub("o", "r", {
    fetchAll: () => prs,
    pacer: fallbackPacer,
    commitTrailer: { get: () => 777 }, // resolves THROUGH the commit-surface union this time
  });
  const hit = withFallback.findMergedByTrailer("W1-T1");

  assert.equal(hit?.number, 777, "sanity: this call really did resolve via the commit-surface fallback");
  assert.deepEqual(
    fallbackCalls,
    baselineCalls,
    "a commit-surface-resolved call must touch the shared GhCallPacer exactly like an ordinary one — no extra wait/backoff for the fallback",
  );

  // And the underlying local lookup itself is a plain synchronous function call — nothing async,
  // nothing timer-based, for anything to pace or sleep in the first place.
  const lookup = buildCommitTrailerLookup({ exec: () => "" });
  const result: unknown = lookup.get("W1-T1");
  assert.equal(result instanceof Promise, false);
});
