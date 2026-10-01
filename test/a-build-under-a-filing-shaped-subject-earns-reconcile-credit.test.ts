// W1-T4942 — a build merged under a filing-shaped subject (`fix(plan)`, `chore: wip`) is refused
// reconcile credit on its SUBJECT alone. The merge's changed paths are the real discriminator:
// a code-touching diff is reconcilable, a bookkeeping-only, empty or unknown one never is, and the
// destructive supersession close keeps reading the subject alone.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { buildCreditCandidates, creditCandidatesFromProjection, creditIsReconcilable } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  projectMergedTaskCandidates,
  type OpenPrView,
} from "../src/lib/sweep.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, StatusProjection } from "../src/lib/status.js";
import { gitRepo } from "./helpers/git-repo.js";

function projection(taskId: string, prNumber: number): StatusProjection {
  return {
    taskId,
    status: "merged",
    merged: true,
    source: "trailer",
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
  };
}

function reconcilable(subject: string | undefined, paths: string[] | undefined, body?: string): boolean {
  const [c] = creditCandidatesFromProjection(
    [projection("W1-T4942", 9001)],
    new Map(subject === undefined ? [] : [[9001, subject]]),
    new Map(body === undefined ? [] : [[9001, body]]),
    new Map(paths === undefined ? [] : [[9001, paths]]),
  );
  return creditIsReconcilable(c);
}

test("W1-T4942: a code-touching merge under a filing-shaped subject is reconcilable", () => {
  const code = ["src/lib/plan.ts", "test/plan.test.ts"];
  const [fixPlan] = creditCandidatesFromProjection(
    [projection("W1-T3336", 9001)],
    new Map([[9001, "fix(plan): make the loader tolerate a bare id (#9001)"]]),
    new Map(),
    new Map([[9001, code]]),
  );
  assert.equal(fixPlan?.creditIsImplementation, false, "the subject path is unchanged");
  assert.equal(fixPlan?.creditHasBuildDiff, true);
  assert.equal(creditIsReconcilable(fixPlan!), true);
  assert.equal(reconcilable("chore: wip (#9001)", ["src/a.ts", "plan/tasks.d/W1-T1.yaml"]), true);
  assert.equal(reconcilable("docs: tidy (#9001)", ["README.md"]), true);
  assert.equal(reconcilable("feat: a normal build (#9001)", undefined), true, "the subject arm still credits");
});

test("W1-T4942: a plan-only filing under a filing-shaped subject is still refused", () => {
  assert.equal(reconcilable("chore(plan): file W1-T9 (#9001)", ["plan/tasks.d/W1-T9-x.yaml"]), false);
  assert.equal(reconcilable("chore(plan): file W1-T9 (#9001)", ["plan/tasks.d/W1-T9-x.yaml", "MASTER-PLAN.md"]), false);
  assert.equal(reconcilable("docs: record a ruling (#9001)", ["DECISIONS.md"]), false, "a DECISIONS.md-only close");
  assert.equal(reconcilable("fix(plan): reword (#9001)", ["plan/tasks.d/a.yaml", "DECISIONS.md"]), false);
  const [c] = creditCandidatesFromProjection(
    [projection("W1-T9", 9001)],
    new Map([[9001, "chore(plan): file W1-T9 (#9001)"]]),
    new Map(),
    new Map([[9001, ["plan/tasks.d/W1-T9-x.yaml"]]]),
  );
  assert.equal(c?.creditHasBuildDiff, false, "bookkeeping-only is false, not unknown");
});

test("W1-T4942: an unknown or empty diff never earns reconcile credit", () => {
  assert.equal(reconcilable("fix(plan): x (#9001)", undefined), false, "no path list for the PR");
  assert.equal(reconcilable("fix(plan): x (#9001)", []), false, "an empty path list");
  assert.equal(reconcilable(undefined, undefined), false, "no subject and no paths");
  const [other] = creditCandidatesFromProjection(
    [projection("W1-T4942", 9001)],
    new Map([[9001, "chore: wip (#9001)"]]),
    new Map(),
    new Map([[9002, ["src/a.ts"]]]),
  );
  assert.equal(other?.creditHasBuildDiff, undefined, "another PR's paths are not this PR's");
  assert.equal(creditIsReconcilable(other!), false);
  const [legacy] = creditCandidatesFromProjection([projection("W1-T4942", 9001)], new Map([[9001, "chore: wip (#9001)"]]));
  assert.equal(creditIsReconcilable(legacy!), false, "a caller passing no path map keeps today's refusal");
  assert.equal(creditIsReconcilable({ merged: true }), false);
  assert.equal(creditIsReconcilable({ merged: false, creditHasBuildDiff: true }), false, "unmerged never credits");
});

test("W1-T4942: a prerequisite-only merge is refused despite a code diff", () => {
  const body = "Prerequisite split for W1-T4942's own PR.\n\nThis PR carries ONLY the instrument: scripts/x.mjs.\n";
  assert.equal(reconcilable("chore: wip (#9001)", ["scripts/x.mjs"], body), false);
  assert.equal(reconcilable("feat: instrument (#9001)", ["scripts/x.mjs"], body), false);
  assert.equal(reconcilable("chore: wip (#9001)", ["scripts/x.mjs"], "an ordinary body\n"), true, "control");
});

test("W1-T4942: the supersession close still declines a filing-shaped subject", () => {
  const [c] = creditCandidatesFromProjection(
    [projection("W1-T2371", 3195)],
    new Map([[3195, "fix(plan): reword the amendment block (#3195)"]]),
    new Map(),
    new Map([[3195, ["src/lib/plan.ts"]]]),
  );
  assert.equal(c?.creditHasBuildDiff, true, "precondition: the reconcile arm would credit this merge");
  const now = new Date().toISOString();
  const open = {
    prNumber: 4461,
    prUrl: "https://github.com/craigoley/remudero/pull/4461",
    taskId: "W1-T2371",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: now,
    createdAt: now,
    headSha: "t4942head",
    autoMergeArmed: false,
    isDependabot: false,
  } as OpenPrView;
  const [projected] = projectMergedTaskCandidates([open], [c!]);
  assert.equal(projected?.taskMergedBy, undefined, "a code diff must not stamp the destructive close");
  assert.doesNotMatch(deriveDisposition(projected!, DEFAULT_SWEEP_POLICY).reason, /already merged/);
});

function planOf(id: string): Plan {
  const t: Task = { id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, files: ["src/example.ts"] };
  return { tasks: [t], byId: new Map([[id, t]]) };
}

function gateway(taskId: string, prNumber: number): GitHub {
  const pr = {
    number: prNumber,
    url: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    state: "MERGED",
    headRefName: `run-${taskId}-1000`,
    body: `Remudero-Task: ${taskId}\n`,
  };
  return {
    listMergedHeadBranches: () => [pr],
    mergedTrailerLookup: () => (id: string) => (id === taskId ? pr : null),
    findMergedByTrailer: () => null,
    prByRef: () => pr,
    headRefName: () => pr.headRefName,
    prBody: () => pr.body,
    changedFiles: () => ["src/example.ts"],
  } as unknown as GitHub;
}

function mergeEvidenceAt(prNumber: number, subject: string, relPath: string): string {
  const repo = gitRepo({ kind: "w1-t4942-paths" });
  const full = join(repo.dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "x\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", `${subject} (#${prNumber})`);
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return repo.dir;
}

function build(taskId: string, prNumber: number, root: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4942-ledger-`));
  const ledger = join(dir, "ledger.ndjson");
  writeFileSync(ledger, "");
  return buildCreditCandidates("craigoley", "remudero", planOf(taskId), ledger, undefined, gateway(taskId, prNumber), () => root);
}

test("W1-T4942: the real credit builder reads merge paths from git", () => {
  const code = build("W1-T4942", 9101, mergeEvidenceAt(9101, "fix(plan): tolerate a bare id", "src/lib/plan.ts"));
  assert.equal(code.length, 1);
  assert.equal(code[0]?.creditIsImplementation, false);
  assert.equal(code[0]?.creditHasBuildDiff, true);
  assert.equal(creditIsReconcilable(code[0]!), true);

  const filing = build("W1-T4942", 9102, mergeEvidenceAt(9102, "chore: wip", "plan/tasks.d/W1-T4942-x.yaml"));
  assert.deepEqual(filing, [], "a plan-only merge is refused before credit candidacy");

  const absent = build("W1-T4942", 9103, mergeEvidenceAt(9999, "fix(plan): other pr", "src/lib/plan.ts"));
  assert.equal(absent[0]?.creditHasBuildDiff, undefined, "a PR outside the read window is unknown");
  assert.equal(creditIsReconcilable(absent[0]!), false);

  const unreadable = build("W1-T4942", 9104, mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4942-nogit-`)));
  assert.equal(unreadable[0]?.creditHasBuildDiff, undefined, "a failed git read cannot flip a shard");
  assert.equal(creditIsReconcilable(unreadable[0]!), false);

  const noRoot = build("W1-T4942", 9105, undefined);
  assert.equal(creditIsReconcilable(noRoot[0]!), false);
});
