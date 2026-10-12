import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireDrainLock, DrainLockError } from "./drain-lock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { updateProposalRegistry, type Proposal } from "./inbox.js";
import { renderBakeoff, type BakeoffCandidate, type BakeoffRow } from "./inbox-bakeoff.js";

export interface DeployedModel {
  model: string;
  billing: BakeoffCandidate["billing"];
  efforts: readonly string[];
}
export interface DeploymentBakeoffCandidate extends BakeoffCandidate {
  /** The deployment's pinned thinking level; the incumbent may omit it for legacy mounts. */
  effort?: string;
}
const key = (model: DeployedModel): string => `${model.billing}:${model.model}`;

export function findUntrialedModels(deployed: readonly DeployedModel[], trialed: readonly string[]): DeployedModel[] {
  const seen = new Set(trialed);
  return deployed.filter((model) => {
    const id = key(model);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function deploymentCandidates(models: readonly DeployedModel[], incumbent: DeploymentBakeoffCandidate): DeploymentBakeoffCandidate[] {
  return [incumbent, ...models.flatMap((model) => model.efforts.map((effort) => ({
    id: `${key(model)}:${effort}`, label: `${model.billing} ${model.model} (${effort})`,
    model: model.model, billing: model.billing, effort, tools: true,
  })))];
}

interface TrialState { trialed: string[]; pending?: { id: string; models: string[]; proposal?: Proposal } }

export function readBakeoffTrialState(stateDir: string): TrialState {
  let raw: string;
  try { raw = readFileSync(join(stateDir, "bakeoff-trialed.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { trialed: [] };
    throw error;
  }
  const state = JSON.parse(raw) as TrialState;
  if (!Array.isArray(state.trialed) || state.trialed.some((id) => typeof id !== "string") ||
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
  replay: (candidates: readonly DeploymentBakeoffCandidate[]) => Promise<BakeoffRow[]>;
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
    const models = findUntrialedModels(input.deployed, state.trialed);
    if (models.length === 0) return [];
    const ids = models.map(key);
    const id = `bakeoff:${createHash("sha256").update(JSON.stringify(ids)).digest("hex").slice(0, 16)}`;
    state.trialed.push(...ids);
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
