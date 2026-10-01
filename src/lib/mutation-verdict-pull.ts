import { inflateRawSync } from "node:zlib";
import { ghExec } from "./github-transport.js";
import type { LedgerLine } from "./ledger.js";
import { MUTATION_GATE_VERDICT_STEP } from "./retro.js";

// ── W1-T2927: the host half of the mutation-verdict transport (MASTER-PLAN D-10) ─────────────
//
// `scripts/mutation-ratchet.mjs` only ever runs inside a GitHub Actions runner, whose filesystem is
// discarded, so the `mutation.ratchet_verdict` row it emits never reached the ledger that reports
// it. ci.yml uploads that row as the `mutation-verdict-ledger` artifact (route (a), ruled by the
// operator 2026-09-30); this module is the pure half of the sweep's pull of it. It makes NO call of
// its own: the sweep hands it its own read-identity GitHub seams, each wrapped in `paceGhEntry` with
// the pacer the sweep's other REST reads share. The pull is bounded per pass, never loops on a
// refusal, and a failed list is logged by the sweep as "nothing ingested" rather than guessed past.

export const MUTATION_VERDICT_ARTIFACT_NAME = "mutation-verdict-ledger";

/** BACKSTOP: artifact downloads one pass may spend, so a first pass over a month of retained
 *  artifacts spreads across passes instead of fanning out. PRIMARY CONTROL is the ledger dedup. */
export const MUTATION_VERDICT_PULL_MAX_DOWNLOADS = 5;

export function mutationVerdictArtifactsRestArgs(owner: string, repo: string): string[] {
  return ["api", `repos/${owner}/${repo}/actions/artifacts?name=${MUTATION_VERDICT_ARTIFACT_NAME}&per_page=30`];
}

export function mutationVerdictArtifactZipRestArgs(owner: string, repo: string, artifactId: number): string[] {
  return ["api", `repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`];
}

/** The artifact-zip read the sweep uses by default: the transport its JSON reads already ride. */
export function readMutationVerdictZip(args: string[]): Buffer {
  return ghExec(args, { maxBuffer: 1 << 26 });
}

/** Every `run_id` the host ledger already holds a verdict for: the dedup key. */
export function mutationVerdictRunIdsFromLedger(lines: readonly Record<string, unknown>[]): Set<string> {
  const ids = new Set<string>();
  for (const l of lines) if (l.step === MUTATION_GATE_VERDICT_STEP && typeof l.run_id === "string") ids.add(l.run_id);
  return ids;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * The well-formed verdict rows in one artifact's text. A row survives only with the verdict step,
 * a non-empty `run_id`, a binary `conclusion` and the four Stryker totals as counts: anything else
 * would put a row on the ledger that `mutationGateLifetime` counts as a run. The runner's own
 * `ts`/`host`/`actor` are kept as `emitted_*` rather than passed through, because `appendLedger`
 * stamps the host's.
 */
export function wellFormedVerdictRows(text: string): LedgerLine[] {
  const rows: LedgerLine[] = [];
  for (const raw of text.split("\n")) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // blank or torn line: not a verdict row, and the next line may still be one
    }
    if (row === null || typeof row !== "object" || row.step !== MUTATION_GATE_VERDICT_STEP) continue;
    if (typeof row.run_id !== "string" || row.run_id === "") continue;
    if (row.conclusion !== "success" && row.conclusion !== "failure") continue;
    if (![row.killed, row.survived, row.timeout, row.no_coverage].every(isCount)) continue;
    rows.push({
      run_id: row.run_id,
      task_id: typeof row.task_id === "string" && row.task_id !== "" ? row.task_id : "mutation-ratchet",
      step: MUTATION_GATE_VERDICT_STEP,
      ...(typeof row.pr_url === "string" ? { pr_url: row.pr_url } : {}),
      conclusion: row.conclusion,
      killed: row.killed,
      survived: row.survived,
      timeout: row.timeout,
      no_coverage: row.no_coverage,
      ...(typeof row.ts === "string" ? { emitted_ts: row.ts } : {}),
      ...(typeof row.host === "string" ? { emitted_host: row.host } : {}),
    });
  }
  return rows;
}

/** The text of the artifact zip's `ledger.ndjson` member (stored or deflated), undefined when the
 *  zip has no such member. A buffer that is not a zip at all THROWS: that is a fault, not an absence. */
export function ledgerTextFromArtifactZip(zip: Buffer): string | undefined {
  const lowest = Math.max(0, zip.length - 65_557);
  let eocd = zip.length - 22;
  while (eocd >= lowest && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < lowest) throw new Error("not a zip: no end-of-central-directory record");
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = zip.readUInt16LE(eocd + 10); n > 0 && at + 46 <= zip.length; n--) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("corrupt zip: bad central-directory entry");
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const next = at + 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const local = zip.readUInt32LE(at + 42);
    at = next;
    if (name.split("/").pop() !== "ledger.ndjson" || local + 30 > zip.length) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + size);
    if (method === 0) return body.toString("utf8");
    if (method === 8) return inflateRawSync(body).toString("utf8");
  }
  return undefined;
}

/** One live, un-recorded artifact, oldest first so a backlog lands in the order it was produced. */
function pullableArtifacts(payload: unknown, recorded: ReadonlySet<string>, settled: ReadonlySet<number>) {
  const listed = (payload as { artifacts?: unknown })?.artifacts;
  if (!Array.isArray(listed)) return [];
  const live: Array<{ id: number; createdAt: string }> = [];
  for (const a of listed as Array<{ id?: unknown; name?: unknown; expired?: unknown; created_at?: unknown; workflow_run?: { id?: unknown } }>) {
    if (typeof a?.id !== "number" || a.name !== MUTATION_VERDICT_ARTIFACT_NAME || a.expired === true) continue;
    if (settled.has(a.id) || recorded.has(String(a.workflow_run?.id))) continue;
    live.push({ id: a.id, createdAt: typeof a.created_at === "string" ? a.created_at : "" });
  }
  return live.sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : x.id - y.id));
}

export interface MutationVerdictPullInput {
  owner: string;
  repo: string;
  /** Run ids the host ledger already holds a verdict for. */
  recorded: ReadonlySet<string>;
  /** Artifact ids already read and fully accounted for, owned by the caller so it outlives a pass. */
  settled: Set<number>;
  /** The sweep's paced JSON read. */
  readJson: (args: string[]) => unknown;
  /** The sweep's paced binary read, for the artifact zip. */
  readZip: (args: string[]) => Buffer;
}

export interface MutationVerdictPullResult {
  /** The rows to append: well-formed, and for a run id the ledger did not hold. */
  rows: LedgerLine[];
  /** Artifacts that could not be read this pass, with why. They are retried next pass. */
  unread: Array<{ artifactId: number; reason: string }>;
}

/** Pull un-recorded `mutation-verdict-ledger` artifacts and return their new verdict rows. The
 *  artifact LIST failing is thrown: the sweep logs it and the pass goes on, rather than reading as
 *  "nothing to ingest". */
export function pullMutationVerdicts(deps: MutationVerdictPullInput): MutationVerdictPullResult {
  const rows: LedgerLine[] = [];
  const unread: MutationVerdictPullResult["unread"] = [];
  const seen = new Set(deps.recorded);
  const artifacts = pullableArtifacts(deps.readJson(mutationVerdictArtifactsRestArgs(deps.owner, deps.repo)), seen, deps.settled);
  for (const { id } of artifacts.slice(0, MUTATION_VERDICT_PULL_MAX_DOWNLOADS)) {
    let zip: Buffer;
    try {
      zip = deps.readZip(mutationVerdictArtifactZipRestArgs(deps.owner, deps.repo, id));
    } catch (e) {
      unread.push({ artifactId: id, reason: `download: ${String((e as Error)?.message ?? e)}` });
      continue; // a transient read: NOT settled, so the next pass tries it again
    }
    // From here the bytes are in hand, so a bad zip is a property of the artifact, not the network:
    // settle it, or a corrupt oldest artifact would take a download slot on every pass forever.
    deps.settled.add(id);
    let text: string | undefined;
    try {
      text = ledgerTextFromArtifactZip(zip);
    } catch (e) {
      unread.push({ artifactId: id, reason: `unzip: ${String((e as Error)?.message ?? e)}` });
    }
    for (const row of wellFormedVerdictRows(text ?? "")) {
      if (seen.has(row.run_id)) continue;
      seen.add(row.run_id);
      rows.push(row);
    }
  }
  return { rows, unread };
}
