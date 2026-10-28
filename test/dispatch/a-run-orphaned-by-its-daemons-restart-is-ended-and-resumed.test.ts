/**
 * W1-T10896 — A RUN ORPHANED BY ITS DAEMON'S IN-PLACE RESTART IS ENDED AND RESUMED.
 *
 * MEASURED 2026-10-28: the daemon container restarted in place (same hostname). W1-T10838's run had pushed
 * its branch, and its claim anchor named this host, minted before the new PID namespace booted, with an absent
 * pid. The boot sweep supplied only the replaced-container probe, so the claim fell to the operator arm, the
 * run never got a verdict, and its pushed branch blocked dispatch for the 24 h orphan grace.
 *
 * These cases run the boot sweep `rmd daemon` calls after taking its lock, with its real /proc liveness probe and
 * its real ledger reads; the resume case reads the pushed head through a real git remote.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import {
  bootSweepDispatchClaims,
  dispatchClaimRef,
  gitDispatchClaimReserver,
  readRunLedgerState,
  runBranchHeadFromLsRemote,
  type ClaimAnchorIdentity,
  type DispatchClaimReserver,
  type GitAnswer,
} from "#src/lib/dispatch-claim.js";
import { appendLedger } from "#src/lib/ledger.js";
import { makeTempDir } from "#src/lib/tmp.js";
import {
  CHECKPOINT_HANDOFF_REASONS,
  pendingWorkerBoundaryHandoffs,
  runBranchDispatchOpts,
  runBranchStateFrom,
} from "#src/lib/daemon.js";
import { dispatchesWithoutNewOwnedPr } from "#src/lib/status.js";
import { readBreakerStrikes } from "#src/lib/breaker-release.js";
import { streakRefusal } from "#src/lib/non-worker-verdict.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

const TASK = "W1-T10838";
const RUN_ID = `${TASK}-946684799000`;
const BRANCH = `run-${RUN_ID}`;
const HEAD = `4cefc7ba3${"0".repeat(31)}`;
/** Minted long before any namespace this test can run in booted. */
const MINT_ISO = "2000-01-01T00:00:00.000Z";
/** No Linux pid reaches this (pid_max is at most 2^22). */
const DEAD_PID = 2_147_483_646;
const LOCAL = hostname();
const OTHER_HOST = "0123456789ab";

function anchorMessage(pid: number, host: string, iso: string): string {
  return `rmd-dispatch claim ${pid}@${host} ${iso}`;
}

/** The orphaned run's own rows: its start, the claim it minted, and the work it finished. */
function orphanRunRows(taskId = TASK, runId = RUN_ID, host = LOCAL): Array<Record<string, unknown>> {
  return [
    { ts: "1999-12-31T23:59:59.000Z", run_id: runId, task_id: taskId, step: "run.start", host },
    { ts: "2000-01-01T00:00:00.500Z", run_id: runId, task_id: taskId, step: "dispatch.claim", host, actor: "run_child",
      ref: dispatchClaimRef(taskId), outcome: "created" },
    { ts: "2000-01-01T00:30:00.000Z", run_id: runId, task_id: taskId, step: "implement.done", host },
  ];
}

function fakeReserver(
  claims: Record<string, string>,
  opts: { keepOnDrop?: boolean; heads?: Record<string, string> } = {},
): DispatchClaimReserver & { dropped: string[]; askedHeads: string[] } {
  const dropped: string[] = [];
  const askedHeads: string[] = [];
  return {
    dropped,
    askedHeads,
    mintAnchor: () => "anchor",
    attempt: () => "taken",
    holder: (taskId) => (claims[taskId] !== undefined ? `sha-${taskId}` : undefined),
    drop: (taskId) => {
      dropped.push(taskId);
      if (!opts.keepOnDrop) delete claims[taskId];
      return true;
    },
    anchorMessage: (taskId) => claims[taskId],
    list: () => Object.keys(claims),
    branchHead: (branch) => {
      askedHeads.push(branch);
      return opts.heads?.[branch];
    },
  };
}

interface Instance {
  stateDir: string;
  boot: (reserver: DispatchClaimReserver) => void;
  rawLines: () => string[];
  rows: () => Array<Record<string, unknown>>;
}

/** One instance's state directory, booted the way `rmd daemon` boots: its log stamps the daemon's run id and
 *  lets a row's own `run_id`/`task_id` override them. */
function instance(t: TestContext, seed: Array<Record<string, unknown>>): Instance {
  const stateDir = makeTempDir("restart-orphan");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledger = join(stateDir, "ledger.ndjson");
  writeFileSync(ledger, seed.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const rawLines = () => readFileSync(ledger, "utf8").split("\n").filter(Boolean);
  let boots = 0;
  return {
    stateDir,
    rawLines,
    rows: () => rawLines().map((line) => JSON.parse(line) as Record<string, unknown>),
    boot: (reserver) => {
      const runId = `DAEMON-${++boots}`;
      const lockIso = new Date().toISOString();
      bootSweepDispatchClaims(reserver, {
        localHost: LOCAL,
        lockHeldSinceMs: Date.parse(lockIso),
        lockHeldSinceIso: lockIso,
        stateDir,
        log: (step, fields) => appendLedger(ledger, { run_id: runId, task_id: "DAEMON", step, lane: "daemon", ...fields }),
      });
    },
  };
}

/** A real bare remote holding the orphan's claim and its pushed run branch, read through the real git reserver. */
function gitRemote(t: TestContext): { reserver: DispatchClaimReserver; head: string; claimTip: () => string } {
  const remote = gitRepo({ bare: true, scope: t });
  const client = gitRepo({ scope: t });
  client.addRemote("origin", remote.dir);
  const tree = client.git("rev-parse", "HEAD^{tree}");
  const anchor = client.git("commit-tree", tree, "-m", anchorMessage(DEAD_PID, LOCAL, MINT_ISO));
  client.git("push", "origin", `${anchor}:${dispatchClaimRef(TASK)}`);
  const head = client.git("commit-tree", tree, "-p", "HEAD", "-m", "the orphan's finished work");
  client.git("push", "origin", `${head}:refs/heads/${BRANCH}`);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const run = (args: string[]): GitAnswer => {
    const r = spawnSync("git", args, { cwd: client.dir, env, encoding: "utf8", timeout: 10_000 });
    return { status: r.status ?? 128, stdout: r.stdout, stderr: r.stderr };
  };
  return { reserver: gitDispatchClaimReserver({ run }), head, claimTip: () => client.git("ls-remote", "origin", dispatchClaimRef(TASK)) };
}

const sweepRows = (rows: Array<Record<string, unknown>>) =>
  rows.filter((r) => r.step === "dispatch.claim_released" && r.surface === "boot-sweep");
const orphanVerdicts = (rows: Array<Record<string, unknown>>) =>
  rows.filter((r) => r.step === "verdict" && r.reason === "orphaned-by-restart");

test("W1-T10896: a same-host claim minted before an in-place restart is released at boot", (t) => {
  const live = new Date(Date.now() + 60_000).toISOString();
  const node = instance(t, orphanRunRows());
  const reserver = fakeReserver({
    [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO),
    // CONTROLS. A claim minted AFTER this namespace booted belongs to a run of this namespace, and a claim whose
    // pid is still present has a claimant; neither is released.
    "W1-T1": anchorMessage(DEAD_PID, LOCAL, live),
    "W1-T2": anchorMessage(process.pid, LOCAL, MINT_ISO),
  });
  node.boot(reserver);
  assert.deepEqual(reserver.dropped, [TASK]);
  const swept = new Map(sweepRows(node.rows()).map((r) => [r.ref, r]));
  const released = swept.get(dispatchClaimRef(TASK))!;
  assert.equal(released.arm, "dead-claimant");
  assert.equal(released.release, true);
  assert.equal(released.dropped, true);
  assert.match(String(released.reason), /BEFORE this host's PID namespace started/);
  for (const kept of ["W1-T1", "W1-T2"]) {
    assert.equal(swept.get(dispatchClaimRef(kept))?.arm, "operator", `${kept} is not provably dead`);
    assert.equal(swept.get(dispatchClaimRef(kept))?.release, false);
  }
});

test("W1-T10896: a cross-host claim is still left to the operator at boot", (t) => {
  // Another host's lane: this instance's ledger never recorded minting the claim, so W1-T5047's replaced-container
  // proof is absent too, and nothing but the anchor's own fields is known.
  const node = instance(t, orphanRunRows(TASK, RUN_ID, OTHER_HOST).filter((r) => r.step !== "dispatch.claim"));
  // The same boot releases a same-host sibling, so the cross-host claim is kept by the host clause alone.
  const reserver = fakeReserver({
    [TASK]: anchorMessage(DEAD_PID, OTHER_HOST, MINT_ISO),
    "W1-T3": anchorMessage(DEAD_PID, LOCAL, MINT_ISO),
  }, { heads: { [BRANCH]: HEAD } });
  node.boot(reserver);
  assert.deepEqual(reserver.dropped, ["W1-T3"]);
  const swept = new Map(sweepRows(node.rows()).map((r) => [r.ref, r]));
  const kept = swept.get(dispatchClaimRef(TASK))!;
  assert.equal(kept.arm, "operator");
  assert.equal(kept.release, false);
  assert.match(String(kept.reason), /Cross-host liveness is not decidable/);
  assert.equal(swept.get(dispatchClaimRef("W1-T3"))?.arm, "dead-claimant");
  assert.deepEqual(orphanVerdicts(node.rows()), [], "a claim kept for the operator ends no run");
});

test("W1-T10896: a run orphaned by the restart gets one orphaned-by-restart verdict", (t) => {
  const node = instance(t, orphanRunRows());
  // The drop "succeeds" but the claim reappears, so the second boot meets the same dead claim again.
  const claims = { [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO) };
  node.boot(fakeReserver(claims, { keepOnDrop: true }));
  const first = orphanVerdicts(node.rows());
  assert.equal(first.length, 1);
  const verdict = first[0]!;
  assert.equal(verdict.run_id, RUN_ID, "the verdict ends the orphaned run, not the daemon's own run");
  assert.equal(verdict.task_id, TASK);
  assert.equal(verdict.verdict, "handed_off");
  assert.equal(verdict.claim_ref, dispatchClaimRef(TASK));
  assert.equal(verdict.claim_anchor, `${DEAD_PID}@${LOCAL} ${MINT_ISO}`);
  assert.match(String(verdict.namespace_boot), /^\d{4}-\d\d-\d\dT/);
  assert.equal(CHECKPOINT_HANDOFF_REASONS.has(String(verdict.reason)), true, "its reason is a checkpoint handoff reason");
  // No branch on origin, so no head is provable.
  assert.equal(verdict.branch, undefined, "an unprovable head carries no receipt");
  assert.equal(verdict.head_sha, undefined);

  node.boot(fakeReserver(claims, { keepOnDrop: true }));
  assert.equal(sweepRows(node.rows()).filter((r) => r.arm === "dead-claimant").length, 2, "the second boot judged it again");
  assert.equal(orphanVerdicts(node.rows()).length, 1, "a second boot writes no second verdict");

  // Rotate the sole verdict beyond the mint lookup's first three archives, then boot again.
  const rows = node.rows();
  writeFileSync(join(node.stateDir, "ledger.2000-01-01T00-01-00-000Z.ndjson"),
    orphanRunRows().map((row) => `${JSON.stringify(row)}\n`).join(""));
  for (const minute of [2, 3]) {
    writeFileSync(join(node.stateDir, `ledger.2000-01-01T00-0${minute}-00-000Z.ndjson`), "");
  }
  for (const compressed of [false, true]) {
    const archive = join(node.stateDir, `ledger.2000-01-02T00-00-00-000Z.ndjson${compressed ? ".gz" : ""}`);
    const history = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
    writeFileSync(archive, compressed ? gzipSync(history) : history);
    writeFileSync(join(node.stateDir, "ledger.ndjson"), "");
    node.boot(fakeReserver(claims, { keepOnDrop: true }));
    assert.equal(sweepRows(node.rows())[0]?.dropped, true, "the archived verdict does not prevent claim release");
    assert.equal(orphanVerdicts(rows).length + orphanVerdicts(node.rows()).length, 1,
      `a boot with the verdict in the fourth ${compressed ? "gzip" : "plain"} archive writes no duplicate`);
    rmSync(archive);
  }
});

test("W1-T10896: the orphaned run pushed head resumes instead of blocking dispatch", (t) => {
  // The claim and the pushed branch live on a real remote, read through the git reserver the daemon uses.
  const origin = gitRemote(t);
  const resumed = `${origin.head}\trefs/heads/${BRANCH}\n`;
  const blocked = (lines: readonly string[]) =>
    runBranchDispatchOpts(runBranchStateFrom(resumed, undefined, pendingWorkerBoundaryHandoffs(lines)), [], () => {})
      .hasPushedRunBranch!(TASK);
  const node = instance(t, orphanRunRows());
  assert.equal(blocked(node.rawLines()), true, "before the boot sweep the pushed branch blocks dispatch");

  node.boot(origin.reserver);
  assert.equal(origin.claimTip(), "", "the dead claim is dropped from origin");
  const verdict = orphanVerdicts(node.rows())[0]!;
  assert.equal(verdict.branch, BRANCH);
  assert.equal(verdict.head_sha, origin.head, "the receipt names origin's exact pushed head");
  assert.equal(blocked(node.rawLines()), false, "the exact pushed head is a resumable checkpoint");
  const pending = pendingWorkerBoundaryHandoffs(node.rawLines());
  assert.deepEqual(pending.get(TASK), { branch: BRANCH, headSha: origin.head });
  // A re-push moves the tip off the receipt, so that head blocks again.
  const moved = `${"f".repeat(40)}\trefs/heads/${BRANCH}\n`;
  assert.equal(runBranchDispatchOpts(runBranchStateFrom(moved, undefined, pending), [], () => {}).hasPushedRunBranch!(TASK), true);
});

test("W1-T10896: a run that already opened its PR gets the verdict without a resume receipt", (t) => {
  const prUrl = "https://github.com/o/r/pull/1";
  const seed = [...orphanRunRows(), { ts: "2000-01-01T00:40:00.000Z", run_id: RUN_ID, task_id: TASK, step: "pr.opened", pr_url: prUrl }];
  const node = instance(t, seed);
  const reserver = fakeReserver({ [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO) }, { heads: { [BRANCH]: HEAD } });
  node.boot(reserver);
  const verdict = orphanVerdicts(node.rows())[0]!;
  assert.equal(verdict.pr_url, prUrl);
  assert.equal(verdict.head_sha, undefined);
  assert.deepEqual(reserver.askedHeads, [], "a run with its own PR is not resumed from its branch");
  assert.equal(pendingWorkerBoundaryHandoffs(node.rawLines()).get(TASK), undefined);
});

test("W1-T10896: a released claim whose run already ended or never started writes no verdict", (t) => {
  const ended = [...orphanRunRows(), { ts: "2000-01-01T00:50:00.000Z", run_id: RUN_ID, task_id: TASK, step: "verdict", verdict: "failed" }];
  const node = instance(t, ended);
  node.boot(fakeReserver({ [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO) }));
  assert.deepEqual(orphanVerdicts(node.rows()), []);

  const unstarted = instance(t, orphanRunRows().filter((r) => r.step !== "run.start"));
  unstarted.boot(fakeReserver({ [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO) }));
  assert.equal(sweepRows(unstarted.rows())[0]!.dropped, true, "the dead claim is still released");
  assert.deepEqual(orphanVerdicts(unstarted.rows()), [], "no run.start, no run to end");
});

test("W1-T10896: an orphaned-by-restart verdict is not a worker strike", (t) => {
  const node = instance(t, orphanRunRows());
  assert.equal(dispatchesWithoutNewOwnedPr(node.rows(), TASK), 1, "with no verdict the run counts against the breaker");
  node.boot(fakeReserver({ [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO) }));
  const verdict = orphanVerdicts(node.rows())[0]!;
  assert.notEqual(streakRefusal(verdict), undefined, "the breaker excludes the verdict by name");
  assert.equal(dispatchesWithoutNewOwnedPr(node.rows(), TASK), 0);
  const strikes = readBreakerStrikes(node.rows(), TASK).strikes;
  assert.deepEqual(strikes.map((s) => s.runId), [RUN_ID]);
  assert.notEqual(strikes[0]!.cause, undefined, "the run is classified as not the worker's");
});

test("W1-T10896: the run ledger reader and the branch head parser fail closed", (t) => {
  const dir = makeTempDir("restart-orphan-ledger");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const anchor: ClaimAnchorIdentity = { pid: DEAD_PID, host: LOCAL, mintedAtMs: Date.parse(MINT_ISO), mintedAtIso: MINT_ISO };
  writeFileSync(join(dir, "ledger.ndjson"), `{torn ${RUN_ID}\n${orphanRunRows().map((r) => JSON.stringify(r)).join("\n")}\n`);
  assert.deepEqual(readRunLedgerState(dir, RUN_ID, anchor), { started: true, verdict: false });
  assert.deepEqual(readRunLedgerState(join(dir, "absent"), RUN_ID, anchor), { started: false, verdict: false });

  const [start, ...afterStart] = orphanRunRows();
  writeFileSync(join(dir, "ledger.1999-12-31T23-59-59-500Z.ndjson.gz"), gzipSync(`${JSON.stringify(start)}\n`));
  writeFileSync(join(dir, "ledger.ndjson"), afterStart.map((row) => `${JSON.stringify(row)}\n`).join(""));
  assert.deepEqual(readRunLedgerState(dir, RUN_ID, anchor), { started: true, verdict: false },
    "a run.start rotated before the claim mint still identifies the orphaned run");

  assert.equal(runBranchHeadFromLsRemote({ status: 0, stdout: `${HEAD}\trefs/heads/${BRANCH}\n` }, BRANCH), HEAD);
  assert.equal(runBranchHeadFromLsRemote({ status: 0, stdout: `${HEAD}\trefs/heads/${BRANCH}-x\n` }, BRANCH), undefined);
  assert.equal(runBranchHeadFromLsRemote({ status: 0, stdout: "" }, BRANCH), undefined);
  assert.equal(runBranchHeadFromLsRemote({ status: 128, stdout: `${HEAD}\trefs/heads/${BRANCH}\n` }, BRANCH), undefined);
});
