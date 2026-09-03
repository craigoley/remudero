/**
 * lib/install-hash.ts — the shared change-detector over `package.json` +
 * `package-lock.json`, extracted from `src/run-task.ts` so both freshness paths
 * consume the SAME primitive.
 *
 * W1-T151 (installFreshness): moved out of run-task.ts to make the same hash
 * available to `src/lib/worker.ts`'s W1-T2777 comparison at
 * {@link linkWorktreeNodeModules} without pulling worker.ts into the run-task
 * import graph. The `src/lib/*` → `src/run-task.ts` direction is the wrong one
 * (worker.ts is imported by run-task.ts, not vice versa), and duplicating this
 * function into worker.ts would create two independent hashes on the same
 * inputs — the exact class of drift silently-worse than sharing truth.
 *
 * `run-task.ts` re-exports the two symbols so every existing caller keeps its
 * import path unchanged; no test needs an import rewrite for the move alone.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * W1-T151 INSTALL FRESHNESS: sha256 of `package.json` + `package-lock.json` content
 * (order-stable, null-separated) — a workspaces field added to `package.json` with no
 * `package-lock.json` change (or vice versa) still moves this hash, so the fixture task
 * exists for ("the workspace conversion that broke operator builds while CI stayed
 * green") is caught either way. A missing file hashes as empty content rather than
 * throwing — deterministic either way, never a crash on a repo with no lockfile yet.
 * This is a change-detector, not a security digest — collision resistance beyond
 * "npm's own two source files changed" is not the property being relied on.
 */
export function hashInstallInputs(
  repoDir: string,
  deps: { readFile?: (p: string) => string } = {},
): string {
  const readFile = deps.readFile ?? ((p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      // Missing/unreadable file hashes as empty content — the function's contract
      // says "deterministic either way, never a crash on a repo with no lockfile yet".
      return "";
    }
  });
  const pkg = readFile(join(repoDir, "package.json"));
  const lock = readFile(join(repoDir, "package-lock.json"));
  return createHash("sha256").update(pkg).update("\0").update(lock).digest("hex");
}

/** Where the last-successful-install hash is persisted — inside `node_modules` itself
 * (never committed, and naturally invalidated if `node_modules` is ever wiped wholesale). */
export function installHashMarkerPath(repoDir: string): string {
  return join(repoDir, "node_modules", ".rmd-install-hash");
}
