/**
 * The shadow comparator (Phase 1 design §5, P1-14). While a view's switch reads `shadow`, serve samples
 * its requests (one per minute per key), and the read-model worker diffs the legacy computation against
 * the read-model body, structurally and field by field. Each differing path is classified:
 *
 * - `dedupe`: the legacy reader counted duplicate rows, which the projector dedupes at ingestion;
 * - `timing`: the two sides read their sources at different ages, and ledger rows landed in between;
 * - `legacy_horizon`: operator ruling Q1, the view is right and a row older than legacy's retention
 *   horizon names the entity;
 * - `real`: nothing above explains it, so it is a bug. A diff no evidence explains is never waved through.
 *
 * A count carries no ids of its own, so the legacy side names its MEMBERS: the entity each side counted,
 * one entry per counted row. Each id the two sides count differently is judged on its own measured rows,
 * and one id nothing explains makes the whole count `real`. A count with no members is `real`.
 *
 * Every sample with a diff writes one `view.shadow_diff` ledger row naming each path and its class. Each
 * view keeps a persisted counter and a cutover-readiness summary, shown by the `read-model` status view.
 *
 * The request path never pays for this: the route only notes the request after its response finished,
 * the legacy side is computed on a deferred turn, and the diff and its evidence run in the worker.
 */
import { systemClock, type Clock } from "./clock.js";
import { withWriteTransaction, type ReadModelDb, type ReadModelLease } from "./read-model-db.js";
import { renderView, type ReadModelViewRoutesOptions, type ViewDefinition } from "./views.js";

export const VIEW_SHADOW_DIFF_STEP = "view.shadow_diff";
/** Design §5: a sampled comparator, one comparison per minute per view key. */
export const VIEW_SHADOW_SAMPLE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
/**
 * The rule of three: zero failures in n independent samples bounds the failure rate below 3/n at 95%.
 * A view is ready when that bound, times its measured daily traffic, is under one wrong response a day.
 */
const RULE_OF_THREE = 3;
const ID_KEYS = ["taskId", "task_id", "instanceId", "id", "repo", "prNumber", "number", "name", "key"] as const;
/** Build and freshness stamps: they differ on every recompute, so they are never a diff. */
const TIME_KEYS: ReadonlySet<string> = new Set(["generatedAt", "generated_at", "asOf", "as_of"]);
const TIME_LEAF = /(At|_at|Ms|_ms|Age|_age)$/;

export type ShadowClassification = "legacy_horizon" | "timing" | "dedupe" | "real";
export const SHADOW_CLASSIFICATIONS: readonly ShadowClassification[] = ["legacy_horizon", "timing", "dedupe", "real"];

export interface ShadowFieldDiff {
  path: string;
  legacy: unknown;
  view: unknown;
  /** The entity ids the path passes through, plus the elements two id lists disagree on. */
  ids: string[];
  /** A count's members, when the legacy side measured them for this path. */
  members?: ShadowMembers;
  /** A sum's rows, when the legacy side measured them for this path. */
  sum?: ShadowSum;
  /** The row a latest-time value is, on each side. */
  latest?: ShadowLatest;
}

/** The rows each side added into one sum, `[identity, amount]`; `precision` is the rounding the value carries. */
export interface ShadowSum {
  legacy: ReadonlyArray<readonly [string, number]>;
  view: ReadonlyArray<readonly [string, number]>;
  precision?: number;
}

/** The row (`<entity>#<row>`) whose time each side reports as a latest-time value. */
export interface ShadowLatest {
  legacy: string | null;
  view: string | null;
}

/** The entity ids each side counted at one aggregate path, one entry per counted row. A member
 *  `<id>#<row>` names the entity `<id>` and one row of it, so a row counted twice is a duplicate. */
export interface ShadowMembers {
  legacy: readonly string[];
  view: readonly string[];
}

export interface ShadowEvidence {
  legacyAsOfMs: number | null;
  viewAsOfMs: number | null;
  legacyHorizonMs?: number;
  /** Of the diff's ids, the ones any ledger row names; an id no row names says nothing. */
  named: ReadonlySet<string>;
  namedBeforeHorizon: ReadonlySet<string>;
  namedInGap: ReadonlySet<string>;
  /** Ledger rows stamped between the two sides' as-of times. */
  rowsInGap: number;
  /** What the legacy reader counted more than once, when it reports it. */
  duplicateIds: ReadonlySet<string>;
  duplicateRows: number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayKey(items: readonly unknown[]): string | undefined {
  if (items.length === 0 || !items.every(isRecord)) return undefined;
  return ID_KEYS.find((k) => items.every((item) => ["string", "number"].includes(typeof (item as Record<string, unknown>)[k])));
}

function uniqueBy(items: readonly unknown[], k: string): Map<string, unknown> | undefined {
  const out = new Map<string, unknown>();
  for (const item of items) {
    const id = String((item as Record<string, unknown>)[k]);
    if (out.has(id)) return undefined;
    out.set(id, item);
  }
  return out;
}

function walk(a: unknown, b: unknown, path: string, ids: string[], out: ShadowFieldDiff[]): void {
  if (canonical(a) === canonical(b)) return;
  if (isRecord(a) && isRecord(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!TIME_KEYS.has(k)) walk(a[k], b[k], path ? `${path}.${k}` : k, ids, out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const k = arrayKey([...a, ...b]);
    const left = k === undefined ? undefined : uniqueBy(a, k);
    const right = k === undefined ? undefined : uniqueBy(b, k);
    if (k !== undefined && left && right) {
      for (const id of [...new Set([...left.keys(), ...right.keys()])]) walk(left.get(id), right.get(id), `${path}[${k}=${id}]`, [...ids, id], out);
      return;
    }
    if (a.every((x) => !isRecord(x) && !Array.isArray(x)) && b.every((x) => !isRecord(x) && !Array.isArray(x))) {
      const inA = new Set(a.map(String));
      const inB = new Set(b.map(String));
      const differ = [...new Set([...inA, ...inB])].filter((x) => inA.has(x) !== inB.has(x));
      out.push({ path, legacy: a, view: b, ids: [...ids, ...differ] });
      return;
    }
    if (a.length === b.length) {
      a.forEach((x, i) => walk(x, b[i], `${path}[${i}]`, ids, out));
      return;
    }
  }
  out.push({ path, legacy: a, view: b, ids });
}

/** Every path where the view's `data` differs from legacy's, times ignored; array items match by id. */
export function diffViewData(legacy: unknown, view: unknown): ShadowFieldDiff[] {
  const out: ShadowFieldDiff[] = [];
  walk(legacy, view, "", [], out);
  return out;
}

function hasDuplicates(values: readonly unknown[]): boolean {
  return new Set(values.map(canonical)).size < values.length;
}

function uniqueInOrder(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((v) => !seen.has(canonical(v)) && Boolean(seen.add(canonical(v))));
}

function tally(ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

/** The ids the two sides counted a different number of times. */
export function memberDelta(members: ShadowMembers): string[] {
  const l = tally(members.legacy);
  const v = tally(members.view);
  return [...new Set([...l.keys(), ...v.keys()])].filter((id) => (l.get(id) ?? 0) !== (v.get(id) ?? 0)).sort();
}

const entityOf = (member: string): string => member.split("#")[0]!;

/** The entities whose rows the evidence must be read for: those of every differing member. */
export function memberEntities(members: ShadowMembers): string[] {
  return [...new Set(memberDelta(members).map(entityOf))];
}

/**
 * A count diff, explained id by id from its measured members: legacy's extra counts of one id are
 * `dedupe`; an id only one side counts is `timing` when a row between the two ages names it, else
 * `legacy_horizon` when a row older than the horizon names it. Any unexplained id makes it `real`.
 */
function classifyAggregate(legacy: number, view: number, members: ShadowMembers, ev: ShadowEvidence): { classification: ShadowClassification; reason: string } {
  if (members.legacy.length !== legacy || members.view.length !== view) {
    return { classification: "real", reason: `the measured members (${members.legacy.length} legacy, ${members.view.length} view) do not account for ${legacy} vs ${view}` };
  }
  const l = tally(members.legacy);
  const v = tally(members.view);
  const units: Record<ShadowClassification, number> = { dedupe: 0, timing: 0, legacy_horizon: 0, real: 0 };
  const unexplained: string[] = [];
  for (const id of memberDelta(members)) {
    const dl = l.get(id) ?? 0;
    const dv = v.get(id) ?? 0;
    if (dv > 1) {
      units.real += Math.abs(dv - dl);
      unexplained.push(id);
      continue;
    }
    units.dedupe += Math.max(0, dl - 1);
    if (Math.min(dl, 1) === dv) continue;
    const entity = entityOf(id);
    const cls: ShadowClassification = ev.namedInGap.has(entity) ? "timing"
      : ev.legacyHorizonMs !== undefined && ev.namedBeforeHorizon.has(entity) ? "legacy_horizon" : "real";
    units[cls]++;
    if (cls === "real") unexplained.push(id);
  }
  const breakdown = SHADOW_CLASSIFICATIONS.filter((c) => units[c] > 0).map((c) => `${units[c]} ${c}`).join(", ");
  if (units.real > 0) return { classification: "real", reason: `no measured row explains ${unexplained.join(" ")} (${breakdown})` };
  const top = (["dedupe", "timing", "legacy_horizon"] as const).reduce((a, b) => (units[b] > units[a] ? b : a));
  return { classification: top, reason: `every counted row differing is explained (${breakdown})` };
}

function amountsById(rows: ReadonlyArray<readonly [string, number]>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [id, amount] of rows) out.set(id, [...(out.get(id) ?? []), amount]);
  return out;
}

/** The entities of every row one sum's two sides added differently. */
export function sumEntities(sum: ShadowSum): string[] {
  const l = amountsById(sum.legacy);
  const v = amountsById(sum.view);
  const differ = [...new Set([...l.keys(), ...v.keys()])].filter((id) => canonical(l.get(id) ?? []) !== canonical(v.get(id) ?? []));
  return [...new Set(differ.map(entityOf))];
}

/**
 * A sum diff, explained by the rows each side added: a row legacy added again with the same amount is
 * `dedupe`; a row only one side added is `timing` or `legacy_horizon` by its entity's rows. Every other
 * amount is the residual, and a residual beyond the value's rounding makes it `real`.
 */
function classifySum(legacy: number, view: number, sum: ShadowSum, ev: ShadowEvidence): { classification: ShadowClassification; reason: string } {
  const tolerance = (sum.precision ?? 0) / 2 + 1e-9;
  const total = (rows: ShadowSum["legacy"]): number => rows.reduce((acc, [, amount]) => acc + amount, 0);
  if (Math.abs(total(sum.legacy) - legacy) > tolerance || Math.abs(total(sum.view) - view) > tolerance) {
    return { classification: "real", reason: `the summed rows (${total(sum.legacy)} legacy, ${total(sum.view)} view) do not account for ${legacy} vs ${view}` };
  }
  const l = amountsById(sum.legacy);
  const v = amountsById(sum.view);
  const amounts: Record<ShadowClassification, number> = { legacy_horizon: 0, timing: 0, dedupe: 0, real: 0 };
  const unexplained: string[] = [];
  for (const id of [...new Set([...l.keys(), ...v.keys()])].sort()) {
    const ls = l.get(id) ?? [];
    const vs = v.get(id) ?? [];
    if (canonical(ls) === canonical(vs)) continue;
    const one = ls[0] ?? vs[0]!;
    if (vs.length > 1 || ![...ls, ...vs].every((amount) => amount === one)) {
      amounts.real += Math.abs(total(ls.map((a) => [id, a])) - total(vs.map((a) => [id, a])));
      unexplained.push(id);
      continue;
    }
    amounts.dedupe += Math.abs(one) * Math.max(0, ls.length - 1);
    if (Math.min(ls.length, 1) === vs.length) continue;
    const entity = entityOf(id);
    const cls: ShadowClassification = ev.namedInGap.has(entity) ? "timing"
      : ev.legacyHorizonMs !== undefined && ev.namedBeforeHorizon.has(entity) ? "legacy_horizon" : "real";
    amounts[cls] += Math.abs(one);
    if (cls === "real") unexplained.push(id);
  }
  const breakdown = SHADOW_CLASSIFICATIONS.filter((c) => amounts[c] > 0).map((c) => `${c} ${amounts[c]}`).join(", ");
  if (amounts.real > tolerance) return { classification: "real", reason: `a residual of ${amounts.real} no measured row explains (${unexplained.join(" ")}; ${breakdown})` };
  const top = (["dedupe", "timing", "legacy_horizon"] as const).reduce((a, b) => (amounts[b] > amounts[a] ? b : a));
  return { classification: top, reason: `every differing row is explained (${breakdown})` };
}

/** A latest-time diff: the later side's row must be one the other side could not yet, or ever, see. */
function classifyLatest(legacy: string, view: string, latest: ShadowLatest, ev: ShadowEvidence): { classification: ShadowClassification; reason: string } {
  const row = Date.parse(view) > Date.parse(legacy) ? latest.view : latest.legacy;
  const entity = row === null ? undefined : entityOf(row);
  if (entity !== undefined && ev.namedInGap.has(entity)) return { classification: "timing", reason: `the later row ${row} landed between the two ages` };
  if (entity !== undefined && ev.legacyHorizonMs !== undefined && ev.namedBeforeHorizon.has(entity)) return { classification: "legacy_horizon", reason: `the later row ${row} names an entity older than the legacy horizon` };
  return { classification: "real", reason: `no measured row explains the later ${row ?? "value"}` };
}

/**
 * Classifies one differing path. Checked in order, each on its own evidence: `dedupe`, then `timing`,
 * then `legacy_horizon`; anything left is `real`. A diff is judged on its own ids or members only, so a
 * busy ledger or a duplicate elsewhere cannot explain away a diff no measured row names.
 */
export function classifyShadowDiff(diff: ShadowFieldDiff, ev: ShadowEvidence): { classification: ShadowClassification; reason: string } {
  const ids = diff.ids.filter((id) => ev.named.has(id));
  const any = (set: ReadonlySet<string>): boolean => ids.some((id) => set.has(id));
  const { legacy, view } = diff;
  if (diff.members && typeof legacy === "number" && typeof view === "number") return classifyAggregate(legacy, view, diff.members, ev);
  if (diff.sum && typeof legacy === "number" && typeof view === "number") return classifySum(legacy, view, diff.sum, ev);
  if (diff.latest && typeof legacy === "string" && typeof view === "string") return classifyLatest(legacy, view, diff.latest, ev);
  if (Array.isArray(legacy) && Array.isArray(view) && hasDuplicates(legacy) && canonical(uniqueInOrder(legacy)) === canonical(view)) {
    return { classification: "dedupe", reason: `legacy lists ${legacy.length - view.length} duplicate element(s)` };
  }
  if (typeof legacy === "number" && typeof view === "number" && legacy > view
    && any(ev.duplicateIds)) {
    return { classification: "dedupe", reason: `legacy counted ${legacy - view} more; it read ${ev.duplicateRows} duplicate row(s)` };
  }
  const agesDiffer = ev.legacyAsOfMs !== null && ev.viewAsOfMs !== null && ev.legacyAsOfMs !== ev.viewAsOfMs;
  const leaf = diff.path.split(/[.[]/).at(-1) ?? "";
  if (agesDiffer && (TIME_LEAF.test(leaf) || any(ev.namedInGap))) {
    return { classification: "timing", reason: `sources ${Math.abs(ev.legacyAsOfMs! - ev.viewAsOfMs!)} ms apart; ${ev.rowsInGap} row(s) landed between` };
  }
  if (ev.legacyHorizonMs !== undefined && any(ev.namedBeforeHorizon)) {
    return { classification: "legacy_horizon", reason: "a row older than the legacy horizon names it (ruling Q1: the view is right)" };
  }
  return { classification: "real", reason: "no horizon, timing or duplicate evidence explains it" };
}

function namedBy(db: ReadModelDb, ids: readonly string[], where: string, params: number[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < ids.length; at += 400) {
    const chunk = ids.slice(at, at + 400);
    const sql = `SELECT DISTINCT task_id FROM fact WHERE task_id IN (${chunk.map(() => "?").join(",")})${where}`;
    for (const row of db.prepare(sql).all(...chunk, ...params)) out.push(String(row.task_id));
  }
  return out;
}

/** The evidence the read model itself holds: which rows name the diff's ids, and when. */
export function readShadowEvidence(
  dbs: readonly ReadModelDb[],
  input: { ids: readonly string[]; legacyAsOfMs: number | null; viewAsOfMs: number | null; legacyHorizonMs?: number; duplicates?: { rows: number; ids: readonly string[] } },
): ShadowEvidence {
  const ids = [...new Set(input.ids)];
  const named = new Set<string>();
  const before = new Set<string>();
  const inGap = new Set<string>();
  let rowsInGap = 0;
  const lo = Math.min(input.legacyAsOfMs ?? 0, input.viewAsOfMs ?? 0);
  const hi = Math.max(input.legacyAsOfMs ?? 0, input.viewAsOfMs ?? 0);
  const gap = input.legacyAsOfMs !== null && input.viewAsOfMs !== null && lo < hi;
  for (const db of dbs) {
    for (const id of namedBy(db, ids, "", [])) named.add(id);
    if (input.legacyHorizonMs !== undefined) for (const id of namedBy(db, ids, " AND ts_ms < ?", [input.legacyHorizonMs])) before.add(id);
    if (!gap) continue;
    for (const id of namedBy(db, ids, " AND ts_ms > ? AND ts_ms <= ?", [lo, hi])) inGap.add(id);
    rowsInGap += Number(db.prepare("SELECT count(*) AS n FROM seen WHERE ts_ms > ? AND ts_ms <= ?").get(lo, hi)?.n ?? 0);
  }
  return {
    legacyAsOfMs: input.legacyAsOfMs, viewAsOfMs: input.viewAsOfMs,
    ...(input.legacyHorizonMs !== undefined ? { legacyHorizonMs: input.legacyHorizonMs } : {}),
    named, namedBeforeHorizon: before, namedInGap: inGap, rowsInGap,
    duplicateIds: new Set(input.duplicates?.ids ?? []), duplicateRows: input.duplicates?.rows ?? 0,
  };
}

/** The legacy computation of one sampled request, projected to the view's `data` shape. */
export interface ShadowLegacy {
  data: unknown;
  asOfMs: number | null;
  /** The oldest row legacy's read could see (its retention horizon), when it has one. */
  horizonMs?: number;
  duplicates?: { rows: number; ids: readonly string[] };
  /** Per aggregate path, what each side counted there; a count diff without them is `real`. */
  members?: Readonly<Record<string, ShadowMembers>>;
  /** Per sum path, the rows each side added; a sum diff without them is `real`. */
  sums?: Readonly<Record<string, ShadowSum>>;
  /** Per latest-time path, the row each side's value is. */
  latest?: Readonly<Record<string, ShadowLatest>>;
  /** A value computed only from other paths (a rate from two counts): explained exactly when they are. */
  derived?: Readonly<Record<string, readonly string[]>>;
}

/** A derived path takes its inputs' classes: `real` unless an input differs and every differing input is explained. */
function classifyDerived(inputs: readonly string[], judged: ReadonlyArray<{ path: string; classification: ShadowClassification }>): { classification: ShadowClassification; reason: string } {
  const classes = judged.filter((d) => inputs.includes(d.path)).map((d) => d.classification);
  if (classes.length === 0 || classes.includes("real")) {
    return { classification: "real", reason: classes.length === 0 ? `none of its inputs (${inputs.join(" ")}) differ` : "an input it is computed from is real" };
  }
  const top = SHADOW_CLASSIFICATIONS.find((c) => classes.includes(c))!;
  return { classification: top, reason: `computed from ${inputs.join(" ")}, each explained (${classes.join(", ")})` };
}

export interface ViewShadowState {
  requests: number;
  firstRequestMs: number | null;
  samples: number;
  diffs: Record<ShadowClassification, number>;
  /** Samples since the last `real` diff, and when that run began. */
  streakSamples: number;
  streakSinceMs: number | null;
  lastRealMs: number | null;
}

export interface ShadowReadiness extends ViewShadowState {
  view: string;
  requestsPerDay: number | null;
  requiredSamples: number | null;
  ready: boolean;
  reason: string;
}

export interface ShadowStore {
  load(): Record<string, ViewShadowState>;
  save(view: string, state: ViewShadowState): void;
}

const SHADOW_DDL = "CREATE TABLE IF NOT EXISTS view_shadow(view TEXT PRIMARY KEY, state TEXT NOT NULL) WITHOUT ROWID";

/** Counters survive a serve restart in the home read model, written behind its lease. */
export function sqliteShadowStore(db: ReadModelDb, lease: ReadModelLease): ShadowStore {
  withWriteTransaction(db, lease, () => db.exec(SHADOW_DDL));
  return {
    load: () => storedShadowStates(db),
    save: (view, state) => void withWriteTransaction(db, lease, () => db.prepare("INSERT INTO view_shadow(view, state) VALUES(?, ?) ON CONFLICT(view) DO UPDATE SET state = excluded.state").run(view, JSON.stringify(state))),
  };
}

function storedShadowStates(db: ReadModelDb): Record<string, ViewShadowState> {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'view_shadow'").get() === undefined) return {};
  return Object.fromEntries(db.prepare("SELECT view, state FROM view_shadow").all().map((row) => [String(row.view), JSON.parse(String(row.state)) as ViewShadowState]));
}

/** Readiness as the persisted counters say, read-only: it shows from boot, before this process compared anything. */
export function storedShadowReadiness(db: ReadModelDb, nowMs: number): ShadowReadiness[] {
  return Object.entries(storedShadowStates(db)).sort(([a], [b]) => a.localeCompare(b)).map(([view, s]) => shadowReadiness(view, s, nowMs));
}

function emptyState(): ViewShadowState {
  return { requests: 0, firstRequestMs: null, samples: 0, diffs: { legacy_horizon: 0, timing: 0, dedupe: 0, real: 0 }, streakSamples: 0, streakSinceMs: null, lastRealMs: null };
}

/**
 * Ready only on SUSTAINED zero `real` diffs: the run of samples since the last one must span a full
 * day of traffic and hold at least 3 x requests-per-day samples. Both numbers come from the view's own
 * measured traffic, so a busy view needs more evidence than a quiet one.
 */
export function shadowReadiness(view: string, s: ViewShadowState, nowMs: number): ShadowReadiness {
  const spanMs = s.firstRequestMs === null ? 0 : nowMs - s.firstRequestMs;
  const requestsPerDay = spanMs >= DAY_MS ? (s.requests * DAY_MS) / spanMs : null;
  const requiredSamples = requestsPerDay === null ? null : Math.max(1, Math.ceil(RULE_OF_THREE * requestsPerDay));
  const streakMs = s.streakSinceMs === null ? 0 : nowMs - s.streakSinceMs;
  let reason: string;
  if (requestsPerDay === null) reason = "traffic not yet observed over a full day";
  else if (streakMs < DAY_MS) reason = s.lastRealMs === null ? "zero real diffs, but for under a day" : "a real diff within the last day";
  else if (s.streakSamples < requiredSamples!) reason = `${s.streakSamples} of ${requiredSamples} samples since the last real diff`;
  else reason = `zero real diffs in ${s.streakSamples} samples over ${Math.floor(streakMs / DAY_MS)} day(s)`;
  const ready = requestsPerDay !== null && streakMs >= DAY_MS && s.streakSamples >= requiredSamples!;
  return { view, ...s, requestsPerDay: requestsPerDay === null ? null : Math.round(requestsPerDay), requiredSamples, ready, reason };
}

export interface ViewShadowOptions {
  clock?: Clock;
  log: (step: string, extra: Record<string, unknown>) => void;
  evidence: (input: Parameters<typeof readShadowEvidence>[1] & { view: string }) => ShadowEvidence;
  store?: ShadowStore;
}

export interface ShadowComparison {
  view: string;
  key: string;
  diffs: Array<{ path: string; classification: ShadowClassification; reason: string }>;
}

export interface ViewShadow {
  compare(input: { view: string; key: string; requests: number; legacy: ShadowLegacy; body: { data: unknown; asOf: string | null } }): ShadowComparison;
  readiness(): ShadowReadiness[];
}

/** The worker-side comparator: diff, classify, count, write the ledger row, persist the counters. */
export function createViewShadow(opts: ViewShadowOptions): ViewShadow {
  const clock = opts.clock ?? systemClock;
  const states = new Map<string, ViewShadowState>(Object.entries(opts.store?.load() ?? {}));
  const stateOf = (view: string): ViewShadowState => states.get(view) ?? states.set(view, emptyState()).get(view)!;
  return {
    compare({ view, key, requests, legacy, body }) {
      const now = clock.now();
      const state = stateOf(view);
      state.requests += requests;
      state.firstRequestMs ??= now;
      state.samples++;
      state.streakSinceMs ??= now;
      const raw = diffViewData(legacy.data, body.data).map((d) => {
        const members = legacy.members?.[d.path];
        const sum = legacy.sums?.[d.path];
        const latest = legacy.latest?.[d.path];
        return { ...d, ...(members ? { members } : {}), ...(sum ? { sum } : {}), ...(latest ? { latest } : {}) };
      });
      const viewAsOf = body.asOf === null ? null : Date.parse(body.asOf);
      const ev = opts.evidence({
        view, ids: raw.flatMap((d) => [...d.ids, ...(d.members ? memberEntities(d.members) : []), ...(d.sum ? sumEntities(d.sum) : []),
          ...(d.latest ? [d.latest.legacy, d.latest.view].flatMap((row) => (row === null ? [] : [entityOf(row)])) : [])]), legacyAsOfMs: legacy.asOfMs, viewAsOfMs: Number.isFinite(viewAsOf) ? viewAsOf : null,
        ...(legacy.horizonMs !== undefined ? { legacyHorizonMs: legacy.horizonMs } : {}), ...(legacy.duplicates ? { duplicates: legacy.duplicates } : {}),
      });
      const judged = raw.filter((d) => !legacy.derived?.[d.path]).map((d) => ({ path: d.path, ...classifyShadowDiff(d, ev) }));
      const diffs = raw.map((d) => {
        const inputs = legacy.derived?.[d.path];
        return inputs ? { path: d.path, ...classifyDerived(inputs, judged) } : judged.find((j) => j.path === d.path)!;
      });
      for (const d of diffs) state.diffs[d.classification]++;
      if (diffs.some((d) => d.classification === "real")) Object.assign(state, { streakSamples: 0, streakSinceMs: now, lastRealMs: now });
      else state.streakSamples++;
      if (diffs.length > 0) {
        const classes = Object.fromEntries(SHADOW_CLASSIFICATIONS.map((c) => [c, diffs.filter((d) => d.classification === c).length]));
        opts.log(VIEW_SHADOW_DIFF_STEP, { view, key, classes, diffs });
      }
      opts.store?.save(view, state);
      return { view, key, diffs };
    },
    readiness: () => [...states.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([view, s]) => shadowReadiness(view, s, clock.now())),
  };
}

/** Offers one view key to the comparator; a `synthetic` offer is the shadow driver's and is no request. */
export type ShadowSample = (view: string, key: string, params: URLSearchParams, synthetic?: boolean) => void;

/**
 * Serve's side: counts every shadow request and passes on at most one per {@link VIEW_SHADOW_SAMPLE_MS}
 * per view key, on a deferred turn after the response finished, with the request count it stands for.
 */
export function createShadowSampler(opts: {
  clock?: Clock;
  sampleMs?: number;
  defer?: (run: () => void) => void;
  send: (sample: { view: string; key: string; params: URLSearchParams; requests: number }) => void;
}): ShadowSample {
  const clock = opts.clock ?? systemClock;
  const defer = opts.defer ?? ((run: () => void) => void setImmediate(run));
  const last = new Map<string, number>();
  const pending = new Map<string, number>();
  return (view, key, params, synthetic = false) => {
    const id = `${view}\u0000${key}`;
    const requests = (pending.get(id) ?? 0) + (synthetic ? 0 : 1);
    const now = clock.now();
    if (now - (last.get(id) ?? Number.NEGATIVE_INFINITY) < (opts.sampleMs ?? VIEW_SHADOW_SAMPLE_MS)) return void pending.set(id, requests);
    last.set(id, now);
    pending.set(id, 0);
    defer(() => opts.send({ view, key, params, requests }));
  };
}

/** One sampled request as serve posts it to the worker; `legacy` is absent when the worker computes that side. */
export interface ShadowRequest {
  view: string;
  key: string;
  requests: number;
  legacy?: ShadowLegacy;
}

/** Legacy bodies serve's main thread already knows how to compute, rendered for a sampled request. */
export function legacyViewSampler(opts: { legacy: readonly ViewDefinition[]; post: (request: ShadowRequest) => void; clock?: Clock; defer?: (run: () => void) => void }): ShadowSample {
  const clock = opts.clock ?? systemClock;
  const legacy = new Map(opts.legacy.map((view) => [view.name, view]));
  return createShadowSampler({
    clock, ...(opts.defer ? { defer: opts.defer } : {}),
    send: ({ view, key, params, requests }) => {
      const definition = legacy.get(view);
      const rendered = definition ? renderView(definition, clock, params) : undefined;
      if (rendered === undefined || "error" in rendered) return opts.post({ view, key, requests });
      const asOf = rendered.body.asOf === null ? Number.NaN : Date.parse(rendered.body.asOf);
      opts.post({ view, key, requests, legacy: { data: rendered.body.data, asOfMs: Number.isFinite(asOf) ? asOf : clock.now() } });
    },
  });
}

/**
 * The view routes' options with the shadow sampler attached when serve runs a read-model worker. The
 * handle's shadow driver offers the same sampler every shadowed key on a cadence, so readiness accrues
 * with no console traffic; the per-key throttle is shared, so the driver never adds to its bound.
 */
export function withViewShadow(handle: { shadow(request: ShadowRequest): void; driveShadow?(sample: ShadowSample): void } | undefined, opts: ReadModelViewRoutesOptions): ReadModelViewRoutesOptions {
  if (!handle) return opts;
  const shadow = legacyViewSampler({ legacy: opts.legacy, post: (request) => handle.shadow(request), ...(opts.clock ? { clock: opts.clock } : {}) });
  handle.driveShadow?.(shadow);
  return { ...opts, shadow };
}
