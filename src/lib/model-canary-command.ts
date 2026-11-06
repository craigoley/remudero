/** Offline CLI preparation and projection. Provider execution requires a separately admitted adapter. */
import { mkdirSync, writeFileSync, existsSync, realpathSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { canarySuiteDigest, commonCanarySuite, weeklyCanarySuite, MODEL_CANARY_VERSION,
  type CanaryCase } from "./model-canary-suite.js";
import { projectCanaryRuns, type CanaryRun, type CanarySourceActivity } from "./model-canary-metrics.js";
import { renderCanaryReport } from "./model-canary-report.js";
import { retentionCanaryProtocol } from "./model-canary-retention.js";
import { contextCanaryProtocol } from "./model-canary-context.js";
import { createHash, randomBytes } from "node:crypto";
import { rotatingCanarySuite } from "./model-canary-rotation.js";
import { buildEffectiveConfigCensus, type BuildEffectiveConfigCensusInput } from "./model-canary-config-census.js";
import { planCanaryMatrix } from "./model-canary-matrix-plan.js";
import { analyzeClusterPairedCanaries, type ClusteredCanaryPairV1 } from "./model-canary-cluster-analysis.js";
import { compareCanaryToFieldTrials, type CanaryBenchmarkCaseV1, type FieldTrialComparisonCohortV1 } from "./model-canary-field-comparison.js";
import { buildExperimentProposal, type ImprovementEvidenceRowV1 } from "./model-canary-proposal-export.js";
import { evaluateCanaryRouterValue, type FrozenRouterOutcomeRowV1, type QualifiedStaticBaselineV1 } from "./model-canary-router-value.js";
import { createAnalysisEvidenceReader } from "./model-canary-analysis-evidence-adapter.js";
import { createNativeFieldEvidenceReader } from "./model-canary-native-field-evidence.js";
import { readExistingNativeCanaryConfig } from "./model-canary-native-config.js";
import type { ModelCanaryConfigCensusV1, ModelCanaryConfigRow } from "./model-canary-config-census.js";
import { validatePrivateCorpus, buildPrivateCanaryRequest, privateCorpusCases, privateCorpusCaseMatches } from "./model-canary-private-corpus.js";
import { capturedPrivateTraceReceipt, gradePrivateTrace, loadPrivateTraceFromCustody,
  type PrivateTraceBindingV1 } from "./model-canary-trace-grader.js";
import { CanarySlotOwner, readOwnedPrivateTraceReceipt } from "./model-canary-owner.js";
import { replayPrivateControl } from "./model-canary-replay-private.js";
import { buildCanarySchedule, executeCanarySchedule, type CanarySchedulePorts, type CanarySlot } from "./model-canary-schedule.js";
import type { CanaryExecutionPorts } from "./model-canary-runner.js";
import { isRegisteredCanarySlotOwner } from "./model-canary-coding-capabilities.js";
import { codingWorkerRequestPorts, type CodingWorker } from "./model-canary-coding-adapter.js";
import type { Config } from "./config.js";
import { ledgerPathFor } from "./ledger-path.js";
import { registerQualifiedCodingExecutionPort } from "./model-canary-coding-port-capability.js";
import { codingLedgerSave, type CodingLedgerWriter } from "./model-canary-ledger.js";
import type { ValidatedPrivateCorpus } from "./model-canary-private-corpus.js";

function boundedCanaryAnalysisInput(input: string, limit = 8 * 1024 * 1024, privateOwned = false): string {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0
    || !Number.isInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK <= 0)
    throw new Error("canary-input-platform-unsupported");
  const fd = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("canary-input-regular-file-required");
    if (privateOwned && ((info.mode & 0o077) !== 0 || typeof process.getuid !== "function" || info.uid !== process.getuid()))
      throw new Error("canary-input-private-owned-file-required");
    if (info.size > limit) throw new Error("canary-input-bound");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw new Error("canary-input-bound");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function writePrivateCanaryAnalysisOutput(dir: string, name: string, data: string) {
  const requirePrivateDirectory = () => {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
      || typeof process.getuid !== "function" || info.uid !== process.getuid())
      throw new Error("canary-output-private-owned-directory-required");
  };
  // mkdir's mode does not protect an existing directory; never follow a final symlink.
  try { requirePrivateDirectory(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let parent = resolve(dir);
  // Resolve the first existing ancestor too: a new directory below a symlink is not private.
  while (!existsSync(parent)) parent = dirname(parent);
  parent = realpathSync(parent);
  while (true) {
    if (existsSync(join(parent, ".git"))) throw new Error("canary-output-inside-git");
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  requirePrivateDirectory();
  writeFileSync(join(dir, name), data, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function readPrivateCanaryTrustAnchors(flag: string | undefined, file: string | undefined): Readonly<Record<string, string>> {
  if (flag === undefined && file === undefined) return {};
  if (flag !== "--trust-anchors" || !file) throw new Error("canary-private-trust-anchor-argument-invalid");
  // This separate, operator-selected file is the trust source; corpus JSON cannot select a key.
  const parsed: unknown = JSON.parse(boundedCanaryAnalysisInput(file, 64 * 1024, true));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).length > 16 || Object.entries(parsed).some(([id, key]) =>
      !/^[a-zA-Z0-9._-]{1,100}$/.test(id) || typeof key !== "string" || key.length > 4096))
    throw new Error("canary-private-trust-anchors-invalid");
  return parsed as Readonly<Record<string, string>>;
}

export interface NativeCanaryAnalysisInputV1 {
  version: "model-canary-analysis-input-v1";
  seed: string;
  censusInput: BuildEffectiveConfigCensusInput;
  matrixOptions: { day: string; seed: string; replicates: number; aa?: boolean };
  matrixDigest: string;
  design: { comparisons: readonly { id: string; endpoints: readonly string[];
    estimands: readonly ("first-attempt" | "all-repeats" | "best-of-k")[] }[];
    splits: readonly ("development" | "sealed-holdout")[] };
  comparisons: readonly { id: string; endpoint: string; leftConfigId: string; rightConfigId: string }[];
  observationWindow: { start: string; end: string };
  routerReplay?: { rows: readonly FrozenRouterOutcomeRowV1[]; baselines: readonly QualifiedStaticBaselineV1[] };
}

export function parseNativeCanaryAnalysisInput(value: unknown): NativeCanaryAnalysisInputV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("canary-analysis-input-invalid");
  const raw = value as Record<string, unknown>;
  const allowed = ["version", "seed", "censusInput", "matrixOptions", "matrixDigest", "design",
    "comparisons", "observationWindow", "routerReplay"];
  if (raw.version !== "model-canary-analysis-input-v1" || Object.keys(raw).some(key => !allowed.includes(key))
    || Object.keys(raw).length < 8 || typeof raw.seed !== "string" || raw.seed.length < 1 || raw.seed.length > 128
    || typeof raw.matrixDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.matrixDigest)
    || !raw.censusInput || typeof raw.censusInput !== "object" || Array.isArray(raw.censusInput)
    || !raw.matrixOptions || typeof raw.matrixOptions !== "object" || Array.isArray(raw.matrixOptions)
    || !raw.design || typeof raw.design !== "object" || Array.isArray(raw.design)
    || !Array.isArray(raw.comparisons) || !raw.comparisons.length
    || !raw.observationWindow || typeof raw.observationWindow !== "object" || Array.isArray(raw.observationWindow))
    throw new Error("canary-analysis-input-invalid");
  const options = raw.matrixOptions as Record<string, unknown>;
  if (Object.keys(options).some(key => !["day", "seed", "replicates", "aa"].includes(key))
    || typeof options.day !== "string" || typeof options.seed !== "string" || !options.seed
    || !Number.isSafeInteger(options.replicates) || (options.replicates as number) < 1
    || (options.aa !== undefined && typeof options.aa !== "boolean"))
    throw new Error("canary-analysis-matrix-options-invalid");
  const design = raw.design as Record<string, unknown>;
  if (Object.keys(design).sort().join(",") !== "comparisons,splits"
    || !Array.isArray(design.comparisons) || !Array.isArray(design.splits))
    throw new Error("canary-analysis-design-invalid");
  const comparisonRows = raw.comparisons as unknown[];
  if (comparisonRows.length > 32 || comparisonRows.some(item => !item || typeof item !== "object" || Array.isArray(item)
    || Object.keys(item).sort().join(",") !== "endpoint,id,leftConfigId,rightConfigId"
    || ["id", "endpoint", "leftConfigId", "rightConfigId"].some(key => typeof (item as Record<string, unknown>)[key] !== "string"
      || ((item as Record<string, unknown>)[key] as string).length < 1
      || ((item as Record<string, unknown>)[key] as string).length > 160)))
    throw new Error("canary-analysis-comparisons-invalid");
  const window = raw.observationWindow as Record<string, unknown>;
  if (Object.keys(window).sort().join(",") !== "end,start" || typeof window.start !== "string"
    || typeof window.end !== "string" || !Number.isFinite(Date.parse(window.start))
    || !Number.isFinite(Date.parse(window.end)) || Date.parse(window.start) >= Date.parse(window.end))
    throw new Error("canary-analysis-window-invalid");
  if (raw.routerReplay !== undefined)
    throw new Error("canary-analysis-router-native-replay-evidence-unavailable");
  return raw as unknown as NativeCanaryAnalysisInputV1;
}

export function nativeCanaryExecutionWithinObservationWindow(
  executionWindow: { startedAt: string; completedAt: string } | null,
  observationWindow: { start: string; end: string },
): boolean {
  if (executionWindow === null) return false;
  const start = Date.parse(observationWindow.start), end = Date.parse(observationWindow.end);
  const executionStart = Date.parse(executionWindow.startedAt), executionEnd = Date.parse(executionWindow.completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && start < end
    && Number.isFinite(executionStart) && Number.isFinite(executionEnd)
    && executionStart >= start && executionEnd < end;
}

export function projectNativeCanaryEstimands(run: Pick<CanaryRun, "attempts" | "verified">) {
  const first = run.attempts.length === 1 && run.verified !== null ? run.verified : null;
  return { outcomes: { "first-attempt": first, "all-repeats": null, "best-of-k": null },
    availability: {
      "first-attempt": first === null ? "withheld-no-single-attempt-grade" as const : "observed" as const,
      "all-repeats": "unavailable-current-terminal-grade-schema-has-no-per-attempt-outcomes" as const,
      "best-of-k": "unavailable-current-terminal-grade-schema-has-no-per-attempt-outcomes" as const,
    } };
}

function canonicalCanaryAnalysisValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCanaryAnalysisValue);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalCanaryAnalysisValue((value as Record<string, unknown>)[key])]));
  return value;
}
function canaryAnalysisDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalCanaryAnalysisValue(value))).digest("hex");
}

function assertCanaryAnalysisSourcePath(configRoot: string, path: string): void {
  const root = realpathSync(configRoot), requested = resolve(path), link = lstatSync(requested);
  const real = realpathSync(requested), info = lstatSync(real), withinRoot = relative(root, real);
  if (!link.isDirectory() || link.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700
    || (typeof process.getuid === "function" && info.uid !== process.getuid())
    || withinRoot === ".." || withinRoot.startsWith("../") || withinRoot.startsWith("/"))
    throw new Error("native-analysis-source-path-outside-private-config-root");
}

function runPrivateCanaryAnalysis(argv: readonly string[]) {
  const [, outDir, ownerDirectory, analysisInputFile, fieldTrialsOutDir, corpusFile, flag, keyFile] = argv;
  if (![6, 8].includes(argv.length) || !outDir || !ownerDirectory || !analysisInputFile || !fieldTrialsOutDir || !corpusFile)
    throw new Error("usage: model-canary-command analyze-private <private-out-dir> <existing-private-owner-dir> <private-analysis-input.json> <existing-field-trials-out-dir> <private-corpus.json> [--trust-anchors <private-anchor-file>]");
  const existingConfig = readExistingNativeCanaryConfig();
  if (existingConfig.state !== "available") throw new Error(existingConfig.reason);
  assertCanaryAnalysisSourcePath(existingConfig.config.root, ownerDirectory);
  assertCanaryAnalysisSourcePath(existingConfig.config.root, fieldTrialsOutDir);
  const ownerEvidence = createAnalysisEvidenceReader(ownerDirectory)();
  const nativeFieldEvidence = createNativeFieldEvidenceReader(fieldTrialsOutDir)();
  const corpus = validatePrivateCorpus(JSON.parse(boundedCanaryAnalysisInput(corpusFile, 2 * 1024 * 1024, true)),
    readPrivateCanaryTrustAnchors(flag, keyFile));
  const input = parseNativeCanaryAnalysisInput(JSON.parse(boundedCanaryAnalysisInput(analysisInputFile, 8 * 1024 * 1024, true)));
  if (corpus.state !== "available") throw new Error(corpus.reason);
  const census = buildEffectiveConfigCensus(input.censusInput);
  const matrix = planCanaryMatrix({ census, cases: input.censusInput.cases,
    day: input.matrixOptions.day, seed: input.matrixOptions.seed, replicates: input.matrixOptions.replicates,
    ...(input.matrixOptions.aa === undefined ? {} : { aa: input.matrixOptions.aa }) });
  if (matrix.digest !== input.matrixDigest) throw new Error("canary-analysis-matrix-digest-mismatch");
  const derivedAnalysisSeed = canaryAnalysisDigest(["model-canary-analysis-seed-v1", matrix.digest, matrix.seed]);
  if (input.seed !== derivedAnalysisSeed) throw new Error("canary-analysis-seed-not-predeclared-by-matrix");
  if (input.design.comparisons.length !== input.comparisons.length
    || input.comparisons.some(pair => !input.design.comparisons.some(declared => declared.id === pair.id
      && declared.endpoints.includes(pair.endpoint))))
    throw new Error("canary-analysis-predeclaration-mismatch");

  const metadataByCase = new Map(corpus.metadata.cases.map(item => [item.caseId, item]));
  const configById = new Map(matrix.configurations.map(row => [row.configId, row]));
  const mappingBySlot = new Map(matrix.shards.flatMap(shard => shard.slotMappings).map(mapping => [mapping.nativeSlotId, mapping]));
  const receipts = ownerEvidence.state === "available" ? ownerEvidence.evidence.receipts : [];
  const receiptByRun = new Map<string, (typeof receipts)[number]>();
  const mappingByRun = new Map<string, (typeof matrix.shards[number]["slotMappings"])[number]>();
  const benchmarkCases: CanaryBenchmarkCaseV1[] = [];
  let unclassifiedReceipts = 0, mismatchedReceipts = 0;
  for (const receipt of receipts) {
    const mapping = mappingBySlot.get(receipt.slot.id), meta = metadataByCase.get(receipt.run.caseId);
    const config = mapping ? configById.get(mapping.configId) : undefined;
    if (!mapping || !meta || !config || mapping.caseId !== receipt.run.caseId) continue;
    const pin = config.pin, actualPin = receipt.slot.pin;
    if (receipt.slot.caseId !== mapping.caseId || actualPin.model !== pin.model || actualPin.route !== pin.route
      || actualPin.effort !== pin.effort || actualPin.billing !== pin.billing
      || actualPin.suiteHash !== matrix.caseSet.nativeSuiteHash || receipt.run.model !== config.configuration.model
      || receipt.run.route !== config.configuration.route || receipt.run.effort !== config.configuration.effort
      || (receipt.run.trial !== undefined && receipt.run.trial.slotId !== receipt.slot.id)) { mismatchedReceipts++; continue; }
    const source = receipt.run.executionSource;
    if (source !== "native-provider-execution" && source !== "synthetic-control-replay") { unclassifiedReceipts++; continue; }
    const c = config.configuration;
    const benchmark: CanaryBenchmarkCaseV1 = {
      runId: receipt.run.id, caseId: meta.caseId, sourceFamilyId: meta.sourceFamilyId, incidentRootId: meta.incidentRootId,
      split: meta.split, executionSource: source,
      identity: { provider: c.provider, deployment: c.deployment, requestedModel: c.requestedModel, model: c.model,
        route: c.route, effort: c.effort, billing: c.billing, treatment: c.treatment,
        corpusDigest: corpus.metadata.digest, scorerDigest: meta.scorerDigest, role: meta.role,
        observationWindow: nativeCanaryExecutionWithinObservationWindow(receipt.executionWindow, input.observationWindow)
          ? input.observationWindow : null },
      outcomes: projectNativeCanaryEstimands(receipt.run).outcomes,
    };
    benchmarkCases.push(benchmark); receiptByRun.set(receipt.run.id, receipt); mappingByRun.set(receipt.run.id, mapping);
  }

  const blocks = new Map<string, Map<string, (typeof receipts)[number]>>();
  for (const receipt of receipts) {
    const mapping = mappingBySlot.get(receipt.slot.id);
    if (!mapping || !receipt.run.trial || !receiptByRun.has(receipt.run.id)) continue;
    const key = JSON.stringify([mapping.replicateId, mapping.caseId]);
    const group = blocks.get(key) ?? new Map<string, (typeof receipts)[number]>();
    if (group.has(mapping.configId)) throw new Error("canary-analysis-duplicate-native-slot");
    group.set(mapping.configId, receipt); blocks.set(key, group);
  }
  const pairs: ClusteredCanaryPairV1[] = [];
  for (const pairSpec of input.comparisons) {
    const declaration = input.design.comparisons.find(item => item.id === pairSpec.id)!;
    if (!configById.has(pairSpec.leftConfigId) || !configById.has(pairSpec.rightConfigId))
      throw new Error("canary-analysis-config-not-in-matrix");
    for (const [blockKey, group] of blocks) {
      const left = group.get(pairSpec.leftConfigId), right = group.get(pairSpec.rightConfigId);
      const caseId = left?.run.caseId ?? right?.run.caseId;
      if (!caseId) continue;
      const meta = metadataByCase.get(caseId);
      if (!meta) continue;
      const leftOutcome = left?.run.attempts.length === 1 ? left.run.verified : null;
      const rightOutcome = right?.run.attempts.length === 1 ? right.run.verified : null;
      const presentSources = [left?.run.executionSource, right?.run.executionSource].filter(Boolean);
      const source = presentSources.length > 0 && presentSources.every(item => item === "native-provider-execution")
        ? "native-provider-execution" : "synthetic-control-replay";
      for (const estimand of declaration.estimands) {
        const a = estimand === "first-attempt" ? leftOutcome : null;
        const b = estimand === "first-attempt" ? rightOutcome : null;
        pairs.push({ pairId: canaryAnalysisDigest([pairSpec.id, pairSpec.endpoint, blockKey, estimand]),
          comparisonId: pairSpec.id, endpoint: pairSpec.endpoint, estimand, split: meta.split, caseId,
          sourceFamilyId: meta.sourceFamilyId, incidentRootId: meta.incidentRootId, executionSource: source,
          complete: a !== null && b !== null, leftValue: a === null ? null : Number(a), rightValue: b === null ? null : Number(b) });
      }
    }
  }
  const clustered = analyzeClusterPairedCanaries({ pairs, design: input.design, seed: input.seed });
  const fieldTrials: readonly FieldTrialComparisonCohortV1[] =
    nativeFieldEvidence.state === "available" ? nativeFieldEvidence.evidence.fieldTrials : [];
  const fieldComparison = compareCanaryToFieldTrials({ benchmarkCases, fieldTrials });
  const timestampQualifiedBenchmarkCases = benchmarkCases.filter(row => row.identity.observationWindow !== null).length;
  const unverifiedOrOutOfWindowBenchmarkCases = benchmarkCases.length - timestampQualifiedBenchmarkCases;

  // Current native owner receipts do not persist frozen pre-outcome decisions or qualified-static-baseline receipts.
  // Keep the helper in the CLI pipeline, but explicitly withhold value claims until those native contracts exist.
  const router = evaluateCanaryRouterValue({ rows: [], baselines: [{ configId: "unverified-static-baseline",
    qualified: false, qualificationEvidenceDigest: "0".repeat(64) }], analysisSeed: input.seed });
  const allowedFailures = ["wrong-model-selection", "fallback-mismatch", "tool-use-failure", "context-loss",
    "latency-regression", "cost-regression", "scorer-disagreement"];
  const proposalEvidence: ImprovementEvidenceRowV1[] = benchmarkCases.flatMap(row => {
    const reason = receiptByRun.get(row.runId)?.run.outcomeReason;
    return row.outcomes["first-attempt"] === false && typeof reason === "string" && allowedFailures.includes(reason)
      ? [{ signatureId: reason, failureClass: reason as ImprovementEvidenceRowV1["failureClass"], caseId: row.caseId,
        sourceFamilyId: row.sourceFamilyId, incidentRootId: row.incidentRootId,
        evidenceDigest: canaryAnalysisDigest([row.runId, row.caseId, row.split, row.outcomes]), executionSource: row.executionSource,
        split: row.split }] : [];
  });
  const proposals = buildExperimentProposal({ evidence: proposalEvidence });
  const result = { version: "model-canary-analysis-v1", state: ownerEvidence.state === "available" ? "analyzed" : "unavailable",
    config: { state: existingConfig.state }, owner: { state: ownerEvidence.state,
      reason: ownerEvidence.state === "unavailable" ? ownerEvidence.reason : null },
    fieldTrials: { state: nativeFieldEvidence.state, reason: nativeFieldEvidence.state === "unavailable"
      ? nativeFieldEvidence.reason : null,
      timestampCoverage: { benchmarkCases: benchmarkCases.length,
        qualifiedExecutionIntervals: timestampQualifiedBenchmarkCases,
        unverifiedOrOutOfWindow: unverifiedOrOutOfWindowBenchmarkCases },
      comparisonWithholdingReason: benchmarkCases.length > 0 && timestampQualifiedBenchmarkCases === 0
        ? "native-execution-interval-missing-or-outside-requested-window" : null,
      controlledCandidateExclusions: nativeFieldEvidence.state === "available"
        ? nativeFieldEvidence.evidence.unmatchedControlledReasons : [] }, matrixDigest: matrix.digest, corpusDigest: corpus.metadata.digest,
    counts: { nativeReceipts: receipts.length, benchmarkCases: benchmarkCases.length, unclassifiedReceipts, mismatchedReceipts },
    estimands: {
      "first-attempt": "observed-only-when-exactly-one-attempt-has-terminal-grade",
      "all-repeats": "unavailable-current-terminal-grade-schema-has-no-per-attempt-outcomes",
      "best-of-k": "unavailable-current-terminal-grade-schema-has-no-per-attempt-outcomes",
    },
    clustered, fieldComparison, router, proposals };
  writePrivateCanaryAnalysisOutput(outDir, "model-canary-analysis.json", JSON.stringify(result, null, 2) + "\n");
  writePrivateCanaryAnalysisOutput(outDir, "model-canary-improvement-proposals.json", JSON.stringify(proposals, null, 2) + "\n");
  return { state: "analyzed-private", nativeReceipts: receipts.length, benchmarkCases: benchmarkCases.length,
    comparisons: clustered.comparisons.length, fieldComparisons: fieldComparison.comparisons.length,
    proposals: proposals.proposals.length };
}



export function canaryCommand(argv: readonly string[]): { state: string; runs?: number; [key: string]: unknown } {
  if (argv[0] === "analyze-private") return runPrivateCanaryAnalysis(argv);
  if (argv[0] === "prepare-coding") {
    const [, outDir, corpusFile, flag, keyFile] = argv;
    if (![3, 5].includes(argv.length) || !outDir || !corpusFile)
      throw new Error("usage: model-canary-command prepare-coding <private-out-dir> <private-corpus.json> [--trust-anchors <private-anchor-file>]");
    const validated = validatePrivateCorpus(JSON.parse(boundedCanaryAnalysisInput(corpusFile, 2 * 1024 * 1024, true)),
      readPrivateCanaryTrustAnchors(flag, keyFile));
    if (validated.state !== "available") throw new Error(validated.reason);
    const cases = validated.metadata.cases.filter(item => item.family === "coding");
    const requests = cases.map(item => {
      const projected = buildPrivateCanaryRequest(validated.corpus, item.caseId);
      if (projected.state !== "available") throw new Error(projected.reason);
      return { request: projected.request, join: { requestId: projected.request.requestId,
        caseId: item.caseId, corpusDigest: validated.metadata.digest, scorerDigest: item.scorerDigest } };
    });
    writePrivateCanaryAnalysisOutput(outDir, "model-canary-coding-requests.json", JSON.stringify({
      version: "model-canary-coding-requests-v1", state: "prepared-not-activated",
      requests: requests.map(item => item.request) }, null, 2) + "\n");
    writePrivateCanaryAnalysisOutput(outDir, "model-canary-coding-joins.json", JSON.stringify({
      version: "model-canary-coding-joins-v1", corpusDigest: validated.metadata.digest,
      joins: requests.map(item => item.join), execution: "requires-native-owner-and-qualified-linux-profile" }, null, 2) + "\n");
    writePrivateCanaryAnalysisOutput(outDir, "model-canary-coding-native.json", JSON.stringify({
      version: "model-canary-coding-native-v1", corpusDigest: validated.metadata.digest,
      cases: privateCorpusCases(validated.corpus)!.filter(item => item.family === "coding"),
      plan: null, seed: null, released: false,
      eligibility: { sourceAdopted: false, adapterQualified: false, productionBusy: true,
        squeeze: true, spareSubscription: false, experimentalCashAllowed: false, premium: false },
    }, null, 2) + "\n");
    return { state: "prepared-not-activated", cases: cases.length, corpusDigest: validated.metadata.digest,
      execution: "requires-native-owner-and-qualified-linux-profile" };
  }
  if (argv[0] === "prepare-private") {
    const [, outDir, input, flag, keyFile] = argv;
    if (![3, 5].includes(argv.length) || !outDir || !input)
      throw new Error("usage: model-canary-command prepare-private <private-out-dir> <private-corpus.json> [--trust-anchors <private-anchor-file>]");
    const bundle: unknown = JSON.parse(boundedCanaryAnalysisInput(input, 2 * 1024 * 1024, true));
    const corpus = validatePrivateCorpus(bundle, readPrivateCanaryTrustAnchors(flag, keyFile));
    if (corpus.state !== "available") throw new Error(corpus.reason);
    const requests = corpus.metadata.cases.map(item => {
      const projected = buildPrivateCanaryRequest(corpus.corpus, item.caseId);
      if (projected.state !== "available") throw new Error(projected.reason);
      return { request: projected.request, join: { requestId: projected.request.requestId,
        caseId: item.caseId, corpusDigest: corpus.metadata.digest, scorerDigest: item.scorerDigest } };
    });
    // Request payload and scorer/provenance joins are separate files; none grants execution.
    writePrivateCanaryAnalysisOutput(outDir, "model-canary-private-scorer.json", JSON.stringify(bundle, null, 2) + "\n");
    writePrivateCanaryAnalysisOutput(outDir, "model-canary-private-requests.json", JSON.stringify({
      version: "model-canary-private-requests-v1", state: "prepared-not-activated",
      requests: requests.map(item => item.request) }, null, 2) + "\n");
    writePrivateCanaryAnalysisOutput(outDir, "model-canary-private-joins.json", JSON.stringify({
      version: "model-canary-private-joins-v1", metadata: corpus.metadata,
      joins: requests.map(item => item.join) }, null, 2) + "\n");
    return { state: "prepared-not-activated", corpusDigest: corpus.metadata.digest,
      cases: corpus.metadata.cases.length, splits: corpus.metadata.splits,
      execution: "qualified-native-owner-required" };
  }
  if (argv[0] === "grade-private") {
    const [, outDir, corpusFile, ownerDirectory, bindingFile, flag, keyFile] = argv;
    if (![5, 7].includes(argv.length) || !outDir || !corpusFile || !ownerDirectory || !bindingFile)
      throw new Error("usage: model-canary-command grade-private <private-out-dir> <private-corpus.json> <operator-selected-private-owner-dir> <binding.json> [--trust-anchors <private-anchor-file>]");
    const corpus = validatePrivateCorpus(JSON.parse(boundedCanaryAnalysisInput(corpusFile, 2 * 1024 * 1024, true)),
      readPrivateCanaryTrustAnchors(flag, keyFile));
    if (corpus.state !== "available") throw new Error(corpus.reason);
    const value: unknown = JSON.parse(boundedCanaryAnalysisInput(bindingFile, 128 * 1024, true));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("canary-private-binding-required");
    const request = value as Record<string, unknown>;
    if (request.version !== "model-canary-private-grade-input-v1" || Object.keys(request).length !== 3
      || !request.slot || typeof request.slot !== "object" || Array.isArray(request.slot)
      || !request.binding || typeof request.binding !== "object" || Array.isArray(request.binding))
      throw new Error("canary-private-binding-input-invalid");
    const slot = request.slot as CanarySlot, binding = request.binding as PrivateTraceBindingV1;
    // Caller must select this trusted owner directory out of band; neither corpus nor run JSON selects it.
    // This operator choice is a custody channel, not proof of configuration provenance.
    // Same-UID host tampering is outside this private-custody boundary; this is not a signature.
    const loaded = loadPrivateTraceFromCustody(corpus.corpus, slot.caseId, binding,
      () => readOwnedPrivateTraceReceipt(ownerDirectory, slot, binding));
    const captured = loaded.state === "available" ? capturedPrivateTraceReceipt(loaded.trace) : null;
    const custodyAvailable = loaded.state === "available" && captured !== null;
    const grade = loaded.state === "available" && captured !== null
      ? gradePrivateTrace(corpus.corpus, slot.caseId, loaded.finalText, loaded.trace, binding)
      : { state: "unavailable" as const, reason: loaded.state === "unavailable"
        ? loaded.reason : "private-trace-capture-unavailable" };
    writePrivateCanaryAnalysisOutput(outDir, "model-canary-private-grade.json", JSON.stringify({
      version: "model-canary-private-grade-v1", corpusDigest: corpus.metadata.digest,
      evidenceSource: custodyAvailable ? "operator-selected-private-owner-custody" : "unavailable",
      binding: captured?.binding ?? null,
      observedUnauthorizedAction: captured === null ? null : captured.events.some(event => event.denied),
      grade }, null, 2) + "\n");
    return { state: "private-regrade", gradeState: grade.state,
      passed: grade.state === "scored" ? grade.passed : null, reason: grade.reason };
  }

  if (argv[0] === "prepare-matrix") {
    const [, outDir, input] = argv;
    if (argv.length !== 3 || !outDir || !input)
      throw new Error("usage: model-canary-command prepare-matrix <private-out-dir> <matrix-input.json>");
    const value: unknown = JSON.parse(boundedCanaryAnalysisInput(input));
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("canary-matrix-input-required");
    const request = value as Record<string, unknown>;
    if (request.version !== "model-canary-matrix-input-v1"
      || typeof request.census !== "object" || request.census === null || Array.isArray(request.census)
      || typeof request.matrix !== "object" || request.matrix === null || Array.isArray(request.matrix))
      throw new Error("canary-matrix-input-version-or-shape-invalid");
    const censusInput = request.census as BuildEffectiveConfigCensusInput;
    const options = request.matrix as Record<string, unknown>;
    if (typeof options.day !== "string" || typeof options.seed !== "string"
      || typeof options.replicates !== "number" || (options.aa !== undefined && typeof options.aa !== "boolean"))
      throw new Error("canary-matrix-options-invalid");
    const census = buildEffectiveConfigCensus(censusInput);
    const matrix = planCanaryMatrix({ census, cases: censusInput.cases,
      day: options.day, seed: options.seed, replicates: options.replicates,
      ...(options.aa === undefined ? {} : { aa: options.aa }) });
    // These are private preparation artifacts. Native ownership, admission and execution remain separate.
    const state = "prepared-not-activated" as const;
    writePrivateCanaryAnalysisOutput(outDir, "model-canary-configuration-census.json", JSON.stringify(census, null, 2) + "\n");
    writePrivateCanaryAnalysisOutput(outDir, "model-canary-matrix-manifest.json", JSON.stringify({ ...matrix, state,
      analysisSeed: canaryAnalysisDigest(["model-canary-analysis-seed-v1", matrix.digest, matrix.seed]),
      requires: ["published-source", "qualified-adapter", "capacity-admission", "shared-owner", "agreed-experiment-budget"] }, null, 2) + "\n");
    return { state, censusDigest: census.digest, matrixDigest: matrix.digest,
      configurations: census.rows.length, shards: matrix.shards.length, readiness: matrix.readiness };
  }
  if (argv[0] === "prepare-rotation") {
    const [, outDir, day, keyFile] = argv;
    if (argv.length !== 4 || !outDir || !day || !keyFile)
      throw new Error("usage: model-canary-command prepare-rotation <private-out-dir> <day> <private-key-file>");
    const key = boundedCanaryAnalysisInput(keyFile, 66);
    const pack = rotatingCanarySuite(day, key.replace(/\r?\n$/, ""));
    const { cases, ...metadata } = pack;
    // Private scorer records retain expectations; the separate request manifest never does.
    writePrivateCanaryAnalysisOutput(outDir, "model-canary-rotation-scorer.json", JSON.stringify(pack, null, 2) + "\n");
    writePrivateCanaryAnalysisOutput(outDir, "model-canary-rotation-manifest.json", JSON.stringify({ ...metadata,
      state: "prepared-not-activated", tasks: cases.map(({ expected: _scorerOnly, ...task }) => task),
      cash: { globalDailyCapUsd: 25, experimentDailyCapUsd: 0, premiumCashEligible: false },
      requires: ["published-source", "qualified-adapter", "capacity-admission", "shared-owner", "agreed-experiment-budget"] }, null, 2) + "\n");
    return { state: "prepared-not-activated", suiteHash: pack.suiteHash, cases: cases.length };
  }
  const [command, outDir, input] = argv;
  if (!outDir || !["prepare", "project"].includes(command ?? "")
    || argv.length !== (command === "prepare" ? 2 : 3))
    throw new Error("usage: model-canary-command prepare <private-out-dir> | project <private-out-dir> <run-array.json>");
  if (command === "prepare") {
    const daily = commonCanarySuite(), weekly = weeklyCanarySuite();
    const namespace = randomBytes(32).toString("hex");
    const manifest = { version: MODEL_CANARY_VERSION, state: "prepared-not-activated", dailyCases: daily.length,
      weeklyCases: weekly.length, suiteHash: canarySuiteDigest([...daily, ...weekly]),
      tasks: [...daily, ...weekly].map(({ expected: _heldOut, ...task }) => task),
      limits: { concurrency: 1, maxCallsDailyCase: 3, wallMs: 60_000, maxOutputBytes: 16_384 },
      cash: { globalDailyCapUsd: 25, experimentDailyCapUsd: 0, premiumCashEligible: false },
      requires: ["published-source", "qualified-adapter", "capacity-admission", "shared-owner", "agreed-experiment-budget"],
      retentionProtocols: [25, 50].map(turns => {
        const p = retentionCanaryProtocol(turns as 25 | 50);
        return { turns, suiteHash: p.suiteHash, instruction: p.instruction,
          prompts: p.cases.map(c => ({ id: c.id, prompt: c.prompt })), sampleUnit: "whole-conversation" };
      }),
      contextProfiles: ([2048, 16384, 65536] as const).flatMap(bytes => (["first-use", "repeat"] as const).map(treatment => {
        const p = contextCanaryProtocol(bytes, treatment, namespace);
        return { version: p.version, bytes, byteUnit: p.byteUnit, treatment, namespace, suiteHash: p.suiteHash,
          cacheGuarantee: p.cacheGuarantee, sampleUnit: p.sampleUnit,
          tasks: p.cases.map(({ expected: _scorerOnly, ...task }) => task) };
      })),
      deeperWeekly: { patchExecution: "pending-isolated-scorer", retention25And50Turns: "native-protocol-prepared-adapter-pending", cacheProfiles: "native-byte-protocol-prepared-adapter-pending" } };
    writePrivateCanaryAnalysisOutput(outDir, "model-canary-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    return { state: manifest.state, suiteHash: manifest.suiteHash };
  }
  if (!input) throw new Error("canary-input-bound");
  const value: unknown = JSON.parse(boundedCanaryAnalysisInput(input));
  if (!Array.isArray(value)) throw new Error("canary-run-array-required");
  const runs = value as CanaryRun[], projection = projectCanaryRuns(runs);
  writePrivateCanaryAnalysisOutput(outDir, "model-canary-metrics.json", JSON.stringify(projection, null, 2) + "\n");
  writePrivateCanaryAnalysisOutput(outDir, "model-canary-report.html", renderCanaryReport(runs));
  return { state: "private-projection", runs: projection.uniqueRuns };
}

/**
 * The opaque host profile only the native systemd/bwrap backend may issue (W1-T11313). This build has
 * no issuer, so no value of this type is ever qualified here: coding defers with
 * coding-native-profile-unavailable before eligibility, claim, admission or request.
 */
export interface NativeCodingProfile { readonly kind: "qualified-linux-coding-profile-v1" }

export interface OwnedCodingCanaryPorts {
  owner: CanarySlotOwner;
  profile: NativeCodingProfile | null;
  privateCorpus: ValidatedPrivateCorpus;
  ledgerPath: string;
  schedulePorts: Pick<CanarySchedulePorts, "eligibility"> & {
    ports(slot: CanarySlot): CanaryExecutionPorts;
  };
  appendCodingLedger?: CodingLedgerWriter;
}

/** @internal Source-unit control only. Production callers must omit this and use the native factory. */
export interface OwnedCodingCanaryTestDependencies {
  workerRuntime?: () => Promise<{ config: Config; worker: CodingWorker }>;
  codingPortFactory?: (slot: CanarySlot, owner: CanarySlotOwner,
    profile: NativeCodingProfile | null) => NonNullable<CanaryExecutionPorts["executeCoding"]> | null;
}

/**
 * App-owned native schedule composition. The CLI cannot construct these capabilities from JSON:
 * the caller supplies the already-owned SQLite owner, opaque qualified host profile, validated
 * private corpus, and its ordinary allowance/worker-backed ports. Missing native authority
 * defers before the schedule can claim, admit, or request a model response.
 */
export async function executeOwnedCodingCanarySchedule(input: OwnedCodingCanaryPorts,
  plan: ReturnType<typeof buildCanarySchedule>, cases: readonly CanaryCase[],
  internal: OwnedCodingCanaryTestDependencies = {}) {
  const hasCoding = cases.some(item => item.family === "coding");
  const firstCodingSlot = plan.slots.find(slot => cases.some(item => item.id === slot.caseId && item.family === "coding"));
  // No native profile issuer exists in this build (W1-T11313), so a coding schedule runs only through
  // the source-unit port factory and otherwise defers, naming why, before it can claim, admit or request.
  if (hasCoding && !internal.codingPortFactory)
    return { state: "deferred" as const, completed: 0, skipped: 0, nextSlot: firstCodingSlot?.id ?? null,
      reason: "coding-native-profile-unavailable" as const };
  if (!input.ledgerPath || !isRegisteredCanarySlotOwner(input.owner))
    return { state: "deferred" as const, completed: 0, skipped: 0, nextSlot: firstCodingSlot?.id ?? null,
      reason: "canary-owner-unavailable" as const };

  const ports: CanarySchedulePorts = {
    eligibility: input.schedulePorts.eligibility,
    claim: async slot => input.owner.claim(slot),
    ports: slot => {
      const base = input.schedulePorts.ports(slot);
      const { executeCoding: _callerExecutor, ...trustedPorts } = base;
      const executeCoding = cases.some(item => item.id === slot.caseId && item.family === "coding")
        ? (() => {
          const injected = internal.codingPortFactory!(slot, input.owner, input.profile);
          return injected ? registerQualifiedCodingExecutionPort(injected) : null;
        })() ?? undefined
        : undefined;
      const save = trustedPorts.save;
      return { ...trustedPorts, ...(executeCoding ? { executeCoding } : {}), save: async (run, grade) => {
        if (run.family === "coding") {
          const activity: CanarySourceActivity = { kind: "synthetic-canary", source: "model-canary-v1",
            sourceReceiptId: run.id, lane: "coding-control" };
          run.executionSource = "native-provider-execution";
          run.sourceActivity = activity;
        }
        await save(run, grade);
      } };
    },
    terminal: async (slot, outcome) => {
      input.owner.terminal(slot, outcome);
      if (outcome.run.family === "coding")
        codingLedgerSave(input.ledgerPath, outcome, input.appendCodingLedger);
    },
  };
  return executeCanarySchedule(plan, { cases, corpus: input.privateCorpus }, ports);
}

/** Same replay entry accepts the inert prepared native request only after an explicit owner release. */
export async function replayPrivateCli(argv: readonly string[], internal: OwnedCodingCanaryTestDependencies = {}) {
  const [, corpusFile, responseFile, ownerDir, flag, keyFile] = argv;
  if (![4, 6].includes(argv.length) || !corpusFile || !responseFile || !ownerDir)
    throw new Error("usage: model-canary-command replay-private <private-corpus.json> <response-script.json> <operator-selected-private-owner-dir> [--trust-anchors <private-anchor-file>]");
  const rawCorpus: unknown = JSON.parse(boundedCanaryAnalysisInput(corpusFile, 2 * 1024 * 1024, true));
  const replayInput: unknown = JSON.parse(boundedCanaryAnalysisInput(responseFile, 128 * 1024, true));
  if (replayInput !== null && typeof replayInput === "object" && !Array.isArray(replayInput)
    && "version" in replayInput && replayInput.version === "model-canary-coding-native-v1") {
    const request = replayInput as Record<string, unknown>;
    if (Object.keys(request).sort().join(",") !== "cases,corpusDigest,eligibility,plan,released,seed,version")
      throw new Error("coding-native-prepared-input-invalid");
    const validation = validatePrivateCorpus(rawCorpus, readPrivateCanaryTrustAnchors(flag, keyFile));
    if (validation.state !== "available") throw new Error(validation.reason);
    if (request.corpusDigest !== validation.metadata.digest || !Array.isArray(request.cases)
      || !request.cases.length || request.cases.some(item => !privateCorpusCaseMatches(validation.corpus, item)
        || item.family !== "coding")) throw new Error("coding-native-prepared-corpus-mismatch");
    const cases = request.cases as CanaryCase[];
    const e = request.eligibility;
    const fields = ["sourceAdopted", "adapterQualified", "productionBusy", "squeeze",
      "spareSubscription", "experimentalCashAllowed", "premium"] as const;
    if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).length !== fields.length
      || fields.some(field => typeof (e as Record<string, unknown>)[field] !== "boolean"))
      throw new Error("coding-native-eligibility-invalid");
    const eligibility = e as Awaited<ReturnType<CanarySchedulePorts["eligibility"]>>;
    if (request.released !== true || !eligibility.sourceAdopted || !eligibility.adapterQualified
      || eligibility.productionBusy || eligibility.squeeze || !eligibility.spareSubscription)
      return { state: "prepared-not-activated" as const, completed: 0 };
    const plan = request.plan as ReturnType<typeof buildCanarySchedule> | null;
    if (!plan || typeof request.seed !== "string" || !Array.isArray(plan.slots)
      || plan.slots.some(slot => slot.pin.billing !== "subscription" || slot.pin.route !== "claude"))
      throw new Error("coding-native-prepared-schedule-required");
    const pins = [...new Map(plan.slots.map(slot => [JSON.stringify(slot.pin), slot.pin])).values()];
    const rebuilt = buildCanarySchedule(plan.day, request.seed, cases, pins, plan.aa);
    if (JSON.stringify(rebuilt) !== JSON.stringify(plan)) throw new Error("coding-native-prepared-schedule-changed");
    // The operator-selected file releases only its already prepared schedule. It cannot select
    // a ledger, executable, profile, worker settings, credential or provider endpoint.
    const { assertExistingCanaryOwnerV1 } = await import("./model-canary-owner.js");
    assertExistingCanaryOwnerV1(ownerDir);
    // The native profile source and the production worker runtime are W1-T11313; until they are
    // wired every host is unqualified here and the schedule never reaches a worker.
    if (!internal.codingPortFactory || !internal.workerRuntime)
      return { state: "deferred" as const, completed: 0, reason: "coding-native-profile-unavailable" };
    const profile: NativeCodingProfile | null = null;
    const { config, worker } = await internal.workerRuntime(), owner = new CanarySlotOwner(ownerDir);
    try {
      const execution = codingWorkerRequestPorts(config, ownerDir, worker);
      return await executeOwnedCodingCanarySchedule({ owner, profile, privateCorpus: validation.corpus,
        ledgerPath: ledgerPathFor(config), schedulePorts: {
          eligibility: async () => eligibility, ports: () => execution,
        } }, plan, cases, internal);
    } finally { owner.close(); }
  }
  return replayPrivateControl({ rawCorpus, replayInput, ownerDir,
    trustAnchors: readPrivateCanaryTrustAnchors(flag, keyFile) });
}

// diff-cov: process-boundary — standalone CLI stdout flush and exit; the native child control proves this entry.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === "replay-private") {
    void replayPrivateCli(argv).then(result => {
      process.stdout.write(JSON.stringify(result) + "\n");
    }).catch(() => {
      process.stderr.write("private-replay-failed\n");
      process.exitCode = 1;
    });
  } else {
    const result = canaryCommand(argv);
    process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(0));
  }
}
