/**
 * W1-T13051 — a suite that runs a Linux host script on a Mac gets the Linux command contract.
 *
 * macOS `chmod` reads `--` as a file name; GNU `chmod` reads it as the end of options. deploy/host-update.sh
 * passes it, so 9 of the 36 suites that run that script were red on the Mac while hosted CI was green
 * (measured 2026-11-16). The shared setup now puts one directory first on PATH on macOS whose `chmod`
 * honours the marker. These tests pin what that directory does, that it is the only such stub, and that
 * Linux is untouched.
 *
 * The native macOS marker difference says so when skipped. Argument forwarding and native failures run
 * on every host; a fresh process selects darwin before loading the complete setup to check PATH order.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";

import { REPO_ROOT } from "#test/helpers/repo-root.js";
import {
  chmodShimSource, installLinuxCommandContract, LINUX_CONTRACT_COMMANDS, LINUX_CONTRACT_DIR_PREFIX,
} from "#test/setup/linux-command-contract.js";

const mode = (path: string): number => statSync(path).mode & 0o777;
const scratch = (): string => mkdtempSync(join(tmpdir(), "rmd-linux-contract-case-"));

/** The contract directory the shared setup put on this process's PATH, if any. */
const contractDirOnPath = (): string | undefined =>
  (process.env.PATH ?? "").split(":").find((entry) => basename(entry).startsWith(LINUX_CONTRACT_DIR_PREFIX));

function onMac(t: TestContext): boolean {
  if (process.platform === "darwin") return true;
  t.skip("the marker difference exists only in macOS chmod; the install rule is covered on every platform below");
  return false;
}

test("W1-T13051 criterion 1: the complete shared setup leaves one process-owned contract directory first on PATH", () => {
  const root = scratch();
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { readdirSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { spawnSync } from 'node:child_process';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    await import('#test/setup/tmp-hygiene.ts');
    const path = process.env.PATH;
    await import('#test/setup/tmp-hygiene.ts');
    const { LINUX_CONTRACT_DIR_PREFIX } = await import('#test/setup/linux-command-contract.ts');
    const { setupDirOwnerTag } = await import('#test/setup/no-live-remote.ts');
    const dirs = readdirSync(tmpdir()).filter(name => name.startsWith(LINUX_CONTRACT_DIR_PREFIX + setupDirOwnerTag()));
    const resolved = spawnSync('/bin/bash', ['-c', 'command -v chmod'], { encoding: 'utf8' });
    process.stdout.write(JSON.stringify({ path, after: process.env.PATH, dirs,
      entries: dirs.map(dir => readdirSync(join(tmpdir(), dir))), resolved: resolved.stdout.trim() }));
  `], { cwd: REPO_ROOT, env: { ...process.env, TMPDIR: root }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const seen = JSON.parse(child.stdout) as {
    path: string; after: string; dirs: string[]; entries: string[][]; resolved: string;
  };
  assert.equal(seen.dirs.length, 1, "loading the shared setup twice creates only one contract directory");
  const dir = join(root, seen.dirs[0]!);
  assert.equal(seen.path.split(":")[0], dir, "the contract must precede every other setup directory");
  assert.equal(seen.after, seen.path);
  assert.equal(dirname(dir), root, "the directory belongs to the child's own temp root");
  assert.deepEqual(seen.entries, [["chmod"]]);
  assert.equal(seen.resolved, join(dir, "chmod"));
  assert.equal(existsSync(dir), false, "the existing exit sweep removes the contract directory");
});

test("W1-T13051 criterion 1: on macOS a child of any test process finds a chmod that accepts the end-of-options marker", (t) => {
  if (!onMac(t)) return;
  const dir = contractDirOnPath();
  assert.ok(dir, `the shared setup must have put a ${LINUX_CONTRACT_DIR_PREFIX}* directory on PATH: ${process.env.PATH}`);
  assert.equal((process.env.PATH ?? "").split(":")[0], dir, "the contract directory must be first on PATH");
  const resolved = spawnSync("bash", ["-c", "command -v chmod"], { encoding: "utf8", env: process.env }).stdout.trim();
  assert.equal(resolved, join(dir, "chmod"), "a child's `chmod` must resolve to the contract directory's");
  const dirOfTargets = scratch();
  // CONTROL, on its own file: the platform's chmod refuses the same arguments, so the pass below is the shim's doing.
  const control = join(dirOfTargets, "control");
  writeFileSync(control, "x", { mode: 0o644 });
  const bare = spawnSync("/bin/chmod", ["600", "--", control], { encoding: "utf8" });
  assert.notEqual(bare.status, 0, "macOS chmod is expected to refuse `--`; if it now accepts it this task is obsolete");
  // It reads `--` as a missing file: it still changes the real operand, then exits non-zero for the marker.
  assert.match(bare.stderr, /--/);
  const target = join(dirOfTargets, "snapshot");
  writeFileSync(target, "x", { mode: 0o644 });
  assert.equal(mode(target), 0o644);
  // The call deploy/host-update.sh makes, through the PATH every suite's child inherits.
  const viaPath = spawnSync("bash", ["-c", 'chmod 600 -- "$1"', "bash", target], { encoding: "utf8", env: process.env });
  assert.equal(viaPath.status, 0, viaPath.stderr);
  assert.equal(mode(target), 0o600);
});

test("W1-T13051 criterion 2: the shim forwards exact mode and operand bytes, dropping only the first marker", () => {
  const dir = scratch();
  const recorder = join(dir, "record-arguments");
  writeFileSync(recorder, '#!/bin/bash\nprintf \'%s\\0\' "$@"\n', { mode: 0o755 });
  const shim = join(dir, "chmod-under-test");
  writeFileSync(shim, chmodShimSource(recorder), { mode: 0o755 });
  const cases = [
    { args: ["640", "a", "b"], expected: ["640", "a", "b"] },
    { args: ["--", "-w", "absent"], expected: ["-w", "absent"] },
    { args: ["600", "--", "-dashed", "--"], expected: ["600", "-dashed", "--"] },
    { args: ["u=rw", "--", "", "space name", "'quote\"", "line\nbreak", "é"],
      expected: ["u=rw", "", "space name", "'quote\"", "line\nbreak", "é"] },
  ];
  for (const { args, expected } of cases) {
    const result = spawnSync(shim, args);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(result.stdout, Buffer.from(expected.map(arg => `${arg}\0`).join("")), JSON.stringify(args));
    assert.equal(result.stderr.length, 0);
  }
});

test("W1-T13051 criterion 2: the real chmod's status and exact error text survive the shim", () => {
  const dir = scratch();
  const shim = join(dir, "chmod-under-test");
  writeFileSync(shim, chmodShimSource(), { mode: 0o755 });
  const a = join(dir, "a"), b = join(dir, "b");
  writeFileSync(a, "x", { mode: 0o644 });
  writeFileSync(b, "x", { mode: 0o644 });
  // No marker: mode and both operands reach the real chmod unchanged.
  assert.equal(spawnSync(shim, ["640", a, b], { encoding: "utf8" }).status, 0);
  assert.deepEqual([mode(a), mode(b)], [0o640, 0o640]);
  const success = spawnSync(shim, ["600", "--", a, b], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual([mode(a), mode(b)], [0o600, 0o600]);
  // A chmod that should fail still fails, with the real command's own status and error text.
  const missing = join(dir, "no-such-file");
  for (const { args, forwarded } of [
    { args: ["600", "--", missing], forwarded: ["600", missing] },
    { args: ["--", "-w", missing], forwarded: ["-w", missing] },
    { args: ["invalid-mode", "--", a], forwarded: ["invalid-mode", a] },
    { args: ["invalid-mode", a], forwarded: ["invalid-mode", a] },
    { args: ["600", "--", missing, "--"], forwarded: ["600", missing, "--"] },
  ]) {
    const real = spawnSync("/bin/chmod", forwarded, { encoding: "utf8", cwd: dir });
    const through = spawnSync(shim, args, { encoding: "utf8", cwd: dir });
    assert.notEqual(real.status, 0, JSON.stringify(forwarded));
    assert.equal(through.status, real.status, JSON.stringify(args));
    assert.equal(through.stderr, real.stderr, JSON.stringify(args));
    assert.equal(through.stdout, real.stdout, JSON.stringify(args));
  }
});

/** A test file that writes a `chmod` stub of its own, in either quote style. */
const OWN_CHMOD_STUB = /writeFileSync\(\s*join\([^)]*,\s*["']chmod["']\s*\)/;

function testSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|mts|mjs|js)$/.test(entry.name)) out.push(path);
    }
  };
  walk(root);
  return out;
}

test("W1-T13051 criterion 3: no suite carries its own chmod shim; the shared setup is the one place", () => {
  // CONTROL: the recogniser matches the private stub this task removed, in the form it had. The sample is
  // assembled from two pieces so this file does not itself read as a suite with a stub of its own.
  assert.match(`  writeFileSync(join(bin, ${JSON.stringify("chmod")}), \`#!/usr/bin/env bash`, OWN_CHMOD_STUB);
  assert.doesNotMatch('fs.writeFileSync(join(dir, "docker"), stub)', OWN_CHMOD_STUB);
  const files = testSources(join(REPO_ROOT, "test"));
  // CONTROL: the walk really read the tree, and saw the one file allowed to write the shim.
  assert.ok(files.length > 1000, `only ${files.length} test sources were walked`);
  const allowed = "test/setup/linux-command-contract.ts";
  assert.ok(files.some((f) => relative(REPO_ROOT, f) === allowed), `${allowed} was not walked`);
  const own = files.map((f) => relative(REPO_ROOT, f))
    .filter((rel) => rel !== allowed && OWN_CHMOD_STUB.test(readFileSync(join(REPO_ROOT, rel), "utf8")));
  assert.deepEqual(own, [], "a suite writes its own chmod stub; add the difference to test/setup/linux-command-contract.ts instead");
  // The suite that carried the private stub now names the shared one.
  const backup = readFileSync(join(REPO_ROOT, "test/deploy/the-nightly-state-backup-keeps-a-copy-of-the-container-config.test.ts"), "utf8");
  assert.match(backup, /test\/setup\/linux-command-contract\.ts/);
});

test("W1-T13051 criterion 4: on Linux the setup adds and writes nothing, and on macOS it shadows chmod and no other command", () => {
  // Linux: nothing is created and PATH is the same string. The seam fails the test if a directory is asked for.
  const linuxEnv: NodeJS.ProcessEnv = { PATH: "/usr/local/bin:/usr/bin" };
  const linux = installLinuxCommandContract({
    platform: "linux", env: linuxEnv, mkdtemp: () => { throw new Error("no directory may be created on Linux"); },
  });
  assert.deepEqual(linux, { installed: false });
  assert.deepEqual(linuxEnv, { PATH: "/usr/local/bin:/usr/bin" });
  // macOS rule, driven on this platform through the seams: one directory, first on PATH, holding chmod only.
  const macEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  const made: string[] = [];
  const mac = installLinuxCommandContract({
    platform: "darwin", env: macEnv, mkdtemp: (prefix) => { const dir = mkdtempSync(prefix); made.push(dir); return dir; },
  });
  assert.equal(mac.installed, true);
  assert.equal(made.length, 1);
  assert.equal(mac.dir, made[0]);
  assert.ok(basename(made[0]!).startsWith(LINUX_CONTRACT_DIR_PREFIX));
  assert.equal(macEnv.PATH, `${made[0]}:/usr/bin:/bin`);
  assert.deepEqual(readdirSync(made[0]!).sort(), [...LINUX_CONTRACT_COMMANDS].sort());
  assert.deepEqual([...LINUX_CONTRACT_COMMANDS], ["chmod"]);
  assert.equal(mode(join(made[0]!, "chmod")), 0o755);
  assert.equal(readFileSync(join(made[0]!, "chmod"), "utf8"), chmodShimSource());
  // The directory this process itself runs under holds the same and nothing more.
  const live = contractDirOnPath();
  if (process.platform === "darwin") assert.deepEqual(readdirSync(live!).sort(), [...LINUX_CONTRACT_COMMANDS].sort());
  else assert.equal(live, undefined, "no contract directory may be on a Linux test process's PATH");
});
