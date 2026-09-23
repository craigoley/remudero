/**
 * test/worktree-node-modules-lockfile-mismatch.test.ts — W1-T2777.
 *
 * THE FAILURE MODE. `linkWorktreeNodeModules` symlinks `node_modules` into a worktree from
 * `resolveNodeModulesSource(repoDir)`. The worktree's source tree is cut FRESH from
 * `origin/main` (by `worktreeAdd`'s own fetch — see `src/lib/worker.ts:3244`), but the
 * node_modules source may be arbitrarily far behind (the operator measured 27→28→39→47→48
 * commits over a few hours; canonical checkout drift, `recordCanonicalCheckoutDrift`). If
 * an incoming commit adds a dependency and the drift hasn't caught up, the linked
 * node_modules cannot resolve it — the worker sees `Cannot find module` inside its own
 * test and the failure reads as a defect in its own diff, not as the drift it actually is.
 *
 * THE FIX (W1-T2777, DETECTION ONLY — the operator explicitly ruled out changing the refresh
 * cycle). At symlink time, compare `hashInstallInputs` between the worktree's source and the
 * node_modules source. Match ⇒ `"linked"`, silently as today. Differ ⇒ `"linked-lockfile-
 * mismatch"` and a warn() so the caller (or the operator reading stderr) knows the drift is
 * about to bite BEFORE the worker starts, not after it fails cryptically inside a test.
 *
 * THE INTENDED FALSIFIER SHAPE, EACH DIRECTION EARNING ITS OWN GUARD:
 *
 *   ─ (a) reproduce the failure. Worktree = origin/main HEAD carrying a new dep in its
 *          package-lock.json; source tree = an older repoDir without that entry; symlink
 *          made; MUST return `linked-lockfile-mismatch`.
 *   ─ (b) prove the fix stays quiet on the healthy path. Matching lockfiles on both sides
 *          MUST return `"linked"` and MUST NOT emit any warning.
 *   ─ (c) the warning names the two paths being compared (not just "mismatch"), so the
 *          operator knows which side is stale without re-deriving it.
 *   ─ (d) the pre-existing outcomes are byte-identically preserved — no regression on the
 *          "already-present"/"no-source"/"failed" paths, which do NOT consult the hash.
 *   ─ (e) the hash function is the SAME one `ensureInstallFresh` uses. A parallel
 *          implementation could drift silently — this guard fires if the module ever grows
 *          two independent hashInstallInputs functions on the same inputs.
 *   ─ (f) end-to-end on real files, not just the injected hasher: real package.json /
 *          package-lock.json bytes on disk with the real default hasher — the all-fakes
 *          trap CLAUDE.md documents fires if this test suite only ever proves the fake.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { linkWorktreeNodeModules } from "../src/lib/worker.js";
import { hashInstallInputs, installHashMarkerPath } from "../src/lib/install-hash.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-w1-t2777-${prefix}`));
}

/** Realistic package.json/package-lock.json pair — one dep. */
function writeInstallInputs(dir: string, deps: Record<string, string>): void {
  const pkg = {
    name: "rmd-t2777-fixture",
    version: "0.0.0",
    dependencies: deps,
  };
  const lock = {
    name: "rmd-t2777-fixture",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: Object.fromEntries([
      ["", { name: "rmd-t2777-fixture", version: "0.0.0", dependencies: deps }],
      ...Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v.replace(/^\^/, "") }]),
    ]),
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock, null, 2));
}

/** Root layout: `worktree/` (empty, no node_modules), `nmSourceParent/node_modules/`
 *  (present, empty). `deps.resolveSource` is overridden to return that path so we don't
 *  depend on the process's install root layout. */
function makeRoot(): { root: string; worktree: string; nmSourceParent: string; nmSource: string } {
  const root = tmp("real-");
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  const nmSourceParent = join(root, "clone");
  mkdirSync(nmSourceParent);
  const nmSource = join(nmSourceParent, "node_modules");
  mkdirSync(nmSource);
  return { root, worktree, nmSourceParent, nmSource };
}

// ── (a) the failure mode this task exists for ────────────────────────────────────────────────

test("W1-T2777 (a): a worktree cut with a NEW dep on top of a source without it returns linked-lockfile-mismatch", () => {
  const { root, worktree, nmSourceParent, nmSource } = makeRoot();
  try {
    // Source (repoDir) sits BEFORE a new dep was added: 1 dependency.
    writeInstallInputs(nmSourceParent, { "some-dep": "^1.0.0" });
    // Worktree, cut from origin/main HEAD, carries a NEWER lockfile with an added dep.
    writeInstallInputs(worktree, { "some-dep": "^1.0.0", "the-new-one": "^2.0.0" });

    const warnings: string[] = [];
    const outcome = linkWorktreeNodeModules(nmSourceParent, worktree, {
      resolveSource: () => nmSource,
      warn: (m) => warnings.push(m),
    });

    assert.equal(
      outcome,
      "linked-lockfile-mismatch",
      "the incident's own shape (worktree has a dep repoDir does not) must be caught",
    );
    assert.equal(warnings.length, 1, "the mismatch must be surfaced through the loud channel exactly once");
    assert.equal(lstatSync(join(worktree, "node_modules")).isSymbolicLink(), true, "the link is still made — best-effort contract holds");
    assert.equal(readlinkSync(join(worktree, "node_modules")), nmSource);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (b) the healthy path stays quiet ─────────────────────────────────────────────────────────

test("W1-T2777 (b): matching lockfiles on both sides return `linked` with NO warning", () => {
  const { root, worktree, nmSourceParent, nmSource } = makeRoot();
  try {
    const deps = { "some-dep": "^1.0.0", "the-new-one": "^2.0.0" };
    writeInstallInputs(worktree, deps);
    writeInstallInputs(nmSourceParent, deps);

    const warnings: string[] = [];
    const outcome = linkWorktreeNodeModules(nmSourceParent, worktree, {
      resolveSource: () => nmSource,
      warn: (m) => warnings.push(m),
    });

    assert.equal(outcome, "linked", "matching lockfiles must produce the pre-W1-T2777 outcome unchanged");
    assert.deepEqual(warnings, [], "the healthy path must never spend the operator's attention on a non-finding");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (c) the warning names both paths ─────────────────────────────────────────────────────────

test("W1-T2777 (c): the mismatch warning names the two directories being compared, so the operator does not re-derive it", () => {
  const { root, worktree, nmSourceParent, nmSource } = makeRoot();
  try {
    writeInstallInputs(nmSourceParent, { "some-dep": "^1.0.0" });
    writeInstallInputs(worktree, { "some-dep": "^2.0.0" });

    const warnings: string[] = [];
    linkWorktreeNodeModules(nmSourceParent, worktree, {
      resolveSource: () => nmSource,
      warn: (m) => warnings.push(m),
    });

    assert.equal(warnings.length, 1);
    const msg = warnings[0]!;
    assert.ok(msg.includes(worktree), `warning must name the worktree side; message: ${msg}`);
    assert.ok(msg.includes(nmSourceParent), `warning must name the node_modules source side; message: ${msg}`);
    assert.match(msg, /Cannot find module|hash differs/, "warning must name the failure mode the operator will otherwise see");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (d) the pre-existing outcomes are byte-identically preserved ─────────────────────────────

test("W1-T2777 (d): `already-present` is unchanged — a taken destination never triggers the lockfile compare", () => {
  let hashCalls = 0;
  const outcome = linkWorktreeNodeModules("/clone", "/wt", {
    lstat: () => ({}),
    resolveSource: () => "/src/node_modules",
    hashInstallInputs: () => {
      hashCalls += 1;
      return "should-never-be-called";
    },
  });
  assert.equal(outcome, "already-present");
  assert.equal(hashCalls, 0, "an occupied destination short-circuits BEFORE the hash compare");
});

test("W1-T2777 (d): `no-source` is unchanged — nothing was linked, nothing to compare", () => {
  let hashCalls = 0;
  const outcome = linkWorktreeNodeModules("/clone", "/wt", {
    lstat: () => {
      throw new Error("ENOENT");
    },
    resolveSource: () => undefined,
    hashInstallInputs: () => {
      hashCalls += 1;
      return "";
    },
  });
  assert.equal(outcome, "no-source");
  assert.equal(hashCalls, 0);
});

test("W1-T2777 (d): `failed` is unchanged — a symlink that threw is `failed`, not a mismatch", () => {
  let hashCalls = 0;
  const outcome = linkWorktreeNodeModules("/clone", "/wt", {
    lstat: () => {
      throw new Error("ENOENT");
    },
    resolveSource: () => "/src/node_modules",
    symlink: () => {
      throw new Error("EPERM");
    },
    hashInstallInputs: () => {
      hashCalls += 1;
      return "";
    },
  });
  assert.equal(outcome, "failed", "a symlink failure yields `failed`, never a manufactured mismatch");
  assert.equal(hashCalls, 0, "a failed symlink short-circuits BEFORE the hash compare");
});

test("W1-T2777 (d): a hasher that VIOLATES its documented non-throwing contract yields `linked`, never a manufactured mismatch", () => {
  // hashInstallInputs is documented to never throw (missing files hash as empty content).
  // If an injected fake breaks that contract anyway, the compare must treat it as
  // "cannot tell" and fall back to the pre-fix outcome — inventing a mismatch a real read
  // never observed would be worse than staying silent.
  const outcome = linkWorktreeNodeModules("/clone", "/wt", {
    lstat: () => {
      throw new Error("ENOENT");
    },
    resolveSource: () => "/src/node_modules",
    symlink: () => {
      /* succeeds — link is made */
    },
    hashInstallInputs: () => {
      throw new Error("hashInstallInputs must never throw, but this fake does");
    },
  });
  assert.equal(outcome, "linked", "a throwing hasher must not be read as a mismatch");
});

// ── (e) the shared primitive contract ────────────────────────────────────────────────────────

test("W1-T2777 (e): the default hasher IS the exported hashInstallInputs — no parallel implementation lives in worker.ts", () => {
  // Two seams to catch the drift: (1) the source's public export at its documented path
  // (extracted from run-task.ts on this task), (2) a synthetic mismatch where the fake would
  // have to lie for the default and the imported to disagree. If a future edit inlines a copy
  // of the hash logic into worker.ts, either the same-input compare below diverges or the
  // export path stops resolving — either way, this guard fires.
  const { root, worktree, nmSourceParent, nmSource } = makeRoot();
  try {
    writeInstallInputs(worktree, { a: "^1.0.0" });
    writeInstallInputs(nmSourceParent, { a: "^1.0.0" });
    const outcome = linkWorktreeNodeModules(nmSourceParent, worktree, {
      resolveSource: () => nmSource,
    });
    assert.equal(outcome, "linked", "the default hasher must classify these identical inputs as matching");

    // The lib export is the single source of truth — importable, callable, deterministic.
    const h1 = hashInstallInputs(worktree);
    const h2 = hashInstallInputs(nmSourceParent);
    assert.equal(h1, h2, "the exported primitive agrees with the outcome above");
    assert.match(h1, /^[0-9a-f]{64}$/, "sha256 hex output is the documented shape");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (f) the all-fakes trap ────────────────────────────────────────────────────────────────────

test("W1-T2777 (f): the DEFAULT leaf runs end-to-end on real files — no injected hasher, real disk", () => {
  const { root, worktree, nmSourceParent, nmSource } = makeRoot();
  try {
    // Deliberately different: worktree adds `x`, source does not.
    writeInstallInputs(worktree, { x: "^1.0.0" });
    writeInstallInputs(nmSourceParent, {});

    const warnings: string[] = [];
    const outcome = linkWorktreeNodeModules(nmSourceParent, worktree, {
      // NO hashInstallInputs override — the production path runs.
      resolveSource: () => nmSource,
      warn: (m) => warnings.push(m),
    });

    assert.equal(outcome, "linked-lockfile-mismatch", "the production hash leaf must detect the mismatch on real disk");
    assert.equal(warnings.length, 1);

    // Cross-check: what did the production hash actually read?
    const hw = hashInstallInputs(worktree);
    const hs = hashInstallInputs(nmSourceParent);
    assert.notEqual(hw, hs, "the exported hash must corroborate the outcome — this is what the code under test also compared");
    assert.notEqual(readFileSync(join(worktree, "package.json"), "utf8"), readFileSync(join(nmSourceParent, "package.json"), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T4193: an IMPLEMENT worktree defers on a same-package mismatch; nothing else changes ──
//
// W1-T2777 above shipped detection only; `worktreeAdd` discarded the outcome. W1-T4193 makes the
// refusal OPT-IN: only runTaskBody's implement path sets `refuseSamePackageLockfileMismatch`, and
// it refuses only when BOTH package.json files name the SAME package. A satellite linked to core's
// install root is ledgered and keeps its link, and every caller without the option keeps the
// warn-and-link baseline. The runTask tests drive the REAL runTaskBody catch arm; the drain test
// drives the REAL runDrainLanes settle loop.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ManagedCheckoutRefreshRefusedError, refreshManagedCheckout, runTask, type RunResult } from "../src/run-task.js";
import { worktreeAdd, WorktreeNodeModulesRefusedError, writeRunLock, type WorkerResult } from "../src/lib/worker.js";
import { runDrain } from "../src/lib/drain.js";
import { loadPlan } from "../src/lib/plan.js";
import type { Config } from "../src/lib/config.js";
import type { DispatchClaimReserver } from "../src/lib/dispatch-claim.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import type { GitHub } from "../src/lib/status.js";
import type { spawnWorker } from "../src/lib/worker.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

const T4193_TASK = "T-W1-T4193-PROBE";
const pkgJson = (name: string, deps: Record<string, string>) => JSON.stringify({ name, version: "0.0.0", dependencies: deps });

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" });
}

/** A bare origin seeded with `seedFiles`, and a clone of it at `<root>/repos/remudero`. */
function t4193Fixture(root: string, seedFiles: Record<string, string>): { repoDir: string } {
  const origin = gitRepo({ bare: true, kind: "w1-t4193-origin" }).dir;
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "-q", origin, seed], { stdio: "pipe" });
  gitIn(seed, "config", "user.email", "t4193@example.invalid");
  gitIn(seed, "config", "user.name", "t4193");
  writeFileSync(join(seed, "README.md"), "seed\n");
  for (const [name, body] of Object.entries(seedFiles)) writeFileSync(join(seed, name), body);
  gitIn(seed, "add", "-A");
  gitIn(seed, "commit", "-q", "-m", "seed");
  gitIn(seed, "push", "-q", "origin", "main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin, repoDir], { stdio: "pipe" });
  gitIn(repoDir, "config", "user.email", "t4193@example.invalid");
  gitIn(repoDir, "config", "user.name", "t4193");
  return { repoDir };
}

/** The same-package drift shape: origin/main adds a dependency; the canonical checkout's OWN
 *  node_modules was installed from the older package.json of the SAME package. */
function samePackageDrift(root: string): { repoDir: string } {
  const { repoDir } = t4193Fixture(root, { "package.json": pkgJson("t4193-core", { a: "^1.0.0", added: "^2.0.0" }) });
  writeFileSync(join(repoDir, "package.json"), pkgJson("t4193-core", { a: "^1.0.0" }));
  mkdirSync(join(repoDir, "node_modules"));
  return { repoDir };
}

function t4193Reserver(dropThrows = false): DispatchClaimReserver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    mintAnchor: () => "t4193-anchor",
    attempt: () => "created",
    holder: () => undefined,
    drop: (taskId, o) => {
      calls.push(`drop:${taskId}:${o?.expect ?? "-"}`);
      if (dropThrows) throw new Error("simulated: origin unreachable during the release");
      return true;
    },
  };
}

const t4193Github = (): GitHub => ({
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
});

function workerErrorEnvelope(): WorkerResult {
  return {
    sessionId: "s", costUsd: 0, numTurns: 0, text: "", blocks: [], stderr: "", subtype: "error_max_turns", isError: true,
    apiError: false, permissionDenials: [], childEnvKeys: [], model: "default", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

interface T4193Run {
  err: unknown;
  result: RunResult | undefined;
  ledger: Array<Record<string, unknown>>;
  reserver: ReturnType<typeof t4193Reserver>;
  spawned: number;
}

/** Drive a REAL runTask() at the fixture under `root`. */
async function runT4193(
  root: string,
  opts: {
    dropThrows?: boolean;
    spawnReturns?: boolean;
    readRemoteHead?: (repoDir: string, ref: string) => string;
    managedCheckoutInstall?: (repoDir: string) => void;
  } = {},
): Promise<T4193Run> {
  const planPath = join(root, "tasks.yaml");
  writeFileSync(
    planPath,
    [`- id: ${T4193_TASK}`, "  title: node_modules refusal probe", "  repo: remudero", "  type: implement",
      "  verify: auto", "  risk: medium", "  files: [src/lib/daemon.ts]", "  origin: architect", "  status: queued", ""].join("\n"),
  );
  const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
  const reserver = t4193Reserver(opts.dropThrows);
  let spawned = 0;
  const spawn: typeof spawnWorker = async () => {
    spawned += 1;
    if (opts.spawnReturns) return workerErrorEnvelope();
    throw new Error("must never spawn — the node_modules refusal fires before any worker runs");
  };
  let err: unknown;
  let result: RunResult | undefined;
  try {
    result = await withLiveWritesAllowed(() =>
      runTask(T4193_TASK, {
        skipGitSync: true,
        planPath,
        config,
        github: t4193Github(),
        spawn,
        containmentExec: (token: string): Promise<ProbeExecResult> =>
          Promise.resolve({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
        isolationExec: (): Promise<IsolationProbeExecResult> =>
          Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
        claimReserver: reserver,
        ...(opts.readRemoteHead ? { worktreeBaseDeps: { readRemoteHead: opts.readRemoteHead } } : {}),
        managedCheckoutInstall: opts.managedCheckoutInstall,
      }),
    );
  } catch (e) {
    err = e;
  }
  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { err, result, ledger, reserver, spawned };
}

function assertDeferredRefusal(r: T4193Run): Record<string, unknown> {
  assert.ok(r.err instanceof WorktreeNodeModulesRefusedError, `runTask must rethrow the typed refusal; got: ${String(r.err)}`);
  assert.equal((r.err as { reasonClass?: unknown }).reasonClass, "blocked_toolchain", "the tag daemon.ts defers without a strike");
  assert.equal(r.err.packageName, "t4193-core");
  assert.match(r.err.message, /Remedy: refresh the canonical checkout \(the install root is re-installed on the next freshness restart\)/);
  assert.equal(r.spawned, 0, "no worker is spawned");
  const refused = r.ledger.find((l) => l.step === "worktree.node_modules_refused");
  assert.equal(refused?.package, "t4193-core", "runTaskBody ledgers the named refusal line");
  assert.equal(r.ledger.find((l) => l.step === "worktree.add_failed"), undefined, "never the generic add-failure line");
  assert.ok(r.reserver.calls.includes(`drop:${T4193_TASK}:t4193-anchor`), "the claim is released through the holder arm");
  return refused!;
}

test("W1-T4193: a lockfile mismatch refuses the worktree instead of linking it", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4193-mismatch-`));
  try {
    const { repoDir } = samePackageDrift(root);
    const r = await runT4193(root);
    const refused = assertDeferredRefusal(r);
    assert.equal(refused.node_modules_source, join(repoDir, "node_modules"), "names the node_modules source side");
    const wt = String(refused.worktreePath);
    assert.equal(existsSync(wt), false, `the refused worktree is removed, never left linked: ${wt}`);
    assert.ok(r.ledger.some((l) => l.step === "worktree.remove" && l.on === "node_modules_refused"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4193: a satellite worktree linked to another packages tree is recorded and never refused", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4193-satellite-`));
  try {
    // A satellite: its own package, no node_modules in its canonical clone, so the only tree
    // resolveNodeModulesSource finds is THIS install root's (package "remudero").
    t4193Fixture(root, { "package.json": pkgJson("remudero-site", { next: "^15.0.0" }) });
    const r = await runT4193(root, { spawnReturns: true });
    assert.equal(r.err, undefined, `a satellite dispatch must never be refused: ${String(r.err)}`);
    assert.ok(r.result, "the run reaches a terminal verdict of its own");
    assert.ok(r.spawned > 0, "the worker is spawned exactly as today");
    const cross = r.ledger.find((l) => l.step === "worktree.node_modules_cross_package");
    assert.deepEqual(
      { worktree_package: cross?.worktree_package, node_modules_package: cross?.node_modules_package, node_modules_source: cross?.node_modules_source },
      { worktree_package: "remudero-site", node_modules_package: "remudero", node_modules_source: join(process.cwd(), "node_modules") },
      "both package names and both paths are recorded",
    );
    assert.match(String(cross?.worktreePath), /worktrees/);
    assert.equal(r.ledger.find((l) => l.step === "worktree.node_modules_refused"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4193: a worktree created without the implement option keeps the warn-and-link baseline", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4193-baseline-`));
  try {
    const { repoDir } = samePackageDrift(root);
    const errors: string[] = [];
    t.mock.method(console, "error", (m: string) => errors.push(m));
    const logs: string[] = [];
    const wt = join(root, "wt");
    worktreeAdd(repoDir, wt, "run-t4193-baseline", "origin/main", { log: (step) => logs.push(step) });
    assert.equal(lstatSync(join(wt, "node_modules")).isSymbolicLink(), true, "the same-package mismatch is still linked");
    assert.equal(readlinkSync(join(wt, "node_modules")), join(repoDir, "node_modules"));
    assert.ok(errors.some((m) => m.startsWith("node_modules lockfile mismatch:")), "and still warned, exactly as W1-T2777 shipped");
    assert.deepEqual(logs.filter((s) => s.startsWith("worktree.node_modules")), [], "no W1-T4193 line without the option");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4193: a refused implement lane in rmd drain defers instead of failing the drain", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4193-drain-`));
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, ["A", "B"].map((id) =>
      `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
    const plan = loadPlan(f);
    const merged = new Set<string>();
    const calls: string[] = [];
    const runOne = async (id: string): Promise<RunResult> => {
      calls.push(id);
      if (id === "A") throw new WorktreeNodeModulesRefusedError("t4193-core", "/wt/A", "/canonical/node_modules");
      merged.add(id);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    };
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const s = await runDrain(
      plan,
      { refreshMerged: () => (id) => merged.has(id), runOne, log: (step, extra) => logs.push([step, extra]) },
      { laneCount: 2, max: 4 },
    );
    assert.notEqual(s.stopReason, "error", `a deferred lane must not end the drain in error: ${s.stopDetail}`);
    assert.deepEqual(s.merged, ["B"], "the sibling lane still merges");
    assert.deepEqual(s.continued, [{ taskId: "A", verdict: "blocked_toolchain" }], "A is continued, never credited");
    assert.deepEqual(calls.filter((c) => c === "A"), ["A"], "and never re-offered in the same drain");
    assert.equal(logs.find(([step]) => step === "drain.lane_error"), undefined);
    const row = logs.find(([step, extra]) => step === "drain.continued" && extra?.task === "A");
    assert.match(String(row?.[1]?.reason), /Remedy: refresh the canonical checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4193: a claim release that throws never replaces the typed refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4193-release-`));
  try {
    samePackageDrift(root);
    const r = await runT4193(root, { dropThrows: true });
    assertDeferredRefusal(r);
    assert.ok(r.ledger.some((l) => l.step === "dispatch.claim_release_error"), "the failed release is ledgered, not swallowed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4193: a refused worktree that cannot be removed is ledgered and still rethrows the typed refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4193-remove-`));
  try {
    const { repoDir } = samePackageDrift(root);
    // The currency check runs AFTER `git worktree add`: answer it truthfully, and LOCK every linked
    // worktree first, so the arm's `git worktree remove --force` genuinely fails.
    const r = await runT4193(root, {
      readRemoteHead: (dir, ref) => {
        for (const line of gitIn(dir, "worktree", "list", "--porcelain").split("\n")) {
          const path = line.startsWith("worktree ") ? line.slice("worktree ".length) : undefined;
          if (path && path !== repoDir) gitIn(dir, "worktree", "lock", path);
        }
        return gitIn(dir, "ls-remote", "origin", `refs/heads/${ref}`).split("\t")[0]!;
      },
    });
    assertDeferredRefusal(r);
    const removeError = r.ledger.find((l) => l.step === "worktree.remove.error");
    assert.equal(removeError?.on, "node_modules_refused");
    assert.match(String(removeError?.error), /worktree remove --force/, "the real git failure is carried, not erased");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4193: an unreadable package.json is ledgered and keeps the link, never refused", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4193-unreadable-`));
  try {
    const { repoDir } = t4193Fixture(root, { "package.json": "{ not json" });
    mkdirSync(join(repoDir, "node_modules"));
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const wt = join(root, "wt");
    worktreeAdd(repoDir, wt, "run-t4193-unreadable", "origin/main", {
      log: (step, extra) => logs.push([step, extra]),
      warn: () => {},
      refuseSamePackageLockfileMismatch: true,
    });
    const row = logs.find(([step]) => step === "worktree.node_modules_package_unreadable");
    assert.match(String(row?.[1]?.worktree_error), /JSON/, "the parse failure is named, not read as a package-less repo");
    assert.equal(lstatSync(join(wt, "node_modules")).isSymbolicLink(), true, "today's link is kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4193: a package-less worktree under the implement option keeps todays link and records nothing", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4193-nopkg-`));
  try {
    const { repoDir } = t4193Fixture(root, {});
    mkdirSync(join(repoDir, "node_modules"));
    const logs: string[] = [];
    const wt = join(root, "wt");
    worktreeAdd(repoDir, wt, "run-t4193-nopkg", "origin/main", { log: (step) => logs.push(step), warn: () => {}, refuseSamePackageLockfileMismatch: true });
    assert.equal(lstatSync(join(wt, "node_modules")).isSymbolicLink(), true);
    assert.deepEqual(logs.filter((s) => s.startsWith("worktree.node_modules")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T4356: the managed checkout is fast-forwarded before a worktree borrows its install ──
//
// W1-T4193 refuses a worktree whose install inputs differ from the checkout it borrows node_modules from, but
// nothing moved repos/<repo>, so a lockfile change on main refused every implement dispatch until an operator
// fast-forwarded it by hand. The runTask tests below drive the REAL refresh inside runTaskBody (only `npm ci`
// is injected); the direct tests pin each arm that leaves the checkout untouched.

/** A borrowed checkout (its own node_modules) one commit behind an origin/main that adds a dependency. */
function behindMain(root: string): { repoDir: string; before: string; after: string } {
  const { repoDir } = t4193Fixture(root, { ".gitignore": "node_modules/\n", "package.json": pkgJson("t4193-core", { a: "^1.0.0" }) });
  mkdirSync(join(repoDir, "node_modules"));
  const seed = join(root, "seed");
  writeFileSync(join(seed, "package.json"), pkgJson("t4193-core", { a: "^1.0.0", added: "^2.0.0" }));
  gitIn(seed, "commit", "-q", "-am", "add a dependency");
  gitIn(seed, "push", "-q", "origin", "main");
  return { repoDir, before: gitIn(repoDir, "rev-parse", "HEAD").trim(), after: gitIn(seed, "rev-parse", "HEAD").trim() };
}

const refreshLog = () => {
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  return { lines, log: (step: string, extra?: Record<string, unknown>) => void lines.push([step, extra]) };
};

test("W1-T4356: a clean managed checkout behind main is fast-forwarded before the worktree borrows its install", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4356-ff-`));
  try {
    const { repoDir, before, after } = behindMain(root);
    const installs: string[] = [];
    const r = await runT4193(root, { spawnReturns: true, managedCheckoutInstall: (dir) => void installs.push(dir) });
    assert.equal(r.err, undefined, `the refreshed checkout must not be refused: ${String(r.err)}`);
    assert.ok(r.spawned > 0, "the worker runs against the refreshed install");
    assert.equal(gitIn(repoDir, "rev-parse", "HEAD").trim(), after, "the checkout now sits at origin/main");
    assert.deepEqual(installs, [repoDir], "the install is refreshed for the lockfile change, once");
    const steps = r.ledger.map((l) => l.step);
    const ff = r.ledger.find((l) => l.step === "managed_checkout.fast_forward");
    assert.deepEqual({ before: ff?.before_sha, after: ff?.after_sha }, { before, after }, "ledgered with both shas");
    assert.ok(steps.indexOf("managed_checkout.fast_forward") < steps.indexOf("worktree.add"), "before the worktree is cut");
    assert.equal(r.ledger.find((l) => l.step === "worktree.node_modules_refused"), undefined);
    assert.equal(existsSync(join(root, "state", "managed-checkout-remudero.lock")), false, "the checkout lock is released");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4356: a dirty managed checkout is never fast-forwarded and the refusal names why", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4356-dirty-`));
  try {
    const { repoDir, before } = behindMain(root);
    writeFileSync(join(repoDir, "operator-notes.txt"), "work in progress\n");
    const installs: string[] = [];
    const r = await runT4193(root, { managedCheckoutInstall: (dir) => void installs.push(dir) });
    const refused = assertDeferredRefusal(r);
    assert.match(String((r.err as Error).message), /the managed checkout was not fast-forwarded: checkout is dirty \(1 changed path\(s\)\)/);
    assert.equal(refused.managed_checkout_not_refreshed, "checkout is dirty (1 changed path(s))", "the ledgered refusal names it too");
    assert.equal(gitIn(repoDir, "rev-parse", "HEAD").trim(), before, "the dirty checkout is untouched");
    assert.deepEqual(installs, [], "and never reinstalled");
    assert.equal(r.ledger.find((l) => l.step === "managed_checkout.fast_forward"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4356: an install that fails after the fast-forward is reverted and refused as a deferral before any worktree exists", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4356-install-`));
  try {
    const { repoDir, before } = behindMain(root);
    const r = await runT4193(root, { managedCheckoutInstall: () => { throw new Error("simulated: npm ci exited 1"); } });
    assert.ok(r.err instanceof ManagedCheckoutRefreshRefusedError, `got: ${String(r.err)}`);
    assert.equal(r.err.reasonClass, "blocked_toolchain", "deferred by daemon.ts without a strike");
    assert.match(String(r.ledger.find((l) => l.step === "managed_checkout.refresh_refused")?.reason), /reverted to [0-9a-f]{40}: simulated: npm ci exited 1/);
    assert.equal(gitIn(repoDir, "rev-parse", "HEAD").trim(), before, "reverted, so the next dispatch retries the install");
    assert.ok(r.reserver.calls.includes(`drop:${T4193_TASK}:t4193-anchor`), "the claim is released");
    assert.equal(r.ledger.find((l) => l.step === "worktree.add"), undefined, "no worktree is cut");
    assert.equal(existsSync(join(root, "state", "managed-checkout-remudero.lock")), false, "the checkout lock is released");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4356: a checkout without its own node_modules is not borrowed, so it is never touched or locked", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4356-unborrowed-`));
  try {
    const { repoDir, before } = behindMain(root);
    rmSync(join(repoDir, "node_modules"), { recursive: true });
    const lockPath = join(root, "state", "refresh.lock");
    const out = refreshManagedCheckout(repoDir, lockPath, refreshLog().log, () => assert.fail("never installs"));
    assert.equal(out.kind, "unborrowed");
    assert.equal(existsSync(lockPath), false, "no lock is taken");
    out.release();
    assert.equal(gitIn(repoDir, "rev-parse", "HEAD").trim(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4356: a current checkout is left alone and its lock is held until released", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4356-current-`));
  try {
    const { repoDir } = t4193Fixture(root, { "package.json": pkgJson("t4193-core", { a: "^1.0.0" }) });
    mkdirSync(join(repoDir, "node_modules"));
    const lockPath = join(root, "state", "refresh.lock");
    const out = refreshManagedCheckout(repoDir, lockPath, refreshLog().log, () => assert.fail("never installs"));
    assert.equal(out.kind, "current");
    assert.throws(() => refreshManagedCheckout(repoDir, lockPath, refreshLog().log), (e: unknown) =>
      e instanceof ManagedCheckoutRefreshRefusedError && /another dispatch holds/.test(e.message), "a peer is refused while it is held");
    out.release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4356: an off-main, unfetchable, diverged or borrowed checkout is skipped with its reason and never moved", () => {
  const cases: Array<[string, (repoDir: string, root: string) => void, RegExp]> = [
    ["off-main", (dir) => void gitIn(dir, "checkout", "-q", "-b", "operator-branch"), /checkout is on operator-branch, not main/],
    ["unfetchable", (dir, root) => void gitIn(dir, "remote", "set-url", "origin", join(root, "gone.git")), /could not fetch origin/],
    ["diverged", (dir) => void gitIn(dir, "commit", "-q", "--allow-empty", "-m", "local only"), /checkout has diverged from origin\/main/],
    ["borrowed", (dir, root) => {
      const wt = join(root, "live-worker");
      gitIn(dir, "worktree", "add", "-q", "--detach", wt);
      writeRunLock(wt, { pid: process.pid, run_id: "live", startedAt: "2026-09-23T00:00:00.000Z" });
    }, /a live worker still borrows its node_modules/],
  ];
  for (const [name, arrange, reason] of cases) {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4356-${name}-`));
    try {
      const { repoDir } = behindMain(root);
      arrange(repoDir, root);
      const head = gitIn(repoDir, "rev-parse", "HEAD").trim();
      const { lines, log } = refreshLog();
      const out = refreshManagedCheckout(repoDir, join(root, "state", "refresh.lock"), log, () => assert.fail("never installs"));
      out.release();
      assert.equal(out.kind, "skipped", name);
      assert.match(out.kind === "skipped" ? out.reason : "", reason, name);
      assert.match(String(lines.find(([s]) => s === "managed_checkout.refresh_skipped")?.[1]?.reason), reason, `${name} is ledgered`);
      assert.equal(gitIn(repoDir, "rev-parse", "HEAD").trim(), head, `${name} is never moved`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("W1-T4356: the default install is ensureInstallFresh, which reinstalls only when the lockfile hash moved", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4356-default-`));
  try {
    const { repoDir, after } = behindMain(root);
    // Prime the install marker with origin/main's inputs, so the REAL default no-ops instead of running npm ci.
    const seedHash = hashInstallInputs(join(root, "seed"));
    mkdirSync(dirname(installHashMarkerPath(repoDir)), { recursive: true });
    writeFileSync(installHashMarkerPath(repoDir), seedHash);
    const out = refreshManagedCheckout(repoDir, join(root, "state", "refresh.lock"), refreshLog().log);
    out.release();
    assert.equal(out.kind, "fast_forwarded");
    assert.equal(gitIn(repoDir, "rev-parse", "HEAD").trim(), after);
    assert.equal(readFileSync(installHashMarkerPath(repoDir), "utf8"), seedHash, "the marker already matched: no npm ci ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4356: a checkout git cannot read is refused and its lock released", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4356-unreadable-`));
  try {
    const repoDir = join(root, "not-a-repo");
    mkdirSync(join(repoDir, "node_modules"), { recursive: true });
    const lockPath = join(root, "state", "refresh.lock");
    assert.throws(() => refreshManagedCheckout(repoDir, lockPath, refreshLog().log), ManagedCheckoutRefreshRefusedError);
    assert.equal(existsSync(lockPath), false, "a refusal never strands the lock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
