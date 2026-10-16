/**
 * A doctrine body path cited outside doctrine/ (a plan shard, a doc, a learning) must reach its rule: on disk,
 * through `doctrine/merged-rules.json`, or as a page an OPEN shard declares in `files:`, which its build creates.
 * The census (test/a-retired-index-line-keeps-its-frozen-bullet.test.ts) and the filing-time lint
 * (`doctrineCitationViolations`, task-linter.ts) share these readers, so the two cannot disagree on what a
 * citation is. Pure: the caller reads the checkout. #12389 filed a shard citing the page its build creates, and
 * main went red at merge.
 */
const DOCTRINE_PATH_RE = /doctrine\/[a-z0-9-]+\/[a-z0-9._-]+\.md/g;

/** Paths into a real section only: `doctrine/x/y.md` in a shard is an example, not a citation. */
export function citedDoctrinePaths(texts: readonly string[], sections: ReadonlySet<string>): Set<string> {
  return new Set(texts.flatMap((t) => t.match(DOCTRINE_PATH_RE) ?? []).filter((p) => sections.has(p.split("/")[1]!)));
}

export function unresolvedDoctrineCitations(
  texts: readonly string[],
  sections: ReadonlySet<string>,
  resolves: (path: string) => boolean,
): string[] {
  return [...citedDoctrinePaths(texts, sections)].filter((path) => !resolves(path)).sort();
}

/** A shard that is neither landed (`merged`, `done`) nor retired will still be built. */
interface PlannedShard {
  readonly status: string;
  readonly retirement?: string;
  readonly files?: readonly string[];
}

/** The doctrine pages open shards declare in `files:`: a citation of one is a forward reference, not a miss. */
export function plannedDoctrinePages(tasks: readonly PlannedShard[]): Set<string> {
  const pages = new Set<string>();
  for (const task of tasks) {
    if (task.status === "merged" || task.status === "done" || task.retirement !== undefined) continue;
    for (const file of task.files ?? []) if (/^doctrine\/[^/]+\/[^/]+\.md$/.test(file)) pages.add(file);
  }
  return pages;
}

/** What a checkout says about doctrine: its sections, and whether a path reaches a rule on disk or by alias. */
export interface DoctrineCitationFacts {
  readonly sections: ReadonlySet<string>;
  readonly resolves: (path: string) => boolean;
}
