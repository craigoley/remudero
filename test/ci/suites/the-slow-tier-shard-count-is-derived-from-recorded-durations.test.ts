import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
