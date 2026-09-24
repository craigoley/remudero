/**
 * W1-T4463 — does a move of serve's checkout change anything serve LOADS?
 *
 * Serve restarted on every merge to main, including the docs, test and learnings merges that
 * cannot change a byte of its module graph; each restart empties its in-memory snapshots and the
 * console's first read after one timed out. The daemon answered the same question in W1-T2964
 * with {@link advanceIsMaterial}; this reuses that list and its fail-toward-restarting contract
 * (empty, blank and unreadable are all relevant) and adds the trees only serve reads.
 */
import { execFile } from "node:child_process";
import { advanceIsMaterial } from "./self-sync.js";

/** Read by serve at boot or by its entrypoint, beyond the daemon's {@link advanceIsMaterial} list.
 *  `.remudero/` is W1-T4229's outage: serve loads managed-repos.json once, at boot. `plan/` is
 *  loaded once too (boardDeps.plan); skipping it waits on serve reloading its plan. */
export const SERVE_ONLY_RESTART_PATHS = ["hooks/", "settings/", "deploy/", ".remudero/", "plan/"] as const;

export function serveRestartRelevant(changedPaths: readonly string[] | undefined): boolean {
  if (advanceIsMaterial(changedPaths)) return true;
  return (changedPaths ?? []).some((raw) => SERVE_ONLY_RESTART_PATHS.some((prefix) => raw.trim().startsWith(prefix)));
}

/** An unreadable diff carries its reason rather than arriving as an empty list. */
export type ChangedPathsRead = { changedPaths?: string[]; diffUnreadable?: string };

export type ChangedPathsReader = (bootSha: string, targetRef: string) => ChangedPathsRead | Promise<ChangedPathsRead>;

/** BACKSTOP: fires only on a hung git; it bounds how long the restart decision waits. */
export const CHANGED_PATHS_TIMEOUT_MS = 30_000;

/** `git diff --name-only <bootSha> <targetRef>`, async: serve's event loop never waits on git. */
export function changedPathsSince(bootSha: string, targetRef: string, repoDir: string): Promise<ChangedPathsRead> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repoDir, "diff", "--name-only", bootSha, targetRef],
      { encoding: "utf8", timeout: CHANGED_PATHS_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve({ diffUnreadable: err.message });
        resolve({ changedPaths: stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0) });
      },
    );
  });
}
