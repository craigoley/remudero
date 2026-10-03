import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BAKED_RUNTIME_SOURCE_PATHS } from "./baked-runtime-inputs.js";

/**
 * Compare the image build stamp with paths that execute from the image. The entrypoint and image
 * layers are baked, as is the serve supervisor launched from /app. Serve generations and workers
 * execute from mounted checkouts. The supervisor's runtime import closure is checked separately
 * so its dependencies cannot silently fall out of the build and drift catalogs.
 * An absent stamp is not applicable; an invalid stamp or unavailable history remains unmeasurable.
 */

/**
 * The ledger step {@link checkImageDrift}'s DRIFT finding is emitted under — same
 * "small module owns its step constant" precedent `src/lib/cost-anomaly.ts`'s
 * `COST_ANOMALY_STEP` sets, imported by both the emitter (`serviceFreshnessGate`,
 * `src/run-task.ts`, beside `daemon.tree_dirty`/`daemon.stale_code`) and the reader
 * (`deriveNeedsMe`, `src/lib/status-board.ts`).
 */
export const IMAGE_DRIFT_STEP = "daemon.image_drift";

// RENDER-RELEVANT, NOT DECISION-RELEVANT — a categorization, not a `src/lib/ledger.ts` edit.
// Nothing in this codebase re-reads a `daemon.image_drift` row to decide anything: a fresh
// `checkImageDrift` call re-derives the same finding from git history on every boot, so this
// step needs no place in `DECISION_RELEVANT_LEDGER_STEPS` (the never-rotated core) — it is
// operator-visible HISTORY, the same role `daemon.headroom`/`console.kick_refused` hold in
// `RENDER_RELEVANT_LEDGER_STEPS`. Deliberately not added there either, on the EXACT precedent
// `COST_ANOMALY_STEP` (`src/lib/cost-anomaly.ts`) already sets: that sibling row is read by this
// same `deriveNeedsMe` clause and was never registered in either ledger.ts set — `ledger.ts` is
// not among this task's declared files, and widening an undeclared shared module is out of this
// one concern's scope, not an oversight.

/** Entrypoint/image layers and the source imported by the image-resident supervisor. */
export const BAKED_PATHS: readonly string[] = ["deploy/entrypoint.sh", "deploy/Dockerfile", ...BAKED_RUNTIME_SOURCE_PATHS];

/** Where `deploy/Dockerfile` stamps the build sha (`RUN printf '%s\n' "${RMD_BUILD_SHA}" >
 *  /etc/rmd-build-sha && chmod 0444 /etc/rmd-build-sha`) — a plain 0444 file inside the image,
 *  never a runtime/Docker query. */
export const DEFAULT_BUILD_SHA_STAMP_PATH = "/etc/rmd-build-sha";

/** A build sha is git-hex — same shape `scripts/fleet-heartbeat.sh`'s own guard enforces
 *  (`*[!0-9a-fA-F]*` rejected), so the Dockerfile's `unknown` default (and any other non-hex
 *  stamp) is caught here rather than compared as though it were a real commit. */
const HEX_SHA_RE = /^[0-9a-fA-F]{7,40}$/;

export type ImageDriftFinding =
  /** Off-container: no `/etc/rmd-build-sha` at all. Not-applicable, never drift. */
  | { status: "not-applicable" }
  /** The stamp is present but cannot be measured against git history — a non-hex stamp
   *  (`unknown` included) or a sha this checkout's history cannot resolve. */
  | { status: "unmeasurable"; reason: string }
  /** The image already contains the newest commit to touch either {@link BAKED_PATHS} path. */
  | { status: "fresh"; buildSha: string }
  /** A commit touching {@link BAKED_PATHS} landed AFTER the image's own build sha — the image is
   *  running stale baked bits (entrypoint or Dockerfile-baked binaries) relative to `main`. */
  | { status: "drift"; buildSha: string; bakedSha: string };

export interface ImageDriftDeps {
  /** Reads the build stamp; defaults to a plain `readFileSync` of {@link DEFAULT_BUILD_SHA_STAMP_PATH}
   *  (or `deps.stampPath`). Returns `undefined` when the file is absent (off-container) — never
   *  throws, so a plain dev checkout degrades to `"not-applicable"` rather than an exception. */
  readStamp?: (path: string) => string | undefined;
  /** Injectable git runner — same "array of args in, stdout string out, throws on nonzero" shape
   *  as `src/lib/self-sync.ts`'s own `deps.git`, so a test drives it with a fake instead of a
   *  real checkout. Defaults to `execFileSync("git", ["-C", repoDir, ...args])`. */
  git?: (repoDir: string, args: string[]) => string;
  /** Overrides {@link DEFAULT_BUILD_SHA_STAMP_PATH} — a test seam, never used in production. */
  stampPath?: string;
}

function defaultReadStamp(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function defaultGit(repoDir: string, args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
}

/**
 * The freshness-gate reader named in this task's rationale: compares `/etc/rmd-build-sha`
 * against {@link BAKED_PATHS}'s own git history in `repoDir` and reports one of the four
 * outcomes on {@link ImageDriftFinding}. Pure aside from the injected `readStamp`/`git` seams —
 * no ledger write here; that is {@link IMAGE_DRIFT_STEP}'s caller's job
 * (`serviceFreshnessGate`, `src/run-task.ts`), mirroring `daemon.tree_dirty`/`daemon.stale_code`'s
 * own assess/emit split.
 */
export function checkImageDrift(repoDir: string, deps: ImageDriftDeps = {}): ImageDriftFinding {
  const readStamp = deps.readStamp ?? defaultReadStamp;
  const git = deps.git ?? defaultGit;
  const stampPath = deps.stampPath ?? DEFAULT_BUILD_SHA_STAMP_PATH;

  const raw = readStamp(stampPath);
  if (raw === undefined) return { status: "not-applicable" };
  const buildSha = raw.trim();
  if (!HEX_SHA_RE.test(buildSha)) {
    return {
      status: "unmeasurable",
      reason: `${stampPath} is not a git sha (got ${JSON.stringify(buildSha)}) — an unbuilt-arg image writes the literal "unknown"`,
    };
  }

  // The stamp names a real-looking sha, but this checkout's own history may not carry it
  // (a shallow clone, a rewritten history) — resolve it BEFORE comparing, never assume.
  try {
    git(repoDir, ["cat-file", "-e", `${buildSha}^{commit}`]);
  } catch {
    return {
      status: "unmeasurable",
      reason: `build sha ${buildSha} (from ${stampPath}) is not resolvable in ${repoDir}'s git history`,
    };
  }

  let latestBakedSha: string;
  try {
    latestBakedSha = git(repoDir, ["log", "-1", "--format=%H", "HEAD", "--", ...BAKED_PATHS]).trim();
  } catch {
    return {
      status: "unmeasurable",
      reason: `could not read ${BAKED_PATHS.join(", ")}'s history in ${repoDir}`,
    };
  }
  // Neither baked path has EVER been touched in this checkout's history — nothing to compare
  // the build sha against, so the image cannot be behind them.
  if (!latestBakedSha) return { status: "fresh", buildSha };

  // Is the newest commit to touch a baked path already IN the image's own build sha's history?
  // `git merge-base --is-ancestor <old> <new>` exits 0 when <old> is an ancestor of (or equal
  // to) <new> — exactly "the image's build already contains this baked change".
  try {
    git(repoDir, ["merge-base", "--is-ancestor", latestBakedSha, buildSha]);
    return { status: "fresh", buildSha };
  } catch {
    return { status: "drift", buildSha, bakedSha: latestBakedSha };
  }
}
