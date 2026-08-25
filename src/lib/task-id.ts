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

/**
 * THE UPPER SANITY BOUND ON AN ALLOCATABLE ID (W1-T1039), AND THE SENTINEL RANGE ABOVE IT.
 *
 * THE DEFECT THIS EXISTS FOR. `maxSeen` below is a `Math.max` across every source with no upper
 * check of any kind, and the invariant in this module's header — "minting MAY skip a number; it
 * must NEVER return a number some source already owns" — is one-directional by design: a single
 * absurdly high id anywhere raises the ceiling permanently and every later mint inherits it. That
 * is not hypothetical. An id was burned by being written as a NEGATIVE CONTROL in prose that the
 * open-PR scan reads, the mint returned it, shards were then filed AT it, and the verb began
 * answering with ids far above the plan's own range while all four surfaces read cleanly. No error
 * surfaces anywhere, because the arithmetic is correct — only the answer is unusable.
 *
 * WHY AN EXPLICIT CONSTANT AND NOT A POPULATION-DERIVED RULE. The self-maintaining form — ignore
 * anything more than N above the SECOND-highest — is refuted by the live data rather than by taste:
 * the outliers are CONSECUTIVE, so highest-minus-second-highest is a gap of 1 and the rule blesses
 * exactly the position that has been poisoned. A rule that needs the outliers to be solitary cannot
 * clean up after a case that produced two of them. A constant is arbitrary only in that a number had
 * to be chosen; it is correct in that it does not depend on the shape of the corruption it survives.
 *
 * WHAT THE HEADROOM IS. The plan's highest real id is in the low thousands after a year of filing,
 * so this is roughly two orders of magnitude of headroom — decades at the observed rate — while
 * sitting far below the magnitude the burned ids occupy.
 *
 * THE COMPLEMENTARY HALF, WHICH IS WHAT MAKES THE CONVENTION SAFE RATHER THAN MERELY SURVIVED.
 * Everything above this bound is NEVER ALLOCATABLE, so the range above it is a sanctioned sentinel
 * space: a negative control drawn from it can be written anywhere, INCLUDING AN OPEN PR BODY,
 * because no mint can ever return one. That is strictly better than teaching the mention scan to
 * read structured fields only — which would also fix this defect, but would blind that scan to a
 * genuinely filed-but-unmerged id, which is the entire reason it reads prose.
 *
 * ALLOCATION ONLY. An id above the bound is ignored HERE and nowhere else. A shard declaring one
 * still loads through `loadPlan`, still lints under `lintPlan`, still counts toward the task total,
 * and stays dispatchable and creditable exactly as before — the two that exist are merged and
 * credited, and `postMergeAmendmentViolations` refuses a renumber, so the fix is a bound that
 * ignores them and never a cleanup that moves them.
 */
export const MAX_ALLOCATABLE_TASK_ID = 100_000;

/**
 * A BACKSTOP (W1-T1266), not a primary control — and the distinction is load-bearing here rather
 * than ceremonial. What NORMALLY keeps the mint's ceiling honest is agreement between the sources:
 * the plan records ids that exist, a filing PR names the one it is about to add, and the two track
 * each other within a single id. This bound fires only once that agreement has ALREADY broken,
 * which in practice means a literal has already been written into prose somewhere. On a healthy
 * population it is never reached, and if it ever starts firing routinely the right response is to
 * ask what is writing burnable literals, never to raise the number.
 *
 * How far a MENTION source (open PR text) may lead the plan's own ceiling before the mint stops
 * believing it. RELATIVE, not absolute: it needs no recalibration as the plan grows.
 *
 * MEASURED 2026-08-25: the legitimate lead is 1 — the open PRs' highest mention was 2289 against a
 * plan ceiling of 2288, which is one filing PR naming the id it is about to add. The observed
 * failure led by 7,711 (a four-digit doc example in one PR body against a plan ceiling of 2288),
 * and the mint handed out that ceiling plus one, then plus two. 100 is two orders above the
 * legitimate lead and two orders below the observed failure, so it needs no precision to separate
 * them — which is what a backstop's sizing should look like.
 */
export const MAX_MENTION_LEAD = 100;

/**
 * May this id number ever be MINTED? False for anything above {@link MAX_ALLOCATABLE_TASK_ID},
 * and for a non-positive or non-integer number — a parse that produced one of those is not an id
 * this allocator may hand out. Read by the per-source fold below; deliberately NOT consulted by
 * `loadPlan`, the linter, or anything that decides visibility or eligibility.
 */
export function isAllocatableTaskId(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= MAX_ALLOCATABLE_TASK_ID;
}

/**
 * The prefix {@link mintNextTaskId} stamps on a degradation it raised because a source READ FINE
 * and answered something no other source corroborates — as opposed to one it could not read at
 * all. SHARED so {@link describeMint} can tell the two apart from `degraded` alone.
 *
 * WHY NOT A THIRD VALUE ON {@link MintSources} (operator ruling, 2026-08-25). `null` there means
 * exactly one thing — NO USABLE CEILING FROM THIS SOURCE — and every consumer that folds the
 * sources into a max is correct to read it that way. WHY the ceiling is unusable is already
 * carried, one field across, in `degraded`. Only the RENDERER needs to distinguish them, so only
 * the renderer looks, and a widened `MintSources` would push a distinction through every consumer
 * to carry something the object already holds.
 */
export const UNTRUSTED_SOURCE_REASON_PREFIX = "read fine but uncorroborated";

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
  /** How many ids the sources carried above {@link MAX_ALLOCATABLE_TASK_ID} and this mint
   *  therefore ignored — a COUNT, never the ids. Zero on a healthy plan. */
  ignoredAboveBound: number;
}

/** Highest ALLOCATABLE id in a list, or `null` when none is — the per-source fold. Ids above
 *  {@link MAX_ALLOCATABLE_TASK_ID} are dropped here rather than at the `Math.max` below, so the
 *  per-source figures `describeMint` prints are the ones that actually fed the mint. That also
 *  keeps the CLI from ECHOING a burned id back at an author, which is how one gets copied into a
 *  PR body and burns the next one. */
function highest(ns: number[]): number | null {
  const allocatable = ns.filter(isAllocatableTaskId);
  return allocatable.length ? Math.max(...allocatable) : null;
}

/** How many ids a source offered that are above the bound — a COUNT, never the ids themselves,
 *  mirroring the ledger discipline that keeps a burned literal out of anything downstream can
 *  echo. Non-zero means the plan really does carry ids this allocator will never hand out. */
function countAboveBound(...lists: number[][]): number {
  return lists.flat().filter((n) => Number.isInteger(n) && n > MAX_ALLOCATABLE_TASK_ID).length;
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

  // THE CORROBORATION CHECK (a source that is PRESENT AND ABSURD). `degraded` already covers a
  // source that could not be READ; nothing covered a source that read fine and answered something
  // no other source agrees with. Open PRs are the only MENTION source here: the plan records ids
  // that EXIST, while a PR body is prose and may carry a fabricated id in a doc example, a
  // placeholder or a quoted prompt — all of which `TASK_ID_MENTION_RE` matches correctly, because
  // they ARE well-formed tokens. So the mention source may lead the plan (a filing PR naming the
  // id it is about to add is normal) but only by {@link MAX_MENTION_LEAD}; beyond that it is
  // asserting a run of ids nothing else has ever seen, and it is DROPPED rather than believed.
  //
  // WHY DROP-AND-SAY RATHER THAN REFUSE. A hard refusal would let one doc example in one open PR
  // body stop every filing in the fleet until a human edited that body — a denial of service
  // authored by a code comment. Dropping the uncorroborated source leaves the mint standing on
  // the plan, which is the authoritative record, and the reservation refs still make a collision
  // impossible. Both are strictly safer than the third option, which is what happened here:
  // minting silently from the outlier.
  //
  // WHY IT KEYS ON A MENTION LEADING THE PLAN, NOT ON ANY TWO SOURCES DISAGREEING. The monolith
  // and the shards legitimately disagree by thousands (280 against 2288 today, because the old
  // monolith ids are low), so a symmetric "sources differ" rule would degrade the shards and
  // break every mint.
  //
  // AND WHY THIS IS NOT `MAX_ALLOCATABLE_TASK_ID`'s JOB. That bound is ABSOLUTE and cannot be
  // tightened to the real ceiling without also refusing the two above-bound ids the plan already
  // carries. This one is RELATIVE, so it needs no calibration against the plan's size and does not
  // move as the plan grows.
  if (sources.openPrs !== null) {
    const planCeiling = Math.max(0, ...[sources.monolith, sources.shards].filter((n): n is number => n != null));
    const lead = sources.openPrs - planCeiling;
    if (planCeiling > 0 && lead > MAX_MENTION_LEAD) {
      degraded.push({
        source: "open-prs",
        reason:
          `${UNTRUSTED_SOURCE_REASON_PREFIX}: its highest mention leads the plan's own ceiling by ${lead} ` +
          `(> ${MAX_MENTION_LEAD}), so it was dropped rather than used as the ceiling — a mention is ` +
          "prose and may name an id nothing has filed",
      });
      // NULLED so `describeMint` cannot echo the burned number back at an author, which is exactly
      // how one gets copied into the next PR body — the same discipline `highest` already keeps.
      sources.openPrs = null;
    }
  }

  // Every term here has already been through `highest`, so each is allocatable or null — the
  // bound is applied at the FOLD, not re-applied at the max.
  const maxSeen = Math.max(0, ...[sources.monolith, sources.shards, sources.openPrs].filter((n): n is number => n != null));
  const ignoredAboveBound = countAboveBound(monolithIds, shards.ids, openPrIds);
  return { id: `W1-T${maxSeen + 1}`, n: maxSeen + 1, maxSeen, sources, degraded, ignoredAboveBound };
}

/** One-line provenance for a mint — what it derived from, and any source it could not read. */
/**
 * How a source that contributed NO ceiling should read. `null` alone cannot say why, so this asks
 * `degraded` — the field that already knows — and names the condition rather than the value: a
 * source read and disbelieved is a different fact from one never read, and rendering the second
 * for the first says "we never looked" when we looked and did not believe it.
 *
 * NEVER THE NUMBER. The whole point of nulling an untrusted source is that its id does not get
 * repeated back at an author; `test/task-id-existence-check.test.ts` scans `src/**` for cited ids
 * and requires each to exist, and it has already caught one comment that would have re-burned
 * them. This describes the condition and prints no id.
 */
function renderAbsentSource(mint: MintedTaskId, source: string): string {
  return mint.degraded.some((d) => d.source === source && d.reason.startsWith(UNTRUSTED_SOURCE_REASON_PREFIX))
    ? "read and not trusted"
    : "not enumerated";
}

export function describeMint(mint: MintedTaskId): string {
  const openPrs = mint.sources.openPrs ?? renderAbsentSource(mint, "open-prs");
  const src = `tasks.yaml ${mint.sources.monolith ?? "-"}, shards ${mint.sources.shards ?? "-"}, open PRs ${openPrs}`;
  const warn = mint.degraded.length
    ? ` — DEGRADED: ${mint.degraded.map((d) => `${d.source} (${d.reason})`).join("; ")}`
    : "";
  // A COUNT, never the ignored ids — printing one would put a burned literal back in front of an
  // author, and the open-PR scan reads exactly that kind of prose.
  const ignored = mint.ignoredAboveBound
    ? ` — ${mint.ignoredAboveBound} id(s) above the allocatable bound ignored`
    : "";
  return `${mint.id} (max ${mint.maxSeen} across ${src})${ignored}${warn}`;
}
