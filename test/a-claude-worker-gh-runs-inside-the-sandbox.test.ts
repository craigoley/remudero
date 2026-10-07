import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as settings from "../src/lib/settings.js";
import * as workerHome from "../src/lib/worker-home.js";

/**
 * A CLAUDE WORKER'S `gh` RUNS INSIDE THE SANDBOX, AND ITS HOME NEVER REACHES THE OPERATOR'S gh CONFIG.
 *
 * READ IN THE BUNDLED CLI (claude-agent-sdk 0.3.276): the Bash sandbox decision returns "unsandboxed"
 * when the excluded-command matcher says yes, and that matcher splits the command into its
 * subcommands and answers yes when ANY ONE of them matches an entry. `gh *` is a wildcard entry, so
 * `gh --version && <anything>` ran the WHOLE line outside the sandbox. That branch is gated only by
 * a host-level flag, never by `allowUnsandboxedCommands`, so an exclusion of any shape is an escape.
 *
 * The worker HOME also symlinked `.config/gh` to the operator's real gh config: an unsandboxed
 * `gh alias set` / `gh config set` there wrote the config the operator's own gh reads.
 *
 * FIXTURES ONLY: every HOME here is a throwaway directory, and nothing below runs gh.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GH_CONFIG_REL = join(".config", "gh");

function policy(): { permissions: { deny: string[] }; sandbox: Record<string, unknown> & { filesystem: { denyRead: string[] } } } {
  return JSON.parse(readFileSync(join(REPO_ROOT, "settings", "worker.json"), "utf8"));
}

/** The smallest policy the validator accepts, so each refusal below is about the one key it adds. */
function minimalPolicy(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    permissions: { deny: [], allow: [], ask: [] },
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, ...extra },
  };
}

test("the worker policy names no excludedCommands, so no compound command rides an exclusion out of the sandbox", () => {
  const sandbox = policy().sandbox;
  assert.equal("excludedCommands" in sandbox, false, "any exclusion lets a compound command that contains it run unsandboxed");
  assert.doesNotThrow(() => settings.validateWorkerSettingsFile(join(REPO_ROOT, "settings", "worker.json")));
});

test("validateWorkerSettings refuses any excludedCommands entry, because the CLI exempts a whole compound command", () => {
  for (const entry of ["gh *", "/usr/local/bin/rmd-gh pr create *", "gh"]) {
    assert.throws(
      () => settings.validateWorkerSettings(minimalPolicy({ excludedCommands: [entry] })),
      (e: unknown) => e instanceof settings.WorkerSettingsError && /excludedCommands/.test(e.message),
      `an exclusion of ${JSON.stringify(entry)} must be refused by name`,
    );
  }
  assert.throws(() => settings.validateWorkerSettings(minimalPolicy({ excludedCommands: "gh *" })), settings.WorkerSettingsError);
  // The control: the same policy without the key, or with an empty list, is accepted.
  assert.doesNotThrow(() => settings.validateWorkerSettings(minimalPolicy()));
  assert.doesNotThrow(() => settings.validateWorkerSettings(minimalPolicy({ excludedCommands: [] })));
});

test("the worker policy denies a sandboxed read of the operator's gh config", () => {
  const p = policy();
  // `~/..` is config.root and `~/../..` the operator's real home, the same anchor the remudero deny uses.
  assert.ok(p.sandbox.filesystem.denyRead.includes("~/../../.config/gh/**"), "sandboxed Bash must not read hosts.yml");
  assert.ok(p.permissions.deny.includes("Read(~/../../.config/gh/**)"), "nor the Read tool");
  assert.ok(p.sandbox.filesystem.denyRead.includes("~/../../.config/remudero/**"), "control: the sibling deny is still there");
});

test("a materialized worker HOME holds no link to the operator's gh config", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-gh-grant-"));
  const realHome = join(root, "real");
  const home = join(root, "wh");
  try {
    mkdirSync(join(realHome, GH_CONFIG_REL), { recursive: true });
    writeFileSync(join(realHome, GH_CONFIG_REL, "hosts.yml"), "github.com:\n  user: fixture\n");
    writeFileSync(join(realHome, ".gitconfig"), "[user]\n\tname = Fixture\n");
    const plan = workerHome.materializeWorkerHome({ workerHome: home, realHome });
    assert.equal(existsSync(join(home, GH_CONFIG_REL)), false, "the operator's gh config must not appear in the worker HOME");
    assert.equal(plan.symlinks.some((s) => s.to.startsWith(join(realHome, ".config"))), false, "no grant targets it");
    assert.equal(lstatSync(join(home, ".gitconfig")).isSymbolicLink(), true, "control: the other grants still materialize");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a link to the operator's gh config left by an earlier materialization is removed", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-gh-revoke-"));
  const realHome = join(root, "real");
  const home = join(root, "wh");
  try {
    mkdirSync(join(realHome, GH_CONFIG_REL), { recursive: true });
    mkdirSync(join(home, ".config"), { recursive: true });
    symlinkSync(join(realHome, GH_CONFIG_REL), join(home, GH_CONFIG_REL)); // what the old grant made
    workerHome.materializeWorkerHome({ workerHome: home, realHome });
    assert.equal(existsSync(join(home, GH_CONFIG_REL)), false, "a reused home must stop reaching the operator's config");
    assert.equal(existsSync(join(realHome, GH_CONFIG_REL)), true, "and the operator's own directory is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a revoked gh config slot that cannot be inspected fails the materialization loudly", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-gh-revoke-locked-"));
  const realHome = join(root, "real");
  const home = join(root, "wh");
  mkdirSync(realHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  symlinkSync(".config", join(home, ".config")); // a real ELOOP on the slot for every uid, never a stubbed error
  try {
    assert.throws(() => workerHome.materializeWorkerHome({ workerHome: home, realHome }), /ELOOP/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file where the .config directory belongs leaves nothing to revoke, and does not fail", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-gh-revoke-file-"));
  const realHome = join(root, "real");
  const home = join(root, "wh");
  try {
    mkdirSync(realHome, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".config"), "not a directory\n");
    assert.doesNotThrow(() => workerHome.materializeWorkerHome({ workerHome: home, realHome }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("REVOKED_WORKER_HOME_GRANTS names the gh config slot, and no live grant reuses it", () => {
  assert.deepEqual([...workerHome.REVOKED_WORKER_HOME_GRANTS], [GH_CONFIG_REL]);
  for (const grant of workerHome.WORKER_HOME_SYMLINKS) {
    assert.notEqual(grant.relPath, GH_CONFIG_REL, "a revoked slot must not also be granted");
  }
});
