import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { makeTempDir } from "../src/lib/tmp.js";
import { createBoardSnapshotCache, boardSnapshotPath, boardOpenSnapshotPath } from "../src/lib/board-snapshot-cache.js";
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
