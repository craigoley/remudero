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
 * mount that fails this is REJECTED at load, same as the Architect's check. The synthesis rungs
 * (W1-T2559 — retro/triage/inbox_draft) get their OWN `synthesis:` mount instead (config.ts's
 * `synthesisModel`/`synthesisEffort`): they ship no code, so the Tier Invariant does not bind
 * them, but each row is still REQUIRED and validated.
 *
 * ── The capability axis (W1-T2573) ──────────────────────────────────────────────
 * `tiers` above ranks CLAUDE model names — the vocabulary every `routes`/`architect`/`judge`
 * mount is written in. The OPTIONAL `capabilities` block is the provider-neutral axis a SECOND
 * vendor's adapter (e.g. `codexTierForRequestedModel` in worker-provider.ts) resolves a
 * requested Claude model + effort INTO, so cross-provider routing is a TABLE LOOKUP, never a
 * substring match on the Claude model name, and effort survives the crossing because the lookup
 * is keyed on (capability, effort). See {@link CapabilityLadder}. When declared, the Tier
 * Invariant is ALSO enforced on capability rank ({@link capabilityRank}) — purely additive to
 * the `tiers`-based check above, so a table that omits `capabilities` validates unchanged.
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

/** The three synthesis rungs (W1-T2559), exempt from the Tier Invariant — see this file's header. */
export const SYNTHESIS_ROLES = ["retro", "triage", "inbox_draft"] as const;
export type SynthesisRole = (typeof SYNTHESIS_ROLES)[number];

/** Convert a supported concrete Claude model id to the label used by Anthropic status updates. */
export function claudeModelDisplayName(model: string): string | undefined {
  const match = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(model);
  if (!match) return undefined;
  const family = match[1][0].toUpperCase() + match[1].slice(1);
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}

/**
 * Provider-neutral capability axis (W1-T2573). `tiers` above ranks CLAUDE model names — the
 * vocabulary every mount in `routes` is written in (Claude is canonical). `capabilities` is the
 * axis a SECOND vendor's adapter (e.g. Codex) resolves a requested Claude model INTO, so that
 * cross-provider routing is a TABLE LOOKUP, never a substring match on the Claude model name:
 *   - `ladder`: capability name -> rank, provider-agnostic, the same shape as `tiers`.
 *   - `claude`: Claude model name -> capability. Every `tiers` key MUST resolve here when this
 *     block is present (checked at load), so any mount that already validated against `tiers`
 *     also resolves a capability.
 *   - `claudeCandidates`: capability -> ordered concrete Claude model ids. Aliases start at the
 *     first entry; explicit concrete pins start at their own entry and can never be upgraded.
 *   - `codex`: capability -> effort -> ordered (most-preferred-first) Codex candidate models.
 *     Keyed on (capability, effort) so effort genuinely crosses the provider boundary instead of
 *     being dropped: a `sonnet/high` mount and a `sonnet/medium` mount can resolve different
 *     candidate rows.
 * OPTIONAL at the top level — a table that omits `capabilities` entirely validates exactly as it
 * did before this axis existed (every other fixture in the suite that predates W1-T2573 stays
 * green); the axis only governs cross-provider routing once an operator opts in by declaring it.
 * `.remudero/mounts.yaml` itself always declares it.
 */
export interface CapabilityLadder {
  /** capability name -> rank (higher = more capable). */
  ladder: Record<string, number>;
  /** Claude model name -> capability; every `tiers` key must appear. */
  claude: Record<string, string>;
  /**
   * capability -> ordered concrete Claude candidates, most capable first.
   *
   * Optional only for callers that construct a CapabilityLadder literal directly. The mounts
   * loader always validates and populates this field whenever `capabilities` is declared.
   */
  claudeCandidates?: Record<string, string[]>;
  /** capability -> effort -> ordered provider candidate model ids (non-empty per (capability, effort)). */
  codex: Record<string, Record<string, string[]>>;
}

/** The whole parsed, validated routing table. */
export interface Mounts {
  /** Model-tier ordering; higher rank = higher-thinking mount (config-maintained). */
  tiers: Record<string, number>;
  /** Effort ordering; higher rank = more thinking effort. */
  efforts: Record<string, number>;
  /** The provider-neutral capability axis (W1-T2573) — see {@link CapabilityLadder}. Absent when
   *  the table declares no `capabilities` block (backward compatible). */
  capabilities?: CapabilityLadder;
  /** The Architect (main agent) mount — strictly above every worker below. */
  architect: Mount;
  /** The Layer-2 flight-judge mount (W1-T21) — strictly above every worker below. */
  judge: Mount;
  synthesis: Record<SynthesisRole, Mount>; // the three synthesis rungs' OWN mounts (W1-T2559) — never the Architect's; REQUIRED
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
 * Resolve a Claude model's declared capability rank (W1-T2573). TOTAL for every model that can
 * reach it, so it asserts nothing of its own: the invariant it would otherwise re-check is
 * already enforced — and tested — at the two places that actually own it. {@link parseMount}
 * refuses a `model` absent from `tiers` ("'model' must be one of …"), and
 * {@link parseCapabilities} refuses a `tiers` key absent from `capabilities.claude`
 * ("'capabilities.claude' is missing a capability for '<model>'"). Every caller below passes a
 * model that came through `parseMount` against the SAME `tiers` object `parseCapabilities` was
 * given, so both lookups always resolve. A third copy of the rule here could never execute; the
 * two above are where a regression is caught, by name.
 */
function capabilityRank(capabilities: CapabilityLadder, model: string): number {
  return capabilities.ladder[capabilities.claude[model]];
}

/**
 * Enforce the Tier Invariant (G-17) against a parsed table.
 * @param opts.thinkingDefault the operator's `thinking_default` (per-instance config, §9); when
 *        given, the Architect's effort must also meet it. The plan-authorship floor
 *        ({@link ARCHITECT_EFFORT_FLOOR}) is enforced unconditionally.
 */
function enforceTierInvariant(m: Mounts, thinkingDefault?: string): void {
  const architectTier = m.tiers[m.architect.model];
  const judgeTier = m.tiers[m.judge.model];
  // W1-T2573: when the table declares a `capabilities` axis, the SAME invariant is ALSO
  // enforced on capability RANK — the provider-neutral generalisation (rationale point 3):
  // capability rank is what a worker riding a different vendor would be compared on, since
  // such a worker has no place on the Claude-only `tiers` ladder at all. This is purely
  // ADDITIVE — it never relaxes the `tiers`-based check below, only adds a second gate when
  // capability data is present, so a table that omits `capabilities` validates exactly as it
  // always has.
  const architectCapabilityRank = m.capabilities ? capabilityRank(m.capabilities, m.architect.model) : undefined;
  const judgeCapabilityRank = m.capabilities ? capabilityRank(m.capabilities, m.judge.model) : undefined;
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
            `Tier Invariant (G-17) violated: worker routes.${type}.${risk}.${cls} rides '${mount.model}' (tier ${workerTier}) which is not strictly below the Architect '${m.architect.model}' (tier ${architectTier}). The Architect must ride a higher tier than every worker.`,
          );
        }
        if (workerTier >= judgeTier) {
          throw new TierInvariantError(
            `Tier Invariant (G-17) violated: worker routes.${type}.${risk}.${cls} rides '${mount.model}' (tier ${workerTier}) which is not strictly below the flight judge '${m.judge.model}' (tier ${judgeTier}). The Layer-2 judge must ride a higher tier than every worker it supervises.`,
          );
        }
        if (m.capabilities && architectCapabilityRank !== undefined) {
          const workerCapabilityRank = capabilityRank(m.capabilities, mount.model);
          if (workerCapabilityRank >= architectCapabilityRank) {
            throw new TierInvariantError(
              `Tier Invariant (G-17) violated on the capability axis (W1-T2573): worker routes.${type}.${risk}.${cls} rides '${mount.model}' (capability '${m.capabilities.claude[mount.model]}', rank ${workerCapabilityRank}) which is not strictly below the Architect '${m.architect.model}' (capability '${m.capabilities.claude[m.architect.model]}', rank ${architectCapabilityRank}). This is the provider-neutral generalisation of the tiers-based check above: it must hold on capability rank too, so it stays enforceable when a worker rides a different vendor.`,
            );
          }
          if (judgeCapabilityRank !== undefined && workerCapabilityRank >= judgeCapabilityRank) {
            throw new TierInvariantError(
              `Tier Invariant (G-17) violated on the capability axis (W1-T2573): worker routes.${type}.${risk}.${cls} rides '${mount.model}' (capability '${m.capabilities.claude[mount.model]}', rank ${workerCapabilityRank}) which is not strictly below the flight judge '${m.judge.model}' (capability '${m.capabilities.claude[m.judge.model]}', rank ${judgeCapabilityRank}).`,
            );
          }
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
      `Tier Invariant (G-17) violated: Architect effort '${m.architect.effort}' is below the plan-authorship floor '${ARCHITECT_EFFORT_FLOOR}'.`,
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
        `Tier Invariant (G-17) violated: Architect effort '${m.architect.effort}' is below the operator thinking_default '${thinkingDefault}'.`,
      );
    }
  }
}

/**
 * Validate the OPTIONAL `capabilities` block (W1-T2573) — see {@link CapabilityLadder}. Only
 * called when `raw.capabilities` is present at all; a table that omits the key entirely gets
 * `mounts.capabilities === undefined` and validates exactly as it did before this axis existed.
 * Once the key IS present, though, every one of its rows is REQUIRED: a `ladder` name, a
 * `claude` mapping covering every `tiers` key, and a `codex` row for every (capability, effort)
 * pair — this is what makes cross-provider routing a TABLE LOOKUP rather than a substring match,
 * so a gap in the table is a load-time refusal, not a runtime guess.
 */
function parseCapabilities(
  raw: unknown,
  tiers: Record<string, number>,
  efforts: Record<string, number>,
): CapabilityLadder {
  if (!isObject(raw)) throw new MountsError("'capabilities' must be a mapping of ladder/claude/codex.");
  const ladder = parseOrdering(raw.ladder, "capabilities.ladder");

  if (!isObject(raw.claude)) {
    throw new MountsError("'capabilities.claude' must be a mapping of Claude model name -> capability.");
  }
  const claude: Record<string, string> = {};
  for (const [model, capability] of Object.entries(raw.claude)) {
    if (typeof capability !== "string" || !(capability in ladder)) {
      throw new MountsError(
        `'capabilities.claude.${model}' must name a capability in 'capabilities.ladder' (${Object.keys(ladder).join(", ")}), got ${JSON.stringify(capability)}.`,
      );
    }
    claude[model] = capability;
  }
  for (const model of Object.keys(tiers)) {
    if (!(model in claude)) {
      throw new MountsError(
        `'capabilities.claude' is missing a capability for '${model}' — every 'tiers' model must resolve one once 'capabilities' is declared (W1-T2573).`,
      );
    }
  }

  if (!isObject(raw.claude_candidates)) {
    throw new MountsError("'capabilities.claude_candidates' must be a mapping of capability -> model list.");
  }
  const claudeCandidates: Record<string, string[]> = {};
  const candidateModels = new Set<string>();
  for (const capability of Object.keys(ladder)) {
    const models = raw.claude_candidates[capability];
    if (!Array.isArray(models) || models.length === 0 || !models.every((entry) => typeof entry === "string" && entry.length > 0)) {
      throw new MountsError(
        `'capabilities.claude_candidates.${capability}' must be a non-empty list of model ids, got ${JSON.stringify(models)}.`,
      );
    }
    if (new Set(models).size !== models.length) {
      throw new MountsError(`'capabilities.claude_candidates.${capability}' must not contain duplicate model ids.`);
    }
    for (const model of models as string[]) {
      if (!claudeModelDisplayName(model)) {
        throw new MountsError(`Claude candidate '${model}' must be a supported concrete Claude model id.`);
      }
      if (candidateModels.has(model)) {
        throw new MountsError(`Claude candidate '${model}' appears in more than one capability list.`);
      }
      if (claude[model] !== capability) {
        throw new MountsError(
          `Claude candidate '${model}' must map to '${capability}' in 'capabilities.claude', got ${JSON.stringify(claude[model])}.`,
        );
      }
      candidateModels.add(model);
    }
    claudeCandidates[capability] = [...(models as string[])];
  }
  for (const model of Object.keys(claude).filter((name) => name.startsWith("claude-"))) {
    if (!candidateModels.has(model)) {
      throw new MountsError(`concrete Claude model '${model}' is missing from 'capabilities.claude_candidates'.`);
    }
  }

  if (!isObject(raw.codex)) {
    throw new MountsError("'capabilities.codex' must be a mapping of capability -> effort -> model list.");
  }
  const codex: Record<string, Record<string, string[]>> = {};
  for (const capability of Object.keys(ladder)) {
    const byEffort = raw.codex[capability];
    if (!isObject(byEffort)) {
      throw new MountsError(`'capabilities.codex.${capability}' must be a mapping of effort -> model list.`);
    }
    codex[capability] = {};
    for (const effort of Object.keys(efforts)) {
      const models = byEffort[effort];
      if (!Array.isArray(models) || models.length === 0 || !models.every((entry) => typeof entry === "string" && entry.length > 0)) {
        throw new MountsError(
          `'capabilities.codex.${capability}.${effort}' must be a non-empty list of model ids, got ${JSON.stringify(models)}.`,
        );
      }
      codex[capability][effort] = [...(models as string[])];
    }
  }

  return { ladder, claude, claudeCandidates, codex };
}

/**
 * Validate one `routes.<type>.<risk>` cell: a mapping of class → {@link Mount} (W1-T167). MUST
 * define a {@link DEFAULT_TASK_CLASS} ("src") row — the fallback {@link resolveMountForClass}
 * takes when a task's derived class has no row of its own. A legacy FLAT mount cell (the
 * pre-W1-T167 shape — `model`/`effort` keys directly under the risk band) is REJECTED here, not
 * silently upgraded: its `model` field fails {@link parseMount}'s own object check, naming the
 * offending path, rather than resolving into a nonsense class named "model".
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
      `'${where}' must define a '${DEFAULT_TASK_CLASS}' class row — the fallback every other class' miss resolves to (W1-T167); have classes: ${classes.join(", ")}.`,
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
 * Validate a raw (parsed-YAML) value into a {@link Mounts}, enforcing the Tier Invariant. Throws
 * {@link MountsError} / {@link TierInvariantError} on any structural or semantic violation.
 */
export function validateMounts(raw: unknown, opts: MountsOptions = {}): Mounts {
  if (!isObject(raw)) throw new MountsError("mounts.yaml must be a mapping.");
  const tiers = parseOrdering(raw.tiers, "tiers");
  const efforts = parseOrdering(raw.efforts, "efforts");
  // W1-T2573: OPTIONAL — present in `.remudero/mounts.yaml` itself; absent in every fixture
  // that predates this axis, which must keep validating unchanged (see parseCapabilities).
  const capabilities = raw.capabilities === undefined ? undefined : parseCapabilities(raw.capabilities, tiers, efforts);
  const architect = parseMount(raw.architect, "architect", tiers, efforts);
  const judge = parseMount(raw.judge, "judge", tiers, efforts);

  // W1-T2559: synthesis rungs — each REQUIRED, validated like architect/judge, never a fallback.
  if (!isObject(raw.synthesis)) throw new MountsError(`'synthesis' must be a mapping of role → mount (${SYNTHESIS_ROLES.join(", ")}).`);
  const synthesis = {} as Record<SynthesisRole, Mount>;
  for (const role of SYNTHESIS_ROLES) {
    if (!(role in raw.synthesis)) throw new MountsError(`'synthesis.${role}' is required.`);
    synthesis[role] = parseMount(raw.synthesis[role], `synthesis.${role}`, tiers, efforts);
  }

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

  const mounts: Mounts = { tiers, efforts, ...(capabilities ? { capabilities } : {}), architect, judge, synthesis, routes };
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
 * Resolve the mount for a (task_type, risk) at the {@link DEFAULT_TASK_CLASS} — the pre-W1-T167
 * call shape, still used by every caller that has no class to route on (the fresh reviewer, the
 * fix rung, the Architect/judge spawns). Throws {@link MountsError} when the table has no cell for
 * that key (a miss is a config gap, not a silent fallback). Equivalent to
 * `resolveMountForClass(m, taskType, risk, DEFAULT_TASK_CLASS).mount`.
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
      `no route for task_type '${taskType}' at risk '${risk}' class '${taskClass}', and no '${DEFAULT_TASK_CLASS}' fallback either (have: ${Object.keys(byClass).join(", ")}).`,
    );
  }
  return { mount: fallback, requestedClass: taskClass, resolvedClass: DEFAULT_TASK_CLASS, fellBackToDefault: true };
}
