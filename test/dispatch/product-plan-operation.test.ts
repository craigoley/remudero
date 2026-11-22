import assert from "node:assert/strict";
import { existsSync, fstatSync, fsyncSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import fsPromises, { watch } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { createHash } from "node:crypto";
import { repoRoot } from "#test/helpers/repo-root.js";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { compactRotations } from "#src/lib/ledger.js";
import { readLedgerKeyManifest } from "#src/lib/ledger-key-manifest.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { bootstrapConfirmed } from "#src/lib/product-build.js";
import { ratifyCliGateway } from "#src/lib/panel-graph.js";
import {
  PRODUCT_PLAN_OPERATION_LIMITS, productCasePlanText, productPlanLedgerTaskId, productPlanOrigin, ProductPlanOperationService,
  type PlanHandoffOutcome, type PlanHandoffPort, type PlanRepository, type PlanTargetPort,
} from "#src/lib/product-plan-operation.js";
import type { ProductRepositoryProvider, ProviderRead } from "#src/lib/product-repository.js";
import { SPEC, violations } from "#test/helpers/openapi-strict.js";
import { writeLedger, type LedgerFixture } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const actor = "clerk:alice";
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const ID = 1432832754;
const identity = { provider: "github", id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public", verifiedAt: "2026-10-26T00:00:00.000Z" } as const;
const envelope = { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true };
const brief = { idea: "private original mobile combat idea", name: "Wreckterra", constraints: ["mobile first"], resourceEnvelope: envelope };
const REQUESTED = "2026-10-26T01:00:00.000Z";
const PR_URL = "https://github.com/craigoley/wreckterra/pull/42";

/** The fake checkout carries no git tree: these suites assume a present table (W1-T11195 tests the reader itself). */
const runnerConfig = async (_checkout: string, head: string) => ({ state: "present" as const, head, path: ".remudero/mounts.yaml", digest: "0".repeat(64) });

class Target implements PlanTargetPort {
  inspection = { enrolled: true as boolean | undefined, head: HEAD as string | undefined, readmeOnly: false as boolean | undefined };
  runner = true;
  async inspect() { return this.inspection; }
  runnerRegistered() { return this.runner; }
}

function fixture(t: TestContext, over: { planned?: "clarify" | "create" | "unreadable"; gateway?: boolean; bound?: boolean; envelope?: boolean;
  serve?: (path: string) => string | undefined } = {}) {
  const root = ownedFixtureDir(t, "product-plan-operation").dir;
  const store = new ProductIntentStore({ root });
  const saved = store.write(actor, { version: "product-intent-v1", requestId: "seed-product-00001", expectedRevision: 0,
    brief: over.envelope === false ? { idea: brief.idea } : brief });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  if (over.bound !== false) {
    assert.ok(store.transition(actor, { version: "product-intent-v1", requestId: "seed-bound-0000001", id: productId,
      expectedRevision: 1, expectedObjectiveRevision: 1, repository: identity }).ok);
  }
  const target = new Target();
  const provider: Pick<ProductRepositoryProvider, "read"> & { next: ProviderRead } = {
    next: { state: "found", repository: { id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" } },
    async read() { return this.next; },
  };
  const calls: { operationId: string; mode: string; brief: string; repoRoot: string; journaled: boolean }[] = [];
  const ledgerDir = join(root, "state");
  mkdirSync(ledgerDir, { recursive: true });
  const ledgerPath = join(ledgerDir, "ledger.ndjson");
  const journalDirectory = join(root, "state", "products", "v1", "plan-operations");
  let release: (outcome: PlanHandoffOutcome) => void = () => {};
  const gateway = {
    async productPlan(call: { operationId: string; mode: "create" | "clarify"; brief: string; repoRoot: string }) {
      // The durable record must already be on disk when the hand-off starts.
      const journaled = existsSync(journalDirectory) && readdirSync(journalDirectory).filter((name) => name.endsWith(".json")).some((name) => readFileSync(join(journalDirectory, name), "utf8").includes(call.operationId));
      calls.push({ ...call, journaled });
      return new Promise<{ outcome: PlanHandoffOutcome }>((resolve) => { release = (outcome) => resolve({ outcome }); });
    },
  };
  const text = async (args: string[]) => {
    const served = over.serve?.(args.join(" "));
    if (served !== undefined) return served;
    if (over.planned === "unreadable") throw new Error("gh: server error (HTTP 502)");
    if (over.planned === "create") throw new Error("gh: Not Found (HTTP 404)");
    assert.match(args.join(" "), /contents\/plan\/tasks\.d\?ref=/);
    return JSON.stringify([{ name: "WRECK-T1-first.yaml" }]);
  };
  const checkout = join(root, "repos", "wreckterra");
  const service = (options: { alive?: boolean; head?: string; gateway?: false | PlanHandoffPort; sync?: (fd: number) => void; readLedgerLines?: EvidenceReader; ledgerReadBoundMs?: number } = {}) => new ProductPlanOperationService({
    root, store, provider, target, bootstrapConfirmed, ledgerPath, text, checkout: (repo: PlanRepository) => repo.name === "wreckterra" ? checkout : undefined, runnerConfig,
    clock: fixedClock(Date.parse(REQUESTED)), isAlive: () => options.alive ?? true,
    ...(options.gateway === false || over.gateway === false ? {} : { gateway: options.gateway ?? gateway }),
    ...(options.sync === undefined ? {} : { sync: options.sync }),
    readLedgerLines: options.readLedgerLines, ledgerReadBoundMs: options.ledgerReadBoundMs,
  });
  let ledger: LedgerFixture | undefined;
  const row = (atMs: number, line: Record<string, unknown>) => {
    ledger ??= writeLedger([], { dir: ledgerDir });
    ledger.append([{ ts: new Date(atMs).toISOString(), ...line }]);
  };
  const command = (extra: Record<string, unknown> = {}) => ({ requestId: "plan-request-00001", productId, expectedRevision: 2, expectedObjectiveRevision: 1, ...extra });
  return { root, store, productId, target, provider, calls, service, row, command, ledgerPath, checkout, journalDirectory, release: (outcome: PlanHandoffOutcome) => release(outcome) };
}
type Fixture = ReturnType<typeof fixture>;
const ok = async (promise: ReturnType<ProductPlanOperationService["execute"]>) => {
  const result = await promise;
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};
const refused = async (promise: ReturnType<ProductPlanOperationService["execute"]>) => { const result = await promise; assert.equal(result.ok, false); return result.code; };
const at = (offsetMs: number) => Date.parse(REQUESTED) + offsetMs;
/** The ledger rows the maintained gateway and the native plan run write for one hand-off, shaped as their own writers shape them. */
const nativeRun = (f: Fixture, operationId: string, extra: { exit?: boolean; pr?: string; pid?: number } = {}) => {
  const pid = extra.pid ?? 4242;
  f.row(at(1_000), { run_id: "PANEL-1", task_id: productPlanLedgerTaskId(operationId), step: "ratify.cli_started", origin: "ratify-gateway", verb: "plan", pid });
  f.row(at(2_000), { run_id: "PLAN-clarify-1", task_id: "PLAN-clarify", step: "plan.start", lane: "plan", actor_pid: pid, mode: "clarify", brief: f.calls.find((call) => call.operationId === operationId)?.brief });
  if (extra.pr) f.row(at(3_000), { run_id: "PLAN-clarify-1", task_id: "PLAN-clarify", step: "pr.opened", lane: "plan", actor_pid: pid, pr_url: extra.pr });
  if (extra.exit) f.row(at(4_000), { run_id: "PANEL-2", task_id: productPlanLedgerTaskId(operationId), step: "ratify.cli_exited", origin: "ratify-gateway", verb: "plan", code: 0, signal: null });
};
const revisionOf = (f: Fixture) => { const read = f.store.read(actor, f.productId); assert.ok(read.ok); return read.value.revision; };
const evidenceIds = (f: Fixture) => { const read = f.store.read(actor, f.productId); assert.ok(read.ok); return read.value.stageEvidence.map((item) => item.id); };

function secondPlanCommand(f: Fixture) {
  const saved = f.store.write(actor, { version: "product-intent-v1", requestId: "second-product-000001", expectedRevision: 0,
    brief: { ...brief, idea: "another saved original combat product" } });
  assert.ok(saved.ok);
  const secondId = saved.value.receipt.productId;
  assert.ok(f.store.transition(actor, { version: "product-intent-v1", requestId: "second-binding-000001", id: secondId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository: identity }).ok);
  return f.command({ productId: secondId, requestId: "second-plan-000001" });
}

test("W1-T10823: a saved product reaches one native plan operation across replay and restart", async (t) => {
  // Refusals come first and never journal or hand anything off.
  const unbound = fixture(t, { bound: false });
  assert.equal(await refused(unbound.service().execute(actor, unbound.command({ expectedRevision: 1 }))), "repository_missing");
  const bare = fixture(t, { envelope: false });
  assert.equal(await refused(bare.service().execute(actor, bare.command())), "envelope_missing", "no resource envelope is ever invented");
  const noRunner = fixture(t, { gateway: false });
  assert.equal(await refused(noRunner.service().execute(actor, noRunner.command())), "handoff_unavailable");
  assert.ok(!existsSync(noRunner.journalDirectory) || readdirSync(noRunner.journalDirectory).every((name) => name === "locks"), "a refused request journals nothing");
  const f = fixture(t);
  assert.equal(await refused(f.service().execute(actor, f.command({ expectedRevision: 1 }))), "stale_revision");
  assert.equal(await refused(f.service().execute(actor, { ...f.command(), pullRequest: 7 })), "invalid_input", "a caller-supplied pull request is never accepted");
  assert.equal(await refused(f.service().execute(actor, { ...f.command(), brief: "x" })), "invalid_input", "caller brief text is never accepted");
  assert.equal(await refused(f.service().execute(actor, { ...f.command(), budgetUsd: 1 })), "invalid_input", "a caller budget is never accepted");
  f.target.inspection = { enrolled: false, head: HEAD, readmeOnly: false };
  assert.equal(await refused(f.service().execute(actor, f.command())), "target_not_enrolled");
  f.target.inspection = { enrolled: true, head: HEAD, readmeOnly: true };
  assert.equal(await refused(f.service().execute(actor, f.command())), "bootstrap_unverified");
  f.target.inspection = { enrolled: true, head: undefined, readmeOnly: undefined };
  assert.equal(await refused(f.service().execute(actor, f.command())), "target_unreadable");
  f.target.inspection = { enrolled: true, head: HEAD, readmeOnly: false };
  f.target.runner = false;
  assert.equal(await refused(f.service().execute(actor, f.command())), "runner_missing");
  f.target.runner = true;
  f.provider.next = { state: "unreadable" };
  assert.equal(await refused(f.service().execute(actor, f.command())), "provider_unreadable");
  f.provider.next = { state: "found", repository: { id: 7, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" } };
  assert.equal(await refused(f.service().execute(actor, f.command())), "repository_conflict");
  f.provider.next = { state: "found", repository: { id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" } };
  assert.equal(f.calls.length, 0, "no refusal reached the gateway");

  // ONE request: a truthful pending observation at once, the record durable BEFORE the hand-off.
  const process = f.service();
  const first = await ok(process.execute(actor, f.command()));
  assert.equal(first.replayed, false);
  assert.equal(first.observation.state, "pending", "a hand-off that has not reported is pending, never queued or proposed");
  assert.equal(first.observation.mode, "clarify", "a head that already holds a plan is reconciled, not recreated");
  assert.equal(first.observation.targetHead, HEAD);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.journaled, true, "the journal record existed before the gateway was called");
  assert.equal(f.calls[0]!.repoRoot, f.checkout, "the child runs against the managed target checkout");
  assert.equal(f.calls[0]!.operationId, first.observation.operationId);
  const read = f.store.read(actor, f.productId);
  assert.ok(read.ok);
  assert.ok(f.calls[0]!.brief.startsWith(productCasePlanText(read.value.brief)), "the hand-off carries the complete approved brief");
  assert.match(f.calls[0]!.brief, /Constraints:\n- mobile first/);
  assert.match(f.calls[0]!.brief, /Resource envelope: budgetUsd=30 maxConcurrentBuilds=1 existingSetupOnly=true/);
  assert.ok(f.calls[0]!.brief.includes(productPlanOrigin(f.productId, first.observation.planEvidenceId)), "the design must carry the product plan origin token");
  assert.ok(f.calls[0]!.brief.includes(`Operation: ${first.observation.operationId}`));
  const journalFile = join(f.journalDirectory, readdirSync(f.journalDirectory).find((name) => name.endsWith(".json"))!);
  assert.equal(statSync(journalFile).mode & 0o777, 0o600, "the plan-operation journal is private");
  assert.ok(evidenceIds(f).includes(`pplan-op:${first.observation.operationId.slice(0, 32)}`), "stageEvidence is the supported projection");
  const operation = first.observation.operationId;

  // Repeats, lost responses and a fresh request id for the SAME saved product all read the one record.
  const again = await ok(process.execute(actor, f.command()));
  assert.deepEqual([again.replayed, again.observation.operationId, again.observation.state], [true, operation, "pending"]);
  const current = f.store.read(actor, f.productId);
  assert.ok(current.ok);
  const freshId = await ok(process.execute(actor, f.command({ requestId: "plan-request-00002", expectedRevision: current.value.revision })));
  assert.deepEqual([freshId.replayed, freshId.observation.operationId], [true, operation]);
  assert.equal(await refused(process.execute(actor, f.command({ expectedRevision: 9 }))), "idempotency_conflict", "one request id is one payload");
  assert.equal(f.calls.length, 1, "no replay spent a second plan");

  // Restart while the child still runs: a brand-new service over the same files and ledger.
  f.release("queued");
  nativeRun(f, operation);
  const restarted = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.deepEqual([restarted.replayed, restarted.observation.operationId, restarted.observation.state], [true, operation, "pending"], "a live child is pending after a restart");
  const dead = await ok(f.service({ alive: false, gateway: false }).execute(actor, f.command()));
  assert.equal(dead.observation.state, "unknown", "a child that vanished without an exit row is unknown, never retried");
  assert.equal(f.calls.length, 1);

  // The native run opens a pull request: only now is it proposed, and that stays distinct from approved or merged.
  f.row(at(3_000), { run_id: "PLAN-clarify-1", task_id: "PLAN-clarify", step: "pr.opened", lane: "plan", actor_pid: 4242, pr_url: PR_URL });
  const proposed = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.equal(proposed.observation.state, "proposed");
  assert.equal(proposed.observation.proposal, PR_URL);
  assert.ok(evidenceIds(f).includes(`pplan-op:${operation.slice(0, 32)}:proposed`));
  assert.equal(f.calls.length, 1, "restart plus a proposal still spent exactly one plan");
  await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.equal(evidenceIds(f).filter((id) => id.endsWith(":proposed")).length, 1, "the terminal evidence is recorded once");
});

test("W1-T10823: pending refused unknown changed-brief and stale-target stay distinct", async (t) => {
  // refused: the child exited and no correlated pull request was opened.
  const a = fixture(t);
  const first = await ok(a.service().execute(actor, a.command()));
  a.release("queued");
  nativeRun(a, first.observation.operationId, { exit: true });
  const refusedRun = await ok(a.service({ gateway: false }).execute(actor, a.command()));
  assert.equal(refusedRun.observation.state, "refused");
  assert.ok(evidenceIds(a).includes(`pplan-op:${first.observation.operationId.slice(0, 32)}:refused`));
  assert.equal((await ok(a.service().execute(actor, a.command({ requestId: "plan-request-00002", expectedRevision: revisionOf(a) })))).observation.state, "refused",
    "a refused plan is never retried silently, even by a fresh request");
  assert.equal(a.calls.length, 1);

  // a pull request outside the target repository, or one no plan run of that child opened, is never this proposal.
  const b = fixture(t);
  const second = await ok(b.service().execute(actor, b.command()));
  b.release("queued");
  nativeRun(b, second.observation.operationId, { exit: true, pr: "https://github.com/someone/else/pull/9" });
  assert.equal((await ok(b.service({ gateway: false }).execute(actor, b.command()))).observation.state, "refused");

  // unknown: a restart lost the in-memory hand-off and no ledger row says what happened.
  const c = fixture(t);
  const live = c.service();
  const third = await ok(live.execute(actor, c.command()));
  assert.equal(third.observation.state, "pending");
  assert.equal((await ok(c.service({ gateway: false }).execute(actor, c.command()))).observation.state, "unknown");
  // ...and an unreadable ledger is unknown too, not a guess.
  assert.equal(c.calls.length, 1);

  // stale-target: the live head moved. The same brief never gets a second plan while the first is unresolved.
  c.target.inspection = { enrolled: true, head: MOVED, readmeOnly: false };
  const stale = await ok(c.service({ gateway: false }).execute(actor, c.command()));
  assert.equal(stale.observation.state, "stale-target");
  assert.equal(stale.observation.targetHead, HEAD, "the frozen head is reported, never replaced");
  const stillOne = await ok(c.service().execute(actor, c.command({ requestId: "plan-request-00003", expectedRevision: revisionOf(c) })));
  assert.deepEqual([stillOne.replayed, stillOne.observation.operationId, stillOne.observation.state], [true, third.observation.operationId, "stale-target"]);
  assert.equal(c.calls.length, 1);

  // changed-brief: the saved brief moved on. The old plan is reported as such and never reused for the new brief.
  const moved = c.store.write(actor, { version: "product-intent-v1", requestId: "brief-changed-000001", id: c.productId,
    expectedRevision: revisionOf(c),
    brief: { ...brief, idea: "a different original idea" } });
  assert.ok(moved.ok);
  c.target.inspection = { enrolled: true, head: HEAD, readmeOnly: false };
  const changed = await ok(c.service({ gateway: false }).execute(actor, c.command()));
  assert.equal(changed.observation.state, "changed-brief");
  assert.equal(c.calls.length, 1, "a changed brief spends nothing on a replay");
  const latest = c.store.read(actor, c.productId);
  assert.ok(latest.ok);
  const replanned = await ok(c.service().execute(actor, c.command({ requestId: "plan-request-00004", expectedRevision: latest.value.revision, expectedObjectiveRevision: latest.value.objectiveRevision })));
  assert.notEqual(replanned.observation.operationId, third.observation.operationId, "the new brief is its own operation");
  assert.equal(replanned.observation.state, "pending");
  assert.equal(c.calls.length, 2);
  assert.ok(c.calls[1]!.brief.includes("a different original idea"));
});

test("W1-T10823: a plan hand-off refuses an unreadable target plan and plans fresh when the target holds none", async (t) => {
  const none = fixture(t, { planned: "create" });
  const created = await ok(none.service().execute(actor, none.command()));
  assert.equal(created.observation.mode, "create", "only an absent plan directory is `create`");
  assert.equal(none.calls[0]!.mode, "create");
  const unreadable = fixture(t, { planned: "unreadable" });
  assert.equal(await refused(unreadable.service().execute(actor, unreadable.command())), "target_unreadable");
  assert.equal(unreadable.calls.length, 0, "an unreadable plan is never guessed into a second plan");
});

test("W1-T10823: a hand-off that reports refused, throws or rejects is recorded and never retried", async (t) => {
  for (const [how, expected] of [["refused", "refused"], ["throws", "unknown"], ["rejects", "unknown"]] as const) {
    const f = fixture(t, { gateway: false });
    let calls = 0;
    const service = new ProductPlanOperationService({
      root: f.root, store: f.store, provider: f.provider, target: f.target, bootstrapConfirmed, ledgerPath: f.ledgerPath, checkout: () => f.checkout, runnerConfig,
      text: async () => JSON.stringify([]), clock: fixedClock(Date.parse(REQUESTED)),
      gateway: { productPlan() {
        calls += 1;
        if (how === "throws") throw new Error("gateway exploded");
        return how === "refused" ? Promise.resolve({ outcome: "refused" as const }) : Promise.reject(new Error("child never started"));
      } },
    });
    const first = await ok(service.execute(actor, f.command()));
    assert.equal(first.observation.mode, "create", "a head holding no plan shard is planned fresh");
    // Let the owner's own queued completion record the outcome, then read the same record again.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await ok(service.execute(actor, f.command()));
    assert.equal(again.observation.state, expected, how);
    assert.equal(again.replayed, true);
    assert.equal(calls, 1, `${how}: a failed hand-off is never retried`);
  }
});

test("W1-T10823: the plan journal refuses a corrupt, foreign or missing target without a hand-off", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const file = join(f.journalDirectory, readdirSync(f.journalDirectory).find((name) => name.endsWith(".json"))!);
  const original = readFileSync(file, "utf8");
    writeFileSync(file, "{not json");
  assert.equal(await refused(f.service().execute(actor, f.command())), "corrupt");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(original), ownerKey: "0".repeat(64) }));
  assert.equal(await refused(f.service().execute(actor, f.command())), "corrupt", "another owner's journal is never read as this one's");
  writeFileSync(file, original);
  renameSync(file, `${file}.kept`);
  mkdirSync(file);
  assert.equal(await refused(f.service().execute(actor, f.command())), "unavailable", "a journal that is not a regular file is refused");
  rmdirSync(file);
  renameSync(`${file}.kept`, file);
  const replay = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.equal(replay.observation.operationId, first.observation.operationId);
  assert.equal(f.calls.length, 1);
  // A target whose managed checkout is not there is refused before anything is journaled.
  const lost = fixture(t);
  const noCheckout = new ProductPlanOperationService({ root: lost.root, store: lost.store, provider: lost.provider, target: lost.target, bootstrapConfirmed,
    checkout: () => undefined, text: async () => "[]", gateway: { productPlan: async () => ({ outcome: "queued" as const }) } });
  assert.equal(await refused(noCheckout.execute(actor, lost.command())), "target_unreadable");
  assert.equal(await refused(noCheckout.execute("", lost.command())), "invalid_identity");
  assert.equal(await refused(noCheckout.execute(actor, { requestId: "short" })), "invalid_input");
  assert.equal(await refused(noCheckout.execute("clerk:bob", lost.command())), "not_found", "another operator's product does not exist");
});

test("W1-T10823: the maintained gateway's product plan port validates its target before it spawns anything", async (t) => {
  const root = ownedFixtureDir(t, "product-plan-gateway").dir;
  const ledgerPath = join(root, "ledger.ndjson");
  let trees = 0;
  const gateway = ratifyCliGateway(root, join(root, "logs"), { ledgerPath, freshTree: async (action) => { trees += 1; return action({ path: root, sha: "f".repeat(40) }); } });
  const good = { operationId: "a".repeat(64), mode: "create" as const, brief: "Approved product brief:\n{}", repoRoot: root };
  for (const bad of [{ operationId: "short" }, { repoRoot: "relative/path" }, { mode: "expand" as unknown as "create" }, { brief: "   " },
    { brief: "x".repeat(64 * 1024 + 1) }]) {
    assert.deepEqual(await gateway.productPlan!({ ...good, ...bad }), { outcome: "refused" });
  }
  assert.equal(trees, 0, "a refused target never reaches the fresh-source runner");
  assert.ok(!existsSync(ledgerPath), "and writes no ledger row");
  assert.equal(ratifyCliGateway(root, join(root, "logs")).productPlan, undefined, "without the owned runner there is no plan port");
});


test("W1-T10823: concurrent service instances retain every product operation and completion", async (t) => {
  const f = fixture(t);
  const commands = [f.command(), secondPlanCommand(f)];
  const values = await Promise.all(commands.map((command) => ok(f.service().execute(actor, command))));
  assert.equal(f.calls.length, 2, "two distinct saved products each launch once");
  const journal = () => JSON.parse(readFileSync(join(f.journalDirectory, readdirSync(f.journalDirectory).find((name) => name.endsWith(".json"))!), "utf8"));
  assert.equal(Object.keys(journal().operations).length, 2, "neither launched operation can be lost");
  assert.equal(Object.keys(journal().requests).length, 2);
  f.release("refused");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(Object.keys(journal().operations).length, 2, "completion re-reads and preserves the other operation");
  for (let i = 0; i < commands.length; i++) {
    const again = await ok(f.service({ gateway: false }).execute(actor, commands[i]));
    assert.equal(again.observation.operationId, values[i]!.observation.operationId);
    assert.equal(again.replayed, true);
  }
  assert.equal(f.calls.length, 2);
});

test("W1-T10823: the shared journal honors the maintained filesystem lock", async (t) => {
  const f = fixture(t);
  // A separately held real lock represents another process, beyond a module-local promise queue.
  const key = createHash("sha256").update(actor).digest("hex");
  mkdirSync(f.journalDirectory, { recursive: true, mode: 0o700 });
  const handle = acquireInflightLock(join(f.journalDirectory, "locks"), key, { run_id: "other-journal-writer" });
  try {
    assert.equal(await refused(f.service().execute(actor, f.command())), "busy");
    assert.equal(f.calls.length, 0);
  } finally { handle.release(); }
  assert.equal((await ok(f.service().execute(actor, f.command()))).observation.state, "pending");
  assert.equal(f.calls.length, 1);
});

test("W1-T10823: completion lock contention never keeps a finished handoff pending", async (t) => {
  const f = fixture(t), service = f.service();
  await ok(service.execute(actor, f.command()));
  const key = createHash("sha256").update(actor).digest("hex");
  const handle = acquireInflightLock(join(f.journalDirectory, "locks"), key, { run_id: "completion-journal-writer" });
  try {
    f.release("queued");
    // Drain promise callbacks while the real lock stays held. No sleep or fabricated ledger verdict.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally { handle.release(); }
  const live = await ok(service.execute(actor, f.command()));
  const restarted = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.equal(live.observation.state, "unknown", "a completed child with no durable outcome or ledger row is unknown");
  assert.equal(restarted.observation.state, live.observation.state, "live and restarted readers agree");
  assert.equal(f.calls.length, 1, "failed completion persistence never retries the plan");
});

test("W1-T10823: an old completed plan never becomes evidence for a newer objective", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const changed = f.store.write(actor, { version: "product-intent-v1", requestId: "changed-objective-000001", id: f.productId,
    expectedRevision: revisionOf(f), brief: { ...brief, objective: "a new objective after launch" } });
  assert.ok(changed.ok);
  nativeRun(f, first.observation.operationId, { pr: PR_URL });
  const current = f.store.read(actor, f.productId); assert.ok(current.ok);
  const again = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.equal(again.observation.state, "changed-brief");
  assert.equal(again.observation.objectiveRevision, 1);
  assert.equal(again.observation.proposal, PR_URL, "historical proposal remains visible");
  const stored = f.store.read(actor, f.productId); assert.ok(stored.ok);
  assert.equal(stored.value.revision, current.value.revision, "old completion writes no new-objective stage evidence");
  assert.equal(stored.value.stageEvidence.filter((entry) => entry.outcome === "proposed").length, 0);
  assert.equal(f.calls.length, 1);
});

test("W1-T10823: the real CLI launcher correlates the native plan brief across distinct PIDs", async (t) => {
  const f = fixture(t);
  const realRoot = repoRoot();
  const cli = join(f.root, "controlled-cli");
  mkdirSync(join(cli, "bin"), { recursive: true }); mkdirSync(join(cli, "src"));
  writeFileSync(join(cli, "package.json"), JSON.stringify({ type: "module" }));
  // Exact maintained launcher bytes and pinned toolchain, with a controlled entry fixture.
  writeFileSync(join(cli, "bin", "rmd"), readFileSync(join(realRoot, "bin", "rmd")), { mode: 0o755 });
  symlinkSync(join(realRoot, "node_modules"), join(cli, "node_modules"), "dir");
  // The external planner is controlled at its argv/ledger protocol. The launcher, parser,
  // runtime PID and durable writer are real; this fixture invokes no planner or GitHub client.
  writeFileSync(join(cli, "src", "run-task.ts"), String.raw`
    import { createRequire } from "node:module";
    import { pathToFileURL } from "node:url";
    const require = createRequire(${JSON.stringify(join(realRoot, "package.json"))});
    const { parsePlanArgs } = await import(pathToFileURL(require.resolve("#src/lib/plan-architect.ts")).href);
    const { appendLedger } = await import(pathToFileURL(require.resolve("#src/lib/ledger.ts")).href);
    const args = process.argv.slice(2), targetAt = args.indexOf("--repo-root");
    if (args[0] !== "plan" || targetAt < 0) throw new Error("unexpected native gateway argv");
    const parsed = parsePlanArgs(args.slice(1, targetAt));
    if ("error" in parsed) throw new Error(parsed.error);
    const run_id = "PLAN-" + parsed.mode + "-" + Date.now(), task_id = "PLAN-" + parsed.mode;
    appendLedger(${JSON.stringify(f.ledgerPath)}, { run_id, task_id, step: "plan.start", lane: "plan", mode: parsed.mode, brief: parsed.brief });
    appendLedger(${JSON.stringify(f.ledgerPath)}, { run_id, task_id, step: "pr.opened", lane: "plan", pr_url: ${JSON.stringify(PR_URL)} });
  `);
  // Keep the gateway in flight while the first observation reads evidence, regardless of launcher speed.
  let launch!: () => void;
  const launchReady = new Promise<void>((resolve) => { launch = resolve; });
  const gateway = ratifyCliGateway(cli, join(f.root, "logs"), { ledgerPath: f.ledgerPath,
    freshTree: async (action) => { await launchReady; return action({ path: cli, sha: "f".repeat(40) }); } });
  const service = new ProductPlanOperationService({ root: f.root, store: f.store, provider: f.provider, target: f.target,
    bootstrapConfirmed, ledgerPath: f.ledgerPath, text: async () => "[]", checkout: () => f.checkout, runnerConfig, gateway });
  const first = await ok(service.execute(actor, f.command()));
  assert.equal(first.observation.state, "pending");
  launch();
  // inFlight tracks the real detached child lifetime. No fixed sleep is a completion proof.
  const deadline = Date.now() + 60_000;
  while (gateway.inFlight(productPlanLedgerTaskId(first.observation.operationId))) {
    if (Date.now() >= deadline) {
      const rows = readFileSync(f.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const started = rows.find((row) => row.step === "ratify.cli_started" && row.task_id === productPlanLedgerTaskId(first.observation.operationId));
      const childLogs = readdirSync(join(f.root, "logs")).map((name) => readFileSync(join(f.root, "logs", name), "utf8"));
      if (started?.pid) { try { process.kill(-started.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      assert.fail(JSON.stringify({ error: "controlled CLI did not finish", rows, childLogs }));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const rows = readFileSync(f.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const started = rows.find((row) => row.step === "ratify.cli_started"), native = rows.find((row) => row.step === "plan.start");
  assert.ok(native, JSON.stringify({ rows, childLogs: readdirSync(join(f.root, "logs")).map((name) => readFileSync(join(f.root, "logs", name), "utf8")) }));
  assert.notEqual(started.pid, native.actor_pid, "the maintained tsx launcher starts a different runtime PID");
  const again = await ok(service.execute(actor, f.command()));
  assert.equal(again.observation.state, "proposed");
  assert.equal(again.observation.proposal, PR_URL);
  assert.equal(again.replayed, true);
});


test("W1-T10823: foreign briefs and ambiguous native runs cannot supply a proposal", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  f.row(at(1_000), { task_id: productPlanLedgerTaskId(first.observation.operationId), step: "ratify.cli_started", pid: 4242 });
  f.row(at(2_000), { run_id: "PLAN-clarify-foreign", task_id: "PLAN-clarify", step: "plan.start", lane: "plan", mode: "clarify", actor_pid: 4242, brief: "someone else's brief" });
  f.row(at(3_000), { run_id: "PLAN-clarify-foreign", task_id: "PLAN-clarify", step: "pr.opened", pr_url: PR_URL });
  assert.equal((await ok(f.service({ gateway: false }).execute(actor, f.command()))).observation.proposal, undefined);
  const g = fixture(t);
  const planned = await ok(g.service().execute(actor, g.command()));
  nativeRun(g, planned.observation.operationId, { pr: PR_URL, exit: true });
  g.row(at(2_100), { run_id: "PLAN-clarify-duplicate", task_id: "PLAN-clarify", step: "plan.start", lane: "plan", mode: "clarify", actor_pid: 8181, brief: g.calls[0]!.brief });
  const ambiguous = await ok(g.service({ gateway: false }).execute(actor, g.command()));
  assert.equal(ambiguous.observation.state, "unknown");
  assert.equal(ambiguous.observation.proposal, undefined);
  assert.equal(evidenceIds(g).filter((id) => id.endsWith(":proposed")).length, 0);
  const h = fixture(t);
  const own = await ok(h.service().execute(actor, h.command()));
  nativeRun(h, own.observation.operationId, { exit: true });
  h.row(at(2_100), { run_id: "PLAN-clarify-1", task_id: "PLAN-clarify", step: "plan.start", lane: "plan", mode: "clarify", actor_pid: 8181, brief: "a foreign product brief at the same native run id" });
  h.row(at(3_000), { run_id: "PLAN-clarify-1", task_id: "PLAN-clarify", step: "pr.opened", lane: "plan", actor_pid: 8181, pr_url: PR_URL });
  const collision = await ok(h.service({ gateway: false }).execute(actor, h.command()));
  assert.equal(collision.observation.state, "unknown", "conflicting native starts sharing one run id stay ambiguous");
  assert.equal(collision.observation.proposal, undefined);
  assert.equal(evidenceIds(h).filter((id) => id.endsWith(":proposed")).length, 0);
  assert.equal(h.calls.length, 1);
});

test("W1-T10823: a completed plan remains visible when its own merge advances the target", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  nativeRun(f, first.observation.operationId, { pr: PR_URL, exit: true });
  f.target.inspection.head = MOVED;
  const again = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.equal(again.observation.state, "proposed");
  assert.equal(again.observation.targetHead, HEAD);
  assert.equal(again.observation.proposal, PR_URL);
  assert.equal(f.calls.length, 1);
});


test("W1-T10823: native identity survives the child starting before its gateway log", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  f.row(at(1_000), { run_id: "PLAN-clarify-early", task_id: "PLAN-clarify", step: "plan.start", lane: "plan", mode: "clarify", actor_pid: 4243, brief: f.calls[0]!.brief });
  f.row(at(2_000), { task_id: productPlanLedgerTaskId(first.observation.operationId), step: "ratify.cli_started", pid: 4242 });
  f.row(at(3_000), { run_id: "PLAN-clarify-early", task_id: "PLAN-clarify", step: "pr.opened", pr_url: PR_URL });
  assert.equal((await ok(f.service({ gateway: false }).execute(actor, f.command()))).observation.state, "proposed");
});


test("W1-T10823: an unreadable live target on replay preserves its native pending operation", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  nativeRun(f, first.observation.operationId);
  f.target.inspect = async () => { throw new Error("target read interrupted"); };
  const replayed = await ok(f.service().execute(actor, f.command()));
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.observation.operationId, first.observation.operationId);
  assert.equal(replayed.observation.state, "pending", "an unreadable head is not a stale target or another hand-off");
  assert.equal(f.calls.length, 1);
});

test("W1-T10823: a blocked journal directory refuses before any plan hand-off", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.journalDirectory, ".."), { recursive: true });
  writeFileSync(f.journalDirectory, "existing file blocks the directory");
  assert.equal(await refused(f.service().execute(actor, f.command())), "unavailable");
  assert.equal(readFileSync(f.journalDirectory, "utf8"), "existing file blocks the directory");
  assert.equal(f.calls.length, 0);
  assert.equal(revisionOf(f), 2);
});

test("W1-T10823: a journal flush failure removes its uncommitted stage and launches nothing", async (t) => {
  const f = fixture(t);
  const service = f.service({ sync: () => { throw new Error("file flush failed"); } });
  assert.equal(await refused(service.execute(actor, f.command())), "unavailable");
  assert.equal(f.calls.length, 0);
  assert.equal(revisionOf(f), 2);
  assert.deepEqual(readdirSync(f.journalDirectory).filter((name) => name.endsWith(".pending") || name.endsWith(".json")), [],
    "failure before rename leaves neither a stage nor a committed operation");
});

test("W1-T10823: a journal cleanup failure retains its stage while refusing the hand-off", async (t) => {
  const f = fixture(t);
  let retained: string | undefined;
  const service = f.service({ sync: () => {
    const name = readdirSync(f.journalDirectory).find((entry) => entry.endsWith(".pending"));
    assert.ok(name, "the default writer staged its actual journal bytes");
    retained = join(f.journalDirectory, name);
    renameSync(retained, retained + ".original");
    mkdirSync(retained);
    throw new Error("flush failed; staged path is now a directory");
  } });
  assert.equal(await refused(service.execute(actor, f.command())), "unavailable");
  assert.ok(retained && statSync(retained).isDirectory(), "failed unlink is retained for the owned fixture cleanup");
  assert.equal(readdirSync(f.journalDirectory).filter((name) => name.endsWith(".json")).length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(revisionOf(f), 2);
});

test("W1-T10823: a directory flush failure preserves an unknown committed operation without relaunch", async (t) => {
  const f = fixture(t);
  let fileFlushes = 0, directoryFlushes = 0;
  const service = f.service({ sync: (fd) => {
    if (fstatSync(fd).isDirectory()) { directoryFlushes += 1; throw new Error("directory flush failed"); }
    fsyncSync(fd);
    fileFlushes += 1;
  } });
  assert.equal(await refused(service.execute(actor, f.command())), "outcome_unknown");
  assert.equal(fileFlushes, 1);
  assert.equal(directoryFlushes, 1);
  const files = readdirSync(f.journalDirectory).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 1);
  const journal = JSON.parse(readFileSync(join(f.journalDirectory, files[0]!), "utf8"));
  const operations = Object.values(journal.operations) as { operationId: string }[];
  assert.equal(operations.length, 1);
  assert.equal(f.calls.length, 0, "no hand-off preceded durable directory confirmation");
  const replayed = await ok(f.service().execute(actor, f.command()));
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.observation.operationId, operations[0]!.operationId);
  assert.equal(replayed.observation.state, "unknown");
  assert.equal(f.calls.length, 0, "a lost durable outcome never retries the planner");
});

test("W1-T13719: a refused plan does not block a fresh request once the target head moves", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  f.release("queued");
  nativeRun(f, first.observation.operationId, { exit: true });
  assert.equal((await ok(f.service({ gateway: false }).execute(actor, f.command()))).observation.state, "refused");
  // The same head keeps the refusal: a fresh request is never a silent retry.
  const sameHead = await ok(f.service().execute(actor, f.command({ requestId: "plan-request-00005", expectedRevision: revisionOf(f) })));
  assert.deepEqual([sameHead.replayed, sameHead.observation.operationId], [true, first.observation.operationId]);
  assert.equal(f.calls.length, 1);
  // The original request still replays its own refused operation and launches nothing.
  f.target.inspection = { enrolled: true, head: MOVED, readmeOnly: false };
  const replay = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.deepEqual([replay.replayed, replay.observation.operationId, replay.observation.state], [true, first.observation.operationId, "stale-target"]);
  assert.equal(f.calls.length, 1);
  // A fresh request at the moved head plans again, at that head.
  const fresh = await ok(f.service().execute(actor, f.command({ requestId: "plan-request-00006", expectedRevision: revisionOf(f) })));
  assert.equal(fresh.replayed, false);
  assert.notEqual(fresh.observation.operationId, first.observation.operationId);
  assert.equal(fresh.observation.targetHead, MOVED);
  assert.equal(f.calls.length, 2);
});

// ── W1-T11394: observational requirement coverage ────────────────────────────────────────────────────────────

const PR_HEAD = "c".repeat(40);
const PROOF = "unit test: the first task proof";
/** What the proposing plan run committed at the PR head; each field is mutable so a case can break exactly one thing. */
function coverageServer(over: { map?: () => string | Error; shard?: string } = {}) {
  const served = { map: over.map ?? ((): string | Error => new Error("gh: Not Found (HTTP 404)")), pull: true };
  const serve = (path: string): string | undefined => {
    if (/repos\/craigoley\/wreckterra\/pulls\/42$/.test(path)) return JSON.stringify({ number: 42, base: { repo: { id: ID } }, head: { sha: PR_HEAD } });
    if (path.includes(`requirement-coverage/`) && path.includes(`ref=${PR_HEAD}`)) { const v = served.map(); if (v instanceof Error) throw v; return v; }
    if (path.endsWith(`plan/tasks.d?ref=${PR_HEAD}`)) return JSON.stringify([{ name: "WRECK-T2-second.yaml" }]);
    if (path.includes(`plan/tasks.d/WRECK-T2-second.yaml?ref=${PR_HEAD}`)) return over.shard ?? `- id: WRECK-T2\n  acceptance:\n    - claim: c\n      proof: "${PROOF}"\n`;
    return undefined;
  };
  return { served, serve };
}
const mapFor = (observation: { operationId: string; briefDigest: string; objectiveRevision: number; targetHead: string },
  inventory: string, entries: unknown[]) => JSON.stringify({ version: "product-plan-requirement-map-v1", operationId: observation.operationId,
  briefDigest: observation.briefDigest, objectiveRevision: observation.objectiveRevision, targetHead: observation.targetHead, inventoryDigest: inventory, entries });
const GOOD_ENTRIES = [{ source: "/constraints/0", status: "linked", taskId: "WRECK-T2", proof: PROOF }, { source: "/idea", status: "deferred", rationale: "needs a human read" }];
/** Plans once, lets the native run open its PR, and returns the proposed observation read with `map` served at the PR head. */
async function proposedWith(t: TestContext, build: (pending: { operationId: string; briefDigest: string; objectiveRevision: number; targetHead: string }, inventory: string) => string | Error,
  over: { shard?: string } = {}) {
  const server = coverageServer(over);
  const f = fixture(t, { serve: server.serve });
  const pending = await ok(f.service().execute(actor, f.command()));
  const coverage = pending.observation.requirementCoverage!;
  server.served.map = () => build(pending.observation, coverage.inventory.digest!);
  f.release("queued");
  nativeRun(f, pending.observation.operationId, { pr: PR_URL, exit: true });
  const proposed = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  return { f, pending, proposed, server };
}

test("W1-T11394: product plan coverage observation binds source inventory and mapping identity", async (t) => {
  const { f, proposed } = await proposedWith(t, (pending, inventory) => mapFor(pending, inventory, GOOD_ENTRIES));
  assert.equal(proposed.observation.state, "proposed");
  const coverage = proposed.observation.requirementCoverage!;
  assert.deepEqual([coverage.version, coverage.basis, coverage.source.state, coverage.inventory.state, coverage.mapping.state],
    ["product-plan-requirement-coverage-v1", "structural-unreviewed", "available", "available", "available"]);
  assert.deepEqual(coverage.binding, { operationId: proposed.observation.operationId, briefDigest: proposed.observation.briefDigest,
    objectiveRevision: 1, targetHead: HEAD }, "the report binds the frozen operation, brief, objective and target head");
  assert.deepEqual(coverage.inventory.items.map((item) => [item.pointer, item.kind]), [["/idea", "idea"], ["/constraints/0", "constraint"]]);
  assert.equal(coverage.inventory.exhaustive, false, "free-form idea text is never claimed exhaustively extracted");
  assert.match(coverage.inventory.digest!, /^[a-f0-9]{64}$/);
  assert.equal(coverage.mapping.head, PR_HEAD, "the mapping is read from the exact proposal head");
  assert.match(coverage.mapping.snapshotDigest!, /^[a-f0-9]{64}$/);
  assert.deepEqual(coverage.entries, [{ pointer: "/idea", state: "deferred", rationale: "needs a human read" },
    { pointer: "/constraints/0", state: "linked", taskId: "WRECK-T2", proof: PROOF }]);
  assert.deepEqual(coverage.counts, { linked: 1, unmapped: 0, deferred: 1, unresolved: 0 });
  assert.ok(!JSON.stringify(coverage).match(/implemented|tested|complete/), "no link is labelled implemented, tested or complete");
  assert.match(coverage.reportId, /^[a-f0-9]{64}$/);
  // The native handoff carries the bounded inventory guidance beside the canonical approved brief.
  const handed = f.calls[0]!.brief;
  assert.ok(handed.includes(productCasePlanText(brief)));
  assert.ok(handed.includes(`Source inventory digest: ${coverage.inventory.digest}`) && handed.includes("- /constraints/0 (constraint)"));
});

test("W1-T11394: product plan coverage observation preserves source inventory and mapping unknown states", async (t) => {
  const unavailable = (c: { mapping: { state: string; reason?: string }; entries: { state: string }[] }, reason: string, entryState: string) => {
    assert.deepEqual([c.mapping.state, c.mapping.reason], ["mapping-unavailable", reason]);
    assert.ok(c.entries.length > 0 && c.entries.every((entry) => entry.state === entryState));
  };
  // Pending: no proposal exists, so nothing is mapped and nothing is claimed.
  const first = await proposedWith(t, () => new Error("gh: Not Found (HTTP 404)"));
  unavailable(first.pending.observation.requirementCoverage!, "no-proposal", "coverage-unavailable");
  unavailable(first.proposed.observation.requirementCoverage!, "report-absent", "coverage-unavailable");
  const bad = await proposedWith(t, () => "{ not json");
  unavailable(bad.proposed.observation.requirementCoverage!, "report-invalid", "coverage-unavailable");
  const foreign = await proposedWith(t, (pending, inventory) => mapFor({ ...pending, operationId: "f".repeat(64) }, inventory, GOOD_ENTRIES));
  unavailable(foreign.proposed.observation.requirementCoverage!, "report-incompatible", "coverage-unavailable");
  const stale = await proposedWith(t, (pending) => mapFor(pending, "0".repeat(64), GOOD_ENTRIES));
  unavailable(stale.proposed.observation.requirementCoverage!, "report-incompatible", "coverage-unavailable");
  const unreadable = await proposedWith(t, () => new Error("gh: server error (HTTP 502)"));
  unavailable(unreadable.proposed.observation.requirementCoverage!, "transport-unreadable", "coverage-unavailable");
  const unknownPointer = await proposedWith(t, (pending, inventory) => mapFor(pending, inventory, [{ source: "/constraints/9", status: "deferred", rationale: "x" }]));
  unavailable(unknownPointer.proposed.observation.requirementCoverage!, "report-invalid", "coverage-unavailable");
  // A proof the candidate task does not carry is an explicit unresolved reference; an unlisted source stays unmapped.
  const unresolved = await proposedWith(t, (pending, inventory) => mapFor(pending, inventory,
    [{ source: "/constraints/0", status: "linked", taskId: "WRECK-T2", proof: "unit test: invented proof" }]));
  const entries = unresolved.proposed.observation.requirementCoverage!.entries;
  assert.deepEqual(entries.map((entry) => [entry.pointer, entry.state]), [["/idea", "unmapped"], ["/constraints/0", "reference-unresolved"]]);
  assert.deepEqual(unresolved.proposed.observation.requirementCoverage!.counts, { linked: 0, unmapped: 1, deferred: 0, unresolved: 1 });
  // A changed brief is source-unavailable: today's brief is never mapped as if it were the frozen one.
  const c = fixture(t);
  const pending = await ok(c.service().execute(actor, c.command()));
  assert.ok(c.store.write(actor, { version: "product-intent-v1", requestId: "brief-changed-000011", id: c.productId, expectedRevision: revisionOf(c),
    brief: { ...brief, idea: "a different original idea" } }).ok);
  const changed = (await ok(c.service({ gateway: false }).execute(actor, c.command()))).observation;
  assert.equal(changed.state, "changed-brief");
  const coverage = changed.requirementCoverage!;
  assert.deepEqual([coverage.source.state, coverage.inventory.state, coverage.inventory.items, coverage.entries, coverage.inventory.digest],
    ["source-unavailable", "inventory-unavailable", [], [], undefined], "absent inventory is never a zero-requirement success");
  assert.equal(coverage.mapping.reason, "brief-unavailable");
  assert.ok(!JSON.stringify(coverage).includes("a different original idea"));
  assert.equal(coverage.binding.briefDigest, pending.observation.briefDigest, "the frozen digest is reported, never today's");
});

test("W1-T11394: product plan coverage observation preserves operation and admission behavior", async (t) => {
  const { f, pending, proposed } = await proposedWith(t, (observation, inventory) => mapFor(observation, inventory, GOOD_ENTRIES));
  const strip = (o: object) => { const { requirementCoverage, ...rest } = o as { requirementCoverage?: unknown }; void requirementCoverage; return rest; };
  const journalFile = () => readFileSync(join(f.journalDirectory, readdirSync(f.journalDirectory).find((name) => name.endsWith(".json"))!), "utf8");
  // Same-input replay is stable: identical report, journal and evidence.
  const journalBefore = journalFile();
  const evidenceBefore = evidenceIds(f);
  const again = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.equal(again.observation.requirementCoverage!.reportId, proposed.observation.requirementCoverage!.reportId);
  assert.deepEqual(again.observation, proposed.observation);
  assert.equal(journalFile(), journalBefore, "reporting never rewrites the journal");
  assert.deepEqual(evidenceIds(f), evidenceBefore);
  assert.equal(f.calls.length, 1);
  assert.equal(pending.observation.operationId, again.observation.operationId);
  // Reporting failure changes neither the state nor the evidence, nor the journal.
  const broken = fixture(t, { serve: (path) => { if (path.includes("/pulls/42")) throw new Error("gh: server error (HTTP 500)"); return undefined; } });
  const first = await ok(broken.service().execute(actor, broken.command()));
  broken.release("queued");
  nativeRun(broken, first.observation.operationId, { pr: PR_URL, exit: true });
  const failing = await ok(broken.service({ gateway: false }).execute(actor, broken.command()));
  assert.equal(failing.observation.state, "proposed");
  assert.equal(failing.observation.proposal, PR_URL);
  assert.equal(failing.observation.requirementCoverage!.mapping.reason, "transport-unreadable");
  assert.ok(evidenceIds(broken).includes(`pplan-op:${first.observation.operationId.slice(0, 32)}:proposed`), "the proposed evidence is still recorded");
  // The healthy and failing runs agree on everything but the report.
  assert.deepEqual(strip(failing.observation), { ...strip(proposed.observation), operationId: failing.observation.operationId,
    planEvidenceId: failing.observation.planEvidenceId });
});

test("W1-T11394: product plan coverage observation reaches the bounded served response contract", async (t) => {
  const { proposed, pending } = await proposedWith(t, (observation, inventory) => mapFor(observation, inventory, GOOD_ENTRIES));
  const schema = SPEC.components.schemas.ProductPlanOperation!;
  assert.deepEqual(violations(proposed.observation, schema), [], "the real proposed observation satisfies the strict contract");
  assert.deepEqual(violations(pending.observation, schema), [], "so does the unavailable-mapping observation");
  // Optional for legacy servers: an observation without the field is still valid.
  const { requirementCoverage, ...legacy } = proposed.observation; void requirementCoverage;
  assert.deepEqual(violations(legacy, schema), []);
  // The contract is bounded and strict: an undeclared key, an overlong excerpt or a non-structural basis is refused.
  const coverage = proposed.observation.requirementCoverage!;
  assert.notDeepEqual(violations({ ...proposed.observation, requirementCoverage: { ...coverage, extra: 1 } }, schema), []);
  assert.notDeepEqual(violations({ ...proposed.observation, requirementCoverage: { ...coverage, basis: "complete" } }, schema), []);
  const long = { ...coverage, inventory: { ...coverage.inventory, items: [{ ...coverage.inventory.items[0]!, excerpt: "x".repeat(241) }] } };
  assert.notDeepEqual(violations({ ...proposed.observation, requirementCoverage: long }, schema), []);
  // Output is bounded by construction: a maximal brief never exceeds the declared item bound or excerpt length.
  const big = fixture(t);
  assert.ok(big.store.write(actor, { version: "product-intent-v1", requestId: "brief-big-000000001", id: big.productId, expectedRevision: revisionOf(big),
    brief: { ...brief, idea: "i".repeat(2000), constraints: Array.from({ length: 24 }, () => "c".repeat(500)),
      decisions: Array.from({ length: 32 }, (_, index) => ({ key: `k${index}`, value: "v".repeat(100), provenance: { kind: "operator" as const } })) } }).ok);
  const maximal = (await ok(big.service().execute(actor, big.command({ requestId: "plan-request-00009", expectedRevision: revisionOf(big), expectedObjectiveRevision: 2 })))).observation;
  assert.deepEqual(violations(maximal, schema), []);
  assert.equal(maximal.requirementCoverage!.inventory.itemCount, 57);
  assert.ok(maximal.requirementCoverage!.inventory.items.every((item) => item.excerpt.length <= 240));
  assert.equal(maximal.requirementCoverage!.inventory.items[1]!.excerpt.length, 240, "a long constraint is truncated, never carried whole");
  assert.ok(Buffer.byteLength(JSON.stringify(maximal.requirementCoverage)) < 64 * 1024);
  assert.ok(Buffer.byteLength(big.calls[0]!.brief) <= 60 * 1024, "the handoff stays inside its byte bound");
});

// ── W1-T13875: "Resume saved plan" froze serve on 2026-11-19 ─────────────────────────────────────────────
// The resume of a Nov 3 operation whose hand-off was refused read every ledger archive since Nov 3 synchronously on serve's
// loop while it held the journal lock, and serve was killed as wedged.

type EvidenceReader = NonNullable<ConstructorParameters<typeof ProductPlanOperationService>[0]["readLedgerLines"]>;

/** An evidence reader that records each read and answers the given lines, or never answers. */
function reader(lines: () => string[] | "never") {
  const reads: string[] = [];
  const read: EvidenceReader = async (stateDir) => {
    reads.push(stateDir);
    const answer = lines();
    return answer === "never" ? new Promise<never>(() => {}) : { ok: true, rawLines: answer };
  };
  return { read, reads };
}

const proposalLines = (f: Fixture, operationId: string): string[] => {
  const brief = f.calls.find((call) => call.operationId === operationId)?.brief;
  return [
    { ts: new Date(at(1_000)).toISOString(), run_id: "PANEL-1", task_id: productPlanLedgerTaskId(operationId), step: "ratify.cli_started", verb: "plan", pid: 4242 },
    { ts: new Date(at(2_000)).toISOString(), run_id: "PLAN-clarify-1", task_id: "PLAN-clarify", step: "plan.start", lane: "plan", mode: "clarify", brief },
    { ts: new Date(at(3_000)).toISOString(), run_id: "PLAN-clarify-1", task_id: "PLAN-clarify", step: "pr.opened", lane: "plan", pr_url: PR_URL },
  ].map((row) => JSON.stringify(row));
};

const journalPath = (f: Fixture) => join(f.journalDirectory, `${createHash("sha256").update(actor).digest("hex")}.json`);
const keptPath = (f: Fixture, operationId: string) => join(journalPath(f).replace(/\.json$/, `.${operationId}.evidence`), "evidence.json");

/** When a seeded legacy refusal was saved: after its run's rows (1-4 s after the request), as the gateway saves it. */
const REFUSED_OFFSET = 5_000;
const REFUSED = new Date(at(REFUSED_OFFSET)).toISOString();

function seedLegacyRefusal(f: Fixture, operationId: string, outcome: "refused" | "exited" = "refused") {
  const path = journalPath(f);
  const journal = JSON.parse(readFileSync(path, "utf8"));
  journal.operations[operationId].handoff = { outcome, at: REFUSED };
  writeFileSync(path, JSON.stringify(journal));
}

/** Load a filesystem fault in the reader subprocess. */
function preloadChildModule(t: TestContext, f: Fixture, source: string) {
  const path = join(f.root, "ledger-io.mjs");
  writeFileSync(path, source);
  const prior = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = [prior, `--import=${pathToFileURL(path).href}`].filter(Boolean).join(" ");
  t.after(() => {
    if (prior === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = prior;
  });
}

test("W1-T13875: a resume of a refused hand-off reads no ledger evidence", async (t) => {
  const f = fixture(t);
  let launches = 0;
  let deliveredBrief: string | undefined;
  const gateway = ratifyCliGateway(f.root, join(f.root, "logs"), { ledgerPath: f.ledgerPath,
    freshTree: async (action) => { launches++; return action({ path: f.root, sha: HEAD }); } });
  const first = await ok(f.service({ gateway: { inFlight: gateway.inFlight, productPlan: (call) => {
    deliveredBrief = call.brief;
    // Exercise the gateway's validation at its boundary. The service itself only constructs valid commands.
    return gateway.productPlan!({ ...call, repoRoot: "relative" });
  } } }).execute(actor, f.command()));
  const operationId = first.observation.operationId;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const journal = JSON.parse(readFileSync(journalPath(f), "utf8"));
  assert.deepEqual(journal.operations[operationId].handoff, { outcome: "refused", at: REQUESTED, beforeLaunch: true });

  // Ledger rows that would read as a proposal: a refusal where nothing ran must not even look.
  const evidence = reader(() => proposalLines(f, operationId).map((line) => {
    const row = JSON.parse(line);
    return row.step === "plan.start" ? JSON.stringify({ ...row, brief: deliveredBrief }) : line;
  }));
  for (let resume = 0; resume < 2; resume++) {
    const again = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
    assert.deepEqual([again.replayed, again.observation.operationId, again.observation.state], [true, operationId, "refused"]);
  }
  assert.equal(evidence.reads.length, 0);
  assert.equal(launches, 0);
});

test("W1-T13875: a resume of a refused hand-off reads no ledger evidence once a legacy refusal's window is read", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  seedLegacyRefusal(f, operationId); // the saved Nov 3 refusal: written before refusals said whether anything ran
  const windows: Array<{ sinceTs: string; untilMs?: number }> = [];
  const evidence = reader(() => []);
  const read: typeof evidence.read = (stateDir, opts) => { windows.push({ sinceTs: opts.sinceTs, untilMs: opts.untilMs }); return evidence.read(stateDir, opts); };
  for (let resume = 0; resume < 3; resume++) {
    const again = await ok(f.service({ gateway: false, readLedgerLines: read }).execute(actor, f.command()));
    assert.deepEqual([again.observation.operationId, again.observation.state], [operationId, "refused"]);
  }
  assert.deepEqual(windows, [{ sinceTs: REQUESTED, untilMs: Date.parse(REFUSED) }],
    "one read, of the request-to-refusal window only; later resumes read nothing");
});

test("W1-T13875: a legacy refusal can recover a proposal opened before the child exited nonzero", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  seedLegacyRefusal(f, operationId);
  nativeRun(f, operationId, { pr: PR_URL });
  f.row(at(4_000), { step: "ratify.cli_exited", task_id: productPlanLedgerTaskId(operationId), code: 1 });

  const resumed = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.deepEqual([resumed.replayed, resumed.observation.operationId, resumed.observation.state, resumed.observation.proposal],
    [true, operationId, "proposed", PR_URL]);
  const evidence = reader(() => []);
  const again = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
  assert.deepEqual([again.observation.state, again.observation.proposal], ["proposed", PR_URL]);
  assert.equal(evidence.reads.length, 0, "the recovered proposal was kept");
  assert.equal(f.calls.length, 1);
});

test("W1-T13875: a legacy refusal retries an incomplete archive scan without keeping its result", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  seedLegacyRefusal(f, operationId);
  const [started, planned, opened] = proposalLines(f, operationId).map((line) => JSON.parse(line) as Record<string, unknown>);
  const dir = dirname(f.ledgerPath);
  const cut = (offset: number) => new Date(at(offset)).toISOString();
  const later = cut(REFUSED_OFFSET + 2_000);
  writeLedger([], { dir, rotations: [
    { at: cut(2_500), rows: [started!, planned!] },
    { at: cut(REFUSED_OFFSET + 1_000), gz: true, rows: [opened!, { ts: cut(REFUSED_OFFSET + 500), step: "daemon.heartbeat" }] },
    { at: later, gz: true, rows: [] },
  ] });
  const archive = join(dir, `ledger.${later.replace(/[:.]/g, "-")}.ndjson.gz`);
  const saved = readFileSync(archive);
  writeFileSync(archive, "unreadable later archive");
  const incomplete = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.deepEqual([incomplete.observation.state, incomplete.observation.proposal], ["unknown", undefined]);

  writeFileSync(archive, saved);
  const resumed = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.deepEqual([resumed.observation.state, resumed.observation.proposal], ["proposed", PR_URL]);
});

test("W1-T13875: a legacy refusal never takes rows from outside its hand-off window", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  seedLegacyRefusal(f, operationId);
  const late = at(REFUSED_OFFSET + 1_000);
  const evidence = reader(() => proposalLines(f, operationId).map((line) => JSON.stringify({ ...JSON.parse(line), ts: new Date(late).toISOString() })));
  const resumed = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
  assert.deepEqual([resumed.observation.state, resumed.observation.proposal], ["refused", undefined]);
});

test("W1-T13875: a nonzero child exit preserves an opened proposal across resumes", { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "bin"));
  writeFileSync(join(f.root, "bin", "rmd"), `#!${process.execPath}\n` + String.raw`
    const { appendFileSync } = require("node:fs");
    const common = { ts: new Date().toISOString(), run_id: "PLAN-clarify-fixture", task_id: "PLAN-clarify", lane: "plan" };
    const rows = [
      { ...common, step: "plan.start", mode: "clarify", brief: process.argv[4] },
      { ...common, step: "pr.opened", pr_url: ${JSON.stringify(PR_URL)} },
    ];
    appendFileSync(${JSON.stringify(f.ledgerPath)}, rows.map((row) => JSON.stringify(row) + "\n").join(""));
    process.exitCode = 1;
  `, { mode: 0o755 });
  const gateway = ratifyCliGateway(f.root, join(f.root, "logs"), {
    ledgerPath: f.ledgerPath, freshTree: async (action) => action({ path: f.root, sha: HEAD }),
  });
  let handoff: ReturnType<NonNullable<typeof gateway.productPlan>> | undefined;
  const service = new ProductPlanOperationService({
    root: f.root, store: f.store, provider: f.provider, target: f.target, bootstrapConfirmed, ledgerPath: f.ledgerPath,
    checkout: () => f.checkout, runnerConfig, text: async () => JSON.stringify([{ name: "existing.yaml" }]),
    gateway: { inFlight: gateway.inFlight, productPlan: (call) => handoff = gateway.productPlan!(call) },
  });
  const first = await ok(service.execute(actor, f.command()));
  assert.deepEqual(await handoff, { outcome: "refused" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const journal = JSON.parse(readFileSync(journalPath(f), "utf8"));
  assert.equal(journal.operations[first.observation.operationId].handoff?.outcome, "exited");
  for (const resumed of [service, f.service({ gateway: false })]) {
    const next = await ok(resumed.execute(actor, f.command()));
    assert.equal(next.observation.state, "proposed", "a refused exit must still read the proposal the child already opened");
    assert.equal(next.observation.proposal, PR_URL);
  }
});

test("W1-T13875: invariant:bounded-read — an evidence read past its bound answers unknown and releases the journal", { timeout: 25_000 }, async (t) => {
  const f = fixture(t);
  const evidence = reader(() => "never");
  const service = f.service({ readLedgerLines: evidence.read, ledgerReadBoundMs: 200 });
  const first = await ok(service.execute(actor, f.command()));
  assert.equal(first.observation.state, "unknown", "an in-flight hand-off cannot turn a timeout into pending");
  assert.equal(first.observation.proposal, undefined);
  f.target.inspection.head = MOVED;
  const afterMove = await ok(service.execute(actor, f.command()));
  assert.equal(afterMove.observation.state, "unknown", "a moved target cannot override a timeout");
  assert.equal(evidence.reads.length, 2, "each attempt hit the bound");
  const key = createHash("sha256").update(actor).digest("hex");
  acquireInflightLock(join(f.journalDirectory, "locks"), key, { run_id: "after-ledger-timeout" }).release();

  seedLegacyRefusal(f, first.observation.operationId, "exited"); // a nonzero child exit still reads its evidence
  nativeRun(f, first.observation.operationId, { pr: PR_URL, exit: true });
  const entered = join(f.root, "listing-entered");
  const finished = join(f.root, "listing-finished");
  const bound = 5_000;
  preloadChildModule(t, f, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const list = fs.readdirSync;
    fs.readdirSync = (directory, ...args) => {
      if (directory === ${JSON.stringify(dirname(f.ledgerPath))} && !fs.existsSync(${JSON.stringify(entered)})) {
        fs.writeFileSync(${JSON.stringify(entered)}, "entered");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
        fs.writeFileSync(${JSON.stringify(finished)}, "finished");
      }
      return list(directory, ...args);
    };
    syncBuiltinESMExports();
  `);
  const listingStarted = (async () => {
    for await (const change of watch(f.root, { signal: AbortSignal.timeout(10_000) })) {
      if (change.filename === "listing-entered") return;
    }
    assert.fail("the default reader never reached the stalled directory listing");
  })();
  // Advance serve's deadline only once the actual filesystem call is blocked in the reader.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let pending = true;
    const resume = ok(f.service({ gateway: false, ledgerReadBoundMs: bound }).execute(actor, f.command()))
      .finally(() => { pending = false; });
    await Promise.race([listingStarted, resume.then(() => assert.fail("the reader answered before reaching its listing"))]);
    t.mock.timers.tick(bound - 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pending, true, "the read is pending one tick before its deadline");
    t.mock.timers.tick(1);
    const delayedDefault = await resume;
    assert.equal(delayedDefault.observation.state, "unknown");
    assert.equal(delayedDefault.observation.proposal, undefined);
    acquireInflightLock(join(f.journalDirectory, "locks"), key, { run_id: "while-listing-stalled" }).release();
    assert.ok(!existsSync(finished), "journal lock released while the listing was still blocked");
  } finally {
    t.mock.timers.reset();
  }

  const lateBound = 200;
  const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, lateBound * 2);
  const delayedProposal = reader(() => { block(); return proposalLines(f, first.observation.operationId); });
  const late = await ok(f.service({ readLedgerLines: delayedProposal.read, ledgerReadBoundMs: lateBound }).execute(actor, f.command()));
  assert.equal(delayedProposal.reads.length, 1);
  assert.equal(late.observation.state, "unknown");
  assert.equal(late.observation.proposal, undefined);
  const lateFailure = reader(() => { block(); throw new Error("late reader failure"); });
  assert.equal((await ok(f.service({ readLedgerLines: lateFailure.read, ledgerReadBoundMs: lateBound }).execute(actor, f.command()))).observation.state, "unknown");
  assert.equal(lateFailure.reads.length, 1);
  const earlyFailure = reader(() => { throw new Error("early reader failure"); });
  assert.equal(await refused(f.service({ readLedgerLines: earlyFailure.read }).execute(actor, f.command())), "unavailable");
  acquireInflightLock(join(f.journalDirectory, "locks"), key, { run_id: "after-late-evidence" }).release();

  const savedLive = `${f.ledgerPath}.saved`;
  renameSync(f.ledgerPath, savedLive);
  symlinkSync(f.ledgerPath, f.ledgerPath);
  try {
    assert.equal(await refused(f.service({ gateway: false }).execute(actor, f.command())), "unavailable",
      "a failed live-file identity check refuses to use the snapshot");
  } finally {
    unlinkSync(f.ledgerPath);
    renameSync(savedLive, f.ledgerPath);
  }
  const next = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.equal(next.observation.state, "proposed");
  assert.equal(next.observation.proposal, PR_URL, "late evidence was discarded and a new read could succeed");
});

test("W1-T13875: invariant:bounded-read preserves stale-target and changed-brief when a read is promptly incomplete", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  seedLegacyRefusal(f, operationId);
  const calls: string[] = [];
  const service = f.service({ gateway: false, ledgerReadBoundMs: 1_000, readLedgerLines: async (_dir, { sinceTs }) => {
    calls.push(sinceTs);
    return { ok: false, rawLines: proposalLines(f, operationId) };
  } });
  f.target.inspection.head = MOVED;
  const stale = await ok(service.execute(actor, f.command()));

  assert.ok(f.store.write(actor, { version: "product-intent-v1", requestId: "brief-changed-000002", id: f.productId,
    expectedRevision: revisionOf(f), brief: { ...brief, idea: "a different original idea" } }).ok);
  const changed = await ok(service.execute(actor, f.command()));
  assert.deepEqual([stale, changed].map(({ observation }) => [observation.state, observation.proposal]),
    [["stale-target", undefined], ["changed-brief", undefined]]);
  assert.deepEqual(calls, [REQUESTED, REQUESTED], "an incomplete view is retried and contributes no proposal");

  const never = reader(() => "never");
  const expired = await ok(f.service({ gateway: false, ledgerReadBoundMs: 20, readLedgerLines: never.read }).execute(actor, f.command()));
  assert.deepEqual([expired.observation.state, expired.observation.proposal], ["unknown", undefined]);
  assert.equal(never.reads.length, 1, "the expired read could not report either changed state");
});

test("W1-T13875: invariant:bounded-read settles against the product revision read after an edit committed during the evidence read", async (t) => {
  for (const proposal of [false, true]) {
    const f = fixture(t);
    const first = await ok(f.service().execute(actor, f.command()));
    const operationId = first.observation.operationId;
    seedLegacyRefusal(f, operationId);
    let edits = 0;
    // A Console brief save lands while the (up to 15 s) read is awaited.
    const read: EvidenceReader = async () => {
      edits++;
      assert.ok(f.store.write(actor, { version: "product-intent-v1", requestId: "brief-during-read-001", id: f.productId,
        expectedRevision: revisionOf(f), brief: { ...brief, idea: "an idea saved while the evidence was read" } }).ok);
      return { ok: true, rawLines: proposal ? proposalLines(f, operationId) : [] };
    };
    const resumed = await f.service({ gateway: false, readLedgerLines: read }).execute(actor, f.command());
    assert.equal(edits, 1);
    assert.ok(resumed.ok, `a brief saved during the read is not a stale revision (proposal: ${proposal}): ${JSON.stringify(resumed)}`);
    assert.equal(resumed.value.observation.state, "changed-brief");
    assert.ok(!evidenceIds(f).some((id) => id.endsWith(":proposed") || id.endsWith(":refused")), "a plan for the old brief is never settled onto the new one");
  }
});

test("W1-T13875: a proposal's evidence is read once and kept", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  let reads = 0;
  const evidence = reader(() => ++reads === 2 ? proposalLines(f, operationId) : []);
  const service = f.service({ readLedgerLines: evidence.read });
  f.target.inspection.head = MOVED;
  const command = f.command({ requestId: "plan-request-moved-head", expectedRevision: revisionOf(f) });
  const reused = await ok(service.execute(actor, command));
  assert.deepEqual([reused.replayed, reused.observation.operationId, reused.observation.state], [true, operationId, "stale-target"]);
  assert.equal(evidence.reads.length, 1, "the final observation used the same nonterminal evidence as selection");
  for (const resumed of [service, service, f.service({ gateway: false, readLedgerLines: evidence.read })]) {
    const settled = await ok(resumed.execute(actor, command));
    assert.equal(settled.observation.operationId, operationId);
    assert.equal(settled.observation.state, "proposed");
    assert.equal(settled.observation.proposal, PR_URL);
  }
  assert.equal(evidence.reads.length, 2, "only the first resume read the final proposal");
  assert.equal(f.calls.length, 1, "the moved head never launched a second planner for an unresolved brief");
});

test("W1-T13875: a proposal's evidence is read once and kept when the journal is full", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  const path = journalPath(f);
  const journal = JSON.parse(readFileSync(path, "utf8"));
  const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
  const record = journal.operations[operationId];
  // Another brief's operation pads the journal to exactly its byte limit; it is never this brief's evidence.
  const filler = { ...record, operationId: hex("filler"), briefDigest: hex("filler-brief"), command: { ...record.command, repoRoot: "/" } };
  journal.operations[filler.operationId] = filler;
  const limit = PRODUCT_PLAN_OPERATION_LIMITS.stateBytes;
  const size = () => Buffer.byteLength(JSON.stringify(journal));
  const entry = (i: number) => { journal.requests[hex(`request-${i}`)] = { operationId: filler.operationId, payloadDigest: hex(`payload-${i}`) }; };
  const before = size();
  entry(0);
  const each = size() - before; // every entry and its comma have the same length
  for (let i = 1, total = before + each; total < limit - 900; i++, total += each) entry(i);
  filler.command.repoRoot = "/" + "x".repeat(limit - size());
  writeFileSync(path, JSON.stringify(journal));
  assert.equal(statSync(path).size, limit, "the journal is at its byte limit");

  const evidence = reader(() => proposalLines(f, operationId));
  for (const resumed of [f.service({ gateway: false, readLedgerLines: evidence.read }), f.service({ gateway: false, readLedgerLines: evidence.read })]) {
    const next = await ok(resumed.execute(actor, f.command()));
    assert.deepEqual([next.observation.operationId, next.observation.state, next.observation.proposal], [operationId, "proposed", PR_URL]);
  }
  assert.equal(evidence.reads.length, 1, "a journal with no room still keeps the proposal it read, across a restart");
  assert.ok(existsSync(keptPath(f, operationId)), "kept beside the journal, not in memory");
  assert.equal(statSync(path).size, limit, "nothing was written past the limit");
});

test("W1-T13875: a proposal's evidence is read once and kept across rotation during the read", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  const proposal = proposalLines(f, operationId).map((line) => JSON.parse(line) as Record<string, unknown>);
  const liveDir = dirname(f.ledgerPath);
  writeLedger(proposal, { dir: liveDir });
  const exit = { ts: new Date(at(5_000)).toISOString(), task_id: productPlanLedgerTaskId(operationId), step: "ratify.cli_exited", code: 1 };
  const rotated = writeLedger([exit], { dir: join(f.root, "rotated"),
    rotations: [{ at: new Date(at(4_000)).toISOString(), gz: true, rows: proposal }] });
  const archiveName = readdirSync(rotated.dir).find((name) => name.endsWith(".ndjson.gz"));
  assert.ok(archiveName);
  const archive = join(liveDir, archiveName);
  preloadChildModule(t, f, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const live = ${JSON.stringify(f.ledgerPath)};
    const archive = ${JSON.stringify(archive)};
    const read = fs.promises.readFile;
    fs.promises.readFile = (path, ...args) => {
      if (path === live && !fs.existsSync(archive)) {
        fs.renameSync(${JSON.stringify(join(rotated.dir, archiveName))}, archive);
        fs.renameSync(${JSON.stringify(rotated.path)}, live);
      }
      return read(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  const resumed = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.ok(existsSync(archive), "the archive landed after the default reader listed the directory");
  assert.equal(readFileSync(f.ledgerPath, "utf8").trim(), JSON.stringify(exit), "only the exit remained in the live file");
  assert.deepEqual([resumed.observation.state, resumed.observation.proposal], ["proposed", PR_URL]);

  const evidence = reader(() => []);
  const restarted = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
  assert.deepEqual([restarted.observation.state, restarted.observation.proposal], ["proposed", PR_URL]);
  assert.equal(evidence.reads.length, 0, "the stable proposal was saved for later resumes");
});

test("W1-T13875: a proposal's evidence is read once and kept, and never from rows before its request", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  const early = new Date(at(-1_000)).toISOString();
  const stale = reader(() => [JSON.stringify({ ts: early, task_id: productPlanLedgerTaskId(operationId), step: "ratify.cli_exited", code: 1 })]);
  const before = await ok(f.service({ gateway: false, readLedgerLines: stale.read }).execute(actor, f.command()));
  assert.equal(before.observation.state, "unknown", "an exit stamped before the request is not this operation's");
  const evidence = reader(() => proposalLines(f, operationId));
  for (let resume = 0; resume < 2; resume++) {
    const next = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
    assert.deepEqual([next.observation.state, next.observation.proposal], ["proposed", PR_URL]);
  }
  assert.equal(evidence.reads.length, 1, "the pre-request row was never kept as final");
});

test("W1-T13875: a correlated exit or failure survives restart without another read", async (t) => {
  for (const [step, state] of [["ratify.cli_exited", "refused"], ["ratify.handoff_failed", "unknown"]] as const) {
    const f = fixture(t);
    const first = await ok(f.service().execute(actor, f.command()));
    const operationId = first.observation.operationId;
    f.row(at(1_000), { task_id: productPlanLedgerTaskId(operationId), step });
    const settled = await ok(f.service({ gateway: false }).execute(actor, f.command()));
    assert.equal(settled.observation.state, state);
    const evidence = reader(() => proposalLines(f, operationId));
    const again = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
    assert.equal(again.observation.state, state);
    assert.equal(evidence.reads.length, 0);
  }
});

// ── W1-T13875 review rounds: each claim's whole path, not only its ledger read ─────────────────────────────

test("W1-T13875 criterion 1: a legacy refusal's window ends at its saved refusal, with no slack after it", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  seedLegacyRefusal(f, operationId);
  // Every row lands after the refusal was saved, though well inside a minute of it: none is this refusal's evidence.
  const after = reader(() => proposalLines(f, operationId).map((line, index) =>
    JSON.stringify({ ...JSON.parse(line), ts: new Date(at(REFUSED_OFFSET + 1 + index * 10_000)).toISOString() })));
  const resumed = await ok(f.service({ gateway: false, readLedgerLines: after.read }).execute(actor, f.command()));
  assert.deepEqual([resumed.observation.state, resumed.observation.proposal], ["refused", undefined]);
  assert.equal(after.reads.length, 1);

  // A proposal opened at the very millisecond the refusal was saved is still inside the window.
  const g = fixture(t);
  const second = await ok(g.service().execute(actor, g.command()));
  seedLegacyRefusal(g, second.observation.operationId);
  const edge = reader(() => proposalLines(g, second.observation.operationId).map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((row) => JSON.stringify(row.step === "pr.opened" ? { ...row, ts: REFUSED } : row)));
  const kept = await ok(g.service({ gateway: false, readLedgerLines: edge.read }).execute(actor, g.command()));
  assert.deepEqual([kept.observation.state, kept.observation.proposal], ["proposed", PR_URL]);
});

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("W1-T13875 criterion 2: a stalled open of the kept evidence file answers unknown within the bound and releases the journal", { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  const evidence = reader(() => proposalLines(f, operationId));
  const settled = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
  assert.equal(settled.observation.state, "proposed");
  const kept = keptPath(f, operationId);
  assert.ok(existsSync(kept));

  const openStarted = deferredSignal();
  const openReleased = deferredSignal();
  const realOpen = fsPromises.open;
  const stalledOpen = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof realOpen>) => {
    if (args[0] === kept) {
      openStarted.resolve();
      await openReleased.promise;
    }
    return realOpen(...args);
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const bound = 25;
    let pending = true;
    const resume = ok(f.service({ gateway: false, readLedgerLines: evidence.read, ledgerReadBoundMs: bound }).execute(actor, f.command()))
      .finally(() => { pending = false; });
    await Promise.race([openStarted.promise, resume.then(() => assert.fail("resume answered without opening the kept file"))]);
    t.mock.timers.tick(bound - 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pending, true, "the open is still pending one tick before the bound");
    t.mock.timers.tick(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pending, false, "resume answers at the bound while the open is still stalled");
    const resumed = await resume;
    assert.deepEqual([resumed.observation.state, resumed.observation.proposal], ["unknown", undefined]);
    const key = createHash("sha256").update(actor).digest("hex");
    acquireInflightLock(join(f.journalDirectory, "locks"), key, { run_id: "while-kept-open-stalled" }).release();
    assert.equal(evidence.reads.length, 1, "a stalled kept file is not a reason to read the ledger again");
  } finally {
    t.mock.timers.reset();
    stalledOpen.mock.restore();
    syncBuiltinESMExports();
    openReleased.resolve();
  }

  const again = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
  assert.deepEqual([again.observation.state, again.observation.proposal], ["proposed", PR_URL]);
  assert.equal(evidence.reads.length, 1, "the kept proposal answered once the file was readable");
});

function mockEvidenceSync(t: TestContext, f: Fixture, flush: (sync: () => Promise<void>) => Promise<void>) {
  const realOpen = fsPromises.open;
  const mock = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof realOpen>) => {
    const handle = await realOpen(...args);
    if (String(args[0]).startsWith(`${f.journalDirectory}/.`) && String(args[0]).endsWith(".pending/evidence.json")) {
      const sync = handle.sync.bind(handle);
      handle.sync = () => flush(sync);
    }
    return handle;
  });
  syncBuiltinESMExports();
  return () => { mock.mock.restore(); syncBuiltinESMExports(); };
}

test("W1-T13875: invariant:bounded-read releases the journal while a new evidence flush is stalled", { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  const evidence = reader(() => proposalLines(f, operationId));
  const ownerKey = createHash("sha256").update(actor).digest("hex");
  const kept = keptPath(f, operationId);
  const started = deferredSignal();
  const release = deferredSignal();
  const discarded = deferredSignal();
  const restoreSync = mockEvidenceSync(t, f, async (sync) => {
    started.resolve();
    await release.promise;
    await sync();
  });
  const realRm = fsPromises.rm;
  const removeStage = t.mock.method(fsPromises, "rm", async (...args: Parameters<typeof realRm>) => {
    await realRm(...args);
    if (String(args[0]).startsWith(`${f.journalDirectory}/.`)) discarded.resolve();
  });
  syncBuiltinESMExports();
  const bound = 5_000;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let finished = false;
    const resume = ok(f.service({ gateway: false, readLedgerLines: evidence.read, ledgerReadBoundMs: bound }).execute(actor, f.command()))
      .finally(() => { finished = true; });
    await Promise.race([started.promise, resume.then(() => assert.fail("resume answered before flushing its evidence"))]);
    t.mock.timers.tick(bound);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, true, "resume answered at the deadline while the flush was still stalled");
    const result = await resume;
    assert.deepEqual([result.observation.state, result.observation.proposal], ["unknown", undefined]);
    acquireInflightLock(join(f.journalDirectory, "locks"), ownerKey, { run_id: "while-evidence-flush-stalled" }).release();
    assert.equal(existsSync(kept), false, "unflushed evidence was never published");
    assert.equal(evidence.reads.length, 1);
    t.mock.timers.reset();
    restoreSync();

    const nextUrl = PR_URL.replace(/42$/, "43");
    const next = reader(() => proposalLines(f, operationId).map((line) => line.replace(PR_URL, nextUrl)));
    assert.equal((await ok(f.service({ gateway: false, readLedgerLines: next.read }).execute(actor, f.command()))).observation.proposal, nextUrl);
    release.resolve();
    await discarded.promise;
    assert.equal((await ok(f.service({ gateway: false, readLedgerLines: next.read }).execute(actor, f.command()))).observation.proposal, nextUrl);
    assert.equal(next.reads.length, 1, "the late stage was discarded and the successful retry stayed kept across restarts");
  } finally {
    t.mock.timers.reset();
    restoreSync();
    removeStage.mock.restore();
    syncBuiltinESMExports();
    release.resolve();
  }
});

test("W1-T13875 criterion 3: a proposal is never answered from evidence its write failed to keep", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  const evidence = reader(() => proposalLines(f, operationId));
  const restore = mockEvidenceSync(t, f, async () => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
  const failing = f.service({ gateway: false, readLedgerLines: evidence.read });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      // The same service never answers a proposal it could not keep.
      assert.equal(await refused(failing.execute(actor, f.command())), "unavailable");
    }
  } finally {
    restore();
  }
  const kept = keptPath(f, operationId);
  assert.equal(existsSync(kept), false, "nothing was kept, so nothing was answered as kept");
  assert.equal(evidence.reads.length, 2);

  for (let resume = 0; resume < 3; resume++) {
    const next = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
    assert.deepEqual([next.observation.state, next.observation.proposal], ["proposed", PR_URL]);
  }
  assert.equal(evidence.reads.length, 3, "the first answered proposal is the one kept, and every restart after it reads nothing");
});

test("W1-T13875 criterion 3: an unreadable kept file is never rewritten without the evidence it holds", async (t) => {
  const f = fixture(t);
  const a = await ok(f.service().execute(actor, f.command()));
  const evidence = reader(() => proposalLines(f, a.observation.operationId));
  assert.equal((await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()))).observation.state, "proposed");
  const kept = keptPath(f, a.observation.operationId);
  const saved = readFileSync(kept);
  writeFileSync(kept, "{ torn");
  assert.equal(await refused(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command())), "corrupt");
  assert.equal(readFileSync(kept, "utf8"), "{ torn", "a corrupt kept file is left for an operator, never overwritten");
  assert.equal(evidence.reads.length, 1, "an unreadable kept file is not a reason to read the ledger again");
  writeFileSync(kept, saved);
  assert.equal((await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()))).observation.state, "proposed");
  assert.equal(evidence.reads.length, 1);
});

test("W1-T13875: a resume of a refused hand-off reads no ledger evidence once a legacy proposal past a future-stamped heartbeat is kept", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  seedLegacyRefusal(f, operationId);
  const [started, planned, opened] = proposalLines(f, operationId).map((line) => JSON.parse(line) as Record<string, unknown>);
  const ts = (offset: number) => new Date(at(offset)).toISOString();
  // Rotation snapshots the live file BEFORE it stamps the archive. Here the snapshot preceded the in-window proposal and its
  // nonzero exit. It already held an unrelated future-stamped heartbeat; the proposal and exit reached the next archive.
  writeLedger([{ ts: ts(REFUSED_OFFSET + 9_000), step: "daemon.heartbeat" }], { dir: dirname(f.ledgerPath), rotations: [
    { at: ts(REFUSED_OFFSET + 1), gz: true, rows: [started!, planned!, { ts: ts(REFUSED_OFFSET + 2_000), step: "daemon.heartbeat" }] },
    { at: ts(REFUSED_OFFSET + 4_000), gz: true, rows: [{ ...opened!, ts: ts(REFUSED_OFFSET - 500) },
      { ts: ts(REFUSED_OFFSET - 100), task_id: productPlanLedgerTaskId(operationId), step: "ratify.cli_exited", code: 1 },
      { ts: ts(REFUSED_OFFSET + 3_000), step: "daemon.heartbeat" }] },
  ] });
  const resumed = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.deepEqual([resumed.observation.state, resumed.observation.proposal], ["proposed", PR_URL],
    "the proposal opened before the nonzero exit is recovered from the archive after the first cut");
  const evidence = reader(() => []);
  const again = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
  assert.deepEqual([again.observation.state, again.observation.proposal], ["proposed", PR_URL]);
  assert.equal(evidence.reads.length, 0, "the recovered proposal was kept, never a refusal");
});

test("W1-T13875 criterion 2: a kept-evidence read that rejects past the deadline, before the timer fires, answers unknown", { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  const evidence = reader(() => proposalLines(f, operationId));
  assert.equal((await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()))).observation.state, "proposed");
  const kept = keptPath(f, operationId);
  assert.ok(existsSync(kept));

  const bound = 25;
  const realOpen = fsPromises.open;
  const lateReject = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof realOpen>) => {
    if (args[0] === kept) {
      // Real time passes the deadline, but the bound's (mocked) timer has not run: the open then rejects.
      const until = performance.now() + bound * 2;
      while (performance.now() < until) await new Promise<void>((resolve) => setImmediate(resolve));
      throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
    }
    return realOpen(...args);
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const resumed = await f.service({ gateway: false, readLedgerLines: evidence.read, ledgerReadBoundMs: bound }).execute(actor, f.command());
    assert.ok(resumed.ok, `a failure past the bound is unknown, never ${JSON.stringify(resumed)}`);
    assert.deepEqual([resumed.value.observation.state, resumed.value.observation.proposal], ["unknown", undefined]);
    acquireInflightLock(join(f.journalDirectory, "locks"), createHash("sha256").update(actor).digest("hex"), { run_id: "after-late-kept-reject" }).release();
  } finally {
    t.mock.timers.reset();
    lateReject.mock.restore();
    syncBuiltinESMExports();
  }
  const again = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
  assert.deepEqual([again.observation.state, again.observation.proposal], ["proposed", PR_URL]);
  assert.equal(evidence.reads.length, 1, "the kept proposal is intact");
});

test("W1-T13875 criterion 3: a view taken while rotation drains the replaced live file is never kept as final", { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  const proposal = proposalLines(f, operationId);
  const exit = JSON.stringify({ ts: new Date(at(5_000)).toISOString(), task_id: productPlanLedgerTaskId(operationId), step: "ratify.cli_exited", code: 1 });
  // Mid-rotation: the new live inode already holds the child's exit, while the replaced inode still holds the proposal
  // the rotation's drain has yet to copy across. The rotation lock is held throughout.
  writeFileSync(f.ledgerPath, `${exit}\n`);
  const lock = `${f.ledgerPath}.rotate.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: "fixture", startedAt: new Date().toISOString() }));
  // The drain finishes, and the lock is released, shortly after the reader first looks at the lock or the live file.
  preloadChildModule(t, f, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const live = ${JSON.stringify(f.ledgerPath)};
    const lock = ${JSON.stringify(lock)};
    let scheduled = false;
    const drainSoon = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        fs.appendFileSync(live, ${JSON.stringify(proposal.join("\n") + "\n")});
        fs.unlinkSync(lock);
      }, 50);
    };
    const lstat = fs.lstatSync;
    fs.lstatSync = (path, ...args) => { if (path === lock) drainSoon(); return lstat(path, ...args); };
    const read = fs.promises.readFile;
    fs.promises.readFile = (path, ...args) => { if (path === live) drainSoon(); return read(path, ...args); };
    syncBuiltinESMExports();
  `);
  const resumed = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.deepEqual([resumed.observation.state, resumed.observation.proposal], ["proposed", PR_URL],
    "the exit seen before the drain finished is not this operation's final evidence");
  const evidence = reader(() => []);
  const again = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
  assert.deepEqual([again.observation.state, again.observation.proposal], ["proposed", PR_URL]);
  assert.equal(evidence.reads.length, 0, "the proposal was kept for later resumes");
});

// ── W1-T13875 review round 2026-11-21: the production window read, a stalled publish, a journaled nonzero exit ─────

test("W1-T13875: a resume of a refused hand-off reads no ledger evidence after keeping a proposal recovered from nonadjacent compacted rotations", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  seedLegacyRefusal(f, operationId);
  const [started, planned, opened] = proposalLines(f, operationId).map((line) => JSON.parse(line) as Record<string, unknown>);
  const dir = dirname(f.ledgerPath);
  const cut = (offset: number) => new Date(at(offset)).toISOString();
  const intermediate = REFUSED_OFFSET + 11 * 60_000;
  const later = REFUSED_OFFSET + 20 * 60_000;
  const excluded = cut(REFUSED_OFFSET + 30 * 60_000);
  writeLedger([], { dir, rotations: [
    { at: cut(2_500), rows: [started!, planned!] },
    { at: cut(REFUSED_OFFSET + 1_000), rows: [opened!] },
    { at: cut(intermediate), gz: true, rows: [{ ts: cut(intermediate - 1_000), step: "daemon.heartbeat" }] },
    { at: cut(later), rows: [{ ts: cut(later - 1_000), step: "daemon.heartbeat" }] },
    { at: excluded, gz: true, rows: [{ ts: excluded, step: "daemon.heartbeat" }] },
  ] });
  const rotation = (stamp: string) => join(dir, `ledger.${stamp.replace(/[:.]/g, "-")}.ndjson`);
  const compacted = compactRotations([rotation(cut(REFUSED_OFFSET + 1_000)), rotation(cut(later))], {
    readRows: (path) => readFileSync(path, "utf8").split("\n"),
    write: (name, body) => writeFileSync(join(dir, name), gzipSync(body)), remove: unlinkSync,
    clock: fixedClock(at(later + 1_000)),
  });
  assert.equal(compacted.archiveName, `ledger.${cut(later - 1_000).replace(/[:.]/g, "-")}.ndjson.gz`);
  const excludedPath = `${rotation(excluded)}.gz`;
  assert.equal((await readLedgerKeyManifest(dir, { path: excludedPath, form: "gzip" })).kind, "built");
  preloadChildModule(t, f, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const read = fs.promises.readFile;
    fs.promises.readFile = (path, ...args) => {
      if (path === ${JSON.stringify(excludedPath)}) throw new Error("archive outside the verified window was opened");
      return read(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  const resumed = await ok(f.service({ gateway: false }).execute(actor, f.command()));
  assert.deepEqual([resumed.observation.state, resumed.observation.proposal], ["proposed", PR_URL],
    "the compacted archive still covers the refusal window despite sorting after an out-of-window archive");
  const reread = reader(() => []);
  const restarted = await ok(f.service({ gateway: false, readLedgerLines: reread.read }).execute(actor, f.command()));
  assert.equal(restarted.observation.proposal, PR_URL);
  assert.equal(reread.reads.length, 0);
});

test("W1-T13875: a proposal's evidence is read once and kept when another instance's publish finishes late", { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const other = secondPlanCommand(f);
  const second = await ok(f.service().execute(actor, other));
  const firstId = first.observation.operationId;
  const secondId = second.observation.operationId;
  const evidence = reader(() => proposalLines(f, firstId));
  const ownerKey = createHash("sha256").update(actor).digest("hex");
  const renaming = deferredSignal();
  const release = deferredSignal();
  const renamed = deferredSignal();
  const realRename = fsPromises.rename;
  const stall = t.mock.method(fsPromises, "rename", async (from: Parameters<typeof realRename>[0], to: Parameters<typeof realRename>[1]) => {
    if (dirname(keptPath(f, firstId)) !== to && `${journalPath(f).slice(0, -5)}.evidence.json` !== to) return realRename(from, to);
    renaming.resolve();
    await release.promise;
    try { await realRename(from, to); } finally { renamed.resolve(); }
  });
  syncBuiltinESMExports();
  const bound = 5_000;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let finished = false;
    const resume = ok(f.service({ gateway: false, readLedgerLines: evidence.read, ledgerReadBoundMs: bound }).execute(actor, f.command()))
      .finally(() => { finished = true; });
    await Promise.race([renaming.promise, resume.then(() => assert.fail("resume answered before publishing its evidence"))]);
    t.mock.timers.tick(bound);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, true, "resume answered at the deadline while the publish was still stalled");
    const result = await resume;
    assert.deepEqual([result.observation.state, result.observation.proposal], ["unknown", undefined]);
    acquireInflightLock(join(f.journalDirectory, "locks"), ownerKey, { run_id: "while-evidence-publish-stalled" }).release();
    t.mock.timers.reset();
    stall.mock.restore();
    syncBuiltinESMExports();

    const secondEvidence = reader(() => proposalLines(f, secondId));
    const retryURL = PR_URL.replace(/42$/, "43");
    const retry = reader(() => proposalLines(f, firstId).map((line) => line.replace(PR_URL, retryURL)));
    assert.equal((await ok(f.service({ gateway: false, readLedgerLines: secondEvidence.read }).execute(actor, other))).observation.proposal, PR_URL);
    assert.equal((await ok(f.service({ gateway: false, readLedgerLines: retry.read }).execute(actor, f.command()))).observation.proposal, retryURL);
    release.resolve();
    await renamed.promise;

    const restarted = f.service({ gateway: false, readLedgerLines: secondEvidence.read });
    assert.equal((await ok(restarted.execute(actor, other))).observation.proposal, PR_URL);
    assert.equal((await ok(restarted.execute(actor, f.command()))).observation.proposal, retryURL);
    assert.equal(secondEvidence.reads.length, 1, "neither operation was read again after the late publish");
  } finally {
    t.mock.timers.reset();
    release.resolve();
    stall.mock.restore();
    syncBuiltinESMExports();
  }
});

test("W1-T13875: a proposal's evidence is read once and kept from an existing shared evidence file", async (t) => {
  const f = fixture(t);
  const setup = await ok(f.service().execute(actor, f.command()));
  const operationId = setup.observation.operationId;
  const source = reader(() => proposalLines(f, operationId));
  const resume = f.service({ gateway: false, readLedgerLines: source.read });
  assert.equal((await ok(resume.execute(actor, f.command()))).observation.proposal, PR_URL);
  const kept = keptPath(f, operationId);
  renameSync(kept, `${journalPath(f).slice(0, -5)}.evidence.json`);
  rmdirSync(dirname(kept));
  assert.equal((await ok(f.service({ gateway: false, readLedgerLines: source.read }).execute(actor, f.command()))).observation.proposal, PR_URL);
  assert.equal(source.reads.length, 1);
});

test("W1-T13875: a journaled nonzero exit stays refused and is kept when its exit row is missing", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  seedLegacyRefusal(f, operationId, "exited"); // the gateway saved the nonzero exit but could not append ratify.cli_exited
  const evidence = reader(() => []);
  for (let resume = 0; resume < 3; resume++) {
    const again = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
    assert.deepEqual([again.observation.operationId, again.observation.state], [operationId, "refused"]);
  }
  assert.equal(evidence.reads.length, 1, "the final exit was read once and kept");
});

test("W1-T13875: a journaled nonzero exit leaves ambiguous native runs unknown when the target moves", async (t) => {
  const f = fixture(t);
  const first = await ok(f.service().execute(actor, f.command()));
  const operationId = first.observation.operationId;
  seedLegacyRefusal(f, operationId, "exited");
  const lines = proposalLines(f, operationId);
  const evidence = reader(() => [...lines, lines[1]!.replace("PLAN-clarify-1", "PLAN-clarify-2")]);
  const resumed = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
  assert.deepEqual([resumed.observation.state, resumed.observation.proposal], ["unknown", undefined]);
  f.target.inspection.head = MOVED;
  const fresh = await ok(f.service({ readLedgerLines: evidence.read }).execute(actor,
    f.command({ requestId: "plan-request-after-ambiguous", expectedRevision: revisionOf(f) })));
  assert.deepEqual([fresh.replayed, fresh.observation.operationId, fresh.observation.state], [true, operationId, "stale-target"]);
  assert.equal(evidence.reads.length, 1);
  assert.equal(f.calls.length, 1);
});
