import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { CanarySlotOwner } from "#src/lib/model-canary-owner.js";
import { buildCanarySchedule, executeCanarySchedule, type CanarySlot, type CanarySchedulePorts } from "#src/lib/model-canary-schedule.js";
import { commonCanarySuite, canarySuiteDigest } from "#src/lib/model-canary-suite.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { readOwnedPrivateTraceReceipt } from "#src/lib/model-canary-owner.js";
import { privateCorpusCases, validatePrivateCorpus,
  type PrivateCanaryBundleV1, type PrivateTraceReceiptV1 } from "#src/lib/model-canary-private-corpus.js";
import { gradePrivateTrace, loadPrivateTraceFromCustody } from "#src/lib/model-canary-trace-grader.js";

type Outcome = Parameters<CanarySchedulePorts["terminal"]>[1];
// A genuinely absent new feature must fail its criterion on base, not become a loader refusal.
const ownerModule = existsSync(new URL("../src/lib/model-canary-owner.ts", import.meta.url))
  ? await import("../src/lib/model-canary-owner.js") : null;
function openOwner(dir: string): CanarySlotOwner {
  assert.ok(ownerModule, "durable canary ownership source is absent");
  return new ownerModule.CanarySlotOwner(dir);
}

function slots() {
  const cases = commonCanarySuite().slice(0, 2);
  return buildCanarySchedule("2026-10-11", "shared-owner", cases,
    [{ model: "test-model", route: "test-route", effort: "medium", suiteHash: canarySuiteDigest(cases), billing: "subscription" }]).slots;
}
function outcome(slot: CanarySlot): Outcome {
  return { state: "unavailable", reason: "transport-error", trace: [], grade: null,
    error: new Error("must-not-retain-arbitrary-error"), run: {
      id: "test-run", caseId: slot.caseId, suiteHash: slot.pin.suiteHash, model: slot.pin.model,
      route: slot.pin.route, effort: slot.pin.effort, family: "structured", verified: null,
      totalDurationMs: 1, attempts: [], outcomeReason: "transport-error" } };
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
function privateTrace(slot: CanarySlot, runId: string): PrivateTraceReceiptV1 {
  const withoutDigest = { version: "private-canary-trace-receipt-v1" as const,
    binding: { version: "private-canary-trace-binding-v1" as const, runId, slotId: slot.id,
      caseId: slot.caseId, suiteHash: slot.pin.suiteHash, corpusDigest: "c".repeat(64), scorerDigest: "d".repeat(64) },
    finalText: "{\"answer\":7}", events: [], complete: true, reason: null };
  return { ...withoutDigest, digest: createHash("sha256").update(canonicalJson(withoutDigest)).digest("hex") };
}
function privateOutcome(slot: CanarySlot): Outcome & { privateTrace: PrivateTraceReceiptV1; privateGrade: Record<string, unknown> } {
  const base = outcome(slot), runId = "94eb1b00-2e11-4b84-8a12-008720fae197";
  return { ...base, state: "scored", reason: "verified", grade: { passed: true, reason: "verified", schemaValid: true },
    run: { ...base.run, id: runId, verified: true, outcomeReason: "verified" }, privateTrace: privateTrace(slot, runId),
    privateGrade: { state: "scored", passed: true, finalPassed: true, tracePassed: true,
      schemaValid: true, reason: "verified" } } as Outcome & { privateTrace: PrivateTraceReceiptV1; privateGrade: Record<string, unknown> };
}
function fixture(action: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-owner-`));
  try { action(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("canary durable owner serializes different slots and retains terminal identity without arbitrary transport errors", () => fixture(dir => {
  const [a, b] = slots(), first = openOwner(dir), second = openOwner(dir);
  try {
    assert.equal(first.claim(a), "claimed");
    assert.equal(second.claim(a), "already-owned-or-terminal");
    assert.throws(() => second.claim(b), /busy-or-capacity/);
    assert.throws(() => second.terminal(a, outcome(a)), /terminal-not-owned/);
    first.terminal(a, outcome(a));
    assert.equal(second.claim(a), "already-owned-or-terminal");
    assert.equal(second.claim(b), "claimed"); second.terminal(b, outcome(b));
    assert.throws(() => first.terminal(a, outcome(a)), /terminal-not-owned/);
    const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT phase,receipt FROM canary_slots_v1").all();
      assert.equal(rows.length, 2); assert.ok(rows.every(r => r.phase === "terminal"));
      assert.ok(rows.every(r => !String(r.receipt).includes("must-not-retain-arbitrary-error")));
      assert.equal(JSON.parse(String(rows[0].receipt)).state, "unavailable");
    } finally { db.close(); }
    assert.equal(statSync(join(dir, "model-canary-slots.sqlite")).mode & 0o777, 0o600);
  } finally { first.close(); second.close(); }
}));

test("canary durable owner refuses changed slot pins and mismatched or oversized terminal records while retaining the claim", () => fixture(dir => {
  const [a, b] = slots(), owner = openOwner(dir);
  try {
    assert.throws(() => owner.claim({ ...a, id: "../escape" }), /slot-invalid/);
    assert.equal(owner.claim(a), "claimed");
    assert.throws(() => owner.claim({ ...a, pin: { ...a.pin, model: "changed" } }), /identity-conflict/);
    const wrong = outcome(a); wrong.run.model = "other";
    assert.throws(() => owner.terminal(a, wrong), /terminal-identity-invalid/);
    const huge = outcome(a); huge.reason = "x".repeat(128 * 1024);
    assert.throws(() => owner.terminal(a, huge), /receipt-bound/);
    assert.throws(() => owner.claim(b), /busy-or-capacity/);
    owner.terminal(a, outcome(a));
  } finally { owner.close(); }
}));

test("canary durable owner keeps a crashed real child claim held across a new process and a new instance", () => fixture(dir => {
  const [a, b] = slots();
  assert.ok(ownerModule, "durable canary ownership source is absent");
  const script = `import {CanarySlotOwner} from './src/lib/model-canary-owner.ts';
    const owner=new CanarySlotOwner(process.argv[1]); console.log(owner.claim(JSON.parse(process.argv[2]))); process.exit(7);`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, dir, JSON.stringify(a)],
    { encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 7, child.stderr); assert.equal(child.stdout.trim(), "claimed");
  const restarted = openOwner(dir);
  try {
    assert.equal(restarted.claim(a), "already-owned-or-terminal");
    assert.throws(() => restarted.claim(b), /busy-or-capacity/);
    assert.throws(() => restarted.terminal(a, outcome(a)), /terminal-not-owned/);
  } finally { restarted.close(); }
}));

test("canary durable owner admits exactly one of concurrent real native children", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-owner-race-`)), [a] = slots();
  try {
    // Initialize schema first; each competing child still opens its own real SQLite connection.
    openOwner(dir).close();
    const script = `import {CanarySlotOwner} from './src/lib/model-canary-owner.ts';
      const owner=new CanarySlotOwner(process.argv[1]); console.log(owner.claim(JSON.parse(process.argv[2]))); owner.close();`;
    const results = await Promise.all(Array.from({ length: 3 }, () => new Promise<string>((done, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, dir, JSON.stringify(a)], { timeout: 15_000 });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
      child.on("error", reject); child.on("close", code => code === 0 ? done(stdout.trim()) : reject(new Error(stderr)));
    })));
    assert.equal(results.filter(r => r === "claimed").length, 1);
    assert.equal(results.filter(r => r === "already-owned-or-terminal").length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("canary durable owner refuses public git symlinked and nonprivate directories", () => fixture(dir => {
  const shared = join(dir, "shared"), linked = join(dir, "linked"), repo = join(dir, "repo");
  mkdirSync(shared, { mode: 0o700 }); symlinkSync(shared, linked);
  assert.throws(() => openOwner(linked), /private-directory-required/);
  chmodSync(shared, 0o755); assert.throws(() => openOwner(shared), /private-directory-required/);
  mkdirSync(repo, { mode: 0o700 }); mkdirSync(join(repo, ".git"));
  assert.throws(() => openOwner(repo), /directory-inside-git/);
  assert.throws(() => openOwner(join(dir, "missing")), /ENOENT/);
}));

test("canary durable owner canonicalizes an ancestor alias while retaining private leaf ownership", () => fixture(dir => {
  const root = join(dir, "real"), alias = join(dir, "alias"), leaf = join(root, "private");
  mkdirSync(root, { mode: 0o700 }); mkdirSync(leaf, { mode: 0o700 }); symlinkSync(root, alias);
  const owner = openOwner(join(alias, "private"));
  try { assert.equal(owner.claim(slots()[0]), "claimed"); }
  finally { owner.close(); }
  assert.equal(statSync(join(leaf, "model-canary-slots.sqlite")).mode & 0o777, 0o600);
}));

test("canary durable owner preserves an actual invalid-schema initialization failure and closes its database", () => fixture(dir => {
  const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
  db.exec("CREATE TABLE canary_slots_v1(id TEXT PRIMARY KEY)"); db.close();
  assert.throws(() => openOwner(dir), /no such column/);
  const reopened = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
  try { assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM canary_slots_v1").get()?.n, 0); }
  finally { reopened.close(); }
}));

test("canary durable owner refuses a full real store without pretending the next slot already ran", () => fixture(dir => {
  openOwner(dir).close();
  const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
  db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000)
    INSERT INTO canary_slots_v1(id,binding,owner,phase) SELECT CAST(i AS TEXT),'test','test','terminal' FROM n`);
  db.close();
  const owner = openOwner(dir);
  try { assert.throws(() => owner.claim(slots()[0]), /busy-or-capacity/); }
  finally { owner.close(); }
}));

test("canary owner reads a private trace only from the matching existing terminal receipt", () => fixture(dir => {
  const [slot] = slots(), owner = openOwner(dir), outcomeWithTrace = privateOutcome(slot);
  try {
    assert.equal(owner.claim(slot), "claimed");
    owner.terminal(slot, outcomeWithTrace);
  } finally { owner.close(); }
  const expected = outcomeWithTrace.privateTrace.binding;
  const loaded = readOwnedPrivateTraceReceipt(dir, slot, expected);
  assert.equal(loaded.state, "available");
  if (loaded.state === "available") {
    assert.equal(loaded.receipt.binding.runId, outcomeWithTrace.run.id);
    assert.equal(loaded.receipt.binding.slotId, slot.id);
    assert.ok(Object.isFrozen(loaded.receipt));
    assert.ok(Object.isFrozen(loaded.receipt.events));
  }
  assert.equal(readOwnedPrivateTraceReceipt(dir, slot, { ...expected, corpusDigest: "e".repeat(64) }).state, "unavailable");
}));

test("native private schedule grades before owner persistence and regrades only verified custody", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-owner-native-`));
  let owner: CanarySlotOwner | undefined;
  try {
    const item = commonCanarySuite()[0]!;
    const bundle: PrivateCanaryBundleV1 = { version: "model-canary-private-bundle-v1", development: {
      version: "model-canary-private-payload-v1", split: "development", cases: [{ item,
        provenance: { sourceFamilyId: "public-development-family", incidentRootId: "public-development-root",
          sourceDigest: "a".repeat(64), observedAt: "2026-11-03T00:00:00.000Z",
          splitId: "dev-native-v1", split: "development", role: "worker" },
        expectedToolTrace: [], scorerVersion: "exact-json-and-application-trace-v1" }],
    } };
    const validated = validatePrivateCorpus(bundle);
    assert.equal(validated.state, "available");
    if (validated.state !== "available") return;
    const cases = privateCorpusCases(validated.corpus)!, suiteHash = canarySuiteDigest(cases);
    const plan = buildCanarySchedule("2026-11-03", "native-owner", cases, ["good", "denied"].map(model => ({
      model, route: "subscription", effort: "low", suiteHash, billing: "subscription" as const,
    })));
    owner = openOwner(dir);
    const saved = new Set<string>(), terminal: Outcome[] = [];
    let requests = 0, admissions = 0;
    const ports: CanarySchedulePorts = {
      eligibility: async () => ({ sourceAdopted: true, adapterQualified: true, productionBusy: false,
        squeeze: false, spareSubscription: true, experimentalCashAllowed: false, premium: false }),
      claim: async slot => owner!.claim(slot),
      ports: slot => ({ monotonicMs: () => 0, admit: async () => { admissions++; return { state: "admitted" }; },
        request: async input => {
          requests++;
          assert.equal(input.prompt, item.prompt);
          assert.deepEqual(input.allowedTools, []);
          return { text: JSON.stringify(item.expected),
            toolCalls: slot.pin.model === "good" ? [] : [{ name: "forbidden", args: { trusted: true, origin: "app" } }],
            resources: { durationMs: 1, firstTextMs: null, generationMs: null, inputTokens: 1, outputTokens: 1,
              cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, usageRatedUsd: null,
              billing: "subscription", servedModel: slot.pin.model, terminal: "complete" } };
        },
        save: async (run, grade) => {
          assert.equal(run.verified, slot.pin.model === "good");
          assert.equal(grade?.passed, run.verified);
          saved.add(run.id);
        } }),
      terminal: async (slot, result) => {
        assert.ok(saved.has(result.run.id));
        assert.equal(result.privateGrade?.state, "scored");
        assert.equal(result.privateTrace?.binding.slotId, slot.id);
        assert.equal(result.privateTrace?.binding.runId, result.run.id);
        owner!.terminal(slot, result); terminal.push(result);
      },
    };
    assert.equal((await executeCanarySchedule(plan, bundle, ports)).completed, 2);
    assert.equal(requests, 2); assert.equal(admissions, 2);
    assert.equal((await executeCanarySchedule(plan, bundle, ports)).skipped, 2);
    assert.equal(requests, 2, "private input never creates a second collector or replay route");
    for (const result of terminal) {
      const receipt = result.privateTrace!, slot = plan.slots.find(row => row.id === receipt.binding.slotId)!;
      const binding = receipt.binding;
      assert.deepEqual(gradePrivateTrace(validated.corpus, slot.caseId, receipt.finalText,
        JSON.parse(JSON.stringify(receipt)), binding),
      { state: "unavailable", reason: "private-trace-capability-unrecognized" });
      const restored = loadPrivateTraceFromCustody(validated.corpus, slot.caseId, binding,
        () => readOwnedPrivateTraceReceipt(dir, slot, binding));
      assert.equal(restored.state, "available");
      if (restored.state === "available")
        assert.deepEqual(gradePrivateTrace(validated.corpus, slot.caseId, restored.finalText, restored.trace, binding),
          result.privateGrade);
      assert.equal(readOwnedPrivateTraceReceipt(dir, slot, { ...binding, scorerDigest: "f".repeat(64) }).state, "unavailable");
    }
  } finally { owner?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("canary owner retains denied observations in incomplete traces only with unavailable grading", () => fixture(dir => {
  const [slot] = slots(), base = outcome(slot), runId = "c0044072-86e2-4b85-b871-3735362cb490";
  const body = { version: "private-canary-trace-receipt-v1" as const,
    binding: { version: "private-canary-trace-binding-v1" as const, runId, slotId: slot.id,
      caseId: slot.caseId, suiteHash: slot.pin.suiteHash, corpusDigest: "c".repeat(64), scorerDigest: "d".repeat(64) },
    finalText: null, events: [{ name: "forbidden", args: {}, result: { denied: true }, denied: true }],
    complete: false, reason: "private-trace-dispatch-unavailable" };
  const trace: PrivateTraceReceiptV1 = { ...body,
    digest: createHash("sha256").update(canonicalJson(body)).digest("hex") };
  const failed = { ...base, state: "scored" as const, reason: "unauthorized-action",
    grade: { passed: false, reason: "unauthorized-action", schemaValid: false },
    run: { ...base.run, id: runId, verified: false, outcomeReason: "unauthorized-action" }, privateTrace: trace,
    privateGrade: { state: "scored", passed: false, finalPassed: null, tracePassed: false,
      schemaValid: false, reason: "unauthorized-action" } } as Outcome & { privateTrace: PrivateTraceReceiptV1; privateGrade: Record<string, unknown> };
  const owner = openOwner(dir);
  try {
    assert.equal(owner.claim(slot), "claimed");
    assert.throws(() => owner.terminal(slot, failed), /private-trace-grade-invalid/);
    owner.terminal(slot, { ...base, run: { ...base.run, id: runId }, privateTrace: trace,
      privateGrade: { state: "unavailable", reason: trace.reason! } });
  }
  finally { owner.close(); }
  const loaded = readOwnedPrivateTraceReceipt(dir, slot, trace.binding);
  assert.equal(loaded.state, "available");
  if (loaded.state === "available") {
    assert.equal(loaded.receipt.complete, false);
    assert.equal(loaded.receipt.events[0]?.denied, true);
  }
  const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
  try {
    const row = db.prepare("SELECT receipt FROM canary_slots_v1 WHERE id=?").get(slot.id) as { receipt: string };
    const stored = JSON.parse(row.receipt);
    assert.equal(stored.run.verified, null); assert.equal(stored.grade, null);
    stored.state = "scored"; stored.run = failed.run;
    stored.grade = failed.grade; stored.reason = failed.reason;
    db.prepare("UPDATE canary_slots_v1 SET receipt=? WHERE id=?").run(JSON.stringify(stored), slot.id);
  } finally { db.close(); }
  assert.deepEqual(readOwnedPrivateTraceReceipt(dir, slot, trace.binding),
    { state: "unavailable", reason: "canary-owner-private-trace-grade-invalid" });
}));

test("canary owner readback rejects stored private-grade disagreement", () => fixture(dir => {
  const [slot] = slots(), owner = openOwner(dir), valid = privateOutcome(slot);
  try { assert.equal(owner.claim(slot), "claimed"); owner.terminal(slot, valid); }
  finally { owner.close(); }
  const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
  try {
    const row = db.prepare("SELECT receipt FROM canary_slots_v1 WHERE id=?").get(slot.id) as { receipt: string };
    const stored = JSON.parse(row.receipt) as { grade: { reason: string } };
    stored.grade.reason = "different-reason";
    db.prepare("UPDATE canary_slots_v1 SET receipt=? WHERE id=?").run(JSON.stringify(stored), slot.id);
  } finally { db.close(); }
  assert.equal(readOwnedPrivateTraceReceipt(dir, slot, valid.privateTrace.binding).state, "unavailable");
}));

test("canary owner readback refuses an unavailable run carrying a stored grade", () => fixture(dir => {
  const [slot] = slots(), owner = openOwner(dir), base = outcome(slot);
  const trace = privateTrace(slot, base.run.id);
  const unavailable = { ...base, privateTrace: trace,
    privateGrade: { state: "unavailable" as const, reason: base.reason } };
  try { assert.equal(owner.claim(slot), "claimed"); owner.terminal(slot, unavailable); }
  finally { owner.close(); }
  const control = readOwnedPrivateTraceReceipt(dir, slot, trace.binding);
  assert.equal(control.state, "available");
  if (control.state === "available") assert.equal(control.receipt.binding.runId, base.run.id);
  const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
  try {
    const row = db.prepare("SELECT receipt FROM canary_slots_v1 WHERE id=?").get(slot.id) as { receipt: string };
    const stored = JSON.parse(row.receipt) as { grade: unknown };
    assert.equal(stored.grade, null);
    stored.grade = { passed: true, reason: "verified", schemaValid: true };
    db.prepare("UPDATE canary_slots_v1 SET receipt=? WHERE id=?").run(JSON.stringify(stored), slot.id);
  } finally { db.close(); }
  assert.deepEqual(readOwnedPrivateTraceReceipt(dir, slot, trace.binding),
    { state: "unavailable", reason: "canary-owner-private-trace-unavailable-grade-invalid" });
}));

test("canary owner preserves legacy receipt shape and refuses tampered private traces", () => fixture(dir => {
  const [legacySlot, tracedSlot] = slots(), owner = openOwner(dir);
  try {
    assert.equal(owner.claim(legacySlot), "claimed"); owner.terminal(legacySlot, outcome(legacySlot));
    assert.equal(owner.claim(tracedSlot), "claimed");
    owner.terminal(tracedSlot, privateOutcome(tracedSlot));
  } finally { owner.close(); }
  const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
  try {
    const rows = db.prepare("SELECT id,receipt FROM canary_slots_v1 ORDER BY id").all() as { id: string; receipt: string }[];
    const legacy = JSON.parse(rows.find(row => row.id === legacySlot.id)!.receipt) as Record<string, unknown>;
    assert.deepEqual(Object.keys(legacy), ["slot", "run", "grade", "state", "reason"]);
    const row = rows.find(value => value.id === tracedSlot.id)!;
    const parsed = JSON.parse(row.receipt) as { privateTrace: { finalText: string } };
    parsed.privateTrace.finalText = "tampered";
    db.prepare("UPDATE canary_slots_v1 SET receipt=? WHERE id=?").run(JSON.stringify(parsed), tracedSlot.id);
  } finally { db.close(); }
  const runId = "94eb1b00-2e11-4b84-8a12-008720fae197";
  assert.equal(readOwnedPrivateTraceReceipt(dir, tracedSlot, privateTrace(tracedSlot, runId).binding).state, "unavailable");
}));

test("canary owner requires private, legacy, and run grades to agree", () => {
  const mutations: Array<(value: ReturnType<typeof privateOutcome>) => void> = [
    value => { value.state = "unknown" as typeof value.state; },
    value => { value.reason = "different-reason"; },
    value => { value.run.outcomeReason = "different-reason"; },
    value => { value.grade!.reason = "different-reason"; },
    value => { value.grade!.schemaValid = false; },
    value => { value.privateGrade.passed = false; },
    value => { value.privateGrade.finalPassed = false; },
    value => { value.privateGrade.tracePassed = false; },
    value => { value.privateGrade.reason = "different-reason"; },
    value => { value.privateGrade.schemaValid = false; },
  ];
  for (const mutate of mutations) fixture(dir => {
    const [slot] = slots(), owner = openOwner(dir), valid = privateOutcome(slot);
    try {
      assert.equal(owner.claim(slot), "claimed");
      const invalid = structuredClone(valid);
      mutate(invalid);
      assert.throws(() => owner.terminal(slot, invalid), /canary-owner-(terminal-identity|private-trace-grade)-invalid/);
      owner.terminal(slot, valid);
    } finally { owner.close(); }
  });
});

test("canary owner readback refuses a passed grade with a denied event or contradictory state", () => fixture(dir => {
  const [deniedSlot, stateSlot] = slots(), owner = openOwner(dir);
  try {
    for (const slot of [deniedSlot, stateSlot]) {
      assert.equal(owner.claim(slot), "claimed"); owner.terminal(slot, privateOutcome(slot));
    }
  } finally { owner.close(); }
  const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
  try {
    for (const slot of [deniedSlot, stateSlot]) {
      const row = db.prepare("SELECT receipt FROM canary_slots_v1 WHERE id=?").get(slot.id) as { receipt: string };
      const stored = JSON.parse(row.receipt) as { state: string; privateTrace: Record<string, unknown> & { digest: string } };
      if (slot.id === deniedSlot.id) {
        stored.privateTrace.events = [{ name: "forbidden", args: {}, result: { denied: true }, denied: true }];
        const body = Object.fromEntries(Object.entries(stored.privateTrace).filter(([key]) => key !== "digest"));
        stored.privateTrace.digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
      } else stored.state = "unavailable";
      db.prepare("UPDATE canary_slots_v1 SET receipt=? WHERE id=?").run(JSON.stringify(stored), slot.id);
    }
  } finally { db.close(); }
  const deniedRun = "94eb1b00-2e11-4b84-8a12-008720fae197";
  const stateRun = "94eb1b00-2e11-4b84-8a12-008720fae197";
  assert.equal(readOwnedPrivateTraceReceipt(dir, deniedSlot, privateTrace(deniedSlot, deniedRun).binding).state, "unavailable");
  assert.equal(readOwnedPrivateTraceReceipt(dir, stateSlot, privateTrace(stateSlot, stateRun).binding).state, "unavailable");
}));

test("canary owner readonly trace reads never create or repair an owner database", () => fixture(dir => {
  const absentDir = join(dir, "not-created");
  assert.equal(readOwnedPrivateTraceReceipt(absentDir, slots()[0], {
    version: "private-canary-trace-binding-v1", runId: "run", slotId: slots()[0].id,
    caseId: slots()[0].caseId, suiteHash: slots()[0].pin.suiteHash,
    corpusDigest: "c".repeat(64), scorerDigest: "d".repeat(64),
  }).state, "unavailable");
  assert.equal(existsSync(absentDir), false);

  mkdirSync(absentDir, { mode: 0o700 });
  const slot = slots()[0];
  assert.equal(readOwnedPrivateTraceReceipt(absentDir, slot, {
    version: "private-canary-trace-binding-v1", runId: "run", slotId: slot.id,
    caseId: slot.caseId, suiteHash: slot.pin.suiteHash,
    corpusDigest: "c".repeat(64), scorerDigest: "d".repeat(64),
  }).state, "unavailable");
  assert.equal(existsSync(join(absentDir, "model-canary-slots.sqlite")), false);
}));
