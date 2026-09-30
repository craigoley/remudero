#!/usr/bin/env node
/**
 * WILL CI'S PLAN LINT REFUSE THIS DIFF'S SHARD? Ask before the push, not after the red board.
 *
 * MEASURED 2026-09-16..30 over 120 failed PR runs: 14 of the 55 single-shard test reds were ci-parity's real
 * `lint-plan:fast` run refusing the PR's own changed shard (shared-proof 7, sizing 5, proof-* 5, machine-filing-admission
 * 2), and each of those PRs then failed the commitlint job's lint-plan step too. Nothing in this hook asked the question.
 *
 * THE ARGV IS READ, NEVER RETYPED: the command is package.json's `lint-plan:fast` script, the same one preflight and CI's
 * scope run, so this cannot drift from them. It is offline (no network rule), so it cannot refuse what CI would not.
 *
 * TWO HAZARDS, BOTH MEASURED. (a) A STALE LOCAL origin/main: 100 commits behind the fork point, the lint on a branch that
 * changed nothing checks 96 tasks and fails on other PRs' merged ones. Every squash-merged commit's subject ends `(#<n>)`,
 * so one in merge-base..HEAD proves the ref is behind, and this ABSTAINS naming `git fetch origin`. (b) machine-filing-
 * admission reads releasedIds and selectability from THIS checkout, so a finding made only of it is REPORTED, not blocking.
 *
 * Exit 0 clean, skipped or reported-only, 1 a blocking violation, 2 could not run (the hook never blocks on 2).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./lib/argv.mjs";
import { gitOrThrow } from "./lib/git.mjs";

const SCRIPT = "lint-plan:fast";
const STATE_DEPENDENT_RULE = "machine-filing-admission";
const SQUASH_SUBJECT_RE = /\(#[0-9]+\)$/;

/** The lint's argv, split out of package.json's `lint-plan:fast` script: `{ args, base }`, or undefined when the script
 *  is missing or is not a plain `node ...` command this can spawn without a shell. */
export function lintArgvFromPackage(packageJsonText) {
  const command = JSON.parse(packageJsonText).scripts?.[SCRIPT];
  const tokens = typeof command === "string" ? command.trim().split(/\s+/) : [];
  if (tokens[0] !== "node") return undefined;
  const at = tokens.indexOf("--base");
  return { args: tokens.slice(1), base: at >= 0 ? tokens[at + 1] : undefined };
}

/** The pure verdict. `lint()` runs the lint and returns `{ status, output }`; it is called only when the diff needs it. */
export function lintPlanPrecheckVerdict({ changedFiles, subjects, lint }) {
  if (!changedFiles.some((f) => f.startsWith("plan/"))) {
    return { exit: 0, lines: ["lint-plan-precheck: SKIP -- no plan/ path in this diff"] };
  }
  const squash = subjects.find((s) => SQUASH_SUBJECT_RE.test(s));
  if (squash !== undefined) {
    return {
      exit: 0,
      lines: [
        `lint-plan-precheck: SKIP -- the local origin/main is behind this branch's fork point (${JSON.stringify(squash)} is already merged)`,
        "  run `git fetch origin` and push again: against a stale ref the lint would judge other PRs' tasks, and a refusal there is not this branch's",
      ],
    };
  }
  const { status, output } = lint();
  if (status === 0) return { exit: 0, lines: ["lint-plan-precheck: OK -- the plan lint passes on this diff"] };
  const rows = output.split("\n").filter((l) => l.startsWith("✗ ") || /^ {4}\[[^\]]+\] /.test(l));
  if (status !== 1 || rows.length === 0) {
    return { exit: 2, lines: [`lint-plan-precheck: the lint exited ${status} with no violation it could name -- not blocking on it`] };
  }
  const rules = new Set(rows.map((l) => /^ {4}\[([^\]]+)\] /.exec(l)?.[1]).filter((r) => r !== undefined));
  const blocking = [...rules].some((r) => r !== STATE_DEPENDENT_RULE);
  const lines = [`lint-plan-precheck: the plan lint CI runs on this diff REFUSES it [${[...rules].join(", ")}]:`, ...rows.map((l) => `  ${l.trim()}`)];
  lines.push(
    blocking
      ? `  TO FIX: edit the shard named above, then reproduce with \`npm run ${SCRIPT}\` (about 8 s, offline). After the push it costs a red PR.`
      : `  (${STATE_DEPENDENT_RULE} reads releasedIds and selectability from this checkout: reported, not blocking -- CI judges it.)`,
  );
  return { exit: blocking ? 1 : 0, lines };
}

/** The whole run, in-process: git and the lint are read from `cwd`, and every line goes to `log` / `warn`, so a test can
 *  drive it against a fixture repo. Returns the exit code; the two lines at the bottom are the only process glue. */
export function runLintPlanPrecheck({ argv = [], cwd = process.cwd(), log = console.log, warn = console.error } = {}) {
  const fallbackBase = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "origin/main";
  try {
    const root = gitOrThrow(["rev-parse", "--show-toplevel"], { cwd });
    const lintArgv = lintArgvFromPackage(readFileSync(join(root, "package.json"), "utf8"));
    if (lintArgv === undefined) throw new Error(`package.json has no plain \`node ...\` ${SCRIPT} script`);
    const forkPoint = gitOrThrow(["merge-base", "HEAD", lintArgv.base ?? fallbackBase], { cwd: root });
    const verdict = lintPlanPrecheckVerdict({
      changedFiles: gitOrThrow(["diff", "--name-only", `${forkPoint}...HEAD`], { cwd: root }).split("\n").filter(Boolean),
      subjects: gitOrThrow(["log", "--format=%s", `${forkPoint}..HEAD`], { cwd: root }).split("\n").filter(Boolean),
      lint: () => {
        const r = spawnSync(process.execPath, lintArgv.args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
        return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
      },
    });
    for (const line of verdict.lines) (verdict.exit === 0 && verdict.lines.length === 1 ? log : warn)(line);
    return verdict.exit;
  } catch (e) {
    warn(`lint-plan-precheck: could not run (${e.message}) -- NOT reporting clean`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) process.exit(runLintPlanPrecheck({ argv: process.argv.slice(2) }));
