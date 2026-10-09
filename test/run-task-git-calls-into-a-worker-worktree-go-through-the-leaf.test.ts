/**
 * W1-T6121 — RUN-TASK'S GIT CALLS INTO A WORKER WORKTREE GO THROUGH THE LEAF.
 *
 * W1-T6106 added `hostWorktreeGit` (src/lib/worktree-git.ts): it pins the gitdir the harness recorded,
 * refuses a rewritten `.git` pointer, and disables code-executing config and the worktree's tracked
 * hooks/. This task routes every src/run-task.ts git call that addresses a WORKER tree (one a worker
 * session or model tool wrote to) or a REVIEWER tree (a checkout of a PR head) through it. Two checks:
 *
 *   1. THE CENSUS — every raw git spawn or `-C` argv left in src/run-task.ts, counted per enclosing
 *      top-level declaration, equals HARNESS_SITES exactly: each a HARNESS-only site (a tree only the
 *      harness writes) with its reason. CONVERTED names the worker/reviewer functions, each of which
 *      must reach the leaf and hold no raw git at all. A new raw site anywhere in the file fails.
 *   2. THE FIXTURES — run-task's own functions, on worktrees whose tracked hooks/ and planted `.git`
 *      pointer each leave a marker, do their legitimate work and write no marker. A raw `git -C`
 *      control first proves each hostile route is live, so an absent marker is evidence.
 *
 * FIXTURES ONLY: every hostile byte is a `touch` of a marker under this suite's own mkdtemp root.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { worktreeAdd } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { OpenPrView } from "../src/lib/sweep.js";
import * as runTask from "./helpers/run-task-test.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

const SOURCE = fileURLToPath(new URL("../src/run-task.ts", import.meta.url));

/** A raw git spawn, or a `-C` argv element, wherever it sits. */
const RAW_GIT = /"-C",|\b(?:execFileSync|execFile|execFilePromise|spawnSync|spawn|exec|baseReproductionExecFile)\(\s*"git"/g;
const LEAF_CALL = /\bhostWorktreeGit(?:Async|Result)?\b/;
const DECL = /^(?:export )?(?:declare )?(?:async )?(?:function\*? |const |let |class |interface |type |enum )([A-Za-z_$][\w$]*)/;

const OWN = "the process's own checkout (repoRoot / process.cwd()): the code this process runs, never a worker's tree";
const CLONE = "a managed clone or the daemon's checkout, which only the harness writes (fetches, refs, plan and log reads)";
const FIX_CLONE = "the fix lane's clone: its worktree registry, recovery refs and the CAS push made from the clone itself";
const GARDEN = "a gardener worktree cut at origin/main that only the harness writes (spec.apply); no worker session runs in it";
const APPROVE = "an approve worktree cut at origin/main whose only writes are the harness's own shard and skill files";
const FRESH_REVIEWER = "the reviewer-<sha> tree at origin/main the harness runs its OWN code from (W1-T3723); no PR content is checked out";

/** Every raw git site left in src/run-task.ts, per enclosing top-level declaration: HARNESS-only. */
const HARNESS_SITES: Readonly<Record<string, { count: number; reason: string }>> = {
  inspectFreshReviewerWorktree: { count: 3, reason: `${FRESH_REVIEWER}; its git is the injected seam` },
  buildFreshTreeReviewRunner: { count: 1, reason: `${FRESH_REVIEWER}: the fetch into repoRoot` },
  buildBaseReproductionProbe: { count: 4, reason: "the base-reproduction probe's clone: prune, add and remove of its origin/main tree" },
  buildSweepEffects: { count: 1, reason: `the fresh-tree runner's git seam over repoRoot; ${FRESH_REVIEWER}` },
  syncPlanFromOrigin: { count: 4, reason: CLONE },
  planSyncGitRunnerAsync: { count: 1, reason: CLONE },
  materializeReviewerSnapshot: { count: 1, reason: "the `git clone --shared` of the source top level the leaf has just pinned; the checkout and every read go through the leaf (W1-T6135)" },
  refreshManagedCheckout: { count: 2, reason: CLONE },
  pushFixRound: { count: 2, reason: "seam argv for its exec/capture, whose defaults run the leaf (W1-T6106)" },
  resolveReviewSubjectCheckout: { count: 2, reason: CLONE },
  planTreeIsBehindMain: { count: 2, reason: CLONE },
  taskIdsEverFiled: { count: 1, reason: OWN },
  remotePlanCeilingOnRef: { count: 1, reason: OWN },
  checkAcceptanceChangedFiles: { count: 1, reason: OWN },
  reapBranchesSteps: { count: 1, reason: OWN },
  censusMembershipCommand: { count: 2, reason: OWN },
  ciLearningTaskIdMinter: { count: 1, reason: OWN },
  defaultVerdictCalibrationGitLog: { count: 2, reason: OWN },
  removeBaseProofWorktree: { count: 2, reason: "removes a base tree from the clone or the caller's own checkout; `worktree remove` runs no hook" },
  triageClaimReserverFor: { count: 2, reason: "test-only sync binding to a clone; production takes triageClaimReserverAsyncFor(repoDir)" },
  dispatchClaimReserverFor: { count: 2, reason: CLONE },
  mergedTriageSubjects: { count: 2, reason: `${CLONE}: its one caller passes repoDir, never the triage worktree` },
  cloneTargetPlan: { count: 1, reason: "a fresh mkdtemp clone the harness makes of a target's plan" },
  buildReservationAuditReport: { count: 1, reason: OWN },
  nextTaskIdCommand: { count: 2, reason: OWN },
  filedShardSlugCorpus: { count: 2, reason: OWN },
  defaultMergeEvidenceLog: { count: 2, reason: `${OWN}; whole-plan scope only, never the review's --base lint` },
  defaultCreditedAmendmentEvidence: { count: 3, reason: OWN },
  runPreflightProofs: { count: 1, reason: OWN },
  runPreflightScopedDiffCoverage: { count: 1, reason: OWN },
  readHeadShaForSummary: { count: 2, reason: OWN },
  retroShippedGithubGateway: { count: 2, reason: OWN },
  mergedPullRequestNumbers: { count: 1, reason: OWN },
  readPushedRunBranchesOutput: { count: 1, reason: OWN },
  readPushedRunBranchesOutputAsync: { count: 1, reason: OWN },
  readDispatchFilingSnapshot: { count: 2, reason: `${CLONE}: the dispatch plan's own checkout` },
  planReloader: { count: 2, reason: CLONE },
  dedicatedTargetPlanReloader: { count: 6, reason: CLONE },
  reviewerCodeRecoveryFromLoadedModule: { count: 2, reason: "the loaded module's own repository" },
  runShardRepairPass: { count: 2, reason: CLONE },
  gardenCheckout: { count: 2, reason: GARDEN },
  gardenCheckoutAsync: { count: 2, reason: GARDEN },
  refreshKnowledgeAssertions: { count: 2, reason: GARDEN },
  buildRegisteredGarden: { count: 2, reason: OWN },
  gardenReplayCommand: { count: 2, reason: OWN },
  daemonCommand: { count: 6, reason: `${OWN} and the daemon's own module repository` },
  installCheckoutCommand: { count: 2, reason: OWN },
  readMergedPathsByPr: { count: 1, reason: OWN },
  readMergeSubjectsByPr: { count: 1, reason: OWN },
  resolveMergeLogReadOptions: { count: 1, reason: OWN },
  creditEvidenceRootFor: { count: 1, reason: OWN },
  registeredFixWorktreeOwner: { count: 2, reason: FIX_CLONE },
  removeAbandonedFixWorktreeOwner: { count: 2, reason: FIX_CLONE },
  refCommitMatchesDirtyRecovery: { count: 6, reason: FIX_CLONE },
  preserveFixHead: { count: 6, reason: FIX_CLONE },
  publishAbandonedFixOwnerAhead: { count: 2, reason: FIX_CLONE },
  shardAgeDays: { count: 2, reason: OWN },
  idCitedInSrc: { count: 2, reason: OWN },
  approveCommand: { count: 20, reason: `${APPROVE}, and the clone it ls-remotes` },
  approveBatchCommand: { count: 6, reason: APPROVE },
  bundleExportCommand: { count: 2, reason: OWN },
  plannedOnOriginMain: { count: 2, reason: OWN },
};

/** The functions that address a worker or reviewer tree: each reaches the leaf and spawns no raw git. */
const CONVERTED = [
  "readWorktreeHeadReflog", "workerCreatedCurrentHead", "fillDerivedBody", "lastCommitSubject",
  "assertReviewerSnapshotIntegrity", "runPlanScopedFixRound", "captureWorktreeSnapshotViaGit",
  "readFixRoundCommitsViaGit", "commitGeneratorOutputViaGit", "runFixRung", "buildProofAmendmentGitOps",
  "proofRepairRoundRefusalInWorktree", "commitsAhead", "deferOpenToSiblingPr", "realCoverageChangedFiles",
  "repairCensusRefusedPush", "runTaskBody", "buildBaseProofDir", "lintScopeMergeBase", "lintPlanForReview",
  "lintPlanCommand", "citationStampPassFor", "headProvenanceFields", "worktreeHasUncommittedChanges",
  "missingCommitLinePrompt", "worktreeChangedFiles", "worktreeMergeBase", "worktreeGitRunner",
  "readRegistrationChanges", "captureRegisteredFixOwnerSnapshot", "temporaryIndexTree",
  "preserveStagedFixOwnerResidue", "readFixOwnerResidue", "readTrackedDirtyOwnerPatch", "preserveTrackedDirtyPatch",
  "resetTrackedDirtyFixOwner", "checkoutFixHeadRef", "createFixRungWorktree", "triageCommandLocked", "planCommand",
  "defaultShardGitRunner",
] as const;

/** Raw git sites and leaf calls per top-level declaration of `text`. */
function sitesByDeclaration(text: string): { raw: Map<string, number>; leaf: Set<string>; declared: Set<string> } {
  const owners: string[] = [];
  const declared = new Set<string>();
  let current = "<module>";
  for (const line of text.split("\n")) {
    const m = DECL.exec(line);
    if (m) declared.add((current = m[1]!));
    owners.push(current);
  }
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const ownerAt = (index: number): string => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return owners[lo]!;
  };
  const raw = new Map<string, number>();
  for (const m of text.matchAll(RAW_GIT)) raw.set(ownerAt(m.index), (raw.get(ownerAt(m.index)) ?? 0) + 1);
  const leaf = new Set<string>();
  text.split("\n").forEach((line, i) => { if (LEAF_CALL.test(line)) leaf.add(owners[i]!); });
  return { raw, leaf, declared };
}

describe("W1-T6121: every raw git site left in run-task.ts is a reasoned HARNESS site", () => {
  const text = readFileSync(SOURCE, "utf8");
  const { raw, leaf, declared } = sitesByDeclaration(text);

  it("the census sees the file: a positive control on its own pattern", () => {
    const total = [...raw.values()].reduce((a, b) => a + b, 0);
    assert.ok(total >= 100, `the pattern must find the known harness sites, found ${total}`);
    assert.ok(declared.size > 1000, `the walk must see run-task's declarations, saw ${declared.size}`);
  });

  it("the raw sites per declaration equal HARNESS_SITES exactly, each with a reason", () => {
    for (const [name, site] of Object.entries(HARNESS_SITES)) {
      assert.ok(declared.has(name), `HARNESS_SITES names a declaration run-task.ts no longer has: ${name}`);
      assert.ok(site.reason.length > 20, `${name} records no reason`);
    }
    const actual = Object.fromEntries([...raw].sort(([a], [b]) => a.localeCompare(b)));
    const expected = Object.fromEntries(Object.entries(HARNESS_SITES).map(([n, s]) => [n, s.count]).sort(([a], [b]) => String(a).localeCompare(String(b))));
    assert.deepEqual(actual, expected,
      "a raw git site was added or removed: route a worker/reviewer site through hostWorktreeGit, or record a HARNESS one here");
  });

  it("every function that addresses a worker or reviewer tree calls the leaf and spawns no raw git", () => {
    const failures: string[] = [];
    for (const name of CONVERTED) {
      if (!declared.has(name)) failures.push(`${name}: not found`);
      else if (!leaf.has(name)) failures.push(`${name}: does not call the hardened leaf`);
      else if (raw.has(name)) failures.push(`${name}: still holds ${raw.get(name)} raw git site(s)`);
      if (Object.hasOwn(HARNESS_SITES, name)) failures.push(`${name}: is both converted and a harness site`);
    }
    assert.deepEqual(failures, []);
  });

  it("a raw git -C added to a converted function fails the census naming it", () => {
    const grown = text.replace(/^export function worktreeHasUncommittedChanges\(worktreePath: string\): boolean \{\n/m,
      (head) => `${head}  execFileSync("git", ["-C", worktreePath, "status"]);\n`);
    assert.notEqual(grown, text, "the fixture edit applied");
    const { raw: grownRaw } = sitesByDeclaration(grown);
    assert.equal(grownRaw.get("worktreeHasUncommittedChanges"), 2);
  });
});

// ── THE FIXTURES ───────────────────────────────────────────────────────────────────────────────

let root: string;
let markers: string;
let counter = 0;

function raw(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function marker(name: string): string {
  return join(markers, name);
}

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

const TRACKED_HOOKS = ["pre-commit", "commit-msg", "prepare-commit-msg", "post-commit", "post-checkout", "pre-push"];

/** A seeded origin + source whose TRACKED hooks/ each leave a marker (and `core.hooksPath=hooks` on the
 *  source itself), and a run worktree cut from it by the real `worktreeAdd`. */
function cutLane(extra: Record<string, string> = {}): { wt: string; branch: string; source: string; n: number } {
  const n = ++counter;
  const remote = gitRepo({ bare: true, kind: `t6121-remote-${n}` }).dir;
  const seed = gitRepo({ kind: `t6121-seed-${n}` });
  seed.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  seed.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  mkdirSync(join(seed.dir, "hooks"));
  for (const hook of TRACKED_HOOKS) script(join(seed.dir, "hooks", hook), `touch '${marker(`tracked-${hook}-${n}`)}'`);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  for (const [path, body] of Object.entries(extra)) {
    mkdirSync(join(seed.dir, path, ".."), { recursive: true });
    writeFileSync(join(seed.dir, path), body);
  }
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "chore: seed");
  seed.addRemote("origin", remote);
  seed.git("push", "-q", "origin", "main");
  seed.git("config", "core.hooksPath", "hooks");
  const wt = join(root, `t6121-wt-${n}`);
  const branch = `run-T6121-${n}-1`;
  worktreeAdd(seed.dir, wt, branch, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  raw(wt, "config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  raw(wt, "config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  // The cut itself is worktreeAdd's (src/lib/worker.ts, outside this task): only what runs AFTER it counts.
  for (const hook of TRACKED_HOOKS) rmSync(marker(`tracked-${hook}-${n}`), { force: true });
  return { wt, branch, source: seed.dir, n };
}

function trackedHooksThatRan(n: number): string[] {
  return TRACKED_HOOKS.filter((hook) => existsSync(marker(`tracked-${hook}-${n}`)));
}

/** A crafted gitdir outside the worktree whose config runs a marker on every index refresh. */
function plantGitDir(name: string): string {
  const evil = join(root, `planted-${name}`);
  raw(root, "init", "-q", evil);
  raw(evil, "config", "core.fsmonitor", `sh -c 'touch "${marker(`planted-fsmonitor-${name}`)}"'`);
  return join(evil, ".git");
}

function pointAt(wt: string, gitDir: string): void {
  writeFileSync(join(wt, ".git"), `gitdir: ${gitDir}\n`);
}

const isPointerRefusal = (e: unknown): boolean => e instanceof Error && e.name === "WorktreePointerRefusedError";
const silentLog = (): void => {};

before(() => {
  root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6121-`));
  markers = join(root, "markers");
  mkdirSync(markers);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("W1-T6121: the controls — each hostile route is live through a raw git -C", () => {
  it("a raw commit in a lane runs its tracked hooks, and a raw status through a planted pointer runs its fsmonitor", () => {
    const { wt, n } = cutLane();
    writeFileSync(join(wt, "control.txt"), "c\n");
    raw(wt, "add", "control.txt");
    raw(wt, "commit", "-q", "-m", "feat: control");
    assert.ok(trackedHooksThatRan(n).includes("pre-commit"), "control: the raw commit ran the tracked pre-commit");
    pointAt(wt, plantGitDir("control"));
    raw(wt, "status", "--porcelain");
    assert.ok(existsSync(marker("planted-fsmonitor-control")), "control: the planted core.fsmonitor command is live");
  });

  it("a raw worktree add from the source runs its tracked post-checkout", () => {
    const { source, n } = cutLane();
    raw(source, "worktree", "add", "--detach", join(root, `control-add-${n}`), "origin/main");
    assert.ok(trackedHooksThatRan(n).includes("post-checkout"), "control: the raw checkout ran the tracked post-checkout");
  });
});

describe("W1-T6121: a fix-round commit through run-task's own functions runs no tracked hook", () => {
  it("runPlanScopedFixRound commits the worker's plan edit and pushes it, running none of the lane's hooks", async () => {
    const path = "plan/tasks.d/W1-T6121-fixture.yaml";
    const { wt, n } = cutLane();
    mkdirSync(join(wt, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(wt, path), "- id: W1-T6121\n");
    runTask.commitGeneratorOutputViaGit({ cwd: wt, message: "chore(plan): file the fixture" });
    const headSha = raw(wt, "rev-parse", "HEAD").trim();
    const body = `## Acceptance\n- the shard is filed | grep: id: W1-T6121 in ${path}`;
    const pushed: string[] = [];
    let preflights = 0;
    const pr = { prNumber: 9121, prUrl: "https://github.com/acme/remudero/pull/9121", headSha, headRefName: "ci-friction-garden-1",
      isPlanFiling: true, checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 0,
      lastActivityAt: new Date().toISOString(), autoMergeArmed: false, ciFailures: [], body } as unknown as OpenPrView;
    const result = await runTask.runPlanScopedFixRound({
      pr, worktreePath: wt, title: "chore(plan): file fixture", body,
      task: { id: "PR-9121", title: "fixture", files: [path] },
      deps: {
        preflight: async () => (++preflights === 1
          ? { ok: false, failures: [{ check: "lint-plan", firstLine: "rationale is missing" }], unreadable: [] }
          : { ok: true, failures: [], unreadable: [] }),
        spawn: async () => {
          writeFileSync(join(wt, path), "- id: W1-T6121\n  rationale: supplied\n");
          return "COMMIT_MESSAGE: fix(plan): supply rationale";
        },
        push: async (sha: string) => { pushed.push(sha); },
        updateMetadata: async () => {},
        execProof: () => ({ hits: 1 }),
        log: silentLog,
      },
    });
    assert.equal(result.outcome, "pushed", result.reason);
    assert.equal(raw(wt, "log", "-1", "--format=%s").trim(), "fix(plan): supply rationale");
    assert.deepEqual(pushed, [raw(wt, "rev-parse", "HEAD").trim()]);
    assert.deepEqual(trackedHooksThatRan(n), [], "no tracked hook ran on the round's commits");
  });

  it("commitGeneratorOutputViaGit and the proof-amendment git ops commit, running none of the lane's hooks", () => {
    const { wt, n } = cutLane();
    const start = raw(wt, "rev-parse", "HEAD").trim();
    writeFileSync(join(wt, "generated.txt"), "g\n");
    const generated = runTask.commitGeneratorOutputViaGit({ cwd: wt, message: "chore: generator output" });
    assert.equal(generated.changed, true);
    assert.equal(generated.sha, raw(wt, "rev-parse", "HEAD").trim());
    const ops = runTask.buildProofAmendmentGitOps();
    writeFileSync(join(wt, "amended.txt"), "a\n");
    ops.gitAdd(wt, "amended.txt");
    const sha = ops.gitCommit(wt, "chore(plan): amend a proof");
    assert.equal(sha, raw(wt, "rev-parse", "HEAD").trim());
    assert.equal(raw(wt, "status", "--porcelain"), "");
    const commits = runTask.readFixRoundCommitsViaGit(wt, start);
    assert.deepEqual(commits.map(({ subject, changedFiles, diffStat }) => ({ subject, changedFiles, diffStat })), [
      { subject: "chore: generator output", changedFiles: 1, diffStat: "generated.txt | 1 +\n 1 file changed, 1 insertion(+)" },
      { subject: "chore(plan): amend a proof", changedFiles: 1, diffStat: "amended.txt | 1 +\n 1 file changed, 1 insertion(+)" },
    ]);
    assert.ok(commits.every(commit => /^[a-f0-9]{64}$/.test(commit.diffDigest ?? "")), "both commits carry content-addressed diff evidence");
    assert.deepEqual(trackedHooksThatRan(n), [], "no tracked hook ran");
  });

  it("createFixRungWorktree cuts and checks out the PR head ref without running its tracked post-checkout", async () => {
    const { source, n } = cutLane();
    raw(source, "-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "HEAD:refs/heads/run-T6121-fix");
    const wt = join(root, `fix-rung-${n}`);
    const recovery = await runTask.createFixRungWorktree(source, wt, "run-T6121-fix");
    assert.equal(recovery, undefined);
    assert.equal(raw(wt, "symbolic-ref", "HEAD").trim(), "refs/heads/run-T6121-fix");
    assert.equal(raw(wt, "rev-parse", "HEAD").trim(), raw(source, "rev-parse", "origin/run-T6121-fix").trim());
    assert.deepEqual(trackedHooksThatRan(n), [], "no tracked hook ran on the fix rung's checkout");
  });
});

describe("W1-T6121: a worktree read through run-task's own functions never follows a planted pointer", () => {
  it("captureWorktreeSnapshotViaGit reads a legitimate lane, and through a planted pointer reads nothing and writes no marker", () => {
    const { wt } = cutLane();
    writeFileSync(join(wt, "dirty.txt"), "d\n");
    assert.notEqual(runTask.captureWorktreeSnapshotViaGit(wt), undefined, "a legitimate lane reads");
    pointAt(wt, plantGitDir("snapshot"));
    assert.equal(runTask.captureWorktreeSnapshotViaGit(wt), undefined, "a refused read is never-a-match");
    assert.equal(existsSync(marker("planted-fsmonitor-snapshot")), false, "the planted fsmonitor never ran");
  });

  it("worktreeHasUncommittedChanges and the generator commit refuse a planted pointer by name, writing no marker", () => {
    const { wt } = cutLane();
    writeFileSync(join(wt, "dirty.txt"), "d\n");
    assert.equal(runTask.worktreeHasUncommittedChanges(wt), true);
    pointAt(wt, plantGitDir("status"));
    assert.throws(() => runTask.worktreeHasUncommittedChanges(wt), isPointerRefusal);
    assert.throws(() => runTask.commitGeneratorOutputViaGit({ cwd: wt, message: "chore: never" }), isPointerRefusal);
    assert.throws(() => runTask.buildProofAmendmentGitOps().gitAdd(wt, "dirty.txt"), isPointerRefusal);
    assert.equal(existsSync(marker("planted-fsmonitor-status")), false, "the planted fsmonitor never ran");
  });

  it("the spawn-shaped runner a reserver takes rethrows a pointer refusal and reports a git failure as its status", () => {
    const { wt } = cutLane();
    const missing = runTask.hostWorktreeGitResult(wt, ["rev-parse", "--verify", "--quiet", "refs/heads/no-such-ref"]);
    assert.equal(missing.status, 1);
    assert.equal(runTask.hostWorktreeGitResult(wt, ["rev-parse", "HEAD"]).stdout.trim(), raw(wt, "rev-parse", "HEAD").trim());
    pointAt(wt, plantGitDir("result"));
    assert.throws(() => runTask.hostWorktreeGitResult(wt, ["status"]), isPointerRefusal);
    assert.equal(existsSync(marker("planted-fsmonitor-result")), false);
  });
});

