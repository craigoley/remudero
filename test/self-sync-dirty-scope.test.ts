import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkCliFreshness, type GitRunner } from "../src/lib/self-sync.js";

// ── W1-T446: `checkCliFreshness`'s dirty check refused on ANY non-empty `git status
// --porcelain`, never consulting the incoming diff — so a dirty path the fast-forward would
// never write (the #1666 incident: a single untracked `.claude/`) stalled the operator's rmd,
// while the deploy supervisor's `treeFfSafe` (src/lib/deployer.ts) already intersects
// dirty-with-incoming and would not have blinked. This suite is the dedicated falsifier for the
// scoped predicate — real throwaway git repos throughout (no stubbed `git`), same style as
// test/self-sync.test.ts's own gitFixture(), because a scoping change proven only against a fake
// `git` would pass while the real `status`/`diff` disagreed.

function planYaml(title: string): string {
  return `- id: T1\n  title: "${title}"\n  repo: remudero\n  type: implement\n`;
}

/** A tiny real "origin" repo + a real clone of it. Mirrors test/self-sync.test.ts's gitFixture(). */
function gitFixture(): { originDir: string; localDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-self-sync-dirty-scope-"));
  const originDir = join(root, "origin");
  const localDir = join(root, "local");
  mkdirSync(join(originDir, "plan"), { recursive: true });
  const git = (dir: string, args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(originDir, ["init", "--quiet", "-b", "main"]);
  git(originDir, ["config", "user.email", "test@example.com"]);
  git(originDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml("origin-title"), "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);
  execFileSync("git", ["clone", "--quiet", originDir, localDir], { encoding: "utf8" });
  git(localDir, ["config", "user.email", "test@example.com"]);
  git(localDir, ["config", "user.name", "Test"]);
  return { originDir, localDir };
}

function publishNewCommit(originDir: string, title: string): void {
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml(title), "utf8");
  execFileSync("git", ["add", "."], { cwd: originDir });
  execFileSync("git", ["commit", "--quiet", "-m", title], { cwd: originDir });
}

/** Publish an ADDITIONAL, brand-new file on origin (never existed locally at all before this). */
function publishNewFile(originDir: string, relPath: string, content: string): void {
  writeFileSync(join(originDir, relPath), content, "utf8");
  execFileSync("git", ["add", "."], { cwd: originDir });
  execFileSync("git", ["commit", "--quiet", "-m", `add ${relPath}`], { cwd: originDir });
}

function headSha(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function spies(localDir: string, countFetches = false) {
  const warnCalls: string[] = [];
  let fetchCalls = 0;
  const realGit: GitRunner = (args) => {
    if (countFetches && args[0] === "fetch") fetchCalls += 1;
    return execFileSync("git", ["-C", localDir, ...args], { encoding: "utf8" });
  };
  return {
    warnCalls,
    get fetchCalls() {
      return fetchCalls;
    },
    deps: {
      git: realGit,
      warn: (msg: string) => warnCalls.push(msg),
      say: () => {},
      reexec: () => {},
    },
  };
}

// ── AC1: a dirty path the incoming fast-forward will NOT write no longer refuses ────────────

test("a dirty path outside the incoming diff (untracked scratch file) no longer refuses the sync", () => {
  const { originDir, localDir } = gitFixture();
  publishNewCommit(originDir, "PUBLISHED"); // touches plan/tasks.yaml only
  writeFileSync(join(localDir, "an-untracked-scratch-file.txt"), "four bytes", "utf8");
  // Falsifier for the fixture itself: unscoped `--porcelain` must see this file, or the test
  // would pass over a tree that was never dirty at all.
  assert.ok(
    execFileSync("git", ["-C", localDir, "status", "--porcelain"], { encoding: "utf8" }).includes(
      "an-untracked-scratch-file.txt",
    ),
    "positive control: the scratch file is visible to plain `git status --porcelain`",
  );

  const { warnCalls, deps } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "synced", "the untracked scratch file is not in the incoming diff -- no refusal");
  assert.equal(warnCalls.length, 0, "no refusal message printed");
  assert.equal(
    readFileSync(join(localDir, "plan", "tasks.yaml"), "utf8"),
    planYaml("PUBLISHED"),
    "the ff-merge actually landed",
  );
  assert.equal(
    readFileSync(join(localDir, "an-untracked-scratch-file.txt"), "utf8"),
    "four bytes",
    "the untouched scratch file survives the sync unmodified",
  );
});

test("a dirty TRACKED file outside the incoming diff also no longer refuses (not an untracked-only carve-out)", () => {
  const { originDir, localDir } = gitFixture();
  // README must exist and be CLONED before the incoming diff is cut, or writing to it locally
  // would itself be an untracked path the incoming diff creates -- a different scenario (AC3).
  writeFileSync(join(originDir, "README.md"), "# readme\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: originDir });
  execFileSync("git", ["commit", "--quiet", "-m", "add readme"], { cwd: originDir });
  execFileSync("git", ["-C", localDir, "pull", "--quiet", "--ff-only"]);
  assert.ok(
    readFileSync(join(localDir, "README.md"), "utf8").length > 0,
    "fixture sanity: README.md must already be TRACKED locally before the incoming diff is cut",
  );
  publishNewCommit(originDir, "PUBLISHED"); // touches plan/tasks.yaml only, README untouched
  // Local modifies the already-tracked README -- a file the incoming diff will not write.
  writeFileSync(join(localDir, "README.md"), "# readme\nlocal note\n", "utf8");

  const { deps } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "synced", "a tracked mod outside the incoming diff is not a hazard to the ff");
  assert.equal(
    readFileSync(join(localDir, "README.md"), "utf8"),
    "# readme\nlocal note\n",
    "the locally-modified, untouched-by-incoming file is preserved exactly",
  );
});

// ── AC2: a dirty path the incoming fast-forward WOULD write still refuses, path named ───────

test("a dirty path the incoming fast-forward WOULD also write still refuses, and the message names it", () => {
  const { originDir, localDir } = gitFixture();
  publishNewCommit(originDir, "PUBLISHED"); // origin also changes plan/tasks.yaml
  writeFileSync(join(localDir, "plan", "tasks.yaml"), planYaml("DIRTY-LOCAL"), "utf8");
  const oldSha = headSha(localDir);

  const { warnCalls, deps } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "refused");
  if (result.status === "refused") {
    assert.equal(result.reason, "dirty");
    assert.match(result.message, /git pull --ff-only/);
    assert.ok(
      result.message.includes(join("plan", "tasks.yaml")) || result.message.includes("plan/tasks.yaml"),
      "the refusal message names the conflicting path",
    );
  }
  assert.equal(headSha(localDir), oldSha, "HEAD must not move -- a real conflict never mutates");
  assert.equal(warnCalls.length, 1);
  assert.ok(
    warnCalls[0].includes("plan/tasks.yaml"),
    "stderr guidance names the conflicting path, not just 'uncommitted changes'",
  );
});

// ── AC3: an untracked file at a path the incoming diff CREATES is a conflict, not ignored ───

test("an untracked local file at a path the incoming diff creates is treated as a conflict, not ignored", () => {
  const { originDir, localDir } = gitFixture();
  // Local independently creates an untracked file BEFORE the path exists anywhere in the repo's
  // history yet.
  writeFileSync(join(localDir, "brand-new-file.txt"), "LOCAL UNTRACKED CONTENT", "utf8");
  // Origin publishes a commit that ADDS that same path for the first time -- a genuine incoming
  // creation, not a pre-existing tracked file being edited.
  publishNewFile(originDir, "brand-new-file.txt", "ORIGIN CONTENT");
  const oldSha = headSha(localDir);

  const { warnCalls, deps } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(
    result.status,
    "refused",
    "an untracked path the incoming diff would create must conflict, not be silently permitted",
  );
  if (result.status === "refused") {
    assert.equal(result.reason, "dirty");
    assert.ok(result.message.includes("brand-new-file.txt"), "the created-path conflict is named");
  }
  assert.equal(headSha(localDir), oldSha, "HEAD must not move over the conflict");
  assert.equal(
    readFileSync(join(localDir, "brand-new-file.txt"), "utf8"),
    "LOCAL UNTRACKED CONTENT",
    "the untracked local content is left untouched, never clobbered",
  );
  assert.equal(warnCalls.length, 1);
});

// ── AC4: the refusal still fires without a second network fetch ─────────────────────────────

test("the (now-scoped) dirty refusal still fires with exactly one `git fetch`, never a second network round trip", () => {
  const { originDir, localDir } = gitFixture();
  publishNewCommit(originDir, "PUBLISHED");
  writeFileSync(join(localDir, "plan", "tasks.yaml"), planYaml("DIRTY-LOCAL"), "utf8");

  // NOT destructured: `fetchCalls` is a live getter over a closure variable, and destructuring it
  // would freeze its value at 0, BEFORE checkCliFreshness ever runs.
  const spy = spies(localDir, /* countFetches */ true);
  const result = checkCliFreshness(localDir, {}, spy.deps);

  assert.equal(result.status, "refused");
  assert.equal(
    spy.fetchCalls,
    1,
    "the incoming-diff read (`git diff --name-only`) must be local -- fetch already ran once above it",
  );
});

test("the permitted (non-conflicting-dirty) sync path also fires exactly one `git fetch`", () => {
  const { originDir, localDir } = gitFixture();
  publishNewCommit(originDir, "PUBLISHED");
  writeFileSync(join(localDir, "an-untracked-scratch-file.txt"), "four", "utf8");

  const spy = spies(localDir, /* countFetches */ true);
  const result = checkCliFreshness(localDir, {}, spy.deps);

  assert.equal(result.status, "synced");
  assert.equal(spy.fetchCalls, 1, "no second fetch on the newly-permitted path either");
});
