import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Synthetic kernel ABI on REAL private file descriptors. This is branch/safety proof,
// not native qualification. The separately retained Azure rehearsal exercises real cgroup2.
test("owned kernel contract binds one fresh lease and refuses unknown population before safe release", async t => {
  const real = { ...fs }, root = real.realpathSync(real.mkdtempSync(join(tmpdir(), "rmd-kernel-contract-")));
  const uid = process.getuid?.(), parentPid = 999001, childPid = 999002;
  const group = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/rmd-heavy-run-80f03329-e69b-4c89-a43c-d416b3c8922e.service`;
  const parent = '/sys/fs/cgroup' + group, physical = join(root, "service"), procFile = join(root, "cgroup");
  real.mkdirSync(physical, { mode: 0o700 });real.writeFileSync(procFile, `0::${group}\n`);
  const descriptors = new Map<number, string>(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const previousSlot = process.env.RMD_TEST_SLOT_DIR;
  let childGone = false;
  const procStat = (pid: number): string => {
    const values = Array<string>(20).fill("0");
    values[0] = pid === childPid && childGone ? "Z" : "S";
    values[1] = String(pid === childPid ? process.pid : pid === process.pid ? parentPid : 1);
    values[19] = String(pid);
    return `${pid} (contract) ${values.join(" ")}`;
  };
  const map = (path: fs.PathLike): fs.PathLike => {
    const p = String(path);
    if (p === "/proc/self/cgroup") return procFile;
    if (p === parent || p.startsWith(parent + '/')) return physical + p.slice(parent.length);
    const fd = /^\/proc\/self\/fd\/(\d+)\/(.+)$/.exec(p);
    if (fd && descriptors.has(Number(fd[1]))) return join(descriptors.get(Number(fd[1]))!, fd[2]!);
    return path;
  };
  Object.defineProperty(process, "platform", { value: "linux" });process.env.RMD_TEST_SLOT_DIR = join(root, "slots");
  t.mock.method(fs, "openSync", ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const mapped = map(path), fd = real.openSync(mapped, flags, mode);descriptors.set(fd, String(mapped));return fd;
  }) as typeof fs.openSync);
  t.mock.method(fs, "lstatSync", ((path: fs.PathLike, options?: fs.StatOptions) => real.lstatSync(map(path), options)) as typeof fs.lstatSync);
  t.mock.method(fs, "realpathSync", ((path: fs.PathLike) => String(path).startsWith(parent) ? String(path) : real.realpathSync(path)) as typeof fs.realpathSync);
  t.mock.method(fs, "statfsSync", ((path: fs.PathLike, options?: fs.StatFsOptions) => String(path).startsWith(parent)
    ? { ...real.statfsSync(physical), type: 0x63677270 } : real.statfsSync(path, options)) as typeof fs.statfsSync);
  t.mock.method(fs, "mkdirSync", ((path: fs.PathLike, options?: fs.MakeDirectoryOptions | fs.Mode) => {
    const mapped = map(path), result = real.mkdirSync(mapped, options);
    if (String(path).startsWith(parent + '/rmd-eval-')) {
      for (const [name, value] of [["cgroup.events", "populated 0\n"], ["cgroup.procs", ""], ["cgroup.kill", ""]]) {
        real.writeFileSync(join(String(mapped), name!), value!, { mode: 0o600 });
      }
    }
    return result;
  }) as typeof fs.mkdirSync);
  t.mock.method(fs, "readlinkSync", ((path: fs.PathLike) => String(path).startsWith('/proc/') ? "pid:[5022]" : real.readlinkSync(path)) as typeof fs.readlinkSync);
  t.mock.method(fs, "readFileSync", ((path: fs.PathOrFileDescriptor, options?: unknown) => {
    const p = String(path), match = /^\/proc\/(\d+|self)\/stat$/.exec(p);
    if (match) return procStat(match[1] === 'self' ? process.pid : Number(match[1]));
    return real.readFileSync(typeof path === 'number' ? path : map(path), options as BufferEncoding);
  }) as typeof fs.readFileSync);
  t.mock.method(fs, "readdirSync", ((path: fs.PathLike, options?: unknown) => String(path) === '/proc'
    ? [1, parentPid, process.pid, childPid].map(String) : real.readdirSync(path, options as fs.ObjectEncodingOptions)) as typeof fs.readdirSync);
  t.mock.method(fs, "writeSync", ((fd: number, ...args: unknown[]) => {
    const path = descriptors.get(fd);
    const result = (real.writeSync as (...args: unknown[]) => number)(fd, ...args);
    if (path?.endsWith('/cgroup.kill')) { childGone = true;real.writeFileSync(join(path.slice(0, -'cgroup.kill'.length), 'cgroup.events'), 'populated 0\n'); }
    return result;
  }) as typeof fs.writeSync);
  t.mock.method(fs, "rmdirSync", ((path: fs.PathLike) => {
    const mapped = map(path);
    for (const file of ['cgroup.events', 'cgroup.procs', 'cgroup.kill']) real.unlinkSync(join(String(mapped), file));
    real.rmdirSync(mapped);
  }) as typeof fs.rmdirSync);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process, 'platform', platform);
    if (previousSlot === undefined) delete process.env.RMD_TEST_SLOT_DIR;else process.env.RMD_TEST_SLOT_DIR = previousSlot;
    real.rmSync(root, { recursive: true, force: true });
  });
  const { createOwnedRunCgroup, joinOwnedRunCgroupSelf } = await import('../src/lib/owned-run-cgroup.js');
  const memory = await import('../src/lib/host-memory-ledger.js');
  real.writeFileSync(procFile, '0::/not-an-isolated-service\n');
  assert.throws(() => createOwnedRunCgroup({ enabled: true, parent }), /own isolated user-service parent/);
  real.writeFileSync(procFile, `0::${group}\n`);
  const empty = createOwnedRunCgroup({ enabled: true, parent })!;
  assert.equal(empty.read().state, 'empty-unqualified');assert.equal(empty.settleCapacity().released, false);
  assert.equal(empty.close(), true);assert.equal(empty.read().state, 'unknown');
  const scope = createOwnedRunCgroup({ enabled: true, parent })!, leaf = String(map(scope.identity.path));
  const copied = { ...scope.identity, ownerPid: parentPid, ownerStart: `proc:${parentPid}` };
  joinOwnedRunCgroupSelf(copied);
  assert.equal(real.readFileSync(join(leaf, 'cgroup.procs'), 'utf8'), String(process.pid), 'self only, never a foreign pid migration');
  real.writeFileSync(join(leaf, 'cgroup.events'), 'populated 1\n');real.writeFileSync(join(leaf, 'cgroup.procs'), String(childPid));
  assert.equal(scope.read().state, 'populated');assert.equal(scope.close(), false);
  const unrelated = memory.openMemoryReservation({ workerClass: 'unclassified', root });unrelated.bindRoot(process.pid);
  memory.sweepMemoryReservations();assert.equal(memory.readMemoryLedger()?.state, 'present');
  assert.equal(scope.attachCapacity(unrelated, childPid), false, 'an active lease cannot be borrowed');
  const lease = memory.openMemoryReservation({ workerClass: 'unclassified', root });
  assert.equal(scope.attachCapacity(lease, childPid), true);assert.equal(scope.attachCapacity(lease, childPid), false);
  assert.equal(scope.settleCapacity().released, false);
  real.writeFileSync(join(leaf, 'cgroup.events'), 'not-a-population-measurement\n');
  assert.equal(scope.read().state, 'unknown');assert.equal(scope.settleCapacity().released, false);
  real.writeFileSync(join(leaf, 'cgroup.events'), 'populated 1\n');scope.cancel();
  assert.equal(scope.read().state, 'gone');
  const published = Object.getOwnPropertyDescriptor(lease, 'published')!;
  Object.defineProperty(lease, 'published', { value: false, configurable: true });
  assert.deepEqual(scope.settleCapacity(), { released: false, reason: 'original-owned-capacity-unavailable' });
  Object.defineProperty(lease, 'published', published);
  const missingRelease = t.mock.method(lease, 'releaseOccupancy', () => {});
  assert.deepEqual(scope.settleCapacity(), { released: false, reason: 'canonical-capacity-release-unverified' });
  assert.equal(scope.close(), false, 'unverified release retains the original handle');missingRelease.mock.restore();
  assert.equal(scope.settleCapacity().released, true);
  assert.equal(scope.settleCapacity().released, true, 'idempotent original settlement');
  assert.equal(memory.readMemoryLedger()?.entries.some(e => e.id === unrelated.id), true);
  assert.equal(scope.close(), true);
});
