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

import { readFileSync, readdirSync } from "node:fs";
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
import { loadPlan } from "../src/lib/plan.ts";
import { isInPlanScope } from "../src/lib/plan-scope.ts";
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
  return { readable: true, body: typeof pr.body === "string" ? pr.body : "", authorLogin, baseSha, headSha };
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

/**
 * The gate's own verdict: the bot exemption first, then the two structural refusals, then
 * `acceptanceAuthorTimeCheck` (no `expectedTaskId` — this job has no PR-to-task binding of its
 * own, the same general-case call shape `rmd check-acceptance` itself uses), then proof shape.
 *
 * W1-T2297's OTHER HALF. The predicate has taken an optional `trailerResolves` since #2934; this
 * caller is what supplies it, so a `Remudero-Task:` trailer naming an id the plan does not declare
 * stops buying an exemption. `trailerResolves` OMITTED — which is what a caller with an unreadable
 * plan passes — leaves the verdict byte for byte what it was before this wiring.
 * @param {{ body: string, authorLogin?: string, trailerResolves?: (taskId: string) => boolean, introducedTaskIds?: string[], trailerCommits?: readonly { sha: string, subject: string, taskId: string }[], changedPaths?: readonly string[], taskFilesForId?: (taskId: string) => readonly string[] | undefined }} input
 */
export function evaluateGate({ body, authorLogin, trailerResolves, introducedTaskIds = [], trailerCommits, changedPaths, taskFilesForId }) {
  if (authorLogin !== undefined && EXEMPT_BOT_LOGINS.has(authorLogin)) {
    return {
      ok: true,
      message: `author "${authorLogin}" is exempt — the dep-review lane owns arming for these (W1-T1060 rationale (5))`,
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
  const result = acceptanceAuthorTimeCheck(body, trailerResolves === undefined ? {} : { trailerResolves });
  return result.ok ? authorTimeProofShapeRefusal(body, result) : result;
}

function authorTimeProofShapeRefusal(body, result) {
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
  const { values } = parseArgs({ args: argv, options: { "event-path": { type: "string" } } });
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

  const result = evaluateGate({
    body: payload.body,
    authorLogin: payload.authorLogin,
    trailerResolves: planTrailerResolver(),
    introducedTaskIds: introducedShardTaskIds({ baseSha: payload.baseSha, headSha: payload.headSha }),
    trailerCommits: commitTaskTrailersAtRange({ baseSha: payload.baseSha, headSha: payload.headSha }),
    changedPaths: changedPathsAtRange({ baseSha: payload.baseSha, headSha: payload.headSha }),
    taskFilesForId: planTaskFilesResolver(),
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
