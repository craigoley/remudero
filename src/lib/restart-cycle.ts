import { fixedClock } from "./clock.js";

type Row = Readonly<Record<string, unknown>>;
type TimedRow = { row: Row; ms: number };
type AbandonedWork = Row & { age_ms: number | null };

export interface RestartCycleRow {
  first_material_change_at: string | null;
  decided_at: string | null;
  exit_at: string;
  started_at: string;
  first_verdict_at: string | null;
  trigger: unknown;
  old_sha: unknown;
  new_sha: unknown;
  phases_ms: unknown;
  reviews_not_started: number;
  reviews_refused_after_finish: number;
  refused_review_ms: number | null;
  admissions_held: number;
  gave_up: { reviews: AbandonedWork[] | null; fix_rounds: AbandonedWork[] | null };
  gave_up_age_ms: number | null;
  verdicts_posted: number;
  verdict_gap_ms: number | null;
  review_wait_ms: number | null;
  waiting_cost_ms: number | null;
  restart_cost_ms: number | null;
  missing_parts: string[];
}

const time = (row: Row): number => typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const iso = (ms: number | undefined): string | null => ms === undefined ? null : fixedClock(ms).iso();
const sum = (parts: readonly (number | null)[]): number | null =>
  parts.some(part => part === null) ? null : parts.reduce<number>((total, part) => total + part!, 0);

function prKey(row: Row): string | undefined {
  if (typeof row.pr_url === "string") return /\/pull\/(\d+)$/.exec(row.pr_url)?.[1];
  const pr = row.pr ?? row.pr_number;
  if (typeof pr === "number") return String(pr);
  return typeof pr === "string" ? /\/pull\/(\d+)$/.exec(pr)?.[1] ?? (/^[0-9]+$/.test(pr) ? pr : undefined) : undefined;
}

export function restartCycleLedgerRows(lines: readonly string[]): { rows: Row[]; errors: string[] } {
  const rows: Row[] = [], errors: string[] = [];
  for (const raw of lines) {
    try {
      const row: unknown = JSON.parse(raw);
      if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row as Row);
      else errors.push("ledger row is not an object");
    } catch (error) {
      const reason = `ledger row parse failed: ${String(error)}`;
      errors.push(reason);
    }
  }
  return { rows, errors };
}

/** Join one freshness exit to the following lifetime; a later boot closes an unfinished cycle. */
export function restartCycleRow(rows: readonly Row[], startAtMs: number): RestartCycleRow | null {
  const ordered: TimedRow[] = rows.map(row => ({ row, ms: time(row) })).filter(r => Number.isFinite(r.ms)).sort((a, b) => a.ms - b.ms);
  const priorBoot = ordered.findLast(r => r.row.step === "daemon.boot" && r.ms < startAtMs);
  const before = ordered.filter(r => r.ms < startAtMs && (priorBoot === undefined || r.ms >= priorBoot.ms));
  const end = before.findLast(r => ["daemon.freshness_exit", "daemon.memory_exit", "daemon.signal_exit", "daemon.stop"].includes(String(r.row.step)));
  if (end?.row.step !== "daemon.freshness_exit") return null;
  const exit = end;
  const decisions = before.filter(r => r.row.step === "daemon.freshness_decision" && r.ms <= exit.ms);
  const decision = decisions.find(r => r.row.action === "restart");
  const marker = before.findLast(r => r.row.step === "daemon_selfrestart_for_freshness" && r.ms >= exit.ms);
  const materialTimes = [...decisions, ...(marker ? [marker] : [])].map(r => r.row.stale_since_ms).filter(finite);
  const materialMs = materialTimes.length ? Math.min(...materialTimes) : undefined;
  const nextBoot = ordered.find(r => r.row.step === "daemon.boot" && r.ms > startAtMs);
  const first = ordered.find(r => r.row.step === "review.posted" && r.ms > startAtMs && (!nextBoot || r.ms < nextBoot.ms));
  const windowStart = materialMs ?? priorBoot?.ms ?? decision?.ms ?? exit.ms;
  const windowEnd = first?.ms ?? nextBoot?.ms ?? startAtMs;
  const window = ordered.filter(r => r.ms >= windowStart && r.ms <= windowEnd && (!nextBoot || r.ms < nextBoot.ms));
  const stops = window.filter(r => r.row.step === "review.skipped_stale_reviewer_code" ||
    r.row.step === "review.post_refused" && r.row.reviewer_code_freshness === "stale");
  const refused = stops.filter(r => r.row.step === "review.post_refused");
  const refusedMs = sum(refused.map(refusal => {
    const calls = ordered.filter(r => r.row.step === "review.reviewer" && typeof refusal.row.run_id === "string" &&
      r.row.run_id === refusal.row.run_id && r.ms <= refusal.ms);
    return calls.length ? sum(calls.map(r => finite(r.row.worker_duration_ms) ? r.row.worker_duration_ms : null)) : null;
  }));
  const waits = new Map<string, number | null>();
  for (const stopped of stops) {
    const key = prKey(stopped.row);
    if (key === undefined) { waits.set(`unknown:${stopped.ms}`, null); continue; }
    if (waits.has(key)) continue;
    const verdict = ordered.find(r => r.row.step === "review.posted" && r.ms > stopped.ms && prKey(r.row) === key);
    waits.set(key, verdict ? verdict.ms - stopped.ms : null);
  }
  const waitMs = sum([...waits.values()]);
  const drain = before.findLast(r => r.row.step === "daemon.freshness_drain.completed" && r.ms <= exit.ms);
  const inventory = Array.isArray(drain?.row.waited_on) ? drain.row.waited_on.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === "object") : undefined;
  const abandoned = inventory?.filter(item => item.abandoned === true).map((item): AbandonedWork => ({ ...item,
    age_ms: finite(item.admitted_at_ms) && item.admitted_at_ms <= drain!.ms ? drain!.ms - item.admitted_at_ms : null }));
  const reviews = abandoned?.filter(item => item.what === "review") ?? null;
  const fixes = abandoned?.filter(item => item.what === "detached" && item.kind === "fix-dispatch") ?? null;
  const gaveUpMs = reviews && fixes ? sum([...reviews, ...fixes].map(item => item.age_ms)) : null;
  const last = ordered.findLast(r => r.row.step === "review.posted" && r.ms < exit.ms);
  const gapMs = last && first ? first.ms - last.ms : null;
  const missing: string[] = [];
  for (const [name, value] of Object.entries({ first_material_change_at: materialMs, decided_at: decision?.ms,
    first_verdict_at: first?.ms, refused_review_ms: refusedMs, review_wait_ms: waitMs, gave_up_age_ms: gaveUpMs, verdict_gap_ms: gapMs })) {
    if (value === null || value === undefined) missing.push(name);
  }
  return {
    first_material_change_at: iso(materialMs), decided_at: iso(decision?.ms), exit_at: iso(exit.ms)!, started_at: iso(startAtMs)!,
    first_verdict_at: iso(first?.ms), trigger: decision?.row.reason ?? (exit.row.restart_request as Row | undefined)?.origin ?? null,
    old_sha: marker?.row.old_sha ?? decision?.row.old_sha ?? null, new_sha: marker?.row.new_sha ?? decision?.row.new_sha ?? null,
    phases_ms: exit.row.phases_ms ?? null,
    reviews_not_started: stops.length - refused.length, reviews_refused_after_finish: refused.length, refused_review_ms: refusedMs,
    admissions_held: window.filter(r => r.row.step === "daemon.admission_held" &&
      (r.row.reason === "restart latched" || r.row.reason === "restart decided")).length,
    gave_up: { reviews, fix_rounds: fixes }, gave_up_age_ms: gaveUpMs,
    verdicts_posted: window.filter(r => r.row.step === "review.posted").length, verdict_gap_ms: gapMs, review_wait_ms: waitMs,
    waiting_cost_ms: sum([refusedMs, waitMs]), restart_cost_ms: sum([gapMs, gaveUpMs]), missing_parts: missing,
  };
}
