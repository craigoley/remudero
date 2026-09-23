/**
 * W1-T4195 — A ROOT-OWNED MUTABLE RUNTIME PATH IS REFUSED AT BOOT, BY NAME.
 *
 * REPORTED TWICE (fb-1789957498656-362d42, fb-1789959757208-462e0b): a host or privileged operation
 * left `state/ledger.ndjson`, or git administration paths under the checkout, owned by root. The
 * container's runtime user then hit EACCES on every `appendLedger` or `git fetch` AFTER the daemon
 * was already admitting work — and nothing in deploy/entrypoint.sh looked before launching it.
 *
 * These tests boot the REAL entrypoint (the pattern of test/entrypoint-boot.test.ts: real git, a
 * fixture HOME, `RMD_*` controls scrubbed) against a fixture tree with ONE path made unwritable, and
 * assert the boot exits non-zero, names that path and its owner, and never runs the command.
 *
 * HOW A PATH IS MADE UNWRITABLE depends on who runs the suite, because root ignores mode bits:
 *   - non-root: `chmod` the path read-only (restored in a `finally` so tmp cleanup still works);
 *     the expected owner is the current user.
 *   - root WITH `setpriv`: the fixture is chowned to `nobody` and the target path chowned back to
 *     root — literally the reported shape — and the entrypoint runs as `nobody`. Expected owner: root.
 *   - root WITHOUT `setpriv`: the assertion cannot be made honestly, so it is SKIPPED WITH A REASON
 *     rather than passing vacuously on a `-w` that root always satisfies.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "entrypoint.sh");
const NOBODY = 65534;
const BOOT_SPAWN_TIMEOUT_MS = 60_000;

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const HAS_SETPRIV = spawnSync("sh", ["-c", "command -v setpriv"], { encoding: "utf8" }).status === 0;
type Mode = "chmod" | "setpriv" | "skip";
const MODE: Mode = !IS_ROOT ? "chmod" : HAS_SETPRIV ? "setpriv" : "skip";
const SKIP_REASON =
  "running as root with no setpriv: root bypasses mode bits, so an unwritable path cannot be manufactured and the refusal cannot be observed";

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
}

interface Fixture {
  home: string;
  origin: string;
  tree: string;
  ledger: string;
  marker: string;
}

/** A HOME holding a real clone at `$HOME/Remudero/remudero`, its ledger, and a bootstrapped tsx. */
function makeFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}boot-writable-`));
  chmodSync(home, 0o755);
  const origin = join(home, "origin");
  mkdirSync(join(origin, "bin"), { recursive: true });
  git(origin, ["init", "-q", "-b", "main"]);
  writeFileSync(join(origin, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(join(origin, "bin", "rmd"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(join(origin, "bin", "rmd"), 0o755);
  git(origin, ["add", "-A"]);
  git(origin, ["commit", "-qm", "c1"]);

  const root = join(home, "Remudero");
  mkdirSync(root, { recursive: true });
  const tree = join(root, "remudero");
  git(home, ["clone", "-q", origin, tree]);
  // The bootstrap install is not under test: an existing tsx sends the script past `npm ci`.
  mkdirSync(join(tree, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(tree, "node_modules", ".bin", "tsx"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(root, "state"), { recursive: true });
  const ledger = join(root, "state", "ledger.ndjson");
  writeFileSync(ledger, "");
  if (MODE === "setpriv") chownTree(home, NOBODY);
  return { home, origin, tree, ledger, marker: join(home, "daemon-launched") };
}

function chownTree(path: string, id: number): void {
  const r = spawnSync("chown", ["-R", `${id}:${id}`, path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`chown -R ${id} ${path} failed: ${r.stderr}`);
}

/** Make `path` unwritable for whoever runs the boot; returns the owner the refusal must name. */
function makeUnwritable(path: string, isDir: boolean): string {
  if (MODE === "setpriv") {
    chownSync(path, 0, 0);
    chmodSync(path, isDir ? 0o755 : 0o644);
    return "root";
  }
  chmodSync(path, isDir ? 0o555 : 0o444);
  return userInfo().username;
}

function restore(path: string, isDir: boolean): void {
  chmodSync(path, isDir ? 0o755 : 0o644);
}

function boot(fx: Fixture): { status: number; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RMD_"))),
    HOME: fx.home,
    RMD_REPO_URL: fx.origin,
    RMD_REF: "main",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const argv = [SCRIPT, "touch", fx.marker];
  const [cmd, args] =
    MODE === "setpriv"
      ? ["setpriv", [`--reuid=${NOBODY}`, `--regid=${NOBODY}`, "--clear-groups", "bash", ...argv]]
      : ["bash", argv];
  const r = spawnSync(cmd, args as string[], { encoding: "utf8", cwd: fx.home, env, timeout: BOOT_SPAWN_TIMEOUT_MS });
  return { status: r.status ?? -1, stderr: `${r.stderr ?? ""}${r.stdout ?? ""}` };
}

function assertRefused(fx: Fixture, path: string, owner: string): void {
  const r = boot(fx);
  assert.notEqual(r.status, 0, `a boot with an unwritable ${path} must exit non-zero:\n${r.stderr}`);
  assert.ok(!existsSync(fx.marker), "the daemon command must never run when a mutable path is unwritable");
  assert.match(r.stderr, /not writable/, `the refusal must say what is wrong:\n${r.stderr}`);
  assert.ok(r.stderr.includes(path), `the refusal must name the path ${path}:\n${r.stderr}`);
  assert.ok(r.stderr.includes(`owner ${owner}`), `the refusal must name the owner (${owner}):\n${r.stderr}`);
}

test("W1-T4195: a writable fixture boots and reaches the command — the positive control for the refusals below", () => {
  const fx = makeFixture();
  const r = boot(fx);
  assert.equal(r.status, 0, `the fixture must boot when every path is writable:\n${r.stderr}`);
  assert.ok(existsSync(fx.marker), "the command must run on a healthy fixture");
});

test("W1-T4195: a root-owned ledger is refused at boot by name", (t) => {
  if (MODE === "skip") return t.skip(SKIP_REASON);
  const fx = makeFixture();
  const owner = makeUnwritable(fx.ledger, false);
  try {
    assertRefused(fx, fx.ledger, owner);
  } finally {
    restore(fx.ledger, false);
  }
});

test("W1-T4195: a root-owned git ref directory is refused at boot by name", (t) => {
  if (MODE === "skip") return t.skip(SKIP_REASON);
  const fx = makeFixture();
  const heads = join(fx.tree, ".git", "refs", "heads");
  const owner = makeUnwritable(heads, true);
  try {
    assertRefused(fx, heads, owner);
  } finally {
    restore(heads, true);
  }
});

// MEASURED 2026-09-23 on the live host: the core container held exactly this shape, a stale reviewer worktree's admin
// entry no longer writable. It blocks only that one worktree, so refusing the whole boot over it would take core down.
test("W1-T4195: an unwritable linked-worktree admin entry warns and still boots", (t) => {
  if (MODE === "skip") return t.skip(SKIP_REASON);
  const fx = makeFixture();
  const entry = join(fx.tree, ".git", "worktrees", "reviewer-6315-fresh-1789955000000");
  mkdirSync(entry, { recursive: true });
  // A real admin entry, pointing at a worktree that no longer exists, so `git worktree prune` wants it gone.
  writeFileSync(join(entry, "gitdir"), join(fx.home, "gone-worktree", ".git") + "\n");
  writeFileSync(join(entry, "HEAD"), "ref: refs/heads/main\n");
  if (MODE === "setpriv") chownTree(join(fx.tree, ".git", "worktrees"), NOBODY);
  const owner = makeUnwritable(entry, true);
  try {
    const r = boot(fx);
    assert.equal(r.status, 0, `one worktree's admin entry must not refuse the boot:\n${r.stderr}`);
    assert.ok(existsSync(fx.marker), "the command must still run");
    assert.match(r.stderr, /WARNING: .*reviewer-6315-fresh-1789955000000 is not writable/, `the entry must be named:\n${r.stderr}`);
    assert.ok(r.stderr.includes(`owner ${owner}`), `the warning must name the owner (${owner}):\n${r.stderr}`);
  } finally {
    restore(entry, true);
  }
});
