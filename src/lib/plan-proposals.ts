import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readWholeFile } from "./plan.js";
import { isDemonstrationProof, isDialectPrefixed, parseWhitelistedProof } from "./review.js";

export const PROPOSAL_STATUSES = ["open", "adopted", "refuted", "superseded"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface ProposalRecord {
  id: string;
  title: string;
  status: ProposalStatus;
  falsifier: string;
  rank?: number;
  source?: string;
}

export class ProposalRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalRecordError";
  }
}

function nonemptyString(value: unknown, field: string, file: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProposalRecordError(`${file}: ${field} must be a non-empty string`);
  }
  return value;
}

/** Load one proposal mapping per YAML file. An absent directory precedes the migration and is empty. */
export function loadProposalRecords(directory: string): ProposalRecord[] {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".yaml")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ProposalRecordError(`cannot list proposals (${directory}): ${String(error)}`);
  }

  const records: ProposalRecord[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const file = join(directory, name);
    let raw: unknown;
    try {
      raw = parseYaml(readWholeFile(file));
    } catch (error) {
      throw new ProposalRecordError(`${file}: cannot read or parse proposal: ${String(error)}`);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ProposalRecordError(`${file}: proposal must be a mapping`);
    }
    const value = raw as Record<string, unknown>;
    const id = nonemptyString(value.id, "id", file);
    if (!/^P[1-9][0-9]*$/.test(id)) throw new ProposalRecordError(`${file}: invalid proposal id '${id}' (expected P<N>)`);
    if (seen.has(id)) throw new ProposalRecordError(`${file}: duplicate proposal id '${id}'`);
    seen.add(id);
    const title = nonemptyString(value.title, "title", file);
    if (!PROPOSAL_STATUSES.includes(value.status as ProposalStatus)) {
      throw new ProposalRecordError(`${file}: invalid status '${String(value.status)}' (must be ${PROPOSAL_STATUSES.join("|")})`);
    }
    const falsifier = nonemptyString(value.falsifier, "falsifier", file);
    if (!isDialectPrefixed(falsifier) || isDemonstrationProof(falsifier) || parseWhitelistedProof(falsifier) === null) {
      throw new ProposalRecordError(`${file}: falsifier must be an executable unit test: or grep: proof`);
    }
    if (value.rank !== undefined && (!Number.isInteger(value.rank) || (value.rank as number) < 1)) {
      throw new ProposalRecordError(`${file}: rank must be a positive integer`);
    }
    if (value.source !== undefined) nonemptyString(value.source, "source", file);
    records.push({
      id, title, status: value.status as ProposalStatus, falsifier,
      ...(value.rank === undefined ? {} : { rank: value.rank as number }),
      ...(value.source === undefined ? {} : { source: value.source as string }),
    });
  }
  return records;
}
