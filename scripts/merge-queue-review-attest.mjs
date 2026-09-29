#!/usr/bin/env node
// scripts/merge-queue-review-attest.mjs — report `remudero-review` on a merge-queue group commit.
//
// Branch protection requires the `remudero-review` context, and a merge queue evaluates every
// required context on its own synthetic group commit (`gh-readonly-queue/main/pr-<N>-<sha>`). The
// orchestrator posts that status on a PR's HEAD only, so without this attestation every queued PR
// would wait out `check_response_timeout_minutes` and be ejected. This runs as the job named
// `remudero-review` in .github/workflows/merge-queue-review-attest.yml and passes ONLY when every
// pull request the group commit contains carries a `success` `remudero-review` status on its own
// head sha. It never reviews anything: it attests that the real reviewer already did.
//
// FAIL CLOSED. A group commit the script cannot attribute to a PR, a PR it cannot read, or a group
// resolving to zero PRs all exit non-zero: an attestation that compares nothing must never pass.
// SECURITY: the workflow must trigger on `merge_group` ONLY — a job named `remudero-review` that
// ran (or was skipped) on a PR head would satisfy the requirement with no review at all.
// FALSIFIER: test/merge-queue-review-attest.test.ts pins both the trigger and this behaviour.
//
// Usage: node scripts/merge-queue-review-attest.mjs   (reads GITHUB_EVENT_PATH, GITHUB_REPOSITORY,
// GH_TOKEN and GITHUB_API_URL; exits 0 only when every PR in the group is reviewed)
import { readFileSync } from "node:fs";
import { isMainModule } from "./lib/argv.mjs";

export const REVIEW_CONTEXT = "remudero-review";

/** The PR number GitHub encodes in a queue ref: `refs/heads/gh-readonly-queue/<base>/pr-<N>-<sha>`. */
export function prFromQueueRef(ref) {
  const m = /gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]+$/.exec(String(ref ?? ""));
  return m ? Number(m[1]) : null;
}

/** The `(#N)` suffix a SQUASH queue gives every commit it builds, or null when absent. */
export function prFromSquashSubject(message) {
  const subject = String(message ?? "").split("\n")[0].trim();
  const m = /\(#(\d+)\)$/.exec(subject);
  return m ? Number(m[1]) : null;
}

/** Every PR a group commit contains: the ref's own PR plus the `(#N)` of each commit between the
 *  group's base and head. A commit carrying no `(#N)` is returned in `unattributed`. */
export function groupPullNumbers(mergeGroup, commits) {
  const numbers = new Set();
  const unattributed = [];
  const own = prFromQueueRef(mergeGroup?.head_ref);
  if (own !== null) numbers.add(own);
  for (const c of commits) {
    const n = prFromSquashSubject(c?.commit?.message);
    if (n === null) unattributed.push(c?.sha ?? "?");
    else numbers.add(n);
  }
  return { numbers: [...numbers].sort((a, b) => a - b), unattributed, own };
}

async function getJson(fetchImpl, api, token, path) {
  const res = await fetchImpl(`${api}${path}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

/** Decide the attestation. Returns `{ ok, lines }`; never throws for a verdict, only rethrows as a
 *  failed verdict so the job's conclusion names the unreadable call. */
export async function attest({ event, repo, token, api = "https://api.github.com", fetchImpl = fetch }) {
  const lines = [];
  const mg = event?.merge_group;
  if (!mg?.head_sha || !mg?.base_sha) {
    return { ok: false, lines: ["not a merge_group event (no merge_group.head_sha/base_sha) — refusing to attest"] };
  }
  try {
    const cmp = await getJson(fetchImpl, api, token, `/repos/${repo}/compare/${mg.base_sha}...${mg.head_sha}`);
    const { numbers, unattributed, own } = groupPullNumbers(mg, cmp.commits ?? []);
    if (own === null) lines.push(`head_ref ${mg.head_ref} names no pr-<N>`);
    if (unattributed.length > 0) lines.push(`group commits with no (#N) subject: ${unattributed.join(", ")}`);
    if (numbers.length === 0) lines.push("the group resolves to zero pull requests");
    let reviewed = 0;
    for (const n of numbers) {
      const pr = await getJson(fetchImpl, api, token, `/repos/${repo}/pulls/${n}`);
      const status = await getJson(fetchImpl, api, token, `/repos/${repo}/commits/${pr.head.sha}/status?per_page=100`);
      const state = (status.statuses ?? []).find((s) => s.context === REVIEW_CONTEXT)?.state ?? "absent";
      lines.push(`#${n} head ${pr.head.sha}: ${REVIEW_CONTEXT}=${state}`);
      if (state === "success") reviewed += 1;
    }
    const ok = own !== null && unattributed.length === 0 && numbers.length > 0 && reviewed === numbers.length;
    lines.push(`${reviewed}/${numbers.length} pull request(s) reviewed`);
    return { ok, lines };
  } catch (err) {
    return { ok: false, lines: [...lines, `unreadable: ${err.message} — refusing to attest`] };
  }
}

export async function main({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const { ok, lines } = await attest({
    event,
    repo: env.GITHUB_REPOSITORY,
    token: env.GH_TOKEN,
    api: env.GITHUB_API_URL || "https://api.github.com",
    fetchImpl,
  });
  for (const line of lines) log(line);
  log(ok ? "remudero-review attested for every PR in the group" : "remudero-review NOT attested");
  return ok ? 0 : 1;
}

// diff-cov: process-boundary — direct CLI dispatch only translates main()'s tested return into a
// process exit code; every decision main() itself makes is exercised directly in
// test/merge-queue-review-attest.test.ts via its injectable env/fetchImpl/log seams.
if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
