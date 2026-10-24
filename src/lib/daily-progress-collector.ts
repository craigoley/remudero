import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { createBoardSnapshotReader, readBoardClosedCollectionReceipt, readOpenBoardSnapshot } from "./board-snapshot-cache.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { dailyDateAt, dailyWindow, DEFAULT_DAILY_PROGRESS_ZONE, nextDailyDue, shiftDailyDate } from "./daily-progress-calendar.js";
import type { DailyProgressEvent, DailyProgressReport, SourceCoverage } from "./daily-progress-contract.js";
import { dailyProgressDayKey, prepareDailyProgressPublication, readDailyProgressManifest, readDailyProgressRevision, type DailyProgressJob, type DailyProgressRecord } from "./daily-progress-store.js";
import { openLedgerUnion } from "./ledger-union.js";
import type { BoardPrRest } from "./open-prs-rest.js";
import { taskIdFromRunBranch } from "./status.js";
import { HAND_WORKTREE_TASK_ID_RE } from "./hand-worktree.js";
import { repositoriesSourcesPath } from "./repositories-view.js";

export interface DailyProgressInstance { name: string; repository: string; root: string; stateDir: string }
export interface DailyProgressCollectionConfig {
  stateDir: string; instances: DailyProgressInstance[]; timeZone?: string;
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
    fd = openSync(repositoriesSourcesPath(stateDir), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("repository inventory exceeds its read bound");
    const raw = JSON.parse(readFileSync(fd, "utf8")) as { improvementEvidence?: { version?: string; repositories?: Array<{ repository: string }>; unresolvedInstances?: unknown[] } };
    const inventory = raw.improvementEvidence;
    if (!inventory || inventory.version !== "repository-evidence-inventory-v1" || !Array.isArray(inventory.repositories) ||
        !Array.isArray(inventory.unresolvedInstances) || inventory.unresolvedInstances.length ||
        !inventory.repositories.length || inventory.repositories.length > 256 || inventory.repositories.some(r => !r || typeof r.repository !== "string" || !REPOSITORY.test(r.repository))) throw new Error("expected repository scope is unresolved");
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
  "fix.dispatch": "Repair requested", "pr.opened": "Pull request opened", "verdict": "Work status reported",
};

async function activity(source: DailyProgressInstance, since: string, now: number, signal?: AbortSignal): Promise<{ events: DailyProgressEvent[]; gaps: number; available: boolean }> {
  const events: DailyProgressEvent[] = [];
  let gaps = 0, rowsRead = 0;
  for await (const row of openLedgerUnion(source.stateDir, { since, dedupe: true, ...(signal ? { signal } : {}),
    onUnreadArchive: () => gaps++, onUnreadLive: () => gaps++, onUnreadDirectory: () => gaps++, onMalformedRow: () => gaps++ })) {
    signal?.throwIfAborted();
    rowsRead++;
    const occurredAt = stamp(row.ts), label = typeof row.step === "string" ? activityLabel[row.step] : undefined;
    if (!occurredAt || Date.parse(occurredAt) > now || !label) continue;
    if (row.repository !== undefined && row.repository !== source.repository) continue;
    const task = typeof row.task_id === "string" && TASK.test(row.task_id) ? row.task_id : undefined;
    const id = createHash("sha256").update(JSON.stringify([source.repository, row])).digest("hex");
    if (events.length >= 100_000) throw new Error("Daily activity exceeds the bounded collection population; retained history is unchanged.");
    events.push({ id: `activity:${source.repository}:${id}`, repository: source.repository, kind: "activity", sourceId: `${source.repository}:ledger:${source.name}`,
      occurredAt, observedAt: fixedClock(now).iso(), fleetAttribution: "confirmed", taskIds: task ? [task] : [], title: task ? `${label} · ${task}` : label, url: null });
  }
  return { events, gaps, available: gaps === 0 || rowsRead > 0 };
}

/** Reconcile cached sources only. The existing PR collector remains the sole GitHub fetcher. */
export async function collectDailyProgress(config: DailyProgressCollectionConfig, clock: Clock = systemClock, signal?: AbortSignal):
  Promise<ReturnType<typeof prepareDailyProgressPublication> | undefined> {
  const now = clock.now(), at = fixedClock(now).iso(), timeZone = config.timeZone ?? DEFAULT_DAILY_PROGRESS_ZONE;
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
    const instances = config.instances.filter(s => s.repository.toLowerCase() === repository).map(s => ({ ...s, repository }));
    const raw = instances.map(instance => {
      const [owner, repo] = repository.split("/") as [string, string];
      const saved = board(instance.root, owner, repo), rows = [...saved.closed?.values() ?? []];
      const receipt = readBoardClosedCollectionReceipt(instance.root, owner, repo, rows);
      return { instance, saved, rows, receipt, open: readOpenBoardSnapshot(instance.root, owner, repo) };
    });
    const activities = await Promise.all(instances.map(async instance => ({ instance, ...await activity(instance, earliest, now, signal) })));
    signal?.throwIfAborted();
    let closedThrough = previousJob?.closedThrough ?? shiftDailyDate(yesterday, -1), requiredFailed = false;
    for (const reportDate of ordered) {
      const window = dailyWindow(reportDate, timeZone), end = Date.parse(window.windowEnd), start = Date.parse(window.windowStart), cutoff = Math.min(now, end);
      const day = manifest.days[dailyProgressDayKey(repository, timeZone, reportDate)];
      const old = day ? readDailyProgressRevision(config.stateDir, day) : undefined;
      const sources: SourceCoverage[] = [], events = new Map<string, DailyProgressEvent>();
      let invalid = 0, chosen: SourceCoverage | undefined;
      for (const source of raw) {
        const receipt = source.receipt.ok ? source.receipt.receipt : undefined;
        const success = receipt?.lastSuccessAt ?? source.saved.closedObservedAt ?? null;
        const sane = success !== null && Date.parse(success) <= now;
        const attempted = receipt?.lastAttemptAt ?? (sane ? success : null);
        const validClock = attempted === null || Date.parse(attempted) <= now;
        const covers = sane && Date.parse(success) >= cutoff;
        const full = source.receipt.ok && receipt?.state === "complete" && validClock && covers;
        const state: SourceCoverage["state"] = full ? "complete" : receipt?.state === "unavailable" ? "unavailable" : source.saved.closed !== undefined ? "partial" : "not_collected";
        const coverage: SourceCoverage = { id: `${repository}:prs:${source.instance.name}`, repository, kind: "pull_requests", required: false, state,
          lastAttemptAt: validClock ? attempted : null, lastSuccessAt: sane && validClock ? success : null,
          coverageStart: sane && validClock && Date.parse(success) >= start ? window.windowStart : null,
          coverageThrough: sane && validClock && Date.parse(success) >= start ? fixedClock(Math.min(Date.parse(success), end)).iso() : null,
          nextDueAt: fixedClock(nextDailyDue(now, timeZone)).iso(), reason: full ? null : !validClock ? "The source receipt is newer than this report's cutoff." : receipt?.reason === "fetch_failed" ? "The latest PR collection failed; saved evidence is retained." : "The saved PR source does not certify complete coverage through this report's cutoff." };
        sources.push(coverage);
        if (!chosen || coverage.state === "complete" && chosen.state !== "complete" || coverage.state === chosen.state && (coverage.lastSuccessAt ?? "") > (chosen.lastSuccessAt ?? "")) chosen = coverage;
        for (const pr of source.rows) {
          if (!prIdentity(pr, repository)) { invalid++; continue; }
          if (pr.state !== "MERGED") continue;
          const occurredAt = stamp(pr.mergedAt);
          if (!occurredAt || Date.parse(occurredAt) > now) { invalid++; continue; }
          if (Date.parse(occurredAt) < start || Date.parse(occurredAt) >= end) continue;
          const ids = taskIds(pr), eventId = `merged:${repository}:${pr.number}`;
          events.set(eventId, { id: eventId, repository, kind: "merged", sourceId: coverage.id, occurredAt, observedAt: at,
            fleetAttribution: ids.length || taskIdFromRunBranch(pr.headRefName) ? "confirmed" : "unknown", taskIds: ids, title: pr.title.trim().slice(0, 2048) || "Merged change", url: pr.url });
        }
      }
      if (!chosen) { chosen = { id: `${repository}:prs:missing`, repository, kind: "pull_requests", required: true, state: "not_collected", lastAttemptAt: null, lastSuccessAt: null,
        coverageStart: null, coverageThrough: null, nextDueAt: fixedClock(nextDailyDue(now, timeZone)).iso(), reason: "No configured PR source is available for this repository." }; sources.push(chosen); }
      chosen.required = true;
      if (invalid && chosen.state === "complete") { chosen.state = "partial"; chosen.reason = "Some saved PR identities or clocks are invalid; complete totals are unavailable."; }
      for (const observed of activities) {
        sources.push({ id: `${repository}:ledger:${observed.instance.name}`, repository, kind: "ledger_activity", required: false, state: observed.available ? "partial" : "unavailable", lastAttemptAt: at, lastSuccessAt: observed.available ? at : null,
          coverageStart: observed.available ? window.windowStart : null, coverageThrough: observed.available ? fixedClock(cutoff).iso() : null, nextDueAt: fixedClock(nextDailyDue(now, timeZone)).iso(),
          reason: `Retained ledger observations do not establish complete activity history.${observed.gaps ? ` ${observed.gaps} source or parse gaps were observed.` : ""}` });
        for (const event of observed.events) if (Date.parse(event.occurredAt) >= start && Date.parse(event.occurredAt) < end) events.set(event.id, event);
      }
      if (!activities.length) sources.push({ id: `${repository}:ledger:missing`, repository, kind: "ledger_activity", required: false, state: "not_collected", lastAttemptAt: null, lastSuccessAt: null,
        coverageStart: null, coverageThrough: null, nextDueAt: null, reason: "No activity source is configured for this repository." });
      sources.push({ id: `${repository}:deployments`, repository, kind: "deployments", required: false, state: "not_collected", lastAttemptAt: null, lastSuccessAt: null,
        coverageStart: null, coverageThrough: null, nextDueAt: null, reason: "Deployment evidence is not collected. A merge does not establish deployment." });
      const retained = new Map(old?.events.map(e => [e.id, e]) ?? []); for (const event of events.values()) retained.set(event.id, event);
      const confirmed = [...retained.values()].filter(e => e.kind === "merged" && e.fleetAttribution === "confirmed");
      const unknown = [...retained.values()].some(e => e.kind === "merged" && e.fleetAttribution === "unknown");
      const complete = chosen.state === "complete", precision = complete && !unknown ? "exact" : confirmed.length ? "at_least" : "unavailable";
      const present = raw.flatMap(s => s.open.ok && Date.parse(s.open.snapshot.savedAt) <= now && s.open.snapshot.rows.every(pr => prIdentity(pr, repository, ["OPEN"])) ? [s.open.snapshot] : []).sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
      if (reportDate === today && present) sources.push({ id: `${repository}:open`, repository, kind: "pull_requests", required: false, state: "partial",
        lastAttemptAt: present.savedAt, lastSuccessAt: present.savedAt, coverageStart: present.savedAt, coverageThrough: present.savedAt, nextDueAt: null,
        reason: `Present open work is a snapshot, not daily activity. Showing ${Math.min(present.rows.length, 200)} of ${present.rows.length} open pull requests.` });
      for (const previous of old?.report.coverage.sources ?? []) if (!sources.some(s => s.id === previous.id)) sources.push({ ...previous, required: false, state: "unavailable", reason: "This historical source is no longer configured; retained evidence remains available." });
      const currentWork: DailyProgressReport["currentWork"] = reportDate === today && present ? { asOf: present.savedAt,
        items: present.rows.slice(0, 200).map(pr => ({ repository, id: `pr:${repository}:${pr.number}`, title: pr.title.slice(0, 2048) || "Open pull request", url: pr.url })) } : null;
      const included = raw.some(s => s.saved.closed !== undefined) || activities.some(s => s.available) || old;
      records.push({ version: "daily-progress-v1", scope: { kind: "repository", repository }, ...window, generatedAt: at,
        phase: end <= now ? complete ? "complete" : "finalizing" : "provisional", coverage: { state: included ? "partial" : "not_collected", expectedRepositories: [repository],
          includedRepositories: included ? [repository] : [], sources },
        totals: { mergedChanges: { value: precision === "unavailable" ? null : confirmed.length, precision }, completedTasks: { value: precision === "unavailable" ? null : 0, precision } },
        events: [...events.values()], currentWork });
      if (end <= now && complete && reportDate > closedThrough) closedThrough = reportDate;
      if (!complete) requiredFailed = true;
    }
    const catchingUp = closing < today && closedThrough >= shiftDailyDate(closing, -1);
    jobs.push({ id, lastAttemptAt: at, lastSuccessAt: requiredFailed ? previousJob?.lastSuccessAt ?? null : at,
      nextDueAt: catchingUp ? at : fixedClock(nextDailyDue(now, timeZone)).iso(), closedThrough,
      error: requiredFailed ? "Some required PR sources do not yet cover the requested report cutoffs." : null });
  }
  signal?.throwIfAborted();
  return records.length || jobs.length ? prepareDailyProgressPublication(config.stateDir, records, jobs) : undefined;
}
