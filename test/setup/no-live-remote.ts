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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const ghConfigDir = mkdtempSync(join(tmpdir(), "rmd-test-gh-config-"));
  env.GH_CONFIG_DIR = ghConfigDir;
  for (const name of APP_KEY_ENV) delete env[name];
  return { ghConfigDir };
}

const installed = installNoLiveRemote();
if (installed.ghConfigDir !== undefined) {
  const dir = installed.ghConfigDir;
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort — the boot sweep reclaims an `rmd-test-` dir left by a killed process
    }
  });
}
