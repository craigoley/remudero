import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  CHANGED_FILES_HEADING,
  buildPlanPrBody,
  changedFilesBlockDrift,
  filingAcceptanceCriteria,
  hasChangedFilesBlock,
  renderChangedFilesBlock,
} from "../src/lib/plan-pr-emitter.js";

/**
 * W1-T2550 — `renderChangedFilesBlock` (W1-T2535) had NO production caller at all:
 * `buildPlanPrBody`'s only in-module consumer guards on `changedFiles !== undefined`, and both
 * `rmd approve` call sites in `src/run-task.ts` — the single-proposal and batch `openPlanPr`
 * closures — built their bodies without ever passing that field. The emitter was reached only by
 * its own test suite (test/a-changed-files-block-cannot-contradict-its-own-diff.test.ts).
 *
 * This wires the ONLY two `buildPlanPrBody` call sites that exist today (both plan-ratification
 * lanes; the build lane does not author its body through this module at all — out of scope, see
 * the task's own rationale) to pass the SAME path list they already compute for
 * `filingAcceptanceCriteria`'s filing evidence. Nothing is invented: the list handed to
 * `changedFiles` is the identical `filedPaths`/`filedTaskIds` local each closure already builds
 * from what it just wrote to disk (`shardRelPaths`/`allShardRelPaths` + `"MASTER-PLAN.md"`).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const RUN_TASK_SRC = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");

/** Slices out an `openPlanPr(branch, ...) {` closure body, up to its own closing `    },` at the
 *  SAME 4-space method indentation — never a bare `\n}` (this closure nests many of its own). */
function openPlanPrRegion(signature: string): string {
  const from = RUN_TASK_SRC.indexOf(signature);
  assert.ok(from >= 0, `${signature} must still exist in src/run-task.ts under that exact signature`);
  const to = RUN_TASK_SRC.indexOf("\n    },\n", from);
  assert.ok(to > from, `could not locate the closing brace for ${signature}`);
  return RUN_TASK_SRC.slice(from, to);
}

// ══ criterion 1/2 — PRODUCTION WIRING: both plan-ratification openPlanPr closures pass the file
// list they already hold, so the block is actually emitted, not only defined ═══════════════════

test("W1-T2550: rmd approve's single-proposal openPlanPr passes changedFiles — the SAME list filingAcceptanceCriteria gets", () => {
  const region = openPlanPrRegion("openPlanPr(branch, id) {");
  assert.match(region, /const filedPaths = \[\.\.\.shardRelPaths, "MASTER-PLAN\.md"\];/, "built from what this ratification actually wrote — not re-derived, not hand-listed");
  assert.match(region, /buildPlanPrBody\(\{/, "still assembled via the shared gate-contract module, never a hand-rolled body");
  assert.match(region, /criteria:\s*filingAcceptanceCriteria\(ids,\s*filedPaths\)/, "filing evidence and changed-files now read the SAME local");
  assert.match(region, /changedFiles:\s*filedPaths/, "the field buildPlanPrBody's own doc says every existing caller omits — no longer true here");
});

test("W1-T2550: rmd approve's BATCH openPlanPr passes changedFiles too — the second (and last) buildPlanPrBody call site", () => {
  const region = openPlanPrRegion("openPlanPr(branch, ids) {");
  assert.match(region, /const filedPaths = \[\.\.\.allShardRelPaths, "MASTER-PLAN\.md"\];/);
  assert.match(region, /criteria:\s*filingAcceptanceCriteria\(filedIds,\s*filedPaths\)/);
  assert.match(region, /changedFiles:\s*filedPaths/);
});

test("W1-T2550: git grep confirms exactly two buildPlanPrBody call sites in src/, and both now pass changedFiles", () => {
  // Guards the premise itself: if a THIRD call site is ever added, this must be re-examined
  // rather than silently leaving it unwired the way this task's own rationale measured.
  const callSites = [...RUN_TASK_SRC.matchAll(/buildPlanPrBody\(\{/g)];
  assert.equal(callSites.length, 2, "src/run-task.ts must have exactly the two `rmd approve` call sites this task wires");
  for (const m of callSites) {
    const from = m.index!;
    const to = RUN_TASK_SRC.indexOf("});", from);
    const call = RUN_TASK_SRC.slice(from, to);
    assert.match(call, /changedFiles:\s*filedPaths/, "every buildPlanPrBody call site in run-task.ts must pass changedFiles");
  }
});

// ══ criterion 1 (functional) — exercising the SAME composition the wired call sites use actually
// emits the rendered block, not merely accepts the option ═══════════════════════════════════════

test("W1-T2550: the exact composition the wired call site uses (filedPaths fed to both criteria and changedFiles) renders the block", () => {
  const shardRelPaths = ["plan/tasks.d/W1-T9001-example.yaml"];
  const filedPaths = [...shardRelPaths, "MASTER-PLAN.md"];
  const body = buildPlanPrBody({
    intro: "Filing W1-T9001.",
    criteria: filingAcceptanceCriteria(["W1-T9001"], filedPaths),
    changedFiles: filedPaths,
  });
  assert.equal(hasChangedFilesBlock(body), true, "the lane that authors this body now actually emits the block");
  assert.match(body, new RegExp(CHANGED_FILES_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(body, /- `MASTER-PLAN\.md`/);
  assert.match(body, /- `plan\/tasks\.d\/W1-T9001-example\.yaml`/);
  // and it round-trips: what was rendered agrees with what was fed in — nothing invented.
  assert.deepEqual(changedFilesBlockDrift(body, filedPaths), { missing: [], extra: [] });
});

// ══ criterion 3 — DERIVED, NEVER AUTHORED: the emitted list restates filedPaths, and carries no
// separate count claim for Rule 15's criterionFieldTampered territory to ever have to police ════

test("W1-T2550: the rendered block is a restatement of filedPaths, never a second (assertable) count", () => {
  const filedPaths = ["plan/tasks.d/W1-T1-a.yaml", "plan/tasks.d/W1-T1-b.yaml", "MASTER-PLAN.md"];
  const block = renderChangedFilesBlock(filedPaths);
  // every path named, and ONLY those paths — nothing added, nothing summarized into a number.
  assert.deepEqual(
    block.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.replace(/^- `|`$/g, "")),
    [...filedPaths].sort(),
  );
  assert.doesNotMatch(block, /\bexactly\b|\b3\b|three/i, "no count is authored alongside the list — the paths ARE the claim");
});

// ══ criterion 4 — a body whose block disagrees with the diff is DETECTED, not silently shipped ═
// (the #3419-class failure: a later gate, e.g. source-size-ratchet, adds a path AFTER the body
// was written — exactly what this wiring's own local `filedPaths` is captured before) ═══════════

test("W1-T2550: a block left behind by a later-added file (the source-size-ratchet shape) is caught by changedFilesBlockDrift", () => {
  const filedPathsAtWriteTime = ["plan/tasks.d/W1-T1-a.yaml", "MASTER-PLAN.md"];
  const body = buildPlanPrBody({
    intro: "Filing W1-T1.",
    criteria: filingAcceptanceCriteria(["W1-T1"], filedPathsAtWriteTime),
    changedFiles: filedPathsAtWriteTime,
  });
  // a later gate widens the REAL diff (e.g. recording a size ceiling) without the body changing
  const realDiffAfterLaterCommit = [...filedPathsAtWriteTime, "scripts/source-size-baseline.json"];
  const drift = changedFilesBlockDrift(body, realDiffAfterLaterCommit);
  assert.deepEqual(drift.missing, ["scripts/source-size-baseline.json"], "names exactly what the body no longer accounts for");
  assert.deepEqual(drift.extra, []);
});

// ══ criterion 5 — a caller that passes NO file list still produces a byte-identical body ═══════

test("W1-T2550: buildPlanPrBody with changedFiles omitted is byte-identical to its pre-wiring shape — nothing existing changes", () => {
  const criteria = [{ claim: "W1-T9999 filed as a well-formed plan task shard", proof: "unit test: test/fixture.test.ts" }];
  assert.equal(
    buildPlanPrBody({ intro: "Filing W1-T9999.", criteria }),
    "Filing W1-T9999.\n\nAcceptance:\n- W1-T9999 filed as a well-formed plan task shard | unit test: test/fixture.test.ts\n",
  );
});
