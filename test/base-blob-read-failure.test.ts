/**
 * test/base-blob-read-failure.test.ts — W1-T460.
 *
 * THE DEFECT. `materialiseBaseProofBlobs` (src/lib/review.ts) wrapped its base read in a bare
 * catch whose own comment admitted the conflation: "absent at base (forward reference) or
 * unreadable — leave it out; grep then finds nothing". Three hops turned that silence into
 * CREDIT:
 *   1. the blob is not written, for EITHER reason;
 *   2. `classifyBaseProofOutcome` grades `exec(...) === "pass" ? "stale" : "discriminates"`, so a
 *      base grep over a missing file returns no-match ⇒ "discriminates";
 *   3. `judgeCriterion` branches on `baseOutcome === "stale"` ONLY — everything else falls to
 *      `proofExec = "executed_pass"; met = true`.
 * So a proof whose base read BROKE was scored as one PROVEN to discriminate. The failure
 * direction is toward credit, which is what makes it worth a task.
 *
 * WHY A CLASSIFIED CATCH IS ENOUGH, and the measurement this suite locks (Group 0): git tells the
 * two apart already. A path absent at the rev exits 128 with no Node `code` (git ran and answered
 * "not there"); a read that genuinely broke carries a Node `code` such as ENOBUFS with `status`
 * null (the read itself failed). The catch keeps swallowing the first — that is the healthy
 * forward-reference case EVERY filing PR depends on — and surfaces the second.
 *
 * THE DISTINCTION Q1 REQUIRES, and the reason `base_unknown` was not simply reused: a WHOLLY
 * unresolvable base ("no base tree at all") and a SINGLE unreadable blob ("the base tree exists,
 * siblings were checked against it, only this proof was exempted") are different facts. The first
 * genuinely leaves no signal for any proof and correctly lets `executed_pass` stand. The second is
 * a per-proof gap wearing a global gap's clothes. They now report as different outcomes.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { buildBaseProofDir, materializeReviewWorktree, reviewCommand, runReview } from "../src/run-task.js";
import {
  baseBlobErrorIsAbsence,
  judgeCriterion,
  materialiseBaseProofBlobs,
  parseWhitelistedProof,
  preexistingProofHits,
} from "../src/lib/review.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });

/**
 * A REAL repo with a real `origin/main` and a real branch commit on top, so `git merge-base
 * origin/main HEAD` resolves for real — the same harness shape test/preexisting-proof-hits-
 * wiring.test.ts uses, and for the same reason: the errors this task classifies are produced by
 * git, so a suite that only ever sees fabricated ones proves nothing about the installed git.
 */
function realRepoWithBranch(baseFiles: Record<string, string>, headFiles: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "t460-repo-"));
  git(dir, "init", "--quiet", "-b", "main");
  for (const [rel, body] of Object.entries(baseFiles)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  for (const [rel, body] of Object.entries(headFiles)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "--allow-empty", "-m", "branch work");
  return dir;
}

/** The two fields that tell absence from a broken read apart. `status` is git's own exit code;
 *  `code` is Node's, set only when the spawn/read itself failed. */
type ShowBlobError = Error & { status?: number | null; code?: string };

/** Capture the error a real `git show <rev>:<path>` throws, so the classifier is tested on the
 *  installed git's ACTUAL shapes rather than on this suite's idea of them. */
function realShowBlobError(dir: string, rev: string, path: string, maxBuffer: number): ShowBlobError {
  try {
    execFileSync("git", ["-C", dir, "show", `${rev}:${path}`], {
      encoding: "utf8",
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return e as ShowBlobError;
  }
  throw new Error(`expected git show ${rev}:${path} to fail`);
}

/** A git-shaped ABSENCE error (status 128, no Node `code`) — Group 0 pins this against real git. */
const absenceError = () =>
  Object.assign(new Error("Command failed: git show"), {
    status: 128,
    stderr: "fatal: path 'x' does not exist in 'deadbeef'",
  });

/** A genuine READ FAILURE (Node `code`, null status) — the measured ENOBUFS shape. */
const readFailureError = () => Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS", status: null });

// ── GROUP 0: THE MEASUREMENT THE WHOLE FIX RESTS ON ──────────────────────────
//
// The classified catch is sound only while git keeps these two shapes distinct. They are a
// property of the INSTALLED git, so a version bump that moves them must turn this red rather than
// silently reverting the fix to "swallow everything".

test("W1-T460 (0): real git distinguishes an absent path (status 128, no Node code) from a broken read (Node code, null status)", () => {
  const head = realRepoWithBranch({ "src/a.ts": "alpha\n" }, { "src/a.ts": "alpha\n", "src/new.ts": "fresh\n" });
  try {
    const base = git(head, "merge-base", "origin/main", "HEAD").trim();

    // (a) absent at the rev AND absent from the worktree.
    const gone = realShowBlobError(head, base, "src/never-existed.ts", 1 << 26);
    assert.equal(gone.status, 128, "git ran and answered: the path is not in that rev");
    assert.equal(gone.code, undefined, "no Node error code — the read itself worked fine");
    assert.equal(baseBlobErrorIsAbsence(gone), true);

    // (b) present in the head worktree, absent at the base — git's OTHER absence message. Both
    //     carry status 128, so the difference is cosmetic, not structural.
    const created = realShowBlobError(head, base, "src/new.ts", 1 << 26);
    assert.equal(created.status, 128);
    assert.equal(created.code, undefined);
    assert.equal(baseBlobErrorIsAbsence(created), true, "a branch-created file is still plain absence");

    // (c) a genuine read failure: the blob exists at the rev, but the read cannot complete.
    //
    // AND WHY THE PREDICATE KEYS ON `code` FIRST, MEASURED: `status` is NOT dependable here. A
    // LARGE overflow reports `status: null` (killed by SIGTERM before exiting), but a SMALL one —
    // this case, a 6-byte blob against maxBuffer 2 — lets the child exit normally first and
    // reports `status: 0`. Both set `code: "ENOBUFS"`. So the only portable statement is the
    // negative one: git never returned its own 128. Asserting `status === null` here passed on the
    // host and failed under the CI runtime, which is precisely the over-specification this
    // comment exists to stop coming back.
    const broke = realShowBlobError(head, base, "src/a.ts", 2);
    assert.equal(broke.code, "ENOBUFS", "the read itself broke");
    assert.notEqual(broke.status, 128, "git never got to answer 'not in that rev'");
    assert.equal(baseBlobErrorIsAbsence(broke), false, "a broken read must NEVER read as absence");
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

test("W1-T460 (0): baseBlobErrorIsAbsence fails CLOSED — an unrecognised throw is a read failure, not absence", () => {
  assert.equal(baseBlobErrorIsAbsence(new Error("boom")), false, "a bare Error proves nothing about the rev");
  assert.equal(baseBlobErrorIsAbsence(undefined), false);
  assert.equal(baseBlobErrorIsAbsence({ status: 1 }), false, "only git's own 128 means 'not in that rev'");
  assert.equal(baseBlobErrorIsAbsence({ status: 128, code: "ENOBUFS" }), false, "a Node code always wins");
  assert.equal(baseBlobErrorIsAbsence(absenceError()), true);
  assert.equal(baseBlobErrorIsAbsence(readFailureError()), false);
});

// ── GROUP 1 — THE TRAP: GENUINE ABSENCE MUST STILL GRADE `discriminates` ─────
//
// This is the NORMAL case and EVERY filing PR depends on it. A fix that graded absence as unknown
// would break every filing review — worse than the defect it replaces.

test("W1-T460 (1): a genuinely-absent base path is still swallowed — no unreadable path, and the proof still grades executed_pass", () => {
  const head = realRepoWithBranch(
    { "src/app.ts": "export const unrelated = 1;\n" },
    { "src/app.ts": "export const unrelated = 1;\n", "src/brand-new.ts": "export function freshThing() {}\n" },
  );
  try {
    // REAL default deps: real merge-base, real worktree (R-11) — and, forced onto the blob fallback
    // below, real `git show` and its real absence error. Both shapes must read absence as absence.
    const built = buildBaseProofDir([{ proof: "grep: freshThing in src/brand-new.ts" }], head);
    assert.equal(built.baseIsCheckout, true);
    assert.deepEqual([...built.baseUnreadablePaths], [], "a checkout at the base simply lacks the file — never a read failure");
    execFileSync("git", ["-C", head, "worktree", "remove", "--force", built.baseCheckoutDir!], { stdio: "pipe" });
    const fallback = buildBaseProofDir([{ proof: "grep: freshThing in src/brand-new.ts" }], head, {
      addWorktree: () => {
        throw new Error("worktree refused by the fixture");
      },
    });
    assert.equal(fallback.baseIsCheckout, false);
    assert.equal(fallback.baseCheckoutDir, undefined, "nothing written for an absent path, as before W1-T460");
    assert.deepEqual([...fallback.baseUnreadablePaths], [], "a forward reference is ABSENCE, never a read failure");

    // …and end to end, the proof keeps its positive override.
    const v = judgeCriterion({ claim: "freshThing exists", proof: "grep: freshThing in src/brand-new.ts" }, new Set(), undefined, {
      cwd: head,
      baseCwd: built.baseCheckoutDir,
      baseUnreadablePaths: new Set(built.baseUnreadablePaths),
      exec: (_wp, cwd) => (cwd === head ? "pass" : "no-match"),
    });
    assert.equal(v.proof_exec, "executed_pass", "absent-at-base is the OPPOSITE of stale — it discriminates maximally");
    assert.equal(v.met, true);
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

test("W1-T460 (1): materialiseBaseProofBlobs reports absence as written-nothing, NOT as unreadable", () => {
  const out = materialiseBaseProofBlobs(
    [{ proof: "grep: freshThing in src/brand-new.ts" }],
    "deadbeef",
    () => {
      throw absenceError();
    },
    () => assert.fail("nothing should be written for an absent path"),
  );
  assert.equal(out.written, 0);
  assert.deepEqual(out.unreadable, [], "the forward-reference carve-out survives the fix intact");
});

// ── GROUP 2 — THE SECOND TRAP: AN UNREADABLE BLOB NO LONGER GRADES executed_pass ──

test("W1-T460 (2): a blob whose read BROKE is recorded unreadable — asserted on the returned outcome, not a log line", () => {
  const out = materialiseBaseProofBlobs(
    [{ proof: "grep: bigSymbol in src/huge.ts" }],
    "deadbeef",
    () => {
      throw readFailureError();
    },
    () => assert.fail("nothing can be written when the read failed"),
  );
  assert.equal(out.written, 0);
  assert.deepEqual(out.unreadable, ["src/huge.ts"], "the failure is named, per path");
});

test("W1-T460 (2): a WRITE failure is a read-failure too — the blob never reached the base tree, so the proof is not silently credited", () => {
  const out = materialiseBaseProofBlobs(
    [{ proof: "grep: bigSymbol in src/huge.ts" }],
    "deadbeef",
    () => "contents that read fine",
    () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    },
  );
  assert.equal(out.written, 0);
  assert.deepEqual(out.unreadable, ["src/huge.ts"]);
});

test("W1-T460 (2): judgeCriterion grades an unreadable-base proof `base_unreadable`, NOT executed_pass — the positive override is withdrawn", () => {
  const criterion = { claim: "the big symbol is present", proof: "grep: bigSymbol in src/huge.ts" };
  const v = judgeCriterion(criterion, new Set(["unrelated", "tokens"]), undefined, {
    cwd: "/tmp/head",
    baseCwd: "/fake/base",
    baseUnreadablePaths: new Set(["src/huge.ts"]),
    exec: () => "pass", // passes on the head; the BASE answer is the one we never got
  });
  assert.notEqual(v.proof_exec, "executed_pass", "THE DEFECT: an unread base must never be scored as proven-discriminating");
  assert.equal(v.proof_exec, "base_unreadable");
  assert.equal(v.met, false, "the keyword floor stands verbatim — a withdrawal, never a manufactured failure");
  assert.match(v.reason, /base blob could not be read/);
});

test("W1-T460 (2): the base grep is not even RUN for an unreadable path — its answer would be meaningless", () => {
  const seen: string[] = [];
  judgeCriterion({ claim: "c", proof: "grep: bigSymbol in src/huge.ts" }, new Set(), undefined, {
    cwd: "/tmp/head",
    baseCwd: "/fake/base",
    baseUnreadablePaths: new Set(["src/huge.ts"]),
    exec: (_wp, cwd) => {
      seen.push(cwd);
      return "pass";
    },
  });
  assert.deepEqual(seen, ["/tmp/head"], "only the head run — a grep over a blob that was never written proves nothing");
});

test("W1-T460 (2): preexistingProofHits still answers false for an unreadable path — never a false positive", () => {
  const wp = parseWhitelistedProof("grep: bigSymbol in src/huge.ts")!;
  assert.equal(preexistingProofHits(wp, () => "pass", "/fake/base", new Set(["src/huge.ts"])), false);
  assert.equal(preexistingProofHits(wp, () => "pass", "/fake/base", new Set()), true, "a readable base still detects staleness");
});

// ── GROUP 3 — THE THIRD TRAP: THE MIXED CASE IS REPORTED PER PROOF ──────────
//
// One path reads and another fails: the base tree STILL EXISTS, so `baseCwd` is defined and the
// readable sibling is graded normally. Nothing may let that sibling's success cover for the
// blob that was never read.

test("W1-T460 (3): a mixed proof set still produces a base tree, and names ONLY the proof whose read failed", () => {
  const out = materialiseBaseProofBlobs(
    [{ proof: "grep: alpha in src/a.ts" }, { proof: "grep: bigSymbol in src/huge.ts" }],
    "deadbeef",
    (_rev, rel) => {
      if (rel === "src/huge.ts") throw readFailureError();
      return "alpha\n";
    },
    () => {},
  );
  assert.equal(out.written, 1, "the readable sibling is materialised, so a base tree really does exist");
  assert.deepEqual(out.unreadable, ["src/huge.ts"], "and only the failing path is named");
});

test("W1-T460 (3): in the mixed case the readable sibling is graded normally while the unreadable proof is NOT credited", () => {
  const ctx = {
    cwd: "/tmp/head",
    baseCwd: "/fake/base",
    baseUnreadablePaths: new Set(["src/huge.ts"]),
  };

  // The sibling whose blob READ fine and does NOT match at base: full credit, exactly as before.
  const readable = judgeCriterion({ claim: "alpha is new", proof: "grep: alpha in src/a.ts" }, new Set(), undefined, {
    ...ctx,
    exec: (_wp, cwd) => (cwd === "/tmp/head" ? "pass" : "no-match"),
  });
  assert.equal(readable.proof_exec, "executed_pass", "a genuinely-checked sibling keeps its override");

  // The proof whose blob never arrived: withdrawn, in the SAME review, against the SAME base tree.
  const unreadable = judgeCriterion({ claim: "big is new", proof: "grep: bigSymbol in src/huge.ts" }, new Set(), undefined, {
    ...ctx,
    exec: () => "pass",
  });
  assert.equal(unreadable.proof_exec, "base_unreadable");
  assert.notEqual(
    unreadable.proof_exec,
    readable.proof_exec,
    "the sibling's base tree must not cover for the blob that was never read",
  );
});

test("W1-T460 (3): buildBaseProofDir surfaces the mixed case — a dir AND the unreadable path together", () => {
  const head = realRepoWithBranch({ "src/a.ts": "alpha\n", "src/b.ts": "beta\n" }, { "src/a.ts": "alpha\n", "src/b.ts": "beta\n" });
  try {
    const built = buildBaseProofDir(
      [{ proof: "grep: alpha in src/a.ts" }, { proof: "grep: beta in src/b.ts" }],
      head,
      {
        // (R-11) The blob path is the FALLBACK now — reached only when the merge-base worktree
        // cannot be added — so this forces it; a real checkout has no per-blob read to break.
        addWorktree: () => {
          throw new Error("worktree refused by the fixture");
        },
        // Only the second path's read breaks; everything else is the real default path.
        showBlob: (cwd, rev, rel) => {
          if (rel === "src/b.ts") throw readFailureError();
          return execFileSync("git", ["-C", cwd, "show", `${rev}:${rel}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        },
      },
    );
    assert.ok(built.baseCheckoutDir, "the readable proof still yields a base tree");
    assert.equal(built.baseIsCheckout, false, "the fallback, by construction");
    assert.equal(readFileSync(join(built.baseCheckoutDir, "src/a.ts"), "utf8"), "alpha\n");
    assert.deepEqual([...built.baseUnreadablePaths], ["src/b.ts"]);
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

// ── GROUP 4 — Q1: THE GLOBAL GAP AND THE PER-PROOF GAP REPORT DIFFERENTLY ────

test("W1-T460 (4): a WHOLLY unresolvable base still yields no dir and no unreadable paths — the global gap is untouched", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "t460-norepo-"));
  try {
    const built = buildBaseProofDir([{ proof: "grep: x in src/a.ts" }], notARepo);
    assert.equal(built.baseCheckoutDir, undefined, "unresolvable base ⇒ no staleness signal, never a false positive");
    assert.deepEqual([...built.baseUnreadablePaths], [], "a global gap is not a per-proof read failure");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("W1-T460 (4): the global gap and the per-proof gap are DIFFERENT outcomes, not the same value wearing two hats", () => {
  const criterion = { claim: "the big symbol is present", proof: "grep: bigSymbol in src/huge.ts" };

  // GLOBAL: no base tree at all. No signal exists for ANY proof ⇒ executed_pass correctly stands.
  const global = judgeCriterion(criterion, new Set(), undefined, { cwd: "/tmp/head", exec: () => "pass" });
  assert.equal(global.proof_exec, "executed_pass");

  // GLOBAL: the base run itself threw — `base_unknown`, an environment gap. Also unchanged.
  const unknown = judgeCriterion(criterion, new Set(), undefined, {
    cwd: "/tmp/head",
    baseCwd: "/fake/base",
    exec: (_wp, cwd) => {
      if (cwd === "/fake/base") throw new Error("base tree cannot run this check");
      return "pass";
    },
  });
  assert.equal(unknown.proof_exec, "executed_pass", "an environment gap must never manufacture a downgrade");

  // PER-PROOF: the base tree EXISTS and this one blob was never read. Different fact, different outcome.
  const perProof = judgeCriterion(criterion, new Set(), undefined, {
    cwd: "/tmp/head",
    baseCwd: "/fake/base",
    baseUnreadablePaths: new Set(["src/huge.ts"]),
    exec: () => "pass",
  });
  assert.equal(perProof.proof_exec, "base_unreadable");
  assert.notEqual(perProof.proof_exec, global.proof_exec);
  assert.notEqual(perProof.proof_exec, unknown.proof_exec);
  assert.notEqual(perProof.reason, unknown.reason, "and the reason a reader sees says which fact it was");
});

test("W1-T460 (4): a proof whose OWN path read fine is untouched by a SIBLING's unreadable path", () => {
  const v = judgeCriterion({ claim: "alpha", proof: "grep: alpha in src/a.ts" }, new Set(), undefined, {
    cwd: "/tmp/head",
    baseCwd: "/fake/base",
    baseUnreadablePaths: new Set(["src/completely-other.ts"]),
    exec: (_wp, cwd) => (cwd === "/tmp/head" ? "pass" : "pass"), // matches at base too ⇒ genuinely stale
  });
  assert.equal(v.proof_exec, "executed_stale", "the staleness check still works for every readable path");
});

// ── GROUP 5 — Q2: git's stderr no longer leaks through a PASSING review ─────

test("W1-T460 (5): the production showBlob pipes git's stderr — a review over an absent base path prints no `fatal:`", () => {
  // WHY A CHILD PROCESS. The leak is git's stderr reaching the REVIEWER's stderr, which is only
  // observable from outside the process. `execFileSync` with no `stdio` inherits it; the fix pipes
  // it. This drives the REAL default `showBlob` — no injection — and reads what the child printed.
  const head = realRepoWithBranch(
    { "src/app.ts": "export const unrelated = 1;\n" },
    { "src/app.ts": "export const unrelated = 1;\n", "src/brand-new.ts": "export function freshThing() {}\n" },
  );
  const script = join(mkdtempSync(join(tmpdir(), "t460-child-")), "probe.ts");
  try {
    writeFileSync(
      script,
      `import { buildBaseProofDir } from ${JSON.stringify(join(REPO_ROOT, "src", "run-task.ts"))};\n` +
        `import { execFileSync } from "node:child_process";\n` +
        // (R-11) The real default path adds a WORKTREE, so `git show` never runs for it; the
        // fallback — forced by a throwing `addWorktree` — is where the piped `git show` lives now.
        `const real = buildBaseProofDir([{ proof: "grep: freshThing in src/brand-new.ts" }], ${JSON.stringify(head)});\n` +
        `execFileSync("git", ["-C", ${JSON.stringify(head)}, "worktree", "remove", "--force", real.baseCheckoutDir], { stdio: "pipe" });\n` +
        `const built = buildBaseProofDir([{ proof: "grep: freshThing in src/brand-new.ts" }], ${JSON.stringify(head)}, { addWorktree: () => { throw new Error("worktree refused by the fixture"); } });\n` +
        `process.stdout.write(JSON.stringify({ checkout: real.baseIsCheckout, dir: built.baseCheckoutDir === undefined, unreadable: [...built.baseUnreadablePaths] }));\n`,
    );
    // NODE_V8_COVERAGE is stripped from the child: it exists to observe git's STDERR, and a
    // coverage report merged from a process that LOADS the module graph without exercising it
    // reports discovered-but-unhit branches that say nothing about the suite. Hygiene, not a fix —
    // measured honestly, removing it moved the aggregate ratchet only 90.20% -> 90.16%, so this
    // spawn was NOT the cause of that drop (the deeper in-process `reviewCommand` drive was).
    const childEnv = { ...process.env };
    delete childEnv.NODE_V8_COVERAGE;
    const r = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: REPO_ROOT, encoding: "utf8", env: childEnv });
    assert.equal(r.status, 0, `child failed: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /fatal:/, "git's absence message must not surface on a PASSING review");
    // …and silencing it did not break the classification the fix depends on.
    assert.deepEqual(JSON.parse(r.stdout), { checkout: true, dir: true, unreadable: [] }, "absence is still swallowed, still not a read failure");
  } finally {
    rmSync(head, { recursive: true, force: true });
    rmSync(dirname(script), { recursive: true, force: true });
  }
});

test("W1-T460 (5): the call site spreads BOTH of buildBaseProofDir's facts onto the evidence", () => {
  // SOURCE-TEXT, AND IT SAYS SO — the same convention, for the same reason, as
  // test/preexisting-proof-hits-wiring.test.ts's own call-site pin. `reviewCommand` is reachable
  // only by driving a whole `rmd review`, and a deeper drive proved to cost more than it bought:
  // it compiles much of the module graph without executing it, so V8 DISCOVERS branches it
  // otherwise never sees and the aggregate `coverage-ratchet` falls (MEASURED: 90.75% -> 90.20%
  // repo-wide, while both files changed here scored BETTER). The executing test below still drives
  // the call site — this pin adds the half execution cannot distinguish: that BOTH facts are
  // forwarded, not just the dir impl-GE already wired.
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.match(
    src,
    /const baseProof = worktreePath \? buildBaseProofDir\(criteria, worktreePath\) : undefined/,
    "reviewCommand must build the base facts from its materialised head worktree",
  );
  // (R-11) The spread became three NAMED fields — the builder's result now also drives teardown
  // of the base worktree, which a spread onto the evidence could not express — so each fact is
  // pinned by name: the dir, W1-T460's unreadable set, and R-11's checkout flag.
  assert.match(src, /baseCheckoutDir:\s*baseProof\?\.baseCheckoutDir/, "the dir reaches runReview");
  assert.match(src, /baseUnreadablePaths:\s*baseProof\?\.baseUnreadablePaths/, "…and W1-T460's per-proof fact beside it");
  assert.match(src, /baseIsCheckout:\s*baseProof\?\.baseIsCheckout/, "…and whether the dir is a checkout at all");
  assert.match(src, /export interface BaseProofDir \{\n  baseCheckoutDir: string \| undefined;\n  baseUnreadablePaths: ReadonlySet<string>;\n  baseIsCheckout: boolean;/, "the builder returns exactly those keys, by name");
});

test("W1-T460 (5): when the worktree could not be materialised, the base facts are still well-formed", async () => {
  // The other arm of the same call site. Materialisation failing is the documented keyword-only
  // fallback (W1-T185 criterion 5), and it must not hand the reviewer a HALF-BUILT evidence: no
  // base dir, and an EMPTY unreadable set rather than a missing one — "nothing failed to read" and
  // "nobody looked" stay distinguishable here too, which is the whole point of W1-T460.
  const root = mkdtempSync(join(tmpdir(), "t460-root2-"));
  const SENTINEL = "stop-before-posting";
  const seen: { baseCheckoutDir?: string; baseUnreadablePaths?: ReadonlySet<string> }[] = [];
  try {
    const body = ["## Acceptance", "- freshThing is introduced | grep: freshThing in src/app.ts"].join("\n");
    await assert.rejects(
      () =>
        reviewCommand("1341", ["--repo", "craigoley/remudero"], {
          fetchView: () => ({ headRefOid: "sha", headRefName: "b", body, url: "u", number: 1341 }),
          loadConfig: () => ({ root }) as Config,
          materialize: () =>
            ({
              worktreePath: undefined,
              failure: { errorClass: "test", message: "materialisation declined for this test" },
            }) as unknown as ReturnType<typeof materializeReviewWorktree>,
          runReview: ((args: { baseCheckoutDir?: string; baseUnreadablePaths?: ReadonlySet<string> }) => {
            seen.push(args);
            throw new Error(SENTINEL);
          }) as unknown as typeof runReview,
        }),
      (e: Error) => e.message === SENTINEL,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].baseCheckoutDir, undefined, "no worktree ⇒ no base dir to compare against");
    assert.deepEqual([...(seen[0].baseUnreadablePaths ?? [])], [], "and an empty set, never a missing one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T460 (5): judgeReview consumes what the call site forwards — the far end of the same chain", () => {
  // The forwarding above is worthless if `judgeReview` never puts it on the exec context, and that
  // end has no observable seam short of a full review — so it is pinned as source text, saying so.
  const review = readFileSync(join(REPO_ROOT, "src", "lib", "review.ts"), "utf8");
  assert.match(
    review,
    /baseUnreadablePaths:\s*evidence\.baseUnreadablePaths/,
    "judgeReview must put it on the exec context, or the whole chain is decoration",
  );
});
