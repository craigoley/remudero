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

import { buildBaseProofDir } from "../src/run-task.js";
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

/** The production judgement, end to end: build the base dir for real, then ask the real guard. */
function staleViaRealPath(head: string, proof: string): boolean {
  const criteria = [{ proof }];
  // REAL default deps — no injection. W1-T460 split the return into
  // (baseCheckoutDir, baseUnreadablePaths); this suite is about the DIR half, and every case below
  // reads at the base perfectly well.
  const baseDir = buildBaseProofDir(criteria, head).baseCheckoutDir;
  const whitelisted = parseWhitelistedProof(proof);
  assert.ok(whitelisted, `the proof must compile: ${proof}`);
  // Sanity: the proof really does pass on the HEAD, or "stale" would be meaningless.
  assert.equal(execWhitelistedProof(whitelisted, head), "pass", "precondition: the proof passes on the head");
  return preexistingProofHits(whitelisted, execWhitelistedProof, baseDir);
}

// ── (6) A PROOF THAT ALREADY MATCHED ON THE BASE IS FLAGGED ──────────────────

test("a grep proof whose pattern ALREADY matched the merge-base is flagged stale", () => {
  // The measured incident's exact shape: the symbol was already present in an unrelated position,
  // so the proof exited 0 on the commit BEFORE the work — it could not have failed.
  const head = realRepoWithBranch(
    { "src/app.ts": "import { workerKeychainPaths } from './x.js';\n" },
    { "src/app.ts": "import { workerKeychainPaths } from './x.js';\nexport function workerKeychainPaths() {}\n" },
  );
  try {
    assert.equal(staleViaRealPath(head, "grep: workerKeychainPaths in src/app.ts"), true);
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── (7) A PROOF THAT DID NOT MATCH ON THE BASE IS CLEAN ──────────────────────

test("a grep proof absent from the merge-base is NOT flagged — it discriminates", () => {
  const head = realRepoWithBranch(
    { "src/app.ts": "export const unrelated = 1;\n" },
    { "src/app.ts": "export const unrelated = 1;\nexport function brandNewSymbol() {}\n" },
  );
  try {
    assert.equal(staleViaRealPath(head, "grep: brandNewSymbol in src/app.ts"), false);
  } finally {
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
  try {
    assert.equal(staleViaRealPath(head, "grep: freshThing in src/brand-new.ts"), false, "a created file is never stale");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── the builder's own contract, still on the REAL default path ───────────────

test("buildBaseProofDir writes only the paths grep proofs name, and nothing for a test proof", () => {
  const head = realRepoWithBranch(
    { "src/a.ts": "alpha\n", "src/b.ts": "beta\n" },
    { "src/a.ts": "alpha\n", "src/b.ts": "beta\n" },
  );
  try {
    const { baseCheckoutDir: dir, baseUnreadablePaths: unreadable } = buildBaseProofDir(
      [{ proof: "grep: alpha in src/a.ts" }, { proof: "unit test: test/x.test.ts" }, { proof: "some prose claim" }],
      head,
    );
    assert.ok(dir, "a grep proof means a base dir");
    assert.deepEqual([...unreadable], [], "W1-T460: every read here succeeds — nothing is unreadable");
    assert.equal(readFileSync(join(dir, "src/a.ts"), "utf8"), "alpha\n", "the named path is materialised from the base");
    assert.equal(existsSync(join(dir, "src/b.ts")), false, "an unnamed path is not");
    assert.equal(existsSync(join(dir, "test/x.test.ts")), false, "a `unit test:` proof needs no base blob");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

test("no grep proof ⇒ no base dir at all ⇒ the check stays inert, as it was for 1,180 verdicts", () => {
  const head = realRepoWithBranch({ "src/a.ts": "alpha\n" }, { "src/a.ts": "alpha\n" });
  try {
    assert.equal(buildBaseProofDir([{ proof: "unit test: test/x.test.ts" }], head).baseCheckoutDir, undefined);
    assert.equal(buildBaseProofDir([], head).baseCheckoutDir, undefined);
  } finally {
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
  assert.match(
    src,
    /\.\.\.\(worktreePath \? buildBaseProofDir\(criteria, worktreePath\) : \{\}\)/,
    "reviewCommand must build the base facts from its own materialised head worktree and spread them onto the evidence",
  );
  assert.match(
    src,
    /baseCheckoutDir:\s*args\.baseCheckoutDir/,
    "and runReview must forward it into the evidence judgeReview reads",
  );
  // The forwarding is worthless if judgeReview does not consume it — pin that end too.
  const review = readFileSync(join(REPO_ROOT, "src", "lib", "review.ts"), "utf8");
  assert.match(review, /baseCwd:\s*evidence\.baseCheckoutDir/, "judgeReview must put it on the exec context");
});
