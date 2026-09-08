/**
 * ONE GIT SPAWN, USED BY EVERY scripts/*.mjs CALLER.
 *
 * Audit recon-2026-09-05 R-59: git was spawned ~14 different ways across the gate scripts —
 * `spawnSync` and `execFileSync` both in use, `-C <dir>` in some call sites and the `cwd` spawn
 * option in others, `maxBuffer` ranging from node's 1 MiB default up through 16 MiB, 64 MiB and
 * 100 MiB with no shared reasoning for which, and `stdio` shaped differently call to call. Each
 * variant is a place a fix (a bigger buffer for a growing report, a suppressed-stderr mode for a
 * probe that expects to fail) has to be re-applied by hand instead of landing once.
 *
 * IDENTITY-ENV, LIKE test/helpers/git-repo.ts's FIXTURE IDENTITY. A script that spawns git to
 * WRITE (`recovery-drill.mjs`'s throwaway origin/install checkouts are today's only script-side
 * committer) must never depend on the host's ambient `user.name`/`user.email` — unset on a bare CI
 * runner is the exact incident test/helpers/git-repo.ts's module doc archives (#1971, found twice).
 * Every call through {@link git} carries a fixed identity via env, so a commit this module makes
 * never depends on what the checkout happens to have configured. A read-only call (`show`,
 * `ls-files`, `rev-parse`) is unaffected — these vars only matter to `commit`/`tag`.
 *
 * `-C <cwd>`, NEVER THE SPAWN OPTION. Fixed here so the argv this module hands the OS is the
 * complete, loggable command line, matching the majority of the migrated call sites.
 */
import { spawnSync } from "node:child_process";

/** The identity a script-initiated git WRITE carries — distinct from
 *  test/helpers/git-repo.ts's `GIT_REPO_FIXTURE_IDENTITY` (that one is test-only) so a script-made
 *  commit is never mistaken for a test fixture's in a `git log`. */
export const GIT_SCRIPT_IDENTITY = { name: "remudero script", email: "script@remudero.invalid" };

const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: GIT_SCRIPT_IDENTITY.name,
  GIT_AUTHOR_EMAIL: GIT_SCRIPT_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_SCRIPT_IDENTITY.name,
  GIT_COMMITTER_EMAIL: GIT_SCRIPT_IDENTITY.email,
};

/**
 * Spawn `git <args>` against `cwd` (default `process.cwd()`), synchronously. Returns the raw
 * `spawnSync` result (`{ status, stdout, stderr, error }`) — this never throws on a non-zero exit,
 * because several callers (`git ls-remote`, a `git show` of a path that may not exist at a given
 * ref) need to inspect a refusal rather than crash on it. Use {@link gitOrThrow} for the common
 * "throw on failure, give me trimmed stdout" shape instead.
 *
 * `maxBuffer` defaults to 64 MiB (the largest any pre-migration call site asked for) and, like
 * `encoding`/`stdio`/`input`, is overridable per call via `opts`. `env` merges OVER the identity
 * env (never under it) so a caller with a real reason to override the committer still can.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, maxBuffer?: number, encoding?: string, stdio?: unknown, input?: string,
 *   env?: Record<string, string | undefined> }} [opts]
 */
export function git(args, opts = {}) {
  const { cwd = process.cwd(), env, ...spawnOpts } = opts;
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...spawnOpts,
    env: { ...process.env, ...IDENTITY_ENV, ...env },
  });
}

/**
 * {@link git}, but throws a message naming the command and cwd on a spawn error or non-zero exit,
 * and returns TRIMMED stdout on success — the shape most read-only call sites (`git show`,
 * `git rev-parse`, `git ls-files` on a single, newline-joined listing) actually want, one throw
 * site instead of N hand-written ones.
 *
 * @param {string[]} args
 * @param {Parameters<typeof git>[1]} [opts]
 * @returns {string}
 */
export function gitOrThrow(args, opts = {}) {
  const result = git(args, opts);
  const cwd = opts.cwd ?? process.cwd();
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${result.status}): ${result.stderr || ""}`);
  }
  return result.stdout.trim();
}
