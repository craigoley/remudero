/**
 * test/setup/no-live-remote.ts — process-wide containment for live remote and state writes.
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
 *  - filesystem (W1-T4923): remember the original config root without creating a config, then
 *    redirect HOME to a per-process fixture config/root. appendLedger refuses the remembered root.
 * Children inherit all of it (a booted daemon, a spawned `bin/rmd`, a raw `git push`).
 * `RMD_ALLOW_LIVE_WRITES=1` stays the one whole-process opt-out.
 *
 * Imported FIRST by test/setup/tmp-hygiene.ts, which every runner invocation already `--import`s.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isTestRunner, LIVE_WRITE_OVERRIDE_ENV, LIVE_WRITE_SENTINEL_TOKEN, TEST_LIVE_STATE_ROOT_ENV } from "../../src/lib/live-write-guard.js";

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
function originalStateRoot(home: string): string {
  const fallback = join(home, "Remudero");
  const configPath = join(home, ".config", "remudero", "config.json");
  if (!existsSync(configPath)) return fallback;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { root?: unknown };
    return typeof config.root === "string" && config.root.length > 0 ? resolve(config.root) : fallback;
  } catch {
    // A missing or unreadable config cannot be used to locate the live root; HOME is still
    // redirected below, and the conventional default root remains denied.
    return fallback;
  }
}

export function installNoLiveRemote(env: NodeJS.ProcessEnv = process.env): { ghConfigDir?: string; fixtureHome?: string } {
  if (!isTestRunner(env)) return {};
  if (env[LIVE_WRITE_OVERRIDE_ENV] === "1") return {};
  const liveRoot = env[TEST_LIVE_STATE_ROOT_ENV] ?? originalStateRoot(env.HOME ?? homedir());
  env[TEST_LIVE_STATE_ROOT_ENV] = liveRoot;
  const fixtureHome = mkdtempSync(join(tmpdir(), "rmd-test-home-"));
  const fixtureRoot = join(fixtureHome, "root");
  const fixtureConfigDir = join(fixtureHome, ".config", "remudero");
  mkdirSync(fixtureConfigDir, { recursive: true });
  writeFileSync(join(fixtureConfigDir, "config.json"), JSON.stringify({ root: fixtureRoot, claudeBin: process.execPath }));
  utimesSync(fixtureHome, new Date(), new Date());
  env.HOME = fixtureHome;
  for (const prefix of GITHUB_PUSH_PREFIXES) appendGitConfigEnv(`url.${DEAD_PUSH_ROOT}.pushInsteadOf`, prefix, env);
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_TOKEN = LIVE_WRITE_SENTINEL_TOKEN;
  env.GITHUB_TOKEN = LIVE_WRITE_SENTINEL_TOKEN;
  const ghConfigDir = mkdtempSync(join(tmpdir(), "rmd-test-gh-config-"));
  utimesSync(ghConfigDir, new Date(), new Date());
  env.GH_CONFIG_DIR = ghConfigDir;
  for (const name of APP_KEY_ENV) delete env[name];
  return { ghConfigDir, fixtureHome };
}

const installed = installNoLiveRemote();
if (installed.ghConfigDir !== undefined && installed.fixtureHome !== undefined) {
  const dirs = [installed.ghConfigDir, installed.fixtureHome];
  process.on("exit", () => {
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort — the boot sweep reclaims an `rmd-test-` dir left by a killed process
      }
    }
  });
}
