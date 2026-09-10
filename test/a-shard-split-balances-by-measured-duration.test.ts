// W1-T3290: selected-set shard summaries must measure the same files the diff admitted.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "test-tier-manifest.mjs");

const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  selectPlanReadingShard: (
    candidateText: string,
    testFiles: string[],
    manifest: { thresholdMs: number; files: Record<string, number> },
    shard: { index: number; count: number },
  ) => {
    candidates: string[];
    files: string[];
    predictedDurationMs: number;
    balance: {
      selectedDurationMs: number;
      selectedMeanDurationMs: number;
      slowestShardExcessMs: number;
      countSplitSlowestExcessMs: number;
      bindingFloor: { file: string; durationMs: number; excessOverMeanMs: number } | null;
    };
  };
  main: (
    argv: string[],
    opts?: { spawn?: (cmd: string, args: string[], opts?: unknown) => { status: number | null; signal?: string | null } },
  ) => number;
};

const { selectPlanReadingShard, main } = mod;

function candidates(files: string[]): string {
  return `${files.join("\n")}\n`;
}

function fixtureRoot(files: string[], manifest: { thresholdMs: number; files: Record<string, number> }): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shard-balance-`));
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const file of files) {
    const full = join(root, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "import { test } from 'node:test';\ntest('noop', () => {});\n");
  }
  writeFileSync(join(root, "scripts", "test-tier-manifest.json"), JSON.stringify(manifest, null, 2));
  return root;
}

test("selected-set duration balancing shrinks the slowest shard's excess against count splitting", () => {
  const selected = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"];
  const manifest = {
    thresholdMs: 5_000,
    files: {
      "test/a.test.ts": 100,
      "test/b.test.ts": 90,
      "test/c.test.ts": 10,
      "test/d.test.ts": 0,
      "test/not-selected.test.ts": 10_000,
    },
  };

  const first = selectPlanReadingShard(candidates(selected), selected, manifest, { index: 1, count: 2 });
  const second = selectPlanReadingShard(candidates(selected), selected, manifest, { index: 2, count: 2 });

  assert.equal(first.balance.selectedDurationMs, 200);
  assert.equal(first.balance.selectedMeanDurationMs, 100);
  assert.equal(first.balance.slowestShardExcessMs, 0);
  assert.equal(first.balance.countSplitSlowestExcessMs, 90);
  assert.ok(first.balance.slowestShardExcessMs < first.balance.countSplitSlowestExcessMs);
  assert.deepEqual([first.predictedDurationMs, second.predictedDurationMs], [100, 100]);
});

test("a selected file above the balanced mean is named as the binding floor in the report", () => {
  const selected = ["test/heavy.test.ts", "test/medium.test.ts", "test/small.test.ts", "test/tiny.test.ts"];
  const manifest = {
    thresholdMs: 5_000,
    files: {
      "test/heavy.test.ts": 250,
      "test/medium.test.ts": 50,
      "test/small.test.ts": 50,
      "test/tiny.test.ts": 50,
    },
  };
  const root = fixtureRoot(selected, manifest);
  const candidatePath = join(root, "candidates.txt");
  writeFileSync(candidatePath, candidates(selected));
  const stderr: string[] = [];
  const priorError = console.error;
  const priorLog = console.log;
  console.error = (value?: unknown) => stderr.push(String(value ?? ""));
  console.log = () => {};
  try {
    assert.equal(main(["--root", root, "--select-candidates", candidatePath, "--shard", "1/2"]), 0);
  } finally {
    console.error = priorError;
    console.log = priorLog;
  }

  const summary = stderr.find((line) => line.includes("plan-reading shard summary")) ?? "";
  assert.match(summary, /selected_total_duration_ms=400/);
  assert.match(summary, /selected_mean_duration_ms=200/);
  assert.match(summary, /binding_floor_file=test\/heavy\.test\.ts/);
  assert.match(summary, /binding_floor_duration_ms=250/);
  assert.match(summary, /binding_floor_excess_ms=50/);
});

test("unmeasured files spread across shards while every selected file lands exactly once", () => {
  const selected = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"];
  const manifest = { thresholdMs: 5_000, files: Object.fromEntries(selected.map((file) => [file, 0])) };
  const assigned = [1, 2, 3, 4].map((index) =>
    selectPlanReadingShard(candidates(selected), selected, manifest, { index, count: 4 }).files,
  );

  assert.deepEqual(assigned.map((files) => files.length), [1, 1, 1, 1]);
  const flat = assigned.flat();
  assert.equal(flat.length, selected.length);
  assert.deepEqual([...new Set(flat)].sort(), selected);
});

test("the same selected set produces the same attributable assignment twice", () => {
  const selected = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"];
  const manifest = {
    thresholdMs: 5_000,
    files: {
      "test/a.test.ts": 700,
      "test/b.test.ts": 400,
      "test/c.test.ts": 300,
      "test/d.test.ts": 100,
    },
  };

  const first = selectPlanReadingShard(candidates(selected), selected, manifest, { index: 2, count: 2 });
  const again = selectPlanReadingShard(candidates([...selected].reverse()), selected, manifest, { index: 2, count: 2 });

  assert.deepEqual(again.files, first.files);
  assert.deepEqual(again.balance, first.balance);
});
