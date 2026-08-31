import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  COMPANION_PATH_CLASSES,
  isCompanionPath,
  sizingViolation,
  subsystemsOf,
} from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";
/**
 * W1-T2543 — `moduleIdFromPath` derives a concern id from a BASENAME, and naming a suite after the
 * claim it proves rather than the module it covers IS the house convention here. So a change to
 * `src/lib/X.ts` plus the suite written to test it scored TWO concerns, and Rule 19 refused it at
 * risk:medium.
 *
 * THE MEASUREMENT THIS FILE EXISTS TO PIN is asserted directly below against the real tree, so the
 * rate cannot silently drift out from under the justification.
 */
function task(over: Partial<Task> = {}): Task {
  return { id: "W1-TX", repo: "remudero", type: "implement", risk: "medium", files: [], ...over } as Task;
}
test("W1-T2543 THE MEASUREMENT: most suites here are named after their claim, not their module", () => {
  // The whole justification. `git ls-files` (never a bare glob — an untracked or NUL-bearing file
  // reads as absent to this harness's grep, per the repo's own investigation rules).
  const root = new URL("..", import.meta.url).pathname;
  const list = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const srcStems = new Set(list(["ls-files", "src/*.ts", "src/lib/*.ts"]).map((p) => p.replace(/^.*\//, "").replace(/\.ts$/, "")));
  const suites = list(["ls-files", "test/*.test.ts"]);
  assert.ok(suites.length > 100, `sanity: expected a large suite population, got ${suites.length}`);
  assert.ok(srcStems.size > 50, `sanity: expected a large module population, got ${srcStems.size}`);
  const unmatched = suites.filter((p) => !srcStems.has(p.replace(/^test\//, "").replace(/\.test\.ts$/, "")));
  const pct = (unmatched.length / suites.length) * 100;
  assert.ok(
    pct > 60,
    `the discount is justified by most suites being claim-named; measured ${unmatched.length}/${suites.length} (${pct.toFixed(1)}%)`,
  );
});
test("W1-T2543 criterion 1: a source file plus a test file in the same task scores ONE concern, not two", () => {
  const t = task({ files: ["src/lib/sweep.ts", "test/sweep-conflicted-disposition.test.ts"] });
  assert.deepEqual([...subsystemsOf(t)], ["sweep"], "the suite is a companion, not a second concern");
  assert.equal(subsystemsOf(t).size, 1);
  // ...and that is what stops Rule 19 refusing an ordinary well-formed task at risk:medium.
  assert.equal(sizingViolation(t), undefined, "one concern must not trip the sizing rule");
});
test("W1-T2543 criterion 1 (the real refusals): the two PRs that fired this rubric within one hour", () => {
  // #3400 and #3403's actual declared file lists, verbatim.
  const t3400 = task({ files: ["src/lib/sweep.ts", "test/sweep-conflicted-disposition.test.ts", "scripts/source-size-baseline.json"] });
  const t3403 = task({ files: ["src/lib/daemon.ts", "deploy/entrypoint.sh", "test/daemon.test.ts", "test/entrypoint-boot.test.ts"] });
  assert.deepEqual([...subsystemsOf(t3400)].sort(), ["source-size-baseline", "sweep"], "the suite no longer counts; the baseline still does");
  assert.deepEqual([...subsystemsOf(t3403)].sort(), ["daemon", "entrypoint"], "two REAL concerns survive — the two suites do not");
});
test("W1-T2543 criterion 2: a task genuinely spanning two source subsystems STILL scores two", () => {
  // The load-bearing half. If this ever returns 1, the discount has eaten Rule 19's span measure.
  const t = task({ files: ["src/lib/sweep.ts", "src/lib/daemon.ts", "test/whatever-it-proves.test.ts"] });
  assert.deepEqual([...subsystemsOf(t)].sort(), ["daemon", "sweep"], "both source stems survive the discount");
  const v = sizingViolation(t);
  assert.ok(v, "two real concerns at risk:medium must still be refused");
  assert.match(v!.message, /spans 2 distinct subsystems/);
});
test("W1-T2543 criterion 3: a test path the task does NOT declare is not discounted, because it is not there to discount", () => {
  // The discount reads `task.files` only. A suite absent from the declaration cannot be counted OR
  // discounted — this pins that the change did not start inferring files from anywhere else.
  const t = task({ files: ["src/lib/sweep.ts"] });
  assert.deepEqual([...subsystemsOf(t)], ["sweep"]);
});
test("W1-T2543: a task declaring ONLY suites still counts them — the discount can never empty the tally", () => {
  // THE VACUITY GUARD. Discounting unconditionally would score a test-only task at ZERO concerns,
  // which passes sizing for the wrong reason and is a worse answer than the one being fixed.
  const t = task({ files: ["test/one-thing.test.ts", "test/another-thing.test.ts"] });
  assert.equal(subsystemsOf(t).size, 2, "with no source to accompany, companions count as themselves");
  const v = sizingViolation(t);
  assert.ok(v, "and a genuinely two-concern test-only task is still refused");
});
test("W1-T2543 criterion 4: the discount is a TABLE, so a later path class needs no change to the counting function", () => {
  assert.ok(COMPANION_PATH_CLASSES.some((c) => c.tag === "test-suite"), "the shipped row");
  assert.equal(isCompanionPath("test/x.test.ts"), true);
  assert.equal(isCompanionPath("src/lib/x.ts"), false);
  // Injected table: a caller-supplied class is honoured with ZERO changes to subsystemsOf, which is
  // the same contract DATA_ARTIFACT_CLASSES already carries.
  const t = task({ files: ["src/lib/sweep.ts", "bench/sweep-throughput.ts"] });
  assert.equal(subsystemsOf(t).size, 2, "unknown class counts by default");
  assert.equal(
    subsystemsOf(t, undefined, [{ tag: "bench", pathPattern: /^bench\// }]).size,
    1,
    "and is discounted purely by adding a row",
  );
});
