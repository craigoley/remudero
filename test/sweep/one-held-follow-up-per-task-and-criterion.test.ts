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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

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
    reserveTaskId: async (_target, beforePush) => {
      await new Promise(resolve => setImmediate(resolve));
      const id = `W1-T${next++}`;
      beforePush?.(id, "a".repeat(40));
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
 * task file that the daemon's plan and the working tree hold beside the parent task; `mainExtra` is one only origin/main
 * holds (the working tree and the daemon's plan lag it). The plan preflight refuses the parent edit when
 * `refuseParentEdit` is set; `listFails` makes the landing's pull request listing fail; `realReservation` reserves ids
 * through the production reservation on the origin.
 */
async function world(t: TestContext, opts: { planExtra?: string; mainExtra?: { id: string; text: string }; refuseParentEdit?: boolean;
  listFails?: boolean; realReservation?: boolean } = {}) {
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
  if (opts.mainExtra !== undefined) {
    const rel = `plan/tasks.d/${opts.mainExtra.id}-fixture-task-held-follow-up.yaml`;
    writeFileSync(join(seed.dir, rel), opts.mainExtra.text);
    seed.git("add", "-A");
    seed.git("commit", "--quiet", "-m", `chore(plan): file ${opts.mainExtra.id}`);
    seed.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
    repo.git("fetch", "--quiet", "origin");
  }
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
      if (opts.listFails === true && args[1] === "list") throw new Error("gh: the open pull requests cannot be listed (HTTP 502)");
      return args[1] === "create" ? `https://github.com/${OWNER}/${REPO}/pull/19839` : [];
    },
    ...(opts.realReservation === true ? {} : { planRepairReserveIdImpl: () => {
      const id = `W1-T91${3000 + minted++}`;
      const tree = origin.git("rev-parse", "main^{tree}");
      const sha = origin.git("commit-tree", tree, "-m", formatReservationAnchorMessage({ branch: landingBranch, startedAt: "2026-11-20T00:00:00Z" }));
      origin.git("update-ref", taskIdReservationRef(id), sha);
      reserved.push(id);
      return id;
    } }),
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
  return { act, reserved, landed, stage, host, production, origin, checkoutDir: repo.dir };
}

/** The remedy module loaded again, as a restarted daemon loads it: a new claim token, so the old holder is gone. */
async function restartedRemedy(): Promise<typeof import("#src/lib/parked-pr-remedy.js")> {
  const url = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "lib", "parked-pr-remedy.ts"));
  url.search = `?restart=${Date.now()}`;
  return import(url.href) as Promise<typeof import("#src/lib/parked-pr-remedy.js")>;
}

/** The new held task files whose acceptance carries `claim`. */
const carries = (files: readonly TaskFileInput[], claim: string) =>
  files.filter(f => f.newFile === true && heldFollowUpsOfTaskText(f.content).some(h => h.claims.includes(claim)));

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
  // With origin/main unreadable (no git checkout), the daemon's plan and the working tree still answer.
  const elsewhere = await w.host.readHeldFollowUps!({ owner: OWNER, repo: REPO, checkoutDir: tempRoot(t, "one-held-no-checkout") });
  assert.deepEqual([...new Set(elsewhere.map(h => h.id))].sort(), ["W1-T13919", "W1-T13921"]);
});

test("W1-T13944 criterion 1: a held follow-up only origin/main holds, behind a stale working tree and daemon plan, is reused", async t => {
  const w = await world(t, { mainExtra: { id: "W1-T13919", text: heldText("W1-T13919", TASK, [CLAIMS[1]!]) } });
  const read = await w.host.readHeldFollowUps!({ owner: OWNER, repo: REPO, checkoutDir: w.checkoutDir });
  assert.deepEqual(read.map(h => h.id), ["W1-T13919"], "readHeldFollowUps: reads origin/main, not only the working tree");
  const rows: Row[] = [];
  const out = await w.act(rows, []);
  assert.equal(out.error, undefined, out.reason);
  assert.equal(out.heldTaskId, "W1-T13919");
  assert.equal(w.reserved.length, 0, "no id is reserved");
  assert.equal(w.landed.length, 0, "no task file lands");
  assert.deepEqual(remedyRows(rows).map(r => [r.outcome, r.held_task_id, r.reused]), [["taken", "W1-T13919", true]]);
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

test("W1-T13944 criterion 3: two splits started together whose criteria overlap file the shared criterion once", async t => {
  const root = tempRoot(t, "one-held-overlap");
  const queue: HeldFollowUp[] = [];
  const f = fakeHost(root, queue);
  const rows: Row[] = [];
  await Promise.all([takeParkedPrRemedy(subject(), split([CLAIMS[1]!]), [], f.h, context(rows)),
    takeParkedPrRemedy(subject(), split([CLAIMS[1]!, CLAIMS[2]!]), [], f.h, context(rows))]);
  assert.equal(f.reserved.length, 1, `one id is reserved while the shared criterion is claimed: ${f.reserved.join(", ")}`);
  assert.equal(carries(f.landed.flat(), CLAIMS[1]!).length, 1, "the shared criterion is in one held file");
  // The next pass moves only the criterion no held follow-up carries yet.
  const next = await takeParkedPrRemedy(subject(), split([CLAIMS[1]!, CLAIMS[2]!]), [], f.h, context(rows));
  assert.equal(next.error, undefined, next.reason);
  assert.equal(carries(f.landed.flat(), CLAIMS[1]!).length, 1, "the shared criterion is still in one held file");
  assert.equal(carries(f.landed.flat(), CLAIMS[2]!).length, 1, "the other criterion is in one held file");
  const again = await takeParkedPrRemedy(subject(), split([CLAIMS[1]!, CLAIMS[2]!]), [], f.h, context(rows));
  assert.equal(again.error, undefined, again.reason);
  assert.equal(f.landed.length, new Set(f.reserved).size, "with every criterion held, a split files nothing more");
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

test("W1-T13944 criterion 4: a restart after the reservation push and before the id reached the claim lands that id, reserving none", async t => {
  const w = await world(t, { realReservation: true });
  let reached!: (reservation: Promise<string>) => void;
  const pushed = new Promise<Promise<string>>(resolve => { reached = resolve; });
  // The first pass dies once its reservation push went through: reserveTaskId never returns to it.
  const dying: ParkedPrHost = { ...w.host, reserveTaskId: (target, beforePush) => {
    reached(Promise.resolve(w.production.reserveTaskId(target, beforePush)));
    return new Promise<string>(() => {});
  } };
  void takeParkedPrRemedy(subject(), split(), [], dying, context([]));
  const id = await (await pushed);
  assert.match(id, /^W1-T\d+$/);
  assert.ok(w.origin.git("rev-parse", taskIdReservationRef(id)).trim(), "origin holds the first pass's reservation");
  const restarted = await restartedRemedy();
  const reservedAfter: string[] = [];
  const host: ParkedPrHost = { ...w.host, reserveTaskId: async (target, beforePush) => {
    const next = await w.production.reserveTaskId(target, beforePush);
    reservedAfter.push(next);
    return next;
  } };
  const rows: Row[] = [];
  const out = await withLiveWritesAllowed(() => restarted.takeParkedPrRemedy(subject(), split(), [], host, context(rows)));
  assert.equal(out.error, undefined, out.reason);
  assert.deepEqual(reservedAfter, [], "the restarted pass reserves no id");
  assert.equal(out.heldTaskId, id, "the restarted pass lands the id the first pass pushed");
  assert.ok(w.landed.flat().some(f => f.newFile === true && f.relPath.includes(id)), "the held file names that id");
  assert.deepEqual(remedyRows(rows).map(r => [r.outcome, r.held_task_id]), [["taken", id]]);
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

test("W1-T13944 criterion 5: when the landing also fails to list its pull requests, partial_refusal still names the parent refusal", async t => {
  const w = await world(t, { refuseParentEdit: true, listFails: true });
  const rows: Row[] = [];
  const out = await w.act(rows, []);
  assert.equal(out.error, undefined, out.reason);
  const first = remedyRows(rows);
  assert.deepEqual(first.map(r => [r.outcome, r.held_task_id]), [["taken", w.reserved[0]]]);
  assert.match(String(first[0]!.partial_refusal), /design-invariant-proof/, "the parent refusal is kept");
  assert.match(String(first[0]!.partial_refusal), /cannot be listed/, "the listing error is kept after it");
  const again = await w.act([], rows.filter(r => r.step !== PARKED_PR_REMEDY_STEP));
  assert.equal(again.heldTaskId, w.reserved[0]);
  assert.equal(w.reserved.length, 1, "the next call reserves no id");
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

test("W1-T13944 criterion 6: a taken row for one criterion does not stand for a later split of another criterion on the same PR and cause", async t => {
  const root = tempRoot(t, "one-held-replay");
  const f = fakeHost(root, []);
  const rows: Row[] = [];
  const first = await takeParkedPrRemedy(subject(), split([CLAIMS[1]!]), [], f.h, context(rows));
  assert.equal(first.error, undefined, first.reason);
  const later = await takeParkedPrRemedy(subject(), split([CLAIMS[2]!]), [...rows], f.h, context(rows));
  assert.equal(later.error, undefined, later.reason);
  assert.equal(f.reserved.length, 2, "the other criterion files its own held follow-up");
  assert.notEqual(later.heldTaskId, first.heldTaskId);
  assert.equal(carries(f.landed.flat(), CLAIMS[2]!).length, 1);
  // The same criterion again, with the ledger, reuses its own row.
  const same = await takeParkedPrRemedy(subject(), split([CLAIMS[1]!]), [...rows], f.h, context(rows));
  assert.equal(same.heldTaskId, first.heldTaskId);
  assert.equal(f.reserved.length, 2);
});

/** The claim file of `claim` of `parent`, as the remedy names it. */
const claimFile = (root: string, parent: string, claim: string) => join(root, "state", "parked-pr-held-follow-up-claims",
  `${createHash("sha256").update(JSON.stringify({ parent, claim })).digest("hex").slice(0, 32)}.json`);

test("W1-T13944 criterion 4: a reservation that fails after its push keeps the pushed id for the next pass; one that fails before keeps nothing", async t => {
  const root = tempRoot(t, "one-held-pending");
  const f = fakeHost(root, []);
  const anchor = "b".repeat(40);
  const failing: ParkedPrHost = { ...f.h, reserveTaskId: async (_target, beforePush) => {
    beforePush?.("W1-T13950", anchor);
    throw new Error("the reservation push went through, and its answer was lost");
  } };
  const out1 = await takeParkedPrRemedy(subject(), split(), [], failing, context([]));
  assert.match(String(out1.error), /answer was lost/);
  const kept = JSON.parse(readFileSync(claimFile(root, TASK, CLAIMS[1]!), "utf8")) as Row;
  assert.deepEqual([kept.holder, kept.pending], [null, [{ taskId: "W1-T13950", anchor }]], "the claim keeps the push and no holder");
  const held: string[] = [];
  const out2 = await takeParkedPrRemedy(subject(), split(), [], { ...f.h, reservationHeld: async (id, a) => {
    held.push(id);
    return id === "W1-T13950" && a === anchor;
  } }, context([]));
  assert.equal(out2.error, undefined, out2.reason);
  assert.deepEqual([out2.heldTaskId, held, f.reserved], ["W1-T13950", ["W1-T13950"], []], "the pushed id is landed, none reserved");

  const beforeAny: ParkedPrHost = { ...f.h, reserveTaskId: async () => { throw new Error("origin cannot be reached"); } };
  const out3 = await takeParkedPrRemedy(subject(), split([CLAIMS[2]!]), [], beforeAny, context([]));
  assert.match(String(out3.error), /cannot be reached/);
  assert.equal(existsSync(claimFile(root, TASK, CLAIMS[2]!)), false, "with no push, the claim is removed");
});

test("W1-T13944 criterion 3: claims of a dead holder or a torn file are taken over, a live holder stands the split back, a failed write takes none", async t => {
  const root = tempRoot(t, "one-held-holders");
  const f = fakeHost(root, []);
  mkdirSync(join(root, "state", "parked-pr-held-follow-up-claims"), { recursive: true });
  const write = (claim: string, text: string) => writeFileSync(claimFile(root, TASK, claim), text);
  // pid 1 lives under another user (EPERM), the parent process lives under this one: both hold their claims.
  for (const pid of [1, process.ppid]) {
    write(CLAIMS[1]!, `${JSON.stringify({ parent: TASK, claim: CLAIMS[1], holder: { pid, token: "another-daemon" } })}\n`);
    const out = await takeParkedPrRemedy(subject(), split(), [], f.h, context([]));
    assert.match(String(out.error), /another pass holds the claim/, `pid ${pid} holds the claim`);
  }
  assert.equal(f.reserved.length, 0);
  // A claim whose file is not a file cannot be read, so the split is refused and takes no claim.
  mkdirSync(claimFile(root, TASK, CLAIMS[0]!));
  const unreadable = await takeParkedPrRemedy(subject(), split([CLAIMS[0]!]), [], f.h, context([]));
  assert.match(String(unreadable.error), /EISDIR/);
  // A torn claim is taken over; when its rewrite fails, the claim this pass created beside it is given back.
  write(CLAIMS[2]!, "{\"parent\": ");
  mkdirSync(`${claimFile(root, TASK, CLAIMS[2]!)}.${process.pid}.tmp`);
  rmSync(claimFile(root, TASK, CLAIMS[1]!));
  const failed = await takeParkedPrRemedy(subject(), split([CLAIMS[1]!, CLAIMS[2]!]), [], f.h, context([]));
  assert.match(String(failed.error), /EISDIR/);
  assert.equal(existsSync(claimFile(root, TASK, CLAIMS[1]!)), false, "the created claim is given back");
  rmSync(`${claimFile(root, TASK, CLAIMS[2]!)}.${process.pid}.tmp`, { recursive: true });
  // A dead holder (a pid no process has) and the torn claim are taken over, and the split files once.
  write(CLAIMS[1]!, `${JSON.stringify({ parent: TASK, claim: CLAIMS[1], holder: { pid: 2 ** 22 + 7, token: "gone" } })}\n`);
  const taken = await takeParkedPrRemedy(subject(), split([CLAIMS[1]!, CLAIMS[2]!]), [], f.h, context([]));
  assert.equal(taken.error, undefined, taken.reason);
  assert.equal(f.reserved.length, 1);
});
