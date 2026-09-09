/**
 * W1-T3228 — A ONE-WORD CONFIG FLAG STOPPED THE FLEET FOR 7h32m AND NOTHING COULD REPAIR IT.
 *
 * MEASURED 2026-09-09 on the Azure host. `core.bare=true` was written onto the daemon's checkout
 * at 02:37:36 while the tree itself was untouched: 3,551 index entries, HEAD at a real commit,
 * `git status` clean. git then refused every worktree operation, deploy/entrypoint.sh's checkout
 * failed, it exited 1 — correctly, it must not run on an unverified HEAD — and `rmd daemon` NEVER
 * STARTED. No `remudero-review` was posted for the whole window; they were posted by hand.
 *
 * WHY NOTHING SELF-HEALED, which is the part worth keeping:
 *   - The DAEMON could not, because the daemon is what failed to start. Every self-repair this
 *     system has lives in code the entrypoint gates, so a failure upstream of the entrypoint's
 *     checkout is upstream of all of it.
 *   - The WATCHDOG did fire, exactly as designed (`rmd-fleet-watchdog.timer`, every five minutes,
 *     "revive a daemon docker has given up on"). It revived the container ~90 times into an
 *     identical death. A revive cannot fix the reason a thing dies, and that watchdog carries no
 *     bound on repeating the same one.
 *   - The BEAT could not see it: it reports ledger recency, and a daemon that never boots writes
 *     no ledger line, so recency cannot tell "down" from "quiet".
 *
 * So the repair has to live in the only code that runs — this script — and it must be the narrow
 * one: a directory holding a populated work tree whose own config calls the repo bare is a config
 * contradicting its contents, and exactly one value reconciles them.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = readFileSync(join(REPO_ROOT, "deploy", "entrypoint.sh"), "utf8");

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

/** A real repo with a real work tree, then flagged bare — the exact shape measured on the host. */
function bareFlaggedCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-bare-flag-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { env: GIT_ENV });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", dir, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "chore: seed"], { env: GIT_ENV });
  execFileSync("git", ["-C", dir, "config", "--local", "core.bare", "true"], { env: GIT_ENV });
  return dir;
}

/** The repair, extracted verbatim from the entrypoint so the TEST drives the shipped text. */
function repairSnippet(): string {
  const start = ENTRYPOINT.indexOf('if [ "$(git -C "$TREE" rev-parse --is-bare-repository');
  assert.ok(start > -1, "deploy/entrypoint.sh must carry the bare-flag repair — it is the subject here");
  const end = ENTRYPOINT.indexOf("\n  fi\n", start);
  assert.ok(end > start, "could not delimit the repair block");
  return ENTRYPOINT.slice(start, end + "\n  fi".length);
}

function runRepair(tree: string): { status: number | null; out: string } {
  const script = ['#!/usr/bin/env bash', 'set -u', `TREE="${tree}"`, 'log() { echo "$*"; }', repairSnippet(), ""].join("\n");
  const path = join(mkdtempSync(join(tmpdir(), "rmd-bare-flag-run-")), "run.sh");
  writeFileSync(path, script, { mode: 0o755 });
  const res = spawnSync("bash", [path], { encoding: "utf8", env: GIT_ENV });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const isBare = (dir: string) =>
  execFileSync("git", ["-C", dir, "rev-parse", "--is-bare-repository"], { encoding: "utf8", env: GIT_ENV }).trim();

test("W1-T3228: a work tree flagged bare is REPAIRED, so the checkout below can run at all", () => {
  const tree = bareFlaggedCheckout();
  assert.equal(isBare(tree), "true", "sanity: the fixture must reproduce the measured state");
  assert.throws(
    () => execFileSync("git", ["-C", tree, "rev-parse", "--show-toplevel"], { stdio: "pipe", env: GIT_ENV }),
    "sanity: git must refuse worktree operations here, which is what killed the daemon",
  );

  const { out } = runRepair(tree);

  assert.equal(isBare(tree), "false", "the flag must be cleared — otherwise every checkout below still refuses");
  assert.doesNotThrow(
    () => execFileSync("git", ["-C", tree, "rev-parse", "--show-toplevel"], { stdio: "pipe", env: GIT_ENV }),
    "and git must accept worktree operations again",
  );
  assert.match(out, /REPAIRING: core\.bare=true/, "the repair must be LOUD — a silent one hides a hook still writing the flag");
  assert.match(out, /inheriting GIT_DIR/, "and must name the known cause, or the next reader re-derives it");
});

test("W1-T3228: an ORDINARY checkout is left completely alone — the repair is not a blanket rewrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-bare-flag-ok-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { env: GIT_ENV });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", dir, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "chore: seed"], { env: GIT_ENV });
  const before = readFileSync(join(dir, ".git", "config"), "utf8");

  const { out } = runRepair(dir);

  assert.equal(readFileSync(join(dir, ".git", "config"), "utf8"), before, "a healthy repo's config must be byte-identical");
  assert.doesNotMatch(out, /REPAIRING/, "and nothing may be reported as repaired when nothing was wrong");
});

test("W1-T3228: a genuinely BARE repo — no work tree on disk — is NOT rewritten into one", () => {
  // The direction that makes this narrow rather than reckless. `--is-bare-repository` alone would
  // also be true here, and flipping the flag would corrupt a real bare repo. The second condition
  // is what separates "config contradicts its contents" from "this repo is legitimately bare".
  const dir = mkdtempSync(join(tmpdir(), "rmd-really-bare-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", dir], { env: GIT_ENV });

  const { out } = runRepair(dir);

  assert.equal(isBare(dir), "true", "a real bare repo must stay bare");
  assert.doesNotMatch(out, /REPAIRING/, "and must not be reported as repaired");
});
