import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlan, type Plan, type Task } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import { runDrain, runnableCandidates, type DrainDeps } from "../src/lib/drain.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import {
  NO_OBSERVED_SCOPE,
  partitionByFileOverlap,
  type ObservedScopeByTask,
} from "../src/lib/dispatch-overlap.js";
import { buildRiskJudgePrompt, type RiskJudgeInput } from "../src/lib/risk-judge.js";
import { shardDeclaredFilesInDiff } from "../src/lib/review.js";

/**
 * W1-T2286 — WIRING `partitionByFileOverlap`'s `observedByTask` UNION THROUGH ITS THREE
 * PRODUCTION CALL SITES (drain.ts's `packDisjointFirst`/`isDisjointFromEvery`, drain.ts's own
 * `runDrainLanes`, daemon.ts's `runDaemon`) — the corrector W1-T2237 built and nothing called.
 * See plan/tasks.d/W1-T2286-the-scope-corrector-is-built-and-unwired.yaml for the full
 * rationale. This shard WIRES the plumbing; it deliberately picks NO live producer (task
 * rationale §4), so every DrainDeps/DaemonDeps that omits `observedByTask` still dispatches
 * byte-identically to before this task — every test below that proves a BEHAVIOUR CHANGE does
 * so by explicitly injecting an `observedByTask` map, exactly as a future producer would.
 */

function readSrc(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relPath}`, import.meta.url)), "utf8");
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" });

function mkTask(id: string, files: string[]): Task {
  return {
    id,
    title: id.toLowerCase(),
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    files,
  };
}

function threeTaskPlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "observed-scope-wiring-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/a.ts]\n" +
      "- id: B\n  title: b\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [test/shared.test.ts]\n" +
      "- id: C\n  title: c\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/c.ts]\n",
  );
  return loadPlan(f);
}

function twoTaskPlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "observed-scope-wiring-2-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/a.ts]\n" +
      "- id: B\n  title: b\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [test/shared.test.ts]\n",
  );
  return loadPlan(f);
}

// ── acceptance: union, never replacement ─────────────────────────────────────────────────────

test("partitionByFileOverlap: an observed path is UNIONED with the declaration, never replaces it — a declared collision still fires with an unrelated observed entry present", () => {
  const A = mkTask("A", ["src/a.ts"]);
  const E = mkTask("E", ["src/a.ts"]);
  // A's OBSERVED scope is a path unrelated to the declared collision. If the union replaced the
  // declaration rather than adding to it, A's effective scope would become ["src/other.ts"] and
  // it would stop colliding with E's declared src/a.ts. It does not: declared ground is still
  // compared, exactly as this claim requires.
  const observed: ObservedScopeByTask = new Map([["A", { files: ["src/other.ts"] }]]);
  const partition = partitionByFileOverlap([A, E], observed);
  assert.deepEqual(partition.dispatch.map((t) => t.id), ["A"], "A takes the slot (first-declared wins)");
  assert.equal(partition.serialized.length, 1, "E is still serialized against A's DECLARED src/a.ts");
  assert.equal(partition.serialized[0]?.task, "E");
  assert.equal(partition.serialized[0]?.blockedBy, "A");
});

// ── acceptance: no observations ⇒ unchanged scoring ──────────────────────────────────────────

test("partitionByFileOverlap: a task with NO observations is scored exactly as it is today — byte-identical to omitting the map, an observed entry for an UNRELATED task changes nothing", () => {
  const A = mkTask("A", ["src/a.ts"]);
  const B = mkTask("B", ["src/b.ts"]);
  const baseline = partitionByFileOverlap([A, B]);
  const withUnrelatedObservation = partitionByFileOverlap(
    [A, B],
    new Map([["Z", { files: ["src/a.ts", "src/b.ts"] }]]), // "Z" is not a candidate here — irrelevant
  );
  const withExplicitEmpty = partitionByFileOverlap([A, B], NO_OBSERVED_SCOPE);
  assert.deepEqual(withUnrelatedObservation, baseline, "an observation for a task NOT in this candidate set is a no-op");
  assert.deepEqual(withExplicitEmpty, baseline, "an explicit empty map behaves exactly like the omitted default");
});

// ── acceptance: same-test-file collision surfaces once observed, and test/ is NOT exempted ──
// Both proved together against `runnableCandidates` — the EXPORTED entry point `packDisjointFirst`/
// `isDisjointFromEvery` (drain.ts) sit behind — so this is a real exercise of that call site, not
// a re-derivation of `partitionByFileOverlap`'s own logic.

test("runnableCandidates: two tasks reaching the SAME test file are packed apart once the observation is present, where the declaration alone called them disjoint — and the test/ path is not exempted from the union", () => {
  const plan = threeTaskPlan(); // A:[src/a.ts], B:[test/shared.test.ts], C:[src/c.ts] — pairwise declared-disjoint
  const isMerged = () => false;

  const withoutObservation = runnableCandidates(plan, isMerged, 2, {});
  assert.deepEqual(
    withoutObservation.map((t) => t.id),
    ["A", "B"],
    "declaration alone: A and B are disjoint, so the first two in dispatch order both pack",
  );

  // A's REAL diff reached test/shared.test.ts too — the exact undeclared-test-file shape the
  // task rationale measures as the largest single undeclared category (test/run-task.test.ts,
  // §0). Nothing exempts it from this union (deliberately — task rationale §3).
  const observedByTask: ObservedScopeByTask = new Map([["A", { files: ["test/shared.test.ts"] }]]);
  const withObservation = runnableCandidates(plan, isMerged, 2, { observedByTask });
  assert.deepEqual(
    withObservation.map((t) => t.id),
    ["A", "C"],
    "B is now skipped for A's slot mate — A's OBSERVED reach collides with B's DECLARED test/shared.test.ts",
  );
});

// ── acceptance: wired at drain.ts's runDrainLanes call site too, with the falsifier ─────────

test("runDrain (laneCount 2): a declared-disjoint pair sharing an OBSERVED test file is deferred via dispatch.serialized, and dispatches on the next pass — the drain.ts wiring reaches partitionByFileOverlap's own direct call, not only the pack step", async () => {
  const plan = twoTaskPlan(); // A:[src/a.ts], B:[test/shared.test.ts]
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const observedByTask: ObservedScopeByTask = new Map([["A", { files: ["test/shared.test.ts"] }]]);
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id: string) => merged.has(id),
      runOne: async (id: string) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
      observedByTask,
    } as DrainDeps,
    { laneCount: 2, max: 4 },
  );
  const serializedLine = lines.find((l) => l.step === "dispatch.serialized");
  assert.ok(serializedLine, "B was deferred — its DECLARED test/shared.test.ts collides with A's OBSERVED reach");
  assert.equal(serializedLine?.extra.task, "B");
  assert.equal(serializedLine?.extra.blocked_by, "A");
  assert.deepEqual(ran, ["A", "B"], "self-resolving: B dispatches on the pass AFTER A, never dropped");
  assert.equal(s.stopReason, "no_runnable");
});

test("FALSIFIER: the SAME plan/candidates with NO observedByTask dependency co-dispatch in one pass — proving the serialization above is caused BY the wiring, not by something else", async () => {
  const plan = twoTaskPlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id: string) => merged.has(id),
      runOne: async (id: string) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
      // observedByTask deliberately OMITTED — this is the pre-W1-T2286 shape every production
      // call site had, and is what removing the wiring at this call site reduces to.
    } as DrainDeps,
    { laneCount: 2, max: 4 },
  );
  assert.equal(
    lines.find((l) => l.step === "dispatch.serialized"),
    undefined,
    "declared files: are disjoint, so with no observation there is nothing to serialize",
  );
  assert.deepEqual(ran.sort(), ["A", "B"], "both dispatch in the SAME pass — the collision above depended on the injected observation");
  assert.equal(s.stopReason, "no_runnable");
});

// ── acceptance: wired at daemon.ts's runDaemon call site too ────────────────────────────────

test("runDaemon (laneCount 2): the SAME declared-disjoint / observed-colliding pair is deferred via dispatch.serialized — the daemon.ts wiring reaches partitionByFileOverlap's own direct call", async () => {
  const plan = twoTaskPlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const observedByTask: ObservedScopeByTask = new Map([["A", { files: ["test/shared.test.ts"] }]]);
  let ticks = 0;
  const summary = await runDaemon(
    plan,
    {
      refreshMerged: () => (id: string) => merged.has(id),
      checkStop: () => (++ticks > 4 ? "tick cap" : undefined),
      log: (step: string, extra?: Record<string, unknown>) => lines.push({ step, extra }),
      runOne: async (id: string) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      sleep: async () => {},
      observedByTask,
    } as unknown as DaemonDeps,
    { max: 2, laneCount: 2 },
  );
  assert.equal(summary.merged.length, 2, "both eventually dispatch — deferred, never dropped");
  assert.deepEqual(ran, ["A", "B"], "each dispatches on its OWN pass — never co-batched with its observed collision");
  const serializedLine = lines.find((l) => l.step === "dispatch.serialized");
  assert.ok(serializedLine, "the daemon's own dispatch-set branch ledgers dispatch.serialized too");
  assert.equal(serializedLine?.extra?.task, "B");
  assert.equal(serializedLine?.extra?.blocked_by, "A");
});

// ── acceptance: the wiring is EXPLICIT at each call site (mechanical, source-level proof) ───

test("SOURCE: all three call sites pass observedByTask EXPLICITLY rather than omitting the argument and relying on partitionByFileOverlap's own default", () => {
  const dispatchOverlapSrc = readSrc("src/lib/dispatch-overlap.ts");
  const drainSrc = readSrc("src/lib/drain.ts");
  const daemonSrc = readSrc("src/lib/daemon.ts");

  assert.match(dispatchOverlapSrc, /export const NO_OBSERVED_SCOPE: ObservedScopeByTask/, "the empty union is exported for callers to pass explicitly");

  // drain.ts's two call sites: the pack step's isDisjointFromEvery/packDisjointFirst chain, and
  // runDrainLanes' own direct partitionByFileOverlap call.
  assert.match(
    drainSrc,
    /function isDisjointFromEvery\(collected: readonly Task\[\], candidate: Task, observedByTask: ObservedScopeByTask\)/,
    "isDisjointFromEvery now takes observedByTask rather than calling partitionByFileOverlap with one argument",
  );
  assert.match(
    drainSrc,
    /partitionByFileOverlap\(candidates, deps\.observedByTask \?\? NO_OBSERVED_SCOPE\)/,
    "runDrainLanes' own partitionByFileOverlap call passes an explicit second argument",
  );

  // daemon.ts's one call site: runDaemon's own direct partitionByFileOverlap call.
  assert.match(
    daemonSrc,
    /partitionByFileOverlap\(candidates, deps\.observedByTask \?\? NO_OBSERVED_SCOPE\)/,
    "runDaemon's own partitionByFileOverlap call passes an explicit second argument",
  );

  // Neither call-site file passes a bare `partitionByFileOverlap(candidates)` anymore.
  assert.doesNotMatch(drainSrc, /partitionByFileOverlap\(candidates\)/, "drain.ts no longer relies on the default parameter");
  assert.doesNotMatch(daemonSrc, /partitionByFileOverlap\(candidates\)/, "daemon.ts no longer relies on the default parameter");
});

// ── acceptance: the risk judge's scope signal is not fed observed paths ─────────────────────

test("risk-judge.ts is not fed observed paths — it imports nothing from dispatch-overlap.ts, and its prompt still flags an undeclared file off the SAME REST-sourced changeView (W1-T1031) it always used", () => {
  const riskJudgeSrc = readSrc("src/lib/risk-judge.ts");
  assert.doesNotMatch(riskJudgeSrc, /dispatch-overlap/, "risk-judge.ts has no dependency on this module at all — nothing here could feed it observed paths");

  const input: RiskJudgeInput = {
    change: {
      description: "touches an undeclared file",
      files: ["src/a.ts"], // DECLARED — deliberately missing src/undeclared.ts below
      changeView: { files: [{ path: "src/a.ts", additions: 1, deletions: 0 }, { path: "src/undeclared.ts", additions: 3, deletions: 0 }], truncated: false },
    },
    gatesState: {},
    planContext: {},
  };
  const prompt = buildRiskJudgePrompt(input);
  assert.match(prompt, /FILES TOUCHED \(declared\): src\/a\.ts/, "the declared list is rendered from task.files, unrelated to this shard");
  assert.match(prompt, /src\/undeclared\.ts: \+3\/-0/, "the REST-sourced ACTUAL CHANGE view still surfaces the undeclared file — unaffected by this task's wiring");
});

// ── acceptance: the proof forward-reference carve-out is untouched ──────────────────────────

test("shardDeclaredFilesInDiff (review.ts) is untouched — it still reads files: off the PR's OWN diff text, not from any ObservedScopeByTask", () => {
  const reviewSrcExcerpt = readSrc("src/lib/review.ts");
  assert.doesNotMatch(reviewSrcExcerpt, /dispatch-overlap/, "review.ts has no dependency on dispatch-overlap.ts");

  const diff = [
    "diff --git a/plan/tasks.d/W1-T999-example.yaml b/plan/tasks.d/W1-T999-example.yaml",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/plan/tasks.d/W1-T999-example.yaml",
    "@@ -0,0 +1,2 @@",
    "+- id: W1-T999",
    "+  files: [src/foo.ts, test/observed-scope-wiring.test.ts]",
  ].join("\n");
  assert.deepEqual(
    [...shardDeclaredFilesInDiff(diff)].sort(),
    ["src/foo.ts", "test/observed-scope-wiring.test.ts"],
    "the forward-reference carve-out still reads the declaration from the DIFF, exactly as before this task",
  );
});

// ── acceptance: nothing here edits a merged shard's files: declaration at runtime ───────────

test("partitionByFileOverlap never mutates a candidate's declared files: — the union is computed into a NEW object, the input Task is untouched", () => {
  const declared = ["src/a.ts"];
  const A = mkTask("A", declared);
  const B = mkTask("B", ["src/b.ts"]);
  const observed: ObservedScopeByTask = new Map([["A", { files: ["src/overrun.ts"] }]]);
  partitionByFileOverlap([A, B], observed);
  assert.equal(A.files, declared, "the Task object's files array is the SAME reference after the call — never replaced");
  assert.deepEqual(declared, ["src/a.ts"], "and its contents are untouched");
});

test("SOURCE: no runtime write to a plan shard from the wiring's three touched files", () => {
  for (const path of ["src/lib/dispatch-overlap.ts", "src/lib/drain.ts", "src/lib/daemon.ts"]) {
    const src = readSrc(path);
    assert.doesNotMatch(src, /writeFileSync\([^)]*tasks\.(d|yaml)/, `${path} writes no plan/tasks.d file`);
  }
});
