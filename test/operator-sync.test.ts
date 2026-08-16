import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runOperatorSync, type GitRunner } from "../src/lib/operator-sync.js";
import { syncCommand } from "../src/run-task.js";

// ── W1-T907: `rmd sync` — the sanctioned dedupe-then-pull recipe as one explicit verb.
// Same discipline as test/self-sync.test.ts (real, throwaway git repos, no git mocking): every
// assertion below drives ACTUAL git plumbing (fetch, hash-object, rev-parse, status --porcelain,
// merge-base --is-ancestor, merge --ff-only) so a "did not refuse" pass can never stand in for
// "the ref actually advanced" (design (viii)).

function gitFixture(): { originDir: string; localDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-operator-sync-"));
  const originDir = join(root, "origin");
  const localDir = join(root, "local");
  mkdirSync(join(originDir, "plan", "feedback"), { recursive: true });
  const git = (dir: string, args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(originDir, ["init", "--quiet", "-b", "main"]);
  git(originDir, ["config", "user.email", "test@example.com"]);
  git(originDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "plan", "tasks.yaml"), "orig: base\n", "utf8");
  writeFileSync(join(originDir, "DECISIONS.md"), "# decisions\n", "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);
  execFileSync("git", ["clone", "--quiet", originDir, localDir], { encoding: "utf8" });
  git(localDir, ["config", "user.email", "test@example.com"]);
  git(localDir, ["config", "user.name", "Test"]);
  return { originDir, localDir };
}

function commitOnOrigin(originDir: string, relPath: string, content: string, message: string): void {
  const full = join(originDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
  execFileSync("git", ["add", "."], { cwd: originDir });
  execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: originDir });
}

function headSha(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** Real, repoDir-scoped git runner + recording say/warn spies — mirrors test/self-sync.test.ts's
 *  spies() helper. */
function spies(localDir: string) {
  const sayCalls: string[] = [];
  const warnCalls: string[] = [];
  const realGit: GitRunner = (args) => execFileSync("git", ["-C", localDir, ...args], { encoding: "utf8" });
  return {
    sayCalls,
    warnCalls,
    deps: {
      git: realGit,
      say: (msg: string) => sayCalls.push(msg),
      warn: (msg: string) => warnCalls.push(msg),
    },
  };
}

// ── AC1: an untracked byte-identical file is discarded and the ff-pull advances HEAD ────────

test("runOperatorSync: an untracked file whose bytes equal the origin/main blob at that path is removed, and the ff-pull then advances HEAD to origin/main", () => {
  const { originDir, localDir } = gitFixture();
  const oldSha = headSha(localDir);
  // The exact incident shape from the rationale: the landing bridge already committed this path
  // on origin/main, and the checkout independently carries an untracked copy with IDENTICAL bytes
  // (e.g. daemon exhaust that was also captured upstream).
  commitOnOrigin(originDir, "plan/feedback/abc.yaml", "entry: abc\n", "land abc");
  mkdirSync(join(localDir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(localDir, "plan", "feedback", "abc.yaml"), "entry: abc\n", "utf8");

  const { sayCalls, warnCalls, deps } = spies(localDir);
  const result = runOperatorSync(localDir, {}, deps);

  assert.equal(result.status, "synced");
  const newSha = headSha(localDir);
  assert.notEqual(newSha, oldSha, "HEAD must have actually advanced");
  assert.equal(newSha, headSha(originDir), "HEAD must land exactly on origin/main's sha");
  assert.equal(
    readFileSync(join(localDir, "plan", "feedback", "abc.yaml"), "utf8"),
    "entry: abc\n",
    "the ff-merge re-creates the path with origin's bytes",
  );
  assert.equal(warnCalls.length, 0, "no refusal on the happy path");
  assert.ok(sayCalls.some((l) => /discarded 1 byte-identical/.test(l)));
  if (result.status === "synced") {
    assert.deepEqual(result.discarded, ["plan/feedback/abc.yaml"]);
    assert.deepEqual(result.preserved, []);
  }
});

// ── AC2: a divergent dirty file is never deleted, always preserved aside first ──────────────

test("runOperatorSync: an untracked file with NO origin/main counterpart is never deleted -- copied to the preserve directory and named in the report, left in place, and the unrelated ff still succeeds", () => {
  const { originDir, localDir } = gitFixture();
  commitOnOrigin(originDir, "plan/tasks.yaml", "orig: published\n", "publish");
  mkdirSync(join(localDir, "scratch"), { recursive: true });
  writeFileSync(join(localDir, "scratch", "local-only.txt"), "MINE\n", "utf8");

  const { deps } = spies(localDir);
  const result = runOperatorSync(localDir, {}, deps);

  assert.equal(result.status, "synced");
  assert.equal(headSha(localDir), headSha(originDir), "the ff still advances -- this file never blocked it");
  assert.equal(
    readFileSync(join(localDir, "scratch", "local-only.txt"), "utf8"),
    "MINE\n",
    "never deleted -- the file the sync never needed to touch is left exactly where it was",
  );
  if (result.status === "synced") {
    assert.equal(result.preserved.length, 1);
    assert.equal(result.preserved[0].path, "scratch/local-only.txt");
    assert.match(result.preserved[0].reason, /no origin\/main counterpart/);
    assert.ok(result.reportPath, "a report path must be named");
    const preservedCopy = join(result.reportPath as string, "scratch", "local-only.txt");
    assert.equal(readFileSync(preservedCopy, "utf8"), "MINE\n", "the preserved COPY carries the original bytes");
    const report = readFileSync(join(result.reportPath as string, "report.md"), "utf8");
    assert.match(report, /scratch\/local-only\.txt/, "the report names the preserved path");
  }
});

test("runOperatorSync: a TRACKED file whose local bytes differ from the origin/main blob at that (incoming) path is preserved aside BEFORE the ff clears it -- never overwritten in place", () => {
  const { originDir, localDir } = gitFixture();
  commitOnOrigin(originDir, "plan/tasks.yaml", "orig: published\n", "publish");
  // Local dirties the SAME tracked path the incoming diff also changes, with DIFFERENT bytes.
  writeFileSync(join(localDir, "plan", "tasks.yaml"), "orig: local-edit\n", "utf8");

  const { deps } = spies(localDir);
  const result = runOperatorSync(localDir, {}, deps);

  assert.equal(result.status, "synced");
  assert.equal(headSha(localDir), headSha(originDir));
  assert.equal(
    readFileSync(join(localDir, "plan", "tasks.yaml"), "utf8"),
    "orig: published\n",
    "the working copy ends on origin's content -- the ff needed this path and cleared it AFTER preserving",
  );
  if (result.status === "synced") {
    assert.equal(result.preserved.length, 1);
    assert.equal(result.preserved[0].path, "plan/tasks.yaml");
    assert.match(result.preserved[0].reason, /differs from the origin\/main blob/);
    const preservedCopy = join(result.reportPath as string, "plan", "tasks.yaml");
    assert.equal(
      readFileSync(preservedCopy, "utf8"),
      "orig: local-edit\n",
      "the LOCAL edit survives, byte for byte, under the preserve directory -- nothing unlanded was lost",
    );
  }
});

// ── AC3: DECISIONS.md is preserve-and-diff by heading (W1-T191) ─────────────────────────────

test("runOperatorSync: a locally-appended DECISIONS.md is RESTORED to origin when every appended heading is already on origin/main", () => {
  const { originDir, localDir } = gitFixture();
  commitOnOrigin(originDir, "DECISIONS.md", "# decisions\n## RECORD-1\nAlready landed.\n", "land RECORD-1");
  // Local independently appended the SAME record (e.g. its own auto-log ran before it pulled).
  writeFileSync(join(localDir, "DECISIONS.md"), "# decisions\n## RECORD-1\nAlready landed.\n", "utf8");

  const { deps } = spies(localDir);
  const result = runOperatorSync(localDir, {}, deps);

  assert.equal(result.status, "synced");
  assert.equal(headSha(localDir), headSha(originDir));
  assert.equal(
    readFileSync(join(localDir, "DECISIONS.md"), "utf8"),
    "# decisions\n## RECORD-1\nAlready landed.\n",
    "restored to exactly origin's landed copy",
  );
  if (result.status === "synced") {
    assert.deepEqual(result.discarded, ["DECISIONS.md"]);
    assert.deepEqual(result.preserved, []);
  }
});

test("runOperatorSync: a locally-appended DECISIONS.md record ABSENT from origin/main is preserved aside with the absent heading named, and is never deleted", () => {
  const { originDir, localDir } = gitFixture();
  // Origin advances a DIFFERENT, unrelated path -- DECISIONS.md itself is untouched upstream, so
  // the local append is genuinely unlanded (not merely lagging the bridge).
  commitOnOrigin(originDir, "plan/tasks.yaml", "orig: published\n", "publish");
  writeFileSync(join(localDir, "DECISIONS.md"), "# decisions\n## RECORD-2\nNot landed yet.\n", "utf8");

  const { deps } = spies(localDir);
  const result = runOperatorSync(localDir, {}, deps);

  assert.equal(result.status, "synced");
  assert.equal(headSha(localDir), headSha(originDir));
  assert.equal(
    readFileSync(join(localDir, "DECISIONS.md"), "utf8"),
    "# decisions\n## RECORD-2\nNot landed yet.\n",
    "never deleted or overwritten -- DECISIONS.md was not part of the incoming diff, so nothing needed to clear it",
  );
  if (result.status === "synced") {
    assert.equal(result.preserved.length, 1);
    assert.equal(result.preserved[0].path, "DECISIONS.md");
    assert.match(result.preserved[0].reason, /## RECORD-2/, "the absent record is named BY HEADING");
    const preservedCopy = join(result.reportPath as string, "DECISIONS.md");
    assert.equal(readFileSync(preservedCopy, "utf8"), "# decisions\n## RECORD-2\nNot landed yet.\n");
  }
});

// ── AC4: BLOCKING -- a true history divergence refuses the whole verb ───────────────────────

test("runOperatorSync: a local commit that is not an ancestor of origin/main refuses the WHOLE verb -- no file removed, no file moved, HEAD unchanged", () => {
  const { originDir, localDir } = gitFixture();
  commitOnOrigin(originDir, "plan/tasks.yaml", "orig: published-on-origin\n", "publish");
  // Local makes its OWN unpublished commit -- a real, non-ff divergence.
  writeFileSync(join(localDir, "plan", "tasks.yaml"), "orig: local-only-commit\n", "utf8");
  execFileSync("git", ["-C", localDir, "add", "."]);
  execFileSync("git", ["-C", localDir, "commit", "--quiet", "-m", "local work"]);
  const oldSha = headSha(localDir);
  // Byte-identical dirt too, to prove even provably-lossless discards never run on this branch.
  mkdirSync(join(localDir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(localDir, "plan", "feedback", "abc.yaml"), "untouched\n", "utf8");

  const { sayCalls, warnCalls, deps } = spies(localDir);
  const result = runOperatorSync(localDir, {}, deps);

  assert.equal(result.status, "refused");
  if (result.status === "refused") assert.equal(result.reason, "blocking");
  assert.equal(headSha(localDir), oldSha, "HEAD must not move");
  assert.equal(
    readFileSync(join(localDir, "plan", "tasks.yaml"), "utf8"),
    "orig: local-only-commit\n",
    "the local commit's content survives untouched",
  );
  assert.ok(existsSync(join(localDir, "plan", "feedback", "abc.yaml")), "no file removed on this branch");
  assert.equal(sayCalls.length, 0, "no plan printed -- nothing was classified");
  assert.equal(warnCalls.length, 1);
  assert.ok(!existsSync(join(localDir, "state")), "no preserve directory written on this branch");
});

// ── AC5: --dry-run prints the identical plan and mutates nothing ────────────────────────────

test("runOperatorSync: --dry-run prints the same three-way classification and mutates nothing -- no deletion, no preserve copy, HEAD unchanged", () => {
  const { originDir, localDir } = gitFixture();
  const oldSha = headSha(localDir);
  commitOnOrigin(originDir, "plan/feedback/abc.yaml", "entry: abc\n", "land abc");
  mkdirSync(join(localDir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(localDir, "plan", "feedback", "abc.yaml"), "entry: abc\n", "utf8"); // identical
  mkdirSync(join(localDir, "scratch"), { recursive: true });
  writeFileSync(join(localDir, "scratch", "local-only.txt"), "MINE\n", "utf8"); // divergent

  const { sayCalls, warnCalls, deps } = spies(localDir);
  const result = runOperatorSync(localDir, { dryRun: true }, deps);

  assert.equal(result.status, "dry-run");
  assert.equal(headSha(localDir), oldSha, "HEAD unchanged");
  assert.ok(existsSync(join(localDir, "plan", "feedback", "abc.yaml")), "identical file not deleted");
  assert.ok(existsSync(join(localDir, "scratch", "local-only.txt")), "divergent file not touched");
  assert.ok(!existsSync(join(localDir, "state")), "no preserve directory written in dry-run");
  assert.equal(warnCalls.length, 0);
  if (result.status === "dry-run") {
    assert.deepEqual(result.identical, ["plan/feedback/abc.yaml"]);
    assert.equal(result.preserved.length, 1);
    assert.equal(result.preserved[0].path, "scratch/local-only.txt");
  }
  assert.ok(sayCalls.some((l) => /--dry-run/.test(l)));
  assert.ok(sayCalls.some((l) => /Nothing was mutated/.test(l)));
});

// ── Off-main refusal (design (vi)): same rule W1-T445 established for the CLI entry guard ───

test("runOperatorSync: an off-main checkout refuses -- never moves a ref that is not main", () => {
  const { originDir, localDir } = gitFixture();
  commitOnOrigin(originDir, "plan/tasks.yaml", "orig: published\n", "publish");
  execFileSync("git", ["-C", localDir, "checkout", "--quiet", "-b", "feature"]);
  const oldSha = headSha(localDir);

  const { warnCalls, deps } = spies(localDir);
  const result = runOperatorSync(localDir, {}, deps);

  assert.equal(result.status, "refused");
  if (result.status === "refused") assert.equal(result.reason, "off-main");
  assert.equal(headSha(localDir), oldSha, "HEAD must not move");
  assert.equal(warnCalls.length, 1);
  assert.match(warnCalls[0], /not `main`/);
});

// ── Already up to date: a total no-op ────────────────────────────────────────────────────────

test("runOperatorSync: already up to date with origin/main is a total no-op", () => {
  const { localDir } = gitFixture();
  const oldSha = headSha(localDir);
  const { sayCalls, warnCalls, deps } = spies(localDir);
  const result = runOperatorSync(localDir, {}, deps);
  assert.equal(result.status, "up-to-date");
  assert.equal(headSha(localDir), oldSha);
  assert.equal(warnCalls.length, 0);
  assert.equal(sayCalls.length, 1);
});

// ── `syncCommand` — main()'s wrapper: arg validation + exit-code translation only ───────────
// (the git-driving logic is exercised directly above, against a fixture, never via this
// process's OWN checkout — see syncCommand's own doc for why repoDir/deps are injectable.)

test("syncCommand: an unexpected argument fails loud -- usage printed, exit 2, no git ever run", () => {
  const errCalls: string[] = [];
  const originalError = console.error;
  console.error = (msg?: unknown) => {
    errCalls.push(String(msg));
  };
  let gitCalled = false;
  try {
    const code = syncCommand(["--bogus"], {
      repoDir: "/does-not-matter",
      deps: { git: (() => ((gitCalled = true), "")) as GitRunner },
    });
    assert.equal(code, 2);
    assert.ok(errCalls.some((l) => /unexpected argument '--bogus'/.test(l)));
  } finally {
    console.error = originalError;
  }
  assert.equal(gitCalled, false, "a bad-arg refusal must spawn nothing -- not even one git call");
});

test("syncCommand: translates runOperatorSync's status into main()'s exit code -- synced/up-to-date -> 0, refused/degraded -> 1", () => {
  const { originDir, localDir } = gitFixture();
  commitOnOrigin(originDir, "plan/tasks.yaml", "orig: published\n", "publish");
  const { deps } = spies(localDir);

  const okCode = syncCommand([], { repoDir: localDir, deps });
  assert.equal(okCode, 0, "a real synced run must exit 0");

  // Already up to date now (the run above advanced it) -- still 0.
  const alreadyCode = syncCommand([], { repoDir: localDir, deps });
  assert.equal(alreadyCode, 0);

  // A genuinely blocked repo must exit 1 -- off-main AND still behind (headSha !== originSha),
  // so the branch check actually gets reached instead of the up-to-date short-circuit.
  execFileSync("git", ["-C", localDir, "checkout", "--quiet", "-b", "feature"]);
  commitOnOrigin(originDir, "plan/tasks.yaml", "orig: published-again\n", "publish again");
  const offMainCode = syncCommand([], { repoDir: localDir, deps });
  assert.equal(offMainCode, 1, "an off-main refusal must exit non-zero");
});
