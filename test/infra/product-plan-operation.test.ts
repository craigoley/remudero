import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { createHash } from "node:crypto";
import { repoRoot } from "#test/helpers/repo-root.js";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { bootstrapConfirmed } from "#src/lib/product-build.js";
import { ratifyCliGateway } from "#src/lib/panel-graph.js";
import {
  productCasePlanText, productPlanLedgerTaskId, productPlanOrigin, ProductPlanOperationService,
  type PlanHandoffOutcome, type PlanRepository, type PlanTargetPort,
} from "#src/lib/product-plan-operation.js";
import type { ProductRepositoryProvider, ProviderRead } from "#src/lib/product-repository.js";
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

class Target implements PlanTargetPort {
  inspection = { enrolled: true as boolean | undefined, head: HEAD as string | undefined, readmeOnly: false as boolean | undefined };
  runner = true;
  async inspect() { return this.inspection; }
  runnerRegistered() { return this.runner; }
}

function fixture(t: TestContext, over: { planned?: "clarify" | "create" | "unreadable"; gateway?: boolean; bound?: boolean; envelope?: boolean } = {}) {
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
    if (over.planned === "unreadable") throw new Error("gh: server error (HTTP 502)");
    if (over.planned === "create") throw new Error("gh: Not Found (HTTP 404)");
    assert.match(args.join(" "), /contents\/plan\/tasks\.d\?ref=/);
    return JSON.stringify([{ name: "WRECK-T1-first.yaml" }]);
  };
  const checkout = join(root, "repos", "wreckterra");
  const service = (options: { alive?: boolean; head?: string; gateway?: boolean } = {}) => new ProductPlanOperationService({
    root, store, provider, target, bootstrapConfirmed, ledgerPath, text, checkout: (repo: PlanRepository) => repo.name === "wreckterra" ? checkout : undefined,
    clock: fixedClock(Date.parse(REQUESTED)), isAlive: () => options.alive ?? true,
    ...(options.gateway === false || over.gateway === false ? {} : { gateway }),
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
      root: f.root, store: f.store, provider: f.provider, target: f.target, bootstrapConfirmed, ledgerPath: f.ledgerPath, checkout: () => f.checkout,
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
  const saved = f.store.write(actor, { version: "product-intent-v1", requestId: "second-product-000001", expectedRevision: 0,
    brief: { ...brief, idea: "another saved original combat product" } });
  assert.ok(saved.ok);
  const secondId = saved.value.receipt.productId;
  assert.ok(f.store.transition(actor, { version: "product-intent-v1", requestId: "second-binding-000001", id: secondId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository: identity }).ok);
  const commands = [f.command(), f.command({ productId: secondId, requestId: "second-plan-000001" })];
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
  const gateway = ratifyCliGateway(cli, join(f.root, "logs"), { ledgerPath: f.ledgerPath,
    freshTree: async (action) => action({ path: cli, sha: "f".repeat(40) }) });
  const service = new ProductPlanOperationService({ root: f.root, store: f.store, provider: f.provider, target: f.target,
    bootstrapConfirmed, ledgerPath: f.ledgerPath, text: async () => "[]", checkout: () => f.checkout, gateway });
  const first = await ok(service.execute(actor, f.command()));
  assert.equal(first.observation.state, "pending");
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
