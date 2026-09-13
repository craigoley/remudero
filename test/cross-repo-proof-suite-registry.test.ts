/**
 * W1-T3525 — THE PROOF DIALECT'S SUITE ROOTS WERE A CLOSED TWO-ENTRY LIST HARDCODED IN review.ts.
 *
 * W1-T3178 taught the dialect a SECOND root (the dashboard's own `apps/dashboard/src/`) alongside
 * `test/`, but both arms lived inside THIS repo (`craigoley/remudero`) and neither was keyed on
 * WHICH repo owns the target being reviewed — there was one checkout, so that key was implicit.
 *
 * remudero-site (DECISIONS.md "W12-T1: THE SITE IS A SEPARATE REPOSITORY") needs its own registered
 * suite: a `tests/` root under its own checkout-local pinned Vitest, no forced config path. A THIRD
 * hardcoded arm string-matched on a path prefix would repeat W1-T3178's exact mistake one repo
 * later and could never REFUSE an unregistered target — so the suite roots are now a REGISTRY keyed
 * on the resolved canonical `owner/repo`, and a target repo the registry does not name is refused
 * rather than silently inheriting `test/`'s or the dashboard's runner.
 *
 * These cases drive the REAL exported parser and classifier, never a re-implementation of either.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  execWhitelistedProof,
  explainUnitTestProofRefusal,
  parseWhitelistedProof,
  pinnedVitestCli,
  vitestNameFilteredOutcome,
  VITEST_TAP_PLAN_RE,
  VITEST_TAP_RESULT_LINE_RE,
  VITEST_TAP_SKIP_RE,
  type ProofSpawner,
  type SuiteRegistryTarget,
} from "../src/lib/review.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP_HYGIENE_IMPORT = "./test/setup/tmp-hygiene.ts";

const REMUDERO: SuiteRegistryTarget = { owner: "craigoley", repo: "remudero" };
const REMUDERO_SITE: SuiteRegistryTarget = { owner: "craigoley", repo: "remudero-site" };
const UNKNOWN_TARGET: SuiteRegistryTarget = { owner: "someone-else", repo: "unregistered-repo" };

// A no-op preflight: these tests never need this REPOSITORY'S own Chromium cache warmed, and the
// real default would attempt it against the host's actual manifest (W1-T2317's ensureBrowsersOnce).
const NO_BROWSER_PREFLIGHT = { preflightBrowsers: () => {} };

test("W1-T3525: a remudero-site tests/ file resolves under its own checkout-local pinned Vitest, no forced config path", () => {
  const p = parseWhitelistedProof("unit test: tests/example.test.ts", REMUDERO_SITE);
  assert.ok(p, "a registered target's own declared root must resolve, not refuse");
  assert.equal(p!.kind, "test");
  assert.equal(p!.runner, "vitest");
  assert.equal(p!.command, "node", "run through the live node binary, never npx");
  assert.ok(
    p!.args.some((a) => a.endsWith(join("node_modules", "vitest", "vitest.mjs"))),
    "it runs the CHECKOUT'S OWN Vitest, pinned the same way the dashboard's is",
  );
  assert.equal(p!.args[1], "run", "run mode, never watch — a proof that never exits is a hung review");
  assert.ok(!p!.args.includes("--config"), "NO forced config path — remudero-site's checkout-local Vitest resolves its own");
  assert.ok(p!.args.includes("tests/example.test.ts"), "the repo-relative path survives into argv");
  // Re-rooting is checkout-local, not fixed to this reviewer's own tree (same mechanism the dashboard already relies on).
  assert.ok(pinnedVitestCli("/some/other/checkout").startsWith("/some/other/checkout/"));
});

test("W1-T3525: a target repo absent from the registry is refused with the dialect's own explainer, never inheriting another repo's runner", () => {
  assert.equal(parseWhitelistedProof("unit test: tests/example.test.ts", UNKNOWN_TARGET), null, "an unregistered target's exact-path arm must refuse");
  assert.equal(parseWhitelistedProof("unit test: an unregistered repo's bare title", UNKNOWN_TARGET), null, "and so must its bare-title arm — no fallback runner");

  const why = explainUnitTestProofRefusal("unit test: tests/example.test.ts", UNKNOWN_TARGET);
  assert.ok(why, "the refusal must carry a sentence, not a bare null");
  assert.match(why!, /no registered suite/i);
  assert.match(why!, /someone-else\/unregistered-repo/, "it names the UNREGISTERED target, not this repo's own roots");
});

test("W1-T3525: the default target's test/ node --test argv and the dashboard's Vitest argv stay byte-for-byte unchanged", () => {
  // THE REGRESSION THAT WOULD RE-GRADE THE WHOLE CORPUS. Every pure-path proof in the plan runs
  // through this arm; a changed flag, a changed order or a dropped import re-grades all of them.
  const nodeProof = parseWhitelistedProof("unit test: test/deny-floor.test.ts");
  assert.ok(nodeProof);
  assert.deepEqual(
    nodeProof!.args,
    ["--test", "--import", "tsx", "--import", TMP_HYGIENE_IMPORT, "test/deny-floor.test.ts"],
    "node --test argv unchanged by the registry's introduction",
  );
  assert.equal(nodeProof!.nameFiltered, undefined);

  const dashboardProof = parseWhitelistedProof("unit test: apps/dashboard/src/App.test.tsx");
  assert.ok(dashboardProof);
  assert.deepEqual(
    dashboardProof!.args,
    [pinnedVitestCli(process.cwd()), "run", "--config", "apps/dashboard/vite.config.ts", "apps/dashboard/src/App.test.tsx"],
    "dashboard Vitest argv unchanged by the registry's introduction",
  );

  // Naming the default target EXPLICITLY must resolve identically to naming none at all.
  const explicitNode = parseWhitelistedProof("unit test: test/deny-floor.test.ts", REMUDERO);
  assert.deepEqual(explicitNode!.args, nodeProof!.args);
  const explicitDashboard = parseWhitelistedProof("unit test: apps/dashboard/src/App.test.tsx", REMUDERO);
  assert.deepEqual(explicitDashboard!.args, dashboardProof!.args);

  // The bare-TITLE arm for the default target is also untouched — still node --test, still name-filtered.
  const title = parseWhitelistedProof("unit test: a bare title unrelated to any suite root");
  assert.ok(title);
  assert.equal(title!.nameFiltered, true);
  assert.equal(title!.runner, undefined, "the default repo's bare-title arm never gains a runner field");
  assert.equal(title!.args[0], "--test");
});

test("W1-T3525: a `..` segment is refused on the new remudero-site root too", () => {
  assert.equal(parseWhitelistedProof("unit test: tests/../../../etc/passwd.test.ts", REMUDERO_SITE), null);
});

// ── Vitest's own exit-code trap (Vitest 5.0.0 exits 0 when every selected test is SKIPPED) ─────
//
// These TAP fixtures are MEASURED, not invented: captured from `node node_modules/vitest/vitest.mjs
// run --reporter=tap` against installed Vitest 5.0.0 (this checkout's own pinned version), against a
// 3-test fixture file (one passing, one failing, one `test.skip()`-declared) under each of four
// selections. Vitest's TAP is NESTED — the file's own wrapper prints at column 0, and every real
// leaf result is indented beneath it — unlike node's flat TAP stream, which is exactly why this
// needs its own parser rather than reusing {@link nameFilteredOutcome}'s.

const VITEST_TAP_ALL_SELECTED_SKIPPED = `TAP version 13
1..1
ok 1 - src/sample.test.ts # SKIP {
    1..3
    ok 1 - alpha passes # SKIP
    ok 2 - beta fails # SKIP
    ok 3 - gamma skipped # SKIP
}
`;

const VITEST_TAP_SELECTED_LEAF_PASSES = `TAP version 13
1..1
ok 1 - src/sample.test.ts # time=3.08ms {
    1..3
    ok 1 - alpha passes # time=1.42ms
    ok 2 - beta fails # SKIP
    ok 3 - gamma skipped # SKIP
}
`;

const VITEST_TAP_SELECTED_LEAF_FAILS = `TAP version 13
1..1
not ok 1 - src/sample.test.ts # time=6.55ms {
    1..3
    ok 1 - alpha passes # SKIP
    not ok 2 - beta fails # time=5.62ms
        ---
        error:
            name: "AssertionError"
            message: "expected 1 to be 2 // Object.is equality"
        at: "/tmp/vitest-probe/src/sample.test.ts:8:13"
        actual: "1"
        expected: "2"
        ...
    ok 3 - gamma skipped # SKIP
}
`;

// A run killed after only ONE of three planned files ever printed its wrapper, and even that one
// file's only leaf was skipped — the plan (`1..3`) is the one honest signal that two files' fates
// are still unknown, exactly the role node's trailing `# duration_ms` summary plays for the node arm.
const VITEST_TAP_TRUNCATED = `TAP version 13
1..3
ok 1 - src/a.test.ts # SKIP {
    1..1
    ok 1 - one # SKIP
}
`;

test("W1-T3525: a bare-title Vitest proof whose title exactly matches a selected, non-skipped leaf test passes", () => {
  assert.equal(vitestNameFilteredOutcome(VITEST_TAP_SELECTED_LEAF_PASSES), "pass");
});

test("W1-T3525: a bare-title Vitest proof whose title matches nothing selected is no-match on the zero exit, never read as a pass", () => {
  // THE TRAP ITSELF: this stream is exactly what Vitest 5.0.0 emits (exit 0) when every selected
  // test was skipped — name-filtered to nothing, or genuinely `test.skip()`-declared either way.
  assert.equal(vitestNameFilteredOutcome(VITEST_TAP_ALL_SELECTED_SKIPPED), "no-match");
});

test("W1-T3525: a bare-title Vitest proof whose selected leaf test fails is classified fail", () => {
  assert.equal(vitestNameFilteredOutcome(VITEST_TAP_SELECTED_LEAF_FAILS), "fail");
});

test("W1-T3525: truncated Vitest output is classified inconclusive (throws) rather than pass or fail", () => {
  assert.throws(() => vitestNameFilteredOutcome(VITEST_TAP_TRUNCATED), /truncated/, "cut off before the TAP plan count completed");
});

// ── The three TAP-parsing regexes {@link vitestNameFilteredOutcome} is built on, each exercised
// directly on BOTH arms (negative-reachability-ratchet, W1-T2317): a fixture merely driving the
// classifier as a whole cannot credit the regex it is text-searched by identifier, so each gets its
// own healthy/unhealthy pair here.

test("W1-T3525: VITEST_TAP_RESULT_LINE_RE matches an indented TAP result line and rejects a non-result line", () => {
  // Not a result line at all — the negative arm.
  assert.equal(VITEST_TAP_RESULT_LINE_RE.exec("TAP version 13"), null);
  // A real, indented result line, captured — the positive arm.
  assert.equal(VITEST_TAP_RESULT_LINE_RE.exec("    ok 1 - alpha passes # time=1.42ms")?.[2], "ok");
});

test("W1-T3525: VITEST_TAP_PLAN_RE matches a TAP13 plan line and rejects ordinary output", () => {
  // No plan line present — the negative arm.
  assert.equal(VITEST_TAP_PLAN_RE.exec("TAP version 13\nok 1 - x\n"), null);
  // The declared file count, captured — the positive arm.
  assert.equal(VITEST_TAP_PLAN_RE.exec("TAP version 13\n1..3\n")?.[1], "3");
});

test("W1-T3525: VITEST_TAP_SKIP_RE recognises Vitest's `# SKIP` comment and rejects a genuinely-run leaf's line", () => {
  assert.equal(VITEST_TAP_SKIP_RE.test("ok 1 - alpha passes # time=1.42ms"), false, "a genuinely-run leaf carries no SKIP marker");
  assert.equal(VITEST_TAP_SKIP_RE.test("ok 3 - gamma skipped # SKIP"), true, "Vitest's own skip marker");
});

test("W1-T3525: execWhitelistedProof routes a Vitest name-filtered proof through the Vitest classifier, not node's", () => {
  const p = parseWhitelistedProof("unit test: alpha passes", REMUDERO_SITE);
  assert.ok(p, "a bare title against the site's sole registered (Vitest-only) root must resolve");
  assert.equal(p!.runner, "vitest");
  assert.equal(p!.nameFiltered, true);

  const passSpawn: ProofSpawner = () => VITEST_TAP_SELECTED_LEAF_PASSES;
  assert.equal(execWhitelistedProof(p!, REPO_ROOT, 60_000, passSpawn, NO_BROWSER_PREFLIGHT), "pass");

  const skipSpawn: ProofSpawner = () => VITEST_TAP_ALL_SELECTED_SKIPPED;
  assert.equal(execWhitelistedProof(p!, REPO_ROOT, 60_000, skipSpawn, NO_BROWSER_PREFLIGHT), "no-match");

  // Vitest's own nonzero exit path: execFileSync throws, carrying the same TAP on the error's stdout.
  const failSpawn: ProofSpawner = () => {
    throw Object.assign(new Error("Command failed"), { status: 1, signal: null, stdout: VITEST_TAP_SELECTED_LEAF_FAILS });
  };
  assert.equal(execWhitelistedProof(p!, REPO_ROOT, 60_000, failSpawn, NO_BROWSER_PREFLIGHT), "fail");
});
