// @source-text-subject: the workflow's matrix, lane commands and verdict are this suite's subject.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { finishJudgedRun } from "#test/helpers/judged-pool-run.js";
// @ts-expect-error — plain .mjs, no declaration file.
import * as tier from "#scripts/test-tier-manifest.mjs";

type Manifest = { thresholdMs: number; files: Record<string, number> };
type Plan = { count: number; makespanMs: number; budgetMs: number; slowFiles: number; fits: boolean };
const plan = tier.slowTierShardPlan as (manifest: Manifest, options?: Record<string, unknown>) => Plan;
const count = tier.slowTierShardCount as (manifest: Manifest, options?: Record<string, unknown>) => number;
const MIN = 60_000;

/** `n` slow files of `minutes` each, named so their order is stable. */
function uniform(n: number, minutes: number): Manifest {
  const files: Record<string, number> = {};
  for (let i = 0; i < n; i += 1) files[`test/slow-${String(i).padStart(2, "0")}.test.ts`] = minutes * MIN;
  return { thresholdMs: 5000, files };
}

test("W1-T11206: the slow-tier shard count is never below 2, and rises when recorded durations grow", () => {
  assert.equal(count({ thresholdMs: 5000, files: { "test/a.test.ts": 6000, "test/b.test.ts": 6000 } }), 2);
  // 12 files on 3 workers against a 21-minute budget (0.6 x 35): 10-minute files fit two shards
  // (6 files, two rounds, 20 min); 12-minute files need four (3 files, one round, 12 min).
  assert.equal(count(uniform(12, 10)), 2);
  const grown = plan(uniform(12, 12));
  assert.equal(grown.count, 4);
  assert.equal(grown.makespanMs, 12 * MIN);
  assert.ok(grown.makespanMs <= grown.budgetMs && grown.fits);
  assert.ok(plan(uniform(12, 12), { ceilingMs: 35 * MIN }).count > count(uniform(12, 10)));
});

test("W1-T11206: a slow file longer than the budget by itself is reported as not fitting, never looped on", () => {
  const result = plan({ thresholdMs: 5000, files: { "test/huge.test.ts": 30 * MIN, "test/small.test.ts": 6000 } });
  assert.equal(result.fits, false);
  assert.equal(result.count, 2);
});

test("W1-T11206: on the shipped manifest at test-slow-shard's own 35-minute ceiling the count is the smallest that fits, and more than 2", () => {
  const workflow = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { "timeout-minutes"?: number }>;
  };
  assert.equal(tier.SLOW_TIER_JOB_CEILING_MS, (workflow.jobs["test-slow-shard"]?.["timeout-minutes"] ?? 0) * MIN);
  const manifest = tier.loadManifest(join(REPO_ROOT, "scripts/test-tier-manifest.json")) as Manifest;
  const testFiles = tier.listTestFiles(REPO_ROOT) as string[];
  const derived = plan(manifest, { testFiles });
  assert.ok(derived.fits);
  assert.ok(derived.count > 2, `derived ${derived.count}`);
  assert.ok(derived.makespanMs <= derived.budgetMs);
  const fewer = plan(manifest, { testFiles, ceilingMs: tier.SLOW_TIER_JOB_CEILING_MS, headroom: tier.SLOW_TIER_HEADROOM });
  assert.equal(fewer.count, derived.count);
  const { slow } = tier.tierFiles(testFiles, manifest) as { slow: string[] };
  const oneLess = (tier.balanceFilesByDuration(slow, manifest, derived.count - 1) as string[][])
    .map((files) => tier.predictMakespanMs(files, manifest, tier.SLOW_TIER_WORKERS) as number);
  assert.ok(Math.max(...oneLess) > derived.budgetMs, "one shard fewer must not fit, or the count is not the smallest");
});

test("W1-T11206: --print-slow-shards prints the matrix list and the count for $GITHUB_OUTPUT", () => {
  const result = spawnSync(process.execPath, ["scripts/test-tier-manifest.mjs", "--print-slow-shards"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  const n = Number(lines.find((line) => line.startsWith("count="))?.slice("count=".length));
  assert.ok(n > 2);
  assert.deepEqual(JSON.parse(lines.find((line) => line.startsWith("shards="))?.slice("shards=".length) ?? "null"),
    Array.from({ length: n }, (_, i) => i + 1));
});

test("W1-T11206: the sparse planner needs the manifest and scripts, without a test checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t11206-plan-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(uniform(12, 12)));
    const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/test-tier-manifest.mjs"),
      "--root", dir, "--manifest", "manifest.json", "--print-slow-shards"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "shards=[1,2,3,4]\ncount=4\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T11206 criterion 3: the failing-tests reporter names each failing test once, under node's real runner", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t11206-"));
  try {
    const fixture = join(dir, "fixture.test.mjs");
    writeFileSync(fixture, [
      'import { describe, test } from "node:test";',
      'test("passes", () => {});',
      'describe("group", () => { test("leaf fails", () => { throw new Error("boom"); }); test("leaf passes", () => {}); });',
      "",
    ].join("\n"));
    const out = join(dir, "failures.ndjson");
    const run = spawnSync(process.execPath, ["--test", ...tier.failingTestsReporterArgs(out), fixture], {
      cwd: dir,
      encoding: "utf8",
      // A nested `node --test` that inherits NODE_TEST_CONTEXT reports to this runner instead of exiting non-zero.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
    });
    assert.notEqual(run.status, 0);
    const failures = tier.readFailingTests(readFileSync(out, "utf8"), dir) as Array<{ file: string; name: string }>;
    assert.deepEqual(failures, [{ file: "fixture.test.mjs", name: "leaf fails" }]);
    assert.deepEqual(tier.formatFailingTests(failures), ["FAILING TESTS (1)", "  fixture.test.mjs > leaf fails"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T11206 criterion 3: a slow-tier run ends its output with its FAILING TESTS block, or FAILING TESTS (0)", () => {
  const reporter = tier.failingTestsReporterArgs("x")[0] as string;
  for (const failing of [true, false]) {
    const lines: string[] = [];
    const status = tier.main(["--root", REPO_ROOT, "--run", "slow", "--shard", "1/3"], {
      env: {},
      log: (line: string) => lines.push(line),
      spawn: (_file: string, args: string[], opts?: unknown) => {
        const at = args.indexOf(reporter);
        assert.ok(at >= 0, "the slow-tier run must carry the failing-tests reporter");
        const destination = args[at + 1]!.slice("--test-reporter-destination=".length);
        const named = args.find((arg) => arg.endsWith(".test.ts"))!;
        writeFileSync(destination, failing ? `${JSON.stringify({ file: join(REPO_ROOT, named), name: "it broke" })}\n` : "");
        return finishJudgedRun(args, opts, failing ? 1 : 0);
      },
    });
    assert.equal(status, failing ? 1 : 0);
    const tail = failing ? lines.slice(-2) : lines.slice(-1);
    assert.equal(tail[0], `FAILING TESTS (${failing ? 1 : 0})`);
    if (failing) assert.match(tail[1]!, /^ {2}test\/.+\.test\.ts > it broke$/);
  }
});

test("W1-T11206 criterion 3: the fast tier's runs carry no failing-tests reporter", () => {
  const reporter = tier.failingTestsReporterArgs("x")[0] as string;
  const seen: string[][] = [];
  tier.main(["--root", REPO_ROOT, "--run", "fast", "--shard", "1/8"], {
    env: { RMD_TEST_POOL: "0" },
    log: () => {},
    spawn: (_file: string, args: string[], opts?: unknown) => {
      seen.push(args);
      return finishJudgedRun(args, opts);
    },
  });
  assert.ok(seen.length > 0);
  assert.ok(seen.every((args) => !args.includes(reporter)));
});

test("W1-T11206 criterion 3: the actual workflow push command prints all failures after scoped retry output", () => {
  const workflow = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const body = workflow.jobs["test-slow-shard"]!.steps.find((step) => step.name?.startsWith("Run the slow tier"))!.run!;
  for (const mode of ["pass", "fail", "recover", "different"]) {
    const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t11206-workflow-"));
    try {
      mkdirSync(join(dir, "test/setup"), { recursive: true });
      mkdirSync(join(dir, "bin"));
      mkdirSync(join(dir, "scripts"));
      for (const script of ["test-tier-manifest.mjs", "test-with-retry.mjs"]) {
        writeFileSync(join(dir, "scripts", script),
          `import { main } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "scripts", script)).href)};\nprocess.exit(await main(process.argv.slice(2)));\n`);
      }
      symlinkSync(join(REPO_ROOT, "scripts/test-duration-reporter.mjs"), join(dir, "scripts/test-duration-reporter.mjs"));
      symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
      writeFileSync(join(dir, "package.json"), '{"type":"module"}');
      writeFileSync(join(dir, "test/setup/tmp-hygiene.ts"), "");
      // The retry wrapper snapshots git status; this disposable fixture has no tracked tree.
      writeFileSync(join(dir, "bin/git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(dir, "test/a.test.ts"), `
import { test, after } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const attempt = existsSync("attempt-a") ? Number(readFileSync("attempt-a", "utf8")) + 1 : 1;
writeFileSync("attempt-a", String(attempt));
test("original failure", () => {
  if (${JSON.stringify(mode)} !== "pass" && (attempt === 1 || ${JSON.stringify(mode)} === "fail")) throw Error("boom");
});
test("retry-only failure", () => {
  if (${JSON.stringify(mode)} === "different" && attempt === 2) throw Error("new failure");
});
after(() => { for (let i = 0; i < 5100; i++) console.log("tail noise " + i); });
`);
      for (const file of ["b", "c"]) writeFileSync(join(dir, `test/${file}.test.ts`), `
import { test } from "node:test";
import { appendFileSync } from "node:fs";
test("healthy ${file}", () => { appendFileSync("attempt-${file}", "x"); });
`);
      const files = { "test/a.test.ts": 6000, "test/b.test.ts": 6000, "test/c.test.ts": 6000 };
      writeFileSync(join(dir, "scripts-manifest.json"), JSON.stringify({ thresholdMs: 5000, files }));
      const script = body.replaceAll("${{ matrix.shard }}", "1")
        .replaceAll("${{ needs.test-slow-plan.outputs.count }}", "2")
        .replaceAll("${{ steps.plan-reading.outputs.established }}", "false")
        .replaceAll("${{ steps.plan-reading.outputs.class }}", "PUSH")
        .replaceAll("--run slow", "--manifest scripts-manifest.json --run slow");
      writeFileSync(join(dir, "step.sh"), script);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", 'bash -eo pipefail step.sh 2>&1'], {
        cwd: dir, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          GITHUB_EVENT_NAME: "push", RUNNER_TEMP: dir, TEST_RETRY: "1", TEST_RETRY_BUDGET_SECONDS: "",
          RMD_TEST_FLAKE_LEDGER: join(dir, "flake.ndjson"),
          GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        },
      });
      assert.equal(result.status, ["fail", "different"].includes(mode) ? 1 : 0, result.stdout + result.stderr);
      assert.equal(readFileSync(join(dir, "attempt-a"), "utf8"), mode === "pass" ? "1" : "2");
      assert.equal(readFileSync(join(dir, "attempt-c"), "utf8"), "x", "the healthy file must not be retried");
      const expected = mode === "pass" ? ["FAILING TESTS (0)"]
        : mode === "different" ? ["FAILING TESTS (2)", "  test/a.test.ts > original failure", "  test/a.test.ts > retry-only failure"]
        : ["FAILING TESTS (1)", "  test/a.test.ts > original failure"];
      const lines = result.stdout.trimEnd().split("\n");
      assert.deepEqual(lines.slice(-expected.length), expected);
      if (mode !== "pass") {
        assert.match(result.stdout, /FLAKE-RETRY-FILES: retrying 1 failed file/);
        assert.ok(lines.slice(-5000).includes("  test/a.test.ts > original failure"));
      }
      const durations = readdirSync(join(dir, "test-duration")).map((file) =>
        JSON.parse(readFileSync(join(dir, "test-duration", file), "utf8")) as { files: Record<string, number> });
      assert.deepEqual(durations.map(({ files }) => Object.keys(files).length).sort(), mode === "pass" ? [2] : [1, 2],
        "scoped retry evidence must preserve the initial shard's durations");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("W1-T11206: the check census names a run-time slow-tier matrix with one `*/*` entry, and refuses an unneeded producer", async () => {
  const { derivePrCheckCandidates } = await import("#src/lib/ci-control-plane.js");
  const job = (needs: string[]) => ({
    on: { pull_request: {} },
    jobs: {
      plan: { name: "plan" },
      shard: {
        name: "shard (${{ matrix.shard }}/${{ needs.plan.outputs.count }})",
        needs,
        strategy: { matrix: { shard: "${{ fromJSON(needs.plan.outputs.shards) }}" } },
      },
    },
  });
  assert.deepEqual(derivePrCheckCandidates("ci.yml", job(["plan"])), ["plan", "shard (*/*)"]);
  assert.throws(() => derivePrCheckCandidates("ci.yml", job([])), /reads needs\.plan, which this job does not need/);
  const workflow = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as Parameters<typeof derivePrCheckCandidates>[1];
  assert.ok(derivePrCheckCandidates("ci.yml", workflow).includes("test-slow-shard (*/*)"));
  assert.equal(
    (workflow.jobs as Record<string, { strategy?: { matrix?: { shard?: unknown } } }>)["test-slow-shard"]?.strategy?.matrix?.shard,
    "${{ fromJSON(needs.test-slow-plan.outputs.shards) }}",
  );
});

test("W1-T11206: ci-friction finds ci.yml as the owner family of every run-time slow-tier shard check", async () => {
  const { workflowJobCheckNames, ciCheckFamily } = await import("#src/lib/ci-friction-gardener.js");
  const workflow = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { name?: string; strategy?: { matrix?: unknown } }>;
  };
  const job = workflow.jobs["test-slow-shard"]!;
  const declared = workflowJobCheckNames(job.name!, job.strategy?.matrix);
  assert.deepEqual(declared, ["test-slow-shard (*/*)"]);
  for (const check of ["test-slow-shard (1/3)", "test-slow-shard (4/4)"]) assert.equal(ciCheckFamily(check), ciCheckFamily((declared as string[])[0]!));
});

// Ordered file-duration samples: October's test-duration-slow rows survive in the non-EWMA
// next-manifest proposal; November's are the original slow.json. Numeric keys below preserve
// lexical execution order without depending on later file renames or re-tiering.
const calibrationSamples = [
  { date: "2026-10-30", job: 124081712339, artifact: 12981014507, measuredMs: 1896788.608482, durations: [
    9899, 17120, 10599, 8727, 17891, 14458, 7631, 14329, 16327, 12433, 7400, 16992,
    8555, 11143, 18535, 21331, 21593, 11841, 15328, 50839, 5130, 10061, 92417, 22372,
    26128, 7332, 41558, 8339, 16078, 6021, 9932, 52079, 8281, 59896, 8987, 12321,
    8685, 38215, 10123, 1729, 17517, 6794, 10439, 11627, 9884, 11562, 23361, 164706,
    37084, 6606, 6659, 41991, 7412, 9233, 10064, 7456, 45746, 73380, 8276, 7782,
    13341, 10948, 11107, 4414, 15820, 20569, 9913, 7710, 16689, 1784, 5080, 12391,
    121733, 10351, 14446, 32833, 31867, 11838, 4505, 9311, 11944, 22726, 7433, 1723,
    65992, 46631, 6195, 11156, 21144, 9913, 12729, 4785, 8112, 16096, 39142, 8280,
    7923, 8266, 101548, 46405, 17513, 9506, 10283, 18051, 9161, 10733, 54591, 4679,
    14719, 8446, 27808, 11107, 6608, 30959, 6602, 34155, 7628, 11733, 6104, 21053,
    25281, 6804, 6134, 21344, 21590, 20235, 10142, 6684, 13569, 13380, 6283, 6169,
    19972, 16259, 8081, 20112, 8406, 11898, 26365, 6850, 5346, 36861, 8910, 23851,
    48801, 7353, 924, 8110, 9570, 26089, 11857, 12841, 14049, 13104, 14040, 19430,
    17221, 32061, 6994, 12063, 51384, 7109, 40591, 43944, 10828, 6722, 7814, 14226,
    26559, 2861, 31558, 8587, 27300, 8150, 7347, 4936, 8221, 26536, 12009, 6916,
    8115, 9447, 5088, 5990, 10504, 6970, 17385, 16883, 19306, 5989, 8408, 5884,
    12682, 31134, 8590, 6220, 7201, 9636, 16519, 25391, 5604, 76046, 6195, 19449,
    26087, 56774, 30602, 10942, 158318, 8623, 5833, 5629, 9539, 63566, 18093, 13773,
    9832, 6466, 8297, 14622, 10266, 6425, 147567, 9499, 8502, 11416, 34542, 15297,
    13963, 8183, 11952, 8559, 11596, 5172, 9136, 9985, 17143, 9867, 10520, 9658,
    10399, 33821, 7470, 24062, 11735, 9023, 8248, 7052, 13124, 7504, 16378, 63027,
    34401, 86858, 20441, 14132, 5854, 10853, 34942, 7977, 9257, 8968, 17158, 7820,
    8727, 8999, 5528, 6900, 78466, 22831, 9863, 9052, 5767, 9683, 161750, 9266,
    7225, 18277, 15102, 27321, 17621, 10343, 11949, 62064, 5683, 19495, 32697, 15989,
    15598, 12167, 6709, 8286, 7420, 8213, 7702, 7975, 9592,
  ] },
  { date: "2026-11-03", job: 125907116846, artifact: 13231715859, measuredMs: 1920495.516399, durations: [
    15194, 15917, 31083, 15689, 11390, 11659, 6414, 16243, 9976, 17000, 8258, 17802,
    16625, 6522, 5499, 8675, 7708, 7677, 64768, 4964, 5063, 6510, 5579, 18586,
    55204, 33399, 7446, 48617, 8861, 9875, 7071, 38189, 16848, 5410, 9274, 48288,
    34124, 6478, 7807, 8852, 8714, 2032, 17006, 14004, 4268, 152444, 7912, 12018,
    6450, 6203, 9012, 43919, 7638, 7961, 28249, 5451, 37197, 8275, 6104, 38165,
    68001, 15371, 8566, 8570, 6133, 12432, 4348, 11845, 12287, 7865, 131975, 12022,
    6968, 8653, 9810, 144884, 15062, 8866, 32971, 35551, 2198, 8053, 6539, 2094,
    9377, 5586, 23528, 8993, 4839, 8259, 51603, 78660, 45010, 7202, 10270, 19326,
    21446, 17255, 8697, 18216, 8339, 7992, 3455, 18442, 52847, 13123, 7365, 11260,
    5875, 6908, 5297, 36882, 7089, 6063, 13964, 7570, 5108, 16872, 32661, 5658,
    13944, 18433, 21526, 11203, 8058, 21554, 14941, 8119, 5775, 11900, 5617, 13727,
    19658, 12281, 22344, 5145, 8851, 9011, 11571, 6995, 25711, 100141, 13694, 10465,
    27864, 37850, 10826, 11945, 43561, 705, 13870, 8283, 61592, 19787, 10024, 7555,
    12224, 5873, 8120, 10525, 11975, 9227, 53155, 51906, 7324, 13718, 11447, 11324,
    22518, 2841, 25301, 8085, 5943, 13280, 7724, 29819, 212318, 8918, 18672, 7899,
    7924, 5319, 6241, 10465, 17362, 8209, 7958, 5806, 6147, 18661, 10582, 7569,
    20326, 15367, 9449, 13559, 5299, 6066, 22104, 8905, 29771, 8893, 7645, 13379,
    14832, 1621, 97699, 64690, 23557, 27275, 5137, 7042, 5427, 10554, 31729, 18371,
    10464, 17591, 9832, 8353, 17401, 13562, 19820, 39930, 7719, 17215, 9964, 8648,
    7455, 15846, 160015, 11494, 14894, 40675, 61574, 15710, 13881, 9378, 12340, 13018,
    17418, 8624, 14120, 4093, 12554, 6553, 5869, 39072, 8517, 7810, 8335, 6944,
    9167, 13339, 7897, 57771, 39350, 35107, 11805, 14338, 32268, 7122, 8134, 11748,
    20681, 8715, 10302, 5683, 84467, 8518, 6844, 8895, 7157, 14847, 25449, 39836,
    9875, 11714, 16745, 9790, 9758, 18332, 12221, 6065, 60995, 5009, 15070, 8960,
    30303, 17248, 29343, 60302, 12248, 7255, 17946, 6863, 6822, 8288, 7450, 32848,
  ] },
];

test("W1-T11206: three workers predict both 10-30 and 11-03 artifact walls within 15%", () => {
  assert.deepEqual(calibrationSamples.map(({ durations }) => durations.length), [297, 300]);
  for (const sample of calibrationSamples) {
    const files = Object.fromEntries(sample.durations.map((ms, i) => [`test/${String(i).padStart(3, "0")}.test.ts`, ms]));
    const manifest = { thresholdMs: 5000, files };
    const predicted = tier.predictMakespanMs(Object.keys(files), manifest, tier.SLOW_TIER_WORKERS) as number;
    const error = Math.abs(predicted - sample.measuredMs) / sample.measuredMs;
    assert.ok(error <= 0.15, `${sample.date} job ${sample.job} artifact ${sample.artifact}: ${predicted} vs ${sample.measuredMs} (${error})`);
    for (const workers of [2, 4]) {
      const wrong = tier.predictMakespanMs(Object.keys(files), manifest, workers) as number;
      assert.ok(Math.abs(wrong - sample.measuredMs) / sample.measuredMs > 0.15);
    }
  }
});
