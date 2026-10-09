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
 * TIERED, SELF-HEALING — never a refusal:
 *   free slot        → run at {@link testRunConcurrency}, niced;
 *   all slots live   → wait (and say so), re-checking every poll;
 *   a dead holder    → reclaimed (same host: pid probe; other host/container: boot id, then lease);
 *   wait past bound  → `wait_bound_exceeded`: run UNSLOTTED at concurrency 1 — slow, never deadlocked;
 *   slot dir unusable → `slot_unavailable`: run unslotted at the load-derived concurrency.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, hostname, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleepAsync } from "node:timers/promises";

import { systemClock, type Clock } from "./clock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, reclaimStaleLock } from "./fs-race-safe.js";
import { RMD_TMP_PREFIX } from "./tmp.js";

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

function inheritedTestSlot(dir: string): { lease?: TestSlotLease; rejected?: string } {
  const raw = process.env[TEST_SLOT_PARENT_ENV];
  if (!raw || process.env.NODE_TEST_CONTEXT) return {};
  try {
    const claim = JSON.parse(raw);
    if (!claim || typeof claim.path !== "string" || typeof claim.nonce !== "string" ||
        !Number.isSafeInteger(claim.pid) || typeof claim.start !== "string" || !Number.isSafeInteger(claim.concurrency) ||
        !/^slot-[1-9][0-9]*\.json$/.test(claim.path.split("/").at(-1) ?? "")) return { rejected: "malformed-claim" };
    if (realpathSync(join(claim.path, "..")) !== realpathSync(dir)) return { rejected: "different-slot-directory" };
    const held = parseTestSlotHolder(readFileSync(claim.path, "utf8"));
    if (!held || held.pid !== claim.pid || held.ownerNonce !== claim.nonce ||
        held.processStart !== claim.start || held.host !== hostname() ||
        held.concurrency !== claim.concurrency || !Number.isSafeInteger(held.concurrency) || held.concurrency! < 1) return { rejected: "different-holder" };
    if (testSlotProcessFacts(held.pid)?.start !== held.processStart) return { rejected: "dead-or-reused-owner" };
    if (!testSlotHasAncestor(held.pid)) return { rejected: "owner-is-not-an-ancestor" };
    const verifyParent = () => {
      const current = parseTestSlotHolder(readFileSync(claim.path, "utf8"));
      if (!current || current.pid !== held.pid || current.ownerNonce !== held.ownerNonce ||
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

/** Seams for {@link acquireTestSlot}; every field defaults to the real host. */
export interface TestSlotOptions {
  dir?: string;
  slots?: number;
  waitBoundMs?: number;
  pollMs?: number;
  clock?: Clock;
  sleep?: (ms: number) => void;
  hostname?: () => string;
  bootId?: () => string | undefined;
  isPidAlive?: (pid: number) => boolean;
  pid?: number;
  load?: () => HostLoad;
  log?: (line: string) => void;
  /** Which priority binaries exist, for the caller's {@link lowPriorityCommand}. */
  binaryExists?: BinaryProbe;
}

/** A held slot (or the named reason none is held), plus the concurrency the run should use. */
export interface TestSlotLease {
  outcome: "acquired" | "wait_bound_exceeded" | "slot_unavailable";
  concurrency: number;
  waitedMs: number;
  /** One line for the step detail: the run says whether it waited, and on whom. */
  note: string;
  /** Only a positively identified real descendant may borrow this owner; absent for unslotted runs. */
  childEnvironment?: Record<string, string>;
  refresh(): void;
  release(): void;
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
function testSlotHolderStale(held: TestSlotHolder, now: number, opts: Required<Pick<TestSlotOptions, "hostname" | "bootId" | "isPidAlive">>): boolean {
  if (held.host === opts.hostname()) return isHolderStale(held, { isPidAlive: opts.isPidAlive, hostname: opts.hostname });
  const mine = opts.bootId();
  if (held.bootId !== undefined && mine !== undefined && held.bootId !== mine) return true;
  return now - Date.parse(held.heartbeatAt) > TEST_SLOT_LEASE_MS;
}

/**
 * Take one of the host-wide slots for a test-suite run, waiting (bounded) while all are live.
 * Never throws and never refuses: every outcome runs the suite, at the concurrency it names.
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
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const load = opts.load ?? readHostLoad;
  const { dir, scope } = opts.dir !== undefined ? { dir: opts.dir, scope: "configured" as const } : resolveTestSlotDir();
  const slots = opts.slots ?? defaultTestSlots(load().cores);
  const waitBoundMs = opts.waitBoundMs ?? TEST_SLOT_WAIT_BOUND_MS;
  const pollMs = opts.pollMs ?? TEST_SLOT_POLL_MS;
  const startedAt = clock.now();
  const startedIso = clock.iso();
  const unslotted = (outcome: TestSlotLease["outcome"], concurrency: number, note: string): TestSlotLease => ({
    outcome, concurrency, waitedMs: clock.now() - startedAt, note, refresh: () => {}, release: () => {},
  });
  const inherited = inheritedTestSlot(dir);
  if (inherited.lease) return inherited.lease;
  if (inherited.rejected) log(JSON.stringify({ step: "test_slot.parent_rejected", label, reason: inherited.rejected }));
  try {
    mkdirSync(dir, { recursive: true, mode: 0o777 });
    // Every container user and the host operator reclaim each other's records: umask must not narrow it.
    if ((statSync(dir).mode & 0o777) !== 0o777 && statSync(dir).uid === process.getuid?.()) chmodSync(dir, 0o777);
  } catch (error) {
    // Uncoordinated is still a run: the named slot_unavailable outcome, never a refusal.
    const concurrency = testRunConcurrency(load(), slots);
    return unslotted("slot_unavailable", concurrency,
      `test slot UNAVAILABLE (${dir}: ${String((error as Error)?.message ?? error)}); ran unslotted at --test-concurrency=${concurrency}`);
  }
  const ownerNonce = randomUUID();
  const processStart = testSlotProcessFacts(opts.pid ?? process.pid)?.start;
  let concurrency = 1;
  const record = (): TestSlotHolder => ({
    pid: opts.pid ?? process.pid, host: host(), bootId: bootId(), startedAt: startedIso,
    heartbeatAt: clock.iso(), label, ownerNonce, processStart, concurrency,
  });
  let announced = false;
  try {
    return yield* waitForSlot();
  } catch (error) {
    // Uncoordinated is still a run: the named slot_unavailable outcome, never a refusal.
    const concurrency = testRunConcurrency(load(), slots);
    return unslotted("slot_unavailable", concurrency,
      `test slot UNAVAILABLE (${dir}: ${String((error as Error)?.message ?? error)}); ran unslotted at --test-concurrency=${concurrency}`);
  }
  function* waitForSlot(): Generator<number, TestSlotLease> {
    for (;;) {
      const holders: string[] = [];
      for (let i = 1; i <= slots; i += 1) {
        const path = join(dir, `slot-${i}.json`);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            concurrency = testRunConcurrency(load(), slots);
            writeFileSync(path, JSON.stringify(record()), { flag: "wx", mode: 0o666 });
            const waitedMs = clock.now() - startedAt;
            if (announced) log(JSON.stringify({ step: "test_slot.acquired", label, slot: i, waitedMs, dir }));
            let held = true;
            return {
              outcome: "acquired", concurrency, waitedMs,
              ...((opts.pid ?? process.pid) === process.pid && host() === hostname() && processStart ? {
                childEnvironment: { [TEST_SLOT_PARENT_ENV]: JSON.stringify({ path, pid: process.pid, nonce: ownerNonce, start: processStart, concurrency }),
                  [TEST_SLOT_DIR_ENV]: dir },
              } : {}),
              note: `host-wide test slot ${i}/${slots} (${scope}: ${dir})` +
                `${announced ? `, after waiting ${Math.round(waitedMs / 1000)}s` : ""}; --test-concurrency=${concurrency}, niced`,
              refresh: () => {
                if (held) writeFileSync(path, JSON.stringify({ ...record(), heartbeatAt: clock.iso() }));
              },
              release: () => {
                if (!held) return;
                held = false;
                // Only OUR record, compared by bytes+inode at the unlink: a reclaimer's replacement survives.
                try {
                  reclaimStaleLock(path, {
                    parseHolder: parseTestSlotHolder,
                    isStale: (h) => h.pid === (opts.pid ?? process.pid) && h.host === host() && h.ownerNonce === ownerNonce,
                    onReclaim: () => {},
                    onLostReclaim: () => {},
                  });
                } catch (error) {
                  // The run's verdict stands; a record we could not remove ages out by its lease.
                  log(JSON.stringify({ step: "test_slot.release_failed", label, path, error: String(error) }));
                }
              },
            };
          } catch (error) {
            // Only "someone holds it" is a slot answer; anything else is the outer slot_unavailable.
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          const reclaim = reclaimStaleLock(path, {
            parseHolder: parseTestSlotHolder,
            isStale: (held) => testSlotHolderStale(held, clock.now(), { hostname: host, bootId, isPidAlive }),
            onLostReclaim: () => {},
          });
          if (reclaim.outcome === "live") {
            holders.push(`slot ${i}: pid ${reclaim.holder.pid} on ${reclaim.holder.host} (${reclaim.holder.label})`);
            break;
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
