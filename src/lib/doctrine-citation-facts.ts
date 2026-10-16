import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DoctrineCitationFacts } from "./doctrine-citations.js";
import { lookupWorkerRule } from "./learnings.js";

/** A checkout's doctrine sections, and whether a cited path reaches a rule there: on disk, or through the index and
 *  `doctrine/merged-rules.json` as `lookupWorkerRule` reads them. Read by lint-plan's changed-tasks pass and the census. */
export function doctrineCitationFactsAt(root: string): DoctrineCitationFacts {
  const doctrine = join(root, "doctrine");
  const sections = new Set(readdirSync(doctrine).filter((entry) => statSync(join(doctrine, entry)).isDirectory()));
  const source = readFileSync(join(root, "CLAUDE.md"), "utf8");
  const readStore = (target: string): string => readFileSync(join(root, target), "utf8");
  return {
    sections,
    resolves: (path) => existsSync(join(root, path)) || lookupWorkerRule(path, source, readStore, []) !== undefined,
  };
}
