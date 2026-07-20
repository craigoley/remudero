import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `.remudero/managed-repos.json` — the MANAGED repo set (MASTER-PLAN §5D, W1-T57).
 *
 * `rmd ops` (W1-T55, lib/ops.ts) explicitly deferred a multi-repo "managed repo set" — v0 only
 * ever scoped to the current repo, resolved by the caller. Issues intake (W1-T57) is the task
 * that introduces it: a small, git-tracked, diffable list of `owner/repo` strings the harness
 * polls for open issues. Empty/missing is a SAFE DEFAULT — nothing is managed until an operator
 * explicitly opts a repo in (consistent with G-6: remudero's OWN public repo stays off the
 * issues-intake lane until WS-4; this file simply never lists it until that call is made).
 *
 * One dedicated file, not a key folded into `settings/worker.json` (which is a sandbox/worker
 * execution config, an unrelated concern) — matches this repo's convention of one file per
 * concern (`.remudero/skills/*.yaml`, `.remudero/mounts.yaml`, `.remudero/principles.yaml`).
 */

export class ManagedReposError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedReposError";
  }
}

export interface ManagedRepo {
  owner: string;
  repo: string;
}

export function managedReposPath(root: string): string {
  return join(root, ".remudero", "managed-repos.json");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Load + validate `.remudero/managed-repos.json` — `{"repos": ["owner/repo", ...]}`. Missing
 * file -> `[]` (nothing managed yet, not an error: this file ships empty by default). A present
 * but malformed file FAILS LOUD (Standing rule: validate before any read consumer trusts it)
 * rather than silently skipping bad entries.
 */
export function loadManagedRepos(root: string): ManagedRepo[] {
  const path = managedReposPath(root);
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ManagedReposError(`.remudero/managed-repos.json is not valid JSON: ${String(err)}`);
  }
  if (!isObject(parsed) || !Array.isArray(parsed.repos)) {
    throw new ManagedReposError('.remudero/managed-repos.json must be shaped {"repos": ["owner/repo", ...]}');
  }

  const out: ManagedRepo[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.repos) {
    if (typeof entry !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(entry)) {
      throw new ManagedReposError(
        `.remudero/managed-repos.json: invalid repo entry ${JSON.stringify(entry)} — expected "owner/repo"`,
      );
    }
    if (seen.has(entry)) continue; // duplicate entries collapse silently — not a malformed-file error
    seen.add(entry);
    const [owner, repo] = entry.split("/");
    out.push({ owner, repo });
  }
  return out;
}
