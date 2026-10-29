import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import { ProductCaseService, productCaseCommandSchema, productCasePlanText } from "#src/lib/product-case.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { ProductBuildService, productBuildKickOrigin, productPlanOrigin, readTargetExecution } from "#src/lib/product-build.js";
import { buildProductCaseRoutes } from "#src/lib/product-routes.js";
import { captureLocalQualificationReceipt, readLocalQualificationReceipt } from "#src/lib/local-qualification-receipt.js";
import { resolveProjectPreflight } from "#src/lib/ci-project-preflight.js";
import { defaultPreflightSpawn } from "#src/lib/commit-message.js";
import type { PreflightSummary } from "#src/lib/ci-parity.js";
import { ghTextAsync } from "#src/lib/github-transport.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { makeRuntimeFixture } from "#test/helpers/native-runtime-fixture.js";
import { declaredBody, violations } from "#test/helpers/openapi-strict.js";
import { preflightCommand, runTask } from "#test/helpers/run-task-test.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { WorkerResult } from "#src/lib/worker.js";
import type { TestSlotOptions } from "#src/lib/test-slot.js";

const authorModule = "#scripts/preflight-author.mjs";
const { main: authorPreflight } = await import(authorModule);

const actor = "clerk:alice";
const taskId = "W9-T1";
const runId = `${taskId}-1793230000000`;
const trusted = "remudero-reviewer[bot]";
const repository = { provider: "github" as const, id: 1432832754, owner: "craigoley", name: "wreckterra",
  defaultBranch: "main", visibility: "public" as const, verifiedAt: new Date().toISOString() };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fixtureSlots = (root: string): TestSlotOptions => ({
  dir: join(root, "fixture-test-slots"), slots: 1, memoryBytes: 512 * 1024 ** 2,
  memoryHeadroom: () => 4 * 1024 ** 3, load: () => ({ cores: 1, load1: 0 }), waitBoundMs: 0,
});

async function fixture(t: TestContext) {
  const root = ownedFixtureDir(t, "case-run-receipts").dir;
  const repo = gitRepo({ scope: t });
  repo.addRemote("origin", "https://github.com/craigoley/wreckterra.git");
  let head = repo.git("rev-parse", "HEAD");
  mkdirSync(join(root, "state"), { recursive: true });
  const store = new ProductIntentStore({ root });
  const brief = { idea: "a correlated native source run", resourceEnvelope: { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true } };
  const saved = store.write(actor, { version: "product-intent-v1", requestId: "receipt-import-0001", expectedRevision: 0,
    brief });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  const command = { version: "product-case-v1", action: "build", command: { version: "product-build-v1", requestId: "receipt-build-00001",
    productId, expectedRevision: 2, expectedObjectiveRevision: 1, planEvidenceId: "reviewed-plan", taskId } };
  let operationId = `pbuild_${hash(command.command)}`;
  const requestedAt = new Date(Date.now() - 10_000).toISOString();
  assert.ok(store.transition(actor, { version: "product-intent-v1", requestId: "receipt-seed-000001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository, stageEvidence: [
      { id: "reviewed-plan", stage: "plan", outcome: "succeeded", objectiveRevision: 1, observedAt: requestedAt,
        references: [{ label: `Reviewed task ${taskId}`, url: "https://github.com/craigoley/wreckterra/pull/7" }] },
    ] }).ok);
  const shim = ghShim([
    { when: "matching-refs/", stdout: "[]" },
    { when: "commits/main", stdout: JSON.stringify({ sha: head }) },
    { when: `contents?ref=${head}`, stdout: JSON.stringify([{ name: "src" }]) },
    { when: "contents/plan/tasks.d?", stdout: JSON.stringify([{ name: "W9-T1-source.yaml" }]) },
    { when: "contents/plan/tasks.d/W9-T1-source.yaml", stdout: stringify([{ id: taskId, origin: productPlanOrigin(productId, "reviewed-plan"),
      status: "queued", budget_usd: 10, design: productCasePlanText(brief) }]) },
    { when: "search/issues", stdout: '{"total_count":0}' },
    { when: "pulls/7/reviews", stdout: "[]" },
    { when: "pulls/7/files", stdout: '[{"filename":"plan/tasks.d/W9-T1-source.yaml"}]' },
    { when: "pulls/7", stdout: JSON.stringify({ number: 7, merged_at: requestedAt, merge_commit_sha: head, head: { sha: head }, base: { ref: "main", repo: { id: repository.id } } }) },
    { when: "api repos/craigoley/wreckterra", stdout: JSON.stringify({ id: repository.id, owner: { login: repository.owner }, name: repository.name, private: false, default_branch: "main" }) },
  ]);
  const path = process.env.PATH;
  process.env.PATH = `${shim.dir}:${path}`;
  t.after(() => { process.env.PATH = path; rmSync(shim.dir, { recursive: true, force: true }); });
  const options = { root, repoRoot: root, daemonRoot: () => ({ state: "found" as const, root, instance: "wreckterra" }), planTrustedReviewer: trusted };
  mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, ".remudero/managed-repos.json"), JSON.stringify({ repos: ["craigoley/wreckterra"] }));
  const ledger = join(root, "state/ledger.ndjson");
  const row = (step: string, extra: Record<string, unknown> = {}) => appendFileSync(ledger, JSON.stringify({
    ts: new Date().toISOString(), run_id: runId, task_id: taskId, repo: "wreckterra", step, ...extra }) + "\n");
  writeFileSync(ledger, "");
  const configure = (conclusion = "success", prHead = head, repoId = repository.id) => {
    shim.addRoute({ when: "pulls/8", stdout: JSON.stringify({ number: 8, head: { sha: prHead }, base: { ref: "main", repo: { id: repoId } } }) });
    shim.addRoute({ when: "pulls/8/reviews", stdout: JSON.stringify([{ state: "COMMENTED", commit_id: head, user: { login: trusted, type: "Bot" } }]) });
    shim.addRoute({ when: "protection/required_status_checks", stdout: JSON.stringify({ contexts: ["test", "build", "remudero-review"], checks: [] }) });
    shim.addRoute({ when: `commits/${head}/check-runs`, stdout: JSON.stringify({ total_count: 2, check_runs: ["test", "build"].map((name, id) =>
      ({ id, name, head_sha: head, status: conclusion === "pending" ? "in_progress" : "completed", conclusion: name === "test" ? conclusion : "success" })) }) });
    shim.addRoute({ when: `commits/${head}/status`, stdout: JSON.stringify({ total_count: 1, statuses: [
      { context: "remudero-review", state: "success", creator: { login: trusted, type: "Bot" } }] }) });
  };
  configure();
  const admitted = await new ProductCaseService(options).execute(actor, command);
  assert.ok(admitted.ok, JSON.stringify(admitted));
  assert.ok(admitted.value.build);
  operationId = admitted.value.build.operationId;
  row("console.kick_dispatched", { task: taskId, origin: productBuildKickOrigin(productId, operationId), native_run_id: runId });
  row("run.start");
  row("pr.opened", { head_sha: head, pr_url: "https://github.com/craigoley/wreckterra/pull/8" });
  row("verdict", { verdict: "handed_off" });
  assert.deepEqual(readTargetExecution(join(root, "state"), { taskId, origin: productBuildKickOrigin(productId, operationId), repo: "wreckterra", requestedAt, nowMs: Date.now() }), { state: "ended", runId });
  const route = () => buildProductCaseRoutes(options)[0]!;
  // Invoke the maintained handler with the same verified identity carrier as serve.
  const request = async () => {
    const { Readable } = await import("node:stream");
    const req = Readable.from([Buffer.from(JSON.stringify(command))]);
    Object.assign(req, { [Symbol.for("remudero.service.verifiedActor")]: actor });
    let body = "";
    const res = { setHeader() {}, writeHead(code: number) { this.statusCode = code; }, statusCode: 200, end(value: string) { body = value; } };
    await route().handler(req as never, res as never, {} as never);
    return { status: res.statusCode, body: JSON.parse(body) };
  };
  return { root, repo, get head() { return head; }, set head(value: string) { head = value; }, store, productId, operationId, command, row, ledger, options, shim, configure, request,
    capture: () => captureLocalQualificationReceipt({ worktreeRoot: repo.dir, stateRoot: root, repository: "craigoley/wreckterra", taskId, runId,
      log: (step, fields) => row(step, fields) }) };
}

function consumerSource(f: Awaited<ReturnType<typeof fixture>>) {
  const put = (path: string, value: string) => { mkdirSync(join(f.repo.dir, path, ".."), { recursive: true }); writeFileSync(join(f.repo.dir, path), value); };
  put(".gitignore", "coverage\nnode_modules\n");
  const scripts = { typecheck: "tsc --noEmit", test: "vitest run --maxWorkers=1", "test:coverage": "vitest run --coverage --maxWorkers=1",
    build: "tsc --noEmit && vite build", security: "npm audit --audit-level=low" };
  put("package.json", JSON.stringify({ name: "qualification-fixture", version: "1.0.0", scripts }));
  put("package-lock.json", JSON.stringify({ name: "qualification-fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "qualification-fixture", version: "1.0.0" } } }));
  put("tsconfig.json", "{}");
  put(".github/workflows/ci.yml", `jobs:\n  quality:\n    steps:\n${["typecheck", "test:coverage", "build", "security"].map(name => `      - run: npm run ${name}`).join("\n")}\n`);
  put("test/local.test.cjs", "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('measured fixture',()=>assert.equal(2+2,4));\n");
  for (const tool of ["tsc", "vite", "vitest"]) {
    // The controlled frontend tool executes a real pinned Node test runner, so its count is measured.
    const body = tool === "vitest" ? `const {spawnSync}=require('node:child_process'); const env={...process.env,NODE_V8_COVERAGE:''}; delete env.NODE_TEST_CONTEXT; const r=spawnSync(process.execPath,['--test','--test-reporter=tap','test/local.test.cjs'],{env,encoding:'utf8'}); process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode=r.status;` : "process.exitCode=0;";
    put(`node_modules/.bin/${tool}`, `#!${process.execPath}\n${body}\n`);
    chmodSync(join(f.repo.dir, "node_modules/.bin", tool), 0o755);
  }
  f.repo.git("add", "."); f.repo.git("commit", "-m", "test(receipts): qualify controlled frontend commands");
  f.head = f.repo.git("rev-parse", "HEAD");
  f.row("pr.opened", { head_sha: f.head, pr_url: "https://github.com/craigoley/wreckterra/pull/8" });
  f.configure("success", f.head);
  const produce = async () => {
    const project = resolveProjectPreflight(f.repo.dir);
    assert.equal(project.kind, "consumer");
    const summaryPath = join(f.repo.dir, "coverage/preflight-summary.json");
    const status = await preflightCommand(["--from", "HEAD^", "--summary-file", summaryPath], {
      projectRoot: f.repo.dir, projectTestSlot: fixtureSlots(f.root), spawn: defaultPreflightSpawn,
    });
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as PreflightSummary & { qualityProfile: string };
    return { result: { ok: status === 0, steps: summary.steps }, summary };
  };
  return { produce, put };
}

test("W1-T10865: served reconciliation binds real local and hosted receipts", async t => {
  const f = await fixture(t);
  const producer = consumerSource(f);
  const produced = await producer.produce();
  assert.equal(produced.result.ok, true, JSON.stringify(produced.result));
  const measured = produced.summary.steps.find(step => step.name === "project:test")?.qualification;
  assert.ok(measured?.complete);
  assert.match(measured.output, /# tests 1/);
  const captured = f.capture();
  assert.equal(captured.verdict, "passed", JSON.stringify(captured));
  assert.equal(captured.tests, 1);
  const duplicate = f.capture();
  assert.equal(duplicate.digest, captured.digest);
  assert.equal(duplicate.reference, captured.reference);
  // The served reader needs only the durable snapshot, after its owned source tree is gone.
  f.repo.cleanup();
  const reply = await f.request();
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.evidence.local[0].outcome, "succeeded");
  assert.equal(reply.body.evidence.hosted[0].outcome, "succeeded");
  for (const channel of ["local", "hosted"]) {
    const receipt = reply.body.evidence[channel][0].receipt;
    assert.equal(receipt.actor, actor);
    assert.equal(receipt.productId, f.productId);
    assert.equal(receipt.objectiveRevision, 1);
    assert.equal(receipt.repository.id, repository.id);
    assert.equal(receipt.operationId, f.operationId);
    assert.equal(receipt.runId, runId);
    assert.equal(receipt.taskId, taskId);
    assert.equal(receipt.head, f.head);
  }
  f.head = "e".repeat(40);
  f.row("pr.checks", { head_sha: f.head, conclusion: "green" });
  f.configure();
  const repaired = await f.request();
  assert.equal(repaired.body.evidence.local.filter((item: { current: boolean }) => item.current)[0].outcome, "unknown");
  assert.equal(repaired.body.evidence.hosted.filter((item: { current: boolean }) => item.current)[0].outcome, "succeeded");
});

test("W1-T10865: failed incomplete foreign and stale evidence cannot pass", async t => {
  const f = await fixture(t);
  for (const [conclusion, outcome] of [["failure", "failed"], ["cancelled", "failed"], ["timed_out", "failed"], ["pending", "running"]]) {
    f.configure(conclusion);
    const reply = await f.request();
    assert.ok(reply.body.evidence.hosted.some((item: { outcome: string }) => item.outcome === outcome), JSON.stringify(reply.body));
  }
  f.configure("success", "a".repeat(40));
  assert.equal((await f.request()).body.evidence.hosted.at(-1).outcome, "unknown");
  f.configure("success", f.head, 7);
  assert.equal((await f.request()).body.evidence.hosted.at(-1).outcome, "unknown");
  f.configure();
  const success = await f.request();
  assert.ok(success.body.evidence.hosted.some((item: { outcome: string }) => item.outcome === "failed"));
  assert.equal(success.body.evidence.hosted.at(-1).outcome, "succeeded");
  f.configure("failure");
  const redAgain = (await f.request()).body.evidence.hosted.filter((item: { current: boolean }) => item.current);
  assert.equal(redAgain.length, 1);
  assert.equal(redAgain[0].outcome, "failed", "reusing an earlier failed receipt must not leave a later success current");
});

test("W1-T10865: replay restart and concurrent edits retain one receipt", async t => {
  const f = await fixture(t);
  assert.ok((await new ProductBuildService(f.options).execute(actor, f.command.command)).ok);
  const concurrent = await Promise.all([f.request(), f.request()]);
  for (const reply of concurrent) assert.equal(reply.status, 200, JSON.stringify(reply.body));
  await new ProductCaseService(f.options).execute(actor, f.command);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: "" };
  delete env.NODE_TEST_CONTEXT;
  const child = `import {ProductCaseService} from '#src/lib/product-case.js';
    process.env.PATH=${JSON.stringify(process.env.PATH)};
    const root=${JSON.stringify(f.root)};
    const result=await new ProductCaseService({root,repoRoot:root,daemonRoot:()=>({state:'found',root,instance:'wreckterra'}),planTrustedReviewer:${JSON.stringify(trusted)}}).execute(${JSON.stringify(actor)},${JSON.stringify(f.command)});
    console.log(JSON.stringify(result));`;
  const restarted = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--import", join(REPO_ROOT, "test/setup/tmp-hygiene.ts"), "--input-type=module", "-e", child], { cwd: REPO_ROOT, env, encoding: "utf8" }));
  assert.ok(restarted.ok, JSON.stringify(restarted));
  const product = f.store.read(actor, f.productId); assert.ok(product.ok);
  assert.equal(product.value.stageEvidence.filter(item => item.id.startsWith("case-local:")).length, 1);
  assert.equal(product.value.stageEvidence.filter(item => item.id.startsWith("case-hosted:")).length, 1);
  const transition = ProductIntentStore.prototype.transition;
  let raced = false;
  t.mock.method(ProductIntentStore.prototype, "transition", function(this: ProductIntentStore, who: string, raw: unknown) {
    const input = raw as { requestId: string; expectedRevision: number };
    if (!raced && input.requestId.startsWith("case_")) {
      raced = true;
      const read = f.store.read(actor, f.productId); assert.ok(read.ok);
      assert.ok(transition.call(f.store, actor, { version: "product-intent-v1", requestId: "receipt-race-00001", id: f.productId,
        expectedRevision: read.value.revision, expectedObjectiveRevision: 1, stageEvidence: [{ id: "concurrent-note", stage: "research", outcome: "unknown",
          objectiveRevision: 1, observedAt: new Date().toISOString(), references: [] }] }).ok);
    }
    return transition.call(this, who, raw);
  });
  f.configure("failure");
  const retried = await f.request();
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.ok(raced);
  assert.ok(f.store.read(actor, f.productId).value?.stageEvidence.some(item => item.id === "concurrent-note"));
  assert.equal(retried.body.evidence.hosted.filter((item: { current: boolean }) => item.current)[0].outcome, "failed");
  let duplicateCommitted = false;
  t.mock.method(ProductIntentStore.prototype, "transition", function(this: ProductIntentStore, who: string, raw: unknown) {
    const input = raw as { requestId: string; stageEvidence?: { observedAt: string }[] };
    if (!duplicateCommitted && input.requestId.startsWith("case_")) {
      duplicateCommitted = true;
      const committed = transition.call(f.store, who, { ...input, stageEvidence: input.stageEvidence?.map(item => ({ ...item,
        observedAt: new Date(Date.parse(item.observedAt) + 1).toISOString() })) });
      assert.ok(committed.ok, JSON.stringify(committed));
    }
    return transition.call(this, who, raw);
  });
  f.configure("pending");
  const lostResponse = await f.request();
  assert.equal(lostResponse.status, 200, JSON.stringify(lostResponse.body));
  assert.ok(duplicateCommitted);
  assert.equal(lostResponse.body.evidence.hosted.filter((item: { current: boolean }) => item.current)[0].outcome, "running");
  const beforeObjectiveChange = f.store.read(actor, f.productId); assert.ok(beforeObjectiveChange.ok);
  assert.ok(f.store.write(actor, { version: "product-intent-v1", requestId: "receipt-objective-01", id: f.productId,
    expectedRevision: beforeObjectiveChange.value.revision, brief: { ...beforeObjectiveChange.value.brief, objective: "a changed objective" } }).ok);
  assert.equal((await f.request()).body.error, "stale_revision");
  assert.ok(f.store.read(actor, f.productId).value?.stageEvidence.some(item => item.receipt?.objectiveRevision === 1));
});

test("W1-T10865: served receipts keep typed outcomes without an HTTP writer", async t => {
  const f = await fixture(t);
  f.row("verdict", { verdict: "merged" });
  assert.equal(productCaseCommandSchema.safeParse({ version: "product-case-v1", action: "evidence", command: {} }).success, false);
  const reply = await f.request();
  assert.ok(reply.body.evidence.local.length, JSON.stringify(reply.body));
  assert.equal(reply.body.evidence.local[0].outcome, "unknown");
  assert.equal(reply.body.evidence.local[0].receipt.channel, "local");
  assert.equal(readLocalQualificationReceipt({ stateRoot: f.root, taskId, runId, head: f.head, repository: "craigoley/wreckterra", row: {} }).outcome, "unknown");
  assert.deepEqual(violations(reply.body, declaredBody("/v1/products/case", "POST", 200)), []);
  const publicBuild = await new ProductBuildService(f.options).execute(actor, f.command.command);
  assert.ok(publicBuild.ok);
  assert.deepEqual(Object.keys(publicBuild.value).sort(), ["receipt", "replayed"]);
});

test("W1-T10865: replay restart and concurrent edits retain one receipt — objective edit during collection", async t => {
  const f = await fixture(t);
  let edited = false;
  const result = await new ProductCaseService({ ...f.options, planText: async (args, options) => {
    const text = await ghTextAsync(args, options);
    if (!edited && args[1]?.includes("/required_status_checks")) {
      edited = true;
      const read = f.store.read(actor, f.productId); assert.ok(read.ok);
      assert.ok(f.store.write(actor, { version: "product-intent-v1", requestId: "receipt-racing-objective", id: f.productId,
        expectedRevision: read.value.revision, brief: { ...read.value.brief, objective: "concurrent objective" } }).ok);
    }
    return text;
  } }).execute(actor, f.command);
  assert.equal(result.code, "stale_revision");
  const after = f.store.read(actor, f.productId); assert.ok(after.ok);
  assert.equal(after.value.brief.objective, "concurrent objective");
  assert.equal(after.value.stageEvidence.filter(item => item.receipt?.channel === "hosted").length, 0);
});

test("W1-T10865: replay restart and concurrent edits retain one receipt — evidence capacity refuses without eviction", async t => {
  const f = await fixture(t);
  assert.equal((await f.request()).status, 200);
  let read = f.store.read(actor, f.productId); assert.ok(read.ok);
  const retained = read.value.stageEvidence.map(item => item.id);
  while (read.value.stageEvidence.length < 128) {
    const start = read.value.stageEvidence.length;
    const count = Math.min(16, 128 - start);
    const saved = f.store.transition(actor, { version: "product-intent-v1", requestId: `capacity-fill-${String(start).padStart(6, "0")}`,
      id: f.productId, expectedRevision: read.value.revision, expectedObjectiveRevision: 1,
      stageEvidence: Array.from({ length: count }, (_, index) => ({ id: `capacity-${start + index}`, stage: "research", outcome: "unknown",
        objectiveRevision: 1, observedAt: new Date().toISOString(), references: [] })) });
    assert.ok(saved.ok, JSON.stringify(saved));
    read = f.store.read(actor, f.productId); assert.ok(read.ok);
  }
  f.configure("failure");
  assert.equal((await f.request()).body.error, "capacity");
  const after = f.store.read(actor, f.productId); assert.ok(after.ok);
  assert.equal(after.value.stageEvidence.length, 128);
  for (const id of retained) assert.ok(after.value.stageEvidence.some(item => item.id === id));
});

test("W1-T10865: failed incomplete foreign and stale evidence cannot pass — hosted controls", async t => {
  const scenarios = [
    ["empty required set", "protection/required_status_checks", { contexts: [], checks: [] }, "unknown"],
    ["truncated check page", "/check-runs", { total_count: 100, check_runs: [] }, "unknown"],
    ["truncated status page", "/status", { total_count: 100, statuses: [] }, "unknown"],
    ["truncated reviews", "pulls/8/reviews", Array.from({ length: 100 }, () => ({ state: "COMMENTED", commit_id: "a".repeat(40), user: null })), "unknown"],
    ["unknown conclusion", "/check-runs", { check_runs: [{ id: 1, name: "test", head_sha: "CURRENT_HEAD", status: "completed", conclusion: "new-unrecognized-result" }] }, "unknown"],
    ["one arbitrary green", "/check-runs", { check_runs: [] }, "running"],
    ["missing second required context", "/check-runs", { check_runs: [{ id: 1, name: "test", head_sha: "CURRENT_HEAD", status: "completed", conclusion: "success" }] }, "running"],
    ["native review absent", "/status", { statuses: [] }, "running"],
    ["forged native review", "/status", { statuses: [{ context: "remudero-review", state: "success", creator: { login: "stranger", type: "User" } }] }, "unknown"],
    ["standing old-head human hold", "pulls/8/reviews", [{ state: "CHANGES_REQUESTED", commit_id: "b".repeat(40), user: { login: "alice", type: "User" } },
      { state: "COMMENTED", commit_id: "a".repeat(40), user: { login: "alice", type: "User" } }], "failed"],
  ] as const;
  for (const [name, when, body, outcome] of scenarios) await t.test(name, async t => {
    const f = await fixture(t);
    f.shim.addRoute({ when, stdout: JSON.stringify(body).replaceAll("CURRENT_HEAD", f.head) });
    const reply = await f.request();
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.evidence.hosted.filter((item: { current: boolean }) => item.current)[0].outcome, outcome);
  });
  await t.test("required policy read unavailable", async t => {
    const f = await fixture(t);
    f.shim.addRoute({ when: "protection/required_status_checks", stderr: "permission unavailable", exit: 1 });
    assert.equal((await f.request()).body.evidence.hosted[0].outcome, "unknown");
  });
  await t.test("first PR observation must match the logged head", async t => {
    const f = await fixture(t);
    f.configure("success", "f".repeat(40));
    let reads = 0;
    const result = await new ProductCaseService({ ...f.options, planText: async (args, options) => {
      const text = await ghTextAsync(args, options);
      if (args[1]?.endsWith("/pulls/8") && ++reads === 1) f.configure();
      return text;
    } }).execute(actor, f.command);
    assert.ok(result.ok);
    assert.equal(result.value.evidence.hosted.filter(item => item.current)[0]?.outcome, "unknown");
  });
});

test("W1-T10865: failed incomplete foreign and stale evidence cannot pass — durable local controls", async t => {
  const f = await fixture(t);
  const producer = consumerSource(f);
  const { summary } = await producer.produce();
  const original = JSON.stringify(summary);
  for (const change of ["missing", "truncated", "dirty", "wrong-head", "zero-tests", "failed"]) {
    const altered = JSON.parse(original);
    const step = altered.steps.find((step: { name: string }) => step.name === "project:test");
    if (change === "missing") delete step.qualification;
    if (change === "truncated") step.qualification.complete = false;
    if (change === "dirty") step.qualification.sourceBefore.clean = false;
    if (change === "wrong-head") step.qualification.sourceAfter.head = "d".repeat(40);
    if (change === "zero-tests") step.qualification.output = "# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
    if (change === "failed") { altered.ok = false; step.ok = false; step.qualification.exitCode = 1; }
    producer.put("coverage/preflight-summary.json", JSON.stringify(altered));
    const captured = f.capture();
    assert.notEqual(captured.verdict, "passed", change);
    const reply = await f.request();
    assert.notEqual(reply.body.evidence.local.filter((item: { current: boolean }) => item.current)[0].outcome, "succeeded", change);
  }
  producer.put("coverage/preflight-summary.json", original);
  const summaryPath = join(f.repo.dir, "coverage/preflight-summary.json");
  const outside = join(f.root, "foreign-summary.json");
  renameSync(summaryPath, outside); symlinkSync(outside, summaryPath);
  assert.equal(f.capture().verdict, "unknown", "fixed producer paths cannot escape the owned worktree through a symlink");
  rmSync(summaryPath); renameSync(outside, summaryPath);
  writeFileSync(summaryPath, Buffer.alloc(1024 * 1024 + 1, 32));
  assert.equal(f.capture().verdict, "unknown", "oversized receipts remain bounded and unknown");
  producer.put("coverage/preflight-summary.json", original);
  const captured = f.capture();
  assert.equal(captured.verdict, "passed");
  const reply = await f.request();
  assert.equal(reply.body.evidence.local.filter((item: { current: boolean }) => item.current)[0].outcome, "succeeded");
  const corruptPath = join(f.root, "state", captured.reference!);
  const corrupted = JSON.parse(readFileSync(corruptPath, "utf8"));
  corrupted.qualification.tests += 1;
  writeFileSync(corruptPath, JSON.stringify(corrupted));
  assert.equal((await f.request()).body.evidence.local.filter((item: { current: boolean }) => item.current)[0].outcome, "unknown");
  f.row("pr.opened", { head_sha: "e".repeat(40), pr_url: "https://github.com/craigoley/wreckterra/pull/8" });
  assert.equal((await f.request()).body.evidence.local.filter((item: { current: boolean }) => item.current)[0].outcome, "unknown", "later repair heads never inherit qualification");
  assert.doesNotThrow(() => captureLocalQualificationReceipt({ stateRoot: f.root, worktreeRoot: f.repo.dir, repository: "craigoley/wreckterra", taskId, runId,
    log() { throw new Error("fixture log unavailable"); } }));
});

test("W1-T10865: served reconciliation binds real local and hosted receipts — rotated run isolation", async t => {
  const f = await fixture(t);
  renameSync(f.ledger, join(f.root, "state/ledger.20261028T000000000Z.ndjson"));
  writeFileSync(f.ledger, "");
  f.row("pr.opened", { run_id: `${taskId}-foreign`, head_sha: "b".repeat(40), pr_url: "https://github.com/craigoley/wreckterra/pull/99",
    correlated_run_hint: runId });
  const reply = await f.request();
  assert.equal(reply.body.evidence.hosted[0].outcome, "succeeded", JSON.stringify(reply.body));
  assert.equal(reply.body.evidence.hosted[0].receipt.runId, runId);
  writeFileSync(join(f.root, "state/ledger.20261028T010000000Z.ndjson.gz"), "unreadable gzip");
  const incomplete = await f.request();
  const current = incomplete.body.evidence.hosted.filter((item: { current: boolean }) => item.current);
  assert.equal(current.length, 1);
  assert.equal(current[0].outcome, "unknown");
  assert.equal(current[0].receipt.head, "unknown");
});

test("W1-T10865: served reconciliation binds real local and hosted receipts — real core author artifact", async t => {
  const f = makeRuntimeFixture(); t.after(() => f.cleanup());
  const root = ownedFixtureDir(t, "core-qualification-snapshot").dir;
  f.git("update-ref", "refs/remotes/origin/main", "HEAD^");
  f.git("config", "user.name", "qualification fixture");
  f.git("config", "user.email", "qualification@fixture.invalid");
  f.git("config", "core.commitGraph", "false");
  assert.equal(f.git("merge-base", "origin/main", "HEAD"), f.git("rev-parse", "HEAD^"));
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL, previousSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  t.after(() => {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = previousSystem;
  });
  const status = authorPreflight([], { root: f.dir, select: () => ({ fullRun: false, suites: ["test/a.test.ts", "test/b.test.ts"], reasons: ["fixture"] }),
    host: () => ({ cores: 2, load1: 0, headroomBytes: 4 * 1024 ** 3 }), testSlot: fixtureSlots(root) });
  assert.equal(status, 0);
  f.git("remote", "set-url", "origin", "https://github.com/craigoley/remudero.git");
  const rows: Record<string, unknown>[] = [];
  const captured = captureLocalQualificationReceipt({ stateRoot: root, worktreeRoot: f.dir, repository: "craigoley/remudero", taskId, runId,
    log: (step, fields) => rows.push({ step, ...fields }) });
  assert.equal(captured.verdict, "passed", JSON.stringify(captured));
  assert.equal(captured.tests, 2);
  const authorPath = join(f.dir, "coverage/preflight-author.json");
  const authorText = readFileSync(authorPath, "utf8");
  const author = JSON.parse(authorText);
  const tested = author.steps.find((step: { name: string }) => step.name === "affected-tests");
  const nativePath = join(f.dir, tested.diagnostics.nativeResult);
  const nativeText = readFileSync(nativePath, "utf8");
  for (const defect of ["incomplete-output", "missing-capture-time", "lost-owner", "mismatched-count", "incomplete-files"]) {
    const receipt = JSON.parse(authorText), native = JSON.parse(nativeText);
    const step = receipt.steps.find((step: { name: string }) => step.name === "affected-tests");
    if (defect === "incomplete-output") native.outputComplete = false;
    if (defect === "missing-capture-time") delete native.startedAt;
    if (defect === "lost-owner") native.parentTracking.ownerLost = true;
    if (defect === "mismatched-count") step.testSummary.tests += 1;
    if (defect === "incomplete-files") step.judge.reported -= 1;
    writeFileSync(authorPath, JSON.stringify(receipt)); writeFileSync(nativePath, JSON.stringify(native));
    assert.notEqual(captureLocalQualificationReceipt({ stateRoot: root, worktreeRoot: f.dir, repository: "craigoley/remudero", taskId, runId, log() {} }).verdict, "passed", defect);
  }
  writeFileSync(authorPath, authorText); writeFileSync(nativePath, nativeText);
  const head = f.git("rev-parse", "HEAD");
  f.cleanup();
  assert.equal(readLocalQualificationReceipt({ stateRoot: root, repository: "craigoley/remudero", taskId, runId, head, row: rows[0]! }).outcome, "succeeded");
});

test("W1-T10865: failed incomplete foreign and stale evidence cannot pass — native author failures and capacity", async t => {
  for (const mode of ["failed", "over-capacity"]) await t.test(mode, t => {
    const f = makeRuntimeFixture(mode === "failed"); t.after(() => f.cleanup());
    const root = ownedFixtureDir(t, "failed-author-qualification").dir;
    if (mode === "over-capacity") {
      writeFileSync(join(f.dir, "scripts/test-tier-manifest.json"), JSON.stringify({ files: { "test/a.test.ts": 1e9, "test/b.test.ts": 1e9 } }));
      f.git("add", "."); f.git("commit", "-m", "test(receipts): model an over-capacity selection");
    }
    const status = authorPreflight([], { root: f.dir, select: () => ({ fullRun: false, suites: ["test/a.test.ts", "test/b.test.ts"], reasons: ["fixture"] }),
      host: () => ({ cores: 1, load1: 0, headroomBytes: 4 * 1024 ** 3 }), testSlot: fixtureSlots(root) });
    assert.notEqual(status, 0);
    f.git("remote", "set-url", "origin", "https://github.com/craigoley/remudero.git");
    const captured = captureLocalQualificationReceipt({ stateRoot: root, worktreeRoot: f.dir, repository: "craigoley/remudero", taskId, runId, log() {} });
    assert.notEqual(captured.verdict, "passed");
    assert.equal(captured.originalVerdict, mode, JSON.stringify(captured));
  });
});

test("W1-T10865: served reconciliation binds real local and hosted receipts — default final-source capture", async t => {
  const root = ownedFixtureDir(t, "native-qualification-boundary").dir;
  const seed = makeRuntimeFixture(); t.after(() => seed.cleanup());
  const origin = gitRepo({ bare: true, scope: t });
  seed.git("push", origin.dir, "HEAD:refs/heads/main");
  const repo = gitRepo({ cloneFrom: origin.dir, scope: t });
  repo.git("config", "user.name", "qualification fixture");
  repo.git("config", "user.email", "qualification@fixture.invalid");
  mkdirSync(join(root, "repos"));
  const managed = join(root, "repos/remudero");
  renameSync(repo.dir, managed);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(managed, "node_modules"));
  execFileSync("git", ["-C", managed, "remote", "set-url", "origin", "https://github.com/craigoley/remudero.git"]);
  const gitConfig = join(root, "git-global.ini");
  writeFileSync(gitConfig, `[url "${origin.dir}"]\n  insteadOf = https://github.com/craigoley/remudero.git\n`);
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  t.after(() => { if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previousGlobal; });
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, stringify([{ id: taskId, title: "qualification boundary fixture", repo: "remudero", type: "implement", verify: "auto",
    risk: "medium", origin: "test", status: "queued", files: ["src/leaf.ts"] }]));
  const worker = (text: string, failed = false): WorkerResult => ({ sessionId: "receipt-worker", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "",
    subtype: failed ? "error_max_budget_usd" : "success", isError: failed, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false });
  let sourceHead = "", ownedWorktree = "", calls = 0;
  const result = await withLiveWritesAllowed(() => runTask(taskId, {
    owner: "craigoley", config: { claudeBin: "/bin/true", root, installRoot: REPO_ROOT }, skipGitSync: true, planPath,
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "receipt-claim", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async token => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    externalWaitFreshness: () => undefined,
    spawn: async args => {
      if (++calls === 1) return worker("RECON REPORT\nOBSERVED: fixture source\n");
      ownedWorktree = args.cwd;
      const git = (...argv: string[]) => execFileSync("git", ["-C", args.cwd, ...argv], { encoding: "utf8" }).trim();
      writeFileSync(join(args.cwd, "src/leaf.ts"), "export const changed = 4;\n");
      git("add", "src/leaf.ts"); git("commit", "-m", "feat(receipts): final fixture source");
      sourceHead = git("rev-parse", "HEAD");
      assert.equal(authorPreflight([], { root: args.cwd, select: () => ({ fullRun: false, suites: ["test/a.test.ts", "test/b.test.ts"], reasons: ["fixture"] }),
        host: () => ({ cores: 2, load1: 0, headroomBytes: 4 * 1024 ** 3 }), testSlot: fixtureSlots(root) }), 0);
      return worker("REPORT\nfixture failure after qualification\n", true);
    },
  }));
  assert.equal(result.verdict, "blocked_budget");
  const rows = readFileSync(join(root, "state/ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const row = rows.find(row => row.step === "local.qualification"); assert.ok(row, JSON.stringify(rows.map(row => row.step)));
  assert.equal(row.head_sha, sourceHead);
  assert.equal(existsSync(ownedWorktree), false);
  assert.equal(readLocalQualificationReceipt({ stateRoot: root, repository: "craigoley/remudero", taskId, runId: result.runId, head: sourceHead, row }).outcome, "succeeded");
});
