import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseProbeOutcome, ImportClosureRead } from "./base-reproduction.js";
import { censusWalksOf } from "./ci-parity.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

export type FixOutcome =
  | { kind: "FIXED" | "BASE_RED" | "FLAKE" }
  | { kind: "NEEDS_SCOPE"; paths: string[] }
  | { kind: "NEEDS_DESIGN"; reason: string };

/** W1-T9561: a NEEDS_SCOPE the harness sent to the flake rerun, because the PR's diff cannot reach its red. */
export type ScopeReroute = { paths: string[]; attribution: RedAttribution };

export type FixOutcomeAction =
  | { kind: "legacy" | "commit" | "verify-base" }
  | { kind: "rerun-once"; rerouted?: ScopeReroute }
  | { kind: "scope-needed"; testPaths: string[]; paths: string[]; attribution?: RedAttribution }
  | { kind: "hand-off"; reason: string };

// The prompt lists each outcome as "FIX_OUTCOME: FLAKE — <what it means>", and workers echo that shape back.
// A dash/colon gloss after the keyword is commentary, not a different outcome: before this, every glossed
// FLAKE/BASE_RED parsed as no outcome, so the rerun and base-verify arms never fired (2026-10-09, #10234).
const OUTCOME_GLOSS = /[ \t]*(?:—|–|--?|:)[ \t].*$/;

export function anchoredFixOutcome(report: string): FixOutcome | undefined {
  const lines = [...report.matchAll(/^[ \t]*FIX_OUTCOME:[ \t]*(.*)$/gm)];
  const raw = lines.at(-1)?.[1].trim();
  const glossed = raw !== undefined && /^(?:FIXED|BASE_RED|FLAKE|NEEDS_SCOPE[ \t])/.test(raw) && OUTCOME_GLOSS.test(raw);
  const value = glossed ? raw.replace(OUTCOME_GLOSS, "") : raw;
  if (value === "FIXED" || value === "BASE_RED" || value === "FLAKE") return { kind: value };
  if (value?.startsWith("NEEDS_DESIGN ")) {
    const reason = value.slice("NEEDS_DESIGN ".length).trim();
    return reason.length > 0 && reason.length <= 500 ? { kind: "NEEDS_DESIGN", reason } : undefined;
  }
  if (value?.startsWith("NEEDS_SCOPE ")) {
    const paths = value.slice("NEEDS_SCOPE ".length).split(",").map((path) => path.trim());
    if (paths.every((path) => path.length > 0 && !/^(?:\/|[A-Za-z]:)/.test(path) &&
      !/[\\\s\x00-\x1f\x7f]/.test(path) &&
      !path.split("/").some((part) => part === ".." || part === "." || part === ""))) {
      return { kind: "NEEDS_SCOPE", paths: [...new Set(paths)] };
    }
  }
  return undefined;
}

export function decideFixOutcomeAction(outcome: FixOutcome | undefined, facts: { admitTests: boolean; attribution?: RedAttribution }): FixOutcomeAction {
  if (!outcome) return { kind: "legacy" };
  switch (outcome.kind) {
    case "FIXED": return { kind: "commit" };
    case "BASE_RED": return { kind: "verify-base" };
    case "FLAKE": return { kind: "rerun-once" };
    case "NEEDS_DESIGN": return { kind: "hand-off", reason: outcome.reason };
    case "NEEDS_SCOPE": {
      const testPaths = facts.admitTests ? outcome.paths.filter((path) => path.startsWith("test/")) : [];
      const paths = outcome.paths.filter((path) => !testPaths.includes(path));
      if (paths.length === 0) return { kind: "commit" };
      // W1-T9561: only evidence the diff cannot reach the red reroutes; `diff-reaches` and `unknown` keep the amendment.
      return facts.attribution?.kind === "diff-cannot-reach"
        ? { kind: "rerun-once", rerouted: { paths: outcome.paths, attribution: facts.attribution } }
        : { kind: "scope-needed", testPaths, paths, ...(facts.attribution ? { attribution: facts.attribution } : {}) };
    }
  }
}

// ── W1-T9561 — a red the PR's diff cannot reach is a flake, not a scope amendment ─────────────────────
// OBSERVED 2026-10-14 on #11702: a learnings task's fix round answered a host-script flake with NEEDS_SCOPE
// deploy/host-update.sh, and the harness tried to graft that script onto the learnings task. The red passed at
// main, main changed nothing reaching it, and the PR's diff reached neither the test nor what it runs. 33 of 34
// path-naming NEEDS_SCOPE refusals 2026-10-04..14 named only paths outside the PR's diff. The decision below
// asks whether the DIFF REACHES the failing tests, never whether the named path is in the diff: a PR may
// legitimately need a neighbour file. No count decides it. A wrong `diff-cannot-reach` costs one requeue and no
// refund (the flake arm refunds only on green); the refuted claim then makes `rerunReproduced` true on this head,
// so the next round runs exactly as before this task.

export type RedAttributionKind = "diff-reaches" | "diff-cannot-reach" | "unknown";
export interface RedAttribution {
  kind: RedAttributionKind;
  /** The PR's changed paths that can reach a failing test; empty unless `kind` is `diff-reaches`. */
  reached: string[];
  reason: string;
  failingTestFiles: string[];
}

export interface RedAttributionInput {
  /** The failing test files the red names (`baseReproductionFiles`). */
  failingTestFiles: readonly string[];
  /** The PR's changed paths, merge base to head; undefined when unread. */
  changedPaths: readonly string[] | undefined;
  /** Each failing test file's import closure, itself included (`ImportClosureRead`); undefined when unread. */
  closure: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  /** The newest verdict at main for each failing test file; undefined when none was read. */
  baseOutcomes: ReadonlyMap<string, BaseProbeOutcome> | undefined;
  isHarnessPath: (path: string) => boolean;
  /** The {@link closureNeedle}s some file in the failing tests' closure names; undefined when unread. */
  namedInClosure: ReadonlySet<string> | undefined;
  /** Each failing file's census walk prefixes; a missing entry means its head text was unread. */
  censusWalks?: ReadonlyMap<string, readonly string[]> | undefined;
  /** A flake claim on this head was already refuted: the red reproduced on a rerun. */
  rerunReproduced?: boolean;
}

const isSuite = (path: string): boolean => /\.test\.[cm]?[jt]sx?$/.test(path);

/** A test/ helper or fixture outside every closure reaches the red only when a closure file names it: by its
 *  directory below test/ (`fixtures/golden-verdicts`), or by its own name when it sits directly in test/. */
export function closureNeedle(path: string): string | undefined {
  if (!path.startsWith("test/") || isSuite(path)) return undefined;
  const dir = posix.dirname(path);
  return dir === "test" ? path.slice("test/".length) : dir.slice("test/".length);
}

/** W1-T9561 — does the PR's diff reach its own red? `diff-cannot-reach` needs every fact: a readable diff,
 *  every failing file's closure known, every failing file recorded `passes` at main, and no rerun that already
 *  reproduced it. Anything missing is `unknown`, which keeps today's scope amendment. */
export function redAttribution(input: RedAttributionInput): RedAttribution {
  const failingTestFiles = [...input.failingTestFiles];
  const answer = (kind: RedAttributionKind, reason: string, reached: string[] = []): RedAttribution => ({ kind, reached, reason, failingTestFiles });
  if (failingTestFiles.length === 0) return answer("unknown", "the red names no test file");
  if (input.changedPaths === undefined) return answer("unknown", "the PR's diff is unread");
  const inClosure = new Set(failingTestFiles);
  for (const file of failingTestFiles) for (const dep of input.closure?.get(file) ?? []) inClosure.add(dep);
  const needleOf = (path: string) => inClosure.has(path) ? undefined : closureNeedle(path);
  const censusReached = new Map<string, string[]>();
  for (const file of failingTestFiles) {
    const paths = input.changedPaths.filter((path) => input.censusWalks?.get(file)?.some((prefix) => path.startsWith(prefix)));
    if (paths.length > 0) censusReached.set(file, paths);
  }
  const reached = input.changedPaths.filter((path) => inClosure.has(path) || input.isHarnessPath(path) || !path.includes("/") ||
    input.namedInClosure?.has(needleOf(path) ?? "") === true || [...censusReached.values()].some((paths) => paths.includes(path)));
  const censusReason = [...censusReached].map(([file, paths]) => `${file} walks ${paths.join(", ")}`).join("; ");
  if (reached.length > 0) return answer("diff-reaches", `the PR changes ${reached.join(", ")}, which can reach the red${censusReason ? `; census ${censusReason}` : ""}`, reached);
  const unread = failingTestFiles.filter((file) => input.closure?.has(file) !== true);
  if (unread.length > 0) return answer("unknown", `no import closure for ${unread.join(", ")}`);
  const unreadText = failingTestFiles.filter((file) => input.censusWalks?.has(file) !== true);
  if (unreadText.length > 0) return answer("unknown", `head test text is unread for ${unreadText.join(", ")}`);
  if (input.namedInClosure === undefined && input.changedPaths.some((path) => needleOf(path) !== undefined)) {
    return answer("unknown", "whether the failing tests name the PR's test/ helpers or fixtures is unread");
  }
  const notPassing = failingTestFiles.filter((file) => input.baseOutcomes?.get(file) !== "passes");
  if (notPassing.length > 0) return answer("unknown", `no passing verdict at main for ${notPassing.join(", ")}`);
  if (input.rerunReproduced) return answer("unknown", "a rerun at this head already reproduced the red");
  return answer("diff-cannot-reach",
    "the PR's diff touches no failing test, nothing they import or walk, no CI harness path and no root file, and they pass at main");
}

/** The newest main verdict per file for `headSha`, from the sweep's (or a fix round's) `sweep.base_reproduction` rows. */
export function baseOutcomesForHead(rows: readonly Record<string, unknown>[], headSha: string | undefined): Map<string, BaseProbeOutcome> | undefined {
  const row = rows.findLast((r) => r.step === "sweep.base_reproduction" && r.head_sha === headSha && headSha !== undefined &&
    Array.isArray(r.files) && r.setup_error === undefined);
  if (!row) return undefined;
  return new Map((row.files as { file?: unknown; outcome?: unknown }[]).filter((p) => typeof p?.file === "string")
    .map((p) => [p.file as string, p.outcome as BaseProbeOutcome]));
}

/** Where {@link readRedAttribution} reads its facts. Every read that throws is unread, never an empty answer. */
export interface RedAttributionReads {
  failingTestFiles: readonly string[];
  headSha: string | undefined;
  prNumber: number | undefined;
  ledger: readonly Record<string, unknown>[];
  rerunReproduced: boolean;
  isHarnessPath: (path: string) => boolean;
  mainTip: () => string | Promise<string>;
  changedPaths: (mainSha: string, headSha: string) => readonly string[] | Promise<readonly string[]>;
  closure: ImportClosureRead;
  namedInClosure: (headSha: string, files: readonly string[], needles: readonly string[]) => ReadonlySet<string> | Promise<ReadonlySet<string>>;
  /** Read a failing file at this head; undefined or a throw leaves its census membership unknown. */
  readTestText?: (headSha: string, file: string) => string | undefined | Promise<string | undefined>;
}

const settle = async <T>(read: () => T | Promise<T>): Promise<T | undefined> => {
  try {
    return await read();
  } catch {
    // An unread fact is undefined, which redAttribution turns into `unknown`: today's scope amendment, never a reroute.
    return undefined;
  }
};

/** W1-T9561 — gather {@link redAttribution}'s facts for a fix round's NEEDS_SCOPE. */
export async function readRedAttribution(reads: RedAttributionReads): Promise<RedAttribution> {
  const { failingTestFiles: failing, headSha, prNumber } = reads;
  const mainSha = failing.length === 0 || headSha === undefined ? undefined : await settle(reads.mainTip);
  const changedPaths = mainSha === undefined ? undefined : await settle(() => reads.changedPaths(mainSha, headSha!));
  const closure = changedPaths === undefined || prNumber === undefined ? undefined
    : await settle(() => reads.closure({ prNumber, headSha: headSha! }, failing, mainSha!));
  const closureFiles = [...new Set([...failing, ...[...closure?.values() ?? []].flatMap((deps) => [...deps])])];
  const needles = [...new Set((changedPaths ?? []).filter((path) => !closureFiles.includes(path)).map(closureNeedle).filter((n) => n !== undefined))];
  const namedInClosure = needles.length === 0 ? new Set<string>() : closure === undefined ? undefined
    : await settle(() => reads.namedInClosure(headSha!, closureFiles, needles));
  const readTestText = reads.readTestText ?? ((head: string, file: string) =>
    hostWorktreeGitAsync(fileURLToPath(new URL("../../", import.meta.url)), ["show", `${head}:${file}`]));
  const censusWalks = new Map<string, readonly string[]>();
  if (changedPaths !== undefined) for (const file of failing) {
    const text = await settle(() => readTestText(headSha!, file));
    if (text !== undefined) censusWalks.set(file, censusWalksOf(file, text));
  }
  return redAttribution({ failingTestFiles: failing, changedPaths, closure, baseOutcomes: baseOutcomesForHead(reads.ledger, headSha),
    isHarnessPath: reads.isHarnessPath, namedInClosure, censusWalks, rerunReproduced: reads.rerunReproduced });
}

/** The `fix.scope_rerouted` row's fields: what the worker asked for, why it was rerouted, and its own diagnosis
 *  (the report's first paragraph) with the edits it left saved, so the flake's incident carries the root cause. */
export function scopeReroutedFields(rerouted: ScopeReroute, report: string, savedPaths: readonly string[] | undefined): Record<string, unknown> {
  const diagnosis = report.trim().split(/\n[ \t]*\n/)[0]?.trim().slice(0, 2000);
  return { paths: rerouted.paths, attribution: rerouted.attribution.kind, reason: rerouted.attribution.reason,
    reached: rerouted.attribution.reached, failing_test_files: rerouted.attribution.failingTestFiles,
    ...(diagnosis ? { diagnosis } : {}), ...(savedPaths === undefined ? {} : { saved_paths: [...savedPaths] }) };
}

/** W1-T9561 — one `test.flake_retry` row per failing file once a rerouted round's requeue reports, in the shape
 *  `selectorShadowFlakeLedger` writes, so the flake's evidence outlives the round. */
export function fixRoundFlakeRetryRows(rerouted: ScopeReroute, green: boolean, prNumber: number | undefined, headSha: string | undefined): Record<string, unknown>[] {
  return rerouted.attribution.failingTestFiles.map((file) => ({ file, source: "fix-round",
    headline: green ? "recovered on retry" : "retry also failed", retry_outcome: green ? "recovered" : "also_failed",
    ...(prNumber === undefined ? {} : { pr_numbers: [prNumber] }), ...(headSha === undefined ? {} : { head_sha: headSha }) }));
}
