import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export type CiGateWorkflowReader = (path: string) => string;

export interface CiGateRequiredSource {
  repository: string;
  checkoutRoot: string;
  isSelf: boolean;
}

export function resolveCiGateRequiredSource(
  target: { owner: string; repo: string },
  roots: { self?: { owner: string; repo: string }; selfRoot: string; configRoot: string; checkoutRoot?: string },
): CiGateRequiredSource {
  const repository = `${target.owner}/${target.repo}`;
  const isSelf = roots.self !== undefined
    && repository.toLowerCase() === `${roots.self.owner}/${roots.self.repo}`.toLowerCase();
  const checkoutRoot = roots.checkoutRoot ?? (isSelf ? roots.selfRoot : join(roots.configRoot, "repos", target.repo));
  return { repository, isSelf, checkoutRoot };
}

type WorkflowRead = { kind: "names"; names: string[] } | { kind: "unreadable"; path: string; reason: string };

function readRequiredWorkflow(root: string, read: CiGateWorkflowReader): WorkflowRead {
  const path = join(root, ".github", "workflows", "ci-gate.yml");
  try {
    const workflow = parse(read(path)) as {
      jobs?: { "ci-gate"?: { env?: { REQUIRED?: unknown } } };
    } | null;
    const encoded = workflow?.jobs?.["ci-gate"]?.env?.REQUIRED;
    if (typeof encoded !== "string") {
      return { kind: "unreadable", path, reason: "jobs.ci-gate.env.REQUIRED is not a JSON string" };
    }
    const names = JSON.parse(encoded) as unknown;
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.trim() === "")) {
      return { kind: "unreadable", path, reason: "REQUIRED must decode to an array of nonblank check names" };
    }
    return { kind: "names", names: [...new Set(names)] };
  } catch (error) {
    return { kind: "unreadable", path, reason: String(error) };
  }
}

const readWorkflowFile: CiGateWorkflowReader = (path) => readFileSync(path, "utf8");

export type CiGateRequiredRead =
  | { kind: "names"; names: string[] }
  | { kind: "unreadable"; repository: string; path: string; reason: string };

export function readCiGateRequiredContract(
  source: CiGateRequiredSource,
  read: CiGateWorkflowReader = readWorkflowFile,
): CiGateRequiredRead {
  const result = readRequiredWorkflow(source.checkoutRoot, read);
  if (result.kind === "names") return result;
  return source.isSelf ? { kind: "names", names: [] } : { ...result, repository: source.repository };
}

export function readCiGateRequiredNames(
  source: CiGateRequiredSource,
  log: (step: string, fields: Record<string, unknown>) => void,
): string[] {
  const result = readCiGateRequiredContract(source);
  if (result.kind === "names") return result.names;
  log("ci_gate.required_unreadable", { repository: result.repository, path: result.path, reason: result.reason });
  return [];
}

/** Compatibility for the already repository-aware dependency and daemon main-health readers. */
export function readCiGateRequiredChecks(root: string, read: CiGateWorkflowReader = readWorkflowFile): string[] {
  const result = readRequiredWorkflow(root, read);
  return result.kind === "names" ? result.names : [];
}
