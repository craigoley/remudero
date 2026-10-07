// W1-T5923 — the coverage lane's critical path is its slowest shard plus a serial merge. Two changes,
// both wall-clock only: (1) each shard translates its own V8 reports through pinned Node's source
// mapper before upload, so the aggregator replays only the range merge (and its lcov.info stays
// byte-identical); (2) the shard split weighs the coverage lane's own instrumented durations.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MERGER = join(REPO_ROOT, "scripts", "coverage-merge-ratchet.mjs");
const TIER = join(REPO_ROOT, "scripts", "test-tier-manifest.mjs");

type Manifest = { thresholdMs: number; files: Record<string, number> };
const tier = (await import(pathToFileURL(TIER).href)) as {
  instrumentedManifest: (uninstrumented: Manifest, instrumented: Manifest) => Manifest & { ratio: number; instrumentedCount: number };
};

function coverageEnv(directory: string): NodeJS.ProcessEnv {
  // Real V8 output is the input under test, so NODE_V8_COVERAGE is set on purpose; the parent's
  // test context is dropped so the child runs as its own test root.
  const { NODE_TEST_CONTEXT: _omitted, ...rest } = process.env;
  return { ...rest, NODE_V8_COVERAGE: directory };
}

/** Real tsx-transpiled, source-mapped V8 reports for one name-filtered slice of a real suite. */
function realRawShard(directory: string, namePattern: string): void {
  mkdirSync(directory, { recursive: true });
  execFileSync(process.execPath, [
    "--enable-source-maps", "--experimental-test-coverage", "--test-coverage-exclude=test/**",
    "--test", "--test-reporter=tap", `--test-name-pattern=${namePattern}`,
    "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "test/worker-provider.test.ts",
  ], { cwd: REPO_ROOT, env: coverageEnv(directory), stdio: "pipe" });
  assert.ok(readdirSync(directory).some((name) => /^coverage-\d+-\d{13}-\d+\.json$/.test(name)), `${directory} must hold raw V8 reports`);
}

function merger(...args: string[]): string {
  return execFileSync(process.execPath, ["--expose-internals", MERGER, ...args], { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" });
}

function mergedLcov(output: string, ...directories: string[]): string {
  merger("--output", output, ...directories);
  return readFileSync(output, "utf8");
}

const SLICES = ["provider selector uses the subscription", "provider selector excludes an exhausted", "provider selector"];

function rawShards(root: string): string[] {
  return SLICES.map((pattern, index) => {
    const directory = join(root, `raw-${index + 1}`);
    realRawShard(directory, pattern);
    return directory;
  });
}

/** Rewrite one premapped chunk family through `edit`, re-sealing sizes and checksums so the merge
 *  reads the edited content rather than refusing it — the edit, not the seal, is what is tested. */
function editPremapped(directory: string, family: "lines" | "mapped", edit: (entries: unknown[]) => unknown[]): void {
  const manifestName = readdirSync(directory).find((name) => /^coverage-premapped-/.test(name))!;
  const manifest = JSON.parse(readFileSync(join(directory, manifestName), "utf8"));
  const key = family === "lines" ? "lines" : "reports";
  for (const chunk of manifest[family === "lines" ? "lineChunks" : "reportChunks"]) {
    const parsed = JSON.parse(readFileSync(join(directory, chunk.file), "utf8"));
    parsed[key] = edit(parsed[key]);
    const source = JSON.stringify(parsed);
    writeFileSync(join(directory, chunk.file), source);
    chunk.bytes = Buffer.byteLength(source);
    chunk.sha256 = createHash("sha256").update(source).digest("hex");
    chunk.entries = parsed[key].length;
  }
  writeFileSync(join(directory, manifestName), JSON.stringify(manifest));
}

test("W1-T5923: premapped shards merge to an lcov.info byte-identical to the former merge of the same raw reports", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}premap-identity-`));
  try {
    const raws = rawShards(root);
    const reference = mergedLcov(join(root, "reference.info"), ...raws);
    const premapped = raws.map((raw, index) => {
      const directory = join(root, `premapped-${index + 1}`);
      assert.match(merger("--premap-output", directory, raw), /premapped 1 raw shard\(s\), \d+ V8 file\(s\), [1-9]\d* retained process report/);
      return directory;
    });
    const merged = mergedLcov(join(root, "premapped.info"), ...premapped);
    assert.ok(/^BRDA:/m.test(reference) && /^DA:\d+,[1-9]/m.test(reference), "the reference must carry real branch and line hits");
    assert.equal(merged, reference, "every SF, FN, FNDA, BRDA and DA line must match the former merge byte for byte");

    // The former compact corpus and a premapped corpus still merge together, in caller order.
    const compact = join(root, "compact-2");
    merger("--compact-output", compact, raws[1]!);
    assert.equal(mergedLcov(join(root, "mixed.info"), premapped[0]!, compact, premapped[2]!), reference);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5923 falsifier: a premapped shard that drops a range, reorders functions, or loses translation line state no longer matches", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}premap-falsifier-`));
  try {
    const raws = rawShards(root);
    const reference = mergedLcov(join(root, "reference.info"), ...raws);
    type Script = { url: string; functions: Array<{ functionName: string; ranges: unknown[] }> };
    const variants: Record<string, (directory: string) => void> = {
      "dropped range": (directory) => editPremapped(directory, "mapped", (reports) => (reports as Script[][]).map((report) =>
        report.map((script) => ({ ...script, functions: script.functions.map((fn) => ({ ...fn, ranges: fn.ranges.slice(0, 1) })) })))),
      "reordered functions": (directory) => editPremapped(directory, "mapped", (reports) => (reports as Script[][]).map((report) =>
        report.map((script) => ({ ...script, functions: [...script.functions].reverse() })))),
      "lost line state": (directory) => editPremapped(directory, "lines", (lines) =>
        (lines as Array<{ written: unknown[] }>).map((line) => ({ ...line, written: [] }))),
    };
    for (const [name, mutate] of Object.entries(variants)) {
      const premapped = raws.map((raw, index) => {
        const directory = join(root, `${name.replaceAll(" ", "-")}-${index + 1}`);
        merger("--premap-output", directory, raw);
        mutate(directory);
        return directory;
      });
      assert.notEqual(mergedLcov(join(root, `${name}.info`), ...premapped), reference, `${name} must change the merged lcov.info`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5923: a premapped shard refuses a tampered chunk, a mixed directory, and an empty input", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}premap-refusal-`));
  try {
    const [raw] = rawShards(root);
    const premapped = join(root, "premapped");
    merger("--premap-output", premapped, raw!);
    const output = join(root, "out.info");
    const chunk = readdirSync(premapped).find((name) => /^coverage-mapped-/.test(name))!;
    const original = readFileSync(join(premapped, chunk), "utf8");
    writeFileSync(join(premapped, chunk), original.replace(/"count":(\d)/, (_m, digit) => `"count":${(Number(digit) + 1) % 10}`));
    assert.throws(() => merger("--output", output, premapped), /checksum mismatch/);
    writeFileSync(join(premapped, chunk), original);
    const manifestName = readdirSync(premapped).find((name) => /^coverage-premapped-/.test(name))!;
    const manifest = readFileSync(join(premapped, manifestName), "utf8");
    writeFileSync(join(premapped, manifestName), JSON.stringify({ ...JSON.parse(manifest), reportCount: 0 }));
    assert.throws(() => merger("--output", output, premapped), /invalid premapped coverage manifest/);
    writeFileSync(join(premapped, manifestName), manifest);
    editPremapped(premapped, "lines", (lines) => (lines as Array<Record<string, unknown>>).map((line) => ({ ...line, url: 7 })));
    assert.throws(() => merger("--output", output, premapped), /invalid premapped line record/);
    writeFileSync(join(premapped, "coverage-1-0000000000000-0.json"), "{}");
    assert.throws(() => merger("--output", output, premapped), /incomplete or mixed premapped coverage/);
    const empty = join(root, "empty");
    mkdirSync(empty);
    assert.throws(() => merger("--premap-output", join(root, "nothing"), empty), /contains no V8 coverage files/);
    assert.throws(() => merger("--premap-output", join(root, "both"), "--output", output, raw!), /exactly one of --output, --compact-output or --premap-output/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5923: the coverage split weighs instrumented durations, scaling an unmeasured file by the measured ratio", () => {
  const uninstrumented = { thresholdMs: 5_000, files: { "test/a.test.ts": 100, "test/b.test.ts": 100, "test/c.test.ts": 200, "test/d.test.ts": 0 } };
  const instrumented = { thresholdMs: 5_000, files: { "test/a.test.ts": 300, "test/b.test.ts": 900 } };
  const weighed = tier.instrumentedManifest(uninstrumented, instrumented);
  assert.equal(weighed.instrumentedCount, 2);
  assert.equal(weighed.ratio, 6, "median of 3x and 9x");
  assert.deepEqual(weighed.files, { "test/a.test.ts": 300, "test/b.test.ts": 900, "test/c.test.ts": 1200, "test/d.test.ts": 0 });
  assert.equal(tier.instrumentedManifest(uninstrumented, { thresholdMs: 5_000, files: {} }).ratio, 1, "no overlap keeps the uninstrumented weights");

  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}instrumented-split-`));
  try {
    // a is cheap to instrument (1x), d is expensive (10x); the unmeasured b and c scale by 5.5x.
    const fast = { thresholdMs: 5_000, files: { "test/a.test.ts": 400, "test/b.test.ts": 300, "test/c.test.ts": 200, "test/d.test.ts": 100 } };
    const slow = { thresholdMs: 5_000, files: { "test/a.test.ts": 400, "test/d.test.ts": 1000 } };
    mkdirSync(join(root, "test"), { recursive: true });
    for (const file of Object.keys(fast.files)) writeFileSync(join(root, file), "import { test } from 'node:test';\ntest('noop', () => {});\n");
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "test-tier-manifest.json"), JSON.stringify(fast));
    writeFileSync(join(root, "scripts", "test-tier-coverage-manifest.json"), JSON.stringify(slow));
    const select = (index: number, ...extra: string[]) => execFileSync(process.execPath,
      [TIER, "--root", root, "--select-all", "--shard", `${index}/2`, ...extra], { encoding: "utf8", stdio: "pipe" }).trim().split("\n");
    assert.deepEqual([select(1), select(2)], [["test/a.test.ts", "test/d.test.ts"], ["test/b.test.ts", "test/c.test.ts"]]);
    const flags = ["--instrumented-manifest", "scripts/test-tier-coverage-manifest.json"];
    assert.deepEqual([select(1, ...flags), select(2, ...flags)], [["test/b.test.ts", "test/a.test.ts"], ["test/c.test.ts", "test/d.test.ts"]],
      "weighed instrumented (a 400, b 1650, c 1100, d 1000), b and a share a shard");
    assert.deepEqual(select(1, "--instrumented-manifest", "scripts/absent.json"), select(1), "an absent ledger is the uninstrumented split");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5923: ci.yml premaps each coverage shard, records its instrumented durations, and splits on them", () => {
  const workflow = parse(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, string> }> }>;
  };
  const steps = workflow.jobs["coverage-ratchet"]!.steps!;
  const run = (name: string) => steps.find((step) => step.name?.startsWith(name))?.run ?? "";
  const collect = run("Test with coverage");
  assert.match(collect, /--select-all --shard \$\{\{ matrix\.shard \}\}\/8 --base HEAD\^1 \\\n\s+--instrumented-manifest scripts\/test-tier-coverage-manifest\.json/);
  assert.match(collect, /--test-reporter=\.\/scripts\/test-duration-reporter\.mjs --test-reporter-destination=coverage\/test-durations\.json/);
  const stage = run("Stage this coverage shard");
  assert.match(stage, /coverage-merge-ratchet\.mjs --premap-output coverage\/premapped coverage\/raw/);
  assert.doesNotMatch(stage, /--compact-output/, "the shard ships premapped reports, never the untranslated corpus");
  const evidence = steps.find((step) => step.name?.startsWith("Upload this coverage shard's instrumented duration evidence"));
  assert.equal(evidence?.with?.name, "coverage-duration-shard-${{ matrix.shard }}");
  assert.equal(evidence?.with?.path, "coverage/test-durations.json");
  const admission = workflow.jobs["coverage-ratchet-required"]!.steps!.find((step) => step.name?.startsWith("Merge raw V8 coverage shards"))?.run ?? "";
  assert.match(admission, /-name 'coverage-premapped-\*\.json'/);
  const proposal = workflow.jobs["flake-retry-aggregate"]!.steps!.find((step) => step.name?.startsWith("Build the instrumented next-manifest proposal"))?.run ?? "";
  assert.match(proposal, /--manifest scripts\/test-tier-coverage-manifest\.json \\\n\s+--record-evidence/);
});
