#!/usr/bin/env node
// scripts/console-parity-ratchet.mjs — W1-T2926 (rationale: this task's own plan shard).
//
// INVARIANT: every `COMMANDS` verb maps to a console route (declaredConsoleRoutes(), shared with
// test/route-registration.test.ts) OR carries a reason in {@link CLI_ONLY}; neither is UNMAPPED
// and always fails. THE RATCHET: {@link CLI_ONLY}'s key set may not grow past
// `scripts/console-parity-baseline.json` without the baseline being edited in the SAME PR (same
// discipline as scripts/comment-load-baseline.json) — a shrink is reported, never refused.
//
// A STEP, NOT A JOB: rides ci.yml's `comment-load-ratchet` job, beside
// contract-coverage-ratchet.mjs — a new ci.yml JOB needs ci-gate.yml too, and Standing rule 25
// refuses a workflow change beside a src/ product path.
//
// Run via `node --import tsx` (like scripts/generate-macro-skills.mjs): COMMANDS and
// declaredConsoleRoutes both live in .ts modules.
//
// FALSIFIER: test/console-parity-ratchet.test.ts.

import { readFileSync } from "node:fs";
import { COMMANDS } from "../src/run-task.ts";
import { declaredConsoleRoutes } from "../test/helpers/declared-routes.ts";
import { isMainModule } from "./lib/argv.mjs";

export const BASELINE_PATH = "scripts/console-parity-baseline.json";

/** verb -> the ONE declared console route ("METHOD /path", {@link declaredConsoleRoutes}'s own
 *  shape) that dispatches the SAME operator action, confirmed by reading the route's handler —
 *  never a name-alone guess. A route whose action genuinely differs from the verb (e.g.
 *  `GET /v1/plan/view` is a READ of the plan; `rmd plan` WRITES it) is deliberately absent here,
 *  even where the names coincide. */
export const ROUTE_MATCH = {
  status: "GET /v1/status",
  pause: "POST /v1/control/pause",
  resume: "POST /v1/control/resume",
  stop: "POST /v1/control/stop",
  "merge-hold": "POST /v1/merge-hold",
  feedback: "POST /v1/feedback",
  trace: "GET /v1/trace",
  inbox: "GET /v1/inbox",
  approve: "POST /v1/inbox/approve",
  reframe: "POST /v1/inbox/reframe",
  peek: "GET /v1/peek",
  replay: "GET /v1/replay",
  skill: "GET /v1/skills",
  drain: "POST /v1/drain/run",
};

const REASON_LOCAL_GIT_PLAN =
  "operator-shell-only: reads or writes the git-tracked plan/ledger directly through local " +
  "filesystem and git access the console's remote HTTP client does not have";

const REASON_LOCAL_PROCESS =
  "operator-shell-only: local host/process/service lifecycle (install, launchd unit generation, " +
  "git checkout maintenance) that the console's remote client cannot perform";

const REASON_RUNG_DISPATCH =
  "operator-shell-only: dispatches a PR-pipeline reconciliation rung via a local process spawn; " +
  "no console route triggers a sweep/fix rung run";

/** `{name -> reason}` for every name in `names`. A helper, not a hand-copied literal per verb, so
 *  the same reason text cannot drift between the verbs that share it. */
function reasons(names, reason) {
  return Object.fromEntries(names.map((name) => [name, reason]));
}

/** verb -> the stated cli-only reason (W1-T2926's rationale: `"operator-shell-only: needs a TTY
 *  for …"`, `"superseded by route …"`). Every key here is a verb the ratchet below tracks — an
 *  entry present here but ABSENT from {@link BASELINE_PATH} is a verb added to this table without
 *  recording it, and is refused for that reason alone, never for the reason text's content. */
export const CLI_ONLY = {
  ...reasons(
    [
      "run-task",
      "review",
      "dep-review",
      "lint-plan",
      "plan-reconcile",
      "proof-queue-audit",
      "preflight",
      "next-task-id",
      "emissions",
      "receipt",
      "authority",
      "check-proof",
      "reap-branches",
      "ledger-compact",
      "ledger-grep",
      "hand-runs",
      "ci-failures",
      "census-membership",
      "caller-sweep",
      "ci-learning",
      "rule-efficacy",
      "coverage-improve",
      "verdict-calibration",
      "autonomy-rate",
      "replay-goldens",
      "check-acceptance",
      "retro",
      "correct",
      "triage",
      "ratify",
      "learnings",
      "bundle",
      "rule",
      "init",
      "project",
      "onboard",
    ],
    REASON_LOCAL_GIT_PLAN,
  ),
  ...reasons(
    [
      "daemon",
      "daemon-plist",
      "deploy",
      "deploy-run",
      "deploy-plist",
      "install-checkout",
      "relay",
      "serve-plist",
      "down",
      "up",
      "sync",
      "doctor",
      "wipe-test",
      "digest-plist",
    ],
    REASON_LOCAL_PROCESS,
  ),
  ...reasons(["sweep", "fix"], REASON_RUNG_DISPATCH),
  serve:
    "bootstraps the console server itself — there is no console route to start the process " +
    "that serves the console's own routes",
  "console-url":
    "prints a locally-held secret bearer token; the console cannot hand out its own credential " +
    "over an authenticated session of itself",
  escalate:
    "creates the escalation (opens a needs-human GitHub issue and, for MANUAL/HARD_STOP, fires " +
    "a real-time ping); the console can only act on one already raised (POST " +
    "/v1/escalation/mark-handled, /reply, /answer, GET /v1/escalation/confirm)",
  notify: "operator-shell-only: sends a local iMessage ping via osascript, a local-machine notification channel with no console equivalent",
  digest:
    "rolls up the ledger into a NEW daily digest message; GET /v1/inbox/digests only reads " +
    "digests already produced, it does not roll one up",
  ops: "operator-shell-only: polls GitHub code-scanning/Dependabot/secret-scanning alert APIs and writes local policy decisions; no console route ingests alerts",
  "alert-fix":
    "operator-shell-only: the alert-fix lane's act-vs-escalate policy decision runs against the " +
    "local alert queue `ops` populates; no console route triggers it",
  issues: "operator-shell-only: polls the GitHub issues API and writes into the local feedback inbox; no console route ingests issues",
  audit: "operator-shell-only: grades a written audit against a checked-in fixture and prints the diff; no console route runs a grading pass",
  away: "sets or shows local operator-presence state used to batch escalations; no console route reads or writes it",
  "verify-human-sweep": "judges the parked verify:human backlog against the local ledger; no console route surfaces it",
  plan:
    "creates, clarifies or expands plan tasks by writing the git-tracked plan; GET /v1/plan/view " +
    "is READ-ONLY and does not cover this write action",
};

/** Every declared route reduced to its `"METHOD /path"` key, the same shape {@link ROUTE_MATCH}'s
 *  values use — so a lookup is one Set membership test. */
export function routeKeys(declaredRoutes) {
  return new Set(declaredRoutes.map((r) => `${r.method} ${r.path}`));
}

/**
 * Sort every verb name into exactly one bucket: `mapped` (a live route dispatches it),
 * `cliOnlyVerbs` (a stated reason covers it) or `unmapped` (neither — always a failure,
 * independent of the baseline below).
 */
export function classifyVerbs(verbNames, declaredRoutes, routeMatch = ROUTE_MATCH, cliOnly = CLI_ONLY) {
  const have = routeKeys(declaredRoutes);
  const mapped = [];
  const cliOnlyVerbs = [];
  const unmapped = [];
  for (const name of verbNames) {
    const routeKey = routeMatch[name];
    if (routeKey !== undefined && have.has(routeKey)) {
      mapped.push(name);
    } else if (Object.prototype.hasOwnProperty.call(cliOnly, name)) {
      cliOnlyVerbs.push(name);
    } else {
      unmapped.push(name);
    }
  }
  return { mapped: mapped.sort(), cliOnlyVerbs: cliOnlyVerbs.sort(), unmapped: unmapped.sort() };
}

/** The ratchet itself: `cliOnlyVerbs` (this run's CLI_ONLY membership) against the recorded
 *  `baselineVerbs`. `added` (grown past the recording) is the ONLY failure condition; `removed`
 *  (shrunk) is reported so the baseline can be lowered to lock the improvement in, same
 *  discipline as scripts/contract-coverage-ratchet.mjs's FELL branch. */
export function ratchetVerdict(cliOnlyVerbs, baselineVerbs) {
  const baseline = new Set(baselineVerbs);
  const current = new Set(cliOnlyVerbs);
  const added = cliOnlyVerbs.filter((v) => !baseline.has(v)).sort();
  const removed = baselineVerbs.filter((v) => !current.has(v)).sort();
  return { ok: added.length === 0, added, removed };
}

export function formatReport({ verbNames, mapped, cliOnlyVerbs, unmapped, verdict, baselinePath }) {
  const out = [];
  out.push(
    `console-parity: ${verbNames.length} COMMANDS verb(s) — ${mapped.length} console-routed, ` +
      `${cliOnlyVerbs.length} cli-only (stated reason), ${unmapped.length} unmapped.`,
  );
  if (unmapped.length > 0) {
    out.push("");
    out.push("UNMAPPED — neither a console route nor a CLI_ONLY reason (add one, in scripts/console-parity-ratchet.mjs):");
    for (const v of unmapped) out.push(`  ${v}`);
  }
  if (verdict.added.length > 0) {
    out.push("");
    out.push(`ADDED to the cli-only set without recording it in ${baselinePath}:`);
    for (const v of verdict.added) out.push(`  ${v}`);
    out.push(`Add each to ${baselinePath}'s "uncoveredVerbs" in this same PR, or give it a console route instead.`);
  }
  if (verdict.removed.length > 0) {
    out.push("");
    out.push(`FELL — no longer cli-only, so ${baselinePath} can be lowered to lock the shrink in:`);
    for (const v of verdict.removed) out.push(`  ${v}`);
  }
  if (unmapped.length === 0 && verdict.added.length === 0) {
    out.push(verdict.removed.length > 0 ? "OK (with a recordable shrink above)." : "OK — unchanged.");
  }
  return out.join("\n");
}

// diff-cov: process-boundary -- the CLI shell. Every DECISION is a pure function tested above
// (classifyVerbs, ratchetVerdict, formatReport); what is left here is I/O and the one
// `process.exit` that is the gate's verdict, which a test cannot observe without spawning it.
function main() {
  const verbNames = COMMANDS.map((c) => c.name);
  const declaredRoutes = declaredConsoleRoutes();
  // A ZERO ON EITHER SIDE IS A BROKEN CENSUS, NOT A CLEAN SHEET — same discipline as
  // contract-coverage-ratchet.mjs: if either extraction stops seeing its corpus, every verb
  // reads as cli-only-or-unmapped and the gate cannot tell that apart from a real clean sheet.
  if (verbNames.length === 0 || declaredRoutes.length === 0) {
    console.log(
      `console-parity: REFUSING — extraction returned ${verbNames.length} verb(s) and ${declaredRoutes.length} route(s). ` +
        "A zero on either side means the census stopped seeing its corpus, which reads as a clean sheet.",
    );
    process.exit(1);
  }
  const { mapped, cliOnlyVerbs, unmapped } = classifyVerbs(verbNames, declaredRoutes);
  const baselineDoc = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const verdict = ratchetVerdict(cliOnlyVerbs, baselineDoc.uncoveredVerbs);
  console.log(formatReport({ verbNames, mapped, cliOnlyVerbs, unmapped, verdict, baselinePath: BASELINE_PATH }));
  process.exit(unmapped.length === 0 && verdict.ok ? 0 : 1);
}

if (isMainModule(import.meta.url)) main();
