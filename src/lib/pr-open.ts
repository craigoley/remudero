import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RatifyPrRef } from "./plan-pr-emitter.js";
import { loadPlan, type AcceptanceCriterion } from "./plan.js";
import { extractTaskTrailerId, parseAcceptanceBlock, parseWhitelistedProof } from "./review.js";
import { taskIdFromRunBranch } from "./status.js";

export interface PrOpenOptions {
  head: string;
  title: string;
  bodyFile: string;
  dryRun?: boolean;
}

export interface PrOpenDeps {
  root: string;
  owner: string;
  repo: string;
  git?: (args: string[]) => string;
  gate?: (body: string, head: string, baseSha: string, headSha: string) => Promise<{ ok: boolean; message: string }>;
  checkProof?: (proof: string, base: string) => Promise<{ status: number | null; error?: string }>;
  create?: (options: { head: string; title: string; body: string }) => RatifyPrRef;
}

function gitAt(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

/** The same event-time predicate and resolvers used by acceptance-author-gate. */
async function authorGateAt(root: string, body: string, head: string, baseSha: string, headSha: string) {
  const gate = await import(new URL("../../scripts/acceptance-author-gate.mjs", import.meta.url).href);
  return gate.evaluateGate({
    body,
    headRefName: head,
    trailerResolves: gate.planTrailerResolver(root),
    introducedTaskIds: gate.introducedShardTaskIds({ baseSha, headSha, root }),
    trailerCommits: gate.commitTaskTrailersAtRange({ baseSha, headSha, root }),
    changedPaths: gate.changedPathsAtRange({ baseSha, headSha, root }),
    taskFilesForId: gate.planTaskFilesResolver(root),
    taskAcceptanceForId: gate.planTaskAcceptanceResolver(root),
    rule15Verdict: gate.rule15SplitAtRange({ baseSha, headSha, root }),
  }) as { ok: boolean; message: string };
}

async function checkAtBase(root: string, proof: string, base: string) {
  const gate = await import(new URL("../../scripts/proof-discrimination-gate.mjs", import.meta.url).href);
  return gate.runCheckProof(proof, base, { root }) as { status: number | null; error?: string };
}

/** Prepare, validate, then create a hand-opened PR. No REST write occurs on a refusal or dry run. */
export async function openPullRequestChecked(options: PrOpenOptions, deps: PrOpenDeps): Promise<{ body: string; pr?: RatifyPrRef }> {
  const { root } = deps;
  const git = deps.git ?? ((args: string[]) => gitAt(root, args));
  if (!options.head || !options.title.trim() || !options.bodyFile) throw new Error("pr open: --head, --title and --body-file are required");
  const current = git(["branch", "--show-current"]).trim();
  if (current !== options.head) throw new Error(`pr open: --head ${options.head} is not the current branch (${current})`);
  const bodyOnly = options.head.startsWith("file/") || /^run-unfiled-\d+$/.test(options.head);
  const taskId = bodyOnly ? undefined : taskIdFromRunBranch(options.head);
  if (!taskId && !bodyOnly) throw new Error(`pr open: unsupported head ${options.head}`);

  let body = readFileSync(options.bodyFile, "utf8").trimEnd();
  const existing = extractTaskTrailerId(body);
  let planCriteria: AcceptanceCriterion[] = [];
  if (taskId) {
    if (existing && existing !== taskId) throw new Error(`pr open: body credits ${existing}, but branch credits ${taskId}`);
    const plan = loadPlan(join(root, "plan", "tasks.yaml"));
    const task = plan.byId.get(taskId);
    if (!task) throw new Error(`pr open: ${taskId} is absent from the plan`);
    planCriteria = task.acceptance ?? [];
    if (!existing) body += `${body ? "\n\n" : ""}Remudero-Task: ${taskId}`;
  } else if (existing) {
    throw new Error(`pr open: ${options.head} must use its own Acceptance block, not a task trailer`);
  }

  const ownCriteria = parseAcceptanceBlock(body);
  if (bodyOnly && ownCriteria.length === 0) throw new Error("pr open: this branch needs a parseable Acceptance block");
  const baseSha = git(["rev-parse", "origin/main"]).trim();
  const headSha = git(["rev-parse", "HEAD"]).trim();
  const mergeBase = git(["merge-base", baseSha, headSha]).trim();
  if (!baseSha || !headSha || !mergeBase) throw new Error("pr open: cannot resolve origin/main and HEAD");
  const verdict = await (deps.gate ?? ((b, h, base, tip) => authorGateAt(root, b, h, base, tip)))(body, options.head, baseSha, headSha);
  if (!verdict.ok) throw new Error(`pr open: acceptance-author-gate refused: ${verdict.message}`);

  // The body block is what a body-only PR is reviewed against. A run branch is reviewed against
  // its plan record, even when its body also carries a matching explanatory block.
  const criteria = taskId ? planCriteria : ownCriteria;
  for (const criterion of criteria) {
    if (criterion.satisfied_by) continue;
    const proof = criterion.proof?.trim() ?? "";
    if (parseWhitelistedProof(proof)?.kind !== "grep") continue;
    const result = await (deps.checkProof ?? ((p, b) => checkAtBase(root, p, b)))(proof, mergeBase);
    if (result.status !== 0) {
      const reason = result.status === 5 ? "passes at the origin/main merge base as well as HEAD" : `could not pass uniquely at HEAD (exit ${result.status ?? "unknown"}${result.error ? `: ${result.error}` : ""})`;
      throw new Error(`pr open: proof ${JSON.stringify(proof)} ${reason}`);
    }
  }

  if (options.dryRun) return { body };
  if (!deps.create) throw new Error("pr open: REST create transport is unavailable");
  return { body, pr: deps.create({ head: options.head, title: options.title, body }) };
}
