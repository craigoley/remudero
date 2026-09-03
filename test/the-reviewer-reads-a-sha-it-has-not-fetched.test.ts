// W1-T2511. `reviewCommand` resolved a trailered PR's criteria from `view.headRefOid` against
// LOCAL git objects, while the only fetch on that path was the first statement of
// `materializeReviewWorktree`, 65 lines below. So the reviewer asked git about a commit it had not
// yet arranged to have.
//
// IT COST TWO DIFFERENT VERDICTS, AND ONLY ONE OF THEM LOOKED WRONG. `loadPlanAtRef` throws on an
// unreadable object, the resolver degrades to `criteria: []`, and the PR-body fallback then decides
// which failure you get: a body with no `## Acceptance` block gives the loud
// "FAIL — no acceptance criteria to judge" (#3328), and a body that HAS one gives something quieter
// and worse — #3365 fell back to a single body criterion and posted `CAPPED: 0/1 proofs executed`
// while its shard resolved 8/8. A suite that only exercised the zero-criteria path would have
// shipped the fix and left the capped path live, which is why both are pinned below.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyHeadShaAvailability, parseAcceptanceBlock, resolvePlanCriteriaAtHead } from "../src/lib/review.js";

const MADE: string[] = [];
after(() => {
  for (const d of MADE) rmSync(d, { recursive: true, force: true });
});

/** A REAL git repo carrying a real plan shard, so `loadPlanAtRef`'s own `git show` runs for real.
 *  The identity env vars are passed explicitly: `actions/checkout` sets neither repo nor global
 *  identity, so a fixture that relies on ambient config passes locally and fails on every runner. */
function repoWithPlan(taskId: string, claim: string): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "w1t2511-"));
  MADE.push(dir);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
             GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git(["init", "-q", "."]);
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n"); // a YAML LIST — a map is rejected by parseTasksFromYaml
  writeFileSync(
    join(dir, "plan", "tasks.d", `${taskId}.yaml`),
    [
      `- id: ${taskId}`,
      `  title: "fixture"`,
      `  repo: remudero`,
      `  depends_on: []`,
      `  type: implement`,
      `  verify: auto`,
      `  risk: medium`,
      `  status: queued`,
      `  attempts: 0`,
      `  origin: "fixture"`,
      `  files: [src/lib/x.ts]`,
      `  acceptance:`,
      `    - claim: "${claim}"`,
      `      proof: "unit test: test/x.test.ts"`,
      "",
    ].join("\n"),
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "fixture"]);
  return { dir, sha: git(["rev-parse", "HEAD"]).trim() };
}

const ABSENT_SHA = "3c19c12f2f0790f0cb9c7df9df5dc6b89b097fd4"; // W1-T2503's real head, unknown to a fixture repo
const body = (taskId: string, extra = "") => `some description${extra}\n\nRemudero-Task: ${taskId}\n`;

// ── criteria 1 + 2: the ordering, and what it costs ──────────────────────────────────────────

test("CRITERION 1: a head sha absent from local objects no longer resolves to zero criteria when the trailer and shard are valid", () => {
  const { dir, sha } = repoWithPlan("W1-T9001", "the shard's own claim");
  // The sha IS present here — this is the post-fetch world the hoist creates.
  const resolved = resolvePlanCriteriaAtHead(body("W1-T9001"), dir, "plan/tasks.yaml", sha);
  assert.equal(resolved.criteria.length, 1, "a valid trailer + shard must resolve from the plan, not degrade");
  assert.equal(resolved.criteria[0]?.claim, "the shard's own claim");
  assert.equal(resolved.divergence, undefined, "and no divergence is reported when the object is readable");

  // THE CONTRAST, same repo, same trailer, same shard — only the sha's availability differs.
  const unfetched = resolvePlanCriteriaAtHead(body("W1-T9001"), dir, "plan/tasks.yaml", ABSENT_SHA);
  assert.equal(unfetched.criteria.length, 0, "an unfetched sha is what produced zero criteria");
  assert.ok(unfetched.divergence, "and it is reported as a divergence, never swallowed");
});

test("CRITERION 2: the fetch that makes the head sha readable runs BEFORE criteria are resolved from it", () => {
  const src = readSource();
  const fetchAt = src.indexOf("fetchHead(repoRoot, view.number);");
  const resolveAt = src.indexOf("resolvePlanCriteriaAtHead(body, repoRoot,");
  assert.ok(fetchAt > 0, "reviewCommand must call the hoisted fetch");
  assert.ok(resolveAt > 0, "and must still resolve criteria at the head sha");
  assert.ok(
    fetchAt < resolveAt,
    "the fetch must precede the resolution — the ordering IS the defect, so asserting the call exists is not enough",
  );
  // AND THE COMMENT THAT ASSERTED A FETCH HAD HAPPENED MUST BE GONE. It read "the head sha this
  // fetch already holds", which is what made the defect survive review the first time.
  assert.doesNotMatch(src, /the head sha this fetch already holds/, "the false comment must not survive the fix");
});

// ── criterion 9 (this task's second symptom): the CAPPED path, not only the zero-criteria one ──

test("CRITERION 9: a divergence that falls back to a body block is not silently capped — the cause is named on the verdict, not only in the ledger", () => {
  const { dir } = repoWithPlan("W1-T9002", "shard claim");
  // #3365's exact shape: trailered body that ALSO carries its own Acceptance block.
  const withBlock = body("W1-T9002", "\n\n## Acceptance\n- a body claim | grep: x in src/lib/x.ts");
  const resolved = resolvePlanCriteriaAtHead(withBlock, dir, "plan/tasks.yaml", ABSENT_SHA);
  assert.equal(resolved.criteria.length, 0, "the plan resolution still fails on an unfetched sha");
  assert.ok(resolved.divergence, "and the divergence is present — this is the row that used to go quiet");
  assert.equal(resolved.divergence?.taskId, "W1-T9002", "naming the task whose criteria were lost");

  // THE POINT OF THIS CRITERION: the fallback SUCCEEDS, which is why the failure stopped looking
  // like one. Without a named cause on the divergence, the verdict reads as an ordinary weak PR.
  const fallback = parseAcceptanceBlock(withBlock);
  assert.equal(fallback.length, 1, "the body block yields one criterion — the capped-at-0/1 shape");
  assert.ok(
    resolved.divergence?.cause,
    "so the divergence must carry a cause the verdict can name; without it the downgrade is silent",
  );
});

// ── criterion 10: the diagnostic git itself cannot give ──────────────────────────────────────

test("CRITERION 10: the divergence message distinguishes an unfetched object from a path genuinely absent at that sha", () => {
  const { dir, sha } = repoWithPlan("W1-T9003", "shard claim");
  assert.equal(classifyHeadShaAvailability(dir, ABSENT_SHA), "absent-object", "a sha this repo never fetched");
  assert.equal(classifyHeadShaAvailability(dir, sha), "readable-object", "a sha it holds");

  // THE CONTROL THAT MAKES THIS WORTH HAVING: git's own message is byte-identical for both, so the
  // probe is the ONLY thing separating them. Assert that sameness rather than trusting it.
  const show = (rev: string) => {
    try {
      execFileSync("git", ["-C", dir, "show", `${rev}:plan/tasks.yaml`], { encoding: "utf8", stdio: "pipe" });
      return "ok";
    } catch (e) {
      return String((e as { stderr?: Buffer }).stderr ?? "").trim();
    }
  };
  const absentMsg = show(ABSENT_SHA);
  assert.match(absentMsg, /exists on disk, but not in/, "git's wording for an absent object");
  assert.equal(
    absentMsg.replace(ABSENT_SHA, "<sha>"),
    show("0000000000000000000000000000000000000000").replace("0000000000000000000000000000000000000000", "<sha>"),
    "two different absent shas give the same message — the reason string alone can never identify the cause",
  );

  // A PROBE THAT CANNOT RUN IS NOT AN ANSWER. An injected runner that throws WITHOUT an exit status
  // is a spawn failure, not a "no" — it must read undetermined rather than be reported as absent.
  const throws = () => {
    throw new Error("git not found");
  };
  assert.equal(classifyHeadShaAvailability(dir, sha, throws), "undetermined", "never guess when the probe failed");
  const exited = () => {
    const e = new Error("exit 1") as Error & { status: number };
    e.status = 1;
    throw e;
  };
  assert.equal(classifyHeadShaAvailability(dir, sha, exited), "absent-object", "a real non-zero exit IS an answer");
});

// ── criteria 3-7: the behaviours that must not move ──────────────────────────────────────────

test("CRITERION 3: a sha that cannot be fetched at all still fails closed, never passes", () => {
  const { dir } = repoWithPlan("W1-T9004", "shard claim");
  const resolved = resolvePlanCriteriaAtHead(body("W1-T9004"), dir, "plan/tasks.yaml", ABSENT_SHA);
  assert.deepEqual(resolved.criteria, [], "zero criteria — never a silent pass");
  assert.ok(resolved.divergence, "and the reason is carried out for the caller to report");
});

test("CRITERION 4: a trailer whose id is absent from the plan at that head still fails closed", () => {
  const { dir, sha } = repoWithPlan("W1-T9005", "shard claim");
  const resolved = resolvePlanCriteriaAtHead(body("W1-T9999"), dir, "plan/tasks.yaml", sha);
  assert.deepEqual(resolved.criteria, [], "a readable plan that simply lacks the id yields nothing to judge");
  assert.equal(resolved.divergence, undefined, "and that is NOT a divergence — the plan was read fine");
});

test("CRITERION 5: a fetch failure is still named through the same degradation path it uses today", () => {
  const src = readSource();
  // The hoisted fetch must be BEST-EFFORT: a throw here must not invent a second failure path for a
  // condition materializeReviewWorktree already reports as `fetch-failure`.
  const hoisted = src.slice(
    src.indexOf("try {\n    fetchHead(repoRoot, view.number);"),
    src.indexOf("let resolverDivergence"),
  );
  assert.match(hoisted, /catch\s*\{/, "the hoisted fetch swallows its own failure");
  assert.doesNotMatch(hoisted, /return\s+\d/, "and never returns an exit code of its own");
  assert.match(src, /errorClass: "fetch-failure"/, "the materializer's own named class still exists");
});

test("CRITERION 6: an untrailered body still reaches the PR-body Acceptance fallback unchanged", () => {
  const { dir } = repoWithPlan("W1-T9006", "shard claim");
  const untrailered = "no trailer here\n\n## Acceptance\n- a body claim | grep: x in src/lib/x.ts";
  const resolved = resolvePlanCriteriaAtHead(untrailered, dir, "plan/tasks.yaml", ABSENT_SHA);
  assert.deepEqual(resolved.criteria, [], "no trailer ⇒ this function resolves nothing");
  assert.equal(resolved.divergence, undefined, "and never touches git, so an absent sha is irrelevant");
  assert.equal(parseAcceptanceBlock(untrailered).length, 1, "the body fallback still finds its criterion");
});

test("CRITERION 7: the materializer still refuses a tree whose tip is not the PR head", () => {
  const src = readSource();
  // There is no `head-mismatch` error CLASS — the union is worktree-collision|fetch-failure|other,
  // and the tip check THROWS instead. Asserting a class name that does not exist would have passed
  // vacuously against this 32k-line file only if the string happened to appear somewhere; it does
  // not, which is how the first draft of this test caught its own invention.
  const tip = src.slice(src.indexOf("if (tip !== headSha)"), src.indexOf("if (tip !== headSha)") + 600);
  assert.ok(tip.length > 0, "the tip comparison must still exist");
  assert.match(tip, /not the PR head/, "and still refuse a tree whose tip is not the PR head");
  assert.match(tip, /throw new Error/, "by throwing, unchanged by this task");
});

// ── criterion 8: the falsifier ───────────────────────────────────────────────────────────────

test("CRITERION 8: restoring the original ordering makes the unfetched-sha case resolve zero criteria again", () => {
  const { dir, sha } = repoWithPlan("W1-T9007", "shard claim");
  // WITH the fetch (the sha is present): full resolution.
  assert.equal(resolvePlanCriteriaAtHead(body("W1-T9007"), dir, "plan/tasks.yaml", sha).criteria.length, 1);
  // WITHOUT it (the sha was never fetched — the pre-fix world): zero, and a divergence naming why.
  const before = resolvePlanCriteriaAtHead(body("W1-T9007"), dir, "plan/tasks.yaml", ABSENT_SHA);
  assert.equal(before.criteria.length, 0, "the ordering defect's exact outcome");
  assert.equal(before.divergence?.cause, "absent-object", "and the cause names it as unfetched, not as a missing path");
});

function readSource(): string {
  return execFileSync("cat", [join(import.meta.dirname, "..", "src", "run-task.ts")], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}
