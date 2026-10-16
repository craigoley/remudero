import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { makeTempDir } from "../src/lib/tmp.js";
import { fixedClock } from "../src/lib/clock.js";
import { createBoardSnapshotCache, boardOpenSnapshotPath } from "../src/lib/board-snapshot-cache.js";
import { captureRepositoryFlow } from "../src/lib/repository-flow.js";
import { flowHistoryPath, readRepositoryFlowHistory, FLOW_HISTORY_MAX_IDENTITIES } from "../src/lib/repository-flow-history.js";
import { buildSweepEffects, runSweep, type OpenPrView } from "./helpers/sweep-test.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { createReadModelWorker, runReadModelWorker, readModelSwitchesPath, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import type { AnalyticsViewData } from "../src/lib/analytics-view.js";
import { createService } from "../src/lib/service.js";
import { buildReadModelViewRoutes } from "../src/lib/views.js";
import { SPEC, violations } from "./helpers/openapi-strict.js";

test("W1-T8707: default quality collection survives restore and named source failure", async t => {
  const root = makeTempDir("repository-quality-wiring");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), repository = "fixture/repo";
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  const now = Date.now(), iso = (offset: number) => new Date(now + offset).toISOString();
  const firstHead = "a".repeat(40), nextHead = "b".repeat(40);
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const publication = { ts: iso(-60000), step: "pr.opened", pr_url: `https://github.com/${repository}/pull/1`,
    head_sha: firstHead, task_id: "W1-T1", run_id: "worker-one" };
  const cost = { ts: iso(-65000), step: "implement.done", task_id: "W1-T1", run_id: "worker-one",
    provider: "cash", total_cost_usd: 0, tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 } };
  const ledger = [publication, cost, { ...cost, step: "verdict", total_cost_usd: 1000 },
    { ...cost, scope: "host", total_cost_usd: 50 }, { ...cost, scope: "fleet", total_cost_usd: 60 },
    { ...cost, repository: "another/repo", total_cost_usd: 70 }].map(r => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(ledgerPath, ledger);
  writeFileSync(join(stateDir, "ledger.replay.ndjson.gz"), gzipSync(ledger));
  const cache = createBoardSnapshotCache(root, "fixture", "repo", { clock: fixedClock(now - 1000) });
  assert.equal(cache.commitClosed([]), true);
  assert.equal(cache.commitOpen!([{ number: 1, url: publication.pr_url, state: "OPEN", createdAt: iso(-86400000),
    updatedAt: iso(-1000), headRefOid: firstHead, headRefName: "run-W1-T1-123", body: "Remudero-Task: W1-T1",
    title: "fixture", autoMergeRequest: null }], now - 1000), true);
  let observed = now - 30000, sha = firstHead, conclusion = "failure", truncated = false;
  const logRows: Array<{ step: string; reason?: unknown }> = [];
  const effects = buildSweepEffects({ owner: "fixture", repo: "repo", config: { root } as Config,
    ledgerPath, runId: "sweep-one", plan: { tasks: [], byId: new Map() } as unknown as Plan,
    nowMsImpl: () => observed, log: (step, fields) => logRows.push({ step, reason: fields?.reason }),
    readJsonImpl: async args => {
      const path = args[1]!;
      if (path.endsWith("/pulls/1")) return { number: 1, state: "open", auto_merge: null, merged: false, draft: false,
        head: { sha }, base: { sha: "c".repeat(40), ref: "main" }, mergeable: true, mergeable_state: "clean" };
      if (path.includes("/protection/")) return { contexts: ["ci", "remudero-review"] };
      if (path.includes("/check-runs?")) return { total_count: truncated ? 101 : 1, check_runs: [
        { id: 7, name: "ci", status: "completed", conclusion, started_at: iso(-45000), completed_at: new Date(observed - 1000).toISOString() } ] };
      if (path.endsWith("/status")) return { sha, total_count: 1, statuses: [
        { context: "remudero-review", state: "success", created_at: iso(-45000), updated_at: new Date(observed - 1000).toISOString() } ] };
      throw new Error(`unexpected source read ${path}`);
    } });
  const pr: OpenPrView = { prNumber: 1, prUrl: publication.pr_url, headSha: firstHead, taskId: "W1-T1",
    checksState: "red", reviewState: "pending", priorStrikes: 0, unmetCriteria: [], lastActivityAt: iso(-1000),
    createdAt: iso(-86400000), mergeState: "dirty", mergeableState: "blocked", autoMergeArmed: false };
  assert.ok(await effects.readArmFacts!(pr));
  const captured = readRepositoryFlowHistory(stateDir, repository);
  assert.ok(captured.ok, "the default sweep reader must persist its own required-head source evidence");
  assert.equal(captured.history.snapshots[0]!.head, firstHead);
  assert.deepEqual(captured.history.snapshots[0]!.policy.required, ["ci", "remudero-review"]);
  const sweepDeps = { ledgerPath, runId: "sweep-one", now: () => now - 1000,
    readerAgreement: { owner: "fixture", repo: "repo",
      boardReader: () => ({ dispatchStreaks: {}, healthyDeploys: {} }),
      independentReader: () => ({ dispatchStreaks: {}, healthyDeploys: {} }) },
    snapshotPublishedAtMs: now - 1000, actionable: () => false,
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {} };
  await runSweep([pr], sweepDeps);
  let flow = (await captureRepositoryFlow(root, stateDir, repository, fixedClock(now)))!;
  assert.equal(flow.quality!.windows[0]!.firstPass.states.FAILURE, 1);
  assert.equal(flow.quality!.windows[0]!.repairLatency.censored, 1);
  const sample = flow.quality!.backlog.find(b => b.sampledAt === iso(-1000))!;
  assert.equal(sample.distinctPrs, 1);
  assert.equal(sample.reasons!.required_red, 1);
  assert.equal(sample.reasons!.awaiting_review, 1);
  assert.equal(sample.reasons!.conflict, 1);
  assert.equal(sample.reasons!.blocked, 1);
  observed = now - 500; sha = nextHead; conclusion = "success"; truncated = true;
  assert.equal(await effects.readArmFacts!(pr), undefined);
  assert.match(String(logRows.at(-1)!.reason), /incomplete/);
  assert.equal((await captureRepositoryFlow(root, stateDir, repository, fixedClock(now)))!.quality!.windows[0]!.repairLatency.samples, 0);
  truncated = false;
  assert.ok(await effects.readArmFacts!(pr));
  assert.equal(cache.commitClosed([{ number: 1, url: publication.pr_url, state: "MERGED", createdAt: iso(-86400000),
    updatedAt: iso(-100), mergedAt: iso(-100), headRefOid: nextHead, headRefName: "run-W1-T1-123",
    body: "Remudero-Task: W1-T1", title: "fixture", autoMergeRequest: null }]), true);
  assert.equal(cache.commitOpen!([], now), true);
  flow = (await captureRepositoryFlow(root, stateDir, repository, fixedClock(now)))!;
  assert.equal(flow.quality!.windows[0]!.repairLatency.samples, 1);
  assert.equal(flow.quality!.windows[0]!.repairLatency.p50Ms, 28500);
  assert.equal(flow.quality!.windows[0]!.efficiency.priced, 1);
  assert.equal(flow.quality!.windows[0]!.efficiency.pricedSubtotalUsd, 0);
  assert.equal(flow.quality!.windows[0]!.efficiency.tokens, 3);
  assert.deepEqual(violations(flow, SPEC.components.schemas.RepositoryFlow!), []);

  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { analytics: "serve" } }));
  const posted: ReadModelWorkerMessage[] = [];
  let onMessage: ((m: { type?: string }) => void) | undefined;
  t.after(() => onMessage?.({ type: "stop" }));
  runReadModelWorker({ on: (_event, run) => onMessage = run, postMessage: m => posted.push(m as ReadModelWorkerMessage), close() {} },
    { kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir: stateDir, repo: repository }],
      tickMs: 20, signal: new SharedArrayBuffer(8), slowLane: { intervalMs: 60000 } });
  const body = () => posted.findLast(m => m.type === "body" && m.entry.view === "analytics");
  const ready = () => { const m = body(); return m?.type === "body" && (m.entry.body.data as AnalyticsViewData)
    .instances[0]?.repositoryFlow?.quality?.windows[0]?.repairLatency.samples === 1; };
  const deadline = Date.now() + 20000;
  while (!ready() && Date.now() < deadline) await sleep(20);
  assert.ok(ready(), JSON.stringify(posted.filter(m => m.type === "log")));
  onMessage?.({ type: "stop" });
  const message = body(); assert.ok(message?.type === "body");
  const served = (message.entry.body.data as AnalyticsViewData).instances[0]!.repositoryFlow!;
  assert.deepEqual(violations(message.entry.body, SPEC.components.schemas.AnalyticsView!), []);
  const durable = readFileSync(flowHistoryPath(stateDir, repository), "utf8");
  writeFileSync(flowHistoryPath(stateDir, repository), JSON.stringify({ version: 99 }));
  const failed = (await captureRepositoryFlow(root, stateDir, repository))!;
  assert.equal(failed.quality!.reason, "invalid_history");
  assert.equal(failed.windows[0]!.summary.merged, 1, "a named quality failure preserves independent flow");
  writeFileSync(flowHistoryPath(stateDir, repository), durable);
  rmSync(ledgerPath); rmSync(boardOpenSnapshotPath(root, "fixture", "repo"));
  const restarted = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir, repo: repository }] });
  const server = createService({ tokens: { read: "r", write: "w" }, routes: buildReadModelViewRoutes({ legacy: [],
    readModelViews: ["analytics"], readModel: restarted }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/analytics`,
      { headers: { authorization: "Bearer r" } });
    assert.equal(response.status, 200);
    const cached = await response.json() as { data: AnalyticsViewData };
    assert.deepEqual(cached.data.instances[0]!.repositoryFlow, served);
    assert.deepEqual(cached.data.coverage, { counted: 1, of: 1, missing: [] });
  }
});

test("quality overflow keeps independently observed backlog and ordinary flow", async t => {
  const root = makeTempDir("repository-quality-overflow");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), repository = "fixture/repo", now = Date.now();
  mkdirSync(stateDir);
  const cache = createBoardSnapshotCache(root, "fixture", "repo", { clock: fixedClock(now) });
  assert.equal(cache.commitClosed([]), true);
  assert.equal(cache.commitOpen!([], now), true);
  const rows = Array.from({ length: FLOW_HISTORY_MAX_IDENTITIES + 1 }, (_, i) => JSON.stringify({
    ts: new Date(now - 1000).toISOString(), step: "implement.done", run_id: `worker-${i}`, task_id: `W1-T${i + 1}`,
    provider: "cash", total_cost_usd: 1, repository }));
  writeFileSync(join(stateDir, "ledger.ndjson"), rows.join("\n") + "\n");
  const flow = (await captureRepositoryFlow(root, stateDir, repository, fixedClock(now)))!;
  assert.equal(flow.quality!.reason, "history_over_budget");
  assert.equal(flow.quality!.backlog.at(-1)!.distinctPrs, 0);
  assert.equal(flow.quality!.windows[0]!.efficiency.coverage, "partial");
  assert.equal(flow.quality!.windows[0]!.efficiency.pricedSubtotalUsd, null);
  assert.equal(flow.windows[0]!.summary.merged, 0);
  const restored = readRepositoryFlowHistory(stateDir, repository);
  assert.ok(restored.ok);
  assert.equal(restored.history.inventories[0]!.prs.length, 0);
});
