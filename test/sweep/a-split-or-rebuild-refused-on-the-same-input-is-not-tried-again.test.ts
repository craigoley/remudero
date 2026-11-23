/**
 * W1-T13830 — A SPLIT OR REBUILD THAT THE PLAN PREFLIGHT REFUSED IS NOT TRIED AGAIN ON THE SAME INPUT.
 *
 * In the 48 hours to 2026-11-19 12:19Z, the split-follow-up and close-and-rebuild remedies were refused 97 times on 4
 * pull requests, and none was taken. Each try reserved a task id, built the held task, and the landing's plan
 * preflight refused it with the same checks. The remedy now keeps a digest of its input on the refused row and does
 * not try the same input again; the ladder takes its next remedy. The reservation is awaited, off the daemon loop.
 */
import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { TaskFileInput } from "#src/lib/feedback-landing.js";
import { actOnParkedPr, PARKED_PR_REMEDY_STEP, parkedPrRemedy, planPreflightRefusalChecks, takeParkedPrRemedy,
  type ParkedPrContext, type ParkedPrDecision, type ParkedPrFacts, type ParkedPrHost, type ParkedPrObserved,
  type ParkedPrSubject } from "#src/lib/parked-pr-remedy.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, reservePlanRepairTaskIdAsync, runSweep, type OpenPrView, type SweepDeps,
  type UpdateBranchOutcome } from "#src/lib/sweep.js";
import { taskIdReservationRef } from "#src/lib/task-id-reservation.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY, originWithClone } from "#test/helpers/git-repo.js";

type Row = { step: string } & Record<string, unknown>;

const TASK = "W1-T13830-FIXTURE";
const PR = 19605;
const PR_URL = `https://github.com/o/remudero/pull/${PR}`;
const HEAD = "7000d48".padEnd(40, "0");
const NOW = Date.parse("2026-11-19T12:00:00Z");
const CLAIMS = ["the first criterion holds", "the second criterion needs a design answer", "the third criterion holds too"];
const SHARD_REL = `plan/tasks.d/${TASK}-a-fixture-task.yaml`;
const shardOf = (rationale = "WHY: a fixture.") => [`- id: ${TASK}`, "  title: \"A fixture task\"", "  repo: remudero", "  files:",
  "    - src/x.ts", "  status: queued", "  attempts: 0", "  acceptance:",
  ...CLAIMS.flatMap(c => [`    - claim: "${c}"`, `      proof: "grep: ${c} in src/x.ts"`]), "  rationale: |", `    ${rationale}`, ""].join("\n");
const PREFLIGHT_REFUSAL = "the plan preflight refused it: [lint-plan] design-invariant-proof; [shard-census] W1-T3086";

type Landing = { prUrl?: string; error?: string; refusalChecks?: readonly string[] };

/** A remedy host whose landing gives `landing()`; it counts reservations and landings. */
function host(landing: () => Landing = () => ({ error: PREFLIGHT_REFUSAL, refusalChecks: ["shard-census", "lint-plan"] }),
  shard: () => string = () => shardOf()) {
  const reserved: string[] = [];
  const landed: TaskFileInput[][] = [];
  const closed: string[] = [];
  let next = 99000;
  const h: ParkedPrHost = {
    readTaskShard: async (id) => id === TASK
      ? { outcome: "read", shard: { relPath: SHARD_REL, text: shard() }, target: { owner: "o", repo: "remudero", checkoutDir: "/unused" } }
      : { outcome: "refused", reason: "task-absent" },
    reserveTaskId: () => { const id = `W1-T${++next}`; reserved.push(id); return id; },
    landTaskFiles: async (files) => { landed.push([...files]); return landing(); },
    closePr: async (prUrl) => { closed.push(prUrl); },
  };
  return { h, reserved, landed, closed };
}

const subject = (over: Partial<ParkedPrSubject> = {}): ParkedPrSubject => ({ prNumber: PR, prUrl: PR_URL, headSha: HEAD, taskId: TASK,
  unmetCriteria: [{ claim: CLAIMS[0]!, reason: "unmet" }, { claim: CLAIMS[1]!, reason: "needs a design answer" }], ...over });

const criterion = (claim: string) => ({ claim, needsInput: true, ladderSpent: true });
const split = (claims: readonly string[] = [CLAIMS[1]!]): ParkedPrDecision => ({ remedy: "split-follow-up",
  inputCriteria: claims.map(criterion), reason: "some criteria need input" });
const rebuild = (claims: readonly string[] = [CLAIMS[1]!]): ParkedPrDecision => ({ remedy: "close-and-rebuild",
  inputCriteria: claims.map(criterion), reason: "nothing can merge without input" });

function context(rows: Row[], observed?: ParkedPrObserved): ParkedPrContext {
  return { runId: "t13830", ledgerTaskId: TASK, nowIso: new Date(NOW).toISOString(), cause: "needs-design",
    text: "fix needs design at this exact head: which store?", append: (row) => { rows.push(row); },
    ...(observed === undefined ? {} : { observed }) };
}

const remedyRows = (rows: readonly Row[]) => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP);

test("W1-T13830 criterion 1: a split or rebuild refused by the plan preflight at the same input reserves, lands and writes nothing", async () => {
  for (const decision of [split(), rebuild()]) {
    const rows: Row[] = [];
    const first = host();
    const refused = await takeParkedPrRemedy(subject(), decision, rows, first.h, context(rows));
    assert.ok(refused.error, "the first try is refused by the landing");
    assert.equal(first.reserved.length, 1);
    const again = host();
    const before = rows.length;
    const outcome = await takeParkedPrRemedy(subject(), decision, rows, again.h, context(rows));
    assert.equal(outcome.unchanged, true);
    assert.equal(outcome.remedy, decision.remedy);
    assert.match(outcome.reason, /refused by the plan preflight \(lint-plan, shard-census\)/);
    assert.equal(outcome.heldTaskId, undefined);
    assert.equal(again.reserved.length, 0, `${decision.remedy}: reserveTaskId is not called`);
    assert.equal(again.landed.length, 0, `${decision.remedy}: landTaskFiles is not called`);
    assert.equal(rows.length, before, `${decision.remedy}: no row is written`);
  }
});

/** A design hold like pull request 19605: one of three criteria needs a design answer. */
function designRows(): Row[] {
  const common = { task_id: TASK, head_sha: HEAD, run_id: "DESIGN-ROUND", host: "fixture-host", actor_pid: 777 };
  const round = { ...common, round_id: "DESIGN-ROUND:1", repair_pr_url: PR_URL };
  return [
    { ...round, step: "fix.dispatch", ts: new Date(NOW - 3000).toISOString(), mode: "ci-log" },
    { ...common, step: "fix.needs_design", ts: new Date(NOW - 2000).toISOString(), contract_revision: "contract-A",
      reason: "which store owns the retries?", covers_criteria: [CLAIMS[1]!], covers_checks: [] },
    { ...round, step: "fix.done", ts: new Date(NOW - 1000).toISOString(), fix_outcome: "NEEDS_DESIGN", subtype: "success" },
  ];
}

const unmet = (claims: readonly string[]) => claims.map(claim => ({ claim, proof: `grep: ${claim} in src/x.ts`, met: false,
  reason: `${claim} is not met`, proof_exec: "executed_fail" })) as OpenPrView["unmetCriteria"];

test("W1-T13830 criterion 2: invariant:never-parked, ten passes at one head reserve one split and one rebuild, not ten", async () => {
  const rows = designRows();
  const parked = host();
  const deps: SweepDeps = {
    ledgerPath: "/unused/t13830-ledger", runId: "W1-T13830-test", now: () => NOW,
    readLedger: () => rows, readHeadContractRefreshHistory: async () => ({ complete: true, lines: rows }),
    appendLine: (_path, row) => { rows.push(row as Row); },
    fixProgressJudge: async () => ({ verdict: "continue", reason: "the judge permits another round" }),
    readTaskContractRevision: () => "contract-A", readMainTip: async () => "a".repeat(40),
    behindMainByPr: new Map([[PR, 0]]), updateBranch: async (): Promise<UpdateBranchOutcome> => "updated",
    arm: () => {}, close: () => {}, escalate: () => {}, dispatchFix: () => {},
    claimFixAdmission: () => ({ admitted: true }), parkedPr: parked.h,
  };
  const pr: OpenPrView = { prNumber: PR, prUrl: PR_URL, taskId: TASK, headSha: HEAD, checksState: "green", reviewState: "failure",
    unmetCriteria: unmet([CLAIMS[0]!, CLAIMS[1]!]), priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
    ciFailures: [] } as OpenPrView;
  for (let pass = 0; pass < 10; pass++) await runSweep([pr], deps);
  assert.equal(parked.reserved.length, 2, `ten passes reserved ${parked.reserved.length} task ids`);
  const refused = remedyRows(rows).filter(r => r.outcome === "refused");
  assert.deepEqual(refused.map(r => r.remedy), ["split-follow-up", "close-and-rebuild"]);
  assert.ok(remedyRows(rows).some(r => r.remedy === "fix-on-pr" && r.outcome === "taken"), "the ladder went on to fix-on-pr");

  // With no remedy left, W1-T13361's one needs-human issue opens. A plan filing has no split, so close-and-rebuild is
  // spent first, then fix-on-pr, which answers a plan filing with a wait.
  const ledger: Row[] = [];
  const asked: string[] = [];
  const plan = host();
  const observed: ParkedPrObserved = { bodyDigest: "body-1", redChecks: [], refusalLine: () => undefined,
    escalate: (text) => { asked.push(text); }, issueOpen: () => false };
  const filing = subject({ isPlanFiling: true, unmetCriteria: [{ claim: CLAIMS[1]!, reason: "needs a design answer" }] });
  const facts: ParkedPrFacts = { unmetCriteria: [criterion(CLAIMS[1]!)], redChecks: [], isPlanFiling: true, taskCriteria: 3 };
  for (let pass = 0; pass < 10; pass++) {
    const outcome = await actOnParkedPr(filing, parkedPrRemedy(facts), facts, ledger, plan.h, context(ledger, observed));
    assert.notEqual(outcome.disposition, "refused-escalate" as never);
  }
  assert.equal(plan.reserved.length, 1, "the rebuild was reserved once");
  assert.equal(asked.length, 1, "one needs-human issue is opened");
  assert.match(asked[0]!, /refused by the plan preflight/);
  assert.equal(remedyRows(ledger).filter(r => r.needs_human === true).length, 1);
});

test("W1-T13830 criterion 3: invariant:retry-on-transient, a refusal that is not a preflight verdict is tried again", async () => {
  // A git or file error from the landing, with no preflight checks.
  for (const landing of [() => ({ error: "git push failed: the remote hung up" }), () => ({ error: "ENOENT: the pending task file" })]) {
    const rows: Row[] = [];
    const h = host(landing);
    await takeParkedPrRemedy(subject(), split(), rows, h.h, context(rows));
    await takeParkedPrRemedy(subject(), split(), rows, h.h, context(rows));
    assert.equal(h.reserved.length, 2, "the next pass reserves and tries again");
    assert.equal(remedyRows(rows).every(r => r.refusal_checks === undefined), true);
  }
  // A failed reservation is a git error too.
  const rows: Row[] = [];
  const failing = host();
  let reserves = 0;
  failing.h.reserveTaskId = () => { reserves++; throw new Error("git ls-remote timed out"); };
  await takeParkedPrRemedy(subject(), split(), rows, failing.h, context(rows));
  await takeParkedPrRemedy(subject(), split(), rows, failing.h, context(rows));
  assert.equal(reserves, 2);
  // A timed-out preflight, or a red main alone has, gives no refusal checks, so the landing names none.
  const failures = [{ check: "lint-plan", firstLine: "a rule" }] as never;
  assert.equal(planPreflightRefusalChecks({ refused: [{ path: SHARD_REL, reason: "budget", failures, timedOut: true }], setAside: [] }), undefined);
  assert.equal(planPreflightRefusalChecks({ refused: [{ path: SHARD_REL, reason: "main red", failures, mainRed: true }], setAside: [] }), undefined);
  assert.equal(planPreflightRefusalChecks({ refused: [{ path: SHARD_REL, reason: "the same bytes were set aside before" }], setAside: [] }), undefined);
  assert.equal(planPreflightRefusalChecks({ refused: [], setAside: [] }), undefined);
  // A refused row written before this task (no input_digest) does not hold the remedy.
  const legacy: Row[] = [{ step: PARKED_PR_REMEDY_STEP, pr_number: PR, head_sha: HEAD, cause: "needs-design", remedy: "split-follow-up",
    outcome: "refused", reason: PREFLIGHT_REFUSAL, refusal_checks: ["lint-plan"] }];
  const old = host();
  const outcome = await takeParkedPrRemedy(subject(), split(), legacy, old.h, context(legacy));
  assert.equal(outcome.unchanged, undefined);
  assert.equal(old.reserved.length, 1);
});

test("W1-T13830 criterion 4: invariant:a-changed-input-releases, a new head, task file text or set of criteria tries again", async () => {
  const rows: Row[] = [];
  let text = shardOf();
  const h = host(undefined, () => text);
  await takeParkedPrRemedy(subject(), split(), rows, h.h, context(rows));
  const digests = () => remedyRows(rows).map(r => r.input_digest);
  await takeParkedPrRemedy(subject(), split(), rows, h.h, context(rows));
  assert.equal(h.reserved.length, 1, "control: the same input is held");
  await takeParkedPrRemedy(subject({ headSha: "b".repeat(40) }), split(), rows, h.h, context(rows));
  assert.equal(h.reserved.length, 2, "a new head tries again");
  text = shardOf("WHY: the task file changed in the holding repository.");
  await takeParkedPrRemedy(subject(), split(), rows, h.h, context(rows));
  assert.equal(h.reserved.length, 3, "a changed task file tries again");
  await takeParkedPrRemedy(subject(), split([CLAIMS[1]!, CLAIMS[2]!]), rows, h.h, context(rows));
  assert.equal(h.reserved.length, 4, "a changed set of moved criteria tries again");
  assert.equal(new Set(digests()).size, 4, "each changed input has its own digest");
  // A plan rebuild's input is its plan files.
  const planRows: Row[] = [];
  const plan = host();
  const filing = (planFiles: string[]) => subject({ taskId: undefined, isPlanFiling: true, planFiles });
  plan.h.planFilingTarget = { owner: "o", repo: "remudero", checkoutDir: "/unused" };
  await takeParkedPrRemedy(filing(["plan/tasks.d/W1-T1-a.yaml"]), rebuild([]), planRows, plan.h, context(planRows));
  await takeParkedPrRemedy(filing(["plan/tasks.d/W1-T1-a.yaml"]), rebuild([]), planRows, plan.h, context(planRows));
  assert.equal(plan.reserved.length, 1, "the same plan files are held");
  await takeParkedPrRemedy(filing(["plan/tasks.d/W1-T1-a.yaml", "plan/tasks.d/W1-T2-b.yaml"]), rebuild([]), planRows, plan.h, context(planRows));
  assert.equal(plan.reserved.length, 2, "a changed set of plan files tries again");
});

test("W1-T13830 criterion 5: the refused row records input_digest and the sorted refusal_checks", async () => {
  const rows: Row[] = [];
  await takeParkedPrRemedy(subject(), split(), rows, host().h, context(rows));
  const row = remedyRows(rows).at(-1)!;
  assert.equal(row.outcome, "refused");
  assert.match(String(row.input_digest), /^[0-9a-f]{64}$/);
  assert.deepEqual(row.refusal_checks, ["lint-plan", "shard-census"]);
  // The names come from the landing's first refused entry, or else its first set-aside entry, sorted and once each.
  const failures = [{ check: "shard-census", firstLine: "W1-T3086" }, { check: "lint-plan", firstLine: "design-invariant-proof" },
    { check: "lint-plan", firstLine: "machine-author-verify" }] as never;
  assert.deepEqual(planPreflightRefusalChecks({ refused: [{ path: SHARD_REL, reason: PREFLIGHT_REFUSAL, failures }], setAside: [] }),
    ["lint-plan", "shard-census"]);
  assert.deepEqual(planPreflightRefusalChecks({ refused: [], setAside: [{ path: SHARD_REL, reason: PREFLIGHT_REFUSAL, failures }] }),
    ["lint-plan", "shard-census"]);
});

/** Replaces node:child_process's sync APIs with a recorder that forwards to the real call, as W1-T13183's test does. */
function syncSpawnRecorder(t: TestContext): { calls: string[]; arm(on: boolean): void } {
  const calls: string[] = [];
  let armed = false;
  const cp = childProcess as unknown as Record<"execFileSync" | "spawnSync" | "execSync", (...a: unknown[]) => unknown>;
  for (const name of ["execFileSync", "spawnSync", "execSync"] as const) {
    const real = cp[name];
    t.mock.method(cp, name, (...a: unknown[]) => {
      if (armed) calls.push([name, String(a[0]), ...(Array.isArray(a[1]) ? a[1].map(String) : [])].join(" "));
      return real(...a);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { calls, arm: (on) => void (armed = on) };
}

const PLAN_SEED = {
  "MASTER-PLAN.md": "# MASTER-PLAN\n",
  "plan/tasks.d/.keep": "",
  "plan/tasks.yaml": ["- id: W1-T4", '  title: "a seed task the plan loader accepts"', "  repo: remudero", "  depends_on: []",
    "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n"),
};

const IDENTITY_KEYS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;
type IdentityKey = typeof IDENTITY_KEYS[number];
type IdentityEnv = Partial<Record<IdentityKey, string>>;

const identityEnvNow = (): IdentityEnv =>
  Object.fromEntries(IDENTITY_KEYS.flatMap(k => process.env[k] === undefined ? [] : [[k, process.env[k]]]));

/** Puts the four identity keys back as `saved` holds them: a key that was unset is deleted, never assigned. */
function restoreIdentityEnv(saved: IdentityEnv): void {
  for (const k of IDENTITY_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Runs `body` with the fixture identity in process.env, then restores the four keys as they were before. */
async function withFixtureIdentity<T>(body: () => Promise<T>): Promise<T> {
  const saved = identityEnvNow();
  process.env.GIT_AUTHOR_NAME = GIT_REPO_FIXTURE_IDENTITY.name;
  process.env.GIT_AUTHOR_EMAIL = GIT_REPO_FIXTURE_IDENTITY.email;
  process.env.GIT_COMMITTER_NAME = GIT_REPO_FIXTURE_IDENTITY.name;
  process.env.GIT_COMMITTER_EMAIL = GIT_REPO_FIXTURE_IDENTITY.email;
  try {
    return await body();
  } finally {
    restoreIdentityEnv(saved);
  }
}

/** The W1-T13830 criterion 6 body: two awaited reservations of task ids, and origin holds both refs. */
async function reserveTwoTaskIdsOffTheLoop(t: TestContext): Promise<void> {
  const parent = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t13830-reserve-`));
  const { origin, clone } = originWithClone(join(parent, "work"), { seed: PLAN_SEED });
  try {
    clone.git("config", "user.name", "remudero-test");
    clone.git("config", "user.email", "test@remudero.invalid");
    const effects = buildSweepEffects({ owner: "o", repo: "remudero", config: { root: parent } as never,
      ledgerPath: join(parent, "ledger.ndjson"), runId: "t13830", plan: { tasks: [], byId: new Map() } as never,
      log: () => {}, policy: DEFAULT_SWEEP_POLICY, repoRoot: clone.dir });
    const recorder = syncSpawnRecorder(t);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      await withFixtureIdentity(async () => {
        recorder.arm(true);
        const pending = effects.parkedPr!.reserveTaskId({ owner: "o", repo: "remudero", checkoutDir: clone.dir });
        recorder.arm(false);
        assert.ok(pending instanceof Promise, "the host's reservation is awaited");
        const before = ticks;
        recorder.arm(true);
        const id = await pending;
        recorder.arm(false);
        assert.ok(ticks > before, "an interval timer fired while the reservation was pending");
        assert.match(id, /^W1-T\d+$/);
        assert.ok(origin.git("rev-parse", taskIdReservationRef(id)).trim(), "origin holds the reservation ref");
        assert.deepEqual(recorder.calls, [], "the reservation reached no synchronous child process");

        // The same reservation over a git runner that resolves only after a timer.
        const slow = (args: string[]) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
          setTimeout(() => execFile("git", ["-C", clone.dir, ...args], { encoding: "utf8" }, (error, stdout, stderr) =>
            resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr })), 5);
        });
        const atStart = ticks;
        const next = await reservePlanRepairTaskIdAsync(clone.dir, "rmd/task-files-landing", slow);
        assert.ok(ticks > atStart, "the timer fired while the slow runner held the reservation");
        assert.notEqual(next, id, "a second reservation takes the next id");
        assert.ok(origin.git("rev-parse", taskIdReservationRef(next)).trim(), "origin holds the second reservation ref");
      });
    } finally {
      clearInterval(timer);
    }
  } finally {
    origin.cleanup();
    rmSync(parent, { recursive: true, force: true });
  }
}

test("W1-T13830 criterion 6: the sweep's parked-PR host reserves the held task id through an awaited reservation", async (t) => {
  await reserveTwoTaskIdsOffTheLoop(t);
});

test("W1-T14309 criterion 1: an empty GIT_AUTHOR_NAME and GIT_COMMITTER_NAME in the runner do not stop the criterion 6 reservations", async (t) => {
  const runner = identityEnvNow();
  process.env.GIT_AUTHOR_NAME = "";
  process.env.GIT_COMMITTER_NAME = "";
  try {
    await reserveTwoTaskIdsOffTheLoop(t);
  } finally {
    restoreIdentityEnv(runner);
  }
});

test("W1-T14309 criterion 2: the identity pin restores each key to its old value and leaves an unset key unset", async () => {
  const runner = identityEnvNow();
  try {
    process.env.GIT_AUTHOR_NAME = "";
    process.env.GIT_COMMITTER_EMAIL = "outer@remudero.invalid";
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    await withFixtureIdentity(async () => {
      for (const k of IDENTITY_KEYS) assert.ok(process.env[k], `${k} is pinned inside the body`);
    });
    assert.equal(process.env.GIT_AUTHOR_NAME, "");
    assert.equal(process.env.GIT_COMMITTER_EMAIL, "outer@remudero.invalid");
    assert.equal("GIT_AUTHOR_EMAIL" in process.env, false, "an unset key is unset again");
    assert.equal("GIT_COMMITTER_NAME" in process.env, false, "an unset key is unset again");
    await assert.rejects(withFixtureIdentity(async () => { throw new Error("body failed"); }), /body failed/);
    assert.equal(process.env.GIT_AUTHOR_NAME, "", "a failed body restores the keys too");
    assert.equal("GIT_AUTHOR_EMAIL" in process.env, false, "a failed body leaves an unset key unset");
  } finally {
    restoreIdentityEnv(runner);
  }
});
