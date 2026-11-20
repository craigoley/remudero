/**
 * W1-T13944 — ONE HELD FOLLOW-UP PER TASK AND CRITERION.
 *
 * Between 07:46 and 11:17 UTC on 2026-11-20 the sweep filed eleven identical held follow-ups of W1-T13865 for one
 * criterion of one pull request at one head, and a twelfth waited in an open landing pull request. Each split staged
 * its held task file, the plan preflight refused the edit of the parent task file, and the remedy wrote a refused row
 * with no held_task_id. The checks that should have stopped the next split read only ledger rows, which were refused,
 * late, or dropped by compaction. The remedy now looks at the plan and the landing queue, and holds a claim file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { Config } from "#src/lib/config.js";
import { taskFilesLandingBranchAsync, type TaskFileInput } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { heldFollowUpsOfTaskText, PARKED_PR_REMEDY_STEP, takeParkedPrRemedy, type HeldFollowUp, type ParkedPrContext,
  type ParkedPrDecision, type ParkedPrHost, type ParkedPrSubject } from "#src/lib/parked-pr-remedy.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { buildSweepEffects } from "#src/lib/sweep.js";
import { formatReservationAnchorMessage, taskIdReservationRef } from "#src/lib/task-id-reservation.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { buildFixturePlanPrBody } from "#test/helpers/plan-pr-body-fixture.js";

type Row = Record<string, unknown>;

const OWNER = "fixture", REPO = "remudero";
const TASK = "W1-T913944", OTHER = "W1-T913945";
const CLAIMS = ["the first criterion holds", "the second criterion needs a design answer", "the third criterion holds too"];
const shardRel = (id: string) => `plan/tasks.d/${id}-fixture.yaml`;
const shardOf = (id: string) => [`- id: ${id}`, `  title: Fixture task ${id}`, "  repo: remudero", "  depends_on: []", "  type: implement",
  "  risk: high", "  verify: auto", "  status: queued", "  attempts: 0", "  acceptance:",
  ...CLAIMS.flatMap(c => [`    - claim: "${c}"`, `      proof: "grep: ${c} in src/x.ts"`]), "  rationale: |", "    WHY: a fixture.", ""].join("\n");
const heldText = (id: string, parent: string, claims: readonly string[]) => [`- id: ${id}`,
  `  title: "Fixture task ${parent} (held follow-up)"`, "  repo: remudero", "  depends_on:", `    - ${parent}`, "  type: implement",
  "  status: queued", "  attempts: 0", "  acceptance:", ...claims.flatMap(c => [`    - claim: "${c}"`, `      proof: "grep: ${c} in src/x.ts"`]),
  "  rationale: |", `    FOLLOW-UP of ${parent}.`, ""].join("\n");

const subject = (taskId = TASK, prNumber = 19767): ParkedPrSubject => ({ prNumber, prUrl: `https://github.com/${OWNER}/${REPO}/pull/${prNumber}`,
  headSha: "004f62a8fa".padEnd(40, "0"), taskId, unmetCriteria: [{ claim: CLAIMS[1]!, reason: "it needs a design answer" }] });
const split = (claims: readonly string[] = [CLAIMS[1]!]): ParkedPrDecision => ({ remedy: "split-follow-up",
  reason: "one criterion needs operator input", inputCriteria: claims.map(claim => ({ claim, needsInput: true, ladderSpent: true })) });
const context = (rows: Row[]): ParkedPrContext => ({ runId: "t13944", ledgerTaskId: TASK, nowIso: "2026-11-20T08:00:00.000Z",
  cause: "needs-design", text: "which store?", append: row => { rows.push(row); } });
const remedyRows = (rows: readonly Row[]) => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP);

function tempRoot(t: TestContext, kind: string): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  return root;
}

/** A remedy host over a temp claim root whose landing queue is `queue`; it counts reservations and landings. */
function fakeHost(root: string, queue: HeldFollowUp[], opts: { land?: (files: readonly TaskFileInput[]) => Promise<void> } = {}) {
  const reserved: string[] = [];
  const landed: TaskFileInput[][] = [];
  let next = 13919;
  const h: ParkedPrHost = {
    heldFollowUpClaimRoot: root,
    readHeldFollowUps: async () => [...queue],
    readTaskShard: async id => [TASK, OTHER].includes(id)
      ? { outcome: "read", shard: { relPath: shardRel(id), text: shardOf(id) }, target: { owner: OWNER, repo: REPO, checkoutDir: "/unused" } }
      : { outcome: "refused", reason: "task-absent" },
    reserveTaskId: async () => {
      await new Promise(resolve => setImmediate(resolve));
      const id = `W1-T${next++}`;
      reserved.push(id);
      return id;
    },
    landTaskFiles: async files => {
      landed.push([...files]);
      await opts.land?.(files);
      queue.push(...heldFollowUpsOfTaskText(files[0]!.content));
      return { prUrl: `https://github.com/${OWNER}/${REPO}/pull/19839`, staged: files.map(f => f.relPath) };
    },
    closePr: async () => { throw new Error("a split closes no pull request"); },
  };
  return { h, reserved, landed };
}

const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const PARENT_RED: PlanPrPreflightResult = { ok: false, failures: [{ check: "lint-plan", firstLine: "design-invariant-proof" }], unreadable: [] };
let minted = 0;

/**
 * The sweep's own parked pull request host over a real git origin and the real task-files landing. `planExtra` is a
 * task file that origin/main's plan holds beside the parent task. The plan preflight refuses the parent edit when
 * `refuseParentEdit` is set.
 */
async function world(t: TestContext, opts: { planExtra?: string; refuseParentEdit?: boolean } = {}) {
  const landingBranch = await taskFilesLandingBranchAsync({ owner: OWNER, repo: REPO });
  const root = tempRoot(t, "one-held-follow-up");
  const origin = gitRepo({ scope: t, bare: true, kind: "one-held-origin" });
  const seed = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "one-held-seed" });
  for (const [path, text] of [["plan/tasks.yaml", "[]\n"], [shardRel(TASK), shardOf(TASK)]] as const) {
    mkdirSync(join(seed.dir, path, ".."), { recursive: true });
    writeFileSync(join(seed.dir, path), text);
  }
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed fixture");
  seed.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const repo = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "one-held-checkout" });
  const env = { ...process.env, GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email };
  const reserved: string[] = [], landed: TaskFileInput[][] = [];
  const planOf = () => mergePlanBlobs([{ label: "fixture.yaml", text: shardOf(TASK) },
    ...(opts.planExtra === undefined ? [] : [{ label: "held.yaml", text: opts.planExtra }])]);
  const effects = buildSweepEffects({
    owner: OWNER, repo: REPO, repoRoot: repo.dir, config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"), runId: "fixture-sweep", log: () => {},
    plan: planOf(), reloadPlanForFixImpl: planOf,
    readJsonImpl: async args => { throw new Error(`the remedy reads no API: ${args.join(" ")}`); },
    planRepairGitImpl: (_file, args) => execFileSync("git", [...args], { encoding: "utf8", stdio: "pipe", env }),
    ghJsonImpl: args => {
      assert.equal(args[0], "pr", `the landing makes no other GitHub call: ${args.join(" ")}`);
      return args[1] === "create" ? `https://github.com/${OWNER}/${REPO}/pull/19839` : [];
    },
    planRepairReserveIdImpl: () => {
      const id = `W1-T91${3000 + minted++}`;
      const tree = origin.git("rev-parse", "main^{tree}");
      const sha = origin.git("commit-tree", tree, "-m", formatReservationAnchorMessage({ branch: landingBranch, startedAt: "2026-11-20T00:00:00Z" }));
      origin.git("update-ref", taskIdReservationRef(id), sha);
      reserved.push(id);
      return id;
    },
    buildPlanPrBodyImpl: buildFixturePlanPrBody,
    planPrPreflightImpl: (_dir, _sha, pr) => opts.refuseParentEdit === true && pr.body.includes("no longer carries the criteria moved to")
      ? PARENT_RED : GREEN,
  });
  assert.ok(effects.parkedPr, "the production sweep effects wire the remedy");
  const production = effects.parkedPr;
  const host: ParkedPrHost = {
    ...production,
    landTaskFiles: (files, target) => { landed.push([...files]); return production.landTaskFiles(files, target); },
    closePr: async () => { throw new Error("a split closes no pull request"); },
  };
  const act = (rows: Row[], ledger: readonly Row[] = []) =>
    withLiveWritesAllowed(() => takeParkedPrRemedy(subject(), split(), ledger, host, context(rows)));
  /** Puts a held follow-up into the landing queue, as a staged file and its record. */
  const stage = (id: string, prUrl?: string) => {
    const rel = `plan/tasks.d/${id}-fixture-task-held-follow-up.yaml`;
    const abs = join(root, "state", "task-files-landing-pending", rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, heldText(id, TASK, [CLAIMS[1]!]));
    writeFileSync(`${abs}.meta.json`, `${JSON.stringify({ baseBlob: null, claim: "filed", proof: `grep: id: ${id} in ${rel}`,
      repository: `${OWNER}/${REPO}`, ...(prUrl === undefined ? {} : { prUrl }) })}\n`);
  };
  return { act, reserved, landed, stage, host };
}

test("W1-T13944 criterion 1: a held follow-up on origin/main for the task and criterion is reused: no id, no file, one taken row", async t => {
  const w = await world(t, { planExtra: heldText("W1-T13921", TASK, [CLAIMS[1]!]) + heldText("W1-T13919", TASK, [CLAIMS[1]!]) });
  const rows: Row[] = [];
  const out = await w.act(rows, []);
  assert.equal(out.error, undefined, out.reason);
  assert.equal(out.heldTaskId, "W1-T13919", "the lowest matching held follow-up is reused");
  assert.equal(w.reserved.length, 0, "no id is reserved");
  assert.equal(w.landed.length, 0, "no task file lands");
  const written = remedyRows(rows);
  assert.equal(written.length, 1);
  assert.deepEqual([written[0]!.outcome, written[0]!.held_task_id, written[0]!.reused], ["taken", "W1-T13919", true]);
});

test("W1-T13944 criterion 2: a held follow-up that waits in the task-files landing queue, staged or in an open landing PR, is reused", async t => {
  for (const prUrl of [undefined, `https://github.com/${OWNER}/${REPO}/pull/19862`]) {
    const w = await world(t);
    w.stage("W1-T13938", prUrl);
    const rows: Row[] = [];
    const out = await w.act(rows, []);
    assert.equal(out.error, undefined, out.reason);
    assert.equal(out.heldTaskId, "W1-T13938");
    assert.equal(w.reserved.length, 0, `no id is reserved (${prUrl ?? "staged"})`);
    assert.equal(w.landed.length, 0, `no task file lands (${prUrl ?? "staged"})`);
    assert.deepEqual(remedyRows(rows).map(r => [r.outcome, r.held_task_id, r.reused]), [["taken", "W1-T13938", true]]);
  }
});

test("W1-T13944 criterion 3: invariant:one-held-follow-up-per-criterion, two calls started together reserve one id and land only it", async t => {
  const root = tempRoot(t, "one-held-concurrent");
  const f = fakeHost(root, []);
  const rows: Row[] = [];
  await Promise.all([takeParkedPrRemedy(subject(), split(), [], f.h, context(rows)),
    takeParkedPrRemedy(subject(), split(), [], f.h, context(rows))]);
  assert.equal(f.reserved.length, 1, `exactly one id is reserved: ${f.reserved.join(", ")}`);
  const id = f.reserved[0]!;
  assert.equal(f.landed.length, 1, "one landing carries the held follow-up");
  for (const file of f.landed.flat()) assert.ok(file.content.includes(id), `${file.relPath} names ${id}`);
  assert.ok(f.landed.flat().filter(file => file.newFile).every(file => file.relPath.includes(id)), "every held file names the one id");
  assert.deepEqual(remedyRows(rows).filter(r => r.outcome === "taken").map(r => r.held_task_id), [id]);
});

test("W1-T13944 criterion 4: after a restart, a claim with a reserved id is landed again with the same id and bytes, and no id is reserved", async t => {
  const root = tempRoot(t, "one-held-restart");
  const first = fakeHost(root, [], { land: async () => { throw new Error("the daemon stopped before the file staged"); } });
  const out1 = await takeParkedPrRemedy(subject(), split(), [], first.h, context([]));
  assert.match(String(out1.error), /the daemon stopped/);
  assert.equal(first.reserved.length, 1);
  const second = fakeHost(root, []);
  const rows: Row[] = [];
  const out2 = await takeParkedPrRemedy(subject(), split(), [], second.h, context(rows));
  assert.equal(out2.error, undefined, out2.reason);
  assert.equal(second.reserved.length, 0, "the restarted pass reserves no id");
  assert.equal(out2.heldTaskId, first.reserved[0]);
  assert.deepEqual(second.landed, first.landed, "the same paths and bytes land again");
  assert.deepEqual(remedyRows(rows).map(r => [r.outcome, r.held_task_id]), [["taken", first.reserved[0]]]);
});

test("W1-T13944 criterion 5: a split whose held file stages and whose parent edit is refused names held_task_id, and the next call reserves none", async t => {
  const w = await world(t, { refuseParentEdit: true });
  const rows: Row[] = [];
  const out = await w.act(rows, []);
  assert.equal(out.error, undefined, out.reason);
  assert.equal(w.reserved.length, 1);
  const first = remedyRows(rows);
  assert.equal(first.length, 1);
  assert.deepEqual([first[0]!.outcome, first[0]!.held_task_id], ["taken", w.reserved[0]]);
  assert.match(String(first[0]!.partial_refusal), /design-invariant-proof/);
  const next: Row[] = [];
  const again = await w.act(next, rows.filter(r => r.step !== PARKED_PR_REMEDY_STEP));
  assert.equal(again.error, undefined, again.reason);
  assert.equal(w.reserved.length, 1, "the next call reserves no id");
  assert.equal(again.heldTaskId, w.reserved[0]);
  assert.deepEqual(remedyRows(next).map(r => [r.outcome, r.held_task_id]), [["taken", w.reserved[0]]]);
});

test("W1-T13944 criterion 6: a different criterion of the same task, and the same criterion of another task, each file their own", async t => {
  const root = tempRoot(t, "one-held-other");
  const queue = heldFollowUpsOfTaskText(heldText("W1-T13919", TASK, [CLAIMS[1]!]));
  const f = fakeHost(root, queue);
  const rows: Row[] = [];
  const otherCriterion = await takeParkedPrRemedy(subject(), split([CLAIMS[2]!]), [], f.h, context(rows));
  const otherTask = await takeParkedPrRemedy(subject(OTHER, 19768), split(), [], f.h, context(rows));
  assert.equal(otherCriterion.error, undefined, otherCriterion.reason);
  assert.equal(otherTask.error, undefined, otherTask.reason);
  assert.equal(f.reserved.length, 2, "each files its own held follow-up");
  assert.deepEqual([otherCriterion.heldTaskId, otherTask.heldTaskId], f.reserved);
  assert.ok(remedyRows(rows).every(r => r.outcome === "taken" && r.reused === undefined));
});
