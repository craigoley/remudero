import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isRenameOnlyDiff } from "../src/lib/review.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

// W1-T4811 (operator ruling 2026-09-22, W1-T2982). The predicate is judged against REAL git output, because the
// falsifier is a predicate keyed on path names: only a real rename-plus-edit shows whether it discriminates.

const OLD = "plan/tasks.d/W1-T900-original.yaml";
const NEW = "plan/tasks.d/W1-T901-renumbered.yaml";
const BODY = Array.from({ length: 12 }, (_, i) => `  line-${i}: "content that keeps similarity high"`).join("\n");

function fixture(): GitRepo {
  const repo = gitRepo({ kind: "t4811-rename" });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, OLD), `- id: W1-T900\n${BODY}\n`);
  writeFileSync(join(repo.dir, "src", "other.ts"), "export const x = 1;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "base");
  repo.git("checkout", "-qb", "topic");
  return repo;
}

function verdict(repo: GitRepo) {
  repo.git("add", "-A");
  repo.git("commit", "-qm", "change");
  return isRenameOnlyDiff(repo.git("diff", "--raw", "--no-abbrev", "-M", "main...HEAD"));
}

test("W1-T4811: a pure rename under plan/tasks.d takes the fast lane", () => {
  const repo = fixture();
  renameSync(join(repo.dir, OLD), join(repo.dir, NEW));
  const v = verdict(repo);
  assert.equal(v.renameOnly, true, v.reason);
  assert.match(v.reason, /1 pure rename/);
});

test("W1-T4811: a rename that also edits one byte is refused the fast lane", () => {
  // Fault injection 1: the SAME rename, plus one byte changed in the renamed file itself.
  const edited = fixture();
  renameSync(join(edited.dir, OLD), join(edited.dir, NEW));
  writeFileSync(join(edited.dir, NEW), readFileSync(join(edited.dir, NEW), "utf8").replace("line-3", "line-4"));
  const a = verdict(edited);
  assert.equal(a.renameOnly, false, "a rename plus a one-byte edit to the renamed file must not take the lane");

  // Fault injection 2: the SAME rename, plus one byte changed in ANY OTHER file.
  const other = fixture();
  renameSync(join(other.dir, OLD), join(other.dir, NEW));
  writeFileSync(join(other.dir, "src", "other.ts"), "export const x = 2;\n");
  const b = verdict(other);
  assert.equal(b.renameOnly, false, "a rename plus a one-byte edit to another file must not take the lane");
  assert.match(b.reason, /not a pure rename/);

  // Fault injection 3: a byte-perfect rename that leaves plan/tasks.d is not the lane either.
  const out = fixture();
  renameSync(join(out.dir, OLD), join(out.dir, "src", "moved.yaml"));
  assert.equal(verdict(out).renameOnly, false);
});

test("W1-T4811: an empty diff, a mode change and an added shard are refused the fast lane", () => {
  assert.equal(isRenameOnlyDiff("").renameOnly, false);
  assert.equal(isRenameOnlyDiff("\n\n").renameOnly, false);
  const sha = "a".repeat(40);
  const row = (mode2: string, status: string, to = NEW) => `:100644 ${mode2} ${sha} ${sha} ${status}\t${OLD}\t${to}\n`;
  assert.equal(isRenameOnlyDiff(row("100644", "R100")).renameOnly, true);
  assert.equal(isRenameOnlyDiff(row("100755", "R100")).renameOnly, false, "an executable-bit flip is a change");
  assert.equal(isRenameOnlyDiff(row("100644", "R099")).renameOnly, false);
  assert.equal(isRenameOnlyDiff(row("100644", "C100")).renameOnly, false);
  assert.equal(isRenameOnlyDiff(`:000000 100644 ${"0".repeat(40)} ${sha} A\t${NEW}\n`).renameOnly, false);
  // A score of R100 with differing blob ids cannot happen in real git; the predicate still refuses it.
  assert.equal(isRenameOnlyDiff(`:100644 100644 ${sha} ${"b".repeat(40)} R100\t${OLD}\t${NEW}\n`).renameOnly, false);
});

test("W1-T4811: ci.yml short-circuits the test matrix only on the predicate's verdict", () => {
  const ci = readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /isRenameOnlyDiff\(readFileSync\("rename-raw\.txt"/, "the classify step must call the real predicate");
  assert.match(ci, /git diff --raw --no-abbrev -M "origin\/\$\{GITHUB_BASE_REF\}\.\.\.HEAD"/);
  assert.match(ci, /echo "rename_only=\$\{RENAME_ONLY\}" >> "\$GITHUB_OUTPUT"/);
  assert.match(ci, /if \[ "\$\{\{ steps\.classify\.outputs\.rename_only \}\}" = "true" \]; then/);
  // The lint still runs: lint-plan is a step of commitlint, which has no rename_only skip.
  assert.doesNotMatch(ci.split("\n  commitlint:")[1]!.split("\n  leak-grep:")[0]!, /rename_only/);
});
