/**
 * 2026-10-11 ci-shard hang (#10765, #10854, #10858): every test passed, then the shard sat silent
 * until the job's 35-minute cancel.
 *
 * The W1-T6085 pure-test pool (scripts/pure-test-pool.mjs) failed one pooled test, the isolated re-run
 * passed, and the leak locator then ran quiet pool re-runs one predecessor at a time (~30 s each over a
 * 224-file pool) BEFORE the shard's non-pooled files. The failing test was W1-T5624's own check that
 * GH_CONFIG_DIR carries this pid: a pool runner runs its tests in its own process, where Node sets no
 * NODE_TEST_CONTEXT, so test/setup/no-live-remote.ts installed none of its containment there.
 *
 * Pinned here: the containment installs in a pool runner; the rest runs before any locate probe; the
 * locator is logarithmic and logs every probe; a hung fast-tier test fails by name and the run ends.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as noLiveRemote from "#test/setup/no-live-remote.js";
import { LIVE_WRITE_SENTINEL_TOKEN } from "#src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { finishJudgedRun } from "#test/helpers/judged-pool-run.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type RunOpts = { pool: boolean; quiet?: boolean; role: string };
const pool = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "pure-test-pool.mjs")).href)) as {
  POOL_ISOLATION_FLAG: string;
  runShardWithPool: (
    files: string[],
    opts: { fast: string[]; readFile?: (path: string) => string; run: (files: string[], opts: RunOpts) => number; log?: (line: string) => void },
  ) => { status: number; poolDefect: null | { leaker: string | null; victim: string | null } };
  locateLeak: (pooled: string[], runPool: (subset: string[]) => number) => { leaker: string | null; victim: string | null };
};
const tiers = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "test-tier-manifest.mjs")).href)) as {
  FAST_TIER_TEST_TIMEOUT_FACTOR?: number;
  fastTierHangBoundArgs?: (manifest: unknown) => string[];
  main: (argv: string[], opts: { spawn: (cmd: string, args: string[], o?: unknown) => { status: number | null }; env?: NodeJS.ProcessEnv }) => number;
};
const setup = noLiveRemote as unknown as {
  runsTestFilesInThisProcess?: (execArgv?: readonly string[]) => boolean;
  installNoLiveRemote: (env?: NodeJS.ProcessEnv, mainThread?: boolean, execArgv?: readonly string[]) => { ghConfigDir?: string };
  GH_CONFIG_DIR_PREFIX: string;
};

const PURE = `import test from "node:test";\ntest("x", () => {});\n`;

function scratchDir(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}pool-hang-${kind}-`));
}

/** A nested `node --test` must not report to this runner, and must not join its coverage session. */
function nestedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.RMD_SELF_SYNC_DONE;
  env.NODE_V8_COVERAGE = "";
  return env;
}

test("a pool runner gets the live-remote containment: GH_CONFIG_DIR owned by its pid and the sentinel GH_TOKEN", () => {
  const dir = scratchDir("probe");
  const out = join(dir, "seen.json");
  const probe = join(dir, "probe.test.ts");
  writeFileSync(probe, [
    `import test from "node:test";`,
    `import { writeFileSync } from "node:fs";`,
    `test("probe", () => writeFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: process.pid, token: process.env.GH_TOKEN, config: process.env.GH_CONFIG_DIR ?? "" })));`,
    "",
  ].join("\n"));
  try {
    const run = spawnSync(
      process.execPath,
      ["--test", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", pool.POOL_ISOLATION_FLAG, "--test-reporter=tap", probe],
      { cwd: REPO_ROOT, encoding: "utf8", env: nestedEnv({ GH_TOKEN: "a-token-the-operator-shell-exported" }), timeout: 120_000 },
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const seen = JSON.parse(readFileSync(out, "utf8")) as { pid: number; token?: string; config: string };
    assert.equal(seen.token, LIVE_WRITE_SENTINEL_TOKEN, "the pooled test must not see the caller's real token");
    assert.ok(basename(seen.config).startsWith(`${setup.GH_CONFIG_DIR_PREFIX}${seen.pid}-`), `GH_CONFIG_DIR=${JSON.stringify(seen.config)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit test: only a --test runner with isolation off counts as running its test files in-process", () => {
  assert.equal(typeof setup.runsTestFilesInThisProcess, "function");
  const inProcess = setup.runsTestFilesInThisProcess!;
  assert.equal(inProcess(["--test", "--experimental-test-isolation=none"]), true);
  assert.equal(inProcess(["--test", "--test-isolation=none"]), true);
  assert.equal(inProcess(["--test", "--test-isolation", "none"]), true);
  assert.equal(inProcess(["--test"]), false, "a per-file runner runs no test code itself");
  assert.equal(inProcess(["--test-isolation=process", "--test-timeout=0"]), false, "a runner's file child");
  assert.equal(inProcess(["--experimental-test-isolation=none"]), false, "not a test runner at all");
  assert.equal(inProcess([]), false);

  const noContext: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: tmpdir() };
  assert.deepEqual(setup.installNoLiveRemote(noContext, true, []), {}, "control: a plain process is left alone");
  assert.equal(noContext.GH_TOKEN, undefined);
  const installed = setup.installNoLiveRemote(noContext, true, ["--test", "--experimental-test-isolation=none"]);
  try {
    assert.ok(installed.ghConfigDir, "a pool runner gets its own gh config dir");
    assert.equal(noContext.GH_CONFIG_DIR, installed.ghConfigDir);
    assert.equal(noContext.GH_TOKEN, LIVE_WRITE_SENTINEL_TOKEN);
  } finally {
    if (installed.ghConfigDir) rmSync(installed.ghConfigDir, { recursive: true, force: true });
  }
});

const SHARD = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/spawner.test.ts"];
const sourceOf = (p: string) => (p.endsWith("spawner.test.ts") ? `${PURE}spawnSync("ls");\n` : PURE);

test("unit test: a pool defect runs the shard's isolated rest BEFORE any locate probe, and logs every probe", () => {
  const roles: string[] = [];
  const log: string[] = [];
  const result = pool.runShardWithPool(SHARD, {
    fast: SHARD,
    readFile: sourceOf,
    log: (line) => log.push(line),
    run: (files, opts) => {
      roles.push(opts.role);
      return opts.pool && files.includes("test/b.test.ts") && files.includes("test/c.test.ts") ? 1 : 0;
    },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.poolDefect, { leaker: "test/b.test.ts", victim: "test/c.test.ts" });
  const firstLocate = roles.indexOf("locate");
  assert.ok(firstLocate > 0, roles.join(","));
  assert.deepEqual(roles.slice(0, firstLocate), ["pool", "rerun", "rest"], "the shard's verdict is complete before locating starts");
  const probeLines = log.filter((l) => l.startsWith("pure-test-pool: locate probe "));
  assert.equal(probeLines.length, roles.length - firstLocate, "one log line per probe, so a long location reads as progress");
});

test("unit test: the leak locator needs O(log n) pool runs, not one per predecessor", () => {
  const pooled = Array.from({ length: 224 }, (_, i) => `test/f${String(i).padStart(3, "0")}.test.ts`);
  const leaker = pooled[37]!;
  const victim = pooled[150]!;
  let probes = 0;
  const found = pool.locateLeak(pooled, (subset) => {
    probes += 1;
    return subset.includes(leaker) && subset.includes(victim) ? 1 : 0;
  });
  assert.deepEqual(found, { leaker, victim });
  const bound = 2 * Math.ceil(Math.log2(pooled.length)) + 2;
  assert.ok(probes <= bound, `${probes} probes for a 224-file pool; at ~30 s a probe the linear search ran past the job's 35 min`);

  assert.deepEqual(
    pool.locateLeak(pooled, (subset) => (subset.includes(victim) ? 1 : 0)),
    { leaker: victim, victim },
    "a file that fails pooled even alone is its own leaker",
  );
  assert.deepEqual(pool.locateLeak(pooled, () => 0), { leaker: null, victim: null }, "a failure that does not reproduce names nobody");
});

test("unit test: a fast-tier run carries a per-test timeout scaled from the tier threshold and exits once every test has finished", () => {
  assert.equal(typeof tiers.fastTierHangBoundArgs, "function");
  const factor = tiers.FAST_TIER_TEST_TIMEOUT_FACTOR!;
  assert.deepEqual(tiers.fastTierHangBoundArgs!({ thresholdMs: 5000, files: {} }), [`--test-timeout=${5000 * factor}`, "--test-force-exit"]);
  assert.deepEqual(tiers.fastTierHangBoundArgs!({ files: {} }), [`--test-timeout=${5000 * factor}`, "--test-force-exit"], "no threshold reads as the default");

  const root = scratchDir("tiers");
  try {
    mkdirSync(join(root, "test"));
    mkdirSync(join(root, "scripts"));
    for (const [rel, body] of Object.entries({
      "test/a.test.ts": PURE,
      "test/b.test.ts": PURE,
      "test/env.test.ts": `${PURE}process.env.X = "1";\n`,
      "test/slow.test.ts": PURE,
    })) {
      writeFileSync(join(root, rel), body);
    }
    writeFileSync(join(root, "scripts", "test-tier-manifest.json"), JSON.stringify({ thresholdMs: 40, files: { "test/slow.test.ts": 9000 } }));

    const fastCalls: string[][] = [];
    assert.equal(tiers.main(["--root", root, "--run", "fast"], { spawn: (_c, args, o) => (fastCalls.push(args), finishJudgedRun(args, o)), env: {} }), 0);
    assert.equal(fastCalls.length, 2, "the pool and the isolated rest");
    for (const args of fastCalls) {
      assert.ok(args.includes(`--test-timeout=${40 * factor}`), args.join(" "));
      assert.ok(args.includes("--test-force-exit"), args.join(" "));
    }
    const unpooled: string[][] = [];
    tiers.main(["--root", root, "--run", "fast"], { spawn: (_c, args) => (unpooled.push(args), { status: 0 }), env: { RMD_TEST_POOL: "0" } });
    assert.ok(unpooled.length === 1 && unpooled[0]!.includes("--test-force-exit"), "the unpooled fast run is bounded too");
    const slowCalls: string[][] = [];
    tiers.main(["--root", root, "--run", "slow"], { spawn: (_c, args) => (slowCalls.push(args), { status: 0 }), env: {} });
    assert.equal(slowCalls.length, 1);
    assert.ok(!slowCalls[0]!.some((a) => a.startsWith("--test-timeout") || a === "--test-force-exit"), "the slow tier keeps its own pace");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hung test under the fast-tier bound fails BY NAME and the run ends, in a pool and per file", () => {
  const dir = scratchDir("hung");
  const hung = join(dir, "hung.test.mjs");
  const fine = join(dir, "fine.test.mjs");
  writeFileSync(hung, [
    `import test from "node:test";`,
    `test("finishes", () => {});`,
    `test("never settles and leaks an interval", async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });`,
    "",
  ].join("\n"));
  writeFileSync(fine, PURE);
  try {
    const bound = tiers.fastTierHangBoundArgs!({ thresholdMs: 20, files: {} });
    for (const isolation of [[pool.POOL_ISOLATION_FLAG], []]) {
      const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...bound, ...isolation, hung, fine], {
        cwd: dir,
        encoding: "utf8",
        env: nestedEnv(),
        timeout: 60_000,
      });
      const label = isolation.length > 0 ? "pool" : "per-file";
      assert.equal(run.signal, null, `${label}: the run was killed by this test's 60 s guard, so the hang held: ${run.stdout}`);
      assert.notEqual(run.status, 0, `${label}: a hung test is a failure`);
      assert.match(run.stdout, /not ok \d+ - never settles and leaks an interval/, `${label}: the hung test is named`);
      assert.match(run.stdout, /test timed out after 480ms/, `${label}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
