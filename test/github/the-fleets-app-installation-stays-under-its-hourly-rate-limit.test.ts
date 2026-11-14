import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import timerPromises from "node:timers/promises";

import { daemonInstallationBudgetWorkerInput, daemonInstallationRegistry, startDaemonInstallationBudget } from "#src/cli/commands/daemon.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { createInstallationBudget, createInstallationBudgetState, GITHUB_WRITE_RESERVE_FRACTION } from "#src/lib/github-installation-budget.js";
import {
  configureGithubInstallationBudget, createGhCallPacer, ghExec, ghExecFile, ghJson, ghJsonAsync, ghTextAsync, githubInstallationBudget,
  GhPaceFloorStandDownError, paceGhEntry, takeGithubBudgetThrottles,
} from "#src/lib/github-transport.js";
import { DEFAULT_HOST_INSTANCE_REGISTRY_PATH, installationConsumers } from "#src/lib/instance-registry.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { fetchOpenPrsRest } from "#src/lib/open-prs-rest.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const INSTALLATION = "155256285";
const START_MS = 1_794_600_000_000;
const RESET_S = START_MS / 1000 + 3600;

/** The host registry's shape: three instances on one installation, one on another, one retired. */
const HOST_REGISTRY = [
  "instances:",
  "  core:", "    repo: remudero", "    github_repo: craigoley/remudero", `    gh_app_installation_id: "${INSTALLATION}"`,
  "  site:", "    repo: remudero-site", "    github_repo: craigoley/remudero-site", `    gh_app_installation_id: "${INSTALLATION}"`,
  "  console:", "    repo: remudero-console", "    github_repo: craigoley/remudero-console", `    gh_app_installation_id: "${INSTALLATION}"`,
  "  other:", "    repo: other", "    github_repo: someone/other", '    gh_app_installation_id: "999"',
  "  old:", "    repo: old", "    github_repo: craigoley/old", "    retired: true", `    gh_app_installation_id: "${INSTALLATION}"`,
  "",
].join("\n");

interface Harness {
  rows: Array<{ step: string; extra?: Record<string, unknown> }>;
  setNow(ms: number): void;
  slept: number[];
  pacer: ReturnType<typeof createGhCallPacer>;
  /** One GitHub response through the real transport parser, with these rate-limit headers. */
  read(remaining: number | undefined, limit?: number, reset?: number): void;
  write(remaining?: number): boolean;
}

function harness(registry: (() => { text: string; source: string } | undefined) = () => ({ text: HOST_REGISTRY, source: "host" }),
  env: NodeJS.ProcessEnv = { GH_APP_INSTALLATION_ID: INSTALLATION, RMD_INSTANCE_NAME: "core" }): Harness {
  let now = START_MS;
  const clock = clockFromMillisFn(() => now);
  const rows: Harness["rows"] = [];
  startDaemonInstallationBudget(registry, env, (step, extra) => rows.push({ step, extra }), clock);
  const slept: number[] = [];
  const pacer = createGhCallPacer({
    minGapMs: 0, rateLimitGapMs: 0, now: () => now, sleepSync: () => {}, sleep: async (ms) => { slept.push(ms); },
  });
  return {
    rows,
    slept,
    pacer,
    setNow: (ms) => { now = ms; },
    read(remaining, limit = 100, reset = RESET_S) {
      const headers = remaining === undefined ? "HTTP/2.0 200 OK" : [
        "HTTP/2.0 200 OK", `X-Ratelimit-Remaining: ${remaining}`, `X-Ratelimit-Limit: ${limit}`,
        `X-Ratelimit-Reset: ${reset}`, "X-Ratelimit-Resource: core",
      ].join("\r\n");
      ghJson(["api", "repos/craigoley/remudero/pulls"], undefined, () => `${headers}\r\n\r\n[]`);
    },
    write(remaining) {
      let ran = false;
      ghJson(["api", "-X", "POST", "repos/craigoley/remudero/issues/1/comments", "-f", "body=x"], undefined, () => {
        ran = true;
        const headers = remaining === undefined ? "" :
          `X-Ratelimit-Remaining: ${remaining}\r\nX-Ratelimit-Limit: 100\r\nX-Ratelimit-Reset: ${RESET_S}\r\nX-Ratelimit-Resource: core\r\n`;
        return `HTTP/2.0 201 Created\r\n${headers}\r\n{}`;
      });
      return ran;
    },
  };
}

/** Reads until the pacer stands down; the count of reads that went ahead. */
function readsUntilStandDown(h: Harness, max = 200): number {
  for (let n = 0; n < max; n++) {
    try {
      h.read(undefined);
    } catch (err) {
      assert.ok(err instanceof GhPaceFloorStandDownError, String(err));
      return n;
    }
  }
  return max;
}

function throttledRows(): Array<{ step: string; extra: Record<string, unknown> }> {
  return takeGithubBudgetThrottles().map(({ step, ...extra }) => ({ step, extra }));
}

afterEach(() => configureGithubInstallationBudget(undefined));

test("W1-T12553 criterion 1: the allowance is the remaining count less the write reserve, shared by the instances and hand runs", async () => {
  const h = harness();
  const configured = h.rows.find((row) => row.step === "github.budget.configured");
  // core, site and console share the installation; "other" is on another one and "old" is retired.
  assert.equal(configured?.extra?.consumers, 4);
  assert.equal(configured?.extra?.outcome, "configured");
  assert.equal(githubInstallationBudget().allowance(), undefined, "no reading yet: no allowance limit");
  h.read(50);
  // floor((50 - 10% of 100) / 4) = 10.
  assert.equal(GITHUB_WRITE_RESERVE_FRACTION, 0.1);
  assert.equal(githubInstallationBudget().allowance(), 10);
  h.read(90, 100);
  assert.equal(githubInstallationBudget().allowance(), 20, "each response's headers give a new reading");
  let argv: string[] = [];
  await ghJsonAsync(["api", "repos/o/r/pulls"], async (_file, args) => {
    argv = [...args];
    return { stdout: `HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 70\r\nX-Ratelimit-Limit: 100\r\nX-Ratelimit-Reset: ${RESET_S}\r\nX-Ratelimit-Resource: core\r\n\r\n[]`, stderr: "" };
  });
  assert.ok(argv.includes("-i"), "the async production transport requests headers without a callback");
  assert.equal(githubInstallationBudget().allowance(), 15);
});

test("W1-T12553 criterion 2: an instance that spent its share waits for the reset, and a larger reading gives a new allowance", async () => {
  const h = harness();
  h.read(50);
  // One instance never spends the installation: 10 reads of the 40 above the reserve, then it stands down.
  assert.equal(readsUntilStandDown(h), 10);
  assert.throws(() => h.pacer.wait(), GhPaceFloorStandDownError, "the synchronous path keeps refusing until the reset");

  await h.pacer.waitAsync!();
  assert.deepEqual(h.slept, [RESET_S * 1000 - START_MS], "the async path awaits a timer to the reset");

  assert.equal(h.write(90), true, "a write still runs and its newer headers restore read allowance");
  assert.equal(readsUntilStandDown(h), 20, "a newer reading with a larger remaining count gives a new allowance");

  h.setNow(RESET_S * 1000 + 1);
  assert.equal(readsUntilStandDown(h), 200, "after the reset the old reading limits nothing");
});

test("W1-T12553 criterion 3: reads stop in the write reserve, and a write never waits on the budget", () => {
  const h = harness();
  h.read(10);
  assert.equal(readsUntilStandDown(h), 0, "remaining 10 of 100 is the reserve: no read goes");
  assert.equal(h.write(), true, "a comment write goes while reads are held back");
  assert.equal(h.write(), true);
  h.write(11);
  assert.equal(readsUntilStandDown(h), 0, "one above the reserve shares to zero reads");
  const throttled = throttledRows();
  assert.deepEqual(throttled.map((row) => row.extra?.reason), ["reserve"], "one row for the window");
});

test("W1-T12553 criterion 2 and criterion 3: a paced PR listing admits each REST read and stops at the share or reserve", () => {
  const run = (remaining: number) => {
    harness();
    const calls: string[] = [];
    const prs = fetchOpenPrsRest("o", "r", (args, onRateLimit) => ghJson(args, onRateLimit, (_file, argv) => {
      calls.push(args[1]);
      assert.ok(argv.includes("-i"));
      const body = args[1].includes("/pulls?")
        ? JSON.stringify([{ number: 1, html_url: "u", updated_at: "t", head: { ref: "b", sha: "sha" } }])
        : JSON.stringify({ check_runs: [] });
      const headers = calls.length === 1
        ? `X-Ratelimit-Remaining: ${remaining}\r\nX-Ratelimit-Limit: 100\r\nX-Ratelimit-Reset: ${RESET_S}\r\nX-Ratelimit-Resource: core\r\n`
        : "";
      return `HTTP/2.0 200 OK\r\n${headers}\r\n${body}`;
    }));
    assert.equal(prs[0]?.rollupUnreadable, true);
    return calls;
  };
  assert.equal(run(14).length, 2, "one rollup read spends the sole share; status cannot run");
  assert.equal(run(10).length, 1, "at the reserve, neither check-runs nor status can run");
});

test("W1-T12553 criterion 4: one throttle row per consumer and reset window, and a GitHub refusal writes one too", () => {
  const h = harness();
  h.read(50);
  readsUntilStandDown(h);
  assert.throws(() => h.pacer.wait(), GhPaceFloorStandDownError);
  assert.throws(() => h.pacer.wait(), GhPaceFloorStandDownError);
  githubInstallationBudget().noteThrottle("refused");
  const throttled = throttledRows();
  assert.equal(throttled.length, 1, "three refusals in one window write one row");
  assert.deepEqual(throttled[0].extra, {
    instance: "core", reason: "refused", remaining: 50, limit: 100, reset: "2026-11-13T21:00:00.000Z", allowance: 10, consumers: 4,
  });

  const shareOnly = harness();
  shareOnly.read(14);
  readsUntilStandDown(shareOnly);
  assert.equal(throttledRows()[0]?.extra.reason, "share");

  const fresh = harness();
  const limited = new Error("API rate limit exceeded for installation ID 155256285");
  for (let n = 0; n < 2; n++) {
    assert.throws(() => paceGhEntry(fresh.pacer, () => true, () => { throw limited; }, { maxAttempts: 1 }), /rate limit exceeded/);
  }
  const refused = throttledRows();
  assert.deepEqual(refused.map((row) => row.extra), [{ instance: "core", reason: "refused", consumers: 4 }],
    "two refusals in one window write one row");

  harness();
  const transportRefusal = Object.assign(new Error("gh api failed"), { stderr: "API rate limit exceeded" });
  assert.throws(() => ghJson(["api", "repos/o/r/pulls"], undefined, () => { throw transportRefusal; }), /gh api failed/);
  assert.equal(throttledRows()[0]?.extra.reason, "refused", "a direct transport refusal also reaches the daemon drain");
});

test("W1-T12553 criterion 5: with no reading, no headers or no registry the pacer behaves as before; the daemon start sets the budget", () => {
  const noReading = harness();
  assert.equal(readsUntilStandDown(noReading), 200, "no reading yet: no allowance limit");
  noReading.read(undefined);
  assert.equal(readsUntilStandDown(noReading), 200, "no rate-limit headers: no allowance limit");

  const unreadable = harness(() => { throw new Error("EACCES: permission denied"); });
  assert.deepEqual(unreadable.rows.find((row) => row.step === "github.budget.configured")?.extra,
    { outcome: "unconfigured", instance: "core", reason: "registry_unreadable", installation_id: INSTALLATION, error: "EACCES: permission denied" });
  unreadable.read(50);
  assert.equal(readsUntilStandDown(unreadable), 200, "an unreadable registry sets no budget");

  const missing = harness(() => undefined);
  assert.equal(missing.rows.find((row) => row.step === "github.budget.configured")?.extra?.reason, "registry_unreadable");
  const noInstallation = harness(undefined, { RMD_INSTANCE_NAME: "core" });
  assert.equal(noInstallation.rows.find((row) => row.step === "github.budget.configured")?.extra?.reason, "no_installation_id");
  const elsewhere = harness(undefined, { GH_APP_INSTALLATION_ID: "123", RMD_INSTANCE_NAME: "core" });
  assert.equal(elsewhere.rows.find((row) => row.step === "github.budget.configured")?.extra?.reason, "no_instance_on_installation");

  // Omitted IDs do not establish which installation the instances use.
  const checkout = harness(() => ({
    text: HOST_REGISTRY.replace(/^ {4}gh_app_installation_id: .*\n/gm, ""), source: "checkout",
  }));
  assert.equal(checkout.rows.find((row) => row.step === "github.budget.configured")?.extra?.reason, "no_instance_on_installation");

  // The daemon start sets the budget; a pacer made anywhere in the process reads it.
  const shared = harness();
  const elsewherePacer = createGhCallPacer({ minGapMs: 0, sleepSync: () => {} });
  ghJson(["api", "rate_limit"], undefined, () =>
    `HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 14\r\nX-Ratelimit-Limit: 100\r\nX-Ratelimit-Reset: ${RESET_S}\r\nX-Ratelimit-Resource: core\r\n\r\n{}`);
  shared.read(undefined);
  assert.throws(() => elsewherePacer.wait(), GhPaceFloorStandDownError, "floor((14 - 10) / 4) = 1 read");
});

test("W1-T12553 criterion 5: the production read worker shares the main thread's installation allowance", async () => {
  harness();
  const config = daemonInstallationBudgetWorkerInput();
  assert.ok(config?.state instanceof SharedArrayBuffer);
  const reset = Math.floor(Date.now() / 1000) + 3600;
  githubInstallationBudget().record({ remaining: 14, limit: 100, reset, resource: "core" });
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { register } = await import(workerData.tsx); register();
      const transport = await import(workerData.entry);
      const before = transport.githubInstallationBudget().consumers;
      transport.ghJson(['api', 'repos/o/r/pulls'], undefined, () => 'HTTP/2.0 200 OK\\r\\n\\r\\n[]');
      let stoodDown = false;
      try { transport.ghJson(['api', 'repos/o/r/pulls'], undefined, () => '[]'); }
      catch (error) { stoodDown = error instanceof transport.GhPaceFloorStandDownError; }
      parentPort.postMessage({ pid: process.pid, before, stoodDown });
    })().catch((error) => parentPort.postMessage({ error: String(error) }));
  `, {
    eval: true,
    workerData: { entry: pathToFileURL(join(REPO_ROOT, "src/lib/github-transport.ts")).href,
      tsx: import.meta.resolve("tsx/esm/api"),
      input: { githubInstallationBudget: config } },
  });
  const outcome = await new Promise<{ pid?: number; before?: number; stoodDown?: boolean; error?: string }>((resolve, reject) => {
    worker.once("message", resolve); worker.once("error", reject);
  });
  await worker.terminate();
  assert.deepEqual(outcome, { pid: process.pid, before: 4, stoodDown: true });
  assert.equal(githubInstallationBudget().admit().ok, false, "the main thread sees the worker's read");
  assert.equal(throttledRows()[0]?.extra.reason, "share", "the worker's row drains on the main thread");
});


test("W1-T12553 criterion 1: omitted and empty installation IDs never match an unrelated installation", () => {
  const registry = [
    "instances:", "  omitted:", "    repo: acme/omitted",
    "  empty:", "    repo: acme/empty", '    gh_app_installation_id: ""',
    "  explicit:", "    repo: acme/explicit", `    gh_app_installation_id: "${INSTALLATION}"`,
  ].join("\n");
  assert.equal(installationConsumers(registry, "999"), undefined);
  assert.equal(installationConsumers(registry, ""), undefined);
  assert.equal(installationConsumers(registry, INSTALLATION), 2, "one matching instance and one hand-run share");
});

test("W1-T12553 criterion 2 and criterion 3: direct and paced ghExecFile reads spend exactly once and writes bypass the reserve", async () => {
  await withGhShim([{ when: "api", stdout: "[]" }], shim => {
    const h = harness();
    const args = ["api", "repos/o/r/commits/head/status"];
    const opts = { encoding: "utf8" as const };
    const reads = [
      () => ghExecFile("gh", args, opts),
      () => ghExecFile(join(shim.dir, "gh"), args, opts),
      () => paceGhEntry(h.pacer, () => false, () => ghExecFile("gh", args, opts)),
      () => ghExec(args, opts),
      () => ghExecFile("gh", ["pr", "diff", "1", "--repo", "o/r"], opts),
      () => ghExec(["pr", "diff", "1", "--repo", "o/r"], opts),
    ];
    const savedGap = process.env.RMD_GH_SHARED_READ_GAP_MS;
    const savedCache = process.env.RMD_GH_CACHE_HOME;
    process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
    process.env.RMD_GH_CACHE_HOME = join(shim.dir, "cache");
    try {
      for (const read of reads) {
        h.write(18); // floor((18 - 10) / 4) = two reads.
        const before = shim.calls().length;
        read();
        assert.equal(githubInstallationBudget().admit().ok, true, "the first call spends only one admission");
        read();
        assert.throws(read, GhPaceFloorStandDownError);
        assert.equal(shim.calls().length - before, 2, "the refused call never spawns gh");
        h.write(10);
        assert.throws(read, GhPaceFloorStandDownError, "the reserve blocks the first read, too");
      }
      for (const write of [
        ["api", "-X", "POST", "repos/o/r/issues/1/comments", "-f", "body=x"],
        ["pr", "merge", "1"], ["pr", "review", "1", "--approve"],
        ["api", "-X", "POST", "repos/o/r/statuses/head", "-f", "state=success"],
      ]) {
        ghExecFile("gh", write, opts);
        ghExec(write, opts);
      }
      const headers = `HTTP/2.0 201 Created\r\nX-Ratelimit-Remaining: 18\r\nX-Ratelimit-Limit: 100\r\nX-Ratelimit-Reset: ${RESET_S}\r\nX-Ratelimit-Resource: core\r\n\r\n{}`;
      shim.addRoute({ when: "headers", stdout: headers });
      const meteredWrite = ["api", "-X", "POST", "repos/o/r/headers", "-i"];
      assert.equal(ghExecFile("gh", meteredWrite, opts).trimEnd(), headers);
      assert.equal(githubInstallationBudget().allowance(), 2, "direct subprocess headers refresh the allowance");
      assert.equal(ghExec(meteredWrite, opts).trimEnd(), headers);
      assert.equal(ghExecFile(process.execPath, ["-e", "process.stdout.write('local')"], opts), "local");
      shim.addRoute({ when: "api", stderr: "API rate limit exceeded", exit: 1 });
      h.write(90);
      assert.throws(() => ghExecFile("gh", args, opts), /rate limit exceeded/);
      assert.equal(throttledRows()[0]?.extra.reason, "refused");
    } finally {
      if (savedGap === undefined) delete process.env.RMD_GH_SHARED_READ_GAP_MS;
      else process.env.RMD_GH_SHARED_READ_GAP_MS = savedGap;
      if (savedCache === undefined) delete process.env.RMD_GH_CACHE_HOME;
      else process.env.RMD_GH_CACHE_HOME = savedCache;
    }
  });
});

test("W1-T12553 criterion 4: consecutive windows retain every undrained throttle across shared consumers", () => {
  const state = createInstallationBudgetState();
  const clock = clockFromMillisFn(() => START_MS);
  const main = createInstallationBudget({ consumers: 4, instance: "core", clock, sharedState: state });
  const worker = createInstallationBudget({ consumers: 4, instance: "core", clock, sharedState: state });
  for (let n = 0; n < 12; n++) {
    worker.record({ remaining: 10, limit: 100, reset: RESET_S + n * 3600, resource: "core" });
    worker.noteThrottle("reserve");
    main.noteThrottle("reserve");
  }
  worker.noteThrottle("refused");
  const rows = main.takeThrottleRows();
  assert.equal(rows.length, 12, "pending evidence outlives the recent-window deduplication history");
  assert.deepEqual(rows.map(row => row.reset), Array.from({ length: 12 }, (_, n) =>
    clockFromMillisFn(() => (RESET_S + n * 3600) * 1000).iso()));
  assert.deepEqual(rows.map(row => row.reason), [...Array(11).fill("reserve"), "refused"]);
  assert.ok(rows.every(row => row.remaining === 10 && row.limit === 100 && row.allowance === 0 && row.consumers === 4));
  assert.deepEqual(worker.takeThrottleRows(), []);
  worker.noteThrottle("reserve");
  assert.deepEqual(main.takeThrottleRows(), [], "draining does not allow duplicates in the same window");

  const local = createInstallationBudget({ consumers: 4, instance: "core", clock });
  for (let n = 0; n < 2; n++) {
    local.record({ remaining: 10, limit: 100, reset: RESET_S + n * 3600 });
    local.noteThrottle("reserve");
  }
  assert.equal(local.takeThrottleRows().length, 2, "an unshared budget also retains distinct pending windows");
});

test("W1-T12553 criterion 5: the actual host-registry read propagates failure and startup logs why", t => {
  const originalRead = fs.readFileSync;
  const attempted: unknown[] = [];
  const failure = Object.assign(new Error("EACCES: host registry denied"), { code: "EACCES" });
  t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    attempted.push(args[0]);
    if (args[0] === DEFAULT_HOST_INSTANCE_REGISTRY_PATH) throw failure;
    return originalRead(...args);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  try {
    const h = harness(() => daemonInstallationRegistry(REPO_ROOT));
    assert.deepEqual(h.rows[0]?.extra, {
      outcome: "unconfigured", instance: "core", reason: "registry_unreadable",
      installation_id: INSTALLATION, error: failure.message,
    });
    assert.deepEqual(attempted, [DEFAULT_HOST_INSTANCE_REGISTRY_PATH], "no checkout fallback hides host read errors");
    assert.equal(daemonInstallationBudgetWorkerInput(), undefined);
    h.read(10);
    assert.equal(readsUntilStandDown(h), 200);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("W1-T12553 criterion 1: failed responses refresh remaining, limit and reset before the refusal is drained", async () => {
  const reset = RESET_S + 3600;
  const stdout = `HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Limit: 200\r\nX-Ratelimit-Reset: ${reset}\r\nX-Ratelimit-Resource: core\r\n\r\n{}`;
  for (const output of [stdout, Buffer.from(stdout), `[${stdout}]`]) {
    for (const run of [
      (error: Error) => ghJson(["api", "repos/o/r/pulls"], undefined, () => { throw error; }),
      (error: Error) => ghJsonAsync(["api", "repos/o/r/pulls"], async () => { throw error; }),
      (error: Error) => ghTextAsync(["api", "repos/o/r/pulls", "-i"], {}, async () => { throw error; }),
    ]) {
      const h = harness();
      h.read(14);
      assert.equal(githubInstallationBudget().allowance(), 1);
      const error = Object.assign(new Error("gh api failed"), { stdout: output, stderr: "API rate limit exceeded", status: 403 });
      let caught: unknown;
      try { await run(error); } catch (failure) { caught = failure; }
      assert.equal(caught, error, "header capture preserves the original failure");
      assert.equal(githubInstallationBudget().allowance(), 0);
      const decision = githubInstallationBudget().admit();
      assert.equal(decision.ok, false);
      if (!decision.ok) assert.equal(decision.waitUntil, reset);
      assert.deepEqual(throttledRows()[0]?.extra, {
        instance: "core", reason: "refused", remaining: 0, limit: 200,
        reset: clockFromMillisFn(() => reset * 1000).iso(), allowance: 0, consumers: 4,
      });
    }
  }
});

test("W1-T12553 criterion 1: real synchronous subprocess failures retain their response headers", async () => {
  const stdout = `HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Limit: 100\r\nX-Ratelimit-Reset: ${RESET_S + 3600}\r\nX-Ratelimit-Resource: core\r\n\r\n{}`;
  await withGhShim([{ when: "api", stdout, stderr: "API rate limit exceeded", exit: 1 }], shim => {
    const env = { ...process.env, RMD_GH_SHARED_READ_GAP_MS: "0", RMD_GH_CACHE_HOME: join(shim.dir, "cache") };
    for (const run of [
      () => ghExec(["api", "repos/o/r/pulls", "-i"], { encoding: "utf8", env }),
      () => ghExecFile("gh", ["api", "repos/o/r/pulls", "-i"], { encoding: "utf8", env }),
    ]) {
      harness().read(14);
      assert.throws(run, /rate limit exceeded/);
      assert.equal(githubInstallationBudget().allowance(), 0);
      assert.equal(throttledRows()[0]?.extra.reset, clockFromMillisFn(() => (RESET_S + 3600) * 1000).iso());
    }
  });
});

test("W1-T12553 criterion 2 and criterion 3: porcelain reads spend the share and await reset at the reserve", async t => {
  let now = START_MS;
  let wake: (() => void) | undefined;
  const waits: number[] = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(timerPromises, "setTimeout", ((ms: number) => {
    waits.push(ms);
    return new Promise<void>(resolve => { wake = resolve; });
  }) as typeof timerPromises.setTimeout);
  syncBuiltinESMExports();
  try {
    for (const remaining of [14, 10]) {
      now = START_MS;
      waits.length = 0;
      const h = harness();
      h.read(remaining);
      let calls = 0;
      const read = () => ghTextAsync(["pr", "diff", "1", "--repo", "o/r"], {}, async () => {
        calls += 1;
        return { stdout: "diff", stderr: "" };
      });
      if (remaining === 14) assert.equal(await read(), "diff");
      const pending = read();
      await new Promise<void>(resolve => setImmediate(resolve));
      const beforeReset = calls;
      h.setNow(now = RESET_S * 1000 - 1);
      await new Promise<void>(resolve => setImmediate(resolve));
      const justBeforeReset = calls;
      h.setNow(now = RESET_S * 1000);
      wake?.();
      assert.equal(await pending, "diff");
      assert.equal(beforeReset, remaining === 14 ? 1 : 0, "the executor stays idle while the event loop continues");
      assert.equal(justBeforeReset, beforeReset, "the read cannot start even one millisecond before reset");
      assert.equal(calls, beforeReset + 1);
      assert.deepEqual(waits, [RESET_S * 1000 - START_MS], "the transport awaits a timer for the complete reset interval");
      assert.equal(throttledRows()[0]?.extra.reason, remaining === 14 ? "share" : "reserve");
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("W1-T12553 criterion 3: synchronous porcelain reads stand down while async writes keep their reserve", async () => {
  const h = harness();
  h.read(10);
  let reads = 0;
  assert.throws(() => ghJson(["pr", "view", "1", "--json", "number"], undefined, () => {
    reads += 1;
    return "{}";
  }), GhPaceFloorStandDownError);
  assert.equal(reads, 0);
  for (const args of [
    ["pr", "merge", "1"], ["pr", "review", "1", "--approve"], ["pr", "comment", "1", "--body", "ok"],
    ["api", "-X", "POST", "repos/o/r/statuses/head", "-f", "state=success"],
  ]) {
    let writes = 0;
    assert.equal(await ghTextAsync(args, {}, async () => { writes += 1; return { stdout: "ok", stderr: "" }; }), "ok");
    assert.equal(writes, 1);
  }
  assert.equal(githubInstallationBudget().admit().ok, false, "writes do not grant or spend read allowance");
});

test("W1-T12553 criterion 4: a refusal survives an already drained window and is emitted only once", async t => {
  for (const sharedState of [undefined, createInstallationBudgetState()]) {
    await t.test(sharedState === undefined ? "local" : "shared worker", () => {
      const clock = clockFromMillisFn(() => START_MS);
      const budget = createInstallationBudget({ consumers: 4, instance: "core", clock, sharedState });
      const writer = sharedState === undefined ? budget : createInstallationBudget({ consumers: 4, instance: "core", clock, sharedState });
      writer.record({ remaining: 14, limit: 100, reset: RESET_S });
      writer.noteThrottle("share");
      assert.equal(budget.takeThrottleRows()[0]?.reason, "share");
      writer.noteThrottle("share");
      assert.deepEqual(budget.takeThrottleRows(), []);
      writer.noteThrottle("refused");
      assert.deepEqual(budget.takeThrottleRows(), [{
        step: "github.budget.throttled", instance: "core", reason: "refused", remaining: 14,
        limit: 100, reset: clockFromMillisFn(() => RESET_S * 1000).iso(), allowance: 1, consumers: 4,
      }]);
      writer.noteThrottle("refused");
      writer.noteThrottle("reserve");
      assert.deepEqual(budget.takeThrottleRows(), [], "the refusal and ordinary throttle both stay deduplicated");
      writer.record({ remaining: 14, limit: 100, reset: RESET_S + 3600 });
      writer.noteThrottle("share");
      writer.noteThrottle("refused");
      assert.equal(budget.takeThrottleRows()[0]?.reason, "refused", "an undrained row is upgraded");
      writer.noteThrottle("refused");
      assert.deepEqual(budget.takeThrottleRows(), [], "upgrading also records that the refusal was emitted");
    });
  }
});
