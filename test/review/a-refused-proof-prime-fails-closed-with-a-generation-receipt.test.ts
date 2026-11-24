import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEPENDENCY_SEED_MIN_IDLE_MS, materializeDependencySeed, sweepDependencySeeds,
  type DependencyGenerationRefusalReceipt } from "#src/lib/dependency-seeds.js";
import { LoopBoundedChildTimeout } from "#src/lib/loop-bounded-child.js";
import { ensureDeps, ensureDepsAsync, proofInstallEnv, registerReviewerCheckout } from "#src/lib/review.js";
import { execFileRouted } from "#src/lib/spawn-helper.js";
import { provisionWorktreeNodeModules, worktreeAddAsync, WorktreeNodeModulesRefusedError } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const primeScript = join(REPO_ROOT, "scripts/dependency-seeds.mjs");
const manifest = JSON.stringify({ name: "prime-fixture", dependencies: { tsx: "1.0.0" } });
const lockfile = JSON.stringify({ name: "prime-fixture", lockfileVersion: 3, packages: { "node_modules/tsx": { version: "1.0.0" } } });
const marker = "node_modules/.rmd-dependency-seed.json";

function inputs(checkout: string): void {
  writeFileSync(join(checkout, "package.json"), manifest);
  writeFileSync(join(checkout, "package-lock.json"), lockfile);
}

function walk(path: string, visit: (path: string) => void): void {
  visit(path);
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), visit);
}

function fixture(t: TestContext, proof = false) {
  let root: string;
  t.after(() => walk(root, (path) => {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) chmodSync(path, stat.mode | 0o700);
  }));
  root = realpathSync(ownedFixtureDir(t, "proof-prime").dir);
  const original = { HOME: process.env.HOME, NODE_OPTIONS: process.env.NODE_OPTIONS,
    RMD_DEPENDENCY_SEED_ROOT: process.env.RMD_DEPENDENCY_SEED_ROOT };
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.HOME = root;
  delete process.env.NODE_OPTIONS;
  const store = join(root, "seeds");
  process.env.RMD_DEPENDENCY_SEED_ROOT = store;
  const checkout = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    inputs(path);
    return path;
  };
  const donor = checkout("donor");
  const tsx = join(donor, "node_modules/tsx");
  mkdirSync(tsx, { recursive: true });
  // A real importable stand-in with a fixed version lets the child resolve its preload offline.
  writeFileSync(join(tsx, "package.json"), JSON.stringify({ name: "tsx", version: "1.0.0", exports: "./index.mjs" }));
  writeFileSync(join(tsx, "index.mjs"), "export const loadedFrom = import.meta.url;\n");
  const consumer = checkout("consumer");
  const generation = materializeDependencySeed(consumer, { root: store, sourceDir: donor, proof,
    env: proof ? proofInstallEnv() : process.env, now: 0 });
  assert.equal(generation.status, "materialized");
  const offending = join(generation.seed, "node_modules/tsx/index.mjs");
  const corrupt = () => chmodSync(offending, lstatSync(offending).mode | 0o200);
  const snapshot = () => {
    const result = new Map<string, [number, Buffer | null]>();
    walk(generation.seed, (path) => {
      const stat = lstatSync(path);
      result.set(path, [stat.mode, stat.isFile() ? readFileSync(path) : null]);
    });
    return result;
  };
  const prime = (target: string) => spawnSync(process.execPath, [
    "--experimental-strip-types", primeScript, "prime", target, ...(proof ? ["--proof"] : []),
    "--root", store, "--requester", "claim-1",
  ], { cwd: target, encoding: "utf8", env: proof ? proofInstallEnv() : process.env });
  return { root, store, checkout, donor, consumer, generation, offending, corrupt, snapshot, prime };
}

function managedRepo(t: TestContext, donor: string) {
  const repo = gitRepo({ scope: t, kind: "prime-managed" });
  inputs(repo.dir);
  cpSync(join(donor, "node_modules"), join(repo.dir, "node_modules"), { recursive: true });
  repo.git("add", "package.json", "package-lock.json");
  repo.git("commit", "-m", "test: commit dependency inputs");
  repo.addRemote("origin", repo.dir);
  return repo;
}

function cliReceipt(stderr: string): DependencyGenerationRefusalReceipt {
  const objects = stderr.split("\n").filter(line => line.startsWith("{"));
  assert.equal(objects.length, 1, stderr);
  return JSON.parse(objects[0]);
}

test("a refused ready generation throws one receipt and the prime CLI prints it as JSON", (t) => {
  const f = fixture(t, true);
  f.corrupt();
  const target = f.checkout("target");
  const child = f.prime(target);
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.stdout, "");
  const receipt = cliReceipt(child.stderr);
  assert.throws(() => materializeDependencySeed(target, { root: f.store, proof: true, env: proofInstallEnv(), requester: "claim-1" }),
    (error: Error & { receipt?: DependencyGenerationRefusalReceipt }) => {
      assert.equal(error.name, "DependencyGenerationRefusedError");
      assert.deepEqual(error.receipt, receipt);
      return true;
    });
  assert.equal(receipt.kind, "generation_refused");
  assert.equal(receipt.generation, f.generation.key);
  assert.equal(receipt.seed, f.generation.seed);
  assert.equal(receipt.mode, "proof");
  assert.equal(receipt.reason, "immutable dependency payload is writable or unverified");
  const stat = lstatSync(f.offending);
  assert.deepEqual(receipt.offending, { path: f.offending, mode: stat.mode & 0o7777, uid: stat.uid });
  assert.deepEqual(receipt.requester, { checkout: target, id: "claim-1" });
  assert.equal(receipt.disposition, "kept-referenced");
  assert.match(receipt.recovery, /fresh absolute RMD_DEPENDENCY_SEED_ROOT/);
  const [consumer] = receipt.consumers;
  assert.equal(receipt.consumers.length, 1);
  assert.ok(consumer);
  assert.equal(consumer.checkout, f.consumer);
  assert.equal(consumer.mountNamespace, process.platform === "linux" ? readlinkSync("/proc/self/ns/mnt") : "host");
  assert.equal(consumer.references, true);

  rmSync(join(f.consumer, marker));
  writeFileSync(join(f.generation.seed, "consumers", "broken.json"), "{");
  assert.throws(() => materializeDependencySeed(target, { root: f.store, proof: true, env: proofInstallEnv() }),
    (error: Error & { receipt: DependencyGenerationRefusalReceipt }) => {
    assert.equal(error.receipt.mode, "proof");
    assert.equal(error.receipt.disposition, "kept-unreferenced");
    assert.ok(error.receipt.consumers.some((row: { references: unknown }) => row.references === false));
    assert.ok(error.receipt.consumers.some((row: { registration: string; references: unknown }) =>
      row.registration === "broken.json" && row.references === "unread"));
    return true;
  });
});

test("a refusal leaves the generation byte- and mode-unchanged and the sweep keeps it as referenced", (t) => {
  const f = fixture(t, true);
  f.corrupt();
  const before = f.snapshot();
  const child = f.prime(f.checkout("target"));
  assert.equal(child.status, 1);
  assert.equal(cliReceipt(child.stderr).disposition, "kept-referenced");
  assert.deepEqual(sweepDependencySeeds(f.store, { apply: true, now: DEPENDENCY_SEED_MIN_IDLE_MS + 1, isOpen: () => false }), [
    { seed: f.generation.seed, action: "keep", reason: "referenced by checkout" },
  ]);
  assert.deepEqual(f.snapshot(), before);
});

test("a refused proof prime fails closed in ensureDeps and worktree provisioning", async (t) => {
  const f = fixture(t, true);
  f.corrupt();
  const sync = f.checkout("sync"), async = f.checkout("async");
  for (const checkout of [sync, async]) registerReviewerCheckout(checkout);
  assert.equal(ensureDeps(sync), false);
  const pending = ensureDepsAsync(async);
  assert.equal(ensureDeps(async), false, "a sync proof cannot pass a prime awaiting its receipt");
  assert.deepEqual(await Promise.all([pending, ensureDepsAsync(async)]), [false, false]);
  assert.equal(ensureDeps(sync), false, "a memoized refusal must remain closed");
  assert.equal(await ensureDepsAsync(sync), false);
  for (const checkout of [sync, async]) assert.ok(!existsSync(join(checkout, "node_modules")));
  const installs = readFileSync(join(f.root, "Remudero/state/ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(installs.length, 2);
  for (const row of installs) {
    assert.equal(row.step, "review.proof_install");
    assert.equal(row.ok, false);
    assert.equal(row.receipt.generation, f.generation.key);
  }

  const managed = materializeDependencySeed(f.checkout("managed-consumer"), { root: f.store, sourceDir: f.donor });
  assert.equal(managed.status, "materialized");
  const offending = join(managed.seed, "node_modules/tsx/index.mjs");
  chmodSync(offending, lstatSync(offending).mode | 0o200);
  const repo = managedRepo(t, f.donor);
  const target = join(f.root, "managed");
  const rows: Array<Record<string, unknown> | undefined> = [];
  await assert.rejects(worktreeAddAsync(repo.dir, target, "run-generation-refused", "origin/main", {
    log: (step, row) => { if (step === "worktree.node_modules") rows.push(row); },
  }), (error: WorktreeNodeModulesRefusedError) => {
    assert.ok(error instanceof WorktreeNodeModulesRefusedError);
    assert.equal(error.reasonClass, "blocked_toolchain");
    assert.equal(error.details?.receipt, rows[0]?.receipt);
    assert.equal(error.outcome, "refused");
    const receipt = error.details?.receipt as DependencyGenerationRefusalReceipt;
    assert.equal(receipt.generation, managed.key);
    assert.equal(receipt.mode, "development");
    assert.deepEqual(receipt.requester, { checkout: target, id: "run-generation-refused" });
    return true;
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.outcome, "refused");
  assert.ok(!existsSync(join(target, "node_modules")));
});

test("the prime child env strips loader options and primes a node_modules-empty target", async (t) => {
  const f = fixture(t);
  const target = f.checkout("target");
  process.env.NODE_OPTIONS = '--import=tsx --enable-source-maps --require "two words.cjs" -r node:path --loader fake --experimental-loader=fake';
  assert.ok(!existsSync(join(target, "node_modules")));
  const outcome = await provisionWorktreeNodeModules(f.donor, target, {
    execPrime: (file, args, options) => {
      assert.equal(options.env?.NODE_OPTIONS, "--enable-source-maps");
      return execFileRouted(file, args, options);
    },
  });
  assert.equal(outcome, "linked");
  assert.ok(lstatSync(join(target, "node_modules")).isDirectory());
  assert.equal(process.env.NODE_OPTIONS.includes("--import=tsx"), true);

  process.env.RMD_DEPENDENCY_SEED_ROOT = "";
  const legacy = f.checkout("legacy");
  assert.equal(await provisionWorktreeNodeModules(f.donor, legacy), "linked");
  assert.equal(lstatSync(join(legacy, "node_modules")).isSymbolicLink(), true);
});

test("a prime child failure with a seed root configured refuses the worktree with a child-failure receipt", async (t) => {
  const f = fixture(t);
  const repo = managedRepo(t, f.donor);
  const target = join(f.root, "loader-failed"), run = "run-loader-failed";
  process.env.NODE_OPTIONS = "--import=tsx";
  const rows: Array<Record<string, unknown> | undefined> = [];
  await assert.rejects(worktreeAddAsync(repo.dir, target, run, "origin/main", {
    log: (step, row) => { if (step === "worktree.node_modules") rows.push(row); },
    execPrime: (file, args, options) => execFileRouted(file, args, { ...options, env: process.env }),
  }), (error: WorktreeNodeModulesRefusedError) => {
    assert.equal(error.reasonClass, "blocked_toolchain");
    assert.equal(rows[0]?.receipt, error.details?.receipt);
    const receipt = error.details?.receipt as Record<string, unknown>;
    assert.equal(receipt.kind, "child_failed");
    assert.equal(receipt.exit, 1);
    assert.equal(receipt.signal, null);
    assert.equal(receipt.code, "ERR_MODULE_NOT_FOUND");
    assert.match(String(receipt.stderr_tail), /Cannot find package 'tsx'/);
    assert.equal(receipt.seed_root, f.store);
    assert.deepEqual(receipt.requester, { checkout: target, id: run });
    assert.match(String(receipt.recovery), /fresh absolute RMD_DEPENDENCY_SEED_ROOT/);
    return true;
  });
  assert.equal(rows[0]?.outcome, "refused");
  assert.ok(!existsSync(join(target, "node_modules")));

  const invalid = await provisionWorktreeNodeModules(f.donor, f.checkout("invalid"), {
    execPrime: async () => ({ stdout: "garbled", stderr: "child diagnostic" }),
  });
  assert.equal(typeof invalid === "object" && invalid.outcome, "refused");
  if (typeof invalid === "object") {
    assert.equal(invalid.receipt.kind, "child_failed");
    assert.ok("stderr_tail" in invalid.receipt);
    assert.equal(invalid.receipt.exit, 0);
    assert.equal(invalid.receipt.code, "INVALID_PRIME_RESULT");
    assert.equal(invalid.receipt.stderr_tail, "child diagnostic");
  }

  const timedOut = await provisionWorktreeNodeModules(f.donor, f.checkout("timeout"), {
    execPrime: async () => { throw new LoopBoundedChildTimeout("prime", 100, { signal: "SIGKILL", stderr: "waiting for lock" }); },
  });
  assert.equal(typeof timedOut === "object" && timedOut.outcome, "refused");
  if (typeof timedOut === "object") {
    assert.ok(timedOut.receipt.kind === "child_failed");
    assert.equal(timedOut.receipt.exit, null);
    assert.equal(timedOut.receipt.signal, "SIGKILL");
    assert.equal(timedOut.receipt.stderr_tail, "waiting for lock");
  }
});

test("a loader fault and a refused generation compose without masking each other", async (t) => {
  const f = fixture(t);
  f.corrupt();
  const before = f.snapshot();
  process.env.NODE_OPTIONS = "--import=tsx";
  const target = f.checkout("target");
  const refused = await provisionWorktreeNodeModules(f.donor, target);
  assert.equal(typeof refused === "object" && refused.outcome, "refused");
  if (typeof refused === "object") {
    assert.equal(refused.receipt.kind, "generation_refused");
    assert.ok("offending" in refused.receipt);
    assert.equal(refused.receipt.offending?.path, f.offending);
  }
  assert.deepEqual(f.snapshot(), before);
  assert.ok(!existsSync(join(target, "node_modules")));
  const recovery = join(f.root, "recovery");
  process.env.RMD_DEPENDENCY_SEED_ROOT = recovery;
  assert.equal(await provisionWorktreeNodeModules(f.donor, target), "linked");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", "console.log((await import('tsx')).loadedFrom)"],
    { cwd: target, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), `file://${realpathSync(join(target, "node_modules/tsx/index.mjs"))}`);
  assert.deepEqual(f.snapshot(), before);
});
