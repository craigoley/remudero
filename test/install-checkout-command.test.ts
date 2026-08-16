/**
 * test/install-checkout-command.test.ts — W1-T924: `rmd install-checkout [--write]`.
 *
 * `installCheckoutCommand` (run-task.ts) is not exported — like `deployRunCommand`/
 * `deployPlistCommand` beside it, it is reached only through `main()`'s dispatch, the same
 * shape `test/deploy-run-freshness-exempt.test.ts` and `test/config.test.ts` already drive
 * (mocked `process.exit`/console, an overridden `HOME` so `loadConfig()` reads a throwaway
 * config rather than the operator's real one). Every scenario below writes its OWN
 * `installRoot` before calling `main()`, since `installCheckoutCommand` calls `loadConfig()`
 * fresh on every invocation (no caching) — this exercises the command's real logic end to end
 * rather than re-testing `lib/install-root.ts`'s own primitives, which `test/install-root.test.ts`
 * already covers in isolation.
 *
 * The one branch that would otherwise need a real network clone (the ABSENT install root,
 * `--write` "cloned" outcome) is exercised against a LOCAL bare-repo fixture instead: git's
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` env override (git >= 2.31) lets
 * the test override what `git -C <repoRoot> config --get remote.origin.url` returns for the
 * one `execFileSync` call the command makes, WITHOUT touching the real worktree's `.git/config`
 * — this worktree shares that file with its sibling worktrees (a linked worktree's `.git` is a
 * pointer into the common repo), so mutating it on disk would be a live hazard to whatever else
 * is running against them.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { main } from "../src/run-task.js";

class ProcessExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** A throwaway bare origin + seed, pushed once — mirrors install-root.test.ts's buildOrigin(),
 *  entirely local (no network). Returns the bare repo's path (a valid `remote.origin.url`). */
function buildLocalOrigin(dir: string): string {
  const originDir = join(dir, "origin.git");
  const seedDir = join(dir, "seed");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", originDir]);
  execFileSync("git", ["init", "--quiet", "-b", "main", seedDir]);
  git(seedDir, ["config", "user.email", "t@example.invalid"]);
  git(seedDir, ["config", "user.name", "Test"]);
  git(seedDir, ["remote", "add", "origin", originDir]);
  writeFileSync(join(seedDir, "marker.txt"), "v1\n");
  git(seedDir, ["add", "."]);
  git(seedDir, ["commit", "--quiet", "-m", "v1"]);
  git(seedDir, ["push", "--quiet", "origin", "main"]);
  return originDir;
}

/** Writes `~/.config/remudero/config.json` under the given (overridden) HOME. `claudeBin` is
 *  always present so `loadConfig()` never shells `which claude` (absent in CI — LEARNINGS.md). */
function writeConfig(home: string, cfg: Partial<Config> & { root: string }): void {
  const dir = join(home, ".config", "remudero");
  mkdirSync(dir, { recursive: true });
  const full: Config = { claudeBin: "/usr/bin/claude", ...cfg };
  writeFileSync(join(dir, "config.json"), JSON.stringify(full, null, 2) + "\n");
}

/** Drives `main(["install-checkout", ...args])` with the freshness gate guarded (a no-op — the
 *  same status `RMD_SELF_SYNC_GUARD=1`/CI itself already forces) and captures exit code + I/O. */
async function runInstallCheckout(
  t: { mock: { method: typeof import("node:test").mock.method } },
  args: string[],
): Promise<{ code: number | undefined; logs: string[]; errs: string[] }> {
  const logs: string[] = [];
  const errs: string[] = [];
  t.mock.method(
    process,
    "exit",
    ((code?: number): never => {
      throw new ProcessExitCalled(code);
    }) as typeof process.exit,
  );
  t.mock.method(console, "log", (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  t.mock.method(console, "error", (...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  });
  const originalArgv = process.argv;
  process.argv = ["node", "run-task.js", "install-checkout", ...args];
  try {
    let caught: unknown;
    await main({ checkFreshness: () => ({ status: "guarded" }) }).catch((e) => {
      caught = e;
    });
    const code = caught instanceof ProcessExitCalled ? caught.code : undefined;
    return { code, logs, errs };
  } finally {
    process.argv = originalArgv;
  }
}

test("install-checkout: an unknown flag is refused (2), same as every other verb's arg guard", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rmd-install-checkout-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  writeConfig(home, { root: join(home, "state-root") });
  try {
    const r = await runInstallCheckout(t, ["--bogus"]);
    assert.equal(r.code, 2);
    assert.ok(
      r.errs.some((e) => e.includes("unexpected argument '--bogus'")),
      `expected the unknownArgError message; got ${JSON.stringify(r.errs)}`,
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("install-checkout: refuses when the resolved install root is the operator's own checkout — the exact defect this closes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rmd-install-checkout-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  // installRoot === repoRoot: the separation invariant's second clause (install root resolves
  // INSIDE the operator's own checkout) fires — the pre-W1-T924 defect, reproduced on purpose.
  writeConfig(home, { root: join(home, "state-root"), installRoot: repoRoot });
  try {
    const r = await runInstallCheckout(t, []);
    assert.equal(r.code, 1);
    assert.ok(
      r.errs.some((e) => e.includes("refused:") && e.includes("resolves INSIDE the operator's own checkout")),
      `expected the separation refusal; got ${JSON.stringify(r.errs)}`,
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("install-checkout (no --write): prints the install root's state plus the migration sequence, without provisioning anything", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rmd-install-checkout-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const installRoot = join(home, "daemon-install"); // absent -- never created by this scenario
  writeConfig(home, { root: join(home, "state-root"), installRoot });
  try {
    const r = await runInstallCheckout(t, []);
    assert.equal(r.code, 0);
    assert.ok(
      r.logs.some((l) => l.includes(`install root: ${installRoot}`)),
      `expected the install-root line; got ${JSON.stringify(r.logs)}`,
    );
    assert.ok(
      r.logs.some((l) => l.includes("state: install root absent")),
      `expected the ABSENT state description; got ${JSON.stringify(r.logs)}`,
    );
    assert.ok(
      r.logs.some((l) => l.includes("migration sequence for an EXISTING (shared) install")),
      "the default (no --write) output must name the full migration sequence (design note v)",
    );
    assert.ok(
      r.logs.some((l) => l.includes("rmd install-checkout --write")),
      "step 1 of the printed sequence must name --write",
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("install-checkout --write: refuses a non-empty, non-git install root — never rm -rf's it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rmd-install-checkout-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const installRoot = join(home, "not-a-repo");
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(join(installRoot, "stray.txt"), "not a git checkout\n");
  writeConfig(home, { root: join(home, "state-root"), installRoot });
  try {
    const r = await runInstallCheckout(t, ["--write"]);
    assert.equal(r.code, 1);
    assert.ok(
      r.errs.some((e) => e.includes("refused (not-a-repo)")),
      `expected the not-a-repo refusal; got ${JSON.stringify(r.errs)}`,
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("install-checkout --write: clones an ABSENT install root from origin/main (local fixture, no network)", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rmd-install-checkout-"));
  const fixtures = mkdtempSync(join(tmpdir(), "rmd-install-checkout-origin-"));
  const savedHome = process.env.HOME;
  const savedGitConfigCount = process.env.GIT_CONFIG_COUNT;
  const savedGitConfigKey0 = process.env.GIT_CONFIG_KEY_0;
  const savedGitConfigValue0 = process.env.GIT_CONFIG_VALUE_0;
  process.env.HOME = home;
  const installRoot = join(home, "daemon-install-clone-target"); // absent -- the clone target
  writeConfig(home, { root: join(home, "state-root"), installRoot });
  const localOrigin = buildLocalOrigin(fixtures);
  // Override what `git -C <repoRoot> config --get remote.origin.url` resolves to for every git
  // invocation made while these env vars are set -- highest-precedence git config source, so it
  // shadows the real worktree's remote WITHOUT writing to its (shared) .git/config on disk.
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "remote.origin.url";
  process.env.GIT_CONFIG_VALUE_0 = localOrigin;
  try {
    const r = await runInstallCheckout(t, ["--write"]);
    assert.equal(r.code, 0);
    assert.ok(
      r.logs.some((l) => l.includes(`cloned at ${installRoot}`)),
      `expected the cloned outcome; got ${JSON.stringify(r.logs)}, errs ${JSON.stringify(r.errs)}`,
    );
    // Real provisioning happened: HEAD of the freshly cloned install root matches origin/main.
    const clonedHead = git(installRoot, ["rev-parse", "HEAD"]);
    const originHead = git(localOrigin, ["rev-parse", "main"]);
    assert.equal(clonedHead, originHead);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedGitConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = savedGitConfigCount;
    if (savedGitConfigKey0 === undefined) delete process.env.GIT_CONFIG_KEY_0;
    else process.env.GIT_CONFIG_KEY_0 = savedGitConfigKey0;
    if (savedGitConfigValue0 === undefined) delete process.env.GIT_CONFIG_VALUE_0;
    else process.env.GIT_CONFIG_VALUE_0 = savedGitConfigValue0;
  }
});
