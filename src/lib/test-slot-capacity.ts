/** Public capacity is directory-entry metadata, never readable ownership bytes or an authority token. */
import { closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixedClock } from "./clock.js";

export interface SlotCapacityInput {
  concurrency?: number;
  memoryBytes?: number;
}
export interface SlotCapacity {
  heartbeatAt: string;
  concurrency: number;
  memoryBytes?: number;
}
const sameInode = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean => a.dev === b.dev && a.ino === b.ino;
const CAPACITY_SCAN_LIMIT = 128;

/** The caller must retain its canonical private reservation when metadata cleanup is incomplete. */
export class SlotCapacityCleanupError extends AggregateError {
  readonly cleanupIncomplete = true;
  constructor(errors: readonly unknown[], message = "slot capacity cleanup is incomplete") {
    super(errors, message, { cause: errors[0] });
    this.name = "SlotCapacityCleanupError";
  }
}

/** Called under the slot mutation guard; detected replacements are preserved, not unlinked.
 * These pathname checks are not an atomic POSIX compare-and-delete against arbitrary raw mutations.
 */
function removeOwnedProjection(directory: string, projection: string,
  owner: { dev: number; ino: number; uid: number }): void {
  try {
    if (owner.uid !== process.getuid?.()) throw new Error("foreign capacity recovery is not authorized");
    const st = lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== owner.uid || (st.mode & 0o777) !== 0o755) throw new Error("unsafe slot capacity directory");
    const current = lstatSync(projection);
    if (current.isFile() && current.uid === owner.uid && sameInode(owner, current)) unlinkSync(projection);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new SlotCapacityCleanupError([error], `slot capacity cleanup is incomplete${detail}`);
    }
    // An unpublished reservation may have no capacity directory or projection yet.
  }
}

/** Retire metadata BEFORE canonical reclamation, AFTER private ownership/staleness validation,
 * with the original descriptor retained and the slot mutation guard held. Public metadata grants
 * no authority. Only the matching private inode's entry is removed; absent metadata is harmless.
 * A cleanup error must leave the canonical private reservation occupied for a later owner retry.
 */
export function retireOwnedSlotCapacity(path: string, slot: number, input: SlotCapacityInput,
  owner: { dev: number; ino: number; uid: number }): void {
  const name = capacityName(slot, input), directory = join(dirname(path), `capacity-${owner.uid}`);
  removeOwnedProjection(directory, join(directory, name), owner);
}

/** Intentionally no label, paths, file inventory, process-start string, owner nonce or descendant claim. */
function capacityName(slot: number, input: SlotCapacityInput): string {
  const numbers = [slot, input.concurrency ?? 1, input.memoryBytes ?? 0];
  if (numbers.some(n => !Number.isSafeInteger(n) || n < 0) || numbers.slice(0, 2).some(n => n < 1)) throw new Error("invalid slot capacity");
  return ["v1", ...numbers].join(".");
}

/** Publish a hard link whose bounded name projects capacity; its inode stays 0600, including through this name.
 * The per-uid directory is public but not peer-writable. Peers never open the link or ownership record.
 * A hard link, unlike a separately readable sidecar, binds the projection to the actual reservation inode.
 * The caller holds the slot mutation guard and keeps fd open until the returned cleanup handle finishes.
 * Use that handle BEFORE deleting the canonical reservation, including after a later caller failure.
 */
export function publishSlotCapacity(path: string, fd: number, slot: number, input: SlotCapacityInput): () => void {
  const name = capacityName(slot, input); // Reject invalid allocation metadata before any directory/link write.
  const owner = fstatSync(fd);
  if (!owner.isFile() || owner.uid !== process.getuid?.() || (owner.mode & 0o077) !== 0 || !sameInode(owner, lstatSync(path))) throw new Error("private slot ownership required");
  const directory = join(dirname(path), `capacity-${owner.uid}`);
  let created = false;
  try { mkdirSync(directory, { mode: 0o755 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const dirFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, 0o600);
  try {
    const own = fstatSync(dirFd);
    if (!own.isDirectory() || own.uid !== owner.uid || !sameInode(own, lstatSync(directory))) throw new Error("unsafe slot capacity directory");
    if (created) fchmodSync(dirFd, 0o755); // Public directory only; never widen ownership-file permissions.
    if ((fstatSync(dirFd).mode & 0o777) !== 0o755) throw new Error("slot capacity directory must be peer-readable and owner-writable only");
  } finally { closeSync(dirFd); }
  const projection = join(directory, name);
  const remove = (): void => removeOwnedProjection(directory, projection, owner);
  let linked = false;
  try {
    linkSync(path, projection);
    linked = true;
    const current = lstatSync(projection);
    if (!current.isFile() || current.uid !== owner.uid || !sameInode(owner, current)) throw new Error("slot changed during capacity publication");
    return remove;
  } catch (error) {
    // EEXIST never grants authority over a pre-existing projection. Rollback is armed before linking.
    if (linked) {
      try { remove(); }
      catch (cleanupError) {
        const failures = cleanupError instanceof SlotCapacityCleanupError ? cleanupError.errors : [cleanupError];
        throw new SlotCapacityCleanupError([error, ...failures], "slot capacity publication failed and rollback is incomplete");
      }
    }
    throw error;
  }
}

export type SlotCapacityObservation = { state: "missing" } | { state: "unknown" } | { state: "observed"; capacity: SlotCapacity };

/** Missing, unreadable and incomplete are distinct. This function never reads private ownership contents. */
export function observeSlotCapacity(path: string, slot: number): SlotCapacityObservation {
  let owner;
  try { owner = lstatSync(path); }
  catch (error) {
    // Only ENOENT establishes absence; every other lookup failure remains occupied UNKNOWN.
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown" };
  }
  if (!owner.isFile() || (owner.mode & 0o077) !== 0) return { state: "unknown" };
  try {
    const directory = join(dirname(path), `capacity-${owner.uid}`), st = lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== owner.uid || (st.mode & 0o777) !== 0o755) return { state: "unknown" };
    const dir = opendirSync(directory);
    let capacity: SlotCapacity | undefined;
    let count = 0;
    try {
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        if (++count > CAPACITY_SCAN_LIMIT) return { state: "unknown" };
        const match = /^v1\.([1-9][0-9]*)\.([1-9][0-9]*)\.([0-9]+)$/.exec(entry.name);
        if (!match || Number(match[1]) !== slot) continue;
        const values = match.slice(1).map(Number);
        if (values.some(n => !Number.isSafeInteger(n))) return { state: "unknown" };
        const projection = lstatSync(join(directory, entry.name));
        if (!projection.isFile() || !sameInode(owner, projection)) continue;
        if (capacity) return { state: "unknown" }; // Ambiguous projections never become spare capacity.
        capacity = { concurrency: values[1]!, ...(values[2] ? { memoryBytes: values[2] } : {}),
          heartbeatAt: fixedClock(projection.mtimeMs).iso() };
      }
    } finally { dir.closeSync(); }
    const current = lstatSync(path);
    return capacity && current.isFile() && sameInode(owner, current) && current.mtimeMs === owner.mtimeMs ? { state: "observed", capacity } : { state: "unknown" };
  } catch {
    // Enumeration or metadata failure grants no capacity and no ownership authority.
    return { state: "unknown" };
  }
}
