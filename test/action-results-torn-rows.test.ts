import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { buildActionResultsRoute, tornRowCouldBeExternalEffect } from "../src/lib/action-results.js";
import type { ExternalEffectResult } from "../src/lib/action-reconciliation.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const effect: ExternalEffectResult = {
  version: "external-effect-v1",
  originatingActionId: "action-1",
  originatingReceiptId: "receipt-1",
  capabilityGrantId: "grant-1",
  connector: "provider",
  targetIdentity: "provider:account",
  requestedOperation: "rotate-secret",
  preconditionSnapshot: { status: "ready" },
  expectedPostconditions: [{ path: "status", equals: "ready" }],
  observation: { status: "fresh", observedAt: "2026-09-22T18:00:00.000Z", ageMs: 10, maxAgeMs: 5_000 },
  idempotencyKey: "key-1",
  reconciliationState: "applied",
  retryPath: { kind: "none", allowed: false, reason: "applied" },
  evidenceReference: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  safeToComplete: true,
};

// The key order appendLedger writes: ts, host, actor, actor_pid, then the caller's run_id, task_id, step.
const externalRow = JSON.stringify({
  ts: "2026-09-22T18:00:01.000Z", host: "h", actor: "daemon", actor_pid: 1,
  run_id: "RUN-1", task_id: "W1-T1", step: "external_effect.reconciled", external_effect: effect,
  reconciliation_state: "applied", action_id: "action-1", capability_grant_id: "grant-1", evidence_reference: effect.evidenceReference,
});
// Shaped like the 2026-09-24 incident row: a daemon row cut mid-write.
const tornDaemonRow = '{"ts":"2026-09-20T13:32:26.000Z","host":"h","actor":"daemon","actor_pid":1,"run_id":"DAEMON-17898890109","task_id":"DAEMON","step":"daemon.summary","cycle":{"dispat';
const tornExternalRow = externalRow.slice(0, externalRow.indexOf('"external_effect":') + 30);
const tornBeforeStep = externalRow.slice(0, externalRow.indexOf('"step"') - 1);

async function readRoute(files: { live: string; rotation?: string }): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}action-results-torn-`));
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const livePath = join(stateDir, "ledger.ndjson");
    writeFileSync(livePath, files.live);
    if (files.rotation !== undefined) writeFileSync(join(stateDir, "ledger.2026-09-22T16-27-20-296Z.ndjson.gz"), gzipSync(files.rotation));
    // Read twice through one route: the second answer comes from its warm rotation memo, which must
    // replay each rotation's torn lines exactly as the cold read classified them.
    const route = buildActionResultsRoute(livePath);
    const bodies: Array<Record<string, unknown>> = [];
    for (let read = 0; read < 2; read++) {
      let status = 0;
      let body = "";
      const response = { writeHead(code: number) { status = code; }, end(value: string) { body = value; } } as never;
      await route.handler({ url: "/v1/action-results" } as never, response, { params: {} });
      assert.equal(status, 200);
      bodies.push({ ...(JSON.parse(body) as Record<string, unknown>), generatedAt: undefined });
    }
    assert.deepEqual(bodies[1], bodies[0], "a warm read answers exactly as the cold one did");
    return bodies[0]!;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("unit test: a torn row that cannot be an external-effect row no longer blanks the action-results projection", async () => {
  const envelope = await readRoute({ live: `${externalRow}\n${tornDaemonRow}\n`, rotation: `${tornDaemonRow}\n` });
  assert.equal(envelope.state, "verified");
  assert.equal((envelope.results as ExternalEffectResult[]).length, 1);
  assert.equal((envelope.results as ExternalEffectResult[])[0].originatingActionId, "action-1");
  assert.match(String(envelope.detail), /^2 unreadable ledger row/);
  assert.equal(tornRowCouldBeExternalEffect(tornDaemonRow), false);
});

test("unit test: a torn row that could be an external-effect row still leaves the action-results projection unavailable", async () => {
  for (const torn of [tornExternalRow, tornBeforeStep, `${tornDaemonRow}${tornBeforeStep}`]) {
    assert.equal(tornRowCouldBeExternalEffect(torn), true, torn);
  }
  for (const files of [{ live: `${externalRow}\n${tornExternalRow}\n` }, { live: `${externalRow}\n`, rotation: `${tornBeforeStep}\n` }]) {
    const envelope = await readRoute(files);
    assert.equal(envelope.state, "unavailable");
    assert.equal(envelope.reason, "ledger-partial");
  }
});
