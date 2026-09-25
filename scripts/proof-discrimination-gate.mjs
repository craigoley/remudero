#!/usr/bin/env node
// A proof that passes before and after a PR does not establish the PR's claim.  This gate runs
// the reviewer's own parser/executor at the PR head and its actual merge base before ci-gate can
// report a green aggregate.  `rmd check-proof --base` owns the execution and its `executed_stale`
// verdict; this file owns only pull-request event wiring and the failure presentation.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { readEventPayload } from "./acceptance-author-gate.mjs";
import { CHECK_PROOF_EXIT } from "../src/run-task.ts";
import { extractTaskTrailerId, parseAcceptanceBlock, parseWhitelistedProof, resolvePlanCriteriaAtHead } from "../src/lib/review.ts";

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
  let credited = 0;
  let guarded = 0;
  for (const criterion of criteria) {
    // W1-T3729 — A CRITERION THE PLAN CREDITS TO AN EARLIER MERGE IS STALE BY CONSTRUCTION.
    //
    // `satisfied_by` is Architect-only (§12 rule 16) and stands IN PLACE OF a proof: it says the
    // criterion was met by the PR it cites. Such a criterion passes at THIS PR's merge base by
    // definition, so running it can only ever return `executed_stale` — arithmetic, not a finding.
    // MEASURED on #5852: all four of W1-T3693's criteria carry it, and the gate refused 4-over-0
    // while naming two remedies that both fail here (the proofs are correctly pointed, and the
    // baseline it offers says of itself that its allowance never rises).
    //
    // THE FILTER IS THE REVIEWER'S OWN, NOT A SECOND NOTION OF IT: review.ts:3718 already names
    // this set — `executableCriteria = criteria.filter((c) => !c.satisfied_by)` — and review.ts
    // grades these MET without executing anything (2359) and counts them as no hole (2752). This
    // file's header says it runs the reviewer's parser and executor; walking a criterion the
    // reviewer never walks is the divergence, not the fix.
    //
    // COUNTED SEPARATELY, NEVER AS `executed`: `executed` is this gate's evidence that it did
    // work, and a task of entirely-credited criteria must not report a green it did not earn.
    if (criterion.satisfied_by) {
      credited += 1;
      continue;
    }
    // W1-T4419 — A GUARD CRITERION PASSES AT THE MERGE BASE BY DESIGN, SO IT CANNOT DISCRIMINATE.
    //
    // `kind: guard` (plan.ts) marks a criterion whose proof is a REGRESSION guard — it protects an
    // existing behaviour rather than proving a new one, so passing at both head and the merge base
    // is exactly what a correct guard does, not evidence of a non-discriminating proof. Skipping it
    // here is not the same as skipping it in review: review (review.ts) still executes a guard's
    // proof like any other criterion and it must still pass at head — only THIS head-vs-base
    // comparison is exempted.
    //
    // COUNTED SEPARATELY, NEVER AS `executed`, for the same reason `credited` is: a task made
    // entirely of guards is refused at parse time (plan.ts's validateAcceptanceShape), so a mixed
    // task reaching this gate with SOME guards must not be reported as if this gate did no work.
    if (criterion.kind === "guard") {
      guarded += 1;
      continue;
    }
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
  return { stale, unreadable, executed, credited, guarded };
}

/**
 * The grandfathered stale-proof allowance for one task, from `scripts/proof-discrimination-baseline.json`.
 *
 * WHY THIS GATE NEEDS ONE AT ALL, measured on origin/main 2026-09-13: a whole-file `unit test: <path>`
 * proof is stale BY CONSTRUCTION — `check-proof --base` returns exit 5 for it every time, verified by
 * sampling `test/plan.test.ts`, `test/daemon.test.ts` and `test/mounts.test.ts` against a real base
 * (hits 100/820/256, verdict pass, exit 5 in all three). And that shape is the repo's DOMINANT idiom:
 * 5,368 such proofs across 1,214 tasks, roughly 69% of all 7,767 proofs in the plan.
 *
 * So without an allowance this REQUIRED gate refuses the majority of the plan on arrival. That is not
 * the gate being wrong — a proof that passes at the base really cannot establish a PR's work — but a
 * gate that refuses two thirds of its corpus stops being a signal and becomes a wall, and the repo
 * already answers that with a ratchet: `clock-signature-baseline.json`, `comment-load-baseline.json`
 * and `self-path-proof-baseline.json` all grandfather a measured backlog and refuse only GROWTH.
 *
 * The allowance is per TASK, keyed by the id the PR's `Remudero-Task:` trailer names, because that is
 * the unit a shard's criteria belong to. A PR with no resolvable task id gets ZERO allowance: an
 * unfiled PR writes its own body criteria and has no backlog to inherit.
 */
/** Read the grandfather table. A missing or unparseable file means NO allowance — the gate stays strict
 *  rather than silently opening up, which is the fail-closed direction for a required check. */
export function readStaleBaseline(root = REPO_ROOT) {
  try {
    const raw = JSON.parse(readFileSync(join(root, "scripts", "proof-discrimination-baseline.json"), "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(raw)) if (!k.startsWith("_")) out[k] = v;
    return out;
  } catch {
    // Fail closed: an unreadable table grandfathers nothing, so a fault cannot admit a stale proof.
    return {};
  }
}

export function staleAllowanceFor(taskId, baseline) {
  if (!taskId) return 0;
  const recorded = baseline?.[taskId];
  return typeof recorded === "number" && Number.isInteger(recorded) && recorded > 0 ? recorded : 0;
}

/**
 * Pure. Does this PR's stale count sit inside its task's grandfathered allowance?
 *
 * A RATCHET, SO THE COUNT CAN ONLY FALL. Exceeding the allowance is refused, which is what stops a new
 * non-discriminating proof from being added; sitting at or under it passes, which is what stops the
 * measured backlog from blocking every PR that touches those shards. Lower a row in the same change
 * that repoints its proofs; never raise one.
 *
 * NOTE the allowance is counted against ANY stale proof, not only the whole-file shape it was seeded
 * from. A task that also carries a stale `grep:` can therefore still exceed its row — deliberately,
 * since a grep is the cheap one to repoint at the line a diff adds.
 */
export function judgeStaleAgainstAllowance(staleCount, allowed) {
  return { ok: staleCount <= allowed, staleCount, allowed, excess: Math.max(0, staleCount - allowed) };
}

export function main(argv, {
  root = REPO_ROOT,
  readPayload = readEventPayload,
  mergeBase = resolveMergeBase,
  resolveCriteria = criteriaForReview,
  runProof = (proof, base) => runCheckProof(proof, base, { root }),
  baseline = readStaleBaseline,
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
  const taskId = extractTaskTrailerId(payload.body ?? "");
  const allowed = staleAllowanceFor(taskId, baseline(root));
  const verdict = judgeStaleAgainstAllowance(result.stale.length, allowed);
  // W1-T3729 design (ii): SKIPPED IS REPORTED, NEVER SILENT — on every verdict path below, so a
  // reader of a pass and a reader of a refusal both learn the same thing.
  if (result.credited > 0) {
    log.log(
      `proof-discrimination: ${result.credited} criterion(s) credited to a prior merge by \`satisfied_by\` and not executed ` +
        "— review grades these MET without running them (review.ts:2359), so they cannot discriminate this PR's work.",
    );
  }
  if (result.guarded > 0) {
    log.log(
      `proof-discrimination: ${result.guarded} criterion(s) declared \`kind: guard\` and skipped for this head-vs-base ` +
        "comparison — a regression guard passes at the merge base by design; review still executes it and it must pass at head.",
    );
  }
  if (result.unreadable.length > 0) {
    for (const row of result.unreadable) log.error(`proof-discrimination: REFUSED — could not run ${JSON.stringify(row.proof)}: ${row.detail}`);
    return 1;
  }
  if (result.stale.length > 0 && verdict.ok) {
    // INSIDE the grandfathered allowance: reported, never refused. Silence here would hide a backlog
    // that only shrinks if someone can see it.
    log.log(
      `proof-discrimination: OK (grandfathered) — ${verdict.staleCount} stale proof(s) for ${taskId}, ` +
        `within its recorded allowance of ${verdict.allowed}. Repoint them at what this PR changes and ` +
        `lower the row in scripts/proof-discrimination-baseline.json; the allowance never rises.`,
    );
    for (const row of result.stale) log.log(`  stale (allowed): ${row.proof}`);
    return 0;
  }
  if (result.stale.length > 0) {
    log.error(`proof-discrimination: FAIL — ${result.stale.length} proof(s) pass at both PR head and merge base (${base.mergeBase}); they cannot establish this PR's work:`);
    for (const row of result.stale) {
      log.error(`  proof: ${row.proof}`);
      log.error(`  head hits: ${row.head}; base hits: ${row.base}`);
      if (row.output) log.error(row.output);
    }
    log.error(
      taskId
        ? `Allowance for ${taskId}: ${verdict.allowed} (scripts/proof-discrimination-baseline.json); this PR carries ${verdict.staleCount}, ${verdict.excess} over.`
        : "No resolvable Remudero-Task trailer, so no grandfathered allowance applies: a PR authoring its own body criteria has no backlog to inherit.",
    );
    log.error("Remedy: replace each stale proof with one that names behavior this PR changes, then rerun this check.");
    return 1;
  }
  log.log(`proof-discrimination: OK — ${result.executed} executable proof(s) from ${source} did not pass at both head and merge base.`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
