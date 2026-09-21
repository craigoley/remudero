import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildContextControlsRoutes, exportGovernedContext } from "../src/lib/context-controls.js";
import { CONTEXT_ITEM_STEP, type ContextItem } from "../src/lib/operator-agent.js";
import { appendLedger } from "../src/lib/ledger.js";

const READ = "context-controls-export-read";
const WRITE = "context-controls-export-write";
const NOW = "2026-09-21T00:00:00.000Z";

function context(contextId: string, overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    version: "context-item-v1",
    contextId,
    source: "assistant-summary:thread-1",
    principal: "operator:alice",
    purpose: "plan-work",
    sensitivity: "moderate",
    authorityRef: "consent:alice:plan",
    observedAt: NOW,
    freshness: "fresh",
    retention: { policy: "short", expiresAt: "2026-09-22T00:00:00.000Z" },
    visibility: "private",
    derivationLinks: [],
    revocation: { state: "active" },
    content: "operator prefers a bearer sk-ABCDEFGHIJKLMNOP token to never appear in export",
    ...overrides,
  };
}

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-context-controls-export-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return join(root, "state", "ledger.ndjson");
}

function register(ledgerPath: string, item: ContextItem): void {
  appendLedger(ledgerPath, { run_id: "context-controls-export", task_id: item.contextId, step: CONTEXT_ITEM_STEP, context: item });
}

async function withService<T>(ledgerPath: string, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({
    tokens: { read: READ, write: WRITE },
    routes: buildContextControlsRoutes({ ledgerPath, now: () => Date.parse(NOW) }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function exportUrl(base: string, principal: string, purpose: string, authorityRef: string): string {
  const params = new URLSearchParams({ principal, purpose, authorityRef });
  return `${base}/v1/context-controls/export?${params.toString()}`;
}

test("unit test: export is scoped to principal+purpose+authority, redacted, and bounded", async () => {
  const ledgerPath = setup();
  const alice = context("ctx:export:alice");
  const bob = context("ctx:export:bob", { principal: "operator:bob", authorityRef: "consent:bob:plan" });
  const wrongPurpose = context("ctx:export:other-purpose", { purpose: "draft-email" });
  for (const item of [alice, bob, wrongPurpose]) register(ledgerPath, item);

  await withService(ledgerPath, async (base) => {
    const missingParams = await fetch(`${base}/v1/context-controls/export?principal=operator:alice`, { headers: { authorization: `Bearer ${READ}` } });
    assert.equal(missingParams.status, 400);

    const res = await fetch(exportUrl(base, alice.principal, alice.purpose, alice.authorityRef), { headers: { authorization: `Bearer ${READ}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; exportId: string; items: Array<Record<string, unknown>> };
    assert.equal(body.status, "completed");
    assert.deepEqual(body.items.map((item) => item.contextId), [alice.contextId]);

    // Scoped: bob's context and the other-purpose context never appear.
    assert.equal(body.items.some((item) => item.contextId === bob.contextId), false);
    assert.equal(body.items.some((item) => item.contextId === wrongPurpose.contextId), false);

    // Redacted: raw content never crosses; secrets are scrubbed even from the bounded preview.
    const exported = body.items[0] as { redactedContent: string };
    assert.notEqual(exported.redactedContent, alice.content);
    assert.equal(exported.redactedContent.includes("sk-ABCDEFGHIJKLMNOP"), false);
    assert.equal(JSON.stringify(body).includes("sk-ABCDEFGHIJKLMNOP"), false);
    assert.ok(exported.redactedContent.includes("[redacted]"));
    assert.equal("content" in exported, false);

    // Scoping to bob returns bob's own item, not alice's.
    const bobRes = await fetch(exportUrl(base, bob.principal, bob.purpose, bob.authorityRef), { headers: { authorization: `Bearer ${READ}` } });
    const bobBody = (await bobRes.json()) as { items: Array<Record<string, unknown>> };
    assert.deepEqual(bobBody.items.map((item) => item.contextId), [bob.contextId]);
  });
});

test("unit test: export refuses (never completes) when no context matches the requested scope", async () => {
  const ledgerPath = setup();
  await withService(ledgerPath, async (base) => {
    const res = await fetch(exportUrl(base, "operator:nobody", "plan-work", "consent:nobody:plan"), { headers: { authorization: `Bearer ${READ}` } });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { status: string; reason: string };
    assert.equal(body.status, "refused");
    assert.equal(body.reason, "absent");
  });
});

test("unit test: export refuses rather than completing when source coverage is incomplete", async () => {
  const ledgerPath = setup();
  const source = context("ctx:export-coverage:source");
  const derived = context("ctx:export-coverage:derived", { derivationLinks: [source.contextId] });
  for (const item of [source, derived]) register(ledgerPath, item);

  await withService(ledgerPath, async (base) => {
    // Before revoking the source, export completes normally.
    const before = await fetch(exportUrl(base, source.principal, source.purpose, source.authorityRef), { headers: { authorization: `Bearer ${READ}` } });
    const beforeBody = (await before.json()) as { status: string; items: Array<Record<string, unknown>> };
    assert.equal(beforeBody.status, "completed");
    assert.equal(beforeBody.items.length, 2);

    // Revoke ONLY the source through the same self-service surface.
    const revoke = await fetch(`${base}/v1/context-controls/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" },
      body: JSON.stringify({ contextId: source.contextId, authorityRef: source.authorityRef }),
    });
    assert.equal(revoke.status, 200);

    // The falsifier this proof exists for: incomplete coverage must NEVER be reported "completed".
    const after = await fetch(exportUrl(base, source.principal, source.purpose, source.authorityRef), { headers: { authorization: `Bearer ${READ}` } });
    assert.equal(after.status, 409);
    const afterBody = (await after.json()) as { status: string; reason: string; incompleteContextIds: string[] };
    assert.equal(afterBody.status, "refused");
    assert.notEqual(afterBody.status, "completed");
    assert.equal(afterBody.reason, "incomplete_coverage");
    assert.ok(afterBody.incompleteContextIds.includes(derived.contextId), "the derived item depends on the now-revoked source");
  });
});

test("unit test: export refuses beyond the bounded item limit", () => {
  const ledgerPath = setup();
  const principal = "operator:bulk";
  const purpose = "plan-work";
  const authorityRef = "consent:bulk:plan";
  for (let index = 0; index < 201; index++) {
    register(ledgerPath, context(`ctx:export-bulk:${index}`, { principal, authorityRef }));
  }
  const result = exportGovernedContext({ ledgerPath, now: () => Date.parse(NOW) }, { principal, purpose, authorityRef });
  assert.equal(result.status, "refused");
  assert.equal((result as { reason: string }).reason, "bounded_exceeded");
});
