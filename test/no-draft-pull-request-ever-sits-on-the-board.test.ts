import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// @ts-expect-error — `scripts/**` sits outside tsconfig's `include`, so this executable .mjs has no
// declaration output (TS7016). The seam is typed below, the idiom the acceptance-author-gate tests use.
import * as census from "../scripts/no-draft-pull-request-census.mjs";
import { gitRepo } from "./helpers/git-repo.js";

type DraftHit = { path: string; line: number; pattern: string; text: string };
const findDraftPullRequestCreators = census.findDraftPullRequestCreators as (
  root: string,
  files: string[],
  read?: (path: string) => string,
) => DraftHit[];
const trackedFiles = census.trackedFiles as (root: string) => string[];
const EXEMPTIONS = census.EXEMPTIONS as Map<string, string>;
const DRAFT_CREATOR_PATTERNS = census.DRAFT_CREATOR_PATTERNS as unknown[];

// W1-T4415 — operator ruling 2026-09-24: a draft PR holds work exactly like a stuck one. The plan
// gardener opened #6912 as a draft; these prove every open draft is readied and no source opens one.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("the census refuses a source file that opens a draft pull request", () => {
  const files: Record<string, string> = {
    "src/lib/opens-draft.ts": 'ghExec(["pr", "create", "--draft", "--title", t]);',
    "src/lib/rest-draft.ts": 'createPlanPrRest((args) => fetcher([...args, "-F", "draft=true"]), owner, repo, pr);',
    "scripts/json-draft.mjs": 'const body = { title, head, base, "draft": true };',
    ".github/workflows/x.yml": "      - run: gh pr create --draft --fill",
    "src/lib/converts.ts": "mutation { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }",
    "src/lib/undoes-ready.ts": 'ghExec(["pr", "ready", url, "--undo"], { stdio: "pipe" });',
    ".github/workflows/y.yml": "      - run: gh pr ready 12 --undo",
    "src/lib/reads-draft.ts": "if (pr.isDraft === true) held.push(pr);",
    "test/fixture.ts": 'ghExec(["pr", "create", "--draft"]);',
  };
  const hits = findDraftPullRequestCreators("/unused", Object.keys(files), (p) => files[p]!);
  assert.deepEqual(
    hits.map((h) => h.path).sort(),
    ["src/lib/opens-draft.ts", "src/lib/rest-draft.ts", "scripts/json-draft.mjs", ".github/workflows/x.yml", "src/lib/converts.ts", "src/lib/undoes-ready.ts", ".github/workflows/y.yml"].sort(),
    "every creator shape is caught; reading isDraft and anything outside the scanned roots is not",
  );
});

test("no tracked source opens a draft pull request", () => {
  // The census's own walk: trackedFiles() is `git ls-files -- src/ scripts/ deploy/ .github/`
  // (SCANNED_ROOTS), and every line of every file it names is asserted against DRAFT_CREATOR_PATTERNS.
  // Stated here because censusPopulationDrift recognizes a census suite by its own text (W1-T4422).
  const files = trackedFiles(REPO_ROOT);
  const listed = spawnSync("git", ["-C", REPO_ROOT, "ls-files", "--", "src/", "scripts/", "deploy/", ".github/"],
    { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(files, listed.stdout.split("\n").filter(Boolean), "the census helper must scan the declared roots");
  assert.ok(files.length > 100, `the census must see the real tree (saw ${files.length} files)`);
  assert.deepEqual(findDraftPullRequestCreators(REPO_ROOT, files), []);
  for (const [path, reason] of EXEMPTIONS) assert.ok(String(reason).trim().length > 0, `${path}: an exemption needs a reason`);
  assert.equal(DRAFT_CREATOR_PATTERNS.length, 4);
});

test("the census CLI reports OK on a clean tree and refuses a tree that opens a draft", () => {
  const script = join(REPO_ROOT, "scripts", "no-draft-pull-request-census.mjs");
  const clean = spawnSync(process.execPath, [script, "--root", REPO_ROOT], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /no-draft-pull-request-census: OK/);

  const repo = gitRepo({ kind: "w1-t4415-census" });
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "opens-draft.ts"), 'ghExec(["pr", "create", "--draft"]);\n');
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "a draft creator");
  const dirty = spawnSync(process.execPath, [script, "--root", repo.dir], { encoding: "utf8" });
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /REFUSED — 1 draft-creating PR call/);
  assert.match(dirty.stdout, /src\/opens-draft\.ts:1 \[--draft flag\]/);
});
