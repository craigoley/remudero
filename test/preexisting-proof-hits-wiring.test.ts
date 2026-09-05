/**
 * test/preexisting-proof-hits-wiring.test.ts — impl-GE.
 *
 * THE DEFECT (recon-GB). `preexistingProofHits` withdraws a `grep:` proof's positive override when
 * the same pattern ALREADY matched the PR's merge-base — a proof that could not have failed proves
 * nothing. It has existed and been unit-tested since W1-T273, and it returns `false` without a
 * `baseCwd` (review.ts). **No production caller ever supplied one**, so it produced `executed_stale`
 * exactly zero times in 1,180 verdicts. The guard was decoration; this wires it.
 *
 * TRAP 2 — WHAT THIS SUITE DRIVES. Every test below runs `buildBaseProofDir`'s **real default
 * implementation**: real `git merge-base`, real `git show`, real `mkdtemp`/`writeFile`, against a
 * real repository created here with real commits. No injected `mergeBase`, no stubbed `showBlob`,
 * no faked filesystem. That is deliberate: a session shipped a plan-reloader today whose production
 * default threw on every tick because all six of its tests injected the seam, so nothing ever
 * exercised the real path. The injectable deps on `buildBaseProofDir` exist for OTHER callers'
 * convenience and are **not** used here.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildBaseProofDir, type BaseProofDir } from "../src/run-task.js";
import { execWhitelistedProof, parseWhitelistedProof, preexistingProofHits } from "../src/lib/review.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });

/**
 * A REAL repo with a real `origin/main` and a real branch commit on top, so `git merge-base
 * origin/main HEAD` resolves for real. Returns the working directory that stands in for the
 * reviewer's materialised head worktree.
 */
function realRepoWithBranch(baseFiles: Record<string, string>, headFiles: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ge-repo-"));
  git(dir, "init", "--quiet", "-b", "main");
  for (const [rel, body] of Object.entries(baseFiles)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "base");
  // A real remote-tracking ref, which is what `merge-base origin/main HEAD` needs.
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  for (const [rel, body] of Object.entries(headFiles)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  git(dir, "add", "-A");
  // `--allow-empty`: a case whose head is byte-identical to its base still needs a real
  // second commit so `merge-base origin/main HEAD` has two distinct refs to resolve.
  git(dir, "commit", "--quiet", "--allow-empty", "-m", "branch work");
  return dir;
}

/** (R-11) The base is now a real WORKTREE of the fixture repo: deregister it before the repo goes. */
function dropBase(head: string, built: BaseProofDir | undefined): void {
  if (built?.baseIsCheckout && built.baseCheckoutDir) {
    try {
      git(head, "worktree", "remove", "--force", built.baseCheckoutDir);
    } catch {
      /* best-effort; rmSync below still clears the dir */
    }
  }
  if (built?.baseCheckoutDir) rmSync(built.baseCheckoutDir, { recursive: true, force: true });
}

/** The production judgement, end to end: build the base dir for real, then ask the real guard. */
function staleViaRealPath(head: string, proof: string): { stale: boolean; built: BaseProofDir } {
  const criteria = [{ proof }];
  // REAL default deps — no injection. W1-T460 split the return into
  // (baseCheckoutDir, baseUnreadablePaths); R-11 added `baseIsCheckout`. Every case below reads
  // at the base perfectly well, and the base is a real detached worktree at the merge-base.
  const built = buildBaseProofDir(criteria, head);
  assert.equal(built.baseIsCheckout, true, "the real default path adds a worktree — no fallback here");
  const whitelisted = parseWhitelistedProof(proof);
  assert.ok(whitelisted, `the proof must compile: ${proof}`);
  // Sanity: the proof really does pass on the HEAD, or "stale" would be meaningless.
  assert.equal(execWhitelistedProof(whitelisted, head), "pass", "precondition: the proof passes on the head");
  return {
    stale: preexistingProofHits(whitelisted, execWhitelistedProof, built.baseCheckoutDir, built.baseUnreadablePaths, built.baseIsCheckout),
    built,
  };
}

// ── (6) A PROOF THAT ALREADY MATCHED ON THE BASE IS FLAGGED ──────────────────

test("a grep proof whose pattern ALREADY matched the merge-base is flagged stale", () => {
  // The measured incident's exact shape: the symbol was already present in an unrelated position,
  // so the proof exited 0 on the commit BEFORE the work — it could not have failed.
  const head = realRepoWithBranch(
    { "src/app.ts": "import { workerKeychainPaths } from './x.js';\n" },
    { "src/app.ts": "import { workerKeychainPaths } from './x.js';\nexport function workerKeychainPaths() {}\n" },
  );
  let built: BaseProofDir | undefined;
  try {
    const r = staleViaRealPath(head, "grep: workerKeychainPaths in src/app.ts");
    built = r.built;
    assert.equal(r.stale, true);
  } finally {
    dropBase(head, built);
    rmSync(head, { recursive: true, force: true });
  }
});

// ── (7) A PROOF THAT DID NOT MATCH ON THE BASE IS CLEAN ──────────────────────

test("a grep proof absent from the merge-base is NOT flagged — it discriminates", () => {
  const head = realRepoWithBranch(
    { "src/app.ts": "export const unrelated = 1;\n" },
    { "src/app.ts": "export const unrelated = 1;\nexport function brandNewSymbol() {}\n" },
  );
  let built: BaseProofDir | undefined;
  try {
    const r = staleViaRealPath(head, "grep: brandNewSymbol in src/app.ts");
    built = r.built;
    assert.equal(r.stale, false);
  } finally {
    dropBase(head, built);
    rmSync(head, { recursive: true, force: true });
  }
});

// ── (8) THE FORWARD-REFERENCE LOCK ───────────────────────────────────────────

test("a proof naming a file the BRANCH CREATES is not flagged — absent is the opposite of stale", () => {
  // "Did not exist before" and "already matched before" are opposite conditions; only the second is
  // the defect. `git show <base>:<newfile>` fails, the blob is simply not written, and grep finds
  // nothing in the base dir.
  const head = realRepoWithBranch(
    { "src/app.ts": "export const unrelated = 1;\n" },
    { "src/app.ts": "export const unrelated = 1;\n", "src/brand-new.ts": "export function freshThing() {}\n" },
  );
  let built: BaseProofDir | undefined;
  try {
    const r = staleViaRealPath(head, "grep: freshThing in src/brand-new.ts");
    built = r.built;
    assert.equal(r.stale, false, "a created file is never stale");
    assert.equal(existsSync(join(built.baseCheckoutDir!, "src/brand-new.ts")), false, "the worktree at the base simply lacks the file");
  } finally {
    dropBase(head, built);
    rmSync(head, { recursive: true, force: true });
  }
});

// ── the builder's own contract, still on the REAL default path ───────────────

test("buildBaseProofDir yields a REAL CHECKOUT of the merge-base — every base path is there, a `unit test:` proof's file included (R-11)", () => {
  const head = realRepoWithBranch(
    { "src/a.ts": "alpha\n", "src/b.ts": "beta\n", "test/x.test.ts": "// present at the base\n" },
    { "src/a.ts": "alpha\n", "src/b.ts": "beta\n", "test/x.test.ts": "// present at the base\n" },
  );
  let built: BaseProofDir | undefined;
  try {
    built = buildBaseProofDir(
      [{ proof: "grep: alpha in src/a.ts" }, { proof: "unit test: test/x.test.ts" }, { proof: "some prose claim" }],
      head,
    );
    const { baseCheckoutDir: dir, baseUnreadablePaths: unreadable } = built;
    assert.ok(dir, "a dialect proof means a base dir");
    assert.equal(built.baseIsCheckout, true, "…and it is a worktree, not a blob directory");
    assert.deepEqual([...unreadable], [], "W1-T460: a checkout has no per-blob read to fail");
    assert.equal(readFileSync(join(dir, "src/a.ts"), "utf8"), "alpha\n", "the named path is at the base");
    assert.equal(existsSync(join(dir, "src/b.ts")), true, "so is a path no proof names — it is a checkout, not a materialisation");
    assert.equal(existsSync(join(dir, "test/x.test.ts")), true, "a `unit test:` proof's file is there to be re-run (the R-11 defect was that it never was)");
    assert.equal(existsSync(join(dir, ".git")), true, "a linked worktree carries its .git pointer");
  } finally {
    dropBase(head, built);
    rmSync(head, { recursive: true, force: true });
  }
});

test("no DIALECT proof ⇒ no base dir at all ⇒ the check stays inert; a `unit test:` proof alone now earns one (R-11)", () => {
  const head = realRepoWithBranch({ "src/a.ts": "alpha\n" }, { "src/a.ts": "alpha\n" });
  let built: BaseProofDir | undefined;
  try {
    assert.equal(buildBaseProofDir([{ proof: "just prose" }], head).baseCheckoutDir, undefined);
    assert.equal(buildBaseProofDir([], head).baseCheckoutDir, undefined);
    built = buildBaseProofDir([{ proof: "unit test: test/x.test.ts" }], head);
    assert.ok(built.baseCheckoutDir, "the pre-R-11 shape returned undefined here, so no unit test was ever checked against a base");
    assert.equal(built.baseIsCheckout, true);
  } finally {
    dropBase(head, built);
    rmSync(head, { recursive: true, force: true });
  }
});

test("an EMPTY merge-base yields no dir either — `git merge-base` can succeed and print nothing", () => {
  // The other half of the unresolvable case, and a distinct arm from the throwing one below: the
  // command exits 0 but resolves no commit (unrelated histories, a truncated read). Treating "" as
  // a rev would ask `git show :<path>` for the INDEX, quietly materialising head content as if it
  // were the base — which would make every proof look stale. Degrading to "no signal" is required.
  const head = mkdtempSync(join(tmpdir(), "ge-emptybase-"));
  try {
    const built = buildBaseProofDir([{ proof: "grep: x in src/a.ts" }], head, { mergeBase: () => "" });
    assert.equal(built.baseCheckoutDir, undefined);
    assert.deepEqual([...built.baseUnreadablePaths], [], "no base to read from is not a per-proof read failure");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

test("an unresolvable merge-base yields no dir rather than throwing inside a review", () => {
  // A directory that is not a git repo at all — `git merge-base` fails. Degrading to "no signal" is
  // required: a false positive strands a PR, a missed one costs only the old behaviour.
  const notARepo = mkdtempSync(join(tmpdir(), "ge-norepo-"));
  try {
    assert.equal(buildBaseProofDir([{ proof: "grep: x in src/a.ts" }], notARepo).baseCheckoutDir, undefined);
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

// ── THE WIRING ITSELF — the half a unit test cannot reach ────────────────────

test("the production call site actually supplies baseCheckoutDir — the gap that made this a no-op", () => {
  // WHY THIS TEST IS SOURCE-TEXT AND SAYS SO. Reverting the CALL SITE to `baseCheckoutDir:
  // undefined` leaves every test above green, because they drive `buildBaseProofDir` directly —
  // which is precisely the defect being fixed: a guard that works and is never reached. Driving
  // `reviewCommand` end to end would need a gh gateway, so this pins the wiring the only other way
  // available. It asserts a CALL, not prose: `laneWindow`-style, the same shape
  // test/arm-outcome-five-sites.test.ts uses for the identical "is this lane actually wired" question.
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");

  // W1-T460 turned the old one-line ternary into a one-line SPREAD, because the builder now
  // returns two facts (the dir AND the paths whose blob could not be read) named as the evidence
  // fields they become. The QUESTION this pin asks is unchanged: is it actually called with the
  // materialised head worktree, and does its result actually reach the evidence?
  // R-11 turned the spread back into three NAMED fields (the dir, W1-T460's unreadable set, and
  // whether the dir is a checkout), because the builder's result now also drives TEARDOWN of the
  // base worktree, which a spread onto the evidence could not express.
  assert.match(
    src,
    /const baseProof = worktreePath \? buildBaseProofDir\(criteria, worktreePath\) : undefined/,
    "reviewCommand must build the base facts from its own materialised head worktree",
  );
  assert.match(src, /baseCheckoutDir:\s*baseProof\?\.baseCheckoutDir/, "…and hand the dir to runReview");
  assert.match(src, /baseIsCheckout:\s*baseProof\?\.baseIsCheckout/, "…with the checkout fact beside it (R-11)");
  assert.match(
    src,
    /baseCheckoutDir:\s*args\.baseCheckoutDir/,
    "and runReview must forward it into the evidence judgeReview reads",
  );
  assert.match(src, /baseIsCheckout:\s*args\.baseIsCheckout/, "the checkout fact too");
  // The forwarding is worthless if judgeReview does not consume it — pin that end too.
  const review = readFileSync(join(REPO_ROOT, "src", "lib", "review.ts"), "utf8");
  assert.match(review, /baseCwd:\s*evidence\.baseCheckoutDir/, "judgeReview must put it on the exec context");
  assert.match(review, /baseIsCheckout:\s*evidence\.baseIsCheckout/, "and the checkout fact with it — the classifier fails closed without it");
});
