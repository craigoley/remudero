/**
 * Machine-filing admission (W1-T3843) runs on every filing PR's `rmd lint-plan --base`. Until
 * 2026-10-02 the only ci-friction shape it admitted was one docs file nothing reads, so every remedy
 * the gardener filed was built as a paragraph (#8302 #8476 #8507 #8514 #8544 #8546). A remedy now
 * names the code that owns its cause and the regression test its build writes — a path that cannot
 * exist yet — and admission must take it as a parked proposal, as it does the legacy shape.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";

import { CI_FRICTION_REMEDIES_FILE, ciFrictionRemedyTestTitle, ciFrictionShardStem, ciFrictionShardYaml } from "#src/lib/ci-friction-gardener.js";
import { fixedClock, systemClock } from "#src/lib/clock.js";
import { runnableCandidates } from "#src/lib/drain.js";
import { machineShardFilingRefusal, machineShardLandingGuard, machineShardLandingRefusal } from "#src/lib/machine-filing.js";
import { assertLintClean, lintTask, sizingViolation, taskRulingPin } from "#src/lib/task-linter.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations, newTestPath, type NewPathApprovalBinding, type NewPathApprovalFacts, type NewPathApprovalRecord, type Task } from "#src/lib/plan.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { buildServeRoutes, type ServeDeps } from "#src/lib/serve.js";
import * as approvalServe from "#src/lib/serve.js";
import * as approvalPlan from "#src/lib/plan.js";
import * as runTask from "#src/run-task.js";
import * as service from "#src/lib/service.js";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

function admit(yaml: string, pathExists = (p: string) => existsSync(join(REPO_ROOT, p))): string[] {
  const plan = loadPlanFromYaml(yaml, "ci-friction-fixture");
  return machineFilingAdmissionViolations(plan.tasks[0]!, { plan, releasedIds: new Set(), pathExists });
}

test("a ci-friction remedy naming its owning code and a new regression test is admitted as a parked proposal", () => {
  const yaml = ciFrictionShardYaml(
    { price: { cause: { kind: "check", name: "fixture-never-built" }, minutes: 12, rounds: 3, prs: 2 }, rung: 1, owner: { files: ["src/run-task.ts"], why: [] }, rounds: [] },
    "W1-T99999",
  );
  const files = loadPlanFromYaml(yaml, "x").tasks[0]!.files;
  assert.deepEqual(files, ["src/run-task.ts", newTestPath("check-fixture-never-built", ["src/run-task.ts"], "ci-friction-gardener")]);
  assert.equal(existsSync(join(REPO_ROOT, files[1]!)), false, "the regression test does not exist before the build writes it");
  assert.deepEqual(admit(yaml), []);
});

test("new path admission binds the explicit approval to the exact task and declared paths through genuine issuer confirmation", async () => {
  const createIssuer = (service as unknown as { createNewPathApprovalIssuer?: typeof service.createNewPathApprovalIssuer }).createNewPathApprovalIssuer;
  assert.equal(typeof createIssuer, "function", "a fixture receipt is not a production confirmation lifecycle");
  let now = Date.UTC(2026, 9, 23, 12);
  const clock = { ...fixedClock(now), now: () => now };
  const { task, facts } = approvalFixture("auto");
  const rawTask = JSON.parse(JSON.stringify(task));
  delete rawTask.sourcePath;delete rawTask.new_path_approval_ref;
  const draftYaml = JSON.stringify([rawTask]);
  let binding: NewPathApprovalBinding | undefined = { ...facts.binding };
  const audit = new Map<string, string>();
  let writeFailure = false, readFailure = false, hangRead = false, pathUnknown = false, writes = 0;
  const io: service.NewPathApprovalIssuerIO = { clock,
    binding: async () => binding,
    paths: async () => pathUnknown ? undefined : structuredClone(facts.paths),
    audit: { write: async (record: Readonly<NewPathApprovalRecord>, bytes: string) => {
      writes++;if (writeFailure) throw new Error("fixture durable write lost");audit.set(record.reference, bytes);
    }, read: async reference => { if (readFailure) throw new Error("fixture durable read unavailable");
      if (hangRead) return await new Promise<string | undefined>(() => {});return audit.get(reference); } },
  };
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "issuer-key", kty: "RSA" } as service.OperatorJwk;
  const token = (sub = "fixture-user") => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const head = encode({ alg: "RS256", kid: jwk.kid });
    const body = encode({ iss: "https://session.fixture.invalid", sub, azp: "https://ui.fixture.invalid",
      iat: now / 1_000 - 1, exp: now / 1_000 + 60, fva: [0, -1] });
    return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  };
  const operatorSession = service.operatorSessionIdentityProvider({ issuer: "https://session.fixture.invalid",
    allowedOrigins: ["https://ui.fixture.invalid"], operatorUserIds: ["fixture-user", "other-user"], keys: { key: async () => jwk }, clock });
  let sequence = 0;
  const store = service.createConfirmNonceStore(() => `issuer-nonce-${++sequence}`, clock.now);
  let issuer = createIssuer!(io);
  const routes = issuer.routes.map(route => ({ ...route, handler: (req: IncomingMessage, res: import("node:http").ServerResponse, ctx: service.RouteContext) =>
    issuer.routes.find(current => current.path === route.path)!.handler(req, res, ctx) }));
  const server = service.createService({ tokens: { read: "fixture-read", write: "fixture-write" }, operatorSession,
    enforceWriteTiers: true, confirmNonces: store, routes });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (operation: string, input: unknown, actor = "fixture-user") => {
    const path = `/v1/new-path-approvals/${operation}`, payload = typeof input === "string" ? input : JSON.stringify(input);
    const nonce = store.issue({ method: "POST", path, payload });
    const response = await fetch(origin + path, { method: "POST", body: payload,
      headers: { [service.OPERATOR_SESSION_HEADER]: token(actor), "x-confirm-nonce": nonce }, signal: AbortSignal.timeout(2_000) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const preview = () => post("preview", { draftYaml, recordPath: APPROVAL_RECORD_PATH, approvedMissingPaths: task.files, lifetimeMs: 60_000 });
  const verify = async (reference: string) => {
    const response = await fetch(`${origin}/v1/new-path-approvals/verify?reference=${reference}`, {
      headers: { authorization: "Bearer fixture-read" }, signal: AbortSignal.timeout(8_000) });
    assert.equal(response.status, 200);return await response.json() as Record<string, any>;
  };
  try {
    const first = await preview();assert.equal(first.status, 200);assert.match(first.body.previewId, /^npp1_/);
    assert.equal((await post("confirm", { previewId: first.body.previewId }, "other-user")).status, 409, "a different signed operator cannot adopt the preview");
    const confirmed = await post("confirm", { previewId: first.body.previewId });assert.equal(confirmed.status, 200);
    const reference = confirmed.body.reference;assert.match(reference, /^npa1_[A-Za-z0-9_-]{43}$/);
    assert.equal(confirmed.body.record.operatorId, "operator:fixture-user");
    assert.equal(confirmed.body.record.intentDigest, approvalPlan.newPathApprovalIntentDigest(task, APPROVAL_RECORD_PATH));
    assert.equal((await verify(reference)).state, "verified");assert.equal((await verify(reference)).state, "verified");
    assert.equal((await post("confirm", { previewId: first.body.previewId })).status, 409);
    assert.equal(writes, 1, "verification and replay never issue a second approval");
    const parallel = await preview();
    const concurrent = await Promise.all([post("confirm", { previewId: parallel.body.previewId }), post("confirm", { previewId: parallel.body.previewId })]);
    assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);assert.equal(writes, 2);
    const bytes = audit.get(reference)!;audit.delete(reference);assert.equal((await verify(reference)).state, "unknown");
    audit.set(reference, bytes + " ");assert.equal((await verify(reference)).state, "unknown", "replacement bytes are not the retained audit");
    audit.set(reference, bytes);readFailure = true;assert.equal((await verify(reference)).state, "unknown");readFailure = false;
    hangRead = true;assert.equal((await verify(reference)).state, "unknown", "an unresponsive read port must not outlive the selected operation's deadline");hangRead = false;
    binding = { ...facts.binding, epoch: "replacement-epoch" };assert.equal((await verify(reference)).state, "unknown");binding = { ...facts.binding };
    const drift = await preview();pathUnknown = true;assert.equal((await post("confirm", { previewId: drift.body.previewId })).status, 409);pathUnknown = false;
    const lost = await preview();writeFailure = true;assert.equal((await post("confirm", { previewId: lost.body.previewId })).status, 409);writeFailure = false;
    assert.equal((await post("confirm", { previewId: lost.body.previewId })).status, 409, "a failed durable write spends the preview, never silently retries");
    const ambiguous = '{"draftYaml":' + JSON.stringify(draftYaml) + ',"recordPath":' + JSON.stringify(APPROVAL_RECORD_PATH) + ',"\\u0072ecordPath":"plan/tasks.d/substitute.yaml","approvedMissingPaths":' + JSON.stringify(task.files) + '}';
    assert.equal((await post("preview", ambiguous)).status, 409, "decoded duplicate keys are ambiguous even when spelled differently");
    assert.equal((await post("revoke", { reference })).status, 200);assert.equal((await verify(reference)).state, "unknown");
    const expiring = await preview();const issued = await post("confirm", { previewId: expiring.body.previewId });
    now += 60_001;assert.equal((await verify(issued.body.reference)).state, "unknown");
    issuer = createIssuer!(io);assert.equal((await verify(concurrent.find(result => result.status === 200)!.body.reference)).state, "unknown",
      "restart does not restore canonical authority from audit JSON");
  } finally {
    server.closeAllConnections();await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("new path admission bounds partial bodies and pending authentication before issuer effects with real HTTP", { timeout: 30_000 }, async () => {
  const now = Date.UTC(2026, 9, 23, 12), clock = fixedClock(now);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "bounded-request-key", kty: "RSA" } as service.OperatorJwk;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "RS256", kid: jwk.kid });
  const claims = encode({ iss: "https://session.fixture.invalid", sub: "fixture-user", azp: "https://ui.fixture.invalid",
    iat: now / 1_000 - 1, exp: now / 1_000 + 60, fva: [0, -1] });
  const token = `${head}.${claims}.${sign("RSA-SHA256", Buffer.from(`${head}.${claims}`), privateKey).toString("base64url")}`;
  for (const mode of ["partial-body", "pending-auth"] as const) {
    let holdKeys = mode === "pending-auth", keyReads = 0, effects = 0, sequence = 0;
    const releaseKeys: Array<() => void> = [], captured: IncomingMessage[] = [];
    const operatorSession = service.operatorSessionIdentityProvider({ issuer: "https://session.fixture.invalid",
      allowedOrigins: ["https://ui.fixture.invalid"], operatorUserIds: ["fixture-user"], clock, keys: { key: async () => {
        keyReads++;if (holdKeys) await new Promise<void>(resolve => releaseKeys.push(resolve));return jwk;
      } } });
    const authorize = operatorSession.authorize!.bind(operatorSession);
    operatorSession.authorize = (req, allow) => { captured.push(req);return authorize(req, allow); };
    const path = "/v1/new-path-approvals/confirm", payload = "{}";
    const nonces = service.createConfirmNonceStore(() => `bounded-nonce-${++sequence}`, clock.now);
    const server = service.createService({ tokens: { read: "fixture-read", write: "fixture-write" }, operatorSession,
      enforceWriteTiers: true, confirmNonces: nonces, routes: [
        { method: "POST", path, scope: "write", tier: "high", newPathApproval: true, handler: (req, res) => {
          const actor = service.verifiedNewPathApprovalAction(req, true);if (actor) effects++;
          res.writeHead(actor ? 200 : 403, { "content-type": "application/json" });res.end(JSON.stringify({ actor }));
        } },
        { method: "GET", path: "/fixture/healthy", scope: "read", handler: (_req, res) => { res.writeHead(200);res.end("legacy healthy"); } },
      ] });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const opened: Array<{ req: ClientRequest; done: Promise<{ status: number; text: string }> }> = [];
    const open = () => {
      let req!: ClientRequest;
      const done = new Promise<{ status: number; text: string }>((resolve, reject) => {
        req = httpRequest(origin + path, { method: "POST", headers: { [service.OPERATOR_SESSION_HEADER]: token,
          "x-confirm-nonce": "unconfirmed-stalled-body", "content-length": mode === "partial-body" ? "100" : "2" } }, res => {
          let text = "";res.setEncoding("utf8");res.on("data", chunk => { text += chunk; });
          res.on("end", () => resolve({ status: res.statusCode!, text }));res.on("error", reject);
        });req.on("error", reject);
      });
      void done.catch(() => {});req.flushHeaders();if (mode === "partial-body") req.write("{");else req.end(payload);
      const value = { req, done };opened.push(value);return value;
    };
    const healthyPost = () => fetch(origin + path, { method: "POST", body: payload,
      headers: { [service.OPERATOR_SESSION_HEADER]: token, "x-confirm-nonce": nonces.issue({ method: "POST", path, payload }) },
      signal: AbortSignal.timeout(2_000) });
    try {
      for (let i = 0; i < 8; i++) open();
      const readyUntil = performance.now() + 1_000;
      while (keyReads < 8 && performance.now() < readyUntil) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(keyReads, 8, "all eight genuine signed HTTP requests reached authentication");
      const busy = await healthyPost();assert.equal(busy.status, 409, `${mode}: the selected bound must include work before issuer dispatch`);await busy.text();
      const legacy = await fetch(origin + "/fixture/healthy", { headers: { authorization: "Bearer fixture-read" }, signal: AbortSignal.timeout(2_000) });
      assert.equal(legacy.status, 200);assert.equal(await legacy.text(), "legacy healthy", "selected backpressure is not a global trusted-flow hold");
      const responses = await Promise.race([Promise.all(opened.map(value => value.done)),
        new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error(`${mode}: selected default deadline never answered`)), 8_000);timer.unref(); })]);
      assert.ok(responses.every(value => value.status === 409 && JSON.parse(value.text).state === "unknown"), mode);
      assert.equal(effects, 0);
      holdKeys = false;for (const release of releaseKeys) release();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(effects, 0, "late authentication completion is not a grant");
      for (const req of captured.slice(0, 8)) {
        assert.equal(service.verifiedNewPathApprovalAction(req, false), undefined);
        assert.equal(req.listenerCount("data"), 0, "cancelled selected body readers release buffering listeners");
      }
      const admitted = await healthyPost();assert.equal(admitted.status, 200);await admitted.text();assert.equal(effects, 1);
    } finally {
      holdKeys = false;for (const release of releaseKeys) release();for (const value of opened) value.req.destroy();
      server.closeAllConnections();await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});

test("new path admission default filesystem audit bounds concurrent identities and never restores authority from replaced bytes", { timeout: 30_000 }, async () => {
  const createNewPathApprovalFilesystemAudit = approvalServe.createNewPathApprovalFilesystemAudit;
  assert.equal(typeof createNewPathApprovalFilesystemAudit, "function", "the actual default audit must exist, not only a fake port");
  const repo = gitRepo({ kind: "default-approval-audit" }), controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 25_000);
  try {
    const audit = createNewPathApprovalFilesystemAudit(repo.dir), { record } = approvalFixture();
    const at = (index: number) => {
      const value = { ...record, reference: `npa1_${index.toString(36).padStart(43, "A")}` };
      return { value, bytes: `${JSON.stringify(value)}\n` };
    };
    for (let i = 0; i < 255; i++) { const { value, bytes } = at(i);await audit.write(value, bytes, controller.signal); }
    const concurrent = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => {
      const { value, bytes } = at(255 + index);return audit.write(value, bytes, controller.signal);
    }));
    const directory = join(repo.dir, "state", "new-path-approvals-v1"), names = readdirSync(directory);
    assert.equal(names.length, 256, "concurrent default writes must reserve before the first filesystem await");
    assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(result => result.status === "rejected").length, 7);
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    assert.ok(names.every(name => (lstatSync(join(directory, name)).mode & 0o777) === 0o600));
    const first = at(0), path = join(directory, `${first.value.reference}.json`);
    assert.equal(await audit.read(first.value.reference, controller.signal), first.bytes);
    assert.equal(await createNewPathApprovalFilesystemAudit(repo.dir).read(first.value.reference, controller.signal), undefined,
      "a new process-local reader does not hydrate pins or authority from retained audit JSON");
    const originalBytes = readFileSync(path);renameSync(path, path + ".retained-original");
    writeFileSync(path, originalBytes, { mode: 0o600 });
    assert.equal(await audit.read(first.value.reference, controller.signal), undefined, "same bytes on a replacement inode stay unknown");
    renameSync(path, path + ".retained-replacement");symlinkSync(path + ".retained-original", path);
    assert.equal(await audit.read(first.value.reference, controller.signal), undefined, "a symlink cannot restore the original audit identity");
    const cancelled = new AbortController();cancelled.abort();
    await assert.rejects(audit.write(at(999).value, at(999).bytes, cancelled.signal));
    assert.equal(existsSync(join(directory, `${at(999).value.reference}.json`)), false);
    const negativeRoot = join(repo.dir, "negative");mkdirSync(negativeRoot, { mode: 0o700 });
    const negative = createNewPathApprovalFilesystemAudit(negativeRoot);
    await assert.rejects(negative.write({ ...record, reference: "../outside-audit" }, first.bytes, controller.signal));
    await assert.rejects(negative.write(at(999).value, "x".repeat(128 * 1024 + 1), controller.signal));
    await assert.rejects(negative.write(at(999).value, at(999).bytes, cancelled.signal));
    assert.equal(existsSync(join(negativeRoot, "state")), false, "invalid, oversized and already-cancelled inputs perform no filesystem write");
    await negative.write(at(999).value, at(999).bytes, controller.signal);
    await assert.rejects(negative.write(at(999).value, at(999).bytes, controller.signal));
    assert.equal(await negative.read(at(999).value.reference, controller.signal), at(999).bytes);
  } finally { clearTimeout(deadline);controller.abort();repo.cleanup(); }
});

test("an invented source path is still refused, and a remedy with no owning code is not a parked shape", () => {
  const invented = ciFrictionShardYaml(
    { price: { cause: { kind: "check", name: "x" }, minutes: 1, rounds: 1, prs: 1 }, rung: 1, owner: { files: ["src/lib/no-such-module.ts"], why: [] }, rounds: [] },
    "W1-T99998",
  );
  assert.match(admit(invented).join("; "), /exist in neither the checkout nor the base tree: src\/lib\/no-such-module\.ts$/);
  const testOnly = invented.replace("    - src/lib/no-such-module.ts\n", "");
  const reasons = admit(testOnly).join("; ");
  assert.match(reasons, /verify:human — not auto-runnable/);
  assert.match(reasons, /exist in neither the checkout nor the base tree: test\/[\w-]+\/check-x\.test\.ts/);
});

test("the legacy docs-only ci-friction shard still files, so existing records keep admitting", () => {
  const legacy = [
    "- id: W1-T99996", '  title: "legacy"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: human", "  risk: low",
    "  status: queued", "  attempts: 0", "  author_class: machine", '  origin: "ci-friction:check:reviewer-unmet"', "  files:", `    - ${CI_FRICTION_REMEDIES_FILE}`,
    "  acceptance:", '    - claim: "c"', `      proof: "grep: ci-friction:check:reviewer-unmet in ${CI_FRICTION_REMEDIES_FILE}"`, "",
  ].join("\n");
  assert.deepEqual(admit(legacy), []);
});

test("a drafted remedy passes the base linter's sizing and admission checks with a grep proof its build makes true", () => {
  const key = "check:ci-log:coverage-ratchet";
  const yaml = ciFrictionShardYaml(
    { price: { cause: { kind: "check", name: "ci-log:coverage-ratchet" }, minutes: 1441, rounds: 457, prs: 291 }, rung: 1, owner: { files: ["src/lib/ci-parity.ts", "src/run-task.ts"], why: ["a", "b"] }, rounds: [] },
    "W1-T99995",
  );
  const plan = loadPlanFromYaml(yaml, "x");
  const task = plan.tasks[0]!;
  const stem = ciFrictionShardStem(key);
  const testPath = newTestPath(stem, ["src/lib/ci-parity.ts"], "ci-friction-gardener");
  assert.deepEqual(task.files, ["src/lib/ci-parity.ts", testPath], "one owner file plus a test named for the shard, in its computed folder");
  assert.equal(sizingViolation(task, { duplicateSlug: stem }), undefined, "the test is the shard's own falsifier, so the span is one concern");
  const proof = task.acceptance?.[0]?.proof ?? "";
  assert.equal(proof, `grep: test("${ciFrictionRemedyTestTitle("W1-T99995", key)}" in ${testPath}`);
  assert.equal(proof.split(" in ").length, 2, "the title never splits the proof's path");
  assert.equal(ciFrictionRemedyTestTitle("W1-T1", "check:pass in ci"), "W1-T1: check:pass within ci is prevented, not retried");
  const lint = lintTask(task, { duplicateSlug: stem, machineFilingAdmission: { plan, releasedIds: new Set(), pathExists: (p) => existsSync(join(REPO_ROOT, p)) } });
  assert.deepEqual(lint.violations.filter((v) => v.severity === "block"), []);
});

const APPROVAL_RECORD_PATH = "plan/tasks.d/W1-T99001-approved-new-path.yaml";
const APPROVAL_REFERENCE = `npa1_${"A".repeat(43)}`;

test("new path admission agrees between the real filing precheck and plan lint through the actual lint command", async () => {
  const repo = gitRepo({ kind: "approval-lint-command" });
  try {
    mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
    const planPath = join(repo.dir, "plan", "tasks.yaml");writeFileSync(planPath, "[]\n");
    mkdirSync(join(repo.dir, "src"));writeFileSync(join(repo.dir, "src", "consumer.ts"), "export function consume(approvedFixture: () => void) { return; }\n");
    repo.git("add", "plan", "src");repo.git("commit", "-m", "chore(plan): seed lint fixture");const base = repo.git("rev-parse", "HEAD");
    const { task, facts, context } = approvalFixture("auto", { risk: "high", band_meaning: "span", budget_usd: 5 });
    task.files = [...task.files!, "src/consumer.ts"];
    task.acceptance = [{ claim: "The approved fixture is created", proof: "grep: approved fixture behavior in src/lib/operator-approved-fixture.ts" },
      { claim: "The helper has an existing consumer", proof: "grep: approvedFixture( in src/consumer.ts" }];
    task.risk_ruling!.pin = taskRulingPin(task);
    const record = { ...facts.record, declaredPaths: [...task.files], intentDigest: approvalPlan.newPathApprovalIntentDigest(task, APPROVAL_RECORD_PATH)! };
    const paths = { ...facts.paths, "src/consumer.ts": { checkout: "present" as const, base: "present" as const } };
    const raw = JSON.parse(JSON.stringify(task));delete raw.sourcePath;
    writeFileSync(join(repo.dir, APPROVAL_RECORD_PATH), JSON.stringify([raw]));repo.git("add", "plan");repo.git("commit", "-m", "chore(plan): file selected fixture");
    let reads = 0;
    const deps: runTask.LintPlanStatusDeps = { repoRoot: repo.dir,
      loadConfig: (() => ({ root: repo.dir, serve: { newPathApproval: facts.binding } })) as never,
      resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }), ghGateway: () => fakeGitHub(),
      projectPlan: ((plan: { tasks: Task[] }) => new Map(plan.tasks.map(candidate => [candidate.id, { merged: false }]))) as never,
      openPlanShardSlugs: () => [],
      newPathApproval: { clock: context.clock, prepareFacts: async selected => {
        reads++;return { ...facts, record, paths, currentSourcePath: selected.sourcePath! };
      } },
    };
    const code = await runTask.lintPlanCommand(["--plan", planPath, "--base", base], deps);
    assert.equal(reads, 1, "the actual changed-task command must prepare selected current facts");
    assert.equal(code, 0, "a qualified exact-intent receipt passes the actual lint command's normal checks");
    const offline = await runTask.lintPlanCommand(["--plan", planPath, "--base", base], { ...deps, offline: true });
    assert.notEqual(offline, 0);assert.equal(reads, 1, "offline must refuse the new exception without issuer I/O");
  } finally { repo.cleanup(); }
});

test("new path admission agrees between the real filing precheck and plan lint before the actual proposal commit", async () => {
  const prepare = (runTask as unknown as { prepareNewPathPlanProposalCommit?: typeof runTask.prepareNewPathPlanProposalCommit }).prepareNewPathPlanProposalCommit;
  assert.equal(typeof prepare, "function", "real plan and triage commit paths must await the selected precheck before staging");
  const repo = gitRepo({ kind: "approval-before-staging" });
  try {
    repo.addRemote("origin", "https://github.com/acme/remudero.git");
    mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
    const { task, facts, context } = approvalFixture("auto"), raw = JSON.parse(JSON.stringify(task));delete raw.sourcePath;
    const text = JSON.stringify([raw]), path = join(repo.dir, APPROVAL_RECORD_PATH);
    writeFileSync(path, text);
    let staged = 0, selectedReads = 0, selectedFacts: NewPathApprovalFacts = facts;
    const io: runTask.NewPathProposalCommitIO = { clock: context.clock,
      prepareFacts: async () => { selectedReads++;return selectedFacts; }, commit: () => { staged++; } };
    const config = () => ({ root: repo.dir, serve: { newPathApproval: facts.binding } });
    const ready = await prepare!(repo.dir, "chore(plan): fixture", () => {}, config, io);
    assert.equal(staged, 0, "preparation is not staging");ready();assert.equal(staged, 1);assert.equal(selectedReads, 1);
    selectedFacts = { state: "unknown", reason: "fixture current issuer unavailable" };
    await assert.rejects(prepare!(repo.dir, "chore(plan): fixture", () => {}, config, io), /new.path approval UNKNOWN/);
    assert.equal(staged, 1);
    selectedFacts = facts;
    const changed = await prepare!(repo.dir, "chore(plan): fixture", () => {}, config, io);
    writeFileSync(path, text.replace("Exact approved fixture behavior", "Unapproved substituted behavior"));
    assert.throws(changed, /changed before staging/);assert.equal(staged, 1);
    const legacy = { ...raw };delete legacy.new_path_approval_ref;writeFileSync(path, JSON.stringify([legacy]));
    const before = selectedReads;
    const old = await prepare!(repo.dir, "chore(plan): fixture", () => {}, () => { throw new Error("legacy must not load approval config"); }, io);
    old();assert.equal(staged, 2);assert.equal(selectedReads, before);
  } finally { repo.cleanup(); }
});

test("new path admission preserves legacy proposals and independent owner holds when actual serve routes assemble", async () => {
  const repo = gitRepo({ kind: "approval-serve-assembly" });
  try {
    const { facts } = approvalFixture(), ledgerPath = join(repo.dir, "state", "ledger.ndjson"), planPath = join(repo.dir, "plan", "tasks.yaml");
    mkdirSync(join(repo.dir, "state"), { recursive: true });mkdirSync(join(repo.dir, "plan"), { recursive: true });
    writeFileSync(planPath, "[]\n");writeFileSync(ledgerPath, "");
    const plan = { tasks: [], byId: new Map() };
    let current: NewPathApprovalBinding | undefined;
    const deps: ServeDeps = { board: { plan, ledgerPath, github: fakeGitHub() },
      panelGraph: { root: repo.dir, planPath, ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => {}, reframe: () => {} } },
      ledgerPath, issues: { close: () => {} }, fleetControlRoot: repo.dir, questionsRoot: repo.dir,
      assistantRepository: facts.binding.repository, instances: { coreInstance: facts.binding.instance },
      githubAppRefresh: { env: {} }, tokens: { read: "fixture-read", write: "fixture-write" }, newPathApprovalConfig: () => current };
    assert.deepEqual(buildServeRoutes(deps).filter(route => route.path.startsWith("/v1/new-path-approvals/")), []);
    current = { ...facts.binding };
    const selected = buildServeRoutes(deps).filter(route => route.path.startsWith("/v1/new-path-approvals/"));
    assert.equal(selected.length, 4, "the opted-in real assembled table, not an unused issuer factory");
    assert.equal(existsSync(join(repo.dir, "state", "new-path-approvals-v1")), false, "assembly issues no grant and creates no audit");
    for (const key of ["instance", "repository"] as const) {
      current = { ...facts.binding, [key]: "wrong-context" };
      assert.deepEqual(buildServeRoutes(deps).filter(route => route.path.startsWith("/v1/new-path-approvals/")), []);
    }
  } finally { repo.cleanup(); }
});

test("new path admission actual serve and default HTTPS reader retain current Git and audit evidence without ambient TLS grants", { timeout: 45_000 }, async () => {
  const repo = gitRepo({ kind: "approval-default-https" });
  const key = join(repo.dir, "key.pem"), cert = join(repo.dir, "cert.pem"), conf = join(repo.dir, "tls.cnf");
  writeFileSync(conf, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n", { mode: 0o600 });
  // Per-run certificate, child-only CA, and normal hostname checking: no host trust-store edit or TLS bypass.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-config", conf, "-days", "1"], { stdio: "ignore", timeout: 10_000 });
  repo.addRemote("origin", "https://github.com/acme/remudero.git");
  const { task: original, facts } = approvalFixture("auto"), raw = JSON.parse(JSON.stringify(original));
  delete raw.sourcePath;delete raw.new_path_approval_ref;
  const draftYaml = JSON.stringify([raw]), base = repo.git("rev-parse", "HEAD");
  const ledgerPath = join(repo.dir, "state", "ledger.ndjson"), planPath = join(repo.dir, "plan", "tasks.yaml");
  mkdirSync(join(repo.dir, "state"), { recursive: true });mkdirSync(join(repo.dir, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");writeFileSync(ledgerPath, "");
  const tokenFile = join(repo.dir, "fixture-read-token.json");
  writeFileSync(tokenFile, JSON.stringify({ read: "fixture-read", write: "never-send-fixture-write" }), { mode: 0o600 });
  let current: NewPathApprovalBinding | undefined = { ...facts.binding }, reads = 0, disappearAt = 0, throwConfig = false;
  const plan = { tasks: [], byId: new Map() };
  const deps: ServeDeps = { board: { plan, ledgerPath, github: fakeGitHub() },
    panelGraph: { root: repo.dir, planPath, ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath, issues: { close: () => {} }, fleetControlRoot: repo.dir, questionsRoot: repo.dir,
    assistantRepository: facts.binding.repository, instances: { coreInstance: facts.binding.instance }, githubAppRefresh: { env: {} },
    tokens: { read: "fixture-read", write: "fixture-write" }, operatorIdentityIo: { clock: systemClock },
    newPathApprovalConfig: () => { reads++;if (throwConfig) throw new Error("fixture config unreadable");return disappearAt && reads >= disappearAt ? undefined : current; } };
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "default-https-key", kty: "RSA" } as service.OperatorJwk;
  const session = () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const head = encode({ alg: "RS256", kid: jwk.kid }), now = Math.floor(systemClock.now() / 1_000);
    const body = encode({ iss: "https://session.fixture.invalid", sub: "fixture-user", azp: "https://ui.fixture.invalid", iat: now - 1, exp: now + 60, fva: [0, -1] });
    return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  };
  const nonces = service.createConfirmNonceStore();
  const operatorSession = service.operatorSessionIdentityProvider({ issuer: "https://session.fixture.invalid", allowedOrigins: ["https://ui.fixture.invalid"],
    operatorUserIds: ["fixture-user"], keys: { key: async () => jwk }, clock: systemClock });
  let routes: service.Route[] = [], verifyCalls = 0, driftAfterFirstRead = false, stallBody = false, closedStalledBodies = 0;
  const dispatcher = service.createService({ tokens: deps.tokens!, operatorSession, enforceWriteTiers: true, confirmNonces: nonces,
    routes: ["preview", "confirm", "revoke", "verify"].map((operation): service.Route => ({ method: operation === "verify" ? "GET" : "POST",
      path: `/v1/new-path-approvals/${operation}`, scope: operation === "verify" ? "read" : "write",
      ...(operation === "verify" ? {} : { tier: operation === "preview" ? "middle" : "high", newPathApproval: true }),
      handler: (req, res, ctx) => routes.find(route => route.path === `/v1/new-path-approvals/${operation}`)!.handler(req, res, ctx) })) });
  const tls = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    if (req.url?.startsWith("/v1/new-path-approvals/verify?")) {
      verifyCalls++;assert.equal(req.headers.authorization, "Bearer fixture-read");assert.equal(req.headers[service.OPERATOR_SESSION_HEADER], undefined);
      if (stallBody) { res.once("close", () => { closedStalledBodies++; });res.writeHead(200, { "content-type": "application/json" });res.write('{"unfinished":');return; }
      if (driftAfterFirstRead) { driftAfterFirstRead = false;res.once("finish", () => { current = { ...current!, epoch: "changed-after-first-read" }; }); }
    }
    dispatcher.emit("request", req, res);
  });
  await new Promise<void>(resolve => tls.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${(tls.address() as AddressInfo).port}`, ca = readFileSync(cert);
  current = { ...facts.binding, origin };
  const assembled = () => buildServeRoutes(deps).filter(route => route.path.startsWith("/v1/new-path-approvals/"));
  const post = (operation: string, input: unknown) => new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const payload = JSON.stringify(input), path = `/v1/new-path-approvals/${operation}`;
    const req = httpsRequest(origin + path, { method: "POST", ca, agent: false, signal: AbortSignal.timeout(8_000),
      headers: { [service.OPERATOR_SESSION_HEADER]: session(), "x-confirm-nonce": nonces.issue({ method: "POST", path, payload }) } }, res => {
      let bytes = "";res.setEncoding("utf8");res.on("data", chunk => { bytes += chunk; });res.on("error", reject);
      res.on("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(bytes) }); } catch (error) { reject(error); } });
    });req.on("error", reject);req.end(payload);
  });
  const preview = () => post("preview", { draftYaml, recordPath: APPROVAL_RECORD_PATH, approvedMissingPaths: original.files, lifetimeMs: 60_000 });
  const childScript = `import {prepareNewPathApprovalFacts} from "#src/lib/plan.js";
    const input=JSON.parse(process.argv[1]);let calls=0,ticks=0;const timer=setInterval(()=>ticks++,10);const bind=()=>{calls++;return input.absentBinding?undefined:input.binding;};
    const started=performance.now();const facts=await prepareNewPathApprovalFacts(input.task,input.recordPath,{repoRoot:input.root,base:input.base,readTokenFile:input.tokenFile,currentBinding:bind},AbortSignal.timeout(8000));
    clearInterval(timer);console.log(JSON.stringify({state:facts?.state??null,facts,calls,ticks,elapsedMs:performance.now()-started}));`;
  const read = async (task: Task, trust = true, absentBinding = false) => {
    const env = { ...process.env };delete env.NODE_TLS_REJECT_UNAUTHORIZED;delete env.NODE_EXTRA_CA_CERTS;
    if (trust) env.NODE_EXTRA_CA_CERTS = cert;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript,
      JSON.stringify({ task, binding: current, root: repo.dir, base, tokenFile, recordPath: APPROVAL_RECORD_PATH, absentBinding })],
      { cwd: REPO_ROOT, env, timeout: 12_000, maxBuffer: 128 * 1_024 });
    return JSON.parse(stdout.trim()) as { state: string | null; facts?: NewPathApprovalFacts; calls: number; ticks: number; elapsedMs: number };
  };
  try {
    throwConfig = true;assert.deepEqual(assembled(), []);throwConfig = false;
    routes = assembled();assert.equal(routes.length, 4);
    assert.equal(existsSync(join(repo.dir, "state", "new-path-approvals-v1")), false);
    reads = 0;disappearAt = 2;assert.equal((await preview()).status, 409, "binding lost inside the real paths callback remains unknown");disappearAt = 0;
    const first = await preview();assert.equal(first.status, 200);
    const issued = await post("confirm", { previewId: first.body.previewId });assert.equal(issued.status, 200);
    const task = { ...approvalPlan.parseNewPathApprovalDraft(draftYaml, APPROVAL_RECORD_PATH), new_path_approval_ref: issued.body.reference };
    const auditPath = join(repo.dir, "state", "new-path-approvals-v1", `${task.new_path_approval_ref}.json`);
    assert.equal(lstatSync(auditPath).mode & 0o777, 0o600);
    let before = verifyCalls;
    assert.equal((await read(task, false)).state, "unknown");assert.equal(verifyCalls, before, "untrusted TLS fails before issuer dispatch");
    const observed = await read(task);assert.equal(observed.state, "verified");assert.equal(verifyCalls - before, 2, "real default fetch rereads after actual checkout/base evidence");
    assert.ok(observed.ticks > 0, "the real child event loop stays responsive during native transport and Git reads");
    assert.ok(observed.facts?.state === "verified");assert.deepEqual(observed.facts.paths, { [task.files![0]!]: { checkout: "missing", base: "missing" } });
    const prepared = { clock: systemClock, newPathApprovals: new Map([[task.id, observed.facts]]) };
    const filing = JSON.parse(JSON.stringify(task));delete filing.sourcePath;
    const abs = join(repo.dir, APPROVAL_RECORD_PATH);mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });writeFileSync(abs, JSON.stringify([filing]));
    assert.equal(machineShardLandingRefusal(repo.dir, [APPROVAL_RECORD_PATH], () => false, undefined, prepared), undefined);
    const guard = machineShardLandingGuard({ repoRoot: repo.dir, preparedAdmission: prepared });
    assert.equal(guard(repo.dir, [APPROVAL_RECORD_PATH]), undefined, "real landing forwards the same current facts");
    assert.match(machineShardLandingGuard({ repoRoot: repo.dir })(repo.dir, [APPROVAL_RECORD_PATH])!, /approval/i, "stored reference is not prepared authority");
    before = verifyCalls;const legacy = { ...task };delete legacy.new_path_approval_ref;
    assert.equal((await read(legacy)).state, null);assert.equal((await read(task, true, true)).state, "unknown");assert.equal(verifyCalls, before);
    renameSync(tokenFile, tokenFile + ".preserved-original");symlinkSync(tokenFile + ".preserved-original", tokenFile);
    assert.equal((await read(task)).state, "unknown");assert.equal(verifyCalls, before, "a symlink credential never reaches the real transport");
    renameSync(tokenFile, tokenFile + ".retained-symlink");renameSync(tokenFile + ".preserved-original", tokenFile);
    stallBody = true;const timedOut = await read(task);stallBody = false;
    assert.equal(timedOut.state, "unknown");assert.ok(timedOut.ticks > 10, "the default body deadline does not block the child event loop");
    assert.ok(timedOut.elapsedMs >= 4_000 && timedOut.elapsedMs < 7_000, "the real five-second deadline, not the outer eight-second fixture abort, ends the stalled read");
    assert.equal(verifyCalls - before, 1, "a stalled body never reaches a second verification");assert.equal(closedStalledBodies, 1, "default cancellation closes the stalled response");
    driftAfterFirstRead = true;assert.equal((await read(task)).state, "unknown");
    current = { ...facts.binding, origin };
    renameSync(auditPath, auditPath + ".preserved-original");writeFileSync(auditPath, readFileSync(auditPath + ".preserved-original"), { mode: 0o600 });
    assert.equal((await read(task)).state, "unknown", "same-byte replacement audit is not current retention");
    routes = assembled();assert.equal((await read(task)).state, "unknown", "actual reconstructed issuer does not restore authority from audit bytes");
  } finally {
    tls.closeAllConnections();await new Promise<void>((resolve, reject) => tls.close(error => error ? reject(error) : resolve()));repo.cleanup();
  }
});

test("new path admission refuses missing drifted and unsupported authority before staging with real checkout and pinned-base path reads", async () => {
  const read = (approvalPlan as unknown as { readNewPathApprovalPaths?: typeof approvalPlan.readNewPathApprovalPaths }).readNewPathApprovalPaths;
  assert.equal(typeof read, "function", "a permanently injected path port cannot establish real missing-path scope");
  const repo = gitRepo({ kind: "new-path-approval" });
  try {
    repo.addRemote("origin", "https://github.com/acme/remudero.git");
    mkdirSync(join(repo.dir, "src", "lib"), { recursive: true });
    writeFileSync(join(repo.dir, "src", "lib", "existing.ts"), "export {};\n");
    symlinkSync("lib", join(repo.dir, "src", "linked"));
    repo.git("add", "src");repo.git("commit", "-m", "test: seed actual approved path controls");
    const base = repo.git("rev-parse", "HEAD"), { task, facts } = approvalFixture();
    const files = ["src/lib/existing.ts", "src/lib/future.ts", "src/NewFolder/new.ts", "src/linked/future.ts", "src/Lib/future.ts"];
    const context = { repoRoot: repo.dir, base, binding: facts.binding };
    const observed = await read!({ ...task, files }, context, AbortSignal.timeout(2_000));
    assert.deepEqual(observed?.[files[0]!], { checkout: "present", base: "present" });
    assert.deepEqual(observed?.[files[1]!], { checkout: "missing", base: "missing" });
    assert.deepEqual(observed?.[files[2]!], { checkout: "missing", base: "missing" }, "a genuinely new directory is not a guessed Git error");
    assert.equal(observed?.[files[3]!]?.checkout, "unknown", "a symlink ancestor is not missing authority");
    assert.equal(observed?.[files[3]!]?.base, "unknown");
    assert.equal(observed?.[files[4]!]?.checkout, "unknown", "case substitutions are not approved missing paths");
    assert.equal(await read!(task, { ...context, base: "0".repeat(40) }, AbortSignal.timeout(2_000)), undefined, "failed Git reads are UNKNOWN, not all-missing");
    assert.equal(await read!(task, { ...context, binding: { ...facts.binding, repository: "other/remudero" } }, AbortSignal.timeout(2_000)), undefined);
    const cancelled = new AbortController();cancelled.abort();
    assert.equal(await read!(task, context, cancelled.signal), undefined);
  } finally { repo.cleanup(); }
});

test("new path admission agrees between the real filing precheck and plan lint with current asynchronous issuer facts", async () => {
  const prepare = (approvalPlan as unknown as { prepareNewPathApprovalFacts?: typeof approvalPlan.prepareNewPathApprovalFacts }).prepareNewPathApprovalFacts;
  assert.equal(typeof prepare, "function", "selected callers need a current bounded reader, not stored trusted receipt text");
  const repo = gitRepo({ kind: "selected-approval-reader" });
  try {
    repo.addRemote("origin", "https://github.com/acme/remudero.git");
    const { task, facts, context } = approvalFixture("auto"), base = repo.git("rev-parse", "HEAD");
    const tokenFile = join(repo.dir, "fixture-service-tokens.json");
    writeFileSync(tokenFile, JSON.stringify({ read: "fixture-read", write: "must-not-be-sent" }), { mode: 0o600 });
    let current: NewPathApprovalBinding | undefined = { ...facts.binding }, calls = 0, mode = "healthy", eventLoop = false;
    const fetchImpl: typeof fetch = async (url, init) => {
      calls++;assert.equal(new URL(String(url)).origin, facts.binding.origin);assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-read");
      await new Promise<void>(resolve => setImmediate(() => { eventLoop = true;resolve(); }));
      if (mode === "outage") throw new Error("fixture transport outage");
      if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://other.invalid" } });
      if (mode === "oversized") return new Response(" ".repeat(256 * 1_024), { status: 200 });
      if (mode === "policy-drift") current = { ...facts.binding, epoch: "replacement" };
      return new Response(mode === "malformed" ? "{" : JSON.stringify({ state: "verified", reference: task.new_path_approval_ref,
        record: facts.record, observedAt: 1_200 }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const readerContext = { repoRoot: repo.dir, base, readTokenFile: tokenFile, currentBinding: () => current };
    const io = { fetch: fetchImpl, clock: context.clock };
    const observed = await prepare!(task, APPROVAL_RECORD_PATH, readerContext, AbortSignal.timeout(2_000), io);
    assert.equal(observed?.state, "verified");assert.equal(eventLoop, true);assert.equal(calls, 2, "recheck the current origin after path reads");
    assert.ok(Object.isFrozen(observed));assert.ok(observed?.state === "verified" && Object.isFrozen(observed.record.binding));
    const raw = JSON.parse(JSON.stringify(task));delete raw.sourcePath;
    const text = JSON.stringify([raw]);
    assert.equal(machineShardFilingRefusal(text, APPROVAL_RECORD_PATH, { pathExists: () => false, pathExistsAtBase: () => false,
      clock: context.clock, newPathApprovals: new Map([[task.id, observed!]]) }), undefined);
    assert.deepEqual(lintTask(task, { machineFilingAdmission: { ...context, newPathApproval: observed } }).violations.filter(v => v.severity === "block"), []);
    for (mode of ["outage", "redirect", "oversized", "malformed", "policy-drift"]) {
      current = { ...facts.binding };
      assert.equal((await prepare!(task, APPROVAL_RECORD_PATH, readerContext, AbortSignal.timeout(2_000), io))?.state, "unknown", mode);
    }
    const before = calls;const legacy: Task = { ...task };delete legacy.new_path_approval_ref;
    assert.equal(await prepare!(legacy, APPROVAL_RECORD_PATH, readerContext, AbortSignal.timeout(2_000), io), undefined);
    current = undefined;
    assert.equal((await prepare!(task, APPROVAL_RECORD_PATH, readerContext, AbortSignal.timeout(2_000), io))?.state, "unknown");
    assert.equal(calls, before, "absent reference or binding means zero approval transport calls");
  } finally { repo.cleanup(); }
});

function approvalFixture(mode: "human" | "auto" = "human", overrides: Partial<Task> = {}) {
  const plan = loadPlanFromYaml([
    "- id: W1-T99001", "  title: Create the explicitly approved fixture module", "  repo: remudero",
    "  depends_on: []", "  type: implement", "  verify: human", "  risk: medium", "  status: queued",
    "  attempts: 0", "  author_class: machine", "  files: [src/lib/operator-approved-fixture.ts]",
    "  design: Exact approved fixture behavior", "  rationale: A fixture, not an issued approval", "  origin: fixture:new-path-approval",
  ].join("\n"), APPROVAL_RECORD_PATH);
  const task = Object.assign(plan.tasks[0]!, { new_path_approval_ref: APPROVAL_REFERENCE });
  Object.assign(task, overrides);
  if (mode === "auto") {
    task.verify = "auto";
    task.acceptance = [{ claim: "The approved fixture is created", proof: "unit test: approved fixture behavior" }];
    task.risk_ruling = { verdict: "operator", action: "proceed", confidence: 1, reasons: ["fixture-only approval"],
      judged_at: "2026-10-23T00:00:00Z", pin: taskRulingPin(task) };
  }
  const binding = {
    issuerId: "fixture-issuer", origin: "https://fixture.invalid", epoch: "fixture-epoch-1", policy: "new-path-approval-v1",
    repositoryId: 7, repository: "acme/remudero", instance: "fixture-core", audience: "fixture-filer",
  };
  // Independent protocol fixture: sourcePath binds the canonical destination, not a host's
  // temporary checkout prefix. The reference alone is excluded to avoid signing itself.
  const canonicalTask = JSON.parse(JSON.stringify(task)) as Record<string, unknown>;
  delete canonicalTask.new_path_approval_ref;
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
    const serialized = JSON.stringify(value);
    assert.ok(serialized !== undefined, "the protocol fixture contains only JSON values");
    return serialized;
  };
  const intentDigest = createHash("sha256").update("remudero:new-path-approval-v1:task-intent\0").update(
    stable({ protocol: "new-path-approval-v1", recordPath: APPROVAL_RECORD_PATH, task: canonicalTask }),
  ).digest("hex");
  const record = {
    protocol: "new-path-approval-v1" as const, reference: APPROVAL_REFERENCE, binding, taskId: task.id, taskRepo: task.repo,
    intentDigest, recordPath: APPROVAL_RECORD_PATH, declaredPaths: [...task.files!], approvedMissingPaths: [...task.files!],
    operatorId: "operator:fixture-user", confirmationId: "fixture-confirmation", issuedAt: 1_000, expiresAt: 2_000,
  };
  const facts = {
    state: "verified" as const, reference: APPROVAL_REFERENCE, binding, record, observedAt: 1_200,
    currentSourcePath: task.sourcePath!, recordPath: APPROVAL_RECORD_PATH,
    paths: { "src/lib/operator-approved-fixture.ts": { checkout: "missing" as const, base: "missing" as const } },
  };
  const context = {
    plan, releasedIds: new Set([task.id]), pathExists: () => false, pathExistsAtBase: () => false,
    clock: fixedClock(1_200), newPathApproval: facts,
  };
  return { plan, task, context, facts, record };
}

test("new path admission binds the explicit approval to the exact task and declared paths", () => {
  const { task, context } = approvalFixture();
  assert.deepEqual(machineFilingAdmissionViolations(task, context), [], "qualified facts admit only the explicitly approved missing path");
  for (const changed of [
    { ...task, id: "W1-T99002" }, { ...task, repo: "other-repo" },
    { ...task, design: "Different requested behavior" }, { ...task, rationale: "A different justification" },
    { ...task, files: [...task.files!, "src/lib/unapproved-extra.ts"] },
  ]) assert.notDeepEqual(machineFilingAdmissionViolations(changed, context), [], "task or full intent drift must not inherit permission");
});

test("new path admission agrees between the real filing precheck and plan lint", () => {
  const { task, context, facts } = approvalFixture("auto");
  const raw = JSON.parse(JSON.stringify(task));
  delete raw.sourcePath;
  const text = JSON.stringify([raw]);
  const paths = { pathExists: () => false, pathExistsAtBase: () => false, clock: context.clock,
    newPathApprovals: new Map([[task.id, facts]]) };
  assert.equal(machineShardFilingRefusal(text, APPROVAL_RECORD_PATH, paths), undefined,
    "the actual maintained precheck receives the same selected facts as plan lint");
  assert.deepEqual(lintTask(task, { machineFilingAdmission: context }).violations.filter(v => v.severity === "block"), []);
  assert.doesNotThrow(() => assertLintClean(task, { machineFilingAdmission: context }));
  for (const approval of [undefined, { state: "unknown" as const, reason: "authority unavailable" },
    { ...facts, record: { ...facts.record, taskId: "W1-T99002" } }]) {
    const selected = new Map<string, NewPathApprovalFacts>();
    if (approval) selected.set(task.id, approval);
    assert.match(machineShardFilingRefusal(text, APPROVAL_RECORD_PATH, { ...paths, newPathApprovals: selected }) ?? "", /new-path approval UNKNOWN/);
    assert.match(lintTask(task, { machineFilingAdmission: { ...context, newPathApproval: approval } }).violations
      .filter(v => v.severity === "block").map(v => v.message).join(";"), /new-path approval UNKNOWN/);
  }
});

test("new path admission preserves legacy proposals and independent owner holds", () => {
  const { task, context } = approvalFixture("auto");
  const pin = taskRulingPin(task);
  assert.equal(taskRulingPin({ ...task, new_path_approval_ref: `npa1_${"B".repeat(43)}` }), pin,
    "the independent receipt does not silently change the legacy ruling pin");
  const withoutApproval: Task = { ...task };
  delete withoutApproval.new_path_approval_ref;
  const legacyContext = { ...context, newPathApproval: undefined, pathExists: () => true,
    clock: { ...fixedClock(1_200), now() { throw new Error("legacy admission must not read the approval clock"); } } };
  assert.deepEqual(machineFilingAdmissionViolations(withoutApproval, legacyContext), []);
  assert.equal(Object.hasOwn(loadPlanFromYaml("- id: W1-T99009\n  title: legacy\n  repo: remudero\n  type: implement\n", "legacy").tasks[0]!, "new_path_approval_ref"), false);
  const held = approvalFixture("auto", { dispatch_hold: true });
  assert.deepEqual(machineFilingAdmissionViolations(held.task, held.context), [], "a qualified receipt can establish path scope without releasing the hold");
  assert.deepEqual(runnableCandidates(held.plan, () => true, 3), [], "the actual selector still honors the owner's independent dispatch hold");
  assert.notDeepEqual(machineFilingAdmissionViolations({ ...task, status: "blocked" }, context), []);
  const dependent = approvalFixture("auto", { depends_on: ["W1-T99002"] });
  assert.match(machineFilingAdmissionViolations(dependent.task, dependent.context).join(";"), /unmerged dependencies/);
});

test("new path admission refuses missing drifted and unsupported authority before staging", async (t) => {
  await t.test("missing or expired prepared evidence never reaches the staging effect", () => {
    const { task, context, facts, record } = approvalFixture();
    assert.deepEqual(machineFilingAdmissionViolations(task, context), [], "a refusal control must first admit the genuinely qualified same-task fixture");
    let staged = 0;
    for (const evidence of [undefined, { state: "unknown" as const, reason: "issuer unavailable" },
      { ...facts, record: { ...record, expiresAt: 1_100 } },
      { ...facts, binding: { ...facts.binding, epoch: "replacement-epoch" } },
      { ...facts, paths: { "src/lib/operator-approved-fixture.ts": { checkout: "unknown" as const, base: "missing" as const } } },
    ]) {
      const reasons = machineFilingAdmissionViolations(task, { ...context, newPathApproval: evidence });
      if (reasons.length === 0) staged++;
      assert.match(reasons.join(";"), /new-path approval UNKNOWN:/);
    }
    assert.equal(staged, 0);
  });
  await t.test("an unsupported task cannot match an omitted digest", () => {
    const { task, context, facts, record } = approvalFixture();
    const malformed = { ...task, unsupported: "acted-on-looking data" } as Task;
    const evidence = { ...facts, record: { ...record, intentDigest: undefined } } as unknown as NewPathApprovalFacts;
    assert.notDeepEqual(machineFilingAdmissionViolations(malformed, { ...context, newPathApproval: evidence }), []);
  });
  await t.test("a digest never invokes a nested array accessor", () => {
    const { task } = approvalFixture();
    const files = [...task.files!];
    let invoked = 0;
    Object.defineProperty(files, "0", { enumerable: true, get() { invoked++; return "src/lib/operator-approved-fixture.ts"; } });
    assert.equal(approvalPlan.newPathApprovalIntentDigest({ ...task, files }, APPROVAL_RECORD_PATH), undefined);
    assert.equal(invoked, 0, "unsupported data is rejected without executing accessors");
  });
  await t.test("hidden and symbol task fields are unsupported rather than unsigned data", () => {
    const { task } = approvalFixture();
    for (const key of ["hidden", Symbol("hidden")]) {
      const changed = { ...task };
      Object.defineProperty(changed, key, { value: "unsupported", enumerable: false });
      assert.equal(approvalPlan.newPathApprovalIntentDigest(changed, APPROVAL_RECORD_PATH), undefined);
    }
  });
  await t.test("selected YAML refuses unsupported fields instead of dropping their bytes", () => {
    const { task } = approvalFixture();
    const raw = JSON.parse(JSON.stringify(task));
    delete raw.sourcePath;
    for (const changed of [{ ...raw, unsupported: "silently lost" }, { ...raw, design: { nested: "lost" } },
      { ...raw, depends_on: "not-a-sequence" }, { ...raw, files: "not-a-sequence" },
      { ...raw, verify: "unsupported" }, { ...raw, sourcePath: "a-spoofed-destination" }]) {
      assert.throws(() => loadPlanFromYaml(JSON.stringify([changed]), APPROVAL_RECORD_PATH), /new.path approval.*unsupported/i);
    }
  });
  await t.test("selected aliases and cyclic input refuse without recursing into detachment", () => {
    const text = `- &task\n  id: W1-T99001\n  title: fixture\n  repo: remudero\n  type: implement\n  new_path_approval_ref: ${APPROVAL_REFERENCE}\n  context: [*task]\n`;
    assert.throws(() => loadPlanFromYaml(text, APPROVAL_RECORD_PATH), /new.path approval.*unsupported/i);
  });
  await t.test("confirmation authority requires a genuine fresh signed-session dispatcher and consumed action nonce", async () => {
    const action = (service as unknown as { verifiedNewPathApprovalAction?: (req: IncomingMessage, confirmed: boolean) => { actor: string } | undefined }).verifiedNewPathApprovalAction;
    assert.equal(typeof action, "function", "a public actor symbol or provider name is not confirmation provenance");
    assert.equal(action!({ [Symbol.for("remudero.service.verifiedActor")]: "operator:fixture-user" } as unknown as IncomingMessage, true), undefined);
    const now = Date.UTC(2026, 9, 23, 12), clock = fixedClock(now);
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key", kty: "RSA" } as service.OperatorJwk;
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = (claims: Record<string, unknown> = {}) => {
      const head = encoded({ alg: "RS256", kid: jwk.kid });
      const body = encoded({ iss: "https://session.fixture.invalid", sub: "fixture-user", azp: "https://ui.fixture.invalid",
        iat: now / 1_000 - 1, exp: now / 1_000 + 60, fva: [0, -1], ...claims });
      return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
    };
    const provider = () => service.operatorSessionIdentityProvider({ issuer: "https://session.fixture.invalid",
      allowedOrigins: ["https://ui.fixture.invalid"], operatorUserIds: ["fixture-user"], keys: { key: async () => jwk }, clock });
    const path = "/v1/new-path-approvals/confirm", payload = "{}";
    for (const mode of ["genuine", "wrong-provider", "unenforced", "missing-iat", "missing-nonce", "oversized", "cached-oversized"] as const) {
      let effects = 0, consumes = 0, sequence = 0;
      const store = service.createConfirmNonceStore(() => `fixture-nonce-${++sequence}`, clock.now);
      const consume = store.consume.bind(store);
      store.consume = (nonce, intended) => { consumes++; return consume(nonce, intended); };
      let operatorSession = provider();
      if (mode === "wrong-provider") operatorSession = { name: "operator-session", grant: () => undefined,
        authorize: () => ({ scopes: new Set(["read", "write"]), tier: "high", actor: "operator:fixture-user" }) };
      if (mode === "cached-oversized") {
        const authorize = operatorSession.authorize!.bind(operatorSession);
        operatorSession.authorize = (req, allow) => {
          (req as unknown as Record<symbol, unknown>)[service.RAW_BODY_CACHE] = "x".repeat(256 * 1_024);
          return authorize(req, allow);
        };
      }
      let captured: IncomingMessage | undefined;
      const authorize = operatorSession.authorize!.bind(operatorSession);
      operatorSession.authorize = (req, allow) => { captured = req; return authorize(req, allow); };
      const route = { method: "POST", path, scope: "write", tier: "high", newPathApproval: true,
        handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => {
          const proof = action!(req, true);
          if (proof) effects++;
          res.writeHead(proof ? 200 : 403, { "content-type": "application/json" });
          res.end(JSON.stringify({ actor: proof?.actor }));
        } } as service.Route;
      const server = service.createService({ tokens: { read: "fixture-read", write: "fixture-write" }, operatorSession,
        enforceWriteTiers: mode !== "unenforced", confirmNonces: store, routes: [route] });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
      try {
        const nonce = store.issue({ method: "POST", path, payload });
        const response = await fetch(url, { method: "POST", body: mode === "oversized" ? "x".repeat(256 * 1_024) : payload,
          headers: { [service.OPERATOR_SESSION_HEADER]: token(mode === "missing-iat" ? { iat: undefined } : {}),
            ...(mode === "missing-nonce" ? {} : { "x-confirm-nonce": nonce }) }, signal: AbortSignal.timeout(2_000) });
        assert.equal(response.status, mode === "genuine" ? 200 : mode.includes("oversized") ? 413 : 403, mode);
        await response.text();
        if (mode === "genuine") {
          const replay = await fetch(url, { method: "POST", body: payload, headers: { [service.OPERATOR_SESSION_HEADER]: token(), "x-confirm-nonce": nonce }, signal: AbortSignal.timeout(2_000) });
          assert.equal(replay.status, 403);await replay.text();
        }
        assert.equal(effects, mode === "genuine" ? 1 : 0, "forbidden effect stays trapped");
        assert.ok(captured);
        assert.equal(action!(captured, false), undefined, "a completed or refused dispatch retains no reusable handler provenance");
        if (mode.includes("oversized")) assert.equal(consumes, 0, "the byte bound precedes nonce buffering/consumption, including the cache");
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  });
});
