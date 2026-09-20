import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { resolveInstallRoot, validateDeployStateRoot } from "../src/lib/install-root.js";
import { main } from "../src/run-task.js";

class ProcessExitCalled extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function writeConfig(home: string, config: Partial<Config> & { root: string }): string {
  const path = join(home, ".config", "remudero", "config.json");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(path, JSON.stringify({ claudeBin: "/usr/bin/claude", ...config }, null, 2) + "\n");
  return path;
}

async function runDeployRun(
  t: { mock: { method: typeof import("node:test").mock.method } },
  args: string[],
): Promise<{ code: number | undefined; logs: string[] }> {
  const logs: string[] = [];
  t.mock.method(
    process,
    "exit",
    ((code?: number): never => {
      throw new ProcessExitCalled(code);
    }) as typeof process.exit,
  );
  t.mock.method(console, "log", (...values: unknown[]) => logs.push(values.map(String).join(" ")));
  const savedArgv = process.argv;
  const savedToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "test-token";
  process.argv = ["node", "run-task.js", "deploy-run", ...args];
  try {
    let caught: unknown;
    await main({ checkFreshness: () => ({ status: "guarded" }) }).catch((error) => {
      caught = error;
    });
    return { code: caught instanceof ProcessExitCalled ? caught.code : undefined, logs };
  } finally {
    process.argv = savedArgv;
    if (savedToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedToken;
  }
}

test("deploy-run override derives a fresh install root and ignores an inherited explicit installRoot", { concurrency: false }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rmd-deploy-root-"));
  const sharedRoot = join(home, "shared-state");
  const sharedInstall = join(home, "core-install");
  mkdirSync(sharedRoot, { recursive: true });
  const configPath = writeConfig(home, { root: sharedRoot, installRoot: sharedInstall });
  const originalConfig = readFileSync(configPath, "utf8");
  const instanceRoot = mkdtempSync(join(tmpdir(), "rmd-instance-state-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const result = await runDeployRun(t, ["--state-root", instanceRoot]);
    assert.equal(result.code, 0);
    assert.match(result.logs.join("\n"), new RegExp(`install root absent at ${instanceRoot}/daemon-install`));
    assert.doesNotMatch(result.logs.join("\n"), new RegExp(`install root absent at ${sharedInstall}`));
    assert.equal(readFileSync(configPath, "utf8"), originalConfig, "the override is not persisted");
    assert.equal(resolveInstallRoot({ root: instanceRoot, installRoot: sharedInstall }), sharedInstall);
    assert.equal(resolveInstallRoot({ root: instanceRoot, installRoot: undefined }), join(instanceRoot, "daemon-install"));
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("deploy-run with a valid override does not create HOME config and names the derived absent install", { concurrency: false }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rmd-deploy-root-no-config-"));
  const instanceRoot = mkdtempSync(join(tmpdir(), "rmd-instance-state-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const result = await runDeployRun(t, ["--state-root", instanceRoot]);
    assert.equal(result.code, 0);
    assert.match(result.logs.join("\n"), new RegExp(`install root absent at ${instanceRoot}/daemon-install`));
    assert.equal(existsSync(join(home, ".config", "remudero", "config.json")), false);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("an unusable override is a named no-op before config loading", { concurrency: false }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rmd-deploy-root-invalid-"));
  const file = join(home, "state-file");
  writeFileSync(file, "not a directory\n");
  const missing = join(home, "missing");
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    for (const value of ["relative/state", missing, file, ""]) {
      const validation = validateDeployStateRoot(value);
      assert.equal(validation.ok, false, `expected ${JSON.stringify(value)} to be refused`);
    }
    const result = await runDeployRun(t, ["--state-root", missing]);
    assert.equal(result.code, 0);
    assert.match(result.logs.join("\n"), /deploy-run — no-op: --state-root/);
    assert.equal(existsSync(join(home, ".config", "remudero", "config.json")), false);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("deploy-run without an override retains the config-selected install root", { concurrency: false }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rmd-deploy-root-default-"));
  const stateRoot = join(home, "state");
  const installRoot = join(home, "configured-install");
  mkdirSync(stateRoot, { recursive: true });
  writeConfig(home, { root: stateRoot, installRoot });
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const result = await runDeployRun(t, []);
    assert.equal(result.code, 0);
    assert.match(result.logs.join("\n"), new RegExp(`install root absent at ${installRoot}`));
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
