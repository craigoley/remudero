/**
 * W1-T14360 — A FRESHNESS RESTART HELD BY THE MINIMUM LIFETIME IS RELEASED FOR A DECLARED EXPEDITE.
 *
 * 2026-11-22: #20230 (W1-T14296, the inbox-draft index fix) merged 14:06Z, nine minutes into a daemon lifetime. Every
 * `daemon.freshness_decision` after it deferred with `held_by: min_lifetime` although the pressure (21) was over the
 * score limit (18), while each inbox draft still carried a two-million-character plan index. The floor is the operator's
 * 2026-10-17 ruling. Its one new fast path: a pending commit whose own `Remudero-Task:` line names a task whose record
 * declares `expedite: <reason>`, and only while the pressure is already over the limit. Priority is never read.
 *
 * The four criteria fail closed: no trailer, a trailer only in the subject, no expedite, an empty one, an unreadable
 * catalog or a pressure at the limit all leave the hold exactly as on origin/main.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// NAMESPACE imports: the expedite exports do not exist at the merge base, and a named import would fail the whole file
// at load, which reads as "never ran" rather than as a red.
import * as cli from "#src/cli/commands/daemon.js";
import { runDaemon, type DaemonDeps, type DaemonFreshness } from "#src/lib/daemon.js";
import * as judge from "#src/lib/deploy-judge.js";
import * as deployer from "#src/lib/deployer.js";
import { loadPlan, loadPlanFromYaml, type Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const MINUTE = 60_000;
const START = Date.parse("2026-11-22T14:00:00Z");
const LIMIT = judge.DEPLOY_RESTART_SCORE_THRESHOLD.value;
const window = { value: 10 * MINUTE, reason: "measured follow-on boots were 1–10 minutes apart" };
const REASON = "inbox drafts each carry a 2,051,287-character plan index (live cost leak)";
// Production's freshnessRestart rows (plan/policy.yaml): a 4 h staleness horizon and a 3 h minimum lifetime.
const HORIZON_MS = 240 * MINUTE;
const LIFETIME_MS = 180 * MINUTE;

type Change = judge.DeployWorthChange & { tasks?: readonly string[] };
const fix = (tasks?: readonly string[], subject = "fix(inbox): drafts carry the index slice only"): Change =>
  ({ sha: "f".repeat(40), subject, files: ["src/lib/inbox.ts"], ...(tasks ? { tasks } : {}) });

function catalog(yaml: string): Plan {
  return loadPlanFromYaml(yaml, "test-catalog.yaml");
}
const record = (id: string, extra: string) =>
  `- id: ${id}\n  title: t\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n${extra}`;

/** A coalesce input for a young lifetime: `staleMs` of staleness over `horizonMs`, `busy` as given. */
function young(changes: readonly Change[], staleMs: number, busy = true, horizonMs = 60 * MINUTE) {
  const nowMs = 31 * MINUTE;
  const decision = judge.decideFreshnessRestart({
    changes, busy, staleSinceMs: nowMs - staleMs, nowMs, state: { total: 0, scoredShas: [] }, ageHorizonMs: horizonMs,
  });
  return { decision, newSha: "f".repeat(40), lastAdvanceAtMs: 0, staleSinceMs: nowMs - staleMs, nowMs, window, lifetimeStartedAtMs: 0,
    ageHorizonMs: horizonMs };
}
const HELD = (input: ReturnType<typeof young>) =>
  ({ action: "hold", reason: "min_lifetime", heldMs: input.nowMs - input.staleSinceMs, windowEndsAtMs: window.value });

/** The expedite the record declares for `taskId` through the real catalog reader, public catalog only. */
function lookupIn(plan: Plan) {
  return cli.catalogTaskExpedite(() => plan, () => undefined);
}

type Row = { step: string; atMs: number; extra: Record<string, unknown> };

/**
 * One daemon lifetime that boots at START, reads fresh for two minutes, then reads stale with `changes` and a tree that
 * was already behind 280 minutes (staleness 21 of the 18 limit over the 4 h horizon, plus the source floor of 1).
 */
async function oneLifetime(changes: readonly Change[], extra: Partial<DaemonDeps> = {}, staleMinutes = 280) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}expedite-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, record("A", ""));
  let nowMs = START;
  const rows: Row[] = [];
  const summary = await runDaemon(loadPlan(path), {
    // The host-independent memory pins (W1-T12163); this suite's own clock replaces the helper's.
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => () => true,
    runOne: async (taskId) => ({ taskId, runId: "unused", merged: true, costUsd: 0, verdict: "merged" }),
    now: () => new Date(nowMs),
    sleep: async () => { nowMs += MINUTE; },
    sweep: async () => ({}),
    checkStop: () => (nowMs >= START + 40 * MINUTE ? "forty minutes replayed" : undefined),
    checkFreshness: (): DaemonFreshness => nowMs < START + 2 * MINUTE ? { stale: false }
      : { stale: true, oldSha: "a".repeat(40), newSha: "f".repeat(40), changes, staleSinceMs: START - staleMinutes * MINUTE },
    readLedgerLines: () => [],
    log: (step, row = {}) => rows.push({ step, atMs: nowMs, extra: row }),
    ...extra,
  }, { sweepWallClockBoundMs: 24 * 60 * MINUTE, freshnessStalenessHorizonMs: HORIZON_MS, freshnessMinLifetimeMs: LIFETIME_MS });
  const decisions = rows.filter((row) => row.step === judge.FRESHNESS_DECISION_STEP);
  return { summary, rows, decisions };
}

test("W1-T14360 criterion 1: a young lifetime over the score limit restarts for a pending commit whose task declares an expedite, and the row names the task and the reason", async () => {
  const plan = catalog(record("W1-T900", `  expedite: "${REASON}"\n`));
  // A plain read of the parsed record, so origin/main reaches the decision and shows its own hold.
  const { summary, decisions } = await oneLifetime([fix(["W1-T900"])], {
    taskExpedite: (id: string) => (plan.byId.get(id) as { expedite?: string } | undefined)?.expedite,
  });
  assert.ok(decisions.length > 0, "the control: the lifetime made a freshness decision");
  const first = decisions[0]!.extra;
  assert.ok(Number(first.pressure) > LIMIT, `the control: pressure ${first.pressure} is over the limit ${LIMIT}`);
  assert.ok(Number(first.lifetime_ms) < LIFETIME_MS, "the control: the lifetime is young");
  // On origin/main this row is { action: "defer", reason: "min_lifetime", held_by: "min_lifetime" } until 3 h.
  assert.equal(first.action, "restart", `held: ${JSON.stringify(first)}`);
  assert.equal(first.reason, judge.EXPEDITE_RELEASE);
  assert.equal(first.fast_path, "expedite");
  assert.equal(first.expedite_task_id, "W1-T900");
  assert.equal(first.expedite_reason, REASON);
  assert.equal(first.held_by, undefined);
  assert.equal(summary.stopReason, "stale", "the lifetime ends for the restart, not the replay's stop");

  const input = { ...young([fix(["W1-T900"])], 70 * MINUTE), expedite: { taskId: "W1-T900", reason: REASON } };
  assert.ok(input.decision.pressure > LIMIT);
  assert.deepEqual(judge.coalesceFreshnessRestart(input), {
    action: "restart", reason: "expedite", heldMs: 70 * MINUTE, windowEndsAtMs: window.value,
    expedite: { taskId: "W1-T900", reason: REASON },
  });
  assert.deepEqual(judge.pendingExpedite([fix(), fix(["W1-T1", "W1-T900"])], lookupIn(plan)), { taskId: "W1-T900", reason: REASON },
    "any one named task with a declared expedite is the expedite");
});

test("W1-T14360 criterion 2: the trailer is read from each pending commit's body; a subject, an absent or unreadable trailer, no or empty expedite, an unreadable catalog, or pressure at the limit all hold", async () => {
  const repo = gitRepo({ kind: "expedite-trailers" });
  const commit = (message: string) => { repo.git("commit", "--quiet", "--allow-empty", "-m", message); return repo.git("rev-parse", "HEAD"); };
  const subjectOnly = commit("Remudero-Task: W1-T901");
  // The squash-merge shape: GitHub appends a co-author paragraph after the PR body, so git's own trailer parser,
  // which reads only the LAST paragraph, misses the task line. 95% of src/ commits on main carry it this way.
  const squashed = commit("fix(inbox): x (#20230)\n\nbody\n\nRemudero-Task: W1-T902\n\n---------\n\nCo-authored-by: a <a@b.invalid>");
  const plain = commit("chore: nothing names a task");
  assert.equal(repo.git("log", "-1", "--format=%(trailers:key=Remudero-Task,valueonly)", squashed), "",
    "the control: git's trailer parser misses the squashed line");
  const changes: Change[] = [subjectOnly, squashed, plain].map((sha) => ({ sha, subject: "s", files: ["src/lib/inbox.ts"] }));
  const read = deployer.pendingCommitTaskReader((args) => Promise.resolve(repo.git(...args)));
  const tagged = await read(changes);
  assert.deepEqual(tagged.map((change) => change.tasks), [undefined, ["W1-T902"], undefined]);
  assert.equal("tasks" in tagged[0]!, false, "a subject-only task line names no task");
  assert.equal(tagged[2], changes[2], "a commit with no task line is passed through as it was");
  assert.deepEqual(await deployer.pendingCommitTaskReader(() => Promise.reject(new Error("git: bad object")))(changes), changes,
    "an unreadable trailer leaves every change as it was");

  // The daemon's freshness reading carries the tasks; a reading that is not stale or has no changes is untouched.
  const wrapped = cli.withPendingCommitTasks(async (): Promise<DaemonFreshness> =>
    ({ stale: true, oldSha: "a".repeat(40), newSha: squashed, changes }), (args) => Promise.resolve(repo.git(...args)));
  const freshness = await wrapped();
  assert.ok(freshness.stale);
  assert.deepEqual(freshness.changes?.map((change) => change.tasks), [undefined, ["W1-T902"], undefined]);
  const fresh: DaemonFreshness = { stale: false };
  assert.equal(await cli.withPendingCommitTasks(async () => fresh, () => Promise.reject(new Error("unused")))(), fresh);
  const unread: DaemonFreshness = { stale: true, oldSha: "a", newSha: "b" };
  assert.equal(await cli.withPendingCommitTasks(async () => unread, () => Promise.reject(new Error("unused")))(), unread);
  const untagged: DaemonFreshness = { stale: true, oldSha: "a", newSha: "b", changes: [changes[2]!] };
  assert.equal(await cli.withPendingCommitTasks(async () => untagged, (args) => Promise.resolve(repo.git(...args)))(), untagged,
    "a reading none of whose commits names a task is returned as it was");

  // Each fail-closed input holds exactly as origin/main does.
  const declared = catalog([record("W1-T900", `  expedite: "${REASON}"\n`), record("W1-T903", "  expedite: \"\"\n"),
    record("W1-T904", "  expedite: \"   \"\n"), record("W1-T905", "")].join(""));
  const over = young([fix(["W1-T900"])], 70 * MINUTE);
  const cases: [string, Change[], (id: string) => string | undefined][] = [
    ["no trailer", [fix()], lookupIn(declared)],
    ["a task line only in the subject", [fix(undefined, "fix(inbox): x\nRemudero-Task: W1-T900")], lookupIn(declared)],
    ["an empty expedite", [fix(["W1-T903"])], lookupIn(declared)],
    ["a blank expedite", [fix(["W1-T904"])], lookupIn(declared)],
    ["no expedite", [fix(["W1-T905"])], lookupIn(declared)],
    ["a task in neither catalog", [fix(["W1-T999"])], lookupIn(declared)],
    ["an unreadable catalog", [fix(["W1-T900"])], () => { throw new Error("catalog unreadable"); }],
  ];
  for (const [label, pending, lookup] of cases) {
    const expedite = judge.pendingExpedite(pending, lookup);
    assert.equal(expedite, undefined, label);
    assert.deepEqual(judge.coalesceFreshnessRestart({ ...over, ...(expedite ? { expedite } : {}) }), HELD(over), label);
  }
  const unreadable = cli.catalogTaskExpedite(() => { throw new Error("public catalog unreadable"); }, () => undefined);
  assert.equal(judge.pendingExpedite([fix(["W1-T900"])], unreadable), undefined, "a public catalog that throws holds");

  // The ops catalog counts only when its snapshot is ok; any other outcome holds.
  const opsOnly = cli.catalogTaskExpedite(() => catalog(record("W1-T905", "")), () => ({ outcome: "ok", plan: declared }));
  assert.equal(opsOnly("W1-T900"), REASON, "an ok ops snapshot is read");
  for (const outcome of ["unreadable", "stale", "malformed", "auth_missing"] as const) {
    assert.equal(cli.catalogTaskExpedite(() => catalog(record("W1-T905", "")), () => ({ outcome, plan: declared }))("W1-T900"),
      undefined, outcome);
  }

  // Pressure at the limit, or idle under it: the hold stays, expedite or not.
  const atLimit = young([fix(["W1-T900"])], 57 * MINUTE);
  assert.equal(atLimit.decision.action, "restart", "the control: pressure at the limit restarts a busy daemon");
  assert.equal(atLimit.decision.pressure, LIMIT);
  const idleUnder = young([fix(["W1-T900"])], 5 * MINUTE, false);
  assert.equal(idleUnder.decision.restartTrigger, "idle");
  assert.ok(idleUnder.decision.pressure < LIMIT);
  for (const input of [atLimit, idleUnder]) {
    assert.deepEqual(judge.coalesceFreshnessRestart({ ...input, expedite: { taskId: "W1-T900", reason: REASON } }), HELD(input));
  }

  // The task field itself: a string is kept; any other value is no expedite.
  const parsed = catalog([record("W1-T900", `  expedite: "${REASON}"\n`), record("W1-T906", "  expedite: true\n")].join(""));
  assert.equal(parsed.byId.get("W1-T900")!.expedite, REASON);
  assert.equal("expedite" in parsed.byId.get("W1-T906")!, false);
});

test("W1-T14360 criterion 3: a task's priority, priority 0 included, never releases the hold; only the declared expedite does", async () => {
  const plan = catalog([record("W1-T910", "  priority: 0\n"), record("W1-T911", `  priority: 0\n  expedite: "${REASON}"\n`),
    record("W1-T912", `  priority: 40\n  expedite: "${REASON}"\n`)].join(""));
  const lookup = lookupIn(plan);
  assert.equal(plan.byId.get("W1-T910")!.priority, 0, "the control: the task is P0");
  const over = young([fix(["W1-T910"])], 70 * MINUTE);
  assert.equal(judge.pendingExpedite([fix(["W1-T910"])], lookup), undefined);
  assert.deepEqual(judge.coalesceFreshnessRestart(over), HELD(over));
  const { decisions } = await oneLifetime([fix(["W1-T910"])], { taskExpedite: lookup });
  assert.ok(decisions.length > 0 && decisions.every((row) => row.extra.held_by === "min_lifetime" && row.extra.action === "defer"),
    "a P0 task with no expedite is held through the whole young lifetime");
  assert.ok(decisions.every((row) => row.extra.fast_path === undefined));
  for (const id of ["W1-T911", "W1-T912"]) {
    assert.deepEqual(judge.pendingExpedite([fix([id])], lookup), { taskId: id, reason: REASON }, `${id}: the expedite, at any priority`);
  }
});

/** The rows of a lifetime with every field the decision and the coalesce rows carry. */
const freshnessRows = (rows: readonly Row[]) =>
  rows.filter((row) => row.step === judge.FRESHNESS_DECISION_STEP || row.step === "daemon.freshness_coalesced");

test("W1-T14360 criterion 4: invariant:the-minimum-lifetime-holds-without-a-declared-expedite — with no expedite pending, every freshness decision, reason and held_by are origin/main's", async () => {
  // origin/main's own values for the 2026-10-17 grid (test/a-daemon-lifetime-runs-ninety-minutes-before-a-freshness-restart).
  const none = (id: string) => (id === "W1-T920" ? "" : undefined);
  const grid: [Change[], number, boolean][] = [[[fix()], 31 * MINUTE, true], [[fix(["W1-T920"])], 70 * MINUTE, true],
    [[fix(["W1-T921"])], 70 * MINUTE, false], [[fix(["W1-T920", "W1-T921"])], 57 * MINUTE, true]];
  for (const [changes, staleMs, busy] of grid) {
    const input = young(changes, staleMs, busy);
    const expedite = judge.pendingExpedite(changes, none);
    assert.equal(expedite, undefined);
    const coalesced = judge.coalesceFreshnessRestart({ ...input, ...(expedite ? { expedite } : {}) });
    assert.deepEqual(coalesced, input.decision.action === "defer" ? input.decision : HELD(input));
    assert.equal("expedite" in coalesced, false);
  }
  const aged = { ...young([fix()], 70 * MINUTE), nowMs: 91 * MINUTE, lifetimeStartedAtMs: 0, minLifetimeMs: 90 * MINUTE };
  assert.deepEqual(judge.coalesceFreshnessRestart(aged), { action: "restart", reason: aged.decision.reason, heldMs: 0, windowEndsAtMs: window.value },
    "a grown lifetime still releases on its own reason");

  // A whole young lifetime: commits naming tasks with no expedite, through the daemon's lookup, ledger exactly the rows
  // a lifetime with no task names and no lookup does — the origin/main shape.
  const baseline = await oneLifetime([fix()]);
  const named = await oneLifetime([fix(["W1-T920"]), fix(["W1-T921"])].map((change, i) => ({ ...change, sha: `${i}`.repeat(40) })),
    { taskExpedite: none });
  const baselineTwo = await oneLifetime([fix(), fix()].map((change, i) => ({ ...change, sha: `${i}`.repeat(40) })));
  assert.ok(baseline.decisions.length > 10, `the control: ${baseline.decisions.length} decisions were made`);
  assert.ok(baseline.decisions.every((row) => row.extra.held_by === "min_lifetime"), "the control: every decision is held");
  assert.deepEqual(freshnessRows(named.rows), freshnessRows(baselineTwo.rows));
  assert.equal(named.summary.stopReason, baselineTwo.summary.stopReason);
});
