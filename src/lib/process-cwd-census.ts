import { opendirSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { systemClock, type Clock } from "./clock.js";

/** W1-T2952: the bounded `/proc` census that decides whether any live process still works inside a dead
 *  fix round's worktree. W1-T10389 moved it out of src/run-task.ts so its own suite can import it without
 *  joining run-task's importers, and taught it to judge a pid whose cwd it may not read instead of
 *  answering `unknown` for the whole census on the first one. */
export interface ProcessCwdCensusDeps {
  readNextPid?: () => string | null;
  readCwd?: (pid: string) => string;
  /** W1-T10389: a pid's `/proc/<pid>/status` text, for its real uid and PPid. It defaults to `/proc` only
   *  when the pids come from `/proc` too; a caller that supplies its own pids and no status reader gets an
   *  unreadable status, so a synthetic process table never reads the real one. */
  readStatus?: (pid: string) => string;
  /** W1-T11659: a pid's `/proc/<pid>/cmdline` text (NUL-separated argv). Same default rule as `readStatus`. */
  readCmdline?: (pid: string) => string;
  /** W1-T11659: a pid's `/proc/<pid>/cgroup` text. Same default rule as `readStatus`. */
  readCgroup?: (pid: string) => string;
  /** W1-T10389: the daemon's own real uid; defaults to `process.getuid()`. */
  ownUid?: number;
  /** W1-T10389: told why an unreadable cwd still answered `unknown`, so the decline row can name it. */
  onUnreadable?: (detail: UnreadableCwdDetail) => void;
  clock?: Pick<Clock, "now">;
  maxEntries?: number;
  wallMs?: number;
}

/** W1-T10389: how a pid's real uid relates to the daemon's. */
export type CwdOwnerUid = "same" | "foreign" | "unreadable";

/** W1-T10389 design 1: which pid, which errno, and (on the daemon's own uid) where the ancestor walk stopped. */
export interface UnreadableCwdDetail {
  pid: number;
  errno: string;
  uid: CwdOwnerUid;
  walk?: "ppid_unreadable" | "cycle" | "reached_init" | "ancestor_exited" | "ancestor_error";
  ancestorPid?: number;
  ancestorErrno?: string;
}

export type ProcessCwdCensus = (
  | { state: "clear"; scanned: number }
  | { state: "occupied"; scanned: number; pid: number; via?: number }
  | { state: "unknown"; scanned: number; reason: "proc_unavailable" | "cwd_unreadable" | "entry_bound" | "wall_bound" }
) & { skippedForeign?: number; skippedUserManagers?: number; attributed?: number; attributedVia?: number[] };

const FIX_OWNER_PROC_ENTRY_BOUND = 4_096;
const FIX_OWNER_PROC_WALL_MS = 100;

export function pathIsAtOrBelow(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The real uid (first field of `Uid:`) and the PPid of a `/proc/<pid>/status` text; null when absent. */
function statusField(status: string, field: "Uid" | "PPid"): number | null {
  const match = new RegExp(`^${field}:\\s+(\\d+)`, "m").exec(status);
  return match ? Number(match[1]) : null;
}

const USER_MANAGER_CMDLINE = "/usr/lib/systemd/systemd\0--user";

/** W1-T11659: true only when every identity fact is readable and exact: argv is the per-user systemd manager
 *  and cgroup v2 places it in that uid's `user@<uid>.service/init.scope`. A failed read is not verified. */
function isVerifiedUserManager(
  pid: string, uid: number, readCmdline: (pid: string) => string, readCgroup: (pid: string) => string,
): boolean {
  let cmdline: string;
  let cgroup: string;
  try {
    cmdline = readCmdline(pid);
    cgroup = readCgroup(pid);
  } catch (identityError) {
    // Unreadable identity is not identity: the caller keeps the fail-closed `unknown` path.
    void identityError;
    return false;
  }
  if (cmdline !== USER_MANAGER_CMDLINE && cmdline !== `${USER_MANAGER_CMDLINE}\0`) return false;
  const unified = cgroup.split("\n").filter((line) => line.startsWith("0::"));
  return unified.length === 1
    && unified[0] === `0::/user.slice/user-${uid}.slice/user@${uid}.service/init.scope`;
}

function errnoOf(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code ? code : "unknown";
}

export function readBoundedProcessCwdCensus(
  ownerPath: string,
  deps: ProcessCwdCensusDeps = {},
): ProcessCwdCensus {
  const clock = deps.clock ?? systemClock;
  const now = () => clock.now();
  const maxEntries = deps.maxEntries ?? FIX_OWNER_PROC_ENTRY_BOUND;
  const wallMs = deps.wallMs ?? FIX_OWNER_PROC_WALL_MS;
  const started = now();
  let procDir: ReturnType<typeof opendirSync> | undefined;
  let readNextPid = deps.readNextPid;
  const pidsFromProc = !readNextPid;
  try {
    if (!readNextPid) {
      try {
        procDir = opendirSync("/proc");
      } catch {
        return { state: "unknown", scanned: 0, reason: "proc_unavailable" };
      }
      readNextPid = () => procDir!.readSync()?.name ?? null;
    }
    const readCwd = deps.readCwd ?? ((pid: string) => readlinkSync(join("/proc", pid, "cwd")));
    const readStatus = deps.readStatus ?? (pidsFromProc
      ? (pid: string) => readFileSync(join("/proc", pid, "status"), "utf8")
      : () => {
        throw Object.assign(new Error("no status reader for a supplied process table"), { code: "ENOSYS" });
      });
    const noReader = (what: string) => () => {
      throw Object.assign(new Error(`no ${what} reader for a supplied process table`), { code: "ENOSYS" });
    };
    const readCmdline = deps.readCmdline ?? (pidsFromProc
      ? (pid: string) => readFileSync(join("/proc", pid, "cmdline"), "utf8")
      : noReader("cmdline"));
    const readCgroup = deps.readCgroup ?? (pidsFromProc
      ? (pid: string) => readFileSync(join("/proc", pid, "cgroup"), "utf8")
      : noReader("cgroup"));
    const ownUid = deps.ownUid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    let scanned = 0;
    // W1-T10389 design 6: ancestor reads count against the same entry bound as the pids they explain.
    let walked = 0;
    let skippedForeign = 0;
    let skippedUserManagers = 0;
    const attributedVia: number[] = [];
    const finish = (result: ProcessCwdCensus): ProcessCwdCensus => ({
      ...result,
      ...(skippedForeign > 0 ? { skippedForeign } : {}),
      ...(skippedUserManagers > 0 ? { skippedUserManagers } : {}),
      ...(attributedVia.length > 0 ? { attributed: attributedVia.length, attributedVia } : {}),
    });
    const unreadable = (detail: UnreadableCwdDetail): ProcessCwdCensus => {
      deps.onUnreadable?.(detail);
      return finish({ state: "unknown", scanned, reason: "cwd_unreadable" });
    };
    for (;;) {
      if (now() - started > wallMs) return finish({ state: "unknown", scanned, reason: "wall_bound" });
      let entry: string | null;
      try {
        entry = readNextPid();
      } catch {
        return finish({ state: "unknown", scanned, reason: "proc_unavailable" });
      }
      if (entry === null) return finish({ state: "clear", scanned });
      if (!/^\d+$/.test(entry)) continue;
      if (scanned + walked >= maxEntries) return finish({ state: "unknown", scanned, reason: "entry_bound" });
      scanned += 1;
      let cwd: string;
      try {
        cwd = readCwd(entry);
      } catch (e) {
        const errno = errnoOf(e);
        if (errno === "ENOENT") continue;
        // W1-T10389 design 2: only a pid whose uid is readable can be told apart from a fleet worker.
        let status: string;
        try {
          status = readStatus(entry);
        } catch (statusError) {
          // The uid was not established, even if status vanished after the denied cwd read.
          void statusError;
          return unreadable({ pid: Number(entry), errno, uid: "unreadable" });
        }
        const uid = statusField(status, "Uid");
        if (uid === null || ownUid === undefined) return unreadable({ pid: Number(entry), errno, uid: "unreadable" });
        if (errno !== "EACCES" && errno !== "EPERM") {
          return unreadable({ pid: Number(entry), errno, uid: uid === ownUid ? "same" : "foreign" });
        }
        if (uid !== ownUid) {
          // A fleet worker runs as the daemon's own uid, so a foreign pid cannot be the owner.
          skippedForeign += 1;
          continue;
        }
        // W1-T11659: the per-user systemd manager is infrastructure, not a worker; skip it only on exact identity.
        if (statusField(status, "PPid") === 1 && isVerifiedUserManager(entry, uid, readCmdline, readCgroup)) {
          skippedUserManagers += 1;
          continue;
        }
        // W1-T10389 design 6: a same-uid pid the census may not read is a sandbox in a child user namespace;
        // its nearest readable ancestor (the launcher outside the sandbox) runs in the workspace it serves.
        const seen = new Set<number>([Number(entry)]);
        let parent = statusField(status, "PPid");
        let decided: { kind: "readable"; pid: number; cwd: string } | undefined;
        for (;;) {
          if (parent === null) return unreadable({ pid: Number(entry), errno, uid: "same", walk: "ppid_unreadable" });
          if (parent < 1) return unreadable({ pid: Number(entry), errno, uid: "same", walk: "reached_init" });
          if (seen.has(parent)) return unreadable({ pid: Number(entry), errno, uid: "same", walk: "cycle" });
          if (now() - started > wallMs) return finish({ state: "unknown", scanned, reason: "wall_bound" });
          if (scanned + walked >= maxEntries) return finish({ state: "unknown", scanned, reason: "entry_bound" });
          walked += 1;
          seen.add(parent);
          try {
            decided = { kind: "readable", pid: parent, cwd: readCwd(String(parent)) };
            break;
          } catch (ancestorError) {
            // Not erased: EACCES/EPERM walk on to the next ancestor; every other errno fails closed with its cause.
            const ancestorErrno = errnoOf(ancestorError);
            if (ancestorErrno === "ENOENT") return unreadable({ pid: Number(entry), errno, uid: "same", walk: "ancestor_exited" });
            if (ancestorErrno !== "EACCES" && ancestorErrno !== "EPERM") {
              return unreadable({ pid: Number(entry), errno, uid: "same", walk: "ancestor_error" });
            }
          }
          if (parent === 1) return unreadable({ pid: Number(entry), errno, uid: "same", walk: "reached_init" });
          let parentStatus: string;
          try {
            parentStatus = readStatus(String(parent));
          } catch (parentStatusError) {
            // Preserve the child's cwd errno; name the ancestor's status failure separately.
            return unreadable({
              pid: Number(entry), errno, uid: "same", walk: "ppid_unreadable",
              ancestorPid: parent, ancestorErrno: errnoOf(parentStatusError),
            });
          }
          parent = statusField(parentStatus, "PPid");
        }
        attributedVia.push(decided.pid);
        if (pathIsAtOrBelow(decided.cwd, ownerPath)) {
          return finish({ state: "occupied", scanned, pid: Number(entry), via: decided.pid });
        }
        continue;
      }
      if (pathIsAtOrBelow(cwd, ownerPath)) {
        return finish({ state: "occupied", scanned, pid: Number(entry) });
      }
    }
  } finally {
    try {
      procDir?.closeSync();
    } catch (e) {
      const error = String(e);
      void error;
    }
  }
}

/** W1-T10389 design 1/3/6: the `process_probe_reason` a decline row carries. Undefined when the census
 *  has nothing to say beyond its state, so a plain clear or direct occupancy keeps today's row. */
export function describeProcessCwdProbe(census: ProcessCwdCensus, detail?: UnreadableCwdDetail): string | undefined {
  const counts = [
    ...(census.skippedForeign ? [`skipped_foreign=${census.skippedForeign}`] : []),
    ...(census.skippedUserManagers ? [`skipped_user_manager=${census.skippedUserManagers}`] : []),
    ...(census.attributed ? [`attributed=${census.attributed}`] : []),
    ...(census.attributedVia?.length ? [`attributed_via=${census.attributedVia.join(",")}`] : []),
  ];
  if (census.state === "unknown") {
    if (census.reason !== "cwd_unreadable" || !detail) return [census.reason, ...counts].join(" ");
    const walk = detail.walk ? ` walk=${detail.walk}` : "";
    const ancestor = detail.ancestorPid !== undefined
      ? ` ancestor_pid=${detail.ancestorPid} ancestor_errno=${detail.ancestorErrno}` : "";
    return [`cwd_unreadable pid=${detail.pid} errno=${detail.errno} uid=${detail.uid}${walk}${ancestor}`, ...counts].join(" ");
  }
  if (census.state === "occupied" && census.via !== undefined) {
    return [`attributed pid=${census.pid} via=${census.via}`, ...counts].join(" ");
  }
  return counts.length > 0 ? [census.state, ...counts].join(" ") : undefined;
}
