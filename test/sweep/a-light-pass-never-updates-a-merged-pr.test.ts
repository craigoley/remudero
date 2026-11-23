/**
 * W1-T14315 — A LIGHT PASS NEVER UPDATES A MERGED PR.
 *
 * 2026-11-20..22: every light-pass ready-overlap refresh error read "head ref does not exist (HTTP
 * 422)", on a PR that had already merged (#20523 merged 18:18:54Z, update attempted 18:19:22Z). The
 * open-PR snapshot is older than the base facts: once a PR merges, its own files are on main, so
 * ready-overlap reads them as main moving under the PR and selects it. runLightPassReadyRefresh now
 * reads the selected PR's live state before it writes, and gives the slot to the next candidate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  runLightPassReadyRefresh,
  type ArmedStalledPr,
  type BaseChangedFiles,
  type LiveStateResult,
  type OpenPrView,
} from "#src/lib/sweep.js";

const NOW = 1_800_000_000_000;
const FILE = "src/lib/read-model-worker.ts";

function pr(prNumber: number, minutesOld: number): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    headSha: `head-${prNumber}`,
    lastActivityAt: new Date(NOW - minutesOld * 60_000).toISOString(),
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    autoMergeArmed: true,
    mergeState: "clean",
    changedFiles: [FILE],
  };
}

/** The oldest head is the one the slot selects first; the newer one is the next eligible candidate. */
const MERGED = pr(20523, 30);
const NEXT = pr(20524, 5);

function harness(prs: readonly OpenPrView[], readLiveState?: (p: OpenPrView) => LiveStateResult | Promise<LiveStateResult>) {
  const updated: ArmedStalledPr[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const reads: number[] = [];
  const run = () => runLightPassReadyRefresh(prs, {
    ledgerPath: "/nonexistent-rmd-w1-t14315/ledger.ndjson",
    runId: "LIGHT-W1-T14315",
    now: () => NOW,
    readLedger: () => [],
    appendLine: (_path, row) => { rows.push(row); },
    updateBranch: (target) => { updated.push(target); return "updated"; },
    ...(readLiveState ? { readLiveState: (p: OpenPrView) => { reads.push(p.prNumber); return readLiveState(p); } } : {}),
    behindMainByPr: new Map(prs.map((p) => [p.prNumber, 2])),
    baseChangedFilesByPr: new Map<number, BaseChangedFiles>(prs.map((p) => [p.prNumber, { files: [FILE], truncated: false }])),
  }, DEFAULT_SWEEP_POLICY);
  return { updated, rows, reads, run };
}

const stepsFor = (rows: Array<Record<string, unknown>>, prNumber: number) =>
  rows.filter((r) => r.pr_number === prNumber).map((r) => r.step);

test("W1-T14315 criterion 1: a selected PR that merged after the snapshot gets no update-branch call and no attempted or error row, and the next eligible candidate is refreshed in the same pass", async () => {
  const h = harness([NEXT, MERGED], (p) => p.prNumber === MERGED.prNumber
    ? { ok: true, state: "MERGED", headSha: MERGED.headSha }
    : { ok: true, state: "OPEN", headSha: p.headSha });
  assert.equal(await h.run(), NEXT.prNumber, "the slot passes to the next eligible candidate");
  assert.deepEqual(h.updated.map((c) => c.prNumber), [NEXT.prNumber], "the merged PR is never updated");
  assert.deepEqual(h.reads, [MERGED.prNumber, NEXT.prNumber], "each selected PR is read live before its write");
  assert.deepEqual(stepsFor(h.rows, MERGED.prNumber), ["sweep.update_branch.skipped_not_open"]);
  const skipped = h.rows.find((r) => r.step === "sweep.update_branch.skipped_not_open");
  assert.match(String(skipped?.reason), /MERGED/);
  assert.equal(skipped?.source, "light_pass");
  assert.equal(skipped?.head_sha, MERGED.headSha);
  assert.deepEqual(stepsFor(h.rows, NEXT.prNumber), ["sweep.update_branch.attempted", "sweep.update_branch.updated"]);

  // A closed PR and an open PR whose head moved stand down the same way, each naming its reason.
  const closed = harness([MERGED], () => ({ ok: true, state: "CLOSED", headSha: MERGED.headSha }));
  assert.equal(await closed.run(), undefined, "with no other candidate the slot is left empty");
  assert.deepEqual(closed.updated, []);
  assert.deepEqual(closed.rows.map((r) => r.step), ["sweep.update_branch.skipped_not_open"]);
  assert.match(String(closed.rows[0]?.reason), /CLOSED/);
  const moved = harness([MERGED], () => ({ ok: true, state: "OPEN", headSha: "head-pushed" }));
  assert.equal(await moved.run(), undefined);
  assert.deepEqual(moved.updated, []);
  assert.deepEqual(moved.rows.map((r) => r.step), ["sweep.update_branch.skipped_not_open"]);
  assert.match(String(moved.rows[0]?.reason), /head moved from head-20523 to head-pushed/);
  assert.equal(moved.rows[0]?.live_head_sha, "head-pushed");
});

test("W1-T14315 criterion 2: an open PR at the selected head, and a PR whose live state cannot be read, are refreshed as on origin/main", async () => {
  const expected = [MERGED.prNumber];
  const expectedSteps = ["sweep.update_branch.attempted", "sweep.update_branch.updated"];
  const cases: Array<[string, ((p: OpenPrView) => LiveStateResult | Promise<LiveStateResult>) | undefined]> = [
    ["open at the selected head", (p) => ({ ok: true, state: "OPEN", headSha: p.headSha })],
    ["open with an unread head", () => ({ ok: true, state: "OPEN" })],
    ["a failed read", () => ({ ok: false })],
    ["a thrown read", () => { throw new Error("gh pr view: HTTP 502"); }],
    ["a rejected read", () => Promise.reject(new Error("gh pr view: timeout"))],
    ["no live reader wired", undefined],
  ];
  for (const [name, read] of cases) {
    const h = harness([NEXT, MERGED], read);
    assert.equal(await h.run(), MERGED.prNumber, name);
    assert.deepEqual(h.updated.map((c) => c.prNumber), expected, name);
    assert.deepEqual(h.rows.map((r) => r.step), expectedSteps, name);
    assert.equal(h.rows[0]?.source, "light_pass", name);
  }
});
