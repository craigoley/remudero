/**
 * test/helpers/delegation-profile-fixture.ts — W1-T3878: the shared delegation-profile-v1 fixture
 * for the five test/delegation-profile-*.test.ts suites. Time is a fixed, injected clock; every
 * instant a profile or action compares against it is an OFFSET from NOW_MS, never a literal.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fixedClock, type Clock } from "../../src/lib/clock.js";
import { createService } from "../../src/lib/service.js";
import { buildOperatorAgentRoutes } from "../../src/lib/operator-agent.js";
import { validateAutomationAction, type AutomationAction, type AutomationPreconditionObservation } from "../../src/lib/automation-action.js";
import { buildDelegationProfile, type DelegationProfile, type DelegationProfileState } from "../../src/lib/delegation-profile.js";
import { writeLedger } from "./ledger-fixture.js";

export const NOW_MS = Date.parse("2026-09-20T11:00:00.000Z");
export const CLOCK: Clock = fixedClock(NOW_MS);
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const READ_TOKEN = "delegation-profile-read-token";
export const WRITE_TOKEN = "delegation-profile-write-token";
export const DELEGATION_ID = "delegation:owner/repo:flow-runner";

/** The instant `offsetMs` from the fixed now, as ISO-8601. */
export function at(offsetMs: number): string {
  return fixedClock(NOW_MS + offsetMs).iso();
}

export function profileInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    delegationId: DELEGATION_ID,
    principal: "operator:owner",
    purpose: "Run the canary flow's bounded automation actions.",
    link: { flowId: "flow:canary" },
    scope: { kind: "repository", repository: "owner/repo" },
    dataClasses: ["status", "logs", "cost"],
    capabilities: ["deploy.canary"],
    capabilitySummary: "Promote canary builds inside the canary flow.",
    riskTier: "production",
    budget: { costUsd: 25, durationMinutes: 240 },
    notification: "on-refusal",
    approvalLevel: "profile",
    humanDecision: "An operator approves every production promotion.",
    fallbackOwner: "operator:owner",
    expiresAt: at(7 * DAY),
    ...overrides,
  };
}

export function builtProfile(overrides: Record<string, unknown> = {}, clock: Clock = CLOCK): DelegationProfile {
  const built = buildDelegationProfile(profileInput(overrides), { clock });
  assert.ok(built.ok, JSON.stringify(built));
  return built.profile;
}

/** A profile's durable state as the fold would produce it, accepted at the fixed now by default. */
export function stateOf(profile: DelegationProfile, overrides: Partial<DelegationProfileState> = {}): DelegationProfileState {
  return { profile, approval: "approved", decidedAt: at(0), acceptedAt: at(0), spentCostUsd: 0, receipts: [], ...overrides };
}

export function actionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "automation-action-v1",
    actionId: "action:deploy:canary",
    capability: "deploy.canary",
    summary: "Promote the canary build to ten percent of traffic.",
    scope: { flowId: "flow:canary", repo: "owner/repo" },
    risk: "low",
    preconditions: [{ id: "health", source: "ledger:health", description: "The fleet health read is healthy." }],
    freshness: { maxAgeSeconds: 600 },
    idempotencyKey: "idem:deploy:canary:1",
    createdAt: at(-HOUR),
    expiresAt: at(HOUR),
    dryRun: true,
    approval: { policy: "none" },
    rollback: { mode: "reversible", plan: "Route all traffic back to the stable build." },
    receiptRef: "ledger:panel.operator_agent_action_receipt",
    ...overrides,
  };
}

export function validAction(overrides: Record<string, unknown> = {}): AutomationAction {
  const validated = validateAutomationAction(actionBody(overrides));
  assert.ok(validated.ok, JSON.stringify(validated));
  return validated.action;
}

export const HEALTHY: AutomationPreconditionObservation[] = [{ preconditionId: "health", state: "satisfied", source: "ledger:health", observedAt: at(-MINUTE) }];

/** A throwaway state dir's live ledger path (rmd- prefixed temp dir). */
export function tempStatePath(): string {
  return writeLedger().path;
}

export function stepsAt(path: string): string[] {
  const text = readFileSync(path, "utf8").trim();
  return text ? text.split("\n").map((line) => String(JSON.parse(line).step)) : [];
}

export function rowsAt(path: string): Array<Record<string, unknown>> {
  const text = readFileSync(path, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

export async function withDelegationService<T>(path: string, fn: (base: string) => Promise<T>, nowMs = NOW_MS): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: buildOperatorAgentRoutes({ ledgerPath: path, now: fixedClock(nowMs).now }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

export async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function readProfiles(base: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${base}/v1/operator-agent/delegations`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { version: string; source: string; profiles: Array<Record<string, unknown>> };
  assert.equal(body.version, "delegation-profile-v1");
  assert.equal(body.source, "ledger");
  return body.profiles;
}

/** Issues the default profile (with overrides) and accepts it, over HTTP. */
export async function issueAndAccept(base: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const issued = await postJson(base, "/v1/operator-agent/delegations", { profile: profileInput(overrides) });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const id = (issued.body.profile as { delegationId: string }).delegationId;
  const accepted = await postJson(base, "/v1/operator-agent/delegations/decision", { delegationId: id, decision: "accepted" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return id;
}
