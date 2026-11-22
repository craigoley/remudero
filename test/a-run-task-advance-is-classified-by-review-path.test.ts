// @source-text-subject: criteria 2 and 4 classify the real src/run-task.ts text itself (which top-level units the review walk reaches, and the review child's argument list); importing run-task.ts would trip the affected-suite reach ratchet.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  REVIEW_TREE_PLACEMENT_SYMBOLS_IN_RUN_TASK,
  SELF_SYNC_GUARD_ENV,
  checkReviewerCodeFreshness,
  reviewPathSpans,
  reviewerCodeFreshnessAt,
  topLevelUnits,
  runTaskAdvanceTouchesReviewPath,
  type GitRunner,
} from "../src/lib/self-sync.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T4469. REVIEW_MATERIAL_ADVANCE_PATHS listed all of src/run-task.ts, so 17 of 23 withheld
// verdicts in a day were caused by run-task.ts hunks in the daemon, serve or sweep wiring. A
// run-task.ts advance now counts only when a hunk meets a declaration the review roots reach.

const BASE = [
  'import { readFileSync } from "node:fs";',
  "import {",
  "  alpha,",
  "  // a comment naming nothing: it's here",
  "  beta,",
  "  libHelper as localAlias,",
  '} from "./lib/letters.js";',
  'import "./lib/side-effect.js";',
  "const PATTERN = /[/\"'`]+/g;",
  "const HELP = `",
  "function notReal() {",
  "an escaped \\` tick",
  "`;",
  "",
  "async function runReview(args: { pr: string }): Promise<string> {",
  "  const note = `review ${args.pr} ${`nested ${helperForReview()}`}`;",
  "  return note + alpha + localAlias + HELP + String(PATTERN) + (args as any).serveDashboard + 'it\\'s' + \"x \\",
  'continued";',
  "}",
  "/*",
  "function retiredReview() {",
  "*/",
  "",
  "function helperForReview(): string {",
  'const inner = "column 0 inside a block";',
  '  return "helper" + inner;',
  "}",
  "",
  "async function reviewCommand(pr: string): Promise<number> {",
  "  return (await runReview({ pr })).length / 2;",
  "}",
  "",
  "export function buildFreshTreeReviewRunner(): string {",
  '  return "fresh";',
  "}",
  "",
  "export function spawnRmdReviewForFreshTree(): string {",
  '  return "spawn";',
  "}",
  "",
  "export function libHelper(): string {",
  '  return "local, never reached through the alias";',
  "}",
  "",
  "export function serveDashboard(): string {",
  '  const view = { runReview: "label" };',
  "  return view.runReview + beta + readFileSync.name;",
  "}",
  "",
  "export { serveDashboard as dashboard };",
  "// the end, with no newline after it",
].join("\n");

function commitRunTask(repo: GitRepo, source: string): string {
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "run-task.ts"), source);
  repo.git("add", "src/run-task.ts");
  repo.git("commit", "--quiet", "-m", "edit run-task");
  return repo.git("rev-parse", "HEAD");
}

function classify(before: string, after: string) {
  const repo = gitRepo({ kind: "run-task-advance" });
  const codeSha = commitRunTask(repo, before);
  const originMainSha = commitRunTask(repo, after);
  const git: GitRunner = (args) => repo.git(...args);
  return runTaskAdvanceTouchesReviewPath(git, codeSha, originMainSha);
}

function edit(from: string, to: string): string {
  assert.ok(BASE.includes(from), `fixture must contain ${from}`);
  return BASE.replace(from, to);
}

test("a run-task hunk outside the review path is not material", () => {
  const verdict = classify(BASE, edit('  return view.runReview + beta', '  return "served" + view.runReview + beta'));
  assert.equal(verdict.touchesReviewPath, false, verdict.reason);
  assert.match(verdict.reason, /1 src\/run-task\.ts hunk\(s\) avoid the review path/);
});

test("an import line binding only names off the review path is not material", () => {
  assert.equal(classify(BASE, edit("  beta,", "  beta,\n  gamma,")).touchesReviewPath, false);
  assert.equal(classify(BASE, edit("  beta,\n", "")).touchesReviewPath, false);
});

test("a new declaration inserted beside the review path is not material", () => {
  const inserted = "export function unrelatedNewHelper(): number {\n  return 1;\n}\n\nasync function reviewCommand";
  const verdict = classify(BASE, edit("async function reviewCommand", inserted));
  assert.equal(verdict.touchesReviewPath, false, verdict.reason);
});

test("an aliased import does not reach the local declaration its source name shares", () => {
  // `libHelper as localAlias` binds localAlias; the local libHelper is off the review path.
  const verdict = classify(BASE, edit('  return "local, never', '  return "still local, never'));
  assert.equal(verdict.touchesReviewPath, false, verdict.reason);
});

test("a run-task hunk inside runReview is material", () => {
  const verdict = classify(BASE, edit("  const note = `review", "  const note = `judged"));
  assert.equal(verdict.touchesReviewPath, true);
  assert.match(verdict.reason, /meets the review path/);
});

test("a helper runReview calls is on the review path too", () => {
  assert.equal(classify(BASE, edit('  return "helper" + inner;', '  return "changed" + inner;')).touchesReviewPath, true);
  assert.equal(classify(BASE, edit("  alpha,", "  alpha,\n  delta,")).touchesReviewPath, false);
  assert.equal(classify(BASE, edit("  alpha,", "  alphaRenamed,")).touchesReviewPath, true);
  assert.equal(classify(BASE, edit('} from "./lib/letters.js";', '} from "./lib/other.js";')).touchesReviewPath, true);
});

test("a column-0 declaration inside a literal or comment or block starts no unit of its own", () => {
  // Both lines belong to a reached unit; a line-only splitter would file them under unreached names.
  assert.equal(classify(BASE, edit("function notReal() {", "function stillNotReal() {")).touchesReviewPath, true);
  assert.equal(classify(BASE, edit("function retiredReview() {", "function retired() {")).touchesReviewPath, true);
  assert.equal(classify(BASE, edit('const inner = "column 0', 'const inner = "col 0')).touchesReviewPath, true);
});

test("a missing review path symbol reads as material", () => {
  const renamed = classify(BASE, BASE.replaceAll("reviewCommand", "reviewVerb"));
  assert.equal(renamed.touchesReviewPath, true);
  assert.match(renamed.reason, /review path symbol reviewCommand not found/);
  const added = classify(BASE.replaceAll("spawnRmdReviewForFreshTree", "spawnLater"), BASE);
  assert.match(added.reason, /review path symbol spawnRmdReviewForFreshTree not found/);
});

test("an unreadable run-task hunk diff reads as material", () => {
  const failing: GitRunner = () => {
    throw new Error("fatal: bad revision");
  };
  const unreadable = runTaskAdvanceTouchesReviewPath(failing, "a".repeat(40), "b".repeat(40));
  assert.equal(unreadable.touchesReviewPath, true);
  assert.match(unreadable.reason, /could not read the src\/run-task\.ts advance: .*bad revision/);

  const faked = (diff: string): GitRunner => (args) => (args[0] === "diff" ? diff : BASE);
  const garbled = runTaskAdvanceTouchesReviewPath(faked("@@ not a header @@\n+x"), "a", "b");
  assert.equal(garbled.touchesReviewPath, true);
  assert.match(garbled.reason, /unparseable hunk header/);
  const empty = runTaskAdvanceTouchesReviewPath(faked(""), "a", "b");
  assert.equal(empty.touchesReviewPath, true);
  assert.match(empty.reason, /no src\/run-task\.ts hunks to classify/);
  const outside = runTaskAdvanceTouchesReviewPath(faked("@@ -45 +45 @@\n-a\n+b"), "a", "b");
  assert.equal(outside.touchesReviewPath, false, "the fake is readable, so only the header decided the rows above");
});

test("a source the scan cannot read to its end reads as material", () => {
  const unreadable = [
    "const open = `never closed",
    "const t = `a${b}",
    'const s = "no close',
    'const s = "no close\n";',
    "const r = /no close",
    "const r = /no close\n/;",
    "/* never closed",
    "function f() {",
    "export default function () {}",
    "const { a } = obj;",
    'import { a } from ./unquoted;\nimport "x";',
  ];
  for (const source of unreadable) {
    const spans = reviewPathSpans(`${BASE}\n${source}`);
    assert.ok("unreadable" in spans, `${JSON.stringify(source)} must not be classified`);
  }
  const verdict = classify(BASE, `${BASE}\nconst open = \`never closed`);
  assert.equal(verdict.touchesReviewPath, true);
  assert.match(verdict.reason, /could not scan it to its end/);
  assert.ok("spans" in reviewPathSpans(BASE), "the base fixture itself must scan, or every row above proves nothing");
});

function behind(changedPaths: string[]) {
  return () => ({
    status: "loaded" as const,
    behind: { oldSha: "a".repeat(40), newSha: "b".repeat(40), changedPaths },
  });
}

test("the freshness check posts across a run-task advance off the review path", () => {
  const repo = gitRepo({ kind: "run-task-advance" });
  const oldSha = commitRunTask(repo, BASE);
  const newSha = commitRunTask(repo, edit("  return view.runReview", '  return "x" + view.runReview'));
  const service = () => ({ status: "loaded" as const, behind: { oldSha, newSha, changedPaths: ["src/run-task.ts", "src/lib/serve.ts"] } });
  const fresh = checkReviewerCodeFreshness(repo.dir, {}, { checkServiceFreshness: service } as never);
  assert.equal(fresh.status, "fresh");
  assert.equal((fresh as { advance: string }).advance, "immaterial");

  const withReview = () => ({ ...service(), behind: { ...service().behind, changedPaths: ["src/run-task.ts", "src/lib/review.ts"] } });
  assert.equal(checkReviewerCodeFreshness(repo.dir, {}, { checkServiceFreshness: withReview } as never).status, "stale");
  const unreadable = checkReviewerCodeFreshness("/nonexistent-rmd-dir", {}, { checkServiceFreshness: behind(["src/run-task.ts"]) } as never);
  assert.equal(unreadable.status, "unreadable", "no git ancestry to read still withholds");
});

test("the guarded freshness check reads a run-task.ts past the 1 MiB exec buffer", () => {
  // The real file is ~2.5 MB; execFileSync's default maxBuffer (1 MiB) would make every read fail
  // and so every run-task.ts advance material again, silently.
  const padding = `export const PADDING = [\n${'  "................................................................",\n'.repeat(20_000)}];\n`;
  const origin = gitRepo({ kind: "run-task-origin", bare: true });
  const seed = gitRepo({ kind: "run-task-seed" });
  seed.addRemote("origin", origin.dir);
  const oldSha = commitRunTask(seed, `${BASE}\n${padding}`);
  seed.git("push", "--quiet", "origin", "HEAD:main");
  const reviewer = gitRepo({ kind: "run-task-reviewer", cloneFrom: origin.dir });
  const newSha = commitRunTask(seed, `${edit("  return view.runReview", '  return "x" + view.runReview')}\n${padding}`);
  seed.git("push", "--quiet", "origin", "HEAD:main");

  const freshness = checkReviewerCodeFreshness(reviewer.dir, { [SELF_SYNC_GUARD_ENV]: "1" });
  assert.deepEqual(freshness, { status: "fresh", codeSha: oldSha, originMainSha: newSha, advance: "immaterial" });
});

// W1-T14152. #19940 (93b21bd1b) changed only how the parent process finds, cuts, leases and removes the tree a
// stale-code review runs in, and it requeued 22 delivered verdicts. Those units never compute a verdict: the child
// `rmd review` in that tree does, and records its own HEAD as the reviewer code. So the walk does not enter them.

// Spliced in so the fixture-copy census does not count this fixture text as a test-owned repo builder.
const INSPECT_FRESH_REVIEWER_TREE = "inspectFreshReviewerWorktree";

const PLACEMENT_BASE = [
  'import { judge } from "./lib/review.js";',
  'import { withReviewerWorktreeLease } from "./lib/reviewer-worktree-lease.js";',
  "",
  "async function runReview(pr: string): Promise<string> {",
  "  return judge(pr) + judgeMore(pr) + verdictHelper();",
  "}",
  "",
  "function verdictHelper(): string {",
  '  return "verdict helper";',
  "}",
  "",
  "async function reviewCommand(pr: string): Promise<number> {",
  '  const seams: FreshTreeReviewSeams = { git: (args) => args.join(" "), spawnReview: spawnRmdReviewForFreshTree, worktreeRoot: "/wt" };',
  '  const fresh = buildFreshTreeReviewRunner("/repo", seams);',
  '  const approve = freshOriginMainTreeRunner("/repo", seams);',
  "  return (await runReview(pr)).length + ((await fresh(pr, [])) ?? 0) + (await approve()).length;",
  "}",
  "",
  "export type FreshTreeReviewSeams = {",
  "  git: (args: string[]) => string;",
  "  spawnReview: (worktree: string, args: string[]) => Promise<number>;",
  "  worktreeRoot: string;",
  "};",
  "",
  'export type FreshTreeTools = Omit<FreshTreeReviewSeams, "spawnReview">;',
  "",
  `function ${INSPECT_FRESH_REVIEWER_TREE}(path: string, git: (args: string[]) => string): "absent" | "reusable" {`,
  '  const listed = git(["worktree", "list", "--porcelain"]);',
  '  return listed.includes(path) ? "reusable" : "absent";',
  "}",
  "",
  'function freshTreeInspector(deps: FreshTreeTools): (path: string) => "absent" | "reusable" {',
  "  return (path) => inspectFreshReviewerWorktree(path, deps.git);",
  "}",
  "",
  "function perAttemptTreePath(deps: FreshTreeTools, sha: string): string {",
  "  return `${deps.worktreeRoot}/reviewer-${sha.slice(0, 12)}`;",
  "}",
  "",
  "function prepareFreshOriginMainTree(deps: FreshTreeTools, sha: string): string {",
  "  const path = perAttemptTreePath(deps, sha);",
  '  if (freshTreeInspector(deps)(path) === "absent") deps.git(["worktree", "add", "--detach", path, sha]);',
  "  makeTreeRunnable(deps, path);",
  "  return path;",
  "}",
  "",
  "function makeTreeRunnable(deps: FreshTreeTools, path: string): void {",
  '  deps.git(["-C", path, "link-node-modules"]);',
  "}",
  "",
  "async function removePerAttemptTree(deps: FreshTreeTools, path: string): Promise<void> {",
  '  deps.git(["worktree", "remove", path]);',
  "}",
  "",
  "export function buildFreshTreeReviewRunner(repoDir: string, deps: FreshTreeReviewSeams) {",
  "  return async (prArg: string, rest: string[]): Promise<number | undefined> => {",
  "    const tree = prepareFreshOriginMainTree(deps, repoDir);",
  "    return withReviewerWorktreeLease(tree, () => deps.spawnReview(tree, [prArg, ...rest]));",
  "  };",
  "}",
  "",
  "export function freshOriginMainTreeRunner(repoDir: string, deps: FreshTreeTools) {",
  "  return async (): Promise<string> => {",
  "    const tree = prepareFreshOriginMainTree(deps, repoDir);",
  "    await removePerAttemptTree(deps, tree);",
  "    return tree;",
  "  };",
  "}",
  "",
  "export function spawnRmdReviewForFreshTree(worktree: string, args: string[]): Promise<number> {",
  "  return Promise.resolve(spawnHelper(worktree, args));",
  "}",
  "",
  "function spawnHelper(worktree: string, args: string[]): number {",
  "  return worktree.length + args.length;",
  "}",
  "",
  "export function garden(): number {",
  "  return 1;",
  "}",
  "",
].join("\n");

const REVIEW_TS = "export const judge = (pr: string) => pr;\n";
const LEASE_TS = "export function withReviewerWorktreeLease<T>(path: string, action: () => T): T {\n  return action();\n}\n";
const LEASE_TS_AFTER = `${LEASE_TS}export class ReviewerWorktreeLeasedError extends Error {}\n`;

type Edit = readonly [from: string, to: string];

/** The #19940 shape: (a) hunks inside the placement units and the seams type, (b) a new class beside them and used
 *  only by them, (c) an import binding used only inside them. (d), the lease file, is a separate file change. */
const PLACEMENT_EDITS: readonly Edit[] = [
  ['import { withReviewerWorktreeLease } from', 'import { ReviewerWorktreeLeasedError, withReviewerWorktreeLease } from'],
  ["  worktreeRoot: string;\n", "  worktreeRoot: string;\n  removeWorktree?: (path: string) => Promise<void>;\n"],
  ['  const listed = git(["worktree", "list", "--porcelain"]);', '  const listed = git(["-C", path, "worktree", "list", "--porcelain"]);'],
  ["reviewer-${sha.slice(0, 12)}`", "reviewer-${sha.slice(0, 12)}-${process.pid}`"],
  ["function prepareFreshOriginMainTree(", "class UnprovenFreshTreeError extends Error {\n  constructor(path: string) {\n    super(`unproven ${path}`);\n  }\n}\n\nfunction prepareFreshOriginMainTree("],
  ["  const path = perAttemptTreePath(deps, sha);\n", "  const path = perAttemptTreePath(deps, sha);\n  if (path.length === 0) throw new UnprovenFreshTreeError(path);\n"],
  ['  deps.git(["worktree", "remove", path]);', '  deps.git(["worktree", "remove", "--force", path]);'],
  ["    return withReviewerWorktreeLease(tree, () => deps.spawnReview(tree, [prArg, ...rest]));",
    "    try {\n      return await withReviewerWorktreeLease(tree, () => deps.spawnReview(tree, [prArg, ...rest]));\n    } catch (err) {\n" +
    "      if (!(err instanceof ReviewerWorktreeLeasedError) && !(err instanceof UnprovenFreshTreeError)) throw err;\n      return undefined;\n    }"],
  ["    await removePerAttemptTree(deps, tree);", "    await removePerAttemptTree(deps, tree).catch(() => undefined);"],
];

function applyEdits(source: string, edits: readonly Edit[]): string {
  return edits.reduce((text, [from, to]) => {
    assert.equal(text.split(from).length, 2, `the fixture must contain ${JSON.stringify(from)} exactly once`);
    return text.replace(from, () => to);
  }, source);
}

interface Advance { runTask?: readonly Edit[]; review?: string; lease?: string; base?: string }

/** A real repository: reviewer code at a base commit, origin/main one commit on, judged by the production predicate. */
function placementAdvance(advance: Advance) {
  const repo = gitRepo({ kind: "t14152-placement" });
  const write = (path: string, text: string) => {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  const base = advance.base ?? PLACEMENT_BASE;
  write("src/run-task.ts", base);
  write("src/lib/review.ts", REVIEW_TS);
  write("src/lib/reviewer-worktree-lease.ts", LEASE_TS);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "reviewer code");
  const codeSha = repo.git("rev-parse", "HEAD");
  write("src/run-task.ts", applyEdits(base, advance.runTask ?? []));
  write("src/lib/review.ts", advance.review ?? REVIEW_TS);
  write("src/lib/reviewer-worktree-lease.ts", advance.lease ?? LEASE_TS);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "main advance");
  const originMainSha = repo.git("rev-parse", "HEAD");
  const git: GitRunner = (args) => repo.git(...args);
  return { freshness: reviewerCodeFreshnessAt(codeSha, originMainSha, git), codeSha, originMainSha };
}

const PLACEMENT_ONLY: Advance = { runTask: PLACEMENT_EDITS, lease: LEASE_TS_AFTER };

test("W1-T14152 criterion 1: an advance that changes only the tree-placement units and the lease file is immaterial", () => {
  const { freshness, codeSha, originMainSha } = placementAdvance(PLACEMENT_ONLY);
  assert.deepEqual(freshness, { status: "fresh", codeSha, originMainSha, advance: "immaterial" });
  // Each part alone is immaterial too, so no single part hides behind another.
  for (const [i, edit] of PLACEMENT_EDITS.entries()) {
    assert.equal(placementAdvance({ runTask: [edit] }).freshness.status, "fresh", `placement edit ${i}: ${edit[0]}`);
  }
  assert.equal(placementAdvance({ lease: LEASE_TS_AFTER }).freshness.status, "fresh", "the lease file alone");
});

const CLOSURE_CHANGES: ReadonlyArray<{ name: string; advance: Advance; path: string }> = [
  { name: "one code token in src/lib/review.ts", advance: { review: REVIEW_TS.replace("=> pr;", "=> pr.trim();") }, path: "src/lib/review.ts" },
  { name: "a hunk in runReview", path: "src/run-task.ts",
    advance: { runTask: [["  return judge(pr) + judgeMore(pr) + verdictHelper();", '  return judge(pr) + judgeMore(pr) + verdictHelper() + "!";']] } },
  { name: "a hunk in a helper only runReview calls", path: "src/run-task.ts",
    advance: { runTask: [['  return "verdict helper";', '  return "verdict helper, changed";']] } },
  { name: "a hunk in reviewCommand", path: "src/run-task.ts",
    advance: { runTask: [['  const fresh = buildFreshTreeReviewRunner("/repo", seams);', '  const fresh = buildFreshTreeReviewRunner("/other", seams);']] } },
  { name: "a hunk in spawnRmdReviewForFreshTree", path: "src/run-task.ts",
    advance: { runTask: [["  return Promise.resolve(spawnHelper(worktree, args));", '  return Promise.resolve(spawnHelper(worktree, [...args, "--json"]));']] } },
  { name: "a hunk in a toolchain helper only the placement units call", path: "src/run-task.ts",
    advance: { runTask: [['  deps.git(["-C", path, "link-node-modules"]);', '  deps.git(["-C", path, "link-node-modules", "--proof"]);']] } },
  { name: "an import line that adds a binding runReview uses", path: "src/run-task.ts",
    advance: { runTask: [['import { judge } from "./lib/review.js";', 'import { judge, judgeMore } from "./lib/review.js";']] } },
  { name: "src/lib/reviewer-worktree-lease.ts together with src/lib/review.ts", path: "src/lib/review.ts",
    advance: { lease: LEASE_TS_AFTER, review: REVIEW_TS.replace("=> pr;", "=> pr.trim();") } },
];

test("W1-T14152 criterion 2: a change inside the verdict closure still makes the reviewer code stale", () => {
  for (const { name, advance, path } of CLOSURE_CHANGES) {
    const together: Advance = {
      runTask: [...PLACEMENT_EDITS, ...(advance.runTask ?? [])], lease: LEASE_TS_AFTER, ...(advance.review ? { review: advance.review } : {}),
    };
    for (const [form, shape] of [["alone", advance], ["with the placement changes", together]] as const) {
      const { freshness } = placementAdvance(shape);
      assert.equal(freshness.status, "stale", `${name}, ${form}: ${JSON.stringify(freshness)}`);
      assert.ok((freshness as { changedPaths: string[] }).changedPaths.includes(path), `${name}, ${form}: ${path} is named`);
    }
  }

  // In the real src/run-task.ts the walk passes through the placement units, so the toolchain code they call stays reached.
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const scan = reviewPathSpans(source);
  assert.ok("spans" in scan, "the real src/run-task.ts must scan");
  const reached = new Set(topLevelUnits(source)!.filter((unit) => !unit.imports && scan.spans.some(([from]) => from === unit.start))
    .flatMap((unit) => unit.names!));
  for (const name of ["makeTreeRunnable", "prepareWorktreeToolchain", "pathOccupied"]) assert.ok(reached.has(name), `${name} stays on the review path`);
  for (const name of REVIEW_TREE_PLACEMENT_SYMBOLS_IN_RUN_TASK) assert.equal(reached.has(name), false, `${name} is passed through, not counted`);
});

test("W1-T14152 criterion 3: the tree-placement set fails closed", () => {
  // A placement unit under a name the set does not hold, and reached from reviewCommand, is walked as today.
  const renamed = PLACEMENT_BASE.replaceAll("freshOriginMainTreeRunner", "approveTreeRunner");
  assert.ok(!(REVIEW_TREE_PLACEMENT_SYMBOLS_IN_RUN_TASK as readonly string[]).includes("approveTreeRunner"));
  const hunk: Edit = ["    await removePerAttemptTree(deps, tree);", "    await removePerAttemptTree(deps, tree).catch(() => undefined);"];
  assert.equal(placementAdvance({ runTask: [hunk] }).freshness.status, "fresh", "under its set name the same hunk is immaterial");
  const renamedFreshness = placementAdvance({ base: renamed, runTask: [hunk] }).freshness;
  assert.equal(renamedFreshness.status, "stale", JSON.stringify(renamedFreshness));
  assert.deepEqual((renamedFreshness as { changedPaths: string[] }).changedPaths, ["src/run-task.ts"]);
  const reason = runTaskAdvanceTouchesReviewPath(...reviewPathShas(renamed, applyEdits(renamed, [hunk])));
  assert.match(reason.reason, /meets the review path/);

  // A name the set holds that the source lacks changes nothing: the advance is judged as if the set did not name it.
  const absent = REVIEW_TREE_PLACEMENT_SYMBOLS_IN_RUN_TASK.filter((name) => !new RegExp(`\\b${name}\\b`).test(PLACEMENT_BASE));
  assert.ok(absent.includes("inPerAttemptTree"), `the fixture lacks some set names: ${absent.join(", ")}`);
  assert.ok("spans" in reviewPathSpans(PLACEMENT_BASE), "a source without every set name still scans");
  assert.equal(placementAdvance({ runTask: [['  return 1;', '  return 2;']] }).freshness.status, "fresh", "an unreached hunk stays immaterial");
  assert.equal(placementAdvance(PLACEMENT_ONLY).freshness.status, "fresh", "the placement-only advance stays immaterial");

  // A missing review root still reads as material, as on origin/main.
  const rootless = PLACEMENT_BASE.replaceAll("runReview", "runVerdict");
  const missing = runTaskAdvanceTouchesReviewPath(...reviewPathShas(rootless, applyEdits(rootless, [['  return 1;', '  return 2;']])));
  assert.equal(missing.touchesReviewPath, true);
  assert.match(missing.reason, /review path symbol runReview not found/);
  assert.equal(placementAdvance({ base: rootless, runTask: [['  return 1;', '  return 2;']] }).freshness.status, "stale");
});

function reviewPathShas(before: string, after: string): [GitRunner, string, string] {
  const repo = gitRepo({ kind: "t14152-root" });
  const codeSha = commitRunTask(repo, before);
  const originMainSha = commitRunTask(repo, after);
  return [(args) => repo.git(...args), codeSha, originMainSha];
}

test("W1-T14152 criterion 4: the review child's argument list stays pinned in the real src/run-task.ts", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const units = topLevelUnits(source);
  assert.ok(units, "the real src/run-task.ts must scan");
  const lines = source.split("\n");
  const placement = new Set<string>(REVIEW_TREE_PLACEMENT_SYMBOLS_IN_RUN_TASK);
  const named = units.filter((unit) => !unit.imports && unit.names?.some((name) => placement.has(name)));
  for (const name of placement) assert.ok(named.some((unit) => unit.names!.includes(name)), `${name} is declared in src/run-task.ts`);
  let pinned = 0;
  for (const unit of named) {
    const name = unit.names![0];
    const code = lines.slice(unit.start - 1, unit.end).join("\n").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const calls = [...code.matchAll(/deps\.spawnReview\(\s*([^,()]+),\s*(\[[^\]]*\])/g)];
    assert.equal(calls.length, (code.match(/\bspawnReview\s*\(/g) ?? []).length, `${name}: every spawnReview call is deps.spawnReview(tree, [...])`);
    for (const call of calls) {
      assert.equal(name, "buildFreshTreeReviewRunner", `${name} calls spawnReview; only buildFreshTreeReviewRunner may`);
      assert.equal(call[2].trim(), "[prArg, ...rest]", `${name} passes ${call[2]} to the review child`);
      pinned++;
    }
    assert.doesNotMatch(code, /(?<![\w$.])spawn(?:Sync)?\s*\(/, `${name} spawns a process`);
  }
  assert.ok(pinned >= 1, "buildFreshTreeReviewRunner must hand the review child its arguments, or this pin proves nothing");
});
