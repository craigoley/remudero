import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ciFrictionCauseKey, ciFrictionOrigin, CI_FRICTION_REMEDIES_FILE, type CiFrictionCause } from "./ci-friction-gardener.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import type { Escalation } from "./escalate.js";
import { writeAtomic } from "./fs-race-safe.js";
import { gardenEffectsPath, gardenStatePath, readGardenEffects, writeGardenEffects, type GardenEffect, type PrState } from "./gardener.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";

/**
 * lib/gardener-overseer.ts (W1-T4802) — the gardener that watches every gardener.
 *
 * Until now nothing read what the gardeners write: selector-shadow failed 513 times in four days,
 * ci-friction sat inert for four days, and the test gardener merged near-identical proposals hourly,
 * each merge crediting its class. The overseer is ONE reader over the evidence they already leave —
 * `<name>.scorecard`, `.gardener_failed`, `.garden_filing_failed`, `.garden_filing_escalated`,
 * `.gardener_judged` ledger rows and `state/<name>-gardener.json` — read through the ledger union.
 * No gardener list is hard-coded: a new gardener is watched from its first row.
 *
 * LIVENESS answers in three self-healing tiers, one per pass of an episode, with no fixed thresholds:
 * NOTICE (ledger), HEAL (clear `lastCheap` and a `lastPass` that landed nothing, so the next pass
 * re-reads its inventory), ESCALATE once, only if the failure or silence persists after the heal.
 * Silence is judged against the gardener's OWN median gap between rows.
 * EFFECT and CHURN never touch another gardener's state file — that races its pass. They are written
 * to `state/<name>-gardener-effects.json`, which `runGarden` folds into its Beta record.
 * OFF SWITCH: `state/GARDENER_OVERSEER_OFF`.
 */

type Row = Record<string, unknown>;

export const GARDENER_OVERSEER_OFF = "GARDENER_OVERSEER_OFF";
const OVERSEER_NAME = "gardener_overseer";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** A gardener is silent once it has been quiet for this many of ITS OWN cadences. */
const SILENCE_CADENCES = 3;
/** A cadence needs this many observed gaps before silence can be judged against it. */
const MIN_GAPS = 3;
/** Two merges of near-identical changes are churn while they land within this many cadences. */
const CHURN_CADENCES = 2;
const KEEP_MS = 30 * DAY_MS;
/** How far back the production reader looks: the weekly scorecard plus a cadence's worth of history. */
export const OVERSEER_LEDGER_WINDOW_MS = 14 * DAY_MS;
export const OVERSEER_MIN_INTERVAL_MS = HOUR_MS;

/** The ledger lines the overseer reads — a raw-line prefilter, so the union is not parsed whole. */
export const OVERSEER_STEP_PATTERN = /"step":"[^"]*(\.(scorecard|gardener_failed|garden_filing_failed|garden_filing_escalated|gardener_judged)|evidence_coverage\.pass)"/;

type EventKind = "pass" | "failed" | "filing_failed" | "filing_escalated" | "judged";
const KIND_BY_SUFFIX: Record<string, EventKind> = {
  scorecard: "pass",
  gardener_failed: "failed",
  garden_filing_failed: "filing_failed",
  garden_filing_escalated: "filing_escalated",
  gardener_judged: "judged",
};

interface GardenerEvent {
  at: number;
  kind: EventKind;
  row: Row;
}

/** Which gardener and what kind of evidence a ledger step is, or `undefined` for any other step. */
export function classifyGardenerStep(step: unknown): { name: string; kind: EventKind } | undefined {
  if (typeof step !== "string") return undefined;
  // evidence-coverage names its pass row `.pass`, not `.scorecard`.
  if (step === "evidence_coverage.pass") return { name: "evidence_coverage", kind: "pass" };
  const dot = step.lastIndexOf(".");
  const name = step.slice(0, dot);
  const suffix = step.slice(dot + 1);
  const kind = dot > 0 && Object.hasOwn(KIND_BY_SUFFIX, suffix) ? KIND_BY_SUFFIX[suffix] : undefined;
  return kind && name !== OVERSEER_NAME ? { name, kind } : undefined;
}

/** A gardener PR read from GitHub: where it stands and what it changed. */
export interface GardenerPrInfo {
  state: PrState;
  title: string;
  paths: string[];
  mergedAt?: string;
}

export interface EffectReading {
  /** The targeted cost before the merge and after, in the same unit; lower is better. */
  before: number;
  after: number;
  /** One standard error of `before`. */
  se: number;
}

export interface TrackedGardenerPr {
  gardener: string;
  actionClass: string;
  url: string;
  openedAt: string;
  info?: GardenerPrInfo;
}

export interface GardenerOverseerPorts {
  stateDir: string;
  /** Every gardener ledger row in the look-back window, read through the ledger union. */
  readRows: () => Row[];
  log: (step: string, extra?: Record<string, unknown>) => void;
  /** Raises a persisting failure to a person (escalate.ts); absent, the tier is ledgered only. */
  escalate?: (escalation: Escalation) => string;
  clock?: Clock;
  /** Where a gardener PR stands and what it changed; `undefined` when it cannot be read this pass. */
  prInfo?: (prUrl: string) => GardenerPrInfo | undefined;
  /** What a merged PR did to the cost it targeted; `undefined` when it cannot yet be measured. */
  effectReading?: (pr: TrackedGardenerPr & { mergedAt: string }, rows: readonly Row[]) => EffectReading | undefined;
  /** When the gardener's own state file last changed (ms); an idle pass still touches it. */
  stateMtime?: (name: string) => number | undefined;
}

interface Episode {
  kind: "failure" | "silence";
  since: string;
  healedAt?: string;
  failuresAtHeal?: number;
  escalatedAt?: string;
  /** A filing streak `runGarden` already escalated: it belongs to gardener.ts, not to this tier ladder. */
  owned?: boolean;
}

interface IssuedVerdict {
  id: string;
  gardener: string;
  actionClass: string;
  verdict: "credit" | "debit";
  kind: "effect" | "churn";
  at: string;
}

export interface OverseerState {
  episodes: Record<string, Episode>;
  prs: Record<string, TrackedGardenerPr>;
  verdicts: IssuedVerdict[];
  churnEscalated: Record<string, string>;
  lastScorecardAt?: string;
}

export function overseerStatePath(stateDir: string): string {
  return join(stateDir, "gardener-overseer.json");
}

function emptyState(): OverseerState {
  return { episodes: {}, prs: {}, verdicts: [], churnEscalated: {} };
}

function readOverseerState(path: string): OverseerState {
  if (!existsSync(path)) return emptyState();
  try {
    return { ...emptyState(), ...(JSON.parse(readFileSync(path, "utf8")) as Partial<OverseerState>) };
  } catch (error) {
    // deliberate: an unreadable record restarts the overseer's episodes; the worst case is one
    // repeated NOTICE, and the gardeners' own state is untouched.
    void error;
    return emptyState();
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function tsOf(row: Row): number {
  return typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
}

/** A gardener's own median gap between its rows — its cadence — or `undefined` while too few are seen. */
export function gardenerCadenceMs(atMs: readonly number[]): number | undefined {
  const sorted = [...atMs].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) if (sorted[i]! > sorted[i - 1]!) gaps.push(sorted[i]! - sorted[i - 1]!);
  // Cheap fingerprints bucket by the hour, so a pass cannot be expected more often than that.
  return gaps.length >= MIN_GAPS ? Math.max(median(gaps), HOUR_MS) : undefined;
}

interface Health {
  kind: "failure" | "silence";
  failures: number;
  lastError?: string;
  owned: boolean;
  silenceMs?: number;
}

function groupEvents(rows: readonly Row[]): Map<string, GardenerEvent[]> {
  const byName = new Map<string, GardenerEvent[]>();
  for (const row of rows) {
    const c = classifyGardenerStep(row.step);
    const at = tsOf(row);
    if (!c || Number.isNaN(at)) continue;
    const list = byName.get(c.name) ?? [];
    list.push({ at, kind: c.kind, row });
    byName.set(c.name, list);
  }
  for (const list of byName.values()) list.sort((a, b) => a.at - b.at);
  return byName;
}

function judgeHealth(events: readonly GardenerEvent[], nowMs: number, mtimeMs: number | undefined): { health?: Health; cadence?: number } {
  const cadence = gardenerCadenceMs(events.map((e) => e.at));
  const lastPassAt = events.reduce((m, e) => (e.kind === "pass" ? Math.max(m, e.at) : m), Number.NEGATIVE_INFINITY);
  const since = events.filter((e) => e.at > lastPassAt);
  const failed = since.filter((e) => e.kind === "failed");
  const filing = since.filter((e) => e.kind === "filing_failed");
  if (failed.length + filing.length > 0) {
    const last = [...failed, ...filing].sort((a, b) => a.at - b.at).at(-1)!;
    const lastError = String(last.row.error ?? last.row.reason ?? "");
    const owned = failed.length === 0 && since.some((e) => e.kind === "filing_escalated");
    return { cadence, health: { kind: "failure", failures: failed.length + filing.length, lastError, owned } };
  }
  if (cadence !== undefined) {
    const lastActivity = Math.max(events.at(-1)?.at ?? Number.NEGATIVE_INFINITY, mtimeMs ?? Number.NEGATIVE_INFINITY);
    const silenceMs = nowMs - lastActivity;
    if (silenceMs > SILENCE_CADENCES * cadence) return { cadence, health: { kind: "silence", failures: 0, owned: false, silenceMs } };
  }
  return { cadence };
}

/** Tier 2: clear what makes a skip-if-unchanged pass trust a stale look, so the next pass re-reads. */
export function healGardener(stateDir: string, name: string): { cleared: string[]; unreadable?: string } {
  const path = gardenStatePath(stateDir, name);
  if (!existsSync(path)) return { cleared: [] };
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return { cleared: [], unreadable: String((error as Error)?.message ?? error) };
  }
  const cleared: string[] = [];
  if ("lastCheap" in state) {
    delete state.lastCheap;
    cleared.push("lastCheap");
  }
  const lastPass = state.lastPass as { landed?: string } | undefined;
  if (lastPass && lastPass.landed === undefined) {
    delete state.lastPass;
    cleared.push("lastPass");
  }
  if (cleared.length > 0) writeAtomic(path, JSON.stringify(state, null, 2) + "\n");
  return { cleared };
}

function livenessEscalation(name: string, health: Health): Escalation {
  const what = health.kind === "failure"
    ? `its passes have failed ${health.failures} times in a row`
    : `it has been silent for ${Math.round((health.silenceMs ?? 0) / HOUR_MS)} hours, well past its own cadence`;
  return {
    class: "BLOCKED",
    taskId: `${name}-gardener-liveness`,
    summary: `the ${name} gardener is unhealthy: ${what}`,
    detail: `The gardener overseer noticed, then healed (cleared the gardener's \`lastCheap\` and any \`lastPass\` that landed nothing), and the condition persisted.${health.lastError ? ` Latest error:\n\n${health.lastError}\n\n` : " "}The ledger's \`${name}.gardener_failed\` and \`${name}.scorecard\` rows carry the history.`,
    options: [
      { label: "fix-gardener", detail: "repair what the latest error names; the next pass then recovers on its own" },
      { label: "switch-off", detail: `touch state/${name.toUpperCase()}_OFF-<class> to stop the class` },
    ],
    recommendation: "fix-gardener",
    headDedup: "independent",
  };
}

function nearIdentical(a: GardenerPrInfo, b: GardenerPrInfo): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  if (norm(a.title) !== norm(b.title)) return false;
  const pa = new Set(a.paths);
  const shared = b.paths.filter((p) => pa.has(p)).length;
  const smaller = Math.min(pa.size, new Set(b.paths).size);
  return smaller > 0 && shared / smaller >= 0.5;
}

function churnEscalation(name: string, actionClass: string, run: readonly TrackedGardenerPr[]): Escalation {
  return {
    class: "BLOCKED",
    taskId: `${name}-gardener-churn`,
    summary: `the ${name} gardener's \`${actionClass}\` class keeps merging near-identical changes`,
    detail: `${run.length} merged PRs with titles that differ only in counts and overlapping changed paths landed faster than the class's metric could move, and the overseer's churn debits did not slow it:\n\n${run.map((p) => `- ${p.url} — ${p.info?.title ?? ""}`).join("\n")}`,
    options: [
      { label: "fix-class", detail: "make the class's action idempotent, or its fingerprint sensitive to the thing that changed" },
      { label: "switch-off", detail: `touch state/${name.toUpperCase()}_OFF-${actionClass} to stop the class` },
    ],
    recommendation: "fix-class",
    headDedup: "independent",
  };
}

function scorecardRow(
  rows: readonly Row[],
  events: Map<string, GardenerEvent[]>,
  state: OverseerState,
  stateDir: string,
  nowMs: number,
  churnByGardener: Map<string, number>,
  stateNames: readonly string[],
): Record<string, unknown> {
  const from = nowMs - WEEK_MS;
  const names = new Set<string>([...events.keys(), ...stateNames]);
  const gardeners: Record<string, unknown> = {};
  for (const name of [...names].sort()) {
    const week = (events.get(name) ?? []).filter((e) => e.at >= from);
    const stamps = [from, ...week.map((e) => e.at), nowMs].sort((a, b) => a - b);
    let longest = 0;
    for (let i = 1; i < stamps.length; i++) longest = Math.max(longest, stamps[i]! - stamps[i - 1]!);
    const prs = Object.values(state.prs).filter((p) => p.gardener === name && Date.parse(p.openedAt) >= from);
    const verdicts = state.verdicts.filter((v) => v.gardener === name && Date.parse(v.at) >= from);
    const means: Record<string, number> = {};
    const path = gardenStatePath(stateDir, name);
    if (existsSync(path)) {
      try {
        const classes = (JSON.parse(readFileSync(path, "utf8")) as { classes?: Record<string, { alpha: number; beta: number }> }).classes ?? {};
        for (const [c, r] of Object.entries(classes)) means[c] = Math.round((r.alpha / (r.alpha + r.beta)) * 1000) / 1000;
      } catch (error) {
        // deliberate: an unreadable state file leaves its class means out of the row, never the row itself.
        void error;
      }
    }
    gardeners[name] = {
      passes: week.filter((e) => e.kind === "pass").length,
      failures: week.filter((e) => e.kind === "failed" || e.kind === "filing_failed").length,
      longest_silence_ms: longest,
      prs_opened: prs.length,
      prs_merged: prs.filter((p) => p.info?.state === "merged").length,
      prs_closed: prs.filter((p) => p.info?.state === "closed").length,
      effect_credits: verdicts.filter((v) => v.kind === "effect" && v.verdict === "credit").length,
      effect_debits: verdicts.filter((v) => v.kind === "effect" && v.verdict === "debit").length,
      churn_episodes: churnByGardener.get(name) ?? 0,
      class_beta_means: means,
    };
  }
  return { window_days: 7, gardeners, rows_read: rows.length };
}

/** Gardener state files present on disk: `<name>-gardener.json`. */
function gardenerNamesOnDisk(stateDir: string): string[] {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir)
    .map((f) => /^(.+)-gardener\.json$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined);
}

export interface OverseerPass {
  ran: boolean;
  gardeners: string[];
}

/** One pass of the overseer. */
export function runGardenerOverseer(deps: GardenerOverseerPorts): OverseerPass {
  if (existsSync(join(deps.stateDir, GARDENER_OVERSEER_OFF))) return { ran: false, gardeners: [] };
  const clock = deps.clock ?? systemClock;
  const nowMs = clock.now();
  const statePath = overseerStatePath(deps.stateDir);
  const state = readOverseerState(statePath);
  const rows = deps.readRows();
  const events = groupEvents(rows);
  const diskNames = gardenerNamesOnDisk(deps.stateDir);
  const names = new Set<string>([...events.keys(), ...diskNames]);
  const mtimeOf = deps.stateMtime ?? ((name: string) => {
    const path = gardenStatePath(deps.stateDir, name);
    return existsSync(path) ? statSync(path).mtimeMs : undefined;
  });
  const cadences = new Map<string, number | undefined>();

  // LIVENESS — notice, then heal, then escalate once per episode.
  for (const name of names) {
    const list = events.get(name) ?? [];
    const { health, cadence } = judgeHealth(list, nowMs, mtimeOf(name));
    cadences.set(name, cadence);
    if (!health) {
      delete state.episodes[name];
      continue;
    }
    const episode = state.episodes[name];
    if (!episode || episode.kind !== health.kind) {
      state.episodes[name] = { kind: health.kind, since: clock.iso(), ...(health.owned ? { owned: true } : {}) };
      deps.log(health.owned ? `${OVERSEER_NAME}.deferred` : `${OVERSEER_NAME}.noticed`, {
        gardener: name,
        kind: health.kind,
        failures: health.failures,
        silence_ms: health.silenceMs ?? null,
        last_error: health.lastError ?? null,
        note: health.owned ? "a filing streak gardener.ts already escalated" : undefined,
      });
      continue;
    }
    if (health.owned) {
      episode.owned = true;
      continue;
    }
    if (episode.healedAt === undefined) {
      const healed = healGardener(deps.stateDir, name);
      episode.healedAt = clock.iso();
      episode.failuresAtHeal = health.failures;
      deps.log(`${OVERSEER_NAME}.healed`, { gardener: name, kind: health.kind, cleared: healed.cleared, unreadable: healed.unreadable ?? null });
      continue;
    }
    if (episode.escalatedAt !== undefined) continue;
    const persists = health.kind === "failure"
      ? health.failures > (episode.failuresAtHeal ?? 0)
      : nowMs - Date.parse(episode.healedAt) > (cadence ?? HOUR_MS);
    if (!persists || !deps.escalate) continue;
    const issueUrl = deps.escalate(livenessEscalation(name, health));
    episode.escalatedAt = clock.iso();
    deps.log(`${OVERSEER_NAME}.escalated`, { gardener: name, kind: health.kind, issue_url: issueUrl, last_error: health.lastError ?? null });
  }
  for (const name of Object.keys(state.episodes)) if (!names.has(name)) delete state.episodes[name];

  // Gardener PRs, discovered from the scorecard rows that name one.
  for (const [name, list] of events) {
    for (const e of list) {
      const url = e.row.pr_url;
      if (e.kind !== "pass" || typeof url !== "string" || state.prs[url]) continue;
      const acting = Array.isArray(e.row.acting) ? e.row.acting[0] : undefined;
      state.prs[url] = { gardener: name, actionClass: typeof acting === "string" ? acting : "", url, openedAt: fixedClock(e.at).iso() };
    }
  }
  for (const [url, pr] of Object.entries(state.prs)) {
    if (nowMs - Date.parse(pr.openedAt) > KEEP_MS) {
      delete state.prs[url];
      continue;
    }
    if (pr.info && pr.info.state !== "open" && pr.info.state !== "unknown") continue;
    const info = deps.prInfo?.(url);
    if (info) pr.info = info;
  }
  state.verdicts = state.verdicts.filter((v) => nowMs - Date.parse(v.at) <= KEEP_MS);

  const issued = new Map<string, GardenEffect[]>();
  const issue = (v: Omit<IssuedVerdict, "at">): void => {
    const at = clock.iso();
    state.verdicts.push({ ...v, at });
    const list = issued.get(v.gardener) ?? [];
    list.push({ id: v.id, actionClass: v.actionClass, verdict: v.verdict, kind: v.kind, at });
    issued.set(v.gardener, list);
  };
  const hasVerdict = (id: string): IssuedVerdict | undefined => state.verdicts.find((v) => v.id === id);

  // EFFECT — a merged change whose targeted cost fell beyond one standard error credits its class; a rise debits it.
  const merged = Object.values(state.prs).filter((p): p is TrackedGardenerPr & { info: GardenerPrInfo & { mergedAt: string } } => p.info?.state === "merged" && typeof p.info.mergedAt === "string" && p.actionClass !== "");
  for (const pr of merged) {
    const id = `effect:${pr.url}`;
    if (hasVerdict(id)) continue;
    const reading = deps.effectReading?.({ ...pr, mergedAt: pr.info.mergedAt }, rows);
    if (!reading) continue;
    const verdict = reading.before - reading.after > reading.se ? "credit" : reading.after - reading.before > reading.se ? "debit" : undefined;
    if (!verdict) continue;
    issue({ id, gardener: pr.gardener, actionClass: pr.actionClass, verdict, kind: "effect" });
    deps.log(`${OVERSEER_NAME}.effect_verdict`, { gardener: pr.gardener, class: pr.actionClass, pr_url: pr.url, verdict, before: reading.before, after: reading.after, se: reading.se });
  }

  // CHURN — near-identical merges from one gardener and class, landing faster than its metric could move.
  const churnEpisodes = new Map<string, number>();
  const groups = new Map<string, typeof merged>();
  for (const pr of merged) {
    const key = `${pr.gardener}\u0000${pr.actionClass}`;
    groups.set(key, [...(groups.get(key) ?? []), pr]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => Date.parse(a.info.mergedAt) - Date.parse(b.info.mergedAt));
    const windowMs = CHURN_CADENCES * Math.max(cadences.get(group[0]!.gardener) ?? 0, HOUR_MS);
    let run: typeof group = [];
    for (const pr of group) {
      const prev = run.at(-1);
      run = prev && nearIdentical(prev.info, pr.info) && Date.parse(pr.info.mergedAt) - Date.parse(prev.info.mergedAt) < windowMs ? [...run, pr] : [pr];
      if (run.length < 2) continue;
      const id = `churn:${pr.url}`;
      if (!hasVerdict(id)) {
        issue({ id, gardener: pr.gardener, actionClass: pr.actionClass, verdict: "debit", kind: "churn" });
        if (run.length === 2) churnEpisodes.set(pr.gardener, (churnEpisodes.get(pr.gardener) ?? 0) + 1);
        deps.log(`${OVERSEER_NAME}.churn`, { gardener: pr.gardener, class: pr.actionClass, pr_url: pr.url, run: run.length, title: pr.info.title });
      }
      // The debits were already in effect when this repeat merged, and it landed anyway.
      const head = run[0]!.url;
      const slowed = run.slice(1, -1).some((p) => {
        const v = hasVerdict(`churn:${p.url}`);
        return v !== undefined && Date.parse(v.at) < Date.parse(pr.info.mergedAt);
      });
      if (slowed && !state.churnEscalated[head] && deps.escalate) {
        const issueUrl = deps.escalate(churnEscalation(pr.gardener, pr.actionClass, run));
        state.churnEscalated[head] = clock.iso();
        deps.log(`${OVERSEER_NAME}.churn_escalated`, { gardener: pr.gardener, class: pr.actionClass, run: run.length, issue_url: issueUrl });
      }
    }
  }
  for (const [name, list] of issued) {
    const path = gardenEffectsPath(deps.stateDir, name);
    writeGardenEffects(path, [...readGardenEffects(path), ...list]);
  }

  // WEEKLY SCORECARD — every gardener seen in the ledger or on disk.
  if (state.lastScorecardAt === undefined || nowMs - Date.parse(state.lastScorecardAt) >= WEEK_MS) {
    deps.log(`${OVERSEER_NAME}.scorecard`, scorecardRow(rows, events, state, deps.stateDir, nowMs, churnEpisodes, diskNames));
    state.lastScorecardAt = clock.iso();
  }
  writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
  return { ran: true, gardeners: [...names].sort() };
}

/** The overseer on its own timer beside the other gardens: never two passes at once, a catch that ledgers.
 *  It reads the ledger union, so it never runs more often than {@link OVERSEER_MIN_INTERVAL_MS} however
 *  fast the daemon polls (the ledger-reading gardens measured 57 s of every 300 s on the event loop). */
export function startGardenerOverseer(deps: GardenerOverseerPorts, intervalMs: number): { stop: () => void } {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      runGardenerOverseer(deps);
    } catch (e) {
      deps.log(`${OVERSEER_NAME}.overseer_failed`, { error: String((e as Error)?.message ?? e) });
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, Math.max(intervalMs, OVERSEER_MIN_INTERVAL_MS));
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * What a merged ci-friction `draft` did to the cost it named: the filing pass's own priced minutes for
 * the cause versus the latest pass's, read only once the filed task's remedy has landed. Other
 * gardeners are judged by their own `GardenSpec.metric` inside `runGarden`.
 */
export function ciFrictionEffectReading(
  pr: { gardener: string; url: string; mergedAt: string },
  rows: readonly Row[],
  remedyLanded: (origin: string) => boolean,
): EffectReading | undefined {
  if (pr.gardener !== "ci-friction") return undefined;
  const cards = rows.filter((r) => r.step === "ci-friction.scorecard");
  const filing = cards.find((r) => r.pr_url === pr.url);
  const key = typeof filing?.untracked === "string" ? filing.untracked : undefined;
  if (!filing || !key) return undefined;
  const minutesOf = (row: Row): { cause: CiFrictionCause; minutes: number; rounds: number } | undefined => {
    const priced = Array.isArray(row.priced) ? (row.priced as Array<{ cause: CiFrictionCause; minutes: number; rounds: number }>) : [];
    return priced.find((p) => ciFrictionCauseKey(p.cause) === key);
  };
  const before = minutesOf(filing);
  if (!before || !remedyLanded(ciFrictionOrigin(before.cause))) return undefined;
  const latest = cards.filter((r) => tsOf(r) > Date.parse(pr.mergedAt)).sort((a, b) => tsOf(a) - tsOf(b)).at(-1);
  if (!latest) return undefined;
  return { before: before.minutes, after: minutesOf(latest)?.minutes ?? 0, se: before.minutes / Math.sqrt(Math.max(before.rounds, 1)) };
}

/** The production wiring: the ledger union, GitHub REST for PRs, and the ci-friction remedies file. */
export function productionGardenerOverseerPorts(opts: {
  stateDir: string;
  repoRoot: string;
  owner: string;
  repo: string;
  fetch: (args: string[]) => unknown;
  log: GardenerOverseerPorts["log"];
  escalate?: GardenerOverseerPorts["escalate"];
  clock?: Clock;
}): GardenerOverseerPorts {
  const clock = opts.clock ?? systemClock;
  const remedyLanded = (origin: string): boolean => {
    const path = join(opts.repoRoot, CI_FRICTION_REMEDIES_FILE);
    return existsSync(path) && readFileSync(path, "utf8").includes(origin);
  };
  return {
    stateDir: opts.stateDir,
    log: opts.log,
    escalate: opts.escalate,
    clock,
    readRows: () => {
      const since = fixedClock(clock.now() - OVERSEER_LEDGER_WINDOW_MS).iso();
      return readLedgerUnionRecordsSync(opts.stateDir, { since, pattern: OVERSEER_STEP_PATTERN, rotationWindowMs: OVERSEER_LEDGER_WINDOW_MS, minRotations: 2 }).rows;
    },
    prInfo: (url) => {
      const n = /\/pull\/(\d+)/.exec(url)?.[1];
      if (!n) return undefined;
      try {
        const pr = opts.fetch(["api", `repos/${opts.owner}/${opts.repo}/pulls/${n}`]) as { merged?: boolean; state?: string; title?: string; merged_at?: string | null };
        const state: PrState = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
        if (state === "open") return { state, title: pr.title ?? "", paths: [] };
        const files = opts.fetch(["api", `repos/${opts.owner}/${opts.repo}/pulls/${n}/files?per_page=100`]) as Array<{ filename?: string }>;
        return { state, title: pr.title ?? "", paths: files.map((f) => f.filename).filter((f): f is string => typeof f === "string"), ...(pr.merged_at ? { mergedAt: pr.merged_at } : {}) };
      } catch (error) {
        opts.log(`${OVERSEER_NAME}.pr_unreadable`, { pr_url: url, error: String((error as Error)?.message ?? error) });
        return undefined;
      }
    },
    effectReading: (pr, rows) => ciFrictionEffectReading(pr, rows, remedyLanded),
  };
}
