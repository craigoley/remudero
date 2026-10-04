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
  if (!input.mainTip?.sha || !Number.isFinite(Date.parse(input.mainTip.committedAt))) return hold("main tip unreadable");
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
