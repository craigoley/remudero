import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_TASK_CLASS } from "./task-class.js";

/**
 * .remudero/mounts.yaml loader + validator (mount-routing v0, MASTER-PLAN §9;
 * W1-T167 added the `class` axis).
 *
 * A DETERMINISTIC policy table (no per-call LLM judgment): keyed by
 * (task_type × risk × class) → a {@link Mount}. This module only READS,
 * VALIDATES, and RESOLVES; it never writes the table (routing changes ship as
 * golden-gated PRs, §9). v0 is a static table.
 *
 * ── The class axis (W1-T167) ────────────────────────────────────────────────
 * A flat sonnet/high mount for every task, regardless of shape, prices a
 * docs-only edit the same as a risk:high src change (the $12 W1-T115 run).
 * Every `routes.<type>.<risk>` cell is now itself a mapping of CLASS →
 * {@link Mount} — `class` comes from {@link import("./task-class.js").deriveTaskClass}
 * (a task's declared `files` globs, e.g. `docs` / `plan-lint` / the universal
 * `src` default) — so a cheaper mount for docs/plan-lint work is a DATA edit to
 * this file, never a code branch. Every risk cell MUST define a
 * `src` row (checked at load, {@link parseRiskCell}): it is the fallback
 * {@link resolveMountForClass} takes — LOUDLY, the caller ledgers it — when the
 * task's derived class has no row of its own (e.g. a risk:high docs task, which
 * this table deliberately leaves unmapped so it never silently rides a
 * cheapened mount at a risk band that warrants the full one).
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
  /** Worker routing: task_type → risk band → class (W1-T167) → mount. Every
   *  risk band carries at least a {@link DEFAULT_TASK_CLASS} row. */
  routes: Record<string, Record<string, Record<string, Mount>>>;
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
  // a separate entity. W1-T167: descends into the class layer too — a cheapened
  // docs/plan-lint row is still a worker mount and must clear the SAME floor.
  for (const [type, byRisk] of Object.entries(m.routes)) {
    for (const [risk, byClass] of Object.entries(byRisk)) {
      for (const [cls, mount] of Object.entries(byClass)) {
        const workerTier = m.tiers[mount.model];
        if (workerTier >= architectTier) {
          throw new TierInvariantError(
            `Tier Invariant (G-17) violated: worker routes.${type}.${risk}.${cls} rides '${mount.model}' ` +
              `(tier ${workerTier}) which is not strictly below the Architect '${m.architect.model}' (tier ${architectTier}). ` +
              `The Architect must ride a higher tier than every worker.`,
          );
        }
        if (workerTier >= judgeTier) {
          throw new TierInvariantError(
            `Tier Invariant (G-17) violated: worker routes.${type}.${risk}.${cls} rides '${mount.model}' ` +
              `(tier ${workerTier}) which is not strictly below the flight judge '${m.judge.model}' (tier ${judgeTier}). ` +
              `The Layer-2 judge must ride a higher tier than every worker it supervises.`,
          );
        }
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

/**
 * Validate one `routes.<type>.<risk>` cell: a mapping of class → {@link Mount}
 * (W1-T167). MUST define a {@link DEFAULT_TASK_CLASS} ("src") row — the
 * fallback {@link resolveMountForClass} takes when a task's derived class has
 * no row of its own, so a table missing it could resolve nothing to fall back
 * to. A legacy FLAT mount cell (the pre-W1-T167 shape — `model`/`effort` keys
 * directly under the risk band) is REJECTED here, not silently upgraded: the
 * `model` field of such a cell fails {@link parseMount}'s own object check,
 * naming the offending path, so a stale hand-edit fails loud at load rather
 * than resolving into a nonsense class named "model".
 */
function parseRiskCell(
  raw: unknown,
  where: string,
  tiers: Record<string, number>,
  efforts: Record<string, number>,
): Record<string, Mount> {
  if (!isObject(raw)) throw new MountsError(`'${where}' must be a mapping of class → mount.`);
  const classes = Object.keys(raw);
  if (classes.length === 0) throw new MountsError(`'${where}' must not be empty.`);
  const out: Record<string, Mount> = {};
  for (const cls of classes) {
    out[cls] = parseMount(raw[cls], `${where}.${cls}`, tiers, efforts);
  }
  if (!(DEFAULT_TASK_CLASS in out)) {
    throw new MountsError(
      `'${where}' must define a '${DEFAULT_TASK_CLASS}' class row — the fallback every other ` +
        `class' miss resolves to (W1-T167); have classes: ${classes.join(", ")}.`,
    );
  }
  return out;
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

  if (!isObject(raw.routes)) throw new MountsError("'routes' must be a mapping of task_type → risk → class → mount.");
  const routes: Record<string, Record<string, Record<string, Mount>>> = {};
  const routeTypes = Object.keys(raw.routes);
  if (routeTypes.length === 0) throw new MountsError("'routes' must not be empty.");
  for (const type of routeTypes) {
    const byRisk = raw.routes[type];
    if (!isObject(byRisk)) throw new MountsError(`'routes.${type}' must be a mapping of risk → class → mount.`);
    const risks = Object.keys(byRisk);
    if (risks.length === 0) throw new MountsError(`'routes.${type}' must not be empty.`);
    routes[type] = {};
    for (const risk of risks) {
      routes[type][risk] = parseRiskCell(byRisk[risk], `routes.${type}.${risk}`, tiers, efforts);
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
 * Resolve the mount for a (task_type, risk) at the {@link DEFAULT_TASK_CLASS}
 * — the pre-W1-T167 call shape, still used by every caller that has no class
 * to route on (the fresh reviewer, the fix rung, the Architect/judge spawns).
 * Throws {@link MountsError} when the table has no cell for that key (routing
 * is a policy, so a miss is a config gap, not a silent fallback). Equivalent to
 * `resolveMountForClass(m, taskType, risk, DEFAULT_TASK_CLASS).mount`, which
 * can never itself fall back (the default class IS the fallback target).
 */
export function resolveMount(m: Mounts, taskType: string, risk: string): Mount {
  return resolveMountForClass(m, taskType, risk, DEFAULT_TASK_CLASS).mount;
}

/** What {@link resolveMountForClass} resolved, including whether it had to fall back. */
export interface MountClassResolution {
  mount: Mount;
  /** The class the caller asked for. */
  requestedClass: string;
  /** The class the returned mount actually belongs to — differs from
   *  `requestedClass` only when `fellBackToDefault` is true. */
  resolvedClass: string;
  /** True when `requestedClass` had no row and the {@link DEFAULT_TASK_CLASS}
   *  row was used instead. The CALLER is responsible for ledgering this LOUDLY
   *  (W1-T167 acceptance: a class miss must never be a silent fallback) — this
   *  function is a pure resolver, no I/O, matching resolveMount's own shape. */
  fellBackToDefault: boolean;
}

/**
 * Resolve the mount for a (task_type, risk, class) — the W1-T167 routing
 * lookup. An unrouted task_type or risk is a config gap (throws
 * {@link MountsError}, same as {@link resolveMount}). An unrouted CLASS is
 * different: it falls back to the risk cell's {@link DEFAULT_TASK_CLASS} row
 * (guaranteed present by {@link parseRiskCell} at load) rather than throwing,
 * because an unanticipated class is expected — the table only carries cheap
 * rows for the classes it has evidence for — but the caller MUST ledger the
 * fallback loudly (`fellBackToDefault`), never silently.
 */
export function resolveMountForClass(m: Mounts, taskType: string, risk: string, taskClass: string): MountClassResolution {
  const byRisk = m.routes[taskType];
  if (!byRisk) throw new MountsError(`no route for task_type '${taskType}' (have: ${Object.keys(m.routes).join(", ")}).`);
  const byClass = byRisk[risk];
  if (!byClass) throw new MountsError(`no route for task_type '${taskType}' at risk '${risk}' (have: ${Object.keys(byRisk).join(", ")}).`);
  const exact = byClass[taskClass];
  if (exact) return { mount: exact, requestedClass: taskClass, resolvedClass: taskClass, fellBackToDefault: false };
  const fallback = byClass[DEFAULT_TASK_CLASS];
  if (!fallback) {
    // Unreachable for any table that passed validateMounts (parseRiskCell requires
    // this row) — guarded anyway so a hand-built Mounts (a test fixture bypassing
    // validateMounts) fails loud instead of returning undefined.
    throw new MountsError(
      `no route for task_type '${taskType}' at risk '${risk}' class '${taskClass}', and no ` +
        `'${DEFAULT_TASK_CLASS}' fallback either (have: ${Object.keys(byClass).join(", ")}).`,
    );
  }
  return { mount: fallback, requestedClass: taskClass, resolvedClass: DEFAULT_TASK_CLASS, fellBackToDefault: true };
}
