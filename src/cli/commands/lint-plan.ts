/**
 * W1-T14343 — THE PUBLIC CATALOG TAKES NO NEW TASK RECORD.
 *
 * Since 2026-11-17 a new task record belongs in the plan destination, yet the public catalog took 542 new records in
 * the 7 days to 2026-11-22: the host switch that says where a new task goes (`state/plan-destination.json`, W1-T12200)
 * is host state, so hosted CI and a session without that host file never see it. This module holds the two facts
 * `lint-plan`'s changed-task pass needs to refuse such a record for every writer, and nothing else:
 *
 *   1. THE ROW. `catalog.newTasks` in the linted plan's OWN `policy.yaml` (the sibling of the plan file being
 *      linted, the same file lint-plan already validates), a committed data row. Absent file or absent row = open.
 *   2. THE HISTORY. An id is new to the public catalog only when no commit reachable from the base ever held it, in a
 *      `tasks.d` record or in the monolith. A mover RESTORE re-adds an id history holds, so it is never refused.
 *
 * The check fires only when the row is closed AND the linted checkout's origin is the repository the row names. A
 * fixture that copies `plan/policy.yaml` has no such origin; a plan repository other than the public one has neither
 * the row nor the origin. When history cannot be read completely (a shallow clone, a git failure) nothing fires and
 * the reason is returned, because a guess here would refuse a restore.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveOwnerRepoAt } from "../../lib/owner-repo.js";
import { hostWorktreeGit } from "../../lib/worktree-git.js";

export type CatalogNewTasksRow = { state: "open" } | { state: "closed"; repository: string };

/** The verdict for one lint pass: `off` checks nothing, `checked` names every added id history never held. */
export type PublicCatalogVerdict =
  | { state: "off"; reason: "no_added_ids" | "row_open" | "not_the_catalog_repository" }
  | { state: "checked"; newIds: ReadonlySet<string> }
  | { state: "unknown"; reason: string };

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROBED_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `catalog.newTasks` out of a policy file's text; `undefined` text (no file) is open. A present row that is not
 *  `{ value: open|closed, origin, repository }` throws, so a typo fails loud instead of reading as open. */
export function catalogNewTasksRow(policyText: string | undefined): CatalogNewTasksRow {
  if (policyText === undefined) return { state: "open" };
  const doc: unknown = parseYaml(policyText);
  const catalog = isMapping(doc) ? doc.catalog : undefined;
  if (catalog === undefined) return { state: "open" };
  const row = isMapping(catalog) ? catalog.newTasks : undefined;
  if (!isMapping(row)) throw new Error("policy.yaml: 'catalog.newTasks' must be a mapping with 'value', 'repository' and 'origin'.");
  if (typeof row.origin !== "string" || row.origin.trim() === "") throw new Error("policy.yaml: 'catalog.newTasks.origin' must name where the row came from.");
  if (row.value === "open") return { state: "open" };
  if (row.value !== "closed") throw new Error(`policy.yaml: 'catalog.newTasks' accepts only "open", "closed", got ${JSON.stringify(row.value)}.`);
  if (typeof row.repository !== "string" || !REPOSITORY.test(row.repository)) {
    throw new Error("policy.yaml: a closed 'catalog.newTasks' must name its repository as <owner>/<name>.");
  }
  return { state: "closed", repository: row.repository };
}

/** {@link catalogNewTasksRow} of the file at `policyFile`; a missing file is open. */
export function readCatalogNewTasksRow(policyFile: string): CatalogNewTasksRow {
  let text: string | undefined;
  try {
    text = readFileSync(policyFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    text = undefined;
  }
  return catalogNewTasksRow(text);
}

export interface PublicCatalogInput {
  /** The checkout being linted: its origin and its history are read. */
  checkoutRoot: string;
  /** The linted plan file, relative to `checkoutRoot` (`plan/tasks.yaml`); its `tasks.d` sibling holds the shards. */
  planRel: string;
  /** The linted plan's own `policy.yaml`. */
  policyFile: string;
  /** The commit whose history is the public catalog's (lint-plan's resolved base). */
  base: string;
  /** Ids this diff adds: absent from the base plan. */
  addedIds: ReadonlySet<string>;
}

/** Which of `addedIds` no commit reachable from `base` ever held. Reads nothing when no id is added. */
export function newPublicTaskRecords(
  input: PublicCatalogInput,
  git: (args: readonly string[]) => string = (args) => hostWorktreeGit(input.checkoutRoot, args, { maxBuffer: 1 << 28 }),
  originOf: (root: string) => { owner: string; repo: string } = resolveOwnerRepoAt,
): PublicCatalogVerdict {
  if (input.addedIds.size === 0) return { state: "off", reason: "no_added_ids" };
  let row: CatalogNewTasksRow;
  try {
    row = readCatalogNewTasksRow(input.policyFile);
  } catch (error) {
    return { state: "unknown", reason: `the catalog row does not read (${firstLine(error)})` };
  }
  if (row.state === "open") return { state: "off", reason: "row_open" };
  let origin: string;
  try {
    const { owner, repo } = originOf(input.checkoutRoot);
    origin = `${owner}/${repo}`;
  } catch (error) {
    void error; // no origin is no public catalog checkout: a fixture or a bare tree, never this repository
    return { state: "off", reason: "not_the_catalog_repository" };
  }
  if (origin.toLowerCase() !== row.repository.toLowerCase()) return { state: "off", reason: "not_the_catalog_repository" };
  const ids = [...input.addedIds].filter((id) => PROBED_ID.test(id));
  const shardDir = join(dirname(input.planRel), "tasks.d");
  const held = new Set<string>();
  try {
    if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
      return { state: "unknown", reason: "this clone is shallow, so its history cannot show which ids the catalog held" };
    }
    if (ids.length > 0) {
      const specs = ids.flatMap((id) => [`${shardDir}/${id}-*`, `${shardDir}/${id}.yaml`, `${shardDir}/${id}.yml`]);
      for (const path of git(["log", input.base, "--format=", "--name-only", "--no-renames", "--", ...specs]).split("\n")) {
        const name = path.slice(shardDir.length + 1);
        const id = ids.find((candidate) => name.startsWith(`${candidate}-`) || name === `${candidate}.yaml` || name === `${candidate}.yml`);
        if (path.startsWith(`${shardDir}/`) && id !== undefined) held.add(id);
      }
      const wanted = new Set(ids);
      for (const line of git(["log", input.base, "-p", "--format=", "--", input.planRel]).split("\n")) {
        const m = /^[-+ ]\s*- id:\s*(\S+)\s*$/.exec(line);
        if (m && wanted.has(m[1]!)) held.add(m[1]!);
      }
    }
  } catch (error) {
    return { state: "unknown", reason: `the base's history does not read (${firstLine(error)})` };
  }
  return { state: "checked", newIds: new Set(ids.filter((id) => !held.has(id))) };
}

function firstLine(error: unknown): string {
  return String((error as Error)?.message ?? error).split("\n")[0]!.trim();
}
