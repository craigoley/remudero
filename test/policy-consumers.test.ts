// W1-T253 (P37 CONSUMERS): every operating constant the W1-T252 substrate collected into
// plan/policy.yaml (proof timeout, prune grace, poll interval, headroom curve, sweep
// staleDays/strikeCap/wipLimit, drain max, launchd ThrottleInterval) now reads from the
// LOADED policy at its consumer site — never a source literal. The invariant is ONE property
// across all six sites (review.ts/worker.ts/daemon.ts/sweep.ts/drain.ts/launchd.ts): no
// collected constant resolves from a literal. It is UNSATISFIABLE PIECEWISE — this file is
// the guard that enumerates every site and fails if any one still does.
//
// Two mechanisms, per VERIFY-FROM-SOURCE findings (daemon.ts's own file header: "this pure
// module never touches the filesystem", Rule 16's headless/live split):
//   - review.ts, worker.ts, sweep.ts, launchd.ts self-load the policy (policy.ts's
//     loadDefaultPolicy — a self-locating, memoized readFileSync) as their default's source,
//     because none of them is documented fs-free and none is imported at the VALUE level by
//     daemon.ts (whose own fs-free promise a transitive fs read would silently break).
//   - daemon.ts and drain.ts (drain.ts IS imported at the value level by daemon.ts) keep their
//     internal DEFAULT_* as the fs-free safety net for a direct/test caller, and the REAL `rmd
//     daemon`/`rmd drain` CLI entries (run-task.ts's daemonCommand/drainCommand) load the
//     policy and thread the resolved value in EXPLICITLY on every real invocation — proven
//     here by SOURCE assertions, the same technique test/mounts-wiring.test.ts already uses
//     for an identical "used to be a literal, now reads a table" proof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { headroomPolicyFromCurve } from "../src/run-task.js";
import { loadPolicy, policyPath } from "../src/lib/policy.js";
import { execWhitelistedProof, type ProofSpawner, type WhitelistedProof } from "../src/lib/review.js";
import { DEFAULT_PRUNE_GRACE_MS } from "../src/lib/worker.js";
import { DEFAULT_POLL_INTERVAL_MS, buildDefaultHeadroomPolicy, resolveHeadroomLimitPct } from "../src/lib/daemon.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { DEFAULT_MAX } from "../src/lib/drain.js";
import { generateLaunchdPlist } from "../src/lib/launchd.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED = loadPolicy(policyPath(REPO_ROOT));
const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

// ── review.ts: proof timeout ────────────────────────────────────────────────────────────

test("W1-T253: execWhitelistedProof's DEFAULT timeout reads plan/policy.yaml's proofTimeoutMs — an explicit override still wins, and it is never the stale 30000 literal", () => {
  const wp: WhitelistedProof = { kind: "grep", command: "grep", args: ["-n", "x", "f.txt"], label: "x in f.txt" };
  let observed: number | undefined;
  const capturingSpawner: ProofSpawner = (_cmd, _args, _cwd, timeoutMs) => {
    observed = timeoutMs;
    return "f.txt:1:x\n";
  };

  execWhitelistedProof(wp, "/tmp", undefined, capturingSpawner);
  // W1-T374: the INVARIANT (the default equals the LOADED policy's proofTimeoutMs) is what this
  // test exists for and holds at any legitimately retuned value — the standing literal pin this
  // line used to also carry (asserting the shipped figure directly) is gone, on purpose.
  assert.equal(observed, SHIPPED.values.proofTimeoutMs, "the default must equal the LOADED policy's proofTimeoutMs");
  assert.notEqual(observed, 30_000, "the pre-existing 30000/DEFAULT_PROOF_TIMEOUT_MS literal must never gate this");

  execWhitelistedProof(wp, "/tmp", 12_345, capturingSpawner);
  assert.equal(observed, 12_345, "an explicit override still wins over the policy default");
});

// ── worker.ts: prune grace ──────────────────────────────────────────────────────────────

test("W1-T253: worker.ts's DEFAULT_PRUNE_GRACE_MS reads plan/policy.yaml's pruneGraceMs, not a source literal", () => {
  assert.equal(DEFAULT_PRUNE_GRACE_MS, SHIPPED.values.pruneGraceMs);
});

// ── sweep.ts: staleDays / strikeCap / wipLimit / dispatchLanes / dailyCostCeilingUsd ────

test("W1-T253: sweep.ts's DEFAULT_SWEEP_POLICY.staleDays/strikeCap/wipLimit read plan/policy.yaml's sweep row, not source literals", () => {
  assert.equal(DEFAULT_SWEEP_POLICY.staleDays, SHIPPED.values.sweep.staleDays);
  assert.equal(DEFAULT_SWEEP_POLICY.strikeCap, SHIPPED.values.sweep.strikeCap);
  assert.equal(DEFAULT_SWEEP_POLICY.wipLimit, SHIPPED.values.sweep.wipLimit);
});

// W1-T325 relocated dispatchLanes out of DEFAULT_SWEEP_POLICY (a relocation, not a retune, at the
// time it moved) — see plan/policy.yaml's own sweep.dispatchLanes row for the retune history
// since (W1-T344, and the operator-directed N=3 experiment and revert). W1-T374 removed the
// standing literal pin this test used to also carry: the assertion below is the INVARIANT — the
// consumer equals SHIPPED.values, i.e. the value is LIFTED rather than a source literal — and it
// holds at ANY value, so it is untouched by every future retune. The row's current figure lives
// in plan/policy.yaml and its own history comment, never here.
test("W1-T325/W1-T344: sweep.ts's DEFAULT_SWEEP_POLICY.dispatchLanes reads plan/policy.yaml's sweep.dispatchLanes row, not a source literal", () => {
  assert.equal(DEFAULT_SWEEP_POLICY.dispatchLanes, SHIPPED.values.sweep.dispatchLanes);
});

// W1-T330: dailyCostCeilingUsd joins its siblings above — a relocation of the pre-existing
// source literal, not a retune at the time it moved (the figure was raised from 150 to 500 on
// 2026-08-04, the day the cost governor first fired in production — see plan/policy.yaml's own
// row for that history). W1-T374 removed the standing literal pin this test used to also carry:
// the assertion below is the INVARIANT and holds at any value, so a later plan-data retune of
// this row no longer requires a test edit.
test("W1-T330: sweep.ts's DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd reads plan/policy.yaml's sweep.dailyCostCeilingUsd row, not a source literal", () => {
  assert.equal(DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd, SHIPPED.values.sweep.dailyCostCeilingUsd);
});

// ── launchd.ts: ThrottleInterval (net-new — emission-from-policy, not literal-removal) ──

test("W1-T253: generateLaunchdPlist's ThrottleInterval reads plan/policy.yaml's launchd.throttleIntervalS by default, and a caller-supplied value overrides it", () => {
  const VALID = { rmdBin: "/Users/op/Remudero/bin/rmd", root: "/Users/op/Remudero" };
  const defaulted = generateLaunchdPlist(VALID);
  assert.match(
    defaulted,
    new RegExp(`<key>ThrottleInterval</key>\\s*<integer>${SHIPPED.values.launchd.throttleIntervalS}</integer>`),
  );
  const overridden = generateLaunchdPlist({ ...VALID, throttleIntervalS: SHIPPED.values.launchd.throttleIntervalS + 1 });
  assert.match(
    overridden,
    new RegExp(`<key>ThrottleInterval</key>\\s*<integer>${SHIPPED.values.launchd.throttleIntervalS + 1}</integer>`),
  );
});

// ── daemon.ts + drain.ts: fs-free by design (see file header) — the CLI entries thread the
// loaded policy in explicitly. daemon.ts's/drain.ts's own DEFAULT_* stays the fs-free
// fallback for a direct/test caller (proven equal to the shipped policy below); the REAL
// wiring is proven at the run-task.ts source level, the same technique
// test/mounts-wiring.test.ts already uses for an identical literal-to-table rewiring. ────

test("W1-T253: daemon.ts's DEFAULT_POLL_INTERVAL_MS (its fs-free fallback) still matches the shipped policy's pollIntervalMs", () => {
  assert.equal(DEFAULT_POLL_INTERVAL_MS, SHIPPED.values.pollIntervalMs);
});

test("W1-T253: drain.ts's DEFAULT_MAX (its fs-free fallback) still matches the shipped policy's drain.max", () => {
  assert.equal(DEFAULT_MAX, SHIPPED.values.drain.max);
});

test("W1-T253: daemonCommand reads pollIntervalMs + the headroom curve FROM the loaded policy, never daemon.ts's fs-free literal defaults", () => {
  assert.match(
    runTaskSrc,
    /const policy = loadPolicy\(policyPath\(repoRoot\)\);/,
    "daemonCommand must load plan/policy.yaml",
  );
  assert.match(
    runTaskSrc,
    /pollIntervalMs:\s*pollIdx >= 0 \? Number\(rest\[pollIdx \+ 1\]\) : policy\.values\.pollIntervalMs,/,
    "pollIntervalMs must default from the loaded policy, not DEFAULT_POLL_INTERVAL_MS",
  );
  assert.doesNotMatch(
    runTaskSrc,
    /pollIntervalMs:\s*pollIdx >= 0 \? Number\(rest\[pollIdx \+ 1\]\) : DEFAULT_POLL_INTERVAL_MS,/,
    "the old DEFAULT_POLL_INTERVAL_MS-literal fallback must be gone",
  );
  assert.match(
    runTaskSrc,
    /headroomPolicy:\s*headroomPolicyFromCurve\(policy\.values\.headroom\.curve\),/,
    "headroomPolicy must be built from the loaded policy's curve",
  );
});

test("W1-T253: drainCommand and daemonCommand's --dry-run preview read drain.max FROM the loaded policy, never drain.ts's fs-free literal default", () => {
  assert.match(
    runTaskSrc,
    /const drainMax = loadPolicy\(policyPath\(repoRoot\)\)\.values\.drain\.max;/,
    "drainCommand must load plan/policy.yaml's drain.max",
  );
  assert.match(
    runTaskSrc,
    /max:\s*maxIdx >= 0 \? Number\(rest\[maxIdx \+ 1\]\) : drainMax,/,
    "drainCommand's max must default from the loaded policy, not DRAIN_DEFAULT_MAX",
  );
  assert.doesNotMatch(runTaskSrc, /: DRAIN_DEFAULT_MAX/, "the old DRAIN_DEFAULT_MAX-literal fallback must be gone");
  assert.match(
    runTaskSrc,
    /max:\s*opts\.max \?\? policy\.values\.drain\.max\s*\}/,
    "daemonCommand's --dry-run preview must also default from the loaded policy",
  );
});

test("W1-T253: headroomPolicyFromCurve converts the SHIPPED policy's curve (null catch-all) into daemon.ts's HeadroomPolicy shape (Infinity catch-all) at the SAME values buildDefaultHeadroomPolicy's fs-free fallback carries", () => {
  const converted = headroomPolicyFromCurve(SHIPPED.values.headroom.curve);
  const fallback = buildDefaultHeadroomPolicy();
  assert.deepEqual(converted, fallback, "today's shipped policy and daemon.ts's fs-free fallback must agree");
  assert.equal(converted[converted.length - 1].maxHoursToReset, Infinity, "the catch-all rung maps null -> Infinity");
  assert.equal(resolveHeadroomLimitPct(1, converted), 100, "inside the final day the ceiling relaxes to 100%");
  assert.equal(resolveHeadroomLimitPct(48, converted), SHIPPED.values.headroom.reservePct, "otherwise it holds at the reserve");
});

// ── The atomic-coupling guard: enumerate EVERY collected-constant site in one place — a
// wiring only a SUBSET of the six files leaves this red, which is the point (W1-T253's
// design note: "unsatisfiable piecewise"). ─────────────────────────────────────────────

test("W1-T253 GUARD: no collected operating constant resolves from a source literal — every site above reads the loaded policy", () => {
  // review.ts's proofTimeoutMs is deliberately ABSENT from this table: W1-T253 removed its
  // source-level DEFAULT_PROOF_TIMEOUT_MS literal entirely in favour of a read of the policy
  // itself, so there is no independent consumer constant left to enumerate here — the real
  // "reads the policy, not a literal" proof for that site is the capturing-spawner test above,
  // which observes the EXECUTOR's effective timeout directly rather than a second copy of it.
  const sites: Array<{ site: string; actual: unknown; expected: unknown }> = [
    { site: "worker.ts pruneGraceMs", actual: DEFAULT_PRUNE_GRACE_MS, expected: SHIPPED.values.pruneGraceMs },
    { site: "daemon.ts pollIntervalMs (fs-free fallback)", actual: DEFAULT_POLL_INTERVAL_MS, expected: SHIPPED.values.pollIntervalMs },
    { site: "sweep.ts staleDays", actual: DEFAULT_SWEEP_POLICY.staleDays, expected: SHIPPED.values.sweep.staleDays },
    { site: "sweep.ts strikeCap", actual: DEFAULT_SWEEP_POLICY.strikeCap, expected: SHIPPED.values.sweep.strikeCap },
    { site: "sweep.ts wipLimit", actual: DEFAULT_SWEEP_POLICY.wipLimit, expected: SHIPPED.values.sweep.wipLimit },
    { site: "sweep.ts dispatchLanes", actual: DEFAULT_SWEEP_POLICY.dispatchLanes, expected: SHIPPED.values.sweep.dispatchLanes },
    { site: "sweep.ts dailyCostCeilingUsd", actual: DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd, expected: SHIPPED.values.sweep.dailyCostCeilingUsd },
    { site: "drain.ts max (fs-free fallback)", actual: DEFAULT_MAX, expected: SHIPPED.values.drain.max },
  ];
  for (const { site, actual, expected } of sites) {
    assert.equal(actual, expected, `${site} must equal the LOADED policy's value, not a stale literal`);
  }
  // daemon.ts's/drain.ts's REAL (fs-free) wiring is threaded at the CLI entry — proven above
  // by the daemonCommand/drainCommand source assertions; launchd.ts's net-new ThrottleInterval
  // is proven above by generateLaunchdPlist's own default+override assertions.
  assert.match(runTaskSrc, /const policy = loadPolicy\(policyPath\(repoRoot\)\);/);
  assert.match(runTaskSrc, /const drainMax = loadPolicy\(policyPath\(repoRoot\)\)\.values\.drain\.max;/);
});
