/**
 * A HELD ID WHOSE HOLDER BRANCH IS GONE GETS THE GATE'S HAND-OFF LINE (W1-T13829).
 *
 * #19604 (head run-unfiled-1795065953000) added three shards whose ids were reserved for run-unfiled-1795065820000,
 * a branch that never reached origin. task-id-existence refused them as "HELD by a different reservation holder" and
 * printed the cure, `reservation hand-off: <holder> -> <filer>`, for each one. The sweep's only held-id rung renumbers
 * fleet heads, so the PR sat red about 5 h until a hand commit added the three lines. The sweep now adds the printed
 * line itself, once per head, when W1-T6026's proof of abandonment holds for every holder.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";

import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { formatReservationAnchorMessage, RESERVATION_PUSH_GRACE_MS, taskIdReservationRef } from "#src/lib/task-id-reservation.js";
import { ciFailureRegionReducer } from "#src/lib/tick-read-worker.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import * as sweep from "#test/helpers/sweep-test.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type CiFailure, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

// The gate's own matcher, read from the script the check runs (it ships no type declarations).
const GATE: string = "#scripts/task-id-existence-check.mjs";
const { shardNoteRecordsReservationHandoff } = (await import(GATE)) as { shardNoteRecordsReservationHandoff(text: string, holder: string, filer: string): boolean };

const NOW = Date.parse("2026-11-19T07:30:00Z");
const HOLDER = "run-unfiled-1795065820000";
const FILER = "run-unfiled-1795065953000";
const IDS = ["W1-T13787", "W1-T13788", "W1-T13789"];
const SHARDS = IDS.map((id) => `plan/tasks.d/${id}-fixture.yaml`);
const HEAD = "b".repeat(40);

/** The gate's own HELD block, as scripts/task-id-existence-check.mjs prints it, with the Actions timestamp prefix. */
function heldLog(entries: Array<{ id: string; file: string; handoff?: string }>): string {
  const stamp = "2026-11-19T05:33:01.1234567Z ";
  const lines = ["task-id-existence: FAILED -- the following added id(s) are HELD by a different reservation holder:", ""];
  for (const e of entries) {
    lines.push(`  ${e.id} -- reserved by ${HOLDER}, while this filing is ${FILER}`, `    ${e.file}:1`);
    if (e.handoff !== undefined) {
      lines.push("    remedy: add this as a NEW line in the shard's note -- do not merge it into any existing note text on the same line, or the check that requires it will not see it:",
        "        note: |", `          ${e.handoff}`);
    }
  }
  lines.push("", "Renumber to a fresh reserved id, or record the operator hand-off in the shard note as `reservation hand-off: <holder> -> <filer>`.");
  return lines.map((l) => stamp + l).join("\n");
}

const handoffLine = `reservation hand-off: ${HOLDER} -> ${FILER}`;
const fullLog = heldLog(IDS.map((id, i) => ({ id, file: SHARDS[i]!, handoff: handoffLine })));

function failure(logTail: string): CiFailure {
  return { name: "task-id-existence", logTail, conclusion: "FAILURE" };
}

function planPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 19604,
    prUrl: "https://github.com/acme/remudero/pull/19604",
    reviewState: "pending",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: HEAD,
    headRefName: FILER,
    autoMergeArmed: false,
    isPlanFiling: true,
    planFilingSource: "github-files",
    ciFailures: [failure(fullLog)],
    body: `Files ${IDS.join(", ")}.`,
    ...over,
  };
}

test("W1-T13829 criterion 1: only the gate's printed hand-off line for this head as filer gives a hand-off decision", () => {
  const decision = sweep.decidePlanRepair(planPr(), {}, undefined, new Set());
  assert.deepEqual(decision, {
    signature: "held-task-id-handoff", action: "handoff", check: "task-id-existence",
    handoffs: IDS.map((id, i) => ({ id, holder: HOLDER, filer: FILER, files: [SHARDS[i]!] })),
  });
  const none = (logTail: string, over: Partial<OpenPrView> = {}) =>
    assert.notEqual(sweep.decidePlanRepair(planPr({ ciFailures: [failure(logTail)], ...over }), {}, undefined, new Set())?.action, "handoff");
  // A held id with no printed line: the gate gave no cure for it, so nothing is handed off.
  none(heldLog([{ id: IDS[0]!, file: SHARDS[0]!, handoff: handoffLine }, { id: IDS[1]!, file: SHARDS[1]! }]));
  const firstJob = heldLog([{ id: IDS[0]!, file: SHARDS[0]! }]).split("\n").slice(0, 4).join("\n");
  none(firstJob, { ciFailures: [failure(firstJob), { ...failure(`          ${handoffLine}`), name: "another-job" }] });
  none(firstJob, { ciFailures: [failure(firstJob.split("\n")[0]!), { ...failure(fullLog), name: "another-job" }] });
  none(`${firstJob}\n##[error]Process completed with exit code 1.\n          ${handoffLine}`);
  // A printed line whose filer is another branch is not this PR's cure.
  none(heldLog([{ id: IDS[0]!, file: SHARDS[0]!, handoff: `reservation hand-off: ${HOLDER} -> run-unfiled-1` }]));
  // A collision or an open-PR claim has no hand-off cure.
  for (const header of ["ALREADY DECLARED", "ALREADY CLAIMED by another OPEN PR"]) {
    none(`${fullLog}\ntask-id-existence: FAILED -- the following added id(s) are ${header}:\n  W1-T13789 -- declared at base\n    plan/tasks.d/W1-T13789-x.yaml:1`);
  }
  // Not a plan filing, or the attempt at this head is spent.
  none(fullLog, { isPlanFiling: false });
  assert.equal(sweep.decidePlanRepair(planPr(), {}, undefined, new Set([`19604@${HEAD}@held-task-id-handoff`])), undefined);
});

interface Fixture {
  remote: GitRepo;
  host: GitRepo;
  headSha: string;
  readJson: (args: string[]) => Promise<unknown>;
  hooksDir: string;
}

const SHARD_TEXTS = [
  `- id: ${IDS[0]}\n  title: "a fixture shard — no note"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: low # a comment\n  status: queued\n`,
  `- id: ${IDS[1]}\n  title: a fixture shard with a note\n  repo: remudero\n  note: filed by hand\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n`,
  `- id: ${IDS[2]}\n  title: another fixture shard\n  repo: remudero\n  status: queued\n`,
];

/** A bare origin holding main, the filing branch and the two reservations; the daemon's checkout of it. */
function fixture(t: TestContext, opts: {
  startedAgoMs: number;
  holderOnOrigin?: boolean;
  openPrOnHolder?: boolean;
  unreadableOpenPr?: boolean;
  texts?: string[];
}): Fixture {
  const remote = gitRepo({ bare: true, scope: t, kind: "t13829-remote" });
  const seed = gitRepo({ cloneFrom: remote.dir, scope: t, kind: "t13829-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  seed.git("add", "plan");
  seed.git("commit", "-m", "chore: seed the plan");
  seed.git("push", "--quiet", "origin", "HEAD:main");
  const startedAt = new Date(NOW - opts.startedAgoMs).toISOString();
  const tree = seed.git("rev-parse", "HEAD^{tree}");
  for (const id of IDS) {
    const claim = seed.git("commit-tree", tree, "-m", formatReservationAnchorMessage({ branch: HOLDER, startedAt }));
    seed.git("push", "--quiet", "origin", `${claim}:refs/rmd-id/${id}`);
  }
  if (opts.holderOnOrigin) seed.git("push", "--quiet", "origin", `HEAD:refs/heads/${HOLDER}`);
  seed.git("checkout", "--quiet", "-b", FILER);
  const texts = opts.texts ?? SHARD_TEXTS;
  texts.forEach((text, i) => writeFileSync(join(seed.dir, SHARDS[i]!), text));
  seed.git("add", "plan");
  seed.git("commit", "-m", "chore(plan): file three tasks");
  seed.git("push", "--quiet", "origin", FILER);
  const headSha = seed.git("rev-parse", "HEAD");
  const host = gitRepo({ cloneFrom: remote.dir, scope: t, kind: "t13829-host" });
  host.git("config", "user.name", "remudero test fixture");
  host.git("config", "user.email", "fixture@remudero.invalid");
  const rows = opts.openPrOnHolder || opts.unreadableOpenPr
    ? [{ number: 19600, html_url: "https://github.com/acme/remudero/pull/19600", state: "open", title: "x", body: "", updated_at: "2026-11-19T05:00:00Z", head: { ref: opts.unreadableOpenPr ? undefined : HOLDER, sha: "c".repeat(40) } }]
    : [];
  const hooksDir = join(ownedFixtureDir(t, "t13829-effects").dir, "hooks");
  mkdirSync(hooksDir);
  return { remote, host, headSha, readJson: async () => rows, hooksDir };
}

let cuts = 0;
async function withFixtureHooks<T>(f: Fixture, run: () => Promise<T>): Promise<T> {
  const saved = process.env.RMD_HARNESS_HOOKS_DIR;
  process.env.RMD_HARNESS_HOOKS_DIR = f.hooksDir;
  try {
    return await withLiveWritesAllowed(run);
  } finally {
    if (saved === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
    else process.env.RMD_HARNESS_HOOKS_DIR = saved;
  }
}

function handOff(f: Fixture, pr: OpenPrView, git?: typeof hostWorktreeGitAsync) {
  const handoffs = IDS.map((id, i) => ({ id, holder: HOLDER, filer: FILER, files: [SHARDS[i]!] }));
  return withFixtureHooks(f, () => sweep.handOffHeldPlanPrIds(pr, handoffs, f.host.dir, join(dirname(f.hooksDir), `wt-${++cuts}`), {
    owner: "acme", repo: "remudero", log: () => {}, readJson: f.readJson, nowMs: () => NOW, git,
  }));
}

test("W1-T13829 criterion 2: no hand-off while the holder branch exists, heads an open PR, or its reservation is young", async (t) => {
  const cases: Array<[string, Parameters<typeof fixture>[1], RegExp]> = [
    ["a 30-minute-old reservation", { startedAgoMs: 30 * 60_000 }, /reservation of W1-T13787 started at .* older than 2 h/],
    ["a reservation exactly at the grace period", { startedAgoMs: RESERVATION_PUSH_GRACE_MS }, /reservation of W1-T13787 started at .* older than 2 h/],
    ["a holder branch on origin", { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, holderOnOrigin: true }, new RegExp(`holder branch ${HOLDER} of W1-T13787 is on origin`)],
    ["an open PR on the holder branch", { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, openPrOnHolder: true }, /open PR #19600 has holder branch/],
    ["an unreadable open PR head", { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, unreadableOpenPr: true }, /open PR #19600 has an unreadable head ref/],
  ];
  for (const [name, opts, reason] of cases) {
    const f = fixture(t, opts);
    const out = await handOff(f, planPr({ headSha: f.headSha }));
    assert.equal(out.outcome, "stood-down", `${name}: ${JSON.stringify(out)}`);
    assert.match(out.reason ?? "", reason, name);
    assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), f.headSha, `${name}: nothing was pushed`);
  }
});

test("W1-T13829 criterion 2: a reservation moved during fetch cannot be proved old from a cached anchor", async (t) => {
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000 });
  const ref = taskIdReservationRef(IDS[0]!);
  f.host.git("fetch", "--no-write-fetch-head", "origin", ref);
  const tree = f.remote.git("rev-parse", "refs/heads/main^{tree}");
  const recent = f.remote.git("commit-tree", tree, "-m", formatReservationAnchorMessage({ branch: HOLDER, startedAt: new Date(NOW).toISOString() }));
  let moved = false;
  const out = await handOff(f, planPr({ headSha: f.headSha }), async (cwd, args) => {
    if (args[0] === "fetch" && args.at(-1) === ref) {
      f.remote.git("update-ref", ref, recent);
      moved = true;
    }
    return hostWorktreeGitAsync(cwd, args);
  });
  assert.equal(moved, true);
  assert.equal(out.outcome, "stood-down", JSON.stringify(out));
  assert.match(out.reason ?? "", /reservation of W1-T13787 changed while it was being read/);
  assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), f.headSha);
});

test("W1-T13829 criterion 3: the line is added as its own note line per named shard, in one commit pushed with a lease", async (t) => {
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000 });
  const out = await handOff(f, planPr({ headSha: f.headSha }));
  assert.equal(out.outcome, "handed-off", JSON.stringify(out));
  const head = f.remote.git("rev-parse", `refs/heads/${FILER}`);
  assert.equal(head, out.newHeadSha, "the commit landed on the PR head");
  assert.equal(f.remote.git("rev-parse", `${head}^`), f.headSha, "one commit on the observed head");
  assert.equal(f.remote.git("diff", "--name-only", f.headSha, head), SHARDS.join("\n"), "only the named shards changed");
  const after = SHARDS.map((path) => f.remote.git("show", `${head}:${path}`) + "\n");
  assert.equal(after[0], `${SHARD_TEXTS[0]}  note: |\n    ${handoffLine}\n`, "a shard with no note gets a block-scalar note");
  assert.equal(after[1], SHARD_TEXTS[1]!.replace("  note: filed by hand\n", `  note: |\n    filed by hand\n    ${handoffLine}\n`), "existing note text is kept");
  for (const [i, text] of after.entries()) {
    const [task] = parseYaml(text) as Array<Record<string, unknown>>;
    assert.equal(task!.id, IDS[i], "the shard still parses");
    assert.equal(shardNoteRecordsReservationHandoff(text, HOLDER, FILER), true, "the gate's matcher accepts the line");
  }
  // The lease is on the head the sweep observed: a moved head is not written.
  const moved = await handOff(f, planPr({ headSha: f.headSha }));
  assert.equal(moved.outcome, "lease-mismatch", JSON.stringify(moved));
  assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), head);
});

test("W1-T13829 criterion 3: a literal note keeps its header, indentation and trailing blank lines", async (t) => {
  const header = "  note: |4+ # keep these blank lines\n";
  const prior = `${header}      filed by hand\n\n\n`;
  const texts = SHARD_TEXTS.map((text) => text.replace("  note: filed by hand\n", prior));
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, texts });
  const out = await handOff(f, planPr({ headSha: f.headSha }));
  assert.equal(out.outcome, "handed-off", JSON.stringify(out));
  const after = f.remote.git("show", `${out.newHeadSha}:${SHARDS[1]}`) + "\n";
  assert.equal(after, texts[1]!.replace(prior, `${prior}      ${handoffLine}\n`));
  const [task] = parseYaml(after) as Array<Record<string, unknown>>;
  assert.equal(task!.note, `filed by hand\n\n\n${handoffLine}\n`);
  assert.equal(shardNoteRecordsReservationHandoff(after, HOLDER, FILER), true);
});

test("W1-T13829 criterion 5: the real sweep repairs all three shards when the CI excerpt drops the HELD header", async (t) => {
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000 });
  const lines = `${fullLog}\n2026-11-19T05:33:02.1234567Z ##[error]Process completed with exit code 1.`.split("\n");
  const reducer = ciFailureRegionReducer(60);
  for (const line of lines) reducer.push(line);
  const logTail = reducer.finish();
  assert.doesNotMatch(logTail, /HELD by a different reservation holder/);
  assert.doesNotMatch(logTail, /W1-T13787/);
  assert.match(logTail, /W1-T13789/);
  const pr = planPr({ headSha: f.headSha, ciFailures: [{ ...failure(logTail), jobId: "12345" }] });
  const root = dirname(f.hooksDir);
  const ledger: Record<string, unknown>[] = [];
  const readErrors: unknown[] = [];
  let logUnavailable = true;
  const effects = sweep.buildSweepEffects({
    owner: "acme", repo: "remudero", repoRoot: f.host.dir, config: { root, claudeBin: "/bin/true" },
    ledgerPath: join(root, "ledger.ndjson"), runId: "W1-T13829-test", plan: { tasks: [], byId: new Map() },
    log: (step, fields) => { if (step === `${sweep.PLAN_REPAIR_STEP}.read_error`) readErrors.push(fields?.error); },
    nowMsImpl: () => NOW, ciGateRequired: [],
    readPlanRepairLogImpl: async (args, onLine) => {
      assert.deepEqual(args, ["api", "repos/acme/remudero/actions/jobs/12345/logs"]);
      lines.forEach(onLine);
      if (logUnavailable) throw new Error("connection closed before the job log completed");
    },
    readJsonImpl: async (args, opts) => {
      assert.match(args[1]!, /pulls\?state=open/);
      assert.equal(opts?.fresh, true);
      return f.readJson(args);
    },
  } as Parameters<typeof sweep.buildSweepEffects>[0]);
  const deps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, postReview: async () => {},
    readPlanRepairFacts: effects.readPlanRepairFacts, repairPlanPr: effects.repairPlanPr,
    ledgerPath: "/dev/null/w1-t13829.ndjson", runId: "W1-T13829-test",
    readLedger: () => ledger, appendLine: (_path: string, line: Record<string, unknown>) => { ledger.push(line); },
    now: () => NOW,
  } as unknown as SweepDeps;
  const incomplete = await effects.readPlanRepairFacts!(pr, "12345");
  assert.deepEqual(readErrors, ["Error: connection closed before the job log completed"]);
  assert.equal(sweep.decidePlanRepair(pr, incomplete, undefined, new Set()), undefined);
  logUnavailable = false;
  await withFixtureHooks(f, () => runSweep([pr], deps, DEFAULT_SWEEP_POLICY));
  const head = f.remote.git("rev-parse", `refs/heads/${FILER}`);
  assert.equal(f.remote.git("rev-parse", `${head}^`), f.headSha);
  assert.equal(f.remote.git("diff", "--name-only", f.headSha, head), SHARDS.join("\n"));
  assert.equal(ledger.find((row) => row.step === sweep.PLAN_REPAIR_STEP)?.outcome, "handed-off");
});

test("W1-T13829 criterion 4: a failed push and a stand-down each spend one attempt at their head", async () => {
  const ledger: Record<string, unknown>[] = [];
  const calls: Array<Record<string, unknown>> = [];
  let answer: { outcome: string; reason?: string } = { outcome: "error", reason: "the push was refused" };
  const deps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, postReview: async () => {},
    readPlanRepairFacts: () => ({}),
    repairPlanPr: (_pr: OpenPrView, decision: Record<string, unknown>) => { calls.push(decision); return answer; },
    ledgerPath: "/dev/null/w1-t13829.ndjson", runId: "W1-T13829-test",
    readLedger: () => ledger, appendLine: (_path: string, line: Record<string, unknown>) => { ledger.push(line); },
    now: () => NOW,
  } as unknown as SweepDeps;
  const rows = () => ledger.filter((l) => l.step === sweep.PLAN_REPAIR_STEP && l.signature === "held-task-id-handoff");
  await runSweep([planPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(calls.length, 1, "the hand-off was attempted");
  assert.equal(calls[0]!.action, "handoff");
  assert.equal(rows().length, 1);
  assert.equal(rows()[0]!.outcome, "error", "the failed push is ledgered");
  await runSweep([planPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(calls.length, 1, "a failed push is not retried at the same head");
  assert.equal(rows().length, 1, "and ledgered once");
  answer = { outcome: "stood-down", reason: "the reservation of W1-T13787 started at 2026-11-19T07:00:00.000Z, less than 2 h ago" };
  const other = planPr({ headSha: "d".repeat(40) });
  await runSweep([other], deps, DEFAULT_SWEEP_POLICY);
  await runSweep([other], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(calls.length, 2, "the stand-down is not retried at the same head");
  assert.equal(rows().find((r) => r.head_sha === other.headSha)?.outcome, "stood-down");
  assert.equal(rows().filter((r) => r.head_sha === other.headSha).length, 1, "the stand-down is ledgered once");
  assert.equal(sweep.planRepairHistoryFromLedger(ledger).has(`19604@${other.headSha}@held-task-id-handoff`), true);
  assert.equal(sweep.planRepairHistoryFromLedger(ledger).has(`19604@${HEAD}@held-task-id-handoff`), true);
});
