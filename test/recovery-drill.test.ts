import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/recovery-drill.mjs"` is a TS7016 — the same reason
// test/clock-sweep.test.ts reaches its script through a runtime import rather than a typed one.
// A dynamic specifier is not statically resolved, so this loads the REAL module, with no shadow
// copy to drift from it.
const DRILL_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "recovery-drill.mjs"),
).href;

type ExerciseResult = { ran: boolean; healthy?: boolean; detail?: string; reason?: string };

const mod = (await import(DRILL_URL)) as {
  RECOVERY_PATHS: Array<{ key: string; label: string; exercise: (mode: "healthy" | "sabotaged") => unknown }>;
  withFixtureDir: (prefix: string, body: (dir: string) => ExerciseResult) => ExerciseResult;
  exerciseStaleLockReclaim: (mode: "healthy" | "sabotaged") => ExerciseResult;
  exerciseCircuitBreakerReset: (mode: "healthy" | "sabotaged", opts?: { maxDispatches?: number }) => ExerciseResult;
  exerciseDeployRollback: (mode: "healthy" | "sabotaged") => ExerciseResult;
  exerciseKeychainReprovision: (mode: "healthy" | "sabotaged", opts?: { faultStep?: string }) => ExerciseResult;
  exerciseSpawnPreflightHusk: (mode: "healthy" | "sabotaged") => ExerciseResult;
  exerciseTornLedgerIndeterminate: (mode: "healthy" | "sabotaged", opts?: { maxDispatches?: number }) => ExerciseResult;
  exerciseGithubGatewayDegrade: (mode: "healthy" | "sabotaged") => ExerciseResult;
  exerciseDirtyTreeProceeds: (mode: "healthy" | "sabotaged") => ExerciseResult;
  exerciseOrphanSweepSigkill: (mode: "healthy" | "sabotaged") => ExerciseResult;
  runDrill: (paths?: typeof mod.RECOVERY_PATHS) => {
    ok: boolean;
    results: Array<{
      key: string;
      label: string;
      healthyRun: { ran: boolean; healthy?: boolean; detail?: string; reason?: string };
      sabotagedRun: { ran: boolean; healthy?: boolean; detail?: string; reason?: string };
      bothRan: boolean;
      discriminates: boolean;
    }>;
  };
  renderReport: (outcome: ReturnType<typeof mod.runDrill>, log: (m: string) => void) => void;
  main: (opts?: { log?: (m: string) => void }) => number;
};
const {
  RECOVERY_PATHS,
  withFixtureDir,
  exerciseStaleLockReclaim,
  exerciseCircuitBreakerReset,
  exerciseDeployRollback,
  exerciseKeychainReprovision,
  exerciseSpawnPreflightHusk,
  exerciseTornLedgerIndeterminate,
  exerciseGithubGatewayDegrade,
  exerciseDirtyTreeProceeds,
  exerciseOrphanSweepSigkill,
  runDrill,
  renderReport,
  main,
} = mod;

// ── W1-T366 — the falsifier both directions: a healthy fixture must read healthy, and a
// sabotaged one must read unhealthy, for EACH of the four named recovery paths, exercised
// against real throwaway fixtures (real fs, real git, a real ledger file, a fake-but-realistic
// security(1) runner) — never a fake reimplementation of the recovery logic itself. ─────────────

test("stale-lock reclaim: a genuinely dead holder's lock is reclaimed AND the fixture proves it via a real fs read", () => {
  const healthy = exerciseStaleLockReclaim("healthy");
  assert.equal(healthy.ran, true);
  assert.equal(healthy.healthy, true, healthy.detail);
});

test("stale-lock reclaim: a misjudged (sabotaged) staleness check leaves the lock in place — reported unhealthy, not silently clean", () => {
  const sabotaged = exerciseStaleLockReclaim("sabotaged");
  assert.equal(sabotaged.ran, true);
  assert.equal(sabotaged.healthy, false, sabotaged.detail);
});

test("circuit breaker reset: real forward progress (a real pr.opened ledger line) clears a real tripped breaker", () => {
  const healthy = exerciseCircuitBreakerReset("healthy");
  assert.equal(healthy.ran, true);
  assert.equal(healthy.healthy, true, healthy.detail);
});

test("circuit breaker reset: a torn ledger read that drops the pr.opened line leaves the breaker tripped — reported unhealthy", () => {
  const sabotaged = exerciseCircuitBreakerReset("sabotaged");
  assert.equal(sabotaged.ran, true);
  assert.equal(sabotaged.healthy, false, sabotaged.detail);
});

test("deploy rollback: a real throwaway git fixture rolls back to the observed-good sha, verified by an independent git rev-parse", { timeout: 20_000 }, () => {
  const healthy = exerciseDeployRollback("healthy");
  assert.equal(healthy.ran, true);
  assert.equal(healthy.healthy, true, healthy.detail);
});

test("deploy rollback: no observed-good boot recorded (the actual 2026-08-05 shape) leaves HEAD on the bad sha — reported unhealthy", { timeout: 20_000 }, () => {
  const sabotaged = exerciseDeployRollback("sabotaged");
  assert.equal(sabotaged.ran, true);
  assert.equal(sabotaged.healthy, false, sabotaged.detail);
});

test("keychain re-provision: a fixture security runner provisions the throwaway store, verified by a real fs read of the store file", () => {
  const healthy = exerciseKeychainReprovision("healthy");
  assert.equal(healthy.ran, true);
  assert.equal(healthy.healthy, true, healthy.detail);
});

test("keychain re-provision: a failing add-generic-password throws a named WorkerKeychainError — never a silent 'provisioned: true'", () => {
  const sabotaged = exerciseKeychainReprovision("sabotaged");
  assert.equal(sabotaged.ran, true);
  assert.equal(sabotaged.healthy, false, sabotaged.detail);
});

// ── W1-T938 — the SAME falsifier, both directions, for the five GUARDS that carried this fleet
// through its past incidents but had never run on a cadence: the spawn preflight husk check, the
// torn-ledger-tail indeterminate projection, the GitHub-gateway degrade, the dirty-tree PROCEED,
// and the orphan sweep's real SIGKILL. ──────────────────────────────────────────────────────────

test("spawn preflight husk: a real non-executable claude husk is refused with the EACCES reason class named, distinguishing it from a crashing binary", () => {
  const healthy = exerciseSpawnPreflightHusk("healthy");
  assert.equal(healthy.ran, true);
  assert.equal(healthy.healthy, true, healthy.detail);
});

test("spawn preflight husk: an executability probe that swallows its errno (the pre-W1-T901 shape) loses the EACCES reason class — reported unhealthy", () => {
  const sabotaged = exerciseSpawnPreflightHusk("sabotaged");
  assert.equal(sabotaged.ran, true);
  assert.equal(sabotaged.healthy, false, sabotaged.detail);
});

test("torn ledger tail: a real ledger file torn on disk mid-line, whose count regresses with no pr.opened to explain it, reads indeterminate — never a false clear", () => {
  const healthy = exerciseTornLedgerIndeterminate("healthy");
  assert.equal(healthy.ran, true);
  assert.equal(healthy.healthy, true, healthy.detail);
});

test("torn ledger tail: a stale reader that never observed the tear masks the regression — reported unhealthy, the guard going quiet caught", () => {
  const sabotaged = exerciseTornLedgerIndeterminate("sabotaged");
  assert.equal(sabotaged.ran, true);
  assert.equal(sabotaged.healthy, false, sabotaged.detail);
});

test("GitHub gateway degrade: a gateway that genuinely reports its read failed is marked indeterminate with a named reason — never rendered as a confirmed 'no PR'", () => {
  const healthy = exerciseGithubGatewayDegrade("healthy");
  assert.equal(healthy.ran, true);
  assert.equal(healthy.healthy, true, healthy.detail);
});

test("GitHub gateway degrade: the same outage disguised as a successful empty read renders a false 'no PR' — reported unhealthy", () => {
  const sabotaged = exerciseGithubGatewayDegrade("sabotaged");
  assert.equal(sabotaged.ran, true);
  assert.equal(sabotaged.healthy, false, sabotaged.detail);
});

test("dirty daemon tree proceeds: a real dirtied tracked file is ledgered as daemon.tree_dirty and the service call returns (proceeds), never refuses", () => {
  const healthy = exerciseDirtyTreeProceeds("healthy");
  assert.equal(healthy.ran, true);
  assert.equal(healthy.healthy, true, healthy.detail);
});

test("dirty daemon tree proceeds: a predicate made to refuse instead of assess is caught — a refusal here is the crash-loop shape this guard exists to avoid", () => {
  const sabotaged = exerciseDirtyTreeProceeds("sabotaged");
  assert.equal(sabotaged.ran, true);
  assert.equal(sabotaged.healthy, false, sabotaged.detail);
});

test("orphan sweep SIGKILL: a real spawned-then-SIGKILLed stray is reported killed AND independently re-verified dead via a real ps scan", () => {
  const healthy = exerciseOrphanSweepSigkill("healthy");
  assert.equal(healthy.ran, true);
  assert.equal(healthy.healthy, true, healthy.detail);
});

test("orphan sweep SIGKILL: a no-op kill still reports 'killed' but the real process survives — a false clean caught by the independent re-check", () => {
  const sabotaged = exerciseOrphanSweepSigkill("sabotaged");
  assert.equal(sabotaged.ran, true);
  assert.equal(sabotaged.healthy, false, sabotaged.detail);
});

// ── Each exercise's own "cannot run at all" branches, hit directly rather than only through
// the orchestrator's synthetic-path tests below — these are the real fixture-init failure paths
// (fixture dir creation, git absence, an unreachable breaker precondition, an unexpected
// keychain failure class), not a stand-in for them. ────────────────────────────────────────────

test("withFixtureDir: a fixture directory that cannot be created (no such parent dir) reports UNREACHABLE, not a crash", () => {
  const result = withFixtureDir(join("does-not-exist-xyz-recovery-drill", "prefix-"), () => ({ ran: true, healthy: true, detail: "unreachable in practice" }));
  assert.equal(result.ran, false);
  assert.match(result.reason ?? "", /could not create the fixture directory/);
});

test("withFixtureDir: the fixture directory is torn down even when the body throws, and the throw is reported UNREACHABLE rather than propagated", () => {
  const dirs: string[] = [];
  const result = withFixtureDir("recovery-drill-cov-", (dir) => {
    dirs.push(dir);
    throw new Error("simulated fixture body failure");
  });
  assert.equal(result.ran, false);
  assert.match(result.reason ?? "", /simulated fixture body failure/);
  assert.equal(dirs.length, 1);
});

test("circuit breaker reset: a fixture whose precondition never trips the breaker is reported UNREACHABLE, not silently skipped", () => {
  // A maxDispatches far above the fixture's five run.start lines means the trip-check itself
  // never fires "tripped" — the guard this drill uses to refuse exercising a reset that was
  // never armed in the first place.
  const result = exerciseCircuitBreakerReset("healthy", { maxDispatches: 999 });
  assert.equal(result.ran, false);
  assert.match(result.reason ?? "", /did not trip the breaker/);
});

test("deploy rollback: git genuinely unavailable (PATH has none) is reported UNREACHABLE, not a false pass or a crash", () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const result = exerciseDeployRollback("healthy");
    assert.equal(result.ran, false);
    assert.match(result.reason ?? "", /git unavailable or fixture init failed/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("torn ledger tail: a fixture whose baseline never trips is reported UNREACHABLE, not silently skipped", () => {
  // A maxDispatches far above the fixture's seven run.start lines means the FIRST (baseline)
  // read never fires "tripped" — the guard this drill uses to refuse exercising a regression
  // check whose prior observation was never armed in the first place.
  const result = exerciseTornLedgerIndeterminate("healthy", { maxDispatches: 999 });
  assert.equal(result.ran, false);
  assert.match(result.reason ?? "", /did not first observe a tripped baseline/);
});

test("dirty daemon tree proceeds: git genuinely unavailable (PATH has none) is reported UNREACHABLE, not a false pass or a crash", () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const result = exerciseDirtyTreeProceeds("healthy");
    assert.equal(result.ran, false);
    assert.match(result.reason ?? "", /git unavailable or fixture init failed/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("keychain re-provision: sabotaging a DIFFERENT step (find-generic-password, a locked login keychain) still reports unhealthy — 'healthy' means the goal was reached, not merely which class was thrown", () => {
  // The default sabotage breaks `add-generic-password` (-> reasonClass "provision-failed").
  // Breaking `find-generic-password` instead simulates a LOCKED login keychain
  // (-> reasonClass "login-keychain-locked") — a real, differently-named failure. The store was
  // still not provisioned either way, so `healthy` stays false for the same reason it does under
  // the default sabotage; the detail line is what distinguishes WHICH named class fired.
  const result = exerciseKeychainReprovision("sabotaged", { faultStep: "find-generic-password" });
  assert.equal(result.ran, true);
  assert.equal(result.healthy, false, result.detail);
  assert.match(result.detail ?? "", /not the expected named class/);
});

// ── The orchestrator's own classification logic, driven with synthetic exercisers so the
// "cannot run" shape and the pass/fail shape are each asserted in isolation, not only through
// the four real (and comparatively slow) paths above. ──────────────────────────────────────────

function fakePath(key: string, healthyResult: unknown, sabotagedResult: unknown) {
  let call = 0;
  return {
    key,
    label: `fixture path ${key}`,
    exercise: () => {
      call++;
      return call === 1 ? healthyResult : sabotagedResult;
    },
  };
}

test("runDrill: a path whose healthy run is healthy AND whose sabotaged run is unhealthy discriminates (PASS)", () => {
  const outcome = runDrill([fakePath("p", { ran: true, healthy: true, detail: "ok" }, { ran: true, healthy: false, detail: "caught" })]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results[0].discriminates, true);
  assert.equal(outcome.results[0].bothRan, true);
});

test("runDrill: a path that reports healthy for BOTH modes never passes — a rubber-stamp drill must be caught", () => {
  const outcome = runDrill([fakePath("always-healthy", { ran: true, healthy: true, detail: "ok" }, { ran: true, healthy: true, detail: "ok" })]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.results[0].discriminates, false);
});

test("runDrill: a path whose healthy run itself reports unhealthy never passes, even if the sabotaged run is caught", () => {
  const outcome = runDrill([fakePath("broken-healthy", { ran: true, healthy: false, detail: "?" }, { ran: true, healthy: false, detail: "caught" })]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.results[0].discriminates, false);
});

test("runDrill: a path whose exercise fn cannot run at all is UNREACHABLE, not counted as discriminating, and never mistaken for a pass or a fail", () => {
  const outcome = runDrill([fakePath("cannot-run", { ran: false, reason: "no git on PATH" }, { ran: false, reason: "no git on PATH" })]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.results[0].bothRan, false);
  assert.equal(outcome.results[0].discriminates, false);
});

test("runDrill: a path whose exercise fn throws is treated as unreachable, never crashes the whole drill", () => {
  const throwing = {
    key: "throws",
    label: "throws",
    exercise: () => {
      throw new Error("boom");
    },
  };
  const outcome = runDrill([throwing]);
  assert.equal(outcome.results[0].bothRan, false);
  assert.match(outcome.results[0].healthyRun.reason ?? "", /boom/);
});

test("renderReport: an UNREACHABLE path's report line is textually distinct from a ran-and-failed path's — 'no output is never read as success', and neither is 'ran but broken' read as 'could not run'", () => {
  const outcome = runDrill([
    fakePath("unreachable-path", { ran: false, reason: "fixture setup failed" }, { ran: false, reason: "fixture setup failed" }),
    fakePath("ran-and-failed", { ran: true, healthy: true, detail: "ok" }, { ran: true, healthy: true, detail: "sabotage missed" }),
  ]);
  const lines: string[] = [];
  renderReport(outcome, (m) => lines.push(m));
  const text = lines.join("\n");
  assert.match(text, /UNREACHABLE/);
  // The unreachable path's own block carries the distinct marker; the ran-and-failed path's own
  // block never does — grabbing each path's slice keeps this from accidentally matching across
  // both entries.
  const unreachableBlock = text.slice(text.indexOf("unreachable-path"), text.indexOf("ran-and-failed"));
  const ranFailedBlock = text.slice(text.indexOf("ran-and-failed"));
  assert.match(unreachableBlock, /UNREACHABLE/);
  assert.doesNotMatch(ranFailedBlock, /UNREACHABLE/);
  assert.match(ranFailedBlock, /FAIL/);
});

test("main: exits 0 when every real path — recovery and guard alike — discriminates healthy from sabotaged, and the report names all nine", { timeout: 60_000 }, () => {
  const lines: string[] = [];
  const code = main({ log: (m) => lines.push(m) });
  const text = lines.join("\n");
  assert.equal(code, 0, text);
  for (const p of RECOVERY_PATHS) {
    assert.match(text, new RegExp(p.key));
  }
  assert.match(text, /^PASS/m);
});

test("RECOVERY_PATHS: exactly the nine candidates the ruling names (four recovery paths, five guards), each with a distinct key", () => {
  const keys = RECOVERY_PATHS.map((p) => p.key).sort();
  assert.deepEqual(keys, [
    "circuit-breaker-reset",
    "deploy-rollback",
    "dirty-tree-proceeds",
    "github-gateway-degrade",
    "keychain-reprovision",
    "orphan-sweep-sigkill",
    "spawn-preflight-husk",
    "stale-lock-reclaim",
    "torn-ledger-indeterminate",
  ]);
});
