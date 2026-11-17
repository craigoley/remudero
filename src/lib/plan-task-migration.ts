import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { resolveRepoLayout } from "./repo-layout.js";
import { OPS_CATALOG_MAX_SHARDS, OPS_CATALOG_MAX_BLOB_BYTES, OPS_CATALOG_MAX_TOTAL_BYTES, OPS_CATALOG_MAX_TREE_ENTRIES } from "./ops-catalog-source.js";
import { parse as parseYaml } from "yaml";
import { defaultGitRunnerAsync, readBlobsAtRefAsync, type Plan } from "./plan.js";
import { createPlanRevisionStore } from "./plan-revision-store.js";
import { dispatchOrder } from "./drain.js";
import { taskIdFromRunBranch, creditsByAnchoredTrailer } from "./status.js";
import { ghJsonAsync } from "./github-transport.js";
import { RmdError } from "./errors.js";

type Json = Record<string, unknown>;
type Options = { publicRoot: string; publicCommit: string; publicRepo: string; opsRoot: string; opsCommit: string; opsRepo: string };
type Original = { path: string; text: string; blob: string; single: boolean; shard: boolean };
// BACKSTOP: refuse a runaway explicit preview whole, never truncate a population into absence.
const MAX_CANDIDATE_LOOKUPS = 32;
// The measured public corpus is 34,444,886 bytes. Leave 16 MiB for framing below the shared 64 MiB Git buffer.
const MAX_CATALOG_BYTES = 48 * 1024 * 1024;
class PreviewUnknown extends RmdError {
  constructor(readonly reason: string) { super("plan", 1, reason); }
}
const unknown = (reason: string): never => { throw new PreviewUnknown(reason); };
const object = (x: unknown): Json => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Json : unknown("incomplete_evidence");
const sha = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{40}$/.test(x);
const repository = (x: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x);
function options(args: readonly string[]): Options | undefined {
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
async function catalog(root: string, commit: string, external = false): Promise<{ plan: Plan; originals: Map<string, Original> }> {
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
    // Refuse known oversized inputs before materializing their payloads. The private limits are
    // the actual reader's exported contract, not a larger public-preview budget or a host override.
    if (!Number.isSafeInteger(size) || declaredBytes > MAX_CATALOG_BYTES) return unknown("catalog_unreadable");
    if (external && (declaredBytes > OPS_CATALOG_MAX_TOTAL_BYTES || size > OPS_CATALOG_MAX_BLOB_BYTES)) return unknown("catalog_incompatible");
    const shard = path.startsWith(shardDir) && !path.slice(shardDir.length).includes("/") && /\.ya?ml$/.test(path);
    return path === monolith || shard ? { path, blob: m[1]!, size, shard } : unknown("catalog_unreadable");
  });
  if (!files.some(f => f.path === monolith) || files.length > 10_000) return unknown("catalog_unreadable");
  if (external) {
    if (files.filter(file => file.shard).length > OPS_CATALOG_MAX_SHARDS) return unknown("catalog_incompatible");
    // The API reader counts each visited immediate tree, including entries outside the selected
    // blobs. Mirror those same three populations without fetching or interpreting unrelated files.
    const trees = [commit, `${commit}:plan`];
    if (files.some(file => file.shard)) trees.push(`${commit}:plan/tasks.d`);
    let treeEntries = 0;
    for (const tree of trees) {
      treeEntries += (await git(["ls-tree", "-z", tree])).split("\0").filter(Boolean).length;
      if (treeEntries > OPS_CATALOG_MAX_TREE_ENTRIES) return unknown("catalog_incompatible");
    }
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
  return { plan, originals };
}
function alreadyMoved(original: Original): boolean {
  // Only otherwise eligible candidates need this raw metadata; strict parsing already validated all bytes.
  const raw: unknown = parseYaml(original.text, { logLevel: "silent" });
  return Array.isArray(raw) && raw.some(entry => entry !== null && typeof entry === "object" && Object.hasOwn(entry, "moved_from"));
}
async function refs(root: string, selectedRepository: string): Promise<Map<string, string>> {
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
function query(o: Options, taskId?: string, control?: Json): string {
  const [owner, name] = o.publicRepo.split("/"), [opsOwner, opsName] = o.opsRepo.split("/");
  const pin = "databaseId nameWithOwner defaultBranchRef{name target{oid}}";
  const open = `open:pullRequests(states:OPEN,first:100,orderBy:{field:CREATED_AT,direction:ASC}){totalCount pageInfo{hasNextPage endCursor} nodes{number state headRefName headRefOid body files(first:100){totalCount pageInfo{hasNextPage} nodes{path}}}}`;
  const merged = `merged:pullRequests(states:MERGED,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){totalCount pageInfo{hasNextPage endCursor} nodes{${prFields}}}`;
  const search = (alias: string, term: string) => `${alias}:search(query:${JSON.stringify(`repo:${o.publicRepo} is:pr is:merged ${term}`)},type:ISSUE,first:100){issueCount pageInfo{hasNextPage} nodes{... on PullRequest{${prFields} repository{databaseId nameWithOwner}}}}`;
  const searches = taskId && control ? search("byTrailer", `"Remudero-Task: ${taskId}" in:body`) + search("byBranch", `head:run-${taskId}-`) +
    search("control", `head:${control.headRefName}`) : "";
  return `query MigrationPreview{public:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${pin} ${open} ${merged}} ops:repository(owner:${JSON.stringify(opsOwner)},name:${JSON.stringify(opsName)}){${pin}} ${searches}}`;
}
function pin(repo: Json, expected: string, commit: string, remote: Map<string, string>): number {
  if (repo.nameWithOwner !== expected || !Number.isSafeInteger(repo.databaseId) || Number(repo.databaseId) <= 0) return unknown("repository_identity");
  const branch = object(repo.defaultBranchRef), target = object(branch.target);
  if (typeof branch.name !== "string" || target.oid !== commit || remote.get(`refs/heads/${branch.name}`) !== commit || remote.get("HEAD") !== commit) return unknown("ref_moved");
  return Number(repo.databaseId);
}
function page(value: unknown): { nodes: Json[]; total: number; next: boolean; cursor: string | null } {
  const p = object(value), info = object(p.pageInfo);
  if (!Array.isArray(p.nodes) || !Number.isSafeInteger(p.totalCount) || Number(p.totalCount) < p.nodes.length || typeof info.hasNextPage !== "boolean" || !(info.endCursor === null || typeof info.endCursor === "string" || info.endCursor === undefined)) return unknown("incomplete_evidence");
  return { nodes: p.nodes.map(object), total: Number(p.totalCount), next: info.hasNextPage, cursor: typeof info.endCursor === "string" ? info.endCursor : null };
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
function taskOwned(id: string, files: readonly string[], remote: Map<string, string>, open: Json[]): boolean {
  if (remote.has(`refs/rmd-dispatch/${id}`) || [...remote.keys()].some(ref => ref.startsWith("refs/heads/") && taskIdFromRunBranch(ref.slice(11)) === id)) return true;
  return open.some(pr => taskIdFromRunBranch(String(pr.headRefName)) === id || String(pr.body).split(/\r?\n/).includes(`Remudero-Task: ${id}`) || page(pr.files).nodes.some(file => files.includes(String(file.path))));
}

interface PreviewState {
  repositoryId: number; opsId: number; open: Json[]; recent: Json[]; mergedTotal: number;
  trailer?: Json[]; branch?: Json[]; control?: Json[];
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
async function readState(o: Options, primaryRefs: Map<string, string>, privateRefs: Map<string, string>, id?: string, control?: Json): Promise<PreviewState> {
  const raw = object(await ghJsonAsync(["api", "graphql", "-f", `query=${query(o, id, control)}`], undefined, undefined, { fresh: true }));
  if (raw.errors !== undefined) return unknown("api_unreadable");
  const data = object(raw.data), primary = object(data.public), secondary = object(data.ops);
  const repositoryId = pin(primary, o.publicRepo, o.publicCommit, primaryRefs), opsId = pin(secondary, o.opsRepo, o.opsCommit, privateRefs);
  if (repositoryId === opsId) return unknown("repository_identity");
  const recent = page(primary.merged);
  if (recent.nodes.length !== Math.min(recent.total, 100) || recent.next !== (recent.total > recent.nodes.length)) return unknown("incomplete_merge_credit");
  const numbers = new Set<number>();
  for (const pr of recent.nodes) { credited(pr); if (numbers.has(Number(pr.number))) return unknown("incomplete_merge_credit"); numbers.add(Number(pr.number)); }
  return { repositoryId, opsId, open: openSnapshot(primary.open), recent: recent.nodes, mergedTotal: recent.total,
    ...(id && control ? { trailer: searchRows(data.byTrailer, repositoryId, o.publicRepo), branch: searchRows(data.byBranch, repositoryId, o.publicRepo), control: searchRows(data.control, repositoryId, o.publicRepo) } : {}) };
}
function stable(before: PreviewState, after: PreviewState): void {
  if (before.repositoryId !== after.repositoryId || before.opsId !== after.opsId || before.mergedTotal !== after.mergedTotal || JSON.stringify(before.open) !== JSON.stringify(after.open) || JSON.stringify(before.recent) !== JSON.stringify(after.recent)) return unknown("ownership_changed");
}
function searchedMerged(state: PreviewState, id: string, control: Json): boolean {
  // Missing search evidence is incomplete; a complete search without its positive control is unreadable.
  if (!state.trailer || !state.branch || !state.control) return unknown("incomplete_merge_credit");
  if (!state.control.some(pr => pr.number === control.number && credited(pr).some(id => credited(control).includes(id)))) return unknown("merge_credit_control_unreadable");
  return [...state.trailer, ...state.branch].some(pr => credited(pr).includes(id));
}

/** Explicit read-only CLI: the result describes evidence, never permission to move a task. */
export async function previewPlanTaskMigration(args: readonly string[]): Promise<number> {
  const o = options(args);
  if (!o) { console.log(JSON.stringify({ outcome: "unknown", reason: "usage", permission: "not_granted" })); return 2; }
  try {
    const publicRefs = await refs(o.publicRoot, o.publicRepo), opsRefs = await refs(o.opsRoot, o.opsRepo);
    const pub = await catalog(o.publicRoot, o.publicCommit), ops = await catalog(o.opsRoot, o.opsCommit, true);
    if (ops.plan.tasks.some(t => pub.plan.byId.has(t.id) || t.depends_on.some(id => !ops.plan.byId.has(id) && !pub.plan.byId.has(id)))) return unknown("catalog_conflict");
    const initial = await readState(o, publicRefs, opsRefs), knownMerged = new Set(initial.recent.flatMap(credited));
    // A positive search control is an actual known run PR, not an invented task or an age-based grant.
    const control = [...initial.recent].reverse().find(pr => taskIdFromRunBranch(String(pr.headRefName)) !== undefined);
    const refused: Array<{ id: string; reason: string }> = [];
    const publicPrerequisites = new Set(pub.plan.tasks.flatMap(task => task.depends_on));
    let candidate: Json | undefined, lookups = 0;
    for (const task of dispatchOrder(pub.plan.tasks).reverse()) {
      const original = pub.originals.get(task.id)!;
      const reason = knownMerged.has(task.id) ? "merged" : task.repo !== o.publicRepo.split("/")[1] ? "target_not_bound" : taskOwned(task.id, [...(task.files ?? []), original.path], publicRefs, initial.open) ? "owned" :
        publicPrerequisites.has(task.id) ? "public_dependants" : !original.single || !original.shard ? "not_single_shard" : alreadyMoved(original) ? "already_moved" : undefined;
      if (reason) { refused.push({ id: task.id, reason }); continue; }
      if (!control) return unknown("merge_credit_control_unreadable");
      if (++lookups > MAX_CANDIDATE_LOOKUPS) return unknown("merge_credit_budget_exhausted");
      const checked = await readState(o, publicRefs, opsRefs, task.id, control); stable(initial, checked);
      if (searchedMerged(checked, task.id, control)) { refused.push({ id: task.id, reason: "merged" }); continue; }
      candidate = { id: task.id, sourcePath: original.path, sourceCommit: o.publicCommit, sourceBlob: original.blob, yaml: original.text, originalBytesBase64: Buffer.from(original.text).toString("base64"), prospectiveMovedFrom: `remudero@${o.publicCommit}` };
      break;
    }
    // Independently re-read selected ownership, both source heads and the candidate's API credit before answering.
    const finalPublic = await refs(o.publicRoot, o.publicRepo), finalOps = await refs(o.opsRoot, o.opsRepo);
    const last = await readState(o, finalPublic, finalOps, candidate ? String(candidate.id) : undefined, control); stable(initial, last);
    if (candidate && control) {
      if (searchedMerged(last, String(candidate.id), control)) return unknown("candidate_credit_changed");
      const task = pub.plan.byId.get(String(candidate.id))!;
      if (taskOwned(task.id, [...(task.files ?? []), String(candidate.sourcePath)], finalPublic, last.open)) return unknown("ownership_changed");
    }
    console.log(JSON.stringify({ outcome: candidate ? "candidate" : "none", permission: "not_granted", publicCommit: o.publicCommit, opsCommit: o.opsCommit,
      controls: { repositoryId: initial.repositoryId, opsRepositoryId: initial.opsId, recentMergedPrs: initial.recent.length, mergedPrTotal: initial.mergedTotal,
        wholeMergeHistoryRead: initial.recent.length === initial.mergedTotal, candidateSearches: lookups, openPrs: initial.open.length, publicTasks: pub.plan.tasks.length, opsTasks: ops.plan.tasks.length }, candidate, refused }));
    return 0;
  } catch (error) {
    // Raw Git/API/parser errors can contain private paths or YAML; unknown is not evidence of freedom.
    console.log(JSON.stringify({ outcome: "unknown", reason: error instanceof PreviewUnknown ? error.reason : "unreadable_evidence", permission: "not_granted" }));
    return 1;
  }
}
