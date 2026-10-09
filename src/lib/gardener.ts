import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import type { Escalation } from "./escalate.js";
import { writeAtomic } from "./fs-race-safe.js";
import { runStepsAsync, runStepsSync, step, type StepEffect, type Steps } from "./git-push.js";
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
  /** The one class whose PR is awaiting its outcome. While it waits, no new PR is opened.
   *  `mergeSeenAt` is when a pass first saw the merge, so a frozen metric is released ({@link GARDEN_PENDING_RELEASE_MS}). */
  pending?: { prUrl: string; actionClass: C; baseline: Outcome; atMerge?: Outcome; mergeSeenAt?: string };
  /** The decision pending's recording time; legacy records start when next observed open. */
  pendingRecordedAt?: string;
  /** The current streak of passes whose filing threw, which defers the next attempt ({@link gardenFilingRetryAt}). */
  filingFailures?: { count: number; lastAt: string; reason: string };
  /** Ids of overseer effect verdicts already folded into `classes` (newest last), so a replay credits once. */
  foldedEffects?: string[];
  /** Legacy verdicts have no ordered watermark, so their receipts must not age out. */
  foldedLegacyEffects?: string[];
  /** Complete delivered prefix for this gardener; sequence gaps belong to other gardeners. */
  foldedEffectThrough?: number;
}

/** A verdict the gardener overseer (W1-T4802) reached about a class: what a merged change did to its
 *  targeted cost (`effect`), or that the class kept re-proposing the same change (`churn`). */
export interface GardenEffect {
  id: string;
  actionClass: string;
  verdict: "credit" | "debit";
  kind: "effect" | "churn";
  at: string;
  sequence?: number;
}

const GARDEN_FOLDED_EFFECTS_KEPT = 200;

class GardenEffectProtocolError extends RmdError {
  constructor(detail: string) {
    super("gardener", GENERIC_EXIT_CODE, detail);
    this.name = "GardenEffectProtocolError";
  }
}

export function gardenEffectsPath(stateDir: string, name: string): string {
  return join(stateDir, `${name}-gardener-effects.json`);
}

export class GardenEffectsUnreadableError extends RmdError {
  constructor(readonly path: string, readonly failureClass: GardenStateFailure, detail: string) {
    super("gardener", GENERIC_EXIT_CODE, `gardener effects ${path} are ${failureClass}: ${detail}; repair or remove the file and the next pass retries`, { path, failureClass });
    this.name = "GardenEffectsUnreadableError";
  }
}

/** Only a confirmed missing file is first boot; damaged verdict evidence stops the pass. */
export function readGardenEffects(path: string): GardenEffect[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT" && lstatSync(path, { throwIfNoEntry: false }) === undefined) return [];
    throw new GardenEffectsUnreadableError(path, "unparseable", String((e as Error)?.message ?? e));
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new GardenEffectsUnreadableError(path, "unparseable", String((e as Error)?.message ?? e)); }
  if (!isRecord(parsed) || !Array.isArray(parsed.effects) || parsed.effects.some((e: unknown) =>
    !isRecord(e) || typeof e.id !== "string" || typeof e.actionClass !== "string" ||
    (e.verdict !== "credit" && e.verdict !== "debit") || (e.kind !== "effect" && e.kind !== "churn") ||
    typeof e.at !== "string" || !Number.isFinite(Date.parse(e.at)) ||
    (e.sequence !== undefined && (!Number.isSafeInteger(e.sequence) || (e.sequence as number) < 1))
  )) throw new GardenEffectsUnreadableError(path, "malformed", "`effects` is not a list of complete verdicts");
  return parsed.effects as GardenEffect[];
}

/** Write the overseer's pending verdicts for one gardener. The overseer never touches the gardener's
 *  own state file — a concurrent pass would overwrite it — so this file is the one seam between them. */
export function writeGardenEffects(path: string, effects: readonly GardenEffect[]): void {
  writeAtomic(path, JSON.stringify({ effects }, null, 2) + "\n");
}

/** Fold an ordered producer prefix, stopping before a class this consumer cannot acknowledge. */
export function foldGardenEffects<C extends string>(state: GardenState<C>, effects: readonly GardenEffect[]): { state: GardenState<C>; applied: GardenEffect[]; remaining: GardenEffect[] } {
  const seen = new Set(state.foldedEffects ?? []);
  const legacy = new Set(state.foldedLegacyEffects ?? ((state.foldedEffectThrough ?? 0) === 0 ? state.foldedEffects ?? [] : []));
  let foldedEffectThrough = state.foldedEffectThrough ?? 0;
  let previous = 0;
  const ids = new Set<string>();
  const sequenced = effects.some((e) => e.sequence !== undefined);
  for (const e of effects) {
    if (sequenced && (e.sequence === undefined || !Number.isSafeInteger(e.sequence) || e.sequence <= previous || ids.has(e.id))) {
      throw new GardenEffectProtocolError("gardener effects are not an ordered, unique producer prefix");
    }
    previous = e.sequence ?? 0;
    ids.add(e.id);
  }
  if (state.foldedLegacyEffects === undefined && (state.foldedEffects?.length ?? 0) >= GARDEN_FOLDED_EFFECTS_KEPT &&
    effects.some((e) => !seen.has(e.id) && (e.sequence === undefined || state.foldedEffectThrough === undefined))) {
    throw new GardenEffectProtocolError("legacy gardener receipt is unavailable beyond the retained 200 IDs");
  }
  const applied: GardenEffect[] = [];
  let remaining: GardenEffect[] = [];
  const classes = { ...state.classes };
  for (const [i, e] of effects.entries()) {
    if (e.sequence !== undefined && e.sequence <= foldedEffectThrough) continue;
    if (legacy.has(e.id) || seen.has(e.id)) {
      if (e.sequence !== undefined) foldedEffectThrough = e.sequence;
      else legacy.add(e.id);
      continue;
    }
    const c = classes[e.actionClass as C];
    if (!Object.hasOwn(classes, e.actionClass)) { remaining = effects.slice(i); break; }
    classes[e.actionClass as C] = e.verdict === "credit" ? { ...c, alpha: c.alpha + 1 } : { ...c, beta: c.beta + 1 };
    applied.push(e);
    seen.add(e.id);
    if (e.sequence === undefined) legacy.add(e.id);
    else foldedEffectThrough = e.sequence;
  }
  const foldedEffects = [...seen].slice(-GARDEN_FOLDED_EFFECTS_KEPT);
  return { state: { ...state, classes, foldedEffects, ...(legacy.size ? { foldedLegacyEffects: [...legacy] } : {}), ...(foldedEffectThrough ? { foldedEffectThrough } : {}) }, applied, remaining };
}

export type PrState = "open" | "merged" | "closed" | "unknown";
export type PendingVerdict = "none" | "waiting" | "credit" | "debit" | "released";

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

/** W1-T5740: the daemon's form of a checkout — the same tree, its landing and disposal awaited. */
export type GardenCheckoutAsync<W extends GardenCheckout = GardenCheckout> = Omit<W, "land" | "dispose"> & {
  land: (opts: { paths: string[]; title: string; body: string }) => Promise<string | undefined>;
  dispose: () => Promise<void>;
};

/** Opens a pass's checkout: the CLI's synchronous one, or the daemon's, made off the event loop. */
export type GardenWorkspacePort<W extends GardenCheckout = GardenCheckout> = () => W | Promise<GardenCheckoutAsync<W>>;

/** What a synchronous caller is handed when an async port reaches it: a promise read as a checkout. */
export const ASYNC_PORT_UNDER_SYNC_PASS = "an async garden workspace port reached a synchronous pass; drive it with its async form";

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/** The checkout a synchronous caller can use. An async port's promise is refused, and the checkout it
 *  makes is disposed once made, so the refusal leaves no worktree behind. */
export function syncGardenWorkspace<W extends GardenCheckout>(ws: W | Promise<GardenCheckoutAsync<W>>): W {
  if (!isPromiseLike(ws)) return ws;
  throw refuseAsyncPort(ws);
}

function refuseAsyncPort(made: PromiseLike<unknown>): Error {
  Promise.resolve(made)
    .then((value) => (value as { dispose?: () => unknown } | null | undefined)?.dispose?.())
    .catch(() => {
      // The refusal already reached the caller; a port that never made a checkout leaves nothing to dispose.
    });
  return new Error(ASYNC_PORT_UNDER_SYNC_PASS);
}

/** {@link runStepsSync}, refusing an effect that returns a promise: the refusal is thrown into the steps
 *  at that yield, so a pass's own catch ledgers it rather than landing a promise as a PR url, and a
 *  checkout the refused effect makes is disposed once made. */
export function runStepsSyncOnly<R>(steps: Steps<R>): R {
  return runStepsSync(refusingPromises(steps));
}

function* refusingPromises<R>(steps: Steps<R>): Steps<R> {
  let next = steps.next();
  while (!next.done) {
    const effect = next.value;
    let value: unknown;
    try {
      value = yield () => {
        const made = effect();
        if (!isPromiseLike(made)) return made;
        throw refuseAsyncPort(made);
      };
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(value);
  }
  return next.value;
}

/** Drives `steps` synchronously until an effect returns a promise, then awaits the rest: steps over
 *  synchronous ports finish before this returns, and steps over the daemon's async ports yield the loop. */
export function runStepsEager<R>(steps: Steps<R>): R | Promise<R> {
  let next = steps.next();
  while (!next.done) {
    let value: unknown;
    try {
      value = next.value();
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    if (isPromiseLike(value)) return resumeSteps(steps, value);
    next = steps.next(value);
  }
  return next.value;
}

async function resumeSteps<R>(steps: Steps<R>, pending: PromiseLike<unknown>): Promise<R> {
  let settled: { ok: true; value: unknown } | { ok: false; error: unknown };
  try {
    settled = { ok: true, value: await pending };
  } catch (error) {
    settled = { ok: false, error };
  }
  let next: IteratorResult<StepEffect, R> = settled.ok ? steps.next(settled.value) : steps.throw(settled.error);
  while (!next.done) {
    let value: unknown;
    try {
      value = await next.value();
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(value);
  }
  return next.value;
}

export interface GardenerDeps<W extends GardenCheckout = GardenCheckout, P extends PrState | Promise<PrState> = PrState> {
  stateDir: string;
  /** The checkout the gardener reads its corpus from for planning (the daemon's own). */
  repoRoot: string;
  /** Directories outside the repo a spec may also read (the knowledge gardener: operator memory). */
  memoryDirs?: string[];
  openWorkspace: GardenWorkspacePort<W>;
  log: (step: string, extra?: Record<string, unknown>) => void;
  prState?: (prUrl: string) => P;
  seed?: number;
  clock?: Clock;
  /** Raises a failure streak to a person (escalate.ts); absent, the streak is ledgered only. */
  escalate?: (escalation: Escalation) => string;
  /** What a pending PR waits on, read from local files with no GitHub call ({@link gardenPendingSignal});
   *  absent or undefined, a pending PR is paced on the clock alone. */
  pendingSignal?: (prUrl: string) => string | undefined;
  /** Stands in for a shard filer's landing guard (machine-filing.ts's `machineShardLandingGuard`): a
   *  fixture sets it to land a shape lint-plan refuses, to test what follows a landing. Production never does. */
  landingRefusal?: (root: string, paths: readonly string[]) => string | undefined;
}

export interface GardenSpec<C extends string, I, A extends GardenAction<C>, W extends GardenCheckout> {
  /** Ledger prefix, state-file stem and off-switch prefix (upper-cased). */
  name: string;
  classes: readonly C[];
  /** Classes judged by their PR's outcome rather than a metric, with the reason the PR says. */
  review?: Partial<Record<C, string>>;
  /** Classes the metric does not measure, judged by their PR's decision like `review` but not a
   *  person's call, so their PR carries no review note (W1-T5825: the gate tally never sees a defuse). */
  decision?: readonly C[];
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
  /** A garden that files plan shards names lint-plan's verdict on its landing here, normally
   *  machine-filing.ts's `machineShardLandingRefusal`. A refusal is a recorded filing failure, so a
   *  draft lint-plan would refuse never opens as a red PR (#10446, #10457). */
  landingRefusal?: (root: string, paths: readonly string[]) => string | undefined;
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
export class GardenStateUnreadableError extends RmdError {
  readonly path: string;
  readonly failureClass: GardenStateFailure;
  constructor(path: string, failureClass: GardenStateFailure, detail: string) {
    super("gardener", GENERIC_EXIT_CODE, `gardener state ${path} is ${failureClass}: ${detail}; repair or remove the file and the next pass retries`, { path, failureClass });
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
  const { pending, lastPass, lastCheap, filingFailures, foldedEffects, foldedLegacyEffects, foldedEffectThrough } = parsed;
  if (pending !== undefined) {
    if (!isRecord(pending) || typeof pending.prUrl !== "string") return "`pending` has no PR url";
    if (typeof pending.actionClass !== "string" || !(pending.actionClass in parsed.classes)) return "`pending` names a class the record does not hold";
    if (!isOutcome(pending.baseline) || (pending.atMerge !== undefined && !isOutcome(pending.atMerge))) return "`pending` has a malformed baseline";
    if (pending.mergeSeenAt !== undefined && typeof pending.mergeSeenAt !== "string") return "`pending.mergeSeenAt` is not a timestamp";
  }
  if (parsed.pendingRecordedAt !== undefined && (typeof parsed.pendingRecordedAt !== "string" || !Number.isFinite(Date.parse(parsed.pendingRecordedAt)))) return "`pendingRecordedAt` is not a timestamp";
  if (lastPass !== undefined && (!isRecord(lastPass) || typeof lastPass.fingerprint !== "string" || (lastPass.landed !== undefined && typeof lastPass.landed !== "string"))) return "`lastPass` is not a fingerprint";
  if (lastCheap !== undefined && typeof lastCheap !== "string") return "`lastCheap` is not a string";
  if (filingFailures !== undefined && (!isRecord(filingFailures) || !isCount(filingFailures.count) || typeof filingFailures.lastAt !== "string" || typeof filingFailures.reason !== "string")) return "`filingFailures` is malformed";
  if (foldedEffects !== undefined && (!Array.isArray(foldedEffects) || foldedEffects.some((id) => typeof id !== "string"))) return "`foldedEffects` is not a list of ids";
  if (foldedLegacyEffects !== undefined && (!Array.isArray(foldedLegacyEffects) || foldedLegacyEffects.some((id) => typeof id !== "string"))) return "`foldedLegacyEffects` is not a list of ids";
  if (foldedEffectThrough !== undefined && (!Number.isSafeInteger(foldedEffectThrough) || (foldedEffectThrough as number) < 0)) return "`foldedEffectThrough` is not a sequence";
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

/** BACKSTOP: how long a merged metric-judged PR may wait for its metric to gain one trial before it is
 *  released unjudged. The gate tally only grows on a `measured` report, and #9019 waited a day of
 *  `partial` ones while every other class, defuse included, sat idle (W1-T5825). */
export const GARDEN_PENDING_RELEASE_MS = 24 * 3_600_000;

/** BACKSTOP: an open decision PR releases its lane unjudged after a day from recording (W1-T5842). */
export const GARDEN_DECISION_PENDING_RELEASE_MS = 24 * 3_600_000;

/**
 * Judge the pending class, if any, on its own metric `now`. A closed (unmerged) PR is a debit. After
 * the merge, the success rate SINCE the merge is compared with the rate before the pass; the class is
 * credited or debited only once the difference exceeds one standard error, and otherwise waits. With a
 * `clock`, a merge whose metric gains no trial within {@link GARDEN_PENDING_RELEASE_MS} is `released`:
 * neither credit nor debit, so a silent metric cannot hold every other class.
 */
export function judgeGardenPending<C extends string>(state: GardenState<C>, now: Outcome, prState: PrState, clock?: Clock): { state: GardenState<C>; verdict: PendingVerdict } {
  const pending = state.pending;
  if (!pending) return { state, verdict: "none" };
  const settle = (credit: boolean): { state: GardenState<C>; verdict: PendingVerdict } => {
    const c = state.classes[pending.actionClass];
    const classes = { ...state.classes, [pending.actionClass]: credit ? { ...c, alpha: c.alpha + 1 } : { ...c, beta: c.beta + 1 } };
    return { state: { ...state, classes, pending: undefined }, verdict: credit ? "credit" : "debit" };
  };
  if (prState === "closed") return settle(false);
  if (prState !== "merged") return { state, verdict: "waiting" };
  if (!pending.atMerge) return { state: { ...state, pending: { ...pending, atMerge: now, ...(clock ? { mergeSeenAt: clock.iso() } : {}) } }, verdict: "waiting" };
  const trials = now.trials - pending.atMerge.trials;
  if (trials <= 0) {
    if (!clock) return { state, verdict: "waiting" };
    // A merge pinned before the stamp existed is stamped now, so its bound starts at this pass.
    if (!pending.mergeSeenAt) return { state: { ...state, pending: { ...pending, mergeSeenAt: clock.iso() } }, verdict: "waiting" };
    if (clock.now() - Date.parse(pending.mergeSeenAt) < GARDEN_PENDING_RELEASE_MS) return { state, verdict: "waiting" };
    return { state: { ...state, pending: undefined }, verdict: "released" };
  }
  const after = (now.successes - pending.atMerge.successes) / trials;
  const before = pending.baseline.trials > 0 ? pending.baseline.successes / pending.baseline.trials : 0.5;
  const se = Math.sqrt(Math.max(before * (1 - before), 1 / (4 * trials)) / trials);
  if (after - before > se) return settle(true);
  if (before - after > se) return settle(false);
  return { state, verdict: "waiting" };
}

/** Merges credit and closes debit; with a clock, an overdue open decision PR releases unjudged. */
export function judgeGardenDecision<C extends string>(state: GardenState<C>, prState: PrState, clock?: Clock): { state: GardenState<C>; verdict: PendingVerdict } {
  const pending = state.pending;
  if (!pending) return { state, verdict: "none" };
  if (prState === "open" && clock && state.pendingRecordedAt && clock.now() - Date.parse(state.pendingRecordedAt) >= GARDEN_DECISION_PENDING_RELEASE_MS) {
    return { state: { ...state, pending: undefined, pendingRecordedAt: undefined }, verdict: "released" };
  }
  if (prState !== "merged" && prState !== "closed") return { state, verdict: "waiting" };
  const c = state.classes[pending.actionClass];
  const credit = prState === "merged";
  const classes = { ...state.classes, [pending.actionClass]: credit ? { ...c, alpha: c.alpha + 1 } : { ...c, beta: c.beta + 1 } };
  return { state: { ...state, classes, pending: undefined, pendingRecordedAt: undefined }, verdict: credit ? "credit" : "debit" };
}

/** Whether `c` is judged by its PR's decision (merged credits, closed debits) rather than a metric. */
function judgedByDecision<C extends string>(spec: Pick<GardenSpec<C, never, GardenAction<C>, GardenCheckout>, "review" | "decision">, c: C): boolean {
  return Boolean(spec.review?.[c]) || spec.decision?.includes(c) === true;
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
export function gardenPrState(owner: string, repo: string, prUrl: string, fetch: (args: string[]) => Promise<unknown>): PrState | Promise<PrState>;
export function gardenPrState(owner: string, repo: string, prUrl: string, fetch: (args: string[]) => unknown): PrState;
export function gardenPrState(owner: string, repo: string, prUrl: string, fetch: (args: string[]) => unknown): PrState | Promise<PrState> {
  return runStepsEager(gardenPrStateSteps(owner, repo, prUrl, fetch));
}

function* gardenPrStateSteps(owner: string, repo: string, prUrl: string, fetch: (args: string[]) => unknown): Steps<PrState> {
  const n = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  if (!n) return "unknown";
  try {
    const pr = (yield* step(() => fetch(["api", `repos/${owner}/${repo}/pulls/${n}`]))) as { merged?: boolean; state?: string };
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

/**
 * A pass whose inventory threw, and the cheap inputs it threw over. Without it a failing inventory left
 * no `lastCheap`, so the garden was due on EVERY poll and re-read its whole corpus to fail the same way.
 * OBSERVED 2026-10-09 10:52-11:54Z on the fleet host: ci-friction ran 47 passes for 1,505 s of child time,
 * every one ending `ci-friction.gardener_failed` (workflow ownership ambiguous for ci-gate) after reading
 * the full ledger union. Kept beside the state file, so a failed pass still leaves the prior receipt intact.
 */
export interface GardenInventoryFailure {
  cheap: string;
  /** When this streak of failures began; the retry wait grows with it. */
  firstAt: string;
  lastAt: string;
  count: number;
  reason: string;
}

export function gardenInventoryFailurePath(stateDir: string, name: string): string {
  return join(stateDir, `${name}-gardener-inventory-failure.json`);
}

/** The first retry over unchanged inputs waits one daemon poll. */
export const GARDEN_INVENTORY_RETRY_BASE_MS = 60_000;
/** Each further retry also waits this fraction of the time the streak has been failing: proportional, not capped. */
export const GARDEN_INVENTORY_RETRY_DIVISOR = 4;

/** The recorded failure; an absent or damaged record is no failure, so the pass runs and reports itself. */
export function readGardenInventoryFailure(stateDir: string, name: string): GardenInventoryFailure | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(gardenInventoryFailurePath(stateDir, name), "utf8"));
    if (!isRecord(parsed) || typeof parsed.cheap !== "string" || typeof parsed.reason !== "string" || !isCount(parsed.count) ||
        !Number.isFinite(Date.parse(String(parsed.firstAt))) || !Number.isFinite(Date.parse(String(parsed.lastAt)))) return undefined;
    return parsed as unknown as GardenInventoryFailure;
  } catch {
    // deliberate: no readable failure record means nothing defers the pass.
    return undefined;
  }
}

/** When a garden whose inventory failed may read it again over the SAME cheap inputs. */
export function gardenInventoryRetryAt(failure: GardenInventoryFailure): number {
  const first = Date.parse(failure.firstAt);
  const last = Date.parse(failure.lastAt);
  return last + GARDEN_INVENTORY_RETRY_BASE_MS + Math.max(0, last - first) / GARDEN_INVENTORY_RETRY_DIVISOR;
}

/** A recorded failure defers the pass only while the cheap inputs are the ones it failed over. */
function inventoryFailureHolds(failure: GardenInventoryFailure | undefined, cheap: string, nowMs: number): boolean {
  return failure !== undefined && failure.cheap === cheap && nowMs < gardenInventoryRetryAt(failure);
}

/**
 * PACING A PENDING PR. A pass over a pending PR asks GitHub for its state and, on unchanged cheap inputs, does
 * nothing else, so it can only learn something when the PR could have moved: its head, its open row (a merge or
 * a close drops it from the open list) or main. OBSERVED 2026-10-09 on the fleet host: gate and export were due
 * on every poll while a PR was pending, about 55-60 passes an hour each and about 550 s of child CPU an hour.
 * Each pending pass records what it saw here. The next one is due when that `signal` moves, when a release
 * clock elapses, or after a growing share of the quiet time: no fixed ceiling, and any change snaps it back.
 */
export const GARDEN_PENDING_QUIET_DIVISOR = 4;

export interface GardenPendingWatch {
  prUrl: string;
  /** What the pending PR waits on, read without a GitHub call ({@link gardenPendingSignal}); absent when unreadable. */
  signal?: string;
  lastPassAt: string;
  /** When the signal last moved (or the watch began); the quiet span runs from here to `lastPassAt`. */
  quietSince: string;
}

export function gardenPendingWatchPath(stateDir: string, name: string): string {
  return join(stateDir, `${name}-gardener-pending-watch.json`);
}

/** The recorded watch; an absent or damaged record is none, so the next poll runs a pass. */
export function readGardenPendingWatch(stateDir: string, name: string): GardenPendingWatch | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(gardenPendingWatchPath(stateDir, name), "utf8"));
    if (!isRecord(parsed) || typeof parsed.prUrl !== "string" || (parsed.signal !== undefined && typeof parsed.signal !== "string") ||
        !Number.isFinite(Date.parse(String(parsed.lastPassAt))) || !Number.isFinite(Date.parse(String(parsed.quietSince)))) return undefined;
    return parsed as unknown as GardenPendingWatch;
  } catch {
    // deliberate: no readable watch means nothing has slowed the pending pass down yet.
    return undefined;
  }
}

/** What a pending PR waits on, from the board's persisted open-PR snapshot and origin/main's ref: the PR's
 *  head and update stamp while it is open, `not-open` once it leaves the open list, and main's sha. */
export function gardenPendingSignal(
  prUrl: string,
  openRows: ReadonlyArray<{ url: string; headRefOid: string; updatedAt: string }> | undefined,
  mainSha: string | undefined,
): string {
  const row = openRows?.find((r) => r.url === prUrl);
  const pr = openRows === undefined ? "pr:unknown" : row ? `pr:${row.headRefOid}@${row.updatedAt}` : "pr:not-open";
  return `${pr} main:${mainSha ?? "unknown"}`;
}

/** When a pending PR's clock-driven release (a merged metric's, or the decision backstop) comes due; undefined for none. */
function pendingReleaseAt<C extends string>(state: GardenState<C>): number | undefined {
  const pending = state.pending;
  if (pending?.mergeSeenAt !== undefined) return Date.parse(pending.mergeSeenAt) + GARDEN_PENDING_RELEASE_MS;
  return state.pendingRecordedAt === undefined ? undefined : Date.parse(state.pendingRecordedAt) + GARDEN_DECISION_PENDING_RELEASE_MS;
}

/** Whether a pass over a pending PR could learn anything, reading only local files. A release clock is due once,
 *  by the first pass after it elapses: a merged metric that keeps "waiting" past it re-reads the same inputs. */
function pendingPassDue<C extends string>(state: GardenState<C>, name: string, deps: Pick<GardenerDeps, "stateDir" | "pendingSignal">, nowMs: number): boolean {
  const prUrl = state.pending!.prUrl;
  const watch = readGardenPendingWatch(deps.stateDir, name);
  if (watch === undefined || watch.prUrl !== prUrl) return true;
  const last = Date.parse(watch.lastPassAt);
  const releaseAt = pendingReleaseAt(state);
  if (releaseAt !== undefined && nowMs >= releaseAt && last < releaseAt) return true;
  const signal = deps.pendingSignal?.(prUrl);
  if (signal !== undefined && signal !== watch.signal) return true;
  return nowMs - last >= Math.max(0, last - Date.parse(watch.quietSince)) / GARDEN_PENDING_QUIET_DIVISOR;
}

/** After a pass: record what a still-pending PR was seen waiting on, or drop the watch once nothing is pending. */
function notePendingWatch(name: string, classes: readonly string[], deps: Pick<GardenerDeps, "stateDir" | "pendingSignal" | "clock">): void {
  const path = gardenPendingWatchPath(deps.stateDir, name);
  try {
    const pending = readGardenState(gardenStatePath(deps.stateDir, name), classes).pending;
    if (!pending) {
      rmSync(path, { force: true });
      return;
    }
    const at = (deps.clock ?? systemClock).iso();
    const prior = readGardenPendingWatch(deps.stateDir, name);
    const signal = deps.pendingSignal?.(pending.prUrl);
    const moved = prior === undefined || prior.prUrl !== pending.prUrl || (signal !== undefined && signal !== prior.signal);
    const watch: GardenPendingWatch = { prUrl: pending.prUrl, ...(signal === undefined ? {} : { signal }), lastPassAt: at, quietSince: moved ? at : prior.quietSince };
    writeAtomic(path, JSON.stringify(watch) + "\n");
  } catch {
    // deliberate: an unwritable watch leaves the next poll due, which is the behaviour before pacing existed.
  }
}

function gardenFilingEscalation(name: string,failures: NonNullable<GardenState<string>["filingFailures"]>): Escalation {
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

/**
 * Whether a pass of `spec` would do anything, read the way {@link runGarden} reads it before its first
 * expensive step, and writing nothing. Waiting overseer effects are always due (the pass folds them); a
 * pending PR is due when what it waits on moved or its paced wait elapsed ({@link GARDEN_PENDING_QUIET_DIVISOR});
 * a filing retry wait is not; otherwise only a changed cheap fingerprint is. A
 * daemon spawning each pass as its own process asks this first, so an idle garden costs a file read
 * rather than a process boot. An unreadable state file throws, and the caller runs the pass, which logs it.
 */
export function gardenPassDue<C extends string>(
  spec: Pick<GardenSpec<C, unknown, GardenAction<C>, GardenCheckout>, "name" | "classes" | "cheapFingerprint">,
  deps: Pick<GardenerDeps, "stateDir" | "clock" | "pendingSignal">,
): boolean {
  const state = readGardenState(gardenStatePath(deps.stateDir, spec.name), spec.classes);
  if (existsSync(gardenEffectsPath(deps.stateDir, spec.name))) return true;
  if ((gardenFilingRetryAt(state.filingFailures) ?? 0) > (deps.clock ?? systemClock).now()) return false;
  if (state.pending && pendingPassDue(state, spec.name, deps, (deps.clock ?? systemClock).now())) return true;
  const cheap = spec.cheapFingerprint();
  if (inventoryFailureHolds(readGardenInventoryFailure(deps.stateDir, spec.name), cheap, (deps.clock ?? systemClock).now())) return false;
  return state.lastCheap !== cheap;
}

/**
 * Whether a pass of `spec` would read its inventory (W1-T5668), mirroring every return {@link gardenPassSteps}
 * takes before `spec.inventory()` and writing nothing. `gardenPassDue` is true for the whole life of a pending
 * PR, yet the pass then returns on an unchanged cheap fingerprint without reading the inventory, so a caller
 * that builds the inventory first (the config gardener's off-loop 60-day read) pays for nothing. Waiting
 * overseer effects answer true, because the pass folds them and may change what it does. `prState` is the
 * pending PR's state, already resolved by the caller, since this read is synchronous; a settled PR is
 * judged without an inventory, and a merged metric-judged one is read on its terminal or release clock.
 */
export function gardenNeedsInventory<C extends string>(
  spec: Pick<GardenSpec<C, unknown, GardenAction<C>, GardenCheckout>, "name" | "classes" | "cheapFingerprint" | "review" | "decision">,
  deps: Pick<GardenerDeps, "stateDir" | "clock">,
  prState?: PrState,
): boolean {
  const state = readGardenState(gardenStatePath(deps.stateDir, spec.name), spec.classes);
  if (existsSync(gardenEffectsPath(deps.stateDir, spec.name))) return true;
  const clock = deps.clock ?? systemClock;
  if ((gardenFilingRetryAt(state.filingFailures) ?? 0) > clock.now()) return false;
  const cheap = spec.cheapFingerprint();
  if (inventoryFailureHolds(readGardenInventoryFailure(deps.stateDir, spec.name), cheap, clock.now())) return false;
  // A decision-judged merge or a closed PR is judged and, on an unchanged fingerprint, returns unread; neither
  // can be a merged metric-judged pending, so the terminal and release terms below are false for them.
  const metricPending = state.pending && !judgedByDecision(spec, state.pending.actionClass) && prState === "merged" ? state.pending : undefined;
  const terminalMetric = metricPending !== undefined && !metricPending.atMerge;
  const releaseDue = metricPending?.atMerge !== undefined &&
    (!metricPending.mergeSeenAt || clock.now() - Date.parse(metricPending.mergeSeenAt) >= GARDEN_PENDING_RELEASE_MS);
  const decisionReleaseDue = state.pending && judgedByDecision(spec, state.pending.actionClass) && prState === "open" &&
    state.pendingRecordedAt !== undefined && clock.now() - Date.parse(state.pendingRecordedAt) >= GARDEN_DECISION_PENDING_RELEASE_MS;
  return state.lastCheap !== cheap || terminalMetric || releaseDue || Boolean(decisionReleaseDue);
}

/** What one pass did. */
export interface GardenPassResult<C extends string, A extends GardenAction<C>> {
  ran: boolean;
  plan?: GardenPlan<C, A>;
  prUrl?: string;
  scorecard?: Record<string, unknown>;
}

/** A settled pending frees the lane. A `lastPass` that landed nothing was recorded while the pending
 *  held every class, so its candidates were seen but never offered; forgetting it lets them act. */
function heldPassForgotten<C extends string>(state: GardenState<C>): GardenState<C> {
  return state.lastPass?.landed === undefined ? { ...state, lastPass: undefined } : state;
}

/** One pass of the gardener `spec` describes, over a synchronous workspace port. Returns what it did. */
export function runGarden<C extends string, I, A extends GardenAction<C>, W extends GardenCheckout>(
  spec: GardenSpec<C, I, A, W>,
  deps: GardenerDeps<W>,
): GardenPassResult<C, A> {
  return runStepsSyncOnly(gardenPassSteps(spec, deps));
}

/** {@link runGarden} with its checkout made, landed and disposed off the event loop (W1-T5740): the
 *  same steps, so the same rows, state and refusals. */
export function runGardenAsync<C extends string, I, A extends GardenAction<C>, W extends GardenCheckout>(
  spec: GardenSpec<C, I, A, W>,
  deps: GardenerDeps<W, PrState | Promise<PrState>>,
): Promise<GardenPassResult<C, A>> {
  return runStepsAsync(gardenPassSteps(spec, deps));
}

function* gardenPassSteps<C extends string, I, A extends GardenAction<C>, W extends GardenCheckout>(
  spec: GardenSpec<C, I, A, W>,
  deps: GardenerDeps<W, PrState | Promise<PrState>>,
): Steps<GardenPassResult<C, A>> {
  try {
    return yield* gardenPassBody(spec, deps);
  } finally {
    notePendingWatch(spec.name, spec.classes, deps);
  }
}

function* gardenPassBody<C extends string, I, A extends GardenAction<C>, W extends GardenCheckout>(
  spec: GardenSpec<C, I, A, W>,
  deps: GardenerDeps<W, PrState | Promise<PrState>>,
): Steps<GardenPassResult<C, A>> {
  const statePath = gardenStatePath(deps.stateDir, spec.name);
  let state = readGardenState(statePath, spec.classes);
  // The overseer's verdicts reach the Beta record here, at the start of a pass, from a file it owns.
  const effectsPath = gardenEffectsPath(deps.stateDir, spec.name);
  const pendingEffects = readGardenEffects(effectsPath);
  if (pendingEffects.length > 0) {
    const folded = foldGardenEffects(state, pendingEffects);
    state = folded.state;
    writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
    if (folded.remaining.length > 0) writeGardenEffects(effectsPath, folded.remaining);
    else rmSync(effectsPath, { force: true });
    if (folded.applied.length > 0) deps.log(`${spec.name}.gardener_effects_folded`, { verdicts: folded.applied.map((e) => `${e.kind}:${e.verdict}:${e.actionClass}`), classes: state.classes });
  }
  if ((gardenFilingRetryAt(state.filingFailures) ?? 0) > (deps.clock ?? systemClock).now()) return { ran: false };
  const cheap = spec.cheapFingerprint();
  const clock = deps.clock ?? systemClock;
  const pendingBefore = state.pending;
  const prState = pendingBefore ? (yield* step(() => deps.prState?.(pendingBefore.prUrl) ?? "unknown")) : undefined;
  if (pendingBefore && judgedByDecision(spec, pendingBefore.actionClass) && prState === "open" && state.pendingRecordedAt === undefined) {
    state = { ...state, pendingRecordedAt: clock.iso() };
    writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
  }
  // Closing any PR is a debit, and a reviewed class credits its merge; neither needs a corpus read.
  if (pendingBefore && (prState === "closed" || (judgedByDecision(spec, pendingBefore.actionClass) && prState === "merged"))) {
    const judged = judgeGardenDecision(state, prState);
    state = heldPassForgotten(judged.state);
    deps.log(`${spec.name}.gardener_judged`, { verdict: judged.verdict, classes: state.classes });
    if (state.lastCheap === cheap) {
      writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
      return { ran: false };
    }
  }
  // A metric class needs one inventory at merge to pin its baseline. Later observations follow
  // the cheap input cadence even when the action fingerprint stays the same. An open or unreadable
  // PR within its backstop need not force an expensive read.
  const metricPending = state.pending && !judgedByDecision(spec, state.pending.actionClass) && prState === "merged" ? state.pending : undefined;
  const terminalMetric = metricPending !== undefined && !metricPending.atMerge;
  // A frozen metric's release (or its first stamp) is due on the clock, not on a changed input.
  const releaseDue = metricPending?.atMerge !== undefined &&
    (!metricPending.mergeSeenAt || clock.now() - Date.parse(metricPending.mergeSeenAt) >= GARDEN_PENDING_RELEASE_MS);
  const decisionReleaseDue = state.pending && judgedByDecision(spec, state.pending.actionClass) && prState === "open" &&
    state.pendingRecordedAt !== undefined && clock.now() - Date.parse(state.pendingRecordedAt) >= GARDEN_DECISION_PENDING_RELEASE_MS;
  if (state.lastCheap === cheap && !terminalMetric && !releaseDue && !decisionReleaseDue) return { ran: false };
  // An inventory that threw over these same inputs throws again; it is retried on a growing wait, and at
  // once when an input changes.
  const failure = readGardenInventoryFailure(deps.stateDir, spec.name);
  if (inventoryFailureHolds(failure, cheap, clock.now())) return { ran: false };
  const failurePath = gardenInventoryFailurePath(deps.stateDir, spec.name);
  let inventory: I;
  try {
    inventory = spec.inventory();
  } catch (e) {
    const at = clock.iso();
    const streak: GardenInventoryFailure = { cheap, firstAt: failure?.firstAt ?? at, lastAt: at, count: (failure?.count ?? 0) + 1,
      reason: String((e as Error)?.message ?? e) };
    writeAtomic(failurePath, JSON.stringify(streak, null, 2) + "\n");
    throw e;
  }
  if (failure !== undefined) rmSync(failurePath, { force: true });
  const fingerprint = spec.fingerprint(inventory);
  if (state.pending) {
    const held = state.pending;
    const recordedAt = state.pendingRecordedAt;
    const judged = judgedByDecision(spec, held.actionClass)
      ? judgeGardenDecision(state, prState ?? "unknown", clock)
      : judgeGardenPending(state, metricOf(spec, inventory, held.actionClass), prState ?? "unknown", clock);
    state = judged.state.pending ? judged.state : heldPassForgotten(judged.state);
    if (judged.verdict === "credit" || judged.verdict === "debit") deps.log(`${spec.name}.gardener_judged`, { verdict: judged.verdict, classes: state.classes });
    if (judged.verdict === "released") {
      const decision = judgedByDecision(spec, held.actionClass);
      deps.log(`${spec.name}.pending_released`, {
        pr_url: held.prUrl, action_class: held.actionClass,
        waited_ms: clock.now() - Date.parse((decision ? recordedAt : held.mergeSeenAt)!),
        bound_ms: decision ? GARDEN_DECISION_PENDING_RELEASE_MS : GARDEN_PENDING_RELEASE_MS,
        ...(decision ? { reason: `open PR ${held.prUrl} exceeded the decision backstop` } : {}),
      });
    }
  }
  const trusted = state.pending !== undefined || state.lastPass?.landed !== undefined || !spec.unfinished?.(inventory);
  if (state.lastPass?.fingerprint === fingerprint && trusted) {
    writeAtomic(statePath, JSON.stringify({ ...state, lastCheap: cheap }, null, 2) + "\n");
    return { ran: false };
  }
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
      const ws = yield* step<W | GardenCheckoutAsync<W>>(() => deps.openWorkspace());
      try {
        // A spec's apply only writes the tree; landing and disposal stay with the pass, awaited or not.
        const landing = spec.apply(ws as unknown as W, plan, scorecard);
        const refused = landing && spec.landingRefusal?.(ws.root, landing.paths);
        if (refused) throw new Error(`${spec.name} gardener: drafted shard failed lint-plan's machine-filing admission (${refused})`);
        if (landing) {
          const why = spec.review?.[acting];
          prUrl = yield* step(() => ws.land(why ? { ...landing, body: judgedByOutcomeNote(spec.name, acting, why) + landing.body } : landing));
        }
      } finally {
        yield* step(() => ws.dispose());
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
  const baseline = (c: C): Outcome => (judgedByDecision(spec, c) ? { trials: 0, successes: 0 } : metricOf(spec, inventory, c));
  const pending = prUrl && acting !== undefined ? { prUrl, actionClass: acting, baseline: baseline(acting) } : state.pending;
  const pendingRecordedAt = prUrl && acting !== undefined ? (judgedByDecision(spec, acting) ? clock.iso() : undefined) : state.pendingRecordedAt;
  const lastPass = prUrl ? { fingerprint, landed: prUrl } : { fingerprint };
  writeAtomic(statePath, JSON.stringify({ ...state, pending, pendingRecordedAt, lastCheap: cheap, lastPass, filingFailures: undefined }, null, 2) + "\n");
  return { ran: true, plan, prUrl, scorecard };
}

/** Run passes on their own timer beside the main loop, never two at once. */
export function startGarden<C extends string, I, A extends GardenAction<C>, W extends GardenCheckout>(
  spec: GardenSpec<C, I, A, W>,
  deps: GardenerDeps<W, PrState | Promise<PrState>>,
  intervalMs: number,
): { stop: () => void } {
  let running = false;
  const failed = (e: unknown) => {
    // An unreadable state file also names its path and failure class, so the row says what to repair.
    const unreadable = e instanceof GardenStateUnreadableError || e instanceof GardenEffectsUnreadableError ? { path: e.path, failure_class: e.failureClass } : {};
    deps.log(`${spec.name}.gardener_failed`, { error: String((e as Error)?.message ?? e), ...unreadable });
  };
  const done = () => {
    running = false;
  };
  // W1-T5740: a pass over the daemon's async port holds `running` until its awaited checkout settles.
  const tick = () => {
    if (running) return;
    running = true;
    try {
      const pass = runStepsEager(gardenPassSteps(spec, deps));
      if (isPromiseLike(pass)) return void Promise.resolve(pass).catch(failed).finally(done);
    } catch (e) {
      // A pass that throws before its first await is ledgered here, as an awaited one's rejection is above.
      failed(e);
    }
    done();
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
