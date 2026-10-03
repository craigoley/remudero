/**
 * test/the-frontier-panel-names-every-filter-reason.test.ts — W1-T5410.
 *
 * `frontierFilterReason` (src/lib/panel-graph.ts) returned early for four reasons and then treated
 * EVERY other `DispatchFilterReason` as unmet dependencies, so a retired, foreign-repo or
 * operator-build task rendered "blocked on unmet dependencies: (none resolved)". The fix is an
 * exhaustive switch; these tests pin that each reason names itself and that ONLY "unmet-deps"
 * renders the dependency sentence — while a genuinely dependency-held task still does.
 *
 * The function is read off the module NAMESPACE so this file loads at a base that does not export
 * it, and each test fails on its own there rather than the whole file failing to import.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as panelGraph from "../src/lib/panel-graph.js";
import type { DispatchFilterReason, MergedSet } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";

type FrontierFilterReason = (
  plan: Plan,
  task: Task,
  reason: DispatchFilterReason,
  isMerged: MergedSet,
) => { kind: string; reason: string } | undefined;

function frontierFilterReason(): FrontierFilterReason {
  const fn = (panelGraph as Record<string, unknown>)["frontierFilterReason"];
  assert.equal(typeof fn, "function", "panel-graph.ts exports frontierFilterReason");
  return fn as FrontierFilterReason;
}

/** The union's arms read from source, the technique test/status-board.test.ts uses for this union. */
function dispatchFilterReasonArms(): DispatchFilterReason[] {
  const drain = readFileSync(new URL("../src/lib/drain.ts", import.meta.url), "utf8");
  const decl = drain.slice(drain.indexOf("export type DispatchFilterReason ="));
  const body = decl.slice(0, decl.indexOf(";"));
  return [...body.matchAll(/\|\s*"([a-z-]+)"/g)].map((m) => m[1]! as DispatchFilterReason);
}

function task(id: string, extra: Partial<Task> = {}): Task {
  return { id, title: `title of ${id}`, repo: "remudero", status: "queued", verify: "auto", depends_on: [], files: [`src/${id}.ts`], ...extra } as unknown as Task;
}

function planOf(...tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan;
}

const DEPENDENCY_SENTENCE = /unmet dependenc/;
const NO_ROW: ReadonlySet<string> = new Set(["already-merged", "verify-not-auto", "credit-indeterminate"]);
const nothingMerged: MergedSet = () => false;

test("W1-T5410: every dispatch filter reason renders its own frontier text, and only unmet-deps renders the dependency sentence", () => {
  const map = frontierFilterReason();
  const arms = dispatchFilterReasonArms();
  assert.ok(arms.length >= 11, `sanity: the union was read from source (${arms.length} arms)`);
  const dep = task("W1-T-DEP");
  const subject = task("W1-T-SUBJ", { depends_on: ["W1-T-DEP"], retirement: "withdrawn", repo: "elsewhere", files: [".github/workflows/ci.yml"] } as Partial<Task>);
  const plan = planOf(dep, subject);

  const texts = new Map<string, string>();
  for (const reason of arms) {
    const r = map(plan, subject, reason, nothingMerged);
    if (NO_ROW.has(reason)) {
      assert.equal(r, undefined, `'${reason}' is skipped, never rendered as a held row`);
      continue;
    }
    assert.ok(r, `'${reason}' renders a row of its own`);
    assert.ok(r.reason.length > 0, `'${reason}' carries reason text`);
    if (reason === "unmet-deps") {
      assert.equal(r.kind, "unmet-dependency");
      assert.match(r.reason, DEPENDENCY_SENTENCE);
    } else {
      assert.notEqual(r.kind, "unmet-dependency", `'${reason}' must not be classified as an unmet dependency`);
      assert.doesNotMatch(r.reason, DEPENDENCY_SENTENCE, `'${reason}' must not inherit the dependency sentence`);
    }
    texts.set(reason, r.reason);
  }
  assert.equal(new Set(texts.values()).size, texts.size, "each reason renders its OWN text — no shared fallback string");
});

test("W1-T5410: retired, foreign-repo and operator-build each name the fact that classified them", () => {
  const map = frontierFilterReason();
  const t = task("W1-T-X", { retirement: "withdrawn", repo: "someone-else/other", files: [".github/workflows/deploy.yml", "src/a.ts"] } as Partial<Task>);
  const plan = planOf(t);
  assert.match(map(plan, t, "retired", nothingMerged)!.reason, /^retired \(withdrawn\) — .*never be built/);
  assert.match(map(plan, t, "foreign-repo", nothingMerged)!.reason, /targets repo someone-else\/other/);
  const op = map(plan, t, "operator-build", nothingMerged)!.reason;
  assert.match(op, /\.github\/workflows\/deploy\.yml/, "names the workflow path an operator must hand-build");
  assert.doesNotMatch(op, /src\/a\.ts/, "names only the workflow paths, not every file");
});

test("W1-T5410: a blocked task keeps its existing text byte-identically, with and without a note", () => {
  const map = frontierFilterReason();
  const noted = task("W1-T-N", { status: "blocked", note: "waiting on ops" } as Partial<Task>);
  const bare = task("W1-T-B", { status: "blocked" } as Partial<Task>);
  const plan = planOf(noted, bare);
  assert.deepEqual(map(plan, noted, "blocked", nothingMerged), { kind: "blocked", reason: "blocked — waiting on ops" });
  assert.deepEqual(map(plan, bare, "blocked", nothingMerged), { kind: "blocked", reason: "W1-T-B's own status is blocked" });
});

test("W1-T5410: a reason outside the union is refused loudly, never rendered as a dependency hold", () => {
  const map = frontierFilterReason();
  const t = task("W1-T-Z");
  assert.throws(() => map(planOf(t), t, "not-a-reason" as DispatchFilterReason, nothingMerged), /unhandled dispatch filter reason not-a-reason/);
});

test("W1-T5410: through buildPlanFrontier, a retired and an operator-build task render their own reason while a dependency-held task still names its dependency", () => {
  const dep = task("W1-T-DEP");
  const held = task("W1-T-HELD", { depends_on: ["W1-T-DEP"] } as Partial<Task>);
  const retired = task("W1-T-RET", { status: "blocked", retirement: "withdrawn" } as Partial<Task>);
  const opBuild = task("W1-T-OPS", { files: [".github/workflows/ci.yml"] } as Partial<Task>);
  const plan = planOf(dep, held, retired, opBuild);
  const rows = panelGraph.buildPlanFrontier(plan, nothingMerged, plan.tasks.length, []);
  const byId = new Map(rows.map((r) => [r.id, r]));

  assert.equal(byId.get("W1-T-DEP")?.runnable, true, "the dependency itself is runnable");
  const heldRow = byId.get("W1-T-HELD");
  assert.equal(heldRow?.reasonKind, "unmet-dependency");
  assert.equal(heldRow?.reason, "blocked on unmet dependency: W1-T-DEP", "the population was SPLIT, not both relabelled");

  for (const id of ["W1-T-RET", "W1-T-OPS"]) {
    const row = byId.get(id);
    assert.ok(row, `${id} renders as held`);
    assert.equal(row.runnable, false);
    assert.notEqual(row.reasonKind, "unmet-dependency", `${id} has no dependency to wait on`);
    assert.doesNotMatch(row.reason, DEPENDENCY_SENTENCE);
  }
  assert.match(byId.get("W1-T-RET")!.reason, /^retired \(withdrawn\)/);
  assert.match(byId.get("W1-T-OPS")!.reason, /\.github\/workflows\/ci\.yml/);
});
