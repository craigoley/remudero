/** Shadow onboarding evidence and promotion through a reviewed registry PR (W1-T4266). */
import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { RmdError } from "./errors.js";
import { parseInstanceRegistry } from "./instance-registry.js";
import { appendLedger, type LedgerWriterDeps } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { readLedgerUnionRecords } from "./ledger-union.js";
import { LIVE_WRITE_SENTINEL_TOKEN, LiveWriteBlockedError } from "./live-write-guard.js";
import { resolveRepoLayout, type RepoLayout } from "./repo-layout.js";

export class GoLiveError extends RmdError {
  constructor(readonly code: string, readonly status: number, readonly receipt?: GoLiveReceipt | GoLivePartialReceipt) {
    super("registry", 1, code, { code, status });
    this.name = "GoLiveError";
  }
}

export type GoLiveApi = (method: "GET" | "POST" | "PUT", path: string, body?: Record<string, unknown>) => Promise<unknown>;
export type ShadowRowReader = (stateDir: string) => Promise<Array<Record<string, unknown>>>;
export interface RegistryWriteTarget { repository: string; filePath: string }
export interface GoLiveBinding {
  target_digest: string;
  content_digest: string;
  base_sha: string;
  file_sha: string;
  publication_permission: "not-granted";
}
export interface GoLivePartialReceipt {
  status: "proposal_incomplete";
  instance: string;
  branch: string;
  phase: "branch" | "file" | "pr";
  outcome: "unknown";
  confirmed: Array<"branch" | "file">;
  binding: GoLiveBinding;
}
/** Serve's composition-root wiring (`ServeDeps.onboardingGoLive`); defined here so serve depends on this module, not the reverse. */
export type GoLiveWiring = Pick<LedgerWriterDeps, "writeLedger"> & {
  /** The repository owning the fleet registry, rather than the instance's managed repository. */
  registryRepository?: string;
  registryTarget?: RegistryWriteTarget;
  minShadowRuns?: number;
  api?: GoLiveApi;
  readRows?: ShadowRowReader;
};
/** Reuse serve's composition-root wiring and the shared ledger port for request inputs. */
type GoLiveRequestOptions = GoLiveWiring & LedgerWriterDeps &
  Pick<RepoLayout, "stateDir"> & { registryRepository: string };
export type { GoLiveRequestOptions as GoLiveDeps };
export interface GoLiveReceipt {
  status: "review_pending";
  instance: string;
  pr_url: string;
  pr_number: number;
  binding?: GoLiveBinding;
}
export interface ShadowVerdict {
  run_id: string;
  pr_url: string;
  review_verdict: string;
  would: "would_merge" | "would_block";
  reason?: string;
}
export interface ShadowEvidence {
  instance: string;
  runs: number;
  would_merge: number;
  would_block: number;
  cost_usd: number | null;
  unpriced_runs: number;
  verdicts: ShadowVerdict[];
}

export function githubGoLiveApi(opts: { token?: () => string | undefined; fetchImpl?: typeof fetch } = {}): GoLiveApi {
  return async (method, path, body) => {
    const token = (opts.token ?? (() => process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN))();
    if (!token) throw new GoLiveError("github_token_unavailable", 503);
    // REST cannot honor the CLI's PATH-stub exemption: it would still reach real GitHub.
    if (token === LIVE_WRITE_SENTINEL_TOKEN) throw new LiveWriteBlockedError("gh-transport", "onboarding REST request carries the test-runner sentinel");
    const response = await (opts.fetchImpl ?? fetch)(`https://api.github.com/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GoLiveError("github_unavailable", 502);
    return response.json();
  };
}

async function shadowRows(stateDir: string): Promise<Array<Record<string, unknown>>> {
  let incomplete = false;
  try {
    // A missing live corpus is unavailable, never an observation of zero runs.
    await access(join(stateDir, LEDGER_FILENAME));
    const rows = await readLedgerUnionRecords(stateDir, {
      step: ["shadow.verdict", "verdict"],
      onUnreadArchive: () => { incomplete = true; },
      onUnreadLive: () => { incomplete = true; },
      onMalformedRow: () => { incomplete = true; },
    });
    if (incomplete) throw new GoLiveError("shadow_evidence_unavailable", 503);
    return rows;
  } catch (error) {
    if (error instanceof GoLiveError) throw error;
    throw new GoLiveError("shadow_evidence_unavailable", 503);
  }
}

/** Instance-specific state roots are the identity boundary for legacy rows without `instance`. */
export async function readShadowEvidence(stateDir: string, instance: string, readRows: ShadowRowReader = shadowRows): Promise<ShadowEvidence> {
  const verdicts = new Map<string, ShadowVerdict>();
  const costs = new Map<string, number>();
  for (const row of await readRows(stateDir)) {
    if (row.instance !== undefined && row.instance !== instance) continue;
    if (row.step === "shadow.verdict") {
      if (typeof row.run_id !== "string" || !row.run_id || typeof row.pr_url !== "string" ||
        !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(row.pr_url) || typeof row.review_verdict !== "string" ||
        (row.would !== "would_merge" && row.would !== "would_block")) {
        throw new GoLiveError("shadow_evidence_invalid", 503);
      }
      verdicts.set(row.run_id, {
        run_id: row.run_id, pr_url: row.pr_url, review_verdict: row.review_verdict, would: row.would,
        ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
      });
    }
    // Terminal `verdict` rows carry the total, so summing worker-spend rows would double count.
    if (row.step === "verdict" && typeof row.run_id === "string" && typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd) && row.cost_usd >= 0) {
      costs.set(row.run_id, row.cost_usd);
    }
  }
  const runs = [...verdicts.values()];
  const unpriced = runs.filter((row) => !costs.has(row.run_id)).length;
  return {
    instance, runs: runs.length,
    would_merge: runs.filter((row) => row.would === "would_merge").length,
    would_block: runs.filter((row) => row.would === "would_block").length,
    cost_usd: unpriced ? null : runs.reduce((total, row) => total + costs.get(row.run_id)!, 0),
    unpriced_runs: unpriced, verdicts: runs,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GoLiveError("registry_response_invalid", 502);
  return value as Record<string, unknown>;
}
function stringField(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new GoLiveError("registry_response_invalid", 502);
  return value;
}

/** Preserve every registry byte except the target's explicit shadow value, including comments. */
function liveRegistry(text: string, instance: string): string {
  let inInstances = false;
  let current = "";
  let changed = false;
  const content = text.split(/(?<=\n)/).map((line) => {
    if (/^instances:\s*(?:#.*)?\r?\n?$/.test(line)) inInstances = true;
    else if (/^[^\s#]/.test(line)) inInstances = false;
    const name = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?\r?\n?$/.exec(line);
    if (inInstances && name) current = name[1];
    if (inInstances && current === instance && /^ {4}mode:/.test(line)) {
      const next = line.replace(/^( {4}mode:\s*)(?:"shadow"|shadow)(?=\s|$)/, "$1live");
      changed = next !== line;
      return next;
    }
    return line;
  }).join("");
  if (!changed) throw new GoLiveError("registry_invalid", 503);
  return content;
}

type GoLiveInput = { instance: string; actor: string };
interface SelectedRegistry {
  repositoryId: number;
  branch: string;
  baseSha: string;
  fileSha: string;
  mode: string;
  text: string;
  digest: string;
}

function selectedTarget(value: unknown): RegistryWriteTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GoLiveError("registry_target_invalid", 503);
  const { repository, filePath } = value as Record<string, unknown>;
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || typeof filePath !== "string" || filePath.length > 2048 || /[\x00-\x1f\x7f?#\\%:]/.test(filePath)) throw new GoLiveError("registry_target_invalid", 503);
  const parts = filePath.split("/");
  if (parts.length > 16 || parts.some(part => !part || part === "." || part === ".." || part.trim() !== part || part.normalize("NFC") !== part)) throw new GoLiveError("registry_target_invalid", 503);
  return Object.freeze({ repository, filePath });
}

function objectSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new GoLiveError("registry_target_unavailable", 503);
  return value;
}

function selectedRegistryText(text: string): void {
  const fields = new Set(["github_repo", "repo", "project", "retired", "mode", "primary", "host", "state_dir", "container", "role", "port", "worktree"]);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\S/.test(line) && line !== "instances:" && !/^version:\s*1$/.test(line)) throw new GoLiveError("registry_target_unavailable", 503);
    const field = /^ {4}([A-Za-z_]+):/.exec(line);
    if (field && !fields.has(field[1])) throw new GoLiveError("registry_target_unavailable", 503);
  }
  if (text.includes("\0")) throw new GoLiveError("registry_target_unavailable", 503);
}

async function readSelectedRegistry(target: RegistryWriteTarget, api: GoLiveApi): Promise<SelectedRegistry> {
  try {
    const repo = `repos/${target.repository}`, metadata = record(await api("GET", repo));
    const repositoryId = Number(metadata.id);
    if (typeof metadata.id !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId < 1
      || typeof metadata.full_name !== "string" || metadata.full_name.toLowerCase() !== target.repository.toLowerCase()) throw new GoLiveError("registry_target_unavailable", 503);
    const branch = stringField(metadata.default_branch);
    const ref = record(record(await api("GET", `${repo}/git/ref/heads/${encodeURIComponent(branch)}`)).object);
    if (ref.type !== "commit") throw new GoLiveError("registry_target_unavailable", 503);
    const baseSha = objectSha(ref.sha), commit = record(await api("GET", `${repo}/git/commits/${baseSha}`));
    if (objectSha(commit.sha) !== baseSha) throw new GoLiveError("registry_target_unavailable", 503);
    let sha = objectSha(record(commit.tree).sha), mode = "";
    const parts = target.filePath.split("/");
    for (let i = 0; i < parts.length; i++) {
      const tree = record(await api("GET", `${repo}/git/trees/${sha}`));
      if (tree.sha !== sha || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 10000) throw new GoLiveError("registry_target_unavailable", 503);
      const matches = tree.tree.filter(entry => typeof entry === "object" && entry !== null && entry.path === parts[i]);
      if (matches.length !== 1) throw new GoLiveError("registry_target_unavailable", 503);
      const entry = record(matches[0]);
      const leaf = i === parts.length - 1;
      if (leaf ? entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755") : entry.type !== "tree" || entry.mode !== "040000") throw new GoLiveError("registry_target_unavailable", 503);
      sha = objectSha(entry.sha); mode = String(entry.mode);
    }
    const encodedPath = parts.map(encodeURIComponent).join("/"), file = record(await api("GET", `${repo}/contents/${encodedPath}?ref=${baseSha}`));
    if (file.type !== "file" || file.path !== target.filePath || file.sha !== sha || file.encoding !== "base64"
      || typeof file.content !== "string" || file.content.length > 380000) throw new GoLiveError("registry_target_unavailable", 503);
    const encoded = file.content.replace(/[\r\n]/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new GoLiveError("registry_target_unavailable", 503);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length < 1 || bytes.length > 256 * 1024 || file.size !== bytes.length || bytes.toString("base64") !== encoded
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== sha) throw new GoLiveError("registry_target_unavailable", 503);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    selectedRegistryText(text);
    return { repositoryId, branch, baseSha, fileSha: sha, mode, text, digest: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    // Transport, encoding and incomplete identity are unresolved evidence, never legacy fallback.
    throw new GoLiveError("registry_target_unavailable", 503);
  }
}

async function requestSelectedGoLive(input: GoLiveInput, deps: GoLiveRequestOptions, target: RegistryWriteTarget, minimum: number): Promise<GoLiveReceipt> {
  const api = deps.api ?? githubGoLiveApi(), stateDir = deps.stateDir, readRows = deps.readRows, ledgerPath = deps.ledgerPath, writeLedger = deps.writeLedger ?? appendLedger;
  const selected = await readSelectedRegistry(target, api);
  let instance;
  try { instance = parseInstanceRegistry(selected.text).instances.find(row => row.name === input.instance && row.live); }
  catch { throw new GoLiveError("registry_invalid", 503); }
  if (!instance) throw new GoLiveError("instance_not_found", 404);
  if (instance.mode !== "shadow") throw new GoLiveError("instance_not_shadow", 409);
  const evidence = await readShadowEvidence(stateDir, input.instance, readRows);
  if (evidence.runs < minimum) throw new GoLiveError("insufficient_shadow_runs", 409);
  const content = liveRegistry(selected.text, input.instance);
  const current = await readSelectedRegistry(target, api);
  if (current.repositoryId !== selected.repositoryId || current.branch !== selected.branch || current.baseSha !== selected.baseSha
    || current.fileSha !== selected.fileSha || current.mode !== selected.mode || current.digest !== selected.digest) throw new GoLiveError("registry_target_stale", 409);
  const binding: GoLiveBinding = Object.freeze({
    target_digest: createHash("sha256").update(JSON.stringify([target.repository.toLowerCase(), target.filePath, selected.repositoryId, input.instance, instance.repo])).digest("hex"),
    content_digest: selected.digest, base_sha: selected.baseSha, file_sha: selected.fileSha, publication_permission: "not-granted",
  });
  const repo = `repos/${target.repository}`, path = `${repo}/contents/${target.filePath.split("/").map(encodeURIComponent).join("/")}`;
  const branch = `onboarding/go-live-${input.instance}-${randomUUID()}`, title = `feat(onboarding): promote ${input.instance} to live`;
  const confirmed: GoLivePartialReceipt["confirmed"] = [];
  let phase: GoLivePartialReceipt["phase"] = "branch", receipt: GoLiveReceipt;
  try {
    await api("POST", `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: selected.baseSha }); confirmed.push("branch"); phase = "file";
    await api("PUT", path, { message: title, sha: selected.fileSha, content: Buffer.from(content).toString("base64"), branch }); confirmed.push("file"); phase = "pr";
    const pr = record(await api("POST", `${repo}/pulls`, {
      title, head: branch, base: selected.branch,
      body: `Operator ${input.actor} requested go-live for ${input.instance}.\n\nShadow runs: ${evidence.runs}; would merge: ${evidence.would_merge}; would block: ${evidence.would_block}.\n\nReview and merge this registry change to promote the instance.`,
    }));
    const url = `https://github.com/${target.repository}/pull/${pr.number}`;
    if (!Number.isInteger(pr.number) || Number(pr.number) < 1 || pr.html_url !== url) throw new GoLiveError("registry_pr_invalid", 502);
    receipt = { status: "review_pending", instance: input.instance, pr_url: url, pr_number: pr.number as number, binding };
  } catch {
    // A failed response can follow a committed effect. Preserve confirmed stages and unknown intent.
    throw new GoLiveError("go_live_proposal_incomplete", 503, { status: "proposal_incomplete", instance: input.instance, branch, phase, outcome: "unknown", confirmed: [...confirmed], binding });
  }
  try {
    writeLedger(ledgerPath, { run_id: `ONBOARDING-${branch}`, task_id: "PANEL", step: "onboarding.go_live_requested",
      actor: input.actor, origin: input.actor, instance: input.instance, shadow_runs: evidence.runs, pr_url: receipt.pr_url, pr_number: receipt.pr_number, binding });
  } catch { throw new GoLiveError("go_live_audit_failed", 503, receipt); }
  return receipt;
}

/** No registry write on disk and no auto-merge: the operator receives the reviewable PR. */
export async function requestGoLive(input: { instance: string; actor: string }, deps: GoLiveRequestOptions): Promise<GoLiveReceipt> {
  if (!input.actor.trim()) throw new GoLiveError("verified_operator_required", 403);
  const minimum = deps.minShadowRuns ?? 3;
  // Safety policy: at least one actual run, even when the install configures its own threshold.
  if (!Number.isInteger(minimum) || minimum < 1) throw new GoLiveError("invalid_shadow_run_minimum", 503);
  if (deps.registryTarget !== undefined) return requestSelectedGoLive({ instance: input.instance, actor: input.actor }, deps, selectedTarget(deps.registryTarget), minimum);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(deps.registryRepository)) throw new GoLiveError("registry_repository_invalid", 503);
  const api = deps.api ?? githubGoLiveApi();
  const repo = `repos/${deps.registryRepository}`;
  const base = stringField(record(await api("GET", repo)).default_branch);
  const baseSha = stringField(record(record(await api("GET", `${repo}/git/ref/heads/${encodeURIComponent(base)}`)).object).sha);
  const registryPath = join(resolveRepoLayout("", () => undefined).stateDir, "daemon-instances.yaml");
  const path = `${repo}/contents/${registryPath}`;
  const file = record(await api("GET", `${path}?ref=${encodeURIComponent(baseSha)}`));
  if (file.encoding !== "base64") throw new GoLiveError("registry_response_invalid", 502);
  const sha = stringField(file.sha);
  const text = Buffer.from(stringField(file.content), "base64").toString("utf8");
  let instances;
  try { instances = parseInstanceRegistry(text).instances; }
  catch { throw new GoLiveError("registry_invalid", 503); }
  const target = instances.find((row) => row.name === input.instance && row.live);
  if (!target) throw new GoLiveError("instance_not_found", 404);
  if (target.mode !== "shadow") throw new GoLiveError("instance_not_shadow", 409);
  const evidence = await readShadowEvidence(deps.stateDir, input.instance, deps.readRows);
  if (evidence.runs < minimum) throw new GoLiveError("insufficient_shadow_runs", 409);
  const content = liveRegistry(text, input.instance);
  const branch = `onboarding/go-live-${input.instance}-${randomUUID()}`;
  await api("POST", `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  const title = `feat(onboarding): promote ${input.instance} to live`;
  await api("PUT", path, { message: title, sha, content: Buffer.from(content).toString("base64"), branch });
  const pr = record(await api("POST", `${repo}/pulls`, {
    title, head: branch, base,
    body: `Operator ${input.actor} requested go-live for ${input.instance}.\n\nShadow runs: ${evidence.runs}; would merge: ${evidence.would_merge}; would block: ${evidence.would_block}.\n\nReview and merge this registry change to promote the instance.`,
  }));
  const url = `https://github.com/${deps.registryRepository}/pull/${pr.number}`;
  if (!Number.isInteger(pr.number) || Number(pr.number) < 1 || pr.html_url !== url) throw new GoLiveError("registry_pr_invalid", 502);
  const receipt: GoLiveReceipt = { status: "review_pending", instance: input.instance, pr_url: url, pr_number: pr.number as number };
  try {
    (deps.writeLedger ?? appendLedger)(deps.ledgerPath, {
      run_id: `ONBOARDING-${branch}`, task_id: "PANEL", step: "onboarding.go_live_requested",
      actor: input.actor, origin: input.actor, instance: input.instance, repository: target.repo,
      registry_repository: deps.registryRepository, shadow_runs: evidence.runs, pr_url: url, pr_number: receipt.pr_number,
    });
  } catch { throw new GoLiveError("go_live_audit_failed", 503, receipt); }
  return receipt;
}
