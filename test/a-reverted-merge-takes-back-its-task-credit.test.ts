/**
 * W1-T14302 — a task whose credited merge is later reverted on main loses that credit, and a shard already flipped to
 * merged by that credit goes back to queued with a declared ledger row.
 *
 * 2026-11-22: W1-T11112 merged as #20049, #20136 reverted it ("This reverts commit 3a6fe5dd57..."), and the plan
 * reconcile still flipped its shard to merged. GitHub keeps #20049 MERGED and its commit stays on main, so no credit
 * rung saw the revert. An operator remove-credit row did not help either: every fleet projection read
 * <config.root>/plan/credit-overrides.yaml, which does not exist on the fleet host.
 *
 * Every history here is a fixture git repository with origin o/r; no test reads this repository's history or calls
 * GitHub (the landing test answers `gh` from a shim).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { buildBatchedGithub, buildCommitTrailerIndex, planCreditOverridePath, projectPlan, type BatchedPr, type CreditStore, type GitHub, type StatusProjection } from "#src/lib/status.js";
import { revertedMergesFromLog } from "#src/lib/reverted-merges.js";
import { reconcileShardStatus, requeueRevertedShard, requeueShardStatusText, revertedRequeues, type RevertedRequeue } from "#src/lib/plan-reconcile.js";
import { buildPlanReconcileCadenceInput, planReconcileCadence, type CreditedMergedIds } from "#src/lib/measurement-cadence.js";
import { landingIdentity, landPlanReconcileShardsAsync, planReconcileLanding, type LandContentInput, type LandFeedbackResult, type PlanReconcileLand } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { LEDGER_STEPS } from "#src/lib/ledger-steps.js";
import { loadPlanFromYaml, type Plan } from "#src/lib/plan.js";
import { createTickReadProducer } from "#src/lib/tick-read-worker.js";
import { createGhCallPacer } from "#src/lib/github-transport.js";
import { dispatchClaimRef, releaseLandedDispatchClaims, type DispatchClaimListing, type DispatchClaimReserverAsync } from "#src/lib/dispatch-claim.js";
import { projectMergedTaskCandidates, type OpenPrView } from "#src/lib/sweep.js";
import { sweepCreditCandidates } from "#src/cli/commands/sweep.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ORIGIN = "https://github.com/o/r.git";
const url = (n: number): string => `https://github.com/o/r/pull/${n}`;
const RUN_HEAD = "run-W1-T1-1790000000000";

/** A shard as the plan loader reads it. */
function shardYaml(id: string, extra = ""): string {
  return `- id: ${id}\n  title: ${id} fixture\n  repo: r\n  type: implement\n  depends_on: []\n  files: [src/${id}.ts]\n  status: queued\n${extra}`;
}
const planOf = (...shards: string[]): Plan => loadPlanFromYaml(shards.join(""), "fixture");

/** One commit of a fixture main: its subject and body, or a function of the shas committed before it. */
type Commit = { subject: string; body?: string };
type Step = Commit | ((shas: readonly string[]) => Commit);

/** A fixture checkout whose origin is o/r and whose origin/main holds `steps`, oldest first. Returns each sha. */
function mainHistory(t: TestContext, steps: readonly Step[], origin = ORIGIN): { dir: string; shas: string[] } {
  const repo = gitRepo({ scope: t, seedCommit: false, kind: "t14302-main" });
  repo.addRemote("origin", origin);
  const shas: string[] = [];
  for (const step of steps) {
    const c = typeof step === "function" ? step(shas) : step;
    repo.git("commit", "--quiet", "--allow-empty", "-m", c.subject, ...(c.body ? ["-m", c.body] : []));
    shas.push(repo.git("rev-parse", "HEAD"));
  }
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { dir: repo.dir, shas };
}

const BUILD_101: Commit = { subject: "feat(x): build W1-T1 (#101)", body: "Remudero-Task: W1-T1" };
const revertOf = (sha: string, pr: number): Commit => ({ subject: `Revert "feat(x): build W1-T1 (#101)" (#${pr})`, body: `This reverts commit ${sha}.` });
/** The revert of the first commit, as PR `pr`. */
const revertsFirst = (pr: number): Step => (shas) => revertOf(shas[0]!, pr);
/** The revert of the commit at `index`, as PR `pr`. */
const revertsAt = (index: number, pr: number): Step => (shas) => ({ subject: `Revert "Revert" (#${pr})`, body: `This reverts commit ${shas[index]!}.` });

function execGit(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function mergedRow(n: number, body = "Remudero-Task: W1-T1", headRefName = RUN_HEAD): BatchedPr {
  return { number: n, url: url(n), state: "MERGED", headRefName, body, title: `feat(x): build (#${n})` };
}

/** The production gateway over injected PR rows and the fixture checkout's real commit history. */
function gatewayOver(rows: () => BatchedPr[], checkout: string, opts: { stripReverts?: boolean } = {}): GitHub {
  const reader = buildCommitTrailerIndex({ slug: "o/r", cwd: checkout });
  return buildBatchedGithub("o", "r", { fetchAll: rows, commitTrailerIndex: opts.stripReverts ? () => reader() : reader });
}

function project(t: TestContext, plan: Plan, github: GitHub, opts: { store?: CreditStore; previous?: StatusProjection; overridePath?: string } = {}): Map<string, StatusProjection> {
  const ledger = writeLedger([], { scope: t });
  let store = opts.store ?? {};
  return projectPlan(plan, {
    ledgerPath: ledger.path, github, skipUncreditedBuildWarning: true,
    readCreditStore: () => store, writeCreditStore: (s) => { store = s; },
    creditOverridePath: opts.overridePath ?? join(ledger.dir, "no-overrides.yaml"),
    ...(opts.previous ? { previousProjection: (id: string) => (id === opts.previous!.taskId ? opts.previous : undefined) } : {}),
  });
}

const storeWith101 = (): CreditStore => ({ "W1-T1": { trailer: { source: "trailer", prUrl: url(101), prNumber: 101, prState: "MERGED" } } });

test("W1-T14302 criterion 1: a revert on main takes back the credit from the durable store, the PR body, the commit trailer and a carried projection", (t) => {
  const h = mainHistory(t, [BUILD_101, revertsFirst(102)]);
  const plan = planOf(shardYaml("W1-T1"));
  const revertSha = h.shas[1]!;
  const expectReverted = (p: StatusProjection | undefined, label: string) => {
    assert.equal(p?.merged, false, label);
    assert.equal(p?.status, "queued", label);
    assert.deepEqual(p?.revertedCredit, { pr: 101, revertSha, revertPr: 102 }, label);
    // The walk itself skipped the pairing: no rung answered with PR 101, so the backstop was not needed.
    assert.equal(p?.prNumber, undefined, label);
  };
  // The durable credit store alone.
  expectReverted(project(t, plan, gatewayOver(() => [], h.dir), { store: storeWith101() }).get("W1-T1"), "durable store");
  // The PR body trailer.
  expectReverted(project(t, plan, gatewayOver(() => [mergedRow(101)], h.dir)).get("W1-T1"), "PR body trailer");
  // The commit trailer alone: the PR body carries no trailer.
  expectReverted(project(t, plan, gatewayOver(() => [mergedRow(101, "no trailer here")], h.dir)).get("W1-T1"), "commit trailer");
  // A carried previous projection: GitHub is dark, so the walk carries the last good answer.
  const carried = project(t, plan, gatewayOver(() => { throw new Error("gh exploded"); }, h.dir), {
    previous: { taskId: "W1-T1", source: "trailer", status: "merged", merged: true, prNumber: 101, prUrl: url(101), prState: "MERGED" },
  }).get("W1-T1");
  assert.equal(carried?.merged, false);
  assert.deepEqual(carried?.revertedCredit, { pr: 101, revertSha, revertPr: 102 });
  // Control: the same sources with no revert on main credit the task, as origin/main does today.
  const plain = mainHistory(t, [BUILD_101]);
  for (const [label, p] of [
    ["durable store", project(t, plan, gatewayOver(() => [], plain.dir), { store: storeWith101() }).get("W1-T1")],
    ["PR body trailer", project(t, plan, gatewayOver(() => [mergedRow(101)], plain.dir)).get("W1-T1")],
    ["commit trailer", project(t, plan, gatewayOver(() => [mergedRow(101, "no trailer here")], plain.dir)).get("W1-T1")],
  ] as const) {
    assert.equal(p?.merged, true, `control ${label}`);
    assert.equal(p?.prNumber, 101, `control ${label}`);
    assert.equal(p?.revertedCredit, undefined, `control ${label}`);
  }
});

test("W1-T14302 criterion 2: the exclusion is per pairing; a revert of the revert gives the credit back; twin reverts count once", (t) => {
  const plan = planOf(shardYaml("W1-T1"));
  // A later merged PR 140 with the same trailer credits the task again, from the store and from the trailer.
  const rebuilt = mainHistory(t, [BUILD_101, revertsFirst(102), { subject: "feat(x): rebuild W1-T1 (#140)", body: "Remudero-Task: W1-T1" }]);
  for (const p of [
    project(t, plan, gatewayOver(() => [mergedRow(140), mergedRow(101)], rebuilt.dir)).get("W1-T1"),
    project(t, plan, gatewayOver(() => [mergedRow(140), mergedRow(101)], rebuilt.dir), { store: storeWith101() }).get("W1-T1"),
  ]) {
    assert.equal(p?.merged, true);
    assert.equal(p?.prNumber, 140);
  }
  // A later commit that reverts the revert gives the credit back to PR 101.
  const restored = mainHistory(t, [BUILD_101, revertsFirst(102), revertsAt(1, 103)]);
  const back = project(t, plan, gatewayOver(() => [mergedRow(101)], restored.dir)).get("W1-T1");
  assert.equal(back?.merged, true);
  assert.equal(back?.prNumber, 101);
  assert.equal(back?.revertedCredit, undefined);
  // Two reverts of the same commit (the #20134 / #20136 twins) are one revert.
  const twins = mainHistory(t, [BUILD_101, revertsFirst(102), revertsFirst(103)]);
  const map = revertedMergesFromLog([
    { sha: "c".repeat(40), ...revertOf("a".repeat(40), 103), body: revertOf("a".repeat(40), 103).body! },
    { sha: "b".repeat(40), ...revertOf("a".repeat(12), 102), body: revertOf("a".repeat(12), 102).body! },
    { sha: "a".repeat(40), subject: BUILD_101.subject, body: BUILD_101.body!, taskId: "W1-T1" },
  ]);
  assert.equal(map.size, 1);
  assert.deepEqual(map.get(101), { revertSha: "b".repeat(40), revertPr: 102, revertPrs: [102, 103], laterTaskIds: [] });
  const twinProjection = project(t, plan, gatewayOver(() => [mergedRow(101)], twins.dir)).get("W1-T1");
  assert.equal(twinProjection?.merged, false);
  assert.equal(twinProjection?.revertedCredit?.revertSha, twins.shas[1]);
  // Reverting one twin counts as reverting the one revert: the credit comes back.
  const oneTwinUndone = mainHistory(t, [BUILD_101, revertsFirst(102), revertsFirst(103), revertsAt(2, 104)]);
  assert.equal(project(t, plan, gatewayOver(() => [mergedRow(101)], oneTwinUndone.dir)).get("W1-T1")?.merged, true);
});

test("W1-T14302 criterion 3: a restored revert keeps its credit (the W1-T11459 case: #17260, reverted by #17304, restored by W1-T11728 in #17408)", (t) => {
  const history = mainHistory(t, [
    { subject: "feat(review): S6 for W1-T11459 (#17260)", body: "Remudero-Task: W1-T11459" },
    (shas) => ({ subject: "Revert \"feat(review): S6 for W1-T11459 (#17260)\" (#17304)", body: `This reverts commit ${shas[0]!}.` }),
    { subject: "feat(review): restore S6 (#17408)", body: "Remudero-Task: W1-T11728" },
  ]);
  const row = mergedRow(17260, "Remudero-Task: W1-T11459", "run-W1-T11459-1790000000000");
  const restorer = (extra: string) => shardYaml("W1-T11728", extra);
  const restoredPlan = planOf(shardYaml("W1-T11459"),
    restorer("  plan_refs: [W1-T11459, W1-T11341]\n  origin: operator-approved S6 restoration after revert PR-17304, 2026-11-08\n"));
  const kept = project(t, restoredPlan, gatewayOver(() => [row], history.dir)).get("W1-T11459");
  assert.equal(kept?.merged, true);
  assert.equal(kept?.prNumber, 17260);
  assert.equal(kept?.revertedCredit, undefined);
  assert.equal(requeueRevertedShard("  status: merged\n", "W1-T11459", kept).skipped, "still-merged");
  // "#17304" counts as naming the revert too.
  const hashNamed = planOf(shardYaml("W1-T11459"), restorer("  plan_refs: [W1-T11459]\n  note: \"restores what #17304 reverted\"\n"));
  assert.equal(project(t, hashNamed, gatewayOver(() => [row], history.dir)).get("W1-T11459")?.merged, true);
  // Without plan_refs, or without naming the revert PR, the later task restores nothing.
  for (const extra of ["  origin: operator-approved S6 restoration after revert PR-17304\n", "  plan_refs: [W1-T11459]\n  origin: a restoration\n"]) {
    const p = project(t, planOf(shardYaml("W1-T11459"), restorer(extra)), gatewayOver(() => [row], history.dir)).get("W1-T11459");
    assert.equal(p?.merged, false, extra);
    assert.equal(p?.revertedCredit?.revertPr, 17304, extra);
  }
});

test("W1-T14302 criterion 4: invariant a-dark-revert-read-changes-nothing: a failed history read, a foreign origin or an unknown sha change no projection", (t) => {
  const plan = planOf(shardYaml("W1-T1"));
  const same = (dir: string, label: string, rows: () => BatchedPr[] = () => [mergedRow(101)]) => {
    const withReverts = project(t, plan, gatewayOver(rows, dir), { store: storeWith101() });
    const asOnMain = project(t, plan, gatewayOver(rows, dir, { stripReverts: true }), { store: storeWith101() });
    assert.deepEqual([...withReverts], [...asOnMain], label);
    assert.equal(withReverts.get("W1-T1")?.merged, true, label);
  };
  // The history read fails: the checkout has no origin/main.
  const unreadable = mainHistory(t, [BUILD_101, revertsFirst(102)]);
  execGit(unreadable.dir, ["update-ref", "-d", "refs/remotes/origin/main"]);
  assert.equal(buildCommitTrailerIndex({ slug: "o/r", cwd: unreadable.dir }).reverts?.(), null);
  same(unreadable.dir, "failed read");
  // The checkout's origin is another repository.
  const foreign = mainHistory(t, [BUILD_101, revertsFirst(102)], "https://github.com/other/repo.git");
  assert.equal(buildCommitTrailerIndex({ slug: "o/r", cwd: foreign.dir }).reverts?.()?.size, 0);
  same(foreign.dir, "foreign origin");
  // The revert line names a sha that is not on the read ref (a branch commit inside a squash merge).
  const unknown = mainHistory(t, [BUILD_101, { subject: "fix(x): squash (#102)", body: "* Revert\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567." }]);
  same(unknown.dir, "sha not on the ref");
});

const MERGED_SHARD = "- id: W1-T1\n  title: W1-T1 fixture\n  status: merged\n  attempts: 0\n";
const revertedProjection = (taskId = "W1-T1"): RevertedRequeue => ({ taskId, merged: false, revertedCredit: { pr: 101, revertSha: "a".repeat(40), revertPr: 102 } });

test("W1-T14302 criterion 5: requeueRevertedShard re-queues only a merged shard whose projection carries revertedCredit", () => {
  const out = requeueRevertedShard(MERGED_SHARD, "W1-T1", revertedProjection());
  assert.equal(out.text, MERGED_SHARD.replace("  status: merged\n", "  status: queued\n"));
  assert.equal(out.skipped, undefined);
  const declines: Array<[string, Parameters<typeof requeueRevertedShard>[2], string]> = [
    [MERGED_SHARD + "  retirement: superseded\n", revertedProjection(), "retired"],
    [MERGED_SHARD.replace("status: merged", "status: queued"), revertedProjection(), "status-not-merged"],
    [MERGED_SHARD, { merged: false }, "no-lost-credit"],
    [MERGED_SHARD, { ...revertedProjection(), indeterminate: true }, "credit-unreadable"],
    [MERGED_SHARD, undefined, "credit-unreadable"],
    [MERGED_SHARD, { ...revertedProjection(), merged: true }, "still-merged"],
    ["- id: W1-T1\n", revertedProjection(), "no-status-field"],
  ];
  for (const [text, projection, reason] of declines) {
    const declined = requeueRevertedShard(text, "W1-T1", projection);
    assert.equal(declined.text, undefined, reason);
    assert.equal(declined.skipped, reason);
  }
  // reconcileShardStatus is still one-way: it never moves merged to queued.
  assert.equal(reconcileShardStatus(MERGED_SHARD, "W1-T1", () => false).text, undefined);
  assert.equal(reconcileShardStatus(MERGED_SHARD, "W1-T1", () => false).skipped, "status-not-queued");
});

// ── the landing (W1-T13816's real bare origin, gh answered by a shim) ─────────────────────────

const TARGET = { owner: "o", repo: "r" };
const OWNER = "w1-t14302-fixture";
const BRANCH = landingIdentity({ family: "plan-reconcile", targetRepository: TARGET, landingOwner: OWNER }).branch;
const FIXTURE_PR = "https://github.com/o/r/pull/14302";
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const shardText = (id: string, status: string, extra = ""): string => `- id: ${id}\n  title: ${id} fixture\n  status: ${status}\n${extra}`;

function landingWorld(t: TestContext) {
  const origin = gitRepo({ bare: true, scope: t, kind: "t14302-origin" });
  const seed = gitRepo({ scope: t, kind: "t14302-seed" });
  seed.addRemote("origin", origin.dir);
  const commit = (repo: GitRepo, files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
      writeFileSync(join(repo.dir, path), content);
    }
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "-m", message);
  };
  return {
    main(files: Record<string, string>, message: string) {
      commit(seed, files, message);
      seed.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
    },
    pending(files: Record<string, string>) {
      const repo = gitRepo({ cloneFrom: origin.dir, scope: t, kind: "t14302-pending" });
      commit(repo, files, "earlier reconcile");
      repo.git("push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`);
    },
    laggingCopy: () => gitRepo({ cloneFrom: origin.dir, scope: t, kind: "t14302-checkout" }).dir,
    // The fixture's git() trims stdout, so the trailing newline is put back.
    blob: (ref: string, path: string) => `${origin.git("cat-file", "-p", `${ref}:${path}`)}\n`,
  };
}

/** Production composition: the cadence input over the checkout's shards, landed through the real landing. */
async function reconcile(checkout: string, ids: string[], credited: CreditedMergedIds, rows: Array<{ step: string; fields: Record<string, unknown> }>) {
  const results: LandFeedbackResult[] = [];
  const inputs: LandContentInput[][] = [];
  const lander: PlanReconcileLand = (root, batch, landOpts) => {
    inputs.push([...batch]);
    return landPlanReconcileShardsAsync(root, batch, landOpts).then((r) => (results.push(r), r));
  };
  const landing = planReconcileLanding(checkout, () => ({
    targetRepository: TARGET, landingOwner: OWNER, planPrPreflight: async () => ({ ok: true, failures: [], unreadable: [] }),
  }), lander);
  const cadence = buildPlanReconcileCadenceInput({
    checkoutRoot: checkout,
    readShards: () => ids.map((id) => ({ taskId: id, path: join(checkout, pathOf(id)), text: readFileSync(join(checkout, pathOf(id)), "utf8") })),
    creditedMergedIds: () => credited,
    lint: () => new Map(),
    log: (step, fields = {}) => rows.push({ step, fields }),
    land: landing.land,
  });
  let calls: string[] = [];
  const report = await withGhShim([{ when: "pr list", stdout: "[]" }, { when: "pr create", stdout: FIXTURE_PR }], (shim) =>
    withLiveWritesAllowed(async () => {
      const r = planReconcileCadence(cadence);
      await landing.settled();
      calls = shim.calls();
      return r;
    }));
  return { report, results, inputs, calls };
}

const withRequeue = (ids: string[], requeue: RevertedRequeue[]): CreditedMergedIds => Object.assign(new Set(ids), { requeue });

test("W1-T14302 criterion 6: the re-queue lands in the bounded plan-reconcile landing, on main's current text, and is carried forward", async (t) => {
  const w = landingWorld(t);
  const one = pathOf("W1-T1"), two = pathOf("W1-T2");
  w.main({ [one]: shardText("W1-T1", "merged"), [two]: shardText("W1-T2", "merged") }, "base");
  const checkout = w.laggingCopy();
  const amended = shardText("W1-T1", "merged", "  note: main amended this shard after the read\n");
  w.main({ [one]: amended }, "main amends W1-T1 after the read");
  // An earlier landing's re-queue of W1-T2, exactly the re-queue edit of main's text, is still pending.
  w.pending({ [two]: requeueShardStatusText(shardText("W1-T2", "merged"))! });

  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const { report, results, inputs, calls } = await reconcile(checkout, ["W1-T1"], withRequeue([], [revertedProjection()]), rows);

  assert.equal(results[0]?.landed, true, results[0]?.error);
  assert.equal(results[0]?.prUrl, FIXTURE_PR);
  assert.deepEqual(report.requeued, ["W1-T1"]);
  assert.equal(report.status, "landed", "a re-queue lands below the drift threshold");
  assert.equal(inputs[0]?.[0]?.relPath, one);
  assert.equal(w.blob(BRANCH, one), amended.replace("  status: merged\n", "  status: queued\n"), "the edit is of main's current text");
  assert.equal(w.blob(BRANCH, two), requeueShardStatusText(shardText("W1-T2", "merged")), "the earlier re-queue is carried forward");
  assert.ok(calls.join("\n").includes(`grep: ^  status: queued$ in ${one}`), "the PR body proof names the queued line");

  // The next pass reads the queued shard; the projection still reads it unmerged, so nothing flips it back.
  const next = planReconcileCadence(buildPlanReconcileCadenceInput({
    checkoutRoot: checkout,
    readShards: () => [{ taskId: "W1-T1", path: join(checkout, one), text: w.blob(BRANCH, one) }],
    creditedMergedIds: () => withRequeue([], [revertedProjection()]),
    land: () => assert.fail("nothing to land"),
  }));
  assert.equal(next.drift, 0);
  assert.equal(next.requeued, undefined);
  assert.equal(next.status, "clear");
});

test("W1-T14302 criterion 7: each re-queue writes one declared plan.reconcile.reverted_requeue row", () => {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const root = "/checkout";
  const landed: string[][] = [];
  const cadence = buildPlanReconcileCadenceInput({
    checkoutRoot: root,
    readShards: () => [{ taskId: "W1-T1", path: join(root, pathOf("W1-T1")), text: MERGED_SHARD }],
    creditedMergedIds: () => withRequeue([], [revertedProjection()]),
    lint: () => new Map(),
    log: (step, fields = {}) => rows.push({ step, fields }),
    land: (inputs) => { landed.push(inputs.map((i) => i.relPath)); },
  });
  planReconcileCadence(cadence);
  assert.deepEqual(landed, [[pathOf("W1-T1")]]);
  assert.deepEqual(rows, [{ step: "plan.reconcile.reverted_requeue", fields: { task: "W1-T1", file: pathOf("W1-T1"), cause: "revert", pr: 101, revert_sha: "a".repeat(40) } }]);
  const declared = LEDGER_STEPS.find((row) => row.step === "plan.reconcile.reverted_requeue");
  assert.ok(declared, "the step is in LEDGER_STEPS");
  assert.deepEqual([...declared.outcomes].sort(), ["override", "revert"]);
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "write-only-ledger-step-baseline.json"), "utf8")) as { recordOnly: Record<string, string> };
  assert.ok((baseline.recordOnly["plan.reconcile.reverted_requeue"] ?? "").trim().length > 0, "recordOnly gives a reason");
});

const OVERRIDE_101 = "- task: W1-T1\n  pr: 101\n  action: remove-credit\n  reason: the build was reverted\n  author_class: operator\n";

test("W1-T14302 criterion 8: an operator remove-credit row re-queues too, with cause override", (t) => {
  const plain = mainHistory(t, [BUILD_101]);
  const plan = planOf(shardYaml("W1-T1"));
  const dir = ownedFixtureDir(t, "t14302-overrides").dir;
  const overrides = join(dir, "credit-overrides.yaml");
  writeFileSync(overrides, OVERRIDE_101);
  const projected = project(t, plan, gatewayOver(() => [mergedRow(101)], plain.dir), { overridePath: overrides });
  const requeue = revertedRequeues([...projected.values()]);
  assert.deepEqual(requeue, [{ taskId: "W1-T1", merged: false, creditOverride: { reason: "the build was reverted", pr: 101 } }]);
  assert.equal(requeueRevertedShard(MERGED_SHARD, "W1-T1", requeue[0]).text, MERGED_SHARD.replace("status: merged", "status: queued"));

  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  planReconcileCadence(buildPlanReconcileCadenceInput({
    checkoutRoot: "/checkout",
    readShards: () => [{ taskId: "W1-T1", path: join("/checkout", pathOf("W1-T1")), text: MERGED_SHARD }],
    creditedMergedIds: () => withRequeue([], requeue),
    lint: () => new Map(),
    log: (step, fields = {}) => rows.push({ step, fields }),
    land: () => {},
  }));
  assert.deepEqual(rows, [{ step: "plan.reconcile.reverted_requeue", fields: { task: "W1-T1", file: pathOf("W1-T1"), cause: "override", pr: 101 } }]);

  // A missing or unreadable record, a row for a task another PR still credits, and no lost credit re-queue nothing.
  for (const path of [join(dir, "missing.yaml"), dir]) {
    assert.deepEqual(revertedRequeues([...project(t, plan, gatewayOver(() => [mergedRow(101)], plain.dir), { overridePath: path }).values()]), [], path);
  }
  const stillCredited = project(t, plan, gatewayOver(() => [mergedRow(140), mergedRow(101)], plain.dir), { overridePath: overrides });
  assert.equal(stillCredited.get("W1-T1")?.merged, true);
  assert.deepEqual(revertedRequeues([...stillCredited.values()]), []);
  assert.deepEqual(revertedRequeues([{ taskId: "W1-T9", merged: false }]), []);
  assert.equal(requeueRevertedShard(MERGED_SHARD, "W1-T1", { merged: false }).skipped, "no-lost-credit");
});

// ── the fleet layout: config.root holds state/ and no plan/; the target checkout holds the plan ──

function fleetLayout(t: TestContext, withOverride: boolean) {
  const configRoot = ownedFixtureDir(t, "t14302-config-root").dir;
  const ledger = writeLedger([], { scope: t, dir: join(configRoot, "state") });
  const checkoutRoot = ownedFixtureDir(t, "t14302-target").dir;
  mkdirSync(join(checkoutRoot, "plan"), { recursive: true });
  if (withOverride) writeFileSync(join(checkoutRoot, "plan", "credit-overrides.yaml"), OVERRIDE_101);
  return { configRoot, ledgerPath: ledger.path, checkoutRoot };
}

function tickRead(layout: ReturnType<typeof fleetLayout>) {
  let pacedAt = 0;
  const pace = (ms: number) => { pacedAt += ms; };
  const closed = { number: 101, html_url: url(101), state: "closed", merged_at: new Date().toISOString(), title: "feat(x): build W1-T1 (#101)",
    body: "Remudero-Task: W1-T1", head: { ref: RUN_HEAD, sha: "sha101" }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), draft: false };
  return createTickReadProducer({ owner: "o", repo: "r", config: { root: layout.configRoot, claudeBin: process.execPath } as never, ledgerPath: layout.ledgerPath, checkoutRoot: layout.checkoutRoot }, {
    fetch: (args) => {
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path.includes("/pulls?") && path.includes("state=open")) return [];
      if (path.includes("/pulls?") && path.includes("state=closed")) return [closed];
      if (path.includes("/issues?")) return [];
      if (path.includes("/files")) return [{ filename: "src/W1-T1.ts" }];
      if (path.includes("/actions/runs")) return { workflow_runs: [] };
      if (/\/pulls\/\d+$/.test(path)) return closed;
      throw new Error(`unexpected read ${args.join(" ")}`);
    },
    changedFilesFetch: async () => ["src/W1-T1.ts"],
    commitTrailerIndex: () => new Map(), evidenceRootFor: () => undefined,
    issues: { create: () => { throw new Error("write in read plane"); }, listOpen: () => [] },
    viewsDeps: { requiredContexts: () => ["ci-gate"], readRequiredContextsAsync: async () => ({ kind: "contexts", contexts: ["ci-gate"] }), readCiGateRequired: () => [], fetchCiFailureEvidence: () => [] },
    pacer: createGhCallPacer({ now: () => pacedAt, sleep: async (ms) => pace(ms), sleepSync: pace }),
  });
}

test("W1-T14302 criterion 9: invariant an-override-reaches-the-fleet-projection: the tick read producer reads the target checkout's override rows", async (t) => {
  const plan = planOf(shardYaml("W1-T1"));
  assert.equal(planCreditOverridePath("/target"), "/target/plan/credit-overrides.yaml");
  const overridden = fleetLayout(t, true);
  const facts = await tickRead(overridden)({ plan });
  const p = new Map(facts.projection).get("W1-T1");
  assert.equal(p?.merged, false);
  assert.deepEqual(p?.creditOverride, { reason: "the build was reverted", pr: 101 });
  assert.equal(facts.creditCandidates.some((c) => c.taskId === "W1-T1"), false, "the credit read sees the row too");
  // Control: the same fleet layout without the row credits the task.
  const plain = await tickRead(fleetLayout(t, false))({ plan });
  assert.equal(new Map(plain.projection).get("W1-T1")?.merged, true);
});

/** An in-memory claim table whose drops honour the lease the way git does. */
function heldClaims(ids: string[]) {
  const refs = new Map(ids.map((id) => [id, { sha: "a".repeat(40) }]));
  const reserver: DispatchClaimReserverAsync & { listHeld: () => DispatchClaimListing } = {
    mintAnchor: () => "anchor",
    attempt: () => "taken",
    holder: (taskId) => refs.get(taskId)?.sha,
    drop: (taskId, opts) => {
      const cur = refs.get(taskId);
      if (!cur || (opts?.expect !== undefined && opts.expect !== cur.sha)) return false;
      refs.delete(taskId);
      return true;
    },
    list: () => [...refs.keys()],
    listHeld: () => ({ ok: true, claims: [...refs].map(([taskId, c]) => ({ taskId, holder: c.sha })) }),
  };
  return { reserver, refs };
}

test("W1-T14302 criterion 10: the tick claim sweep keeps a claim whose standing credit is gone, reading only the projection", async (t) => {
  // The shard text still reads merged; the sweep never reads it.
  const plan = planOf(shardYaml("W1-T1").replace("status: queued", "status: merged"));
  const reverted = mainHistory(t, [BUILD_101, revertsFirst(102)]);
  const plain = mainHistory(t, [BUILD_101]);
  const dir = ownedFixtureDir(t, "t14302-claim-overrides").dir;
  writeFileSync(join(dir, "credit-overrides.yaml"), OVERRIDE_101);
  const sweep = async (projection: Map<string, StatusProjection>) => {
    const { reserver, refs } = heldClaims(["W1-T1"]);
    const rows: string[] = [];
    await releaseLandedDispatchClaims(reserver, {
      isMerged: (id) => projection.get(id)?.merged ?? false,
      isIndeterminate: (id) => projection.get(id)?.indeterminate === true,
      log: (step) => rows.push(step),
    });
    return { held: refs.has("W1-T1"), rows };
  };
  for (const [label, projection] of [
    ["reverted on main", project(t, plan, gatewayOver(() => [mergedRow(101)], reverted.dir))],
    ["override row", project(t, plan, gatewayOver(() => [mergedRow(101)], plain.dir), { overridePath: join(dir, "credit-overrides.yaml") })],
  ] as const) {
    const out = await sweep(projection);
    assert.equal(out.held, true, `${label}: ${dispatchClaimRef("W1-T1")} stays held`);
    assert.deepEqual(out.rows, [], `${label}: no dispatch.claim_released row`);
  }
  const released = await sweep(project(t, plan, gatewayOver(() => [mergedRow(101)], plain.dir)));
  assert.equal(released.held, false, "with neither, the claim is released as today");
  assert.deepEqual(released.rows, ["dispatch.claim_released"]);
});

test("W1-T14302 criterion 11: the leftover close honours a removed credit in the sweep's own credit read", async (t) => {
  // config.root holds no plan/; the target checkout config.root/repos/r is the evidence root and holds the plan.
  const configRoot = ownedFixtureDir(t, "t14302-sweep-root").dir;
  const target = join(configRoot, "repos", "r");
  const checkout = gitRepo({ scope: t, seedCommit: false, kind: "t14302-sweep-target" });
  checkout.addRemote("origin", ORIGIN);
  mkdirSync(join(checkout.dir, "src"), { recursive: true });
  writeFileSync(join(checkout.dir, "src", "W1-T1.ts"), "export const built = true;\n");
  checkout.git("add", "-A");
  checkout.git("commit", "--quiet", "-m", BUILD_101.subject, "-m", BUILD_101.body!);
  checkout.git("update-ref", "refs/remotes/origin/main", "HEAD");
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(checkout.dir, target);
  const ledger = writeLedger([], { scope: t, dir: join(configRoot, "state") });
  const plan = planOf(shardYaml("W1-T1"));
  const openPr = { prNumber: 150, prUrl: url(150), taskId: "W1-T1", reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    strikeHistory: [], lastActivityAt: new Date().toISOString(), createdAt: new Date().toISOString(), headSha: "beef", autoMergeArmed: false, isDependabot: false } as unknown as OpenPrView;
  const home = ownedFixtureDir(t, "t14302-home").dir;
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root: configRoot, claudeBin: process.execPath }));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const stamp = () => {
      const github = buildBatchedGithub("o", "r", { fetchAll: () => [mergedRow(101)], commitTrailerIndex: () => new Map() });
      const candidates = sweepCreditCandidates(target, "o", "r", plan, ledger.path, () => {}, github);
      return { candidates, pr: projectMergedTaskCandidates([openPr], candidates)[0]! };
    };
    const control = stamp();
    assert.equal(control.pr.taskMergedBy, 101, "without the row the open PR is stamped as a leftover, as today");
    mkdirSync(join(target, "plan"), { recursive: true });
    writeFileSync(join(target, "plan", "credit-overrides.yaml"), OVERRIDE_101);
    const removed = stamp();
    assert.equal(removed.candidates.some((c) => c.taskId === "W1-T1" && c.merged === true), false);
    assert.equal(removed.pr.taskMergedBy, undefined, "the removed credit closes nothing");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
