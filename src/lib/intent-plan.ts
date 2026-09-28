/**
 * src/lib/intent-plan.ts — W1-T3898: TURN A CONVERSATION INTO A BOUNDED PLAN.
 *
 * An `intent-plan-v1` envelope is the reviewable middle between an operator's sentence and an
 * automation-action-v1 request (W1-T3855): the requested outcome, constraints, known facts and
 * their sources, unresolved questions, proposed bounded steps, consequence class, scope, budget,
 * required approval, expiry, idempotency key, and each step's linked undo or refusal path.
 *
 * A SENTENCE IS NEVER AUTHORITY. Research over the goal only NARROWS (an explicitly named
 * repository, a stated spend ceiling); steps come only from a structured producer; a body claiming
 * approval, confirmation, or model confidence is refused; nothing here registers or executes.
 * CLARIFICATION reuses W1-T2499's discipline: research first, ask only what research left open,
 * deduplicate, never ask one question twice, and stop at its DEFAULT_MAX_ROUNDS.
 * A PREVIEW is non-operative and keeps expired, unavailable, stale, ambiguous, refused and
 * over-budget distinct. CONFIRMATION derives the linked actions but reports `awaiting-receipt`
 * until their durable receipts exist; UNDO is a new linked event (a withdrawal, a rollback request,
 * or a recorded refusal), never a write to the plan or to any receipt.
 *
 * Pure: no I/O, time only through `Clock`. operator-agent.ts ledgers what this decides.
 */

import { createHash } from "node:crypto";
import {
  AUTOMATION_ACTION_MAX_FRESHNESS_SECONDS,
  AUTOMATION_ACTION_MAX_ID_CHARS,
  AUTOMATION_ACTION_MAX_TEXT_CHARS,
  AUTOMATION_ACTION_VERSION,
  automationRedactionViolation,
  delegationRequiresHumanGate,
  validateAutomationAction,
  type AutomationAction,
  type AutomationActionPrecondition,
  type AutomationActionReceipt,
  type AutomationActionRollback,
  type AutomationActionState,
  type AutomationApprovalPolicy,
  type AutomationPreflightFinding,
  type DelegationRiskTier,
} from "./automation-action.js";
import { fixedClock, type Clock } from "./clock.js";
import { DELEGATION_PROFILE_MAX_COST_USD, delegationEligibility, findNonAuthoritativeSignal, type DelegationProfileState } from "./delegation-profile.js";
import { DEFAULT_MAX_ROUNDS } from "./reply-interpreter.js";

/** Named once so a record's own `version` and every consumer's pin can never drift. */
export const INTENT_PLAN_VERSION = "intent-plan-v1" as const;
export const INTENT_PLAN_LEDGER_STEP = "panel.operator_agent_intent_plan";
export const INTENT_PLAN_EVENT_LEDGER_STEP = "panel.operator_agent_intent_plan_event";

/** PRIMARY CONTROL: the requested-outcome sentence's cap — the console bounds `goal` the same. */
export const INTENT_PLAN_MAX_GOAL_CHARS = 4_000;
/** PRIMARY CONTROL: one clarification answer's cap — the console bounds `answer` the same. */
export const INTENT_PLAN_MAX_ANSWER_CHARS = 2_000;
/** PRIMARY CONTROL: an operator's decision note — the console bounds `note` the same. */
export const INTENT_PLAN_MAX_NOTE_CHARS = 1_000;
/** PRIMARY CONTROL: how many constraints or supplied facts one plan may carry. */
export const INTENT_PLAN_MAX_LIST = 12;
/** PRIMARY CONTROL: how many bounded steps one plan may propose. */
export const INTENT_PLAN_MAX_STEPS = 4;
/** PRIMARY CONTROL: clarification rounds per plan — W1-T2499's own bound, reused, never re-chosen. */
export const INTENT_PLAN_MAX_ROUNDS = DEFAULT_MAX_ROUNDS;
/** PRIMARY CONTROL: producer-supplied questions. With the two built-in rules, every question a
 *  plan can ask fits inside {@link INTENT_PLAN_MAX_ROUNDS}. */
export const INTENT_PLAN_MAX_SUPPLIED_QUESTIONS = DEFAULT_MAX_ROUNDS - 2;
/** PRIMARY CONTROL: the longest a plan stays confirmable (seven days). */
export const INTENT_PLAN_MAX_TTL_MINUTES = 7 * 24 * 60;
export const INTENT_PLAN_DEFAULT_TTL_MINUTES = 24 * 60;
export const INTENT_PLAN_DEFAULT_FRESHNESS_SECONDS = 60 * 60;
/** BACKSTOP: events one plan may accumulate. A healthy plan writes a handful (a few answers, one
 *  confirmation, an undo or two); reaching this means a caller is looping, so nothing more appends. */
export const INTENT_PLAN_MAX_EVENTS = 100;
/** PRIMARY CONTROL: the caller-supplied idempotency key, short enough that `<key>:step-N` still
 *  fits an automation-action id field. */
export const INTENT_PLAN_MAX_KEY_CHARS = 140;

/** A body key claiming the approval a sentence never carries — refused wherever it is nested. */
export const INTENT_PLAN_AUTHORITY_FIELD_RE =
  /^(?:approved|approvals?|confirmed|confirmations?|authori[sz](?:ed|ations?)|permissions?|granted|consent(?:ed)?)$/i;
/** An EXPLICIT repository reference in a goal: `repo owner/name`, `repository owner/name`, or a
 *  github.com URL. A bare `a/b` is not one — `and/or` and `src/x.ts` must never become a scope. */
export const INTENT_PLAN_REPO_MENTION_RE = /(?:\brepo(?:sitory)?:?\s+`?|github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{0,99}[A-Za-z0-9_-])/i;
/** An EXPLICIT spend ceiling in a goal ("at most $20", "under $5", "budget of $100"). */
export const INTENT_PLAN_SPEND_MENTION_RE = /\b(?:at most|under|up to|no more than|max(?:imum)?(?: of)?|budget(?: of)?|ceiling(?: of)?|cap(?: of)?)\s+\$\s?(\d{1,5}(?:\.\d{1,2})?)(?!\d|\.\d)/i;
/** A scope answer: one `owner/name` repository (optionally prefixed `repo`), or `instance <id>`. */
export const INTENT_PLAN_SCOPE_ANSWER_RE =
  /^(?:(?:repo(?:sitory)?:?\s+)?([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{0,99}[A-Za-z0-9_-])|instance:?\s+([A-Za-z0-9][A-Za-z0-9_.:-]{0,159}))\.?$/i;
/** A ceiling answer: one dollar amount. */
export const INTENT_PLAN_USD_ANSWER_RE = /^\$?\s?(\d{1,5}(?:\.\d{1,2})?)\s*(?:usd|dollars)?\.?$/i;

export interface IntentPlanScope {
  readonly repo?: string;
  readonly instance?: string;
  /** The flow the plan's actions join; defaults to the plan id, so a delegation can link to it. */
  readonly flowId?: string;
}

/** A known fact and its source. `goal` facts are research over the sentence itself. */
export interface IntentPlanFact {
  readonly statement: string;
  readonly source: string;
  readonly observedAt: string;
  readonly availability: "available" | "unavailable";
}

export interface IntentPlanQuestionSpec {
  readonly id: string;
  readonly question: string;
}

/** One proposed bounded step: an automation-action-v1 draft minus the ids, times, and approval the
 *  plan derives. Its approval policy is DERIVED from its risk and rollback, never supplied. */
export interface IntentPlanStep {
  readonly stepId: string;
  readonly capability: string;
  readonly summary: string;
  readonly risk: DelegationRiskTier;
  readonly preconditions: readonly AutomationActionPrecondition[];
  readonly freshness: { readonly maxAgeSeconds: number };
  readonly dryRun: boolean;
  readonly rollback: AutomationActionRollback;
  readonly receiptRef: string;
  readonly estimatedCostUsd: number;
  readonly approvalPolicy: AutomationApprovalPolicy;
}

export type IntentPlanConsequenceClass = "financial" | "irreversible";

/** An `intent-plan-v1` record. Immutable: answers, confirmation, and undo append linked events. */
export interface IntentPlan {
  readonly version: typeof INTENT_PLAN_VERSION;
  readonly planId: string;
  readonly outcome: string;
  readonly constraints: readonly string[];
  readonly facts: readonly IntentPlanFact[];
  readonly research: { readonly repositories: readonly string[]; readonly ceilingsUsd: readonly number[] };
  readonly questions: readonly IntentPlanQuestionSpec[];
  readonly steps: readonly IntentPlanStep[];
  readonly scope: IntentPlanScope;
  readonly delegationId?: string;
  readonly consequence: { readonly riskTiers: readonly DelegationRiskTier[]; readonly classes: readonly IntentPlanConsequenceClass[]; readonly summary: string };
  readonly budget: { readonly estimatedUsd: number; readonly ceilingUsd?: number };
  readonly approval: { readonly confirmation: "operator"; readonly humanGatedSteps: readonly string[] };
  readonly freshness: { readonly maxAgeSeconds: number };
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly proposedBy: string;
  readonly preview: { readonly operative: false };
  readonly undo: ReadonlyArray<{ readonly stepId: string; readonly mode: AutomationActionRollback["mode"]; readonly path: string }>;
}

export type IntentPlanBuildCode =
  | "not-an-object"
  | "forbidden-field"
  | "secret-value"
  | "non-authoritative-signal"
  | "authority-claim"
  | "unknown-field"
  | "missing-outcome"
  | "invalid-constraints"
  | "invalid-facts"
  | "invalid-questions"
  | "invalid-steps"
  | "invalid-scope"
  | "invalid-budget"
  | "invalid-freshness"
  | "invalid-expiry"
  | "invalid-idempotency-key";

export type IntentPlanBuild =
  | { readonly ok: true; readonly plan: IntentPlan }
  | { readonly ok: false; readonly code: IntentPlanBuildCode; readonly field: string; readonly reason: string };

const RISK_ORDER: readonly DelegationRiskTier[] = ["low", "medium", "high", "production", "financial", "credential", "destructive"];
const INPUT_FIELDS: ReadonlySet<string> = new Set(["goal", "constraints", "facts", "questions", "steps", "scope", "delegationId", "budget", "freshness", "expiresInMinutes", "idempotencyKey"]);
const STEP_FIELDS: ReadonlySet<string> = new Set(["capability", "summary", "risk", "preconditions", "freshness", "dryRun", "rollback", "receiptRef", "estimatedCostUsd"]);
const BUILT_IN_QUESTION_IDS: ReadonlySet<string> = new Set(["scope", "budget-ceiling"]);
const HUMAN_GATE_CODE = "delegation-human-gate-required";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function boundedUsd(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= DELEGATION_PROFILE_MAX_COST_USD;
}

/** The first key anywhere in `value` that `re` matches, as a dotted path. Depth-bounded. */
function findKey(value: unknown, re: RegExp, path = "", depth = 0): string | undefined {
  if (depth > 8 || typeof value !== "object" || value === null) return undefined;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  for (const [key, child] of entries) {
    const childPath = path ? `${path}.${key}` : key;
    if (!Array.isArray(value) && re.test(key)) return childPath;
    const nested = findKey(child, re, childPath, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function textList(value: unknown, maxItems: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => bounded(item, AUTOMATION_ACTION_MAX_TEXT_CHARS))) return null;
  return value.map((item: string) => item.trim());
}

function validateFacts(value: unknown, createdMs: number): IntentPlanFact[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > INTENT_PLAN_MAX_LIST) return null;
  const facts: IntentPlanFact[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || !bounded(item.statement, AUTOMATION_ACTION_MAX_TEXT_CHARS) || !bounded(item.source, AUTOMATION_ACTION_MAX_ID_CHARS)) return null;
    // A fact dated after the plan could never age, so it could never read stale: refused.
    if (!validInstant(item.observedAt) || Date.parse(item.observedAt) > createdMs) return null;
    const availability = item.availability ?? "available";
    if (availability !== "available" && availability !== "unavailable") return null;
    facts.push({ statement: item.statement.trim(), source: item.source.trim(), observedAt: fixedClock(Date.parse(item.observedAt)).iso(), availability });
  }
  return facts;
}

/** Supplied questions, DEDUPLICATED by id and by normalised text before the bound applies. */
function validateQuestions(value: unknown): IntentPlanQuestionSpec[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > INTENT_PLAN_MAX_LIST) return null;
  const ids = new Set<string>(BUILT_IN_QUESTION_IDS);
  const texts = new Set<string>();
  const out: IntentPlanQuestionSpec[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || !bounded(item.id, AUTOMATION_ACTION_MAX_ID_CHARS) || !bounded(item.question, AUTOMATION_ACTION_MAX_TEXT_CHARS)) return null;
    const id = item.id.trim();
    const text = item.question.trim().toLowerCase().replace(/\s+/g, " ");
    if (ids.has(id) || texts.has(text)) continue;
    ids.add(id);
    texts.add(text);
    out.push({ id, question: item.question.trim() });
  }
  return out.length <= INTENT_PLAN_MAX_SUPPLIED_QUESTIONS ? out : null;
}

function validateScope(value: unknown): IntentPlanScope | null {
  if (value === undefined) return {};
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "repo" && key !== "instance" && key !== "flowId")) return null;
  const scope: { repo?: string; instance?: string; flowId?: string } = {};
  for (const field of ["repo", "instance", "flowId"] as const) {
    if (value[field] === undefined) continue;
    if (!bounded(value[field], AUTOMATION_ACTION_MAX_ID_CHARS)) return null;
    scope[field] = value[field].trim();
  }
  return scope;
}

function stepApprovalPolicy(risk: DelegationRiskTier, rollback: AutomationActionRollback): AutomationApprovalPolicy {
  return delegationRequiresHumanGate(risk) || rollback.mode === "irreversible" ? "human" : "none";
}

/** One step, validated by the automation-action-v1 validator itself over a probe envelope, so a
 *  step can never carry a field the action contract would refuse at confirmation. */
function validateStep(value: unknown, stepId: string): IntentPlanStep | string {
  if (!isPlainObject(value)) return "a step must be a JSON object";
  const unknown = Object.keys(value).find((key) => !STEP_FIELDS.has(key));
  if (unknown) return `field ${unknown} is not a step field; approval is derived, never supplied`;
  const cost = value.estimatedCostUsd ?? 0;
  if (!boundedUsd(cost)) return `estimatedCostUsd must be a number in 0..${DELEGATION_PROFILE_MAX_COST_USD}`;
  const probe = validateAutomationAction({
    ...value,
    version: AUTOMATION_ACTION_VERSION,
    actionId: stepId,
    scope: { flowId: stepId, repo: stepId },
    idempotencyKey: stepId,
    createdAt: fixedClock(0).iso(),
    expiresAt: fixedClock(1).iso(),
    approval: { policy: "human" },
  });
  if (!probe.ok) return `${probe.code}: ${probe.reason}`;
  const { capability, summary, risk, preconditions, freshness, dryRun, rollback, receiptRef } = probe.action;
  return { stepId, capability, summary, risk, preconditions, freshness, dryRun, rollback, receiptRef, estimatedCostUsd: cost, approvalPolicy: stepApprovalPolicy(risk, rollback) };
}

function distinctMatches(goal: string, re: RegExp): string[] {
  const all = [...goal.matchAll(new RegExp(re.source, "gi"))].map((match) => match[1]!);
  return [...new Set(all)].slice(0, INTENT_PLAN_MAX_LIST);
}

function consequenceOf(steps: readonly IntentPlanStep[], estimatedUsd: number): IntentPlan["consequence"] {
  const riskTiers = RISK_ORDER.filter((tier) => steps.some((step) => step.risk === tier));
  const irreversible = steps.filter((step) => step.rollback.mode === "irreversible" || step.risk === "destructive").length;
  const classes: IntentPlanConsequenceClass[] = [];
  if (estimatedUsd > 0 || riskTiers.includes("financial")) classes.push("financial");
  if (irreversible > 0) classes.push("irreversible");
  const summary = steps.length === 0
    ? "no bounded step proposed yet; nothing can run from this plan"
    : `${steps.length} bounded step(s); risk ${riskTiers.join("/")}; ${irreversible} irreversible; estimated $${estimatedUsd}`;
  return { riskTiers, classes, summary };
}

/**
 * Builds an `intent-plan-v1` record from a producer's request. `createdAt` is the SERVER clock and
 * the plan id derives from the idempotency key, so neither can be forged. Research over the goal
 * runs HERE, before any question exists: one explicitly named repository settles the scope, one
 * stated ceiling settles the budget. A forbidden, credential-shaped, authority-claiming, or unknown
 * field refuses the whole request by name rather than being silently dropped.
 */
export function buildIntentPlan(input: unknown, opts: { readonly clock: Clock; readonly proposedBy: string }): IntentPlanBuild {
  const refuse = (code: IntentPlanBuildCode, field: string, reason: string): IntentPlanBuild => ({ ok: false, code, field, reason });
  if (!isPlainObject(input)) return refuse("not-an-object", "plan", "an intent plan request must be a JSON object");
  const redaction = automationRedactionViolation(input);
  if (redaction) return refuse(redaction.code, redaction.field, `field ${redaction.field} may not enter the intent-plan contract`);
  const signal = findNonAuthoritativeSignal(input);
  if (signal) return refuse("non-authoritative-signal", signal, `field ${signal} can never authorize a plan`);
  const claim = findKey(input, INTENT_PLAN_AUTHORITY_FIELD_RE);
  if (claim) return refuse("authority-claim", claim, `field ${claim} claims an approval a request never carries; only an operator decision confirms a plan`);
  const unknown = Object.keys(input).find((key) => !INPUT_FIELDS.has(key));
  if (unknown) return refuse("unknown-field", unknown, `field ${unknown} is not part of an intent-plan request`);
  if (!bounded(input.goal, INTENT_PLAN_MAX_GOAL_CHARS)) return refuse("missing-outcome", "goal", `a goal of 1..${INTENT_PLAN_MAX_GOAL_CHARS} characters is required`);
  const goal = input.goal.trim();
  const createdMs = opts.clock.now();
  const constraints = textList(input.constraints, INTENT_PLAN_MAX_LIST);
  if (!constraints) return refuse("invalid-constraints", "constraints", `at most ${INTENT_PLAN_MAX_LIST} bounded constraints`);
  const supplied = validateFacts(input.facts, createdMs);
  if (!supplied) return refuse("invalid-facts", "facts", `at most ${INTENT_PLAN_MAX_LIST} facts of {statement, source, observedAt no later than now, availability?}`);
  const questions = validateQuestions(input.questions);
  if (!questions) return refuse("invalid-questions", "questions", `at most ${INTENT_PLAN_MAX_SUPPLIED_QUESTIONS} distinct {id, question} after deduplication`);
  const scopeInput = validateScope(input.scope);
  if (!scopeInput) return refuse("invalid-scope", "scope", "scope may name only a bounded repo, instance, and flowId");
  if (input.delegationId !== undefined && !bounded(input.delegationId, AUTOMATION_ACTION_MAX_ID_CHARS)) return refuse("invalid-scope", "delegationId", "delegationId must be a bounded string");
  const budgetInput = input.budget ?? {};
  if (!isPlainObject(budgetInput) || Object.keys(budgetInput).some((key) => key !== "ceilingUsd") || (budgetInput.ceilingUsd !== undefined && !boundedUsd(budgetInput.ceilingUsd))) {
    return refuse("invalid-budget", "budget", `budget may name only ceilingUsd in 0..${DELEGATION_PROFILE_MAX_COST_USD}`);
  }
  const ceilingInput = budgetInput.ceilingUsd as number | undefined;
  const maxAgeSeconds = input.freshness === undefined ? INTENT_PLAN_DEFAULT_FRESHNESS_SECONDS : isPlainObject(input.freshness) ? input.freshness.maxAgeSeconds : undefined;
  if (!boundedInteger(maxAgeSeconds, 1, AUTOMATION_ACTION_MAX_FRESHNESS_SECONDS)) return refuse("invalid-freshness", "freshness.maxAgeSeconds", `freshness.maxAgeSeconds must be an integer in 1..${AUTOMATION_ACTION_MAX_FRESHNESS_SECONDS}`);
  const ttl = input.expiresInMinutes ?? INTENT_PLAN_DEFAULT_TTL_MINUTES;
  if (!boundedInteger(ttl, 1, INTENT_PLAN_MAX_TTL_MINUTES)) return refuse("invalid-expiry", "expiresInMinutes", `expiresInMinutes must be an integer in 1..${INTENT_PLAN_MAX_TTL_MINUTES}`);
  if (input.idempotencyKey !== undefined && !bounded(input.idempotencyKey, INTENT_PLAN_MAX_KEY_CHARS)) return refuse("invalid-idempotency-key", "idempotencyKey", `idempotencyKey must be 1..${INTENT_PLAN_MAX_KEY_CHARS} characters`);
  const createdAt = opts.clock.iso();
  const inputDigest = digest(JSON.stringify(input));
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : `intent:${digest(`${inputDigest}\u0000${createdAt}\u0000${opts.proposedBy}`)}`;
  const planId = `intent-plan-${digest(idempotencyKey)}`;
  const rawSteps = input.steps ?? [];
  if (!Array.isArray(rawSteps) || rawSteps.length > INTENT_PLAN_MAX_STEPS) return refuse("invalid-steps", "steps", `at most ${INTENT_PLAN_MAX_STEPS} steps`);
  const steps: IntentPlanStep[] = [];
  for (const [index, raw] of rawSteps.entries()) {
    const step = validateStep(raw, `step-${index + 1}`);
    if (typeof step === "string") return refuse("invalid-steps", `steps.${index}`, step);
    steps.push(step);
  }
  const repositories = distinctMatches(goal, INTENT_PLAN_REPO_MENTION_RE);
  const ceilingsUsd = distinctMatches(goal, INTENT_PLAN_SPEND_MENTION_RE).map(Number);
  const researched = (statement: string): IntentPlanFact => ({ statement, source: "goal", observedAt: createdAt, availability: "available" });
  const scope = scopeInput.repo || scopeInput.instance || repositories.length !== 1 ? scopeInput : { ...scopeInput, repo: repositories[0]! };
  const ceilingUsd = ceilingInput ?? (ceilingsUsd.length === 1 ? ceilingsUsd[0] : undefined);
  const estimatedUsd = steps.reduce((sum, step) => sum + step.estimatedCostUsd, 0);
  return {
    ok: true,
    plan: {
      version: INTENT_PLAN_VERSION,
      planId,
      outcome: goal,
      constraints,
      facts: [...supplied, ...repositories.map((repo) => researched(`the goal names repository ${repo}`)), ...ceilingsUsd.map((usd) => researched(`the goal caps spend at $${usd}`))],
      research: { repositories, ceilingsUsd },
      questions,
      steps,
      scope,
      ...(typeof input.delegationId === "string" ? { delegationId: input.delegationId.trim() } : {}),
      consequence: consequenceOf(steps, estimatedUsd),
      budget: { estimatedUsd, ...(ceilingUsd !== undefined ? { ceilingUsd } : {}) },
      approval: { confirmation: "operator", humanGatedSteps: steps.filter((step) => step.approvalPolicy === "human").map((step) => step.stepId) },
      freshness: { maxAgeSeconds },
      createdAt,
      expiresAt: fixedClock(createdMs + ttl * 60_000).iso(),
      idempotencyKey,
      inputDigest,
      proposedBy: opts.proposedBy,
      preview: { operative: false },
      undo: steps.map((step) => ({ stepId: step.stepId, mode: step.rollback.mode, path: step.rollback.mode === "reversible" ? step.rollback.plan : step.rollback.refusal })),
    },
  };
}

// ── Events: every change after proposal is a NEW linked record ────────────────────────────

export type IntentPlanUndoResult = "withdrawn" | "rollback-requested" | "refused" | "nothing-to-undo" | "already-undone";

export interface IntentPlanUndoStep {
  readonly stepId: string;
  readonly actionId: string;
  readonly result: IntentPlanUndoResult;
  readonly detail: string;
  readonly code?: string;
  readonly linkedReceiptId?: string;
}

interface IntentPlanEventBase {
  readonly eventId: string;
  readonly at: string;
  readonly issuer: string;
  readonly note?: string;
}

export type IntentPlanEvent =
  | (IntentPlanEventBase & { readonly kind: "clarify"; readonly questionId: string; readonly answer: string })
  | (IntentPlanEventBase & { readonly kind: "confirm"; readonly actionIds: readonly string[] })
  | (IntentPlanEventBase & { readonly kind: "undo"; readonly outcome: "withdrawn" | "requested" | "refused"; readonly steps: readonly IntentPlanUndoStep[] });

const UNDO_RESULTS: readonly string[] = ["withdrawn", "rollback-requested", "refused", "nothing-to-undo", "already-undone"];

function validateUndoStep(value: unknown): IntentPlanUndoStep | null {
  if (!isPlainObject(value) || !bounded(value.stepId, AUTOMATION_ACTION_MAX_ID_CHARS) || !bounded(value.actionId, AUTOMATION_ACTION_MAX_ID_CHARS)) return null;
  if (typeof value.result !== "string" || !UNDO_RESULTS.includes(value.result) || !bounded(value.detail, AUTOMATION_ACTION_MAX_TEXT_CHARS)) return null;
  if ((value.code !== undefined && !bounded(value.code, AUTOMATION_ACTION_MAX_ID_CHARS)) || (value.linkedReceiptId !== undefined && !bounded(value.linkedReceiptId, AUTOMATION_ACTION_MAX_ID_CHARS))) return null;
  return {
    stepId: value.stepId,
    actionId: value.actionId,
    result: value.result as IntentPlanUndoResult,
    detail: value.detail,
    ...(value.code !== undefined ? { code: value.code as string } : {}),
    ...(value.linkedReceiptId !== undefined ? { linkedReceiptId: value.linkedReceiptId as string } : {}),
  };
}

/** Re-validates an event read back from the ledger, so a hand-edited row never enters a fold. */
export function validateIntentPlanEvent(value: unknown): IntentPlanEvent | null {
  if (!isPlainObject(value) || automationRedactionViolation(value) || !bounded(value.eventId, AUTOMATION_ACTION_MAX_ID_CHARS) || !validInstant(value.at) || !bounded(value.issuer, AUTOMATION_ACTION_MAX_ID_CHARS)) return null;
  if (value.note !== undefined && !bounded(value.note, INTENT_PLAN_MAX_NOTE_CHARS)) return null;
  const base = { eventId: value.eventId, at: value.at, issuer: value.issuer, ...(value.note !== undefined ? { note: value.note as string } : {}) };
  if (value.kind === "clarify" && bounded(value.questionId, AUTOMATION_ACTION_MAX_ID_CHARS) && bounded(value.answer, INTENT_PLAN_MAX_ANSWER_CHARS)) {
    return { ...base, kind: "clarify", questionId: value.questionId, answer: value.answer };
  }
  if (value.kind === "confirm" && Array.isArray(value.actionIds) && value.actionIds.length <= INTENT_PLAN_MAX_STEPS && value.actionIds.every((id) => bounded(id, AUTOMATION_ACTION_MAX_ID_CHARS))) {
    return { ...base, kind: "confirm", actionIds: value.actionIds as string[] };
  }
  if (value.kind !== "undo" || (value.outcome !== "withdrawn" && value.outcome !== "requested" && value.outcome !== "refused") || !Array.isArray(value.steps)) return null;
  const steps = value.steps.map(validateUndoStep);
  return steps.length <= INTENT_PLAN_MAX_STEPS && steps.every((step) => step !== null) ? { ...base, kind: "undo", outcome: value.outcome, steps: steps as IntentPlanUndoStep[] } : null;
}

function intentPlanEventId(plan: IntentPlan, events: readonly IntentPlanEvent[], kind: IntentPlanEvent["kind"], at: string): string {
  return `ipe-${digest(`${plan.planId}\u0000${kind}\u0000${events.length}\u0000${at}`)}`;
}

export interface IntentPlanState {
  readonly plan: IntentPlan;
  readonly events: readonly IntentPlanEvent[];
}

/**
 * Folds ledger rows into one state per plan. A plan row stores the producer's INPUT plus the
 * server's createdAt and proposer, and the record is REBUILT here through {@link buildIntentPlan} —
 * so a hand-edited row is re-validated by the same code that admitted it. The first row per plan
 * id wins; events append in ledger order, deduplicated by id, up to {@link INTENT_PLAN_MAX_EVENTS}.
 */
export function foldIntentPlans(rows: readonly Readonly<Record<string, unknown>>[]): IntentPlanState[] {
  const states = new Map<string, { plan: IntentPlan; events: IntentPlanEvent[] }>();
  for (const row of rows) {
    if (row.step === INTENT_PLAN_LEDGER_STEP && validInstant(row.created_at) && bounded(row.proposed_by, AUTOMATION_ACTION_MAX_ID_CHARS)) {
      const built = buildIntentPlan(row.input, { clock: fixedClock(Date.parse(row.created_at)), proposedBy: row.proposed_by });
      if (built.ok && !states.has(built.plan.planId)) states.set(built.plan.planId, { plan: built.plan, events: [] });
    } else if (row.step === INTENT_PLAN_EVENT_LEDGER_STEP) {
      const state = typeof row.plan_id === "string" ? states.get(row.plan_id) : undefined;
      const event = validateIntentPlanEvent(row.event);
      if (state && event && state.events.length < INTENT_PLAN_MAX_EVENTS && !state.events.some((item) => item.eventId === event.eventId)) state.events.push(event);
    }
  }
  return [...states.values()].sort((left, right) => Date.parse(right.plan.createdAt) - Date.parse(left.plan.createdAt) || left.plan.planId.localeCompare(right.plan.planId));
}

// ── Clarification: W1-T2499's discipline over a plan ─────────────────────────────────────

function scopeResolved(scope: IntentPlanScope): boolean {
  return Boolean(scope.repo || scope.instance);
}

function firstAnswers(events: readonly IntentPlanEvent[]): Map<string, string> {
  const answers = new Map<string, string>();
  for (const event of events) if (event.kind === "clarify" && !answers.has(event.questionId)) answers.set(event.questionId, event.answer.trim());
  return answers;
}

export interface IntentPlanResolution {
  readonly scope: IntentPlanScope;
  readonly ceilingUsd?: number;
  readonly answers: ReadonlyMap<string, string>;
}

/** The plan as its answers resolve it — derived, never written back to the plan. */
export function resolveIntentPlan(plan: IntentPlan, events: readonly IntentPlanEvent[]): IntentPlanResolution {
  const answers = firstAnswers(events);
  const scopeMatch = INTENT_PLAN_SCOPE_ANSWER_RE.exec(answers.get("scope") ?? "");
  const answeredScope = scopeMatch ? (scopeMatch[1] ? { repo: scopeMatch[1] } : { instance: scopeMatch[2]! }) : {};
  const scope = scopeResolved(plan.scope) ? plan.scope : { ...plan.scope, ...answeredScope };
  const usdMatch = INTENT_PLAN_USD_ANSWER_RE.exec(answers.get("budget-ceiling") ?? "");
  const ceilingUsd = plan.budget.ceilingUsd ?? (usdMatch ? Number(usdMatch[1]) : undefined);
  return { scope, ...(ceilingUsd !== undefined ? { ceilingUsd } : {}), answers };
}

export interface IntentPlanQuestion {
  readonly id: string;
  readonly question: string;
  /** What research already established — every question states it, so none asks what was known. */
  readonly established: string;
}

export interface IntentPlanClarification {
  readonly state: "understood" | "clarifying" | "exhausted";
  /** The questions still ASKABLE: unresolved and never asked before. */
  readonly open: readonly IntentPlanQuestion[];
  /** Everything research and answers have not settled, askable or not. */
  readonly unresolved: readonly IntentPlanQuestion[];
  readonly roundsUsed: number;
  readonly maxRounds: number;
}

function questionFindings(plan: IntentPlan, resolution: IntentPlanResolution): Array<{ question: IntentPlanQuestion; settled: boolean }> {
  const repos = plan.research.repositories;
  return [
    {
      settled: scopeResolved(resolution.scope),
      question: {
        id: "scope",
        question: "Which one repository (owner/name) or instance (instance <id>) should this plan act on?",
        established: repos.length === 0 ? "the goal names no repository and no scope was supplied" : `the goal names ${repos.length} repositories: ${repos.join(", ")}`,
      },
    },
    {
      settled: plan.budget.estimatedUsd === 0 || resolution.ceilingUsd !== undefined,
      question: {
        id: "budget-ceiling",
        question: "What is the most, in US dollars, this plan may spend?",
        established: `the proposed steps estimate $${plan.budget.estimatedUsd} and no single spend ceiling was stated`,
      },
    },
    ...plan.questions.map((spec) => ({
      settled: resolution.answers.has(spec.id),
      question: { ...spec, established: "the proposer could not settle this from its own sources" },
    })),
  ];
}

/**
 * The plan's clarification state. Understood is an EMPTY unresolved set, never a model's say-so.
 * A question already answered is never asked again even if the answer did not settle it; once no
 * unresolved question is askable, or {@link INTENT_PLAN_MAX_ROUNDS} answers are spent, the plan
 * reports `exhausted` and names what stays open instead of asking indefinitely.
 */
export function intentPlanClarification(plan: IntentPlan, events: readonly IntentPlanEvent[]): IntentPlanClarification {
  const resolution = resolveIntentPlan(plan, events);
  const clarifies = events.filter((event) => event.kind === "clarify");
  const asked = new Set(clarifies.map((event) => event.questionId));
  const unresolved = questionFindings(plan, resolution).filter((finding) => !finding.settled).map((finding) => finding.question);
  const open = unresolved.filter((question) => !asked.has(question.id));
  const counts = { roundsUsed: clarifies.length, maxRounds: INTENT_PLAN_MAX_ROUNDS };
  if (unresolved.length === 0) return { state: "understood", open: [], unresolved: [], ...counts };
  if (open.length === 0 || clarifies.length >= INTENT_PLAN_MAX_ROUNDS) return { state: "exhausted", open: [], unresolved, ...counts };
  return { state: "clarifying", open, unresolved, ...counts };
}

// ── Preview: non-operative, and every blocking state kept distinct ───────────────────────

export type IntentPlanPreviewState =
  | "ready"
  | "expired"
  | "unavailable"
  | "stale"
  | "ambiguous"
  | "refused"
  | "over-budget"
  | "clarification-exhausted"
  | "needs-clarification";

/** First-precedence order: the preview's state is the earliest of these any finding names. */
const PREVIEW_PRECEDENCE: readonly Exclude<IntentPlanPreviewState, "ready">[] = [
  "expired", "unavailable", "stale", "ambiguous", "refused", "over-budget", "clarification-exhausted", "needs-clarification",
];

export interface IntentPlanPreviewFinding {
  readonly state: Exclude<IntentPlanPreviewState, "ready">;
  readonly code: string;
  readonly detail: string;
  readonly stepId?: string;
}

export interface IntentPlanPreview {
  /** A preview never registers, approves, or executes anything — structurally `false`. */
  readonly operative: false;
  readonly state: IntentPlanPreviewState;
  readonly evaluatedAt: string;
  readonly findings: readonly IntentPlanPreviewFinding[];
  readonly clarification: IntentPlanClarification;
  readonly scope: IntentPlanScope;
  readonly ceilingUsd?: number;
}

/** The automation-action-v1 records a confirmed plan requests, one per step. Deterministic from
 *  the plan and its resolved scope, so a retried confirmation names the SAME actions and keys. */
export function intentPlanActions(plan: IntentPlan, scope: IntentPlanScope): AutomationAction[] {
  return plan.steps.map((step) => ({
    version: AUTOMATION_ACTION_VERSION,
    actionId: `${plan.planId}:${step.stepId}`,
    capability: step.capability,
    summary: step.summary,
    scope: { flowId: scope.flowId ?? plan.planId, ...(scope.repo ? { repo: scope.repo } : {}), ...(scope.instance ? { instance: scope.instance } : {}) },
    risk: step.risk,
    preconditions: step.preconditions,
    freshness: step.freshness,
    idempotencyKey: `${plan.idempotencyKey}:${step.stepId}`,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    dryRun: step.dryRun,
    approval: { policy: step.approvalPolicy },
    rollback: step.rollback,
    receiptRef: step.receiptRef,
  }));
}

export interface IntentPlanPreviewInput {
  readonly plan: IntentPlan;
  readonly events: readonly IntentPlanEvent[];
  readonly clock: Clock;
  /** The plan's named delegation's durable state; `undefined` when none is found. */
  readonly delegation?: DelegationProfileState;
}

/** Delegation refusals per step. The human gate is not one: each gated action still takes its own
 *  operator approval after confirmation, exactly as `delegationEligibility` requires. */
function delegationFindings(input: IntentPlanPreviewInput, scope: IntentPlanScope): IntentPlanPreviewFinding[] {
  const { plan, clock } = input;
  if (plan.delegationId === undefined || !scopeResolved(scope)) return [];
  return intentPlanActions(plan, scope).flatMap((action, index) =>
    delegationEligibility({ state: input.delegation, action, estimatedCostUsd: plan.budget.estimatedUsd, clock })
      .filter((finding: AutomationPreflightFinding) => finding.code !== HUMAN_GATE_CODE)
      .map((finding) => ({ state: "refused" as const, code: finding.code, detail: finding.detail, stepId: plan.steps[index]!.stepId })),
  );
}

/**
 * Previews a plan without touching anything. Expiry, a missing step, an unavailable or stale
 * supplied fact, an ambiguous scope, a delegation refusal, an estimate over the ceiling, and open
 * or exhausted clarification each add a finding under their own state; only a plan with none is
 * `ready`. Time is read here, at preview, never trusted from an earlier call.
 */
export function previewIntentPlan(input: IntentPlanPreviewInput): IntentPlanPreview {
  const { plan, events, clock } = input;
  const nowMs = clock.now();
  const resolution = resolveIntentPlan(plan, events);
  const clarification = intentPlanClarification(plan, events);
  const findings: IntentPlanPreviewFinding[] = [];
  if (nowMs >= Date.parse(plan.expiresAt)) findings.push({ state: "expired", code: "plan-expired", detail: `plan ${plan.planId} expired at ${plan.expiresAt}` });
  if (plan.steps.length === 0) findings.push({ state: "unavailable", code: "no-bounded-step", detail: "no producer proposed a bounded step; a sentence alone never becomes an action" });
  const maxAgeMs = plan.freshness.maxAgeSeconds * 1000;
  for (const fact of plan.facts) {
    if (fact.availability === "unavailable") findings.push({ state: "unavailable", code: "source-unavailable", detail: `source ${fact.source} was unavailable: ${fact.statement}` });
    else if (fact.source !== "goal" && nowMs - Date.parse(fact.observedAt) > maxAgeMs) findings.push({ state: "stale", code: "fact-stale", detail: `the fact from ${fact.source} is older than ${plan.freshness.maxAgeSeconds}s` });
  }
  if (!scopeResolved(resolution.scope) && plan.research.repositories.length > 1) {
    findings.push({ state: "ambiguous", code: "ambiguous-scope", detail: `the goal names ${plan.research.repositories.length} repositories and none was chosen` });
  }
  findings.push(...delegationFindings(input, resolution.scope));
  if (resolution.ceilingUsd !== undefined && plan.budget.estimatedUsd > resolution.ceilingUsd) {
    findings.push({ state: "over-budget", code: "over-budget", detail: `the steps estimate $${plan.budget.estimatedUsd} against a $${resolution.ceilingUsd} ceiling` });
  }
  if (clarification.state === "exhausted") findings.push({ state: "clarification-exhausted", code: "clarification-exhausted", detail: `${clarification.unresolved.length} question(s) stay unresolved after ${clarification.roundsUsed} answer(s)` });
  if (clarification.state === "clarifying") findings.push({ state: "needs-clarification", code: "open-questions", detail: `${clarification.open.length} question(s) are open` });
  const state = PREVIEW_PRECEDENCE.find((candidate) => findings.some((finding) => finding.state === candidate)) ?? "ready";
  return { operative: false, state, evaluatedAt: clock.iso(), findings, clarification, scope: resolution.scope, ...(resolution.ceilingUsd !== undefined ? { ceilingUsd: resolution.ceilingUsd } : {}) };
}

// ── Decisions: clarify, confirm, undo — each a NEW linked event or a named refusal ─────────

export type IntentPlanStatus = "draft" | "confirmed" | "withdrawn";

export function intentPlanStatus(events: readonly IntentPlanEvent[]): IntentPlanStatus {
  if (events.some((event) => event.kind === "confirm")) return "confirmed";
  return events.some((event) => event.kind === "undo" && event.outcome === "withdrawn") ? "withdrawn" : "draft";
}

export type IntentPlanDecisionResult =
  | { readonly disposition: "recorded" | "confirmed" | "withdrawn" | "requested"; readonly append: true; readonly event: IntentPlanEvent; readonly actions?: readonly AutomationAction[] }
  | { readonly disposition: "reused"; readonly append: false; readonly event: IntentPlanEvent }
  | { readonly disposition: "refused"; readonly append: boolean; readonly code: string; readonly reason: string; readonly event?: IntentPlanEvent };

function refused(code: string, reason: string): IntentPlanDecisionResult {
  return { disposition: "refused", append: false, code, reason };
}

function historyFull(state: IntentPlanState): IntentPlanDecisionResult | undefined {
  return state.events.length >= INTENT_PLAN_MAX_EVENTS ? refused("event-history-full", `plan ${state.plan.planId} already holds ${state.events.length} events`) : undefined;
}

export interface IntentPlanClarifyInput {
  readonly state: IntentPlanState;
  readonly questionId: string;
  readonly answer: string;
  readonly issuer: string;
  readonly clock: Clock;
}

/** Records one answer. Refused for a closed or expired plan, a question already asked, a question
 *  that is not open, or an exhausted round budget — never asked twice, never asked forever. */
export function clarifyIntentPlan(input: IntentPlanClarifyInput): IntentPlanDecisionResult {
  const { state, clock } = input;
  const { plan, events } = state;
  const status = intentPlanStatus(events);
  if (status !== "draft") return refused("plan-closed", `plan ${plan.planId} is ${status}; its questions are closed`);
  if (clock.now() >= Date.parse(plan.expiresAt)) return refused("plan-expired", `plan ${plan.planId} expired at ${plan.expiresAt}`);
  if (!bounded(input.answer, INTENT_PLAN_MAX_ANSWER_CHARS) || automationRedactionViolation({ answer: input.answer })) return refused("invalid-answer", "an answer must be bounded and carry no credential");
  if (events.some((event) => event.kind === "clarify" && event.questionId === input.questionId)) return refused("already-asked", `question ${input.questionId} was already asked and answered; it is never asked twice`);
  const clarification = intentPlanClarification(plan, events);
  if (clarification.state === "exhausted") return refused("clarification-exhausted", `the clarification budget is spent after ${clarification.roundsUsed} answer(s)`);
  if (!clarification.open.some((question) => question.id === input.questionId)) return refused("not-open", `question ${input.questionId} is not open on plan ${plan.planId}`);
  const full = historyFull(state);
  if (full) return full;
  const at = clock.iso();
  return { disposition: "recorded", append: true, event: { eventId: intentPlanEventId(plan, events, "clarify", at), kind: "clarify", at, issuer: input.issuer, questionId: input.questionId, answer: input.answer.trim() } };
}

export interface IntentPlanConfirmInput {
  readonly state: IntentPlanState;
  readonly issuer: string;
  readonly note?: string;
  readonly clock: Clock;
  readonly delegation?: DelegationProfileState;
}

/**
 * Confirmation derives the linked automation-action-v1 requests. The preview is RE-RUN here, at
 * confirmation, never trusted from an earlier read, and anything but `ready` refuses under its own
 * state. A second confirmation returns the first. Nothing here reports success: the event names the
 * requested actions, whose own admission and completion receipts are the only evidence of an outcome.
 */
export function confirmIntentPlan(input: IntentPlanConfirmInput): IntentPlanDecisionResult {
  const { state, clock } = input;
  const { plan, events } = state;
  const existing = events.find((event) => event.kind === "confirm");
  if (existing) return { disposition: "reused", append: false, event: existing };
  if (intentPlanStatus(events) === "withdrawn") return refused("plan-withdrawn", `plan ${plan.planId} was withdrawn; propose a new plan`);
  const preview = previewIntentPlan({ plan, events, clock, ...(input.delegation ? { delegation: input.delegation } : {}) });
  if (preview.state !== "ready") return refused(`preview-${preview.state}`, preview.findings.find((finding) => finding.state === preview.state)!.detail);
  const full = historyFull(state);
  if (full) return full;
  const actions = intentPlanActions(plan, preview.scope);
  const at = clock.iso();
  const event: IntentPlanEvent = { eventId: intentPlanEventId(plan, events, "confirm", at), kind: "confirm", at, issuer: input.issuer, actionIds: actions.map((action) => action.actionId), ...(input.note ? { note: input.note } : {}) };
  return { disposition: "confirmed", append: true, event, actions };
}

/** One linked action's durable history, as operator-agent.ts folds it from the ledger. */
export interface IntentPlanLinkedAction {
  readonly action: AutomationAction;
  readonly state: AutomationActionState;
  readonly receipts: readonly AutomationActionReceipt[];
}

function undoStepFor(stepId: string, actionId: string, linked: IntentPlanLinkedAction | undefined): IntentPlanUndoStep {
  const at = { stepId, actionId };
  if (!linked) return { ...at, result: "refused", code: "action-missing", detail: `action ${actionId} is not on the ledger; nothing can be undone safely` };
  const { action } = linked;
  if (linked.state === "registered" || linked.state === "approved") return { ...at, result: "withdrawn", detail: `action ${actionId} never ran; its admission is refused from now on` };
  if (linked.state === "in-progress") return { ...at, result: "refused", code: "in-progress", detail: `action ${actionId} is executing; undo again once it completes` };
  if (linked.state === "rolled_back") return { ...at, result: "already-undone", detail: `action ${actionId} is already rolled back` };
  if (linked.state !== "succeeded") return { ...at, result: "nothing-to-undo", detail: `action ${actionId} ended ${linked.state}; nothing ran to undo` };
  if (action.rollback.mode === "irreversible") return { ...at, result: "refused", code: "irreversible", detail: action.rollback.refusal };
  const completion = [...linked.receipts].reverse().find((receipt) => receipt.kind === "completion" && receipt.outcome === "succeeded")!;
  return { ...at, result: "rollback-requested", linkedReceiptId: completion.receiptId, detail: action.rollback.plan };
}

export interface IntentPlanUndoInput {
  readonly state: IntentPlanState;
  readonly linked: readonly IntentPlanLinkedAction[];
  readonly issuer: string;
  readonly note?: string;
  readonly clock: Clock;
}

/**
 * Undo NEVER rewrites the plan or a receipt. An unconfirmed plan is withdrawn. For a confirmed one,
 * each linked action gets its own answer: a never-run action is withdrawn (its admission refused
 * from then on), a completed reversible one gets a rollback REQUEST linked to its completion
 * receipt — done only when a rollback receipt exists — and an irreversible or running one is
 * refused by name. A refusal is recorded too; an undo that changes nothing returns the last one.
 */
export function undoIntentPlan(input: IntentPlanUndoInput): IntentPlanDecisionResult {
  const { state, clock } = input;
  const { plan, events } = state;
  const prior = [...events].reverse().find((event) => event.kind === "undo");
  const confirmation = events.find((event) => event.kind === "confirm");
  const full = historyFull(state);
  const at = clock.iso();
  const make = (outcome: "withdrawn" | "requested" | "refused", steps: IntentPlanUndoStep[]): IntentPlanEvent => ({
    eventId: intentPlanEventId(plan, events, "undo", at), kind: "undo", at, issuer: input.issuer, outcome, steps, ...(input.note ? { note: input.note } : {}),
  });
  if (!confirmation) {
    if (prior) return { disposition: "reused", append: false, event: prior };
    return full ?? { disposition: "withdrawn", append: true, event: make("withdrawn", []) };
  }
  const earlier = new Map(events.flatMap((event) => (event.kind === "undo" ? event.steps : [])).map((step) => [step.actionId, step.result]));
  const steps = confirmation.actionIds.map((actionId, index) =>
    undoStepFor(plan.steps[index]?.stepId ?? `step-${index + 1}`, actionId, input.linked.find((linked) => linked.action.actionId === actionId)),
  );
  const fresh = steps.some((step) => (step.result === "withdrawn" || step.result === "rollback-requested") && earlier.get(step.actionId) !== step.result);
  if (full) return full;
  if (fresh) return { disposition: "requested", append: true, event: make("requested", steps) };
  if (prior && !steps.some((step) => step.result === "refused")) return { disposition: "reused", append: false, event: prior };
  const first = steps.find((step) => step.result === "refused") ?? steps[0]!;
  return { disposition: "refused", append: true, code: first.code ?? "nothing-to-undo", reason: first.detail, event: make("refused", steps) };
}

/** Admission refusals for an action a confirmed plan requested and a later undo withdrew — fed into
 *  the action's own preflight exactly like a delegation's eligibility findings. */
export function intentPlanActionEligibility(states: readonly IntentPlanState[], actionId: string): AutomationPreflightFinding[] {
  const owner = states.find((state) => state.events.some((event) => event.kind === "confirm" && event.actionIds.includes(actionId)));
  const withdrawn = owner?.events.some((event) => event.kind === "undo" && event.steps.some((step) => step.actionId === actionId && step.result === "withdrawn"));
  return withdrawn ? [{ outcome: "refused", code: "intent-plan-withdrawn", detail: `plan ${owner!.plan.planId} withdrew action ${actionId}` }] : [];
}

// ── Execution and the public read shape ─────────────────────────────────────────────────

export type IntentPlanExecutionState =
  | "not-requested"
  | "awaiting-receipt"
  | "in-progress"
  | "succeeded"
  | "failed"
  | "refused"
  | "expired"
  | "rolled-back"
  | "partially-rolled-back"
  | "unknown";

export interface IntentPlanExecution {
  readonly state: IntentPlanExecutionState;
  readonly actions: ReadonlyArray<{
    readonly actionId: string;
    readonly state: AutomationActionState | "missing";
    readonly evidenceRef?: string;
    readonly undo?: "withdrawn" | "rollback-requested" | "rolled-back";
  }>;
}

/**
 * What the linked actions' receipts say happened. `succeeded` needs EVERY action's completion
 * receipt (each names its evidence); a missing action reads `unknown`, never success.
 */
export function intentPlanExecution(state: IntentPlanState, linked: readonly IntentPlanLinkedAction[]): IntentPlanExecution {
  const confirmation = state.events.find((event) => event.kind === "confirm");
  if (!confirmation) return { state: "not-requested", actions: [] };
  const undone = new Map(state.events.flatMap((event) => (event.kind === "undo" ? event.steps : [])).map((step) => [step.actionId, step.result]));
  const actions = confirmation.actionIds.map((actionId) => {
    const history = linked.find((item) => item.action.actionId === actionId);
    const evidenceRef = history?.receipts.find((receipt) => receipt.kind === "completion" && receipt.outcome === "succeeded")?.evidenceRef;
    const requested = undone.get(actionId);
    const undo = history?.state === "rolled_back" ? ("rolled-back" as const) : requested === "withdrawn" || requested === "rollback-requested" ? requested : undefined;
    return { actionId, state: history?.state ?? ("missing" as const), ...(evidenceRef ? { evidenceRef } : {}), ...(undo ? { undo } : {}) };
  });
  const states = actions.map((action) => action.state);
  const any = (value: string): boolean => states.includes(value as AutomationActionState);
  const every = (value: string): boolean => states.every((item) => item === value);
  const settledOk = states.every((item) => item === "succeeded" || item === "rolled_back");
  const execution: IntentPlanExecutionState = any("missing") ? "unknown"
    : any("in-progress") ? "in-progress"
    : any("failed") ? "failed"
    : any("rejected") ? "refused"
    : any("registered") || any("approved") ? "awaiting-receipt"
    : every("succeeded") ? "succeeded"
    : every("rolled_back") ? "rolled-back"
    : settledOk ? "partially-rolled-back"
    : "expired";
  return { state: execution, actions };
}

export const INTENT_PLAN_SOURCE = "rmd:core:/v1/operator-agent/intent-plans";

function consoleNote(event: IntentPlanEvent): string {
  if (event.note) return event.note;
  if (event.kind === "clarify") return `answered ${event.questionId}`;
  if (event.kind === "confirm") return `requested ${event.actionIds.length} action(s); success waits for their receipts`;
  return `undo ${event.outcome}: ${event.steps.map((step) => `${step.stepId} ${step.result}`).join(", ") || "plan withdrawn"}`;
}

/**
 * The public read shape: every field the console's intent-plan-v1 normaliser reads (planId, goal,
 * constraints, unknowns, scope, consequence, freshness, nextDecision, observedAt, receipts,
 * source), plus core's own envelope, status, preview, confirmation, execution, and events.
 */
export function projectIntentPlan(state: IntentPlanState, linked: readonly IntentPlanLinkedAction[], clock: Clock, delegation?: DelegationProfileState) {
  const { plan, events } = state;
  const status = intentPlanStatus(events);
  const preview = previewIntentPlan({ plan, events, clock, ...(delegation ? { delegation } : {}) });
  const execution = intentPlanExecution(state, linked);
  const confirmation = events.find((event) => event.kind === "confirm");
  const draft = status === "draft";
  const freshness = draft && (preview.state === "stale" || preview.state === "expired") ? "stale" : draft && preview.state === "unavailable" ? "unavailable" : "verified";
  const blocked = ["expired", "unavailable", "stale", "refused", "over-budget"].includes(preview.state);
  const undoable = ["awaiting-receipt", "in-progress", "succeeded", "partially-rolled-back"].includes(execution.state);
  const nextDecision = !draft ? (status === "confirmed" && undoable ? "undo" : "none")
    : preview.state === "ready" ? "confirm"
    : preview.clarification.open.length > 0 && !blocked ? "answer_clarification"
    : "none";
  const { scope, ceilingUsd } = preview;
  return {
    planId: plan.planId,
    goal: plan.outcome,
    constraints: plan.constraints,
    unknowns: draft ? preview.clarification.unresolved.map((question) => ({ id: question.id, question: `${question.question} (already established: ${question.established})`.slice(0, 500) })) : [],
    scope: { repository: scope.repo ?? (scope.instance ? "(instance scope)" : "(unresolved)"), ...(scope.instance ? { instanceId: scope.instance } : {}) },
    consequence: {
      classes: plan.consequence.classes,
      summary: plan.consequence.summary,
      ...(plan.consequence.classes.includes("financial") ? { budgetUsd: plan.budget.estimatedUsd } : {}),
      ...(ceilingUsd !== undefined ? { ceilingUsd } : {}),
    },
    freshness,
    nextDecision,
    observedAt: clock.iso(),
    receipts: [
      { kind: "propose" as const, at: plan.createdAt, issuer: plan.proposedBy },
      ...events.map((event) => ({ kind: event.kind, at: event.at, issuer: event.issuer, note: consoleNote(event).slice(0, 1_000) })),
    ],
    source: INTENT_PLAN_SOURCE,
    version: INTENT_PLAN_VERSION,
    status,
    plan,
    preview,
    confirmation: confirmation ? { state: "requested" as const, at: confirmation.at, actionIds: confirmation.actionIds } : { state: "none" as const },
    execution,
    events,
  };
}
