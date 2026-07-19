import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { citation } from "./provenance.js";

/**
 * Promptsmith — the READ side of the compounding thesis (WS-8, W1-T19; SPLIT +
 * INDEX + SUPERSESSION, W1-T33).
 *
 * LEARNINGS.md is written by diagnosing workers and never read back, so every
 * worker starts fresh and re-pays the re-learning tax two files away. This
 * module closes the loop: it injects, into every rendered implement prompt,
 *   (a) DISTRUST THE PROMPT OVER THE INSTALLED VERSION (Standing rule 7),
 *   (b) the autonomy clause (Standing rule 8), and
 *   (c) the LEARNINGS entries whose file-globs MATCH the task.
 *
 * Matching is DETERMINISTIC by `files:` globs — never semantic — so only
 * relevant facts inject. A KNOWLEDGE BUDGET caps the injected chars so a growing
 * learnings file can never become an unbounded context tax; over budget the
 * highest-relevance / most-recently-cited entries win and the rest are DROPPED
 * (logged). Every injected line carries `[src: learnings#<id>]`, so the rendered
 * prompt still passes the provenance linter (Standing rule 1).
 *
 * The machine-readable source of truth is the `learnings/` directory: one flat
 * corpus file becomes a SCAN as it grows, so W1-T33 split it into subsystem
 * shards — `learnings/{platform,architecture,ci,testing,failures}.yaml` — plus
 * a GENERATED index (`learnings/index.json`, `scripts/generate-learnings-index.mjs`,
 * `npm run learnings-index`) mapping each shard to the entry ids and file-globs it
 * carries. `loadLearningsForTaskFiles` uses that index to LOOK UP only the shard
 * files a task could possibly match, instead of parsing the whole corpus every
 * time. The prose `LEARNINGS.md` stays the human/Architect-owned narrative
 * (MASTER-PLAN governance) and is intentionally NOT parsed here.
 *
 * SUPERSESSION: an entry carries `lifecycle: active | superseded | quarantined`
 * (default `active`). Provenance decays — a fact can become FALSE — so a
 * `superseded` entry is NEVER injected (`selectLearnings` filters it out before
 * ranking); it stays in its shard file for provenance only, optionally naming
 * the entry that replaced it via `superseded_by`.
 *
 * SELF-VERIFICATION (W1-T34): an entry may additionally carry an `assertion` —
 * a shell command that must exit 0 for the fact to still be considered true (a
 * fact pinned to, say, an SDK version must not keep being injected once the SDK
 * moves). `scripts/learnings-assert-check.mjs` runs every entry's assertion; a
 * FAILING one flips that entry's committed `lifecycle` to `quarantined` (and
 * records why in `quarantined_reason`) — the exact same generate-and-`--check`
 * shape as the W1-T33 index (`npm run learnings-assert` mutates the shard,
 * `npm run learnings-assert:check` fails CI when the committed corpus doesn't
 * match a fresh re-verification, naming the stale entry). A `quarantined`
 * entry is filtered out by `selectLearnings` exactly like `superseded` — this
 * module never itself executes an assertion, keeping injection a pure, fast,
 * non-shelling lookup. Re-verification (the assertion passing again) is what
 * lets a subsequent `npm run learnings-assert` restore `lifecycle: active`.
 */

/** Standing rule 7 — empirically the highest-value line in the template. */
export const DISTRUST_RULE =
  "DISTRUST THE PROMPT OVER THE INSTALLED VERSION. Read the installed schema/behaviour before trusting any spelling, shape, or default a prompt asserts — including this one's. (Standing rule 7)";

/** Standing rule 8 — the autonomy clause. */
export const AUTONOMY_CLAUSE =
  "Proceed autonomously: the loop never waits on a human unless the plan says so, and idle time is spent grooming. Escalate only when the plan requires it. (Standing rule 8)";

/** Provenance ids for the two always-injected doctrine lines. */
const DISTRUST_SRC = "learnings#standing-rule-7";
const AUTONOMY_SRC = "learnings#standing-rule-8";

/**
 * Default KNOWLEDGE BUDGET: the max chars of MATCHED-learning fact lines injected
 * per prompt. The two doctrine lines above are mandatory and NOT counted against
 * it — only the growing, file-matched corpus is capped.
 */
export const DEFAULT_KNOWLEDGE_BUDGET_CHARS = 1800;

/**
 * An entry's LIFECYCLE (W1-T33 + W1-T34). `active` (the default) is a
 * candidate for injection. `superseded` means provenance decayed by human
 * correction — a newer entry replaced this fact — and the entry stays in its
 * shard for the historical record. `quarantined` means provenance decayed
 * AUTOMATICALLY: the entry's `assertion` currently fails, so
 * `scripts/learnings-assert-check.mjs` flipped it here. Both `superseded` and
 * `quarantined` entries are filtered out by `selectLearnings` before ranking,
 * so neither can ever be injected into a rendered prompt.
 */
export type Lifecycle = "active" | "superseded" | "quarantined";

/** One durable, provenance-tagged fact, tagged for deterministic matching. */
export interface LearningEntry {
  /** Stable slug used in the injected citation `[src: learnings#<id>]`. */
  id: string;
  /** Human-facing grouping (e.g. `containment`, `ci`); advisory, not matched. */
  subsystem: string;
  /** `active` | `superseded` | `quarantined` (default `active`). See {@link Lifecycle}. */
  lifecycle: Lifecycle;
  /** (superseded entries only) the id of the entry that replaced this one. */
  supersededBy?: string;
  /**
   * (W1-T34) An optional shell command (run via `sh -c` from the repo root)
   * that must exit 0 for this entry's `fact` to still be considered true.
   * Verified by `scripts/learnings-assert-check.mjs`, never by this module.
   */
  assertion?: string;
  /**
   * (quarantined entries only, W1-T34) why `learnings-assert-check.mjs`
   * auto-quarantined this entry — the failing assertion plus its exit code,
   * recorded so a human reading the shard sees why without re-running it.
   */
  quarantinedReason?: string;
  /** Repo-relative globs; an entry matches a task iff one glob hits a task file. */
  files: string[];
  /** The fact itself — one line, the thing a worker inherits. */
  fact: string;
  /** Provenance of the fact (e.g. `PR#8`); recorded lineage, not the injected src. */
  src: string;
  /** Optional ISO date last cited; recent entries win a budget tie. */
  cited?: string;
}

export class LearningsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningsError";
  }
}

/** Compile one glob to an anchored RegExp (`**` spans `/`, `*`/`?` do not). */
function globToRegExp(glob: string): RegExp {
  const SPECIAL = ".+^${}()|[]\\";
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (SPECIAL.includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$");
}

/** How many of `taskFiles` this entry's globs match (0 = no concrete match). */
function matchCount(entry: LearningEntry, taskFiles: string[]): number {
  const globs = entry.files.map(globToRegExp);
  return taskFiles.filter((f) => globs.some((g) => g.test(f))).length;
}

/**
 * Parse one already-loaded YAML document (a list of entry mappings) into
 * validated `LearningEntry` records, checking ids against the supplied `seen`
 * set so a caller can share one set across MULTIPLE files (cross-shard
 * duplicate-id detection) or pass a fresh one for single-file loading.
 * `sourceLabel` is only used to make error messages point at the right file.
 */
function parseLearningsDoc(raw: unknown, sourceLabel: string, seen: Set<string>): LearningEntry[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new LearningsError(`learnings must be a YAML list of entries (${sourceLabel}).`);
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new LearningsError(`learnings entry ${i} must be a mapping (${sourceLabel}).`);
    }
    const e = entry as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new LearningsError(`learnings entry ${i}: missing string 'id' (${sourceLabel}).`);
    }
    if (seen.has(id)) throw new LearningsError(`duplicate learnings id '${id}' (${sourceLabel}).`);
    seen.add(id);
    if (typeof e.fact !== "string" || e.fact.length === 0) {
      throw new LearningsError(`learnings '${id}': missing string 'fact' (${sourceLabel}).`);
    }
    if (typeof e.src !== "string" || e.src.length === 0) {
      throw new LearningsError(`learnings '${id}': missing string 'src' (${sourceLabel}).`);
    }
    if (!Array.isArray(e.files) || e.files.some((f) => typeof f !== "string")) {
      throw new LearningsError(`learnings '${id}': 'files' must be a list of globs (${sourceLabel}).`);
    }
    let lifecycle: Lifecycle = "active";
    if (e.lifecycle !== undefined) {
      if (e.lifecycle !== "active" && e.lifecycle !== "superseded" && e.lifecycle !== "quarantined") {
        throw new LearningsError(
          `learnings '${id}': 'lifecycle' must be 'active', 'superseded', or 'quarantined', got ${JSON.stringify(e.lifecycle)} (${sourceLabel}).`,
        );
      }
      lifecycle = e.lifecycle;
    }
    const supersededBy = typeof e.superseded_by === "string" && e.superseded_by.length > 0 ? e.superseded_by : undefined;
    if (supersededBy !== undefined && lifecycle !== "superseded") {
      throw new LearningsError(
        `learnings '${id}': 'superseded_by' is set but 'lifecycle' is not 'superseded' (${sourceLabel}).`,
      );
    }
    if (e.assertion !== undefined && (typeof e.assertion !== "string" || e.assertion.length === 0)) {
      throw new LearningsError(`learnings '${id}': 'assertion' must be a non-empty string (${sourceLabel}).`);
    }
    const assertion = typeof e.assertion === "string" ? e.assertion : undefined;
    const quarantinedReason =
      typeof e.quarantined_reason === "string" && e.quarantined_reason.length > 0 ? e.quarantined_reason : undefined;
    if (quarantinedReason !== undefined && lifecycle !== "quarantined") {
      throw new LearningsError(
        `learnings '${id}': 'quarantined_reason' is set but 'lifecycle' is not 'quarantined' (${sourceLabel}).`,
      );
    }
    return {
      id,
      subsystem: typeof e.subsystem === "string" ? e.subsystem : "",
      lifecycle,
      supersededBy,
      assertion,
      quarantinedReason,
      files: e.files as string[],
      fact: e.fact,
      src: e.src,
      cited: typeof e.cited === "string" ? e.cited : undefined,
    };
  });
}

/** Parse one learnings YAML file. A MISSING file is not an error — returns `[]`. */
export function loadLearnings(path: string): LearningEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return []; // no corpus yet — inject only the doctrine lines
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new LearningsError(`learnings is not valid YAML (${path}): ${String(err)}`);
  }
  return parseLearningsDoc(raw, path, new Set());
}

/**
 * Parse EVERY `*.yaml` shard in `dir` (sorted by filename for determinism) into
 * one merged corpus (W1-T33 SPLIT). Ids are checked for uniqueness ACROSS every
 * shard, not just within one — two shards defining the same id is a corpus
 * error, same as a single-file duplicate. A MISSING directory is not an error —
 * returns `[]` (no corpus yet, same convention as {@link loadLearnings}).
 * Includes `superseded` entries (callers that must never inject them, i.e.
 * `selectLearnings`, filter those out themselves); this is the full corpus,
 * kept for provenance/index purposes too.
 */
export function loadLearningsCorpus(dir: string): LearningEntry[] {
  let filenames: string[];
  try {
    filenames = readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .sort();
  } catch {
    return []; // no corpus directory yet
  }
  const seen = new Set<string>();
  const entries: LearningEntry[] = [];
  for (const filename of filenames) {
    const path = join(dir, filename);
    const text = readFileSync(path, "utf8");
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (err) {
      throw new LearningsError(`learnings is not valid YAML (${path}): ${String(err)}`);
    }
    entries.push(...parseLearningsDoc(raw, path, seen));
  }
  return entries;
}

/**
 * A GENERATED lookup index (W1-T33): for every corpus shard filename, the
 * entry ids it carries and the union of `files:` globs those entries use, plus
 * a `subsystem -> shard filename(s)` map. `scripts/generate-learnings-index.mjs`
 * writes `learnings/index.json` from the shard files; `npm run
 * learnings-index:check` fails when the committed index doesn't match a fresh
 * regeneration (a STALE index).
 */
export interface LearningsIndex {
  files: Record<string, { entries: string[]; globs: string[] }>;
  bySubsystem: Record<string, string[]>;
}

/** Parse a `learnings/index.json`. Returns `null` on any missing/malformed index (non-fatal — callers fall back to a full corpus scan rather than fail closed on a lookup optimization). */
export function loadLearningsIndex(path: string): LearningsIndex | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text) as unknown;
    const r = raw as { files?: unknown; bySubsystem?: unknown };
    if (typeof r !== "object" || r === null || typeof r.files !== "object" || r.files === null) return null;
    return raw as LearningsIndex;
  } catch {
    return null;
  }
}

/**
 * PURE lookup: which shard filenames in `index` could possibly contain an
 * entry matching `taskFiles`? Repo-wide (`taskFiles` empty/absent) candidates
 * every shard — the budget still bounds the tax. Otherwise a shard is a
 * candidate iff at least one of the globs its entries use matches at least one
 * task file. This is the LOOKUP, not a full scan: it never parses/loads a
 * shard's entries, only tests the pre-recorded glob strings from the index.
 */
export function candidateShardFiles(index: LearningsIndex, taskFiles: string[] | undefined): string[] {
  const filenames = Object.keys(index.files).sort();
  const files = taskFiles ?? [];
  if (files.length === 0) return filenames; // repo-wide: every shard is a candidate
  return filenames.filter((filename) => {
    const globs = index.files[filename].globs.map(globToRegExp);
    return files.some((f) => globs.some((g) => g.test(f)));
  });
}

/**
 * The Promptsmith entry point (W1-T33): load only the corpus shards `taskFiles`
 * could match, using the generated `learnings/index.json` for the lookup — a
 * task touching one subsystem's files parses ONE shard, not all five (and not
 * whatever N grows to). Falls back to a full `loadLearningsCorpus` scan if the
 * index is missing (e.g. a fresh checkout before the first `npm run
 * learnings-index` run) — correctness never depends on the index being
 * present, only the LOOKUP-vs-SCAN performance win does.
 */
export function loadLearningsForTaskFiles(learningsDir: string, taskFiles: string[] | undefined): LearningEntry[] {
  const index = loadLearningsIndex(join(learningsDir, "index.json"));
  if (!index) return loadLearningsCorpus(learningsDir);
  const candidates = candidateShardFiles(index, taskFiles);
  const entries: LearningEntry[] = [];
  for (const filename of candidates) {
    entries.push(...loadLearnings(join(learningsDir, filename)));
  }
  return entries;
}

/**
 * Select the learnings to inject for a task, DETERMINISTICALLY.
 *
 * LIFECYCLE FILTER (W1-T33 supersession, W1-T34 quarantine) first: an entry
 * whose `lifecycle` is `superseded` OR `quarantined` is dropped from
 * candidacy before matching even runs — its provenance has decayed (by human
 * correction, or by a failing self-verification assertion) and it must NEVER
 * be injected, no matter how well its `files:` would otherwise match. It is
 * excluded here, not merely de-prioritized, so no budget pressure or
 * tie-break can let it slip through.
 *
 * Matching: an entry is a candidate iff one of its globs matches one of
 * `taskFiles`. When `taskFiles` is empty/absent the task is treated as
 * repo-wide, so EVERY (non-superseded) entry is a candidate (the budget still
 * bounds the tax).
 *
 * Ordering (highest first): concrete match count → most-recently-cited → id.
 * Then fill up to `budgetChars` of rendered fact lines; the remainder is
 * `dropped` (returned for logging), so the injected corpus is bounded.
 */
export function selectLearnings(
  entries: LearningEntry[],
  taskFiles: string[] | undefined,
  budgetChars: number = DEFAULT_KNOWLEDGE_BUDGET_CHARS,
): { selected: LearningEntry[]; dropped: LearningEntry[] } {
  const active = entries.filter((e) => e.lifecycle === "active");
  const files = taskFiles ?? [];
  const repoWide = files.length === 0;
  const ranked = active
    .map((entry) => ({ entry, count: repoWide ? 0 : matchCount(entry, files) }))
    .filter((r) => repoWide || r.count > 0)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      const ac = a.entry.cited ?? "";
      const bc = b.entry.cited ?? "";
      if (ac !== bc) return bc < ac ? -1 : 1; // recent (larger ISO) first
      return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
    })
    .map((r) => r.entry);

  const selected: LearningEntry[] = [];
  const dropped: LearningEntry[] = [];
  let used = 0;
  for (const entry of ranked) {
    const cost = renderLearningLine(entry).length + 1; // +1 for the joining "\n"
    if (used + cost > budgetChars && selected.length > 0) {
      dropped.push(entry);
      continue;
    }
    selected.push(entry);
    used += cost;
  }
  return { selected, dropped };
}

/** One entry as a provenance-tagged CONTEXT bullet. */
function renderLearningLine(entry: LearningEntry): string {
  return `- ${entry.fact} ${citation(`learnings#${entry.id}`)}`;
}

/**
 * Render ONLY the two mandatory, INVARIANT doctrine lines (Tier 0, MASTER-PLAN
 * §8A) — the distrust rule and the autonomy clause. This is the STABLE PREFIX
 * of the cache-aware assembly rule (W1-T35): it is line-capped and must change
 * RARELY, since an edit here busts the prompt cache for every worker rendered
 * after it. Callers place this FIRST in a rendered prompt, ahead of anything
 * volatile (task context, recon output, matched learnings). Always non-empty.
 */
export function renderDoctrinePreamble(): string {
  return [
    `- ${DISTRUST_RULE} ${citation(DISTRUST_SRC)}`,
    `- ${AUTONOMY_CLAUSE} ${citation(AUTONOMY_SRC)}`,
  ].join("\n");
}

/**
 * Render ONLY the task-matched LEARNINGS facts (Tier 1, W1-T19/W1-T33) — no
 * doctrine lines. VOLATILE: the corpus grows every retro, so callers place
 * this LAST in a rendered prompt (cache-aware ordering, W1-T35), never ahead
 * of the stable {@link renderDoctrinePreamble} block. "" when nothing matched.
 */
export function renderMatchedLearnings(selected: LearningEntry[]): string {
  return selected.map(renderLearningLine).join("\n");
}

/**
 * Render the LEARNINGS half of a prompt's CONTEXT block: the two mandatory
 * doctrine lines followed by the pre-selected, matched facts. Every line is
 * cited, so the block passes the provenance linter. Returns "" only if you pass
 * an empty selection AND the doctrine lines are unwanted (never — they always
 * emit), so the string is always non-empty.
 *
 * Bundles {@link renderDoctrinePreamble} + {@link renderMatchedLearnings} in
 * historical (doctrine-then-facts) order for callers that want ONE block
 * rather than the two pieces separately. `renderImplementPrompt` (run-task.ts)
 * does NOT use this — it keeps the two pieces apart so it can place the
 * stable preamble first and the volatile matched facts last in the wider
 * CONTEXT block (cache-aware ordering, W1-T35), not merely relative to each
 * other.
 */
export function renderLearningsContext(selected: LearningEntry[]): string {
  return [renderDoctrinePreamble(), renderMatchedLearnings(selected)].filter((s) => s.length > 0).join("\n");
}
