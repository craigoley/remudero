import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import * as fleet from "../src/lib/fleet-lane.js";
import * as garden from "../src/lib/gardener.js";
import * as daemon from "../src/lib/daemon.js";
import { ghJsonAsync } from "../src/lib/github-transport.js";
import { runAutomaticBranchReapRung, reapBranchesCommand, reapBranchesCommandAsync } from "../src/run-task.js";
import type { AutomaticBranchReapState } from "../src/lib/branch-reaper.js";
import type { Config } from "../src/lib/config.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";

function slowChildren() {
  const githubRoutes: GhShimRoute[] = [
    { when: "head=", stdout: "merged\ttrue", delaySeconds: 0.07 },
    { when: "pulls/", stdout: '{"merged":true,"state":"closed"}', delaySeconds: 0.07 },
    { when: "", delaySeconds: 0.07 },
  ];
  const github = ghShim(githubRoutes, { kind: "reap-garden-loop" });
  const gitRoutes: GhShimRoute[] = [
    { when: "ls-remote", stdout: "main-sha\trefs/heads/main\nold-sha\trefs/heads/old" },
    { when: "--merged=origin/main", stdout: "origin/main" },
    { when: "for-each-ref", stdout: "origin/main\tmain-sha\t1\norigin/old\told-sha\t1" },
    { when: "grep -l -F", exit: 1 },
    { when: "log", stdout: "sha1\nsha2" },
    { when: "" },
  ].map((route) => ({ ...route, delaySeconds: 0.07 }));
  const git = ghShim(gitRoutes, { kind: "reap-garden-git", command: "git" });
  const root = github.dir;
  mkdirSync(join(root, "src"));
  const priorPath = process.env.PATH;
  process.env.PATH = `${git.dir}:${github.dir}:${priorPath}`;
  const rows = () => [
    ...git.events().map((row) => ({ ...row, cmd: "git" })),
    ...github.events().map((row) => ({ ...row, cmd: "gh" })),
  ];
  return {
    root, rows,
    fail: (cmd: "git" | "gh") => {
      const shim = cmd === "git" ? git : github;
      const routes = cmd === "git" ? gitRoutes : githubRoutes;
      shim.addRoute({ when: "", exit: 2, delaySeconds: 0.07 });
      return () => { for (const route of [...routes].reverse()) shim.addRoute(route); };
    },
    close: () => {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(git.dir, { recursive: true, force: true });
    },
  };
}

async function probe<T>(fx: ReturnType<typeof slowChildren>, run: () => T | Promise<T>) {
  const observed = new Set<number>();
  const timer = setInterval(() => {
    const rows = fx.rows();
    for (const row of rows) if (row.phase === "start" && !rows.some((end) => end.id === row.id && end.phase === "end")) observed.add(row.id);
  }, 5);
  try {
    const result = await run();
    const started = fx.rows().filter((row) => row.phase === "start");
    assert.ok(started.length > 0, "the positive control saw real child processes");
    for (const row of started) assert.ok(observed.has(row.id), `timer ran during ${row.cmd} ${row.args.join(" ")}`);
    return result;
  } finally {
    clearInterval(timer);
  }
}

describe("test/the-reap-and-garden-reads-never-block-the-loop.test.ts", () => {
  test("W1-T5285: the automatic branch reap lets a timer fire while its execs are in flight", async () => {
    const fx = slowChildren();
    const state: AutomaticBranchReapState = {};
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const run = (passState = state) => runAutomaticBranchReapRung("acme", "demo", { root: fx.root } as Config,
      join(fx.root, "ledger.ndjson"), "REAP", (step, extra) => rows.push({ step, extra }), passState, { root: fx.root });
    try {
      await probe(fx, async () => {
        const first = run();
        await run({});
        await first;
      });
      assert.equal(rows.filter((row) => row.step === "branch_reap.sweep.started").length, 1, "a second reap cannot overlap");
      assert.equal(rows.filter((row) => row.step === "branch_reap.sweep.completed").length, 1);
      assert.deepEqual(state.mergedHeadShas, { main: "main-sha", old: "old-sha" });
      assert.ok(fx.rows().some((row) => row.args.includes("--delete") && row.args.includes("old")), "the awaited path reaches the guarded prune");
      const starts = fx.rows().filter((row) => row.phase === "start").length;
      await run();
      assert.equal(fx.rows().filter((row) => row.phase === "start").length, starts + 1, "the unchanged branch set keeps its cadence");
    } finally { fx.close(); }
  });

  test("W1-T5285: the knowledge gardener pr state read lets a timer fire while gh is in flight", async () => {
    const fx = slowChildren();
    const spec: garden.GardenSpec<"a", number, garden.GardenAction<"a">, garden.GardenCheckout> = {
      name: "demo", classes: ["a"], decision: ["a"], cheapFingerprint: () => "same",
      inventory: () => { throw new Error("a decision PR needs no inventory read"); },
      fingerprint: () => "same", metric: () => ({ trials: 0, successes: 0 }),
      candidates: () => [], scorecard: () => ({}), apply: () => undefined,
    };
    const statePath = garden.gardenStatePath(fx.root, "demo");
    const pending = { prUrl: "https://github.com/acme/demo/pull/1", actionClass: "a" as const, baseline: { trials: 0, successes: 0 } };
    const initial = { ...garden.initialGardenState(["a"]), pending, lastCheap: "same" };
    await writeFile(statePath, JSON.stringify(initial));
    const rows: string[] = [];
    let reading: Promise<unknown> | undefined;
    const deps: garden.GardenerDeps<garden.GardenCheckout, garden.PrState | Promise<garden.PrState>> = {
      stateDir: fx.root, repoRoot: fx.root, openWorkspace: () => { throw new Error("no filing"); },
      prState: (url) => garden.gardenPrState("acme", "demo", url, (args) => {
        reading = ghJsonAsync(args);
        return reading;
      }), log: (step) => rows.push(step),
    };
    try {
      await probe(fx, () => garden.runGardenAsync(spec, deps));
      assert.equal(garden.readGardenState(statePath, ["a"]).classes.a.alpha, initial.classes.a.alpha + 1);
      assert.equal(garden.readGardenState(statePath, ["a"]).pending, undefined);
      assert.deepEqual(rows, ["demo.gardener_judged"]);
      fx.fail("gh");
      await writeFile(statePath, JSON.stringify(initial));
      rows.length = 0;
      await garden.runGardenAsync(spec, deps);
      assert.deepEqual(garden.readGardenState(statePath, ["a"]), initial, "an unreadable PR stays unknown and unjudged");
      assert.deepEqual(rows, []);
      assert.equal(await garden.gardenPrState("acme", "demo", "invalid", ghJsonAsync), "unknown");
    } finally {
      // A reverted synchronous reader can leave its async fetch running; drain it before removing PATH.
      await reading?.catch((error) => assert.ok(error));
      fx.close();
    }
  });

  test("W1-T5285: the merge rate read lets a timer fire while git log is in flight", async () => {
    const fx = slowChildren();
    try {
      assert.equal(await probe(fx, () => fleet.mergedInLastDayAsync(fx.root)), 2);
      fx.fail("git");
      assert.equal(await fleet.mergedInLastDayAsync(fx.root), 0, "an unanswerable merge rate still files nothing");
    } finally { fx.close(); }
  });

  test("the async reaper preserves CLI verdicts, caches and ledger rows", async () => {
    const fx = slowChildren();
    try {
      const run = (async: boolean) => {
        const ledgerPath = join(fx.root, async ? "async.ndjson" : "sync.ndjson");
        const cache: Record<string, unknown> = {};
        const opts = {
          root: fx.root, ownerRepo: { owner: "acme", repo: "demo" }, ledgerPath, runId: "SAME", quiet: true,
          onMergedHeadCacheUpdate: (next: unknown) => { cache.merged = next; },
          onNoPrHeadCacheUpdate: (next: unknown) => { cache.none = next; },
          onExitReason: (reason: string) => { cache.reason = reason; },
        };
        return { result: async ? reapBranchesCommandAsync(["--prune"], opts) : reapBranchesCommand(["--prune"], opts), cache, ledgerPath };
      };
      const sync = run(false), async = run(true);
      assert.equal(await async.result, sync.result);
      assert.deepEqual(async.cache, sync.cache);
      const rows = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => {
        const { ts, ...row } = JSON.parse(line);
        return row;
      });
      assert.deepEqual(rows(async.ledgerPath), rows(sync.ledgerPath));
    } finally { fx.close(); }
  });

  test("an unreadable automatic reap releases its guard and can retry", async () => {
    const fx = slowChildren();
    const state: AutomaticBranchReapState = {};
    const logs: Array<Record<string, unknown>> = [];
    const run = () => runAutomaticBranchReapRung("acme", "demo", { root: fx.root } as Config,
      join(fx.root, "ledger.ndjson"), "RETRY", (_step, extra = {}) => logs.push(extra), state, { root: fx.root });
    try {
      const recover = fx.fail("git");
      await run();
      assert.equal(logs[0]?.outcome, "unreadable");
      assert.equal(state.lastRunAtMs, undefined);
      recover();
      await run();
      assert.ok(logs.some((row) => row.outcome === "completed_with_drift_or_failure"));
      assert.ok(state.lastRunAtMs);
    } finally { fx.close(); }
  });

  test("a failed asynchronous active-head read refuses prune", async () => {
    const fx = slowChildren();
    try {
      fx.fail("gh");
      let reason: string | undefined;
      assert.equal(await reapBranchesCommandAsync(["--prune"], {
        root: fx.root, ownerRepo: { owner: "acme", repo: "demo" }, quiet: true,
        onExitReason: (why) => { reason = why; },
      }), 1);
      assert.equal(reason, "prune-refused: the open pull requests could not be re-read");
      assert.equal(fx.rows().some((row) => row.args.includes("--delete")), false);
    } finally { fx.close(); }
  });

  test("the fleet lane awaits its merge rate and keeps the same pass facts", async () => {
    const fx = slowChildren();
    try {
      fleet.writeClassificationSnapshot(fx.root, []);
      const deps = { stateDir: fx.root, ledgerPath: join(fx.root, "ledger.ndjson"), approve: () => { throw new Error("no findings to file"); } };
      const async = await probe(fx, () => fleet.triageFleetLaneAsync({ ...deps, mergedLastDay: () => fleet.mergedInLastDayAsync(fx.root) }));
      const sync = fleet.triageFleetLane({ ...deps, mergedLastDay: () => 2 });
      assert.equal(async.room, 2);
      assert.deepEqual({ ...async, classificationAgeMs: undefined }, { ...sync, classificationAgeMs: undefined });
    } finally { fx.close(); }
  });

  test("the fleet timer skips overlapping passes and records asynchronous failures", async () => {
    let resolve!: (result: fleet.FleetLanePass) => void;
    const pending = new Promise<fleet.FleetLanePass>((done) => { resolve = done; });
    let calls = 0;
    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const lane = fleet.startFleetLane(() => { calls++; return pending; }, 5, (step, extra) => logs.push({ step, extra }));
    try {
      await new Promise((done) => setTimeout(done, 30));
      assert.equal(calls, 1);
      resolve({ filed: ["finding"], merged: [], room: 1 });
      await new Promise((done) => setImmediate(done));
      assert.equal(logs[0]?.step, "fleet_lane.pass");
    } finally { lane.stop(); }
    const failed = fleet.startFleetLane(async () => { throw new Error("merge read rejected"); }, 1000, (step, extra) => logs.push({ step, extra }));
    try {
      await new Promise((done) => setImmediate(done));
      assert.deepEqual(logs.at(-1), { step: "fleet_lane.failed", extra: { error: "merge read rejected" } });
    } finally { failed.stop(); }
  });

  test("the daemon SRE timer awaits one merge-rate child before building its input", async () => {
    const fx = slowChildren();
    const rates: number[] = [];
    try {
      await probe(fx, async () => {
        const lane = daemon.startDaemonSreLane((rate) => {
          rates.push(rate);
          return {
            stateDir: fx.root, root: fx.root, mergedLastDay: () => rate, readEvents: () => [],
            hasOpenTask: () => false, framesFor: () => [], mergedPrsSince: () => [], log: () => {},
          };
        }, () => fleet.mergedInLastDayAsync(fx.root), () => {})(5);
        try { await lane.settled(); } finally { lane.stop(); }
      });
      assert.deepEqual(rates, [2]);
      assert.equal(fx.rows().filter((row) => row.phase === "start").length, 1, "ticks cannot overlap the awaited read");
    } finally { fx.close(); }
  });

  test("the daemon SRE timer records a rejected merge-rate port", async () => {
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const lane = daemon.startDaemonSreLane(() => { throw new Error("no input without a rate"); },
      async () => { throw new Error("rate unavailable"); }, (step, extra) => rows.push({ step, extra }))(1000);
    try {
      await lane.settled();
      assert.deepEqual(rows, [{ step: "sre_lane.failed", extra: { error: "rate unavailable" } }]);
    } finally { lane.stop(); }
  });
});
