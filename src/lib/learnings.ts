import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { citation } from "./provenance.js";

/**
 * Promptsmith — the READ side of the compounding thesis (WS-8, W1-T19).
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
 * The machine-readable source of truth is `plan/learnings.yaml` (structured,
 * git-owned); the prose `LEARNINGS.md` stays the human/Architect-owned narrative
 * (MASTER-PLAN governance) and is intentionally NOT parsed here.
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

/** One durable, provenance-tagged fact, tagged for deterministic matching. */
export interface LearningEntry {
  /** Stable slug used in the injected citation `[src: learnings#<id>]`. */
  id: string;
  /** Human-facing grouping (e.g. `containment`, `ci`); advisory, not matched. */
  subsystem: string;
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

/** Parse `plan/learnings.yaml`. A MISSING file is not an error — returns `[]`. */
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
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new LearningsError("learnings must be a YAML list of entries.");
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new LearningsError(`learnings entry ${i} must be a mapping.`);
    }
    const e = entry as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new LearningsError(`learnings entry ${i}: missing string 'id'.`);
    }
    if (seen.has(id)) throw new LearningsError(`duplicate learnings id '${id}'.`);
    seen.add(id);
    if (typeof e.fact !== "string" || e.fact.length === 0) {
      throw new LearningsError(`learnings '${id}': missing string 'fact'.`);
    }
    if (typeof e.src !== "string" || e.src.length === 0) {
      throw new LearningsError(`learnings '${id}': missing string 'src'.`);
    }
    if (!Array.isArray(e.files) || e.files.some((f) => typeof f !== "string")) {
      throw new LearningsError(`learnings '${id}': 'files' must be a list of globs.`);
    }
    return {
      id,
      subsystem: typeof e.subsystem === "string" ? e.subsystem : "",
      files: e.files as string[],
      fact: e.fact,
      src: e.src,
      cited: typeof e.cited === "string" ? e.cited : undefined,
    };
  });
}

/**
 * Select the learnings to inject for a task, DETERMINISTICALLY.
 *
 * Matching: an entry is a candidate iff one of its globs matches one of
 * `taskFiles`. When `taskFiles` is empty/absent the task is treated as
 * repo-wide, so EVERY entry is a candidate (the budget still bounds the tax).
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
  const files = taskFiles ?? [];
  const repoWide = files.length === 0;
  const ranked = entries
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
 * Render the LEARNINGS half of a prompt's CONTEXT block: the two mandatory
 * doctrine lines followed by the pre-selected, matched facts. Every line is
 * cited, so the block passes the provenance linter. Returns "" only if you pass
 * an empty selection AND the doctrine lines are unwanted (never — they always
 * emit), so the string is always non-empty.
 */
export function renderLearningsContext(selected: LearningEntry[]): string {
  const lines = [
    `- ${DISTRUST_RULE} ${citation(DISTRUST_SRC)}`,
    `- ${AUTONOMY_CLAUSE} ${citation(AUTONOMY_SRC)}`,
    ...selected.map(renderLearningLine),
  ];
  return lines.join("\n");
}
