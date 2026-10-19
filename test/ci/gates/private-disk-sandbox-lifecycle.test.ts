import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, afterEach, test } from "node:test";
import * as review from "#src/lib/review.js";
import { preopenGateSandboxArgv } from "#src/lib/preopen-gate.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

// The pre-migration reviewer gives this test RAM /tmp AND an already writable, private disk HOME.
// Use only that existing throwaway bind for nested fixtures; never grant or borrow another host root.
const inheritedHome = process.env.HOME, priorTmpdir = process.env.TMPDIR;
if (process.platform === "linux" && inheritedHome && /^rmd-proof-home-/.test(basename(inheritedHome)) && [0x01021994n, 0x858458f6n].includes(fs.statfsSync(tmpdir(), { bigint: true }).type)) {
  const home = fs.lstatSync(inheritedHome);
  if (home.isDirectory() && home.uid === process.geteuid?.() && (home.mode & 0o777) === 0o700 && ![0x01021994n, 0x858458f6n].includes(fs.statfsSync(inheritedHome, { bigint: true }).type)) {
    process.env.TMPDIR = inheritedHome;
    after(() => { if (priorTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmpdir; });
  }
}

afterEach(() => review.setProofSandboxForTests());

test("proof and preopen tmp binds belong to each throwaway home", (t) => {
  const { dir } = ownedFixtureDir(t, "disk-sandbox-argv");
  const cwd = join(dir, "checkout"), home = join(dir, "home"), other = join(dir, "other-home"), harness = join(dir, "harness");
  for (const p of [cwd, home, other, harness]) mkdirSync(p, { mode: 0o700 });
  const input = { cwd, home, env: {} };
  const argv = review.proofSandboxArgv(input), scratch = join(realpathSync(home), ".rmd-private-tmp");
  const tmpAt = argv.findIndex((s, i) => s === "--bind" && argv[i + 2] === "/tmp");
  assert.ok(tmpAt >= 0, "private disk scratch replaces the anonymous tmpfs mount");
  assert.equal(argv[tmpAt + 1], scratch);
  assert.equal(statSync(scratch).mode & 0o777, 0o700);
  for (const flag of ["--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session"]) assert.ok(argv.includes(flag), flag);
  assert.deepEqual(review.proofSandboxArgv(input), argv, "same HOME reuses only its own private tree");
  const second = review.proofSandboxArgv({ ...input, home: other });
  assert.equal(second.includes(scratch), false, "no second sandbox receives the first sandbox's scratch");
  const gate = preopenGateSandboxArgv({ cwd, home, harnessRoot: harness, env: {} }, {});
  const harnessAt = gate.findIndex((s, i) => s === "--ro-bind" && gate[i + 1] === realpathSync(harness));
  const diskAt = gate.findIndex((s, i) => s === "--bind" && gate[i + 2] === "/tmp");
  assert.ok(diskAt >= 0 && harnessAt > diskAt, "a harness beneath /tmp is mounted after the private disk");
});

test("private disk scratch refuses symlinks and nonprivate directories", (t) => {
  const { dir } = ownedFixtureDir(t, "disk-sandbox-refusal");
  const cwd = join(dir, "checkout"), home = join(dir, "home"), outside = join(dir, "outside");
  for (const p of [cwd, home, outside]) mkdirSync(p, { mode: 0o700 });
  const scratch = join(home, ".rmd-private-tmp");
  symlinkSync(outside, scratch);
  assert.throws(() => review.proofSandboxArgv({ cwd, home, env: {} }), review.ProofSandboxUnavailableError);
  fs.unlinkSync(scratch);
  mkdirSync(scratch, { mode: 0o777 });
  chmodSync(scratch, 0o777);
  assert.throws(() => review.proofSandboxArgv({ cwd, home, env: {} }), /not private/);
  chmodSync(scratch, 0o700);
  assert.deepEqual(fs.readdirSync(outside), [], "no data was written through the refused alias");
});

test("a disk scratch setup failure never degrades a Linux proof to unsandboxed", (t) => {
  const made: string[] = [], original = fs.mkdirSync;
  let spawned = false;
  try {
    t.mock.method(fs, "mkdirSync", ((path: fs.PathLike, options: fs.MakeDirectoryOptions) => {
      const result = original(path, options);
      if (String(path).endsWith("/.rmd-private-tmp")) made.push(String(path));
      return result;
    }) as typeof fs.mkdirSync);
    t.mock.method(fs, "statfsSync", (() => { throw Error("fixture disk metadata unavailable"); }) as typeof fs.statfsSync);
    syncBuiltinESMExports();
    const exec = (() => { spawned = true; return ""; }) as unknown as typeof execFileSync;
    const status = review.probeProofSandbox("linux", exec);
    assert.equal(status.mode, "unavailable");
    assert.match(status.mode === "unavailable" ? status.reason : "", /private disk.*metadata unavailable/);
    assert.equal(spawned, false, "no executable starts after storage setup fails");
    assert.ok(made.length > 0, "the real default setup ran");
    assert.ok(made.every(p => !existsSync(p)), "the probe's existing HOME owner removes partial scratch");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("unavailable private storage refuses both default proof launchers and removes their homes", async (t) => {
  const { dir } = ownedFixtureDir(t, "disk-sandbox-unavailable"), homes: string[] = [];
  const original = fs.mkdtempSync;
  let spawned = false;
  try {
    t.mock.method(fs, "mkdtempSync", ((...args: Parameters<typeof fs.mkdtempSync>) => {
      const path = original(...args);
      if (typeof path === "string" && basename(path).startsWith("rmd-proof-home-")) homes.push(path);
      return path;
    }) as typeof fs.mkdtempSync);
    t.mock.method(childProcess, "execFileSync", (() => { spawned = true; return ""; }) as unknown as typeof execFileSync);
    syncBuiltinESMExports();
    review.setProofSandboxForTests({ mode: "unavailable", reason: "fixture private disk unavailable" });
    assert.throws(() => review.defaultProofSpawner(process.execPath, ["-e", ""], dir, 1000), /fixture private disk unavailable/);
    await assert.rejects(review.defaultAsyncProofSpawner(process.execPath, ["-e", ""], dir, 1000), /fixture private disk unavailable/);
    assert.equal(spawned, false, "neither launcher starts a command after a storage refusal");
    assert.equal(homes.length, 2, "both real default launchers created their own temporary HOME");
    assert.ok(homes.every(path => !existsSync(path)), "preparation failure removes each partial HOME");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("private disk scratch cannot alias a protected install or credential", (t) => {
  const { dir } = ownedFixtureDir(t, "disk-sandbox-alias");
  const cwd = join(dir, "checkout"), home = join(dir, "home");
  for (const p of [cwd, home]) mkdirSync(p, { mode: 0o700 });
  review.proofSandboxArgv({ cwd, home, env: {} });
  const scratch = join(home, ".rmd-private-tmp"), key = join(scratch, "fixture-key");
  writeFileSync(key, "fixture-only-not-a-secret");
  assert.throws(() => review.proofSandboxArgv({ cwd, home, env: { GH_APP_PRIVATE_KEY_PATH: key } }), /protected bind or credential/);
  const install = join(scratch, "fixture-install");
  mkdirSync(install);
  symlinkSync(install, join(cwd, "node_modules"));
  assert.throws(() => review.proofSandboxArgv({ cwd, home, env: {} }), /protected bind or credential/);
  assert.equal(readFileSync(key, "utf8"), "fixture-only-not-a-secret");
});

test("private disk scratch refuses RAM backing and a foreign uid", (t) => {
  const { dir } = ownedFixtureDir(t, "disk-sandbox-metadata");
  const cwd = join(dir, "checkout"), home = join(dir, "home");
  for (const p of [cwd, home]) mkdirSync(p, { mode: 0o700 });
  const original = fs.fstatSync;
  try {
    t.mock.method(fs, "statfsSync", (() => ({ type: 0x01021994n })) as unknown as typeof fs.statfsSync);
    syncBuiltinESMExports();
    assert.throws(() => review.proofSandboxArgv({ cwd, home, env: {} }), /RAM-backed/);
    t.mock.restoreAll();
    t.mock.method(fs, "fstatSync", ((...args: Parameters<typeof fs.fstatSync>) => ({ ...original(...args), uid: (process.geteuid?.() ?? 0) + 1 })) as typeof fs.fstatSync);
    syncBuiltinESMExports();
    assert.throws(() => review.proofSandboxArgv({ cwd, home, env: {} }), /not private/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("a transient disk setup refusal is not cached as a boot verdict", (t) => {
  const { dir } = ownedFixtureDir(t, "disk-sandbox-recovery");
  const stats = fs.statfsSync(dir, { bigint: true });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let unreadable = true, spawns = 0;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    t.mock.method(fs, "statfsSync", (() => { if (unreadable) throw Error("fixture disk read failed"); return stats; }) as unknown as typeof fs.statfsSync);
    t.mock.method(childProcess, "execFileSync", (() => { spawns++; return ""; }) as unknown as typeof execFileSync);
    syncBuiltinESMExports();
    review.setProofSandboxForTests();
    assert.equal(review.proofSandboxStatus().mode, "unavailable");
    unreadable = false;
    const available = review.proofSandboxStatus();
    assert.equal(available.mode, "bwrap");
    assert.equal(review.proofSandboxStatus(), available);
    assert.equal(spawns, 1, "only an assessed runtime answer is memoised");
  } finally {
    Object.defineProperty(process, "platform", platform);
    review.setProofSandboxForTests();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

for (const async of [false, true]) for (const mode of ["success", "failure", "timeout"]) {
  test(`private disk scratch is removed after ${async ? "async" : "sync"} proof ${mode}`, async (t) => {
    const fixture = ownedFixtureDir(t, "disk-sandbox-cleanup"), cwd = join(fixture.dir, "checkout"), binary = join(fixture.dir, "fixture-bwrap"), log = join(fixture.dir, "homes.jsonl");
    mkdirSync(cwd);
    writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path');
const home=process.env.HOME, scratch=path.join(home,'.rmd-private-tmp');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({home,scratch})+'\\n');
if(process.argv.at(-1)==='')process.exit(0);
fs.writeFileSync(path.join(scratch,'fixture-only'),'owned');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({home,scratch,phase:'written'})+'\\n');
const mode=process.argv.at(-1);
if(mode==='fixture-failure')process.exit(3);
if(mode==='fixture-timeout')setInterval(()=>{},1000);
else process.stdout.write('fixture-ok');
`, { mode: 0o755 });
    review.setProofSandboxForTests({ mode: "bwrap", binary });
    const args = ["-e", "fixture-" + mode], timeout = mode === "timeout" ? 1000 : 5000;
    const expectedFailure = (error: unknown) => {
      const value = error as { code?: unknown; status?: unknown; killed?: boolean; signal?: unknown };
      return mode === "timeout" ? value.killed === true || typeof value.signal === "string" : value.code === 3 || value.status === 3;
    };
    if (async) {
      const child = review.defaultAsyncProofSpawner(process.execPath, args, cwd, timeout);
      fixture.until(child.then(() => undefined, () => undefined));
      if (mode === "success") assert.equal(await child, "fixture-ok");
      else await assert.rejects(child, expectedFailure);
    } else if (mode === "success") assert.equal(review.defaultProofSpawner(process.execPath, args, cwd, timeout), "fixture-ok");
    else assert.throws(() => review.defaultProofSpawner(process.execPath, args, cwd, timeout), expectedFailure);
    const homes = readFileSync(log, "utf8").trim().split("\n").map(s => JSON.parse(s) as { home: string; scratch: string; phase?: string });
    assert.ok(homes.length >= 2, "both the real launcher start check and proof child executed");
    assert.ok(homes.some(row => row.phase === "written"), "the child actually wrote its owned scratch before the terminal outcome");
    for (const value of homes) {
      assert.equal(existsSync(value.home), false);
      assert.equal(existsSync(value.scratch), false);
    }
    t.diagnostic("fixture runner tests launcher lifecycle only, not kernel isolation");
  });
}

test("real Linux proof scratch is disk-backed and isolated between runs", (t) => {
  if (process.platform !== "linux") {
    assert.equal(review.probeProofSandbox().mode, "unsandboxed");
    t.diagnostic("real platform refusal verified; Linux kernel isolation/performance is not exercised here");
    return;
  }
  const status = review.probeProofSandbox();
  if (status.mode !== "bwrap") {
    assert.match(status.reason, /bwrap/);
    t.diagnostic("real bwrap unavailability verified; kernel isolation/performance remains unqualified");
    return;
  }
  const { dir } = ownedFixtureDir(t, "disk-sandbox-linux"), cwd = join(dir, "checkout");
  mkdirSync(cwd);
  const homes = [join(dir, "home-a"), join(dir, "home-b")];
  const parentNet = fs.readlinkSync("/proc/self/ns/net");
  const started = performance.now();
  for (const [index, home] of homes.entries()) {
    mkdirSync(home, { mode: 0o700 });
    const marker = `private-marker-${index}`;
    const code = `const f=require('node:fs');
f.writeFileSync('/tmp/'+process.argv[1],'x'.repeat(65536));
process.stdout.write(JSON.stringify({type:String(f.statfsSync('/tmp',{bigint:true}).type),names:f.readdirSync('/tmp').filter(s=>s.startsWith('private-marker-')),net:f.readlinkSync('/proc/self/ns/net')}));`;
    const out = JSON.parse(execFileSync(status.binary, [...review.proofSandboxArgv({ cwd, home, env: {} }), process.execPath, "-e", code, marker], { cwd, env: review.proofChildEnv(home), encoding: "utf8", timeout: 10000 }));
    assert.notEqual(out.type, String(0x01021994n));
    assert.notEqual(out.type, String(0x858458f6n));
    assert.deepEqual(out.names, [marker]);
    assert.notEqual(out.net, parentNet, "the existing private network namespace remains");
    assert.equal(statSync(join(home, ".rmd-private-tmp", marker)).size, 65536);
  }
  t.diagnostic(`two real disk-backed private sandboxes, 128 KiB total: ${Math.round(performance.now() - started)} ms; existing 10s startup bounds unchanged`);
});
