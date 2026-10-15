/**
 * test-slot — a test-suite run on the shared fleet host takes a HOST-WIDE slot, at LOW priority,
 * with a BOUNDED concurrency, so one operator or worker coverage run cannot starve reviews/serve.
 *
 * MEASURED 2026-10-06: an operator session's coverage run (7+ `node --test` processes) took the
 * 8-core host to load ~33 and review width collapsed to 1. Three causes, one per tier below:
 * (1) no `--test-concurrency` anywhere in src/, so Node ran cores−1 files at once, each spawning
 * git/tsx; (2) the coverage lock (`coverageGateLockDir`) is keyed by checkout realpath in a
 * container-local /tmp, so two checkouts — or host and container — never saw each other;
 * (3) nothing lowered a test child's priority (only `childGardenPassSpawn` used nice).
 *
 * LEGACY tiered fallback (private v1 coordination instead requires an admitted lease):
 *   free slot        → run at {@link testRunConcurrency}, niced;
 *   all slots live   → wait (and say so), re-checking every poll;
 *   memory short     → a run that names its peak waits while the host's memory headroom cannot hold it plus the live
 *                      holders' named peaks — the CPU-derived count is the most slots, memory decides how many of them
 *                      are open, and a run with no other holder always goes;
 *   a dead holder    → reclaimed (same host: pid probe; other host/container: boot id, then lease);
 *   wait past bound  → `wait_bound_exceeded`: run UNSLOTTED at concurrency 1 — slow, never deadlocked;
 *   slot dir unusable → `slot_unavailable`: run unslotted at the load-derived concurrency.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, ftruncateSync, futimesSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { availableParallelism, hostname, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleepAsync } from "node:timers/promises";

import { systemClock, type Clock } from "./clock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, reclaimStaleLock } from "./fs-race-safe.js";
import { RMD_TMP_PREFIX } from "./tmp.js";
import { observeSlotCapacity, publishSlotCapacity, retireOwnedSlotCapacity, SlotCapacityCleanupError } from "./test-slot-capacity.js";
import { acquireSlotMutation, slotMutationPending } from "./test-slot-mutation.js";
import { observeTestSlotParent } from "./test-slot-parent.js";

/** Names the slot directory every container and the host share (the scratch mount's bind). */
export const TEST_SLOT_DIR_ENV = "RMD_TEST_SLOT_DIR";
/** Overrides the host-wide slot count. */
export const TEST_SLOTS_ENV = "RMD_TEST_SLOTS";
/** A descendant's claim to its live parent's slot; never an injected environment argument. */
export const TEST_SLOT_PARENT_ENV = "RMD_TEST_SLOT_PARENT";
/** The host side of the scratch mount (deploy/scratch-mounts.sh `scratch_root`/rmd). */
export const HOST_SCRATCH_RMD_DIR = "/mnt/scratch/rmd";
/** A test child's CPU niceness — the same yield {@link import("./garden-registry.js").GARDEN_CHILD_NICENESS} uses. */
export const TEST_RUN_NICENESS = 10;
/** Cores left for the daemon, serve and reviews before any test concurrency is granted. */
export const TEST_RUN_HEADROOM_CORES = 2;
/** BACKSTOP — a waiter normally leaves when a holder releases; this fires only when every holder
 *  has run longer than a whole local coverage run (~20-40 min at the old concurrency), and then
 *  degrades to concurrency 1 rather than refusing or deadlocking. */
export const TEST_SLOT_WAIT_BOUND_MS = 45 * 60_000;
/** BACKSTOP — a holder in ANOTHER container/host cannot be pid-probed; it refreshes its record at
 *  every shard boundary, so a record this stale names a holder that died without releasing. */
export const TEST_SLOT_LEASE_MS = 90 * 60_000;
const TEST_SLOT_POLL_MS = 5_000;
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/**
 * Bytes this host can still hand a new process tree before it thrashes: the host's `MemAvailable`, and under a bounded
 * cgroup v2 (a daemon container) its `memory.high`/`memory.max` less what it cannot drop — the smaller one. Undefined
 * where neither reads (macOS): memory then closes no slot.
 */
export function readMemoryHeadroom(read: (path: string) => string = (path) => readFileSync(path, "utf8")): number | undefined {
  const readings: number[] = [];
  try {
    const kb = /^MemAvailable:\s*(\d+)\s*kB\s*$/m.exec(read("/proc/meminfo"))?.[1];
    if (kb !== undefined) readings.push(Number(kb) * 1024);
  } catch {
    // No /proc (macOS): the host reading is skipped.
  }
  try {
    const current = Number(read("/sys/fs/cgroup/memory.current").trim());
    const bounds = ["memory.high", "memory.max"].map((name) => Number(read(`/sys/fs/cgroup/${name}`).trim())).filter(Number.isFinite);
    if (Number.isFinite(current) && bounds.length > 0) readings.push(Math.min(...bounds) - current + droppableCacheBytes(read));
  } catch {
    // No cgroup v2 here (a host process, macOS): the host reading alone stands.
  }
  return readings.length === 0 ? undefined : Math.min(...readings);
}

/** Clean, non-shmem page cache the kernel drops before it would OOM; none counted without a readable breakdown. */
function droppableCacheBytes(read: (path: string) => string): number {
  try {
    const stat = read("/sys/fs/cgroup/memory.stat");
    const field = (name: string): number => Number(new RegExp(`^${name} (\\d+)$`, "m").exec(stat)?.[1] ?? 0);
    return Math.max(0, field("file") - field("shmem") - field("file_dirty") - field("file_writeback"));
  } catch {
    // No breakdown: every charged byte counts as held, the conservative reading.
    return 0;
  }
}

/** Starting prior for a `node --test` file child's peak. OBSERVED 2026-10-10 in the core daemon container: a worker's
 *  default-concurrency run held 7–8 file children at 300–570 MB RSS each, 2.8 GB for the tree. An estimate, not a limit. */
export const TEST_FILE_PEAK_BYTES = 512 * 1024 ** 2;

/** How many test files `headroom` holds: a scalar peak or the selection's largest overlapping peaks, at least one.
 *  CPU caps it at admission. Undefined with no reading (macOS): memory then sizes nothing. */
export function memoryTestConcurrency(headroom: number | undefined, perFileBytes: number | readonly number[] = TEST_FILE_PEAK_BYTES): number | undefined {
  if (headroom === undefined || !Number.isFinite(headroom)) return undefined;
  if (typeof perFileBytes === "number") return perFileBytes > 0 ? Math.max(1, Math.floor(headroom / perFileBytes)) : undefined;
  const peaks = [...perFileBytes].sort((a, b) => b - a);
  let bytes = 0;
  let count = 0;
  for (const peak of peaks) {
    if (!Number.isFinite(peak) || peak <= 0) return undefined;
    bytes += peak;
    if (bytes > headroom) break;
    count += 1;
  }
  return Math.max(1, count);
}

export interface TestFileSize {
  path: string;
  bytes: number;
  basis: "file-p90" | "class-tail" | "prior";
  samples: number;
}

/** Host load facts, injectable so a test fixes them. */
export interface HostLoad {
  cores: number;
  /** The one-minute load average. */
  load1: number;
}

export function readHostLoad(): HostLoad {
  return { cores: availableParallelism(), load1: loadavg()[0] ?? 0 };
}

/** The default slot count: one per four cores, at least one (two on the 8-core fleet host). */
export function defaultTestSlots(cores: number, env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env[TEST_SLOTS_ENV]);
  if (Number.isSafeInteger(configured) && configured >= 1) return configured;
  return Math.max(1, Math.floor(cores / 4));
}

/**
 * A run's `--test-concurrency`: cores minus headroom minus what the host is already running, and
 * never more than this run's share of the slots — so every slot busy at once still leaves
 * {@link TEST_RUN_HEADROOM_CORES} free. Always at least 1, always below the core count.
 */
export function testRunConcurrency(load: HostLoad, slots = 1): number {
  const cores = Number.isFinite(load.cores) && load.cores >= 1 ? Math.floor(load.cores) : 1;
  const busy = Number.isFinite(load.load1) && load.load1 > 0 ? Math.floor(load.load1) : 0;
  const usable = cores - TEST_RUN_HEADROOM_CORES;
  const share = Math.ceil(usable / Math.max(1, slots));
  return Math.max(1, Math.min(share, usable - busy, cores - 1));
}

/** `args` with an explicit `--test-concurrency=<n>` right after `--test` (replacing any already there). */
export function testRunArgv(args: readonly string[], concurrency: number): string[] {
  const kept = args.filter((arg) => !arg.startsWith("--test-concurrency"));
  const at = kept.indexOf("--test");
  const flag = `--test-concurrency=${Math.max(1, Math.floor(concurrency))}`;
  if (at === -1) return [flag, ...kept];
  return [...kept.slice(0, at + 1), flag, ...kept.slice(at + 1)];
}

/** Which binaries exist, injectable so a test fixes the host. */
export type BinaryProbe = (path: string) => boolean;
const NICE_PATHS = ["/usr/bin/nice", "/bin/nice"];
const IONICE_PATHS = ["/usr/bin/ionice", "/bin/ionice"];

export interface LowPriorityCommand {
  file: string;
  args: string[];
  /** What actually lowered the child: `nice+ionice`, `nice`, or `none` (no binary — said so). */
  priority: "nice+ionice" | "nice" | "none";
}

/**
 * `file args` re-spelled to start under `nice -n 10` (and `ionice -c 2 -n 7`, best-effort lowest,
 * where it exists — never the idle class, which can starve a suite into its own timeouts). The
 * wrapper execs the same pid, so the spawn's result, signals and process group are unchanged.
 * A test child only — never the daemon or serve themselves.
 */
export function lowPriorityCommand(file: string, args: readonly string[], exists: BinaryProbe = existsSync): LowPriorityCommand {
  const nice = NICE_PATHS.find((path) => exists(path));
  if (nice === undefined) return { file, args: [...args], priority: "none" };
  const niced = ["-n", String(TEST_RUN_NICENESS), file, ...args];
  const ionice = IONICE_PATHS.find((path) => exists(path));
  if (ionice === undefined) return { file: nice, args: niced, priority: "nice" };
  return { file: ionice, args: ["-c", "2", "-n", "7", nice, ...niced], priority: "nice+ionice" };
}

/** The node executable and argv inside a {@link lowPriorityCommand} wrapper (identity when unwrapped). */
export function unwrapLowPriority(file: string, args: readonly string[]): { file: string; args: string[] } {
  let rest = [file, ...args];
  if (/ionice$/.test(rest[0] ?? "") && rest[1] === "-c") rest = rest.slice(5);
  if (/nice$/.test(rest[0] ?? "") && rest[1] === "-n") rest = rest.slice(3);
  return { file: rest[0] ?? file, args: rest.slice(1) };
}

/** Where the slot directory resolves, and why. */
export interface TestSlotDir {
  dir: string;
  scope: "configured" | "host-scratch" | "local" | "test-process";
}

let testProcessSlotDir: string | undefined;
let testFileSlotScope: string | undefined;
const testFileSlotDirs = new Map<string, string>();

/** Select the owning file before a pooled test runs; repeated and nested tests retain its state. */
export function setTestFileSlotScope(file: string): void {
  testFileSlotScope = file;
  testProcessSlotDir = testFileSlotDirs.get(file);
}

/** The process's TMPDIR at load, so a test that later points TMPDIR at a fixture never receives the slot dir. */
const TEST_PROCESS_TMP_ROOT = tmpdir();

/**
 * The shared slot directory: `RMD_TEST_SLOT_DIR` when set (the scratch bind every container
 * carries); else the host's own `/mnt/scratch/rmd/test-slots` when that mount is there; else a
 * `/tmp` directory shared by every process of this container/machine — narrower, and named so.
 * A test process (NODE_TEST_CONTEXT) never resolves the host's real dir unless one is configured.
 */
export function resolveTestSlotDir(
  env: NodeJS.ProcessEnv = process.env,
  isDir: (path: string) => boolean = (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      // Absent or unreadable both mean "this is not the host scratch mount"; the next rung answers.
      return false;
    }
  },
): TestSlotDir {
  // Native suite children retain private fixture admission even when their author owns a slot.
  const configured = env.NODE_TEST_CONTEXT && env[TEST_SLOT_PARENT_ENV] ? undefined : env[TEST_SLOT_DIR_ENV];
  if (configured) return { dir: configured, scope: "configured" };
  if (env.NODE_TEST_CONTEXT) {
    testProcessSlotDir ??= mkdtempSync(join(TEST_PROCESS_TMP_ROOT, `${RMD_TMP_PREFIX}test-slots-`));
    if (testFileSlotScope !== undefined) testFileSlotDirs.set(testFileSlotScope, testProcessSlotDir);
    return { dir: testProcessSlotDir, scope: "test-process" };
  }
  if (isDir(HOST_SCRATCH_RMD_DIR)) return { dir: join(HOST_SCRATCH_RMD_DIR, "test-slots"), scope: "host-scratch" };
  return { dir: "/tmp/rmd-test-slots", scope: "local" };
}

/** One slot's holder record. */
export interface TestSlotHolder {
  pid: number;
  host: string;
  /** The kernel boot id — shared by every container on one host, so it survives the host check. */
  bootId?: string;
  startedAt: string;
  heartbeatAt: string;
  label: string;
  ownerNonce?: string;
  processStart?: string;
  concurrency?: number;
  /** The holder's pid namespace (`/proc/self/ns/pid`); a different one makes its pid unprobeable from here. */
  pidNs?: string;
  /** The peak the holder's run named ({@link TestSlotOptions.memoryBytes}); a later costed run reserves room for it. */
  memoryBytes?: number;
  filePeaks?: readonly TestFileSize[];
  ownershipProtocol?: "private-capacity-v1";
  /** A private owner has finished its work; same-uid recovery need not wait for its long-lived parent to exit. */
  releaseRequestedAt?: string;
}

/** Kernel-derived start identity and parent, including on hosts without /proc. */
export function testSlotProcessFacts(pid: number,
  read = (path: string) => readFileSync(path, "utf8"),
  ps = (id: number) => execFileSync("ps", ["-p", String(id), "-o", "ppid=", "-o", "lstart="],
    { encoding: "utf8", timeout: 1_000, maxBuffer: 4_096 }),
): { start: string; parent: number } | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const raw = read(`/proc/${pid}/stat`);
    const fields = raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\s+/);
    if (raw.includes(") ") && /^[0-9]+$/.test(fields[19] ?? "") && /^[0-9]+$/.test(fields[1] ?? "")) {
      return { start: `proc:${fields[19]}`, parent: Number(fields[1]) };
    }
  } catch { /* A non-/proc host uses its actual kernel ps result below. */ }
  try {
    const match = ps(pid).trim().match(/^([0-9]+)\s+(\S.*)$/);
    if (match) return { start: `ps:${match[2]}`, parent: Number(match[1]) };
  } catch { /* Unknown identity never permits borrowing a parent's slot. */ }
  return undefined;
}

/** Bounded ancestry measurement; production borrowing always uses the actual defaults. */
export function testSlotHasAncestor(pid: number, childPid = process.pid, factsFor = testSlotProcessFacts): boolean {
  let child = childPid;
  const seen = new Set<number>();
  for (let depth = 0; depth < 64 && child > 1 && !seen.has(child); depth += 1) {
    seen.add(child);
    const facts = factsFor(child);
    if (!facts) return false;
    if (facts.parent === pid) return true;
    child = facts.parent;
  }
  return false;
}

function inheritedTestSlot(dir: string, requirePrivate = false): { lease?: TestSlotLease; rejected?: string } {
  const raw = process.env[TEST_SLOT_PARENT_ENV];
  if (!raw || process.env.NODE_TEST_CONTEXT) return {};
  try {
    const claim = JSON.parse(raw);
    if (!claim || typeof claim.path !== "string" || typeof claim.nonce !== "string" ||
        !Number.isSafeInteger(claim.pid) || typeof claim.start !== "string" || !Number.isSafeInteger(claim.concurrency) ||
        !/^slot-[1-9][0-9]*\.json$/.test(claim.path.split("/").at(-1) ?? "")) return { rejected: "malformed-claim" };
    if (realpathSync(join(claim.path, "..")) !== realpathSync(dir)) return { rejected: "different-slot-directory" };
    const held = parseTestSlotHolder(readFileSync(claim.path, "utf8"));
    if (!held || held.releaseRequestedAt !== undefined || held.pid !== claim.pid || held.ownerNonce !== claim.nonce ||
        held.processStart !== claim.start || held.host !== hostname() ||
        held.concurrency !== claim.concurrency || !Number.isSafeInteger(held.concurrency) || held.concurrency! < 1) return { rejected: "different-holder" };
    if (requirePrivate && held.ownershipProtocol !== "private-capacity-v1") return { rejected: "private-protocol-required" };
    if (testSlotProcessFacts(held.pid)?.start !== held.processStart) return { rejected: "dead-or-reused-owner" };
    if (!testSlotHasAncestor(held.pid)) return { rejected: "owner-is-not-an-ancestor" };
    const verifyParent = () => {
      const current = parseTestSlotHolder(readFileSync(claim.path, "utf8"));
      if (!current || (requirePrivate && current.ownershipProtocol !== "private-capacity-v1") || current.releaseRequestedAt !== undefined || current.pid !== held.pid || current.ownerNonce !== held.ownerNonce ||
          current.processStart !== held.processStart || testSlotProcessFacts(held.pid)?.start !== held.processStart) {
        throw new Error("inherited parent test slot lost its live owner; nested completion refused");
      }
    };
    return { lease: { outcome: "acquired", concurrency: held.concurrency!, waitedMs: 0,
      note: `inherited live parent test slot (${claim.path}); --test-concurrency=${held.concurrency}`,
      childEnvironment: { [TEST_SLOT_PARENT_ENV]: raw, [TEST_SLOT_DIR_ENV]: dir },
      refresh: verifyParent, release: verifyParent } };
  } catch (error) {
    const reason = `unreadable-parent-claim: ${String((error as Error)?.message ?? error)}`;
    return { rejected: reason };
  }
}

/** This process's pid namespace, or undefined off Linux. A sandboxed worker (Codex's bwrap) gets its own. */
export function readPidNamespace(path = "/proc/self/ns/pid"): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    // No /proc (macOS): every holder is judged by the pid probe, exactly as before this field existed.
    return undefined;
  }
}

export function readBootId(path: string = BOOT_ID_PATH): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    // No /proc (macOS): the boot rung is skipped and the lease rung alone ages a foreign holder.
    return undefined;
  }
}

function parseTestSlotHolder(raw: string): TestSlotHolder | null {
  try {
    const h = JSON.parse(raw);
    if (typeof h !== "object" || h === null) return null;
    if (!Number.isSafeInteger(h.pid) || typeof h.host !== "string" || typeof h.startedAt !== "string" ||
        typeof h.heartbeatAt !== "string" || !Number.isFinite(Date.parse(h.heartbeatAt))) return null;
    return h as TestSlotHolder;
  } catch {
    // An unparseable record names no holder at all; reclaimStaleLock treats null as reclaimable.
    return null;
  }
}

/** Open first, refuse links/devices, and read only the bounded original descriptor. */
function readTestSlotHolder(path: string, expected?: { dev: number; ino: number }): TestSlotHolder | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const before = fstatSync(fd);
    if (expected && (before.dev !== expected.dev || before.ino !== expected.ino)) return null;
    if (!before.isFile() || before.size < 1 || before.size > 1024 * 1024) return null;
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n < 1) return null;
      offset += n;
    }
    const after = fstatSync(fd), current = lstatSync(path);
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
    return parseTestSlotHolder(bytes.toString("utf8"));
  } finally { closeSync(fd); }
}

/** Harden EVERY reopen in the shared identity/bytes reclaimer, not just a prior inspection.
 * A private replacement never inherits the old inode's deletion authority, even with identical JSON.
 */
function reclaimPrivateTestSlot(path: string, expected: { dev: number; ino: number; uid: number },
  isStale: (holder: TestSlotHolder) => boolean, onReclaim: () => void, unpublishedCreation = false) {
  const same = (st: Stats): boolean => st.isFile() && st.dev === expected.dev &&
    st.ino === expected.ino && st.uid === expected.uid && st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
  const boundedRead = (fd: number): string => {
    const before = fstatSync(fd);
    if (!same(before) || (before.size < 1 && !unpublishedCreation) || before.size > 1024 * 1024) throw new Error("private reservation identity or bound changed");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n < 1) throw new Error("private reservation truncated during recovery");
      offset += n;
    }
    const after = fstatSync(fd);
    if (!same(after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("private reservation changed during recovery");
    return bytes.toString("utf8");
  };
  const safeOpen = (name: Parameters<typeof openSync>[0]): number => {
    if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) throw new Error("safe private recovery flags unavailable");
    const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { if (!same(fstatSync(fd))) throw new Error("private reservation inode replaced before recovery"); }
    catch (error) { closeSync(fd); throw error; }
    return fd;
  };
  let authorizedBytes: string | undefined;
  return reclaimStaleLock(path, {
    // Null is reclaimable in the shared helper: wrap it so private UNKNOWN is never free.
    parseHolder: raw => ({ holder: parseTestSlotHolder(raw), raw }),
    isStale: current => {
      const allowed = current.holder !== null ? isStale(current.holder) : unpublishedCreation;
      if (allowed) authorizedBytes = current.raw;
      return allowed;
    },
    onReclaim, onLostReclaim: () => {},
  }, {
    openSync: safeOpen,
    // The shared reclaimer calls this seam only as readFileSync(fd, "utf8"); it never requests a Buffer.
    readFileSync: boundedRead as unknown as typeof readFileSync, closeSync, fstatSync, statSync: lstatSync,
    unlinkSync: name => {
      // The generic audit callback ran BEFORE this final check. The mutation guard
      // serializes cooperating writers; POSIX still supplies no arbitrary-actor inode CAS.
      const fd = safeOpen(name);
      try { if (boundedRead(fd) !== authorizedBytes) throw new Error("private reservation bytes replaced before unlink"); }
      finally { closeSync(fd); }
      if (!same(lstatSync(name))) throw new Error("private reservation replaced before unlink");
      unlinkSync(name);
    },
  });
}

/** Seams for {@link acquireTestSlot}; every field defaults to the real host. */
export interface TestSlotOptions {
  dir?: string;
  /** Source-only opt-in. Default writers remain legacy until reader-first fleet qualification. */
  ownershipProtocol?: "private-capacity-v1";
  /** Required coordination remains fail-closed even when a directory cannot be inspected. */
  privateCoordinationRequired?: boolean;
  /** Default-off mode-bit entry protection check. Requires an explicit dir, private writer and an existing
   * parent; never creates or widens it. Not an ACL/ancestor audit or a live adoption switch. */
  privateParentPolicy?: "require-entry-protection";
  slots?: number;
  waitBoundMs?: number;
  pollMs?: number;
  clock?: Clock;
  sleep?: (ms: number) => void;
  hostname?: () => string;
  bootId?: () => string | undefined;
  isPidAlive?: (pid: number) => boolean;
  pidNamespace?: () => string | undefined;
  /** Native default; explicit Linux fixtures must not turn two missing namespaces into a local pid proof. */
  platform?: NodeJS.Platform;
  pid?: number;
  load?: () => HostLoad;
  log?: (line: string) => void;
  /** Which priority binaries exist, for the caller's {@link lowPriorityCommand}. */
  binaryExists?: BinaryProbe;
  /** This run's expected peak (bytes). Set, a slot opens to it only while the memory headroom holds it plus every
   *  other live holder's named peak; unset, memory sizes nothing (today's count-only admission). */
  memoryBytes?: number;
  /** A test run's per-file peak (bytes). Set, the run is sized by memory too: its concurrency is the smaller of the
   *  CPU-derived count and what the headroom, less the live holders' named peaks, holds at this much per file; its
   *  record names concurrency × this as its peak, and a slot opens to it while the headroom holds one file beside them. */
  perFileBytes?: number;
  /** Learned sizes of the selection; a concurrent wave reserves its largest file peaks. */
  filePeaks?: readonly TestFileSize[];
  /** The host's memory headroom in bytes; default {@link readMemoryHeadroom}. */
  memoryHeadroom?: () => number | undefined;
}

/** A held slot (or the named reason none is held), plus the concurrency the run should use. */
export interface TestSlotLease {
  outcome: "acquired" | "wait_bound_exceeded" | "slot_unavailable";
  /** False is NOT_RUN, never permission to use the legacy unslotted fallback. */
  executionAllowed?: boolean;
  concurrency: number;
  waitedMs: number;
  /** One line for the step detail: the run says whether it waited, and on whom. */
  note: string;
  /** Only a positively identified real descendant may borrow this owner; absent for unslotted runs. */
  childEnvironment?: Record<string, string>;
  refresh(): void;
  release(): void;
}

/** Legacy never-refusing leases are compatible; an explicit private NOT_RUN must survive every launch boundary. */
export function testSlotExecutionAllowed(lease: TestSlotLease): boolean {
  return lease.executionAllowed !== false;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Is `held` dead? Same host → the shared pid/start-time predicate. Another host or container →
 * its pid means nothing here, so: a different kernel boot id is dead by construction, and
 * otherwise a heartbeat older than {@link TEST_SLOT_LEASE_MS} is a holder that died unreleased.
 * TRAP: isHolderStale alone would call ANY container-id-shaped foreign host stale from inside a
 * container (it assumes an earlier boot of the same cell) — on a shared mount that is a live peer.
 */
function testSlotHolderStale(held: TestSlotHolder, now: number, opts: Required<Pick<TestSlotOptions, "hostname" | "bootId" | "isPidAlive" | "pidNamespace">>): boolean {
  const myNs = opts.pidNamespace();
  const foreignNs = held.pidNs !== undefined && myNs !== undefined && held.pidNs !== myNs;
  // Same hostname but another pid namespace (two sandboxed workers in one container): the pid probe would read a
  // live peer as dead, so it is aged like a foreign host's holder — boot id, then lease.
  if (held.host === opts.hostname() && !foreignNs) return isHolderStale(held, { isPidAlive: opts.isPidAlive, hostname: opts.hostname });
  const mine = opts.bootId();
  if (held.bootId !== undefined && mine !== undefined && held.bootId !== mine) return true;
  return now - Date.parse(held.heartbeatAt) > TEST_SLOT_LEASE_MS;
}

/**
 * Take one of the host-wide slots for a test-suite run, waiting (bounded) while all are live.
 * Legacy-only outcomes retain fallback. Private-required failures are explicit NOT_RUN;
 * callers must honor executionAllowed before starting work or recording admission.
 */
export function acquireTestSlot(label: string, opts: TestSlotOptions = {}): TestSlotLease {
  const acquisition = testSlotAcquisition(label, opts);
  let next = acquisition.next();
  while (!next.done) {
    try {
      (opts.sleep ?? sleepSync)(next.value);
      next = acquisition.next();
    } catch (error) {
      next = acquisition.throw(error);
    }
  }
  return next.value;
}

export async function acquireTestSlotAsync(label: string, opts: Omit<TestSlotOptions, "sleep"> = {}): Promise<TestSlotLease> {
  const acquisition = testSlotAcquisition(label, opts);
  let next = acquisition.next();
  while (!next.done) {
    await sleepAsync(next.value);
    next = acquisition.next();
  }
  return next.value;
}

function* testSlotAcquisition(label: string, opts: TestSlotOptions): Generator<number, TestSlotLease> {
  const clock = opts.clock ?? systemClock;
  const host = opts.hostname ?? hostname;
  const bootId = opts.bootId ?? (() => readBootId());
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const pidNamespace = opts.pidNamespace ?? (() => readPidNamespace());
  const privateWriter = opts.ownershipProtocol === "private-capacity-v1";
  const parentPolicy = opts.privateParentPolicy === "require-entry-protection";
  let privateRequired = privateWriter || opts.privateCoordinationRequired === true || parentPolicy;
  const privateStale = (held: TestSlotHolder): boolean => {
    if (held.ownershipProtocol !== "private-capacity-v1") return false;
    if (held.releaseRequestedAt !== undefined && Number.isFinite(Date.parse(held.releaseRequestedAt)) && Date.parse(held.releaseRequestedAt) <= clock.now()) return true;
    const mine = bootId();
    if (held.bootId !== undefined && mine !== undefined && held.bootId !== mine) return true;
    const mineNs = pidNamespace();
    if ((held.pidNs === undefined) !== (mineNs === undefined)) return false;
    if ((opts.platform ?? process.platform) === "linux" && (held.pidNs === undefined || mineNs === undefined)) return false;
    // A private owner's age never proves death across an identity boundary. The legacy
    // heartbeat fallback can reclaim a healthy long-running peer; leave it to its owner lane.
    if (held.pidNs !== mineNs || held.host !== host()) return false;
    return isHolderStale(held, { hostname: host, isPidAlive });
  };
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const cleanupLog = (row: Record<string, unknown>): void => {
    try { log(JSON.stringify(row)); }
    catch (error) {
      try { process.stderr.write(`${JSON.stringify({ step: "test_slot.cleanup_diagnostic_failed", event: row.step, error: String(error) })}\n`); }
      catch { /* Failed telemetry must never bypass descriptor cleanup or grant execution. */ }
    }
  };
  const finishMutation = (mutation: Extract<ReturnType<typeof acquireSlotMutation>, { state: "acquired" }>): boolean => {
    try { mutation.release(); return true; }
    catch (error) {
      privateRequired = true;
      cleanupLog({ step: "test_slot.mutation_cleanup_incomplete", label, ownerRecoveryRequired: true, error: String(error) });
      return false;
    }
  };
  const load = opts.load ?? readHostLoad;
  // An opted-in policy must not reach the test resolver's mkdir side effect before inspection.
  const { dir, scope } = opts.dir !== undefined || parentPolicy ? { dir: opts.dir ?? "", scope: "configured" as const } : resolveTestSlotDir();
  const slots = opts.slots ?? defaultTestSlots(load().cores);
  const waitBoundMs = opts.waitBoundMs ?? TEST_SLOT_WAIT_BOUND_MS;
  const pollMs = opts.pollMs ?? TEST_SLOT_POLL_MS;
  const startedAt = clock.now();
  const startedIso = clock.iso();
  const headroomOf = opts.memoryHeadroom ?? readMemoryHeadroom;
  const files = opts.filePeaks?.length ? opts.filePeaks : undefined;
  const peaks = files && files[0]?.path !== "<selection>" ? files.map((f) => f.bytes).sort((a, b) => b - a) : undefined;
  const perFile = peaks ?? files?.[0]?.bytes ?? opts.perFileBytes;
  const basisNote = files ? `; file peaks ${[...new Set(files.map((f) => f.basis))].join(", ")}` : "";
  /** The CPU-derived concurrency, lowered to what the headroom less `reservedBytes` holds when the run names a per-file peak. */
  const sized = (reservedBytes = 0): number => {
    const cpu = testRunConcurrency(load(), slots);
    if (perFile === undefined) return cpu;
    const headroom = headroomOf();
    return Math.min(cpu, peaks?.length ?? cpu, memoryTestConcurrency(headroom === undefined ? undefined : headroom - reservedBytes, perFile) ?? cpu);
  };
  const unslotted = (outcome: TestSlotLease["outcome"], concurrency: number, note: string): TestSlotLease => ({
    outcome, concurrency, executionAllowed: !privateRequired, waitedMs: clock.now() - startedAt,
    note: (privateRequired ? `NOT_RUN: private coordination requires an admitted lease (${outcome}); ${note.replace(/; ran unslotted.*$/i, "")}` : note) + basisNote,
    refresh: () => {}, release: () => {},
  });
  if (parentPolicy) {
    if (opts.dir === undefined) return unslotted("slot_unavailable", 1, "parent policy requires an explicit existing directory");
    if (!privateWriter) return unslotted("slot_unavailable", 1, "parent policy requires the gated private writer");
    const parent = observeTestSlotParent(dir);
    if (parent.state !== "SAFE") return unslotted("slot_unavailable", 1, `parent entry protection ${parent.state}: ${parent.reason}`);
  }
  const inherited = inheritedTestSlot(dir, parentPolicy);
  if (inherited.lease) return inherited.lease;
  if (inherited.rejected) log(JSON.stringify({ step: "test_slot.parent_rejected", label, reason: inherited.rejected }));
  try {
    if (!parentPolicy) {
      mkdirSync(dir, { recursive: true, mode: 0o777 });
      // Legacy preparation only: explicit parent policy must never widen a protected directory.
      if ((statSync(dir).mode & 0o777) !== 0o777 && statSync(dir).uid === process.getuid?.()) chmodSync(dir, 0o777);
    }
  } catch (error) {
    // Uncoordinated is still a run: the named slot_unavailable outcome, never a refusal.
    const concurrency = sized();
    return unslotted("slot_unavailable", concurrency,
      `test slot UNAVAILABLE (${dir}: ${String((error as Error)?.message ?? error)}); ran unslotted at --test-concurrency=${concurrency}`);
  }
  const ownerNonce = randomUUID();
  const processStart = testSlotProcessFacts(opts.pid ?? process.pid)?.start;
  let concurrency = 1;
  /** The peak this run's record names: its own estimate, or its per-file peak at the concurrency it was granted. */
  const ownPeak = (): number | undefined => opts.memoryBytes ?? (peaks ? peaks.slice(0, concurrency).reduce((sum, peak) => sum + peak, 0)
    : typeof perFile === "number" ? concurrency * perFile : undefined);
  const record = (): TestSlotHolder => ({
    pid: opts.pid ?? process.pid, host: host(), bootId: bootId(), startedAt: startedIso,
    heartbeatAt: clock.iso(), label, ownerNonce, processStart, concurrency, pidNs: pidNamespace(),
    ...(ownPeak() === undefined ? {} : { memoryBytes: ownPeak() }),
    ...(files ? { filePeaks: files } : {}), ...(privateWriter ? { ownershipProtocol: "private-capacity-v1" as const } : {}),
  });
  const mib = (bytes: number): number => Math.round(bytes / 1024 ** 2);
  const recoverPrivateSlot = (path: string, slot: number, st: Stats): boolean => {
    if (!privateWriter || !st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()) return false;
    const held = readTestSlotHolder(path, st);
    if (!held || !privateStale(held)) return false;
    // Keep the canonical occupied anchor if projection cleanup cannot complete.
    retireOwnedSlotCapacity(path, slot, held, st);
    const reclaimed = reclaimPrivateTestSlot(path, st,
      current => JSON.stringify(current) === JSON.stringify(held) && privateStale(current),
      () => log(JSON.stringify({ step: "test_slot.owner_recovery_intent", slot })));
    if (reclaimed.outcome !== "reclaimed") return false;
    log(JSON.stringify({ step: "test_slot.owner_recovery", slot }));
    return true;
  };
  /** The other slots' records (slot `slot`'s own never counted). */
  const othersThan = (slot: number): { memoryBytes?: number; unknown?: boolean }[] => {
    const others: { memoryBytes?: number; unknown?: boolean }[] = [];
    for (let j = 1; j <= slots; j += 1) {
      if (j === slot) continue;
      try {
        const path = join(dir, `slot-${j}.json`);
        if (slotMutationPending(path)) { privateRequired = true; others.push({ unknown: true }); continue; }
        const st = lstatSync(path);
        if (st.isFile() && (st.mode & 0o077) === 0) {
          privateRequired = true;
          const observation = observeSlotCapacity(path, j);
          if (observation.state !== "missing") others.push(observation.state === "observed" ? observation.capacity : { unknown: true });
        } else others.push(st.isFile() ? readTestSlotHolder(path) ?? { unknown: true } : { unknown: true });
      } catch (error) {
        // Only an absent peer is omitted; failed inspection still reserves UNKNOWN capacity.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") others.push({ unknown: true });
      }
    }
    return others;
  };
  const namedPeaks = (others: { memoryBytes?: number }[]): number => others.reduce((sum, held) => sum + (held.memoryBytes ?? 0), 0);
  /** Why slot `slot` stays closed to this run on memory (its own record not counted), or undefined when it may take it. */
  const memoryShort = (slot: number): string | undefined => {
    const others = othersThan(slot);
    if (privateRequired && !privateWriter) return "private coordination encountered; private writer remains gated";
    if (others.some(held => held.unknown)) return "peer capacity UNKNOWN; reservation is occupied, not free";
    // A sized test run needs room for one file: it shrinks its concurrency to whatever more the headroom holds.
    const own = opts.memoryBytes ?? peaks?.[0] ?? files?.[0]?.bytes ?? opts.perFileBytes;
    if (own === undefined) return undefined;
    if (others.length === 0) return undefined;
    const headroom = headroomOf();
    const need = namedPeaks(others) + own;
    if (headroom === undefined || headroom >= need) return undefined;
    return `memory headroom ${mib(headroom)} MiB < ${mib(need)} MiB for this run and the live holders' peaks`;
  };
  let announced = false;
  try {
    return yield* waitForSlot();
  } catch (error) {
    // Uncoordinated is still a run: the named slot_unavailable outcome, never a refusal.
    const concurrency = sized();
    return unslotted("slot_unavailable", concurrency,
      `test slot UNAVAILABLE (${dir}: ${String((error as Error)?.message ?? error)}); ran unslotted at --test-concurrency=${concurrency}`);
  }
  function* waitForSlot(): Generator<number, TestSlotLease> {
    for (;;) {
      // Recover only our own, privately inspected dead holders BEFORE calculating memory.
      // Otherwise a dead peer closes the free slot beside it, or its old projection collides
      // with the replacement. Public metadata alone never authorizes foreign recovery.
      for (let i = 1; i <= slots; i += 1) {
        const path = join(dir, `slot-${i}.json`);
        try {
          const st = lstatSync(path);
          if (st.isFile() && (st.mode & 0o077) === 0) privateRequired = true;
          if (!privateWriter) continue;
          const mutation = acquireSlotMutation(path);
          if (mutation.state !== "acquired") continue;
          try { recoverPrivateSlot(path, i, st); } finally { finishMutation(mutation); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(JSON.stringify({ step: "test_slot.owner_recovery_refused", slot: i, error: String(error) }));
        }
      }
      const holders: string[] = [];
      for (let i = 1; i <= slots; i += 1) {
        const path = join(dir, `slot-${i}.json`);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const mutation = acquireSlotMutation(path);
          if (mutation.state !== "acquired") {
            // The usable shared parent was inspected already; failed guard acquisition
            // cannot prove no private coordination exists, including after guard creation.
            privateRequired = true; holders.push(`slot ${i}: mutation pending; coordination UNKNOWN`); break;
          }
          let admittedLease: TestSlotLease | undefined;
          try {
          // Memory first, with no existence check: a slot's own record never counts against it, so whenever reclaiming
          // a dead holder there could open a slot, this passes and the reclaim below runs.
          const short = memoryShort(i);
          if (short !== undefined) {
            if (!holders.includes(short)) holders.push(short);
            break;
          }
          let openedFd: number | undefined;
          let removeCapacity: (() => void) | undefined;
          let createdRecord: TestSlotHolder | undefined;
          let writeOwnedRecord: ((body: string) => void) | undefined;
          try {
            concurrency = perFile === undefined ? testRunConcurrency(load(), slots) : sized(namedPeaks(othersThan(i)));
            const ownedRecord = structuredClone(record()), body = JSON.stringify(ownedRecord);
            if (privateWriter && (Buffer.byteLength(body) > 1024 * 1024 ||
              [concurrency, ownPeak() ?? 0].some(n => !Number.isSafeInteger(n) || n < 0))) throw new Error("private slot record or capacity exceeds its bound");
            createdRecord = ownedRecord;
            // Ownership bytes (including nonce, labels and paths) are private through EVERY hard link.
            // Peers observe only the capacity projection's bounded name and inode metadata.
            const fd = openSync(path, "wx+", 0o600); openedFd = fd;
            if (!privateWriter) fchmodSync(fd, 0o644); // Legacy writer only; private v1 is never widened.
            const writeRecord = (body: string): void => {
              const bytes = Buffer.from(body); let offset = 0;
              while (offset < bytes.length) {
                const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
                if (written < 1) throw new Error("test slot record write made no progress");
                offset += written;
              }
              ftruncateSync(fd, bytes.length);
              futimesSync(fd, clock.date(), clock.date());
            };
            writeOwnedRecord = writeRecord;
            writeRecord(body);
            removeCapacity = privateWriter ? publishSlotCapacity(path, fd, i, ownedRecord) : undefined;
            const waitedMs = clock.now() - startedAt;
            if (announced) log(JSON.stringify({ step: "test_slot.acquired", label, slot: i, waitedMs, dir }));
            let held = true;
            let closed = false;
            const close = (): void => {
              if (closed) return;
              closed = true;
              closeSync(fd);
            };
            const stillOwnsRecord = (): boolean => {
              const open = fstatSync(fd), current = lstatSync(path);
              if (!current.isFile() || current.isSymbolicLink() || current.dev !== open.dev || current.ino !== open.ino || open.size < 1 || open.size > 1024 * 1024) return false;
              const bytes = Buffer.alloc(open.size);
              if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return false;
              const holder = parseTestSlotHolder(bytes.toString("utf8"));
              return holder?.ownerNonce === ownerNonce && holder.pid === (opts.pid ?? process.pid) && holder.host === host();
            };
            return admittedLease = {
              outcome: "acquired", executionAllowed: true, concurrency, waitedMs,
              ...((opts.pid ?? process.pid) === process.pid && host() === hostname() && processStart ? {
                childEnvironment: { [TEST_SLOT_PARENT_ENV]: JSON.stringify({ path, pid: process.pid, nonce: ownerNonce, start: processStart, concurrency }),
                  [TEST_SLOT_DIR_ENV]: dir },
              } : {}),
              note: `host-wide test slot ${i}/${slots} (${scope}: ${dir})` +
                `${announced ? `, after waiting ${Math.round(waitedMs / 1000)}s` : ""}; --test-concurrency=${concurrency}, niced${basisNote}`,
              refresh: () => {
                if (!held) return;
                const refreshMutation = acquireSlotMutation(path);
                if (refreshMutation.state !== "acquired") {
                  log(JSON.stringify({ step: "test_slot.refresh_deferred", label, path })); return;
                }
                try {
                  if (!stillOwnsRecord()) { held = false; close(); cleanupLog({ step: "test_slot.refresh_lost", label, path }); return; }
                  writeRecord(JSON.stringify({ ...ownedRecord, heartbeatAt: clock.iso() }));
                } catch (error) {
                  held = false; close(); cleanupLog({ step: "test_slot.refresh_failed", label, path, error: String(error) });
                } finally { finishMutation(refreshMutation); }
              },
              release: () => {
                if (!held) return;
                let lastError: unknown;
                // BACKSTOP: three immediate attempts cover a transient read/unlink failure, never an unbounded wait.
                for (let n = 0; n < 3; n += 1) {
                  const releaseMutation = acquireSlotMutation(path);
                  if (releaseMutation.state !== "acquired") { lastError = new Error("slot mutation pending during release"); continue; }
                  try {
                    if (!stillOwnsRecord()) {
                      held = false; close();
                      cleanupLog({ step: privateWriter ? "test_slot.release_lost" : "test_slot.release_failed", label, path,
                        reason: "owner identity no longer matches; replacement preserved" });
                      return;
                    }
                    // Metadata first: on failure the canonical anchor remains occupied/recoverable.
                    removeCapacity?.();
                    const ours = (h: TestSlotHolder) => h.pid === (opts.pid ?? process.pid) && h.host === host() && h.ownerNonce === ownerNonce;
                    const result = privateWriter ? reclaimPrivateTestSlot(path, fstatSync(fd), ours, () => {})
                      : reclaimStaleLock(path, { parseHolder: parseTestSlotHolder, isStale: ours, onReclaim: () => {}, onLostReclaim: () => {} });
                    held = false; close();
                    if (result.outcome !== "reclaimed" && result.outcome !== "missing") cleanupLog({ step: "test_slot.release_lost", label, path });
                    return;
                  } catch (error) {
                    // Preserve the latest failure for the bounded terminal cleanup receipt.
                    lastError = error;
                  }
                  finally { finishMutation(releaseMutation); }
                }
                const terminalMutation = acquireSlotMutation(path);
                try {
                  if (terminalMutation.state === "acquired" && privateWriter && stillOwnsRecord()) {
                    writeRecord(JSON.stringify({ ...ownedRecord, heartbeatAt: clock.iso(), releaseRequestedAt: clock.iso() }));
                  }
                } catch (error) {
                  // A failed terminal write stays occupied and is named in cleanup_incomplete below.
                  lastError = error;
                }
                finally {
                  if (terminalMutation.state === "acquired") finishMutation(terminalMutation);
                  held = false; close();
                }
                cleanupLog({ step: "test_slot.cleanup_incomplete", label, path, ownerRecoveryRequired: true, error: String(lastError) });
              },
            };
          } catch (error) {
            if (openedFd !== undefined) {
              try {
                let metadataRemoved = !(error instanceof SlotCapacityCleanupError);
                try { removeCapacity?.(); }
                catch (cleanupError) {
                  metadataRemoved = false;
                  cleanupLog({ step: "test_slot.capacity_rollback_incomplete", label, path, error: String(cleanupError) });
                }
                if (metadataRemoved && privateWriter) {
                  // Exclusive creation + pinned original fd authorizes OUR empty/partial unpublished rollback.
                  reclaimPrivateTestSlot(path, fstatSync(openedFd), h => h.ownerNonce === ownerNonce, () => {}, true);
                } else if (privateWriter && createdRecord && writeOwnedRecord) {
                  writeOwnedRecord(JSON.stringify({ ...createdRecord, heartbeatAt: clock.iso(), releaseRequestedAt: clock.iso() }));
                }
              }
              finally { closeSync(openedFd); }
            }
            // Only "someone holds it" is a slot answer; anything else is the outer slot_unavailable.
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          const capacity = observeSlotCapacity(path, i);
          const currentStat = (() => {
            try { return lstatSync(path); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
          })();
          if (currentStat?.isDirectory()) throw new Error("test slot path is a directory, not a reservation file");
          if (currentStat && !currentStat.isFile()) { holders.push(`slot ${i}: non-file reservation UNKNOWN`); break; }
          const privateRecord = currentStat !== undefined && (currentStat.mode & 0o077) === 0;
          if (privateRecord) privateRequired = true;
          // Cross-account observers cannot inspect private authority. Never infer permission to delete it
          // from public metadata, even if its heartbeat is old. Owner-lane release/recovery is required.
          if (privateRecord && (capacity.state !== "observed" || currentStat!.uid !== process.getuid?.())) {
            holders.push(`slot ${i}: private owner; ${capacity.state === "observed" ? "peer capacity observed" : "capacity UNKNOWN"}; owner-lane release required`);
            break;
          }
          if (privateRecord) {
            if (recoverPrivateSlot(path, i, currentStat!)) continue;
            holders.push(`slot ${i}: private owner still occupied; owner-lane release required`);
            break;
          }
          const reclaim = reclaimStaleLock(path, {
            parseHolder: parseTestSlotHolder,
            isStale: (held) => testSlotHolderStale(held, clock.now(), { hostname: host, bootId, isPidAlive, pidNamespace }),
            onLostReclaim: () => {},
          });
          if (reclaim.outcome === "live") {
            holders.push(`slot ${i}: pid ${reclaim.holder.pid} on ${reclaim.holder.host} (${reclaim.holder.label})`);
            break;
          }
          } finally {
            if (!finishMutation(mutation) && admittedLease) {
              admittedLease.executionAllowed = false;
              admittedLease.note = "NOT_RUN: slot mutation guard cleanup is incomplete; owner-lane recovery required";
              admittedLease.release();
            }
          }
        }
      }
      const waitedMs = clock.now() - startedAt;
      if (waitedMs >= waitBoundMs) {
        log(JSON.stringify({ step: "test_slot.wait_bound_exceeded", label, waitedMs, holders }));
        return unslotted("wait_bound_exceeded", 1,
          `test slot WAIT BOUND EXCEEDED after ${Math.round(waitedMs / 1000)}s (${holders.join("; ")}); ran UNSLOTTED at --test-concurrency=1`);
      }
      if (!announced) {
        announced = true;
        log(JSON.stringify({ step: "test_slot.waiting", label, dir, holders }));
      }
      yield Math.min(pollMs, Math.max(0, waitBoundMs - waitedMs));
    }
  }
}
