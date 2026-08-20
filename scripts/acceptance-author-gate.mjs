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

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { acceptanceAuthorTimeCheck } from "../src/lib/review.ts";

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
  return { readable: true, body: typeof pr.body === "string" ? pr.body : "", authorLogin };
}

/**
 * The gate's own verdict: the bot exemption first, then `acceptanceAuthorTimeCheck` verbatim (no
 * `expectedTaskId` — this job has no plan lookup of its own, the same general-case call shape
 * `rmd check-acceptance` itself uses).
 * @param {{ body: string, authorLogin?: string }} input
 */
export function evaluateGate({ body, authorLogin }) {
  if (authorLogin !== undefined && EXEMPT_BOT_LOGINS.has(authorLogin)) {
    return {
      ok: true,
      message: `author "${authorLogin}" is exempt — the dep-review lane owns arming for these (W1-T1060 rationale (5))`,
    };
  }
  return acceptanceAuthorTimeCheck(body);
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

  const result = evaluateGate({ body: payload.body, authorLogin: payload.authorLogin });
  if (!result.ok) {
    console.error(`acceptance-author-gate: REFUSED (${result.defect}) — ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`acceptance-author-gate: OK — ${result.message}`);
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/acceptance-author-gate.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
