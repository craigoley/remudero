/** Recorded synthetic controls for the native private-corpus runner and existing slot owner. */
import { createHash } from "node:crypto";
import { CanarySlotOwner, assertExistingCanaryOwnerV1 } from "./model-canary-owner.js";
import { buildCanarySchedule, executeCanarySchedule, type CanarySchedulePorts } from "./model-canary-schedule.js";
import type { CanaryExecutionSource, CanarySourceActivity } from "./model-canary-metrics.js";
import { canarySuiteDigest, type CanaryCase } from "./model-canary-suite.js";
import { privateCorpusCaseMatches, snapshotPrivateCanaryJson, validatePrivateCorpus,
  type PrivateCanaryBundleV1, type ValidatedPrivateCorpus } from "./model-canary-private-corpus.js";
import type { CanaryExecutionOutcome, CanaryResponse } from "./model-canary-runner.js";

const scriptVersion = "model-canary-private-replay-v1" as const;
const maxScriptBytes = 128 * 1024;
const maxOutputBytes = 16_384;
const maxToolCalls = 2;
const object = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function privateBundleShape(value: unknown): value is PrivateCanaryBundleV1 {
  if (!object(value) || value.version !== "model-canary-private-bundle-v1" || !object(value.development)) return false;
  const development = value.development;
  return development.version === "model-canary-private-payload-v1" && development.split === "development"
    && Array.isArray(development.cases)
    && (value.sealedHoldout === undefined || object(value.sealedHoldout));
}

interface ReplayResponse { text: string; toolCalls: Array<{ name: string; args: Record<string, unknown> }> }
interface ReplayInputV1 { version: typeof scriptVersion; caseId: string; day: string; seed: string; responses: ReplayResponse[] }

function validateReplayInput(raw: unknown): { replay: ReplayInputV1; canonical: string } {
  let safe: unknown;
  try { safe = snapshotPrivateCanaryJson(raw, maxScriptBytes); } catch { throw new Error("private-replay-input-invalid"); }
  const encoded = JSON.stringify(safe);
  if (Buffer.byteLength(encoded, "utf8") > maxScriptBytes || !object(safe)
    || !exact(safe, ["version", "caseId", "day", "seed", "responses"])
    || safe.version !== scriptVersion || typeof safe.caseId !== "string" || safe.caseId.length < 1 || safe.caseId.length > 128
    || typeof safe.day !== "string" || typeof safe.seed !== "string" || safe.seed.length < 1 || safe.seed.length > 160
    || !Array.isArray(safe.responses) || safe.responses.length < 1 || safe.responses.length > 3)
    throw new Error("private-replay-input-invalid");
  const responses: ReplayResponse[] = [];
  for (const response of safe.responses) {
    if (!object(response) || !exact(response, ["text", "toolCalls"]) || typeof response.text !== "string"
      || Buffer.byteLength(response.text, "utf8") > maxOutputBytes || !Array.isArray(response.toolCalls)
      || response.toolCalls.length > maxToolCalls) throw new Error("private-replay-response-invalid");
    const toolCalls: ReplayResponse["toolCalls"] = [];
    for (const tool of response.toolCalls) {
      if (!object(tool) || !exact(tool, ["name", "args"]) || typeof tool.name !== "string"
        || tool.name.length < 1 || tool.name.length > 100 || !object(tool.args))
        throw new Error("private-replay-tool-request-invalid");
      toolCalls.push({ name: tool.name, args: tool.args });
    }
    responses.push({ text: response.text, toolCalls });
  }
  return { replay: safe as unknown as ReplayInputV1, canonical: encoded };
}

function developmentCase(bundle: unknown, corpus: ValidatedPrivateCorpus, caseId: string): CanaryCase {
  if (!object(bundle) || !object(bundle.development) || !Array.isArray(bundle.development.cases))
    throw new Error("private-replay-development-case-required");
  const row = bundle.development.cases.find(candidate => object(candidate) && object(candidate.item)
    && candidate.item.id === caseId);
  if (!row || !object(row) || !object(row.item) || !privateCorpusCaseMatches(corpus, row.item as unknown as CanaryCase))
    throw new Error("private-replay-development-case-required");
  return row.item as unknown as CanaryCase;
}

/** Recorded inputs exercise the app's native dispatcher; this is not a provider/model evaluation. */
export async function replayPrivateControl(input: {
  rawCorpus: unknown; replayInput: unknown; trustAnchors?: Readonly<Record<string, string>>; ownerDir: string;
}) {
  const { replay, canonical } = validateReplayInput(input.replayInput);
  let safeCorpus: unknown;
  try { safeCorpus = snapshotPrivateCanaryJson(input.rawCorpus, 2 * 1024 * 1024); }
  catch { throw new Error("private-replay-corpus-invalid"); }
  const validated = validatePrivateCorpus(safeCorpus, input.trustAnchors);
  if (validated.state !== "available") throw new Error(validated.reason);
  if (!privateBundleShape(safeCorpus)) throw new Error("private-replay-corpus-invalid");
  const corpus = validated.corpus, item = developmentCase(safeCorpus, corpus, replay.caseId);
  const cases = [item], pin = { model: "offline-replay-control", route: "synthetic-control",
    effort: "fixture", suiteHash: canarySuiteDigest(cases), billing: "subscription" as const };
  const plan = buildCanarySchedule(replay.day, replay.seed, cases, [pin]);
  assertExistingCanaryOwnerV1(input.ownerDir);
  const owner = new CanarySlotOwner(input.ownerDir);
  const activity: CanarySourceActivity = { kind: "synthetic-canary", source: "model-canary-v1",
    sourceReceiptId: sha(canonical), lane: "offline-private-replay" };
  let responseIndex = 0, terminal: CanaryExecutionOutcome | undefined;
  const ports: CanarySchedulePorts = {
    claim: async slot => owner.claim(slot),
    // This fixture has no provider transport or spend. It traverses only the existing local ownership path.
    eligibility: async () => ({ sourceAdopted: true, adapterQualified: true, productionBusy: false,
      squeeze: false, spareSubscription: true, experimentalCashAllowed: false, premium: false }),
    ports: slot => ({
      admit: async () => ({ state: "admitted" as const }),
      request: async (): Promise<CanaryResponse> => {
        const response = replay.responses[responseIndex++];
        if (!response) throw new Error("private-replay-response-exhausted");
        return { text: response.text, toolCalls: response.toolCalls,
          resources: { durationMs: null, firstTextMs: null, generationMs: null, inputTokens: null,
            outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
            usageRatedUsd: null, billing: slot.pin.billing, servedModel: null, terminal: "complete" } };
      },
      save: async run => {
        run.executionSource = "synthetic-control-replay" satisfies CanaryExecutionSource;
        run.sourceActivity = activity;
      },
      monotonicMs: () => performance.now(),
    }),
    terminal: async (slot, outcome) => {
      outcome.run.executionSource = "synthetic-control-replay";
      outcome.run.sourceActivity = activity;
      terminal = outcome;
      owner.terminal(slot, outcome);
    },
  };
  try {
    const scheduled = await executeCanarySchedule(plan, safeCorpus, ports, input.trustAnchors);
    if (!terminal) throw new Error(scheduled.state === "deferred" ? "private-replay-owner-or-schedule-deferred"
      : "private-replay-owner-terminal-missing");
    const trace = terminal.privateTrace;
    return { state: "synthetic-control-replay" as const, executionSource: "synthetic-control-replay" as const,
      scheduled, runId: terminal.run.id, slotId: plan.slots[0]!.id, caseId: item.id,
      binding: trace?.binding ?? null, grade: terminal.privateGrade ?? null,
      observedUnauthorizedAction: trace ? trace.events.some(event => event.denied) : null,
      providerCalls: 0 as const, providerIdentity: null, usage: null, cost: null,
      note: "Recorded response controls exercise native corpus, schedule, runner, app dispatcher and owner; not model or field evidence." };
  } finally { owner.close(); }
}
