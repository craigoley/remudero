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
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import { READ_MODEL_DIRNAME, withWriteTransaction, type ReadModelDb, type ReadModelLease } from "./read-model-db.js";
import { renderView, type ReadModelViewRoutesOptions, type ViewDefinition } from "./views.js";

export const VIEW_SHADOW_DIFF_STEP = "view.shadow_diff";
/** Design §5: a sampled comparator, one comparison per minute per view key. */
export const VIEW_SHADOW_SAMPLE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** How much of each side of a `real` diff its ledger row carries. */
const SHADOW_EXCERPT_CHARS = 400;
/**
 * The rule of three: zero failures in n independent samples bounds the failure rate below 3/n at 95%.
 * A view is ready when that bound, times its measured daily traffic, is under one wrong response a day.
 */
const RULE_OF_THREE = 3;
/** One full day of samples per key at the sampling cadence: the shadow driver samples every key at it. */
const CADENCE_SAMPLES_PER_DAY = DAY_MS / VIEW_SHADOW_SAMPLE_MS;
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
  /** Per listed id, the row each side sorted it by, when the list is ordered by time. */
  sortKeys?: Readonly<Record<string, ShadowLatest>>;
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
  /** Named by a row legacy's read could not see: older than its horizon, or one its own rows lack. */
  namedBeforeHorizon: ReadonlySet<string>;
  namedInGap: ReadonlySet<string>;
  /** Ledger rows stamped between the two sides' as-of times. */
  rowsInGap: number;
  /** What the legacy reader counted more than once, when it reports it. */
  duplicateIds: ReadonlySet<string>;
  duplicateRows: number;
  /** Legacy's own rows, when it names them: a sort-key row they lack is one legacy could not see. */
  legacyRows?: LegacyRows;
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

const isFlatList = (items: readonly unknown[]): boolean => items.every((x) => !isRecord(x) && !Array.isArray(x));

/**
 * The elements two lists both hold that changed place: those outside one longest subsequence both
 * keep in the same order (patience sorting, n log n). `a` and `b` hold no duplicates.
 */
export function movedIds(a: readonly string[], b: readonly string[]): string[] {
  const at = new Map(b.map((x, i) => [x, i]));
  const common = a.filter((x) => at.has(x));
  const tails: number[] = [];
  const prev: number[] = [];
  common.forEach((x, i) => {
    const pos = at.get(x)!;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at.get(common[tails[mid]!]!)! < pos) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  });
  const kept = new Set<string>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]!) kept.add(common[i]!);
  return common.filter((x) => !kept.has(x));
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
    if (isFlatList(a) && isFlatList(b)) {
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

/** A value as a `real` diff's ledger row carries it, so the diff can be re-judged from the row alone. */
function excerpt(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > SHADOW_EXCERPT_CHARS ? `${text.slice(0, SHADOW_EXCERPT_CHARS)}…` : text;
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

/** One id's own measured explanation: a row between the two ages names it, else a row legacy's read could not see. */
function explainId(id: string, ev: ShadowEvidence): ShadowClassification {
  const entity = entityOf(id);
  return ev.namedInGap.has(entity) ? "timing" : ev.legacyHorizonMs !== undefined && ev.namedBeforeHorizon.has(entity) ? "legacy_horizon" : "real";
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
    const cls = explainId(id, ev);
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
    const cls = explainId(id, ev);
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
 * A list of ids (a board group), judged member by member as a count is: an id only one side lists is
 * explained by its own rows. An order diff is explained when the ids whose sort-key rows explain
 * nothing keep the same relative order on both sides; every explained id that moved counts once.
 * A duplicate legacy listed is `dedupe`; one the view listed is `real`.
 */
/**
 * Why one id sorts differently, from the row each side sorted it by: the later row landed between the
 * two ages (`timing`), or it is the view's and legacy's own rows lack it (`legacy_horizon`). Checked in
 * memory, so judging a thousand-id order costs no read.
 */
function explainOrder(key: ShadowLatest | undefined, ev: ShadowEvidence): ShadowClassification {
  const ms = (row: string | null): number => (row === null ? Number.NEGATIVE_INFINITY : Date.parse(row.slice(row.indexOf("#") + 1)));
  if (!key || ms(key.legacy) === ms(key.view)) return "real";
  const viewLater = ms(key.view) > ms(key.legacy);
  const at = ms(viewLater ? key.view : key.legacy);
  const [lo, hi] = [Math.min(ev.legacyAsOfMs ?? 0, ev.viewAsOfMs ?? 0), Math.max(ev.legacyAsOfMs ?? 0, ev.viewAsOfMs ?? 0)];
  if (at > lo && at <= hi) return "timing";
  const id = entityOf((key.view ?? key.legacy)!);
  const seen = (ev.legacyRows?.[id] ?? []).some((row) => Number(row.split("|")[0]) === at);
  return viewLater && ev.legacyRows !== undefined && !seen && at <= (ev.legacyAsOfMs ?? Number.POSITIVE_INFINITY) ? "legacy_horizon" : "real";
}

function classifyList(legacy: readonly unknown[], view: readonly unknown[], ev: ShadowEvidence, sortKeys: Readonly<Record<string, ShadowLatest>> = {}): { classification: ShadowClassification; reason: string } {
  const [l, v] = [[...new Set(legacy.map(String))], [...new Set(view.map(String))]];
  const units: Record<ShadowClassification, number> = { dedupe: legacy.length - l.length, timing: 0, legacy_horizon: 0, real: view.length - v.length };
  const unexplained: string[] = units.real > 0 ? ["(a view duplicate)"] : [];
  const judge = (id: string, cls = explainId(id, ev)): void => {
    units[cls]++;
    if (cls === "real") unexplained.push(id);
  };
  const [inL, inV] = [new Set(l), new Set(v)];
  for (const id of [...new Set([...l, ...v])].filter((x) => inL.has(x) !== inV.has(x)).sort()) judge(id);
  const [cl, cv] = [l.filter((id) => inV.has(id)), v.filter((id) => inL.has(id))];
  const order = (id: string): ShadowClassification => explainOrder(sortKeys[id], ev);
  const fixed = new Set(cl.filter((id) => order(id) === "real"));
  const skeleton = movedIds(cl.filter((id) => fixed.has(id)), cv.filter((id) => fixed.has(id)));
  for (const id of skeleton) judge(id, "real");
  const slots = (ids: readonly string[]): Map<string, number> => {
    const out = new Map<string, number>();
    let n = 0;
    for (const id of ids) if (fixed.has(id)) n++; else out.set(id, n);
    return out;
  };
  const [sl, sv] = [slots(cl), slots(cv)];
  const among = new Set(movedIds(cl.filter((id) => !fixed.has(id)), cv.filter((id) => !fixed.has(id))));
  for (const id of cl) if (!fixed.has(id) && (sl.get(id) !== sv.get(id) || among.has(id))) judge(id, order(id));
  const breakdown = SHADOW_CLASSIFICATIONS.filter((c) => units[c] > 0).map((c) => `${units[c]} ${c}`).join(", ");
  const named = unexplained.length > 10 ? `${unexplained.slice(0, 10).join(" ")} and ${unexplained.length - 10} more` : unexplained.join(" ");
  if (units.real > 0) return { classification: "real", reason: `no measured row explains ${named} (${breakdown})` };
  if (breakdown === "") return { classification: "real", reason: "the lists hold the same ids in the same order, so they differ in element type" };
  const top = (["dedupe", "timing", "legacy_horizon"] as const).reduce((a, b) => (units[b] > units[a] ? b : a));
  return { classification: top, reason: `every listed id differing or moved is explained (${breakdown})` };
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
  if (Array.isArray(legacy) && Array.isArray(view) && isFlatList(legacy) && isFlatList(view)) return classifyList(legacy, view, ev, diff.sortKeys);
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

/** The rows legacy read, by the id each names, as `<tsMs>|<step>`: what its read saw, so what it could not. */
export type LegacyRows = Readonly<Record<string, readonly string[]>>;

/** Indexes a legacy read's rows by the task and the pull request each names. */
export function legacyRowIndex(rows: ReadonlyArray<Record<string, unknown>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    const ms = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
    if (!Number.isFinite(ms)) continue;
    const task = typeof row.task_id === "string" ? row.task_id : row.task;
    for (const id of [task, row.pr_number]) if (typeof id === "string" || typeof id === "number") (out[String(id)] ??= []).push(`${ms}|${String(row.step)}`);
  }
  return out;
}

/**
 * The `ids` named by a fact row between legacy's horizon and its read time that legacy's own rows lack:
 * compaction prunes the live file per step and per pull request, so legacy misses rows newer than its
 * oldest one too. A row older than the horizon is unseen already, and is not read again.
 */
function unseenBy(db: ReadModelDb, ids: readonly string[], rows: LegacyRows, fromMs: number, asOfMs: number): string[] {
  const out = new Set<string>();
  const seen = new Map<string, Set<string>>();
  for (let at = 0; at < ids.length; at += 400) {
    const chunk = ids.slice(at, at + 400);
    const sql = `SELECT task_id, step, ts_ms FROM fact WHERE task_id IN (${chunk.map(() => "?").join(",")}) AND ts_ms >= ? AND ts_ms <= ?`;
    for (const row of db.prepare(sql).all(...chunk, fromMs, asOfMs)) {
      const id = String(row.task_id);
      const keys = seen.get(id) ?? seen.set(id, new Set(rows[id] ?? [])).get(id)!;
      if (!keys.has(`${String(row.ts_ms)}|${String(row.step)}`)) out.add(id);
    }
  }
  return [...out];
}

/** The evidence the read model itself holds: which rows name the diff's ids, and when; `legacyRows` adds legacy's own read. */
export function readShadowEvidence(
  dbs: readonly ReadModelDb[],
  input: { ids: readonly string[]; legacyAsOfMs: number | null; viewAsOfMs: number | null; legacyHorizonMs?: number; duplicates?: { rows: number; ids: readonly string[] }; legacyRows?: LegacyRows },
): ShadowEvidence {
  const ids = [...new Set(input.ids)];
  const named = new Set<string>();
  const before = new Set<string>();
  const inGap = new Set<string>();
  let rowsInGap = 0;
  const lo = Math.min(input.legacyAsOfMs ?? 0, input.viewAsOfMs ?? 0);
  const hi = Math.max(input.legacyAsOfMs ?? 0, input.viewAsOfMs ?? 0);
  const gap = input.legacyAsOfMs !== null && input.viewAsOfMs !== null && lo < hi;
  const live = input.legacyRows;
  for (const id of live ? ids : []) {
    if (!live![id]) continue;
    named.add(id);
    if (gap && live![id]!.some((key) => Number(key.split("|")[0]) > lo && Number(key.split("|")[0]) <= hi)) inGap.add(id);
  }
  for (const db of dbs) {
    for (const id of namedBy(db, ids, "", [])) named.add(id);
    if (input.legacyHorizonMs !== undefined) for (const id of namedBy(db, ids, " AND ts_ms < ?", [input.legacyHorizonMs])) before.add(id);
    if (live) for (const id of unseenBy(db, ids.filter((id) => !before.has(id)), live, input.legacyHorizonMs ?? 0, input.legacyAsOfMs ?? Number.MAX_SAFE_INTEGER)) before.add(id);
    if (!gap) continue;
    for (const id of namedBy(db, ids, " AND ts_ms > ? AND ts_ms <= ?", [lo, hi])) inGap.add(id);
    rowsInGap += Number(db.prepare("SELECT count(*) AS n FROM seen WHERE ts_ms > ? AND ts_ms <= ?").get(lo, hi)?.n ?? 0);
  }
  return {
    legacyAsOfMs: input.legacyAsOfMs, viewAsOfMs: input.viewAsOfMs,
    ...(input.legacyHorizonMs !== undefined ? { legacyHorizonMs: input.legacyHorizonMs } : {}),
    named, namedBeforeHorizon: before, namedInGap: inGap, rowsInGap,
    duplicateIds: new Set(input.duplicates?.ids ?? []), duplicateRows: input.duplicates?.rows ?? 0,
    ...(live ? { legacyRows: live } : {}),
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
  /** The rows legacy's read held ({@link legacyRowIndex}): a row it lacks is one it could not see. */
  rows?: LegacyRows;
  /** Per time-ordered list path, each id's sort-key row on each side (`<id>#<ts>`). */
  sortKeys?: Readonly<Record<string, Readonly<Record<string, ShadowLatest>>>>;
  /** A value computed only from other paths (a rate from two counts): explained exactly when they are. */
  derived?: Readonly<Record<string, readonly string[]>>;
  /** What each side was computed from (a plan generation, a probe instant), carried onto the diff row as evidence. */
  inputs?: Readonly<Record<string, unknown>>;
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
  /** The keys sampled since the streak began; absent in a state persisted before it was counted. */
  streakKeys?: string[];
}

export interface ShadowReadiness extends Omit<ViewShadowState, "streakKeys"> {
  view: string;
  /** How many keys the streak sampled: each owes the cadence's full day of samples. */
  keys: number;
  requestsPerDay: number | null;
  requiredSamples: number | null;
  ready: boolean;
  reason: string;
}

export interface ShadowStore {
  load(): Record<string, ViewShadowState>;
  save(view: string, state: ViewShadowState): void;
}

/** On the persistent state disk beside the switch file: the DB may live on scratch a deallocate wipes. */
export function viewShadowPath(stateDir: string): string {
  return join(stateDir, READ_MODEL_DIRNAME, "view-shadow.json");
}

/** Counters survive a restart and a scratch wipe in `path`, written only behind the home read model's lease. */
export function fileShadowStore(path: string, db: ReadModelDb, lease: ReadModelLease): ShadowStore {
  const states = storedShadowStates(path, db);
  return {
    load: () => ({ ...states }),
    save: (view, state) => {
      states[view] = state;
      withWriteTransaction(db, lease, () => writeAtomic(path, JSON.stringify(states)));
    },
  };
}

/** The file; until its first save, the `view_shadow` table an older build kept in the DB, so a streak carries over. */
function storedShadowStates(path: string, db: ReadModelDb): Record<string, ViewShadowState> {
  const text = readFileIfExists(path);
  if (text !== undefined) return JSON.parse(text) as Record<string, ViewShadowState>;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'view_shadow'").get() === undefined) return {};
  return Object.fromEntries(db.prepare("SELECT view, state FROM view_shadow").all().map((row) => [String(row.view), JSON.parse(String(row.state)) as ViewShadowState]));
}

/** Readiness as the persisted counters say, read-only: it shows from boot, before this process compared anything. */
export function storedShadowReadiness(path: string, db: ReadModelDb, nowMs: number): ShadowReadiness[] {
  return Object.entries(storedShadowStates(path, db)).sort(([a], [b]) => a.localeCompare(b)).map(([view, s]) => shadowReadiness(view, s, nowMs));
}

function emptyState(): ViewShadowState {
  return { requests: 0, firstRequestMs: null, samples: 0, diffs: { legacy_horizon: 0, timing: 0, dedupe: 0, real: 0 }, streakSamples: 0, streakSinceMs: null, lastRealMs: null, streakKeys: [] };
}

/**
 * Ready only on SUSTAINED zero `real` diffs: the run of samples since the last one must span a full day
 * and hold a full day of continuous sampling, one sample per key per {@link VIEW_SHADOW_SAMPLE_MS}. The
 * sampler never exceeds that cadence, so the count alone proves the sampling ran for a day: a restart
 * or a stalled worker only delays it. Measured request traffic raises the floor to 3 x requests-per-day
 * (the rule of three), so a busy view needs more evidence than the cadence gives it.
 */
export function shadowReadiness(view: string, state: ViewShadowState, nowMs: number): ShadowReadiness {
  const { streakKeys, ...s } = state;
  const keys = Math.max(1, streakKeys?.length ?? 0);
  const spanMs = s.firstRequestMs === null ? 0 : nowMs - s.firstRequestMs;
  const requestsPerDay = spanMs >= DAY_MS ? (s.requests * DAY_MS) / spanMs : null;
  const requiredSamples = Math.max(keys * CADENCE_SAMPLES_PER_DAY, Math.ceil(RULE_OF_THREE * (requestsPerDay ?? 0)));
  const streakMs = s.streakSinceMs === null ? 0 : nowMs - s.streakSinceMs;
  let reason: string;
  if (streakMs < DAY_MS) reason = s.lastRealMs === null ? "zero real diffs, but for under a day" : "a real diff within the last day";
  else if (s.streakSamples < requiredSamples) reason = `${s.streakSamples} of ${requiredSamples} samples since the last real diff (a day at one per minute for ${keys} key(s))`;
  else reason = `zero real diffs in ${s.streakSamples} samples over ${Math.floor(streakMs / DAY_MS)} day(s)`;
  const ready = streakMs >= DAY_MS && s.streakSamples >= requiredSamples;
  return { view, ...s, keys, requestsPerDay: requestsPerDay === null ? null : Math.round(requestsPerDay), requiredSamples, ready, reason };
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
        const sortKeys = legacy.sortKeys?.[d.path];
        return { ...d, ...(members ? { members } : {}), ...(sum ? { sum } : {}), ...(latest ? { latest } : {}), ...(sortKeys ? { sortKeys } : {}) };
      });
      const viewAsOf = body.asOf === null ? null : Date.parse(body.asOf);
      const ev = opts.evidence({
        view, ids: raw.flatMap((d) => [...d.ids, ...(d.members ? memberEntities(d.members) : []), ...(d.sum ? sumEntities(d.sum) : []),
          ...(d.latest ? [d.latest.legacy, d.latest.view].flatMap((row) => (row === null ? [] : [entityOf(row)])) : [])]), legacyAsOfMs: legacy.asOfMs, viewAsOfMs: Number.isFinite(viewAsOf) ? viewAsOf : null,
        ...(legacy.horizonMs !== undefined ? { legacyHorizonMs: legacy.horizonMs } : {}), ...(legacy.duplicates ? { duplicates: legacy.duplicates } : {}),
        ...(legacy.rows ? { legacyRows: legacy.rows } : {}),
      });
      const judged = raw.filter((d) => !legacy.derived?.[d.path]).map((d) => ({ path: d.path, ...classifyShadowDiff(d, ev) }));
      const diffs = raw.map((d) => {
        const inputs = legacy.derived?.[d.path];
        return inputs ? { path: d.path, ...classifyDerived(inputs, judged) } : judged.find((j) => j.path === d.path)!;
      });
      for (const d of diffs) state.diffs[d.classification]++;
      if (diffs.some((d) => d.classification === "real")) Object.assign(state, { streakSamples: 0, streakSinceMs: now, lastRealMs: now, streakKeys: [] });
      else Object.assign(state, { streakSamples: state.streakSamples + 1, streakKeys: [...new Set([...state.streakKeys ?? [], key])] });
      if (diffs.length > 0) {
        const classes = Object.fromEntries(SHADOW_CLASSIFICATIONS.map((c) => [c, diffs.filter((d) => d.classification === c).length]));
        const sides = (path: string): { legacy: string; view: string } => {
          const d = raw.find((r) => r.path === path)!;
          return { legacy: excerpt(d.legacy), view: excerpt(d.view) };
        };
        opts.log(VIEW_SHADOW_DIFF_STEP, { view, key, classes, ...(legacy.inputs ? { inputs: legacy.inputs } : {}), diffs: diffs.map((d) => (d.classification === "real" ? { ...d, ...sides(d.path) } : d)) });
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
