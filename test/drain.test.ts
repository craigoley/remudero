import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";
import {
  applyCuratedSelection,
  buildDrainPreview,
  nextRunnable,
  plannedSequence,
  renderSummary,
  resumeCommand,
  runDrain,
  type CuratedSelection,
  type MergedSet,
  type OpenPrCheck,
} from "../src/lib/drain.js";
import { pauseDetail, requestPause, requestStop, stopDetail } from "../src/lib/fleet-control.js";
import { deriveStatus, type GitHub } from "../src/lib/status.js";

// A small linear-ish plan: A → B → C (chain) + D (independent), all auto.
const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: b
  repo: remudero
  type: implement
  depends_on: [A]
  status: queued
  note: "b's rationale"
- id: C
  title: c
  repo: remudero
  type: implement
  depends_on: [B]
  status: queued
- id: D
  title: d
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: H
  title: human-only
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "drain-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const NONE_MERGED: MergedSet = () => false;
function mergedSetOf(...ids: string[]): MergedSet {
  const s = new Set(ids);
  return (id) => s.has(id);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });
const blockedResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: false, costUsd: 0.3, verdict: "blocked_review", prUrl: "https://github.com/o/r/pull/9" });

// ── next-runnable = the DAG logic (reuses unmetDependencies) ────────────────

test("nextRunnable: first in file order whose deps are merged; skips verify:human and merged", () => {
  const plan = fixturePlan();
  // Nothing merged: A and D are runnable; A wins (file order). H (human) is skipped.
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
  // A merged: B and D runnable; B wins (file order before D).
  assert.equal(nextRunnable(plan, mergedSetOf("A"))?.id, "B");
  // A,B,C,D merged: only H left, and it is verify:human ⇒ nothing runnable.
  assert.equal(nextRunnable(plan, mergedSetOf("A", "B", "C", "D")), undefined);
});

// ── W1-T76 (absorbs P21): creditability is LOAD-BEARING for the whole DAG,
// not just anti-orphan. The fix rung amends the SAME run-<taskId>-<epochMs>
// branch this run opened; once THAT branch merges, deriveStatus credits the
// task exactly as an unfixed merge would, and nextRunnable naturally unblocks
// its dependent — composing status.ts's existing ownership-assert with
// drain.ts's existing DAG walk, no new production code required.
test("W1-T76: once the fix rung's SAME-branch amendment merges, deriveStatus credits the fixed task AND nextRunnable unblocks its dependent", () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const runId = "A-1730000000000"; // this run's OWN branch — never a fix/* head
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: (taskId) => (taskId === "A" ? { number: 50, url: "u/50", state: "MERGED" } : null),
    headRefName: (prUrl) => (prUrl === "u/50" ? `run-${runId}` : undefined),
    prBody: (prUrl) => (prUrl === "u/50" ? "Remudero-Task: A\n" : undefined),
  };
  const dir = mkdtempSync(join(tmpdir(), "rmd-drain-fixrung-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const isMerged: MergedSet = (taskId) => {
    const t = plan.tasks.find((x) => x.id === taskId);
    return t ? deriveStatus(t, { ledgerPath, github }).merged : false;
  };

  assert.equal(isMerged("A"), true, "the fixed task's SAME-branch merge is credited (source: trailer)");
  const next = nextRunnable(plan, isMerged);
  assert.equal(next?.id, "B", "A's dependent (B) is now runnable — the fix rung's merge unblocked it");
  assert.notEqual(next?.id, "A", "the already-merged/fixed task itself is EXCLUDED from runnable");
});

// ── W1-T80: dispatch dedup — an OPEN PR means IN-FLIGHT, never runnable ─────
// (the #143/#145 duplicate-build race: rmd review posted success on #143, the
// drain started seconds later — merging is async, so the task looked
// not-merged and a fresh worker rebuilt it end-to-end as #145, orphaning the
// reviewed-green #143).

test("W1-T80 canonical race fixture: a task whose latest PR is OPEN is excluded from nextRunnable, with a legible skip naming the PR", () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 143 : undefined);
  const skips: Array<{ id: string; prNumber: number }> = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isOpenPr,
    onSkip: (t, prNumber) => skips.push({ id: t.id, prNumber }),
  });
  // A is IN-FLIGHT (open PR #143) — excluded, never re-dispatched as a duplicate build.
  assert.deepEqual(skips, [{ id: "A", prNumber: 143 }]);
  // D is the next runnable candidate in file order once A is skipped (B/C still
  // depend on the un-merged A).
  assert.equal(next?.id, "D");
});

test("W1-T80: a CLOSED (unmerged) PR does NOT block — an abandoned/superseded attempt leaves the task runnable", () => {
  const plan = fixturePlan();
  // A's latest PR is CLOSED (not open) — isOpenPr correctly reports "not open".
  const isOpenPr: OpenPrCheck = () => undefined;
  const next = nextRunnable(plan, NONE_MERGED, { isOpenPr, onSkip: () => assert.fail("no skip expected") });
  assert.equal(next?.id, "A", "a closed-unmerged PR leaves the task runnable — re-runs stay possible");
});

test("W1-T80: merged and correction-credited tasks are excluded exactly as today, isOpenPr never even consulted for them", () => {
  const plan = fixturePlan();
  const consulted: string[] = [];
  const isOpenPr: OpenPrCheck = (id) => {
    consulted.push(id);
    return undefined;
  };
  const next = nextRunnable(plan, mergedSetOf("A"), { isOpenPr });
  assert.equal(next?.id, "B");
  assert.ok(!consulted.includes("A"), "an already-merged task is filtered out before isOpenPr is ever asked");
});

test("W1-T80: no isOpenPr wired at all ⇒ nextRunnable behaves exactly as before this guard existed", () => {
  const plan = fixturePlan();
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
  assert.equal(nextRunnable(plan, mergedSetOf("A"))?.id, "B");
});

test("W1-T80 runDrain integration: the #143 state is skipped with a dispatch.skipped ledger line (task + PR number), and the drain proceeds to the next runnable task instead of halting", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      // A's most recent PR (#143) is OPEN — reviewed-green but not yet merged
      // (merge is async). It must never be re-dispatched as a fresh build.
      isOpenPr: (id) => (id === "A" ? 143 : undefined),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.ok(!ran.includes("A"), "A (in-flight under open PR #143) was never re-dispatched as a duplicate build");
  // D is the only other runnable candidate (B/C depend on the still-open A).
  assert.deepEqual(ran, ["D"]);
  assert.equal(s.stopReason, "max_reached");
  const skipLine = lines.find((l) => l.step === "dispatch.skipped");
  assert.ok(skipLine, "a dispatch.skipped ledger line was emitted");
  assert.equal(skipLine?.extra.task, "A");
  assert.equal(skipLine?.extra.pr_number, 143);
  assert.equal(skipLine?.extra.reason, "open-pr");
});

test("plannedSequence (--dry-run order): simulates merges forward, honouring deps + --max + --until", () => {
  const plan = fixturePlan();
  assert.deepEqual(plannedSequence(plan, NONE_MERGED), ["A", "B", "C", "D"]);
  assert.deepEqual(plannedSequence(plan, NONE_MERGED, { max: 2 }), ["A", "B"]);
  assert.deepEqual(plannedSequence(plan, NONE_MERGED, { until: "B" }), ["A", "B"]);
  // --until already satisfied ⇒ empty.
  assert.deepEqual(plannedSequence(plan, mergedSetOf("A", "B"), { until: "B" }), []);
});

// ── the loop: stop-on-block, --max, headroom, until, no-runnable ────────────

test("stop-on-block: a blocked task HALTS the drain and does NOT run its dependents", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        ran.push(id);
        // A merges; B blocks; C (B's dependent) must NEVER run.
        if (id === "B") return blockedResult(id);
        merged.add(id);
        return okResult(id);
      },
    },
  );
  assert.equal(s.stopReason, "blocked");
  assert.match(s.stopDetail ?? "", /B → blocked_review/);
  assert.deepEqual(s.merged, ["A"]);
  assert.deepEqual(ran, ["A", "B"]); // C was NOT attempted
  assert.ok(!ran.includes("C"), "the blocked task's dependent must not run");
  assert.match(s.resumeCommand, /^rmd drain/);
});

test("--max N halts after N successful tasks", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
    },
    { max: 2 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A", "B"]);
  assert.equal(s.attempted.length, 2);
});

test("headroom: a near-limit reading STOPS with reason=headroom_exhausted BEFORE spawning", async () => {
  const plan = fixturePlan();
  const nearLimit: UsageSnapshot = {
    billingMode: "subscription",
    session: { percentUsed: 42, resetsAt: "3pm" },
    weekly: [{ label: "all models", percentUsed: 98, resetsAt: "Monday" }],
  };
  let spawned = 0;
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      readUsage: () => nearLimit,
    },
  );
  assert.equal(s.stopReason, "headroom_exhausted");
  assert.match(s.stopDetail ?? "", /weekly \(all models\) at 98% — resets Monday/);
  assert.equal(spawned, 0, "no task is spawned when a window is at/near its limit");
});

test("headroom unreadable (undefined) does NOT halt — best-effort, the drain continues", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => undefined,
    },
    { max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A"]);
});

test("--until: drains until the target merges, then stops", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
    },
    { until: "B", max: 10 },
  );
  assert.equal(s.stopReason, "until_reached");
  assert.deepEqual(s.merged, ["A", "B"]); // C, D not run
});

test("no_runnable: an empty/blocked-out plan stops cleanly", async () => {
  const plan = fixturePlan();
  const s = await runDrain(
    plan,
    { refreshMerged: () => mergedSetOf("A", "B", "C", "D"), runOne: async (id) => okResult(id) },
  );
  assert.equal(s.stopReason, "no_runnable"); // only H left (verify:human)
  assert.deepEqual(s.attempted, []);
});

// ── fleet control (W1-T11): STOP / Pause (drain-and-hold) / Resume ─────────

test("PAUSE (drain-and-hold): issued mid-run, the in-flight task still reaches merged; no new spawn follows", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "fleet-pause-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        // Simulate an operator pausing WHILE task A is in flight — the flag
        // appears mid-run, before A resolves.
        if (id === "A") requestPause(root, "quiet hours");
        merged.add(id);
        return okResult(id);
      },
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
  );
  assert.equal(s.stopReason, "paused");
  // A was in flight when pause was requested — it still reaches merged (drain-and-hold).
  assert.deepEqual(s.merged, ["A"]);
  assert.deepEqual(s.attempted, ["A"]); // B (A's dependent) never spawns
  assert.ok(lines.some((l) => l.step === "drain.pause"), "a drain.pause ledger line was emitted");
});

test("STOP: kills within one tick — ledger stop line + no subsequent spawns", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "fleet-stop-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        ran.push(id);
        requestStop(root, "operator hard-stop");
        merged.add(id);
        return okResult(id);
      },
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
  );
  assert.equal(s.stopReason, "stopped");
  assert.deepEqual(ran, ["A"]); // STOP is checked at the very next tick — no B/C/D spawn
  assert.ok(
    lines.some((l) => l.step === "drain.stop" && /operator hard-stop/.test(String(l.extra.detail))),
    "a drain.stop ledger line, carrying the reason, was emitted",
  );
});

test("STOP set BEFORE a drain even starts: zero tasks attempted (a fresh drain also refuses to spawn)", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "fleet-stop-pre-"));
  requestStop(root, "pre-armed");
  let spawned = 0;
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
    },
  );
  assert.equal(s.stopReason, "stopped");
  assert.equal(spawned, 0);
  assert.deepEqual(s.attempted, []);
});

test("STOP takes precedence over PAUSE when both flags are set", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "fleet-both-"));
  requestPause(root, "b");
  requestStop(root, "a");
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => okResult(id),
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
    },
  );
  assert.equal(s.stopReason, "stopped");
});

// ── W1-T140: drain preview + curation panel ─────────────────────────────────

test("buildDrainPreview: renders plannedSequence's order as task cards, each carrying id/title/description + direct dependency edges both ways", () => {
  const plan = fixturePlan(); // A -> B -> C (chain, B carries a note), D independent, H human-only
  const cards = buildDrainPreview(plan, NONE_MERGED);

  assert.deepEqual(cards.map((c) => c.id), plannedSequence(plan, NONE_MERGED), "card order equals plannedSequence's order exactly");

  const [a, b, c, d] = cards;
  assert.equal(a.title, "a");
  assert.equal(a.description, "", "no note on A -> empty description, never undefined");
  assert.deepEqual(a.dependsOn, [], "A has no incoming edges");
  assert.deepEqual(a.dependents, [{ id: "B", title: "b" }], "A's only direct dependent is B");

  assert.equal(b.description, "b's rationale", "B's note surfaces as its card description");
  assert.deepEqual(b.dependsOn, [{ id: "A", title: "a" }]);
  assert.deepEqual(b.dependents, [{ id: "C", title: "c" }]);

  assert.deepEqual(c.dependsOn, [{ id: "B", title: "b" }]);
  assert.deepEqual(c.dependents, [], "nothing in the plan depends on C");

  assert.deepEqual(d.dependsOn, [], "D is independent");
  assert.deepEqual(d.dependents, [], "nothing depends on D either");
});

test("buildDrainPreview: honors --max/--until exactly like plannedSequence (it IS plannedSequence, resolved to cards)", () => {
  const plan = fixturePlan();
  assert.deepEqual(buildDrainPreview(plan, NONE_MERGED, { max: 2 }).map((c) => c.id), ["A", "B"]);
  assert.deepEqual(buildDrainPreview(plan, NONE_MERGED, { until: "B" }).map((c) => c.id), ["A", "B"]);
  assert.deepEqual(buildDrainPreview(plan, mergedSetOf("A", "B"), { until: "B" }), [], "--until already satisfied -> no cards");
});

// A dedicated 3-node chain (A -> B -> C, no independent siblings) so the curated-
// selection tests below match the acceptance bar's own language exactly: "natural
// order is [A, B, C]".
const CHAIN_ABC = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: b
  repo: remudero
  type: implement
  depends_on: [A]
  status: queued
- id: C
  title: c
  repo: remudero
  type: implement
  depends_on: [B]
  status: queued
`;

function chainAbcPlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "drain-curated-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, CHAIN_ABC);
  return loadPlan(f);
}

test("curated selection: [B, A] (depth 2) drives runOne to fire for exactly B then A, in that order — the natural order (A, B, C) is overridden entirely", async () => {
  const plan = chainAbcPlan();
  assert.deepEqual(plannedSequence(plan, NONE_MERGED), ["A", "B", "C"], "sanity: the natural order is A, B, C");

  const selection: CuratedSelection = { taskIds: ["B", "A"], depth: 2 };
  const opts = applyCuratedSelection({}, selection);
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => {
        ran.push(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" };
      },
    },
    opts,
  );
  assert.deepEqual(ran, ["B", "A"], "runOne fired for exactly B then A, in the curated order");
  assert.equal(s.stopReason, "max_reached");
});

test("curated selection: unselected tasks are never dispatched — no runOne call, no ledger line, and the summary's attempted excludes them", async () => {
  const plan = chainAbcPlan();
  const selection: CuratedSelection = { taskIds: ["B", "A"], depth: 2 };
  const opts = applyCuratedSelection({}, selection);
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => {
        ran.push(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" };
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    opts,
  );
  assert.ok(!ran.includes("C"), "C was never passed to runOne — the falsifier: pre-fix drain ran the full plannedSequence, ignoring the selection");
  assert.ok(!s.attempted.includes("C"), "the drain summary's attempted excludes the unselected task");
  assert.ok(!lines.some((l) => l.extra.task === "C" || l.extra.id === "C"), "no ledger line names the unselected task");
  assert.deepEqual(s.attempted, ["B", "A"]);
});

test("curated selection: an id already merged or in-flight (open PR) is skipped, never re-dispatched, without derailing the rest of the curated order", async () => {
  const plan = chainAbcPlan();
  const selection: CuratedSelection = { taskIds: ["A", "B", "C"], depth: 3 };
  const opts = applyCuratedSelection({}, selection);
  const ran: string[] = [];
  const skips: Array<{ id: string; prNumber: number }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => mergedSetOf("A"), // A already landed before this drain started
      isOpenPr: (id) => (id === "B" ? 77 : undefined), // B is in-flight under an open PR
      runOne: async (id) => {
        ran.push(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" };
      },
      log: (step, extra = {}) => {
        if (step === "dispatch.skipped") skips.push({ id: String(extra.task), prNumber: Number(extra.pr_number) });
      },
    },
    opts,
  );
  assert.deepEqual(ran, ["C"], "A is already merged (skipped) and B is in-flight (skipped) — only C actually dispatches");
  // The loop re-evaluates the curated list fresh every tick (same as the natural
  // path), so a still-open B is re-logged on each subsequent tick until the drain
  // concludes — assert every logged skip names B's open PR, never A or C.
  assert.ok(skips.length >= 1, "B's in-flight skip is legible on the ledger, same shape as the natural path's W1-T80 guard");
  assert.ok(skips.every((s) => s.id === "B" && s.prNumber === 77), "every skip logged names B's open PR #77 — never A or C");
});

test("applyCuratedSelection: truncates to depth and caps max to the same bound, regardless of a larger caller-supplied max", () => {
  const opts = applyCuratedSelection({ max: 10, until: "C" }, { taskIds: ["B", "A", "D"], depth: 2 });
  assert.deepEqual(opts.curated, ["B", "A"]);
  assert.equal(opts.max, 2);
  assert.equal(opts.until, "C", "unrelated opts fields pass through untouched");
});

test("renderSummary + resumeCommand: 'what happened while away' is reconstructable", () => {
  const line = renderSummary({
    attempted: ["A", "B"], merged: ["A"], stopReason: "blocked",
    stopDetail: "B → blocked_review", costUsd: 0.8, resumeCommand: resumeCommand({ until: "C" }),
  });
  assert.match(line, /attempted : A, B/);
  assert.match(line, /merged    : A/);
  assert.match(line, /stopped   : blocked — B → blocked_review/);
  assert.match(line, /resume    : rmd drain --until C/);
});
