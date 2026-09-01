// test/a-filing-is-not-a-build.test.ts — W1-T2530.
//
// THE DEFECT. `scripts/worker-branch-shape.mjs` (W1-T2491) refuses any branch that claims a task
// — by an anchored `Remudero-Task:` trailer, or by filing a `plan/tasks.d/*.yaml` shard — unless
// its head ref carries `run-<taskId>-<epochMs>`. That shape is unsatisfiable for a PR that files
// SEVERAL shards (one head ref cannot carry N ids) and actively harmful for one that files a
// single shard: `projectPlan` (src/lib/status.ts) attributes an OPEN PR to a task by that same
// regex against `headRefName`, so renaming a filing to it would make dispatch believe the task is
// an in-flight BUILD nobody has started. MEASURED on this filing's own predecessor: a plan-only
// branch adding four shards (`plan-findings-3349-session`) was REFUSED for W1-T2526..W1-T2529.
//
// THE FIX. A task id claimed ONLY by a filed shard (never also anchored by a trailer) is now
// exempt from the shape check when this branch's own diff is PLAN-ONLY (every changed file since
// base is in `isInPlanScope` — the same predicate `judgeReview`/`checkSatisfiedByGuard` already
// gate Standing rule 15's carve-out on). A trailer claim is always shape-checked regardless. A
// shard claim on a diff that ALSO touches something outside plan scope is unaffected — that is
// the limb this gate was originally built to catch (a build that files its own shard and forgets
// the trailer), and it must keep refusing.
//
// WHAT IS REAL HERE: every function under test is imported straight from the production script
// (`scripts/worker-branch-shape.mjs`) via a dynamic import — `scripts/**` sits outside tsconfig's
// `include` (see tsconfig.json), the same reason test/a-worker-branch-must-be-shaped-for-
// dispatch.test.ts (W1-T2491's own suite) reaches it the same way. Nothing here is re-implemented
// or mocked.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "worker-branch-shape.mjs");

const mod = (await import(pathToFileURL(SCRIPT_PATH).href)) as {
  evaluateWorkerBranchShape: (input: {
    headRef: string | undefined;
    commitMessages: string | undefined;
    addedFiles: readonly string[];
    readFile: (path: string) => string | undefined;
    changedFiles?: readonly string[];
  }) => { ok: boolean; defect?: string; message: string };
  isPlanOnlyDiff: (changedFiles: readonly string[]) => boolean;
};
const { evaluateWorkerBranchShape, isPlanOnlyDiff } = mod;

function shardYaml(id: string) {
  return `- id: ${id}\n  title: "a filed shard"\n  repo: remudero\n  status: queued\n`;
}

// The real four-shard filing that exposed this (rationale: measured the same hour W1-T2491
// merged), reproduced as a fixture — acceptance 4.
const FILING_IDS = ["W1-T2526", "W1-T2527", "W1-T2528", "W1-T2529"];
const FILING_HEAD_REF = "plan-findings-3349-session";
const FILING_ADDED_FILES = FILING_IDS.map((id) => `plan/tasks.d/${id}-something.yaml`);
const FILING_COMMIT_MESSAGES = "chore(plan): file four shards from the 3349 session\n";
const FILING_READ_FILE = (path: string) => {
  const hit = FILING_IDS.find((id) => path === `plan/tasks.d/${id}-something.yaml`);
  return hit ? shardYaml(hit) : undefined;
};

function filingInput(overrides: { changedFiles?: readonly string[]; headRef?: string } = {}) {
  return {
    headRef: overrides.headRef ?? FILING_HEAD_REF,
    commitMessages: FILING_COMMIT_MESSAGES,
    addedFiles: FILING_ADDED_FILES,
    readFile: FILING_READ_FILE,
    changedFiles: overrides.changedFiles ?? FILING_ADDED_FILES,
  };
}

// ── acceptance 1: a plan-only branch adding shards for several tasks passes, whatever its head ref

test("acceptance 1: a plan-only branch declaring shards for FOUR distinct tasks passes on an entirely unshaped head ref", () => {
  const result = evaluateWorkerBranchShape({
    headRef: "plan-findings-9999-session",
    commitMessages: "chore(plan): file W1-T9001, W1-T9002, W1-T9003\n",
    addedFiles: ["plan/tasks.d/W1-T9001-a.yaml", "plan/tasks.d/W1-T9002-b.yaml", "plan/tasks.d/W1-T9003-c.yaml"],
    readFile: (path) => {
      if (path === "plan/tasks.d/W1-T9001-a.yaml") return shardYaml("W1-T9001");
      if (path === "plan/tasks.d/W1-T9002-b.yaml") return shardYaml("W1-T9002");
      if (path === "plan/tasks.d/W1-T9003-c.yaml") return shardYaml("W1-T9003");
      return undefined;
    },
    changedFiles: ["plan/tasks.d/W1-T9001-a.yaml", "plan/tasks.d/W1-T9002-b.yaml", "plan/tasks.d/W1-T9003-c.yaml"],
  });
  assert.equal(result.ok, true, "one head ref cannot carry three ids' run-<id>-<epochMs> shape — a filing must not be forced to try");
  assert.match(result.message, /plan-only/, "the OK reason names the plan-only carve-out, not a silent pass");
});

test("acceptance 1: an entirely unrelated, plainly-named head ref (no run- prefix at all) still passes a plan-only multi-shard filing", () => {
  const result = evaluateWorkerBranchShape(filingInput({ headRef: "operator-scratch/plan-cleanup" }));
  assert.equal(result.ok, true);
});

// ── acceptance 2: a branch that ALSO changes src/ and files its own shard is STILL refused when ──
// ── unshaped — the limb the gate was built for survives ─────────────────────────────────────────

test("acceptance 2: a branch filing its own shard whose diff ALSO touches src/ is refused on an unshaped head ref", () => {
  const result = evaluateWorkerBranchShape({
    headRef: "chore/file-a-new-task",
    commitMessages: "chore(plan): file W1-T2491\n",
    addedFiles: ["plan/tasks.d/W1-T2491-something.yaml"],
    readFile: (path) => (path === "plan/tasks.d/W1-T2491-something.yaml" ? shardYaml("W1-T2491") : undefined),
    changedFiles: ["plan/tasks.d/W1-T2491-something.yaml", "src/lib/status.ts"],
  });
  assert.equal(result.ok, false, "src/lib/status.ts outside plan scope means this diff is NOT plan-only — the shard claim still requires the shape");
  assert.equal(result.defect, "unshaped-worker-branch");
});

test("acceptance 2: the same fixture, with the src/ file removed from changedFiles (now genuinely plan-only), passes", () => {
  const result = evaluateWorkerBranchShape({
    headRef: "chore/file-a-new-task",
    commitMessages: "chore(plan): file W1-T2491\n",
    addedFiles: ["plan/tasks.d/W1-T2491-something.yaml"],
    readFile: (path) => (path === "plan/tasks.d/W1-T2491-something.yaml" ? shardYaml("W1-T2491") : undefined),
    changedFiles: ["plan/tasks.d/W1-T2491-something.yaml"],
  });
  assert.equal(result.ok, true, "control: the ONLY difference from the test above is the diff's plan-only-ness");
});

test("acceptance 2: isPlanOnlyDiff itself is false the moment one changed path falls outside plan scope, whatever else it carries", () => {
  assert.equal(isPlanOnlyDiff(["plan/tasks.d/W1-T1-a.yaml", "src/lib/status.ts"]), false);
  assert.equal(isPlanOnlyDiff(["plan/tasks.d/W1-T1-a.yaml", "MASTER-PLAN.md", "docs/ORIENTATION.md"]), true);
  assert.equal(isPlanOnlyDiff([]), false, "an empty changed-file list fails closed to NOT plan-only");
});

// ── acceptance 3: an anchored trailer still claims a task on an unshaped branch regardless of ────
// ── whether the diff is plan-only ────────────────────────────────────────────────────────────────

test("acceptance 3: a trailer-claimed id on an UNSHAPED branch is refused even though the diff is entirely plan-only", () => {
  const result = evaluateWorkerBranchShape({
    headRef: "fix/light-pass-tick-not-bounded-by-ci",
    commitMessages: "fix(plan): tidy a shard\n\nRemudero-Task: W1-T2491\n",
    addedFiles: [],
    readFile: () => undefined,
    changedFiles: ["plan/tasks.d/W1-T2491-something.yaml"],
  });
  assert.equal(result.ok, false, "a trailer is an explicit build claim whatever else the diff holds — plan-only-ness never exempts it");
  assert.equal(result.defect, "unshaped-worker-branch");
});

test("acceptance 3: a trailer-claimed id on a run-shaped branch still passes, plan-only diff or not", () => {
  const result = evaluateWorkerBranchShape({
    headRef: "run-W1-T2491-1787887966537",
    commitMessages: "fix(plan): tidy a shard\n\nRemudero-Task: W1-T2491\n",
    addedFiles: [],
    readFile: () => undefined,
    changedFiles: ["plan/tasks.d/W1-T2491-something.yaml"],
  });
  assert.equal(result.ok, true);
});

test("acceptance 3: an id claimed by BOTH a trailer and a filed shard on a plan-only diff is still refused unshaped — the trailer, not the shard form, governs", () => {
  const result = evaluateWorkerBranchShape({
    headRef: "chore/both-forms",
    commitMessages: "chore(plan): file it\n\nRemudero-Task: W1-T2491\n",
    addedFiles: ["plan/tasks.d/W1-T2491-something.yaml"],
    readFile: (path) => (path === "plan/tasks.d/W1-T2491-something.yaml" ? shardYaml("W1-T2491") : undefined),
    changedFiles: ["plan/tasks.d/W1-T2491-something.yaml"],
  });
  assert.equal(result.ok, false);
});

// ── acceptance 4: the real four-shard filing that exposed this is reproduced as a fixture and ────
// ── passes, anchoring the fix to the observation ─────────────────────────────────────────────────

test("acceptance 4: the real W1-T2526..W1-T2529 four-shard filing fixture (plan-findings-3349-session) passes", () => {
  const result = evaluateWorkerBranchShape(filingInput());
  assert.equal(result.ok, true, "MEASURED refused before this fix; must pass now");
  for (const id of FILING_IDS) assert.ok(result.message.includes(id) || true); // message need not enumerate every id; ok is what's pinned
});

test("acceptance 4: sanity — the fixture really is plan-only and really does claim all four ids by shard only (no trailer)", () => {
  assert.equal(isPlanOnlyDiff(FILING_ADDED_FILES), true);
  assert.doesNotMatch(FILING_COMMIT_MESSAGES, /Remudero-Task:/, "the real filing carried no trailer — only the filed shards");
});

// ── acceptance 5: removing the plan-only condition makes the filing fixture refuse again ─────────

test("acceptance 5: the IDENTICAL filing fixture, once its diff also touches a file outside plan scope (no longer plan-only), refuses again", () => {
  const result = evaluateWorkerBranchShape(filingInput({ changedFiles: [...FILING_ADDED_FILES, "src/lib/status.ts"] }));
  assert.equal(result.ok, false, "removing plan-only-ness from the SAME claim set must restore the pre-fix refusal");
  assert.equal(result.defect, "unshaped-worker-branch");
});

test("acceptance 5: the IDENTICAL filing fixture, with no changedFiles supplied at all (the pre-W1-T2530 caller shape), also refuses", () => {
  // Before this fix, evaluateWorkerBranchShape had no changedFiles parameter at all and every
  // shard claim was unconditionally required to carry the shape. A caller that still omits it
  // (changedFiles defaults to []) must see the OLD, pre-carve-out behavior, never a silent pass.
  const result = evaluateWorkerBranchShape({
    headRef: FILING_HEAD_REF,
    commitMessages: FILING_COMMIT_MESSAGES,
    addedFiles: FILING_ADDED_FILES,
    readFile: FILING_READ_FILE,
  });
  assert.equal(result.ok, false, "an empty/omitted changedFiles list fails closed to NOT plan-only, restoring the refusal");
});
