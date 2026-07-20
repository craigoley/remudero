import { createHash } from "node:crypto";
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
 *
 * LAYERS (P32/W1-T145): the corpus this file parses is the PROJECT layer —
 * repo-scoped, everything above. P32 proposes two more: USER-OVERALL
 * (cross-project, one fleet-readable home outside any single repo checkout,
 * `userOverallLearningsHome` in config.ts) and RMD-GLOBAL (cross-user,
 * opt-in, a versioned HASH-PINNED artifact, `globalLearningsHome` in
 * config.ts / {@link loadGlobalArtifact} here). ONE entry shape
 * ({@link LearningEntry}, unchanged except for the new optional `layer`
 * field) is valid at every layer — the SAME `parseLearningsDoc` validates a
 * project shard, a user-overall shard, and a global artifact's `entries`
 * identically, so an entry can move between layers without reshaping.
 * {@link loadLayeredLearnings} reads all three homes in precedence order
 * (project, then user-overall, then global) into one merged corpus.
 *
 * PROMOTION (P32/W1-T146): {@link promoteEntry} decides whether ONE entry
 * rises a layer. Promotion is a strict two-stage pipeline, SCRUB then JUDGE,
 * never the reverse: (1) {@link scrubEntry} is a DETERMINISTIC leak-grep
 * analog (secret-pattern regexes) plus a PII detector; a hit BLOCKS
 * promotion and the judge is NEVER invoked (the opt-in, error-reporting
 * model — nothing project-identifying reaches an LLM call without first
 * clearing scrub). (2) only once scrub passes does {@link
 * PromotionJudgeDeps.judge} — an injected, advisory LLM applicability
 * eval, mirroring flight-judge.ts's `deps.judge` shape so promotion stays
 * unit-testable without a real spawn — decide project-specific (stays) vs
 * broadly-applicable (promotes one layer up, via {@link
 * planPromotionFromVerdict}). The judge is FAIL-CLOSED: a parse failure, a
 * missing verdict, or a confidence below {@link
 * planPromotionFromVerdict}'s threshold all resolve to "does not promote" —
 * uncertainty never promotes. A promoted entry's `src` provenance survives
 * REDACTED ({@link redactProvenance} strips repo-identifying specifics —
 * task ids, PR/issue numbers — while keeping the origin's shape), never
 * dropped outright. {@link runPromotionPass} batches {@link promoteEntry}
 * over a corpus. The PER-LAYER BUDGET RATCHET ({@link
 * computeLayerBudgetUsage} / {@link evaluateLayerBudgetRatchet}) extends
 * learnings-budget-ratchet's (W1-T38, scripts/learnings-budget-ratchet.mjs)
 * injectable-weight measurement so each layer's active corpus is capped
 * INDEPENDENTLY, rather than one global ceiling across all three layers.
 *
 * The transport that actually MOVES a promoted entry onto a populated
 * user-overall/global home on this machine (§6, DECISIONS.md
 * distribution-architecture Tier 3) is still deferred — this module decides
 * WHETHER an entry promotes and produces its next-layer shape; writing that
 * shape to a real home is the transport's job.
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

/**
 * Which knowledge layer an entry lives at (P32/W1-T145): `project`
 * (repo-scoped, the default), `user-overall` (cross-project, one operator's
 * fleet), or `global` (cross-user, opt-in, hash-pinned). Layer is ORTHOGONAL
 * to lifecycle — it says WHERE an entry is read from, not whether it is
 * injectable.
 */
export type Layer = "project" | "user-overall" | "global";

/** Every valid {@link Layer}, in promotion order (bottom-up: project -> user-overall -> global). */
export const LAYERS: readonly Layer[] = ["project", "user-overall", "global"];

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
  /**
   * (W1-T50) Marks a `failures`-subsystem incident whose SYMPTOM is
   * operator-visible (something you'd see running `rmd`, not only in a
   * worker's internal diff). Optional; defaults to `false` — most failures
   * entries are dev-time postmortems, not operator-facing. `true` obligates a
   * matching `docs/troubleshooting.md` entry; `checkTroubleshootingCoverage`
   * (src/lib/review.ts) enforces that at review time from the diff alone.
   */
  operatorImpact?: boolean;
  /**
   * (P32/W1-T145) Which knowledge layer this entry lives at. Optional;
   * DEFAULTS TO `"project"` when omitted — every pre-existing shard entry
   * (written before this field existed) is a project entry with no edit
   * required. Use {@link entryLayer} to read the defaulted value rather than
   * this raw (possibly-`undefined`) field directly.
   */
  layer?: Layer;
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
    if (e.operator_impact !== undefined && typeof e.operator_impact !== "boolean") {
      throw new LearningsError(`learnings '${id}': 'operator_impact' must be a boolean (${sourceLabel}).`);
    }
    const operatorImpact = e.operator_impact === true;
    let layer: Layer | undefined;
    if (e.layer !== undefined) {
      if (e.layer !== "project" && e.layer !== "user-overall" && e.layer !== "global") {
        throw new LearningsError(
          `learnings '${id}': 'layer' must be 'project', 'user-overall', or 'global', got ${JSON.stringify(e.layer)} (${sourceLabel}).`,
        );
      }
      layer = e.layer;
    }
    return {
      id,
      subsystem: typeof e.subsystem === "string" ? e.subsystem : "",
      lifecycle,
      supersededBy,
      assertion,
      quarantinedReason,
      operatorImpact,
      layer,
      files: e.files as string[],
      fact: e.fact,
      src: e.src,
      cited: typeof e.cited === "string" ? e.cited : undefined,
    };
  });
}

/** Read an entry's {@link Layer}, applying the `"project"` default when `layer` is omitted. */
export function entryLayer(entry: LearningEntry): Layer {
  return entry.layer ?? "project";
}

/**
 * The PROJECT layer's home (P32/W1-T145): the repo-relative directory
 * `loadLearningsCorpus`/`loadLearningsForTaskFiles` already read (W1-T33's
 * shard split — `run-task.ts` derives this same path inline today as
 * `join(dirname(planPath), "..", "learnings")`; this helper names it so
 * project, {@link userOverallLearningsHome}, and {@link globalLearningsHome}
 * (config.ts) read as one symmetric set of layer-home functions).
 */
export function projectLearningsHome(repoRoot: string): string {
  return join(repoRoot, "learnings");
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
 * Compute a per-entry char weight that budget accounting counts against —
 * the RENDERED injectable line length (P32/W1-T145; the shape
 * `selectLearnings` already used inline, now named/exported so it is the ONE
 * definition every layer/caller — including the future per-layer ratchet,
 * W1-T146 — measures "budget-counted" against, rather than each re-deriving
 * its own render).
 */
export function entryBudgetWeight(entry: LearningEntry): number {
  return renderLearningLine(entry).length;
}

/**
 * The RMD-GLOBAL layer's artifact shape (P32/W1-T145): a VERSIONED,
 * content-addressed bundle of {@link LearningEntry} records. `hash` pins the
 * artifact's own content — {@link computeArtifactHash} recomputed over
 * `entries` must equal it, or the artifact is a forgery/corruption and
 * {@link loadGlobalArtifact} refuses it. The transport that produces/pulls
 * this file (opt-in POST up / hash-pinned pull down, §6, DECISIONS.md
 * distribution-architecture Tier 3) is DEFERRED — this is only the shape a
 * pulled artifact must satisfy to be trusted.
 */
export interface GlobalArtifact {
  /** Human-facing artifact version (e.g. a date or semver-ish tag); advisory. */
  version: string;
  /** sha256 hex digest of `entries`, per {@link computeArtifactHash}. */
  hash: string;
  entries: LearningEntry[];
}

/**
 * Deterministic sha256 content hash of a set of layered-learnings entries
 * (P32/W1-T145). Sorted by `id` first so ENTRY ORDER never changes the hash —
 * only content does — then hashed over each field the schema defines
 * (`undefined` optionals normalized to `null` so an omitted field hashes
 * identically regardless of which code path produced the in-memory object).
 */
export function computeArtifactHash(entries: LearningEntry[]): string {
  const canonical = [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => ({
      id: e.id,
      subsystem: e.subsystem,
      lifecycle: e.lifecycle,
      supersededBy: e.supersededBy ?? null,
      assertion: e.assertion ?? null,
      quarantinedReason: e.quarantinedReason ?? null,
      operatorImpact: e.operatorImpact ?? false,
      layer: entryLayer(e),
      files: e.files,
      fact: e.fact,
      src: e.src,
      cited: e.cited ?? null,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The result of loading + verifying a {@link GlobalArtifact}. */
export type GlobalArtifactResult =
  | { ok: true; artifact: GlobalArtifact; entries: LearningEntry[] }
  | { ok: false; reason: string };

/**
 * Load and VERIFY the RMD-GLOBAL artifact at `path` (P32/W1-T145).
 *
 * `entries` is parsed through the exact same {@link parseLearningsDoc} every
 * other layer uses — a malformed global entry is rejected with the same
 * {@link LearningsError} shape a malformed project or user-overall entry
 * would produce; ONE validator, every layer. The content hash is then
 * recomputed via {@link computeArtifactHash} and compared to the artifact's
 * own `hash` field: a MISMATCH (tampering, corruption, or a hand-edited
 * `entries` list that forgot to re-pin) means the artifact is REFUSED —
 * `{ ok: false }`, contributing zero entries — never silently trusted. A
 * missing file is refused the same way (nothing pulled yet reads identically
 * to "refuse silently", which is the correct default for an opt-in layer
 * nothing has to populate).
 */
export function loadGlobalArtifact(path: string): GlobalArtifactResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: `global artifact not found: ${path}` };
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { ok: false, reason: `global artifact is not valid YAML (${path}): ${String(err)}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `global artifact must be a mapping with 'version', 'hash', 'entries' (${path})` };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== "string" || r.version.length === 0) {
    return { ok: false, reason: `global artifact missing string 'version' (${path})` };
  }
  if (typeof r.hash !== "string" || r.hash.length === 0) {
    return { ok: false, reason: `global artifact missing string 'hash' (${path})` };
  }
  let entries: LearningEntry[];
  try {
    entries = parseLearningsDoc(r.entries, path, new Set());
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const actualHash = computeArtifactHash(entries);
  if (actualHash !== r.hash) {
    return {
      ok: false,
      reason: `global artifact hash mismatch (${path}): pinned ${r.hash}, computed ${actualHash} — refused, not trusted`,
    };
  }
  return { ok: true, artifact: { version: r.version, hash: r.hash, entries }, entries };
}

/** Where to read each P32 layer from for one {@link loadLayeredLearnings} call. */
export interface LayeredLearningsHomes {
  /** Project layer directory, e.g. {@link projectLearningsHome}'s return value. Required — always read. */
  projectDir: string;
  /** User-overall layer directory, e.g. `userOverallLearningsHome(config)` (config.ts). Optional: omitted = not read. */
  userOverallDir?: string;
  /** Global layer artifact file, e.g. inside `globalLearningsHome(config)` (config.ts). Optional: omitted = not read. */
  globalArtifactPath?: string;
}

/** The result of one layered read: the merged corpus, plus why the global layer was excluded (if it was). */
export interface LayeredLearningsResult {
  entries: LearningEntry[];
  /** Set iff a `globalArtifactPath` was given but {@link loadGlobalArtifact} refused it (missing/malformed/hash mismatch). */
  globalRefusedReason?: string;
}

/**
 * Read all three P32 layers into ONE merged corpus, in PRECEDENCE ORDER:
 * project first, user-overall second, global last (bottom-up promotion's
 * read-side mirror — the most repo-specific facts are listed first).
 * Downstream ranking ({@link selectLearnings}) still applies its own
 * match-count/recency ordering on top of this list; "precedence" here only
 * fixes the merge order, not the final injected order.
 *
 * Missing project/user-overall directories are non-fatal, same convention as
 * {@link loadLearningsCorpus} (no corpus at that layer yet -> contributes
 * nothing). A global artifact that fails verification contributes ZERO
 * entries and its reason is surfaced via `globalRefusedReason` for the
 * caller to log — excluded, never silently trusted (the W1-T145 falsifier).
 *
 * No PROMOTION or SCRUB gate lives here — this only reads what already
 * exists at each home; deciding what MOVES between layers is W1-T146.
 */
export function loadLayeredLearnings(homes: LayeredLearningsHomes): LayeredLearningsResult {
  return mergeLayers(loadLearningsCorpus(homes.projectDir), homes);
}

/**
 * The PROMPT-ASSEMBLY entry point (P32/W1-T145): identical to
 * {@link loadLayeredLearnings} except the PROJECT layer is read via the
 * INDEX-based {@link loadLearningsForTaskFiles} lookup (W1-T33) instead of a
 * full corpus scan — the same lookup-not-scan property the project layer
 * already had is preserved once user-overall/global are merged in, so
 * layering never regresses the project corpus's O(matching shards) cost.
 * This is what a real prompt assembly (`run-task.ts`'s implement dispatch)
 * calls: project (index lookup, file-matched) + user-overall (full corpus,
 * expected small/cross-project) + global (hash-verified artifact), merged in
 * PRECEDENCE ORDER, ready to hand to {@link selectLearnings} /
 * {@link renderMatchedLearnings} exactly like the project-only corpus was
 * before this task.
 */
export function loadLayeredLearningsForTaskFiles(
  homes: LayeredLearningsHomes,
  taskFiles: string[] | undefined,
): LayeredLearningsResult {
  return mergeLayers(loadLearningsForTaskFiles(homes.projectDir, taskFiles), homes);
}

/** Shared merge step behind {@link loadLayeredLearnings}/{@link loadLayeredLearningsForTaskFiles}: append user-overall then verified-global onto an already-loaded project corpus, in PRECEDENCE ORDER. */
function mergeLayers(projectEntries: LearningEntry[], homes: LayeredLearningsHomes): LayeredLearningsResult {
  const entries: LearningEntry[] = [...projectEntries];
  if (homes.userOverallDir) {
    entries.push(...loadLearningsCorpus(homes.userOverallDir));
  }
  let globalRefusedReason: string | undefined;
  if (homes.globalArtifactPath) {
    const result = loadGlobalArtifact(homes.globalArtifactPath);
    if (result.ok) {
      entries.push(...result.entries);
    } else {
      globalRefusedReason = result.reason;
    }
  }
  return { entries, globalRefusedReason };
}

// ── PROMOTION (P32/W1-T146): SCRUB THEN JUDGE ──────────────────────────────

/** One deterministic scrub pattern: a name (surfaced in a block reason) + regex it matches against. */
interface ScrubPattern {
  name: string;
  pattern: RegExp;
}

/**
 * Leak-grep analog: deterministic secret-shaped patterns. Deliberately
 * conservative (specific token shapes, not "any long string") so scrub does
 * not blanket-block ordinary facts — the acceptance bar is "a deliberately
 * secret-bearing entry is BLOCKED," not "every entry with a long word is."
 */
const SECRET_PATTERNS: ScrubPattern[] = [
  { name: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github-token", pattern: /\bgh[opsu]_[A-Za-z0-9]{20,}\b/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "private-key-block", pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
  {
    name: "generic-credential-assignment",
    pattern: /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"]?[A-Za-z0-9/+_.-]{12,}['"]?/i,
  },
];

/** PII detector patterns: the shapes a fact/provenance line should never carry. */
const PII_PATTERNS: ScrubPattern[] = [
  { name: "email-address", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: "phone-number", pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/ },
];

/** The result of running {@link scrubEntry}: whether it blocks promotion, and every pattern name that hit. */
export interface ScrubResult {
  blocked: boolean;
  reasons: string[];
}

/** Every free-text field of an entry a leaked secret/PII value could hide in. `files` (globs) is excluded — not free text. */
function scrubbableFields(entry: LearningEntry): (string | undefined)[] {
  return [entry.fact, entry.src, entry.assertion, entry.quarantinedReason];
}

/**
 * The SCRUB gate (P32/W1-T146, stage 1 of {@link promoteEntry}): a
 * DETERMINISTIC leak-grep analog (secret-pattern regexes) plus a PII
 * detector, run over every free-text field of `entry`. Pure and synchronous
 * — no LLM call, no network, no I/O — so a caller can run it before ever
 * paying for (or risking) a judge invocation. `blocked: true` means
 * promotion must stop HERE; {@link promoteEntry} never calls the judge when
 * this returns blocked.
 */
export function scrubEntry(entry: LearningEntry): ScrubResult {
  const reasons = new Set<string>();
  for (const field of scrubbableFields(entry)) {
    if (!field) continue;
    for (const p of SECRET_PATTERNS) if (p.pattern.test(field)) reasons.add(p.name);
    for (const p of PII_PATTERNS) if (p.pattern.test(field)) reasons.add(p.name);
  }
  return { blocked: reasons.size > 0, reasons: [...reasons].sort() };
}

/** Applicability classes the promotion judge chooses between — see {@link buildPromotionJudgePrompt}. */
export type PromotionApplicability = "project-specific" | "broadly-applicable";

/** What the promotion judge returns. ADVISORY — {@link planPromotionFromVerdict} is the deterministic actor (Standing rule 12, same split as flight-judge.ts). */
export interface PromotionJudgeVerdict {
  applicability: PromotionApplicability;
  /** 0..1 — how confident the judge is in `applicability`. */
  confidence: number;
  /** One-sentence concrete reason, surfaced in logs/results for a human to audit. */
  rationale: string;
}

/**
 * Build the promotion judge's prompt for ONE entry (P32/W1-T146). The judge
 * sees ONLY this entry's fields (id, subsystem, fact, src, files) — never
 * sibling entries, never the corpus it would join — so its verdict is about
 * this fact's own shape, not comparative. Mirrors flight-judge.ts's
 * `buildJudgePrompt`: prose framing + a fixed MACHINE-READABLE OUTPUT
 * contract a caller can parse without an LLM round-trip to re-ask.
 */
export function buildPromotionJudgePrompt(entry: LearningEntry): string {
  return [
    `You are the PROMOTION JUDGE (P32/W1-T146) — a broader-applicability`,
    `evaluator for ONE knowledge-layer entry that has ALREADY PASSED the`,
    `deterministic scrub gate (no secret/PII pattern matched its text). You`,
    `decide ONLY whether the fact below GENERALIZES beyond this one repo — you`,
    `never edit the entry, never write to any layer, and never see any other`,
    `entry. A deterministic caller acts on your verdict (fail-closed:`,
    `anything short of a confident BROADLY-APPLICABLE call keeps the entry at`,
    `its current layer).`,
    ``,
    `ENTRY:`,
    `  id: ${entry.id}`,
    `  subsystem: ${entry.subsystem}`,
    `  fact: ${entry.fact}`,
    `  src: ${entry.src}`,
    `  files: ${entry.files.join(", ") || "(none)"}`,
    ``,
    `Classify the entry's APPLICABILITY — exactly one of:`,
    `  project-specific    — names/depends on THIS repo's paths, ids, tasks,`,
    `                        PRs, tools, or architecture; would not transfer`,
    `                        to a worker in a different repo`,
    `  broadly-applicable  — a cross-cutting lesson that holds regardless of`,
    `                        which repo/project a worker is in`,
    ``,
    `MACHINE-READABLE OUTPUT (required, in addition to any prose): emit`,
    `exactly one of each of these lines, and nothing else on the line:`,
    `  PROMOTION_APPLICABILITY: <project-specific|broadly-applicable>`,
    `  PROMOTION_CONFIDENCE: <0.0-1.0>`,
    `  PROMOTION_RATIONALE: <one sentence, the concrete reason>`,
  ].join("\n");
}

/**
 * FAIL-CLOSED default when the judge's output carries no parseable verdict
 * (same doctrine as flight-judge.ts's `FAIL_CLOSED_VERDICT`): an unreadable
 * judge is evidence the entry should NOT move, not a reason to wave it
 * through. `applicability: "project-specific"` at `confidence: 0` can never
 * satisfy {@link planPromotionFromVerdict}'s threshold.
 */
const FAIL_CLOSED_PROMOTION_VERDICT: PromotionJudgeVerdict = {
  applicability: "project-specific",
  confidence: 0,
  rationale: "judge output carried no parseable PROMOTION_APPLICABILITY verdict — failing closed (stays at current layer)",
};

/**
 * Parse the promotion judge's `PROMOTION_APPLICABILITY`/`PROMOTION_CONFIDENCE`/
 * `PROMOTION_RATIONALE` lines into a {@link PromotionJudgeVerdict}. Missing or
 * unrecognized applicability fails closed ({@link FAIL_CLOSED_PROMOTION_VERDICT});
 * a missing/invalid confidence defaults to 0. Case-insensitive; tolerant of
 * surrounding prose (same tolerance as flight-judge.ts's `parseJudgeVerdict`).
 */
export function parsePromotionJudgeVerdict(text: string): PromotionJudgeVerdict {
  const applicabilityMatch = text.match(/PROMOTION_APPLICABILITY:\s*([\w-]+)/i);
  const confidenceMatch = text.match(/PROMOTION_CONFIDENCE:\s*([\d.]+)/i);
  const rationaleMatch = text.match(/PROMOTION_RATIONALE:\s*(.+)/i);

  const applicability = applicabilityMatch?.[1]?.toLowerCase();
  if (applicability !== "project-specific" && applicability !== "broadly-applicable") {
    return { ...FAIL_CLOSED_PROMOTION_VERDICT };
  }

  let confidence = confidenceMatch ? Number(confidenceMatch[1]) : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));

  return { applicability, confidence, rationale: rationaleMatch?.[1]?.trim() ?? "" };
}

/** Below this confidence, a `broadly-applicable` verdict still does NOT promote (fail-closed default). */
export const DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD = 0.7;

/**
 * The deterministic actor on a {@link PromotionJudgeVerdict} (Standing rule
 * 12 — judgment is advisory, the decision to act is a pure function of it).
 * Promotes iff the judge said `broadly-applicable` AND its confidence meets
 * `confidenceThreshold` — anything else (including a `project-specific`
 * call, a low-confidence `broadly-applicable` call, or the fail-closed
 * default) does not promote.
 */
export function planPromotionFromVerdict(
  verdict: PromotionJudgeVerdict,
  confidenceThreshold: number = DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD,
): boolean {
  return verdict.applicability === "broadly-applicable" && verdict.confidence >= confidenceThreshold;
}

/** The layer immediately above `layer` in {@link LAYERS}' bottom-up order, or `undefined` if `layer` is already the top (`global`). */
export function nextLayer(layer: Layer): Layer | undefined {
  const idx = LAYERS.indexOf(layer);
  if (idx === -1 || idx === LAYERS.length - 1) return undefined;
  return LAYERS[idx + 1];
}

/**
 * Redact repo-identifying SPECIFICS out of a provenance `src` string while
 * keeping its origin shape (P32/W1-T146: "provenance survives promotion in
 * REDACTED form" — the origin is kept, project-identifying specifics
 * scrubbed). Strips task ids (`W1-T146`), PR numbers, issue numbers, and any
 * other bare `#<digits>` reference; anything else in `src` (e.g. a
 * subsystem/team name) survives untouched.
 */
export function redactProvenance(src: string): string {
  return src
    .replace(/\bW\d+-T\d+[a-zA-Z]?\b/g, "[task]")
    .replace(/\bPR ?#\d+\b/gi, "PR#[redacted]")
    .replace(/\bissue ?#\d+\b/gi, "issue#[redacted]")
    .replace(/#\d+\b/g, "#[redacted]");
}

/** Dependencies {@link promoteEntry}/{@link runPromotionPass} need injected — mirrors flight-judge.ts's `FlightJudgeDeps.judge` so promotion is unit-testable without a real spawn. */
export interface PromotionJudgeDeps {
  /** The advisory LLM applicability eval. NEVER invoked when {@link scrubEntry} blocks (the scrub falsifier). */
  judge: (entry: LearningEntry) => Promise<PromotionJudgeVerdict>;
  /** Optional structured-event sink (same shape as flight-judge.ts's `deps.log`); no-op if omitted. */
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Overrides {@link DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD} for this call. */
  confidenceThreshold?: number;
}

/** Which stage {@link promoteEntry} stopped at. `"scrub"` and `"top-layer"` never reach the judge. */
export type PromotionStage = "scrub" | "top-layer" | "judge" | "promoted";

/** The full, auditable outcome of one {@link promoteEntry} call. */
export interface PromotionResult {
  entryId: string;
  promoted: boolean;
  stage: PromotionStage;
  scrub: ScrubResult;
  /** Set iff the judge was actually invoked (i.e. scrub passed and the entry was below the top layer). */
  verdict?: PromotionJudgeVerdict;
  /** Set iff `promoted`: the entry's next-layer shape, with `layer` bumped and `src` redacted. Not yet written to any home — see the module doc's transport note. */
  promotedEntry?: LearningEntry;
  reason: string;
}

/**
 * The PROMOTION PIPELINE for ONE entry (P32/W1-T146): SCRUB, then JUDGE,
 * strictly in that order and never the reverse.
 *
 * 1. {@link scrubEntry}. A block returns immediately with `stage: "scrub"` —
 *    `deps.judge` is NEVER called (assert zero judge invocations in a test
 *    fixture; that is the scrub falsifier).
 * 2. If `entry` is already at the top layer (`global`), there is nothing
 *    above it to promote to — returns `stage: "top-layer"` without invoking
 *    the judge either (a judge call would be meaningless with no target).
 * 3. Otherwise `deps.judge(entry)` runs and {@link planPromotionFromVerdict}
 *    decides. A non-promoting verdict (including the fail-closed default)
 *    returns `stage: "judge"`, `promoted: false` — the entry stays exactly
 *    where it was (the judge falsifier: a project-specific entry never
 *    appears at the next layer after a pass).
 * 4. A promoting verdict returns `stage: "promoted"` with `promotedEntry`:
 *    the SAME entry, `layer` set to the next layer up and `src` run through
 *    {@link redactProvenance}. `promoteEntry` does not mutate `entry` and
 *    does not write `promotedEntry` anywhere — persisting it to a real
 *    user-overall/global home is the deferred transport's job.
 */
export async function promoteEntry(entry: LearningEntry, deps: PromotionJudgeDeps): Promise<PromotionResult> {
  const log = deps.log ?? (() => {});
  const scrub = scrubEntry(entry);
  log("promotion.scrub", { id: entry.id, blocked: scrub.blocked, reasons: scrub.reasons });
  if (scrub.blocked) {
    return {
      entryId: entry.id,
      promoted: false,
      stage: "scrub",
      scrub,
      reason: `blocked at scrub (never reached the judge): ${scrub.reasons.join(", ")}`,
    };
  }

  const from = entryLayer(entry);
  const to = nextLayer(from);
  if (!to) {
    return {
      entryId: entry.id,
      promoted: false,
      stage: "top-layer",
      scrub,
      reason: `already at the top layer (${from}) — nothing above it to promote to`,
    };
  }

  const verdict = await deps.judge(entry);
  log("promotion.verdict", { id: entry.id, applicability: verdict.applicability, confidence: verdict.confidence });

  if (!planPromotionFromVerdict(verdict, deps.confidenceThreshold)) {
    return {
      entryId: entry.id,
      promoted: false,
      stage: "judge",
      scrub,
      verdict,
      reason: `judge did not promote: applicability=${verdict.applicability} confidence=${verdict.confidence}`,
    };
  }

  const promotedEntry: LearningEntry = { ...entry, layer: to, src: redactProvenance(entry.src) };
  log("promotion.promoted", { id: entry.id, from, to });
  return { entryId: entry.id, promoted: true, stage: "promoted", scrub, verdict, promotedEntry, reason: `promoted ${from} -> ${to}` };
}

/** The batched outcome of {@link runPromotionPass}: every entry's individual result, plus the flat list of new next-layer entries produced. */
export interface PromotionPassResult {
  results: PromotionResult[];
  promotedEntries: LearningEntry[];
}

/**
 * Run {@link promoteEntry} over a whole corpus (P32/W1-T146) — "a promotion
 * pass." `superseded`/`quarantined` entries are skipped (never promotion
 * candidates — same lifecycle filter {@link selectLearnings} applies before
 * injection; a decayed fact should not rise a layer either). Returns every
 * entry's individual {@link PromotionResult} plus the flat `promotedEntries`
 * list a caller would merge into the next layer's home — a project-specific
 * entry's result has `promoted: false` and contributes nothing to that list,
 * which is the shape the judge-falsifier test asserts against.
 */
export async function runPromotionPass(entries: LearningEntry[], deps: PromotionJudgeDeps): Promise<PromotionPassResult> {
  const results: PromotionResult[] = [];
  const promotedEntries: LearningEntry[] = [];
  for (const entry of entries) {
    if (entry.lifecycle !== "active") continue;
    const result = await promoteEntry(entry, deps);
    results.push(result);
    if (result.promoted && result.promotedEntry) promotedEntries.push(result.promotedEntry);
  }
  return { results, promotedEntries };
}

// ── PER-LAYER BUDGET RATCHET (P32/W1-T146, extends W1-T38) ─────────────────

/** Optional per-layer char caps for {@link evaluateLayerBudgetRatchet}; an omitted layer is uncapped. */
export type LayerBudgetCaps = Partial<Record<Layer, number>>;

/** One layer's measured active-corpus injectable weight, mirroring `computeActiveChars`' shape in scripts/learnings-budget-ratchet.mjs. */
export interface LayerBudgetUsage {
  layer: Layer;
  chars: number;
  activeCount: number;
}

/**
 * Measure each layer's injectable weight INDEPENDENTLY (P32/W1-T146):
 * same formula scripts/learnings-budget-ratchet.mjs's `computeActiveChars`
 * uses (rendered `- <fact> [src: learnings#<id>]` line length, +1 per entry
 * for the joining newline, `lifecycle: active` only — `superseded`/
 * `quarantined` entries carry zero weight because {@link selectLearnings}
 * never injects them) via {@link entryBudgetWeight}, but bucketed by {@link
 * entryLayer} instead of summed across the whole corpus. Always returns one
 * entry per {@link LAYERS}, in that order, even when a layer has zero
 * entries (`chars: 0`).
 */
export function computeLayerBudgetUsage(entries: LearningEntry[]): LayerBudgetUsage[] {
  const usage = new Map<Layer, LayerBudgetUsage>(LAYERS.map((layer) => [layer, { layer, chars: 0, activeCount: 0 }]));
  for (const entry of entries) {
    if (entry.lifecycle !== "active") continue;
    const u = usage.get(entryLayer(entry));
    if (!u) continue;
    u.chars += entryBudgetWeight(entry) + 1;
    u.activeCount += 1;
  }
  return LAYERS.map((layer) => usage.get(layer) as LayerBudgetUsage);
}

/**
 * The per-layer ratchet check (P32/W1-T146, extends learnings-budget-ratchet
 * W1-T38 from a single global ceiling to one INDEPENDENT cap per layer): a
 * layer whose measured {@link computeLayerBudgetUsage} exceeds its `caps`
 * entry is a violation, named in the returned string; a layer with no cap
 * set is never a violation. Exceeding ONE layer's cap does not affect
 * another layer's evaluation — each is judged solely against its own cap,
 * same as the acceptance bar names ("exceeding one layer's cap fails the
 * ratchet"). Empty array means every capped layer is at or under budget.
 */
export function evaluateLayerBudgetRatchet(entries: LearningEntry[], caps: LayerBudgetCaps): string[] {
  const violations: string[] = [];
  for (const usage of computeLayerBudgetUsage(entries)) {
    const cap = caps[usage.layer];
    if (typeof cap === "number" && usage.chars > cap) {
      violations.push(`${usage.layer} layer active corpus ${usage.chars} chars > cap ${cap} chars`);
    }
  }
  return violations;
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
 * Ordering (highest first): concrete match count → LAYER PRECEDENCE
 * (project → user-overall → global, P32/W1-T145 — the most repo-specific
 * fact wins a tie before recency does) → most-recently-cited → id. Then fill
 * up to `budgetChars` of rendered fact lines; the remainder is `dropped`
 * (returned for logging), so the injected corpus is bounded. Every entry
 * pre-W1-T145 has no `layer` set, which defaults to `"project"` — so the
 * layer tiebreak is a no-op for the pre-existing project-only corpus and
 * only distinguishes entries once a user-overall/global layer is actually
 * populated.
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
      const layerDiff = LAYERS.indexOf(entryLayer(a.entry)) - LAYERS.indexOf(entryLayer(b.entry));
      if (layerDiff !== 0) return layerDiff;
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
    const cost = entryBudgetWeight(entry) + 1; // +1 for the joining "\n"
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
