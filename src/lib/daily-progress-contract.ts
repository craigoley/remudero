import type { ContractResult } from "./code-health-contract.js";
import { codeHealthSourceRequirements } from "./code-health-contract.js";
import type { ManagedRepo } from "./managed-repos.js";
import { fixedClock } from "./clock.js";

export const DAILY_PROGRESS_VERSION = "daily-progress-v1" as const;
export type EvidenceState = "complete" | "partial" | "stale" | "not_collected" | "unavailable" | "unauthorized";
export interface SourceCoverage {
  id: string; repository: string; kind: "pull_requests" | "ledger_activity" | "deployments";
  required: boolean; state: EvidenceState; lastAttemptAt: string | null; lastSuccessAt: string | null;
  coverageStart: string | null; coverageThrough: string | null; nextDueAt: string | null;
  reason: string | null;
}
export interface MeasuredCount { value: number | null; precision: "exact" | "at_least" | "unavailable" }
export interface DailyProgressEvent {
  id: string; repository: string; kind: "merged" | "activity" | "deployment";
  sourceId: string; occurredAt: string; observedAt: string;
  fleetAttribution: "confirmed" | "unknown" | "non_fleet";
  taskIds: string[]; title: string; url: string | null;
}
export interface DailyProgressReport {
  version: typeof DAILY_PROGRESS_VERSION;
  scope: { kind: "repository"; repository: string } | { kind: "all" };
  reportDate: string; timeZone: string; windowStart: string; windowEnd: string;
  revision: number; correctionReason: string | null; generatedAt: string;
  phase: "provisional" | "finalizing" | "complete" | "corrected";
  coverage: { state: EvidenceState; expectedRepositories: string[]; includedRepositories: string[]; sources: SourceCoverage[] };
  totals: { mergedChanges: MeasuredCount; completedTasks: MeasuredCount };
  events: DailyProgressEvent[];
  page: { totalEvents: number; nextCursor: string | null };
  currentWork: null | { asOf: string; items: Array<{ repository: string; id: string; title: string; url: string | null }> };
}
export interface RepositoryEvidenceInventory {
  version: "repository-evidence-inventory-v1";
  repositories: Array<{ repository: string; instanceIds: string[]; expectedDailySources: string[]; expectedQualitySources: string[] }>;
  unresolvedInstances: string[];
  measurementState: "not_collected";
}

/** Expected sources are configuration, not evidence that a collector has run. */
export function buildRepositoryEvidenceInventory(instances: ReadonlyArray<{ instanceId: string; options: { instanceRepository?: ManagedRepo } }>): RepositoryEvidenceInventory {
  const repos = new Map<string, Set<string>>(), unresolved = new Set<string>();
  for (const instance of instances) {
    if (!text(instance.instanceId, 128)) throw new TypeError("invalid configured instance identity");
    const r = instance.options.instanceRepository;
    const id = r && typeof r.owner === "string" && typeof r.repo === "string" ? `${r.owner}/${r.repo}`.toLowerCase() : undefined;
    if (!repository(id)) { unresolved.add(instance.instanceId); continue; }
    const members = repos.get(id) ?? new Set<string>(); members.add(instance.instanceId); repos.set(id, members);
  }
  return {
    version: "repository-evidence-inventory-v1", measurementState: "not_collected",
    repositories: [...repos].sort(([a], [b]) => a.localeCompare(b)).map(([repository, members]) => ({
      repository, instanceIds: [...members].sort(), expectedDailySources: ["pull_requests", "ledger_activity", "deployments"], expectedQualitySources: [...codeHealthSourceRequirements()],
    })),
    unresolvedInstances: [...unresolved].sort(),
  };
}

type Fields = Record<string, unknown>;
const text = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0");
const record = (v: unknown): v is Fields => v !== null && typeof v === "object" && !Array.isArray(v);
const only = (v: Fields, keys: string): boolean => Object.keys(v).every((k) => keys.split(" ").includes(k));
function instant(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) || !Number.isFinite(Date.parse(v))) return false;
  const canonical = fixedClock(Date.parse(v)).iso();
  return v === canonical || v === canonical.replace(".000Z", "Z");
}
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const repository = (v: unknown): v is string => text(v, 140) && /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(v) && ![".", ".."].includes(v.split("/")[1]!);
const repoKey = (v: string): string => v.toLowerCase();
const repoList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 256 && v.every(repository) && new Set(v.map(repoKey)).size === v.length;
const states: readonly string[] = ["complete", "partial", "stale", "not_collected", "unavailable", "unauthorized"];

/** Validate exact local midnight bounds, including real 23- and 25-hour days. */
function calendarWindow(report: DailyProgressReport): ContractResult<true> {
  if (!/^\d{4}-\d\d-\d\d$/.test(report.reportDate) || !instant(`${report.reportDate}T00:00:00.000Z`) || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(report.timeZone)) return { ok: false, reason: "invalid calendar date or zone" };
  const next = fixedClock(Date.parse(`${report.reportDate}T00:00:00.000Z`)).date(); next.setUTCDate(next.getUTCDate() + 1);
  const nextDate = next.toISOString().slice(0, 10);
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: report.timeZone, calendar: "iso8601", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const localMidnight = (stamp: string, date: string) => {
      const p = Object.fromEntries(formatter.formatToParts(fixedClock(Date.parse(stamp)).date()).map((part) => [part.type, part.value]));
      return `${p.year}-${p.month}-${p.day}` === date && p.hour === "00" && p.minute === "00" && p.second === "00" && Date.parse(stamp) % 1000 === 0;
    };
    return localMidnight(report.windowStart, report.reportDate) && localMidnight(report.windowEnd, nextDate)
      ? { ok: true, value: true } : { ok: false, reason: "report bounds are not the named local calendar day" };
  } catch (error) {
    return { ok: false, reason: error instanceof RangeError ? "unsupported reporting time zone" : "calendar conversion unavailable" };
  }
}

function sourceShape(v: unknown, report: DailyProgressReport): v is SourceCoverage {
  if (!record(v) || !only(v, "id repository kind required state lastAttemptAt lastSuccessAt coverageStart coverageThrough nextDueAt reason")) return false;
  if (!text(v.id) || !repository(v.repository) || !["pull_requests", "ledger_activity", "deployments"].includes(String(v.kind)) || typeof v.required !== "boolean" || !states.includes(String(v.state))) return false;
  if (![v.lastAttemptAt, v.lastSuccessAt, v.coverageStart, v.coverageThrough, v.nextDueAt].every((x) => x === null || instant(x)) || !(v.reason === null || text(v.reason, 2048))) return false;
  if (v.state !== "complete" && !text(v.reason, 2048)) return false;
  const t = (x: unknown) => typeof x === "string" ? Date.parse(x) : undefined;
  const attempt = t(v.lastAttemptAt), success = t(v.lastSuccessAt), start = t(v.coverageStart), through = t(v.coverageThrough), now = Date.parse(report.generatedAt);
  if ([attempt, success, through].some((x) => x !== undefined && x > now)) return false;
  if (success !== undefined && (attempt === undefined || success > attempt)) return false;
  if ((start === undefined) !== (through === undefined) || (start !== undefined && through !== undefined && start > through)) return false;
  if (through !== undefined && (success === undefined || through > success)) return false;
  if (v.state === "complete" && (attempt === undefined || success === undefined || start === undefined || through === undefined)) return false;
  return true;
}

function count(v: unknown): v is MeasuredCount {
  return record(v) && only(v, "value precision") && ((v.precision === "unavailable" && v.value === null) || (["exact", "at_least"].includes(String(v.precision)) && natural(v.value)));
}

function link(v: unknown): v is string | null {
  if (v === null) return true;
  if (!text(v, 2048) || !URL.canParse(v)) return false;
  const u = new URL(v);
  return u.protocol === "https:" && !u.username && !u.password;
}

function eventShape(v: unknown): v is DailyProgressEvent {
  return record(v) && only(v, "id repository kind sourceId occurredAt observedAt fleetAttribution taskIds title url") &&
    text(v.id) && repository(v.repository) && ["merged", "activity", "deployment"].includes(String(v.kind)) && text(v.sourceId) &&
    instant(v.occurredAt) && instant(v.observedAt) && ["confirmed", "unknown", "non_fleet"].includes(String(v.fleetAttribution)) &&
    Array.isArray(v.taskIds) && v.taskIds.length <= 256 && v.taskIds.every((id) => text(id, 128)) && new Set(v.taskIds).size === v.taskIds.length && text(v.title, 2048) && link(v.url);
}

/** A complete page is not a complete corpus: totals, source coverage and pagination stay separate. */
export function validateDailyProgressReport(value: unknown): ContractResult<DailyProgressReport> {
  const fail = (reason: string): ContractResult<DailyProgressReport> => ({ ok: false, reason });
  if (!record(value) || !only(value, "version scope reportDate timeZone windowStart windowEnd revision correctionReason generatedAt phase coverage totals events page currentWork")) return fail("invalid report fields");
  if (value.version !== DAILY_PROGRESS_VERSION || !text(value.reportDate, 10) || !text(value.timeZone, 128) || !instant(value.windowStart) || !instant(value.windowEnd) || !instant(value.generatedAt)) return fail("invalid report identity or clock");
  const report = value as unknown as DailyProgressReport;
  if (Date.parse(report.windowStart) >= Date.parse(report.windowEnd)) return fail("report ends before it starts");
  const calendar = calendarWindow(report);
  if (!calendar.ok) return fail(calendar.reason);
  if (!natural(report.revision) || report.revision < 1 || !(report.correctionReason === null || text(report.correctionReason, 2048)) || !["provisional", "finalizing", "complete", "corrected"].includes(report.phase)) return fail("invalid report revision or phase");
  if (report.phase === "corrected" && (report.revision < 2 || !text(report.correctionReason, 2048))) return fail("corrected reports need a new revision and reason");
  const scope = report.scope, c = report.coverage;
  if (!record(scope) || !(scope.kind === "all" ? only(scope, "kind") : scope.kind === "repository" && only(scope, "kind repository") && repository(scope.repository))) return fail("invalid report scope");
  if (!record(c) || !only(c, "state expectedRepositories includedRepositories sources") || !states.includes(c.state) || !repoList(c.expectedRepositories) || !repoList(c.includedRepositories)) return fail("invalid source coverage inventory");
  const expected = new Set(c.expectedRepositories.map(repoKey)), included = new Set(c.includedRepositories.map(repoKey));
  if ([...included].some((r) => !expected.has(r)) || (scope.kind === "repository" && (expected.size !== 1 || !expected.has(repoKey(scope.repository))))) return fail("report repositories contradict its scope");
  if (!Array.isArray(c.sources) || c.sources.length > 1024 || !c.sources.every((s) => sourceShape(s, report)) || new Set(c.sources.map((s) => s.id)).size !== c.sources.length) return fail("invalid or duplicate source evidence");
  if (c.sources.some((s) => !expected.has(repoKey(s.repository)))) return fail("source belongs to a foreign repository");
  for (const r of included) {
    if (!["pull_requests", "ledger_activity", "deployments"].every((kind) => c.sources.some((s) => repoKey(s.repository) === r && s.kind === kind))) return fail("included repository omits an expected source kind");
  }
  const fullScope = expected.size > 0 && expected.size === included.size;
  if (c.state === "complete" && (!fullScope || !c.sources.length || c.sources.some((s) => s.state !== "complete"))) return fail("complete coverage omits expected repositories or sources");
  const ended = report.phase === "complete" || report.phase === "corrected";
  if (ended && Date.parse(report.generatedAt) < Date.parse(report.windowEnd)) return fail("a finished day cannot precede its ending instant");
  const through = Math.min(Date.parse(report.generatedAt), Date.parse(report.windowEnd));
  const coversWindow = (s: SourceCoverage) => s.state === "complete" && s.coverageStart !== null && s.coverageThrough !== null && Date.parse(s.coverageStart) <= Date.parse(report.windowStart) && Date.parse(s.coverageThrough) >= through;
  const exactMerges = fullScope && [...included].every((r) => c.sources.some((s) => repoKey(s.repository) === r && s.kind === "pull_requests" && s.required && coversWindow(s)));
  if (ended && c.sources.some((s) => s.required && !coversWindow(s))) return fail("finished report lacks its required source window");
  if (!record(report.totals) || !only(report.totals, "mergedChanges completedTasks") || !Object.values(report.totals).every(count) || !count(report.totals.mergedChanges) || !count(report.totals.completedTasks)) return fail("invalid measured totals");
  if (Object.values(report.totals).some((v) => v.precision === "exact") && !exactMerges) return fail("exact totals require complete expected merge evidence");
  if (!Array.isArray(report.events) || report.events.length > 200 || !report.events.every(eventShape) || new Set(report.events.map((e) => e.id)).size !== report.events.length) return fail("invalid or duplicate evidence page");
  const sources = new Map(c.sources.map((s) => [s.id, s]));
  for (const e of report.events) {
    const s = sources.get(e.sourceId), kind = { merged: "pull_requests", activity: "ledger_activity", deployment: "deployments" }[e.kind];
    if (!included.has(repoKey(e.repository)) || !s || repoKey(s.repository) !== repoKey(e.repository) || s.kind !== kind) return fail("event identity contradicts its source scope");
    if (Date.parse(e.occurredAt) < Date.parse(report.windowStart) || Date.parse(e.occurredAt) >= Date.parse(report.windowEnd) || Date.parse(e.observedAt) > Date.parse(report.generatedAt)) return fail("event clock is outside the report evidence window");
    if (e.kind === "deployment" && (s.state === "not_collected" || s.lastSuccessAt === null)) return fail("deployment lacks an independent source receipt");
  }
  const confirmed = report.events.filter((e) => e.kind === "merged" && e.fleetAttribution === "confirmed");
  const tasks = new Set(confirmed.flatMap((e) => e.taskIds));
  if ((report.totals.mergedChanges.value !== null && report.totals.mergedChanges.value < confirmed.length) || (report.totals.completedTasks.value !== null && report.totals.completedTasks.value < tasks.size)) return fail("totals omit confirmed evidence on this page");
  if (!record(report.page) || !only(report.page, "totalEvents nextCursor") || !natural(report.page.totalEvents) || report.page.totalEvents < report.events.length || !(report.page.nextCursor === null || text(report.page.nextCursor, 1024))) return fail("invalid evidence pagination");
  if (report.currentWork !== null) {
    const w = report.currentWork;
    if (!record(w) || !only(w, "asOf items") || !instant(w.asOf) || Date.parse(w.asOf) > Date.parse(report.generatedAt) || !Array.isArray(w.items) || w.items.length > 200 || !w.items.every((i) => record(i) && only(i, "repository id title url") && repository(i.repository) && included.has(repoKey(i.repository)) && text(i.id) && text(i.title, 2048) && link(i.url))) return fail("invalid current-work snapshot");
  }
  return { ok: true, value: report };
}
