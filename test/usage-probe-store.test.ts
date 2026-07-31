import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { workerKeychainPaths } from "../src/lib/worker-home.js";
import { readUsageSnapshot, type UsageProbeRunner } from "../src/run-task.js";

// A minimal, well-formed `/usage` capture parseUsage accepts — content is
// irrelevant to every test here; only the ENV/argv the probe builds is under
// test.
const SAMPLE_USAGE_TEXT = [
  "Using your subscription",
  "Current session: 12% used · resets 3pm",
  "Current week (all models): 34% used · resets Jan 8",
  "",
].join("\n");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-usage-probe-"));
}

function withHome<T>(realHome: string, fn: () => T): T {
  const prior = process.env.HOME;
  process.env.HOME = realHome;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  }
}

test("readUsageSnapshot: the probe's env HOME resolves the SAME keychain store workerKeychainPaths hands a worker spawn", () => {
  const root = tmp();
  const realHome = tmp();
  try {
    const config: Config = { claudeBin: "/bin/true", root };
    // The store a real worker spawn resolves (worker.ts's own
    // `workerKeychainPaths(join(config.root, "state"))` call) — planted so
    // materializeWorkerHome's existsSync gate actually grants the symlink.
    const workerStore = workerKeychainPaths(join(root, "state")).keychainPath;
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(workerStore, "WORKER-STORE-BYTES");

    let capturedEnv: Record<string, string> | undefined;
    const recorder: UsageProbeRunner = (bin, argv, opts) => {
      capturedEnv = opts.env;
      assert.deepEqual(argv, ["-p", "/usage"]);
      return SAMPLE_USAGE_TEXT;
    };

    withHome(realHome, () => readUsageSnapshot(config, recorder));

    assert.ok(capturedEnv, "the injected runner must have been called");
    const home = capturedEnv!.HOME;
    assert.ok(home, "the probe's env must carry a HOME");
    assert.notEqual(home, realHome, "HOME must be the redirected worker home, never the operator's real HOME");
    // Follow the HOME-relative keychain slot exactly as Claude Code itself
    // does, and confirm it lands on the WORKER store, byte for byte.
    const resolved = readFileSync(join(home, "Library", "Keychains", "login.keychain-db"), "utf8");
    assert.equal(resolved, "WORKER-STORE-BYTES", "the probe's keychain slot must resolve the worker store");
  } finally {
    rmSync(root, { recursive: true, force: true }); // also removes workerHomeDir(config), a child of root
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("readUsageSnapshot: with two stores present, the probe follows the WORKER store and never the fleet user's login keychain", () => {
  const root = tmp();
  const realHome = tmp();
  try {
    const config: Config = { claudeBin: "/bin/true", root };

    // The operator's real login keychain — a DIFFERENT store, planted at the
    // path the pre-fix bug (bare HOME inheritance) would have resolved.
    mkdirSync(join(realHome, "Library", "Keychains"), { recursive: true });
    writeFileSync(join(realHome, "Library", "Keychains", "login.keychain-db"), "LOGIN-KEYCHAIN-BYTES");

    // The worker's dedicated store — what a real spawn (worker.ts) resolves.
    const workerStore = workerKeychainPaths(join(root, "state")).keychainPath;
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(workerStore, "WORKER-KEYCHAIN-BYTES");

    let capturedEnv: Record<string, string> | undefined;
    const recorder: UsageProbeRunner = (_bin, _argv, opts) => {
      capturedEnv = opts.env;
      return SAMPLE_USAGE_TEXT;
    };

    withHome(realHome, () => readUsageSnapshot(config, recorder));

    const home = capturedEnv!.HOME;
    const resolved = readFileSync(join(home, "Library", "Keychains", "login.keychain-db"), "utf8");
    assert.equal(resolved, "WORKER-KEYCHAIN-BYTES", "must follow the WORKER store");
    assert.notEqual(resolved, "LOGIN-KEYCHAIN-BYTES", "must NEVER fall back to the fleet user's login keychain");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("readUsageSnapshot: the exec seam is injectable, and its DEFAULT implementation (no recorder) is exercised by a real leaf process", () => {
  const root = tmp();
  const realHome = tmp();
  const binDir = tmp();
  const fakeClaude = join(binDir, "fake-claude.sh");
  try {
    // A real, executable leaf — no injected recorder — proving the DEFAULT
    // `execFileSync` path itself is covered, not just the seam's shape.
    // Single-quoted so `/bin/sh` preserves the real newlines literally (a
    // JSON.stringify-escaped `\n` would print as two literal characters,
    // never a newline, and the SESSION_LINE/WEEKLY_LINE regexes would miss).
    writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s' '${SAMPLE_USAGE_TEXT}'\n`);
    chmodSync(fakeClaude, 0o755);

    const config: Config = { claudeBin: fakeClaude, root };
    const snap = withHome(realHome, () => readUsageSnapshot(config)); // no runner arg ⇒ defaultUsageProbeRunner

    assert.ok(snap, "the real default runner must have produced a parsed snapshot");
    assert.equal(snap!.session.percentUsed, 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("readUsageSnapshot: an unreadable probe still returns undefined and the ratified unreadable⇒continue polarity is unchanged", () => {
  const root = tmp();
  const realHome = tmp();
  try {
    const config: Config = { claudeBin: "/bin/true", root };
    const throwingRunner: UsageProbeRunner = () => {
      throw new Error("simulated: claude -p /usage exited nonzero");
    };

    const snap = withHome(realHome, () => readUsageSnapshot(config, throwingRunner));
    assert.equal(snap, undefined, "unreadable must yield undefined, never throw, never a default 'unlimited' snapshot");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("readUsageSnapshot: a garbled (unparseable) capture ALSO yields undefined, same polarity as an execution failure", () => {
  const root = tmp();
  const realHome = tmp();
  try {
    const config: Config = { claudeBin: "/bin/true", root };
    const garbledRunner: UsageProbeRunner = () => "not anything /usage would ever print";

    const snap = withHome(realHome, () => readUsageSnapshot(config, garbledRunner));
    assert.equal(snap, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});
