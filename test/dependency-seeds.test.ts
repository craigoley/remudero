import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configuredDependencySeedRoot, defaultDependencySeedRoot, dependencySeedConfigPath, dependencySeedIdentity, DEPENDENCY_SEED_MIN_IDLE_MS, legacyHostNamespace, materializeDependencySeed, sweepDependencySeeds } from "../src/lib/dependency-seeds.js";

function writable(path: string): void {
  const s = lstatSync(path);
  if (s.isSymbolicLink()) return;
  chmodSync(path, s.mode | 0o700);
  if (s.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name));
}
function fixture(body: (root: string, donor: string, checkout: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-test-")));
  const donor = join(root, "donor"), checkout = join(root, "checkout");
  for (const dir of [donor, checkout]) {
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { dep: "1.0.0" } }));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: { "": { name: "fixture" }, "node_modules/dep": { version: "1.0.0" } } }));
  }
  mkdirSync(join(donor, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(donor, "node_modules", "dep", "package.json"), '{"name":"dep","version":"1.0.0"}');
  writeFileSync(join(donor, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(donor, "node_modules", ".bin"));
  writeFileSync(join(donor, "node_modules", ".bin", "fixture"), "#!/bin/sh\n");
  try { body(root, donor, checkout); }
  finally { writable(root); rmSync(root, { recursive: true, force: true }); }
}
const identityOptions = { npmVersion: "11.19.0", env: {}, platform: "linux" as const };

test("dependency seed identity separates workspace manifests, toolchains and proof policy", () => fixture((root, donor, checkout) => {
  const first = dependencySeedIdentity(checkout, identityOptions).key;
  assert.equal(first, dependencySeedIdentity(donor, identityOptions).key);
  assert.notEqual(first, dependencySeedIdentity(checkout, { ...identityOptions, proof: true }).key);
  assert.notEqual(first, dependencySeedIdentity(checkout, { ...identityOptions, npmVersion: "12" }).key);
  assert.notEqual(first, dependencySeedIdentity(checkout, { ...identityOptions, platform: "darwin" }).key);
  assert.notEqual(first, dependencySeedIdentity(checkout, { ...identityOptions, env: { npm_config_omit: "dev" } }).key);
  mkdirSync(join(checkout, "packages", "local"), { recursive: true });
  writeFileSync(join(checkout, "packages", "local", "package.json"), '{"name":"local"}');
  writeFileSync(join(checkout, "package-lock.json"), '{"packages":{"packages/local":{}}}');
  const workspace = dependencySeedIdentity(checkout, identityOptions).key;
  writeFileSync(join(checkout, "packages", "local", "package.json"), '{"name":"local","dependencies":{"dep":"2"}}');
  assert.notEqual(workspace, dependencySeedIdentity(checkout, identityOptions).key);
  writeFileSync(join(checkout, ".npmrc"), "legacy-peer-deps=true\n");
  assert.ok(dependencySeedIdentity(checkout, identityOptions).files[".npmrc"]);
  writeFileSync(join(checkout, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
  assert.throws(() => dependencySeedIdentity(checkout, identityOptions), /credential/);
}));

test("dependency seed rejects missing, unreadable and escaping install inputs", () => fixture((root, donor, checkout) => {
  rmSync(join(checkout, "package-lock.json"));
  assert.throws(() => dependencySeedIdentity(checkout, identityOptions), /ENOENT/);
  symlinkSync(join(donor, "package-lock.json"), join(checkout, "package-lock.json"));
  assert.throws(() => dependencySeedIdentity(checkout, identityOptions), /escapes/);
  rmSync(join(checkout, "package-lock.json"));
  writeFileSync(join(checkout, "package-lock.json"), '{"packages":{"../escape":{}}}');
  assert.throws(() => dependencySeedIdentity(checkout, identityOptions), /escaping/);
}));

test("dependency seed preserves occupied installs while refusing incomplete and dangling node_modules", () => fixture((root, donor, checkout) => {
  mkdirSync(join(checkout, "node_modules"));
  assert.throws(() => materializeDependencySeed(checkout), /missing dep/);
  assert.ok(lstatSync(join(checkout, "node_modules")).isDirectory());
  rmSync(join(checkout, "node_modules"), { recursive: true });
  symlinkSync(join(root, "missing"), join(checkout, "node_modules"));
  assert.throws(() => materializeDependencySeed(checkout), /ENOENT/);
  assert.ok(lstatSync(join(checkout, "node_modules")).isSymbolicLink());
}));

test("occupied seed validates its generation before reuse and never installs over a stale consumer", () => fixture((root, donor, checkout) => {
  const opts = { ...identityOptions, root: join(root, "seeds"), sourceDir: donor, proof: true };
  const first = materializeDependencySeed(checkout, opts);
  assert.equal(first.status, "materialized");
  if (first.status !== "materialized") throw new Error("fixture seed absent");
  const file = join(checkout, "node_modules", "dep", "index.js");
  const inode = statSync(file).ino;
  const refuseInstall = () => { throw new Error("must not install over occupied dependencies"); };
  assert.deepEqual(materializeDependencySeed(checkout, { ...opts, runInstall: refuseInstall }), { status: "present" });
  assert.throws(() => materializeDependencySeed(checkout, { ...opts, npmVersion: "changed", runInstall: refuseInstall }), /identity mismatch/);
  assert.equal(statSync(file).ino, inode);
  assert.equal(readFileSync(file, "utf8"), "module.exports = 1;\n");
  writeFileSync(join(first.seed, "ready.json"), JSON.stringify({ version: 1, key: "wrong" }));
  assert.throws(() => materializeDependencySeed(checkout, opts), /not ready/);
}));

test("dependency seed Linux materialization keeps package storage shared and caches private", () => fixture((root, donor, checkout) => {
  mkdirSync(join(donor, "node_modules", ".cache"));
  writeFileSync(join(donor, "node_modules", ".cache", "live"), "private");
  const opts = { ...identityOptions, root: join(root, "seeds"), sourceDir: donor };
  const result = materializeDependencySeed(checkout, opts);
  assert.equal(result.status, "materialized");
  if (result.status !== "materialized") return;
  assert.equal(result.method, "readonly-links");
  assert.equal(result.installed, false);
  assert.ok(lstatSync(join(checkout, "node_modules")).isDirectory());
  assert.ok(lstatSync(join(checkout, "node_modules", "dep")).isSymbolicLink());
  assert.equal(statSync(join(result.seed, "node_modules", "dep", "index.js")).mode & 0o222, 0);
  assert.ok(!existsSync(join(checkout, "node_modules", ".cache")));
  mkdirSync(join(checkout, "node_modules", ".cache"));
  writeFileSync(join(checkout, "node_modules", ".cache", "local"), "mine");
  assert.ok(!existsSync(join(result.seed, "node_modules", ".cache")));
  const second = join(root, "second"); mkdirSync(second);
  for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(second, name), readFileSync(join(checkout, name)));
  const reused = materializeDependencySeed(second, { ...opts, runInstall: () => { throw new Error("must reuse"); } });
  assert.equal(reused.status, "materialized");
  if (reused.status === "materialized") assert.equal(reused.seed, result.seed);
}));

test("dependency seed proof copies cannot mutate another checkout or its seed", () => fixture((root, donor, checkout) => {
  const result = materializeDependencySeed(checkout, { ...identityOptions, root: join(root, "seeds"), sourceDir: donor, proof: true });
  assert.equal(result.status, "materialized");
  if (result.status !== "materialized") return;
  assert.equal(result.method, "private-copy");
  writeFileSync(join(checkout, "node_modules", "dep", "index.js"), "changed");
  assert.equal(readFileSync(join(result.seed, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
  assert.equal(readFileSync(join(donor, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
  rmSync(join(checkout, "node_modules"), { recursive: true });
  assert.ok(existsSync(join(result.seed, "node_modules", "dep", "index.js")));
}));

test("dependency seed APFS clones have independent inodes and survive checkout reinstall", { skip: process.platform !== "darwin" }, () => fixture((root, donor, checkout) => {
  const result = materializeDependencySeed(checkout, { ...identityOptions, platform: "darwin", root: join(root, "seeds"), sourceDir: donor });
  assert.equal(result.status, "materialized");
  if (result.status !== "materialized") return;
  assert.equal(result.method, "apfs-clone");
  const seedFile = join(result.seed, "node_modules", "dep", "index.js");
  const localFile = join(checkout, "node_modules", "dep", "index.js");
  assert.notEqual(statSync(seedFile).ino, statSync(localFile).ino);
  writeFileSync(localFile, "changed");
  assert.equal(readFileSync(seedFile, "utf8"), "module.exports = 1;\n");
  rmSync(join(checkout, "node_modules"), { recursive: true });
  assert.ok(existsSync(seedFile));
}));

test("dependency seed workspace links resolve the consuming checkout rather than the donor", () => fixture((root, donor, checkout) => {
  for (const dir of [donor, checkout]) {
    mkdirSync(join(dir, "packages", "local"), { recursive: true });
    writeFileSync(join(dir, "packages", "local", "package.json"), '{"name":"@fixture/local"}');
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: { "packages/local": {}, "node_modules/dep": {}, "node_modules/@fixture/local": { link: true, resolved: "packages/local" } } }));
  }
  mkdirSync(join(donor, "node_modules", "@fixture"));
  symlinkSync("../../packages/local", join(donor, "node_modules", "@fixture", "local"));
  mkdirSync(join(donor, "packages", "local", "node_modules", "nested"), { recursive: true });
  writeFileSync(join(donor, "packages", "local", "node_modules", "nested", "package.json"), '{"name":"nested"}');
  materializeDependencySeed(checkout, { ...identityOptions, root: join(root, "seeds"), sourceDir: donor, now: 0 });
  assert.equal(realpathSync(join(checkout, "node_modules", "@fixture", "local")), join(checkout, "packages", "local"));
  assert.ok(existsSync(join(checkout, "packages", "local", "node_modules", "nested", "package.json")));
  rmSync(join(checkout, "node_modules"), { recursive: true });
  assert.equal(sweepDependencySeeds(join(root, "seeds"), { now: DEPENDENCY_SEED_MIN_IDLE_MS + 1, apply: true, isOpen: () => false })[0].reason, "referenced by checkout");
  assert.ok(existsSync(join(checkout, "packages", "local", "node_modules", "nested", "package.json")));
}));

test("dependency seed fails closed on mismatched or incomplete donors and install failures", () => fixture((root, donor, checkout) => {
  const opts = { ...identityOptions, root: join(root, "seeds"), sourceDir: donor };
  writeFileSync(join(donor, "package.json"), '{"name":"other"}');
  assert.throws(() => materializeDependencySeed(checkout, opts), /do not match/);
  assert.ok(!existsSync(join(checkout, "node_modules")));
  writeFileSync(join(donor, "package.json"), readFileSync(join(checkout, "package.json")));
  writeFileSync(join(donor, "node_modules", "dep", "package.json"), '{"name":"dep","version":"2.0.0"}');
  assert.throws(() => materializeDependencySeed(checkout, opts), /version mismatch/);
  rmSync(join(donor, "node_modules", "dep"), { recursive: true });
  assert.throws(() => materializeDependencySeed(checkout, opts), /missing dep/);
  assert.throws(() => materializeDependencySeed(checkout, { ...opts, sourceDir: undefined, runInstall: () => { throw new Error("install failed"); } }), /install failed/);
  assert.equal(readdirSync(opts.root).filter(name => name.endsWith(".lock") || name.startsWith(".stage")).length, 0);
}));

test("dependency seed npm installs disable lifecycle scripts and publish only a verified generation", () => fixture((root, donor, checkout) => {
  let installs = 0;
  const result = materializeDependencySeed(checkout, { ...identityOptions, root: join(root, "seeds"), proof: true, runInstall: (stage, args, env) => {
    installs++;
    assert.deepEqual(args, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    assert.equal(env.npm_config_cache, join(root, "seeds", ".npm-cache"));
    mkdirSync(join(stage, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(stage, "node_modules", "dep", "package.json"), '{"name":"dep","version":"1.0.0"}');
  } });
  assert.equal(installs, 1);
  if (result.status === "materialized") assert.equal(result.installed, true);
}));

test("dependency seed GC keeps referenced, recent, locked, open and unverified generations", () => fixture((root, donor, checkout) => {
  const store = join(root, "seeds"); const now = Date.now();
  const result = materializeDependencySeed(checkout, { ...identityOptions, root: store, sourceDir: donor, now: now - DEPENDENCY_SEED_MIN_IDLE_MS - 1 });
  if (result.status !== "materialized") throw new Error("missing seed");
  assert.equal(sweepDependencySeeds(store, { now, apply: true, isOpen: () => false })[0].reason, "referenced by checkout");
  rmSync(join(checkout, "node_modules"), { recursive: true });
  assert.equal(sweepDependencySeeds(store, { now })[0].reason, "open-file scan unavailable");
  assert.equal(sweepDependencySeeds(store, { now, isOpen: () => true })[0].reason, "open file or process");
  assert.match(sweepDependencySeeds(store, { now, isOpen: () => { throw new Error("blind"); } })[0].reason, /unverified/);
  mkdirSync(`${result.seed}.lock`);
  assert.match(sweepDependencySeeds(store, { now })[0].reason, /lock/);
  rmSync(`${result.seed}.lock`, { recursive: true });
  assert.equal(sweepDependencySeeds(store, { now: now - 2, isOpen: () => false })[0].reason, "used within six hours");
  assert.equal(sweepDependencySeeds(store, { now, isOpen: () => false })[0].action, "remove");
  assert.ok(existsSync(result.seed));
  assert.equal(sweepDependencySeeds(store, { now, apply: true, isOpen: () => false })[0].action, "remove");
  assert.ok(!existsSync(result.seed));
}));

test("dependency seed store cannot be a symlink and busy locks are never stolen", () => fixture((root, donor, checkout) => {
  const store = join(root, "seeds"); mkdirSync(store); symlinkSync(store, join(root, "alias"));
  assert.throws(() => materializeDependencySeed(checkout, { ...identityOptions, root: join(root, "alias"), sourceDir: donor }), /account-owned/);
  const key = dependencySeedIdentity(checkout, identityOptions).key; mkdirSync(join(store, `${key}.lock`));
  assert.throws(() => materializeDependencySeed(checkout, { ...identityOptions, root: store, sourceDir: donor, lockWaitMs: 0 }), /EEXIST/);
  assert.ok(existsSync(join(store, `${key}.lock`)));
}));

test("a URL-encoded seed root is refused instead of starting a second store", () => {
  assert.throws(() => configuredDependencySeedRoot("/account", { RMD_DEPENDENCY_SEED_ROOT: "/account/Library/Application%20Support/Remudero/dependencies" }), /URL-encoded/);
  assert.equal(configuredDependencySeedRoot("/account", { RMD_DEPENDENCY_SEED_ROOT: "/account/Library/Application Support/Remudero/dependencies" }),
    "/account/Library/Application Support/Remudero/dependencies");
});

test("dependency seed defaults are separate per account and platform", () => {
  assert.equal(dependencySeedConfigPath("/account"), "/account/.config/remudero/dependency-seeds.json");
  assert.equal(defaultDependencySeedRoot("/account", "darwin"), "/account/Library/Application Support/Remudero/dependencies");
  assert.equal(defaultDependencySeedRoot("/account", "linux"), "/account/.local/share/remudero/dependencies");
  const previous = process.env.RMD_DEPENDENCY_SEED_ROOT;
  try {
    process.env.RMD_DEPENDENCY_SEED_ROOT = "/seed-root"; assert.equal(configuredDependencySeedRoot(), "/seed-root");
    process.env.RMD_DEPENDENCY_SEED_ROOT = "relative"; assert.throws(configuredDependencySeedRoot, /absolute/);
  } finally { if (previous === undefined) delete process.env.RMD_DEPENDENCY_SEED_ROOT; else process.env.RMD_DEPENDENCY_SEED_ROOT = previous; }
});

test("generic janitors protect seed stores and ancestors regardless of age", () => fixture((root, donor, checkout) => {
  const store = join(root, "seeds"); mkdirSync(store); writeFileSync(join(store, ".rmd-dependency-seed-root.json"), '{}');
  const guard = join(process.cwd(), "deploy", "dependency-seed-guard.sh");
  for (const path of [root, store, join(store, "generation")]) {
    const output = execFileSync("bash", ["-c", 'source "$1"; rmd_dependency_seed_risk "$2"', "guard", guard, path], { encoding: "utf8" });
    assert.match(output, /dependency seed store/);
  }
  assert.throws(() => execFileSync("bash", ["-c", 'source "$1"; rmd_dependency_seed_risk "$2"', "guard", guard, checkout]), /Command failed/);
  assert.match(execFileSync("bash", ["-c", 'source "$1"; rmd_dependency_seed_risk ./seeds', "guard", guard], { cwd: root, encoding: "utf8", timeout: 3000 }), /dependency seed store/);
}));

test("dependency seed account configuration is optional and invalid configuration is refused", () => fixture((root) => {
  assert.equal(configuredDependencySeedRoot(root, {}), undefined);
  const file = dependencySeedConfigPath(root); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"enabled":false}'); assert.equal(configuredDependencySeedRoot(root, {}), undefined);
  writeFileSync(file, '{"enabled":true,"root":"/durable/seeds"}'); assert.equal(configuredDependencySeedRoot(root, {}), "/durable/seeds");
  assert.equal(configuredDependencySeedRoot(root, { RMD_DEPENDENCY_SEED_ROOT: "" }), undefined);
  writeFileSync(file, '{"enabled":true,"root":"relative"}'); assert.throws(() => configuredDependencySeedRoot(root, {}), /absolute/);
  writeFileSync(file, '{"enabled":true,"root":"/a/Application%20Support/seeds"}'); assert.throws(() => configuredDependencySeedRoot(root, {}), /URL-encoded/);
  writeFileSync(file, 'broken json'); assert.throws(() => configuredDependencySeedRoot(root, {}), /JSON/);
}));

test("dependency seed real npm default primes an empty project without lifecycle execution", () => fixture((root, donor, checkout) => {
  symlinkSync(join(root, "missing-npm-cache"), join(root, ".npm"));
  writeFileSync(join(checkout, "package.json"), '{"name":"empty","version":"1.0.0","scripts":{"prepare":"exit 99"}}');
  writeFileSync(join(checkout, "package-lock.json"), '{"name":"empty","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"empty","version":"1.0.0"}}}');
  const result = materializeDependencySeed(checkout, { root: join(root, "seeds"), proof: true,
    env: { PATH: process.env.PATH, HOME: root, npm_config_offline: "true" } });
  assert.equal(result.status, "materialized");
  if (result.status === "materialized") assert.equal(result.installed, true);
}));

test("dependency seed GC refuses malformed readiness and malformed consumer evidence", () => fixture((root, donor, checkout) => {
  const store = join(root, "seeds");
  const result = materializeDependencySeed(checkout, { ...identityOptions, root: store, sourceDir: donor, now: 0 });
  if (result.status !== "materialized") throw new Error("missing seed");
  const ready = join(result.seed, "ready.json"), original = readFileSync(ready);
  writeFileSync(ready, '{}'); assert.match(sweepDependencySeeds(store, { now: Date.now() })[0].reason, /unverified/);
  const third = join(root, "third"); mkdirSync(third);
  for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(third, name), readFileSync(join(checkout, name)));
  assert.throws(() => materializeDependencySeed(third, { ...identityOptions, root: store, sourceDir: donor }), /metadata mismatch/);
  writeFileSync(ready, original);
  const consumer = join(result.seed, "consumers", readdirSync(join(result.seed, "consumers"))[0]);
  writeFileSync(consumer, JSON.stringify({ checkout, mountNamespace: "another container" }));
  assert.equal(sweepDependencySeeds(store, { now: Date.now(), isOpen: () => false })[0].reason, "foreign or unverified consumer mount namespace");
  writeFileSync(join(result.seed, "consumers", "invalid.json"), '{"checkout":"relative"}');
  assert.match(sweepDependencySeeds(store, { now: Date.now(), isOpen: () => false })[0].reason, /unverified/);
}));

test("dependency seed concurrent builders install once and never expose a partial generation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-concurrent-")));
  try {
    const first = join(root, "first"), second = join(root, "second"), calls = join(root, "calls");
    for (const dir of [first, second]) {
      mkdirSync(dir); writeFileSync(join(dir, "package.json"), '{"name":"empty"}'); writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
    }
    const module = pathToFileURL(join(process.cwd(), "src/lib/dependency-seeds.ts")).href;
    const code = `import {materializeDependencySeed} from ${JSON.stringify(module)}; import fs from 'node:fs';
      const r=materializeDependencySeed(process.argv[1], {root:process.argv[2],npmVersion:'11.19.0',env:{},runInstall:(stage)=>{
        fs.appendFileSync(process.argv[3],'install\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);
        fs.mkdirSync(stage+'/node_modules'); }}); console.log(JSON.stringify(r));`;
    const run = promisify(execFile);
    const results = await Promise.all([first, second].map(dir => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, dir, join(root, "seeds"), calls], { timeout: 10_000 })));
    const a = JSON.parse(results[0].stdout), b = JSON.parse(results[1].stdout);
    assert.equal(a.seed, b.seed); assert.equal(readFileSync(calls, "utf8"), "install\n");
    assert.equal([a.installed, b.installed].filter(Boolean).length, 1);
  } finally { writable(root); rmSync(root, { recursive: true, force: true }); }
});

test("dependency seed installer publishes complete immutable tools and preserves existing configuration", () => fixture((root) => {
  const home = join(root, "home"); mkdirSync(home);
  const installer = join(process.cwd(), "deploy", "install-dependency-seeds.sh");
  const env = { ...process.env, HOME: home, RMD_SEED_NODE: process.execPath, RMD_DEPENDENCY_SEED_ROOT: join(home, "store") };
  execFileSync("bash", [installer], { env });
  const wrapper = join(home, ".local", "bin", "remudero-dependencies");
  const saved = readFileSync(wrapper), config = readFileSync(dependencySeedConfigPath(home));
  const versions = join(home, ".local", "share", "remudero", "dependency-seed-tools");
  const version = readdirSync(versions).find(name => /^[a-f0-9]{64}$/.test(name))!;
  assert.ok(existsSync(join(versions, version, "src", "lib", "clock.ts")));
  assert.throws(() => execFileSync(process.execPath, [join(versions, version, "scripts", "dependency-seeds.mjs"), "enable"], { env, stdio: "pipe" }), /existing seed configuration/);
  assert.deepEqual(readFileSync(dependencySeedConfigPath(home)), config);
  const fresh = join(home, "fresh"); mkdirSync(fresh);
  writeFileSync(join(fresh, "package.json"), '{"name":"empty","version":"1.0.0"}');
  writeFileSync(join(fresh, "package-lock.json"), '{"name":"empty","version":"1.0.0","lockfileVersion":3,"packages":{}}');
  const cold = JSON.parse(execFileSync(wrapper, ["prime", fresh], { env: { ...env, PATH: "/usr/bin:/bin", npm_config_offline: "true" }, encoding: "utf8" }));
  assert.equal(cold.status, "materialized", "SSH/cron's minimal PATH still resolves the pinned npm toolchain");
  execFileSync("bash", [installer], { env });
  assert.deepEqual(readFileSync(wrapper), saved);
  assert.deepEqual(readFileSync(dependencySeedConfigPath(home)), config);
  rmSync(join(versions, version, "scripts", "dependency-seeds.mjs"));
  assert.throws(() => execFileSync("bash", [installer], { env, stdio: "pipe" }), /Command failed/);
  assert.deepEqual(readFileSync(wrapper), saved);
}));

test("a pre-namespace consumer record on a macOS host path is read from the host; other legacy records stay retained", () => fixture((root, donor, checkout) => {
  assert.equal(legacyHostNamespace("/Users/someone/Remudero/run", "darwin"), "host");
  assert.equal(legacyHostNamespace("/private/var/folders/x/T/run", "darwin"), "host");
  assert.equal(legacyHostNamespace("/workspace/run", "darwin"), undefined, "a container-only path stays unverified");
  assert.equal(legacyHostNamespace("/Users/someone/run", "linux"), undefined, "Linux has real mount namespaces");
  const store = join(root, "seeds");
  const result = materializeDependencySeed(checkout, { ...identityOptions, root: store, sourceDir: donor, now: 0 });
  if (result.status !== "materialized") throw new Error("missing seed");
  const consumer = join(result.seed, "consumers", readdirSync(join(result.seed, "consumers"))[0]);
  writeFileSync(consumer, JSON.stringify({ checkout }));
  writable(join(checkout, "node_modules")); rmSync(join(checkout, "node_modules"), { recursive: true });
  const [row] = sweepDependencySeeds(store, { now: Date.now(), isOpen: () => false });
  assert.equal(row.reason, process.platform === "darwin" ? "unreferenced and idle for six hours" : "foreign or unverified consumer mount namespace");
}));
