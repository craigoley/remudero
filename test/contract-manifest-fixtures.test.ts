import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  automationRedactionViolation,
  executeAutomationAction,
  preflightAutomationAction,
  validateAutomationReceipt,
  type AutomationAction,
  type AutomationActionReceipt,
  type AutomationPreconditionObservation,
} from "../src/lib/automation-action.js";
import { reconcileExternalEffect, redactConnectorEvidence, type ExternalEffectRequest, type ExternalObservation } from "../src/lib/action-reconciliation.js";
import { fixedClock } from "../src/lib/clock.js";

// W1-T3896: the automation-flow-v1 fixture corpus is what the console pins to test its adapter.
// This suite proves it covers ready, refused, stale, unknown, expired, in-progress, pending and
// partial outcomes; that every record is EXACTLY what the named core engine produces for the
// stated input (so a fixture can never describe behaviour core does not have); and that dropping
// the fixtures for any required outcome — a refusal included — fails the validator.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_OUTCOMES = ["ready", "refused", "stale", "unknown", "expired", "in-progress", "pending", "partial"];

interface Fixture {
  id: string;
  covers: string[];
  shape: string;
  engine: "preflightAutomationAction" | "executeAutomationAction" | "reconcileExternalEffect";
  input: {
    now: string;
    actionOverrides?: Partial<AutomationAction>;
    observations?: AutomationPreconditionObservation[];
    receipts?: AutomationActionReceipt[];
    receiptsFrom?: string[];
    request?: Omit<ExternalEffectRequest, "observe" | "now">;
    observation?: ExternalObservation;
  };
  record: Record<string, unknown>;
}
interface Corpus { schemaVersion: string; action: AutomationAction; fixtures: Fixture[] }
interface Validation { ok: boolean; errors: Array<{ code: string; path: string; detail: string }> }

const mod = (await import(pathToFileURL(join(ROOT, "scripts", "validate-contract-manifest.mjs")).href)) as {
  validateContractManifest: (manifest: unknown, options?: { fixtures?: unknown; openapi?: unknown }) => Validation;
  loadContractManifest: (root: string, manifestPath?: string) => { manifest: { fixtureCoverage: Array<{ outcome: string }> }; fixtures: Corpus; openapi: unknown };
};

const loaded = mod.loadContractManifest(ROOT, "contracts/automation-flow-v1.json");
const corpus = loaded.fixtures;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const codes = (result: Validation): string[] => result.errors.map((error) => error.code);

test("the manifest requires, and the corpus covers, every console-facing outcome", () => {
  assert.deepEqual(loaded.manifest.fixtureCoverage.map((entry) => entry.outcome), REQUIRED_OUTCOMES);
  for (const outcome of REQUIRED_OUTCOMES) {
    assert.ok(corpus.fixtures.some((fixture) => fixture.covers.includes(outcome)), `a fixture covers ${outcome}`);
  }
  assert.equal(corpus.schemaVersion, "automation-flow-v1");
  const result = mod.validateContractManifest(loaded.manifest, { fixtures: corpus });
  assert.deepEqual(result.errors, [], "every fixture's claimed coverage is exhibited by its record");
});

test("every fixture record is exactly what its named core engine produces for its input", async () => {
  const produced = new Map<string, unknown>();
  for (const fixture of corpus.fixtures) {
    const { input } = fixture;
    const action: AutomationAction = { ...corpus.action, ...(input.actionOverrides ?? {}) };
    const clock = fixedClock(Date.parse(input.now));
    const receipts = input.receipts ?? (input.receiptsFrom ?? []).map((id) => produced.get(id) as AutomationActionReceipt);
    let record: unknown;
    if (fixture.engine === "preflightAutomationAction") {
      record = preflightAutomationAction({ action, observations: input.observations ?? [], receipts, clock });
    } else if (fixture.engine === "executeAutomationAction") {
      record = executeAutomationAction({ action, observations: input.observations ?? [], receipts, clock }).receipt;
    } else {
      assert.ok(input.request && input.observation, `${fixture.id} names its connector request and observation`);
      const observation = input.observation;
      record = await reconcileExternalEffect({ ...input.request, observe: async () => observation, now: () => new Date(Date.parse(input.now)) });
    }
    assert.deepEqual(JSON.parse(JSON.stringify(record)), fixture.record, `${fixture.id} matches ${fixture.engine}`);
    produced.set(fixture.id, record);
  }
});

test("every fixture is redaction-clean and every receipt fixture passes core's own receipt validator", () => {
  for (const fixture of corpus.fixtures) {
    if (fixture.shape === "ExternalActionResult") {
      assert.deepEqual(redactConnectorEvidence(fixture.record), fixture.record, `${fixture.id} carries nothing to redact`);
    } else {
      assert.equal(automationRedactionViolation(fixture.record), undefined, `${fixture.id} carries no forbidden field or secret value`);
    }
    if (fixture.shape === "AutomationActionReceipt") assert.ok(validateAutomationReceipt(fixture.record), `${fixture.id} is a valid receipt`);
  }
});

test("omitting every fixture for any required outcome — a refusal included — fails the validator by name", () => {
  for (const outcome of REQUIRED_OUTCOMES) {
    const trimmed = clone(corpus);
    trimmed.fixtures = trimmed.fixtures.filter((fixture) => !fixture.covers.includes(outcome));
    const result = mod.validateContractManifest(loaded.manifest, { fixtures: trimmed });
    assert.equal(result.ok, false, `dropping ${outcome} is refused`);
    const missing = result.errors.filter((error) => error.code === "missing-fixture-coverage");
    assert.ok(missing.some((error) => error.detail.includes(`"${outcome}"`)), `the refusal names ${outcome}`);
  }
});

test("a fixture claiming an outcome its record does not exhibit is refused", () => {
  const lying = clone(corpus);
  const ready = lying.fixtures.find((fixture) => fixture.id === "preflight-ready");
  assert.ok(ready);
  ready.covers = ["ready", "refused"];
  assert.ok(codes(mod.validateContractManifest(loaded.manifest, { fixtures: lying })).includes("fixture-coverage-mismatch"));
});

test("a fixture carrying a forbidden field or a credential-shaped value is refused", () => {
  const leaky = clone(corpus);
  const first = leaky.fixtures[0];
  assert.ok(first);
  first.record = { ...first.record, transcript: "the operator said" };
  assert.ok(codes(mod.validateContractManifest(loaded.manifest, { fixtures: leaky })).includes("redaction-violation"));

  const secret = clone(corpus);
  const receipt = secret.fixtures.find((fixture) => fixture.shape === "AutomationActionReceipt");
  assert.ok(receipt);
  receipt.record = { ...receipt.record, reason: "bearer abcdefghijklmnop" };
  assert.ok(codes(mod.validateContractManifest(loaded.manifest, { fixtures: secret })).includes("redaction-violation"));
});
