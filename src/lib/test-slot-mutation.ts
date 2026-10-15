/** Short cooperative serialization for all participating slot writers, including legacy allocation.
 * This guard covers create/recover/release/rollback, not the lifetime of the test work itself.
 * An abandoned or unreadable guard is never aged, retried or stolen. The caller bounds deferral.
 * Retaining its empty private descriptor pins identity until release. The final pathname unlink is
 * still not an atomic POSIX inode CAS against arbitrary actors bypassing this protocol.
 */
import { closeSync, fstatSync, lstatSync, openSync, unlinkSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";

export type SlotMutation =
  | { state: "acquired"; release(): void }
  | { state: "busy"; reason: "contended" | "unavailable" };

const mutationPath = (path: string): string => join(dirname(path), `.${basename(path)}.mutation`);

/** Presence includes non-files and lookup failures; only ENOENT establishes an absent guard. */
export function slotMutationPending(path: string): boolean {
  try { lstatSync(mutationPath(path)); return true; }
  catch (error) {
    // Absence alone is free; denied/failed lookups retain the occupied guard.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** path is the canonical slot JSON pathname. A busy result never establishes free capacity. */
export function acquireSlotMutation(path: string): SlotMutation {
  const uid = process.getuid?.();
  if (uid === undefined) return { state: "busy", reason: "unavailable" };
  const guard = mutationPath(path);
  let fd: number;
  try { fd = openSync(guard, "wx", 0o600); }
  catch (error) {
    return { state: "busy", reason: (error as NodeJS.ErrnoException).code === "EEXIST" ? "contended" : "unavailable" };
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
