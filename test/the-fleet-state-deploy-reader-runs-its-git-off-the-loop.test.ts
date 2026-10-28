import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, deployStateRowsOffLoop } from "#src/lib/sweep.js";
import { readDeployFactsAsync, realDeployDeps, realDeploySensorsAsync, type RealDeployOpts } from "#src/lib/deployer.js";
import { ghTextAsync } from "#src/lib/github-transport.js";
import { deployStateRows, reconcileFleetState, type DeployStateReader, type FleetStateRow } from "#src/lib/state-reconciler.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const SYNC_SPAWNS = ["execFileSync", "spawnSync", "execSync"] as const;

/** Every sync spawn throws while `run` is pending; the ESM bindings see the trap through syncBuiltinESMExports. */
async function withSyncSpawnsTrapped<T>(run: () => Promise<T>): Promise<T> {
  const originals = SYNC_SPAWNS.map((name) => [name, childProcess[name]] as const);
  const cp = (childProcess as unknown as { default: Record<string, unknown> }).default;
  for (const name of SYNC_SPAWNS) {
    cp[name] = (...args: unknown[]) => { throw new Error(`W1-T9552 trap: ${name} ${JSON.stringify(args.slice(0, 2))}`); };
  }
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    for (const [name, original] of originals) cp[name] = original;
    syncBuiltinESMExports();
  }
}

/** A temp install repo whose origin/main carries the image inputs, and a PATH shim directory. */
function installFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9552-"));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const repo = gitRepo({ kind: "w1-t9552-install", scope: t, seedCommit: false });
  writeFileSync(join(repo.dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  writeFileSync(join(repo.dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { version: "1.0.0" } } }));
  repo.git("add", ".");
  repo.git("commit", "-m", "chore: seed image inputs");
  const sha = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", sha);
  repo.git("tag", "image/2026-10-28-fixture", sha);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  t.after(() => {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  });
  const opts: RealDeployOpts = {
    installPath: repo.dir, stateRoot: root, ledgerPath: join(root, "state", "ledger.ndjson"),
    daemonLabel: "fixture", serveLabel: "fixture", servePort: 1, uid: 0, log: () => {},
  };
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { root, repo, sha, opts, stub };
}

function latchFree(deploy: DeployStateReader["deploy"]): DeployStateReader {
  return { deploy, requestDeploy: () => {}, deployRequested: () => false, failedAt: () => undefined, clearFailure: () => {} };
}

async function answers(rows: readonly FleetStateRow[]) {
  return Promise.all(rows.map(async (row) => ({
    pipeline: row.pipeline, target: row.target, desired: row.desired,
    observed: await row.observe(), inFlight: await row.inFlight?.(),
  })));
}

test("W1-T9552: the fleet-state deploy rows build with sync spawns trapped and match the sync rows", async (t) => {
  const { root, repo, sha, opts, stub } = installFixture(t);
  stub("docker", `printf '%s\\n' '${sha}'`);
  const expected = await answers(deployStateRows(latchFree(realDeployDeps(opts)), []));
  assert.deepEqual(expected.map((row) => row.pipeline), ["image", "deploy"], "positive control: the sync reader builds both rows");
  const logs: Record<string, unknown>[] = [];
  const effects = buildSweepEffects({
    owner: "acme", repo: "widgets", repoRoot: repo.dir,
    config: { root, installRoot: repo.dir } as never, ledgerPath: opts.ledgerPath, runId: "w1-t9552",
    plan: { tasks: [], byId: new Map() } as never, policy: DEFAULT_SWEEP_POLICY,
    log: (step, data) => { logs.push({ step, ...data }); },
    readJsonImpl: async () => { throw new Error("REST unavailable"); },
  });
  const state = await withSyncSpawnsTrapped(() => effects.readFleetState!([]));
  assert.deepEqual(logs.filter((e) => e.pipeline === "deploy"), [], "the deploy read raised nothing");
  const deployRows = state.rows.filter((row) => row.pipeline === "image" || row.pipeline === "deploy");
  assert.deepEqual(await withSyncSpawnsTrapped(() => answers(deployRows)), expected);
  assert.equal(expected[1]!.observed, true, "docker's baked sha is current, read through the stub");
});

test("W1-T9552: a slow git during the deploy read does not delay a concurrent timer", async (t) => {
  const { sha, opts, stub } = installFixture(t);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  stub("docker", "exit 1");
  stub("git", `sleep 0.2\nexec '${realGit}' "$@"`);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  t.after(() => clearInterval(timer));
  const began = Date.now();
  const facts = await readDeployFactsAsync(realDeploySensorsAsync(opts, ghTextAsync));
  const tookMs = Date.now() - began;
  const ticksDuringRead = ticks;
  clearInterval(timer);
  assert.equal(facts.newestBakedSha, sha);
  assert.ok(tookMs >= 200, `positive control: the slow git stub ran (${tookMs} ms)`);
  assert.ok(ticksDuringRead > 0, `the timer ticked while git slept (${ticksDuringRead} ticks in ${tookMs} ms)`);
});

test("W1-T9552: a failed deploy fact reads as unknown, as the sync getter does", async (t) => {
  const { sha, opts, stub } = installFixture(t);
  stub("docker", "echo 'Error: No such container' >&2\nexit 1");
  const sync = realDeployDeps(opts);
  assert.equal(sync.imageBakedCommitsBehind!(), undefined, "the sync getter reads a failed docker read as unknown");
  const facts = await withSyncSpawnsTrapped(() => readDeployFactsAsync(realDeploySensorsAsync(opts, ghTextAsync)));
  assert.equal(facts.newestBakedSha, sha);
  assert.equal(facts.imageBakedCommitsBehind, undefined);
  assert.equal(facts.imagePublished, sync.imagePublished!(sha));
  assert.deepEqual(facts.thrown, {}, "an unknown fact is not a throw");
  const rows = await deployStateRowsOffLoop(latchFree(realDeploySensorsAsync(opts, ghTextAsync)), []);
  assert.deepEqual(await answers(rows), await answers(deployStateRows(latchFree(sync), [])));
});

test("W1-T9552: a deploy fact that throws replays as the same unreadable row", async () => {
  const failing = (): never => { throw new Error("registry exploded"); };
  const deploy = { newestBakedSha: () => "abc", imagePublished: failing, imageBakedCommitsBehind: () => 0, imageRecycleManual: () => false };
  const syncEvents: Record<string, unknown>[] = [];
  await reconcileFleetState(deployStateRows(latchFree(deploy), []), [], (e) => syncEvents.push(e));
  const asyncEvents: Record<string, unknown>[] = [];
  const facts = await readDeployFactsAsync(deploy);
  assert.equal((facts.thrown.imagePublished as Error).message, "registry exploded");
  await reconcileFleetState(await deployStateRowsOffLoop(latchFree(deploy), []), [], (e) => asyncEvents.push(e));
  assert.deepEqual(asyncEvents, syncEvents);
  assert.deepEqual(asyncEvents.map((e) => [e.pipeline, e.step]), [["image", "reconcile.unreadable"]]);
  await assert.rejects(readDeployFactsAsync({ newestBakedSha: failing }), /registry exploded/, "no baked sha read, no rows");
});

test("W1-T9552: an unpublished image reads its build state and its dispatch is awaited", async () => {
  const reads: string[] = [];
  let dispatched = false;
  const deploy = {
    newestBakedSha: async () => "abc",
    imagePublished: async () => { reads.push("published"); return false; },
    imageBuildInFlight: async () => { reads.push("in-flight"); return false; },
    imageBakedCommitsBehind: async () => 0,
    imageRecycleManual: () => false,
    dispatchImageBuild: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); dispatched = true; },
  };
  const events: Record<string, unknown>[] = [];
  await reconcileFleetState(await deployStateRowsOffLoop(latchFree(deploy), []), [], (e) => {
    events.push({ ...e, dispatched });
  });
  assert.deepEqual(reads, ["published", "in-flight"], "publication is read once per pass");
  assert.deepEqual(events.map((e) => [e.pipeline, e.step, e.dispatched]), [["image", "reconcile.repaired", true]]);
  const published = await readDeployFactsAsync({ ...deploy, imagePublished: async () => true });
  assert.equal(published.imageBuildInFlight, undefined, "a published image never asks about its build");
  assert.deepEqual(reads, ["published", "in-flight"]);
});
