import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  DEPENDENCY_SEED_MIN_IDLE_MS, materializeDependencySeed, primeRefusalReceipt, SEED_PRIME_RECOVERY, seedPrimeChildEnv,
  sweepDependencySeeds, type DependencyGenerationRefusalReceipt,
} from "#src/lib/dependency-seeds.js";
import { isSpawnInfraBlockedError } from "#src/lib/ledger.js";
import { ensureDeps, ensureDepsAsync, proofInstallEnv } from "#src/lib/review.js";
import { provisionWorktreeNodeModules, WorktreeNodeModulesRefusedError, worktreeAddAsync } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "scripts", "dependency-seeds.mjs");
const execFileAsync = promisify(execFile);
const PACKAGE = JSON.stringify({ name: "w1-t12120-fixture", version: "1.0.0", dependencies: { tsx: "1.0.0" } });
const LOCK = JSON.stringify({
  name: "w1-t12120-fixture", lockfileVersion: 3,
  packages: { "": { name: "w1-t12120-fixture" }, "node_modules/tsx": { version: "1.0.0" } },
});
const LOADER = "--import=tsx --enable-source-maps";

type ExecPrime = NonNullable<NonNullable<Parameters<typeof provisionWorktreeNodeModules>[2]>["execPrime"]>;
type Row = [string, Record<string, unknown> | undefined];

function writable(path: string): void {
  const s = lstatSync(path, { throwIfNoEntry: false });
  if (!s || s.isSymbolicLink()) return;
  chmodSync(path, s.mode | 0o700);
  if (s.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name));
}

function scratch(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-w1-t12120-")));
  t.after(() => { writable(dir); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function inputs(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), PACKAGE);
  writeFileSync(join(dir, "package-lock.json"), LOCK);
  return dir;
}

/** A real install whose one package is a stand-in `tsx`: importing it marks the process, so a child's
 * `--import=tsx` proves which tree it resolved from. */
function installInto(dir: string): void {
  const pkg = join(dir, "node_modules", "tsx");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "tsx", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(pkg, "index.js"), "globalThis.W1_T12120_TSX = \"seeded\";\n");
}

function donorAt(dir: string): string {
  inputs(dir);
  installInto(dir);
  return dir;
}

function primeCli(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, "prime", ...args], {
    cwd, env, encoding: "utf8", timeout: 60_000,
  });
}

/** Prime `consumer` from `donor` into `root`, returning the generation it now references. */
function primeGeneration(root: string, donor: string, consumer: string, env: NodeJS.ProcessEnv, proof: boolean, cwd: string) {
  const run = primeCli([consumer, "--root", root, "--source", donor, ...(proof ? ["--proof"] : [])], env, cwd);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout) as { status: string; key: string; seed: string };
  assert.equal(result.status, "materialized");
  return result;
}

/** Every path under `dir` with its mode, owner and content (or link target). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string): void => {
    const st = lstatSync(path);
    const head = `${(st.mode & 0o7777).toString(8)}:${st.uid}`;
    if (st.isSymbolicLink()) out[path] = `l ${head} ${readlinkSync(path)}`;
    else if (st.isFile()) out[path] = `f ${head} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    else {
      out[path] = `d ${head}`;
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    }
  };
  walk(dir);
  return out;
}

async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try { return await body(); }
  finally { apply(saved); }
}

/** The worker's prime child, run for real. `strip: false` hands the child the parent's NODE_OPTIONS back,
 * which is what the spawn did before seedPrimeChildEnv. */
function realPrime(seen: NodeJS.ProcessEnv[], strip = true): ExecPrime {
  return (async (file: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const env = strip ? { ...options.env } : { ...options.env, NODE_OPTIONS: process.env.NODE_OPTIONS };
    if (env.NODE_OPTIONS === undefined) delete env.NODE_OPTIONS;
    seen.push(env);
    const { stdout, stderr } = await execFileAsync(file, [...args], { cwd: options.cwd, env, encoding: "utf8", timeout: 60_000 });
    return { stdout, stderr };
  }) as unknown as ExecPrime;
}

function noNodeModules(dir: string): boolean {
  return lstatSync(join(dir, "node_modules"), { throwIfNoEntry: false }) === undefined;
}

function generations(root: string): string[] {
  return existsSync(root) ? readdirSync(root).filter((name) => /^[a-f0-9]{64}$/.test(name)) : [];
}

/** A git origin whose committed inputs match the fixture, plus the canonical clone's own installed tree. */
function originRepo(t: TestContext) {
  const repo = gitRepo({ scope: t, kind: "w1-t12120" });
  inputs(repo.dir);
  repo.git("add", "package.json", "package-lock.json");
  repo.git("commit", "--quiet", "-m", "chore: seed package");
  repo.addRemote("origin", repo.dir);
  installInto(repo.dir);
  return repo;
}

function refusalOf(rows: Row[]): Record<string, unknown> | undefined {
  return rows.find(([step]) => step === "worktree.node_modules")?.[1];
}

test("a refused ready generation throws one receipt and the prime CLI prints it as JSON", (t) => {
  const dir = scratch(t);
  const root = join(dir, "seeds");
  const env = proofInstallEnv();
  const donor = donorAt(join(dir, "donor"));
  const consumer = inputs(join(dir, "consumer"));
  const generation = primeGeneration(root, donor, consumer, env, true, dir);
  const payload = join(generation.seed, "node_modules", "tsx", "index.js");
  assert.equal(statSync(payload).mode & 0o222, 0, "a ready generation's payload is read-only");
  writable(payload);
  // An unreadable consumer row is listed as unread, never dropped.
  writeFileSync(join(generation.seed, "consumers", "unreadable.json"), "{not json");

  const fresh = inputs(join(dir, "fresh"));
  let thrown: unknown;
  try { materializeDependencySeed(fresh, { root, proof: true, requester: "run-w1-t12120", env }); }
  catch (error) { thrown = error; }
  const receipt = primeRefusalReceipt(thrown) as DependencyGenerationRefusalReceipt;
  assert.ok(receipt, `expected a generation receipt, got ${String(thrown)}`);
  assert.equal(receipt.kind, "generation_refused");
  assert.equal(receipt.generation, generation.key);
  assert.equal(receipt.seed, generation.seed);
  assert.equal(receipt.mode, "proof");
  assert.match(receipt.reason, /immutable dependency payload is writable or unverified/);
  assert.deepEqual(receipt.offending, { path: payload, mode: 0o744, uid: process.getuid?.() ?? null });
  assert.deepEqual(receipt.requester, { checkout: fresh, id: "run-w1-t12120" });
  assert.equal(receipt.disposition, "kept-referenced");
  assert.equal(receipt.recovery, SEED_PRIME_RECOVERY);
  assert.match(receipt.recovery, /fresh absolute RMD_DEPENDENCY_SEED_ROOT/);
  assert.equal(receipt.consumers.length, 2);
  const registered = receipt.consumers.find((row) => row.registration !== "unreadable.json");
  assert.equal(registered?.checkout, consumer);
  assert.equal(registered?.references, true);
  assert.equal(typeof registered?.mountNamespace, "string");
  const unread = receipt.consumers.find((row) => row.registration === "unreadable.json");
  assert.equal(unread?.references, "unread");
  assert.equal(unread?.checkout, null);
  assert.equal(typeof unread?.error, "string");
  assert.ok(noNodeModules(fresh), "a refused prime materializes nothing");

  const cli = primeCli([fresh, "--proof", "--root", root, "--requester", "run-w1-t12120"], env, dir);
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(cli.stdout, "");
  const jsonLines = cli.stderr.split("\n").filter((line) => line.startsWith("{"));
  assert.equal(jsonLines.length, 1, cli.stderr);
  assert.deepEqual(JSON.parse(jsonLines[0]!), receipt);
  assert.deepEqual(primeRefusalReceipt(cli.stderr), receipt);
  assert.doesNotMatch(cli.stderr, /^dependency-seeds: /m);
  assert.ok(noNodeModules(fresh));

  // Every other error keeps today's line.
  const missing = primeCli([join(dir, "absent"), "--root", root], env, dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^dependency-seeds: /m);
  assert.equal(primeRefusalReceipt(missing.stderr), undefined);
});

test("a refusal leaves the generation byte- and mode-unchanged and the sweep keeps it as referenced", (t) => {
  const dir = scratch(t);
  const root = join(dir, "seeds");
  const env = proofInstallEnv();
  const donor = donorAt(join(dir, "donor"));
  const consumer = inputs(join(dir, "consumer"));
  const generation = primeGeneration(root, donor, consumer, env, true, dir);
  writable(join(generation.seed, "node_modules", "tsx", "index.js"));
  const before = snapshot(generation.seed);

  const refused = primeCli([inputs(join(dir, "fresh")), "--proof", "--root", root], env, dir);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(primeRefusalReceipt(refused.stderr)?.disposition, "kept-referenced");
  assert.deepEqual(snapshot(generation.seed), before, "the refusal repaired or removed part of the generation");

  const later = Date.now() + DEPENDENCY_SEED_MIN_IDLE_MS + 60 * 60_000;
  const swept = sweepDependencySeeds(root, { apply: true, now: later, isOpen: () => false });
  assert.deepEqual(swept.filter((row) => row.seed === generation.seed),
    [{ seed: generation.seed, action: "keep", reason: "referenced by checkout" }]);
  assert.deepEqual(snapshot(generation.seed), before);

  // Control: with the consumer's marker gone the receipt reads kept-unreferenced, and the sweep's own rules decide.
  writable(join(consumer, "node_modules"));
  rmSync(join(consumer, "node_modules"), { recursive: true, force: true });
  const unreferenced = primeCli([inputs(join(dir, "fresh-2")), "--proof", "--root", root], env, dir);
  assert.equal(unreferenced.status, 1, unreferenced.stderr);
  const receipt = primeRefusalReceipt(unreferenced.stderr);
  assert.equal(receipt?.disposition, "kept-unreferenced");
  assert.deepEqual(receipt?.consumers.map((row) => [row.checkout, row.references]), [[consumer, false]]);
  assert.deepEqual(snapshot(generation.seed), before);
  assert.deepEqual(sweepDependencySeeds(root, { now: later, isOpen: () => false }).filter((row) => row.seed === generation.seed),
    [{ seed: generation.seed, action: "remove", reason: "unreferenced and idle for six hours" }]);
  assert.deepEqual(snapshot(generation.seed), before);
});

test("a refused proof prime fails closed in ensureDeps and worktree provisioning", async (t) => {
  const dir = scratch(t);
  const proofRoot = join(dir, "proof-seeds");
  const env = proofInstallEnv();
  const donor = donorAt(join(dir, "donor"));
  const generation = primeGeneration(proofRoot, donor, inputs(join(dir, "consumer")), env, true, dir);
  const payload = join(generation.seed, "node_modules", "tsx", "index.js");
  const readOnly = statSync(payload).mode & 0o7777;
  writable(payload);

  await withEnv({ RMD_DEPENDENCY_SEED_ROOT: proofRoot }, async () => {
    const failures: unknown[] = [];
    const exec = ((file: string, args: readonly string[], options: object) => {
      try { return execFileSync(file, args, options); }
      catch (error) { failures.push(error); throw error; }
    }) as unknown as typeof execFileSync;
    const sync = inputs(join(dir, "review-sync"));
    assert.equal(ensureDeps(sync, exec), false, "a refused proof prime must not report dependencies as available");
    assert.equal(ensureDeps(sync, exec), false, "the refusal holds for the checkout");
    assert.equal(primeRefusalReceipt((failures[0] as { stderr?: unknown }).stderr)?.generation, generation.key);
    assert.ok(noNodeModules(sync));
    const asyncTree = inputs(join(dir, "review-async"));
    assert.equal(await ensureDepsAsync(asyncTree), false);
    assert.ok(noNodeModules(asyncTree));

    // Control: a healthy generation primes as today.
    chmodSync(payload, readOnly);
    const healthy = inputs(join(dir, "review-healthy"));
    assert.equal(ensureDeps(healthy), true);
    assert.ok(lstatSync(join(healthy, "node_modules")).isDirectory());
  });

  const devRoot = join(dir, "dev-seeds");
  const devEnv = seedPrimeChildEnv(process.env);
  const dev = primeGeneration(devRoot, donor, inputs(join(dir, "dev-consumer")), devEnv, false, dir);
  writable(join(dev.seed, "node_modules", "tsx", "index.js"));
  const repo = originRepo(t);
  const canonical = join(repo.dir, "node_modules");
  await withEnv({ RMD_DEPENDENCY_SEED_ROOT: devRoot }, async () => {
    const rows: Row[] = [];
    const worktree = join(dir, "worktree-refused");
    await assert.rejects(worktreeAddAsync(repo.dir, worktree, "run-w1-t12120-refused", "origin/main", {
      resolveSource: () => canonical, execPrime: realPrime([]), log: (step, extra) => rows.push([step, extra]),
    }), (error: unknown) => {
      assert.ok(error instanceof WorktreeNodeModulesRefusedError, String(error));
      assert.equal(error.reasonClass, "blocked_toolchain");
      assert.equal(isSpawnInfraBlockedError(error), true);
      assert.equal(error.outcome, "refused");
      assert.match(error.message, /immutable dependency payload is writable or unverified/);
      return true;
    });
    const row = refusalOf(rows);
    assert.equal(row?.outcome, "refused");
    const receipt = row?.receipt as DependencyGenerationRefusalReceipt | undefined;
    assert.equal(receipt?.kind, "generation_refused");
    assert.equal(receipt?.generation, dev.key);
    assert.equal(receipt?.mode, "development");
    assert.deepEqual(receipt?.requester, { checkout: worktree, id: "run-w1-t12120-refused" });
    assert.ok(noNodeModules(worktree), "the worktree must not continue on the canonical clone's tree");
  });

  // Control: an unset seed root falls back as today, linking the canonical clone's install.
  await withEnv({ RMD_DEPENDENCY_SEED_ROOT: "" }, async () => {
    const rows: Row[] = [];
    const worktree = join(dir, "worktree-unconfigured");
    await worktreeAddAsync(repo.dir, worktree, "run-w1-t12120-unconfigured", "origin/main", {
      resolveSource: () => canonical, execPrime: realPrime([]), log: (step, extra) => rows.push([step, extra]),
    });
    assert.equal(refusalOf(rows)?.outcome, "linked");
    assert.equal(realpathSync(join(worktree, "node_modules")), realpathSync(canonical));
  });
});

test("the prime child env strips loader options and primes a node_modules-empty target", async (t) => {
  const parent = { NODE_OPTIONS: LOADER, KEEP: "1" };
  assert.deepEqual(seedPrimeChildEnv(parent), { NODE_OPTIONS: "--enable-source-maps", KEEP: "1" });
  assert.deepEqual(parent, { NODE_OPTIONS: LOADER, KEEP: "1" }, "the parent env is copied, never edited");
  assert.equal(seedPrimeChildEnv({
    NODE_OPTIONS: "--require ./a.cjs -r b --loader c --experimental-loader=d --import e --max-old-space-size=512",
  }).NODE_OPTIONS, "--max-old-space-size=512");
  assert.equal("NODE_OPTIONS" in seedPrimeChildEnv({ NODE_OPTIONS: "--import tsx", PATH: "/bin" }), false);
  assert.equal("NODE_OPTIONS" in seedPrimeChildEnv({ PATH: "/bin" }), false);

  const dir = scratch(t);
  const donor = donorAt(join(dir, "donor"));
  const root = join(dir, "seeds");
  await withEnv({ NODE_OPTIONS: LOADER, RMD_DEPENDENCY_SEED_ROOT: root }, async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const target = inputs(join(dir, "target"));
    const outcome = await provisionWorktreeNodeModules(donor, target, {
      resolveSource: () => join(donor, "node_modules"), execPrime: realPrime(seen),
    });
    assert.equal(outcome, "linked");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.NODE_OPTIONS, "--enable-source-maps");
    const modules = lstatSync(join(target, "node_modules"));
    assert.ok(modules.isDirectory() && !modules.isSymbolicLink(), "the target gains its own node_modules");
    assert.equal(generations(root).length, 1);

    // The same fixture with the strip removed dies before prime runs.
    const bypassRoot = join(dir, "bypass-seeds");
    const bypassed = inputs(join(dir, "target-bypassed"));
    const result = await withEnv({ RMD_DEPENDENCY_SEED_ROOT: bypassRoot }, () =>
      provisionWorktreeNodeModules(donor, bypassed, { resolveSource: () => join(donor, "node_modules"), execPrime: realPrime([], false) }));
    assert.equal(typeof result, "object");
    if (typeof result !== "object") return;
    assert.equal(result.outcome, "refused");
    assert.equal(result.receipt.kind, "child_failed");
    if (result.receipt.kind !== "child_failed") return;
    assert.equal(result.receipt.code, "ERR_MODULE_NOT_FOUND");
    assert.ok(noNodeModules(bypassed));
    assert.equal(existsSync(bypassRoot), false, "the child died before prime created its store");
  });
});

test("a prime child failure with a seed root configured refuses the worktree with a child-failure receipt", async (t) => {
  const dir = scratch(t);
  const root = join(dir, "seeds");
  const repo = originRepo(t);
  const canonical = join(repo.dir, "node_modules");
  await withEnv({ NODE_OPTIONS: LOADER, RMD_DEPENDENCY_SEED_ROOT: root }, async () => {
    const rows: Row[] = [];
    const worktree = join(dir, "worktree");
    await assert.rejects(worktreeAddAsync(repo.dir, worktree, "run-w1-t12120-child", "origin/main", {
      resolveSource: () => canonical, execPrime: realPrime([], false), log: (step, extra) => rows.push([step, extra]),
    }), (error: unknown) => {
      assert.ok(error instanceof WorktreeNodeModulesRefusedError, String(error));
      assert.equal(isSpawnInfraBlockedError(error), true);
      assert.equal(error.outcome, "refused");
      assert.match(error.message, /dependency seed prime child failed \(ERR_MODULE_NOT_FOUND\)/);
      return true;
    });
    const row = refusalOf(rows);
    assert.equal(row?.outcome, "refused");
    const receipt = row?.receipt as Record<string, unknown> | undefined;
    assert.equal(receipt?.kind, "child_failed");
    assert.equal(receipt?.exit, 1);
    assert.equal(receipt?.signal, null);
    assert.equal(receipt?.code, "ERR_MODULE_NOT_FOUND");
    assert.match(String(receipt?.stderr_tail), /tsx/);
    assert.equal(receipt?.seed_root, root);
    assert.deepEqual(receipt?.requester, { checkout: worktree, id: "run-w1-t12120-child" });
    assert.equal(receipt?.recovery, SEED_PRIME_RECOVERY);
    assert.ok(noNodeModules(worktree), "the worktree never links the canonical clone's node_modules");
  });

  // Unparseable stdout and a killed child are refusals too, never "failed" (which falls back to a link).
  await withEnv({ RMD_DEPENDENCY_SEED_ROOT: root }, async () => {
    const garbled = await provisionWorktreeNodeModules(repo.dir, inputs(join(dir, "garbled")), {
      resolveSource: () => canonical,
      execPrime: (async () => ({ stdout: "not json", stderr: "" })) as unknown as ExecPrime,
    });
    assert.ok(typeof garbled === "object" && garbled.outcome === "refused" && garbled.receipt.kind === "child_failed");
    if (typeof garbled === "object" && garbled.receipt.kind === "child_failed") {
      assert.equal(garbled.receipt.exit, 0);
      assert.equal(garbled.receipt.code, "INVALID_PRIME_RESULT");
    }
    const killed = await provisionWorktreeNodeModules(repo.dir, inputs(join(dir, "killed")), {
      resolveSource: () => canonical,
      execPrime: (async () => { throw Object.assign(new Error("timed out"), { signal: "SIGKILL", code: null, stderr: "" }); }) as unknown as ExecPrime,
    });
    assert.ok(typeof killed === "object" && killed.outcome === "refused" && killed.receipt.kind === "child_failed");
    if (typeof killed === "object" && killed.receipt.kind === "child_failed") {
      assert.equal(killed.receipt.signal, "SIGKILL");
      assert.equal(killed.receipt.exit, null);
    }
  });
});

test("a loader fault and a refused generation compose without masking each other", async (t) => {
  const dir = scratch(t);
  const root = join(dir, "seeds");
  const donor = donorAt(join(dir, "donor"));
  const generation = primeGeneration(root, donor, inputs(join(dir, "consumer")), seedPrimeChildEnv(process.env), false, dir);
  writable(join(generation.seed, "node_modules", "tsx", "index.js"));
  const before = snapshot(generation.seed);
  const repo = originRepo(t);
  const canonical = join(repo.dir, "node_modules");

  await withEnv({ NODE_OPTIONS: "--import=tsx", RMD_DEPENDENCY_SEED_ROOT: root }, async () => {
    const rows: Row[] = [];
    const worktree = join(dir, "worktree");
    await assert.rejects(worktreeAddAsync(repo.dir, worktree, "run-w1-t12120-composed", "origin/main", {
      resolveSource: () => canonical, execPrime: realPrime([]), log: (step, extra) => rows.push([step, extra]),
    }), (error: unknown) => {
      assert.ok(error instanceof WorktreeNodeModulesRefusedError, String(error));
      assert.equal(isSpawnInfraBlockedError(error), true);
      assert.doesNotMatch(error.message, /ERR_MODULE_NOT_FOUND/);
      return true;
    });
    const receipt = refusalOf(rows)?.receipt as DependencyGenerationRefusalReceipt | undefined;
    assert.equal(receipt?.kind, "generation_refused", "the loader fault must not mask the generation refusal");
    assert.equal(receipt?.generation, generation.key);
    assert.equal(receipt?.disposition, "kept-referenced");
    assert.deepEqual(snapshot(generation.seed), before);
    assert.ok(noNodeModules(worktree));
  });

  // The same parent environment, pointed at a fresh healthy root, primes the target's own install.
  const fresh = join(dir, "fresh-seeds");
  await withEnv({ NODE_OPTIONS: "--import=tsx", RMD_DEPENDENCY_SEED_ROOT: fresh }, async () => {
    const target = inputs(join(dir, "target"));
    assert.equal(await provisionWorktreeNodeModules(donor, target, {
      resolveSource: () => join(donor, "node_modules"), execPrime: realPrime([]),
    }), "linked");
    const proof = spawnSync(process.execPath, ["-e", "process.stdout.write(String(globalThis.W1_T12120_TSX))"], {
      cwd: target, env: { ...process.env, NODE_OPTIONS: "--import=tsx" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(proof.status, 0, proof.stderr);
    assert.equal(proof.stdout, "seeded", "a check-proof child resolves tsx from the target's own node_modules");
  });
  assert.deepEqual(snapshot(generation.seed), before);
});
