import { stampVerificationAsk } from "./inbox-retirement.js";
/**
 * lib/machine-filing-judge.ts — the LLM judge in the middle of machine-filed work (operator ruling
 * 2026-09-29, DECISIONS.md).
 *
 * Every machine filer writes the shared header in machine-filing.ts, so a new record arrives
 * UNJUDGED at `verify: human`. This pass asks the risk judge about each one and pins the answer ON
 * THE RECORD as W1-T2977's `risk_ruling`, which `machineAuthorVerifyViolation` already reads:
 *   proceed    -> `verify: auto` with the pinned ruling: dispatchable, no person asked.
 *   escalate   -> stays `verify: human` with the pinned ruling, and the reasons reach the inbox.
 *   no verdict -> nothing is written; the record stays parked and is asked again next pass.
 *
 * WHY ON THE RECORD AND NOT A LEDGER ROW. The verify-human release writes `ratify.approved`, and
 * the daemon reads releases from the LIVE ledger, which compaction prunes. Measured 2026-09-29: 151
 * task ids carry a release row across the rotations, 76 in the live ledger, so 75 releases had
 * silently lapsed. A pinned ruling rides git; it cannot age out, and an edit to the record changes
 * its pin, which re-opens the question.
 *
 * A PARKED ESCALATION IS ASKED AGAIN (W1-T8830). On 2026-10-12, 18 escalations sat in the inbox,
 * some since 2026-10-03, because only an edit re-opened them. The pin stays on the record. Beside it,
 * the judge's state keeps the inputs each parked escalation was judged on and a re-ask schedule
 * ({@link reaskIntervalMs}). The judge asks again when an input moves or the schedule falls due.
 * An unchanged answer writes nothing; a changed one lands through the one judge PR and is re-pinned.
 *
 * EARNED AUTONOMY, NO FIXED BAR. Each filer family's record (its merged tasks, its declined ones,
 * and its gardener's Beta credit where it keeps one) is shown to the judge and sets how confident
 * a `low` verdict must be: {@link earnedConfidenceBar}. A family that keeps helping is trusted
 * more, one that keeps failing less, and either recovers as its outcomes move.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { Clock } from "./clock.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import { fetchOriginRetryingRefLock } from "./git-fetch-retry.js";
import { ghExec } from "./github-transport.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { hostWorktreeGit, hostWorktreeGitAsync } from "./worktree-git.js";
import type { GardenWorkspacePort, PrState } from "./gardener.js";
import type { Proposal } from "./inbox.js";
import { machineFilingAdmissionViolations, parseTasksFromYaml, type MachineFilingAdmissionContext, type Plan, type Task } from "./plan.js";
import {
  buildFilingRiskJudgeInput,
  DEFAULT_RISK_POLICY,
  planRiskJudgeAction,
  recordFilingRiskRuling,
  type FilingRiskRuling,
  type RiskJudgeInput,
  type RiskJudgeVerdict,
  type RiskPolicy,
} from "./risk-judge.js";
import { deterministicEscalation, UNPRICED_PRIORITY, withoutRulingBlock } from "./machine-filing.js";
import {
  FLAKE_INCIDENT_MAIN_INHERITED_STEP, flakeIncidentMainInherited, type FlakeIncidentRecordEvidence, type FlakeJudgeEvidencePort, type MainRedAtBase,
} from "./flake-incident-gardener.js";
import { lintTask, promoteIntroducedPlanOnlyDiagnostics, rulingVerifyViolation, taskRulingPin, type LintViolation } from "./task-linter.js";

/** The operator's escalation rule, handed to the judge verbatim in its gates state. */
export const MACHINE_JUDGE_ESCALATE_ONLY_IF =
  "Classify HIGH only when this task is really risky or broken: what it will DO touches secrets, " +
  "credentials, auth or permissions; deletes data, branches or history (even when the deletion is " +
  "the fix); changes merge, deploy, infrastructure or review policy; or takes an irreversible " +
  "action; or it asks for a decision only the operator can make (his priorities, budget, preference " +
  "or policy); or its finding cannot be verified from what is shown. Everything else is LOW and flows " +
  "— its PR still passes CI and review.";

export const MACHINE_JUDGE_STATE_FILE = "machine-filing-judge.json";

/** The family a machine record belongs to: its `origin:` up to the first colon. */
export function machineFamily(task: Pick<Task, "origin">): string {
  const origin = task.origin?.trim() ?? "";
  return origin ? origin.split(":")[0]! : "unknown";
}

/** The family whose record sets a record's bar: a machine filer's, or one shared by operator records. */
export function judgementFamily(task: Pick<Task, "origin" | "author_class">): string {
  return task.author_class === "machine" ? machineFamily(task) : "operator";
}

/** A record the linter treats as a ruling (it declares DECISIONS.md): it stays with the operator. */
export function isRulingShaped(task: Task): boolean {
  return rulingVerifyViolation({ ...task, verify: "auto" }) !== undefined;
}

/** Operator releases (`rmd approve`) awaiting their pinned ruling, kept where ledger rotation cannot
 *  shed them. The judge pins each as an operator ruling, with no model asked. */
export const OPERATOR_RELEASES_FILE = "operator-releases.json";

export function readOperatorReleases(stateDir: string): Set<string> {
  const raw = readFileIfExists(join(stateDir, OPERATOR_RELEASES_FILE));
  return new Set(Object.keys(raw === undefined ? {} : ((JSON.parse(raw) as { releases?: Record<string, string> }).releases ?? {})));
}

export function recordOperatorRelease(stateDir: string, taskId: string, atIso: string): void {
  const path = join(stateDir, OPERATOR_RELEASES_FILE);
  const raw = readFileIfExists(path);
  const releases = raw === undefined ? {} : ((JSON.parse(raw) as { releases?: Record<string, string> }).releases ?? {});
  writeAtomic(path, JSON.stringify({ releases: { ...releases, [taskId]: releases[taskId] ?? atIso } }) + "\n");
}

export interface FamilyTrackRecord {
  family: string;
  merged: number;
  declined: number;
  alpha: number;
  beta: number;
  mean: number;
}

/**
 * A family's record as Beta(1 + credits, 1 + debits). A credit is a merged record; a debit is one
 * a person retired as `closed` or `retired`. A `withdrawn` duplicate is neither: the plan gardener
 * folded it into a sibling, which says nothing about whether the work was worth doing. A gardener
 * that keeps its own Beta record (gardener.ts) adds what it learned beyond its optimistic prior.
 */
export function familyTrackRecord(
  plan: Plan,
  family: string,
  isMerged: (id: string) => boolean,
  garden?: { alpha: number; beta: number },
): FamilyTrackRecord {
  let merged = 0;
  let declined = 0;
  for (const t of plan.tasks) {
    // Only records a judge or filer is answerable for: every machine record, and operator records a ruling released.
    if (judgementFamily(t) !== family || (t.author_class !== "machine" && t.risk_ruling === undefined)) continue;
    if (isMerged(t.id)) merged += 1;
    else if (t.retirement === "closed" || t.retirement === "retired") declined += 1;
  }
  const alpha = 1 + merged + Math.max(0, (garden?.alpha ?? 3) - 3);
  const beta = 1 + declined + Math.max(0, (garden?.beta ?? 1) - 1);
  return { family, merged, declined, alpha, beta, mean: alpha / (alpha + beta) };
}

/** How confident a `low` verdict must be: the policy's bar at an even record, lower as the family
 *  earns trust and approaching certainty as it loses it. Continuous, never a cliff. */
export function earnedConfidenceBar(base: number, mean: number): number {
  return 1 - (1 - base) * 2 * mean;
}

/**
 * A record this pass should rule on: an unjudged or stale machine record; an operator `verify: human`
 * record that is not ruling-shaped (operator ruling 2026-09-29); or one the operator released with
 * `rmd approve`, whose release becomes a pinned ruling.
 */
export function needsMachineJudgement(task: Task, operatorReleases: ReadonlySet<string> = new Set()): boolean {
  if (task.status !== "queued" || task.retirement !== undefined || shardRelPath(task) === undefined) return false;
  if (operatorReleases.has(task.id)) return task.verify === "human";
  const unjudged = task.risk_ruling === undefined || task.risk_ruling.pin !== taskRulingPin(task);
  if (task.author_class === "machine") return unjudged;
  return task.verify === "human" && !isRulingShaped(task) && unjudged;
}

/** A record this judge parked under an escalate pin that still matches it: the records a re-ask reads (W1-T8830). */
export function parkedEscalation(task: Task, operatorReleases: ReadonlySet<string> = new Set()): boolean {
  if (task.status !== "queued" || task.retirement !== undefined || shardRelPath(task) === undefined) return false;
  if (operatorReleases.has(task.id) || task.verify !== "human" || task.risk_ruling?.action !== "escalate") return false;
  if (task.risk_ruling.pin !== taskRulingPin(task)) return false;
  return task.author_class === "machine" || !isRulingShaped(task);
}

/** The judge's inputs that can move while the record stays unchanged: the family's bar, the cost the
 *  origin names (null when nothing prices it), and which of its `depends_on` have merged. */
export interface MachineJudgeEvidence {
  bar: number;
  cost: number | null;
  merged_deps: string[];
}

export function machineJudgeEvidence(task: Task, bar: number, cost: number | undefined, isMerged: (id: string) => boolean): MachineJudgeEvidence {
  return { bar, cost: cost ?? null, merged_deps: task.depends_on.filter(isMerged).sort() };
}

/** Which inputs differ between the snapshot a record was judged on and the current one. */
export function movedEvidence(then: MachineJudgeEvidence, now: MachineJudgeEvidence): string[] {
  return [
    then.bar !== now.bar ? "confidence_bar" : undefined,
    then.cost !== now.cost ? "cost" : undefined,
    then.merged_deps.join(",") !== now.merged_deps.join(",") ? "depends_on" : undefined,
  ].filter((m): m is string => m !== undefined);
}

/** The time scale for a re-ask interval: one day for a family with an even flip record and a record
 *  on its first ask. It is a unit, not a limit; the interval scales from it with no cap and no floor. */
export const MACHINE_JUDGE_REASK_SCALE_MS = 24 * 60 * 60 * 1000;

/** A family's re-ask history: how many re-asks ran and how many changed the verdict. */
export interface ReaskRecord {
  asked: number;
  flipped: number;
}

/**
 * How long a parked escalation waits before the judge asks again when nothing has moved. The family's
 * flip rate is read as Beta(1 + flipped, 1 + held). Its odds against a flip set the starting interval,
 * so a family whose re-asks often flip is asked sooner. Each unchanged answer for this record doubles
 * the interval. A flip anywhere in the family raises the rate, which shortens the wait for every
 * parked record in that family.
 */
export function reaskIntervalMs(family: ReaskRecord | undefined, repeats: number): number {
  // The odds against a flip, (1 + held) / (1 + flipped), taken over whole counts so an interval is exact.
  const flipped = family?.flipped ?? 0;
  return MACHINE_JUDGE_REASK_SCALE_MS * ((1 + (family?.asked ?? 0) - flipped) / (1 + flipped)) * 2 ** repeats;
}

/** W1-T9043, operator ruling 2026-10-13: a machine escalation no person rules on for this many days is withdrawn
 *  by the judge, so its gardener re-files the cause from fresh evidence if it still costs. Silence never releases. */
export const MACHINE_JUDGE_UNANSWERED_WITHDRAW_DAYS = 30;

/** W1-T9043: the age bands a parked escalation is ledgered under, the verify-human cadence's own 14/30/60 days. */
export const MACHINE_ESCALATION_AGE_BANDS = [14, 30, 60] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since the record's pinned ruling was judged. Under an escalate pin that is its first escalation:
 *  an unchanged re-ask writes nothing, and an edit re-pins. `null` when `judged_at` does not parse, never 0. */
export function escalationAgeDays(task: Pick<Task, "risk_ruling">, nowMs: number): number | null {
  const at = Date.parse(task.risk_ruling?.judged_at ?? "");
  return Number.isFinite(at) ? Math.max(0, Math.floor((nowMs - at) / DAY_MS)) : null;
}

/** The highest {@link MACHINE_ESCALATION_AGE_BANDS} band an age has reached, or `null` below the first. */
export function escalationAgeBand(ageDays: number | null): number | null {
  let band: number | null = null;
  for (const b of MACHINE_ESCALATION_AGE_BANDS) if (ageDays !== null && ageDays >= b) band = b;
  return band;
}

/** Ledger steps that are a ruling on one task the record itself does not carry: a release
 *  (`ratify.approved`) and `rmd release`'s breaker reset. An edit re-pins the record, and `rmd approve`
 *  also lands in {@link OPERATOR_RELEASES_FILE}; both already end {@link parkedEscalation}. */
export const OPERATOR_RULING_STEPS: ReadonlySet<string> = new Set(["ratify.approved", "dispatch.breaker_released"]);

/** The newest {@link OPERATOR_RULING_STEPS} row's `ts` for each task id. */
export function operatorRulingTimes(rows: Iterable<Record<string, unknown>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.step !== "string" || !OPERATOR_RULING_STEPS.has(row.step)) continue;
    if (typeof row.task_id !== "string" || typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts))) continue;
    const prior = out.get(row.task_id);
    if (prior === undefined || Date.parse(row.ts) > Date.parse(prior)) out.set(row.task_id, row.ts);
  }
  return out;
}

/** `<planDir>/tasks.d/<file>` for a record that lives in a shard, taken from the record's own
 *  `sourcePath` tail rather than re-spelled here (a house-layout literal in a new file trips the
 *  W1-T3701 ratchet); the monolith is never rewritten here. */
export function shardRelPath(task: Pick<Task, "sourcePath">): string | undefined {
  const p = task.sourcePath?.replaceAll("\\", "/");
  const m = p === undefined ? null : /(?:^|\/)([^/]+\/tasks\.d\/[^/]+\.ya?ml)$/.exec(p);
  return m?.[1];
}

/** How much of a record's `note:` and `rationale:` the judge is shown, in characters (W1-T9042).
 *  PRIMARY CONTROL: it fires on a healthy long rationale by design and states its cut; the evidence line counts all. */
export const MACHINE_JUDGE_EVIDENCE_CAP = 4000;

/** `text` cut to `cap` characters at a line boundary, with the cut stated; a lone longer line is cut mid-line. */
function boundedAtLine(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const lines = text.split("\n");
  let shown = "";
  for (const line of lines) {
    const next = shown === "" ? line : `${shown}\n${line}`;
    if (next.length > cap) break;
    shown = next;
  }
  const how = shown === "" ? ((shown = text.slice(0, cap)), "mid-line") : "at a line boundary";
  return `${shown}\n[cut ${how}: ${shown.length} of ${text.length} characters shown; the rest is in the record]`;
}

/** The record's own repo root, from its shard's `sourcePath` (`<root>/<plan>/tasks.d/<file>`), or undefined. */
function shardRepoRoot(task: Pick<Task, "sourcePath">): string | undefined {
  return task.sourcePath === undefined || shardRelPath(task) === undefined ? undefined : dirname(dirname(dirname(task.sourcePath)));
}

/** One line of facts the harness computes from the record, so the judge need not take the filer's word:
 *  the PRs and round/PR counts its `note:`/`rationale:` cite (counted over the whole text, not only the
 *  bounded part shown), whether each declared file exists at the base the plan was read from, and each
 *  proof's dialect. */
function machineEvidenceLine(task: Task, pathExists: ((path: string) => boolean) | undefined): string {
  const narrative = [task.note ?? "", task.rationale ?? ""].join("\n");
  const prs = [...new Set([...narrative.matchAll(/(?:(?<![\w&])#|\/pull\/)(\d+)\b/g)].map((m) => `#${m[1]}`))];
  const counts = [...new Set([...narrative.matchAll(/\b\d[\d,]*\s+(?:PRs?|pull requests?|rounds?)\b/gi)].map((m) => `"${m[0]}"`))];
  const files = task.files ?? [];
  const absent = pathExists === undefined ? [] : files.filter((f) => !pathExists(f));
  const dialects = [...new Set((task.acceptance ?? []).map((c) => /^\s*(unit test|grep|demonstration):/i.exec(c.proof ?? "")?.[1]?.toLowerCase() ?? "prose"))];
  return [
    "EVIDENCE (computed by the harness from the record, not written by the filer):",
    `note/rationale cites ${prs.length} distinct PR reference(s)${prs.length > 0 ? ` (${prs.slice(0, 12).join(", ")}${prs.length > 12 ? ", …" : ""})` : ""}`,
    counts.length > 0 ? `and states ${counts.slice(0, 12).join(", ")};` : "and states no round or PR count;",
    pathExists === undefined
      ? "declared files: not checked (no base checkout in hand);"
      : `${files.length - absent.length} of ${files.length} declared file(s) exist at the base${absent.length > 0 ? `; absent: ${absent.join(", ")}` : ""};`,
    `proof dialects: ${dialects.length > 0 ? dialects.join(", ") : "(no proof declared)"}.`,
  ].join(" ");
}

/** The record's `note:` and `rationale:`, as filed and bounded, then the {@link machineEvidenceLine}. */
function machineEvidence(task: Task, pathExists: ((path: string) => boolean) | undefined): string {
  const filed = [
    task.note?.trim() ? `note (as filed): ${task.note.trim()}` : undefined,
    task.rationale?.trim() ? `rationale (as filed):\n${task.rationale.trim()}` : undefined,
  ].filter((s): s is string => s !== undefined);
  const shown = filed.length > 0 ? `${boundedAtLine(filed.join("\n"), MACHINE_JUDGE_EVIDENCE_CAP)}\n` : "";
  return `${shown}${machineEvidenceLine(task, pathExists)}`;
}

/** The judge's input: the record as {@link buildFilingRiskJudgeInput} renders it, plus the operator's
 *  escalation rule, the family's record, and the evidence the record carries (W1-T9042, 2026-10-13: 14 of
 *  15 model verdicts escalated for missing evidence the record's `rationale:` already held). `pathExists`
 *  defaults to the record's own checkout, read from its shard's path. */
export function machineJudgeInput(task: Task, record: FamilyTrackRecord, pathExists?: (path: string) => boolean, extraEvidence?: string): RiskJudgeInput {
  const root = shardRepoRoot(task);
  const exists = pathExists ?? (root === undefined ? undefined : (p: string) => existsSync(join(root, p)));
  // Judged AS IT WOULD DISPATCH: shown `verify: human`, the judge counted on a person who, on
  // proceed, is never asked (measured 2026-09-29: "verify: human is set, giving a human checkpoint").
  const base = buildFilingRiskJudgeInput({ ...task, verify: "auto" });
  const description = `${base.change.description}\n${machineEvidence(task, exists)}${extraEvidence === undefined ? "" : `\n${extraEvidence}`}`;
  return {
    ...base,
    // Stated first, in the operator's words: the judge's generic framing leans LOW on a defect title.
    change: { ...base.change, description: `OPERATOR ESCALATION RULE: ${MACHINE_JUDGE_ESCALATE_ONLY_IF}\n\n${description}` },
    gatesState: { ...base.gatesState, author_class: task.author_class ?? "operator", escalate_only_if: MACHINE_JUDGE_ESCALATE_ONLY_IF },
    planContext: {
      ...base.planContext,
      author_family: record.family,
      family_track_record:
        `${record.merged} merged and ${record.declined} declined machine task(s) from this family ` +
        `(Beta mean ${record.mean.toFixed(2)}); a family that keeps failing is judged more strictly.`,
    },
  };
}

export type MachineJudgement =
  | { kind: "ruled"; task: Task; ruling: FilingRiskRuling; bar: number; record: FamilyTrackRecord; byOperator?: true }
  | { kind: "unavailable"; task: Task; reason: string };

/** Ask the judge about ONE record. Never throws: an error or a verdict-less answer is `unavailable`. */
export async function judgeMachineShard(
  task: Task,
  record: FamilyTrackRecord,
  ports: { riskJudge: (input: RiskJudgeInput) => Promise<RiskJudgeVerdict>; policy: RiskPolicy; clock: Clock; evidence?: string },
): Promise<MachineJudgement> {
  const bar = earnedConfidenceBar(ports.policy.confidenceThreshold, record.mean);
  const backstop = deterministicEscalation(task);
  if (backstop) {
    const reasons = [`deterministic backstop: ${backstop} — irreversible or privileged work goes to a person`];
    return { kind: "ruled", task, bar, record, ruling: { verdict: "high", action: "escalate", confidence: 1, reasons, judgedAt: ports.clock.iso() } };
  }
  let verdict: RiskJudgeVerdict;
  try {
    verdict = await ports.riskJudge(machineJudgeInput(task, record, undefined, ports.evidence));
  } catch (e) {
    return { kind: "unavailable", task, reason: `the risk judge threw: ${String((e as Error)?.message ?? e)}` };
  }
  if (verdict.availability === "unavailable") {
    return { kind: "unavailable", task, reason: verdict.reasons.join("; ") || "the risk judge reached no decision" };
  }
  const action = planRiskJudgeAction(verdict, { confidenceThreshold: bar });
  return {
    kind: "ruled",
    task,
    bar,
    record,
    ruling: {
      verdict: verdict.verdict,
      action: action.kind,
      confidence: verdict.confidence,
      reasons: action.kind === "escalate" ? [action.reason] : [...verdict.reasons],
      judgedAt: ports.clock.iso(),
    },
  };
}

/** What the judge knows about one flake-incident record beyond its own text. */
export interface FlakeJudgeFacts {
  retries?: FlakeIncidentRecordEvidence;
  mainRed: MainRedAtBase;
  mainRedBaseSha?: string;
  repair?: { offendingSha: string; fixPrUrl?: string };
}

const isFlakeIncident = (task: Pick<Task, "origin">): boolean => task.origin?.startsWith("flake-incident:") === true;

async function flakeFacts(task: Task, retries: ReadonlyMap<string, FlakeIncidentRecordEvidence>, port: FlakeJudgeEvidencePort): Promise<FlakeJudgeFacts> {
  const r = retries.get(task.id);
  if (r === undefined) return { mainRed: "unread" };
  const main = port.mainRedAt === undefined ? { mainRed: "unread" as const } : await port.mainRedAt(r.file, r.baseShas);
  const repair = port.repairFor?.(r.file, r.title);
  return { retries: r, mainRed: main.mainRed, ...(main.redSha ? { mainRedBaseSha: main.redSha } : {}), ...(repair ? { repair } : {}) };
}

/** The flake-incident facts as one line of the judge's evidence: unread evidence is said to be unread, never false. */
export function flakeEvidenceLine(facts: FlakeJudgeFacts): string {
  const r = facts.retries;
  return [
    "FLAKE-INCIDENT EVIDENCE (from the harness's ledger and main's own CI, not written by the filer):",
    r === undefined
      ? "retry outcomes: unread (no flake_incident.filed row for this record in the ledger window);"
      : `retry outcomes: ${r.recovered} recovered on retry, ${r.alsoFailed} also failed, over ${r.prs.length} filed PR(s), ${r.alsoFailedPrs} of them with a retry that also failed;`,
    facts.mainRed === "unread"
      ? "main's own CI failed the test at the PRs' bases: unread;"
      : `main's own CI failed the test at the PRs' bases: ${facts.mainRed}${facts.mainRedBaseSha ? ` (at ${facts.mainRedBaseSha})` : ""};`,
    facts.repair
      ? `a main-health repair names the test: offending ${facts.repair.offendingSha}${facts.repair.fixPrUrl ? `, fix ${facts.repair.fixPrUrl}` : ""}.`
      : "no main-health repair naming the test was read.",
    "A test that never passes on retry across PRs that do not touch it is the signature of a red inherited from main, not a flake.",
  ].join(" ");
}

/** Why a main-inherited record is retired, on one line: the evidence and the route. */
function flakeRetirementReason(facts: FlakeJudgeFacts & { retries: FlakeIncidentRecordEvidence }, atIso: string): string {
  const r = facts.retries;
  const main = facts.mainRed === true ? `main's own CI failed it at ${facts.mainRedBaseSha ?? "a base"}` : `main's own CI at the bases: ${facts.mainRed}`;
  return `not a flake: a red inherited from main. ${r.recovered} recovered and ${r.alsoFailed} also failed on retry over ${r.prs.length} PR(s) ` +
    `that do not touch the test, ${r.alsoFailedPrs} with a failed retry; ${main}. Routed to main-health as ${FLAKE_INCIDENT_MAIN_INHERITED_STEP} ` +
    `by the machine-filing judge (W1-T9694), ${atIso}`;
}

/** W1-T9694: ONE shard's text with the record retired, as the operator retired W1-T9532: `status: blocked`,
 *  `retirement: <kind>` with the reason, and `verify: human`. Undefined, with the reason, when it cannot be.
 *  W1-T9043 withdraws an unanswered escalation as `withdrawn`, which no family's track record counts against it. */
export function renderRetiredShard(
  text: string, relPath: string, reason: string, kind: "retired" | "withdrawn" = "retired",
): { contents: string } | { refused: string } {
  if ((text.match(/^- id:/gm) ?? []).length !== 1) return { refused: `${relPath} does not hold exactly one record` };
  const lines = text.replace(/\n+$/, "").split("\n").filter((l) => !/^ {2}retirement:/.test(l));
  const verifyAt = lines.findIndex((l) => /^ {2}verify:/.test(l));
  const statusAt = lines.findIndex((l) => /^ {2}status:/.test(l));
  if (verifyAt < 0 || statusAt < 0) return { refused: `${relPath} has no verify: or status: line` };
  lines[verifyAt] = "  verify: human  # parked with the retirement: any risk ruling judged the record before this edit";
  lines[statusAt] = "  status: blocked";
  lines.splice(statusAt + 1, 0, `  retirement: ${kind}  # ${reason.replace(/\s+/g, " ").trim()}`);
  const contents = lines.join("\n") + "\n";
  const before = shardRecord(text, relPath);
  const after = shardRecord(contents, relPath);
  if (after.id !== before.id || after.status !== "blocked" || after.retirement !== kind) return { refused: `${relPath}: the retirement did not parse back` };
  const checks = (vs: readonly LintViolation[]) => new Set(vs.filter((v) => v.severity === "block").map((v) => v.check));
  const had = checks(lintTask(before).violations);
  const added = [...checks(promoteIntroducedPlanOnlyDiagnostics(lintTask(after).violations, lintTask(before).violations, false))].filter((c) => !had.has(c));
  return added.length > 0 ? { refused: `${after.id}: the retirement fails lint (${added.join(", ")})` } : { contents };
}

const q = (v: string): string => JSON.stringify(v);

/** A shard's text without its `risk_ruling` block's `judged_at:` line: an operator release is stamped
 *  afresh every pass, so only this line may differ from the ruling main carries (W1-T5406). */
function withoutJudgedAt(text: string): string {
  let inBlock = false;
  return text
    .split("\n")
    .filter((line) => {
      if (/^ {2}risk_ruling:\s*$/.test(line)) return (inBlock = true);
      if (line.trim() !== "" && !/^ {4}/.test(line)) inBlock = false;
      return !(inBlock && /^ {4}judged_at:/.test(line));
    })
    .join("\n");
}

/** ONE shard's record. A lone shard cannot resolve its `depends_on`, so the caller checks them against
 *  the whole plan (2026-09-30: validating in isolation threw on every dependency and killed each pass). */
const shardRecord = (text: string, relPath: string): Task => parseTasksFromYaml(text, relPath)[0]!;

/**
 * Rewrite ONE shard's text with a ruling: `verify:` set by the action and the ruling appended,
 * pinned to the record AS REWRITTEN. Returns undefined, with the reason, when the text is not a
 * single record, names a different id, depends on a task `known` (the whole plan) lacks, or the
 * rewrite would not clear the linter it exists for.
 */
export function renderRuledShard(
  text: string,
  relPath: string,
  judgedPin: string,
  ruling: FilingRiskRuling,
  known: { has: (id: string) => boolean } = new Set<string>(),
  /** lint-plan --base's machine-filing admission (W1-T3843), as the landing PR will meet it. Absent: not checked. */
  admission?: Omit<MachineFilingAdmissionContext, "releasedIds">,
): { contents: string } | { refused: string; lint?: true } {
  if ((text.match(/^- id:/gm) ?? []).length !== 1) return { refused: `${relPath} does not hold exactly one record` };
  const unknownDep = shardRecord(text, relPath).depends_on.find((d) => !known.has(d));
  if (unknownDep !== undefined) return { refused: `${relPath}: depends_on unknown task '${unknownDep}'` };
  const verify = ruling.action === "proceed" ? "auto" : "human";
  const lines = withoutRulingBlock(text.replace(/\n+$/, "").split("\n"));
  // 2026-10-10: `verify: human  # <why>` is valid YAML the plan loads, and W1-T7736 was refused as having no
  // verify: line. The comment is kept on its own line above, so the rewrite never drops the filer's words.
  let verifyAt = lines.findIndex((l) => /^ {2}verify:\s*[^\s#]+\s*(#.*)?$/.test(l));
  if (verifyAt < 0) return { refused: `${relPath} has no verify: line` };
  const comment = /^ {2}verify:\s*[^\s#]+\s*#\s*(.*?)\s*$/.exec(lines[verifyAt]!)?.[1];
  if (comment) lines.splice(verifyAt++, 0, `  # ${comment}`);
  lines[verifyAt] = `  verify: ${verify}`;
  // Released machine work with no measured cost dispatches mid-queue, never last (2026-09-29).
  const released = shardRecord(text, relPath);
  if (ruling.action === "proceed" && released.author_class === "machine" && released.priority === undefined) {
    lines.splice(verifyAt + 1, 0, `  priority: ${UNPRICED_PRIORITY}`);
  }
  const flipped = lines.join("\n") + "\n";
  const before = shardRecord(text, relPath);
  const after = shardRecord(flipped, relPath);
  // The judge ruled on the record it read. If this checkout's copy differs, the ruling is not about it.
  if (taskRulingPin({ ...before, verify: "auto" }) !== judgedPin) return { refused: `${after.id} changed since it was judged` };
  const ruled = recordFilingRiskRuling(after, ruling, taskRulingPin);
  const block = [
    "  risk_ruling:",
    `    verdict: ${q(ruling.verdict)}`,
    `    action: ${ruling.action}`,
    `    confidence: ${ruling.confidence}`,
    "    reasons:",
    ...(ruling.reasons.length > 0 ? ruling.reasons.map((r) => `      - ${q(r)}`) : ["      - \"(the judge recorded no reason)\""]),
    `    judged_at: ${q(ruling.judgedAt)}`,
    `    pin: ${q(ruled.risk_ruling!.pin)}`,
  ];
  const contents = flipped + block.join("\n") + "\n";
  const reparsed = shardRecord(contents, relPath);
  // The pin is taken from `after`, whose pinned fields the block above does not touch, and a
  // `proceed` is written at `verify: auto` while an `escalate` stays `verify: human`: the written
  // pin matches and machine-author-verify clears by construction, so neither is re-checked here.
  // Judged as lint-plan --base judges the landing PR: a warning the flip introduces is promoted to block
  // on a plan-only diff (W1-T3814). 2026-10-10: proof-test-only-discrimination, a warn at verify: auto
  // and silent at human, refused every landing the live ledger kept (29) while this read only `severity: block`.
  const checks = (vs: readonly LintViolation[]) => new Set(vs.filter((v) => v.severity === "block").map((v) => v.check));
  const base = lintTask(before).violations;
  const had = checks(base);
  const added = [...checks(promoteIntroducedPlanOnlyDiagnostics(lintTask(reparsed).violations, base, false))].filter((c) => !had.has(c));
  if (added.length > 0) return { refused: `${reparsed.id}: at verify: auto it fails lint (${added.join(", ")})`, lint: true };
  // lint-plan --base also runs the machine-filing admission on every changed machine record, and a plain lintTask
  // skips it: at verify: auto it refuses unmerged depends_on, which verify: human parks past. Only what the
  // rewrite introduces counts, as above, so a reason the record already carried is not the ruling's to answer.
  if (admission !== undefined) {
    const admit = (t: Task) => machineFilingAdmissionViolations(t, { ...admission, releasedIds: new Set() });
    const held = new Set(admit(before));
    const refusedBy = admit(reparsed).filter((r) => !held.has(r));
    if (refusedBy.length > 0) return { refused: `${reparsed.id}: at verify: auto lint-plan's machine-filing admission refuses it (${refusedBy.join("; ")})`, lint: true };
  }
  return { contents };
}

interface RulingPins {
  id: string;
  relPath: string;
  pin: string;
  sourcePin: string;
  action?: string;
}

function mainRecords(root: string, paths: string[]): Map<string, string> {
  // In-place callers have no merge target; Git-backed workspaces always refresh origin/main.
  if (!existsSync(join(root, ".git"))) {
    return new Map(paths.flatMap((path) => {
      const text = readFileIfExists(join(root, path));
      return text === undefined ? [] : [[path, text] as const];
    }));
  }
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" });
  fetchOriginRetryingRefLock(git);
  const target = git(["rev-parse", "origin/main"]).trim();
  const present = new Set(git(["ls-tree", "-r", "--name-only", target, "--", ...paths]).trim().split("\n"));
  return new Map(paths.filter((path) => present.has(path)).map((path) => [path, git(["show", `${target}:${path}`])]));
}

function staleRulingPins(records: RulingPins[], main: Map<string, string>): { id: string; pin: string; main_pin: string | null }[] {
  return records.flatMap((record) => {
    const text = main.get(record.relPath);
    const task = text === undefined ? undefined : parseTasksFromYaml(text, record.relPath).find((t) => t.id === record.id);
    const pin = task === undefined ? null : taskRulingPin(task);
    // The source pin covers the unruled record; the rendered pin covers verify/priority after release,
    // and a retirement (W1-T9694) is current while the tree reads the record as it was written.
    const current = (task?.status === "queued" && task.retirement === undefined && (pin === record.sourcePin || pin === record.pin)) ||
      ((record.action === "retire" || record.action === "withdraw") && pin === record.pin);
    return current ? [] : [{ id: record.id, pin: record.pin, main_pin: pin }];
  });
}

interface MachineJudgeState {
  pending?: { prUrl: string; ids: string[]; records?: RulingPins[]; repoRoot?: string };
  /** A record whose judge PR a person closed, by the pin it had: not re-asked until it changes. */
  declined?: Record<string, string>;
  /** The judge's answer for a record not yet landed, by the pin it judged: reused with no model call
   *  while the record is unchanged (2026-09-30: 1,152 calls re-ruled the same 19 records). */
  rulings?: Record<string, { pin: string; ruling: FilingRiskRuling; bar: number }>;
  /** A record whose rendered ruling main already carries byte for byte, by the pin it was judged at:
   *  not re-rendered while the daemon's lagging checkout still reads it as due (W1-T5359, 2026-10-02:
   *  W1-T5309's merged ruling was re-landed 38 times, each an empty commit that stalled the loop). */
  settled?: Record<string, string>;
  /** W1-T10348: the subset of `settled` that was settled as an OPERATOR release, by the same pin. Only
   *  this masks a release: an escalate ruling settled earlier keeps the same pin when the operator
   *  releases the record, so `settled` alone hid W1-T6372, W1-T7271 and W1-T7736 for 8 days. */
  settledReleases?: Record<string, string>;
  /** An operator release whose `verify: auto` rewrite the linter refuses (a ruling-shaped record, which
   *  ruling-verify keeps at `verify: human`), by the pin it was refused at. A release skips `declined`, so
   *  without this an unchanged record was re-rendered every pass: W1-T5717, 515 identical refusals
   *  2026-10-13 12:03Z to 10-14 12:00Z, each opening and disposing a landing worktree. Kept while the pin holds. */
  refusedReleases?: Record<string, string>;
  /** W1-T8830: for each parked escalation, keyed by the pin it is parked at, the inputs it was last asked
   *  on, when that was, and how many answers in a row came back unchanged. Only a schedule: the ruling
   *  itself lives on the record. */
  reask?: Record<string, ReaskEntry>;
  /** W1-T8830: each family's re-asks and how many flipped, which set its cadence ({@link reaskIntervalMs}). */
  reaskRecord?: Record<string, ReaskRecord>;
  /** W1-T9694: for each released flake-incident record, the pin and evidence it was last reconsidered on. */
  flakeReleased?: Record<string, string>;
}

interface ReaskEntry {
  pin: string;
  inputs: MachineJudgeEvidence;
  askedAt: string;
  repeats: number;
}

function readState(path: string): MachineJudgeState {
  const raw = readFileIfExists(path);
  if (raw === undefined) return {};
  const parsed = JSON.parse(raw) as MachineJudgeState;
  if (parsed === null || typeof parsed !== "object") throw new Error(`machine judge: invalid state in ${path}`);
  return parsed;
}

export interface MachineJudgePorts {
  stateDir: string;
  plan: () => Plan;
  riskJudge: (input: RiskJudgeInput) => Promise<RiskJudgeVerdict>;
  riskPolicy?: () => RiskPolicy;
  isMerged?: (id: string) => boolean;
  /** Where a family's gardener keeps its Beta record: `<stateDir>/<family>-gardener.json`. */
  gardenRecord?: (family: string) => { alpha: number; beta: number } | undefined;
  /** Land the rewrites as one plan-only PR (the daemon). Absent, `writeRoot` is written in place. */
  openWorkspace?: GardenWorkspacePort;
  writeRoot?: string;
  /** Task ids the operator released with `rmd approve` ({@link readOperatorReleases}). */
  operatorReleases?: () => ReadonlySet<string>;
  prState?: (prUrl: string) => PrState;
  stageProposal: (proposal: Proposal) => void;
  log: (step: string, extra?: Record<string, unknown>) => void;
  clock: Clock;
  limit?: number;
  excludeFamilies?: readonly string[];
  /** The cost a record's origin names, as its family's gardener prices it now (W1-T8830). When this is
   *  absent or returns undefined, no cost is compared, and the bar, the deps and the cadence decide a re-ask. */
  costEvidence?: (task: Task) => number | undefined;
  /** W1-T9694: the retry and main-health facts for flake-incident records. Absent: judged on their text alone. */
  flakeEvidence?: FlakeJudgeEvidencePort;
  /** W1-T9043: read once per pass, the newest operator ruling on a task that its record does not carry
   *  (a ledgered release, `rmd release`, an `rmd note`). A ruling at or after the escalation stops its withdrawal.
   *  Absent or throwing: nothing is withdrawn this pass. */
  operatorRulings?: () => (taskId: string) => string | undefined;
}

/** What the machine judge reads that a pass can change: the plan tree it judges (and its risk policy, which
 *  lives in it) and the operator's releases. A plan that cannot be resolved stamps as unreadable, so it
 *  differs from any recorded tree and the pass runs and reports the failure. */
export function machineJudgeInputs(repoRoot: string, stateDir: string): string {
  let plan: string;
  try {
    plan = hostWorktreeGit(repoRoot, ["rev-parse", `HEAD:${relative(repoRoot, resolveRepoLayout(repoRoot).planDir)}`], { stdio: "pipe" }).trim();
  } catch {
    // deliberate: an unresolvable plan tree is its own stamp; it never matches a tree a pass recorded.
    plan = "unreadable";
  }
  const releases = statSync(join(stateDir, OPERATOR_RELEASES_FILE), { throwIfNoEntry: false });
  return `${plan}:${releases ? `${releases.size}:${releases.mtimeMs}` : "absent"}`;
}

export async function machineJudgeInputsAsync(repoRoot: string, stateDir: string): Promise<string> {
  let plan: string;
  try {
    plan = (await hostWorktreeGitAsync(repoRoot, ["rev-parse", `HEAD:${relative(repoRoot, resolveRepoLayout(repoRoot).planDir)}`], { stdio: "pipe" })).trim();
  } catch {
    // An unreadable tree retains the existing input stamp instead of claiming no change.
    plan = "unreadable";
  }
  const releases = statSync(join(stateDir, OPERATOR_RELEASES_FILE), { throwIfNoEntry: false });
  return `${plan}:${releases ? `${releases.size}:${releases.mtimeMs}` : "absent"}`;
}

/** Whether a pass moved anything: a ruling proceeded, escalated, refused or settled, or a PR opened. Waiting
 *  on a PR, an unavailable judge and a failed landing (one whose PR did not open) are not new; pacing backs off. */
export function machineJudgeFoundWork(report: MachineJudgeReport): boolean {
  const unlanded = new Set(report.unlanded);
  const moved = (ids: readonly string[]) => ids.some((id) => !unlanded.has(id));
  return report.prUrl !== undefined || moved(report.proceeded) || moved(report.escalated) || moved(report.retired ?? []) ||
    moved(report.withdrawn ?? []) ||
    report.refused.length > 0 || report.settled.length > 0;
}

export interface MachineJudgeReport {
  proceeded: string[];
  escalated: string[];
  unavailable: string[];
  refused: string[];
  /** Records whose landing threw: ledgered and skipped, never aborting the rest of the pass. */
  failed: string[];
  /** Records whose ruling the landing tree already carries: nothing to land, and not a failure. */
  settled: string[];
  prUrl?: string;
  unlanded?: string[];
  /** W1-T8830: the parked escalations asked again this pass, whatever they answered. */
  reasked?: string[];
  /** W1-T9694: flake-incident records retired as main-inherited, routed to main-health. */
  retired?: string[];
  /** W1-T9043: machine escalations withdrawn after {@link MACHINE_JUDGE_UNANSWERED_WITHDRAW_DAYS} days with no ruling. */
  withdrawn?: string[];
}

/** The Beta record gardener.ts keeps for a family, summed over its classes. */
export function gardenFamilyRecord(stateDir: string, family: string): { alpha: number; beta: number } | undefined {
  const path = join(stateDir, `${family}-gardener.json`);
  if (!existsSync(path)) return undefined;
  const state = JSON.parse(readFileSync(path, "utf8")) as { classes?: Record<string, { alpha: number; beta: number }> };
  const classes = Object.values(state.classes ?? {});
  if (classes.length === 0) return undefined;
  // Each class starts at Beta(3, 1); only what it learned beyond that prior is evidence.
  return {
    alpha: 3 + classes.reduce((s, c) => s + Math.max(0, c.alpha - 3), 0),
    beta: 1 + classes.reduce((s, c) => s + Math.max(0, c.beta - 1), 0),
  };
}

export function machineJudgeProposal(ruled: Extract<MachineJudgement, { kind: "ruled" }>): Proposal {
  const { task, ruling, record } = ruled;
  return stampVerificationAsk({
    id: `machine-judge:${task.id}`,
    summary:
      `${task.id} ${task.author_class === "machine" ? `was filed by the ${record.family} gardener` : "is your verify: human record"} and the risk judge escalated it, so it ` +
      `stays parked for you:\n  ${ruling.reasons.join("\n  ")}\n\n${task.title}\n\n` +
      `Family record: ${record.merged} merged, ${record.declined} declined. Release it with ` +
      `\`rmd approve ${task.id}\`, or edit the record and the judge will rule again.`,
    evidenceAnchors: [],
  }, task.id, "machine-filing-judge-v1");
}

/** A parked escalation the judge answered with a proceed this pass, held until landing decides whether it flipped. */
interface PendingReask {
  judged: Extract<MachineJudgement, { kind: "ruled" }>;
  family: string;
  pin: string;
  inputs: MachineJudgeEvidence;
  repeats: number;
}

/** Book one answered re-ask. A flip resets the record's backoff and raises its family's flip rate.
 *  A repeat doubles the record's next interval. */
function noteReask(state: MachineJudgeState, r: PendingReask, changed: boolean): void {
  const family = ((state.reaskRecord ??= {})[r.family] ??= { asked: 0, flipped: 0 });
  family.asked += 1;
  if (changed) family.flipped += 1;
  (state.reask ??= {})[r.judged.task.id] = { pin: r.pin, inputs: r.inputs, askedAt: r.judged.ruling.judgedAt, repeats: changed ? 0 : r.repeats + 1 };
}

/**
 * W1-T8830: ask the judge again about each parked escalation whose inputs moved since it was last asked,
 * or whose cadence ({@link reaskIntervalMs}) has fallen due. An unchanged answer is booked here and
 * writes nothing. A proceed is returned so it lands through the one judge PR, re-pinned.
 */
async function reaskParkedEscalations(c: {
  ports: MachineJudgePorts;
  plan: Plan;
  state: MachineJudgeState;
  report: MachineJudgeReport;
  records: Map<string, FamilyTrackRecord>;
  released: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
  isMerged: (id: string) => boolean;
  policy: RiskPolicy;
  room: number;
  /** W1-T9043: records this pass withdraws as unanswered, which are not asked again. */
  withdrawing: ReadonlySet<string>;
}): Promise<Map<string, PendingReask>> {
  const { ports, plan, state } = c;
  // A schedule is kept while its record is open. A pin that no longer matches is re-seeded below.
  state.reask = Object.fromEntries(
    Object.entries(state.reask ?? {}).filter(([id]) => plan.byId.get(id)?.status === "queued" && plan.byId.get(id)?.retirement === undefined),
  );
  // Every record's cadence reads the family's history as it stood when the pass began, so a re-ask
  // answered earlier in this pass never shifts a sibling's wait, and plan order cannot change who is asked.
  const cadence: Record<string, ReaskRecord> = structuredClone(state.reaskRecord ?? {});
  const pending = new Map<string, PendingReask>();
  let room = c.room;
  for (const task of plan.tasks) {
    if (room <= 0) break;
    if (!parkedEscalation(task, c.released) || c.withdrawing.has(task.id)) continue;
    const family = judgementFamily(task);
    const pin = task.risk_ruling!.pin; // parkedEscalation proved it is the record's own pin
    if (c.excluded.has(family) || state.declined?.[task.id] === pin) continue;
    if (!c.records.has(family)) c.records.set(family, familyTrackRecord(plan, family, c.isMerged, ports.gardenRecord?.(family)));
    const record = c.records.get(family)!;
    const inputs = machineJudgeEvidence(task, earnedConfidenceBar(c.policy.confidenceThreshold, record.mean), ports.costEvidence?.(task), c.isMerged);
    const prior = state.reask[task.id];
    // First sight of this pin (parked before W1-T8830, or the state was lost): the inputs are taken as
    // they stand now, and the cadence counts from the ruling's own judged_at.
    const entry = prior?.pin === pin ? prior : { pin, inputs, askedAt: task.risk_ruling!.judged_at, repeats: 0 };
    state.reask[task.id] = entry;
    const moved = movedEvidence(entry.inputs, inputs);
    const intervalMs = reaskIntervalMs(cadence[family], entry.repeats);
    // Written as "not yet due" negated, so an unparseable judged_at (NaN) reads as due and is asked.
    const cadenceDue = !(Date.parse(entry.askedAt) + intervalMs > ports.clock.now());
    if (moved.length === 0 && !cadenceDue) continue;
    room -= 1;
    const judged = await judgeMachineShard(task, record, { riskJudge: ports.riskJudge, policy: c.policy, clock: ports.clock });
    if (judged.kind === "unavailable") {
      c.report.unavailable.push(task.id);
      ports.log("machine_judge.unavailable", { task_id: task.id, reason: judged.reason, reask: true });
      continue;
    }
    (c.report.reasked ??= []).push(task.id);
    const changed = judged.ruling.action !== "escalate";
    // W1-T9043: a re-ask that keeps `escalate` is a resurfacing, ledgered with the escalation's age and band.
    const ageDays = escalationAgeDays(task, ports.clock.now());
    ports.log("machine_judge.reasked", {
      task_id: task.id,
      family,
      age_days: ageDays,
      age_band: escalationAgeBand(ageDays),
      moved,
      cadence_due: cadenceDue,
      interval_ms: intervalMs,
      previous_action: "escalate",
      action: judged.ruling.action,
      verdict: judged.ruling.verdict,
      confidence: judged.ruling.confidence,
      confidence_bar: judged.bar,
      changed,
    });
    const reask: PendingReask = { judged, family, pin, inputs, repeats: entry.repeats };
    if (changed) pending.set(task.id, reask);
    else noteReask(state, reask, false);
  }
  return pending;
}

/** W1-T9043: a parked machine escalation no person ruled on within {@link MACHINE_JUDGE_UNANSWERED_WITHDRAW_DAYS}. */
interface Withdrawal {
  task: Task;
  ageDays: number;
  band: number | null;
  escalatedAt: string;
}

/**
 * W1-T9043, operator ruling 2026-10-13: the machine escalations parked for a person longer than
 * {@link MACHINE_JUDGE_UNANSWERED_WITHDRAW_DAYS} days with no ruling. A ruling is an edit to the record (it re-pins),
 * `rmd approve` (an operator release), a judge PR the operator closed (declined), or any
 * {@link MachineJudgePorts.operatorRulings} entry at or after the escalation. Each of those keeps the record parked.
 */
function unansweredEscalations(c: {
  ports: MachineJudgePorts;
  plan: Plan;
  state: MachineJudgeState;
  released: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
}): Withdrawal[] {
  if (c.ports.operatorRulings === undefined) return [];
  const nowMs = c.ports.clock.now();
  const aged = c.plan.tasks.filter((t) =>
    t.author_class === "machine" && parkedEscalation(t, c.released) && !c.excluded.has(judgementFamily(t)) &&
    c.state.declined?.[t.id] !== t.risk_ruling!.pin && (escalationAgeDays(t, nowMs) ?? -1) >= MACHINE_JUDGE_UNANSWERED_WITHDRAW_DAYS);
  if (aged.length === 0) return [];
  let ruledAt: (taskId: string) => string | undefined;
  try {
    ruledAt = c.ports.operatorRulings();
  } catch (e) {
    // Withdrawing a record the operator may have ruled on would answer for him; this pass withdraws none.
    c.ports.log("machine_judge.withdraw_skipped", { task_ids: aged.map((t) => t.id), reason: `operator rulings are unreadable: ${String((e as Error)?.message ?? e)}` });
    return [];
  }
  return aged.flatMap((task) => {
    const escalatedAt = task.risk_ruling!.judged_at;
    const ruling = Date.parse(ruledAt(task.id) ?? "");
    if (Number.isFinite(ruling) && ruling >= Date.parse(escalatedAt)) return [];
    const ageDays = escalationAgeDays(task, nowMs)!;
    return [{ task, ageDays, band: escalationAgeBand(ageDays), escalatedAt }];
  });
}

/** The `retirement:` note an unanswered withdrawal carries: the age, and the ruling that withdrew it. */
function unansweredWithdrawalReason(w: Withdrawal, atIso: string): string {
  return `withdrawn unanswered: escalated to a person ${w.escalatedAt} and held ${w.ageDays} days with no operator ruling ` +
    `(operator ruling 2026-10-13: silence re-judges, then retires; it never approves or releases). Its gardener ` +
    `re-files the cause from fresh evidence if it still costs. Withdrawn by the machine-filing judge (W1-T9043), ${atIso}`;
}

/** An operator release the judge cannot pin on the record: the operator is told why once, rather than the
 *  judge re-rendering it every pass. The ledger's release row is untouched; only the durable pin is refused. */
export function refusedReleaseProposal(task: Task, reason: string): Proposal {
  return {
    id: `machine-judge-release:${task.id}`,
    summary:
      `Your release of ${task.id} (\`rmd approve ${task.id}\`) cannot be pinned on the record, which keeps verify: human:\n  ${reason}\n\n` +
      `${task.title}\n\nOnly the ledger's release row carries it now. Edit the record so it clears that check and the ` +
      "judge will pin the release; an unchanged record is not retried.",
    evidenceAnchors: [],
  };
}

/** A flake-incident record the judge read as main-inherited; `key` is set for one it had already released. */
interface Retirement {
  task: Task;
  facts: FlakeJudgeFacts & { retries: FlakeIncidentRecordEvidence };
  key?: string;
}

const mainInherited = (facts: FlakeJudgeFacts): facts is FlakeJudgeFacts & { retries: FlakeIncidentRecordEvidence } =>
  facts.retries !== undefined && flakeIncidentMainInherited({ ...facts.retries, mainRed: facts.mainRed });

/** A flake-incident record this judge released: queued at `verify: auto` under its own proceed pin. */
function releasedFlake(task: Task, operatorReleases: ReadonlySet<string>): boolean {
  return isFlakeIncident(task) && task.status === "queued" && task.retirement === undefined && task.verify === "auto" &&
    !operatorReleases.has(task.id) && shardRelPath(task) !== undefined &&
    task.risk_ruling?.action === "proceed" && task.risk_ruling.pin === taskRulingPin(task);
}

/**
 * W1-T9694: a released flake-incident record is reconsidered once, on the first pass whose computed evidence
 * differs from what it was released on (W1-T8830's moved-input rule). Main-inherited, it is retired; else the
 * judge is asked again with the evidence, and only an escalation is landed. A record with no evidence read moved nothing.
 */
async function reconsiderReleasedFlakes(c: {
  ports: MachineJudgePorts;
  port: FlakeJudgeEvidencePort;
  plan: Plan;
  state: MachineJudgeState;
  report: MachineJudgeReport;
  records: Map<string, FamilyTrackRecord>;
  isMerged: (id: string) => boolean;
  policy: RiskPolicy;
  releasedFlakes: readonly Task[];
  retries: ReadonlyMap<string, FlakeIncidentRecordEvidence>;
  retire: Retirement[];
}): Promise<Extract<MachineJudgement, { kind: "ruled" }>[]> {
  const ids = new Set(c.releasedFlakes.map((t) => t.id));
  c.state.flakeReleased = Object.fromEntries(Object.entries(c.state.flakeReleased ?? {}).filter(([id]) => ids.has(id)));
  const out: Extract<MachineJudgement, { kind: "ruled" }>[] = [];
  for (const task of c.releasedFlakes) {
    const r = c.retries.get(task.id);
    if (r === undefined) continue;
    const key = `${task.risk_ruling!.pin}:${JSON.stringify([r.recovered, r.alsoFailed, r.alsoFailedPrs, r.prs, r.baseShas])}`;
    if (c.state.flakeReleased[task.id] === key) continue;
    const facts = await flakeFacts(task, c.retries, c.port);
    if (mainInherited(facts)) {
      c.retire.push({ task, facts, key });
      continue;
    }
    const family = judgementFamily(task);
    if (!c.records.has(family)) c.records.set(family, familyTrackRecord(c.plan, family, c.isMerged, c.ports.gardenRecord?.(family)));
    const judged = await judgeMachineShard(task, c.records.get(family)!, { riskJudge: c.ports.riskJudge, policy: c.policy, clock: c.ports.clock, evidence: flakeEvidenceLine(facts) });
    if (judged.kind === "unavailable") {
      c.report.unavailable.push(task.id);
      c.ports.log("machine_judge.unavailable", { task_id: task.id, reason: judged.reason, flake_reconsidered: true });
      continue;
    }
    c.state.flakeReleased[task.id] = key;
    c.ports.log("machine_judge.flake_reconsidered", { task_id: task.id, action: judged.ruling.action, verdict: judged.ruling.verdict, main_red: facts.mainRed });
    if (judged.ruling.action === "escalate") out.push(judged);
  }
  return out;
}

/** One pass: rule on every unjudged or stale machine record, then land or write the rewrites. */
export async function runMachineFilingJudge(ports: MachineJudgePorts): Promise<MachineJudgeReport> {
  const statePath = join(ports.stateDir, MACHINE_JUDGE_STATE_FILE);
  const state = readState(statePath);
  const report: MachineJudgeReport = { proceeded: [], escalated: [], unavailable: [], refused: [], failed: [], settled: [] };
  if (state.pending) {
    const pr = ports.prState?.(state.pending.prUrl) ?? "unknown";
    if (pr === "open" || pr === "unknown") {
      const pendingPlan = ports.plan();
      const records = state.pending.records ?? state.pending.ids.map((id) => ({
        id, relPath: shardRelPath(pendingPlan.byId.get(id) ?? {}) ?? "",
        pin: state.rulings?.[id]?.pin ?? "unknown", sourcePin: state.rulings?.[id]?.pin ?? "unknown",
      }));
      const source = pendingPlan.tasks.find((t) => t.sourcePath !== undefined)?.sourcePath;
      const root = state.pending.repoRoot ?? (source === undefined ? undefined : dirname(dirname(dirname(source))));
      if (root === undefined) throw new Error("machine judge: pending PR has no merge-target checkout");
      const stale = staleRulingPins(records, mainRecords(root, records.map((r) => r.relPath).filter(Boolean)));
      if (stale.length > 0) {
        const comment = "Withdrawing stale machine-filing rulings after origin/main changed:\n" +
          stale.map((r) => `${r.id}: ruling pin ${r.pin}; main pin ${r.main_pin ?? "removed"}`).join("\n");
        ghExec(["pr", "close", state.pending.prUrl, "--comment", comment], { encoding: "utf8", stdio: "pipe" });
        ports.log("machine_judge.withdrawn", { pr_url: state.pending.prUrl, stale });
        for (const id of state.pending.ids) delete state.rulings?.[id];
        state.pending = undefined;
        writeAtomic(statePath, JSON.stringify(state) + "\n");
        return report;
      }
      ports.log("machine_judge.waiting", { pr_url: state.pending.prUrl });
      return report;
    }
    if (pr === "closed") {
      const plan = ports.plan();
      state.declined ??= {};
      for (const id of state.pending.ids) {
        const t = plan.byId.get(id);
        if (t) state.declined[id] = taskRulingPin(t);
      }
    }
    state.pending = undefined;
  }

  const plan = ports.plan();
  const isMerged = ports.isMerged ?? ((id: string) => ["merged", "done"].includes(plan.byId.get(id)?.status ?? ""));
  const excluded = new Set(ports.excludeFamilies ?? []);
  const released = ports.operatorReleases?.() ?? new Set<string>();
  const due = plan.tasks.filter(
    (t) =>
      needsMachineJudgement(t, released) &&
      // W1-T10348: a release is masked only by a settled RELEASE; a settled escalation is what it overrules.
      (released.has(t.id)
        ? state.settledReleases?.[t.id] !== taskRulingPin(t) && state.refusedReleases?.[t.id] !== taskRulingPin(t)
        : state.settled?.[t.id] !== taskRulingPin(t) && !excluded.has(judgementFamily(t)) && state.declined?.[t.id] !== taskRulingPin(t)),
  );
  const policy = ports.riskPolicy?.() ?? DEFAULT_RISK_POLICY;
  const dueIds = new Set(due.map((t) => t.id));
  state.rulings = Object.fromEntries(
    Object.entries(state.rulings ?? {}).filter(([id, c]) => dueIds.has(id) && c.pin === taskRulingPin(plan.byId.get(id)!)),
  );
  // Kept only while the plan still reads the record at the pin it was settled at.
  state.settled = Object.fromEntries(
    Object.entries(state.settled ?? {}).filter(([id, pin]) => {
      const t = plan.byId.get(id);
      return t !== undefined && pin === taskRulingPin(t);
    }),
  );
  state.settledReleases = Object.fromEntries(
    Object.entries(state.settledReleases ?? {}).filter(([id, pin]) => {
      const t = plan.byId.get(id);
      return t !== undefined && pin === taskRulingPin(t);
    }),
  );
  state.refusedReleases = Object.fromEntries(
    Object.entries(state.refusedReleases ?? {}).filter(([id, pin]) => {
      const t = plan.byId.get(id);
      return t !== undefined && pin === taskRulingPin(t);
    }),
  );
  const records = new Map<string, FamilyTrackRecord>();
  const ruled: Extract<MachineJudgement, { kind: "ruled" }>[] = [];
  // W1-T9694: a flake-incident record is judged with the harness's retry and main-health facts, and one the
  // gardener's own classifier reads as main-inherited is retired rather than asked about.
  const flakePort = ports.flakeEvidence;
  const releasedFlakes = flakePort === undefined ? [] : plan.tasks.filter((t) => releasedFlake(t, released));
  const judgedNow = due.slice(0, ports.limit ?? due.length);
  const flakeTasks = [...judgedNow.filter((t) => isFlakeIncident(t) && !released.has(t.id)), ...releasedFlakes];
  const retries = flakePort !== undefined && flakeTasks.length > 0 ? flakePort.retries(flakeTasks) : new Map<string, FlakeIncidentRecordEvidence>();
  const retire: Retirement[] = [];
  for (const task of judgedNow) {
    const family = judgementFamily(task);
    if (!records.has(family)) records.set(family, familyTrackRecord(plan, family, isMerged, ports.gardenRecord?.(family)));
    let flakeLine: string | undefined;
    if (flakePort !== undefined && isFlakeIncident(task) && !released.has(task.id)) {
      const facts = await flakeFacts(task, retries, flakePort);
      if (mainInherited(facts)) {
        retire.push({ task, facts });
        continue;
      }
      flakeLine = flakeEvidenceLine(facts);
    }
    const cached = state.rulings[task.id];
    const judged: MachineJudgement = released.has(task.id)
      ? {
          kind: "ruled", task, bar: 0, record: records.get(family)!, byOperator: true,
          ruling: { verdict: "operator", action: "proceed", confidence: 1, reasons: ["released by the operator with rmd approve"], judgedAt: ports.clock.iso() },
        }
      : cached !== undefined
        ? { kind: "ruled", task, bar: cached.bar, record: records.get(family)!, ruling: cached.ruling }
        : await judgeMachineShard(task, records.get(family)!, { riskJudge: ports.riskJudge, policy, clock: ports.clock, ...(flakeLine ? { evidence: flakeLine } : {}) });
    if (judged.kind === "unavailable") {
      report.unavailable.push(task.id);
      ports.log("machine_judge.unavailable", { task_id: task.id, reason: judged.reason });
      continue;
    }
    ruled.push(judged);
    if (cached !== undefined) {
      ports.log("machine_judge.reused", { task_id: task.id, action: judged.ruling.action, pin: cached.pin });
      continue;
    }
    if (!judged.byOperator) state.rulings[task.id] = { pin: taskRulingPin(task), ruling: judged.ruling, bar: judged.bar };
    ports.log("machine_judge.ruled", {
      task_id: task.id,
      action: judged.ruling.action,
      verdict: judged.ruling.verdict,
      confidence: judged.ruling.confidence,
      confidence_bar: judged.bar,
      family: judged.record.family,
      family_mean: judged.record.mean,
      reasons: judged.ruling.reasons,
    });
  }
  const withdraw = unansweredEscalations({ ports, plan, state, released, excluded });
  const reasks = await reaskParkedEscalations({
    ports, plan, state, report, records, released, excluded, isMerged, policy,
    room: ports.limit === undefined ? Infinity : ports.limit - due.length, withdrawing: new Set(withdraw.map((w) => w.task.id)),
  });
  ruled.push(...[...reasks.values()].map((r) => r.judged));
  if (flakePort !== undefined) {
    ruled.push(...await reconsiderReleasedFlakes({ ports, port: flakePort, plan, state, report, records, isMerged, policy, releasedFlakes, retries, retire }));
  }
  // Persisted before landing, so a landing that throws never costs these rulings again.
  writeAtomic(statePath, JSON.stringify(state) + "\n");
  if (ruled.length === 0 && retire.length === 0 && withdraw.length === 0) return report;

  const ws = ports.writeRoot === undefined ? await ports.openWorkspace?.() : undefined;
  const root = ports.writeRoot ?? ws?.root;
  if (root === undefined) throw new Error("machine judge: neither a workspace nor a write root was supplied");
  try {
    let landed: (RulingPins & { action: string })[] = [];
    for (const { task, facts, key } of retire) {
      try {
        const relPath = shardRelPath(task)!;
        const text = readFileIfExists(join(root, relPath));
        const out = text === undefined ? { refused: `${relPath} is absent from the landing tree` } : renderRetiredShard(text, relPath, flakeRetirementReason(facts, ports.clock.iso()));
        if (key !== undefined) (state.flakeReleased ??= {})[task.id] = key;
        if ("refused" in out) {
          (state.declined ??= {})[task.id] = taskRulingPin(task);
          report.refused.push(task.id);
          ports.log("machine_judge.refused", { task_id: task.id, reason: out.refused, main_inherited: true });
          continue;
        }
        writeAtomic(join(root, relPath), out.contents);
        landed.push({ id: task.id, relPath, pin: taskRulingPin(shardRecord(out.contents, relPath)), sourcePin: taskRulingPin(shardRecord(text!, relPath)), action: "retire" });
        (report.retired ??= []).push(task.id);
        const r = facts.retries;
        // The row W1-T9551's main-health rung reads, so the red is routed where a new main-inherited one is.
        ports.log(FLAKE_INCIDENT_MAIN_INHERITED_STEP, {
          origin: task.origin, file: r.file, title: r.title, prs: r.prs, prs_count: r.prs.length, runs: r.runs, base_shas: r.baseShas,
          main_red: facts.mainRed, ...(facts.mainRedBaseSha ? { main_red_base_sha: facts.mainRedBaseSha } : {}), also_failed: r.alsoFailed,
          route: "main-health", task_id: task.id, source: "machine-judge",
        });
        ports.log("machine_judge.main_inherited", { task_id: task.id, origin: task.origin, recovered: r.recovered, also_failed: r.alsoFailed, main_red: facts.mainRed });
      } catch (e) {
        report.failed.push(task.id);
        ports.log("machine_judge.record_failed", { task_id: task.id, error: String((e as Error)?.message ?? e) });
      }
    }
    for (const w of withdraw) {
      const { task } = w;
      try {
        const relPath = shardRelPath(task)!;
        const text = readFileIfExists(join(root, relPath));
        const out = text === undefined
          ? { refused: `${relPath} is absent from the landing tree` }
          : taskRulingPin(shardRecord(text, relPath)) !== taskRulingPin(task)
          ? { refused: `${task.id} changed since its unanswered escalation was read` }
          : renderRetiredShard(text, relPath, unansweredWithdrawalReason(w, ports.clock.iso()), "withdrawn");
        if ("refused" in out) {
          (state.declined ??= {})[task.id] = taskRulingPin(task);
          report.refused.push(task.id);
          ports.log("machine_judge.refused", { task_id: task.id, reason: out.refused, unanswered: true });
          continue;
        }
        writeAtomic(join(root, relPath), out.contents);
        landed.push({ id: task.id, relPath, pin: taskRulingPin(shardRecord(out.contents, relPath)), sourcePin: taskRulingPin(shardRecord(text!, relPath)), action: "withdraw" });
        (report.withdrawn ??= []).push(task.id);
        ports.log("machine_judge.unanswered_withdrawn", {
          task_id: task.id, family: judgementFamily(task), age_days: w.ageDays, age_band: w.band,
          withdraw_after_days: MACHINE_JUDGE_UNANSWERED_WITHDRAW_DAYS, escalated_at: w.escalatedAt, retirement: "withdrawn",
        });
      } catch (e) {
        report.failed.push(task.id);
        ports.log("machine_judge.record_failed", { task_id: task.id, error: String((e as Error)?.message ?? e) });
      }
    }
    for (const r of ruled) {
      try {
        const relPath = shardRelPath(r.task)!;
        const text = readFileIfExists(join(root, relPath));
        const judgedPin = taskRulingPin({ ...r.task, verify: "auto" });
        const admission = { plan, isMerged: (t: Task) => isMerged(t.id), pathExists: (p: string) => existsSync(join(root, p)) };
        let out = text === undefined
          ? { refused: `${relPath} is absent from the landing tree` }
          : renderRuledShard(text, relPath, judgedPin, r.ruling, plan.byId, admission);
        if (text !== undefined && "refused" in out && out.lint && !r.byOperator) {
          // A proceed the record cannot honour is BROKEN, which is the operator's to see: park it,
          // pinned, with the reason, rather than re-asking the judge every pass.
          r.ruling = { ...r.ruling, action: "escalate", reasons: [...r.ruling.reasons, `the judge said proceed, but ${out.refused}`] };
          out = renderRuledShard(text, relPath, judgedPin, r.ruling, plan.byId, admission);
        }
        const reask = reasks.get(r.task.id);
        if (reask !== undefined) {
          // A re-ask counts as a flip only if it lands changed. If the record cannot honour a proceed,
          // it stays parked under its current pin, and nothing is rewritten.
          const held = r.ruling.action === "escalate";
          noteReask(state, reask, !held);
          if (held) {
            ports.log("machine_judge.reask_held", { task_id: r.task.id, reason: r.ruling.reasons.at(-1) });
            continue;
          }
        }
        if ("refused" in out) {
          // Settled by the record's pin, so an unchanged record is not re-judged every pass. A release
          // bypasses `declined`, so it is settled in its own map and told to the operator once.
          if (r.byOperator) {
            (state.refusedReleases ??= {})[r.task.id] = taskRulingPin(r.task);
            ports.stageProposal(refusedReleaseProposal(r.task, out.refused));
          } else (state.declined ??= {})[r.task.id] = taskRulingPin(r.task);
          report.refused.push(r.task.id);
          ports.log("machine_judge.refused", { task_id: r.task.id, reason: out.refused, ...(r.byOperator ? { operator_release: true } : {}) });
          continue;
        }
        const pin = shardRecord(out.contents, relPath).risk_ruling!.pin;
        if (out.contents === text || (r.byOperator && withoutJudgedAt(out.contents) === withoutJudgedAt(text!))) {
          // Main already carries this ruling: the daemon's plan lags the landing tree, so landing it
          // again commits nothing or only a timestamp. Settled by its pin instead (W1-T5359, W1-T5406).
          delete state.rulings[r.task.id];
          state.settled[r.task.id] = taskRulingPin(r.task);
          if (r.byOperator) (state.settledReleases ??= {})[r.task.id] = taskRulingPin(r.task);
          report.settled.push(r.task.id);
          ports.log("machine_judge.already_landed", { task_id: r.task.id, pin });
          continue;
        }
        writeAtomic(join(root, relPath), out.contents);
        landed.push({ id: r.task.id, relPath, pin, sourcePin: taskRulingPin(shardRecord(text!, relPath)), action: r.ruling.action });
        if (r.ruling.action === "proceed") report.proceeded.push(r.task.id);
        else {
          // The inputs this escalation was judged on, kept so that a later move re-opens it (W1-T8830).
          (state.reask ??= {})[r.task.id] = {
            pin, inputs: machineJudgeEvidence(r.task, r.bar, ports.costEvidence?.(r.task), isMerged), askedAt: r.ruling.judgedAt, repeats: 0,
          };
          report.escalated.push(r.task.id);
          if (!ws) ports.stageProposal(machineJudgeProposal(r));
        }
      } catch (e) {
        // One bad record is ledgered and skipped; the rest of the pass still lands (2026-09-30).
        report.failed.push(r.task.id);
        ports.log("machine_judge.record_failed", { task_id: r.task.id, error: String((e as Error)?.message ?? e) });
      }
    }
    if (ws && landed.length > 0) {
      const stale = staleRulingPins(landed, mainRecords(root, landed.map((l) => l.relPath)));
      const staleIds = new Set(stale.map((r) => r.id));
      for (const r of stale) {
        delete state.rulings[r.id];
        ports.log("machine_judge.pin_stale", { task_id: r.id, pin: r.pin, main_pin: r.main_pin });
      }
      landed = landed.filter((l) => !staleIds.has(l.id));
      report.proceeded = report.proceeded.filter((id) => !staleIds.has(id));
      report.escalated = report.escalated.filter((id) => !staleIds.has(id));
      if (report.retired) report.retired = report.retired.filter((id) => !staleIds.has(id));
      if (report.withdrawn) report.withdrawn = report.withdrawn.filter((id) => !staleIds.has(id));
      for (const r of ruled) if (report.escalated.includes(r.task.id)) ports.stageProposal(machineJudgeProposal(r));
    }
    if (ws && landed.length > 0) {
      report.prUrl = await ws.land({
        paths: landed.map((l) => l.relPath),
        title: `chore(plan): the machine-filing judge rules on ${landed.length} machine-filed task(s)`,
        body: machineJudgePrBody(landed),
      });
      if (report.prUrl) state.pending = {
        prUrl: report.prUrl, ids: landed.map((l) => l.id), records: landed,
        repoRoot: dirname(dirname(dirname((ruled[0]?.task ?? retire[0]?.task ?? withdraw[0]!.task).sourcePath!))),
      };
      else report.unlanded = landed.map((l) => l.id);
      ports.log("machine_judge.landed", { pr_url: report.prUrl ?? null, ids: landed.map((l) => l.id) });
    }
  } finally {
    await ws?.dispose();
  }
  writeAtomic(statePath, JSON.stringify(state) + "\n");
  return report;
}

/** How each landed action reads in the judge PR, and the proof its acceptance block carries. */
const LANDED_NOTE: Record<string, { note: string; claim: (id: string) => string; grep: string }> = {
  retire: { note: " (a red inherited from main, routed to main-health; W1-T9694)", claim: (id) => `${id} is retired as a red inherited from main`, grep: "^  retirement: retired" },
  withdraw: {
    note: " (escalated to a person and unanswered for 30 days, so withdrawn, never released; operator ruling 2026-10-13, W1-T9043)",
    claim: (id) => `${id} is withdrawn as an unanswered escalation`, grep: "^  retirement: withdrawn",
  },
};

function machineJudgePrBody(landed: { id: string; relPath: string; pin: string; action: string }[]): string {
  return [
    "The machine-filing judge (operator ruling 2026-09-29) ruled on these machine-filed records. A `proceed` ruling releases the record to `verify: auto`; an `escalate` ruling keeps it parked and stages its reasons in the inbox. Each ruling is pinned to the record it judged, so `machineAuthorVerifyViolation` refuses it if the record changes. Close this PR to decline; the judge will not ask again until a record changes.",
    "",
    ...landed.map((l) => `- \`${l.id}\`: **${l.action}**${LANDED_NOTE[l.action]?.note ?? ""}`),
    "",
    "## Acceptance",
    ...landed.flatMap((l) => {
      const n = LANDED_NOTE[l.action];
      return n !== undefined
        ? [`- claim: ${n.claim(l.id)}`, `  proof: grep: ${n.grep} in ${l.relPath}`]
        : [`- claim: ${l.id} carries the judge's pinned ${l.action} ruling`, `  proof: grep: pin: "${l.pin}" in ${l.relPath}`];
    }),
  ].join("\n");
}

/** Run the pass now, then on the interval, one at a time. */
export function startMachineFilingJudge(ports: MachineJudgePorts, intervalMs: number): { stop: () => void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runMachineFilingJudge(ports);
    } catch (error) {
      ports.log("machine_judge.failed", { error: String((error as Error)?.message ?? error) });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 0);
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
