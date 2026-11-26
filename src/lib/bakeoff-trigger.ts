import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireDrainLock, DrainLockError } from "./drain-lock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { updateProposalRegistry, type Proposal } from "./inbox.js";
import { renderBakeoff, type BakeoffCandidate, type BakeoffRow } from "./inbox-bakeoff.js";
import { CASH_RESPONSES_DEPLOYMENTS } from "./cash-responses.js";
import { invoiceLeadEligibility, readNewestInvoiceVerdictsAsync } from "./cash-invoice-reconcile.js";
import { readLedgerUnionRecordsSync } from "./ledger-grep.js";
import { isFoundryClaudeDeployment, OPENWEIGHT_REASONING_EFFORTS } from "./worker-provider.js";
import { systemClock, type Clock } from "./clock.js";
import { JUDGE_REPLAY_STALE_DAYS, judgeReplayPoolRefusal, readJudgeShadowPoolRecord, recordJudgeReplayFigures, type JudgeReplayFigures } from "./judge-shadow.js";
import type { JudgeReplayFinishedRow } from "./judge-replay-batch.js";

/** W1-T12422: a decision model is billed `decisions` and keyed `decisions:<candidate>`, apart from `cash:<deployment>`. */
export interface DeployedModel {
  model: string;
  billing: BakeoffCandidate["billing"] | "decisions";
  efforts: readonly string[];
  readinessDigest?: string;
}

/** W1-T12422: one direct judge replay of one model, and the shadow roles whose pool its figures decide. */
export interface JudgeReplayOutcome {
  roles: readonly string[];
  row: Pick<JudgeReplayFinishedRow, "corpus" | "outcome" | "reason" | "sent" | "rejected" | "median_case_settled_usd" | "settled_usd">;
}

/** A replay stopped by a 429 or a budget refusal bought no trial: the model stays untrialed and is tried on a later pass. */
const RETRIED_STOPS: ReadonlySet<string> = new Set(["rate-limited", "budget-refused"]);
export interface DeploymentBakeoffCandidate extends BakeoffCandidate {
  /** The deployment's pinned thinking level; the incumbent may omit it for legacy mounts. */
  effort?: string;
}
const key = (model: DeployedModel): string => `${model.billing}:${model.model}`;

export function findUntrialedModels(deployed: readonly DeployedModel[], trialed: readonly string[], digests: Readonly<Record<string, string>> = {}): DeployedModel[] {
  const seen = new Set<string>();
  const measured = new Set(trialed);
  return deployed.filter((model) => {
    const id = key(model);
    if (seen.has(id)) return false;
    seen.add(id);
    return !measured.has(id) || !!(model.readinessDigest && digests[id] !== undefined && digests[id] !== model.readinessDigest);
  });
}

export function deploymentCandidates(models: readonly DeployedModel[], incumbent: DeploymentBakeoffCandidate): DeploymentBakeoffCandidate[] {
  // A decision model answers typed questions only: it has no inbox-draft arm.
  return [incumbent, ...models.filter((model): model is DeployedModel & { billing: BakeoffCandidate["billing"] } => model.billing !== "decisions").flatMap((model) => {
    // Responses and Foundry Claude send effort natively; a chat deployment with no effort row drops reasoning_effort
    // at transport, so its effort arms would only repeat thinking off.
    const native = CASH_RESPONSES_DEPLOYMENTS[model.model] !== undefined || isFoundryClaudeDeployment(model.model);
    const efforts = model.billing !== "cash" ? model.efforts : OPENWEIGHT_REASONING_EFFORTS[model.model] ?? (native ? model.efforts : []);
    const arms: Array<string | undefined> = model.billing === "cash" ? [undefined, ...new Set(efforts)] : [...new Set(efforts)];
    return arms.map((effort) => ({
      id: `${key(model)}:${effort ?? "off"}`, label: `${model.billing} ${model.model} (${effort ?? "thinking off"})`,
      model: model.model, billing: model.billing, ...(effort === undefined ? {} : { effort }), tools: true,
    }));
  })];
}

interface TrialState {
  trialed: string[]; readinessDigests?: Record<string, string>; pending?: { id: string; models: string[]; proposal?: Proposal };
  /** W1-T12422: the models whose direct judge replay ran, and the readiness digest it ran at. */
  judgeTrialed?: string[]; judgeDigests?: Record<string, string>;
  /** W1-T14841: when each model's judge replay was last started, so stale figures buy one replay per bound, not one per pass. */
  judgeReplayedAt?: Record<string, string>;
}

export function readBakeoffTrialState(stateDir: string): TrialState {
  let raw: string;
  try { raw = readFileSync(join(stateDir, "bakeoff-trialed.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { trialed: [] };
    throw error;
  }
  const state = JSON.parse(raw) as TrialState;
  if (!Array.isArray(state.trialed) || state.trialed.some((id) => typeof id !== "string") ||
    (state.readinessDigests !== undefined && (state.readinessDigests === null || typeof state.readinessDigests !== "object" ||
      Array.isArray(state.readinessDigests) || Object.values(state.readinessDigests).some((digest) => typeof digest !== "string"))) ||
    (state.judgeTrialed !== undefined && (!Array.isArray(state.judgeTrialed) || state.judgeTrialed.some((id) => typeof id !== "string"))) ||
    (state.judgeDigests !== undefined && (state.judgeDigests === null || typeof state.judgeDigests !== "object" || Array.isArray(state.judgeDigests) ||
      Object.values(state.judgeDigests).some((digest) => typeof digest !== "string"))) ||
    (state.judgeReplayedAt !== undefined && (state.judgeReplayedAt === null || typeof state.judgeReplayedAt !== "object" ||
      Array.isArray(state.judgeReplayedAt) || Object.values(state.judgeReplayedAt).some((at) => typeof at !== "string"))) ||
    (state.pending && (typeof state.pending.id !== "string" || !Array.isArray(state.pending.models) ||
      state.pending.models.some((id) => typeof id !== "string") ||
      (state.pending.proposal && (state.pending.proposal.id !== state.pending.id || typeof state.pending.proposal.summary !== "string"))))) {
    throw new Error("bake-off trial history is unreadable; refusing to spend");
  }
  return state;
}

export interface DeploymentBakeoffInput {
  stateDir: string;
  deployed: readonly DeployedModel[];
  incumbent: DeploymentBakeoffCandidate;
  replay?: (candidates: readonly DeploymentBakeoffCandidate[]) => Promise<BakeoffRow[]>;
  /** W1-T12422: the direct judge replay of one cash deployment or decision model, for each `shadow: auto` role. */
  judgeReplay?: (model: DeployedModel) => Promise<JudgeReplayOutcome[]>;
  /** W1-T14841: what the judge replay is keyed on beside each model's readiness digest (judge-shadow.ts judgeReplayKey):
   *  the `shadow: auto` roles and the decision reader revision. A change replays every judge-trialed model once. */
  judgeReplayKey?: string;
  /** W1-T14841: the `shadow: auto` roles. A trialed model whose pool figures for one are older than
   *  JUDGE_REPLAY_STALE_DAYS is replayed once more. */
  judgeReplayRoles?: readonly string[];
  /** The clock, for a test; production reads the system clock. */
  clock?: Pick<Clock, "now" | "iso">;
}

const DAY_MS = 86_400_000;

/** W1-T14841: the model as the judge replay keys it: its readiness digest joined with the replay key. */
function judgeKeyed(model: DeployedModel, replayKey: string | undefined): DeployedModel {
  if (replayKey === undefined || model.readinessDigest === undefined) return model;
  return { ...model, readinessDigest: createHash("sha256").update(`${model.readinessDigest}\u0000${replayKey}`).digest("hex") };
}

/** W1-T14841: a judge-trialed model is stale when its pool figures for an auto role are older than the bound and its
 *  last replay started before the bound too. An unreadable pool record names no model stale. */
function staleJudgeModels(models: readonly DeployedModel[], input: DeploymentBakeoffInput, state: TrialState, nowMs: number): DeployedModel[] {
  const roles = input.judgeReplayRoles ?? [];
  if (roles.length === 0) return [];
  let record;
  try { record = readJudgeShadowPoolRecord(input.stateDir); }
  catch (error) {
    process.stderr.write(`bake-off: the judge pool record is unreadable, so no model is replayed as stale: ${error instanceof Error ? error.message : String(error)}\n`);
    return [];
  }
  const bound = nowMs - JUDGE_REPLAY_STALE_DAYS * DAY_MS;
  return models.filter((model) => {
    const id = key(model);
    if (!(state.judgeTrialed ?? []).includes(id)) return false;
    const started = state.judgeReplayedAt?.[id];
    if (started !== undefined && Date.parse(started) > bound) return false;
    return roles.some((role) => {
      const figures = record.replays[role]?.[id];
      return figures !== undefined && Date.parse(figures.finishedAt) <= bound;
    });
  });
}

/** W1-T12422: the replay figures one finished replay stores for the pool. */
function replayFigures(row: JudgeReplayOutcome["row"], finishedAt: string): JudgeReplayFigures {
  return { corpus: row.corpus, sent: row.sent, rejected: row.rejected, medianCaseUsd: row.median_case_settled_usd, finishedAt };
}

/** W1-T12422: the proposal's table of judge replay figures, one line per model and corpus, naming each pool refusal. */
export function renderJudgeReplays(outcomes: ReadonlyArray<{ key: string; outcome: JudgeReplayOutcome }>): string {
  if (outcomes.length === 0) return "";
  const lines = outcomes.map(({ key: id, outcome: { roles, row } }) => {
    const refusal = judgeReplayPoolRefusal(replayFigures(row, ""));
    const share = row.sent === 0 ? "-" : `${((row.rejected / row.sent) * 100).toFixed(1)}%`;
    const median = row.median_case_settled_usd === null ? "-" : `$${row.median_case_settled_usd.toFixed(4)}`;
    const verdict = row.outcome !== "finished" ? `not trialed: ${row.outcome}${row.reason ? ` (${row.reason})` : ""}`
      : refusal === undefined ? "joins the pool" : `stays out: ${refusal}`;
    return `| ${id} | ${roles.join(", ")} | ${row.corpus} | ${row.sent} | ${share} | ${median} | ${verdict} |`;
  });
  return ["Judge replays (W1-T12421's direct lane) for the `shadow: auto` roles:", "",
    "| Model | Roles | Corpus | Cases sent | Rejected | Median $ per case | Pool |", "| --- | --- | --- | --- | --- | --- | --- |", ...lines].join("\n");
}

/** Claim before spending: an abandoned sweep or a restart cannot buy a second trial. */
export async function runDeploymentBakeoff(input: DeploymentBakeoffInput): Promise<Proposal[]> {
  let lock;
  try { lock = acquireDrainLock(join(input.stateDir, "bakeoff-trialed.lock")); }
  catch (error) {
    // A named lock-contention result means another sweep owns this trial; skip without spending.
    if (error instanceof DrainLockError) return [];
    throw error;
  }
  try {
    const path = join(input.stateDir, "bakeoff-trialed.json");
    const missing = !existsSync(path);
    const state = readBakeoffTrialState(input.stateDir);
    const save = () => writeAtomic(path, JSON.stringify(state));
    const publish = (): Proposal => {
      const pending = state.pending!;
      const proposal = pending.proposal ?? { id: pending.id,
        summary: `Deployment bake-off interrupted for ${pending.models.join(", ")}. No completed table is available. Re-run manually to measure it; routing is unchanged.`,
        evidenceAnchors: [] };
      updateProposalRegistry(join(input.stateDir, "inbox-proposals.json"), (current) =>
        current.some((p) => p.id === proposal.id) ? null : [...current, proposal]);
      delete state.pending;
      save();
      return proposal;
    };
    // Recover the report write independently of the paid replay.
    if (state.pending) return [publish()];
    if (!input.replay && !input.judgeReplay) return [];
    if (missing) {
      const history = readLedgerUnionRecordsSync(input.stateDir, { step: "inbox.bakeoff", refuseIncomplete: true });
      if (!history.ok) throw new Error(`bake-off ledger history is unreadable; refusing to spend: ${history.unread.join(", ")}`);
      for (const record of history.rows) {
        const row = record as { step?: string; candidate?: string; model?: string; billing?: string; status?: string };
        if (row.step !== "inbox.bakeoff" || row.status === "capacity_shortfall") continue;
        if (typeof row.model === "string" && (row.billing === "cash" || row.billing === "subscription"))
          state.trialed.push(`${row.billing}:${row.model}`);
        for (const model of input.deployed) {
          const legacy = `${model.billing}-${model.model}`;
          if (row.billing === model.billing && (row.model === model.model || row.candidate === legacy ||
            row.candidate?.startsWith(`${legacy}-`) || row.candidate?.startsWith(`${key(model)}:`))) state.trialed.push(key(model));
        }
      }
    }
    state.trialed = [...new Set(state.trialed)];
    state.readinessDigests ??= {};
    for (const model of input.deployed) {
      if (state.trialed.includes(key(model)) && model.readinessDigest && state.readinessDigests[key(model)] === undefined)
        state.readinessDigests[key(model)] = model.readinessDigest;
    }
    // W1-T12422: a decision model gets the judge replay only; a cash deployment gets both; Foundry Claude neither.
    const models = input.replay ? findUntrialedModels(input.deployed.filter((model) => model.billing !== "decisions"), state.trialed, state.readinessDigests) : [];
    state.judgeTrialed ??= [];
    state.judgeDigests ??= {};
    const judgeable = input.deployed.filter((model) => model.billing !== "subscription" && !isFoundryClaudeDeployment(model.model))
      .map((model) => judgeKeyed(model, input.judgeReplayKey));
    const clock = input.clock ?? systemClock;
    const nowMs = clock.now();
    const untrialed = input.judgeReplay ? findUntrialedModels(judgeable, state.judgeTrialed, state.judgeDigests) : [];
    const judged = input.judgeReplay ? [...untrialed, ...staleJudgeModels(judgeable, input, state, nowMs)
      .filter((model) => !untrialed.some((u) => key(u) === key(model)))] : [];
    if (judged.length > 0) {
      state.judgeReplayedAt ??= {};
      for (const model of judged) state.judgeReplayedAt[key(model)] = clock.iso();
    }
    save();
    if (models.length === 0 && judged.length === 0) return [];
    const ids = models.map(key);
    const judgedIds = judged.map(key);
    const id = `bakeoff:${randomUUID()}`;
    state.trialed = [...new Set([...state.trialed, ...ids])];
    for (const model of models) if (model.readinessDigest) state.readinessDigests[key(model)] = model.readinessDigest;
    state.judgeTrialed = [...new Set([...state.judgeTrialed, ...judgedIds])];
    for (const model of judged) if (model.readinessDigest) state.judgeDigests[key(model)] = model.readinessDigest;
    state.pending = { id, models: [...new Set([...ids, ...judgedIds])] };
    save();
    let summary: string;
    try {
      const candidates = deploymentCandidates(models, input.incumbent);
      const rows = models.length > 0 && input.replay ? await input.replay(candidates) : [];
      // Capacity refusals bought no trial. Keep them eligible when the learned quota changes.
      const skipped = models.filter((model) => {
        const arms = candidates.filter((c) => c.id.startsWith(`${key(model)}:`));
        return arms.length > 0 && arms.every((c) => rows.some((r) => r.candidate === c.id && r.status === "capacity_shortfall"));
      }).map(key);
      state.trialed = state.trialed.filter((id) => !skipped.includes(id));
      for (const id of skipped) delete state.readinessDigests[id];
      // W1-T10858: an open-weight arm is marked not eligible to lead until Azure's bill reconciles with its list price.
      const eligibility = models.length === 0 ? "" : invoiceLeadEligibility(rows, await readNewestInvoiceVerdictsAsync(input.stateDir));
      // W1-T12422: one replay at a time; a 429 or a budget stop leaves the model untrialed for a later pass.
      const replays: Array<{ key: string; outcome: JudgeReplayOutcome }> = [];
      for (const model of judged) {
        const outcomes = await input.judgeReplay!(model);
        for (const outcome of outcomes) {
          replays.push({ key: key(model), outcome });
          if (outcome.row.outcome === "finished") {
            for (const role of outcome.roles) recordJudgeReplayFigures(input.stateDir, role, key(model), replayFigures(outcome.row, systemClock.iso()));
          }
        }
        if (outcomes.some((o) => o.row.outcome === "stopped" && RETRIED_STOPS.has(o.row.reason ?? ""))) {
          state.judgeTrialed = state.judgeTrialed.filter((trialed) => trialed !== key(model));
          state.judgeDigests = Object.fromEntries(Object.entries(state.judgeDigests).filter(([trialed]) => trialed !== key(model)));
        }
      }
      const inbox = models.length === 0 ? "" : `${renderBakeoff(rows)}${eligibility ? `\n\n${eligibility}` : ""}`;
      const judgeTable = renderJudgeReplays(replays);
      summary = `Deployment bake-off for ${[...new Set([...ids, ...judgedIds])].join(", ")}. Compare the new models and thinking levels with the incumbent; the operator picks. Routing is unchanged.\n\n${[inbox, judgeTable].filter(Boolean).join("\n\n")}`;
    } catch (error) {
      // Preserve the provider or replay failure verbatim in the operator-facing proposal.
      summary = `Deployment bake-off failed for ${ids.join(", ")}: ${String(error)}. No completed table is available. Re-run manually to measure it; routing is unchanged.`;
    }
    state.pending.proposal = { id, summary, evidenceAnchors: [] };
    save();
    return [publish()];
  } finally { lock.release(); }
}
