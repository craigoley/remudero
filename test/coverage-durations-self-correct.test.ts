// W1-T4071 — the coverage shards are balanced on durations that correct themselves. Measured on
// 66 full coverage runs (2026-10-09): every shard's predicted serial sum was even to the
// millisecond, yet shard 1 ran 1.45x the run mean and shard 2 0.71x. Two causes, both fixed in
// scripts/test-tier-manifest.mjs: `node --test` sorts its file list, so the 14-minute
// test/retro-marker-atomic.test.ts LPT handed shard 1 first started only at its alphabetical
// turn, and the committed instrumented ledger was written once (W1-T5923) and never again.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIER = join(REPO_ROOT, "scripts", "test-tier-manifest.mjs");
const REPORTER = join(REPO_ROOT, "scripts", "test-duration-reporter.mjs");

type Manifest = { thresholdMs: number; files: Record<string, number> };
const tier = (await import(pathToFileURL(TIER).href)) as {
  balanceFilesByDuration: (files: string[], manifest: Manifest, shards: number) => string[][];
  packFilesByMakespan: (files: string[], manifest: Manifest, shards: number, workers: number) => string[][];
  predictMakespanMs: (files: string[], manifest: Manifest, workers: number) => number;
  foldDurationsEwma: (manifest: Manifest, measured: Record<string, number>, opts?: { alpha?: number; knownFiles?: string[] }) => Manifest;
  partitionProblems: (files: string[], selections: { shard: number; digest: string; files: string[] }[]) => string[];
};

function fixtureRoot(kind: string, names: string[], body = 'import { test } from "node:test";\ntest("ok", () => {});\n'): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-`));
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const name of names) writeFileSync(join(root, "test", name), body);
  return root;
}

function writeLedger(root: string, relative: string, files: Record<string, number>): void {
  writeFileSync(join(root, relative), `${JSON.stringify({ thresholdMs: 5000, files })}\n`);
}

function tierCli(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [TIER, "--root", root, ...args], { cwd: root, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function coverageStepRun(): string {
  const workflow = parse(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8"));
  const steps = workflow.jobs["coverage-ratchet"].steps as { name?: string; run?: string; with?: { path?: string } }[];
  return steps.map((step) => `${step.run ?? ""}\n${step.with?.path ?? ""}`).join("\n");
}

const names = (count: number, prefix = "suite") => Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}.test.ts`);

test("W1-T4071: the coverage command writes duration evidence for every selected file", () => {
  const run = coverageStepRun();
  // The selection is recorded beside the evidence, both under coverage/, from the same command.
  assert.match(run, /--test-reporter=\.\/scripts\/test-duration-reporter\.mjs --test-reporter-destination=coverage\/test-durations\.json/);
  assert.match(run, /--select-all --shard \$\{\{ matrix\.shard \}\}\/8 --base HEAD\^1[\s\S]*--workers 3 --selection-output coverage\/selected-files\.json/);
  assert.match(run, /^coverage\/ledger-snapshot\.manifest$/m, "the weighed snapshot is uploaded for the proposal to fold onto");

  const root = fixtureRoot("coverage-evidence", names(7));
  try {
    writeLedger(root, "scripts/test-tier-manifest.json", {});
    writeLedger(root, "scripts/coverage-ledger.json", {});
    const picked = tierCli(root, [
      "--select-all", "--shard", "1/2", "--instrumented-manifest", "scripts/coverage-ledger.json",
      "--workers", "3", "--selection-output", "selected.json",
    ]);
    assert.equal(picked.status, 0, picked.stderr);
    const selection = JSON.parse(readFileSync(join(root, "selected.json"), "utf8")) as { files: string[] };
    assert.ok(selection.files.length >= 3, `the shard must select files, got ${selection.files.length}`);
    assert.deepEqual(selection.files, picked.stdout.trim().split("\n"));

    const { NODE_TEST_CONTEXT: _omitted, ...env } = process.env;
    execFileSync(process.execPath, [
      "--experimental-test-coverage", "--test", "--test-reporter=tap", "--test-reporter-destination=stdout",
      `--test-reporter=${REPORTER}`, "--test-reporter-destination=durations.json", ...selection.files,
    ], { cwd: root, env, stdio: "pipe" });
    const evidence = JSON.parse(readFileSync(join(root, "durations.json"), "utf8")) as { files: Record<string, number> };
    assert.deepEqual(Object.keys(evidence.files).sort(), [...selection.files].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4071: an EWMA update moves a stale entry both ways and ignores a zero", () => {
  const ledger: Manifest = { thresholdMs: 5000, files: { "test/a.test.ts": 59_000, "test/b.test.ts": 509_000, "test/c.test.ts": 4_000, "test/gone.test.ts": 9 } };
  const known = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"];
  const folded = tier.foldDurationsEwma(ledger, { "test/a.test.ts": 359_000, "test/b.test.ts": 9_000, "test/c.test.ts": 0, "test/d.test.ts": 1_200 }, { alpha: 0.5, knownFiles: known });
  assert.equal(folded.files["test/a.test.ts"], 209_000, "a stale-low entry moves halfway up");
  assert.equal(folded.files["test/b.test.ts"], 259_000, "a stale-high entry moves halfway down");
  assert.equal(folded.files["test/c.test.ts"], 4_000, "a zero reading never replaces a real one");
  assert.equal(folded.files["test/d.test.ts"], 1_200, "a first measurement is taken as is");
  assert.equal(folded.files["test/gone.test.ts"], undefined, "a row naming no test file is dropped");
  assert.equal(ledger.files["test/a.test.ts"], 59_000, "the input ledger is never mutated");
  // Repeated observations converge on the truth rather than oscillating or sticking.
  let entry: Manifest = ledger;
  for (let run = 0; run < 8; run += 1) entry = tier.foldDurationsEwma(entry, { "test/b.test.ts": 9_000 });
  assert.ok(Math.abs(entry.files["test/b.test.ts"]! - 9_000) < 3_000, `converged to ${entry.files["test/b.test.ts"]}`);

  // The CLI folds onto the snapshot when one is given, never the committed ledger.
  const root = fixtureRoot("coverage-ewma", ["a.test.ts", "b.test.ts"]);
  try {
    writeLedger(root, "scripts/coverage-ledger.json", { "test/a.test.ts": 1_000, "test/b.test.ts": 1_000 });
    writeLedger(root, "snapshot.json", { "test/a.test.ts": 100_000, "test/b.test.ts": 2_000 });
    writeFileSync(join(root, "evidence.json"), JSON.stringify({ version: 1, files: { "test/a.test.ts": 20_000, "test/b.test.ts": 0 } }));
    const result = tierCli(root, [
      "--manifest", "scripts/coverage-ledger.json", "--snapshot", "snapshot.json", "--ewma", "0.5",
      "--record-evidence", "evidence.json", "--output", "next.json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "next.json"), "utf8")).files, { "test/a.test.ts": 60_000, "test/b.test.ts": 2_000 });
    assert.equal(tierCli(root, ["--ewma", "0", "--record-evidence", "evidence.json", "--output", "x.json"]).status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4071: four shards partition the suite and an absent snapshot falls back", () => {
  const files = names(40);
  const root = fixtureRoot("coverage-snapshot", files);
  try {
    writeLedger(root, "scripts/test-tier-manifest.json", {});
    writeLedger(root, "scripts/coverage-ledger.json", Object.fromEntries(files.map((f, i) => [`test/${f}`, 1_000 + i])));
    // The snapshot reverses the weights: the split must follow it.
    writeLedger(root, "snapshot.json", Object.fromEntries(files.map((f, i) => [`test/${f}`, 1_000 + (files.length - i) * 400])));
    writeFileSync(join(root, "broken.json"), "{ not json");
    writeFileSync(join(root, "misshapen.json"), JSON.stringify({ files: { "test/suite-00.test.ts": -1 } }));
    const split = (snapshot: string | undefined) => [1, 2, 3, 4].map((index) => {
      const result = tierCli(root, [
        "--select-all", "--shard", `${index}/4`, "--instrumented-manifest", "scripts/coverage-ledger.json",
        ...(snapshot ? ["--snapshot", snapshot] : []), "--workers", "3", "--selection-output", `sel-${index}.json`,
      ]);
      assert.equal(result.status, 0, result.stderr);
      return { files: result.stdout.trim().split("\n"), stderr: result.stderr };
    });

    const fromSnapshot = split("snapshot.json");
    const all = fromSnapshot.flatMap((shard) => shard.files).sort();
    assert.deepEqual(all, files.map((f) => `test/${f}`), "the four shards run every file exactly once");
    assert.match(fromSnapshot[0]!.stderr, /ledger=snapshot:[0-9a-f]{16} workers=3 predicted_makespan_ms=\d+/);
    const check = tierCli(root, ["--check-partition", "sel-1.json", "sel-2.json", "sel-3.json", "sel-4.json"]);
    assert.equal(check.status, 0, check.stderr);

    const committed = split(undefined);
    assert.notDeepEqual(fromSnapshot.map((s) => s.files), committed.map((s) => s.files), "a usable snapshot changes the split");
    for (const fallback of ["absent.json", "broken.json", "misshapen.json"]) {
      const fellBack = split(fallback);
      assert.deepEqual(fellBack.map((s) => s.files), committed.map((s) => s.files), `${fallback} falls back to the committed ledger`);
      assert.match(fellBack[0]!.stderr, /warning: snapshot .* weighing the committed ledger/);
      assert.match(fellBack[0]!.stderr, /ledger=committed:committed/);
    }

    // The aggregator's check refuses a dropped file and a split computed from two ledgers.
    const shards = fromSnapshot.map((s, i) => ({ shard: i + 1, digest: "d1", files: s.files }));
    assert.deepEqual(tier.partitionProblems(all, shards), []);
    const dropped = shards.map((s, i) => (i === 0 ? { ...s, files: s.files.slice(1) } : s));
    assert.match(tier.partitionProblems(all, dropped).join("\n"), /ran on no shard/);
    assert.match(tier.partitionProblems(all, shards.map((s, i) => (i === 3 ? { ...s, digest: "d2" } : s))).join("\n"), /different ledgers/);
    writeFileSync(join(root, "sel-4.json"), JSON.stringify({ shard: 4, digest: "other", files: [] }));
    assert.equal(tierCli(root, ["--check-partition", "sel-1.json", "sel-2.json", "sel-3.json", "sel-4.json"]).status, 1);
    assert.equal(tierCli(root, ["--check-partition", "sel-1.json", "missing.json"]).status, 1, "an unreadable selection refuses");
    assert.equal(tierCli(root, ["--select-all", "--shard", "1/4", "--workers", "0"]).status, 2, "a non-positive worker count is refused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4071: makespan packing never places two files above the shard mean together", () => {
  // Modelled on the measured suite: one 14-minute file that sorts late, a few long files, and a
  // long tail of short ones, packed for 8 shards of 3 concurrent workers.
  const files: Record<string, number> = { "test/retro-marker-atomic.test.ts": 852_000, "test/live-write-guard.test.ts": 600_000, "test/lint-plan-open-only.test.ts": 520_000, "test/run-task.test.ts": 450_000 };
  for (let i = 0; i < 600; i += 1) files[`test/${String.fromCharCode(97 + (i % 26))}-suite-${i}.test.ts`] = 2_000 + ((i * 7919) % 20_000);
  const ledger: Manifest = { thresholdMs: 5000, files };
  const all = Object.keys(files);
  const shards = 8;
  const workers = 3;
  const total = Object.values(files).reduce((a, b) => a + b, 0);
  const mean = total / (shards * workers);
  const heavy = all.filter((f) => files[f]! > mean);
  assert.ok(heavy.length >= 2 && heavy.length <= shards, `the fixture needs 2..${shards} files above the ${mean} ms mean, has ${heavy.length}`);

  const packed = tier.packFilesByMakespan(all, ledger, shards, workers);
  assert.deepEqual(packed.flat().sort(), [...all].sort(), "packing is a partition");
  for (const shard of packed) assert.ok(shard.filter((f) => heavy.includes(f)).length <= 1, `two files above the mean share a shard: ${shard.filter((f) => heavy.includes(f))}`);
  assert.deepEqual(tier.packFilesByMakespan(all, ledger, shards, workers), packed, "the selection is deterministic");

  // The serial-sum split leaves the long file to start at its alphabetical turn; makespan packing
  // makes it the floor and nothing more.
  const slowest = (split: string[][]) => Math.max(...split.map((s) => tier.predictMakespanMs(s, ledger, workers)));
  const lpt = slowest(tier.balanceFilesByDuration(all, ledger, shards));
  const makespan = slowest(packed);
  assert.equal(makespan, 852_000, "the longest file is the floor of the critical path");
  assert.ok(makespan < lpt, `makespan packing ${makespan} ms must beat the serial-sum split ${lpt} ms`);
  assert.deepEqual(tier.packFilesByMakespan(all, ledger, shards, 1), tier.balanceFilesByDuration(all, ledger, shards), "one worker is the serial split");
});
