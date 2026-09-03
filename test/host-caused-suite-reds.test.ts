/**
 * test/host-caused-suite-reds.test.ts — W1-T2234.
 *
 * THE GAP. Every `runs-on:` in .github/workflows/ci.yml is `ubuntu-latest` (29 occurrences, 0
 * `macos`), so a lane running `rmd preflight --ci-parity` on a darwin machine shells `npm run
 * test:ci` and meets reds a required check has never once seen — 26 of them at the census sha,
 * 17 alone from `deploy/recycle-container.sh`'s one `declare -A` line on a host whose bash is
 * 3.2. This suite proves `lib/ci-parity.ts`'s `ci:host-caused-suite-reds` step: it REPORTS which
 * clusters this host is expected to produce (acceptance 1), a cluster this host does NOT match
 * is never claimed (acceptance 4, the mirror of "never absorbed"), nothing here ever makes
 * `ci:test` itself quieter — a failure it did not predict, or any failure at all, still fails
 * the run exactly as loudly as before (acceptance 2), no test is skipped anywhere to get there
 * (acceptance 3), and `ci:test`'s own invocation is byte-identical to what it was before this
 * step existed (acceptance 5).
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import {
  CI_PARITY_TABLE,
  HOST_CAUSED_SUITE_REDS,
  computeHostFacts,
  detectHostFacts,
  hostCausedSuiteRedsForFacts,
  hostCausedSuiteRedsStep,
  parseBashMajorVersion,
  runCiParity,
  type HostFacts,
} from "../src/lib/ci-parity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/** Records every spawn call, falling back to a clean `{status: 0}` for anything unlisted —
 *  duplicated locally per test/preflight-ci-parity.test.ts's own file-scoping convention. */
function recordingSpawn(map: Record<string, { status: number; stdout?: string; stderr?: string }> = {}) {
  const calls: { file: string; args: string[]; opts?: { cwd?: string; input?: string; stream?: boolean } }[] = [];
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

// W1-T2770: `nodeVersion`/`pinnedNodeVersion` set to the same value so this fixture's platform
// axis is not accidentally coupled to the merge-lcov cluster's node-version-drift predicate —
// every existing assertion below is about the platform/bash/meminfo axes, and a fixture that
// silently triggered a fourth cluster would make those assertions read the wrong signal.
const DARWIN_BASH_3_2: HostFacts = {
  platform: "darwin",
  bashMajorVersion: 3,
  hasProcMeminfo: false,
  nodeVersion: "22.22.3",
  pinnedNodeVersion: "22.22.3",
};
const LINUX_CI: HostFacts = {
  platform: "linux",
  bashMajorVersion: 5,
  hasProcMeminfo: true,
  nodeVersion: "22.22.3",
  pinnedNodeVersion: "22.22.3",
};

// ── acceptance 1: a lane reports which suite failures are host-caused ───────────────────────

test("HOST_CAUSED_SUITE_REDS: the registry's per-cluster counts sum correctly — each cluster's file/cause/count row must match, not just the total", () => {
  // Counts asserted PER CLUSTER, not merely against a magic total: a total-only compare hides
  // a cluster whose count moved AND a cluster whose count moved the other way by the same
  // amount, and it silently rebases the "wrong carried 16" evidence trail every time a cluster
  // is added.
  //
  // W1-T2776 RE-KEYED THIS TABLE FROM CAUSE TO FILE. Keying by cause silently asserted that a
  // cause has exactly ONE file, and that assumption is what the registry's gap was made of: the
  // bash-3.2 cluster has EIGHT files, seven of which went unregistered for hundreds of commits.
  // Per-FILE rows keep every property the cause-keyed version had — each row still pins one
  // measured count, a removed registry entry still fails the length check — while letting the
  // registry say the true thing about a cluster that spans files.
  const expected: Record<string, { cause: string; count: number }> = {
    // The W1-T2234 census figure, deliberately NOT rebased to today's measured 18 — see the
    // note beside the entry in src/lib/ci-parity.ts. This row is the evidence trail the test's
    // own header paragraph is about.
    "test/recycle-container.test.ts": { cause: "bash-3.2-no-associative-arrays", count: 17 },
    // W1-T2776: measured 2026-09-03, one `node --test` run per file on the mini. Every one of
    // these spawns deploy/recycle-container.sh through the PATH `bash` (3.2 on darwin).
    "test/a-lock-whose-container-is-gone-is-reclaimed-not-waited-on.test.ts": { cause: "bash-3.2-no-associative-arrays", count: 8 },
    "test/a-recycle-refuses-a-state-dir-that-is-not-a-checkout.test.ts": { cause: "bash-3.2-no-associative-arrays", count: 5 },
    "test/app-auth-satisfies-the-recycle-credential-refusal.test.ts": { cause: "bash-3.2-no-associative-arrays", count: 6 },
    "test/daemon-default-credential.test.ts": { cause: "bash-3.2-no-associative-arrays", count: 1 },
    "test/recycle-capture-falls-back-to-the-shell.test.ts": { cause: "bash-3.2-no-associative-arrays", count: 3 },
    "test/the-recovery-path-merges-into-a-shared-checkout.test.ts": { cause: "bash-3.2-no-associative-arrays", count: 8 },
    "test/the-recycle-wait-is-sized-under-the-run-it-waits-on.test.ts": { cause: "bash-3.2-no-associative-arrays", count: 5 },
    "test/worker-credential-preflight.test.ts": { cause: "darwin-keychain-unprovisioned", count: 2 },
    "test/fleet-heartbeat.test.ts": { cause: "bsd-date-control-arm", count: 2 },
    "test/recovery-drill.test.ts": { cause: "undiagnosed-ps-orphan-sweep", count: 2 },
    "test/dispatch-memory-governor.test.ts": { cause: "linux-procfs-absent", count: 1 },
    "test/proof-spawner-env-isolation.test.ts": { cause: "macos-corefoundation-env-leak", count: 1 },
    "test/worker.test.ts": { cause: "w1-t2205-e2e-darwin-keychain-asymmetry", count: 1 },
    // W1-T2770: the merge-lcov Node-pin-drift cluster is guarded by nodeVersion vs
    // pinnedNodeVersion, an axis independent of the platform/bash/procfs axes above; MEASURED
    // count is exactly the six coverage-merge-CLI tests that fail on any string mismatch.
    "test/merge-lcov.test.ts": { cause: "node-version-drift-from-pin", count: 6 },
  };
  for (const entry of HOST_CAUSED_SUITE_REDS) {
    const row = expected[entry.file];
    assert.ok(row, `unregistered file ${entry.file} — declare its expected cause and count here or remove it from the registry`);
    assert.equal(entry.cause, row.cause, `${entry.file} cause`);
    assert.equal(entry.count, row.count, `${entry.file} count`);
  }
  assert.equal(
    HOST_CAUSED_SUITE_REDS.length,
    Object.keys(expected).length,
    "the registry length must match this table's row count — an entry removed from the registry but not from here would pass silently",
  );
  assert.equal(
    new Set(HOST_CAUSED_SUITE_REDS.map((e) => e.file)).size,
    HOST_CAUSED_SUITE_REDS.length,
    "one row per FILE — a duplicated file would let two rows disagree about the same measurement",
  );

  const bash = HOST_CAUSED_SUITE_REDS.find((e) => e.cause === "bash-3.2-no-associative-arrays");
  assert.equal(bash?.file, "test/recycle-container.test.ts");
});

test("hostCausedSuiteRedsForFacts: a host that satisfies EVERY axis matches every registered cluster (all `appliesTo` predicates read true)", () => {
  // The full-house case: darwin + bash 3.2 + no procfs (the original axes) AND a
  // running-Node/pin mismatch (W1-T2770's axis). Each cluster keys off one of these; the
  // fixture must exercise all of them for the equality below to hold.
  const allAxes: HostFacts = { ...DARWIN_BASH_3_2, nodeVersion: "22.23.2", pinnedNodeVersion: "22.22.3" };
  const applicable = hostCausedSuiteRedsForFacts(allAxes);
  assert.equal(applicable.length, HOST_CAUSED_SUITE_REDS.length, "every axis satisfied => every cluster applies");
});

test("hostCausedSuiteRedsStep: on a full-house darwin/bash-3.2/node-drift host, the step NAMES the applicable clusters — file, cause and count — so a lane can subtract them from ci:test's own FAIL", () => {
  const allAxes: HostFacts = { ...DARWIN_BASH_3_2, nodeVersion: "22.23.2", pinnedNodeVersion: "22.22.3" };
  const step = hostCausedSuiteRedsStep(allAxes);
  assert.equal(step.ok, true, "informational — never its own verdict");
  assert.match(step.detail, /test\/recycle-container\.test\.ts/);
  assert.match(step.detail, /bash-3\.2-no-associative-arrays/);
  assert.match(step.detail, /~17 test\(s\)/);
  assert.match(step.detail, /test\/merge-lcov\.test\.ts/);
  assert.match(step.detail, /node-version-drift-from-pin/);
  // The banner reports "N of M" where M is the registry size — matched loosely on the numbers
  // so a future added cluster does not re-break this assertion for the same reason today's did.
  assert.match(
    step.detail,
    new RegExp(`${HOST_CAUSED_SUITE_REDS.length} of ${HOST_CAUSED_SUITE_REDS.length} known host-caused suite-red cluster\\(s\\) apply`),
  );
});

test("CI_PARITY_TABLE: the 'ci' job entry runs a DEDICATED ci:host-caused-suite-reds step, named independently of ci:test — same shape as W1-T373's ci:cli-reference-check precedent", () => {
  const { spawn } = recordingSpawn();
  const ciEntry = CI_PARITY_TABLE.find((e) => e.job === "ci")!;
  assert.ok(ciEntry && ciEntry.mirrored, "the 'ci' job must be a mirrored entry");
  const steps = ciEntry.run!(REPO_ROOT, spawn);
  const step = steps.find((s) => s.name === "ci:host-caused-suite-reds");
  assert.ok(step, "expected a 'ci:host-caused-suite-reds' step in the 'ci' job entry's run()");
});

test("runCiParity: ci:host-caused-suite-reds is present in the full run's steps and reports independently — same discipline as every other named step", () => {
  const { spawn } = recordingSpawn();
  const result = runCiParity(REPO_ROOT, { spawn });
  const step = result.steps.find((s) => s.name === "ci:host-caused-suite-reds")!;
  assert.ok(step, "expected the step in the full runCiParity output");
  assert.equal(step.ok, true);
});

// ── acceptance 4: a diff-caused failure is never absorbed into the host-caused set ──────────

test("hostCausedSuiteRedsForFacts: a linux/bash-5/with-procfs host matches NOTHING — none of the seven predicates read true off this host's own facts", () => {
  const applicable = hostCausedSuiteRedsForFacts(LINUX_CI);
  assert.deepEqual(applicable, [], "no cluster's appliesTo() is satisfied by a linux CI runner's facts");
});

test("hostCausedSuiteRedsStep: on a linux CI host, the step reports 0 applicable clusters and says a ci:test failure here is the diff's own", () => {
  const step = hostCausedSuiteRedsStep(LINUX_CI);
  assert.equal(step.ok, true);
  assert.match(step.detail, /0 of \d+ known host-caused suite-red cluster\(s\) apply/);
  assert.match(step.detail, /any ci:test failure here is this diff's own/);
});

test("computeHostFacts / parseBashMajorVersion: an UNPARSEABLE or missing bash version reads as undefined, never a guessed 0 or a false match on the bash-3.2 cluster", () => {
  assert.equal(parseBashMajorVersion(""), undefined);
  assert.equal(parseBashMajorVersion("not a version string"), undefined);
  const facts = computeHostFacts({
    platform: "darwin",
    bashVersionText: "",
    hasProcMeminfo: true,
    nodeVersion: "22.22.3",
    nvmrcText: "22.22.3\n",
  });
  assert.equal(facts.bashMajorVersion, undefined);
  const applicable = hostCausedSuiteRedsForFacts(facts);
  assert.equal(
    applicable.some((e) => e.cause === "bash-3.2-no-associative-arrays"),
    false,
    "an unknown bash version must never be read as 'applies' — a probe that cannot tell must not guess",
  );
});

// ── acceptance 2: a NEW/undeclared host-caused failure still fails the lane loudly ──────────

test("runCiParity: ci:test's own FAIL is completely unaffected by ci:host-caused-suite-reds — a diff-caused (or ANY undeclared) red stays loud and blocking regardless of what the triage step names", () => {
  const { spawn } = recordingSpawn({ "npm run test:ci": { status: 1, stderr: "not ok 1 - some brand new test this diff broke" } });
  const result = runCiParity(REPO_ROOT, { spawn });

  const ciTest = result.steps.find((s) => s.name === "ci:test")!;
  assert.equal(ciTest.ok, false, "ci:test's own exit-code-derived verdict is untouched");

  const triage = result.steps.find((s) => s.name === "ci:host-caused-suite-reds")!;
  assert.equal(triage.ok, true, "the triage step is informational and never itself fails");

  // The overall run stays red — nothing here quietly absorbs the failure.
  assert.equal(result.ok, false, "a red ci:test still fails the WHOLE lane, exactly as loudly as before this step existed");
});

test("hostCausedSuiteRedsStep: a cluster's appliesTo() predicate is never satisfied merely because the FILE matches — it is keyed on host facts, so a new/undeclared break in a registered file is never claimed as this host's own", () => {
  // Same file as the darwin-keychain entry, but linux facts: the entry must not apply.
  const linuxFacts: HostFacts = {
    platform: "linux",
    bashMajorVersion: 5,
    hasProcMeminfo: true,
    nodeVersion: "22.22.3",
    pinnedNodeVersion: "22.22.3",
  };
  const applicable = hostCausedSuiteRedsForFacts(linuxFacts);
  assert.equal(
    applicable.some((e) => e.file === "test/worker-credential-preflight.test.ts"),
    false,
    "the darwin-keychain cluster must not be claimed on a host that isn't darwin",
  );
});

// ── acceptance 3: no test is skipped on any platform to reach the separation ────────────────

test("CI_PARITY_TABLE: adding ci:host-caused-suite-reds does not remove or gate ci:test — both steps are present regardless of host facts, on every platform", () => {
  const { spawn } = recordingSpawn();
  const ciEntry = CI_PARITY_TABLE.find((e) => e.job === "ci")!;
  const steps = ciEntry.run!(REPO_ROOT, spawn);
  const names = steps.map((s) => s.name);
  assert.ok(names.includes("ci:test"), "ci:test must still run — nothing here skips it");
  assert.ok(names.includes("ci:host-caused-suite-reds"), "the new triage step runs alongside it, never instead of it");
  assert.ok(names.includes("ci:typecheck"));
  assert.ok(names.includes("ci:cli-reference-check"));
});

test("hostCausedSuiteRedsStep: never returns ok: false for ANY combination of host facts — it cannot itself skip or gate a test, only report", () => {
  const combos: HostFacts[] = [
    DARWIN_BASH_3_2,
    LINUX_CI,
    { platform: "darwin", bashMajorVersion: undefined, hasProcMeminfo: true, nodeVersion: "22.22.3", pinnedNodeVersion: "22.22.3" },
    { platform: "win32", bashMajorVersion: undefined, hasProcMeminfo: false, nodeVersion: "22.22.3", pinnedNodeVersion: "22.22.3" },
  ];
  for (const facts of combos) {
    assert.equal(hostCausedSuiteRedsStep(facts).ok, true, `facts=${JSON.stringify(facts)} must still report ok: true`);
  }
});

// ── acceptance 5: the ci-parity step still shells the full suite exactly as it does today ───

test("CI_PARITY_TABLE: ci:test still invokes exactly `npm run test:ci`, streamed, with no scope-narrowing argv — unchanged by ci:host-caused-suite-reds' addition", () => {
  const { spawn, calls } = recordingSpawn();
  const ciEntry = CI_PARITY_TABLE.find((e) => e.job === "ci")!;
  ciEntry.run!(REPO_ROOT, spawn);

  const call = calls.find((c) => c.file === "npm" && c.args.join(" ") === "run test:ci");
  assert.ok(call, "expected an `npm run test:ci` call, argv unchanged");
  assert.equal(call!.args.length, 2, "no extra flag was added to narrow or filter the suite");
  assert.equal(call!.opts?.stream, true, "still streamed — this step must not reintroduce the swallowed-output regression");
  assert.equal(call!.opts?.cwd, REPO_ROOT);
});

test("ci:host-caused-suite-reds does not itself spawn `npm run test:ci` a second time — it derives facts from bash --version and /proc/meminfo only, never re-running the suite", () => {
  const { spawn, calls } = recordingSpawn();
  const ciEntry = CI_PARITY_TABLE.find((e) => e.job === "ci")!;
  ciEntry.run!(REPO_ROOT, spawn);

  const testCiCalls = calls.filter((c) => c.file === "npm" && c.args.join(" ") === "run test:ci");
  assert.equal(testCiCalls.length, 1, "the full suite must be shelled EXACTLY ONCE per ci-parity run — the triage step must never double its cost");
});

test("detectHostFacts: spawns `bash` (not a second npm test:ci) to read the version, and checks /proc/meminfo via the injected hasFile — never the real filesystem in a test", () => {
  const { spawn, calls } = recordingSpawn({ bash: { status: 0, stdout: "5.2.15(1)-release\n" } });
  const facts = detectHostFacts(REPO_ROOT, spawn, (p) => p === "/proc/meminfo");
  assert.equal(facts.bashMajorVersion, 5);
  assert.equal(facts.hasProcMeminfo, true);
  assert.ok(calls.some((c) => c.file === "bash"), "expected a bash invocation to read $BASH_VERSION");
  assert.equal(
    calls.some((c) => c.args.join(" ").includes("test:ci")),
    false,
    "detecting host facts must never itself shell the suite",
  );
});

test("detectHostFacts: a spawn that THROWS (bash not found) is caught locally and reads as bashMajorVersion: undefined — never an uncaught throw out of the step", () => {
  const throwingSpawn: PreflightSpawn = () => {
    throw new Error("ENOENT: bash not found");
  };
  const facts = detectHostFacts(REPO_ROOT, throwingSpawn, () => false);
  assert.equal(facts.bashMajorVersion, undefined);
});
