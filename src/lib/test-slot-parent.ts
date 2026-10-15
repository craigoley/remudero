import { lstatSync, type Stats } from "node:fs";
import { posix } from "node:path";

export interface TestSlotParentMetadata {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
  /** POSIX permission and special bits only, including sticky. */
  readonly mode: number;
}

export type TestSlotParentErrorCode = "ENOENT" | "EACCES" | "EPERM" | "ENOTDIR" | "ELOOP" | "EIO" | "OTHER";
export type TestSlotParentObservation =
  | { state: "SAFE"; reason: "no-cross-user-write-bits" | "sticky-cross-user-writable-parent"; parent: TestSlotParentMetadata }
  | { state: "UNSAFE"; reason: "parent-is-symlink" | "parent-is-not-directory" | "cross-user-writable-without-sticky"; parent: TestSlotParentMetadata }
  | { state: "UNKNOWN"; reason: "unsupported-platform" | "invalid-path" | "invalid-metadata" | "parent-changed" }
  | { state: "UNKNOWN"; reason: "parent-missing" | "parent-lookup-failed"; errorCode: TestSlotParentErrorCode };

type ParentStat = Pick<Stats, "dev" | "ino" | "uid" | "gid" | "mode" | "isDirectory" | "isSymbolicLink">;

function metadata(st: ParentStat): TestSlotParentMetadata | undefined {
  if (![st.dev, st.ino, st.uid, st.gid, st.mode].every(n => Number.isSafeInteger(n) && n >= 0) || st.mode > 0o177777) return undefined;
  return { dev: st.dev, ino: st.ino, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 };
}

function lookupFailure(error: unknown): TestSlotParentObservation {
  // Never return paths, raw error messages, stacks or arbitrary thrown values.
  let code: unknown;
  try { code = (error as NodeJS.ErrnoException | null)?.code; }
  catch { /* A throwing code accessor is still an unclassified lookup failure. */ }
  const errorCode: TestSlotParentErrorCode = code === "ENOENT" || code === "EACCES" || code === "EPERM" ||
    code === "ENOTDIR" || code === "ELOOP" || code === "EIO" ? code : "OTHER";
  return { state: "UNKNOWN", reason: errorCode === "ENOENT" ? "parent-missing" : "parent-lookup-failed", errorCode };
}

/** Source-only observer for private-capacity-v1; directory is the parent of slot/guard/capacity entries,
 * NOT a slot JSON path. SAFE describes only the observed POSIX mode-bit entry protection. A sticky
 * shared directory restricts unrelated UIDs' unlink/rename of entries; it does not protect against
 * the directory owner, same-UID or privileged actors, or stop arbitrary entry creation/squatting.
 * ACLs, ancestor paths, mount semantics, peer usability and admission are outside this observation.
 * This is no recovery/deletion credential, atomic path pin or guarantee against later mutation.
 * No contents, enumeration, writes, chmod, deletion, retries or runtime activation occur here.
 * At most two synchronous lstat calls; this bounds work count, not filesystem syscall latency.
 */
export function observeTestSlotParent(directory: string,
  lstat: (directory: string) => ParentStat = lstatSync,
  platform: NodeJS.Platform = process.platform): TestSlotParentObservation {
  if (platform !== "linux" && platform !== "darwin") return { state: "UNKNOWN", reason: "unsupported-platform" };
  // Do not resolve dot segments through symlinks or let a trailing slash hide a final symlink.
  if (!directory || directory.length > 4096 || directory.includes("\0") || !posix.isAbsolute(directory) ||
    directory.split("/").some(part => part === "." || part === "..")) return { state: "UNKNOWN", reason: "invalid-path" };
  const path = directory.replace(/\/+$/, "") || "/";
  try {
    const first = lstat(path), parent = metadata(first);
    if (!parent) return { state: "UNKNOWN", reason: "invalid-metadata" };
    if (first.isSymbolicLink()) return { state: "UNSAFE", reason: "parent-is-symlink", parent };
    if (!first.isDirectory()) return { state: "UNSAFE", reason: "parent-is-not-directory", parent };
    // Treat either group or other write permission as potentially cross-user, even without search.
    const crossUserWritable = (parent.mode & 0o022) !== 0;
    if (crossUserWritable && (parent.mode & 0o1000) === 0) return { state: "UNSAFE", reason: "cross-user-writable-without-sticky", parent };
    const next = lstat(path), current = metadata(next);
    if (!current) return { state: "UNKNOWN", reason: "invalid-metadata" };
    if (next.isSymbolicLink() || !next.isDirectory() || parent.dev !== current.dev || parent.ino !== current.ino ||
      parent.uid !== current.uid || parent.gid !== current.gid || parent.mode !== current.mode) return { state: "UNKNOWN", reason: "parent-changed" };
    return { state: "SAFE", reason: crossUserWritable ? "sticky-cross-user-writable-parent" : "no-cross-user-write-bits", parent };
  } catch (error) {
    // Missing and failed lookup both retain uncertainty, never free capacity or repair authority.
    return lookupFailure(error);
  }
}
