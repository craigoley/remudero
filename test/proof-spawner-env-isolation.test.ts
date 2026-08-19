// test/proof-spawner-env-isolation.test.ts — W1-T499
//
// THE MECHANISM THIS CLOSES: `defaultProofSpawner` (src/lib/review.ts) used to call
// `execFileSync(command, args, { cwd, stdio, timeout, encoding })` — WITH NO `env` KEY — so a
// proof's child process inherited `process.env` ENTIRE, exactly as it happened to be shaped by
// whatever process was running the reviewer (a daemon started from a dev shell, a launchd job, a
// bare CLI invocation, or `node --test` itself under CI). `deploy/host-update.sh` sets
// `RMD_RESTART_THROTTLE_S` on the daemon container; it appears in NO `.github/` workflow. So a
// GitHub Actions runner and a reviewer daemon could evaluate the identical sha in genuinely
// different environments and reach opposite verdicts on the same proof — the PR #1830 incident
// this task's rationale documents.
//
// `defaultProofSpawner` now builds its child env from `buildProofEnv` — an ALLOWLIST
// (`PROOF_ENV_ALLOWLIST`), never `process.env` wholesale. These three tests drive the REAL
// exported `defaultProofSpawner`, not a re-implementation of its decision, matching the house
// discipline every sibling proof-executor suite (test/check-proof-executor-parity.test.ts,
// test/check-proof-base.test.ts) already uses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProofEnv, defaultProofSpawner, PROOF_ENV_ALLOWLIST } from "../src/lib/review.js";

/** Run the REAL `defaultProofSpawner` with a tiny node one-liner that dumps its own
 *  `process.env` back out as JSON, and parse the result. */
function spawnAndReadEnv(): Record<string, string | undefined> {
  const out = defaultProofSpawner(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    process.cwd(),
    30_000,
  );
  return JSON.parse(out);
}

// A var shaped exactly like the ones this task's rationale names — set by a daemon/deploy
// script, absent from every CI workflow — mutated onto THIS process's own `process.env` to
// stand in for "the orchestrator that happens to be running the reviewer". `defaultProofSpawner`
// takes no env override parameter (matching the real `ProofSpawner` signature every caller uses),
// so exercising the real leak/no-leak boundary means mutating the real `process.env` the way a
// contaminated daemon shell would, and restoring it in `finally`.
const CANARY_VAR = "RMD_RESTART_THROTTLE_S";

function withCanary<T>(value: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, CANARY_VAR);
  const saved = process.env[CANARY_VAR];
  try {
    if (value === undefined) delete process.env[CANARY_VAR];
    else process.env[CANARY_VAR] = value;
    return fn();
  } finally {
    if (had) process.env[CANARY_VAR] = saved;
    else delete process.env[CANARY_VAR];
  }
}

test("a proof executes in a declared environment rather than inheriting the orchestrator's", () => {
  const childEnv = withCanary("2", () => spawnAndReadEnv());
  assert.equal(
    childEnv[CANARY_VAR],
    undefined,
    `${CANARY_VAR} is on the ALLOWLIST for nothing — a proof's child must never see a var the ` +
      "orchestrator merely happens to carry",
  );
  // Not a one-var spot check: NOTHING outside the declared allowlist survives, however this
  // process's own env happens to be shaped when the suite runs.
  const leaked = Object.keys(childEnv).filter((k) => !(PROOF_ENV_ALLOWLIST as readonly string[]).includes(k));
  assert.deepEqual(leaked, [], "every key in the child's env must be a member of PROOF_ENV_ALLOWLIST");
});

test("the variables these suites genuinely need still reach the child", () => {
  assert.ok(process.env.PATH, "precondition: this process itself has a PATH");
  assert.ok(process.env.HOME, "precondition: this process itself has a HOME");
  const childEnv = spawnAndReadEnv();
  assert.equal(childEnv.PATH, process.env.PATH, "PATH must reach the child unchanged — node/npm/grep/playwright resolve through it");
  assert.equal(childEnv.HOME, process.env.HOME, "HOME must reach the child unchanged — npm/git config and cache resolution need it");
  // The declared allowlist itself must actually name PATH and HOME, not merely happen to pass
  // them through some other mechanism.
  assert.ok(PROOF_ENV_ALLOWLIST.includes("PATH"));
  assert.ok(PROOF_ENV_ALLOWLIST.includes("HOME"));
});

test("the same sha reviewed under two different orchestrator environments reaches the same verdict", () => {
  // Orchestrator A: a daemon-shaped environment carrying the exact var deploy/host-update.sh
  // passes into the container (present on no CI runner).
  const envA = withCanary("2", () => buildProofEnv(process.env));
  // Orchestrator B: a CI-shaped environment — GitHub Actions' own ambient vars, and the daemon
  // var absent entirely, matching the MEASURED positive control (GH_TOKEN/GITHUB_TOKEN found in
  // .github/, RMD_RESTART_THROTTLE_S found in none).
  const ciLikeParent: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
  };
  delete ciLikeParent[CANARY_VAR];
  const envB = buildProofEnv(ciLikeParent);

  assert.deepEqual(
    envA,
    envB,
    "the declared proof env must be BYTE-IDENTICAL whether the orchestrator is a daemon " +
      "carrying its own RMD_* vars or a CI runner carrying GitHub Actions' own ambient vars — " +
      "that identity is what makes the same sha reach the same verdict under either one",
  );

  // And the same holds for what a proof's CHILD PROCESS actually observes end to end, not just
  // the intermediate `buildProofEnv` object: spawn for real under each simulated orchestrator and
  // diff the two observed environments directly.
  const observedA = withCanary("2", () => spawnAndReadEnv());
  const observedB = withCanary(undefined, () => {
    process.env.CI = "true";
    try {
      return spawnAndReadEnv();
    } finally {
      delete process.env.CI;
    }
  });
  assert.deepEqual(observedA, observedB, "a proof's child process must observe the identical declared env either way");
});
