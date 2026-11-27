import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { resolveRepoLayout } from "./repo-layout.js";
import { opsCatalogBoundRefusal, type OpsCatalogBoundsIo } from "./ops-catalog-source.js";
import { parse as parseYaml } from "yaml";
import { defaultGitRunnerAsync, readBlobsAtRefAsync, type Plan, type Task } from "./plan.js";
import { createPlanRevisionStore } from "./plan-revision-store.js";
import { dispatchOrder } from "./drain.js";
import { taskIdFromRunBranch, creditsByAnchoredTrailer } from "./status.js";
import { classifyGhLimitFailure, defaultGhRetryAfterSeconds, DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS, ghJsonAsync, ghTextAsync } from "./github-transport.js";
import { RmdError } from "./errors.js";

type Json = Record<string, unknown>;
export type MigrationOptions = { publicRoot: string; publicCommit: string; publicRepo: string; opsRoot: string; opsCommit: string; opsRepo: string };
type Options = MigrationOptions;
export type CatalogOriginal = { path: string; text: string; blob: string; single: boolean; shard: boolean };
type Original = CatalogOriginal;
/** One GraphQL read: the CLI's own GitHub read, or a caller's pinned reader (W1-T13680). */
export type MigrationGraphqlReader = (query: string) => Promise<unknown>;
/**
 * W1-T14714: a rate-limited read waits and is made again, for as long as GitHub keeps refusing on rate: the wait is the
 * refusal's retry-after when it names one, else the transport's refusal floor doubled per refusal. Any other failure throws.
 */
export function withRateLimitBackoff(read: MigrationGraphqlReader, sleep: (ms: number) => Promise<void> = ms => new Promise(done => setTimeout(done, ms))): MigrationGraphqlReader {
  return async query => {
    for (let attempt = 0; ; attempt++) {
      try { return await read(query); }
      catch (error) {
        if (classifyGhLimitFailure(error) === undefined) throw error;
        const after = defaultGhRetryAfterSeconds(error);
        await sleep(after !== undefined ? after * 1000 : DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS * 2 ** attempt);
      }
    }
  };
}
const graphqlRead: MigrationGraphqlReader = withRateLimitBackoff(query => ghJsonAsync(["api", "graphql", "-f", `query=${query}`], undefined, undefined, { fresh: true }));
/** The page GitHub serves of a connection; the open-PR read follows every next page of the list and of each PR's files. */
const GRAPHQL_PAGE = 100;
/**
 * W1-T14714 (operator ruling 2026-11-24, "remove all three caps"): no count holds a batch. A batch ends only where the
 * caller's fits() says its copy or remove pull request would pass GitHub's own body limit, or where the catalog's room
 * (judgeOpsBatch) ends it.
 */
export type BatchFits = (batch: ReadonlyArray<{ id: string; path: string; blob: string }>) => boolean;
/** W1-T14345 (operator ruling 2026-11-22): an open record is queued or blocked; merged and done records stay as history. */
const OPEN_STATUSES: ReadonlySet<string> = new Set(["queued", "blocked"]);
// The measured public corpus is 34,444,886 bytes. Leave 16 MiB for framing below the shared 64 MiB Git buffer.
const MAX_CATALOG_BYTES = 48 * 1024 * 1024;
export class PreviewUnknown extends RmdError {
  constructor(readonly reason: string) { super("plan", 1, reason); }
}
export const unknown = (reason: string): never => { throw new PreviewUnknown(reason); };
const object = (x: unknown): Json => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Json : unknown("incomplete_evidence");
const sha = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{40}$/.test(x);
const repository = (x: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x);
export function migrationOptions(args: readonly string[]): Options | undefined {
  const names = ["public-root", "public-commit", "public-repo", "ops-root", "ops-commit", "ops-repo"];
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, ""), value = args[i + 1];
    if (!key || !names.includes(key) || values.has(key) || !value || value.startsWith("--")) return undefined;
    values.set(key, value);
  }
  if (values.size !== names.length) return undefined;
  const o = Object.fromEntries(names.map((key) => [key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), values.get(key)!])) as Options;
  return sha(o.publicCommit) && sha(o.opsCommit) && repository(o.publicRepo) && repository(o.opsRepo) && o.publicRepo !== o.opsRepo && o.publicRepo.split("/")[1] === "remudero" ? o : undefined;
}
/** W1-T14368: what an ops copy is judged on: the read catalog's sizes, as the API reader counts them. */
export interface OpsCatalogSize { shards: number; bytes: number; treeEntries: number; shardDir: boolean }
/** W1-T14447: the catalog's own paths at its commit: its monolith and its shard directory (with a trailing slash). */
export interface CatalogPaths { monolith: string; shardDir: string }
export async function catalog(root: string, commit: string, external = false):
  Promise<{ plan: Plan; originals: Map<string, Original>; paths: CatalogPaths; size?: OpsCatalogSize }> {
  const git = defaultGitRunnerAsync(root);
  if ((await git(["rev-parse", `${commit}^{commit}`])).trim() !== commit) return unknown("catalog_unreadable");
  const within = (path: string): string => {
    const value = relative(root, path).split(sep).join("/");
    return !value || value === ".." || value.startsWith("../") || /[\r\n\0\\]/.test(value) ? unknown("catalog_unreadable") : value;
  };
  // Resolve the maintained override path, then supply only its bytes at the selected commit.
  // A live working-tree override cannot redirect this pinned catalog read.
  const overridePaths: string[] = [];
  const defaults = resolveRepoLayout(root, path => { overridePaths.push(within(path)); return undefined; });
  if (overridePaths.length !== 1) return unknown("catalog_unreadable");
  const overridePath = overridePaths[0]!;
  const metadata = (await git(["ls-tree", "-z", commit, "--", overridePath])).split("\0").filter(Boolean);
  let override: string | undefined;
  if (metadata.length) {
    const match = /^100644 blob ([a-f0-9]{40})\t([^\r\n]+)$/.exec(metadata[0]!);
    if (metadata.length !== 1 || !match || match[2] !== overridePath) return unknown("catalog_unreadable");
    override = (await readBlobsAtRefAsync(git, commit, [overridePath]))[0]!;
    const buffer = Buffer.from(override);
    if (buffer.length > MAX_CATALOG_BYTES || createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex") !== match[1]) return unknown("catalog_unreadable");
  }
  const layout = resolveRepoLayout(root, () => override);
  // The production private reader still requires its canonical house plan paths.
  if (external && (layout.planMonolith !== defaults.planMonolith || layout.planDir !== defaults.planDir)) return unknown("catalog_incompatible");
  const monolith = within(layout.planMonolith), shardDir = within(join(layout.planDir, "tasks.d")) + "/";
  const entries = (await git(["ls-tree", "-rlz", commit, "--", monolith, shardDir])).split("\0").filter(Boolean);
  let declaredBytes = 0;
  const files = entries.map(line => {
    const m = /^100644 blob ([a-f0-9]{40}) +([0-9]+)\t([^\r\n]+)$/.exec(line);
    if (!m) return unknown("catalog_unreadable");
    const size = Number(m[2]), path = m[3]!;
    declaredBytes += size;
    // Refuse known oversized inputs before materializing their payloads. No per-blob limit applies: the catalog's
    // own size is judged on the copy by the reader's derived bounds (W1-T14368, W1-T14638).
    if (!Number.isSafeInteger(size) || declaredBytes > MAX_CATALOG_BYTES) return unknown("catalog_unreadable");
    const shard = path.startsWith(shardDir) && !path.slice(shardDir.length).includes("/") && /\.ya?ml$/.test(path);
    return path === monolith || shard ? { path, blob: m[1]!, size, shard } : unknown("catalog_unreadable");
  });
  if (!files.some(f => f.path === monolith)) return unknown("catalog_unreadable");
  let size: OpsCatalogSize | undefined;
  if (external) {
    // The API reader counts each visited immediate tree, including entries outside the selected
    // blobs. Mirror those same three populations without fetching or interpreting unrelated files.
    const hasShards = files.some(file => file.shard);
    const trees = [commit, `${commit}:${within(layout.planDir)}`];
    if (hasShards) trees.push(`${commit}:${shardDir.slice(0, -1)}`);
    let treeEntries = 0;
    for (const tree of trees) {
      treeEntries += (await git(["ls-tree", "-z", tree])).split("\0").filter(Boolean).length;
    }
    size = { shards: files.filter(file => file.shard).length, bytes: declaredBytes, treeEntries, shardDir: hasShards };
  }
  const texts = await readBlobsAtRefAsync(git, commit, files.map(f => f.path));
  let bytes = 0;
  const blobs = files.map((file, i) => {
    const text = texts[i]!, buffer = Buffer.from(text); bytes += buffer.length;
    if (buffer.length !== file.size || bytes > MAX_CATALOG_BYTES || createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex") !== file.blob) return unknown("catalog_unreadable");
    return { label: file.path, text };
  });
  const store = createPlanRevisionStore({ strict: true, yamlLogLevel: "silent", ...(external ? { dependencyMode: "preserve-external" as const } : {}) });
  const plan = store.adopt({ key: commit, commit, repoDir: root, relPath: monolith }, blobs).plan;
  // The strict reader already parsed every task and bound its sourcePath. Reuse that provenance,
  // rather than parsing the whole catalog three times just to recover the same per-file identity.
  const byPath = new Map(files.map((file, i) => [file.path, { ...file, text: texts[i]! }]));
  const counts = new Map<string, number>();
  for (const task of plan.tasks) counts.set(task.sourcePath!, (counts.get(task.sourcePath!) ?? 0) + 1);
  const originals = new Map<string, Original>(plan.tasks.map(task => [task.id,
    { ...byPath.get(task.sourcePath!)!, single: counts.get(task.sourcePath!) === 1 }]));
  return { plan, originals, paths: { monolith, shardDir }, ...(size ? { size } : {}) };
}

/**
 * W1-T14368: the ops catalog a copy would produce, judged on the API reader's own bounds: the read catalog plus one
 * shard of the copy's bytes (the original and its one moved_from line). A copy the reader would refuse is refused
 * here, before it lands and stops ops dispatch.
 */
export function judgeOpsCopy(size: OpsCatalogSize, original: string, publicCommit: string, io: OpsCatalogBoundsIo = {}): void {
  judgeOpsBatch(size, [original], publicCommit, io);
}

/**
 * W1-T14345: the same judgement for the catalog one batched COPY would produce: every copy's bytes and shard at once.
 * The catalog's growth is not bounded, so a step may carry any number of copies the reader's other bounds admit.
 */
export function judgeOpsBatch(size: OpsCatalogSize, originals: readonly string[], publicCommit: string, io: OpsCatalogBoundsIo = {}): void {
  let bytes = 0;
  for (const original of originals) {
    const indent = /\n([ \t]+)\S/.exec(original)?.[1] ?? "";
    const copyBytes = Buffer.byteLength(original) + Buffer.byteLength(`${indent}moved_from: remudero@${publicCommit}\n`);
    bytes += copyBytes;
  }
  const produced = { shards: size.shards + originals.length, bytes: size.bytes + bytes };
  if (opsCatalogBoundRefusal(produced, io)) return unknown("catalog_incompatible");
}
/** remudero-ops scripts/ops-gate.rb REQUIRED_KEYS without "id", NON_EMPTY_KEYS, RISKS, PROOF_PREFIXES and DEMONSTRATION_RE. */
const OPS_GATE_REQUIRED_KEYS = ["title", "repo", "type", "verify", "risk", "status", "attempts", "acceptance"] as const;
const OPS_GATE_NON_EMPTY_KEYS = ["title", "repo", "type", "verify", "status", "attempts"] as const;
const OPS_GATE_RISKS: readonly unknown[] = ["low", "medium", "high"];
const OPS_GATE_PROOF_PREFIXES = ["unit test:", "grep:"] as const;
const OPS_GATE_DEMONSTRATION = /^demonstration:[ \t\r\n\f\v]*[^ \t\r\n\f\v]/i;
// Ruby's String#strip set, so a value of other Unicode spaces is not blank, as the gate reads it.
const rubyStrip = (value: string): string => value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/g, "");
const rubyHash = (value: unknown): value is Json => Object.prototype.toString.call(value) === "[object Object]";
const filled = (value: unknown): value is string => typeof value === "string" && rubyStrip(value) !== "";
/**
 * W1-T14424: every problem remudero-ops scripts/ops-gate.rb OpsGate.rule_problems finds in one parsed task, as its own
 * text. The gate checks a moved live record against every rule and refuses the whole copy pull request for one problem,
 * so the mover leaves such a record out. It mirrors the Ruby line by line; a change to the gate is a visible drift:
 *   rule_problems:     each REQUIRED_KEYS key but id is present; each NON_EMPTY_KEYS key present is not blank?;
 *                      check_depends_on; a present priority is Numeric; a present risk is one of RISKS; check_acceptance.
 *   blank?:            nil, an empty String/Array/Hash, or a String that strips to "".
 *   check_depends_on:  a present depends_on is an Array, and every item is a String.
 *   check_acceptance:  a present acceptance is a non-empty Array; each item is a Hash with a String claim that strips
 *                      non-empty; a present satisfied_by must be non-empty text and stands in place of the proof;
 *                      otherwise the proof is non-empty text, a stripped proof matching DEMONSTRATION_RE needs
 *                      verify: human, and any other proof starts (unstripped) with one of PROOF_PREFIXES.
 */
export function opsGateShapeProblems(task: Json): string[] {
  const problems: string[] = [];
  const has = (key: string) => Object.hasOwn(task, key);
  for (const key of OPS_GATE_REQUIRED_KEYS) if (!has(key)) problems.push(`is missing the required key '${key}'`);
  for (const key of OPS_GATE_NON_EMPTY_KEYS) {
    const value = task[key];
    if (has(key) && (value === null || value === undefined || (typeof value === "string" && rubyStrip(value) === "") ||
      (Array.isArray(value) && value.length === 0) || (rubyHash(value) && Object.keys(value).length === 0))) problems.push(`'${key}' is empty`);
  }
  if (has("depends_on")) {
    const deps = task.depends_on;
    if (!Array.isArray(deps)) problems.push("'depends_on' is not a list");
    else if (!deps.every(dep => typeof dep === "string")) problems.push("'depends_on' holds an item that is not a task id");
  }
  if (has("priority") && !(typeof task.priority === "number" || typeof task.priority === "bigint")) problems.push("'priority' is not a number");
  if (has("risk") && !OPS_GATE_RISKS.includes(task.risk)) problems.push("'risk' is not low, medium or high");
  if (!has("acceptance")) return problems;
  const items = task.acceptance;
  if (!Array.isArray(items) || items.length === 0) return [...problems, "'acceptance' is not a non-empty list"];
  items.forEach((item: unknown, index) => {
    const n = index + 1;
    if (!rubyHash(item)) { problems.push(`acceptance item ${n} is not a map`); return; }
    if (!filled(item.claim)) problems.push(`acceptance item ${n} has no 'claim'`);
    if (Object.hasOwn(item, "satisfied_by")) {
      if (!filled(item.satisfied_by)) problems.push(`acceptance item ${n} has a 'satisfied_by' that is not text`);
      return;
    }
    const proof = item.proof;
    if (!filled(proof)) problems.push(`acceptance item ${n} has no 'proof'`);
    else if (OPS_GATE_DEMONSTRATION.test(rubyStrip(proof))) {
      if (task.verify !== "human") problems.push(`acceptance item ${n} has a 'demonstration:' proof on a task that is not 'verify: human'`);
    } else if (!OPS_GATE_PROOF_PREFIXES.some(prefix => proof.startsWith(prefix))) {
      problems.push(`acceptance item ${n} has a 'proof' that does not start with 'unit test:' or 'grep:'`);
    }
  });
  return problems;
}
/** W1-T14424: a single-task record's ops-gate problems, read as the gate's YAML 1.1 reader reads its bytes. */
/** W1-T14858: remudero-ops scripts/ops-gate.rb HISTORY_STATUSES — the statuses it judges as moved history. */
export const OPS_GATE_HISTORY_STATUSES: ReadonlySet<string> = new Set(["merged", "done", "retired", "superseded", "closed", "dropped"]);
function opsGateShapeRefused(original: Original): boolean {
  const raw: unknown = parseYaml(original.text, { version: "1.1", logLevel: "silent" });
  return !Array.isArray(raw) || raw.length !== 1 || !rubyHash(raw[0]) || opsGateShapeProblems(raw[0]).length > 0;
}
function alreadyMoved(original: Original): boolean {
  // Only otherwise eligible candidates need this raw metadata; strict parsing already validated all bytes.
  const raw: unknown = parseYaml(original.text, { logLevel: "silent" });
  return Array.isArray(raw) && raw.some(entry => entry !== null && typeof entry === "object" && Object.hasOwn(entry, "moved_from"));
}
export async function refs(root: string, selectedRepository: string): Promise<Map<string, string>> {
  // The selected API identity and ownership namespace must name the same repository.
  // A local origin may point to a same-commit fork with no active dispatch claims.
  const text = await defaultGitRunnerAsync(root)(["ls-remote", `https://github.com/${selectedRepository}.git`]);
  const map = new Map<string, string>();
  for (const line of text.trim().split("\n")) {
    const m = /^([a-f0-9]{40})\s+(HEAD|refs\/[^\s]+)$/.exec(line);
    if (!m || map.has(m[2]!)) return unknown("ownership_unreadable");
    map.set(m[2]!, m[1]!);
  }
  if (!map.has("HEAD")) return unknown("ownership_unreadable");
  return map;
}
const prFields = "number state headRefName body mergeCommit{oid}";
/** W1-T13680: the receipt line a mover's ops copy pull request carries; a closed unmerged one is a refused move. */
export const MOVE_COPY_RECEIPT = "Remudero-Move-Copy:";
const moverFields = "number state headRefName body repository{databaseId nameWithOwner}";
const FILES_PAGE = "totalCount pageInfo{hasNextPage endCursor} nodes{path}";
const OPEN_ORDER = "states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}";
const OPEN_PAGE = `totalCount pageInfo{hasNextPage endCursor} nodes{number state headRefName headRefOid body files(first:${GRAPHQL_PAGE}){${FILES_PAGE}}}`;
function query(o: Options, taskId?: string, control?: Json, movers = false): string {
  const [owner, name] = o.publicRepo.split("/"), [opsOwner, opsName] = o.opsRepo.split("/");
  const pin = "databaseId nameWithOwner defaultBranchRef{name target{oid}}";
  const open = `open:pullRequests(${OPEN_ORDER},first:${GRAPHQL_PAGE}){${OPEN_PAGE}}`;
  const merged = `merged:pullRequests(states:MERGED,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){totalCount pageInfo{hasNextPage endCursor} nodes{${prFields}}}`;
  const search = (alias: string, term: string) => `${alias}:search(query:${JSON.stringify(`repo:${o.publicRepo} is:pr is:merged ${term}`)},type:ISSUE,first:100){issueCount pageInfo{hasNextPage} nodes{... on PullRequest{${prFields} repository{databaseId nameWithOwner}}}}`;
  const moves = (alias: string, repo: string, term: string) => `${alias}:search(query:${JSON.stringify(`repo:${repo} is:pr ${term}`)},type:ISSUE,first:100){issueCount pageInfo{hasNextPage} nodes{... on PullRequest{${moverFields}}}}`;
  const searches = (taskId && control ? search("byTrailer", `"Remudero-Task: ${taskId}" in:body`) + search("byBranch", `head:run-${taskId}-`) +
    // W1-T14345: a batched copy's branch names no task, so a refused copy is found by its receipt line for this id.
    search("control", `head:${control.headRefName}`) + moves("refusedMoves", o.opsRepo, `is:closed head:plan-move- "${MOVE_COPY_RECEIPT} ${taskId}" in:body`) : "") +
    (movers ? moves("publicMoves", o.publicRepo, "is:open head:plan-move-") + moves("opsMoves", o.opsRepo, "is:open head:plan-move-") : "");
  return `query MigrationPreview{public:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${pin} ${open} ${merged}} ops:repository(owner:${JSON.stringify(opsOwner)},name:${JSON.stringify(opsName)}){${pin}} ${searches}}`;
}
/** W1-T14447: the repository's identity and default branch, and every live head (the API's default-branch oid, the
 *  listed branch and HEAD) that is not the pinned commit. A live head is not refused here: {@link liveHeadJudge}
 *  admits it only when it descends from the pin by commits that touch no carried task. */
function pin(repo: Json, expected: string, commit: string, remote: Map<string, string>): { id: number; branch: string; live: string[] } {
  if (repo.nameWithOwner !== expected || !Number.isSafeInteger(repo.databaseId) || Number(repo.databaseId) <= 0) return unknown("repository_identity");
  const branch = object(repo.defaultBranchRef), target = object(branch.target);
  if (typeof branch.name !== "string") return unknown("ref_moved");
  const heads = [target.oid, remote.get(`refs/heads/${branch.name}`), remote.get("HEAD")];
  if (!heads.every(sha)) return unknown("ref_moved");
  return { id: Number(repo.databaseId), branch: branch.name, live: [...new Set(heads)].filter(head => head !== commit) };
}
function page(value: unknown): { nodes: Json[]; total: number; next: boolean; cursor: string | null } {
  const p = object(value), info = object(p.pageInfo);
  if (!Array.isArray(p.nodes) || !Number.isSafeInteger(p.totalCount) || Number(p.totalCount) < p.nodes.length || typeof info.hasNextPage !== "boolean" || !(info.endCursor === null || typeof info.endCursor === "string" || info.endCursor === undefined)) return unknown("incomplete_evidence");
  return { nodes: p.nodes.map(object), total: Number(p.totalCount), next: info.hasNextPage, cursor: typeof info.endCursor === "string" ? info.endCursor : null };
}
/**
 * W1-T14714: the whole open-PR read. The first page rides the preview query; every next page of the open list, and of
 * each open pull request's files, is read by cursor until GitHub says there is none. What comes back is one page with no
 * next, so {@link openSnapshot} judges it exactly as before. A read that answers with errors, or with no next cursor
 * while saying there is a next page, is UNKNOWN.
 */
async function wholeOpen(o: Options, first: unknown, read: MigrationGraphqlReader): Promise<Json> {
  const [owner, name] = o.publicRepo.split("/");
  const repo = (inner: string) => `query MigrationOpenPage{public:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${inner}}}`;
  const ask = async (inner: string): Promise<Json> => {
    const raw = object(await read(repo(inner)));
    if (raw.errors !== undefined) return unknown("api_unreadable");
    return object(object(raw.data).public);
  };
  const after = (cursor: unknown) => typeof cursor === "string" ? cursor : unknown("incomplete_open_prs");
  const rows = (connection: Json): unknown[] => Array.isArray(connection.nodes) ? connection.nodes : unknown("incomplete_open_prs");
  let list = object(first);
  const nodes: Json[] = rows(list).map(object);
  while (object(list.pageInfo).hasNextPage === true) {
    list = object((await ask(`open:pullRequests(${OPEN_ORDER},first:${GRAPHQL_PAGE},after:${JSON.stringify(after(object(list.pageInfo).endCursor))}){${OPEN_PAGE}}`)).open);
    nodes.push(...rows(list).map(object));
  }
  for (const pr of nodes) {
    let files = object(pr.files);
    const paths: unknown[] = [...rows(files)];
    while (object(files.pageInfo).hasNextPage === true) {
      const next = await ask(`pullRequest(number:${Number(pr.number)}){files(first:${GRAPHQL_PAGE},after:${JSON.stringify(after(object(files.pageInfo).endCursor))}){${FILES_PAGE}}}`);
      files = object(object(next.pullRequest).files);
      paths.push(...rows(files));
    }
    pr.files = { totalCount: object(pr.files).totalCount, pageInfo: { hasNextPage: false, endCursor: null }, nodes: paths };
  }
  return { totalCount: object(first).totalCount, pageInfo: { hasNextPage: false, endCursor: null }, nodes };
}
function openSnapshot(value: unknown): Json[] {
  const p = page(value);
  if (p.next || p.nodes.length !== p.total) return unknown("incomplete_open_prs");
  for (const pr of p.nodes) {
    if (!Number.isSafeInteger(pr.number) || pr.state !== "OPEN" || typeof pr.headRefName !== "string" || !sha(pr.headRefOid) || typeof pr.body !== "string") return unknown("incomplete_open_prs");
    const files = page(pr.files);
    if (files.next || files.total !== files.nodes.length || files.nodes.some(f => typeof f.path !== "string")) return unknown("incomplete_open_prs");
  }
  return p.nodes;
}
function credited(pr: Json): string[] {
  if (!Number.isSafeInteger(pr.number) || pr.state !== "MERGED" || !sha(object(pr.mergeCommit).oid) || typeof pr.headRefName !== "string" || typeof pr.body !== "string") return unknown("incomplete_merge_credit");
  const branch = taskIdFromRunBranch(pr.headRefName);
  return [...new Set([...(branch ? [branch] : []), ...Array.from(pr.body.matchAll(/^Remudero-Task: (W[0-9]+-T[0-9]+)\r?$/gm), m => m[1]!)])]
    .filter(id => branch === id || creditsByAnchoredTrailer("MERGED", pr.headRefName as string, pr.body as string, id));
}
/** Whether `id` is owned: a dispatch claim or run branch names it, or an open pull request names it by its run branch or
 *  `Remudero-Task:` trailer, or edits one of `paths` (the record's own shard). An open pull request that only edits the
 *  code a record's `files:` lists does not own it (operator ruling 2026-11-26, decision card
 *  cmsg_01KfHU5QoLahDBtwgXxjyKDYNxapcGM6jACdh7UcsY2Z61): credit follows the trailer or run branch, and hot files always
 *  carry some open pull request, so that overlap pinned records on core for good. */
export function taskOwned(id: string, paths: readonly string[], remote: Map<string, string>, open: Json[]): boolean {
  if (remote.has(`refs/rmd-dispatch/${id}`) || [...remote.keys()].some(ref => ref.startsWith("refs/heads/") && taskIdFromRunBranch(ref.slice(11)) === id)) return true;
  return open.some(pr => taskIdFromRunBranch(String(pr.headRefName)) === id || String(pr.body).split(/\r?\n/).includes(`Remudero-Task: ${id}`) || page(pr.files).nodes.some(file => paths.includes(String(file.path))));
}

export interface PreviewState {
  repositoryId: number; opsId: number; publicBranch: string; opsBranch: string; open: Json[]; recent: Json[]; mergedTotal: number;
  /** W1-T14447: each side's live heads that are not its pinned commit; empty while the main still sits at the pin. */
  publicLive: string[]; opsLive: string[];
  trailer?: Json[]; branch?: Json[]; control?: Json[]; refusedMoves?: Json[]; publicMoves?: Json[]; opsMoves?: Json[];
}
/** A mover pull request search: complete, in the named repository, on a plan-move- branch, never merged-credit evidence. */
function moverRows(raw: unknown, repositoryId: number, name: string, states: readonly string[]): Json[] {
  const value = object(raw), info = object(value.pageInfo);
  if (!Array.isArray(value.nodes) || value.nodes.length > 100 || value.issueCount !== value.nodes.length || info.hasNextPage !== false) return unknown("incomplete_move_evidence");
  const rows = value.nodes.map(object);
  for (const row of rows) {
    const repo = object(row.repository);
    if (!Number.isSafeInteger(row.number) || !states.includes(String(row.state)) || typeof row.headRefName !== "string" || !row.headRefName.startsWith("plan-move-") ||
      typeof row.body !== "string" || repo.databaseId !== repositoryId || repo.nameWithOwner !== name) return unknown("incomplete_move_evidence");
  }
  return rows;
}
function searchRows(raw: unknown, repositoryId: number, name: string): Json[] {
  const value = object(raw), info = object(value.pageInfo);
  if (!Array.isArray(value.nodes) || value.nodes.length > 100 || value.issueCount !== value.nodes.length || info.hasNextPage !== false) return unknown("incomplete_merge_credit");
  const rows = value.nodes.map(object), numbers = new Set<number>();
  for (const row of rows) {
    credited(row);
    const repo = object(row.repository);
    if (repo.databaseId !== repositoryId || repo.nameWithOwner !== name || numbers.has(Number(row.number))) return unknown("incomplete_merge_credit");
    numbers.add(Number(row.number));
  }
  return rows;
}
export interface ReadStateOptions { id?: string; control?: Json; reader?: MigrationGraphqlReader; movers?: boolean }
export async function readState(o: Options, primaryRefs: Map<string, string>, privateRefs: Map<string, string>, read: ReadStateOptions = {}): Promise<PreviewState> {
  const { id, control, movers = false } = read;
  const raw = object(await (read.reader ?? graphqlRead)(query(o, id, control, movers)));
  if (raw.errors !== undefined) return unknown("api_unreadable");
  const data = object(raw.data), primary = object(data.public), secondary = object(data.ops);
  const publicPin = pin(primary, o.publicRepo, o.publicCommit, primaryRefs), opsPin = pin(secondary, o.opsRepo, o.opsCommit, privateRefs);
  const repositoryId = publicPin.id, opsId = opsPin.id;
  if (repositoryId === opsId) return unknown("repository_identity");
  const recent = page(primary.merged);
  if (recent.nodes.length !== Math.min(recent.total, 100) || recent.next !== (recent.total > recent.nodes.length)) return unknown("incomplete_merge_credit");
  const numbers = new Set<number>();
  for (const pr of recent.nodes) { credited(pr); if (numbers.has(Number(pr.number))) return unknown("incomplete_merge_credit"); numbers.add(Number(pr.number)); }
  return { repositoryId, opsId, publicBranch: publicPin.branch, opsBranch: opsPin.branch, publicLive: publicPin.live, opsLive: opsPin.live,
    open: openSnapshot(await wholeOpen(o, primary.open, read.reader ?? graphqlRead)), recent: recent.nodes, mergedTotal: recent.total,
    ...(id && control ? { trailer: searchRows(data.byTrailer, repositoryId, o.publicRepo), branch: searchRows(data.byBranch, repositoryId, o.publicRepo), control: searchRows(data.control, repositoryId, o.publicRepo),
      refusedMoves: moverRows(data.refusedMoves, opsId, o.opsRepo, ["CLOSED", "MERGED"]) } : {}),
    ...(movers ? { publicMoves: moverRows(data.publicMoves, repositoryId, o.publicRepo, ["OPEN"]), opsMoves: moverRows(data.opsMoves, opsId, o.opsRepo, ["OPEN"]) } : {}) };
}
/** W1-T14447: a task a move step carries: its id, its record path (the same path on both sides), and every path
 *  taskOwned reads as its own: its record path alone (the operator's 2026-11-26 ruling: a pull request that only
 *  edits a record's `files:` does not own it; one naming its task or editing its record does). */
export interface CarriedTask { id: string; path: string; files: readonly string[] }
const NO_REFS: Map<string, string> = new Map();
/**
 * W1-T14447: the re-read refuses ownership_changed only for a change that touches a carried task: another repository,
 * an open pull request owning a carried task by taskOwned's rules (its record path, its run branch, its
 * trailer), or a merged pull request crediting one. Every open and merged pull request of `after` is judged, not only
 * the new or changed ones: the selection already refused any task owned in `before.open` or credited in
 * `before.recent`, so a hit here is a change, and judging the whole read cannot miss one. A merged pull request that
 * is new or changed since `before` is also refused when it merely names a carried task the way taskOwned reads an open
 * one (its run branch or a `Remudero-Task:` line), even where the anchored credit rule would not count it: a revised
 * merged body is a change to that task's evidence. Pushes, merges and order changes that touch no carried task pass.
 */
function stable(before: PreviewState, after: PreviewState, carried: readonly CarriedTask[]): void {
  if (before.repositoryId !== after.repositoryId || before.opsId !== after.opsId) return unknown("ownership_changed");
  const ids = new Set(carried.map(task => task.id));
  if (carried.some(task => taskOwned(task.id, task.files, NO_REFS, after.open)) || after.recent.some(pr => credited(pr).some(id => ids.has(id)))) return unknown("ownership_changed");
  const prior = new Map(before.recent.map(pr => [pr.number, JSON.stringify(pr)]));
  const named = (pr: Json) => carried.some(task => taskIdFromRunBranch(String(pr.headRefName)) === task.id || String(pr.body).split(/\r?\n/).includes(`Remudero-Task: ${task.id}`));
  if (after.recent.some(pr => prior.get(pr.number) !== JSON.stringify(pr) && named(pr))) return unknown("ownership_changed");
}

/** A git command's exit status: 0 on success, the process's own status otherwise (-1 when it never ran). */
const exitOf = (git: ReturnType<typeof defaultGitRunnerAsync>, args: string[]): Promise<number> =>
  git(args).then(() => 0, (error: { code?: unknown }) => typeof error.code === "number" ? error.code : -1);
/** The change from a pinned commit to one live head: every path it touches, and its catalog patch. */
interface LiveRange { changed: ReadonlySet<string>; patch: string }
async function liveRange(root: string, repository: string, pinned: string, live: string, paths: CatalogPaths): Promise<LiveRange> {
  const git = defaultGitRunnerAsync(root);
  // The live head is read as the janitor reads one: fetch its objects when absent, and write no ref.
  if (await exitOf(git, ["cat-file", "-e", `${live}^{commit}`]) !== 0) {
    await exitOf(git, ["fetch", "--quiet", "--no-write-fetch-head", `https://github.com/${repository}.git`, "HEAD"]);
    if (await exitOf(git, ["cat-file", "-e", `${live}^{commit}`]) !== 0) return unknown("ref_moved");
  }
  if (await exitOf(git, ["merge-base", "--is-ancestor", pinned, live]) !== 0) return unknown("ref_moved");
  // No rename detection: a record moved away from its path names that path, not only its new one.
  const changed = new Set((await git(["diff", "--no-renames", "--name-only", "-z", pinned, live, "--"])).split("\0").filter(Boolean));
  const patch = await git(["diff", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", pinned, live, "--", paths.monolith, paths.shardDir]);
  return { changed, patch };
}
/** An id named as a whole word: W1-T1 is not named by W1-T10, and is named by run-W1-T1-5 or `depends_on: [W1-T1]`. */
const namesTask = (text: string, id: string): boolean => {
  const literal = id.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${literal}(?![A-Za-z0-9])`, "m").test(text);
};
export type LiveHeadJudge = (state: PreviewState, carried: readonly CarriedTask[]) => Promise<void>;
/**
 * W1-T14447: admit a main that moved past its pinned commit. Each live head of each side is fetched without writing
 * a ref and admitted only when the pin is its ancestor, its range from the pin changes no carried task's record path
 * on that side, and its catalog patch names no carried task (a new record at another path, or a new dependant);
 * otherwise ref_moved. A step is still written on its pinned commit. Each range is read once per judge.
 */
export function liveHeadJudge(o: Options, paths: { public: CatalogPaths; ops: CatalogPaths }): LiveHeadJudge {
  const ranges = new Map<string, Promise<LiveRange>>();
  const sides = [
    { side: "public" as const, root: o.publicRoot, repository: o.publicRepo, pinned: o.publicCommit, live: (state: PreviewState) => state.publicLive },
    { side: "ops" as const, root: o.opsRoot, repository: o.opsRepo, pinned: o.opsCommit, live: (state: PreviewState) => state.opsLive },
  ];
  return async (state, carried) => {
    for (const { side, root, repository, pinned, live } of sides) {
      for (const head of live(state)) {
        const key = `${side}:${head}`;
        const range = ranges.get(key) ?? liveRange(root, repository, pinned, head, paths[side]);
        ranges.set(key, range);
        const { changed, patch } = await range;
        if (carried.some(task => changed.has(task.path) || namesTask(patch, task.id))) return unknown("ref_moved");
      }
    }
  };
}
function searchedMerged(state: PreviewState, id: string, control: Json): boolean {
  // Missing search evidence is incomplete; a complete search without its positive control is unreadable.
  if (!state.trailer || !state.branch || !state.control) return unknown("incomplete_merge_credit");
  if (!state.control.some(pr => pr.number === control.number && credited(pr).some(id => credited(control).includes(id)))) return unknown("merge_credit_control_unreadable");
  return [...state.trailer, ...state.branch].some(pr => credited(pr).includes(id));
}

/** W1-T14875: the record paths a closed copy pull request's failed ops-gate run named, or undefined when that is unread. */
export type OpsGateNamedReader = (repository: string, pull: number) => Promise<ReadonlySet<string> | undefined>;

/** One ops-gate finding line, `<path>: <message>`, after the job log's timestamp. */
const GATE_FINDING = /^(?:\S+Z )?(plan\/tasks\.d\/[^\s:]+\.ya?ml): \S/;
const stamp = (line: string) => line.replace(/^\S+Z /, "");
/**
 * PURE. The record paths an ops-gate job log names, or undefined unless the log reads whole: the gate step's output, every
 * line before its `ops-gate: FAIL` verdict a record finding, and as many of them as its `findings: N` summary counts.
 * A finding on anything but a record (a leak in another file) names no record, so it is undefined: every record stays refused.
 */
export function opsGateNamedPaths(log: string): ReadonlySet<string> | undefined {
  const lines = log.split(/\r?\n/).map(stamp);
  const run = lines.findIndex(line => line === "##[group]Run ruby scripts/ops-gate.rb");
  const start = run < 0 ? -1 : lines.indexOf("##[endgroup]", run);
  const fail = start < 0 ? -1 : lines.indexOf("ops-gate: FAIL", start);
  if (fail < 0) return undefined;
  const findings = lines.slice(start + 1, fail);
  const counted = lines.slice(fail).map(line => /^findings: (\d+) /.exec(line)?.[1]).find(n => n !== undefined);
  if (findings.length === 0 || findings.some(line => !GATE_FINDING.test(line)) || Number(counted) !== findings.length) return undefined;
  return new Set(findings.map(line => GATE_FINDING.exec(line)![1]!));
}

/** The live reader: the pull request's head, its failed ops-gate check run, and that run's job log. */
export const opsGateNamedRead: OpsGateNamedReader = async (repository, pull) => {
  const head = object(object(await ghJsonAsync(["api", `repos/${repository}/pulls/${pull}`])).head).sha;
  const runs = object(await ghJsonAsync(["api", `repos/${repository}/commits/${String(head)}/check-runs?check_name=ops-gate&per_page=100`])).check_runs;
  const failed = Array.isArray(runs) ? runs.map(object).filter(r => r.conclusion === "failure") : [];
  // No failed ops-gate run means the gate named nothing; the close was someone's own refusal of every record in it.
  if (failed.length !== 1) return undefined;
  return opsGateNamedPaths(await ghTextAsync(["api", `repos/${repository}/actions/jobs/${String(failed[0]!.id)}/logs`]));
};

/** W1-T13680: a closed, unmerged mover pull request whose ops copy added this same public blob: the move was refused.
 *  W1-T14345: one copy pull request may carry many tasks, so its receipt line, not its branch, names this one.
 *  W1-T14875 (operator ruling 2026-11-25 20:31Z): a closed batch refuses only the records its failed ops-gate run named.
 *  When that run cannot be read, or there is none, every record in the batch stays refused, as before. */
async function moveRefused(state: PreviewState, id: string, blob: string, named: OpsGateNamedReader, repository: string): Promise<boolean> {
  if (!state.refusedMoves) return unknown("incomplete_move_evidence");
  for (const pr of state.refusedMoves) {
    if (pr.state !== "CLOSED") continue;
    const receipt = String(pr.body).split(/\r?\n/).find(line => line.startsWith(`${MOVE_COPY_RECEIPT} ${id} `) && line.split(" ").includes(`blob=${blob}`));
    if (receipt === undefined) continue;
    const path = receipt.split(" ").find(field => field.startsWith("path="))?.slice(5);
    const paths = await named(repository, Number(pr.number)).then(x => x, () => undefined);
    if (paths === undefined || path === undefined || paths.has(path)) return true;
  }
  return false;
}

/**
 * W1-T14345: the order the public records were filed in: the first commit of the pinned history that added each path.
 * A path the history never shows added (a shallow read) ranks after every one it does.
 */
async function filingRanks(root: string, commit: string, dirs: readonly string[]): Promise<Map<string, number>> {
  const ranks = new Map<string, number>();
  if (dirs.length === 0) return ranks;
  const out = await defaultGitRunnerAsync(root)(["log", "--reverse", "--no-renames", "--diff-filter=A", "--format=", "--name-only", commit, "--", ...dirs]);
  for (const path of out.split("\n")) if (path && !ranks.has(path)) ranks.set(path, ranks.size);
  return ranks;
}

/** The preview's whole answer, before it is printed; `permission` is never granted. W1-T14345: `batch` is every task
 *  one move step may carry, oldest filing first; `candidate` is its first. */
export interface MigrationSelection {
  outcome: "candidate" | "none"; permission: "not_granted"; publicCommit: string; opsCommit: string;
  controls: Json; candidate: Json | undefined; batch: Json[]; refused: Array<{ id: string; reason: string }>;
}

/** Every id a public record names through depends_on or superseded_by. The mover leaves such a record public: its
 *  removal would leave the naming record's reference dangling, and the public plan read refuses that, so the REMOVE
 *  step's checks fail forever. W1-T13178 was copied while W1-T2874 named it as superseded_by. */
export function publicReferences(tasks: ReadonlyArray<Task>): Set<string> {
  return new Set(tasks.flatMap(task => [...task.depends_on, ...(task.superseded_by === undefined ? [] : [task.superseded_by])]));
}

/** W1-T14993: the reservation evidence a moving record whose id has no refs/rmd-id ref carries in its receipts. */
export const heldAtBase = (publicCommit: string) => `held-at=remudero@${publicCommit}`;
/** W1-T14993 (operator ruling 2026-11-26T15:10:25Z, "match the ops gate's rule"): what proves a moving record's id. Its
 *  refs/rmd-id ref when one exists; otherwise, as ops-gate check_reserved exempts a verified move, the public plan holding
 *  the id at the move's base proves it (ids before W1-T4217 predate reservations). Undefined when neither does. */
export function moveReservation(id: string, publicRefs: ReadonlyMap<string, string>, base: { commit: string; ids: { has(id: string): boolean } }): string | undefined {
  return publicRefs.get(`refs/rmd-id/${id}`) ?? (base.ids.has(id) ? heldAtBase(base.commit) : undefined);
}

/** W1-T14993: the roots and skipped folders scripts/task-id-existence-check.mjs scans for cited ids. */
const CITATION_ROOTS = ["src", "deploy", "plan"];
const CITATION_SKIPPED = new Set(["node_modules", "dist", "build", ".git", "coverage"]);
/** W1-T14993: the public files at `commit` that would still cite `id` once the paths in `leaving` are removed, as
 *  task-id-existence reads them (a whole-word id under its roots; its baseline exempts an id). A record held only at the
 *  base resolves through its own shard, so its removal is refused by that gate whenever this is non-empty. */
export async function unresolvedCitations(root: string, commit: string, id: string, leaving: ReadonlySet<string>): Promise<string[]> {
  const git = defaultGitRunnerAsync(root);
  const grep = ["grep", "-I", "-l", "-w", "-F", "-e", id, commit, "--", ...CITATION_ROOTS];
  const found = await exitOf(git, ["grep", "-q", ...grep.slice(1)]);
  if (found === 1) return [];
  if (found !== 0) return unknown("citation_unreadable");
  const cited = (await git(grep)).split("\n").filter(Boolean).map(line => line.slice(commit.length + 1))
    .filter(path => !leaving.has(path) && !path.split("/").some(part => CITATION_SKIPPED.has(part)));
  if (cited.length === 0) return [];
  const baseline = "scripts/task-id-existence-baseline.json";
  if (await exitOf(git, ["cat-file", "-e", `${commit}:${baseline}`]) !== 0) return cited;
  const rows = JSON.parse(await git(["show", `${commit}:${baseline}`])) as Array<{ id?: unknown }>;
  return rows.some(row => row.id === id) ? [] : cited;
}

/** W1-T15047: for each of `ids`, the public files at `commit` that cite it as task-id-existence reads them, in one
 *  read: {@link unresolvedCitations}'s whole-word match, roots, skipped folders and baseline, with nothing leaving. */
export async function citingFiles(root: string, commit: string, ids: readonly string[]): Promise<Map<string, string[]>> {
  const cited = new Map<string, string[]>();
  if (ids.length === 0) return cited;
  const git = defaultGitRunnerAsync(root);
  const grep = ["grep", "-I", "-o", "-w", "-F", ...ids.flatMap(id => ["-e", id]), commit, "--", ...CITATION_ROOTS];
  const found = await exitOf(git, ["grep", "-q", ...grep.slice(1).filter(arg => arg !== "-o")]);
  if (found === 1) return cited;
  if (found !== 0) return unknown("citation_unreadable");
  const baseline = "scripts/task-id-existence-baseline.json";
  const exempt = await exitOf(git, ["cat-file", "-e", `${commit}:${baseline}`]) !== 0 ? new Set<unknown>() :
    new Set((JSON.parse(await git(["show", `${commit}:${baseline}`])) as Array<{ id?: unknown }>).map(row => row.id));
  for (const line of (await git(grep)).split("\n")) {
    if (!line.startsWith(`${commit}:`)) continue;
    const at = line.lastIndexOf(":"), path = line.slice(commit.length + 1, at), id = line.slice(at + 1);
    if (exempt.has(id) || path.split("/").some(part => CITATION_SKIPPED.has(part))) continue;
    const paths = cited.get(id) ?? cited.set(id, []).get(id)!;
    if (!paths.includes(path)) paths.push(path);
  }
  return cited;
}

/** The selection the preview verb prints (W1-T13680 exports it for `rmd move-task`): pinned catalogs, ownership, the
 *  merge-credit search and a stable re-read. It throws {@link PreviewUnknown} on any unread or changed evidence.
 *  W1-T14345: it fills a batch of open tasks, oldest filing first, that the ops catalog has room for; a batch of one is
 *  selected exactly as before. W1-T14714: no count ends the batch; {@link BatchFits} ends it where a pull request would
 *  pass GitHub's body limit. */
export async function selectPlanTaskMigration(
  o: Options, reader: MigrationGraphqlReader = graphqlRead, bounds: OpsCatalogBoundsIo = {}, fits?: BatchFits, gateNamed: OpsGateNamedReader = opsGateNamedRead,
): Promise<MigrationSelection> {
  const publicRefs = await refs(o.publicRoot, o.publicRepo), opsRefs = await refs(o.opsRoot, o.opsRepo);
  const pub = await catalog(o.publicRoot, o.publicCommit), ops = await catalog(o.opsRoot, o.opsCommit, true);
  if (ops.plan.tasks.some(t => pub.plan.byId.has(t.id) || t.depends_on.some(id => !ops.plan.byId.has(id) && !pub.plan.byId.has(id)))) return unknown("catalog_conflict");
  const judge = liveHeadJudge(o, { public: pub.paths, ops: ops.paths });
  const initial = await readState(o, publicRefs, opsRefs, { reader }), knownMerged = new Set(initial.recent.flatMap(credited));
  await judge(initial, []);
  // A positive search control is an actual known run PR, not an invented task or an age-based grant.
  const control = [...initial.recent].reverse().find(pr => taskIdFromRunBranch(String(pr.headRefName)) !== undefined);
  const refused: Array<{ id: string; reason: string }> = [];
  const publicPrerequisites = publicReferences(pub.plan.tasks);
  const atBase = { commit: o.publicCommit, ids: pub.plan.byId };
  // Oldest filing first; records filed in one commit keep the reverse dispatch order the preview always read.
  const ranks = await filingRanks(o.publicRoot, o.publicCommit, [...new Set([...pub.originals.values()].filter(x => x.shard).map(x => dirname(x.path)))]);
  const rank = (task: Task) => ranks.get(pub.originals.get(task.id)!.path) ?? Number.MAX_SAFE_INTEGER;
  const ordered = dispatchOrder(pub.plan.tasks).reverse().map((task, i) => ({ task, i })).sort((a, b) => rank(a.task) - rank(b.task) || a.i - b.i).map(x => x.task);
  const batch: Json[] = [];
  // W1-T14447: what each re-read protects: every member selected so far, and the candidate under lookup.
  const carried: CarriedTask[] = [];
  const carriedOf = (task: Task, path: string): CarriedTask => ({ id: task.id, path, files: [path] });
  let lookups = 0;
  // W1-T14825: a record public records still name moves WITH them. Its group is the record plus every public record
  // that names it through depends_on or superseded_by, transitively; a retired, merged or done namer moves as history.
  // The whole group joins one batch or none of it does, so no removal ever leaves a public reference dangling.
  const namers = new Map<string, Task[]>();
  for (const t of pub.plan.tasks) for (const id of publicReferences([t])) (namers.get(id) ?? namers.set(id, []).get(id)!).push(t);
  // W1-T15047: a record that cites an unreserved record's id in prose names it too, since the id resolves only through
  // that record's own shard. Only a single-record shard is a citer that can move; any other citing file still refuses.
  const recordAt = new Map<string, Task>();
  for (const t of pub.plan.tasks) { const orig = pub.originals.get(t.id)!; if (orig.single && orig.shard) recordAt.set(orig.path, t); }
  const named = new Set(publicPrerequisites);
  const unreserved = pub.plan.tasks.filter(t => !publicRefs.has(`refs/rmd-id/${t.id}`)).map(t => t.id);
  for (const [id, paths] of await citingFiles(o.publicRoot, o.publicCommit, unreserved)) {
    for (const citer of paths.map(path => recordAt.get(path))) {
      if (citer === undefined || citer.id === id) continue;
      const list = namers.get(id) ?? namers.set(id, []).get(id)!;
      if (!list.includes(citer)) list.push(citer);
      named.add(id);
    }
  }
  const inBatch = new Set<string>(), historyIds = new Set<string>();
  const isHistory = (t: Task) => !OPEN_STATUSES.has(t.status) || t.retirement !== undefined;
  /** Why `t` cannot join a group, or undefined; a history member skips only the open-work rules. */
  const groupRefusal = (t: Task): string | undefined => {
    const orig = pub.originals.get(t.id)!;
    if (!isHistory(t) && knownMerged.has(t.id)) return "merged";
    if (t.repo !== o.publicRepo.split("/")[1]) return "target_not_bound";
    if (taskOwned(t.id, [orig.path], publicRefs, initial.open)) return "owned";
    if (!orig.single || !orig.shard) return "not_single_shard";
    if (alreadyMoved(orig)) return "already_moved";
    // W1-T14858: the ops gate judges a record as moved history by its status alone, so a retired record whose status is
    // still open-shaped (blocked, queued) is moved live work there and must pass the shape rules.
    if (!OPS_GATE_HISTORY_STATUSES.has(t.status) && opsGateShapeRefused(orig)) return "ops_gate_shape";
    if (moveReservation(t.id, publicRefs, atBase) === undefined) return "reservation_absent";
    return undefined;
  };
  /** The record's group, or undefined when any member cannot move or would leave a superseded_by unresolved in ops. */
  const groupOf = (lead: Task): Task[] | undefined => {
    const group = new Map<string, Task>([[lead.id, lead]]);
    const queue = [lead];
    while (queue.length > 0) {
      for (const namer of namers.get(queue.shift()!.id) ?? []) {
        if (group.has(namer.id) || inBatch.has(namer.id)) continue;
        group.set(namer.id, namer);
        queue.push(namer);
      }
    }
    const members = [...group.values()];
    if (members.some(m => m !== lead && groupRefusal(m) !== undefined)) return undefined;
    const lands = (id: string) => group.has(id) || inBatch.has(id) || ops.plan.byId.has(id);
    if (members.some(m => m.superseded_by !== undefined && !lands(m.superseded_by))) return undefined;
    return members;
  };
  for (const task of ordered) {
    if (inBatch.has(task.id)) continue;
    const original = pub.originals.get(task.id)!;
    const reason = knownMerged.has(task.id) ? "merged" : task.repo !== o.publicRepo.split("/")[1] ? "target_not_bound" : taskOwned(task.id, [original.path], publicRefs, initial.open) ? "owned" :
      named.has(task.id) && groupOf(task) === undefined ? "public_dependants" : !original.single || !original.shard ? "not_single_shard" : alreadyMoved(original) ? "already_moved" : undefined;
    if (reason) { refused.push({ id: task.id, reason }); continue; }
    if (task.retirement !== undefined) {
      refused.push({ id: task.id, reason: "retired" });
      continue;
    }
    // W1-T13680: only an open, machine-verified task whose public reservation exists may move. W1-T14345: open is
    // queued or blocked. W1-T14425: a verify:human record is open like any other, since W1-T14408 made its release pin
    // exclude the mover's moved_from line, so a release survives the move. W1-T14424: an open record
    // the ops gate's moved-live rules refuse would fail the whole batch's copy, so it is left out before any lookup.
    const unmovable = !OPEN_STATUSES.has(task.status) ? "not_open" : opsGateShapeRefused(original) ? "ops_gate_shape" :
      moveReservation(task.id, publicRefs, atBase) === undefined ? "reservation_absent" : undefined;
    if (unmovable) { refused.push({ id: task.id, reason: unmovable }); continue; }
    if (!control) return unknown("merge_credit_control_unreadable");
    // W1-T14825: an unnamed record is a group of one, selected exactly as before.
    const group = named.has(task.id) ? groupOf(task)! : [task];
    // W1-T14993: a member with no reservation ref resolves only through its own shard, so it moves only when its removal
    // (with the batch's) leaves no public citation of its id for task-id-existence to refuse.
    const leaving = new Set([...batch.map(m => String(m.sourcePath)), ...group.map(m => pub.originals.get(m.id)!.path)]);
    let cited = false;
    for (const member of group) {
      if (publicRefs.has(`refs/rmd-id/${member.id}`)) continue;
      if ((await unresolvedCitations(o.publicRoot, o.publicCommit, member.id, leaving)).length > 0) { cited = true; break; }
    }
    if (cited) { refused.push({ id: task.id, reason: group.length > 1 ? "group_citation_unresolved" : "citation_unresolved" }); continue; }
    let groupRefused: string | undefined;
    const carrying = [...carried];
    for (const member of group) {
      const memberOriginal = pub.originals.get(member.id)!;
      lookups++;
      const checked = await readState(o, publicRefs, opsRefs, { id: member.id, control, reader });
      carrying.push(carriedOf(member, memberOriginal.path));
      stable(initial, checked, carrying); await judge(checked, carrying);
      if (await moveRefused(checked, member.id, memberOriginal.blob, gateNamed, o.opsRepo)) { groupRefused = "move_refused"; break; }
      // A merged or done record moves as history: its merge credit is what it records, not a reason to stay.
      if (!isHistory(member) && searchedMerged(checked, member.id, control)) { groupRefused = "merged"; break; }
    }
    if (groupRefused) { refused.push({ id: task.id, reason: group.length > 1 ? `group_${groupRefused}` : groupRefused }); continue; }
    const texts = group.map(member => pub.originals.get(member.id)!.text);
    // W1-T14368: the bounds judge the ops catalog this copy would produce, not the one it read. W1-T14345: with every
    // copy the batch already holds; a copy the catalog has no room for ends the batch, and refuses it only when alone.
    if (ops.size) {
      try { judgeOpsBatch(ops.size, [...batch.map(member => String(member.yaml)), ...texts], o.publicCommit, bounds); }
      catch (error) { if (batch.length === 0 || !(error instanceof PreviewUnknown)) throw error; break; }
    }
    // W1-T14714: a member whose receipts would carry a pull request past GitHub's body limit ends the batch; never alone.
    const members = group.map(member => { const orig = pub.originals.get(member.id)!; return { id: member.id, path: orig.path, blob: orig.blob }; });
    if (fits && batch.length > 0 && !fits([...batch.map(m => ({ id: String(m.id), path: String(m.sourcePath), blob: String(m.sourceBlob) })), ...members])) break;
    for (const member of group) {
      const orig = pub.originals.get(member.id)!;
      carried.push(carriedOf(member, orig.path));
      inBatch.add(member.id);
      if (isHistory(member)) historyIds.add(member.id);
      batch.push({ id: member.id, sourcePath: orig.path, sourceCommit: o.publicCommit, sourceBlob: orig.blob, yaml: orig.text, originalBytesBase64: Buffer.from(orig.text).toString("base64"), prospectiveMovedFrom: `remudero@${o.publicCommit}` });
    }
  }
  // Independently re-read selected ownership, both source heads and each selected task's API credit before answering.
  const finalPublic = await refs(o.publicRoot, o.publicRepo), finalOps = await refs(o.opsRoot, o.opsRepo);
  for (const member of batch.length > 0 ? batch : [undefined]) {
    const last = await readState(o, finalPublic, finalOps, { id: member ? String(member.id) : undefined, control, reader });
    stable(initial, last, carried); await judge(last, carried);
    if (member && control) {
      if (!historyIds.has(String(member.id)) && searchedMerged(last, String(member.id), control)) return unknown("candidate_credit_changed");
      const task = pub.plan.byId.get(String(member.id))!;
      if (taskOwned(task.id, [String(member.sourcePath)], finalPublic, last.open)) return unknown("ownership_changed");
    }
  }
  const candidate = batch[0];
  return { outcome: candidate ? "candidate" : "none", permission: "not_granted", publicCommit: o.publicCommit, opsCommit: o.opsCommit,
    controls: { repositoryId: initial.repositoryId, opsRepositoryId: initial.opsId, recentMergedPrs: initial.recent.length, mergedPrTotal: initial.mergedTotal,
      wholeMergeHistoryRead: initial.recent.length === initial.mergedTotal, candidateSearches: lookups, openPrs: initial.open.length, publicTasks: pub.plan.tasks.length, opsTasks: ops.plan.tasks.length }, candidate, batch, refused };
}

/** Explicit read-only CLI: the result describes evidence, never permission to move a task. */
export async function previewPlanTaskMigration(args: readonly string[]): Promise<number> {
  const o = migrationOptions(args);
  if (!o) { console.log(JSON.stringify({ outcome: "unknown", reason: "usage", permission: "not_granted" })); return 2; }
  try {
    console.log(JSON.stringify(await selectPlanTaskMigration(o)));
    return 0;
  } catch (error) {
    // Raw Git/API/parser errors can contain private paths or YAML; unknown is not evidence of freedom.
    console.log(JSON.stringify({ outcome: "unknown", reason: error instanceof PreviewUnknown ? error.reason : "unreadable_evidence", permission: "not_granted" }));
    return 1;
  }
}
