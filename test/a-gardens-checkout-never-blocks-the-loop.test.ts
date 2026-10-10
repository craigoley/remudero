/**
 * W1-T5740 — A GARDEN'S CHECKOUT NEVER BLOCKS THE LOOP.
 *
 * MEASURED 2026-10-04 19:20Z: one intake pass held the boot loop ~153 s inside `gardenCheckout`'s
 * synchronous `git fetch` + `worktree add`. Every "lets a timer fire" test below runs the REAL git
 * subprocess against a local origin whose upload-pack (fetch) and receive-pack (push) are held open
 * by a script, and counts the interval ticks the loop ran while that child was in flight. A
 * synchronous checkout cannot pass: it holds the loop until the child exits, so no tick observes it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  ASYNC_PORT_UNDER_SYNC_PASS,
  gardenStatePath,
  isPromiseLike,
  runGarden,
  runGardenAsync,
  runStepsEager,
  startGarden,
  syncGardenWorkspace,
  type GardenAction,
  type GardenCheckout,
  type GardenCheckoutAsync,
  type GardenSpec,
} from "../src/lib/gardener.js";
import { step } from "../src/lib/git-push.js";
import { fileConsumerVia, runHostResourcePass, runHostResourcePassAsync, samplesPath, type ConsumerFiling, type HostResourcePorts, type HostSample } from "../src/lib/host-resource-gardener.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { openOpportunityIntakePorts, productionOpportunityIntakePorts } from "../src/lib/opportunity-intake.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  daemonGardenWorkspace,
  gardenCheckout,
  gardenCheckoutAsync,
  knowledgeGardenWorkspaceAsync,
  productionMachineFilingJudgePorts,
  type GardenCheckoutOpts,
} from "../src/run-task.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";

type Log = (step: string, extra?: Record<string, unknown>) => void;
type Row = [string, Record<string, unknown> | undefined];

const CLOCK = fixedClock(1790000000777);

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Counts the interval ticks the loop ran while `inFlight()` read true, across `call`. */
async function ticksWhileInFlight<T>(inFlight: () => boolean, call: () => Promise<T>): Promise<{ inFlightTicks: number; value: T }> {
  let inFlightTicks = 0;
  const interval = setInterval(() => {
    if (inFlight()) inFlightTicks += 1;
  }, 5);
  try {
    const value = await call();
    return { inFlightTicks, value };
  } finally {
    clearInterval(interval);
  }
}

/** A bare origin with `main`, a clone of it, and transport scripts that hold every fetch
 *  (upload-pack) and push (receive-pack) open while it is logged. */
function slowOrigin(kind: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5740-${kind}-`));
  const origin = gitRepo({ bare: true, kind: `t5740-${kind}-origin` });
  const seed = gitRepo({ kind: `t5740-${kind}-seed` });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "--quiet", origin.dir, clone]);
  git(clone, "config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  git(clone, "config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  const transportLog = join(root, "transport.log");
  for (const [service, key] of [["upload-pack", "uploadpack"], ["receive-pack", "receivepack"]] as const) {
    const script = join(root, `slow-${service}.sh`);
    writeFileSync(script, `#!/bin/sh\necho "start ${service}" >> '${transportLog}'\nsleep 0.3\ngit ${service} "$@"\nrc=$?\necho "end ${service}" >> '${transportLog}'\nexit $rc\n`, { mode: 0o755 });
    git(clone, "config", `remote.origin.${key}`, script);
  }
  const lines = (): string[] => (existsSync(transportLog) ? readFileSync(transportLog, "utf8").split("\n").filter(Boolean) : []);
  return {
    root,
    clone,
    worktreesRoot: join(root, "worktrees"),
    heads: () => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort(),
    /** True while the FIRST transport child of `service` since `reset()` has started and not ended. */
    inFlight: (service: "upload-pack" | "receive-pack") => {
      const own = lines().filter((line) => line.endsWith(service));
      return own[0] === `start ${service}` && !own.includes(`end ${service}`);
    },
    reset: () => rmSync(transportLog, { force: true }),
    cleanup: () => {
      for (const dir of [root, origin.dir, seed.dir]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

type C = "a";
function demoSpec(seen: Array<{ root: string; branch?: string; head: string }>, landing?: { paths: string[]; title: string; body: string }): GardenSpec<C, number, GardenAction<C>, GardenCheckout> {
  return {
    name: "demo",
    classes: ["a"],
    cheapFingerprint: () => "v1",
    inventory: () => 1,
    fingerprint: () => "f1",
    metric: () => ({ trials: 0, successes: 0 }),
    candidates: () => [{ class: "a", target: "x", reason: "r" }],
    scorecard: () => ({}),
    apply: (ws) => {
      seen.push({ root: ws.root, ...(ws.branch ? { branch: ws.branch } : {}), head: git(ws.root, "rev-parse", "HEAD") });
      if (landing) writeFileSync(join(ws.root, landing.paths[0]!), "tended\n");
      return landing;
    },
  };
}

function gardenOpts(fx: ReturnType<typeof slowOrigin>, log: Log): GardenCheckoutOpts {
  return {
    name: "plan",
    repoDir: fx.clone,
    worktreesRoot: fx.worktreesRoot,
    owner: "acme",
    repo: "remudero",
    log,
    clock: CLOCK,
    fetcher: (args) => (args.includes("POST") || args.includes("--method") ? { html_url: "https://github.com/acme/remudero/pull/5", number: 5 } : []),
    preflight: () => ({ ok: true, failures: [], unreadable: [] }),
  };
}

/** A row with its fixture-specific paths and timings reduced to their shape, so two fixtures compare. */
function comparable(rows: Row[], fx: ReturnType<typeof slowOrigin>): string[] {
  const shape = (key: string, value: unknown) =>
    typeof value === "string" ? value.split(fx.root).join("<fx>").replace(/\b[0-9a-f]{40}\b/g, "<sha>") : /_ms$|^ms$|duration/.test(key) ? 0 : value;
  return rows.map(([s, extra]) => `${s} ${JSON.stringify(extra ?? {}, shape)}`);
}

test("W1-T5740: each daemon garden workspace port lets a timer fire while its checkout's git fetch is in flight", async (t) => {
  const fx = slowOrigin("ports");
  try {
    const rows: Row[] = [];
    const log: Log = (s, e) => void rows.push([s, e]);
    const ctx = { config: { root: fx.root } as Parameters<typeof daemonGardenWorkspace>[0]["config"], repoRoot: fx.clone, owner: "acme", repo: "remudero", log };
    const ports: Array<[string, () => GardenCheckout | Promise<GardenCheckoutAsync>, RegExp]> = [
      ["registered garden", daemonGardenWorkspace(ctx, "plan"), /^plan-garden-\d+$/],
      ["machine judge", productionMachineFilingJudgePorts({ repoRoot: fx.clone, stateDir: fx.root, worktreesRoot: fx.worktreesRoot, owner: "acme", repo: "remudero", log, clock: CLOCK }).openWorkspace!, /^machine-judge-garden-1790000000777$/],
      ["knowledge", () => knowledgeGardenWorkspaceAsync({ repoDir: fx.clone, worktreesRoot: join(fx.root, "kw"), owner: "acme", repo: "remudero", log, clock: CLOCK }), /^knowledge-garden-1790000000777$/],
    ];
    for (const [name, open, branchRe] of ports) {
      fx.reset();
      const { inFlightTicks, value: ws } = await ticksWhileInFlight(() => fx.inFlight("upload-pack"), async () => open());
      t.diagnostic(`${name}: ${inFlightTicks} loop tick(s) ran while git fetch was in flight`);
      assert.ok(inFlightTicks > 0, `${name}: a timer must run while the checkout's git fetch is in flight`);
      assert.match(ws.branch ?? "", branchRe);
      assert.equal(git(ws.root, "rev-parse", "HEAD"), git(fx.clone, "rev-parse", "origin/main"));
      await ws.dispose();
      assert.equal(existsSync(ws.root), false, `${name}: dispose removes the worktree`);
    }
    assert.ok(rows.some(([s]) => s === "worktree.add"), "the async add still ledgers its worktree.add row");
  } finally {
    fx.cleanup();
  }
});

test("W1-T5740: a garden pass over the daemon's port lets a timer fire while the checkout's git fetch is in flight", async () => {
  const fx = slowOrigin("pass");
  try {
    const rows: Row[] = [];
    const log: Log = (s, e) => void rows.push([s, e]);
    const ctx = { config: { root: fx.root } as Parameters<typeof daemonGardenWorkspace>[0]["config"], repoRoot: fx.clone, owner: "acme", repo: "remudero", log };
    const seen: Array<{ root: string; branch?: string; head: string }> = [];
    fx.reset();
    const { inFlightTicks, value: pass } = await ticksWhileInFlight(
      () => fx.inFlight("upload-pack"),
      () => runGardenAsync(demoSpec(seen), { stateDir: fx.root, repoRoot: fx.clone, openWorkspace: daemonGardenWorkspace(ctx, "plan"), log, seed: 1 }),
    );
    assert.ok(inFlightTicks > 0, "a timer must run while the pass's checkout fetch is in flight");
    assert.equal(pass.ran, true);
    assert.equal(seen.length, 1, "the pass applied its plan in the checkout it awaited");
    assert.match(seen[0]!.branch ?? "", /^plan-garden-\d+$/);
    assert.equal(existsSync(seen[0]!.root), false, "the pass disposed its checkout");
    assert.ok(rows.some(([s]) => s === "demo.scorecard"));
  } finally {
    fx.cleanup();
  }
});

test("W1-T5740: the async checkout opens the same branch and records the same rows as the sync form, its push off the loop", async () => {
  const landing = { paths: ["tended.txt"], title: "chore(plan): tend the demo garden", body: "the body" };
  const run = async (form: "sync" | "async") => {
    const fx = slowOrigin(`same-${form}`);
    const rows: Row[] = [];
    const log: Log = (s, e) => void rows.push([s, e]);
    const seen: Array<{ root: string; branch?: string; head: string }> = [];
    const deps = { stateDir: fx.root, repoRoot: fx.clone, log, seed: 1 };
    try {
      let pushTicks = 0;
      const pass = await withLiveWritesAllowed(async () => {
        if (form === "sync") return runGarden(demoSpec(seen, landing), { ...deps, openWorkspace: () => gardenCheckout(gardenOpts(fx, log)) });
        fx.reset();
        const ticked = await ticksWhileInFlight(() => fx.inFlight("receive-pack"), () => runGardenAsync(demoSpec(seen, landing), { ...deps, openWorkspace: () => gardenCheckoutAsync(gardenOpts(fx, log)) }));
        pushTicks = ticked.inFlightTicks;
        return ticked.value;
      });
      return { pass, rows: comparable(rows, fx), heads: fx.heads(), seen, pushTicks, state: JSON.parse(readFileSync(gardenStatePath(fx.root, "demo"), "utf8")) as Record<string, unknown> };
    } finally {
      fx.cleanup();
    }
  };
  const sync = await run("sync");
  const async_ = await run("async");
  assert.ok(async_.pushTicks > 0, "a timer must run while the garden branch's git push is in flight");
  assert.equal(async_.pass.prUrl, "https://github.com/acme/remudero/pull/5");
  assert.equal(async_.pass.prUrl, sync.pass.prUrl);
  assert.deepEqual(async_.heads, ["main", "plan-garden-1790000000777"], "the async form pushed the garden branch");
  assert.deepEqual(async_.heads, sync.heads, "the same branch on origin");
  assert.equal(async_.seen[0]!.branch, sync.seen[0]!.branch);
  assert.deepEqual(async_.rows, sync.rows, "the same ledger rows, in the same order");
  assert.deepEqual(async_.state, sync.state, "the same garden state");
});

test("W1-T5740: the daemon's intake awaits its knowledge checkout and disposes it when the ports cannot be built", async () => {
  const fx = slowOrigin("intake");
  try {
    const rows: Row[] = [];
    const log: Log = (s, e) => void rows.push([s, e]);
    const worktreesRoot = join(fx.root, "kw");
    const garden = {
      stateDir: fx.root,
      repoRoot: fx.clone,
      clock: CLOCK,
      log,
      openWorkspace: () => knowledgeGardenWorkspaceAsync({ repoDir: fx.clone, worktreesRoot, owner: "acme", repo: "remudero", log, clock: CLOCK }),
    };
    fx.reset();
    let refused: unknown;
    const { inFlightTicks } = await ticksWhileInFlight(() => fx.inFlight("upload-pack"), () => openOpportunityIntakePorts(garden).catch((e: unknown) => void (refused = e)));
    assert.ok(inFlightTicks > 0, "a timer must run while the intake's checkout fetch is in flight");
    assert.match(String(refused), /GitHub repository identity/, "a local origin is not a GitHub identity");
    assert.equal(existsSync(join(worktreesRoot, "knowledge-garden-1790000000777")), false, "the refused intake disposed its checkout");
    assert.throws(() => productionOpportunityIntakePorts(garden), new RegExp(ASYNC_PORT_UNDER_SYNC_PASS));
  } finally {
    fx.cleanup();
  }
});

test("W1-T5740: the intake's ports are built over an awaited checkout and its dispose is awaited", async () => {
  const repo = gitRepo({ kind: "t5740-intake-ports" });
  const root = repo.dir;
  try {
    mkdirSync(join(root, "plan"));
    repo.addRemote("origin", "https://github.com/acme/app.git");
    writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
    writeFileSync(join(root, "plan", "policy.yaml"), "{}\n");
    let disposed = 0;
    const ws: GardenCheckoutAsync = { root, land: async () => "https://github.com/acme/app/pull/1", dispose: async () => void disposed++ };
    const ports = await openOpportunityIntakePorts({ stateDir: root, repoRoot: root, clock: CLOCK, log: () => {}, openWorkspace: async () => ws });
    assert.equal(ports.repo, "acme/app");
    await ports.dispose?.();
    assert.equal(disposed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5740: a synchronous pass refuses an async port, ledgers the refusal and disposes what the port made", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5740-refuse-`));
  try {
    const rows: Row[] = [];
    let disposed = 0;
    const made: GardenCheckoutAsync = { root: dir, land: async () => "u", dispose: async () => void disposed++ };
    const pass = runGarden(demoSpec([]), { stateDir: dir, repoRoot: dir, openWorkspace: async () => made, log: (s, e) => void rows.push([s, e]), seed: 1 });
    assert.equal(pass.prUrl, undefined);
    const failed = rows.find(([s]) => s === "demo.garden_filing_failed")?.[1];
    assert.equal(failed?.reason, ASYNC_PORT_UNDER_SYNC_PASS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposed, 1, "the checkout the refused port made is disposed once made");
    assert.equal(syncGardenWorkspace(made as unknown as GardenCheckout), made, "a checkout that is not a promise passes through");
    const rejected = Promise.reject(new Error("never made"));
    assert.throws(() => syncGardenWorkspace(rejected as unknown as Promise<GardenCheckoutAsync>), new RegExp(ASYNC_PORT_UNDER_SYNC_PASS));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T5740: the eager driver finishes synchronous steps in place and awaits the rest, routing each failure back into the steps", async () => {
  function* steps(effects: Array<() => unknown>) {
    const seen: unknown[] = [];
    for (const effect of effects) {
      try {
        seen.push(yield* step(effect));
      } catch (e) {
        seen.push(`caught ${(e as Error).message}`);
      }
    }
    return seen;
  }
  const boom = (m: string) => () => {
    throw new Error(m);
  };
  assert.deepEqual(runStepsEager(steps([() => 1, boom("sync")])), [1, "caught sync"], "synchronous steps finish before it returns");
  const pending = runStepsEager(steps([() => 1, async () => 2, () => Promise.reject(new Error("async")), boom("after"), () => 3]));
  assert.ok(isPromiseLike(pending), "an awaited effect hands back a promise");
  assert.deepEqual(await pending, [1, 2, "caught async", "caught after", 3]);
  const rejectedFirst = runStepsEager(steps([() => Promise.reject(new Error("first"))]));
  assert.deepEqual(await rejectedFirst, ["caught first"]);
});

test("W1-T5740: a timer-driven garden holds its pass while an async checkout is in flight", async () => {
  const repo = gitRepo({ kind: "t5740-timer" });
  const dir = repo.dir;
  try {
    let opened = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const landed: string[] = [];
    const rows: string[] = [];
    const pump = startGarden(
      demoSpec([], { paths: ["x"], title: "t", body: "b" }),
      {
        stateDir: dir,
        repoRoot: dir,
        openWorkspace: async () => {
          opened++;
          await gate;
          return { root: dir, land: async (o) => (landed.push(o.title), "https://github.com/acme/demo/pull/3"), dispose: async () => {} };
        },
        log: (s) => void rows.push(s),
        seed: 1,
      },
      2,
    );
    for (let waited = 0; waited < 40; waited += 2) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(opened, 1, "no second pass starts while the first awaits its checkout");
    release();
    for (let waited = 0; landed.length === 0 && waited < 5000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    pump.stop();
    assert.deepEqual(landed, ["t"]);
    assert.ok(rows.includes("demo.scorecard"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const GB = 1024 * 1024;
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

function growingHost(dir: string): void {
  const samples: HostSample[] = Array.from({ length: 144 }, (_, i) => {
    const tsMs = NOW - (143 - i) * 30 * 60_000;
    return {
      host: "azure",
      beatTs: new Date(tsMs).toISOString(),
      tsMs,
      values: { root_free_kb: 400 * GB + (143 - i) * GB },
      consumers: { worktrees: 10 * GB + i * 0.8 * GB, state: 3 * GB },
      devices: { root: "/dev/sda1" },
      consumerDevices: { worktrees: "/dev/sda1", state: "/dev/sda1" },
      janitorTs: new Date(Math.floor(tsMs / (6 * 3_600_000)) * 6 * 3_600_000).toISOString(),
      janitorFreedKb: 4 * 1024,
    };
  });
  writeFileSync(samplesPath(dir), samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

test("W1-T5740: the host-resource filing awaits the daemon's checkout, and a synchronous pass refuses it", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5740-host-`));
  // The checkout holds the janitor the shard declares, as main does: lint-plan's admission reads it.
  mkdirSync(join(dir, "deploy"), { recursive: true });
  writeFileSync(join(dir, "deploy", "rmd-host-cleanup.sh"), "#!/bin/sh\n");
  try {
    const rows: Array<[string, Record<string, unknown> | undefined]> = [];
    let disposed = 0;
    const open = async (): Promise<GardenCheckoutAsync> => ({
      root: dir,
      branch: "host-resource-garden-1",
      land: async () => "https://github.com/acme/remudero/pull/12",
      dispose: async () => void disposed++,
    });
    const ports = (fileConsumer: HostResourcePorts["fileConsumer"]): HostResourcePorts => ({
      stateDir: dir, clock: fixedClock(NOW), log: (s, e) => void rows.push([s, e]), readHeartbeats: () => [], planOrigins: () => [], fileConsumer,
    });
    growingHost(dir);
    const refusedPass = runHostResourcePass(ports(fileConsumerVia(open, () => "W1-T9996")));
    assert.equal(refusedPass.ran, true);
    assert.match(String(rows.find(([s]) => s === "host_resource.file_failed")?.[1]?.error), new RegExp(ASYNC_PORT_UNDER_SYNC_PASS));
    rmSync(join(dir, "host-resource-state.json"), { force: true });
    rows.length = 0;
    const filer = fileConsumerVia(open, () => "W1-T9995");
    const pass = await runHostResourcePassAsync(ports(filer));
    assert.equal(pass.ran, true);
    assert.equal(rows.find(([s]) => s === "host_resource.filed")?.[1]?.pr_url, "https://github.com/acme/remudero/pull/12");
    const filing = rows.find(([s]) => s === "host_resource.filed");
    assert.ok(filing, "the awaited filing is ledgered");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(disposed >= 2, "both the refused and the awaited checkout were disposed");
    const direct = filer({ host: "azure", device: "root", consumer: "worktrees", origin: "host-resource:azure:worktrees", attribution: { consumer: "worktrees", growthKbPerHour: GB, share: 0.8, spanHours: 72, points: 144, janitorPasses: 12 } } as ConsumerFiling);
    assert.ok(isPromiseLike(direct), "over the daemon's port the filer hands back a promise");
    assert.equal(await direct, "https://github.com/acme/remudero/pull/12");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
