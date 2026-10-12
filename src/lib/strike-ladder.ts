import { utcDayOf, type SloRungTaken } from "./pr-blocker.js";

export interface StrikeLadderInput {
  lastAttemptAt: string | null | undefined;
  mainTip?: { sha: string; committedAt: string };
  currentMergeBaseSha?: string;
  rebuildsSoFar?: number;
  requeueable?: boolean;
  refreshedAtMainTip?: boolean;
}

export interface StrikeLadderDecision {
  rung: "refresh" | "rebuild" | "digest" | "hold";
  reason: string;
}

export function decideStrikeLadderRung(input: StrikeLadderInput): StrikeLadderDecision {
  const hold = (reason: string): StrikeLadderDecision => ({ rung: "hold", reason: `strike ladder hold: ${reason}` });
  if (input.mainTip === undefined) return hold("main tip unavailable");
  if (!input.mainTip.sha) return hold("main tip sha unreadable");
  if (!Number.isFinite(Date.parse(input.mainTip.committedAt))) return hold("main tip commit time unreadable");
  if (!input.currentMergeBaseSha) return hold("merge base unreadable");
  if (input.lastAttemptAt === undefined || (input.lastAttemptAt !== null && !Number.isFinite(Date.parse(input.lastAttemptAt)))) return hold("last attempt unreadable");
  if (!Number.isInteger(input.rebuildsSoFar) || input.rebuildsSoFar! < 0) return hold("rebuild notes unreadable");
  if (input.requeueable === undefined || input.refreshedAtMainTip === undefined) return hold("ownership or refresh history unreadable");
  if (input.lastAttemptAt !== null && Date.parse(input.mainTip.committedAt) > Date.parse(input.lastAttemptAt) &&
      input.currentMergeBaseSha !== input.mainTip.sha && !input.refreshedAtMainTip) {
    return { rung: "refresh", reason: "strike ladder refresh: main moved since the last attempt; one CI run, no strike spent" };
  }
  if (input.requeueable && input.rebuildsSoFar! < 2) {
    return { rung: "rebuild", reason: `strike ladder rebuild ${input.rebuildsSoFar! + 1}/2: close and requeue with a failure digest` };
  }
  return { rung: "digest", reason: "strike ladder digest: rebuild budget spent or PR cannot be requeued" };
}

interface CausePr {
  checksState: string;
  redRequiredChecks?: readonly string[];
  ciFailures?: readonly { name: string; logTail: string }[];
  unmetCriteria: readonly { reason: string }[];
}

const REVIEW_CAUSE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["not-executed", /not[- ]executed|never executed|no proofs? executed/i],
  ["non-discriminating", /non[- ]discriminating/i],
  ["keyword-floor", /keyword[- _]floor|keyword[- _]only/i],
  ["non-responsive", /non[- ]responsive/i],
];

export function firstFailingTestTitle(log: string): string | undefined {
  return /^\s*(?:#\s*)?not ok \d+\s*-\s*(.+)$/m.exec(log)?.[1]?.trim();
}

export function strikeCauseKey(pr: CausePr, failingTestFiles: readonly string[] = []): string {
  let key: string;
  if (pr.checksState === "red" || (pr.redRequiredChecks?.length ?? 0) > 0) {
    const name = pr.redRequiredChecks?.[0] ?? pr.ciFailures?.[0]?.name ?? "required";
    const failure = pr.ciFailures?.find(f => f.name === name);
    const check = name.replace(/\s*\(\d+\/\d+\)\s*$/, "");
    const title = failure ? firstFailingTestTitle(failure.logTail) : undefined;
    const suffix = title ?? failingTestFiles[0];
    key = `check:${check}${suffix ? `#${suffix}` : ""}`;
  } else {
    const text = pr.unmetCriteria.map(c => c.reason).join("\n");
    key = `review:${REVIEW_CAUSE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "unmet"}`;
  }
  return key.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
}

export function latestStrikeLadderAttempt(
  rows: readonly Record<string, unknown>[], taskId: string | undefined, prNumber: number,
): string | null | undefined {
  const attempts = rows.filter(r =>
    (r.step === "fix.dispatch" && taskId !== undefined && r.task_id === taskId) ||
    (r.step === "sweep.strike_ladder.refreshed" && r.pr_number === prNumber));
  if (attempts.some(r => typeof r.ts !== "string" || !Number.isFinite(Date.parse(r.ts)))) return undefined;
  return attempts.reduce<string | null>((latest, r) => latest === null || Date.parse(r.ts as string) > Date.parse(latest) ? r.ts as string : latest, null);
}

export function hasUnspentLadderRefresh(
  rows: readonly Record<string, unknown>[], taskId: string | undefined, prNumber: number,
): boolean {
  const refreshes = rows.filter(r => r.step === "sweep.strike_ladder.refreshed" && r.pr_number === prNumber);
  if (refreshes.length === 0) return false;
  const latest = latestStrikeLadderAttempt(rows, undefined, prNumber);
  return latest === undefined || !rows.some(r => r.step === "fix.dispatch" && r.task_id === taskId &&
    typeof r.ts === "string" && Date.parse(r.ts) > Date.parse(latest!));
}

export function capStrikeLadderNote(note: string): string {
  const suffix = "\n[truncated at 2,000 characters]";
  return note.length <= 2000 ? note : note.slice(0, 2000 - suffix.length) + suffix;
}

/** W1-T5690 — the ledger's rung rows for one PR/task as the SLO reads them. Refresh is "at this
 *  head" by main tip (a refresh moves the head), the others by head sha. Rebuild rows are the
 *  `requeued` rows of the TASK, so the lifetime and per-UTC-day caps see every head. */
export function sloRungHistory(
  rows: readonly Record<string, unknown>[],
  at: { taskId: string | undefined; prNumber: number; headSha: string; mainSha: string | undefined },
): SloRungTaken[] {
  const out: SloRungTaken[] = [];
  for (const r of rows) {
    const atMs = typeof r.ts === "string" ? Date.parse(r.ts) : Number.NaN;
    if (r.step === "sweep.strike_ladder.refreshed" && r.pr_number === at.prNumber) {
      out.push({ rung: "refresh", atMs, atThisHead: at.mainSha !== undefined && r.main_sha === at.mainSha });
    } else if (r.step === "sweep.strike_ladder.requeued" && at.taskId !== undefined && r.task_id === at.taskId) {
      out.push({ rung: "rebuild", atMs, atThisHead: r.head_sha === at.headSha });
    } else if ((r.step === "sweep.strike_ladder.digest_opened" || r.step === "sweep.strike_ladder.digest_appended") &&
        r.pr_number === at.prNumber) {
      out.push({ rung: "digest", atMs, atThisHead: r.head_sha === at.headSha });
    }
  }
  return out;
}

/** W1-T5690 — has a rebuild for this task already run on `nowMs`'s UTC day? */
export function rebuiltOnUtcDay(history: readonly SloRungTaken[], nowMs: number): boolean {
  return history.some(h => h.rung === "rebuild" && utcDayOf(h.atMs) === utcDayOf(nowMs));
}
