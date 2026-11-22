/**
 * lib/incident-templates.ts (W1-T13131) — the one versioned template contract incident ingest
 * (incident-events.ts) and SRE publication (sre-lane.ts) share.
 *
 * W1-T4383 grouped incidents by a fingerprint of normalised free text, and W1-T4385 published
 * scrubbed message samples into feedback. A denylist scrub misses short values (a 6-character
 * secret, a branch name, a path), so a runtime value could become both an incident's identity
 * and published bytes. This module is the boundary that replaces it: an incident's identity and
 * every byte this lane publishes come from a SOURCE-OWNED catalog entry binding a stable template
 * id to the literal message template its emitter writes, with a placeholder for EVERY
 * interpolation. A template id is resolved against this catalog; a client string is never
 * trusted because its field is named template. An event whose template is missing, unknown,
 * malformed or reported under a kind/source its entry does not declare is REFUSED before it is
 * fingerprinted or published — there is no fallback to scrubbed text and no catch-all template.
 *
 * Catalog entries and field policies are reviewed code. Never add one by copying a rendered
 * message: quote the emitter's literal and replace each interpolation with a named placeholder.
 */

import { createHash } from "node:crypto";

import { fixedClock } from "./clock.js";

/** The basis version. Folded into every fingerprint, so a legacy free-text id is never reused. */
export const INCIDENT_TEMPLATE_CONTRACT = "incident-template/v1";

/** One reviewed contract: a stable id bound to an emitter's literal message template. */
export interface IncidentTemplate {
  readonly id: string;
  /** The emitter's literal message, every interpolation replaced by a `{placeholder}`. */
  readonly literal: string;
  /** Every `{placeholder}` in {@link literal}, exactly. */
  readonly placeholders: readonly string[];
  /** The incident kinds this template may be reported under. */
  readonly kinds: readonly string[];
  /** The reporting sources this template may arrive from. */
  readonly sources: readonly string[];
  /** Static classification, published beside the template id. */
  readonly classification: string;
  /** The source file the literal is quoted from, so a reviewer can check it. */
  readonly quotedFrom: string;
}

// PRIMARY CONTROL: the longest template id the resolver accepts; a longer one is refused as malformed.
export const INCIDENT_TEMPLATE_ID_MAX_CHARS = 128;
const TEMPLATE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const PLACEHOLDER_PATTERN = /\{([a-z_]+)\}/g;

/** The SRE lane's own flow and intervention producers, which never pass through HTTP ingest. */
const SRE_LANE_SOURCE = "sre-lane";

export const INCIDENT_TEMPLATE_CATALOG: readonly IncidentTemplate[] = [
  {
    id: "service.internal-error",
    literal: "internal_error",
    placeholders: [],
    kinds: ["http_5xx"],
    sources: ["gateway", "daemon"],
    classification: "service.dispatch-failure",
    quotedFrom: "src/lib/service.ts",
  },
  {
    id: "board.status-unavailable",
    literal: "board_unavailable",
    placeholders: [],
    kinds: ["http_5xx"],
    sources: ["console", "gateway", "daemon"],
    classification: "board.snapshot-unavailable",
    quotedFrom: "src/lib/board.ts",
  },
  {
    id: "invariant.dispatch-stall",
    literal: "dispatch hold rows={held}, implement run starts={implement_starts}, fulfilled dispatches={fulfilled}",
    placeholders: ["held", "implement_starts", "fulfilled"],
    kinds: ["invariant"],
    sources: ["gateway"],
    classification: "invariant.dispatch-stall",
    quotedFrom: "src/lib/incident-invariants.ts",
  },
  {
    id: "sre-lane.flow-finding",
    literal: "{subject} {finding}",
    placeholders: ["subject", "finding"],
    kinds: ["flow"],
    sources: [SRE_LANE_SOURCE],
    classification: "sre-lane.fleet-flow",
    quotedFrom: "src/lib/fleet-flow-detectors.ts",
  },
  {
    id: "sre-lane.intervention",
    literal: "surface={surface} action={action} target={target} actor={actor} cause={cause}{file} — a hand action answered a fleet state no lane resolved",
    placeholders: ["surface", "action", "target", "actor", "cause", "file"],
    kinds: ["intervention"],
    sources: [SRE_LANE_SOURCE],
    classification: "sre-lane.operator-intervention",
    quotedFrom: "src/lib/operator-interventions.ts",
  },
];

/** The SRE lane's own producers write no template id: their rows are bound here, by reviewed code, to their entry. */
const LANE_OWNED_TEMPLATE_IDS: Readonly<Record<string, string>> = {
  flow: "sre-lane.flow-finding",
  intervention: "sre-lane.intervention",
};

/** The template id this lane's own flow/intervention producer is bound to, or undefined for any other row. A row
 *  naming no source is an in-process event of this lane: HTTP ingest refuses both kinds, and it always names one. */
export function laneOwnedIncidentTemplateId(source: unknown, kind: unknown): string | undefined {
  if ((source !== undefined && source !== SRE_LANE_SOURCE) || typeof kind !== "string") return undefined;
  return Object.hasOwn(LANE_OWNED_TEMPLATE_IDS, kind) ? LANE_OWNED_TEMPLATE_IDS[kind] : undefined;
}

/** Every problem with a catalog's shape — an empty list means each entry is well formed and unique. */
export function incidentTemplateCatalogProblems(catalog: readonly IncidentTemplate[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of catalog) {
    if (!isWellFormedTemplateId(entry.id)) problems.push(`${entry.id}: malformed id`);
    if (seen.has(entry.id)) problems.push(`${entry.id}: declared twice`);
    seen.add(entry.id);
    const used = [...entry.literal.matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1]);
    if (used.join("\u0000") !== entry.placeholders.join("\u0000")) problems.push(`${entry.id}: placeholders do not match the literal`);
    if (entry.kinds.length === 0 || entry.sources.length === 0) problems.push(`${entry.id}: declares no kind or source`);
  }
  return problems;
}

function isWellFormedTemplateId(value: string): boolean {
  return value.length > 0 && value.length <= INCIDENT_TEMPLATE_ID_MAX_CHARS && TEMPLATE_ID_PATTERN.test(value);
}

// ── resolve ───────────────────────────────────────────────────────────────────────────────────

export type IncidentTemplateRefusalReason = "missing" | "malformed" | "unknown" | "mismatched";
export const INCIDENT_TEMPLATE_REFUSAL_REASONS: readonly IncidentTemplateRefusalReason[] = ["missing", "malformed", "unknown", "mismatched"];

export type IncidentTemplateResolution =
  | { ok: true; template: IncidentTemplate }
  | { ok: false; reason: IncidentTemplateRefusalReason };

/**
 * Resolve an emitter's template id against the source-owned catalog. Missing (absent or null), malformed (not a
 * well-formed id string), unknown (no catalog entry) and mismatched (the entry does not declare this kind, or a
 * named source) are each refused — never defaulted, never matched loosely.
 */
export function resolveIncidentTemplate(
  input: { templateId: unknown; kind: string; source?: string },
  catalog: readonly IncidentTemplate[] = INCIDENT_TEMPLATE_CATALOG,
): IncidentTemplateResolution {
  const id = input.templateId;
  if (id === undefined || id === null) return { ok: false, reason: "missing" };
  if (typeof id !== "string" || !isWellFormedTemplateId(id)) return { ok: false, reason: "malformed" };
  const template = catalog.find((entry) => entry.id === id);
  if (template === undefined) return { ok: false, reason: "unknown" };
  if (!template.kinds.includes(input.kind)) return { ok: false, reason: "mismatched" };
  if (input.source !== undefined && !template.sources.includes(input.source)) return { ok: false, reason: "mismatched" };
  return { ok: true, template };
}

// ── identity ──────────────────────────────────────────────────────────────────────────────────

/** The fingerprint basis: the contract version, the template's id and literal, its classification and the kind
 *  (an enum the template declares). No rendered message, interpolation value, name, route or frame. */
export function incidentTemplateFingerprintBasis(template: IncidentTemplate, kind: string): string {
  return [INCIDENT_TEMPLATE_CONTRACT, template.id, template.literal, template.classification, kind].join("\u0000");
}

export function incidentTemplateFingerprint(template: IncidentTemplate, kind: string): string {
  return createHash("sha256").update(incidentTemplateFingerprintBasis(template, kind), "utf8").digest("hex");
}

// ── publication ───────────────────────────────────────────────────────────────────────────────

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const DEPLOY_SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const SUSPECT_PR_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/;

/** Named policy: a published fingerprint is 64 lower-case hex characters. */
export function isPublishableIncidentFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

/** Named policy: a deploy sha is published only as 7-40 lower-case hex characters. */
export function isPublishableDeploySha(value: unknown): value is string {
  return typeof value === "string" && DEPLOY_SHA_PATTERN.test(value);
}

/** Named policy: a suspect commit is published only as a github.com pull-request url. */
export function isPublishableSuspectPr(value: unknown): value is string {
  return typeof value === "string" && SUSPECT_PR_PATTERN.test(value);
}

/** The only facts a published incident body is built from, each named. */
export interface IncidentPublicationFacts {
  fingerprint: string;
  template: IncidentTemplate;
  kind: string;
  sources: readonly string[];
  count: number;
  firstSeenMs: number;
  lastSeenMs: number;
  burnPerHour: number;
  deployShas: readonly string[];
  suspectPrs: readonly string[];
}

/**
 * The feedback body for one eligible incident, built from the resolved literal template and the named safe fields
 * only. A kind or source the template does not declare, a deploy sha or a suspect PR outside its policy, is withheld.
 * Throws on an unpublishable fingerprint: the caller refuses such a row before it gets here.
 */
export function renderIncidentPublication(facts: IncidentPublicationFacts): string {
  if (!isPublishableIncidentFingerprint(facts.fingerprint)) throw new Error("incident fingerprint is not publishable");
  const { template } = facts;
  const kind = template.kinds.includes(facts.kind) ? facts.kind : "withheld";
  const sources = [...new Set(facts.sources.filter((s) => template.sources.includes(s)))];
  const shas = [...new Set(facts.deployShas.filter(isPublishableDeploySha))];
  const prs = [...new Set(facts.suspectPrs.filter(isPublishableSuspectPr))];
  const count = Number.isSafeInteger(facts.count) && facts.count >= 0 ? facts.count : 0;
  const burn = Number.isFinite(facts.burnPerHour) ? facts.burnPerHour.toFixed(2) : "0.00";
  return [
    `Incident ${facts.fingerprint.slice(0, 12)}: ${kind} template ${template.id}`,
    `Template contract: ${INCIDENT_TEMPLATE_CONTRACT}`,
    `Message template: ${template.literal}`,
    `Classification: ${template.classification}`,
    `Source(s): ${sources.length ? sources.join(", ") : "withheld"}`,
    `First seen: ${fixedClock(facts.firstSeenMs).iso()}`,
    `Last seen: ${fixedClock(facts.lastSeenMs).iso()}`,
    `Count: ${count}, burn: ${burn}/hr`,
    `Deploy sha(s): ${shas.length ? shas.join(", ") : "unknown"}`,
    "Suspect commits (merged pull requests touching the incident's in-app frames):",
    ...(prs.length ? prs.map((p) => `  - ${p}`) : ["  (none found)"]),
  ].join("\n");
}
