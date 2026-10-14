/**
 * src/lib/automation-trigger.ts — W1-T3956: automation-trigger-v1, the named-start registry.
 *
 * The layer ABOVE the existing cadence (W1-T2923) and signed-event wake (W1-T2568) mechanisms, and
 * BELOW the automation-action-v1 execution seam (W1-T3855). It is not a second scheduler: a timer
 * or webhook path keeps reconciling level-triggered and merely SUBMITS a named trigger request
 * here, and a missed event is recovered by the next cadence tick. It answers four questions in one
 * durable contract: what may start this flow, which repository/instance and policy profile apply,
 * what happened to each run, and how do we safely replay or stop it. INVARIANTS (named refusals):
 *  - ONLY REGISTERED WORK STARTS. A trigger names a registered flow whose automation-action-v1
 *    contract and capability grants already exist; an unknown trigger or flow is refused.
 *  - A TRIGGER CARRIES NO AUTHORITY. Its request is a closed whitelist: a command, credential, raw
 *    prompt, or model instruction is refused BY NAME, and any other unnamed field is refused too.
 *  - ONE RUN PER DELIVERY. A repeated idempotency key or delivery id returns the first run.
 *  - BOUNDED. Per-trigger queue and per-concurrency-key in-flight limits refuse excess explicitly.
 *  - HISTORY IS APPEND-ONLY. Every transition appends an event; a terminal run never changes, and a
 *    manual replay is a NEW run linked by `replayOf`.
 *  - UNAVAILABLE STAYS UNAVAILABLE. A profile, ledger, or source that cannot be read refuses or
 *    reads `unknown`; it never becomes an empty success.
 *  - NO BYPASS. The run only records the flow's action contract and its approval policy; executing
 *    that action still goes through automation-action-v1's preflight and human gate.
 *
 * FALSIFIER: test/automation-trigger-{registry,history,replay}.test.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import {
  automationRedactionViolation,
  validateAutomationAction,
  validateAutomationReceipt,
  type AutomationAction,
  type AutomationApprovalPolicy,
} from "./automation-action.js";
import { appendLedger } from "./ledger.js";
import { bearerTokenId, jsonAction, sendJson } from "./panel-actions.js";
import type { Route } from "./service.js";

/** Named once so every record's `version` and every consumer's pin can never drift. */
export const AUTOMATION_TRIGGER_VERSION = "automation-trigger-v1" as const;

/** The three ways a run may start. `webhook` must arrive already authenticated by its adapter. */
export const AUTOMATION_TRIGGER_SOURCES = ["schedule", "webhook", "manual"] as const;
export type AutomationTriggerSource = (typeof AUTOMATION_TRIGGER_SOURCES)[number];

/** A trigger's own activation state. */
export const AUTOMATION_TRIGGER_ACTIVATION_STATES = ["active", "paused"] as const;
export type AutomationTriggerActivationState = (typeof AUTOMATION_TRIGGER_ACTIVATION_STATES)[number];

/** Every state a run can read as. `stale` and `unknown` are DERIVED at read time, never stored. */
export const AUTOMATION_TRIGGER_RUN_STATES = [
  "refused", "queued", "in-progress", "success", "failed", "expired", "cancelled", "stale", "unknown",
] as const;
export type AutomationTriggerRunState = (typeof AUTOMATION_TRIGGER_RUN_STATES)[number];

/** The run states nothing may move a run out of. */
const TERMINAL_STATES: ReadonlySet<AutomationTriggerRunState> = new Set(["refused", "success", "failed", "expired", "cancelled"]);

/** PRIMARY CONTROL: the cap on every id-shaped field. */
export const AUTOMATION_TRIGGER_MAX_ID_CHARS = 160;
/** PRIMARY CONTROL: the cap on a reason or other bounded prose. */
export const AUTOMATION_TRIGGER_MAX_TEXT_CHARS = 320;
/** PRIMARY CONTROL: the largest queue one trigger may declare. */
export const AUTOMATION_TRIGGER_MAX_QUEUE = 100;
/** PRIMARY CONTROL: the largest in-flight bound one trigger may declare. */
export const AUTOMATION_TRIGGER_MAX_IN_FLIGHT = 20;
/** PRIMARY CONTROL: the longest a request may wait before it expires (7 days). */
export const AUTOMATION_TRIGGER_MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
/** BACKSTOP: runs one trigger may hold in this process. A healthy trigger never reaches it inside
 *  one daemon lifetime; reaching it means a source is resubmitting in a loop, so admission stops
 *  (`history-full`) rather than letting the history grow without bound. */
export const AUTOMATION_TRIGGER_MAX_RUNS_PER_TRIGGER = 500;

/** Keys a trigger must never carry, on top of automation-action-v1's prompt/credential/model list. */
export const AUTOMATION_TRIGGER_FORBIDDEN_FIELD_RE =
  /^(?:commands?|cmds?|script|shell|exec|args|argv|env|instructions?|system_?prompt|model_?instructions?)$/i;

/** DST behaviour for a scheduled trigger. Both fire an ambiguous (fall-back) wall time ONCE, at its
 *  first occurrence; they differ only on a non-existent (spring-forward) wall time. */
export type AutomationTriggerDstPolicy = "skip-gap" | "shift-gap";

export type AutomationTriggerActivation =
  | { readonly mode: "schedule"; readonly scheduleId: string; readonly timezone: string; readonly dst: AutomationTriggerDstPolicy }
  | { readonly mode: "webhook"; readonly event: string }
  | { readonly mode: "manual" };

export interface AutomationTriggerScope {
  readonly repo?: string;
  readonly instance?: string;
}

/** An immutable `automation-trigger-v1` definition. Its activation mode never changes after
 *  registration; pause/resume is registry state, not a field here. */
export interface AutomationTriggerDefinition {
  readonly version: typeof AUTOMATION_TRIGGER_VERSION;
  readonly triggerId: string;
  readonly flowId: string;
  readonly activation: AutomationTriggerActivation;
  readonly scope: AutomationTriggerScope;
  /** The environment/policy profile, resolved at EXECUTION time — never cached at registration. */
  readonly profileId: string;
  readonly limits: { readonly maxQueued: number; readonly maxInFlight: number };
  readonly expirySeconds: number;
  /** An in-progress run with no observation for longer than this reads `stale`. */
  readonly staleAfterSeconds: number;
  /** Runs sharing this key share the in-flight bound. Defaults to the triggerId. */
  readonly concurrencyKey: string;
}

/** A registered flow: the automation-action-v1 contract a trigger may start, and its grants. */
export interface AutomationFlow {
  readonly flowId: string;
  readonly action: AutomationAction;
  readonly capabilityGrants: readonly string[];
}

/** The caller-submitted start. A closed whitelist — see {@link validateAutomationTriggerRequest}. */
export interface AutomationTriggerRequest {
  readonly version: typeof AUTOMATION_TRIGGER_VERSION;
  readonly triggerId: string;
  readonly source: AutomationTriggerSource;
  readonly idempotencyKey: string;
  /** The webhook delivery or schedule slot identity; a repeat is a duplicate. */
  readonly deliveryId?: string;
  /** Webhook only: the adapter verified the sender's signature before submitting. */
  readonly verified?: boolean;
  /** Schedule only: the slot this start is for. */
  readonly scheduledFor?: string;
  /** Manual only: the VERIFIED identity of who asked, never a body field. */
  readonly requestedBy?: string;
  readonly requestedAt: string;
  readonly expiresAt?: string;
}

export type AutomationTriggerRunEventKind = "queued" | "refused" | "start-refused" | "started" | "heartbeat" | "success" | "failed" | "expired" | "cancelled";

/** One append-only history entry. */
export interface AutomationTriggerRunEvent {
  readonly kind: AutomationTriggerRunEventKind;
  readonly at: string;
  readonly code?: string;
  readonly reason: string;
  readonly receiptId?: string;
  readonly profile?: { readonly profileId: string; readonly revision: string };
}

/** The immutable header of one bounded run. Its events append; the header never changes. */
export interface AutomationTriggerRunRecord {
  readonly version: typeof AUTOMATION_TRIGGER_VERSION;
  readonly runId: string;
  readonly triggerId: string;
  readonly flowId: string;
  readonly actionId: string;
  readonly approvalPolicy: AutomationApprovalPolicy;
  readonly activationMode: AutomationTriggerActivation["mode"];
  readonly source: AutomationTriggerSource;
  readonly scope: AutomationTriggerScope;
  readonly timezonePolicy?: { readonly timezone: string; readonly dst: AutomationTriggerDstPolicy };
  readonly profileId: string;
  readonly idempotencyKey: string;
  readonly deliveryId?: string;
  readonly scheduledFor?: string;
  readonly requestedBy?: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly concurrencyKey: string;
  /** The run this one replays. The original is never modified. */
  readonly replayOf?: string;
}

/** A run as read: header, every event, and the state/freshness/reason they imply right now. */
export interface AutomationTriggerRunView extends AutomationTriggerRunRecord {
  readonly state: AutomationTriggerRunState;
  readonly code?: string;
  readonly reason: string;
  readonly observedAt: string;
  readonly freshness: { readonly ageSeconds: number; readonly status: "fresh" | "stale" | "unknown" };
  readonly resolvedProfile?: { readonly profileId: string; readonly revision: string };
  readonly receiptId?: string;
  readonly events: readonly AutomationTriggerRunEvent[];
}

/** What a profile resolver answers. `unavailable`/`unknown` never admit a start. */
export type AutomationTriggerProfileResolution =
  | { readonly status: "resolved"; readonly profileId: string; readonly revision: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "unknown"; readonly reason: string };

/** One durable record of a registry write. The journal is written FIRST; a failed write refuses
 *  the operation and leaves memory unchanged. */
export interface AutomationTriggerJournalEntry {
  readonly kind: "flow-registered" | "trigger-registered" | "activation" | "run-event";
  readonly triggerId?: string;
  readonly runId?: string;
  readonly at: string;
  readonly record: unknown;
}

export interface AutomationTriggerRegistryOptions {
  readonly clock?: Clock;
  readonly resolveProfile?: (profileId: string, scope: AutomationTriggerScope) => AutomationTriggerProfileResolution;
  readonly journal?: (entry: AutomationTriggerJournalEntry) => void;
}

interface TriggerSlot {
  readonly definition: AutomationTriggerDefinition;
  activation: AutomationTriggerActivationState;
  activationReason: string;
  activationAt: string;
  sourceObservation?: { readonly status: "available" | "unavailable"; readonly observedAt: string; readonly reason: string };
}

interface RunSlot {
  readonly record: AutomationTriggerRunRecord;
  readonly events: AutomationTriggerRunEvent[];
}

/** The in-process registry. Durable history is whatever {@link AutomationTriggerRegistryOptions.journal}
 *  writes; this object is the bounded working set the daemon serves from. */
export class AutomationTriggerRegistry {
  readonly clock: Clock;
  readonly resolveProfile: (profileId: string, scope: AutomationTriggerScope) => AutomationTriggerProfileResolution;
  readonly journal: (entry: AutomationTriggerJournalEntry) => void;
  readonly flows = new Map<string, AutomationFlow>();
  readonly triggers = new Map<string, TriggerSlot>();
  readonly runs = new Map<string, RunSlot>();
  private sequence = 0;

  constructor(options: AutomationTriggerRegistryOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.resolveProfile = options.resolveProfile ?? (() => ({ status: "unavailable", reason: "no profile resolver is configured" }));
    this.journal = options.journal ?? (() => undefined);
  }

  nextRunId(): string {
    this.sequence += 1;
    return `atr-${String(this.sequence).padStart(6, "0")}`;
  }
}

/** Ledger step prefix every journal entry is written under: `automation_trigger.<kind>`. */
export const AUTOMATION_TRIGGER_LEDGER_STEP_PREFIX = "automation_trigger";

/** The production journal: one daemon-ledger row per registry write, under
 *  {@link AUTOMATION_TRIGGER_LEDGER_STEP_PREFIX}. A failed append throws, which the registry turns
 *  into a `journal-unavailable` refusal — an unwritable ledger never reads as a quiet success. */
export function automationTriggerLedgerJournal(ledgerPath: string, append: typeof appendLedger = appendLedger): (entry: AutomationTriggerJournalEntry) => void {
  return (entry) => append(ledgerPath, {
    run_id: entry.runId ?? `automation-trigger:${entry.triggerId ?? "registry"}`,
    task_id: entry.triggerId ?? "automation-trigger",
    step: `${AUTOMATION_TRIGGER_LEDGER_STEP_PREFIX}.${entry.kind.replace(/-/g, "_")}`,
    version: AUTOMATION_TRIGGER_VERSION,
    at: entry.at,
    record: entry.record,
  });
}

export function createAutomationTriggerRegistry(options: AutomationTriggerRegistryOptions = {}): AutomationTriggerRegistry {
  return new AutomationTriggerRegistry(options);
}

// ── validation ────────────────────────────────────────────────────────────────────────────────

export type AutomationTriggerRefusal = { readonly ok: false; readonly code: string; readonly field?: string; readonly reason: string };

function refusal(code: string, reason: string, field?: string): AutomationTriggerRefusal {
  return { ok: false, code, reason: reason.slice(0, AUTOMATION_TRIGGER_MAX_TEXT_CHARS), ...(field ? { field } : {}) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= AUTOMATION_TRIGGER_MAX_ID_CHARS;
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function iso(value: string): string {
  return fixedClock(Date.parse(value)).iso();
}

function boundedInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** The first trigger-forbidden key anywhere in `value`, as a dotted path. Depth-bounded. */
function findTriggerForbiddenField(value: unknown, path = "", depth = 0): string | undefined {
  if (depth > 8 || !isPlainObject(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (AUTOMATION_TRIGGER_FORBIDDEN_FIELD_RE.test(key)) return childPath;
    const nested = findTriggerForbiddenField(child, childPath, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/** Refuses authority-shaped content BY NAME, then any key outside `allowed`. */
function authorityViolation(value: Record<string, unknown>, allowed: readonly string[]): AutomationTriggerRefusal | undefined {
  const redaction = automationRedactionViolation(value);
  if (redaction) return refusal(redaction.code, `field ${redaction.field} may not enter the automation-trigger contract`, redaction.field);
  const forbidden = findTriggerForbiddenField(value);
  if (forbidden) return refusal("forbidden-field", `field ${forbidden} would carry authority; a trigger may only name a registered flow`, forbidden);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) return refusal("unknown-field", `field ${unknown} is not part of the automation-trigger contract`, unknown);
  return undefined;
}

/** Why `timezone` is not an IANA zone this runtime can resolve, or `undefined` when it is. The
 *  runtime's own RangeError message is the reason; any other error is not a verdict and rethrows. */
export function timezoneProblem(timezone: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return undefined;
  } catch (error) {
    if (error instanceof RangeError) return error.message;
    throw error;
  }
}

function validateActivation(value: unknown): AutomationTriggerActivation | AutomationTriggerRefusal {
  if (!isPlainObject(value)) return refusal("invalid-activation", "activation must be an object naming a mode", "activation");
  if (value.mode === "schedule") {
    if (!boundedId(value.scheduleId)) return refusal("invalid-activation", "a schedule activation names the cadence entry it runs on (scheduleId)", "activation.scheduleId");
    const zoneProblem = typeof value.timezone === "string" ? timezoneProblem(value.timezone) : "timezone is not a string";
    if (zoneProblem !== undefined) return refusal("invalid-timezone", `a schedule activation needs an IANA timezone: ${zoneProblem}`, "activation.timezone");
    if (value.dst !== "skip-gap" && value.dst !== "shift-gap") return refusal("invalid-timezone", "a schedule activation needs a dst policy: skip-gap or shift-gap", "activation.dst");
    return { mode: "schedule", scheduleId: value.scheduleId.trim(), timezone: value.timezone as string, dst: value.dst };
  }
  if (value.mode === "webhook") {
    if (!boundedId(value.event)) return refusal("invalid-activation", "a webhook activation names the event it accepts", "activation.event");
    return { mode: "webhook", event: value.event.trim() };
  }
  if (value.mode === "manual") return { mode: "manual" };
  return refusal("invalid-activation", "activation.mode must be schedule, webhook, or manual", "activation.mode");
}

const DEFINITION_FIELDS = ["version", "triggerId", "flowId", "activation", "scope", "profileId", "limits", "expirySeconds", "staleAfterSeconds", "concurrencyKey"] as const;

/** Validates and deep-freezes a trigger definition. Every refusal names its code and field. */
export function validateAutomationTriggerDefinition(value: unknown): { ok: true; trigger: AutomationTriggerDefinition } | AutomationTriggerRefusal {
  if (!isPlainObject(value)) return refusal("not-an-object", "a trigger definition must be a JSON object");
  const violation = authorityViolation(value, DEFINITION_FIELDS);
  if (violation) return violation;
  if (value.version !== AUTOMATION_TRIGGER_VERSION) return refusal("invalid-version", `version must be ${AUTOMATION_TRIGGER_VERSION}`, "version");
  if (!boundedId(value.triggerId) || !boundedId(value.flowId)) return refusal("missing-identity", "triggerId and flowId are required", "triggerId");
  const activation = validateActivation(value.activation);
  if ("ok" in activation) return activation;
  const scope: { repo?: string; instance?: string } = {};
  if (isPlainObject(value.scope)) {
    for (const field of ["repo", "instance"] as const) if (boundedId(value.scope[field])) scope[field] = value.scope[field].trim();
  }
  if (!scope.repo && !scope.instance) return refusal("missing-scope", "scope must name a repo or an instance", "scope");
  if (!boundedId(value.profileId)) return refusal("missing-profile", "a policy/environment profileId is required", "profileId");
  const limits = isPlainObject(value.limits) ? value.limits : {};
  if (!boundedInt(limits.maxQueued, AUTOMATION_TRIGGER_MAX_QUEUE) || !boundedInt(limits.maxInFlight, AUTOMATION_TRIGGER_MAX_IN_FLIGHT)) {
    return refusal("invalid-limits", `limits.maxQueued 1..${AUTOMATION_TRIGGER_MAX_QUEUE} and limits.maxInFlight 1..${AUTOMATION_TRIGGER_MAX_IN_FLIGHT} are required`, "limits");
  }
  if (!boundedInt(value.expirySeconds, AUTOMATION_TRIGGER_MAX_EXPIRY_SECONDS)) {
    return refusal("invalid-expiry", `expirySeconds must be an integer in 1..${AUTOMATION_TRIGGER_MAX_EXPIRY_SECONDS}`, "expirySeconds");
  }
  if (!boundedInt(value.staleAfterSeconds, AUTOMATION_TRIGGER_MAX_EXPIRY_SECONDS)) {
    return refusal("invalid-staleness", `staleAfterSeconds must be an integer in 1..${AUTOMATION_TRIGGER_MAX_EXPIRY_SECONDS}`, "staleAfterSeconds");
  }
  if (value.concurrencyKey !== undefined && !boundedId(value.concurrencyKey)) return refusal("invalid-limits", "concurrencyKey must be a bounded id", "concurrencyKey");
  const triggerId = value.triggerId.trim();
  return {
    ok: true,
    trigger: deepFreeze({
      version: AUTOMATION_TRIGGER_VERSION,
      triggerId,
      flowId: value.flowId.trim(),
      activation,
      scope,
      profileId: value.profileId.trim(),
      limits: { maxQueued: limits.maxQueued as number, maxInFlight: limits.maxInFlight as number },
      expirySeconds: value.expirySeconds,
      staleAfterSeconds: value.staleAfterSeconds,
      concurrencyKey: typeof value.concurrencyKey === "string" ? value.concurrencyKey.trim() : triggerId,
    }),
  };
}

const REQUEST_FIELDS = ["version", "triggerId", "source", "idempotencyKey", "deliveryId", "verified", "scheduledFor", "requestedBy", "requestedAt", "expiresAt"] as const;

/** Validates a start request. A closed whitelist: authority-shaped keys are refused by name and
 *  every other unnamed key is refused, so nothing can ride along into a run. */
export function validateAutomationTriggerRequest(value: unknown): { ok: true; request: AutomationTriggerRequest } | AutomationTriggerRefusal {
  if (!isPlainObject(value)) return refusal("not-an-object", "a trigger request must be a JSON object");
  const violation = authorityViolation(value, REQUEST_FIELDS);
  if (violation) return violation;
  if (value.version !== AUTOMATION_TRIGGER_VERSION) return refusal("invalid-version", `version must be ${AUTOMATION_TRIGGER_VERSION}`, "version");
  if (!boundedId(value.triggerId)) return refusal("missing-identity", "triggerId is required", "triggerId");
  if (typeof value.source !== "string" || !(AUTOMATION_TRIGGER_SOURCES as readonly string[]).includes(value.source)) {
    return refusal("invalid-source", "source must be schedule, webhook, or manual", "source");
  }
  if (!boundedId(value.idempotencyKey)) return refusal("missing-idempotency-key", "a bounded idempotencyKey is required", "idempotencyKey");
  if (!validInstant(value.requestedAt)) return refusal("invalid-request-time", "requestedAt must be an ISO-8601 instant", "requestedAt");
  for (const field of ["deliveryId", "requestedBy"] as const) {
    if (value[field] !== undefined && !boundedId(value[field])) return refusal("invalid-field", `${field} must be a bounded id`, field);
  }
  for (const field of ["scheduledFor", "expiresAt"] as const) {
    if (value[field] !== undefined && !validInstant(value[field])) return refusal("invalid-field", `${field} must be an ISO-8601 instant`, field);
  }
  if (value.verified !== undefined && typeof value.verified !== "boolean") return refusal("invalid-field", "verified must be a boolean", "verified");
  const source = value.source as AutomationTriggerSource;
  if (source === "webhook" && (value.verified !== true || value.deliveryId === undefined)) {
    return refusal("unauthenticated-webhook", "a webhook start must carry its delivery id and arrive verified by its adapter", "verified");
  }
  if (source === "schedule" && value.scheduledFor === undefined) return refusal("missing-schedule-slot", "a schedule start names the slot it is for", "scheduledFor");
  if (source === "manual" && value.requestedBy === undefined) return refusal("missing-requester", "a manual start names its verified requester", "requestedBy");
  return {
    ok: true,
    request: deepFreeze({
      version: AUTOMATION_TRIGGER_VERSION,
      triggerId: value.triggerId.trim(),
      source,
      idempotencyKey: value.idempotencyKey.trim(),
      ...(value.deliveryId !== undefined ? { deliveryId: (value.deliveryId as string).trim() } : {}),
      ...(value.verified !== undefined ? { verified: value.verified as boolean } : {}),
      ...(value.scheduledFor !== undefined ? { scheduledFor: iso(value.scheduledFor as string) } : {}),
      ...(value.requestedBy !== undefined ? { requestedBy: (value.requestedBy as string).trim() } : {}),
      requestedAt: iso(value.requestedAt),
      ...(value.expiresAt !== undefined ? { expiresAt: iso(value.expiresAt as string) } : {}),
    }),
  };
}

// ── adapters: the existing timer and webhook paths submit through these ──────────────────────

/** The request a cadence tick (W1-T2923) submits for one schedule slot. The slot IS the delivery
 *  identity, so a re-tick of the same slot is a duplicate rather than a second run. */
export function scheduledTriggerRequest(triggerId: string, scheduledFor: string, requestedAt: string): AutomationTriggerRequest {
  const slot = iso(scheduledFor);
  return { version: AUTOMATION_TRIGGER_VERSION, triggerId, source: "schedule", idempotencyKey: `schedule:${slot}`, deliveryId: `schedule:${slot}`, scheduledFor: slot, requestedAt };
}

/** The request the signed-event wake (W1-T2568) submits AFTER verifying the HMAC. Only that
 *  adapter may set `verified`; the HTTP manual route never can. */
export function webhookTriggerRequest(triggerId: string, deliveryId: string, requestedAt: string): AutomationTriggerRequest {
  return { version: AUTOMATION_TRIGGER_VERSION, triggerId, source: "webhook", idempotencyKey: `webhook:${deliveryId}`, deliveryId, verified: true, requestedAt };
}

// ── registry writes ──────────────────────────────────────────────────────────────────────────

/** Writes the journal entry first; a throw refuses the whole operation (`journal-unavailable`). */
function journalFirst(registry: AutomationTriggerRegistry, entry: AutomationTriggerJournalEntry): AutomationTriggerRefusal | undefined {
  try {
    registry.journal(entry);
    return undefined;
  } catch (error) {
    const reason = `the trigger journal could not be written: ${String((error as Error)?.message ?? error)}`;
    return refusal("journal-unavailable", reason);
  }
}

/** Registers a flow a trigger may start: an automation-action-v1 contract scoped to this flow, whose
 *  capability is among the flow's grants. A flow without both is refused, so a trigger can never
 *  be the first thing to grant an action authority. */
export function registerAutomationFlow(
  registry: AutomationTriggerRegistry,
  input: { flowId: string; action: unknown; capabilityGrants: readonly string[] },
): { ok: true; flow: AutomationFlow } | AutomationTriggerRefusal {
  if (!boundedId(input.flowId)) return refusal("missing-identity", "flowId is required", "flowId");
  const validated = validateAutomationAction(input.action);
  if (!validated.ok) return refusal("missing-action-contract", `the flow's action contract is invalid: ${validated.code}`, "action");
  if (validated.action.scope.flowId !== input.flowId) return refusal("missing-action-contract", "the action contract must be scoped to this flowId", "action.scope.flowId");
  if (!Array.isArray(input.capabilityGrants) || !input.capabilityGrants.includes(validated.action.capability)) {
    return refusal("missing-capability-grant", `capability ${validated.action.capability} has no grant for flow ${input.flowId}`, "capabilityGrants");
  }
  const flow = deepFreeze({ flowId: input.flowId, action: validated.action, capabilityGrants: [...input.capabilityGrants] });
  const failed = journalFirst(registry, { kind: "flow-registered", at: registry.clock.iso(), record: flow });
  if (failed) return failed;
  registry.flows.set(flow.flowId, flow);
  return { ok: true, flow };
}

/** Registers a named trigger. Re-registering the SAME definition is idempotent; a different one
 *  under the same id is refused (`trigger-immutable`) — the activation mode never changes. */
export function registerAutomationTrigger(
  registry: AutomationTriggerRegistry,
  input: unknown,
): { ok: true; trigger: AutomationTriggerDefinition; existing: boolean } | AutomationTriggerRefusal {
  const validated = validateAutomationTriggerDefinition(input);
  if (!validated.ok) return validated;
  const { trigger } = validated;
  if (!registry.flows.has(trigger.flowId)) return refusal("unregistered-flow", `flow ${trigger.flowId} is not registered`, "flowId");
  const existing = registry.triggers.get(trigger.triggerId);
  if (existing) {
    if (JSON.stringify(existing.definition) !== JSON.stringify(trigger)) {
      return refusal("trigger-immutable", `trigger ${trigger.triggerId} is already registered with a different definition`, "triggerId");
    }
    return { ok: true, trigger: existing.definition, existing: true };
  }
  const at = registry.clock.iso();
  const failed = journalFirst(registry, { kind: "trigger-registered", triggerId: trigger.triggerId, at, record: trigger });
  if (failed) return failed;
  registry.triggers.set(trigger.triggerId, { definition: trigger, activation: "active", activationReason: "registered", activationAt: at });
  return { ok: true, trigger, existing: false };
}

/** Pauses or resumes a trigger. Pause stops new admission and new starts; running work is left
 *  running and stays visible. */
export function setAutomationTriggerActivation(
  registry: AutomationTriggerRegistry,
  triggerId: string,
  state: AutomationTriggerActivationState,
  reason: string,
): { ok: true; triggerId: string; state: AutomationTriggerActivationState } | AutomationTriggerRefusal {
  const slot = registry.triggers.get(triggerId);
  if (!slot) return refusal("unregistered-trigger", `trigger ${triggerId} is not registered`, "triggerId");
  if (state !== "active" && state !== "paused") return refusal("invalid-activation", "state must be active or paused", "state");
  const bounded = String(reason ?? "").slice(0, AUTOMATION_TRIGGER_MAX_TEXT_CHARS) || state;
  const at = registry.clock.iso();
  const failed = journalFirst(registry, { kind: "activation", triggerId, at, record: { state, reason: bounded } });
  if (failed) return failed;
  slot.activation = state;
  slot.activationReason = bounded;
  slot.activationAt = at;
  return { ok: true, triggerId, state };
}

/** Records what the trigger's external source (scheduler, webhook sender) last looked like, so an
 *  unavailable source reads `unavailable` rather than as a quiet, healthy trigger. */
export function observeAutomationTriggerSource(
  registry: AutomationTriggerRegistry,
  triggerId: string,
  observation: { status: "available" | "unavailable"; reason: string },
): boolean {
  const slot = registry.triggers.get(triggerId);
  if (!slot) return false;
  slot.sourceObservation = { status: observation.status, observedAt: registry.clock.iso(), reason: observation.reason.slice(0, AUTOMATION_TRIGGER_MAX_TEXT_CHARS) };
  return true;
}

function appendEvent(registry: AutomationTriggerRegistry, run: RunSlot, event: AutomationTriggerRunEvent): AutomationTriggerRefusal | undefined {
  const frozen = deepFreeze({ ...event, reason: event.reason.slice(0, AUTOMATION_TRIGGER_MAX_TEXT_CHARS) });
  const failed = journalFirst(registry, { kind: "run-event", triggerId: run.record.triggerId, runId: run.record.runId, at: frozen.at, record: { header: run.record, event: frozen } });
  if (failed) return failed;
  run.events.push(frozen);
  return undefined;
}

/** The STORED state an event list implies (never `stale`/`unknown`, which are read-time). */
function storedState(events: readonly AutomationTriggerRunEvent[]): AutomationTriggerRunState {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const kind = events[index]!.kind;
    if (kind === "heartbeat" || kind === "start-refused") continue;
    if (kind === "started") return "in-progress";
    return kind as AutomationTriggerRunState;
  }
  return "unknown";
}

function runsOf(registry: AutomationTriggerRegistry, triggerId: string): RunSlot[] {
  return [...registry.runs.values()].filter((run) => run.record.triggerId === triggerId);
}

export type AutomationTriggerSubmission =
  | { readonly outcome: "queued"; readonly run: AutomationTriggerRunView }
  | { readonly outcome: "duplicate"; readonly run: AutomationTriggerRunView }
  | { readonly outcome: "refused"; readonly code: string; readonly reason: string; readonly field?: string; readonly run?: AutomationTriggerRunView };

/**
 * THE ONE ENTRY every start takes — schedule, verified webhook, manual, and replay. Validates the
 * request, then refuses by name: an unknown trigger or flow, a source the activation mode does not
 * admit, a paused trigger, an expired request, a full queue, or a full history. A repeated
 * idempotency key or delivery id returns the FIRST run (`duplicate`) and appends nothing. A
 * refusal against a known trigger is recorded as a `refused` run so the history says why.
 */
export function submitAutomationTrigger(registry: AutomationTriggerRegistry, input: unknown, link: { replayOf?: string } = {}): AutomationTriggerSubmission {
  const validated = validateAutomationTriggerRequest(input);
  if (!validated.ok) return { outcome: "refused", code: validated.code, reason: validated.reason, ...(validated.field ? { field: validated.field } : {}) };
  const { request } = validated;
  const slot = registry.triggers.get(request.triggerId);
  if (!slot) return { outcome: "refused", code: "unregistered-trigger", reason: `trigger ${request.triggerId} is not registered` };
  const flow = registry.flows.get(slot.definition.flowId);
  if (!flow) return { outcome: "refused", code: "unregistered-flow", reason: `flow ${slot.definition.flowId} is not registered` };
  const prior = runsOf(registry, request.triggerId);
  const duplicate = prior.find((run) => storedState(run.events) !== "refused"
    && (run.record.idempotencyKey === request.idempotencyKey || (request.deliveryId !== undefined && run.record.deliveryId === request.deliveryId)));
  if (duplicate) return { outcome: "duplicate", run: viewRun(registry, duplicate) };
  if (prior.length >= AUTOMATION_TRIGGER_MAX_RUNS_PER_TRIGGER) {
    return { outcome: "refused", code: "history-full", reason: `trigger ${request.triggerId} holds ${prior.length} runs in this process` };
  }
  const { definition } = slot;
  const nowMs = registry.clock.now();
  const requestedMs = Date.parse(request.requestedAt);
  const ceilingMs = requestedMs + definition.expirySeconds * 1000;
  const expiresMs = request.expiresAt !== undefined ? Math.min(Date.parse(request.expiresAt), ceilingMs) : ceilingMs;
  const record: AutomationTriggerRunRecord = deepFreeze({
    version: AUTOMATION_TRIGGER_VERSION,
    runId: registry.nextRunId(),
    triggerId: definition.triggerId,
    flowId: flow.flowId,
    actionId: flow.action.actionId,
    approvalPolicy: flow.action.approval.policy,
    activationMode: definition.activation.mode,
    source: request.source,
    scope: definition.scope,
    ...(definition.activation.mode === "schedule" ? { timezonePolicy: { timezone: definition.activation.timezone, dst: definition.activation.dst } } : {}),
    profileId: definition.profileId,
    idempotencyKey: request.idempotencyKey,
    ...(request.deliveryId !== undefined ? { deliveryId: request.deliveryId } : {}),
    ...(request.scheduledFor !== undefined ? { scheduledFor: request.scheduledFor } : {}),
    ...(request.requestedBy !== undefined ? { requestedBy: request.requestedBy } : {}),
    requestedAt: request.requestedAt,
    expiresAt: fixedClock(expiresMs).iso(),
    concurrencyKey: definition.concurrencyKey,
    ...(link.replayOf !== undefined ? { replayOf: link.replayOf } : {}),
  });
  const refuse = (code: string, reason: string): AutomationTriggerSubmission => {
    const run: RunSlot = { record, events: [] };
    const failed = appendEvent(registry, run, { kind: "refused", at: registry.clock.iso(), code, reason });
    if (failed) return { outcome: "refused", code: failed.code, reason: failed.reason };
    registry.runs.set(record.runId, run);
    return { outcome: "refused", code, reason, run: viewRun(registry, run) };
  };
  const mode = definition.activation.mode;
  if (request.source !== "manual" && request.source !== mode) {
    return refuse("source-not-permitted", `trigger ${definition.triggerId} is activated by ${mode}; a ${request.source} start is not admitted`);
  }
  if (slot.activation === "paused") return refuse("trigger-paused", `trigger ${definition.triggerId} is paused: ${slot.activationReason}`);
  if (nowMs >= expiresMs) return refuse("request-expired", `the request expired at ${record.expiresAt}`);
  const queued = prior.filter((run) => storedState(run.events) === "queued" && nowMs < Date.parse(run.record.expiresAt)).length;
  if (queued >= definition.limits.maxQueued) return refuse("queue-full", `trigger ${definition.triggerId} already has ${queued} queued runs (limit ${definition.limits.maxQueued})`);
  const run: RunSlot = { record, events: [] };
  const failed = appendEvent(registry, run, { kind: "queued", at: registry.clock.iso(), reason: link.replayOf ? `replay of ${link.replayOf}` : `${request.source} start admitted` });
  if (failed) return { outcome: "refused", code: failed.code, reason: failed.reason };
  registry.runs.set(record.runId, run);
  return { outcome: "queued", run: viewRun(registry, run) };
}

export type AutomationTriggerRunResult =
  | { readonly ok: true; readonly run: AutomationTriggerRunView }
  | { readonly ok: false; readonly code: string; readonly reason: string; readonly run?: AutomationTriggerRunView };

function runRefusal(registry: AutomationTriggerRegistry, run: RunSlot | undefined, code: string, reason: string): AutomationTriggerRunResult {
  return { ok: false, code, reason, ...(run ? { run: viewRun(registry, run) } : {}) };
}

function resolveProfileSafely(registry: AutomationTriggerRegistry, definition: AutomationTriggerDefinition): AutomationTriggerProfileResolution {
  try {
    return registry.resolveProfile(definition.profileId, definition.scope);
  } catch (error) {
    return { status: "unavailable", reason: `profile resolver failed: ${String((error as Error)?.message ?? error)}` };
  }
}

/**
 * Moves a queued run to in-progress. The profile is resolved NOW, at execution time; an unavailable
 * or unknown profile refuses the start and leaves the run queued (the next cadence tick retries).
 * A paused trigger and a full in-flight bound refuse the same way; an expired run is closed.
 */
export function startAutomationTriggerRun(registry: AutomationTriggerRegistry, runId: string): AutomationTriggerRunResult {
  const run = registry.runs.get(runId);
  if (!run) return runRefusal(registry, undefined, "unknown-run", `run ${runId} does not exist`);
  const state = storedState(run.events);
  if (state !== "queued") return runRefusal(registry, run, "not-queued", `run ${runId} is ${state}; only a queued run can start`);
  const slot = registry.triggers.get(run.record.triggerId)!;
  const at = registry.clock.iso();
  const startRefused = (code: string, reason: string): AutomationTriggerRunResult => {
    const failed = appendEvent(registry, run, { kind: "start-refused", at, code, reason });
    return failed ? runRefusal(registry, run, failed.code, failed.reason) : runRefusal(registry, run, code, reason);
  };
  if (registry.clock.now() >= Date.parse(run.record.expiresAt)) {
    const failed = appendEvent(registry, run, { kind: "expired", at, code: "run-expired", reason: `the run expired at ${run.record.expiresAt} before it started` });
    return runRefusal(registry, run, failed?.code ?? "run-expired", failed?.reason ?? `run ${runId} expired before it started`);
  }
  if (slot.activation === "paused") return startRefused("trigger-paused", `trigger ${run.record.triggerId} is paused: ${slot.activationReason}`);
  const inFlight = [...registry.runs.values()].filter((other) => other.record.concurrencyKey === run.record.concurrencyKey && storedState(other.events) === "in-progress").length;
  if (inFlight >= slot.definition.limits.maxInFlight) {
    return startRefused("in-flight-limit", `${inFlight} runs are already in flight for ${run.record.concurrencyKey} (limit ${slot.definition.limits.maxInFlight})`);
  }
  const profile = resolveProfileSafely(registry, slot.definition);
  if (profile.status !== "resolved") return startRefused(`profile-${profile.status}`, profile.reason);
  const failed = appendEvent(registry, run, { kind: "started", at, reason: `started under profile ${profile.profileId}@${profile.revision}`,
    profile: { profileId: profile.profileId, revision: profile.revision } });
  if (failed) return runRefusal(registry, run, failed.code, failed.reason);
  return { ok: true, run: viewRun(registry, run) };
}

/** Records that an in-progress run is still alive, so it does not read `stale`. */
export function heartbeatAutomationTriggerRun(registry: AutomationTriggerRegistry, runId: string, reason = "heartbeat"): AutomationTriggerRunResult {
  const run = registry.runs.get(runId);
  if (!run) return runRefusal(registry, undefined, "unknown-run", `run ${runId} does not exist`);
  if (storedState(run.events) !== "in-progress") return runRefusal(registry, run, "not-in-progress", `run ${runId} is not in progress`);
  const failed = appendEvent(registry, run, { kind: "heartbeat", at: registry.clock.iso(), reason });
  return failed ? runRefusal(registry, run, failed.code, failed.reason) : { ok: true, run: viewRun(registry, run) };
}

/**
 * Closes an in-progress run from the flow's automation-action-v1 COMPLETION receipt — the only
 * evidence a success may claim. The receipt must name this flow's action; `succeeded` closes the
 * run `success`, `failed` closes it `failed`, and anything else is refused. A terminal run is
 * never changed again (`run-terminal`).
 */
export function completeAutomationTriggerRun(registry: AutomationTriggerRegistry, runId: string, receiptInput: unknown): AutomationTriggerRunResult {
  const run = registry.runs.get(runId);
  if (!run) return runRefusal(registry, undefined, "unknown-run", `run ${runId} does not exist`);
  const state = storedState(run.events);
  if (TERMINAL_STATES.has(state)) return runRefusal(registry, run, "run-terminal", `run ${runId} is already ${state}; history is never rewritten`);
  if (state !== "in-progress") return runRefusal(registry, run, "not-in-progress", `run ${runId} is ${state}; only an in-progress run completes`);
  const receipt = validateAutomationReceipt(receiptInput);
  if (!receipt || receipt.kind !== "completion" || (receipt.outcome !== "succeeded" && receipt.outcome !== "failed")) {
    return runRefusal(registry, run, "invalid-receipt", "a run completes only from an automation-action-v1 completion receipt that succeeded or failed");
  }
  if (receipt.actionId !== run.record.actionId) return runRefusal(registry, run, "receipt-mismatch", `receipt names action ${receipt.actionId}, not ${run.record.actionId}`);
  const kind = receipt.outcome === "succeeded" ? "success" : "failed";
  const failed = appendEvent(registry, run, { kind, at: registry.clock.iso(), reason: receipt.reason || kind, receiptId: receipt.receiptId });
  return failed ? runRefusal(registry, run, failed.code, failed.reason) : { ok: true, run: viewRun(registry, run) };
}

/** Cancels a queued or in-progress run. A terminal run is refused (`run-terminal`). */
export function cancelAutomationTriggerRun(registry: AutomationTriggerRegistry, runId: string, reason: string): AutomationTriggerRunResult {
  const run = registry.runs.get(runId);
  if (!run) return runRefusal(registry, undefined, "unknown-run", `run ${runId} does not exist`);
  const state = storedState(run.events);
  if (TERMINAL_STATES.has(state)) return runRefusal(registry, run, "run-terminal", `run ${runId} is already ${state}; history is never rewritten`);
  const failed = appendEvent(registry, run, { kind: "cancelled", at: registry.clock.iso(), reason: reason || "cancelled" });
  return failed ? runRefusal(registry, run, failed.code, failed.reason) : { ok: true, run: viewRun(registry, run) };
}

/**
 * Manual replay: a NEW manual run of the same trigger, linked by `replayOf`, admitted through
 * {@link submitAutomationTrigger} like any other start — so a paused trigger, a full queue, and a
 * duplicate key all refuse it. The original run's header and events are never touched. Only a
 * terminal run can be replayed.
 */
export function replayAutomationTriggerRun(
  registry: AutomationTriggerRegistry,
  runId: string,
  input: { requestedBy: string; idempotencyKey: string },
): AutomationTriggerSubmission {
  const original = registry.runs.get(runId);
  if (!original) return { outcome: "refused", code: "unknown-run", reason: `run ${runId} does not exist` };
  const state = storedState(original.events);
  if (!TERMINAL_STATES.has(state)) return { outcome: "refused", code: "run-not-terminal", reason: `run ${runId} is ${state}; only a finished run can be replayed` };
  return submitAutomationTrigger(registry, {
    version: AUTOMATION_TRIGGER_VERSION,
    triggerId: original.record.triggerId,
    source: "manual",
    idempotencyKey: input.idempotencyKey,
    requestedBy: input.requestedBy,
    requestedAt: registry.clock.iso(),
  }, { replayOf: original.record.runId });
}

// ── read side ────────────────────────────────────────────────────────────────────────────────

/** A run as read right now. `stale`: in progress with no observation inside the trigger's bound.
 *  `unknown`: the latest observation is dated after the reader's clock, so nothing it says can be
 *  trusted. `expired`: still queued past its expiry. Stored events are never altered. */
function viewRun(registry: AutomationTriggerRegistry, run: RunSlot): AutomationTriggerRunView {
  const nowMs = registry.clock.now();
  const events = run.events;
  const last = events[events.length - 1]!;
  const lastMs = Date.parse(last.at);
  const stored = storedState(events);
  const closing = [...events].reverse().find((event) => event.kind !== "heartbeat");
  const started = events.find((event) => event.kind === "started");
  const definition = registry.triggers.get(run.record.triggerId)?.definition;
  const staleAfterMs = (definition?.staleAfterSeconds ?? 0) * 1000;
  let state: AutomationTriggerRunState = stored;
  let reason = closing?.reason ?? last.reason;
  let code = closing?.code;
  if (lastMs > nowMs) {
    state = "unknown";
    code = "observed-in-future";
    reason = `the latest observation (${last.at}) is dated after this read`;
  } else if (stored === "in-progress" && nowMs - lastMs > staleAfterMs) {
    state = "stale";
    code = "no-recent-observation";
    reason = `no observation for ${Math.round((nowMs - lastMs) / 1000)}s (bound ${staleAfterMs / 1000}s)`;
  } else if (stored === "queued" && nowMs >= Date.parse(run.record.expiresAt)) {
    state = "expired";
    code = "run-expired";
    reason = `queued past its expiry at ${run.record.expiresAt}`;
  }
  const ageSeconds = Math.max(0, Math.round((nowMs - lastMs) / 1000));
  const freshness = state === "unknown" ? "unknown" : state === "stale" ? "stale" : "fresh";
  const receiptId = [...events].reverse().find((event) => event.receiptId)?.receiptId;
  return deepFreeze({
    ...run.record,
    state,
    ...(code ? { code } : {}),
    reason,
    observedAt: last.at,
    freshness: { ageSeconds, status: freshness },
    ...(started?.profile ? { resolvedProfile: started.profile } : {}),
    ...(receiptId ? { receiptId } : {}),
    events: events.map((event) => ({ ...event })),
  });
}

export interface AutomationTriggerView {
  readonly trigger: AutomationTriggerDefinition;
  readonly state: AutomationTriggerActivationState;
  readonly reason: string;
  readonly changedAt: string;
  /** What the trigger's external source last looked like; `unknown` when never observed. */
  readonly source: { readonly status: "available" | "unavailable" | "unknown"; readonly observedAt?: string; readonly reason: string };
  readonly queued: number;
  readonly inFlight: number;
}

export interface AutomationTriggerHistory {
  readonly version: typeof AUTOMATION_TRIGGER_VERSION;
  readonly generatedAt: string;
  readonly triggers: readonly AutomationTriggerView[];
  readonly runs: readonly AutomationTriggerRunView[];
}

/** Every trigger and every run in this process, newest run first. */
export function readAutomationTriggerHistory(registry: AutomationTriggerRegistry): AutomationTriggerHistory {
  const runs = [...registry.runs.values()].map((run) => viewRun(registry, run)).reverse();
  const triggers = [...registry.triggers.values()].map((slot): AutomationTriggerView => {
    const own = runs.filter((run) => run.triggerId === slot.definition.triggerId);
    return {
      trigger: slot.definition,
      state: slot.activation,
      reason: slot.activationReason,
      changedAt: slot.activationAt,
      source: slot.sourceObservation
        ? { status: slot.sourceObservation.status, observedAt: slot.sourceObservation.observedAt, reason: slot.sourceObservation.reason }
        : { status: "unknown", reason: "the trigger's source has not been observed in this process" },
      queued: own.filter((run) => run.state === "queued").length,
      inFlight: own.filter((run) => run.state === "in-progress" || run.state === "stale").length,
    };
  });
  return { version: AUTOMATION_TRIGGER_VERSION, generatedAt: registry.clock.iso(), triggers, runs };
}

// ── HTTP surface ─────────────────────────────────────────────────────────────────────────────

/** HTTP status for a submission: 202 queued, 200 duplicate, 404 unknown trigger or run, 503 an
 *  unwritable journal, 400 a malformed request (refused before any run existed), and 409 every
 *  other refusal — each body names its code and reason. */
function submissionStatus(submission: AutomationTriggerSubmission): number {
  if (submission.outcome === "queued") return 202;
  if (submission.outcome === "duplicate") return 200;
  if (submission.code === "unregistered-trigger" || submission.code === "unknown-run") return 404;
  if (submission.code === "journal-unavailable") return 503;
  if (submission.run || ["unregistered-flow", "history-full", "run-not-terminal"].includes(submission.code)) return 409;
  return 400;
}

function closedBody<T extends Record<string, unknown>>(body: unknown, fields: readonly string[]): { error: string } | T {
  if (!isPlainObject(body)) return { error: "body must be a JSON object" };
  const unknown = Object.keys(body).find((key) => !fields.includes(key));
  if (unknown) return { error: `field ${unknown} is not accepted here` };
  return body as T;
}

/**
 * GET /v1/automation/triggers (read), POST /v1/automation/triggers/run, /activation and /replay
 * (write, MIDDLE). Over HTTP only a MANUAL start can enter: the body names a trigger and an
 * idempotency key, and the requester is the verified request identity — never a body field — so a
 * browser cannot claim to be a verified webhook or a scheduler. `submit` is the production
 * assembly's call into {@link submitAutomationTrigger}.
 */
export function buildAutomationTriggerRoutes(input: {
  registry: AutomationTriggerRegistry;
  submit: (request: AutomationTriggerRequest) => AutomationTriggerSubmission;
}): Route[] {
  const { registry, submit } = input;
  const respond = (res: ServerResponse, result: AutomationTriggerSubmission): void => sendJson(res, submissionStatus(result), result);
  return [
    {
      method: "GET",
      path: "/v1/automation/triggers",
      scope: "read",
      handler: (_req: IncomingMessage, res: ServerResponse) => sendJson(res, 200, readAutomationTriggerHistory(registry)),
    },
    {
      method: "POST",
      path: "/v1/automation/triggers/run",
      scope: "write",
      tier: "middle",
      handler: jsonAction((body) => closedBody<{ triggerId: string; idempotencyKey: string }>(body, ["triggerId", "idempotencyKey"]), (input, req, res) => {
        respond(res, submit({
          version: AUTOMATION_TRIGGER_VERSION,
          triggerId: input.triggerId,
          source: "manual",
          idempotencyKey: input.idempotencyKey,
          requestedBy: bearerTokenId(req),
          requestedAt: registry.clock.iso(),
        }));
      }),
    },
    {
      method: "POST",
      path: "/v1/automation/triggers/activation",
      scope: "write",
      tier: "middle",
      handler: jsonAction((body) => closedBody<{ triggerId: string; state: AutomationTriggerActivationState; reason?: string }>(body, ["triggerId", "state", "reason"]), (input, _req, res) => {
        const result = setAutomationTriggerActivation(registry, String(input.triggerId), input.state, String(input.reason ?? ""));
        if (result.ok) sendJson(res, 200, result);
        else sendJson(res, result.code === "unregistered-trigger" ? 404 : result.code === "journal-unavailable" ? 503 : 400, result);
      }),
    },
    {
      method: "POST",
      path: "/v1/automation/triggers/replay",
      scope: "write",
      tier: "middle",
      handler: jsonAction((body) => closedBody<{ runId: string; idempotencyKey: string }>(body, ["runId", "idempotencyKey"]), (input, req, res) => {
        respond(res, replayAutomationTriggerRun(registry, String(input.runId), { requestedBy: bearerTokenId(req), idempotencyKey: input.idempotencyKey }));
      }),
    },
  ];
}
