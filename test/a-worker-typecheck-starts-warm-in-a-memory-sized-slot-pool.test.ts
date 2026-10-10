// test/a-worker-typecheck-starts-warm-in-a-memory-sized-slot-pool.test.ts — the follow-ups to #10612. OBSERVED
// 2026-10-10 08:12–09:55Z: two sandboxed worker `npm run typecheck` runs (2.4 and 2.2 GB) held the core container at
// 8.47 of 8.61 GiB for over an hour. Three gaps let them:
//   1. implement worktrees hang off `repos/<repo>`, whose git dir never got a typecheck seed — the sweep's merge probe
//      publishes into the install root's — so every worker's first check ran cold;
//   2. the shared slot pool admitted by count alone, so the pair both ran on 2 default slots;
//   3. `rmd preflight`'s typecheck wrote its buildinfo into the git dir, read-only in the sandbox: a false TS5033 red.
// FIXTURES ONLY: every clone, tree, install, slot dir and buildinfo lives under this test's tmp dirs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { typecheckStep, type PreflightSpawn } from "../src/lib/commit-message.js";
import { acquireTestSlot, readMemoryHeadroom } from "../src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { refreshCanonicalSeed, TYPECHECK_BUILDINFO_NAME, TYPECHECK_COLD_PEAK_BYTES } from "../src/lib/typecheck-buildinfo.js";
import { NPM_TYPECHECK_SLOT_LABEL, runTypecheck, WORKTREE_BUILDINFO_NAME } from "../src/lib/typecheck-run.js";
import { worktreeAdd } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSCONFIG = JSON.stringify({ compilerOptions: { types: [], noEmit: true, strict: true }, include: ["*.ts"] });
const SOURCES: Record<string, string> = {
  "tsconfig.json": TSCONFIG,
  "a.ts": "export function width(n: number): number { return n * 2; }\n",
  "b.ts": 'import { width } from "./a";\nexport const w: number = width(3);\n',
  ".gitignore": "node_modules\n*.tsbuildinfo\n",
};
const GiB = 1024 ** 3;

/** A slot dir of this test's own, named in the env too, with two slots — so no run here can wait on the host's. */
function slotPool(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}warm-typecheck-slots-`));
  const keys = ["RMD_TEST_SLOT_DIR", "RMD_TEST_SLOTS", "RMD_TEST_SLOT_PARENT"];
  const saved = keys.map((key) => process.env[key]);
  process.env.RMD_TEST_SLOT_DIR = dir;
  process.env.RMD_TEST_SLOTS = "2";
  delete process.env.RMD_TEST_SLOT_PARENT;
  t.after(() => {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const heldRecords = (dir: string): Array<{ label: string; memoryBytes?: number }> =>
  readdirSync(dir).filter((name) => name.startsWith("slot-")).map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));

/** The real compiler, recording each argv. */
function realTsc(seen: string[][] = []): (file: string, args: readonly string[], cwd: string) => { status: number | null } {
  return (file, args, cwd) => {
    seen.push([...args]);
    return { status: spawnSync(file, [...args], { cwd, encoding: "utf8" }).status };
  };
}

/** A tiny project whose `node_modules` links this repo's install, plus one linked lane of it. */
function projectWithLane(t: TestContext): { dir: string; lane: string; laneGitDir: string } {
  const tree = gitRepo({ kind: "warm-typecheck-project" });
  t.after(() => tree.cleanup());
  symlinkSync(join(REPO_ROOT, "node_modules"), join(tree.dir, "node_modules"));
  for (const [name, text] of Object.entries(SOURCES)) writeFileSync(join(tree.dir, name), text);
  tree.git("add", ...Object.keys(SOURCES));
  tree.git("commit", "-qm", "base");
  const lane = join(realpathSync(dirname(tree.dir)), `${RMD_TMP_PREFIX}warm-typecheck-lane-${process.pid}-${Date.now()}`);
  tree.addWorktree(lane, `lane-${Date.now()}`);
  t.after(() => rmSync(lane, { recursive: true, force: true }));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(lane, "node_modules"));
  const laneGitDir = realpathSync(spawnSync("git", ["-C", lane, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim());
  return { dir: tree.dir, lane, laneGitDir };
}

/**
 * The fleet host's shape: an install root whose `node_modules` is a real directory (the compiler linked into it), and a
 * managed clone at `<root>/repos/app` with no install of its own and no buildinfo — the clone implement worktrees hang
 * off. The clone's own `node_modules` link stands in for `resolveNodeModulesSource`'s install-root fallback.
 */
function fleetHost(t: TestContext): { root: string; install: string; managed: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}warm-typecheck-host-`)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const install = join(root, "install");
  renameSync(gitRepo({ kind: "warm-typecheck-install" }).dir, install);
  mkdirSync(join(install, "node_modules", ".bin"), { recursive: true });
  symlinkSync(realpathSync(join(REPO_ROOT, "node_modules", "typescript")), join(install, "node_modules", "typescript"));
  symlinkSync(realpathSync(join(REPO_ROOT, "node_modules", ".bin", "tsc")), join(install, "node_modules", ".bin", "tsc"));
  for (const [name, text] of Object.entries(SOURCES)) writeFileSync(join(install, name), text);
  const seed = gitRepo({ kind: "warm-typecheck-seed" });
  for (const [name, text] of Object.entries(SOURCES)) writeFileSync(join(seed.dir, name), text);
  seed.git("add", ...Object.keys(SOURCES));
  seed.git("commit", "-qm", "seed");
  const origin = gitRepo({ bare: true, kind: "warm-typecheck-origin" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos"));
  const managed = join(root, "repos", "app");
  renameSync(gitRepo({ cloneFrom: origin.dir, kind: "warm-typecheck-managed" }).dir, managed);
  symlinkSync(join(install, "node_modules"), join(managed, "node_modules"));
  return { root, install, managed };
}

test("cutting a worktree from the managed clone publishes the install root's typecheck seed, so a sandboxed worker's first check runs warm and takes no slot", (t) => {
  const slots = slotPool(t);
  const host = fleetHost(t);
  // The install root's own check writes the only buildinfo on the host, as the sweep's merge probe does on the fleet.
  assert.equal(runTypecheck(host.install, [], { spawn: realTsc(), log: () => {} }), 0);
  assert.ok(existsSync(join(host.install, ".git", TYPECHECK_BUILDINFO_NAME)), "the install root holds a buildinfo");
  const seed = join(host.managed, ".git", TYPECHECK_BUILDINFO_NAME);
  assert.equal(existsSync(seed), false, "the managed clone starts with none");

  const wt = join(host.root, "worktrees", "lane-1");
  const rows: string[] = [];
  worktreeAdd(host.managed, wt, "run-lane-1", "origin/main", { log: (step) => rows.push(step), warn: () => {} });
  assert.ok(existsSync(seed), "cutting the worktree published the seed into the managed clone's git dir");
  assert.deepEqual(rows.filter((step) => step.startsWith("worktree.typecheck_seed")), [], "a published seed is silent");

  // The worker's sandbox binds the clone's git dir read-only; only the worktree is writable.
  const wtGitDir = realpathSync(spawnSync("git", ["-C", wt, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim());
  const canWrite = (dir: string) => realpathSync(dir) === realpathSync(wt);
  const lines: string[] = [];
  const seen: string[][] = [];
  const code = runTypecheck(wt, [], {
    spawn: realTsc(seen), canWrite, log: (line) => lines.push(line),
    acquireSlot: () => assert.fail("a warm first check must not wait for a slot"),
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(lines, [], "no typecheck.cold line: the first check started warm");
  assert.deepEqual(seen, [["-p", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile", join(wt, WORKTREE_BUILDINFO_NAME)]]);
  assert.ok(!existsSync(join(wtGitDir, TYPECHECK_BUILDINFO_NAME)), "nothing was written into the read-only git dir");
  assert.deepEqual(heldRecords(slots), []);
});

test("the managed clone's seed is refreshed only when the install root's buildinfo is newer, and a clone without a linked install gets none", (t) => {
  const host = fleetHost(t);
  const wt = join(host.root, "worktrees", "lane-2");
  assert.equal(spawnSync("git", ["-C", host.managed, "worktree", "add", "-q", "-b", "lane-2", wt, "origin/main"]).status, 0);
  assert.equal(refreshCanonicalSeed(wt), "no-seed", "the tree links no install yet");
  symlinkSync(join(host.install, "node_modules"), join(wt, "node_modules"));
  assert.equal(refreshCanonicalSeed(wt), "no-seed", "the install root has no buildinfo to give");
  assert.equal(runTypecheck(host.install, [], { spawn: realTsc(), log: () => {}, acquireSlot: () => ({ outcome: "acquired", concurrency: 1, waitedMs: 0, note: "", refresh: () => {}, release: () => {} }) }), 0);
  assert.equal(refreshCanonicalSeed(wt), "published");
  assert.equal(refreshCanonicalSeed(wt), "kept", "a seed at least as new as the donor's is left alone");
  const donor = join(host.install, ".git", TYPECHECK_BUILDINFO_NAME);
  const later = new Date(Date.now() + 60_000);
  utimesSync(donor, later, later);
  assert.equal(refreshCanonicalSeed(wt), "published", "a newer install-root buildinfo refreshes it");
  writeFileSync(donor, JSON.stringify({ version: "0.0.1-fixture" }));
  utimesSync(donor, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
  assert.equal(refreshCanonicalSeed(wt), "mismatch", "another compiler's buildinfo is never published");
  assert.equal(refreshCanonicalSeed(host.install), "no-seed", "the install root is its own seed");
});

test("a cold typecheck waits while the memory headroom cannot hold its peak plus a live sandboxed holder's, and takes a slot from the same pool once it can", (t) => {
  const slots = slotPool(t);
  const project = projectWithLane(t);
  // A sandboxed worker's cold check already holds a slot: another pid namespace, its peak named in the record.
  const peer = acquireTestSlot(NPM_TYPECHECK_SLOT_LABEL, {
    dir: slots, slots: 2, memoryBytes: TYPECHECK_COLD_PEAK_BYTES, pidNamespace: () => "pid:[4026532001]", log: () => {},
  });
  assert.equal(peer.outcome, "acquired");
  const during: Array<Array<{ label: string; memoryBytes?: number }>> = [];
  const fakeTsc = () => { during.push(heldRecords(slots)); return { status: 0 }; };

  const short: string[] = [];
  const tight = { dir: slots, slots: 2, waitBoundMs: 0, memoryHeadroom: () => 1.5 * TYPECHECK_COLD_PEAK_BYTES, log: () => {} };
  assert.equal(runTypecheck(project.dir, [], { spawn: fakeTsc, testSlot: tight, log: (line) => short.push(line) }), 0);
  assert.match(short.join("\n"), /"slot":"wait_bound_exceeded"/, "two peaks do not fit in the headroom, so it did not take the free slot");
  assert.match(short.join("\n"), /memory headroom 3840 MiB < 5120 MiB/);
  assert.deepEqual(during[0]?.map((r) => r.label), [NPM_TYPECHECK_SLOT_LABEL], "it ran unslotted, never refused");

  const roomy = { ...tight, memoryHeadroom: () => 2 * TYPECHECK_COLD_PEAK_BYTES };
  const ran: string[] = [];
  assert.equal(runTypecheck(project.dir, [], { spawn: fakeTsc, testSlot: roomy, log: (line) => ran.push(line) }), 0);
  assert.match(ran.join("\n"), /"slot":"acquired"/);
  assert.deepEqual(during[1]?.map((r) => [r.label, r.memoryBytes]), [
    [NPM_TYPECHECK_SLOT_LABEL, TYPECHECK_COLD_PEAK_BYTES], [NPM_TYPECHECK_SLOT_LABEL, TYPECHECK_COLD_PEAK_BYTES],
  ], "both cold checks held the ONE pool, each naming its peak");

  const suite = acquireTestSlot("suite", { dir: slots, slots: 2, memoryHeadroom: () => 0, log: () => {} });
  assert.equal(suite.outcome, "acquired", "a run that names no peak is admitted by count, as before");
  suite.release();
  peer.release();
  const alone: string[] = [];
  const nothing = { ...tight, memoryHeadroom: () => 0 };
  assert.equal(runTypecheck(project.dir, [], { spawn: fakeTsc, testSlot: nothing, log: (line) => alone.push(line) }), 0);
  assert.match(alone.join("\n"), /"slot":"acquired"/, "with no other holder the first run always goes");

  // A DEAD costed holder never keeps the pool shut: it is reclaimed even while memory closes the free slot beside it.
  const filler = acquireTestSlot("suite", { dir: slots, slots: 2, log: () => {} });
  acquireTestSlot(NPM_TYPECHECK_SLOT_LABEL, { dir: slots, slots: 2, memoryBytes: TYPECHECK_COLD_PEAK_BYTES, pid: 999_999, log: () => {} });
  filler.release();
  const revived: string[] = [];
  const deadPeer = { ...tight, isPidAlive: () => false };
  assert.equal(runTypecheck(project.dir, [], { spawn: fakeTsc, testSlot: deadPeer, log: (line) => revived.push(line) }), 0);
  assert.match(revived.join("\n"), /"slot":"acquired"/, revived.join("\n"));
  assert.deepEqual(during.at(-1)?.map((r) => r.label), [NPM_TYPECHECK_SLOT_LABEL], "the dead record was reclaimed, not waited on");
  assert.deepEqual(heldRecords(slots), []);
});

test("the slot pool's memory headroom is the smaller of MemAvailable and the container's cgroup bound less its droppable cache", () => {
  const files = (entries: Record<string, string>) => (path: string): string => {
    const text = entries[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return text;
  };
  const meminfo = { "/proc/meminfo": "MemTotal: 16000000 kB\nMemAvailable:    6000000 kB\n" };
  const cgroup = {
    "/sys/fs/cgroup/memory.current": "8000000000\n",
    "/sys/fs/cgroup/memory.high": "8589934592\n",
    "/sys/fs/cgroup/memory.max": "9244659712\n",
    "/sys/fs/cgroup/memory.stat": "anon 7000000000\nfile 900000000\nshmem 100000000\nfile_dirty 50000000\nfile_writeback 0\n",
  };
  assert.equal(readMemoryHeadroom(files({ ...meminfo, ...cgroup })), 8589934592 - 8000000000 + 750000000, "memory.high binds first");
  assert.equal(readMemoryHeadroom(files(meminfo)), 6000000 * 1024, "a host process reads MemAvailable alone");
  assert.equal(readMemoryHeadroom(files({ ...meminfo, ...cgroup, "/sys/fs/cgroup/memory.high": "max\n", "/sys/fs/cgroup/memory.max": "max\n" })),
    6000000 * 1024, "an unbounded cgroup adds no reading");
  const { "/sys/fs/cgroup/memory.stat": _stat, ...noStat } = cgroup;
  assert.equal(readMemoryHeadroom(files(noStat)), 8589934592 - 8000000000, "no breakdown: every charged byte is held");
  assert.equal(readMemoryHeadroom(files({})), undefined, "nothing readable sizes nothing");
  const real = readMemoryHeadroom();
  assert.ok(real === undefined || (Number.isFinite(real) && real > 0), `the host's own reading: ${String(real)}`);
});

test("rmd preflight's typecheck in a sandbox whose git dir is read-only keeps its buildinfo in the worktree instead of failing TS5033", (t) => {
  const slots = slotPool(t);
  const project = projectWithLane(t);
  const canWrite = (dir: string) => realpathSync(dir) !== project.laneGitDir;
  const seen: string[][] = [];
  const spawn: PreflightSpawn = (file, args, options) => {
    seen.push([...args]);
    const r = spawnSync(file, [...args], { cwd: options?.cwd, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const step = typecheckStep(project.lane, spawn, { dir: slots, log: () => {} }, canWrite);
  assert.equal(step.ok, true, step.detail);
  const buildInfo = join(project.lane, WORKTREE_BUILDINFO_NAME);
  assert.deepEqual(seen, [["-p", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile", buildInfo]]);
  assert.ok(existsSync(buildInfo), "tsc wrote the worktree's buildinfo");
  assert.ok(!existsSync(join(project.laneGitDir, TYPECHECK_BUILDINFO_NAME)), "nothing was written into the read-only git dir");
  assert.equal(typecheckStep(project.lane, spawn, { dir: slots, log: () => {} }, () => false).ok, true, "nowhere writable runs the plain check");
  assert.deepEqual(seen.at(-1), ["-p", "tsconfig.json", "--noEmit"]);
  assert.deepEqual(heldRecords(slots), []);
});
