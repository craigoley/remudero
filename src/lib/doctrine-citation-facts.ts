import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DoctrineCitationFacts } from "./doctrine-citations.js";
import { lookupWorkerRule } from "./learnings.js";

/** A checkout's doctrine sections, and whether a cited path reaches a rule there: on disk, or through the index and
 *  `doctrine/merged-rules.json` as `lookupWorkerRule` reads them. Read by lint-plan's changed-tasks pass and the census.
 *  A checkout with no doctrine/ (a consumer repo, a fixture) has no sections, so nothing in it is a citation. */
export function doctrineCitationFactsAt(root: string): DoctrineCitationFacts {
  const doctrine = join(root, "doctrine");
  if (!existsSync(doctrine)) return { sections: new Set(), resolves: () => true };
  const sections = new Set(readdirSync(doctrine).filter((entry) => statSync(join(doctrine, entry)).isDirectory()));
  const index = join(root, "CLAUDE.md");
  const source = existsSync(index) ? readFileSync(index, "utf8") : "";
  const readStore = (target: string): string => readFileSync(join(root, target), "utf8");
  return {
    sections,
    resolves: (path) => existsSync(join(root, path)) || lookupWorkerRule(path, source, readStore, []) !== undefined,
  };
}
