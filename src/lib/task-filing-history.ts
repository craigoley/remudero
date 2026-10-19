import { parseDocument } from "yaml";
import { hostWorktreeGit, type HostWorktreeGitOptions } from "./worktree-git.js";

export interface FilingHistoryLimits {
  commitVisits: number;
  blobReads: number;
  decodedBytes: number;
  metadataBytes: number;
  stateEntries: number;
}

// PRIMARY CONTROL: one invocation, never one allowance per task. The bounded main survey at
// 0fc7b7f16581 saw 9,869 commits, 9,769 blobs / 176,168,327 bytes and 2,178,102 diff bytes;
// fd79a2f9's original-parent raw headers/messages occupy 23,545,207 bytes.
// Defaults leave finite margin; the real-Git population and exhaustion fixtures exercise them.
export const FILING_HISTORY_LIMITS: Readonly<FilingHistoryLimits> = Object.freeze({
  commitVisits: 16_384, blobReads: 16_384, decodedBytes: 256 * 1024 ** 2,
  metadataBytes: 32 * 1024 ** 2, stateEntries: 1_048_576,
});

export interface FilingHistoryOptions {
  /** A caller may reduce the allowance, never enlarge the production limits. */
  limits?: Partial<FilingHistoryLimits>;
  readGit?: typeof hostWorktreeGit;
}

type Birth = { commit: string; path: string; source: "embedded" | "shard"; committerSeconds: number };
export type TaskFilingHistory =
  | ({ state: "qualified"; revision: string; completeness: "complete" } & Birth)
  | { state: "unknown"; revision?: string; completeness: "incomplete"; reason: string };
type Commit = { oid: string; parents: string[]; seconds: number };
type Change = { path: string; old: string; next: string };
type RecordState = { count: number; seen: boolean; path?: string; birth?: Birth; reason?: string };
const EMPTY: RecordState = Object.freeze({ count: 0, seen: false });
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO = /^0+$/;
const CHUNK_BYTES = 4 * 1024 ** 2;
class HistoryUnavailable extends Error {}
function unavailable(reason: string): never { throw new HistoryUnavailable(reason); }

function historyUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return unavailable("unsupported historical plan UTF-8 encoding"); }
}

export interface TaskFilingHistoryInvocation {
  readonly root: string;
  readonly candidates: ReadonlySet<string>;
  readonly limits: Readonly<FilingHistoryLimits>;
  readonly usage: FilingHistoryLimits;
  readonly readGit: typeof hostWorktreeGit;
  revision?: string;
  results?: ReadonlyMap<string, TaskFilingHistory>;
  failure?: string;
}

/** Lazy: callers that have no age candidates do no Git work. No state survives this invocation. */
export function createTaskFilingHistoryInvocation(
  root: string, ids: readonly string[], options: FilingHistoryOptions = {},
): TaskFilingHistoryInvocation {
  const limits = { ...FILING_HISTORY_LIMITS, ...options.limits };
  const invalid = Object.keys(FILING_HISTORY_LIMITS).some(key => {
    const k = key as keyof FilingHistoryLimits;
    return !Number.isSafeInteger(limits[k]) || limits[k] < 0 || limits[k] > FILING_HISTORY_LIMITS[k];
  });
  return { root, candidates: new Set(ids), limits, readGit: options.readGit ?? hostWorktreeGit,
    usage: { commitVisits: 0, blobReads: 0, decodedBytes: 0, metadataBytes: 0, stateEntries: 0 },
    ...(invalid ? { failure: "invalid filing-history limits" } : {}) };
}

function debit(ctx: TaskFilingHistoryInvocation, resource: keyof FilingHistoryLimits, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > ctx.limits[resource] - ctx.usage[resource])
    unavailable(`filing-history ${resource} budget exhausted`);
  ctx.usage[resource] += amount;
}

function readHistory(ctx: TaskFilingHistoryInvocation, args: string[], options: HostWorktreeGitOptions = {}): string {
  return ctx.readGit(ctx.root, args, { ...options, encoding: "latin1",
    env: { GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_GRAFT_FILE: undefined,
      GIT_SHALLOW_FILE: undefined, GIT_REPLACE_REF_BASE: undefined } });
}

function metadata(ctx: TaskFilingHistoryInvocation, args: string[], input?: string): string {
  const remaining = Math.min(ctx.limits.metadataBytes - ctx.usage.metadataBytes, ctx.limits.decodedBytes - ctx.usage.decodedBytes);
  if (remaining <= 0) unavailable("filing-history decodedBytes/metadataBytes budget exhausted");
  let raw: string;
  try { raw = readHistory(ctx, args, { input, maxBuffer: remaining }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOBUFS") unavailable("filing-history decodedBytes/metadataBytes budget exhausted");
    throw error;
  }
  debit(ctx, "metadataBytes", raw.length); debit(ctx, "decodedBytes", raw.length);
  return raw;
}

function historyGraph(ctx: TaskFilingHistoryInvocation): Commit[] {
  const pin = metadata(ctx, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!OID.test(pin)) unavailable("unreadable filing-history revision");
  ctx.revision = pin;
  if (metadata(ctx, ["rev-parse", "--is-shallow-repository"]).trim() !== "false")
    unavailable("shallow or incomplete filing history");
  const raw = metadata(ctx, ["log", "--pretty=raw", "--no-patch", "--no-notes", "--no-show-signature",
    "--no-color", "--encoding=none", "--reverse", "--topo-order", `--max-count=${ctx.limits.commitVisits + 1}`, pin, "--"]);
  const commits: Commit[] = [];
  let current: Commit | undefined;
  let headers = false;
  for (const line of raw.split("\n")) {
    if (line.startsWith("commit ")) {
      debit(ctx, "commitVisits", 1);
      const oid = line.slice(7);
      if (!OID.test(oid)) unavailable("unsupported commit header");
      current = { oid, parents: [], seconds: NaN }; commits.push(current); headers = true;
    } else if (headers && current) {
      if (line === "") headers = false;
      else if (line.startsWith("parent ")) {
        const parent = line.slice(7);
        if (!OID.test(parent)) unavailable("unsupported original parent");
        current.parents.push(parent);
      } else if (line.startsWith("committer ")) {
        const timestamp = / (-?\d+) [+-]\d{4}$/.exec(line)?.[1];
        current.seconds = timestamp === undefined ? NaN : Number(timestamp);
      }
    }
  }
  const seen = new Set<string>();
  for (const commit of commits) {
    if (!Number.isSafeInteger(commit.seconds) || seen.has(commit.oid) || commit.parents.some(p => !seen.has(p)))
      unavailable("incomplete or unsupported original-parent ancestry");
    seen.add(commit.oid);
  }
  if (!seen.has(pin) || commits.at(-1)?.oid !== pin) unavailable("incomplete pinned filing history");
  return commits;
}

function recognized(path: string): boolean {
  return path === "plan/tasks.yaml" || /^plan\/tasks\.d\/[^/]+\.(?:yaml|yml)$/.test(path);
}

function historyChanges(ctx: TaskFilingHistoryInvocation, commits: Commit[]): Map<string, Change[]> {
  const input = commits.map(c => [c.oid, ...c.parents.slice(0, 1)].join(" ")).join("\n") + "\n";
  const raw = metadata(ctx, ["diff-tree", "--stdin", "-r", "--root", "--raw", "-z", "--no-renames",
    "--no-abbrev", "--always", "--no-ext-diff", "--no-textconv", "--", "plan/tasks.yaml", "plan/tasks.d/"], input);
  const result = new Map<string, Change[]>();
  const wanted = new Set(commits.map(c => c.oid));
  const parts = raw.split("\0");
  let list: Change[] | undefined;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (OID.test(part)) {
      if (!wanted.has(part) || result.has(part)) unavailable("unsupported history diff identity");
      list = []; result.set(part, list); continue;
    }
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) [AMDT]$/.exec(part);
    if (!match || !list || i + 1 >= parts.length - 1) unavailable("incomplete history diff");
    const path = historyUtf8(Buffer.from(parts[++i]!, "latin1"));
    if (!recognized(path)) continue;
    if (![match[1], match[2]].every(mode => ["000000", "100644", "100755"].includes(mode!)) ||
        ![match[3], match[4]].every(oid => OID.test(oid!))) unavailable("unsupported plan container object");
    list.push({ path, old: match[3]!, next: match[4]! });
  }
  if (parts.at(-1) !== "" || result.size !== commits.length) unavailable("incomplete history diff population");
  return result;
}

function historyBlobs(ctx: TaskFilingHistoryInvocation, changes: Map<string, Change[]>): Map<string, Map<string, number>> {
  const ids = [...new Set([...changes.values()].flatMap(rows => rows.flatMap(c => [c.old, c.next])).filter(id => !ZERO.test(id)))];
  debit(ctx, "blobReads", ids.length);
  const info = ids.length ? metadata(ctx, ["cat-file", "--batch-check"], ids.join("\n") + "\n").trimEnd().split("\n") : [];
  if (info.length !== ids.length) unavailable("incomplete plan blob census");
  const sizes = info.map((line, index) => {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(line);
    const size = Number(match?.[2]);
    if (!match || match[1] !== ids[index] || !Number.isSafeInteger(size) || size < 0)
      unavailable("missing or unsupported historical plan blob");
    if (size > CHUNK_BYTES) unavailable("filing-history decodedBytes chunk budget exhausted");
    return size;
  });
  const result = new Map<string, Map<string, number>>();
  for (let index = 0; index < ids.length;) {
    const start = index;
    let bytes = 0;
    while (index < ids.length) {
      const expected = `${ids[index]} blob ${sizes[index]}\n`.length + sizes[index]! + 1;
      if (index > start && bytes + expected > CHUNK_BYTES) break;
      bytes += expected; index++;
    }
    debit(ctx, "decodedBytes", bytes);
    const output = Buffer.from(readHistory(ctx, ["cat-file", "--batch"], {
      input: ids.slice(start, index).join("\n") + "\n", maxBuffer: bytes,
    }), "latin1");
    let offset = 0;
    for (let i = start; i < index; i++) {
      const header = `${ids[i]} blob ${sizes[i]}\n`;
      if (output.subarray(offset, offset + header.length).toString("ascii") !== header)
        unavailable("unreadable historical blob header");
      offset += header.length;
      const text = historyUtf8(output.subarray(offset, offset + sizes[i]!));
      offset += sizes[i]!;
      if (output[offset++] !== 10) unavailable("incomplete historical blob bytes");
      const doc = parseDocument(text, { uniqueKeys: true });
      if (doc.errors.length) unavailable("unsupported historical plan YAML");
      let value: unknown;
      try { value = doc.toJS({ maxAliasCount: 0 }); }
      catch { unavailable("unsupported historical plan aliases"); }
      if (!Array.isArray(value)) unavailable("unsupported historical plan container shape");
      const counts = new Map<string, number>();
      for (const record of value) {
        if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.id !== "string")
          unavailable("unsupported historical task record shape");
        if (ctx.candidates.has(record.id)) counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
      }
      result.set(ids[i]!, counts);
    }
    if (offset !== output.length) unavailable("unexpected historical blob bytes");
  }
  return result;
}

function recordStates(ctx: TaskFilingHistoryInvocation, commits: Commit[], changes: Map<string, Change[]>, blobs: Map<string, Map<string, number>>): Map<string, RecordState> {
  const states = new Map<string, Map<string, RecordState>>();
  const consumers = new Map<string, number>();
  for (const commit of commits) for (const parent of commit.parents) consumers.set(parent, (consumers.get(parent) ?? 0) + 1);
  for (const commit of commits) {
    const parents = commit.parents.map(p => states.get(p)!);
    const base = parents[0] ?? new Map<string, RecordState>();
    const deltas = new Map<string, number>();
    const paths = new Map<string, string>();
    for (const change of changes.get(commit.oid)!) {
      for (const [oid, direction] of [[change.old, -1], [change.next, 1]] as const) {
        for (const [id, count] of blobs.get(oid) ?? []) {
          deltas.set(id, (deltas.get(id) ?? 0) + direction * count);
          if (direction === 1) paths.set(id, change.path);
        }
      }
    }
    const affected = new Set(deltas.keys());
    if (parents.length > 1) for (const parent of parents) for (const id of parent.keys()) affected.add(id);
    let next = base;
    if (affected.size) {
      debit(ctx, "stateEntries", base.size + affected.size);
      next = new Map(base);
      for (const id of affected) {
        const prior = parents.map(p => p.get(id) ?? EMPTY);
        const first = base.get(id) ?? EMPTY;
        const count = first.count + (deltas.get(id) ?? 0);
        if (count < 0) unavailable("inconsistent historical record states");
        const path = paths.get(id) ?? first.path;
        const births = new Map(prior.filter(p => p.birth).map(p => [p.birth!.commit, p.birth!]));
        let reason = prior.find(p => p.reason)?.reason;
        let birth = births.size === 1 ? births.values().next().value : undefined;
        const seen = count > 0 || prior.some(p => p.seen);
        if (count > 1) reason = "duplicate task identity in filing history";
        else if (births.size > 1) reason = "incomparable task introductions in filing history";
        else if (count === 1 && !prior.some(p => p.count === 1)) {
          if (prior.some(p => p.seen)) reason = "ambiguous task deletion/reintroduction in filing history";
          else if (!path) unavailable("missing task introduction path");
          else birth = { commit: commit.oid, path, source: path === "plan/tasks.yaml" ? "embedded" : "shard", committerSeconds: commit.seconds };
        }
        next.set(id, { count, seen, path, birth, reason });
      }
    }
    states.set(commit.oid, next);
    for (const parent of commit.parents) {
      const left = consumers.get(parent)! - 1; consumers.set(parent, left);
      if (left === 0) states.delete(parent);
    }
  }
  return states.get(ctx.revision!)!;
}

/** A result is qualified only after the complete bounded corpus has been read and checked. */
export function resolveTaskFilingHistory(id: string, ctx: TaskFilingHistoryInvocation): TaskFilingHistory {
  if (!ctx.candidates.has(id)) return { state: "unknown", completeness: "incomplete", reason: "task absent from this history invocation" };
  if (!ctx.results && !ctx.failure) {
    try {
      const commits = historyGraph(ctx);
      const changes = historyChanges(ctx, commits);
      const states = recordStates(ctx, commits, changes, historyBlobs(ctx, changes));
      ctx.results = new Map([...ctx.candidates].map(candidate => {
        const state = states.get(candidate);
        const result: TaskFilingHistory = state?.count === 1 && state.birth && !state.reason
          ? { state: "qualified", revision: ctx.revision!, completeness: "complete", ...state.birth }
          : { state: "unknown", revision: ctx.revision, completeness: "incomplete",
            reason: state?.reason ?? "exact task record absent at the pinned revision" };
        return [candidate, result];
      }));
    } catch (error) {
      ctx.failure = error instanceof HistoryUnavailable ? error.message
        : "git log failed: repository or complete history objects could not be read";
    }
  }
  return ctx.results?.get(id) ?? { state: "unknown", revision: ctx.revision, completeness: "incomplete", reason: ctx.failure! };
}
