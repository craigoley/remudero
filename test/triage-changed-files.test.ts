/**
 * test/triage-changed-files.test.ts — the detection that decides whether a PROPOSED triage run
 * produced anything (impl-EO).
 *
 * REAL GIT, NOT A HAND-ASSEMBLED FIXTURE. Every case below builds an actual repository with an
 * actual `origin/main`, writes files the way the worker writes them, and runs the REAL
 * `triageChangedFiles` — which shells out to real `git`. A stubbed exec could not have caught this
 * defect at all: the bug was git's own behaviour (`diff` does not report untracked paths), so a
 * test that fakes git would have agreed with the broken code.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { decideTriage } from "../src/lib/triage.js";
import { triageChangedFiles } from "../src/run-task.js";

const SANDBOX = mkdtempSync(join(tmpdir(), "rmd-eo-triage-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

let seq = 0;
/** A real repo with a real `origin/main`, shaped like a triage worktree. */
function newWorktree(): string {
  const base = join(SANDBOX, `case-${seq++}`);
  const origin = join(base, "origin");
  const wt = join(base, "wt");
  mkdirSync(origin, { recursive: true });
  mkdirSync(wt, { recursive: true });
  const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", wt]);
  git(wt, ["config", "user.email", "t@t"]);
  git(wt, ["config", "user.name", "t"]);
  mkdirSync(join(wt, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(wt, "plan", "tasks.yaml"), "tasks: []\n");
  writeFileSync(join(wt, "src.ts"), "export const a = 1;\n");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-qm", "init"]);
  git(wt, ["remote", "add", "origin", origin]);
  git(wt, ["push", "-q", "origin", "main"]);
  git(wt, ["fetch", "-q", "origin"]);
  return wt;
}

const PROPOSED = { kind: "proposed", summary: "add W1-T286 (origin: feedback#x)" } as const;

describe("triage changed-file detection", () => {
  it("a PROPOSED verdict whose proposal is a NEW plan/tasks.d shard is accepted", () => {
    const wt = newWorktree();
    // Exactly what PR #1060 directs the worker to do: create its own shard file.
    writeFileSync(join(wt, "plan", "tasks.d", "W1-T286-example.yaml"), "- id: W1-T286\n  origin: feedback#x\n");

    const changedFiles = triageChangedFiles(wt);

    assert.deepEqual(changedFiles, ["plan/tasks.d/W1-T286-example.yaml"], "the new shard must be detected");
    const decision = decideTriage({ verdict: PROPOSED as never, changedFiles });
    assert.notEqual(decision.action, "error", `a compliant run must not be refused: ${JSON.stringify(decision)}`);
  });

  it("the pre-#1060 shape still works: an EDIT to the tracked monolith is detected", () => {
    const wt = newWorktree();
    writeFileSync(join(wt, "plan", "tasks.yaml"), "tasks: [W1-T286]\n");

    assert.deepEqual(triageChangedFiles(wt), ["plan/tasks.yaml"]);
    assert.notEqual(decideTriage({ verdict: PROPOSED as never, changedFiles: triageChangedFiles(wt) }).action, "error");
  });

  // ── THE REGRESSION LOCK (the 2026-07-22 defect's detection must survive) ─────────────

  it("REGRESSION LOCK: a run that changed NOTHING is still judged inconsistent", () => {
    const wt = newWorktree();

    assert.deepEqual(triageChangedFiles(wt), [], "an untouched worktree must report no changes");
    const decision = decideTriage({ verdict: PROPOSED as never, changedFiles: [] });
    assert.equal(decision.action, "error", "PROPOSED with no changes must still be refused");
    assert.match(decision.reason ?? "", /no plan files were changed/);
  });

  it("REGRESSION LOCK: an ignored file is not mistaken for a plan change", () => {
    const wt = newWorktree();
    writeFileSync(join(wt, ".gitignore"), "junk/\n");
    execFileSync("git", ["-C", wt, "add", "-A"], { encoding: "utf8" });
    execFileSync("git", ["-C", wt, "commit", "-qm", "ignore"], { encoding: "utf8" });
    // Push so origin/main CARRIES the .gitignore — otherwise the commit itself is a tracked diff
    // and this case would measure that instead of the ignored file.
    execFileSync("git", ["-C", wt, "push", "-q", "origin", "main"], { encoding: "utf8" });
    execFileSync("git", ["-C", wt, "fetch", "-q", "origin"], { encoding: "utf8" });
    mkdirSync(join(wt, "junk"), { recursive: true });
    writeFileSync(join(wt, "junk", "out.log"), "noise\n");

    assert.deepEqual(triageChangedFiles(wt), [], "--exclude-standard must drop ignored paths");
    assert.equal(decideTriage({ verdict: PROPOSED as never, changedFiles: triageChangedFiles(wt) }).action, "error");
  });

  // ── NON-PLAN FILES ───────────────────────────────────────────────────────────────────

  it("a run touching only a NON-plan file is still rejected", () => {
    const wt = newWorktree();
    writeFileSync(join(wt, "src.ts"), "export const a = 2;\n");

    assert.deepEqual(triageChangedFiles(wt), ["src.ts"]);
    const decision = decideTriage({ verdict: PROPOSED as never, changedFiles: ["src.ts"] });
    assert.equal(decision.action, "error", "a src/ edit is not a plan proposal");
  });

  it("a NEWLY CREATED non-plan file is detected and still rejected", () => {
    const wt = newWorktree();
    // The union must not become a loophole: creating src/ files is still not a proposal.
    writeFileSync(join(wt, "sneaky.ts"), "export const b = 3;\n");

    assert.deepEqual(triageChangedFiles(wt), ["sneaky.ts"]);
    assert.equal(decideTriage({ verdict: PROPOSED as never, changedFiles: triageChangedFiles(wt) }).action, "error");
  });

  it("tracked edits and new files are unioned, deduped, in one report", () => {
    const wt = newWorktree();
    writeFileSync(join(wt, "plan", "tasks.yaml"), "tasks: [W1-T1]\n");
    writeFileSync(join(wt, "plan", "tasks.d", "W1-T287-two.yaml"), "- id: W1-T287\n");

    const changed = triageChangedFiles(wt).sort();
    assert.deepEqual(changed, ["plan/tasks.d/W1-T287-two.yaml", "plan/tasks.yaml"]);
    assert.equal(new Set(changed).size, changed.length, "no path may be reported twice");
  });
});
