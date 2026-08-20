import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MAX_ALLOCATABLE_TASK_ID,
  isAllocatableTaskId,
  mintNextTaskId,
} from "../src/lib/task-id.js";
import { loadPlan } from "../src/lib/plan.js";
import { lintPlan } from "../src/lib/task-linter.js";

// W1-T1039: THE ALLOCATOR HAD NO UPPER SANITY BOUND, SO ONE BURNED ID BECAME THE PERMANENT CEILING.
// `maxSeen` is a `Math.max` across four surfaces, and the module's own invariant is one-directional
// by design — a mint may skip a number but must never reuse one — so a single absurdly high id
// anywhere raises the ceiling for every later mint. An id was burned by being written as a NEGATIVE
// CONTROL in prose the open-PR scan reads; the mint returned it; shards were filed AT it; and the
// verb began answering far above the plan's own range with every surface reading cleanly and no
// error anywhere, because the arithmetic was right and only the answer was unusable.
//
// NO OUT-OF-RANGE ID IS WRITTEN AS A LITERAL IN THIS FILE, DELIBERATELY. Every fixture derives its
// value from `MAX_ALLOCATABLE_TASK_ID` instead. Writing the literal is the exact mechanism under
// repair: `TASK_ID_MENTION_RE` matches `W1-T<n>` ANYWHERE, and the history scan's own
// `ADDED_TASK_ID_RE` matches an `id:` line a patch ADDS — so a literal in this file could be
// harvested from this very PR and burn the next id. Deriving costs nothing and cannot.

/** One id comfortably above the bound, and its immediate successor. CONSECUTIVE ON PURPOSE — that
 *  is the shape the live data actually has, and it is what refutes the population-derived rule. */
const FAR_ABOVE = MAX_ALLOCATABLE_TASK_ID * 10;
const FAR_ABOVE_NEXT = FAR_ABOVE + 1;
/** A perfectly ordinary id, well inside the plan's real range. */
const SANE = 1044;

function planRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-alloc-bound-"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  return root;
}

/** A minimal, loadPlan-valid task block for one id. Built by interpolation so no `id:` line
 *  carrying an out-of-range literal exists anywhere in this file's own source. */
function taskBlock(n: number): string {
  return [
    `- id: W1-T${n}`,
    `  title: "fixture task ${n}"`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  status: queued",
    "",
  ].join("\n");
}

function writePlan(root: string, monolith: number[], shards: number[][] = []): string {
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, monolith.map(taskBlock).join(""), "utf8");
  shards.forEach((ids, i) => {
    writeFileSync(join(root, "plan", "tasks.d", `shard-${i}.yaml`), ids.map(taskBlock).join(""), "utf8");
  });
  return planPath;
}

// ── acceptance 1: the bound rejects the out-of-range id and admits the sane one, in ONE run ──

test("W1-T1039: an id far above the sane population is ignored when computing the max", () => {
  // BOTH DIRECTIONS IN A SINGLE MINT, which is the whole falsifier: a bound that rejected
  // everything would also "pass" a test that only checked the rejection, and a bound that rejected
  // nothing would pass one that only checked the admission. The same fixture carries one of each.
  const root = planRoot();
  const planPath = writePlan(root, [SANE], [[FAR_ABOVE]]);

  const mint = mintNextTaskId({ planPath });

  assert.equal(mint.maxSeen, SANE, "the max must come from the sane id, never the one above the bound");
  assert.equal(mint.n, SANE + 1, "the minted number is one past the sane max");
  assert.equal(mint.id, `W1-T${SANE + 1}`);
  assert.ok(mint.n <= MAX_ALLOCATABLE_TASK_ID, "a mint may never exceed the bound");
  assert.equal(mint.sources.shards, null, "the shard offered only an out-of-range id, so it contributed nothing");
  assert.equal(mint.sources.monolith, SANE, "the monolith's sane id did contribute");
  assert.equal(mint.ignoredAboveBound, 1, "the ignored id is COUNTED, never echoed");
  assert.deepEqual(mint.degraded, [], "an ignored id is not a read failure — nothing is degraded");
});

test("W1-T1039: the predicate admits the top of the range and refuses one past it", () => {
  // The boundary itself, so `<=` can never silently become `<`.
  assert.equal(isAllocatableTaskId(MAX_ALLOCATABLE_TASK_ID), true);
  assert.equal(isAllocatableTaskId(MAX_ALLOCATABLE_TASK_ID + 1), false);
  assert.equal(isAllocatableTaskId(SANE), true);
  assert.equal(isAllocatableTaskId(0), false, "an id is one-based — zero is not allocatable");
  assert.equal(isAllocatableTaskId(-1), false);
  assert.equal(isAllocatableTaskId(1.5), false, "a non-integer parse is not an id this may hand out");
});

// ── acceptance 4: the second-highest is itself an outlier, so it cannot be trusted ──

test("W1-T1039: the second highest is not trusted when it is itself an outlier", () => {
  // WHY THE POPULATION-DERIVED RULE IS REFUSED. The obvious self-maintaining form — ignore anything
  // more than N above the SECOND-highest — inspects exactly the position that has been poisoned
  // once the outliers are CONSECUTIVE, which is the shape the real corpus has: the gap from highest
  // to second-highest is 1, and the gap from second-highest to third is six figures. A rule needing
  // the outliers to be solitary cannot clean up after the case that produced two of them.
  const root = planRoot();
  const planPath = writePlan(root, [SANE], [[FAR_ABOVE, FAR_ABOVE_NEXT]]);

  const mint = mintNextTaskId({ planPath });

  assert.equal(mint.maxSeen, SANE, "two consecutive outliers must not raise the ceiling between them");
  assert.equal(mint.ignoredAboveBound, 2, "both were ignored, and both were counted");
  assert.equal(
    FAR_ABOVE_NEXT - FAR_ABOVE,
    1,
    "fixture precondition: the two outliers are CONSECUTIVE, so a highest-minus-second-highest rule sees a gap of 1",
  );
});

// ── acceptance 3: the open-PR prose surface, which is where the burn began ──

test("W1-T1039: a sentinel written in an open pr body no longer raises the ceiling", () => {
  // THE ORIGINAL MECHANISM, AND THE HALF THAT MAKES THE CONVENTION SAFE. `mentionedTaskIds` reads
  // an id ANYWHERE in an open PR's text, which is correct — an unmerged PR offers no structured
  // place to read its minted ids from. The repair is not to blind that scan (which would miss a
  // genuinely filed-but-unmerged id) but to make the range above the bound never-allocatable, so a
  // negative control drawn from it is safe to write anywhere, including here.
  const root = planRoot();
  const planPath = writePlan(root, [SANE]);
  const body = `recon: the reservation for W1-T${FAR_ABOVE} reads 0, which is the negative control`;

  const mint = mintNextTaskId({ planPath, openPrTexts: () => [body] });

  assert.equal(mint.maxSeen, SANE, "a sentinel mentioned in prose must not become the ceiling");
  assert.equal(mint.sources.openPrs, null, "the PR text offered only a sentinel, so it contributed nothing");
  assert.equal(mint.ignoredAboveBound, 1);

  // AND THE SCAN STILL DOES ITS JOB: a SANE id mentioned in the same prose is still honoured, so
  // this fix did not quietly disable the surface it hardened.
  const withReal = mintNextTaskId({
    planPath,
    openPrTexts: () => [`${body} — and W1-T${SANE + 5} is filed but unmerged`],
  });
  assert.equal(withReal.maxSeen, SANE + 5, "a real unmerged id in prose must still raise the floor");
});

// ── acceptance 2: allocation only — visibility and eligibility are untouched ──

test("W1-T1039: an out of range shard still loads and still lints", () => {
  // THE BOUND MUST NOT REMOVE A TASK FROM ANYTHING BUT ALLOCATION. The two real out-of-range shards
  // are merged and credited, and `postMergeAmendmentViolations` refuses a renumber — so the fix is
  // a bound that IGNORES them for minting while they keep loading, linting and counting exactly as
  // before. A bound that quietly dropped them from the plan would be a far larger, unasked change.
  const root = planRoot();
  const planPath = writePlan(root, [SANE], [[FAR_ABOVE]]);

  const plan = loadPlan(planPath);
  const ids = plan.tasks.map((t) => t.id);
  assert.equal(plan.tasks.length, 2, "BOTH tasks are in the plan — the out-of-range one is not dropped");
  assert.ok(ids.includes(`W1-T${SANE}`));
  assert.ok(ids.includes(`W1-T${FAR_ABOVE}`), "the out-of-range shard still loads");

  const results = lintPlan(plan);
  assert.equal(results.size, plan.tasks.length, "every task is still linted, the out-of-range one included");
  assert.ok(results.has(`W1-T${FAR_ABOVE}`), "the out-of-range task is still checked by the linter");

  // And the allocator still refuses to mint at it, in the same tree — the two facts coexist.
  assert.equal(mintNextTaskId({ planPath }).maxSeen, SANE);
});

// ── the fourth surface: git history, which can never be cleaned up ──────────────────────────

test("W1-T1039: an id above the bound in plan history no longer raises the ceiling", async () => {
  // THE SURFACE THAT CANNOT BE REPAIRED AT SOURCE. The other three can in principle be edited; this
  // one reads ids out of immutable git history, so a shard once filed at a burned id keeps handing
  // that id back from `git log -p` forever. `mintNextTaskIdWithHistory` folds it in AFTER
  // `mintNextTaskId` has already bounded its own three, so without the same filter here the fix is
  // invisible at the verb: MEASURED with the library bound alone in place, `rmd next-task-id`
  // reported a correctly-bounded `shards` term beside an unbounded history term and still answered
  // out of range.
  const { mintNextTaskIdWithHistory } = await import("../src/run-task.js");
  const root = planRoot();
  const planPath = writePlan(root, [SANE]);

  // A synthetic `git log -p` patch: one ADDED id inside the range, one above it. `taskIdsEverFiled`
  // reads added `id:` lines, so this is the exact shape the real scan sees.
  const patch = [`+- id: W1-T${SANE}`, `+- id: W1-T${FAR_ABOVE}`, ""].join("\n");
  const gitRunner = (args: string[]): string => {
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc1234\n";
    if (args[0] === "log") return patch;
    throw new Error(`unstubbed git ${args[0]}`); // no cache path resolves -> nothing is written
  };

  const mint = mintNextTaskIdWithHistory({ planPath, repoRoot: root, gitRunner });

  assert.equal(mint.historyMax, SANE, "history contributes its sane id, never the one above the bound");
  assert.equal(mint.maxSeen, SANE, "the folded max stays inside the range");
  assert.equal(mint.n, SANE + 1);
  assert.ok(mint.n <= MAX_ALLOCATABLE_TASK_ID, "the verb's own mint may never exceed the bound");

  // PRECONDITION, so the assertions above are not vacuous: the fixture patch really does carry an
  // id above the bound, and the scan really would have seen it.
  assert.ok(patch.includes(`W1-T${FAR_ABOVE}`), "fixture carries an out-of-range added id");
  assert.equal(isAllocatableTaskId(FAR_ABOVE), false, "and it is genuinely outside the bound");
});
