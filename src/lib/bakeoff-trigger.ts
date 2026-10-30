import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireDrainLock, DrainLockError } from "./drain-lock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { updateProposalRegistry, type Proposal } from "./inbox.js";
import { renderBakeoff, type BakeoffCandidate, type BakeoffRow } from "./inbox-bakeoff.js";
import { readLedgerUnionRecordsSync } from "./ledger-grep.js";

export interface DeployedModel {
  model: string;
  billing: BakeoffCandidate["billing"];
  efforts: readonly string[];
  readinessDigest?: string;
}
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
  return [incumbent, ...models.flatMap((model) => model.efforts.map((effort) => ({
    id: `${key(model)}:${effort}`, label: `${model.billing} ${model.model} (${effort})`,
    model: model.model, billing: model.billing, effort, tools: true,
  })))];
}

interface TrialState { trialed: string[]; readinessDigests?: Record<string, string>; pending?: { id: string; models: string[]; proposal?: Proposal } }

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
    if (!input.replay) return [];
    if (missing) {
      const history = readLedgerUnionRecordsSync(input.stateDir, { step: "inbox.bakeoff", refuseIncomplete: true });
      if (!history.ok) throw new Error(`bake-off ledger history is unreadable; refusing to spend: ${history.unread.join(", ")}`);
      for (const record of history.rows) {
        const row = record as { step?: string; candidate?: string; model?: string; billing?: string };
        if (row.step !== "inbox.bakeoff") continue;
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
    const models = findUntrialedModels(input.deployed, state.trialed, state.readinessDigests);
    save();
    if (models.length === 0) return [];
    const ids = models.map(key);
    const id = `bakeoff:${randomUUID()}`;
    state.trialed = [...new Set([...state.trialed, ...ids])];
    for (const model of models) if (model.readinessDigest) state.readinessDigests[key(model)] = model.readinessDigest;
    state.pending = { id, models: ids };
    save();
    let summary: string;
    try {
      const rows = await input.replay(deploymentCandidates(models, input.incumbent));
      summary = `Deployment bake-off for ${ids.join(", ")}. Compare the new models and thinking levels with the incumbent; the operator picks. Routing is unchanged.\n\n${renderBakeoff(rows)}`;
    } catch (error) {
      // Preserve the provider or replay failure verbatim in the operator-facing proposal.
      summary = `Deployment bake-off failed for ${ids.join(", ")}: ${String(error)}. No completed table is available. Re-run manually to measure it; routing is unchanged.`;
    }
    state.pending.proposal = { id, summary, evidenceAnchors: [] };
    save();
    return [publish()];
  } finally { lock.release(); }
}
