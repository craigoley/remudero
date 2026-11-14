import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";
import { buildSweepLightHook } from "#test/helpers/run-task-test.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import type { daemonCommand as daemonImplementation } from "#src/cli/commands/daemon.js";
import type { DaemonDeps, DaemonSummary, LightPassScope } from "#src/lib/daemon.js";
import type { Plan } from "#src/lib/plan.js";
import type { SweepDeps } from "#src/lib/sweep.js";

type Deps = NonNullable<Parameters<typeof daemonImplementation>[1]>;
type Row = Record<string, unknown> & { step: string };
const MAX_AGE_MS = 5 * 60_000;
const BOOT: LightPassScope = { reviewOnly: true, scope: "boot" };
const stopped: DaemonSummary = { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-first-tick-views-"));
  mkdirSync(join(root, "state"));
  const planPath = join(root, "tasks.yaml");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(planPath, "[]\n");
  const transport = ghShim([{ when: "", stdout: "[]" }], { kind: "first-tick-views" });
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_SHARED_READ_GAP_MS"] as const;
  const env = keys.map((key) => [key, process.env[key]] as const);
  process.env.PATH = `${transport.dir}:${process.env.PATH ?? ""}`;
  process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  const clock = { ms: Date.now() };
  const reads: unknown[] = [];
  const answers: Array<(plan: unknown, n: number) => Promise<unknown>> = [];
  const generation = (plan: unknown, n: number, publishedAtMs = clock.ms) => ({
    generation: n, source: "inline", publishedAtMs, settledAtMs: clock.ms,
    facts: { plan, projection: [], openBranches: [], creditUpdates: [], openPrViews: [] },
  });
  const rows = (): Row[] => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const ownReads = () => transport.calls().filter((call) => call.includes("pulls?state=open")).length;
  const effects: SweepDeps = {
    ledgerPath, runId: "first-tick-views", readLedger: () => [], readActiveWorkerCount: () => 0,
    arm: () => assert.fail("unexpected arm"), close: () => assert.fail("unexpected close"),
    postReview: () => assert.fail("unexpected review"), dispatchFix: () => assert.fail("unexpected fix"),
    escalate: () => assert.fail("unexpected escalation"),
  };
  const deps: Deps = {
    config: { root, claudeBin: "/bin/true" }, repoRoot: REPO_ROOT, now: () => clock.ms,
    startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
    checkPause: () => undefined, checkStop: () => undefined, readRunChildMode: () => "off",
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {},
    buildSweepLightHook: (...args: Parameters<typeof buildSweepLightHook>) => {
      // Each hook gets its own repository namespace so transport caches cannot mask a read.
      args[0] = "o";
      args[1] = basename(root);
      args[11] = undefined;
      args[12] = { ...args[12], effects: () => effects, clock: { now: () => clock.ms } };
      return buildSweepLightHook(...args);
    },
    wireSweepWake: () => ({ sleep: async () => "timeout", acknowledge: () => {}, close: () => {} }),
    startGitCredentialSocket: async () => undefined, startMemoryCensus: () => () => {},
    startReadPlane: (() => ({
      read: async ({ plan }: { plan: unknown }) => {
        reads.push(plan);
        return answers[reads.length - 1]?.(plan, reads.length) ?? generation(plan, reads.length);
      },
      stop: async () => {},
    })) as never,
  };
  return { clock, reads, answers, generation, ownReads,
    firstTickSources: () => rows().filter((row) => row.step === "daemon.first_tick_read").map((row) => row.source),
    viewsSources: () => rows().filter((row) => row.step === "sweep_light.pre_review_timing").map((row) => row.views_source),
    run: (loop: (plan: Plan, deps: DaemonDeps) => Promise<void>) => daemonCommand(
      ["--allow-self-target", "--plan", planPath],
      { ...deps, runDaemon: async (plan, ports) => { await loop(plan, ports); return stopped; } }),
    cleanup: () => {
      env.forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      });
      rmSync(transport.dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("W1-T12358: the boot light pass is served the early tick read", async () => {
  const f = fixture();
  const earlyAtMs = f.clock.ms;
  try {
    assert.equal(await f.run(async (plan, deps) => {
      f.clock.ms += 10_000;
      await deps.refreshMergedAsync!(plan);
      await deps.sweepLight!(BOOT);
      assert.deepEqual(f.firstTickSources(), ["early"]);
      assert.deepEqual(f.viewsSources(), ["tick_read"]);
      assert.equal(f.reads.length, 1);
      assert.equal(f.ownReads(), 0, "the light pass did not read GitHub");
      f.clock.ms = earlyAtMs + MAX_AGE_MS;
      await deps.sweepLight!(BOOT);
      assert.deepEqual(f.viewsSources(), ["tick_read", "tick_read"], "the age limit is inclusive");
      f.clock.ms++;
      await deps.sweepLight!(BOOT);
      assert.deepEqual(f.viewsSources(), ["tick_read", "tick_read", "own_read"], "freshness is checked again at consumption");
      assert.equal(f.ownReads(), 1, "positive control: an expired read sends the light pass to GitHub");
    }), 0);
  } finally { f.cleanup(); }
});

test("W1-T12358: a stale or failed early read is not served to the boot light pass", async () => {
  for (const source of ["early_stale", "early_failed", "plan_changed"] as const) {
    for (const current of [true, false]) {
      const f = fixture();
      if (source === "early_failed") f.answers[0] = async () => { throw new Error("fixture early read failure"); };
      f.answers[1] = async (plan, n) => f.generation(plan, n, f.clock.ms - (current ? 0 : 1));
      try {
        assert.equal(await f.run(async (plan, deps) => {
          f.clock.ms += MAX_AGE_MS + 1;
          const next = source === "plan_changed" ? { ...plan } : plan;
          deps.onPlanReload?.(next);
          await deps.refreshMergedAsync!(next);
          await deps.sweepLight!(BOOT);
          assert.deepEqual(f.firstTickSources(), [source]);
          assert.equal(f.reads.length, 2, "the first tick read again");
          assert.equal(f.reads[1], next, "the replacement read used the current plan");
          assert.deepEqual(f.viewsSources(), [current ? "tick_read" : "own_read"]);
          assert.equal(f.ownReads(), current ? 0 : 1, "a replacement must start in this tick");
        }), 0);
      } finally { f.cleanup(); }
    }
  }
});

test("W1-T12358: a later tick serves only a read from that tick", async () => {
  const f = fixture();
  f.answers[1] = async (plan, n) => f.generation(plan, n, f.clock.ms - 1);
  try {
    assert.equal(await f.run(async (plan, deps) => {
      f.clock.ms += 10_000;
      await deps.refreshMergedAsync!(plan);
      await deps.sweepLight!(BOOT);
      f.clock.ms += 10_000;
      await deps.refreshMergedAsync!(plan);
      await deps.sweepLight!(BOOT);
      assert.deepEqual(f.viewsSources(), ["tick_read", "own_read"], "tick two cannot borrow the early start");
      assert.equal(f.ownReads(), 1);
      f.clock.ms += 10_000;
      await deps.refreshMergedAsync!(plan);
      await deps.sweepLight!(BOOT);
      assert.deepEqual(f.viewsSources(), ["tick_read", "own_read", "tick_read"]);
      assert.equal(f.ownReads(), 1, "a current later read avoids another GitHub read");
      assert.equal(f.reads.length, 3);
      assert.deepEqual(f.firstTickSources(), ["early"], "later ticks write no first-tick row");
    }), 0);
  } finally { f.cleanup(); }
});
