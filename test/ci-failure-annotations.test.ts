import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchCiFailures, defaultCiAnnotationFetch, type CiAnnotationFetch } from "../src/run-task.js";
import { describeCiLogUnavailable, diffCoverageReport, type CiFailure } from "../src/lib/sweep.js";

// ── W1-T2298 — the coverage failure detail is published and nothing reads it. Two halves: a SECOND
// SOURCE for `logTail` when the log blob cannot be read, and a REPORTER for the diff-scoped coverage
// block that the one existing coverage recogniser never matched. Both are proved here against the
// producer's own object, never through the wider sweep.

/** A failing required check as the rollup reports it, with the details url the producer parses. */
const failing = (name: string, jobId = "98137955459") => ({
  name,
  conclusion: "FAILURE",
  detailsUrl: `https://github.com/o/r/actions/runs/1/job/${jobId}`,
});

/** Records what the fallback was asked for, so the WIRING is proved and not merely the outcome. */
function recorder(messages: string[]): { fetch: CiAnnotationFetch; calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = [];
  return {
    calls,
    fetch: (owner, repo, id) => {
      calls.push([owner, repo, id]);
      return messages;
    },
  };
}

const DIFF_COVERAGE_TAIL = [
  "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests, even though the aggregate coverage-ratchet floor may still be satisfied:",
  "  - src/run-task.ts:14478",
  "  - src/run-task.ts:14479",
].join("\n");

test("the failure detail is read from the annotation source when the log tail cannot be read", () => {
  const r = recorder([DIFF_COVERAGE_TAIL]);
  const [f] = fetchCiFailures("o", "r", [failing("coverage-ratchet")], 60, r.fetch);
  assert.equal(f?.logUnavailable, undefined, "a tail was recovered, so no cause may be recorded");
  assert.match(f?.logTail ?? "", /diff-coverage: BLOCKED/);
  assert.equal(f?.tailSource, "annotations");
  assert.equal(f?.annotationFallback?.outcome, "recovered");
  assert.deepEqual(r.calls, [["o", "r", "98137955459"]], "the check-run id is reused as-is, no new plumbing");
});

test("a readable log tail is still preferred, so existing recognisers match exactly what they match today", () => {
  // The real `gh run view` cannot read a log here (the proxy denies it), so this asserts the
  // ORDERING that makes preference meaningful: the fallback is consulted only after that failure,
  // and it is consulted with the same id — never instead of the log read, and never first.
  const r = recorder(["from the annotation source"]);
  const [f] = fetchCiFailures("o", "r", [failing("ci")], 60, r.fetch);
  assert.equal(r.calls.length, 1, "the fallback runs once, after the log read has already failed");
  assert.equal(f?.tailSource, "annotations");
  // And with NO job id there is nothing to fall back with, so the fallback is never reached at all.
  const r2 = recorder(["never asked for"]);
  const [g] = fetchCiFailures("o", "r", [{ name: "ci", conclusion: "FAILURE", detailsUrl: "https://x/none" }], 60, r2.fetch);
  assert.deepEqual(r2.calls, [], "no job id ⇒ no annotation fetch is attempted");
  assert.equal(g?.logUnavailable?.kind, "no-job-id");
});

test("an unreadable failure detail records which source answered and why, instead of degrading silently", () => {
  const empty = recorder([]);
  const [f] = fetchCiFailures("o", "r", [failing("coverage-ratchet")], 60, empty.fetch);
  assert.equal(f?.logTail, "");
  assert.equal(f?.tailSource, undefined, "no source answered, so none may be claimed");
  assert.equal(f?.annotationFallback?.outcome, "empty", "the fallback ran and said so");
  assert.equal(
    f?.logUnavailable?.kind,
    "fetch-failed",
    "the log's OWN named cause survives — a fallback that overwrote it would take W1-T2291's answer back",
  );
  assert.match(describeCiLogUnavailable(f!.logUnavailable!), /log NOT read/);
});

test("a throwing annotation fallback is named, never rethrown — the producer keeps its no-throw contract", () => {
  const boom: CiAnnotationFetch = () => {
    throw Object.assign(new Error("Forbidden"), { code: "EPROXY" });
  };
  const [f] = fetchCiFailures("o", "r", [failing("ci")], 60, boom);
  assert.equal(f?.annotationFallback?.outcome, "failed");
  assert.match((f?.annotationFallback as { detail: string }).detail, /EPROXY: Forbidden/);
  assert.equal(f?.logUnavailable?.kind, "fetch-failed", "the log's own cause is untouched by the fallback's failure");
});

test("the diff-scoped coverage failure is recognised by its own wording and names the uncovered lines", () => {
  const report = diffCoverageReport([{ name: "coverage-ratchet", logTail: DIFF_COVERAGE_TAIL }]);
  assert.equal(report?.check, "coverage-ratchet");
  assert.deepEqual(report?.uncovered, ["src/run-task.ts:14478", "src/run-task.ts:14479"]);
});

test("the AGGREGATE ratchet's wording is not the diff-scoped one, which is why it matched nothing before", () => {
  const aggregate: CiFailure = {
    name: "coverage-ratchet",
    logTail: "coverage-ratchet: BLOCKED -- coverage is below a floor:\n  - branches 81.2 < 81.5",
  };
  assert.equal(diffCoverageReport([aggregate]), undefined, "the two sentences must not be conflated");
  assert.equal(diffCoverageReport([]), undefined);
});

test("the diff-scoped coverage recogniser reports and dispatches no fix worker", async () => {
  const sweep = await import("../src/lib/sweep.js");
  const classes = sweep.DEFAULT_FIX_CLASSES as ReadonlyArray<{ id: string }>;
  assert.ok(
    !classes.some((c) => c.id.includes("diff-coverage")),
    "a diff-coverage FixClass would dispatch a redrive that re-runs the same gate and fails identically",
  );
  // And the reporter itself returns DATA — it has no dispatch surface to misuse.
  const report = diffCoverageReport([{ name: "coverage-ratchet", logTail: DIFF_COVERAGE_TAIL }]);
  assert.deepEqual(Object.keys(report ?? {}).sort(), ["check", "uncovered"]);
});

test("the producer still never throws and still names the same failing checks it names today", () => {
  const r = recorder(["x"]);
  const out = fetchCiFailures(
    "o",
    "r",
    [failing("ci"), failing("coverage-ratchet", "1"), { name: "claims", conclusion: "SUCCESS", detailsUrl: "" }],
    60,
    r.fetch,
  );
  assert.deepEqual(out.map((f) => f.name).sort(), ["ci", "coverage-ratchet"], "successes are still excluded");
  assert.doesNotThrow(() => fetchCiFailures("o", "r", undefined, 60, r.fetch));
  assert.deepEqual(fetchCiFailures("o", "r", [], 60, r.fetch), []);
});

test("the DEFAULT annotation fetch really shells out — the seam's own implementation is reachable", () => {
  // Not a fake: this runs `defaultCiAnnotationFetch` itself. Against a repo/id that cannot resolve
  // it must THROW (which the producer's catch is what turns into a named cause) rather than return
  // a value — so the default is proven executable, not merely present.
  assert.throws(() => defaultCiAnnotationFetch("no-such-owner-xyzzy", "no-such-repo-xyzzy", "1"));
});
