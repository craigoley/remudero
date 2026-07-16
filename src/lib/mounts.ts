import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * .remudero/mounts.yaml loader + validator (mount-routing v0, MASTER-PLAN §9).
 *
 * A DETERMINISTIC policy table (no per-call LLM judgment): keyed by
 * (task_type × risk) → a {@link Mount}. This module only READS, VALIDATES, and
 * RESOLVES; it never writes the table (routing changes ship as golden-gated PRs,
 * §9). v0 is a static table.
 *
 * ── The Tier Invariant (G-17) ────────────────────────────────────────────────
 * The Architect (main agent) ALWAYS rides a higher-thinking mount than the
 * coding agents. Enforced here as TWO ANDed conditions, exactly per §9:
 *
 *     architect.tier  >  max(worker.tier)     — STRICT model-tier dominance
 *     architect.effort ≥ thinking_default      — floor: high (plan authorship)
 *
 * A table that violates it is REJECTED at load (a {@link TierInvariantError}).
 * This is a CONFIG-validation rule, not a runtime judgment: the flywheel may
 * lower workers freely but a proposal that lowers the Architect to or below the
 * worker ceiling can never load. The invariant is RELATIVE — the model-tier and
 * effort orderings are DATA in the file (`tiers`/`efforts`), read as such rather
 * than hardcoded, since the lineup shifts.
 *
 * ── The judge extension (Layer 2, W1-T21 — MASTER-PLAN §4B) ────────────────────
 * The flight judge is a second, SEPARATE entity subject to the SAME shape of
 * invariant: `judge.tier > max(worker.tier)` — it must ride strictly above
 * every worker it may be asked to supervise, so it can never be talked into
 * agreement by a worker riding its own tier or higher. A table with a `judge`
 * mount that fails this is REJECTED at load, same as the Architect's check.
 */

/** Base error for any structural or semantic mounts.yaml violation. */
export class MountsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MountsError";
  }
}

/** The Tier Invariant (G-17) was violated. A subtype so callers/tests assert it. */
export class TierInvariantError extends MountsError {
  constructor(message: string) {
    super(message);
    this.name = "TierInvariantError";
  }
}

/** One mount: the model, effort, and resource budgets a run rides. */
export interface Mount {
  /** Model name — MUST be a key of {@link Mounts.tiers}. */
  model: string;
  /** Reasoning effort — MUST be a key of {@link Mounts.efforts}. */
  effort: string;
  /** Max agent turns before the runaway backstop trips. */
  maxTurns: number;
  /** Context budget (tokens) this mount plans against. */
  contextBudget: number;
}

/** The whole parsed, validated routing table. */
export interface Mounts {
  /** Model-tier ordering; higher rank = higher-thinking mount (config-maintained). */
  tiers: Record<string, number>;
  /** Effort ordering; higher rank = more thinking effort. */
  efforts: Record<string, number>;
  /** The Architect (main agent) mount — strictly above every worker below. */
  architect: Mount;
  /** The Layer-2 flight-judge mount (W1-T21) — strictly above every worker below. */
  judge: Mount;
  /** Worker routing: task_type → risk band → mount. */
  routes: Record<string, Record<string, Mount>>;
}

/** The plan-authorship effort floor the Architect must meet or exceed (§9). */
const ARCHITECT_EFFORT_FLOOR = "high";

/** Default location of the table, under a repo/workspace root. */
export function mountsPath(root: string): string {
  return join(root, ".remudero", "mounts.yaml");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a `Record<string, number>` ordering block (tiers / efforts). */
function parseOrdering(raw: unknown, name: string): Record<string, number> {
  if (!isObject(raw)) throw new MountsError(`'${name}' must be a mapping of name → rank.`);
  const out: Record<string, number> = {};
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new MountsError(`'${name}' must not be empty.`);
  for (const key of keys) {
    const rank = raw[key];
    if (typeof rank !== "number" || !Number.isInteger(rank) || rank <= 0) {
      throw new MountsError(`'${name}.${key}' must be a positive integer rank, got ${JSON.stringify(rank)}.`);
    }
    out[key] = rank;
  }
  return out;
}

/** Validate one mount cell, checking its model/effort resolve in the orderings. */
function parseMount(
  raw: unknown,
  where: string,
  tiers: Record<string, number>,
  efforts: Record<string, number>,
): Mount {
  if (!isObject(raw)) throw new MountsError(`mount ${where} must be a mapping.`);
  const { model, effort, max_turns, context_budget } = raw;
  if (typeof model !== "string" || !(model in tiers)) {
    throw new MountsError(`mount ${where}: 'model' must be one of ${Object.keys(tiers).join(", ")}, got ${JSON.stringify(model)}.`);
  }
  if (typeof effort !== "string" || !(effort in efforts)) {
    throw new MountsError(`mount ${where}: 'effort' must be one of ${Object.keys(efforts).join(", ")}, got ${JSON.stringify(effort)}.`);
  }
  if (typeof max_turns !== "number" || !Number.isInteger(max_turns) || max_turns <= 0) {
    throw new MountsError(`mount ${where}: 'max_turns' must be a positive integer, got ${JSON.stringify(max_turns)}.`);
  }
  if (typeof context_budget !== "number" || !Number.isInteger(context_budget) || context_budget <= 0) {
    throw new MountsError(`mount ${where}: 'context_budget' must be a positive integer, got ${JSON.stringify(context_budget)}.`);
  }
  return { model, effort, maxTurns: max_turns, contextBudget: context_budget };
}

/**
 * Enforce the Tier Invariant (G-17) against a parsed table.
 *
 * @param opts.thinkingDefault the operator's `thinking_default` (per-instance
 *        config, §9). When given, the Architect's effort must also meet it. The
 *        plan-authorship floor ({@link ARCHITECT_EFFORT_FLOOR}) is enforced
 *        unconditionally.
 */
function enforceTierInvariant(m: Mounts, thinkingDefault?: string): void {
  const architectTier = m.tiers[m.architect.model];
  const judgeTier = m.tiers[m.judge.model];
  // architect.tier > max(worker.tier): strict model-tier dominance.
  // judge.tier > max(worker.tier): the Layer-2 flight judge (W1-T21) must ALSO
  // ride strictly above every worker it may supervise — same enforcement shape,
  // a separate entity.
  for (const [type, byRisk] of Object.entries(m.routes)) {
    for (const [risk, mount] of Object.entries(byRisk)) {
      const workerTier = m.tiers[mount.model];
      if (workerTier >= architectTier) {
        throw new TierInvariantError(
          `Tier Invariant (G-17) violated: worker routes.${type}.${risk} rides '${mount.model}' ` +
            `(tier ${workerTier}) which is not strictly below the Architect '${m.architect.model}' (tier ${architectTier}). ` +
            `The Architect must ride a higher tier than every worker.`,
        );
      }
      if (workerTier >= judgeTier) {
        throw new TierInvariantError(
          `Tier Invariant (G-17) violated: worker routes.${type}.${risk} rides '${mount.model}' ` +
            `(tier ${workerTier}) which is not strictly below the flight judge '${m.judge.model}' (tier ${judgeTier}). ` +
            `The Layer-2 judge must ride a higher tier than every worker it supervises.`,
        );
      }
    }
  }
  // architect.effort ≥ plan-authorship floor.
  const architectEffort = m.efforts[m.architect.effort];
  const floor = m.efforts[ARCHITECT_EFFORT_FLOOR];
  if (floor === undefined) {
    throw new MountsError(`'efforts' must define '${ARCHITECT_EFFORT_FLOOR}' (the Architect effort floor).`);
  }
  if (architectEffort < floor) {
    throw new TierInvariantError(
      `Tier Invariant (G-17) violated: Architect effort '${m.architect.effort}' is below the ` +
        `plan-authorship floor '${ARCHITECT_EFFORT_FLOOR}'.`,
    );
  }
  // architect.effort ≥ thinking_default (when supplied by the caller).
  if (thinkingDefault !== undefined) {
    const wanted = m.efforts[thinkingDefault];
    if (wanted === undefined) {
      throw new MountsError(`thinking_default '${thinkingDefault}' is not a known effort (${Object.keys(m.efforts).join(", ")}).`);
    }
    if (architectEffort < wanted) {
      throw new TierInvariantError(
        `Tier Invariant (G-17) violated: Architect effort '${m.architect.effort}' is below the ` +
          `operator thinking_default '${thinkingDefault}'.`,
      );
    }
  }
}

/** Options for {@link validateMounts} / {@link loadMounts}. */
export interface MountsOptions {
  /** Operator `thinking_default` (per-instance config, §9); enforces the floor. */
  thinkingDefault?: string;
}

/**
 * Validate a raw (parsed-YAML) value into a {@link Mounts}, enforcing the Tier
 * Invariant. Throws {@link MountsError} / {@link TierInvariantError} on any
 * structural or semantic violation.
 */
export function validateMounts(raw: unknown, opts: MountsOptions = {}): Mounts {
  if (!isObject(raw)) throw new MountsError("mounts.yaml must be a mapping.");
  const tiers = parseOrdering(raw.tiers, "tiers");
  const efforts = parseOrdering(raw.efforts, "efforts");
  const architect = parseMount(raw.architect, "architect", tiers, efforts);
  const judge = parseMount(raw.judge, "judge", tiers, efforts);

  if (!isObject(raw.routes)) throw new MountsError("'routes' must be a mapping of task_type → risk → mount.");
  const routes: Record<string, Record<string, Mount>> = {};
  const routeTypes = Object.keys(raw.routes);
  if (routeTypes.length === 0) throw new MountsError("'routes' must not be empty.");
  for (const type of routeTypes) {
    const byRisk = raw.routes[type];
    if (!isObject(byRisk)) throw new MountsError(`'routes.${type}' must be a mapping of risk → mount.`);
    const risks = Object.keys(byRisk);
    if (risks.length === 0) throw new MountsError(`'routes.${type}' must not be empty.`);
    routes[type] = {};
    for (const risk of risks) {
      routes[type][risk] = parseMount(byRisk[risk], `routes.${type}.${risk}`, tiers, efforts);
    }
  }

  const mounts: Mounts = { tiers, efforts, architect, judge, routes };
  enforceTierInvariant(mounts, opts.thinkingDefault);
  return mounts;
}

/** Load, parse, and validate `.remudero/mounts.yaml` from `path`. */
export function loadMounts(path: string, opts: MountsOptions = {}): Mounts {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new MountsError(`mounts.yaml is not valid YAML (${path}): ${String(err)}`);
  }
  return validateMounts(raw, opts);
}

/**
 * Resolve the mount for a (task_type, risk) — the deterministic routing lookup.
 * Throws {@link MountsError} when the table has no cell for that key (routing is
 * a policy, so a miss is a config gap, not a silent fallback).
 */
export function resolveMount(m: Mounts, taskType: string, risk: string): Mount {
  const byRisk = m.routes[taskType];
  if (!byRisk) throw new MountsError(`no route for task_type '${taskType}' (have: ${Object.keys(m.routes).join(", ")}).`);
  const mount = byRisk[risk];
  if (!mount) throw new MountsError(`no route for task_type '${taskType}' at risk '${risk}' (have: ${Object.keys(byRisk).join(", ")}).`);
  return mount;
}
