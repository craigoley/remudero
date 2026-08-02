/**
 * test/triage-changed-files.test.ts — the detection that decides whether a PROPOSED filing run
 * produced anything (impl-EO; extended to the PLAN lane by impl-ER).
 *
 * REAL GIT, NOT A HAND-ASSEMBLED FIXTURE. Every case below builds an actual repository with an
 * actual `origin/main`, writes files the way the worker writes them, and runs the REAL
 * `worktreeChangedFiles` — which shells out to real `git`. A stubbed exec could not have caught this
 * defect at all: the bug was git's own behaviour (`diff` does not report untracked paths), so a
 * test that fakes git would have agreed with the broken code.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { decidePlanArchitect } from "../src/lib/plan-architect.js";
import { decideTriage } from "../src/lib/triage.js";
import { worktreeChangedFiles } from "../src/run-task.js";

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

    const changedFiles = worktreeChangedFiles(wt);

    assert.deepEqual(changedFiles, ["plan/tasks.d/W1-T286-example.yaml"], "the new shard must be detected");
    const decision = decideTriage({ verdict: PROPOSED as never, changedFiles });
    assert.notEqual(decision.action, "error", `a compliant run must not be refused: ${JSON.stringify(decision)}`);
  });

  it("the pre-#1060 shape still works: an EDIT to the tracked monolith is detected", () => {
    const wt = newWorktree();
    writeFileSync(join(wt, "plan", "tasks.yaml"), "tasks: [W1-T286]\n");

    assert.deepEqual(worktreeChangedFiles(wt), ["plan/tasks.yaml"]);
    assert.notEqual(decideTriage({ verdict: PROPOSED as never, changedFiles: worktreeChangedFiles(wt) }).action, "error");
  });

  // ── THE REGRESSION LOCK (the 2026-07-22 defect's detection must survive) ─────────────

  it("REGRESSION LOCK: a run that changed NOTHING is still judged inconsistent", () => {
    const wt = newWorktree();

    assert.deepEqual(worktreeChangedFiles(wt), [], "an untouched worktree must report no changes");
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

    assert.deepEqual(worktreeChangedFiles(wt), [], "--exclude-standard must drop ignored paths");
    assert.equal(decideTriage({ verdict: PROPOSED as never, changedFiles: worktreeChangedFiles(wt) }).action, "error");
  });

  // ── NON-PLAN FILES ───────────────────────────────────────────────────────────────────

  it("a run touching only a NON-plan file is still rejected", () => {
    const wt = newWorktree();
    writeFileSync(join(wt, "src.ts"), "export const a = 2;\n");

    assert.deepEqual(worktreeChangedFiles(wt), ["src.ts"]);
    const decision = decideTriage({ verdict: PROPOSED as never, changedFiles: ["src.ts"] });
    assert.equal(decision.action, "error", "a src/ edit is not a plan proposal");
  });

  it("a NEWLY CREATED non-plan file is detected and still rejected", () => {
    const wt = newWorktree();
    // The union must not become a loophole: creating src/ files is still not a proposal.
    writeFileSync(join(wt, "sneaky.ts"), "export const b = 3;\n");

    assert.deepEqual(worktreeChangedFiles(wt), ["sneaky.ts"]);
    assert.equal(decideTriage({ verdict: PROPOSED as never, changedFiles: worktreeChangedFiles(wt) }).action, "error");
  });

  it("tracked edits and new files are unioned, deduped, in one report", () => {
    const wt = newWorktree();
    writeFileSync(join(wt, "plan", "tasks.yaml"), "tasks: [W1-T1]\n");
    writeFileSync(join(wt, "plan", "tasks.d", "W1-T287-two.yaml"), "- id: W1-T287\n");

    const changed = worktreeChangedFiles(wt).sort();
    assert.deepEqual(changed, ["plan/tasks.d/W1-T287-two.yaml", "plan/tasks.yaml"]);
    assert.equal(new Set(changed).size, changed.length, "no path may be reported twice");
  });
});

// ── THE PLAN LANE, which carried the same defect until impl-ER ───────────────────────
//
// PR #1100 fixed the triage lane and left the plan lane on the tracked-only `git diff`. The shape is
// identical and, for this lane, the created-file case is the NORMAL one: `.remudero/skills/plan.yaml`
// directs a PROPOSED run to add tasks, and PR #1074's monolith-filing rule pushes those into a NEW
// shard under `plan/tasks.d/`. `rmd plan` is operator-invoked rather than auto-fired, so this never
// burned money unattended the way the triage side did — it silently threw away correct runs instead.

describe("plan changed-file detection", () => {
  const PLAN_PROPOSED = { kind: "proposed", summary: "add W1-T300 scaffolding the initiative" } as const;

  it("a PROPOSED plan run whose proposal is a NEW plan/tasks.d shard is accepted", () => {
    const wt = newWorktree();
    writeFileSync(join(wt, "plan", "tasks.d", "W1-T300-new-initiative.yaml"), "- id: W1-T300\n");

    // The OLD detection, verbatim, for contrast — this is what the plan lane ran until impl-ER.
    const trackedOnly = execFileSync("git", ["-C", wt, "diff", "--name-only", "origin/main"], { encoding: "utf8" })
      .split("\n").map((x) => x.trim()).filter(Boolean);
    assert.deepEqual(trackedOnly, [], "the tracked-only diff is blind to a created shard");
    assert.equal(
      decidePlanArchitect({ verdict: PLAN_PROPOSED as never, changedFiles: trackedOnly }).action,
      "error",
      "...which is why a correct plan run was refused",
    );

    const changed = worktreeChangedFiles(wt);
    assert.deepEqual(changed, ["plan/tasks.d/W1-T300-new-initiative.yaml"]);
    assert.equal(decidePlanArchitect({ verdict: PLAN_PROPOSED as never, changedFiles: changed }).action, "propose");
  });

  it("an EDITED MASTER-PLAN.md is still seen, so the tracked half is not lost", () => {
    const wt = newWorktree();
    writeFileSync(join(wt, "plan", "tasks.yaml"), "tasks: []\n# edited\n");
    assert.deepEqual(worktreeChangedFiles(wt), ["plan/tasks.yaml"]);
    assert.equal(decidePlanArchitect({ verdict: PLAN_PROPOSED as never, changedFiles: worktreeChangedFiles(wt) }).action, "propose");
  });

  it("a created file OUTSIDE plan scope is now seen, and correctly refused", () => {
    // The tradeoff the union brings to this lane, stated rather than discovered later: an untracked
    // path outside plan scope now reaches decidePlanArchitect and is refused. That is the SAME
    // behaviour the triage lane has run with since PR #1100, and it is the right direction — a
    // plan-only PR that quietly carried a new src/ file is a defect worth failing on.
    const wt = newWorktree();
    writeFileSync(join(wt, "plan", "tasks.d", "W1-T301-ok.yaml"), "- id: W1-T301\n");
    writeFileSync(join(wt, "sneaky.ts"), "export const x = 1;\n");

    const changed = worktreeChangedFiles(wt).sort();
    assert.deepEqual(changed, ["plan/tasks.d/W1-T301-ok.yaml", "sneaky.ts"]);
    const decision = decidePlanArchitect({ verdict: PLAN_PROPOSED as never, changedFiles: changed });
    assert.equal(decision.action, "error");
    assert.match((decision as { reason: string }).reason, /outside plan scope/);
  });

  it("an IGNORED created file never counts, so worker scratch cannot trip the scope check", () => {
    const wt = newWorktree();
    writeFileSync(join(wt, ".gitignore"), "scratch.json\n");
    execFileSync("git", ["-C", wt, "add", ".gitignore"], { encoding: "utf8" });
    execFileSync("git", ["-C", wt, "commit", "-qm", "ignore scratch"], { encoding: "utf8" });
    execFileSync("git", ["-C", wt, "push", "-q", "origin", "main"], { encoding: "utf8" });
    execFileSync("git", ["-C", wt, "fetch", "-q", "origin"], { encoding: "utf8" });

    writeFileSync(join(wt, "plan", "tasks.d", "W1-T302-ok.yaml"), "- id: W1-T302\n");
    writeFileSync(join(wt, "scratch.json"), "{}\n");

    assert.deepEqual(worktreeChangedFiles(wt), ["plan/tasks.d/W1-T302-ok.yaml"], "--exclude-standard drops it");
  });

  it("THE PLAN LANE ACTUALLY CALLS IT — a call-site revert is caught, not just a function change", () => {
    // Every case above drives worktreeChangedFiles DIRECTLY, so all of them would still pass if
    // someone put the tracked-only `git diff` back at the plan call site. That is precisely the shape
    // of the defect being fixed: a correct helper, unwired at one lane. planCommand cannot be driven
    // here without spawning a paid worker, so the wiring is asserted structurally instead.
    const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
    const planLane = src.slice(src.indexOf("export async function planCommand("));
    const upToDecision = planLane.slice(0, planLane.indexOf("decidePlanArchitect({ verdict, changedFiles })"));

    assert.match(upToDecision, /const changedFiles = worktreeChangedFiles\(worktreePath\);/,
      "the plan lane must derive changedFiles from the shared helper");
    assert.doesNotMatch(upToDecision, /diff", "--name-only", "origin\/main"/,
      "...and must NOT have a tracked-only git diff of its own");
  });
});
