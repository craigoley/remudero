// test/a-machine-filed-shard-reads-as-an-operator-ruling.test.ts — W1-T2959.
//
// LAW 5: "RECORDS LAUNDER AUTHORITY UNLESS THE AUTHOR CLASS RIDES THE RECORD — unmarked records
// read as ratified; origin tags carry commission, not intent"
// (docs/research/research-laws-and-gaps-2026-08-05.md, Part 1). Its own prediction names the
// failure this suite exists to prevent: "any new record channel added without a mandatory
// author-class mark will, within weeks, carry a machine conclusion a later reader treats as an
// operator ruling."
//
// THE PROHIBITION IS ON AN UNMARKED RECORD, NOT ON FILING. So the compliant shape already in this
// repo is `rulingVerifyViolation`'s (W1-T326/W1-T353): mark the record, and refuse it at
// `verify: auto` so `isDispatchEligible` PARKS it until a person looks. A marked, parked shard can
// neither present itself as ratified nor dispatch itself.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { machineAuthorVerifyViolation } from "../src/lib/task-linter.js";
import { lintTask } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";
import {
  CI_LEARNING_MINT_CEILING,
  ciLearningCadenceCheck,
  ciLearningCadenceMarkerPath,
  ciLearningShardId,
  mintCiLearningShards,
  recordCiLearningCadenceFire,
} from "../src/lib/measurement-cadence.js";
import type { CiFailureCorpus, CiFailurePair } from "../src/lib/ci-failure-corpus.js";

/** A minimal, otherwise-clean Task fixture — mirrors test/task-linter.test.ts's own helper so a
 *  violation this suite reports is this suite's field and never an unrelated lint. */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test test/foo.test.ts asserts the thing" }],
    ...over,
  };
}

const pair = (over: Partial<CiFailurePair> & { pr: number; gate: string }): CiFailurePair => ({
  redSha: `red${over.pr}`,
  greenSha: `green${over.pr}`,
  repairFiles: ["src/lib/x.ts"],
  state: "repaired",
  ...over,
});

const corpus = (over: Partial<CiFailureCorpus> = {}): CiFailureCorpus => ({
  status: "populated",
  prsScanned: 4,
  unreadableShas: [],
  pairs: [],
  ...over,
});

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-w1t2959-"));
}

// ── (iii) THE AUTHOR-CLASS MARK IS A FIELD AND A LINT ─────────────────────────────────────────

test("W1-T2959 a shard marked machine-authored is REFUSED at verify:auto — it cannot dispatch itself", () => {
  const v = machineAuthorVerifyViolation(task({ id: "W1-T9001", author_class: "machine", verify: "auto" }));
  assert.ok(v, "a marked shard at verify:auto must be refused");
  assert.equal(v.severity, "block");
  assert.equal(v.check, "machine-author-verify");
  assert.match(v.message, /W1-T9001/);
  assert.match(v.message, /verify: human/, "the message must name the remedy, not merely refuse");
});

test("W1-T2959 the same marked shard at verify:human PASSES — the loop may propose, only a person releases", () => {
  assert.equal(
    machineAuthorVerifyViolation(task({ id: "W1-T9001", author_class: "machine", verify: "human" })),
    undefined,
  );
});

test("W1-T2959 an UNMARKED shard at verify:auto still passes — the mark is load-bearing, not a blanket refusal", () => {
  // Without this the arm would refuse every task in the plan and its green would mean nothing.
  assert.equal(machineAuthorVerifyViolation(task({ id: "W1-T9002", verify: "auto" })), undefined);
  assert.equal(
    machineAuthorVerifyViolation(task({ id: "W1-T9003", author_class: "operator", verify: "auto" })),
    undefined,
    "an operator-authored shard is exactly a person's shard and is graded as one",
  );
});

test("W1-T2959 the arm is WIRED into lintTask, not merely exported", () => {
  // W1-T365's shape: a gate proves a UNIT and never a WIRE. This asserts the wire.
  const marked = lintTask(task({ id: "W1-T9004", author_class: "machine", verify: "auto" }));
  assert.ok(
    marked.violations.some((v) => v.check === "machine-author-verify" && v.severity === "block"),
    "lintTask must surface the refusal",
  );
  assert.equal(marked.ok, false, "and a BLOCKING violation must flip ok false");
  const unmarked = lintTask(task({ id: "W1-T9005", verify: "auto" }));
  assert.equal(
    unmarked.violations.filter((v) => v.check === "machine-author-verify").length,
    0,
    "and must not fire on a person's shard",
  );
});

// ── (i) ONE ROW, ONE MARKER, THE SHARED DECISION FUNCTION ────────────────────────────────────

test("W1-T2959 the rung paces on its OWN marker file, distinct from every sibling cadence", () => {
  const root = tmpRoot();
  const mine = ciLearningCadenceMarkerPath(root);
  assert.match(mine, /state[/\\]/, "the marker lives under state/");
  // A short interval on one rung must never drag another — the reason digestCadence states for
  // not folding into measurementCadence.
  assert.notEqual(mine, join(root, "state", "last-measurement-cadence.json"));
  assert.notEqual(mine, join(root, "state", "last-digest-cadence.json"));
});

test("W1-T2959 the rung decides through the SHARED two-bound function: disabled, then interval, then daily cap", () => {
  const root = tmpRoot();
  const ON = { enabled: true, minIntervalMinutes: 60, maxPerDay: 1 };
  const now = new Date("2026-09-06T12:00:00Z");

  assert.equal(ciLearningCadenceCheck({ root, policy: { ...ON, enabled: false }, now }).fire, false);

  // No marker at all: fires.
  assert.equal(ciLearningCadenceCheck({ root, policy: ON, now }).fire, true);

  // After a fire, the interval bound holds it.
  recordCiLearningCadenceFire(root, now);
  const tooSoon = ciLearningCadenceCheck({ root, policy: ON, now: new Date("2026-09-06T12:30:00Z") });
  assert.equal(tooSoon.fire, false);
  assert.ok(tooSoon.reason, "a refusal names its reason");

  // Past the interval but at the daily cap: still refused, and for a DIFFERENT reason.
  const capped = ciLearningCadenceCheck({ root, policy: ON, now: new Date("2026-09-06T18:00:00Z") });
  assert.equal(capped.fire, false);
  assert.notEqual(capped.reason, tooSoon.reason, "the two bounds must be distinguishable");
});

test("W1-T2959 a corrupt marker fails CLOSED rather than firing", () => {
  const root = tmpRoot();
  const p = ciLearningCadenceMarkerPath(root);
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "{ not json");
  const d = ciLearningCadenceCheck({ root, policy: { enabled: true, minIntervalMinutes: 1, maxPerDay: 99 } });
  assert.equal(d.fire, false);
});

// ── (ii) THE MINT CEILING IS A PRIMARY CONTROL ───────────────────────────────────────────────

test("W1-T2959 one firing files AT MOST the ceiling, and NAMES every finding it excluded", () => {
  const pairs = Array.from({ length: CI_LEARNING_MINT_CEILING + 2 }, (_, i) =>
    pair({ pr: 100 + i, gate: `gate-${i}` }),
  );
  const r = mintCiLearningShards(corpus({ pairs }), []);
  assert.equal(r.status, "backlog");
  assert.equal(r.drafts.length, CI_LEARNING_MINT_CEILING, "the ceiling is a PRIMARY control, not a backstop");
  assert.equal(r.excludedFindings.length, 2, "the excess is NAMED, never silently dropped");
  for (const e of r.excludedFindings) assert.match(e, /gate-/, "an excluded finding names itself");
});

test("W1-T2959 a rerun over the same corpus files NOTHING new — idempotent by deterministic id", () => {
  const pairs = [pair({ pr: 100, gate: "coverage-ratchet" }), pair({ pr: 101, gate: "source-size" })];
  const first = mintCiLearningShards(corpus({ pairs }), []);
  assert.equal(first.drafts.length, 2);

  const already = first.drafts.map((d) => d.findingId);
  const second = mintCiLearningShards(corpus({ pairs }), already);
  assert.equal(second.drafts.length, 0, "the second fire over an unchanged corpus files nothing");
  assert.equal(second.status, "clear", "and reports a measured absence rather than a backlog");
});

test("W1-T2959 the dedup id is deterministic and discriminating", () => {
  const a = ciLearningShardId({ pr: 100, gate: "coverage-ratchet" });
  assert.equal(a, ciLearningShardId({ pr: 100, gate: "coverage-ratchet" }), "same finding, same id");
  assert.notEqual(a, ciLearningShardId({ pr: 100, gate: "source-size" }), "a different gate is a different finding");
  assert.notEqual(a, ciLearningShardId({ pr: 101, gate: "coverage-ratchet" }), "a different PR is a different finding");
});

// ── (iv) EVERY DRAFT THE RUNG PRODUCES CARRIES THE MARK AND PARKS ────────────────────────────

test("W1-T2959 every draft the rung produces is MARKED and PARKED, and the linter agrees", () => {
  const r = mintCiLearningShards(corpus({ pairs: [pair({ pr: 100, gate: "coverage-ratchet" })] }), []);
  assert.equal(r.drafts.length, 1);
  const d = r.drafts[0];
  assert.equal(d.author_class, "machine", "Law 5: the author class rides the record");
  assert.equal(d.verify, "human", "isDispatchEligible refuses verify !== auto, so this PARKS");

  // The two halves must agree: a draft flipped to auto is refused by the linter that ships.
  const asFiled = task({ id: "W1-T9100", author_class: d.author_class, verify: d.verify });
  assert.equal(machineAuthorVerifyViolation(asFiled), undefined, "as produced, it lints clean");
  assert.ok(
    machineAuthorVerifyViolation({ ...asFiled, verify: "auto" }),
    "and the instant anything flips it to auto, the linter refuses it",
  );
});

test("W1-T2959 only a repaired pair is mintable — an open failure has no fix to learn from yet", () => {
  const r = mintCiLearningShards(
    corpus({ pairs: [pair({ pr: 100, gate: "still-red", state: "open", greenSha: undefined, repairFiles: undefined })] }),
    [],
  );
  assert.equal(r.drafts.length, 0);
  assert.equal(r.status, "clear");
});

// ── (v) A MEASURED ABSENCE, NEVER A BARE ZERO (P48) ──────────────────────────────────────────

test("W1-T2959 an EMPTY corpus and an UNREADABLE one are different answers", () => {
  const empty = mintCiLearningShards(corpus({ status: "clear", pairs: [] }), []);
  assert.equal(empty.status, "clear");
  assert.equal(empty.drafts.length, 0);
  assert.deepEqual(empty.unreadableShas, []);

  const blind = mintCiLearningShards(
    corpus({ status: "unreadable", pairs: [], unreadableShas: ["deadbeef"] }),
    [],
  );
  assert.equal(blind.status, "unreadable", "a window never seen is NOT a window with nothing in it");
  assert.deepEqual(blind.unreadableShas, ["deadbeef"], "the unreadable shas are NAMED");
  assert.notEqual(blind.status, empty.status, "the two must be distinguishable by a caller");
});

test("W1-T2959 an unreadable corpus that DID yield a repaired pair still names what it could not read", () => {
  // Partial blindness is the dangerous case: something was found, so a caller could read the
  // result as complete. The unreadable shas must survive onto the result either way.
  const r = mintCiLearningShards(
    corpus({ status: "unreadable", pairs: [pair({ pr: 100, gate: "coverage-ratchet" })], unreadableShas: ["cafe"] }),
    [],
  );
  assert.equal(r.drafts.length, 1, "what WAS read is still mined");
  assert.deepEqual(r.unreadableShas, ["cafe"], "and the blindness is still reported");
  assert.equal(r.status, "unreadable", "status reports the weaker claim, never the stronger");
});

// ── (v) THE OUTPUT MUST REACH THE LANE THAT OPENS THE PRs ────────────────────────────────────

test("W1-T2959 a draft names a surface a DISPATCHED WORKER can actually read", () => {
  // MEASURED, not assumed: spawnWorker passes `settingSources: []` (src/lib/worker.ts), the SDK's
  // isolation mode, so a dispatched worker NEVER reads CLAUDE.md. A shard whose remedy were "add a
  // CLAUDE.md bullet" would improve interactive sessions and change nothing about the fleet's own
  // pull requests — the exact failure this criterion exists to prevent.
  const workerSrc = readFileSync("src/lib/worker.ts", "utf8");
  assert.match(workerSrc, /settingSources:\s*\[\]/, "the isolation this criterion depends on still ships");

  const r = mintCiLearningShards(corpus({ pairs: [pair({ pr: 100, gate: "coverage-ratchet" })] }), []);
  const d = r.drafts[0];
  assert.match(d.remedySurface, /learnings\//, "the remedy must name the surface that reaches the fleet");
  assert.doesNotMatch(d.remedySurface, /CLAUDE\.md/, "and never CLAUDE.md, which no dispatched worker reads");
});
