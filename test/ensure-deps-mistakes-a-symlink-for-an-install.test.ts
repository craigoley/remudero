import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import type { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import {
  ensureDeps,
  execWhitelistedProof,
  judgeCriterion,
  parseWhitelistedProof,
  pinnedVitestCli,
  type ProofSpawner,
} from "../src/lib/review.js";
import { makeTempDir } from "../src/lib/tmp.js";

const PROOF = "unit test: apps/dashboard/src/App.test.tsx";

function checkoutWithPackage(): string {
  const cwd = makeTempDir("w1t3312-checkout-");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  return cwd;
}

function dashboardProof() {
  const proof = parseWhitelistedProof(PROOF);
  assert.ok(proof, "the dashboard proof must resolve before its runner can be checked");
  assert.equal(proof!.runner, "vitest", "the resolver must name the checkout-local runner it needs");
  return proof!;
}

function absentRunnerCheckout(): string {
  const cwd = checkoutWithPackage();
  const shared = makeTempDir("w1t3312-shared-node-modules-");
  // This is the worker's normal linked-worktree shape: the directory exists but lacks the new
  // dependency. The target is deliberately empty; no test relies on a package manager or network.
  symlinkSync(shared, join(cwd, "node_modules"), "dir");
  return cwd;
}

test("W1-T3312: a symlinked node_modules without Vitest is not a satisfied install and is never cleared", () => {
  const cwd = absentRunnerCheckout();
  const runner = pinnedVitestCli(cwd);
  const calls: string[] = [];
  const recorder = ((file: string) => {
    calls.push(file);
    return "";
  }) as unknown as typeof execFileSync;

  assert.equal(ensureDeps(cwd, recorder, runner), false, "the required runner, not the directory, decides readiness");
  assert.deepEqual(calls, [], "npm ci must never clear the shared target behind a worktree symlink");
});

test("W1-T3312: an absent checkout-local runner grades not_executable, names the runner, and never spawns it", () => {
  const cwd = absentRunnerCheckout();
  const proof = dashboardProof();
  let spawns = 0;
  const spawner: ProofSpawner = () => {
    spawns++;
    return "";
  };

  assert.throws(
    () => execWhitelistedProof(proof, cwd, 60_000, spawner, { preflightBrowsers: () => {} }),
    /proof runner is absent from this checkout/,
    "the executor must decline an unavailable runner before it can manufacture a failed assertion",
  );
  assert.equal(spawns, 0, "an absent runner must not be passed to node at all");

  const verdict = judgeCriterion(
    { claim: "the dashboard proof is independently checkable", proof: PROOF },
    new Set(["dashboard", "proof", "checkable"]),
    undefined,
    { cwd, exec: execWhitelistedProof },
  );
  assert.equal(verdict.proof_exec, "not_executable", "a host tool gap is not a failing assertion");
  assert.equal(verdict.proof_skip, "runner-absent");
  assert.notEqual(verdict.proof_exec, "executed_fail");
  assert.match(verdict.reason, new RegExp(pinnedVitestCli(cwd).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(verdict.reason, /runner is absent/i, "the operator-facing reason must name the host gap");
});

test("W1-T3312: a present runner executes from the checkout and genuine test failures remain failures", () => {
  const cwd = checkoutWithPackage();
  const runner = pinnedVitestCli(cwd);
  mkdirSync(join(cwd, "node_modules", "vitest"), { recursive: true });
  writeFileSync(runner, "// fixture runner exists; the injected spawner observes its argv\n");
  const proof = dashboardProof();
  const seen: string[][] = [];
  const passing: ProofSpawner = (_command, args) => {
    seen.push([...args]);
    return "";
  };

  assert.equal(execWhitelistedProof(proof, cwd, 60_000, passing, { preflightBrowsers: () => {} }), "pass");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]![0], runner, "the spawned CLI must be rooted at the checkout being proved");
  assert.notEqual(seen[0]![0], proof.args[0], "the parser process's own checkout must not leak into execution");

  const failing: ProofSpawner = () => {
    const error = Object.assign(new Error("assertion failed"), { status: 1, stdout: "" });
    throw error;
  };
  assert.equal(
    execWhitelistedProof(proof, cwd, 60_000, failing, { preflightBrowsers: () => {} }),
    "fail",
    "the availability guard must not suppress a real nonzero test result once its runner exists",
  );
});
