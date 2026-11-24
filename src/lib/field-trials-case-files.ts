/**
 * W1-T14602: which tasks the nightly Field Trials case-file snapshot covers, and the GitHub reads it needs.
 *
 * Every plan task with a worker call in the ledger read gets a case file when it has a credited PR: no count,
 * window or size bound picks which called task is measured. GitHub work stays small by carrying state from the
 * last build: a task's credited PR number and the read of a PR GitHub reports MERGED or CLOSED, which no later
 * read can change. W1-T14728: tasks link to PRs from one paginated listing of the repository's pull requests, newest
 * update first, never a search per task. The carry keeps which tasks each listed PR credits and the newest update
 * the listing has seen, so a later build lists only the PRs updated since.
 */
import type { FlowRow } from "./field-trials-flow.js";
import type { GhReadCadenceDeps } from "./github-transport.js";
import type { CaseFileCommandInput } from "./report-commands.js";
import type { TaskCaseFile } from "./task-case-file.js";

// W1-T14728: v2 adds the PR listing index; a v1 carry starts a full listing.
export const FIELD_TRIALS_CASE_FILE_CARRY_VERSION = "field-trials-case-carry-v2" as const;

/** One raw `gh pr view` answer for a finished PR, kept with the time it was read. */
export interface CarriedPrRead { readAt: string; raw: Record<string, unknown> }

/** What one build hands the next. Absent or invalid state starts from nothing, never from a guess. */
export interface FieldTrialsCaseFileCarry {
  version: typeof FIELD_TRIALS_CASE_FILE_CARRY_VERSION;
  /** Task id -> its credited PR number from a `pr.opened` ledger row, kept after the row leaves the ledger read. */
  links: Record<string, number>;
  /** PR number -> its read, kept only once GitHub reported it MERGED or CLOSED. */
  finishedPrs: Record<string, CarriedPrRead>;
  /** PR number -> the task ids it credits, for every listed PR that credits one. */
  listedPrs: Record<string, string[]>;
  /** The newest `updated_at` a complete listing has seen; absent until one completes. */
  listedThrough?: string;
}

/** One pull request as the listing gives it. */
export interface ListedPr { number?: unknown; body?: unknown; headRefName?: unknown; updatedAt?: unknown }


/** What the ledger and the plan say: the build's data, with no GitHub read in it. */
export interface FieldTrialsCaseFileSource {
  rows: readonly FlowRow[];
  /** Every task id in the plan; a called task outside it is counted, never given a case file. */
  planIds: ReadonlySet<string>;
  carry: FieldTrialsCaseFileCarry | undefined;
}

/** Page `page` (from 1) of the repository's pull requests, state all, newest update first, 100 per page; an empty
 *  page ends the listing. Throws on a failed read. */
export type ListPrsPage = (page: number) => Promise<ListedPr[]>;
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
  summary: Record<string, number>;
  /** Every GitHub read that failed for a reason other than a rate limit, with GitHub's own message. */
  readFailures: CaseFileReadFailure[];
}

/** A failed listing page or PR read: the task is left without a read, never given a guessed one. */
export interface CaseFileReadFailure { read: "list" | "view"; target: string; error: string }

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function emptyCarry(): FieldTrialsCaseFileCarry {
  return { version: FIELD_TRIALS_CASE_FILE_CARRY_VERSION, links: {}, finishedPrs: {}, listedPrs: {} };
}

/** A carry file's parsed JSON, or an empty carry when it is not one this version wrote. */
export function parseCarry(value: unknown): FieldTrialsCaseFileCarry {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const map = (field: unknown) => field && typeof field === "object" && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
  const links = map(record?.links); const finishedPrs = map(record?.finishedPrs); const listedPrs = map(record?.listedPrs);
  if (record?.version !== FIELD_TRIALS_CASE_FILE_CARRY_VERSION || !links || !finishedPrs || !listedPrs) return emptyCarry();
  const carry = emptyCarry();
  for (const [taskId, number] of Object.entries(links)) if (Number.isSafeInteger(number) && (number as number) > 0) carry.links[taskId] = number as number;
  for (const [number, read] of Object.entries(finishedPrs)) {
    const entry = map(read);
    if (typeof entry?.readAt === "string" && map(entry.raw) && finished(entry.raw as Record<string, unknown>)) {
      carry.finishedPrs[number] = { readAt: entry.readAt, raw: entry.raw as Record<string, unknown> };
    }
  }
  for (const [number, tasks] of Object.entries(listedPrs)) {
    if (Array.isArray(tasks) && tasks.every((task) => typeof task === "string")) carry.listedPrs[number] = tasks as string[];
  }
  // A watermark with no index behind it would skip PRs; it is kept only beside the index it was written with.
  if (typeof record.listedThrough === "string") carry.listedThrough = record.listedThrough;
  return carry;
}

const finished = (raw: Record<string, unknown>) => raw.state === "MERGED" || raw.state === "CLOSED";

/** The PR body's trailer or a `run-<task>-<epoch>` head names the task. */
export function creditsTask(pr: ListedPr, taskId: string): boolean {
  return String(pr.body ?? "").split(/\r?\n/).includes(`Remudero-Task: ${taskId}`)
    || new RegExp(`^run-${taskId}-\\d+$`).test(String(pr.headRefName ?? ""));
}

/** Every task id a PR credits by {@link creditsTask}'s two rules, found without knowing the task first. */
export function creditedTasks(pr: ListedPr): string[] {
  const tasks = new Set<string>();
  for (const line of String(pr.body ?? "").split(/\r?\n/)) {
    const trailer = /^Remudero-Task: (\S+)$/.exec(line);
    if (trailer) tasks.add(trailer[1]!);
  }
  const head = /^run-(.+)-\d+$/.exec(String(pr.headRefName ?? ""));
  if (head) tasks.add(head[1]!);
  return [...tasks].filter((task) => creditsTask(pr, task)).sort();
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

/** {@link ListPrsPage} over `gh api`: one REST page of `repo`'s pull requests, state all, newest update first. */
export function ghPrListingPage(gh: (args: string[]) => Promise<string>, repo: string): ListPrsPage {
  return async (page) => {
    const list: unknown = JSON.parse(await gh(["api",
      `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`]));
    if (!Array.isArray(list)) throw new Error(`PR listing page ${page} returned no list`);
    return list.map((pr: { number?: unknown; body?: unknown; head?: { ref?: unknown }; updated_at?: unknown } | null) =>
      ({ number: pr?.number, body: pr?.body, headRefName: pr?.head?.ref, updatedAt: pr?.updated_at }));
  };
}

/** The listing pass: pages newest update first until an empty page, or, after a complete listing, until a page
 *  reaches PRs older than the carried watermark. Newest-first order is what makes the watermark safe: a PR updated
 *  mid-pass moves to page 1 and only shifts later rows DOWN (read twice, never skipped), and its new update is
 *  newer than every row this pass saw, so the next pass lists it. A failed page stops the pass and keeps the old watermark, so
 *  the next build lists the gap again; the PRs already listed still update the index. */
async function listPrs(prior: FieldTrialsCaseFileCarry, listPage: ListPrsPage, pacing: CaseFilePacing, firstWaitMs: number,
  counts: { listPages: number; listedPrs: number; listFailed: number; rateLimitWaits: number },
  readFailures: CaseFileReadFailure[]): Promise<Pick<FieldTrialsCaseFileCarry, "listedPrs" | "listedThrough">> {
  const listedPrs = { ...prior.listedPrs };
  let newest: string | undefined;
  for (let page = 1; ; page += 1) {
    let rows: ListedPr[];
    try { rows = await paced(pacing, firstWaitMs, () => listPage(page), counts); }
    catch (error) {
      counts.listFailed = 1;
      readFailures.push({ read: "list", target: `page ${page}`, error: errorText(error) });
      return { listedPrs, ...(prior.listedThrough === undefined ? {} : { listedThrough: prior.listedThrough }) };
    }
    counts.listPages += 1;
    let reachedWatermark = rows.length === 0;
    for (const pr of rows) {
      const updatedAt = typeof pr.updatedAt === "string" ? pr.updatedAt : "";
      if (newest === undefined || updatedAt > newest) newest = updatedAt;
      if (prior.listedThrough !== undefined && updatedAt < prior.listedThrough) { reachedWatermark = true; continue; }
      if (!Number.isSafeInteger(pr.number)) continue;
      counts.listedPrs += 1;
      const tasks = creditedTasks(pr);
      if (tasks.length > 0) listedPrs[String(pr.number)] = tasks; else delete listedPrs[String(pr.number)];
    }
    if (reachedWatermark) {
      const through = [newest, prior.listedThrough].filter((at): at is string => !!at).sort().at(-1);
      return { listedPrs, ...(through === undefined ? {} : { listedThrough: through }) };
    }
  }
}

/** Pick every called task, link it to its PR, and read each PR that can still change. */
export async function planFieldTrialsCaseFiles(source: FieldTrialsCaseFileSource, listPage: ListPrsPage, viewPr: ViewPr,
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
  const counts = { candidates: candidates.length, outsidePlan, linkedByLedger: 0, linkedByCarry: 0, listPages: 0,
    listedPrs: 0, listFailed: 0, linkedByListing: 0, listingAmbiguous: 0, prReads: 0,
    prReadsCarried: 0, prReadsFailed: 0, rateLimitWaits: 0 };
  const prNumbers = new Map<string, number>();
  const readFailures: CaseFileReadFailure[] = [];
  const listed = await listPrs(prior, listPage, pacing, firstWaitMs, counts, readFailures);
  carry.listedPrs = listed.listedPrs;
  if (listed.listedThrough !== undefined) carry.listedThrough = listed.listedThrough;
  const creditedBy = new Map<string, number[]>();
  const fromListing = new Set<string>();
  for (const [number, tasks] of Object.entries(listed.listedPrs)) {
    for (const task of tasks) creditedBy.set(task, [...(creditedBy.get(task) ?? []), Number(number)]);
  }
  for (const taskId of candidates) {
    const fromLedger = ledgerPr.get(taskId)?.number;
    if (fromLedger !== undefined) { prNumbers.set(taskId, fromLedger); counts.linkedByLedger += 1; continue; }
    const fromCarry = prior.links[taskId];
    if (fromCarry !== undefined) { prNumbers.set(taskId, fromCarry); counts.linkedByCarry += 1; continue; }
    // The listing index answers every unlinked task with no read of its own; a task it names no PR for has none
    // among the PRs listed so far, and a PR opened later is listed by the next build's pass.
    const credited = creditedBy.get(taskId) ?? [];
    if (credited.length > 1) { counts.listingAmbiguous += 1; continue; }
    if (credited.length === 1) { prNumbers.set(taskId, credited[0]!); fromListing.add(taskId); counts.linkedByListing += 1; }
  }
  // Only a ledger link is carried: a listing link is recomputed from the index each build, so a PR edited to drop
  // its trailer loses the task instead of keeping a stale link.
  for (const [taskId, number] of prNumbers) if (!fromListing.has(taskId)) carry.links[taskId] = number;
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
  // A failed listing leaves an unlinked task unknown, never counted as having no PR.
  const unlinked = candidates.length - selected.length;
  return { selected, prNumbers, prReads, oldestCallTs, carry, readFailures,
    summary: { ...counts, selected: selected.length, withoutPr: counts.listFailed ? 0 : unlinked,
      unlinkedListingFailed: counts.listFailed ? unlinked : 0 } };
}

/** Days the case-file ledger read must reach back from `asOf` to include the oldest selected call. */
export function caseLedgerWindowDays(asOf: string, oldestCallTs: string | null): number {
  if (oldestCallTs === null) return 1;
  return Math.max(1, Math.ceil((Date.parse(asOf) - Date.parse(oldestCallTs)) / 86_400_000) + 1);
}

/** The whole nightly build: plan the reads, then build every case file in ONE call, so they share one asOf. */
export async function buildFieldTrialsCaseFiles(source: FieldTrialsCaseFileSource, listPage: ListPrsPage, viewPr: ViewPr,
  pacing: CaseFilePacing, buildCaseFiles: (plan: FieldTrialsCaseFilePlan) => Promise<TaskCaseFile[]>,
  firstWaitMs: number = RATE_LIMIT_FIRST_WAIT_MS,
): Promise<{ files: TaskCaseFile[]; carry: FieldTrialsCaseFileCarry; summary: Record<string, number>;
  readFailures: CaseFileReadFailure[] }> {
  const plan = await planFieldTrialsCaseFiles(source, listPage, viewPr, pacing, firstWaitMs);
  const files = plan.selected.length > 0 ? await buildCaseFiles(plan) : [];
  return { files, carry: plan.carry, summary: plan.summary, readFailures: plan.readFailures };
}
