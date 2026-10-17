/** Short cooperative serialization for all participating slot writers, including legacy allocation.
 * This guard covers create/recover/release/rollback, not the lifetime of the test work itself.
 * An unreadable guard is never aged, retried or stolen. An abandoned one is reclaimed only when the
 * caller opts in with {@link OrphanGuardRecovery} (W1-T9928): past a bound derived from holds the caller
 * measured itself, AND an open-file probe run as the guard's own uid positively shows no process holds it.
 * Retaining its empty private descriptor pins identity until release. The final pathname unlink is
 * still not an atomic POSIX inode CAS against arbitrary actors bypassing this protocol.
 */
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, realpathSync, statSync, unlinkSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";

export type SlotMutation =
  | { state: "acquired"; release(): void }
  | { state: "busy"; reason: "contended" | "unavailable" };

/** Whether any process holds a guard open: only `closed` is positive evidence of an orphan. */
export interface GuardHolderEvidence {
  state: "open" | "closed" | "unknown";
  /** Which probe answered (`proc-fd`, `lsof`, an injected name). */
  probe: string;
  reason: string;
}

/** A writer keeps its guard descriptor open from creation to unlink, so an open-file check decides orphanhood. */
export interface OrphanGuardRecovery {
  /** The age past which this guard may be judged, derived from holds the caller measured; undefined judges nothing. */
  boundMs(guard: Stats): number | undefined;
  /** Milliseconds on the file-timestamp clock, so a guard's age is `now() - mtimeMs`. */
  now(): number;
  probe(guardPath: string, guard: Stats): GuardHolderEvidence;
  log(row: Record<string, unknown>): void;
}

const mutationPath = (path: string): string => join(dirname(path), `.${basename(path)}.mutation`);

/** Presence includes non-files and lookup failures; only ENOENT establishes an absent guard. */
export function slotMutationPending(path: string): boolean {
  try { lstatSync(mutationPath(path)); return true; }
  catch (error) {
    // Absence alone is free; denied/failed lookups retain the occupied guard.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * The real open-file probe: a `/proc/<pid>/fd` scan on linux, `lsof` on darwin, both over the guard
 * owner's own processes. Any unreadable same-uid process, failed run or other platform is `unknown`.
 * Other uids cannot open a 0600 guard they do not own, so their processes are outside the question.
 */
export function defaultGuardHolderProbe(guardPath: string, guard: Stats, platform: NodeJS.Platform = process.platform,
  lsof = (path: string) => execFileSync("lsof", ["-t", "--", path], { encoding: "utf8", timeout: 2_000, maxBuffer: 65_536, stdio: ["ignore", "pipe", "pipe"] })): GuardHolderEvidence {
  if (guard.uid !== process.getuid?.()) return { state: "unknown", probe: "none", reason: `guard uid ${guard.uid} is not this process's uid` };
  if (platform === "linux") return procFdProbe(guardPath, guard);
  if (platform !== "darwin") return { state: "unknown", probe: "none", reason: `no open-file probe on ${platform}` };
  try {
    const pids = lsof(guardPath).trim();
    return pids ? { state: "open", probe: "lsof", reason: `held open by pid ${pids.split(/\s+/).join(",")}` }
      : { state: "unknown", probe: "lsof", reason: "lsof exited 0 naming no process" };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    // lsof exits 1 both for "no process has it open" and for its own errors; only a silent 1 is the former.
    if (failed.status === 1 && !String(failed.stdout ?? "").trim() && !String(failed.stderr ?? "").trim()) {
      return { state: "closed", probe: "lsof", reason: "lsof found no process holding the guard" };
    }
    return { state: "unknown", probe: "lsof", reason: `lsof failed: ${String(failed.stderr ?? "").trim() || String(error)}` };
  }
}

function procFdProbe(guardPath: string, guard: Stats, procRoot = "/proc"): GuardHolderEvidence {
  const uid = process.getuid?.();
  let target: string;
  let pids: string[];
  try {
    target = join(realpathSync(dirname(guardPath)), basename(guardPath));
    pids = readdirSync(procRoot).filter(name => /^[0-9]+$/.test(name));
  } catch (error) {
    return { state: "unknown", probe: "proc-fd", reason: `process table unreadable: ${String(error)}` };
  }
  let scanned = 0;
  for (const pid of pids) {
    let fds: string[];
    try {
      if (statSync(join(procRoot, pid)).uid !== uid) continue;
      fds = readdirSync(join(procRoot, pid, "fd"));
    } catch (error) {
      // A process that exited mid-scan holds nothing; any other failure leaves the scan incomplete.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue;
      return { state: "unknown", probe: "proc-fd", reason: `pid ${pid} descriptors unreadable: ${String(error)}` };
    }
    for (const fd of fds) {
      try {
        const link = readlinkSync(join(procRoot, pid, "fd", fd));
        if (link !== target && link !== `${target} (deleted)`) continue;
        const open = statSync(join(procRoot, pid, "fd", fd));
        if (open.dev === guard.dev && open.ino === guard.ino) return { state: "open", probe: "proc-fd", reason: `held open by pid ${pid}` };
      } catch (error) {
        // A descriptor closed between listing and reading is not a holder; anything else is unknown.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return { state: "unknown", probe: "proc-fd", reason: `pid ${pid} fd ${fd} unreadable: ${String(error)}` };
      }
    }
    scanned += 1;
  }
  return { state: "closed", probe: "proc-fd", reason: `no descriptor among ${scanned} same-uid process(es) names the guard` };
}

/**
 * Reclaim an abandoned guard: past the caller's measured bound, empty, owned by this uid, and positively
 * shown closed. The identity is re-read after the probe; anything that moved keeps the guard.
 */
export function reclaimOrphanedSlotMutation(path: string, recovery: OrphanGuardRecovery): "reclaimed" | "kept" | "gone" {
  const guard = mutationPath(path);
  let st: Stats;
  try { st = lstatSync(guard); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    recovery.log({ step: "test_slot.mutation_guard_unproven", path: guard, reason: `guard unreadable: ${String(error)}` });
    return "kept";
  }
  const boundMs = recovery.boundMs(st);
  if (boundMs === undefined) return "kept";
  const ageMs = recovery.now() - st.mtimeMs;
  if (!(ageMs > boundMs)) return "kept";
  const facts = { path: guard, uid: st.uid, mtime: new Date(st.mtimeMs).toISOString(), ageMs: Math.round(ageMs), boundMs: Math.round(boundMs) };
  if (!st.isFile() || st.size !== 0) {
    recovery.log({ step: "test_slot.mutation_guard_unproven", ...facts, reason: "not an empty regular guard file" });
    return "kept";
  }
  if (st.uid !== process.getuid?.()) {
    recovery.log({ step: "test_slot.mutation_guard_unproven", ...facts, reason: "foreign-uid guard: its owner's processes are not probeable here" });
    return "kept";
  }
  const evidence = recovery.probe(guard, st);
  if (evidence.state !== "closed") {
    if (evidence.state === "unknown") recovery.log({ step: "test_slot.mutation_guard_unproven", ...facts, probe: evidence.probe, reason: evidence.reason });
    return "kept";
  }
  try {
    const again = lstatSync(guard);
    if (again.dev !== st.dev || again.ino !== st.ino || again.mtimeMs !== st.mtimeMs || again.size !== 0) {
      recovery.log({ step: "test_slot.mutation_guard_unproven", ...facts, probe: evidence.probe, reason: "guard identity changed during the probe" });
      return "kept";
    }
    recovery.log({ step: "test_slot.mutation_guard_reclaimed", ...facts, probe: evidence.probe, evidence: evidence.reason });
    unlinkSync(guard);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    recovery.log({ step: "test_slot.mutation_guard_unproven", ...facts, probe: evidence.probe, reason: `reclaim failed: ${String(error)}` });
    return "kept";
  }
  return "reclaimed";
}

/** path is the canonical slot JSON pathname. A busy result never establishes free capacity. */
export function acquireSlotMutation(path: string, recovery?: OrphanGuardRecovery): SlotMutation {
  const uid = process.getuid?.();
  if (uid === undefined) return { state: "busy", reason: "unavailable" };
  const guard = mutationPath(path);
  let fd: number;
  try { fd = openSync(guard, "wx", 0o600); }
  catch (error) {
    const contended = (error as NodeJS.ErrnoException).code === "EEXIST";
    // One retry, only after a proven orphan was removed (or vanished); a live writer always wins.
    if (!contended || recovery === undefined || reclaimOrphanedSlotMutation(path, recovery) === "kept") {
      return { state: "busy", reason: contended ? "contended" : "unavailable" };
    }
    try { fd = openSync(guard, "wx", 0o600); }
    catch (retryError) {
      return { state: "busy", reason: (retryError as NodeJS.ErrnoException).code === "EEXIST" ? "contended" : "unavailable" };
    }
  }
  let owner: Stats;
  const privateEmpty = (st: Stats): boolean => st.isFile() && st.uid === uid && st.size === 0 && (st.mode & 0o077) === 0;
  const same = (st: Stats): boolean => privateEmpty(st) && st.dev === owner.dev && st.ino === owner.ino;
  try {
    owner = fstatSync(fd);
    if (!privateEmpty(owner) || !same(lstatSync(guard))) throw new Error("slot mutation guard identity is unknown");
  } catch {
    // Inspection failure grants no unlink authority. Leave the name occupied and attempt fd cleanup.
    try { closeSync(fd); } catch { /* Still unavailable; never report acquisition or free capacity. */ }
    return { state: "busy", reason: "unavailable" };
  }
  let released = false;
  return {
    state: "acquired",
    release(): void {
      if (released) return;
      released = true;
      const errors: unknown[] = [];
      try {
        if (process.getuid?.() !== uid || !same(fstatSync(fd))) throw new Error("slot mutation guard ownership changed");
        let current: Stats | undefined;
        try { current = lstatSync(guard); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (current !== undefined) {
          if (!same(current)) throw new Error("slot mutation guard ownership changed");
          unlinkSync(guard);
        }
      } catch (error) {
        // Carry the original failure through descriptor cleanup into the thrown aggregate below.
        errors.push(error);
      }
      finally {
        try { closeSync(fd); }
        catch (error) {
          // A close failure joins, rather than replaces, the failed unlink diagnosis.
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "slot mutation guard release is incomplete");
    },
  };
}
