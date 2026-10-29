import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { sweepFeedbackLandingAsync } from "./feedback-landing.js";
import { mutationVerdictArtifactZipRestArgs, zipTextMembers } from "./mutation-verdict-pull.js";

// ── W1-T7853: fold debt a CI run files reaches the daemon's feedback inbox ───────────────────────
//
// scripts/claude-md-budget-ratchet.mjs files `plan/feedback/fold-debt-<file>-<bytes>.yaml` into a CI
// runner's throwaway checkout: the light-gates job on the PR lane, `ci` shard 1 on main's push lane.
// ci.yml uploads what each run newly filed as an artifact, and this module is the host half of the
// pull, on the channel W1-T2927 built for the mutation verdict: the sweep's own paced reads, a dedup
// on the ledger, and a per-pass bound. A PR-lane entry is held until its pull request merges at the
// head that filed it; main's push lane files only debt main already carries.

export const FOLD_DEBT_PR_ARTIFACT = "claude-md-fold-debt";
export const FOLD_DEBT_MAIN_ARTIFACT = "claude-md-fold-debt-main";
/** Terminal rows, keyed by the artifact's `workflow_run_id`: a run with one is never read again. */
export const FOLD_DEBT_INGESTED_STEP = "sweep.fold_debt_pull.ingested";
export const FOLD_DEBT_DROPPED_STEP = "sweep.fold_debt_pull.dropped";
export const FOLD_DEBT_PULL_ERROR_STEP = "sweep.fold_debt_pull.error";

/** BACKSTOP: merge lookups and downloads one pass may spend. PRIMARY CONTROL is the ledger dedup. */
export const FOLD_DEBT_PULL_MAX_READS = 5;

const ENTRY_FILE = /^(fold-debt-[A-Za-z0-9-]+-\d+)\.yaml$/;

export function foldDebtArtifactsRestArgs(owner: string, repo: string, name: string): string[] {
  return ["api", `repos/${owner}/${repo}/actions/artifacts?name=${name}&per_page=30`];
}

export function pullsForCommitRestArgs(owner: string, repo: string, sha: string): string[] {
  return ["api", `repos/${owner}/${repo}/commits/${sha}/pulls`];
}

/** Every workflow run a terminal pull row names: the dedup key. */
export function foldDebtRunIdsFromLedger(lines: readonly Record<string, unknown>[]): Set<string> {
  const ids = new Set<string>();
  for (const l of lines) {
    if ((l.step === FOLD_DEBT_INGESTED_STEP || l.step === FOLD_DEBT_DROPPED_STEP) && typeof l.workflow_run_id === "string") ids.add(l.workflow_run_id);
  }
  return ids;
}

export interface FoldDebtEntry { id: string; text: string }
type Lane = "main" | "pr";
interface Listed { artifactId: number; workflowRunId: string; headSha: string; lane: Lane; createdAt: string }

export type FoldDebtOutcome = Pick<Listed, "artifactId" | "workflowRunId" | "lane"> & { prNumber?: number } & (
  | { kind: "accepted"; entries: FoldDebtEntry[]; refused: Array<{ name: string; reason: string }> }
  | { kind: "held" | "dropped" | "unread"; reason: string });

/** One artifact member as an entry, or why it is not one: the name the ratchet gives, and the shape
 *  `plan/feedback` holds (its own id, a timestamp, a body, and the gate's origin and status). */
export function foldDebtEntryFromMember(name: string, text: string): FoldDebtEntry | { reason: string } {
  const id = ENTRY_FILE.exec(name)?.[1];
  if (id === undefined) return { reason: "not a fold-debt-<file>-<bytes>.yaml entry" };
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return { reason: `unparseable: ${String((e as Error)?.message ?? e)}` };
  }
  const d = (doc ?? {}) as Record<string, unknown>;
  if (d.id !== id || typeof d.ts !== "string" || typeof d.raw !== "string" || d.origin !== "gate" || d.status !== "new") {
    return { reason: "not a plan/feedback entry: id, ts, raw, origin: gate and status: new are required" };
  }
  return { id, text };
}

function listed(payload: unknown, name: string, lane: Lane, ingested: ReadonlySet<string>, settled: ReadonlySet<number>): Listed[] {
  const artifacts = (payload as { artifacts?: unknown })?.artifacts;
  if (!Array.isArray(artifacts)) return [];
  const live: Listed[] = [];
  for (const a of artifacts as Array<{ id?: unknown; name?: unknown; expired?: unknown; created_at?: unknown; workflow_run?: { id?: unknown; head_sha?: unknown } }>) {
    const runId = a.workflow_run?.id;
    if (typeof a?.id !== "number" || a.name !== name || a.expired === true || typeof runId !== "number") continue;
    if (settled.has(a.id) || ingested.has(String(runId))) continue;
    live.push({ artifactId: a.id, workflowRunId: String(runId), headSha: String(a.workflow_run?.head_sha ?? ""), lane,
      createdAt: typeof a.created_at === "string" ? a.created_at : "" });
  }
  return live;
}

type Pull = { number?: unknown; state?: unknown; merged_at?: unknown; head?: { sha?: unknown } };

/** A PR-lane run's standing: its debt is main's only once the pull request merged at the head that filed it. */
export function mergeStanding(pulls: unknown, headSha: string): { kind: "accepted" | "held" | "dropped"; prNumber?: number; reason: string } {
  const list = Array.isArray(pulls) ? (pulls as Pull[]) : [];
  const merged = list.find((p) => typeof p.merged_at === "string");
  const number = (p: Pull | undefined) => (typeof p?.number === "number" ? p.number : undefined);
  if (merged) {
    const at = String(merged.head?.sha ?? "");
    return at === headSha
      ? { kind: "accepted", prNumber: number(merged), reason: `PR #${number(merged)} merged` }
      : { kind: "dropped", prNumber: number(merged), reason: `PR #${number(merged)} merged at head ${at}, not at this run's head ${headSha}` };
  }
  const open = list.find((p) => p.state === "open");
  if (open) return { kind: "held", prNumber: number(open), reason: `PR #${number(open)} is open` };
  if (list.length > 0) return { kind: "dropped", prNumber: number(list[0]), reason: `PR #${number(list[0])} closed unmerged` };
  return { kind: "held", reason: `no pull request is associated with ${headSha} yet` };
}

export interface FoldDebtPullInput {
  owner: string;
  repo: string;
  /** Workflow runs the ledger already holds a terminal row for. */
  ingested: ReadonlySet<string>;
  /** Artifact ids read and accounted for, owned by the caller so it outlives a pass. */
  settled: Set<number>;
  /** The sweep's paced JSON read. */
  readJson: (args: string[]) => unknown;
  /** The sweep's paced binary read, for the artifact zip. */
  readZip: (args: string[]) => Buffer;
  /** The checkout whose `plan/feedback` {@link landFoldDebt} writes the entries into and lands from. */
  root: string;
  log: (step: string, fields: Record<string, unknown>) => void;
  land?: (root: string) => { landed: boolean; error?: string } | Promise<{ landed: boolean; error?: string }>;
  write?: (path: string, text: string) => void;
}

/** Pull un-ingested fold-debt artifacts, main's lane first, oldest first. A failed LIST throws: the
 *  sweep logs it and ingests nothing, rather than reading it as "no debt was filed". */
export function pullFoldDebtEntries(deps: FoldDebtPullInput): FoldDebtOutcome[] {
  const pending = [
    ...listed(deps.readJson(foldDebtArtifactsRestArgs(deps.owner, deps.repo, FOLD_DEBT_MAIN_ARTIFACT)), FOLD_DEBT_MAIN_ARTIFACT, "main", deps.ingested, deps.settled),
    ...listed(deps.readJson(foldDebtArtifactsRestArgs(deps.owner, deps.repo, FOLD_DEBT_PR_ARTIFACT)), FOLD_DEBT_PR_ARTIFACT, "pr", deps.ingested, deps.settled),
  ].sort((x, y) => (x.lane !== y.lane ? (x.lane === "main" ? -1 : 1) : x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : x.artifactId - y.artifactId));
  const outcomes: FoldDebtOutcome[] = [];
  let reads = 0;
  for (const a of pending) {
    const at = { artifactId: a.artifactId, workflowRunId: a.workflowRunId, lane: a.lane };
    let prNumber: number | undefined;
    if (a.lane === "pr") {
      if (reads >= FOLD_DEBT_PULL_MAX_READS) break;
      reads += 1;
      let standing: ReturnType<typeof mergeStanding>;
      try {
        standing = mergeStanding(deps.readJson(pullsForCommitRestArgs(deps.owner, deps.repo, a.headSha)), a.headSha);
      } catch (e) {
        outcomes.push({ ...at, kind: "unread", reason: `merge lookup: ${String((e as Error)?.message ?? e)}` });
        continue;
      }
      prNumber = standing.prNumber;
      const pr = prNumber === undefined ? {} : { prNumber };
      if (standing.kind !== "accepted") {
        if (standing.kind === "dropped") deps.settled.add(a.artifactId);
        outcomes.push({ ...at, ...pr, kind: standing.kind, reason: standing.reason });
        continue;
      }
    }
    if (reads >= FOLD_DEBT_PULL_MAX_READS) break;
    reads += 1;
    let zip: Buffer;
    try {
      zip = deps.readZip(mutationVerdictArtifactZipRestArgs(deps.owner, deps.repo, a.artifactId));
    } catch (e) {
      outcomes.push({ ...at, kind: "unread", reason: `download: ${String((e as Error)?.message ?? e)}` });
      continue; // a transient read: NOT settled, so the next pass tries it again
    }
    deps.settled.add(a.artifactId);
    const entries: FoldDebtEntry[] = [];
    const refused: Array<{ name: string; reason: string }> = [];
    try {
      for (const m of zipTextMembers(zip)) {
        const e = foldDebtEntryFromMember(m.name, m.text);
        if ("reason" in e) refused.push({ name: m.name, reason: e.reason });
        else entries.push(e);
      }
    } catch (e) {
      refused.push({ name: "(artifact)", reason: `unzip: ${String((e as Error)?.message ?? e)}` });
    }
    outcomes.push({ ...at, ...(prNumber === undefined ? {} : { prNumber }), kind: "accepted", entries, refused });
  }
  return outcomes;
}

/** Write each accepted entry with exclusive create, land them once, and return the terminal rows. An
 *  entry already on disk is already filed, the idempotence `fileFoldDebt` keeps. A failed write is
 *  logged and left un-ingested, so the next pass reads that artifact again. */
export async function landFoldDebt(outcomes: readonly FoldDebtOutcome[], deps: FoldDebtPullInput): Promise<Record<string, unknown>[]> {
  const write = deps.write ?? ((path: string, text: string) => writeFileSync(path, text, { flag: "wx" }));
  const dir = join(deps.root, "plan", "feedback");
  const rows: Record<string, unknown>[] = [];
  const filed: Array<{ row: Record<string, unknown> }> = [];
  for (const o of outcomes) {
    const at = { workflow_run_id: o.workflowRunId, artifact_id: o.artifactId, lane: o.lane, ...(o.prNumber === undefined ? {} : { pr_number: o.prNumber }) };
    if (o.kind === "unread") deps.log(FOLD_DEBT_PULL_ERROR_STEP, { phase: "artifact", ...at, reason: o.reason });
    if (o.kind === "dropped") rows.push({ step: FOLD_DEBT_DROPPED_STEP, ...at, reason: o.reason });
    if (o.kind !== "accepted") continue;
    const written: string[] = [];
    const existing: string[] = [];
    try {
      if (o.entries.length > 0) mkdirSync(dir, { recursive: true });
      for (const e of o.entries) {
        try {
          write(join(dir, `${e.id}.yaml`), e.text);
          written.push(e.id);
        } catch (err) {
          if ((err as { code?: unknown })?.code !== "EEXIST") throw err;
          existing.push(e.id);
        }
      }
    } catch (err) {
      deps.settled.delete(o.artifactId);
      deps.log(FOLD_DEBT_PULL_ERROR_STEP, { phase: "write", ...at, error: String((err as Error)?.message ?? err) });
      continue;
    }
    const row = { step: FOLD_DEBT_INGESTED_STEP, ...at, entry_ids: o.entries.map((e) => e.id), written, existing, refused: o.refused };
    filed.push({ row });
    rows.push(row);
  }
  if (filed.some(({ row }) => (row.written as string[]).length > 0)) {
    let landed: { landed: boolean; error?: string };
    try {
      landed = await (deps.land ?? sweepFeedbackLandingAsync)(deps.root);
    } catch (err) {
      landed = { landed: false, error: String((err as Error)?.message ?? err) };
    }
    for (const { row } of filed) Object.assign(row, { landed: landed.landed }, landed.error === undefined ? {} : { land_error: landed.error });
  }
  return rows;
}
