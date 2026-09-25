import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// @ts-expect-error — `scripts/**` sits outside tsconfig's `include`, so this executable .mjs has no
// declaration output (TS7016). The seam is typed below, the idiom the acceptance-author-gate tests use.
import * as census from "../scripts/no-draft-pull-request-census.mjs";
import { readyDraftViaGh } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";
import { runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";

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

const NOW = Date.parse("2026-09-24T01:00:00Z");
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 6912,
    prUrl: "https://github.com/craigoley/remudero/pull/6912",
    taskId: "W1-T4415",
    reviewState: "pending",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    // expiring-fixture: exempt -- aged against the frozen NOW above, never Date.now()
    lastActivityAt: "2026-09-24T00:31:39Z",
    headSha: "c3297170",
    headRefName: "plan-garden-1790209890119",
    autoMergeArmed: false,
    mergeState: "clean",
    ...over,
  };
}

function deps(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: "/tmp/rmd-w1-t4415-ledger.ndjson",
    runId: "SWEEP-W1-T4415",
    now: () => NOW,
    readLedger: () => [],
    appendLine: () => {},
    ...over,
  };
}

test("the sweep marks an open draft pull request ready for review and ledgers it", async () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const argvs: string[][] = [];
  const readyDraft = readyDraftViaGh("craigoley", "remudero", (step, extra) => rows.push({ step, extra }), ((args: string[]) => {
    argvs.push(args);
    return "";
  }) as never);

  await runSweep([pr({ isDraft: true }), pr({ prNumber: 6913, headSha: "2ac6e2d9", isDraft: false })], deps({ readyDraft }));

  assert.deepEqual(argvs, [["pr", "ready", "6912", "--repo", "craigoley/remudero"]], "only the draft is readied");
  assert.deepEqual(rows, [
    { step: "sweep.draft_readied", extra: { pr_number: 6912, head_sha: "c3297170", head_ref: "plan-garden-1790209890119" } },
  ]);
});

test("a draft whose checks are not green is readied too", async () => {
  const readied: number[] = [];
  await runSweep(
    [pr({ prNumber: 7001, isDraft: true, checksState: "red" }), pr({ prNumber: 7002, isDraft: true, checksState: "pending" })],
    deps({ readyDraft: (p) => void readied.push(p.prNumber) }),
  );
  assert.deepEqual(readied, [7001, 7002]);
});

test("a failed ready write is ledgered with its reason and the sweep goes on", async () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const readyDraft = readyDraftViaGh("craigoley", "remudero", (step, extra) => rows.push({ step, extra }), (() => {
    throw new Error("HTTP 403");
  }) as never);
  const summary = await runSweep([pr({ isDraft: true })], deps({ readyDraft }));
  assert.equal(rows[0]?.step, "sweep.draft_ready_failed");
  assert.equal(rows[0]?.extra?.reason, "HTTP 403");
  assert.ok(summary, "the pass still completes");
});

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
