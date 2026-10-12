import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBehindMainByPr } from "../src/run-task.js";
import {
  DEFAULT_SWEEP_POLICY,
  openPrsBehindMain,
  REFRESH_RELEVANT_BASE_PATHS,
  runSweep,
  type BaseChangedFiles,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "./helpers/sweep-test.js";

const NOW = 1_800_000_000_000;
const POLICY: SweepPolicy = {
  ...DEFAULT_SWEEP_POLICY,
  reviewWaitingBranchRefreshEnabled: true,
  reviewWaitingBranchRefreshThreshold: 10,
};

function pr(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 3_600_000).toISOString(),
    headSha: `head${prNumber}`,
    autoMergeArmed: false,
    mergeState: "behind",
    changedFiles: ["src/mine.ts", "test/mine.test.ts"],
    ...over,
  };
}

const base = (files: string[], truncated = false): BaseChangedFiles => ({ files, truncated });

function deps(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: "/tmp/rmd-w1-t5696-ledger.ndjson",
    runId: "SWEEP-W1-T5696",
    now: () => NOW,
    readLedger: () => [],
    appendLine: () => {},
    ...over,
  };
}

test("unit test: a reviewed PR 17 behind whose main-side changes touch none of its files is not refreshed", () => {
  const target = pr(5001);
  const behind = new Map([[5001, 17]]);
  const unrelated = new Map([[5001, base(["src/other.ts", "docs/readme.md", "scripts/some-tool.mjs"])]]);
  assert.deepEqual(openPrsBehindMain([target], behind, POLICY, new Set(), unrelated), []);
  // and the same PR WITHOUT the base-file fact keeps today's refresh
  assert.equal(openPrsBehindMain([target], behind, POLICY)[0]?.updateReason, "distance");
});

test("unit test: one whose own file changed on main is refreshed as distance-overlap", () => {
  const target = pr(5002);
  const picked = openPrsBehindMain(
    [target],
    new Map([[5002, 17]]),
    POLICY,
    new Set(),
    new Map([[5002, base(["src/other.ts", "src/mine.ts"])]]),
  );
  assert.equal(picked[0]?.updateReason, "distance-overlap");
  assert.deepEqual(picked[0]?.matchingBaseFiles, ["src/mine.ts"]);
});

test("unit test: a recorded baseline change refreshes as distance-baseline", () => {
  const behind = new Map([[5003, 17]]);
  for (const path of ["scripts/comment-load-baseline.json", ".github/workflows/ci.yml", "package-lock.json", "tsconfig.build.json"]) {
    const picked = openPrsBehindMain([pr(5003)], behind, POLICY, new Set(), new Map([[5003, base(["src/other.ts", path])]]));
    assert.equal(picked[0]?.updateReason, "distance-baseline", path);
    assert.deepEqual(picked[0]?.matchingBaseFiles, [path]);
  }
  // a path outside the list, even one that looks close, is not refresh-relevant
  const near = openPrsBehindMain([pr(5003)], behind, POLICY, new Set(), new Map([[5003, base(["scripts/baseline-monotonic-check.mjs", "docs/package.json.md"])]]));
  assert.deepEqual(near, []);
  assert.ok(REFRESH_RELEVANT_BASE_PATHS.includes("scripts/*-baseline.json"));
});

test("unit test: an unknown base-file list keeps the refresh", () => {
  const behind = new Map([[5004, 17]]);
  const empty = new Map<number, BaseChangedFiles>();
  assert.equal(openPrsBehindMain([pr(5004)], behind, POLICY, new Set(), empty)[0]?.updateReason, "distance-unknown");
  const truncated = new Map([[5004, base(["src/other.ts"], true)]]);
  assert.equal(openPrsBehindMain([pr(5004)], behind, POLICY, new Set(), truncated)[0]?.updateReason, "distance-unknown");
  const noPrFiles = pr(5004, { changedFiles: undefined });
  const known = new Map([[5004, base(["src/other.ts"])]]);
  assert.equal(openPrsBehindMain([noPrFiles], behind, POLICY, new Set(), known)[0]?.updateReason, "distance-unknown");
});

test("unit test: a distance past the ceiling refreshes with no overlap", () => {
  const unrelated = new Map([[5005, base(["src/other.ts"])]]);
  assert.deepEqual(openPrsBehindMain([pr(5005)], new Map([[5005, 60]]), POLICY, new Set(), unrelated), []);
  const picked = openPrsBehindMain([pr(5005)], new Map([[5005, 61]]), POLICY, new Set(), unrelated);
  assert.equal(picked[0]?.updateReason, "distance-ceiling");
});

test("unit test: an armed stale-blocked PR is refreshed with no overlap", () => {
  const target = pr(5006, {
    autoMergeArmed: true,
    mergeState: "clean",
    mergeable: true,
    mergeableState: "blocked",
  });
  const unrelated = new Map([[5006, base(["src/other.ts"])]]);
  const picked = openPrsBehindMain([target], new Map([[5006, 2]]), POLICY, new Set(), unrelated);
  assert.equal(picked[0]?.updateReason, "stale-blocked");
});

test("unit test: the update-branch ledger row names the cause and the matching base files", async () => {
  const rows: Array<Record<string, unknown>> = [];
  await runSweep(
    [pr(5007)],
    deps({
      behindMainByPr: new Map([[5007, 17]]),
      baseChangedFilesByPr: new Map([[5007, base(["src/mine.ts"])]]),
      appendLine: (_path, row) => rows.push(row),
      updateBranch: () => "updated",
    }),
    POLICY,
  );
  const updated = rows.find((row) => row.step === "sweep.update_branch.updated");
  assert.equal(updated?.update_reason, "distance-overlap");
  assert.deepEqual(updated?.matching_base_files, ["src/mine.ts"]);

  const quiet: Array<Record<string, unknown>> = [];
  await runSweep(
    [pr(5008)],
    deps({
      behindMainByPr: new Map([[5008, 17]]),
      baseChangedFilesByPr: new Map([[5008, base(["src/other.ts"])]]),
      appendLine: (_path, row) => quiet.push(row),
      updateBranch: () => "updated",
    }),
    POLICY,
  );
  assert.equal(quiet.some((row) => String(row.step).startsWith("sweep.update_branch.")), false);
});

test("unit test: buildBehindMainByPr fills the base-file map from the same compare call", () => {
  const calls: string[][] = [];
  const full = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` }));
  const fetch = (argv: string[]): unknown => {
    calls.push(argv);
    if (argv[1]?.includes("head5009")) return { ahead_by: 17, files: [{ filename: "src/a.ts" }, { status: "x" }] };
    if (argv[1]?.includes("head5010")) return { ahead_by: 20, files: full };
    return { ahead_by: 3 };
  };
  const files = new Map<number, BaseChangedFiles>();
  const behind = buildBehindMainByPr("o", "r", [pr(5009), pr(5010), pr(5011)], fetch, NOW, files);
  assert.equal(calls.length, 3, "one compare per PR, no second call for the files");
  assert.deepEqual([...behind], [[5009, 17], [5010, 20], [5011, 3]]);
  assert.deepEqual(files.get(5009), { files: ["src/a.ts"], truncated: false });
  assert.equal(files.get(5010)?.truncated, true);
  assert.equal(files.has(5011), false, "a compare without files[] records no base-file fact");
});
