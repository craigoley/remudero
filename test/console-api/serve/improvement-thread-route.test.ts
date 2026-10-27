import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { buildServeRoutes, type ServeDeps } from "#src/lib/serve.js";
import { createService, createConfirmNonceStore, type IdentityProvider } from "#src/lib/service.js";
import { captureInboxDraftSnapshot, commitInboxDraftOutcomes, type Proposal } from "#src/lib/inbox.js";
import type { ImprovementThreadView, ImprovementActionResult, ImprovementThreadResult } from "#src/lib/improvement-thread.js";
import { withTempDir } from "#src/lib/tmp.js";
import { sourceFixture } from "#test/helpers/improvement-thread-fixture.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { declaredBody, violations } from "#test/helpers/openapi-strict.js";

const identity: IdentityProvider = {
  name: "verified-test-operator", grant: () => undefined,
  authorize: req => req.headers["x-test-operator"] === "verified"
    ? { scopes: new Set(["read", "write"]), tier: "high", actor: "operator:test" } : undefined,
};

test("improvement routes persist conversations and reviewed decisions through production assembly", async () => {
  await withTempDir("improvement-served-contract", async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir);
    const questionsRoot = join(dir, "separate-checkout"), planPath = join(questionsRoot, "plan", "tasks.yaml");
    mkdirSync(join(questionsRoot, "plan"), { recursive: true }); writeFileSync(planPath, "[]\n");
    const ledgerPath = join(deps.stateDir, "ledger.ndjson"); writeFileSync(ledgerPath, "");
    const serveDeps: ServeDeps = {
      board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github: fakeGitHub() },
      panelGraph: { root: questionsRoot, planPath, ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(),
        ratify: { approve: () => assert.fail("saving a decision cannot ratify"), reframe: () => assert.fail("saving a goal cannot reframe") } },
      ledgerPath, issues: { close: () => assert.fail("saving a decision cannot close issues") },
      fleetControlRoot: join(dir, "fleet"), questionsRoot, tokens: { read: "route-read", write: "route-write" },
    };
    async function start() {
      const confirmNonces = createConfirmNonceStore();
      const routes = buildServeRoutes({ ...serveDeps, confirmNonces });
      const server = createService({ tokens: serveDeps.tokens, operatorSession: identity, routes, confirmNonces,
        enforceWriteTiers: true, log: () => {} });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return { base, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
    }
    let app = await start();
    async function send<T>(path: string, body?: unknown, auth: "operator" | "write" | "read" | "none" = "operator", nonce?: string) {
      const method = body === undefined ? "GET" : "POST";
      const response = await fetch(app.base + path, { method, headers: {
        ...(auth === "none" ? {} : { authorization: `Bearer ${auth === "read" ? "route-read" : "route-write"}` }),
        ...(auth === "operator" ? { "x-test-operator": "verified" } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }), ...(nonce ? { "x-confirm-nonce": nonce } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json();
      assert.deepEqual(violations(result, declaredBody(path.split("?")[0]!, method, response.status)), [], `${method} ${path}: ${JSON.stringify(result)}`);
      return { status: response.status, body: result as T };
    }
    try {
      assert.equal((await send("/v1/improvements/threads", request, "none")).status, 401);
      assert.equal((await send("/v1/improvements/threads", request, "read")).status, 403);
      assert.equal((await send("/v1/improvements/threads", { ...request, approved: true })).status, 400);
      const saved = await send<ImprovementThreadResult>("/v1/improvements/threads", request);
      assert.equal(saved.status, 200); assert(saved.body.state === "saved");
      const { requestId, threadId, proposalId } = saved.body;
      const reopened = await send<ImprovementThreadView>(`/v1/improvements/thread?threadId=${encodeURIComponent(threadId)}`);
      assert.equal(reopened.status, 200); assert(reopened.body.state === "saved"); assert.equal(reopened.body.messages.length, 2);
      assert.equal(reopened.body.source.state, "current"); assert.equal(reopened.body.execution.state, "not_requested");
      const decision = { requestId, goalDigest: reopened.body.goalDigest, idempotencyKey: "http-draft-request-0001" };
      assert.equal((await send("/v1/improvements/threads/draft", decision, "write")).status, 403);
      const queued = await send<ImprovementActionResult>("/v1/improvements/threads/draft", decision);
      assert.equal(queued.status, 202); assert(queued.body.state === "requested");
      assert.equal(queued.body.operation.state, "requested"); assert.equal(queued.body.execution.state, "not_requested");
      const retry = await send<ImprovementActionResult>("/v1/improvements/threads/draft", decision);
      assert.deepEqual(retry.body, queued.body);
      const stateDir = join(inboxRoot, "state");
      assert.equal(existsSync(join(stateDir, "inbox-drafts.json")), false, "the service never drafts queued work itself");
      const proposal = (JSON.parse(readFileSync(join(stateDir, "inbox-proposals.json"), "utf8")) as { proposals: Proposal[] }).proposals.find(row => row.id === proposalId)!;
      assert.equal(proposal.trigger?.fired, false, "the HTTP request saves the decision; only the daemon-owned handoff requests drafting");
      const snapshot = captureInboxDraftSnapshot(proposal, { repository: request.repository });
      const candidate = { proposalId, fragmentYaml: "- id: W1-T99999\n  title: Simplify repeated work\n", stampLine: "Saved draft", anchorFingerprint: "",
        completion: { snapshot, lintClean: true, violations: [] } };
      commitInboxDraftOutcomes({ stateDir, scope: { repository: request.repository }, snapshots: [snapshot],
        outcomes: [{ ok: true, proposalId, candidate, snapshot }], log: () => {} });
      const ready = await send<ImprovementThreadView>(`/v1/improvements/thread?requestId=${requestId}`);
      assert(ready.body.state === "saved"); assert.equal(ready.body.drafting.state, "ready"); assert(ready.body.drafting.digest);
      const filing = { ...decision, idempotencyKey: "http-reviewed-file-0001", draftDigest: ready.body.drafting.digest };
      const path = "/v1/improvements/threads/file";
      assert.equal((await send(path, filing, "write")).status, 403);
      const missingNonce = await send<{ error: string }>(path, filing); assert.equal(missingNonce.status, 403);
      assert.equal(missingNonce.body.error, "confirm_nonce_required");
      const confirmation = await send<{ nonce: string }>("/v1/confirm", { method: "POST", path, payload: JSON.stringify(filing) });
      assert.equal(confirmation.status, 200);
      const filed = await send<ImprovementActionResult>(path, filing, "operator", confirmation.body.nonce);
      assert.equal(filed.status, 202); assert(filed.body.state === "requested");
      assert.equal(filed.body.operation.state, "requested"); assert.equal(filed.body.execution.state, "not_requested");
      assert.notEqual(filed.body.operation.operationId, queued.body.operation.operationId);
      assert.equal((await send(path, filing, "operator", confirmation.body.nonce)).status, 403, "the nonce is single use");
      await app.close(); app = await start();
      const recovered = await send<ImprovementThreadView>(`/v1/improvements/thread?requestId=${requestId}`);
      assert(recovered.body.state === "saved"); assert.equal(recovered.body.filing.state, "requested");
      assert.equal(recovered.body.filing.operationId, filed.body.operation.operationId);
      const receipt = await send<{ operation: unknown }>(`/v1/improvements/action?operationId=${filed.body.operation.operationId}`);
      assert.deepEqual(receipt.body.operation, filed.body.operation);
      assert.equal(readFileSync(ledgerPath, "utf8"), "");
      assert.equal(existsSync(join(questionsRoot, "state", "improvement-threads")), false);
      assert.equal(existsSync(join(inboxRoot, "repos", "atlas", "plan", "tasks.yaml")), false);
      // Damaged saved records behind the read routes are uncertain: never an absent decision or an unsaved chat.
      writeFileSync(join(deps.stateDir, "improvement-threads", "actions", `${filed.body.operation.operationId}.json`), "{corrupt");
      const damagedAction = await send<{ state: string }>(`/v1/improvements/action?operationId=${filed.body.operation.operationId}`);
      assert.equal(damagedAction.status, 503); assert.equal(damagedAction.body.state, "uncertain");
      const linkDir = join(deps.stateDir, "improvement-threads", "thread-links"), links = readdirSync(linkDir);
      assert.equal(links.length, 1, "the saved link corpus was observed"); writeFileSync(join(linkDir, links[0]!), "{corrupt");
      const damagedLink = await send<{ state: string }>(`/v1/improvements/thread?threadId=${encodeURIComponent(threadId)}`);
      assert.equal(damagedLink.status, 503); assert.equal(damagedLink.body.state, "uncertain");
    } finally { await app.close(); }
  });
});
