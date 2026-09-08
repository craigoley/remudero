/**
 * test/helpers/git-repo.ts — W1-T2903: the shared git-repository fixture.
 *
 * WHY THIS EXISTS. Audit recon-2026-09-05 R-41 counted 62 distinct repo-builder function names
 * across `test/*.test.ts` (`git grep -hoE 'function [a-zA-Z]*(Repo|Checkout|Clone|Worktree|
 * Bare)[A-Za-z]*\(' -- 'test/*.test.ts' | sort -u | wc -l`) and 218 raw `git init` sites in 130
 * files — every one of them a hand-rolled copy of the same three steps (mkdtemp, `git init`, set
 * an identity). CLAUDE.md's own ledger records the cost: a fixture that shells git PLUMBING
 * without an explicit identity "fails on every CI runner and passes on every dev machine" (#1971,
 * after #1964 failed the SAME way) — `actions/checkout` configures neither repo nor global
 * `user.name`/`user.email`, and `commit-tree`/`commit` refuse with "Author identity unknown"
 * without one. That fix had to be found TWICE because there was no one fixture to fix it in.
 *
 * This module is that one fixture. Every repo it builds carries its own identity
 * ({@link GIT_REPO_FIXTURE_IDENTITY}) on every git invocation it makes, so it depends on nothing
 * the checkout happens to have configured — reproduced against the stripped-CI condition CLAUDE.md
 * names (`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`, repo `user.email`/`user.name`
 * unset) in test/helpers/git-repo.test.ts.
 *
 * TMP HYGIENE, TWO LAYERS. test/setup/tmp-hygiene.ts (loaded on every `npm test`/`npm run
 * test:ci` invocation) monkeypatches `node:fs`'s `mkdtempSync` process-wide: every dir it creates
 * is recorded and removed in a `process.on("exit")` handler, and any BARE prefix is normalized so
 * `src/lib/tmp.ts`'s production boot sweep can also reclaim it if the process is killed before
 * that handler runs. That layer is a backstop for existing bare-prefix call sites, not a licence
 * for a new one: `scripts/mkdtemp-callsite-check.mjs` (a pre-commit gate, W1-T2773) statically
 * refuses a NEW `mkdtempSync` callsite whose prefix does not itself start `rmd-` — it cannot see
 * the runtime monkeypatch, only the source. This fixture therefore prefixes with
 * {@link RMD_TMP_PREFIX} directly, satisfying the static gate on its own terms and needing the
 * runtime shim only as the same backstop every other call site already has. A fixture-local
 * `try/finally` would only ever duplicate the exit-handler sweep, so this fixture does not carry
 * one — `cleanup()` is offered for a caller that wants its dir gone mid-test, never required for
 * correctness.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "../../src/lib/tmp.js";

/**
 * The fixture's OWN committer — never one borrowed from the host or CI runner. Exported so a
 * caller that asserts authorship (the way test/lint-plan-broken-base.test.ts's own regression
 * pin does, W1-T2903 origin #1971) does not have to duplicate the literal.
 */
export const GIT_REPO_FIXTURE_IDENTITY = {
  name: "remudero test fixture",
  email: "fixture@remudero.invalid",
};

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
};

export interface GitRepoOpts {
  /** Create a `--bare` repository instead of a normal working tree. Default false. */
  bare?: boolean;
  /** Initial branch name. Default "main". */
  branch?: string;
  /** Seed one commit (an empty `README.md`) once the repo exists. Ignored for `bare: true`
   *  (nothing to commit into). Default true for a non-bare repo, so the common case — "give me
   *  a repo with a HEAD" — needs no opts at all. */
  seedCommit?: boolean;
  /** `git clone` this path/url instead of `git init` — the shape a working checkout of a bare
   *  origin needs. Mutually exclusive with `bare`/`seedCommit`, which are ignored when set. */
  cloneFrom?: string;
  /** `mkdtempSync` prefix. Cosmetic only (distinguishes fixtures in a directory listing);
   *  default "git-repo". */
  kind?: string;
}

export interface GitRepo {
  /** Absolute path to the repository's working (or bare) directory. */
  readonly dir: string;
  /** Run `git` inside this repo with the fixture's OWN identity env, never the host's. Returns
   *  trimmed stdout. */
  git(...args: string[]): string;
  /** `git remote add name url` — the "remote" shape (typically another {@link GitRepo}'s
   *  `.dir`, or a `bare: true` repo's). */
  addRemote(name: string, url: string): void;
  /** `git worktree add` a new worktree at `path` on `branch` (created from `base`, default
   *  `HEAD`) — the "worktree" shape. Returns a {@link GitRepo} handle over the new worktree,
   *  sharing this fixture's identity. */
  addWorktree(path: string, branch: string, base?: string): GitRepo;
  /** Remove the repository directory now, rather than waiting for the suite's own tmp-hygiene
   *  sweep (see the module doc) — never required, only useful for a test that wants the dir gone
   *  before it ends. Best-effort; safe to call twice. */
  cleanup(): void;
}

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

function wrap(dir: string): GitRepo {
  return {
    dir,
    git: (...args: string[]) => runGit(dir, args),
    addRemote(name: string, url: string): void {
      runGit(dir, ["remote", "add", name, url]);
    },
    addWorktree(path: string, branch: string, base = "HEAD"): GitRepo {
      runGit(dir, ["worktree", "add", "-b", branch, path, base]);
      return wrap(path);
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Build a throwaway git repository. Bare, worktree and remote shapes are all reachable off the
 * one returned handle — see {@link GitRepoOpts.bare}, {@link GitRepo.addWorktree} and
 * {@link GitRepo.addRemote} — so a caller needing any combination of them still starts from this
 * single function.
 */
export function gitRepo(opts: GitRepoOpts = {}): GitRepo {
  const { bare = false, branch = "main", seedCommit = !bare, kind = "git-repo", cloneFrom } = opts;
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-`));
  if (cloneFrom !== undefined) {
    execFileSync("git", ["clone", "--quiet", cloneFrom, dir], { encoding: "utf8", env: GIT_ENV });
  } else {
    runGit(dir, bare ? ["init", "--quiet", "--bare", "-b", branch] : ["init", "--quiet", "-b", branch]);
  }
  const repo = wrap(dir);
  if (seedCommit && !bare && cloneFrom === undefined) {
    execFileSync("git", ["-C", dir, "commit", "--quiet", "--allow-empty", "-m", "initial commit"], {
      encoding: "utf8",
      env: GIT_ENV,
    });
  }
  return repo;
}
