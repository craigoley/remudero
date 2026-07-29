import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  WORKER_HOME_RC_FILES,
  WORKER_HOME_SYMLINKS,
  DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS,
  isReapableWorkerHome,
  materializeWorkerHome,
  perRunWorkerHomeDir,
  reapWorkerHome,
  sweepStaleWorkerHomes,
  workerHomePlan,
} from "../src/lib/worker-home.js";
import { CLAUDE_BIN_ENV_OVERRIDE, createClaudeExecutableCache, spawnWorker } from "../src/lib/worker.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-workerhome-perrun-"));
}

// ── Claim 1: two concurrent runs receive DISTINCT homes — a shared/singleton ──
// home serving both FAILS (the falsifier).

test("FALSIFIER: a shared singleton home serving two 'concurrent' spawns loses one run's state — this is the WS-2 race this task fixes", () => {
  // Pre-W1-T170 shape: BOTH runs materialize the exact SAME singleton path.
  const root = join(tmp(), "worker-home");
  const realHome = tmp();
  try {
    materializeWorkerHome({ workerHome: root, realHome });
    writeFileSync(join(root, ".bashrc"), "alias run=A\n"); // run A's own rc state
    materializeWorkerHome({ workerHome: root, realHome }); // "run B" reusing the SAME home
    assert.equal(
      readFileSync(join(root, ".bashrc"), "utf8"),
      "",
      "a SHARED home truncates whatever a different, concurrent run last wrote — the exact race WS-2 names",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("perRunWorkerHomeDir: two runIds off the SAME root resolve to DISTINCT sibling directories, never the singleton root itself", () => {
  const root = join(tmp(), "worker-home");
  const homeA = perRunWorkerHomeDir(root, "run-A");
  const homeB = perRunWorkerHomeDir(root, "run-B");
  assert.equal(homeA, `${root}-run-A`);
  assert.equal(homeB, `${root}-run-B`);
  assert.notEqual(homeA, homeB);
  assert.notEqual(homeA, root);
  assert.notEqual(homeB, root);
});

test("perRunWorkerHomeDir: an ABSENT runId still generates a fresh, distinct home every call — uniqueness never depends on a caller threading a runId through", () => {
  const root = join(tmp(), "worker-home");
  const a = perRunWorkerHomeDir(root);
  const b = perRunWorkerHomeDir(root);
  assert.notEqual(a, b, "two calls with no runId must still never collide");
  for (const h of [a, b]) assert.ok(h.startsWith(`${root}-`), `${h} must be a sibling of the root`);
});

test("two concurrent runs: EACH gets its own home, with its OWN rc files and its OWN complete symlink allowlist, and neither's materialize disturbs the other's", () => {
  const root = join(tmp(), "worker-home");
  const realHome = tmp();
  const homeA = perRunWorkerHomeDir(root, "run-A");
  const homeB = perRunWorkerHomeDir(root, "run-B");
  try {
    mkdirSync(join(realHome, ".claude"), { recursive: true });
    writeFileSync(join(realHome, ".gitconfig"), "[user]\n\tname = Test\n");

    // Simulated interleaving: A materializes and plants state, B materializes and
    // plants DIFFERENT state — neither call touches the other's directory at all.
    materializeWorkerHome({ workerHome: homeA, realHome });
    writeFileSync(join(homeA, ".bashrc"), "alias run=A\n");
    materializeWorkerHome({ workerHome: homeB, realHome });
    writeFileSync(join(homeB, ".bashrc"), "alias run=B\n");
    materializeWorkerHome({ workerHome: homeA, realHome }); // a second A spawn, same run
    materializeWorkerHome({ workerHome: homeB, realHome }); // a second B spawn, same run

    assert.equal(readFileSync(join(homeA, ".bashrc"), "utf8"), "", "A's OWN re-materialize truncates only A's own rc");
    assert.equal(readFileSync(join(homeB, ".bashrc"), "utf8"), "", "B's OWN re-materialize truncates only B's own rc");

    const planA = workerHomePlan({ workerHome: homeA, realHome });
    const planB = workerHomePlan({ workerHome: homeB, realHome });
    assert.equal(planA.rcFiles.length, WORKER_HOME_RC_FILES.length);
    assert.equal(planB.rcFiles.length, WORKER_HOME_RC_FILES.length);
    assert.equal(planA.symlinks.length, WORKER_HOME_SYMLINKS.length, "run A's allowlist is COMPLETE, not shared/partial");
    assert.equal(planB.symlinks.length, WORKER_HOME_SYMLINKS.length, "run B's allowlist is COMPLETE, not shared/partial");
    for (const rc of planA.rcFiles) assert.ok(rc.startsWith(`${homeA}/`));
    for (const rc of planB.rcFiles) assert.ok(rc.startsWith(`${homeB}/`));
  } finally {
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

// ── Claim 2: each per-run home reproduces the singleton's isolation guarantee ──
// — an injected operator-dotfile fixture yields zero inherited aliases/functions,
// per home.

test("materializeWorkerHome: EACH per-run home independently truncates its OWN injected operator-dotfile fixture — zero inherited aliases/functions, per home", () => {
  const root = join(tmp(), "worker-home");
  const realHome = tmp();
  const homes = ["run-1", "run-2", "run-3"].map((id) => perRunWorkerHomeDir(root, id));
  try {
    for (const home of homes) {
      // Simulate a stranger's populated dotfiles landing in the slot Remudero owns
      // for THIS run's home — the exact fixture worker-home.test.ts uses, applied
      // independently to every per-run home.
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".bashrc"), `alias ls='ls -la' # operator fixture in ${home}\n`);
      writeFileSync(join(home, ".zshrc"), "function operator_fn() { echo leaked; }\n");
    }
    for (const home of homes) materializeWorkerHome({ workerHome: home, realHome });
    for (const home of homes) {
      for (const rc of WORKER_HOME_RC_FILES) {
        const p = join(home, rc);
        assert.ok(existsSync(p), `${rc} must exist under ${home}`);
        assert.equal(readFileSync(p, "utf8"), "", `${rc} under ${home} must be EMPTY — zero inherited aliases/functions`);
      }
    }
    assert.equal(new Set(homes).size, homes.length, "sanity: all three per-run homes are distinct paths");
  } finally {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("materializeWorkerHome: a per-run home's auth symlinks (.claude/.config/gh/.gitconfig) still resolve to the real HOME, per home", () => {
  const root = join(tmp(), "worker-home");
  const realHome = tmp();
  const home = perRunWorkerHomeDir(root, "run-auth");
  try {
    mkdirSync(join(realHome, ".claude"), { recursive: true });
    writeFileSync(join(realHome, ".claude", "session.json"), "{}");
    materializeWorkerHome({ workerHome: home, realHome });
    assert.equal(readFileSync(join(home, ".claude", "session.json"), "utf8"), "{}");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

// ── Claim 3: a per-run home is reaped on every exit path including error, and ──
// a home orphaned by an ended run is reaped by the boot sweep.

test("isReapableWorkerHome: accepts only a one-segment sibling of root, never the root itself or anything nested/outside", () => {
  const root = "/scratch/worker-home";
  assert.equal(isReapableWorkerHome(root, root), false, "the singleton root itself must never be reapable");
  assert.equal(isReapableWorkerHome(root, "/scratch/worker-home-run-A"), true);
  assert.equal(isReapableWorkerHome(root, "/scratch/worker-home-run-A/nested"), false, "no traversal into a subpath");
  assert.equal(isReapableWorkerHome(root, "/scratch/unrelated-dir"), false);
  assert.equal(isReapableWorkerHome(root, "/scratch/worker-home-"), false, "an empty suffix is not a valid per-run id");
});

test("reapWorkerHome: removes an existing per-run home and is guarded against reaping the singleton root", () => {
  const root = join(tmp(), "worker-home");
  const home = perRunWorkerHomeDir(root, "run-reap");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".bashrc"), "");
  assert.ok(existsSync(home));

  const guardedAway = reapWorkerHome(root, root); // attempt to reap the ROOT itself
  assert.equal(guardedAway.reaped, false);
  assert.equal(guardedAway.reason, "guard-rejected");

  const result = reapWorkerHome(root, home);
  assert.equal(result.reaped, true);
  assert.equal(existsSync(home), false, "the per-run home must be gone after reap");
});

test("reapWorkerHome: reaping an already-absent home is a benign no-op, never throws", () => {
  const root = join(tmp(), "worker-home");
  const home = perRunWorkerHomeDir(root, "never-materialized");
  assert.doesNotThrow(() => {
    const result = reapWorkerHome(root, home);
    assert.equal(result.reaped, false);
    assert.equal(result.reason, "absent");
  });
});

test("sweepStaleWorkerHomes: reaps an OLD orphaned per-run home but keeps a fresh (still-in-use) one", () => {
  const root = join(tmp(), "worker-home");
  const stale = perRunWorkerHomeDir(root, "orphan-old");
  const fresh = perRunWorkerHomeDir(root, "orphan-fresh");
  const unrelated = join(tmp(), "not-a-worker-home"); // must never be touched
  try {
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    const oldMtime = new Date(Date.now() - DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS * 2);
    utimesSync(stale, oldMtime, oldMtime);

    const summary = sweepStaleWorkerHomes(root, { now: () => Date.now() });

    assert.ok(summary.removed.includes("worker-home-orphan-old"), "the stale orphan must be reaped");
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(fresh), true, "a recent-mtime home may still be owned by a live spawn — never collateral");
    assert.equal(existsSync(unrelated), true, "a directory outside the worker-home-<id> naming scheme is never touched");
  } finally {
    rmSync(stale, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
    rmSync(unrelated, { recursive: true, force: true });
  }
});

test("sweepStaleWorkerHomes: an injected old `now` reaps nothing — nothing is old relative to itself (no false positives)", () => {
  const root = join(tmp(), "worker-home");
  const home = perRunWorkerHomeDir(root, "just-created");
  try {
    mkdirSync(home, { recursive: true });
    const summary = sweepStaleWorkerHomes(root, { now: () => Date.now() });
    assert.equal(summary.removed.length, 0);
    assert.ok(summary.kept.includes("worker-home-just-created"));
    assert.equal(existsSync(home), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Claim 3, end-to-end: spawnWorker itself reaps its per-run home on both the ──
// success path and the thrown-error path — the withTempDir discipline actually
// wired into the real spawn boundary, not just the pure helper.

function e2eSpawnWorkerArgs(dir: string, runId: string, extra: Record<string, unknown> = {}) {
  const settingsFile = join(dir, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));
  return {
    cwd: dir,
    permissionMode: "bypassPermissions" as const,
    settingsFile,
    prompt: "W1-T170 per-run worker-home reap fixture",
    runId,
    config: { claudeBin: "/unused", root: dir },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: dir, exists: () => true, canExecute: () => true, locations: [] },
    },
    // Force past the darwin-only keychain gate without touching a real keychain.
    keychain: { platform: "linux" as NodeJS.Platform },
    ...extra,
  };
}

function fakeQueryFn(behavior: "success" | "error") {
  return ((params: { prompt: string; options: { spawnClaudeCodeProcess?: (o: unknown) => unknown } }) => {
    params.options.spawnClaudeCodeProcess?.({
      command: "/bin/sh",
      args: ["-c", "true"],
      env: {},
      signal: new AbortController().signal,
    });
    if (behavior === "error") {
      return (async function* () {
        throw new Error("simulated transport failure — no result envelope ever seen");
      })();
    }
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-1",
        total_cost_usd: 0.01,
        num_turns: 1,
      };
    })();
  }) as unknown as Parameters<typeof spawnWorker>[0]["queryFn"];
}

test("spawnWorker (end-to-end, SUCCESS path): the per-run worker-home is reaped after a normal resolve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-home-e2e-success-"));
  const expectedHome = join(dir, "worker-home-reap-e2e-success");
  await spawnWorker({
    ...e2eSpawnWorkerArgs(dir, "reap-e2e-success"),
    queryFn: fakeQueryFn("success"),
    containment: { spawn: (opts, onStderr) => ({ process: { stdin: {}, stdout: {}, kill: () => true, killed: false, exitCode: null, on() {}, once() {}, off() {} } as never, pid: 999998 }), teardown: () => {} },
  } as Parameters<typeof spawnWorker>[0]);
  assert.equal(existsSync(expectedHome), false, "the per-run home must be reaped once the spawn resolves");
});

test("spawnWorker (end-to-end, ERROR path): the per-run worker-home is STILL reaped when the SDK stream throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-home-e2e-error-"));
  const expectedHome = join(dir, "worker-home-reap-e2e-error");
  await assert.rejects(
    () =>
      spawnWorker({
        ...e2eSpawnWorkerArgs(dir, "reap-e2e-error"),
        queryFn: fakeQueryFn("error"),
        containment: { spawn: (opts, onStderr) => ({ process: { stdin: {}, stdout: {}, kill: () => true, killed: false, exitCode: null, on() {}, once() {}, off() {} } as never, pid: 999997 }), teardown: () => {} },
      } as Parameters<typeof spawnWorker>[0]),
    /simulated transport failure/,
  );
  assert.equal(existsSync(expectedHome), false, "the per-run home must be reaped even though the spawn THREW — the withTempDir discipline (W1-T115/W1-T131)");
});
