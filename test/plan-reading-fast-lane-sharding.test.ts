// W1-T3191: plan/docs changes already pay for four CI matrix runners. This suite proves the
// conservative plan-reading candidate set is divided across all four by the same duration ledger
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
  jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
};
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  selectPlanReadingShard: (
    candidateText: string,
    testFiles: string[],
    manifest: { thresholdMs: number; files: Record<string, number> },
    shard: { index: number; count: number },
  ) => { candidates: string[]; files: string[]; predictedDurationMs: number };
  main: (
    argv: string[],
    opts?: { spawn?: (cmd: string, args: string[], opts?: unknown) => { status: number | null; signal?: string | null } },
  ) => number;
};

const { selectPlanReadingShard, main } = mod;

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

test("unsafe, duplicate, unknown, untiered, empty, and under-width candidate sets all fail closed", () => {
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
  const untieredManifest = { thresholdMs: 5_000, files: { ...manifest.files } };
  delete untieredManifest.files["test/h.test.ts"];
  assert.throws(() => selectPlanReadingShard(candidates, files, untieredManifest, { index: 1, count: 4 }), /manifest/);
});

test("the candidate runner spawns exactly its selected shard and never spawns after invalid input", () => {
  const candidatePath = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}plan-reading-candidates-`)), "candidates.txt");
  writeFileSync(
    candidatePath,
    [
      "test/a-plan-only-filing-passes-on-naming-coincidence-not-evidence.test.ts",
      "test/ci-sharding.test.ts",
      "test/fast-lane-classifier.test.ts",
      "test/plan-reading-fast-lane-sharding.test.ts",
      "test/test-tier-manifest.test.ts",
    ].join("\n"),
  );
  let args: string[] = [];
  const status = main(["--root", REPO_ROOT, "--run-candidates", candidatePath, "--shard", "2/4"], {
    spawn: (_cmd, childArgs) => {
      args = childArgs;
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.ok(args.includes("--test"));
  assert.ok(args.some((arg) => arg.endsWith(".test.ts")));

  let invalidSpawns = 0;
  const refused = main(["--root", REPO_ROOT, "--run-candidates", "does-not-exist", "--shard", "2/4"], {
    spawn: () => {
      invalidSpawns += 1;
      return { status: 0 };
    },
  });
  assert.notEqual(refused, 0);
  assert.equal(invalidSpawns, 0);
});

test("the workflow uses all four paid shards, names fallback telemetry, and preserves source CI", () => {
  const ci = (workflow.jobs.ci.steps ?? []).map((step) => step.run ?? "").join("\n");
  assert.doesNotMatch(ci, /matrix\.shard \}\}" != "1"[\s\S]{0,200}shard 1 owns the plan\/docs-reading set/);
  assert.match(ci, /--select-candidates plan-reading-suites\.txt --shard \$\{\{ matrix\.shard \}\}\/4/);
  assert.match(ci, /RETRY_SCRIPT="scripts\/test-with-retry\.mjs"[\s\S]*--run-candidates plan-reading-suites\.txt --shard \$\{\{ matrix\.shard \}\}\/4/);
  assert.match(ci, /plan-reading shard summary/);
  assert.match(ci, /fallback=source/);
  assert.match(
    ci,
    /test-tier-manifest\.mjs --run fast --shard \$\{\{ matrix\.shard \}\}\/4 --base "\$TIER_BASE"/,
    "source PRs keep W1-T2904's duration-balanced fast-tier path",
  );
});

test("the required slow job suppresses duplicate plan-reading execution only after exact validation", () => {
  const slow = (workflow.jobs["test-slow"].steps ?? []).map((step) => step.run ?? "").join("\n");
  assert.match(slow, /diff-class\.mjs --changed-files/);
  assert.match(slow, /--select-candidates plan-reading-suites\.txt --shard 1\/4/);
  assert.match(slow, /plan-reading matrix established/);
  assert.match(slow, /npm run --silent test:slow/);
});

test("the current conservative candidate set is complete, tiered, and fills every shard", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/diff-class.mjs", "--list-plan-reading-suites"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const current = result.stdout.trim();
  const allTests = Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, "scripts/test-tier-manifest.json"), "utf8")).files);
  const currentManifest = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/test-tier-manifest.json"), "utf8"));
  assert.ok(current.split("\n").length >= 257, "the filing measured 257; base growth may only increase the conservative set");
  for (let index = 1; index <= 4; index += 1) {
    assert.ok(selectPlanReadingShard(current, allTests, currentManifest, { index, count: 4 }).files.length > 0);
  }
});
