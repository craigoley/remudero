import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { rotateLedger } from "../src/lib/ledger.js";
import { DEFAULT_SWEEP_POLICY, dueRepairFilings, mainLatestRunFromLedger } from "../src/lib/sweep.js";
import { buildLedgerIndex, deriveStatus, recordCredit, type CreditStore, type GitHub } from "../src/lib/status.js";
import type { Task } from "../src/lib/plan.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// E6 (2026-10-02): the carried core was 91% of the ceiling, so the live file rotated every ~5 min.
// These pin the rows a rotation stops carrying, and that each live-file reader of them answers the same.

const NOW = Date.parse("2026-10-02T12:00:00Z");
const URL = "https://github.com/craigoley/remudero/pull/";

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function disposed(pr: number, msAgo: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { ts: at(msAgo), run_id: "DAEMON-1", task_id: `W1-T${pr}`, step: "sweep.disposed", pr_number: pr, pr_url: `${URL}${pr}`, ...extra };
}

/** Noise no retention set keeps, so the file crosses the ceiling and every kept row is a choice. */
function noise(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ ts: at(60_000), run_id: "n", task_id: "n", step: "cli.invoked", pad: "x".repeat(200), i }));
}

function rotate(rows: Array<Record<string, unknown>>): { live: Array<Record<string, unknown>>; archived: string; dir: string; path: string } {
  const fx = writeLedger([...rows, ...noise(200)]);
  return rotateAt(fx.path, fx.dir);
}

function rotateAt(path: string, dir: string): { live: Array<Record<string, unknown>>; archived: string; dir: string; path: string } {
  const fx = { path, dir };
  const result = rotateLedger(fx.path, { ceilingBytes: 30_000, smoothingWindowMs: 0, now: () => new Date(NOW) });
  assert.equal(result.rotated, true, "the fixture crosses the ceiling");
  const live = readFileSync(fx.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(!live.some((r) => r.step === "ledger.rotation_shed"), "the shed valve never fires here: every drop is the carry rule");
  const archived = readdirSync(fx.dir)
    .filter((n) => n.endsWith(".ndjson.gz"))
    .map((n) => gunzipSync(readFileSync(join(fx.dir, n))).toString("utf8"))
    .join("");
  return { live, archived, dir: fx.dir, path: fx.path };
}

const DAY = 86_400_000;

function mergedFact(pr: number, msAgo: number): Record<string, unknown> {
  return { ts: at(msAgo), run_id: "SWEEP-1", task_id: `W1-T${pr}`, step: "verdict.merged", verdict: "merged", pr_number: pr, pr_url: `${URL}${pr}` };
}

test("a rotation stops carrying a merged PR's sweep rows but keeps the ones a reader still asks for", () => {
  const rows = [
    disposed(101, 9_000, { head_sha: "aaa", disposition: "post-review", acted: true }),
    disposed(101, 8_000, { head_sha: "bbb", disposition: "blocked-fixable", acted: true, reason: "ci red" }),
    disposed(101, 7_000, { head_sha: "ccc", disposition: "stale", acted: true, keep_head_branch: "run-x" }),
    disposed(101, 6_000, { head_sha: "ddd", disposition: "wait", acted: false }),
    mergedFact(101, 5_000),
    disposed(303, 1_000, { head_sha: "fff", disposition: "wait", acted: false }),
  ];
  const { live, archived, dir } = rotate(rows);
  try {
    const swept = live.filter((r) => r.step === "sweep.disposed");
    const merged = swept.filter((r) => r.pr_number === 101).map((r) => r.head_sha).sort();
    assert.deepEqual(merged, ["bbb", "ccc"], "only the acted repair row and the reaper's keep_head_branch row of a merged PR are carried");
    assert.ok(swept.some((r) => r.pr_number === 303), "a PR with no merge fact is carried");
    for (const head of ["aaa", "ddd"]) assert.ok(archived.includes(`"head_sha":"${head}"`), `the dropped ${head} row is still in the archive`);

    const policy = { ...DEFAULT_SWEEP_POLICY, repairFilingThreshold: 1 };
    assert.deepEqual(dueRepairFilings(live, NOW, policy), dueRepairFilings(rows, NOW, policy), "dueRepairFilings reads the same");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a long-waiting open PR keeps every sweep row a reader reads however far it trails the sweep", () => {
  // #202 has waited five days behind #303's fresh rows. W1-T5517: its newest row and its acted repair
  // row stay; the older head's post-review row, which no live reader reads, is archived.
  const rows = [
    disposed(202, 5 * DAY + 2_000, { head_sha: "e0", disposition: "blocked-fixable", acted: true }),
    disposed(202, 5 * DAY, { head_sha: "eee", disposition: "post-review", acted: true }),
    disposed(202, 5 * DAY - 1_000, { head_sha: "e2", disposition: "wait", acted: false }),
    mergedFact(999, 2_000),
    disposed(303, 1_000, { head_sha: "fff", disposition: "wait", acted: false }),
  ];
  const { live, archived, dir } = rotate(rows);
  try {
    const heads = live.filter((r) => r.step === "sweep.disposed" && r.pr_number === 202).map((r) => r.head_sha).sort();
    assert.deepEqual(heads, ["e0", "e2"]);
    assert.ok(archived.includes(`"head_sha":"eee"`));
    const policy = { ...DEFAULT_SWEEP_POLICY, repairFilingThreshold: 1 };
    assert.deepEqual(dueRepairFilings(live, NOW, policy), dueRepairFilings(rows, NOW, policy), "dueRepairFilings reads the same");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rotation carries only the newest main health row and the newest dep-review decision per task", () => {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 30; i++) {
    rows.push({ ts: at(600_000 - i * 1_000), run_id: "D", task_id: "DAEMON", step: "main.health.observed", sha: `s${i}`, state: i === 29 ? "red" : "green", failing_checks: i === 29 ? ["ci"] : [] });
    rows.push({ ts: at(600_000 - i * 1_000), run_id: "d", task_id: `dep-review-PR${i % 2}`, step: "dep-review.decided", decision: `d${i}` });
  }
  const { live, dir } = rotate(rows);
  try {
    const health = live.filter((r) => r.step === "main.health.observed");
    assert.equal(health.length, 1);
    assert.deepEqual(mainLatestRunFromLedger(live), mainLatestRunFromLedger(rows), "the sweep's main-health reader reads the same");
    const decided = live.filter((r) => r.step === "dep-review.decided").map((r) => `${String(r.task_id)}=${String(r.decision)}`).sort();
    assert.deepEqual(decided, ["dep-review-PR0=d28", "dep-review-PR1=d29"], "the depReview seam's at(-1) per task survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function review(pr: number, msAgo: number, head: string, planOnly: boolean): Record<string, unknown> {
  return {
    ts: at(msAgo), run_id: `PR-${pr}`, task_id: `PR-${pr}`, step: "review.posted", pr_url: `${URL}${pr}`, head_sha: head,
    state: "success", plan_only: planOnly, decision_verdict: { state: "success", criteria: [], summary: "y".repeat(400) },
  };
}

/** A durable head-branch credit for `pr`, revalidated by the real deriveStatus against `ledger`, scanned and indexed alike. */
function creditAfterRotation(pr: number, head: string, ledger: Array<Record<string, unknown>>): { merged: boolean; invalidated: boolean } {
  const scanned = creditVia(pr, head, ledger, false);
  assert.deepEqual(creditVia(pr, head, ledger, true), scanned, "the ledger index answers as the scan does");
  return scanned;
}

function creditVia(pr: number, head: string, ledger: Array<Record<string, unknown>>, indexed: boolean): { merged: boolean; invalidated: boolean } {
  const taskId = `W9-T${pr}`;
  let store: CreditStore = recordCredit({}, taskId, { source: "head-branch", prUrl: `${URL}${pr}`, prNumber: pr, prState: "MERGED" });
  const merged = { number: pr, url: `${URL}${pr}`, state: "MERGED", headRefName: `run-${taskId}-1`, headRefOid: head };
  const github = {
    prByRef: () => merged,
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [merged],
    headRefName: () => undefined,
    prBody: () => undefined,
  } as unknown as GitHub;
  const task = { id: taskId, title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0 } as unknown as Task;
  const projection = deriveStatus(task, {
    ledgerPath: "/tmp/does-not-exist/ledger.ndjson",
    github,
    readLedger: () => ledger,
    readCreditStore: () => store,
    writeCreditStore: (next) => { store = next; },
    ...(indexed ? { ledgerIndex: buildLedgerIndex(ledger) } : {}),
  });
  return { merged: projection.merged, invalidated: store[taskId]?.invalidated?.["head-branch"] !== undefined };
}

test("a rotation stops carrying a merged PR's review rows and the plan-only credit refusal still reads its marker", () => {
  const rows = [
    review(401, 9_000, "plan-head", true),
    review(402, 8_500, "impl-head", false),
    mergedFact(401, 8_000),
    mergedFact(402, 7_500),
    review(303, 1_000, "open-head", false),
  ];
  const { live, archived, dir } = rotate(rows);
  try {
    const reviewed = live.filter((r) => r.step === "review.posted").map((r) => r.pr_url);
    assert.deepEqual(reviewed, [`${URL}303`], "only the PR with no recorded merge keeps its review row");
    assert.ok(archived.includes('"head_sha":"plan-head"') && archived.includes('"head_sha":"impl-head"'), "the dropped review rows are in the archive");
    const markers = live.filter((r) => r.step === "review.plan_only_reviewed");
    assert.deepEqual(markers.map((r) => [r.pr_url, r.head_sha, r.plan_only]), [[`${URL}401`, "plan-head", true]], "one marker for the plan-only review and none for the implementation");
    assert.deepEqual(creditAfterRotation(401, "plan-head", live), { merged: false, invalidated: true }, "the plan-only refusal reads the same after rotation");
    assert.deepEqual(creditAfterRotation(401, "plan-head", rows), { merged: false, invalidated: true }, "and the same before it");
    assert.deepEqual(creditAfterRotation(402, "impl-head", live), { merged: true, invalidated: false }, "an implementation PR keeps its credit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second rotation carries the plan-only review marker without writing a duplicate", () => {
  // Two postings for one head make one marker; the row seen again later (as a recarry would bring it) makes none.
  const { dir, path } = rotate([review(501, 9_000, "plan-head", true), review(501, 8_500, "plan-head", true), mergedFact(501, 8_000)]);
  try {
    assert.equal(readFileSync(path, "utf8").split("review.plan_only_reviewed").length - 1, 1, "one marker per PR head");
    appendFileSync(path, [review(501, 7_000, "plan-head", true), ...noise(200)].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { live } = rotateAt(path, dir);
    const markers = live.filter((r) => r.step === "review.plan_only_reviewed");
    assert.equal(markers.length, 1, "the carried marker is the only one");
    assert.equal(markers[0].pr_url, `${URL}501`);
    assert.deepEqual(creditAfterRotation(501, "plan-head", live), { merged: false, invalidated: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
