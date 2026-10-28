/**
 * lib/field-trials-field-note.ts — W1-T10831: CORE'S PRODUCER FOR THE SITE'S model-field-note-v1.
 *
 * The site (craigoley/remudero-site, lib/model-field-note.ts parseModelFieldNote, imported by
 * scripts/import-model-field-note.mjs) publishes observational per-model x task-class coverage. This
 * module turns the private field-trials-flow-v1 snapshot's adoption cells into a CANDIDATE for it:
 * an envelope whose state is `candidate-unreviewed`, holding a note body that leaves reviewedBy,
 * reviewedAt and publishedAt (or the site stage mode's stagedBy/stagedAt) to the site. Core never
 * stamps a review; the owner's merge of the site's import PR is the review.
 *
 * DISCLOSURE is the SITE's rule, pinned here, not core's SMALL_CELL_MIN: a row needs at least twice
 * the site's minimum cell of assignments, and each count and its complement is 0 or at least that
 * cell. A failing row is withheld and counted; more rows than the site admits keep a deterministic
 * subset. CONSENT needs both a live core receipt and an active aggregate-public entry in the pinned
 * site registry revision. No host, instance, task, assignment, account, path or prompt enters the
 * note; source labels in the envelope are salted pseudonyms. Falsifier:
 * test/routing/the-field-note-exporter-writes-a-site-candidate.test.ts.
 */
import { createHash, createHmac } from "node:crypto";
import type { AdoptionSelectedCell, FieldTrialsConsent, FieldTrialsFlowSnapshot } from "./field-trials-flow.js";

export const MODEL_FIELD_NOTE_SCHEMA = "model-field-note-v1" as const;
export const FIELD_NOTE_CANDIDATE_VERSION = "model-field-note-candidate-v1" as const;
export const FIELD_NOTE_WINDOWS_VERSION = "field-note-windows-v1" as const;
/** PINNED CONTRACT: the site validator's `minCell` (lib/model-field-note.ts). */
export const SITE_MIN_CELL = 10;
/** PINNED CONTRACT: the site validator's row ceiling. */
export const SITE_ROW_LIMIT = 24;
/** PINNED CONTRACT: the site validator's `safeId`, which every modelId, taskClass, repo and releaseId must match. */
export const SITE_SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** The site's consent registry shape (lib/field-trials-consent.ts). */
export interface SiteConsentRegistry {
  revision: string;
  entries: readonly { repository: string; state: "active" | "revoked"; scope: "aggregate-public"; approvedOn: string;
    approvedBy: "owner" }[];
}

/** The registry revision core pins by default, copied from the site; `--site-registry` names a newer one. */
export const PINNED_SITE_CONSENT_REGISTRY: SiteConsentRegistry = {
  revision: "owner-2026-09-25-v1",
  entries: [
    { repository: "remudero", state: "active", scope: "aggregate-public", approvedOn: "2026-09-25", approvedBy: "owner" },
    { repository: "remudero-console", state: "active", scope: "aggregate-public", approvedOn: "2026-09-25", approvedBy: "owner" },
    { repository: "remudero-site", state: "active", scope: "aggregate-public", approvedOn: "2026-09-25", approvedBy: "owner" },
  ],
};

export interface ModelFieldNoteRow {
  modelId: string;
  taskClass: string;
  assigned: number;
  servedObserved: number;
  callOutcomeObserved: number;
  verified: { state: "unavailable"; reason: "no-verified-outcome-join" };
}

/** The note body without the review fields the site stamps. */
export interface ModelFieldNoteBody {
  schema: typeof MODEL_FIELD_NOTE_SCHEMA;
  releaseId: string;
  status: "published";
  publicationScope: "public-opt-in";
  evidence: "observational";
  windowStart: string;
  windowEnd: string;
  asOf: string;
  sourceDigest: string;
  sourceRepos: string[];
  consentRegistryRevision: string;
  rows: ModelFieldNoteRow[];
}

export interface ModelFieldNoteCandidate {
  version: typeof FIELD_NOTE_CANDIDATE_VERSION;
  state: "candidate-unreviewed";
  createdAt: string;
  snapshotAsOf: string;
  disclosure: { minCell: number; minAssigned: number; rowLimit: number };
  sources: { source: string; receiptHash: string }[];
  withheld: { cells: number; reasons: Record<string, number>; sources: { source: string; reason: string }[] };
  servedModelGap: { assigned: number; servedObserved: number;
    rows: { modelId: string; taskClass: string; assigned: number; servedObserved: number; servedUnknown: number }[] };
  note: ModelFieldNoteBody;
}

export interface FieldNoteWindow {
  releaseId: string;
  windowStart: string;
  windowEnd: string;
  sourceRepos: string[];
  sourceDigest: string;
  consentReceipts: string[];
  createdAt: string;
}

/** Private: every window core exported, so the next one starts where the last ended. */
export interface FieldNoteWindows {
  version: typeof FIELD_NOTE_WINDOWS_VERSION;
  windows: FieldNoteWindow[];
}

export type ModelFieldNoteResult =
  | { state: "candidate"; candidate: ModelFieldNoteCandidate; window: FieldNoteWindow }
  | { state: "withheld" | "refused"; reason: string; withheld?: ModelFieldNoteCandidate["withheld"] };

export interface ModelFieldNoteInput {
  snapshot: FieldTrialsFlowSnapshot;
  consent: FieldTrialsConsent | string | null;
  registry: SiteConsentRegistry | string;
  windows: FieldNoteWindows;
  salt: string;
  nowIso: string;
}

const DAY_MS = 86_400_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function msIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The site's publishableCount: a positive small subgroup, or a small complement, is never shown. */
export function sitePublishableCount(value: number, denominator: number, minCell: number = SITE_MIN_CELL): boolean {
  return (value === 0 || value >= minCell) && (denominator - value === 0 || denominator - value >= minCell);
}

/** Why a row fails the site's disclosure rule, or null when it may be shown. */
export function siteRowDisclosure(row: Pick<ModelFieldNoteRow, "assigned" | "servedObserved" | "callOutcomeObserved">,
  minCell: number = SITE_MIN_CELL): string | null {
  if (row.assigned < minCell * 2) return "assigned-below-twice-min-cell";
  if (!sitePublishableCount(row.servedObserved, row.assigned, minCell)) return "served-observed-or-complement-small";
  if (!sitePublishableCount(row.callOutcomeObserved, row.assigned, minCell)) return "call-outcome-or-complement-small";
  return null;
}

export function parseSiteConsentRegistry(value: unknown): SiteConsentRegistry | string {
  const registry = record(value);
  if (typeof registry?.revision !== "string" || registry.revision.length === 0 || !Array.isArray(registry.entries)) return "site-registry-invalid";
  const valid = registry.entries.every((entry) => {
    const item = record(entry);
    return typeof item?.repository === "string" && SITE_SAFE_ID_RE.test(item.repository)
      && (item.state === "active" || item.state === "revoked") && item.scope === "aggregate-public";
  });
  return valid ? registry as unknown as SiteConsentRegistry : "site-registry-invalid";
}

/** An absent or unreadable record is no prior window; a malformed one is refused rather than ignored. */
export function parseFieldNoteWindows(value: unknown): FieldNoteWindows | string {
  const windows = record(value);
  if (windows === undefined || windows.unreadable !== undefined) return { version: FIELD_NOTE_WINDOWS_VERSION, windows: [] };
  if (windows.version !== FIELD_NOTE_WINDOWS_VERSION || !Array.isArray(windows.windows)
    || !windows.windows.every((entry) => typeof record(entry)?.windowEnd === "string"
      && Number.isFinite(Date.parse(String(record(entry)!.windowEnd))))) return "field-note-windows-invalid";
  return windows as unknown as FieldNoteWindows;
}

/** The site names repositories bare; core names them owner/repo. */
function siteRepoOf(repo: string): string {
  return repo.split("/").at(-1)!.toLowerCase();
}

/** Every string the candidate carries, keys included, for the private-key scan. */
function candidateStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) candidateStrings(item, out);
  else if (record(value)) for (const [key, item] of Object.entries(value as Record<string, unknown>)) { out.push(key); candidateStrings(item, out); }
  return out;
}

/**
 * Build the site candidate from one snapshot. Rows are selected model x task class over whole UTC days
 * from the end of the last exported window (or the first observed day) to the start of the snapshot's
 * own, still-partial, UTC day. Pure: the caller reads and writes every file.
 */
export function buildModelFieldNoteCandidate(input: ModelFieldNoteInput): ModelFieldNoteResult {
  const { snapshot, consent, registry, windows, salt, nowIso } = input;
  if (consent === null) return { state: "withheld", reason: "no-consent-receipt" };
  if (typeof consent === "string") return { state: "withheld", reason: consent };
  if (typeof registry === "string") return { state: "withheld", reason: registry };
  if (snapshot.state === "unavailable") return { state: "refused", reason: "snapshot-unavailable" };
  const pseudonym = (value: string) => `src-${createHmac("sha256", salt).update(value).digest("hex").slice(0, 12)}`;
  const siteEntries = new Map(registry.entries.map((entry) => [entry.repository, entry]));
  const included = new Map<string, string>();
  const sources: ModelFieldNoteCandidate["sources"] = [];
  const receipts: string[] = [];
  const withheldSources: ModelFieldNoteCandidate["withheld"]["sources"] = [];
  for (const source of snapshot.provenance.sources) {
    const grant = consent.repos.find((entry) => entry.repo.toLowerCase() === source.repo.toLowerCase() && entry.revoked !== true
      && (entry.rights === "aggregate-opt-in" || entry.rights === "public-benchmark"));
    const siteRepo = siteRepoOf(source.repo);
    const site = siteEntries.get(siteRepo);
    const reason = grant === undefined ? "no-aggregate-consent"
      : site?.state !== "active" || site.scope !== "aggregate-public" ? "not-active-in-site-registry" : null;
    if (reason !== null) { withheldSources.push({ source: pseudonym(source.label), reason }); continue; }
    included.set(source.label, siteRepo);
    const receiptHash = sha256(grant!.receipt);
    receipts.push(receiptHash);
    sources.push({ source: pseudonym(source.label), receiptHash });
  }
  if (included.size === 0) return { state: "withheld", reason: "no-aggregate-consent" };
  const partitions = Object.entries(snapshot.families.adoption).flatMap(([key, partition]) => {
    const [label, , day, taskClass] = key.split("|");
    return included.has(label!) && /^\d{4}-\d\d-\d\d$/.test(day!) ? [{ key, label: label!, dayMs: Date.parse(`${day}T00:00:00.000Z`),
      taskClass: taskClass!, partition }] : [];
  });
  if (partitions.some(({ partition }) => record(partition.cells.bySelected) === undefined)) {
    return { state: "refused", reason: "snapshot-predates-selected-model-cross-tab" };
  }
  const windowEndMs = Math.floor(Date.parse(snapshot.asOf) / DAY_MS) * DAY_MS;
  const priorEnd = windows.windows.map((entry) => Date.parse(entry.windowEnd)).sort((a, b) => b - a)[0];
  const firstDay = partitions.map((entry) => entry.dayMs).sort((a, b) => a - b)[0];
  const windowStartMs = priorEnd ?? firstDay;
  if (windowStartMs === undefined) return { state: "withheld", reason: "no-observed-assignment-day" };
  if (windowStartMs >= windowEndMs) return { state: "withheld", reason: "no-new-whole-utc-day" };
  const inWindow = partitions.filter((entry) => entry.dayMs >= windowStartMs && entry.dayMs < windowEndMs);
  const totals = new Map<string, { modelId: string; taskClass: string } & AdoptionSelectedCell>();
  const reasons: Record<string, number> = {};
  const withhold = (reason: string) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  for (const { taskClass, partition } of inWindow) {
    for (const [modelId, cell] of Object.entries(partition.cells.bySelected)) {
      const id = JSON.stringify([modelId, taskClass]);
      const total = totals.get(id) ?? { modelId, taskClass, assigned: 0, servedKnown: 0, callOutcomeKnown: 0 };
      total.assigned += cell.assigned;
      total.servedKnown += cell.servedKnown;
      total.callOutcomeKnown += cell.callOutcomeKnown;
      totals.set(id, total);
    }
  }
  const gapRows: ModelFieldNoteCandidate["servedModelGap"]["rows"] = [];
  const publishable: ModelFieldNoteRow[] = [];
  for (const total of [...totals.values()].sort((a, b) => a.modelId.localeCompare(b.modelId) || a.taskClass.localeCompare(b.taskClass))) {
    if (!SITE_SAFE_ID_RE.test(total.modelId)) { withhold("model-id-not-site-safe"); continue; }
    if (total.taskClass === "unknown" || !SITE_SAFE_ID_RE.test(total.taskClass)) { withhold("task-class-unknown-or-unsafe"); continue; }
    const row: ModelFieldNoteRow = { modelId: total.modelId, taskClass: total.taskClass, assigned: total.assigned,
      servedObserved: total.servedKnown, callOutcomeObserved: total.callOutcomeKnown,
      verified: { state: "unavailable", reason: "no-verified-outcome-join" } };
    const failure = siteRowDisclosure(row);
    if (failure !== null) { withhold(failure); continue; }
    publishable.push(row);
  }
  // Deterministic: the largest cells first, ties by model then task class.
  publishable.sort((a, b) => b.assigned - a.assigned || a.modelId.localeCompare(b.modelId) || a.taskClass.localeCompare(b.taskClass));
  const overLimit = publishable.splice(SITE_ROW_LIMIT).length;
  if (overLimit > 0) reasons["row-limit"] = overLimit;
  const withheld = { cells: Object.values(reasons).reduce((sum, n) => sum + n, 0), reasons, sources: withheldSources };
  if (publishable.length === 0) return { state: "withheld", reason: "no-publishable-row", withheld };
  for (const row of publishable) gapRows.push({ modelId: row.modelId, taskClass: row.taskClass, assigned: row.assigned,
    servedObserved: row.servedObserved, servedUnknown: row.assigned - row.servedObserved });
  const windowStart = msIso(windowStartMs);
  const windowEnd = msIso(windowEndMs);
  const sourceDigest = sha256(inWindow.map((entry) => `${entry.key}\n${entry.partition.inputHash}`).sort().join("\n"));
  const sourceRepos = [...new Set(included.values())].sort();
  const body: ModelFieldNoteBody = { schema: MODEL_FIELD_NOTE_SCHEMA, releaseId: "", status: "published",
    publicationScope: "public-opt-in", evidence: "observational", windowStart, windowEnd, asOf: msIso(Date.parse(snapshot.asOf)),
    sourceDigest, sourceRepos, consentRegistryRevision: registry.revision, rows: publishable };
  body.releaseId = `fn-${windowStart.slice(0, 10)}-${windowEnd.slice(0, 10)}-${sha256(JSON.stringify(body)).slice(0, 12)}`;
  const candidate: ModelFieldNoteCandidate = { version: FIELD_NOTE_CANDIDATE_VERSION, state: "candidate-unreviewed",
    createdAt: msIso(Date.parse(nowIso)), snapshotAsOf: body.asOf,
    disclosure: { minCell: SITE_MIN_CELL, minAssigned: SITE_MIN_CELL * 2, rowLimit: SITE_ROW_LIMIT }, sources, withheld,
    servedModelGap: { assigned: gapRows.reduce((sum, row) => sum + row.assigned, 0),
      servedObserved: gapRows.reduce((sum, row) => sum + row.servedObserved, 0), rows: gapRows }, note: body };
  const strings = candidateStrings(candidate);
  if (snapshot.privateKeys.some((key) => key.length >= 6 && strings.some((value) => value.includes(key)))) {
    return { state: "refused", reason: "private-join-key-in-candidate" };
  }
  return { state: "candidate", candidate, window: { releaseId: body.releaseId, windowStart, windowEnd, sourceRepos, sourceDigest,
    consentReceipts: receipts.sort(), createdAt: candidate.createdAt } };
}
