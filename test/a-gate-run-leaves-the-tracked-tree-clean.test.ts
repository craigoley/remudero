import assert from "node:assert/strict";
import { assertGateProbeRan } from "#test/helpers/gate-probe-evidence.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAST_GATE_STEPS } from "#src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { isolatedCheckout } from "#test/helpers/isolated-checkout.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RATCHET = join(REPO_ROOT, "scripts", "source-size-ratchet.mjs");
const GATE_CHECKOUT = isolatedCheckout(REPO_ROOT);
symlinkSync(join(REPO_ROOT, "node_modules"), join(GATE_CHECKOUT.root, "node_modules"));

after(() => GATE_CHECKOUT.cleanup());

// The detector reads tracked-file state and completed native status. Gate output is not its
// subject: retaining the whole plan census can kill a real child at spawnSync's buffer ceiling.
// W1-T13243: `timeoutMs` is a parameter now; the fixed 120 s below survives only as the FALLBACK.
function runProbe(command: string, args: string[], cwd = GATE_CHECKOUT.root, timeoutMs = FALLBACK_BOUND_MS) {
  return spawnSync(command, args, { cwd, stdio: "ignore", timeout: timeoutMs });
}

/** The fixed bound a step runs under when nothing has been measured on this host (set HERE, W1-T13243). */
const FALLBACK_BOUND_MS = 120_000;
/** The bound's finite upper edge: a step still running here is hung, whatever the host's speed. */
const HANG_CEILING_MS = 900_000;
/** How many times its own measured runtime a step may take in the bounded run. */
const BOUND_MULTIPLE = 3;

interface StepBound {
  ms: number;
  source: "measured" | "fallback";
  measuredMs?: number;
  fallbackMs: number;
  description: string;
}

/**
 * W1-T13243: a step's bound from its OWN measured runtime on this host: the multiple of the
 * measurement, never below the fixed fallback and never above the hang ceiling. No measurement
 * means the fallback. The description names both numbers, so a failure says which bound applied.
 */
function deriveStepBound(
  measuredMs: number | undefined,
  fallbackMs = FALLBACK_BOUND_MS,
  ceilingMs = HANG_CEILING_MS,
  multiple = BOUND_MULTIPLE,
): StepBound {
  if (measuredMs === undefined || !Number.isFinite(measuredMs) || measuredMs <= 0) {
    return { ms: fallbackMs, source: "fallback", fallbackMs, description: `bound ${fallbackMs} ms = the fixed fallback (no measurement on this host)` };
  }
  const ms = Math.min(ceilingMs, Math.max(fallbackMs, Math.ceil(measuredMs * multiple)));
  return {
    ms,
    source: "measured",
    measuredMs,
    fallbackMs,
    description: `bound ${ms} ms = ${multiple} x measured ${Math.round(measuredMs)} ms on this host (fixed fallback ${fallbackMs} ms; ceiling ${ceilingMs} ms)`,
  };
}

interface ProbeDeps {
  run: (command: string, args: string[], timeoutMs: number) => ReturnType<typeof runProbe>;
  now: () => number;
  measured: Map<string, number>;
  fallbackMs: number;
  ceilingMs: number;
}

const MEASURED_STEP_MS = new Map<string, number>();
const REAL_DEPS: ProbeDeps = {
  run: (command, args, timeoutMs) => runProbe(command, args, GATE_CHECKOUT.root, timeoutMs),
  now: Date.now,
  measured: MEASURED_STEP_MS,
  fallbackMs: FALLBACK_BOUND_MS,
  ceilingMs: HANG_CEILING_MS,
};

/**
 * W1-T13243: run one gate step bounded by what it measures on THIS host. A once-per-process
 * calibration run (under the hang ceiling) times the step; the run the caller's detector judges
 * is then bounded by {@link deriveStepBound}. A step that outlives the ceiling is hung and fails
 * here; a step that outlives its derived bound fails naming the bound and where it came from.
 */
function probeStep(label: string, command: string, args: string[], deps: ProbeDeps = REAL_DEPS): StepBound {
  let measuredMs = deps.measured.get(label);
  if (measuredMs === undefined) {
    const t0 = deps.now();
    const calibration = deps.run(command, args, deps.ceilingMs);
    assertGateProbeRan(`${label} (calibration run, hang ceiling ${deps.ceilingMs} ms)`, calibration);
    measuredMs = Math.max(1, deps.now() - t0);
    deps.measured.set(label, measuredMs);
  }
  const bound = deriveStepBound(measuredMs, deps.fallbackMs, deps.ceilingMs);
  assertGateProbeRan(`${label} (${bound.description})`, deps.run(command, args, bound.ms));
  return bound;
}

/**
 * test/a-gate-run-leaves-the-tracked-tree-clean.test.ts — W1-T2791.
 *
 * THE RECORDING FORM STILL EXITS 0 WHILE MUTATING, and W1-T2650 removed the only thing that made
 * that observable. `SCOPE_EXEMPT_GENERATED_ARTIFACTS` (src/lib/review.ts) names
 * `scripts/source-size-baseline.json` and is subtracted by BOTH `scopeGuardOutOfScopeFiles` and
 * `scopeViolationFiles` — which correctly stopped the blocked_review that cost issue #3843, and in
 * doing so removed the guard that used to REFUSE a stray baseline write by name. Nothing objects
 * now.
 *
 * RE-MEASURED BEFORE BUILDING, as this shard's own falsifier demands (it has already been
 * overtaken once, by #3871). On origin/main, over a throwaway root carrying one unrecorded
 * TypeScript source file under `src/`:
 *
 *     recording form (`--baseline <file>`) : exit 0, baseline MUTATED
 *     gate-path form (`source-size-signal`): exit 1, baseline UNCHANGED
 *
 * So the premise holds: the mutation is silent and exit-code-invisible, which is exactly why the
 * assertion below compares `git status --porcelain` BEFORE and AFTER rather than trusting a status.
 *
 * THE DETECTOR MUST NOT BE VACUOUS. Run against the gate path in a tree where nothing would drift,
 * the check passes trivially and forever — the exact vacuity this shard's filing warned against.
 * So it is falsified in the POSITIVE direction too: pointed at the recording form with an
 * unrecorded source file present, it must FAIL and NAME the dirtied path.
 *
 * AND THE PROBE NEVER WRITES INTO THE TRACKED TREE. A detector for tracked-tree mutation that
 * itself mutates the tracked tree is self-refuting; the positive case runs entirely inside a
 * throwaway git repo it creates.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/** `git status --porcelain` for `dir`, as a set of lines — the tree's observable state. */
function porcelain(dir: string): string[] {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: dir, encoding: "utf8", env: GIT_ENV })
    .split("\n")
    .filter(Boolean)
    .sort();
}

/**
 * THE DETECTOR. Snapshot the tree, run `step`, snapshot again, and return the paths that changed
 * — IN PROCESS and by comparison, never by reading the step's exit code, because the defect being
 * guarded is a mutation that exits 0.
 */
function dirtiedBy(dir: string, step: () => void): string[] {
  const before = new Set(porcelain(dir));
  step();
  return porcelain(dir).filter((line) => !before.has(line));
}

// ── acceptance 1: the fast gate's own source-size step leaves the tracked tree byte-identical ──

test("W1-T2791 (acceptance 1): running the fast gate's OWN source-size step leaves the tracked tree byte-identical", () => {
  // THE STEP IS READ FROM THE GATE'S OWN TABLE, never hardcoded — if the `source-size` job is ever
  // re-pointed at a writing form, this test follows it there instead of guarding a name that moved.
  const entry = FAST_GATE_STEPS.find((s) => s.job === "source-size");
  assert.ok(entry, "the fast gate still carries a source-size step");
  assert.equal(entry.script, "source-size-signal", "and it is the non-writing form");

  const dirtied = dirtiedBy(GATE_CHECKOUT.root, () => {
    // The exit code is NOT the assertion — a step that never ran is the only thing probeStep refuses.
    probeStep(entry.script, "npm", ["run", "--silent", entry.script]);
  });
  assert.deepEqual(dirtied, [], "a gate run must leave the tracked tree exactly as it found it");
});

// ── acceptance 3: the SAME assertion, over EVERY step the fast gate runs ──────────────────────

/**
 * Acceptance 1 guards ONE step by name. `comment-load-ratchet` was added to FAST_GATE_STEPS
 * afterwards pointing at its RECORDING form, and nothing objected: every suite run spawned it
 * through `preflight --fast` (test/preflight-is-freshness-exempt-and-scrubs-the-guard-from-
 * children.test.ts drives the real verb), it rewrote scripts/comment-load-baseline.json, and
 * scripts/test-with-retry.mjs reddened the shard as TRACKED-TREE DIRT. Intermittently: the retry
 * re-snapshots a tree the first run already dirtied, so the second pass sees no NEW dirt and
 * passes. A guard scoped to one step cannot see the next step that escapes it, so this one is
 * derived from the table.
 */
test("W1-T2791 (acceptance 3): EVERY step the fast gate runs leaves the tracked tree byte-identical, not just the one guarded by name", () => {
  const offenders: string[] = [];
  for (const entry of FAST_GATE_STEPS) {
    const dirtied = dirtiedBy(GATE_CHECKOUT.root, () => {
      // A step that never RAN dirties nothing and would pass this loop for the wrong reason — the
      // vacuity acceptance 1 guards with the same assertion. Exit code is otherwise not the subject.
      probeStep(entry.script, "npm", ["run", "--silent", entry.script]);
    });
    if (dirtied.length > 0) offenders.push(`${entry.job} (npm run ${entry.script}) dirtied: ${dirtied.join(", ")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `a gate run must leave the tracked tree exactly as it found it, for every step in the table:\n${offenders.join("\n")}`,
  );
});

// ── acceptance 2: the SAME detector, falsified in the positive direction ───────────────────────

test("W1-T2791 (acceptance 2): pointed at the RECORDING form with an unrecorded source file present, the detector FAILS and names the dirtied path", () => {
  // A throwaway git repo, so the probe's fixture never touches the tracked tree — the shard's own
  // falsifier calls a detector that mutates what it guards self-refuting.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gate-tree-clean-`));
  try {
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "source-size-baseline.json"), "{}\n");
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root, env: GIT_ENV });

    // The unrecorded file. Committed, so it is part of the tree the ratchet measures and NOT itself
    // the dirt the detector reports — otherwise the assertion below would pass on the fixture.
    writeFileSync(join(root, "src", "lib", "brand-new-unrecorded.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["commit", "--quiet", "-m", "add an unrecorded source file"], { cwd: root, env: GIT_ENV });
    assert.deepEqual(porcelain(root), [], "fixture: the probe tree starts clean");

    const baseline = join(root, "scripts", "source-size-baseline.json");
    let status: number | null = null;
    const dirtied = dirtiedBy(root, () => {
      const r = spawnSync("node", [RATCHET, "--root", root, "--baseline", baseline], { cwd: root, encoding: "utf8" });
      status = r.status;
    });

    // THE WHOLE POINT, IN TWO ASSERTIONS THAT MUST BOTH HOLD:
    assert.equal(status, 0, "the recording form exits ZERO — which is why an exit code cannot detect this");
    assert.deepEqual(
      dirtied,
      [" M scripts/source-size-baseline.json"],
      "and it mutated a tracked file while doing so — the detector names the path",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2791 (acceptance 2b): the CONTROL — the same probe tree, the gate-path form, leaves it clean", () => {
  // Without this, acceptance 2 could pass because the probe tree is dirty for some reason of its
  // own. Same fixture, same detector, the non-writing form: no dirt.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gate-tree-control-`));
  try {
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "source-size-baseline.json"), "{}\n");
    writeFileSync(join(root, "src", "lib", "brand-new-unrecorded.ts"), "export const x = 1;\n");
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["commit", "--quiet", "-m", "same fixture, no --baseline"], { cwd: root, env: GIT_ENV });
    assert.deepEqual(porcelain(root), []);

    const dirtied = dirtiedBy(root, () => {
      spawnSync("node", [RATCHET, "--root", root], { cwd: root, encoding: "utf8" });
    });
    assert.deepEqual(dirtied, [], "the form the fast gate actually runs never writes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2791: the detector itself is not blind — it reports a mutation made by anything, not only by the ratchet", () => {
  // A detector that only ever reads [] is indistinguishable from one that works. Drive it against
  // a deliberate write so its POSITIVE direction is proven independently of the subject under test.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gate-tree-selftest-`));
  try {
    writeFileSync(join(root, "tracked.txt"), "one\n");
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: root, env: GIT_ENV });
    assert.deepEqual(dirtiedBy(root, () => {}), [], "a no-op step dirties nothing");
    assert.deepEqual(
      dirtiedBy(root, () => writeFileSync(join(root, "tracked.txt"), "two\n")),
      [" M tracked.txt"],
      "and a write is seen, named by path",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("a tracked-tree gate probe completes beyond the capture ceiling and preserves native launch failure", () => {
  const completed = runProbe(process.execPath, ["-e", "process.stderr.write(Buffer.alloc(2 * 1024 * 1024, 120));" ]);
  assert.equal(completed.status, 0); assert.equal(completed.signal, null); assert.equal(completed.error, undefined);
  const refused = runProbe("/nonexistent-remudero-probe-command", []);
  assert.equal(refused.status, null); assert.equal((refused.error as NodeJS.ErrnoException).code, "ENOENT");
});

// ── W1-T13243: each step's bound comes from its own measurement on the host that runs it ───────

/** A fake host: `stepMs` is how long the step takes on it; a run bounded below that is killed like spawnSync does. */
function fakeHost(stepMs: number, effect: () => void = () => {}) {
  let clock = 0;
  const calls: number[] = [];
  const deps: ProbeDeps = {
    run: (_command, _args, timeoutMs) => {
      calls.push(timeoutMs);
      if (stepMs > timeoutMs) {
        clock += timeoutMs;
        const error = Object.assign(new Error("spawnSync npm ETIMEDOUT"), { code: "ETIMEDOUT" });
        return { status: null, signal: "SIGTERM", error } as unknown as ReturnType<typeof runProbe>;
      }
      effect();
      clock += stepMs;
      return { status: 0, signal: null, error: undefined } as unknown as ReturnType<typeof runProbe>;
    },
    now: () => clock,
    measured: new Map(),
    fallbackMs: 120_000,
    ceilingMs: 900_000,
  };
  return { deps, calls };
}

test("W1-T13243 criterion 1: a step slower than the fixed fallback runs under a bound derived from its own measured runtime, where the fixed value would have killed it", () => {
  const slow = fakeHost(132_000);
  const bound = probeStep("lint-plan:fast", "npm", ["run", "--silent", "lint-plan:fast"], slow.deps);
  assert.equal(bound.source, "measured");
  assert.equal(bound.measuredMs, 132_000);
  assert.equal(bound.ms, 396_000, "three times the measured runtime");
  assert.deepEqual(slow.calls, [900_000, 396_000], "calibrated under the hang ceiling, then run under the derived bound");

  // The same host under the fixed value alone is the failure the operator Mac showed.
  const fixed = fakeHost(132_000);
  assert.throws(
    () => assertGateProbeRan("lint-plan:fast", fixed.deps.run("npm", [], 120_000)),
    /lint-plan:fast ran \(status null; signal SIGTERM; code ETIMEDOUT\)/,
  );
});

test("W1-T13243 criterion 1: with no measurement the fixed value is the fallback, and a bound is never below it or above the hang ceiling", () => {
  assert.equal(deriveStepBound(undefined).ms, FALLBACK_BOUND_MS);
  assert.equal(deriveStepBound(undefined).source, "fallback");
  assert.equal(deriveStepBound(Number.NaN).source, "fallback");
  assert.equal(deriveStepBound(5_000).ms, FALLBACK_BOUND_MS, "a fast host keeps the fixed value as the floor");
  assert.equal(deriveStepBound(5_000).source, "measured");
  assert.equal(deriveStepBound(10 * HANG_CEILING_MS).ms, HANG_CEILING_MS, "a bound is finite whatever was measured");
});

test("W1-T13243 criterion 1: the failure message names the derived bound, the measurement it came from and the fixed fallback", () => {
  const host = fakeHost(100_000);
  probeStep("calibrated", "npm", [], host.deps); // calibrates at 100000 ms
  const slowerNow = fakeHost(1_000_000); // the step later outlives its own derived bound
  slowerNow.deps.measured.set("calibrated", 100_000);
  assert.throws(
    () => probeStep("calibrated", "npm", [], slowerNow.deps),
    (error: Error) => {
      assert.match(error.message, /bound 300000 ms = 3 x measured 100000 ms on this host/);
      assert.match(error.message, /fixed fallback 120000 ms/);
      assert.match(error.message, /signal SIGTERM; code ETIMEDOUT/);
      return true;
    },
  );
  // A step with nothing measured names the fallback as the bound's source instead.
  assert.match(deriveStepBound(undefined).description, /the fixed fallback \(no measurement on this host\)/);
});

test("W1-T13243 criterion 2: invariant:a-dirtying-step-still-fails — a step that changes a tracked file is still reported by path, through the derived bound", () => {
  const repo = gitRepo({ kind: "gate-tree-bound" });
  const root = repo.dir;
  try {
    writeFileSync(join(root, "tracked.txt"), "one\n");
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "-m", "seed");
    const host = fakeHost(10_000, () => writeFileSync(join(root, "tracked.txt"), "two\n"));
    const dirtied = dirtiedBy(root, () => {
      probeStep("dirtying", "npm", [], host.deps);
    });
    assert.deepEqual(dirtied, [" M tracked.txt"]);
  } finally {
    repo.cleanup();
  }
});

test("W1-T13243 criterion 2: invariant:a-dirtying-step-still-fails — a step that really hangs is still stopped, by the hang ceiling in calibration and by its derived bound after it", () => {
  const hang = ["-e", "setInterval(() => {}, 1000)"];
  const real = (ceilingMs: number, measured = new Map<string, number>()): ProbeDeps => ({
    run: (command, args, timeoutMs) => runProbe(command, args, REPO_ROOT, timeoutMs),
    now: Date.now,
    measured,
    fallbackMs: 200,
    ceilingMs,
  });
  assert.throws(
    () => probeStep("hangs", process.execPath, hang, real(400)),
    /hangs \(calibration run, hang ceiling 400 ms\) ran \(status null; signal SIGTERM; code ETIMEDOUT\)/,
  );
  // A step measured fast that then hangs is stopped at its derived bound, not left to the ceiling.
  assert.throws(
    () => probeStep("hangs-later", process.execPath, hang, real(60_000, new Map([["hangs-later", 50]]))),
    /hangs-later \(bound 200 ms = 3 x measured 50 ms on this host \(fixed fallback 200 ms; ceiling 60000 ms\)\) ran \(status null; signal SIGTERM/,
  );
});
