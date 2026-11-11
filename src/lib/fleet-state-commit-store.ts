import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fs-race-safe.js";

// W1-T12234: the fleet-state read asks GitHub the same questions about the same main commits in
// every full sweep. This store keeps the answers that cannot change: a commit has a workflow run,
// a commit has a run of one workflow, and the files that a commit changed.
//
// THE RULE THIS MODULE HOLDS: it keeps a positive answer only. It has no way to keep a count of 0
// or an unreadable count, because a run can still appear for that commit. A caller that finds no
// answer here reads GitHub, as it did before this store.

const SCHEMA = 1;
// A hard limit on the commits in the store. `retain` keeps the store to the look-back of the
// sweep. This limit holds when a sweep fails before it can call `retain`.
const COMMIT_LIMIT = 64;

interface CommitAnswers {
  runs: boolean;
  workflows: Set<string>;
  files?: readonly string[];
}

type FleetStateCommitStoreSave = { ok: true; written: boolean } | { ok: false; reason: string };

export interface FleetStateCommitStore {
  /** Why the file gave no answers. Absent when the file was read, and when there is no file yet. */
  readonly unreadable?: string;
  changedFiles(sha: string): readonly string[] | undefined;
  hasRuns(sha: string): boolean;
  hasWorkflowRuns(sha: string, workflow: string): boolean;
  setChangedFiles(sha: string, files: readonly string[]): void;
  setHasRuns(sha: string): void;
  setHasWorkflowRuns(sha: string, workflow: string): void;
  /** Removes each commit that is not in `shas`. */
  retain(shas: Iterable<string>): void;
  /** Writes the file if an answer changed since the last write. A failed write keeps the answers in memory. */
  save(): FleetStateCommitStoreSave;
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function parseStore(text: string): Map<string, CommitAnswers> {
  const body = JSON.parse(text) as { schema?: unknown; commits?: unknown } | null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("the store is not an object");
  if (body.schema !== SCHEMA) throw new Error(`schema ${JSON.stringify(body.schema)} is not schema ${SCHEMA}`);
  const commits = body.commits;
  if (commits === null || typeof commits !== "object" || Array.isArray(commits)) throw new Error("commits is not an object");
  const parsed = new Map<string, CommitAnswers>();
  for (const [sha, value] of Object.entries(commits as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`commit ${sha} is not an object`);
    const { runs, workflows, files } = value as { runs?: unknown; workflows?: unknown; files?: unknown };
    if (runs !== undefined && runs !== true) throw new Error(`commit ${sha} has a run answer that is not true`);
    if (workflows !== undefined && !isStrings(workflows)) throw new Error(`commit ${sha} has workflows that are not a list of names`);
    if (files !== undefined && !isStrings(files)) throw new Error(`commit ${sha} has files that are not a list of paths`);
    parsed.set(sha, { runs: runs === true, workflows: new Set(workflows ?? []), ...(files ? { files } : {}) });
  }
  return parsed;
}

/**
 * Reads `state/cache/fleet-state-commits.json`. A missing file gives an empty store. A file that
 * cannot be read, is not JSON, has a different schema or has a wrong shape also gives an empty
 * store, and `unreadable` names the reason. This function does not throw.
 */
export function loadFleetStateCommitStore(stateDir: string): FleetStateCommitStore {
  const path = join(stateDir, "cache", "fleet-state-commits.json");
  let commits = new Map<string, CommitAnswers>();
  let unreadable: string | undefined;
  try {
    commits = parseStore(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable = String((error as Error)?.message ?? error);
  }
  // An unreadable file is replaced at the first save, so one bad file is reported once.
  let dirty = unreadable !== undefined;
  const answers = (sha: string): CommitAnswers => {
    let entry = commits.get(sha);
    if (!entry) {
      entry = { runs: false, workflows: new Set() };
      commits.set(sha, entry);
    }
    return entry;
  };
  const trim = (): void => {
    // A Map lists its keys in the order of insertion, so the first key is the commit that entered the store first.
    for (const sha of commits.keys()) {
      if (commits.size <= COMMIT_LIMIT) break;
      commits.delete(sha);
      dirty = true;
    }
  };
  trim();
  return {
    ...(unreadable !== undefined ? { unreadable } : {}),
    changedFiles: (sha) => commits.get(sha)?.files,
    hasRuns: (sha) => commits.get(sha)?.runs === true,
    hasWorkflowRuns: (sha, workflow) => commits.get(sha)?.workflows.has(workflow) === true,
    setChangedFiles: (sha, files) => {
      answers(sha).files = [...files];
      dirty = true;
      trim();
    },
    setHasRuns: (sha) => {
      if (commits.get(sha)?.runs === true) return;
      answers(sha).runs = true;
      dirty = true;
      trim();
    },
    setHasWorkflowRuns: (sha, workflow) => {
      if (commits.get(sha)?.workflows.has(workflow) === true) return;
      answers(sha).workflows.add(workflow);
      dirty = true;
      trim();
    },
    retain: (shas) => {
      const keep = new Set(shas);
      for (const sha of commits.keys()) {
        if (keep.has(sha)) continue;
        commits.delete(sha);
        dirty = true;
      }
    },
    save: () => {
      if (!dirty) return { ok: true, written: false };
      const body: Record<string, { runs?: true; workflows?: string[]; files?: readonly string[] }> = {};
      for (const [sha, entry] of commits) {
        body[sha] = {
          ...(entry.runs ? { runs: true as const } : {}),
          ...(entry.workflows.size > 0 ? { workflows: [...entry.workflows].sort() } : {}),
          ...(entry.files ? { files: entry.files } : {}),
        };
      }
      try {
        // A temporary file and a rename: a second process reads the old file or the new file, never a part of one.
        writeAtomic(path, JSON.stringify({ schema: SCHEMA, commits: body }), { mode: 0o600 });
        dirty = false;
        return { ok: true, written: true };
      } catch (error) {
        return { ok: false, reason: String((error as Error)?.message ?? error) };
      }
    },
  };
}
