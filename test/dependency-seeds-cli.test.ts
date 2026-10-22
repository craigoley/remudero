import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error -- standalone .mjs tool is outside tsconfig and has no declarations.
import { ownerOnlyHome, seedIsOpen } from "../scripts/dependency-seeds.mjs";

test("dependency CLI explicitly reuses a command-only generation with no registry install", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-seed-cli-reuse-"));
  const store = join(root, "store"), home = join(root, "home"), donor = join(root, "donor"), first = join(root, "first"), next = join(root, "next");
  for (const dir of [home, donor, first, next]) {
    mkdirSync(dir);
    if (dir === home) continue;
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { dep: "1.0.0" } }));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/dep": { version: "1.0.0" } } }));
  }
  mkdirSync(join(donor, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(donor, "node_modules", "dep", "package.json"), '{"name":"dep","version":"1.0.0"}');
  for (const name of ["user.npmrc", "global.npmrc"]) writeFileSync(join(home, name), "");
  const env = { ...process.env, HOME: home, RMD_DEPENDENCY_SEED_ROOT: "", npm_config_offline: "true",
    npm_config_userconfig: join(home, "user.npmrc"), npm_config_globalconfig: join(home, "global.npmrc") };
  const cli = join(process.cwd(), "scripts", "dependency-seeds.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "prime", ...args], { env, encoding: "utf8", timeout: 20_000 });
  try {
    const initial = run(first, "--source", donor, "--root", store, "--proof");
    assert.equal(initial.status, 0, initial.stderr);
    const source = JSON.parse(initial.stdout);
    writeFileSync(join(next, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { dep: "1.0.0" }, scripts: { build: "new build command" } }));
    const reused = run(next, "--reuse-seed", source.seed, "--root", store, "--proof");
    assert.equal(reused.status, 0, reused.stderr);
    const result = JSON.parse(reused.stdout);
    assert.equal(result.reusedFrom, source.key);
    assert.equal(result.installed, false);
    assert.notEqual(result.key, source.key);
  } finally {
    // The fixture owns both immutable generations; make only this fixture writable for retirement.
    const makeWritable = (path: string): void => {
      const s = lstatSync(path); if (s.isSymbolicLink()) return;
      chmodSync(path, s.mode | 0o700);
      if (s.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
    };
    makeWritable(root); rmSync(root, { recursive: true, force: true });
  }
});

test("dependency seed CLI requires administrator scans and distinguishes no-open-files from unknown", () => {
  assert.throws(() => seedIsOpen("/seed", 501), /administrator/);
  const calls: unknown[][] = [];
  const exec = (...args: unknown[]) => { calls.push(args); return "node holds a file"; };
  assert.equal(seedIsOpen("/seed", 0, exec), true);
  assert.equal(calls[0]?.[0], process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof");
  assert.deepEqual(calls[0]?.[1], ["-nP", "+D", "/seed"]);
  assert.deepEqual(calls[0]?.[2], { encoding: "utf8", timeout: 30_000 });
  assert.equal(seedIsOpen("/seed", 0, () => ""), false);
  assert.equal(seedIsOpen("/seed", 0, () => { throw Object.assign(new Error("none"), { status: 1, stdout: "", stderr: "" }); }), false);
  for (const evidence of [{ status: 2 }, { status: 1, stdout: "partial" }, { status: 1, stderr: "permission denied" }]) {
    assert.throws(() => seedIsOpen("/seed", 0, () => { throw Object.assign(new Error("unknown"), evidence); }), /unknown/);
  }
});

test("dependency seed CLI enables once, preserves configuration and defaults to a dry sweep", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-cli-")));
  const home = join(root, "home"); mkdirSync(home);
  const cli = join(process.cwd(), "scripts", "dependency-seeds.mjs");
  const env = { ...process.env, HOME: home, RMD_DEPENDENCY_SEED_ROOT: "" };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  try {
    const enabled = run("enable"); assert.equal(enabled.status, 0, enabled.stderr);
    const { config, root: store } = JSON.parse(enabled.stdout);
    const original = readFileSync(config, "utf8");
    assert.equal(run("enable").status, 1);
    assert.equal(readFileSync(config, "utf8"), original);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, ".rmd-dependency-seed-root.json"), '{"version":1}');
    const swept = run("sweep", "--root", store); assert.equal(swept.status, 0, swept.stderr);
    assert.deepEqual(JSON.parse(swept.stdout), []);
    const applied = run("sweep", "--apply", "--root", store); assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(JSON.parse(applied.stdout), []);
    assert.match(run("unknown").stderr, /usage:/);
    assert.match(run("enable", "--root", "relative").stderr, /must be absolute/);
    rmSync(join(home, ".config", "remudero"), { recursive: true });
    const overridden = run("enable", "--root", join(root, "explicit")); assert.equal(overridden.status, 0, overridden.stderr);
    assert.equal(JSON.parse(overridden.stdout).root, join(root, "explicit"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a seed store in an owner-only macOS home is scanned with the owner's own lsof", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-home-")));
  try {
    const seed = join(home, "Library/seeds/abc"), uid = process.getuid!();
    const acl = (line: string) => () => `drwx------+ 9 me staff 288 Oct 21 10:00 ${home}\n ${line}\n`;
    chmodSync(home, 0o700);
    assert.equal(ownerOnlyHome(seed, uid, home, acl("0: group:everyone deny delete"), "darwin"), true);
    assert.equal(ownerOnlyHome(seed, uid, home, acl("0: user:other allow list,search"), "darwin"), false, "an ACL grant lets another account in");
    assert.equal(ownerOnlyHome(seed, uid, home, acl(""), "linux"), false, "Linux keeps the administrator scan");
    assert.equal(ownerOnlyHome("/elsewhere/seed", uid, home, acl(""), "darwin"), false);
    assert.equal(ownerOnlyHome(seed, uid + 1, home, acl(""), "darwin"), false);
    chmodSync(home, 0o711);
    assert.equal(ownerOnlyHome(seed, uid, home, acl(""), "darwin"), false, "others can traverse the home");
    assert.equal(seedIsOpen(seed, 501, () => "", () => true), false);
    assert.throws(() => seedIsOpen(seed, 501, () => "", () => false), /administrator/);
  } finally { chmodSync(home, 0o700); rmSync(home, { recursive: true, force: true }); }
});
