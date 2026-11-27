// W1-T14810: the fold-debt and mutation-verdict artifact lists follow a completed workflow run,
// with policy githubEventWake.artifactRecheckMs as the freshness floor for a missed delivery.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { foldDebtArtifactsRestArgs, FOLD_DEBT_MAIN_ARTIFACT, FOLD_DEBT_PR_ARTIFACT } from "#src/lib/fold-debt-pull.js";
import {
  createDeliveryDedupStore,
  createGitHubEventWakeHandler,
  isAllowlistedGithubEvent,
  readWorkflowRunCompleted,
  sweepWakeMarkerPath,
  wireSweepWakeToDaemon,
  workflowRunCompletedPath,
} from "#src/lib/github-event-wake.js";
import { mutationVerdictArtifactsRestArgs } from "#src/lib/mutation-verdict-pull.js";
import { loadDefaultPolicy } from "#src/lib/policy.js";
import { createService } from "#src/lib/service.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { DEFAULT_SWEEP_POLICY, buildSweepEffects, runSweep } from "#test/helpers/sweep-test.js";

const SECRET = "w1-t14810-secret";
const OWNER = "craigoley";
const REPO = "remudero";
const LISTINGS = [
  foldDebtArtifactsRestArgs(OWNER, REPO, FOLD_DEBT_MAIN_ARTIFACT)[1],
  foldDebtArtifactsRestArgs(OWNER, REPO, FOLD_DEBT_PR_ARTIFACT)[1],
  mutationVerdictArtifactsRestArgs(OWNER, REPO)[1],
];

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14810-`));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

async function post(root: string, event: string, payload: Record<string, unknown>, deliveryId: string): Promise<{ status: number; body: unknown }> {
  const route = createGitHubEventWakeHandler({
    secret: SECRET,
    repository: `${OWNER}/${REPO}`,
    markerPath: sweepWakeMarkerPath(root),
    resolveMarkerPath: (repository) => (repository === `${OWNER}/${REPO}` ? sweepWakeMarkerPath(root) : undefined),
    dedup: createDeliveryDedupStore(50),
  });
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const body = JSON.stringify({ repository: { full_name: `${OWNER}/${REPO}` }, ...payload });
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}${route.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`,
      },
      body,
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

/** One sweep pass the way the daemon runs it: fresh effects per poll, over one instance's state root. */
async function pass(root: string, nowMs: number, reads: string[], opts: { listThrows?: boolean } = {}): Promise<void> {
  const readJson = (args: string[]) => {
    reads.push(String(args[1]));
    if (opts.listThrows && LISTINGS.includes(String(args[1]))) throw new Error("list 502");
    return { artifacts: [] };
  };
  const effects = buildSweepEffects({
    owner: OWNER,
    repo: REPO,
    config: { root } as never,
    ledgerPath: "/dev/null/ledger.ndjson",
    runId: "t14810",
    plan: { tasks: [], byId: new Map() } as never,
    log: () => {},
    policy: DEFAULT_SWEEP_POLICY,
    repoRoot: root,
    ghJsonImpl: readJson,
    ghBufferImpl: () => Buffer.alloc(0),
    readJsonImpl: async (args: string[]) => readJson(args),
    readBufferImpl: async () => Buffer.alloc(0),
    nowMsImpl: () => nowMs,
  });
  await runSweep([], {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: "/dev/null/ledger.ndjson", runId: "t14810",
    readLedger: () => [], appendLine: () => {}, now: () => nowMs, log: () => {},
    pullMutationVerdicts: effects.pullMutationVerdicts,
    pullFoldDebt: effects.pullFoldDebt,
    artifactListingDue: effects.artifactListingDue,
  }, DEFAULT_SWEEP_POLICY);
}

const listingsIn = (reads: string[]) => reads.filter((r) => LISTINGS.includes(r));

test("W1-T14810: an artifact pull waits for a completed workflow run", async () => {
  const root = stateRoot();
  try {
    const recheckMs = loadDefaultPolicy().values.githubEventWake.artifactRecheckMs;
    assert.equal(recheckMs, 900_000, "the shipped freshness floor");
    // An hour before the real clock: the delivery below is stamped at real time, after both early passes.
    const t0 = Date.now() - 3_600_000;
    const reads: string[] = [];

    await pass(root, t0, reads);
    assert.deepEqual(listingsIn(reads).sort(), [...LISTINGS].sort(), "a daemon's first sweep lists every artifact kind once");

    reads.length = 0;
    await pass(root, t0 + 60_000, reads);
    assert.deepEqual(listingsIn(reads), [], "no workflow_run delivery since the last listing: no artifact list read");

    // A verified workflow_run.completed delivery for this repository: the next sweep lists.
    const res = await post(root, "workflow_run", { action: "completed", workflow_run: { id: 77 } }, "d-run-1");
    assert.equal(res.status, 202);
    const receivedAt = Date.parse(readWorkflowRunCompleted(workflowRunCompletedPath(root))!.receivedAtIso);
    reads.length = 0;
    await pass(root, Math.max(receivedAt, t0 + 120_000), reads);
    assert.deepEqual(listingsIn(reads).sort(), [...LISTINGS].sort(), "a completed run since the last listing lists every kind");

    reads.length = 0;
    await pass(root, Math.max(receivedAt, t0 + 120_000) + 1_000, reads);
    assert.deepEqual(listingsIn(reads), [], "that delivery is spent once it is listed");

    // A missed delivery: the floor lists once the last listing is older than artifactRecheckMs.
    const floorAt = Math.max(receivedAt, t0 + 120_000) + recheckMs;
    reads.length = 0;
    await pass(root, floorAt, reads, { listThrows: true });
    assert.deepEqual(listingsIn(reads).sort(), [LISTINGS[0], LISTINGS[2]].sort(),
      "the freshness floor lists after artifactRecheckMs (a failed main-lane list stops the fold-debt pull)");

    // That listing failed: its stamp is restored, so the very next sweep lists again.
    reads.length = 0;
    await pass(root, floorAt + 1_000, reads);
    assert.deepEqual(listingsIn(reads).sort(), [...LISTINGS].sort(), "a failed listing is retried on the next sweep");
    reads.length = 0;
    await pass(root, floorAt + 2_000, reads);
    assert.deepEqual(listingsIn(reads), [], "and a successful one is not");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T14810: a completed workflow run webhook is accepted and wakes the daemon", async () => {
  assert.equal(isAllowlistedGithubEvent("workflow_run", "completed"), true);
  assert.equal(isAllowlistedGithubEvent("workflow_run", "requested"), false);
  assert.equal(isAllowlistedGithubEvent("workflow_run", "in_progress"), false);

  const ignoredRoot = stateRoot();
  try {
    const ignored = await post(ignoredRoot, "workflow_run", { action: "requested", workflow_run: { id: 76 } }, "d-run-requested");
    assert.deepEqual(ignored.body, { error: "ignored" });
    assert.equal(existsSync(workflowRunCompletedPath(ignoredRoot)), false, "a requested run records nothing");
    assert.equal(existsSync(sweepWakeMarkerPath(ignoredRoot)), false);
  } finally {
    rmSync(ignoredRoot, { recursive: true, force: true });
  }

  const root = stateRoot();
  try {
    const res = await post(root, "workflow_run", { action: "completed", workflow_run: { id: 78 } }, "d-run-2");
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { accepted: true });
    const record = readWorkflowRunCompleted(workflowRunCompletedPath(root));
    assert.equal(record?.deliveryId, "d-run-2");
    assert.equal(record?.repository, `${OWNER}/${REPO}`);
    assert.equal(existsSync(sweepWakeMarkerPath(root)), true, "the wake marker is armed");

    // A structural wake: it does not wait out the check/status settle period.
    const timers: Array<{ ms: number }> = [];
    const wiring = wireSweepWakeToDaemon(root, () => {}, undefined, {
      checkSettleMs: 10_000,
      timers: { setTimer: (_cb, ms) => { const h = { ms }; timers.push(h); return h; }, clearTimer: () => {} },
    });
    try {
      assert.equal(await wiring.sleep(60_000), "wake", "the daemon wakes on the delivery");
      assert.ok(!timers.some((t) => t.ms === 10_000), "no settle timer was armed for a workflow run");
      wiring.acknowledge();
      assert.equal(existsSync(sweepWakeMarkerPath(root)), false, "the accepted sweep consumes the marker");
      assert.equal(readWorkflowRunCompleted(workflowRunCompletedPath(root))?.deliveryId, "d-run-2",
        "the workflow-run record outlives the marker, so the sweep it woke still sees it");
    } finally {
      wiring.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
