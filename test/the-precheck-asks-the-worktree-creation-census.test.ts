/**
 * #11677 (2026-10-14): W1-T9077's build added a raw `git worktree add` in src/lib/engine-tree.ts::buildEngine,
 * and test/worktree-creation-census.test.ts refused it only in CI's rule-checks — the suite was on the
 * shrink-only ciOnly list, so the pre-push precheck never asked it, and a fix round was spent registering the
 * site. The precheck now asks the census whenever a diff moves a raw site's census key.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findRawWorktreeAddSites, RAW_WORKTREE_ADD_RE } from "../src/lib/worktree-sites.js";
// @ts-ignore the executable .mjs module has no declaration file.
import * as precheck from "../scripts/census-precheck.mjs";
import { repoRoot as findRepoRoot } from "./helpers/repo-root.js";

const CENSUS = "test/worktree-creation-census.test.ts";
const SOURCE = "src/lib/engine-tree.ts";
const ROOT = findRepoRoot();
const raw = (dir: string) => `  run(["-C", repo, "worktree", "add", "--detach", ${dir}, sha]);`;

function started(path: string, head: string | null, base: string | null): string[] {
  const runs: string[][] = [];
  const result = precheck.evaluateAdmittedCensusSuites({
    changed: [path],
    readHead: () => head,
    readBase: () => base,
    loadMembers: () => [],
    runSuites: (files: string[]) => { runs.push(files); return files.includes(CENSUS) ? [CENSUS] : []; },
  });
  if (runs.flat().includes(CENSUS)) {
    assert.ok(result.violations.some((v: string) => v.includes("npm run census:worktree-creation") && v.includes("WORKTREE_SITE_REGISTRY")));
  }
  return runs.flat();
}

test("a diff adding a raw git worktree add site in src starts the worktree-creation census before the push", () => {
  const added = `export function buildEngine(repo, sha) {\n${raw("tmp")}\n}\n`;
  assert.ok(started(SOURCE, added, null).includes(CENSUS), "a new file's raw site");
  assert.ok(started(SOURCE, added, "export const x = 1;\n").includes(CENSUS), "a raw site added to an existing file");
  assert.ok(started(SOURCE, added.replace("buildEngine", "buildPinnedEngine"), added).includes(CENSUS), "the enclosing site renamed");
  assert.ok(started(SOURCE, added + `export async function second(repo, sha) {\n${raw("tmp2")}\n}\n`, added).includes(CENSUS), "a second site");
  assert.ok(started(SOURCE, "export const x = 1;\n", added).includes(CENSUS), "a site removed, so its row would rot");
  assert.ok(started(SOURCE, null, added).includes(CENSUS), "a file holding a site deleted");
  for (const path of ["src/lib/worktree-sites.ts", "src/lib/worker.ts", CENSUS]) {
    assert.ok(started(path, "", "").includes(CENSUS), path);
  }
});

test("a diff that leaves every raw worktree site's census key unchanged starts no worktree-creation census", () => {
  const site = `export function buildEngine(repo, sha) {\n${raw("tmp")}\n}\n`;
  assert.ok(!started(SOURCE, site + "const y = 2;\n", site + "const y = 1;\n").includes(CENSUS), "an unrelated edit beside a site");
  assert.ok(!started(SOURCE, site.replace("tmp", "dir"), site).includes(CENSUS), "the site's arguments edited");
  assert.ok(!started(SOURCE, `// ${raw("tmp")}\n * ${raw("tmp")}\n`, "").includes(CENSUS), "comment lines quoting the shape");
  assert.ok(!started("docs/engine.md", raw("tmp"), "").includes(CENSUS), "outside src");
  assert.ok(!started("test/engine.test.ts", raw("tmp"), "").includes(CENSUS), "a test fixture");
});

test("the precheck's raw worktree site keys equal the census's own scan of every real src file", () => {
  assert.equal(precheck.RAW_WORKTREE_ADD_SHAPE.source, RAW_WORKTREE_ADD_RE.source);
  const byFile = new Map<string, string[]>();
  for (const site of findRawWorktreeAddSites(join(ROOT, "src"), ROOT)) {
    byFile.set(site.file, [...(byFile.get(site.file) ?? []), site.site]);
  }
  assert.ok(byFile.size >= 5, `the census found raw sites in only ${byFile.size} src file(s); the comparison would be vacuous`);
  for (const [file, sites] of byFile) {
    assert.deepEqual(precheck.rawWorktreeAddSiteKeys(readFileSync(join(ROOT, file), "utf8")), [...sites].sort(), file);
  }
});
