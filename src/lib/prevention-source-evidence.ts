/** Source adoption is file identity plus later relevant work, separate from causal efficacy. */
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, relative } from "node:path";

const SHA = /^[0-9a-f]{40}$/;
const PATH = /^(?:src|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|js|sh)$/;
const validPath = (path: unknown): path is string => typeof path === "string" && PATH.test(path)
  && !path.split("/").some((part) => part === ".." || part === ".");
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
type Unknown = { state: "unavailable"; reason: string };
export type ImportedModuleEvidence = { state: "observed"; source: "module-import-git";
  path: string; blob: string; revision: string; capturedAt: string } | Unknown;
export interface PreventionSourceRegistration {
  id: string; taskId: string; causeKey: string; path: string; blob: string; mergeRevision: string; mergedAt: string;
  workScope: "fix-worker-attempt";
}

/** Call exactly once from the importing module, with its already captured clean source pin.
 * Matching the tracked commit blob to the physical file refuses a checkout changed during capture. */
export function captureImportedModule(moduleFile: string, pin: unknown,
  git: (args: string[]) => string = (args) => execFileSync("git", ["-C", dirname(moduleFile), ...args],
    { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024 }),
  now: () => string = () => new Date().toISOString(),
): ImportedModuleEvidence {
  const value = object(pin);
  if (value?.source !== "executing-module-git" || !SHA.test(String(value.revision)))
    return { state: "unavailable", reason: "no-clean-executing-module-pin" };
  try {
    const root = git(["rev-parse", "--show-toplevel"]).trim();
    const path = relative(root, moduleFile);
    if (isAbsolute(path) || !validPath(path)) return { state: "unavailable", reason: "module-path-not-a-source-file" };
    const blob = git(["rev-parse", `${value.revision}:${path}`]).trim();
    const actual = git(["hash-object", "--no-filters", "--", moduleFile]).trim();
    const capturedAt = now();
    if (!SHA.test(blob) || actual !== blob || !time(capturedAt)) return { state: "unavailable", reason: "module-source-capture-mismatch" };
    return { state: "observed", source: "module-import-git", path, blob, revision: String(value.revision), capturedAt };
  } catch {
    return { state: "unavailable", reason: "module-source-read-failed" };
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function importedModuleOf(value: unknown): ImportedModuleEvidence {
  const row = object(value);
  return row?.state === "observed" && row.source === "module-import-git" && validPath(row.path)
    && SHA.test(String(row.blob)) && SHA.test(String(row.revision)) && time(row.capturedAt)
    ? row as unknown as Extract<ImportedModuleEvidence, { state: "observed" }>
    : { state: "unavailable", reason: "qualifying-imported-module-not-recorded" };
}

export function preventionRegistrationsOf(value: unknown): PreventionSourceRegistration[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((item) => {
    const row = object(item);
    return row && typeof row.id === "string" && row.id.startsWith("ci-friction:") && typeof row.taskId === "string" && row.taskId.length > 0
      && typeof row.causeKey === "string" && row.causeKey.length > 0 && validPath(row.path) && SHA.test(String(row.blob))
      && SHA.test(String(row.mergeRevision)) && time(row.mergedAt) && row.workScope === "fix-worker-attempt"
      ? [row as unknown as PreventionSourceRegistration] : [];
  });
}

interface SourceRow {
  step: string; ts: string | null; host: string | null; assignmentId: string | null; success: boolean | null;
  importedModule?: ImportedModuleEvidence; preventions?: PreventionSourceRegistration[];
  repair?: { repo: string | null; number: number | null; workerRunId: string | null; roundId: string | null; rung: string | null; assignmentObserved: boolean };
}
export interface PreventionAdoptionReport {
  id: string; taskId: string; causeKey: string; expectedSource: PreventionSourceRegistration;
  loadedSource: ImportedModuleEvidence;
  laterWork: { state: "observed"; at: string; host: string; workerRunId: string; assignmentId: string; success: boolean } | Unknown;
  basis: "exact-module-file-and-later-fix-attempt";
  efficacyClaim: "none"; history: "unavailable-retention-uncertified";
}

/** A bounded registration fold and one assignment/terminal index, not a second fleet collector. */
export function preventionAdoption(rows: readonly SourceRow[], asOf: string): {
  state: "observed-partial" | "unavailable"; reason: string; omittedRegistrations: number; records: PreventionAdoptionReport[];
} {
  if (!time(asOf)) return { state: "unavailable", reason: "invalid-observation-time", omittedRegistrations: 0, records: [] };
  const registrations = new Map<string, PreventionSourceRegistration>();
  const assignments = new Map<string, SourceRow[]>();
  const terminals = new Map<string, SourceRow[]>();
  let omittedRegistrations = 0;
  const join = (row: SourceRow) => JSON.stringify([row.host, row.repair?.workerRunId, row.assignmentId]);
  for (const row of rows) {
    if (!time(row.ts) || Date.parse(row.ts) > Date.parse(asOf)) continue;
    if (row.step === "ci-friction.scorecard") for (const source of preventionRegistrationsOf(row.preventions)) {
      if (Date.parse(source.mergedAt) > Date.parse(row.ts)) continue;
      const key = JSON.stringify([source.id, source.taskId, source.mergeRevision, source.path, source.blob]);
      if (registrations.has(key) || registrations.size < 32) registrations.set(key, source);
      else omittedRegistrations += 1;
    }
    if (row.repair?.rung !== "fix" || !row.repair.workerRunId || !row.repair.roundId || row.assignmentId === null
      || row.host === null || row.repair.repo === null || row.repair.number === null || row.repair.assignmentObserved === false) continue;
    const loaded = importedModuleOf(row.importedModule);
    if (row.step === "worker.assignment" && loaded.state === "observed") {
      const key = JSON.stringify([loaded.path, loaded.blob]);
      let group = assignments.get(key);
      if (group === undefined) { group = []; assignments.set(key, group); }
      group.push(row);
    }
    if (row.step === "worker.attempt") {
      let group = terminals.get(join(row));
      if (group === undefined) { group = []; terminals.set(join(row), group); }
      group.push(row);
    }
  }
  const records = [...registrations.values()].map((source) => {
    let loadedSource: ImportedModuleEvidence = { state: "unavailable", reason: "no-matching-module-import-after-merge" };
    let laterWork: PreventionAdoptionReport["laterWork"] = { state: "unavailable", reason: "no-later-relevant-fix-attempt" };
    for (const assignment of assignments.get(JSON.stringify([source.path, source.blob])) ?? []) {
      const loaded = assignment.importedModule;
      if (loaded?.state !== "observed" || loaded.path !== source.path || loaded.blob !== source.blob
        || Date.parse(loaded.capturedAt) < Date.parse(source.mergedAt) || Date.parse(loaded.capturedAt) > Date.parse(assignment.ts!)) continue;
      loadedSource = loaded;
      const group = terminals.get(join(assignment)) ?? [];
      const outcomes = new Set(group.map((row) => JSON.stringify([row.repair?.repo, row.repair?.number, row.repair?.roundId, row.success])));
      if (outcomes.size > 1) { laterWork = { state: "unavailable", reason: "conflicting-terminal-work-receipts" }; continue; }
      const terminal = group.find((row) => row.repair?.roundId === assignment.repair!.roundId
        && row.repair.repo === assignment.repair!.repo && row.repair.number === assignment.repair!.number
        && typeof row.success === "boolean" && Date.parse(row.ts!) >= Date.parse(assignment.ts!));
      if (terminal) { laterWork = { state: "observed", at: terminal.ts!, host: terminal.host!,
        workerRunId: terminal.repair!.workerRunId!, assignmentId: terminal.assignmentId!, success: terminal.success! }; break; }
    }
    return { id: source.id, taskId: source.taskId, causeKey: source.causeKey, expectedSource: source,
      loadedSource, laterWork, basis: "exact-module-file-and-later-fix-attempt" as const,
      efficacyClaim: "none" as const, history: "unavailable-retention-uncertified" as const };
  });
  return { state: records.length > 0 ? "observed-partial" : "unavailable",
    reason: records.length > 0 ? "file-adoption-only-retention-uncertified" : "no-qualified-source-registration",
    omittedRegistrations, records };
}
