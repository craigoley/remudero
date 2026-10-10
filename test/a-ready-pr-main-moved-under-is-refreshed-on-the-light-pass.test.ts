/**
 * W1-T7214 — A READY PR MAIN MOVED UNDER IS REFRESHED ON THE LIGHT PASS.
 *
 * 2026-10-09: #10353 merged at 13:52:22Z on a base that lacked #10349 (13:43:28Z, the same file
 * src/lib/read-model-worker.ts). W1-T6022's ready-overlap refresh ran only in a full sweep, a run in
 * flight starved the full sweep, and `buildSweepLightHook` passed `updateBranch: undefined` — so the
 * light pass could arm that PR but never refresh it. Main stayed red 55 minutes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  DEFAULT_SWEEP_POLICY,
  runLightPassReadyRefresh,
  type ArmedStalledPr,
  type BaseChangedFiles,
  type OpenPrView,
} from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildSweepLightHook } from "../src/run-task.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";

const NOW = 1_800_000_000_000;
const FILE = "src/lib/read-model-worker.ts";

function pr(prNumber: number, minutesOld: number, changedFiles: string[] = [FILE]): OpenPrView {
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
    changedFiles,
  };
}

/** #10353's shape (overlap, older), a newer overlap, a no-overlap PR, and a truncated base list. */
const OLDER = pr(10353, 30);
const NEWER = pr(10354, 5);
const NO_OVERLAP = pr(10355, 60, ["src/other.ts"]);
const UNKNOWN = pr(10356, 90);

function facts(prs: readonly OpenPrView[]) {
  const behindMainByPr = new Map(prs.map((p) => [p.prNumber, 2]));
  const baseChangedFilesByPr = new Map<number, BaseChangedFiles>(prs.map((p) =>
    [p.prNumber, { files: [FILE], truncated: p.prNumber === UNKNOWN.prNumber }]));
  return { behindMainByPr, baseChangedFilesByPr };
}

function harness(
  prs: readonly OpenPrView[],
  extra: { ledger?: Array<Record<string, unknown>>; status?: string; mergeQueue?: () => boolean } = {},
) {
  const updated: ArmedStalledPr[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const run = () => runLightPassReadyRefresh(prs, {
    ledgerPath: "/nonexistent-rmd-w1-t7214/ledger.ndjson",
    runId: "LIGHT-W1-T7214",
    now: () => NOW,
    readLedger: () => extra.ledger ?? [],
    appendLine: (_path, row) => { rows.push(row); },
    updateBranch: (target) => { updated.push(target); return "updated"; },
    ...(extra.mergeQueue ? { mergeQueue: extra.mergeQueue } : {}),
    ...(extra.status === undefined ? {} : {
      readActionsStatusSummary: async () => ({ components: [{ name: "Actions", status: extra.status! }], incidents: [] }),
    }),
    ...facts(prs),
  }, DEFAULT_SWEEP_POLICY);
  return { updated, rows, run };
}

test("a light pass refreshes the one ready PR whose own file main changed since its CI base; with two such PRs it refreshes only the older head; a ready PR with no overlap and a ready-unknown PR are not refreshed; under an incident hold it refreshes nothing", async () => {
  // The one ready-overlap PR is refreshed; the no-overlap and ready-unknown PRs beside it are not.
  const one = harness([NO_OVERLAP, OLDER, UNKNOWN], { status: "operational" });
  assert.equal(await one.run(), OLDER.prNumber);
  assert.deepEqual(one.updated.map((c) => [c.prNumber, c.updateReason]), [[OLDER.prNumber, "ready-overlap"]]);
  const attempted = one.rows.find((r) => r.step === "sweep.update_branch.attempted");
  assert.equal(attempted?.source, "light_pass", "the update row names the light pass");
  assert.equal(attempted?.head_sha, OLDER.headSha);
  assert.deepEqual(attempted?.matching_base_files, [FILE]);
  assert.equal(one.rows.find((r) => r.step === "sweep.update_branch.updated")?.source, "light_pass");

  // Two ready-overlap PRs: only the older head, and only one update per pass.
  const two = harness([NEWER, OLDER]);
  await two.run();
  assert.deepEqual(two.updated.map((c) => c.prNumber), [OLDER.prNumber]);

  // No overlap and ready-unknown alone: nothing is refreshed and no row is written.
  const neither = harness([NO_OVERLAP, UNKNOWN]);
  assert.equal(await neither.run(), undefined);
  assert.deepEqual(neither.updated, []);
  assert.deepEqual(neither.rows, []);

  // W1-T5939: an Actions incident holds every refresh.
  for (const status of ["major_outage", "degraded_performance"]) {
    const held = harness([NEWER, OLDER], { status });
    assert.equal(await held.run(), undefined, status);
    assert.deepEqual(held.updated, [], status);
  }
});

test("W1-T7214: the light refresh shares the full sweep's one update per (PR, head) and stands down under a merge queue", async () => {
  // W1-T5921: a head the full sweep (or an earlier light pass) already spent is not pressed again.
  const spent = harness([NEWER, OLDER], {
    ledger: [{ step: "sweep.update_branch.attempted", pr_number: OLDER.prNumber, head_sha: OLDER.headSha }],
  });
  await spent.run();
  assert.deepEqual(spent.updated.map((c) => c.prNumber), [NEWER.prNumber]);

  // W1-T5903: the queue tests the merged result, so the refresh stands down and names it once.
  const queued = harness([OLDER], { mergeQueue: () => true });
  assert.equal(await queued.run(), undefined);
  assert.deepEqual(queued.updated, []);
  assert.equal(queued.rows.filter((r) => r.step === "sweep.update_branch.skipped_queue").length, 1);
});

// ── the production light hook wires it ───────────────────────────────────────────────────────────

const HEAD = { ref: "run-W1-T7214-1", sha: "7214000000000000000000000000000000000d01" };
const PR = { number: 7214, html_url: "https://github.com/o/r/pull/7214", state: "open" };

/** One ready PR (green, reviewed) whose own file main changed two commits ago. Routes are first-match
 *  substrings, so `/pulls/7214/files` and `update-branch` precede `/pulls/7214`. */
function readyOverlapRoutes(): GhShimRoute[] {
  const json = (value: unknown) => JSON.stringify(value);
  return [
    { when: "required_status_checks", stdout: json({ contexts: ["ci-gate", "remudero-review"] }) },
    { when: "pulls?state=open", stdout: json([{ ...PR, body: "Remudero-Task: W1-T7214", updated_at: new Date(Date.now() - 60_000).toISOString(), head: HEAD, auto_merge: null }]) },
    { when: `compare/${HEAD.sha}...main`, stdout: json({ ahead_by: 2, files: [{ filename: FILE }] }) },
    { when: "/pulls/7214/files", stdout: json([{ filename: FILE }]) },
    { when: "update-branch", stdout: "{}" },
    { when: "/pulls/7214", stdout: json({ ...PR, merged_at: null, head: HEAD }) },
    { when: "check-runs", stdout: json({ check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] }) },
    { when: "/status", stdout: json({ statuses: [{ context: "remudero-review", state: "success" }] }) },
    { when: "", stdout: "{}" },
  ];
}

test("W1-T7214: buildSweepLightHook presses update-branch on a ready PR main moved under", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t7214-hook-`));
  const shim = ghShim(readyOverlapRoutes(), { kind: "t7214-gh" });
  const oldPath = process.env.PATH;
  const transportEnv = ["RMD_GH_TRANSPORT_FLOOR", "RMD_GH_CACHE_HOME", "RMD_GH_SHARED_READ_GAP_MS"] as const;
  const oldTransportEnv = transportEnv.map((key) => [key, process.env[key]] as const);
  process.env.PATH = `${shim.dir}:${oldPath}`;
  // The shim is local: inherited reviewer cadence must not refuse its fixture reads.
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  try {
    const hook = buildSweepLightHook(
      "o", "r", { root } as never, join(root, "ledger.ndjson"), "RUN-T7214",
      { tasks: [] } as never, (step, extra) => { logs.push({ step, extra }); },
      { loadedCodeSha: "boot-loaded-sha", isLoadedCodeAtOrAfter: () => false },
    );
    await withLiveWritesAllowed(() => hook());
    assert.ok(!logs.some((l) => l.step === "sweep_light.error"), JSON.stringify(logs));
    const updates = shim.calls().filter((call) => call.includes("pulls/7214/update-branch"));
    assert.equal(updates.length, 1, JSON.stringify(shim.calls()));
    assert.ok(updates[0]!.includes(`expected_head_sha=${HEAD.sha}`), "the update is leased to the head CI judged");
  } finally {
    process.env.PATH = oldPath;
    for (const [key, value] of oldTransportEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
