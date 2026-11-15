// W1-T12820: with the installation exhausted at the core daemon's 02:56Z restart on 2026-11-15, the first
// tick's read slept to the 03:09Z reset and the tick awaited it, so no sweep ran for 24 minutes. A refused read
// now waits at most the daemon's poll interval for the reset; past it the read stands down, and the tick and the
// sweep go on with a partial pass. The pacer no longer asks the budget without an argv.
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import timerPromises from "node:timers/promises";

import { daemonInstallationBudgetWorkerInput, startDaemonInstallationBudget } from "#src/cli/commands/daemon.js";
import type { daemonCommand as daemonImplementation } from "#src/cli/commands/daemon.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { DaemonSummary, LightPassScope } from "#src/lib/daemon.js";
import { installationBudgetForThread } from "#src/lib/github-installation-budget.js";
import {
  configureGithubInstallationBudget, createGhCallPacer, ghJson, ghJsonAsync, ghTextAsync, githubInstallationBudget,
  GhPaceFloorStandDownError, paceGhEntry, paceGhEntryAsync, takeGithubBudgetThrottles,
} from "#src/lib/github-transport.js";
import { DEFAULT_HOST_INSTANCE_REGISTRY_PATH } from "#src/lib/instance-registry.js";
import type { SweepDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";
import { buildSweepLightHook } from "#test/helpers/run-task-test.js";

const INSTALLATION = "155256285";
const START_MS = 1_794_715_000_000;
const HOUR_S = 3600;
/** The daemon's poll interval, as the daemon passes it: the wait bound. */
const POLL_MS = 60_000;
const REGISTRY = [
  "instances:",
  "  core:", "    repo: remudero", "    github_repo: craigoley/remudero", `    gh_app_installation_id: "${INSTALLATION}"`,
  "  site:", "    repo: remudero-site", "    github_repo: craigoley/remudero-site", `    gh_app_installation_id: "${INSTALLATION}"`,
  "",
].join("\n");
const ENV = { GH_APP_INSTALLATION_ID: INSTALLATION, RMD_INSTANCE_NAME: "core" };
const OK = { stdout: "HTTP/2.0 200 OK\r\n\r\n[]", stderr: "" };

afterEach(() => configureGithubInstallationBudget(undefined));

/** The budget the daemon's start sets, on a fake clock, with the installation at 0 of 15000 until `resetS`; null: no bound. */
function exhausted(resetS: number, bound: number | null = POLL_MS): { now: { ms: number } } {
  const now = { ms: START_MS };
  startDaemonInstallationBudget(() => ({ text: REGISTRY, source: "host" }), ENV, () => {},
    clockFromMillisFn(() => now.ms), "craigoley/remudero", bound ?? undefined);
  githubInstallationBudget().record({ remaining: 0, limit: 15000, reset: resetS, resource: "core" });
  takeGithubBudgetThrottles();
  return { now };
}

/** Every transport timer, recorded; each one moves the fake clock on by its length and resolves at once. */
function recordTimers(t: TestContext, now?: { ms: number }): number[] {
  const waits: number[] = [];
  t.mock.method(timerPromises, "setTimeout", (async (ms: number) => {
    waits.push(ms);
    if (now) now.ms += ms;
  }) as typeof timerPromises.setTimeout);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return waits;
}

test("W1-T12820 criterion 1: a reset past the bound stands the async read down with its reading, and no timer runs", async (t) => {
  const waits = recordTimers(t);
  exhausted(START_MS / 1000 + HOUR_S);
  let calls = 0;
  const exec = async () => { calls += 1; return OK; };
  for (const read of [
    () => ghJsonAsync(["api", "repos/o/r/pulls"], exec),
    () => ghTextAsync(["pr", "diff", "1", "--repo", "o/r"], {}, exec),
  ]) {
    await assert.rejects(read(), (err: unknown) => {
      assert.ok(err instanceof GhPaceFloorStandDownError, String(err));
      assert.equal(err.resource, "core");
      assert.equal(err.remaining, 0);
      assert.equal(err.limit, 15000);
      return true;
    });
  }
  assert.equal(calls, 0, "no GitHub read ran");
  assert.deepEqual(waits, [], "no timer to the reset");
  assert.equal(takeGithubBudgetThrottles()[0]?.reason, "reserve", "the throttle row is still written");

  const input = daemonInstallationBudgetWorkerInput();
  assert.equal(input?.maxWaitMs, POLL_MS, "the worker threads' input carries the bound");
  const thread = installationBudgetForThread(input!, clockFromMillisFn(() => START_MS));
  const refusal = thread.claimRead();
  assert.equal(refusal.ok, false);
  if (!refusal.ok) {
    assert.equal(thread.resetWaitMs(refusal), undefined, "a worker thread stands down past the same bound");
    assert.equal(thread.resetWaitMs({ ...refusal, waitUntil: START_MS / 1000 + 30 }), 30_000);
  }
});

test("W1-T12820 criterion 3: the pacer holds no GraphQL or search read on the core reading; the core read stands down", async (t) => {
  const waits = recordTimers(t);
  exhausted(START_MS / 1000 + HOUR_S);
  const slept: number[] = [];
  const pacer = createGhCallPacer({ minGapMs: 0, rateLimitGapMs: 0, sleepSync: (ms) => slept.push(ms), sleep: async (ms) => { slept.push(ms); } });
  const graphql = ["api", "graphql", "-f", "query={viewer{login}}"];
  const search = ["api", "search/issues?q=repo:o/r"];
  const core = ["api", "repos/o/r/pulls"];
  const sync = (args: string[]) => () => paceGhEntry(pacer, () => false, () => ghJson(args, undefined, () => "HTTP/2.0 200 OK\r\n\r\n{}"));
  const async = (args: string[]) => paceGhEntryAsync(pacer, () => false, () => ghJsonAsync(args, async () => ({ stdout: "HTTP/2.0 200 OK\r\n\r\n{}", stderr: "" })));

  assert.deepEqual(sync(graphql)(), {}, "a paced sync GraphQL read goes ahead");
  assert.deepEqual(sync(search)(), {}, "a paced sync search read goes ahead");
  assert.deepEqual(await async(graphql), {}, "a paced async GraphQL read goes ahead");
  assert.deepEqual(await async(search), {}, "a paced async search read goes ahead");
  assert.deepEqual([...waits, ...slept], [], "none of them waited");

  assert.throws(sync(core), GhPaceFloorStandDownError, "the core read on the same pacer stands down");
  await assert.rejects(async(core), GhPaceFloorStandDownError);
  assert.deepEqual(waits, [], "and does not wait an hour for the reset");
});

test("W1-T12820 criterion 4: a reset within the bound still waits one timer and then reads; with no bound the wait is whole", async (t) => {
  for (const [bound, aheadS] of [[POLL_MS, 30], [null, HOUR_S]] as const) {
    const { now } = exhausted(START_MS / 1000 + aheadS, bound);
    const waits = recordTimers(t, now);
    let calls = 0;
    assert.deepEqual(await ghJsonAsync(["api", "repos/o/r/pulls"], async () => { calls += 1; return OK; }), []);
    assert.deepEqual(waits, [aheadS * 1000], "one timer, to the reset");
    assert.equal(calls, 1, "the read ran after the reset");
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

type Deps = NonNullable<Parameters<typeof daemonImplementation>[1]>;
type Row = Record<string, unknown> & { step: string };
const BOOT: LightPassScope = { reviewOnly: true, scope: "boot" };
const stopped: DaemonSummary = { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };

/** fs.readFileSync fails ENOENT for the host registry only, so the daemon reads the checkout copy (W1-T12670). */
function noHostRegistry(t: TestContext): void {
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === DEFAULT_HOST_INSTANCE_REGISTRY_PATH) throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    return originalRead(...args);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
}

test("W1-T12820 criterion 2: the real first tick with an exhausted installation stands down and the boot light pass runs", { timeout: 4 * POLL_MS }, async (t) => {
  noHostRegistry(t);
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w12820-first-tick-`));
  mkdirSync(join(root, "state"));
  const planPath = join(root, "tasks.yaml");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(planPath, "[]\n");
  const shim = ghShim([{ when: "", stdout: "[]" }], { kind: "w12820-gh" });
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_SHARED_READ_GAP_MS",
    "GH_APP_INSTALLATION_ID", "RMD_INSTANCE_NAME", "RMD_SELECTED_INSTANCE_REGISTRY", "RMD_INSTANCE_REGISTRY"] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  const listeners = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) if (!listeners[signal].includes(listener)) process.removeListener(signal, listener);
    }
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  for (const key of keys.slice(4)) delete process.env[key];
  process.env.PATH = `${shim.dir}:${process.env.PATH ?? ""}`;
  process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  process.env.GH_APP_INSTALLATION_ID = INSTALLATION;

  const effects: SweepDeps = {
    ledgerPath, runId: "w12820-first-tick", readLedger: () => [], readActiveWorkerCount: () => 0,
    arm: () => assert.fail("unexpected arm"), close: () => assert.fail("unexpected close"),
    postReview: () => assert.fail("unexpected review"), dispatchFix: () => assert.fail("unexpected fix"),
    escalate: () => assert.fail("unexpected escalation"),
  };
  let generation = 0;
  const startedAtMs = Date.now();
  let loopMs: number | undefined;
  const deps: Deps = {
    config: { root, claudeBin: "/bin/true" }, repoRoot: REPO_ROOT,
    // The daemon has set its budget by now: the installation is at 0 of 15000, an hour from its reset.
    startGithubAppRefresh: () => {
      githubInstallationBudget().record({ remaining: 0, limit: 15000, reset: Math.floor(Date.now() / 1000) + HOUR_S, resource: "core" });
      return { armed: false };
    },
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
    checkPause: () => undefined, checkStop: () => undefined, readRunChildMode: () => "off",
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {},
    buildSweepLightHook: (...args: Parameters<typeof buildSweepLightHook>) => {
      args[0] = "o";
      args[1] = basename(root);
      args[11] = undefined;
      args[12] = { ...args[12], effects: () => effects };
      return buildSweepLightHook(...args);
    },
    wireSweepWake: () => ({ sleep: async () => "timeout", acknowledge: () => {}, close: () => {} }),
    startGitCredentialSocket: async () => undefined, startMemoryCensus: () => () => {},
    // A read plane that runs the daemon's own inline tick read: the real producer, pacer and transport.
    startReadPlane: ((options: { inline: (input: unknown) => Promise<unknown> }) => ({
      read: async (input: unknown) => {
        const publishedAtMs = Date.now();
        const facts = await options.inline(input);
        return { generation: ++generation, source: "inline", publishedAtMs, settledAtMs: Date.now(), facts };
      },
      stop: async () => {},
    })) as never,
  };
  const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--poll-ms", String(POLL_MS)], {
    ...deps,
    runDaemon: async (plan, ports) => {
      await ports.refreshMergedAsync!(plan);
      await ports.sweepLight!(BOOT);
      loopMs = Date.now() - startedAtMs;
      return stopped;
    },
  });
  assert.equal(code, 0);
  const rows: Row[] = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const configured = rows.find((row) => row.step === "github.budget.configured");
  assert.equal(configured?.outcome, "configured", JSON.stringify(configured));
  assert.equal(daemonInstallationBudgetWorkerInput()?.maxWaitMs, POLL_MS, "the daemon's bound is its poll interval");
  const openFailed = rows.find((row) => row.step === "read_plane.open_failed");
  assert.match(String(openFailed?.reason), /gh call pacer stood down: core at 0\/15000/, "the open-PR read stood down");
  assert.deepEqual(rows.filter((row) => row.step === "daemon.first_tick_read").map((row) => row.source), ["early"]);
  assert.ok(rows.some((row) => row.step === "sweep_light.pre_review_timing"), "the boot light pass ran");
  assert.ok(loopMs !== undefined && loopMs < POLL_MS, `the first tick and its light pass took ${loopMs} ms, within the bound`);
});
