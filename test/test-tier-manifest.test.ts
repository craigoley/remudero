// test/test-tier-manifest.test.ts — W1-T2904: the per-test-file duration ledger and its
// fast/slow tiering.
//
// W1-T4430 FLIPPED THE ACCEPTANCE THIS FILE ONCE PROVED: a test file absent from the manifest is
// no longer refused (it defaults to the fast tier at duration 0, same as every other reader of
// `manifest.files`); `--check` refuses only a GHOST row — one that names a file no longer on disk.
// See test/a-new-test-file-needs-no-tier-row.test.ts for that acceptance's own coverage.
//
// scripts/test-tier-manifest.mjs is a plain .mjs file outside tsconfig's `include` (same
// convention as test/test-with-retry.test.ts / test/coverage-ratchet.test.ts), so its pure
// functions are imported directly and its CLI surface is driven as a real subprocess against
// throwaway fixture directories under `mkdtemp` — never the real repo tree, so this suite cannot
// be made to pass or fail by anything else touching scripts/test-tier-manifest.json.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "test-tier-manifest.mjs");

// scripts/test-tier-manifest.mjs sits outside tsconfig's `include` (a plain .mjs file), so — same
// convention as test/a-shard-that-produced-no-summary-is-not-a-failure-set.test.ts's import of
// scripts/test-with-retry.mjs — it is reached here via a dynamic `import()` off a
// `pathToFileURL`, never a static import that TS7016s.
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  DEFAULT_SLOW_THRESHOLD_MS: number;
  tierForDuration: (durationMs: number, thresholdMs: number) => "fast" | "slow";
  findGhostRows: (testFiles: string[], manifest: { files: Record<string, number> }) => string[];
  tierFiles: (
    testFiles: string[],
    manifest: { thresholdMs: number; files: Record<string, number> },
  ) => { fast: string[]; slow: string[] };
  balanceFilesByDuration: (
    testFiles: string[],
    manifest: { thresholdMs: number; files: Record<string, number> },
    shardCount: number,
  ) => string[][];
  mergeDurations: (
    manifest: { thresholdMs: number; files: Record<string, number> },
    measured: Record<string, number>,
  ) => { thresholdMs: number; files: Record<string, number> };
  readDurationEvidence: (
    paths: string[],
    knownTestFiles: string[],
  ) => { measured: Record<string, number>; warnings: string[] };
  loadManifest: (path: string) => { thresholdMs: number; files: Record<string, number> };
  listTestFiles: (root: string) => string[];
  writeManifest: (path: string, manifest: { thresholdMs: number; files: Record<string, number> }) => void;
  main: (
    argv: string[],
    opts?: {
      spawn?: (cmd: string, args: string[], spawnOpts?: unknown) => { status: number | null; signal?: string | null };
      env?: NodeJS.ProcessEnv;
    },
  ) => number;
};
const {
  DEFAULT_SLOW_THRESHOLD_MS,
  tierForDuration,
  findGhostRows,
  tierFiles,
  balanceFilesByDuration,
  mergeDurations,
  readDurationEvidence,
  loadManifest,
  listTestFiles,
  writeManifest,
  main,
} = mod;

function newFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}test-tier-manifest-`));
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  return root;
}

function writeFixtureTestFile(root: string, relPath: string): void {
  const full = join(root, "test", relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "import { test } from 'node:test';\ntest('noop', () => {});\n");
}

function writeFixtureManifest(root: string, manifest: { thresholdMs: number; files: Record<string, number> }): void {
  writeFileSync(join(root, "scripts", "test-tier-manifest.json"), JSON.stringify(manifest, null, 2));
}

function runCli(args: string[], root: string) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
}

// ── pure functions ───────────────────────────────────────────────────────────────────────────

test("tierForDuration: below the threshold is fast, at or above it is slow", () => {
  assert.equal(tierForDuration(0, 5000), "fast");
  assert.equal(tierForDuration(4999, 5000), "fast");
  assert.equal(tierForDuration(5000, 5000), "slow");
  assert.equal(tierForDuration(57771, 5000), "slow");
});

test("findGhostRows: a manifest row naming a file NOT on disk is a ghost; an absent file is never one", () => {
  const manifest = {
    thresholdMs: DEFAULT_SLOW_THRESHOLD_MS,
    files: { "test/a.test.ts": 0, "test/b.test.ts": 1234, "test/deleted.test.ts": 500 },
  };
  const ghosts = findGhostRows(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"], manifest);
  assert.deepEqual(ghosts, ["test/deleted.test.ts"], "only the row naming a file that is gone is a ghost");
});

test("tierFiles: buckets by the manifest's recorded duration against its own threshold", () => {
  const manifest = {
    thresholdMs: 5000,
    files: { "test/fast.test.ts": 10, "test/slow.test.ts": 58000, "test/unmeasured.test.ts": 0 },
  };
  const { fast, slow } = tierFiles(["test/fast.test.ts", "test/slow.test.ts", "test/unmeasured.test.ts"], manifest);
  assert.deepEqual(fast.sort(), ["test/fast.test.ts", "test/unmeasured.test.ts"]);
  assert.deepEqual(slow, ["test/slow.test.ts"]);
});

test("balanceFilesByDuration: longest-first allocation balances cumulative duration, not file count or hash", () => {
  const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"];
  const manifest = {
    thresholdMs: 10_000,
    files: {
      "test/a.test.ts": 900,
      "test/b.test.ts": 800,
      "test/c.test.ts": 200,
      "test/d.test.ts": 100,
    },
  };
  assert.deepEqual(balanceFilesByDuration(files, manifest, 2), [
    ["test/a.test.ts", "test/d.test.ts"],
    ["test/b.test.ts", "test/c.test.ts"],
  ]);
});

test("balanceFilesByDuration: unmeasured zero-duration files spread by count instead of collapsing into one shard", () => {
  const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"];
  const manifest = { thresholdMs: 5000, files: Object.fromEntries(files.map((file) => [file, 0])) };
  assert.deepEqual(balanceFilesByDuration(files, manifest, 2).map((shard) => shard.length), [2, 2]);
});

test("mergeDurations: overwrites/adds only the named entries, leaves every other recorded file untouched, never mutates its input", () => {
  const manifest = { thresholdMs: 5000, files: { "test/a.test.ts": 1, "test/b.test.ts": 2 } };
  const frozen = JSON.parse(JSON.stringify(manifest));
  const merged = mergeDurations(manifest, { "test/b.test.ts": 99, "test/c.test.ts": 3 });
  assert.deepEqual(merged.files, { "test/a.test.ts": 1, "test/b.test.ts": 99, "test/c.test.ts": 3 });
  assert.deepEqual(manifest, frozen, "the input manifest must be untouched");
});

test("readDurationEvidence merges shard documents, keeps the slowest repeat, and rejects unsafe or malformed entries", () => {
  const root = newFixtureRoot();
  const first = join(root, "first.json");
  const second = join(root, "second.json");
  writeFileSync(first, JSON.stringify({
    version: 1,
    files: { "test/a.test.ts": 12, "test/b.test.ts": 20, "../escape.test.ts": 999 },
  }));
  writeFileSync(second, JSON.stringify({
    version: 1,
    files: { "test/a.test.ts": 15, "test/unknown.test.ts": 30, "test/b.test.ts": -1 },
  }));
  const result = readDurationEvidence([first, second], ["test/a.test.ts", "test/b.test.ts"]);
  assert.deepEqual(result.measured, { "test/a.test.ts": 15, "test/b.test.ts": 20 });
  assert.equal(result.warnings.length, 3);
});

test("readDurationEvidence: an UNREADABLE evidence file warns and skips it, never aborting the merge", () => {
  // The catch arm. One corrupt shard artifact must not lose the other shards' evidence — a
  // recording run collects from four shards and any one of them can be truncated.
  const root = newFixtureRoot();
  const broken = join(root, "broken.json");
  const good = join(root, "good.json");
  writeFileSync(broken, "{ this is not json");
  writeFileSync(good, JSON.stringify({ version: 1, files: { "test/a.test.ts": 21 } }));
  const result = readDurationEvidence([broken, good], ["test/a.test.ts"]);
  assert.deepEqual(result.measured, { "test/a.test.ts": 21 }, "the readable shard's evidence survives");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /unreadable duration evidence/);
  assert.ok(result.warnings[0].includes(broken), "the warning names the file it could not read");
});

test("readDurationEvidence: an evidence file of the WRONG SCHEMA warns and skips it, rather than reading it as empty", () => {
  // The schema arm, distinct from the catch above: this file parses fine and is simply not the
  // document we asked for. Reading it as `{}` would silently downgrade every recorded duration.
  const root = newFixtureRoot();
  const wrongVersion = join(root, "v2.json");
  const noFiles = join(root, "nofiles.json");
  const good = join(root, "good.json");
  writeFileSync(wrongVersion, JSON.stringify({ version: 2, files: { "test/a.test.ts": 99 } }));
  writeFileSync(noFiles, JSON.stringify({ version: 1 }));
  writeFileSync(good, JSON.stringify({ version: 1, files: { "test/a.test.ts": 21 } }));
  const result = readDurationEvidence([wrongVersion, noFiles, good], ["test/a.test.ts"]);
  assert.deepEqual(result.measured, { "test/a.test.ts": 21 }, "neither malformed document contributed a duration");
  assert.equal(result.warnings.length, 2);
  for (const w of result.warnings) assert.match(w, /unsupported duration evidence schema/);
});

test("--record-evidence without --output REFUSES with exit 2 rather than writing somewhere it guessed", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "a.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/a.test.ts": 1 } });
  const evidence = join(root, "shard.json");
  writeFileSync(evidence, JSON.stringify({ version: 1, files: { "test/a.test.ts": 44 } }));
  const missingOutput = runCli(["--record-evidence", evidence], root);
  assert.equal(missingOutput.status, 2, missingOutput.stderr);
  assert.match(missingOutput.stderr, /--record-evidence requires one or more files and --output/);
  // The mirror arm: --output given but no evidence file named.
  const missingEvidence = runCli(["--record-evidence", "--output", join(root, "p.json")], root);
  assert.equal(missingEvidence.status, 2, missingEvidence.stderr);
});

test("--record-evidence writes a separate deterministic proposal and never mutates the tracked manifest", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "a.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/a.test.ts": 1 } });
  const evidence = join(root, "shard.json");
  const proposal = join(root, "proposal.json");
  writeFileSync(evidence, JSON.stringify({ version: 1, files: { "test/a.test.ts": 44 } }));
  const before = readFileSync(join(root, "scripts", "test-tier-manifest.json"), "utf8");
  const result = runCli(["--record-evidence", evidence, "--output", proposal], root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(proposal, "utf8")).files, { "test/a.test.ts": 44 });
  assert.equal(readFileSync(join(root, "scripts", "test-tier-manifest.json"), "utf8"), before);
});

// ── --propose: gates a future "open the PR" rung on whether the proposal differs materially ────

test("--propose without --proposed REFUSES with exit 2 rather than guessing a proposal file", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "a.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/a.test.ts": 100 } });
  const result = runCli(["--propose"], root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--propose requires --proposed <path>/);
});

test("--propose exits 0 and says so when the proposal is material, against the default --manifest as committed", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "a.test.ts");
  writeFixtureTestFile(root, "b.test.ts");
  // No --committed given: --propose must fall back to reading the tracked manifest at --manifest.
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/a.test.ts": 100, "test/b.test.ts": 0 } });
  const proposal = join(root, "proposal.json");
  writeFileSync(proposal, JSON.stringify({ thresholdMs: 5000, files: { "test/a.test.ts": 100, "test/b.test.ts": 5 } }));
  // No --shard-count given: must fall back to the default of 4 rather than throwing on `undefined`.
  const result = runCli(["--propose", "--proposed", proposal], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /proposal is material — open a pull request adopting it/);
});

test("--propose exits 1 and says so when the proposal is NOT material, against an explicit --committed and --shard-count", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "a.test.ts");
  writeFixtureTestFile(root, "b.test.ts");
  const committed = join(root, "committed.json");
  writeFileSync(committed, JSON.stringify({ thresholdMs: 5000, files: { "test/a.test.ts": 1000, "test/b.test.ts": 10 } }));
  const proposal = join(root, "proposal.json");
  // A few ms of measurement noise on an already-measured file: no shard membership change.
  writeFileSync(proposal, JSON.stringify({ thresholdMs: 5000, files: { "test/a.test.ts": 1003, "test/b.test.ts": 11 } }));
  const result = runCli(["--propose", "--proposed", proposal, "--committed", committed, "--shard-count", "2"], root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /proposal is not material — no pull request needed/);
});

test("loadManifest: a missing manifest file reads as empty (default threshold, no files), not a crash", () => {
  const root = newFixtureRoot();
  const manifest = loadManifest(join(root, "scripts", "test-tier-manifest.json"));
  assert.deepEqual(manifest, { thresholdMs: DEFAULT_SLOW_THRESHOLD_MS, files: {} });
});

test("listTestFiles: walks nested test/ directories, returns sorted root-relative POSIX paths", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "b.test.ts");
  writeFixtureTestFile(root, "a.test.ts");
  writeFixtureTestFile(root, "nested/c.test.ts");
  writeFixtureTestFile(root, "not-a-test.ts"); // must be excluded — no `.test.ts` suffix
  const files = listTestFiles(root);
  assert.deepEqual(files, ["test/a.test.ts", "test/b.test.ts", "test/nested/c.test.ts"]);
});

test("listTestFiles: a root with no test directory is an empty suite, while another read error stays loud", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}test-tier-no-test-`));
  assert.deepEqual(listTestFiles(root), []);
  writeFileSync(join(root, "test"), "not a directory");
  assert.throws(() => listTestFiles(root), /ENOTDIR/);
});

// ── the W1-T4430 acceptance: a new test file needs no row, a GHOST row is what refuses ─────────

test("W1-T4430 acceptance: --check PASSES on a brand-new, untiered test file — no row was ever required", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "tiered.test.ts");
  writeFixtureTestFile(root, "brand-new.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/tiered.test.ts": 12 } });

  const result = runCli(["--check"], root);
  assert.equal(result.status, 0, `an untiered file must never refuse: ${result.stderr}`);
  assert.match(result.stdout, /OK/);
});

test("W1-T4430 acceptance: --check REFUSES a GHOST row — a manifest entry naming a file that no longer exists", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "tiered.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/tiered.test.ts": 12, "test/deleted.test.ts": 900 } });

  const result = runCli(["--check"], root);
  assert.notEqual(result.status, 0, "a row naming a file that does not exist must refuse");
  assert.match(result.stderr, /test\/deleted\.test\.ts/, "the refusal must NAME the ghost row");
  assert.doesNotMatch(result.stderr, /test\/tiered\.test\.ts/, "the row that still names a real file must not be reported");
});

test("W1-T2904 acceptance, positive control: --check PASSES when every test file is recorded and no row is a ghost", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "tiered.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/tiered.test.ts": 12 } });

  const result = runCli(["--check"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test("--check ignores --base entirely now — it neither spawns git nor changes the verdict", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "from-main.test.ts");
  let calls = 0;
  const code = main(["--root", root, "--check", "--base", "origin/main"], {
    spawn: () => {
      calls += 1;
      return { status: 0, stdout: "test/from-main.test.ts\n" };
    },
  });
  assert.equal(code, 0);
  assert.equal(calls, 0, "W1-T4430: a ghost-row check never needs the base tree, so it must not spawn git");
});

test("--seed adds a placeholder duration of 0 for an untiered file, and never overwrites an already-recorded one", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "tiered.test.ts");
  writeFixtureTestFile(root, "brand-new.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/tiered.test.ts": 999 } });

  const result = runCli(["--seed"], root);
  assert.equal(result.status, 0, result.stderr);

  const written = JSON.parse(readFileSync(join(root, "scripts", "test-tier-manifest.json"), "utf8"));
  assert.deepEqual(written.files, { "test/brand-new.test.ts": 0, "test/tiered.test.ts": 999 });

  // Idempotent: seeding again with nothing new to add changes nothing and still exits 0.
  const again = runCli(["--seed"], root);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /nothing to seed/);
});

// ── --run wiring: a pure unit test on `main`'s injectable spawn, not a real recursive `node --test` ──

test("W1-T4430: --run fast INCLUDES an untiered test file, rather than refusing to spawn at all", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "tiered.test.ts");
  writeFixtureTestFile(root, "brand-new.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/tiered.test.ts": 1 } });

  let capturedArgs: string[] | undefined;
  const code = main(["--root", root, "--run", "fast"], {
    spawn: (_cmd: string, args: string[]) => {
      capturedArgs = args;
      return { status: 0 };
    },
  });
  assert.equal(code, 0);
  assert.ok(capturedArgs?.includes("test/tiered.test.ts"));
  assert.ok(capturedArgs?.includes("test/brand-new.test.ts"), "an untiered file defaults into the fast tier, not a refusal");
});

test("--run rejects an unknown tier and a malformed shard before spawning tests", () => {
  const root = newFixtureRoot();
  let calls = 0;
  const spawn = () => {
    calls += 1;
    return { status: 0 };
  };
  assert.equal(main(["--root", root, "--run", "lukewarm"], { spawn }), 2);
  assert.equal(main(["--root", root, "--run", "fast", "--shard", "9/4"], { spawn }), 2);
  assert.equal(calls, 0);
});

test("--run fast spawns node --test over exactly the fast-tier files, and returns the child's own exit code", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "fast.test.ts");
  writeFixtureTestFile(root, "slow.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/fast.test.ts": 10, "test/slow.test.ts": 58000 } });

  let capturedArgs: string[] | undefined;
  const code = main(["--root", root, "--run", "fast"], {
    spawn: (_cmd: string, args: string[]) => {
      capturedArgs = args;
      return { status: 3 };
    },
  });
  assert.equal(code, 3, "the wrapper returns the spawned child's own exit code");
  assert.ok(capturedArgs?.includes("test/fast.test.ts"));
  assert.ok(!capturedArgs?.includes("test/slow.test.ts"), "the fast run must not include a slow-tier file");
});

test("--run slow with no slow-tier files recorded yet runs nothing and exits 0", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "fast.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/fast.test.ts": 10 } });

  let spawnCalls = 0;
  const code = main(["--root", root, "--run", "slow"], { spawn: () => { spawnCalls += 1; return { status: 0 }; } });
  assert.equal(code, 0);
  assert.equal(spawnCalls, 0, "an empty tier must not spawn an argument-less `node --test`, which node itself refuses");
});

test("--run fast --shard runs only its duration-balanced shard", () => {
  const root = newFixtureRoot();
  for (const file of ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"]) writeFixtureTestFile(root, file);
  writeFixtureManifest(root, {
    thresholdMs: 5000,
    files: {
      "test/a.test.ts": 900,
      "test/b.test.ts": 800,
      "test/c.test.ts": 200,
      "test/d.test.ts": 100,
    },
  });
  let capturedArgs: string[] = [];
  const code = main(["--root", root, "--run", "fast", "--shard", "2/2"], {
    spawn: (_cmd: string, args: string[]) => {
      capturedArgs = args;
      return { status: 0 };
    },
  });
  assert.equal(code, 0);
  assert.ok(capturedArgs.includes("test/b.test.ts"));
  assert.ok(capturedArgs.includes("test/c.test.ts"));
  assert.ok(!capturedArgs.includes("test/a.test.ts"));
  assert.ok(!capturedArgs.includes("test/d.test.ts"));
});

test("--select-all emits one duration-balanced whole-suite shard without spawning the test runner", () => {
  const root = newFixtureRoot();
  for (const file of ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"]) writeFixtureTestFile(root, file);
  writeFixtureManifest(root, {
    thresholdMs: 5000,
    files: {
      "test/a.test.ts": 900,
      "test/b.test.ts": 800,
      "test/c.test.ts": 200,
      "test/d.test.ts": 100,
    },
  });
  const result = runCli(["--select-all", "--shard", "2/2"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["test/b.test.ts", "test/c.test.ts"]);
  assert.match(result.stderr, /coverage shard summary/);
});

test("--select-all refuses an unfilled coverage matrix instead of silently emitting an empty shard", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "only.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/only.test.ts": 100 } });
  const result = runCli(["--select-all", "--shard", "1/2"], root);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot fill 2 shards/);
});

test("--select-all rejects a missing shard argument before it can select the whole suite", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "only.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/only.test.ts": 100 } });
  let spawnCalls = 0;
  const code = main(["--root", root, "--select-all"], { spawn: () => { spawnCalls += 1; return { status: 0 }; } });
  assert.equal(code, 2);
  assert.equal(spawnCalls, 0);
});

test("W1-T4430: --select-all INCLUDES an untiered test in the coverage suite, rather than refusing it", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "recorded.test.ts");
  writeFixtureTestFile(root, "untiered.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/recorded.test.ts": 100 } });
  const result = runCli(["--select-all", "--shard", "1/1"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n").sort(), ["test/recorded.test.ts", "test/untiered.test.ts"]);
});

test("--run adds a second event reporter only when a duration output is requested", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "a.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/a.test.ts": 1 } });
  const output = join(root, "evidence", "shard.json");
  let capturedArgs: string[] = [];
  const code = main(["--root", root, "--run", "fast"], {
    env: { RMD_TEST_DURATION_OUTPUT: output },
    spawn: (_cmd: string, args: string[]) => {
      capturedArgs = args;
      return { status: 0 };
    },
  });
  assert.equal(code, 0);
  assert.ok(capturedArgs.includes("--test-reporter=tap"));
  assert.ok(capturedArgs.some((arg) => arg.endsWith("scripts/test-duration-reporter.mjs")));
  assert.ok(capturedArgs.includes(`--test-reporter-destination=${output}`));
});

test("writeManifest round-trips through loadManifest with sorted keys (a deterministic diff on every recording pass)", () => {
  const root = newFixtureRoot();
  const path = join(root, "scripts", "test-tier-manifest.json");
  writeManifest(path, { thresholdMs: 5000, files: { "test/z.test.ts": 1, "test/a.test.ts": 2 } });
  const raw = readFileSync(path, "utf8");
  assert.ok(raw.indexOf('"test/a.test.ts"') < raw.indexOf('"test/z.test.ts"'), "keys must be written sorted");
  assert.deepEqual(loadManifest(path), { thresholdMs: 5000, files: { "test/a.test.ts": 2, "test/z.test.ts": 1 } });
});

test("default mode reports the tier census without spawning the runner", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "fast.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/fast.test.ts": 12 } });
  let calls = 0;
  assert.equal(main(["--root", root], { spawn: () => { calls += 1; return { status: 0 }; } }), 0);
  assert.equal(calls, 0);
});
