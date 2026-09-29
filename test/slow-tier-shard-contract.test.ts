import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tier = (await import(pathToFileURL(join(root, "scripts/test-tier-manifest.mjs")).href)) as {
  listTestFiles: (root: string) => string[];
  loadManifest: (path: string) => { thresholdMs: number; files: Record<string, number> };
  tierFiles: (files: string[], manifest: { thresholdMs: number; files: Record<string, number> }) => { slow: string[] };
  main: (args: string[], opts: {
    spawn: (file: string, args: string[]) => { status: number };
    env: Record<string, string>;
  }) => number;
};
const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, {
    name?: string;
    needs?: string[];
    if?: string;
    strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
    steps?: Array<{ name?: string; run?: string }>;
  }>;
};

test("W1-T4756 criterion 1: both balanced slow shards cover the slow tier exactly once", () => {
  const shard = workflow.jobs["test-slow-shard"];
  assert.deepEqual(shard.strategy?.matrix?.shard, [1, 2]);
  assert.equal(shard.strategy?.["fail-fast"], false);
  assert.equal(shard.if, undefined, "push and merge_group must enter the shard job");
  const run = shard.steps?.find((step) => step.name?.startsWith("Run the slow tier"))?.run ?? "";
  assert.match(run, /--run slow --shard \$\{\{ matrix\.shard \}\}\/2 --base HEAD/);
  assert.match(run, /test:slow -- --shard \$\{\{ matrix\.shard \}\}\/2 --base/);

  const manifest = tier.loadManifest(join(root, "scripts/test-tier-manifest.json"));
  const slow = tier.tierFiles(tier.listTestFiles(root), manifest).slow;
  assert.ok(slow.length >= 2, "the control population must fill both shards");
  const selected: string[][] = [];
  for (const index of shard.strategy?.matrix?.shard ?? []) {
    const calls: string[][] = [];
    const status = tier.main(["--root", root, "--run", "slow", "--shard", `${index}/2`], {
      spawn: (_file: string, args: string[]) => {
        calls.push(args);
        return { status: 0 };
      },
      env: {},
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 1, `shard ${index} must invoke one test runner`);
    selected.push(calls[0]!.filter((arg) => arg.endsWith(".test.ts")));
  }
  assert.ok(selected.every((files) => files.length > 0));
  assert.equal(new Set(selected.flat()).size, selected.flat().length, "no slow file runs in both shards");
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
