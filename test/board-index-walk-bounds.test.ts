import assert from "node:assert/strict";
import { test } from "node:test";
import { NEEDS_HUMAN_LABEL } from "../src/lib/escalate.js";
import {
  boardIssuesRestArgs,
  type BoardIssueRest,
  type BoardPrRest,
  fetchBoardPrsRest,
  fetchLabelledIssuesRest,
  mapBoardPr,
  type RestPullRow,
} from "../src/lib/open-prs-rest.js";
import { DEFAULT_BOARD_POLL_TTL_MS } from "../src/lib/serve.js";
import { buildBatchedGithub } from "../src/lib/status.js";

/**
 * W1-T2222: the board's index walk re-reads the whole corpus every poll cycle, and the issue half
 * had no delta mode at all. `fetchBoardPrsRest`'s COLD (`state=closed`) half already carried a
 * real short-circuit (`known?.get(row.number)?.updatedAt === row.updated_at`); the issue fetch
 * (`fetchAllIssues`, lib/status.ts) had none, re-reading the WHOLE `needs-human` label set
 * (523-524 rows, ~3.04 MB MEASURED 2026-08-24) on every TTL tick regardless of whether anything
 * changed. This file proves the five claims the shard names, ONE PER TEST GROUP below, over
 * `fetchLabelledIssuesRest` (the new issue delta, open-prs-rest.ts, reusing the PR cold half's
 * proven stop test verbatim) and the gateway's existing TTL discipline (`buildBatchedGithub`).
 *
 * WHAT IS DELIBERATELY NOT HERE. The HOT (`state=open`) PR half stays unconditional — design (iv)
 * pins "nothing caches a live value past its TTL", and an open PR's `auto_merge` arming is exactly
 * the kind of state change the module's own doc says must not rest on `updated_at`. So "a
 * warm-cache poll stops walking open rows it already holds unchanged" is proved at the level the
 * design actually changes it: `buildBatchedGithub`'s gateway-scope cache answers a poll landing
 * INSIDE its TTL from memory, with ZERO further REST calls, rather than re-walking anything.
 */

const BOARD_MAX_PAGES = 50; // mirrors open-prs-rest.ts's runaway-guard internal (not exported —
// same local-pin discipline test/board-gateway-truncation.test.ts already uses for this constant).

function prRow(n: number, state: "open" | "closed", updatedAt: string, over: Partial<RestPullRow> = {}): RestPullRow {
  return {
    number: n,
    html_url: `https://github.com/o/r/pull/${n}`,
    state,
    merged_at: null,
    updated_at: updatedAt,
    head: { ref: `b${n}` },
    body: "",
    auto_merge: null,
    title: `pr ${n}`,
    ...over,
  };
}

interface RawIssueRow {
  number: number;
  html_url: string;
  state: string;
  updated_at: string;
  title: string;
  pull_request?: unknown;
}

function issueRow(n: number, state: "open" | "closed", updatedAt: string, over: Partial<RawIssueRow> = {}): RawIssueRow {
  return { number: n, html_url: `https://github.com/o/r/issues/${n}`, state, updated_at: updatedAt, title: `issue ${n}`, ...over };
}

function knownIssue(row: RawIssueRow): BoardIssueRest {
  return { number: row.number, url: row.html_url, state: row.state, title: row.title, updatedAt: row.updated_at };
}

// ── claim 1: "a warm-cache poll stops walking open rows it already holds unchanged" ────────────

test("claim 1: a poll landing inside the gateway's TTL answers entirely from memory -- zero further REST calls for rows it already holds", () => {
  let clock = 0;
  const calls: string[][] = [];
  const github = buildBatchedGithub("o", "r", {
    now: () => clock,
    ttlMs: 150_000,
    exec: (args) => {
      calls.push(args);
      const q = args[1] ?? "";
      if (q.includes("/issues")) return "[]";
      return JSON.stringify(q.includes("state=open") ? [prRow(1, "open", "2026-08-01T00:00:00Z")] : []);
    },
  });

  assert.equal(github.prByRef("https://github.com/o/r/pull/1")?.number, 1, "the cold poll populates the cache");
  const afterCold = calls.length;
  assert.ok(afterCold > 0, "the cold poll must have made at least one real call");

  clock += 1_000; // still well inside the 150s TTL -- a warm poll.
  github.prByRef("https://github.com/o/r/pull/1");
  github.listOpenHeadBranches?.();
  assert.equal(calls.length, afterCold, "a warm-cache poll issues NO further REST calls -- it never re-walks a row it already holds unchanged");
});

test("claim 1 (supporting): a delta-mode open-state walk reads the small page, not the cold pass's full page", () => {
  const openA = prRow(1, "open", "2026-08-01T00:00:00Z");
  const openB = prRow(2, "open", "2026-08-01T00:00:00Z");
  const known: Map<number, BoardPrRest> = new Map([
    [1, mapBoardPr(openA)],
    [2, mapBoardPr(openB)],
  ]);

  const coldCalls: string[][] = [];
  fetchBoardPrsRest("o", "r", (args) => {
    coldCalls.push(args);
    return (args[1] ?? "").includes("state=open") ? [openA, openB] : [];
  }); // no `known` -> mode=full

  const warmCalls: string[][] = [];
  const warm = fetchBoardPrsRest(
    "o",
    "r",
    (args) => {
      warmCalls.push(args);
      return (args[1] ?? "").includes("state=open") ? [openA, openB] : [];
    },
    known,
  );

  const coldOpen = coldCalls.filter((a) => (a[1] ?? "").includes("state=open"));
  const warmOpen = warmCalls.filter((a) => (a[1] ?? "").includes("state=open"));
  assert.equal(warm.mode, "delta");
  assert.ok(coldOpen[0][1].includes("per_page=100"), `the cold pass reads the full page size: ${coldOpen[0][1]}`);
  assert.ok(warmOpen[0][1].includes("per_page=30"), `a warm poll reads the smaller delta page instead: ${warmOpen[0][1]}`);
});

// ── claim 2: "the issue fetch asks only for what changed since its last successful read" ───────

test("claim 2: the issue delta re-reads a changed row and stops at the first one that still matches the known cache", () => {
  const unchanged = issueRow(10, "open", "2026-08-01T00:00:00Z");
  const touched = issueRow(11, "open", "2026-08-02T00:00:00Z", { title: "edited after the cache was built" });
  const known = new Map<number, BoardIssueRest>([[10, knownIssue(unchanged)]]);

  const calls: string[][] = [];
  const fetch = (args: string[]): unknown => {
    calls.push(args);
    // sorted updated_at DESCENDING: the changed row (newer) sorts above the unchanged one.
    return (args[1] ?? "").includes("page=1") ? [touched, unchanged] : [];
  };

  const out = fetchLabelledIssuesRest("o", "r", NEEDS_HUMAN_LABEL, fetch, known);

  assert.equal(out.mode, "delta");
  assert.equal(out.calls, 1, "the walk stops at #10, whose updated_at still matches the cache -- it never asks for page 2");
  assert.equal(out.rows.find((r) => r.number === 11)?.title, "edited after the cache was built", "the changed issue IS re-read");
  assert.equal(out.rows.find((r) => r.number === 10)?.updatedAt, unchanged.updated_at, "the unchanged issue is served from the cache, not re-fetched past it");
});

test("claim 2 (supporting): boardIssuesRestArgs sorts updated_at descending -- the entire basis of the stop above", () => {
  const args = boardIssuesRestArgs("o", "r", NEEDS_HUMAN_LABEL, 1, 30);
  assert.equal(args[0], "api");
  assert.match(args[1], /sort=updated/);
  assert.match(args[1], /direction=desc/);
  assert.match(args[1], /state=all/);
  assert.match(args[1], new RegExp(`labels=${NEEDS_HUMAN_LABEL}`));
});

test("claim 2 (supporting): a genuinely unchanged label set costs exactly one request, never the flat re-read the fixed `state=all` fetch used to pay", () => {
  const rows = [issueRow(1, "open", "2026-08-01T00:00:00Z"), issueRow(2, "closed", "2026-07-01T00:00:00Z")];
  const known = new Map(rows.map((r) => [r.number, knownIssue(r)]));
  let calls = 0;
  const out = fetchLabelledIssuesRest("o", "r", NEEDS_HUMAN_LABEL, () => {
    calls += 1;
    return rows;
  }, known);
  assert.equal(calls, 1);
  assert.equal(out.calls, 1);
  assert.equal(out.rows.length, 2, "both rows survive the refresh even though neither was re-mapped past the stop");
});

// ── claim 3: "a cold cache still reaches every row the board needs, bounded and reported rather
//    than silently truncated" ───────────────────────────────────────────────────────────────────

test("claim 3: a cold issue cache is bounded at BOARD_MAX_PAGES and REPORTS the truncation rather than stopping silently", () => {
  let calls = 0;
  const fetch = (): unknown => {
    calls += 1;
    // Always a full page and every number is fresh, so neither the short-page nor the
    // known-row stop ever fires -- the walk is forced to the ceiling.
    return Array.from({ length: 100 }, (_, i) => issueRow(calls * 1000 + i, "open", "2026-08-01T00:00:00Z"));
  };

  const out = fetchLabelledIssuesRest("o", "r", NEEDS_HUMAN_LABEL, fetch);

  assert.equal(out.mode, "full");
  assert.equal(out.calls, BOARD_MAX_PAGES, "the walk is bounded, never unbounded");
  assert.equal(out.truncated, true, "hitting the ceiling must be REPORTED, not silent");
  assert.equal(out.rows.length, BOARD_MAX_PAGES * 100, "every row inside the bound is still returned, not dropped");
});

test("claim 3 (control): a cold issue cache that never approaches the ceiling reports truncated=false", () => {
  const out = fetchLabelledIssuesRest("o", "r", NEEDS_HUMAN_LABEL, () => [issueRow(1, "open", "2026-08-01T00:00:00Z")]);
  assert.equal(out.truncated, false);
  assert.equal(out.calls, 1);
});

// ── claim 4: "the board still names closed and merged work after the bound is applied" ─────────

test("claim 4: a PR merged years ago, and an issue closed years ago, are both still named -- no recency bound drops an old row", () => {
  const oldMerged = prRow(500, "closed", "2019-01-01T00:00:00Z", { merged_at: "2019-01-01T00:00:00Z" });
  const knownPrs: Map<number, BoardPrRest> = new Map([[500, mapBoardPr(oldMerged)]]);
  const prOut = fetchBoardPrsRest(
    "o",
    "r",
    (args) => ((args[1] ?? "").includes("state=open") ? [] : [oldMerged]),
    knownPrs,
  );
  assert.equal(prOut.rows.find((r) => r.number === 500)?.state, "MERGED", "a PR merged years ago is still named on the board");

  const oldClosedIssue = issueRow(700, "closed", "2019-01-01T00:00:00Z");
  const knownIssues = new Map<number, BoardIssueRest>([[700, knownIssue(oldClosedIssue)]]);
  const issueOut = fetchLabelledIssuesRest("o", "r", NEEDS_HUMAN_LABEL, () => [oldClosedIssue], knownIssues);
  assert.equal(issueOut.rows.find((r) => r.number === 700)?.state, "closed", "an issue closed years ago is still named too");
});

// ── claim 5: "no value that can change while a PR is open is served past the poll TTL" ─────────

test("claim 5: past the poll TTL, an open PR's changed field AND an issue's changed state are both re-read -- nothing live is served from a stale memo", () => {
  let clock = 0;
  let openTitle = "original title";
  let issueState: "open" | "closed" = "open";
  let issueUpdatedAt = "2026-08-01T00:00:00Z"; // closing an issue always bumps this on real GitHub.
  const github = buildBatchedGithub("o", "r", {
    now: () => clock,
    ttlMs: 150_000,
    exec: (args) => {
      const q = args[1] ?? "";
      if (q.includes("/issues")) return JSON.stringify([issueRow(9, issueState, issueUpdatedAt)]);
      if (q.includes("state=open")) return JSON.stringify([prRow(1, "open", "2026-08-01T00:00:00Z", { title: openTitle })]);
      return JSON.stringify([]);
    },
  });

  assert.equal(github.prByRef("https://github.com/o/r/pull/1")?.title, "original title");
  assert.equal(github.issueByUrl?.("https://github.com/o/r/issues/9")?.state, "open");

  openTitle = "renamed after the cache warmed";
  issueState = "closed";
  issueUpdatedAt = "2026-08-01T00:05:00Z";
  clock += 150_001; // past ttlMs -- the NEXT poll must be a real re-fetch, never a memo.

  assert.equal(
    github.prByRef("https://github.com/o/r/pull/1")?.title,
    "renamed after the cache warmed",
    "an open PR's live field is re-read once the TTL has elapsed",
  );
  assert.equal(github.issueByUrl?.("https://github.com/o/r/issues/9")?.state, "closed", "the issue's live state is re-read too");
});

test("claim 5 (supporting): the poll TTL itself is unchanged by this task -- DEFAULT_BOARD_POLL_TTL_MS stays 150000", () => {
  // This task makes each poll CHEAPER, never RARER (design (iv)) -- lengthening the TTL is the
  // move that trades freshness for bytes rather than removing waste, and is explicitly refused.
  // Asserted here as a value, not merely described, so a future edit fails this test loudly
  // instead of silently drifting the exact bound claim 5 depends on.
  assert.equal(DEFAULT_BOARD_POLL_TTL_MS, 150_000);
});
