import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { fixedClock, systemClock } from "./clock.js";
import { escalate, ghIssueGateway, type Escalation, type IssueGateway } from "./escalate.js";
import { isQuietHours, pauseDetail, pendingPrActions, requestPrAction, stopDetail } from "./fleet-control.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { defaultInContainer, writeAtomic } from "./fs-race-safe.js";
import { ghExec } from "./github-transport.js";
import { parseInflightLockInfo } from "./inflight-lock.js";
import { isFastBurn, sreGovernorVerdict, verdictFor, governorIncidentFromLedgerRow, type IncidentEvidence, type SreGovernorControls, type SreGovernorIncident, type SreGovernorTier, type SreGovernorVerdict } from "./sre-governor.js";
import { readLedgerLines } from "./status.js";

/**
 * lib/sre-runbooks.ts (W1-T4386) — a KNOWN failure with a KNOWN, REVERSIBLE fix no longer waits for
 * a human. The SRE lane (sre-lane.ts) hands each incident to {@link runMatchingRunbook} before it
 * files feedback. A runbook acts only when its precheck holds AND the governor's verdict is `live`;
 * `shadow` records the act it would have taken without taking it. Every attempt ledgers one
 * `sre.runbook` receipt {id, fingerprint, mode, before, after, outcome}.
 *
 * INTERRUPTS (operator rulings 2026-09-23): the operator is paged ONLY for a user-visible fast burn
 * ({@link isFastBurn}) or a runbook that failed {@link SRE_RUNBOOK_FAILURE_LIMIT} times for one
 * fingerprint — through the existing needs-human issue, assigned to the operator so GitHub delivers
 * email and a mobile push. Nothing else notifies.
 *
 * GOVERNED (W1-T4390): {@link daemonSreRunbookPass} asks sre-governor.ts's `sreGovernorVerdict`
 * before every act, over this ledger only — the core daemon evaluates the same function every tick,
 * so a lane that skips this check is still stopped. A stopped verdict that names flapping or harm
 * also pages the operator here, through the same needs-human issue.
 *
 * FALSIFIER: test/sre-runbooks.test.ts.
 */

export const SRE_RUNBOOK_STEP = "sre.runbook";
/** PRIMARY CONTROL: "a fix that failed twice" (operator ruling 2026-09-23) — the second failure
 *  for one fingerprint stops the runbook and escalates. */
export const SRE_RUNBOOK_FAILURE_LIMIT = 2;

// ── the runbook contract ─────────────────────────────────────────────────────────────────────

// The incident shape, the fast-burn test and the governor's tiers live in the leaf module the core
// daemon also imports (W1-T4390), so both enforcers read ONE definition; re-exported for callers.
export type { IncidentEvidence, SreGovernorTier, SreGovernorVerdict } from "./sre-governor.js";
export { FAST_BURN_PER_HOUR, FAST_BURN_RECENT_MS, isFastBurn } from "./sre-governor.js";

/** A precheck's or verify's reading. `ok` means "safe and needed" for a precheck, "cleared" for a
 *  verify; `observed` is the receipt's `before`/`after` text; `subject` keys once-only runbooks. */
export interface RunbookObservation {
  ok: boolean;
  observed: string;
  subject?: string;
}

export interface SreRunbook {
  id: string;
  /** The allowlist admits only reversible fixes — {@link runMatchingRunbook} never acts on `false`. */
  reversible: boolean;
  blastRadius: string;
  matches(incident: IncidentEvidence): boolean;
  precheck(incident: IncidentEvidence): Promise<RunbookObservation>;
  act(incident: IncidentEvidence): Promise<void>;
  verify(incident: IncidentEvidence): Promise<RunbookObservation>;
}

export type SreRunbookOutcome = "precheck_refused" | "would_act" | "held" | "cleared" | "failed" | "escalated";

export interface SreRunbookReceipt {
  id: string;
  fingerprint: string;
  mode: SreGovernorTier;
  outcome: SreRunbookOutcome;
  subject?: string;
  before?: string;
  after?: string;
  reason?: string;
  issue_url?: string;
  /** The incident's own last-seen instant when this receipt was taken — a runbook re-runs only on
   *  NEWER evidence, so a paced-out lane re-reading one incident every tick records nothing new. */
  seen_ms?: number;
  /** The ledger row's own instant (read back from `ts`) — the governor's clock for every receipt. */
  ts_ms?: number;
}

export interface RunbookPassResult {
  runbook?: string;
  outcome: SreRunbookOutcome | "no_match" | "no_new_evidence";
  /** False only while a live runbook still owns the incident (cleared it, or will retry it). */
  fileFeedback: boolean;
  escalatedUrl?: string;
}

/** Id recorded on an escalation receipt that no runbook owns (a fast burn with no runbook). */
const FAST_BURN_RECEIPT_ID = "fast-burn";

// ── escalation ───────────────────────────────────────────────────────────────────────────────

function sreEscalation(incident: IncidentEvidence, why: string, evidence: readonly SreRunbookReceipt[]): Escalation {
  const receiptLines = evidence.map(
    (r) => `- ${r.id} mode=${r.mode} outcome=${r.outcome} before=${r.before ?? "-"} after=${r.after ?? "-"}`,
  );
  return {
    class: "BLOCKED",
    taskId: `SRE-${incident.fingerprint.slice(0, 12)}`,
    summary: `SRE incident ${incident.kind} ${incident.name}: ${why}`,
    detail: [
      `The SRE lane escalated incident \`${incident.fingerprint.slice(0, 12)}\` (${incident.kind} ${incident.name}): ${why}.`,
      ``,
      `- count: ${incident.count}, burn: ${incident.burnPerHour.toFixed(2)}/hr`,
      `- first seen: ${fixedClock(incident.firstSeenMs).iso()}, last seen: ${fixedClock(incident.lastSeenMs).iso()}`,
      `- instance(s): ${incident.instances.join(", ") || "unknown"}; deploy sha(s): ${incident.deployShas.join(", ") || "unknown"}`,
      ...incident.sampleMessages.map((m) => `- sample: ${m}`),
      ``,
      `Runbook receipts:`,
      ...(receiptLines.length ? receiptLines : ["- (no runbook acted)"]),
    ].join("\n"),
    options: [
      { label: "Remediate by hand", detail: "Read the evidence above and fix the incident; the lane files it as feedback too." },
      { label: "Pause the SRE lane", detail: "Create state/SRE_LANE_OFF if the lane's own actions are making this worse." },
    ],
    recommendation: "Remediate by hand",
    headDedup: "independent",
    consequence: "The incident keeps burning; the lane will not act on this fingerprint again.",
  };
}

function escalateOnce(
  incident: IncidentEvidence,
  runbookId: string,
  why: string,
  escalate: (e: Escalation) => string | null,
  log: (step: string, extra?: Record<string, unknown>) => void,
  history: readonly SreRunbookReceipt[],
): string | undefined {
  if (history.some((r) => r.outcome === "escalated")) return undefined;
  const url = escalate(sreEscalation(incident, why, history)) ?? undefined;
  // No receipt for an issue that did not open, so the next pass asks again rather than going quiet.
  if (url !== undefined) record(log, { id: runbookId, fingerprint: incident.fingerprint, mode: "live", outcome: "escalated", reason: why, issue_url: url });
  return url;
}

function record(log: (step: string, extra?: Record<string, unknown>) => void, receipt: SreRunbookReceipt): void {
  log(SRE_RUNBOOK_STEP, { ...receipt });
}

/** A precheck or verify that throws reads as not-ok, carrying why — never as a thrown pass that
 *  would leave the incident unfiled forever. */
async function observe(phase: string, read: () => Promise<RunbookObservation>): Promise<RunbookObservation> {
  try {
    return await read();
  } catch (e) {
    return { ok: false, observed: `${phase} threw: ${String((e as Error)?.message ?? e)}` };
  }
}

// ── the matcher ──────────────────────────────────────────────────────────────────────────────

/** Hand one incident to the first reversible runbook that matches it: precheck, governor, act,
 *  verify, receipt — and escalate only on a fast burn or the {@link SRE_RUNBOOK_FAILURE_LIMIT}th
 *  failure. Returns whether the lane should still file the incident as feedback. */
export async function runMatchingRunbook(
  incident: IncidentEvidence,
  runbooks: readonly SreRunbook[],
  governorVerdict: (runbookId: string, incident: IncidentEvidence) => SreGovernorVerdict,
  receipts: () => SreRunbookReceipt[],
  escalate: (e: Escalation) => string | null,
  log: (step: string, extra?: Record<string, unknown>) => void,
  nowMs: () => number,
): Promise<RunbookPassResult> {
  const fastBurn = isFastBurn(incident, nowMs());
  const history = receipts().filter((r) => r.fingerprint === incident.fingerprint);
  const runbook = runbooks.find((r) => r.reversible && r.matches(incident));
  const burnUrl = () => (fastBurn ? escalateOnce(incident, runbook?.id ?? FAST_BURN_RECEIPT_ID, "user-visible fast burn", escalate, log, history) : undefined);
  if (!runbook) return { outcome: "no_match", fileFeedback: true, escalatedUrl: burnUrl() };

  const own = history.filter((r) => r.id === runbook.id);
  const failures = own.filter((r) => r.mode === "live" && r.outcome === "failed").length;
  const newest = own[own.length - 1];
  if (newest && newest.outcome !== "escalated" && newest.seen_ms === incident.lastSeenMs) {
    const stillOwned = newest.mode === "live" && (newest.outcome === "cleared" || newest.outcome === "failed");
    return { runbook: runbook.id, outcome: "no_new_evidence", fileFeedback: !stillOwned || failures >= SRE_RUNBOOK_FAILURE_LIMIT, escalatedUrl: burnUrl() };
  }
  if (failures >= SRE_RUNBOOK_FAILURE_LIMIT) {
    const url = escalateOnce(incident, runbook.id, `runbook ${runbook.id} failed ${failures} times`, escalate, log, history);
    return { runbook: runbook.id, outcome: "escalated", fileFeedback: true, escalatedUrl: url };
  }

  const before = await observe("precheck", () => runbook.precheck(incident));
  const base = { id: runbook.id, fingerprint: incident.fingerprint, subject: before.subject, before: before.observed, seen_ms: incident.lastSeenMs };
  if (!before.ok) {
    record(log, { ...base, mode: "live", outcome: "precheck_refused" });
    return { runbook: runbook.id, outcome: "precheck_refused", fileFeedback: true, escalatedUrl: burnUrl() };
  }

  const verdict = governorVerdict(runbook.id, incident);
  if (verdict.tier === "shadow") {
    record(log, { ...base, mode: "shadow", outcome: "would_act", reason: verdict.reason });
    return { runbook: runbook.id, outcome: "would_act", fileFeedback: true, escalatedUrl: burnUrl() };
  }
  if (verdict.tier !== "live") {
    record(log, { ...base, mode: verdict.tier, outcome: "held", reason: verdict.reason });
    // `slow` is a backoff: the runbook still owns the incident. `stopped` hands it to the fleet.
    const stopUrl = verdict.escalate ? escalateOnce(incident, runbook.id, `governor stopped ${runbook.id}: ${verdict.reason}`, escalate, log, history) : undefined;
    return { runbook: runbook.id, outcome: "held", fileFeedback: verdict.tier === "stopped", escalatedUrl: stopUrl ?? burnUrl() };
  }

  let actError: string | undefined;
  try {
    await runbook.act(incident);
  } catch (e) {
    // A thrown fix is a failed fix: its message becomes the receipt's `after`, never a thrown pass.
    actError = String((e as Error)?.message ?? e);
  }
  const after = actError === undefined ? await observe("verify", () => runbook.verify(incident)) : { ok: false, observed: `act threw: ${actError}` };
  const outcome: SreRunbookOutcome = after.ok ? "cleared" : "failed";
  const receipt: SreRunbookReceipt = { ...base, mode: "live", outcome, after: after.observed };
  record(log, receipt);
  if (outcome === "cleared") return { runbook: runbook.id, outcome, fileFeedback: false };

  if (failures + 1 >= SRE_RUNBOOK_FAILURE_LIMIT) {
    const url = escalateOnce(incident, runbook.id, `runbook ${runbook.id} failed ${failures + 1} times`, escalate, log, [...history, receipt]);
    return { runbook: runbook.id, outcome: "escalated", fileFeedback: true, escalatedUrl: url };
  }
  return { runbook: runbook.id, outcome, fileFeedback: false, escalatedUrl: burnUrl() };
}

// ── receipts, from the ledger ────────────────────────────────────────────────────────────────

const OUTCOMES: ReadonlySet<string> = new Set(["precheck_refused", "would_act", "held", "cleared", "failed", "escalated"]);
const TIERS: ReadonlySet<string> = new Set(["live", "slow", "shadow", "stopped"]);

/** A ledger row reduced to a receipt — `undefined` for any other step or a torn row. */
export function receiptFromLedgerRow(row: Record<string, unknown>): SreRunbookReceipt | undefined {
  if (row.step !== SRE_RUNBOOK_STEP) return undefined;
  const { id, fingerprint, mode, outcome } = row;
  if (typeof id !== "string" || typeof fingerprint !== "string") return undefined;
  if (typeof mode !== "string" || !TIERS.has(mode) || typeof outcome !== "string" || !OUTCOMES.has(outcome)) return undefined;
  const text = (k: string) => (typeof row[k] === "string" ? (row[k] as string) : undefined);
  return {
    id,
    fingerprint,
    mode: mode as SreGovernorTier,
    outcome: outcome as SreRunbookOutcome,
    subject: text("subject"),
    before: text("before"),
    after: text("after"),
    seen_ms: typeof row.seen_ms === "number" ? row.seen_ms : undefined,
    ts_ms: typeof row.ts === "string" && Number.isFinite(Date.parse(row.ts)) ? Date.parse(row.ts) : undefined,
  };
}

export function readRunbookReceipts(ledgerPath: string): SreRunbookReceipt[] {
  return readLedgerLines(ledgerPath) // ledger-read-intent: live — the receipts this daemon wrote.
    .map((row) => receiptFromLedgerRow(row))
    .filter((r): r is SreRunbookReceipt => r !== undefined);
}

/** Every incident row this ledger holds, as the governor reads them. */
export function readGovernorIncidents(ledgerPath: string): SreGovernorIncident[] {
  return readLedgerLines(ledgerPath) // ledger-read-intent: live — the incidents this daemon ledgered.
    .map((row) => governorIncidentFromLedgerRow(row))
    .filter((e): e is SreGovernorIncident => e !== undefined);
}

/** STOP, PAUSE and QUIET_HOURS as fleet-control.ts writes them under `<root>/state` — the directory
 *  the ledger itself lives in (ledger-path.ts `ledgerPathFor`), so root is two levels above it. */
export function fleetControlsBesideLedger(ledgerPath: string): SreGovernorControls {
  const root = dirname(dirname(ledgerPath));
  return { emergencyStop: stopDetail(root), pause: pauseDetail(root), quietHours: isQuietHours(root) ? "QUIET_HOURS set" : undefined };
}

/** The lane's own enforcer: `sreGovernorVerdict` over this ledger's receipts, incidents and the
 *  fleet controls, evaluated fresh before every act — never a verdict the lane remembered. */
export function ledgerGovernorVerdict(
  ledgerPath: string,
  runbookIds: readonly string[],
  nowMs: () => number,
  controls: () => SreGovernorControls = () => fleetControlsBesideLedger(ledgerPath),
): (runbookId: string) => SreGovernorVerdict {
  return (runbookId) => {
    const verdicts = sreGovernorVerdict(readRunbookReceipts(ledgerPath), readGovernorIncidents(ledgerPath), controls(), nowMs(), runbookIds);
    return verdictFor(verdicts, runbookId);
  };
}

/** The daemon's runbook gates around a catalog (src/run-task.ts builds the catalog, so a test can
 *  inject its own): receipts from this daemon's ledger, the governor over that same ledger, and the
 *  operator's assigned needs-human issue. */
export function daemonSreRunbookPass(
  runbooks: readonly SreRunbook[],
  ledgerPath: string,
  owner: string,
  repo: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
): (incident: IncidentEvidence) => Promise<RunbookPassResult> {
  const receipts = () => readRunbookReceipts(ledgerPath);
  const escalate = sreOperatorEscalation({ owner, repo, ledgerPath, log });
  const nowMs = () => systemClock.now();
  const governor = ledgerGovernorVerdict(ledgerPath, runbooks.map((r) => r.id), nowMs);
  return (incident) => runMatchingRunbook(incident, runbooks, (id) => governor(id), receipts, escalate, log, nowMs);
}

/** The needs-human issue path, each issue assigned to the repo's owner — the operator — so GitHub
 *  delivers an email and a GitHub Mobile push. An unassignable issue still opens (logged). */
export function sreOperatorEscalation(opts: {
  owner: string;
  repo: string;
  ledgerPath: string;
  log: (step: string, extra?: Record<string, unknown>) => void;
  gh?: (args: string[]) => string;
  nowMs?: () => number;
}): (e: Escalation) => string | null {
  const repoArg = `${opts.owner}/${opts.repo}`;
  const gh = opts.gh ?? ((args: string[]) => ghExec(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const issues: IssueGateway = ghIssueGateway(opts.owner, opts.repo, {
    exec: (args) => {
      const out = gh(args);
      if (args[0] !== "issue" || args[1] !== "create") return out;
      try {
        gh(["issue", "edit", out.trim(), "--repo", repoArg, "--add-assignee", opts.owner]);
      } catch (error) {
        opts.log("sre.escalation_assign_failed", { issue_url: out.trim(), reason: String((error as Error)?.message ?? error) });
      }
      return out;
    },
  });
  return (e) => {
    try {
      return escalate(e, { issues, ledgerPath: opts.ledgerPath, runId: `SRE-${(opts.nowMs ?? systemClock.now)()}` }) || null;
    } catch (error) {
      opts.log("sre.escalation_failed", { task_id: e.taskId, reason: String((error as Error)?.message ?? error) });
      return null;
    }
  };
}

// ── the initial catalog ──────────────────────────────────────────────────────────────────────

/** The incident `name` each runbook answers; the subject rides in the message as `key=value`. */
export const SRE_RUNBOOK_INCIDENTS = {
  "rerun-failed-ci-once": ["ci-red-unrelated"],
  "catch-up-managed-checkout": ["stale-managed-checkout"],
  "recycle-stale-container": ["stale-container"],
  "clear-stale-lock-or-nudge": ["stale-lock", "stale-review"],
} as const satisfies Record<string, readonly string[]>;

/** `key=value` from the incident's newest sample message, or undefined. Pure. */
export function incidentSubject(incident: IncidentEvidence, key: string): string | undefined {
  for (const message of [...incident.sampleMessages].reverse()) {
    const match = new RegExp(`(?:^|\\s)${key}=(\\S+)`).exec(message);
    if (match) return match[1];
  }
  return undefined;
}

/** What each catalog runbook reads and does — injected so a test drives the catalog offline. */
export interface SreRunbookHost {
  failedCi(pr: number): Promise<{ headSha: string; unrelated: boolean; jobIds: number[]; observed: string }>;
  rerunJob(jobId: number): Promise<void>;
  checkout(): Promise<{ clean: boolean; behind: number; borrowed: boolean; observed: string }>;
  fastForward(): Promise<void>;
  reinstall(): Promise<void>;
  canRecycle(container: string): Promise<{ ok: boolean; observed: string }>;
  recycle(container: string): Promise<void>;
  lock(path: string): Promise<{ present: boolean; holderDead: boolean; observed: string }>;
  removeLock(path: string): Promise<void>;
  reviewRequested(pr: number): Promise<boolean>;
  requestReview(pr: number): Promise<void>;
}

function refused(observed: string): RunbookObservation {
  return { ok: false, observed };
}

function prNumber(incident: IncidentEvidence): number | undefined {
  const n = Number(incidentSubject(incident, "pr"));
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function answers(id: keyof typeof SRE_RUNBOOK_INCIDENTS): (incident: IncidentEvidence) => boolean {
  const names: readonly string[] = SRE_RUNBOOK_INCIDENTS[id];
  return (incident) => names.includes(incident.name);
}

/** The allowlisted, reversible runbooks the daemon hands the SRE lane (the design's initial four). */
export function sreRunbookCatalog(host: SreRunbookHost, receipts: () => SreRunbookReceipt[]): SreRunbook[] {
  return [
    {
      id: "rerun-failed-ci-once",
      reversible: true,
      blastRadius: "one pull request's failed jobs",
      matches: answers("rerun-failed-ci-once"),
      precheck: async (incident) => {
        const pr = prNumber(incident);
        if (pr === undefined) return refused("incident names no pr=<n>");
        const ci = await host.failedCi(pr);
        const subject = `${pr}@${ci.headSha}`;
        const rerun = receipts().some((r) => r.id === "rerun-failed-ci-once" && r.subject === subject && r.mode === "live" && (r.outcome === "cleared" || r.outcome === "failed"));
        if (rerun) return { ok: false, observed: `already re-ran once at ${subject}`, subject };
        return { ok: ci.unrelated && ci.jobIds.length > 0, observed: ci.observed, subject };
      },
      act: async (incident) => {
        const ci = await host.failedCi(prNumber(incident) as number);
        for (const job of ci.jobIds) await host.rerunJob(job);
      },
      verify: async (incident) => {
        const ci = await host.failedCi(prNumber(incident) as number);
        return { ok: ci.jobIds.length === 0, observed: ci.observed };
      },
    },
    {
      id: "catch-up-managed-checkout",
      reversible: true,
      blastRadius: "the managed checkout and its node_modules",
      matches: answers("catch-up-managed-checkout"),
      precheck: async () => {
        const c = await host.checkout();
        return { ok: c.clean && c.behind > 0 && !c.borrowed, observed: c.observed };
      },
      act: async () => {
        await host.fastForward();
        await host.reinstall();
      },
      verify: async () => {
        const c = await host.checkout();
        return { ok: c.behind === 0, observed: c.observed };
      },
    },
    {
      id: "recycle-stale-container",
      reversible: true,
      blastRadius: "one daemon or gateway container (the script pauses and waits for workers)",
      matches: answers("recycle-stale-container"),
      precheck: async (incident) => {
        const container = incidentSubject(incident, "container");
        if (!container) return refused("incident names no container=<name>");
        return { ...(await host.canRecycle(container)), subject: container };
      },
      act: async (incident) => host.recycle(incidentSubject(incident, "container") as string),
      verify: async (incident) => {
        const r = await host.canRecycle(incidentSubject(incident, "container") as string);
        return { ok: !r.ok, observed: r.observed };
      },
    },
    {
      id: "clear-stale-lock-or-nudge",
      reversible: true,
      blastRadius: "one dead holder's lock file, or one review request",
      matches: answers("clear-stale-lock-or-nudge"),
      precheck: async (incident) => {
        const lockPath = incidentSubject(incident, "lock");
        if (lockPath) {
          const l = await host.lock(lockPath);
          return { ok: l.present && l.holderDead, observed: l.observed, subject: lockPath };
        }
        const pr = prNumber(incident);
        if (pr === undefined) return refused("incident names no lock=<path> or pr=<n>");
        const requested = await host.reviewRequested(pr);
        return { ok: !requested, observed: requested ? `review already requested for #${pr}` : `no review request for #${pr}`, subject: `#${pr}` };
      },
      act: async (incident) => {
        const lockPath = incidentSubject(incident, "lock");
        if (lockPath) return host.removeLock(lockPath);
        return host.requestReview(prNumber(incident) as number);
      },
      verify: async (incident) => {
        const lockPath = incidentSubject(incident, "lock");
        if (lockPath) {
          const l = await host.lock(lockPath);
          return { ok: !l.present, observed: l.observed };
        }
        const pr = prNumber(incident) as number;
        const requested = await host.reviewRequested(pr);
        return { ok: requested, observed: requested ? `review requested for #${pr}` : `no review request for #${pr}` };
      },
    },
  ];
}

// ── the daemon's host ────────────────────────────────────────────────────────────────────────

interface RollupCheck {
  name?: string;
  conclusion?: string;
  detailsUrl?: string;
}

/** The real host: git in the managed checkout, `gh` against `owner/repo`, files under `root/state`.
 *  The container probe is injectable so the recycle safety guard can be tested in both states. */
export function daemonSreRunbookHost(opts: {
  root: string;
  repoDir: string;
  owner: string;
  repo: string;
  isInContainer?: () => boolean;
}): SreRunbookHost {
  const repoArg = `${opts.owner}/${opts.repo}`;
  const git = (args: string[]) => execFileSync("git", ["-C", opts.repoDir, ...args], { encoding: "utf8" }).trim();
  const gh = (args: string[]) => ghExec(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const failed = (checks: RollupCheck[]) => checks.filter((c) => c.conclusion === "FAILURE");
  return {
    async failedCi(pr) {
      const view = JSON.parse(gh(["pr", "view", String(pr), "--repo", repoArg, "--json", "headRefOid,statusCheckRollup"])) as { headRefOid?: string; statusCheckRollup?: RollupCheck[] };
      const red = failed(view.statusCheckRollup ?? []);
      const jobIds = red.map((c) => Number(/\/job\/(\d+)/.exec(c.detailsUrl ?? "")?.[1])).filter((n) => Number.isSafeInteger(n) && n > 0);
      const main = JSON.parse(gh(["api", `repos/${repoArg}/commits/main/check-runs`, "--jq", "[.check_runs[] | {name, conclusion}]"])) as Array<{ name?: string; conclusion?: string }>;
      const greenOnMain = new Set(main.filter((c) => c.conclusion === "success").map((c) => c.name));
      const unrelated = red.length > 0 && red.every((c) => greenOnMain.has(c.name));
      return { headSha: view.headRefOid ?? "unknown", unrelated, jobIds, observed: `red: ${red.map((c) => c.name).join(", ") || "none"}; green on main: ${unrelated}` };
    },
    // The job, never the run: a run-level rerun re-spends every green sibling job.
    async rerunJob(jobId) {
      gh(["api", "-X", "POST", `repos/${repoArg}/actions/jobs/${jobId}/rerun`]);
    },
    async checkout() {
      git(["fetch", "--quiet", "origin", "main"]);
      const clean = git(["status", "--porcelain"]) === "";
      const behind = Number(git(["rev-list", "--count", "HEAD..origin/main"]));
      const inflight = join(opts.root, "state", "inflight");
      const borrowed = existsSync(inflight) && readdirSync(inflight).some((f) => f.endsWith(".lock"));
      return { clean, behind, borrowed, observed: `clean=${clean} behind=${behind} borrowed=${borrowed}` };
    },
    async fastForward() {
      git(["merge", "--ff-only", "origin/main"]);
    },
    async reinstall() {
      execFileSync("npm", ["ci"], { cwd: opts.repoDir, stdio: "ignore" });
    },
    // recycle-container.sh must never run inside the container it replaces (its own header).
    async canRecycle(container) {
      if ((opts.isInContainer ?? defaultInContainer)()) return { ok: false, observed: `recycle of ${container} refused: this daemon runs inside a container` };
      return { ok: true, observed: `${container} reported drifted` };
    },
    async recycle(container) {
      execFileSync("bash", [join(opts.repoDir, "deploy", "recycle-container.sh"), "--container", container], { stdio: "ignore" });
    },
    async lock(path) {
      if (!existsSync(path)) return { present: false, holderDead: false, observed: `${path} absent` };
      const holder = parseInflightLockInfo(readFileIfPresent(path));
      const holderDead = holder !== null && !defaultIsPidAlive(holder.pid);
      return { present: true, holderDead, observed: `${path} held by pid ${holder?.pid ?? "unknown"} (${holderDead ? "dead" : "alive or unknown"})` };
    },
    async removeLock(path) {
      unlinkSync(path);
    },
    async reviewRequested(pr) {
      return pendingPrActions(opts.root).some((r) => r.action === "review" && r.prNumber === pr);
    },
    async requestReview(pr) {
      requestPrAction(opts.root, "review", pr, "sre-runbook");
    },
  };
}

function readFileIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    // A lock that vanished between the existence check and this read has no holder to judge.
    return `unreadable: ${String((e as Error)?.message ?? e)}`;
  }
}

// ── the daemon's governor port (W1-T4390) ────────────────────────────────────────────────────

/** What the core daemon's governor step reads and writes, injected so daemon.ts stays free of I/O:
 *  the SRE instance's live ledger, the lane's pause switch, and the operator's escalation. */
export interface SreGovernorEnforcer {
  /** Every row of the SRE instance's live ledger. */
  readLedger(): Record<string, unknown>[];
  /** The lane's pause switch's text while present, `undefined` while absent. */
  laneOff(): string | undefined;
  pauseLane(text: string): void;
  resumeLane(): void;
  /** Absent when the composition root has no repo identity to open an issue under. */
  escalate?: (e: Escalation) => string | null;
}

/** The real port over one state root. `laneOffPath` is sre-lane.ts's `sreLaneOffPath` — passed in,
 *  since sre-lane.ts imports this module and importing it back would close a cycle. */
export function daemonSreGovernorEnforcer(opts: {
  ledgerPath: string;
  laneOffPath: string;
  escalate?: (e: Escalation) => string | null;
}): SreGovernorEnforcer {
  return {
    readLedger: () => readLedgerLines(opts.ledgerPath), // ledger-read-intent: live — the governor reads this instance's own receipts.
    laneOff: () => (existsSync(opts.laneOffPath) ? readFileIfPresent(opts.laneOffPath) : undefined),
    pauseLane: (text) => writeAtomic(opts.laneOffPath, text),
    resumeLane: () => {
      try {
        unlinkSync(opts.laneOffPath);
      } catch (e) {
        // Already gone — an operator resumed it first; the lane is resumed either way.
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
      }
    },
    escalate: opts.escalate,
  };
}
