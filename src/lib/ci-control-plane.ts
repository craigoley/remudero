import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type CiJob = {
  name?: string;
  uses?: string;
  strategy?: { matrix?: Record<string, unknown> };
};

export type WorkflowDoc = { on?: unknown; jobs?: Record<string, CiJob> };

export type CiParityEntryShape = {
  job: string;
  mirrored: boolean;
  reason?: string;
  run?: unknown;
};

const EXTERNAL_REUSABLE_WORKFLOW_NAMES: Readonly<Record<string, readonly string[]>> = {
  "osv-scanner-pr.yml#scan-pr": ["scan-pr / osv-scan"],
};

function firesOnPullRequest(on: unknown): boolean {
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  return !!on && typeof on === "object" && "pull_request" in (on as Record<string, unknown>);
}

function substitute(name: string, key: string, value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`matrix key '${key}' has a non-scalar value (${JSON.stringify(value)})`);
  }
  return name.replace(new RegExp(`\\$\\{\\{\\s*matrix\\.${key}\\s*\\}\\}`, "g"), String(value));
}

function expandMatrixNames(template: string, matrix: Record<string, unknown>): string[] {
  const keys = Object.keys(matrix);
  if (keys.length === 1 && keys[0] === "include") {
    if (!Array.isArray(matrix.include)) throw new Error(`matrix.include is not an array (${JSON.stringify(matrix.include)})`);
    return matrix.include.map((combo) => {
      if (!combo || typeof combo !== "object" || Array.isArray(combo)) throw new Error(`matrix.include entry is not an object (${JSON.stringify(combo)})`);
      return Object.entries(combo as Record<string, unknown>).reduce((name, [key, value]) => substitute(name, key, value), template);
    });
  }
  if (keys.includes("include") || keys.includes("exclude")) throw new Error(`unsupported matrix shape (${keys.join(", ")})`);
  return Object.entries(matrix).reduce<string[]>((names, [key, values]) => {
    if (!Array.isArray(values)) throw new Error(`matrix.${key} is not an array (${JSON.stringify(values)})`);
    return names.flatMap((name) => values.map((value) => substitute(name, key, value)));
  }, [template]);
}

/** Derive every check-run name that a pull_request workflow in this tree can register. */
export function derivePrCheckCandidates(relPath: string, doc: WorkflowDoc): string[] {
  if (!firesOnPullRequest(doc.on)) return [];
  const candidates: string[] = [];
  for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
    if (job.uses) {
      const key = `${relPath}#${jobId}`;
      candidates.push(...(EXTERNAL_REUSABLE_WORKFLOW_NAMES[key] ?? [`${key} (unrecognized reusable-workflow caller — add its real check-run name(s) to EXTERNAL_REUSABLE_WORKFLOW_NAMES)`]));
      continue;
    }
    for (const name of job.strategy?.matrix ? expandMatrixNames(job.name ?? jobId, job.strategy.matrix) : [job.name ?? jobId]) {
      candidates.push(name.includes("${{") ? `${relPath}#${jobId} (unresolved template after matrix expansion: ${JSON.stringify(name)})` : name);
    }
  }
  return candidates;
}

export function findPrCheckRegistryGaps(candidates: readonly string[], required: ReadonlySet<string>, advisory: ReadonlySet<string>, ignore: ReadonlySet<string>): string[] {
  return [...new Set(candidates)].filter((candidate) => !required.has(candidate) && !advisory.has(candidate) && !ignore.has(candidate));
}

export function loadCiGateLists(repoRoot: string): { required: Set<string>; advisory: Set<string>; ignore: Set<string> } {
  const path = join(repoRoot, ".github", "workflows", "ci-gate.yml");
  const doc = parseYaml(readFileSync(path, "utf8")) as { jobs?: Record<string, { env?: Record<string, unknown> }> } | null;
  const env = doc?.jobs?.["ci-gate"]?.env;
  const parseList = (key: "REQUIRED" | "ADVISORY" | "IGNORE") => {
    const raw = env?.[key];
    if (typeof raw !== "string") throw new Error(`${path} has no ci-gate.env.${key} string`);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error(`${path}'s ci-gate.env.${key} is not a JSON string array`);
    return new Set(parsed);
  };
  return { required: parseList("REQUIRED"), advisory: parseList("ADVISORY"), ignore: parseList("IGNORE") };
}

export function loadWorkflowDocuments(repoRoot: string): Array<{ relPath: string; doc: WorkflowDoc }> {
  const workflowsDir = join(repoRoot, ".github", "workflows");
  return readdirSync(workflowsDir)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => ({ relPath: file, doc: parseYaml(readFileSync(join(workflowsDir, file), "utf8")) as WorkflowDoc }));
}

export function ciControlPlaneParity(ciJobNames: readonly string[], entries: readonly CiParityEntryShape[]): { ok: boolean; problems: string[] } {
  const byJob = new Map<string, CiParityEntryShape[]>();
  for (const entry of entries) byJob.set(entry.job, [...(byJob.get(entry.job) ?? []), entry]);
  const problems: string[] = [];
  for (const job of ciJobNames) {
    const matches = byJob.get(job) ?? [];
    if (matches.length !== 1) {
      problems.push(matches.length === 0 ? `ci.yml job '${job}' has no CI_PARITY_TABLE entry` : `ci.yml job '${job}' has ${matches.length} CI_PARITY_TABLE entries`);
      continue;
    }
    const entry = matches[0]!;
    if (entry.mirrored && typeof entry.run !== "function") problems.push(`ci.yml job '${job}' is mirrored but has no run()`);
    if (!entry.mirrored && !entry.reason?.trim()) problems.push(`ci.yml job '${job}' is excluded but has no reason`);
  }
  return { ok: problems.length === 0, problems };
}
