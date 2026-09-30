import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildPanelGraphRoutes, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { inboxThreadId } from "../src/lib/inbox-thread.js";
import { createService } from "../src/lib/service.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const RELEASED = "verify-human:W1-T217";
const UNRELEASED = "verify-human:W1-T216";
const RULING = "ruling:operator-choice";

function fixture(corruptArchive = false, heldTaskId?: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-archive-release-inbox-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, ["W1-T216", "W1-T217"].map((id) => `
- id: ${id}
  title: "A controlled security ruling"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  ${id === heldTaskId ? "dispatch_hold: true" : ""}
  risk: high
  status: queued
  attempts: 0
  files: [test/controlled-task.test.ts]
  acceptance:
    - claim: "a controlled check"
      proof: "unit test: controlled check"
`).join(""));
  const registryPath = join(root, "state", "inbox-proposals.json");
  writeFileSync(registryPath, JSON.stringify({
    proposals: [UNRELEASED, RELEASED, RULING].map((id) => ({ id, summary: `Review ${id}`, evidenceAnchors: [] })),
  }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  writeFileSync(join(root, "state", "ledger.2026-09-27T00-00-00-000Z.ndjson"),
    JSON.stringify({ step: "ratify.approved", task_id: "W1-T217", released: "verify-human",
      run_id: "RELEASE-217", ts: "2026-09-27T00:00:00.000Z",
      ...(heldTaskId ? { author_class: "machine" } : {}) }) + "\n");
  if (corruptArchive) writeFileSync(join(root, "state", "ledger.2026-09-26T00-00-00-000Z.ndjson.gz"), "not a gzip archive");
  const approved: string[] = [];
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath, github: { prView: () => null },
    statusGithub: fakeGitHub(), ratify: { approve: (id) => { approved.push(id); }, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40),
  };
  return { root, registryPath, ledgerPath, approved, deps };
}

async function withServer<T>(deps: PanelGraphDeps, use: (base: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: "read-token", write: "write-token" }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

async function get(base: string, path: string) {
  const response = await fetch(`${base}${path}`, { headers: { authorization: "Bearer read-token" } });
  assert.equal(response.status, 200);
  return response.json() as Promise<Record<string, unknown>>;
}

test("W1-T4768: archived positive release retires exact ask", async (t) => {
  const world = fixture();
  t.after(() => rmSync(world.root, { recursive: true, force: true }));
  await withServer(world.deps, async (base) => {
    const inbox = await get(base, "/v1/inbox") as { notReady: Array<{ proposalId: string }> };
    assert.ok(!inbox.notReady.some((item) => item.proposalId === RELEASED));
    assert.ok(inbox.notReady.some((item) => item.proposalId === UNRELEASED));
    const threads = await get(base, "/v1/inbox/threads") as { threads: Array<{ proposalId: string }> };
    assert.ok(!threads.threads.some((item) => item.proposalId === RELEASED));
    assert.ok(threads.threads.some((item) => item.proposalId === UNRELEASED));
    assert.ok(threads.threads.some((item) => item.proposalId === RULING));
    const census = await get(base, "/v1/inbox/attention-census") as {
      snapshotKey: string; counts: { decision: number; history: number };
      items: Array<{ proposalId: string; attention: string; sourceFacts: Array<{ detail: string }> }>;
    };
    assert.equal(census.items.find((item) => item.proposalId === RELEASED)?.attention, "history");
    assert.ok(census.items.find((item) => item.proposalId === RELEASED)?.sourceFacts.some((fact) => fact.detail.includes("RELEASE-217")));
    assert.equal(census.items.find((item) => item.proposalId === UNRELEASED)?.attention, "decision");
    const repeat = await get(base, "/v1/inbox/attention-census") as { snapshotKey: string };
    assert.equal(repeat.snapshotKey, census.snapshotKey, "unchanged archive evidence keeps one stable snapshot");
    const detail = await get(base, `/v1/inbox/thread?id=${encodeURIComponent(inboxThreadId(RELEASED))}`) as {
      attention: string; messages: Array<{ actions: string[] }>;
    };
    assert.equal(detail.attention, "history");
    assert.deepEqual(detail.messages[0]?.actions, []);
    const reply = await fetch(`${base}/v1/inbox/thread/reply`, {
      method: "POST",
      headers: { authorization: "Bearer write-token", "content-type": "application/json" },
      body: JSON.stringify({ threadId: inboxThreadId(RELEASED), text: "please reconsider", intentId: "retired-release-01" }),
    });
    assert.equal(reply.status, 404, "a historical release must not accept a new live reply");
    const approve = await fetch(`${base}/v1/inbox/approve`, {
      method: "POST",
      headers: { authorization: "Bearer write-token", "content-type": "application/json" },
      body: JSON.stringify({ proposalId: RELEASED }),
    });
    assert.equal(approve.status, 409, "an archived release also blocks a direct stale approval request");
    assert.deepEqual(world.approved, []);
  });
  const registry = readFileSync(world.registryPath, "utf8");
  assert.ok(registry.includes(RELEASED), "reconciliation must not erase the registry record");
});

test("W1-T4768: archive gap preserves unproven ask", async (t) => {
  const world = fixture(true);
  t.after(() => rmSync(world.root, { recursive: true, force: true }));
  await withServer(world.deps, async (base) => {
    const inbox = await get(base, "/v1/inbox") as { notReady: Array<{ proposalId: string }> };
    assert.ok(inbox.notReady.some((item) => item.proposalId === RELEASED));
    assert.ok(inbox.notReady.some((item) => item.proposalId === UNRELEASED));
    const census = await get(base, "/v1/inbox/attention-census") as {
      sources: { archiveLedger: string }; items: Array<{ proposalId: string; attention: string }>;
    };
    assert.equal(census.sources.archiveLedger, "unavailable");
    assert.equal(census.items.find((item) => item.proposalId === RELEASED)?.attention, "decision");
  });
});

test("an archived release does not hide a task with an explicit dispatch hold", async (t) => {
  const world = fixture(false, "W1-T217");
  t.after(() => rmSync(world.root, { recursive: true, force: true }));
  await withServer(world.deps, async (base) => {
    const inbox = await get(base, "/v1/inbox") as { notReady: Array<{ proposalId: string }> };
    assert.ok(inbox.notReady.some((item) => item.proposalId === RELEASED));
    const census = await get(base, "/v1/inbox/attention-census") as {
      discrepancy?: string;
      items: Array<{ proposalId: string; attention: string; whyMe: string; sourceFacts: Array<{ detail: string }> }>;
    };
    const row = census.items.find((item) => item.proposalId === RELEASED);
    assert.equal(row?.attention, "decision");
    assert.match(row?.whyMe ?? "", /dispatch hold/i);
    assert.ok(row?.sourceFacts.some((fact) => fact.detail.includes("RELEASE-217")));
    assert.ok(row?.sourceFacts.some((fact) => fact.detail.includes("machine-authored")));
    assert.equal(census.discrepancy, "active_human_ask_has_release_receipt");
  });
});

test("W1-T4768: a live positive release remains proven when a retained archive is unreadable", async (t) => {
  const world = fixture(true);
  t.after(() => rmSync(world.root, { recursive: true, force: true }));
  appendFileSync(world.ledgerPath, JSON.stringify({ step: "ratify.approved", task_id: "W1-T216",
    released: "verify-human", run_id: "LIVE-216", ts: "2026-09-29T12:00:00.000Z" }) + "\n");
  await withServer(world.deps, async (base) => {
    const census = await get(base, "/v1/inbox/attention-census") as {
      sources: { archiveLedger: string }; items: Array<{ proposalId: string; attention: string; sourceFacts: Array<{ detail: string }> }>;
    };
    assert.equal(census.sources.archiveLedger, "unavailable");
    assert.equal(census.items.find((item) => item.proposalId === UNRELEASED)?.attention, "history");
    assert.ok(census.items.find((item) => item.proposalId === UNRELEASED)?.sourceFacts.some((fact) => fact.detail.includes("LIVE-216")));
    assert.equal(census.items.find((item) => item.proposalId === RELEASED)?.attention, "decision",
      "the archived-only release remains unproven during the read fault");
  });
});
