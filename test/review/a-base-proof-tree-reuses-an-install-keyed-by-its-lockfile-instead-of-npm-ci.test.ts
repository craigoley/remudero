// W1-T13974: a reviewer's own proof checkout (a base or head tree it cut for a proof) used to run a full
// `npm ci` whenever the account had not opted in to dependency seeds — every fleet reviewer, since no daemon
// container carries dependency-seeds.json. It now primes from a lockfile-keyed store under the instance's state
// dir. These tests drive ensureDeps and ensureDepsAsync against a temp HOME whose config names a temp instance
// root (so the state dir resolves exactly as the daemon resolves it), a fake `npm` first on PATH that logs every
// call, and the real dependency-seeds prime child.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { dependencySeedIdentity, materializeDependencySeed, sweepDependencySeeds } from "#src/lib/dependency-seeds.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import {
  ensureDeps,
  ensureDepsAsync,
  execWhitelistedProof,
  parseWhitelistedProof,
  pinnedVitestCli,
  PROOF_INSTALL_ARGS,
  registerReviewerCheckout,
} from "#src/lib/review.js";

const STORE = "proof-dependency-seeds";
const SEED_KEY = /^[a-f0-9]{64}$/;

interface World {
  root: string;
  home: string;
  state: string;
  store: string;
  log: string;
  checkouts: number;
}

interface NpmCall {
  argv: string[];
  cwd: string;
}

interface InstallRow {
  step: string;
  checkout: string;
  install: string;
  seed_key: string | null;
  seed_store: string | null;
  ok: boolean;
  reason: string | null;
  wall_ms: number;
}

/** A fake npm: logs argv and cwd, answers --version, and `ci` writes every lockfile package after a short wait so
 *  two concurrent primes genuinely overlap. */
function fakeNpm(log: string): string {
  return `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
if (process.argv[2] === "--version") { console.log("10.9.9"); process.exit(0); }
if (process.argv[2] === "ci") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  for (const [name, pkg] of Object.entries(lock.packages || {})) {
    if (!name.startsWith("node_modules/")) continue;
    const dir = path.join("node_modules", name.slice("node_modules/".length));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: name.slice("node_modules/".length), version: pkg.version }));
    fs.writeFileSync(path.join(dir, "vitest.mjs"), "");
  }
}
`;
}

function world(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-proof-seed-")));
  const home = join(root, "home");
  const instance = join(root, "instance");
  const state = join(instance, "state");
  const bin = join(root, "bin");
  const log = join(root, "npm.log");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root: instance }));
  writeFileSync(join(bin, "npm"), fakeNpm(log), { mode: 0o755 });
  writeFileSync(log, "");
  return { root, home, state, store: join(state, STORE), log, checkouts: 0 };
}

function checkout(w: World, vitest = "5.0.5"): string {
  const dir = join(w.root, `checkout-${++w.checkouts}`);
  mkdirSync(join(dir, "tests", "unit"), { recursive: true });
  const manifest = { name: "seed-fixture", version: "1.0.0", dependencies: { vitest } };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({
    name: "seed-fixture", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": manifest, "node_modules/vitest": { version: vitest } },
  }));
  writeFileSync(join(dir, "tests", "unit", "seeded.test.ts"), `test("a seeded proof", () => {});\n`);
  return dir;
}

function owned(w: World, vitest?: string): string {
  const dir = checkout(w, vitest);
  registerReviewerCheckout(dir);
  return dir;
}

/** Runs `body` with HOME, PATH and RMD_DEPENDENCY_SEED_ROOT pointed at the world, then restores all three. */
async function inWorld(w: World, seedRoot: string | undefined, body: () => void | Promise<void>): Promise<void> {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, RMD_DEPENDENCY_SEED_ROOT: process.env.RMD_DEPENDENCY_SEED_ROOT };
  process.env.HOME = w.home;
  process.env.PATH = `${join(w.root, "bin")}:${saved.PATH ?? ""}`;
  if (seedRoot === undefined) delete process.env.RMD_DEPENDENCY_SEED_ROOT;
  else process.env.RMD_DEPENDENCY_SEED_ROOT = seedRoot;
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // A published seed generation is read-only by design; give the owner write back so the fixture can go.
    execFileSync("chmod", ["-R", "u+w", w.root]);
    rmSync(w.root, { recursive: true, force: true });
  }
}

function npmCalls(w: World): NpmCall[] {
  return readFileSync(w.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as NpmCall);
}

function installs(w: World): NpmCall[] {
  return npmCalls(w).filter((call) => call.argv[0] === "ci");
}

function rows(w: World): InstallRow[] {
  const ledger = join(w.state, LEDGER_FILENAME);
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as InstallRow)
    .filter((row) => row.step === "review.proof_install");
}

function seeds(w: World): string[] {
  return existsSync(w.store) ? readdirSync(w.store).filter((name) => SEED_KEY.test(name)).sort() : [];
}

function recordingExec(calls: string[][]): typeof execFileSync {
  return ((command: string, args: readonly string[], options: object) => {
    calls.push([command, ...args]);
    return execFileSync(command, args, options);
  }) as typeof execFileSync;
}

function installedVitest(dir: string): string | undefined {
  return (JSON.parse(readFileSync(join(dir, "node_modules", "vitest", "package.json"), "utf8")) as { version?: string }).version;
}

const isSeedPrime = (call: readonly string[], root: string) =>
  call[0] === process.execPath && call.includes("prime") && call.includes("--proof") && call[call.indexOf("--root") + 1] === root;

test("W1-T13974 criterion 1: a reviewer's proof tree with no configured seed root primes from the state-dir store, and a second tree on its lockfile runs no npm install", async () => {
  const w = world();
  await inWorld(w, undefined, () => {
    const first = owned(w), second = owned(w);
    const calls: string[][] = [];
    assert.equal(ensureDeps(first, recordingExec(calls), pinnedVitestCli(first)), true, "the first tree gets its runner");
    assert.equal(calls.length, 1, `one install command for the first tree: ${JSON.stringify(calls)}`);
    assert.ok(isSeedPrime(calls[0]!, w.store), `the first tree is primed from the state-dir store, not npm ci: ${JSON.stringify(calls[0])}`);
    assert.equal(installs(w).length, 1, "the store's first generation is one npm install");
    assert.equal(ensureDeps(second, recordingExec(calls), pinnedVitestCli(second)), true, "the second tree gets its runner");
    assert.ok(isSeedPrime(calls[1]!, w.store), "the second tree goes to the same store");
    assert.equal(installs(w).length, 1, "the second tree on the same lockfile runs no npm install");
    assert.deepEqual(npmCalls(w).filter((call) => call.cwd === second).map((call) => call.argv), [["--version"]],
      "the second tree's only npm call is the seed identity's version read: no install runs there");
    assert.deepEqual(npmCalls(w).filter((call) => call.argv[0] !== "--version" && call.argv[0] !== "ci"), [],
      "npm's only other call is the seed identity's version read");
    assert.equal(seeds(w).length, 1, "one lockfile, one seed generation");
    for (const dir of [first, second]) {
      assert.equal(lstatSync(join(dir, "node_modules")).isSymbolicLink(), false, "a proof tree gets a real install of its own");
      assert.equal(installedVitest(dir), "5.0.5");
    }
    assert.ok(!calls.some((call) => call[0] === "npm"), "npm ci never ran");
  });
});

test("W1-T13974 criterion 1: the asynchronous review path primes from the same state-dir store", async () => {
  const w = world();
  await inWorld(w, undefined, async () => {
    const first = owned(w), second = owned(w);
    assert.equal(await ensureDepsAsync(first, pinnedVitestCli(first)), true);
    assert.equal(await ensureDepsAsync(second, pinnedVitestCli(second)), true);
    assert.equal(installs(w).length, 1, "one npm install between both trees");
    assert.ok(installs(w).every((call) => call.cwd !== first && call.cwd !== second), "npm ci ran in the store's stage, never in a proof tree");
    assert.equal(seeds(w).length, 1);
    assert.equal(installedVitest(second), "5.0.5");
  });
});

test("W1-T13974 criterion 2: two proof trees on one lockfile primed at the same time make one install between them, and a changed lockfile installs exactly once", async () => {
  const w = world();
  await inWorld(w, undefined, async () => {
    const a = owned(w), b = owned(w);
    assert.deepEqual(await Promise.all([ensureDepsAsync(a, pinnedVitestCli(a)), ensureDepsAsync(b, pinnedVitestCli(b))]), [true, true]);
    assert.equal(installs(w).length, 1, "the second prime waited on the seed key's lock and linked the same seed");
    const together = rows(w);
    assert.deepEqual(together.map((row) => row.install).sort(), ["fresh", "reused"]);
    assert.equal(together[0]!.seed_key, together[1]!.seed_key, "both trees name one seed");
    const [oldSeed] = seeds(w);

    const c = owned(w, "5.0.6"), d = owned(w, "5.0.6");
    assert.equal(await ensureDepsAsync(c, pinnedVitestCli(c)), true);
    assert.equal(ensureDeps(d, execFileSync, pinnedVitestCli(d)), true);
    assert.equal(installs(w).length, 2, "a changed lockfile installs exactly once");
    assert.equal(installedVitest(c), "5.0.6", "a changed lockfile never reuses the old install");
    assert.equal(installedVitest(d), "5.0.6");
    const changed = rows(w).slice(2);
    assert.deepEqual(changed.map((row) => row.install), ["fresh", "reused"]);
    assert.notEqual(changed[0]!.seed_key, together[0]!.seed_key, "a changed lockfile is a new seed key");
    assert.equal(seeds(w).length, 2, "the old seed is left in place");
    assert.ok(existsSync(join(w.store, oldSeed!, "ready.json")), "priming never removes the old generation");
    const swept = sweepDependencySeeds(w.store, { now: Date.now() });
    assert.deepEqual(swept.map((entry) => entry.action), ["keep", "keep"], "the old seed is left to sweepDependencySeeds");
  });
});

test("W1-T13974 criterion 3: each priming of a reviewer checkout writes one review.proof_install row naming reused, fresh or npm-ci, the seed key and its wall time", async () => {
  const w = world();
  await inWorld(w, undefined, async () => {
    const a = owned(w), b = owned(w);
    ensureDeps(a, execFileSync, pinnedVitestCli(a));
    await ensureDepsAsync(b, pinnedVitestCli(b));
    ensureDeps(a, execFileSync, pinnedVitestCli(a)); // memoised: no second priming, no second row
    const seeded = rows(w);
    assert.equal(seeded.length, 2, "one row per primed checkout");
    assert.deepEqual(seeded.map((row) => [row.checkout, row.install, row.seed_store, row.ok]), [[a, "fresh", "state-dir", true], [b, "reused", "state-dir", true]]);
    for (const row of seeded) {
      assert.match(row.seed_key ?? "", SEED_KEY, "the row names the seed key");
      assert.equal(typeof row.wall_ms, "number");
      assert.ok(row.wall_ms >= 0);
    }
    assert.equal(seeded[0]!.seed_key, seeds(w)[0], "the key is the store's generation name");

    const stranger = checkout(w);
    ensureDeps(stranger, execFileSync); // not the reviewer's checkout: npm ci as at base, and no reviewer row
    assert.equal(rows(w).length, 2, "a checkout the reviewer did not create writes no proof-install row");

    process.env.RMD_DEPENDENCY_SEED_ROOT = "";
    const disabled = owned(w);
    await ensureDepsAsync(disabled, pinnedVitestCli(disabled));
    const last = rows(w).at(-1)!;
    assert.deepEqual([last.checkout, last.install, last.seed_key, last.seed_store, last.ok], [disabled, "npm-ci", null, null, true]);
  });
});

test("W1-T13974 criterion 3: a seed prime that fails falls back to npm ci and its row says npm-ci with the prime's reason", async () => {
  const w = world();
  await inWorld(w, undefined, async () => {
    writeFileSync(w.store, "not a directory"); // every prime into this store fails
    const sync = owned(w), later = owned(w);
    const calls: string[][] = [];
    assert.equal(ensureDeps(sync, recordingExec(calls), pinnedVitestCli(sync)), true, "the fallback still installs the runner");
    assert.ok(isSeedPrime(calls[0]!, w.store), "the seed prime was tried first");
    assert.deepEqual(calls[1], ["npm", ...PROOF_INSTALL_ARGS], "then npm ci, exactly as at base");
    assert.equal(await ensureDepsAsync(later, pinnedVitestCli(later)), true);
    assert.deepEqual(installs(w).map((call) => call.cwd), [sync, later], "npm ci ran in each tree");
    const fallen = rows(w);
    assert.deepEqual(fallen.map((row) => [row.install, row.seed_key, row.seed_store, row.ok]), [["npm-ci", null, "state-dir", true], ["npm-ci", null, "state-dir", true]]);
    for (const row of fallen) assert.match(row.reason ?? "", /dependency-seeds|Command failed/, "the row carries why the seed was not used");
  });
});

test("W1-T13974 criterion 3: a ledger that cannot be written never fails the priming", async () => {
  const w = world();
  await inWorld(w, undefined, () => {
    mkdirSync(join(w.state, LEDGER_FILENAME)); // appendLedger cannot open a directory
    const dir = owned(w);
    assert.equal(ensureDeps(dir, execFileSync, pinnedVitestCli(dir)), true);
    assert.equal(installedVitest(dir), "5.0.5");
  });
});

test("W1-T13974 criterion 4: invariant:proof-results-unchanged — an empty RMD_DEPENDENCY_SEED_ROOT still runs npm ci exactly as at base", async () => {
  const w = world();
  await inWorld(w, "", async () => {
    const sync = owned(w), later = owned(w);
    const calls: string[][] = [];
    assert.equal(ensureDeps(sync, recordingExec(calls), pinnedVitestCli(sync)), true);
    assert.deepEqual(calls, [["npm", ...PROOF_INSTALL_ARGS]]);
    assert.equal(await ensureDepsAsync(later, pinnedVitestCli(later)), true);
    assert.deepEqual(npmCalls(w), [{ argv: [...PROOF_INSTALL_ARGS], cwd: sync }, { argv: [...PROOF_INSTALL_ARGS], cwd: later }]);
    assert.equal(existsSync(w.store), false, "the state-dir store is never created");
  });
});

test("W1-T13974 criterion 4: invariant:proof-results-unchanged — an account seed root is used as today and the state-dir store is not", async () => {
  const w = world();
  const account = join(w.root, "account-seeds");
  await inWorld(w, undefined, async () => {
    writeFileSync(join(w.home, ".config", "remudero", "dependency-seeds.json"), JSON.stringify({ enabled: true, root: account }));
    const sync = owned(w), later = owned(w), stranger = checkout(w);
    const calls: string[][] = [];
    ensureDeps(sync, recordingExec(calls), pinnedVitestCli(sync));
    ensureDeps(stranger, recordingExec(calls));
    assert.ok(isSeedPrime(calls[0]!, account), `the account root primes the reviewer's tree: ${JSON.stringify(calls[0])}`);
    assert.ok(isSeedPrime(calls[1]!, account), "and any other fresh checkout, as at base");
    assert.equal(await ensureDepsAsync(later, pinnedVitestCli(later)), true);
    assert.equal(existsSync(w.store), false, "the state-dir store is never created when the account opted in");
    assert.equal(readdirSync(account).filter((name) => SEED_KEY.test(name)).length, 1);
    writeFileSync(join(w.home, ".config", "remudero", "dependency-seeds.json"), JSON.stringify({ enabled: false }));
    const off = owned(w);
    const offCalls: string[][] = [];
    ensureDeps(off, recordingExec(offCalls), pinnedVitestCli(off));
    assert.deepEqual(offCalls, [["npm", ...PROOF_INSTALL_ARGS]], "an account that turned seeds off keeps npm ci");
    process.env.RMD_DEPENDENCY_SEED_ROOT = account;
    const pinned = owned(w);
    const pinnedCalls: string[][] = [];
    ensureDeps(pinned, recordingExec(pinnedCalls), pinnedVitestCli(pinned));
    assert.ok(isSeedPrime(pinnedCalls[0]!, account), "an RMD_DEPENDENCY_SEED_ROOT override is used as today");
  });
});

test("W1-T13974 criterion 4: invariant:proof-results-unchanged — a linked node_modules is never reinstalled and a stranger's checkout never reaches the state-dir store", async () => {
  const w = world();
  await inWorld(w, undefined, async () => {
    // A PARTIAL shared install (its runner missing), so only the link guard stands between it and a reinstall.
    const shared = join(w.root, "shared-install");
    mkdirSync(join(shared, "vitest"), { recursive: true });
    const linkedSync = owned(w), linkedAsync = owned(w);
    for (const dir of [linkedSync, linkedAsync]) symlinkSync(shared, join(dir, "node_modules"), "dir");
    const calls: string[][] = [];
    assert.equal(ensureDeps(linkedSync, recordingExec(calls), pinnedVitestCli(linkedSync)), false, "the shared install lacks the runner");
    assert.equal(await ensureDepsAsync(linkedAsync, pinnedVitestCli(linkedAsync)), false);
    assert.deepEqual(calls, [], "a linked install is never reinstalled");
    assert.deepEqual(readdirSync(shared), ["vitest"], "the shared target is untouched");
    assert.deepEqual(npmCalls(w), []);
    assert.deepEqual(rows(w), [], "nothing was primed, so nothing is recorded");

    const stranger = checkout(w), strangerAsync = checkout(w);
    ensureDeps(stranger, recordingExec(calls));
    assert.deepEqual(calls, [["npm", ...PROOF_INSTALL_ARGS]], "a checkout the reviewer did not create runs npm ci as at base");
    await ensureDepsAsync(strangerAsync);
    assert.deepEqual(installs(w).map((call) => call.cwd), [stranger, strangerAsync]);
    assert.equal(existsSync(w.store), false, "the state-dir store is never touched for it");
  });
});

test("W1-T13974 criterion 4: invariant:proof-results-unchanged — an unreadable instance or seed config keeps today's outcome", async () => {
  const w = world();
  await inWorld(w, undefined, async () => {
    const config = join(w.home, ".config", "remudero", "config.json");
    rmSync(config);
    mkdirSync(config); // the instance config cannot be read: no state dir, so npm ci as at base
    const noState = owned(w);
    const calls: string[][] = [];
    assert.equal(ensureDeps(noState, recordingExec(calls), pinnedVitestCli(noState)), true);
    assert.deepEqual(calls, [["npm", ...PROOF_INSTALL_ARGS]]);
    assert.equal(existsSync(w.store), false);
    rmSync(config, { recursive: true });
    const noConfig = owned(w); // no instance config at all: no state dir either
    const noConfigCalls: string[][] = [];
    assert.equal(ensureDeps(noConfig, recordingExec(noConfigCalls), pinnedVitestCli(noConfig)), true);
    assert.deepEqual(noConfigCalls, [["npm", ...PROOF_INSTALL_ARGS]]);
    assert.equal(existsSync(w.store), false);
    writeFileSync(config, JSON.stringify({ root: join(w.root, "instance") }));

    // An account seed config with no root throws, as at base: the sync path installs nothing, the async path rejects.
    writeFileSync(join(w.home, ".config", "remudero", "dependency-seeds.json"), JSON.stringify({ enabled: true }));
    const badSync = owned(w), badAsync = owned(w);
    const badCalls: string[][] = [];
    assert.equal(ensureDeps(badSync, recordingExec(badCalls), pinnedVitestCli(badSync)), false, "no install, so no runner");
    assert.deepEqual(badCalls, []);
    await assert.rejects(ensureDepsAsync(badAsync, pinnedVitestCli(badAsync)), /absolute root/);
    assert.deepEqual(rows(w).map((row) => [row.checkout, row.install, row.ok]), [[badSync, "none", false]]);
    assert.match(rows(w)[0]!.reason ?? "", /absolute root/);
  });
});

test("W1-T13974 criterion 4: invariant:proof-results-unchanged — a corrupt seed falls back to npm ci and is never linked", async () => {
  const w = world();
  await inWorld(w, undefined, () => {
    const first = owned(w);
    ensureDeps(first, execFileSync, pinnedVitestCli(first));
    const [key] = seeds(w);
    const ready = join(w.store, key!, "ready.json");
    writeFileSync(ready, JSON.stringify({ ...JSON.parse(readFileSync(ready, "utf8")), key: "0".repeat(64) }));
    const second = owned(w);
    assert.equal(ensureDeps(second, execFileSync, pinnedVitestCli(second)), true);
    assert.deepEqual(installs(w).map((call) => call.cwd).slice(1), [second], "the corrupt seed's tree ran npm ci in place");
    assert.equal(existsSync(join(second, "node_modules", ".rmd-dependency-seed.json")), false, "nothing from the corrupt seed was materialized");
    assert.deepEqual(rows(w).map((row) => row.install), ["fresh", "npm-ci"]);
  });
});

test("W1-T13974 criterion 4: invariant:proof-results-unchanged — a proof's verdict and argv on a seed-primed tree match an npm-ci tree, and a linked install still gets --configLoader native", async () => {
  const w = world();
  await inWorld(w, undefined, () => {
    const target = { owner: "craigoley", repo: "remudero-console" };
    const pass = "TAP version 13\n1..1\nok 1 - tests/unit/seeded.test.ts {\n    1..1\n    ok 1 - a seeded proof\n}\n";
    const fail = "TAP version 13\n1..1\nnot ok 1 - tests/unit/seeded.test.ts {\n    1..1\n    not ok 1 - a seeded proof\n}\n";
    const seeded = owned(w);
    ensureDeps(seeded, execFileSync, pinnedVitestCli(seeded));
    process.env.RMD_DEPENDENCY_SEED_ROOT = "";
    const npmCi = owned(w);
    ensureDeps(npmCi, execFileSync, pinnedVitestCli(npmCi));
    assert.deepEqual(rows(w).map((row) => row.install), ["fresh", "npm-ci"], "one tree from each arm");
    const linked = owned(w);
    symlinkSync(join(seeded, "node_modules"), join(linked, "node_modules"), "dir");

    const run = (cwd: string, tap: string) => {
      const seen: string[][] = [];
      const proof = parseWhitelistedProof("unit test: tests/unit/seeded.test.ts", target)!;
      const verdict = execWhitelistedProof(proof, cwd, 1000, (_command, args) => {
        seen.push([...args]);
        return tap;
      }, { preflightBrowsers: () => {} });
      return { verdict, argv: seen.map((args) => args.map((arg) => arg.split(cwd).join("<tree>"))) };
    };
    for (const tap of [pass, fail]) {
      const fromSeed = run(seeded, tap), fromNpmCi = run(npmCi, tap);
      assert.deepEqual(fromSeed, fromNpmCi, "the seed-primed tree runs the same argv to the same verdict");
      assert.ok(!fromSeed.argv.flat().includes("--configLoader"), "a real install keeps the target's own config loader");
    }
    assert.equal(run(seeded, pass).verdict, "pass");
    const shared = run(linked, pass);
    assert.equal(shared.verdict, "pass");
    assert.deepEqual(shared.argv[0]!.slice(-2), ["--configLoader", "native"], "a linked install still loads config natively");
  });
});

// ── W1-T13974 amendment: a seed key's lock names its owner, a provably dead owner's lock is reclaimed, and a proof
// prime never waits out a lock it cannot prove dead. These name the literals rather than importing new symbols, so the
// suite still loads, and reddens for the defect's own reason, against the pre-change source.

/** The key the review path's prime child computes for `dir`: the fake npm answers 10.9.9 and the child's env carries
 *  none of the npm_config options identity reads. */
function primeKey(dir: string): string {
  return dependencySeedIdentity(dir, { proof: true, npmVersion: "10.9.9", env: {} }).key;
}

const linux = process.platform === "linux";

function procStart(pid: number): string | undefined {
  if (!linux) return undefined;
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

/** A held lock for `key` in the world's store whose owner.json says `owner` (or no owner file when `owner` is null). */
function holdLock(w: World, key: string, owner: Record<string, unknown> | string | null): string {
  mkdirSync(w.store, { recursive: true, mode: 0o700 });
  const lock = join(w.store, `${key}.lock`);
  mkdirSync(lock, { mode: 0o700 });
  if (owner !== null) writeFileSync(join(lock, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner));
  return lock;
}

function ownerOf(pid: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const start = procStart(pid);
  return {
    pid, hostname: hostname(), started_at_ms: Date.now() - 60_000,
    ...(start ? { process_start: start } : {}), ...(linux ? { pid_namespace: readlinkSync("/proc/self/ns/pid") } : {}), ...extra,
  };
}

/** A pid that existed a moment ago and is now gone. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid!;
}

function installVitest(stage: string): void {
  const dir = join(stage, "node_modules", "vitest");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "vitest", version: "5.0.5" }));
}

const inProcess = (w: World, extra: Record<string, unknown> = {}) =>
  ({ root: w.store, proof: true, npmVersion: "10.9.9", env: {}, runInstall: installVitest, ...extra });

test("W1-T13974 criterion 2: a seed lock whose owner died on this host is reclaimed, and the tree gets the seed install", async () => {
  const w = world();
  await inWorld(w, undefined, () => {
    const viaReview = owned(w);
    const key = primeKey(viaReview);
    const lock = holdLock(w, key, ownerOf(deadPid()));
    assert.equal(ensureDeps(viaReview, execFileSync, pinnedVitestCli(viaReview)), true);
    const [row] = rows(w);
    assert.deepEqual([row!.install, row!.seed_key, row!.reason], ["fresh", key, "seed-lock-reclaimed"], "the dead owner's lock was reclaimed");
    assert.equal(installs(w).filter((call) => call.cwd === viaReview).length, 0, "the tree took the seed, not npm ci");
    assert.equal(existsSync(lock), false, "the reclaimed lock is released when the prime ends");
    assert.deepEqual(seeds(w), [key]);

    const direct = checkout(w, "5.0.6");
    const directKey = dependencySeedIdentity(direct, inProcess(w)).key;
    holdLock(w, directKey, ownerOf(deadPid()));
    const result = materializeDependencySeed(direct, inProcess(w, { runInstall: (stage: string) => {
      const dir = join(stage, "node_modules", "vitest");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "vitest", version: "5.0.6" }));
    } }));
    assert.equal(result.status, "materialized");
    assert.equal((result as { lockReclaimed?: boolean }).lockReclaimed, true);
    assert.equal(existsSync(join(w.store, `${directKey}.lock`)), false);
    assert.deepEqual(readdirSync(w.store).filter((name) => name.includes(".reclaimed-")), [], "no reclaimed lock is left behind");
  });
});

test("W1-T13974 criterion 2: a reused pid on Linux counts as a dead owner", async (t) => {
  if (!linux) { t.skip("process start times come from /proc"); return; }
  const w = world();
  await inWorld(w, undefined, () => {
    const dir = checkout(w);
    holdLock(w, dependencySeedIdentity(dir, inProcess(w)).key, ownerOf(process.pid, { process_start: "0" }));
    const result = materializeDependencySeed(dir, inProcess(w));
    assert.equal((result as { lockReclaimed?: boolean }).lockReclaimed, true, "a live pid with another start time is not the owner");
  });
});

test("W1-T13974 criterion 2: a seed lock with a live owner is never reclaimed, and the proof prime falls back within its short wait as seed-lock-held", async () => {
  const w = world();
  await inWorld(w, undefined, async () => {
    const sync = owned(w);
    const key = primeKey(sync);
    const lock = holdLock(w, key, ownerOf(process.pid));
    const owner = readFileSync(join(lock, "owner.json"), "utf8");
    // No wall-clock bound here (W1-T2811): the short wait is proven by the reason. A prime that waited out the 120 s
    // install bound would be SIGKILLed by its own 120 s exec bound first, and its row would not say seed-lock-held.
    assert.equal(ensureDeps(sync, execFileSync, pinnedVitestCli(sync)), true, "npm ci still installs the runner");
    const later = owned(w);
    assert.equal(await ensureDepsAsync(later, pinnedVitestCli(later)), true);
    assert.deepEqual(rows(w).map((row) => [row.install, row.seed_key, row.reason]), [["npm-ci", null, "seed-lock-held"], ["npm-ci", null, "seed-lock-held"]]);
    assert.deepEqual(installs(w).map((call) => call.cwd), [sync, later], "each tree fell back to npm ci in place");
    assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), owner, "a live owner's lock is left exactly as it was");

    const direct = checkout(w);
    assert.throws(() => materializeDependencySeed(direct, inProcess(w)), /seed-lock-held.*EEXIST/, "a proof prime gives up on its own");
    assert.ok(existsSync(lock));
  });
});

test("W1-T13974 criterion 2: a seed lock from another host, with no owner, an unreadable owner or a pid it may not signal is never reclaimed", async () => {
  const w = world();
  await inWorld(w, undefined, () => {
    const owners: Array<[string, Record<string, unknown> | string | null]> = [
      ["another host", ownerOf(deadPid(), { hostname: `not-${hostname()}` })],
      ["no owner.json", null],
      ["an unreadable owner.json", "{\"pid\": 12"],
      ["an owner it may not signal (EPERM)", ownerOf(1, { process_start: undefined })],
    ];
    for (const [label, owner] of owners) {
      const dir = checkout(w);
      const key = dependencySeedIdentity(dir, inProcess(w)).key;
      const lock = holdLock(w, key, owner);
      const before = existsSync(join(lock, "owner.json")) ? readFileSync(join(lock, "owner.json"), "utf8") : null;
      assert.throws(() => materializeDependencySeed(dir, inProcess(w, { lockWaitMs: 300 })), /seed-lock-held/, `${label}: the prime gives up`);
      assert.ok(existsSync(lock), `${label}: the lock is never reclaimed`);
      assert.equal(existsSync(join(lock, "owner.json")) ? readFileSync(join(lock, "owner.json"), "utf8") : null, before, `${label}: untouched`);
      assert.equal(existsSync(join(dir, "node_modules")), false, `${label}: nothing was installed`);
      rmSync(lock, { recursive: true });
    }
  });
});
