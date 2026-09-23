/**
 * W1-T4397 — a doctrine or root-markdown edit is a DOCS diff, and the suites that read it still run.
 *
 * #6855 (AGENTS.md, CLAUDE.md, doctrine/) classified SOURCE and paid ~100 job-minutes, because only plan
 * scope and docs/ counted as prose. Reclassifying alone would have been unsafe: the plan/docs lane runs
 * only suites that name plan/ or docs/, so the suites guarding CLAUDE.md and the doctrine index would
 * have been dropped. They are added exactly when their file changes, so a plan-only diff pays nothing more.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "diff-class.mjs");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  classify: (files: unknown) => { class: string };
  planReadingSuiteFiles: (root?: string, changed?: string[]) => string[];
  readsChangedProse: (content: string, changed: string[]) => boolean;
};

test("W1-T4397: doctrine and root markdown classify as docs", () => {
  assert.equal(mod.classify(["AGENTS.md", "CLAUDE.md", "doctrine/ci-and-merging/x.md"]).class, "DOCS_ONLY");
  assert.equal(mod.classify(["CLAUDE.md", "package.json"]).class, "SOURCE", "a config file keeps the diff SOURCE");
  assert.equal(mod.classify(["CLAUDE.md", ".github/workflows/ci.yml"]).class, "SOURCE");
  assert.equal(mod.classify(["src/lib/README.md"]).class, "SOURCE", "markdown under src/ is not root prose");
});

test("W1-T4397: the suites that read doctrine still run for a doctrine edit", () => {
  const base = new Set(mod.planReadingSuiteFiles(REPO_ROOT));
  const index = "test/the-doctrine-index-points-at-every-body.test.ts";
  assert.equal(base.has(index), false, "the doctrine index suite is not in the plain plan-reading set");
  assert.ok(mod.planReadingSuiteFiles(REPO_ROOT, ["doctrine/ci-and-merging/x.md"]).includes(index));
  // A CLAUDE.md edit adds the suites that read CLAUDE.md, and only a changed file's readers are added.
  const claude = mod.planReadingSuiteFiles(REPO_ROOT, ["CLAUDE.md"]);
  assert.ok(claude.length > base.size && claude.every((s) => base.has(s) || /CLAUDE\.md/.test(readFileSync(join(REPO_ROOT, s), "utf8"))));
  assert.equal(mod.readsChangedProse('x = "XCLAUDE.md"', ["CLAUDE.md"]), false, "a longer name is not the changed file");
  assert.equal(mod.readsChangedProse('join(REPO_ROOT, "doctrine")', ["CLAUDE.md"]), false, "doctrine readers only when doctrine changed");
  // The CLI takes the changed list, as ci.yml passes it, and plain plan-only diffs pay for nothing extra.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4397-`));
  const list = join(dir, "changed.txt");
  writeFileSync(list, "doctrine/ci-and-merging/x.md\n");
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--list-plan-reading-suites", "--changed-files", list], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.split("\n").includes(index));
  writeFileSync(list, "plan/tasks.yaml\n");
  const plain = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--list-plan-reading-suites", "--changed-files", list], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(plain.stdout.trim().split("\n").length, base.size);
  const ci = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.equal((ci.match(/--list-plan-reading-suites --changed-files changed-files\.txt/g) ?? []).length, 2, "both lanes pass the changed list");
});
