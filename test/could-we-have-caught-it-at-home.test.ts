import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRefusalLocality, refusalLocalityReport, stripMatrixSuffix, type ParityRow } from "../src/lib/ci-failure-corpus.js";

// ── W1-T3740 — THE SCOREBOARD THE LOOP NEVER HAD ─────────────────────────────────────────────
//
// The ci-learning rung mints findings into `learnings/*.yaml`, and its own description records why
// a remedy may not name CLAUDE.md: "spawnWorker passes settingSources: [] and no dispatched worker
// reads it." The loop produces KNOWLEDGE, which is the one output that cannot reach the builder.
//
// Nothing measured the gap it exists to close. MEASURED over one session: of roughly thirty CI
// refusals, about TWENTY were answerable by a local command in seconds. Both halves of the join
// already existed — the failure corpus and the parity registry — so the question is mechanical.
//
// Run against the REAL registry and that session's jobs, this reports:
//
//   refusal-locality: 7 of 14 refusal(s) were already catchable at home
//     in-default-tier: 5 — comment-load-ratchet, lint-plan
//     mirrored-not-default: 2 — task-id-existence, coverage-ratchet
//     excluded-with-reason: 5 — proof-discrimination, acceptance-author-gate, squash-trailer-gate
//     unknown-job: 2 — ci-shard, …
//
// and W1-T3738 has since moved `proof-discrimination` OUT of the excluded bucket, which is what
// the number is for: it falls when the mirror grows, and by no other means.

const REGISTRY: ParityRow[] = [
  { job: "comment-load-ratchet", mirrored: true },
  { job: "coverage-ratchet", mirrored: true },
  { job: "ci-shard", mirrored: false, reason: "matrix job; local mirroring is a wall-clock decision on W1-T3737's measurements" },
  { job: "squash-trailer-gate", mirrored: false, reason: "reads the pull_request event payload; a local checkout cannot supply it honestly" },
  { job: "a-drifted-exclusion", mirrored: false },
];
const DEFAULT_TIER = new Set(["comment-load-ratchet", "lint-plan"]);

test("a default-tier job counts as locally catchable", () => {
  // The most uncomfortable class, and the point of naming it: preflight ALREADY runs this. Four of
  // this session's refusals were comment-load, which the 29-second default tier catches.
  assert.equal(classifyRefusalLocality("comment-load-ratchet", REGISTRY, DEFAULT_TIER), "in-default-tier");
  // The default tier wins even over a registry row, because running it is what matters, not how it
  // is catalogued.
  assert.equal(classifyRefusalLocality("lint-plan", REGISTRY, DEFAULT_TIER), "in-default-tier");

  const r = refusalLocalityReport(["comment-load-ratchet", "lint-plan"], REGISTRY, DEFAULT_TIER);
  assert.equal(r.alreadyCatchable, 2);
});

test("a mirrored job outside the default is counted apart", () => {
  // A DIFFERENT REMEDY: this one is a tier promotion, not a new check. Collapsing it into
  // "catchable" would hide which lever to pull, and into "not catchable" would understate the gap.
  assert.equal(classifyRefusalLocality("coverage-ratchet", REGISTRY, DEFAULT_TIER), "mirrored-not-default");

  const r = refusalLocalityReport(["coverage-ratchet", "comment-load-ratchet"], REGISTRY, DEFAULT_TIER);
  assert.equal(r.counts["mirrored-not-default"], 1);
  assert.equal(r.counts["in-default-tier"], 1);
  assert.equal(r.alreadyCatchable, 2, "both are refusals the fleet could already have caught");
});

test("an unregistered job reports unknown, never unmirrored", () => {
  // THE SIMPLIFICATION THAT MUST NOT HAPPEN. A job the registry does not name is DRIFT —
  // ci-parity:drift exists to refuse exactly that — and reporting it as "not mirrored" turns a
  // signal into a backlog entry nobody re-reads.
  assert.equal(classifyRefusalLocality("never-heard-of-it", REGISTRY, DEFAULT_TIER), "unknown-job");

  // THE LOOKUP IS EXACT, AND THIS IS WHY. `coverage-shard` and `coverage-ratchet` are DIFFERENT
  // CI jobs — both appeared, separately, among this session's refusals. Any name-prefix heuristic
  // reports the unregistered one as mirrored, which is a false green on the only number this
  // report exists to produce.
  assert.equal(
    classifyRefusalLocality("coverage-shard", REGISTRY, DEFAULT_TIER),
    "unknown-job",
    "a job sharing a prefix with a registered one is NOT that job",
  );

  // And `mirrored: false` with NO reason is its own thing: an exclusion nobody recorded. It is not
  // a considered exclusion and must not read as one.
  assert.equal(classifyRefusalLocality("a-drifted-exclusion", REGISTRY, DEFAULT_TIER), "unmirrored");
  assert.equal(classifyRefusalLocality("squash-trailer-gate", REGISTRY, DEFAULT_TIER), "excluded-with-reason");

  const r = refusalLocalityReport(["never-heard-of-it"], REGISTRY, DEFAULT_TIER);
  assert.equal(r.counts["unknown-job"], 1);
  assert.equal(r.counts.unmirrored, 0, "drift is never absorbed into the backlog");
  assert.ok(r.lines.some((l) => /registry DRIFT/.test(l)), "and the report says so");
});

test("the report names the already-catchable count", () => {
  // A TOTAL falls whenever CI gets quieter for any reason. This number falls only when the mirror
  // grows or a class stops happening — it cannot be lowered by writing a better comment, which is
  // precisely the move that has not worked.
  const jobs = ["comment-load-ratchet", "coverage-ratchet", "squash-trailer-gate", "never-heard-of-it"];
  const r = refusalLocalityReport(jobs, REGISTRY, DEFAULT_TIER);
  assert.equal(r.total, 4);
  assert.equal(r.alreadyCatchable, 2);
  assert.match(r.lines[0], /^refusal-locality: 2 of 4 refusal\(s\) were already catchable at home$/);

  // The headline is the catchable count, NOT the total — a report leading with 4 would read as
  // improvement the moment CI ran fewer jobs.
  assert.doesNotMatch(r.lines[0], /^refusal-locality: 4 /);

  // Nothing refused ⇒ zero, reported, rather than an empty report that looks like no data.
  const none = refusalLocalityReport([], REGISTRY, DEFAULT_TIER);
  assert.equal(none.alreadyCatchable, 0);
  assert.match(none.lines[0], /0 of 0/);
});

// ── W1-T3743 — THE MATRIX SUFFIX IS A SPELLING, NOT A DIFFERENT JOB ──────────────────────────
//
// GitHub reports `ci-shard` as `ci-shard (1/4)`; the registry names it `ci-shard`. Before this,
// the join never stripped the suffix, so a live, registered, required job read as `unknown-job`
// on its very first use — the drift signal the classification exists to raise, firing on itself.

test("a matrix-suffixed job resolves to its registry entry", () => {
  assert.equal(
    classifyRefusalLocality("ci-shard (1/4)", REGISTRY, DEFAULT_TIER),
    "excluded-with-reason",
    "the join strips the shard suffix and finds ci-shard's own registry row, not unknown-job",
  );
  assert.equal(stripMatrixSuffix("ci-shard (1/4)"), "ci-shard");
  assert.equal(stripMatrixSuffix("coverage-shard (3/4)"), "coverage-shard");

  const r = refusalLocalityReport(["ci-shard (1/4)"], REGISTRY, DEFAULT_TIER);
  assert.equal(r.counts["unknown-job"], 0);
  assert.equal(r.counts["excluded-with-reason"], 1);
});

test("a shared prefix is not a match after normalising", () => {
  // THE STRIP MUST NOT BECOME A FUZZY MATCH. `coverage-shard` shares a prefix with the registered
  // `coverage-ratchet`, and normalising its matrix suffix away must not make the two collide.
  assert.equal(
    classifyRefusalLocality("coverage-shard (3/4)", REGISTRY, DEFAULT_TIER),
    "unknown-job",
    "coverage-shard and coverage-ratchet are different jobs even once the suffix is stripped",
  );
});

test("an unregistered job survives normalisation as unknown", () => {
  // A name that normalises to nothing registered is still drift — normalising narrows what counts
  // as drift, it must not abolish the signal entirely.
  assert.equal(classifyRefusalLocality("never-heard-of-it (2/4)", REGISTRY, DEFAULT_TIER), "unknown-job");
  assert.equal(stripMatrixSuffix("never-heard-of-it (2/4)"), "never-heard-of-it");

  // And a name with no matrix suffix at all passes through untouched.
  assert.equal(stripMatrixSuffix("lint-plan"), "lint-plan");
});
