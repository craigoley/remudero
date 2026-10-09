import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { systemClock, type Clock } from "./clock.js";
import type { Escalation } from "./escalate.js";
import type { GardenAction, GardenCheckout, GardenerDeps, GardenSpec } from "./gardener.js";
import { gardenLedgerBucket } from "./gardener.js";
import { writeAtomic } from "./fs-race-safe.js";
import { ghExec } from "./github-transport.js";
import { gateFireRatesPath, type GateFireRateReport } from "./gate-fire-rate.js";
import { ledgerLivePath, ledgerRotationDigests, ledgerRotationEntries, readLedgerUnionRecordsSync, type LedgerGrepFsDeps, type LedgerRotationHook } from "./ledger-union.js";
import { loadPlanFromYaml } from "./plan.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { lintTask } from "./task-linter.js";
import { renderMachineShard } from "./machine-filing.js";
import {
  CI_FRICTION_REMEDIES_DOC,
  ciFrictionCauseState,
  ciFrictionEvidence,
  ciFrictionRemedyRationale,
  ciFrictionRungOrigin,
  locateCiFrictionOwner,
  ownerSearchTerms,
  parseCiFrictionOrigin,
  type CiFrictionCauseState,
  type CiFrictionOwner,
  type CiFrictionOwnershipEvidence,
  type CiFrictionRemedyTask,
  type OwnerSearch,
  type RemedyRound,
  type ReplayStep,
  replayCiFrictionLadder,
} from "./ci-friction-remedy.js";
import { slug as kebabSlug } from "./feedback-docket.js";
import { trailerTaskIds } from "./field-trials-github.js";
import type { LedgerRecord } from "./retro.js";

/**
 * CI friction is ranked by recency-weighted PR minutes, never fire count.
 * Ledger rounds measure checks, main merges, conflicts and refused commits; merged manual fixes
 * add explicitly labeled median proxies. Gate reports supply measured check minutes.
 * Remedies enter the governed plan through the existing ladder, not a direct code-writing path.
 * Unreadable history refuses the pass; unreadable manual evidence is reported independently.
 */

// ── Pricing: rounds → causes, never fire count ──────────────────────────────────────────────

export type CiFrictionCauseKind = "check" | "main_merge" | "conflict" | "fix_refusal" | "hand_fix";

export type CiFrictionHandFix = { pr: number; at: string; files: string[] };
export type CiFrictionHandFixRead = { state: "observed"; fixes: CiFrictionHandFix[]; asOf?: string; source?: "cache" | "api" } | { state: "unmeasured"; reason: string; fixes: CiFrictionHandFix[] };

/** Collect one paginated list per pass; source changes come from local merge commits, not N PR API reads. */
export function readCiFrictionHandFixes(
  repoRoot: string, stateDir: string, owner: string, repo: string, clock: Clock = systemClock,
  run: (command: string, args: string[]) => string = (command, args) => command === "gh" ? ghExec(args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }) : execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }),
): CiFrictionHandFixRead {
  const since = clock.now() - 14 * 86_400_000;
  const fixes = new Map<number, CiFrictionHandFix>();
  try {
    const path = join(stateDir, "ci-friction-hand-fixes.json");
    const cached = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
    if (cached?.repository === `${owner}/${repo}` && cached.state === "observed" && Array.isArray(cached.fixes) &&
      cached.fixes.every((fix: CiFrictionHandFix) => Number.isSafeInteger(fix.pr) && Number.isFinite(Date.parse(fix.at)) && Array.isArray(fix.files) && fix.files.every((file) => /^(src|scripts)\/[\w./-]+$/.test(file) && !file.split("/").includes(".."))) &&
      clock.now() >= Date.parse(cached.asOf) && clock.now() - Date.parse(cached.asOf) < 600_000)
      return { state: "observed", fixes: cached.fixes.filter((fix: CiFrictionHandFix) => Date.parse(fix.at) >= since), asOf: cached.asOf, source: "cache" };
    const byPr: Record<string, { sha: string; files: string[] }> = {};
    for (let page = 1; ; page++) {
      const rows = JSON.parse(run("gh", ["api", `repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`]));
      if (!Array.isArray(rows)) throw new Error("hand-fix PR list is not an array");
      for (const row of rows) {
        if (!Number.isSafeInteger(row.number) || typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at)))
          throw new Error("hand-fix PR list has an invalid identity or timestamp");
        if (!/^run-unfiled-/.test(row.head?.ref ?? "") || !/^fix(?:\([^)]*\))?!?:/.test(row.title ?? "") || !row.merged_at) continue;
        const at = Date.parse(row.merged_at); // expiring-fixture: exempt -- tests inject Clock and exercise both window boundaries
        if (!Number.isFinite(at) || at < since || at > clock.now()) continue;
        if (!/^[0-9a-f]{40}$/.test(row.merge_commit_sha ?? "")) throw new Error(`hand-fix PR #${row.number} has no merge commit`);
        const prior = cached?.repository === `${owner}/${repo}` ? cached.byPr?.[row.number] : undefined;
        const files: string[] = prior?.sha === row.merge_commit_sha && Array.isArray(prior.files) && prior.files.every((file: unknown) => typeof file === "string" && /^(src|scripts)\/[\w./-]+$/.test(file) && !file.split("/").includes("..")) ? prior.files :
          run("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", row.merge_commit_sha])
            .trim().split("\n").filter((file) => /^(src|scripts)\/[\w./-]+$/.test(file) && !file.split("/").includes(".."));
        byPr[row.number] = { sha: row.merge_commit_sha, files: [...new Set<string>(files)] };
        fixes.set(row.number, { pr: row.number, at: row.merged_at, files: [...new Set(files)] });
      }
      if (rows.length < 100 || Date.parse(rows.at(-1).updated_at) < since) break;
    }
    const result: CiFrictionHandFixRead = { state: "observed", fixes: [...fixes.values()].sort((a, b) => a.pr - b.pr), asOf: clock.iso(), source: "api" };
    writeAtomic(path, JSON.stringify({ ...result, repository: `${owner}/${repo}`, byPr }) + "\n");
    return result;
  } catch (error) {
    return { state: "unmeasured", reason: String((error as Error)?.message ?? error), fixes: [] };
  }
}

/** A manual repair is one observation. Attribute it to its highest-priced owner match, never count it twice. */
export function ciFrictionHandFixRounds(
  fixes: readonly CiFrictionHandFix[], rounds: readonly CiFrictionRound[], priced: readonly CiFrictionCausePrice[], search: OwnerSearch,
): CiFrictionRound[] {
  const sorted = rounds.map((r) => r.minutes).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const owners = priced.map((price) => ({ price, files: locateCiFrictionOwner(ciFrictionCauseKey(price.cause),
    rounds.filter((r) => ciFrictionCauseKey(r.cause) === ciFrictionCauseKey(price.cause)).flatMap((r) => r.detail ? [r.detail] : []), search)?.files ?? [] }));
  const unique = [...new Map(fixes.map((fix) => [fix.pr, fix])).values()];
  const unowned = new Map<string, CiFrictionHandFix[]>();
  const result: CiFrictionRound[] = [];
  for (const fix of unique) {
    const matched = owners.find((owner) => owner.files.some((file) => fix.files.includes(file)));
    if (matched) {
      if (!rounds.some((round) => round.pr === fix.pr && ciFrictionCauseKey(round.cause) === ciFrictionCauseKey(matched.price.cause)))
        result.push({ pr: fix.pr, at: fix.at, cause: matched.price.cause, minutes: median,
          pricing: "median-proxy",
          detail: `hand fix PR #${fix.pr}: ${fix.files.join(", ")}; minutes are the pass median proxy (${median}), not measured repair time` });
    } else {
      for (const file of fix.files) unowned.set(file, [...(unowned.get(file) ?? []), fix]);
    }
  }
  const emitted = new Set<number>();
  for (const [file, repairs] of [...unowned].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    if (repairs.length < 2) continue;
    for (const fix of repairs) {
      if (emitted.has(fix.pr)) continue;
      emitted.add(fix.pr);
      result.push({ pr: fix.pr, at: fix.at, cause: { kind: "hand_fix", name: file }, minutes: median,
        pricing: "median-proxy",
        detail: `hand fix PR #${fix.pr}: ${file}; minutes are the pass median proxy (${median}), not measured repair time` });
    }
  }
  return result;
}

/** A failed history read is a failed garden pass, never a measured zero-friction corpus. */
export const CI_FRICTION_LEDGER_STEPS: readonly string[] = [
  "pr.opened", "sweep.disposed", "test.flake_retry", "fix.dispatch", "fix.commit_refused",
  "fix.base_refreshed", "ci-friction.remedy_escalated", "ci-friction.scorecard",
];

/** Bump whenever {@link CI_FRICTION_LEDGER_STEPS} or {@link ciFrictionHeadWitnesses} changes: each keys a durable
 *  per-rotation digest ({@link ledgerRotationDigests}), and a stale one must not answer for the new reduction. */
export const CI_FRICTION_DIGEST_VERSION = "1";

/** One rotation's head-to-PR witnesses, reduced the way the association recovery below reads them: the first
 *  row per head sha that names a pull request, as `{ step, head_sha, pr_number }`. */
export function ciFrictionHeadWitnesses(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const witnesses: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (typeof row.head_sha !== "string" || seen.has(row.head_sha)) continue;
    const pr = typeof row.pr_number === "number" ? row.pr_number : prNumberFromUrl(row.pr_url);
    if (pr === undefined) continue;
    seen.add(row.head_sha);
    witnesses.push({ step: row.step, head_sha: row.head_sha, pr_number: pr });
  }
  return witnesses;
}

/** The durable rotation digests the ci-friction history read answers its archives from. */
export interface CiFrictionRotationDigests {
  steps: LedgerRotationHook;
  witnesses: LedgerRotationHook;
}

export function ciFrictionRotationDigests(stateDir: string, fsDeps?: LedgerGrepFsDeps): CiFrictionRotationDigests {
  const wanted = new Set(CI_FRICTION_LEDGER_STEPS);
  return {
    steps: ledgerRotationDigests(stateDir, (rows) => rows.filter((row) => wanted.has(row.step as string)),
      { holder: "ci-friction-steps", reducerVersion: CI_FRICTION_DIGEST_VERSION }, fsDeps).rotationRecords,
    witnesses: ledgerRotationDigests(stateDir, ciFrictionHeadWitnesses,
      { holder: "ci-friction-head-witnesses", reducerVersion: CI_FRICTION_DIGEST_VERSION }, fsDeps).rotationRecords,
  };
}

/**
 * The gardener's whole ledger history. Archived rotations are answered from durable digests, so a pass after
 * the first decompresses only rotations cut since the last one; the rows are the full union's, unchanged.
 */
export function readCiFrictionLedgerRecords(
  stateDir: string,
  reader: typeof readLedgerUnionRecordsSync = readLedgerUnionRecordsSync,
  digests: CiFrictionRotationDigests = ciFrictionRotationDigests(stateDir),
): LedgerRecord[] {
  const checked = (options: Parameters<typeof readLedgerUnionRecordsSync>[1]): LedgerRecord[] => {
    const read = reader(stateDir, options);
    if (!read.ok) {
      const reason = read.archiveCount === 0
        ? "no ledger rotations"
        : read.unread.length > 0
          ? `unread ledger file(s): ${read.unread.map((path) => basename(path)).join(", ")}`
          : "incomplete ledger union";
      throw new Error(`ci-friction ledger union unreadable: ${reason}`);
    }
    return read.rows as LedgerRecord[];
  };
  const rows = checked({ step: CI_FRICTION_LEDGER_STEPS, requireArchives: true, refuseIncomplete: true, rotationRecords: digests.steps });
  const byRun = runPrIndex(rows);
  const byHead = headPrIndex(rows);
  const missing = new Set<string>();
  for (const row of rows) {
    if (row.step === "fix.dispatch" && typeof row.head_sha === "string" && !byHead.has(row.head_sha) && !byRun.has(String(row.run_id))) missing.add(row.head_sha);
  }
  if (missing.size === 0) return rows;
  // headPrIndex also accepts association witnesses from review/verdict rows. Recover only heads
  // the retained dispatches need, preserving that attribution without keeping every unrelated row.
  const pattern = new RegExp([...missing].map(head => JSON.stringify(head).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
  const recovered = new Set<string>();
  // The pattern narrows the live file; each archive answers with its witnesses, which the head check below narrows.
  for (const row of checked({ pattern, requireArchives: true, refuseIncomplete: true, rotationRecords: digests.witnesses })) {
    if (typeof row.head_sha !== "string" || !missing.has(row.head_sha) || recovered.has(row.head_sha)) continue;
    const pr = typeof row.pr_number === "number" ? row.pr_number : prNumberFromUrl(row.pr_url);
    if (pr === undefined) continue;
    rows.push({ step: row.step, head_sha: row.head_sha, pr_number: pr });
    recovered.add(row.head_sha);
  }
  return rows;
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
  /** What the round met, verbatim enough to act on: a refusal's reason, a check and the failure it
   *  named, the files a main merge brought in. The evidence a drafted remedy carries. */
  detail?: string;
  pricing?: "median-proxy";
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
      const hand = ledgerRounds.filter((r) => r.pricing === "median-proxy" && ciFrictionCauseKey(r.cause) === ciFrictionCauseKey(cause));
      const proxyMinutes = hand.reduce((sum, r) => sum + r.minutes * (nowMs === undefined ? 1 : ciFrictionRecencyWeight(r.at, nowMs)), 0);
      rows.set(ciFrictionCauseKey(cause), { cause, minutes: g.minutes + proxyMinutes, rounds: g.redRuns + hand.length,
        prSet: new Set(), prs: g.prs + new Set(hand.map((r) => r.pr)).size });
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
  detail?: string;
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
      const named = Array.isArray(r.ci_failures)
        ? (r.ci_failures as Array<{ check?: unknown; signature?: unknown }>).map((f) => `${String(f.check)}${typeof f.signature === "string" ? `: ${f.signature}` : ""}`).join("; ")
        : "";
      const conflicted = Array.isArray(r.conflicted_files) ? (r.conflicted_files as unknown[]).filter((f) => typeof f === "string").slice(0, 3).join(", ") : "";
      const detail = [`${String(r.mode)} round`, named, conflicted ? `conflicted: ${conflicted}` : ""].filter(Boolean).join(" — ");
      const boundary: RoundBoundary = { ts: r.ts, detail, round, cause: causeFromDispatchMode(r.mode), split, elapsed, pr: typeof r.head_sha === "string" ? prByHead.get(r.head_sha) : undefined };
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
        boundary.detail = typeof r.reason === "string" ? r.reason : boundary.detail;
      }
    } else if (r.step === "fix.base_refreshed") {
      const files = Array.isArray(r.matching_base_files) ? (r.matching_base_files as unknown[]).filter((f): f is string => typeof f === "string") : [];
      const list = byRun.get(r.run_id) ?? [];
      list.push({ ts: r.ts, cause: { kind: "main_merge", name: files[0] ?? "main" }, detail: files.length > 0 ? `main merged in over ${files.slice(0, 3).join(", ")}` : "main merged in" });
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
        for (const cause of causes) rounds.push({ pr, cause, minutes: minutes / causes.length, at: boundary.ts, ...(boundary.detail ? { detail: boundary.detail } : {}) });
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

/** What the plan says about every ci-friction cause: each task naming one, with when its build merged. */
export interface CiFrictionPlanState {
  tasks: CiFrictionRemedyTask[];
  /** Shards naming a ci-friction origin that did not parse, with why. */
  unreadable?: string[];
  /** Set when the fetch failed and the last fetched main was read instead — named, never silent. */
  degraded?: string;
}

/** Runs git against a checkout and returns stdout. */
export type CiFrictionGit = (args: string[]) => string;

/** How far back the plan-history reads walk. Every read is ONE bounded `git log`, never one per shard:
 *  a full-history walk per shard took about a minute each on this repo (measured 2026-10-02). */
export const CI_FRICTION_HISTORY_SINCE = "--since=60.days";

/** `path -> commit time` from one `git log --name-only` walk; `pick` keeps the oldest or newest. */
export function pathTimesFromLog(text: string, pick: "oldest" | "newest"): Map<string, string> {
  const out = new Map<string, string>();
  let at: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("\u0001")) {
      at = line.slice(1);
      continue;
    }
    if (!line || !at) continue;
    // `git log` lists newest first: overwriting keeps the oldest, first-write-wins keeps the newest.
    if (pick === "oldest" || !out.has(line)) out.set(line, at);
  }
  return out;
}

/** Read every task whose `origin:` names a ci-friction cause from `refName`, and when each one's build
 *  merged: the commit carrying its `Remudero-Task:` trailer, else the commit that set it `merged`. */
export function readCiFrictionPlanTasks(git: CiFrictionGit, shardsDir: string, refName = "origin/main", onUnreadable: (path: string, reason: string) => void = () => {}): CiFrictionRemedyTask[] {
  let listed = "";
  try {
    listed = git(["grep", "-l", "-E", "^[[:space:]]*origin:[[:space:]]*[\"']?ci-friction:", refName, "--", shardsDir]);
  } catch (e) {
    // `git grep` exits 1 on no match, which is an empty plan; any other failure is a real one.
    if ((e as { status?: number }).status !== 1) throw e;
  }
  const paths = listed.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.replace(`${refName}:`, ""));
  const merges = new Map<string, string>();
  for (const line of git(["log", refName, CI_FRICTION_HISTORY_SINCE, "--format=%cI%x09%(trailers:key=Remudero-Task,valueonly,separator=%x2C)"]).split("\n")) {
    const [at, ids] = line.split("\t");
    for (const id of (ids ?? "").split(",").map((value) => value.trim()).filter(Boolean)) if (at) merges.set(id, at);
  }
  // Source registration needs a delivery on main's first-parent history. A feature commit's
  // authored time cannot describe its eventual merge; the older remedy credit reader stays intact.
  const builds = new Map<string, Array<{ at: string; revision: string; changed: string[] }>>();
  for (const block of git(["log", refName, CI_FRICTION_HISTORY_SINCE,
    "--format=%x01%cI%x09%H%x00%B%x00", "--name-only", "--first-parent", "--diff-merges=first-parent", "--max-count=4096"]).split("\x01")) {
    const fields = block.split("\x00");
    if (fields.length !== 3) continue;
    const [at, revision] = fields[0]!.split("\t");
    if (!at || !Number.isFinite(Date.parse(at)) || !revision || !/^[0-9a-f]{40}$/.test(revision)) continue;
    const commit = { at, revision, changed: fields[2]!.split("\n").filter(line => /^(src|scripts)\//.test(line)) };
    for (const id of trailerTaskIds(fields[1])) {
      let group = builds.get(id);
      if (group === undefined) { group = []; builds.set(id, group); }
      group.push(commit);
    }
  }
  const tasks: CiFrictionRemedyTask[] = [];
  for (const path of paths) {
    let parsed: ReturnType<typeof loadPlanFromYaml>;
    try {
      parsed = loadPlanFromYaml(git(["show", `${refName}:${path}`]), path);
    } catch (error) {
      // One unparseable shard is reported by name, never fatal: the rest of the plan still decides.
      onUnreadable(path, String((error as Error)?.message ?? error).split("\n")[0]!);
      continue;
    }
    for (const task of parsed.tasks) {
      if (typeof task.origin !== "string" || parseCiFrictionOrigin(task.origin) === undefined) continue;
      const retired = (task as { retirement?: unknown }).retirement !== undefined;
      const mergedAt = merges.get(task.id);
      tasks.push({ id: task.id, origin: task.origin, status: String(task.status ?? "queued"), retired, files: [...(task.files ?? [])], path, ...(mergedAt ? { mergedAt } : {}) });
    }
  }
  const fallbackPaths = [...new Set(tasks.filter(task => task.status === "merged" && !task.mergedAt && task.path).map(task => task.path!))];
  if (fallbackPaths.length > 0) {
    const flips = pathTimesFromLog(git(["log", refName, CI_FRICTION_HISTORY_SINCE, "-S", "status: merged", "--format=%x01%cI", "--name-only", "--", ...fallbackPaths]), "oldest");
    for (const task of tasks) {
      if (task.status === "merged" && !task.mergedAt && task.path) task.mergedAt = flips.get(task.path);
    }
  }
  let sourceReads = 0;
  for (const task of tasks) {
    const owner = task.files.find((file) => /^(?:src|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|js|sh)$/.test(file)
      && !file.endsWith(".test.ts") && !file.split("/").some((part) => part === "." || part === ".."));
    const build = owner ? [...(builds.get(task.id) ?? [])].reverse().find((entry) => entry.changed.includes(owner)) : undefined;
    if (!owner || !build) {
      task.preventionSource = { state: "unavailable", reason: "no-credited-owning-source-build" };
    } else if (sourceReads >= 32) {
      task.preventionSource = { state: "unavailable", reason: "source-registration-read-cap" };
    } else {
      sourceReads += 1;
      try {
        const blob = git(["rev-parse", `${build.revision}:${owner}`]).trim();
        task.preventionSource = /^[0-9a-f]{40}$/.test(blob)
          ? { id: task.origin, taskId: task.id, causeKey: parseCiFrictionOrigin(task.origin)!.key,
            path: owner, blob, mergeRevision: build.revision, mergedAt: build.at, workScope: "fix-worker-attempt" }
          : { state: "unavailable", reason: "owning-source-blob-invalid" };
      } catch {
        task.preventionSource = { state: "unavailable", reason: "owning-source-blob-unreadable" };
      }
    }
  }
  return tasks;
}

/** The daemon's image checkout may trail a just-merged filing for minutes, so fetch main first. A failed
 *  fetch DEGRADES to the last fetched main and says so: the ledger's landed-filing receipts cover what
 *  this gardener itself filed since, and failing the whole pass (74 times on 2026-10-01/02, one
 *  `spawnSync git ETIMEDOUT` each) measured nothing and drafted nothing. */
export function readCiFrictionPlanState(repoRoot: string, git?: CiFrictionGit): CiFrictionPlanState {
  const options = { encoding: "utf8" as const, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
  const run: CiFrictionGit = git ?? ((args) => execFileSync("git", ["-C", repoRoot, ...args], options));
  let degraded: string | undefined;
  try {
    run(["fetch", "--quiet", "--no-write-fetch-head", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  } catch (e) {
    // Not an empty plan: the outcome is carried as `degraded`, ledgered, and the last fetched main is read.
    degraded = `fetch failed (${String((e as Error)?.message ?? e).split("\n")[0]}); read the last fetched origin/main`;
  }
  const shards = relative(repoRoot, join(resolveRepoLayout(repoRoot).planDir, "tasks.d"));
  const unreadable: string[] = [];
  const tasks = readCiFrictionPlanTasks(run, shards, "origin/main", (path, reason) => unreadable.push(`${path}: ${reason}`));
  return { tasks, ...(degraded ? { degraded } : {}), ...(unreadable.length > 0 ? { unreadable } : {}) };
}

/** Whether a job runs on the merge queue's group commit: its workflow declares `merge_group`, and a job
 *  `if:` that branches on `github.event_name` names it. An `if:` that never reads the event is not a filter. */
export function runsOnMergeGroup(on: unknown, jobIf: unknown): boolean {
  const events = typeof on === "string" ? [on]
    : Array.isArray(on) ? on.filter((event): event is string => typeof event === "string")
    : on && typeof on === "object" ? Object.keys(on) : [];
  if (!events.includes("merge_group")) return false;
  if (typeof jobIf !== "string" || !jobIf.includes("github.event_name")) return true;
  return /==\s*['"]merge_group['"]/.test(jobIf);
}

/** Why a check's declared workflow owner was not resolved, as a suffix for its escalation; undefined when it was not a gap. */
function workflowGap(search: OwnerSearch, key: string, details: readonly string[]): string | undefined {
  const family = key.startsWith("check:") ? ownerSearchTerms(key, details).at(-1) : undefined;
  const gap = family === undefined ? undefined : search.workflowGaps?.().find(entry => entry.family === family);
  return gap ? `; ${gap.reason}` : undefined;
}

/** GitHub's matrix expansion, as far as naming checks needs it: the product of each key's list, less
 *  `exclude`, plus `include` (extending each original combination it does not contradict, else a new one). */
export function expandWorkflowMatrix(matrix: unknown): Array<Record<string, unknown>> | string {
  if (matrix === undefined) return [{}];
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) return "matrix is not a literal mapping";
  const spec = matrix as Record<string, unknown>;
  const keys = Object.keys(spec).filter(key => key !== "include" && key !== "exclude");
  let rows: Array<Record<string, unknown>> = keys.length > 0 ? [{}] : [];
  for (const key of keys) {
    const values = spec[key];
    if (!Array.isArray(values)) return `matrix.${key} is not a literal list`;
    rows = rows.flatMap(row => values.map(value => ({ ...row, [key]: value })));
  }
  const entries = (field: "include" | "exclude"): Array<Record<string, unknown>> | string => {
    const list = spec[field] ?? [];
    return Array.isArray(list) && list.every(item => item && typeof item === "object" && !Array.isArray(item))
      ? list as Array<Record<string, unknown>> : `matrix.${field} is not a literal list of mappings`;
  };
  const exclude = entries("exclude");
  const include = entries("include");
  if (typeof exclude === "string") return exclude;
  if (typeof include === "string") return include;
  rows = rows.filter(row => !exclude.some(entry => Object.entries(entry).every(([key, value]) => row[key] === value)));
  const originals = rows.length;
  for (const entry of include) {
    let extended = false;
    for (const row of rows.slice(0, originals)) {
      if (Object.entries(entry).every(([key, value]) => !keys.includes(key) || row[key] === value)) {
        Object.assign(row, entry);
        extended = true;
      }
    }
    if (!extended) rows.push({ ...entry });
  }
  return rows;
}

/** The check names one job reports: its `name` rendered over each matrix combination, or why it cannot be. */
export function workflowJobCheckNames(name: string, matrix: unknown): string[] | string {
  if (!name.includes("${{")) return [name];
  const rows = expandWorkflowMatrix(matrix);
  if (typeof rows === "string") return rows;
  const names = new Set<string>();
  for (const row of rows) {
    let failure: string | undefined;
    const rendered = name.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression: string) => {
      const key = /^matrix\.([\w-]+)$/.exec(expression)?.[1];
      const value = key === undefined ? undefined : row[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
      failure ??= `\${{ ${expression} }} has no literal value`;
      return "";
    });
    if (failure !== undefined) return failure;
    names.add(rendered);
  }
  return names.size > 0 ? [...names] : "matrix expands to no combination";
}

/** Pin fetched main for literal source reads and declared workflow identities (W1-T6311).
 *  Missing paths are absence and failed git reads refuse the pass; a workflow shape it cannot name, or two
 *  owners it cannot tell apart, is a gap for that check alone ({@link OwnerSearch.workflowGaps}). */
export function gitCiFrictionOwnerSearch(git: CiFrictionGit, refName = "origin/main"): OwnerSearch {
  let revision: string | undefined;
  const pinned = (): string => {
    if (!revision) {
      const source = git(["rev-parse", "--verify", `${refName}^{commit}`]).trim();
      if (!/^[0-9a-f]{40}$/.test(source)) throw new Error(`ci-friction ownership: invalid revision for ${refName}`);
      revision = source;
    }
    return revision;
  };
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const workflowWitnesses = new Map<string, unknown>();
  const workflowGaps = new Map<string, string>();
  let workflowDocs: Array<{ file: string; document: ReturnType<typeof parseDocument> }> | undefined;
  const identity = (name: string) => kebabSlug(ciCheckFamily(name), 200);
  return {
    pin: () => gitCiFrictionOwnerSearch(git, refName),
    workflowGaps: () => [...workflowGaps].map(([family, reason]) => ({ family, reason })),
    workflowOwner: (family) => {
      const source = pinned();
      // The revision is pinned, so each workflow is read and parsed once per search, not once per check.
      workflowDocs ??= git(["ls-tree", "-r", "--name-only", source, "--", ".github/workflows"])
        .split("\n").filter(path => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)).sort()
        .map(file => ({ file, document: parseDocument(git(["show", `${source}:${file}`])) }));
      const matches: Array<{ file: string; jobId: string; witness: unknown; queued: boolean }> = [];
      // A workflow shape this reader cannot name is a gap for the checks it might own, never a failed pass:
      // `related` gaps are jobs whose unexpandable name could be this check; `unread` ones are whole files.
      const related: string[] = [];
      const unread: string[] = [];
      for (const { file, document } of workflowDocs) {
        if (document.errors.length > 0) {
          unread.push(`${file}: ${document.errors.map(error => error.message.split("\n")[0]).join("; ")}`);
          continue;
        }
        const workflow = document.toJS();
        if (!workflow || typeof workflow !== "object" || !workflow.jobs || typeof workflow.jobs !== "object" || Array.isArray(workflow.jobs)) {
          unread.push(`${file}: unsupported jobs input`);
          continue;
        }
        for (const [jobId, raw] of Object.entries(workflow.jobs)) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            unread.push(`${file}: unsupported job ${jobId}`);
            continue;
          }
          const job = raw as { name?: unknown; if?: unknown; uses?: unknown; strategy?: { matrix?: unknown } };
          const name = job.name === undefined ? jobId : job.name;
          if (typeof name !== "string") {
            unread.push(`${file}: unsupported name for ${jobId}`);
            continue;
          }
          const declared = workflowJobCheckNames(name, job.strategy?.matrix);
          if (typeof declared === "string") {
            const prefix = name.split("${{")[0]!.replace(/[ (/-]+$/, "");
            if (!prefix || identity(prefix) === identity(family) || identity(family).startsWith(`${identity(prefix)}-`) || identity(jobId) === identity(family))
              related.push(`${file}:${jobId}: ${declared}`);
            continue;
          }
          // A reusable-workflow caller (`uses:`) never reports its own name: its checks are `<name> / <called job>`.
          const caller = typeof job.uses === "string";
          if (!declared.some(check => caller ? family.toLowerCase().startsWith(`${check.toLowerCase()} / `) : identity(check) === identity(family))) continue;
          matches.push({ file, jobId, witness: { file, jobId, name, matrix: name.includes("${{") ? job.strategy?.matrix : undefined },
            queued: runsOnMergeGroup(workflow.on, job.if) });
        }
      }
      // Two jobs may report one check name: ci.yml's `ci-gate` produces the required context on every PR
      // push and on the merge queue's group commit, while ci-gate.yml's `ci-gate` only re-aggregates on a
      // body `edited` event. The producer the merge queue gates on owns the check; the others are re-run
      // variants of it. Throwing here instead (2026-10-09) failed every ci-friction inventory.
      const queued = matches.filter(match => match.queued);
      const owners = matches.length > 1 && queued.length === 1 ? queued : matches;
      const gap = related.length > 0 ? `workflow ownership unsupported for ${family} at ${source}: ${related.join(", ")}`
        : owners.length > 1 ? `workflow ownership ambiguous for ${family} at ${source}: ${owners.map(match => `${match.file}:${match.jobId}`).join(", ")}`
        : owners.length === 0 && unread.length > 0 ? `workflow ownership unreadable for ${family} at ${source}: ${unread.join(", ")}`
        : undefined;
      if (gap !== undefined) {
        workflowGaps.set(family, gap);
        return undefined;
      }
      const match = owners[0];
      if (!match) return undefined;
      const variants = matches.filter(other => other !== match).map(other => `${other.file}:${other.jobId}`);
      workflowWitnesses.set(`${identity(family)}:${match.file}`, match.witness);
      return { files: [match.file], why: [`${match.file}: declares job ${match.jobId} for ${family}`
        + (variants.length > 0 ? ` and runs it on merge_group (re-run variant not on the queue: ${variants.join(", ")})` : "")] };
    },
    evidence: (key, details, owner) => {
      const source = pinned();
      const family = key.startsWith("check:") ? ownerSearchTerms(key, details).at(-1) : undefined;
      const witnesses = (owner?.files ?? []).map(file => ({ file,
        witness: (family ? workflowWitnesses.get(`${identity(family)}:${file}`) : undefined) ?? git(["rev-parse", `${source}:${file}`]).trim() }));
      return { revision: source, fingerprint: digest({ key, witnesses }) };
    },
    filesContaining: (term) => {
      const source = pinned();
      let out = "";
      try {
        // -w: a term found only inside larger identifiers ("ci" in "decision") names no code path.
        out = git(["grep", "-c", "-F", "-w", "-e", term, source, "--", "src", "scripts"]);
      } catch (e) {
        // `git grep` exits 1 when nothing matches: no owner, which the ladder escalates.
        const failure = e as { status?: number; stderr?: unknown };
        if (failure.status !== 1 || String(failure.stderr ?? "").trim()) throw e;
      }
      return out.split("\n").flatMap((line) => {
        const m = /^[^:]+:(.+):(\d+)$/.exec(line.trim());
        if (!m) return [];
        const file = m[1]!;
        // A test file is evidence, never an owner — under a test/ directory or named *.test.*.
        if (/(?:^|\/)test\//.test(file) || /\.test\.[mc]?[jt]s$/.test(file)) return [];
        return [{ file, hits: Number(m[2]) }];
      });
    },
    fileExists: (file) => {
      const source = pinned();
      const listed = git(["ls-tree", "-r", "--name-only", source, "--", file]).split("\n");
      if (!listed.includes(file)) return false;
      git(["cat-file", "-e", `${source}:${file}`]);
      return true;
    },
  };
}

/** The origins the gardener itself escalated to a person — each holds its cause at that rung. */
export function escalatedCiFrictionOrigins(records: readonly LedgerRecord[]): string[] {
  return [...new Set(records.filter((r) => r.step === "ci-friction.remedy_escalated" && typeof r.origin === "string").map((r) => r.origin as string))];
}

/** A landed filing stays decided even when its price changes or the PR is closed. The scorecard
 * is written only after `land` returns a PR URL; a pass with no PR is not a decision. */
export function landedCiFrictionOrigins(records: readonly LedgerRecord[]): string[] {
  const origins = new Set<string>();
  for (const row of records) {
    if (row.step !== "ci-friction.scorecard" || typeof row.pr_url !== "string" || !PR_URL_RE.test(row.pr_url) ||
        typeof row.untracked !== "string" || !/^(check|main_merge|conflict|fix_refusal|hand_fix):.+$/.test(row.untracked)) continue;
    origins.add(`ci-friction:${row.untracked}`);
  }
  return [...origins];
}

/** The legacy remedies doc. Nothing reads it, so a record naming only it is rung 0 — never a remedy. */
export const CI_FRICTION_REMEDIES_FILE = CI_FRICTION_REMEDIES_DOC;
export const CI_FRICTION_GARDEN_LOG = "ci-friction-garden-log.md";
/** The trend log lives beside the gardener's own state: it needs no PR, so it cannot ride one. */
export function ciFrictionGardenLogPath(stateDir: string): string {
  return join(stateDir, CI_FRICTION_GARDEN_LOG);
}
const CI_FRICTION_SLUG_MAX = 72;

/** Everything a drafted remedy is rendered from. */
export interface CiFrictionDraft {
  price: CiFrictionCausePrice;
  rung: number;
  owner: CiFrictionOwner;
  rounds: readonly RemedyRound[];
  prior?: Extract<CiFrictionCauseState, { state: "draft" }>["prior"];
}

/** The title a drafted remedy's regression test must carry — task-scoped, and never containing " in ",
 *  which would split its `grep:` proof at the wrong place. */
export function ciFrictionRemedyTestTitle(taskId: string, key: string): string {
  return `${taskId}: ${key.replace(/ in /g, " within ")} is prevented, not retried`;
}

/** The slug a drafted shard's filename and its regression test share. Equal names are what make the
 *  test the shard's OWN falsifier to the sizing rule, so a remedy is one owner file plus its test. */
export function ciFrictionShardStem(key: string): string {
  return kebabSlug(key, CI_FRICTION_SLUG_MAX).replace(/-+$/, "");
}

/** Render ONE draft as a single-element YAML task list — the shard file's whole contents. It names the
 *  code that owns the cause and a regression test, never the remedies doc. */
export function ciFrictionShardYaml(draft: CiFrictionDraft, taskId: string, priced: readonly CiFrictionCausePrice[] = [draft.price]): string {
  const { price, rung, owner } = draft;
  const key = ciFrictionCauseKey(price.cause);
  const origin = ciFrictionRungOrigin(key, rung);
  const testPath = `test/${ciFrictionShardStem(key)}.test.ts`;
  // The shared machine-filing path (operator ruling 2026-09-29): the header, verify and risk are its.
  return renderMachineShard({
    taskId,
    title: `THE CI FRICTION GARDENER'S COSTLIEST OPEN CAUSE — ${key} cost ${price.minutes} PR minute(s) across ${price.rounds} round(s) on ${price.prs} pull request(s)${rung > 1 ? `, and rung ${rung - 1}'s remedy did not move it` : ""}`,
    origin,
    // One owner file: the most implicated. The rationale names every candidate the search found.
    files: [owner.files[0]!, testPath],
    cost: price.minutes,
    costPopulation: priced.map((p) => p.minutes),
    acceptance: [
      // A forward reference: the build writes this test, so the proof greps for its declaration.
      { claim: `the harness no longer spends a fix round on ${key}`, proof: `grep: test("${ciFrictionRemedyTestTitle(taskId, key)}" in ${testPath}` },
    ],
    note: `Filed by the ci-friction gardener (W1-T4435) at rung ${rung}. MACHINE-AUTHORED — the machine-filing judge releases it or escalates it to a person. After its build merges, the gardener measures ${key}'s share of all fix rounds in equal windows before and after; a share that does not fall reopens the cause at rung ${rung + 1}.`,
    rationale: ciFrictionRemedyRationale({
      key,
      minutes: price.minutes,
      rounds: price.rounds,
      prs: price.prs,
      owner,
      evidence: ciFrictionEvidence(draft.rounds, key),
      prior: draft.prior,
    }),
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

export interface CiFrictionOwnershipReconsideration {
  origin: string;
  oldRefusal: string;
  evidence: CiFrictionOwnershipEvidence;
  owner: CiFrictionOwner;
  decision: "draft";
}

/** One cause the pass acts on: drafted at a rung against its owner, or escalated to a person. */
export interface CiFrictionGardenAction extends GardenAction<CiFrictionGardenClass> {
  price: CiFrictionCausePrice;
  origin: string;
  rung: number;
  /** Where the cause stands — a `draft` carries its owner, an `escalate` its reason. */
  decision: { kind: "draft"; owner: CiFrictionOwner; prior?: CiFrictionDraft["prior"]; reconsideration?: CiFrictionOwnershipReconsideration } | { kind: "escalate"; why: string; prior?: CiFrictionDraft["prior"]; holdReason?: "no-owner" | "ladder-exhausted"; evidence?: CiFrictionOwnershipEvidence };
  /** Every cause priced in the pass, which ranks this one's dispatch priority. */
  priced?: CiFrictionCausePrice[];
}

/** Where one priced cause stands, for the scorecard: the ladder is visible on every pass. */
export interface CiFrictionCauseLine {
  cause: string;
  minutes: number;
  state: CiFrictionCauseState["state"] | "delegated" | "escalated";
  rung?: number;
  task?: string;
  effect?: string;
}

export interface CiFrictionInventory {
  priced: CiFrictionCausePrice[];
  preventionSources?: { registrations: import("./prevention-source-evidence.js").PreventionSourceRegistration[]; unavailable: number };
  /** The cause this pass would act on, if any. */
  next?: { price: CiFrictionCausePrice; origin: string; rung: number; decision: CiFrictionGardenAction["decision"] };
  /** Where each of the costliest causes stands. */
  ladder: CiFrictionCauseLine[];
  rounds: CiFrictionRound[];
  degraded?: string;
  handFixState?: { state: "observed" | "unmeasured"; count: number };
  /** Legacy field kept for the overseer's filing receipts: the cause (and rung) this pass acts on. */
  untracked?: CiFrictionCausePrice;
  /** Checks whose declared workflow owner could not be resolved, and why; each resolved to no owner. */
  workflowGaps?: Array<{ family: string; reason: string }>;
}

export interface CiFrictionGardenSources {
  /** The ledger union's own records — read once per pass, never parsed twice for one tick. */
  ledgerRecords: () => readonly LedgerRecord[];
  handFixes?: () => CiFrictionHandFixRead;
  gateFireRates?: () => GateFireRateReport | undefined;
  /** Every ci-friction task on fetched main, with when its build merged ({@link readCiFrictionPlanState}). */
  planState: () => CiFrictionPlanState;
  /** Finds the code a cause's rounds name ({@link locateCiFrictionOwner}). */
  ownerSearch: OwnerSearch;
  /** THE RESERVATION PATH (task-id-reservation.ts via `ciLearningTaskIdMinter`, run-task.ts),
   *  never `max(id)+1` — see that minter's own doc for why. */
  mintTaskId: (filingBranch?: string) => string;
}

/** How many of the costliest causes the ladder reports and the pass considers. */
const LADDER_DEPTH = 8;

/** Rounds in the shape the remedy module reads. */
export function remedyRoundsOf(rounds: readonly CiFrictionRound[]): RemedyRound[] {
  return rounds.map((r) => ({ pr: r.pr, causeKey: ciFrictionCauseKey(r.cause), ...(r.at ? { at: r.at } : {}), ...(r.detail ? { detail: r.detail } : {}) }));
}

/**
 * Walk the costliest causes in price order and decide each one's place on the ladder. A merge conflict
 * is the hot-file gardener's (W1-T4803) and is never drafted here. The first cause that needs a draft or
 * a person is the pass's `next`; a draft whose owner cannot be located goes to a person rather than
 * becoming a docs record.
 */
export function ciFrictionLadder(input: {
  priced: readonly CiFrictionCausePrice[];
  rounds: readonly CiFrictionRound[];
  tasks: readonly CiFrictionRemedyTask[];
  receipts: ReadonlySet<string>;
  escalated: ReadonlySet<string>;
  holds?: readonly LedgerRecord[];
  ownerSearch: OwnerSearch;
  nowMs: number;
}): Pick<CiFrictionInventory, "next" | "ladder"> {
  const remedyRounds = remedyRoundsOf(input.rounds);
  const ladder: CiFrictionCauseLine[] = [];
  let next: CiFrictionInventory["next"];
  for (const price of input.priced.slice(0, LADDER_DEPTH)) {
    const key = ciFrictionCauseKey(price.cause);
    const line: CiFrictionCauseLine = { cause: key, minutes: price.minutes, state: "draft" };
    ladder.push(line);
    if (price.cause.kind === "conflict") {
      line.state = "delegated";
      continue;
    }
    const s = ciFrictionCauseState(key, input.tasks, remedyRounds, input.nowMs, input.receipts);
    line.state = s.state;
    if ("task" in s) line.task = s.task.id;
    if ("effect" in s) line.effect = s.effect.reason;
    if (s.state !== "draft" && s.state !== "escalate") continue;
    line.rung = s.rung;
    if (s.prior?.effect) line.effect = s.prior.effect.reason;
    const origin = ciFrictionRungOrigin(key, s.rung);
    const held = input.escalated.has(origin);
    if (held) line.state = "escalated";
    const hold = input.holds?.filter(row => row.step === "ci-friction.remedy_escalated" && row.origin === origin).at(-1);
    const legacyRefusal = `no code in src/ or scripts/ names ${key}, so no remedy can be drafted against it`;
    const noOwnerHold = hold && (hold.hold_reason === "no-owner" || (hold.hold_reason === undefined && hold.why === legacyRefusal));
    if (held && (s.state !== "draft" || !noOwnerHold)) {
      line.state = "escalated";
      continue;
    }
    if (next) continue;
    if (s.state === "escalate") {
      next = { price, origin, rung: s.rung, decision: { kind: "escalate", why: `${s.rung - 1} remedy rung(s) did not move ${key}`, prior: s.prior, holdReason: "ladder-exhausted" } };
      continue;
    }
    const details = remedyRounds.filter((r) => r.causeKey === key && r.detail).map((r) => r.detail!);
    const owner = locateCiFrictionOwner(key, details, input.ownerSearch);
    const evidence = input.ownerSearch.evidence?.(key, details, owner);
    let reconsideration: CiFrictionOwnershipReconsideration | undefined;
    if (held) {
      line.state = "escalated";
      const previous = hold?.ownership_evidence as CiFrictionOwnershipEvidence | undefined;
      const consumed = input.holds?.some(row => row.step === "ci-friction.scorecard" &&
        Array.isArray(row.ownership_reconsiderations) && row.ownership_reconsiderations.some(item =>
          item?.origin === origin && item?.evidence?.fingerprint === evidence?.fingerprint));
      if (!owner || !evidence || consumed || previous?.fingerprint === evidence.fingerprint || typeof hold?.why !== "string") continue;
      reconsideration = { origin, oldRefusal: hold.why, evidence, owner, decision: "draft" };
      line.state = "draft";
    }
    next = owner
      ? { price, origin, rung: s.rung, decision: { kind: "draft", owner, prior: s.prior, ...(reconsideration ? { reconsideration } : {}) } }
      : { price, origin, rung: s.rung, decision: { kind: "escalate", why: legacyRefusal + (input.ownerSearch.workflowOwner ? "; no declared workflow job resolves it" : "")
        + (workflowGap(input.ownerSearch, key, details) ?? ""), prior: s.prior, holdReason: "no-owner", evidence } };
    if (!owner) line.state = "escalate";
  }
  return { next, ladder };
}

function draftCandidates(inv: CiFrictionInventory): CiFrictionGardenAction[] {
  const n = inv.next;
  if (!n) return [];
  const key = ciFrictionCauseKey(n.price.cause);
  return [
    {
      class: "draft",
      target: n.origin,
      origin: n.origin,
      price: n.price,
      rung: n.rung,
      decision: n.decision,
      priced: inv.priced,
      reason: n.decision.kind === "draft"
        ? `${key} cost ${n.price.minutes} PR minute(s) across ${n.price.rounds} round(s) on ${n.price.prs} pull request(s) — drafted at rung ${n.rung} against ${n.decision.owner.files.join(", ")}.`
        : `${key} cost ${n.price.minutes} PR minute(s) — ${n.decision.why}; a person decides.`,
    },
  ];
}

/** The escalation a cause gets when the ladder runs out or its owner cannot be found. */
export function ciFrictionEscalation(action: CiFrictionGardenAction): Escalation {
  const key = ciFrictionCauseKey(action.price.cause);
  const why = action.decision.kind === "escalate" ? action.decision.why : "";
  const prior = action.decision.prior;
  return {
    class: "BLOCKED",
    taskId: `ci-friction-${kebabSlug(key, 60)}`,
    summary: `CI friction: ${key} keeps costing fix rounds and the gardener cannot remedy it alone`,
    detail: [
      `${key} cost ${action.price.minutes} PR minute(s) across ${action.price.rounds} round(s) on ${action.price.prs} pull request(s) (seven-day half-life).`,
      `Why this needs a person: ${why}.`,
      ...(prior ? [`The last rung was ${prior.task.id}${prior.effect ? `: ${prior.effect.reason}` : ""}.`] : []),
    ].join("\n\n"),
    options: [
      { label: "design-remedy", detail: "name the mechanism and file it as a task; the gardener measures it like any rung" },
      { label: "accept-cost", detail: `retire the cause: add a task with origin ${action.origin} and a retirement field` },
    ],
    recommendation: "design-remedy",
    headDedup: "independent",
  };
}

/** The repo's own CI friction as a gardener spec (gardener.ts, W1-T4110). */
export function ciFrictionGardenSpec(deps: GardenerDeps, sources: CiFrictionGardenSources): GardenSpec<CiFrictionGardenClass, CiFrictionInventory, CiFrictionGardenAction, GardenCheckout> {
  const clock: Clock = deps.clock ?? systemClock;
  return {
    name: "ci-friction",
    classes: CI_FRICTION_GARDEN_CLASSES,
    review: { draft: "filing a new task from priced friction is a judgement call — the machine-filing judge or a person decides the remedy." },
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
      const records = sources.ledgerRecords();
      const plan = sources.planState();
      const ownerSearch = sources.ownerSearch.pin?.() ?? sources.ownerSearch;
      const ledgerRounds = ciFrictionRoundsFromLedger(records);
      const hand = sources.handFixes?.();
      if (hand?.state === "unmeasured") deps.log("ci-friction.hand_fixes_unmeasured", { reason: hand.reason });
      const rounds = [...ledgerRounds, ...ciFrictionHandFixRounds(hand?.fixes ?? [], ledgerRounds,
        priceCiFrictionCauses(ledgerRounds, sources.gateFireRates?.(), clock.now()), ownerSearch)];
      const priced = priceCiFrictionCauses(rounds, sources.gateFireRates?.(), clock.now());
      if (plan.degraded) deps.log("ci-friction.origins_degraded", { reason: plan.degraded });
      if (plan.unreadable) deps.log("ci-friction.plan_shard_unreadable", { shards: plan.unreadable });
      const { next, ladder } = ciFrictionLadder({
        priced,
        rounds,
        tasks: plan.tasks,
        receipts: new Set(landedCiFrictionOrigins(records)),
        escalated: new Set(escalatedCiFrictionOrigins(records)),
        holds: records,
        ownerSearch,
        nowMs: clock.now(),
      });
      const workflowGaps = ownerSearch.workflowGaps?.() ?? [];
      if (workflowGaps.length > 0) deps.log("ci-friction.workflow_ownership_unresolved", { gaps: workflowGaps });
      const registrations = plan.tasks.flatMap((task) => task.preventionSource && !("state" in task.preventionSource) ? [task.preventionSource] : []).slice(0, 32);
      const preventionSources = { registrations, unavailable: plan.tasks.length - registrations.length };
      return { priced, rounds, ladder, preventionSources, ...(workflowGaps.length > 0 ? { workflowGaps } : {}), ...(hand ? { handFixState: { state: hand.state, count: hand.fixes.length } } : {}), ...(next ? { next, untracked: next.price } : {}), ...(plan.degraded ? { degraded: plan.degraded } : {}) };
    },
    // The ladder decides whether work remains — never a recorded fingerprint alone, which a pass that
    // drew no action or failed to land could have left behind.
    unfinished: (inv) => inv.next !== undefined,
    fingerprint: (inv) => `${inv.priced.map((p) => `${ciFrictionCauseKey(p.cause)}:${p.minutes}`).join(",")}|${inv.next ? inv.next.origin : ""}`,
    candidates: (inv) => draftCandidates(inv),
    scorecard: (inv, plan) => {
      appendCiFrictionTrendRow(ciFrictionGardenLogPath(deps.stateDir), clock.iso(), inv.priced);
      return {
        ownership_reconsiderations: plan.actions.flatMap(action => action.decision.kind === "draft" && action.decision.reconsideration ? [action.decision.reconsideration] : []),
        prevention_sources: inv.preventionSources?.registrations ?? [],
        prevention_source_unavailable: inv.preventionSources?.unavailable ?? null,
        prevention_source_scope: "owning-file-build-not-runtime-or-efficacy",
        causes: inv.priced.length,
        total_minutes: Math.round(inv.priced.reduce((s, p) => s + p.minutes, 0) * 10) / 10,
        // The receipt key: the cause and, above rung 1, its rung — `landedCiFrictionOrigins` reads it back.
        untracked: inv.next ? inv.next.origin.slice("ci-friction:".length) : null,
        next: inv.next ? { origin: inv.next.origin, rung: inv.next.rung, decision: inv.next.decision.kind } : null,
        ladder: inv.ladder,
        hand_fixes: inv.handFixState ?? { state: "unmeasured", count: null },
        priced: inv.priced,
        ...(inv.workflowGaps ? { workflow_ownership_unresolved: inv.workflowGaps } : {}),
        ...(inv.degraded ? { degraded: inv.degraded } : {}),
      };
    },
    apply: (ws, plan) => {
      const action = plan.actions[0];
      if (!action) return undefined;
      if (action.decision.kind === "escalate") {
        // No PR: the receipt row holds the cause at this rung so the next pass moves on to the next one.
        const issue = deps.escalate ? deps.escalate(ciFrictionEscalation(action)) : undefined;
        deps.log("ci-friction.remedy_escalated", { origin: action.origin, rung: action.rung, why: action.decision.why,
          hold_reason: action.decision.holdReason, ownership_evidence: action.decision.evidence, issue_url: issue ?? null });
        return undefined;
      }
      if (!ws.branch) throw new Error("ci-friction gardener: filing workspace has no branch for task-id reservation");
      const taskId = sources.mintTaskId(ws.branch);
      const records = sources.ledgerRecords();
      const contents = ciFrictionShardYaml(
        { price: action.price, rung: action.rung, owner: action.decision.owner, rounds: remedyRoundsOf([
          ...ciFrictionRoundsFromLedger(records), ...ciFrictionHandFixRounds(sources.handFixes?.().fixes ?? [], ciFrictionRoundsFromLedger(records),
            action.priced ?? [], sources.ownerSearch),
        ]), prior: action.decision.prior },
        taskId,
        action.priced,
      );
      const verdict = ciFrictionRecordVerdict(contents, `ci-friction:${taskId}`);
      if (!verdict.ok) throw new Error(`ci-friction gardener: drafted record failed lint (${verdict.reason})`);
      const stem = ciFrictionShardStem(ciFrictionCauseKey(action.price.cause));
      const shardDir = join(resolveRepoLayout(ws.root).planDir, "tasks.d");
      const shardPath = join(shardDir, `${taskId}${stem ? `-${stem}` : ""}.yaml`);
      const relPath = relative(ws.root, shardPath);
      mkdirSync(shardDir, { recursive: true });
      writeFileSync(shardPath, contents);

      const body = [
        "The ci-friction gardener (W1-T4435) prices CI-round causes in PR minutes, ranked by minutes lost — never fire count.",
        "",
        `- **draft** \`${action.target}\` (rung ${action.rung}): ${action.reason}`,
        "",
        `The record names the code that owns the cause and a regression test; its build is measured by the cause's share of fix rounds before and after, and reopens one rung up if the share does not fall.`,
        "",
        "## Acceptance",
        `- claim: the costliest open cause is filed as a parked task`,
        `  proof: grep: ${action.origin} in ${relPath}`,
      ].join("\n");
      // PLAN-ONLY: the shard alone, so Standing rule 15's filing exemption applies.
      return { paths: [relPath], title: `chore(plan): the ci-friction gardener drafts a fix for ${action.target}`, body };
    },
  };
}

// ── Replay: the ladder over a past window ──────────────────────────────────────────────────

/** Each ci-friction task with when its shard reached `refName` and, if retired, when. */
export function readCiFrictionPlanTimeline(git: CiFrictionGit, shardsDir: string, refName = "origin/main"): Array<CiFrictionRemedyTask & { filedAt: string; retiredAt?: string }> {
  const tasks = readCiFrictionPlanTasks(git, shardsDir, refName);
  const added = pathTimesFromLog(git(["log", refName, CI_FRICTION_HISTORY_SINCE, "--diff-filter=A", "--format=%x01%cI", "--name-only", "--", shardsDir]), "oldest");
  const retired = tasks.some((t) => t.retired)
    ? pathTimesFromLog(git(["log", refName, CI_FRICTION_HISTORY_SINCE, "-S", "retirement:", "--format=%x01%cI", "--name-only", "--", shardsDir]), "newest")
    : new Map<string, string>();
  return tasks.map((task) => {
    // A shard older than the walk existed throughout the window.
    const filedAt = (task.path && added.get(task.path)) || "1970-01-01T00:00:00.000Z";
    const retiredAt = task.retired && task.path ? retired.get(task.path) : undefined;
    return { ...task, filedAt, ...(retiredAt ? { retiredAt } : {}) };
  });
}

/** One replayed instant, flattened for a report line. */
export interface CiFrictionReplayLine extends ReplayStep {
  /** Where the next draft would point, located against today's tree (an approximation for the past). */
  owner?: string[];
}

/** Replay the ladder at `stepMs` intervals over `[fromMs, toMs]` from the whole ledger union. */
export function replayCiFriction(input: {
  records: readonly LedgerRecord[];
  tasks: ReadonlyArray<CiFrictionRemedyTask & { filedAt: string; retiredAt?: string }>;
  fromMs: number;
  toMs: number;
  stepMs: number;
  ownerSearch?: OwnerSearch;
}): CiFrictionReplayLine[] {
  const rounds = ciFrictionRoundsFromLedger(input.records);
  const remedyRounds = remedyRoundsOf(rounds);
  const steps = replayCiFrictionLadder({
    fromMs: input.fromMs,
    toMs: input.toMs,
    stepMs: input.stepMs,
    rounds: remedyRounds,
    // Conflicts are the hot-file gardener's, exactly as the live ladder skips them.
    price: (_visible, nowMs) => priceCiFrictionCauses(rounds.filter((r) => r.at !== undefined && Date.parse(r.at) <= nowMs), undefined, nowMs)
      .filter((p) => p.cause.kind !== "conflict")
      .map((p) => ({ key: ciFrictionCauseKey(p.cause), minutes: p.minutes })),
    tasks: input.tasks,
  });
  return steps.map((step) => {
    if (!step.next || step.next.state !== "draft" || !input.ownerSearch) return step;
    const key = step.next.key;
    const details = remedyRounds.filter((r) => r.causeKey === key && r.detail && r.at !== undefined && r.at <= step.at).map((r) => r.detail!);
    const owner = locateCiFrictionOwner(key, details, input.ownerSearch);
    return { ...step, owner: owner?.files ?? [] };
  });
}

/** Render a replay as the plain-text report `rmd garden replay ci-friction` prints. */
export function renderCiFrictionReplay(lines: readonly CiFrictionReplayLine[]): string {
  const out: string[] = [];
  const drafted = new Map<string, string>();
  for (const line of lines) {
    const next = line.next
      ? `${line.next.state} ${line.next.key} (rung ${line.next.rung})${line.owner ? ` → ${line.owner.length > 0 ? line.owner.join(", ") : "no owner: a person"}` : ""}`
      : "nothing to draft";
    out.push(`${line.at.slice(0, 16)}Z  ${next}`);
    for (const c of line.causes.slice(0, 5)) out.push(`    ${String(c.minutes).padStart(8)}m  ${c.state.padEnd(11)} ${c.key}${c.rung ? ` r${c.rung}` : ""}${c.verdict ? ` [${c.verdict}]` : ""}`);
    if (line.next && !drafted.has(`${line.next.key}#${line.next.rung}`)) drafted.set(`${line.next.key}#${line.next.rung}`, line.at);
  }
  out.push("", `Distinct actions the ladder would have taken: ${drafted.size}`);
  for (const [k, at] of drafted) out.push(`  ${at.slice(0, 16)}Z  ${k}`);
  return out.join("\n");
}
