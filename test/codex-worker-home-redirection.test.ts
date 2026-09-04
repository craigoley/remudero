/**
 * test/codex-worker-home-redirection.test.ts — W1-T2800.
 *
 * THE LEAK, REPRODUCED AGAINST PINNED codex-cli 0.152.0 BEFORE ANY FIX WAS WRITTEN. The shard's
 * falsifier makes the reproduction a PRECONDITION, not a validation step: build nothing on the
 * strength of a source reading. It was reproduced, and the measurement is sharper than the
 * hypothesis. With a sentinel exported ONLY from `$HOME/.bashrc` (never in the spawn env) and the
 * repo's exact exclusion argv:
 *
 *   /proc/self/environ in the child ....... 0 ANTHROPIC keys   (the exclusions HOLD)
 *   `env` with no shell at all ............ 0 ANTHROPIC keys   (the exclusions HOLD)
 *   the SHELL-VISIBLE value ............... sk-ant-LEAKCANARY-…  (the leak)
 *   plain `bash -c`, same HOME, no codex .. <empty>            (the discriminating control)
 *
 * Both exclusions do exactly what they claim AT THE PROCESS BOUNDARY, and the worker's shell
 * re-reads the value FROM DISK after that boundary is crossed. Removing `.bashrc` closed it;
 * restoring it re-opened it. So neither exclusion is wrong and neither is the fix — the missing
 * boundary is HOME redirection, which is what the Claude path has had since W1-T18 and what
 * `spawnWorker`'s Codex branch returned past.
 *
 * WHY THE ASSERTIONS BELOW ARE ON THE VALUE, NOT ON HOME. The falsifier is explicit that a test
 * asserting only that HOME points somewhere redirected "proves the wiring and not the exclusion,
 * and does not discharge this task". So the first test seeds a real rc file with a sentinel in a
 * simulated operator HOME and asserts the sentinel is UNREACHABLE through the env the Codex spawn
 * actually hands its child — the same shape as the live reproduction, minus the binary.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { codexSpawnEnvForTest } from "../src/lib/worker-provider.js";
import { WORKER_HOME_RC_FILES, materializeWorkerHome, perRunWorkerHomeDir } from "../src/lib/worker-home.js";
import { billingMode } from "../src/lib/env.js";
import type { Config } from "../src/lib/config.js";

const SENTINEL = "sk-ant-LEAKCANARY-W1T2800-deadbeef";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rmd-t2800-"));
}

/** A simulated OPERATOR home carrying the sentinel in every rc file the host might source — the
 *  shape measured on the operator mini, where `~/.zshrc` exports ANTHROPIC_API_KEY twice. */
function operatorHomeWithRcSentinel(root: string): string {
  const home = join(root, "operator-home");
  mkdirSync(home, { recursive: true });
  for (const rc of WORKER_HOME_RC_FILES) writeFileSync(join(home, rc), `export ANTHROPIC_API_KEY=${SENTINEL}\n`);
  return home;
}

function fakeConfig(root: string): Config {
  return { root, workerProviders: { codex: { codexHome: join(root, "codex-home") } } } as unknown as Config;
}

// ── the leak itself: asserted on the VALUE, per the falsifier ───────────────────────────────────

test("W1-T2800: the sentinel exported only from an rc file is UNREACHABLE through the Codex spawn env — HOME resolves to a redirected per-spawn home whose rc files are blank", () => {
  const root = scratch();
  try {
    const operatorHome = operatorHomeWithRcSentinel(root);
    const workerHome = perRunWorkerHomeDir(join(root, "worker-homes"), "RUN-1", { perSpawn: true });
    materializeWorkerHome({ workerHome, realHome: operatorHome });

    const env = codexSpawnEnvForTest(fakeConfig(root), {
      cwd: root,
      prompt: "p",
      runId: "RUN-1",
      workerHome,
      zdotdir: join(root, "zdotdir"),
      env: {},
    });

    // (a) HOME is the redirected home, NOT the operator's — and there is no process.env.HOME
    //     fallback reachable on this path.
    assert.equal(env.HOME, workerHome, "the Codex spawn's HOME must be the per-spawn redirected home");
    assert.notEqual(env.HOME, operatorHome);

    // (b) THE LOAD-BEARING ASSERTION — the sentinel's VALUE is not reachable from that HOME,
    //     because every rc file the redirected home carries is BLANK. This is what the live
    //     reproduction showed crossing the boundary, and it is what the fix closes.
    for (const rc of WORKER_HOME_RC_FILES) {
      const body: string = readFileSync(join(env.HOME as string, rc), "utf8");
      assert.equal(body, "", `${rc} in the redirected home must be blank`);
      assert.ok(!body.includes(SENTINEL), `${rc} must not carry the operator's exported key`);
    }
    // and the operator's own rc really does carry it, or this proves nothing
    assert.match(readFileSync(join(operatorHome, ".bashrc"), "utf8"), new RegExp(SENTINEL));

    // (c) no ANTHROPIC_ key survives into the spawn env either — the boundary exclusion still holds
    assert.equal(Object.keys(env).filter((k) => k.startsWith("ANTHROPIC_")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2800: an ANTHROPIC_ key in args.env is still filtered, and the redirected HOME cannot be overridden through args.env ordering", () => {
  const root = scratch();
  try {
    const workerHome = perRunWorkerHomeDir(join(root, "worker-homes"), "RUN-2", { perSpawn: true });
    materializeWorkerHome({ workerHome, realHome: operatorHomeWithRcSentinel(root) });
    const env = codexSpawnEnvForTest(fakeConfig(root), {
      cwd: root,
      prompt: "p",
      runId: "RUN-2",
      workerHome,
      zdotdir: join(root, "zdotdir"),
      // both an excluded key AND an attempt to steer HOME through args.env
      env: { ANTHROPIC_API_KEY: SENTINEL, HOME: "/tmp/attacker-home" },
    });
    assert.equal(env.ANTHROPIC_API_KEY, undefined, "the existing key filter is unchanged and still fires");
    assert.equal(
      env.HOME,
      workerHome,
      "HOME comes from the explicitly threaded worker home, never from args.env ordering (the implicit dependency the design forbids)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2800: ZDOTDIR is redirected on the Codex path, so a directly-invoked zsh cannot reach the operator's zdotdir", () => {
  const root = scratch();
  try {
    const workerHome = perRunWorkerHomeDir(join(root, "worker-homes"), "RUN-3", { perSpawn: true });
    materializeWorkerHome({ workerHome, realHome: operatorHomeWithRcSentinel(root) });
    const zdotdir = join(root, "zdotdir");
    const env = codexSpawnEnvForTest(fakeConfig(root), { cwd: root, prompt: "p", runId: "RUN-3", workerHome, zdotdir, env: {} });
    assert.equal(env.ZDOTDIR, zdotdir, "ZDOTDIR must be redirected on the Codex path (W1-T1C compinit contamination)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2800: billingMode over the Codex spawn's own env keys reads subscription, and no ANTHROPIC_ key is present in one view and absent from the other", () => {
  const root = scratch();
  try {
    const workerHome = perRunWorkerHomeDir(join(root, "worker-homes"), "RUN-4", { perSpawn: true });
    materializeWorkerHome({ workerHome, realHome: operatorHomeWithRcSentinel(root) });
    const env = codexSpawnEnvForTest(fakeConfig(root), {
      cwd: root, prompt: "p", runId: "RUN-4", workerHome, zdotdir: join(root, "zdotdir"),
      env: { ANTHROPIC_API_KEY: SENTINEL },
    });
    const childEnvKeys = Object.keys(env);
    assert.equal(billingMode(childEnvKeys), "subscription", "the ledger's billing derivation must agree with the real env");
    // the agreement the shard demands: the shell's HOME carries no rc that could re-export a key
    for (const rc of WORKER_HOME_RC_FILES) {
      assert.ok(!(readFileSync(join(env.HOME as string, rc), "utf8") as string).includes("ANTHROPIC_"), `${rc} must not reintroduce a key childEnvKeys cannot see`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2800: HOME is required on the Codex spawn path — there is no process.env.HOME fallback left to reach", () => {
  const root = scratch();
  try {
    const saved = process.env.HOME;
    process.env.HOME = join(root, "operator-home-from-process-env");
    mkdirSync(process.env.HOME, { recursive: true });
    writeFileSync(join(process.env.HOME, ".bashrc"), `export ANTHROPIC_API_KEY=${SENTINEL}\n`);
    try {
      const workerHome = perRunWorkerHomeDir(join(root, "worker-homes"), "RUN-5", { perSpawn: true });
      materializeWorkerHome({ workerHome, realHome: process.env.HOME });
      const env = codexSpawnEnvForTest(fakeConfig(root), {
        cwd: root, prompt: "p", runId: "RUN-5", workerHome, zdotdir: join(root, "zdotdir"), env: {},
      });
      assert.equal(env.HOME, workerHome);
      assert.notEqual(env.HOME, process.env.HOME, "process.env.HOME must not be reachable as a fallback on the spawn path");
    } finally {
      if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
