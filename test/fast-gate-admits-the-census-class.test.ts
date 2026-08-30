import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { FAST_GATE_CENSUS_BOUND_MS, FAST_GATE_STEPS, runPreflightFast } from "../src/lib/ci-parity.js";

// ── W1-T2478: the fast gate admits the census class under a MEASURED bound ─────────────────────
//
// THE DEFECT. Six suites walk the whole `src/**` population and assert over it — a pure source
// scan plus a written baseline/exemption table, structurally identical to `claims`/`jscpd`/
// `depcruise`, which `rmd preflight --fast` already runs. The fast gate ran none of them, because
// `FAST_GATE_STEPS`'s old design (iii) excluded anything that spawns `node --test` BY MECHANISM,
// not by cost. `test/bound-kind-declared.test.ts` blocked #3304 on a single undeclared
// bound-shaped constant, with a clean fast run immediately before it.
//
// WHAT THIS FILE PROVES, ONE TEST GROUP PER ACCEPTANCE CLAIM (see the task shard's own
// `acceptance:` list): the four census suites this task admits (bound-kind, catch-erasure,
// negative-reachability, no-shallowing) are reachable from `--fast` and measure under
// `FAST_GATE_CENSUS_BOUND_MS`; a step that runs OVER that bound is refused BY THE MEASUREMENT,
// generically, never by a name-matched exception; the admission reason is a stated predicate;
// the mode still never shells the full suite; the bound-kind suite's own fixture proves the
// #3304 omission shape is caught; the seven pre-existing steps are untouched; a failing census
// step names itself and its own failure text; and removing the census entries restores the old
// blind spot.
//
// A FIFTH SUITE (`test/enforcement-data-carveout.test.ts`, measured ~2.1s alone in this
// environment) is deliberately NOT added here — over `FAST_GATE_CENSUS_BOUND_MS`, it stays out
// until it is made cheaper or its own cost is argued separately, refused by the same predicate a
// future entry would be, never by a written exception (task rationale, "NOT IN SCOPE").

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const REAL_PACKAGE_JSON = JSON.stringify({
  scripts: Object.fromEntries(FAST_GATE_STEPS.map((s) => [s.script, "echo stub"])),
});

/** Records every spawn call and answers from a lookup table keyed by a substring of
 *  `[file, ...args].join(" ")`, falling back to a clean `{status: 0}` for anything unlisted —
 *  duplicated locally per test/preflight-fast-mode.test.ts's own file-scoping convention. */
function recordingSpawn(map: Record<string, { status: number; stdout?: string; stderr?: string }> = {}) {
  const calls: { file: string; args: string[]; opts?: { cwd?: string; input?: string } }[] = [];
  const spawn: PreflightSpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const key = [file, ...args].join(" ");
    for (const [needle, result] of Object.entries(map)) {
      if (key.includes(needle)) {
        return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
}

const CENSUS_STEPS = FAST_GATE_STEPS.filter((s) => s.boundMs !== undefined);
const NON_CENSUS_STEPS = FAST_GATE_STEPS.filter((s) => s.boundMs === undefined);

// ═══════════════════ acceptance: "the fast gate runs every census suite that ═══════════════════
// ═══════════════════ measures under the per-step bound" ═════════════════════════════════════

test("FAST_GATE_STEPS: exactly four census entries, each bound at the shared FAST_GATE_CENSUS_BOUND_MS constant — never a one-off number per entry", () => {
  assert.equal(CENSUS_STEPS.length, 4, "the task admits exactly four of the six measured census suites");
  for (const step of CENSUS_STEPS) {
    assert.equal(step.boundMs, FAST_GATE_CENSUS_BOUND_MS, `${step.job} must reference the shared PRIMARY CONTROL constant`);
  }
  assert.equal(NON_CENSUS_STEPS.length, 8, "the seven pre-existing npm-script gates plus W1-T2488's source-size-ratchet are untouched by this task");
});

test("runPreflightFast: run for real (unmocked, real spawn, real package.json) over ONLY the four census entries, every one measures under the bound and passes on this HEAD", () => {
  // Isolated from the seven pre-existing entries via the `steps` seam — one of those seven
  // (cli-reference:check) is independently fragile in a sandboxed test runner (tsx's own IPC
  // pipe setup, unrelated to this task's diff), and this claim is specifically about the census
  // class this task adds, not a re-verification of the other seven's own environment.
  const result = runPreflightFast(REPO_ROOT, { steps: CENSUS_STEPS });
  assert.equal(result.steps.length, 4);
  for (const step of result.steps) {
    assert.equal(step.ok, true, `expected ${step.name} to pass on a clean HEAD: ${step.detail}`);
    assert.doesNotMatch(step.detail, /BOUND EXCEEDED/, `${step.name} must not report BOUND EXCEEDED on a clean, fast run`);
  }
  assert.equal(result.ok, true);
});

// ═══════════════════ acceptance: "a census suite measured over the bound is refused by ═════════
// ═══════════════════ the bound and not by an exception" ═════════════════════════════════════

test("runPreflightFast: an entry whose OWN measured wall time exceeds boundMs is refused as BOUND EXCEEDED even though its command exits zero — proven against a synthetic job name the production source never mentions, so the mechanism cannot be a name-matched exception", () => {
  const { spawn } = recordingSpawn(); // every call returns {status: 0} — the underlying command WOULD pass
  const clockTicks = [0, 2500]; // start=0ms, elapsed reads 2500ms > FAST_GATE_CENSUS_BOUND_MS (2000ms)
  let tick = 0;
  const now = () => clockTicks[tick++];
  const syntheticSteps = [
    { job: "synthetic-slow-census-zzq", script: "synthetic-slow-census-zzq", reason: "test fixture only", boundMs: FAST_GATE_CENSUS_BOUND_MS },
  ];
  const packageJsonText = JSON.stringify({ scripts: { "synthetic-slow-census-zzq": "echo stub" } });

  const result = runPreflightFast(REPO_ROOT, { spawn, now, steps: syntheticSteps, packageJsonText });
  const step = result.steps[0];

  assert.equal(step.ok, false);
  assert.match(step.detail, /BOUND EXCEEDED/);
  assert.match(step.detail, /would have PASSed/, "the underlying command DID succeed — refusal is the measured bound, not the command's own exit code");
  assert.doesNotMatch(step.detail, /FAIL —/, "must not be reported as an ordinary command failure");
  assert.equal(result.ok, false);
});

test("src/lib/ci-parity.ts contains no per-job-name branch deciding admission — the generic bound above fired for a job name the module's own source text never mentions", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "lib", "ci-parity.ts"), "utf8");
  assert.doesNotMatch(source, /synthetic-slow-census-zzq/, "sanity: the fixture name really is foreign to production source");
  assert.doesNotMatch(source, /job\s*===\s*["']/, "no `job === \"...\"` branch anywhere in the module — admission is never decided by matching a job's own name");
});

// ═══════════════════ acceptance: "admission is decided by a stated predicate rather than ═══════
// ═══════════════════ an enumerated list" ═════════════════════════════════════════════════════

test("FAST_GATE_STEPS: every census entry's reason states the predicate (the tracked population it walks, that it asserts over every file, and its own baseline/exemption table) rather than resting on bare list membership", () => {
  for (const step of CENSUS_STEPS) {
    assert.match(step.reason, /walks tracked/, `${step.job}: reason must name the population it walks`);
    assert.match(step.reason, /asserts/, `${step.job}: reason must state what it asserts`);
    assert.match(step.reason, /baseline|EXEMPTIONS|grandfather/i, `${step.job}: reason must name its baseline/exemption table`);
  }
});

// ═══════════════════ acceptance: "the fast gate still never shells the full suite" ══════════════

test("package.json: every census:* script names exactly ONE test file, never the test/**/*.test.ts glob, test:ci, or a bare npm test", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const step of CENSUS_STEPS) {
    const command = pkg.scripts[step.script];
    assert.ok(command, `package.json must declare "${step.script}"`);
    assert.doesNotMatch(command, /test:ci/, `${step.script} must not shell test:ci`);
    assert.doesNotMatch(command, /test\/\*\*/, `${step.script} must not shell the test/**/*.test.ts glob`);
    assert.doesNotMatch(command, /\bnpm (run )?test\b/, `${step.script} must not shell npm test`);
    const testFileMatches = command.match(/test\/[\w.\-/]+\.test\.ts/g) ?? [];
    assert.equal(testFileMatches.length, 1, `${step.script} must name exactly one test file, got: ${command}`);
  }
});

test("runPreflightFast: mocked end-to-end over all twelve FAST_GATE_STEPS, no spawn call ever names test:ci, a bare npm test, or the test/**/*.test.ts glob", () => {
  const { spawn, calls } = recordingSpawn();
  runPreflightFast(REPO_ROOT, { spawn, packageJsonText: REAL_PACKAGE_JSON });
  assert.equal(calls.length, FAST_GATE_STEPS.length, "exactly one spawn per curated step, no extras");
  for (const call of calls) {
    const key = [call.file, ...call.args].join(" ");
    assert.doesNotMatch(key, /test:ci/);
    assert.doesNotMatch(key, /test\/\*\*/);
    assert.equal(call.file, "npm", "every FAST_GATE_STEPS spawn — census or not — is an `npm run --silent <script>` call, never a direct node invocation");
  }
});

// ═══════════════════ acceptance: "the bound-kind census now fails a fast run on the ════════════
// ═══════════════════ omission that reddened the build" ══════════════════════════════════════

test("census:bound-kind targets test/bound-kind-declared.test.ts, and that suite's OWN fixture PROPERTY test proves an undeclared, non-grandfathered bound-shaped constant (the #3304 ADOPTION_MINT_CEILING shape) is reported as a violation — run directly, unmocked, filtered to that one property", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const command = pkg.scripts["census:bound-kind"];
  assert.match(command, /test\/bound-kind-declared\.test\.ts/, "census:bound-kind must target the bound-kind census file");

  // NODE_TEST_CONTEXT/NODE_OPTIONS stripped — same isolation test/reapable-prefix.test.ts and
  // test/route-scope-matrix.test.ts already establish for a nested `node --test` spawned from
  // WITHIN a `node --test` run (this file's own): left inherited, the child's own recursion
  // guard silently "skips running files" and exits 0 having asserted nothing, which is exactly
  // the false-PASS shape src/lib/ci-parity.ts's `withoutNodeTestContext` exists to prevent in
  // `runPreflightFast` itself — this direct call needs the identical guard.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_OPTIONS;
  const output = execFileSync(
    process.execPath,
    [
      "--test",
      "--import",
      "tsx",
      "--import",
      "./test/setup/tmp-hygiene.ts",
      "--test-name-pattern",
      "newly added bound-shaped constant with no declared kind fails and names it",
      "test/bound-kind-declared.test.ts",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", env: childEnv },
  );
  assert.match(
    output,
    /# pass 1/,
    "the fixture PROPERTY test — which plants an undeclared bound-shaped constant and asserts it is reported as a violation, the exact #3304 shape — itself passes, proving the detection this census step now runs is real",
  );
});

test("FAST_GATE_STEPS now includes bound-kind-census wired to census:bound-kind — a --fast run reaches this suite for the first time", () => {
  assert.ok(FAST_GATE_STEPS.some((s) => s.job === "bound-kind-census" && s.script === "census:bound-kind"));
});

// ═══════════════════ acceptance: "every previously admitted fast step is still admitted ════════
// ═══════════════════ and still passes" ═══════════════════════════════════════════════════════

test("FAST_GATE_STEPS: the seven pre-existing entries carry no boundMs — this task does not re-audit their admission basis", () => {
  for (const step of NON_CENSUS_STEPS) {
    assert.equal(step.boundMs, undefined, `${step.job} must not carry a boundMs — its admission is unchanged by W1-T2478`);
  }
});

test("runPreflightFast: mocked, the seven pre-existing steps behave exactly as before this task — PASS, never timed, never BOUND EXCEEDED", () => {
  const { spawn } = recordingSpawn();
  const result = runPreflightFast(REPO_ROOT, { spawn, packageJsonText: REAL_PACKAGE_JSON });
  for (const step of NON_CENSUS_STEPS) {
    const reported = result.steps.find((s) => s.name === step.job);
    assert.ok(reported, `${step.job} missing from the result`);
    assert.equal(reported.ok, true, `${step.job}: ${reported.detail}`);
    assert.doesNotMatch(reported.detail, /BOUND EXCEEDED/, `${step.job} carries no boundMs and must never be timed`);
  }
});

test("package.json: the seven pre-existing FAST_GATE_STEPS commands are byte-identical to before this task", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["cli-reference:check"], "tsx scripts/generate-cli-reference.mjs --check");
  assert.equal(pkg.scripts["claims"], "node scripts/claims-check.mjs");
  assert.equal(pkg.scripts["learnings-budget-ratchet"], "node scripts/learnings-budget-ratchet.mjs");
  assert.equal(pkg.scripts["jscpd"], "jscpd src --config .jscpd.json");
  assert.equal(pkg.scripts["depcruise"], "depcruise src --config .dependency-cruiser.cjs");
  assert.equal(pkg.scripts["api-client:check"], "node scripts/generate-api-client.mjs --check");
  assert.equal(pkg.scripts["no-hand-rolled-fetch:check"], "node scripts/no-hand-rolled-fetch-check.mjs");
});

// ═══════════════════ acceptance: "the per-step bound is documented as a primary control and ════
// ═══════════════════ never as a backstop" ════════════════════════════════════════════════════

test("src/lib/ci-parity.ts documents the bound as a PRIMARY CONTROL and never labels it a backstop", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "lib", "ci-parity.ts"), "utf8");
  assert.match(source, /PRIMARY CONTROL/);
  assert.doesNotMatch(source, /is a backstop|as a backstop\b/i, "the bound must never itself be documented as a backstop");
});

// ═══════════════════ acceptance: "a failing census step names which suite failed rather than ═══
// ═══════════════════ a bare non-zero exit" ═══════════════════════════════════════════════════

test("runPreflightFast: a census step that genuinely fails (elapsed under the bound) reports the job name AND the captured failure text — never a bare non-zero exit, and never confused with BOUND EXCEEDED", () => {
  const failingOutput =
    "not ok 1 - PROPERTY every bound-shaped constant under src/ either declares its kind or is grandfathered\n" +
    "  ---\n" +
    "  error: undeclared, non-grandfathered bound(s): src/lib/newbound.ts:NEW_FEATURE_CAP\n";
  const { spawn } = recordingSpawn({ "census:bound-kind": { status: 1, stdout: failingOutput } });
  const result = runPreflightFast(REPO_ROOT, { spawn, packageJsonText: REAL_PACKAGE_JSON, steps: CENSUS_STEPS });

  const step = result.steps.find((s) => s.name === "bound-kind-census")!;
  assert.equal(step.ok, false);
  assert.match(step.detail, /^bound-kind-census: FAIL/, "named by its own job, not a bare exit code");
  assert.match(step.detail, /NEW_FEATURE_CAP/, "names the offending suite's own failure text, not just a status");
  assert.doesNotMatch(step.detail, /BOUND EXCEEDED/, "a genuine assertion failure under the bound must read as FAIL, not BOUND EXCEEDED");
});

// ═══════════════════ acceptance: "removing the census steps makes the omission pass a fast ═════
// ═══════════════════ run again" ══════════════════════════════════════════════════════════════

test("runPreflightFast: with the census entries removed from `steps`, a spawn that WOULD fail every census script is never even invoked for them — the fast gate goes back to blind, exactly the shape that let #3304 through a clean fast run", () => {
  const { spawn, calls } = recordingSpawn(Object.fromEntries(CENSUS_STEPS.map((s) => [s.script, { status: 1, stdout: "would have failed" }])));
  const result = runPreflightFast(REPO_ROOT, { spawn, packageJsonText: REAL_PACKAGE_JSON, steps: NON_CENSUS_STEPS });

  for (const step of CENSUS_STEPS) {
    const call = calls.find((c) => c.args.includes(step.script));
    assert.equal(call, undefined, `${step.script} must never be spawned once the census steps are removed from the list`);
  }
  assert.equal(result.steps.length, 8);
  assert.equal(result.ok, true, "with every pre-existing step at its default clean PASS and no census step present, the run reads green — the exact blind spot #3304 fell through");
});
