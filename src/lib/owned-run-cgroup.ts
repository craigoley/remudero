import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmdirSync, statfsSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedMemoryRunBinding, readMemoryLedger, type MemoryReservationHandle } from "./host-memory-ledger.js";
import { readPidNamespace, testSlotHasAncestor, testSlotProcessFacts } from "./test-slot.js";

/** BACKSTOP: kernel control reads must never become unbounded streams. */
export const OWNED_CGROUP_READ_BYTES = 4096;
export interface OwnedRunCgroupIdentity {
  path: string; dev: number; ino: number;
  ownerPid: number; ownerStart: string; namespace: string;
}
export type OwnedRunCgroupReading = { state: "populated" | "gone" | "empty-unqualified" } | { state: "unknown"; reason: string };
export interface OwnedRunCgroup {
  readonly identity: OwnedRunCgroupIdentity;
  read(): OwnedRunCgroupReading;
  cancel(): void;
  attachCapacity(lease: MemoryReservationHandle, rootPid: number): boolean;
  settleCapacity(): { released: boolean; reason: string };
  close(): boolean;
}

function verifyCgroup(path: string, identity?: Pick<OwnedRunCgroupIdentity, "dev" | "ino">): void {
  const st = lstatSync(path);
  if (process.platform !== "linux" || !st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o022) !== 0 ||
      realpathSync(path) !== resolve(path) || statfsSync(path).type !== 0x63677270 ||
      (identity && (st.dev !== identity.dev || st.ino !== identity.ino))) throw new Error("owned cgroup identity/backend unavailable");
}
function readControl(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("cgroup control is not regular");
    const buffer = Buffer.alloc(OWNED_CGROUP_READ_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (!count) break;used += count;
    }
    if (used > OWNED_CGROUP_READ_BYTES) throw new Error("cgroup control read incomplete");
    return buffer.subarray(0, used).toString("utf8");
  } finally { closeSync(fd); }
}
function writeControl(path: string, value: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile() || writeSync(fd, value) !== Buffer.byteLength(value)) throw new Error("cgroup control write incomplete");
  } finally { closeSync(fd); }
}

/** Child bootstrap ONLY: joins itself BEFORE dependency install, SDK spawn, probes or graders.
 * Never migrates a named foreign PID, or the creating daemon/supervisor into the kill boundary.
 * Single-account cooperative backend, not authentication against another writer of that account. */
export function joinOwnedRunCgroupSelf(identity: OwnedRunCgroupIdentity): void {
  const owner = testSlotProcessFacts(identity.ownerPid);
  if (!/\/rmd-eval-[a-f0-9-]{36}$/.test(identity.path) || identity.ownerPid === process.pid || !owner || owner.start !== identity.ownerStart ||
      identity.namespace !== readPidNamespace() || !testSlotHasAncestor(identity.ownerPid)) throw new Error("cgroup join requires a genuine child in the creating namespace");
  verifyCgroup(identity.path, identity);
  const dir = openSync(identity.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(dir);
    if (st.dev !== identity.dev || st.ino !== identity.ino) throw new Error("cgroup join identity changed");
    writeControl(`/proc/self/fd/${dir}/cgroup.procs`, String(process.pid));
  } finally { closeSync(dir); }
}

/** Default OFF. Creates only a unique EMPTY leaf under an explicitly delegated existing parent.
 * No default root, privilege elevation, fleet migration, controller tuning or adoption of an old scope.
 * This primitive is NOT a timer, native full-EVAL profile, grant or automated dispatch authority. */
export function createOwnedRunCgroup(opts: { enabled?: boolean; parent?: string }): OwnedRunCgroup | undefined {
  if (opts.enabled !== true) return undefined;
  if (!opts.parent || opts.parent === "/sys/fs/cgroup") throw new Error("explicit delegated cgroup parent required");
  verifyCgroup(opts.parent);
  const ownerStart = testSlotProcessFacts(process.pid)?.start, namespace = readPidNamespace();
  if (!ownerStart || !namespace) throw new Error("cgroup owner identity unavailable");
  const path = join(opts.parent, `rmd-eval-${randomUUID()}`);
  mkdirSync(path, { mode: 0o700 }); // Exclusive private leaf, independent of an operator's permissive umask.
  verifyCgroup(path);
  const st = lstatSync(path), identity: OwnedRunCgroupIdentity = Object.freeze({ path, dev: st.dev, ino: st.ino, ownerPid: process.pid, ownerStart, namespace });
  const dir = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let observedPopulated = false, closed = false;
  let capacity: MemoryReservationHandle | undefined, capacityReleased = false;
  const assertOwner = (): void => {
    if (closed || identity.ownerPid !== process.pid || testSlotProcessFacts(process.pid)?.start !== ownerStart || readPidNamespace() !== namespace) throw new Error("cgroup owner unavailable");
    verifyCgroup(path, identity);
    const actual = fstatSync(dir);
    if (actual.dev !== identity.dev || actual.ino !== identity.ino) throw new Error("cgroup descriptor identity changed");
  };
  const read = (): OwnedRunCgroupReading => {
    try {
      assertOwner();
      const text = readControl(`/proc/self/fd/${dir}/cgroup.events`), values = [...text.matchAll(/^populated ([01])$/gm)];
      if (values.length !== 1) throw new Error("cgroup population unavailable");
      if (values[0]![1] === "1") { observedPopulated = true;return { state: "populated" }; }
      return { state: observedPopulated ? "gone" : "empty-unqualified" };
    } catch (error) { return { state: "unknown", reason: error instanceof Error ? error.message : String(error) }; }
  };
  return {
    identity, read,
    cancel: () => { assertOwner();writeControl(`/proc/self/fd/${dir}/cgroup.kill`, "1"); },
    attachCapacity: (lease, rootPid) => {
      assertOwner();
      if (capacity || !lease.id || lease.published !== true || ownedMemoryRunBinding(lease.id).state !== "fresh" ||
          !testSlotHasAncestor(process.pid, rootPid) || read().state !== "populated") return false;
      const members = readControl(`/proc/self/fd/${dir}/cgroup.procs`).trim().split("\n");
      if (!members.includes(String(rootPid))) return false;
      const birth = testSlotProcessFacts(rootPid)?.start;
      if (!birth) return false;
      lease.bindRoot(rootPid);
      const bound = ownedMemoryRunBinding(lease.id);
      if (bound.state !== "bound" || bound.roots.length !== 1 || bound.roots[0]?.pid !== rootPid || bound.roots[0]?.start !== birth) return false;
      capacity = lease;return true; // One original fresh lease, bound before child bootstrap proceeds.
    },
    settleCapacity: () => {
      if (capacityReleased) return { released: true, reason: "original-owned-capacity-already-released" };
      if (read().state !== "gone") return { released: false, reason: "whole-run-population-not-verified-gone" };
      const lease = capacity;
      if (!lease) return { released: false, reason: "no-original-bound-capacity" };
      const before = readMemoryLedger(), entry = before?.entries.find(e => e.id === lease.id);
      if (!lease.id || lease.published !== true || before?.state !== "present" || before.counts.unreadable !== 0 || entry?.status !== "owned") {
        return { released: false, reason: "original-owned-capacity-unavailable" };
      }
      lease.releaseOccupancy(); // Canonical ledger retains live/unknown descendants; no second lease store.
      const after = readMemoryLedger();
      if (after?.state !== "present" || after.counts.unreadable !== 0 || after.entries.some(e => e.id === lease.id)) {
        return { released: false, reason: "canonical-capacity-release-unverified" };
      }
      capacityReleased = true;
      return { released: true, reason: "owned-kernel-population-gone-and-canonical-release-verified" };
    },
    close: () => {
      const state = read().state;
      if (state !== "gone" && state !== "empty-unqualified") return false;
      if (capacity && !capacityReleased) return false;
      assertOwner();rmdirSync(path);closeSync(dir);closed = true;return true;
    },
  };
}
