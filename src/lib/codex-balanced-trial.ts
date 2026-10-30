import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { aaStackHash, parseAaTrialManifest, type AaTrialManifest, type BenchmarkAaCommandInput } from "./benchmark-aa.js";
import { listProspectiveAaRegistrations, prospectiveAaDir, type ProspectiveAaProtocol } from "./benchmark-aa-prospective.js";
import { citeAaReceipt, paidArmPauseReasons, parsePaidPilotRequest, PAID_PILOT_CASH_CEILING_USD,
  PAID_PILOT_STOPPING_RULE, PAID_PILOT_WINDOW_MS, type PaidPilotAaCitation, type PaidPilotEvidence,
  type PaidPilotProtocol, type PaidPilotRequest } from "./benchmark-paid-pilot.js";
import { systemClock, type Clock } from "./clock.js";
import { loadConfig } from "./config.js";
import { readCodexModelCatalog } from "./model-availability.js";

const SOL = "gpt-6.1-sol";
const TERRA = "gpt-6.1-terra";
const VERSION = "codex-balanced-trial-v1";
const GUARDRAILS = ["recovery.repairRunsObserved", "laterDefects", "missingness.servedModel", "missingness.billingMode",
  "missingness.cost", "accounting.cashEstimate"] as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface CodexBalancedTrialRequest {
  phase: "aa" | "ab";
  manifest: AaTrialManifest;
  selections: { task_id: string; worker_assignment: { selected: { provider: string; effort: string };
    routing: { decision?: { capability?: string } } } }[];
  pilotRequest: unknown;
}

export interface CodexBalancedTrialInput {
  stateDir: string;
  request: unknown;
  // The CLI owns the readiness runtime; registration supplies the pinned request and never runs pairs.
  readiness: (request: { stateDir: string; trialId: string; manifest: AaTrialManifest; maxPairs: 0; clock: Clock }) => Promise<{
    state: "receipt-emitted" | "withheld" | "refused";
    refusals: string[];
    receipt: { state: "emitted" | "withheld" };
  }>;
  clock?: Clock;
  readCatalog?: () => Promise<string[]>;
}

interface RegisteredPopulation {
  denominator: number;
  eligible: { taskId: string }[];
  digest: string;
}

export interface CodexBalancedTrialProtocol {
  version: typeof VERSION;
  trialId: string;
  registeredAt: string;
  lead: typeof SOL;
  liveAssignment: false;
  assignment: { unit: "task"; method: "sha256(benchmark-aa-allocation-v1, seed, taskId) parity"; allocation: { control: 0.5; paid: 0.5 } };
  primaryOutcome: "verified-completion";
  analysis: "intention-to-treat";
  guardrails: typeof GUARDRAILS;
  stoppingRule: typeof PAID_PILOT_STOPPING_RULE;
  cash: { ceilingUsd: number; windowMs: number; api: "reserve-before-each-attempt"; subscriptionUsd: 0 };
  aa: { protocolDigest: string; populationDigest: string; receipt: PaidPilotAaCitation };
  pilotRequest: PaidPilotRequest;
  digest: string;
}

type Refusal = { ok: false; reason: string };
export type CodexBalancedTrialResult = Refusal
  | { ok: true; phase: "aa"; protocol: ProspectiveAaProtocol; population: RegisteredPopulation }
  | { ok: true; phase: "ab"; protocol: CodexBalancedTrialProtocol; path: string };
const refuse = (reason: string): Refusal => ({ ok: false, reason });

function readJson(path: string, name: string): { ok: true; value: unknown } | Refusal {
  try { return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) }; }
  catch (error) {
    const reason = `${name}-unreadable:${(error as NodeJS.ErrnoException).code ?? "invalid-json"}`;
    return refuse(reason);
  }
}

function parseRequest(value: unknown): { ok: true; request: CodexBalancedTrialRequest; manifest: AaTrialManifest } | Refusal {
  if (value === null || typeof value !== "object") return refuse("request-invalid");
  const request = value as CodexBalancedTrialRequest;
  if (request.phase !== "aa" && request.phase !== "ab") return refuse("phase-invalid");
  const parsed = parseAaTrialManifest(request.manifest);
  if (!parsed.ok) return parsed;
  const { stack } = parsed.manifest;
  if (stack.provider !== "codex" || stack.model !== SOL || !["low", "medium"].includes(stack.effort))
    return refuse("aa-needs-codex-sol-balanced-low-or-medium");
  if (!Array.isArray(request.selections)) return refuse("selection-evidence-missing");
  const selections = new Map<string, CodexBalancedTrialRequest["selections"][number]>();
  for (const row of request.selections) {
    if (typeof row?.task_id !== "string" || selections.has(row.task_id)) return refuse("selection-evidence-invalid-or-duplicated");
    selections.set(row.task_id, row);
  }
  const tasks = parsed.manifest.tasks.filter(task => {
    const assignment = selections.get(task.taskId)?.worker_assignment;
    return assignment?.selected?.provider === "codex" && assignment.routing?.decision?.capability === "balanced"
      && assignment.selected.effort === stack.effort;
  });
  if (tasks.length === 0) return refuse("codex-balanced-population-empty");
  return { ok: true, request, manifest: { ...parsed.manifest, tasks, labels: ["A1", "A2"] } };
}

function registeredAa(stateDir: string, manifest: AaTrialManifest) {
  const listing = listProspectiveAaRegistrations(stateDir);
  if (listing.state !== "read") return refuse(`aa-registrations-unreadable:${listing.reason}`);
  const entry = listing.registrations.find(row => row.trialId === manifest.trialId);
  if (entry?.protocol === undefined || entry.protocol === null) return refuse(entry?.reason ?? "aa-registration-missing");
  const protocol = entry.protocol;
  if (aaStackHash(protocol.manifest.stack) !== aaStackHash(manifest.stack)) return refuse("aa-stack-mismatch");
  const ordered = (tasks: AaTrialManifest["tasks"]) => [...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId));
  if (hash(ordered(protocol.manifest.tasks)) !== hash(ordered(manifest.tasks))
    || hash(protocol.manifest.cohort) !== hash(manifest.cohort) || protocol.manifest.strataRevision !== manifest.strataRevision)
    return refuse("aa-population-mismatch");
  return { ok: true as const, protocol };
}

// One effort per calibration preserves the existing A/A invariant: both labels run one identical stack.
export async function registerCodexBalancedTrial(input: CodexBalancedTrialInput): Promise<CodexBalancedTrialResult> {
  const parsed = parseRequest(input.request);
  if (!parsed.ok) return parsed;
  const { request, manifest } = parsed;
  const clock = input.clock ?? systemClock;
  let cited: ReturnType<typeof citeAaReceipt> | undefined;
  if (request.phase === "ab") {
    const aa = registeredAa(input.stateDir, manifest);
    if (!aa.ok) return aa;
    const report = readJson(join(prospectiveAaDir(input.stateDir, manifest.trialId), `calibration-receipt.${manifest.trialId}.json`), "aa-calibration");
    if (!report.ok) return report;
    cited = citeAaReceipt(report.value, clock.now());
    if (!cited.ok) return cited;
    if (cited.citation.trialId !== manifest.trialId || cited.citation.stackHash !== aaStackHash(manifest.stack)) return refuse("aa-stack-mismatch");
    if (cited.citation.allocationReceiptHash !== aa.protocol.allocationReceiptHash) return refuse("aa-population-mismatch");
  }
  const readiness = await input.readiness({ clock, stateDir: input.stateDir,
    trialId: manifest.trialId, manifest, maxPairs: 0 });
  if (readiness.state === "refused") return refuse(readiness.refusals.join(","));
  const aa = registeredAa(input.stateDir, manifest);
  if (!aa.ok) return aa;
  const frozen = readJson(join(prospectiveAaDir(input.stateDir, manifest.trialId), "population.json"), "aa-population");
  if (!frozen.ok) return frozen;
  const population = frozen.value as RegisteredPopulation;
  if (request.phase === "aa") return { ok: true, phase: "aa", protocol: aa.protocol, population };
  if (readiness.receipt.state !== "emitted" || cited === undefined || !cited.ok) return refuse("aa-receipt-not-passing");
  let catalog: string[];
  try { catalog = await (input.readCatalog ?? (() => readCodexModelCatalog(loadConfig())))(); }
  catch (error) {
    const reason = `codex-catalog-unreadable:${(error as Error).message}`;
    return refuse(reason);
  }
  if (!catalog.includes(TERRA)) return refuse(`codex-catalog-missing:${TERRA}`);
  const pilot = parsePaidPilotRequest(request.pilotRequest);
  if (!pilot.ok) return pilot;
  const pilotRequest = pilot.request;
  if (pilotRequest.approval.reference !== "#7418") return refuse("pilot-approval-must-cite-7418");
  if (pilotRequest.design !== "unpaired" || pilotRequest.reviewerReplay !== undefined) return refuse("task-randomization-required");
  for (const [arm, model] of [["control", SOL], ["paid", TERRA]] as const) {
    const pin = pilotRequest.arms[arm];
    if (pin.provider !== "codex" || pin.model !== model || pin.effort !== manifest.stack.effort) return refuse(`trial-arm-mismatch:${arm}`);
  }
  const { provider: _provider, model: _model, effort: _effort, ...revisions } = manifest.stack;
  if (Object.entries(revisions).some(([field, revision]) => pilotRequest.revisions[field as keyof typeof revisions] !== revision))
    return refuse("pilot-stack-mismatch");
  const eligible = new Set(population.eligible.map(task => task.taskId));
  if (pilotRequest.population.length !== eligible.size || pilotRequest.population.some(task => !eligible.has(task.taskId)
    || !manifest.tasks.some(entry => entry.taskId === task.taskId && entry.taskClass === task.taskClass && entry.risk === task.risk))
    || pilotRequest.strataRevision !== manifest.strataRevision) return refuse("pilot-population-mismatch");
  const terms = { assignment: { unit: "task", method: "sha256(benchmark-aa-allocation-v1, seed, taskId) parity",
    allocation: { control: 0.5, paid: 0.5 } } as CodexBalancedTrialProtocol["assignment"], primaryOutcome: "verified-completion" as const,
    analysis: "intention-to-treat" as const, guardrails: GUARDRAILS, stoppingRule: PAID_PILOT_STOPPING_RULE,
    cash: { ceilingUsd: PAID_PILOT_CASH_CEILING_USD, windowMs: PAID_PILOT_WINDOW_MS,
      api: "reserve-before-each-attempt" as const, subscriptionUsd: 0 as const } };
  const protocolText = JSON.stringify({ ...terms, operatorProtocol: pilotRequest.protocolText });
  const body: Omit<CodexBalancedTrialProtocol, "digest"> = { version: VERSION, trialId: pilotRequest.pilotId,
    registeredAt: clock.iso(), lead: SOL, liveAssignment: false, ...terms,
    aa: { protocolDigest: aa.protocol.digest, populationDigest: population.digest, receipt: cited.citation },
    pilotRequest: { ...pilotRequest, protocolText } };
  const protocol: CodexBalancedTrialProtocol = { ...body, digest: hash(body) };
  const path = join(input.stateDir, `${VERSION}.${protocol.trialId}.json`);
  try {
    mkdirSync(input.stateDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(protocol, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "EEXIST" ? "trial-already-registered"
      : `trial-registration-unwritable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
    return refuse(reason);
  }
  return { ok: true, phase: "ab", protocol, path };
}

// W1-T10842 persists the returned cash reservation under its admission lock before spawning.
export function codexBalancedAttemptAdmission(input: { protocol: PaidPilotProtocol; evidence: PaidPilotEvidence;
  nowIso: string; billing: "api" | "subscription"; reserveUsd: number }) {
  if (input.billing === "subscription") return { admitted: true, reserveUsd: 0, reasons: [] };
  if (!Number.isFinite(input.reserveUsd) || input.reserveUsd <= 0)
    return { admitted: false, reserveUsd: 0, reasons: ["cash-reserve-invalid"] };
  const { reasons } = paidArmPauseReasons(input.protocol, input.evidence, input.nowIso, input.reserveUsd);
  return { admitted: reasons.length === 0, reserveUsd: reasons.length === 0 ? input.reserveUsd : 0, reasons };
}

export async function codexBalancedTrialCommand(rest: string[], run: (request: unknown, stateDir: string) => Promise<CodexBalancedTrialResult>,
  deps: Pick<BenchmarkAaCommandInput, "print" | "resolveStateDir"> = {}): Promise<number> {
  const print = deps.print ?? console.log;
  let values;
  try { values = parseArgs({ args: rest, strict: true, options: { request: { type: "string" }, "state-dir": { type: "string" } } }).values; }
  catch (error) {
    const reason = `codex-balanced-trial: arguments-invalid: ${(error as Error).message}`;
    print(reason);
    return 2;
  }
  if (values.request === undefined) { print("usage: rmd benchmark-aa balanced --request <aa-or-ab-request.json> [--state-dir <dir>]"); return 2; }
  const loaded = readJson(values.request, "request");
  if (!loaded.ok) { print(loaded.reason); return 2; }
  const result = await run(loaded.value, values["state-dir"] ?? (deps.resolveStateDir ?? (() => join(loadConfig().root, "state")))());
  print(JSON.stringify(result));
  return result.ok ? 0 : 2;
}
