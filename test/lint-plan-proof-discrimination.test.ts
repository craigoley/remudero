import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTask, proofBaseDiscriminationViolations } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

/** A minimal, otherwise-clean Task fixture — every test overrides only what it needs. */
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
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
    ...over,
  };
}

/** Every path this predicate is asked about is reported PRESENT at the base ref. */
const presentAtBase = () => true;
/** ...and here, ABSENT — the forward-referencing shape. */
const absentAtBase = () => false;

test("W1-T2835: a pure-path proof whose file exists at base is reported, naming the executed_stale consequence", () => {
  const v = proofBaseDiscriminationViolations(
    task({ id: "W1-T1", acceptance: [{ claim: "the rung fires", proof: "unit test: test/already-here.test.ts" }] }),
    { pathExistsAtBase: presentAtBase },
  );
  assert.equal(v.length, 1);
  assert.equal(v[0]!.check, "proof-base-discrimination");
  // The message must name the CONSEQUENCE, not merely the file's presence: a reader who sees only
  // "this file exists at base" cannot act on it.
  assert.match(v[0]!.message, /executed_stale/);
  assert.match(v[0]!.message, /keyword floor/);
  assert.match(v[0]!.message, /classifyBaseProofOutcome/);
  assert.match(v[0]!.message, /test\/already-here\.test\.ts/);
});

test("W1-T2835: a forward-referencing proof is NOT reported, so the healthy majority stays silent", () => {
  // THE REAL SHAPE, NOT A SYNTHETIC ONE (this task's falsifier requires it): W1-T2976
  // ("a report with no reader is not a report") was filed at base d7a18a6458b0 declaring
  // `unit test: test/a-report-with-no-reader-is-not-a-report.test.ts`, and that file did NOT exist
  // at that base — its own PR created it. Measured 2026-09-06 across every filed shard at its own
  // filing base: 3582 proofs of this shape against 828 already-present. Firing on these would be a
  // regression, not a fix, however real the true positives are.
  const v = proofBaseDiscriminationViolations(
    task({
      id: "W1-T2976",
      acceptance: [
        {
          claim: "a report with no reader is not a report",
          proof: "unit test: test/a-report-with-no-reader-is-not-a-report.test.ts",
        },
      ],
    }),
    { pathExistsAtBase: absentAtBase },
  );
  assert.deepEqual(v, []);
});

test("W1-T2835: the check is silent with no base predicate, so whole-plan and pre-dispatch never report", () => {
  const t = task({ id: "W1-T3", acceptance: [{ claim: "c", proof: "unit test: test/already-here.test.ts" }] });
  // ABSENT ⇒ SILENT is the contract `blockedDisposition` and `newMonolithIds` already follow: a
  // whole-plan run has no base and must not report the standing population.
  assert.deepEqual(proofBaseDiscriminationViolations(t, {}), []);
  assert.deepEqual(proofBaseDiscriminationViolations(t), []);
  // ...and through the aggregate, the surface an actual pass uses.
  assert.equal(
    lintTask(t, {}).violations.filter((x) => x.check === "proof-base-discrimination").length,
    0,
  );
});

test("W1-T2835: the check warns and never blocks, so a repair naming a red-at-base test is not refused", () => {
  const t = task({ id: "W1-T4", acceptance: [{ claim: "repairs the red test", proof: "unit test: test/red.test.ts" }] });
  const v = proofBaseDiscriminationViolations(t, { pathExistsAtBase: presentAtBase });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.severity, "warn");
  // A WARN never flips `ok`: presence-at-base is a heuristic for passing-at-base, and a task
  // REPAIRING a currently-failing test names an existing file while discriminating perfectly.
  const res = lintTask(t, { pathExistsAtBase: presentAtBase });
  assert.equal(res.violations.some((x) => x.check === "proof-base-discrimination" && x.severity === "warn"), true);
  assert.equal(res.violations.some((x) => x.check === "proof-base-discrimination" && x.severity === "block"), false);
});

test("W1-T2835: the base fact arrives ONLY through the injected predicate, never from disk", () => {
  // This file exists on disk in every checkout that runs this suite, yet a predicate reporting it
  // ABSENT keeps the check silent — so the verdict cannot be coming from the filesystem.
  const onDisk = task({
    id: "W1-T5",
    acceptance: [{ claim: "c", proof: "unit test: test/lint-plan-proof-discrimination.test.ts" }],
  });
  assert.deepEqual(proofBaseDiscriminationViolations(onDisk, { pathExistsAtBase: absentAtBase }), []);
  // ...and the mirror: a path that exists in NO checkout is reported when the predicate says present.
  const notOnDisk = task({
    id: "W1-T6",
    acceptance: [{ claim: "c", proof: "unit test: test/xyzzy-exists-in-no-checkout.test.ts" }],
  });
  assert.equal(proofBaseDiscriminationViolations(notOnDisk, { pathExistsAtBase: presentAtBase }).length, 1);

  const asked: string[] = [];
  proofBaseDiscriminationViolations(onDisk, {
    pathExistsAtBase: (p) => {
      asked.push(p);
      return true;
    },
  });
  assert.deepEqual(asked, ["test/lint-plan-proof-discrimination.test.ts"]);
});

test("W1-T2835: only the pure-path test form is judged — titles and grep proofs stay silent", () => {
  // A name-filtered proof's discrimination turns on whether the TITLE matches at base, and a grep
  // proof's on the PATTERN. A path predicate can answer neither, so both stay silent rather than guess.
  const title = task({ id: "W1-T7", acceptance: [{ claim: "c", proof: "unit test: some bare test title" }] });
  const grep = task({ id: "W1-T8", acceptance: [{ claim: "c", proof: "grep: needle in src/lib/plan.ts" }] });
  const prose = task({ id: "W1-T9", acceptance: [{ claim: "c", proof: "operator eyeballs it" }] });
  for (const t of [title, grep, prose]) {
    assert.deepEqual(proofBaseDiscriminationViolations(t, { pathExistsAtBase: presentAtBase }), []);
  }
});
