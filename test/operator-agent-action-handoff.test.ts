import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { executeCatalogueAction } from "../src/lib/action-executor.js";

import {
  ACTION_HANDOFF_VERSION,
  actionHandoffPaths,
  executeActionHandoff,
  prepareActionHandoff,
  type ActionHandoffConfig,
} from "../src/lib/operator-agent-action-handoff.js";
import { fixedClock } from "../src/lib/clock.js";
import { isPaused, isStopped } from "../src/lib/fleet-control.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const ACTOR = "operator:alice";
const T0 = Date.parse("2026-09-30T12:00:00.000Z");

function fixture(overrides: Partial<ActionHandoffConfig> = {}): { deps: ActionHandoffConfig; root: string; done: () => void } {
  const seeded = writeLedger();
  const root = seeded.dir;
  mkdirSync(join(root, "state"), { recursive: true });
  const deps: ActionHandoffConfig = {
    root, claimRoot: root, ledgerPath: seeded.path,
    instance: "core", repository: "owner/repo", clock: fixedClock(T0), ...overrides,
  };
  return { deps, root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function appendedRows(path: string): Array<Record<string, unknown>> {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

const intent = (intentId: string, verb = "fleet.pause") => ({ intentId, verb, instance: "core", repository: "owner/repo" });

test("a prepared action is typed, allowlisted, instance-scoped, non-mutating, and names target, tier, consequence, expiry, recovery", () => {
  const { deps, root, done } = fixture();
  try {
    const prepared = prepareActionHandoff(deps, ACTOR, intent("intent-prepare-01"));
    assert.equal(prepared.status, 201);
    const preview = prepared.body as Record<string, any>;
    assert.equal(preview.version, ACTION_HANDOFF_VERSION);
    assert.equal(preview.version, "action-handoff-v1");
    assert.equal(preview.verb, "fleet.pause");
    assert.equal(preview.capability, "rmd.fleet.pause");
    assert.deepEqual(preview.target, { kind: "fleet-control", instance: "core", repository: "owner/repo", state: { paused: false, stopped: false } });
    assert.equal(preview.tier, "middle");
    assert.deepEqual(preview.consequence.risk, "medium");
    assert.equal(preview.consequence.reversible, true);
    assert.equal(preview.recovery.verb, "fleet.resume");
    assert.equal(preview.recovery.capability, "rmd.fleet.resume");
    assert.equal(preview.preparedAt, new Date(T0).toISOString());
    assert.ok(Date.parse(preview.expiresAt) > T0 && Date.parse(preview.expiresAt) - T0 <= 10 * 60_000, "the preview expires within a bounded window");
    assert.match(preview.confirmationId, /^[0-9a-f-]{36}$/);
    assert.equal(preview.mutated, false);
    assert.equal(preview.confirmation, "explicit-operator-confirmation-required");
    assert.equal(isPaused(root), false, "prepare performs no target mutation");
    assert.deepEqual(appendedRows(deps.ledgerPath), [], "prepare appends no ledger row");

    const resume = prepareActionHandoff(deps, ACTOR, intent("intent-prepare-02", "fleet.resume"));
    assert.equal(resume.status, 201);
    assert.equal((resume.body as Record<string, any>).recovery.verb, "fleet.pause");
  } finally {
    done();
  }
});

test("only the reversible allowlist prepares: high-tier, irreversible, and unknown verbs are unavailable in v1", () => {
  const { deps, root, done } = fixture();
  try {
    for (const verb of ["task.kick", "pr.review", "pr.repair", "fleet.stop"]) {
      const refused = prepareActionHandoff(deps, ACTOR, intent(`intent-excluded-${verb}`, verb));
      assert.equal((refused.body as Record<string, unknown>).outcome, "refused", verb);
      assert.ok(["excluded_in_v1", "unknown_verb"].includes(String((refused.body as Record<string, unknown>).code)), verb);
    }
    assert.equal((prepareActionHandoff(deps, ACTOR, intent("intent-excluded-kick", "task.kick")).body as Record<string, unknown>).code, "excluded_in_v1");
    assert.equal((prepareActionHandoff(deps, ACTOR, intent("intent-unknown-01", "shell.exec")).body as Record<string, unknown>).code, "unknown_verb");
    assert.equal(isPaused(root) || isStopped(root), false);
    assert.equal(existsSync(actionHandoffPaths(deps, "x".repeat(36)).dir), false, "a refused intent stores no preparation");
  } finally {
    done();
  }
});

test("repeated assistant intent has one action and one receipt", () => {
  const { deps, root, done } = fixture();
  try {
    const first = prepareActionHandoff(deps, ACTOR, intent("intent-repeat-01"));
    const again = prepareActionHandoff(deps, ACTOR, intent("intent-repeat-01"));
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    const confirmationId = (first.body as Record<string, string>).confirmationId;
    assert.equal((again.body as Record<string, string>).confirmationId, confirmationId, "a repeated intent names the same single action");
    assert.equal((again.body as Record<string, unknown>).existing, true);
    const changed = prepareActionHandoff(deps, ACTOR, intent("intent-repeat-01", "fleet.resume"));
    assert.equal(changed.status, 409);
    assert.equal((changed.body as Record<string, unknown>).code, "intent_conflict");

    const confirm = { confirmationId, confirm: true, verb: "fleet.pause", instance: "core", repository: "owner/repo" } as const;
    const executed = executeActionHandoff(deps, ACTOR, confirm);
    assert.equal(executed.status, 200);
    const receipt = executed.body as Record<string, any>;
    assert.equal(receipt.outcome, "succeeded");
    assert.equal(receipt.version, "action-handoff-v1");
    assert.equal(receipt.actorHash.length, 64, "the receipt attributes the operator by hash");
    assert.match(receipt.evidenceRef, /^ledger:panel\.pause_requested@/);
    assert.ok(isPaused(root));

    const replay = executeActionHandoff(deps, ACTOR, confirm);
    assert.equal(replay.status, 409);
    assert.equal((replay.body as Record<string, unknown>).code, "replayed");
    assert.deepEqual((replay.body as Record<string, unknown>).receipt, receipt, "the replay names the one stored receipt");

    const rows = appendedRows(deps.ledgerPath);
    assert.equal(rows.filter((row) => row.step === "panel.pause_requested").length, 1, "one governed verb ran");
    assert.equal(rows.filter((row) => row.step === "operator_agent.action_handoff_receipt").length, 1, "one attributable receipt");
  } finally {
    done();
  }
});

test("ambiguous external outcomes remain unresolved, never success-shaped", () => {
  const { deps, root, done } = fixture();
  const lostDeps: ActionHandoffConfig = { ...deps, execute: () => { throw new Error("socket hang up after dispatch"); } };
  try {
    const refusedPreview = prepareActionHandoff(lostDeps, ACTOR, intent("intent-lost-00"));
    assert.equal(refusedPreview.status, 503, "a policy check that cannot answer is not a preview");
    assert.equal((refusedPreview.body as Record<string, unknown>).outcome, "refused");
    const prepared = prepareActionHandoff(deps, ACTOR, intent("intent-lost-01"));
    const confirmationId = (prepared.body as Record<string, string>).confirmationId;
    const confirm = { confirmationId, confirm: true, verb: "fleet.pause", instance: "core", repository: "owner/repo" } as const;
    const lost = executeActionHandoff(lostDeps, ACTOR, confirm);
    assert.equal(lost.status, 202);
    assert.equal((lost.body as Record<string, unknown>).outcome, "unresolved");
    assert.match(String((lost.body as Record<string, unknown>).reason), /socket hang up/);
    const replay = executeActionHandoff(lostDeps, ACTOR, confirm);
    assert.equal(replay.status, 409);
    assert.equal(((replay.body as Record<string, any>).receipt).outcome, "unresolved", "a replay never upgrades an unresolved outcome");
    assert.equal(isPaused(root), false);

    // A claim with no durable receipt (a crash between claim and receipt) is unresolved on replay.
    const second = prepareActionHandoff(deps, ACTOR, intent("intent-lost-02"));
    const secondId = (second.body as Record<string, string>).confirmationId;
    writeFileSync(actionHandoffPaths(deps, secondId).claim, JSON.stringify({ at: "crashed" }));
    const crashed = executeActionHandoff(deps, ACTOR, { ...confirm, confirmationId: secondId });
    assert.equal(crashed.status, 409);
    assert.equal((crashed.body as Record<string, unknown>).outcome, "unresolved");
    assert.equal((crashed.body as Record<string, unknown>).code, "replayed");
  } finally {
    done();
  }
});

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const intentFile = (deps: ActionHandoffConfig, intentId: string): string =>
  join(actionHandoffPaths(deps, "").dir, `${sha(`${sha(ACTOR)}:${intentId}`)}.intent.json`);
const preparedFiles = (deps: ActionHandoffConfig): string[] => readdirSync(actionHandoffPaths(deps, "").dir).filter((name) => name.endsWith(".prepared.json"));
/** A dry-run policy check that lets the store race happen between the intent lookup and the write. */
const racing = (deps: ActionHandoffConfig, race: () => void): ActionHandoffConfig =>
  ({ ...deps, execute: (request) => { if (request.dryRun) race(); return executeCatalogueAction(request); } });

test("a concurrent prepare of the same intent resolves to the first preview and leaves no orphan preparation", () => {
  const { deps, done } = fixture();
  try {
    const first = prepareActionHandoff(deps, ACTOR, intent("intent-race-a01"));
    const firstId = (first.body as Record<string, string>).confirmationId;
    const loser = prepareActionHandoff(racing(deps, () => writeFileSync(intentFile(deps, "intent-race-b01"), JSON.stringify({ confirmationId: firstId }))), ACTOR, intent("intent-race-b01"));
    assert.equal(loser.status, 200);
    assert.equal((loser.body as Record<string, unknown>).confirmationId, firstId, "the loser is handed the winner's preview");
    assert.equal((loser.body as Record<string, unknown>).existing, true);
    assert.equal(preparedFiles(deps).length, 1, "the losing attempt's preparation is removed");
  } finally {
    done();
  }
});

test("a concurrent prepare whose winning intent record is unreadable is refused, not thrown", () => {
  const { deps, done } = fixture();
  try {
    prepareActionHandoff(deps, ACTOR, intent("intent-race-a02"));
    const loser = prepareActionHandoff(racing(deps, () => writeFileSync(intentFile(deps, "intent-race-b02"), "{not json")), ACTOR, intent("intent-race-b02"));
    assert.equal(loser.status, 503);
    assert.equal((loser.body as Record<string, unknown>).outcome, "refused");
    assert.equal((loser.body as Record<string, unknown>).code, "store_unavailable");
    assert.match(String((loser.body as Record<string, unknown>).detail), /concurrent preview is unreadable/);
    assert.equal(preparedFiles(deps).length, 1, "the losing attempt's preparation is removed");
  } finally {
    done();
  }
});

test("a preview that cannot be stored is refused with store_unavailable and never handed out", () => {
  const { deps, done } = fixture();
  try {
    const blocked = prepareActionHandoff(racing(deps, () => writeFileSync(actionHandoffPaths(deps, "").dir, "not a directory")), ACTOR, intent("intent-store-01"));
    assert.equal(blocked.status, 503);
    assert.equal((blocked.body as Record<string, unknown>).outcome, "refused");
    assert.equal((blocked.body as Record<string, unknown>).code, "store_unavailable");
    assert.match(String((blocked.body as Record<string, unknown>).detail), /preview could not be stored/);
    assert.equal((blocked.body as Record<string, unknown>).confirmationId, undefined);
  } finally {
    done();
  }
});

test("a receipt that cannot be made durable is reported unresolved, never success-shaped", () => {
  const { deps, root, done } = fixture();
  try {
    const prepared = prepareActionHandoff(deps, ACTOR, intent("intent-receipt-01"));
    const confirmationId = (prepared.body as Record<string, string>).confirmationId;
    const lostReceipt: ActionHandoffConfig = { ...deps, execute: (request) => {
      if (!request.dryRun) mkdirSync(actionHandoffPaths(deps, confirmationId).receipt);
      return executeCatalogueAction(request);
    } };
    const result = executeActionHandoff(lostReceipt, ACTOR, { confirmationId, confirm: true, verb: "fleet.pause", instance: "core", repository: "owner/repo" });
    assert.equal(result.status, 503);
    assert.equal((result.body as Record<string, unknown>).outcome, "unresolved");
    assert.match(String((result.body as Record<string, unknown>).detail), /receipt not durable/);
    assert.ok(isPaused(root), "the governed verb ran; the lost receipt is reported honestly rather than as success");
    assert.equal(appendedRows(deps.ledgerPath).filter((row) => row.step === "operator_agent.action_handoff_receipt").length, 0);
  } finally {
    done();
  }
});

test("a delegated refusal after confirmation is recorded as a refused receipt, not a success", () => {
  const { deps, root, done } = fixture();
  try {
    const prepared = prepareActionHandoff(deps, ACTOR, intent("intent-policy-01", "fleet.resume"));
    assert.equal(prepared.status, 201);
    const confirmationId = (prepared.body as Record<string, string>).confirmationId;
    // The governed verb's own policy is re-run at execute; its refusal becomes the receipt's outcome.
    const refused = executeActionHandoff({ ...deps, execute: (request) => ({ disposition: "refused", receipt: { version: "automation-action-v1", receiptId: "r-1", actionId: request.action.actionId, idempotencyKey: request.action.idempotencyKey, kind: "execution", outcome: "refused", at: new Date(T0).toISOString(), receiptRef: request.action.receiptRef, code: "stop-active", reason: "a fleet STOP is active" } }) },
      ACTOR, { confirmationId, confirm: true, verb: "fleet.resume", instance: "core", repository: "owner/repo" });
    assert.equal(refused.status, 409);
    assert.equal((refused.body as Record<string, unknown>).outcome, "refused");
    assert.equal((refused.body as Record<string, unknown>).code, "policy_refused");
    assert.equal(isPaused(root) || isStopped(root), false);
    assert.equal(appendedRows(deps.ledgerPath).filter((row) => row.step === "operator_agent.action_handoff_receipt").length, 1);
  } finally {
    done();
  }
});
