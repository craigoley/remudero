/**
 * THE SECOND POLE, AND THE DIFF THAT MAKES IT WORTH RUNNING.
 *
 * `ci` runs ubuntu. The review judge runs the operator's mini. Nothing runs both, and every
 * host-dependent test defect in this repo was found by someone happening to execute on the other
 * side. This suite covers the comparison that turns that convention into a measurement.
 *
 * THIS FILE IS ITSELF HOST-INDEPENDENT, and that is not decoration — a parity checker whose own
 * fixtures borrow the ambient environment would be the tenth instance of the defect it exists to
 * find. Every TAP stream below is a string literal, every seam is injected: nothing here spawns a
 * suite, reads $HOME, shells out to git, or writes a feedback entry.
 *
 * BOTH DIRECTIONS ARE REAL AND BOTH ARE COVERED. `test/fleet-heartbeat.test.ts`'s BSD tests fail on
 * the MINI; `test/recon-gaps-relayed.test.ts`'s byte-identity test fails on CI. A checker that only
 * knew one direction would call the other pole's divergence "clean".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_PARITY_BASELINE,
  diffHostParity,
  findSiblingDisagreements,
  normaliseTestPath,
  readTapFailures,
  renderHostParityReport,
  renderSiblingDisagreement,
  runHostParity,
  type DeclaredDivergence,
} from "../src/lib/host-parity.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A TAP stream the way `node --test` really writes one — `not ok`, the YAML block carrying
 *  `location:`, and the trailing summary that makes it a RESULT rather than a fragment. */
function tap(failures: { title: string; file: string }[], opts: { summary?: boolean; tests?: number } = {}): string {
  const body = failures
    .map(
      (f, i) =>
        `not ok ${i + 1} - ${f.title}\n` +
        "  ---\n" +
        "  duration_ms: 1.5\n" +
        "  type: 'test'\n" +
        `  location: '/somewhere/on/this/host/${f.file}:2:5626'\n` +
        "  failureType: 'testCodeFailure'\n" +
        "  ...\n",
    )
    .join("");
  const summary =
    `# tests ${opts.tests ?? 100}\n# suites 0\n# pass ${(opts.tests ?? 100) - failures.length}\n` +
    `# fail ${failures.length}\n# duration_ms 107391.2\n`;
  return `TAP version 13\n${body}${opts.summary === false ? "" : summary}`;
}

const BSD = {
  title: "the BSD/macOS branch of epoch_of computes the SAME age the GNU branch does",
  file: "test/fleet-heartbeat.test.ts",
};
const RECON = {
  title: "the RECON prompt is byte-identical to origin/main's — this changes the implement side only",
  file: "test/recon-gaps-relayed.test.ts",
};
const NOVEL = { title: "a brand new assertion nobody has declared", file: "test/some-new.test.ts" };

const id = (f: { title: string; file: string }) => `${f.file}::${f.title}`;

/** Every mini-pole entry the REAL baseline declares, as TAP-writable pairs. The suppression tests
 *  below observe the WHOLE set rather than one of it: with a subset, the entries left unobserved
 *  are correctly reported as healed, which would make "declared ⇒ silence" untestable. */
const ALL_MINI = HOST_PARITY_BASELINE.filter((d) => d.pole === "mini").map((d) => {
  const cut = d.test.indexOf("::");
  return { file: d.test.slice(0, cut), title: d.test.slice(cut + 2) };
});

// ── THE IDENTITY SURVIVES THE CROSSING ────────────────────────────────────────────────────────

test("a failure's identity is file::title, so the two poles' absolute roots cannot break the match", () => {
  // THE POINT: the mini reports /Users/craigoleyagent/…, a runner reports /home/runner/work/…. An
  // identity built on either can never match the other.
  assert.equal(normaliseTestPath("/Users/craigoleyagent/Remudero/remudero-s5/test/a.test.ts:2:56"), "test/a.test.ts");
  assert.equal(normaliseTestPath("/home/runner/work/remudero/remudero/test/a.test.ts:1:1"), "test/a.test.ts");
  const mini = readTapFailures(tap([BSD]));
  const ci = readTapFailures(
    tap([BSD]).replace("/somewhere/on/this/host/", "/home/runner/work/remudero/remudero/"),
  );
  assert.deepEqual(mini.failures, ci.failures, "the same test must produce the same identity on both poles");
});

test("a bare title is NOT the identity — two files carrying the same title stay distinct", () => {
  // Verbatim-shared titles are real here (`THE OTHER DIRECTION…` appears in several files), and a
  // collision would let one pole's failure mask another's.
  const r = readTapFailures(
    tap([
      { title: "THE OTHER DIRECTION", file: "test/one.test.ts" },
      { title: "THE OTHER DIRECTION", file: "test/two.test.ts" },
    ]),
  );
  assert.deepEqual(r.failures, ["test/one.test.ts::THE OTHER DIRECTION", "test/two.test.ts::THE OTHER DIRECTION"]);
});

// ── A TRUNCATED RUN IS NOT A RESULT ───────────────────────────────────────────────────────────

test("no trailing summary ⇒ INCONCLUSIVE, and nothing is diffed or captured", () => {
  // A killed run prints every assertion it reached and no totals, so its failure set is a SUBSET BY
  // CONSTRUCTION — it would read as "fewer divergences" and silently retire the check.
  const r = readTapFailures(tap([BSD, NOVEL], { summary: false }));
  assert.equal(r.complete, false);
  assert.deepEqual(r.failures, [], "an unfinished run reports no failures rather than a partial set");

  const captured: string[] = [];
  const out = runHostParity({
    pole: "mini",
    runSuite: () => tap([NOVEL], { summary: false }),
    capture: (raw) => captured.push(raw),
  });
  assert.equal(out.status, "inconclusive");
  assert.equal(out.captured, false, "an undeclared divergence in a truncated run must NOT be reported as one");
  assert.deepEqual(captured, []);
  assert.match(out.report, /INCONCLUSIVE/);
});

test("the retry wrapper's SECOND stream wins — a flake the retry cleared is not a divergence", () => {
  // MEASURED on #1644: scripts/test-with-retry.mjs re-runs the whole command on red, so one CI log
  // carries the same test as both `not ok` and `ok`. The job's conclusion came from the last run.
  const doubled = `${tap([BSD, NOVEL])}FLAKE-RETRY: first attempt failed — ${NOVEL.title}\n${tap([BSD])}`;
  const r = readTapFailures(doubled);
  assert.equal(r.complete, true);
  assert.deepEqual(r.failures, [id(BSD)], "only the final stream's failures count");
});

// ── DIRECTION 1: THE MINI POLE ────────────────────────────────────────────────────────────────

test("MINI: a declared divergence is silence — the baseline suppresses it", () => {
  const diff = diffHostParity({ observed: ALL_MINI.map(id), pole: "mini" });
  assert.deepEqual(diff.undeclared, [], "declared and observed ⇒ nothing to report");
  assert.deepEqual(diff.healed, [], "and none is claimed healed either");
  assert.ok(
    diff.declaredSeen.some((d) => d.test === id(BSD)),
    "the run must be able to prove it LOOKED, not merely that it said nothing",
  );
});

test("MINI: an UNDECLARED divergence is the finding — the baseline does NOT suppress it", () => {
  // The load-bearing pair with the test above: same pole, same call, one id in the baseline and one
  // not. If a change ever made these behave alike, the baseline would be a mute button.
  const diff = diffHostParity({ observed: [...ALL_MINI.map(id), id(NOVEL)], pole: "mini" });
  assert.deepEqual(diff.undeclared, [id(NOVEL)]);
  assert.deepEqual(diff.healed, [], "and the declared ones stay suppressed in the same call");
});

test("MINI: a declared entry that STOPS failing is reported — a baseline nobody prunes is a mute button", () => {
  const diff = diffHostParity({ observed: [], pole: "mini" });
  assert.ok(diff.healed.length > 0, "every mini entry passed, so every mini entry is stale");
  assert.ok(
    diff.healed.every((d) => d.pole === "mini"),
    "and the ci-pole entry is NOT claimed healed by a mini run — that is what the pole scoping is for",
  );
});

// ── DIRECTION 2 (THE OTHER POLE): CI ──────────────────────────────────────────────────────────

test("THE OTHER DIRECTION — CI: the ci-pole entry is declared there and undeclared on the mini", () => {
  // `recon-gaps-relayed`'s byte-identity test runs `git show origin/main:…`, and actions/checkout
  // has no fetch-depth, so the ref does not exist on a runner. It fails on CI and passes here.
  assert.deepEqual(diffHostParity({ observed: [id(RECON)], pole: "ci" }).undeclared, [], "declared for ci");
  assert.deepEqual(
    diffHostParity({ observed: [id(RECON)], pole: "mini" }).undeclared,
    [id(RECON)],
    "the SAME failure on the mini would be a new divergence — a pole-blind diff would call it declared",
  );
});

test("THE OTHER DIRECTION — CI: a mini-declared divergence appearing on CI is NOT suppressed", () => {
  assert.deepEqual(diffHostParity({ observed: [id(BSD)], pole: "ci" }).undeclared, [id(BSD)]);
});

// ── THE BASELINE ITSELF ───────────────────────────────────────────────────────────────────────

test("every declared divergence names a file that exists and carries a reason", () => {
  // An entry with no reason is an absent entry in a costume — CI_PARITY_TABLE's own distinction.
  // And an entry naming a deleted file is rot that would silently protect nothing.
  for (const d of HOST_PARITY_BASELINE) {
    const [file, ...rest] = d.test.split("::");
    assert.ok(rest.join("::").length > 0, `${d.test} must be file::title`);
    assert.ok(existsSync(join(REPO_ROOT, file ?? "")), `${file} must exist`);
    assert.ok(d.reason.trim().length > 20, `${d.test} must say WHY`);
  }
  assert.ok(
    HOST_PARITY_BASELINE.some((d) => d.pole === "mini") && HOST_PARITY_BASELINE.some((d) => d.pole === "ci"),
    "both poles must be represented — a one-pole baseline is the blind spot this exists to close",
  );
});

// ── END TO END, THROUGH THE REAL runHostParity ────────────────────────────────────────────────

test("a run whose failures are all declared is CLEAN and writes nothing", () => {
  const captured: string[] = [];
  const out = runHostParity({ pole: "mini", runSuite: () => tap(ALL_MINI), capture: (r) => captured.push(r) });
  assert.equal(out.status, "clean");
  assert.equal(out.captured, false);
  assert.deepEqual(captured, [], "silence is the point — a report every run is noise");
});

test("a run carrying a NEW divergence is DRIFT and writes exactly one record naming it", () => {
  const captured: string[] = [];
  const out = runHostParity({
    pole: "mini",
    runSuite: () => tap([...ALL_MINI, NOVEL]),
    capture: (r) => captured.push(r),
  });
  assert.equal(out.status, "drift");
  assert.equal(captured.length, 1, "one record, not one per divergence");
  assert.match(captured[0] ?? "", /NEW DIVERGENCE on mini/);
  assert.match(captured[0] ?? "", /test\/some-new\.test\.ts::a brand new assertion nobody has declared/);
  assert.doesNotMatch(captured[0] ?? "", /DECLARED BUT PASSING/, "every declared entry was observed, so no stale section");
});

test("an undeclared failure that PASSES when re-run alone is a flake, reported as such and never captured", () => {
  // MEASURED on this checker's own first live run: its single undeclared entry was the W1-T356
  // wiring test, a known whole-suite flake. Without the confirm step the tool's day-one output
  // would have been noise.
  const captured: string[] = [];
  const asked: string[] = [];
  const out = runHostParity({
    pole: "mini",
    runSuite: () => tap([...ALL_MINI, NOVEL]),
    confirm: (candidate) => {
      asked.push(candidate);
      return false; // passed alone
    },
    capture: (r) => captured.push(r),
  });
  assert.deepEqual(asked, [id(NOVEL)], "only the UNDECLARED entry is re-run — declared ones are not re-tested");
  assert.equal(out.status, "clean", "a flake leaves the declared list correct, so it is not drift");
  assert.deepEqual(out.confirmed, []);
  assert.deepEqual(out.unconfirmed, [id(NOVEL)]);
  assert.deepEqual(captured, [], "and nothing is written");
  assert.match(out.report, /NOT REPORTED — failed in the glob run and PASSED when its file was re-run alone/);
});

test("THE OTHER DIRECTION: an undeclared failure that REPRODUCES alone is drift and IS captured", () => {
  // The falsifier for "confirm suppresses everything". If this ever stops reporting, the confirm
  // step has become a mute button on the whole check.
  const captured: string[] = [];
  const out = runHostParity({
    pole: "mini",
    runSuite: () => tap([...ALL_MINI, NOVEL]),
    confirm: () => true,
    capture: (r) => captured.push(r),
  });
  assert.equal(out.status, "drift");
  assert.deepEqual(out.confirmed, [id(NOVEL)]);
  assert.equal(captured.length, 1);
  assert.match(captured[0] ?? "", /REPRODUCED\s+when their file was re-run alone/);
});

test("with NO confirm seam every undeclared entry is still reported — a caller that cannot re-run gets the finding", () => {
  const out = runHostParity({ pole: "mini", runSuite: () => tap([...ALL_MINI, NOVEL]) });
  assert.equal(out.status, "drift");
  assert.deepEqual(out.confirmed, [id(NOVEL)], "silence would be the worse default");
});

test("a custom baseline is honoured, so the check is not welded to this repo's current set", () => {
  const baseline: DeclaredDivergence[] = [{ test: id(NOVEL), pole: "mini", reason: "declared for this fixture only" }];
  const out = runHostParity({ pole: "mini", runSuite: () => tap([NOVEL]), baseline });
  assert.equal(out.status, "clean");
});

test("the report names the counts a reader needs, and never invents one it did not measure", () => {
  const rendered = renderHostParityReport({
    pole: "mini",
    reading: { complete: true, failures: [id(BSD)], tests: 6496 },
    diff: diffHostParity({ observed: [id(BSD)], pole: "mini" }),
    headSha: "11dcbf0",
  });
  assert.match(rendered, /HOST PARITY \(mini\) at 11dcbf0: 6496 tests, 1 failing/);
  assert.match(rendered, /1 declared, 0 undeclared/);
});

// ── PART TWO: SIBLING JOBS ON ONE SHA ─────────────────────────────────────────────────────────
//
// MEASURED ON #1886 (head ad5904c): `coverage-ratchet` failed the W1-T356 wiring test while `ci`
// ran the same glob on the same sha to success. The fixtures below use that same shape — two
// sibling jobs, one sha, one test — because it is the case that motivated this predicate.

const WIRING = id({ file: "test/daemon.test.ts", title: "W1-T356 orphan-sweep wiring test" });

test("a head where one job passed and a sibling failed is reported as a disagreement", () => {
  const disagreements = findSiblingDisagreements([
    { job: "ci", sha: "ad5904c", conclusion: "success" },
    { job: "coverage-ratchet", sha: "ad5904c", conclusion: "failure", failingTest: WIRING },
  ]);
  assert.equal(disagreements.length, 1, "both job names are reported as ONE disagreement, not two");
  assert.deepEqual(disagreements[0]?.passed, ["ci"]);
  assert.deepEqual(disagreements[0]?.failed, ["coverage-ratchet"]);
  assert.deepEqual(disagreements[0]?.failingTests, [WIRING]);
  assert.equal(disagreements[0]?.sha, "ad5904c");
});

test("a head where every job failed yields no disagreement", () => {
  // THE FALSE-POSITIVE CONTAINMENT: a detector that fired on any red would report this sha too.
  // All-red is agreement, not disagreement — and a real, unanimous failure must not be muted here.
  const disagreements = findSiblingDisagreements([
    { job: "ci", sha: "deadbee", conclusion: "failure", failingTest: WIRING },
    { job: "coverage-ratchet", sha: "deadbee", conclusion: "failure", failingTest: WIRING },
  ]);
  assert.deepEqual(disagreements, []);
});

test("a head with a single job cannot disagree with itself", () => {
  const disagreements = findSiblingDisagreements([{ job: "ci", sha: "abc1234", conclusion: "success" }]);
  assert.deepEqual(disagreements, []);
});

test("a job that was skipped or cancelled is neither pole, so it cannot manufacture a disagreement", () => {
  const disagreements = findSiblingDisagreements([
    { job: "ci", sha: "cafebabe", conclusion: "success" },
    { job: "docs-lint", sha: "cafebabe", conclusion: "skipped" },
  ]);
  assert.deepEqual(disagreements, [], "a skipped job never ran the suite, so it has nothing to disagree with");
});

test("a disagreement on one sha does not leak into another sha's siblings", () => {
  const disagreements = findSiblingDisagreements([
    { job: "ci", sha: "sha-one", conclusion: "success" },
    { job: "coverage-ratchet", sha: "sha-one", conclusion: "failure", failingTest: WIRING },
    { job: "ci", sha: "sha-two", conclusion: "success" },
    { job: "coverage-ratchet", sha: "sha-two", conclusion: "success" },
  ]);
  assert.deepEqual(
    disagreements.map((d) => d.sha),
    ["sha-one"],
    "sha-two agreed and must not appear",
  );
});

test("the report names a disagreement and never claims the run was a flake", () => {
  const [disagreement] = findSiblingDisagreements([
    { job: "ci", sha: "ad5904c", conclusion: "success" },
    { job: "coverage-ratchet", sha: "ad5904c", conclusion: "failure", failingTest: WIRING },
  ]);
  assert.ok(disagreement, "the fixture above must produce a disagreement for this to test anything");
  const report = renderSiblingDisagreement(disagreement);
  assert.match(report, /DISAGREEMENT/, "the verdict word must appear");
  assert.match(report, /\bci\b/);
  assert.match(report, /coverage-ratchet/);
  assert.match(report, /ad5904c/);
  assert.match(report, new RegExp(WIRING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(report.toLowerCase(), /flake/, "naming the disagreement must not assert it was noise");
});
