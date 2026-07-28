import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * TASK-ID MINTING — one derivation for "what is the next free `W1-T<n>`?".
 *
 * WHY THIS MODULE EXISTS (the 2/2 collision evidence, 2026-07-25 session): the next id
 * was picked by eye — "one above the last one I saw" — which silently misses ids that
 * live somewhere the picker did not look. Twice in ONE session:
 *   - `W1-T256` was already owned by a merged PR   → renumbered to `W1-T257` (#770)
 *   - `W1-T260` was already owned by a `plan/tasks.d/` shard → renumbered to `W1-T261` (#775)
 * Each collision cost a mechanical renumber + re-push cycle because `rmd lint-plan`
 * (correctly) refuses a duplicate id, and the refusal lands AFTER the PR is open.
 *
 * LINEAGE — feedback#fb-1784766965325-c7b673 ("MINT TASK IDS AT APPROVE TIME, NOT DRAFT
 * TIME"): drafts that mint ids independently overlap, and the reserved set must be derived
 * from `merged plan ∪ open plan-PR minted ids` rather than a state-side registry. This
 * module is the DERIVATION half of that doctrine — one function, three sources, no
 * registry — leaving c7b673's approve-time SEQUENCING (placeholder ids in drafts, concrete
 * ids minted only at `rmd approve`) to its own task.
 *
 * THE INVARIANT, stated as an asymmetry: minting MAY skip a number; it must NEVER return a
 * number some source already owns. Every source is therefore folded in with `max`, and an
 * unreadable/unavailable source is reported as {@link MintDegradation} rather than silently
 * treated as empty — an absent source can only ever hide a HIGHER id, which is exactly the
 * collision this module exists to prevent.
 */

/** Task-id declarations in a plan file: `- id: W1-T123` / `id: W1-T123` at a line's start. */
const TASK_ID_DECL_RE = /^\s*(?:-\s*)?id:\s*["']?W1-T(\d+)/gm;

/** Any `W1-T<n>` MENTION — the only thing a PR title/body/branch can be scanned for. */
const TASK_ID_MENTION_RE = /\bW1-T(\d+)\b/g;

/**
 * Task-id numbers DECLARED in one plan file's text. Anchored to the `id:` key so a
 * `depends_on: [W1-T9]` reference or a prose mention never counts as ownership — a plan
 * file owns the ids it declares.
 */
export function declaredTaskIds(text: string): number[] {
  return [...text.matchAll(TASK_ID_DECL_RE)].map((m) => Number(m[1]));
}

/**
 * Task-id numbers MENTIONED anywhere in free text (an open PR's title, body, or head
 * branch). Deliberately looser than {@link declaredTaskIds}: a PR that has not merged yet
 * offers no structured place to read its minted ids from, and over-counting here only ever
 * SKIPS a number, while under-counting would collide.
 */
export function mentionedTaskIds(text: string): number[] {
  return [...text.matchAll(TASK_ID_MENTION_RE)].map((m) => Number(m[1]));
}

/** Why a mint source contributed nothing — carried on the result, never swallowed. */
export interface MintDegradation {
  /** Which source could not be read (`shards` | `open-prs`). */
  source: string;
  /** The failure, verbatim enough to act on. */
  reason: string;
}

/** Per-source highest id seen (`null` when a source contributed nothing). */
export interface MintSources {
  /** plan/tasks.yaml — the monolith. */
  monolith: number | null;
  /** plan/tasks.d/*.yaml — the shards a monolith-only read misses (the #775 collision). */
  shards: number | null;
  /** Open plan PRs' minted ids — ids that exist but have not merged (the #770 class). */
  openPrs: number | null;
}

/** The mint: the id to use, what it was derived from, and what could not be read. */
export interface MintedTaskId {
  /** The full id to use, e.g. `W1-T263`. */
  id: string;
  /** Its numeric part. */
  n: number;
  /** The highest id ANY source already owns (`0` when the plan is empty). */
  maxSeen: number;
  sources: MintSources;
  /** Non-empty when a source could not be read — the mint is then a FLOOR, not a ceiling. */
  degraded: MintDegradation[];
}

/** Highest of a number list, or `null` when empty — the per-source fold. */
function highest(ns: number[]): number | null {
  return ns.length ? Math.max(...ns) : null;
}

/**
 * Every `plan/tasks.d/*.yaml` shard's declared ids, plus any read failure. The shard
 * directory is absent on an unsharded plan (back-compat, exactly as `loadPlan` treats it) —
 * that is EMPTY, never a degradation.
 */
function shardTaskIds(planPath: string): { ids: number[]; degraded: MintDegradation[] } {
  const shardDir = join(dirname(planPath), "tasks.d");
  const degraded: MintDegradation[] = [];
  let entries: string[];
  try {
    entries = readdirSync(shardDir);
  } catch {
    return { ids: [], degraded }; // no tasks.d/ — an unsharded plan, not a failure
  }
  const ids: number[] = [];
  for (const file of entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort()) {
    try {
      ids.push(...declaredTaskIds(readFileSync(join(shardDir, file), "utf8")));
    } catch (err) {
      // A shard we cannot read may own a HIGHER id than anything we can — say so.
      degraded.push({ source: "shards", reason: `cannot read shard ${file}: ${String(err)}` });
    }
  }
  return { ids, degraded };
}

/**
 * Mint the next free task id from the max across ALL of: `plan/tasks.yaml`, EVERY
 * `plan/tasks.d/*.yaml` shard, and (where cheaply enumerable) the ids minted by OPEN plan
 * PRs — the three places an id can already be taken. `openPrTexts` is injected by the
 * caller (`gh pr list --state open` at the edge, fixtures in tests); omitting it is a
 * legitimate offline mint, and a THROWING enumerator degrades rather than blocking the
 * caller — with `degraded` populated so the mint is legible as a floor.
 */
export function mintNextTaskId(opts: {
  /** Path to `plan/tasks.yaml`; its sibling `tasks.d/` is read alongside it. */
  planPath: string;
  /** Open plan PRs' text (title/body/branch), scanned for MENTIONED ids. */
  openPrTexts?: () => string[];
}): MintedTaskId {
  const degraded: MintDegradation[] = [];

  const monolithIds = declaredTaskIds(readFileSync(opts.planPath, "utf8"));
  const shards = shardTaskIds(opts.planPath);
  degraded.push(...shards.degraded);

  let openPrIds: number[] = [];
  let openPrsEnumerated = false;
  if (opts.openPrTexts) {
    try {
      openPrIds = opts.openPrTexts().flatMap(mentionedTaskIds);
      openPrsEnumerated = true;
    } catch (err) {
      degraded.push({ source: "open-prs", reason: `cannot enumerate open PRs: ${String(err)}` });
    }
  }

  const sources: MintSources = {
    monolith: highest(monolithIds),
    shards: highest(shards.ids),
    openPrs: openPrsEnumerated ? highest(openPrIds) : null,
  };
  const maxSeen = Math.max(0, ...[sources.monolith, sources.shards, sources.openPrs].filter((n): n is number => n != null));
  return { id: `W1-T${maxSeen + 1}`, n: maxSeen + 1, maxSeen, sources, degraded };
}

/** One-line provenance for a mint — what it derived from, and any source it could not read. */
export function describeMint(mint: MintedTaskId): string {
  const src = `tasks.yaml ${mint.sources.monolith ?? "-"}, shards ${mint.sources.shards ?? "-"}, open PRs ${mint.sources.openPrs ?? "not enumerated"}`;
  const warn = mint.degraded.length
    ? ` — DEGRADED: ${mint.degraded.map((d) => `${d.source} (${d.reason})`).join("; ")}`
    : "";
  return `${mint.id} (max ${mint.maxSeen} across ${src})${warn}`;
}
