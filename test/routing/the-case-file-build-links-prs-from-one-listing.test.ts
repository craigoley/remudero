import assert from "node:assert/strict";
import { test } from "node:test";
import { creditedTasks, emptyCarry, ghPrListingPage, parseCarry, planFieldTrialsCaseFiles, type CaseFilePacing,
  type FieldTrialsCaseFileCarry, type ListedPr, type ListPrsPage, type ViewPr } from "#src/lib/field-trials-case-files.js";
import type { FlowRow } from "#src/lib/field-trials-flow.js";

const now = "2026-11-24T20:00:00.000Z";
const taskId = (i: number) => `W1-T${30000 + i}`;
const minutesAgo = (minutes: number) => new Date(Date.parse(now) - minutes * 60_000).toISOString();
const call = (i: number) => ({ fingerprint: `f${i}`, ts: minutesAgo(i + 1), step: "worker.assignment", host: null,
  actor: null, taskId: taskId(i), runId: `run-${i}`, assignmentId: null, requestedModel: null, selectedModel: null,
  servedModel: null, prRepo: null, prNumber: null }) as FlowRow;
const pr = (number: number, updatedAt: string, body: string, headRefName = "feature"): ListedPr =>
  ({ number, updatedAt, body, headRefName });
const pacing: CaseFilePacing = { nowIso: () => now, sleep: async () => {} };
const viewPr: ViewPr = async (number) => ({ number, state: "MERGED" });

/** A listing over `rows`, newest update first, 100 per page, with every page it serves recorded. */
function listing(rows: ListedPr[], fail?: (page: number) => Error | undefined) {
  const sorted = [...rows].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const pages: number[] = [];
  const listPage: ListPrsPage = async (page) => {
    const error = fail?.(page);
    if (error) throw error;
    pages.push(page);
    return sorted.slice((page - 1) * 100, page * 100);
  };
  return { listPage, pages };
}

function plan(count: number, listPage: ListPrsPage, carry?: FieldTrialsCaseFileCarry) {
  const rows = Array.from({ length: count }, (_, i) => call(i));
  return planFieldTrialsCaseFiles({ rows, planIds: new Set(rows.map((row) => row.taskId!)), carry }, listPage, viewPr, pacing);
}

test("W1-T14728 criterion 1: the case-file build links every task from one PR listing with no per-task search", async () => {
  // 600 called tasks with no `pr.opened` row: 599 credited by a trailer, one by its run- head branch, plus
  // PRs that credit no called task. The old build spent one search per task.
  const rows = Array.from({ length: 599 }, (_, i) => pr(50000 + i, minutesAgo(i), `Fix\n\nRemudero-Task: ${taskId(i)}`));
  rows.push(pr(50599, minutesAgo(700), "no trailer", `run-${taskId(599)}-1795551310736`));
  rows.push(...Array.from({ length: 50 }, (_, i) => pr(60000 + i, minutesAgo(800 + i), "unrelated")));
  const { listPage, pages } = listing(rows);
  const result = await plan(600, listPage);
  assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 7, 8], "650 PRs are 7 pages, and the empty 8th ends the listing");
  assert.equal(result.summary.linkedByListing, 600, "invariant:one-listing-links-every-task");
  assert.equal(result.summary.withoutPr, 0);
  assert.equal(result.prNumbers.get(taskId(599)), 50599, "a run- head branch credits its task");
  assert.equal(result.prNumbers.get(taskId(0)), 50000);
  assert.equal(result.carry.listedThrough, minutesAgo(0), "the carry keeps the newest update listed");
  assert.equal(Object.keys(result.carry.listedPrs).length, 600, "only a PR crediting a task is indexed");
  // Two PRs crediting one task stay ambiguous, as one search with two hits was.
  const twice = listing([pr(1, minutesAgo(1), `Remudero-Task: ${taskId(0)}`), pr(2, minutesAgo(2), `Remudero-Task: ${taskId(0)}`)]);
  const ambiguous = await plan(1, twice.listPage);
  assert.equal(ambiguous.summary.listingAmbiguous, 1);
  assert.equal(ambiguous.prNumbers.size, 0);
  // creditedTasks finds exactly what creditsTask accepts: an exact trailer line, a run-<id>-<digits> head.
  assert.deepEqual(creditedTasks(pr(3, now, `Remudero-Task: W1-T1\nRemudero-Task: W1-T2 extra\n Remudero-Task: W1-T3`,
    "run-W1-T4-12")), ["W1-T1", "W1-T4"]);
  assert.deepEqual(creditedTasks({ number: 4 }), []);
  assert.deepEqual(creditedTasks(pr(5, now, "", "run-W1-T5-x")), []);
});

test("W1-T14728 criterion 2: a later case-file build lists only PRs updated since the last one", async () => {
  const first = listing(Array.from({ length: 250 }, (_, i) => pr(50000 + i, minutesAgo(i + 60), `Remudero-Task: ${taskId(i)}`)));
  const night1 = await plan(260, first.listPage);
  assert.deepEqual(first.pages, [1, 2, 3, 4], "the first build lists everything");
  const carry = parseCarry(JSON.parse(JSON.stringify(night1.carry)));
  assert.equal(carry.listedThrough, minutesAgo(60));
  // Tonight: a new PR for a still-unlinked task, and an edit that removed PR 50000's trailer; everything else is older.
  const second = listing([pr(50255, minutesAgo(5), `Remudero-Task: ${taskId(255)}`), pr(50000, minutesAgo(10), "trailer removed"),
    ...Array.from({ length: 249 }, (_, i) => pr(50001 + i, minutesAgo(i + 61), `Remudero-Task: ${taskId(i + 1)}`))]);
  const night2 = await plan(260, second.listPage, carry);
  assert.deepEqual(second.pages, [1], "only the page reaching the watermark is read");
  assert.equal(night2.summary.listedPrs, 2, "only the two PRs updated since the watermark are re-indexed");
  assert.equal(night2.prNumbers.get(taskId(255)), 50255, "a PR opened since the last build is linked");
  assert.equal(night2.prNumbers.has(taskId(0)), false, "a PR that no longer credits the task loses its link");
  assert.equal(night2.prNumbers.get(taskId(249)), 50249, "a link from an older listing is kept");
  assert.equal(night2.summary.withoutPr, 10, "W1-T30255 gained a PR and W1-T30000 lost one");
  assert.equal(night2.carry.listedThrough, minutesAgo(5));
  // A carry from the search era (v1), or a damaged index, starts a full listing.
  assert.deepEqual(parseCarry({ version: "field-trials-case-carry-v1", links: {}, finishedPrs: {} }), emptyCarry());
  const damaged = parseCarry({ ...carry, listedPrs: { 1: "W1-T1", 2: [3], 3: ["W1-T3"] }, listedThrough: 7 });
  assert.deepEqual(damaged.listedPrs, { 3: ["W1-T3"] });
  assert.equal(damaged.listedThrough, undefined);
});

test("W1-T14728 criterion 3: a failed PR listing page is named and links no task as PR-less", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => pr(50000 + i, minutesAgo(i), `Remudero-Task: ${taskId(i)}`));
  const { listPage } = listing(rows, (page) => page === 2 ? new Error("HTTP 502: Bad Gateway") : undefined);
  const result = await plan(160, listPage);
  assert.deepEqual(result.readFailures, [{ read: "list", target: "page 2", error: "HTTP 502: Bad Gateway" }]);
  assert.equal(result.summary.listFailed, 1);
  assert.equal(result.summary.withoutPr, 0, "no task is counted as having no PR");
  assert.equal(result.summary.unlinkedListingFailed, 60, "the 60 unanswered tasks are named as unknown");
  assert.equal(result.summary.linkedByListing, 100, "the page that was read still links its tasks");
  assert.equal(result.carry.listedThrough, undefined, "no watermark is written past a gap");
  // The next build lists the gap again from the old watermark.
  const prior = emptyCarry();
  prior.listedThrough = minutesAgo(500);
  const retry = await plan(160, listing(rows, (page) => page === 1 ? new Error("HTTP 500") : undefined).listPage, prior);
  assert.equal(retry.carry.listedThrough, minutesAgo(500), "a failed pass keeps the prior watermark");
});

test("W1-T14728: the gh listing page reads one REST page and keeps only the fields the index needs", async () => {
  const calls: string[][] = [];
  const page = ghPrListingPage(async (args) => {
    calls.push(args);
    return JSON.stringify([{ number: 7, body: null, head: { ref: "run-W1-T7-1" }, updated_at: now, title: "x" }, null]);
  }, "craigoley/remudero");
  assert.deepEqual(await page(3), [{ number: 7, body: null, headRefName: "run-W1-T7-1", updatedAt: now },
    { number: undefined, body: undefined, headRefName: undefined, updatedAt: undefined }]);
  assert.deepEqual(calls, [["api", "repos/craigoley/remudero/pulls?state=all&sort=updated&direction=desc&per_page=100&page=3"]]);
  await assert.rejects(ghPrListingPage(async () => "{}", "o/r")(1), /PR listing page 1 returned no list/);
});
