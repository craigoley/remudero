/**
 * W1-T11195 — the ONE bounded reader of a product target's runner configuration.
 *
 * A native `rmd plan` against a product target reads its mounts table (`mountsPath`) from that target before it logs
 * `plan.start`; a target that carries none can only fail. This reader answers, from the COMMITTED tree at the exact frozen
 * head (never the working tree, which a dirty file can fake), whether that table is there and valid, so the product plan
 * operation refuses with a named, recoverable state before it journals or hands anything off.
 *
 * Four answers, and a failure never becomes absence (W1-T10621's confirmed-absence discipline):
 * - `present`: a regular blob that parses and validates through `validateMounts`, Tier Invariant (G-17) included.
 * - `absent`: a successful tree read at a verified commit lacks the path.
 * - `invalid`: the path is a symlink, a non-blob, oversized, or a blob that fails parsing or validation.
 * - `unreadable`: any git or transport failure, including a head that is not a commit in the checkout.
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ghTextAsync } from "./github-transport.js";
import { loadMounts, mountsPath, validateMounts } from "./mounts.js";
import { ProductIntentStore } from "./product-intent-store.js";
import { systemClock, type Clock } from "./clock.js";
import { acquireInflightLock, InflightLockError } from "./inflight-lock.js";
import { productIdSchema, productRequestIdSchema, type ProductStoreCode } from "./product-intent.js";
import { ghProductRepositoryProvider, type ProductRepositoryProvider } from "./product-repository.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

const layout = resolveRepoLayout(sep, () => undefined);
const treePath = (path: string) => relative(layout.root, path).split(sep).join("/");
/** The table's path inside the target tree: exactly the file `mountsPath` joins under a target root. */
export const TARGET_RUNNER_CONFIG_PATH = treePath(mountsPath(layout.root));
/** The never-overridable per-target state directory the table lives in. */
const STATE_DIRECTORY = treePath(layout.stateDir);
/** BACKSTOP: this repository's own table is ~43 KB; a blob past this bound is refused as invalid, never buffered. */
export const TARGET_RUNNER_CONFIG_MAX_BYTES = 1024 * 1024;

export type TargetRunnerConfig =
  | { state: "present"; head: string; path: string; digest: string }
  | { state: "absent"; head: string; path: string }
  | { state: "invalid" | "unreadable"; head: string; path: string; reason: string };

/** One git read of the target checkout; the default is the pinned host-worktree reader. */
export type TargetGitRead = (checkout: string, args: string[], opts: { maxBuffer: number; encoding?: "utf8" | "latin1" }) => Promise<string>;
const hostRead: TargetGitRead = (checkout, args, opts) => hostWorktreeGitAsync(checkout, args, { timeout: 20_000, ...opts });

interface TreeEntry { mode: string; type: string; object: string; size: string; path: string }
const entries = (out: string): TreeEntry[] => out.split("\0").filter(Boolean).flatMap((line) => {
  const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\S+)\t(.*)$/s.exec(line);
  if (!match) throw new Error(`unparseable ls-tree row: ${JSON.stringify(line)}`);
  return [{ mode: match[1]!, type: match[2]!, object: match[3]!, size: match[4]!, path: match[5]! }];
});

/** Read the mounts table from `head`'s committed tree in `checkout`. Never throws: every failure is a state. */
export async function readTargetRunnerConfig(checkout: string, head: string, read: TargetGitRead = hostRead): Promise<TargetRunnerConfig> {
  const path = TARGET_RUNNER_CONFIG_PATH;
  const at = { head, path };
  if (!/^[a-f0-9]{40}$/.test(head)) return { state: "unreadable", ...at, reason: "the frozen head is not a commit id" };
  let blob: Buffer;
  try {
    const commit = (await read(checkout, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${head}^{commit}`], { maxBuffer: 4096 })).trim();
    if (commit !== head) return { state: "unreadable", ...at, reason: `the checkout resolves ${head} to ${commit || "nothing"}` };
    const [file] = entries(await read(checkout, ["ls-tree", "-z", "-l", "--full-tree", head, "--", path], { maxBuffer: 64 * 1024 }));
    if (file === undefined) {
      // The file is not listed. A symlinked or non-directory state directory hides it rather than proving it absent.
      const [parent] = entries(await read(checkout, ["ls-tree", "-z", "-l", "--full-tree", head, "--", STATE_DIRECTORY], { maxBuffer: 64 * 1024 }));
      if (parent !== undefined && parent.type !== "tree") {
        return { state: "invalid", ...at, reason: `${STATE_DIRECTORY} is a ${parent.mode === "120000" ? "symlink" : parent.type}, not a directory` };
      }
      return { state: "absent", ...at };
    }
    if (file.mode === "120000") return { state: "invalid", ...at, reason: `${path} is a symlink` };
    if (file.type !== "blob") return { state: "invalid", ...at, reason: `${path} is a ${file.type}, not a file` };
    if (!(Number(file.size) <= TARGET_RUNNER_CONFIG_MAX_BYTES)) return { state: "invalid", ...at, reason: `${path} is ${file.size} bytes, over the ${TARGET_RUNNER_CONFIG_MAX_BYTES}-byte bound` };
    blob = Buffer.from(await read(checkout, ["cat-file", "blob", file.object], { maxBuffer: TARGET_RUNNER_CONFIG_MAX_BYTES + 1, encoding: "latin1" }), "latin1");
  } catch (error) {
    return { state: "unreadable", ...at, reason: `git read failed: ${String((error as Error)?.message ?? error)}` };
  }
  try {
    validateMounts(parseYaml(new TextDecoder("utf-8", { fatal: true }).decode(blob)));
  } catch (error) {
    return { state: "invalid", ...at, reason: String((error as Error)?.message ?? error) };
  }
  return { state: "present", ...at, digest: createHash("sha256").update(blob).digest("hex") };
}

export const RUNNER_CONFIG_PREVIEW_VERSION = "product-runner-config-preview-v1" as const;
const commitId = z.string().regex(/^[a-f0-9]{40}$/);
const previewQuery = z.object({ productId: productIdSchema,
  expectedRevision: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedObjectiveRevision: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export interface RunnerConfigProposal {
  path: string; bytes: string; digest: string; targetHead: string;
  source: { kind: "serving_instance_mounts"; commit: string };
  validation: { valid: true; g17: true };
  changes: [{ operation: "add"; path: string }];
}
export interface RunnerConfigPreview {
  version: typeof RUNNER_CONFIG_PREVIEW_VERSION; productId: string; revision: number; objectiveRevision: number;
  state: TargetRunnerConfig["state"] | "source_unavailable" | "stale_target" | "repository_missing" | "repository_conflict";
  head?: string; path: string; digest?: string; reason?: string; proposal?: RunnerConfigProposal;
}
export interface RunnerConfigPreviewOptions {
  root?: string; installRoot: string; store?: ProductIntentStore;
  provider?: Pick<ProductRepositoryProvider, "read">;
  text?: typeof ghTextAsync;
}
type PreviewResult = { ok: true; value: RunnerConfigPreview } | { ok: false; code: ProductStoreCode };

/** Adapt bounded GitHub tree/blob reads to the same committed-tree reader used by native planning. */
function githubRunnerConfigRead(slug: string, api: (path: string) => Promise<string>): TargetGitRead {
  const row = z.object({ path: z.string(), mode: z.string().regex(/^\d{6}$/), type: z.string(), sha: commitId, size: z.number().int().nonnegative().optional() });
  const tree = z.object({ truncated: z.literal(false), tree: z.array(row) });
  const trees = new Map<string, z.infer<typeof tree>>();
  const getTree = async (ref: string) => {
    if (!trees.has(ref)) trees.set(ref, tree.parse(JSON.parse(await api(`${slug}/git/trees/${ref}`))));
    return trees.get(ref)!.tree;
  };
  return async (_checkout, args) => {
    if (args[0] === "rev-parse") {
      const head = args.at(-1)!.replace(/\^\{commit\}$/, "");
      return commitId.parse(JSON.parse(await api(`${slug}/commits/${head}`)).sha);
    }
    if (args[0] === "ls-tree") {
      const head = args[4]!;
      const path = args.at(-1)!;
      const roots = await getTree(head);
      const parent = roots.find(entry => entry.path === STATE_DIRECTORY);
      const found = path === STATE_DIRECTORY ? parent : parent?.type === "tree"
        ? (await getTree(parent.sha)).find(entry => entry.path === "mounts.yaml") : undefined;
      return found ? `${found.mode} ${found.type} ${found.sha} ${found.size ?? "-"}\t${path}\0` : "";
    }
    const blob = z.object({ sha: commitId, encoding: z.literal("base64"), size: z.number().int().max(TARGET_RUNNER_CONFIG_MAX_BYTES), content: z.string() })
      .parse(JSON.parse(await api(`${slug}/git/blobs/${args[2]}`)));
    const content = blob.content.replace(/\s/g, "");
    if (blob.sha !== args[2] || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new Error("invalid GitHub blob");
    const bytes = Buffer.from(content, "base64");
    if (bytes.length !== blob.size) throw new Error("GitHub blob size mismatch");
    return bytes.toString("latin1");
  };
}

/** Informational only: the owner and live repository/head are checked again before any proposal is returned. */
export async function previewRunnerConfigBootstrap(options: RunnerConfigPreviewOptions, actor: string, query: unknown): Promise<PreviewResult> {
  const input = previewQuery.safeParse(query);
  if (!input.success) return { ok: false, code: "invalid_input" };
  const store = options.store ?? new ProductIntentStore(options);
  const product = store.read(actor, input.data.productId);
  if (!product.ok) return { ok: false, code: product.code };
  const { id: productId, revision, objectiveRevision, repository } = product.value;
  if (revision !== input.data.expectedRevision || objectiveRevision !== input.data.expectedObjectiveRevision) return { ok: false, code: "stale_revision" };
  const result = (value: Omit<RunnerConfigPreview, "version" | "productId" | "revision" | "objectiveRevision" | "path">): PreviewResult => ({ ok: true,
    value: { version: RUNNER_CONFIG_PREVIEW_VERSION, productId, revision, objectiveRevision, path: TARGET_RUNNER_CONFIG_PATH, ...value } });
  if (!repository) return result({ state: "repository_missing" });
  const text = options.text ?? ghTextAsync;
  const api = (path: string) => text(["api", path], { maxBuffer: 2 * TARGET_RUNNER_CONFIG_MAX_BYTES, timeout: 20_000 });
  const provider = options.provider ?? ghProductRepositoryProvider(text);
  const slug = `repos/${repository.owner}/${repository.name}`;
  const liveIdentity = async () => {
    const live = await provider.read(repository.owner, repository.name);
    if (live.state === "unreadable") throw new Error("repository identity unreadable");
    return live.state === "found" && live.repository.id === repository.id &&
      live.repository.owner.toLowerCase() === repository.owner.toLowerCase() && live.repository.name.toLowerCase() === repository.name.toLowerCase() &&
      live.repository.defaultBranch === repository.defaultBranch;
  };
  // Both head reads bypass every read cache (broker and in-flight): a cached head would let a moved target keep its proposal.
  const currentHead = async () => commitId.parse(JSON.parse(await text(["api", `${slug}/commits/${encodeURIComponent(repository.defaultBranch)}`],
    { maxBuffer: 2 * TARGET_RUNNER_CONFIG_MAX_BYTES, timeout: 20_000, fresh: true })).sha);
  let head: string;
  let config: TargetRunnerConfig;
  try {
    if (!await liveIdentity()) return result({ state: "repository_conflict" });
    head = await currentHead();
    config = await readTargetRunnerConfig(slug, head, githubRunnerConfigRead(slug, api));
  } catch (error) { return result({ state: "unreadable", reason: String(error).slice(0, 512) }); }
  let proposal: RunnerConfigProposal | undefined;
  if (config.state === "absent") try {
    if (!isAbsolute(options.installRoot)) throw new Error("serving install root unavailable");
    const path = mountsPath(options.installRoot);
    // One descriptor, opened without following a link and without blocking (a FIFO would otherwise wait for a writer),
    // is checked and read: the bytes checked are the bytes compared.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let onDisk: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > TARGET_RUNNER_CONFIG_MAX_BYTES) throw new Error("source is not a bounded regular file");
      onDisk = readFileSync(fd);
    } finally { closeSync(fd); }
    const sourceCommit = commitId.parse((await hostRead(options.installRoot, ["rev-parse", "HEAD"], { maxBuffer: 4096 })).trim());
    const committed = Buffer.from(await hostRead(options.installRoot, ["cat-file", "blob", `${sourceCommit}:${TARGET_RUNNER_CONFIG_PATH}`],
      { maxBuffer: TARGET_RUNNER_CONFIG_MAX_BYTES + 1, encoding: "latin1" }), "latin1");
    if (!onDisk.equals(committed)) throw new Error("source differs from its recorded commit");
    // The maintained entry point (including G-17) over the path now known to be a bounded regular file, then the same
    // validation over the exact committed bytes that are offered.
    loadMounts(path);
    const bytes = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(committed);
    validateMounts(parseYaml(bytes));
    const digest = createHash("sha256").update(committed).digest("hex");
    proposal = { path: TARGET_RUNNER_CONFIG_PATH, bytes, digest, targetHead: head,
      source: { kind: "serving_instance_mounts", commit: sourceCommit }, validation: { valid: true, g17: true },
      changes: [{ operation: "add", path: TARGET_RUNNER_CONFIG_PATH }] };
  } catch (error) { return result({ state: "source_unavailable", head, reason: String(error).slice(0, 512) }); }
  try {
    if (!await liveIdentity()) return result({ state: "repository_conflict" });
    if (await currentHead() !== head) return result({ state: "stale_target", head });
  } catch (error) { return result({ state: "unreadable", head, reason: String(error).slice(0, 512) }); }
  const latest = store.read(actor, productId);
  if (!latest.ok) return { ok: false, code: latest.code };
  if (latest.value.revision !== revision || latest.value.objectiveRevision !== objectiveRevision) return { ok: false, code: "stale_revision" };
  return result({ ...config, ...("reason" in config ? { reason: config.reason.slice(0, 512) } : {}), ...(proposal ? { proposal } : {}) });
}

// ── W1-T11197: an accepted preview reaches the target ONLY as one add-only pull request a human reviews ──────────────

export const RUNNER_CONFIG_PROPOSAL_VERSION = "product-runner-config-proposal-v1" as const;
/** PRIMARY CONTROL: maintained quotas. `contentBytes` keeps the base64 contents field under one argv string's kernel bound. */
export const RUNNER_CONFIG_PROPOSAL_LIMITS = { requestBytes: 4 * 1024, records: 256, stateBytes: 1024 * 1024, contentBytes: 90 * 1024 } as const;
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const revisionNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** The command carries the digest the operator accepted from the preview, never bytes or paths. */
export const runnerConfigProposalCommandSchema = z.object({
  version: z.literal(RUNNER_CONFIG_PROPOSAL_VERSION), requestId: productRequestIdSchema, productId: productIdSchema,
  expectedRevision: revisionNumber, expectedObjectiveRevision: revisionNumber, targetHead: commitId, configDigest: hex64,
}).strict();
export type RunnerConfigPullState = "open" | "merged" | "merged_unreviewed" | "merged_drifted" | "closed_unmerged" | "unknown";
export type RunnerConfigProposalCode = ProductStoreCode | "repository_missing" | "repository_conflict" | "provider_unreadable"
  | "stale_preview" | "runner_config_present" | "runner_config_invalid" | "source_unavailable" | "branch_conflict";
const pullRequestSchema = z.object({ number: z.number().int().positive(), url: z.string().url() }).strict();
const proposalRecordSchema = z.object({
  productId: productIdSchema, objectiveRevision: revisionNumber,
  repository: z.object({ id: revisionNumber, owner: z.string().min(1).max(64), name: z.string().min(1).max(128), defaultBranch: z.string().min(1).max(255) }).strict(),
  targetHead: commitId, configDigest: hex64, sourceCommit: commitId, branch: z.string().min(1).max(255),
  phase: z.enum(["intent", "proposed"]), recordedAt: z.string().datetime(),
  pullRequest: pullRequestSchema.optional(), evidence: z.array(z.number().int().positive()).max(64),
}).strict().refine((value) => (value.phase === "proposed") === (value.pullRequest !== undefined));
type ProposalRecord = z.infer<typeof proposalRecordSchema>;
const proposalJournalSchema = z.object({
  version: z.literal(RUNNER_CONFIG_PROPOSAL_VERSION), ownerKey: hex64,
  records: z.record(hex64, proposalRecordSchema), requests: z.record(hex64, z.object({ key: hex64, payloadDigest: hex64 }).strict()),
}).strict().refine((value) => Object.keys(value.records).length <= RUNNER_CONFIG_PROPOSAL_LIMITS.records);
type ProposalJournal = z.infer<typeof proposalJournalSchema>;
export interface RunnerConfigProposalReply {
  version: typeof RUNNER_CONFIG_PROPOSAL_VERSION; productId: string; state: RunnerConfigPullState; replayed: boolean;
  proposal: { path: string; branch: string; targetHead: string; configDigest: string; sourceCommit: string; pullRequest: { number: number; url: string } };
}
export type RunnerConfigProposalResult = { ok: true; value: RunnerConfigProposalReply; code?: never } | { ok: false; code: RunnerConfigProposalCode; value?: never };
/** The reused product-build review rule: the merged PR whose merge commit is `head`, and whether its latest reviews approve it. */
export type ReviewedMergeRead = (repository: { id: number; owner: string; name: string; defaultBranch: string }, head: string) => Promise<
  { state: "found"; starter: { number: number; reviewed: boolean } } | { state: "absent" } | { state: "unreadable" }>;
export interface RunnerConfigProposalOptions extends RunnerConfigPreviewOptions {
  reviewedMerge: ReviewedMergeRead;
  clock?: Pick<Clock, "iso">;
  sync?: (fd: number) => void;
}
// A refusal raised inside a proposal run and always caught by proposeRunnerConfigBootstrap, which answers its code.
const PROPOSAL_CODE = Symbol("runner-config-proposal-code");
type ProposalFault = Error & { [PROPOSAL_CODE]: RunnerConfigProposalCode };
const proposalFault = (code: RunnerConfigProposalCode): ProposalFault =>
  Object.assign(new Error(`runner config proposal: ${code}`), { [PROPOSAL_CODE]: code });
const proposalCodeOf = (error: unknown): RunnerConfigProposalCode | undefined =>
  error instanceof Error ? (error as Partial<ProposalFault>)[PROPOSAL_CODE] : undefined;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const notFound = (error: unknown) => /\(HTTP 404\)|\bHTTP 404\b/.test(`${String((error as { stderr?: unknown })?.stderr ?? "")}\n${String((error as Error)?.message ?? error)}`);
const proposalChains = new Map<string, Promise<unknown>>();
async function serializedProposal<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = proposalChains.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.catch(() => undefined /* the caller awaits next and receives its failure */);
  proposalChains.set(key, tail);
  try { return await next; } finally { if (proposalChains.get(key) === tail) proposalChains.delete(key); }
}
const previewRefusal: Partial<Record<RunnerConfigPreview["state"], RunnerConfigProposalCode>> = {
  present: "runner_config_present", invalid: "runner_config_invalid", unreadable: "provider_unreadable",
  source_unavailable: "source_unavailable", stale_target: "stale_preview", repository_missing: "repository_missing", repository_conflict: "repository_conflict",
};

/**
 * Turns the digest an operator accepted from {@link previewRunnerConfigBootstrap} into ONE pull request that adds only
 * the runner configuration on its own branch at the exact previewed head. The record is journaled (private, fsynced)
 * BEFORE the first GitHub write, so a lost response reconciles by reading the exact branch, its one-file diff and the PR
 * for that head, never by a second create. It never writes the default branch, merges, approves, changes protection,
 * touches another path or deletes anything as compensation.
 */
export async function proposeRunnerConfigBootstrap(options: RunnerConfigProposalOptions, actor: string, command: unknown): Promise<RunnerConfigProposalResult> {
  try {
    if (typeof actor !== "string" || !actor.trim() || actor.length > 512) throw proposalFault("invalid_identity");
    const parsed = runnerConfigProposalCommandSchema.safeParse(command);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > RUNNER_CONFIG_PROPOSAL_LIMITS.requestBytes) throw proposalFault("invalid_input");
    if (!options.root || !isAbsolute(options.root)) throw proposalFault("unavailable");
    const root = realpathSync(options.root);
    const ownerKey = sha256(actor);
    const directory = join(root, "state", "products", "v1", "runner-config");
    const paths = { root, directory, state: join(directory, `${ownerKey}.json`), locks: join(directory, "locks"), ownerKey };
    return await serializedProposal(ownerKey, async () => {
      ensureProposalDirectory(paths.root, options.sync ?? fsyncSync);
      let lock;
      try { lock = acquireInflightLock(paths.locks, ownerKey, { run_id: `runner-config-proposal-${randomUUID()}` }); }
      catch (error) { throw error instanceof InflightLockError ? proposalFault("busy") : proposalFault("unavailable"); }
      try { return { ok: true as const, value: await new RunnerConfigProposalRun(options, actor, parsed.data, paths).run() }; }
      finally { lock.release(); }
    });
  } catch (error) {
    return { ok: false, code: proposalCodeOf(error) ?? "unavailable" };
  }
}

function ensureProposalDirectory(root: string, sync: (fd: number) => void): void {
  const parts = ["state", "products", "v1", "runner-config"];
  for (const [index, directory] of parts.map((_, at) => join(root, ...parts.slice(0, at + 1))).entries()) {
    const owned = index > 1;
    let created = false;
    if (owned) {
      try { mkdirSync(directory, { mode: 0o700 }); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw proposalFault("unavailable"); }
    } else mkdirSync(directory, { recursive: true });
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (created) fchmodSync(fd, 0o700);
      const info = fstatSync(fd);
      if (!info.isDirectory() || (owned && (info.mode & 0o077) !== 0)) throw proposalFault("unavailable");
    } finally { closeSync(fd); }
    const parent = openSync(dirname(directory), constants.O_RDONLY);
    try { sync(parent); } finally { closeSync(parent); }
  }
}

class RunnerConfigProposalRun {
  private readonly api: (args: string[]) => Promise<string>;
  private readonly sync: (fd: number) => void;
  private readonly store: ProductIntentStore;
  constructor(private readonly options: RunnerConfigProposalOptions, private readonly actor: string,
    private readonly input: z.infer<typeof runnerConfigProposalCommandSchema>,
    private readonly paths: { directory: string; state: string; ownerKey: string }) {
    const text = options.text ?? ghTextAsync;
    this.api = (args) => text(["api", ...args], { maxBuffer: 2 * TARGET_RUNNER_CONFIG_MAX_BYTES, timeout: 20_000 });
    this.sync = options.sync ?? fsyncSync;
    this.store = options.store ?? new ProductIntentStore({ root: options.root });
  }

  async run(): Promise<RunnerConfigProposalReply> {
    const { input } = this;
    let journal = this.readJournal();
    const requestKey = sha256(input.requestId);
    const payloadDigest = sha256(JSON.stringify(input));
    const key = sha256(`${input.productId}\n${input.targetHead}\n${input.configDigest}`);
    const bound = journal.requests[requestKey];
    if (bound && bound.payloadDigest !== payloadDigest) throw proposalFault("idempotency_conflict");
    let record = journal.records[key];
    let bytes: string | undefined;
    if (bound) {
      if (!record) throw proposalFault("corrupt");
      if (record.phase === "proposed") return this.reply(this.ensureEvidence(journal, key, record), await this.pullState(record), true);
    } else {
      const product = this.store.read(this.actor, input.productId);
      if (!product.ok) throw proposalFault(product.code);
      if (product.value.revision !== input.expectedRevision || product.value.objectiveRevision !== input.expectedObjectiveRevision) throw proposalFault("stale_revision");
      if (record?.phase === "proposed") {
        // The same accepted proposal returns the same pull request until a human closes it unmerged.
        const state = await this.pullState(record);
        if (state !== "closed_unmerged") {
          this.persist({ ...journal, requests: { ...journal.requests, [requestKey]: { key, payloadDigest } } });
          return this.reply(record, state, true);
        }
      }
      if (record?.phase !== "intent") {
        // Immediately before acting, recompute the preview: every refusal is decided on live state, never on the request.
        const preview = await previewRunnerConfigBootstrap(this.options, this.actor,
          { productId: input.productId, expectedRevision: input.expectedRevision, expectedObjectiveRevision: input.expectedObjectiveRevision });
        if (!preview.ok) throw proposalFault(preview.code);
        const refusal = previewRefusal[preview.value.state];
        if (refusal) throw proposalFault(refusal);
        const accepted = preview.value.proposal;
        if (!accepted || accepted.digest !== input.configDigest || accepted.targetHead !== input.targetHead) throw proposalFault("stale_preview");
        if (Buffer.byteLength(accepted.bytes) > RUNNER_CONFIG_PROPOSAL_LIMITS.contentBytes) throw proposalFault("source_unavailable");
        const repository = product.value.repository!;
        if (!record && Object.keys(journal.records).length >= RUNNER_CONFIG_PROPOSAL_LIMITS.records) throw proposalFault("capacity");
        bytes = accepted.bytes;
        record = { productId: input.productId, objectiveRevision: input.expectedObjectiveRevision,
          repository: { id: repository.id, owner: repository.owner, name: repository.name, defaultBranch: repository.defaultBranch },
          targetHead: input.targetHead, configDigest: input.configDigest, sourceCommit: accepted.source.commit,
          branch: `remudero/runner-config-${input.targetHead.slice(0, 12)}-${input.configDigest.slice(0, 12)}`,
          phase: "intent", recordedAt: this.clock(), evidence: record?.evidence ?? [] };
      }
      // The durable record exists BEFORE the first GitHub write: a crash or lost response reconciles, never re-creates.
      journal = this.persist({ ...journal, records: { ...journal.records, [key]: record! }, requests: { ...journal.requests, [requestKey]: { key, payloadDigest } } });
    }
    const pullRequest = await this.write(record!, bytes);
    record = { ...record!, phase: "proposed", pullRequest };
    journal = this.persist({ ...journal, records: { ...journal.records, [key]: record } });
    return this.reply(this.ensureEvidence(journal, key, record), "open", false);
  }

  /** The PR exists whatever the product record says; evidence that cannot be recorded now is retried on the next replay. */
  private ensureEvidence(journal: ProposalJournal, key: string, record: ProposalRecord): ProposalRecord {
    const pullRequest = record.pullRequest!;
    if (record.evidence.includes(pullRequest.number) || !this.recordEvidence(record, pullRequest)) return record;
    const next = { ...record, evidence: [...record.evidence, pullRequest.number] };
    this.persist({ ...journal, records: { ...journal.records, [key]: next } });
    return next;
  }

  private clock(): string { return (this.options.clock ?? systemClock).iso(); }

  private reply(record: ProposalRecord, state: RunnerConfigPullState, replayed: boolean): RunnerConfigProposalReply {
    return { version: RUNNER_CONFIG_PROPOSAL_VERSION, productId: record.productId, state, replayed,
      proposal: { path: TARGET_RUNNER_CONFIG_PATH, branch: record.branch, targetHead: record.targetHead, configDigest: record.configDigest,
        sourceCommit: record.sourceCommit, pullRequest: record.pullRequest! } };
  }

  private slug(record: ProposalRecord) { return `repos/${record.repository.owner}/${record.repository.name}`; }

  /** Reads one GitHub object; a 404 is `undefined`, and every other failure is an unknown outcome, never absence. */
  private async read<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    let raw: string;
    try { raw = await this.api([path]); }
    catch (error) { if (notFound(error)) return undefined; throw proposalFault("outcome_unknown"); }
    const parsed = schema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw proposalFault("outcome_unknown");
    return parsed.data;
  }

  /** A write whose response is lost is decided by the read that follows it, never by a retry. */
  private async attempt(args: string[]): Promise<void> {
    // A lost or failed write is decided by the read that follows it, never by this reply.
    try { await this.api(args); } catch { /* decided by the following read */ }
  }

  private async branchFile(record: ProposalRecord, ref: string): Promise<string | undefined> {
    const file = await this.read(`${this.slug(record)}/contents/${TARGET_RUNNER_CONFIG_PATH}?ref=${encodeURIComponent(ref)}`,
      z.object({ type: z.string(), encoding: z.literal("base64"), content: z.string() }).passthrough());
    if (file === undefined) return undefined;
    if (file.type !== "file") throw proposalFault("branch_conflict");
    return sha256(Buffer.from(file.content.replace(/\s/g, ""), "base64"));
  }

  /** The branch may hold only `targetHead` or `targetHead` plus exactly one commit that adds exactly our file. */
  private async branchState(record: ProposalRecord): Promise<"absent" | "base" | "added"> {
    const slug = this.slug(record);
    const ref = await this.read(`${slug}/git/ref/heads/${record.branch}`, z.object({ object: z.object({ sha: commitId }).passthrough() }).passthrough());
    if (ref === undefined) return "absent";
    if (ref.object.sha === record.targetHead) return "base";
    const compare = await this.read(`${slug}/compare/${record.targetHead}...${ref.object.sha}`, z.object({
      status: z.string(), ahead_by: z.number().int(), behind_by: z.number().int(),
      files: z.array(z.object({ filename: z.string(), status: z.string() }).passthrough()).optional(),
    }).passthrough());
    const files = compare?.files ?? [];
    if (!compare || compare.behind_by !== 0 || compare.ahead_by !== 1 || files.length !== 1 ||
      files[0]!.filename !== TARGET_RUNNER_CONFIG_PATH || files[0]!.status !== "added") throw proposalFault("branch_conflict");
    if (await this.branchFile(record, ref.object.sha) !== record.configDigest) throw proposalFault("branch_conflict");
    return "added";
  }

  private async bytesFor(record: ProposalRecord, known: string | undefined): Promise<string> {
    if (known !== undefined) return known;
    const preview = await previewRunnerConfigBootstrap(this.options, this.actor,
      { productId: record.productId, expectedRevision: this.input.expectedRevision, expectedObjectiveRevision: record.objectiveRevision });
    const accepted = preview.ok ? preview.value.proposal : undefined;
    if (!accepted || accepted.digest !== record.configDigest || accepted.targetHead !== record.targetHead) throw proposalFault("outcome_unknown");
    return accepted.bytes;
  }

  private async write(record: ProposalRecord, known: string | undefined): Promise<{ number: number; url: string }> {
    const slug = this.slug(record);
    let state = await this.branchState(record);
    if (state === "absent") {
      await this.attempt(["-X", "POST", `${slug}/git/refs`, "-f", `ref=refs/heads/${record.branch}`, "-f", `sha=${record.targetHead}`]);
      state = await this.branchState(record);
      if (state === "absent") throw proposalFault("outcome_unknown");
    }
    if (state === "base") {
      const bytes = await this.bytesFor(record, known);
      // A contents PUT with NO blob sha: GitHub itself refuses it if the path already exists on the branch.
      await this.attempt(["-X", "PUT", `${slug}/contents/${TARGET_RUNNER_CONFIG_PATH}`,
        "-f", `message=chore(remudero): add runner configuration (${record.configDigest.slice(0, 12)})`,
        "-f", `content=${Buffer.from(bytes, "utf8").toString("base64")}`, "-f", `branch=${record.branch}`]);
      if (await this.branchState(record) !== "added") throw proposalFault("outcome_unknown");
    }
    const owner = record.repository.owner;
    const pulls = z.array(z.object({ number: z.number().int().positive(), html_url: z.string().url(), state: z.string(),
      head: z.object({ ref: z.string() }).passthrough(), base: z.object({ ref: z.string() }).passthrough() }).passthrough());
    const listed = async () => (await this.read(`${slug}/pulls?head=${encodeURIComponent(`${owner}:${record.branch}`)}&state=open&per_page=100`, pulls) ?? [])
      .filter((pull) => pull.head.ref === record.branch && pull.state === "open");
    let open = await listed();
    if (open.some((pull) => pull.base.ref !== record.repository.defaultBranch)) throw proposalFault("branch_conflict");
    if (open.length === 0) {
      await this.attempt(["-X", "POST", `${slug}/pulls`, "-f", `title=chore(remudero): add runner configuration`,
        "-f", `head=${record.branch}`, "-f", `base=${record.repository.defaultBranch}`, "-f", `body=${proposalBody(record)}`]);
      open = await listed();
    }
    if (open.length !== 1 || open[0]!.base.ref !== record.repository.defaultBranch) throw proposalFault("outcome_unknown");
    return { number: open[0]!.number, url: open[0]!.html_url };
  }

  /** open, closed unmerged, or merged; a merge counts only when the reused review rule approves it and its bytes are ours. */
  private async pullState(record: ProposalRecord): Promise<RunnerConfigPullState> {
    try {
      const pull = await this.read(`${this.slug(record)}/pulls/${record.pullRequest!.number}`, z.object({ state: z.string(), merged_at: z.string().nullable(),
        merge_commit_sha: commitId.nullable(), base: z.object({ ref: z.string() }).passthrough() }).passthrough());
      if (pull === undefined) return "unknown";
      if (pull.state === "open") return "open";
      if (pull.merged_at === null || pull.merge_commit_sha === null) return "closed_unmerged";
      if (pull.base.ref !== record.repository.defaultBranch) return "merged_unreviewed";
      const review = await this.options.reviewedMerge(record.repository, pull.merge_commit_sha);
      if (review.state === "unreadable") return "unknown";
      if (review.state !== "found" || review.starter.number !== record.pullRequest!.number || !review.starter.reviewed) return "merged_unreviewed";
      return await this.branchFile(record, pull.merge_commit_sha) === record.configDigest ? "merged" : "merged_drifted";
    } catch (error) {
      if (proposalCodeOf(error)) return "unknown";
      throw error;
    }
  }

  /** One product stage-evidence item per pull request, recorded as `proposed`; a moved objective records nothing. */
  private recordEvidence(record: ProposalRecord, pullRequest: { number: number; url: string }): boolean {
    const latest = this.store.read(this.actor, record.productId);
    if (!latest.ok) return false;
    // A moved objective is a new question: the proposal stands, and no evidence is recorded against it.
    if (latest.value.objectiveRevision !== record.objectiveRevision) return true;
    const id = `runner-config:${sha256(`${record.targetHead}:${record.configDigest}`).slice(0, 32)}:${pullRequest.number}`;
    if (latest.value.stageEvidence.some((item) => item.id === id)) return true;
    const saved = this.store.transition(this.actor, { version: "product-intent-v1", requestId: `prcfg_${sha256(id).slice(0, 64)}`, id: record.productId,
      expectedRevision: latest.value.revision, expectedObjectiveRevision: record.objectiveRevision,
      stageEvidence: [{ id, stage: "repository", outcome: "proposed", objectiveRevision: record.objectiveRevision, observedAt: this.clock(),
        references: [{ label: "Runner configuration pull request", url: pullRequest.url }] }] });
    return saved.ok;
  }

  private readJournal(): ProposalJournal {
    let fd: number | undefined;
    try {
      fd = openSync(this.paths.state, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink > 1 || (info.mode & 0o077) !== 0 || info.size > RUNNER_CONFIG_PROPOSAL_LIMITS.stateBytes) throw proposalFault("unavailable");
      const parsed = proposalJournalSchema.safeParse((() => { try { return JSON.parse(readFileSync(fd!, "utf8")); } catch { /* unparseable bytes fail the schema below as corrupt */ return undefined; } })());
      if (!parsed.success || parsed.data.ownerKey !== this.paths.ownerKey) throw proposalFault("corrupt");
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: RUNNER_CONFIG_PROPOSAL_VERSION, ownerKey: this.paths.ownerKey, records: {}, requests: {} };
      throw proposalCodeOf(error) ? error : proposalFault("unavailable");
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  /** Atomic, fsynced replace. A failure before the rename is `unavailable`; after it, the outcome is unknown. */
  private persist(journal: ProposalJournal): ProposalJournal {
    const body = JSON.stringify(journal);
    if (Buffer.byteLength(body) > RUNNER_CONFIG_PROPOSAL_LIMITS.stateBytes) throw proposalFault("capacity");
    const stage = join(this.paths.directory, `.${this.paths.ownerKey}.${randomUUID()}.pending`);
    let renamed = false;
    try {
      const fd = openSync(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, body, "utf8"); this.sync(fd); } finally { closeSync(fd); }
      renameSync(stage, this.paths.state);
      renamed = true;
      const dir = openSync(this.paths.directory, constants.O_RDONLY);
      try { this.sync(dir); } finally { closeSync(dir); }
      return journal;
    } catch (error) {
      void error;
      if (!renamed) try { unlinkSync(stage); } catch { /* a stage already gone is the outcome wanted */ }
      throw proposalFault(renamed ? "outcome_unknown" : "unavailable");
    }
  }
}

function proposalBody(record: ProposalRecord): string {
  return [
    "Remudero proposes adding its runner configuration to this repository. A human must review and merge this pull request: Remudero never merges it.",
    "",
    `- Path: \`${TARGET_RUNNER_CONFIG_PATH}\` (added; no other file changes)`,
    `- Based on: ${record.targetHead}`,
    `- Source: the serving Remudero instance's own validated mounts table at commit ${record.sourceCommit}`,
    `- sha256: ${record.configDigest}`,
  ].join("\n");
}
