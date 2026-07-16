import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
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

test("source (c) correction-awareness: a correction.provenance line debunking this exact credit blocks it, even though ownership + anchor would otherwise pass", () => {
  const fixture = ownedTrailerFixture("W1-TX", "W1-TX-1730000000000");
  const github = fakeGitHub({
    byTrailer: { "W1-TX": { number: 12, url: "u/12", state: "MERGED" } },
    headRefByUrl: { "u/12": fixture.headRefName },
    bodyByUrl: { "u/12": fixture.body },
  });
  const ledgerPath = ledgerFile([
    { step: "correction.provenance", task_id: "W1-TX", claimed_pr_url: "u/12", actual_pr_url: "u/99" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github });
  assert.equal(proj.source, "none");
  assert.equal(proj.merged, false);
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
