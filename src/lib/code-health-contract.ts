import { fixedClock } from "./clock.js";

export const CODE_HEALTH_VERSION = "code-health-v1" as const;
export const CODE_HEALTH_SOURCE_KINDS = ["quality", "coverage"] as const;
export type ContractResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface CodeHealthAssessment {
  version: typeof CODE_HEALTH_VERSION;
  repository: string;
  analyzedSha: string;
  currentSha: string;
  baselineSha: string | null;
  policyVersion: string;
  observedAt: string;
  nextDueAt: string | null;
  state: "measured" | "partial" | "stale" | "not_collected" | "unavailable";
  sources: Array<{
    id: string; kind: string; required: boolean; state: "complete" | "partial" | "stale" | "not_collected" | "unavailable";
    analyzedSha: string | null; observedAt: string | null; scopeHash: string | null;
    toolVersion: string | null; rulesVersion: string | null; configHash: string | null;
    baseline: null | { sha: string; scopeHash: string; toolVersion: string; rulesVersion: string; configHash: string };
    exclusions: string[]; reason: string | null;
  }>;
  checks: Array<{ id: string; category: "maintainability" | "security" | "reliability" | "tests"; state: "met" | "not_met" | "not_measured"; sourceIds: string[]; reason: string }>;
  findings: Array<{ fingerprint: string; sourceId: string; severity: "critical" | "high" | "medium" | "low"; category: string; status: "new" | "existing" | "unknown"; path: string; title: string; effortMinutes: number | null; estimateKind: "modeled" | null }>;
  summary: { met: number; assessed: number; expected: number; healthy: boolean | null };
}

export function codeHealthSourceRequirements(): readonly string[] {
  return [...CODE_HEALTH_SOURCE_KINDS];
}

/** Required expectations do not assert that any scanner is configured or has run. */
export function validateCodeHealthSourceRequirements(value: unknown): ContractResult<string[]> {
  return Array.isArray(value) && value.length === CODE_HEALTH_SOURCE_KINDS.length && CODE_HEALTH_SOURCE_KINDS.every((kind) => value.includes(kind))
    ? { ok: true, value } : { ok: false, reason: "invalid expected code health sources" };
}

type Fields = Record<string, unknown>;
const text = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0");
const record = (v: unknown): v is Fields => v !== null && typeof v === "object" && !Array.isArray(v);
const only = (v: Fields, keys: string): boolean => Object.keys(v).every((k) => keys.split(" ").includes(k));
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/i.test(v);
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function timestamp(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) || !Number.isFinite(Date.parse(v))) return false;
  const canonical = fixedClock(Date.parse(v)).iso();
  return v === canonical || v === canonical.replace(".000Z", "Z");
}
const strings = (v: unknown, max = 128): v is string[] => Array.isArray(v) && v.length <= max && v.every((s) => text(s));
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const repository = (v: unknown): v is string => text(v, 140) && /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(v) && ![".", ".."].includes(v.split("/")[1]!);

function sourceShape(v: unknown, a: CodeHealthAssessment): v is CodeHealthAssessment["sources"][number] {
  if (!record(v) || !only(v, "id kind required state analyzedSha observedAt scopeHash toolVersion rulesVersion configHash baseline exclusions reason")) return false;
  if (!text(v.id) || !text(v.kind, 64) || typeof v.required !== "boolean" || !["complete", "partial", "stale", "not_collected", "unavailable"].includes(String(v.state))) return false;
  if (!(v.analyzedSha === null || sha(v.analyzedSha)) || !(v.observedAt === null || timestamp(v.observedAt))) return false;
  if (v.observedAt !== null && Date.parse(v.observedAt as string) > Date.parse(a.observedAt)) return false;
  if (![v.scopeHash, v.toolVersion, v.rulesVersion, v.configHash].every((x) => x === null || text(x))) return false;
  if (!strings(v.exclusions) || !(v.reason === null || text(v.reason, 2048))) return false;
  if (v.state !== "complete" && !text(v.reason, 2048)) return false;
  if (v.state === "complete" && (!sha(v.analyzedSha) || !timestamp(v.observedAt) || ![v.scopeHash, v.toolVersion, v.rulesVersion, v.configHash].every((x) => text(x)))) return false;
  if (v.baseline !== null) {
    const b = v.baseline;
    if (!record(b) || !only(b, "sha scopeHash toolVersion rulesVersion configHash") || !sha(b.sha) || ![b.scopeHash, b.toolVersion, b.rulesVersion, b.configHash].every((x) => text(x))) return false;
  }
  return true;
}

function comparable(s: CodeHealthAssessment["sources"][number], a: CodeHealthAssessment): boolean {
  const b = s.baseline;
  return s.state === "complete" && s.analyzedSha === a.analyzedSha && b !== null && b.sha === a.baselineSha &&
    b.scopeHash === s.scopeHash && b.toolVersion === s.toolVersion && b.rulesVersion === s.rulesVersion && b.configHash === s.configHash;
}

function checkShape(v: unknown): v is CodeHealthAssessment["checks"][number] {
  return record(v) && only(v, "id category state sourceIds reason") && text(v.id) &&
    ["maintainability", "security", "reliability", "tests"].includes(String(v.category)) &&
    ["met", "not_met", "not_measured"].includes(String(v.state)) && strings(v.sourceIds) && unique(v.sourceIds) && text(v.reason, 2048);
}

function findingShape(v: unknown): v is CodeHealthAssessment["findings"][number] {
  return record(v) && only(v, "fingerprint sourceId severity category status path title effortMinutes estimateKind") &&
    text(v.fingerprint) && text(v.sourceId) && ["critical", "high", "medium", "low"].includes(String(v.severity)) &&
    text(v.category, 64) && ["new", "existing", "unknown"].includes(String(v.status)) && text(v.title, 2048) &&
    text(v.path, 4096) && !v.path.startsWith("/") && !v.path.includes("\\") && v.path.split("/").every((s) => s !== ".." && s !== "") &&
    ((v.effortMinutes === null && v.estimateKind === null) || (typeof v.effortMinutes === "number" && Number.isFinite(v.effortMinutes) && v.effortMinutes >= 0 && v.estimateKind === "modeled"));
}

/** Validates evidence and cross-field meaning; it does not collect scans or choose score thresholds. */
export function validateCodeHealthAssessment(value: unknown): ContractResult<CodeHealthAssessment> {
  const fail = (reason: string): ContractResult<CodeHealthAssessment> => ({ ok: false, reason });
  if (!record(value) || !only(value, "version repository analyzedSha currentSha baselineSha policyVersion observedAt nextDueAt state sources checks findings summary")) return fail("invalid assessment fields");
  if (value.version !== CODE_HEALTH_VERSION || !repository(value.repository) || !sha(value.analyzedSha) || !sha(value.currentSha) || !(value.baselineSha === null || sha(value.baselineSha)) || !text(value.policyVersion)) return fail("invalid assessment identity");
  if (!timestamp(value.observedAt) || !(value.nextDueAt === null || timestamp(value.nextDueAt)) || !["measured", "partial", "stale", "not_collected", "unavailable"].includes(String(value.state))) return fail("invalid assessment clock or state");
  const a = value as unknown as CodeHealthAssessment;
  if (!Array.isArray(a.sources) || a.sources.length > 128 || !a.sources.every((s) => sourceShape(s, a)) || !unique(a.sources.map((s) => s.id))) return fail("invalid or duplicate scan sources");
  if (!Array.isArray(a.checks) || a.checks.length > 256 || !a.checks.every(checkShape) || !unique(a.checks.map((c) => c.id))) return fail("invalid or duplicate assessment checks");
  const sources = new Map(a.sources.map((s) => [s.id, s]));
  for (const c of a.checks) {
    if (!c.sourceIds.every((id) => sources.has(id))) return fail("check references an unknown source");
    if (c.state !== "not_measured" && (!c.sourceIds.length || !c.sourceIds.every((id) => sources.get(id)!.state === "complete" && sources.get(id)!.analyzedSha === a.analyzedSha))) return fail("assessed check lacks source evidence for its commit");
    if (c.state === "met" && !c.sourceIds.every((id) => comparable(sources.get(id)!, a))) return fail("passing check lacks comparable baseline evidence");
  }
  if (!Array.isArray(a.findings) || a.findings.length > 1000 || !a.findings.every(findingShape) || !unique(a.findings.map((f) => f.fingerprint))) return fail("invalid or duplicate findings");
  for (const f of a.findings) {
    const s = sources.get(f.sourceId);
    if (!s || (f.status !== "unknown" && !comparable(s, a))) return fail("finding classification lacks comparable source evidence");
  }
  const s = a.summary;
  if (!record(s) || !only(s, "met assessed expected healthy") || !natural(s.met) || !natural(s.assessed) || !natural(s.expected) || ![true, false, null].includes(s.healthy)) return fail("invalid assessment summary");
  if (s.met !== a.checks.filter((c) => c.state === "met").length || s.assessed !== a.checks.filter((c) => c.state !== "not_measured").length || s.expected !== a.checks.length) return fail("summary must count the declared checks without dropping missing ones");
  const complete = a.currentSha === a.analyzedSha && CODE_HEALTH_SOURCE_KINDS.every((kind) => a.sources.some((source) => source.kind === kind && source.required && comparable(source, a))) && a.sources.filter((source) => source.required).every((source) => comparable(source, a));
  if (a.state === "measured" && (!complete || s.assessed !== s.expected || !s.expected)) return fail("measured assessment has missing or incomparable evidence");
  if (s.healthy === true && (a.state !== "measured" || !complete || !s.expected || s.met !== s.expected)) return fail("healthy assessment requires complete comparable evidence and passing policy checks");
  if (s.healthy === false && s.met === s.assessed) return fail("unhealthy assessment needs an observed failing policy check");
  return { ok: true, value: a };
}
