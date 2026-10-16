import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeAtomic, type WriteAtomicIo } from "./fs-race-safe.js";

const DAY = 86400000;
/** BACKSTOP: refuse excess evidence rather than silently truncating a cohort or identity set. */
export const FLOW_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
/** BACKSTOP: checkpoint identity populations are bounded independently of serialized bytes. */
const MAX_IDENTITIES = 8192;
/** PRIMARY CONTROL: daily inventory retention covers the public thirty-day graph. */
const INVENTORY_DAYS = 31;
/** PRIMARY CONTROL: retain joins beyond graph windows so earlier costs can join later deliveries. */
const EVIDENCE_DAYS = 90;
const stamp = z.string().datetime();
const small = z.string().min(1).max(160);
const pr = z.number().int().positive().safe();
const head = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const count = z.number().int().nonnegative();
const amount = z.number().nonnegative().finite().nullable();
const reasons = ["awaiting_review", "required_red", "conflict", "blocked", "unknown"] as const;
const states = ["SUCCESS", "FAILURE", "PENDING", "CANCELLED", "SKIPPED", "NEUTRAL", "MISSING", "EXPIRED", "UNKNOWN"] as const;
const publicationSchema = z.strictObject({ pr, head, at: stamp, run: small.nullable(), task: small.nullable() });
const snapshotSchema = z.strictObject({ pr, head, at: stamp, generation: small, complete: z.boolean(),
  policy: z.strictObject({ id: small, required: z.array(small).max(128), accepted: z.array(z.enum(states)).max(9) }),
  checks: z.array(z.strictObject({ name: small, state: z.enum(states), attempt: count,
    startedAt: stamp, completedAt: stamp.nullable() })).max(512), round: small.nullable() });
const inventorySchema = z.strictObject({ at: stamp, generation: small, complete: z.boolean(),
  prs: z.array(z.strictObject({ pr, head, createdAt: stamp.nullable(), reasons: z.array(z.enum(reasons)).max(5) })).max(MAX_IDENTITIES) });
const costSchema = z.strictObject({ identity: small, at: stamp, run: small.nullable(), task: small.nullable(),
  cash: amount, modeled: amount, tokens: amount });
const historySchema = z.strictObject({ version: z.literal(1), repository: z.string().max(240).regex(/^[\w.-]+\/[\w.-]+$/),
  observedAt: stamp, publications: z.array(publicationSchema).max(MAX_IDENTITIES),
  snapshots: z.array(snapshotSchema).max(MAX_IDENTITIES), inventories: z.array(inventorySchema).max(INVENTORY_DAYS),
  costs: z.array(costSchema).max(MAX_IDENTITIES) });
export type FlowHistory = z.infer<typeof historySchema>;
export type FlowSnapshot = FlowHistory["snapshots"][number];
export type FlowHistoryUpdate = Partial<Pick<FlowHistory, "publications" | "snapshots" | "inventories" | "costs">>;
type HistoryReason = "missing_history" | "invalid_history" | "history_over_budget" | "write_failed";
type HistoryRead = { ok: true; history: FlowHistory } | { ok: false; reason: HistoryReason };

const stateCountsSchema = z.strictObject({ SUCCESS: count, FAILURE: count, PENDING: count, CANCELLED: count,
  SKIPPED: count, NEUTRAL: count, MISSING: count, EXPIRED: count, UNKNOWN: count });
const reasonCountsSchema = z.strictObject({ awaiting_review: count, required_red: count, conflict: count, blocked: count, unknown: count });
export const repositoryQualitySchema = z.strictObject({ observedAt: stamp.nullable(),
  reason: z.enum(["missing_history", "invalid_history", "history_over_budget", "write_failed"]).nullable(),
  retentionDays: z.literal(EVIDENCE_DAYS), inventoryDays: z.literal(INVENTORY_DAYS),
  backlog: z.array(z.strictObject({ date: z.string(), sampledAt: stamp.nullable(), generation: small.nullable(),
    coveredFrom: stamp.nullable(), coveredThrough: stamp.nullable(), distinctPrs: count.nullable(),
    reasons: reasonCountsSchema.nullable(), oldestMs: amount, missingCreatedAt: count.nullable() })).max(30),
  windows: z.array(z.strictObject({ days: z.union([z.literal(7), z.literal(30)]), from: stamp, through: stamp,
    firstPass: z.strictObject({ cohort: count, eligible: count, passing: count, unknown: count, states: stateCountsSchema,
      denominator: z.literal("observed publications and open or discovered PRs; includes unknowns") }),
    repairLatency: z.strictObject({ unit: z.literal("ms"), samples: count, censored: count, p50Ms: amount, p90Ms: amount,
      episodes: z.array(z.strictObject({ pr, failingHead: head, currentHead: head, round: small.nullable(),
        failedAt: stamp, recoveredAt: stamp.nullable() })).max(64), evidenceTruncated: z.boolean() }),
    efficiency: z.strictObject({ deliveredPrs: count, linkedPrs: count, priced: count, unpriced: count, unlinked: count,
      pricedSubtotalUsd: amount, modeledSubtotalUsd: amount, tokens: amount, totalUsd: z.null(), operatorEffortMs: z.null(),
      cohort: z.literal("observed delivered PRs by merge time; retained exact run and task producer joins"),
      costBasis: z.literal("producer estimates; not invoices or causal ROI") }) })).length(2) });
export type RepositoryQuality = z.infer<typeof repositoryQualitySchema>;

export function flowHistoryPath(stateDir: string, repository: string): string {
  return join(stateDir, "repository-flow", `${createHash("sha256").update(repository).digest("hex")}.json`);
}

export function readRepositoryFlowHistory(stateDir: string, repository: string): HistoryRead {
  try {
    const path = flowHistoryPath(stateDir, repository);
    if (statSync(path).size > FLOW_HISTORY_MAX_BYTES) return { ok: false, reason: "history_over_budget" };
    const parsed = historySchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success || parsed.data.repository !== repository) return { ok: false, reason: "invalid_history" };
    return { ok: true, history: parsed.data };
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing_history" : "invalid_history" };
  }
}

/** Only observation owners write. A failed stage leaves the last durable checkpoint intact. */
export function recordRepositoryFlowHistory(stateDir: string, repository: string, update: FlowHistoryUpdate,
  options: { io?: WriteAtomicIo } = {}): { ok: true } | { ok: false; reason: HistoryReason } {
  const previous = readRepositoryFlowHistory(stateDir, repository);
  if (!previous.ok && previous.reason !== "missing_history") return previous;
  const times = Object.values(update).flatMap(rows => rows.map(row => row.at));
  if (!times.length) return { ok: true };
  if (times.some(at => !stamp.safeParse(at).success)) return { ok: false, reason: "invalid_history" };
  const observedAt = [previous.ok ? previous.history.observedAt : times[0]!, ...times].sort().at(-1)!;
  const cutoff = Date.parse(observedAt) - EVIDENCE_DAYS * DAY;
  const old: FlowHistory = previous.ok ? previous.history : { version: 1, repository, observedAt,
    publications: [], snapshots: [], inventories: [], costs: [] };
  const unique = <T extends { at: string }>(rows: T[], key: (row: T) => string) =>
    [...new Map(rows.filter(row => Date.parse(row.at) >= cutoff).map(row => [key(row), row])).values()];
  const inventories = new Map<string, FlowHistory["inventories"][number]>();
  for (const row of [...old.inventories, ...update.inventories ?? []].sort((a, b) => a.at.localeCompare(b.at))) {
    if (row.complete && Date.parse(row.at) >= Date.parse(observedAt) - INVENTORY_DAYS * DAY) inventories.set(row.at.slice(0, 10), row);
  }
  const next: FlowHistory = { version: 1, repository, observedAt,
    publications: unique([...old.publications, ...update.publications ?? []], row => JSON.stringify(row)),
    snapshots: unique([...old.snapshots, ...update.snapshots ?? []], row => JSON.stringify(row)),
    inventories: [...inventories.values()].slice(-INVENTORY_DAYS),
    costs: unique([...old.costs, ...update.costs ?? []], row => row.identity) };
  if ([next.publications, next.snapshots, next.costs].some(rows => rows.length > MAX_IDENTITIES) ||
      Buffer.byteLength(JSON.stringify(next)) > FLOW_HISTORY_MAX_BYTES) return { ok: false, reason: "history_over_budget" };
  if (!historySchema.safeParse(next).success || next.inventories.some(row => new Set(row.prs.map(p => p.pr)).size !== row.prs.length))
    return { ok: false, reason: "invalid_history" };
  try {
    writeAtomic(flowHistoryPath(stateDir, repository), JSON.stringify(next) + "\n", options);
    return { ok: true };
  } catch (error) {
    // The caller receives a named writer failure; the previous checkpoint remains readable.
    void error;
    return { ok: false, reason: "write_failed" };
  }
}

function requiredSnapshot(snapshot: FlowSnapshot) {
  const { policy } = snapshot;
  if (!snapshot.complete || !policy.required.length || !policy.accepted.length ||
      new Set(policy.required).size !== policy.required.length) return undefined;
  const checks = policy.required.map(name => snapshot.checks.filter(check => check.name === name)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.attempt - a.attempt)[0]);
  if (checks.some(check => check && (check.startedAt > snapshot.at ||
      check.completedAt !== null && (check.completedAt < check.startedAt || check.completedAt > snapshot.at)))) return undefined;
  const outcomes = checks.map(check => check?.state ?? "MISSING");
  const green = outcomes.every(state => policy.accepted.includes(state)) && checks.every(check => check?.completedAt !== null && check !== undefined);
  const failed = outcomes.some(state => state === "FAILURE");
  return { checks, outcomes, green, failed };
}

const percentile = (values: number[], fraction: number): number | null => values.length
  ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]! : null;

export function foldRepositoryFlowHistory(history: FlowHistory | undefined, through: string,
  delivered: Array<{ pr: number; at: string }> = [], reason: HistoryReason | null = null): RepositoryQuality {
  const now = Date.parse(through), day = Math.floor(now / DAY) * DAY;
  const h = history && Date.parse(history.observedAt) <= now ? history : undefined;
  const result: RepositoryQuality = { observedAt: h?.observedAt ?? null, reason: reason ?? (h ? null : "missing_history"),
    retentionDays: EVIDENCE_DAYS, inventoryDays: INVENTORY_DAYS, backlog: [], windows: [] };
  for (let i = 29; i >= 0; i--) {
    const start = day - i * DAY, date = new Date(start).toISOString().slice(0, 10);
    const sample = h?.inventories.filter(s => s.complete && s.at.slice(0, 10) === date && Date.parse(s.at) <= now)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    const reasonsCount = { awaiting_review: 0, required_red: 0, conflict: 0, blocked: 0, unknown: 0 };
    const ages: number[] = [];
    let missing = 0;
    for (const p of sample?.prs ?? []) {
      for (const r of new Set(p.reasons)) reasonsCount[r]++;
      if (p.createdAt === null || p.createdAt > sample!.at) missing++;
      else ages.push(Date.parse(sample!.at) - Date.parse(p.createdAt));
    }
    result.backlog.push({ date, sampledAt: sample?.at ?? null, generation: sample?.generation ?? null,
      coveredFrom: sample?.at ?? null, coveredThrough: sample?.at ?? null,
      distinctPrs: sample ? sample.prs.length : null, reasons: sample ? reasonsCount : null,
      oldestMs: ages.length ? Math.max(...ages) : null, missingCreatedAt: sample ? missing : null });
  }
  for (const days of [7, 30] as const) {
    const from = new Date(day - (days - 1) * DAY).toISOString();
    const inWindow = (at: string) => at >= from && at <= through;
    const pubs = h?.publications ?? [], snapshots = h?.snapshots ?? [];
    const cohort = new Set([...pubs.filter(p => inWindow(p.at)).map(p => p.pr),
      ...snapshots.filter(p => inWindow(p.at)).map(p => p.pr),
      ...h?.inventories.filter(s => inWindow(s.at)).flatMap(s => s.prs.map(p => p.pr)) ?? []]);
    const firstPass: RepositoryQuality["windows"][number]["firstPass"] = { cohort: cohort.size, eligible: 0, passing: 0, unknown: 0,
      states: { SUCCESS: 0, FAILURE: 0, PENDING: 0, CANCELLED: 0, SKIPPED: 0, NEUTRAL: 0, MISSING: 0, EXPIRED: 0, UNKNOWN: 0 },
      denominator: "observed publications and open or discovered PRs; includes unknowns" };
    for (const number of cohort) {
      const publications = pubs.filter(p => p.pr === number);
      const publication = publications[0];
      const initial = publication && snapshots.filter(s => s.pr === number && s.head === publication.head && s.at >= publication.at && s.at <= through);
      const latest = initial && [...initial].sort((a, b) => b.at.localeCompare(a.at))[0];
      const verified = latest && requiredSnapshot(latest);
      if (!publication || new Set(publications.map(p => p.head)).size !== 1 || !latest || !verified ||
          new Set(initial!.map(s => JSON.stringify(s.policy))).size !== 1) { firstPass.unknown++; continue; }
      firstPass.eligible++;
      firstPass.passing += Number(verified.green);
      for (const state of new Set(verified.outcomes)) firstPass.states[state]++;
    }
    const episodes: RepositoryQuality["windows"][number]["repairLatency"]["episodes"] = [];
    const open = new Map<number, typeof episodes[number]>();
    for (const s of [...snapshots].filter(s => s.at <= through).sort((a, b) => a.at.localeCompare(b.at))) {
      const verified = requiredSnapshot(s);
      const existing = open.get(s.pr);
      if (existing) existing.currentHead = s.head;
      if (!verified) continue;
      if (verified.failed && !existing) {
        const episode = { pr: s.pr, failingHead: s.head, currentHead: s.head, round: s.round, failedAt: s.at, recoveredAt: null as string | null };
        episodes.push(episode); open.set(s.pr, episode);
      } else if (existing && verified.green) {
        const completedAt = verified.checks.map(c => c!.completedAt!).sort().at(-1)!;
        if (completedAt >= existing.failedAt) {
          existing.recoveredAt = completedAt; existing.round = s.round; open.delete(s.pr);
        }
      }
    }
    const selected = episodes.filter(e => inWindow(e.failedAt));
    const durations = selected.filter(e => e.recoveredAt !== null).map(e => Date.parse(e.recoveredAt!) - Date.parse(e.failedAt));
    const deliveredPrs = new Set(delivered.filter(p => inWindow(p.at)).map(p => p.pr));
    const linked = new Set<number>();
    let priced = 0, unpriced = 0, unlinked = 0, usd = 0, modeled = 0, models = 0, tokens = 0, tokenRows = 0;
    for (const c of h?.costs ?? []) {
      const joins = new Set(pubs.filter(p => c.run !== null && c.task !== null && p.run === c.run && p.task === c.task).map(p => p.pr));
      const number = joins.size === 1 ? [...joins][0] : undefined;
      if (number === undefined) { if (inWindow(c.at)) unlinked++; continue; }
      if (!deliveredPrs.has(number)) continue;
      linked.add(number);
      if (c.cash === null) unpriced++; else { priced++; usd += c.cash; }
      if (c.modeled !== null) { models++; modeled += c.modeled; }
      if (c.tokens !== null) { tokenRows++; tokens += c.tokens; }
    }
    result.windows.push({ days, from, through, firstPass,
      repairLatency: { unit: "ms", samples: durations.length, censored: selected.length - durations.length,
        p50Ms: percentile(durations, .5), p90Ms: percentile(durations, .9), episodes: selected.slice(-64), evidenceTruncated: selected.length > 64 },
      efficiency: { deliveredPrs: deliveredPrs.size, linkedPrs: linked.size, priced, unpriced, unlinked,
        pricedSubtotalUsd: priced ? usd : null, modeledSubtotalUsd: models ? modeled : null, tokens: tokenRows ? tokens : null,
        totalUsd: null, operatorEffortMs: null, cohort: "observed delivered PRs by merge time; retained exact run and task producer joins",
        costBasis: "producer estimates; not invoices or causal ROI" } });
  }
  return result;
}
