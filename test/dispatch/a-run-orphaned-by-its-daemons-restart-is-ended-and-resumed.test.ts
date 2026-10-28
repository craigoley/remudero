/**
 * W1-T10896 — A RUN ORPHANED BY ITS DAEMON'S IN-PLACE RESTART IS ENDED AND RESUMED.
 *
 * MEASURED 2026-10-28: the daemon container restarted in place (same hostname). W1-T10838's run had pushed
 * its branch, and its claim anchor named this host, minted before the new PID namespace booted, with an absent
 * pid. The boot sweep supplied only the replaced-container probe, so the claim fell to the operator arm, the
 * run never got a verdict, and its pushed branch blocked dispatch for the 24 h orphan grace.
 *
 * These cases run the boot sweep `rmd daemon` calls after taking its lock, with its real /proc liveness probe and
 * its real ledger reads. The resume case dispatches the receipt into real runTask against a local bare remote.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import {
  dispatchClaimRef, readRunLedgerState, runBranchHeadFromLsRemote, type ClaimAnchorIdentity,
} from "#src/lib/dispatch-claim.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { dispatchesWithoutNewOwnedPr } from "#src/lib/status.js";
import { readBreakerStrikes } from "#src/lib/breaker-release.js";
import { streakRefusal } from "#src/lib/non-worker-verdict.js";
import { handoffReceiptsToCarry, pendingWorkerBoundaryHandoffs, runBranchDispatchOpts, runBranchStateFrom, runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { loadPlan } from "#src/lib/plan.js";
import { appendLedger } from "#src/lib/ledger.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { runTask } from "#test/helpers/run-task-test.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import {
  TASK, RUN_ID, BRANCH, HEAD, MINT_ISO, DEAD_PID, LOCAL, OTHER_HOST, ORPHAN_PLAN,
  anchorMessage, orphanRunRows, fakeReserver, instance, gitRemote, sweepRows, orphanVerdicts,
} from "#test/helpers/restart-orphan.js";

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

test("W1-T10896: the orphaned run pushed head resumes instead of blocking dispatch", async (t) => {
  const origin = gitRemote(t);
  const node = instance(t, orphanRunRows());
  assert.equal(dispatchesWithoutNewOwnedPr(node.rows(), TASK), 1);
  const before = runBranchDispatchOpts(runBranchStateFrom(`${origin.head}\trefs/heads/${BRANCH}\n`, undefined,
    pendingWorkerBoundaryHandoffs(node.rawLines())), [], () => {});
  assert.equal(before.hasPushedRunBranch!(TASK), true, "without the boot receipt the pushed branch blocks dispatch");
  node.boot(origin.reserver);
  assert.equal(origin.claimTip(), "", "the dead claim no longer blocks dispatch");
  const verdicts = orphanVerdicts(node.rows());
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]!.branch, BRANCH);
  assert.equal(verdicts[0]!.head_sha, origin.head, "the resume receipt names the real remote's exact head");
  assert.equal(verdicts[0]!.verdict, "handed_off");
  assert.equal(dispatchesWithoutNewOwnedPr(node.rows(), TASK), 0, "the orphan no longer consumes the dispatch budget");
  await resumeOrphan(t, origin, node.rawLines());
});

/** Dispatch selection and the real runTask consumer share the receipt the boot sweep actually wrote. */
async function resumeOrphan(t: TestContext, origin: ReturnType<typeof gitRemote>, rawLines: string[],
  options: { repair?: boolean; yieldAfterGate?: boolean } = {}) {
  const repair = options.repair === true;
  const root = makeTempDir("restart-orphan-resume");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "repos"));
  renameSync(origin.client.dir, join(root, "repos", "remudero"));
  mkdirSync(join(root, "state"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, rawLines.join("\n") + "\n");
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ORPHAN_PLAN);
  const gh = ghShim([], { kind: "restart-orphan-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(gh.dir, { recursive: true, force: true }); });
  const history = () => readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
  const rows = () => history().map((raw) => JSON.parse(raw) as Record<string, unknown>);
  const prompts: string[] = [];
  const gateSpawns: number[] = [];
  const gateHeads: string[] = [];
  let proofCalls = 0;
  let prCreates = 0;
  let dispatches = 0;
  let gateCompleted = false;
  const listing = `${origin.head}\trefs/heads/${BRANCH}\n`;
  const blocked = () => runBranchDispatchOpts(runBranchStateFrom(listing, undefined,
    pendingWorkerBoundaryHandoffs(history())), [], () => {}).hasPushedRunBranch!(TASK);
  assert.equal(blocked(), false, "the pushed branch's exact receipt unblocks dispatch");
  await runDaemon(loadPlan(planPath), {
    refreshMerged: () => () => false,
    readLedgerLines: history,
    readPushedRunBranches: () => listing,
    log: (step, fields) => appendLedger(ledgerPath, { run_id: "DAEMON-fixture", task_id: "DAEMON", step, ...fields }),
    checkStop: () => dispatches > 0 ? "fixture dispatched" : undefined,
    runOne: async () => {
      dispatches++;
      return withLiveWritesAllowed(() => runTask(TASK, {
        config: { claudeBin: "/bin/true", root, installRoot: REPO_ROOT, workerProviders: { harnessCommitsImplement: true } },
        skipGitSync: true, planPath, owner: "fixture",
        github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
        claimReserver: { mintAnchor: () => "fixture-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
        containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
        isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
        coveragePrecheckPorts: { changedFiles: () => [] },
        implementPush: async (cwd, options) => {
          origin.remote.git("-C", cwd, "push", "-q", ...(options?.force ? ["--force"] : []), "origin", "HEAD");
        },
        otherOpenPrReader: async () => [],
        prOpenRefusalIssues: { create: () => "https://github.com/fixture/remudero/issues/1", listOpen: () => [], ensureLabel: () => true },
        prCreateExec: () => { prCreates++; return ""; },
        prOpenProofRunner: async () => {
          proofCalls++;
          return { status: 5, stdout: "verdict:    executed_stale\ncause:      the proof passes at the merge base" };
        },
        externalWaitFreshness: () => options.yieldAfterGate && gateCompleted ? {
          stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40),
          changes: [{ sha: "b".repeat(40), subject: "fix: refresh daemon", files: ["src/lib/daemon.ts"] }],
        } : undefined,
        preopenGate: async (cwd) => {
          gateCompleted = true;
          gateSpawns.push(prompts.length);
          gateHeads.push(origin.remote.git("-C", cwd, "rev-parse", "HEAD"));
          const restored = await import(pathToFileURL(join(cwd, "src/change.ts")).href);
          assert.equal(restored.value, 42, "the saved implementation survives restoration");
          return repair && gateSpawns.length === 1
            ? { kind: "fail", failedSteps: ["fixture repair required"], durationMs: 1 }
            : { kind: "pass", durationMs: 1 };
        },
        spawn: async (args): Promise<WorkerResult> => {
          prompts.push(String(args.prompt));
          return { sessionId: "fixture", costUsd: 0, numTurns: 1, text: "REPORT\nno edits needed\n", blocks: [], stderr: "", subtype: "success",
            isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
        },
      }));
    },
    sleep: async () => {},
  } as DaemonDeps, { laneCount: 1, max: 1 });
  assert.equal(dispatches, 1, "the daemon dispatches the orphan rather than skipping its pushed branch");
  assert.deepEqual(gateSpawns, repair ? [0, 1] : [0], "pre-open runs first; only a failed gate may launch a repair worker");
  assert.deepEqual(gateHeads, repair ? [origin.head, origin.head] : [origin.head], "pre-open sees the exact saved head");
  assert.equal(prompts.length, repair ? 1 : 0, "no recon or implementation worker rebuilds the orphaned work");
  if (repair) assert.match(prompts[0]!, /fixture repair required/);
  assert.equal(rows().find((row) => row.step === "implement.checkpoint_restored")?.source_head_sha, origin.head);
  assert.equal(rows().some((row) => row.step === "implement.preopen_resumed"), true);
  assert.equal(rows().find((row) => row.step === "run.freshness_handoff")?.resume_phase, "preopen", "the daemon carries the phase at boot");
  if (options.yieldAfterGate) {
    const receipt = pendingWorkerBoundaryHandoffs(history()).get(TASK);
    assert.ok(receipt, "a freshness yield replaces the orphan receipt with its pushed checkpoint");
    assert.equal(receipt.resumePhase, "preopen", "yielding before PR-open must not restart implementation next time");
    assert.equal(origin.remote.git("rev-parse", receipt.branch), receipt.headSha, "the replacement receipt names its exact remote head");
    assert.ok(rows().some((row) => row.step === "verdict" && row.reason === "freshness_yield" && row.resume_phase === "preopen"));
    assert.equal(proofCalls, 0, "the freshness boundary yields before the opener");
    assert.equal(prCreates, 0);
    return;
  }
  assert.ok(proofCalls > 0, "the restored head still goes through the opener's proof-freshness gate");
  assert.equal(prCreates, 0, "a stale proof still prevents PR creation");
  assert.ok(rows().some((row) => row.step === "verdict" && row.stage === "pr_open.refused" && row.cause === "base-proof-refused"));
  assert.equal(pendingWorkerBoundaryHandoffs(history()).get(TASK)?.resumePhase, "preopen", "a returned gate refusal keeps the phase for retry");
}

test("W1-T10896: pre-open resume still repairs a failed gate before checking proof freshness", async (t) => {
  const origin = gitRemote(t);
  const node = instance(t, orphanRunRows());
  node.boot(origin.reserver);
  await resumeOrphan(t, origin, node.rawLines(), { repair: true });
});

test("W1-T10896: a freshness yield after pre-open keeps the orphan's resume phase", async (t) => {
  const origin = gitRemote(t);
  const node = instance(t, orphanRunRows());
  node.boot(origin.reserver);
  await resumeOrphan(t, origin, node.rawLines(), { yieldAfterGate: true });
});

test("W1-T10896: carried and kept orphan receipts retain their pre-open phase", (t) => {
  const node = instance(t, orphanRunRows());
  node.boot(fakeReserver({ [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO) }, { heads: { [BRANCH]: HEAD } }));
  const receipt = { branch: BRANCH, headSha: HEAD, resumePhase: "preopen" };
  assert.deepEqual(pendingWorkerBoundaryHandoffs(node.rawLines()).get(TASK), receipt);
  assert.deepEqual(handoffReceiptsToCarry(node.rawLines()), [[TASK, receipt]]);
  const carried = JSON.stringify({ task_id: TASK, step: "run.freshness_handoff", branch: BRANCH, head_sha: HEAD, resume_phase: "preopen", carried: true });
  assert.deepEqual(pendingWorkerBoundaryHandoffs([carried]).get(TASK), receipt, "a carried row survives without its original verdict");
  const kept = JSON.stringify({ task_id: TASK, step: "implement.checkpoint_kept", source_branch: BRANCH, head_sha: HEAD, resume_phase: "preopen" });
  assert.deepEqual(pendingWorkerBoundaryHandoffs([kept]).get(TASK), receipt, "a failed resumed run retains its phase");
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
