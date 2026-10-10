/**
 * W1-T6085 — pure test files share one process.
 *
 * scripts/pure-test-pool.mjs admits a test file to a shared `--experimental-test-isolation=none`
 * child only when a static census finds nothing that could leak into a neighbour; the tier manifest
 * runs a fast shard's admitted files in ONE child and every other file as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Verdict = { admitted: boolean; reasons: string[] };
type RunOpts = { pool: boolean; quiet?: boolean; role: string };
const pool = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "pure-test-pool.mjs")).href)) as {
  POOL_ISOLATION_FLAG: string;
  censusSource: (source: unknown) => Verdict;
  censusFile: (file: string, opts?: { root?: string; readFile?: (path: string) => string }) => Verdict;
  partitionPool: (
    files: string[],
    opts: { fast: string[]; root?: string; readFile?: (path: string) => string },
  ) => { pooled: string[]; isolated: string[]; refusals: Record<string, string[]> };
  runShardWithPool: (
    files: string[],
    opts: {
      fast: string[];
      readFile?: (path: string) => string;
      run: (files: string[], opts: RunOpts) => number;
      log?: (line: string) => void;
    },
  ) => { status: number; poolDefect: null | { leaker: string | null; victim: string | null } };
};
const manifest = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "test-tier-manifest.mjs")).href)) as {
  main: (
    argv: string[],
    opts: { spawn: (cmd: string, args: string[], o?: unknown) => { status: number | null }; env?: NodeJS.ProcessEnv },
  ) => number;
};

const PURE = `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("x", () => assert.equal(1 + 1, 2));\n`;

test("unit test: the census admits a file with no env, chdir, spawn or global writes", () => {
  const verdict = pool.censusSource(PURE);
  assert.deepEqual(verdict, { admitted: true, reasons: [] });
  // Reading process.env is not writing it.
  assert.equal(pool.censusSource(`${PURE}const h = process.env.HOME; const c = { ...process.env };\n`).admitted, true);
  assert.equal(pool.censusSource(`${PURE}const m = /a/.exec("a"); const e = process.env.X === "1";\n`).admitted, true);
});

const REFUSED: Array<[string, string]> = [
  ["process.env write", `process.env.FOO = "1";`],
  ["process.env write", `process.env["FOO"] ??= "1";`],
  ["process.env write", `delete process.env.FOO;`],
  ["process.env write", `Object.assign(process.env, { A: "1" });`],
  ["process.env write", `const env = process.env;\nenv.A = "1";`],
  ["process.chdir", `process.chdir("/tmp");`],
  ["child_process / spawn / exec", `import { spawnSync } from "node:child_process";`],
  ["child_process / spawn / exec", `const r = execSync("ls");`],
  ["global or prototype assignment", `globalThis.fetch = () => null;`],
  ["global or prototype assignment", `Array.prototype.last = function () {};`],
  ["global or prototype assignment", `Date.now = () => 0;`],
  ["global or prototype assignment", `process.exitCode = 1;`],
  ["global or prototype assignment", `Object.defineProperty(globalThis, "x", { value: 1 });`],
  ["module mock", `mock.module("./x.js", {});`],
  ["module mock", `t.mock.method(fs, "readFileSync", () => "");`],
  ["timer fake", `mock.timers.enable({ apis: ["setTimeout"] });`],
  ["process-level listener", `process.on("exit", () => {});`],
  ["process-level listener", `process.once("uncaughtException", () => {});`],
];

test("unit test: the census refuses each env, chdir, spawn, global, mock, timer and listener write by name", () => {
  for (const [name, snippet] of REFUSED) {
    const verdict = pool.censusSource(`${PURE}${snippet}\n`);
    assert.equal(verdict.admitted, false, `${snippet} must be refused`);
    assert.ok(verdict.reasons.includes(name), `${snippet} must be refused as "${name}", got ${JSON.stringify(verdict.reasons)}`);
  }
});

test("unit test: a fixture that assigns process.env is never found in the pool (the falsifier)", () => {
  const files = ["test/pure.test.ts", "test/env-writer.test.ts"];
  const source: Record<string, string> = {
    "test/pure.test.ts": PURE,
    "test/env-writer.test.ts": `${PURE}process.env.LEAK = "1";\n`,
  };
  const split = pool.partitionPool(files, { fast: files, root: "r", readFile: (p) => source[p.replace(/^r[\\/]/, "").replaceAll("\\", "/")] });
  assert.deepEqual(split.pooled, ["test/pure.test.ts"]);
  assert.deepEqual(split.isolated, ["test/env-writer.test.ts"]);
  assert.deepEqual(split.refusals["test/env-writer.test.ts"], ["process.env write"]);
});

test("unit test: the census refuses what it cannot read, and what is not in the fast tier", () => {
  for (const unreadable of [undefined, null, 42, "", "   \n"]) {
    assert.equal(pool.censusSource(unreadable).admitted, false, `${String(unreadable)} is unreadable`);
  }
  const missing = pool.censusFile("test/nope.test.ts", { root: join(tmpdir(), "rmd-no-such-root-6085") });
  assert.equal(missing.admitted, false);
  assert.match(missing.reasons[0] ?? "", /^unreadable/);

  const split = pool.partitionPool(["test/slow.test.ts", "test/fast.test.ts"], {
    fast: ["test/fast.test.ts"],
    readFile: () => PURE,
  });
  assert.deepEqual(split.pooled, ["test/fast.test.ts"]);
  assert.deepEqual(split.refusals["test/slow.test.ts"], ["not in the fast tier"]);
});

const SHARD = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/spawner.test.ts"];
const sourceOf = (p: string) => (p.endsWith("spawner.test.ts") ? `${PURE}spawnSync("ls");\n` : PURE);

test("unit test: a shard runs its admitted files in one child under --experimental-test-isolation=none and the rest isolated", () => {
  const calls: Array<{ files: string[]; pool: boolean }> = [];
  const result = pool.runShardWithPool(SHARD, {
    fast: SHARD,
    readFile: sourceOf,
    run: (files, opts) => {
      calls.push({ files, pool: opts.pool });
      return 0;
    },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(calls, [
    { files: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"], pool: true },
    { files: ["test/spawner.test.ts"], pool: false },
  ]);
  assert.equal(pool.POOL_ISOLATION_FLAG, "--experimental-test-isolation=none");
});

test("unit test: a pool failure re-runs the pool isolated and names the file that leaks", () => {
  const calls: Array<{ files: string[]; pool: boolean; role: string }> = [];
  const log: string[] = [];
  // b leaks into c: whenever both are in ONE shared process, the process fails.
  const result = pool.runShardWithPool(SHARD, {
    fast: SHARD,
    readFile: sourceOf,
    log: (line) => log.push(line),
    run: (files, opts) => {
      calls.push({ files, pool: opts.pool, role: opts.role });
      return opts.pool && files.includes("test/b.test.ts") && files.includes("test/c.test.ts") ? 1 : 0;
    },
  });
  assert.equal(result.status, 0, "every file passes alone, so the shard is green");
  assert.deepEqual(result.poolDefect, { leaker: "test/b.test.ts", victim: "test/c.test.ts" });
  const reruns = calls.filter((c) => c.role === "rerun");
  assert.deepEqual(reruns, [{ files: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"], pool: false, role: "rerun" }]);
  assert.ok(log.some((l) => l.includes("POOL DEFECT") && l.includes("leaking file: test/b.test.ts")), log.join("\n"));
  assert.equal(calls.at(-1)?.role, "rest", "the non-pooled file still runs after the defect is named");
});

test("unit test: a pooled file that also fails isolated is a test failure, not a pool defect", () => {
  const log: string[] = [];
  const result = pool.runShardWithPool(SHARD, {
    fast: SHARD,
    readFile: sourceOf,
    log: (line) => log.push(line),
    run: (files) => (files.includes("test/b.test.ts") ? 1 : 0),
  });
  assert.equal(result.status, 1);
  assert.equal(result.poolDefect, null);
  assert.ok(!log.some((l) => l.includes("POOL DEFECT")));
});

// tmp-hygiene sets NODE_TEST_CONTEXT, which makes a nested `node --test` run inline; drop it.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-pool-6085-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

test("unit test: --run fast spawns the pool with isolation off and the leftovers with it on", () => {
  const root = fixtureRoot({
    "test/a.test.ts": PURE,
    "test/b.test.ts": PURE,
    "test/env.test.ts": `${PURE}process.env.X = "1";\n`,
    "test/slow.test.ts": PURE,
    "scripts/test-tier-manifest.json": JSON.stringify({ thresholdMs: 5000, files: { "test/slow.test.ts": 9000 } }),
  });
  const calls: string[][] = [];
  const code = manifest.main(["--root", root, "--run", "fast"], {
    spawn: (_cmd, args) => {
      calls.push(args);
      return { status: 0 };
    },
    env: {},
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  const [first, second] = calls as [string[], string[]];
  assert.ok(first.includes(pool.POOL_ISOLATION_FLAG));
  assert.deepEqual(first.filter((a) => a.endsWith(".test.ts")), ["test/a.test.ts", "test/b.test.ts"]);
  assert.ok(!second.includes(pool.POOL_ISOLATION_FLAG));
  assert.deepEqual(second.filter((a) => a.endsWith(".test.ts")), ["test/env.test.ts"]);
  assert.ok(![...first, ...second].includes("test/slow.test.ts"), "the slow tier is not the fast run's");

  // The slow tier never shares a process.
  const slowCalls: string[][] = [];
  manifest.main(["--root", root, "--run", "slow"], { spawn: (_c, args) => (slowCalls.push(args), { status: 0 }), env: {} });
  assert.equal(slowCalls.length, 1);
  assert.ok(!slowCalls[0]!.includes(pool.POOL_ISOLATION_FLAG));
});

test("unit test: a duration reporter writes each pool child to its own file so evidence is not overwritten", () => {
  const root = fixtureRoot({
    "test/a.test.ts": PURE,
    "test/b.test.ts": PURE,
    "test/env.test.ts": `${PURE}process.env.X = "1";\n`,
    "scripts/test-tier-manifest.json": JSON.stringify({ thresholdMs: 5000, files: {} }),
  });
  const destinations: string[] = [];
  manifest.main(["--root", root, "--run", "fast"], {
    spawn: (_cmd, args) => {
      destinations.push(args.filter((a) => a.startsWith("--test-reporter-destination=") && a.endsWith(".json")).join(","));
      return { status: 0 };
    },
    env: { RMD_TEST_DURATION_OUTPUT: "out/shard-1.json" },
  });
  assert.equal(destinations.length, 2);
  assert.match(destinations[0]!, /out[\\/]shard-1\.pool\.json$/);
  assert.match(destinations[1]!, /out[\\/]shard-1\.json$/);
});

test("unit test: node runs two files in one shared process under the flag this pool passes", () => {
  const root = fixtureRoot({
    "a.test.ts": `import test from "node:test";\nglobalThis.__pool6085 = process.pid;\ntest("a", () => {});\n`,
    "b.test.ts": `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("b", () => assert.equal((globalThis as any).__pool6085, process.pid));\n`,
  });
  const shared = spawnSync(
    process.execPath,
    ["--test", "--import", "tsx", pool.POOL_ISOLATION_FLAG, "--test-reporter=tap", join(root, "a.test.ts"), join(root, "b.test.ts")],
    { cwd: REPO_ROOT, encoding: "utf8", env: cleanEnv() },
  );
  assert.equal(shared.status, 0, shared.stdout + shared.stderr);
  const isolated = spawnSync(
    process.execPath,
    ["--test", "--import", "tsx", "--test-reporter=tap", join(root, "a.test.ts"), join(root, "b.test.ts")],
    { cwd: REPO_ROOT, encoding: "utf8", env: cleanEnv() },
  );
  assert.notEqual(isolated.status, 0, "without the flag each file has its own process, so b cannot see a's global");
});
