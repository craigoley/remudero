import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * W1-T1021 IMAGE DRIFT DETECTION — the running container's image can fall arbitrarily far
 * behind `main` and nothing notices. `.github/workflows/acr-build.yml` is `workflow_dispatch:`
 * only (no push trigger), so a merge never rebuilds the image on its own; meanwhile
 * `deploy/entrypoint.sh` resolves `TREE="$CONFIG_ROOT/remudero"`, fetches+checks it out on every
 * boot and `cd`s into it before running `./bin/rmd` — so `src/`, `test/`, `plan/`, `bin/`,
 * `scripts/` AND `node_modules` (bootstrapped by the entrypoint, freshened by
 * `ensureInstallFresh`) are all LIVE off the mount and take effect on the next freshness
 * restart with no rebuild at all.
 *
 * EXACTLY TWO PATHS ARE BAKED, RE-DERIVED FROM `deploy/Dockerfile`'S OWN LINES, NOT ASSUMED:
 * `COPY --chown=node:node deploy/entrypoint.sh /usr/local/bin/rmd-entrypoint` is what
 * `ENTRYPOINT` actually execs (never the mount's copy), and the Dockerfile's own apt
 * installs/`ARG`s/base image are baked with it. A `COPY . .` snapshot also lands at `/app`, but
 * the entrypoint `cd`s away from it before running anything, so it is inert rather than
 * authoritative. A change under `src/` (or anywhere outside these two paths) MUST NOT trigger
 * this detector — see {@link BAKED_PATHS}.
 *
 * THE COMPARISON INPUT ALREADY EXISTS AND NEEDS NO NEW PLUMBING. `deploy/Dockerfile`'s
 * `ARG RMD_BUILD_SHA=unknown` / `RUN printf '%s\n' "${RMD_BUILD_SHA}" > /etc/rmd-build-sha &&
 * chmod 0444 /etc/rmd-build-sha` stamps the commit `acr-build.yml` built FROM (it passes
 * `--build-arg "RMD_BUILD_SHA=${GITHUB_SHA}"`), readable with a plain `readFileSync` from inside
 * the running container — no Docker socket, no `docker exec`, no runtime query (that class of
 * read is `scripts/fleet-heartbeat.sh`'s job, from the HOST; this module runs INSIDE, where the
 * stamp is an ordinary 0444 file). {@link checkImageDrift} is therefore the whole gap: nothing
 * else in this tree ever joined the stamp to the baked paths' own git history.
 *
 * THREE DEGRADED CASES, each a real outcome rather than a guessed drift:
 *   - The stamp file is ABSENT off-container (a plain dev checkout, no `/etc/rmd-build-sha` at
 *     all) → {@link ImageDriftFinding} `"not-applicable"`, never drift.
 *   - The stamp is not a git-hex sha — `ARG RMD_BUILD_SHA=unknown`'s own default makes a
 *     hand-built image write the literal string `"unknown"`, and `scripts/fleet-heartbeat.sh`
 *     already guards the identical case with `*[!0-9a-fA-F]*` — → `"unmeasurable"`, never drift.
 *   - The stamp names a commit this checkout's local git history cannot resolve (a shallow
 *     clone, a rewritten history) → `"unmeasurable"` for the same reason: a detector that
 *     reports drift on any of these three would fire on every developer machine.
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

/** The exactly-two paths COPY'd into the image at build time — re-derived from
 *  `deploy/Dockerfile`'s own `COPY --chown=node:node deploy/entrypoint.sh …` /
 *  `ENTRYPOINT […, "/usr/local/bin/rmd-entrypoint"]` lines and its own apt/`ARG` layers. Every
 *  other path (`src/`, `test/`, `plan/`, `bin/`, `scripts/`, `node_modules`) is served LIVE from
 *  the entrypoint's own mount-and-checkout, so a change there must never report as image drift. */
export const BAKED_PATHS: readonly string[] = ["deploy/entrypoint.sh", "deploy/Dockerfile"];

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
