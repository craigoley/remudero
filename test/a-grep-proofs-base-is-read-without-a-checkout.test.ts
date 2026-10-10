/**
 * A `grep:` PROOF'S BASE IS READ, NEVER CHECKED OUT.
 *
 * OBSERVED 2026-10-10 on the fleet host at load 30: the measurement cadence sat 78 minutes in a plan-reconcile
 * landing because `rmd check-proof "grep: ^  status: merged$ in plan/tasks.d/<shard>.yaml" --base origin/main`
 * ran `git worktree add --detach` of origin/main, whose `git reset --hard` spent 66 minutes writing every tracked
 * file and a fresh index, all to answer one grep over one blob. `buildBaseProofDir` now builds a grep-only
 * review's base from the blobs its proofs name. These cases pin that it adds no worktree, and that the reviewer's
 * real executor reads the same answer from that tree as from a real checkout of the same commit, for each shape
 * a target can take at the base: a match, no match, a missing path, a directory, and a binary file.
 *
 * Every repository here is built by test/helpers/git-repo.ts; the reference checkout is the control.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";

import * as runTask from "../src/run-task.js";
import * as review from "../src/lib/review.js";
import * as baseStale from "../src/lib/proof-base-stale.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const { buildBaseProofDir, checkProofCommand, CHECK_PROOF_EXIT } = runTask;
type BaseProofDir = runTask.BaseProofDir;

const NEEDLE = "needle_7f3a";
/** Bytes a UTF-8 decode would rewrite (0xff, 0xfe) around a NUL, on the line the grep matches. */
const BINARY = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0x20]), Buffer.from(`${NEEDLE} \n`), Buffer.from([0xc3, 0x28, 0x0a])]);

/** One proof per shape a target can take at the base. Every head file carries the needle. */
const PROOFS = {
  match: `grep: ${NEEDLE} in src/match.ts`,
  noMatch: `grep: ${NEEDLE} in src/no-match.ts`,
  missing: `grep: ${NEEDLE} in src/missing.ts`,
  directory: `grep: ${NEEDLE} in plan/tasks.d`,
  binary: `grep: ${NEEDLE} in assets/blob.bin`,
  anchored: `grep: ^  status: merged$ in plan/tasks.d/w1-t1-sample.yaml`,
} as const;

function put(repo: GitRepo, files: Record<string, string | Buffer>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
    writeFileSync(join(repo.dir, rel), body);
  }
  repo.git("add", "-A");
}

/** A base commit (`origin/main`, the merge-base) and a head commit on top. */
function fixture(): { repo: GitRepo; mergeBase: string } {
  const repo = gitRepo({ kind: "grep-base-read" });
  put(repo, {
    "src/match.ts": `export const a = "${NEEDLE}";\n`,
    "src/no-match.ts": "export const b = 1;\n",
    "plan/tasks.d/w1-t1-sample.yaml": `- id: W1-T1\n  status: merged\n  note: ${NEEDLE}\n`,
    "plan/tasks.d/w1-t2-other.yaml": "- id: W1-T2\n  status: queued\n",
    "assets/blob.bin": BINARY,
    "docs/unrelated.md": "a file no proof names\n",
  });
  repo.git("commit", "-q", "-m", "base");
  const mergeBase = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  put(repo, {
    "src/no-match.ts": `export const b = "${NEEDLE}";\n`,
    "src/missing.ts": `export const c = "${NEEDLE}";\n`,
  });
  repo.git("commit", "-q", "-m", "head");
  return { repo, mergeBase };
}

/** What the reviewer's real executor reads from `cwd`: its verdict and matched lines, or the throw it raises. */
function readAt(proof: string, cwd: string): Record<string, unknown> {
  const w = review.parseWhitelistedProof(proof);
  assert.ok(w, `the proof compiles: ${proof}`);
  try {
    const verdict = review.execWhitelistedProof(w, cwd);
    return { verdict, lines: w.matchedLines ?? [], failure: w.failureOutput ?? null };
  } catch (e) {
    const err = e as Error & { status?: number };
    return { verdict: "threw", error: err.constructor.name, status: err.status ?? null, message: err.message };
  }
}

/** The reviewer's own judgement of one criterion with the real executor on both trees. */
function judgeAt(head: string, base: BaseProofDir, proof: string) {
  const v = review.judgeCriterion({ claim: "the shape holds", proof }, new Set(), undefined, {
    cwd: head,
    exec: review.execWhitelistedProof,
    baseCwd: base.baseCheckoutDir,
    baseUnreadablePaths: base.baseUnreadablePaths,
    baseIsCheckout: base.baseIsCheckout,
    addedTestFiles: base.addedTestFiles,
  });
  return { met: v.met, proof_exec: v.proof_exec, reason: v.reason };
}

/** Every file under `dir`, repo-relative and sorted. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

function scratch(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}grep-base-read-`)), name);
}

test("a grep-only review builds its merge-base side with no `git worktree add`, and holds only the blob it names", () => {
  const { repo, mergeBase } = fixture();
  const dir = scratch("base");
  try {
    let worktreeAdds = 0;
    const built = buildBaseProofDir([{ proof: PROOFS.anchored }, { proof: "prose with no dialect" }], repo.dir, {
      makeDir: () => (mkdirSync(dir), dir),
      addWorktree: (repoDir, path, revision) => {
        worktreeAdds++;
        repo.git("-C", repoDir, "worktree", "add", "--detach", path, revision);
      },
    });
    assert.equal(worktreeAdds, 0, "a grep proof's base is its blob; nothing is checked out");
    assert.equal(built.baseIsGrepTree, true);
    assert.equal(built.baseIsCheckout, false, "never claimed as a checkout a `unit test:` could run in");
    assert.equal(built.baseCheckoutDir, dir);
    assert.deepEqual(filesUnder(dir), ["plan/tasks.d/w1-t1-sample.yaml"], "one blob written, not the ~8,100-file tree");
    assert.equal(readFileSync(join(dir, "plan/tasks.d/w1-t1-sample.yaml"), "utf8"), repo.git("show", `${mergeBase}:plan/tasks.d/w1-t1-sample.yaml`) + "\n");
    assert.equal(repo.git("worktree", "list").split("\n").length, 1, "no worktree is registered");
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true });
    repo.cleanup();
  }
});

test("`rmd check-proof --base` on the observed plan-reconcile proof adds no worktree and removes its base tree", (t) => {
  const { repo } = fixture();
  const dir = scratch("base");
  const savedCwd = process.cwd();
  const lines: string[] = [];
  try {
    let worktreeAdds = 0;
    process.chdir(repo.dir);
    t.mock.method(console, "log", (...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const code = checkProofCommand(["grep:", "^  status: merged$", "in", "plan/tasks.d/w1-t1-sample.yaml", "--base", "origin/main"], {
      baseBlobDeps: { makeDir: () => (mkdirSync(dir), dir), addWorktree: () => void worktreeAdds++ },
    });
    assert.equal(code, CHECK_PROOF_EXIT.executedStale, lines.join("\n"));
    assert.match(lines.join("\n"), /^base hits:\s+1$/m, "the anchored BRE matched the real base blob");
    assert.equal(worktreeAdds, 0, "check-proof --base never checks the base out for a grep");
    assert.equal(existsSync(dir), false, "the verb removed its base tree on the way out");
  } finally {
    process.chdir(savedCwd);
    rmSync(dirname(dir), { recursive: true, force: true });
    repo.cleanup();
  }
});

test("the base read from blobs is IDENTICAL to a real checkout's for a match, no match, missing path, directory and binary file", () => {
  const { repo, mergeBase } = fixture();
  const checkout = scratch("checkout");
  const trees: BaseProofDir[] = [];
  try {
    repo.git("worktree", "add", "--detach", checkout, mergeBase); // the control: what a checkout holds
    const control: BaseProofDir = { baseCheckoutDir: checkout, baseUnreadablePaths: new Set(), baseIsCheckout: true, addedTestFiles: new Set() };
    const expected: Record<string, string> = {
      match: "pass",
      noMatch: "fail",
      missing: "threw",
      directory: "threw",
      binary: "pass",
      anchored: "pass",
    };
    for (const [shape, proof] of Object.entries(PROOFS)) {
      const built = buildBaseProofDir([{ proof }], repo.dir);
      trees.push(built);
      assert.equal(built.baseIsGrepTree, true, `${shape}: read from blobs, not checked out`);
      const fromBlobs = readAt(proof, built.baseCheckoutDir!);
      const fromCheckout = readAt(proof, checkout);
      assert.equal(fromCheckout.verdict, expected[shape], `${shape}: the control reads the shape it was built to (${JSON.stringify(fromCheckout)})`);
      assert.deepEqual(fromBlobs, fromCheckout, `${shape}: the executor reads the same answer from both trees`);
      assert.deepEqual(judgeAt(repo.dir, built, proof), judgeAt(repo.dir, control, proof), `${shape}: the reviewer's verdict is the same`);
    }
    const binary = trees[Object.keys(PROOFS).indexOf("binary")]!;
    assert.ok(readFileSync(join(binary.baseCheckoutDir!, "assets/blob.bin")).equals(BINARY), "the binary blob's bytes arrive unchanged");
    const directory = trees[Object.keys(PROOFS).indexOf("directory")]!;
    assert.deepEqual(filesUnder(directory.baseCheckoutDir!), ["plan/tasks.d/w1-t1-sample.yaml", "plan/tasks.d/w1-t2-other.yaml"], "a directory arrives with everything beneath it");
  } finally {
    for (const t of trees) if (t.baseCheckoutDir) rmSync(t.baseCheckoutDir, { recursive: true, force: true });
    repo.git("worktree", "remove", "--force", checkout);
    rmSync(dirname(checkout), { recursive: true, force: true });
    repo.cleanup();
  }
});

test("a target reached through a symlink falls back to a real checkout, the one tree that reproduces the link", () => {
  const { repo } = fixture();
  try {
    symlinkSync("src", join(repo.dir, "linked"));
    symlinkSync("match.ts", join(repo.dir, "src", "alias.ts"));
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "links");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    repo.git("commit", "-q", "--allow-empty", "-m", "head");
    for (const proof of [`grep: ${NEEDLE} in linked/match.ts`, `grep: ${NEEDLE} in src/alias.ts`]) {
      let worktreeAdds = 0;
      const built = buildBaseProofDir([{ proof }], repo.dir, {
        addWorktree: (repoDir, path, revision) => {
          worktreeAdds++;
          repo.git("-C", repoDir, "worktree", "add", "--detach", path, revision);
        },
      });
      try {
        assert.equal(worktreeAdds, 1, `${proof}: only a checkout reproduces a symlink`);
        assert.equal(built.baseIsCheckout, true);
        assert.notEqual(built.baseIsGrepTree, true);
        // How grep then treats the link is the host grep's own business (GNU follows a named link under -r,
        // BSD does not); the checkout hands it the same link either way.
        assert.equal(lstatSync(join(built.baseCheckoutDir!, "linked")).isSymbolicLink(), true);
        assert.equal(lstatSync(join(built.baseCheckoutDir!, "src/alias.ts")).isSymbolicLink(), true);
      } finally {
        repo.git("worktree", "remove", "--force", built.baseCheckoutDir!);
      }
    }
  } finally {
    repo.cleanup();
  }
});

test("a base read that BREAKS is unreadable for that target alone — never absence, never a match", () => {
  const { repo } = fixture();
  const trees: string[] = [];
  try {
    const brokenBlob = buildBaseProofDir([{ proof: PROOFS.match }, { proof: PROOFS.anchored }], repo.dir, {
      grepTree: {
        readBlob: (_cwd, _rev, rel) => {
          if (rel === "src/match.ts") throw Object.assign(new Error("simulated cat-file failure"), { code: "ENOBUFS" });
          return Buffer.from(readFileSync(join(repo.dir, rel)));
        },
      },
    });
    trees.push(brokenBlob.baseCheckoutDir!);
    assert.equal(brokenBlob.baseIsGrepTree, true);
    assert.deepEqual([...brokenBlob.baseUnreadablePaths], ["src/match.ts"]);
    assert.equal(existsSync(join(brokenBlob.baseCheckoutDir!, "src/match.ts")), false, "nothing is written for a broken read");
    assert.equal(existsSync(join(brokenBlob.baseCheckoutDir!, "plan/tasks.d/w1-t1-sample.yaml")), true, "the sibling still reads");

    const brokenList = buildBaseProofDir([{ proof: PROOFS.match }], repo.dir, {
      grepTree: { listTree: () => { throw new Error("simulated ls-tree failure"); } },
    });
    trees.push(brokenList.baseCheckoutDir!);
    assert.deepEqual([...brokenList.baseUnreadablePaths], ["src/match.ts"]);
    const v = judgeAt(repo.dir, brokenList, PROOFS.match);
    assert.equal(v.proof_exec, "base_unreadable", "the reviewer withholds the override rather than crediting an unmeasured base");
  } finally {
    for (const dir of trees) rmSync(dir, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("a grep naming a test file the diff ADDS still classifies as discriminating, and a broken diff read degrades to none added", () => {
  const { repo } = fixture();
  const trees: string[] = [];
  try {
    put(repo, { "test/fresh.test.ts": `export const fresh = "${NEEDLE}";\n` });
    repo.git("commit", "-q", "-m", "adds a test");
    const proof = `grep: ${NEEDLE} in test/fresh.test.ts`;
    const built = buildBaseProofDir([{ proof }], repo.dir);
    trees.push(built.baseCheckoutDir!);
    assert.equal(built.baseIsGrepTree, true);
    assert.deepEqual([...built.addedTestFiles], ["test/fresh.test.ts"], "the same ADDED set the worktree path reports");
    assert.equal(existsSync(join(built.baseCheckoutDir!, "test/fresh.test.ts")), false, "nothing is copied: no test re-runs here");
    assert.equal(judgeAt(repo.dir, built, proof).proof_exec, "executed_pass");

    const blind = buildBaseProofDir([{ proof }], repo.dir, {
      changedTestFiles: () => {
        throw new Error("simulated git diff failure");
      },
    });
    trees.push(blind.baseCheckoutDir!);
    assert.equal(blind.baseIsGrepTree, true, "a broken diff read never costs the grep tree");
    assert.deepEqual([...blind.addedTestFiles], []);
  } finally {
    for (const dir of trees) rmSync(dir, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("the pre-push stale check reads its base through the same tree: binary-exact, and a symlinked target is never a certain finding", () => {
  const { repo, mergeBase } = fixture();
  try {
    const stale = baseStale.certainStaleProofs(
      [
        { claim: "binary", proof: PROOFS.binary },
        { claim: "match", proof: PROOFS.match },
        { claim: "fresh", proof: PROOFS.missing },
      ],
      repo.dir,
      mergeBase,
    );
    assert.deepEqual(stale.map((r) => r.claim).sort(), ["binary", "match"], "both already match at the merge base; the new file cannot");

    const linked = baseStale.certainStaleProofs([{ claim: "match", proof: PROOFS.match }], repo.dir, mergeBase, {
      listTree: () => [{ mode: "120000", type: "blob", path: "src/match.ts" }],
    });
    assert.deepEqual(linked, [], "a target only a checkout could answer for is no certain finding");
  } finally {
    repo.cleanup();
  }
});
