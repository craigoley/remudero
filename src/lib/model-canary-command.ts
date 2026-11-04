/** Offline CLI preparation and projection. Provider execution requires a separately admitted adapter. */
import { mkdirSync, writeFileSync, existsSync, realpathSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canarySuiteDigest, commonCanarySuite, weeklyCanarySuite, MODEL_CANARY_VERSION } from "./model-canary-suite.js";
import { projectCanaryRuns, type CanaryRun } from "./model-canary-metrics.js";
import { renderCanaryReport } from "./model-canary-report.js";
import { retentionCanaryProtocol } from "./model-canary-retention.js";
import { contextCanaryProtocol } from "./model-canary-context.js";
import { randomBytes } from "node:crypto";
import { rotatingCanarySuite } from "./model-canary-rotation.js";
import { buildEffectiveConfigCensus, type BuildEffectiveConfigCensusInput } from "./model-canary-config-census.js";
import { planCanaryMatrix } from "./model-canary-matrix-plan.js";
import { validatePrivateCorpus, buildPrivateCanaryRequest } from "./model-canary-private-corpus.js";
import { capturedPrivateTraceReceipt, gradePrivateTrace, loadPrivateTraceFromCustody,
  type PrivateTraceBindingV1 } from "./model-canary-trace-grader.js";
import { readOwnedPrivateTraceReceipt } from "./model-canary-owner.js";
import type { CanarySlot } from "./model-canary-schedule.js";

function boundedInput(input: string, limit = 8 * 1024 * 1024, privateOwned = false): string {
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

function privateOutput(dir: string, name: string, data: string) {
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

function privateTrustAnchors(flag: string | undefined, file: string | undefined): Readonly<Record<string, string>> {
  if (flag === undefined && file === undefined) return {};
  if (flag !== "--trust-anchors" || !file) throw new Error("canary-private-trust-anchor-argument-invalid");
  // This separate, operator-selected file is the trust source; corpus JSON cannot select a key.
  const parsed: unknown = JSON.parse(boundedInput(file, 64 * 1024, true));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).length > 16 || Object.entries(parsed).some(([id, key]) =>
      !/^[a-zA-Z0-9._-]{1,100}$/.test(id) || typeof key !== "string" || key.length > 4096))
    throw new Error("canary-private-trust-anchors-invalid");
  return parsed as Readonly<Record<string, string>>;
}

export function canaryCommand(argv: readonly string[]) {
  if (argv[0] === "prepare-private") {
    const [, outDir, input, flag, keyFile] = argv;
    if (![3, 5].includes(argv.length) || !outDir || !input)
      throw new Error("usage: model-canary-command prepare-private <private-out-dir> <private-corpus.json> [--trust-anchors <private-anchor-file>]");
    const bundle: unknown = JSON.parse(boundedInput(input, 2 * 1024 * 1024, true));
    const corpus = validatePrivateCorpus(bundle, privateTrustAnchors(flag, keyFile));
    if (corpus.state !== "available") throw new Error(corpus.reason);
    const requests = corpus.metadata.cases.map(item => {
      const projected = buildPrivateCanaryRequest(corpus.corpus, item.caseId);
      if (projected.state !== "available") throw new Error(projected.reason);
      return { request: projected.request, join: { requestId: projected.request.requestId,
        caseId: item.caseId, corpusDigest: corpus.metadata.digest, scorerDigest: item.scorerDigest } };
    });
    // Request payload and scorer/provenance joins are separate files; none grants execution.
    privateOutput(outDir, "model-canary-private-scorer.json", JSON.stringify(bundle, null, 2) + "\n");
    privateOutput(outDir, "model-canary-private-requests.json", JSON.stringify({
      version: "model-canary-private-requests-v1", state: "prepared-not-activated",
      requests: requests.map(item => item.request) }, null, 2) + "\n");
    privateOutput(outDir, "model-canary-private-joins.json", JSON.stringify({
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
    const corpus = validatePrivateCorpus(JSON.parse(boundedInput(corpusFile, 2 * 1024 * 1024, true)),
      privateTrustAnchors(flag, keyFile));
    if (corpus.state !== "available") throw new Error(corpus.reason);
    const value: unknown = JSON.parse(boundedInput(bindingFile, 128 * 1024, true));
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
    privateOutput(outDir, "model-canary-private-grade.json", JSON.stringify({
      version: "model-canary-private-grade-v1", corpusDigest: corpus.metadata.digest,
      evidenceSource: custodyAvailable ? "operator-selected-private-owner-custody" : "unavailable",
      binding: captured?.binding ?? null, grade }, null, 2) + "\n");
    return { state: "private-regrade", gradeState: grade.state,
      passed: grade.state === "scored" ? grade.passed : null, reason: grade.reason };
  }

  if (argv[0] === "prepare-matrix") {
    const [, outDir, input] = argv;
    if (argv.length !== 3 || !outDir || !input)
      throw new Error("usage: model-canary-command prepare-matrix <private-out-dir> <matrix-input.json>");
    const value: unknown = JSON.parse(boundedInput(input));
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
    privateOutput(outDir, "model-canary-configuration-census.json", JSON.stringify(census, null, 2) + "\n");
    privateOutput(outDir, "model-canary-matrix-manifest.json", JSON.stringify({ ...matrix, state,
      requires: ["published-source", "qualified-adapter", "capacity-admission", "shared-owner", "agreed-experiment-budget"] }, null, 2) + "\n");
    return { state, censusDigest: census.digest, matrixDigest: matrix.digest,
      configurations: census.rows.length, shards: matrix.shards.length, readiness: matrix.readiness };
  }
  if (argv[0] === "prepare-rotation") {
    const [, outDir, day, keyFile] = argv;
    if (argv.length !== 4 || !outDir || !day || !keyFile)
      throw new Error("usage: model-canary-command prepare-rotation <private-out-dir> <day> <private-key-file>");
    const key = boundedInput(keyFile, 66);
    const pack = rotatingCanarySuite(day, key.replace(/\r?\n$/, ""));
    const { cases, ...metadata } = pack;
    // Private scorer records retain expectations; the separate request manifest never does.
    privateOutput(outDir, "model-canary-rotation-scorer.json", JSON.stringify(pack, null, 2) + "\n");
    privateOutput(outDir, "model-canary-rotation-manifest.json", JSON.stringify({ ...metadata,
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
    privateOutput(outDir, "model-canary-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    return { state: manifest.state, suiteHash: manifest.suiteHash };
  }
  if (!input) throw new Error("canary-input-bound");
  const value: unknown = JSON.parse(boundedInput(input));
  if (!Array.isArray(value)) throw new Error("canary-run-array-required");
  const runs = value as CanaryRun[], projection = projectCanaryRuns(runs);
  privateOutput(outDir, "model-canary-metrics.json", JSON.stringify(projection, null, 2) + "\n");
  privateOutput(outDir, "model-canary-report.html", renderCanaryReport(runs));
  return { state: "private-projection", runs: projection.uniqueRuns };
}

// diff-cov: process-boundary — standalone CLI stdout flush and exit; the native child control proves this entry.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = canaryCommand(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(0));
}
