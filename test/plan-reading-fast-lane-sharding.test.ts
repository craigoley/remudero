// W1-T3191: plan/docs changes already pay for CI matrix runners. This suite proves the
// conservative plan-reading candidate set is divided across all of them by the same duration ledger
// as source CI, without turning an unreadable candidate set into an empty green run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "test-tier-manifest.mjs");
const workflow = parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, {
    strategy?: { matrix?: { shard?: number[] } };
    steps?: Array<{ name?: string; run?: string }>;
  }>;
};
const CI_SHARD_COUNT = workflow.jobs.ci?.strategy?.matrix?.shard?.length ?? 0;
assert.ok(CI_SHARD_COUNT > 0, "ci.yml must declare at least one shard");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  selectPlanReadingShard: (
    candidateText: string,
    testFiles: string[],
    manifest: { thresholdMs: number; files: Record<string, number> },
    shard: { index: number; count: number },
  ) => { candidates: string[]; files: string[]; predictedDurationMs: number };
  listTestFiles: (root: string) => string[];
  tierFiles: (
    testFiles: string[],
    manifest: { thresholdMs: number; files: Record<string, number> },
  ) => { fast: string[]; slow: string[] };
  main: (
    argv: string[],
    opts?: { spawn?: (cmd: string, args: string[], opts?: unknown) => { status: number | null; signal?: string | null } },
  ) => number;
};

const { selectPlanReadingShard, listTestFiles, tierFiles, main } = mod;

const files = [
  "test/a.test.ts",
  "test/b.test.ts",
  "test/c.test.ts",
  "test/d.test.ts",
  "test/e.test.ts",
  "test/f.test.ts",
  "test/g.test.ts",
  "test/h.test.ts",
];
const manifest = {
  thresholdMs: 5_000,
  files: Object.fromEntries(files.map((file, index) => [file, 800 - index * 100])),
};
const candidates = `${files.join("\n")}\n`;

test("all four plan-reading shards are non-empty, disjoint, and their normalized union is exact", () => {
  const selected = [1, 2, 3, 4].map((index) =>
    selectPlanReadingShard(candidates, files, manifest, { index, count: 4 }),
  );
  assert.deepEqual(selected.map((entry) => entry.files.length), [2, 2, 2, 2]);
  assert.deepEqual([...new Set(selected.flatMap((entry) => entry.files))].sort(), files);
  assert.equal(selected.flatMap((entry) => entry.files).length, files.length, "no candidate may be duplicated");
});

test("recorded durations drive deterministic longest-processing-time assignment", () => {
  const first = selectPlanReadingShard(candidates, files, manifest, { index: 1, count: 4 });
  const again = selectPlanReadingShard([...files].reverse().join("\n"), files, manifest, { index: 1, count: 4 });
  assert.deepEqual(first.files, ["test/a.test.ts", "test/h.test.ts"]);
  assert.equal(first.predictedDurationMs, 900);
  assert.deepEqual(again, first, "candidate input order cannot move an equal manifest and shard count");
});

// W1-T4430 retitled this from "... unknown, untiered, empty ..." — an untiered candidate is no
// longer a refusal (the next test proves it is admitted). Every other arm is unchanged, and
// "unknown" (a candidate naming no file on disk) is the arm that still guards a stale name.
test("unsafe, duplicate, unknown, empty, and under-width candidate sets all fail closed", () => {
  assert.throws(
    () => selectPlanReadingShard(candidates, files, manifest, { index: 0, count: 4 }),
    /valid shard index\/count/,
  );
  const invalid = [
    "",
    "../escape.test.ts\n",
    "/tmp/absolute.test.ts\n",
    "C:\\absolute.test.ts\n",
    "test/a.test.ts\ntest/a.test.ts\n",
    "test/unknown.test.ts\n",
    "test/a.test.ts\ntest/b.test.ts\ntest/c.test.ts\n",
  ];
  for (const text of invalid) {
    assert.throws(
      () => selectPlanReadingShard(text, files, manifest, { index: 1, count: 4 }),
      `candidate set must refuse: ${JSON.stringify(text)}`,
    );
  }
});

test("W1-T4430: an untiered candidate is admitted into exactly one shard, in the fast tier at duration 0", () => {
  // The retired contract refused this set (`/manifest/`), which on the real tree sent every
  // plan/docs PR to the full source fallback once the seeded duration-0 rows were removed.
  const untieredManifest = { thresholdMs: 5_000, files: { ...manifest.files } };
  delete untieredManifest.files["test/h.test.ts"];
  const selected = [1, 2, 3, 4].map((index) =>
    selectPlanReadingShard(candidates, files, untieredManifest, { index, count: 4 }),
  );
  assert.ok(selected.every((entry) => entry.files.length > 0), "every shard is still filled");
  assert.equal(
    selected.filter((entry) => entry.files.includes("test/h.test.ts")).length,
    1,
    "the untiered candidate runs in exactly one shard — never dropped, never duplicated",
  );
  assert.deepEqual(selected.flatMap((entry) => entry.files).sort(), files, "the union is still exact");
  assert.equal(untieredManifest.files["test/h.test.ts"], undefined, "selection wrote no row for it");
  const { fast, slow } = tierFiles(files, untieredManifest);
  assert.ok(fast.includes("test/h.test.ts") && !slow.includes("test/h.test.ts"), "an absent row is the fast tier");
});

test("the candidate runner spawns exactly its selected shard and never spawns after invalid input", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}plan-reading-candidates-`));
  const candidatePath = join(scratch, "candidates.txt");
  const candidateFiles = [
    "test/a-plan-only-filing-passes-on-naming-coincidence-not-evidence.test.ts",
    "test/ci-sharding.test.ts",
    "test/fast-lane-classifier.test.ts",
    "test/plan-reading-fast-lane-sharding.test.ts",
    "test/test-tier-manifest.test.ts",
  ];
  writeFileSync(candidatePath, candidateFiles.join("\n"));
  // W1-T4430: a pinned manifest with NO row for one candidate, so this proves the runner admits an
  // untiered file rather than leaning on whatever the real ledger happens to record today.
  const manifestPath = join(scratch, "manifest.json");
  const untiered = "test/plan-reading-fast-lane-sharding.test.ts";
  writeFileSync(
    manifestPath,
    JSON.stringify({
      thresholdMs: 5_000,
      files: Object.fromEntries(candidateFiles.filter((f) => f !== untiered).map((f, i) => [f, 500 + i * 100])),
    }),
  );
  const spawned: string[] = [];
  for (let index = 1; index <= 4; index += 1) {
    let args: string[] = [];
    let spawns = 0;
    const status = main(
      ["--root", REPO_ROOT, "--manifest", manifestPath, "--run-candidates", candidatePath, "--shard", `${index}/4`],
      {
        spawn: (_cmd, childArgs) => {
          spawns += 1;
          args = childArgs;
          return { status: 0 };
        },
      },
    );
    assert.equal(status, 0, `shard ${index}/4 runs`);
    assert.equal(spawns, 1, `shard ${index}/4 spawns exactly once`);
    assert.ok(args.includes("--test"));
    const shardFiles = args.filter((arg) => arg.endsWith(".test.ts"));
    assert.ok(shardFiles.length > 0, `shard ${index}/4 is filled`);
    spawned.push(...shardFiles);
  }
  assert.deepEqual(spawned.sort(), [...candidateFiles].sort(), "the four spawns cover every candidate exactly once");
  assert.ok(spawned.includes(untiered), "including the candidate with no manifest row");

  let invalidSpawns = 0;
  const refused = main(["--root", REPO_ROOT, "--run-candidates", "does-not-exist", "--shard", "2/4"], {
    spawn: () => {
      invalidSpawns += 1;
      return { status: 0 };
    },
  });
  assert.notEqual(refused, 0);
  assert.equal(invalidSpawns, 0);

  assert.equal(
    main(["--root", REPO_ROOT, "--select-candidates", candidatePath]),
    2,
    "candidate mode without an explicit shard must refuse",
  );

  const priorLog = console.log;
  const selected: string[] = [];
  console.log = (value?: unknown) => selected.push(String(value ?? ""));
  try {
    assert.equal(main(["--root", REPO_ROOT, "--select-candidates", candidatePath, "--shard", "2/4"]), 0);
  } finally {
    console.log = priorLog;
  }
  assert.equal(selected.length, 1);
  assert.match(selected[0] ?? "", /^test\/.*\.test\.ts$/);
});

test("the workflow uses every paid shard, names fallback telemetry, and preserves source CI", () => {
  const ci = (workflow.jobs.ci.steps ?? []).map((step) => step.run ?? "").join("\n");
  assert.doesNotMatch(ci, /matrix\.shard \}\}" != "1"[\s\S]{0,200}shard 1 owns the plan\/docs-reading set/);
  assert.match(ci, new RegExp(String.raw`--select-candidates plan-reading-suites\.txt --shard \$\{\{ matrix\.shard \}\}\/${CI_SHARD_COUNT}`));
  assert.match(
    ci,
    new RegExp(String.raw`RETRY_SCRIPT="scripts\/test-with-retry\.mjs"[\s\S]*--run-candidates plan-reading-suites\.txt --shard \$\{\{ matrix\.shard \}\}\/${CI_SHARD_COUNT}`),
  );
  assert.match(ci, /plan-reading shard summary/);
  assert.match(ci, /fallback=source/);
  assert.match(
    ci,
    new RegExp(String.raw`test-tier-manifest\.mjs --run fast --shard \$\{\{ matrix\.shard \}\}\/${CI_SHARD_COUNT} --base "\$TIER_BASE"`),
    "source PRs keep W1-T2904's duration-balanced fast-tier path",
  );
});

test("coverage validates the tier manifest before Playwright or an instrumented shard", () => {
  const coverage = workflow.jobs["coverage-ratchet"]?.steps ?? [];
  const indexOf = (pattern: RegExp) => coverage.findIndex((step) => pattern.test(step.name ?? ""));
  const tierIndex = indexOf(/Validate the coverage test-tier manifest/);
  const browserIndex = indexOf(/Install Playwright's Chromium/);
  const coverageIndex = indexOf(/Test with coverage/);
  assert.ok(tierIndex >= 0, "coverage must have an early tier-manifest admission step");
  assert.ok(browserIndex > tierIndex, "tier admission must precede the browser install");
  assert.ok(coverageIndex > tierIndex, "tier admission must precede the instrumented test run");
  assert.match(coverage[tierIndex]?.run ?? "", /test-tier-manifest\.mjs --check --base HEAD\^1/);
});

test("the required slow job suppresses duplicate plan-reading execution only after exact validation", () => {
  const slow = (workflow.jobs["test-slow"].steps ?? []).map((step) => step.run ?? "").join("\n");
  assert.match(slow, /diff-class\.mjs --changed-files/);
  assert.match(slow, new RegExp(`--select-candidates plan-reading-suites\\.txt --shard 1/${CI_SHARD_COUNT}`));
  assert.match(slow, /plan-reading matrix established/);
  assert.match(slow, /npm run --silent test:slow/);
});

// W1-T4430 retitled this from "... complete, tiered, and fills every shard": a candidate need not be
// tiered any more, so the population it is checked against is the test files ON DISK, not the
// manifest's rows (which after W1-T4430 hold only measured files).
test("the current conservative candidate set is complete, on disk, and fills every shard", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/diff-class.mjs", "--list-plan-reading-suites"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const current = result.stdout.trim();
  const allTests = listTestFiles(REPO_ROOT);
  const currentManifest = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/test-tier-manifest.json"), "utf8"));
  const currentSet = current.split("\n");
  assert.ok(currentSet.length >= 257, "the filing measured 257; base growth may only increase the conservative set");
  const assigned: string[] = [];
  for (let index = 1; index <= CI_SHARD_COUNT; index += 1) {
    const shardFiles = selectPlanReadingShard(current, allTests, currentManifest, { index, count: CI_SHARD_COUNT }).files;
    assert.ok(shardFiles.length > 0);
    assigned.push(...shardFiles);
  }
  assert.deepEqual(assigned.sort(), [...currentSet].sort(), "all CI shards cover the whole candidate set exactly once");
});
