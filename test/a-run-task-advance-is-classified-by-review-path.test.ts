import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  SELF_SYNC_GUARD_ENV,
  checkReviewerCodeFreshness,
  reviewPathSpans,
  runTaskAdvanceTouchesReviewPath,
  type GitRunner,
} from "../src/lib/self-sync.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

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
  assert.equal(unreadable.status, "stale", "no git to read the advance with still withholds");
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
