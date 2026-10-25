import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ghTextAsync } from "./github-transport.js";
import { withTempDir } from "./tmp.js";
import { readCodeHealthArtifactJson } from "./code-health-store.js";
import { isDeepStrictEqual } from "node:util";
import { fixedClock } from "./clock.js";
import { CODE_HEALTH_SOURCE_KINDS } from "./code-health-contract.js";
import { projectCodeHealth, independentCodeHealthScans, compareCodeHealthScanPair, codeHealthFindingFingerprint, codeHealthFindingFixedAfter, codeHealthSeverityAtLeast, type CodeHealthProjectionInput, type CodeHealthScan } from "./code-health-projection.js";

export interface CodeHealthCollection {
  repository: string;
  currentSha: string;
  observedAt: string;
  scans: CodeHealthScan[];
  previous: CodeHealthProjectionInput | null;
}

const SOURCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const registry: CodeHealthProjectionInput["registry"] = {
  version: "code-health-existing-policy-v1",
  checks: [
    { id: "quality-maintainability-open", sourceKind: "quality", category: "maintainability", description: "No unresolved findings in the existing CodeQL maintainability subset." },
    { id: "coverage-existing-tier", sourceKind: "coverage", category: "tests", description: "Meets this repository's existing instrumented coverage tier." },
  ],
};

/** Assembly has no network, model, filing, or dispatch effects. */
export function prepareCodeHealthCollection(input: CodeHealthCollection): CodeHealthProjectionInput {
  projectCodeHealth({ repository: input.repository, currentSha: input.currentSha, analyzedSha: input.currentSha,
    observedAt: input.observedAt, nextDueAt: null, registry, scans: input.scans, baseline: null });
  const previous = input.previous;
  if (previous && previous.repository.toLowerCase() !== input.repository.toLowerCase()) throw new Error("The previous code health evidence belongs to another repository.");
  const past = previous ? [...previous.scans, ...(previous.baseline?.scans ?? []), ...(previous.retainedEvidence ?? []).map(entry => entry.scan)] : [];
  const scans = CODE_HEALTH_SOURCE_KINDS.map(kind => {
    const measured = input.scans.filter(scan => scan.kind === kind);
    if (measured.length > 1) throw new Error("The collection contains duplicate required sources.");
    const scan = measured[0];
    if (!scan) return { kind, repository: input.repository.toLowerCase(), scanId: `not-collected:${kind}`, analyzedSha: "", observedAt: "",
      state: "not_collected", scopeHash: null, toolVersion: null, rulesVersion: null, configHash: null, exclusions: [],
      reason: "This required source did not supply a measured result.", checks: [], findings: [] } satisfies CodeHealthScan;
    const original = past.find(prior => prior.kind === kind && prior.scanId === scan.scanId && prior.state === "complete");
    // A workflow rerun or another alert read cannot mint an independent scan or renew its clock.
    if (original && scan.state === "complete") {
      if (isDeepStrictEqual({ ...original, observedAt: "" }, { ...scan, observedAt: "" })) return structuredClone(original);
      return { ...structuredClone(scan), observedAt: original.observedAt, state: "partial",
        reason: "A saved measurement identity returned different source facts. Its results need verification." } satisfies CodeHealthScan;
    }
    return structuredClone(scan);
  });
  const analyzedSha = scans.find(scan => /^[a-f0-9]{40}$/i.test(scan.analyzedSha))?.analyzedSha ?? input.currentSha;
  const priorAssessment = previous ? projectCodeHealth(previous) : null;
  const previousComplete = previous !== null && priorAssessment !== null && CODE_HEALTH_SOURCE_KINDS.every(kind =>
    priorAssessment.sources.some(source => source.required && source.kind === kind && source.state === "complete" && source.analyzedSha === previous.analyzedSha));
  const independentCollection = previousComplete && CODE_HEALTH_SOURCE_KINDS.every(kind => {
    const current = scans.find(scan => scan.kind === kind)!, prior = previous!.scans.find(scan => scan.kind === kind)!;
    return current.state === "complete" && current.analyzedSha === analyzedSha && independentCodeHealthScans(current, prior);
  });
  const baseline = independentCollection ? { analyzedSha: previous!.analyzedSha, policyVersion: previous!.registry.version, scans: structuredClone(previous!.scans) } : previous?.baseline ?? null;
  const retained = previous ? [...(previous.retainedEvidence ?? []), ...previous.scans.filter(scan => scan.findings.some(finding => finding.status !== "fixed"))
    .map(scan => ({ policyVersion: previous.registry.version, scan }))] : [];
  const known = new Map<string, typeof retained[number]>();
  for (const entry of retained) {
    const key = JSON.stringify([entry.policyVersion, entry.scan.kind, entry.scan.scanId, entry.scan.analyzedSha, entry.scan.observedAt]);
    if (!known.has(key)) known.set(key, structuredClone(entry));
  }
  const result: CodeHealthProjectionInput = { repository: input.repository.toLowerCase(), currentSha: input.currentSha.toLowerCase(), analyzedSha: analyzedSha.toLowerCase(),
    observedAt: input.observedAt, nextDueAt: fixedClock(Date.parse(input.observedAt) + SOURCE_INTERVAL_MS).iso(), registry: structuredClone(registry), scans,
    baseline: baseline ? structuredClone(baseline) : null, retainedEvidence: [...known.values()] };
  const completeKinds = new Set(projectCodeHealth({ ...result, retainedEvidence: [] }).sources.filter(source => source.required && source.state === "complete").map(source => source.kind));
  result.retainedEvidence = result.retainedEvidence!.filter(entry => {
    const current = result.scans.find(scan => scan.kind === entry.scan.kind);
    if (!current || !completeKinds.has(entry.scan.kind)) return true;
    const measured = new Map(current.findings.map(finding => [codeHealthFindingFingerprint(result.repository, current.kind, finding), finding]));
    const pair = compareCodeHealthScanPair({ ...result, baseline: { analyzedSha: entry.scan.analyzedSha, policyVersion: entry.policyVersion, scans: [entry.scan] } }, current, entry.scan);
    return entry.scan.findings.some(finding => {
      if (finding.status === "fixed") return false;
      const known = measured.get(codeHealthFindingFingerprint(result.repository, current.kind, finding));
      if (known && known.status !== "fixed" && codeHealthSeverityAtLeast(known.severity, finding.severity) &&
          (!Number.isFinite(Date.parse(entry.scan.observedAt)) || Date.parse(current.observedAt) >= Date.parse(entry.scan.observedAt))) return false;
      return !(pair === "comparable" && codeHealthFindingFixedAfter(known, entry.scan.observedAt));
    });
  });
  projectCodeHealth(result); // Refuse overflow or invalid evidence without discarding the prior saved snapshot.
  return result;
}

export interface CodeHealthQualityEvidenceRead {
  currentSha: string;
  quality: Omit<Parameters<typeof import("./codeql-quality-intake.js").qualityScanFromCollectedEvidence>[0], "repository" | "source" | "knownFindingIds">;
}

type QualityTextRead = (args: string[], opts?: { maxBuffer?: number; timeout?: number }) => Promise<string>;
const QUALITY_RESPONSE_BYTES = 512 * 1024;
const qualityObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const qualityString = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");

function configuredQualityLanguages(value: unknown): string[] {
  if (!qualityObject(value) || !qualityObject(value.jobs)) throw new Error("The configured CodeQL job inventory is unavailable.");
  const languages: string[] = [];
  for (const job of Object.values(value.jobs)) {
    if (!qualityObject(job) || !Array.isArray(job.steps) || !job.steps.some(step => qualityObject(step) && typeof step.uses === "string" && /^github\/codeql-action\/analyze@/i.test(step.uses))) continue;
    const strategy = qualityObject(job.strategy) ? job.strategy : {}, matrix = qualityObject(strategy.matrix) ? strategy.matrix : {};
    let configured: unknown[] | undefined;
    if (matrix.exclude !== undefined) throw new Error("The configured CodeQL language exclusions need explicit source support.");
    if (Array.isArray(matrix.include)) configured = matrix.include.map(entry => qualityObject(entry) ? entry.language : undefined);
    else if (Array.isArray(matrix.language)) configured = matrix.language;
    else {
      const init = job.steps.find(step => qualityObject(step) && typeof step.uses === "string" && /^github\/codeql-action\/init@/i.test(step.uses));
      const field = qualityObject(init) && qualityObject(init.with) ? init.with.languages : undefined;
      if (typeof field === "string" && !field.includes("${{")) configured = field.split(/[,\s]+/).filter(Boolean);
    }
    if (!configured?.length || configured.some(language => typeof language !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(language))) throw new Error("The configured CodeQL languages cannot be resolved safely.");
    languages.push(...configured as string[]);
  }
  if (!languages.length || languages.length > 8 || new Set(languages).size !== languages.length) throw new Error("The configured CodeQL language inventory is missing, repeated or exceeds its bound.");
  return languages.sort();
}

/** Existing GitHub transport, one completed main run, original metadata, and independently configured languages. Never reads alerts again. */
export async function readCodeHealthQualityEvidence(repository: string, readText: QualityTextRead = ghTextAsync): Promise<CodeHealthQualityEvidenceRead> {
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(repository) || /\/(?:\.|\.\.)$/.test(repository)) throw new Error("Invalid Code health repository identity.");
  const prefix = `repos/${repository.toLowerCase()}`;
  const json = async (path: string): Promise<unknown> => {
    const text = await readText(["api", `${prefix}/${path}`, "-H", "X-GitHub-Api-Version: 2026-03-10"], { maxBuffer: QUALITY_RESPONSE_BYTES, timeout: 10_000 });
    if (Buffer.byteLength(text) > QUALITY_RESPONSE_BYTES) throw new Error("Code health source response exceeds its bound.");
    return JSON.parse(text);
  };
  const head = await json("commits/main");
  if (!qualityObject(head) || typeof head.sha !== "string" || !/^[a-f0-9]{40}$/i.test(head.sha)) throw new Error("The current repository revision is unavailable.");
  const runs = await json("actions/workflows/codeql.yml/runs?branch=main&status=completed&per_page=1");
  if (!qualityObject(runs) || !Array.isArray(runs.workflow_runs) || runs.workflow_runs.length !== 1) throw new Error("No bounded completed main CodeQL run is available.");
  const run = runs.workflow_runs[0];
  if (!qualityObject(run) || !Number.isSafeInteger(run.id) || Number(run.id) <= 0 || run.head_branch !== "main" || run.status !== "completed" ||
      typeof run.head_sha !== "string" || !/^[a-f0-9]{40}$/i.test(run.head_sha) || run.path !== ".github/workflows/codeql.yml") throw new Error("The selected CodeQL run has incomplete or foreign identity.");
  const runId = String(run.id), analyzedSha = run.head_sha.toLowerCase();
  const file = await json(`contents/.github/workflows/codeql.yml?ref=${analyzedSha}`);
  if (!qualityObject(file) || file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || !Number.isSafeInteger(file.size) || Number(file.size) > 128 * 1024) throw new Error("The configured CodeQL workflow is unreadable or exceeds its bound.");
  const workflow = Buffer.from(file.content, "base64");
  if (workflow.length !== file.size || workflow.length > 128 * 1024) throw new Error("The configured CodeQL workflow size does not match.");
  const requiredLanguages = configuredQualityLanguages(parseYaml(workflow.toString("utf8")));
  const listed = await json(`actions/runs/${runId}/artifacts?per_page=100`);
  if (!qualityObject(listed) || !Number.isSafeInteger(listed.total_count) || Number(listed.total_count) > 100 || !Array.isArray(listed.artifacts) || listed.artifacts.length !== listed.total_count) throw new Error("The CodeQL artifact inventory is incomplete or exceeds its bound.");
  const availableArtifacts = listed.artifacts;
  const selected = requiredLanguages.map(language => {
    const name = `code-health-quality-${language}`, matches = availableArtifacts.filter(artifact => qualityObject(artifact) && artifact.name === name);
    if (matches.length !== 1) throw new Error("A configured original-output artifact is missing or repeated.");
    const artifact = matches[0] as Record<string, unknown>, source = artifact.workflow_run;
    if (!Number.isSafeInteger(artifact.id) || Number(artifact.id) <= 0 || artifact.expired !== false || !Number.isSafeInteger(artifact.size_in_bytes) ||
        Number(artifact.size_in_bytes) <= 0 || Number(artifact.size_in_bytes) > 256 * 1024 || !qualityObject(source) || source.id !== run.id ||
        source.head_sha !== run.head_sha || source.head_branch !== "main" || !Number.isSafeInteger(source.repository_id) || source.repository_id !== source.head_repository_id)
      throw new Error("A CodeQL artifact is expired, oversized, or belongs to another workflow run or repository.");
    return { language, name };
  });
  const artifacts = await withTempDir("code-health-quality", async root => {
    const values: unknown[] = [];
    for (const artifact of selected) {
      const dir = join(root, artifact.language);
      await readText(["run", "download", runId, "--repo", repository.toLowerCase(), "--name", artifact.name, "--dir", dir], { maxBuffer: 16 * 1024, timeout: 10_000 });
      values.push(readCodeHealthArtifactJson(join(dir, "code-health-quality.json")));
    }
    return values;
  });
  const raw = await json("code-scanning/analyses?ref=refs%2Fheads%2Fmain&tool_name=CodeQL&per_page=100");
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new Error("The bounded CodeQL analysis inventory is unavailable.");
  let lastAt = Number.POSITIVE_INFINITY;
  const analyses: CodeHealthQualityEvidenceRead["quality"]["analyses"] = raw.map(value => {
    if (!qualityObject(value) || value.ref !== "refs/heads/main" || !qualityObject(value.tool) || String(value.tool.name).toLowerCase() !== "codeql" ||
        typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at)) || Date.parse(value.created_at) > lastAt) throw new Error("The analysis inventory is invalid or not ordered newest first.");
    lastAt = Date.parse(value.created_at);
    const bounded = (value: unknown, max = 256): string => qualityString(value, max) ? value : "";
    return { sarifId: bounded(value.sarif_id), analyzedSha: bounded(value.commit_sha).toLowerCase(), category: bounded(value.category),
      toolVersion: bounded(value.tool.version), analysisKey: bounded(value.analysis_key),
      environmentHash: qualityString(value.environment) ? createHash("sha256").update(value.environment).digest("hex") : "",
      createdAt: fixedClock(Date.parse(value.created_at)).iso(), rulesCount: Number.isSafeInteger(value.rules_count) ? Number(value.rules_count) : -1,
      error: value.error === "" ? "" : bounded(value.error, 2048) || "The analysis error state is unavailable.",
      warning: value.warning === "" ? "" : bounded(value.warning, 2048) || "The analysis warning state is unavailable." };
  });
  // GitHub returns newest first. Finding every original SARIF ID proves this page covers all
  // newer analyses relevant to the selected artifacts; it does not claim complete historical coverage.
  if (artifacts.some(artifact => !qualityObject(artifact) || !analyses.some(analysis => analysis.sarifId === artifact.sarifId))) throw new Error("The bounded analysis page does not cover every configured artifact.");
  return { currentSha: head.sha.toLowerCase(), quality: { analyzedSha, runId, requiredLanguages, artifacts, analyses } };
}
