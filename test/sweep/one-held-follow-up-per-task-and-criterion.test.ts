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
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { REPO_ROOT } from "#test/helpers/repo-root.js";

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
  if (opts.realReservation === true) {
    // The production reservation spawns commit-tree outside the fixture's Git wrapper, with this process's environment,
    // where an empty GIT_AUTHOR_NAME or GIT_COMMITTER_NAME outranks the checkout's config: name the fixture there too.
    repo.git("config", "--local", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
    repo.git("config", "--local", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
    const identity = { GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email };
    const before = Object.fromEntries(Object.keys(identity).map(k => [k, process.env[k]]));
    Object.assign(process.env, identity);
    t.after(() => {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }
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
  const results: Awaited<ReturnType<ParkedPrHost["landTaskFiles"]>>[] = [];
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
    landTaskFiles: async (files, target) => {
      landed.push([...files]);
      const result = await production.landTaskFiles(files, target);
      results.push(result);
      return result;
    },
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
  return { act, reserved, landed, results, stage, host, production, origin, checkoutDir: repo.dir };
}

/** The remedy module loaded again, as a restarted daemon loads it: a new claim token, so the old holder is gone. */
async function restartedRemedy(): Promise<typeof import("#src/lib/parked-pr-remedy.js")> {
  const url = pathToFileURL(join(REPO_ROOT, "src", "lib", "parked-pr-remedy.ts"));
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
  // The landing's own error stays the transport error, as every other remedy (close-and-rebuild) reads it.
  assert.match(String(w.results[0]!.error), /cannot be listed/, "the landing error keeps its precedence");
  assert.match(String(w.results[0]!.refused?.map(r => r.reason).join("; ")), /design-invariant-proof/);
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

/** The newest generation of the claim on `claim` of `parent`, as the remedy names it, or undefined when there is none. */
const claimDir = (root: string, parent: string, claim: string) => join(root, "state", "parked-pr-held-follow-up-claims",
  createHash("sha256").update(JSON.stringify({ parent, claim })).digest("hex").slice(0, 32));
function claimRecord(root: string, parent: string, claim: string): Row | undefined {
  const dir = claimDir(root, parent, claim);
  const gens = existsSync(dir) ? readdirSync(dir).flatMap(n => /^(\d+)\.json$/.exec(n)?.[1] ?? []).map(Number) : [];
  return gens.length === 0 ? undefined : JSON.parse(readFileSync(join(dir, `${Math.max(...gens)}.json`), "utf8")) as Row;
}
/** Writes `record` as the next generation of the claim, as a pass in another process would. */
function writeClaim(root: string, parent: string, claim: string, record: Row): void {
  const dir = claimDir(root, parent, claim);
  mkdirSync(dir, { recursive: true });
  const gens = readdirSync(dir).flatMap(n => /^(\d+)\.json$/.exec(n)?.[1] ?? []).map(Number);
  writeFileSync(join(dir, `${Math.max(0, ...gens) + 1}.json`), `${JSON.stringify({ parent, claim, ...record })}\n`);
}

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
  const kept = claimRecord(root, TASK, CLAIMS[1]!)!;
  assert.deepEqual([kept.holder, kept.pending], [null, [{ taskId: "W1-T13950", anchor, claims: [CLAIMS[1]] }]],
    "the claim keeps the push and no holder");
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
  const freed = claimRecord(root, TASK, CLAIMS[2]!)!;
  assert.deepEqual([freed.holder, freed.pending, freed.id], [null, [], undefined], "with no push, the claim holds nothing");
});

test("W1-T13944 criterion 4: a restart after a pass whose first id another holder held lands the id that pass pushed, reserving none", async t => {
  const w = await world(t, { realReservation: true });
  let planted: string | undefined;
  let reached!: (reservation: Promise<string>) => void;
  const pushed = new Promise<Promise<string>>(resolve => { reached = resolve; });
  // The first id the pass asks for is held by a holder whose branch is gone and whose time is old, one a takeover
  // would reclaim. A takeover pushes an anchor the claim never sees, so the pass must ask the next id instead.
  const dying: ParkedPrHost = { ...w.host, reserveTaskId: (target, beforePush) => {
    reached(Promise.resolve(w.production.reserveTaskId(target, (taskId, anchor) => {
      if (planted === undefined) {
        planted = taskId;
        const sha = w.origin.git("commit-tree", w.origin.git("rev-parse", "main^{tree}"), "-m",
          formatReservationAnchorMessage({ branch: "rmd/a-landing-branch-that-is-gone", startedAt: "2020-01-01T00:00:00Z" }));
        w.origin.git("update-ref", taskIdReservationRef(taskId), sha);
      }
      beforePush?.(taskId, anchor);
    })));
    return new Promise<string>(() => {});
  } };
  void takeParkedPrRemedy(subject(), split(), [], dying, context([]));
  const id = await (await pushed);
  assert.ok(planted !== undefined && id !== planted, `the held id ${String(planted)} is not taken over: ${id}`);
  const foreign = w.origin.git("log", "-1", "--format=%B", taskIdReservationRef(planted));
  assert.match(foreign, /a-landing-branch-that-is-gone/, "the other holder keeps its ref");
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
  assert.deepEqual(remedyRows(rows).map(r => [r.outcome, r.held_task_id]), [["taken", id]]);
});

test("W1-T13944 criterion 3: claims of a dead holder are taken over, a live holder stands the split back, damage takes none", async t => {
  const root = tempRoot(t, "one-held-holders");
  const f = fakeHost(root, []);
  // pid 1 lives under another user (EPERM), the parent process lives under this one: both hold their claims.
  for (const pid of [1, process.ppid]) {
    writeClaim(root, TASK, CLAIMS[1]!, { holder: { pid, token: "another-daemon" }, pending: [] });
    const out = await takeParkedPrRemedy(subject(), split(), [], f.h, context([]));
    assert.match(String(out.error), /another pass holds the claim/, `pid ${pid} holds the claim`);
  }
  assert.equal(f.reserved.length, 0);
  // A generation is written whole, so one that does not parse is damage: the split is refused and takes no claim.
  mkdirSync(claimDir(root, TASK, CLAIMS[2]!), { recursive: true });
  writeFileSync(join(claimDir(root, TASK, CLAIMS[2]!), "1.json"), "{\"parent\": ");
  const damaged = await takeParkedPrRemedy(subject(), split([CLAIMS[2]!]), [], f.h, context([]));
  assert.match(String(damaged.error), /JSON/);
  assert.equal(f.reserved.length, 0);
  rmSync(claimDir(root, TASK, CLAIMS[2]!), { recursive: true });
  // A dead holder (a pid no process has) is taken over, and the split files once.
  writeClaim(root, TASK, CLAIMS[1]!, { holder: { pid: 2 ** 22 + 7, token: "gone" }, pending: [] });
  const taken = await takeParkedPrRemedy(subject(), split([CLAIMS[1]!, CLAIMS[2]!]), [], f.h, context([]));
  assert.equal(taken.error, undefined, taken.reason);
  assert.equal(f.reserved.length, 1);
  assert.equal(claimRecord(root, TASK, CLAIMS[1]!)!.id, f.reserved[0]);
});

/**
 * A pass in its own process: it loads the remedy, says it is ready, waits for `go`, and runs one split over a claim root
 * and landing queue that every process shares. Each reservation it makes is a line in `reservations`.
 */
const CHILD_PASS = `
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const f = JSON.parse(process.env.RMD_T13944_PASS);
const { takeParkedPrRemedy, heldFollowUpsOfTaskText } = await import(f.remedyUrl);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const host = {
  heldFollowUpClaimRoot: f.root,
  readHeldFollowUps: async () => readdirSync(f.queue).flatMap(n => heldFollowUpsOfTaskText(readFileSync(join(f.queue, n), "utf8"))),
  readTaskShard: async () => ({ outcome: "read", shard: f.shard, target: { owner: "fixture", repo: "remudero", checkoutDir: "/unused" } }),
  reserveTaskId: async (_target, beforePush) => {
    const id = "W1-T" + (13919 + f.index);
    beforePush?.(id, "a".repeat(40));
    appendFileSync(f.reservations, id + "\\n");
    await sleep(50);
    return id;
  },
  landTaskFiles: async files => {
    await sleep(20);
    writeFileSync(join(f.queue, f.index + ".yaml"), files[0].content);
    return { staged: files.map(file => file.relPath) };
  },
  closePr: async () => { throw new Error("a split closes no pull request"); },
};
writeFileSync(f.ready, "");
while (!existsSync(f.go)) await sleep(1);
const out = await takeParkedPrRemedy(f.subject, f.decision, [], host, { runId: "pass-" + f.index, ledgerTaskId: f.subject.taskId,
  nowIso: "2026-11-20T08:00:00.000Z", cause: "needs-design", text: "which store?", append: () => {} });
process.stdout.write(JSON.stringify(out));
`;

test("W1-T13944 criterion 3: invariant:one-held-follow-up-per-criterion, passes in four processes started together reserve one id", { timeout: 240_000 }, async t => {
  const root = tempRoot(t, "one-held-processes");
  const queue = join(root, "queue"), reservations = join(root, "reservations"), go = join(root, "go");
  mkdirSync(queue);
  writeFileSync(reservations, "");
  const remedyUrl = pathToFileURL(join(REPO_ROOT, "src", "lib", "parked-pr-remedy.ts")).href;
  const passes = [0, 1, 2, 3].map(index => {
    const ready = join(root, `ready-${index}`);
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD_PASS], {
      cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: root, RMD_T13944_PASS: JSON.stringify({ index, root, queue, reservations, go, ready, remedyUrl,
        shard: { relPath: shardRel(TASK), text: shardOf(TASK) }, subject: subject(), decision: split() }) },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += String(d); });
    child.stderr.on("data", d => { stderr += String(d); });
    const done = new Promise<{ heldTaskId?: string; error?: string }>((resolve, reject) => child.on("close", code => code === 0
      ? resolve(JSON.parse(stdout) as { heldTaskId?: string; error?: string })
      : reject(new Error(`pass ${index} exited ${String(code)}: ${stderr}`))));
    return { ready, done };
  });
  while (!passes.every(p => existsSync(p.ready))) await new Promise(resolve => setTimeout(resolve, 20));
  writeFileSync(go, "");
  const outs = await Promise.all(passes.map(p => p.done));
  const reserved = readFileSync(reservations, "utf8").split("\n").filter(Boolean);
  assert.equal(reserved.length, 1, `exactly one id is reserved: ${reserved.join(", ")} (${JSON.stringify(outs)})`);
  const landed = readdirSync(queue).flatMap(n => heldFollowUpsOfTaskText(readFileSync(join(queue, n), "utf8")));
  assert.ok(landed.length > 0 && landed.every(h => h.id === reserved[0]), `every landed file names ${reserved[0]}`);
  assert.ok(outs.every(o => o.heldTaskId === undefined || o.heldTaskId === reserved[0]), JSON.stringify(outs));
});

test("W1-T13944 criterion 1: a lagging daemon plan that holds a lower matching id does not stand in for the task origin/main holds", async t => {
  const w = await world(t, { mainExtra: { id: "W1-T20002", text: heldText("W1-T20002", TASK, [CLAIMS[1]!]) },
    planExtra: heldText("W1-T20001", TASK, [CLAIMS[1]!]) });
  const rows: Row[] = [];
  const out = await w.act(rows, []);
  assert.equal(out.error, undefined, out.reason);
  assert.equal(out.heldTaskId, "W1-T20002", "the held follow-up origin/main holds is reused");
  assert.equal(w.reserved.length, 0, "no id is reserved");
  assert.equal(w.landed.length, 0, "no task file lands");
  assert.deepEqual(remedyRows(rows).map(r => [r.outcome, r.held_task_id, r.reused]), [["taken", "W1-T20002", true]]);
});

test("W1-T13944 criterion 7: readHeldFollowUps: a held follow-up on origin/main that depends on a task in another catalog is read", async t => {
  const text = heldText("W1-T13919", TASK, [CLAIMS[1]!]).replace(`    - ${TASK}\n`, `    - ${TASK}\n    - W1-T13900001\n`);
  const w = await world(t, { mainExtra: { id: "W1-T13919", text } });
  const read = await w.host.readHeldFollowUps!({ owner: OWNER, repo: REPO, checkoutDir: w.checkoutDir });
  assert.deepEqual(read.map(h => [h.id, h.depends_on]), [["W1-T13919", [TASK, "W1-T13900001"]]]);
  const rows: Row[] = [];
  const out = await w.act(rows, []);
  assert.equal(out.heldTaskId, "W1-T13919", out.reason);
  assert.equal(w.reserved.length, 0, "no id is reserved");
  assert.deepEqual(remedyRows(rows).map(r => [r.outcome, r.held_task_id, r.reused]), [["taken", "W1-T13919", true]]);
});

test("W1-T13944 criterion 5: a split whose files all stage and whose landing only fails to list its pull requests is refused and names no parent refusal", async t => {
  const w = await world(t, { listFails: true });
  const rows: Row[] = [];
  const out = await w.act(rows, []);
  assert.match(String(out.error), /cannot be listed/);
  const first = remedyRows(rows);
  assert.deepEqual(first.map(r => [r.outcome, r.held_task_id, r.partial_refusal]), [["refused", undefined, undefined]]);
  assert.doesNotMatch(String(first[0]!.reason), /refused the edit of the parent/);
  // The held file waits in the landing queue, so the next call, with no remedy row, reuses it.
  const next: Row[] = [];
  const again = await w.act(next, []);
  assert.equal(again.heldTaskId, w.reserved[0], again.reason);
  assert.equal(w.reserved.length, 1, "the next call reserves no id");
});

test("W1-T13944 criterion 6: a reservation pushed for two criteria is not taken by a split of one, so each files its own id", async t => {
  const root = tempRoot(t, "one-held-shared-push");
  const queue: HeldFollowUp[] = [];
  const f = fakeHost(root, queue);
  const anchor = "c".repeat(40);
  const dying: ParkedPrHost = { ...f.h, reserveTaskId: async (_target, beforePush) => {
    beforePush?.("W1-T13950", anchor);
    throw new Error("the daemon stopped after the push");
  } };
  const out0 = await takeParkedPrRemedy(subject(), split([CLAIMS[1]!, CLAIMS[2]!]), [], dying, context([]));
  assert.match(String(out0.error), /stopped after the push/);
  const held: ParkedPrHost = { ...f.h, reservationHeld: async (id, a) => id === "W1-T13950" && a === anchor };
  const rows: Row[] = [];
  const first = await takeParkedPrRemedy(subject(), split([CLAIMS[1]!]), [], held, context(rows));
  const second = await takeParkedPrRemedy(subject(), split([CLAIMS[2]!]), [], held, context(rows));
  assert.equal(first.error, undefined, first.reason);
  assert.equal(second.error, undefined, second.reason);
  assert.notEqual(first.heldTaskId, second.heldTaskId, "the two criteria name two held follow-ups");
  assert.deepEqual(f.reserved, [first.heldTaskId, second.heldTaskId], "each reserves its own id");
  assert.equal(carries(f.landed.flat(), CLAIMS[1]!).length, 1);
  assert.equal(carries(f.landed.flat(), CLAIMS[2]!).length, 1);
  assert.deepEqual(remedyRows(rows).map(r => [r.outcome, r.held_task_id]), [["taken", first.heldTaskId], ["taken", second.heldTaskId]]);
});

test("W1-T13944 criterion 6: a held file the landing refuses because other bytes wait at its path is not staged, so its split is refused", async t => {
  const w = await world(t);
  w.stage("W1-T13919");
  const rel = "plan/tasks.d/W1-T13919-fixture-task-held-follow-up.yaml";
  const landed = await withLiveWritesAllowed(() => w.production.landTaskFiles([{ relPath: rel, newFile: true,
    content: heldText("W1-T13919", TASK, [CLAIMS[2]!]), claim: "filed", proof: `grep: id: W1-T13919 in ${rel}` }],
  { owner: OWNER, repo: REPO, checkoutDir: w.checkoutDir }));
  assert.deepEqual(landed.refused?.map(r => r.relPath), [rel], "the other bytes are refused");
  assert.equal(landed.staged?.includes(rel), false, "a path that waits with other bytes is not this file's staging");
  // The remedy then writes refused and names no held task.
  const root = tempRoot(t, "one-held-other-bytes");
  const f = fakeHost(root, []);
  const rows: Row[] = [];
  const out = await takeParkedPrRemedy(subject(), split([CLAIMS[2]!]), [], { ...f.h, landTaskFiles: async files => ({
    error: landed.error ?? "refused", staged: [files[0]!.relPath], refused: [{ relPath: files[0]!.relPath, reason: "another edit waits" }] }) },
  context(rows));
  assert.ok(out.error !== undefined, out.reason);
  assert.deepEqual(remedyRows(rows).map(r => [r.outcome, r.held_task_id]), [["refused", undefined]]);
});
