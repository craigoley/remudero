// test/test-tier-manifest.test.ts — W1-T2904: the per-test-file duration ledger and its
// fast/slow tiering refuses a test file it has never recorded, which is the acceptance this file
// exists to prove ("a test file absent from the tier manifest is refused").
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
  findUntieredFiles: (testFiles: string[], manifest: { files: Record<string, number> }) => string[];
  tierFiles: (
    testFiles: string[],
    manifest: { thresholdMs: number; files: Record<string, number> },
  ) => { fast: string[]; slow: string[] };
  balanceFilesByDuration: (
    testFiles: string[],
    manifest: { thresholdMs: number; files: Record<string, number> },
    shardCount: number,
  ) => string[][];
  inheritedUntieredFiles: (
    missing: string[],
    baseRef: string | undefined,
    root: string,
    spawn: (cmd: string, args: string[], opts?: unknown) => { status: number | null; stdout?: string },
  ) => { inherited: string[]; blocking: string[] };
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
  findUntieredFiles,
  tierFiles,
  balanceFilesByDuration,
  inheritedUntieredFiles,
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

test("findUntieredFiles: a file on disk the manifest has never heard of is missing -- a duration of 0 is NOT missing", () => {
  const manifest = { thresholdMs: DEFAULT_SLOW_THRESHOLD_MS, files: { "test/a.test.ts": 0, "test/b.test.ts": 1234 } };
  const missing = findUntieredFiles(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"], manifest);
  assert.deepEqual(missing, ["test/c.test.ts"], "only the file with NO entry at all is missing");
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

test("inherited untiered files from a moving base default fast without blocking; this PR's new file still blocks", () => {
  const calls: string[] = [];
  const result = inheritedUntieredFiles(
    ["test/from-main.test.ts", "test/from-pr.test.ts"],
    "origin/main",
    "/repo",
    (_cmd, args) => {
      calls.push(args.join(" "));
      return { status: 0, stdout: "test/from-main.test.ts\ntest/already-tiered.test.ts\n" };
    },
  );
  assert.deepEqual(result, { inherited: ["test/from-main.test.ts"], blocking: ["test/from-pr.test.ts"] });
  assert.deepEqual(calls, ["-C /repo ls-tree -r --name-only origin/main -- test"]);
});

test("an unreadable explicit base fails closed: every untiered file still blocks", () => {
  const result = inheritedUntieredFiles(
    ["test/unresolved.test.ts"],
    "missing-ref",
    "/repo",
    () => ({ status: 128, stdout: "" }),
  );
  assert.deepEqual(result, { inherited: [], blocking: ["test/unresolved.test.ts"] });
});

test("without an explicit base, every untiered file blocks (author-time fixture and fail-closed control)", () => {
  const result = inheritedUntieredFiles(
    ["test/new.test.ts"],
    undefined,
    "/repo",
    () => {
      throw new Error("git must not run without an explicit base");
    },
  );
  assert.deepEqual(result, { inherited: [], blocking: ["test/new.test.ts"] });
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

// ── the acceptance criterion itself: an untiered file is refused ───────────────────────────────

test("W1-T2904 acceptance: --check REFUSES a test file absent from the tier manifest, naming it", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "tiered.test.ts");
  writeFixtureTestFile(root, "brand-new.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/tiered.test.ts": 12 } });

  const result = runCli(["--check"], root);
  assert.notEqual(result.status, 0, "an untiered file must refuse, not merely warn");
  assert.match(result.stderr, /test\/brand-new\.test\.ts/, "the refusal must NAME the missing file");
  assert.doesNotMatch(result.stderr, /test\/tiered\.test\.ts is not recorded/, "the already-tiered file must not be reported as missing");
});

test("W1-T2904 acceptance, positive control: --check PASSES when every test file is recorded", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "tiered.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/tiered.test.ts": 12 } });

  const result = runCli(["--check"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test("--check --base reports inherited base movement but passes when this branch introduced no untiered file", () => {
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
  assert.equal(calls, 1, "one base-tree census handles every inherited file");
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

test("--run refuses when the manifest is missing any test file, without spawning anything", () => {
  const root = newFixtureRoot();
  writeFixtureTestFile(root, "tiered.test.ts");
  writeFixtureTestFile(root, "brand-new.test.ts");
  writeFixtureManifest(root, { thresholdMs: 5000, files: { "test/tiered.test.ts": 1 } });

  let spawnCalls = 0;
  const code = main(["--root", root, "--run", "fast"], { spawn: () => { spawnCalls += 1; return { status: 0 }; } });
  assert.equal(code, 1);
  assert.equal(spawnCalls, 0, "an untiered file must refuse before ever spawning the test runner");
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
