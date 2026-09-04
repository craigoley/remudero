/**
 * test/a-merged-tasks-shard-still-reads-queued-so-the-fleet-rebuilds-it.test.ts — W1-T2675.
 *
 * THE FILED PREMISE WAS FALSE AND IS NOT WHAT THIS PINS. The shard read "nothing at dispatch
 * consults the credit projection". It does: `isDispatchEligible` (lib/drain.ts) opens with
 * `if (isMerged(t.id))` and refuses `already-merged` before any other probe, and a credited task
 * is already excluded today with no change. Measured against the real selector before any code
 * was written here, and again by "a definitively credited task is still refused" below.
 *
 * THE REAL DEFECT IS ONE STEP EARLIER, AT THE ADAPTER. `deriveStatus` (lib/status.ts) returns
 * `{ merged: false, source: "throttled", indeterminate: true }` when the GitHub credit read
 * genuinely FAILED rather than resolving to a clean "no evidence" — and `StatusProjection.
 * indeterminate`'s own doc is explicit about what a dispatch gate owes that value: "a caller that
 * gates dispatch or a ledger write off this projection MUST treat `indeterminate` as DO NOT ACT,
 * never as an ordinary queued task, because the evidence a 'not merged' conclusion would rest on
 * was never actually consulted."
 *
 * Every `MergedSet` adapter in the repo is spelled `projection.get(id)?.merged ?? false` — twelve
 * of them, including the two that feed dispatch (run-task.ts's drain and daemon lanes) — and none
 * consults `indeterminate`. So "we could not tell" collapses into "definitely not merged", the
 * task is admitted, a worker spawns, and the rebuild cannot pass review because the shard's
 * criteria describe a diff already on main. That is the #3512 lifecycle the shard measured; the
 * cause is this fail-open, not a missing check.
 *
 * THE FALSIFIER RUNS IN BOTH DIRECTIONS. A refusal that fires on every task is not a check, so an
 * ordinarily-uncredited task (`source: "none"`, no `indeterminate`) must still dispatch, and the
 * pre-existing `already-merged` refusal must keep its own distinct name.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  alreadyMergedCreditFromProjection,
  runnableCandidates,
  type AlreadyMergedCredit,
  type NextRunnableOpts,
} from "../src/lib/drain.js";
import { buildPlanFrontier } from "../src/lib/panel-graph.js";
import type { Plan, Task } from "../src/lib/plan.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function task(id: string): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    status: "queued",
    files: [`src/lib/${id}.ts`],
  } as unknown as Task;
}

/** The exact adapter shape every dispatch call site uses: `projection.get(id)?.merged ?? false`. */
function adapter(projection: Map<string, { merged?: boolean; indeterminate?: true }>) {
  return (id: string) => projection.get(id)?.merged ?? false;
}

function select(
  ids: string[],
  projection: Map<string, { merged?: boolean; indeterminate?: true }>,
  opts: NextRunnableOpts = {},
): { dispatched: string[]; filtered: Array<[string, string]> } {
  const filtered: Array<[string, string]> = [];
  const plan = { tasks: ids.map(task) } as unknown as Plan;
  const dispatched = runnableCandidates(plan, adapter(projection), ids.length, {
    ...opts,
    onFiltered: (t, reason) => filtered.push([t.id, reason]),
  }).map((t) => t.id);
  return { dispatched, filtered };
}

const INDETERMINATE = { merged: false, indeterminate: true } as const;

test("W1-T2675: an INDETERMINATE credit read is refused at dispatch, before any worker spawns", () => {
  const projection = new Map([["W1-T-SHIPPED", { ...INDETERMINATE }]]);
  const { dispatched, filtered } = select(["W1-T-SHIPPED"], projection, {
    isCreditIndeterminate: (id) => projection.get(id)?.indeterminate === true,
  });

  assert.deepEqual(dispatched, [], "a task whose credit could not be read must never be dispatched");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.[0], "W1-T-SHIPPED");
});

test("W1-T2675: the refusal is named apart from already-merged, so an operator can tell them apart", () => {
  const indeterminate = new Map([["W1-T-UNREADABLE", { ...INDETERMINATE }]]);
  const credited = new Map([["W1-T-CREDITED", { merged: true }]]);

  const a = select(["W1-T-UNREADABLE"], indeterminate, {
    isCreditIndeterminate: (id) => indeterminate.get(id)?.indeterminate === true,
  });
  const b = select(["W1-T-CREDITED"], credited);

  assert.equal(a.filtered[0]?.[1], "credit-indeterminate");
  assert.equal(b.filtered[0]?.[1], "already-merged");
  assert.notEqual(a.filtered[0]?.[1], b.filtered[0]?.[1], "the two refusals must not share one name");
});

test("W1-T2675: an ordinarily uncredited task still dispatches, so the check is not a blanket refusal", () => {
  const projection = new Map<string, { merged?: boolean; indeterminate?: true }>([
    ["W1-T-UNREADABLE", { ...INDETERMINATE }],
    ["W1-T-FRESH", { merged: false }],
  ]);
  const { dispatched } = select(["W1-T-UNREADABLE", "W1-T-FRESH"], projection, {
    isCreditIndeterminate: (id) => projection.get(id)?.indeterminate === true,
  });

  assert.deepEqual(dispatched, ["W1-T-FRESH"], "only the unreadable one is held back");
});

test("W1-T2675: a definitively credited task is still refused already-merged, unchanged", () => {
  const projection = new Map([["W1-T-CREDITED", { merged: true }]]);
  const { dispatched, filtered } = select(["W1-T-CREDITED"], projection, {
    isCreditIndeterminate: () => false,
  });

  assert.deepEqual(dispatched, []);
  assert.equal(filtered[0]?.[1], "already-merged", "the pre-existing refusal keeps its own name and order");
});

test("W1-T2675: omitting the probe preserves today's behaviour exactly", () => {
  const projection = new Map([["W1-T-UNREADABLE", { ...INDETERMINATE }]]);
  const { dispatched } = select(["W1-T-UNREADABLE"], projection);

  assert.deepEqual(
    dispatched,
    ["W1-T-UNREADABLE"],
    "a caller that cannot supply the probe has no indeterminate evidence to act on, so it must behave as before",
  );
});

test("W1-T2675: both dispatch lanes actually supply the probe — the seam is wired, not inert", () => {
  const runTask = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const drain = readFileSync(join(REPO_ROOT, "src", "lib", "drain.ts"), "utf8");
  const daemon = readFileSync(join(REPO_ROOT, "src", "lib", "daemon.ts"), "utf8");

  // run-task.ts derives it from the SAME `lastProj` snapshot `isOpenPr` reads, once per lane.
  const derivations = runTask.match(/const isCreditIndeterminate\b/g) ?? [];
  assert.equal(derivations.length, 2, "the drain lane and the daemon lane each derive the probe");

  // ...and each threads it through to the selector alongside `isOpenPr`.
  const threaded = (src: string) => (src.match(/isCreditIndeterminate: deps\.isCreditIndeterminate/g) ?? []).length;
  assert.equal(threaded(drain), 2, "drain.ts threads the probe at both selector sites");
  assert.equal(threaded(daemon), 1, "daemon.ts threads the probe at its selector site");
});

test("W1-T2675: the frontier SKIPS a credit-indeterminate task instead of calling it dependency-blocked", () => {
  // EXECUTED, not read off the source: without the arm this reason falls through
  // frontierFilterReason's trailing catch-all and renders as an unmet-dependency row whose own
  // list resolves to none — a sentence false in both halves, and the W1-T2636 shape on a new member.
  const plan = { tasks: [task("W1-T-UNREADABLE"), task("W1-T-FRESH")] } as unknown as Plan;
  const projection = new Map<string, { merged?: boolean; indeterminate?: true }>([
    ["W1-T-UNREADABLE", { merged: false, indeterminate: true }],
    ["W1-T-FRESH", { merged: false }],
  ]);
  const rows = buildPlanFrontier(plan, adapter(projection), plan.tasks.length, [], undefined, (id) =>
    projection.get(id)?.indeterminate === true);

  const unreadable = rows.find((r) => r.id === "W1-T-UNREADABLE");
  assert.equal(unreadable, undefined, "a task whose credit could not be read is skipped, never guessed at");

  const fresh = rows.find((r) => r.id === "W1-T-FRESH");
  assert.ok(fresh, "the ordinarily-uncredited task still renders");
  assert.equal(fresh?.runnable, true);

  for (const row of rows) {
    assert.notEqual(row.reasonKind, "unmet-dependency",
      "no row may be attributed to unmet dependencies — neither task has any");
  }
});

/** Captures {@link AlreadyMergedCredit} the way a real caller (a daemon log line, a ledger row)
 *  would: alongside the `already-merged` decline, never in place of it. */
function selectWithCredit(
  ids: string[],
  projection: Map<string, { merged?: boolean; source?: "trailer" | "head-branch" | "none"; prNumber?: number }>,
): {
  dispatched: string[];
  filtered: Array<[string, string]>;
  credits: Array<[string, AlreadyMergedCredit]>;
  events: string[];
} {
  const filtered: Array<[string, string]> = [];
  const credits: Array<[string, AlreadyMergedCredit]> = [];
  const events: string[] = [];
  const plan = { tasks: ids.map(task) } as unknown as Plan;
  const dispatched = runnableCandidates(
    plan,
    (id) => {
      events.push(`merged:${id}`);
      return projection.get(id)?.merged ?? false;
    },
    ids.length,
    {
      creditFor: (id) => {
        events.push(`credit:${id}`);
        return alreadyMergedCreditFromProjection(projection.get(id));
      },
      onFiltered: (t, reason) => filtered.push([t.id, reason]),
      onAlreadyMergedCredit: (t, credit) => credits.push([t.id, credit]),
    },
  ).map((t) => t.id);
  return { dispatched, filtered, credits, events };
}

test("W1-T2675: the already-merged refusal names which credit path matched and the PR that carried it", () => {
  const projection = new Map([["W1-T1000002", { merged: true, source: "trailer" as const, prNumber: 2376 }]]);
  const { dispatched, filtered, credits, events } = selectWithCredit(["W1-T1000002"], projection);

  assert.deepEqual(dispatched, []);
  assert.equal(filtered[0]?.[1], "already-merged", "the refusal itself is still already-merged, unchanged");
  assert.equal(credits.length, 1, "the credit is named exactly once, alongside the refusal");
  assert.equal(credits[0]?.[0], "W1-T1000002");
  assert.deepEqual(credits[0]?.[1], { path: "trailer", prNumber: 2376 },
    "both the matched credit path AND the PR that carried it are named");
  assert.deepEqual(events, ["merged:W1-T1000002", "credit:W1-T1000002"],
    "the credit detail is read from the same projection only after merged=true already refused dispatch");
});

test("W1-T2675: credit by head-ref alone is honoured, so a merge carrying no trailer still counts", () => {
  // #1657, cited in this task's own filing: zero trailers, credited purely by its
  // run-W1-T444-1786560477 head ref. isMerged(true) is honoured on its own — no trailer is
  // required for the refusal to fire — and the named path reports exactly that evidence.
  const projection = new Map([["W1-T444", { merged: true, source: "head-branch" as const, prNumber: 1657 }]]);
  const { dispatched, filtered, credits, events } = selectWithCredit(["W1-T444"], projection);

  assert.deepEqual(dispatched, [], "a head-ref-only credit still refuses the task, with no trailer needed");
  assert.equal(filtered[0]?.[1], "already-merged");
  assert.deepEqual(credits[0]?.[1], { path: "head-ref", prNumber: 1657 });
  assert.deepEqual(events, ["merged:W1-T444", "credit:W1-T444"],
    "head-ref credit is honoured through the merged projection itself, not a trailer-only path");
});

test("W1-T2675: the shard's own status field is neither read nor written by the already-merged check", () => {
  // A task's `status:` is a hand-authored filing artifact (CLAUDE.md), never a completion signal —
  // so a merged-credited task must be refused already-merged regardless of what its OWN status
  // field says, and that field must come back byte-identical: nothing on this branch writes it.
  const t = task("W1-T-STALE-STATUS");
  (t as unknown as { status: string }).status = "in_progress"; // deliberately NOT "queued" nor "blocked"
  const plan = { tasks: [t] } as unknown as Plan;
  const projection = new Map([["W1-T-STALE-STATUS", true]]);
  const filtered: Array<[string, string]> = [];
  const credits: Array<[string, AlreadyMergedCredit]> = [];

  const dispatched = runnableCandidates(plan, (id) => projection.get(id) ?? false, 1, {
    creditFor: (id) => (id === "W1-T-STALE-STATUS" ? { path: "both", prNumber: 4242 } : undefined),
    onFiltered: (task_, reason) => filtered.push([task_.id, reason]),
    onAlreadyMergedCredit: (task_, credit) => credits.push([task_.id, credit]),
  }).map((c) => c.id);

  assert.deepEqual(dispatched, []);
  assert.equal(filtered[0]?.[1], "already-merged",
    "the decision is already-merged regardless of the task's own status field — never blocked, " +
    "never anything derived from status");
  assert.deepEqual(credits[0]?.[1], { path: "both", prNumber: 4242 });
  // The check never WRITES status either: the same object handed in comes back unchanged.
  assert.equal((t as unknown as { status: string }).status, "in_progress",
    "the check must not mutate the shard's own status field");
});
