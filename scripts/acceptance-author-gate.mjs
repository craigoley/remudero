#!/usr/bin/env node
// scripts/acceptance-author-gate.mjs
//
// AUTHOR-TIME ACCEPTANCE GATE, run as a STANDALONE CI job off the `pull_request` EVENT PAYLOAD
// (W1-T1060). W1-T952 shipped `acceptanceAuthorTimeCheck` (src/lib/review.ts) — the SAME
// no-header/no-trailer/unparseable/empty-proofs predicate `remudero-review` already judges a body
// against — but every call site that reaches it runs AFTER a full CI cycle, and a posted review
// verdict binds to its head sha (the post-review rung fires only at `reviewState === "none"`), so
// repairing a defective body today buys nothing: the remedy is a NEW HEAD plus a fresh CI cycle.
// This script closes that gap for the two PR-authoring paths `PR_AUTHORING_PATHS` (review.ts)
// records as `reachable: false` for an IN-REPO check — a human or agent running `gh pr create`/the
// REST endpoint, or an MCP client, directly — by running the SAME predicate at the ONE place both
// paths must still pass through: CI.
//
// NO API CALL. `on: pull_request` already carries the PR body + author login in the event
// payload (readable at `GITHUB_EVENT_PATH`, no REST/GraphQL round trip), which is what keeps this
// gate working in exactly the window a busy fleet exhausts the GitHub API.
//
// REUSES `acceptanceAuthorTimeCheck`, never a second predicate — this file adds a CALLER, not a
// second implementation of the parsing/diagnosis logic that lives in src/lib/review.ts.
//
// THE ONE EXEMPTION THIS SCRIPT ADDS on top of `acceptanceAuthorTimeCheck` itself: a
// `dependabot[bot]`-authored PR. Measured against the recently merged population, the only
// bodies that would otherwise fail this gate were two dependency bumps opened by dependabot and
// one hand-opened plan renumber — and the dep-review lane (src/run-task.ts's `armAutoMerge`)
// already owns arming those PRs on its own rules, so a gate that refuses every dependency bump is
// one the fleet learns to ignore within a day. The author login rides in the same event payload
// this script already reads, so the exemption costs no extra call.
//
// FAILS LOUD ON AN UNREADABLE PAYLOAD. A missing event file, invalid JSON, a payload with no
// `pull_request` object (not a pull_request event, or a corrupt payload), or a `pull_request.body`
// that is neither a string nor `null` REFUSES rather than passing — treating an unreadable input
// as clean is the vacuous-pass family this repo has already paid for repeatedly.
//
// Usage (CI): node --import tsx scripts/acceptance-author-gate.mjs
//   (reads $GITHUB_EVENT_PATH, set automatically by GitHub Actions on every `pull_request` run)
// Usage (local/test): node --import tsx scripts/acceptance-author-gate.mjs --event-path <path>
//
// Exit 0 ⇒ the body (or the trailer, or the bot exemption) is judgeable. Exit 1 ⇒ refused, with
// the defect and message (from `acceptanceAuthorTimeCheck`/`acceptanceBlockDiagnostics`, verbatim
// — design item (ii), W1-T1060) printed to stderr.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import {
  acceptanceAuthorTimeCheck,
  extractTaskTrailerId,
  explainGrepProofRefusal,
  explainUnitTestProofRefusal,
  filingSelfCreditCheck,
  parseAcceptanceBlock,
  parseWhitelistedProof,
  wrappedGrepPattern,
} from "../src/lib/review.ts";
import { rule15SplitViolation } from "../src/lib/ci-parity.ts";
import { loadPlan } from "../src/lib/plan.ts";
import { isInPlanScope } from "../src/lib/plan-scope.ts";
import { lintTask } from "../src/lib/task-linter.ts";
import { taskIdFromRunBranch } from "../src/lib/status.ts";
import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "./lib/repo-root.mjs";

/**
 * Bot authors exempt from this gate — see the module comment's "THE ONE EXEMPTION" section.
 * Narrow and explicit (not every `*[bot]` login): the measured population names only
 * `dependabot[bot]`, and the dep-review lane's own skip check (src/run-task.ts's `armAutoMerge`)
 * is scoped just as narrowly, by head ref rather than login — widening this set is a deliberate,
 * separately-measured change, not a default.
 */
export const EXEMPT_BOT_LOGINS = new Set(["dependabot[bot]"]);

/**
 * Read a `pull_request` event payload from disk and pull out exactly what this gate needs: the PR
 * body and the author's login. Never throws — an unreadable/malformed/wrong-shaped payload comes
 * back as `{ readable: false, reason }` so the caller can REFUSE rather than treat "I don't know"
 * as clean.
 * @param {string} eventPath
 */
export function readEventPayload(eventPath) {
  let raw;
  try {
    raw = readFileSync(eventPath, "utf8");
  } catch (err) {
    return { readable: false, reason: `cannot read event payload at ${eventPath}: ${err.message}` };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { readable: false, reason: `event payload at ${eventPath} is not valid JSON: ${err.message}` };
  }
  const pr = json && typeof json === "object" ? json.pull_request : undefined;
  if (pr === undefined || pr === null || typeof pr !== "object") {
    return {
      readable: false,
      reason: `event payload at ${eventPath} has no "pull_request" object — not a pull_request event, or a corrupt payload`,
    };
  }
  if (typeof pr.body !== "string" && pr.body !== null && pr.body !== undefined) {
    return {
      readable: false,
      reason: `event payload's pull_request.body at ${eventPath} is neither a string nor null (got ${typeof pr.body})`,
    };
  }
  const authorLogin = typeof pr.user?.login === "string" ? pr.user.login : undefined;
  // W1-T3231: the two shas the self-credit check needs. OPTIONAL by design — a payload without
  // them (an older event shape, a hand-built fixture) leaves that check unable to see the diff,
  // which it treats as "nothing to refuse". Their absence never makes the payload unreadable,
  // because the checks this gate already runs do not need them.
  const baseSha = typeof pr.base?.sha === "string" ? pr.base.sha : undefined;
  const headSha = typeof pr.head?.sha === "string" ? pr.head.sha : undefined;
  const headRefName = typeof pr.head?.ref === "string" ? pr.head.ref : undefined;
  return { readable: true, body: typeof pr.body === "string" ? pr.body : "", authorLogin, baseSha, headSha, headRefName };
}

/**
 * W1-T3231 — the task ids whose PLAN RECORD this diff INTRODUCES.
 *
 * A shard file ADDED under `plan/tasks.d/` between the two shas, read for the `- id:` lines it
 * declares. Same line-scan surface as {@link declaredPlanTaskIds}, and for the same reason: this
 * must answer on a tree it may not be able to parse.
 *
 * NO API CALL, which is the property W1-T1060 built this gate for — `base.sha` and `head.sha` ride
 * in the event payload the gate already reads, and the rest is local git. The job's checkout needs
 * `fetch-depth: 0` for those shas to be present; without it the `git diff` fails and this returns
 * `[]`.
 *
 * FAILS OPEN, ALWAYS. Missing shas, a shallow clone, a git that errors, a shard that reads back
 * empty — every one returns `[]`, which the caller reads as "this diff introduces no task record".
 * A gate that refuses when it cannot see is the vacuous-refusal mirror of the vacuous pass, and
 * this one runs on every PR.
 *
 * KNOWN LIMITATION: a task filed by appending to the `plan/tasks.yaml` MONOLITH is a MODIFICATION,
 * not an addition, and is not seen here. Every filing in the measured session used a shard, and
 * `rule15-filing` pushes filings toward shards; widening to an id-set delta over the monolith is a
 * separate, larger change.
 *
 * @param {{ baseSha?: string, headSha?: string, root?: string, git?: (args: string[]) => string }} opts
 * @returns {string[]}
 */
export function introducedShardTaskIds({ baseSha, headSha, root = REPO_ROOT, git } = {}) {
  if (!baseSha || !headSha) return [];
  const run =
    git ??
    ((args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  let nameStatus;
  try {
    nameStatus = run(["diff", "--name-status", "--diff-filter=A", `${baseSha}...${headSha}`, "--", "plan/tasks.d"]);
  } catch {
    return []; // shallow clone, unknown sha, no git — fail OPEN
  }
  const ids = [];
  for (const line of String(nameStatus).split("\n")) {
    const path = line.trim().split(/\s+/).slice(1).join(" ");
    if (!path.endsWith(".yaml")) continue;
    let text;
    try {
      text = run(["show", `${headSha}:${path}`]);
    } catch {
      continue; // one unreadable shard costs that shard, never the whole read
    }
    for (const m of String(text).matchAll(/^\s*- id:\s*([A-Za-z0-9-]+)\s*$/gm)) ids.push(m[1]);
  }
  return ids;
}

/**
 * Every changed path in the pull request's merge-base range, or `undefined` when local git cannot
 * supply that evidence. An empty set is also non-evidence: it must not manufacture a refusal.
 * @param {{ baseSha?: string, headSha?: string, root?: string, git?: (args: string[]) => string }} opts
 * @returns {string[] | undefined}
 */
export function changedPathsAtRange({ baseSha, headSha, root = REPO_ROOT, git } = {}) {
  if (!baseSha || !headSha) return undefined;
  const run =
    git ??
    ((args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  try {
    const output = run(["diff", "--name-only", "-z", "--no-renames", `${baseSha}...${headSha}`]);
    return [...new Set(String(output).split("\0").filter(Boolean))];
  } catch {
    return undefined;
  }
}

/**
 * Standing rule 15's shared author-time verdict for the pull request's merge-base diff.
 *
 * The pre-push hook and `rmd preflight` already call `rule15SplitViolation`; this required,
 * event-driven check must use that same predicate so a worker cannot reach semantic review with a
 * known mixed criterion-and-implementation diff merely because its local hook was unavailable.
 *
 * Missing SHAs or an unreadable local range preserve the gate's prior behaviour (`undefined`),
 * rather than manufacturing a refusal from absent evidence. The workflow checks out full history,
 * so a normal pull_request event supplies both SHAs and the diff without a GitHub API call.
 *
 * @param {{ baseSha?: string, headSha?: string, root?: string, git?: (args: string[]) => string }} opts
 * @returns {import("../src/lib/ci-parity.ts").Rule15SplitVerdict | undefined}
 */
export function rule15SplitAtRange({ baseSha, headSha, root = REPO_ROOT, git } = {}) {
  if (!baseSha || !headSha) return undefined;
  const run =
    git ??
    ((args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  try {
    return rule15SplitViolation(String(run(["diff", "--no-ext-diff", `${baseSha}...${headSha}`])));
  } catch {
    return undefined;
  }
}

/** A task trailer found in one commit reachable from a pull request head. */
export function commitTaskTrailersAtRange({ baseSha, headSha, root = REPO_ROOT, git } = {}) {
  if (!baseSha || !headSha) return undefined;
  const run =
    git ??
    ((args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  let output;
  try {
    // Commit messages cannot contain NUL, so this is a structural record format rather than a
    // line-oriented parse of third-party text. `-z` supplies the record separator; without it,
    // git inserts a newline between formatted commits and shifts the next record's sha into the
    // preceding body field. `%B` deliberately sees trailers on FOLLOW-UP commits, not only the
    // pull request body or its tip commit (W1-T3414).
    // Two dots deliberately select only commits reachable from the PR head and not its base.
    // Triple-dot would also scan base-only commits after a branch fell behind main, turning an
    // unrelated main trailer into a refusal on this PR.
    output = run(["log", "-z", "--format=%H%x00%s%x00%B", `${baseSha}..${headSha}`]);
  } catch {
    return undefined;
  }
  const fields = String(output).split("\0");
  const trailers = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [sha, subject, body] = fields.slice(index, index + 3);
    if (!sha) continue;
    const seen = new Set();
    for (const match of body.matchAll(/^Remudero-Task:[ \t]*([A-Za-z0-9-]+)[ \t]*$/gm)) {
      const taskId = match[1];
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      trailers.push({ sha, subject, taskId });
    }
  }
  return trailers;
}

export { REPO_ROOT };

/**
 * Every task id the plan DECLARES, across `plan/tasks.yaml` and every `plan/tasks.d/*.yaml` shard.
 *
 * FAILS OPEN, AND THAT IS THE WHOLE CONTRACT. `undefined` means "this gate could not read the
 * plan", which is different from an empty set: an empty set resolves NOTHING and would make the
 * gate start refusing every trailer-bearing body it accepts today. Any read failure — a missing
 * directory, an unreadable file, a torn shard — returns `undefined` and the caller passes NO
 * resolver, which is `acceptanceAuthorTimeCheck`'s documented today-behaviour-byte-for-byte path.
 *
 * A LINE SCAN, NOT `loadPlan`. This gate must answer "does the plan declare this id" on a tree it
 * may not be able to parse; `loadPlan` refuses a plan with a duplicate id outright, and a gate
 * that inherits that refusal would go red on a defect that has nothing to do with the body it is
 * judging. The `- id:` line is the same surface `rmd next-task-id` scans for the same reason.
 *
 * @param {string} root
 * @returns {Set<string> | undefined}
 */
export function declaredPlanTaskIds(root = REPO_ROOT) {
  const ids = new Set();
  try {
    const shardDir = join(root, "plan", "tasks.d");
    const files = [join(root, "plan", "tasks.yaml"), ...readdirSync(shardDir).filter((f) => f.endsWith(".yaml")).map((f) => join(shardDir, f))];
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(/^\s*- id:\s*([A-Za-z0-9-]+)\s*$/gm)) ids.add(m[1]);
    }
  } catch {
    return undefined; // unreadable plan — fail OPEN, never a set that resolves nothing
  }
  return ids.size > 0 ? ids : undefined; // a plan that declares nothing is unreadable in every sense that matters here
}

/**
 * The `trailerResolves` predicate `acceptanceAuthorTimeCheck` takes, or `undefined` when the plan
 * could not be read — omission is the signal, never a resolver that answers false for everything.
 * @param {string} root
 * @returns {((taskId: string) => boolean) | undefined}
 */
export function planTrailerResolver(root = REPO_ROOT) {
  const ids = declaredPlanTaskIds(root);
  return ids === undefined ? undefined : (taskId) => ids.has(taskId);
}

/**
 * Read declared task files from the checked-out plan. Unlike the trailer resolver's deliberately
 * permissive line scan, this needs the plan schema's authoritative `files:` array; a bad plan
 * supplies no structural evidence and therefore no additional refusal.
 * @param {string} root
 * @returns {((taskId: string) => readonly string[] | undefined) | undefined}
 */
export function planTaskFilesResolver(root = REPO_ROOT) {
  try {
    const plan = loadPlan(join(root, "plan", "tasks.yaml"));
    return (taskId) => plan.byId.get(taskId)?.files;
  } catch {
    return undefined;
  }
}

/**
 * W1-T3149's additional author-time refusal. It applies only when the local range proves this is
 * a plan-only diff and the trailered task itself declares implementation paths.
 * @param {{ body: string, changedPaths?: readonly string[], taskFilesForId?: (taskId: string) => readonly string[] | undefined }} input
 */
export function planOnlyImplementationTrailerRefusal({ body, changedPaths, taskFilesForId }) {
  if (changedPaths === undefined || changedPaths.length === 0 || taskFilesForId === undefined) return undefined;
  const taskId = extractTaskTrailerId(body);
  if (taskId === undefined || !changedPaths.every(isInPlanScope)) return undefined;
  let declaredFiles;
  try {
    declaredFiles = taskFilesForId(taskId);
  } catch {
    return undefined;
  }
  const nonPlanFiles = Array.isArray(declaredFiles) ? declaredFiles.filter((path) => !isInPlanScope(path)) : [];
  if (nonPlanFiles.length === 0) return undefined;
  return {
    ok: false,
    defect: "plan-only-implementation-trailer",
    message:
      `Remudero-Task: ${taskId} resolves to non-plan file(s): ${nonPlanFiles.join(", ")}. ` +
      `This pull request changes only plan-scope path(s), so it cannot implement ${taskId}. ` +
      "Remove the trailer and author this PR's own ## Acceptance block, or include the implementation changes.",
  };
}

/**
 * Read declared ACCEPTANCE CRITERIA from the checked-out plan — the proof-comparison sibling of
 * {@link planTaskFilesResolver}. Same authoritative/fail-closed contract: a bad plan (or a task
 * with no `acceptance:` of its own) supplies no structural evidence and therefore no additional
 * refusal, never a resolver that answers "nothing" for everything.
 * @param {string} root
 * @returns {((taskId: string) => readonly { claim: string, proof: string }[] | undefined) | undefined}
 */
export function planTaskAcceptanceResolver(root = REPO_ROOT) {
  try {
    const plan = loadPlan(join(root, "plan", "tasks.yaml"));
    return (taskId) => plan.byId.get(taskId)?.acceptance;
  } catch {
    return undefined;
  }
}

/**
 * W1-T3658 — DOES THIS PULL REQUEST'S OWN `## Acceptance` BLOCK NAME DIFFERENT PROOFS THAN THE
 * TASK IT CREDITS?
 *
 * CONSOLE-T12 shipped and merged carrying BOTH a `Remudero-Task:` trailer (the shape review
 * resolves criteria from) AND its own body-level `## Acceptance` block naming four proofs — unit
 * tests that did not exist. Review judged the trailer's shard; a human reading the PR read the
 * body's block; nothing compared the two, so the mismatch shipped.
 *
 * NOT A BAN ON EITHER SHAPE (the task's rationale). A body-only PR (no trailer) and a
 * trailer-only PR (no body block) are BOTH unaffected — this returns `undefined` for either, the
 * same "nothing to compare" contract every structural predicate in this file keeps.
 *
 * COMPARES THE PROOF TEXT ITSELF, NEVER A COUNT (the task's own falsifier: two proof sets of
 * equal size naming entirely different tests must still refuse). Proofs are compared as sets of
 * trimmed strings so reordering the bullets — the plan and the body need not list them in the
 * same sequence — is never mistaken for a divergence.
 *
 * FAILS OPEN on everything it cannot read: no `taskAcceptanceForId` resolver, no trailer, an id
 * the plan does not declare, or a task with no `acceptance:` of its own all return `undefined`.
 * @param {{ body: string, taskAcceptanceForId?: (taskId: string) => readonly { claim: string, proof: string }[] | undefined }} input
 */
export function trailerBodyProofDivergenceRefusal({ body, taskAcceptanceForId }) {
  if (taskAcceptanceForId === undefined) return undefined;
  const trailerId = extractTaskTrailerId(body ?? "");
  if (trailerId === undefined) return undefined;
  let declared;
  try {
    declared = taskAcceptanceForId(trailerId);
  } catch {
    return undefined;
  }
  if (!Array.isArray(declared) || declared.length === 0) return undefined;

  const bodyCriteria = parseAcceptanceBlock(body ?? "");
  if (bodyCriteria.length === 0) return undefined; // trailer-only shape — unaffected, task acceptance criterion 2

  const taskProofs = declared.map((c) => (c.proof ?? "").trim()).filter((p) => p.length > 0);
  const bodyProofs = bodyCriteria.map((c) => (c.proof ?? "").trim()).filter((p) => p.length > 0);
  const taskSet = new Set(taskProofs);
  const bodySet = new Set(bodyProofs);
  const onlyInBody = [...new Set(bodyProofs.filter((p) => !taskSet.has(p)))];
  const onlyInTask = [...new Set(taskProofs.filter((p) => !bodySet.has(p)))];
  if (onlyInBody.length === 0 && onlyInTask.length === 0) return undefined; // identical proof sets — no divergence

  return {
    ok: false,
    defect: "trailer-body-proof-divergence",
    message:
      `Remudero-Task: ${trailerId} trailer present AND this pull request carries its own ` +
      "`## Acceptance` block, but the two name DIFFERENT proofs — review resolves criteria from " +
      `${trailerId}'s plan record, so a proof only in this PR's body is never executed, and a proof ` +
      `only in ${trailerId}'s declared acceptance is never seen by a human reading this PR's body ` +
      "(the CONSOLE-T12 shape). " +
      `Proof(s) only in this PR's own block: ${onlyInBody.length ? onlyInBody.map((p) => JSON.stringify(p)).join(", ") : "(none)"}. ` +
      `Proof(s) only in ${trailerId}'s declared acceptance: ${onlyInTask.length ? onlyInTask.map((p) => JSON.stringify(p)).join(", ") : "(none)"}. ` +
      `Remove this PR's own \`## Acceptance\` block (criteria already resolve from ${trailerId}), or make ` +
      "the two proof sets agree.",
  };
}


/**
 * W1-T3739 — RENDER a pull request's `## Acceptance` block FROM the task's own criteria, so the
 * two cannot disagree.
 *
 * `trailerBodyProofDivergenceRefusal` above refuses a body whose proofs differ from the shard's —
 * the CONSOLE-T12 shape, and it refused FIVE pull requests in one session on 2026-09-17. Every one
 * of those bodies was authored by hand beside a shard that already held the answer.
 *
 * Rendering makes the divergence UNREACHABLE rather than refused: only one of the two documents is
 * authored. The output is deliberately in the dialect {@link parseAcceptanceBlock} reads, and the
 * test for this round-trips through THAT parser rather than comparing strings — a renderer checked
 * against a hand-written expectation would drift from the parser exactly the way the bodies did.
 */
export function renderAcceptanceBlock(criteria) {
  const rows = (criteria ?? []).filter((c) => typeof c?.claim === "string" && c.claim.trim().length > 0);
  if (rows.length === 0) return "";
  return [
    "## Acceptance",
    "",
    ...rows.map((c) =>
      c.satisfied_by && !c.proof
        ? // A criterion the plan credits to an earlier merge carries no proof text at all
          // (plan.ts: "satisfied_by stands IN PLACE OF a proof"), so rendering a `proof:` line for
          // it would invent one — and `proof-discrimination` would then try to execute it.
          `- claim: ${c.claim.trim()}\n  satisfied_by: ${String(c.satisfied_by).trim()}`
        : `- claim: ${c.claim.trim()}\n  proof: ${String(c.proof ?? "").trim()}`,
    ),
    "",
  ].join("\n");
}

/**
 * W1-T3414 — a branch commit can add a trailer after the PR author deliberately opened a
 * plan-only filing without one. Squash merge preserves commit bodies, so inspect every reachable
 * branch commit before accepting the PR. This is deliberately an extension of the existing
 * author-time gate, not a second workflow or a post-merge best-effort report.
 * @param {{ trailerCommits?: readonly { sha: string, subject: string, taskId: string }[], changedPaths?: readonly string[], taskFilesForId?: (taskId: string) => readonly string[] | undefined }} input
 */
export function followupCommitImplementationTrailerRefusal({ trailerCommits, changedPaths, taskFilesForId }) {
  if (trailerCommits === undefined || changedPaths === undefined || changedPaths.length === 0 || taskFilesForId === undefined) return undefined;
  if (!changedPaths.every(isInPlanScope)) return undefined;
  for (const trailer of trailerCommits) {
    let declaredFiles;
    try {
      declaredFiles = taskFilesForId(trailer.taskId);
    } catch {
      continue;
    }
    const nonPlanFiles = Array.isArray(declaredFiles) ? declaredFiles.filter((path) => !isInPlanScope(path)) : [];
    if (nonPlanFiles.length === 0) continue;
    return {
      ok: false,
      defect: "follow-up-implementation-trailer",
      message:
        `Commit ${trailer.sha} (${trailer.subject}) carries Remudero-Task: ${trailer.taskId}, but this pull request ` +
        `changes only plan-scope path(s) and does not ship its non-plan file(s): ${nonPlanFiles.join(", ")}. ` +
        "Remove the trailer from that commit or include the implementation changes.",
    };
  }
  return undefined;
}

/** CI owns commit trailers; the standalone `edited` caller owns PR-body facts. */
export function evaluateCommitTrailerGate({ trailerCommits, changedPaths, taskFilesForId }) {
  const refusal = followupCommitImplementationTrailerRefusal({ trailerCommits, changedPaths, taskFilesForId });
  if (refusal !== undefined) return refusal;
  return { ok: true, message: "no follow-up commit trailer credits an implementation absent from this pull request" };
}

/**
 * The gate's own verdict: the bot exemption first, then Rule 15 and the three structural refusals
 * (plan-only-implementation, follow-up-commit-implementation, and W1-T3658's trailer/body proof
 * divergence), then `acceptanceAuthorTimeCheck` (no `expectedTaskId` — this job has no PR-to-task
 * binding of its own, the same general-case call shape `rmd check-acceptance` itself uses), then
 * proof shape.
 *
 * W1-T2297's OTHER HALF. The predicate has taken an optional `trailerResolves` since #2934; this
 * caller is what supplies it, so a `Remudero-Task:` trailer naming an id the plan does not declare
 * stops buying an exemption. `trailerResolves` OMITTED — which is what a caller with an unreadable
 * plan passes — leaves the verdict byte for byte what it was before this wiring.
 * @param {{ body: string, authorLogin?: string, headRefName?: string, trailerResolves?: (taskId: string) => boolean, introducedTaskIds?: string[], trailerCommits?: readonly { sha: string, subject: string, taskId: string }[], changedPaths?: readonly string[], taskFilesForId?: (taskId: string) => readonly string[] | undefined, taskAcceptanceForId?: (taskId: string) => readonly { claim: string, proof: string }[] | undefined, rule15Verdict?: import("../src/lib/ci-parity.ts").Rule15SplitVerdict }} input
 */
export function evaluateGate({ body, authorLogin, headRefName, trailerResolves, introducedTaskIds = [], trailerCommits, changedPaths, taskFilesForId, taskAcceptanceForId, rule15Verdict }) {
  if (authorLogin !== undefined && EXEMPT_BOT_LOGINS.has(authorLogin)) {
    return {
      ok: true,
      message: `author "${authorLogin}" is exempt — the dep-review lane owns arming for these (W1-T1060 rationale (5))`,
    };
  }
  if (rule15Verdict?.refused) {
    return {
      ok: false,
      defect: "rule-15-split",
      message: rule15Verdict.reason ?? "Standing rule 15 refuses this mixed plan-and-implementation diff",
    };
  }
  // W1-T3231 runs BEFORE the acceptance check, not after: a filing PR carrying its own trailer
  // PASSES `acceptanceAuthorTimeCheck` today (the trailer arm accepts any resolvable id at face
  // value), so ordering it second would leave it unreachable on exactly the bodies it is for.
  const selfCredit = filingSelfCreditCheck(body, introducedTaskIds);
  if (!selfCredit.ok) return { ok: false, defect: "files-and-credits-the-same-task", message: selfCredit.message };
  const structuralRefusal = planOnlyImplementationTrailerRefusal({ body, changedPaths, taskFilesForId });
  if (structuralRefusal !== undefined) return structuralRefusal;
  const followupRefusal = followupCommitImplementationTrailerRefusal({ trailerCommits, changedPaths, taskFilesForId });
  if (followupRefusal !== undefined) return followupRefusal;
  const proofDivergence = trailerBodyProofDivergenceRefusal({ body, taskAcceptanceForId });
  if (proofDivergence !== undefined) return proofDivergence;
  // W1-T3747: reconcile only a credited implementation; filings/body-only PRs stay silent.
  const planOnly = changedPaths !== undefined && changedPaths.length > 0 && changedPaths.every(isInPlanScope);
  const trailerId = extractTaskTrailerId(body ?? "");
  const creditedTaskId = planOnly ? undefined : (trailerId ?? taskIdFromRunBranch(headRefName));
  if (creditedTaskId !== undefined && taskFilesForId !== undefined) {
    let declaredFiles;
    let declaredAcceptance;
    try {
      declaredFiles = taskFilesForId(creditedTaskId);
      declaredAcceptance = taskAcceptanceForId?.(creditedTaskId);
    } catch {
      declaredFiles = undefined;
      declaredAcceptance = undefined;
    }
    if (Array.isArray(declaredFiles)) {
      const violations = lintTask(
        { id: creditedTaskId, files: declaredFiles, acceptance: Array.isArray(declaredAcceptance) ? declaredAcceptance : [] },
        { creditedBuild: true, moduleExists: (path) => existsSync(join(REPO_ROOT, path)) },
      ).violations.filter((violation) => violation.check === "credited-test-path");
      if (violations.length > 0) return { ok: false, defect: "credited-test-path", message: violations.map((v) => v.message).join(" ") };
    }
  }
  const result = acceptanceAuthorTimeCheck(body, trailerResolves === undefined ? {} : { trailerResolves });
  // JUDGE THE SOURCE THE CRITERIA ACTUALLY CAME FROM. The predicate above returns OK early on the
  // trailer arm precisely because "criteria come from the plan record rather than the body" — and
  // the proof-shape check below then re-parsed the BODY anyway, undoing the exemption the same
  // call had just granted one line earlier. Recomputed here with the predicate's OWN condition, not
  // by string-matching its message, so the two cannot disagree about which arm fired.
  const criteriaCameFromPlan = trailerId !== undefined && (trailerResolves === undefined || trailerResolves(trailerId));
  return result.ok ? authorTimeProofShapeRefusal(body, result, criteriaCameFromPlan) : result;
}

/**
 * Refuse a body whose Acceptance bullets carry proofs review cannot execute.
 *
 * SKIPPED ENTIRELY when the criteria resolve from the plan (`criteriaCameFromPlan`). On that arm the
 * body's block is NOT the source of truth and review never reads it, so parsing it here judged prose
 * the author wrote as explanation. MEASURED on #5687: a body carrying a valid
 * `Remudero-Task: W1-T3612` trailer — whose shard declares two proofs that both parse — was refused
 * "criterion 1 cannot execute: empty proof", because a prose section headed `## Acceptance criteria`
 * parsed to one claim with no `proof:` line. The shard was fine; the gate was reading the wrong file.
 * #5680 had already been refused the same way and rewritten its body to get past it.
 *
 * NOT A COVERAGE HOLE: a shard's proofs are held to the same dialect by `lint-plan` (which refuses a
 * criterion review cannot execute) and by `proof-discrimination`. Re-deriving that judgement here
 * would be a second implementation of it, which this script's own header rules out.
 * @param {string} body
 * @param {{ ok: true, message: string }} result
 * @param {boolean} [criteriaCameFromPlan]
 */
function authorTimeProofShapeRefusal(body, result, criteriaCameFromPlan = false) {
  if (criteriaCameFromPlan) return result;
  const criteria = parseAcceptanceBlock(body);
  const defects = [];
  criteria.forEach((criterion, index) => {
    const proof = criterion.proof ?? "";
    const criterionNumber = index + 1;
    const wrapped = wrappedGrepPattern(proof);
    if (wrapped !== undefined) {
      defects.push(
        `criterion ${criterionNumber} wraps its grep pattern in ${wrapped.delimiter}; ` +
          `use: grep: ${wrapped.bare} in <path>`,
      );
    }
    if (parseWhitelistedProof(proof) === null) {
      defects.push(`criterion ${criterionNumber} cannot execute: ${proofShapeReason(proof)}`);
    }
  });
  if (defects.length === 0) return result;
  return {
    ok: false,
    defect: "proof-shape",
    message: `${result.message}. ${defects.join("; ")}.`,
  };
}

function proofShapeReason(proof) {
  const trimmed = proof.trim();
  return (
    explainGrepProofRefusal(trimmed) ??
    explainUnitTestProofRefusal(trimmed) ??
    (trimmed.length === 0
      ? "empty proof"
      : `no runnable dialect prefix (\`grep:\` or \`unit test:\`) in proof \`${trimmed}\``)
  );
}

/**
 * Resolve the event-payload path from the flag, falling back to the environment.
 *
 * EXTRACTED AND PURE so its refusal arm is reachable from a test. Inline in `main` it ran only when
 * the script was invoked as a process, so `diff-coverage` blocked the PR naming exactly those
 * lines — the same extraction-and-injection remedy used elsewhere in this repo rather than an
 * exemption comment, which the script's own guidance says "blocks the PR harder, not softer".
 */
export function resolveEventPath(flagValue, env = process.env) {
  const eventPath = flagValue ?? env.GITHUB_EVENT_PATH;
  return eventPath
    ? { ok: true, eventPath }
    : {
        ok: false,
        message:
          "acceptance-author-gate: REFUSED — no event payload path (pass --event-path or set GITHUB_EVENT_PATH)",
      };
}

export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { "event-path": { type: "string" }, "commit-trailer-only": { type: "boolean" } },
  });
  const resolved = resolveEventPath(values["event-path"]);
  if (!resolved.ok) {
    console.error(resolved.message);
    process.exitCode = 1;
    return;
  }
  const eventPath = resolved.eventPath;

  const payload = readEventPayload(eventPath);
  if (!payload.readable) {
    console.error(`acceptance-author-gate: REFUSED — unreadable event payload: ${payload.reason}`);
    process.exitCode = 1;
    return;
  }

  const trailerCommits = commitTaskTrailersAtRange({ baseSha: payload.baseSha, headSha: payload.headSha });
  const changedPaths = changedPathsAtRange({ baseSha: payload.baseSha, headSha: payload.headSha });
  const taskFilesForId = planTaskFilesResolver();
  const result = values["commit-trailer-only"]
    ? evaluateCommitTrailerGate({ trailerCommits, changedPaths, taskFilesForId })
    : evaluateGate({
      body: payload.body,
      authorLogin: payload.authorLogin,
      headRefName: payload.headRefName,
      trailerResolves: planTrailerResolver(),
      introducedTaskIds: introducedShardTaskIds({ baseSha: payload.baseSha, headSha: payload.headSha }),
      trailerCommits,
      changedPaths,
      taskFilesForId,
      taskAcceptanceForId: planTaskAcceptanceResolver(),
      rule15Verdict: rule15SplitAtRange({ baseSha: payload.baseSha, headSha: payload.headSha }),
    });
  if (!result.ok) {
    console.error(`acceptance-author-gate: REFUSED (${result.defect}) — ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`acceptance-author-gate: OK — ${result.message}`);
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/acceptance-author-gate.mjs ...`), never on import.
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
