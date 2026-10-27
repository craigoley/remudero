import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, fstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { PRODUCT_EVALUATION_LIMITS, ProductEvaluationService, evaluateProductImprovement, productEvaluationCommandSchema } from "#src/lib/product-evaluation.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const actor = "clerk:alice";
const V = { objectiveVersion: "objective-1", evaluatorVersion: "evaluator-1" };
const REF = "https://example.com/replays/1";

function fixture(t: TestContext, options: { envelope?: boolean; sync?: (fd: number) => void } = {}) {
  const root = ownedFixtureDir(t, "product-evaluation").dir;
  const intents = new ProductIntentStore({ root });
  const saved = intents.write(actor, { version: "product-intent-v1", requestId: "eval-product-0000001", expectedRevision: 0,
    brief: { idea: "private idea", name: "Wreckterra", ...(options.envelope === false ? {} : { resourceEnvelope: { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true } }) } });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  const service = new ProductEvaluationService({ root, store: intents, clock: fixedClock(Date.parse("2026-10-27T10:00:00.000Z")), sync: options.sync });
  const command = (over: Record<string, unknown> = {}) => {
    const current = intents.read(actor, productId); assert.ok(current.ok);
    return { version: "product-evaluation-v1", requestId: "eval-request-0000001", productId,
      expectedRevision: current.value.revision, expectedObjectiveRevision: current.value.objectiveRevision,
      objective: V, baseline: V, candidate: V,
      holdouts: [
        { kind: "geography", id: "central-park", baseline: 0.5, candidate: 0.6 },
        { kind: "device", id: "phone-small", baseline: 0.7, candidate: 0.7 },
      ],
      evidence: [{ channel: "replay", reference: REF }],
      proposal: { summary: "tighten the skirmish pacing", pullRequests: 1, costUsd: 5 }, ...over };
  };
  const directory = join(root, "state/products/v1/evaluations");
  return { root, intents, service, productId, command, directory, journal: () => readdirSync(directory).filter((name) => name.endsWith(".json")) };
}
const holdouts = (...cells: Array<[string, string, number | null, number | null]>) =>
  cells.map(([kind, id, baseline, candidate]) => ({ kind, id, baseline, candidate }));

test("W1-T10619: product evaluation refuses changed objectives and failed holdouts", (t) => {
  const f = fixture(t);
  const ok = f.service.execute(actor, f.command());
  assert.ok(ok.ok);
  assert.equal(ok.value.receipt.verdict, "reviewable");
  assert.equal(ok.value.receipt.objective.objectiveVersion, "objective-1");
  assert.equal(ok.value.receipt.confidence, 1);

  const changedObjective = f.service.execute(actor, f.command({ requestId: "eval-request-0000002", candidate: { ...V, objectiveVersion: "objective-2" } }));
  assert.deepEqual(changedObjective, { ok: false, code: "objective_changed" });
  const changedEvaluator = f.service.execute(actor, f.command({ requestId: "eval-request-0000003", baseline: { ...V, evaluatorVersion: "evaluator-2" } }));
  assert.deepEqual(changedEvaluator, { ok: false, code: "objective_changed" });
  const refusedCommand = f.command({ requestId: "eval-request-0000004",
    holdouts: holdouts(["geography", "central-park", 0.5, 0.6], ["device", "phone-small", 0.7, 0.69]) });
  const regressed = f.service.execute(actor, refusedCommand);
  assert.deepEqual(regressed, { ok: false, code: "holdout_failed" });
  const stale = f.service.execute(actor, f.command({ requestId: "eval-request-0000005", expectedRevision: 1 }));
  assert.deepEqual(stale, { ok: false, code: "stale_revision" });

  // A refusal is a durable failure, never an erased one, and it replays identically.
  const history = f.service.history(actor, f.productId);
  assert.ok(history.ok);
  assert.deepEqual(history.value.map((entry) => entry.verdict), ["reviewable", "refused", "refused", "refused"]);
  assert.deepEqual(history.value.map((entry) => entry.refusal), [undefined, "objective_changed", "objective_changed", "holdout_failed"]);
  assert.deepEqual(f.service.execute(actor, { ...refusedCommand }), { ok: false, code: "holdout_failed" });
  const stored = f.intents.read(actor, f.productId);
  assert.ok(stored.ok);
  assert.deepEqual(stored.value.stageEvidence.map((item) => [item.stage, item.outcome]),
    [["improve", "proposed"], ["improve", "failed"], ["improve", "failed"], ["improve", "failed"]]);
});

test("W1-T10619: missing device and geography measurements remain unknown", (t) => {
  const f = fixture(t);
  const missing = f.service.execute(actor, f.command({ holdouts: holdouts(["geography", "central-park", 0.5, null], ["device", "phone-small", null, null]) }));
  assert.ok(missing.ok);
  assert.equal(missing.value.receipt.verdict, "unknown");
  assert.deepEqual(missing.value.receipt.coverage, { geography: "unknown", device: "unknown" });
  assert.deepEqual(missing.value.receipt.holdouts.map((cell) => [cell.outcome, cell.baseline, cell.candidate]), [["unknown", 0.5, null], ["unknown", null, null]]);
  assert.equal(missing.value.receipt.confidence, 0, "nothing measured means no confidence, not a pass");

  // A kind with no held-out cell at all is also unknown: absence is never coverage.
  const noDevice = f.service.execute(actor, f.command({ requestId: "eval-request-0000002", expectedRevision: 2,
    holdouts: holdouts(["geography", "central-park", 0.5, 0.5]) }));
  assert.ok(noDevice.ok);
  assert.deepEqual(noDevice.value.receipt.coverage, { geography: "held", device: "unknown" });
  assert.equal(noDevice.value.receipt.verdict, "unknown");
  assert.equal(noDevice.value.receipt.confidence, 1);
  const stored = f.intents.read(actor, f.productId);
  assert.ok(stored.ok);
  assert.deepEqual(stored.value.stageEvidence.map((item) => item.outcome), ["unknown", "unknown"]);
  // Bots and replays never stand in for human or physical-device acceptance.
  assert.deepEqual(noDevice.value.receipt.acceptance, { humanFun: "unverified", recognizableGeography: "unverified", originality: "unverified", physicalDevice: "unverified" });
  // A real regression outranks a missing measurement elsewhere.
  assert.deepEqual(f.service.execute(actor, f.command({ requestId: "eval-request-0000003", expectedRevision: 3,
    holdouts: holdouts(["geography", "a", 0.5, 0.1], ["device", "b", null, null]) })), { ok: false, code: "holdout_failed" });
});

test("W1-T10619: improvement proposals preserve bounded authority and history", (t) => {
  const f = fixture(t);
  const firstCommand = f.command();
  const first = f.service.execute(actor, firstCommand);
  assert.ok(first.ok);
  assert.equal(first.value.replayed, false);
  assert.equal(first.value.receipt.executionAuthority, "none");
  assert.equal(first.value.receipt.autoDeploy, false);
  assert.equal(first.value.receipt.deployed, false);
  assert.equal(first.value.receipt.proposal.state, "proposed");
  const replay = f.service.execute(actor, firstCommand);
  assert.deepEqual(replay.ok && replay.value, { receipt: first.value.receipt, replayed: true }, "a retry returns the original receipt");
  assert.deepEqual(f.service.execute(actor, { ...firstCommand, proposal: { summary: "different", pullRequests: 1, costUsd: 5 } }), { ok: false, code: "idempotency_conflict" });

  const second = f.service.execute(actor, f.command({ requestId: "eval-request-0000002", expectedRevision: 2, proposal: { summary: "second proposal", pullRequests: 2, costUsd: 30 } }));
  assert.ok(second.ok);
  const history = f.service.history(actor, f.productId);
  assert.ok(history.ok);
  assert.deepEqual(history.value.map((entry) => entry.operationId), [first.value.receipt.operationId, second.value.receipt.operationId]);
  assert.deepEqual(history.value[0], first.value.receipt, "the earlier proposal is preserved unchanged");

  // Authority is bounded: spend above the product envelope, more pull requests than allowed and any
  // authority-widening field are refused, and refused requests record nothing.
  const before = readFileSync(join(f.directory, f.journal()[0]!), "utf8");
  assert.deepEqual(f.service.execute(actor, f.command({ requestId: "eval-request-0000003", expectedRevision: 3, proposal: { summary: "x", pullRequests: 1, costUsd: 30.01 } })), { ok: false, code: "budget_exceeded" });
  assert.deepEqual(f.service.execute(actor, f.command({ requestId: "eval-request-0000004", expectedRevision: 3, proposal: { summary: "x", pullRequests: PRODUCT_EVALUATION_LIMITS.pullRequests + 1, costUsd: 1 } })), { ok: false, code: "invalid_input" });
  for (const widened of [{ autoDeploy: true }, { executionAuthority: "deploy" }, { budgetUsd: 500 }]) {
    assert.deepEqual(f.service.execute(actor, f.command({ requestId: "eval-request-0000005", expectedRevision: 3, ...widened })), { ok: false, code: "invalid_input" });
  }
  assert.deepEqual(f.service.execute(actor, f.command({ requestId: "eval-request-0000006", expectedRevision: 3, proposal: { summary: "x", pullRequests: 1, costUsd: 1 }, evidence: [{ channel: "replay", reference: "http://example.com/plain" }] })), { ok: false, code: "invalid_input" });
  assert.equal(readFileSync(join(f.directory, f.journal()[0]!), "utf8"), before, "refusals leave the journal byte-identical");

  // Without a resource envelope the product has granted no spend at all.
  const bare = fixture(t, { envelope: false });
  assert.deepEqual(bare.service.execute(actor, bare.command()), { ok: false, code: "budget_exceeded" });
  assert.ok(bare.service.execute(actor, bare.command({ proposal: { summary: "free", pullRequests: 0, costUsd: 0 } })).ok);

  // Ownership: another principal can neither see nor extend this history.
  assert.deepEqual(f.service.execute("clerk:bob", f.command({ requestId: "eval-request-0000007" })), { ok: false, code: "not_found" });
  assert.deepEqual(f.service.history("clerk:bob", f.productId), { ok: false, code: "not_found" });
  assert.deepEqual(f.service.execute("  ", f.command()), { ok: false, code: "invalid_identity" });
  assert.deepEqual(f.service.history("  ", f.productId), { ok: false, code: "invalid_identity" });
  assert.deepEqual(f.service.history(actor, "nope"), { ok: false, code: "invalid_input" });
  assert.equal(statSync(join(f.directory, f.journal()[0]!)).mode & 0o777, 0o600);
  assert.equal(statSync(f.directory).mode & 0o077, 0);
});

test("W1-T10619: evaluation durability faults are explicit, never fabricated successes", (t) => {
  const f = fixture(t);
  assert.ok(f.service.execute(actor, f.command()).ok);
  const file = join(f.directory, f.journal()[0]!);

  // corrupt journal
  writeFileSync(file, "{not json", { mode: 0o600 });
  assert.deepEqual(f.service.execute(actor, f.command({ requestId: "eval-request-0000002", expectedRevision: 2 })), { ok: false, code: "corrupt" });
  writeFileSync(file, JSON.stringify({ version: "product-evaluation-v1", ownerKey: "0".repeat(64), operations: {} }), { mode: 0o600 });
  assert.deepEqual(f.service.history(actor, f.productId), { ok: false, code: "corrupt" });
  // a wider-than-private journal is refused rather than trusted
  chmodSync(file, 0o644);
  assert.deepEqual(f.service.execute(actor, f.command({ requestId: "eval-request-0000002", expectedRevision: 2 })), { ok: false, code: "unavailable" });
  chmodSync(file, 0o600);

  // a concurrent writer holds the owner lock
  const g = fixture(t);
  assert.ok(g.service.execute(actor, g.command()).ok);
  const lock = acquireInflightLock(join(g.directory, "locks"), createHash("sha256").update(actor).digest("hex"), { run_id: "held-elsewhere" });
  try {
    assert.deepEqual(g.service.execute(actor, g.command({ requestId: "eval-request-0000002", expectedRevision: 2 })), { ok: false, code: "busy" });
  } finally { lock.release(); }

  // missing root
  assert.deepEqual(new ProductEvaluationService({}).execute(actor, g.command()), { ok: false, code: "unavailable" });
});

test("W1-T10619: evaluation commit failures leave no journal and unknown outcomes are reported", (t) => {
  let phase: "ok" | "before-rename" | "after-rename" = "ok";
  let journalFile = () => false;
  const f = fixture(t, { sync: (fd) => {
    const directory = fstatSync(fd).isDirectory();
    if (phase === "before-rename" && !directory) throw new Error("fsync failed");
    if (phase === "after-rename" && directory && journalFile()) throw new Error("directory fsync failed");
  } });
  journalFile = () => f.journal().length > 0;
  phase = "before-rename";
  assert.deepEqual(f.service.execute(actor, f.command()), { ok: false, code: "unavailable" });
  assert.deepEqual(f.journal(), [], "no journal survives a failure before the rename");
  assert.deepEqual(readdirSync(f.directory).filter((name) => name.endsWith(".pending")), [], "the staged file is discarded");
  phase = "after-rename";
  assert.deepEqual(f.service.execute(actor, f.command()), { ok: false, code: "outcome_unknown" });
  phase = "ok";
  const retried = f.service.execute(actor, f.command());
  assert.ok(retried.ok);
  assert.equal(retried.value.replayed, true, "the identical command reconciles to the one durable receipt");
  const stored = f.intents.read(actor, f.productId);
  assert.ok(stored.ok);
  assert.equal(stored.value.stageEvidence.length, 1);
  assert.ok(existsSync(join(f.directory, f.journal()[0]!)));
});

test("W1-T10619: evaluation capacity and schema guards are enforced", (t) => {
  const f = fixture(t);
  assert.equal(productEvaluationCommandSchema.safeParse(f.command({ holdouts: [] })).success, false);
  assert.equal(productEvaluationCommandSchema.safeParse(f.command({ holdouts: holdouts(["device", "a", 0.1, 0.1], ["device", "a", 0.1, 0.1]) })).success, false, "duplicate cells are ambiguous");
  assert.equal(productEvaluationCommandSchema.safeParse(f.command({ holdouts: holdouts(["device", "a", 1.5, 0.1]) })).success, false);
  const parsed = productEvaluationCommandSchema.parse(f.command());
  const product = f.intents.read(actor, f.productId);
  assert.ok(product.ok);
  assert.throws(() => evaluateProductImprovement(parsed, product.value, "bogus", "0".repeat(64), "2026-10-27T10:00:00.000Z"), /operationId|invalid/i);
  const big = f.command({ evidence: Array.from({ length: 16 }, (_, index) => ({ channel: "bot", reference: `https://example.com/${"a".repeat(1000)}${index}` })) });
  assert.deepEqual(f.service.execute(actor, big), { ok: false, code: "invalid_input" });
});
