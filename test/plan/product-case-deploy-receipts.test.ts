import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { ProductDeploymentService, vercelDeploymentProvider } from "#src/lib/product-deployment.js";
import { buildProductCaseRoutes } from "#src/lib/product-routes.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { declaredBody, violations } from "#test/helpers/openapi-strict.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const actor = "clerk:alice", team = "team_fixture", head = "a".repeat(40);
const repository = { id: 1234, owner: "fixture", name: "game" };
const now = "2026-10-29T00:00:00.000Z";

async function fixture(t: TestContext, hostedChange?: string) {
  const root = ownedFixtureDir(t, "case-deploy-receipts").dir;
  const store = new ProductIntentStore({ root });
  const saved = store.write(actor, { version: "product-intent-v1", requestId: "deploy-import-000001", expectedRevision: 0, brief: { idea: "fixture game" } });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  const hostedReceipt = { channel: "hosted" as const, actor, productId, objectiveRevision: 1, repository, operationId: `pbuild_${"b".repeat(64)}`,
    runId: "fixture-run", taskId: "W9-T1", head, execution: "ended" as const, contexts: [{ name: "test", conclusion: "success" }], review: "success" as const, reason: "native review: success" };
  if (hostedChange === "foreign actor") hostedReceipt.actor = "clerk:bob";
  if (hostedChange === "foreign product") hostedReceipt.productId = `prd_${"e".repeat(32)}`;
  if (hostedChange === "foreign repository") hostedReceipt.repository = { ...repository, id: 999 };
  if (hostedChange === "wrong objective") hostedReceipt.objectiveRevision = 2;
  assert.ok(store.transition(actor, { version: "product-intent-v1", requestId: "deploy-repository-001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1,
    repository: { ...repository, provider: "github", defaultBranch: "main", visibility: "public", verifiedAt: now },
    stageEvidence: [{ id: "case-hosted:fixture", stage: "build", outcome: "succeeded", objectiveRevision: 1, observedAt: now,
      references: [{ label: "Hosted qualification", url: "https://github.com/fixture/game/pull/8" }],
      ...(hostedChange === "legacy" ? {} : { receipt: hostedReceipt }) }] }).ok);
  if (hostedChange === "later failed") assert.ok(store.transition(actor, { version: "product-intent-v1", requestId: "later-hosted-000001", id: productId,
    expectedRevision: 2, expectedObjectiveRevision: 1,
    stageEvidence: [{ id: "case-hosted:later", stage: "build", outcome: "failed", objectiveRevision: 1, observedAt: now, references: [], receipt: hostedReceipt }] }).ok);
  const previousFetch = globalThis.fetch;
  const previousEnv = { VERCEL_TOKEN: process.env.VERCEL_TOKEN, VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID, VERCEL_API_URL: process.env.VERCEL_API_URL };
  process.env.VERCEL_TOKEN = "fixture-secret"; process.env.VERCEL_TEAM_ID = team;
  process.env.VERCEL_API_URL = "https://api.vercel.example";
  t.after(() => { globalThis.fetch = previousFetch; for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  let deployment = { id: "dpl_fixture", projectId: "prj_fixture", ownerId: team, readyState: "READY", target: null as string | null, createdAt: Date.parse(now),
    gitSource: { type: "github", repoId: repository.id, sha: head }, url: "fixture.vercel.app" };
  let httpStatus = 200, unreadable = false, truncated = false, probes = 0;
  let loseResponse = false;
  let others: typeof deployment[] = [];
  let providerReply: ((url: URL) => Response | undefined) | undefined;
  let probeBody: () => BodyInit = () => "game";
  let beforeProbe: (() => void) | undefined;
  const calls: { url: URL; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.hostname === "fixture.vercel.app") {
      probes++; beforeProbe?.();
      assert.equal(init?.headers, undefined, "provider credential never reaches the served URL");
      assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
      return new Response(httpStatus === 204 ? null : probeBody(), { status: httpStatus });
    }
    assert.equal(init?.method, "GET", "observation and adoption are read-only");
    assert.equal(url.searchParams.get("teamId"), team);
    if (unreadable) throw new Error("provider transport failed");
    const override = providerReply?.(url); if (override) return override;
    if (url.pathname.startsWith("/v9/projects/")) return Response.json({ id: "prj_fixture", name: "fixture", accountId: team,
      link: { type: "github", org: repository.owner, repo: repository.name, repoId: repository.id } });
    if (url.pathname === "/v6/deployments") {
      assert.equal(url.searchParams.get("projectId"), "prj_fixture");
      return Response.json({ deployments: [deployment, ...others].map(item => ({ uid: item.id })), pagination: { next: truncated ? 10 : null } });
    }
    const found = [deployment, ...others].find(item => url.pathname === `/v13/deployments/${item.id}`);
    assert.ok(found, url.pathname);
    return Response.json({ ...found, gitSource: url.searchParams.get("withGitRepoInfo") === "true" ? found.gitSource : undefined });
  };
  const binding = await new ProductDeploymentService({ root }).execute(actor, { version: "product-deployment-v1", requestId: "deploy-adopt-000001",
    productId, action: "adopt", teamId: team, projectId: "prj_fixture", projectName: "fixture", repository,
    expectedRevision: hostedChange === "later failed" ? 3 : 2, expectedObjectiveRevision: 1 });
  assert.ok(binding.ok, JSON.stringify(binding));
  const operationId = binding.value.receipt.operationId;
  const current = () => { const read = store.read(actor, productId); assert.ok(read.ok); return read.value; };
  const command = () => ({ version: "product-case-v1", action: "observe-deployment", command: {
    productId, operationId, expectedRevision: current().revision, expectedObjectiveRevision: current().objectiveRevision } });
  const request = async (input: unknown = command(), extra: object = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(input))]);
    Object.assign(req, { [Symbol.for("remudero.service.verifiedActor")]: actor });
    let body = "";
    const res = { setHeader() {}, writeHead(status: number) { this.statusCode = status; }, statusCode: 200, end(value: string) {
      if (loseResponse) { loseResponse = false; throw new Error("response lost after durable commit"); }
      body = value;
    } };
    await buildProductCaseRoutes({ root, planText: async () => JSON.stringify({ number: 8, merged_at: null, merge_commit_sha: null,
      head: { sha: head }, base: { ref: "main", repo: { id: repository.id } } }), ...extra })[0]!.handler(req as never, res as never, {} as never);
    const parsed = JSON.parse(body);
    assert.deepEqual(violations(parsed, declaredBody("/v1/products/case", "POST", res.statusCode)), []);
    return { status: res.statusCode, body: parsed };
  };
  return { root, store, productId, operationId, command, request, current, calls,
    get deployment() { return deployment; }, set deployment(value) { deployment = value; },
    set status(value: number) { httpStatus = value; }, set unreadable(value: boolean) { unreadable = value; },
    set truncated(value: boolean) { truncated = value; }, get probes() { return probes; },
    set loseResponse(value: boolean) { loseResponse = value; },
    set others(value: typeof others) { others = value; }, set providerReply(value: typeof providerReply) { providerReply = value; },
    set probeBody(value: () => BodyInit) { probeBody = value; }, set beforeProbe(value: () => void) { beforeProbe = value; } };
}

test("W1-T10866: deployment binds its tested source project and answering URL", async t => {
  const f = await fixture(t);
  const reply = await f.request();
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const evidence = reply.body.evidence.deploy;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].outcome, "succeeded"); assert.equal(evidence[0].current, true);
  assert.deepEqual(evidence[0].receipt, { channel: "deploy", actor, productId: f.productId, objectiveRevision: 1,
    operationId: f.operationId, repository, projectId: "prj_fixture", teamId: team, deploymentId: "dpl_fixture",
    providerCreatedAt: Date.parse(now),
    target: "preview", commit: head, url: "https://fixture.vercel.app/", readyState: "READY", servedStatus: 200,
    outcome: "succeeded", reason: "served URL answered" });
  assert.equal(f.probes, 1);
  assert.equal(f.calls.find(call => call.url.pathname === "/v13/deployments/dpl_fixture")?.url.searchParams.get("withGitRepoInfo"), "true");
  const input = f.command();
  for (const injection of [{ url: "https://evil.invalid" }, { commit: head }, { outcome: "succeeded" }]) {
    assert.equal((await f.request({ ...input, command: { ...input.command, ...injection } })).status, 400);
  }
  assert.equal((await f.request({ ...input, command: { ...input.command, operationId: `pdeploy_${"f".repeat(64)}` } })).body.error, "binding_not_found");
  const journal = join(f.root, "state/products/v1/deployments", `${createHash("sha256").update(actor).digest("hex")}.json`);
  const original = readFileSync(journal, "utf8");
  for (const mismatch of ["product", "repository", "team", "objective"]) {
    const state = JSON.parse(original);
    const binding = Object.values(state.operations)[0] as { receipt: { productId: string; objectiveRevision: number; project: { teamId: string; repository: { id: number } } } };
    if (mismatch === "product") binding.receipt.productId = `prd_${"d".repeat(32)}`;
    if (mismatch === "repository") binding.receipt.project.repository.id++;
    if (mismatch === "team") binding.receipt.project.teamId = "team_foreign";
    if (mismatch === "objective") binding.receipt.objectiveRevision++;
    writeFileSync(journal, JSON.stringify(state));
    const calls = f.calls.length;
    const refusal = await f.request();
    assert.equal(refusal.status, 409, mismatch);
    assert.equal(f.calls.length, calls, "binding is re-read and refused before any external read");
  }
  writeFileSync(journal, original);
  assert.equal((await f.request()).body.replayed, true);
  writeFileSync(journal, "{");
  const corrupt = await f.request();
  assert.equal(corrupt.status, 503); assert.equal(corrupt.body.error, "corrupt");
  writeFileSync(journal, original);
});

test("W1-T10866: preview production and failed deployment outcomes stay separate", async t => {
  const cases = [
    ["project", "refusal", { projectId: "prj_foreign" }], ["team", "refusal", { ownerId: "team_foreign" }],
    ["repository", "refusal", { gitSource: { type: "github", repoId: 9, sha: head } }],
    ["untested", "blocked", { gitSource: { type: "github", repoId: repository.id, sha: "c".repeat(40) } }],
    ["building", "running", { readyState: "BUILDING" }], ["queued", "running", { readyState: "QUEUED" }],
    ["initializing", "running", { readyState: "INITIALIZING" }], ["blocked", "blocked", { readyState: "BLOCKED" }],
    ["error", "failed", { readyState: "ERROR" }], ["cancelled", "failed", { readyState: "CANCELED" }],
  ] as const;
  for (const [name, outcome, changes] of cases) await t.test(name, async t => {
    const f = await fixture(t); Object.assign(f.deployment, changes);
    const reply = await f.request();
    if (outcome === "refusal") { assert.equal(reply.status, 409); assert.equal(f.current().stageEvidence.length, 1); }
    else { assert.equal(reply.status, 200); assert.equal(reply.body.evidence.deploy[0].outcome, outcome); }
    assert.equal(f.probes, 0);
  });
  for (const [status, outcome] of [[204, "succeeded"], [401, "blocked"], [403, "blocked"], [500, "failed"], [302, "unknown"]] as const) await t.test(`served ${status}`, async t => {
    const f = await fixture(t); f.status = status;
    assert.equal((await f.request()).body.evidence.deploy[0].outcome, outcome);
  });
  for (const state of ["missing config", "unreadable", "truncated", "oversized"]) await t.test(state, async t => {
    const f = await fixture(t);
    if (state === "missing config") delete process.env.VERCEL_TOKEN;
    if (state === "unreadable") f.unreadable = true;
    if (state === "truncated") f.truncated = true;
    if (state === "oversized") f.probeBody = () => "x".repeat(65537);
    const reply = await f.request(); assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.evidence.deploy[0].outcome, "unknown");
  });
  const f = await fixture(t);
  const preview = await f.request();
  f.deployment.target = "production";
  const production = await f.request();
  assert.equal(production.body.evidence.deploy.length, 2);
  assert.notEqual(preview.body.evidence.deploy[0].id, production.body.evidence.deploy[1].id);
  assert.deepEqual(production.body.evidence.deploy.map((item: { receipt: { target: string } }) => item.receipt.target), ["preview", "production"]);
});

test("W1-T10866: preview production and failed deployment outcomes stay separate — source and transport controls", async t => {
  const merge = "c".repeat(40);
  await t.test("an older provider port cannot claim deployment evidence", async t => {
    const f = await fixture(t), provider = vercelDeploymentProvider();
    delete provider.deployments;
    const result = await new ProductDeploymentService({ root: f.root, provider }).observe(actor, f.productId, f.operationId);
    assert.ok(result.ok); assert.equal(result.deployments.length, 0);
    assert.match(result.reason!, /deployment reader unavailable/);
    assert.deepEqual(await new ProductDeploymentService({}).observe(actor, f.productId, f.operationId), { ok: false, code: "unavailable" });
  });
  await t.test("default source transport verifies the merged head", async t => {
    const f = await fixture(t); f.deployment.gitSource.sha = merge;
    const shim = ghShim([{ when: "api repos/fixture/game/pulls/8", stdout: JSON.stringify({ number: 8, merged_at: now, merge_commit_sha: merge,
      head: { sha: head }, base: { ref: "main", repo: { id: repository.id } } }) }]);
    const previousPath = process.env.PATH; process.env.PATH = `${shim.dir}:${previousPath}`;
    t.after(() => { process.env.PATH = previousPath; rmSync(shim.dir, { recursive: true, force: true }); });
    const reply = await f.request(undefined, { planText: undefined });
    assert.equal(reply.status, 200); assert.equal(reply.body.evidence.deploy[0].outcome, "succeeded");
    assert.equal(shim.calls().filter(call => call.includes("repos/fixture/game/pulls/8")).length, 1);
  });
  for (const change of ["matching", "foreign repository", "foreign head", "foreign base", "unmerged", "unreadable"]) await t.test(`merge ${change}`, async t => {
    const f = await fixture(t); f.deployment.gitSource.sha = merge;
    const planText = async () => {
      if (change === "unreadable") throw new Error("merge unavailable");
      return JSON.stringify({ number: 8, merged_at: change === "unmerged" ? null : now, merge_commit_sha: merge,
        head: { sha: change === "foreign head" ? "f".repeat(40) : head },
        base: { ref: change === "foreign base" ? "topic" : "main", repo: { id: change === "foreign repository" ? 999 : repository.id } } });
    };
    const reply = await f.request(undefined, { planText });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.evidence.deploy[0].outcome, change === "matching" ? "succeeded" : change === "unreadable" ? "unknown" : "blocked");
    assert.equal(f.probes, change === "matching" ? 1 : 0);
  });
  for (const change of ["http", "json", "oversize", "missing source", "identity", "empty", "target"]) await t.test(`provider ${change}`, async t => {
    const f = await fixture(t);
    f.providerReply = url => {
      if (!url.pathname.startsWith("/v13/") && change !== "empty") return undefined;
      if (change === "http") return new Response("refused", { status: 403 });
      if (change === "json") return new Response("not json");
      if (change === "oversize") return new Response("x".repeat(256 * 1024 + 1));
      if (change === "missing source") return Response.json({ ...f.deployment, gitSource: undefined });
      if (change === "identity") return Response.json({ ...f.deployment, id: "dpl_foreign" });
      if (change === "target") return Response.json({ ...f.deployment, target: "custom" });
      return Response.json({ deployments: [], pagination: { next: null } });
    };
    const reply = await f.request(); assert.equal(reply.status, 200);
    assert.equal(reply.body.evidence.deploy[0].outcome, "unknown"); assert.equal(f.probes, 0);
  });
  for (const change of ["timeout", "redirect", "invalid utf8", "body failure", "unrecognized"]) await t.test(`served ${change}`, async t => {
    const f = await fixture(t);
    if (change === "invalid utf8") f.probeBody = () => new Uint8Array([255, 254]);
    if (change === "timeout" || change === "redirect") f.probeBody = () => { throw new Error(`${change} refused`); };
    if (change === "body failure") f.probeBody = () => new ReadableStream({ start(controller) { controller.error(new Error("stream lost")); } });
    if (change === "unrecognized") f.deployment.readyState = "NEW_STATE";
    const reply = await f.request(); assert.equal(reply.status, 200);
    assert.equal(reply.body.evidence.deploy[0].outcome, change === "invalid utf8" ? "succeeded" : "unknown");
  });
  for (const change of ["later failed", "foreign actor", "foreign product", "foreign repository", "wrong objective", "legacy"]) await t.test(`hosted ${change}`, async t => {
    const f = await fixture(t, change);
    const reply = await f.request(); assert.equal(reply.status, 200);
    assert.equal(reply.body.evidence.deploy[0].outcome, "blocked"); assert.equal(f.probes, 0);
  });
});

test("W1-T10866: replay restart and concurrent edits preserve deployment history", async t => {
  const f = await fixture(t);
  f.deployment.readyState = "ERROR";
  const failed = await f.request(); assert.equal(failed.status, 200);
  f.deployment.readyState = "READY";
  const input = f.command();
  f.beforeProbe = () => {
    const product = f.current();
    assert.ok(f.store.transition(actor, { version: "product-intent-v1", requestId: `concurrent-edit-${product.revision.toString().padStart(4, "0")}`,
      id: f.productId, expectedRevision: product.revision, expectedObjectiveRevision: 1,
      stageEvidence: [{ id: `unrelated-${product.revision}`, stage: "research", outcome: "succeeded", objectiveRevision: 1, observedAt: now, references: [] }] }).ok);
  };
  const replies = await Promise.all([f.request(input), f.request(input)]);
  for (const reply of replies) assert.equal(reply.status, 200, JSON.stringify(reply.body));
  f.status = 204;
  const replay = await f.request(input);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.evidence.deploy.length, 2);
  assert.deepEqual(replay.body.evidence.deploy.map((item: { outcome: string }) => item.outcome), ["failed", "succeeded"]);
  assert.deepEqual(replay.body.evidence.deploy.map((item: { current: boolean }) => item.current), [false, true]);
  assert.equal(f.current().stageEvidence.filter(item => item.receipt?.channel === "deploy").length, 2);
});

test("W1-T10866: replay restart and concurrent edits preserve deployment history — stale and ordered controls", async t => {
  await t.test("a lost HTTP response replays the durable typed receipt after restart", async t => {
    const f = await fixture(t), command = f.command();
    f.loseResponse = true;
    await assert.rejects(f.request(command), /response lost after durable commit/);
    const durable = f.current(), stored = durable.stageEvidence.find(item => item.receipt?.channel === "deploy");
    assert.ok(stored);
    f.status = 204;
    const recovered = await f.request(command);
    assert.equal(recovered.status, 200); assert.equal(recovered.body.replayed, true);
    assert.equal(recovered.body.revision, durable.revision);
    assert.deepEqual(recovered.body.evidence.deploy[0].receipt, stored.receipt);
    assert.equal(recovered.body.evidence.deploy[0].current, true);
    assert.equal(f.current().stageEvidence.filter(item => item.receipt?.channel === "deploy").length, 1);
  });
  await t.test("receipts saved with the earlier metadata hash retain their identity and typed data", async t => {
    const f = await fixture(t), command = f.command(), product = f.current();
    const receipt = { channel: "deploy" as const, actor, productId: f.productId, objectiveRevision: 1,
      operationId: f.operationId, repository, projectId: "prj_fixture", teamId: team, deploymentId: "dpl_fixture",
      providerCreatedAt: Date.parse(now), target: "preview" as const, commit: head, url: "https://fixture.vercel.app/",
      readyState: "READY", servedStatus: 200, outcome: "succeeded" as const, reason: "served URL answered" };
    const id = `case-deploy:${createHash("sha256").update(JSON.stringify(receipt)).digest("hex")}`;
    assert.ok(f.store.transition(actor, { version: "product-intent-v1", requestId: "prior-deploy-receipt-001", id: f.productId,
      expectedRevision: product.revision, expectedObjectiveRevision: 1, stageEvidence: [{ id, stage: "deploy", outcome: "succeeded",
        objectiveRevision: 1, observedAt: now, references: [{ label: receipt.reason, url: receipt.url }], receipt }] }).ok);
    const durable = f.current();
    f.status = 204;
    const replay = await f.request(command);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true); assert.equal(replay.body.revision, durable.revision);
    assert.deepEqual(replay.body.evidence.deploy, [{ id, reference: receipt.url, outcome: "succeeded", receipt, current: true }]);
    assert.equal(f.current().stageEvidence.filter(item => item.receipt?.channel === "deploy").length, 1);
  });
  await t.test("equivalent 2xx probes replay the first durable receipt across instances and revisions", async t => {
    const f = await fixture(t), command = f.command();
    const first = await f.request(command);
    assert.equal(first.status, 200);
    assert.equal(first.body.evidence.deploy[0].outcome, "succeeded");
    const durable = f.current(), stored = first.body.evidence.deploy[0];
    f.status = 204;
    const recovered = await f.request(command);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.replayed, true);
    assert.equal(recovered.body.revision, durable.revision);
    assert.deepEqual(recovered.body.evidence.deploy, [stored]);
    f.status = 201;
    const fresh = await f.request();
    assert.equal(fresh.status, 200); assert.equal(fresh.body.replayed, true);
    assert.deepEqual(fresh.body.evidence.deploy, [stored]);
    assert.equal(f.current().stageEvidence.filter(item => item.receipt?.channel === "deploy").length, 1);
  });
  await t.test("concurrent equivalent 2xx probes converge while retaining an earlier failure", async t => {
    const f = await fixture(t);
    f.deployment.readyState = "ERROR";
    assert.equal((await f.request()).body.evidence.deploy[0].outcome, "failed");
    f.deployment.readyState = "READY";
    const statuses = [200, 204];
    f.beforeProbe = () => { f.status = statuses.shift()!; };
    const command = f.command();
    const replies = await Promise.all([f.request(command), f.request(command)]);
    for (const reply of replies) {
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.deepEqual(reply.body.evidence.deploy.map((item: { outcome: string }) => item.outcome), ["failed", "succeeded"]);
    }
    assert.deepEqual(replies[0]!.body.evidence.deploy, replies[1]!.body.evidence.deploy);
    assert.equal(f.current().stageEvidence.filter(item => item.receipt?.channel === "deploy").length, 2);
  });
  await t.test("an unreadable observation never keeps an earlier success current", async t => {
    const f = await fixture(t);
    const succeeded = await f.request(); assert.equal(succeeded.status, 200);
    f.unreadable = true;
    const unknown = await f.request(); assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body.evidence.deploy.map((item: { current: boolean }) => item.current), [false, true]);
    assert.equal(unknown.body.evidence.deploy[1].outcome, "unknown");
    f.unreadable = false;
    const replay = await f.request(); assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.deepEqual(replay.body.evidence.deploy.map((item: { current: boolean }) => item.current), [true, false]);
  });
  await t.test("a hosted failure arriving during the probe refuses success", async t => {
    const f = await fixture(t);
    f.beforeProbe = () => {
      const product = f.current(), hosted = product.stageEvidence[0]!;
      assert.ok(f.store.transition(actor, { version: "product-intent-v1", requestId: "concurrent-hosted-001", id: f.productId,
        expectedRevision: product.revision, expectedObjectiveRevision: 1,
        stageEvidence: [{ ...hosted, id: "case-hosted:failed", outcome: "failed" }] }).ok);
    };
    assert.equal((await f.request()).body.error, "stale_revision");
    assert.equal(f.current().stageEvidence.filter(item => item.receipt?.channel === "deploy").length, 0);
  });
  await t.test("stale command cannot admit a new observation", async t => {
    const f = await fixture(t), input = f.command(), product = f.current();
    assert.ok(f.store.transition(actor, { version: "product-intent-v1", requestId: "stale-control-00001", id: f.productId,
      expectedRevision: product.revision, expectedObjectiveRevision: 1,
      stageEvidence: [{ id: "other", stage: "research", outcome: "succeeded", objectiveRevision: 1, observedAt: now, references: [] }] }).ok);
    assert.equal((await f.request(input)).body.error, "stale_revision");
    assert.equal(f.current().stageEvidence.filter(item => item.receipt?.channel === "deploy").length, 0);
  });
  await t.test("objective changes while probing refuse the old receipt", async t => {
    const f = await fixture(t);
    f.beforeProbe = () => {
      const product = f.current();
      assert.ok(f.store.write(actor, { version: "product-intent-v1", requestId: "objective-change-0001", id: f.productId,
        expectedRevision: product.revision, brief: { idea: "a different objective" } }).ok);
    };
    assert.equal((await f.request()).body.error, "stale_revision");
    assert.equal(f.current().stageEvidence.filter(item => item.receipt?.channel === "deploy").length, 0);
  });
  await t.test("provider creation time keeps newest deployment current", async t => {
    const f = await fixture(t);
    f.others = [{ ...f.deployment, id: "dpl_older", readyState: "ERROR", createdAt: f.deployment.createdAt - 1000 }];
    const reply = await f.request(); assert.equal(reply.status, 200);
    const current = reply.body.evidence.deploy.filter((item: { current: boolean }) => item.current);
    assert.equal(current.length, 1); assert.equal(current[0].receipt.deploymentId, "dpl_fixture");
    assert.equal(reply.body.evidence.deploy.length, 2);
    assert.equal((await f.request()).body.replayed, true);
  });
});
