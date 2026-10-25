import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { dailyDateAt, dailyWindow, DEFAULT_DAILY_PROGRESS_ZONE, resolveDailyDate, shiftDailyDate } from "./daily-progress-calendar.js";
import { readDailyProgressRepositories } from "./daily-progress-collector.js";
import { validateDailyProgressReport, type DailyProgressReport, type MeasuredCount, type SourceCoverage } from "./daily-progress-contract.js";
import { dailyProgressDayKey, readDailyProgressManifest, readDailyProgressRevision, type DailyProgressRevision } from "./daily-progress-store.js";
import { readModelSidecarDir, type ReadModelDb } from "./read-model-db.js";
import { judgeSource } from "./view-freshness.js";
import { viewKey, type ViewBodySource, type ViewRequestFailure, type ViewSource } from "./views.js";

export const DAILY_PROGRESS_VIEW_NAME = "daily-progress";
/** Internal memory entry carrying a real all-repository report, not an alternate public schema. */
export const DAILY_PROGRESS_SCOPE_KEY = "__daily_progress_scope";
/** BACKSTOP: a page bounds returned evidence, never the stored or counted population. */
export const DAILY_PROGRESS_PAGE_BYTES = 1024 * 1024;
/** PRIMARY CONTROL: source age follows the agreed hourly cadence; retry scheduling cannot renew it. */
const DAILY_SOURCE_FRESHNESS_MS = 3_600_000;
class DailyProgressNotReady extends RmdError {
  constructor(message: string) { super("read-model", GENERIC_EXIT_CODE, message); }
}
interface Page { r: number; o: number; k: string }
interface Request { repository: string; timeZone: string; reportDate: string; revision?: number; page?: Page }

function request(params: URLSearchParams, now: number, defaultZone: string): Request {
  for (const name of params.keys()) if (!["repository", "timeZone", "date", "revision", "page"].includes(name) || params.getAll(name).length !== 1) throw new RangeError("unknown or repeated Daily progress parameter");
  const repository = (params.get("repository") ?? "all").toLowerCase(), timeZone = params.get("timeZone") ?? defaultZone;
  if (repository !== "all" && !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(repository)) throw new RangeError("unknown repository");
  const reportDate = resolveDailyDate(params.get("date") ?? "today", now, timeZone);
  if (reportDate > dailyDateAt(now, timeZone)) throw new RangeError("future report date is unavailable");
  const rawRevision = params.get("revision");
  let revision = rawRevision === null ? undefined : /^[1-9]\d{0,14}$/.test(rawRevision) ? Number(rawRevision) : Number.NaN;
  if (revision !== undefined && !Number.isSafeInteger(revision)) throw new RangeError("invalid report revision");
  let page: Page | undefined;
  const encoded = params.get("page");
  if (encoded !== null) {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(encoded)) throw new RangeError("invalid report page");
    page = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Page;
    if (!page || Object.keys(page).some(k => !["r", "o", "k"].includes(k)) || !Number.isSafeInteger(page.r) || page.r < 1 ||
        !Number.isSafeInteger(page.o) || page.o < 0 || page.o > 1_000_000_000 || typeof page.k !== "string" || !/^[a-f0-9]{64}$/.test(page.k) ||
        revision !== undefined && revision !== page.r) throw new RangeError("invalid report page or revision");
    revision = page.r;
    params.set("revision", String(revision));
  }
  params.set("repository", repository); params.set("timeZone", timeZone); params.set("date", reportDate);
  return { repository, timeZone, reportDate, ...(revision === undefined ? {} : { revision }), ...(page ? { page } : {}) };
}

export function dailyProgressRequestKey(params: URLSearchParams, now: number, defaultZone = DEFAULT_DAILY_PROGRESS_ZONE): string {
  request(params, now, defaultZone);
  return viewKey(params);
}

function scopeKey(input: Request, repositories: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([input.repository, input.timeZone, input.reportDate, repositories])).digest("hex");
}

function missingSources(repository: string): SourceCoverage[] {
  return (["pull_requests", "ledger_activity", "deployments"] as const).map(kind => ({ id: `${repository}:missing:${kind}`, repository, instanceId: null, kind,
    required: kind === "pull_requests", state: "not_collected", lastAttemptAt: null, lastSuccessAt: null, coverageStart: null, coverageThrough: null,
    nextDueAt: null, reason: "No retained report supplies this source for the selected day and revision." }));
}

function count(values: MeasuredCount[], exact: boolean): MeasuredCount {
  const sum = values.reduce((total, value) => total + (value.value ?? 0), 0);
  return exact && values.every(v => v.precision === "exact") ? { value: sum, precision: "exact" }
    : sum > 0 ? { value: sum, precision: "at_least" } : { value: null, precision: "unavailable" };
}

/** Worker-side read: authorize scope before opening any day object or adding counts. */
export function readDailyProgressReport(opts: { stateDir: string; params: URLSearchParams; now: number; timeZone?: string }): { data: DailyProgressReport; sources: ViewSource[] } {
  const input = request(opts.params, opts.now, opts.timeZone ?? DEFAULT_DAILY_PROGRESS_ZONE);
  const inventory = readDailyProgressRepositories(opts.stateDir);
  if (input.repository !== "all" && !inventory.includes(input.repository)) throw new RangeError("unknown repository");
  const expected = input.repository === "all" ? inventory : [input.repository], identity = scopeKey(input, expected);
  if (input.page && input.page.k !== identity) throw new RangeError("report page belongs to another scope or reporting day");
  const manifest = readDailyProgressManifest(opts.stateDir), selected: DailyProgressRevision[] = [], missing: string[] = [];
  const revision = input.revision ?? (input.repository === "all" ? manifest.generation : manifest.days[dailyProgressDayKey(input.repository, input.timeZone, input.reportDate)]?.revisions.length);
  if (revision === undefined || revision < 1) throw new DailyProgressNotReady("Daily progress has not collected this reporting day.");
  if (input.repository === "all" && revision > manifest.generation) throw new RangeError("unknown report revision");
  for (const repository of expected) {
    const day = manifest.days[dailyProgressDayKey(repository, input.timeZone, input.reportDate)];
    let value: DailyProgressRevision | undefined;
    if (day) {
      if (input.repository !== "all") value = readDailyProgressRevision(opts.stateDir, day, revision);
      else for (let at = day.revisions.length; at >= 1; at--) {
        const candidate = readDailyProgressRevision(opts.stateDir, day, at);
        if (candidate.generation <= revision) { value = candidate; break; }
      }
    }
    if (value) selected.push(value); else missing.push(repository);
  }
  if (!selected.length) throw new DailyProgressNotReady("Daily progress has not retained this reporting day and revision.");
  const first = selected[0]!.report;
  const allEvents = selected.flatMap(r => r.events).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  const sourceEvidence = [...selected.flatMap(r => r.report.coverage.sources), ...missing.flatMap(missingSources)];
  const expectedSources = [...selected.flatMap(r => r.report.coverage.expectedSources), ...missing.flatMap(repository => missingSources(repository).map(({ id, repository, kind, instanceId, required }) => ({ id, repository, kind, instanceId, required })))];
  const generatedAt = selected.map(r => r.report.generatedAt).sort().at(-1)!;
  const cutoff = Math.min(Date.parse(generatedAt), Date.parse(first.windowEnd));
  const complete = !missing.length && expectedSources.filter(s => s.required).every(identity => {
    const s = sourceEvidence.find(source => source.id === identity.id);
    return s !== undefined && s.state === "complete" && s.coverageStart !== null && s.coverageThrough !== null && Date.parse(s.coverageStart) <= Date.parse(first.windowStart) && Date.parse(s.coverageThrough) >= cutoff;
  });
  const included = [...new Set(selected.flatMap(r => r.report.coverage.includedRepositories))].sort();
  const current = selected.flatMap(r => r.report.currentWork ? [r.report.currentWork] : []);
  const { events: _events, page: _page, ...base } = { ...first, events: [], page: null };
  const data: DailyProgressReport = { ...base, scope: input.repository === "all" ? { kind: "all" } : { kind: "repository", repository: input.repository },
    revision, generatedAt, correctionReason: selected.some(r => r.report.correctionReason !== null) ? "Includes revised source evidence." : null,
    phase: Date.parse(first.windowEnd) <= Date.parse(generatedAt) ? complete ? selected.some(r => r.report.phase === "corrected") ? "corrected" : "complete" : "finalizing" : "provisional",
    coverage: { state: "partial", expectedRepositories: expected, includedRepositories: included, expectedSources, sources: sourceEvidence },
    totals: { mergedChanges: count(selected.map(r => r.report.totals.mergedChanges), complete), completedTasks: count(selected.map(r => r.report.totals.completedTasks), complete) },
    currentWork: current.length ? { asOf: current.map(c => c.asOf).sort()[0]!, items: current.flatMap(c => c.items).slice(0, 200) } : null,
    events: [], page: { totalEvents: allEvents.length, nextCursor: null } };
  const offset = input.page?.o ?? 0;
  if (offset > allEvents.length || offset === allEvents.length && offset !== 0) throw new RangeError("report page is outside the retained evidence");
  if (Buffer.byteLength(JSON.stringify(data)) > DAILY_PROGRESS_PAGE_BYTES) throw new RangeError("report metadata exceeds its response bound; select a repository");
  for (const event of allEvents.slice(offset, offset + 200)) {
    if (Buffer.byteLength(JSON.stringify({ ...data, events: [...data.events, event] })) + 1024 > DAILY_PROGRESS_PAGE_BYTES) break;
    data.events.push(event);
  }
  if (offset + data.events.length < allEvents.length) {
    if (!data.events.length) throw new RangeError("one evidence item exceeds the response bound");
    data.page.nextCursor = Buffer.from(JSON.stringify({ r: revision, o: offset + data.events.length, k: identity })).toString("base64url");
  }
  const checked = validateDailyProgressReport(data);
  if (!checked.ok) throw new Error(`Daily progress cached report refused: ${checked.reason}`);
  const sources = sourceEvidence.filter(s => s.required).map((source): ViewSource => {
    return judgeSource({ name: `github:daily:${source.id}`, kind: "github", asOf: source.lastSuccessAt, budgetMs: DAILY_SOURCE_FRESHNESS_MS,
      state: source.state === "unavailable" || source.state === "not_collected" || source.lastSuccessAt === null ? "unavailable" : source.state === "stale" ? "stale" : "fresh",
      ...(source.reason ? { reason: source.reason } : {}) }, opts.now);
  });
  return { data, sources };
}

/** Request-side validation is memory-only, including checks before a held body or ETag can answer. */
export function validateDailyProgressRequest(params: URLSearchParams, source: ViewBodySource | undefined, now: number): ViewRequestFailure | undefined {
  try {
    const rawHeld = source?.body(DAILY_PROGRESS_VIEW_NAME, DAILY_PROGRESS_SCOPE_KEY)?.body.data;
    const held = validateDailyProgressReport(rawHeld).ok ? rawHeld as DailyProgressReport : undefined;
    const input = request(params, now, held?.timeZone ?? DEFAULT_DAILY_PROGRESS_ZONE);
    if (!source) return undefined; // Native off/shadow policy answers without a report.
    let roster = held;
    const currentDate = dailyDateAt(now, held?.timeZone ?? DEFAULT_DAILY_PROGRESS_ZONE);
    // A retained roster authorizes known scope across midnight. Date aliases have already resolved
    // independently, so yesterday remains readable while the new today's body is still being built.
    if (!roster) {
      const currentKey = dailyProgressRequestKey(new URLSearchParams({ repository: "all", date: "today", timeZone: held?.timeZone ?? DEFAULT_DAILY_PROGRESS_ZONE }), now);
      roster = source.body(DAILY_PROGRESS_VIEW_NAME, currentKey)?.body.data as DailyProgressReport | undefined;
      if (!roster || roster.reportDate !== currentDate) { source.want?.(DAILY_PROGRESS_VIEW_NAME, currentKey); return { error: "view_not_ready", status: 503, detail: "Daily progress is waiting for the current reporting day." }; }
    }
    if (!validateDailyProgressReport(roster).ok || roster.scope.kind !== "all") return { error: "view_not_ready", status: 503, detail: "Daily progress repository scope is unavailable." };
    const expected = roster.coverage.expectedRepositories;
    if (input.repository !== "all" && !expected.includes(input.repository)) throw new RangeError("unknown repository");
    const scoped = input.repository === "all" ? expected : [input.repository];
    if (input.page && input.page.k !== scopeKey(input, scoped)) throw new RangeError("report page belongs to another scope or reporting day");
    const key = viewKey(params), entry = source.body(DAILY_PROGRESS_VIEW_NAME, key)?.body.data as DailyProgressReport | undefined;
    if (!entry) { source.want?.(DAILY_PROGRESS_VIEW_NAME, key); return { error: "view_not_ready", status: 503, detail: "Daily progress is preparing the selected report." }; }
    if (entry && JSON.stringify(entry.coverage.expectedRepositories) !== JSON.stringify(scoped)) { source.want?.(DAILY_PROGRESS_VIEW_NAME, key); return { error: "view_not_ready", status: 503, detail: "Repository scope changed; the cached report is being rebuilt." }; }
    return undefined;
  } catch (error) {
    return error instanceof RangeError || error instanceof SyntaxError
      ? { error: "invalid_request", status: 400, detail: error instanceof RangeError ? error.message : "Invalid Daily progress page." }
      : { error: "view_not_ready", status: 503, detail: "Daily progress scope or cached report is unavailable." };
  }
}

export function createDailyProgressView(opts: { stateDir?: string; timeZone?: string; keys?: () => string[] } = {}): {
  name: string; version: number; demand: true;
  materialize(ctx: { now: number; sourceStore?: ReadModelDb; instances: ReadonlyArray<unknown> }): Array<{ key: string; data: DailyProgressReport; sources: ViewSource[] }>;
} {
  return { name: DAILY_PROGRESS_VIEW_NAME, version: 1, demand: true, materialize(ctx) {
    const stateDir = opts.stateDir ?? (ctx.sourceStore ? dirname(readModelSidecarDir(dirname(ctx.sourceStore.path))) : undefined);
    if (!stateDir) throw new DailyProgressNotReady("Daily progress durable state is unavailable.");
    const timeZone = opts.timeZone ?? DEFAULT_DAILY_PROGRESS_ZONE, today = dailyDateAt(ctx.now, timeZone);
    const currentKey = dailyProgressRequestKey(new URLSearchParams({ repository: "all", date: today, timeZone }), ctx.now);
    const yesterdayKey = dailyProgressRequestKey(new URLSearchParams({ repository: "all", date: shiftDailyDate(today, -1), timeZone }), ctx.now);
    return [...new Set([currentKey, yesterdayKey, ...opts.keys?.() ?? []])].flatMap(key => {
      try {
        const built = readDailyProgressReport({ stateDir, params: new URLSearchParams(key), now: ctx.now, timeZone });
        return [{ key, ...built }, ...(key === currentKey ? [{ key: DAILY_PROGRESS_SCOPE_KEY, ...built }] : [])];
      } catch (error) {
        if (error instanceof DailyProgressNotReady || error instanceof RangeError) return [];
        throw error;
      }
    });
  } };
}
