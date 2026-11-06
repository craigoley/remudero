/** Read private field-trial snapshots/candidates without refresh, publication, or promotion effects. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { CanaryFieldComparisonIdentityV1, FieldTrialComparisonCohortV1 } from "./model-canary-field-comparison.js";

export interface NativeFieldEvidenceV1 {
  version: "native-field-evidence-v1";
  private: true;
  observational: true;
  causalClaims: "none";
  asOf: string;
  fieldTrials: FieldTrialComparisonCohortV1[];
  unmatchedControlledCandidates: number;
  unmatchedControlledReasons: { candidateDigest: string; reason: string }[];
}
export type NativeFieldEvidenceResultV1 = { state: "available"; evidence: NativeFieldEvidenceV1 }
  | { state: "unavailable"; reason: string };
// Bound snapshots at 32 MiB: the current native flow snapshot is about 14 MiB, with growth headroom.
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024, MAX_CANDIDATES = 128;
const nativeFieldSha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const nativeFieldRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function assertNativeFieldPrivateDirectory(path: string): void {
  const requested = resolve(path), info = lstatSync(requested), real = realpathSync(requested), stat = lstatSync(real);
  if (!info.isDirectory() || info.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700
    || (typeof process.getuid === "function" && stat.uid !== process.getuid()))
    throw new Error("native-field-private-directory-required");
  for (let parent = real; ; parent = dirname(parent)) {
    if (lstatSync(parent).isDirectory() && (nativeFieldHasGitMarker(parent))) throw new Error("native-field-inside-git");
    if (dirname(parent) === parent) break;
  }
}
function nativeFieldHasGitMarker(dir: string): boolean {
  return readdirSync(dir).includes(".git");
}
function readNativeFieldPrivateJson(path: string, limit: number): unknown {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0
    || !Number.isInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK <= 0)
    throw new Error("native-field-platform-unsupported");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit || (info.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid()))
      throw new Error("native-field-private-file-required");
    const buffer = Buffer.alloc(info.size + 1); let length = 0;
    while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n; }
    if (length > limit) throw new Error("native-field-bound");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally { closeSync(fd); }
}
function nativeFieldIncompleteIdentity(cohort: Record<string, unknown>): CanaryFieldComparisonIdentityV1 {
  const revisions = nativeFieldRecord(cohort.revisions) ? cohort.revisions : {};
  const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
  const treatmentParts = { scaffold: text(revisions.prompt), tools: text(revisions.tool),
    context: text(revisions.environment), cache: text(revisions.cache) };
  const treatment: CanaryFieldComparisonIdentityV1["treatment"] = treatmentParts.scaffold !== null
    && treatmentParts.tools !== null && treatmentParts.context !== null && treatmentParts.cache !== null
    ? { scaffold: treatmentParts.scaffold, tools: treatmentParts.tools, context: treatmentParts.context, cache: treatmentParts.cache }
    : null;
  return {
    provider: text(cohort.provider), deployment: null, requestedModel: text(cohort.selectedModel),
    model: text(cohort.servedModel), route: null, effort: text(cohort.selectedEffort), billing: null,
    treatment, corpusDigest: null, scorerDigest: null, role: null, observationWindow: null,
  };
}
function nativeFieldObservationalRows(snapshot: Record<string, unknown>): FieldTrialComparisonCohortV1[] {
  if (!Array.isArray(snapshot.servedTrialCohorts)) return [];
  const result: FieldTrialComparisonCohortV1[] = [];
  for (const source of snapshot.servedTrialCohorts) {
    if (!nativeFieldRecord(source) || !nativeFieldRecord(source.evidence) || source.evidence.observational !== true || source.evidence.causalClaims !== "none"
      || !Array.isArray(source.evidence.cohorts)) throw new Error("native-field-observational-contract-invalid");
    for (const raw of source.evidence.cohorts) {
      if (!nativeFieldRecord(raw) || !Number.isSafeInteger(raw.assignments) || Number(raw.assignments) < 0
        || !Number.isSafeInteger(raw.workerSucceeded) || Number(raw.workerSucceeded) < 0
        || !Number.isSafeInteger(raw.workerFailed) || Number(raw.workerFailed) < 0
        || Number(raw.workerSucceeded) + Number(raw.workerFailed) > Number(raw.assignments))
        throw new Error("native-field-observational-cohort-invalid");
      const id = nativeFieldSha256(JSON.stringify([source.source, source.repo, raw.host, raw.period, raw.provider,
        raw.selectedModel, raw.servedModel, raw.selectedEffort, raw.taskClass, raw.risk, raw.workLane, raw.revisions]));
      const assigned = Number(raw.assignments), observed = Number(raw.workerSucceeded) + Number(raw.workerFailed);
      result.push({ id, design: "observational", state: "observed", identity: nativeFieldIncompleteIdentity(raw),
        assignedTasks: assigned, observedTasks: observed, successfulTasks: Number(raw.workerSucceeded),
        assignmentAudit: null, randomizationUnit: null, analysis: null, assignmentProbabilities: null });
    }
  }
  return result;
}
function nativeControlledCandidateRefusal(release: unknown, sidecar: unknown, expectedReleaseId: string): string | null {
  if (!nativeFieldRecord(release)) return "controlled-candidate-invalid";
  if (release.releaseId !== expectedReleaseId || typeof release.releaseId !== "string"
    || !/^controlled-[a-f0-9]{16}$/.test(release.releaseId))
    return "controlled-release-id-filename-mismatch";
  if ("controlled-" + nativeFieldSha256(JSON.stringify({ ...release, releaseId: "" })).slice(0, 16) !== expectedReleaseId)
    return "controlled-release-content-digest-mismatch";
  if (!nativeFieldRecord(sidecar)) return "controlled-sidecar-invalid";
  if (typeof sidecar.releaseId !== "string") return "controlled-sidecar-release-id-unavailable";
  if (sidecar.releaseId !== expectedReleaseId) return "controlled-sidecar-release-id-mismatch";
  if (typeof sidecar.epochId !== "string" || sidecar.epochId.length < 1 || sidecar.epochId.length > 160)
    return "controlled-sidecar-epoch-id-unavailable";
  // The existing candidate/sidecar contract carries no native registered-epoch receipt joining this epoch ID to
  // the release's assignment probabilities. Preserve it as unmatched until that producer contract exists.
  return "controlled-registered-epoch-linkage-unavailable";
}
export function createNativeFieldEvidenceReader(outDir: string): () => NativeFieldEvidenceResultV1 {
  return () => {
    try {
      assertNativeFieldPrivateDirectory(outDir);
      const snapshot = readNativeFieldPrivateJson(join(outDir, "field-trials-flow-v1.json"), MAX_SNAPSHOT_BYTES);
      if (!nativeFieldRecord(snapshot) || (snapshot.state !== "observed" && snapshot.state !== "observed-partial")
        || snapshot.observational !== true || snapshot.causalClaims !== "none" || typeof snapshot.asOf !== "string")
        return { state: "unavailable", reason: "native-field-snapshot-contract-unavailable" };
      const fieldTrials = nativeFieldObservationalRows(snapshot);
      const controlledDir = join(outDir, "controlled");
      let unmatchedControlledCandidates = 0;
      const unmatchedControlledReasons: { candidateDigest: string; reason: string }[] = [];
      try {
        const info = lstatSync(controlledDir);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
          || (typeof process.getuid === "function" && info.uid !== process.getuid()))
          throw new Error("native-field-controlled-directory-private-required");
        const directoryEntries = readdirSync(controlledDir);
        const entryNames = new Set(directoryEntries);
        const names = directoryEntries.filter(name => /^controlled-[a-f0-9]{16}\.candidate\.json$/.test(name)).sort();
        if (names.length > MAX_CANDIDATES) throw new Error("native-field-controlled-candidate-bound");
        for (const name of names) {
          const expectedReleaseId = name.slice(0, -".candidate.json".length);
          const candidatePath = join(controlledDir, name);
          const sidecarPath = join(controlledDir, expectedReleaseId + ".sidecar.private.json");
          const sidecarName = expectedReleaseId + ".sidecar.private.json";
          if (!entryNames.has(sidecarName)) {
            unmatchedControlledCandidates++; unmatchedControlledReasons.push({ candidateDigest: nativeFieldSha256(name), reason: "controlled-sidecar-missing" }); continue;
          }
          const candidate: unknown = readNativeFieldPrivateJson(candidatePath, 1024 * 1024);
          const sidecar: unknown = readNativeFieldPrivateJson(sidecarPath, 1024 * 1024);
          const refusal = nativeControlledCandidateRefusal(candidate, sidecar, expectedReleaseId);
          if (refusal) {
            unmatchedControlledCandidates++; unmatchedControlledReasons.push({ candidateDigest: nativeFieldSha256(name), reason: refusal }); continue;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return { state: "available", evidence: { version: "native-field-evidence-v1", private: true,
        observational: true, causalClaims: "none", asOf: snapshot.asOf, fieldTrials,
        unmatchedControlledCandidates, unmatchedControlledReasons } };
    } catch (error) {
      return { state: "unavailable", reason: error instanceof Error && error.message.startsWith("native-field-")
        ? error.message : "native-field-evidence-unreadable" };
    }
  };
}
