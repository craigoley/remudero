import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { defaultInstanceInboxSources } from "../src/lib/instance-gateway.js";
import { mountInstanceInboxRoutes } from "../src/lib/instance-inbox-contract.js";
import { inboxThreadId } from "../src/lib/inbox-thread.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}instance-reframe-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), ledgerPath = join(stateDir, "ledger.ndjson");
  mkdirSync(stateDir);
  const registry = join(stateDir, "inbox-proposals.json"), drafts = join(stateDir, "inbox-drafts.json");
  const proposal = { id: "verify-human:W1-T216", summary: "Held security drill", evidenceAnchors: [], conflictsWith: [], reframeHistory: [] };
  const store = (summary = proposal.summary) => writeFileSync(registry, JSON.stringify({ proposals: [{ ...proposal, summary }] }));
  store(); writeFileSync(drafts, JSON.stringify({ [proposal.id]: { old: "draft" }, unrelated: { retained: true } }));
  writeFileSync(ledgerPath, "");
  const planPath = join(root, "repos/site/plan/tasks.yaml"), coreState = join(root, "core-registry.json");
  mkdirSync(join(root, "repos/site/plan"), { recursive: true });
  writeFileSync(planPath, '- id: W1-T216\n  risk: high\n  dispatch_hold: security-drill-awaits-ruling\n');
  writeFileSync(coreState, JSON.stringify({ proposals: [{ id: proposal.id, summary: "Core owns a different ask" }] }));
  const source = { instance: "site", root, ledgerPath, planPath };
  const routes = defaultInstanceInboxSources(source, "owner/site", { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined });
  const binding = { instance: "site", repository: "owner/site", stateDir, routes };
  const start = async () => {
    const app = createService({ routes: mountInstanceInboxRoutes(binding), tokens: { read: "instance-read", write: "instance-write" } });
    await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
    t.after(() => { app.closeAllConnections(); app.close(); });
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { authorization: "Bearer instance-write", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
  };
  const request = (snapshotKey: unknown, intentId = "reframe-intent-1") => ({ instance: "site", repository: "owner/site", threadId: inboxThreadId(proposal.id), proposalId: proposal.id, snapshotKey, intentId, feedback: "Keep the explicit security hold; improve the evidence." });
  return { root, registry, drafts, ledgerPath, proposal, store, start, request, planPath, coreState };
}

test("instance proposal reads advertise a source-owned reversible action and reject foreign scope", async t => {
  const f = fixture(t), call = await f.start();
  const view = await call("GET", `/v1/i/site/inbox/proposal?id=${encodeURIComponent(f.proposal.id)}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.repository, "owner/site"); assert.equal(view.body.instance, "site");
  assert.deepEqual(view.body.actions, [{ action: "reframe", tier: "low", path: "/v1/i/site/inbox/reframe" }]);
  assert.match(String(view.body.snapshotKey), /^[a-f0-9]{64}$/);
  assert.equal((await call("GET", "/v1/i/site/inbox/proposal?id=x&repository=owner/core")).status, 409);
  assert.equal((await call("GET", "/v1/i/site/inbox/proposal?id=missing")).status, 404);
  const root = { instance: "site", root: f.root, ledgerPath: f.ledgerPath, planPath: join(f.root, "plan/tasks.yaml") };
  const paths = defaultInstanceInboxSources(root, "owner/site", { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined }).map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes("GET /v1/inbox") && paths.includes("GET /v1/inbox/attention-census"));
  assert.ok(paths.includes("POST /v1/inbox/reframe"));
  assert.ok(!paths.some(p => /approve|decline|cost-ceiling/.test(p)), "the full write bundle is never mounted");
});

test("an instance refuses a stale proposal or forged reframe before changing its source", async t => {
  const f = fixture(t), call = await f.start();
  const view = await call("GET", `/v1/i/site/inbox/proposal?id=${encodeURIComponent(f.proposal.id)}`);
  f.store("Changed evidence");
  const before = [f.registry, f.drafts, f.ledgerPath].map(p => readFileSync(p, "utf8"));
  const stale = await call("POST", "/v1/i/site/inbox/reframe", f.request(view.body.snapshotKey));
  assert.equal(stale.status, 409); assert.equal(stale.body.error, "proposal_snapshot_changed");
  const foreign = await call("POST", "/v1/i/site/inbox/reframe", { ...f.request(view.body.snapshotKey), repository: "owner/core" });
  assert.equal(foreign.status, 409);
  assert.equal((await call("POST", "/v1/i/site/inbox/reframe", { ...f.request(view.body.snapshotKey), proposalId: "other" })).status, 400);
  assert.deepEqual([f.registry, f.drafts, f.ledgerPath].map(p => readFileSync(p, "utf8")), before);
});

test("a source-owned reframe survives concurrent replay and restart without repeating feedback", async t => {
  const f = fixture(t), call = await f.start();
  const view = await call("GET", `/v1/i/site/inbox/proposal?id=${encodeURIComponent(f.proposal.id)}`);
  const body = { ...f.request(view.body.snapshotKey), feedback: "  Keep the explicit security hold; improve the evidence.\n" };
  const protectedSources = [f.planPath, f.coreState].map(p => readFileSync(p, "utf8"));
  const answers = await Promise.all([call("POST", "/v1/i/site/inbox/reframe", body), call("POST", "/v1/i/site/inbox/reframe", body)]);
  assert.ok(answers.every(r => r.status === 200));
  const restart = await f.start();
  assert.equal((await restart("POST", "/v1/i/site/inbox/reframe", body)).status, 200);
  assert.equal((await restart("POST", "/v1/i/site/inbox/reframe", { ...body, feedback: "different" })).status, 409);
  const registry = JSON.parse(readFileSync(f.registry, "utf8"));
  const history = registry.proposals[0].reframeHistory;
  assert.equal(history.length, 1);
  const { input, ...originalFields } = history[0];
  assert.deepEqual(originalFields, { feedback: body.feedback });
  assert.match(input.id, /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...input, id: undefined }, { id: undefined, repository: "owner/site", proposalId: f.proposal.id,
    threadId: inboxThreadId(f.proposal.id), contentSha256: createHash("sha256").update(body.feedback).digest("hex") });
  assert.deepEqual(JSON.parse(readFileSync(f.drafts, "utf8")), { unrelated: { retained: true } });
  const rows = readFileSync(f.ledgerPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(rows.filter(r => r.step === "ratify.reframed").length, 1);
  assert.deepEqual(rows.find(r => r.step === "ratify.reframed").input, input, "the unchanged source-owned action records its exact captured input");
  assert.equal(rows.filter(r => r.step === "panel.proposal_reframe_requested").length, 1);
  assert.ok(rows.every(r => r.task_id === f.proposal.id));
  assert.ok(!rows.some(r => r.step === "ratify.approved"));
  assert.deepEqual([f.planPath, f.coreState].map(p => readFileSync(p, "utf8")), protectedSources);
});

test("an unavailable instance reframe stays unknown while an old daemon remains read-only", async t => {
  const f = fixture(t), call = await f.start();
  const view = await call("GET", `/v1/i/site/inbox/proposal?id=${encodeURIComponent(f.proposal.id)}`);
  writeFileSync(f.drafts, "{broken");
  const before = readFileSync(f.registry, "utf8");
  const failed = await call("POST", "/v1/i/site/inbox/reframe", f.request(view.body.snapshotKey));
  assert.equal(failed.status, 503); assert.equal(failed.body.delivery, "unknown");
  assert.equal(readFileSync(f.registry, "utf8"), before); assert.equal(readFileSync(f.ledgerPath, "utf8"), "");
  assert.equal((await call("POST", "/v1/i/site/inbox/reframe", f.request(view.body.snapshotKey))).status, 409);
  rmSync(f.registry);
  const old = await call("POST", "/v1/i/site/inbox/reframe", f.request(view.body.snapshotKey, "old-daemon-intent"));
  assert.equal(old.body.error, "inbox_read_only");
});

test("instance proposal source faults are unavailable rather than an empty successful read", async t => {
  const f = fixture(t), call = await f.start();
  for (const contents of ['{broken', '{"proposals":{}}', '{"proposals":[{"id":"x"}]}', '{"proposals":[null]}']) {
    writeFileSync(f.registry, contents);
    const read = await call("GET", "/v1/i/site/inbox/proposal?id=x");
    assert.equal(read.status, 503); assert.equal(read.body.error, "proposal_source_unavailable");
  }
});

test("a missing instance draft cache can be rebuilt but an unreadable cache holds reframe", async t => {
  const absent = fixture(t), call = await absent.start();
  const view = await call("GET", `/v1/i/site/inbox/proposal?id=${encodeURIComponent(absent.proposal.id)}`);
  rmSync(absent.drafts);
  assert.equal((await call("POST", "/v1/i/site/inbox/reframe", absent.request(view.body.snapshotKey))).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(absent.drafts, "utf8")), {});
  const unreadable = fixture(t), other = await unreadable.start();
  const held = await other("GET", `/v1/i/site/inbox/proposal?id=${encodeURIComponent(unreadable.proposal.id)}`);
  rmSync(unreadable.drafts); mkdirSync(unreadable.drafts);
  assert.equal((await other("POST", "/v1/i/site/inbox/reframe", unreadable.request(held.body.snapshotKey))).status, 503);
  assert.equal(readFileSync(unreadable.ledgerPath, "utf8"), "");
});
