// W1-T9730 — a flake incident reopens only on CI runs newer than the runs its last filing cited.
// Live case 2026-10-15: W1-T9668 was filed at 15:49:58Z citing nine runs from 38750735314 on. At 16:01-16:07Z
// the selector-shadow gardener read the logs of four OLDER runs (38747185379..38748813664) and wrote their
// test.flake_retry rows then. The after-filing rule compared the rows' write time, so three of those PRs read
// fresh and the same origin was re-filed as W1-T9707.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { flakeIncidentOrigin, runFlakeIncidentGardener } from "#src/lib/flake-incident-gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const FILE = "test/a-ci-friction-cause-owned-by-a-test-alone-escalates-as-no-owner.test.ts";
const ORIGIN = flakeIncidentOrigin(FILE, "");
const NOW = Date.parse("2026-10-15T20:00:00Z");
const HOUR = 3_600_000;

type Row = Record<string, unknown>;

/** W1-T9668 filed three hours ago over runs 100..109 on ten PRs, its repair since merged. */
function harness(filedRunIds: number[] | null = Array.from({ length: 10 }, (_, i) => 100 + i)) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9730-`));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, FILE, ".."), { recursive: true });
  writeFileSync(join(root, FILE), "");
  const ledger = join(root, "state", "ledger.ndjson");
  const log = (step: string, extra: Row = {}, ts = NOW) => {
    appendFileSync(ledger, JSON.stringify({ ts: new Date(ts).toISOString(), step, ...extra }) + "\n");
  };
  const shardRow = (pr: number, runId: number, ts: number) => log("test.flake_retry", {
    file: FILE, ci_run_id: runId, shard: 3, source: "selector-shadow", retry_outcome: "recovered",
    head_sha: `head-${pr}`, base_sha: `base-${pr}`, pr_numbers: [pr],
  }, ts);
  const fixRoundRow = (pr: number, ts: number) => {
    log("fix.scope_rerouted", {
      run_id: `run-${pr}`, task_id: `W1-T${pr}`, paths: [], attribution: "diff-cannot-reach", reached: [],
      failing_test_files: [FILE], head_sha: `head-${pr}`,
    }, ts);
    log("test.flake_retry", {
      run_id: `run-${pr}`, task_id: `W1-T${pr}`, file: FILE, source: "fix-round", retry_outcome: "recovered",
      pr_numbers: [pr], head_sha: `head-${pr}`,
    }, ts);
  };
  const filedPrs = Array.from({ length: 10 }, (_, i) => 1000 + i);
  filedPrs.forEach((pr, i) => shardRow(pr, 100 + i, NOW - 4 * HOUR));
  log("flake_incident.filed", {
    origin: ORIGIN, task_id: "W1-T9668", file: FILE, title: "", prs: filedPrs,
    ...(filedRunIds === null ? {} : { run_ids: filedRunIds }),
  }, NOW - 3 * HOUR);
  const landed: Array<{ paths: string[]; title: string }> = [];
  const deps = {
    stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(NOW), log,
    openWorkspace: () => ({
      root, branch: "selector-shadow-garden-1",
      land: (opts: { paths: string[]; title: string; body: string }) => (landed.push(opts), `https://github.com/acme/remudero/pull/${30000 + landed.length}`),
      dispose: () => {},
    }),
  };
  const sources = {
    mintTaskId: () => "W1-T9707",
    readChangedPaths: () => ["src/lib/unrelated.ts"],
    planTasks: () => [{ id: "W1-T9668", origin: ORIGIN, status: "merged" }],
    readSource: () => "",
  };
  const rows = (step: string): Row[] => readFileSync(ledger, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Row).filter((r) => r.step === step);
  return { deps, sources, landed, rows, shardRow, fixRoundRow };
}

test("W1-T9730: a run older than the filing does not reopen the incident", async () => {
  const h = harness();
  // Three new PRs whose runs predate every run the filing cited, read and written an hour after it.
  [2001, 2002, 2003].forEach((pr, i) => h.shardRow(pr, 90 + i, NOW - HOUR));
  await runFlakeIncidentGardener(h.deps, h.sources);
  assert.equal(h.landed.length, 0, "rows written late for old runs are not new failures");
  assert.equal(h.rows("flake_incident.filed").length, 1);
});

test("W1-T9730: a run newer than the filing reopens the incident", async () => {
  const h = harness();
  [2001, 2002, 2003].forEach((pr, i) => h.shardRow(pr, 110 + i, NOW - HOUR));
  await runFlakeIncidentGardener(h.deps, h.sources);
  assert.equal(h.landed.length, 1, "three PRs failing on runs newer than the filing reopen it, as today");
});

test("W1-T9730: a fix-round row after the filing still counts by when it was written", async () => {
  const late = harness();
  [2001, 2002, 2003].forEach((pr) => late.fixRoundRow(pr, NOW - HOUR));
  await runFlakeIncidentGardener(late.deps, late.sources);
  assert.equal(late.landed.length, 1, "a fix-round row names no run, so its ts decides");

  const early = harness();
  [2001, 2002, 2003].forEach((pr) => early.fixRoundRow(pr, NOW - 5 * HOUR));
  await runFlakeIncidentGardener(early.deps, early.sources);
  assert.equal(early.landed.length, 0, "a fix-round row written before the filing is not fresh");
});

test("W1-T9730: a filing that cited no run falls back to when each row was written", async () => {
  const h = harness(null);
  [2001, 2002, 2003].forEach((pr, i) => h.shardRow(pr, 90 + i, NOW - HOUR));
  await runFlakeIncidentGardener(h.deps, h.sources);
  assert.equal(h.landed.length, 1, "an older filed row carries no run_ids, so the rows' ts decides, as before W1-T9730");
});
