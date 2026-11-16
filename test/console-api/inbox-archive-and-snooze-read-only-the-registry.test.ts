/**
 * W1-T13235: after W1-T13188, POST /v1/inbox/snooze still took up to 11,002 ms and /v1/inbox/archive 2,913 ms on
 * 2026-11-16, because each loaded and projected the plan and read the ledger to check that a proposal exists. They now
 * read the proposals registry alone. The plan path here points at no file, so any plan read fails the request.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createService } from "#src/lib/service.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

type TestCtx = { after: (fn: () => void) => void };
const WRITE_TOKEN = "registry-only-write-token";
const A = "verify-human:W9-T1";

function world(t: TestCtx, ids: string[]): { deps: PanelGraphDeps; registry: string } {
  const root = makeTempDir("rmd-inbox-registry-only");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const registry = join(stateDir, "inbox-proposals.json");
  writeFileSync(registry, JSON.stringify({ proposals: ids.map((id) => ({ id, summary: `about ${id}`, evidenceAnchors: [] })) }));
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath: join(root, "plan", "absent-tasks.yaml"), ledgerPath,
    github: { prView: () => null },
    statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40),
    inboxGrepAnchor: () => true,
    inboxClock: fixedClock(Date.parse("2026-11-16T19:00:00.000Z")),
  };
  return { deps, registry };
}

async function post(deps: PanelGraphDeps, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createService({ tokens: { read: "registry-only-read-token", write: WRITE_TOKEN }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
      { method: "POST", headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

test("W1-T13235 criterion 1: archive and snooze answer from the registry with no plan to read", async (t) => {
  const { deps } = world(t, [A]);
  const archived = await post(deps, "/v1/inbox/archive", { proposalId: A, archived: true });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.archived, true);
  const snoozed = await post(deps, "/v1/inbox/snooze", { proposalId: A, until: "2026-11-17T09:00:00Z" });
  assert.equal(snoozed.status, 200, JSON.stringify(snoozed.body));
  assert.equal(snoozed.body.snoozedUntil, "2026-11-17T09:00:00Z");
  for (const path of ["/v1/inbox/archive", "/v1/inbox/snooze"]) {
    const missing = await post(deps, path, { proposalId: "verify-human:W9-T404", archived: true, until: null });
    assert.equal(missing.status, 404, `${path}: ${JSON.stringify(missing.body)}`);
    assert.equal(missing.body.error, "not_found");
  }
});

test("W1-T13235 criterion 2: an id the registry gains is found on the next call", async (t) => {
  const { deps, registry } = world(t, [A]);
  const B = "verify-human:W9-T2";
  assert.equal((await post(deps, "/v1/inbox/archive", { proposalId: B, archived: true })).status, 404, "positive control: absent at first");
  writeFileSync(registry, JSON.stringify({ proposals: [A, B].map((id) => ({ id, summary: `about ${id}`, evidenceAnchors: [] })) }));
  assert.equal((await post(deps, "/v1/inbox/archive", { proposalId: B, archived: true })).status, 200);
});

test("W1-T13235 criterion 3: decline still classifies before it acts, so with no plan it cannot answer ok", async (t) => {
  const { deps } = world(t, [A]);
  const declined = await post(deps, "/v1/inbox/decline", { proposalId: A, reason: "not now" });
  assert.notEqual(declined.status, 200, `decline still reads the plan: ${JSON.stringify(declined.body)}`);
});
