import { createHash } from "node:crypto";
import { improvementEffectNamespaceDir, projectGardenerOpportunityEvidence } from "./gardener-opportunity-evidence.js";
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, lstatSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createBoardSnapshotReader, readBoardClosedCollectionReceipt, readOpenBoardSnapshot } from "./board-snapshot-cache.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { dailyDateAt, dailyWindow, DEFAULT_DAILY_PROGRESS_ZONE, nextDailyDue, shiftDailyDate } from "./daily-progress-calendar.js";
import { validateRepositoryEvidenceInventory, type DailyProgressEvent, type DailyProgressReport, type SourceCoverage, type ExpectedDailySource } from "./daily-progress-contract.js";
import { dailyProgressDayKey, prepareDailyProgressPublication, readDailyProgressManifest, readDailyProgressRevision, type DailyProgressJob, type DailyProgressRecord } from "./daily-progress-store.js";
import { fingerprintLedgerLine, listedLedgerFiles, openLedgerUnion, rotationStampIso, type LedgerCorpusEntry } from "./ledger-union.js";
import type { BoardPrRest } from "./open-prs-rest.js";
import { taskIdFromRunBranch } from "./status.js";
import { HAND_WORKTREE_TASK_ID_RE } from "./hand-worktree.js";
import { repositoriesSourcesPath } from "./repositories-view.js";

export interface DailyProgressInstance { name: string; repository: string; root: string; stateDir: string }
export interface DailyProgressCollectionConfig {
  stateDir: string; instances: DailyProgressInstance[]; timeZone?: string;
  /** Restrict reads to held instances without removing configured source expectations. */
  ownedInstanceNames?: string[];
  expectedRepositories?: string[]; correctionDates?: string[];
}
const REPOSITORY = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i;
/** BACKSTOPS: work per pass; unprocessed closing dates remain durably due. */
const CATCH_UP_DAYS = 14, CORRECTION_DAYS = 7, MAX_DATES = 32;
const TASK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const stamp = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? fixedClock(Date.parse(value)).iso() : null;
const jobId = (repository: string, zone: string): string => createHash("sha256").update(JSON.stringify([repository, zone])).digest("hex");

/** Expected scope comes from the server publisher, never from the observed event population. */
export function readDailyProgressRepositories(stateDir: string): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(repositoriesSourcesPath(stateDir), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("repository inventory exceeds its read bound");
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, size);
      if (read === 0) break;
      size += read;
    }
    const after = fstatSync(fd);
    if (size !== stat.size || size > 1024 * 1024 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("repository inventory changed during the bounded read");
    const raw = JSON.parse(bytes.subarray(0, size).toString("utf8")) as { improvementEvidence?: { version?: string; repositories?: Array<{ repository: string }>; unresolvedInstances?: unknown[] } };
    const checked = validateRepositoryEvidenceInventory(raw.improvementEvidence);
    if (!checked.ok || checked.value.unresolvedInstances.length || !checked.value.repositories.length || checked.value.repositories.length > 256) throw new Error("expected repository scope is unresolved or invalid");
    const inventory = checked.value;
    return [...new Set(inventory.repositories.map(r => r.repository.toLowerCase()))].sort();
  } catch (error) {
    throw new Error("Daily progress repository inventory is unavailable; complete fleet scope is not established.", { cause: error });
  } finally { if (fd !== undefined) closeSync(fd); }
}

function taskIds(pr: BoardPrRest): string[] {
  const branch = taskIdFromRunBranch(pr.headRefName);
  const trailers = [...pr.body.matchAll(/^Remudero-Task:[ \t]*([A-Za-z0-9._-]+)[ \t]*$/gm)].map(m => m[1]!);
  return [...new Set([...(branch ? [branch] : []), ...trailers].filter(id => HAND_WORKTREE_TASK_ID_RE.test(id)))].sort();
}

function prIdentity(pr: BoardPrRest, repository: string, states: readonly string[] = ["MERGED", "CLOSED"]): boolean {
  if (!Number.isSafeInteger(pr.number) || pr.number < 1 || !URL.canParse(pr.url)) return false;
  const url = new URL(pr.url);
  return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.search && !url.hash &&
    url.pathname.toLowerCase() === `/${repository}/pull/${pr.number}` && states.includes(pr.state);
}

const activityLabel: Readonly<Record<string, string>> = {
  "worker.spawn": "Worker started", "worker.finished": "Worker finished", "worker.assignment": "Work assigned",
  "fix.dispatch": "Repair attempt recorded", "pr.opened": "Pull request opened", "verdict": "Work status reported",
};

/** A native observation is activity, never task-completion or causal benefit credit. */
function improvementActivity(row: Record<string, unknown>, repository: string, occurredAt: string, now: number): { title: string; taskIds: string[]; url: string | null } | undefined {
  if (row.step !== "opportunity_outcome.effect_observed" || typeof row.proposal_id !== "string") return undefined;
  const projected = projectGardenerOpportunityEvidence([{ key: row.opportunity_key, proposalId: row.proposal_id,
    candidate: { repo: repository, key: row.proposal_id, observedAt: occurredAt }, sourceIds: [row.source_snapshot_id ?? (row.improvement_source as { snapshotId?: unknown } | undefined)?.snapshotId],
    at: occurredAt, state: "merged", improvement: row.improvement_source, effect: row.effect }], repository, fixedClock(now));
  if (projected.state !== "reported" || projected.improvementEffects.length !== 1) return undefined;
  const effect = projected.improvementEffects[0]!;
  const title = effect.verdict === "helped" ? "Improvement check reported fewer findings for this rule"
    : effect.verdict === "hurt" ? "Improvement check reported more findings for this rule"
    : effect.verdict === "unchanged" ? "Improvement check reported the same number of findings for this rule"
    : "Improvement check needs more evidence";
  return { title, taskIds: effect.taskIds, url: effect.mergePrUrls[0] ?? effect.planPrUrl };
}

/**
 * One ledger row the activity read keeps: only what can become a displayed event, never the row's payload (a worker row
 * can carry tens of KiB). `rowId` is the row's whole-row identity hash, computed once; an improvement row keeps the few
 * fields its projection reads.
 */
interface ActivityCandidate {
  ts: unknown; step: string; taskId: unknown; repository: unknown; fingerprint: string;
  rowId?: string; improvement?: Record<string, unknown>;
}
/** What one immutable rotation archive gave the activity read, kept for the archive's (path, size, mtime). */
interface ArchiveActivity { identity: string; sinceMs: number; candidates: ActivityCandidate[]; malformed: number; newestMs: number }

/**
 * W1-T13442: each rotated archive's activity candidates, read once per (root, repository, archive). OBSERVED 2026-11-17 on
 * the Azure host: with closedThrough stuck at 2026-10-26 the collection read three weeks of archives on every attempt,
 * outran its 120 s deadline, was cancelled (read_model.daily_cancelled every 128-147 s, nothing staged) and started over
 * from zero, holding the slow lane at ~0.58 cores. An archive never changes once rotated, so a cancelled attempt now keeps
 * every archive it finished, the next attempt resumes past them, and a due run re-reads only the live ledger.
 * Process-local (the slow lane's thread outlives its runs); entries for archives no longer in a run's window are dropped.
 */
export type DailyActivityMemo = Map<string, ArchiveActivity>;
export function createDailyActivityMemo(): DailyActivityMemo { return new Map(); }
const processActivityMemo: DailyActivityMemo = createDailyActivityMemo();

const ACTIVITY_STEPS = new Set([...Object.keys(activityLabel), "opportunity_outcome.effect_observed"]);
/** Whether a row can ever become an event for `repository`; everything else is dropped before it is kept. */
const candidateRow = (row: Record<string, unknown>, repository: string): boolean =>
  typeof row.step === "string" && ACTIVITY_STEPS.has(row.step) && (row.repository === undefined || row.repository === repository);
/** Producer metadata differs between the native and projection ledgers: an identity hashes keys in a fixed order. */
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, stable(child)])) : value;
const identityHash = (identity: unknown): string => createHash("sha256").update(JSON.stringify(stable(identity))).digest("hex");
function candidate(row: Record<string, unknown>, repository: string, raw: string): ActivityCandidate {
  const kept: ActivityCandidate = { ts: row.ts, step: row.step as string, taskId: row.task_id, repository: row.repository, fingerprint: fingerprintLedgerLine(raw) };
  if (row.step === "opportunity_outcome.effect_observed") {
    kept.improvement = { step: row.step, proposal_id: row.proposal_id, opportunity_key: row.opportunity_key, source_snapshot_id: row.source_snapshot_id,
      improvement_source: row.improvement_source, effect: row.effect };
  }
  // A native row's identity is the whole row; hashed now so its payload is never retained.
  kept.rowId = identityHash([repository, row]);
  return kept;
}

/** The rotated archives of `root` whose rows can reach `sinceMs`, oldest first, as openLedgerUnion orders them. */
function archivesInWindow(root: string, sinceMs: number, unreadDirectory: () => void): LedgerCorpusEntry[] {
  return listedLedgerFiles(root, { readdirSync: (dir) => readdirSync(dir) }, unreadDirectory).rotations.filter((entry) => {
    const stamp = rotationStampIso(basename(entry.path));
    return stamp === undefined || !(Date.parse(stamp) < sinceMs);
  });
}

async function readArchive(root: string, entry: LedgerCorpusEntry, repository: string, memo: DailyActivityMemo, key: string,
  since: string, signal: AbortSignal | undefined): Promise<ArchiveActivity | undefined> {
  let identity: string;
  try {
    const stat = statSync(entry.path);
    identity = `${stat.ino}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch (_err) {
    // Rotated away (compacted or pruned) between the listing and the stat: openLedgerUnion names it unread below.
    identity = "unstattable";
  }
  const held = memo.get(key);
  // An entry read from a later `since` lacks the rows before it; the window only moves later, so this is a rare re-read.
  if (held && held.identity === identity && held.sinceMs <= Date.parse(since)) return held;
  const read: ArchiveActivity = { identity, sinceMs: Date.parse(since), candidates: [], malformed: 0, newestMs: Number.NEGATIVE_INFINITY };
  let unread = false, acceptedRaw = "";
  for await (const row of openLedgerUnion(root, { since, dedupe: false, includeLive: false, corpusSnapshot: { rotations: [entry], unclassified: [], auxiliary: [] },
    ...(signal ? { signal } : {}), onAcceptedRecord: (_row, raw) => { acceptedRaw = raw; },
    onUnreadArchive: () => { unread = true; }, onUnreadDirectory: () => { unread = true; }, onMalformedRow: () => { read.malformed++; } })) {
    const raw = acceptedRaw; acceptedRaw = "";
    signal?.throwIfAborted();
    const ts = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
    if (ts > read.newestMs) read.newestMs = ts;
    if (candidateRow(row, repository)) read.candidates.push(candidate(row, repository, raw));
  }
  // An archive that could not be read is a gap this run and is read again next run: only a whole read is kept.
  if (unread || identity === "unstattable") return undefined;
  memo.set(key, read);
  return read;
}

export async function readDailyActivity(source: DailyProgressInstance, fleetStateDir: string, since: string, now: number, signal?: AbortSignal,
  memo: DailyActivityMemo = processActivityMemo): Promise<{ events: DailyProgressEvent[]; gaps: number; available: boolean }> {
  const events: DailyProgressEvent[] = [];
  let gaps = 0, rowsRead = 0;
  const roots = [source.stateDir], isolated = improvementEffectNamespaceDir(fleetStateDir, source.repository, source.name);
  try { if (!lstatSync(isolated).isDirectory()) gaps++; else roots.push(isolated); }
  catch (error) {
    // The optional projection has no history before its first publication. An unreadable existing
    // namespace is a gap; absence does not imply a complete native activity corpus.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") gaps++;
  }
  const sinceMs = Date.parse(since);
  for (const root of roots) {
    const selectedReplay = new Set<string>();
    const accept = (kept: ActivityCandidate): void => {
      const { fingerprint } = kept;
      const occurredAt = stamp(kept.ts);
      if (!occurredAt || Date.parse(occurredAt) > now || Date.parse(occurredAt) < sinceMs) return;
      const improvement = kept.improvement ? improvementActivity(kept.improvement, source.repository, occurredAt, now) : undefined;
      const label = improvement?.title ?? activityLabel[kept.step];
      if (!label) return;
      if (kept.repository !== undefined && kept.repository !== source.repository) return;
      // Keep exact raw replay accounting per root, before semantic reconciliation. Only displayed
      // activity needs an identity inventory; unrelated payloads live for this iteration alone.
      if (selectedReplay.has(fingerprint)) return;
      selectedReplay.add(fingerprint);
      // The reader catches callback exceptions as read gaps. Refuse here so no partial result can publish.
      if (events.length >= 100_000) throw new Error("Daily activity exceeds the bounded collection population; retained history is unchanged.");
      const task = typeof kept.taskId === "string" && TASK.test(kept.taskId) ? kept.taskId : undefined;
      // Bind duplicate observations to their source/effect identity instead of the append location or actor.
      const id = improvement
        ? identityHash([source.repository, occurredAt, kept.improvement!.proposal_id, kept.improvement!.improvement_source, kept.improvement!.effect])
        : kept.rowId!;
      events.push({ id: `activity:${source.repository}:${id}`, repository: source.repository, kind: "activity", sourceId: `${source.repository}:ledger:${source.name}`,
        occurredAt, observedAt: fixedClock(now).iso(), fleetAttribution: "confirmed", taskIds: improvement?.taskIds ?? (task ? [task] : []), title: improvement ? label : task ? `${label} · ${task}` : label, url: improvement?.url ?? null });
    };
    const kept = new Set<string>();
    for (const entry of archivesInWindow(root, sinceMs, () => gaps++)) {
      const key = `${root}\u0000${source.repository}\u0000${entry.path}`;
      kept.add(key);
      const archive = await readArchive(root, entry, source.repository, memo, key, since, signal);
      if (!archive) { gaps++; continue; }
      gaps += archive.malformed;
      if (archive.newestMs >= sinceMs) rowsRead++;
      for (const candidate of archive.candidates) accept(candidate);
    }
    // Archives that left the window (or the directory) are never read again by this root: their entries go.
    for (const key of memo.keys()) if (key.startsWith(`${root}\u0000${source.repository}\u0000`) && !kept.has(key)) memo.delete(key);
    // The live ledger grows between runs, so it is read whole each run, as before.
    let acceptedRaw = "";
    for await (const row of openLedgerUnion(root, { since, dedupe: false, corpusSnapshot: { rotations: [], unclassified: [], auxiliary: [] }, ...(signal ? { signal } : {}),
      onAcceptedRecord: (_row, raw) => { acceptedRaw = raw; },
      onUnreadLive: () => gaps++, onUnreadDirectory: () => gaps++, onMalformedRow: () => gaps++ })) {
      const raw = acceptedRaw; acceptedRaw = "";
      signal?.throwIfAborted();
      rowsRead++;
      if (candidateRow(row, source.repository)) accept(candidate(row, source.repository, raw));
    }
  }
  return { events, gaps, available: gaps === 0 || rowsRead > 0 };
}

/** Reconcile cached sources only. The existing PR collector remains the sole GitHub fetcher. */
export async function collectDailyProgress(config: DailyProgressCollectionConfig, clock: Clock = systemClock, signal?: AbortSignal,
  activityMemo: DailyActivityMemo = processActivityMemo):
  Promise<ReturnType<typeof prepareDailyProgressPublication> | undefined> {
  const now = clock.now(), timeZone = config.timeZone ?? DEFAULT_DAILY_PROGRESS_ZONE;
  const today = dailyDateAt(now, timeZone), yesterday = shiftDailyDate(today, -1);
  const expected = [...new Set((config.expectedRepositories ?? readDailyProgressRepositories(config.stateDir)).map(r => r.toLowerCase()))].sort();
  if (!expected.length || expected.length > 256 || expected.some(r => !REPOSITORY.test(r))) throw new Error("invalid server-owned daily repository inventory");
  if ((config.correctionDates?.length ?? 0) > MAX_DATES) throw new Error("too many targeted daily corrections");
  const manifest = readDailyProgressManifest(config.stateDir), board = createBoardSnapshotReader();
  const records: DailyProgressRecord[] = [], jobs: DailyProgressJob[] = [];
  for (const repository of expected) {
    signal?.throwIfAborted();
    const id = jobId(repository, timeZone), previousJob = manifest.jobs[id];
    if (previousJob && Date.parse(previousJob.nextDueAt) > now) continue;
    const dates = new Set([today, yesterday]);
    for (let i = 2; i <= CORRECTION_DAYS; i++) dates.add(shiftDailyDate(today, -i));
    let closing = previousJob?.closedThrough ? shiftDailyDate(previousJob.closedThrough, 1) : yesterday;
    for (let i = 0; closing < today && i < CATCH_UP_DAYS; i++, closing = shiftDailyDate(closing, 1)) dates.add(closing);
    for (const date of config.correctionDates ?? []) { dailyWindow(date, timeZone); if (date > today) throw new Error("future daily correction refused"); dates.add(date); }
    if (dates.size > MAX_DATES) throw new Error("daily catch-up exceeds its per-pass calendar bound");
    const ordered = [...dates].sort(), earliest = dailyWindow(ordered[0]!, timeZone).windowStart;
    const configuredInstances = config.instances.filter(s => s.repository.toLowerCase() === repository).map(s => ({ ...s, repository }));
    const configured: ExpectedDailySource[] = configuredInstances.flatMap(instance => [
      { id: `${repository}:prs:${instance.name}`, repository, instanceId: instance.name, kind: "pull_requests" as const, required: true },
      { id: `${repository}:ledger:${instance.name}`, repository, instanceId: instance.name, kind: "ledger_activity" as const, required: false },
    ]);
    if (!configuredInstances.length) configured.push({ id: `${repository}:prs:missing`, repository, instanceId: null, kind: "pull_requests", required: true },
      { id: `${repository}:ledger:missing`, repository, instanceId: null, kind: "ledger_activity", required: false });
    const expectedSources: ExpectedDailySource[] = [...configured,
      { id: `${repository}:deployments`, repository, instanceId: null, kind: "deployments", required: false },
      { id: `${repository}:open`, repository, instanceId: null, kind: "pull_requests", required: false }];
    const instances = configuredInstances.filter(s => config.ownedInstanceNames === undefined || config.ownedInstanceNames.includes(s.name));
    const raw = instances.map(instance => {
      const [owner, repo] = repository.split("/") as [string, string];
      const saved = board(instance.root, owner, repo), rows = [...saved.closed?.values() ?? []];
      const receipt = readBoardClosedCollectionReceipt(instance.root, owner, repo, rows);
      return { instance, saved, rows, receipt, open: readOpenBoardSnapshot(instance.root, owner, repo) };
    });
    // W1-T13454: each repository is judged at the time its files were read, never at the pass's start. OBSERVED
    // 2026-11-17: the console's closed-PR receipt is rewritten every minute and was read minutes into the pass (behind
    // core's ledger read), so every console report read "The source receipt is newer than this report's cutoff".
    const readAt = Math.max(now, clock.now()), at = fixedClock(readAt).iso();
    const activities = await Promise.all(instances.map(async instance => ({ instance, ...await readDailyActivity(instance, config.stateDir, earliest, readAt, signal, activityMemo) })));
    signal?.throwIfAborted();
    let closedThrough = previousJob?.closedThrough ?? shiftDailyDate(yesterday, -1), requiredFailed = false;
    for (const reportDate of ordered) {
      const window = dailyWindow(reportDate, timeZone), end = Date.parse(window.windowEnd), start = Date.parse(window.windowStart), cutoff = Math.min(readAt, end);
      const day = manifest.days[dailyProgressDayKey(repository, timeZone, reportDate)];
      const old = day ? readDailyProgressRevision(config.stateDir, day) : undefined;
      const sources: SourceCoverage[] = [], events = new Map<string, DailyProgressEvent>();
      let invalid = 0;
      for (const source of raw) {
        const receipt = source.receipt.ok ? source.receipt.receipt : undefined;
        const success = receipt?.lastSuccessAt ?? source.saved.closedObservedAt ?? null;
        const sane = success !== null && Date.parse(success) <= readAt;
        const attempted = receipt?.lastAttemptAt ?? (sane ? success : null);
        const validClock = attempted === null || Date.parse(attempted) <= readAt;
        const covers = sane && Date.parse(success) >= cutoff;
        const full = source.receipt.ok && receipt?.state === "complete" && validClock && covers;
        const state: SourceCoverage["state"] = full ? "complete" : receipt?.state === "unavailable" ? "unavailable" : source.saved.closed !== undefined ? "partial" : "not_collected";
        const coverage: SourceCoverage = { id: `${repository}:prs:${source.instance.name}`, repository, instanceId: source.instance.name, kind: "pull_requests", required: true, state,
          lastAttemptAt: validClock ? attempted : null, lastSuccessAt: sane && validClock ? success : null,
          coverageStart: sane && validClock && Date.parse(success) >= start ? window.windowStart : null,
          coverageThrough: sane && validClock && Date.parse(success) >= start ? fixedClock(Math.min(Date.parse(success), end)).iso() : null,
          nextDueAt: fixedClock(nextDailyDue(readAt, timeZone)).iso(), reason: full ? null : !validClock ? "The source receipt is newer than this report's cutoff." : receipt?.reason === "fetch_failed" ? "The latest PR collection failed; saved evidence is retained." : "The saved PR source does not certify complete coverage through this report's cutoff." };
        sources.push(coverage);
        for (const pr of source.rows) {
          if (!prIdentity(pr, repository)) { invalid++; continue; }
          if (pr.state !== "MERGED") continue;
          if (pr.authorType === "Bot" && ["dependabot[bot]", "renovate[bot]"].includes(pr.authorLogin?.toLowerCase() ?? "")) continue;
          const occurredAt = stamp(pr.mergedAt);
          // W1-T13454: GitHub moves updatedAt at a merge, so a merge with no saved time whose last update precedes this
          // window merged before it and is no evidence about this day. OBSERVED 2026-11-17: 8,452 legacy core rows
          // (and 131 site, 561 console) carry no mergedAt, which made every required PR source partial for every day.
          const updatedAt = stamp(pr.updatedAt);
          if (!occurredAt && updatedAt && Date.parse(updatedAt) < start) continue;
          if (!occurredAt || Date.parse(occurredAt) > readAt) { invalid++; continue; }
          if (Date.parse(occurredAt) < start || Date.parse(occurredAt) >= end) continue;
          const ids = taskIds(pr), eventId = `merged:${repository}:${pr.number}`;
          events.set(eventId, { id: eventId, repository, kind: "merged", sourceId: coverage.id, occurredAt, observedAt: at,
            fleetAttribution: ids.length || taskIdFromRunBranch(pr.headRefName) ? "confirmed" : "unknown", taskIds: ids, title: pr.title.trim().slice(0, 2048) || "Merged change", url: pr.url });
        }
      }
      for (const instance of configuredInstances.filter(s => !instances.includes(s))) {
        for (const kind of ["pull_requests", "ledger_activity"] as const) sources.push({
          id: `${repository}:${kind === "pull_requests" ? "prs" : "ledger"}:${instance.name}`, repository, instanceId: instance.name, kind,
          required: kind === "pull_requests", state: "not_collected", lastAttemptAt: null, lastSuccessAt: null,
          coverageStart: null, coverageThrough: null, nextDueAt: null,
          reason: "This configured source is not owned by this collector; its coverage is not established.",
        });
      }
      if (!configuredInstances.length) sources.push({ id: `${repository}:prs:missing`, repository, instanceId: null, kind: "pull_requests", required: true, state: "not_collected", lastAttemptAt: null, lastSuccessAt: null,
        coverageStart: null, coverageThrough: null, nextDueAt: fixedClock(nextDailyDue(readAt, timeZone)).iso(), reason: "No configured PR source is available for this repository." });
      if (invalid) for (const source of sources) if (source.required && source.state === "complete") { source.state = "partial"; source.reason = "Some saved PR identities or clocks are invalid; complete totals are unavailable."; }
      for (const observed of activities) {
        sources.push({ id: `${repository}:ledger:${observed.instance.name}`, repository, instanceId: observed.instance.name, kind: "ledger_activity", required: false, state: observed.available ? "partial" : "unavailable", lastAttemptAt: at, lastSuccessAt: observed.available ? at : null,
          coverageStart: observed.available ? window.windowStart : null, coverageThrough: observed.available ? fixedClock(cutoff).iso() : null, nextDueAt: fixedClock(nextDailyDue(readAt, timeZone)).iso(),
          reason: `Retained ledger observations do not establish complete activity history.${observed.gaps ? ` ${observed.gaps} source or parse gaps were observed.` : ""}` });
        for (const event of observed.events) if (Date.parse(event.occurredAt) >= start && Date.parse(event.occurredAt) < end) events.set(event.id, event);
      }
      if (!configuredInstances.length) sources.push({ id: `${repository}:ledger:missing`, repository, instanceId: null, kind: "ledger_activity", required: false, state: "not_collected", lastAttemptAt: null, lastSuccessAt: null,
        coverageStart: null, coverageThrough: null, nextDueAt: null, reason: "No activity source is configured for this repository." });
      sources.push({ id: `${repository}:deployments`, repository, instanceId: null, kind: "deployments", required: false, state: "not_collected", lastAttemptAt: null, lastSuccessAt: null,
        coverageStart: null, coverageThrough: null, nextDueAt: null, reason: "Deployment evidence is not collected. A merge does not establish deployment." });
      const retained = new Map(old?.events.map(e => [e.id, e]) ?? []); for (const event of events.values()) retained.set(event.id, event);
      const confirmed = [...retained.values()].filter(e => e.kind === "merged" && e.fleetAttribution === "confirmed");
      const unknown = [...retained.values()].some(e => e.kind === "merged" && e.fleetAttribution === "unknown");
      const complete = raw.length > 0 && sources.filter(source => source.required).every(source => source.state === "complete"), precision = complete && !unknown ? "exact" : confirmed.length ? "at_least" : "unavailable";
      const present = raw.flatMap(s => s.open.ok && Date.parse(s.open.snapshot.savedAt) <= now && s.open.snapshot.rows.every(pr => prIdentity(pr, repository, ["OPEN"])) ? [s.open.snapshot] : []).sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
      if (reportDate === today && present) sources.push({ id: `${repository}:open`, repository, instanceId: null, kind: "pull_requests", required: false, state: "partial",
        lastAttemptAt: present.savedAt, lastSuccessAt: present.savedAt, coverageStart: present.savedAt, coverageThrough: present.savedAt, nextDueAt: null,
        reason: `Present open work is a snapshot, not daily activity. Showing ${Math.min(present.rows.length, 200)} of ${present.rows.length} open pull requests.` });
      const reportExpectedSources = [...expectedSources];
      for (const previous of old?.report.coverage.sources ?? []) if (!reportExpectedSources.some(s => s.id === previous.id)) {
        const { id, repository, kind, instanceId } = previous;
        reportExpectedSources.push({ id, repository, kind, instanceId, required: false });
        sources.push({ ...previous, required: false, state: "unavailable", reason: "This historical source is no longer configured; retained evidence remains available." });
      }
      const currentWork: DailyProgressReport["currentWork"] = reportDate === today && present ? { asOf: present.savedAt,
        items: present.rows.slice(0, 200).map(pr => ({ repository, id: `pr:${repository}:${pr.number}`, title: pr.title.slice(0, 2048) || "Open pull request", url: pr.url })) } : null;
      const included = raw.some(s => s.saved.closed !== undefined) || activities.some(s => s.available) || old;
      records.push({ version: "daily-progress-v1", scope: { kind: "repository", repository }, ...window, generatedAt: at,
        phase: end <= readAt ? complete ? "complete" : "finalizing" : "provisional", coverage: { state: included ? "partial" : "not_collected", expectedRepositories: [repository],
          includedRepositories: included ? [repository] : [], expectedSources: reportExpectedSources, sources },
        totals: { mergedChanges: { value: precision === "unavailable" ? null : confirmed.length, precision }, completedTasks: { value: precision === "unavailable" ? null : 0, precision } },
        events: [...events.values()], currentWork });
      if (end <= readAt && complete && reportDate === shiftDailyDate(closedThrough, 1)) closedThrough = reportDate;
      if (!complete) requiredFailed = true;
    }
    const catchingUp = closing < today && closedThrough >= shiftDailyDate(closing, -1);
    jobs.push({ id, lastAttemptAt: at, lastSuccessAt: requiredFailed ? previousJob?.lastSuccessAt ?? null : at,
      nextDueAt: catchingUp ? at : fixedClock(nextDailyDue(readAt, timeZone)).iso(), closedThrough,
      error: requiredFailed ? "Some required PR sources do not yet cover the requested report cutoffs." : null });
  }
  signal?.throwIfAborted();
  return records.length || jobs.length ? prepareDailyProgressPublication(config.stateDir, records, jobs) : undefined;
}
