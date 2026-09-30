import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { systemClock, type Clock } from "./clock.js";
import type { GardenAction, GardenCheckout, GardenerDeps, GardenSpec } from "./gardener.js";
import { gardenLedgerBucket, startGarden } from "./gardener.js";
import { writeAtomic } from "./fs-race-safe.js";
import { gateFireRatesPath, type GateFireRateReport } from "./gate-fire-rate.js";
import { ledgerLivePath, ledgerRotationEntries, readLedgerUnionRecordsSync } from "./ledger-union.js";
import { loadPlanFromYaml } from "./plan.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { lintTask } from "./task-linter.js";
import { renderMachineShard } from "./machine-filing.js";
import { slug as kebabSlug } from "./feedback-docket.js";
import type { LedgerRecord } from "./retro.js";

/**
 * lib/ci-friction-gardener.ts (W1-T4435) — the fleet prices its own slowest gate.
 *
 * INVARIANT: every cause is ranked by PR MINUTES LOST, never fire count — a frequent one-minute
 * check must never outrank a rare 25-minute one (this module's own falsifier). gate-gardener
 * (W1-T4116) already counts how often each gate fires; it never prices a fire in PR time.
 *
 * FOUR CAUSE KINDS, priced from what the fleet already measures — no new GitHub calls: `check`
 * (a red gate's own minutes, from gate-fire-rate.ts's persisted report, W1-T4115); `main_merge`
 * (a `fix.base_refreshed` round — GitHub auto-merging main in, named by the shared file it
 * blames); `conflict` (a `fix.dispatch` round whose `mode` is `"merge-conflict"`); `fix_refusal`
 * (a round whose `fix.commit_refused` fired — the harness refused that round's commit, so it
 * bought no progress; design point (iv)). Each ledger round's minutes are the wall-clock gap
 * since the run's PREVIOUS round (or its `pr.opened`) — every row already carries `ts`.
 *
 * ONE class, `draft` (a `review` class, gardener.ts): the costliest cause with no queued task
 * already tracking it (`origin: ci-friction:<cause>`) is filed as a parked, `verify: human`,
 * `author_class: machine` task, same idempotency shape as measurement-cadence.ts's CI-learning
 * rung, judged by whether its PR merges. Every pass whose pricing moved appends a row to the
 * trend log in the STATE dir ({@link ciFrictionGardenLogPath}), so the trend reads as the total
 * moving (design point (iii)) — never in the filing PR, whose shard must travel alone (Rule 15
 * refused all eight 2026-09-25 filings that carried a docs/ log beside the shard).
 */

// ── Pricing: rounds → causes, never fire count ──────────────────────────────────────────────

export type CiFrictionCauseKind = "check" | "main_merge" | "conflict" | "fix_refusal";

/** A failed history read is a failed garden pass, never a measured zero-friction corpus. */
export function readCiFrictionLedgerRecords(stateDir: string): LedgerRecord[] {
  const read = readLedgerUnionRecordsSync(stateDir, { requireArchives: true, refuseIncomplete: true });
  if (!read.ok) {
    const reason = read.archiveCount === 0
      ? "no ledger rotations"
      : read.unread.length > 0
        ? `unread ledger file(s): ${read.unread.map((path) => basename(path)).join(", ")}`
        : "incomplete ledger union";
    throw new Error(`ci-friction ledger union unreadable: ${reason}`);
  }
  return read.rows as LedgerRecord[];
}

export interface CiFrictionCause {
  kind: CiFrictionCauseKind;
  name: string;
}

/** The one key every idempotency and ranking lookup uses. */
export function ciFrictionCauseKey(c: CiFrictionCause): string {
  return `${c.kind}:${c.name}`;
}

/** One extra-head round, already attributed to a cause and priced in PR minutes. */
export interface CiFrictionRound {
  pr: number;
  cause: CiFrictionCause;
  minutes: number;
  /** When the round ended — the recency weight's clock. Absent, the round counts in full. */
  at?: string;
}

/** A round this old counts half; one twice as old a quarter. A smooth fade, never a cutoff date,
 *  so the ranking follows the fleet's CURRENT load and a fixed cause visibly falls. */
export const CI_FRICTION_HALF_LIFE_MS = 7 * 24 * 3_600_000;

/** The recency weight of a round ending at `at`, seen from `nowMs`. */
export function ciFrictionRecencyWeight(at: string | undefined, nowMs: number, halfLifeMs = CI_FRICTION_HALF_LIFE_MS): number {
  const t = at === undefined ? NaN : Date.parse(at);
  return Number.isFinite(t) ? 0.5 ** (Math.max(0, nowMs - t) / halfLifeMs) : 1;
}

export interface CiFrictionCausePrice {
  cause: CiFrictionCause;
  /** PR minutes lost to this cause, recency-weighted when a clock is given — the ONLY field this
   *  module ranks by. */
  minutes: number;
  /** How often it fired — reported for context; ranking by this instead of minutes is the
   *  falsifier: a frequent one-minute check must never outrank a rare 25-minute one. */
  rounds: number;
  prs: number;
}

/** Sum priced rounds and a gate-fire-rate report into one row per cause, ranked by MINUTES. */
export function priceCiFrictionCauses(
  ledgerRounds: readonly CiFrictionRound[],
  gateFireRates?: GateFireRateReport,
  nowMs?: number,
): CiFrictionCausePrice[] {
  const rows = new Map<string, { cause: CiFrictionCause; minutes: number; rounds: number; prSet: Set<number>; prs: number }>();
  for (const r of ledgerRounds) {
    const key = ciFrictionCauseKey(r.cause);
    const row = rows.get(key) ?? { cause: r.cause, minutes: 0, rounds: 0, prSet: new Set<number>(), prs: 0 };
    row.minutes += nowMs === undefined ? r.minutes : r.minutes * ciFrictionRecencyWeight(r.at, nowMs);
    row.rounds += 1;
    row.prSet.add(r.pr);
    rows.set(key, row);
  }
  if (gateFireRates?.status === "measured") {
    for (const g of gateFireRates.gates) {
      if (g.minutes <= 0) continue;
      const cause: CiFrictionCause = { kind: "check", name: g.gate };
      rows.set(ciFrictionCauseKey(cause), { cause, minutes: g.minutes, rounds: g.redRuns, prSet: new Set(), prs: g.prs });
    }
  }
  return [...rows.values()]
    .map(({ cause, minutes, rounds, prSet, prs }) => ({
      cause,
      minutes: Math.round(minutes * 10) / 10,
      rounds,
      prs: prSet.size > 0 ? prSet.size : prs,
    }))
    .sort((a, b) => b.minutes - a.minutes || b.rounds - a.rounds);
}

// ── Loading rounds from the ledger union ────────────────────────────────────────────────────

/** Exported so a fixture can exercise its unhealthy arm by name (negative-reachability-ratchet,
 *  W1-T2317) — a pull-request URL's `/pull/<n>` suffix, matched, versus any other GitHub URL
 *  shape, rejected. */
export const PR_URL_RE = /\/pull\/(\d+)(?:[/?#].*)?$/;

function prNumberFromUrl(url: unknown): number | undefined {
  if (typeof url !== "string") return undefined;
  const m = PR_URL_RE.exec(url);
  return m ? Number(m[1]) : undefined;
}

/** `run_id -> pull request number`, from `pr.opened` — every implement/fix run logs it once, the
 *  moment the pull request the fix rung's rounds belong to exists. A run this cannot attribute
 *  contributes no rounds, never a guessed pull request. */
export function runPrIndex(records: readonly LedgerRecord[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const r of records) {
    if (r.step !== "pr.opened" || typeof r.run_id !== "string") continue;
    const pr = prNumberFromUrl(r.pr_url);
    if (pr !== undefined && !index.has(r.run_id)) index.set(r.run_id, pr);
  }
  return index;
}

const minutesBetween = (fromIso: unknown, toIso: unknown): number | undefined => {
  if (typeof fromIso !== "string" || typeof toIso !== "string") return undefined;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isFinite(ms) && ms > 0 ? ms / 60_000 : undefined;
};

function causeFromDispatchMode(mode: unknown): CiFrictionCause {
  return mode === "merge-conflict" ? { kind: "conflict", name: "merge-conflict" } : { kind: "check", name: typeof mode === "string" ? mode : "unknown" };
}

/** The one line a red check's log tail names its failure by: the failing test FILE when the log
 *  names one, else the first failure line with its volatile parts (timestamps, shas, counts)
 *  removed so two rounds of the same failure share one signature. `undefined` when neither exists. */
export function ciFailureSignature(logTail: string): string | undefined {
  const lines = logTail.split("\n");
  const failing = lines.filter((l) => /not ok|✖|FAIL|fail(?:ed|ure)?\b|Error|refused|BLOCKED/.test(l));
  // The file a failure line names, else (a stack frame under it) the first file the tail names.
  for (const l of failing.length > 0 ? [...failing, ...lines] : []) {
    const file = /(test\/[\w./-]+\.test\.[mc]?[jt]s)/.exec(l)?.[1];
    if (file) return file;
  }
  const first = failing[0]
    ?.replace(/^\S+\s+\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, "")
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "")
    .replace(/\b[0-9a-f]{7,40}\b/g, "")
    .replace(/\d+/g, "N")
    .trim();
  return first ? first.slice(0, 120) : undefined;
}

/** A refused commit's reason, stripped of its volatile parts, so every round refused the same way
 *  prices ONE harness cause (`fix_refusal:<reason>`) rather than one per sha. */
export function refusalReasonKey(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim() === "") return "commit_refused";
  return kebabSlug(reason.split(/ — |: /)[0]!.replace(/\b[0-9a-f]{7,40}\b/g, "").replace(/\d+/g, "n"), 60);
}

/** A matrix check's FAMILY: `coverage-shard (5/8)` and `coverage-shard (5/4)` are one cause, so a
 *  shard-count change in ci.yml never splits one failure's cost across names. */
export function ciCheckFamily(check: string): string {
  return check.replace(/\s*\(\d+\/\d+\)\s*$/, "");
}

function ciLogCauses(r: LedgerRecord, redByHead: ReadonlyMap<string, string[]>, flaky: ReadonlySet<string>): CiFrictionCause[] {
  const own = Array.isArray(r.ci_failures)
    ? (r.ci_failures as Array<{ check?: unknown; signature?: unknown }>).filter((f) => typeof f.check === "string")
    : [];
  const failures = own.length > 0
    ? own.map((f) => ({ check: f.check as string, signature: typeof f.signature === "string" ? f.signature : undefined }))
    : (typeof r.head_sha === "string" ? redByHead.get(r.head_sha) ?? [] : []).map((check) => ({ check, signature: undefined as string | undefined }));
  if (failures.length === 0) return [{ kind: "check", name: "ci-log" }];
  return failures.map(({ check, signature }) => ({
    kind: "check",
    name: `ci-log:${kebabSlug(ciCheckFamily(check), 40)}${signature ? `:${kebabSlug(signature, 60)}` : ""}${signature && flaky.has(signature) ? ":flaky" : ""}`,
  }));
}

/** `head_sha -> the red checks the sweep saw on it`, from `sweep.disposed` (its `red_checks`, or
 *  the check its reason names, "<check> failed on <sha>"). */
function redChecksByHead(records: readonly LedgerRecord[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const r of records) {
    if (r.step !== "sweep.disposed" || typeof r.head_sha !== "string") continue;
    const listed = Array.isArray(r.red_checks) ? (r.red_checks as unknown[]).filter((c): c is string => typeof c === "string") : [];
    const named = typeof r.reason === "string" ? /([^—]+?) failed on [0-9a-f]{7}/.exec(r.reason)?.[1]?.trim() : undefined;
    const checks = listed.length > 0 ? listed : named ? [named] : [];
    if (checks.length > 0) index.set(r.head_sha, checks);
  }
  return index;
}

interface RoundBoundary {
  ts: string;
  round?: number;
  cause: CiFrictionCause;
  /** A round that repaired several red checks at once: its minutes split evenly across them. */
  split?: CiFrictionCause[];
  /** The round's own worker minutes (`elapsed_ms`, W1-T1219), when the row carries them. */
  elapsed?: number;
  /** The pull request the round's head belongs to, for a run that logged no `pr.opened`. */
  pr?: number;
}

/** `head_sha -> pull request`, from any row naming both (the sweep's `sweep.disposed`). The daemon
 *  sweep's fix rounds share one `DAEMON-*` run id across many PRs and log no `pr.opened`, so the
 *  head they repaired is the only thing that ties a round to its PR. */
export function headPrIndex(records: readonly LedgerRecord[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const r of records) {
    if (typeof r.head_sha !== "string" || index.has(r.head_sha)) continue;
    const pr = typeof r.pr_number === "number" ? r.pr_number : prNumberFromUrl(r.pr_url);
    if (pr !== undefined) index.set(r.head_sha, pr);
  }
  return index;
}

/**
 * Every `fix.dispatch` / `fix.base_refreshed` round, attributed to a cause and priced by its own
 * worker minutes (`elapsed_ms`, dispatch to the round's end) when the row carries them, else the
 * wall-clock minutes since the run's previous round (or its `pr.opened`, for the first). A sweep
 * round (a `DAEMON-*` run, no `pr.opened`) is tied to its PR by the head it repaired. A round
 * whose own `fix.commit_refused` fired is priced as `fix_refusal` instead of whatever triggered it
 * — the harness bought no progress that round, which is the waste design point (iv) asks for.
 */
export function ciFrictionRoundsFromLedger(records: readonly LedgerRecord[]): CiFrictionRound[] {
  const prByRun = runPrIndex(records);
  const prByHead = headPrIndex(records);
  const redByHead = redChecksByHead(records);
  const flaky = new Set(records.filter((r) => r.step === "test.flake_retry" && typeof r.file === "string").map((r) => r.file as string));
  // A refusal belongs to the latest dispatch of the same run on the same round: a numbered round
  // (an implement run) or, for the sweep's "resume"/"fresh" rounds, the same head sha.
  const roundKey = (r: LedgerRecord): string | undefined =>
    typeof r.run_id !== "string" ? undefined : typeof r.round === "number" ? `${r.run_id}#${r.round}` : typeof r.head_sha === "string" ? `${r.run_id}@${r.head_sha}` : undefined;
  const lastDispatch = new Map<string, RoundBoundary>();
  const byRun = new Map<string, RoundBoundary[]>();
  const opens = new Map<string, string>();
  for (const r of records) {
    if (typeof r.run_id !== "string" || typeof r.ts !== "string") continue;
    if (r.step === "pr.opened" && !opens.has(r.run_id)) {
      opens.set(r.run_id, r.ts);
      continue;
    }
    if (r.step === "fix.dispatch") {
      const round = typeof r.round === "number" ? r.round : undefined;
      const split = r.mode === "ci-log" ? ciLogCauses(r, redByHead, flaky) : undefined;
      const list = byRun.get(r.run_id) ?? [];
      const elapsed = typeof r.elapsed_ms === "number" && r.elapsed_ms > 0 ? r.elapsed_ms / 60_000 : undefined;
      const boundary: RoundBoundary = { ts: r.ts, round, cause: causeFromDispatchMode(r.mode), split, elapsed, pr: typeof r.head_sha === "string" ? prByHead.get(r.head_sha) : undefined };
      list.push(boundary);
      byRun.set(r.run_id, list);
      const key = roundKey(r);
      if (key) lastDispatch.set(key, boundary);
    } else if (r.step === "fix.commit_refused") {
      const key = roundKey(r);
      const boundary = key ? lastDispatch.get(key) : undefined;
      if (boundary) {
        boundary.cause = { kind: "fix_refusal", name: refusalReasonKey(r.reason) };
        boundary.split = undefined;
      }
    } else if (r.step === "fix.base_refreshed") {
      const files = Array.isArray(r.matching_base_files) ? (r.matching_base_files as unknown[]).filter((f): f is string => typeof f === "string") : [];
      const list = byRun.get(r.run_id) ?? [];
      list.push({ ts: r.ts, cause: { kind: "main_merge", name: files[0] ?? "main" } });
      byRun.set(r.run_id, list);
    }
  }
  const rounds: CiFrictionRound[] = [];
  for (const [runId, list] of byRun) {
    const runPr = prByRun.get(runId);
    const sorted = [...list].sort((a, b) => a.ts.localeCompare(b.ts));
    let prevTs = opens.get(runId) ?? sorted[0]?.ts;
    for (const boundary of sorted) {
      const pr = runPr ?? boundary.pr;
      // A gap between two rows of a shared sweep run spans OTHER PRs' work, so it prices nothing.
      const minutes = boundary.elapsed ?? (runPr !== undefined ? minutesBetween(prevTs, boundary.ts) : undefined);
      if (pr !== undefined && minutes !== undefined) {
        const causes = boundary.split ?? [boundary.cause];
        for (const cause of causes) rounds.push({ pr, cause, minutes: minutes / causes.length, at: boundary.ts });
      }
      prevTs = boundary.ts;
    }
  }
  return rounds;
}

/** The persisted gate-fire-rate report (W1-T4115) — `undefined` when it has never been measured,
 *  never a guessed report. */
export function readGateFireRateReport(stateDir: string): GateFireRateReport | undefined {
  const p = gateFireRatesPath(stateDir);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as GateFireRateReport;
  } catch {
    // deliberate: an unreadable report prices zero check causes this pass, never a fabricated one.
    return undefined;
  }
}

// ── Drafting the costliest untracked cause ──────────────────────────────────────────────────

/** The idempotency key a filed task's `origin:` carries — matched against every `origin:` the plan
 *  already holds so a tracked cause is never re-drafted. */
export function ciFrictionOrigin(cause: CiFrictionCause): string {
  return `ci-friction:${ciFrictionCauseKey(cause)}`;
}

/** The costliest priced cause with no queued task already tracking it — `undefined` when every
 *  measured cause already has one, which proposes nothing rather than a duplicate. */
export function costliestUntrackedCause(priced: readonly CiFrictionCausePrice[], planOrigins: readonly string[]): CiFrictionCausePrice | undefined {
  const held = new Set(planOrigins);
  return priced.find((p) => !held.has(ciFrictionOrigin(p.cause)));
}

/** Where a person records that a drafted cause's remedy landed — a task's acceptance proof points
 *  here, and the file need not exist yet at filing time (an absent path is simply no match). */
export const CI_FRICTION_REMEDIES_FILE = "docs/ci-friction-remedies.md";
export const CI_FRICTION_GARDEN_LOG = "ci-friction-garden-log.md";
/** The trend log lives beside the gardener's own state: it needs no PR, so it cannot ride one. */
export function ciFrictionGardenLogPath(stateDir: string): string {
  return join(stateDir, CI_FRICTION_GARDEN_LOG);
}
const CI_FRICTION_SLUG_MAX = 72;

/** Render ONE draft as a single-element YAML task list — the shard file's whole contents. */
export function ciFrictionShardYaml(price: CiFrictionCausePrice, taskId: string, priced: readonly CiFrictionCausePrice[] = [price]): string {
  const key = ciFrictionCauseKey(price.cause);
  const origin = ciFrictionOrigin(price.cause);
  // The shared machine-filing path (operator ruling 2026-09-29): the header, verify and risk are its.
  return renderMachineShard({
    taskId,
    title: `THE CI FRICTION GARDENER'S COSTLIEST UNTRACKED CAUSE — ${key} cost ${price.minutes} PR minute(s) across ${price.rounds} round(s) on ${price.prs} pull request(s), and nothing tracks it`,
    origin,
    files: [CI_FRICTION_REMEDIES_FILE],
    cost: price.minutes,
    costPopulation: priced.map((p) => p.minutes),
    acceptance: [{ claim: `the ${key} cause of PR friction has a recorded remedy`, proof: `grep: ${origin} in ${CI_FRICTION_REMEDIES_FILE}` }],
    note: `Filed by the ci-friction gardener (W1-T4435) from a weekly pass over the ledger and gate-fire-rate.ts's own measurement. ${key} priced at ${price.minutes} PR minute(s) across ${price.rounds} round(s) on ${price.prs} pull request(s) — the costliest cause with no open task. MACHINE-AUTHORED — the machine-filing judge releases it or escalates it to a person; its remedy is recorded in ${CI_FRICTION_REMEDIES_FILE} naming "${origin}" once it lands.`,
  }).text;
}

/** Parse rendered shard bytes back and lint them — a record this rung cannot get past the repo's
 *  own linter must never reach the disk. */
export function ciFrictionRecordVerdict(contents: string, label: string): { ok: boolean; reason: string } {
  try {
    const task = loadPlanFromYaml(contents, label).tasks[0];
    const lint = lintTask(task);
    return lint.ok ? { ok: true, reason: "" } : { ok: false, reason: lint.violations.map((v) => `${v.severity}:${v.check}`).join(", ") };
  } catch (e) {
    return { ok: false, reason: `unparseable: ${(e as Error).message}` };
  }
}

/** One row for {@link CI_FRICTION_GARDEN_LOG}: the total priced this pass and its costliest cause,
 *  so an improvement is visible as the total moving, not just the newest draft. */
export function ciFrictionTrendRow(atIso: string, priced: readonly CiFrictionCausePrice[]): string {
  const total = Math.round(priced.reduce((s, p) => s + p.minutes, 0) * 10) / 10;
  const top = priced[0];
  return `| ${atIso} | ${total} | ${top ? `${ciFrictionCauseKey(top.cause)} (${top.minutes}m)` : "none"} |`;
}

/** Append this pass's trend row unless the log's last row already reads the same total and top. */
export function appendCiFrictionTrendRow(logPath: string, atIso: string, priced: readonly CiFrictionCausePrice[]): void {
  const row = ciFrictionTrendRow(atIso, priced);
  const prior = existsSync(logPath)
    ? readFileSync(logPath, "utf8")
    : "# CI friction garden log\n\nEach row is one pass of the ci-friction gardener (W1-T4435) whose pricing moved: the total\nPR minutes it priced across every cause, and the costliest one.\n\n| pass | total PR minutes | costliest cause |\n| --- | --- | --- |\n";
  const sansTime = (line: string) => line.split("|").slice(2).join("|");
  const last = prior.trimEnd().split("\n").at(-1) ?? "";
  if (sansTime(last) === sansTime(row)) return;
  writeAtomic(logPath, prior.replace(/\n*$/, "\n") + row + "\n");
}

// ── The gardener spec ────────────────────────────────────────────────────────────────────────

export type CiFrictionGardenClass = "draft";
export const CI_FRICTION_GARDEN_CLASSES: readonly CiFrictionGardenClass[] = ["draft"];

export interface CiFrictionGardenAction extends GardenAction<CiFrictionGardenClass> {
  price: CiFrictionCausePrice;
  origin: string;
  /** Every cause priced in the pass, which ranks this one's dispatch priority. */
  priced?: CiFrictionCausePrice[];
}

export interface CiFrictionInventory {
  priced: CiFrictionCausePrice[];
  untracked?: CiFrictionCausePrice;
}

export interface CiFrictionGardenSources {
  /** The ledger union's own records — read once per pass, never parsed twice for one tick. */
  ledgerRecords: () => readonly LedgerRecord[];
  gateFireRates?: () => GateFireRateReport | undefined;
  /** Every `origin:` the plan already holds. */
  planOrigins: () => readonly string[];
  /** THE RESERVATION PATH (task-id-reservation.ts via `ciLearningTaskIdMinter`, run-task.ts),
   *  never `max(id)+1` — see that minter's own doc for why. */
  mintTaskId: (filingBranch?: string) => string;
}

function draftCandidates(inv: CiFrictionInventory): CiFrictionGardenAction[] {
  if (!inv.untracked) return [];
  const cause = inv.untracked.cause;
  return [
    {
      class: "draft",
      target: ciFrictionCauseKey(cause),
      origin: ciFrictionOrigin(cause),
      price: inv.untracked,
      priced: inv.priced,
      reason: `${ciFrictionCauseKey(cause)} cost ${inv.untracked.minutes} PR minute(s) across ${inv.untracked.rounds} round(s) on ${inv.untracked.prs} pull request(s) — the costliest cause with no open task.`,
    },
  ];
}

/** The repo's own CI friction as a gardener spec (gardener.ts, W1-T4110). */
export function ciFrictionGardenSpec(deps: GardenerDeps, sources: CiFrictionGardenSources): GardenSpec<CiFrictionGardenClass, CiFrictionInventory, CiFrictionGardenAction, GardenCheckout> {
  const clock: Clock = deps.clock ?? systemClock;
  return {
    name: "ci-friction",
    classes: CI_FRICTION_GARDEN_CLASSES,
    review: { draft: "filing a new task from priced friction is a judgement call — a person decides the remedy." },
    cheapFingerprint: () => {
      const head = execFileSync("git", ["-C", deps.repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const live = ledgerLivePath(deps.stateDir);
      const report = gateFireRatesPath(deps.stateDir);
      const fileStamp = (path: string): string => {
        if (!existsSync(path)) return "absent";
        const stat = statSync(path);
        return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
      };
      // A live append is expected every second; inode and mode change only when the source is
      // replaced or its access posture changes. The hourly bucket bounds ordinary full reads.
      const liveAccessStamp = (): string => {
        if (!existsSync(live)) return "absent";
        const stat = statSync(live);
        return `${stat.ino}:${stat.mode}`;
      };
      // Rotations can change independently of the live ledger. Include their metadata so a
      // changed or unreadable archive cannot be skipped by the garden's cheap-pass cache.
      const archives = ledgerRotationEntries(readdirSync(deps.stateDir), deps.stateDir)
        .map((entry) => {
          const stat = statSync(entry.path);
          return `${basename(entry.path)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
        }).join("|");
      return `${head}:${gardenLedgerBucket(clock)}:${liveAccessStamp()}:${fileStamp(report)}:${archives}`;
    },
    inventory: () => {
      const rounds = ciFrictionRoundsFromLedger(sources.ledgerRecords());
      const priced = priceCiFrictionCauses(rounds, sources.gateFireRates?.(), clock.now());
      return { priced, untracked: costliestUntrackedCause(priced, sources.planOrigins()) };
    },
    // The plan's own `origin:` lines decide whether the costliest cause is filed — never a recorded
    // fingerprint alone, which a pass that drew no action or failed to land could have left behind.
    unfinished: (inv) => inv.untracked !== undefined,
    fingerprint: (inv) => `${inv.priced.map((p) => `${ciFrictionCauseKey(p.cause)}:${p.minutes}`).join(",")}|${inv.untracked ? ciFrictionCauseKey(inv.untracked.cause) : ""}`,
    candidates: (inv) => draftCandidates(inv),
    scorecard: (inv) => {
      appendCiFrictionTrendRow(ciFrictionGardenLogPath(deps.stateDir), clock.iso(), inv.priced);
      return {
      causes: inv.priced.length,
      total_minutes: Math.round(inv.priced.reduce((s, p) => s + p.minutes, 0) * 10) / 10,
      untracked: inv.untracked ? ciFrictionCauseKey(inv.untracked.cause) : null,
      priced: inv.priced,
      };
    },
    apply: (ws, plan) => {
      const action = plan.actions[0];
      if (!action) return undefined;
      if (!ws.branch) throw new Error("ci-friction gardener: filing workspace has no branch for task-id reservation");
      const taskId = sources.mintTaskId(ws.branch);
      const contents = ciFrictionShardYaml(action.price, taskId, action.priced);
      const verdict = ciFrictionRecordVerdict(contents, `ci-friction:${taskId}`);
      if (!verdict.ok) throw new Error(`ci-friction gardener: drafted record failed lint (${verdict.reason})`);
      const stem = kebabSlug(ciFrictionCauseKey(action.price.cause), CI_FRICTION_SLUG_MAX).replace(/-+$/, "");
      const shardDir = join(resolveRepoLayout(ws.root).planDir, "tasks.d");
      const shardPath = join(shardDir, `${taskId}${stem ? `-${stem}` : ""}.yaml`);
      const relPath = relative(ws.root, shardPath);
      mkdirSync(shardDir, { recursive: true });
      writeFileSync(shardPath, contents);

      const body = [
        "The ci-friction gardener (W1-T4435) prices CI-round causes in PR minutes, ranked by minutes lost — never fire count.",
        "",
        `- **draft** \`${action.target}\`: ${action.reason}`,
        "",
        `The shard's one criterion is carried, once its remedy lands, by \`grep: ${action.origin} in ${CI_FRICTION_REMEDIES_FILE}\`.`,
        "",
        "## Acceptance",
        `- claim: the costliest untracked cause is filed as a parked task`,
        `  proof: grep: ${action.origin} in ${relPath}`,
      ].join("\n");
      // PLAN-ONLY: the shard alone, so Standing rule 15's filing exemption applies.
      return { paths: [relPath], title: `chore(plan): the ci-friction gardener drafts a fix for ${action.target}`, body };
    },
  };
}

/** Run ci-friction gardener passes on their own timer (gardener.ts's `startGarden`). */
export function startCiFrictionGardener(deps: GardenerDeps, sources: CiFrictionGardenSources, intervalMs: number): { stop: () => void } {
  return startGarden(ciFrictionGardenSpec(deps, sources), deps, intervalMs);
}
