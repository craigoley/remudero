import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { citation } from "./provenance.js";

/**
 * Promptsmith: the read side of the compounding thesis (WS-8, W1-T19, W1-T33). It injects the two
 * doctrine lines and the file-matched `learnings/*.yaml` facts into every rendered implement
 * prompt. Matching is deterministic by an entry's `files:` globs, never semantic; a knowledge
 * budget caps the injected chars, so a growing corpus can never become an unbounded context tax;
 * and every injected line carries `[src: learnings#<id>]`, so the prompt still passes the
 * provenance linter (Standing rule 1). The corpus is sharded by subsystem and read through a
 * generated index, so a task parses only the shards its files could match. `LEARNINGS.md` stays
 * the human-owned narrative, read back only by `retroCommand` (src/run-task.ts), not parsed here.
 * INVARIANT: an entry whose lifecycle is not `active` is never injected. See {@link Lifecycle}.
 * INVARIANT: one entry shape and one validator serve every layer. See {@link Layer}.
 * FALSIFIER: test/learnings-{commons,layers,promotion}.test.ts.
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

// Why: 8148 is a measured derivation, not a picked number — docs/forensics/learnings.md#default_knowledge_budget_chars (W1-T941).
/**
 * Default knowledge budget: the max chars of matched fact lines injected per prompt. The doctrine
 * lines above are mandatory and are not counted against it.
 * INVARIANT: this equals scripts/knowledge-budget-baseline.json's `capChars` — raise it there.
 * FALSIFIER: test/knowledge-budget-derivation.test.ts's drift test.
 */
export const DEFAULT_KNOWLEDGE_BUDGET_CHARS = 8148;

// Why: contradiction detection narrows recency-overwrite rather than replacing it — docs/forensics/learnings.md#lifecycle (W1-T88/P14).
/**
 * An entry's lifecycle. `active` (the default) is a candidate for injection. `superseded` means a
 * human correction replaced the fact; `quarantined` means its `assertion` now fails, so
 * `learnings-assert-check.mjs` flipped it (W1-T34); `contested` means the consolidation pass found
 * it opposing another active entry (W1-T88). Non-active entries stay in their shard for the record.
 * INVARIANT: {@link selectLearnings} filters all three out before ranking, so none reaches a prompt.
 */
export type Lifecycle = "active" | "superseded" | "quarantined" | "contested";

// Why: the three-layer design and its promotion order — docs/forensics/learnings.md#layer (P32/W1-T145).
/**
 * Which knowledge layer an entry lives at: `project` (repo-scoped, the default), `user-overall`
 * (one operator's fleet), or `global` (cross-user, opt-in, hash-pinned). Layer says where an entry
 * is read from, not whether it is injectable — that is {@link Lifecycle}'s job.
 */
export type Layer = "project" | "user-overall" | "global";

/** Every valid {@link Layer}, in promotion order (bottom-up: project -> user-overall -> global). */
export const LAYERS: readonly Layer[] = ["project", "user-overall", "global"];

/**
 * The only valid non-absent value of an entry's `share` field (§6, W1-T425). There is no
 * `"private"` counterpart: omitting the field already means private, so a second spelling of the
 * same state would only be another way to get it wrong.
 */
export type Share = "public";

/** One durable, provenance-tagged fact, tagged for deterministic matching. */
export interface LearningEntry {
  /** Stable slug used in the injected citation `[src: learnings#<id>]`. */
  id: string;
  /** Human-facing grouping (e.g. `containment`, `ci`); advisory, not matched. */
  subsystem: string;
  /** `active` | `superseded` | `quarantined` | `contested` (default `active`). See {@link Lifecycle}. */
  lifecycle: Lifecycle;
  /** (superseded entries only) the id of the entry that replaced this one. */
  supersededBy?: string;
  /** (contested only, W1-T88/P14) the id of the other entry this one opposes. Set on BOTH members
   *  of a pair, so a reader of either finds its counterpart. */
  contestedWith?: string;
  /** (W1-T34) Optional `sh -c` command that must exit 0 for this `fact` to still be true. Run by
   *  `scripts/learnings-assert-check.mjs`, never by this module. */
  assertion?: string;
  /** (quarantined only, W1-T34) the failing assertion and its exit code, so a reader sees why
   *  `learnings-assert-check.mjs` quarantined the entry without re-running it. */
  quarantinedReason?: string;
  /** (W1-T50) Marks a `failures` incident whose symptom is operator-visible; defaults to `false`.
   *  `true` obligates a matching `docs/troubleshooting.md` entry, which
   *  `checkTroubleshootingCoverage` (src/lib/review.ts) enforces from the diff alone. */
  operatorImpact?: boolean;
  /** (W1-T939) Marks a `failures` incident whose guard belongs in a `scripts/recovery-drill.mjs`
   *  fixture (`RECOVERY_PATHS`, W1-T366/W1-T938): {@link operatorImpact}'s sibling, one level
   *  narrower. Defaults to `false`. `true` obligates a drill-table touch in the same diff, which
   *  `checkDrillCoverage` (src/lib/review.ts) enforces from the diff alone. */
  drillObligating?: boolean;
  /** (P32/W1-T145) Defaults to `"project"`, so a shard entry written before this field existed
   *  needs no edit. Read it through {@link entryLayer}, never as this raw field. */
  layer?: Layer;
  /** (§6, W1-T425) The transport opt-in: `share: public` makes this entry exportable via
   *  `rmd learnings export`. Omitting it means private forever, and {@link selectExportableEntries}
   *  never includes an entry the exporter merely guesses is safe. */
  share?: Share;
  /** Repo-relative globs; an entry matches a task iff one glob hits a task file. */
  files: string[];
  /** The fact itself — one line, the thing a worker inherits. */
  fact: string;
  /** Provenance of the fact (e.g. `PR#8`); recorded lineage, not the injected src. */
  src: string;
  /** Optional ISO date last cited; recent entries win a budget tie. W1-T419's retro.ts miner
   *  derives it from measured evidence: a `learnings.injected` ledger row, or a `learnings#<id>`
   *  git-log citation. */
  cited?: string;
  /** (W1-T419) Optional count of the evidence backing {@link cited}. Absent means nothing mined
   *  yet, which the budget ratchet renders `never-cited`, never zero. {@link selectLearnings} does
   *  not read it; the ratchet's compression ordering does. */
  citedCount?: number;
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
 * Parse one already-loaded YAML document into validated {@link LearningEntry} records. `seen` is
 * shared across files for cross-shard duplicate-id detection, or fresh for one file;
 * `sourceLabel` only points error messages at the right file.
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
      if (
        e.lifecycle !== "active" &&
        e.lifecycle !== "superseded" &&
        e.lifecycle !== "quarantined" &&
        e.lifecycle !== "contested"
      ) {
        throw new LearningsError(
          `learnings '${id}': 'lifecycle' must be 'active', 'superseded', 'quarantined', or 'contested', got ${JSON.stringify(e.lifecycle)} (${sourceLabel}).`,
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
    const contestedWith = typeof e.contested_with === "string" && e.contested_with.length > 0 ? e.contested_with : undefined;
    if (contestedWith !== undefined && lifecycle !== "contested") {
      throw new LearningsError(
        `learnings '${id}': 'contested_with' is set but 'lifecycle' is not 'contested' (${sourceLabel}).`,
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
    if (e.drill_obligating !== undefined && typeof e.drill_obligating !== "boolean") {
      throw new LearningsError(`learnings '${id}': 'drill_obligating' must be a boolean (${sourceLabel}).`);
    }
    const drillObligating = e.drill_obligating === true;
    let layer: Layer | undefined;
    if (e.layer !== undefined) {
      if (e.layer !== "project" && e.layer !== "user-overall" && e.layer !== "global") {
        throw new LearningsError(
          `learnings '${id}': 'layer' must be 'project', 'user-overall', or 'global', got ${JSON.stringify(e.layer)} (${sourceLabel}).`,
        );
      }
      layer = e.layer;
    }
    if (e.cited_count !== undefined && (typeof e.cited_count !== "number" || !Number.isFinite(e.cited_count))) {
      throw new LearningsError(`learnings '${id}': 'cited_count' must be a number (${sourceLabel}).`);
    }
    const citedCount = typeof e.cited_count === "number" ? e.cited_count : undefined;
    // The `share: public` opt-in (§6, W1-T425). Any other non-absent value is a usage error: a
    // typo must fail loud, never fail open into "I guess this one's fine to omit from a bundle."
    let share: Share | undefined;
    if (e.share !== undefined) {
      if (e.share !== "public") {
        throw new LearningsError(
          `learnings '${id}': 'share' must be "public" when set (omit the field entirely to keep an entry private), got ${JSON.stringify(e.share)} (${sourceLabel}).`,
        );
      }
      share = e.share;
    }
    return {
      id,
      subsystem: typeof e.subsystem === "string" ? e.subsystem : "",
      lifecycle,
      supersededBy,
      contestedWith,
      assertion,
      quarantinedReason,
      operatorImpact,
      drillObligating,
      layer,
      share,
      files: e.files as string[],
      fact: e.fact,
      src: e.src,
      cited: typeof e.cited === "string" ? e.cited : undefined,
      citedCount,
    };
  });
}

/** Read an entry's {@link Layer}, applying the `"project"` default when `layer` is omitted. */
export function entryLayer(entry: LearningEntry): Layer {
  return entry.layer ?? "project";
}

/** The project layer's home (P32/W1-T145): the repo-relative `learnings` directory. Named so it,
 *  `userOverallLearningsHome` and `globalLearningsHome` (config.ts) read as one symmetric set. */
export function projectLearningsHome(repoRoot: string): string {
  return join(repoRoot, "learnings");
}

/** The five subsystem shards this repo's corpus is split into (W1-T33). `rmd onboard --phase
 *  synthesize` (W1-T2505) seeds an onboarded repo with the SAME split, so {@link
 *  loadLearningsCorpus} and {@link loadLearningsIndex} work there unchanged. */
export const PROJECT_LEARNINGS_SHARD_NAMES = ["architecture", "ci", "failures", "platform", "testing"] as const;

/** One seeded shard file's content: an empty entry list plus a header explaining WHY it is
 *  empty (W1-T2505's whole design point — see {@link seedProjectLearningsHomeFiles}). */
function seedShardFileContent(name: string): string {
  return (
    [
      `# learnings/${name}.yaml — seeded by \`rmd onboard --phase synthesize\` (W1-T2505).`,
      "#",
      "# One of the five subsystem shards this repo's own corpus is split into (W1-T33 SPLIT):",
      `# learnings/{${PROJECT_LEARNINGS_SHARD_NAMES.join(",")}}.yaml. Onboarding seeds the SAME`,
      "# split rather than inventing a new one, so loadLearningsCorpus/loadLearningsIndex (see",
      "# this file's own header, src/lib/learnings.ts) work unchanged against this repo too.",
      "#",
      "# EMPTY ON PURPOSE: onboarding seeds a HOME for facts, never a fact itself. A learnings",
      "# entry carries provenance (a `src` plus a citation date) -- inventing one here would",
      "# manufacture provenance for something nobody in this repo has established yet. The first",
      "# entry any shard here ever carries is the first real learning about this repo.",
      "",
      "[]",
      "",
    ].join("\n")
  );
}

// Why: onboarding seeds a home for facts, never a fact — docs/forensics/learnings.md#seedprojectlearningshomefiles (W1-T2505).
/**
 * The seeded project learnings home's files (W1-T2505), keyed by filename relative to the home:
 * five empty shards ({@link PROJECT_LEARNINGS_SHARD_NAMES}) plus a matching `index.json`.
 * INVARIANT: that `index.json` is exactly what `scripts/generate-learnings-index.mjs` would produce
 * from five empty shards, reproduced here because onboarding writes through an injected fs seam.
 */
export function seedProjectLearningsHomeFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of PROJECT_LEARNINGS_SHARD_NAMES) {
    files[`${name}.yaml`] = seedShardFileContent(name);
  }
  const indexFiles: Record<string, { entries: string[]; globs: string[] }> = {};
  for (const name of PROJECT_LEARNINGS_SHARD_NAMES) {
    indexFiles[`${name}.yaml`] = { entries: [], globs: [] };
  }
  const index: LearningsIndex = { files: indexFiles, bySubsystem: {} };
  files["index.json"] = `${JSON.stringify(index, null, 2)}\n`;
  return files;
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
 * Parse every `*.yaml` shard in `dir`, sorted by filename for determinism, into one merged corpus
 * (W1-T33). A missing directory returns `[]`, the same convention as {@link loadLearnings}.
 * INVARIANT: ids are unique across every shard, not only within one. The result is the full
 * corpus; {@link selectLearnings} filters non-active entries out itself.
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

/** The per-entry char weight budget accounting counts: the rendered injectable line's length
 *  (P32/W1-T145). The ONE definition every layer and caller measures against. */
export function entryBudgetWeight(entry: LearningEntry): number {
  return renderLearningLine(entry).length;
}

/** id -> {@link entryBudgetWeight} plus 1 for the joining newline (W1-T941). A `learnings.injected`
 *  ledger row carries dropped ids but never their weight; this is the lookup digest.ts's
 *  `measureKnowledgeBudgetPressure` joins them against without importing the corpus loaders. */
export function buildEntryWeightIndex(entries: LearningEntry[]): Record<string, number> {
  const index: Record<string, number> = {};
  for (const entry of entries) {
    index[entry.id] = entryBudgetWeight(entry) + 1;
  }
  return index;
}

/**
 * The rmd-global layer's artifact (P32/W1-T145): a versioned, content-addressed bundle of
 * {@link LearningEntry} records. INVARIANT: {@link computeArtifactHash} over `entries` must equal
 * `hash`, or {@link loadGlobalArtifact} refuses the artifact as a forgery or a corruption.
 */
export interface GlobalArtifact {
  /** Human-facing artifact version (e.g. a date or semver-ish tag); advisory. */
  version: string;
  /** sha256 hex digest of `entries`, per {@link computeArtifactHash}. */
  hash: string;
  entries: LearningEntry[];
}

/**
 * Deterministic sha256 content hash of a set of layered-learnings entries (P32/W1-T145).
 * INVARIANT: entries sort by `id` first, so order never changes the hash, and `undefined` optionals
 * normalize to `null`, so an omitted field hashes alike whichever path built it.
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
      share: e.share ?? null,
      files: e.files,
      fact: e.fact,
      src: e.src,
      cited: e.cited ?? null,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The reason prefix {@link loadGlobalArtifact} emits for a missing artifact (W1-T1251). Exported
 *  so a caller classifies by the SAME literal this module returns, not a second driftable regex.
 *  Matched with `startsWith`, so a short test fixture and the real path-suffixed message agree. */
export const GLOBAL_ARTIFACT_ABSENT_REASON_PREFIX = "global artifact not found";

/**
 * `"absent"` is the artifact not existing yet: the one designed, non-fatal state (W1-T1251).
 * `"refused"` is every other {@link loadGlobalArtifact} failure — invalid YAML, not a mapping, a
 * missing `version` or `hash`, a malformed entry, a hash mismatch — a real problem, not an absence.
 */
export type GlobalArtifactRefusalKind = "absent" | "refused";

/**
 * Classify a `loadGlobalArtifact` refusal reason: the ONE discriminant every consumer reads.
 * INVARIANT: `"absent"` iff the reason starts with {@link GLOBAL_ARTIFACT_ABSENT_REASON_PREFIX}.
 * Every other reason, an unrecognized future one included, classifies `"refused"`, so a new failure
 * reads as a problem rather than vanishing into the deferred-transport line.
 */
export function classifyGlobalArtifactRefusal(reason: string): GlobalArtifactRefusalKind {
  return reason.startsWith(GLOBAL_ARTIFACT_ABSENT_REASON_PREFIX) ? "absent" : "refused";
}

/** The result of loading + verifying a {@link GlobalArtifact}. */
export type GlobalArtifactResult =
  | { ok: true; artifact: GlobalArtifact; entries: LearningEntry[] }
  | { ok: false; reason: string; kind: GlobalArtifactRefusalKind };

/** Build a `{ ok: false }` {@link GlobalArtifactResult}, deriving `kind` from `reason` via {@link
 *  classifyGlobalArtifactRefusal} — ONE call site computes both, so they can never disagree. */
function refused(reason: string): GlobalArtifactResult {
  return { ok: false, reason, kind: classifyGlobalArtifactRefusal(reason) };
}

// Why: the seven failure reasons, and why only absence is designed — docs/forensics/learnings.md#loadglobalartifact (P32/W1-T145, W1-T1251).
/**
 * Load and verify the rmd-global artifact at `path` (P32/W1-T145).
 * INVARIANT: `entries` parses through the same {@link parseLearningsDoc} every other layer uses, so
 * a malformed global entry is rejected exactly like a project one.
 * INVARIANT: a hash mismatch refuses the artifact and contributes zero entries, never silently
 * trusting it. A missing file refuses the same way but carries `kind: "absent"`: a designed absence
 * is not the same claim as a tampered artifact.
 */
export function loadGlobalArtifact(path: string): GlobalArtifactResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return refused(`${GLOBAL_ARTIFACT_ABSENT_REASON_PREFIX}: ${path}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return refused(`global artifact is not valid YAML (${path}): ${String(err)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refused(`global artifact must be a mapping with 'version', 'hash', 'entries' (${path})`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== "string" || r.version.length === 0) {
    return refused(`global artifact missing string 'version' (${path})`);
  }
  if (typeof r.hash !== "string" || r.hash.length === 0) {
    return refused(`global artifact missing string 'hash' (${path})`);
  }
  let entries: LearningEntry[];
  try {
    entries = parseLearningsDoc(r.entries, path, new Set());
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
  const actualHash = computeArtifactHash(entries);
  if (actualHash !== r.hash) {
    return refused(`global artifact hash mismatch (${path}): pinned ${r.hash}, computed ${actualHash} — refused, not trusted`);
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
 * Read all three P32 layers into one merged corpus, in precedence order: project, user-overall,
 * global. Precedence fixes the merge order only; {@link selectLearnings} still ranks on top, and a
 * missing project or user-overall directory is non-fatal.
 * INVARIANT: a global artifact failing verification contributes zero entries, its reason surfacing
 * as `globalRefusedReason` — excluded, never silently trusted (the W1-T145 falsifier).
 */
export function loadLayeredLearnings(homes: LayeredLearningsHomes): LayeredLearningsResult {
  return mergeLayers(loadLearningsCorpus(homes.projectDir), homes);
}

/**
 * The prompt-assembly entry point (P32/W1-T145): {@link loadLayeredLearnings}, except the project
 * layer is read through the index-based {@link loadLearningsForTaskFiles} lookup (W1-T33), so
 * layering never regresses that layer's lookup-not-scan cost. `run-task.ts` calls this.
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

/** Leak-grep analog: deterministic secret-shaped patterns. Deliberately conservative — specific
 *  token shapes, not "any long string" — so the bar is "a deliberately secret-bearing entry is
 *  blocked", not "every entry with a long word is". */
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
 * The scrub gate (P32/W1-T146, stage 1 of {@link promoteEntry}): the leak-grep analog plus a PII
 * detector over every free-text field. Pure and synchronous, so a caller runs it before paying for
 * a judge invocation. INVARIANT: `blocked: true` stops promotion here, and {@link promoteEntry}
 * never calls the judge.
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

/** Build the promotion judge's prompt for ONE entry (P32/W1-T146), mirroring flight-judge.ts's
 *  `buildJudgePrompt`. INVARIANT: the judge sees only this entry's fields, never a sibling or the
 *  corpus it would join, so its verdict is about this fact's own shape and is not comparative. */
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

/** Fail-closed default when the judge's output carries no parseable verdict, the same doctrine as
 *  flight-judge.ts's `FAIL_CLOSED_VERDICT`. `project-specific` at confidence 0 can never satisfy
 *  {@link planPromotionFromVerdict}: an unreadable judge is evidence the entry should not move. */
const FAIL_CLOSED_PROMOTION_VERDICT: PromotionJudgeVerdict = {
  applicability: "project-specific",
  confidence: 0,
  rationale: "judge output carried no parseable PROMOTION_APPLICABILITY verdict — failing closed (stays at current layer)",
};

/** Parse the judge's `PROMOTION_APPLICABILITY`, `PROMOTION_CONFIDENCE` and `PROMOTION_RATIONALE`
 *  lines. Missing or unrecognized applicability fails closed ({@link
 *  FAIL_CLOSED_PROMOTION_VERDICT}); missing or invalid confidence defaults to 0. Case-insensitive
 *  and tolerant of surrounding prose, like flight-judge.ts's `parseJudgeVerdict`. */
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

/** The deterministic actor on a {@link PromotionJudgeVerdict} (Standing rule 12: judgment is
 *  advisory, acting on it is a pure function). INVARIANT: promotes iff the judge said
 *  `broadly-applicable` AND confidence meets `confidenceThreshold`; the fail-closed default and
 *  every other outcome do not promote. */
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

/** Redact repo-identifying specifics out of a provenance `src` while keeping its origin shape
 *  (P32/W1-T146: provenance survives promotion redacted, never dropped). Strips task ids, PR and
 *  issue numbers, and any other bare `#<digits>`; the rest of `src` survives untouched. */
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

// Why: scrub runs before the judge so nothing project-identifying reaches an LLM call — docs/forensics/learnings.md#promoteentry (P32/W1-T146).
/**
 * The promotion pipeline for ONE entry (P32/W1-T146): scrub, then judge, in that order only. It
 * mutates nothing and writes nothing to any home.
 * 1. {@link scrubEntry}. A block returns `stage: "scrub"` and the judge is never called; the
 *    scrub falsifier asserts zero judge invocations.
 * 2. An entry already at the top layer returns `stage: "top-layer"`, also without a judge call.
 * 3. Otherwise the judge runs and {@link planPromotionFromVerdict} decides; a non-promoting
 *    verdict returns `stage: "judge"` and the entry stays put, which is the judge falsifier.
 * 4. A promoting verdict returns `promotedEntry`: the entry with layer bumped, `src` redacted.
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

/** Run {@link promoteEntry} over a whole corpus (P32/W1-T146): a promotion pass. Returns each
 *  entry's {@link PromotionResult} plus the flat `promotedEntries` a caller merges into the next
 *  layer's home. INVARIANT: a non-active entry is skipped, so a decayed fact never rises a layer. */
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

// ── TRANSPORT: EXPORT/IMPORT (§6, W1-T425) ──────────────────────────────────
//
// Two verbs riding machinery that already exists: loadGlobalArtifact's hash-pin verification and
// scrubEntry's leak-grep analog both predate this section, which builds only the bundle between
// them and never a second copy of either guard.

/** Provenance stamped onto an exported bundle (§6, W1-T425): where it came from and when — informational, never hashed (only `entries` is; see {@link computeArtifactHash}). */
export interface ExportProvenance {
  /** e.g. `owner/repo` of the exporting checkout. */
  sourceRepo: string;
  /** The exporting checkout's HEAD sha at export time. */
  sourceSha: string;
  /** ISO timestamp of the export. */
  exportedAt: string;
}

/** A bundle produced by `rmd learnings export`: the exact {@link GlobalArtifact} shape
 *  {@link loadGlobalArtifact} already parses and hash-verifies, plus a `provenance` block. That
 *  loader ignores unknown top-level keys, so the bundle round-trips through it unchanged. */
export interface ExportBundle extends GlobalArtifact {
  provenance: ExportProvenance;
}

/** The exportable subset of a corpus (§6, W1-T425). INVARIANT: only ACTIVE entries carrying the
 *  explicit `share: "public"` opt-in are included — a pure filter over the declared field, never a
 *  guess about what looks safe. */
export function selectExportableEntries(entries: LearningEntry[]): LearningEntry[] {
  return entries.filter((e) => e.lifecycle === "active" && e.share === "public");
}

/** The outcome of one {@link buildExportBundle} call — a refusal always NAMES why (and, for a tripwire hit, which entry), never a silent empty bundle. */
export type ExportResult =
  | { ok: true; bundle: ExportBundle }
  | { ok: false; reason: string; blockedEntryId?: string };

// Why: field-level opt-in, with scrub as an independent floor beneath it — docs/forensics/learnings.md#buildexportbundle (§6, W1-T425).
/**
 * Build an exportable bundle from a loaded corpus (§6, W1-T425). Two refusals, both before anything
 * is produced: zero entries carry `share: public` (never an empty-but-valid bundle), or a candidate
 * matches {@link scrubEntry}'s patterns (refused by entry id, so a mis-declared one cannot leave).
 */
export function buildExportBundle(
  entries: LearningEntry[],
  provenance: ExportProvenance,
  version: string = provenance.exportedAt,
): ExportResult {
  const candidates = selectExportableEntries(entries);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        "zero entries carry `share: public` — nothing exported. An entry without the explicit opt-in never leaves " +
        "the tree; stamp `share: public` on the entries you intend to share, then export again.",
    };
  }
  for (const entry of candidates) {
    const scrub = scrubEntry(entry);
    if (scrub.blocked) {
      return {
        ok: false,
        reason:
          `export aborted: entry '${entry.id}' matched the leak-grep tripwire (${scrub.reasons.join(", ")}) — ` +
          `no bundle was written. This is the independent floor beneath the \`share: public\` declaration.`,
        blockedEntryId: entry.id,
      };
    }
  }
  return { ok: true, bundle: { version, hash: computeArtifactHash(candidates), entries: candidates, provenance } };
}

/** Render an {@link ExportBundle} to YAML — the same shard shape {@link loadGlobalArtifact} parses back, plus the provenance block. */
export function renderExportBundle(bundle: ExportBundle): string {
  return stringifyYaml(bundle);
}

/** The outcome of one {@link verifyBundlePin} call. */
export type BundlePinResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify a bundle's own declared `hash` against an operator-supplied pin (§6, W1-T425): the check
 * `rmd learnings import` runs before writing to the global home, catching a wrong or substituted
 * file before it reaches disk.
 * INVARIANT: this never recomputes the hash from `entries`. That re-derivation is
 * {@link loadGlobalArtifact}'s job at prompt-assembly time, so import gates only whether the file
 * is written, never reimplementing the tamper check.
 */
export function verifyBundlePin(bundleText: string, pin: string): BundlePinResult {
  let raw: unknown;
  try {
    raw = parseYaml(bundleText);
  } catch (err) {
    return { ok: false, reason: `bundle is not valid YAML: ${String(err)}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "bundle must be a mapping with 'version', 'hash', 'entries' — refused, not written" };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.hash !== "string" || r.hash.length === 0) {
    return { ok: false, reason: "bundle missing string 'hash' — cannot pin, refused, not written" };
  }
  if (r.hash !== pin) {
    return {
      ok: false,
      reason: `pin mismatch: bundle declares hash ${r.hash}, operator pinned ${pin} — refused, not written`,
    };
  }
  return { ok: true };
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
 * Measure each layer's injectable weight independently (P32/W1-T146). INVARIANT: the same formula
 * scripts/learnings-budget-ratchet.mjs's `computeActiveChars` uses — rendered line length, plus 1
 * per entry for the joining newline, active entries only — bucketed by {@link entryLayer}. Always
 * one row per {@link LAYERS}, even for a layer with zero entries.
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

/** The per-layer ratchet check (P32/W1-T146), extending learnings-budget-ratchet (W1-T38) from one
 *  global ceiling to an independent cap per layer. INVARIANT: each layer is judged solely against
 *  its own cap, so exceeding one does not affect another; an uncapped layer is never a violation. */
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

/** A generated lookup index (W1-T33): per shard filename, the entry ids it carries and the union
 *  of `files:` globs those entries use, plus a `subsystem -> shard filename(s)` map. FALSIFIER:
 *  `npm run learnings-index:check` fails on an index that a fresh generate run would not produce. */
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

/** Pure lookup: which shard filenames in `index` could hold an entry matching `taskFiles`? Empty
 *  or absent `taskFiles` is repo-wide and candidates every shard, since the budget still bounds
 *  the tax. INVARIANT: this never parses or loads a shard's entries; it tests recorded globs. */
export function candidateShardFiles(index: LearningsIndex, taskFiles: string[] | undefined): string[] {
  const filenames = Object.keys(index.files).sort();
  const files = taskFiles ?? [];
  if (files.length === 0) return filenames; // repo-wide: every shard is a candidate
  return filenames.filter((filename) => {
    const globs = index.files[filename].globs.map(globToRegExp);
    return files.some((f) => globs.some((g) => g.test(f)));
  });
}

/** The Promptsmith entry point (W1-T33): load only the shards `taskFiles` could match, using
 *  `learnings/index.json` for the lookup. INVARIANT: correctness never depends on the index
 *  existing — a missing one falls back to a full {@link loadLearningsCorpus} scan and loses only
 *  the lookup-versus-scan win. */
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
 * Select the learnings to inject for a task, deterministically.
 * INVARIANT: the lifecycle filter runs FIRST, so a non-active entry leaves candidacy before
 * matching. Excluded, not de-prioritized: no budget pressure or tie-break lets it slip (W1-T33).
 * A candidate is an entry one of whose globs matches a task file; empty or absent `taskFiles` is
 * repo-wide. Ordering, highest first: match count, layer precedence (P32/W1-T145),
 * most-recently-cited, id. Then fill to `budgetChars`; the remainder is `dropped` for logging.
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

/** Render only the two mandatory doctrine lines (Tier 0, MASTER-PLAN §8A); always non-empty.
 *  INVARIANT: this is the STABLE prefix of the cache-aware assembly rule (W1-T35) and must change
 *  rarely, since an edit busts the prompt cache for every worker rendered after it. Callers place
 *  it first, ahead of anything volatile. */
export function renderDoctrinePreamble(): string {
  return [
    `- ${DISTRUST_RULE} ${citation(DISTRUST_SRC)}`,
    `- ${AUTONOMY_CLAUSE} ${citation(AUTONOMY_SRC)}`,
  ].join("\n");
}

/** Render only the task-matched facts (Tier 1, W1-T19/W1-T33), with no doctrine lines. VOLATILE:
 *  the corpus grows every retro, so callers place this LAST in a rendered prompt (cache-aware
 *  ordering, W1-T35), never ahead of {@link renderDoctrinePreamble}. "" when nothing matched. */
export function renderMatchedLearnings(selected: LearningEntry[]): string {
  return selected.map(renderLearningLine).join("\n");
}

/**
 * Render the learnings half of a prompt's context block: the doctrine lines, then the pre-selected
 * matched facts. Every line is cited, so the block passes the provenance linter, and the result is
 * always non-empty. `renderImplementPrompt` (run-task.ts) does NOT use this: it keeps the pieces
 * apart so it can place the stable preamble first and the volatile facts last (W1-T35).
 */
export function renderLearningsContext(selected: LearningEntry[]): string {
  return [renderDoctrinePreamble(), renderMatchedLearnings(selected)].filter((s) => s.length > 0).join("\n");
}

/**
 * Progressive disclosure for a headline-and-body rule corpus (W1-T2508). CLAUDE.md's bullets are
 * already written `- **HEADLINE** body`, an agent-skill-shaped split nobody had to invent, only
 * honour. Nothing here is wired into {@link renderLearningsContext} or `run-task.ts`: it proves
 * the retrieval path is safe before any body is withheld.
 */

/** One parsed rule bullet. INVARIANT: the headline wrapped in `**` markers, followed by `body`,
 *  reproduces the source bullet byte for byte, so splitting a rule never alters its text
 *  (W1-T2508 acceptance). */
export interface RuleHeadline {
  /** The bolded headline text, with the `**` markers already stripped. May itself span
   *  multiple source lines (CLAUDE.md wraps a long headline before closing `**`). */
  headline: string;
  /** Everything after the closing `**`, verbatim — the retrievable "material needed to do
   *  it" an agent-skill description defers until activation. */
  body: string;
}

export const RULE_BULLET_START_RE = /^- \*\*/;
export const RULE_HEADLINE_RE = /^- \*\*([\s\S]+?)\*\*/;

/**
 * Split `markdown` into top-level `- **HEADLINE** body` bullets. A bullet runs from one line
 * matching `^- \*\*` up to the next such line or a `#` heading, so a body may hold blank lines,
 * sub-bullets or a table without truncating early. INVARIANT: a bullet that opens but never closes
 * its `**` is refused loudly — a silent wrong split is worse than none.
 */
export function parseRuleHeadlines(markdown: string): RuleHeadline[] {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (RULE_BULLET_START_RE.test(line)) {
      if (current) blocks.push(current.join("\n"));
      current = [line];
    } else if (/^#/.test(line)) {
      if (current) {
        blocks.push(current.join("\n"));
        current = null;
      }
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join("\n"));

  return blocks.map((raw) => {
    const m = RULE_HEADLINE_RE.exec(raw);
    if (!m) {
      throw new LearningsError(`parseRuleHeadlines: bullet opens "**" but never closes it: ${raw.slice(0, 80)}…`);
    }
    return { headline: m[1], body: raw.slice(m[0].length) };
  });
}

/** Index every rule by its headline. INVARIANT: a headline mapping to two different bodies is
 *  refused loudly rather than letting the second silently win — "every headline resolves to
 *  exactly one body" is an acceptance criterion, not an assumption. */
export function buildHeadlineIndex(rules: RuleHeadline[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const rule of rules) {
    const existing = index.get(rule.headline);
    if (existing !== undefined && existing !== rule.body) {
      throw new LearningsError(`buildHeadlineIndex: headline "${rule.headline}" resolves to two different bodies`);
    }
    index.set(rule.headline, rule.body);
  }
  return index;
}

/** The always-on half: headlines only, never a body, which is what an agent-skill description is.
 *  One bolded headline per line, in the corpus's own order; about 15% of CLAUDE.md's own bulk by
 *  the rationale's measurement. */
export function renderHeadlineOnlyIndex(rules: RuleHeadline[]): string {
  return rules.map((r) => `- **${r.headline}**`).join("\n");
}

/** Look up one rule's body by its headline. `undefined` means "not retrievable" — callers that
 *  must never go silent on that use {@link retrieveRuleBodyOrDegrade}, never this directly. */
export function retrieveRuleBody(index: Map<string, string>, headline: string): string | undefined {
  return index.get(headline);
}

/** Resolve one rule's body on demand through the injected `retrieve`. INVARIANT: a failed
 *  retrieval degrades to the FULL rule (`- **headline**body`), never to `""` and never a throw.
 *  W1-T2508's rationale names the hazard: a headline whose body cannot be fetched leaves the
 *  reader knowing a rule exists, unable to read it, and proceeding anyway. */
export function retrieveRuleBodyOrDegrade(
  rule: RuleHeadline,
  retrieve: (headline: string) => string | undefined,
): string {
  const body = retrieve(rule.headline);
  if (body !== undefined) return body;
  return `- **${rule.headline}**${rule.body}`;
}

/** The wider context-block shape this mechanism assembles into, mirroring
 *  {@link renderLearningsContext}'s stable-then-volatile ordering (W1-T35): the headline index is
 *  stable and sits first, `retrievedBodies` grows over a session and sits last. */
export function renderProgressiveRuleContext(rules: RuleHeadline[], retrievedBodies: string[]): string {
  return [renderHeadlineOnlyIndex(rules), retrievedBodies.join("\n")].filter((s) => s.length > 0).join("\n\n");
}
