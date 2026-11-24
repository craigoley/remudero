import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { checkoutHeadStamp } from "./checkout-head.js";
import { bodyCreditedMergeTimes, ciFrictionRecordVerdict, ciFrictionRecencyWeight, gitCiFrictionOwnerSearch, type CiFrictionPlanState } from "./ci-friction-gardener.js";
import { CI_FRICTION_EFFECT_MAX_WINDOW_MS, CI_FRICTION_ESCALATE_RUNG, type CiFrictionRemedyTask, type OwnerSearch, type RemedyEffect } from "./ci-friction-remedy.js";
import type { Escalation } from "./escalate.js";
import { rowPrNumber } from "./fix-progress-judge.js";
import { measureRemedy, prHoursMetric, REMEDY_WIDENED_BEFORE_WINDOW_MS } from "./remedy-effect.js";
import { slug } from "./feedback-docket.js";
import { prepareGardenTaskIds, gardenLedgerBucket, type GardenTaskIdMinter, type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec } from "./gardener.js";
import { ghExec } from "./github-transport.js";
import { PR_TERMINAL_STEP } from "./ledger-carry.js";
import { ledgerRotationEntries, readLedgerUnionRecordsSync } from "./ledger-union.js";
import { machineShardFilingRefusal, machineShardLandingGuard, renderMachineShard } from "./machine-filing.js";
import { retirementReopensAt, type RetirementDated } from "./mechanical-rulings.js";
import { newTestPath, parseTasksFromYaml } from "./plan.js";
import { blockerOwnerModule, PR_BLOCKERS, type PrBlocker } from "./pr-blocker.js";
import { resolveRepoLayout } from "./repo-layout.js";
import type { LedgerRecord } from "./retro.js";
import { ADMISSION_FLOW_STEP, observeAdmissionFlow, type AdmissionFlowInput, type AdmissionFlowReport } from "./flow-gardener.js";
import { feedbackContentDigest } from "./contributor-admission.js";

export interface PrOutcome { state: "open" | "closed" | "merged"; at?: string; mergedBy?: string }
export interface Charge { pr: number; key: string; start: number; end: number; hours: number; reason: string; owner: string; handedOff?: boolean }
type EligibilityArm = "unowned" | "failed" | "past p90" | "open own-red" | "CI hand-off";
const FLOW_ROUND_STEPS = new Set(["fix.dispatch", "sweep.review_admitted", "review.posted"]);

export interface Episode {
  pr: number; key: string; owner: string; start: number; end: number;
  outcome: "open" | "cleared" | "failed" | "unknown"; eligible: boolean;
  charges: Charge[];
  handedOff?: boolean;
  flow?: { ownerActed: boolean; waitOnly: boolean; eligibilityArm?: EligibilityArm };
}
export interface Price { key: string; hours: number; prs: number; owners: string[]; thresholdHours?: number }
export interface Prior { task: CiFrictionRemedyTask; effect?: RemedyEffect }
export interface FlowAction extends GardenAction<"draft"> {
  price: Price; origin: string; rung: number; prior?: Prior; escalation?: string;
  charges: Charge[]; population: number[];
  admissionShadow?: boolean;
  eligibilityCounts?: Record<EligibilityArm, number>;
}
export interface Inventory {
  charges: Charge[]; episodes: Episode[]; priced: Price[]; candidates: Price[];
  next?: FlowAction; ladder: Array<{ cause: string; state: string; rung: number; effect?: RemedyEffect; reason?: string }>;
}
/** W1-T12548: why the ladder cannot file this draft in this pass, or undefined when it can. */
export type LadderFileable = (action: FlowAction) => string | undefined;
export interface FlowGardenSources {
  owner: string; repo: string;
  mintTaskId: GardenTaskIdMinter;
  ledgerRecords?: () => readonly LedgerRecord[];
  planState?: () => CiFrictionPlanState;
  prOutcomes?: (prs: readonly number[]) => ReadonlyMap<number, PrOutcome>;
  ownerSearch?: OwnerSearch;
  draftShard?: (action: FlowAction, taskId: string) => string;
  escalate?: (escalation: Escalation) => string | null;
  admission?: AdmissionFlowInput;
}

/**
 * W1-T7421: the draft -> measure effect -> escalate ladder, kept ONE implementation. A garden that prices a
 * cause and files one remedy per cause names its {@link LadderKind}; the flow gardener is one (`flow-blocker`),
 * the fix-lane gardener another (`fix-lane`). Nothing below forks on which.
 */
export interface LadderKind {
  /** The garden's spec name (ledger prefix, branch stem). */
  name: string;
  /** The `origin:` prefix a remedy task carries: `<prefix>:<cause key>[#r<rung>]`. */
  prefix: string;
  /** The ledger step whose pr_url rows prove a filing is in flight, and the one an escalation is recorded on. */
  receiptStep: string;
  escalatedStep: string;
  /** The stem of the remedy's shard and test names. */
  stem: string;
  title: (action: FlowAction) => string;
  commitTitle: (cause: string) => string;
  claim: (cause: string) => string;
  ownerLine: (action: FlowAction) => string;
  evidenceLine: (pr: number, hours: number, reason: string) => string;
  escalationSummary: (cause: string) => string;
  /** Files a remedy may own when no source file mentions the cause's text. */
  fallbackFiles?: readonly string[];
  /** Admission proposals have a one-remedy/one-owner-judgment shadow budget, not live effects. */
  shadowAdmission?: boolean;
  /** W1-T9597: a `<PR blocker>:<reason>` key is owned by its declared owner's module, never by a text search. */
  declaredOwners?: boolean;
  /** W1-T11097: the modules that measure this ladder's own cause; a remedy scoped to one is a relabel, so it escalates. */
  ownModules?: readonly string[];
}

function flowCauseLabel(cause: string): string {
  return cause.replace(/ \(round DAEMON-<sha>:<n>:<sha>\)$/, "");
}

export const FLOW_LADDER: LadderKind = {
  name: "flow-remedy", prefix: "flow-blocker", receiptStep: "flow-remedy.scorecard", escalatedStep: "flow.remedy_escalated", stem: "flow",
  title: a => `THE FLOW GARDENER'S COSTLIEST UNOWNED BLOCKER — ${a.price.key} cost ${a.price.hours.toFixed(2)} PR-hours`,
  commitTitle: cause => `chore(plan): draft a flow remedy for ${cause}`,
  claim: cause => `${flowCauseLabel(cause)} is cleared by its owner without manual intervention`,
  ownerLine: a => {
    const owner = a.price.owners.includes("NONE") ? "NONE is absent" : a.price.owners.join(", ") + " failed to clear eligible episodes";
    const counts = Object.entries(a.eligibilityCounts ?? {}).map(([arm, count]) => `${arm} ${count}`).join(", ");
    return `Owner ${owner}.${counts ? ` Eligible episodes by arm: ${counts}.` : ""}`;
  },
  evidenceLine: (pr, hours, reason) => `- PR #${pr}: ${hours.toFixed(2)} PR-hours — ${reason}`,
  escalationSummary: cause => `Flow blocker: ${cause} still costs PR-hours`,
  declaredOwners: true,
  ownModules: ["src/lib/flow-remedy-gardener.ts"],
};

export const ADMISSION_FLOW_LADDER: LadderKind = { ...FLOW_LADDER, prefix: "admission-flow", shadowAdmission: true };

/** Distinct PR episodes, not retries, head pushes or repeated receipt rows, measure recurrence. */
export interface AdmissionRecurrenceSample {
  atMs: number; repositoryId: number; policyDigest: string; populationDigest: string;
  coverage: string; domain: "shadow"; population: number[]; episodes: string[];
}
export function admissionRecurrence(samples: readonly AdmissionRecurrenceSample[], mergedAtMs: number, nowMs: number): RemedyEffect {
  const unmeasured: RemedyEffect = { verdict: "unmeasurable", before: { k: 0, n: 0 }, after: { k: 0, n: 0 }, windowDays: 0, z: 0,
    reason: "unknown: no comparable controlled before/after windows and actual remedy merge" };
  const span = Math.min(nowMs - mergedAtMs, CI_FRICTION_EFFECT_MAX_WINDOW_MS);
  if (!Number.isFinite(span) || span <= 0) return unmeasured;
  const before = samples.filter(s => s.atMs >= mergedAtMs - span && s.atMs < mergedAtMs);
  const after = samples.filter(s => s.atMs >= mergedAtMs && s.atMs <= nowMs);
  const all = [...before, ...after], control = before[0];
  if (!control || !after.length || all.some(s => s.domain !== "shadow" || s.coverage !== "measured"
    || s.repositoryId !== control.repositoryId || s.policyDigest !== control.policyDigest || s.populationDigest !== control.populationDigest
    || feedbackContentDigest([...s.population].sort((a, b) => a - b)) !== s.populationDigest)) return unmeasured;
  const distinct = (rows: readonly AdmissionRecurrenceSample[]) => new Set(rows.flatMap(s => s.episodes));
  const beforeEpisodes = distinct(before), afterEpisodes = distinct(after);
  // A persistent old episode is not a new recurrence; retain its cause separately in the ladder.
  const k = [...afterEpisodes].filter(id => !beforeEpisodes.has(id)).length;
  const result = { before: { k: beforeEpisodes.size, n: control.population.length }, after: { k, n: control.population.length },
    windowDays: span / 86_400_000, z: 0 };
  if (result.before.n === 0 || result.before.k === 0) return { ...unmeasured, ...result };
  const persistent = [...afterEpisodes].some(id => beforeEpisodes.has(id));
  return { ...result, verdict: !persistent && k < result.before.k ? "credit" : "debit",
    reason: `observed distinct-episode recurrence: ${result.before.k}/${result.before.n} before, ${k}/${result.after.n} after; persistent ${persistent}; equal windows, no causal claim` };
}

function admissionEffect(records: readonly LedgerRecord[], cause: string, merge: number, now: number): RemedyEffect {
  const samples: AdmissionRecurrenceSample[] = [];
  for (const row of records.filter(r => r.step === ADMISSION_FLOW_STEP)) {
    if (row.mode !== "shadow" || row.corpusCoverage !== "measured" || !Number.isSafeInteger(row.repositoryId)
      || typeof row.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.policyDigest)
      || typeof row.populationDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.populationDigest)
      || !Array.isArray(row.trusted) || !Array.isArray(row.affected) || !Number.isFinite(row.observedAtMs)) return admissionRecurrence([], merge, now);
    const prs = [...row.trusted, ...row.affected] as AdmissionFlowReport["affected"];
    if (prs.some(r => !Number.isSafeInteger(r.pr) || r.pr <= 0 || !Number.isSafeInteger(r.itemId) || r.itemId <= 0
      || !/^admission-[a-f0-9]{64}$/.test(r.causeKey))) return admissionRecurrence([], merge, now);
    samples.push({ atMs: Number(row.observedAtMs), repositoryId: Number(row.repositoryId), policyDigest: row.policyDigest,
      populationDigest: row.populationDigest, coverage: "measured", domain: "shadow", population: prs.map(r => r.pr),
      episodes: row.affected.filter((r: AdmissionFlowReport["affected"][number]) => r.causeKey === cause).map((r: AdmissionFlowReport["affected"][number]) => `${r.itemId}:${cause}`) });
  }
  return admissionRecurrence(samples, merge, now);
}

/** Typed cause keys enter the ONE ladder directly, never through the free-text SHA normalizer. */
export function admissionFlowInventory(report: AdmissionFlowReport, records: readonly LedgerRecord[], tasks: readonly CiFrictionRemedyTask[], nowMs: number): Inventory {
  const eligible = report.corpusCoverage === "measured" ? report.affected.filter(r => r.evidence !== "current-disposition" || r.status === "owner-action") : [];
  const episodes: Episode[] = eligible.map(r => ({ pr: r.pr, key: r.causeKey, owner: "admission-shadow", start: r.openedAtMs, end: nowMs,
    outcome: "unknown", eligible: true, charges: [{ pr: r.pr, key: r.causeKey, start: r.openedAtMs, end: nowMs,
      hours: (nowMs - r.openedAtMs) / 3_600_000, reason: r.originalReason ?? r.evidence, owner: "admission-shadow" }] }));
  const inv = ladderOf(ADMISSION_FLOW_LADDER, episodes, records, tasks, nowMs);
  if (inv.next) { inv.next.admissionShadow = true; inv.next.reason = `${inv.next.price.key}: observed open exposure, not causal attribution; shadow proposal only`; }
  return inv;
}

/** Write intent before any diagnostic acknowledgement; lost acknowledgement never resets it. */
export function recordAdmissionFlowProposal(deps: GardenerDeps, action: FlowAction): void {
  if (!/^admission-[a-f0-9]{64}$/.test(action.price.key) || action.admissionShadow !== true || ![1, 2].includes(action.rung)) {
    deps.log("admission_flow.proposal_unknown", { reason: "invalid-proposal", permission: "not-granted" }); return;
  }
  const effect = action.escalation ? "owner-judgment" : "remedy";
  const dir = join(deps.stateDir, "admission-flow-shadow-intents");
  const token = join(dir, `${action.price.key}-${effect}.json`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(token, JSON.stringify({ version: "admission-flow-intent-v1", mode: "shadow", effect, cause: action.price.key,
      origin: action.origin, permission: "not-granted", originalReasons: action.charges.map(c => c.reason), atMs: (deps.clock ?? systemClock).now() }) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    // EEXIST includes unreadable/corrupt existing tokens: never delete them into a fresh budget.
    deps.log("admission_flow.proposal_unknown", { cause: action.price.key, reason: (error as NodeJS.ErrnoException).code === "EEXIST"
      ? "existing-intent-or-lost-acknowledgement" : "intent-unreadable", permission: "not-granted" }); return;
  }
  deps.log("admission_flow.proposal_shadow", { cause: action.price.key, effect, mode: "shadow", permission: "not-granted",
    remedy_max: 1, owner_judgment_max: 1, original_reason: "retained-in-private-intent", required_checks: "ordinary-current-head-checks-required" });
}

const originOf = (kind: LadderKind, key: string, rung: number) => `${kind.prefix}:${key}${rung > 1 ? `#r${rung}` : ""}`;
const parseOrigin = (kind: LadderKind, origin: string) =>
  new RegExp(`^${kind.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(.+?)(?:#r(\\d+))?$`).exec(origin);
/** Normalises a free-text reason into a class key: shas, PR numbers and counts collapse, the detail after " — " drops. */
export const reasonClass = (reason: string) => reason.split(" — ")[0]!
  .replace(/\b[0-9a-f]{7,40}\b/gi, "<sha>")
  .replace(/\/pull\/\d+/g, "/pull/<n>").replace(/\b\d+(?:\.\d+)?\b/g, "<n>").trim();
/** A recurring check and its observed red heads, read beside the sweep's disposition rows. */
export const CI_LESSON_HANDOFF_STEP = "ci_learning.ladder_handoff";
/** The fleet App as REST (`remudero-fleet[bot]`), `gh` (`app/remudero-fleet`) and GraphQL (`remudero-fleet`) spell it —
 *  `readOutcomes` asks GraphQL, so the bare login is the one a fleet merge actually carries (sweep's isFleetAppAuthor). */
export const isFleet = (actor: string | undefined) =>
  actor === "remudero-fleet[bot]" || actor === "app/remudero-fleet" || actor === "remudero-fleet";

/** The ledger union the ladder reads: `steps` plus the kind's own receipt and escalation rows. */
export function readLadderRecords(stateDir: string, kind: LadderKind, steps: readonly string[] = ["sweep.disposed"]): LedgerRecord[] {
  const read = readLedgerUnionRecordsSync(stateDir, {
    step: [...new Set([...steps, kind.receiptStep, kind.escalatedStep, PR_TERMINAL_STEP])], requireArchives: true, refuseIncomplete: true,
  });
  if (!read.ok) throw new Error(`${kind.stem} ledger union unreadable: ${read.unread.join(", ") || "missing or incomplete rotations"}`);
  return read.rows as LedgerRecord[];
}

export function readLadderPlan(repoRoot: string, kind: LadderKind): CiFrictionPlanState {
  const git = (args: string[]) => execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  let degraded: string | undefined;
  try { git(["fetch", "--quiet", "--no-write-fetch-head", "origin", "+refs/heads/main:refs/remotes/origin/main"]); }
  catch (error) {
    const reason = `fetch failed (${String(error)}); read the last fetched origin/main`;
    degraded = reason;
  }
  const shards = relative(repoRoot, join(resolveRepoLayout(repoRoot).planDir, "tasks.d"));
  let listed = "";
  try { listed = git(["grep", "-l", "-E", `^[[:space:]]*origin:[[:space:]]*[\"']?${kind.prefix}:`, "origin/main", "--", shards]); }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  const tasks: Array<CiFrictionRemedyTask & RetirementDated> = [];
  const unreadable: string[] = [];
  for (const path of listed.trim().split("\n").filter(Boolean).map(p => p.replace("origin/main:", ""))) {
    try {
      // W1-T12025: one shard is not a plan. `loadPlanFromYaml` resolves depends_on and superseded_by inside the blob
      // it is given, so a ladder shard naming a task in another shard read as unreadable and failed the pass
      // (W1-T11062 superseded_by W1-T11172, 2026-11-10). The shard's own schema is still checked here.
      const text = git(["show", `origin/main:${path}`]);
      for (const task of parseTasksFromYaml(text, path)) {
        if (!task.origin || !parseOrigin(kind, task.origin)) continue;
        const reopensAt = task.retirement !== undefined ? retirementReopensAt(text) : undefined;
        tasks.push({ id: task.id, origin: task.origin, status: task.status, retired: task.retirement !== undefined,
          files: [...(task.files ?? [])], path, ...(reopensAt ? { reopensAt } : {}) });
      }
    } catch (error) {
      const reason = `${path}: ${String(error)}`;
      unreadable.push(reason);
    }
  }
  const merges = bodyCreditedMergeTimes(git, "origin/main", tasks.map(task => task.id));
  for (const task of tasks) {
    const mergedAt = merges.get(task.id);
    if (mergedAt) task.mergedAt = mergedAt;
  }
  return { tasks, degraded, unreadable };
}

export function readOutcomes(prs: readonly number[], sources: FlowGardenSources): ReadonlyMap<number, PrOutcome> {
  const result = new Map<number, PrOutcome>();
  // W1-T5538: one batched read per fifty PRs; a missing merger remains unknown, never owner-cleared.
  for (let offset = 0; offset < prs.length; offset += 50) {
    const batch = prs.slice(offset, offset + 50);
    const query = `query { repository(owner:${JSON.stringify(sources.owner)}, name:${JSON.stringify(sources.repo)}) { ${batch.map(pr =>
      `p${pr}:pullRequest(number:${pr}) { state mergedAt closedAt mergedBy { login } }`).join(" ")} } }`;
    const body = JSON.parse(ghExec(["api", "graphql", "-f", `query=${query}`], { encoding: "utf8" }));
    if (body.errors) throw new Error("flow PR outcomes unreadable: GraphQL errors");
    if (body.data === undefined || body.data === null) throw new Error("flow PR outcomes unreadable: data missing");
    const repository = body.data.repository;
    if (repository === undefined || repository === null) throw new Error("flow PR outcomes unreadable: repository missing");
    for (const pr of batch) {
      const row = repository[`p${pr}`];
      if (!row || !["OPEN", "CLOSED", "MERGED"].includes(row.state)) throw new Error(`flow PR #${pr} outcome missing`);
      result.set(pr, { state: row.state.toLowerCase(), at: row.mergedAt ?? row.closedAt ?? undefined, mergedBy: row.mergedBy?.login });
    }
  }
  return result;
}

/** W1-T14140: the checks a `sweep.disposed` row names red — its `red_checks` when it carries them (written only on a pass
 *  that dispatched a fix, W1-T4459), else the `<check> failed on <sha>` clauses describeCiFailures writes. `required checks
 *  red`, the reason for every PR whose rollup reads red, names none, so such a row joins a hand-off by its head alone. */
export function redChecksOf(row: LedgerRecord): string[] {
  if (Array.isArray(row.red_checks)) return row.red_checks.filter((check): check is string => typeof check === "string");
  return String(row.reason ?? "").split("; ")
    .flatMap((clause) => /^(.+?) failed on [0-9a-f]{7,40}(?= — |$)/i.exec(clause)?.[1] ?? []);
}

/** A hand-off's checks by PR, one entry per red head ({@link CI_LESSON_HANDOFF_STEP}'s `red_heads`). */
function handedOffChecks(records: readonly LedgerRecord[]): Map<number, { gate: string; sha: string }[]> {
  const byPr = new Map<number, { gate: string; sha: string }[]>();
  for (const { step, gate, red_heads: heads } of records) {
    if (step !== CI_LESSON_HANDOFF_STEP || typeof gate !== "string" || !Array.isArray(heads)) continue;
    for (const head of heads) {
      if (!head || !Number.isSafeInteger(head.pr) || head.pr <= 0 || typeof head.sha !== "string" || !head.sha) continue;
      const checks = byPr.get(head.pr) ?? [];
      checks.push({ gate, sha: head.sha });
      byPr.set(head.pr, checks);
    }
  }
  return byPr;
}

function flowEpisodeEvidence(records: readonly LedgerRecord[], now: number) {
  const rounds = new Map<number, number[]>();
  const terminals = new Map<number, PrOutcome>();
  for (const row of records) {
    if (row.step === undefined || (row.step !== PR_TERMINAL_STEP && !FLOW_ROUND_STEPS.has(row.step))) continue;
    const pr = rowPrNumber(row);
    if (pr === undefined || !Number.isSafeInteger(pr) || pr <= 0) continue;
    if (row.step === PR_TERMINAL_STEP) {
      if (row.state !== "closed" && row.state !== "merged") continue;
      const at = row.state === "merged" ? row.merged_at : row.closed_at;
      const previous = terminals.get(pr);
      if (typeof at === "string" && Date.parse(at) <= now && (!previous || Date.parse(at) >= Date.parse(previous.at!))) {
        terminals.set(pr, { state: row.state, at });
      }
    } else {
      if (row.step === "review.posted" &&
        (row.status_recovered === true || row.status_confirmed === true || row.review_source === "github-comment")) continue;
      const at = Date.parse(row.ts ?? "");
      if (Number.isFinite(at) && at <= now) {
        const times = rounds.get(pr) ?? [];
        times.push(at);
        rounds.set(pr, times);
      }
    }
  }
  return { rounds, terminals };
}

function flowTerminal(ledger: PrOutcome | undefined, current: PrOutcome | undefined): PrOutcome | undefined {
  // An open PR can have an earlier close receipt from before it was reopened.
  if (!ledger || current?.state === "open" || (current && current.state !== ledger.state)) return current;
  return { ...current, ...ledger };
}

/** The ordinary flow ladder joins owner actions and terminal cutoffs. The fix-lane ladder uses the observed pass gaps. */
export function episodesOf(records: readonly LedgerRecord[], outcomes: ReadonlyMap<number, PrOutcome>, now: number, forFlowRemedy = false): Episode[] {
  const byPr = new Map<number, LedgerRecord[]>();
  const handoffs = handedOffChecks(records);
  const evidence = forFlowRemedy ? flowEpisodeEvidence(records, now) : undefined;
  for (const r of records) {
    if (r.step !== "sweep.disposed" || !Number.isSafeInteger(r.pr_number) || Number(r.pr_number) <= 0 ||
        !PR_BLOCKERS.includes(r.blocker as PrBlocker) || typeof r.ts !== "string" || !Number.isFinite(Date.parse(r.ts)) ||
        Date.parse(r.ts) > now || typeof r.reason !== "string" || typeof r.blocker_owner !== "string") continue;
    const pr = Number(r.pr_number);
    const rows = byPr.get(pr) ?? [];
    rows.push(r);
    byPr.set(pr, rows);
  }
  const episodes: Episode[] = [];
  for (const [pr, observations] of byPr) {
    const rows = [...new Map(observations.sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!)).map(r => [r.ts!, r])).values()];
    const terminal = forFlowRemedy ? flowTerminal(evidence?.terminals.get(pr), outcomes.get(pr)) : outcomes.get(pr);
    const terminalAt = Date.parse(terminal?.at ?? "");
    const cutoff = forFlowRemedy && terminal?.state !== "open" && Number.isFinite(terminalAt) ? terminalAt : Infinity;
    const actions = evidence ? [
      ...(evidence.rounds.get(pr) ?? []),
      ...observations.filter(row => row.acted === true).map(row => Date.parse(row.ts!)),
    ] : [];
    const actedDuring = (from: number, to: number) => actions.some(at => at >= from && at < to);
    let episode: Episode | undefined;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const start = Date.parse(r.ts!);
      if (start >= cutoff) break;
      const key = `${r.blocker}:${reasonClass(String(r.reason))}`;
      if (!episode || episode.key !== key || episode.owner !== r.blocker_owner) {
        if (episode) {
          episode.outcome = "cleared";
          episode.end = start;
          if (episode.flow) episode.flow.ownerActed = actedDuring(episode.start, start);
        }
        episode = { pr, key, owner: String(r.blocker_owner), start, end: start, outcome: "open", eligible: false, charges: [] };
        if (forFlowRemedy) episode.flow = { ownerActed: false, waitOnly: true };
        episodes.push(episode);
      }
      if (episode.flow) episode.flow.waitOnly &&= r.disposition === "wait";
      // Join the evidence on the PR: the row is the handed check's when it names that check, or when it was written at a
      // head where the check read red. Sweep gives one aggregate reason for most red rollups and names no check in it.
      const named = redChecksOf(r);
      const handed = r.blocker === "own-red" && handoffs.get(pr)?.some(({ gate, sha }) => named.includes(gate) || r.head_sha === sha) === true;
      if (handed) episode.handedOff = true;
      const next = rows[i + 1];
      if (next) {
        const end = Math.min(Date.parse(next.ts!), cutoff);
        episode.end = end;
        episode.charges.push({ pr, key, start, end, hours: (end - start) / 3_600_000, reason: String(r.reason), owner: episode.owner,
          ...(handed ? { handedOff: true } : {}) });
      }
    }
    if (!episode) continue;
    if (episode.flow) episode.flow.ownerActed = actedDuring(episode.start, cutoff);
    if (terminal && terminal.state !== "open") {
      episode.end = Number.isFinite(terminalAt) ? Math.max(episode.end, terminalAt) : episode.end;
      episode.outcome = terminal.state === "closed" ? "failed" : terminal.mergedBy === undefined ? "unknown" : isFleet(terminal.mergedBy) ? "cleared" : "failed";
    }
  }
  return episodes;
}

function priceEpisodes(episodes: readonly Episode[], now: number): Price[] {
  const byKey = new Map<string, { hours: number; prs: Set<number>; owners: Set<string> }>();
  for (const episode of episodes) {
    const hours = episode.charges.reduce((sum, c) => sum + c.hours * ciFrictionRecencyWeight(fixedClock(c.end).iso(), now), 0);
    if (hours <= 0) continue;
    const price = byKey.get(episode.key) ?? { hours: 0, prs: new Set<number>(), owners: new Set<string>() };
    price.hours += hours; price.prs.add(episode.pr); price.owners.add(episode.owner);
    byKey.set(episode.key, price);
  }
  return [...byKey].map(([key, p]) => ({ key, hours: p.hours, prs: p.prs.size, owners: [...p.owners].sort() }))
    .sort((a, b) => b.hours - a.hours || b.prs - a.prs || a.key.localeCompare(b.key));
}

/** W1-T12548: an open own-red episode older than this is eligible whatever the p90 of cleared ones is. */
export const FLOW_OWN_RED_OPEN_AGE_MS = 60 * 60_000;

function excludedFromFlowRemedy(e: Episode): boolean {
  return e.flow !== undefined && (e.flow.ownerActed || e.flow.waitOnly || e.key.startsWith("held-draft:"));
}

/** Marks which episodes are worth a remedy: no owner, a failed end, an open wait past the p90 of cleared ones,
 *  or an own-red episode open past {@link FLOW_OWN_RED_OPEN_AGE_MS}. */
export function markEligibility(episodes: Episode[], now: number): Map<string, number> {
  const thresholds = new Map<string, number>();
  for (const key of new Set(episodes.map(e => e.key))) {
    const cleared = episodes.filter(e => e.key === key && e.owner !== "NONE" && e.outcome === "cleared")
      .map(e => (e.end - e.start) / 3_600_000).sort((a, b) => a - b);
    if (cleared.length) thresholds.set(key, cleared[Math.ceil(cleared.length * 0.9) - 1]!);
  }
  for (const e of episodes) {
    const threshold = thresholds.get(e.key);
    const arm = excludedFromFlowRemedy(e) ? undefined
      : e.owner === "NONE" ? "unowned"
      : e.outcome === "failed" ? "failed"
      : e.outcome === "open" && threshold !== undefined && (now - e.start) / 3_600_000 > threshold ? "past p90"
      : e.outcome === "open" && e.key.startsWith("own-red:") && now - e.start > FLOW_OWN_RED_OPEN_AGE_MS ? "open own-red"
      : undefined;
    e.eligible = arm !== undefined;
    if (e.flow) e.flow.eligibilityArm = arm;
  }
  return thresholds;
}

function inventoryOf(records: readonly LedgerRecord[], tasks: readonly CiFrictionRemedyTask[], outcomes: ReadonlyMap<number, PrOutcome>,
  now: number, fileable?: LadderFileable): Inventory {
  const episodes = episodesOf(records, outcomes, now, true);
  const thresholds = markEligibility(episodes, now);
  return ladderOf(FLOW_LADDER, episodes, records, tasks, now, thresholds, fileable);
}

/** What an episode puts up for a remedy: all of an eligible episode, else only the charges a CI-lesson hand-off names
 *  (W1-T14140). One aggregate-red episode can span heads where different checks read red; the hand-off owns only its own. */
function eligibleSlice(e: Episode): Episode[] {
  if (excludedFromFlowRemedy(e)) return [];
  if (e.eligible) return [e];
  const handed = e.charges.filter(c => c.handedOff);
  return handed.length ? [{ ...e, charges: handed }] : [];
}

function flowEligibilityCounts(episodes: readonly Episode[]): Record<EligibilityArm, number> {
  const counts = { unowned: 0, failed: 0, "past p90": 0, "open own-red": 0, "CI hand-off": 0 };
  for (const episode of episodes) counts[episode.flow?.eligibilityArm ?? "CI hand-off"]++;
  return counts;
}

/**
 * The shared rung logic: price the episodes' cause keys, find each cause's remedy among the plan's tasks, measure the
 * effect of a merged one, and name the next draft or escalation. A cause with a remedy still open drafts nothing.
 * W1-T12548: a draft `fileable` refuses is `skipped` with its reason and the walk goes on; an escalation is never skipped.
 * W1-T12838: a top record retired by rule 2 (cause stopped) or withdrawn reads as retired only until a charge on its cause
 * ends after that retirement; from then the cause drafts at the next rung, as a debit does.
 */
export function ladderOf(kind: LadderKind, episodes: Episode[], records: readonly LedgerRecord[], tasks: readonly (CiFrictionRemedyTask & RetirementDated)[],
  now: number, thresholds: ReadonlyMap<string, number> = new Map(), fileable?: LadderFileable): Inventory {
  const charges = episodes.flatMap(e => e.charges);
  const priced = priceEpisodes(episodes, now);
  const eligible = episodes.flatMap(eligibleSlice);
  const ordinaryFlow = kind.prefix === FLOW_LADDER.prefix;
  const recentCauses = ordinaryFlow ? new Set(eligible.flatMap(e => e.charges)
    .filter(c => Math.min(c.end, now) > Math.max(c.start, now - REMEDY_WIDENED_BEFORE_WINDOW_MS)).map(c => c.key)) : undefined;
  const candidates = priceEpisodes(eligible, now).filter(p => recentCauses === undefined || recentCauses.has(p.key))
    .map(p => ({ ...p, thresholdHours: thresholds.get(p.key) }));
  const ladder: Inventory["ladder"] = [];
  let next: FlowAction | undefined;
  // A filing PR the sweep recorded closed unmerged (`pr.terminal`, W1-T5318) holds nothing: its cause drafts again.
  const closedUnmerged = new Set(records.filter(r => r.step === PR_TERMINAL_STEP && r.state !== "merged").map(r => Number(r.pr_number)));
  const receipts = new Set(records.filter(r => r.step === kind.receiptStep && typeof r.pr_url === "string" && /\/pull\/\d+$/.test(r.pr_url)
      && !closedUnmerged.has(Number(/(\d+)$/.exec(r.pr_url)![1])))
    .map(r => (r.next as { origin?: string } | undefined)?.origin).filter((s): s is string => typeof s === "string"));
  const escalated = new Set(records.filter(r => r.step === kind.escalatedStep && typeof r.issue_url === "string").map(r => r.origin));
  for (const price of candidates) {
    const mine = tasks.filter(t => parseOrigin(kind, t.origin)?.[1] === price.key);
    const top = [...mine].sort((a, b) => Number(parseOrigin(kind, b.origin)?.[2] ?? 1) - Number(parseOrigin(kind, a.origin)?.[2] ?? 1))[0];
    let rung = top ? Number(parseOrigin(kind, top.origin)?.[2] ?? 1) : 1;
    let state = "draft";
    let effect: RemedyEffect | undefined;
    let prior: Prior | undefined;
    let unverifiable: string | undefined;
    if (mine.some(t => !t.retired && !t.mergedAt)) state = "in_progress";
    else if (top?.retired && !top.mergedAt) {
      const reopensAt = Date.parse(top.reopensAt ?? "");
      if (Number.isFinite(reopensAt) && charges.some(c => c.key === price.key && c.end > reopensAt)) { rung++; prior = { task: top }; }
      else state = "retired";
    }
    else if (top?.mergedAt) {
      // expiring-fixture: exempt -- effect fixtures use an injected fixed Clock, independent of wall time
      const merge = Date.parse(top.mergedAt);
      if (!Number.isFinite(merge)) state = "in_progress";
      else {
        // W1-T9060: ONE measurement for every ladder. An `unmeasurable` effect is never `resolved`: it keeps measuring, and
        // once the after-window is full it escalates "effect unverifiable" to a person.
        effect = kind.shadowAdmission ? admissionEffect(records, price.key, merge, now)
          : measureRemedy(top, prHoursMetric(kind.name, kind.prefix, charges), merge, now).effect;
        const afterFull = now - merge >= CI_FRICTION_EFFECT_MAX_WINDOW_MS;
        state = effect.verdict === "credit" ? "resolved" : effect.verdict === "debit" ? "draft" : "measuring";
        if (effect.verdict === "unmeasurable" && afterFull) {
          state = "escalate"; prior = { task: top, effect };
          unverifiable = `effect unverifiable: ${effect.reason}`;
        }
        if (state === "draft") { rung++; prior = { task: top, effect }; }
      }
    }
    const origin = originOf(kind, price.key, rung);
    if (receipts.has(origin) && !mine.some(t => t.origin === origin)) state = "in_progress";
    if (escalated.has(origin)) state = "escalated";
    if (state === "draft" && rung >= (kind.shadowAdmission ? 2 : CI_FRICTION_ESCALATE_RUNG)) state = "escalate";
    const causeEpisodes = !next && (state === "draft" || state === "escalate") ? eligible.filter(e => e.key === price.key) : undefined;
    const action: FlowAction | undefined = causeEpisodes ? {
      class: "draft", target: origin, origin, rung, price, prior,
      charges: causeEpisodes.flatMap(e => e.charges),
      ...(ordinaryFlow ? { eligibilityCounts: flowEligibilityCounts(causeEpisodes) } : {}),
      population: candidates.map(p => p.hours), reason: `${price.key} cost ${price.hours.toFixed(2)} PR-hours; owner ${price.owners.join(", ")}`,
      ...(state === "escalate" ? { escalation: unverifiable ?? `${rung - 1} remedy rungs did not reduce the share of PR-hours` } : {}) } : undefined;
    const skipped = action && state === "draft" ? fileable?.(action) : undefined;
    ladder.push({ cause: price.key, state: skipped === undefined ? state : "skipped", rung, effect, ...(skipped === undefined ? {} : { reason: skipped }) });
    if (action && skipped === undefined) next = action;
  }
  return { episodes, charges, priced, candidates, ladder, next };
}

/** W1-T9597 — a PR blocker's remedy is owned by the module its declared owner names (`PR_BLOCKER_OWNER_MODULES`), read
 *  off the charges' `blocker_owner`; no text search runs. No module, or charges naming several owners, is no owner. */
function declaredOwnerFile(action: FlowAction, kind: LadderKind): { file: string; line: string } {
  const owners = [...new Set([...action.charges.map(c => c.owner), ...action.price.owners])].sort();
  const file = owners.length === 1 ? blockerOwnerModule(owners[0]!) : undefined;
  if (file === undefined) {
    throw new Error(`${kind.stem} gardener: no source owner found for ${action.price.key}: declared owner ` +
      `${owners.join(", ") || "(none)"} names no module in PR_BLOCKER_OWNER_MODULES`);
  }
  return { file, line: `${owners[0]} → ${file}` };
}

/** The owner choice, factored out of {@link draftShard} so a ladder can read the owner file before it drafts. */
function chooseOwner(action: FlowAction, search: OwnerSearch, kind: LadderKind): { owner?: { file: string; line: string }; files: { file: string; hits: number }[] } {
  const [blocker, ...reason] = action.price.key.split(":");
  const owner = kind.declaredOwners && PR_BLOCKERS.includes(blocker as PrBlocker) ? declaredOwnerFile(action, kind) : undefined;
  const matches = owner ? [{ file: owner.file, hits: 0 }] : search.filesContaining(reason.join(":"));
  const found = matches.length ? matches : search.filesContaining(blocker!);
  const files = (found.length ? found : (kind.fallbackFiles ?? []).filter(f => search.fileExists(f)).map(file => ({ file, hits: 0 })))
    .sort((a, b) => b.hits - a.hits || a.file.localeCompare(b.file));
  if (!files.length) throw new Error(`${kind.stem} gardener: no source owner found for ${action.price.key}`);
  return { ...(owner ? { owner } : {}), files };
}

/**
 * W1-T11097 — a reason the ladder cannot scope a remedy to `ownerFile`, or undefined when it can: the file is not a
 * source module (a data file, a test, a doc), is one of the ladder's own measuring modules (the remedy would only
 * relabel the classifier), or is the file a prior remedy whose effect did not fall already used.
 */
export function remedyScopeRefusal(ownerFile: string, kind: LadderKind, prior?: Prior): string | undefined {
  if (!/^(src|scripts)\/.+\.(ts|mts|js|mjs)$/.test(ownerFile)) {
    return `the owner file ${ownerFile} is not a source module (a .ts, .mts, .js or .mjs file under src/ or scripts/)`;
  }
  if (kind.ownModules?.includes(ownerFile)) {
    return `the owner file ${ownerFile} is the ${kind.name} ladder's own classifier; a remedy scoped to it only relabels the cause`;
  }
  if (prior && prior.task.files[0] === ownerFile) {
    return `the owner file ${ownerFile} is the file previous remedy ${prior.task.id} already used and its effect did not fall`;
  }
  return undefined;
}

export function draftShard(action: FlowAction, taskId: string, search: OwnerSearch, kind: LadderKind): string {
  const { owner, files } = chooseOwner(action, search, kind);
  const stem = slug(flowCauseLabel(action.price.key), 80);
  const testPath = newTestPath(`${kind.stem}-${stem}`, [files[0]!.file], "flow-remedy-gardener");
  const evidence = new Map<number, { hours: number; reason: string }>();
  for (const c of action.charges) {
    const prior = evidence.get(c.pr);
    evidence.set(c.pr, { hours: (prior?.hours ?? 0) + c.hours, reason: c.reason });
  }
  return renderMachineShard({ taskId, origin: action.origin,
    title: kind.title(action),
    files: [files[0]!.file, testPath], cost: action.price.hours, costPopulation: action.population,
    acceptance: [{ claim: kind.claim(action.price.key),
      proof: `grep: test("${taskId}: ${kind.stem}-${stem} clears without a person" in ${testPath}` }],
    invariants: { declared: [{ slug: "other-blockers-still-hold",
      statement: `the remedy clears ${flowCauseLabel(action.price.key)} and nothing else; a PR held by any other blocker is still held exactly as before.`,
      claim: `a PR held by a blocker other than ${flowCauseLabel(action.price.key)} is still held after the change`,
      proof: `grep: test("${taskId}: ${kind.stem}-${stem} leaves other blockers held" in ${testPath}` }] },
    note: `Filed by ${kind.stem} at rung ${action.rung}; measure the cause's share of PR-hours after the build merges.`,
    rationale: [action.reason, kind.ownerLine(action),
      `Source owner: ${owner?.line ?? files[0]!.file}. Top five PRs by observed hours, with original blocker reasons:`,
      ...[...evidence].sort((a, b) => b[1].hours - a[1].hours || a[0] - b[0]).slice(0, 5)
        .map(([pr, e]) => kind.evidenceLine(pr, e.hours, e.reason)),
      ...(action.prior ? [`Previous remedy ${action.prior.task.id}: ${action.prior.task.files.join(", ")}; ${action.prior.effect?.reason}. Take a structurally different remedy.`] : []),
      "Effect compares this cause's share of total PR-hours in equal windows before and after its build merge; a debit reopens one rung up.",
    ],
  }).text;
}

/** What a ladder garden supplies: its kind, how to read its inventory, and the filing seams. */
export interface LadderSpecInput {
  kind: LadderKind;
  sources: Pick<FlowGardenSources, "mintTaskId" | "ownerSearch" | "draftShard" | "escalate">;
  /** W1-T12548: `ladderGardenSpec` passes the `fileable` check a ladder hands to {@link ladderOf}. */
  inventory: (fileable?: LadderFileable) => Inventory;
  inventoryAsync?: (fileable?: LadderFileable) => Promise<Inventory>;
  /** The pacing bucket the cheap fingerprint carries; the flow ladder re-reads hourly, the fix-lane ladder daily. */
  bucket?: (clock: Clock) => number;
  /** Called once per pass with the scorecard the pass is about to log (the fix-lane garden writes its report here). */
  onScorecard?: (inventory: Inventory, scorecard: Record<string, unknown>) => void;
}

/** The draft -> measure -> escalate ladder as a garden spec (W1-T7421: one implementation for every ladder). */
export function ladderGardenSpec(deps: GardenerDeps, input: LadderSpecInput): GardenSpec<"draft", Inventory, FlowAction, GardenCheckout> {
  const { kind, sources } = input;
  const clock = deps.clock ?? systemClock;
  const bucket = input.bucket ?? gardenLedgerBucket;
  const searchOf = (): OwnerSearch => sources.ownerSearch ?? gitCiFrictionOwnerSearch(args => execFileSync("git", ["-C", deps.repoRoot, ...args], { encoding: "utf8", timeout: 60_000 }));
  // An owner the search cannot name is left to draftShard, which throws its own "no source owner" error.
  const scopeRefusalOf = (action: FlowAction): string | undefined => {
    let file: string;
    try { file = chooseOwner(action, searchOf(), kind).files[0]!.file; } catch (err) {
      // No nameable owner is not a scope refusal: draftShard re-runs the same choice and throws "no source owner found" itself.
      void err; return undefined;
    }
    return remedyScopeRefusal(file, kind, action.prior);
  };
  // W1-T12548: a draft with no nameable owner, or a refused owner file, is skipped for this pass instead of filed.
  const fileable: LadderFileable = action => {
    let file: string;
    try { file = chooseOwner(action, searchOf(), kind).files[0]!.file; } catch (err) {
      if (!(err instanceof Error) || !/no source owner found/.test(err.message)) throw err;
      return err.message;
    }
    return remedyScopeRefusal(file, kind, action.prior);
  };
  const logSkips = (inv: Inventory): Inventory => {
    for (const rung of inv.ladder) {
      if (rung.state === "skipped") deps.log(`${kind.name}.cause_skipped`, { cause: rung.cause, rung: rung.rung, reason: rung.reason });
    }
    return inv;
  };
  const inventoryAsync = input.inventoryAsync;
  return {
    name: kind.name, landingRefusal: machineShardLandingGuard(deps, sources.ownerSearch?.fileExists), classes: ["draft"], review: { draft: "a remedy task is a judgement call for the machine-filing judge or a person" },
    cheapFingerprint: () => {
      const head = checkoutHeadStamp(deps.repoRoot, clock);
      const archives = ledgerRotationEntries(readdirSync(deps.stateDir), deps.stateDir).map(e => {
        const s = statSync(e.path); return `${basename(e.path)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.mode}`;
      }).join("|");
      return `${head}:${bucket(clock)}:${archives}`;
    },
    inventory: () => logSkips(input.inventory(fileable)),
    ...(inventoryAsync ? { inventoryAsync: async () => logSkips(await inventoryAsync(fileable)) } : {}),
    unfinished: inv => inv.next !== undefined,
    fingerprint: inv => `${inv.candidates.map(p => `${p.key}:${p.hours}`).join(",")}|${inv.next?.origin ?? ""}`,
    candidates: inv => inv.next ? [inv.next] : [],
    scorecard: inv => {
      const scorecard = { causes: inv.priced.length, total_pr_hours: inv.priced.reduce((sum, p) => sum + p.hours, 0),
        priced: inv.priced.map(({ key, hours }) => ({ key, hours })),
        next: inv.next ? { origin: inv.next.origin, rung: inv.next.rung } : null, ladder: inv.ladder };
      input.onScorecard?.(inv, scorecard);
      return scorecard;
    },
    prepare: (ws, plan, async) => prepareGardenTaskIds(ws, plan.actions[0] && !plan.actions[0].admissionShadow && !plan.actions[0].escalation && scopeRefusalOf(plan.actions[0]) === undefined ? 1 : 0, sources.mintTaskId, async),
    apply: (ws, plan, _scorecard, heldIds) => {
      const action = plan.actions[0];
      if (!action) return undefined;
      if (action.admissionShadow) { recordAdmissionFlowProposal(deps, action); return undefined; }
      const escalationReason = action.escalation ?? scopeRefusalOf(action);
      if (escalationReason !== undefined) {
        const escalation: Escalation = { class: "BLOCKED", taskId: `${kind.stem}-${slug(action.price.key, 60)}`,
          summary: kind.escalationSummary(action.price.key), detail: `${action.reason}\n${escalationReason}\n${action.prior?.effect?.reason ?? ""}`,
          options: [{ label: "design-remedy", detail: "name a structural remedy and file it" }, { label: "accept-cost", detail: `retire ${action.origin}` }],
          recommendation: "design-remedy", headDedup: "independent" };
        const issue = sources.escalate ? sources.escalate(escalation) : deps.escalate?.(escalation);
        deps.log(kind.escalatedStep, { origin: action.origin, rung: action.rung, reason: escalationReason, issue_url: issue ?? null });
        return undefined;
      }
      if (!ws.branch) throw new Error(`${kind.stem} gardener: filing workspace has no reservation branch`);
      const id = (heldIds ?? prepareGardenTaskIds(ws, 1, sources.mintTaskId) as string[])[0]!;
      const search = searchOf();
      const contents = sources.draftShard ? sources.draftShard(action, id) : draftShard(action, id, search, kind);
      const verdict = ciFrictionRecordVerdict(contents, `${kind.stem}:${id}`);
      if (!verdict.ok) throw new Error(`${kind.stem} gardener: drafted record failed lint (${verdict.reason})`);
      const dir = join(resolveRepoLayout(ws.root).planDir, "tasks.d");
      const path = join(dir, `${id}-${kind.stem}-${slug(flowCauseLabel(action.price.key), 80)}.yaml`);
      // lint-plan's verdict before the draft reaches disk; the spec's `landingRefusal` re-reads the landing.
      const refused = machineShardFilingRefusal(contents, relative(ws.root, path), {
        pathExists: p => existsSync(join(ws.root, p)) || existsSync(join(deps.repoRoot, p)),
        pathExistsAtBase: search.fileExists
      });
      if (refused !== undefined) throw new Error(`${kind.stem} gardener: drafted record failed machine-filing admission (${refused})`);
      mkdirSync(dir, { recursive: true }); writeFileSync(path, contents);
      const relPath = relative(ws.root, path);
      const originPattern = JSON.stringify(action.origin).slice(1, -1).replace(/[.\[\]*^$\\]/g, "\\$&");
      return { paths: [relPath], title: kind.commitTitle(slug(action.price.key, 55)),
        body: `${action.reason}\n\nAcceptance:\n- the costliest unowned blocker is filed once | grep: ${originPattern} in ${relPath}` };
    },
  };
}

/** W1-T5538: prices observed PR waits and files one admitted remedy for an unowned or uncleared cause. */
export function flowGardenSpec(deps: GardenerDeps, sources: FlowGardenSources): GardenSpec<"draft", Inventory, FlowAction, GardenCheckout> {
  const clock = deps.clock ?? systemClock;
  const inventory = (fileable?: LadderFileable): Inventory => {
    const records = sources.ledgerRecords ? sources.ledgerRecords()
      : readLadderRecords(deps.stateDir, FLOW_LADDER, ["sweep.disposed", CI_LESSON_HANDOFF_STEP, ...FLOW_ROUND_STEPS]);
    const plan = sources.planState ? sources.planState() : readLadderPlan(deps.repoRoot, FLOW_LADDER);
    if (plan.degraded) deps.log("flow.origins_degraded", { reason: plan.degraded });
    if (plan.unreadable?.length) throw new Error(`flow plan shards unreadable: ${plan.unreadable.join(", ")}`);
    const prs = [...new Set(episodesOf(records, new Map(), clock.now()).filter(e => e.outcome === "open").map(e => e.pr))];
    const outcomes = sources.prOutcomes ? sources.prOutcomes(prs) : readOutcomes(prs, sources);
    return inventoryOf(records, plan.tasks, outcomes, clock.now(), fileable);
  };
  const admission = sources.admission;
  const enabled = admission?.settings?.mode === "shadow" && admission.settings.disposition === "shadow";
  return ladderGardenSpec(deps, {
    kind: FLOW_LADDER, sources,
    inventory,
    ...(enabled ? { inventoryAsync: async (fileable?: LadderFileable): Promise<Inventory> => {
      const ordinary = inventory(fileable);
      try {
        const report = await observeAdmissionFlow(deps, admission);
        const records = sources.ledgerRecords ? sources.ledgerRecords() : readLadderRecords(deps.stateDir, ADMISSION_FLOW_LADDER, [ADMISSION_FLOW_STEP]);
        const plan = sources.planState ? sources.planState() : readLadderPlan(deps.repoRoot, ADMISSION_FLOW_LADDER);
        if (plan.degraded || plan.unreadable?.length) throw new Error("admission-plan-unreadable");
        // The default plan status/trailer-only history cannot manufacture a build merge. A
        // bounded current PR window credits both the exact trailer and independent run branch;
        // a missing/older credit holds only the next admission rung as unmeasured.
        const tasks = sources.planState ? plan.tasks : plan.tasks.map(t => ({ ...t, mergedAt: report.mergeCredits[t.id] }));
        const shadow = admissionFlowInventory(report, records, tasks, clock.now());
        if (shadow.next) {
          const effect = shadow.next.escalation ? "owner-judgment" : "remedy";
          const token = join(deps.stateDir, "admission-flow-shadow-intents", `${shadow.next.price.key}-${effect}.json`);
          // A previous intent, readable or not, is a spent proposal budget, not an open-PR hold.
          if (existsSync(token)) shadow.next = undefined;
        }
        return { ...ordinary, episodes: [...ordinary.episodes, ...shadow.episodes], charges: [...ordinary.charges, ...shadow.charges],
          priced: [...ordinary.priced, ...shadow.priced], candidates: [...ordinary.candidates, ...shadow.candidates],
          ladder: [...ordinary.ladder, ...shadow.ladder], next: ordinary.next ?? shadow.next };
      } catch { // Admission evidence loss holds only its proposal; ordinary trusted flow remains available.
        deps.log("admission_flow.proposal_unknown", { reason: "admission-inventory-unreadable", permission: "not-granted" }); return ordinary;
      }
    } } : {}),
  });
}
