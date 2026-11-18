import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";

import type { Config } from "#src/lib/config.js";
import { taskFilesLandingBranchAsync, type TaskFileInput } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { PARKED_PR_REMEDY_STEP, takeParkedPrRemedy, type ParkedPrDecision, type ParkedPrHost,
  type ParkedPrSubject } from "#src/lib/parked-pr-remedy.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { buildSweepEffects } from "#src/lib/sweep.js";
import { formatReservationAnchorMessage, taskIdReservationRef } from "#src/lib/task-id-reservation.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { buildFixturePlanPrBody } from "#test/helpers/plan-pr-body-fixture.js";

// W1-T13656: the held task file a split or a rebuild files is new, so the landing must be told so. Every test here
// drives the sweep's own parked-PR host, whose landTaskFiles is the real landTaskFilesAsync, over a real git origin.

const OWNER = "fixture", REPO = "remudero", ID = "W1-T900656";
const SHARD = `plan/tasks.d/${ID}-fixture.yaml`;
const CLAIMS = ["the first criterion holds", "the second criterion needs a design answer"];
const shardText = [`- id: ${ID}`, "  title: Held rebuild fixture", "  repo: remudero", "  depends_on: []", "  type: implement",
  "  risk: high", "  verify: auto", "  status: queued", "  attempts: 0", "  acceptance:",
  ...CLAIMS.flatMap(c => [`    - claim: "${c}"`, `      proof: "grep: ${c} in src/x.ts"`]), "  rationale: |", "    WHY: a fixture.", ""].join("\n");
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const RED: PlanPrPreflightResult = { ok: false, failures: [{ check: "proof-discrimination", firstLine: "fixture refusal" }], unreadable: [] };
// One id sequence for the file: the landing remembers a tree it has tested, so no two tests may file the same bytes.
let minted = 0;

async function world(t: TestContext) {
  // The branch the landing holds a reservation by; its source repository is the checkout the test runs in.
  const landingBranch = await taskFilesLandingBranchAsync({ owner: OWNER, repo: REPO });
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}held-new-file-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const origin = gitRepo({ scope: t, bare: true, kind: "held-new-file-origin" });
  const seed = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "held-new-file-seed" });
  for (const [path, text] of [["plan/tasks.yaml", "[]\n"], [SHARD, shardText]] as const) {
    mkdirSync(join(seed.dir, path, ".."), { recursive: true });
    writeFileSync(join(seed.dir, path), text);
  }
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed fixture");
  seed.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const repo = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "held-new-file-checkout" });
  const env = { ...process.env, GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email };
  const reserved: string[] = [], closed: string[] = [], landed: TaskFileInput[][] = [], rows: Record<string, unknown>[] = [];
  let verdict = GREEN;
  const effects = buildSweepEffects({
    owner: OWNER, repo: REPO, repoRoot: repo.dir, config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"), runId: "fixture-sweep", log: () => {},
    plan: mergePlanBlobs([{ label: "fixture.yaml", text: shardText }]),
    reloadPlanForFixImpl: () => mergePlanBlobs([{ label: "fixture.yaml", text: shardText }]),
    readJsonImpl: async args => { throw new Error(`the remedy reads no API: ${args.join(" ")}`); },
    // The real git, in the fixture checkout: main holds no file at a held task's path.
    planRepairGitImpl: (_file, args) => execFileSync("git", [...args], { encoding: "utf8", stdio: "pipe", env }),
    ghJsonImpl: args => {
      assert.equal(args[0], "pr", `the landing makes no other GitHub call: ${args.join(" ")}`);
      return args[1] === "create" ? `https://github.com/${OWNER}/${REPO}/pull/656` : [];
    },
    // The sweep's reservation, as reservePlanRepairTaskId leaves it: an anchor ref held by the landing branch.
    planRepairReserveIdImpl: () => {
      const id = `W1-T90${1000 + minted++}`;
      const tree = origin.git("rev-parse", "main^{tree}");
      const sha = origin.git("commit-tree", tree, "-m", formatReservationAnchorMessage({ branch: landingBranch, startedAt: "2026-11-18T00:00:00Z" }));
      origin.git("update-ref", taskIdReservationRef(id), sha);
      reserved.push(id);
      return id;
    },
    buildPlanPrBodyImpl: buildFixturePlanPrBody,
    planPrPreflightImpl: () => verdict,
  });
  assert.ok(effects.parkedPr, "the production sweep effects wire the remedy");
  const production = effects.parkedPr;
  const host: ParkedPrHost = {
    ...production,
    landTaskFiles: (files, target) => { landed.push([...files]); return production.landTaskFiles(files, target); },
    closePr: async prUrl => { closed.push(prUrl); },
  };
  const ctx = { runId: "fixture-sweep", ledgerTaskId: ID, nowIso: "2026-11-18T12:00:00.000Z", cause: "needs-design",
    text: "which store?", append: (row: Record<string, unknown>) => { rows.push(row); } };
  const act = (pr: ParkedPrSubject, decision: ParkedPrDecision) =>
    withLiveWritesAllowed(() => takeParkedPrRemedy(pr, decision, [], host, ctx));
  const pending = (rel: string) => join(root, "state", "task-files-landing-pending", rel);
  const refOf = (id: string) => origin.git("for-each-ref", "--format=%(objectname)", taskIdReservationRef(id));
  return { act, reserved, closed, landed, rows, pending, refOf, refuse: () => { verdict = RED; },
    mainHolds: (rel: string) => origin.git("ls-tree", "--name-only", "main", rel) !== "" };
}

const subject: ParkedPrSubject = { prNumber: 19199, prUrl: `https://github.com/${OWNER}/${REPO}/pull/19199`, headSha: "head", taskId: ID,
  unmetCriteria: [{ claim: CLAIMS[1]!, reason: "it needs a design answer" }] };
const rebuild: ParkedPrDecision = { remedy: "close-and-rebuild", reason: "no part can merge without operator input",
  inputCriteria: CLAIMS.map(claim => ({ claim, needsInput: true, ladderSpent: true })) };
const split: ParkedPrDecision = { remedy: "split-follow-up", reason: "one criterion needs operator input",
  inputCriteria: [{ claim: CLAIMS[1]!, needsInput: true, ladderSpent: true }] };
const remedyRows = (rows: readonly Record<string, unknown>[]) => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP);
const meta = (abs: string) => JSON.parse(readFileSync(`${abs}.meta.json`, "utf8")) as { baseBlob: string | null };

test("W1-T13656 criterion 1: a close-and-rebuild lands its held task file as a new file, takes the remedy and closes the PR", async t => {
  const w = await world(t);
  assert.ok(w.mainHolds(SHARD), "origin/main holds the task file of the pull request");
  const out = await w.act(subject, rebuild);
  assert.equal(out.error, undefined, out.reason);
  const held = out.heldTaskId!;
  assert.equal(held, w.reserved[0]);
  const files = w.landed[0]!;
  assert.equal(files.length, 1);
  assert.match(files[0]!.relPath, new RegExp(`^plan/tasks\\.d/${held}-`));
  assert.equal(w.mainHolds(files[0]!.relPath), false, "origin/main does not hold the held task file");
  assert.equal(files[0]!.newFile, true);
  assert.ok(existsSync(w.pending(files[0]!.relPath)), "the real landing staged the held task file");
  assert.equal(meta(w.pending(files[0]!.relPath)).baseBlob, null);
  assert.equal((parse(readFileSync(w.pending(files[0]!.relPath), "utf8")) as { id: string }[])[0]!.id, held);
  const row = remedyRows(w.rows)[0]!;
  assert.deepEqual([row.remedy, row.outcome, row.held_task_id, row.closed], ["close-and-rebuild", "taken", held, true]);
  assert.doesNotMatch(String(row.reason), /takes only an edit of a task file that exists/);
  assert.deepEqual(w.closed, [subject.prUrl], "the pull request is closed");
  assert.notEqual(w.refOf(held), "", "a landed held task keeps its reserved id");
});

test("W1-T13656 criterion 2: invariant:edits-stay-edits, a split marks only its held task file new", async t => {
  const w = await world(t);
  const out = await w.act(subject, split);
  assert.equal(out.error, undefined, out.reason);
  const files = w.landed[0]!;
  const amended = files.find(f => f.relPath === SHARD)!, held = files.find(f => f.relPath !== SHARD)!;
  assert.ok(amended && held, "a split lands the held task file and the amended task file");
  assert.equal(held.newFile, true);
  assert.equal(amended.newFile, undefined, "the amended task file is an edit of a file origin/main holds");
  assert.equal(meta(w.pending(held.relPath)).baseBlob, null);
  assert.notEqual(meta(w.pending(SHARD)).baseBlob, null, "the amended task file is staged against its main blob");
  assert.match(readFileSync(w.pending(SHARD), "utf8"), new RegExp(`MOVED to ${out.heldTaskId}`));
  const row = remedyRows(w.rows)[0]!;
  assert.deepEqual([row.remedy, row.outcome, row.held_task_id, row.closed], ["split-follow-up", "taken", out.heldTaskId, undefined]);
  assert.deepEqual(w.closed, [], "a split does not close the pull request");
});

test("W1-T13656 criterion 3: the plan-filing rebuild marks its held task file new and lands through the real landing", async t => {
  const w = await world(t);
  const filing: ParkedPrSubject = { prNumber: 19200, prUrl: `https://github.com/${OWNER}/${REPO}/pull/19200`, headSha: "head",
    isPlanFiling: true, planFiles: ["plan/tasks.d/W1-T900700-a-filed-task.yaml"], unmetCriteria: [] };
  const out = await w.act(filing, { remedy: "close-and-rebuild", reason: "the plan-scoped round is exhausted", inputCriteria: [] });
  assert.equal(out.error, undefined, out.reason);
  const files = w.landed[0]!;
  assert.equal(files.length, 1);
  assert.equal(files[0]!.newFile, true);
  assert.match(files[0]!.relPath, new RegExp(`^plan/tasks\\.d/${out.heldTaskId}-rebuild-the-plan-filing-of-pull-request-19200\\.yaml$`));
  assert.ok(existsSync(w.pending(files[0]!.relPath)), "the real landing staged the held plan rebuild");
  const row = remedyRows(w.rows)[0]!;
  assert.deepEqual([row.outcome, row.held_task_id, row.closed], ["taken", out.heldTaskId, true]);
  assert.deepEqual(w.closed, [filing.prUrl]);
});

test("W1-T13656 criterion 4: invariant:a-refused-held-file-frees-its-id, a held task file the landing refuses releases its id on every pass", async t => {
  const w = await world(t);
  w.refuse();
  for (let pass = 0; pass < 2; pass++) {
    const out = await w.act(subject, rebuild);
    assert.match(String(out.error), /the plan preflight refused it: \[proof-discrimination\] fixture refusal/);
  }
  assert.equal(w.reserved.length, 2, "each pass reserves one id");
  for (const id of w.reserved) assert.equal(w.refOf(id), "", `the reservation of ${id} is released`);
  assert.deepEqual(remedyRows(w.rows).map(r => [r.outcome, r.held_task_id]), [["refused", undefined], ["refused", undefined]]);
  assert.ok(remedyRows(w.rows).every(r => !String(r.reason).includes("takes only an edit of a task file that exists")));
  assert.deepEqual(w.closed, [], "a refused landing closes nothing");
});
