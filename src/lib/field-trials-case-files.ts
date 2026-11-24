/**
 * W1-T14602: which tasks the nightly Field Trials case-file snapshot covers, and the GitHub reads it needs.
 *
 * Every plan task with a worker call in the ledger read gets a case file when it has a credited PR: no count,
 * window or size bound picks which called task is measured. GitHub work stays small by carrying state from the
 * last build: a task's credited PR number and the read of a PR GitHub reports MERGED or CLOSED, which no later
 * read can change. A task with no PR link is searched on every build; an empty search is never remembered.
 */
import type { FlowRow } from "./field-trials-flow.js";
import { readLastGoodOpsCatalogSnapshot, readOpsCatalogSnapshotAsync } from "./ops-catalog-source.js";
import { planDestinationRepository } from "./plan-destination.js";
import type { Plan, Task } from "./plan.js";
import type { GhReadCadenceDeps } from "./github-transport.js";
import type { CaseFileCommandInput } from "./report-commands.js";
import type { TaskCaseFile } from "./task-case-file.js";

export const FIELD_TRIALS_CASE_FILE_CARRY_VERSION = "field-trials-case-carry-v1" as const;

/** One raw `gh pr view` answer for a finished PR, kept with the time it was read. */
export interface CarriedPrRead { readAt: string; raw: Record<string, unknown> }

/** What one build hands the next. Absent or invalid state starts from nothing, never from a guess. */
export interface FieldTrialsCaseFileCarry {
  version: typeof FIELD_TRIALS_CASE_FILE_CARRY_VERSION;
  /** Task id -> its credited PR number, from a ledger row or a search. */
  links: Record<string, number>;
  /** PR number -> its read, kept only once GitHub reported it MERGED or CLOSED. */
  finishedPrs: Record<string, CarriedPrRead>;
}

export interface SearchHit { number?: unknown; body?: unknown; headRefName?: unknown }

/** What the ledger and the plan say: the build's data, with no GitHub read in it. */
export interface FieldTrialsCaseFileSource {
  rows: readonly FlowRow[];
  /** Every task id in the plan; a called task outside it is counted, never given a case file. */
  planIds: ReadonlySet<string>;
  carry: FieldTrialsCaseFileCarry | undefined;
  /** W1-T14717: how the ops catalog was read for `planIds` (see {@link readCaseFileCatalog}); the summary names it. */
  opsCatalog?: string;
}

/** W1-T14717: one read of the ops catalog: off (no destination), the live snapshot, the last good snapshot after a
 * refusal, or no plan at all with the reason. */
export type CaseFileOpsRead =
  | { outcome: "off" }
  | { outcome: "ok"; plan: Plan }
  | { outcome: "last-good"; plan: Plan; refusal: string }
  | { outcome: "unreadable"; reason: string };

/** The reads {@link readCaseFileOpsCatalog} makes; each defaults to the one the daemon tick uses. */
/** W1-T14717: the snapshot script's ops catalog read. The destination names the catalog; a refused live read falls
 * back to the daemon's last good snapshot (W1-T14564), and the refusal is kept either way. */
export async function readCaseFileOpsCatalog(stateDir: string, destination = planDestinationRepository,
  snapshot = readOpsCatalogSnapshotAsync, lastGood = readLastGoodOpsCatalogSnapshot): Promise<CaseFileOpsRead> {
  const named = destination(stateDir);
  if (named.outcome === "off") return { outcome: "off" };
  if (named.outcome === "unreadable") return { outcome: "unreadable", reason: "destination-unreadable" };
  const target = { repository: `${named.owner}/${named.repo}` };
  const live = await snapshot(target, undefined, { stateDir });
  if (live.outcome === "ok" && live.plan) return { outcome: "ok", plan: live.plan };
  const kept = await lastGood(target, undefined, { stateDir });
  if (kept.outcome === "ok" && kept.plan) return { outcome: "last-good", plan: kept.plan, refusal: live.outcome };
  return { outcome: "unreadable", reason: `ops-${live.outcome}` };
}

export interface CaseFileCatalog {
  /** Every task id the public plan or the ops catalog holds. */
  planIds: ReadonlySet<string>;
  /** The task a case file is built for: the public record, else the ops record. */
  readTask: (taskId: string) => Task | undefined;
  /** "off", "ok", "last-good-<refusal>" or "unreadable-<reason>". */
  opsCatalog: string;
}

/** W1-T14717 INVARIANT every-called-task-is-a-candidate: since W1-T14343 new core tasks are filed in the ops catalog,
 * so the snapshot selects from the public plan and the ops catalog together. An unreadable catalog never stops the
 * build: the public plan still answers, and the refusal is named, never read as an empty catalog. */
export async function readCaseFileCatalog(publicPlan: Plan, readOps: () => Promise<CaseFileOpsRead>): Promise<CaseFileCatalog> {
  let read: CaseFileOpsRead;
  try { read = await readOps(); }
  catch (error) { read = { outcome: "unreadable", reason: `ops-read-failed:${error instanceof Error ? error.name : "unknown"}` }; }
  const tasks = new Map(publicPlan.byId);
  if (read.outcome === "ok" || read.outcome === "last-good") {
    for (const task of read.plan.tasks) if (!tasks.has(task.id)) tasks.set(task.id, task);
  }
  const opsCatalog = read.outcome === "last-good" ? `last-good-${read.refusal}`
    : read.outcome === "unreadable" ? `unreadable-${read.reason}` : read.outcome;
  return { planIds: new Set(tasks.keys()), readTask: (taskId) => tasks.get(taskId), opsCatalog };
}

/** `gh pr list --search <taskId>`; throws on a failed read. */
export type SearchPrs = (taskId: string) => Promise<SearchHit[]>;
/** `gh pr view <n>`; throws on a failed read. */
export type ViewPr = (number: number) => Promise<Record<string, unknown>>;
/** The clock and the wait, taken from the seams that already carry them (no new deps shape). */
export type CaseFilePacing = Required<Pick<CaseFileCommandInput, "nowIso">> & Required<Pick<GhReadCadenceDeps, "sleep">>;

/** PRIMARY CONTROL: the wait before the first retry of a read GitHub refused for its rate limit; doubled per
 *  retry, to 15 minutes. It paces retries only: every refused read is retried until it is answered. */
export const RATE_LIMIT_FIRST_WAIT_MS = 60_000;

export interface FieldTrialsCaseFilePlan {
  /** Every called plan task with a credited PR, newest call first. */
  selected: string[];
  /** Task id -> the PR number its case file reads. */
  prNumbers: Map<string, number>;
  /** PR number -> the raw read and its time; a failed read is absent. */
  prReads: Map<number, CarriedPrRead>;
  /** The oldest worker call among the selected tasks, so the case-file ledger read reaches back to it. */
  oldestCallTs: string | null;
  carry: FieldTrialsCaseFileCarry;
  summary: Record<string, number | string>;
  /** Every GitHub read that failed for a reason other than a rate limit, with GitHub's own message. */
  readFailures: CaseFileReadFailure[];
}

/** A failed search or PR read: the task is left without a read, never given a guessed one. */
export interface CaseFileReadFailure { read: "search" | "view"; target: string; error: string }

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function emptyCarry(): FieldTrialsCaseFileCarry {
  return { version: FIELD_TRIALS_CASE_FILE_CARRY_VERSION, links: {}, finishedPrs: {} };
}

/** A carry file's parsed JSON, or an empty carry when it is not one this version wrote. */
export function parseCarry(value: unknown): FieldTrialsCaseFileCarry {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const map = (field: unknown) => field && typeof field === "object" && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
  const links = map(record?.links); const finishedPrs = map(record?.finishedPrs);
  if (record?.version !== FIELD_TRIALS_CASE_FILE_CARRY_VERSION || !links || !finishedPrs) return emptyCarry();
  const carry = emptyCarry();
  for (const [taskId, number] of Object.entries(links)) if (Number.isSafeInteger(number) && (number as number) > 0) carry.links[taskId] = number as number;
  for (const [number, read] of Object.entries(finishedPrs)) {
    const entry = map(read);
    if (typeof entry?.readAt === "string" && map(entry.raw) && finished(entry.raw as Record<string, unknown>)) {
      carry.finishedPrs[number] = { readAt: entry.readAt, raw: entry.raw as Record<string, unknown> };
    }
  }
  return carry;
}

const finished = (raw: Record<string, unknown>) => raw.state === "MERGED" || raw.state === "CLOSED";

/** The PR body's trailer or a `run-<task>-<epoch>` head names the task. */
export function creditsTask(pr: SearchHit, taskId: string): boolean {
  return String(pr.body ?? "").split(/\r?\n/).includes(`Remudero-Task: ${taskId}`)
    || new RegExp(`^run-${taskId}-\\d+$`).test(String(pr.headRefName ?? ""));
}

/** A read GitHub refused for its primary or secondary rate limit, as `gh` reports it. */
export function isRateLimited(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { stderr?: unknown }).stderr ?? "")}` : String(error);
  return /rate limit|abuse detection|HTTP 429/i.test(text);
}

async function paced<T>(pacing: CaseFilePacing, firstWaitMs: number, read: () => Promise<T>,
  counts: { rateLimitWaits: number }): Promise<T> {
  let wait = firstWaitMs;
  for (;;) {
    try { return await read(); }
    catch (error) {
      if (!isRateLimited(error)) throw error;
      counts.rateLimitWaits += 1;
      await pacing.sleep(wait);
      wait = Math.min(wait * 2, 15 * 60_000);
    }
  }
}

/** Pick every called task, link it to its PR, and read each PR that can still change. */
export async function planFieldTrialsCaseFiles(source: FieldTrialsCaseFileSource, searchPrs: SearchPrs, viewPr: ViewPr,
  pacing: CaseFilePacing, firstWaitMs: number = RATE_LIMIT_FIRST_WAIT_MS): Promise<FieldTrialsCaseFilePlan> {
  const prior = source.carry ?? emptyCarry();
  const carry = emptyCarry();
  const lastCall = new Map<string, string>();
  let outsidePlan = 0;
  const outside = new Set<string>();
  for (const row of source.rows) {
    if (row.step !== "worker.assignment" || !row.taskId || !/^W\d+-T\d+$/.test(row.taskId) || !row.ts) continue;
    if (!source.planIds.has(row.taskId)) { if (!outside.has(row.taskId)) { outside.add(row.taskId); outsidePlan += 1; } continue; }
    const seenTs = lastCall.get(row.taskId);
    if (seenTs === undefined || row.ts > seenTs) lastCall.set(row.taskId, row.ts);
  }
  const candidates = [...lastCall.keys()].sort((a, b) => lastCall.get(b)!.localeCompare(lastCall.get(a)!) || a.localeCompare(b));
  const ledgerPr = new Map<string, { number: number; ts: string }>();
  for (const row of source.rows) {
    if (row.step !== "pr.opened" || !row.taskId || row.prRepo !== "craigoley/remudero" || !row.prNumber) continue;
    const seen = ledgerPr.get(row.taskId);
    if (!seen || (row.ts ?? "") > seen.ts) ledgerPr.set(row.taskId, { number: row.prNumber, ts: row.ts ?? "" });
  }
  const counts = { candidates: candidates.length, outsidePlan, linkedByLedger: 0, linkedByCarry: 0, searches: 0,
    searchMatched: 0, searchAmbiguous: 0, searchUnreadable: 0, prReads: 0,
    prReadsCarried: 0, prReadsFailed: 0, rateLimitWaits: 0 };
  const prNumbers = new Map<string, number>();
  const readFailures: CaseFileReadFailure[] = [];
  for (const taskId of candidates) {
    const fromLedger = ledgerPr.get(taskId)?.number;
    if (fromLedger !== undefined) { prNumbers.set(taskId, fromLedger); counts.linkedByLedger += 1; continue; }
    const fromCarry = prior.links[taskId];
    if (fromCarry !== undefined) { prNumbers.set(taskId, fromCarry); counts.linkedByCarry += 1; continue; }
    // Every unlinked task is searched on every build: a PR can open after an earlier empty search with no
    // `pr.opened` row, so an empty search is never remembered. The rate-limit backoff paces the cost.
    counts.searches += 1;
    try {
      const credited = (await paced(pacing, firstWaitMs, () => searchPrs(taskId), counts)).filter((pr) => creditsTask(pr, taskId));
      if (credited.length > 1) { counts.searchAmbiguous += 1; continue; }
      if (credited.length === 1 && Number.isSafeInteger(credited[0]!.number)) {
        prNumbers.set(taskId, credited[0]!.number as number);
        counts.searchMatched += 1;
      }
    } catch (error) {
      counts.searchUnreadable += 1;
      readFailures.push({ read: "search", target: taskId, error: errorText(error) });
    }
  }
  for (const [taskId, number] of prNumbers) carry.links[taskId] = number;
  const prReads = new Map<number, CarriedPrRead>();
  for (const number of new Set(prNumbers.values())) {
    const kept = prior.finishedPrs[String(number)];
    if (kept && Number(kept.raw.number) === number) {
      prReads.set(number, kept); carry.finishedPrs[String(number)] = kept; counts.prReadsCarried += 1; continue;
    }
    counts.prReads += 1;
    try {
      const readAt = pacing.nowIso();
      const raw = await paced(pacing, firstWaitMs, () => viewPr(number), counts);
      const read = { readAt, raw };
      prReads.set(number, read);
      if (finished(raw)) carry.finishedPrs[String(number)] = read;
    } catch (error) {
      counts.prReadsFailed += 1;
      readFailures.push({ read: "view", target: String(number), error: errorText(error) });
    }
  }
  const selected = candidates.filter((taskId) => prNumbers.has(taskId));
  let oldestCallTs: string | null = null;
  for (const row of source.rows) {
    if (row.step !== "worker.assignment" || !row.taskId || !row.ts || !prNumbers.has(row.taskId)) continue;
    if (oldestCallTs === null || row.ts < oldestCallTs) oldestCallTs = row.ts;
  }
  return { selected, prNumbers, prReads, oldestCallTs, carry, readFailures,
    summary: { ...counts, selected: selected.length, withoutPr: candidates.length - selected.length,
      ...(source.opsCatalog === undefined ? {} : { opsCatalog: source.opsCatalog }) } };
}

/** Days the case-file ledger read must reach back from `asOf` to include the oldest selected call. */
export function caseLedgerWindowDays(asOf: string, oldestCallTs: string | null): number {
  if (oldestCallTs === null) return 1;
  return Math.max(1, Math.ceil((Date.parse(asOf) - Date.parse(oldestCallTs)) / 86_400_000) + 1);
}

/** The whole nightly build: plan the reads, then build every case file in ONE call, so they share one asOf. */
export async function buildFieldTrialsCaseFiles(source: FieldTrialsCaseFileSource, searchPrs: SearchPrs, viewPr: ViewPr,
  pacing: CaseFilePacing, buildCaseFiles: (plan: FieldTrialsCaseFilePlan) => Promise<TaskCaseFile[]>,
  firstWaitMs: number = RATE_LIMIT_FIRST_WAIT_MS,
): Promise<{ files: TaskCaseFile[]; carry: FieldTrialsCaseFileCarry; summary: Record<string, number | string>;
  readFailures: CaseFileReadFailure[] }> {
  const plan = await planFieldTrialsCaseFiles(source, searchPrs, viewPr, pacing, firstWaitMs);
  const files = plan.selected.length > 0 ? await buildCaseFiles(plan) : [];
  return { files, carry: plan.carry, summary: plan.summary, readFailures: plan.readFailures };
}
