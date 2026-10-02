// W1-T3720 — A BUNDLED JOB MUST NAME THE GATE THAT ACTUALLY REFUSED, NOT THE JOB THAT HOSTED IT.
//
// ci.yml's `commitlint` job (W1-T4399) runs the light gates as `continue-on-error` steps and then
// posts each REQUIRED check run itself, and some of those check runs AND several steps together:
// `comment-load-ratchet` is the conjunction of the comment-load-ratchet, expiring-fixture-census
// and console-parity steps. MEASURED 2026-09-17 on five PRs: the board showed
// `comment-load-ratchet` red while comment-load-ratchet itself printed OK and
// `expiring-fixture-census: BLOCKED` was the real refusal, so every diagnosis paid a log dig.
//
// This module computes the check run's TITLE — never its NAME. The name is the required context
// (ci-gate.yml's REQUIRED list and branch protection), so it is returned unchanged in every case;
// only the title a reader sees on the check run says which gate refused. The refusing gate is read
// from the gate's OWN report (`<gate>: BLOCKED ...` is the first token every self-describing gate
// emits, e.g. the shared `emitCiReport` encoder), never from a hand-kept gate-to-job table: a table
// goes stale on the next gate a bundle adds, the report's own first token cannot. A failing step
// whose report names no gate (a crash, a report in another shape) falls back to that step's own id
// — the workflow names each step after its gate — so the title is never emptier than today's.
//
// CLI (the reporting step in ci.yml): `node scripts/bundled-gate-report.mjs <check-name> <constituent>...`
// where each constituent is `<step-id>=<outcome>` (or a bare `<outcome>`, whose id is the check
// name). A step's report is read from `$GATE_REPORT_DIR/<step-id>.log` when present. Prints the
// title on one line. The caller keeps its own conclusion and falls back to the check name if this
// script fails, so a defect here can never stop a required context from being posted.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A gate's own headline, optionally behind GitHub's rendering of an `::error` command (`##[error]`)
 *  or the raw command itself (`::error title=<gate>::`). Anchored per line, so a gate name quoted
 *  mid-sentence never reads as a refusal. */
const GATE_BLOCKED_HEADLINE = /^(?:##\[error\]|::error[^\n]*?::)?([a-z][a-z0-9-]*): BLOCKED\b/gm;

/** Every gate whose OWN report in `text` says BLOCKED — sorted, deduplicated, empty when none did. */
export function refusedGateNames(text) {
  const refused = new Set();
  for (const match of String(text ?? "").matchAll(GATE_BLOCKED_HEADLINE)) refused.add(match[1]);
  return [...refused].sort();
}

/** The same rule the reporting step has always applied: `skipped` (a fast-laned gate) is a pass. */
export function isFailingOutcome(outcome) {
  return outcome !== "success" && outcome !== "skipped";
}

/** `<step-id>=<outcome>` or a bare `<outcome>` (whose step id is the check's own name). */
export function parseConstituent(arg, checkName) {
  const at = arg.lastIndexOf("=");
  return at === -1 ? { id: checkName, outcome: arg } : { id: arg.slice(0, at), outcome: arg.slice(at + 1) };
}

/**
 * Describe one posted check run. `name` is ALWAYS `checkName` — the required context never moves.
 * A passing check keeps `checkName` as its title too, so a green board reads exactly as before.
 * A failing one is titled by every gate that refused: for each failing constituent, the gates its
 * own report names BLOCKED, or its step id when the report names none.
 */
export function describeBundledCheck(checkName, constituents) {
  const failing = constituents.filter((c) => isFailingOutcome(c.outcome));
  if (failing.length === 0) return { name: checkName, conclusion: "success", title: checkName, refusedBy: [] };
  const refusedBy = new Set();
  for (const c of failing) {
    const named = refusedGateNames(c.report);
    for (const gate of named.length > 0 ? named : [c.id]) refusedBy.add(gate);
  }
  const sorted = [...refusedBy].sort();
  return { name: checkName, conclusion: "failure", title: sorted.join(", "), refusedBy: sorted };
}

/** Read each constituent's report from `reportDir/<id>.log`, when a directory is given and the file exists. */
export function readReports(constituents, reportDir, { exists = existsSync, readFile = (p) => readFileSync(p, "utf8") } = {}) {
  return constituents.map((c) => {
    if (!reportDir) return c;
    const path = join(reportDir, `${c.id}.log`);
    return exists(path) ? { ...c, report: readFile(path) } : c;
  });
}

export function main(argv = process.argv.slice(2), { env = process.env, log = console.log, ...io } = {}) {
  const [checkName, ...args] = argv;
  if (!checkName) throw new Error("usage: bundled-gate-report.mjs <check-name> <step-id>=<outcome>...");
  const constituents = readReports(args.map((a) => parseConstituent(a, checkName)), env.GATE_REPORT_DIR, io);
  log(describeBundledCheck(checkName, constituents).title);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("bundled-gate-report.mjs")) process.exit(main());
