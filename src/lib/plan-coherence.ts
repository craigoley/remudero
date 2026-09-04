import { parseTasksFromYaml } from "./plan.js";
import { shardSlugFromPath } from "./task-linter.js";

/**
 * PLAN COHERENCE (W1-T2642) — measures the TWO plan registries {@link "./plan.js".loadPlan}'s
 * merged view never checks, because the merge is coherent by construction and needs no new
 * guard (loadPlan already fails loud on a duplicate id or an unresolved `depends_on`):
 *
 * (i) THE FILENAME REGISTRY. `shardSlugFromPath` (task-linter.ts) derives a shard's id from
 *     `plan/tasks.d/<id>-<slug>.yaml` BY PARSING THE PATH AND NEVER OPENING THE FILE — every
 *     `git log --grep`, docs/operator-guide.md's next-task-id recipe, and every human grepping
 *     a filename reads THAT id. A shard whose filename id disagrees with the record id inside
 *     it is invisible to all of them while loadPlan happily builds the OTHER id from the
 *     record. Two registries, one file, no comparison — until now.
 * (ii) THE ONE-TASK-PER-FILE CONVENTION. `monolithFilingViolations`' own message (task-linter.ts)
 *     tells a filer to "create plan/tasks.d/<id>-<slug>.yaml holding a single-element YAML
 *     list", and nothing verifies it: that check keys on id SETS in `--base` mode only and is
 *     explicitly silent in whole-plan mode. A shard holding two records passes every gate and
 *     silently re-creates the shared-EOF collision surface W1-T122 deleted.
 *
 * A PURE, OFFLINE MODULE. No fs, no network — the caller (the retro rung, {@link
 * "./retro.js".planCoherenceRung}) reads `plan/tasks.yaml` and `plan/tasks.d/*.yaml` and hands
 * in the raw text, the same "the linter is pure, the caller reads disk" seam
 * `task-linter.ts`'s `opts.moduleExists` and `planShardSlugCorpus` already use.
 *
 * REUSE, NEVER A SECOND OPINION. The filename id comes from {@link shardSlugFromPath}, imported
 * and never re-parsed — a second filename parser IS the drift class this module exists to
 * close. Record ids come from {@link "./plan.js".parseTasksFromYaml}, never a regex over
 * `- id:` — that function's own caller docs (plan.ts) already record why a text scan is wrong
 * (it matches a commented-out line, a `depends_on` entry, or prose).
 */

/** One shard file's repo-relative path (e.g. `plan/tasks.d/W1-T2642-foo.yaml`) and raw text —
 *  exactly what a caller gets back from `readdirSync` + `readFileSync` over `plan/tasks.d/`,
 *  handed in rather than read here (this module has no fs of its own). */
export interface PlanCoherenceShardEntry {
  path: string;
  text: string;
}

/** A shard's FILENAME id ({@link shardSlugFromPath}) disagrees with the record id inside it —
 *  a disagreement `shardSlugFromPath` structurally cannot see, since it parses the path and
 *  never opens the file. Only checked when the shard holds EXACTLY one record (a shard holding
 *  zero or two+ becomes a {@link FilingCountFinding} instead — "the record id" is not a single
 *  well-defined thing to compare against otherwise). */
export interface FilenameIdMismatchFinding {
  kind: "filename-id-mismatch";
  path: string;
  filenameId: string;
  recordId: string;
}

/** A shard whose filename DOES parse (per {@link shardSlugFromPath}) holds other than exactly
 *  one task record — the one-task-per-file convention `monolithFilingViolations`' own message
 *  asserts and no check verified before this module. `recordCount` is 0 (an empty/placeholder
 *  shard) or >= 2 (the shared-EOF collision surface W1-T122's sharding exists to prevent). */
export interface FilingCountFinding {
  kind: "filing-count";
  path: string;
  recordCount: number;
  recordIds: string[];
}

/** A path under `plan/tasks.d/` that {@link shardSlugFromPath} cannot parse at all — today this
 *  is silently absent from the duplicate-title corpus ({@link
 *  "./task-linter.js".planShardSlugCorpus}), invisible to every `git log --grep` recipe and to
 *  every human grepping a filename for a task id, without anything ever saying so. */
export interface UnparseablePathFinding {
  kind: "unparseable-path";
  path: string;
}

/** The SAME task id is held by two different sources (the monolith and a shard, or two
 *  shards) — the exact condition {@link "./plan.js".loadPlan} throws `PlanError` on. This
 *  module NAMES it as a finding instead of throwing, so a census over the whole corpus can
 *  report every offender in one pass rather than aborting at the first. `firstPath` /
 *  `secondPath` follow the SAME merge order `loadPlan` uses (the monolith, then shards in
 *  sorted-filename order) — the id this reports is the identical one `loadPlan` would throw
 *  on for the same fixture, never a second opinion about what the plan contains. */
export interface CrossFileDuplicateFinding {
  kind: "cross-file-duplicate";
  id: string;
  firstPath: string;
  secondPath: string;
}

/** The four DETERMINISTIC finding classes this module can report. */
export type PlanCoherenceFinding =
  | FilenameIdMismatchFinding
  | FilingCountFinding
  | UnparseablePathFinding
  | CrossFileDuplicateFinding;

/** The raw scan result: every finding plus what was actually examined, so a caller can render
 *  "N shards and M monolith records examined, zero disagreements" rather than a bare zero
 *  (MASTER-PLAN P48) — see {@link "./retro.js".planCoherenceRung}, this module's only
 *  consumer. */
export interface PlanCoherenceScan {
  findings: PlanCoherenceFinding[];
  shardsExamined: number;
  monolithRecordsExamined: number;
}

/**
 * Scan the monolith blob plus every shard entry for the four finding classes above.
 *
 * THROWS {@link "./plan.js".PlanError} exactly when {@link parseTasksFromYaml} would — a
 * monolith or shard blob that is not valid YAML, or not a valid task list, is a genuinely
 * broken plan file (the same condition that already breaks `loadPlan` for every other
 * consumer); this module does not invent a softer reading of that failure, and a healthy repo
 * cannot present it here without `loadPlan` already having failed everywhere else first.
 */
export function scanPlanCoherence(
  monolith: { path: string; text: string },
  shards: readonly PlanCoherenceShardEntry[],
): PlanCoherenceScan {
  const findings: PlanCoherenceFinding[] = [];
  const monolithTasks = parseTasksFromYaml(monolith.text, monolith.path);

  // id -> the first path it was seen at, in the SAME merge order loadPlan uses (monolith
  // first, then shards in the order the caller supplies them) — so the first duplicate this
  // loop finds for a given id is the SAME one loadPlan would throw PlanError on.
  const seenAt = new Map<string, string>();
  for (const t of monolithTasks) seenAt.set(t.id, monolith.path);

  for (const shard of shards) {
    const filenameEntry = shardSlugFromPath(shard.path);
    if (!filenameEntry) {
      findings.push({ kind: "unparseable-path", path: shard.path });
      continue;
    }

    const shardTasks = parseTasksFromYaml(shard.text, shard.path);
    if (shardTasks.length !== 1) {
      findings.push({
        kind: "filing-count",
        path: shard.path,
        recordCount: shardTasks.length,
        recordIds: shardTasks.map((t) => t.id),
      });
    } else if (shardTasks[0].id !== filenameEntry.id) {
      findings.push({
        kind: "filename-id-mismatch",
        path: shard.path,
        filenameId: filenameEntry.id,
        recordId: shardTasks[0].id,
      });
    }

    for (const t of shardTasks) {
      const firstPath = seenAt.get(t.id);
      if (firstPath) {
        findings.push({ kind: "cross-file-duplicate", id: t.id, firstPath, secondPath: shard.path });
      } else {
        seenAt.set(t.id, shard.path);
      }
    }
  }

  return { findings, shardsExamined: shards.length, monolithRecordsExamined: monolithTasks.length };
}
