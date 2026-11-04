import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { finishJudgedRun } from "./helpers/judged-pool-run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tier = (await import(pathToFileURL(join(root, "scripts/test-tier-manifest.mjs")).href)) as {
  listTestFiles: (root: string) => string[];
  loadManifest: (path: string) => { thresholdMs: number; files: Record<string, number> };
  tierFiles: (files: string[], manifest: { thresholdMs: number; files: Record<string, number> }) => { slow: string[] };
  slowTierShardCount: (manifest: { thresholdMs: number; files: Record<string, number> }, options?: { testFiles?: string[] }) => number;
  main: (args: string[], opts: {
    spawn: (file: string, args: string[], opts?: unknown) => { status: number };
    env: Record<string, string>;
  }) => number;
};
const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, {
    name?: string;
    needs?: string[];
    if?: string;
    strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] | string } };
    steps?: Array<{ name?: string; run?: string }>;
  }>;
};

test("W1-T4756 criterion 1: the derived balanced slow shards cover the slow tier exactly once", () => {
  const shard = workflow.jobs["test-slow-shard"];
  // W1-T11206: the matrix and its total come from test-slow-plan's derived count.
  assert.equal(shard.strategy?.matrix?.shard, "${{ fromJSON(needs.test-slow-plan.outputs.shards) }}");
  assert.equal(shard.name, "test-slow-shard (${{ matrix.shard }}/${{ needs.test-slow-plan.outputs.count }})");
  assert.deepEqual(shard.needs, ["test-slow-plan"]);
  assert.equal(shard.strategy?.["fail-fast"], false);
  assert.equal(shard.if, undefined, "push and merge_group must enter the shard job");
  const run = shard.steps?.find((step) => step.name?.startsWith("Run the slow tier"))?.run ?? "";
  assert.match(run, /--run slow --shard \$\{\{ matrix\.shard \}\}\/\$\{\{ needs\.test-slow-plan\.outputs\.count \}\} --base HEAD/);
  assert.match(run, /test:slow -- --shard \$\{\{ matrix\.shard \}\}\/\$\{\{ needs\.test-slow-plan\.outputs\.count \}\} --base/);

  const manifest = tier.loadManifest(join(root, "scripts/test-tier-manifest.json"));
  const testFiles = tier.listTestFiles(root);
  const slow = tier.tierFiles(testFiles, manifest).slow;
  const count = tier.slowTierShardCount(manifest, { testFiles });
  assert.ok(count >= 2, `derived ${count}`);
  assert.ok(slow.length >= count, "the control population must fill every derived shard");
  const selected: string[][] = [];
  for (let index = 1; index <= count; index += 1) {
    const calls: string[][] = [];
    const status = tier.main(["--root", root, "--run", "slow", "--shard", `${index}/${count}`], {
      spawn: (_file: string, args: string[], opts?: unknown) => {
        calls.push(args);
        return finishJudgedRun(args, opts);
      },
      env: {},
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 1, `shard ${index} must invoke one test runner`);
    selected.push(calls[0]!.filter((arg) => arg.endsWith(".test.ts")));
  }
  assert.ok(selected.every((files) => files.length > 0));
  assert.equal(new Set(selected.flat()).size, selected.flat().length, "no slow file runs in two shards");
  assert.deepEqual(selected.flat().sort(), slow.sort(), "no slow file is omitted");
});

test("W1-T4756 criterion 1: stable required slow verdict refuses a missing, red, or canceled matrix", () => {
  const aggregate = workflow.jobs["test-slow"];
  assert.equal(aggregate.name, "test-slow");
  assert.deepEqual(aggregate.needs, ["test-slow-shard"]);
  assert.equal(aggregate.if, "${{ always() }}");
  const body = aggregate.steps?.find((step) => step.name === "Collapse both slow-tier shards into the stable required check")?.run;
  assert.ok(body);
  for (const matrixResult of ["failure", "skipped", "cancelled", ""]) {
    const result: ReturnType<typeof spawnSync> = spawnSync("bash", ["-eo", "pipefail", "-c", body], {
      encoding: "utf8",
      env: { ...process.env, SHARD_RESULT: matrixResult },
    });
    assert.equal(result.status, 1, `matrix result ${JSON.stringify(matrixResult)} must refuse`);
  }
  const success = spawnSync("bash", ["-eo", "pipefail", "-c", body], {
    encoding: "utf8",
    env: { ...process.env, SHARD_RESULT: "success" },
  });
  assert.equal(success.status, 0, success.stderr);
});
