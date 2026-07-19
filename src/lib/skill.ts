import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * `.remudero/skills/<name>.yaml` loader (MASTER-PLAN §5B, W1-T44).
 *
 * §5B's unification: Setup, Plan, Feedback/triage, Refactor, Design Review,
 * Retro, and the Reviewer are ALL THE SAME PRIMITIVE — a higher-tier (G-17)
 * worker that GROUNDS (grep the plan/learnings/ledger/DECISIONS) -> RESEARCHES
 * (server-side WebSearch) -> GRILLS (AskUserQuestion / a needs-human issue) or
 * PRODUCES (a PR gated by ci-gate+remudero-review). They differ ONLY in a
 * declarative PROFILE, so a skill is a CONFIG ENTRY, not new code: this module
 * READS that profile — { tools[], permission_profile, output_contract,
 * grounding_sources[], gate, tier } — from one YAML file per skill. Dropping a
 * new `.remudero/skills/<name>.yaml` is the entire diff for a new skill; NO
 * loader change, NO CLI change (the acceptance bar this module exists to
 * satisfy). Each entry maps 1:1 to a future UI action (§7 shell, W3-T8) — the
 * panel button IS the registry entry.
 *
 * The skill's NAME is its FILENAME (`foo.yaml` -> `"foo"`), never a `name:`
 * field inside the body — so a file can never silently drift from the
 * identity `rmd skill list` reports it under, and renaming the file always
 * renames the skill.
 */

/** Any structural or semantic violation of the skill-registry shape. */
export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

/** One resolved `.remudero/skills/<name>.yaml` entry. */
export interface Skill {
  /** The skill's identity — its filename minus `.yaml`. */
  name: string;
  /** The SDK tool allowlist (`Options.tools`) this skill's worker rides. */
  tools: string[];
  /** Named permission/sandbox profile the worker's settings file resolves to. */
  permission_profile: string;
  /** What this skill's worker PRODUCES (the shape of its PR / status / report). */
  output_contract: string;
  /** What the GROUND step reads before researching/proposing. */
  grounding_sources: string[];
  /** The required-status gate its output must clear before merge. */
  gate: string;
  /** The mount tier (§9) this skill's worker rides — G-17 above every implement worker. */
  tier: string;
}

/** `<root>/.remudero/skills` — the registry directory. */
export function skillsDir(root: string): string {
  return join(root, ".remudero", "skills");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requiredString(raw: unknown, field: string, name: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new SkillError(`skill '${name}': '${field}' must be a non-empty string.`);
  }
  return raw;
}

function requiredStringArray(raw: unknown, field: string, name: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((t) => typeof t === "string" && t.trim().length > 0)) {
    throw new SkillError(`skill '${name}': '${field}' must be a non-empty list of non-empty strings.`);
  }
  return raw as string[];
}

/**
 * Validate one parsed skill document against the §5B shape. `name` is passed
 * in (from the filename) rather than read from the body — see the module
 * doc's identity note.
 */
export function validateSkill(raw: unknown, name: string): Skill {
  if (!isObject(raw)) {
    throw new SkillError(`skill '${name}': the document must be a mapping of {tools, permission_profile, output_contract, grounding_sources, gate, tier}.`);
  }
  return {
    name,
    tools: requiredStringArray(raw.tools, "tools", name),
    permission_profile: requiredString(raw.permission_profile, "permission_profile", name),
    output_contract: requiredString(raw.output_contract, "output_contract", name),
    grounding_sources: requiredStringArray(raw.grounding_sources, "grounding_sources", name),
    gate: requiredString(raw.gate, "gate", name),
    tier: requiredString(raw.tier, "tier", name),
  };
}

/** Parse + validate one `.remudero/skills/<name>.yaml` file. */
export function loadSkill(path: string): Skill {
  const name = basename(path).replace(/\.yaml$/, "");
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new SkillError(`skill '${name}' is not valid YAML (${path}): ${String(err)}`);
  }
  return validateSkill(raw, name);
}

/**
 * Load EVERY `*.yaml` file in `dir` (sorted by filename for determinism) into
 * the registry. A MISSING directory is not an error — returns `[]` (same
 * no-corpus-yet convention as {@link import("./learnings.js").loadLearningsCorpus}).
 */
export function loadSkillRegistry(dir: string): Skill[] {
  let filenames: string[];
  try {
    filenames = readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .sort();
  } catch {
    return []; // no registry directory yet
  }
  return filenames.map((f) => loadSkill(join(dir, f)));
}

/** Render `rmd skill list`'s human-readable listing — one block per skill, every field resolved. */
export function renderSkillList(skills: Skill[]): string {
  if (skills.length === 0) {
    return "(no skills registered — drop a .remudero/skills/<name>.yaml; see MASTER-PLAN §5B)";
  }
  return skills
    .map(
      (s) =>
        `${s.name}\n` +
        `  tools:              ${s.tools.join(", ")}\n` +
        `  permission_profile: ${s.permission_profile}\n` +
        `  output_contract:    ${s.output_contract}\n` +
        `  grounding_sources:  ${s.grounding_sources.join(", ")}\n` +
        `  gate:               ${s.gate}\n` +
        `  tier:               ${s.tier}`,
    )
    .join("\n\n");
}
