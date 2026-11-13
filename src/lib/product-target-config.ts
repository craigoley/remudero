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
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadMounts, mountsPath, validateMounts } from "./mounts.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";
import { ghTextAsync } from "./github-transport.js";
import { ProductIntentStore } from "./product-intent-store.js";
import { productIdSchema, type ProductStoreCode } from "./product-intent.js";
import { ghProductRepositoryProvider, type ProductRepositoryProvider } from "./product-repository.js";

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
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const revision = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const previewQuery = z.object({ productId: productIdSchema, expectedRevision: revision, expectedObjectiveRevision: revision }).strict();
type PreviewText = typeof ghTextAsync;
export interface RunnerConfigPreviewOptions {
  root?: string;
  installRoot: string;
  store?: ProductIntentStore;
  provider?: Pick<ProductRepositoryProvider, "read">;
  text?: PreviewText;
}
export interface RunnerConfigProposal {
  path: string; bytes: string; digest: string; targetHead: string;
  source: { kind: "serving-instance-mounts"; commit: string };
  validation: { valid: true; g17: true };
  changes: [{ operation: "add"; path: string }];
}
export interface RunnerConfigPreview {
  version: typeof RUNNER_CONFIG_PREVIEW_VERSION; productId: string; revision: number; objectiveRevision: number;
  state: "present" | "absent" | "invalid" | "unreadable" | "source_unavailable";
  path: string; head?: string; digest?: string; reason?: string; proposal?: RunnerConfigProposal;
}
type PreviewResult = { ok: true; value: RunnerConfigPreview; code?: never }
  | { ok: false; code: ProductStoreCode | "repository_missing" | "repository_conflict"; value?: never };

/** Adapt the committed GitHub tree to the existing bounded reader; absence requires a complete tree. */
function githubConfigRead(api: (path: string) => Promise<string>, head: string): TargetGitRead {
  const row = z.object({ mode: z.string().regex(/^[0-7]{6}$/), type: z.enum(["blob", "tree", "commit"]),
    sha, path: z.string(), size: z.number().int().nonnegative().optional() });
  const cache = new Map<string, z.infer<typeof row>[]>();
  return async (_checkout, args) => {
    if (args[0] === "rev-parse") return z.object({ sha }).parse(JSON.parse(await api(`git/commits/${head}`))).sha;
    if (args[0] === "cat-file") {
      const blob = z.object({ encoding: z.literal("base64"), content: z.string() }).parse(JSON.parse(await api(`git/blobs/${args[2]}`)));
      const bytes = Buffer.from(blob.content, "base64");
      if (bytes.length > TARGET_RUNNER_CONFIG_MAX_BYTES) throw new Error("target blob exceeds byte bound");
      return bytes.toString("latin1");
    }
    const path = args.at(-1)!;
    const parts = path.split("/");
    const find = async (tree: string, index: number): Promise<string> => {
      let rows = cache.get(tree);
      if (!rows) {
        const result = z.object({ truncated: z.literal(false), tree: z.array(row) }).parse(JSON.parse(await api(`git/trees/${tree}`)));
        rows = result.tree; cache.set(tree, rows);
      }
      const entry = rows.find(item => item.path === parts[index]);
      if (!entry) return "";
      if (index === parts.length - 1) return `${entry.mode} ${entry.type} ${entry.sha} ${entry.size ?? "-"}\t${path}\0`;
      if (entry.type !== "tree") return "";
      return find(entry.sha, index + 1);
    };
    return find(head, 0);
  };
}

/** Informational only: no store transition, journal, checkout creation or provider mutation. */
export async function previewRunnerConfigBootstrap(options: RunnerConfigPreviewOptions, actor: string, query: unknown): Promise<PreviewResult> {
  if (typeof actor !== "string" || !actor.trim() || actor.length > 512) return { ok: false, code: "invalid_identity" };
  const parsed = previewQuery.safeParse(query);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  const input = parsed.data;
  const store = options.store ?? new ProductIntentStore(options);
  const product = store.read(actor, input.productId);
  if (!product.ok) return { ok: false, code: product.code };
  const { revision, objectiveRevision, repository } = product.value;
  if (revision !== input.expectedRevision || objectiveRevision !== input.expectedObjectiveRevision) return { ok: false, code: "stale_revision" };
  if (!repository) return { ok: false, code: "repository_missing" };
  const base = { version: RUNNER_CONFIG_PREVIEW_VERSION, productId: input.productId, revision, objectiveRevision, path: TARGET_RUNNER_CONFIG_PATH };
  const outcome = (observation: Pick<RunnerConfigPreview, "state" | "head" | "digest" | "reason" | "proposal">): PreviewResult =>
    ({ ok: true, value: { ...base, ...observation } });
  const reason = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 512);
  const text = options.text ?? ghTextAsync;
  const provider = options.provider ?? ghProductRepositoryProvider(text);
  let head: string;
  try {
    const live = await provider.read(repository.owner, repository.name);
    if (live.state !== "found") return outcome({ state: "unreadable", reason: `repository ${live.state}` });
    if (live.repository.id !== repository.id || live.repository.owner.toLowerCase() !== repository.owner.toLowerCase() ||
      live.repository.name.toLowerCase() !== repository.name.toLowerCase() || live.repository.defaultBranch !== repository.defaultBranch)
      return { ok: false, code: "repository_conflict" };
    const api = (path: string) => text(["api", `repos/${repository.owner}/${repository.name}/${path}`],
      { timeout: 20_000, maxBuffer: 2 * TARGET_RUNNER_CONFIG_MAX_BYTES, fresh: true });
    const readHead = async () => z.object({ sha }).parse(JSON.parse(await api(`commits/${encodeURIComponent(repository.defaultBranch)}`))).sha;
    head = await readHead();
    const config = await readTargetRunnerConfig("github", head, githubConfigRead(api, head));
    if (await readHead() !== head) return outcome({ state: "unreadable", head, reason: "the default-branch head moved during preview" });
    if (config.state !== "absent") return outcome({ ...config, ...("reason" in config ? { reason: reason(config.reason) } : {}) });
  } catch (error) {
    return outcome({ state: "unreadable", reason: reason(error) });
  }
  try {
    if (!isAbsolute(options.installRoot)) throw new Error("the serving install root is unavailable");
    const path = mountsPath(options.installRoot);
    if (statSync(path).size > TARGET_RUNNER_CONFIG_MAX_BYTES) throw new Error("source table exceeds byte bound");
    const bytes = readFileSync(path);
    if (bytes.length > TARGET_RUNNER_CONFIG_MAX_BYTES) throw new Error("source table exceeds byte bound");
    loadMounts(path);
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    validateMounts(parseYaml(content));
    const commit = sha.parse((await hostRead(options.installRoot, ["rev-parse", "HEAD"], { maxBuffer: 4096 })).trim());
    const committed = Buffer.from(await hostRead(options.installRoot, ["show", `${commit}:${TARGET_RUNNER_CONFIG_PATH}`],
      { maxBuffer: TARGET_RUNNER_CONFIG_MAX_BYTES + 1, encoding: "latin1" }), "latin1");
    if (!bytes.equals(committed)) throw new Error("source table differs from its recorded commit");
    const current = store.read(actor, input.productId);
    if (!current.ok) return { ok: false, code: current.code };
    if (current.value.revision !== revision || current.value.objectiveRevision !== objectiveRevision) return { ok: false, code: "stale_revision" };
    return outcome({ state: "absent", head, proposal: { path: TARGET_RUNNER_CONFIG_PATH, bytes: content,
      digest: createHash("sha256").update(bytes).digest("hex"), targetHead: head,
      source: { kind: "serving-instance-mounts", commit }, validation: { valid: true, g17: true },
      changes: [{ operation: "add", path: TARGET_RUNNER_CONFIG_PATH }] } });
  } catch (error) {
    return outcome({ state: "source_unavailable", head, reason: reason(error) });
  }
}
