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
 * EARNED AUTONOMY, NO FIXED BAR. Each filer family's record (its merged tasks, its declined ones,
 * and its gardener's Beta credit where it keeps one) is shown to the judge and sets how confident
 * a `low` verdict must be: {@link earnedConfidenceBar}. A family that keeps helping is trusted
 * more, one that keeps failing less, and either recovers as its outcomes move.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { Clock } from "./clock.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import type { GardenCheckout, PrState } from "./gardener.js";
import type { Proposal } from "./inbox.js";
import { loadPlanFromYaml, type Plan, type Task } from "./plan.js";
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
import { deterministicEscalation } from "./machine-filing.js";
import { lintTask, rulingVerifyViolation, taskRulingPin } from "./task-linter.js";

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
  if (task.status !== "queued" || task.retirement !== undefined || !shardRelPath(task)) return false;
  if (operatorReleases.has(task.id)) return task.verify === "human";
  const unjudged = task.risk_ruling === undefined || task.risk_ruling.pin !== taskRulingPin(task);
  if (task.author_class === "machine") return unjudged;
  return task.verify === "human" && !isRulingShaped(task) && unjudged;
}

/** `plan/tasks.d/<file>` for a record that lives in a shard; the monolith is never rewritten here. */
export function shardRelPath(task: Pick<Task, "sourcePath">): string | undefined {
  const p = task.sourcePath?.replaceAll("\\", "/");
  if (!p || !/(^|\/)plan\/tasks\.d\/[^/]+\.ya?ml$/.test(p)) return undefined;
  return `plan/tasks.d/${basename(p)}`;
}

/** The judge's input: the record as {@link buildFilingRiskJudgeInput} renders it, plus the
 *  operator's escalation rule and the family's record as evidence. */
export function machineJudgeInput(task: Task, record: FamilyTrackRecord): RiskJudgeInput {
  // Judged AS IT WOULD DISPATCH: shown `verify: human`, the judge counted on a person who, on
  // proceed, is never asked (measured 2026-09-29: "verify: human is set, giving a human checkpoint").
  const base = buildFilingRiskJudgeInput({ ...task, verify: "auto" });
  return {
    ...base,
    // Stated first, in the operator's words: the judge's generic framing leans LOW on a defect title.
    change: { ...base.change, description: `OPERATOR ESCALATION RULE: ${MACHINE_JUDGE_ESCALATE_ONLY_IF}\n\n${base.change.description}` },
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
  ports: { riskJudge: (input: RiskJudgeInput) => Promise<RiskJudgeVerdict>; policy: RiskPolicy; clock: Clock },
): Promise<MachineJudgement> {
  const bar = earnedConfidenceBar(ports.policy.confidenceThreshold, record.mean);
  const backstop = deterministicEscalation(task);
  if (backstop) {
    const reasons = [`deterministic backstop: ${backstop} — irreversible or privileged work goes to a person`];
    return { kind: "ruled", task, bar, record, ruling: { verdict: "high", action: "escalate", confidence: 1, reasons, judgedAt: ports.clock.iso() } };
  }
  let verdict: RiskJudgeVerdict;
  try {
    verdict = await ports.riskJudge(machineJudgeInput(task, record));
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

const q = (v: string): string => JSON.stringify(v);

/** Drop an existing `risk_ruling:` block from a single-record shard's text. */
function withoutRulingBlock(lines: string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^ {2}risk_ruling:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && (line.trim() === "" || /^ {4}/.test(line))) continue;
    inBlock = false;
    out.push(line);
  }
  return out;
}

/**
 * Rewrite ONE shard's text with a ruling: `verify:` set by the action and the ruling appended,
 * pinned to the record AS REWRITTEN. Returns undefined, with the reason, when the text is not a
 * single record, names a different id, or the rewrite would not clear the linter it exists for.
 */
export function renderRuledShard(
  text: string,
  relPath: string,
  judgedPin: string,
  ruling: FilingRiskRuling,
): { contents: string } | { refused: string; lint?: true } {
  if ((text.match(/^- id:/gm) ?? []).length !== 1) return { refused: `${relPath} does not hold exactly one record` };
  const verify = ruling.action === "proceed" ? "auto" : "human";
  const lines = withoutRulingBlock(text.replace(/\n+$/, "").split("\n"));
  const verifyAt = lines.findIndex((l) => /^ {2}verify:\s*\S+\s*$/.test(l));
  if (verifyAt < 0) return { refused: `${relPath} has no verify: line` };
  lines[verifyAt] = `  verify: ${verify}`;
  const flipped = lines.join("\n") + "\n";
  const before = loadPlanFromYaml(text, relPath).tasks[0]!;
  const after = loadPlanFromYaml(flipped, relPath).tasks[0]!;
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
  const reparsed = loadPlanFromYaml(contents, relPath).tasks[0]!;
  // The pin is taken from `after`, whose pinned fields the block above does not touch, and a
  // `proceed` is written at `verify: auto` while an `escalate` stays `verify: human`: the written
  // pin matches and machine-author-verify clears by construction, so neither is re-checked here.
  const blocking = (t: Task) => new Set(lintTask(t).violations.filter((v) => v.severity === "block").map((v) => v.check));
  const had = blocking(before);
  const added = [...blocking(reparsed)].filter((c) => !had.has(c));
  if (added.length > 0) return { refused: `${reparsed.id}: at verify: auto it fails lint (${added.join(", ")})`, lint: true };
  return { contents };
}

interface MachineJudgeState {
  pending?: { prUrl: string; ids: string[] };
  /** A record whose judge PR a person closed, by the pin it had: not re-asked until it changes. */
  declined?: Record<string, string>;
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
  openWorkspace?: () => GardenCheckout;
  writeRoot?: string;
  /** Task ids the operator released with `rmd approve` ({@link readOperatorReleases}). */
  operatorReleases?: () => ReadonlySet<string>;
  prState?: (prUrl: string) => PrState;
  stageProposal: (proposal: Proposal) => void;
  log: (step: string, extra?: Record<string, unknown>) => void;
  clock: Clock;
  limit?: number;
  excludeFamilies?: readonly string[];
}

export interface MachineJudgeReport {
  proceeded: string[];
  escalated: string[];
  unavailable: string[];
  refused: string[];
  prUrl?: string;
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
  return {
    id: `machine-judge:${task.id}`,
    summary:
      `${task.id} ${task.author_class === "machine" ? `was filed by the ${record.family} gardener` : "is your verify: human record"} and the risk judge escalated it, so it ` +
      `stays parked for you:\n  ${ruling.reasons.join("\n  ")}\n\n${task.title}\n\n` +
      `Family record: ${record.merged} merged, ${record.declined} declined. Release it with ` +
      `\`rmd approve ${task.id}\`, or edit the record and the judge will rule again.`,
    evidenceAnchors: [],
  };
}

/** One pass: rule on every unjudged or stale machine record, then land or write the rewrites. */
export async function runMachineFilingJudge(ports: MachineJudgePorts): Promise<MachineJudgeReport> {
  const statePath = join(ports.stateDir, MACHINE_JUDGE_STATE_FILE);
  const state = readState(statePath);
  const report: MachineJudgeReport = { proceeded: [], escalated: [], unavailable: [], refused: [] };
  if (state.pending) {
    const pr = ports.prState?.(state.pending.prUrl) ?? "unknown";
    if (pr === "open" || pr === "unknown") {
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
      (released.has(t.id) || (!excluded.has(judgementFamily(t)) && state.declined?.[t.id] !== taskRulingPin(t))),
  );
  const policy = ports.riskPolicy?.() ?? DEFAULT_RISK_POLICY;
  const records = new Map<string, FamilyTrackRecord>();
  const ruled: Extract<MachineJudgement, { kind: "ruled" }>[] = [];
  for (const task of due.slice(0, ports.limit ?? due.length)) {
    const family = judgementFamily(task);
    if (!records.has(family)) records.set(family, familyTrackRecord(plan, family, isMerged, ports.gardenRecord?.(family)));
    const judged: MachineJudgement = released.has(task.id)
      ? {
          kind: "ruled", task, bar: 0, record: records.get(family)!, byOperator: true,
          ruling: { verdict: "operator", action: "proceed", confidence: 1, reasons: ["released by the operator with rmd approve"], judgedAt: ports.clock.iso() },
        }
      : await judgeMachineShard(task, records.get(family)!, { riskJudge: ports.riskJudge, policy, clock: ports.clock });
    if (judged.kind === "unavailable") {
      report.unavailable.push(task.id);
      ports.log("machine_judge.unavailable", { task_id: task.id, reason: judged.reason });
      continue;
    }
    ruled.push(judged);
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
  if (ruled.length === 0) {
    writeAtomic(statePath, JSON.stringify(state) + "\n");
    return report;
  }

  const ws = ports.writeRoot === undefined ? ports.openWorkspace?.() : undefined;
  const root = ports.writeRoot ?? ws?.root;
  if (root === undefined) throw new Error("machine judge: neither a workspace nor a write root was supplied");
  try {
    const landed: { id: string; relPath: string; pin: string; action: string }[] = [];
    for (const r of ruled) {
      const relPath = shardRelPath(r.task)!;
      const text = readFileIfExists(join(root, relPath));
      const judgedPin = taskRulingPin({ ...r.task, verify: "auto" });
      let out = text === undefined
        ? { refused: `${relPath} is absent from the landing tree` }
        : renderRuledShard(text, relPath, judgedPin, r.ruling);
      if (text !== undefined && "refused" in out && out.lint && !r.byOperator) {
        // A proceed the record cannot honour is BROKEN, which is the operator's to see: park it,
        // pinned, with the reason, rather than re-asking the judge every pass.
        r.ruling = { ...r.ruling, action: "escalate", reasons: [...r.ruling.reasons, `the judge said proceed, but ${out.refused}`] };
        out = renderRuledShard(text, relPath, judgedPin, r.ruling);
      }
      if ("refused" in out) {
        // Settled by the record's pin, so an unchanged record is not re-judged every pass.
        (state.declined ??= {})[r.task.id] = taskRulingPin(r.task);
        report.refused.push(r.task.id);
        ports.log("machine_judge.refused", { task_id: r.task.id, reason: out.refused });
        continue;
      }
      writeAtomic(join(root, relPath), out.contents);
      const pin = loadPlanFromYaml(out.contents, relPath).tasks[0]!.risk_ruling!.pin;
      landed.push({ id: r.task.id, relPath, pin, action: r.ruling.action });
      if (r.ruling.action === "proceed") report.proceeded.push(r.task.id);
      else {
        report.escalated.push(r.task.id);
        ports.stageProposal(machineJudgeProposal(r));
      }
    }
    if (ws && landed.length > 0) {
      report.prUrl = ws.land({
        paths: landed.map((l) => l.relPath),
        title: `chore(plan): the machine-filing judge rules on ${landed.length} machine-filed task(s)`,
        body: machineJudgePrBody(landed),
      });
      if (report.prUrl) state.pending = { prUrl: report.prUrl, ids: landed.map((l) => l.id) };
      ports.log("machine_judge.landed", { pr_url: report.prUrl ?? null, ids: landed.map((l) => l.id) });
    }
  } finally {
    ws?.dispose();
  }
  writeAtomic(statePath, JSON.stringify(state) + "\n");
  return report;
}

function machineJudgePrBody(landed: { id: string; relPath: string; pin: string; action: string }[]): string {
  return [
    "The machine-filing judge (operator ruling 2026-09-29) ruled on these machine-filed records. A `proceed` ruling releases the record to `verify: auto`; an `escalate` ruling keeps it parked and stages its reasons in the inbox. Each ruling is pinned to the record it judged, so `machineAuthorVerifyViolation` refuses it if the record changes. Close this PR to decline; the judge will not ask again until a record changes.",
    "",
    ...landed.map((l) => `- \`${l.id}\`: **${l.action}**`),
    "",
    "## Acceptance",
    ...landed.flatMap((l) => [`- claim: ${l.id} carries the judge's pinned ${l.action} ruling`, `  proof: grep: pin: "${l.pin}" in ${l.relPath}`]),
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
