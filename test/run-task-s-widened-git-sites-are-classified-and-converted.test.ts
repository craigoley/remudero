/**
 * W1-T6135 — RUN-TASK'S WIDENED GIT SITES ARE CLASSIFIED AND CONVERTED.
 *
 * W1-T6123's widened census (test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts)
 * counted src/run-task.ts under one lump reason. This suite holds the per-function record instead:
 *
 *   1. THE TABLE — every widened site left in src/run-task.ts (a `-C` argv under any name, a `cwd`
 *      option, or a git helper), counted per enclosing function, equals RUN_TASK_WIDENED_SITES exactly,
 *      each with its class and the tree it addresses. Every class is CHECKOUT: a tree only the harness
 *      writes. The file's WIDENED_SITE_EXCEPTIONS count is this table's sum, so a site added, removed or
 *      moved between functions fails here by name, not in a review.
 *   2. THE CONVERSIONS — planCriteriaAtHeadForRepair (an exported read whose cwd any caller may name)
 *      and materializeReviewerSnapshot (the reviewer's PR-head checkout) now reach the leaf.
 *   3. THE FIXTURES — on a PR-head tree whose `.git` pointer names a planted gitdir with a
 *      `core.fsmonitor` marker, neither function writes the marker; a raw `git -C` control proves the
 *      route is live first, so an absent marker is evidence.
 *
 * TWO CENSUSES, TWO METRICS: test/run-task-git-calls-into-a-worker-worktree-go-through-the-leaf.test.ts's
 * HARNESS_SITES counts every raw spawn and `-C` per declaration (W1-T6121's pattern); this table counts
 * W1-T6123's widened sites, the ones that address a tree. A function in both is described by both, each
 * for its own count; the CLASS lives only here.
 *
 * FIXTURES ONLY: every hostile byte is a `touch` of a marker under this suite's own mkdtemp root.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { worktreeAdd } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import * as runTask from "../src/run-task.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";
import { functionBody, widenedGitSites, WIDENED_SITE_EXCEPTIONS } from "./every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.js";

const FILE = "src/run-task.ts";
const SOURCE = fileURLToPath(new URL(`../${FILE}`, import.meta.url));

type SiteClass = "CHECKOUT";

const OWN = "the process's own checkout (repoRoot / process.cwd() / the caller's root): the code this process runs";
const MANAGED = "the managed checkout or a managed clone (repoDir), which only the harness fetches, resets and reads";
const FIX_CLONE = "the fix lane's clone (repoDir): its worktree registry, recovery refs and CAS push, never the fix worktree's own .git";
const GARDEN = "a gardener worktree cut at origin/main that only spec.apply writes; no worker session runs in it";

/** Every widened git site left in src/run-task.ts, per enclosing top-level function, with its class. */
export const RUN_TASK_WIDENED_SITES: Readonly<Record<string, { count: number; cls: SiteClass; reason: string }>> = {
  inspectFreshReviewerWorktree: { count: 1, cls: "CHECKOUT", reason: `${MANAGED}: lists its registered trees to find the origin/main reviewer-<sha> tree` },
  buildFreshTreeReviewRunner: { count: 1, cls: "CHECKOUT", reason: `${MANAGED}: fetches origin/main before the harness cuts its own reviewer tree` },
  buildBaseReproductionProbe: { count: 3, cls: "CHECKOUT", reason: "the probe's clone (repoDir): prune, add and remove of a detached origin/main tree no PR content reaches" },
  syncPlanFromOrigin: { count: 2, cls: "CHECKOUT", reason: `${MANAGED}: plan fetch and origin/main blob reads` },
  planSyncGitRunnerAsync: { count: 1, cls: "CHECKOUT", reason: `${MANAGED}: the async plan-sync runner` },
  refreshManagedCheckout: { count: 1, cls: "CHECKOUT", reason: MANAGED },
  resolveReviewSubjectCheckout: { count: 1, cls: "CHECKOUT", reason: "config.root/repos/<repo>, the target's managed checkout, read for its origin before any review" },
  planTreeIsBehindMain: { count: 1, cls: "CHECKOUT", reason: MANAGED },
  taskIdsEverFiled: { count: 1, cls: "CHECKOUT", reason: OWN },
  remotePlanCeilingOnRef: { count: 1, cls: "CHECKOUT", reason: OWN },
  reapBranchesSteps: { count: 1, cls: "CHECKOUT", reason: `${OWN}: exec binds cwd to opts.root ?? repoRoot` },
  censusMembershipCommand: { count: 1, cls: "CHECKOUT", reason: `${OWN}: deps.repoRoot ?? repoRoot` },
  ciLearningTaskIdMinter: { count: 1, cls: "CHECKOUT", reason: `${OWN}: the id-minting root` },
  defaultVerdictCalibrationGitLog: { count: 2, cls: "CHECKOUT", reason: `${OWN}: opts.cwd ?? repoRoot` },
  dispatchClaimReserverFor: { count: 1, cls: "CHECKOUT", reason: MANAGED },
  cloneTargetPlan: { count: 1, cls: "CHECKOUT", reason: "a fresh mkdtemp clone the harness makes of a target's plan" },
  buildReservationAuditReport: { count: 1, cls: "CHECKOUT", reason: OWN },
  nextTaskIdCommand: { count: 2, cls: "CHECKOUT", reason: OWN },
  filedShardSlugCorpus: { count: 1, cls: "CHECKOUT", reason: `${OWN}: an origin/main ls-tree` },
  defaultMergeEvidenceLog: { count: 2, cls: "CHECKOUT", reason: `${OWN}: lint-plan's whole-plan split only, never the review's --base lint` },
  defaultCreditedAmendmentEvidence: { count: 3, cls: "CHECKOUT", reason: `${OWN}: creditedProofVisibility's deps.cwd ?? repoRoot` },
  runPreflightProofs: { count: 1, cls: "CHECKOUT", reason: `${OWN}: the author's own checkout preflight runs in` },
  runPreflightScopedDiffCoverage: { count: 1, cls: "CHECKOUT", reason: `${OWN}: the author's own checkout preflight runs in` },
  readHeadShaForSummary: { count: 1, cls: "CHECKOUT", reason: OWN },
  retroShippedGithubGateway: { count: 1, cls: "CHECKOUT", reason: OWN },
  retroShippedGithubGatewayAsync: { count: 1, cls: "CHECKOUT", reason: `${OWN}: replay answers from commitGit, bound to opts.commitCwd ?? process.cwd()` },
  mergedPullRequestNumbers: { count: 1, cls: "CHECKOUT", reason: OWN },
  readPushedRunBranchesOutput: { count: 1, cls: "CHECKOUT", reason: OWN },
  readPushedRunBranchesOutputAsync: { count: 1, cls: "CHECKOUT", reason: `${OWN}: opts.cwd is repoRoot` },
  readDispatchFilingSnapshot: { count: 1, cls: "CHECKOUT", reason: "the drain's plan checkout (dispatchValueContextForSelection's planPath / target.planPath), never a worker tree" },
  planReloader: { count: 1, cls: "CHECKOUT", reason: MANAGED },
  dedicatedTargetPlanReloader: { count: 3, cls: "CHECKOUT", reason: `${MANAGED}: a dedicated target's plan checkout` },
  reviewerCodeRecoveryFromLoadedModule: { count: 1, cls: "CHECKOUT", reason: "the loaded module's own repository: the code this process runs" },
  runShardRepairPass: { count: 1, cls: "CHECKOUT", reason: `${OWN}: its one caller passes repoDir: repoRoot` },
  gardenCheckout: { count: 1, cls: "CHECKOUT", reason: GARDEN },
  gardenCheckoutAsync: { count: 1, cls: "CHECKOUT", reason: GARDEN },
  refreshKnowledgeAssertions: { count: 1, cls: "CHECKOUT", reason: GARDEN },
  buildRegisteredGarden: { count: 1, cls: "CHECKOUT", reason: OWN },
  gardenReplayCommand: { count: 1, cls: "CHECKOUT", reason: OWN },
  daemonCommand: { count: 3, cls: "CHECKOUT", reason: `${OWN} and the daemon module's own repository; ${MANAGED}` },
  installCheckoutCommand: { count: 1, cls: "CHECKOUT", reason: OWN },
  readMergedPathsByPr: { count: 1, cls: "CHECKOUT", reason: `${OWN}: the credit evidence root` },
  readMergeSubjectsByPr: { count: 1, cls: "CHECKOUT", reason: `${OWN}: the credit evidence root` },
  resolveMergeLogReadOptions: { count: 1, cls: "CHECKOUT", reason: `${OWN}: the credit evidence root` },
  creditEvidenceRootFor: { count: 1, cls: "CHECKOUT", reason: `${OWN}: or a managed clone of the credited repo` },
  registeredFixWorktreeOwner: { count: 1, cls: "CHECKOUT", reason: FIX_CLONE },
  removeAbandonedFixWorktreeOwner: { count: 1, cls: "CHECKOUT", reason: `${FIX_CLONE}; git resolves the removed tree from the clone's admin dir` },
  refCommitMatchesDirtyRecovery: { count: 3, cls: "CHECKOUT", reason: FIX_CLONE },
  preserveFixHead: { count: 3, cls: "CHECKOUT", reason: FIX_CLONE },
  publishAbandonedFixOwnerAhead: { count: 1, cls: "CHECKOUT", reason: FIX_CLONE },
  shardAgeDays: { count: 1, cls: "CHECKOUT", reason: OWN },
  idCitedInSrc: { count: 1, cls: "CHECKOUT", reason: OWN },
  approveCommand: { count: 6, cls: "CHECKOUT", reason: "an approve worktree cut at origin/main whose only writes are the harness's shard and skill files, and the clone it ls-remotes" },
  bundleExportCommand: { count: 1, cls: "CHECKOUT", reason: OWN },
  plannedOnOriginMain: { count: 1, cls: "CHECKOUT", reason: `${OWN}: dir defaults to repoRoot` },
};

/** The functions this task routed through the leaf: each holds no widened site and calls the leaf. */
const CONVERTED = ["planCriteriaAtHeadForRepair", "materializeReviewerSnapshot"] as const;
const LEAF_CALL = /\bhostWorktreeGit(?:Async|Result|AtTopLevel)?\(/;

function widenedByFunction(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const site of widenedGitSites(text)) out[site.fn ?? "<module>"] = (out[site.fn ?? "<module>"] ?? 0) + 1;
  return out;
}

const sorted = (r: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));

describe("W1-T6135: every widened git site left in run-task.ts is a classed CHECKOUT site", () => {
  const text = readFileSync(SOURCE, "utf8");
  const actual = widenedByFunction(text);

  it("the census sees the file: a positive control on the widened pattern", () => {
    const total = Object.values(actual).reduce((a, b) => a + b, 0);
    assert.ok(total >= 50, `the widened pattern must find run-task's harness sites, found ${total}`);
    assert.equal(actual["<module>"], undefined, "every site is attributed to a top-level function");
  });

  it("the widened sites per function equal RUN_TASK_WIDENED_SITES exactly, each CHECKOUT with a reason", () => {
    for (const [name, site] of Object.entries(RUN_TASK_WIDENED_SITES)) {
      assert.equal(site.cls, "CHECKOUT", `${name} is classed ${site.cls}`);
      assert.ok(site.reason.length > 20, `${name} records no reason`);
    }
    const expected = sorted(Object.fromEntries(Object.entries(RUN_TASK_WIDENED_SITES).map(([n, s]) => [n, s.count])));
    assert.deepEqual(sorted(actual), expected,
      "a widened git site was added, removed or moved: route a worker/reviewer site through hostWorktreeGit, or class it here");
  });

  it("the file's WIDENED_SITE_EXCEPTIONS count is this table's sum and names this table, not a lump", () => {
    const sum = Object.values(RUN_TASK_WIDENED_SITES).reduce((a, s) => a + s.count, 0);
    const entry = WIDENED_SITE_EXCEPTIONS[FILE];
    assert.ok(entry, `${FILE} has a widened exception`);
    assert.equal(entry.count, sum);
    assert.match(entry.reason, /^CHECKOUT\b/);
    assert.match(entry.reason, /RUN_TASK_WIDENED_SITES/);
    assert.match(entry.reason, /run-task-s-widened-git-sites-are-classified-and-converted\.test\.ts/);
  });

  it("no function that addresses a worker or PR-head tree holds a widened site, and each calls the leaf", () => {
    for (const name of CONVERTED) {
      assert.equal(Object.hasOwn(RUN_TASK_WIDENED_SITES, name), false, `${name} is both converted and a CHECKOUT site`);
      assert.equal(actual[name], undefined, `${name} still holds ${actual[name]} widened site(s)`);
      const body = functionBody(text, name);
      assert.ok(body, `${name} not found`);
      assert.match(body, LEAF_CALL, `${name} does not call the hardened leaf`);
    }
  });

  it("a raw git -C added to a converted function, or moved into a new one, fails the table naming it", () => {
    const grown = text.replace(/^export function planCriteriaAtHeadForRepair\(([^\n]*)\{\n/m,
      (head) => `${head}  execFileSync("git", ["-C", cwd, "status"]);\n`);
    assert.notEqual(grown, text, "the fixture edit applied");
    assert.equal(widenedByFunction(grown).planCriteriaAtHeadForRepair, 1);
  });
});

// ── THE FIXTURES ───────────────────────────────────────────────────────────────────────────────

let root: string;
let markers: string;
let counter = 0;

const TASK = "W1-T6135-FIXTURE";
const CRITERIA = [{ claim: "the fixture resolves at head", proof: "unit test: the fixture resolves at head" }];

function raw(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function marker(name: string): string {
  return join(markers, name);
}

/** A seeded origin + source carrying a plan that declares TASK, and a run worktree cut from it by the
 *  real `worktreeAdd` (so it has a recorded gitdir the leaf pins to). */
function cutLane(): { wt: string; head: string } {
  const n = ++counter;
  const remote = gitRepo({ bare: true, kind: `t6135-remote-${n}` }).dir;
  const seed = gitRepo({ kind: `t6135-seed-${n}` });
  seed.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  seed.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  mkdirSync(join(seed.dir, "plan"));
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"),
    JSON.stringify([{ id: TASK, title: "fixture", repo: "remudero", type: "implement", acceptance: CRITERIA }]));
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "chore: seed");
  seed.addRemote("origin", remote);
  seed.git("push", "-q", "origin", "main");
  const wt = join(root, `t6135-wt-${n}`);
  worktreeAdd(seed.dir, wt, `run-T6135-${n}-1`, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  return { wt, head: raw(wt, "rev-parse", "HEAD").trim() };
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

/** Runs `body` with a global git config whose core.fsmonitor writes `name`'s marker. */
function withGlobalFsmonitor<T>(name: string, body: () => T): T {
  const config = join(root, `global-${name}.gitconfig`);
  writeFileSync(config, `[core]\n\tfsmonitor = sh -c 'touch "${marker(`global-fsmonitor-${name}`)}"'\n`);
  const prior = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  try {
    return body();
  } finally {
    if (prior === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prior;
  }
}

const BODY = `fixture body\n\nRemudero-Task: ${TASK}`;
const ABSENT_SHA = "6135613561356135613561356135613561356135";

before(() => {
  root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6135-`));
  markers = join(root, "markers");
  mkdirSync(markers);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("W1-T6135: the controls — each hostile route is live through a raw git -C", () => {
  it("a raw fetch through a planted pointer runs the planted fsmonitor", () => {
    const { wt } = cutLane();
    pointAt(wt, plantGitDir("control"));
    assert.throws(() => raw(wt, "fetch", "--quiet", "origin", ABSENT_SHA), "the planted gitdir has no origin");
    assert.ok(existsSync(marker("planted-fsmonitor-control")), "control: the planted core.fsmonitor command is live");
  });

  it("a raw detached checkout under a global core.fsmonitor runs it", () => {
    const { wt, head } = cutLane();
    withGlobalFsmonitor("control", () => raw(wt, "checkout", "--quiet", "--detach", "--force", head));
    assert.ok(existsSync(marker("global-fsmonitor-control")), "control: the global core.fsmonitor command is live");
  });
});

describe("W1-T6135: planCriteriaAtHeadForRepair reads a PR head through the leaf", () => {
  it("resolves the task's criteria at a legitimate head, from the tree and from below its top level", () => {
    const { wt, head } = cutLane();
    assert.deepEqual(runTask.planCriteriaAtHeadForRepair(BODY, head, wt), CRITERIA);
    assert.deepEqual(runTask.planCriteriaAtHeadForRepair(BODY, head, join(wt, "plan")), CRITERIA);
  });

  it("on a tree whose .git pointer names a planted gitdir, reads nothing and never writes the marker", () => {
    const { wt } = cutLane();
    pointAt(wt, plantGitDir("criteria"));
    assert.deepEqual(runTask.planCriteriaAtHeadForRepair(BODY, ABSENT_SHA, wt), [], "a refused read is no cure");
    assert.equal(existsSync(marker("planted-fsmonitor-criteria")), false, "the planted fsmonitor never ran");
  });
});

describe("W1-T6135: materializeReviewerSnapshot checks out the PR head through the leaf", () => {
  it("refuses a PR-head tree whose .git pointer names a planted gitdir, never writing the marker", () => {
    const { wt, head } = cutLane();
    pointAt(wt, plantGitDir("snapshot"));
    const reviewRoot = mkdtempSync(join(root, "review-"));
    assert.throws(() => runTask.materializeReviewerSnapshot(reviewRoot, wt, head),
      (e: unknown) => e instanceof Error && e.name === "ReviewerSnapshotError" && /not a readable Git repository/.test(e.message));
    assert.equal(existsSync(marker("planted-fsmonitor-snapshot")), false, "the planted fsmonitor never ran");
  });

  it("materializes a legitimate PR head, its checkout running no code-executing config", () => {
    const { wt, head } = cutLane();
    const reviewRoot = mkdtempSync(join(root, "review-"));
    const snapshot = withGlobalFsmonitor("snapshot", () => runTask.materializeReviewerSnapshot(reviewRoot, wt, head));
    assert.equal(snapshot.cwd, join(reviewRoot, "checkout"));
    assert.equal(raw(snapshot.cwd, "rev-parse", "HEAD").trim(), head);
    assert.equal(readFileSync(join(snapshot.cwd, "plan", "tasks.yaml"), "utf8").includes(TASK), true);
    assert.equal(existsSync(marker("global-fsmonitor-snapshot")), false, "the checkout ran no fsmonitor");
  });
});
