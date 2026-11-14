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
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ghTextAsync } from "./github-transport.js";
import { loadMounts, mountsPath, validateMounts } from "./mounts.js";
import { ProductIntentStore } from "./product-intent-store.js";
import { productIdSchema, type ProductStoreCode } from "./product-intent.js";
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
  const currentHead = async () => commitId.parse(JSON.parse(await api(`${slug}/commits/${encodeURIComponent(repository.defaultBranch)}`)).sha);
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
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > TARGET_RUNNER_CONFIG_MAX_BYTES) throw new Error("source is not a bounded regular file");
    const sourceCommit = commitId.parse((await hostRead(options.installRoot, ["rev-parse", "HEAD"], { maxBuffer: 4096 })).trim());
    const committed = Buffer.from(await hostRead(options.installRoot, ["cat-file", "blob", `${sourceCommit}:${TARGET_RUNNER_CONFIG_PATH}`],
      { maxBuffer: TARGET_RUNNER_CONFIG_MAX_BYTES + 1, encoding: "latin1" }), "latin1");
    loadMounts(path);
    if (!readFileSync(path).equals(committed)) throw new Error("source differs from its recorded commit");
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
