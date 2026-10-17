/** Short cooperative serialization for all participating slot writers, including legacy allocation.
 * This guard covers create/recover/release/rollback, not the lifetime of the test work itself.
 * An unreadable guard is never aged, retried or stolen. An abandoned one is reclaimed only when the
 * caller opts in with {@link OrphanGuardRecovery} (W1-T9928): past a bound derived from holds the caller
 * measured itself, AND an open-file probe run as the guard's own uid positively shows no process holds it.
 * Retaining its empty private descriptor pins identity until release. The final pathname unlink is
 * still not an atomic POSIX inode CAS against arbitrary actors bypassing this protocol.
 */
import { spawn } from "node:child_process";
import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, rmdirSync, statSync, unlinkSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fixedClock } from "./clock.js";
import { RMD_TMP_PREFIX } from "./tmp.js";

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

// The helper's live loop bounds lsof and writes a receipt to an inherited, already-unlinked file.
// Even a synchronous slot wait can read that receipt on its next poll without blocking the daemon.
const LSOF_RECEIPT_SCRIPT = `
import {execFile} from 'node:child_process';
import {writeSync} from 'node:fs';
execFile('lsof', ['-t', '--', process.argv[1]], {encoding: 'utf8', timeout: 2000, maxBuffer: 65536},
  (error, stdout, stderr) => writeSync(3, JSON.stringify({status: error ? error.code ?? error.signal ?? 'failed' : 0, stdout, stderr}) + '\\n'));
`;

/** One acquisition owns its in-flight observations and closes every receipt when it finishes. */
export function createGuardHolderProbe() {
  const pending = new Map<string, { identity: string; fd: number; error?: Error }>();
  const discard = (path: string): void => {
    const entry = pending.get(path);
    if (entry === undefined) return;
    pending.delete(path);
    closeSync(entry.fd);
  };
  const probe = (path: string, guard: Stats, platform: NodeJS.Platform = process.platform): GuardHolderEvidence =>
    defaultGuardHolderProbe(path, guard, platform, () => {
      const identity = JSON.stringify([guard.dev, guard.ino, guard.uid, guard.mode, guard.size, guard.mtimeMs, guard.ctimeMs]);
      if (pending.has(path) && pending.get(path)!.identity !== identity) discard(path);
      let entry = pending.get(path);
      if (entry === undefined) {
        const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}slot-lsof-`));
        const receipt = join(dir, "receipt");
        let fd: number;
        try { fd = openSync(receipt, "wx+", 0o600); }
        finally {
          try { unlinkSync(receipt); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          rmdirSync(dir);
        }
        entry = { identity, fd };
        pending.set(path, entry);
        try {
          const child = spawn(process.execPath, ["--input-type=module", "-e", LSOF_RECEIPT_SCRIPT, path],
            { stdio: ["ignore", "ignore", "ignore", fd] });
          const observation = entry;
          child.on("error", error => { observation.error = error; });
          child.unref();
        } catch (error) { discard(path); throw error; }
        throw new Error("lsof observation pending; no terminal receipt yet");
      }
      if (entry.error) { const error = entry.error; discard(path); throw error; }
      const size = fstatSync(entry.fd).size;
      if (size === 0) throw new Error("lsof observation pending; no terminal receipt yet");
      if (size > 1024 * 1024) { discard(path); throw new Error("lsof receipt exceeds its output bound"); }
      const bytes = Buffer.alloc(size);
      const read = readSync(entry.fd, bytes, 0, size, 0);
      if (read !== size || bytes[size - 1] !== 10) throw new Error("lsof observation pending; incomplete receipt");
      discard(path);
      const result = JSON.parse(bytes.toString("utf8")) as { status: unknown; stdout: string; stderr: string };
      if (typeof result.stdout !== "string" || typeof result.stderr !== "string") throw new Error("invalid lsof receipt");
      if (result.status !== 0) throw Object.assign(new Error(`lsof exited ${String(result.status)}`), result);
      return result.stdout;
    });
  return { probe, dispose: (): void => { for (const path of pending.keys()) discard(path); } };
}

/** Presence includes non-files and lookup failures; only ENOENT establishes an absent guard. */
export function slotMutationPending(path: string): boolean {
  try { lstatSync(mutationPath(path)); return true; }
  catch (error) {
    // Absence alone is free; denied/failed lookups retain the occupied guard.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * A `/proc/<pid>/fd` scan on linux, or a completed `lsof` observation supplied by createGuardHolderProbe
 * on darwin, both over the guard owner's processes. Incomplete/failed observations are `unknown`.
 * Other uids cannot open a 0600 guard they do not own, so their processes are outside the question.
 */
export function defaultGuardHolderProbe(guardPath: string, guard: Stats, platform: NodeJS.Platform = process.platform,
  lsof?: (path: string) => string): GuardHolderEvidence {
  if (guard.uid !== process.getuid?.()) return { state: "unknown", probe: "none", reason: `guard uid ${guard.uid} is not this process's uid` };
  if (platform === "linux") return procFdProbe(guard);
  if (platform !== "darwin") return { state: "unknown", probe: "none", reason: `no open-file probe on ${platform}` };
  if (lsof === undefined) return { state: "unknown", probe: "lsof", reason: "a polling open-file observer is required on darwin" };
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

function procFdProbe(guard: Stats, procRoot = "/proc"): GuardHolderEvidence {
  const uid = process.getuid?.();
  const deadline = performance.now() + 2_000;
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter(name => /^[0-9]+$/.test(name));
  } catch (error) {
    return { state: "unknown", probe: "proc-fd", reason: `process table unreadable: ${String(error)}` };
  }
  let scanned = 0;
  const unreadable: string[] = [];
  for (const pid of pids) {
    if (performance.now() >= deadline) return { state: "unknown", probe: "proc-fd", reason: "incomplete: open-file probe exceeded its observation bound" };
    let fds: string[];
    try {
      if (statSync(join(procRoot, pid)).uid !== uid) continue;
      fds = readdirSync(join(procRoot, pid, "fd"));
    } catch (error) {
      // A process that exited mid-scan holds nothing; any other failure leaves the scan incomplete.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") unreadable.push(pid);
      continue;
    }
    for (const fd of fds) {
      if (performance.now() >= deadline) return { state: "unknown", probe: "proc-fd", reason: "incomplete: descriptor scan exceeded its observation bound" };
      try {
        // Compare every open inode: a writer may have opened a hard-link alias or renamed the guard.
        const open = statSync(join(procRoot, pid, "fd", fd));
        if (open.dev === guard.dev && open.ino === guard.ino) return { state: "open", probe: "proc-fd", reason: `held open by pid ${pid}` };
      } catch (error) {
        // A descriptor closed between listing and reading is not a holder; anything else is unknown.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(`${pid}/fd/${fd}`);
      }
    }
    scanned += 1;
  }
  if (unreadable.length > 0) {
    return { state: "unknown", probe: "proc-fd", reason: `incomplete: descriptors unreadable for same-uid ${unreadable.slice(0, 5).join(",")}` };
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
  if (boundMs === undefined || !Number.isFinite(boundMs) || boundMs < 0) return "kept";
  const ageMs = recovery.now() - st.mtimeMs;
  if (!(ageMs > boundMs)) return "kept";
  const facts = { path: guard, uid: st.uid, mtime: fixedClock(st.mtimeMs).iso(), ageMs: Math.round(ageMs), boundMs: Math.round(boundMs) };
  if (!st.isFile() || st.size !== 0 || (st.mode & 0o077) !== 0) {
    recovery.log({ step: "test_slot.mutation_guard_unproven", ...facts, reason: "not an empty private regular guard file" });
    return "kept";
  }
  if (st.uid !== process.getuid?.()) {
    recovery.log({ step: "test_slot.mutation_guard_unproven", ...facts, reason: "foreign-uid guard: its owner's processes are not probeable here" });
    return "kept";
  }
  let evidence: GuardHolderEvidence;
  try { evidence = recovery.probe(guard, st); }
  catch (error) { evidence = { state: "unknown", probe: "failed", reason: `open-file probe failed: ${String(error)}` }; }
  if (evidence.state !== "closed") {
    if (evidence.state === "unknown") recovery.log({ step: "test_slot.mutation_guard_unproven", ...facts, probe: evidence.probe, reason: evidence.reason });
    return "kept";
  }
  try {
    const again = lstatSync(guard);
    const same = (current: Stats): boolean => current.isFile() && current.dev === st.dev && current.ino === st.ino &&
      current.uid === st.uid && current.mode === st.mode && current.mtimeMs === st.mtimeMs && current.ctimeMs === st.ctimeMs && current.size === 0;
    if (!same(again)) {
      recovery.log({ step: "test_slot.mutation_guard_unproven", ...facts, probe: evidence.probe, reason: "guard identity changed during the probe" });
      return "kept";
    }
    unlinkSync(guard);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    recovery.log({ step: "test_slot.mutation_guard_unproven", ...facts, probe: evidence.probe, reason: `reclaim failed: ${String(error)}` });
    return "kept";
  }
  recovery.log({ step: "test_slot.mutation_guard_reclaimed", ...facts, probe: evidence.probe, evidence: evidence.reason });
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
