import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { makeTempDir } from "../src/lib/tmp.js";
import { createBoardSnapshotCache, createBoardSnapshotReader, boardObservationPath, boardSnapshotPath, boardOpenSnapshotPath } from "../src/lib/board-snapshot-cache.js";
import { buildBatchedGithub } from "../src/lib/status.js";
import { fixedClock } from "../src/lib/clock.js";
import { captureRepositoryFlow } from "../src/lib/repository-flow.js";
import { createReadModelWorker, runReadModelWorker, readModelSwitchesPath, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { createService } from "../src/lib/service.js";
import { buildReadModelViewRoutes } from "../src/lib/views.js";
import type { AnalyticsViewData } from "../src/lib/analytics-view.js";
import { SPEC, violations } from "./helpers/openapi-strict.js";
import { repairReceiptFields } from "../src/lib/repair-cost-evidence.js";

test("W1-T8684: default sources reach cached repository flow without request-time scans", async t => {
  const root = makeTempDir("repository-flow-worker");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  const repository = "fixture/repo";
  const now = Date.now();
  const createdAt = new Date(now - 3600000).toISOString();
  const mergedAt = new Date(now - 60000).toISOString();
  const cache = createBoardSnapshotCache(root, "fixture", "repo");
  assert.equal(cache.commitClosed([{ number: 3, url: `https://github.com/${repository}/pull/3`, state: "MERGED",
    createdAt, mergedAt, updatedAt: mergedAt, headRefName: "run-W1-T12-123", headRefOid: "a".repeat(40),
    body: "Remudero-Task: W1-T12", autoMergeRequest: null, title: "fixture" }]), true);
  assert.equal(cache.commitOpen!([], now), true);
  // Exercise the fields owned by the real fix lane, not invented collector-specific aliases.
  const repairFields = repairReceiptFields({ prUrl: `https://github.com/${repository}/pull/3`, roundId: "one" });
  assert.equal("pr_url" in repairFields, false);
  assert.equal("round_id" in repairFields, false);
  writeFileSync(join(stateDir, "ledger.ndjson"), JSON.stringify({ ts: mergedAt, step: "fix.dispatch",
    ...repairFields, head_sha: "b".repeat(40) }) + "\n");
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { analytics: "serve" } }));
  const posted: ReadModelWorkerMessage[] = [];
  let onMessage: ((m: { type?: string }) => void) | undefined;
  t.after(() => onMessage?.({ type: "stop" }));
  runReadModelWorker({ on: (_event, run) => onMessage = run, postMessage: m => posted.push(m as ReadModelWorkerMessage), close() {} },
    { kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir: stateDir, repo: repository }],
      tickMs: 20, signal: new SharedArrayBuffer(8), slowLane: { intervalMs: 60000 } });
  const body = () => posted.findLast(m => m.type === "body" && m.entry.view === "analytics");
  const ready = () => { const m = body(); return m?.type === "body" && (m.entry.body.data as AnalyticsViewData)
    .instances[0]?.repositoryFlow?.windows[0]?.summary.merged === 1; };
  const deadline = Date.now() + 20000;
  while (!ready() && Date.now() < deadline) await sleep(20);
  assert.ok(ready(), JSON.stringify(posted.filter(m => m.type === "log")));
  onMessage?.({ type: "stop" });
  const message = body(); assert.ok(message?.type === "body");
  const flow = (message.entry.body.data as AnalyticsViewData).instances[0]!.repositoryFlow!;
  assert.equal(flow.windows[0]!.summary.repairRounds, 1);
  assert.equal(flow.windows[0]!.summary.mergeLatency.p50Ms, 3540000);
  assert.deepEqual(violations(message.entry.body, SPEC.components.schemas.AnalyticsView!), []);
  rmSync(join(stateDir, "ledger.ndjson"));
  rmSync(boardSnapshotPath(root, "fixture", "repo"));
  rmSync(boardOpenSnapshotPath(root, "fixture", "repo"));
  const restarted = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir, repo: repository }] });
  assert.deepEqual((restarted.body("analytics")!.body.data as AnalyticsViewData).instances[0]!.repositoryFlow, flow);
  const server = createService({ tokens: { read: "r", write: "w" }, routes: buildReadModelViewRoutes({ legacy: [],
    readModelViews: ["analytics"], readModel: restarted }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/analytics`,
      { headers: { authorization: "Bearer r" } });
    assert.equal(response.status, 200);
    const cached = await response.json() as { data: AnalyticsViewData };
    assert.deepEqual(cached.data.instances[0]!.repositoryFlow, flow);
    assert.deepEqual(cached.data.coverage, { counted: 1, of: 1, missing: [] });
  }
});

test("W1-T8912: default refresh persists PR observation for warm and cold cached reads", async t => {
  const root = makeTempDir("repository-flow-observation");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  const repository = "fixture/observed";
  const [owner, repo] = repository.split("/") as [string, string];
  const now = Date.now();
  const written = now - 2 * 3600000;
  const createdAt = new Date(written - 3600000).toISOString();
  const mergedAt = new Date(written - 60000).toISOString();
  const ghBin = join(root, "fake-gh");
  const merged = JSON.stringify([{ number: 5, html_url: `https://github.com/${repository}/pull/5`, state: "closed",
    merged_at: mergedAt, created_at: createdAt, updated_at: mergedAt, body: "Remudero-Task: W1-T5", title: "merged",
    head: { ref: "run-W1-T5-1", sha: "c".repeat(40) }, auto_merge: null }]);
  writeFileSync(ghBin, `#!/bin/sh\ncase "$*" in\n  *"state=closed"*) echo '${merged}' ;;\n  *) echo '[]' ;;\nesac\n`);
  chmodSync(ghBin, 0o755);
  const settle = async (gateway: ReturnType<typeof buildBatchedGithub>) => {
    gateway.warm!();
    const deadline = Date.now() + 10000;
    while (gateway.readState?.() === "in_flight") {
      if (Date.now() >= deadline) assert.fail("background prewarm did not settle");
      await sleep(10);
    }
  };
  // The history was written two hours ago by the real background worker path.
  await settle(buildBatchedGithub(owner, repo, { ghBin, snapshotCache: createBoardSnapshotCache(root, owner, repo, { clock: fixedClock(written) }) }));
  const dataPath = boardSnapshotPath(root, owner, repo);
  const history = { bytes: readFileSync(dataPath, "utf8"), mtimeMs: statSync(dataPath).mtimeMs };
  assert.equal(createBoardSnapshotCache(root, owner, repo).commitOpen!([], now), true);
  writeFileSync(join(stateDir, "ledger.ndjson"), JSON.stringify({ ts: new Date(now).toISOString(), step: "daemon.tick" }) + "\n");
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { analytics: "serve" } }));
  // Warm the shared default reader on the stale clock first.
  const stale = (await captureRepositoryFlow(root, stateDir, repository))!;
  assert.equal(stale.sources.closedObservedAt, new Date(written).toISOString());
  assert.equal(stale.sources.prFreshness, "stale");

  // A restarted process's default cache and gateway re-read GitHub; nothing changed.
  await settle(buildBatchedGithub(owner, repo, { ghBin, snapshotCache: createBoardSnapshotCache(root, owner, repo) }));
  assert.deepEqual({ bytes: readFileSync(dataPath, "utf8"), mtimeMs: statSync(dataPath).mtimeMs }, history, "history is not rewritten");
  const observedAt = (JSON.parse(readFileSync(boardObservationPath(root, owner, repo), "utf8")) as { observedAt: string }).observedAt;
  assert.ok(Date.parse(observedAt) >= now, observedAt);

  // Warm: the read-model worker's collector shares the reader that already held the stale clock.
  const posted: ReadModelWorkerMessage[] = [];
  let onMessage: ((m: { type?: string }) => void) | undefined;
  t.after(() => onMessage?.({ type: "stop" }));
  runReadModelWorker({ on: (_event, run) => onMessage = run, postMessage: m => posted.push(m as ReadModelWorkerMessage), close() {} },
    { kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir: stateDir, repo: repository }],
      tickMs: 20, signal: new SharedArrayBuffer(8), slowLane: { intervalMs: 60000 } });
  const flowOf = () => { const m = posted.findLast(p => p.type === "body" && p.entry.view === "analytics");
    return m?.type === "body" ? (m.entry.body.data as AnalyticsViewData).instances[0]?.repositoryFlow : undefined; };
  const deadline = Date.now() + 20000;
  while (flowOf()?.sources.prFreshness !== "fresh" && Date.now() < deadline) await sleep(20);
  onMessage?.({ type: "stop" });
  const flow = flowOf()!;
  assert.equal(flow.sources.prFreshness, "fresh", JSON.stringify(flow?.sources));
  assert.equal(flow.sources.closedObservedAt, observedAt);
  assert.equal(flow.windows[0]!.summary.merged, 1);

  // Cold: a fresh reader recovers the same watermark from disk; the restarted worker serves it over HTTP.
  assert.equal(createBoardSnapshotReader()(root, owner, repo).closedObservedAt, observedAt);
  const restarted = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir, repo: repository }] });
  const server = createService({ tokens: { read: "r", write: "w" }, routes: buildReadModelViewRoutes({ legacy: [],
    readModelViews: ["analytics"], readModel: restarted }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/analytics`,
    { headers: { authorization: "Bearer r" } });
  assert.equal(response.status, 200);
  const served = (await response.json() as { data: AnalyticsViewData }).data.instances[0]!.repositoryFlow!;
  assert.equal(served.sources.closedObservedAt, observedAt);
  assert.equal(served.sources.prFreshness, "fresh");
});
