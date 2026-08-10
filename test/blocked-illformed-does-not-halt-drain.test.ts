/**
 * `blocked_illformed` NO LONGER HALTS A DRAIN — the third and best-justified member of
 * {@link NON_HALTING_VERDICTS}.
 *
 * THE ARGUMENT, and why it is stronger here than for either predecessor. The drain's header
 * justifies stop-on-block as "a blocked task's DEPENDENTS would build on missing work, so
 * continuing risks compounding a gap." For `blocked_ci` (#1500) the work was pushed and a PR is
 * open; for `no_pr` (#1508) a worker ran and produced nothing. For THIS verdict the pre-dispatch
 * linter refused the task before anything happened at all — `runTask`'s own comment above the
 * refusal reads "linter-failing task BEFORE the inflight lock is even taken — no lock, no worktree,
 * no worker ever spawns", and the result carries `costUsd: 0`. Nothing to compound, nothing spent.
 *
 * MEASURED: one `--max 6` drain ran W1-T393 (merged), W1-T399 (`no_pr`, correctly continued), then
 * W1-T24 — refused with three `proof-dialect` violations — and stopped, surrendering three
 * dispatches. `lint-plan` reports 472 `proof-dialect` violations plan-wide, so a drain working past
 * the (clean) frontier meets one routinely.
 *
 * WHAT THIS FILE LOCKS, and the trap each assertion exists for.
 *   BOTH DIRECTIONS. A suite asserting only "blocked_illformed continues" passes just as happily
 *   against a change that EMPTIES the halt set. Every continue-test here has a twin that swaps only
 *   the verdict and requires a halt, plus an explicit assertion of the set's exact membership.
 *   THE FIXTURE REACHES THE DECISION. `attempted.length > 0` is asserted before any conclusion is
 *   drawn from a drain that continued: a drain that dispatched nothing also "does not halt", and
 *   would satisfy the headline claim vacuously.
 *   THE SKIP IS VISIBLE. 472 latent violations must not become 472 silent skips, so the rundown's
 *   per-task attribution is asserted here rather than assumed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildRundown, haltsDrain, NON_HALTING_VERDICTS, renderRundown, runDrain, type DrainSummary } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";

function task(id: string, depends_on: string[] = []): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on,
    type: "implement",
    verify: "auto",
    risk: "low",
    status: "queued",
    attempts: 0,
    files: [],
    acceptance: [],
  } as unknown as Task;
}

function plan(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan;
}

function drainDeps(results: Record<string, { merged: boolean; verdict: string; prUrl?: string }>, merged: Set<string>) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      refreshMerged: () => (id: string) => merged.has(id),
      runOne: async (id: string) => {
        calls.push(id);
        const r = results[id];
        if (r.merged) merged.add(id);
        // `costUsd: 0` matches what runTask really returns for a pre-dispatch refusal — see the
        // source-level assertion at the end of this file, which pins that rather than trusting it.
        return { taskId: id, runId: `R-${id}`, merged: r.merged, verdict: r.verdict, prUrl: r.prUrl, costUsd: r.verdict === "blocked_illformed" ? 0 : 1 };
      },
      log: () => {},
    },
  };
}

test("haltsDrain: blocked_illformed no longer halts, while every genuinely blocking verdict still does", () => {
  assert.equal(haltsDrain({ merged: false, verdict: "blocked_illformed" }), false, "blocked_illformed must not halt");

  // THE CONTROL that stops this passing against an emptied set. Every remaining member of the halt
  // set is named, so removing one silently fails here rather than in production.
  for (const v of [
    "blocked",
    "blocked_review",
    "blocked_containment",
    "blocked_isolation",
    "blocked_budget",
    "blocked_transient",
    "blocked_git_fetch",
    "blocked_inflight",
    // `task_already_merged` LEFT this list when it joined NON_HALTING_VERDICTS. When THIS file was
    // written it was the strongest remaining candidate and was named here deliberately; the
    // measured `--max 6` drain that stopped at $0.00 on W1-T24 spent that deferral. Its argument is
    // stronger than this file's own: `blocked_illformed` never dispatched, whereas an already-merged
    // task is FINISHED — its dependents can build on it, so there is no gap to compound.
    "pr_attribution_failed",
    "failed",
  ]) {
    assert.equal(haltsDrain({ merged: false, verdict: v }), true, `${v} must still halt`);
  }
  assert.deepEqual(
    [...NON_HALTING_VERDICTS].sort(),
    ["blocked_ci", "blocked_illformed", "no_pr", "task_already_merged"],
    "the exempt set is exactly these four — not three, and not everything",
  );
  assert.equal(haltsDrain({ merged: true, verdict: "merged" }), false, "a merged result never halts");
});

test("runDrain CONTINUES past a blocked_illformed and spends the rest of its budget on other work", async () => {
  const p = plan([task("A"), task("B")]);
  // A pre-dispatch refusal has NO prUrl and NO cost — nothing ran.
  const { calls, deps } = drainDeps(
    { A: { merged: false, verdict: "blocked_illformed" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const s = (await runDrain(p, deps as never, { max: 2 })) as DrainSummary;
  assert.ok(s.attempted.length > 0, "fixture must reach the halt decision");
  assert.deepEqual(calls, ["A", "B"], "the drain must go on to dispatch B");
  assert.deepEqual(s.merged, ["B"], "a continued task is NOT credited as merged");
  assert.deepEqual(
    (s.continued ?? []).map((c) => c.taskId),
    ["A"],
    "the ill-formed task is recorded as continued, never as done",
  );
  assert.equal(s.costUsd, 1, "the refusal itself cost nothing — only B's run is billed");
});

test("runDrain still HALTS on a genuinely blocking verdict — the same fixture with only the verdict swapped", async () => {
  // THE FALSIFIER for the test above. Identical plan, identical deps, one string changed.
  const p = plan([task("A"), task("B")]);
  const { calls, deps } = drainDeps(
    { A: { merged: false, verdict: "blocked_review" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const s = (await runDrain(p, deps as never, { max: 2 })) as DrainSummary;
  assert.ok(s.attempted.length > 0, "fixture must reach the halt decision");
  assert.deepEqual(calls, ["A"], "B must never be dispatched");
  assert.equal(s.stopReason, "blocked");
  assert.deepEqual(s.continued ?? [], [], "a halting verdict is never recorded as continued");
});

test("an ill-formed task is dispatched exactly once per pass — continuing past it does not re-offer it", async () => {
  // `excludeIds` (#1500) is the ONLY thing standing between this verdict and a same-pass loop: the
  // task is still unmerged, still dependency-eligible, and unlike blocked_ci has no open PR for
  // `isOpenPr` to catch. Its linter verdict is also deterministic, so a re-offer would refuse it
  // again immediately and spin. Budget deliberately exceeds the task count so a loop is visible.
  const p = plan([task("A"), task("B")]);
  const { calls, deps } = drainDeps(
    { A: { merged: false, verdict: "blocked_illformed" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const s = (await runDrain(p, deps as never, { max: 4 })) as DrainSummary;
  assert.ok(s.attempted.length > 0, "fixture must reach the halt decision");
  assert.equal(calls.filter((c) => c === "A").length, 1, "A must be dispatched exactly once");
});

test("the parallel-lane loop applies the same rule: an ill-formed lane continues, a blocking lane halts", async () => {
  // The two loops decide through ONE predicate, but they are separate call sites and this file's
  // own history is that single-lane and multi-lane drifted apart.
  const p = plan([task("A"), task("B")]);
  const soft = drainDeps(
    { A: { merged: false, verdict: "blocked_illformed" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const s = (await runDrain(p, soft.deps as never, { max: 2, laneCount: 2 })) as DrainSummary;
  assert.ok(s.attempted.length > 0, "fixture must reach the halt decision");
  assert.deepEqual((s.continued ?? []).map((c) => c.taskId), ["A"], "the ill-formed lane is continued");

  const hard = drainDeps({ A: { merged: false, verdict: "failed" }, B: { merged: true, verdict: "merged" } }, new Set());
  const h = (await runDrain(p, hard.deps as never, { max: 2, laneCount: 2 })) as DrainSummary;
  assert.ok(h.attempted.length > 0, "fixture must reach the halt decision");
  assert.equal(h.stopReason, "blocked", "a blocking lane still stops the pass");
});

test("the rundown NAMES the skipped task and its reason — 472 latent violations must not skip silently", async () => {
  // THE PRECONDITION FOR SKIPPING AT ALL. If continuing meant the refusal vanished from the
  // operator's view, this change would trade a halt for a silence, which is worse.
  const p = plan([task("A"), task("B")]);
  const { deps } = drainDeps(
    { A: { merged: false, verdict: "blocked_illformed" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const s = (await runDrain(p, deps as never, { max: 2 })) as DrainSummary;
  assert.ok(s.attempted.length > 0, "fixture must reach the halt decision");

  const rendered = renderRundown(buildRundown(s));
  assert.match(rendered, /blocked\s+: A — blocked_illformed — drain continued/, "the skipped task gets its OWN verdict line");
  assert.match(rendered, /merged\s+: B/, "and the work that followed it is still credited");
});

test("runTask returns blocked_illformed with costUsd 0, before any lock or spawn — the premise of the exemption", () => {
  // THE ARGUMENT RESTS ON THIS AND NOTHING ELSE. If a future change made the pre-dispatch refusal
  // happen AFTER a worktree or a spawn, "nothing was spent" would silently stop being true and this
  // verdict would no longer deserve its exemption. Read from source, since no unit test drives the
  // real refusal path.
  const src = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
  assert.match(
    src,
    /costUsd: 0, verdict: "blocked_illformed"/,
    "the refusal must still return costUsd: 0 — a billed refusal is a different verdict from this one",
  );
  assert.match(
    src,
    /BEFORE the inflight lock is even taken/,
    "and must still be documented as preceding the lock, worktree and spawn",
  );
});
