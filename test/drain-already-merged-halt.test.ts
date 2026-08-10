import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import {
  NON_HALTING_VERDICTS,
  buildRundown,
  haltsDrain,
  renderRundown,
  runDrain,
  runnableCandidates,
  type MergedSet,
} from "../src/lib/drain.js";
import type { RunResult } from "../src/run-task.js";

/**
 * AN ALREADY-MERGED TASK HALTED THE DRAIN.
 *
 * MEASURED: a `--max 6` drain attempted ONE task and stopped at $0.00 —
 * `REFUSED: W1-T24 is already merged (…/pull/75) — pass --rerun to dispatch anyway`, then
 * `stopped : blocked — W1-T24 → task_already_merged`, with five live tasks behind it.
 *
 * `task_already_merged` is the FOURTH verdict to join `NON_HALTING_VERDICTS`, and its argument is
 * the strongest of the four: the drain's own header justifies stop-on-block as "a blocked task's
 * DEPENDENTS would build on missing work", and here the work is DONE — its dependents can build
 * on it, which is what merged means. Nothing is missing to compound, and the refusal costs zero
 * (it fires before any lock, worktree or worker).
 *
 * BOTH DIRECTIONS ARE PROVED, because a test asserting only "it no longer halts" passes on a
 * change that empties the halt set entirely.
 */

// A first in FILE ORDER so it is the task selection reaches, with D genuinely behind it.
// `nextRunnable` SHORT-CIRCUITS on the first eligible task, so a fixture whose subject sits after
// a dispatchable task never reaches the decision under test at all.
const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [src/a.ts]
- id: D
  title: d
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [src/d.ts]
- id: H
  title: human-only
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`;

function fixturePlan(tag: string): Plan {
  const dir = mkdtempSync(join(tmpdir(), `drain-already-merged-${tag}-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const NONE_MERGED: MergedSet = () => false;

/**
 * A merged set that GROWS as the drain merges things — what `drainCommand`'s own `refreshMerged`
 * does (it re-derives the projection from GitHub on every pass). A frozen `() => false` re-offers
 * an already-merged task on the next pass and the drain runs it again, which is a FIXTURE defect
 * that looks exactly like a spin: caught here by `ran` reading `["A","D","D","D","D","D"]`.
 */
function liveMergedSet(): { isMerged: MergedSet; record: (id: string) => void } {
  const done = new Set<string>();
  return { isMerged: (id) => done.has(id), record: (id) => void done.add(id) };
}

const merged = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.5, verdict: "merged" });
/** The W1-T319 refusal's own shape: non-merged, ZERO cost, no PR of its own. */
const alreadyMerged = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: false, costUsd: 0, verdict: "task_already_merged" });
const blockedReview = (id: string): RunResult => ({
  taskId: id,
  runId: `${id}-run`,
  merged: false,
  costUsd: 0.3,
  verdict: "blocked_review",
  prUrl: "https://github.com/o/r/pull/9",
});

// ── the halt set, enumerated — RE-DERIVED FROM THE TYPE'S OWN SOURCE ───────────────────────

/**
 * Every verdict `RunResult` can carry, read out of `src/lib/run-result.ts` rather than retyped.
 * A hand-kept list would silently stop covering a verdict added later — and a verdict nobody
 * classified defaults to HALTING, which is a decision made by omission.
 */
function verdictsFromSource(): string[] {
  const src = readFileSync(new URL("../src/lib/run-result.ts", import.meta.url), "utf8");
  const union = src.slice(src.indexOf("verdict:"), src.indexOf("}", src.indexOf("verdict:")));
  return [...union.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]);
}

/** The documented split. `merged`/`already_satisfied` carry `merged: true` and never reach the set. */
const HALTS: Record<string, boolean> = {
  merged: false,
  already_satisfied: false,
  blocked_ci: false,
  no_pr: false,
  blocked_illformed: false,
  task_already_merged: false,
  blocked: true,
  blocked_review: true,
  blocked_budget: true,
  blocked_containment: true,
  blocked_isolation: true,
  blocked_inflight: true,
  blocked_git_fetch: true,
  blocked_transient: true,
  pr_attribution_failed: true,
  failed: true,
};

test("the halt set is EXHAUSTIVE over RunResult's own verdict union — a new verdict cannot default to halting unnoticed", () => {
  const declared = verdictsFromSource();
  assert.ok(declared.length >= 16, `the union parse must actually find the verdicts (found ${declared.length})`);
  assert.deepEqual(
    declared.filter((v) => !(v in HALTS)),
    [],
    "every verdict RunResult declares must be classified here — an unclassified one halts by omission",
  );
  assert.deepEqual(
    Object.keys(HALTS).filter((v) => !declared.includes(v)),
    [],
    "and this table must not classify a verdict the type no longer has",
  );
});

test("haltsDrain: exactly four non-merged verdicts continue the drain; every other one still stops it", () => {
  for (const [verdict, shouldHalt] of Object.entries(HALTS)) {
    const isMergedResult = verdict === "merged" || verdict === "already_satisfied";
    assert.equal(
      haltsDrain({ merged: isMergedResult, verdict }),
      shouldHalt,
      `${verdict} must ${shouldHalt ? "HALT" : "CONTINUE"} the drain`,
    );
  }
  // The membership itself, stated: emptying the set would satisfy every "no longer halts"
  // assertion in this file while destroying the guarantee the halting tests below hold.
  assert.deepEqual([...NON_HALTING_VERDICTS].sort(), ["blocked_ci", "blocked_illformed", "no_pr", "task_already_merged"]);
});

// ── the fixture really has work behind A ───────────────────────────────────────────────────

test("FIXTURE PRECONDITION: A and D are both dispatchable, so 'D was never attempted' is a real claim", () => {
  assert.deepEqual(
    runnableCandidates(fixturePlan("precondition"), NONE_MERGED, 10).map((t) => t.id),
    ["A", "D"],
    "H is verify:human; A and D are both eligible, and A is first in file order",
  );
});

// ── direction 1: task_already_merged no longer halts ───────────────────────────────────────

test("runDrain: a task_already_merged refusal is CONTINUED past, and the drain spends its remaining budget", async () => {
  const plan = fixturePlan("continues");
  const ran: string[] = [];
  const live = liveMergedSet();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => live.isMerged,
      runOne: async (id) => {
        ran.push(id);
        if (id === "A") return alreadyMerged(id);
        live.record(id);
        return merged(id);
      },
    },
    { max: 6 },
  );

  // REACHED THE DECISION: A was really selected and really returned the verdict under test.
  assert.deepEqual(ran, ["A", "D"], "A ran and returned task_already_merged; the drain went on to D");
  assert.deepEqual(s.attempted, ["A", "D"]);
  assert.deepEqual(s.merged, ["D"], "the refused task is NOT credited as merged by this drain — it produced no PR");
  assert.deepEqual(s.continued, [{ taskId: "A", verdict: "task_already_merged", prUrl: undefined }]);
  assert.equal(s.stopReason, "no_runnable", "the drain ran out of work rather than stopping on A");
  assert.equal(s.costUsd, 0.5, "the refusal itself cost nothing — only D's real run is charged");
});

test("runDrain: the refused task is never re-offered, so a deterministic refusal cannot spin", async () => {
  const plan = fixturePlan("no-spin");
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      // BOTH refuse, every time — the real refusal is deterministic (the projection does not
      // change mid-drain), so nothing but `excludeIds` stops the selector re-offering A forever.
      runOne: async (id) => {
        ran.push(id);
        return alreadyMerged(id);
      },
    },
    { max: 6 },
  );
  assert.deepEqual(ran, ["A", "D"], "each task offered EXACTLY ONCE across a --max 6 budget, never re-selected");
  assert.equal(s.stopReason, "no_runnable");
  assert.equal(s.costUsd, 0);
});

// ── direction 2: a genuinely blocking verdict STILL halts ──────────────────────────────────

test("runDrain: a genuinely blocking verdict still stops the drain, with the work behind it untouched", async () => {
  const plan = fixturePlan("still-halts");
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => {
        ran.push(id);
        return id === "A" ? blockedReview(id) : merged(id);
      },
    },
    { max: 6 },
  );

  // THE LOAD-BEARING DIRECTION. Emptying NON_HALTING_VERDICTS — or adding a verdict that leaves
  // work unfinished — turns this red. `blocked_review` means a PR exists and was NOT accepted:
  // its dependents really would build on missing work, which is the header's own argument.
  assert.deepEqual(ran, ["A"], "D was never attempted — the drain stopped at A");
  assert.deepEqual(s.attempted, ["A"]);
  assert.equal(s.stopReason, "blocked");
  assert.match(String(s.stopDetail), /A → blocked_review/);
  assert.deepEqual(s.continued ?? [], [], "a halting verdict is never recorded as continued");
});

// ── the skip is named, so a stale plan cannot hide behind it ───────────────────────────────

test("buildRundown gives the refused task its OWN line, carrying its own verdict — never the drain's stopDetail", async () => {
  const plan = fixturePlan("rundown");
  const live = liveMergedSet();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => live.isMerged,
      runOne: async (id) => {
        if (id === "A") return alreadyMerged(id);
        live.record(id);
        return merged(id);
      },
    },
    { max: 6 },
  );
  const lines = buildRundown(s);
  assert.deepEqual(
    lines,
    [
      { taskId: "A", outcome: "blocked", detail: "task_already_merged — drain continued" },
      { taskId: "D", outcome: "merged" },
    ],
    "a drain that silently skipped merged tasks would hide a stale plan; this one names the skip",
  );
  const rendered = renderRundown(lines);
  assert.match(rendered, /A.*task_already_merged/, "and the operator sees it, not just the ledger");
});

// ── the lanes loop decides identically ─────────────────────────────────────────────────────

test("runDrain at laneCount 2: the lanes loop continues past the refusal and still halts on a real block", async () => {
  const contPlan = fixturePlan("lanes-continues");
  const contRan: string[] = [];
  const contLive = liveMergedSet();
  const cont = await runDrain(
    contPlan,
    {
      refreshMerged: () => contLive.isMerged,
      runOne: async (id) => {
        contRan.push(id);
        if (id === "A") return alreadyMerged(id);
        contLive.record(id);
        return merged(id);
      },
    },
    { max: 6, laneCount: 2 },
  );
  assert.deepEqual(contRan.sort(), ["A", "D"], "REACHED THE DECISION on the lanes path too");
  assert.deepEqual(cont.merged, ["D"]);
  assert.deepEqual(cont.continued, [{ taskId: "A", verdict: "task_already_merged", prUrl: undefined }]);
  assert.equal(cont.stopReason, "no_runnable");

  const haltPlan = fixturePlan("lanes-halts");
  const halt = await runDrain(
    haltPlan,
    {
      refreshMerged: () => NONE_MERGED,
      // A and D share no files, so at laneCount 2 both dispatch in ONE pass and the halt is
      // decided over the settled set rather than after a solo run — the case the single-lane
      // test cannot reach.
      runOne: async (id) => (id === "A" ? blockedReview(id) : merged(id)),
    },
    { max: 6, laneCount: 2 },
  );
  assert.equal(halt.stopReason, "blocked", "the lanes loop shares ONE halt predicate with the single-lane loop");
  assert.match(String(halt.stopDetail), /A → blocked_review/);
});

// ── the curated path, which is how the measured drain selected ─────────────────────────────

test("runDrain --curated: the refusal is continued past there too, and the curated selector cannot re-offer it", async () => {
  const plan = fixturePlan("curated");
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => {
        ran.push(id);
        return id === "A" ? alreadyMerged(id) : merged(id);
      },
    },
    // The measured shape: an operator-curated list headed by a task the projection had not yet
    // credited. `nextCurated` guards re-offer through `attempted` rather than `excludeIds`, so
    // the no-spin property has to be proved on this path separately.
    { max: 6, curated: ["A", "D"] },
  );
  assert.deepEqual(ran, ["A", "D"]);
  assert.deepEqual(s.merged, ["D"], "the four dispatches behind the refusal are no longer surrendered");
  assert.equal(s.stopReason, "no_runnable");
});
