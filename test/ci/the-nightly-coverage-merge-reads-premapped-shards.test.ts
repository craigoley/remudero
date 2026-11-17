// W1-T13275 — the coverage-nightly shards premap their coverage as ci.yml's coverage shards do (W1-T5923),
// so the nightly merge replays only the range merge and finishes inside its 30-minute ceiling.
// MEASURED 2026-11-17 (Actions jobs API): 9 of 13 coverage-nightly runs from 2026-11-05 were cancelled in the
// merge job's serial "Merge raw V8 coverage shards into one lcov" step; the last green one took 22m44s of 30.
// The test impact map still reads the compact shards, because compaction keeps each report's suite and the
// premapped corpus does not.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { strategy?: { matrix?: { shard?: number[] } }; steps?: Step[] };
type Workflow = { jobs: Record<string, Job> };

const nightly = () =>
  parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/coverage-nightly.yml"), "utf8")) as Workflow;
const stepNamed = (job: Job, prefix: string) => {
  const step = (job.steps ?? []).find((s) => (s.name ?? "").startsWith(prefix));
  assert.ok(step, `expected a step named "${prefix}..."`);
  return step!;
};
/** The shard directories a coverage-merge-ratchet.mjs call in `run` names, as `<shard>/<kind>`. */
const shardDirs = (run: string) =>
  [...run.matchAll(/coverage-shards\/coverage-shard-(\d+)\/(\w+)/g)].map((m) => `${m[1]}/${m[2]}`);

test("W1-T13275 criterion 1: each nightly shard premaps into its upload, and the merge reads every premapped shard and no compact one", () => {
  const { shards, merge } = nightly().jobs;
  const width = shards!.strategy!.matrix!.shard!;
  const premap = stepNamed(shards!, "Premap this shard's raw V8 coverage");
  assert.match(
    premap.run!,
    /coverage-merge-ratchet\.mjs --premap-output coverage-artifact\/premapped coverage\/raw/,
    "the shard premaps its own raw reports into the uploaded artifact directory",
  );
  const names = shards!.steps!.map((s) => s.name ?? "");
  const upload = names.indexOf("Upload coverage shard");
  assert.ok(upload > names.indexOf(premap.name!), "the premap runs before the shard's upload");
  assert.equal(shards!.steps![upload]!.with!.path, "coverage-artifact", "the upload carries coverage-artifact/premapped");

  const mergeRun = stepNamed(merge!, "Merge raw V8 coverage shards").run!;
  assert.match(mergeRun, /--output coverage\/lcov\.info/);
  assert.match(mergeRun, new RegExp(`--shard-count ${width.length}\\b`));
  assert.deepEqual(shardDirs(mergeRun), width.map((n) => `${n}/premapped`), "every shard's premapped directory, in order");
});

test("W1-T13275 criterion 2: the test impact map is still built from the compact shards", () => {
  const { shards, merge } = nightly().jobs;
  const width = shards!.strategy!.matrix!.shard!;
  const mapRun = stepNamed(merge!, "Build the test impact map").run!;
  assert.match(mapRun, /--impact-map test-impact-map\.json/);
  assert.deepEqual(shardDirs(mapRun), width.map((n) => `${n}/raw`), "the compact directories keep each report's suite");
  assert.match(stepNamed(shards!, "Compact this shard's raw V8 coverage").run!, /--compact-output coverage\/compact coverage\/raw/);
});

function merger(...args: string[]): string {
  return execFileSync(process.execPath, ["--expose-internals", join(REPO_ROOT, "scripts/coverage-merge-ratchet.mjs"), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });
}

test("W1-T13275 criterion 3: invariant nightly-floor-identity, one shard set merged from premapped files gives the compact merge's lcov bytes", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}nightly-premap-identity-`));
  try {
    // Real tsx-transpiled, source-mapped V8 reports from two name-filtered slices of one real suite.
    const raws = ["provider selector uses the subscription", "provider selector excludes an exhausted"].map((pattern, i) => {
      const raw = join(root, `raw-${i + 1}`);
      mkdirSync(raw, { recursive: true });
      const { NODE_TEST_CONTEXT: _omitted, ...env } = process.env;
      execFileSync(process.execPath, [
        "--enable-source-maps", "--experimental-test-coverage", "--test-coverage-exclude=test/**",
        "--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`,
        "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "test/worker-provider.test.ts",
      ], { cwd: REPO_ROOT, env: { ...env, NODE_V8_COVERAGE: raw }, stdio: "pipe" });
      assert.ok(readdirSync(raw).some((name) => /^coverage-\d+-\d{13}-\d+\.json$/.test(name)), `${raw} must hold raw V8 reports`);
      return raw;
    });
    // The workflow's two shard-side calls, on the same raw directory.
    const compact = raws.map((raw, i) => {
      const dir = join(root, `compact-${i + 1}`);
      mkdirSync(dir);
      merger("--compact-output", dir, raw);
      return dir;
    });
    const premapped = raws.map((raw, i) => {
      const dir = join(root, `premapped-${i + 1}`);
      merger("--premap-output", dir, raw);
      return dir;
    });
    merger("--output", join(root, "compact.info"), "--shard-count", "2", ...compact);
    merger("--output", join(root, "premapped.info"), "--shard-count", "2", ...premapped);
    const reference = readFileSync(join(root, "compact.info"), "utf8");
    assert.ok(/^BRDA:/m.test(reference) && /^DA:\d+,[1-9]/m.test(reference), "the reference carries real branch and line hits");
    assert.equal(readFileSync(join(root, "premapped.info"), "utf8"), reference, "the floor's lcov must not change by a byte");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
