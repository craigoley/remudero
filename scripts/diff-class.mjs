#!/usr/bin/env -S npx tsx
/**
 * scripts/diff-class.mjs — W1-T2428: classify a changed-file list so CI can run the suites a diff
 * can actually fail and skip the rest.
 *
 * THIS IS AN ENTRY POINT, NOT A PREDICATE. The class comes from `isInPlanScope`
 * (src/lib/plan-architect.ts), which is CANONICAL for a stated reason: `docs/ORIENTATION.md` is
 * REGENERATED from `MASTER-PLAN.md`, so a plan change legitimately carries it, and the sweep already
 * derives `planOnly` from this same function for the reviewer. Making it canonical adds no new
 * source of truth.
 *
 * NEVER A BASH REIMPLEMENTATION. Three plan-scope predicates already exist and two DISAGREE on a
 * real PR: on #3131's file list `isInPlanScope` says plan-only while `nonPlanFilesInDiff`
 * (lib/triage.ts) returns `["docs/ORIENTATION.md"]`. A fourth spelling in shell would drift from
 * all three. Triage keeps its own narrower REFUSAL policy; only this classifier's mechanism is
 * shared.
 *
 * FAIL CLOSED, EVERYWHERE. Any throw, an empty file list, an unreadable input, or a class this
 * cannot determine yields `source` — which runs everything, i.e. exactly today's behaviour. The
 * expensive answer is the safe one, so every unknown takes it.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The three classes, strictest first. A mixed diff takes the strictest class present. */
export const CLASS_SOURCE = "source";
export const CLASS_DOCS_ONLY = "docs-only";
export const CLASS_PLAN_ONLY = "plan-only";

/**
 * Classify a changed-file list. `source` is the fail-closed answer and the default for anything
 * this cannot decide — including an EMPTY list, which must never read as "nothing outside plan/".
 */
export function classifyFiles(files, isInPlanScope) {
  if (!Array.isArray(files) || files.length === 0) return CLASS_SOURCE;
  if (files.some((f) => typeof f !== "string" || f.length === 0)) return CLASS_SOURCE;
  try {
    if (files.every((f) => isInPlanScope(f))) return CLASS_PLAN_ONLY;
    if (files.every((f) => f.startsWith("docs/"))) return CLASS_DOCS_ONLY;
    return CLASS_SOURCE;
  } catch {
    return CLASS_SOURCE; // a throwing predicate is an undeterminable class
  }
}

/**
 * The suites a plan-only diff CAN still fail: those that read the COMMITTED TREE from a repo-root
 * constant AND name a plan or docs path. ENUMERATED FROM THE TREE, never hand-copied — a baked list
 * goes stale silently, and this set is what makes the lane safe rather than a blanket skip.
 * `test/plan-proposals.test.ts` is the exemplar: it caught a real duplicate proposal id on #3131.
 */
export function planReadingSuites(cwd = process.cwd(), run = defaultGitGrep) {
  const withRoot = new Set(run(["grep", "-l", "-e", "REPO_ROOT", "-e", "repoRoot", "--", "test/*.test.ts"], cwd));
  const withPlan = new Set(
    run(["grep", "-lE", "-e", "MASTER-PLAN\\.md|plan/tasks|plan/plan-index|plan/tasks\\.d|docs/", "--", "test/*.test.ts"], cwd),
  );
  return [...withRoot].filter((f) => withPlan.has(f)).sort();
}

export function defaultGitGrep(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return []; // an unreadable tree yields an empty set; the caller falls back to running everything
  }
}

export function readFileList(argv) {
  const fromIdx = argv.indexOf("--from");
  if (fromIdx !== -1 && argv[fromIdx + 1]) {
    try {
      return readFileSync(argv[fromIdx + 1], "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    } catch {
      return []; // unreadable -> empty -> source, the fail-closed direction
    }
  }
  const filesIdx = argv.indexOf("--files");
  if (filesIdx !== -1) return argv.slice(filesIdx + 1).filter(Boolean);
  return [];
}

export async function main(argv, out = console.log) {
  try {
    if (argv.includes("--plan-suites")) {
      for (const f of planReadingSuites()) out(f);
      return;
    }
    const { isInPlanScope } = await import("../src/lib/plan-architect.ts");
    out(classifyFiles(readFileList(argv), isInPlanScope));
  } catch {
    out(CLASS_SOURCE); // any failure at all runs everything
  }
}

/**
 * True only when this module IS the process entry point. Compared as a resolved file URL rather
 * than by basename, so a test importing this module can never trip the CLI path — and extracted
 * from the guard below so the decision is testable: the `await main(...)` it protects runs in no
 * test by construction, which is exactly why the PREDICATE has to be reachable on its own.
 */
export function isDirectRun(argv1, moduleUrl) {
  return Boolean(argv1) && moduleUrl === pathToFileURL(argv1).href;
}

if (isDirectRun(process.argv[1], import.meta.url)) await main(process.argv.slice(2));
