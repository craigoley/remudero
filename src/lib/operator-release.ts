import { createHash } from "node:crypto";
import { readFileIfExists } from "./fs-race-safe.js";

/** Missing history is empty; unreadable history must reach the release authority as an error. */
export function readReleaseLedgerLines(path: string): readonly string[] {
  return (readFileIfExists(path) ?? "").split("\n").filter(Boolean);
}

type ReleaseContract = { id: string; sourcePath?: unknown; attempts?: unknown; catalog?: unknown; moved_from?: unknown;
  risk_ruling?: { operator_release_pin?: string }; verify?: unknown };

export type ReleaseEvidence = ReadonlyMap<string, unknown> | ReadonlySet<string>;
export type ReleaseAuthor = "operator" | "machine";

/** Pins the loaded contract, excluding only runtime bookkeeping and the ruling it authorizes.
 *  W1-T12224: `verify` is pinned as written. A release authorizes dispatch only, so a later human<->auto edit
 *  changes the contract the operator approved and needs a fresh `rmd approve`.
 *  W1-T13386: `catalog` is where a reader found the record, stamped on after the read, never a term of the
 *  contract. The daemon's tick hashes an ops record without the stamp and the task's own run hashes it with
 *  the stamp, so a pin that included it made one release read as two contracts.
 *  W1-T14408: `moved_from` is the provenance line the catalog mover (W1-T13680) writes into a record's ops copy,
 *  never a term the operator approved. A pin that included it read a record released in the public catalog as
 *  reapproval required once moved. Every other term, the title, files, acceptance and design included, stays pinned. */
export function operatorReleasePin(task: ReleaseContract): string {
  const { sourcePath: _source, attempts: _attempts, catalog: _catalog, moved_from: _moved, risk_ruling: _ruling, ...contract } = task;
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).filter(k => record[k] !== undefined).sort()
        .map(k => `${JSON.stringify(k)}:${stable(record[k])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  };
  return createHash("sha256").update(stable(contract)).digest("hex");
}

export function releaseContractPins(tasks: readonly ReleaseContract[]): (id: string) => string | undefined {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const pins = new Map<string, string>();
  return id => {
    const task = byId.get(id);
    if (task === undefined) return undefined;
    let pin = pins.get(id);
    if (pin === undefined) { pin = operatorReleasePin(task); pins.set(id, pin); }
    return pin;
  };
}

/** Old ID-only evidence is retained as a hold, never silently upgraded into a new grant.
 *  Only a matching operator receipt clears a human hold; a machine cannot reapprove it. */
export function qualifyReleaseEvidence(
  lines: readonly string[], durable: ReleaseEvidence = new Map(), pins: ReadonlyMap<string, string> | ((id: string) => string | undefined) = new Map(),
): { authors: Map<string, ReleaseAuthor>; reapproval: Set<string>; unknownHistory: boolean } {
  const operators = new Set<string>();
  const machines = new Set<string>();
  const reapproval = new Set<string>();
  let unknownHistory = false;
  const observe = (id: string, pin: unknown, author: ReleaseAuthor): void => {
    if (typeof pin === "string" && (typeof pins === "function" ? pins(id) : pins.get(id)) === pin) (author === "operator" ? operators : machines).add(id);
    else if (author === "operator") reapproval.add(id);
  };
  for (const line of lines) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch {
      // It may conceal a human hold; a machine cannot turn unread history into absence.
      unknownHistory = true;
      continue;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) { unknownHistory = true; continue; }
    if (row.step !== "ratify.approved") continue;
    if (typeof row.task_id !== "string" || !row.task_id) { unknownHistory = true; continue; }
    observe(row.task_id, row.release_pin, row.author_class === "machine" ? "machine" : "operator");
  }
  for (const entry of durable) {
    if (typeof entry === "string") observe(entry, undefined, "operator");
    else {
      const [id, value] = entry;
      observe(id, value !== null && typeof value === "object" ? (value as Record<string, unknown>).pin : undefined, "operator");
    }
  }
  const authors = new Map<string, ReleaseAuthor>();
  for (const id of machines) if (!reapproval.has(id)) authors.set(id, "machine");
  for (const id of operators) { authors.set(id, "operator"); reapproval.delete(id); }
  return { authors, reapproval, unknownHistory };
}

export const RELEASE_LIFECYCLE_STATUSES = ["queued", "recon", "prompted", "running", "review", "fixing", "diagnosing", "blocked", "merged", "done"] as const;

/** A pinned operator ruling keeps its contract after landing; a status flip (plan.ts's TASK_STATUSES, mirrored) is bookkeeping. */
export function operatorReleaseContractChanged(task: ReleaseContract & { status?: unknown }): boolean {
  const pin = task.risk_ruling?.operator_release_pin;
  if (pin === undefined || pin === operatorReleasePin(task)) return false;
  return !RELEASE_LIFECYCLE_STATUSES.some((status) => status !== task.status && pin === operatorReleasePin({ ...task, status } as ReleaseContract));
}
