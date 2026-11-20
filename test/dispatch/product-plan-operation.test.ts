import assert from "node:assert/strict";
import { existsSync, fstatSync, fsyncSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { watch } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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
  type PlanHandoffOutcome, type PlanHandoffPort, type PlanRepository, type PlanTargetPort,
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

/** The fake checkout carries no git tree: these suites assume a present table (W1-T11195 tests the reader itself). */
const runnerConfig = async (_checkout: string, head: string) => ({ state: "present" as const, head, path: ".remudero/mounts.yaml", digest: "0".repeat(64) });

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
  const service = (options: { alive?: boolean; head?: string; gateway?: boolean; inFlight?: PlanHandoffPort["inFlight"]; sync?: (fd: number) => void; readLedgerLines?: EvidenceReader; ledgerReadBoundMs?: number } = {}) => new ProductPlanOperationService({
    root, store, provider, target, bootstrapConfirmed, ledgerPath, text, checkout: (repo: PlanRepository) => repo.name === "wreckterra" ? checkout : undefined, runnerConfig,
    clock: fixedClock(Date.parse(REQUESTED)), isAlive: () => options.alive ?? true,
    ...(options.gateway === false || over.gateway === false ? {} : { gateway: { ...gateway, inFlight: options.inFlight } }),
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

function seedLegacyRefusal(f: Fixture, operationId: string) {
  const path = journalPath(f);
  const journal = JSON.parse(readFileSync(path, "utf8"));
  journal.operations[operationId].handoff = { outcome: "refused", at: REQUESTED };
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
  const first = await ok(f.service({ inFlight: () => false }).execute(actor, f.command()));
  const operationId = first.observation.operationId;
  f.release("refused");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const journal = JSON.parse(readFileSync(journalPath(f), "utf8"));
  assert.deepEqual(journal.operations[operationId].handoff, { outcome: "refused", at: REQUESTED, beforeLaunch: true });

  const evidence = reader(() => proposalLines(f, operationId));
  const again = await ok(f.service({ gateway: false, readLedgerLines: evidence.read }).execute(actor, f.command()));
  assert.deepEqual([again.replayed, again.observation.operationId, again.observation.state], [true, operationId, "refused"]);
  assert.equal(evidence.reads.length, 0);
  assert.equal(f.calls.length, 1);
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
  assert.equal(f.calls.length, 1);
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
  const path = join(f.journalDirectory, readdirSync(f.journalDirectory).find((name) => name.endsWith(".json"))!);
  const journal = JSON.parse(readFileSync(path, "utf8"));
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
  const service = f.service({ readLedgerLines: evidence.read, ledgerReadBoundMs: 20 });
  const first = await ok(service.execute(actor, f.command()));
  assert.equal(first.observation.state, "unknown", "an in-flight hand-off cannot turn a timeout into pending");
  assert.equal(first.observation.proposal, undefined);
  f.target.inspection.head = MOVED;
  const afterMove = await ok(service.execute(actor, f.command()));
  assert.equal(afterMove.observation.state, "unknown", "a moved target cannot override a timeout");
  assert.equal(evidence.reads.length, 2, "each attempt hit the bound");
  const key = createHash("sha256").update(actor).digest("hex");
  acquireInflightLock(join(f.journalDirectory, "locks"), key, { run_id: "after-ledger-timeout" }).release();

  seedLegacyRefusal(f, first.observation.operationId);
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

  const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  const delayedProposal = reader(() => { block(); return proposalLines(f, first.observation.operationId); });
  const late = await ok(f.service({ readLedgerLines: delayedProposal.read, ledgerReadBoundMs: 10 }).execute(actor, f.command()));
  assert.equal(delayedProposal.reads.length, 1);
  assert.equal(late.observation.state, "unknown");
  assert.equal(late.observation.proposal, undefined);
  const lateFailure = reader(() => { block(); throw new Error("late reader failure"); });
  assert.equal((await ok(f.service({ readLedgerLines: lateFailure.read, ledgerReadBoundMs: 10 }).execute(actor, f.command()))).observation.state, "unknown");
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
