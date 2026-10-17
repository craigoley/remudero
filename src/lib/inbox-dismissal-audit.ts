type Coverage = "observed" | "partial" | "unavailable";
export type InboxDismissalScope = { instance: string; repository: string; proposalId: string; taskId: string | null };
type Scope = InboxDismissalScope;
export type InboxDismissalReceipt = { id: string; kind: "retire" | "restore" | "outcome"; scope: Scope; snapshotKey: string; at: string;
  authority?: "operator" | "automatic"; heldAtRetirement?: boolean; retirementId?: string;
  operator?: string; intentId?: string;
  outcome?: "false_dismissal" | "terminal_confirmed"; evidence?: string };
type Receipt = InboxDismissalReceipt;
export interface InboxDismissalAuditInput {
  scope?: { instance: string; repository: string };
  window: { from: string; to: string };
  coverage: { receipts: Coverage; outcomes: Coverage; plan: Coverage; registry: Coverage };
  controls: { heldSecurity: { taskId: string; observed: boolean; passed: boolean }; terminalMechanical: { observed: boolean; passed: boolean } };
  receipts: readonly unknown[];
}
/** BACKSTOP: bounded public evidence rows; the entire eligible corpus is still audited and counted. */
export const INBOX_DISMISSAL_SAMPLE_LIMIT = 100;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const stamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function inboxDismissalReceipt(raw: unknown): Receipt | undefined {
  const value = object(raw), scope = object(value.scope);
  if (!id(value.id) || !stamp(value.at) || !hash(value.snapshotKey) || !id(scope.instance) || !id(scope.repository)
    || !id(scope.proposalId) || !(scope.taskId === null || id(scope.taskId))
    || (value.kind !== "retire" && value.kind !== "restore" && value.kind !== "outcome")) return undefined;
  if (value.kind === "retire" && value.authority !== "operator" && value.authority !== "automatic") return undefined;
  if (value.kind !== "retire" && !id(value.retirementId)) return undefined;
  if (value.kind === "outcome" && ((value.outcome !== "false_dismissal" && value.outcome !== "terminal_confirmed") || !id(value.evidence))) return undefined;
  if (value.heldAtRetirement !== undefined && typeof value.heldAtRetirement !== "boolean") return undefined;
  if (value.operator !== undefined && !id(value.operator) || value.intentId !== undefined && !id(value.intentId)) return undefined;
  return { id: value.id, kind: value.kind, scope: scope as Scope, snapshotKey: value.snapshotKey, at: value.at,
    ...(value.authority === "operator" || value.authority === "automatic" ? { authority: value.authority } : {}),
    ...(typeof value.heldAtRetirement === "boolean" ? { heldAtRetirement: value.heldAtRetirement } : {}),
    ...(id(value.retirementId) ? { retirementId: value.retirementId } : {}),
    ...(id(value.operator) ? { operator: value.operator } : {}), ...(id(value.intentId) ? { intentId: value.intentId } : {}),
    ...(value.kind === "outcome" ? { outcome: value.outcome as Receipt["outcome"], evidence: value.evidence as string } : {}) };
}
const scopeKey = (scope: Scope): string => JSON.stringify([scope.repository, scope.instance, scope.proposalId, scope.taskId]);
const retirementKey = (receipt: Receipt, retirementId = receipt.id): string => JSON.stringify([scopeKey(receipt.scope), receipt.snapshotKey, retirementId]);

/** A read-only audit: missing coverage and missing outcomes never certify zero false dismissal. */
export function buildInboxDismissalAudit(input: InboxDismissalAuditInput) {
  let unqualified = 0, foreign = 0, duplicates = 0, conflicting = 0;
  const records = new Map<string, Receipt>(), conflicted = new Set<string>();
  for (const raw of input.receipts) {
    const receipt = inboxDismissalReceipt(raw);
    if (!receipt) { unqualified++; continue; }
    if (receipt.scope.repository !== input.scope?.repository || receipt.scope.instance !== input.scope?.instance) { foreign++; continue; }
    const key = JSON.stringify([receipt.scope.repository, receipt.scope.instance, receipt.id]);
    const prior = records.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(receipt)) { conflicting++; conflicted.add(key); continue; }
    if (prior) { duplicates++; continue; }
    records.set(key, receipt);
  }
  const valid = [...records].filter(([key]) => !conflicted.has(key)).map(([, receipt]) => receipt);
  const from = Date.parse(input.window.from), to = Date.parse(input.window.to);
  const retired = valid.filter(receipt => receipt.kind === "retire" && Date.parse(receipt.at) >= from && Date.parse(receipt.at) <= to);
  const laterByRetirement = new Map<string, Receipt[]>();
  for (const receipt of valid.filter(receipt => receipt.kind !== "retire")) {
    const key = retirementKey(receipt, receipt.retirementId);
    laterByRetirement.set(key, [...(laterByRetirement.get(key) ?? []), receipt]);
  }
  const observed = { falseDismissals: 0, terminalConfirmed: 0, restored: 0, unresolved: 0 };
  const rows = retired.map(retirement => {
    const later = (laterByRetirement.get(retirementKey(retirement)) ?? []).filter(receipt =>
      Date.parse(receipt.at) >= Date.parse(retirement.at) && Date.parse(receipt.at) <= to);
    const restored = later.some(receipt => receipt.kind === "restore");
    const failed = retirement.authority === "automatic" && retirement.heldAtRetirement === true
      || later.some(receipt => receipt.outcome === "false_dismissal");
    const terminal = !failed && later.some(receipt => receipt.outcome === "terminal_confirmed");
    if (restored) observed.restored++;
    if (failed) observed.falseDismissals++;
    else if (terminal) observed.terminalConfirmed++;
    else observed.unresolved++;
    return { receiptId: retirement.id, proposalId: retirement.scope.proposalId, taskId: retirement.scope.taskId, snapshotKey: retirement.snapshotKey,
      retiredAt: retirement.at, outcome: failed ? "false_dismissal" as const : terminal ? "terminal_confirmed" as const : "unresolved" as const,
      restored, evidence: later.filter(receipt => receipt.evidence).map(receipt => receipt.evidence!).slice(0, 3) };
  });
  const controlsObserved = input.controls.heldSecurity.taskId === "W1-T216" && input.controls.heldSecurity.observed && input.controls.heldSecurity.passed
    && input.controls.terminalMechanical.observed && input.controls.terminalMechanical.passed;
  const measurable = id(input.scope?.instance) && id(input.scope?.repository) && Number.isFinite(from) && Number.isFinite(to) && from <= to
    && ["receipts", "outcomes", "plan", "registry"].every(key => input.coverage[key as keyof typeof input.coverage] === "observed") && controlsObserved
    && unqualified === 0 && conflicting === 0 && observed.unresolved === 0;
  return { contract: "inbox-dismissal-audit-v1" as const, state: measurable ? "measured" as const : "unmeasurable" as const,
    scope: input.scope ?? { instance: null, repository: null }, window: input.window, coverage: input.coverage, controls: input.controls,
    denominator: { eligible: retired.length, sampled: retired.length, returned: Math.min(rows.length, INBOX_DISMISSAL_SAMPLE_LIMIT), unqualified, foreign, duplicates, conflicting },
    observed, measurement: { falseDismissals: measurable ? observed.falseDismissals : null,
      falseDismissalRate: measurable && retired.length > 0 ? observed.falseDismissals / retired.length : null },
    items: rows.slice(0, INBOX_DISMISSAL_SAMPLE_LIMIT), truncated: rows.length > INBOX_DISMISSAL_SAMPLE_LIMIT };
}
export type InboxDismissalAudit = ReturnType<typeof buildInboxDismissalAudit>;

/** Qualified receipts retain their own immutable identity; legacy rows are counted as unqualified. */
export function inboxDismissalReceipts(rows: readonly Record<string, unknown>[]): unknown[] {
  return rows.flatMap(row => row.dismissalAuditReceipt !== undefined ? [row.dismissalAuditReceipt]
    : row.step === "panel.proposal_declined" || row.step === "panel.proposal_restored" || (row.step === "ratify.approved" && row.released === "verify-human") ? [{}] : []);
}

export function validInboxDismissalAudit(raw: unknown): InboxDismissalAudit | undefined {
  const value = object(raw), denominator = object(value.denominator), observed = object(value.observed), measurement = object(value.measurement);
  const scope = object(value.scope), window = object(value.window), coverage = object(value.coverage), controls = object(value.controls);
  const held = object(controls.heldSecurity), terminal = object(controls.terminalMechanical);
  const count = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
  if (value.contract !== "inbox-dismissal-audit-v1" || (value.state !== "measured" && value.state !== "unmeasurable")
    || !["instance", "repository"].every(key => scope[key] === null || id(scope[key])) || !stamp(window.from) || !stamp(window.to)
    || !["receipts", "outcomes", "plan", "registry"].every(key => ["observed", "partial", "unavailable"].includes(String(coverage[key])))
    || held.taskId !== "W1-T216" || ![held.observed, held.passed, terminal.observed, terminal.passed].every(x => typeof x === "boolean")
    || !["eligible", "sampled", "returned", "unqualified", "foreign", "duplicates", "conflicting"].every(key => count(denominator[key]))
    || !["falseDismissals", "terminalConfirmed", "restored", "unresolved"].every(key => count(observed[key]))
    || !(measurement.falseDismissals === null || count(measurement.falseDismissals))
    || !(measurement.falseDismissalRate === null || typeof measurement.falseDismissalRate === "number" && Number.isFinite(measurement.falseDismissalRate) && measurement.falseDismissalRate >= 0 && measurement.falseDismissalRate <= 1)
    || !Array.isArray(value.items) || value.items.length > INBOX_DISMISSAL_SAMPLE_LIMIT || typeof value.truncated !== "boolean") return undefined;
  if (value.state === "unmeasurable" && (measurement.falseDismissals !== null || measurement.falseDismissalRate !== null)) return undefined;
  if (Date.parse(String(window.from)) > Date.parse(String(window.to))) return undefined;
  if (value.state === "measured" && (!id(scope.instance) || !id(scope.repository) || measurement.falseDismissals === null || !Object.values(coverage).every(x => x === "observed")
    || !held.observed || !held.passed || !terminal.observed || !terminal.passed || Number(observed.unresolved) !== 0
    || Number(denominator.unqualified) !== 0 || Number(denominator.conflicting) !== 0)) return undefined;
  if (denominator.sampled !== denominator.eligible || denominator.returned !== value.items.length
    || denominator.returned !== Math.min(Number(denominator.sampled), INBOX_DISMISSAL_SAMPLE_LIMIT)
    || value.truncated !== (Number(denominator.sampled) > INBOX_DISMISSAL_SAMPLE_LIMIT)
    || Number(observed.falseDismissals) + Number(observed.terminalConfirmed) + Number(observed.unresolved) !== denominator.sampled
    || Number(observed.restored) > Number(denominator.sampled)) return undefined;
  if (value.state === "measured" && (measurement.falseDismissals !== observed.falseDismissals
    || measurement.falseDismissalRate !== (Number(denominator.sampled) === 0 ? null : Number(observed.falseDismissals) / Number(denominator.sampled)))) return undefined;
  for (const item of value.items) {
    const row = object(item);
    if (!id(row.receiptId) || !id(row.proposalId) || !(row.taskId === null || id(row.taskId)) || !hash(row.snapshotKey) || !stamp(row.retiredAt)
      || !["false_dismissal", "terminal_confirmed", "unresolved"].includes(String(row.outcome)) || typeof row.restored !== "boolean"
      || !Array.isArray(row.evidence) || row.evidence.length > 3 || !row.evidence.every(id)) return undefined;
  }
  return value as unknown as InboxDismissalAudit;
}
