import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  loadPolicy,
  policyPath,
  PolicyError,
  validatePolicy,
  type Policy,
} from "../src/lib/policy.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED = policyPath(REPO_ROOT);

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
    },
    drain: {
      max: { value: 10, origin: "lifted:src/lib/drain.ts:243 (DEFAULT_MAX)", min: 1, max: 100 },
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
  assert.deepEqual(p.values.sweep, { staleDays: 14, strikeCap: 2, wipLimit: 10 });
  assert.equal(p.values.drain.max, 10);
  assert.deepEqual(p.values.headroom.curve, [
    { maxHoursToReset: 24, limitPct: 100 },
    { maxHoursToReset: null, limitPct: 95 },
  ]);
  assert.equal(p.values.headroom.reservePct, 95);
  assert.equal(p.values.headroom.enabled, true);
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
  const liftedPaths = Object.keys(p.origin).filter((path) => path !== "launchd.throttleIntervalS");
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
