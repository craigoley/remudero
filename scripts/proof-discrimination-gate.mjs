#!/usr/bin/env node
// A proof that passes before and after a PR does not establish the PR's claim.  This gate runs
// the reviewer's own parser/executor at the PR head and its actual merge base before ci-gate can
// report a green aggregate.  `rmd check-proof --base` owns the execution and its `executed_stale`
// verdict; this file owns only pull-request event wiring and the failure presentation.

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { readEventPayload } from "./acceptance-author-gate.mjs";
import { CHECK_PROOF_EXIT } from "../src/run-task.ts";
import { parseAcceptanceBlock, parseWhitelistedProof, resolvePlanCriteriaAtHead } from "../src/lib/review.ts";

function defaultGit(args, root) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

/** Resolve the PR's actual fork point.  The event's base SHA can be newer than that fork point,
 * so passing it straight to `check-proof --base` would falsely reject a proof added by another PR. */
export function resolveMergeBase(baseSha, headSha, { root = REPO_ROOT, git = defaultGit } = {}) {
  if (!baseSha || !headSha) return { ok: false, message: "event payload is missing pull_request.base.sha or pull_request.head.sha" };
  const result = git(["merge-base", baseSha, headSha], root);
  const mergeBase = String(result.stdout ?? "").trim();
  if (result.error || result.status !== 0 || !mergeBase) {
    const detail = String(result.stderr ?? result.error?.message ?? "no merge base returned").trim();
    return { ok: false, message: `could not resolve the PR merge base: ${detail || "git merge-base failed"}` };
  }
  return { ok: true, mergeBase };
}

/** Match the reviewer's trailer-at-head resolver, falling back to the body only when that resolver
 * supplied no criteria.  The event checkout is pinned to `headSha` by the workflow. */
export function criteriaForReview(body, headSha, { root = REPO_ROOT, resolveAtHead = resolvePlanCriteriaAtHead } = {}) {
  const resolved = resolveAtHead(body, root, "plan/tasks.yaml", headSha);
  if (resolved.criteria.length > 0) return { criteria: resolved.criteria, source: resolved.source ?? "task acceptance" };
  return { criteria: parseAcceptanceBlock(body), source: "PR body Acceptance block" };
}

/** Run the public diagnostic command instead of duplicating any proof parsing or execution. */
export function runCheckProof(proof, mergeBase, { root = REPO_ROOT, spawn = spawnSync } = {}) {
  const result = spawn(process.execPath, ["--import", "tsx", "src/run-task.ts", "check-proof", proof, "--base", mergeBase], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function proofCounts(stdout) {
  const head = /^hits:\s*(\d+)\s*$/m.exec(stdout)?.[1];
  const base = /^base hits:\s*(\d+)\s*$/m.exec(stdout)?.[1];
  return { head: head ?? "not reported", base: base ?? "not reported" };
}

/** Evaluate every executable criterion.  Exit 5 is `check-proof`'s stable, reviewer-owned name
 * for head/base parity.  Other reviewer outcomes are deliberately outside this task's scope. */
export function evaluateProofDiscrimination(criteria, mergeBase, runProof) {
  const stale = [];
  const unreadable = [];
  let executed = 0;
  for (const criterion of criteria) {
    const proof = criterion.proof?.trim() ?? "";
    if (!proof || parseWhitelistedProof(proof) === null) continue;
    const result = runProof(proof, mergeBase);
    if (result.status === null || result.status === undefined || result.error) {
      unreadable.push({ proof, detail: result.error ?? result.signal ?? "check-proof did not return an exit status" });
      continue;
    }
    executed += 1;
    if (result.status === CHECK_PROOF_EXIT.executedStale) {
      stale.push({ proof, ...proofCounts(result.stdout), output: result.stdout.trim() });
    }
  }
  return { stale, unreadable, executed };
}

export function main(argv, {
  root = REPO_ROOT,
  readPayload = readEventPayload,
  mergeBase = resolveMergeBase,
  resolveCriteria = criteriaForReview,
  runProof = (proof, base) => runCheckProof(proof, base, { root }),
  log = console,
} = {}) {
  const { values } = parseArgs({ args: argv, options: { "event-path": { type: "string" } } });
  const eventPath = values["event-path"] ?? process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    log.error("proof-discrimination: REFUSED — no event payload path (pass --event-path or set GITHUB_EVENT_PATH)");
    return 1;
  }
  const payload = readPayload(eventPath);
  if (!payload.readable) {
    log.error(`proof-discrimination: REFUSED — unreadable event payload: ${payload.reason}`);
    return 1;
  }
  const base = mergeBase(payload.baseSha, payload.headSha, { root });
  if (!base.ok) {
    log.error(`proof-discrimination: REFUSED — ${base.message}`);
    return 1;
  }
  const { criteria, source } = resolveCriteria(payload.body, payload.headSha, { root });
  const result = evaluateProofDiscrimination(criteria, base.mergeBase, runProof);
  if (result.unreadable.length > 0) {
    for (const row of result.unreadable) log.error(`proof-discrimination: REFUSED — could not run ${JSON.stringify(row.proof)}: ${row.detail}`);
    return 1;
  }
  if (result.stale.length > 0) {
    log.error(`proof-discrimination: FAIL — ${result.stale.length} proof(s) pass at both PR head and merge base (${base.mergeBase}); they cannot establish this PR's work:`);
    for (const row of result.stale) {
      log.error(`  proof: ${row.proof}`);
      log.error(`  head hits: ${row.head}; base hits: ${row.base}`);
      if (row.output) log.error(row.output);
    }
    log.error("Remedy: replace each stale proof with one that names behavior this PR changes, then rerun this check.");
    return 1;
  }
  log.log(`proof-discrimination: OK — ${result.executed} executable proof(s) from ${source} did not pass at both head and merge base.`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
