import { createHash } from "node:crypto";
import type { Config, WorkerProviderId } from "./config.js";
import type { Mount, Mounts } from "./mounts.js";
import type { MountHeadroomArm, MountHeadroomCell } from "./mount-recommender.js";

export interface MountExplorationPolicy {
  kind: "bounded-fraction";
  fraction: number;
}

/**
 * PRIMARY CONTROL: at most this share of eligible implementation dispatches may ride an
 * exploratory arm. Bounded exploration supplies the variation `recommendMounts` needs without
 * silently rewriting the committed mounts table.
 */
export const MOUNT_EXPLORATION_POLICY: MountExplorationPolicy = {
  kind: "bounded-fraction",
  fraction: 0.05,
};

const EXCLUDED_LANES = new Set(["architect", "judge"]);

export type MountExplorationRefusalReason =
  | "excluded-risk"
  | "excluded-lane"
  | "missing-cell"
  | "unmatched-arms"
  | "on-policy-arm-missing"
  | "runner-up-unavailable"
  | "invalid-policy"
  | "outside-fraction";

export interface MountExplorationArm {
  armKey: string;
  provider: WorkerProviderId;
  servedModel: string;
  effort: string;
  n: number;
}

export interface MountExplorationDispatch {
  kind: "explore";
  policy: MountExplorationPolicy;
  cellKey: string;
  type: string;
  risk: string;
  taskClass: string;
  onPolicyArm: MountExplorationArm;
  exploredArm: MountExplorationArm;
  mount: Mount;
  sampleUnit: number;
  reason: "bounded-fraction-runner-up";
  codexModelPreference?: { capability: string; effort: string; model: string };
}

export interface MountExplorationRefusal {
  kind: "refusal";
  policy: MountExplorationPolicy;
  reason: MountExplorationRefusalReason;
  detail: string;
  cellKey?: string;
  exclusion?: "risk" | "lane";
}

export type MountExplorationDecision = MountExplorationDispatch | MountExplorationRefusal;

export interface ExploreMountInput {
  cells: readonly MountHeadroomCell[];
  mounts: Mounts;
  taskType: string;
  risk: string;
  taskClass: string;
  currentMount: Mount;
  runId: string;
  taskId?: string;
  enabledProviders: readonly WorkerProviderId[];
  policy?: MountExplorationPolicy;
  sampleUnit?: number;
}

interface ExpressedArm {
  arm: MountExplorationArm;
  mount: Mount;
  codexModelPreference?: { capability: string; effort: string; model: string };
}

function cellKeyOf(input: Pick<ExploreMountInput, "taskType" | "risk" | "taskClass">): string {
  return `${input.taskType}::${input.risk}::${input.taskClass}`;
}

function stableUnit(parts: readonly string[]): number {
  const hex = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 13);
  return Number.parseInt(hex, 16) / 0x10000000000000;
}

function asWorkerProvider(value: string): WorkerProviderId | undefined {
  return value === "claude" || value === "codex" ? value : undefined;
}

function armSummary(arm: MountHeadroomArm): MountExplorationArm | undefined {
  const provider = asWorkerProvider(arm.provider);
  if (!provider) return undefined;
  return { armKey: arm.armKey, provider, servedModel: arm.servedModel, effort: arm.effort, n: arm.n };
}

function capabilityForClaudeModel(mounts: Mounts, model: string): string | undefined {
  return mounts.capabilities?.claude[model];
}

function claudeCandidatesFor(mounts: Mounts, capability: string | undefined): readonly string[] {
  if (!capability) return [];
  return mounts.capabilities?.claudeCandidates?.[capability] ?? [];
}

function codexCapabilityForArm(mounts: Mounts, arm: MountExplorationArm): string | undefined {
  const codex = mounts.capabilities?.codex;
  if (!codex) return undefined;
  return Object.entries(codex).find(([, byEffort]) => byEffort[arm.effort]?.includes(arm.servedModel))?.[0];
}

function armMatchesCurrentMount(mounts: Mounts, arm: MountExplorationArm, currentMount: Mount): boolean {
  if (arm.effort !== currentMount.effort) return false;
  const capability = capabilityForClaudeModel(mounts, currentMount.model);
  if (arm.provider === "claude") {
    return arm.servedModel === currentMount.model || claudeCandidatesFor(mounts, capability).includes(arm.servedModel);
  }
  return mounts.capabilities?.codex[capability ?? ""]?.[currentMount.effort]?.includes(arm.servedModel) ?? false;
}

function expressArm(mounts: Mounts, currentMount: Mount, arm: MountExplorationArm): ExpressedArm | undefined {
  if (arm.provider === "claude") {
    if (!(arm.servedModel in mounts.tiers)) return undefined;
    return { arm, mount: { ...currentMount, model: arm.servedModel, effort: arm.effort } };
  }
  const capability = codexCapabilityForArm(mounts, arm);
  const requestedModel = claudeCandidatesFor(mounts, capability)[0];
  if (!capability || !requestedModel) return undefined;
  return {
    arm,
    mount: { ...currentMount, model: requestedModel, effort: arm.effort },
    codexModelPreference: { capability, effort: arm.effort, model: arm.servedModel },
  };
}

function bySampleThenKey(a: MountExplorationArm, b: MountExplorationArm): number {
  return b.n - a.n || (a.armKey < b.armKey ? -1 : a.armKey > b.armKey ? 1 : 0);
}

function refuse(
  policy: MountExplorationPolicy,
  reason: MountExplorationRefusalReason,
  detail: string,
  extra: Pick<MountExplorationRefusal, "cellKey" | "exclusion"> = {},
): MountExplorationRefusal {
  return { kind: "refusal", policy, reason, detail, ...extra };
}

export function exploreMount(input: ExploreMountInput): MountExplorationDecision {
  const policy = input.policy ?? MOUNT_EXPLORATION_POLICY;
  if (!(policy.fraction > 0 && policy.fraction <= 1)) {
    return refuse(policy, "invalid-policy", `mount exploration policy fraction must be > 0 and <= 1, got ${policy.fraction}.`);
  }
  if (input.risk === "high") {
    return refuse(policy, "excluded-risk", "risk:high cells are excluded from mount exploration.", { exclusion: "risk" });
  }
  if (EXCLUDED_LANES.has(input.taskType)) {
    return refuse(policy, "excluded-lane", `${input.taskType} lanes are excluded from mount exploration.`, {
      exclusion: "lane",
    });
  }

  const cellKey = cellKeyOf(input);
  const cell = input.cells.find((candidate) => candidate.cellKey === cellKey);
  if (!cell) return refuse(policy, "missing-cell", `no mount-headroom cell exists for ${cellKey}.`, { cellKey });
  const enabled = new Set(input.enabledProviders);
  const arms = cell.arms
    .map(armSummary)
    .filter((arm): arm is MountExplorationArm => arm !== undefined && enabled.has(arm.provider));
  if (arms.length < 2) {
    return refuse(policy, "unmatched-arms", `cell ${cellKey} has fewer than two enabled provider arms to explore.`, {
      cellKey,
    });
  }

  const onPolicyArm = arms
    .filter((arm) => armMatchesCurrentMount(input.mounts, arm, input.currentMount))
    .sort(bySampleThenKey)[0];
  if (!onPolicyArm) {
    return refuse(policy, "on-policy-arm-missing", `cell ${cellKey} has no arm matching the current mount.`, { cellKey });
  }

  const runnerUp = arms
    .filter((arm) => arm.armKey !== onPolicyArm.armKey)
    .sort(bySampleThenKey)
    .map((arm) => expressArm(input.mounts, input.currentMount, arm))
    .find((candidate): candidate is ExpressedArm => candidate !== undefined);
  if (!runnerUp) {
    return refuse(policy, "runner-up-unavailable", `cell ${cellKey} has no runner-up arm expressible as spawn knobs.`, {
      cellKey,
    });
  }

  const sample = input.sampleUnit ?? stableUnit([input.runId, input.taskId ?? "", cellKey, onPolicyArm.armKey, runnerUp.arm.armKey]);
  if (!(sample >= 0 && sample < policy.fraction)) {
    return refuse(
      policy,
      "outside-fraction",
      `cell ${cellKey} sampled ${sample.toFixed(6)}, outside the declared ${policy.fraction} exploration fraction.`,
      { cellKey },
    );
  }

  return {
    kind: "explore",
    policy,
    cellKey,
    type: cell.type,
    risk: cell.risk,
    taskClass: cell.taskClass,
    onPolicyArm,
    exploredArm: runnerUp.arm,
    mount: runnerUp.mount,
    sampleUnit: sample,
    reason: "bounded-fraction-runner-up",
    ...(runnerUp.codexModelPreference ? { codexModelPreference: runnerUp.codexModelPreference } : {}),
  };
}

export function mountExplorationLedgerFields(decision: MountExplorationDispatch): Record<string, unknown> {
  return {
    cell: decision.cellKey,
    task_type: decision.type,
    risk: decision.risk,
    task_class: decision.taskClass,
    on_policy_arm: decision.onPolicyArm.armKey,
    explored_arm: decision.exploredArm.armKey,
    on_policy: {
      provider: decision.onPolicyArm.provider,
      served_model: decision.onPolicyArm.servedModel,
      effort: decision.onPolicyArm.effort,
      n: decision.onPolicyArm.n,
    },
    explored: {
      provider: decision.exploredArm.provider,
      served_model: decision.exploredArm.servedModel,
      effort: decision.exploredArm.effort,
      n: decision.exploredArm.n,
    },
    sample_unit: decision.sampleUnit,
    reason: decision.reason,
    policy: decision.policy,
  };
}

export function configForMountExploration(config: Config, decision: MountExplorationDispatch): Config {
  return {
    ...config,
    workerProviders: {
      ...config.workerProviders,
      enabled: [decision.exploredArm.provider],
      ...(decision.exploredArm.provider === "codex" ? { codexModel: decision.exploredArm.servedModel } : {}),
    },
  };
}

// ── WIRING: the seam between `runTask` and the decision above ────────────────────────────────────
//
// This block used to sit inline in `runTask`, and two of its arms were unreachable from any test.
// `runId` there is `${taskId}-${Date.now()}`, and the sampler hashes it, so which dispatches explore
// is a function of the wall clock: a harness CANNOT steer `runTask` onto the explore arm without
// becoming time-dependent, and a time-dependent test of a 5%-sampled path is a flake generator. The
// arm that matters most — the one that actually redirects the spawn — was therefore the one nothing
// could cover, and the catch arm that makes this whole rung non-fatal was never exercised either.
//
// Seaming it fixes both: the cell source (a dynamic import of `scripts/mount-headroom-sweep.mjs`)
// and the mounts table become injectable, so the explore arm and the failure arm are each reachable
// by passing a fake, while `runTask` keeps the real ones.

export interface MountExplorationWiringDeps {
  /** The observed per-cell arm population. Injected because the real one is a dynamic import. */
  loadCells: () => Promise<MountHeadroomCell[]>;
  loadMountsTable: () => Mounts;
  log: (step: string, fields: Record<string, unknown>) => void;
}

export interface MountExplorationWiringInput {
  taskType: string;
  risk: string;
  taskClass: string;
  currentMount: Mount;
  config: Config;
  runId: string;
  taskId: string;
  enabledProviders: WorkerProviderId[];
}

/**
 * Resolve the mount and config the implement spawn should ride.
 *
 * NEVER THROWS. Exploration is an optional measurement rung: if the sweep cannot be read, the
 * mounts table will not load, or the sampler itself faults, the run proceeds on its ON-POLICY mount
 * rather than failing. A rung that can take the dispatch down with it is worse than no rung, so the
 * failure is ledgered (`mount.exploration.error`) and swallowed — silence here would be the real
 * defect, which is why the catch logs rather than merely returning.
 */
export async function resolveMountExplorationDispatch(
  input: MountExplorationWiringInput,
  deps: MountExplorationWiringDeps,
): Promise<{ mount: Mount; config: Config }> {
  try {
    // A high-risk task is excluded by policy, so the sweep is not even read — the dynamic import
    // costs real time and this arm can never explore. `exploreMount` refuses it independently; this
    // is the cheap short-circuit, not the decision.
    const cells = input.risk === "high" ? [] : await deps.loadCells();
    const exploration = exploreMount({
      cells,
      mounts: deps.loadMountsTable(),
      taskType: input.taskType,
      risk: input.risk,
      taskClass: input.taskClass,
      currentMount: input.currentMount,
      runId: input.runId,
      taskId: input.taskId,
      enabledProviders: input.enabledProviders,
    });
    if (exploration.kind === "explore") {
      deps.log("mount.exploration", { run_id: input.runId, ...mountExplorationLedgerFields(exploration) });
      return { mount: exploration.mount, config: configForMountExploration(input.config, exploration) };
    }
    return { mount: input.currentMount, config: input.config };
  } catch (error) {
    deps.log("mount.exploration.error", { reason: String((error as Error)?.message ?? error) });
    return { mount: input.currentMount, config: input.config };
  }
}
