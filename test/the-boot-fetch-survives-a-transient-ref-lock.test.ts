import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "entrypoint.sh");

/**
 * W1-T2501: THE BOOT FETCH USED TO BE ATTEMPTED EXACTLY ONCE. MEASURED
 * (operator-log#cannot-lock-ref-2026-08-30): a boot fetch failed to lock THREE refs in one call —
 * `refs/remotes/origin/main`, `heartbeat-mini` and a feature branch — the signature of another git
 * process transiently holding them, not of corruption. The old entrypoint logged one line
 * ("fetch FAILED — continuing on the tree as it stands") and carried on: the daemon booted on the
 * stale tree that produced, and the advisory id mint two commands later read a corpus four ids
 * behind.
 *
 * `deploy/entrypoint.sh` now retries the boot fetch, but ONLY when the failure is a ref lock
 * (`cannot lock ref` / `unable to update local ref`) — never on failure generally, so a network or
 * auth failure still fails open after one attempt, exactly as before. The retry is bounded
 * (`RMD_FETCH_LOCK_RETRY_MAX`, default 5) and an exhausted retry still starts the daemon, now named
 * a "STALE BOOT" in the log rather than left as one line among many.
 *
 * REAL GIT FOR EVERYTHING EXCEPT THE FAILURE INJECTION — same rationale as
 * test/entrypoint-boot.test.ts: this suite is a statement about the entrypoint's OWN retry/backoff
 * logic, not about git's locking internals (which are an inherently racy thing to reproduce on
 * demand). The `git` on PATH here is a thin wrapper that intercepts only a `fetch` invocation, to
 * simulate the measured `cannot lock ref` failure a chosen number of times, and forwards every
 * other invocation — clone, checkout, config, status, worktree, rev-parse, ls-files, hash-object,
 * cat-file — straight to the REAL git untouched. A stub that modeled git's locking behaviour itself
 * could not discover a regression in it; this only ever fakes the ONE failure this change reacts to.
 */

const REAL_GIT = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

interface Boot {
  status: number;
  stdout: string;
  stderr: string;
  /** number of times the wrapped `git ... fetch ...` actually ran (real or faked). */
  fetchCalls: number;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync(REAL_GIT, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

function commit(cwd: string, message: string): string {
  spawnSync(REAL_GIT, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd },
  });
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** A git origin with one commit, plus the package files a real clone would carry. */
function makeOrigin(): string {
  const origin = mkdtempSync(join(tmpdir(), "boot-fetch-origin-"));
  git(origin, ["init", "-q", "-b", "main"]);
  writeFileSync(join(origin, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(join(origin, "first.txt"), "one\n");
  git(origin, ["add", "-A"]);
  commit(origin, "c1");
  return origin;
}

/** Add a commit to the origin that creates `file`, and return the new sha. */
function advanceOrigin(origin: string, file: string, body: string): string {
  writeFileSync(join(origin, file), body);
  git(origin, ["add", "-A"]);
  return commit(origin, `add ${file}`);
}

const treeOf = (home: string) => join(home, "Remudero", "remudero");
const headOf = (home: string) => git(treeOf(home), ["rev-parse", "HEAD"]);
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "boot-fetch-home-"));
}

/** The `npm` stub: records nothing interesting here, only creates the artefact the install-skip
 * condition looks for so a real, multi-minute `npm ci` is never invoked. */
function writeNpmStub(dir: string): void {
  const npm = [
    "#!/usr/bin/env bash",
    'if [ "$1" = "ci" ]; then mkdir -p node_modules/.bin; printf "#!/bin/sh\\n" > node_modules/.bin/tsx; chmod 0755 node_modules/.bin/tsx; fi',
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "npm"), npm, { mode: 0o755 });
  chmodSync(join(dir, "npm"), 0o755);
}

interface GitFetchStubOpts {
  /** fail with a "cannot lock ref" error this many times, then let the real fetch through. */
  failLockTimes?: number;
  /** fail with a "cannot lock ref" error on EVERY call — the lock never clears. */
  alwaysFailLock?: boolean;
  /** fail with an unrelated (non-lock) error on every call — e.g. network/auth. */
  alwaysFailNonLock?: boolean;
}

/**
 * A `git` wrapper that intercepts ONLY an invocation carrying the literal argument `fetch`
 * (`deploy/entrypoint.sh` always calls it as `git -C "$TREE" fetch --prune origin`) and forwards
 * every other invocation straight to the real git. Each intercepted fetch call is counted in
 * `<rec>/fetch-calls`, so a test can assert exactly how many attempts the entrypoint made.
 */
function writeGitFetchStub(dir: string, rec: string, opts: GitFetchStubOpts): void {
  const lockError =
    "error: cannot lock ref 'refs/remotes/origin/main': is at 0000000000000000000000000000000000000000 but expected 1111111111111111111111111111111111111111\nerror: some local refs could not be updated";
  const nonLockError = "fatal: unable to access 'https://example.invalid/repo.git/': Could not resolve host: example.invalid";
  const failTimes = opts.failLockTimes ?? 0;
  const failBranch = opts.alwaysFailNonLock
    ? `printf '%s\\n' "${nonLockError}" >&2\n    exit 128`
    : opts.alwaysFailLock
      ? `printf '%s\\n' "${lockError}" >&2\n    exit 128`
      : `if [ "$n" -le ${failTimes} ]; then printf '%s\\n' "${lockError}" >&2; exit 128; fi`;
  const body = [
    "#!/usr/bin/env bash",
    "is_fetch=0",
    'for a in "$@"; do if [ "$a" = "fetch" ]; then is_fetch=1; fi; done',
    'if [ "$is_fetch" = "1" ]; then',
    `  n=$(cat "${rec}/fetch-calls" 2>/dev/null || echo 0)`,
    "  n=$((n+1))",
    `  printf '%s\\n' "$n" > "${rec}/fetch-calls"`,
    `  ${failBranch}`,
    "fi",
    `exec "${REAL_GIT}" "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(dir, "git"), body, { mode: 0o755 });
  chmodSync(join(dir, "git"), 0o755);
}

/** Boot the real entrypoint against `home`, which persists across calls so a SECOND boot sees the
 * tree the first one left — exactly like test/entrypoint-boot.test.ts's own `boot`. */
function boot(
  home: string,
  origin: string,
  opts: { git?: GitFetchStubOpts; env?: Record<string, string>; script?: string } = {},
): Boot {
  const stubs = mkdtempSync(join(tmpdir(), "boot-fetch-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "boot-fetch-rec-"));
  writeNpmStub(stubs);
  writeGitFetchStub(stubs, rec, opts.git ?? {});
  const r = spawnSync("bash", [opts.script ?? SCRIPT, "true"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      HOME: home,
      RMD_REPO_URL: origin,
      RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...(opts.env ?? {}),
    },
  });
  let fetchCalls = 0;
  try {
    fetchCalls = Number(readFileSync(join(rec, "fetch-calls"), "utf8").trim()) || 0;
  } catch {
    fetchCalls = 0;
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", fetchCalls };
}

// ── ACCEPTANCE: retried rather than abandoned, and lands on the fetched tip ────────────────────

test("a boot fetch that fails on a transient ref lock is retried rather than abandoned, and lands on the fetched tip", () => {
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin).status, 0, "first boot (clone) must succeed");

  const c2 = advanceOrigin(origin, "second.txt", "two\n");

  const second = boot(home, origin, { git: { failLockTimes: 2 } });
  assert.equal(second.status, 0, `second boot failed: ${second.stderr}`);
  assert.equal(second.fetchCalls, 3, "must retry twice on the lock, then succeed on the third attempt");
  assert.equal(headOf(home), c2, "the retried fetch must still land the boot on the newly fetched tip");
  assert.match(second.stderr, /another process holds a ref lock \(attempt 1\/5\)/);
  assert.match(second.stderr, /another process holds a ref lock \(attempt 2\/5\)/);
  assert.match(second.stderr, /fetch: succeeded on retry 3\/5 — the ref lock cleared/);
  assert.doesNotMatch(second.stderr, /STALE BOOT/, "a fetch that eventually succeeds must never be reported stale");
});

// ── ACCEPTANCE: a fetch that succeeds on retry leaves the boot otherwise byte-identical ────────

test("a fetch that succeeds on retry leaves the rest of the boot exactly as an ordinary clean boot", () => {
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin).status, 0);
  const c2 = advanceOrigin(origin, "second.txt", "two\n");

  const clean = boot(freshHome(), origin, {});
  const retried = boot(home, origin, { git: { failLockTimes: 1 } });

  assert.equal(retried.status, 0, `retried boot failed: ${retried.stderr}`);
  // Same shape of "checkout:" announcement, same absence of REFUSING/STALE — the retry changes
  // nothing downstream of the fetch succeeding.
  assert.match(retried.stderr, /checkout: [0-9a-f]{40} \(main\)/);
  assert.match(clean.stderr, /checkout: [0-9a-f]{40} \(main\)/);
  assert.doesNotMatch(retried.stderr, /REFUSING to sync/);
  assert.doesNotMatch(clean.stderr, /REFUSING to sync/);
  assert.equal(headOf(home), c2, "the retried boot lands on the same tip a clean fetch would have");
});

// ── ACCEPTANCE: a failure that is not a ref lock is not retried ────────────────────────────────

test("a failure that is not a ref lock is not retried, and keeps today's single-attempt fail-open message", () => {
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin).status, 0);
  const before = headOf(home);
  advanceOrigin(origin, "second.txt", "two\n");

  const second = boot(home, origin, { git: { alwaysFailNonLock: true } });
  assert.equal(second.status, 0, "a non-lock fetch failure must still fail OPEN");
  assert.equal(second.fetchCalls, 1, "a non-lock failure must not be retried");
  assert.match(second.stderr, /fetch FAILED — continuing on the tree as it stands/);
  assert.doesNotMatch(second.stderr, /ref lock/, "a non-lock failure must never be described as a lock");
  assert.doesNotMatch(second.stderr, /STALE BOOT/, "one failed attempt is not an exhausted retry");
  assert.equal(headOf(home), before, "nothing was fetched, so HEAD must be unchanged");
});

// ── ACCEPTANCE: bounded retries, fail-open survives, and a NAMED stale boot ─────────────────────

test("retries are bounded, an exhausted retry still starts the daemon, and it is reported as a NAMED stale boot", () => {
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin).status, 0);

  const second = boot(home, origin, {
    git: { alwaysFailLock: true },
    env: { RMD_FETCH_LOCK_RETRY_MAX: "3", RMD_FETCH_LOCK_RETRY_PAUSE_S: "0" },
  });
  assert.equal(second.status, 0, "an exhausted retry must still start the daemon rather than refusing the boot");
  assert.equal(second.fetchCalls, 3, "retries must be bounded to the configured max, never unlimited");
  assert.match(second.stderr, /another process holds a ref lock \(attempt 1\/3\)/);
  assert.match(second.stderr, /another process holds a ref lock \(attempt 2\/3\)/);
  assert.doesNotMatch(second.stderr, /attempt 3\/3\) — retrying/, "the LAST attempt must not announce a retry that never happens");
  assert.match(
    second.stderr,
    /STALE BOOT: fetch FAILED after 3 attempt\(s\), still ref-locked — continuing on the tree as it stands/,
    "an exhausted retry must be named, not one log line among many",
  );
});

// ── ACCEPTANCE: a successful first fetch makes no additional call ──────────────────────────────

test("a successful first fetch makes no additional call", () => {
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin).status, 0);
  advanceOrigin(origin, "second.txt", "two\n");

  const second = boot(home, origin, { git: {} });
  assert.equal(second.status, 0, `second boot failed: ${second.stderr}`);
  assert.equal(second.fetchCalls, 1, "a first-try success must make exactly one fetch call");
  assert.doesNotMatch(second.stderr, /retrying in/);
  assert.doesNotMatch(second.stderr, /succeeded on retry/);
  assert.doesNotMatch(second.stderr, /STALE BOOT/);
});

// ── ACCEPTANCE: removing the retry restores the single-attempt behaviour and fails the lock case ─

function mutate(find: string, replace: string): string {
  const src = readFileSync(SCRIPT, "utf8");
  assert.equal(src.split(find).length - 1, 1, `the mutation target must be unique: ${JSON.stringify(find)}`);
  const dir = mkdtempSync(join(tmpdir(), "boot-fetch-mutant-"));
  const p = join(dir, "entrypoint.sh");
  writeFileSync(p, src.replace(find, replace), { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

test("MUTANT: forcing the retry budget back to 1 restores the single-attempt behaviour and fails the lock case", () => {
  // THE NON-VACUITY CHECK for every assertion above: with the retry mechanically disabled (bounded
  // to exactly one attempt), the measured defect must reproduce — a lock that would have cleared on
  // a second try instead abandons the fetch, and the boot proceeds on the stale tree.
  const mutant = mutate(
    'FETCH_LOCK_RETRY_MAX="${RMD_FETCH_LOCK_RETRY_MAX:-5}"',
    'FETCH_LOCK_RETRY_MAX="${RMD_FETCH_LOCK_RETRY_MAX:-1}"',
  );
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin, { script: mutant }).status, 0);
  const before = headOf(home);
  const c2 = advanceOrigin(origin, "second.txt", "two\n");

  // The lock clears after 2 failures — a real retry lands on c2. Forced to ONE attempt, the mutant
  // must reproduce the original defect instead.
  const second = boot(home, origin, { script: mutant, git: { failLockTimes: 2 } });
  assert.equal(second.status, 0, "still fails open — that half of the behaviour is untouched");
  assert.equal(second.fetchCalls, 1, "the mutant must make exactly one attempt, proving the retry is what is gone");
  assert.equal(headOf(home), before, "the mutant must land on the STALE tree, reproducing the original defect");
  assert.notEqual(headOf(home), c2, "and must NOT reach the tip a real retry would have fetched");
  assert.match(second.stderr, /STALE BOOT: fetch FAILED after 1 attempt\(s\), still ref-locked/);
});
