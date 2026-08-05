/**
 * lib/dispatch-governor.ts — W1-T342's PER-DISPATCH GOVERNOR GATE, in the one home both callers can
 * reach.
 *
 * WHY ITS OWN MODULE. `runDaemon` (daemon.ts) and `runDrainLanes` (drain.ts) must call the SAME
 * predicate — this function's own doc says so in as many words: "W1-T343's loop must call THIS
 * function again per lane it admits, never hoist a single call above the loop." Two copies of one
 * rule is a defect this repo has paid for twice, so a second implementation in drain.ts was never an
 * option. Neither of the two obvious homes works:
 *
 *   - daemon.ts (where it was born): daemon.ts already imports `nextRunnable` FROM drain.ts, so
 *     drain.ts importing back would close an import CYCLE.
 *   - sweep.ts (where `CostGovernorResult`/`QueueGovernorResult` live): it runs
 *     `loadDefaultPolicy()` — a `readFileSync` — at MODULE LOAD, and daemon.ts's header states it
 *     "never touches the filesystem" and holds sweep.js at `import type` only for exactly that
 *     reason. A value import would have quietly broken that purity.
 *
 * So: a new module with TYPE-ONLY dependencies, no filesystem, no cycle, imported as a value by both.
 *
 * THE GOVERNOR RESULT TYPES stay in sweep.ts and are imported here type-only — this module owns the
 * DECISION, never the shapes.
 */
import type { CostGovernorResult, QueueGovernorResult } from "./sweep.js";



/**
 * W1-T342 — THE PER-DISPATCH GOVERNOR GATE (design (i)/(ii)/(iv)).
 *
 * `checkCostGovernor`/`checkQueueGovernor` used to be consulted exactly ONCE, at the top of the
 * tick, and that single reading silently stood in for every dispatch-shaped action the REST of
 * the tick could still take — the retro trigger, the idle branch's auto-triage rung, and (once
 * W1-T343 wires a per-lane loop over `nextRunnable`'s pick) every lane in a multi-lane batch. A
 * ceiling that trips BETWEEN two dispatches in that batch would never be seen: the second lane
 * spends against a reading taken before the first lane's own (still in-flight, not yet ledgered)
 * cost could possibly show up in it.
 *
 * THE FIX: every dispatch-shaped action gets its OWN, freshly-taken reading. `runDaemon` below
 * still calls this once at the top of the tick (gating retro/auto-triage/kicks/`nextRunnable`
 * exactly as the single call used to) AND calls it again immediately before the actual dispatch
 * (`runOne`) — see that second call site's own comment. At N=1 (today; W1-T343's lane loop is
 * explicitly out of THIS task's scope) nothing async runs between the two calls in a dispatching
 * tick, so the second call always agrees with the first — a provable no-op change in observable
 * behaviour until lanes exist. It becomes load-bearing the moment a batch can hold more than one
 * lane: W1-T343's loop must call THIS function again per lane it admits, never hoist a single
 * call above the loop the way the tick-top call alone would.
 *
 * FAIL-CLOSED ON AN UNREADABLE OBSERVATION (design (iv)): `deps.checkCostGovernor`/
 * `deps.checkQueueGovernor` are pure, non-throwing predicates in sweep.ts's OWN contract, but the
 * real wiring (`costGovernorGateFor`/`queueGovernorGateFor`, run-task.ts) reads a ledger file /
 * live PR count on every call — so a LATER dispatch in a batch can hit a transient read failure
 * the first dispatch didn't. Unlike every OTHER per-tick consultation in `runDaemon` (`reloadPlan`,
 * `reloadDailyCostCeilingUsd`, `sweep`, `checkAutoTriage`, `checkRetroTrigger` all already catch
 * and degrade), these two calls were previously bare: a throw propagated straight out of
 * `runDaemon` — a full-process crash, never a deferral. The safe answer to "the reading could not
 * be taken" is the SAME as a confirmed-over-ceiling reading — admit no further dispatch this
 * batch (`kind: "unreadable"`) — never a silent fall-through to "admitted" because the check
 * errored.
 */
export function checkDispatchGovernors(
  deps: DispatchGovernorDeps,
  dailyCostCeilingUsd: number | undefined,
): DispatchGovernorVerdict | undefined {
  let costGoverned: CostGovernorResult | undefined;
  try {
    costGoverned = deps.checkCostGovernor?.(dailyCostCeilingUsd);
  } catch (e) {
    return { kind: "unreadable", source: "cost", error: e instanceof Error ? e.message : String(e) };
  }
  if (costGoverned) return { kind: "cost", result: costGoverned };

  let queueGoverned: QueueGovernorResult | undefined;
  try {
    queueGoverned = deps.checkQueueGovernor?.();
  } catch (e) {
    return { kind: "unreadable", source: "queue", error: e instanceof Error ? e.message : String(e) };
  }
  if (queueGoverned) return { kind: "queue", result: queueGoverned };

  return undefined;
}


// ── TYPE-ONLY DECLARATIONS, DELIBERATELY SANDWICHED BETWEEN THE TWO FUNCTIONS ────────────────
//
// NOT at the file head or tail, on purpose. `--experimental-test-coverage` stamps `DA:<line>,0`
// across a NEW file's leading AND trailing source-line records (a source-map preamble/epilogue
// artifact), so type declarations parked at either end read to diff-coverage as uncovered CODE and
// block the gate — measured on this exact file: DA:1,0 through DA:14,0 with every one of those lines
// being a comment, an import or an interface member. Bracketed by executed statements they get no
// such record. Same remedy `lib/open-prs-rest.ts` already applies to its own `GhApiFetcher`.

/**
 * What a caller must supply. `DaemonDeps.checkCostGovernor` takes an optional ceiling;
 * `DrainDeps.checkCostGovernor` takes none. A zero-parameter function IS assignable to a
 * one-optional-parameter type, so both satisfy this structurally and neither call site needs a shim.
 */
export interface DispatchGovernorDeps {
  checkCostGovernor?: (dailyCostCeilingUsd?: number) => CostGovernorResult | undefined;
  checkQueueGovernor?: () => QueueGovernorResult | undefined;
}

/** W1-T342: discriminates which governor (if either) is deferring THIS dispatch, and why. */
export type DispatchGovernorVerdict =
  | { kind: "cost"; result: CostGovernorResult }
  | { kind: "queue"; result: QueueGovernorResult }
  | { kind: "unreadable"; source: "cost" | "queue"; error: string };

/**
 * The ledger FIELDS a deferral verdict renders to — a pure projection of {@link
 * DispatchGovernorVerdict}, kept beside the type so a second caller cannot invent different names
 * for the same fact.
 *
 * The STEP name stays the caller's: `runDaemon` logs `daemon.cost_governor` and `runDrainLanes` logs
 * `dispatch.lane_governed`, because a per-tick deferral and a mid-batch lane refusal are genuinely
 * different events. Only the payload is shared. `runDaemon`'s own `logDispatchGovernorDefer` closure
 * already emits exactly these names and is deliberately left untouched — consolidating it is a
 * separate change, not this one's concern.
 */
export function governorDeferPayload(verdict: DispatchGovernorVerdict): Record<string, unknown> {
  if (verdict.kind === "cost") {
    return {
      observed_day_cost_usd: verdict.result.observedDayCostUsd,
      daily_cost_ceiling_usd: verdict.result.ceilingUsd,
    };
  }
  if (verdict.kind === "queue") {
    return { observed_open_count: verdict.result.observedOpenCount, wip_limit: verdict.result.wipLimit };
  }
  return {
    source: verdict.source,
    error: verdict.error,
    note: "governor observation unreadable — failing closed, admitting no further lane this batch",
  };
}
