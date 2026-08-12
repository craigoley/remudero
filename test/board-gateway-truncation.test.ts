import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import { fetchBoardPrsRest, type GhApiFetcher, type RestPullRow } from "../src/lib/open-prs-rest.js";
import { buildBatchedGithub, deriveStatus } from "../src/lib/status.js";

/**
 * W1-T415: `fetchBoardPrsRest` computes `truncated` (open-prs-rest.ts, set when a walk hits
 * `BOARD_MAX_PAGES` on either half) and `buildBatchedGithub` already LEDGERS it into
 * `board_gateway.fetch_bytes` — but nothing EXPOSED it, so a partial GitHub read was consumed as
 * the complete state of the repo by every `deriveStatus` caller. This file proves the fix: a new
 * `GitHub.readTruncated()` accessor, and `derivePrPrecedence`'s existing `readFailed()` defer arm
 * now also deferring on it — ONLY the absence-conclusion, never a credit already found above it.
 *
 * `BOARD_FULL_PAGE_SIZE` (100) and `BOARD_MAX_PAGES` (50) are not exported from open-prs-rest.ts
 * (they are runaway-guard internals, not a public contract), so this file pins their documented
 * values locally -- a future change to either constant fails these tests loudly rather than
 * silently stopping to exercise the ceiling.
 */
const FULL_PAGE_SIZE = 100;
const MAX_PAGES = 50;

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

function ledgerFile(lines: Array<Record<string, unknown>> = []): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-truncation-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  return p;
}

/** A minimal, otherwise-inert REST list row -- a filler PR the fixtures pad pages with. */
function fillerRow(n: number, over: Partial<RestPullRow> = {}): RestPullRow {
  return {
    number: n,
    html_url: `https://github.com/o/r/pull/${n}`,
    state: "open",
    merged_at: null,
    updated_at: "2020-01-01T00:00:00Z",
    head: { ref: "filler" },
    body: "",
    auto_merge: null,
    title: "",
    ...over,
  };
}

/** A MERGED, anchored-trailer, own-run-branch row -- creditable via rung (c) the instant it is seen. */
function creditingRow(n: number, taskId: string, runId: string): RestPullRow {
  return fillerRow(n, {
    state: "closed",
    merged_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    head: { ref: `run-${runId}` },
    body: `Implements ${taskId}.\n\nRemudero-Task: ${taskId}\n`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// DESIGN (iv) / acceptance #4: the open (hot) and closed (cold) walks each set `truncated` on
// their OWN, proved separately -- a fixture that truncated both at once could not tell which
// loop set the flag, and a fixture that only ever truncated the open walk would leave the cold
// path (the binding one, per the rationale) unexercised.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("fetchBoardPrsRest: the OPEN (hot) walk alone hits BOARD_MAX_PAGES and sets truncated, while the CLOSED (cold) walk exits early on its own short page, untouched", () => {
  const calls = { open: 0, closed: 0 };
  const fetch: GhApiFetcher = (args) => {
    const q = String(args[1] ?? "");
    if (q.includes("state=open")) {
      calls.open += 1;
      // Always a FULL page: never triggers the `rows.length < perPage` early break, so the hot
      // loop walks every one of the 50 pages and hits the ceiling.
      return Array.from({ length: FULL_PAGE_SIZE }, (_, i) => fillerRow(1_000_000 + calls.open * 1000 + i));
    }
    calls.closed += 1;
    return []; // closed: an empty page ends the cold walk after its very first request.
  };
  const result = fetchBoardPrsRest("o", "r", fetch);
  assert.equal(result.truncated, true, "the open walk alone must set truncated");
  assert.equal(calls.open, MAX_PAGES, "the open walk should have been forced through every page up to the ceiling");
  assert.equal(calls.closed, 1, "the closed walk must exit on its own short page -- the open walk's truncation must not leak into it");
});

test("fetchBoardPrsRest: the CLOSED (cold) walk alone hits BOARD_MAX_PAGES and sets truncated, while the OPEN (hot) walk exits early on its own short page, untouched", () => {
  const calls = { open: 0, closed: 0 };
  const fetch: GhApiFetcher = (args) => {
    const q = String(args[1] ?? "");
    if (q.includes("state=open")) {
      calls.open += 1;
      return []; // open: an empty page ends the hot walk after its very first request.
    }
    calls.closed += 1;
    // Always a FULL page, and every row's updated_at differs from anything a `known` map could
    // hold (there is none here), so `reachedKnown` never fires and the cold walk runs to the
    // ceiling exactly like the open walk does in the sibling test above.
    return Array.from({ length: FULL_PAGE_SIZE }, (_, i) => fillerRow(2_000_000 + calls.closed * 1000 + i, { state: "closed", merged_at: "2020-01-01T00:00:00Z" }));
  };
  const result = fetchBoardPrsRest("o", "r", fetch);
  assert.equal(result.truncated, true, "the closed walk alone must set truncated");
  assert.equal(calls.closed, MAX_PAGES, "the closed walk should have been forced through every page up to the ceiling");
  assert.equal(calls.open, 1, "the open walk must exit on its own short page -- the closed walk's truncation must not leak into it");
});

test("fetchBoardPrsRest: neither walk approaching the ceiling leaves truncated false -- the control for the two fixtures above", () => {
  const fetch: GhApiFetcher = (args) => {
    const q = String(args[1] ?? "");
    return q.includes("state=open") ? [] : [];
  };
  const result = fetchBoardPrsRest("o", "r", fetch);
  assert.equal(result.truncated, false);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Acceptance #1/#2/#3, end to end through the REAL precedence chain: `buildBatchedGithub` driven
// by an injected `exec` (never `fetchAll`, which would bypass `fetchBoardPrsRest` and so could
// never actually reach truncation) forces the COLD half -- the binding case per the rationale --
// past BOARD_MAX_PAGES, then `deriveStatus` is asked about a task whose crediting PR either falls
// outside that reached view, falls inside it, or (the control) never truncates at all.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An `opts.exec` that forces the CLOSED (cold) half to truncate: every closed page returns a
 * FULL {@link FULL_PAGE_SIZE} rows for all {@link MAX_PAGES} pages the walk is allowed, so it
 * never takes the `rows.length < perPage` early exit and hits the ceiling on page 50. The OPEN
 * (hot) half always answers empty, so it is never the cause of the truncation this fixture
 * produces -- isolating the binding half exactly as the two `fetchBoardPrsRest`-level tests above
 * do directly. `credit`, if given, is spliced into page 1 -- i.e. INSIDE the reached view; leaving
 * it `undefined` means no such row exists ANYWHERE the walk reaches, simulating a crediting PR
 * that would only appear on a page past the ceiling.
 */
function coldTruncatingExec(credit?: RestPullRow): (args: string[]) => string {
  return (args: string[]) => {
    const q = String(args[1] ?? "");
    if (q.includes("state=open")) return JSON.stringify([]);
    // `&page=` (never `per_page=`, which would also match a bare `/page=(\d+)/`) -- the query
    // string is `...&per_page=100&page=<n>`, and `"per_page=100"` itself ends in the substring
    // `"page=100"`, so an unanchored pattern silently parses every page as page 100.
    const page = Number(q.match(/[&?]page=(\d+)/)?.[1] ?? "1");
    const rows: RestPullRow[] = [];
    if (page === 1 && credit) rows.push(credit);
    while (rows.length < FULL_PAGE_SIZE) rows.push(fillerRow(3_000_000 + page * 1000 + rows.length, { state: "closed", merged_at: "2020-01-01T00:00:00Z" }));
    return JSON.stringify(rows);
  };
}

test("W1-T415 acceptance #1: a task whose crediting PR falls OUTSIDE a truncated view is left indeterminate, never reported not-merged", () => {
  const github = buildBatchedGithub("o", "r", { exec: coldTruncatingExec(undefined) });
  const proj = deriveStatus(task({ id: "W1-T900" }), { ledgerPath: ledgerFile(), github });
  // DESIGN (v): prove the fixture actually REACHED truncation -- a fixture whose page count never
  // reaches the bound tests nothing and reads identically to one that does.
  assert.equal(github.readTruncated?.(), true, "the fixture must have actually hit BOARD_MAX_PAGES on the cold half");
  assert.equal(proj.indeterminate, true, "no evidence found in a truncated view must defer, not conclude not-merged");
  assert.equal(proj.merged, false);
  assert.notEqual(proj.source, "none", "a truncated read's absence must never collapse to the same shape a genuine absence produces");
});

test("W1-T415 acceptance #2: a task the truncated view DOES contain is still credited -- truncation defers only the absences", () => {
  const runId = "W1-T901-1786000000000";
  const credit = creditingRow(3_000_001, "W1-T901", runId);
  const github = buildBatchedGithub("o", "r", { exec: coldTruncatingExec(credit) });
  const proj = deriveStatus(task({ id: "W1-T901" }), { ledgerPath: ledgerFile(), github });
  assert.equal(github.readTruncated?.(), true, "the fixture must have actually hit BOARD_MAX_PAGES on the cold half");
  assert.equal(proj.merged, true, "a credit the (truncated) view DOES contain must still land -- truncation must not veto a rung reached above it");
  assert.equal(proj.source, "trailer");
  assert.equal(proj.prNumber, 3_000_001);
});

test("W1-T415 acceptance #3a: an untruncated fetch behaves exactly as it does today -- no evidence is a confirmed not-merged, not deferred", () => {
  const noTruncationExec: (args: string[]) => string = (args) => {
    const q = String(args[1] ?? "");
    // Both halves answer a single short page -- neither approaches BOARD_MAX_PAGES.
    return q.includes("state=open") ? JSON.stringify([]) : JSON.stringify([fillerRow(4_000_001, { state: "closed", merged_at: "2020-01-01T00:00:00Z" })]);
  };
  const github = buildBatchedGithub("o", "r", { exec: noTruncationExec });
  const proj = deriveStatus(task({ id: "W1-T902" }), { ledgerPath: ledgerFile(), github });
  assert.equal(github.readTruncated?.(), false, "the control fixture must not have truncated");
  assert.equal(github.readFailed?.(), false);
  assert.equal(proj.indeterminate, undefined, "an untruncated, healthy read with no evidence is a confirmed absence, not deferred");
  assert.equal(proj.merged, false);
  assert.equal(proj.source, "none");
});

test("W1-T415 acceptance #3b: a genuinely FAILED fetch still defers via readFailed -- truncation is a separate signal and must not mask or substitute for it", () => {
  const enobufsError = Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS", status: null, stderr: "" });
  const github = buildBatchedGithub("o", "r", {
    exec: () => {
      throw enobufsError;
    },
  });
  const proj = deriveStatus(task({ id: "W1-T903" }), { ledgerPath: ledgerFile(), github });
  assert.equal(github.readFailed?.(), true);
  // A THROW never reaches `fetchBoardPrsRest`'s own return, so `readTruncated()` must stay at its
  // untouched initial `false` -- a failed read and a truncated read are different facts, and a
  // throw is evidence of neither the walk running nor it being cut short.
  assert.equal(github.readTruncated?.(), false, "a fetch that never completed cannot itself be reported truncated");
  assert.equal(proj.indeterminate, true);
  assert.equal(proj.source, "throttled");
  assert.equal(proj.unavailableReason, "buffer_overflow");
  assert.equal(proj.merged, false);
});
