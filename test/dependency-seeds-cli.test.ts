import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error -- standalone .mjs tool is outside tsconfig and has no declarations.
import { attestedOpen, ownerOnlyHome, seedIsOpen } from "../scripts/dependency-seeds.mjs";

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

test("the dependency seed CLI sweeps a URL-encoded stray store named by --root but refuses it as configuration", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-cli-")));
  const stray = join(root, "home/Library/Application%20Support/Remudero/dependencies");
  const cli = join(process.cwd(), "scripts", "dependency-seeds.mjs");
  const run = (env: Record<string, string>, ...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, HOME: join(root, "home"), ...env }, encoding: "utf8" });
  try {
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, ".rmd-dependency-seed-root.json"), '{"version":1}');
    const named = run({ RMD_DEPENDENCY_SEED_ROOT: "" }, "sweep", "--root", stray, "--apply");
    assert.equal(named.status, 0, named.stderr);
    assert.deepEqual(JSON.parse(named.stdout), []);
    const configured = run({ RMD_DEPENDENCY_SEED_ROOT: stray }, "sweep");
    assert.notEqual(configured.status, 0);
    assert.match(configured.stderr, /URL-encoded/);
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

test("a fresh root-owned open-file scan stands in for the administrator scan; a stale, foreign or writable one does not", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-scan-")));
  try {
    const scans = join(root, "open-files"); mkdirSync(scans, { mode: 0o755 }); chmodSync(root, 0o755); chmodSync(scans, 0o755);
    const store = join(root, "home/Library/Application Support/Remudero/dependencies"), seed = join(store, "abc");
    const uid = process.getuid!(), now = Date.now();
    const file = join(scans, createHash("sha256").update(store.toLowerCase()).digest("hex") + ".json");
    const write = (scan: Record<string, unknown>, mode = 0o644) => {
      writeFileSync(file, JSON.stringify({ version: 1, root: store, scannedAt: Math.floor(now / 1000), open: [], ...scan })); chmodSync(file, mode);
    };
    const check = (opts: Record<string, unknown> = {}) => attestedOpen(seed, { dir: scans, now, rootUid: uid, ...opts });
    assert.equal(check(), undefined, "no scan");
    write({}); assert.equal(check(), false);
    write({ open: [join(store, "other/file.js")] }); assert.equal(check(), false, "another generation's open file");
    write({ open: [join(seed, "node_modules/x/index.js").toUpperCase()] }); assert.equal(check(), true, "case-insensitive names");
    write({ scannedAt: Math.floor(now / 1000) - 16 * 60 }); assert.equal(check(), undefined, "stale");
    write({ root: join(root, "elsewhere") }); assert.equal(check(), undefined, "another store");
    write({}, 0o666); assert.equal(check(), undefined, "writable by others");
    write({}); assert.equal(check({ rootUid: uid + 1 }), undefined, "not written by root");
    assert.equal(seedIsOpen(seed, 501, () => "", () => false, () => false), false);
    assert.equal(seedIsOpen(seed, 501, () => "", () => false, () => true), true);
    assert.throws(() => seedIsOpen(seed, 501, () => "", () => false, () => undefined), /administrator/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("root's seed scan records what lsof sees, refuses a symlinked store, and its installer runs no account code", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-scan-")));
  try {
    const store = join(root, "dependencies"), seed = join(store, "abc"), out = join(root, "open-files");
    mkdirSync(seed, { recursive: true }); mkdirSync(out, { mode: 0o755 }); chmodSync(root, 0o755); chmodSync(out, 0o755);
    const lsof = join(root, "lsof");
    writeFileSync(lsof, `#!/bin/bash\nprintf 'p42\\nfcwd\\nn%s\\n' '${seed}/node_modules/x/index.js'\n`, { mode: 0o755 });
    const script = join(process.cwd(), "deploy/mac/seed-open-files.py");
    const run = (...roots: string[]) => spawnSync("python3", ["-I", script, "--out", out, "--lsof", lsof, ...roots], { encoding: "utf8" });
    const ok = run(store);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(attestedOpen(seed, { dir: out, rootUid: process.getuid!() }), true);
    symlinkSync(root, join(root, "alias")); // the store itself is a real folder; its parent is a link
    const refused = run(join(root, "alias/dependencies"));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not a symlink/);

    const installer = join(process.cwd(), "deploy/mac/install-seed-open-files.sh");
    const plist = spawnSync("bash", [installer, "--print-plist", store], { encoding: "utf8" });
    assert.equal(plist.status, 0, plist.stderr);
    assert.match(plist.stdout, /<string>\/usr\/bin\/python3<\/string>\s*<string>-I<\/string>\s*<string>\/Library\/Application Support\/Remudero\/libexec\/seed-open-files.py<\/string>/);
    assert.match(plist.stdout, new RegExp(`<string>${store}</string>`));
    if (process.getuid!() !== 0) assert.match(spawnSync("bash", [installer, store], { encoding: "utf8" }).stderr, /run with sudo/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
