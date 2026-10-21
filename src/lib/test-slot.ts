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
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, ftruncateSync, futimesSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { availableParallelism, hostname, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleepAsync } from "node:timers/promises";

import { systemClock, type Clock } from "./clock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, reclaimStaleLock } from "./fs-race-safe.js";
import { sameHost } from "./host-identity.js";
import { RMD_TMP_PREFIX } from "./tmp.js";
import { observeSlotCapacity, publishSlotCapacity, retireOwnedSlotCapacity, SlotCapacityCleanupError } from "./test-slot-capacity.js";
import { acquireSlotMutation, createGuardHolderProbe, slotMutationPending, type GuardHolderEvidence, type OrphanGuardRecovery } from "./test-slot-mutation.js";
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
/** Covered descendants inherit the existing parent claim, including the reservation nonce and process start. */
export const TEST_SLOT_RUN_ENV = TEST_SLOT_PARENT_ENV;
/** A beating lease's cadence. A record names it only while a live event loop really beats it. */
export const TEST_SLOT_HEARTBEAT_MS = 60_000;
/** Missed recorded beats before a waiter logs one silence observation. Silence is never quiescence. */
export const TEST_SLOT_SILENT_BEATS = 3;
/** A guard older than this many times the longest hold this waiter measured itself may be probed as orphaned. */
export const MUTATION_GUARD_HOLD_FACTOR = 1000;
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
  /** Present only while a live event loop beats this record at this cadence; absent keeps the pid judgment. */
  heartbeatIntervalMs?: number;
  /** The OS owner of this reservation; missing ownership never authorizes tree-based recovery. */
  ownerUid?: number;
  /** Sticky once work uses a marker: withdrawing a cadence must not restore parent-pid-only recovery. */
  workIdentity?: "reservation-marker-v1";
  /** Scope observed before publication (dedicated: only our group and our own ancestors); shared or unproven never ends. */
  cgroupScope?: { path: string; dedicated: boolean; reason?: string };
}

/** Identity a complete run monitor must name in its terminal evidence. */
export interface TestSlotReservationIdentity {
  host: string;
  bootId: string;
  pidNs: string;
  ownerUid: number;
  pid: number;
  processStart: string;
  ownerNonce: string;
  startedAt: string;
}

export function testSlotReservationIdentity(held: TestSlotHolder): TestSlotReservationIdentity | undefined {
  if (!held.ownerNonce || !held.processStart || !held.bootId || !held.pidNs ||
      !Number.isSafeInteger(held.ownerUid) || held.ownerUid! < 0 || !Number.isSafeInteger(held.pid) || held.pid < 1 ||
      !Number.isFinite(Date.parse(held.startedAt))) return undefined;
  return { host: held.host, bootId: held.bootId, pidNs: held.pidNs, ownerUid: held.ownerUid!, pid: held.pid,
    processStart: held.processStart, ownerNonce: held.ownerNonce, startedAt: held.startedAt };
}

/** Whether the reserved process tree ended. Only `ended` frees capacity; `unknown` names what it could not see. */
export interface ReservedTreeEvidence {
  state: "ended" | "live" | "unknown";
  coverage: string;
  reason: string;
  /** Positive coverage of the entire run, including reparented/detached work, bound to this generation. */
  complete?: boolean;
  reservation?: TestSlotReservationIdentity;
}

function verifiedTerminalEvidence(held: TestSlotHolder, evidence: ReservedTreeEvidence): boolean {
  const identity = testSlotReservationIdentity(held);
  return evidence.state === "ended" && evidence.complete === true && identity !== undefined &&
    evidence.reservation !== undefined && Object.entries(identity).every(([key, value]) =>
      evidence.reservation![key as keyof TestSlotReservationIdentity] === value);
}

function observeReservedTree(held: TestSlotHolder, probe: (held: TestSlotHolder) => ReservedTreeEvidence): ReservedTreeEvidence {
  try {
    const evidence = probe(structuredClone(held));
    if (evidence.state !== "ended" || verifiedTerminalEvidence(held, evidence)) return evidence;
    return { state: "unknown", coverage: evidence.coverage, reason: "terminal evidence has incomplete coverage or a different reservation identity" };
  } catch (error) {
    return { state: "unknown", coverage: "none", reason: `process-tree probe failed: ${String(error)}` };
  }
}

/** Seams for {@link probeReservedTree}; every field defaults to this host. */
export interface ReservedTreeProbeHost {
  platform?: NodeJS.Platform;
  bootId?: string;
  pidNs?: string;
  hostname?: () => string;
  list?: () => string[];
  read?: (path: string) => string;
  readCgroup?: (path: string) => string;
}

const goneProcess = (error: unknown): boolean => ["ENOENT", "ESRCH"].includes(String((error as NodeJS.ErrnoException)?.code));
const dedicatedScopePath = (path: unknown): path is string => typeof path === "string" &&
  /^\/(?:[^/\0\n]+\/)*[^/\0\n]+\.scope$/.test(path) && !path.split("/").some(part => part === "." || part === "..");

/**
 * Record our cgroup v2 membership. A scope is dedicated when every member is in our process group or is one of our
 * own ancestors: a builder's `systemd-run --scope timeout … job.sh` puts the wrapper `timeout`s (each takes a new
 * group) and the job script in the scope with the owner (W1-T10251). Any other member makes the scope shared.
 */
export function readTestSlotCgroup(host: ReservedTreeProbeHost = {}): TestSlotHolder["cgroupScope"] {
  if ((host.platform ?? process.platform) !== "linux") return undefined;
  const read = host.read ?? ((path: string) => readFileSync(path, "utf8"));
  const readCgroup = host.readCgroup ?? read;
  const statFields = (raw: string): string[] | undefined => raw.includes(") ") ? raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\s+/) : undefined;
  let path = "";
  try {
    path = /^0::([^\n]+)$/m.exec(read("/proc/self/cgroup"))?.[1] ?? "";
    if (!dedicatedScopePath(path)) return { path, dedicated: false, reason: "not a dedicated cgroup v2 scope" };
    const self = statFields(read("/proc/self/stat"));
    const group = self?.[2];
    if (!/^[1-9][0-9]*$/.test(group ?? "")) throw new Error("owner process group unproven");
    const members = readCgroup(`/sys/fs/cgroup${path}/cgroup.procs`).trim().split(/\s+/);
    if (!members.includes(String(process.pid))) throw new Error("scope does not contain this owner");
    let ancestors: Set<string> | undefined;
    const ancestorsOfOwner = (): Set<string> => {
      const chain = new Set<string>();
      // The parent chain ends at pid 0; an unreadable link ends it early, which only leaves the scope shared.
      for (let parent = self?.[1]; parent !== undefined && /^[1-9][0-9]*$/.test(parent) && !chain.has(parent);) {
        chain.add(parent);
        try { parent = statFields(read(`/proc/${parent}/stat`))?.[1]; } catch { break; }
      }
      return chain;
    };
    for (const pid of members) {
      if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("invalid scope member");
      const member = statFields(read(`/proc/${pid}/stat`));
      if (member?.[2] === group) continue;
      if (member !== undefined && (ancestors ??= ancestorsOfOwner()).has(pid)) continue;
      return { path, dedicated: false, reason: "scope contains another process group" };
    }
    return { path, dedicated: true };
  } catch (error) {
    return { path, dedicated: false, reason: `scope dedication unproven: ${String(error)}` };
  }
}

function probeCgroupScope(held: TestSlotHolder, ownerStart: number, read: (path: string) => string,
  readCgroup: (path: string) => string): ReservedTreeEvidence | undefined {
  if (held.cgroupScope?.dedicated !== true || !dedicatedScopePath(held.cgroupScope.path)) return undefined;
  const unknown = (reason: string): ReservedTreeEvidence => ({ state: "unknown", coverage: "cgroup-scope", reason });
  try {
    const raw = read(`/proc/${held.pid}/stat`);
    const start = raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
    if (!raw.includes(") ") || !/^[1-9][0-9]*$/.test(start ?? "")) return unknown("owner process start unreadable");
    if (Number(start) === ownerStart) return { state: "live", coverage: "cgroup-scope", reason: "recorded owner is alive" };
  } catch (error) {
    if (!goneProcess(error)) {
      const reason = `owner death unproven: ${String(error)}`;
      return unknown(reason);
    }
  }
  const scope = `/sys/fs/cgroup${held.cgroupScope.path}`;
  let reason: string;
  try {
    const procs = readCgroup(`${scope}/cgroup.procs`).trim();
    if (procs !== "") return { state: "live", coverage: "cgroup-scope", reason: "dedicated scope still holds processes" };
    // populated covers descendant cgroups too; an empty parent's procs alone is insufficient.
    const populated = /^populated ([01])$/m.exec(readCgroup(`${scope}/cgroup.events`))?.[1];
    if (populated === "1") return { state: "live", coverage: "cgroup-scope", reason: "dedicated scope still holds descendant work" };
    if (populated !== "0") return unknown("dedicated scope population unreadable");
    reason = "owner gone and dedicated scope is empty";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const reason = `scope quiescence unproven: ${String(error)}`;
      return unknown(reason);
    }
    reason = "owner gone and dedicated scope is absent";
  }
  return { state: "ended", complete: true, coverage: "cgroup-scope", reason, reservation: testSlotReservationIdentity(held) };
}

/**
 * Exact-tree evidence for one reservation (W1-T9928). The tree is the recorded owner (pid + kernel start)
 * plus every process carrying this reservation's parent claim, which reparented and detached descendants
 * inherit. Seeing a marker proves live work; its absence cannot prove complete coverage: exec can
 * replace an environment, and a process can fork during a scan. Without an independent complete run
 * monitor this probe returns `unknown` when it sees no live work. A recorded dedicated cgroup scope
 * supplies complete coverage once the owner is gone and the scope is absent or unpopulated.
 */
export function probeReservedTree(held: TestSlotHolder, host: ReservedTreeProbeHost = {}): ReservedTreeEvidence {
  const platform = host.platform ?? process.platform;
  const unknown = (reason: string, coverage = "none"): ReservedTreeEvidence => ({ state: "unknown", coverage, reason });
  if (platform !== "linux") return unknown(`no exact-tree probe on ${platform}`);
  if (!testSlotReservationIdentity(held) || !/^proc:[0-9]+$/.test(held.processStart ?? "")) return unknown("owner identity unknown: no complete reservation identity or kernel process start");
  if (!sameHost(held.host, (host.hostname ?? hostname)()) || held.ownerUid !== process.getuid?.()) return unknown("host or owner uid differs");
  const bootId = "bootId" in host ? host.bootId : readBootId();
  const pidNs = "pidNs" in host ? host.pidNs : readPidNamespace();
  if (held.bootId === undefined || held.bootId !== bootId) return unknown("boot identity unproven");
  if (held.pidNs === undefined || held.pidNs !== pidNs) return unknown("pid namespace differs or is unrecorded");
  const ownerStart = Number(held.processStart!.slice("proc:".length));
  if (!Number.isSafeInteger(ownerStart) || ownerStart < 1) return unknown("invalid kernel process start");
  const read = host.read ?? ((path: string) => readFileSync(path, "utf8"));
  const scopeEvidence = probeCgroupScope(held, ownerStart, read, host.readCgroup ?? read);
  if (scopeEvidence && scopeEvidence.state !== "unknown") return scopeEvidence;
  let pids: string[];
  try { pids = (host.list ?? (() => readdirSync("/proc")))().filter(name => /^[0-9]+$/.test(name)); }
  catch (error) { return unknown(`process table unreadable: ${String(error)}`); }
  const markerPrefix = `${TEST_SLOT_RUN_ENV}=`;
  const unreadable: string[] = [];
  const deadline = performance.now() + 2_000;
  let scanned = 0;
  for (const pid of pids) {
    if (performance.now() >= deadline) return unknown("incomplete: process-tree observation exceeded its bound", "proc-environ (incomplete)");
    let start: number;
    try {
      const raw = read(`/proc/${pid}/stat`);
      start = Number(raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]);
      if (!raw.includes(") ") || !Number.isSafeInteger(start)) throw new Error("unparseable stat");
    } catch (error) {
      if (!goneProcess(error)) {
        const reason = `${pid}: process identity unreadable (${String(error)})`;
        unreadable.push(reason);
      }
      continue;
    }
    if (Number(pid) === held.pid && start === ownerStart) return { state: "live", coverage: "proc-environ", reason: `owner pid ${pid} is alive with its recorded start` };
    if (start < ownerStart) continue;
    let environ: string;
    try { environ = read(`/proc/${pid}/environ`); }
    catch (error) {
      if (!goneProcess(error)) {
        const reason = `${pid}: environment unreadable (${String(error)})`;
        unreadable.push(reason);
      }
      continue;
    }
    const marker = environ.split("\0").find(entry => entry.startsWith(markerPrefix));
    if (marker !== undefined) {
      try {
        const claim = JSON.parse(marker.slice(markerPrefix.length));
        if (claim?.nonce === held.ownerNonce && claim.pid === held.pid && claim.start === held.processStart) {
          return { state: "live", coverage: "proc-environ", reason: `covered descendant pid ${pid} still carries the reservation marker` };
        }
      } catch (error) {
        const reason = `${pid}: malformed reservation marker (${String(error)})`;
        unreadable.push(reason);
      }
    }
    scanned += 1;
  }
  if (unreadable.length > 0) return unknown(`incomplete: ${unreadable.length} process(es) started since the owner could not be read (pid ${unreadable.slice(0, 5).join(",")})`, "proc-environ (incomplete)");
  return unknown(`none of ${scanned} process(es) carries the marker; marker absence does not prove complete process-tree quiescence`, "proc-environ (incomplete)");
}

/** What a beating process needs to rewrite exactly one reservation; the lease's own identity, never a new one. */
export interface TestSlotHeartbeatHandle {
  path: string;
  ownerNonce: string;
  pid: number;
  processStart: string;
  host: string;
  intervalMs: number;
  bootId?: string;
  pidNs?: string;
  ownerUid?: number;
  /** Every covered step descendant inherits this, so {@link probeReservedTree} can see it after its parent dies. */
  coverageEnvironment: Record<string, string>;
}

/**
 * One beat under the slot's mutation guard: rewrites heartbeatAt (and states the cadence, or withdraws it)
 * in place, only while the record still names this exact owner. A busy guard defers; drift is `lost`.
 */
export function beatTestSlot(handle: TestSlotHeartbeatHandle, opts: { withdraw?: boolean; clock?: Clock } = {}): "beat" | "withdrawn" | "deferred" | "lost" {
  if (!Number.isSafeInteger(handle.intervalMs) || handle.intervalMs < 1) throw new Error("heartbeat cadence must be a positive safe integer");
  const mutation = acquireSlotMutation(handle.path);
  if (mutation.state !== "acquired") return "deferred";
  try {
    let fd: number;
    try { fd = openSync(handle.path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "lost";
      throw error;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || (st.mode & 0o077) === 0 || st.size < 1 || st.size > 1024 * 1024) return "lost";
      const bytes = Buffer.alloc(st.size);
      if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return "lost";
      const held = parseTestSlotHolder(bytes.toString("utf8"));
      if (!held || held.ownerNonce !== handle.ownerNonce || held.pid !== handle.pid || held.processStart !== handle.processStart ||
          held.bootId !== handle.bootId || held.pidNs !== handle.pidNs || held.ownerUid !== handle.ownerUid ||
          st.uid !== process.getuid?.() || held.ownerUid !== st.uid ||
          !sameHost(held.host, handle.host) || held.releaseRequestedAt !== undefined || held.ownershipProtocol !== undefined) return "lost";
      const when = (opts.clock ?? systemClock).date();
      const next: TestSlotHolder = { ...held, heartbeatAt: when.toISOString(), workIdentity: "reservation-marker-v1" };
      delete next.heartbeatIntervalMs;
      if (!opts.withdraw) next.heartbeatIntervalMs = handle.intervalMs;
      const body = Buffer.from(JSON.stringify(next));
      let offset = 0;
      while (offset < body.length) {
        const written = writeSync(fd, body, offset, body.length - offset, offset);
        if (written < 1) throw new Error("test slot heartbeat write made no progress");
        offset += written;
      }
      ftruncateSync(fd, body.length);
      futimesSync(fd, when, when);
      return opts.withdraw ? "withdrawn" : "beat";
    } finally { closeSync(fd); }
  } finally { mutation.release(); }
}

/**
 * Beat a reservation on an unref'd interval of THIS process's live event loop (W1-T9928). `stop(true)`
 * withdraws the cadence once the step ends; the permanent work identity still requires exact-tree
 * evidence before reclaiming. A failed or deferred beat is a diagnostic, never a release.
 */
export function startTestSlotHeartbeat(handle: TestSlotHeartbeatHandle,
  log: (row: Record<string, unknown>) => void = row => void process.stderr.write(`${JSON.stringify(row)}\n`)): { stop(coveredWorkEnded: boolean): void } {
  // Publish the protected identity before any child can start. A deferred or lost first beat is NOT admission.
  const initial = beatTestSlot(handle);
  if (initial !== "beat") throw new Error(`cannot start covered work: initial heartbeat ${initial}`);
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    try {
      if (beatTestSlot(handle) !== "lost") return;
      stopped = true;
      clearInterval(timer);
      log({ step: "test_slot.heartbeat_lost", path: handle.path, reason: "reservation no longer names this owner; beating stopped" });
    } catch (error) {
      log({ step: "test_slot.heartbeat_failed", path: handle.path, error: String(error) });
    }
  };
  const timer = setInterval(tick, handle.intervalMs);
  timer.unref?.();
  return {
    stop(coveredWorkEnded: boolean): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (!coveredWorkEnded) {
        log({ step: "test_slot.heartbeat_stopped", path: handle.path, reason: "covered work may outlive the step; cadence kept for exact-tree judgment" });
        return;
      }
      try { beatTestSlot(handle, { withdraw: true }); }
      catch (error) { log({ step: "test_slot.heartbeat_withdraw_failed", path: handle.path, error: String(error) }); }
    },
  };
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
        held.processStart !== claim.start || !sameHost(held.host, hostname()) ||
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

/** Recheck after the audit callback too: telemetry cannot give a replacement or late beat deletion authority. */
function unlinkObservedTestSlot(path: string, expected: Stats, held: TestSlotHolder): void {
  const current = lstatSync(path);
  if (!current.isFile() || (current.mode & 0o077) === 0 || current.uid !== expected.uid ||
      current.dev !== expected.dev || current.ino !== expected.ino ||
      JSON.stringify(readTestSlotHolder(path, expected)) !== JSON.stringify(held)) {
    throw new Error("reservation identity or heartbeat changed before release; re-observe");
  }
  unlinkSync(path);
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

/** The exact reservation an owner lane asks to release: the identity it observed, never a pattern. */
export interface OwnerReleaseRequest {
  ownerNonce: string;
  pid: number;
  processStart: string;
}

export type OwnerReleaseResult =
  | { outcome: "released"; evidence: ReservedTreeEvidence }
  | { outcome: "refused" | "deferred" | "held"; reason: string };

/**
 * An identity-checked, owner-assisted release of one legacy reservation after its covered work ended
 * (W1-T9928). Refused while the owner process or any covered descendant is observed live, when the record
 * lacks or differs from the requested identity (PID reuse, a replaced reservation), and for private-capacity-v1
 * records. A record that changes during release is held for re-observation. Nothing is signalled.
 */
export function releaseTestSlotForOwner(path: string, request: OwnerReleaseRequest, opts: {
  treeProbe?: (held: TestSlotHolder) => ReservedTreeEvidence;
  isPidAlive?: (pid: number) => boolean;
  hostname?: () => string;
  bootId?: () => string | undefined;
  pidNamespace?: () => string | undefined;
  log?: (line: string) => void;
} = {}): OwnerReleaseResult {
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const mutation = acquireSlotMutation(path);
  if (mutation.state !== "acquired") return { outcome: "deferred", reason: "slot mutation pending; re-observe" };
  try {
    const st = lstatSync(path);
    if (!st.isFile() || (st.mode & 0o077) === 0) return { outcome: "refused", reason: "private or non-file reservation: owner-lane release required" };
    const held = readTestSlotHolder(path, st);
    if (!held || !testSlotReservationIdentity(held)) return { outcome: "refused", reason: "owner identity unknown" };
    if (held.ownerUid !== st.uid || held.ownerUid !== process.getuid?.() ||
        !sameHost(held.host, (opts.hostname ?? hostname)()) || held.bootId !== (opts.bootId ?? readBootId)() ||
        held.pidNs !== (opts.pidNamespace ?? readPidNamespace)() || held.ownershipProtocol !== undefined) {
      return { outcome: "refused", reason: "reservation host, boot, namespace or owner identity is unproven" };
    }
    if (held.ownerNonce !== request.ownerNonce || held.pid !== request.pid || held.processStart !== request.processStart) {
      return { outcome: "refused", reason: "reservation identity differs from the request: PID reuse or a replaced reservation" };
    }
    const facts = testSlotProcessFacts(held.pid);
    if (facts?.start === held.processStart || (facts === undefined && (opts.isPidAlive ?? defaultIsPidAlive)(held.pid))) {
      return { outcome: "refused", reason: `owner pid ${held.pid} is alive` };
    }
    const evidence = observeReservedTree(held, opts.treeProbe ?? probeReservedTree);
    if (!verifiedTerminalEvidence(held, evidence)) return { outcome: "refused", reason: `covered work is not proven ended: ${evidence.reason}` };
    const result = reclaimStaleLock(path, {
      parseHolder: raw => ({ holder: parseTestSlotHolder(raw) }),
      isStale: current => current.holder !== null && JSON.stringify(current.holder) === JSON.stringify(held),
      onReclaim: () => log(JSON.stringify({ step: "test_slot.owner_release", path, pid: held.pid, label: held.label,
        ownerNonce: held.ownerNonce, processStart: held.processStart, bootId: held.bootId, pidNs: held.pidNs,
        reservation: testSlotReservationIdentity(held),
        evidence: evidence.state, coverage: evidence.coverage, reason: evidence.reason })),
      onLostReclaim: () => {},
    }, {
      openSync, readFileSync, closeSync, fstatSync, statSync: lstatSync,
      unlinkSync: () => unlinkObservedTestSlot(path, st, held),
    });
    if (result.outcome === "reclaimed") return { outcome: "released", evidence };
    return { outcome: "held", reason: "reservation changed during release; re-observe" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "refused", reason: "no reservation at this path" };
    return { outcome: "held", reason: `release could not verify the reservation: ${String(error)}` };
  } finally { mutation.release(); }
}

/** Seams for {@link acquireTestSlot}; every field defaults to the real host. */
export interface TestSlotOptions {
  /** Explicit ceiling; it only lowers CPU/memory-derived capacity. */
  maxConcurrency?: number;
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
  /** Exact-tree evidence for a cadence-bearing holder whose owner pid is gone; default {@link probeReservedTree}. */
  treeProbe?: (held: TestSlotHolder) => ReservedTreeEvidence;
  /** Whether any process holds a mutation guard open; default {@link defaultGuardHolderProbe}. */
  guardProbe?: (guardPath: string, guard: Stats) => GuardHolderEvidence;
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
  /** Lets a process with a live event loop beat this legacy reservation while its owner blocks. */
  heartbeat?: TestSlotHeartbeatHandle;
  refresh(): void;
  release(): void;
}

/** Explicit NOT_RUN for private coordination or unproven covered work survives every launch boundary. */
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
  if (sameHost(held.host, opts.hostname()) && !foreignNs) return isHolderStale(held, { isPidAlive: opts.isPidAlive, hostname: opts.hostname });
  const mine = opts.bootId();
  if (held.bootId !== undefined && mine !== undefined && held.bootId !== mine) return true;
  return now - Date.parse(held.heartbeatAt) > TEST_SLOT_LEASE_MS;
}

/**
 * Take one of the host-wide slots for a test-suite run, waiting (bounded) while all are live.
 * Ordinary acquisition runs at its named concurrency. Invalid explicit ceilings and
 * wider inherited owners refuse before work; they never edit another owner or raise capacity.
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
  const maximum = opts.maxConcurrency ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError("test worker ceiling must be a positive safe integer");
  const guardHolder = createGuardHolderProbe();
  try { return yield* testSlotPolls(label, opts, maximum, opts.guardProbe ?? guardHolder.probe); }
  finally { guardHolder.dispose(); }
}

function* testSlotPolls(label: string, opts: TestSlotOptions, maximum: number,
  guardProbe: OrphanGuardRecovery["probe"]): Generator<number, TestSlotLease> {
  const clock = opts.clock ?? systemClock;
  const host = opts.hostname ?? hostname;
  const bootId = opts.bootId ?? (() => readBootId());
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const pidNamespace = opts.pidNamespace ?? (() => readPidNamespace());
  const privateWriter = opts.ownershipProtocol === "private-capacity-v1";
  const parentPolicy = opts.privateParentPolicy === "require-entry-protection";
  const basePrivate = privateWriter || opts.privateCoordinationRequired === true || parentPolicy;
  // Re-derived at every poll from what that poll observes (W1-T9928); only incomplete cleanup is sticky.
  let cleanupIncomplete = false;
  let privateRequired = basePrivate;
  let reservedWorkUnproven = false;
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
    if (held.pidNs !== mineNs || !sameHost(held.host, host())) return false;
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
      cleanupIncomplete = true; privateRequired = true;
      cleanupLog({ step: "test_slot.mutation_cleanup_incomplete", label, ownerRecoveryRequired: true, error: String(error) });
      return false;
    }
  };
  const treeProbe = opts.treeProbe ?? ((held: TestSlotHolder) => probeReservedTree(held, { platform: opts.platform, hostname: host, bootId: bootId(), pidNs: pidNamespace() }));
  const observed = new Set<string>();
  /** One row per distinct observation: a bounded diagnostic, not one per poll. */
  const observeOnce = (key: string, row: Record<string, unknown>): void => {
    if (observed.has(key)) return;
    observed.add(key);
    log(JSON.stringify(row));
  };
  const guardHolds: number[] = [];
  const guardSeen = new Map<string, number>();
  let poll = 0;
  const guardRecovery: OrphanGuardRecovery = {
    boundMs: (guard) => {
      const key = `${guard.dev}:${guard.ino}:${guard.mtimeMs}`, first = guardSeen.get(key);
      if (first === undefined) guardSeen.set(key, poll);
      // Judge only a guard this waiter already met on an EARLIER poll, against holds it measured itself.
      if (first === undefined || first === poll || guardHolds.length === 0) return undefined;
      return MUTATION_GUARD_HOLD_FACTOR * Math.max(...guardHolds);
    },
    now: () => systemClock.now(),
    probe: guardProbe,
    log: row => observeOnce(`${String(row.step)}:${String(row.path)}:${String(row.mtime)}:${String(row.reason)}`, { ...row, label }),
  };
  /** The waiter's own guard acquisitions, each acquire→release duration kept for this acquisition only. */
  const takeMutation = (path: string): ReturnType<typeof acquireSlotMutation> => {
    const began = performance.now();
    const mutation = acquireSlotMutation(path, guardRecovery);
    if (mutation.state !== "acquired") return mutation;
    return { state: "acquired", release: () => {
      try { mutation.release(); } finally { guardHolds.push(performance.now() - began); }
    } };
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
    const cpu = Math.min(maximum, testRunConcurrency(load(), slots));
    if (perFile === undefined) return cpu;
    const headroom = headroomOf();
    return Math.min(cpu, peaks?.length ?? cpu, memoryTestConcurrency(headroom === undefined ? undefined : headroom - reservedBytes, perFile) ?? cpu);
  };
  const unslotted = (outcome: TestSlotLease["outcome"], concurrency: number, note: string): TestSlotLease => ({
    outcome, concurrency, executionAllowed: !privateRequired && !reservedWorkUnproven, waitedMs: clock.now() - startedAt,
    note: (privateRequired || reservedWorkUnproven ? `NOT_RUN: ${reservedWorkUnproven ? "covered work has not been proven ended" : "private coordination requires an admitted lease"} (${outcome}); ${note.replace(/; ran unslotted.*$/i, "")}` : note) + basisNote,
    refresh: () => {}, release: () => {},
  });
  if (parentPolicy) {
    if (opts.dir === undefined) return unslotted("slot_unavailable", 1, "parent policy requires an explicit existing directory");
    if (!privateWriter) return unslotted("slot_unavailable", 1, "parent policy requires the gated private writer");
    const parent = observeTestSlotParent(dir);
    if (parent.state !== "SAFE") return unslotted("slot_unavailable", 1, `parent entry protection ${parent.state}: ${parent.reason}`);
  }
  const inherited = inheritedTestSlot(dir, parentPolicy);
  if (inherited.lease) {
    if (inherited.lease.concurrency > maximum) throw new Error("inherited test slot exceeds explicit worker ceiling");
    return inherited.lease;
  }
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
    heartbeatAt: clock.iso(), label, ownerNonce, processStart, concurrency, pidNs: pidNamespace(), ownerUid: process.getuid?.(),
    cgroupScope: readTestSlotCgroup({ platform: opts.platform }),
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
      poll += 1;
      privateRequired = basePrivate || cleanupIncomplete;
      reservedWorkUnproven = false;
      // Recover only our own, privately inspected dead holders BEFORE calculating memory.
      // Otherwise a dead peer closes the free slot beside it, or its old projection collides
      // with the replacement. Public metadata alone never authorizes foreign recovery.
      for (let i = 1; i <= slots; i += 1) {
        const path = join(dir, `slot-${i}.json`);
        try {
          const st = lstatSync(path);
          if (st.isFile() && (st.mode & 0o077) === 0) privateRequired = true;
          else if (st.isFile()) {
            const held = readTestSlotHolder(path, st);
            if (held?.heartbeatIntervalMs !== undefined || held?.workIdentity !== undefined) reservedWorkUnproven = true;
          }
          if (!privateWriter) continue;
          const mutation = takeMutation(path);
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
          const mutation = takeMutation(path);
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
            concurrency = perFile === undefined ? Math.min(maximum, testRunConcurrency(load(), slots)) : sized(namedPeaks(othersThan(i)));
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
              return holder?.ownerNonce === ownerNonce && holder.pid === (opts.pid ?? process.pid) && sameHost(holder.host, host());
            };
            const parentClaim = JSON.stringify({ path, pid: process.pid, nonce: ownerNonce, start: processStart, concurrency });
            return admittedLease = {
              outcome: "acquired", executionAllowed: true, concurrency, waitedMs,
              ...((opts.pid ?? process.pid) === process.pid && sameHost(host(), hostname()) && processStart ? {
                childEnvironment: { [TEST_SLOT_PARENT_ENV]: parentClaim,
                  [TEST_SLOT_DIR_ENV]: dir },
                ...(privateWriter ? {} : { heartbeat: { path, ownerNonce, pid: process.pid, processStart, host: host(),
                  bootId: ownedRecord.bootId, pidNs: ownedRecord.pidNs, ownerUid: ownedRecord.ownerUid,
                  intervalMs: TEST_SLOT_HEARTBEAT_MS, coverageEnvironment: { [TEST_SLOT_RUN_ENV]: parentClaim } } }),
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
                  const current = readTestSlotHolder(path, fstatSync(fd));
                  if (!current) throw new Error("owned reservation became unreadable during refresh");
                  writeRecord(JSON.stringify({ ...current, heartbeatAt: clock.iso() }));
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
                    const ours = (h: TestSlotHolder) => h.pid === (opts.pid ?? process.pid) && sameHost(h.host, host()) && h.ownerNonce === ownerNonce;
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
          let quiescent: { held: TestSlotHolder; evidence: ReservedTreeEvidence } | undefined;
          const reclaim = reclaimStaleLock(path, {
            parseHolder: parseTestSlotHolder,
            isStale: (held) => {
              quiescent = undefined;
              const pidStale = testSlotHolderStale(held, clock.now(), { hostname: host, bootId, isPidAlive, pidNamespace });
              const cadence = held.heartbeatIntervalMs, myNs = pidNamespace();
              const local = sameHost(held.host, host()) && !(held.pidNs !== undefined && myNs !== undefined && held.pidNs !== myNs);
              // A cadence-less or foreign record keeps today's judgment exactly (pid probe; boot id, then lease).
              const recordedCadence = cadence !== undefined && Number.isSafeInteger(cadence) && cadence > 0;
              if ((!recordedCadence && held.workIdentity === undefined) || !local) return pidStale;
              reservedWorkUnproven = true;
              const silentMs = clock.now() - Date.parse(held.heartbeatAt);
              if (recordedCadence && silentMs > TEST_SLOT_SILENT_BEATS * cadence!) {
                observeOnce(`silent:${i}:${held.ownerNonce}`, { step: "test_slot.heartbeat_silent", label, slot: i, pid: held.pid, holder: held.label,
                  heartbeatAt: held.heartbeatAt, heartbeatIntervalMs: cadence, silentMs, decision: "retained: a missed beat is diagnostic, never quiescence" });
              }
              if (!pidStale) return false;
              // The owner pid is gone or reused: only exact-tree terminal evidence frees its capacity.
              const evidence = held.ownerUid === currentStat?.uid && held.ownerUid === process.getuid?.() &&
                held.bootId === bootId() && held.pidNs === myNs && testSlotReservationIdentity(held) !== undefined
                ? observeReservedTree(held, treeProbe)
                : { state: "unknown" as const, coverage: "none", reason: "owner identity unknown or host/boot/namespace/uid differs" };
              if (evidence.state === "ended") { quiescent = { held, evidence }; return true; }
              observeOnce(`withheld:${i}:${held.ownerNonce}:${evidence.state}:${evidence.reason}`, { step: "test_slot.reclaim_withheld", label, slot: i,
                pid: held.pid, holder: held.label, ownerNonce: held.ownerNonce, processStart: held.processStart,
                evidence: evidence.state, coverage: evidence.coverage, reason: evidence.reason });
              return false;
            },
            onReclaim: (detail) => {
              if (quiescent === undefined) {
                console.error(`[reclaimStaleLock] ${detail.lockPath}: reclaiming stale holder before unlink: ${detail.raw}`);
                return;
              }
              const { held, evidence } = quiescent;
              log(JSON.stringify({ step: "test_slot.reclaimed_quiescent", label, slot: i, pid: held.pid, holder: held.label,
                ownerNonce: held.ownerNonce, processStart: held.processStart, bootId: held.bootId, pidNs: held.pidNs,
                reservation: testSlotReservationIdentity(held),
                coverage: evidence.coverage, reason: evidence.reason, silentMs: clock.now() - Date.parse(held.heartbeatAt) }));
            },
            onLostReclaim: () => {},
          }, {
            openSync, readFileSync, closeSync, fstatSync, statSync: lstatSync,
            unlinkSync: name => {
              if (quiescent && currentStat) unlinkObservedTestSlot(path, currentStat, quiescent.held);
              else unlinkSync(name);
            },
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
