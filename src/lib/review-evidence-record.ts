import { createHash } from "node:crypto";
import { z } from "zod";
import { mergeTargetFromPrUrl } from "./arm-auto-merge.js";
import { ghJsonAsync, ghTextAsync, type GhJsonReadOptions } from "./github-transport.js";
import { reviewCodeShaFromDescription, REVIEW_CONTEXT, REVIEWER_IDENTITY_ENV, REVIEWER_TOKEN_ENV,
  type CriterionVerdict, type ReviewState } from "./review.js";

const MARKER = "<!-- remudero-review-evidence:v1";
const END = "\n-->";
const FLEET_LOGIN = "remudero-fleet[bot]";
const proofOutcomes = z.enum([
  "executed_pass", "executed_fail", "not_executable", "exec_error", "cannot_evaluate", "inconclusive_load",
  "executed_stale", "base_unreadable", "not_yet_built", "stale_self_path",
]);
const payloadSchema = z.object({
  pr_url: z.string(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  review_input_digest: z.string().regex(/^v2:[a-f0-9]{64}$/),
  state: z.enum(["success", "failure"]),
  reviewer_code_sha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  capped: z.boolean(),
  plan_only: z.boolean(),
  partially_executed: z.boolean(),
  decision_verdict: z.object({
    criteria: z.array(z.object({
      claim: z.string(), proof: z.string(), reason: z.string(), met: z.boolean(),
      proof_exec: proofOutcomes, holdout: z.literal(true).optional(),
    })),
  }),
  unmet_criteria: z.array(z.string()),
  reasons: z.array(z.string()),
});
const envelopeSchema = z.object({ sha256: z.string(), evidence: z.unknown() });
const commentSchema = z.object({
  id: z.number().int().positive(), body: z.string(), created_at: z.string(), updated_at: z.string(),
  user: z.object({ login: z.string(), type: z.enum(["Bot", "User"]) }),
});
const commentPages = z.array(z.array(z.unknown()));
const statusResponseSchema = z.object({
  errors: z.never().optional(),
  data: z.object({ repository: z.object({
    nameWithOwner: z.string(),
    object: z.object({ oid: z.string(), status: z.object({ context: z.object({
      context: z.literal(REVIEW_CONTEXT), state: z.enum(["SUCCESS", "FAILURE"]),
      createdAt: z.string(), description: z.string().nullable(),
      creator: z.object({ login: z.string(), __typename: z.enum(["Bot", "User"]) }),
    }) }) }),
  }) }),
});

type ReviewEvidencePayload = z.infer<typeof payloadSchema>;
type PostedReview = Omit<ReviewEvidencePayload, "state" | "review_input_digest" | "decision_verdict" | "unmet_criteria" | "reasons"> & {
  state: ReviewState;
  review_input_digest?: string;
  decision_verdict: { criteria: readonly CriterionVerdict[] };
  unmet_criteria: readonly string[];
  reasons: readonly string[];
};

const checksum = (evidence: unknown) => createHash("sha256").update(JSON.stringify(evidence)).digest("hex");

export function renderReviewEvidenceRecord(row: PostedReview, catalog?: "public" | "ops"): string {
  const evidence = payloadSchema.parse({
    pr_url: row.pr_url, head_sha: row.head_sha, review_input_digest: row.review_input_digest, state: row.state,
    reviewer_code_sha: row.reviewer_code_sha,
    capped: row.capped, plan_only: row.plan_only, partially_executed: row.partially_executed,
    decision_verdict: { criteria: row.decision_verdict.criteria.map(criterion => ({
      met: criterion.met, proof_exec: criterion.proof_exec,
      claim: criterion.holdout ? "" : criterion.claim,
      proof: criterion.holdout || catalog === "ops" ? "" : criterion.proof,
      reason: criterion.holdout || catalog === "ops" ? "" : criterion.reason,
      ...(criterion.holdout ? { holdout: true } : {}),
    })) },
    unmet_criteria: row.unmet_criteria,
    reasons: catalog === "ops" ? [] : row.reasons,
  });
  const encoded = JSON.stringify({ sha256: checksum(evidence), evidence }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `${MARKER}\n${encoded}${END}`;
}

function parseRecord(body: string): ReviewEvidencePayload | undefined {
  const prefix = MARKER + "\n";
  if (!body.startsWith(prefix) || !body.endsWith(END)) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(body.slice(prefix.length, -END.length));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const envelope = envelopeSchema.safeParse(decoded);
  if (!envelope.success) return undefined;
  const payload = payloadSchema.safeParse(envelope.data.evidence);
  return payload.success && checksum(envelope.data.evidence) === envelope.data.sha256 ? payload.data : undefined;
}

export async function writeReviewEvidenceRecord(row: PostedReview, catalog?: "public" | "ops"): Promise<void> {
  if (row.state === "pending") return;
  if (row.review_input_digest === undefined) {
    throw new Error("cannot write terminal review evidence without the exact review input digest");
  }
  const target = mergeTargetFromPrUrl(row.pr_url);
  if (!target) throw new Error("review evidence needs a GitHub pull request URL");
  const token = process.env[REVIEWER_TOKEN_ENV];
  const env = token ? { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } : undefined;
  await ghTextAsync(["api", "--method", "POST", `repos/${target.owner}/${target.repo}/issues/${target.prNumber}/comments`,
    "-f", `body=${renderReviewEvidenceRecord(row, catalog)}`], { env });
}

interface ExpectedReview {
  prUrl: string;
  headSha: string;
  reviewInputDigest?: string;
  reviewState: ReviewState | "none";
}

export async function readReviewEvidenceRecord(
  expected: ExpectedReview,
  readJson: (args: string[], options: GhJsonReadOptions) => Promise<unknown> =
    (args, options) => ghJsonAsync(args, undefined, undefined, options),
): Promise<{
  row: ReviewEvidencePayload & { context: string; proof_exec: CriterionVerdict["proof_exec"][] };
  commentId: number;
} | undefined> {
  const target = mergeTargetFromPrUrl(expected.prUrl);
  if (!target || !expected.reviewInputDigest || (expected.reviewState !== "success" && expected.reviewState !== "failure")) return undefined;
  const configuredLogin = process.env[REVIEWER_IDENTITY_ENV]?.trim().toLowerCase();
  const login = configuredLogin || FLEET_LOGIN;
  const fetch = (args: string[]) => readJson(args, { fresh: true });
  const pages = commentPages.parse(await fetch(["api",
    `repos/${target.owner}/${target.repo}/issues/${target.prNumber}/comments?per_page=100`, "--paginate", "--slurp"]));
  let newest: z.infer<typeof commentSchema> | undefined;
  for (const raw of pages.flat()) {
    const comment = commentSchema.safeParse(raw);
    if (!comment.success) continue;
    const candidate = comment.data;
    if (candidate.user.login.toLowerCase() !== login || !candidate.body.startsWith(MARKER)) continue;
    if (!newest || candidate.id > newest.id) newest = candidate;
  }
  // A superseding or edited record must never cause an older verdict to be adopted.
  if (!newest || newest.updated_at !== newest.created_at) return undefined;
  const row = parseRecord(newest.body);
  if (!row || row.pr_url !== expected.prUrl || row.head_sha !== expected.headSha ||
      row.review_input_digest !== expected.reviewInputDigest || row.state !== expected.reviewState) return undefined;

  const query = `query($owner:String!,$name:String!,$sha:GitObjectID!){
    repository(owner:$owner,name:$name){nameWithOwner object(oid:$sha){... on Commit{
      oid status{context(name:"${REVIEW_CONTEXT}"){context state createdAt description creator{login __typename}}}
    }}}
  }`;
  const response = statusResponseSchema.safeParse(await fetch(["api", "graphql", "-f", `query=${query}`,
    "-f", `owner=${target.owner}`, "-f", `name=${target.repo}`, "-f", `sha=${expected.headSha}`]));
  if (!response.success) return undefined;
  const repository = response.data.data.repository;
  if (repository.nameWithOwner.toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase() ||
      repository.object.oid !== expected.headSha) return undefined;
  const entry = repository.object.status.context;
  const actor = entry.creator;
  const posterLogin = actor.__typename === "Bot" && /^[a-z0-9-]+$/i.test(actor.login) ? `${actor.login}[bot]` : actor.login;
  if (entry.state.toLowerCase() !== row.state || posterLogin.toLowerCase() !== login || actor.__typename !== newest.user.type ||
      row.reviewer_code_sha !== reviewCodeShaFromDescription(entry.description ?? undefined) ||
      !(Date.parse(newest.created_at) >= Date.parse(entry.createdAt))) return undefined;

  return { row: { ...row, context: REVIEW_CONTEXT, proof_exec: row.decision_verdict.criteria.map(criterion => criterion.proof_exec) },
    commentId: newest.id };
}
