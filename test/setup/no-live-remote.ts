/**
 * test/setup/no-live-remote.ts — W1-T4805: LIVE REMOTE WRITES ARE IMPOSSIBLE FOR THE WHOLE TEST
 * PROCESS, not refused one call site at a time.
 *
 * INCIDENT (2026-09-29): the test "daemonCommand: builds the real daemon deps … present STOP"
 * (test/run-task.test.ts) boots the real daemon; the daemon's plan gardener pushed a real
 * `plan-garden-*` branch to the live repo on every suite run — 103 branches. The per-call fence
 * (src/lib/live-write-guard.ts `assertLiveWriteAllowed`) fired only AFTER the push. Earlier:
 * recon-AQ (#6949) — a test that paused the LIVE fleet. The guard "checks the CALL, not the
 * DESTINATION", so every new write path is unguarded until someone adds a fence; meanwhile the
 * test process holds everything a live write needs.
 *
 * This module takes those things away, at process level, when `isTestRunner()` holds:
 *  - git: `url.<dead>.pushInsteadOf` rewrites every github.com push URL form to a dead `file://`
 *    path whose name says why, so a raw `git push` fails loudly with no network. A local bare
 *    fixture (test/helpers/git-repo.ts `gitRepo({ bare: true })`) is a plain path and is untouched.
 *  - gh: GH_TOKEN and GITHUB_TOKEN become {@link LIVE_WRITE_SENTINEL_TOKEN}, which the transport
 *    (src/lib/github-transport.ts) refuses before spawning gh; GH_CONFIG_DIR points at an empty
 *    per-process dir so the operator's keyring login is unreachable.
 *  - App: GH_APP_PRIVATE_KEY_PATH / GH_APP_ID / GH_APP_INSTALLATION_ID are removed.
 * Children inherit all of it (a booted daemon, a spawned `bin/rmd`, a raw `git push`).
 * `RMD_ALLOW_LIVE_WRITES=1` stays the one whole-process opt-out.
 *
 * Imported FIRST by test/setup/tmp-hygiene.ts, which every runner invocation already `--import`s.
 */
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, systemClock } from "../../src/lib/clock.js";
import { discoverLiveLedgerRoot, isTestRunner, LIVE_LEDGER_DENY_ROOT_ENV, LIVE_WRITE_OVERRIDE_ENV,
  LIVE_WRITE_SENTINEL_TOKEN } from "../../src/lib/live-write-guard.js";

/** Where every rewritten github.com push URL lands. It does not exist; its NAME is the message. */
export const DEAD_PUSH_ROOT = "file:///nonexistent/W1-T4805-live-github-push-blocked-by-the-test-suite/";

/** The github.com push URL forms the rewrite covers. */
export const GITHUB_PUSH_PREFIXES: readonly string[] = ["https://github.com/", "git@github.com:", "ssh://git@github.com/"];

/** The GitHub App credentials removed from a test process. */
export const APP_KEY_ENV: readonly string[] = ["GH_APP_PRIVATE_KEY_PATH", "GH_APP_ID", "GH_APP_INSTALLATION_ID"];

/** Append one entry to git's `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` env config,
 *  preserving whatever is already there. */
export function appendGitConfigEnv(key: string, value: string, env: NodeJS.ProcessEnv = process.env): void {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const at = Number.isInteger(n) && n > 0 ? n : 0;
  env[`GIT_CONFIG_KEY_${at}`] = key;
  env[`GIT_CONFIG_VALUE_${at}`] = value;
  env.GIT_CONFIG_COUNT = String(at + 1);
}

/** Apply the containment to `env`. Exported so a test can drive it against a scratch env. */
export function installNoLiveRemote(env: NodeJS.ProcessEnv = process.env): { ghConfigDir?: string } {
  if (!isTestRunner(env)) return {};
  if (env[LIVE_WRITE_OVERRIDE_ENV] === "1") return {};
  env[LIVE_LEDGER_DENY_ROOT_ENV] = discoverLiveLedgerRoot(env);
  for (const prefix of GITHUB_PUSH_PREFIXES) appendGitConfigEnv(`url.${DEAD_PUSH_ROOT}.pushInsteadOf`, prefix, env);
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_TOKEN = LIVE_WRITE_SENTINEL_TOKEN;
  env.GITHUB_TOKEN = LIVE_WRITE_SENTINEL_TOKEN;
  // W1-T5550: the owning pid is in the name, so a later process can tell this dir's owner is gone.
  const ghConfigDir = mkdtempSync(join(tmpdir(), `rmd-test-gh-config-${process.pid}-`));
  env.GH_CONFIG_DIR = ghConfigDir;
  for (const name of APP_KEY_ENV) delete env[name];
  return { ghConfigDir };
}

/**
 * W1-T5550 — A SIGKILLED TEST PROCESS LEAVES ITS SETUP DIRS BEHIND, SO THE NEXT ONE REMOVES THEM.
 *
 * The `process.on("exit")` handlers below and in ./tmp-hygiene.ts are the fast path. A SIGKILL skips
 * them, and the `rmd-` boot sweep (`sweepStaleTempDirs`) only scans the daemon's own `os.tmpdir()`,
 * so a test run whose TMPDIR is elsewhere (/mnt/scratch) was never swept: 32+ refuse and 28+ config
 * dirs sat there at filing. Each setup dir now carries its owner's pid (`<prefix><pid>-<random>`),
 * and every test process that loads the setup removes the same-prefix dirs under its own tmpdir
 * whose owner is not alive and which are older than {@link DEAD_OWNER_MIN_AGE_MS}.
 */
export const GH_CONFIG_DIR_PREFIX = "rmd-test-gh-config-";

/** A dead owner's dir younger than this is kept. The age is a second guard beside the pid: a pid
 *  that reads dead from here can belong to a live process in another pid namespace sharing tmp. */
export const DEAD_OWNER_MIN_AGE_MS = 60_000;

/** Why {@link reapDeadOwnerDirs} kept a dir it matched. */
export type DeadOwnerKeepReason = "alive" | "fresh" | "not-removable";

export interface DeadOwnerReap {
  removed: string[];
  kept: Array<{ name: string; reason: DeadOwnerKeepReason }>;
}

export interface DeadOwnerReapDeps {
  /** The directory scanned; default `os.tmpdir()`. */
  root?: string;
  clock?: Clock;
  isAlive?: (pid: number) => boolean;
  minAgeMs?: number;
}

/** `process.kill(pid, 0)` sends nothing; it only asks whether the pid exists. ESRCH is the one
 *  answer that means "gone"; EPERM means the process exists under another user, so it is alive. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove every `<prefix><pid>-*` directory under `root` whose owning pid is not alive and whose
 *  mtime is at least `minAgeMs` old. A name without a pid (made before W1-T5550) is not matched. */
export function reapDeadOwnerDirs(prefix: string, deps: DeadOwnerReapDeps = {}): DeadOwnerReap {
  const root = deps.root ?? tmpdir();
  const clock = deps.clock ?? systemClock;
  const isAlive = deps.isAlive ?? pidIsAlive;
  const minAgeMs = deps.minAgeMs ?? DEAD_OWNER_MIN_AGE_MS;
  const owned = new RegExp(`^${escapeRegExp(prefix)}(\\d+)-`);
  const result: DeadOwnerReap = { removed: [], kept: [] };
  for (const name of readdirSync(root)) {
    const match = owned.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isAlive(pid)) {
      result.kept.push({ name, reason: "alive" });
      continue;
    }
    const full = join(root, name);
    let stat;
    try {
      stat = lstatSync(full);
    } catch (error) {
      // Another loader's reap removed it between readdir and here: nothing left to judge.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory()) continue;
    if (clock.now() - stat.mtimeMs < minAgeMs) {
      result.kept.push({ name, reason: "fresh" });
      continue;
    }
    try {
      rmSync(full, { recursive: true, force: true });
      result.removed.push(name);
    } catch (error) {
      // A sticky shared tmp refuses another user's dir; that dir is theirs to reap, not ours.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw error;
      result.kept.push({ name, reason: "not-removable" });
    }
  }
  return result;
}

const installed = installNoLiveRemote();
if (installed.ghConfigDir !== undefined) {
  const dir = installed.ghConfigDir;
  reapDeadOwnerDirs(GH_CONFIG_DIR_PREFIX);
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort — the boot sweep reclaims an `rmd-test-` dir left by a killed process
    }
  });
}
