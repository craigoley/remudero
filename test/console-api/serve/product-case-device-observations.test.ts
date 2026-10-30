import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { buildProductCaseRoutes } from "#src/lib/product-routes.js";
import { createService, operatorSessionIdentityProvider, type OperatorJwk } from "#src/lib/service.js";
import type { ProductDeployReceipt, ProductTransition } from "#src/lib/product-intent.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { declaredBody, SPEC, violations } from "#test/helpers/openapi-strict.js";

const actor = "operator:phone-observer", head = "a".repeat(40);
const repository = { id: 1234, owner: "fixture", name: "game" };
const observedAt = "2026-10-29T12:00:00.000Z";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "phone-test", kty: "RSA" } as OperatorJwk;
const issuer = "https://phone-session.example", origin = "https://console.example";
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token() {
  const seconds = Math.floor(Date.now() / 1000);
  const payload = `${encoded({ alg: "RS256", kid: jwk.kid })}.${encoded({ iss: issuer, azp: origin,
    sub: "phone-observer", iat: seconds, exp: seconds + 3600, fva: [0, 0] })}`;
  return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`;
}

async function fixture(t: TestContext, change?: (receipt: ProductDeployReceipt) => void, owner = actor) {
  const root = ownedFixtureDir(t, "case-phone").dir;
  const store = new ProductIntentStore({ root });
  const saved = store.write(owner, { version: "product-intent-v1", requestId: "phone-import-000001",
    expectedRevision: 0, brief: { idea: "fixture mobile web game" } });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  const deployment: ProductDeployReceipt = { channel: "deploy", actor: owner, productId, objectiveRevision: 1,
    operationId: `pdeploy_${"b".repeat(64)}`, repository, projectId: "prj_phone", teamId: "team_phone",
    deploymentId: "dpl_phone", target: "preview", providerCreatedAt: Date.parse(observedAt), commit: head,
    url: "https://phone.vercel.app/", readyState: "READY", servedStatus: 200, outcome: "succeeded", reason: "served URL answered" };
  change?.(deployment);
  assert.ok(store.transition(owner, { version: "product-intent-v1", requestId: "phone-deployment-001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1,
    repository: { ...repository, provider: "github", defaultBranch: "main", visibility: "public", verifiedAt: observedAt },
    stageEvidence: [{ id: "case-deploy:phone", stage: "deploy", outcome: deployment.outcome, objectiveRevision: 1,
      observedAt, references: [{ label: "served URL answered", url: "https://phone.vercel.app/" }], receipt: deployment }] }).ok);
  const current = () => { const read = store.read(owner, productId); assert.ok(read.ok); return read.value; };
  const command = () => ({ version: "product-case-v1", action: "observe-phone", command: {
    productId, expectedRevision: current().revision, expectedObjectiveRevision: current().objectiveRevision,
    deployEvidenceId: "case-deploy:phone", platform: "ios", browser: "Safari 26", deviceModel: "iPhone 16",
    scenarioId: "signed-in-console-c4", outcome: "passed", observedAt } });
  async function serve(serviceStore?: ProductIntentStore) {
    const route = buildProductCaseRoutes({ root, ...(serviceStore ? { store: serviceStore } : {}) })[0]!;
    let loseResponse = false;
    const server = createService({ tokens: { read: "phone-read", write: "phone-write" },
      operatorSession: operatorSessionIdentityProvider({ issuer, allowedOrigins: [origin], operatorUserIds: ["phone-observer"],
        keys: { key: async kid => kid === jwk.kid ? jwk : undefined } }),
      providers: [{ name: "fixture-machine", grant: () => undefined, authorize: req => req.headers["x-machine"] ?
        { scopes: new Set(["read", "write"]), tier: "high", actor: String(req.headers["x-machine"]) } : undefined }],
      routes: [{ ...route, async handler(req, res, context) {
        if (loseResponse) { loseResponse = false; res.end = (() => { res.destroy(); return res; }) as typeof res.end; }
        await route.handler(req, res, context);
      } }] });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const close = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    t.after(async () => { if (server.listening) await close(); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/products/case`;
    return { close, loseResponse() { loseResponse = true; }, async request(input: unknown = command(), auth = "operator") {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (auth === "operator") headers["x-rmd-operator-session"] = token();
      else if (auth === "bearer") headers.authorization = "Bearer phone-write";
      else headers["x-machine"] = auth;
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(input) });
      const body = await response.json();
      assert.deepEqual(violations(body, declaredBody("/v1/products/case", "POST", response.status)), []);
      return { status: response.status, body };
    } };
  }
  return { root, store, productId, deployment, current, command, serve };
}

test("W1-T10867: operator phone observation binds its deployment and scenario", async t => {
  const f = await fixture(t), server = await f.serve(), input = f.command();
  const reply = await server.request(input);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.deepEqual(violations(input, SPEC.components.schemas.ProductCaseCommand!), []);
  assert.equal(reply.body.replayed, false);
  assert.equal(reply.body.evidence.mobile.length, 1);
  const observation = reply.body.evidence.mobile[0];
  assert.equal(observation.outcome, "passed");
  assert.equal(observation.provenance, "operator-attested");
  assert.equal(observation.platform, "ios");
  assert.deepEqual(observation.receipt, { channel: "mobile", actor, productId: f.productId, objectiveRevision: 1,
    repository, provenance: "operator-attested", source: "physical-phone-browser", deployEvidenceId: "case-deploy:phone",
    deploymentId: "dpl_phone", target: "preview", commit: head, url: "https://phone.vercel.app/",
    platform: "ios", browser: "Safari 26", deviceModel: "iPhone 16", scenarioId: "signed-in-console-c4", outcome: "passed", observedAt });
  const stored = f.current().stageEvidence.find(item => item.id === observation.id)!;
  assert.deepEqual(stored.receipt, observation.receipt);
  assert.equal(stored.outcome, "succeeded");
  assert.ok(stored.references.some(ref => ref.label === "Operator-attested physical-phone browser observation"));
  assert.equal(f.current().executionAuthority, "none");
  for (const injection of [{ commit: "f".repeat(40) }, { url: "https://evil.invalid" }, { actor: "operator:other" },
    { deploymentId: "dpl_other" }, { source: "browser-emulation" }, { screenshot: "https://image.invalid" }]) {
    assert.equal((await server.request({ ...input, command: { ...input.command, ...injection } })).status, 400);
  }
});

test("W1-T10867: invalid observers refuse and iOS never satisfies Android", async t => {
  const f = await fixture(t), server = await f.serve();
  assert.equal((await server.request(f.command(), "bearer")).status, 403);
  for (const machine of ["worker:phone", "bot:phone", "service:phone"]) {
    const own = await fixture(t, undefined, machine), endpoint = await own.serve();
    assert.equal((await endpoint.request(own.command(), machine)).status, 403);
    assert.equal(own.current().stageEvidence.length, 1);
  }
  for (const changes of [{ platform: "desktop" }, { platform: "emulated-ios" }, { browser: " " }, { deviceModel: "x".repeat(161) },
    { scenarioId: "" }, { observedAt: "yesterday" }, { attachment: "https://image.invalid" }]) {
    assert.equal((await server.request({ ...f.command(), command: { ...f.command().command, ...changes } })).status, 400);
  }
  assert.equal((await server.request({ version: "product-case-v1", action: "observe-phone", command: {
    productId: f.productId, expectedRevision: 2, expectedObjectiveRevision: 1, attachment: "https://image.invalid" } })).status, 400);
  assert.equal((await server.request({ ...f.command(), command: { ...f.command().command, deployEvidenceId: "missing" } })).body.error, "deployment_not_qualified");
  for (const [name, change] of [
    ["actor", (r: ProductDeployReceipt) => { r.actor = "operator:other"; }],
    ["product", (r: ProductDeployReceipt) => { r.productId = `prd_${"d".repeat(32)}`; }],
    ["repository", (r: ProductDeployReceipt) => { r.repository = { ...repository, id: 9 }; }],
    ["objective", (r: ProductDeployReceipt) => { r.objectiveRevision = 2; }],
    ["failed", (r: ProductDeployReceipt) => { r.outcome = "failed"; }],
    ["running", (r: ProductDeployReceipt) => { r.outcome = "running"; }],
    ["missing deployment", (r: ProductDeployReceipt) => { r.deploymentId = null; }],
    ["missing commit", (r: ProductDeployReceipt) => { r.commit = null; }],
  ] as const) await t.test(name, async t => {
    const bad = await fixture(t, change), endpoint = await bad.serve();
    const reply = await endpoint.request();
    assert.equal(reply.status, 409); assert.equal(reply.body.error, "deployment_not_qualified");
    assert.equal(bad.current().stageEvidence.length, 1);
  });
  const ios = await server.request();
  assert.equal(ios.status, 200);
  assert.deepEqual(ios.body.mobileCoverage, { ios: "passed", android: "unverified" });
  assert.deepEqual(ios.body.evidence.mobile.map((item: { platform: string }) => item.platform), ["ios"]);
  const android = await server.request({ ...f.command(), command: { ...f.command().command,
    platform: "android", browser: "Chrome 142", deviceModel: "Pixel 10", outcome: "blocked" } });
  assert.deepEqual(android.body.mobileCoverage, { ios: "passed", android: "blocked" });
  const current = f.current();
  assert.ok(f.store.write(actor, { version: "product-intent-v1", requestId: "phone-objective-change", id: f.productId,
    expectedRevision: current.revision, brief: { idea: "a changed objective" } }).ok);
  assert.equal((await server.request()).body.error, "deployment_not_qualified");
  assert.equal((await server.request(f.command())).status, 409);
});

test("W1-T10867: invalid observers refuse and iOS never satisfies Android — timestamp ordering", async t => {
  const f = await fixture(t), server = await f.serve();
  const first = { ...f.command(), command: { ...f.command().command, observedAt: "2026-10-29T12:01:00Z" } };
  assert.equal((await server.request(first)).status, 200);
  const later = { ...f.command(), command: { ...f.command().command, observedAt: "2026-10-29T12:01:00.001Z", outcome: "failed" } };
  const reply = await server.request(later);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.evidence.mobile.map((item: { outcome: string }) => item.outcome), ["passed", "failed"]);
  assert.deepEqual(reply.body.mobileCoverage, { ios: "failed", android: "unverified" });
  const tied = { ...f.command(), command: { ...f.command().command, observedAt: "2026-10-29T12:01:00.001Z", outcome: "blocked" } };
  assert.deepEqual((await server.request(tied)).body.mobileCoverage, { ios: "blocked", android: "unverified" });
});

test("W1-T10867: replay restart and concurrent edits preserve phone history", async t => {
  const f = await fixture(t), server = await f.serve(), original = f.command();
  server.loseResponse();
  await assert.rejects(server.request(original));
  assert.equal(f.current().stageEvidence.length, 2);
  const replay = await server.request(original);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  const uncertainStore = new ProductIntentStore({ root: f.root, sync: () => { throw new Error("directory sync failed"); } });
  const uncertain = await (await f.serve(uncertainStore)).request(original);
  assert.equal(uncertain.status, 503); assert.equal(uncertain.body.error, "outcome_unknown");
  assert.equal(f.current().stageEvidence.length, 2);
  await server.close();
  const processRestart = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { buildProductCaseRoutes } from '#src/lib/product-routes.js';
    import { createService, operatorSessionIdentityProvider } from '#src/lib/service.js';
    const [root, session, key, input] = process.argv.slice(1);
    const server = createService({ tokens: { read: 'phone-read', write: 'phone-write' },
      operatorSession: operatorSessionIdentityProvider({ issuer: 'https://phone-session.example',
        allowedOrigins: ['https://console.example'], operatorUserIds: ['phone-observer'],
        keys: { key: async () => JSON.parse(key) } }), routes: buildProductCaseRoutes({ root }) });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/products/case', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-rmd-operator-session': session }, body: input });
      if (response.status !== 200) throw new Error(await response.text());
      console.log(JSON.stringify(await response.json()));
    } finally { await new Promise(resolve => server.close(resolve)); }
  `, f.root, token(), JSON.stringify(jwk), JSON.stringify(original)], {
    cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: "" },
  });
  assert.equal(processRestart.status, 0, processRestart.stderr);
  const afterProcessRestart = JSON.parse(processRestart.stdout);
  assert.deepEqual(violations(afterProcessRestart, declaredBody("/v1/products/case", "POST", 200)), []);
  assert.equal(afterProcessRestart.replayed, true);
  assert.deepEqual(afterProcessRestart.evidence.mobile, replay.body.evidence.mobile);
  const restarted = await f.serve(), second = await f.serve();
  const reconstructed = await restarted.request(original);
  assert.deepEqual(reconstructed.body.evidence.mobile, replay.body.evidence.mobile);
  assert.deepEqual(reconstructed.body.mobileCoverage, { ios: "passed", android: "unverified" });
  const failed = { ...f.command(), command: { ...f.command().command, outcome: "failed", observedAt: "2026-10-29T12:01:00.000Z" } };
  const replies = await Promise.all([restarted.request(failed), second.request(failed)]);
  assert.ok(replies.every(reply => reply.status === 200));
  assert.deepEqual(replies.map(reply => reply.body.replayed).sort(), [false, true]);
  assert.equal(f.current().stageEvidence.length, 3);
  assert.deepEqual(replies[1]!.body.evidence.mobile.map((item: { outcome: string }) => item.outcome), ["passed", "failed"]);
  assert.equal(replies[1]!.body.mobileCoverage.ios, "failed");
  assert.equal((await restarted.request(original)).body.mobileCoverage.ios, "failed", "old replay must not conceal a later failure");
  assert.equal((await restarted.request({ ...original, command: { ...original.command, browser: "different browser" } })).body.error, "stale_revision");
  const stale = { ...f.command(), command: { ...f.command().command, observedAt: "2026-10-29T12:03:00.000Z" } };
  const freshStore = new ProductIntentStore({ root: f.root });
  assert.ok(freshStore.transition(actor, { version: "product-intent-v1", requestId: "phone-concurrent-other", id: f.productId,
    expectedRevision: f.current().revision, expectedObjectiveRevision: 1,
    stageEvidence: [{ id: "other-evidence", stage: "review", outcome: "blocked", objectiveRevision: 1, observedAt, references: [] }] }).ok);
  assert.equal((await second.request(stale)).body.error, "stale_revision");
  const blocked = { ...f.command(), command: { ...f.command().command, outcome: "blocked", observedAt: "2026-10-29T12:02:00.000Z" } };
  const racedStore = new ProductIntentStore({ root: f.root });
  const transition = racedStore.transition.bind(racedStore);
  let race = true;
  racedStore.transition = (owner, input) => {
    if (race) {
      race = false;
      const next = input as ProductTransition;
      assert.ok(freshStore.transition(owner, { ...next, requestId: "phone-racing-review", stageEvidence: [{
        id: "racing-review", stage: "review", outcome: "blocked", objectiveRevision: 1, observedAt, references: [] }] }).ok);
    }
    return transition(owner, input);
  };
  const racing = await f.serve(racedStore);
  const converged = await racing.request(blocked);
  assert.equal(converged.status, 200, JSON.stringify(converged.body));
  assert.deepEqual(converged.body.evidence.mobile.map((item: { outcome: string }) => item.outcome), ["passed", "failed", "blocked"]);
  assert.equal((await second.request(blocked)).body.replayed, true);
  assert.equal(f.current().stageEvidence.filter(item => item.receipt?.channel === "mobile").length, 3);
});

test("W1-T10867: replay restart and concurrent edits preserve phone history — legacy and objective controls", async t => {
  const f = await fixture(t);
  assert.ok(f.store.transition(actor, { version: "product-intent-v1", requestId: "phone-legacy-000001", id: f.productId,
    expectedRevision: 2, expectedObjectiveRevision: 1,
    stageEvidence: [{ id: "case-mobile:legacy", stage: "deploy", outcome: "succeeded", objectiveRevision: 1, observedAt,
      references: [{ label: "Screenshot", url: "https://image.invalid/phone" }] }] }).ok);
  const server = await f.serve();
  const initial = f.command();
  const reply = await server.request(initial);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.evidence.mobile[0], { id: "case-mobile:legacy", reference: "https://image.invalid/phone",
    outcome: "unknown", provenance: "unverified", platform: null, current: false });
  assert.deepEqual(reply.body.mobileCoverage, { ios: "passed", android: "unverified" });
  const revision = f.current().revision;
  assert.ok(f.store.write(actor, { version: "product-intent-v1", requestId: "phone-new-objective-01", id: f.productId,
    expectedRevision: revision, brief: { idea: "new held-out objective" } }).ok);
  assert.equal((await server.request(initial)).body.error, "stale_revision");
  const imported = await server.request({ version: "product-case-v1", action: "import", command: {
    version: "product-intent-v1", requestId: "phone-import-000001", expectedRevision: 0, brief: { idea: "fixture mobile web game" } } });
  assert.equal(imported.status, 200);
  assert.deepEqual(imported.body.mobileCoverage, { ios: "unverified", android: "unverified" });
  assert.equal(imported.body.evidence.mobile.length, 2);
  assert.ok(imported.body.evidence.mobile.every((item: { current: boolean }) => item.current === false));
});

test("W1-T10867: replay restart and concurrent edits preserve phone history — race and capacity refusals", async t => {
  const f = await fixture(t);
  const current = f.current();
  for (let offset = 0; offset < 127; offset += 16) {
    const evidence = Array.from({ length: Math.min(16, 127 - offset) }, (_, index) => ({
      id: `capacity-${offset + index}`, stage: "review", outcome: "blocked", objectiveRevision: 1, observedAt, references: [] }));
    assert.ok(f.store.transition(actor, { version: "product-intent-v1", requestId: `phone-capacity-${offset}-0001`, id: f.productId,
      expectedRevision: f.current().revision, expectedObjectiveRevision: 1, stageEvidence: evidence }).ok);
  }
  const server = await f.serve();
  assert.equal((await server.request()).body.error, "capacity");
  assert.equal(f.current().stageEvidence.length, 128);
  assert.equal(current.revision, 2);
  const race = await fixture(t), initial = race.command();
  const racingStore = new ProductIntentStore({ root: race.root });
  const transition = racingStore.transition.bind(racingStore);
  let changeObjective = true;
  racingStore.transition = (owner, input) => {
    if (changeObjective) {
      changeObjective = false;
      assert.ok(race.store.write(owner, { version: "product-intent-v1", requestId: "phone-race-objective-01", id: race.productId,
        expectedRevision: race.current().revision, brief: { idea: "a concurrently replaced objective" } }).ok);
    }
    return transition(owner, input);
  };
  assert.equal((await (await race.serve(racingStore)).request(initial)).body.error, "stale_revision");
  assert.equal(race.current().stageEvidence.length, 1);
});
