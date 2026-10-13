/** Repository-scoped cached PR evidence. Never infer a merge or green check from a worker verdict.
 * Falsifiers: test/repository-flow.test.ts and test/repository-flow-cached-wiring.test.ts. */
import { z } from "zod";
import { createBoardSnapshotReader, readOpenBoardSnapshot } from "./board-snapshot-cache.js";
import { fingerprintLedgerLine, openLedgerUnion } from "./ledger-union.js";
import { buildBatchedGithub, taskIdFromRunBranch } from "./status.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import type { BoardPrRest } from "./open-prs-rest.js";
import { ANALYTICS_REFRESH_INTERVAL_MS, ANALYTICS_REFRESH_TIMEOUT_MS } from "./analytics-route.js";
import { projectRepairCostContext } from "./repair-cost-evidence.js";

export const REPOSITORY_FLOW_VERSION = "repository-flow-v1";
/** BACKSTOP: optional graph evidence leaves room for existing Analytics in the same response. */
export const REPOSITORY_FLOW_MAX_BYTES = 64 * 1024;
/** BACKSTOP: reserve remaining view space for ordinary metrics, sources and gardener costs. */
export const REPOSITORY_FLOW_FLEET_MAX_BYTES = 256 * 1024;
/** BACKSTOP: the board's own complete-cache limit, not a cap on displayed link counts. */
const MAX_PRS = 100000;
/** BACKSTOP: exact receipt replay accounting is bounded separately from the compact public DTO. */
const MAX_REPAIR_IDENTITIES = 65536;
const DAY_MS = 86400000;
/** PRIMARY CONTROL: graph completeness uses the existing Analytics refresh freshness bound. */
const PR_SOURCE_FRESH_MS = 2 * ANALYTICS_REFRESH_INTERVAL_MS + ANALYTICS_REFRESH_TIMEOUT_MS;
const reasonNames = ["code", "flake", "infrastructure", "conflict", "unknown"] as const;
const unknowns = {
  firstPass: "initial-head and required-check policy evidence not collected",
  repairLatency: "required-current-head recovery evidence not collected",
  backlog: "historical daily backlog observations not collected",
  efficiency: "delivered-work price and token attribution evidence not collected",
} as const;
const stamp = z.string().datetime();
const nullableCount = z.number().int().nonnegative().nullable();
const nullableMs = z.number().nonnegative().finite().nullable();
const bucketSchema = z.strictObject({ date: z.string().regex(/^\d{4}-\d\d-\d\d$/), opened: nullableCount,
  merged: nullableCount, deliveredTasks: nullableCount, repairedPrs: nullableCount, repairRounds: nullableCount });
const summarySchema = z.strictObject({ opened: nullableCount, merged: nullableCount, deliveredTasks: nullableCount,
  repairedPrs: nullableCount, repairRounds: nullableCount,
  repairReasons: z.strictObject({ code: nullableCount, flake: nullableCount, infrastructure: nullableCount,
    conflict: nullableCount, unknown: nullableCount }),
  mergeLatency: z.strictObject({ unit: z.literal("ms"), samples: z.number().int().nonnegative(),
    p50Ms: nullableMs, p90Ms: nullableMs, missingCreatedAt: z.number().int().nonnegative() }),
  openAge: z.strictObject({ unit: z.literal("ms"), censored: z.literal(true), asOf: stamp.nullable(), samples: z.number().int().nonnegative(),
    oldestMs: nullableMs, missingCreatedAt: z.number().int().nonnegative() }) });
const schema = z.strictObject({ version: z.literal(REPOSITORY_FLOW_VERSION), scope: z.literal("repository"),
  repository: z.string().max(240).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  state: z.enum(["reported", "partial", "not_collected"]), reason: z.enum(["missing_source", "invalid_source", "over_budget"]).nullable(),
  materializedAt: stamp,
  sources: z.strictObject({ openObservedAt: stamp.nullable(), closedObservedAt: stamp.nullable(),
    prCorpus: z.enum(["complete", "partial", "unavailable"]), prFreshness: z.enum(["fresh", "stale", "unknown"]),
    ledgerObservedAt: stamp.nullable(), ledgerCorpus: z.enum(["observed", "partial", "unavailable"]),
    earliestLedgerAt: stamp.nullable(), latestLedgerAt: stamp.nullable(), observedPrs: nullableCount,
    observedRepairIdentities: nullableCount }),
  limits: z.strictObject({ prRows: z.literal(MAX_PRS), repairIdentities: z.literal(MAX_REPAIR_IDENTITIES),
    publicBytes: z.literal(REPOSITORY_FLOW_MAX_BYTES), evidencePerWindow: z.literal(64) }),
  gaps: z.array(z.string().max(160)).max(16),
  notCollected: z.strictObject({ firstPass: z.literal(unknowns.firstPass), repairLatency: z.literal(unknowns.repairLatency),
    backlog: z.literal(unknowns.backlog), efficiency: z.literal(unknowns.efficiency) }),
  windows: z.array(z.strictObject({ days: z.union([z.literal(7), z.literal(30)]), from: stamp, through: stamp,
    coverage: z.strictObject({ opened: z.enum(["complete", "observed", "unknown"]), merged: z.enum(["complete", "observed", "unknown"]),
      repairs: z.enum(["observed", "unknown"]), partialCounts: z.literal("observed lower bounds; not complete historical totals") }),
    buckets: z.array(bucketSchema).max(30), summary: summarySchema,
    evidence: z.array(z.strictObject({ prNumber: z.number().int().positive(), url: z.string().max(320),
      kind: z.enum(["opened", "merged", "repair"]), at: stamp })).max(64),
    evidenceTruncated: z.boolean() })).length(2) });
export type RepositoryFlow = z.infer<typeof schema>;
type Repair = { pr: number; head: string; round: string; at: number; reason: typeof reasonNames[number] };
const boardReader = createBoardSnapshotReader();
const time = (v: unknown): number | undefined => typeof v === "string" && stamp.safeParse(v).success ? Date.parse(v) : undefined;
function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}
function empty(repository: string, now: number, reason: RepositoryFlow["reason"]): RepositoryFlow {
  const through = fixedClock(now).iso();
  const endDay = Math.floor(now / DAY_MS) * DAY_MS;
  return { version: REPOSITORY_FLOW_VERSION, scope: "repository", repository, state: "not_collected", reason,
    materializedAt: through, sources: { openObservedAt: null, closedObservedAt: null, prCorpus: "unavailable", prFreshness: "unknown",
      ledgerObservedAt: null, ledgerCorpus: "unavailable", earliestLedgerAt: null, latestLedgerAt: null,
      observedPrs: null, observedRepairIdentities: null },
    limits: { prRows: MAX_PRS, repairIdentities: MAX_REPAIR_IDENTITIES, publicBytes: REPOSITORY_FLOW_MAX_BYTES, evidencePerWindow: 64 },
    gaps: [], notCollected: { ...unknowns }, windows: [7, 30].map(days => ({ days: days as 7 | 30,
      from: fixedClock(endDay - (days - 1) * DAY_MS).iso(), through,
      coverage: { opened: "unknown", merged: "unknown", repairs: "unknown", partialCounts: "observed lower bounds; not complete historical totals" },
      buckets: Array.from({ length: days }, (_, i) => ({ date: fixedClock(endDay - (days - 1 - i) * DAY_MS).iso().slice(0, 10),
        opened: null, merged: null, deliveredTasks: null, repairedPrs: null, repairRounds: null })),
      summary: { opened: null, merged: null, deliveredTasks: null, repairedPrs: null, repairRounds: null,
        repairReasons: { code: null, flake: null, infrastructure: null, conflict: null, unknown: null },
        mergeLatency: { unit: "ms", samples: 0, p50Ms: null, p90Ms: null, missingCreatedAt: 0 },
        openAge: { unit: "ms", censored: true, asOf: null, samples: 0, oldestMs: null, missingCreatedAt: 0 } },
      evidence: [], evidenceTruncated: false })) };
}

/** Validate persisted optional data before rendering; unsupported or corrupt data cannot erase Analytics. */
export function publicRepositoryFlow(value: unknown, repository: string, materializedAt: string): RepositoryFlow {
  const now = time(materializedAt) ?? systemClock.now();
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > REPOSITORY_FLOW_MAX_BYTES) return empty(repository, now, "over_budget");
    const parsed = schema.safeParse(value);
    if (!parsed.success || parsed.data.repository !== repository || parsed.data.windows[0]!.days !== 7 ||
      parsed.data.windows[1]!.days !== 30 || parsed.data.windows.some(w => w.buckets.length !== w.days ||
        w.evidence.some(e => e.url !== `https://github.com/${repository}/pull/${e.prNumber}`))) {
      return empty(repository, now, "invalid_source");
    }
    const clocks = [parsed.data.materializedAt, parsed.data.sources.openObservedAt, parsed.data.sources.closedObservedAt,
      parsed.data.sources.ledgerObservedAt, ...parsed.data.windows.map(w => w.through)].filter((v): v is string => v !== null);
    if (clocks.some(v => Date.parse(v) > now) || parsed.data.windows.some(w => Date.parse(w.from) > Date.parse(w.through))) {
      return empty(repository, now, "invalid_source");
    }
    return parsed.data;
  } catch {
    return { ...empty(repository, now, "invalid_source"), reason: "invalid_source" };
  }
}

/** Existing worker refresh only: reads existing board snapshots and the canonical ledger union, no GitHub call. */
export async function captureRepositoryFlow(root: string, stateDir: string, repository: string | undefined,
  clock: Clock = systemClock): Promise<RepositoryFlow | undefined> {
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.length > 240) return undefined;
  const now = clock.now();
  const result = empty(repository, now, "missing_source");
  const [owner, repo] = repository.split("/") as [string, string];
  const closed = boardReader(root, owner, repo);
  const open = readOpenBoardSnapshot(root, owner, repo);
  if (!open.ok && /bound|oversized/.test(open.reason)) return empty(repository, now, "over_budget");
  const openAt = open.ok ? time(open.snapshot.savedAt) : undefined;
  const closedAt = time(closed.closedObservedAt);
  const rows = [...closed.closed?.values() ?? [], ...open.ok ? open.snapshot.rows : []];
  if (rows.length > MAX_PRS) return empty(repository, now, "over_budget");
  const identity = (p: BoardPrRest) => Number.isSafeInteger(p.number) && p.number > 0 &&
    p.url === `https://github.com/${repository}/pull/${p.number}` && ["OPEN", "CLOSED", "MERGED"].includes(p.state);
  if (!rows.every(identity)) return empty(repository, now, "invalid_source");
  const prs = new Map<number, BoardPrRest>();
  for (const p of rows) {
    const previous = prs.get(p.number);
    if (!previous || (time(p.updatedAt) ?? -1) > (time(previous.updatedAt) ?? -1)) prs.set(p.number, p);
  }
  // Native credit index over data already in hand. No default git-log or GitHub transport is invoked.
  const creditIndex = buildBatchedGithub(owner, repo, { fetchAll: () => [...prs.values()],
    commitTrailerIndex: () => new Map(), now: () => now });
  const lookup = creditIndex.mergedTrailerLookup!();
  const delivered = new Map<number, Set<string>>();
  const credit = (n: number, id: string) => { const ids = delivered.get(n) ?? new Set<string>(); ids.add(id); delivered.set(n, ids); };
  for (const p of creditIndex.listMergedHeadBranches!() ?? []) {
    const id = taskIdFromRunBranch(p.headRefName);
    if (id) credit(p.number, id);
  }
  const candidates = new Set([...prs.values()].flatMap(p => [...p.body.matchAll(/^Remudero-Task:[ \t]*(W\d+-T\d+[A-Za-z]?|CONSOLE-T\d+|SITE-T\d+)[ \t]*$/gm)].map(m => m[1]!)));
  for (const id of candidates) {
    const hit = lookup?.(id);
    if (hit) credit(hit.number, id);
  }
  const prComplete = closed.closed !== undefined && open.ok;
  result.sources.openObservedAt = openAt === undefined ? null : fixedClock(openAt).iso();
  result.sources.closedObservedAt = closedAt === undefined ? null : fixedClock(closedAt).iso();
  result.sources.prCorpus = prComplete ? "complete" : rows.length ? "partial" : "unavailable";
  const prFresh = openAt !== undefined && closedAt !== undefined && now - openAt <= PR_SOURCE_FRESH_MS && now - closedAt <= PR_SOURCE_FRESH_MS;
  result.sources.prFreshness = openAt === undefined || closedAt === undefined ? "unknown" : prFresh ? "fresh" : "stale";
  result.sources.observedPrs = closed.closed !== undefined || open.ok ? prs.size : null;
  const gaps = new Set<string>();
  if (!prComplete) gaps.add("open or closed PR snapshot is missing or incomplete");
  if (openAt === undefined || closedAt === undefined) gaps.add("legacy snapshot has no source observation clock");
  if ((openAt ?? now) > now || (closedAt ?? now) > now) return empty(repository, now, "invalid_source");
  if (result.sources.prFreshness === "stale") gaps.add("PR checkpoint is older than the Analytics freshness bound");
  let complete = true, live = false, earliest: number | undefined, latest: number | undefined, overflow = false;
  const fingerprints = new Set<string>();
  const repairs = new Map<string, Repair>();
  const stream = openLedgerUnion(stateDir, { since: result.windows[1]!.from, dedupe: false,
    onUnreadArchive: () => { complete = false; }, onUnreadLive: () => { complete = false; },
    onMalformedRow: () => { complete = false; }, onLiveRead: () => { live = true; },
    onAcceptedRecord: (row, raw) => {
      const at = time(row.ts);
      if (at === undefined || at > now) { complete = false; return; }
      earliest = earliest === undefined ? at : Math.min(earliest, at);
      latest = latest === undefined ? at : Math.max(latest, at);
      if (row.step !== "fix.dispatch") return;
      const fingerprint = fingerprintLedgerLine(raw);
      if (fingerprints.has(fingerprint)) return;
      if (fingerprints.size >= MAX_REPAIR_IDENTITIES) { overflow = true; return; }
      fingerprints.add(fingerprint);
      // The real fix caller emits repair_pr_url/repair_round_id (fixWorkerReceipt),
      // not the generic aliases older collectors and fixtures used. Decode its
      // caller-owned context with the same projector as private repair accounting.
      const canonical = projectRepairCostContext(row);
      const hasCanonical = row.repair_pr_url !== undefined || row.repair_round_id !== undefined;
      const n = hasCanonical ? canonical.number : row.pr_number;
      const round = hasCanonical ? canonical.roundId : row.round_id;
      const scopeMatches = hasCanonical
        ? canonical.repo === repository &&
          (row.pr_number === undefined || row.pr_number === n) &&
          (row.pr_url === undefined || row.pr_url === row.repair_pr_url) &&
          (row.round_id === undefined || row.round_id === round)
        : row.pr_url === `https://github.com/${repository}/pull/${n}` ||
          row.pr_url === undefined && (row.repository === repository || row.repo === repository);
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0 || typeof row.head_sha !== "string" ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.head_sha) || typeof round !== "string" || !round.length ||
        round.length > 160 || !scopeMatches ||
        row.repository !== undefined && row.repository !== repository ||
        typeof row.repo === "string" && row.repo.includes("/") && row.repo !== repository) {
        gaps.add("repair rows without exact repository PR head and round were excluded"); return;
      }
      const reason = reasonNames.includes(row.reason_class as typeof reasonNames[number])
        ? row.reason_class as typeof reasonNames[number] : "unknown";
      const key = JSON.stringify([n, row.head_sha, round]);
      const previous = repairs.get(key);
      if (!previous) repairs.set(key, { pr: n, head: row.head_sha, round, at, reason });
      else if (previous.at !== at || previous.reason !== reason) {
        previous.at = Math.min(previous.at, at); previous.reason = "unknown";
        gaps.add("conflicting repair identity observations retain unknown classification");
      }
    } });
  try { for await (const row of stream) { void row; if (overflow) break; } }
  catch {
    // The public ledgerCorpus remains partial/unavailable and repair totals cannot claim completeness.
    complete = false;
    gaps.add("ledger collection failed; repair totals are unavailable");
  }
  result.sources.ledgerObservedAt = live ? clock.iso() : null;
  result.sources.ledgerCorpus = live && complete ? "observed" : live || earliest !== undefined ? "partial" : "unavailable";
  result.sources.earliestLedgerAt = earliest === undefined ? null : fixedClock(earliest).iso();
  result.sources.latestLedgerAt = latest === undefined ? null : fixedClock(latest).iso();
  result.sources.observedRepairIdentities = repairs.size || live ? repairs.size : null;
  if (!complete || !live) gaps.add("retained ledger corpus is unavailable or partially readable");
  gaps.add("repair counts cover observed retained receipts, not verified full historical absence");
  if (overflow) return empty(repository, now, "over_budget");
  for (const window of result.windows) {
    const from = Date.parse(window.from);
    const inWindow = (at: number | undefined): at is number => at !== undefined && at >= from && at <= now;
    const counts = new Map(window.buckets.map(b => [b.date, { opened: new Set<number>(), merged: new Set<number>(),
      tasks: new Set<string>(), repairs: new Set<number>(), rounds: new Set<string>() }]));
    const opened = new Set<number>(), merged = new Set<number>(), tasks = new Set<string>();
    const latencies: number[] = [], ages: number[] = [];
    let missingCreation = 0, missingOpenCreation = 0, missingMerge = false, missingOpened = false;
    const evidence: RepositoryFlow["windows"][number]["evidence"] = [];
    const add = (p: number, kind: "opened" | "merged" | "repair", at: number) => {
      if (evidence.length < 64) evidence.push({ prNumber: p, url: `https://github.com/${repository}/pull/${p}`, kind, at: fixedClock(at).iso() });
      else window.evidenceTruncated = true;
    };
    for (const p of prs.values()) {
      const created = time(p.createdAt), mergedAt = time(p.mergedAt);
      if (created === undefined || created > now) missingOpened = true;
      if (inWindow(created)) { opened.add(p.number); counts.get(fixedClock(created).iso().slice(0, 10))!.opened.add(p.number); add(p.number, "opened", created); }
      if (p.state === "MERGED" && (mergedAt === undefined || mergedAt > now) && (time(p.updatedAt) ?? now) >= from) missingMerge = true;
      if (p.state === "MERGED" && inWindow(mergedAt)) {
        merged.add(p.number); const bucket = counts.get(fixedClock(mergedAt).iso().slice(0, 10))!; bucket.merged.add(p.number);
        for (const task of delivered.get(p.number) ?? []) { tasks.add(task); bucket.tasks.add(task); }
        if (created === undefined || created > mergedAt) missingCreation++; else latencies.push(mergedAt - created);
        add(p.number, "merged", mergedAt);
      }
      if (p.state === "OPEN") {
        if (created === undefined || openAt === undefined || created > openAt) missingOpenCreation++; else ages.push(openAt - created);
      }
    }
    const observed = [...repairs].filter(([, r]) => inWindow(r.at));
    const repairedPrs = new Set(observed.map(([, r]) => r.pr));
    const repairKnown = observed.length > 0;
    const reasons = { code: 0, flake: 0, infrastructure: 0, conflict: 0, unknown: 0 };
    for (const [key, r] of observed) {
      const bucket = counts.get(fixedClock(r.at).iso().slice(0, 10))!;
      bucket.repairs.add(r.pr); bucket.rounds.add(key); reasons[r.reason]++; add(r.pr, "repair", r.at);
    }
    const mergesKnown = prComplete && prFresh && !missingMerge;
    const openedKnown = prComplete && prFresh && !missingOpened;
    const observedCount = (count: number, isComplete: boolean) => isComplete || count > 0 ? count : null;
    window.coverage = { opened: openedKnown ? "complete" : opened.size ? "observed" : "unknown",
      merged: mergesKnown ? "complete" : merged.size ? "observed" : "unknown", repairs: repairKnown ? "observed" : "unknown",
      partialCounts: "observed lower bounds; not complete historical totals" };
    for (const bucket of window.buckets) {
      const count = counts.get(bucket.date)!;
      Object.assign(bucket, { opened: observedCount(count.opened.size, openedKnown), merged: observedCount(count.merged.size, mergesKnown),
        deliveredTasks: observedCount(count.tasks.size, mergesKnown), repairedPrs: observedCount(count.repairs.size, false),
        repairRounds: observedCount(count.rounds.size, false) });
    }
    Object.assign(window.summary, { opened: observedCount(opened.size, openedKnown), merged: observedCount(merged.size, mergesKnown),
      deliveredTasks: observedCount(tasks.size, mergesKnown), repairedPrs: repairKnown ? repairedPrs.size : null,
      repairRounds: repairKnown ? observed.length : null,
      repairReasons: repairKnown ? reasons : { code: null, flake: null, infrastructure: null, conflict: null, unknown: null },
      mergeLatency: { unit: "ms", samples: latencies.length, p50Ms: percentile(latencies, .5), p90Ms: percentile(latencies, .9), missingCreatedAt: missingCreation },
      openAge: { unit: "ms", censored: true, asOf: result.sources.openObservedAt, samples: ages.length,
        oldestMs: ages.length ? Math.max(...ages) : null, missingCreatedAt: missingOpenCreation } });
    if (missingOpened || missingMerge || missingCreation || missingOpenCreation) gaps.add("legacy or invalid PR event metadata leaves counts or latency samples incomplete");
    window.evidence = evidence;
  }
  result.reason = rows.length || prComplete || repairs.size ? null : "missing_source";
  result.state = result.reason ? "not_collected" : "partial";
  result.gaps = [...gaps];
  result.materializedAt = clock.iso();
  return publicRepositoryFlow(result, repository, clock.iso());
}
