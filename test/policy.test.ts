import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  clearDailyCostCeilingOverride,
  dailyCostCeilingOverridePath,
  loadPolicy,
  parseOrigin,
  policyPath,
  PolicyError,
  resolveDailyCostCeiling,
  validatePolicy,
  writeDailyCostCeilingOverride,
  type Policy,
} from "../src/lib/policy.js";
import { lintPlanCommand } from "../src/run-task.js";
// The SOURCE constants plan/policy.yaml claims to lift — imported so the drift lock below
// compares against the real thing, never a second copy of the literal.
//
// `proofTimeoutMs` is deliberately ABSENT from this list: W1-T253 replaced review.ts's
// `DEFAULT_PROOF_TIMEOUT_MS` literal with a read of the policy itself, so there is no source
// constant left to compare against and drift is structurally unreachable for that field. See
// the drift lock's own note below and test/policy-consumers.test.ts, which asserts the
// stronger property (the executor's effective timeout IS the policy value).
import { DEFAULT_PRUNE_GRACE_MS } from "../src/lib/worker.js";
import { buildDefaultHeadroomPolicy, DEFAULT_POLL_INTERVAL_MS } from "../src/lib/daemon.js";
import { fixStrikeCap } from "../src/lib/config.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { DEFAULT_MAX } from "../src/lib/drain.js";
import { HEADROOM_LIMIT_PCT } from "../src/lib/headroom.js";
import { DEFAULT_RETRO_MERGES_THRESHOLD, DEFAULT_RETRO_DAYS_THRESHOLD } from "../src/lib/retro.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED = policyPath(REPO_ROOT);

/** A minimal, valid `plan/tasks.yaml` body — just enough for `loadPlan` to accept it;
 *  these lint-plan integration tests are about `plan/policy.yaml`, not task shape. */
const MINIMAL_VALID_TASKS_YAML =
  "- id: FIXTURE-T1\n  title: policy lint fixture\n  repo: remudero\n  type: implement\n  origin: architect\n  risk: medium\n";

/** Build a fixture `<dir>/plan/{tasks.yaml,policy.yaml}` pair — `tasks.yaml` always
 *  minimal-valid, `policy.yaml` the caller's raw table — and return the tasks.yaml path
 *  `lintPlanCommand(["--plan", ...])` should be pointed at (its sibling policy.yaml is
 *  what `lintPlanCommand` itself resolves and checks, per W1-T252). Fixtures live UNDER
 *  the repo root (test/.tmp-w1-t252-lint-*) so they are never refused as "outside root".
 */
function lintFixture(policyRaw: Record<string, unknown>): { tasksPath: string; dir: string } {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t252-lint-"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  const tasksPath = join(dir, "plan", "tasks.yaml");
  writeFileSync(tasksPath, MINIMAL_VALID_TASKS_YAML, "utf8");
  writeFileSync(join(dir, "plan", "policy.yaml"), stringifyYaml(policyRaw), "utf8");
  return { tasksPath, dir };
}

async function runLintPlanCapturingStderr(tasksPath: string): Promise<{ exitCode: number; stderr: string }> {
  const origError = console.error;
  const origLog = console.log;
  const origWarn = console.warn;
  const errors: string[] = [];
  console.error = (m: string) => errors.push(m);
  console.log = () => {};
  console.warn = () => {};
  try {
    const exitCode = await lintPlanCommand(["--plan", tasksPath]);
    return { exitCode, stderr: errors.join("\n") };
  } finally {
    console.error = origError;
    console.log = origLog;
    console.warn = origWarn;
  }
}

/** A minimal, VALID raw table mirroring the shipped plan/policy.yaml shape — the base every
 *  negative-case test below mutates one field of. */
function goodRaw(): Record<string, unknown> {
  return {
    proofTimeoutMs: { value: 60_000, origin: "lifted:src/lib/review.ts:675 (DEFAULT_PROOF_TIMEOUT_MS)", min: 60_000, max: 300_000 },
    pruneGraceMs: { value: 120_000, origin: "lifted:src/lib/worker.ts:1243 (DEFAULT_PRUNE_GRACE_MS)", min: 30_000, max: 900_000 },
    pollIntervalMs: { value: 60_000, origin: "lifted:src/lib/daemon.ts:87 (DEFAULT_POLL_INTERVAL_MS)", min: 5_000, max: 600_000 },
    fixStrikeCap: { value: 2, origin: "lifted:src/lib/config.ts:218 (fixStrikeCap default)", min: 1, max: 10 },
    sweep: {
      staleDays: { value: 14, origin: "lifted:src/lib/sweep.ts:254 (DEFAULT_SWEEP_POLICY.staleDays)", min: 1, max: 90 },
      strikeCap: { value: 2, origin: "lifted:src/lib/sweep.ts:255 (DEFAULT_SWEEP_POLICY.strikeCap)", min: 1, max: 10 },
      wipLimit: { value: 10, origin: "lifted:src/lib/sweep.ts:257 (DEFAULT_SWEEP_POLICY.wipLimit)", min: 1, max: 50 },
      tmpMaxAgeMs: { value: 3_600_000, origin: "net-new", min: 60_000, max: 86_400_000 },
      dispatchLanes: { value: 2, origin: "lifted:src/lib/sweep.ts:359 (DEFAULT_SWEEP_POLICY.dispatchLanes)", min: 1, max: 4 },
      dailyCostCeilingUsd: { value: 500, origin: "lifted:src/lib/sweep.ts:365 (DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd)", min: 100, max: 2500 },
    },
    drain: {
      max: { value: 10, origin: "lifted:src/lib/drain.ts:243 (DEFAULT_MAX)", min: 1, max: 100 },
    },
    retro: {
      mergesThreshold: { value: 25, origin: "lifted:src/lib/retro.ts:2299 (DEFAULT_RETRO_MERGES_THRESHOLD)", min: 1, max: 100 },
      daysThreshold: { value: 7, origin: "lifted:src/lib/retro.ts:2304 (DEFAULT_RETRO_DAYS_THRESHOLD)", min: 1, max: 90 },
    },
    headroom: {
      curve: {
        value: [
          { maxHoursToReset: 24, limitPct: 100 },
          { maxHoursToReset: null, limitPct: 95 },
        ],
        origin: "lifted:src/lib/daemon.ts:145-148 (buildDefaultHeadroomPolicy)",
      },
      reservePct: { value: 95, origin: "lifted:src/lib/headroom.ts:119 (HEADROOM_LIMIT_PCT)", min: 50, max: 100 },
      enabled: { value: true, origin: "lifted:src/lib/daemon.ts:968 (headroomEnabled default)" },
    },
    launchd: {
      throttleIntervalS: { value: 60, origin: "net-new", min: 10, max: 3600 },
    },
    scratchReap: {
      enabled: { value: false, origin: "net-new" },
      maxAgeHours: {
        value: 24,
        origin: "lifted:src/lib/worker-scratch.ts (DEFAULT_SCRATCH_SWEEP_MAX_AGE_MS = 24h)",
        min: 4,
        max: 168,
      },
    },
  };
}

function throwsPolicyError(fn: () => unknown, msgRe: RegExp): void {
  assert.throws(
    fn,
    (e: unknown) => e instanceof PolicyError && msgRe.test((e as Error).message),
  );
}

// ── acceptance 1: lifts the CURRENT source values, rejects the 30000 regression ────────────

test("the SHIPPED plan/policy.yaml loads and lifts the current source values", () => {
  const p = loadPolicy(SHIPPED);
  assert.equal(p.values.proofTimeoutMs, 60_000);
  assert.equal(p.values.pruneGraceMs, 120_000);
  assert.equal(p.values.pollIntervalMs, 60_000);
  assert.equal(p.values.fixStrikeCap, 2);
  assert.deepEqual(p.values.sweep, {
    staleDays: 14,
    strikeCap: 2,
    wipLimit: 10,
    tmpMaxAgeMs: 3_600_000,
    dispatchLanes: 1,
    dailyCostCeilingUsd: 500,
  });
  assert.equal(p.values.drain.max, 10);
  assert.deepEqual(p.values.retro, { mergesThreshold: 25, daysThreshold: 7 });
  assert.deepEqual(p.values.headroom.curve, [
    { maxHoursToReset: 24, limitPct: 100 },
    { maxHoursToReset: null, limitPct: 95 },
  ]);
  assert.equal(p.values.headroom.reservePct, 95);
  assert.equal(p.values.headroom.enabled, true);
});

// ── the DRIFT LOCK (W1-T252 follow-up) ─────────────────────────────────────────────────────
//
// The test above asserts the shipped values against LITERALS, which cannot detect the one
// failure that matters: a source constant moving while policy.yaml keeps the old number. Its
// title claims the values track source; only this test actually checks it, by comparing each
// LIFTED field against the real exported constant it cites. W1-T253 rewires every consumer to
// read these values instead of its literal, so a silently-stale row here becomes a silent
// behaviour change there — the drift must fail RED at the moment the source moves, in the PR
// that moves it, not later.
//
// `headroom.enabled` is deliberately absent: its source is an inline `opts.headroomEnabled ??
// true` default (src/lib/daemon.ts), not a named constant, so there is nothing to import. It
// stays covered by the literal assertion above; naming that gap is better than implying the
// lock is total.

test("every LIFTED policy value equals the SOURCE constant it cites — the drift lock", () => {
  const p = loadPolicy(SHIPPED).values;
  // proofTimeoutMs is NOT asserted here — W1-T253 removed review.ts's literal in favour of a
  // read of this very file, so a comparison would be against nothing (and drift is impossible
  // once the code reads the policy). Consumed-from-policy is proved in policy-consumers.test.ts.
  assert.equal(p.pruneGraceMs, DEFAULT_PRUNE_GRACE_MS, "pruneGraceMs drifted from worker.ts's DEFAULT_PRUNE_GRACE_MS");
  assert.equal(p.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs drifted from daemon.ts's DEFAULT_POLL_INTERVAL_MS");
  assert.equal(p.fixStrikeCap, fixStrikeCap({ claudeBin: "/bin/true", root: "/nonexistent" }), "fixStrikeCap drifted from config.ts's fixStrikeCap default");
  assert.equal(p.sweep.staleDays, DEFAULT_SWEEP_POLICY.staleDays, "sweep.staleDays drifted from sweep.ts's DEFAULT_SWEEP_POLICY");
  assert.equal(p.sweep.strikeCap, DEFAULT_SWEEP_POLICY.strikeCap, "sweep.strikeCap drifted from sweep.ts's DEFAULT_SWEEP_POLICY");
  assert.equal(p.sweep.wipLimit, DEFAULT_SWEEP_POLICY.wipLimit, "sweep.wipLimit drifted from sweep.ts's DEFAULT_SWEEP_POLICY");
  assert.equal(p.sweep.dispatchLanes, DEFAULT_SWEEP_POLICY.dispatchLanes, "sweep.dispatchLanes drifted from sweep.ts's DEFAULT_SWEEP_POLICY");
  assert.equal(
    p.sweep.dailyCostCeilingUsd,
    DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd,
    "sweep.dailyCostCeilingUsd drifted from sweep.ts's DEFAULT_SWEEP_POLICY",
  );
  assert.equal(p.drain.max, DEFAULT_MAX, "drain.max drifted from drain.ts's DEFAULT_MAX");
  assert.equal(
    p.retro.mergesThreshold,
    DEFAULT_RETRO_MERGES_THRESHOLD,
    "retro.mergesThreshold drifted from retro.ts's DEFAULT_RETRO_MERGES_THRESHOLD",
  );
  assert.equal(
    p.retro.daysThreshold,
    DEFAULT_RETRO_DAYS_THRESHOLD,
    "retro.daysThreshold drifted from retro.ts's DEFAULT_RETRO_DAYS_THRESHOLD",
  );
  assert.equal(p.headroom.reservePct, HEADROOM_LIMIT_PCT, "headroom.reservePct drifted from headroom.ts's HEADROOM_LIMIT_PCT");
  // The curve is the same shape with `Infinity` written as `null` in YAML (policy.ts's documented
  // mapping), so compare rung-for-rung with that one substitution applied.
  const sourceCurve = buildDefaultHeadroomPolicy().map((r) => ({
    maxHoursToReset: Number.isFinite(r.maxHoursToReset) ? r.maxHoursToReset : null,
    limitPct: r.limitPct,
  }));
  assert.deepEqual(p.headroom.curve, sourceCurve, "headroom.curve drifted from daemon.ts's buildDefaultHeadroomPolicy");
});

test("validatePolicy accepts a correctly-shaped table (the goodRaw() fixture)", () => {
  assert.doesNotThrow(() => validatePolicy(goodRaw()));
});

test("REJECTS a fixture whose proof timeout is the stale, predating 30000 (the operator's falsifier)", () => {
  const raw = goodRaw();
  (raw.proofTimeoutMs as Record<string, unknown>).value = 30_000;
  throwsPolicyError(() => validatePolicy(raw), /proofTimeoutMs\.value.*out of its declared bound/);
});

test("the SHIPPED file's proofTimeoutMs.min is itself pinned at 60000 — the regression floor ships in the committed data, not just a fixture's choice", () => {
  const rawShipped = parseYaml(readFileSync(SHIPPED, "utf8")) as Record<string, { min: number }>;
  assert.equal(rawShipped.proofTimeoutMs.min, 60_000);
  // And the loader enforces that committed floor: a fixture copying the shipped bounds but
  // carrying the stale 30000 value still fails (re-proves the operator's falsifier end to end).
  const raw = goodRaw();
  (raw.proofTimeoutMs as Record<string, unknown>).value = 30_000;
  throwsPolicyError(() => validatePolicy(raw), /proofTimeoutMs\.value.*out of its declared bound/);
});

// ── acceptance 2: every field carries a schema bound; an out-of-bounds value is REFUSED ────

test("REJECTS an out-of-bounds value, naming the field", () => {
  const raw = goodRaw();
  (raw.fixStrikeCap as Record<string, unknown>).value = 999;
  throwsPolicyError(() => validatePolicy(raw), /fixStrikeCap\.value.*out of its declared bound/);
});

test("ACCEPTS an in-bounds edit with zero other changes", () => {
  const raw = goodRaw();
  (raw.sweep as Record<string, Record<string, unknown>>).staleDays.value = 21;
  const p = validatePolicy(raw);
  assert.equal(p.values.sweep.staleDays, 21);
});

test("REJECTS a nested sweep field out of bounds, naming its dotted path", () => {
  const raw = goodRaw();
  (raw.sweep as Record<string, Record<string, unknown>>).wipLimit.value = 0;
  throwsPolicyError(() => validatePolicy(raw), /sweep\.wipLimit\.value.*out of its declared bound/);
});

// W1-T320: sweep.tmpMaxAgeMs is a bounded row like its three sweep.* siblings above — same
// falsifier shape, proving the bound actually binds rather than accepting any number.
test("REJECTS sweep.tmpMaxAgeMs out of its declared bound, naming its dotted path", () => {
  const raw = goodRaw();
  (raw.sweep as Record<string, Record<string, unknown>>).tmpMaxAgeMs.value = 999_999_999;
  throwsPolicyError(() => validatePolicy(raw), /sweep\.tmpMaxAgeMs\.value.*out of its declared bound/);
});

// W1-T325: sweep.dispatchLanes is a bounded row now too (a relocation, not a retune — the
// falsifier below proves an out-of-bounds edit is REFUSED at load, never silently clamped).
test("REJECTS sweep.dispatchLanes out of its declared bound, naming its dotted path", () => {
  const raw = goodRaw();
  (raw.sweep as Record<string, Record<string, unknown>>).dispatchLanes.value = 999;
  throwsPolicyError(() => validatePolicy(raw), /sweep\.dispatchLanes\.value.*out of its declared bound/);
});

// W1-T330: sweep.dailyCostCeilingUsd is a bounded row now too (a relocation, not a retune — the
// falsifier below proves an out-of-bounds edit is REFUSED at load, never silently clamped).
test("REJECTS sweep.dailyCostCeilingUsd out of its declared bound, naming its dotted path", () => {
  const raw = goodRaw();
  (raw.sweep as Record<string, Record<string, unknown>>).dailyCostCeilingUsd.value = 99_999;
  throwsPolicyError(() => validatePolicy(raw), /sweep\.dailyCostCeilingUsd\.value.*out of its declared bound/);
});

test("W1-T264 acceptance 4 — a retro threshold outside its declared bound fails validation", () => {
  const raw = goodRaw();
  (raw.retro as Record<string, Record<string, unknown>>).mergesThreshold.value = 999;
  throwsPolicyError(() => validatePolicy(raw), /retro\.mergesThreshold\.value.*out of its declared bound/);
});

test("REJECTS a retro.daysThreshold out of its [1, 90] bound", () => {
  const raw = goodRaw();
  (raw.retro as Record<string, Record<string, unknown>>).daysThreshold.value = 0;
  throwsPolicyError(() => validatePolicy(raw), /retro\.daysThreshold\.value.*out of its declared bound/);
});

test("REJECTS a headroom.reservePct out of its [50, 100] bound", () => {
  const raw = goodRaw();
  (raw.headroom as Record<string, Record<string, unknown>>).reservePct.value = 10;
  throwsPolicyError(() => validatePolicy(raw), /headroom\.reservePct\.value.*out of its declared bound/);
});

test("REJECTS a launchd.throttleIntervalS below the [10, 3600] bound (mirrors generateServeLaunchdPlist's own >= 10 floor)", () => {
  const raw = goodRaw();
  (raw.launchd as Record<string, Record<string, unknown>>).throttleIntervalS.value = 1;
  throwsPolicyError(() => validatePolicy(raw), /launchd\.throttleIntervalS\.value.*out of its declared bound/);
});

test("REJECTS a headroom curve rung with limitPct outside [0, 100]", () => {
  const raw = goodRaw();
  (raw.headroom as Record<string, Record<string, unknown>>).curve = {
    value: [{ maxHoursToReset: 24, limitPct: 250 }],
    origin: "lifted:src/lib/daemon.ts:145-148 (buildDefaultHeadroomPolicy)",
  };
  throwsPolicyError(() => validatePolicy(raw), /headroom\.curve\.value\[0\]\.limitPct/);
});

test("REJECTS a headroom curve that does not end in a catch-all (maxHoursToReset: null) rung", () => {
  const raw = goodRaw();
  (raw.headroom as Record<string, Record<string, unknown>>).curve = {
    value: [{ maxHoursToReset: 24, limitPct: 100 }],
    origin: "lifted:src/lib/daemon.ts:145-148 (buildDefaultHeadroomPolicy)",
  };
  throwsPolicyError(() => validatePolicy(raw), /must end with a catch-all rung/);
});

test("rmd lint-plan FAILS over a bounds-violating plan/policy.yaml (fixStrikeCap out of its declared bound), naming the field", async () => {
  const raw = goodRaw();
  (raw.fixStrikeCap as Record<string, unknown>).value = 999;
  const { tasksPath, dir } = lintFixture(raw);
  try {
    const { exitCode, stderr } = await runLintPlanCapturingStderr(tasksPath);
    assert.notEqual(exitCode, 0, "lint-plan must exit non-zero over a bounds-violating plan/policy.yaml");
    assert.match(stderr, /plan\/policy\.yaml/);
    assert.match(stderr, /fixStrikeCap\.value.*out of its declared bound/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rmd lint-plan FAILS over a plan/policy.yaml regressing proofTimeoutMs to the stale 30000", async () => {
  const raw = goodRaw();
  (raw.proofTimeoutMs as Record<string, unknown>).value = 30_000;
  const { tasksPath, dir } = lintFixture(raw);
  try {
    const { exitCode, stderr } = await runLintPlanCapturingStderr(tasksPath);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /proofTimeoutMs\.value.*out of its declared bound/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rmd lint-plan PASSES over a within-bounds plan/policy.yaml edit (a sweep.staleDays retune)", async () => {
  const raw = goodRaw();
  (raw.sweep as Record<string, Record<string, unknown>>).staleDays.value = 21;
  const { tasksPath, dir } = lintFixture(raw);
  try {
    const { exitCode } = await runLintPlanCapturingStderr(tasksPath);
    assert.equal(exitCode, 0, "an in-bounds plan/policy.yaml edit must lint clean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rmd lint-plan on the SHIPPED plan/tasks.yaml also validates the SHIPPED plan/policy.yaml (no --plan override) without adding a policy failure", async () => {
  // Not a full-plan assertion (the real plan/tasks.yaml carries its own, unrelated
  // pre-existing task-lint violations) — only that plan/policy.yaml itself never shows
  // up as a `✗ plan/policy.yaml:` line, proving the shipped file is read and passes.
  const { stderr } = await runLintPlanCapturingStderr(join(REPO_ROOT, "plan", "tasks.yaml"));
  assert.ok(!/✗ plan\/policy\.yaml/.test(stderr), `the shipped plan/policy.yaml must not fail lint-plan; got:\n${stderr}`);
});

// ── acceptance 3: launchd ThrottleInterval is NET-NEW — never claimed lifted ───────────────

test("launchd.throttleIntervalS carries a bound and origin=net-new", () => {
  const p = loadPolicy(SHIPPED);
  assert.equal(p.origin["launchd.throttleIntervalS"].kind, "net-new");
  assert.equal(p.origin["launchd.throttleIntervalS"].raw, "net-new");
});

test("REJECTS a fixture that marks launchd.throttleIntervalS as lifted (inventing a source that never existed)", () => {
  const raw = goodRaw();
  (raw.launchd as Record<string, Record<string, unknown>>).throttleIntervalS.origin =
    "lifted:src/lib/launchd.ts:1 (invented)";
  throwsPolicyError(
    () => validatePolicy(raw),
    /launchd\.throttleIntervalS\.origin.*must be net-new/,
  );
});

// ── acceptance 4: the loader is deterministic; every LIFTED field cites its source site ────

test("two loads of the SAME file yield identical values", () => {
  const a = loadPolicy(SHIPPED);
  const b = loadPolicy(SHIPPED);
  assert.deepEqual(a.values, b.values);
});

test("every LIFTED field records origin=lifted:<source-site> — the net-new field is the only exception", () => {
  const p: Policy = loadPolicy(SHIPPED);
  // impl-DJ: the three `autoTriage.*` fields join `launchd.throttleIntervalS` as net-new — there is
  // no source literal to lift them from, because the rung they configure did not exist before.
  // impl-EK: `scratchReap.enabled` joins them for the same reason — there was no prior
  // literal gating a clone reap, because no clone reap existed.
  // W1-T320: `sweep.tmpMaxAgeMs` joins them too — it is NOT a straight lift of
  // src/lib/tmp.ts's DEFAULT_TEMP_SWEEP_MAX_AGE_MS (24h): the shipped policy value is a
  // deliberate retuning (well below 24h — see this field's plan/policy.yaml comment for the
  // ENOSPC incident that made 24h unsafe), so citing that constant as its origin would claim
  // a source-site copy that never happened.
  const NET_NEW = new Set([
    "launchd.throttleIntervalS",
    "autoTriage.enabled",
    "autoTriage.minIntervalMinutes",
    "autoTriage.maxIntervalMinutes",
    "autoTriage.depthFloor",
    "autoTriage.depthCeiling",
    "autoTriage.maxPerDay",
    "scratchReap.enabled",
    "sweep.tmpMaxAgeMs",
  ]);
  const liftedPaths = Object.keys(p.origin).filter((path) => !NET_NEW.has(path));
  assert.ok(liftedPaths.length > 0);
  for (const path of liftedPaths) {
    const o = p.origin[path];
    assert.equal(o.kind, "lifted", `${path} should be lifted`);
    assert.ok(o.raw.startsWith("lifted:") && o.raw.slice("lifted:".length).trim().length > 0, `${path} must cite a non-empty source site`);
  }
});

test("REJECTS a lifted field with NO source site cited (an empty lifted: origin)", () => {
  const raw = goodRaw();
  (raw.pollIntervalMs as Record<string, unknown>).origin = "lifted:";
  throwsPolicyError(() => validatePolicy(raw), /pollIntervalMs\.origin.*must be exactly/);
});

test("REJECTS a lifted field relabeled net-new (hiding its real source)", () => {
  const raw = goodRaw();
  (raw.pruneGraceMs as Record<string, unknown>).origin = "net-new";
  throwsPolicyError(() => validatePolicy(raw), /pruneGraceMs\.origin.*must be lifted:<src-site>/);
});

// ── structural failures ─────────────────────────────────────────────────────────────────────

test("REJECTS a non-mapping document", () => {
  throwsPolicyError(() => validatePolicy([1, 2, 3]), /must be a mapping/);
});

test("REJECTS a policy missing 'sweep' entirely", () => {
  const raw = goodRaw();
  delete (raw as Record<string, unknown>).sweep;
  throwsPolicyError(() => validatePolicy(raw), /'sweep' must be a mapping/);
});

test("REJECTS a non-numeric value where a number is required", () => {
  const raw = goodRaw();
  (raw.fixStrikeCap as Record<string, unknown>).value = "two";
  throwsPolicyError(() => validatePolicy(raw), /fixStrikeCap\.value.*must be a finite number/);
});

test("REJECTS a non-boolean value for headroom.enabled", () => {
  const raw = goodRaw();
  (raw.headroom as Record<string, Record<string, unknown>>).enabled.value = "yes";
  throwsPolicyError(() => validatePolicy(raw), /headroom\.enabled\.value.*must be a boolean/);
});

test("REJECTS min > max as an unsatisfiable bound", () => {
  const raw = goodRaw();
  (raw.fixStrikeCap as Record<string, unknown>).min = 10;
  (raw.fixStrikeCap as Record<string, unknown>).max = 1;
  throwsPolicyError(() => validatePolicy(raw), /unsatisfiable bound/);
});

// ── the NON-FINITE BOUND falsifier (W1-T252 follow-up) ─────────────────────────────────────
//
// A NaN bound makes every comparison in numberField false — `min > max`, `value < min`,
// `value > max` — so a declared bound stops binding instead of widening, and ANY value loads
// clean. The operator's binding 30000 rejection is a bound check, so it was bypassable by a
// single YAML token: `min: .nan`. These lock the refusal, including through real YAML text
// (`.nan` / `.inf` are ordinary YAML scalars, not something a fixture has to construct).

test("REJECTS a NaN bound instead of letting it silently disable the bound check", () => {
  const raw = goodRaw();
  (raw.sweep as Record<string, Record<string, unknown>>).wipLimit = {
    value: 9999, origin: "lifted:src/lib/sweep.ts:270 (DEFAULT_SWEEP_POLICY.wipLimit)", min: NaN, max: NaN,
  };
  throwsPolicyError(() => validatePolicy(raw), /sweep\.wipLimit.*must carry numeric 'min' and 'max' bounds — finite ones/);
});

test("REJECTS an Infinity bound the same way — a bound that cannot bind is malformed", () => {
  const raw = goodRaw();
  (raw.drain as Record<string, Record<string, unknown>>).max = {
    value: 9999, origin: "lifted:src/lib/drain.ts:271 (DEFAULT_MAX)", min: -Infinity, max: Infinity,
  };
  throwsPolicyError(() => validatePolicy(raw), /drain\.max.*finite ones/);
});

test("a YAML .nan min can no longer smuggle the stale 30000 proof timeout past its floor", () => {
  // Real YAML text, exactly as a plan PR would carry it — not a hand-built fixture object.
  const smuggled = readFileSync(SHIPPED, "utf8")
    .replace("  value: 60000\n  origin: \"lifted:src/lib/review.ts:675", "  value: 30000\n  origin: \"lifted:src/lib/review.ts:675")
    .replace("  min: 60000", "  min: .nan");
  const raw = parseYaml(smuggled) as Record<string, unknown>;
  assert.equal((raw.proofTimeoutMs as Record<string, unknown>).value, 30_000, "the fixture really does carry the stale 30000");
  assert.ok(Number.isNaN((raw.proofTimeoutMs as Record<string, number>).min), "and really does carry a NaN min");
  throwsPolicyError(() => validatePolicy(raw), /proofTimeoutMs.*finite ones/);
});

// ── structural-guard coverage: every defensive PolicyError branch has a falsifier ──────────
// These pin the validator's malformed-input rejections (each a distinct throw the shipped,
// well-formed policy.yaml never reaches) so a future refactor that drops a guard fails RED.

test("parseOrigin REJECTS an unregistered field path (the defensive unknown-field guard)", () => {
  throwsPolicyError(() => parseOrigin("bogus.not-a-policy-field", "net-new"), /is not a recognized policy field/);
});

test("parseOrigin REJECTS a non-string / empty origin", () => {
  throwsPolicyError(() => parseOrigin("proofTimeoutMs", ""), /origin.*must be a non-empty string/);
  throwsPolicyError(() => parseOrigin("proofTimeoutMs", 42), /origin.*must be a non-empty string/);
});

test("REJECTS a numeric field that is not a {value,origin,min,max} mapping", () => {
  const raw = goodRaw();
  raw.proofTimeoutMs = 60_000; // a bare number, not the bounded-field mapping
  throwsPolicyError(() => validatePolicy(raw), /proofTimeoutMs.*must be a mapping/);
});

test("REJECTS a numeric field missing its numeric min/max bounds", () => {
  const raw = goodRaw();
  raw.proofTimeoutMs = { value: 60_000, origin: "lifted:src/lib/review.ts:675" }; // no min/max
  throwsPolicyError(() => validatePolicy(raw), /proofTimeoutMs.*must carry numeric 'min' and 'max'/);
});

test("REJECTS a boolean field that is not a {value,origin} mapping", () => {
  const raw = goodRaw();
  (raw.headroom as Record<string, unknown>).enabled = true; // a bare boolean, not the mapping
  throwsPolicyError(() => validatePolicy(raw), /headroom\.enabled.*must be a mapping/);
});

test("REJECTS a headroom.curve that is not a {value,origin} mapping", () => {
  const raw = goodRaw();
  (raw.headroom as Record<string, unknown>).curve = [{ maxHoursToReset: null, limitPct: 95 }]; // array, not mapping
  throwsPolicyError(() => validatePolicy(raw), /headroom\.curve.*must be a mapping/);
});

test("REJECTS a headroom.curve whose value is an empty (or non-array) rung list", () => {
  const raw = goodRaw();
  (raw.headroom as Record<string, unknown>).curve = { value: [], origin: "lifted:src/lib/daemon.ts:145-148" };
  throwsPolicyError(() => validatePolicy(raw), /headroom\.curve\.value.*must be a non-empty array/);
});

test("REJECTS a headroom.curve rung that is not a mapping", () => {
  const raw = goodRaw();
  (raw.headroom as Record<string, unknown>).curve = { value: [5], origin: "lifted:src/lib/daemon.ts:145-148" };
  throwsPolicyError(() => validatePolicy(raw), /headroom\.curve\.value\[0\].*must be a mapping/);
});

test("REJECTS a headroom.curve rung whose maxHoursToReset is neither null nor a positive number", () => {
  const raw = goodRaw();
  (raw.headroom as Record<string, unknown>).curve = {
    value: [{ maxHoursToReset: -5, limitPct: 100 }],
    origin: "lifted:src/lib/daemon.ts:145-148",
  };
  throwsPolicyError(() => validatePolicy(raw), /headroom\.curve\.value\[0\]\.maxHoursToReset.*must be null or a finite positive number/);
});

// The same non-finite hole existed TWICE MORE in this file, on the curve rungs — NaN passes every
// range test by failing every comparison. Unfixed, a `.nan` maxHoursToReset loads clean and then
// never matches in resolveHeadroomLimitPct (a silently dead rung), and a `.nan` limitPct loads
// clean and yields a NaN CEILING that every headroom comparison silently fails. Infinity is
// refused on maxHoursToReset because `null` is this schema's only spelling of the catch-all, so a
// non-final Infinity rung would swallow every rung after it.

test("REJECTS a curve rung whose maxHoursToReset is NaN rather than accepting a rung that can never match", () => {
  const raw = goodRaw();
  (raw.headroom as Record<string, unknown>).curve = {
    value: [{ maxHoursToReset: NaN, limitPct: 100 }, { maxHoursToReset: null, limitPct: 95 }],
    origin: "lifted:src/lib/daemon.ts:145-148",
  };
  throwsPolicyError(() => validatePolicy(raw), /maxHoursToReset.*must be null or a finite positive number/);
});

test("REJECTS a non-final Infinity curve rung, which would swallow every rung after it", () => {
  const raw = goodRaw();
  (raw.headroom as Record<string, unknown>).curve = {
    value: [{ maxHoursToReset: Infinity, limitPct: 100 }, { maxHoursToReset: null, limitPct: 95 }],
    origin: "lifted:src/lib/daemon.ts:145-148",
  };
  throwsPolicyError(() => validatePolicy(raw), /maxHoursToReset.*must be null or a finite positive number/);
});

test("REJECTS a NaN limitPct rather than accepting a ceiling no comparison can satisfy", () => {
  const raw = goodRaw();
  (raw.headroom as Record<string, unknown>).curve = {
    value: [{ maxHoursToReset: 24, limitPct: NaN }, { maxHoursToReset: null, limitPct: 95 }],
    origin: "lifted:src/lib/daemon.ts:145-148",
  };
  throwsPolicyError(() => validatePolicy(raw), /limitPct.*must be a finite number/);
});

test("loadPolicy REJECTS a file that is not valid YAML, naming the path", () => {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t252-badyaml-"));
  const bad = join(dir, "policy.yaml");
  writeFileSync(bad, "proofTimeoutMs: {value: 60000,\n  bad: [unterminated\n", "utf8"); // malformed YAML
  try {
    throwsPolicyError(() => loadPolicy(bad), /is not valid YAML/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T332: the state/-resident daily-cost-ceiling override store ─────────────────────────
//
// A fresh `<root>/state/` per test (mkdtempSync), never the real repo's `state/` — that
// directory is fleet-control's live PAUSE/STOP surface and must never be touched by a test.
// `SHIPPED_POLICY` supplies the real committed row (`sweep.dailyCostCeilingUsd`: min 100,
// max 2500) so bound checks below exercise the ACTUAL committed bound, not a fixture's.

const SHIPPED_POLICY: Policy = loadPolicy(SHIPPED);

function overrideRoot(): string {
  return mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t332-override-"));
}

// acceptance 1 — override wins; absence yields the committed default; one rule, no merging.

test("W1-T332 acceptance 1 — a written override takes precedence over the committed default", () => {
  const root = overrideRoot();
  try {
    writeDailyCostCeilingOverride(root, 1_200, SHIPPED_POLICY);
    const effective = resolveDailyCostCeiling(root, SHIPPED_POLICY);
    assert.equal(effective.usd, 1_200);
    assert.equal(effective.committedDefaultUsd, SHIPPED_POLICY.values.sweep.dailyCostCeilingUsd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T332 acceptance 1 — no override file at all yields the committed default, not a merge/partial value", () => {
  const root = overrideRoot();
  try {
    assert.equal(existsOverride(root), false);
    const effective = resolveDailyCostCeiling(root, SHIPPED_POLICY);
    assert.equal(effective.usd, SHIPPED_POLICY.values.sweep.dailyCostCeilingUsd);
    assert.equal(effective.usd, effective.committedDefaultUsd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T332 acceptance 1 — clearing a written override reverts resolution to the committed default", () => {
  const root = overrideRoot();
  try {
    writeDailyCostCeilingOverride(root, 900, SHIPPED_POLICY);
    assert.equal(resolveDailyCostCeiling(root, SHIPPED_POLICY).usd, 900);
    assert.equal(clearDailyCostCeilingOverride(root), true);
    assert.equal(resolveDailyCostCeiling(root, SHIPPED_POLICY).usd, SHIPPED_POLICY.values.sweep.dailyCostCeilingUsd);
    assert.equal(clearDailyCostCeilingOverride(root), false, "clearing an absent override is idempotent, not an error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function existsOverride(root: string): boolean {
  try {
    readFileSync(dailyCostCeilingOverridePath(root), "utf8");
    return true;
  } catch {
    return false;
  }
}

// acceptance 2 — an out-of-bound write is REFUSED at write time (never clamped/accepted), and
// the bound consulted is the committed row's own (`policy.bounds`), not a second copy.

test("W1-T332 acceptance 2 — REJECTS a write above the committed row's max, performing no write", () => {
  const root = overrideRoot();
  try {
    assert.throws(
      () => writeDailyCostCeilingOverride(root, 99_999, SHIPPED_POLICY),
      (e: unknown) => e instanceof PolicyError && /out of the committed plan\/policy\.yaml bound/.test((e as Error).message),
    );
    assert.equal(existsOverride(root), false, "a refused write must leave no file behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T332 acceptance 2 — REJECTS a write below the committed row's min, performing no write", () => {
  const root = overrideRoot();
  try {
    assert.throws(
      () => writeDailyCostCeilingOverride(root, 1, SHIPPED_POLICY),
      (e: unknown) => e instanceof PolicyError && /out of the committed plan\/policy\.yaml bound/.test((e as Error).message),
    );
    assert.equal(existsOverride(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T332 acceptance 2 — the bound enforced is the LIVE committed row, not a hardcoded copy: a fixture policy with a tighter bound refuses a value the shipped policy would accept", () => {
  const root = overrideRoot();
  const raw = goodRaw();
  (raw.sweep as Record<string, Record<string, unknown>>).dailyCostCeilingUsd = {
    value: 300, origin: "lifted:src/lib/sweep.ts:365 (DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd)", min: 100, max: 300,
  };
  const tighterPolicy = validatePolicy(raw);
  try {
    // 1200 is within the SHIPPED bound [100, 2500] but outside this fixture's [100, 300] —
    // proving the check reads whichever Policy's bounds it is handed, never a fixed literal.
    assert.throws(() => writeDailyCostCeilingOverride(root, 1_200, tighterPolicy), PolicyError);
    assert.doesNotThrow(() => writeDailyCostCeilingOverride(root, 1_200, SHIPPED_POLICY));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T332 acceptance 2 — REJECTS a non-finite override value at write time", () => {
  const root = overrideRoot();
  try {
    assert.throws(() => writeDailyCostCeilingOverride(root, NaN, SHIPPED_POLICY), PolicyError);
    assert.throws(() => writeDailyCostCeilingOverride(root, Infinity, SHIPPED_POLICY), PolicyError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T332 — writeDailyCostCeilingOverride REJECTS a hand-built Policy carrying no 'sweep.dailyCostCeilingUsd' bound (the defensive guard, distinct from an out-of-range value)", () => {
  const root = overrideRoot();
  const handBuiltPolicy: Policy = { ...SHIPPED_POLICY, bounds: {} };
  try {
    assert.throws(
      () => writeDailyCostCeilingOverride(root, 1_000, handBuiltPolicy),
      (e: unknown) => e instanceof PolicyError && /policy carries no 'sweep\.dailyCostCeilingUsd' bound/.test((e as Error).message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T332 — clearDailyCostCeilingOverride returns false (not throw) when the path exists but cannot be unlinked (e.g. a directory occupies it)", () => {
  const root = overrideRoot();
  try {
    const path = dailyCostCeilingOverridePath(root);
    mkdirSync(path, { recursive: true }); // unlinkSync on a directory refuses (EPERM/EISDIR), unlike a plain file
    assert.equal(clearDailyCostCeilingOverride(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// acceptance 3 — a malformed or unreadable override falls back to the committed default and
// REPORTS why, never as zero or unbounded.

test("W1-T332 acceptance 3 — malformed JSON in the override file falls back to the committed default and reports it", () => {
  const root = overrideRoot();
  try {
    const path = dailyCostCeilingOverridePath(root);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(path, "{ not valid json", "utf8");
    const effective = resolveDailyCostCeiling(root, SHIPPED_POLICY);
    assert.equal(effective.usd, SHIPPED_POLICY.values.sweep.dailyCostCeilingUsd);
    assert.equal(effective.provenance, "default");
    assert.ok(effective.fallback, "a malformed override must set a fallback report");
    assert.match(effective.fallback!.reason, /not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T332 acceptance 3 — an override file missing/non-numeric 'usd' falls back and reports, never reading as zero", () => {
  const root = overrideRoot();
  try {
    const path = dailyCostCeilingOverridePath(root);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(path, JSON.stringify({ usd: "not-a-number" }), "utf8");
    const effective = resolveDailyCostCeiling(root, SHIPPED_POLICY);
    assert.equal(effective.usd, SHIPPED_POLICY.values.sweep.dailyCostCeilingUsd);
    assert.notEqual(effective.usd, 0);
    assert.equal(effective.provenance, "default");
    assert.match(effective.fallback!.reason, /malformed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T332 acceptance 3 — an override whose value falls outside the CURRENT committed bound (e.g. the plan/policy.yaml row tightened since it was written) falls back and reports, never reading as unbounded", () => {
  const root = overrideRoot();
  try {
    writeDailyCostCeilingOverride(root, 2_000, SHIPPED_POLICY);
    // Simulate the committed row tightening below the previously-written override.
    const raw = goodRaw();
    (raw.sweep as Record<string, Record<string, unknown>>).dailyCostCeilingUsd = {
      value: 300, origin: "lifted:src/lib/sweep.ts:365 (DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd)", min: 100, max: 300,
    };
    const tightenedPolicy = validatePolicy(raw);
    const effective = resolveDailyCostCeiling(root, tightenedPolicy);
    assert.equal(effective.usd, tightenedPolicy.values.sweep.dailyCostCeilingUsd);
    assert.equal(effective.provenance, "default");
    assert.match(effective.fallback!.reason, /out of the committed bound/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T332 acceptance 3 — an override file that cannot be read at all (e.g. a directory in its place) falls back and reports, distinct from ordinary absence", () => {
  const root = overrideRoot();
  try {
    const path = dailyCostCeilingOverridePath(root);
    mkdirSync(path, { recursive: true }); // a directory, not a file — readFileSync fails EISDIR
    const effective = resolveDailyCostCeiling(root, SHIPPED_POLICY);
    assert.equal(effective.usd, SHIPPED_POLICY.values.sweep.dailyCostCeilingUsd);
    assert.equal(effective.provenance, "default");
    assert.ok(effective.fallback, "an unreadable (not merely absent) override must report a fallback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// acceptance 4 — the effective value carries its provenance: "at default" is distinguishable
// from "overridden", and ordinary absence carries NO fallback report (it is not a malformed
// case — see the precedence rule in acceptance 1).

test("W1-T332 acceptance 4 — provenance is 'default' with no fallback when nothing was ever written", () => {
  const root = overrideRoot();
  try {
    const effective = resolveDailyCostCeiling(root, SHIPPED_POLICY);
    assert.equal(effective.provenance, "default");
    assert.equal(effective.fallback, undefined, "ordinary absence is not a fallback case");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T332 acceptance 4 — provenance is 'overridden' when a valid override is in effect, distinguishable from 'default'", () => {
  const root = overrideRoot();
  try {
    writeDailyCostCeilingOverride(root, 1_000, SHIPPED_POLICY);
    const overridden = resolveDailyCostCeiling(root, SHIPPED_POLICY);
    assert.equal(overridden.provenance, "overridden");
    clearDailyCostCeilingOverride(root);
    const atDefault = resolveDailyCostCeiling(root, SHIPPED_POLICY);
    assert.equal(atDefault.provenance, "default");
    assert.notEqual(overridden.provenance, atDefault.provenance);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T332 — the override path is state/-resident, matching fleet-control.ts's <root>/state/ location", () => {
  const root = "/tmp/does-not-need-to-exist-for-this-check";
  assert.equal(dailyCostCeilingOverridePath(root), join(root, "state", "DAILY_COST_CEILING_OVERRIDE"));
});
