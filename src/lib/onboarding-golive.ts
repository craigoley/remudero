/** Shadow onboarding evidence and promotion through a reviewed registry PR (W1-T4266). */
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { parseInstanceRegistry } from "./instance-registry.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { readLedgerUnionRecords } from "./ledger-union.js";
import { LIVE_WRITE_SENTINEL_TOKEN, LiveWriteBlockedError } from "./live-write-guard.js";

export class GoLiveError extends Error {
  constructor(readonly code: string, readonly status: number, readonly receipt?: GoLiveReceipt) {
    super(code);
    this.name = "GoLiveError";
  }
}

export type GoLiveApi = (method: "GET" | "POST" | "PUT", path: string, body?: Record<string, unknown>) => Promise<unknown>;
export type ShadowRowReader = (stateDir: string) => Promise<Array<Record<string, unknown>>>;
export interface GoLiveDeps {
  /** The repository owning the fleet registry, rather than the instance's managed repository. */
  registryRepository: string;
  stateDir: string;
  ledgerPath: string;
  minShadowRuns?: number;
  api?: GoLiveApi;
  readRows?: ShadowRowReader;
  writeLedger?: (path: string, line: LedgerLine) => void;
}
export interface GoLiveReceipt {
  status: "review_pending";
  instance: string;
  pr_url: string;
  pr_number: number;
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

/** No registry write on disk and no auto-merge: the operator receives the reviewable PR. */
export async function requestGoLive(input: { instance: string; actor: string }, deps: GoLiveDeps): Promise<GoLiveReceipt> {
  if (!input.actor.trim()) throw new GoLiveError("verified_operator_required", 403);
  const minimum = deps.minShadowRuns ?? 3;
  // Safety policy: at least one actual run, even when the install configures its own threshold.
  if (!Number.isInteger(minimum) || minimum < 1) throw new GoLiveError("invalid_shadow_run_minimum", 503);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(deps.registryRepository)) throw new GoLiveError("registry_repository_invalid", 503);
  const api = deps.api ?? githubGoLiveApi();
  const repo = `repos/${deps.registryRepository}`;
  const base = stringField(record(await api("GET", repo)).default_branch);
  const baseSha = stringField(record(record(await api("GET", `${repo}/git/ref/heads/${encodeURIComponent(base)}`)).object).sha);
  const path = `${repo}/contents/.remudero/daemon-instances.yaml`;
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
