import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { systemClock, type Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { sampleBeta, seededRandom } from "./knowledge-value.js";

/**
 * lib/gardener.ts (W1-T4110) — the general half of every gardener.
 *
 * A gardener is a background loop that changes something the fleet owns and then checks whether the
 * change helped. The knowledge gardener (W1-T4095) was the first; this module is its general part so
 * each new gardener is a small {@link GardenSpec}, not a copy. EACH PASS: skip if nothing changed
 * (a cheap fingerprint, then a full one); judge the one action class whose PR awaits its outcome; let
 * ONE class act — the best draw from its Beta record, among classes with work and at least even odds;
 * land its changes as one PR; write a `<name>.scorecard` ledger row.
 *
 * A class is judged by ITS OWN metric ({@link GardenSpec.metric}), never one shared scalar: a closed PR
 * is a debit; after a merge, only a change in that metric beyond one standard error credits or debits
 * it. Each class has an off switch, `state/<NAME>_OFF-<class>`. A class that doctrine reserves to a
 * person declares `review`: such a class is judged by its PR's outcome alone — merged credits, closed
 * debits ({@link judgeGardenDecision}) — not by a metric. EVERY garden PR, reviewed class or not, opens
 * ready for review and flows through the fleet's review and auto-merge; none is ever a draft or held
 * (operator ruling, 2026-09-24: a draft sits like a stuck PR).
 */

/** Successes out of trials: the evidence a class is judged on. */
export interface Outcome {
  trials: number;
  successes: number;
}

export interface ClassRecord {
  alpha: number;
  beta: number;
}

export interface GardenState<C extends string> {
  classes: Record<C, ClassRecord>;
  lastPass?: { fingerprint: string };
  /** The cheap fingerprint of the last look, so an idle tick reads nothing more. */
  lastCheap?: string;
  /** The one class whose PR is awaiting its outcome. While it waits, no new PR is opened. */
  pending?: { prUrl: string; actionClass: C; baseline: Outcome; atMerge?: Outcome };
}

export type PrState = "open" | "merged" | "closed" | "unknown";
export type PendingVerdict = "none" | "waiting" | "credit" | "debit";

export interface GardenAction<C extends string> {
  class: C;
  target: string;
  reason: string;
}

export interface GardenPlan<C extends string, A extends GardenAction<C>> {
  actions: A[];
  /** Which class this pass's draw let act (at most one). */
  acting: C[];
}

/** A place to make a pass's changes and land them as one PR. */
export interface GardenCheckout {
  root: string;
  /** Commit the paths and open the PR — always ready for review, never a draft. */
  land: (opts: { paths: string[]; title: string; body: string }) => string | undefined;
  dispose: () => void;
}

export interface GardenerDeps<W extends GardenCheckout = GardenCheckout> {
  stateDir: string;
  /** The checkout the gardener reads its corpus from for planning (the daemon's own). */
  repoRoot: string;
  /** Directories outside the repo a spec may also read (the knowledge gardener: operator memory). */
  memoryDirs?: string[];
  openWorkspace: () => W;
  log: (step: string, extra?: Record<string, unknown>) => void;
  prState?: (prUrl: string) => PrState;
  seed?: number;
  clock?: Clock;
}

export interface GardenSpec<C extends string, I, A extends GardenAction<C>, W extends GardenCheckout> {
  /** Ledger prefix, state-file stem and off-switch prefix (upper-cased). */
  name: string;
  classes: readonly C[];
  /** Classes judged by their PR's outcome rather than a metric, with the reason the PR says. */
  review?: Partial<Record<C, string>>;
  cheapFingerprint: () => string;
  inventory: () => I;
  fingerprint: (inventory: I) => string;
  /** The evidence a class without `review` is judged on, read from the current inventory. */
  metric?: (inventory: I, actionClass: C) => Outcome;
  /** Every action any class could take now. Called after the class draws, with the same rng. */
  candidates: (inventory: I, rng: () => number) => A[];
  scorecard: (inventory: I, plan: GardenPlan<C, A>) => Record<string, unknown>;
  /** Make the plan's changes in the workspace; return what to land, or undefined if nothing changed. */
  apply: (workspace: W, plan: GardenPlan<C, A>, scorecard: Record<string, unknown>) => { paths: string[]; title: string; body: string } | undefined;
}

/** A new class starts optimistic (Beta(3, 1)): it acts most passes until its outcomes say otherwise. */
export function initialGardenState<C extends string>(classes: readonly C[]): GardenState<C> {
  return { classes: Object.fromEntries(classes.map((c) => [c, { alpha: 3, beta: 1 }])) as Record<C, ClassRecord> };
}

export function gardenStatePath(stateDir: string, name: string): string {
  return join(stateDir, `${name}-gardener.json`);
}

export function readGardenState<C extends string>(path: string, classes: readonly C[]): GardenState<C> {
  if (!existsSync(path)) return initialGardenState(classes);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GardenState<C>;
    return parsed && parsed.classes ? { ...initialGardenState(classes), ...parsed } : initialGardenState(classes);
  } catch {
    // deliberate: an unreadable state restarts every class at its optimistic prior; nothing is lost
    // that the next passes cannot re-learn.
    return initialGardenState(classes);
  }
}

/**
 * Judge the pending class, if any, on its own metric `now`. A closed (unmerged) PR is a debit. After
 * the merge, the success rate SINCE the merge is compared with the rate before the pass; the class is
 * credited or debited only once the difference exceeds one standard error, and otherwise waits.
 */
export function judgeGardenPending<C extends string>(state: GardenState<C>, now: Outcome, prState: PrState): { state: GardenState<C>; verdict: PendingVerdict } {
  const pending = state.pending;
  if (!pending) return { state, verdict: "none" };
  const settle = (credit: boolean): { state: GardenState<C>; verdict: PendingVerdict } => {
    const c = state.classes[pending.actionClass];
    const classes = { ...state.classes, [pending.actionClass]: credit ? { ...c, alpha: c.alpha + 1 } : { ...c, beta: c.beta + 1 } };
    return { state: { ...state, classes, pending: undefined }, verdict: credit ? "credit" : "debit" };
  };
  if (prState === "closed") return settle(false);
  if (prState !== "merged") return { state, verdict: "waiting" };
  if (!pending.atMerge) return { state: { ...state, pending: { ...pending, atMerge: now } }, verdict: "waiting" };
  const trials = now.trials - pending.atMerge.trials;
  if (trials <= 0) return { state, verdict: "waiting" };
  const after = (now.successes - pending.atMerge.successes) / trials;
  const before = pending.baseline.trials > 0 ? pending.baseline.successes / pending.baseline.trials : 0.5;
  const se = Math.sqrt(Math.max(before * (1 - before), 1 / (4 * trials)) / trials);
  if (after - before > se) return settle(true);
  if (before - after > se) return settle(false);
  return { state, verdict: "waiting" };
}

/** A class a person reviews is judged by that person: a merged PR credits it, a closed one debits it. */
export function judgeGardenDecision<C extends string>(state: GardenState<C>, prState: PrState): { state: GardenState<C>; verdict: PendingVerdict } {
  const pending = state.pending;
  if (!pending) return { state, verdict: "none" };
  if (prState !== "merged" && prState !== "closed") return { state, verdict: "waiting" };
  const c = state.classes[pending.actionClass];
  const credit = prState === "merged";
  const classes = { ...state.classes, [pending.actionClass]: credit ? { ...c, alpha: c.alpha + 1 } : { ...c, beta: c.beta + 1 } };
  return { state: { ...state, classes, pending: undefined }, verdict: credit ? "credit" : "debit" };
}

/** The evidence a metric-judged class is read on; a spec that leaves a class unreviewed must say how. */
function metricOf<C extends string, I>(spec: { name: string; metric?: (inventory: I, actionClass: C) => Outcome }, inventory: I, actionClass: C): Outcome {
  if (!spec.metric) throw new Error(`gardener ${spec.name}: class ${actionClass} has no review and the spec has no metric`);
  return spec.metric(inventory, actionClass);
}

/**
 * Every class draws from its record; of those that drew at least even odds, the ONE with the highest
 * draw and something to do acts this pass, so each outcome is credited to exactly one class. The
 * draws come before `candidates` is called, so both share one seeded sequence.
 */
export function planGarden<C extends string, A extends GardenAction<C>>(opts: {
  classes: readonly C[];
  state: GardenState<C>;
  rng: () => number;
  candidates: () => A[];
  switchedOff?: (c: C) => boolean;
}): GardenPlan<C, A> {
  const draws = opts.classes.map((c) => ({ c, draw: opts.switchedOff?.(c) ? -1 : sampleBeta({ ...opts.state.classes[c], mean: 0 }, opts.rng) }));
  const eligible = draws.filter((d) => d.draw >= 0.5).sort((a, b) => b.draw - a.draw).map((d) => d.c);
  const all = opts.candidates();
  const chosen = eligible.find((c) => all.some((a) => a.class === c));
  return { actions: chosen ? all.filter((a) => a.class === chosen) : [], acting: chosen ? [chosen] : [] };
}

/** The note a reviewed class's PR opens with: why its outcome is the verdict. It is never held — it
 *  is reviewed and auto-merges like every fleet PR, and closing it is how a person declines it. */
export function judgedByOutcomeNote(name: string, actionClass: string, why: string): string {
  return `**Judged by its outcome.** The ${name} gardener's \`${actionClass}\` changes are judged by whether this PR merges: ${why} It is reviewed and auto-merges like every fleet PR; close it to decline — a merge credits the class, a close debits it.\n\n`;
}

/** Where a landed PR stands, read over REST with the given fetcher. */
export function gardenPrState(owner: string, repo: string, prUrl: string, fetch: (args: string[]) => unknown): PrState {
  const n = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  if (!n) return "unknown";
  try {
    const pr = fetch(["api", `repos/${owner}/${repo}/pulls/${n}`]) as { merged?: boolean; state?: string };
    return pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
  } catch {
    // deliberate: an unreadable PR is "unknown", which keeps the pending class waiting, never judged on a guess.
    return "unknown";
  }
}

/** One pass of the gardener `spec` describes. Returns what it did. */
export function runGarden<C extends string, I, A extends GardenAction<C>, W extends GardenCheckout>(
  spec: GardenSpec<C, I, A, W>,
  deps: GardenerDeps<W>,
): { ran: boolean; plan?: GardenPlan<C, A>; prUrl?: string; scorecard?: Record<string, unknown> } {
  const statePath = gardenStatePath(deps.stateDir, spec.name);
  const cheap = spec.cheapFingerprint();
  if (readGardenState(statePath, spec.classes).lastCheap === cheap) return { ran: false };
  const inventory = spec.inventory();
  const fingerprint = spec.fingerprint(inventory);
  let state = readGardenState(statePath, spec.classes);
  if (state.lastPass?.fingerprint === fingerprint) {
    writeAtomic(statePath, JSON.stringify({ ...state, lastCheap: cheap }, null, 2) + "\n");
    return { ran: false };
  }
  if (state.pending) {
    const prState = deps.prState?.(state.pending.prUrl) ?? "unknown";
    const judged = spec.review?.[state.pending.actionClass]
      ? judgeGardenDecision(state, prState)
      : judgeGardenPending(state, metricOf(spec, inventory, state.pending.actionClass), prState);
    state = judged.state;
    if (judged.verdict === "credit" || judged.verdict === "debit") deps.log(`${spec.name}.gardener_judged`, { verdict: judged.verdict, classes: state.classes });
  }
  const clock = deps.clock ?? systemClock;
  const rng = seededRandom(deps.seed ?? clock.now());
  const plan: GardenPlan<C, A> = state.pending
    ? { actions: [], acting: [] }
    : planGarden({
        classes: spec.classes,
        state,
        rng,
        candidates: () => spec.candidates(inventory, rng),
        switchedOff: (c) => existsSync(join(deps.stateDir, `${spec.name.toUpperCase()}_OFF-${c}`)),
      });
  const scorecard = spec.scorecard(inventory, plan);
  const acting = plan.acting[0];
  let prUrl: string | undefined;
  if (acting !== undefined && plan.actions.length > 0) {
    const ws = deps.openWorkspace();
    try {
      const landing = spec.apply(ws, plan, scorecard);
      if (landing) {
        const why = spec.review?.[acting];
        prUrl = ws.land(why ? { ...landing, body: judgedByOutcomeNote(spec.name, acting, why) + landing.body } : landing);
      }
    } finally {
      ws.dispose();
    }
  }
  deps.log(`${spec.name}.scorecard`, { ...scorecard, acting: plan.acting, actions: plan.actions.length, pr_url: prUrl ?? null, awaiting: state.pending?.prUrl ?? null });
  // Only a class whose changes landed as a PR is judged, and only on its own metric from this moment.
  const baseline = (c: C): Outcome => (spec.review?.[c] ? { trials: 0, successes: 0 } : metricOf(spec, inventory, c));
  const pending = prUrl && acting !== undefined ? { prUrl, actionClass: acting, baseline: baseline(acting) } : state.pending;
  writeAtomic(statePath, JSON.stringify({ ...state, pending, lastCheap: cheap, lastPass: { fingerprint } }, null, 2) + "\n");
  return { ran: true, plan, prUrl, scorecard };
}

/** Run passes on their own timer beside the main loop, never two at once. */
export function startGarden<C extends string, I, A extends GardenAction<C>, W extends GardenCheckout>(
  spec: GardenSpec<C, I, A, W>,
  deps: GardenerDeps<W>,
  intervalMs: number,
): { stop: () => void } {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      runGarden(spec, deps);
    } catch (e) {
      deps.log(`${spec.name}.gardener_failed`, { error: String((e as Error)?.message ?? e) });
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
