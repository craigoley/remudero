// /v1/status is only as fresh as its stalest source. A long-lived serve showed GitHub facts 40 minutes old
// while the page's own staleness said fresh, because the envelope described only when the page was computed.

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import { buildStatusRoute } from "../src/lib/board.js";
import { createConsoleSnapshotCache, RouteResponseBuffer } from "../src/lib/console-snapshot-cache.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const TTL_MS = 150_000;

function statusRoute(facts: { ageMs: number }) {
  const ledgerPath = writeLedger().path;
  const plan = { tasks: [], byId: new Map() } as unknown as Plan;
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    listOpenHeadBranches: () => [],
    factsAgeMs: () => facts.ageMs,
    factsStale: () => facts.ageMs >= TTL_MS,
  };
  return buildStatusRoute({ plan, ledgerPath, github });
}

function request(): IncomingMessage {
  return { method: "GET", url: "/v1/status", headers: {} } as unknown as IncomingMessage;
}

async function read(handler: (req: IncomingMessage, res: ServerResponse, ctx: { params: Record<string, string> }) => unknown): Promise<Record<string, any>> {
  const buffer = new RouteResponseBuffer();
  await handler(request(), buffer as unknown as ServerResponse, { params: {} });
  return JSON.parse(buffer.buffered(0).body) as Record<string, any>;
}

test("a memoized board re-reads the github facts age on every read", async () => {
  const facts = { ageMs: 10_000 };
  const route = statusRoute(facts);
  const first = await read(route.handler);
  assert.equal(first.github_facts_status, "fresh");
  facts.ageMs = 2_419_000;
  const second = await read(route.handler);
  assert.equal(second.github_facts_age_ms, 2_419_000, "the memo hit reports the age now, not when it was computed");
  assert.equal(second.github_facts_status, "stale");
});

test("a status page whose github facts are stale is never labelled fresh", async () => {
  const facts = { ageMs: 2_419_000 };
  const cache = createConsoleSnapshotCache(statusRoute(facts), { budgetMs: 750, fallbackBody: () => ({}) });
  const stale = await read(cache.handler);
  assert.equal(stale.github_facts_status, "stale");
  assert.equal(stale.staleness.status, "stale", "the page is as stale as its stalest source");
  assert.equal(stale.staleness.stale, true);
  assert.equal(stale.staleness.reason, "github facts 2419 s old");

  const freshFacts = { ageMs: 10_000 };
  const freshCache = createConsoleSnapshotCache(statusRoute(freshFacts), { budgetMs: 750, fallbackBody: () => ({}) });
  const fresh = await read(freshCache.handler);
  assert.equal(fresh.staleness.status, "fresh", "fresh facts leave a just-computed page fresh");
  assert.equal(fresh.staleness.reason, undefined);
});
