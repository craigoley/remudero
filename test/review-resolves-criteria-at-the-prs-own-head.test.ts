import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { judgeReview, resolvePlanCriteriaAtHead } from "../src/lib/review.js";

// ── W1-T2432: "A BUILD IS UNJUDGEABLE UNTIL THE REVIEWER's OWN CONTAINER RESTARTS PAST ITS
// SHARD" ──────────────────────────────────────────────────────────────────────────────────────
//
// `resolvePlanCriteriaAtHead` resolves a trailered PR's judging criteria from the plan AS IT
// STANDS AT THE PR's OWN HEAD SHA (via `loadPlanAtRef`'s `git show`/`git ls-tree`), never the
// container's checked-out working tree. Below proves the six acceptance claims the task filing
// names, each against `plan/tasks.d/W1-T2432-*.yaml`'s own wording.

/** A minimal well-formed task entry — the smallest shape `parseTasksFromYaml` accepts. */
const task = (id: string, acceptance: string[] = []): string =>
  [
    `- id: ${id}`,
    `  title: ${id.toLowerCase()}`,
    "  repo: remudero",
    "  type: implement",
    "  depends_on: []",
    "  verify: auto",
    "  status: queued",
    "  attempts: 0",
    ...(acceptance.length
      ? [
          "  acceptance:",
          // Deliberately PROSE, non-dialect-prefixed proofs (never `grep:`/`unit test:`): a
          // dialect-prefixed proof that never executes (no headCheckoutDir in these fixtures)
          // caps the verdict regardless of keyword coverage, which is not what these tests probe.
          ...acceptance.flatMap((claim) => [`    - claim: "${claim}"`, `      proof: "${claim}, per the PR body"`]),
        ]
      : []),
  ].join("\n");

/** A real git repo with a committed `plan/tasks.yaml` (+ optional `plan/tasks.d/` shards) at
 *  whatever ref the caller commits — the fixture `loadPlanAtRef` (and so this function) needs,
 *  since it reads git objects, never the working tree. Mirrors
 *  `test/main-plan-load-guard.test.ts`'s own `gitPlanRepo` fixture. */
function gitPlanRepo(): { dir: string; run: (args: string[]) => string; commit: (msg: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-review-at-head-git-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
  run(["init", "--quiet", "-b", "main"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "user.name", "Test"]);
  mkdirSync(join(dir, "plan"), { recursive: true });
  const commit = (msg: string): string => {
    run(["add", "-A"]);
    run(["commit", "--quiet", "-m", msg, "--allow-empty"]);
    return run(["rev-parse", "HEAD"]).trim();
  };
  return { dir, run, commit };
}

const TRAILERED_BODY = (taskId: string) => `REPORT\n\nsome text\n\nRemudero-Task: ${taskId}\n`;

// (1) CRITERIA RESOLVE FROM THE PLAN AS IT STANDS AT THE PR's OWN HEAD.
test("criteria resolve from the plan as it stands at the pull request's own head", () => {
  const { dir, commit } = gitPlanRepo();
  writeFileSync(join(dir, "plan", "tasks.yaml"), task("W1-T1", ["the thing works"]) + "\n");
  const headSha = commit("plan");

  const result = resolvePlanCriteriaAtHead(TRAILERED_BODY("W1-T1"), dir, "plan/tasks.yaml", headSha);
  assert.deepEqual(
    result.criteria.map((c) => c.claim),
    ["the thing works"],
    "the criterion committed at headSha must resolve",
  );
  assert.equal(result.taskId, "W1-T1");
  // W1-T2623: the operator-visible source names the head sha, the task, the count, AND (the
  // restored read-identity assertion) the object identity of the plan bytes actually read — WHICH
  // plan bytes this review gated, not only which task id and how many criteria it found.
  assert.equal(
    result.source,
    `plan at ${headSha} task W1-T1 (1 criteria) — read: plan/tasks.yaml@${execFileSync(
      "git",
      ["-C", dir, "rev-parse", `${headSha}:plan/tasks.yaml`],
      { encoding: "utf8" },
    )
      .trim()
      .slice(0, 12)}`,
    "with no tasks.d/ at this head, the identity names only the monolith — never a fabricated shard reference",
  );
});

// (2) A SHARD MERGED AFTER THE REVIEWER BOOTED IS STILL FOUND WHEN PRESENT AT THAT HEAD.
test("a shard merged after the reviewer booted is still found when it is present at that head", () => {
  const { dir, run, commit } = gitPlanRepo();
  // "Boot" commit: the monolith only, no shard yet — this is the sha a container's working tree
  // would be checked out to if it booted here and never restarted.
  writeFileSync(join(dir, "plan", "tasks.yaml"), task("W1-T1") + "\n");
  const bootSha = commit("boot: monolith only");

  // A shard lands in a LATER commit — the PR's own head — after the simulated boot.
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.d", "w1-t2.yaml"), task("W1-T2", ["shard criterion lands"]) + "\n");
  const headSha = commit("shard lands after boot");

  // The container's checked-out working tree is left AT THE BOOT COMMIT (checked out, detached) —
  // exactly the "restart hasn't happened yet" state the filing names — while headSha (the PR's
  // own head, already known to the reviewer from the PR view) has moved past it.
  run(["checkout", "--quiet", "--detach", bootSha]);

  const atHead = resolvePlanCriteriaAtHead(TRAILERED_BODY("W1-T2"), dir, "plan/tasks.yaml", headSha);
  assert.deepEqual(
    atHead.criteria.map((c) => c.claim),
    ["shard criterion lands"],
    "resolving against headSha must find the shard even though the working tree is still checked out at the older boot commit",
  );
});

// (3) A TASK WITH GENUINELY NO CRITERIA ANYWHERE STILL FAILS CLOSED.
test("a task with genuinely no criteria anywhere still fails closed", () => {
  const { dir, commit } = gitPlanRepo();
  // W1-T1 exists but declares no acceptance criteria at all.
  writeFileSync(join(dir, "plan", "tasks.yaml"), task("W1-T1") + "\n");
  const headSha = commit("plan");

  const resolved = resolvePlanCriteriaAtHead(TRAILERED_BODY("W1-T1"), dir, "plan/tasks.yaml", headSha);
  assert.deepEqual(resolved.criteria, [], "a task with no declared acceptance resolves to zero criteria");

  const verdict = judgeReview(resolved.criteria, { diff: "+++ b/x.ts\n+export const x = 1;", report: "did the thing" });
  assert.equal(verdict.state, "failure", "zero criteria must still fail closed — nothing to judge is never a pass");
});

// (4) A BODY CARRYING NO ANCHORED TRAILER IS UNCHANGED AND STILL FAILS CLOSED.
test("a body carrying no anchored trailer is unchanged and still fails closed", () => {
  const untrailered = "REPORT\n\nno trailer here at all\nPR_URL: https://github.com/o/r/pull/1\n";
  // Deliberately unreachable repoRoot/headSha — proving no git object is ever touched when there
  // is no trailer to resolve (see also claim 6's fetch-count assertion below for the trailered path).
  const resolved = resolvePlanCriteriaAtHead(untrailered, "/no/such/repo", "plan/tasks.yaml", "deadbeef");
  assert.deepEqual(resolved.criteria, [], "no trailer ⇒ no criteria, exactly as before this change");
  assert.equal(resolved.taskId, undefined);

  const verdict = judgeReview(resolved.criteria, { diff: "+++ b/x.ts\n+export const x = 1;", report: untrailered });
  assert.equal(verdict.state, "failure", "an untrailered body must still fail closed");
});

// (5) THE VERDICT IS POSTED FRESH AND NO PRIOR VERDICT IS CARRIED FORWARD.
test("the verdict is posted fresh and no prior verdict is carried forward", () => {
  const { dir, run, commit } = gitPlanRepo();
  writeFileSync(join(dir, "plan", "tasks.yaml"), task("W1-T1") + "\n");
  const bootSha = commit("boot: no shard yet");

  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.d", "w1-t9.yaml"), task("W1-T9", ["the fix lands"]) + "\n");
  const headSha = commit("shard lands after boot");
  run(["checkout", "--quiet", "--detach", bootSha]);

  const report = "REPORT\n\nthe fix lands, per the PR body\nPR_URL: https://github.com/o/r/pull/9\n";
  // A single, first-ever resolve+judge pass — no second call, no ledger, no prior verdict
  // supplied anywhere in this composition — must already post success. This is the property the
  // filing's rationale (4) says a stale reviewer does NOT have (it needed a SECOND read, 23
  // minutes later, to clear a fail-closed verdict on the very same sha).
  const resolved = resolvePlanCriteriaAtHead(TRAILERED_BODY("W1-T9"), dir, "plan/tasks.yaml", headSha);
  const verdict = judgeReview(resolved.criteria, { diff: "+++ b/x.ts\n+export const x = 1;", report });
  assert.equal(verdict.state, "success", "the very first resolve+judge pass must already see the shard — no carried-forward failure to clear later");
});

// (6) NOTHING ADDED FETCHES TWICE OR WAITS BETWEEN RESOLVING AND JUDGING.
test("nothing added fetches twice or waits between resolving and judging", () => {
  const { dir, commit } = gitPlanRepo();
  writeFileSync(join(dir, "plan", "tasks.yaml"), task("W1-T1", ["criterion one"]) + "\n");
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.d", "w1-t2.yaml"), task("W1-T2", ["criterion two"]) + "\n");
  const headSha = commit("plan with one shard");

  let calls = 0;
  // `stdin` is forwarded: the shard read is one `git cat-file --batch`, which takes its object
  // list there. A fake that dropped it would hand git an empty request and read back nothing.
  const countingRunGit = (args: string[], stdin?: string): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe", input: stdin });
  const runGit = (args: string[], stdin?: string): string => {
    calls += 1;
    return countingRunGit(args, stdin);
  };

  const result = resolvePlanCriteriaAtHead(TRAILERED_BODY("W1-T1"), dir, "plan/tasks.yaml", headSha, runGit);
  // Exactly: one `git show` for the monolith, one `git ls-tree` for tasks.d/, ONE
  // `git cat-file --batch` for every shard in it (one shard here, but the count no longer moves
  // with that number), plus (W1-T2623) the read-identity probes over the SAME objects — one
  // `git rev-parse` for the monolith's blob oid, one for tasks.d/'s tree oid — never a retry,
  // never doubled, and never more than one probe per object even though both the content read
  // and the identity read touch it.
  assert.equal(
    calls,
    5,
    "the monolith, the shard listing, the ONE batch read of every shard, and the two read-identity rev-parse probes must each run exactly once",
  );
  assert.deepEqual(result.criteria.map((c) => c.claim), ["criterion one"]);
  assert.match(
    result.source ?? "",
    /— read: plan\/tasks\.yaml@[0-9a-f]{12} \+ plan\/tasks\.d\/@[0-9a-f]{12}$/,
    "the restored read-identity assertion (W1-T2623) must name both the monolith and the shard set",
  );

  // SYNCHRONOUS BY CONSTRUCTION: nothing to await between resolving and judging — the function's
  // own return value is never a Promise/thenable, so a caller can compose it with judgeReview in
  // the same tick with no wait of any kind.
  assert.equal(typeof (result as unknown as { then?: unknown }).then, "undefined", "resolvePlanCriteriaAtHead must return a plain value, never a Promise");
  const verdict = judgeReview(result.criteria, { diff: "+++ b/x.ts\n+export const x = 1;", report: "criterion one: proved right here" });
  assert.equal(typeof verdict, "object");
});

// Divergence is named, not swallowed, when the plan at headSha itself refuses to load (a
// duplicate id) — mirrors run-task.ts's own resolvePlanCriteriaForReview divergence shape.
test("a plan that fails to load at headSha is a named divergence, never a silent success", () => {
  const { dir, commit } = gitPlanRepo();
  writeFileSync(join(dir, "plan", "tasks.yaml"), task("W1-T1") + "\n");
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  // A shard re-declaring the monolith's own id — loadPlanAtRef must refuse this.
  writeFileSync(join(dir, "plan", "tasks.d", "collides.yaml"), task("W1-T1") + "\n");
  const headSha = commit("colliding plan");

  const resolved = resolvePlanCriteriaAtHead(TRAILERED_BODY("W1-T1"), dir, "plan/tasks.yaml", headSha);
  assert.deepEqual(resolved.criteria, []);
  assert.equal(resolved.divergence?.taskId, "W1-T1");
  assert.match(resolved.divergence?.reason ?? "", /duplicate task id/);
});
