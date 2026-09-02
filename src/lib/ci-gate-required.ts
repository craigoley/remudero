import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export type CiGateWorkflowReader = (path: string) => string;

/** Read ci-gate's checked-in sibling contract. Any unreadable or ambiguous shape disables early fixing. */
export function readCiGateRequiredChecks(
  root: string,
  read: CiGateWorkflowReader = (path) => readFileSync(path, "utf8"),
): string[] {
  try {
    const workflow = parse(read(join(root, ".github", "workflows", "ci-gate.yml"))) as {
      jobs?: { "ci-gate"?: { env?: { REQUIRED?: unknown } } };
    } | null;
    const encoded = workflow?.jobs?.["ci-gate"]?.env?.REQUIRED;
    if (typeof encoded !== "string") return [];
    const names = JSON.parse(encoded) as unknown;
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.trim() === "")) return [];
    return [...new Set(names)];
  } catch {
    return [];
  }
}
