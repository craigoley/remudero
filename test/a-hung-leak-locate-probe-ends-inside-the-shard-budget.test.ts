/**
 * W1-T9426 — 2026-10-14, #11629's ci-shard (1/8): every test passed (1358/1358) by 10:37Z, then the
 * pure-test pool's leak locator ran probe 11 for 18 minutes and the job's 35-minute cancel read the
 * finished shard as SHARD HANG.
 *
 * Pinned here: a locate probe gets the full pool run's measured wall time as its deadline and a probe
 * past it ends location; a probe starts only while the job's remaining time fits one; either way the
 * shard's already-final status comes back. scripts/pure-test-pool.mjs, runShardWithPool.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { finishJudgedRun } from "./helpers/judged-pool-run.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type RunOpts = { pool: boolean; quiet?: boolean; role: string; deadlineMs?: number };
type RunStatus = number | string;
type PoolDefect = null | { leaker: string | null; victim: string | null; stopped?: true; narrowed?: string[] };
const pool = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "pure-test-pool.mjs")).href)) as {
  POOL_ISOLATION_FLAG: string;
  RUN_PAST_DEADLINE?: string;
  runShardWithPool: (
    files: string[],
    opts: {
      fast: string[];
      readFile?: (path: string) => string;
      run: (files: string[], opts: RunOpts) => RunStatus;
      log?: (line: string) => void;
      now?: () => number;
      env?: NodeJS.ProcessEnv;
    },
  ) => { status: number; poolDefect: PoolDefect };
  spawnJudgedRun: (
    files: string[],
    opts: { spawn: typeof spawnSync; cwd: string; args: string[]; pool: boolean; quiet?: boolean; role: string; log?: (line: string) => void; env?: NodeJS.ProcessEnv; deadlineMs?: number },
  ) => RunStatus;
};
const tiers = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "test-tier-manifest.mjs")).href)) as {
  main: (
    argv: string[],
    opts: { spawn: (cmd: string, args: string[], o?: Record<string, unknown>) => { status: number | null }; env?: NodeJS.ProcessEnv; log?: (line: string) => void },
  ) => number;
};

const PURE = `import test from "node:test";\ntest("x", () => {});\n`;
const POOLED = Array.from({ length: 224 }, (_, i) => `test/f${String(i).padStart(3, "0")}.test.ts`);
const LEAKER = POOLED[37]!;
const VICTIM = POOLED[150]!;
const SHARD = [...POOLED, "test/spawner.test.ts"];
const sourceOf = (p: string) => (p.endsWith("spawner.test.ts") ? `${PURE}spawnSync("ls");\n` : PURE);
const leaks = (files: string[]) => files.includes(LEAKER) && files.includes(VICTIM);

const POOL_MS = 240_000;
const PROBE_MS = 60_000;

/**
 * A shard whose pool fails, whose isolated re-run and rest pass, and whose probes take PROBE_MS on a
 * fake clock. Probe `hangAt` never returns before its deadline: given one, the clock moves to it and
 * the run reports itself killed; given none, it would block until the job's cancel, so it throws.
 */
function shard({ hangAt, env = {}, startAt = 0 }: { hangAt?: number; env?: NodeJS.ProcessEnv; startAt?: number }) {
  let clock = startAt;
  const roles: string[] = [];
  const probes: Array<{ files: number; deadlineMs?: number; leftMs: number }> = [];
  const log: string[] = [];
  const cancelAt = env.RMD_JOB_STARTED_MS ? Number(env.RMD_JOB_STARTED_MS) + Number(env.RMD_JOB_TIMEOUT_MINUTES) * 60_000 : Infinity;
  const result = pool.runShardWithPool(SHARD, {
    fast: SHARD,
    readFile: sourceOf,
    env,
    now: () => clock,
    log: (line) => log.push(line),
    run: (files, opts) => {
      roles.push(opts.role);
      if (opts.role === "pool") {
        clock += POOL_MS;
        return 1;
      }
      if (opts.role !== "locate") return 0;
      probes.push({ files: files.length, deadlineMs: opts.deadlineMs, leftMs: cancelAt - clock });
      if (probes.length === hangAt) {
        if (!(typeof opts.deadlineMs === "number" && opts.deadlineMs > 0)) {
          throw new Error(`locate probe ${probes.length} was given no deadline: it would hold the shard until the job's cancel`);
        }
        clock += opts.deadlineMs;
        return pool.RUN_PAST_DEADLINE ?? 1;
      }
      clock += PROBE_MS;
      return leaks(files) ? 1 : 0;
    },
  });
  return { result, roles, probes, log, clock };
}

test("W1-T9426: a locate probe past the full pool run time is killed and ends the search", () => {
  const { result, probes, log } = shard({ hangAt: 3 });
  assert.equal(probes.length, 3, `no probe may start after the hung one: ${log.join("\n")}`);
  for (const probe of probes) assert.equal(probe.deadlineMs, POOL_MS, "a probe's deadline is the full pool run's measured wall time");
  const hung = log.find((line) => line.includes("locate probe 3 HUNG"));
  assert.ok(hung, log.join("\n"));
  assert.match(hung, new RegExp(`\\(${probes[2]!.files} file\\(s\\) ending test/f\\d{3}\\.test\\.ts\\): killed at its 240s deadline`));
  const defect = result.poolDefect!;
  assert.equal(defect.leaker, null);
  assert.equal(defect.stopped, true);
  assert.ok(defect.narrowed!.includes(LEAKER) && defect.narrowed!.includes(VICTIM), "the files the search narrowed to still hold the leak");
  assert.ok(defect.narrowed!.length < POOLED.length, "two probes had already narrowed the pool");
  assert.match(log.at(-1)!, /leaking file: not isolated to one file after 3 probe\(s\); location stopped, the leak lies among these \d+ file\(s\)/);

  // Control: with no hung probe the same search runs to the leaker, so the stop above is the deadline's.
  const clean = shard({});
  assert.deepEqual(clean.result.poolDefect, { leaker: LEAKER, victim: VICTIM });
  assert.ok(clean.probes.length > 3);
});

test("W1-T9426: a hung locate probe leaves the shard status final and green", () => {
  const startAt = 1_000_000;
  const env = { RMD_JOB_STARTED_MS: String(startAt - 300_000), RMD_JOB_TIMEOUT_MINUTES: "35" };
  const cancelAt = startAt - 300_000 + 35 * 60_000;
  const { result, roles, clock, log } = shard({ hangAt: 5, env, startAt });
  assert.equal(result.status, 0, "every test passed; a diagnostic of the pool must not turn that red");
  assert.deepEqual(roles.slice(0, 3), ["pool", "rerun", "rest"], "the verdict was final before location began");
  assert.equal(roles.filter((r) => r === "locate").length, 5);
  assert.ok(clock < cancelAt, `the shard returned at ${clock}, before the job's cancel at ${cancelAt}`);
  assert.match(log.join("\n"), /POOL DEFECT .*not isolated to one file/);
});

test("W1-T9426: no probe starts once the remaining job budget cannot fit one", () => {
  // The job started 25 min before the pool; the pool takes 4 min, so 6 min (360 s) is left after it.
  const startAt = 5_000_000;
  const started = startAt - 25 * 60_000;
  const env = { RMD_JOB_STARTED_MS: String(started), RMD_JOB_TIMEOUT_MINUTES: "35" };
  const cancelAt = started + 35 * 60_000;

  const { result, probes, log, clock } = shard({ env, startAt });
  assert.equal(result.status, 0);
  // Before any probe the estimate is the pool's 240 s; 360 s cannot hold it twice, so nothing starts.
  assert.equal(probes.length, 0, log.join("\n"));
  assert.match(log.join("\n"), /locate probe 1 NOT STARTED \(\d+ file\(s\) ending test\/f\d{3}\.test\.ts\): the job has 360s left/);
  assert.equal(result.poolDefect?.stopped, true);
  assert.deepEqual(result.poolDefect?.narrowed, POOLED, "nothing was narrowed, so the whole pool still holds the leak");
  assert.ok(clock <= cancelAt);

  // With 9 min left after the pool, probes run, each measured at 60 s, until two no longer fit: the
  // first is judged against the pool's 240 s (540 s holds it twice), each later one against 60 s.
  const leftAfterPoolMs = 540_000;
  const roomy = { RMD_JOB_STARTED_MS: String(startAt + POOL_MS + leftAfterPoolMs - 35 * 60_000), RMD_JOB_TIMEOUT_MINUTES: "35" };
  const later = shard({ env: roomy, startAt });
  const fits = Math.floor((leftAfterPoolMs - 2 * PROBE_MS) / PROBE_MS) + 1;
  assert.ok(shard({}).probes.length > fits, "control: the unbounded search needs more probes than the budget holds");
  assert.equal(later.probes.length, fits, later.log.join("\n"));
  for (const probe of later.probes) {
    assert.ok(probe.deadlineMs! + PROBE_MS <= probe.leftMs, `a probe's deadline leaves the job room to finish: ${JSON.stringify(probe)}`);
  }
  assert.match(later.log.join("\n"), new RegExp(`locate probe ${fits + 1} NOT STARTED .*the job has ${(leftAfterPoolMs - fits * PROBE_MS) / 1000}s left`));
  assert.equal(later.result.status, 0);
  assert.ok(later.clock < startAt + POOL_MS + leftAfterPoolMs, "the shard ended before the job's cancel");
});

test("W1-T9426: a judged run still going at its deadline is killed and reported past its deadline", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9426-hang-`));
  try {
    const file = join(dir, "hangs.test.mjs");
    writeFileSync(file, `import test from "node:test";\ntest("never settles", async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: "" };
    delete env.NODE_TEST_CONTEXT;
    const log: string[] = [];
    const status = pool.spawnJudgedRun([file], {
      // This test's own 60 s guard; the run's deadline, when it passes one, overrides it.
      spawn: ((cmd: string, args: string[], opts: object) => spawnSync(cmd, args, { timeout: 60_000, ...opts })) as typeof spawnSync,
      cwd: dir,
      args: ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", pool.POOL_ISOLATION_FLAG],
      pool: true,
      quiet: true,
      role: "locate",
      log: (line) => log.push(line),
      env,
      deadlineMs: 1500,
    });
    assert.equal(status, pool.RUN_PAST_DEADLINE, log.join("\n"));
    assert.match(log.join("\n"), /LOCATE RUN FAILED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The fast tier over fixtures a-d whose pool fails whenever b and c share it, every pool line in `log`. */
function fixtureFastTier(log: (line: string) => void) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9426-tier-`));
  try {
    mkdirSync(join(root, "test"));
    mkdirSync(join(root, "scripts"));
    for (const name of ["a", "b", "c", "d"]) writeFileSync(join(root, "test", `${name}.test.ts`), PURE);
    writeFileSync(join(root, "scripts", "test-tier-manifest.json"), JSON.stringify({ thresholdMs: 40, files: {} }));
    const probeOpts: Array<Record<string, unknown>> = [];
    const status = tiers.main(["--root", root, "--run", "fast"], {
      env: {},
      log,
      spawn: (_cmd, args, opts) => {
        const pooled = args.includes(pool.POOL_ISOLATION_FLAG);
        if (pooled && opts?.stdio === "ignore") probeOpts.push(opts);
        const fails = pooled && args.some((a) => a.endsWith("b.test.ts")) && args.some((a) => a.endsWith("c.test.ts"));
        return finishJudgedRun(args, opts, fails ? 1 : 0);
      },
    });
    return { status, probeOpts };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T9426: the fast tier hands every locate probe a SIGKILL deadline", () => {
  const { status, probeOpts } = fixtureFastTier(() => {});
  assert.equal(status, 0);
  assert.ok(probeOpts.length > 0, "the pool failed and the isolated re-run passed, so location ran");
  for (const opts of probeOpts) {
    assert.ok(typeof opts.timeout === "number" && opts.timeout > 0, JSON.stringify(opts.timeout));
    assert.equal(opts.killSignal, "SIGKILL");
  }
});

// W1-T10171: before `main` took a `log`, this fixture's POOL DEFECT verdict ("leaking file: test/b.test.ts
// (first failing alongside it: test/c.test.ts)") reached every CI log that ran this file, and the gardener
// and the sweep read it as that shard's failure.
test("W1-T10171: a fast-tier fixture run sends its pool lines to its log sink, never the process stderr", () => {
  const sink: string[] = [];
  const stderr: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr.push(String(chunk));
    return (write as (...a: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  let status: number;
  try {
    status = fixtureFastTier((line) => sink.push(line)).status;
  } finally {
    process.stderr.write = write;
  }
  assert.equal(status, 0);
  assert.match(sink.join("\n"), /^pure-test-pool: POOL DEFECT\b.*leaking file: /m, "the verdict reached the sink");
  assert.match(sink.join("\n"), /^pure-test-pool: pool run complete\b/m, "the judged runs' lines reached the sink too");
  assert.deepEqual(stderr.filter((chunk) => chunk.includes("pure-test-pool:")), [], "no pool line reached the process stderr");
});
