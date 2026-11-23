/**
 * Retirement of recovered headroom-reserve escalations (W1-T2603), moved out of `src/run-task.ts`
 * (W1-T12440) so its sweep test does not import the run-task hub. `run-task.ts` re-exports every
 * symbol here, so existing callers keep their import path.
 */
import { appendLedger } from "./ledger.js";
import type { AsyncIssueGateway, OpenIssue } from "./escalate.js";
import { readLedgerLines } from "./status.js";
import { listRetirableEscalationIssuesAsync } from "./sweep.js";

/**
 * W1-T2603 (A RECOVERED HEADROOM BREACH NEVER CLOSES ITS OWN ESCALATION). `escalateHeadroomReserve`
 * above raises one `[HARD_STOP]` issue per breach episode and nothing ever retires it — the breach
 * is a property of the ACCOUNT, not of any task, so it carries no task referent for
 * `buildEscalationReconcileCandidates` (below) to resolve against and falls through every arm of
 * that reconciler by construction, not by a bug in it (see this task's own rationale). This is the
 * missing retirement PATH for exactly that class, kept structurally separate from the task-referent
 * reconciler rather than bolted onto it.
 *
 * RETIRE ON AN OBSERVED RECOVERY, NEVER ON A TIMER OR AN ABSENCE. The daemon's own poll loop
 * (`daemon.ts`) already writes a `daemon.headroom` row on every tick with `window`, `percent_used`,
 * `limit_pct` and `over_ceiling` — a POSITIVE reading, taken whether or not the governor is
 * enforcing (see that step's own "ONE HEARTBEAT PER TICK, IN EVERY ENFORCEMENT POSTURE" doc). This
 * scans forward from the escalating row's own `ts` for the NEWEST such reading, for the SAME
 * `window` string, carrying `over_ceiling === false` — a positive observation that the door is open
 * again. A daemon that stopped reading headroom entirely (the W1-T2565 blind window) produces
 * exactly zero matching rows, never a false one, so an absence of breach rows is never mistaken for
 * recovery — the candidate list is built ONLY from a reading that actually happened.
 *
 * MATCH THE WINDOW, NOT JUST THE CLASS. The session (5h) and weekly windows breach independently
 * (`resolveHeadroomWindows`, daemon.ts) — a recovery reading for one must never retire an escalation
 * raised for the other, so `window` is compared for exact string equality, never treated as
 * interchangeable with "some window recovered".
 */
export interface HeadroomRecoveryCandidate {
  issueUrl: string;
  window: string;
  resetsAt: string;
  /** The recovery reading that justifies retiring this issue — always `over_ceiling: false`,
   *  always for the SAME `window`, always newer than the escalation it retires. */
  recovery: { percentUsed: number; limitPct: number; ts: string };
}

/**
 * Pure builder, mirroring `buildEscalationReconcileCandidates`'s own "read the ledger, hand back
 * candidates" shape: delivered headroom-reserve escalations with a later recovery reading for
 * their window. With a live `openIssueUrls` snapshot, only open issues qualify. Without one,
 * return potential candidates with no recorded retirement so the caller can decide whether to list.
 */
export function buildHeadroomRecoveryCandidates(
  ledgerPath: string,
  openIssueUrls?: ReadonlySet<string>,
): HeadroomRecoveryCandidate[] {
  const lines = readLedgerLines(ledgerPath); // ledger-read-intent: live — this scan wants the newest rows only.
  const retiredUrls = new Set(openIssueUrls === undefined
    ? lines.filter((line) => line.step === "daemon.headroom_reserve.retired").map((line) => line.issue_url)
    : []);
  const candidates: HeadroomRecoveryCandidate[] = [];
  for (const line of lines) {
    if (line.step !== "daemon.headroom_reserve.escalated") continue;
    const issueUrl = typeof line.issue_url === "string" ? line.issue_url : undefined;
    if (!issueUrl || retiredUrls.has(issueUrl) || (openIssueUrls && !openIssueUrls.has(issueUrl))) continue;
    const window = typeof line.window === "string" ? line.window : undefined;
    const resetsAt = typeof line.resets_at === "string" ? line.resets_at : undefined;
    const escalatedTs = typeof line.ts === "string" ? line.ts : undefined;
    if (!window || !resetsAt || !escalatedTs) continue; // a pre-W1-T2603 row — no window to match
    const escalatedMs = Date.parse(escalatedTs);
    if (!Number.isFinite(escalatedMs)) continue;
    // The NEWEST matching recovery reading, so the citation names the most current evidence —
    // "newest wins" never changes WHETHER this retires, only what the close comment cites.
    let recovery: { percentUsed: number; limitPct: number; ts: string } | undefined;
    for (const reading of lines) {
      if (reading.step !== "daemon.headroom") continue;
      if (reading.window !== window) continue; // THE WINDOW MATCH — never just the class
      if (reading.over_ceiling !== false) continue; // a positive under-ceiling observation only
      const readingTs = typeof reading.ts === "string" ? reading.ts : undefined;
      if (!readingTs) continue;
      const readingMs = Date.parse(readingTs);
      if (!Number.isFinite(readingMs) || readingMs <= escalatedMs) continue; // must POSTDATE the breach
      if (!recovery || readingMs > Date.parse(recovery.ts)) {
        recovery = {
          percentUsed: typeof reading.percent_used === "number" ? reading.percent_used : NaN,
          limitPct: typeof reading.limit_pct === "number" ? reading.limit_pct : NaN,
          ts: readingTs,
        };
      }
    }
    if (recovery) candidates.push({ issueUrl, window, resetsAt, recovery });
  }
  return candidates;
}

/** The closing citation posted on a headroom-recovery retirement — mirrors
 *  `renderReconcileCloseComment`'s "name the resolution" discipline for the task-referent arm. */
export function renderHeadroomRecoveryCloseComment(c: HeadroomRecoveryCandidate): string {
  return [
    "Auto-retired by the headroom-recovery reconciler (W1-T2603).",
    "",
    `**${c.window}** is now reading **${c.recovery.percentUsed}% used** (below the ${c.recovery.limitPct}% ` +
      `operator reserve ceiling) as of ${c.recovery.ts} — under its ceiling again since this escalation was ` +
      `raised for a breach at ${c.resetsAt !== undefined ? `the window resetting ${c.resetsAt}` : "this window"}.`,
    "",
    "_Level-triggered closure from a daemon-observed `daemon.headroom` reading for the SAME window. If the " +
      "account breaches again, a fresh escalation opens on its own._",
  ].join("\n");
}

/**
 * Reconcile OPEN headroom-reserve escalations against observed recovery — the retirement leg
 * `escalateHeadroomReserve` never had. Build potential candidates from the ledger first, then use
 * the shared listing to confirm they are still open under needs-human or fleet-notice. A failed
 * issue-list read or close is logged and the other reconciliation rungs can continue.
 */
export async function retireRecoveredHeadroomEscalations(
  ledgerPath: string,
  runId: string,
  ctx: { issues: AsyncIssueGateway; log?: (step: string, extra?: Record<string, unknown>) => void; dryRun?: boolean },
): Promise<{ retired: number }> {
  const log = ctx.log ?? (() => {});
  let candidates = buildHeadroomRecoveryCandidates(ledgerPath);
  if (candidates.length > 0) {
    let open: OpenIssue[];
    try {
      open = await listRetirableEscalationIssuesAsync(ctx.issues);
    } catch (e) {
      log("sweep.headroom_recovery.list_failed", { error: String((e as Error)?.message ?? e) });
      return { retired: 0 };
    }
    const openUrls = new Set(open.map((issue) => issue.url));
    candidates = candidates.filter((candidate) => openUrls.has(candidate.issueUrl));
  }
  let retired = 0;
  for (const c of candidates) {
    // dryRun leaves no trace — mirrors runEscalationReconcile's own "still counts, never acts" preview.
    if (ctx.dryRun) {
      retired++;
      continue;
    }
    try {
      if (!ctx.issues.closeWithComment) throw new Error("issue gateway cannot close issues");
      await ctx.issues.closeWithComment(c.issueUrl, renderHeadroomRecoveryCloseComment(c));
    } catch (e) {
      log("sweep.headroom_recovery.close_failed", { issue_url: c.issueUrl, error: String((e as Error)?.message ?? e) });
      continue;
    }
    appendLedger(ledgerPath, {
      run_id: runId,
      task_id: "daemon",
      step: "daemon.headroom_reserve.retired",
      issue_url: c.issueUrl,
      window: c.window,
      resets_at: c.resetsAt,
      recovered_percent_used: c.recovery.percentUsed,
      recovered_ts: c.recovery.ts,
    });
    log("sweep.headroom_recovery.retired", { issue_url: c.issueUrl, window: c.window, recovered_ts: c.recovery.ts });
    retired++;
  }
  log("sweep.headroom_recovery.summary", { candidates: candidates.length, retired });
  return { retired };
}
