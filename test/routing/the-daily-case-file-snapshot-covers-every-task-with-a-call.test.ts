import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadCaseFileSnapshot } from "#src/lib/benchmark-cohort.js";
import { buildFieldTrialsCaseFiles, caseLedgerWindowDays, emptyCarry, isRateLimited, parseCarry,
  planFieldTrialsCaseFiles, type CaseFilePacing, type FieldTrialsCaseFileCarry, type FieldTrialsCaseFilePlan,
  type FieldTrialsCaseFileSource, type ListPrsPage, type ViewPr } from "#src/lib/field-trials-case-files.js";
import type { FlowRow } from "#src/lib/field-trials-flow.js";
import type { Task } from "#src/lib/plan.js";
import { caseFileCommand, parseCasePrSnapshot } from "#src/lib/report-commands.js";
import type { StatusProjection } from "#src/lib/status.js";
import { readTaskCaseLedgers, type TaskCaseFile } from "#src/lib/task-case-file.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const now = "2026-11-24T04:00:00.000Z";
const sha = "c".repeat(40);
const taskId = (i: number) => `W1-T${20000 + i}`;
const daysAgo = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();

function flow(partial: Partial<FlowRow>): FlowRow {
  return { fingerprint: Math.random().toString(16), ts: null, step: "", host: null, actor: null, taskId: null, runId: null,
    assignmentId: null, requestedModel: null, selectedModel: null, servedModel: null, prRepo: null, prNumber: null,
    ...partial } as FlowRow;
}
const call = (i: number, ts: string) => flow({ step: "worker.assignment", taskId: taskId(i), runId: `run-${i}`, ts });
const opened = (i: number, ts: string) => flow({ step: "pr.opened", taskId: taskId(i), prRepo: "craigoley/remudero",
  prNumber: 40000 + i, ts });
const prRaw = (number: number, state: "OPEN" | "MERGED" | "CLOSED", task: string) => ({ number,
  url: `https://github.com/craigoley/remudero/pull/${number}`, state, headRefOid: sha, headRefName: `run-${task}-1`,
  body: `Remudero-Task: ${task}`, mergedAt: state === "MERGED" ? "2026-11-01T00:00:00Z" : null, statusCheckRollup: [] });

/** One build's inputs, with the GitHub reads recorded so a test can count them. */
function setup(rows: FlowRow[], over: { carry?: FieldTrialsCaseFileCarry; outside?: string[]; nowIso?: () => string;
  viewPr?: ViewPr } = {}) {
  const views: number[] = [];
  const pages: number[] = [];
  const ids = new Set(rows.map((row) => row.taskId).filter((id): id is string => !!id && !over.outside?.includes(id)));
  const source: FieldTrialsCaseFileSource = { rows, planIds: ids, carry: over.carry };
  const listPage: ListPrsPage = async (page) => { pages.push(page); return []; };
  const viewPr: ViewPr = over.viewPr ?? (async (number) => { views.push(number); return prRaw(number, "MERGED", taskId(number - 40000)); });
  const pacing: CaseFilePacing = { nowIso: over.nowIso ?? (() => now), sleep: async () => {} };
  const plan = (list: ListPrsPage = listPage, pace: CaseFilePacing = pacing, waitMs?: number): Promise<FieldTrialsCaseFilePlan> =>
    planFieldTrialsCaseFiles(source, list, viewPr, pace, waitMs);
  const build = (files: (plan: FieldTrialsCaseFilePlan) => Promise<TaskCaseFile[]>) =>
    buildFieldTrialsCaseFiles(source, listPage, viewPr, pacing, files);
  return { plan, build, views, pages };
}

test("W1-T14602 criterion 1: every called plan task is a candidate, with no count bound and no 14-day window", async () => {
  // 1,000 called tasks, most of them called long before the old 14-day window, every one with a credited PR.
  const rows = Array.from({ length: 1000 }, (_, i) => [call(i, daysAgo(1 + (i % 90))), opened(i, daysAgo(1 + (i % 90)))]).flat();
  rows.push(call(5000, daysAgo(2)), flow({ step: "worker.assignment", taskId: "W1-T99999", ts: daysAgo(1) }));
  const built = setup(rows, { outside: ["W1-T99999"] });
  const result = await built.build(async (plan) => plan.selected.map((id) => ({ taskId: id }) as unknown as TaskCaseFile));
  assert.equal(result.summary.candidates, 1001, "every called task in the plan is a candidate");
  assert.equal(result.summary.outsidePlan, 1);
  // W1-T14989: the one called task with no credited PR gets a case file too, so its build can read as ended.
  assert.equal(result.files.length, 1001, "one case file for every called task, credited PR or not");
  assert.equal(result.summary.withoutPr, 1, "a called task with no credited PR is counted, not dropped silently");
  assert.ok(result.files.some((file) => file.taskId === taskId(89)), "a task last called 90 days ago is covered");
  // The case-file ledger read reaches back to the oldest selected call.
  const plan = await built.plan();
  assert.equal(plan.oldestCallTs, daysAgo(90));
  assert.equal(caseLedgerWindowDays(now, plan.oldestCallTs), 91);
  assert.equal(caseLedgerWindowDays(now, null), 1);
});

test("W1-T14602 criterion 2: a finished PR is carried with no GitHub call, a changeable one is read again, every unlinked task is searched", async () => {
  const rows = [call(1, daysAgo(3)), opened(1, daysAgo(3)), call(2, daysAgo(2)), opened(2, daysAgo(2)),
    call(3, daysAgo(1)), opened(3, daysAgo(1)), ...Array.from({ length: 40 }, (_, i) => call(100 + i, daysAgo(1)))];
  const carry = emptyCarry();
  carry.finishedPrs["40001"] = { readAt: daysAgo(3), raw: prRaw(40001, "MERGED", taskId(1)) };
  carry.finishedPrs["40002"] = { readAt: daysAgo(2), raw: prRaw(40002, "CLOSED", taskId(2)) };
  let limited = 1;
  const views: number[] = [];
  const first = setup(rows, { carry: parseCarry(JSON.parse(JSON.stringify(carry))),
    viewPr: async (number) => { views.push(number); return prRaw(number, "OPEN", taskId(number - 40000)); } });
  const pages: number[] = [];
  const sleeps: number[] = [];
  // W1-T14728: every unlinked task is looked up in one PR listing, not searched one by one.
  const plan = await first.plan(async (page) => {
    if (limited > 0) { limited -= 1; throw new Error("gh: API rate limit exceeded for installation"); }
    pages.push(page);
    return page === 1 ? [{ number: 40100, body: `Remudero-Task: ${taskId(100)}`, headRefName: "x", updatedAt: daysAgo(1) }] : [];
  }, { nowIso: () => now, sleep: async (ms) => { sleeps.push(ms); } }, 5);
  assert.deepEqual(views, [40003, 40100], "only the PRs that can still change are read");
  assert.equal(plan.summary.prReadsCarried, 2);
  assert.equal(plan.prReads.get(40001)?.readAt, daysAgo(3), "a carried read keeps the time it was made");
  assert.deepEqual(pages, [1, 2], "all 40 unlinked tasks are answered by one listing: past the old 25-search bound");
  assert.equal(plan.summary.withoutPr, 39);
  assert.deepEqual(sleeps, [5], "a rate-limit reply waits and retries the same page");
  assert.equal(plan.summary.rateLimitWaits, 1);
  assert.equal(plan.prNumbers.get(taskId(100)), 40100);
  // The next night: links, finished reads and the listing index are carried, an OPEN PR is not, and EVERY
  // still-unlinked task is looked up again — a PR may have opened since, with no `pr.opened` row.
  const nextCarry = parseCarry(JSON.parse(JSON.stringify(plan.carry)));
  const nextPages: number[] = [];
  const next = setup(rows, { carry: nextCarry });
  const again = await next.plan(async (page) => {
    nextPages.push(page);
    // The PR of W1-T20101 opened after last night's listing; the older PR sits below the watermark.
    return [{ number: 40101, body: `Remudero-Task: ${taskId(101)}`, headRefName: "x", updatedAt: now },
      { number: 40100, body: `Remudero-Task: ${taskId(100)}`, headRefName: "x", updatedAt: daysAgo(2) }];
  });
  assert.deepEqual(nextPages, [1], "the next listing stops at the watermark");
  assert.equal(again.prNumbers.get(taskId(101)), 40101, "a PR opened after an empty listing is linked on the next build");
  assert.equal(again.summary.withoutPr, 38, "all 38 still-unlinked tasks are looked up, none skipped as 'searched before'");
  assert.deepEqual(next.views.sort(), [40003, 40100, 40101], "an OPEN read is never carried");
  // A carry this version did not write, or a damaged entry, starts from nothing.
  assert.deepEqual(parseCarry({ version: "other" }), emptyCarry());
  assert.deepEqual(parseCarry({ ...carry, finishedPrs: { 1: { readAt: now, raw: { state: "OPEN" } } } }).finishedPrs, {});
  assert.equal(isRateLimited(new Error("You have exceeded a secondary rate limit")), true);
  assert.equal(isRateLimited(new Error("HTTP 404: Not Found")), false);
  // A failed read that is not a rate limit is counted and leaves the task without a read, never a guessed one.
  const failing = setup([call(7, daysAgo(1)), opened(7, daysAgo(1))], { viewPr: async () => { throw new Error("HTTP 502"); } });
  const failed = await failing.plan();
  assert.equal(failed.summary.prReadsFailed, 1);
  assert.equal(failed.prReads.size, 0);
  assert.deepEqual(failed.readFailures, [{ read: "view", target: "40007", error: "HTTP 502" }], "the failure keeps GitHub's reason");
  const unlistable = setup([call(8, daysAgo(1))]);
  const listFailed = await unlistable.plan(async () => { throw new Error("HTTP 500"); });
  assert.deepEqual(listFailed.readFailures, [{ read: "list", target: "page 1", error: "HTTP 500" }]);
  assert.equal(listFailed.summary.listFailed, 1);
});

const taskOf = (id: string) => ({ id, title: `Task ${id}`, repo: "remudero", depends_on: [], type: "implement",
  verify: "auto", risk: "high", status: "queued", attempts: 0 }) as Task;
/** The script's batch call over a real (empty) ledger: one caseFileCommand call for the whole selection. */
async function batchFiles(t: TestContext, ids: string[], clock: () => string): Promise<TaskCaseFile[]> {
  const ledger = writeLedger([], { scope: t });
  let printed = "";
  const code = await caseFileCommand(["--tasks", ids.join(","), "--json"], {
    stateDir: ledger.dir, nowIso: clock, resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    readTask: taskOf,
    readLedgers: (dir, taskIds, asOf) => readTaskCaseLedgers(dir, taskIds, asOf),
    readProjection: (task) => ({ taskId: task.id, status: "merged", merged: true, source: "trailer",
      prNumber: 40000 + Number(task.id.slice(4)) - 20000 }) as StatusProjection,
    readPr: (number, _owner, _repo, readAt) => parseCasePrSnapshot(prRaw(number, "MERGED", taskId(number - 40000)), readAt),
    out: (line) => { printed = line; }, err: () => {},
  });
  assert.equal(code, 0);
  return JSON.parse(printed) as TaskCaseFile[];
}

test("W1-T14602 criterion 3: every case file in one snapshot carries the same asOf", async (t) => {
  const rows = Array.from({ length: 30 }, (_, i) => [call(i, daysAgo(i + 1)), opened(i, daysAgo(i + 1))]).flat();
  let tick = Date.parse(now);
  // The clock moves on every read, as a long night of GitHub reads does; the files still share one asOf.
  const clock = () => new Date(tick += 60_000).toISOString();
  const result = await setup(rows, { nowIso: clock }).build((plan) => batchFiles(t, plan.selected, clock));
  assert.equal(result.files.length, 30);
  assert.equal(new Set(result.files.map((file) => file.asOf)).size, 1);
});

test("W1-T14602 criterion 4: no batch bound and no snapshot size bound", async (t) => {
  const ids = Array.from({ length: 1000 }, (_, i) => taskId(i));
  const files = await batchFiles(t, ids, () => now);
  assert.equal(files.length, 1000, "a 1,000-task batch is read, not refused");
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-snapshot-size-"));
  try {
    mkdirSync(join(dir, "field-trials"));
    const path = join(dir, "field-trials", "case-files-latest.json");
    const padded = files.map((file) => ({ ...file, plan: { ...file.plan, pad: "x".repeat(5_000) } }));
    writeFileSync(path, JSON.stringify(padded));
    assert.ok(JSON.stringify(padded).length > 4 * 1024 * 1024, "the fixture is over the old 4 MiB bound");
    assert.equal(loadCaseFileSnapshot(path).length, 1000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
