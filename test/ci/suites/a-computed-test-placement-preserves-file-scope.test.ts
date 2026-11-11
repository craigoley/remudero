/**
 * W1-T11501 — a filed test can ship in the folder its CONTENTS compute without a placement amendment.
 *
 * `rmd test-place` computes a test's folder from the file's imports, so a shard that declares a test before it exists
 * names a sketch. Every fixture here is a REAL private git checkout (a clone, so `origin/main` exists) driven through
 * the production callers: commitWorkerEdits (worker staging), pushScopeOutOfScopeFiles (the push guard),
 * fixRungScopeStandDownReason (the fix rung's guard) and judgeReview/reviewScopeContext (the review advisory). The
 * folder is whatever the real placement engine answers over the fixture's own copy of scripts/test-placement.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pushScopeOutOfScopeFiles } from "#src/cli/commands/run-task-verb.js";
import { judgeReview, reviewPlacementAdmitted, reviewScopeContext } from "#src/lib/review.js";
import { placePaths } from "#src/lib/test-placement.js";
import { computedPlacementAdmission, GREP_PROOF_PATH_RE, observeComputedPlacement, resolveTestPath } from "#src/lib/test-path-resolver.js";
import { commitWorkerEdits, fixRungScopeStandDownReason, scopeGuardOutOfScopeFiles } from "#test/helpers/run-task-test.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NAME = "fixture-feature.test.ts";
const DECLARED_TEST = `test/declared-sketch/${NAME}`;
const MARKER = "FIXTURE-MARKER-ONE";
const IMPL = "src/lib/impl.ts";
const PROOFS = [`grep: ${MARKER} in ${DECLARED_TEST}`, "grep: some other pattern in src/lib/impl.ts"];
const ACCEPTANCE = PROOFS.map((proof, i) => ({ claim: `claim ${i}`, proof }));
const FILES = [IMPL, DECLARED_TEST];

const body = (marker: string | undefined): string =>
  `import { sameTestFile } from "#src/lib/test-path-resolver.js";\n${marker === undefined ? "" : `// ${marker}\n`}` +
  `export const answer = sameTestFile("a", "a");\n`;

interface Fixture {
  readonly wt: GitRepo;
  /** The folder the real placement engine computes for the fixture's candidate contents. */
  readonly folder: string;
  /** The candidate's repo path at the computed folder. */
  readonly home: string;
}

function write(wt: GitRepo, path: string, text: string): void {
  mkdirSync(dirname(join(wt.dir, path)), { recursive: true });
  writeFileSync(join(wt.dir, path), text);
}

/** A clone of a seeded upstream carrying the placement data, a base test and one src file; nothing declared exists. */
function fixture(): Fixture {
  const upstream = gitRepo({ kind: "placement-upstream", branch: "main" });
  cpSync(join(REPO_ROOT, "scripts", "test-placement"), join(upstream.dir, "scripts", "test-placement"), { recursive: true });
  write(upstream, IMPL, "export const impl = 1;\n");
  write(upstream, "test/existing/base-existing.test.ts", body(undefined));
  upstream.git("add", "-A");
  upstream.git("commit", "-m", "seed");
  const wt = gitRepo({ kind: "placement-wt", cloneFrom: upstream.dir });
  wt.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  wt.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  write(wt, "test/probe/probe.test.ts", body(MARKER));
  const folder = placePaths(wt.dir, ["test/probe/probe.test.ts"], wt.git("rev-parse", "HEAD^{tree}"))[0]!.placement.folder;
  rmSync(join(wt.dir, "test/probe"), { recursive: true, force: true });
  return { wt, folder, home: `test/${folder}/${NAME}` };
}

const stage = (wt: GitRepo, declared: readonly string[] = FILES) =>
  commitWorkerEdits(wt.dir, declared, "feat: fixture", {}, ACCEPTANCE);

test("W1-T11501 criterion 1: the unique same-basename test at the computed folder is staged, pushed and resolved", () => {
  const { wt, home, folder } = fixture();
  assert.notEqual(`test/${folder}`, dirname(DECLARED_TEST), "the sketch folder differs from the computed one");
  write(wt, IMPL, "export const impl = 2;\n");
  write(wt, home, body(MARKER));

  const staged = stage(wt);
  assert.equal(staged.committed, true, JSON.stringify(staged));
  assert.deepEqual(staged.undeclared, []);
  assert.ok(wt.git("show", "--name-only", "--format=", "HEAD").split("\n").includes(home), "the computed-folder test is committed");

  // Push scope: the declared-scope comparison over the branch diff against origin/main.
  const diffFiles = wt.git("diff", "--name-only", "origin/main...HEAD").split("\n");
  const task = { files: FILES, acceptance: ACCEPTANCE };
  assert.deepEqual(scopeGuardOutOfScopeFiles(diffFiles, FILES), [home], "exact-path matching alone flags the file");
  assert.deepEqual(pushScopeOutOfScopeFiles(wt.dir, diffFiles, task, []), []);

  // The committed original-path proof resolves by unique basename; the shard's proofs were never rewritten.
  assert.deepEqual(resolveTestPath(DECLARED_TEST, { root: wt.dir }), { path: home, how: "basename" });
  assert.deepEqual(ACCEPTANCE.map((c) => c.proof), PROOFS);
});

test("W1-T11501 criterion 1: a candidate is judged on its contents, so a marker-bearing file in the computed folder admits", () => {
  const { wt, home } = fixture();
  write(wt, home, body(MARKER));
  const outcome = observeComputedPlacement({ root: wt.dir, declaredFiles: FILES, proofs: PROOFS, candidates: [home] });
  assert.deepEqual([...outcome.admitted], [home]);
  assert.equal(outcome.refusals.size, 0);
});

test("W1-T11501 criterion 2: wrong folder, renamed basename, changed or missing marker stay refused", () => {
  const { wt, home } = fixture();
  const observe = (candidates: string[], proofs: readonly string[] = PROOFS) =>
    observeComputedPlacement({ root: wt.dir, declaredFiles: FILES, proofs, candidates });

  const wrong = `test/wrong-folder/${NAME}`;
  write(wt, wrong, body(MARKER));
  const wrongOutcome = observe([wrong]);
  assert.equal(wrongOutcome.admitted.size, 0);
  assert.match(wrongOutcome.refusals.get(wrong)!, /computed folder is test\/.+\/, not test\/wrong-folder\//);

  const renamed = `${home.replace(NAME, "renamed.test.ts")}`;
  write(wt, renamed, body(MARKER));
  assert.equal(observe([renamed]).admitted.size, 0, "a different basename is a different test");

  write(wt, home, body("a changed marker"));
  assert.match(observe([home]).refusals.get(home)!, /marker\(s\) not preserved: FIXTURE-MARKER-ONE/);

  write(wt, home, body(MARKER));
  assert.match(observe([home], ["grep: other in src/lib/impl.ts"]).refusals.get(home)!, /no criterion marker/);
  assert.equal(observe([home]).admitted.size, 1, "control: the marker-bearing file in the computed folder admits");

  // The proof split: a pattern with no path token yields no marker, and a pattern plus path yields both parts.
  assert.equal(GREP_PROOF_PATH_RE.test("a pattern with no path token"), false);
  assert.equal(GREP_PROOF_PATH_RE.test(`${MARKER} in ${DECLARED_TEST}`), true);
  assert.deepEqual(GREP_PROOF_PATH_RE.exec(`${MARKER} in ${DECLARED_TEST}`)?.slice(1), [MARKER, DECLARED_TEST]);
});

test("W1-T11501 criterion 2: duplicate candidate, symlink, fixture, traversal and unreadable placement stay refused", () => {
  const { wt, home, folder } = fixture();
  write(wt, home, body(MARKER));
  const observe = (candidates: string[], extra: Partial<Parameters<typeof observeComputedPlacement>[0]> = {}) =>
    observeComputedPlacement({ root: wt.dir, declaredFiles: FILES, proofs: PROOFS, candidates, ...extra });

  // duplicate: the same basename already tracked elsewhere, and a second new candidate of that basename.
  const tracked = ["test/existing/base-existing.test.ts", `test/elsewhere/${NAME}`];
  assert.match(observe([home], { baseTracked: tracked }).refusals.get(home)!, /not unique/);
  assert.match(observe([home], { baseTracked: [DECLARED_TEST] }).refusals.get(home)!, /declared test already exists/);
  const second = `test/second-copy/${NAME}`;
  write(wt, second, body(MARKER));
  const twin = observe([home, second]);
  assert.equal(twin.admitted.size, 0);
  assert.match(twin.refusals.get(home)!, /not unique/);

  // symlink at the computed folder to a regular file.
  const linkHome = `test/${folder}/link-${NAME}`;
  write(wt, `test/real/${NAME}`, body(MARKER));
  rmSync(join(wt.dir, home));
  symlinkSync(join(wt.dir, `test/real/${NAME}`), join(wt.dir, home));
  const linked = observe([home]);
  assert.equal(linked.admitted.size, 0);
  assert.match(linked.refusals.get(home)!, /not a readable regular file/);
  assert.equal(linkHome.length > 0, true);

  // fixture and traversal shapes are not eligible paths at all.
  for (const path of [`test/fixtures/${NAME}`, `test/${folder}/../${NAME}`]) {
    const declaredFiles = [path, IMPL];
    const outcome = observeComputedPlacement({ root: wt.dir, declaredFiles, proofs: PROOFS, candidates: [path] });
    assert.equal(outcome.admitted.size, 0, path);
  }

  // unreadable placement: the engine throws, and a base tree that cannot be read.
  const throwing = computedPlacementAdmission([home], {
    declaredFiles: FILES, proofs: PROOFS, baseTracked: [], read: () => body(MARKER),
    folderOf: () => { throw new Error("placement data unreadable"); },
  });
  assert.equal(throwing.admitted.size, 0);
  assert.match(throwing.refusals.get(home)!, /placement could not be computed \(placement data unreadable\)/);
  const noFolder = computedPlacementAdmission([home], {
    declaredFiles: FILES, proofs: PROOFS, baseTracked: [], read: () => body(MARKER), folderOf: () => undefined,
  });
  assert.equal(noFolder.admitted.size, 0);
  const badTree = observe([home], { baseRev: "no-such-rev" });
  assert.equal(badTree.admitted.size, 0);
  assert.match(badTree.refusals.get(home)!, /the base tree could not be read/);
});

test("W1-T11501 criterion 2: an undeclared production edit and an empty scope stay refused", () => {
  const { wt, home } = fixture();
  write(wt, IMPL, "export const impl = 3;\n");
  write(wt, "src/lib/rogue.ts", "export const rogue = true;\n");
  write(wt, home, body(MARKER));
  const staged = stage(wt);
  assert.equal(staged.committed, true);
  assert.deepEqual(staged.undeclared, ["src/lib/rogue.ts"], "production code outside files: is still undeclared");
  const committed = wt.git("show", "--name-only", "--format=", "HEAD").split("\n");
  assert.ok(committed.includes(home) && committed.includes(IMPL) && !committed.includes("src/lib/rogue.ts"));

  const empty = fixture();
  write(empty.wt, empty.home, body(MARKER));
  const none = stage(empty.wt, []);
  assert.equal(none.committed, false);
  assert.match(none.reason ?? "", /declares no files/);
  const task = { files: [], acceptance: ACCEPTANCE };
  assert.deepEqual(pushScopeOutOfScopeFiles(empty.wt.dir, [empty.home], task, []), [empty.home]);
});

test("W1-T11501 criterion 2: a wrong-folder file is left unstaged by the real staging path", () => {
  const { wt } = fixture();
  const wrong = `test/wrong-folder/${NAME}`;
  write(wt, IMPL, "export const impl = 4;\n");
  write(wt, wrong, body(MARKER));
  const staged = stage(wt);
  assert.deepEqual(staged.undeclared, [wrong]);
});

test("W1-T11501 criterion 3: staging, push scope, fix scope and review scope share one narrow predicate", () => {
  const { wt, home } = fixture();
  write(wt, IMPL, "export const impl = 5;\n");
  write(wt, home, body(MARKER));
  assert.equal(stage(wt).committed, true);
  const diffFiles = wt.git("diff", "--name-only", "origin/main...HEAD").split("\n");
  assert.deepEqual(diffFiles.sort(), [home, IMPL].sort());

  // fix rung: without the placement evidence the file is new out-of-scope; with it nothing is.
  const placement = { root: wt.dir, proofs: PROOFS };
  const bare = fixRungScopeStandDownReason(diffFiles, [], FILES);
  assert.deepEqual(bare?.newOutOfScopePaths, [home]);
  assert.equal(fixRungScopeStandDownReason(diffFiles, [], FILES, [], [], [], placement), undefined);

  // push guard: the same set.
  assert.deepEqual(pushScopeOutOfScopeFiles(wt.dir, diffFiles, { files: FILES, acceptance: ACCEPTANCE }, []), []);

  // review: the scope advisory subtracts the same admitted set, and the ordinary floor still runs.
  const diff = wt.git("diff", "origin/main...HEAD");
  const criteria = [{ claim: "the change is safe", proof: "widget frobnicate implemented" }, ...ACCEPTANCE];
  const admitted = reviewPlacementAdmitted(diff, wt.dir, FILES, ACCEPTANCE);
  assert.deepEqual([...admitted], [home]);
  assert.deepEqual(reviewScopeContext(diff, FILES).widenedFiles, [home]);
  assert.deepEqual(reviewScopeContext(diff, FILES, admitted).widenedFiles, []);
  const report = "REPORT\n- widget frobnicate implemented and verified.\nPR_URL: https://github.com/o/r/pull/1";
  const judged = judgeReview(criteria, { diff, report, taskDeclaredFiles: FILES, headCheckoutDir: wt.dir });
  assert.equal(judged.unwiredAdvisories?.find((a) => a.reasonCode === "scope_violation"), undefined);
  const withoutCheckout = judgeReview(criteria, { diff, report, taskDeclaredFiles: FILES });
  assert.deepEqual(withoutCheckout.unwiredAdvisories?.find((a) => a.reasonCode === "scope_violation")?.symbols, [home]);
});

test("W1-T11501 criterion 3: a non-test path keeps exact matching and the review admits nothing without a checkout", () => {
  const { wt, home } = fixture();
  write(wt, IMPL, "export const impl = 6;\n");
  write(wt, home, body(MARKER));
  stage(wt);
  const diff = wt.git("diff", "origin/main...HEAD");
  assert.equal(reviewPlacementAdmitted(diff, undefined, FILES, ACCEPTANCE).size, 0);
  assert.equal(reviewPlacementAdmitted(diff, wt.dir, [IMPL], ACCEPTANCE).size, 0, "no declared test, nothing to admit");
  assert.deepEqual(pushScopeOutOfScopeFiles(wt.dir, ["src/lib/other.ts", home], { files: FILES, acceptance: ACCEPTANCE }, []),
    ["src/lib/other.ts"]);
});
