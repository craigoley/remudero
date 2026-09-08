// test/the-retro-emits-closure-by-class-and-guard-fire-counts.test.ts — W1-T3074: the two tables a
// fleet operator acts on. Closure by task class (filed, merged, open, a merge rate refused below
// the population floor with its denominator stated, cost per merge, last merge) and guard fire
// counts since the marker, ZERO ROWS INCLUDED, with the zero-streak the marker carries forward.
//
// The falsifier the shard names: with the population seed removed from `guardFireCounts`, the
// three-guard mapping below lists ONE guard (the one that fired) instead of three.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { configPath } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  CLOSURE_POPULATION_FLOOR,
  GUARD_RETIREMENT_ZERO_STREAK,
  closureByClass,
  guardFireCounts,
  guardFiredBy,
  guardNameOfVerdict,
  guardPopulation,
  guardZeroStreakRecord,
  mergeRateCell,
  renderClosureByClass,
  renderGuardFireCounts,
  type ClosureRun,
} from "../src/lib/retro-closure.js";
import {
  GUARD_REASON_FALLBACK_ROWS,
  buildGather,
  parseMastMapping,
  renderGather,
  resolveGuardCheck,
  type RetroMarker,
} from "../src/lib/retro.js";
import { retroCommand } from "../src/run-task.js";
import { offlineGithub } from "./setup/offline-github.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function ts(day: number): string {
  return `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
}

function run(over: Partial<ClosureRun> & { runId: string }): ClosureRun {
  return { taskId: `T-${over.runId}`, startTs: ts(1), verdict: "merged", costUsd: 1, ...over };
}

// ── closure by task class ──────────────────────────────────────────────────

const CLOSURE_RUNS: ClosureRun[] = [
  run({ runId: "d1", taskClass: "docs", startTs: ts(2), costUsd: 1 }),
  run({ runId: "d2", taskClass: "docs", startTs: ts(4), costUsd: 3 }),
  run({ runId: "s1", taskClass: "src", startTs: ts(3), costUsd: 5 }),
  run({ runId: "s2", taskClass: "src", startTs: ts(5), verdict: "blocked_ci", costUsd: 2 }),
  run({ runId: "old", taskClass: "src", startTs: ts(1), costUsd: 100 }),
];
const CLOSURE_SHIPPED = [
  { runId: "d1", taskId: "T-d1" },
  { runId: "d2", taskId: "T-d2" },
  { runId: "s1", taskId: "T-s1" },
];

test("closureByClass: the merge rate is REFUSED below the population floor and the denominator is stated either way", () => {
  const rows = closureByClass(CLOSURE_RUNS, CLOSURE_SHIPPED, ["docs", "src", "src", "src", "src", "plan-lint"], ts(1));
  assert.deepEqual(
    rows.map((r) => r.taskClass),
    ["docs", "plan-lint", "src"],
    "one row per class seen in runs, credited, or listed open — sorted",
  );
  const docs = rows.find((r) => r.taskClass === "docs")!;
  assert.equal(docs.merged, 2);
  assert.equal(docs.open, 1);
  assert.equal(docs.filed, "not supplied", "no filing dates were given, so filed says so rather than reading 0");
  assert.deepEqual(docs.mergeRate, { kind: "refused", merged: 2, denominator: 3, floor: CLOSURE_POPULATION_FLOOR });
  assert.equal(CLOSURE_POPULATION_FLOOR, 5, "P48's floor");
  assert.match(mergeRateCell(docs.mergeRate), /REFUSED \(population 3 below floor 5, P48\)/);

  const src = rows.find((r) => r.taskClass === "src")!;
  assert.equal(src.merged, 1);
  assert.equal(src.open, 4);
  assert.deepEqual(src.mergeRate, { kind: "rate", value: 0.2, merged: 1, denominator: 5 }, "at the floor the rate is stated over its denominator");
  assert.equal(mergeRateCell(src.mergeRate), "0.2 (1 of 5)");
  assert.equal(src.costPerMerge, 7, "every in-window src run's cost (5 + 2), refused runs included, over 1 merge; the pre-window run is excluded");
  assert.equal(src.lastMergeTs, ts(3));
  assert.equal(docs.lastMergeTs, ts(4), "the newest credited run's start ts");

  const planLint = rows.find((r) => r.taskClass === "plan-lint")!;
  assert.equal(planLint.merged, 0);
  assert.equal(planLint.costPerMerge, null, "zero merges never reads as a $0 cost per merge");
  assert.equal(planLint.lastMergeTs, undefined);
});

test("closureByClass: supplied filing dates become the denominator, windowed by sinceTs; a credit with no run groups under unknown", () => {
  const filings = [
    { taskClass: "docs", filedTs: ts(2) },
    { taskClass: "docs", filedTs: ts(3) },
    { taskClass: "docs", filedTs: ts(4) },
    { taskClass: "docs", filedTs: ts(5) },
    { taskClass: "docs", filedTs: ts(6) },
    { taskClass: "docs", filedTs: ts(1) },
    { taskClass: "gates", filedTs: ts(6) },
  ];
  const rows = closureByClass(CLOSURE_RUNS, [...CLOSURE_SHIPPED, { runId: "ghost", taskId: "T-ghost" }], [], ts(1), filings);
  const docs = rows.find((r) => r.taskClass === "docs")!;
  assert.equal(docs.filed, 5, "the ts(1) filing sits at the marker and is out of the window");
  assert.deepEqual(docs.mergeRate, { kind: "rate", value: 0.4, merged: 2, denominator: 5 });
  const gates = rows.find((r) => r.taskClass === "gates")!;
  assert.equal(gates.filed, 1);
  assert.equal(gates.mergeRate.kind, "refused", "a class that is only filed still gets a row, refused at population 1");
  const unknown = rows.find((r) => r.taskClass === "unknown")!;
  assert.equal(unknown.merged, 1, "a shipped credit whose run is not in the corpus is counted, never dropped");
  assert.equal(unknown.lastMergeTs, undefined);
  assert.deepEqual(closureByClass([], [], [], undefined), []);
});

test("renderClosureByClass: a markdown table under the heading, with the refusal text in the cell", () => {
  const rows = closureByClass(CLOSURE_RUNS, CLOSURE_SHIPPED, ["docs"], ts(1));
  const md = renderClosureByClass(rows);
  assert.ok(md.startsWith("## Closure by task class\n"));
  assert.match(md, /\| class \| filed \| merged \| open \| merge rate \| cost per merge \| last merge \|/);
  assert.match(md, /\| docs \| not supplied \| 2 \| 1 \| REFUSED \(population 3 below floor 5, P48\) \| \$2\.000 \| 2026-09-04T00:00:00\.000Z \|/);
  assert.match(renderClosureByClass([]), /^## Closure by task class\n\nNo task class observed/);
});

// ── guard fire counts ──────────────────────────────────────────────────────

const THREE_GUARD_MAPPING = parseMastMapping(`
rows:
  - verdict: blocked_isolation
    mast_mode: "N/A"
    category: infrastructure
  - verdict: blocked_containment
    mast_mode: "N/A"
    category: infrastructure
  - verdict: blocked_sandbox
    mast_mode: "N/A"
    category: infrastructure
  - verdict: blocked_budget
    mast_mode: "FM-1.5"
    category: specification
`);

const ONE_FIRE_LEDGER: ClosureRun[] = [
  run({ runId: "g1", taskClass: "src", startTs: ts(2), verdict: "blocked_isolation", guard: "isolation", check: "inherited-functions" }),
  run({ runId: "m1", taskClass: "src", startTs: ts(2), verdict: "merged" }),
  run({ runId: "b1", taskClass: "src", startTs: ts(2), verdict: "blocked_budget" }),
];

test("guardFireCounts: a guard named by the mapping that fired zero times since the marker is listed at zero rather than omitted", () => {
  const rows = guardFireCounts(ONE_FIRE_LEDGER, THREE_GUARD_MAPPING, ts(1));
  assert.deepEqual(
    rows.map((r) => [r.guard, r.count]),
    [
      ["containment", 0],
      ["isolation", 1],
      ["sandbox", 0],
    ],
    "three guards named, one fired: THREE rows, two of them zero (the falsifier lists one)",
  );
  assert.equal(rows.length, 3);
  const iso = rows.find((r) => r.guard === "isolation")!;
  assert.deepEqual(iso.checks, ["inherited-functions"]);
  assert.deepEqual(iso.taskIds, ["T-g1"]);
  assert.equal(iso.zeroStreak, 0);
  const sandbox = rows.find((r) => r.guard === "sandbox")!;
  assert.deepEqual(sandbox.checks, []);
  assert.equal(sandbox.zeroStreak, 1, "a zero this cycle with no prior streak reads 1 marker at zero");
  assert.equal(sandbox.retirementCandidate, false);
  assert.equal(guardNameOfVerdict("blocked_sandbox"), "sandbox");
  assert.equal(guardNameOfVerdict("preflight_refused"), "preflight_refused", "no prefix, no stripping");
});

test("guardFireCounts: the fallback table names guards too, prose-only and verdict-only lines count, and the resolver agrees with resolveGuardCheck", () => {
  assert.deepEqual(guardPopulation({ rows: [] }, GUARD_REASON_FALLBACK_ROWS), ["containment", "isolation"], "the fallback table alone names the two shipped guards");
  const real = parseMastMapping(readFileSync(join(REPO_ROOT, "plan", "mast-mapping.yaml"), "utf8"));
  assert.deepEqual(guardPopulation(real, GUARD_REASON_FALLBACK_ROWS), ["containment", "isolation"], "the real mapping's infrastructure rows name the same two");

  const prose = run({ runId: "p1", startTs: ts(2), verdict: "blocked_isolation", reason: "isolation_preflight_failed: inherited functions" });
  const bare = run({ runId: "v1", startTs: ts(2), verdict: "blocked_containment" });
  const structured = run({ runId: "s1", startTs: ts(2), verdict: "blocked_containment", guard: "containment", check: "outside-cwd-denial" });
  const notAGuard = run({ runId: "n1", startTs: ts(2), verdict: "blocked_budget" });
  const rows = guardFireCounts([prose, bare, structured, notAGuard], real, ts(1), { fallbackRows: GUARD_REASON_FALLBACK_ROWS });
  assert.deepEqual(
    rows.map((r) => [r.guard, r.count, r.checks]),
    [
      ["containment", 2, ["outside-cwd-denial", "unknown"]],
      ["isolation", 1, ["inherited-functions"]],
    ],
  );
  for (const r of [prose, structured]) {
    const theirs = resolveGuardCheck(r);
    assert.ok(theirs, "resolveGuardCheck resolves both of these");
    assert.deepEqual(guardFiredBy(r, real, GUARD_REASON_FALLBACK_ROWS), theirs, "where retro.ts resolves a guard, this module resolves the same one");
  }
  assert.equal(resolveGuardCheck(bare), undefined, "retro.ts cannot name a bare verdict's guard");
  assert.deepEqual(guardFiredBy(bare, real, GUARD_REASON_FALLBACK_ROWS), { guard: "containment", check: "unknown" }, "this module names it off the infrastructure row");
  assert.equal(guardFiredBy(notAGuard, real, GUARD_REASON_FALLBACK_ROWS), undefined);
  assert.equal(guardFireCounts([structured], real, ts(3), { fallbackRows: GUARD_REASON_FALLBACK_ROWS }).find((r) => r.guard === "containment")!.count, 0, "a fire at or before sinceTs is outside the window");
});

test("guardFireCounts: the zero-streak carries the prior marker's count forward and names a retirement candidate at the streak", () => {
  assert.equal(GUARD_RETIREMENT_ZERO_STREAK, 10);
  const rows = guardFireCounts(ONE_FIRE_LEDGER, THREE_GUARD_MAPPING, ts(1), { priorZeroStreak: { containment: 9, isolation: 4 } });
  const containment = rows.find((r) => r.guard === "containment")!;
  assert.equal(containment.zeroStreak, 10);
  assert.equal(containment.retirementCandidate, true);
  assert.equal(rows.find((r) => r.guard === "isolation")!.zeroStreak, 0, "a fire resets the streak");
  assert.equal(rows.find((r) => r.guard === "sandbox")!.zeroStreak, 1);
  assert.deepEqual(guardZeroStreakRecord(rows), { containment: 10, isolation: 0, sandbox: 1 }, "the record the next marker carries");
  const early = guardFireCounts(ONE_FIRE_LEDGER, THREE_GUARD_MAPPING, ts(1), { priorZeroStreak: { sandbox: 1 }, retirementStreak: 2 });
  assert.equal(early.find((r) => r.guard === "sandbox")!.retirementCandidate, true, "the streak is an option so a test never waits ten markers");
  const extra = guardFireCounts([run({ runId: "x", startTs: ts(2), verdict: "blocked_novel", guard: "novel", check: "probe" })], THREE_GUARD_MAPPING, ts(1));
  assert.ok(extra.some((r) => r.guard === "novel" && r.count === 1), "a guard a run named that the population did not is a row, never dropped");
  const md = renderGuardFireCounts(rows);
  assert.ok(md.startsWith("## Guard fire counts since marker\n"));
  assert.match(md, /\| containment \| 0 \| \(none\) \| \(none\) \| 10 \| candidate for retirement \(zero for 10 markers\): verify against the golden suite before removing \|/);
  assert.match(md, /\| isolation \| 1 \| inherited-functions \| T-g1 \| 0 \|  \|/);
  assert.match(renderGuardFireCounts([]), /No guard is named by the mapping or the fallback table\./);
});

// ── the gather, the render and the marker ──────────────────────────────────

const GATHER_LEDGER = [
  { ts: ts(2), run_id: "r1", task_id: "W1-T1", step: "run.start", type: "implement", task_class: "docs" },
  { ts: ts(2), run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 1.5, pr_url: "https://github.com/o/r/pull/1" },
  { ts: ts(3), run_id: "r2", task_id: "W1-T2", step: "run.start", type: "implement", task_class: "src" },
  { ts: ts(3), run_id: "r2", task_id: "W1-T2", step: "verdict", verdict: "blocked_isolation", guard: "isolation", check: "inherited-functions", cost_usd: 0.2 },
  { ts: ts(4), run_id: "r3", task_id: "W1-T3", step: "run.start", type: "implement", task_class: "src" },
  { ts: ts(4), run_id: "r3", task_id: "W1-T3", step: "verdict", verdict: "merged", cost_usd: 2, pr_url: "https://github.com/o/r/pull/3" },
]
  .map((l) => JSON.stringify(l))
  .join("\n");

test("renderGather prints both tables and the marker carries the guard zero-streak forward", () => {
  const g = buildGather({
    ledgerNdjson: GATHER_LEDGER,
    learningsMd: "# L\n",
    sinceTs: ts(1),
    mastMapping: THREE_GUARD_MAPPING,
    openTaskClasses: ["src", "src", "src", "src", "docs"],
    priorGuardZeroStreak: { containment: 2, sandbox: 9 },
  });
  assert.deepEqual(
    g.closureByClass.map((r) => [r.taskClass, r.merged, r.open, r.mergeRate.kind]),
    [
      ["docs", 1, 1, "refused"],
      ["src", 1, 4, "rate"],
    ],
    "the SHIPPED union credits the merges and the open classes fill the denominator",
  );
  assert.deepEqual(
    g.guardFireCounts.map((r) => [r.guard, r.count, r.zeroStreak, r.retirementCandidate]),
    [
      ["containment", 0, 3, false],
      ["isolation", 1, 0, false],
      ["sandbox", 0, 10, true],
    ],
    "the prior marker's streaks are carried into this cycle's rows",
  );
  const md = renderGather(g);
  const closureAt = md.indexOf("\n## Closure by task class\n");
  const guardsAt = md.indexOf("\n## Guard fire counts since marker\n");
  assert.ok(closureAt > 0, "the closure heading is printed");
  assert.ok(guardsAt > closureAt, "the guard heading is printed, after the closure table");
  assert.match(md, /\| src \| not supplied \| 1 \| 4 \| 0\.2 \(1 of 5\) \| \$2\.200 \| 2026-09-04T00:00:00\.000Z \|/);
  assert.match(md, /\| sandbox \| 0 \| \(none\) \| \(none\) \| 10 \| candidate for retirement/);

  const next: RetroMarker = { ts: ts(4), learnings_count: 0, runs_seen: 3, guard_zero_streak: guardZeroStreakRecord(g.guardFireCounts) };
  assert.deepEqual(next.guard_zero_streak, { containment: 3, isolation: 0, sandbox: 10 });
  const again = buildGather({ ledgerNdjson: "", learningsMd: "", sinceTs: ts(4), mastMapping: THREE_GUARD_MAPPING, priorGuardZeroStreak: next.guard_zero_streak });
  assert.deepEqual(guardZeroStreakRecord(again.guardFireCounts), { containment: 4, isolation: 1, sandbox: 11 }, "a quiet cycle advances every streak by one");
  assert.deepEqual(buildGather({ ledgerNdjson: "", learningsMd: "" }).guardFireCounts.map((r) => r.guard), [
    "containment",
    "isolation",
  ], "with no mapping the fallback table still names the two shipped guards");
});

test("retroCommand --dry-run prints the two operator tables and carries the prior guard streak into them", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-closure-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-closure-root-"));
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");
    writeFileSync(
      join(state, "ledger.ndjson"),
      [
        { ts: ts(2), run_id: "cmd-1", task_id: "W1-T-CMD1", step: "run.start", type: "implement", task_class: "retro-dry-run-fixture" },
        { ts: ts(3), run_id: "cmd-1", task_id: "W1-T-CMD1", step: "verdict", verdict: "blocked_isolation", guard: "isolation", check: "inherited-functions", cost_usd: 0.5 },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    writeFileSync(
      join(state, "last-retro.json"),
      JSON.stringify(
        {
          ts: ts(1),
          learnings_count: 0,
          runs_seen: 0,
          guard_zero_streak: { containment: 9 },
        } satisfies RetroMarker,
        null,
        2,
      ) + "\n",
    );

    const logSpy = t.mock.method(console, "log", () => {});
    const code = await withLiveWritesAllowed(() => retroCommand(["--dry-run"], { github: offlineGithub() }));
    assert.equal(code, 0);
    const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
    assert.match(printed, /## Closure by task class/);
    assert.match(printed, /\| retro-dry-run-fixture \| not supplied \| 0 \| 0 \| REFUSED \(population 0 below floor 5, P48\) \| n\/a \(0 merged\) \| \(none\) \|/);
    assert.match(printed, /## Guard fire counts since marker/);
    assert.match(printed, /\| containment \| 0 \| \(none\) \| \(none\) \| 10 \| candidate for retirement/);
    assert.match(printed, /\| isolation \| 1 \| inherited-functions \| W1-T-CMD1 \| 0 \|/);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
