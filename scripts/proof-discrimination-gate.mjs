#!/usr/bin/env node
import { CHECK_PROOF_CHILD_ENTRY, CHECK_PROOF_EXIT, checkProofChildArgv } from "../src/lib/check-proof.ts";
// A proof that passes before and after a PR does not establish the PR's claim.  This gate runs
// the reviewer's own parser/executor at the PR head and its actual merge base before ci-gate can
// report a green aggregate.  `rmd check-proof --base` owns the execution and its `executed_stale`
// verdict; this file owns only pull-request event wiring and the failure presentation.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { bodyWithRecoveredIdentity, readEventPayload, resolveTaskIdentity } from "./acceptance-author-gate.mjs";
import { parseAcceptanceBlock, parseWhitelistedProof, resolvePlanCriteriaAtHead } from "../src/lib/review.ts";
import { buildAffectedSuitesGraph } from "../src/lib/affected-suites.ts";

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
  return { criteria: parseAcceptanceBlock(body), source: BODY_CRITERIA_SOURCE };
}

/** The source {@link criteriaForReview} names when it fell back to the PR body. */
export const BODY_CRITERIA_SOURCE = "PR body Acceptance block";

/**
 * W1-T14627: a body `kind: guard` is exempt only on a PR that names its task. An ops-catalog task's record is out of
 * this job's reach (Actions holds no ops credential), so the body carries the record's guard here and remudero-review,
 * which reads the record, refuses a body guard the record does not declare. A PR naming no task has no record to
 * back a guard, so its body guards are executed like any other criterion. Criteria from the core plan pass unchanged.
 */
export function honouredGuards(criteria, source, taskId) {
  if (source !== BODY_CRITERIA_SOURCE || taskId !== undefined) return criteria;
  return criteria.map((criterion) => {
    if (criterion.kind !== "guard") return criterion;
    const { kind: _guard, ...executed } = criterion;
    return executed;
  });
}

/** Run the public diagnostic command instead of duplicating any proof parsing or execution. */
const CHECK_PROOF_MAX_BUFFER = 16 * 1024 * 1024;
const checkProofSpawnOptions = (root) => ({
  cwd: root,
  // check-proof is a read-only diagnostic against the caller's pinned head/base. Re-syncing a
  // detached PR head against a moving origin/main would replace that question with a refusal.
  env: { ...process.env, RMD_SELF_SYNC_DONE: "1" },
});

export function runCheckProof(proof, mergeBase, { root = REPO_ROOT, spawn = spawnSync } = {}) {
  const result = spawn(process.execPath, checkProofChildArgv(proof, mergeBase), {
    ...checkProofSpawnOptions(root),
    encoding: "utf8",
    maxBuffer: CHECK_PROOF_MAX_BUFFER,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/** W1-T15183: {@link runCheckProof} without blocking, so the gate can run several proofs at once.
 *  Same child, options and result shape; output past the same per-stream buffer ends the child with an error. */
export function runCheckProofAsync(proof, mergeBase, { root = REPO_ROOT, spawnChild = spawn } = {}) {
  return new Promise((resolve) => {
    const out = { stdout: "", stderr: "" };
    let error;
    let settled = false;
    const settle = (status, signal) => {
      if (settled) return;
      settled = true;
      resolve({ status, signal, error, stdout: out.stdout, stderr: out.stderr });
    };
    const child = spawnChild(process.execPath, checkProofChildArgv(proof, mergeBase), checkProofSpawnOptions(root));
    for (const name of ["stdout", "stderr"]) {
      child[name]?.setEncoding("utf8");
      child[name]?.on("data", (chunk) => {
        if (Buffer.byteLength(out[name]) + Buffer.byteLength(chunk) > CHECK_PROOF_MAX_BUFFER) {
          error ??= `${name} maxBuffer length exceeded`;
          child.kill();
          return;
        }
        out[name] += chunk;
      });
    }
    child.on("error", (spawnError) => {
      error ??= spawnError.message;
      if (child.pid === undefined) settle(null, null);
    });
    child.on("close", (status, signal) => settle(error === undefined ? status : null, signal));
  });
}

function proofCounts(stdout) {
  const head = /^hits:\s*(\d+)\s*$/m.exec(stdout)?.[1];
  const base = /^base hits:\s*(\d+)\s*$/m.exec(stdout)?.[1];
  return { head: head ?? "not reported", base: base ?? "not reported" };
}

/** The criteria this gate runs, in criterion order, and the ones it counts without running. */
function planProofDiscrimination(criteria) {
  const plan = { proofs: [], credited: 0, guarded: 0 };
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
      plan.credited += 1;
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
      plan.guarded += 1;
      continue;
    }
    const proof = criterion.proof?.trim() ?? "";
    if (!proof || parseWhitelistedProof(proof) === null) continue;
    plan.proofs.push(proof);
  }
  return plan;
}

/** Judge each planned proof's outcome, in criterion order: the one verdict both evaluators return. */
function judgeProofDiscrimination(plan, results) {
  const stale = [];
  const unreadable = [];
  let executed = 0;
  const countDiscriminated = [];
  // W1-T11157: every proof this gate ran, with its raw outcome, for the published result record.
  const judged = [];
  for (const [index, proof] of plan.proofs.entries()) {
    const result = results[index];
    judged.push({ proof, status: result.status, error: result.error ?? result.signal, stdout: String(result.stdout ?? "") });
    if (result.status === null || result.status === undefined || result.error) {
      unreadable.push({ proof, detail: result.error ?? result.signal ?? "check-proof did not return an exit status" });
      continue;
    }
    executed += 1;
    if (result.status === CHECK_PROOF_EXIT.executedStale) {
      // W1-T5418 — PREVENTED, NOT RETRIED: a `grep:` proof that matches MORE lines at head than at the
      // merge base was made true in more places by this PR, so it discriminates by count. Refusing it
      // only spent a fix round to rewrite a proof that already names what the diff added.
      if (proof.startsWith("grep:")) {
        const { head, base } = proofCounts(result.stdout);
        if (/^\d+$/.test(head) && /^\d+$/.test(base) && Number(head) > Number(base)) {
          countDiscriminated.push({ proof, head, base });
          continue;
        }
      }
      stale.push({ proof, ...proofCounts(result.stdout), output: result.stdout.trim() });
    }
  }
  return { stale, unreadable, executed, credited: plan.credited, guarded: plan.guarded, countDiscriminated, judged };
}

/** Evaluate every executable criterion.  Exit 5 is `check-proof`'s stable, reviewer-owned name
 * for head/base parity.  Other reviewer outcomes are deliberately outside this task's scope. */
export function evaluateProofDiscrimination(criteria, mergeBase, runProof) {
  const plan = planProofDiscrimination(criteria);
  return judgeProofDiscrimination(plan, plan.proofs.map((proof) => runProof(proof, mergeBase)));
}

/** W1-T15183: the pool size, the runner's available parallelism capped at the proof count; one when it cannot be read. */
export function proofPoolSize(proofCount, readParallelism = availableParallelism) {
  let cores;
  try {
    cores = readParallelism();
  } catch {
    // An unreadable core count is not a gate failure: the gate runs one proof at a time, as it did before.
    cores = 1;
  }
  const usable = Number.isInteger(cores) && cores > 0 ? cores : 1;
  return Math.max(1, Math.min(usable, proofCount));
}

/** W1-T15183: {@link evaluateProofDiscrimination} with the proofs run through a pool of `poolSize` at once.
 *  Each proof still runs at head and at the merge base; results are kept by index, so the verdict is the same. */
export async function evaluateProofDiscriminationConcurrently(criteria, mergeBase, runProof, {
  poolSize = proofPoolSize,
} = {}) {
  const plan = planProofDiscrimination(criteria);
  const results = new Array(plan.proofs.length);
  let next = 0;
  const worker = async () => {
    while (next < plan.proofs.length) {
      const index = next;
      next += 1;
      results[index] = await runProof(plan.proofs[index], mergeBase);
    }
  };
  await Promise.all(Array.from({ length: poolSize(plan.proofs.length) }, worker));
  return judgeProofDiscrimination(plan, results);
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

// ── W1-T11157: THE RESULT RECORD A REVIEW MAY READ IN SHADOW ─────────────────────────────────────────────────────────
// The review re-runs every proof this job just ran. This job now publishes what it judged as ONE line of its own log,
// so `rmd review` can compare each hosted outcome with its host run (src/cli/commands/review.ts, review.proof_reuse_shadow).
// Operator trust decision 2026-11-03: the record counts only as this workflow's successful job at that exact head, read
// through the App; the executor is everything this job runs; a reused outcome counts toward no verdict (shadow first).
// The job log, not check-run output, carries it: an Actions job cannot write its own check run's summary without a
// `checks: write` token, and that token would sit beside the PR head's test code this job executes.

/** The workflow whose successful job at a head is the only producer the review accepts. */
export const PROOF_DISCRIMINATION_WORKFLOW = ".github/workflows/proof-discrimination-gate.yml";
/** That workflow's job, as the Actions jobs API names it. */
export const PROOF_DISCRIMINATION_JOB = "proof-discrimination";
/** The log line prefix that carries the record; exactly one such line per job. */
export const RESULT_MARKER = "RMD-PROOF-DISCRIMINATION-RESULT ";
export const RESULT_FORMAT = "rmd-proof-discrimination-result-v1";
/** The record's byte cap (the Checks API's 64 KiB summary cap); a larger record publishes only that it was too large. */
export const RESULT_MAX_BYTES = 64 * 1024;
/** check-proof's stable exit codes by name, as the record reports each proof's verdict. */
export const CHECK_PROOF_VERDICT_NAMES = Object.fromEntries(Object.entries(CHECK_PROOF_EXIT).map(([name, code]) =>
  [code, { pass: "pass", fail: "fail", refused: "refused", noMatch: "no-match", execError: "exec_error", executedStale: "executed_stale" }[name] ?? name]));

const EXECUTOR_ENTRIES = ["scripts/proof-discrimination-gate.mjs", CHECK_PROOF_CHILD_ENTRY];
const EXECUTOR_FILES = ["package.json", "package-lock.json", ".nvmrc", PROOF_DISCRIMINATION_WORKFLOW];
const EXECUTOR_TREES = ["test/setup/"];
/** The affected-suite selector's graph input: tracked code files under these trees (affected-suites.ts TRACKED_CODE_ARGS). */
const GRAPH_TREES = ["src/", "scripts/", "bin/", "test/"];
const GRAPH_CODE_FILE = /\.(?:ts|mts|mjs|js|cjs)$/;

/**
 * THE EXECUTOR SET, called by this gate and by the review alike: the import closure of this script and of the
 * check-proof child it spawns, walked over the affected-suite selector's own graph ({@link buildAffectedSuitesGraph}),
 * plus package.json, package-lock.json, .nvmrc, test/setup/** and this workflow. The walk builds the graph one layer at
 * a time with every tracked code path as a target, so each reached file's edges equal the whole-tree graph's while
 * only the reached files are read. `trackedPaths` is `git ls-files`; `readText(path)` reads one tracked file.
 */
export function proofDiscriminationExecutorSet(trackedPaths, readText) {
  const tracked = new Set(trackedPaths);
  const code = trackedPaths.filter((path) => GRAPH_TREES.some((tree) => path.startsWith(tree)) && GRAPH_CODE_FILE.test(path));
  const aliases = tracked.has("package.json") ? JSON.parse(readText("package.json")).imports ?? {} : {};
  const set = new Set();
  let frontier = EXECUTOR_ENTRIES.filter((path) => tracked.has(path));
  while (frontier.length > 0) {
    for (const path of frontier) set.add(path);
    const graph = buildAffectedSuitesGraph(new Map(frontier.map((path) => [path, readText(path)])), code, aliases);
    frontier = [...new Set(frontier.flatMap((path) => [...(graph.dependencies.get(path) ?? [])]))].filter((path) => !set.has(path));
  }
  for (const path of trackedPaths) if (EXECUTOR_FILES.includes(path) || EXECUTOR_TREES.some((tree) => path.startsWith(tree))) set.add(path);
  return [...set].sort();
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The PR body's digest, as both sides compute it. */
export function bodyDigest(body) {
  return sha256(String(body ?? ""));
}

/** The executor set's digest (each path with its content's sha256, in path order) and the workflow file's own. */
export function proofDiscriminationDigests(trackedPaths, readBytes) {
  const files = proofDiscriminationExecutorSet(trackedPaths, (path) => readBytes(path).toString("utf8"));
  const executor = files.map((path) => `${path}\0${sha256(readBytes(path))}\n`).join("");
  return {
    files,
    executor_digest: sha256(executor),
    workflow_digest: trackedPaths.includes(PROOF_DISCRIMINATION_WORKFLOW) ? sha256(readBytes(PROOF_DISCRIMINATION_WORKFLOW)) : null,
  };
}

/** The tracked paths at `root`, as `git ls-files -z` lists them. */
export function trackedPathsAt(root, git = defaultGit) {
  const result = git(["ls-files", "-z"], root);
  if (result.error || result.status !== 0) throw new Error(`git ls-files failed: ${String(result.stderr ?? result.error?.message ?? "").trim()}`);
  return String(result.stdout ?? "").split("\0").filter(Boolean);
}

/** The executor digests of the checkout at `root`. */
export function executorDigestsAt(root) {
  return proofDiscriminationDigests(trackedPathsAt(root), (path) => readFileSync(join(root, path)));
}

/** The proofs this gate executes for `criteria`, in order: the same filter {@link evaluateProofDiscrimination} applies. */
export function discriminationProofs(criteria) {
  return criteria.filter((criterion) => !criterion.satisfied_by && criterion.kind !== "guard")
    .map((criterion) => criterion.proof?.trim() ?? "")
    .filter((proof) => proof !== "" && parseWhitelistedProof(proof) !== null);
}

/** One judged proof as the record names it: check-proof's head and base outcome lines and its exit verdict. */
export function recordedProofOutcome({ proof, status, error, stdout }) {
  const verdict = typeof status === "number" ? CHECK_PROOF_VERDICT_NAMES[status] ?? `exit ${status}` : "unreadable";
  return {
    proof,
    head: /^verdict:\s+(\S+)/m.exec(stdout)?.[1] ?? "not reported",
    base: /^base:\s+(\S+)/m.exec(stdout)?.[1] ?? "not reported",
    verdict,
    ...(verdict === "unreadable" ? { detail: String(error ?? "check-proof did not return an exit status") } : {}),
  };
}

/** The record for one evaluated head. `executor` is {@link executorDigestsAt}'s result, or `{ error }`. */
export function proofDiscriminationRecord({ headSha, baseSha, body, criteriaSource, executor, judged }) {
  return {
    format: RESULT_FORMAT,
    head_sha: headSha,
    base_sha: baseSha,
    body_digest: bodyDigest(body),
    criteria_source: criteriaSource,
    executor_digest: executor.executor_digest ?? null,
    workflow_digest: executor.workflow_digest ?? null,
    ...(executor.error === undefined ? { executor_files: executor.files.length } : { executor_error: executor.error }),
    proofs: judged.map(recordedProofOutcome),
  };
}

/** The one log line that publishes `record`, or names it too large when it would pass {@link RESULT_MAX_BYTES}. */
export function resultLine(record) {
  const json = JSON.stringify(record);
  const bytes = Buffer.byteLength(json);
  if (bytes <= RESULT_MAX_BYTES) return `${RESULT_MARKER}${json}`;
  return `${RESULT_MARKER}${JSON.stringify({ format: RESULT_FORMAT, head_sha: record.head_sha, too_large: true, bytes })}`;
}

/** W1-T15183: the event, merge base and criteria both entry points judge, or `{ exit }` when the gate refuses first. */
function prepareProofDiscrimination(argv, {
  root = REPO_ROOT,
  readPayload = readEventPayload,
  mergeBase = resolveMergeBase,
  resolveCriteria = criteriaForReview,
  runProof = (proof, base) => runCheckProof(proof, base, { root }),
  baseline = readStaleBaseline,
  log = console,
  executorDigests = executorDigestsAt,
  writeResult = (path, text) => writeFileSync(path, text),
} = {}) {
  const { values } = parseArgs({ args: argv, options: { "event-path": { type: "string" }, "result-path": { type: "string" } } });
  const eventPath = values["event-path"] ?? process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    log.error("proof-discrimination: REFUSED — no event payload path (pass --event-path or set GITHUB_EVENT_PATH)");
    return { exit: 1 };
  }
  const payload = readPayload(eventPath);
  if (!payload.readable) {
    log.error(`proof-discrimination: REFUSED — unreadable event payload: ${payload.reason}`);
    return { exit: 1 };
  }
  const base = mergeBase(payload.baseSha, payload.headSha, { root });
  if (!base.ok) {
    log.error(`proof-discrimination: REFUSED — ${base.message}`);
    return { exit: 1 };
  }
  // W1-T4206: the reviewer's identity surfaces, in its order — the body trailer, then a run-shaped head ref.
  const identity = resolveTaskIdentity({ body: payload.body, headRefName: payload.headRefName });
  const { criteria, source } = resolveCriteria(bodyWithRecoveredIdentity(payload.body, identity), payload.headSha, { root });
  const taskId = identity.taskId;
  return { criteria: honouredGuards(criteria, source, taskId), mergeBase: base.mergeBase, runProof, payload, source,
    taskId, identity, root, baseline, log, executorDigests, writeResult, resultPath: values["result-path"] };
}

/** W1-T15183: the verdict and its log for one evaluated head, the same for both entry points. */
function reportProofDiscrimination({ mergeBase, payload, source, taskId, identity, root, baseline, log,
  executorDigests, writeResult, resultPath }, result) {
  const allowed = staleAllowanceFor(taskId, baseline(root));
  const verdict = judgeStaleAgainstAllowance(result.stale.length, allowed);
  publishResult({ payload, mergeBase, source, judged: result.judged, root, executorDigests, log,
    resultPath, writeResult });
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
    log.error(`proof-discrimination: FAIL — ${result.stale.length} proof(s) pass at both PR head and merge base (${mergeBase}); they cannot establish this PR's work:`);
    for (const row of result.stale) {
      log.error(`  proof: ${row.proof}`);
      log.error(`  head hits: ${row.head}; base hits: ${row.base}`);
      if (row.output) log.error(row.output);
    }
    log.error(
      taskId
        ? `Allowance for ${taskId}: ${verdict.allowed} (scripts/proof-discrimination-baseline.json); this PR carries ${verdict.staleCount}, ${verdict.excess} over. Task identity was read from ${identity.read}.`
        : `No resolvable Remudero-Task trailer (task identity read from ${identity.read}), so no grandfathered allowance applies: a PR authoring its own body criteria has no backlog to inherit.`,
    );
    log.error("Remedy: replace each stale proof with one that names behavior this PR changes, then rerun this check.");
    // #10234: the sweep reads only a failed step's last lines (CI_STEP_ERROR_CONTEXT_LINES), and each proof's output
    // above can run long, so the verdict and its proofs close the log for the stale-proof route to find.
    log.error(`proof-discrimination: FAIL — ${result.stale.length} proof(s) pass at both PR head and merge base (${mergeBase}):`);
    for (const row of result.stale) log.error(`  proof: ${row.proof}`);
    return 1;
  }
  log.log(`proof-discrimination: OK — ${result.executed} executable proof(s) from ${source} did not pass at both head and merge base.`);
  return 0;
}


export function main(argv, deps = {}) {
  const run = prepareProofDiscrimination(argv, deps);
  if (run.exit !== undefined) return run.exit;
  return reportProofDiscrimination(run, evaluateProofDiscrimination(run.criteria, run.mergeBase, run.runProof));
}

/** W1-T15183: the command-line entry. {@link main} with the proofs run concurrently, up to the runner's cores;
 *  the verdict, the published record and the exit codes are {@link main}'s. */
export async function mainConcurrent(argv, deps = {}) {
  const root = deps.root ?? REPO_ROOT;
  const run = prepareProofDiscrimination(argv, { runProof: (proof, base) => runCheckProofAsync(proof, base, { root }), ...deps });
  if (run.exit !== undefined) return run.exit;
  const result = await evaluateProofDiscriminationConcurrently(run.criteria, run.mergeBase, run.runProof,
    { poolSize: deps.poolSize });
  return reportProofDiscrimination(run, result);
}

/** Publish the record as one log line before any verdict line, so a failing job's log still ends in its verdict
 *  (#10234: the sweep reads only the tail). Never changes the exit code: an unreadable executor is named in the record. */
function publishResult({ payload, mergeBase, source, judged, root, executorDigests, log, resultPath, writeResult }) {
  let executor;
  try {
    executor = executorDigests(root);
  } catch (error) {
    executor = { error: String(error?.message ?? error).slice(0, 500) };
  }
  const record = proofDiscriminationRecord({ headSha: payload.headSha, baseSha: mergeBase, body: payload.body,
    criteriaSource: source, executor, judged });
  log.log(resultLine(record));
  if (resultPath) writeResult(resultPath, `${JSON.stringify(record, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  mainConcurrent(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
