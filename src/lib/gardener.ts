import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { systemClock, type Clock } from "./clock.js";
import type { Escalation } from "./escalate.js";
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
  /** `landed` names the PR that pass opened, so a spec's {@link GardenSpec.unfinished} cannot re-file it. */
  lastPass?: { fingerprint: string; landed?: string };
  /** The cheap fingerprint of the last look, so an idle tick reads nothing more. */
  lastCheap?: string;
  /** The one class whose PR is awaiting its outcome. While it waits, no new PR is opened. */
  pending?: { prUrl: string; actionClass: C; baseline: Outcome; atMerge?: Outcome };
  /** The current streak of passes whose filing threw, which defers the next attempt ({@link gardenFilingRetryAt}). */
  filingFailures?: { count: number; lastAt: string; reason: string };
  /** Ids of overseer effect verdicts already folded into `classes` (newest last), so a replay credits once. */
  foldedEffects?: string[];
}

/** A verdict the gardener overseer (W1-T4802) reached about a class: what a merged change did to its
 *  targeted cost (`effect`), or that the class kept re-proposing the same change (`churn`). */
export interface GardenEffect {
  id: string;
  actionClass: string;
  verdict: "credit" | "debit";
  kind: "effect" | "churn";
  at: string;
}

const GARDEN_FOLDED_EFFECTS_KEPT = 200;

export function gardenEffectsPath(stateDir: string, name: string): string {
  return join(stateDir, `${name}-gardener-effects.json`);
}

/** The pending overseer verdicts for one gardener; an absent or unreadable file holds none. */
export function readGardenEffects(path: string): GardenEffect[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { effects?: GardenEffect[] };
    return Array.isArray(parsed?.effects) ? parsed.effects.filter((e) => typeof e?.id === "string" && typeof e.actionClass === "string") : [];
  } catch (error) {
    // deliberate: an unreadable effects file is dropped, not thrown into the pass; the overseer
    // holds its own record of each verdict and writes the file afresh.
    void error;
    return [];
  }
}

/** Write the overseer's pending verdicts for one gardener. The overseer never touches the gardener's
 *  own state file — a concurrent pass would overwrite it — so this file is the one seam between them. */
export function writeGardenEffects(path: string, effects: readonly GardenEffect[]): void {
  writeAtomic(path, JSON.stringify({ effects }, null, 2) + "\n");
}

/** Credit or debit each class named by a verdict not folded before. Unknown classes are skipped. */
export function foldGardenEffects<C extends string>(state: GardenState<C>, effects: readonly GardenEffect[]): { state: GardenState<C>; applied: GardenEffect[] } {
  const seen = new Set(state.foldedEffects ?? []);
  const applied: GardenEffect[] = [];
  const classes = { ...state.classes };
  for (const e of effects) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const c = classes[e.actionClass as C];
    if (!c) continue;
    classes[e.actionClass as C] = e.verdict === "credit" ? { ...c, alpha: c.alpha + 1 } : { ...c, beta: c.beta + 1 };
    applied.push(e);
  }
  const foldedEffects = [...seen].slice(-GARDEN_FOLDED_EFFECTS_KEPT);
  return { state: { ...state, classes, foldedEffects }, applied };
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
  /** Landing branch, when a garden reserves a task id before filing its PR. */
  branch?: string;
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
  /** Raises a failure streak to a person (escalate.ts); absent, the streak is ledgered only. */
  escalate?: (escalation: Escalation) => string;
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
  /** True when the inventory itself shows the work is still undone (a ci-friction cause no plan task
   *  tracks), so a matching fingerprint from a pass that landed nothing is not trusted as done. */
  unfinished?: (inventory: I) => boolean;
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

/** Why an EXISTING state file could not be trusted: `unparseable` is bytes that are not JSON (or cannot
 *  be read), `malformed` is JSON that is not a gardener state. A missing file is neither: it is first boot. */
export type GardenStateFailure = "unparseable" | "malformed";

/** An existing state file the gardener cannot trust. Resetting it to the optimistic prior would forget a
 *  pending PR and open a duplicate, so the pass fails with this instead and leaves the file for repair. */
export class GardenStateUnreadableError extends Error {
  readonly path: string;
  readonly failureClass: GardenStateFailure;
  constructor(path: string, failureClass: GardenStateFailure, detail: string) {
    super(`gardener state ${path} is ${failureClass}: ${detail}; repair or remove the file and the next pass retries`);
    this.name = "GardenStateUnreadableError";
    this.path = path;
    this.failureClass = failureClass;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isOutcome = (v: unknown): boolean => isRecord(v) && isCount(v.trials) && isCount(v.successes);

/** The first structural fault in a parsed state, or `undefined`. Optional fields may be absent (an older
 *  record), a class the spec has added since may be absent (it is initialized), but nothing present may
 *  be the wrong shape: a pass acts on every one of these. */
function gardenStateFault(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return "the file is not a JSON object";
  if (!isRecord(parsed.classes)) return "`classes` is missing or not an object";
  for (const [name, c] of Object.entries(parsed.classes)) {
    if (!isRecord(c) || !isCount(c.alpha) || !isCount(c.beta)) return `class \`${name}\` has no numeric alpha and beta`;
  }
  const { pending, lastPass, lastCheap, filingFailures, foldedEffects } = parsed;
  if (pending !== undefined) {
    if (!isRecord(pending) || typeof pending.prUrl !== "string") return "`pending` has no PR url";
    if (typeof pending.actionClass !== "string" || !(pending.actionClass in parsed.classes)) return "`pending` names a class the record does not hold";
    if (!isOutcome(pending.baseline) || (pending.atMerge !== undefined && !isOutcome(pending.atMerge))) return "`pending` has a malformed baseline";
  }
  if (lastPass !== undefined && (!isRecord(lastPass) || typeof lastPass.fingerprint !== "string" || (lastPass.landed !== undefined && typeof lastPass.landed !== "string"))) return "`lastPass` is not a fingerprint";
  if (lastCheap !== undefined && typeof lastCheap !== "string") return "`lastCheap` is not a string";
  if (filingFailures !== undefined && (!isRecord(filingFailures) || !isCount(filingFailures.count) || typeof filingFailures.lastAt !== "string" || typeof filingFailures.reason !== "string")) return "`filingFailures` is malformed";
  if (foldedEffects !== undefined && (!Array.isArray(foldedEffects) || foldedEffects.some((id) => typeof id !== "string"))) return "`foldedEffects` is not a list of ids";
  return undefined;
}

/** The recorded state; a MISSING file is first boot and gets the optimistic prior. An existing file that
 *  cannot be read, parsed or validated throws {@link GardenStateUnreadableError} — never the prior. */
export function readGardenState<C extends string>(path: string, classes: readonly C[]): GardenState<C> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // existsSync also returns false when a parent directory is inaccessible. Only a confirmed
    // missing file is first boot; every other read failure must stop the pass.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return initialGardenState(classes);
    throw new GardenStateUnreadableError(path, "unparseable", String((e as Error)?.message ?? e));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new GardenStateUnreadableError(path, "unparseable", String((e as Error)?.message ?? e));
  }
  const fault = gardenStateFault(parsed);
  if (fault) throw new GardenStateUnreadableError(path, "malformed", fault);
  return { ...initialGardenState(classes), ...(parsed as GardenState<C>), classes: { ...initialGardenState(classes).classes, ...(parsed as GardenState<C>).classes } };
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

/** A terminal PR verdict: reviewed merges earn credit; closing any pending PR earns a debit. */
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

/** How long a ledger-reading gardener's cheap fingerprint holds. The live ledger grows every second, so
 *  a fingerprint over its size or mtime never matched, and each poll re-read the whole union on the
 *  event loop — 2026-09-29 profile: 57 s of every 300 s in the ci-friction and test gardeners. */
export const GARDEN_LEDGER_BUCKET_MS = 3_600_000;

/** The ledger half of a cheap fingerprint: an hour bucket, never the live file's size or mtime. */
export function gardenLedgerBucket(clock: Clock): number {
  return Math.floor(clock.now() / GARDEN_LEDGER_BUCKET_MS);
}

/** A failed filing's first retry waits this long; each further consecutive failure doubles it. */
export const GARDEN_FILING_RETRY_BASE_MS = 15 * 60_000;
const GARDEN_FILING_RETRY_MAX_MS = 24 * 3_600_000;
/** The consecutive failure that is raised to a person — earlier ones are retried quietly. */
export const GARDEN_FILING_ESCALATE_AT = 3;

/** When a gardener whose filings keep failing may try again; `undefined` when nothing failed. */
export function gardenFilingRetryAt(failures: GardenState<string>["filingFailures"]): number | undefined {
  if (!failures) return undefined;
  const wait = Math.min(GARDEN_FILING_RETRY_BASE_MS * 2 ** (failures.count - 1), GARDEN_FILING_RETRY_MAX_MS);
  return Date.parse(failures.lastAt) + wait;
}

function gardenFilingEscalation(name: string, failures: NonNullable<GardenState<string>["filingFailures"]>): Escalation {
  return {
    class: "BLOCKED",
    taskId: `${name}-gardener`,
    summary: `the ${name} gardener's filing has failed ${failures.count} times in a row`,
    detail: `Each pass had work, but opening its PR threw, so nothing landed. Latest reason:\n\n${failures.reason}\n\nIt keeps retrying with a doubling wait; the ledger's \`${name}.garden_filing_failed\` rows carry each attempt.`,
    options: [
      { label: "fix-filing", detail: "repair what the latest reason names; the next retry then lands on its own" },
      { label: "switch-off", detail: `touch state/${name.toUpperCase()}_OFF-<class> to stop the class` },
    ],
    recommendation: "fix-filing",
    headDedup: "independent",
  };
}

/** One pass of the gardener `spec` describes. Returns what it did. */
export function runGarden<C extends string, I, A extends GardenAction<C>, W extends GardenCheckout>(
  spec: GardenSpec<C, I, A, W>,
  deps: GardenerDeps<W>,
): { ran: boolean; plan?: GardenPlan<C, A>; prUrl?: string; scorecard?: Record<string, unknown> } {
  const statePath = gardenStatePath(deps.stateDir, spec.name);
  let state = readGardenState(statePath, spec.classes);
  // The overseer's verdicts reach the Beta record here, at the start of a pass, from a file it owns.
  const effectsPath = gardenEffectsPath(deps.stateDir, spec.name);
  const pendingEffects = readGardenEffects(effectsPath);
  if (pendingEffects.length > 0) {
    const folded = foldGardenEffects(state, pendingEffects);
    state = folded.state;
    writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
    rmSync(effectsPath, { force: true });
    if (folded.applied.length > 0) deps.log(`${spec.name}.gardener_effects_folded`, { verdicts: folded.applied.map((e) => `${e.kind}:${e.verdict}:${e.actionClass}`), classes: state.classes });
  }
  if ((gardenFilingRetryAt(state.filingFailures) ?? 0) > (deps.clock ?? systemClock).now()) return { ran: false };
  const cheap = spec.cheapFingerprint();
  const pendingBefore = state.pending;
  const prState = pendingBefore ? deps.prState?.(pendingBefore.prUrl) ?? "unknown" : undefined;
  // Closing any PR is a debit, and a reviewed class credits its merge; neither needs a corpus read.
  if (pendingBefore && (prState === "closed" || (spec.review?.[pendingBefore.actionClass] && prState === "merged"))) {
    const judged = judgeGardenDecision(state, prState);
    state = judged.state;
    deps.log(`${spec.name}.gardener_judged`, { verdict: judged.verdict, classes: state.classes });
    if (state.lastCheap === cheap) {
      writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
      return { ran: false };
    }
  }
  // A metric class needs one inventory at merge to pin its baseline. Later observations follow
  // the cheap input cadence even when the action fingerprint stays the same. An open or unreadable
  // PR need not force an expensive read.
  const terminalMetric = state.pending && !spec.review?.[state.pending.actionClass] &&
    prState === "merged" && !state.pending.atMerge;
  if (state.lastCheap === cheap && !terminalMetric) return { ran: false };
  const inventory = spec.inventory();
  const fingerprint = spec.fingerprint(inventory);
  if (state.pending) {
    const judged = spec.review?.[state.pending.actionClass]
      ? judgeGardenDecision(state, prState ?? "unknown")
      : judgeGardenPending(state, metricOf(spec, inventory, state.pending.actionClass), prState ?? "unknown");
    state = judged.state;
    if (judged.verdict === "credit" || judged.verdict === "debit") deps.log(`${spec.name}.gardener_judged`, { verdict: judged.verdict, classes: state.classes });
  }
  const trusted = state.pending !== undefined || state.lastPass?.landed !== undefined || !spec.unfinished?.(inventory);
  if (state.lastPass?.fingerprint === fingerprint && trusted) {
    writeAtomic(statePath, JSON.stringify({ ...state, lastCheap: cheap }, null, 2) + "\n");
    return { ran: false };
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
    try {
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
    } catch (e) {
      // A failed filing is not a pass: no fingerprint is recorded, so the same work is retried once
      // the doubling wait elapses, and a streak is raised to a person instead of going silent.
      const reason = String((e as Error)?.message ?? e);
      const failures = { count: (state.filingFailures?.count ?? 0) + 1, lastAt: clock.iso(), reason };
      writeAtomic(statePath, JSON.stringify({ ...state, filingFailures: failures }, null, 2) + "\n");
      deps.log(`${spec.name}.garden_filing_failed`, { attempt: failures.count, reason, retry_after_ms: gardenFilingRetryAt(failures)! - clock.now() });
      if (failures.count === GARDEN_FILING_ESCALATE_AT && deps.escalate) {
        deps.log(`${spec.name}.garden_filing_escalated`, { attempt: failures.count, issue_url: deps.escalate(gardenFilingEscalation(spec.name, failures)) });
      }
      // The measurement stands whether or not its PR opened: a filing that keeps failing must not
      // also silence the scorecard (the ci-friction rows stopped for a day behind one bad title).
      deps.log(`${spec.name}.scorecard`, { ...scorecard, acting: plan.acting, actions: plan.actions.length, pr_url: null, awaiting: state.pending?.prUrl ?? null, filing_failed: failures.count });
      return { ran: true, plan, scorecard };
    }
  }
  deps.log(`${spec.name}.scorecard`, { ...scorecard, acting: plan.acting, actions: plan.actions.length, pr_url: prUrl ?? null, awaiting: state.pending?.prUrl ?? null });
  // Only a class whose changes landed as a PR is judged, and only on its own metric from this moment.
  const baseline = (c: C): Outcome => (spec.review?.[c] ? { trials: 0, successes: 0 } : metricOf(spec, inventory, c));
  const pending = prUrl && acting !== undefined ? { prUrl, actionClass: acting, baseline: baseline(acting) } : state.pending;
  const lastPass = prUrl ? { fingerprint, landed: prUrl } : { fingerprint };
  writeAtomic(statePath, JSON.stringify({ ...state, pending, lastCheap: cheap, lastPass, filingFailures: undefined }, null, 2) + "\n");
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
      // An unreadable state file also names its path and failure class, so the row says what to repair.
      const unreadable = e instanceof GardenStateUnreadableError ? { path: e.path, failure_class: e.failureClass } : {};
      deps.log(`${spec.name}.gardener_failed`, { error: String((e as Error)?.message ?? e), ...unreadable });
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
