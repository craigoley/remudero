#!/usr/bin/env node
// scripts/no-draft-pull-request-census.mjs
//
// NO-DRAFT CENSUS (W1-T4415). Operator ruling 2026-09-24: no process may open a draft pull request,
// because a draft never reviews or merges and holds work exactly like a stuck PR. The plan gardener
// did (#6912) until #6913 removed its draft path; this census makes the next creator fail CI instead.
//
// It walks tracked files under src/, scripts/, deploy/ and .github/ and reports every line carrying a
// draft-creating PR call: a `--draft` flag, a `draft=true` / `"draft": true` payload field, or a
// convertPullRequestToDraft mutation. EXEMPTIONS names any reasoned exception; today there are none.
//
// Usage: node scripts/no-draft-pull-request-census.mjs [--root <dir>]   (exit 1 when any creator is found)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCANNED_ROOTS = ["src/", "scripts/", "deploy/", ".github/"];
const SELF = "scripts/no-draft-pull-request-census.mjs";

/** Each pattern names one way a PR is opened as, or turned into, a draft. */
export const DRAFT_CREATOR_PATTERNS = [
  { name: "--draft flag", re: /(^|[\s"'`[,])--draft\b/ },
  { name: "draft=true payload field", re: /\bdraft["']?\s*[=:]\s*["']?true\b/ },
  { name: "convertPullRequestToDraft mutation", re: /\bconvertPullRequestToDraft\b/ },
  { name: "ready --undo flag", re: /(^|[\s"'`[,])--undo\b/ },
];

/** `path` -> reason. A path here is skipped; an entry without a reason is refused by the test. */
export const EXEMPTIONS = new Map();

/** Every draft-creating line in `files` (paths relative to `root`), as `{ path, line, pattern, text }`. */
export function findDraftPullRequestCreators(root, files, read = (p) => readFileSync(join(root, p), "utf8")) {
  const hits = [];
  for (const path of files) {
    if (path === SELF || EXEMPTIONS.has(path)) continue;
    if (!SCANNED_ROOTS.some((r) => path.startsWith(r))) continue;
    const lines = read(path).split("\n");
    lines.forEach((text, i) => {
      for (const { name, re } of DRAFT_CREATOR_PATTERNS) {
        if (re.test(text)) hits.push({ path, line: i + 1, pattern: name, text: text.trim().slice(0, 160) });
      }
    });
  }
  return hits;
}

export function trackedFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "--", ...SCANNED_ROOTS], { encoding: "utf8" })
    .split("\n")
    .filter((p) => p.length > 0);
}

function main(argv) {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 ? argv[rootIdx + 1] : fileURLToPath(new URL("..", import.meta.url));
  const hits = findDraftPullRequestCreators(root, trackedFiles(root));
  if (hits.length === 0) {
    console.log(`no-draft-pull-request-census: OK — no draft-creating PR call under ${SCANNED_ROOTS.join(", ")}`);
    return 0;
  }
  console.log(`no-draft-pull-request-census: REFUSED — ${hits.length} draft-creating PR call(s); open PRs ready for review:`);
  for (const h of hits) console.log(`  ${h.path}:${h.line} [${h.pattern}] ${h.text}`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
