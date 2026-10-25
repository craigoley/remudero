import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { fixedClock, systemClock } from "./clock.js";
import { checkoutHeadStamp } from "./checkout-head.js";
import { prepareGardenTaskIds, type GardenTaskIdMinter, type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec, type Outcome } from "./gardener.js";
import { gateFireRatesPath, type GateFireRate, type GateFireRateReport } from "./gate-fire-rate.js";
import { writeAtomic } from "./fs-race-safe.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { defaultTestSlots, lowPriorityCommand, readHostLoad, testRunArgv, testRunConcurrency } from "./test-slot.js";
import { machineShardLandingGuard, renderMachineShard } from "./machine-filing.js";
import { loadPlan, loadPlanFromYaml, machineFilingAdmissionViolations, retirementHoldsOrigin, taskLandedArgs, newTestPath, loadPlanForLayout } from "./plan.js";
import { hostWorktreeGit } from "./worktree-git.js";
import { loadPolicy } from "./policy.js";
import { sameTestFile } from "./test-path-resolver.js";
import { collectCiFailureCorpus, rollupAtSha, type CiFailurePair, type CorpusCommit } from "./ci-failure-corpus.js";
import { ghJsonAsync, ghTextAsync } from "./github-transport.js";
import { checkRunsRestArgs, combinedStatusRestArgs } from "./open-prs-rest.js";
import { commentCompressionOrigin, nextCommentCompression, readGateFollowupOrigins, type CommentCompressionFinding } from "./comment-compression.js";

/**
 * lib/gate-gardener.ts (W1-T4116) — the gates tend themselves.
 *
 * W1-T4115 measures how often each gate fires; nothing acted on it. Each pass proposes ONE class of
 * change as ONE pull request, every value taken from the ratchet's OWN measurement, never a guess:
 *   - TIGHTEN: a one-way ceiling the code has fallen below — a legacy source-size
 *     row the ratchet itself would now record lower (its `shrunk`). (W1-T4583 retired the
 *     contract-coverage ceiling this also tightened.)
 *   - REFRESH: a stale row — a per-file row for a file that no longer exists (the ratchet's
 *     `removed`), or the learnings baseline's recorded measurement that no longer matches the corpus.
 *     Its `capChars` headroom is deliberate and never touched.
 *   - DEMOTE: a REQUIRED gate that never refused across at least as many pull requests as a typical
 *     gate, moved to ADVISORY with a GATE_RATIONALE — a `review` class, judged by whether its PR merges.
 * TIGHTEN and REFRESH are judged by refusals repaired against refusals overridden across all gates.
 * DEFUSE files a remedy for a fixture about to expire; that tally never measures it, so it is judged
 * by its PR's decision (W1-T5825). COMPRESS files priority-1 comment maintenance without
 * blocking the change that exposed it; its decision metric measures proposal acceptance.
 */

export type GateGardenClass = "tighten" | "refresh" | "demote" | "defuse" | "false-positive" | "compress";
export const GATE_GARDEN_CLASSES: readonly GateGardenClass[] = ["tighten", "refresh", "demote", "defuse", "false-positive", "compress"];
export const DEFUSE_LEAD_DAYS = 21;

export type GateRepairClass = "baseline-only" | "token-dodge" | "rename-dodge" | "off-subject" | "genuine";
export type GateRepairPair = CiFailurePair & { triggered?: boolean };
export interface GateRepairRule {
  gate: string;
  recognizer: string;
  symbol: string;
  ownFiles: readonly string[];
  /** Null only for gates that measure paths or executions rather than source tokens. */
  gateRegex: RegExp | null;
  trigger?: (input: { changed: string[]; readHead: (path: string) => string | null; readBase: (path: string) => string | null }) => boolean;
}
export interface GateRepairObservation { pair: GateRepairPair; repairDiff: string }

const STRING_LITERAL = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const matchesGate = (regex: RegExp, text: string): boolean => new RegExp(regex.source, regex.flags.replace(/[gy]/g, "")).test(text);
const stringValue = (literal: string): string => literal.slice(1, -1).replace(/\\([\\"'])/g, "$1");

function rebuiltTokens(line: string): Array<{ expression: string; value: string }> {
  const literal = STRING_LITERAL.source;
  const expressions = new RegExp(`\\[\\s*(?:${literal})(?:\\s*,\\s*(?:${literal}))*\\s*(?:,\\s*)?\\]\\.join\\(\\s*(?:${literal})\\s*\\)|(?:${literal})(?:\\s*\\+\\s*(?:${literal}))+`, "g");
  return [...line.matchAll(expressions)].map(([expression]) => {
    const strings = [...expression.matchAll(STRING_LITERAL)].map(([s]) => stringValue(s));
    const value = expression.startsWith("[") ? strings.slice(0, -1).join(strings.at(-1)) : strings.join("");
    return { expression, value };
  });
}

const SOURCE_TOKEN = new RegExp(`${STRING_LITERAL.source}|//[^\\n]*|/\\*[\\s\\S]*?\\*/|[A-Za-z_$][\\w$]*|\\s+|[^\\w\\s]`, "g");
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** A diff line's code: a comment line is empty, and a trailing comment or a whitespace run is not the edit. */
function codeOf(line: string): string {
  if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return "";
  return (line.match(SOURCE_TOKEN) ?? []).filter((token) => !token.startsWith("//") && !token.startsWith("/*"))
    .map((token) => /^\s+$/.test(token) ? " " : token).join("").trim();
}

/** Each hunk's removed and added code lines, with the file its `diff --git` header names. */
function repairHunks(repairDiff: string): Array<{ file?: string; removed: string[]; added: string[] }> {
  const hunks: Array<{ file?: string; removed: string[]; added: string[] }> = [];
  let file: string | undefined, hunk: (typeof hunks)[number] | undefined;
  for (const line of repairDiff.split("\n")) {
    const header = /^diff --git a\/\S+ b\/(\S+)/.exec(line);
    if (header || line.startsWith("@@")) {
      if (header) file = header[1];
      hunk = undefined;
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++") || !/^[-+]/.test(line)) continue;
    const code = codeOf(line.slice(1));
    if (!code) continue;
    if (!hunk) hunks.push(hunk = { file, removed: [], added: [] });
    (line.startsWith("-") ? hunk.removed : hunk.added).push(code);
  }
  return hunks;
}

/** How one added line dodges the gate that matched one removed line, if it does. */
function lineDodge(before: string, after: string, gateRegex: RegExp): "token-dodge" | "rename-dodge" | undefined {
  for (const rebuilt of rebuiltTokens(after)) {
    for (const [literal] of before.matchAll(STRING_LITERAL)) {
      if (stringValue(literal) === rebuilt.value && before.replace(literal, "<token>") === after.replace(rebuilt.expression, "<token>")) return "token-dodge";
    }
  }
  const oldTokens = before.match(SOURCE_TOKEN) ?? [], newTokens = after.match(SOURCE_TOKEN) ?? [];
  if (oldTokens.length !== newTokens.length) return undefined;
  const changed = oldTokens.flatMap((old, i) => old === newTokens[i] ? [] : [{ old, next: newTokens[i]! }]);
  const first = changed[0];
  if (first && changed.every(({ old, next }) => old === first.old && next === first.next && IDENTIFIER.test(old) && IDENTIFIER.test(next)) &&
      matchesGate(gateRegex, first.old) && !matchesGate(gateRegex, first.next)) return "rename-dodge";
  return undefined;
}

/**
 * A repair is a dodge only when EVERY gated line it removes outside the gate's own files comes back as a token
 * rebuilt from literals or a pure rename. One gated line changed any other way is a genuine repair, whatever the
 * other hunks do; a comment or an unrelated line beside the dodge changes nothing.
 */
export function classifyGateRepair(pair: GateRepairPair, repairDiff: string, ownFiles: readonly string[], gateRegex: RegExp | null): GateRepairClass {
  const repairFiles = pair.repairFiles ?? [];
  if (pair.state !== "repaired" || !pair.greenSha || repairFiles.length === 0) return "genuine";
  if (repairFiles.every((file) => ownFiles.includes(file))) return "baseline-only";
  if (pair.triggered === false) return "off-subject";
  if (gateRegex === null) return "genuine";
  let dodge: "token-dodge" | "rename-dodge" | undefined;
  for (const hunk of repairHunks(repairDiff)) {
    if (hunk.file !== undefined && ownFiles.includes(hunk.file)) continue;
    const added = [...hunk.added];
    for (const before of hunk.removed) {
      if (!matchesGate(gateRegex, before)) continue;
      const kept = added.indexOf(before);
      if (kept >= 0) {
        added.splice(kept, 1);
        continue;
      }
      const at = added.findIndex((after) => !matchesGate(gateRegex, after) && lineDodge(before, after, gateRegex) !== undefined);
      if (at < 0) return "genuine";
      const kind = lineDodge(before, added[at]!, gateRegex)!;
      if (dodge !== "token-dodge") dodge = kind;
      added.splice(at, 1);
    }
  }
  return dodge ?? "genuine";
}

export function gateRepairCandidates(observations: readonly GateRepairObservation[], rules: readonly GateRepairRule[], coveredOrigins: readonly string[], log: GardenerDeps["log"]): GateGardenAction[] {
  const covered = new Set(coveredOrigins), actions: GateGardenAction[] = [];
  for (const observation of observations) {
    const rule = rules.find((r) => r.gate === observation.pair.gate);
    if (!rule) continue;
    const classification = classifyGateRepair(observation.pair, observation.repairDiff, rule.ownFiles, rule.gateRegex);
    if (classification === "genuine") continue;
    log("gate.false_positive_suspected", { ...observation.pair, classification, recognizer: rule.recognizer, symbol: rule.symbol });
    const target = `gate-false-positive:${rule.gate}`;
    if (covered.has(target)) continue;
    covered.add(target);
    actions.push({ class: "false-positive", target, file: rule.recognizer,
      edit: { kind: "false-positive", rule, observation, classification },
      reason: `PR #${observation.pair.pr} cleared ${rule.gate} with ${classification}; repair ${rule.symbol}.` });
  }
  return actions;
}

export function renderFalsePositiveShard(action: GateGardenAction, taskId: string) {
  if (action.edit.kind !== "false-positive") throw new Error("gate gardener: mixed false-positive plan");
  const { rule, observation: { pair, repairDiff }, classification } = action.edit;
  return renderMachineShard({ taskId, title: `Repair ${rule.symbol}'s ${classification} false positive`, origin: action.target,
    files: [rule.recognizer], cost: 1,
    acceptance: [{ claim: `${rule.symbol} accepts the healthy case from PR #${pair.pr} while still refusing its unhealthy control.`,
      proof: `unit test: ${taskId}: ${rule.symbol} distinguishes the false positive from its unhealthy control` }],
    rationale: [`Gate ${rule.gate}, PR #${pair.pr}: ${pair.redSha} -> ${pair.greenSha}; classification ${classification}.`,
      `Repair the recognizer ${rule.symbol} in ${rule.recognizer}. Gate-owned files: ${rule.ownFiles.join(", ")}.`,
      "Measure the gate's suspect repair rate after the remedy merges; lowering that rate is the effect.",
      "Preserve the unhealthy control. Do not rename the PR's symbols, rebuild tokens, or raise a baseline to hide the refusal.",
      ...repairDiff.split("\n").map((line) => `Repair evidence: ${line}`)],
  });
}

/**
 * Evaluates a rule's SYNCHRONOUS trigger over files read from GitHub without blocking the loop: each pass
 * records the paths the trigger asked for and could not yet see, fetches them, and runs again, until a pass
 * asks for nothing new. A file absent at a sha (HTTP 404) is `null`, as the trigger's own readers return.
 */
async function evaluateTriggerAsync(rule: GateRepairRule, changed: string[], shas: { head: string; base: string },
  readAt: (sha: string, path: string) => Promise<string | null>): Promise<boolean | undefined> {
  if (!rule.trigger) return undefined;
  const seen = new Map<string, string | null>();
  for (let round = 0; round < 8; round++) {
    const missing = new Map<string, { sha: string; path: string }>();
    const reader = (sha: string) => (path: string): string | null => {
      const key = `${sha}:${path}`;
      if (seen.has(key)) return seen.get(key)!;
      missing.set(key, { sha, path });
      return null;
    };
    let verdict: boolean | undefined, failure: { error: unknown } | undefined;
    try {
      verdict = rule.trigger({ changed, readHead: reader(shas.head), readBase: reader(shas.base) });
    } catch (error) {
      failure = { error: error };
    }
    if (!missing.size) {
      if (failure !== undefined) throw failure.error;
      return verdict;
    }
    for (const [key, { sha, path }] of missing) seen.set(key, await readAt(sha, path));
  }
  throw new Error(`gate trigger never settled: ${rule.gate}`);
}

export async function loadGateRepairObservations(rules: readonly GateRepairRule[], sources: GateDefuseSources = {}): Promise<GateRepairObservation[]> {
  const readJsonAsync = sources.ghJson ?? ((args: string[]) => ghJsonAsync(args));
  const readTextAsync = sources.ghText ?? ((args: string[]) => ghTextAsync(args));
  const repo = await readJsonAsync(["repo", "view", "--json", "nameWithOwner"]) as { nameWithOwner: string };
  const [owner, name] = repo.nameWithOwner.split("/") as [string, string];
  const api = `repos/${repo.nameWithOwner}`;
  const prs = await readJsonAsync(["api", `${api}/pulls?state=all&sort=updated&direction=desc&per_page=100`]) as Array<{ number: number; base: { sha: string } }>;
  const observations: GateRepairObservation[] = [];
  for (const pr of prs) {
    const commits = await readJsonAsync(["api", `${api}/pulls/${pr.number}/commits?per_page=100`]) as Array<{ sha: string }>;
    const runs = new Map<string, { check_runs: Array<{ id: number; name: string; conclusion: string }> }>();
    const corpusCommits: CorpusCommit[] = [];
    for (const { sha } of commits) {
      const [checkRuns, statuses] = await Promise.allSettled([
        readJsonAsync(checkRunsRestArgs(owner, name, sha)), readJsonAsync(combinedStatusRestArgs(owner, name, sha))]);
      // An unreadable rollup stays `undefined`, never green: collectCiFailureCorpus names the sha.
      let rollup: CorpusCommit["rollup"];
      if (checkRuns.status === "fulfilled" && statuses.status === "fulfilled") {
        runs.set(sha, checkRuns.value as { check_runs: Array<{ id: number; name: string; conclusion: string }> });
        rollup = rollupAtSha(owner, name, sha, (args) => args[1]?.includes("/check-runs") ? checkRuns.value : statuses.value);
      }
      corpusCommits.push({ sha, rollup });
    }
    const corpus = collectCiFailureCorpus({ prs: [{ number: pr.number, commits: corpusCommits }] });
    for (const pair of corpus.pairs.filter((pair) => pair.state === "repaired")) {
      const diff = await readJsonAsync(["api", `${api}/compare/${pair.redSha}...${pair.greenSha}`]) as { files: Array<{ filename: string; patch?: string }> };
      const files = diff.files ?? [];
      if (files.length === 0 || files.some((file) => file.patch === undefined)) throw new Error(`gate repair diff unreadable for PR #${pr.number}`);
      const repairDiff = files.map((file) => `diff --git a/${file.filename} b/${file.filename}\n${file.patch}`).join("\n");
      const direct = rules.filter((rule) => rule.gate === pair.gate);
      const failed = runs.get(pair.redSha)?.check_runs.find((check) => check.name === pair.gate && check.conclusion === "failure");
      const log = direct.length || !failed ? "" : await readTextAsync(["run", "view", "--job", String(failed.id), "--log-failed"]);
      const implicated = direct.length ? direct : rules.filter((rule) => log.includes(rule.gate));
      for (const rule of implicated) {
        const before = await readJsonAsync(["api", `${api}/compare/${pr.base.sha}...${pair.redSha}`]) as { merge_base_commit: { sha: string }; files: Array<{ filename: string }> };
        const readAt = async (sha: string, path: string): Promise<string | null> => {
          let value: { content?: string; encoding?: string };
          try {
            value = await readJsonAsync(["api", `${api}/contents/${path}?ref=${sha}`]) as { content?: string; encoding?: string };
          } catch (error) {
            if (/\b404\b|Not Found/.test(String((error as Error)?.message ?? error))) return null;
            throw error;
          }
          if (value.encoding !== "base64" || typeof value.content !== "string") throw new Error(`gate trigger content unreadable: ${path}@${sha}`);
          return Buffer.from(value.content, "base64").toString("utf8");
        };
        const triggered = await evaluateTriggerAsync(rule, before.files.map((file) => file.filename),
          { head: pair.redSha, base: before.merge_base_commit.sha }, readAt);
        observations.push({ pair: { ...pair, gate: rule.gate, repairFiles: files.map((file) => file.filename), triggered }, repairDiff });
      }
    }
  }
  return observations;
}

const NO_REPAIRS = (): { actions: GateGardenAction[]; tally: Outcome } => ({ actions: [], tally: { trials: 0, successes: 0 } });

/** True when there is anything to read: injected observations, or a fire-rate report that saw a repaired refusal. */
function repairsAreWorthReading(deps: GardenerDeps, sources: GateDefuseSources): boolean {
  if (sources.repairObservations) return true;
  const reportPath = gateFireRatesPath(deps.stateDir);
  return existsSync(reportPath) && !!(readJson(reportPath).gates as GateFireRate[] | undefined)?.some((gate) => gate.repaired > 0);
}

function falsePositiveRules(probes: GateProbes, sources: GateDefuseSources): readonly GateRepairRule[] {
  const rules = sources.repairRules ?? probes.fp?.GATE_REPAIR_RULES;
  if (!rules) throw new Error("gate gardener: false-positive rule metadata is missing");
  return rules;
}

function falsePositiveActions(deps: GardenerDeps, rules: readonly GateRepairRule[], observations: readonly GateRepairObservation[], open: readonly string[]): { actions: GateGardenAction[]; tally: Outcome } {
  const tally: Outcome = { trials: observations.length, successes: 0 };
  for (const observation of observations) {
    const rule = rules.find((rule) => rule.gate === observation.pair.gate);
    if (rule && classifyGateRepair(observation.pair, observation.repairDiff, rule.ownFiles, rule.gateRegex) === "genuine") tally.successes++;
  }
  if (!observations.length) return { actions: [], tally };
  const layout = resolveRepoLayout(deps.repoRoot);
  const queued = existsSync(layout.planMonolith) ? loadPlan(layout.planMonolith).tasks.filter((task) =>
    task.status === "queued" && !task.retirement).flatMap((task) => task.origin ? [task.origin] : []) : [];
  return { actions: gateRepairCandidates(observations, rules, [...queued, ...open], deps.log), tally };
}

/** The synchronous pass reads only what is injected: GitHub is read by {@link falsePositiveInventoryAsync}. */
function falsePositiveInventory(deps: GardenerDeps, probes: GateProbes, sources: GateDefuseSources): { actions: GateGardenAction[]; tally: Outcome } {
  if (!sources.repairObservations) return NO_REPAIRS();
  const rules = falsePositiveRules(probes, sources);
  return falsePositiveActions(deps, rules, sources.repairObservations(), sources.openOrigins?.() ?? []);
}

async function falsePositiveInventoryAsync(deps: GardenerDeps, probes: GateProbes, sources: GateDefuseSources): Promise<{ actions: GateGardenAction[]; tally: Outcome }> {
  if (!repairsAreWorthReading(deps, sources)) return NO_REPAIRS();
  const rules = falsePositiveRules(probes, sources);
  const observations = sources.repairObservations?.() ?? await loadGateRepairObservations(rules, sources);
  if (!observations.length) return falsePositiveActions(deps, rules, observations, []);
  const open = sources.openOrigins?.() ??
    ((await (sources.ghJson ?? ((args: string[]) => ghJsonAsync(args)))(["pr", "list", "--state", "open", "--limit", "1000", "--json", "body"])) as Array<{ body: string }>)
      .flatMap((pr) => [...pr.body.matchAll(/gate-false-positive:[^\s"'`]+/g)].map(([origin]) => origin));
  return falsePositiveActions(deps, rules, observations, open);
}

interface ExpiringFixture {
  file: string; line: number; stamp: string; field: string; threshold: string;
  expiresAt: number; daysLeft: number;
}

export interface GateDefuseSources {
  repairObservations?: () => readonly GateRepairObservation[];
  repairRules?: readonly GateRepairRule[];
  thresholdDays?: number;
  leadDays?: number;
  openOrigins?: () => string[];
  mintTaskId?: GardenTaskIdMinter;
  admissionViolations?: typeof machineFilingAdmissionViolations;
  execFile?: (command: string, args: string[], options: { cwd: string; encoding: "utf8" }) => string;
  /** W1-T9049: the awaited `gh` JSON/text reads of the false-positive pass; default the paced transport. */
  ghJson?: (args: string[]) => Promise<unknown>;
  ghText?: (args: string[]) => Promise<string>;
  /** Runs one test file with the clock shifted `shiftDays` ahead: true when it passes. Throws when
   *  the run reaches no verdict. Default {@link runSuiteShifted} in the repo checkout. */
  runSuite?: (file: string, shiftDays: number) => boolean;
}

/** W1-T6036: the control shift, nonzero so the control loads the same clock preload as the shifted run. */
export const DEFUSE_CONTROL_SHIFT_DAYS = 0.001;
export const DEFUSE_VERDICTS_FILE = "gate-gardener-defuse-verdicts.json";
const DEFUSE_RUN_TIMEOUT_MS = 15 * 60_000;
type DefuseVerdict = "confirmed" | "shifted_passed" | "control_failed";

export interface ShiftedSuiteMeasurement { passed: boolean; pass: number; tests: number }
interface ShiftedSuiteOptions {
  execFile?: (command: string, args: string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; encoding: "utf8"; stdio: "pipe"; timeout: number; maxBuffer: number;
  }) => string;
}

/** The slice of scripts/pure-test-pool.mjs (the test judge) the defuse run uses. A plain .mjs, so no types. */
interface DefuseJudge {
  prepareJudgedRun(options: { makeDir: () => string }): { args: string[]; env: Record<string, string>; read(): { tallyText: string; markerText: string } };
  judgedNodeTestArgs(args: readonly string[], judgedArgs: readonly string[]): string[];
  judgeRun(files: readonly string[], opts: { status: number; pool: boolean; root: string; tallyText: string; markerText: string }): { complete: boolean; given: number; reported: number; tests: number | null; failed: number | null };
  describeJudgedRun(role: string, verdict: { complete: boolean }, opts: { prefix: string }): string;
}
// Loaded from the orchestrator's own checkout when a defuse runs, never at import (sandboxes copy only src/).
const loadDefuseJudge = (): DefuseJudge => createRequire(import.meta.url)("../../scripts/pure-test-pool.mjs") as DefuseJudge;

export function runSuiteShifted(repoRoot: string, file: string, shiftDays: number, options: ShiftedSuiteOptions & { measure: true }): ShiftedSuiteMeasurement;
export function runSuiteShifted(repoRoot: string, file: string, shiftDays: number, options?: ShiftedSuiteOptions & { measure?: false }): boolean;
/** Shared runner: measured TAP counts prove a crossing (W1-T7812) only when the named file
 *  reaches its own summary (W1-T8380). A partial exit 0 reaches no verdict. */
export function runSuiteShifted(repoRoot: string, file: string, shiftDays: number, {
  execFile = execFileSync,
  measure = false,
}: ShiftedSuiteOptions & { measure?: boolean } = {}): ShiftedSuiteMeasurement | boolean {
  readFileSync(resolve(repoRoot, file)); // Node can report a green wrapper for a missing test path.
  const privateRoot = mkdtempSync(join(tmpdir(), "rmd-shifted-suite-"));
  try {
    const judge = loadDefuseJudge();
    const judged = judge.prepareJudgedRun({ makeDir: () => {
      const dir = join(privateRoot, "judge");
      mkdirSync(dir);
      return dir;
    } });
    const env: NodeJS.ProcessEnv = { ...process.env, FK_SHIFT_DAYS: String(shiftDays), TMPDIR: privateRoot };
    delete env.RMD_SELF_SYNC_DONE; // the test setup refuses to load under it (W1-T3069)
    delete env.NODE_TEST_CONTEXT; // inherited from a parent `node --test`, it makes this run report nothing and exit 0
    const args = judge.judgedNodeTestArgs(["--test", "--test-reporter=tap", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "--import", "./scripts/clock-shift.mjs", file], judged.args);
    // Niced and bounded (test-slot.ts), but no host-wide slot: one file, and a gardener pass must not queue behind coverage.
    const load = readHostLoad();
    const child = lowPriorityCommand(process.execPath, testRunArgv(args, testRunConcurrency(load, defaultTestSlots(load.cores))));
    const childEnv: NodeJS.ProcessEnv = { ...env, ...judged.env };
    // Shifted proof children are not part of the enclosing CI coverage measurement. Inheriting
    // NODE_V8_COVERAGE makes an intentional early-exit fixture corrupt the parent coverage report.
    childEnv.NODE_V8_COVERAGE = "";
    childEnv.NODE_OPTIONS = (childEnv.NODE_OPTIONS ?? "")
      .replace(/(^|\s)(?:"--experimental-test-coverage"|'--experimental-test-coverage'|--experimental-test-coverage)(?=\s|$)/g, "$1")
      .trim();
    if (!childEnv.NODE_OPTIONS) delete childEnv.NODE_OPTIONS;
    let output: string;
    let status = 0;
    try {
      output = execFile(child.file, child.args, { cwd: repoRoot, env: childEnv, encoding: "utf8", stdio: "pipe", timeout: DEFUSE_RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      const failure = error as { status?: unknown; signal?: unknown; stdout?: string | Buffer };
      if (typeof failure.status !== "number" || failure.status === 0 || failure.signal) throw error;
      status = failure.status;
      output = String(failure.stdout ?? "");
    }
    const count = (name: string): number => {
      const match = new RegExp(`^# ${name} (\\d+)\\s*$`, "m").exec(output);
      if (!match) throw new Error(`shifted suite ${file}: no # ${name} TAP summary`);
      const value = Number(match[1]);
      if (!Number.isSafeInteger(value)) throw new Error(`shifted suite ${file}: invalid # ${name} TAP count`);
      return value;
    };
    const tests = count("tests"), pass = count("pass"), fail = count("fail"), cancelled = count("cancelled");
    const skipped = count("skipped"), todo = count("todo");
    if (tests === 0 || cancelled > 0 || pass + fail === 0 || tests !== pass + fail + cancelled + skipped + todo || (status !== 0 && fail === 0) || (status === 0 && fail > 0)) {
      throw new Error(`shifted suite ${file}: incomplete TAP verdict (exit ${status}, tests ${tests}, pass ${pass}, fail ${fail}, cancelled ${cancelled})`);
    }
    const wrapper = `# Subtest: ${relative(repoRoot, resolve(repoRoot, file))}`;
    if (!output.split("\n").some((line) => line.startsWith("# Subtest: ") && line !== wrapper)) {
      throw new Error(`shifted suite ${file}: no named tests in TAP verdict`);
    }
    const verdict = judge.judgeRun([file], { status, pool: false, root: repoRoot, ...judged.read() });
    if (verdict.tests !== tests || verdict.failed !== fail) {
      throw new Error(`shifted suite ${file}: TAP counts disagree with the end-of-run tally (tests ${verdict.tests}, fail ${verdict.failed})`);
    }
    if (!verdict.complete && (status === 0 || verdict.reported !== verdict.given)) {
      throw new Error(`the run reaches no verdict: ${judge.describeJudgedRun("defuse", verdict, { prefix: "test-judge" })}`);
    }
    const measurement = { passed: status === 0, pass, tests };
    return measure ? measurement : measurement.passed;
  } finally {
    rmSync(privateRoot, { recursive: true, force: true });
  }
}

/** Census adapter; the gardener keeps its existing boolean seam. */
export function runSuiteShiftedMeasured(repoRoot: string, file: string, shiftDays: number, options: ShiftedSuiteOptions = {}): ShiftedSuiteMeasurement {
  return runSuiteShifted(repoRoot, file, shiftDays, { ...options, measure: true });
}

export type GateEdit =
  | { kind: "row"; key: string; to: number | null }
  | { kind: "demote"; gate: string; rationale: string }
  | { kind: "defuse"; finding: ExpiringFixture; leadDays: number; urgent: boolean }
  | { kind: "false-positive"; rule: GateRepairRule; observation: GateRepairObservation; classification: GateRepairClass }
  | { kind: "compress"; finding: CommentCompressionFinding };

export interface GateGardenAction extends GardenAction<GateGardenClass> {
  /** Repo-relative file the edit lands in. */
  file: string;
  edit: GateEdit;
}

export interface GateInventory {
  candidates: GateGardenAction[];
  /** Repaired and overridden refusals, summed over every fire-rate measurement seen so far. */
  tally: Outcome;
  repairTally?: Outcome;
}

export const CI_GATE_YML = ".github/workflows/ci-gate.yml";
export const GATE_GARDEN_LOG = "docs/gate-garden-log.md";

type Json = Record<string, unknown>;
const readJson = (path: string): Json => JSON.parse(readFileSync(path, "utf8")) as Json;

interface LedgerVerdict {
  shrunk: Array<{ path: string; to: number }>;
  removed: string[];
}

/** The ratchets' own measurement and evaluation functions. They are ES modules under scripts/, so
 *  they load once, asynchronously, before the (synchronous) gardener runs. */
export interface GateProbes {
  fp?: { GATE_REPAIR_RULES: readonly GateRepairRule[] };
  ss: { listSourceFiles: (r: string) => string[]; countLines: (t: string) => number; evaluateSourceSizeRatchet: (c: Json, b: Json) => LedgerVerdict };
  cl: { listMeasuredFiles: (r: string) => string[]; countCommentLines: (t: string, p: string) => { comments: number }; evaluateCommentLoadRatchet: (c: Json, b: Json) => LedgerVerdict };
  lb: { loadCorpus: (d: string) => unknown[]; computeActiveChars: (e: unknown[]) => { chars: number; activeCount: number } };
  gm: { readGateLists: (t: string) => { required: Set<string> }; evaluateGateMonotonic: (b: unknown, h: unknown) => { ok: boolean; detail: string } };
  ef?: { MARGIN_DAYS: number; censusExpiringFixtures: (opts: { files: string[]; readFile: (path: string) => string; now: number; thresholdDays: number; marginDays: number }) => { reported: ExpiringFixture[] } };
}

export async function loadGateProbes(root: string): Promise<GateProbes> {
  const load = async <T>(rel: string) => (await import(pathToFileURL(join(root, rel)).href)) as T;
  return {
    ss: await load("scripts/source-size-ratchet.mjs"),
    cl: await load("scripts/comment-load-ratchet.mjs"),
    lb: await load("scripts/learnings-budget-ratchet.mjs"),
    gm: await load("scripts/gate-monotonic-check.mjs"),
    ef: await load("scripts/expiring-fixture-census.mjs"),
    fp: await load("scripts/census-precheck.mjs"),
  };
}

function defuseCandidates(deps: GardenerDeps, probes: GateProbes, sources: GateDefuseSources): GateGardenAction[] {
  if (!probes.ef) throw new Error("gate gardener: expiring-fixture census probe is missing");
  const run = (cmd: string, args: string[]): string => sources.execFile
    ? sources.execFile(cmd, args, { cwd: deps.repoRoot, encoding: "utf8" })
    : execFileSync(cmd, args, { cwd: deps.repoRoot, encoding: "utf8" });
  const leadDays = sources.leadDays ?? DEFUSE_LEAD_DAYS;
  const files = run("git", ["ls-files", "test/*.test.ts"]).trim().split("\n").filter(Boolean);
  if (files.length === 0) return [];
  const layout = resolveRepoLayout(deps.repoRoot);
  const { reported } = probes.ef.censusExpiringFixtures({
    files, readFile: (path) => readFileSync(join(deps.repoRoot, path), "utf8"),
    now: (deps.clock ?? systemClock).now(), thresholdDays: sources.thresholdDays ?? loadPolicy(join(layout.planDir, "policy.yaml")).values.sweep.staleDays,
    marginDays: leadDays,
  });
  const byFile = new Map<string, ExpiringFixture>();
  for (const f of reported) {
    const prior = byFile.get(f.file);
    if (!prior || f.expiresAt < prior.expiresAt) byFile.set(f.file, f);
  }
  if (byFile.size === 0) return [];
  // W1-T9729: a retirement whose superseding task has not landed still covers its origin.
  const landed = (id: string) => hostWorktreeGit(deps.repoRoot, taskLandedArgs(id)).trim() !== "";
  const queued = existsSync(layout.planMonolith) ? loadPlan(layout.planMonolith).tasks
    .filter((t) => (t.status === "queued" && !t.retirement) || (t.origin?.startsWith("expiring-fixture:") === true && retirementHoldsOrigin(t, landed)))
    .map((t) => t.origin) : [];
  const open = sources.openOrigins ? sources.openOrigins() : (JSON.parse(run("gh", ["pr", "list", "--state", "open", "--limit", "1000", "--json", "body"])) as Array<{ body: string }>).flatMap((pr) => [...pr.body.matchAll(/expiring-fixture:test\/[^\s"'`]+\.test\.ts/g)].map((m) => m[0]));
  const covered = new Set([...queued, ...open]);
  const runSuite = sources.runSuite ?? ((file: string, days: number) => runSuiteShifted(deps.repoRoot, file, days));
  return [...byFile.values()].flatMap((finding): GateGardenAction[] => {
    const target = `expiring-fixture:${finding.file}`;
    if ([...covered].some((origin) => origin?.startsWith("expiring-fixture:") &&
      sameTestFile(origin.slice("expiring-fixture:".length), finding.file))) {
      deps.log("gate_garden.defuse_deferred", defuseEvidence(finding, leadDays));
      return [];
    }
    if (!confirmDefuse(deps, finding, run, runSuite)) return [];
    return [{ class: "defuse", target, file: finding.file,
      edit: { kind: "defuse", finding, leadDays, urgent: finding.daysLeft <= probes.ef!.MARGIN_DAYS },
      reason: `${finding.file}:${finding.line} crosses ${finding.threshold} on ${fixedClock(finding.expiresAt).iso()} (${leadDays}-day lead).` }];
  });
}

/** Reuse the gate gardener's normal reservation, admission, plan-PR and decision path. */
export function commentCompressionCandidates(deps: GardenerDeps, probes: GateProbes, sources: GateDefuseSources = {}): GateGardenAction[] {
  const findings = probes.cl.listMeasuredFiles(deps.repoRoot).map(file => ({ file,
    comments: probes.cl.countCommentLines(readFileSync(join(deps.repoRoot, file), "utf8"), file).comments }));
  if (!nextCommentCompression(findings, new Set())) return [];
  const layout = resolveRepoLayout(deps.repoRoot);
  if (!existsSync(layout.planMonolith)) throw new Error("comment compression plan context is unreadable");
  const shardDir = join(layout.planDir, "tasks.d");
  if (lstatSync(shardDir, { throwIfNoEntry: false })) readdirSync(shardDir);
  const tasks = loadPlanForLayout(layout).tasks;
  const held = new Set<string>();
  // An unresolved retirement stays held; this nomination makes no claim that a task shipped.
  for (const task of tasks) {
    if (task.origin?.startsWith("comment-compression:") && ((task.status === "queued" && !task.retirement) || retirementHoldsOrigin(task, () => false))) held.add(task.origin);
    if (task.status === "queued" && !task.retirement && /(?:compress|compact|fold).*comment|comment.*(?:compress|compact|fold)/i.test(task.title)) {
      for (const file of task.files ?? []) held.add(commentCompressionOrigin(file));
    }
  }
  if (!nextCommentCompression(findings, held)) return [];
  if (!sources.openOrigins) throw new Error("comment compression requires an awaited open-PR inventory");
  const open = sources.openOrigins();
  for (const origin of open) held.add(origin);
  const finding = nextCommentCompression(findings, held);
  return finding ? [{ class: "compress", target: commentCompressionOrigin(finding.file), file: finding.file,
    edit: { kind: "compress", finding }, reason: `${finding.comments} comment lines nominate high-priority follow-up; the originating change is not blocked.` }] : [];
}

/**
 * W1-T6036: a field-name census is a CANDIDATE generator. Measured 2026-10-06, the widened census
 * named 22 `updated_at`/`updatedAt` rows that no threshold ages, so a finding is filed only when its
 * file passes at the control shift and fails shifted one day past the crossing. Anything else is
 * ledgered `gate_garden.defuse_unconfirmed`. A verdict is remembered per blob and crossing day; a
 * run with no verdict is ledgered `run_error` and retried next pass, never read as red.
 */
function confirmDefuse(deps: GardenerDeps, f: ExpiringFixture, run: (cmd: string, args: string[]) => string, runSuite: (file: string, days: number) => boolean): boolean {
  const crossingDate = fixedClock(f.expiresAt).iso();
  const evidence = { file: f.file, line: f.line, crossingDate };
  const path = join(deps.stateDir, DEFUSE_VERDICTS_FILE);
  const memo = (existsSync(path) ? readJson(path) : {}) as Record<string, DefuseVerdict>;
  const key = `${run("git", ["hash-object", "--", f.file]).trim()}:${crossingDate.slice(0, 10)}`;
  let verdict = memo[key];
  if (!verdict) {
    try {
      verdict = !runSuite(f.file, DEFUSE_CONTROL_SHIFT_DAYS) ? "control_failed"
        : runSuite(f.file, Math.ceil(f.daysLeft) + 1) ? "shifted_passed" : "confirmed";
    } catch (e) {
      deps.log("gate_garden.defuse_unconfirmed", { ...evidence, outcome: "run_error", error: String(e) });
      return false;
    }
    writeAtomic(path, JSON.stringify({ ...memo, [key]: verdict }, null, 2) + "\n");
    if (verdict !== "confirmed") deps.log("gate_garden.defuse_unconfirmed", { ...evidence, outcome: verdict });
  }
  return verdict === "confirmed";
}

function defuseEvidence(f: ExpiringFixture, leadDays: number): Record<string, unknown> {
  return { file: f.file, line: f.line, crossingDate: fixedClock(f.expiresAt).iso(), leadDays };
}

/** `s` as a BRE matching itself under the executor's `grep -arn`: one pass over a class holding the
 *  backslash, so an escape this adds is never itself re-escaped and a `\` in a path stays literal. */
function breLiteral(s: string): string {
  return s.replace(/[\\.*[^$]/g, "\\$&");
}

function commentCompressionSlug(file: string): string {
  return `compress-${file.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

export function renderCommentCompressionShard(finding: CommentCompressionFinding, taskId: string) {
  const testFile = newTestPath(commentCompressionSlug(finding.file), [finding.file], finding.file);
  const rendered = renderMachineShard({
    taskId, title: `Compress the ${finding.comments} comment lines in ${finding.file} without changing executable code`,
    origin: commentCompressionOrigin(finding.file), files: [finding.file, testFile],
    acceptance: [{ claim: "Comment volume is measurably reduced while executable tokens and existing behavioral assertions are preserved.",
      proof: `unit test: ${taskId}: comment compression preserves executable code` }],
    rationale: [
      `Observed ${finding.comments} comment lines in ${finding.file}. This is maintenance debt, never a merge ceiling.`,
      "Operator 2026-10-24: excess comments create high-priority follow-up work; they must not block the originating change.",
      "Compress repeated explanations. Preserve displaced historical detail in the PR review record and retain its citation; keep invariants, traps, falsifiers and text pinned by existing tests.",
      `Add the named regression in ${testFile}; compare executable tokens against the pre-compression source and verify a real comment-count reduction.`,
      "Preserve every existing behavioral assertion and run the actual callers. Do not invent a new hard comment ceiling or claim success from a title-only proof.",
      "Preserve existing owners, stops and deployment holds. This maintenance task grants no service restart, release or publication override.",
    ],
  });
  // This operator-set priority is explicit, rather than an invented measured-cost population.
  return { ...rendered, text: rendered.text.replace("  status: queued\n", "  priority: 1\n  status: queued\n") };
}

export function renderDefuseShard(action: GateGardenAction, taskId: string) {
  if (action.edit.kind === "compress") return renderCommentCompressionShard(action.edit.finding, taskId);
  if (action.edit.kind !== "defuse") throw new Error("gate gardener: mixed defuse plan");
  const { finding: f, leadDays, urgent } = action.edit;
  const crossing = fixedClock(f.expiresAt).iso();
  const title = `${taskId}: ${f.file} stays defused across ${crossing}`;
  return renderMachineShard({
    taskId, title: `Defuse the expiring fixture in ${f.file} before ${crossing}`, origin: action.target,
    files: [f.file], cost: 1, costPopulation: urgent ? [0, 1] : [1],
    acceptance: [{ claim: `The census reports no crossing for ${f.file} with now past ${crossing}, and the test remains green across the crossing.`,
      proof: `grep: test("${breLiteral(title)}" in ${f.file}` }],
    rationale: [
      `${f.file}:${f.line}: ${f.field} is stamped ${f.stamp}; ${f.threshold} crosses on ${crossing}.`,
      `Found ${f.daysLeft} days before crossing using a ${leadDays}-day lead horizon.`,
      "Use an exemption only when this case is judged against an injected clock; prove it by ageing the fixture across the threshold and rerunning the test, as #8673 did.",
      "Otherwise make the stamp relative to the test's clock. Moving a fixed date only re-arms the fixture.",
      "Add the task's regression to this fixture file: run the census immediately before and after crossing, and run the affected case at both clocks.",
    ],
  });
}

function prepareDefuseTaskIds(ws: GardenCheckout, count: number, deps: GardenerDeps, sources: GateDefuseSources, async = false) {
  if (async && count > 0 && !sources.mintTaskId) throw new Error("gate gardener: async task-id minter is required for defuse filing");
  return prepareGardenTaskIds(ws, count, sources.mintTaskId ?? ((branch) => {
    const args = ["--import", "tsx", join(deps.repoRoot, "src/run-task.ts"), "next-task-id", "--reserve", "--branch", branch];
    const output = sources.execFile
      ? sources.execFile(process.execPath, args, { cwd: deps.repoRoot, encoding: "utf8" })
      : execFileSync(process.execPath, args, { cwd: deps.repoRoot, encoding: "utf8" });
    const id = /^RESERVED (W1-T\d+) on origin/m.exec(output)?.[1];
    if (!id) throw new Error("gate gardener: task-id reservation returned no held id");
    return id;
  }), async);
}

function assertDefuseAdmission(action: GateGardenAction, deps: GardenerDeps, sources: GateDefuseSources): void {
  const draft = action.edit.kind === "false-positive" ? renderFalsePositiveShard(action, "NEW-1") : renderDefuseShard(action, "NEW-1");
  if (draft.refused) throw new Error(`gate gardener: defuse shard refused (${draft.refused})`);
  const plan = loadPlanFromYaml(draft.text, "defuse-admission");
  const reasons = (sources.admissionViolations ?? machineFilingAdmissionViolations)(plan.tasks[0]!, {
    plan, releasedIds: new Set(), pathExists: (path) => existsSync(join(deps.repoRoot, path)),
  });
  if (reasons.length) throw new Error(`gate gardener: defuse shard refused (machine-filing-admission: ${reasons.join("; ")})`);
}

function applyDefuseActions(ws: GardenCheckout, actions: GateGardenAction[], deps: GardenerDeps, sources: GateDefuseSources, heldIds?: readonly string[]) {
  if (!ws.branch) throw new Error("gate gardener: filing workspace has no branch for task-id reservation");
  const paths: string[] = [];
  for (const [index, action] of actions.entries()) {
    assertDefuseAdmission(action, deps, sources);
    const taskId = heldIds ? heldIds[index] : (prepareDefuseTaskIds(ws, 1, deps, sources) as string[])[0];
    if (!taskId) throw new Error("gate gardener: task-id reservation returned no held id");
    const rendered = action.edit.kind === "false-positive" ? renderFalsePositiveShard(action, taskId) : renderDefuseShard(action, taskId);
    if (rendered.refused) throw new Error(`gate gardener: defuse shard refused (${rendered.refused})`);
    const stem = action.file.replace(/^test\//, "").replace(/\.test\.ts$/, "").replace(/[^a-zA-Z0-9-]/g, "-");
    const path = join(resolveRepoLayout(ws.root).planDir, "tasks.d", `${taskId}-${action.edit.kind === "compress" ? commentCompressionSlug(action.file) : `${action.edit.kind}-${stem}`}.yaml`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, rendered.text);
    paths.push(relative(ws.root, path));
  }
  const land = ws.land.bind(ws);
  ws.land = (opts) => {
    const url = land(opts);
    if (url) for (const a of actions) {
      if (a.edit.kind === "defuse") deps.log("gate_garden.defuse_filed", defuseEvidence(a.edit.finding, a.edit.leadDays));
      if (a.edit.kind === "false-positive") deps.log("gate.false_positive_filed", { gate: a.edit.rule.gate, recognizer: a.file, classification: a.edit.classification });
      if (a.edit.kind === "compress") deps.log("gate_garden.comment_compression_filed", { file: a.edit.finding.file, observed_comments: a.edit.finding.comments, priority: 1, origin: a.target });
    }
    return url;
  };
  const subject = actions[0]?.class === "false-positive" ? "gate recognizer" : actions[0]?.class === "compress" ? "comment compression" : "expiring fixture";
  return { paths, title: `chore(plan): file ${actions.length} ${subject} remedy task(s)`, body: [
    "The gate gardener files measured maintenance follow-ups through normal machine-filing admission.", "", "## Acceptance",
    ...actions.flatMap((a, i) => [`- claim: ${a.target} has a machine-filed remedy`, `  proof: grep: ${a.target} in ${paths[i]}`]),
  ].join("\n") };
}

/** TIGHTEN and REFRESH rows for the two per-file ledgers, from each ratchet's own evaluation. */
function ledgerCandidates(root: string, { ss }: GateProbes): GateGardenAction[] {
  const measured: Array<{ file: string; verdict: LedgerVerdict }> = [];
  const lines: Json = {};
  for (const p of ss.listSourceFiles(root)) lines[p] = ss.countLines(readFileSync(join(root, p), "utf8"));
  measured.push({ file: "scripts/source-size-baseline.json", verdict: ss.evaluateSourceSizeRatchet(lines, readJson(join(root, "scripts/source-size-baseline.json"))) });
  return measured.flatMap(({ file, verdict }) => [
    ...verdict.shrunk.map((s): GateGardenAction => ({ class: "tighten", target: `${file}#${s.path}`, file, edit: { kind: "row", key: s.path, to: s.to }, reason: `The file shrank a whole bucket; the ratchet now records ${s.to}.` })),
    ...verdict.removed.map((path): GateGardenAction => ({ class: "refresh", target: `${file}#${path}`, file, edit: { kind: "row", key: path, to: null }, reason: "The file no longer exists." })),
  ]);
}

/** REFRESH for the learnings baseline's recorded measurement; the cap is left alone. */
function learningsCandidates(root: string, { lb }: GateProbes): GateGardenAction[] {
  const file = "scripts/learnings-budget-baseline.json";
  const now = lb.computeActiveChars(lb.loadCorpus(resolveRepoLayout(root).learningsDir));
  const recorded = readJson(join(root, file));
  const rows: Array<[string, number]> = [["measuredChars", now.chars], ["measuredActiveEntries", now.activeCount]];
  return rows
    .filter(([key, value]) => typeof recorded[key] === "number" && recorded[key] !== value)
    .map(([key, value]) => ({ class: "refresh", target: `${file}#${key}`, file, edit: { kind: "row", key, to: value }, reason: `The recorded ${key} is ${String(recorded[key])}; the corpus measures ${value}.` }));
}

/** DEMOTE: the REQUIRED gate that never refused over at least the median number of pull requests a
 *  gate is seen on, costing the most minutes — one per pass, since each is a person's decision. */
export function demotionCandidate(report: GateFireRateReport & { measuredAt?: string }, required: Set<string>): GateGardenAction | undefined {
  if (report.status !== "measured") return undefined;
  const prs = report.gates.map((g) => g.prs).sort((a, b) => a - b);
  const typical = prs[Math.floor(prs.length / 2)] ?? 0;
  const quiet = report.gates
    .filter((g) => report.neverFired.includes(g.gate) && required.has(g.gate) && g.prs >= typical)
    .sort((a, b) => b.minutes - a.minutes || b.prs - a.prs);
  const g: GateFireRate | undefined = quiet[0];
  if (!g) return undefined;
  const rationale = `W1-T4116 gate gardener: ${g.gate} refused 0 of ${g.runs} runs on ${g.prs} pull requests (measured ${report.measuredAt ?? "unknown"}, ${g.minutes} min).`;
  return { class: "demote", target: g.gate, file: CI_GATE_YML, edit: { kind: "demote", gate: g.gate, rationale }, reason: `It never refused on ${g.prs} pull requests and cost ${g.minutes} CI minutes.` };
}

/** Fold each NEW fire-rate measurement into a running tally once, so the metric only grows. */
export function updateTally(stateDir: string, report: (GateFireRateReport & { measuredAt?: string }) | undefined): Outcome {
  const path = join(stateDir, "gate-gardener-tally.json");
  const tally = existsSync(path) ? (readJson(path) as { seen: string[]; trials: number; successes: number }) : { seen: [], trials: 0, successes: 0 };
  if (report?.status === "measured" && report.measuredAt && !tally.seen.includes(report.measuredAt)) {
    for (const g of report.gates) {
      tally.trials += g.repaired + g.overridden;
      tally.successes += g.repaired;
    }
    tally.seen.push(report.measuredAt);
    writeAtomic(path, JSON.stringify(tally, null, 2) + "\n");
  }
  return { trials: tally.trials, successes: tally.successes };
}

export function gateInventory(repoRoot: string, stateDir: string, probes: GateProbes): GateInventory {
  const reportPath = gateFireRatesPath(stateDir);
  const report = existsSync(reportPath) ? (readJson(reportPath) as unknown as GateFireRateReport & { measuredAt?: string }) : undefined;
  // The REQUIRED list, read by the gate-monotonic check itself.
  const required = probes.gm.readGateLists(readFileSync(join(repoRoot, CI_GATE_YML), "utf8")).required;
  const demote = report ? demotionCandidate(report, required) : undefined;
  const candidates = [...ledgerCandidates(repoRoot, probes), ...learningsCandidates(repoRoot, probes), ...(demote ? [demote] : [])];
  return { candidates, tally: updateTally(stateDir, report) };
}

/** Move one gate from REQUIRED to ADVISORY in ci-gate.yml and set a fresh GATE_RATIONALE. */
export function demoteInCiGate(text: string, gate: string, rationale: string): string {
  const listRe = (name: string) => new RegExp(`(^ {6}${name}: >-\\n {8}\\[\\n)([\\s\\S]*?)(\\n {8}\\])`, "m");
  const items = (body: string) => body.split("\n").map((l) => l.trim().replace(/,$/, "")).filter(Boolean);
  const render = (list: string[]) => list.map((q, i) => `        ${q}${i < list.length - 1 ? "," : ""}`).join("\n");
  const quoted = JSON.stringify(gate);
  const req = listRe("REQUIRED").exec(text);
  const adv = listRe("ADVISORY").exec(text);
  if (!req || !adv || !items(req[2]!).includes(quoted)) throw new Error(`ci-gate.yml: ${gate} is not in a readable REQUIRED list`);
  let out = text.replace(listRe("REQUIRED"), (_m, a: string, b: string, c: string) => a + render(items(b).filter((q) => q !== quoted)) + c);
  out = out.replace(listRe("ADVISORY"), (_m, a: string, b: string, c: string) => a + render([...items(b), quoted]) + c);
  const line = `      GATE_RATIONALE: ${JSON.stringify(rationale)}`;
  return /^ {6}GATE_RATIONALE: .*$/m.test(out) ? out.replace(/^ {6}GATE_RATIONALE: .*$/m, line) : out.replace(/^( {6}ADVISORY: >-)$/m, `${line}\n$1`);
}

/** Set (or, for `null`, remove) one numeric row, editing only that line when the file does not
 *  round-trip through JSON.stringify unchanged. */
export function editBaselineRow(text: string, key: string, to: number | null): string {
  const parsed = JSON.parse(text) as Json;
  if (JSON.stringify(parsed, null, 2) + "\n" === text) {
    if (to === null) delete parsed[key];
    else parsed[key] = to;
    return JSON.stringify(parsed, null, 2) + "\n";
  }
  if (to === null) throw new Error(`cannot remove ${key} from a baseline that does not round-trip`);
  const re = new RegExp(`("${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*)-?\\d+(?:\\.\\d+)?`);
  if (!re.test(text)) throw new Error(`no numeric row ${key}`);
  return text.replace(re, `$1${to}`);
}

function logSection(heading: string, actions: GateGardenAction[]): string {
  return ["", heading, "", ...actions.map((a) => `- ${a.class} ${a.target}: ${a.reason}`), ""].join("\n");
}

export function applyGateActions(root: string, actions: GateGardenAction[], heading: string, { gm }: GateProbes): string[] {
  const byFile = new Map<string, GateGardenAction[]>();
  for (const a of actions) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a]);
  for (const [file, list] of byFile) {
    let text = readFileSync(join(root, file), "utf8");
    for (const a of list) {
      if (a.edit.kind === "defuse" || a.edit.kind === "false-positive" || a.edit.kind === "compress") throw new Error("follow-up actions require machine filing");
      text = a.edit.kind === "row" ? editBaselineRow(text, a.edit.key, a.edit.to) : demoteInCiGate(text, a.edit.gate, a.edit.rationale);
    }
    if (file === CI_GATE_YML) {
      // The gate-monotonic check itself must read the result as a REVIEWED demotion.
      const verdict = gm.evaluateGateMonotonic(gm.readGateLists(readFileSync(join(root, file), "utf8")), gm.readGateLists(text));
      if (!verdict.ok) throw new Error(`gate-monotonic would refuse: ${verdict.detail}`);
    }
    writeFileSync(join(root, file), text);
  }
  const logPath = join(root, GATE_GARDEN_LOG);
  const prior = existsSync(logPath) ? readFileSync(logPath, "utf8") : "# Gate garden log\n\nEach section is one pass of the gate gardener (W1-T4116).\n";
  writeAtomic(logPath, prior.replace(/\n*$/, "\n") + logSection(heading, actions));
  return [...byFile.keys(), GATE_GARDEN_LOG].sort();
}

function prBody(actions: GateGardenAction[], heading: string): string {
  const proofs = actions.flatMap((a) => a.edit.kind === "defuse" || a.edit.kind === "false-positive" || a.edit.kind === "compress" ? [] :
    a.edit.kind === "demote"
      ? [`- claim: ${a.edit.gate} is moved to ADVISORY with a reviewed rationale`, `  proof: grep: GATE_RATIONALE: "W1-T4116 gate gardener: ${a.edit.gate} refused 0 in ${CI_GATE_YML}`]
      : a.edit.to === null
        ? []
        : [`- claim: ${a.target} records ${a.edit.to}`, `  proof: grep: "${a.edit.key}": ${a.edit.to} in ${a.file}`],
  );
  return [
    "The gate gardener (W1-T4116) tends the repo's gates from their own measurements.",
    "",
    ...actions.map((a) => `- **${a.class}** \`${a.target}\`: ${a.reason}`),
    "",
    "## Acceptance",
    "- claim: this pass is recorded in the gate garden log",
    `  proof: grep: ^${heading}$ in ${GATE_GARDEN_LOG}`,
    ...proofs,
  ].join("\n");
}

/** The repo's gates as a gardener spec, over probes loaded by {@link loadGateProbes}. */
export function gateGardenSpec(deps: GardenerDeps, probes: GateProbes, sources: GateDefuseSources = {}): GardenSpec<GateGardenClass, GateInventory, GateGardenAction, GardenCheckout> {
  const clock = deps.clock ?? systemClock;
  const localInventory = (input: GateDefuseSources): GateInventory => {
    const inv = gateInventory(deps.repoRoot, deps.stateDir, probes);
    if (!existsSync(join(deps.stateDir, "GATE_OFF-defuse"))) inv.candidates.push(...defuseCandidates(deps, probes, input));
    if (!existsSync(join(deps.stateDir, "GATE_OFF-compress"))) inv.candidates.push(...commentCompressionCandidates(deps, probes, input));
    return inv;
  };
  const falsePositiveOff = (): boolean => existsSync(join(deps.stateDir, "GATE_OFF-false-positive"));
  return {
    name: "gate",
    landingRefusal: machineShardLandingGuard({ ...deps, admissionViolations: sources.admissionViolations }),
    classes: GATE_GARDEN_CLASSES,
    review: { demote: "demoting a required gate stops it blocking merges, which is a judgement call." },
    decision: ["defuse", "compress"],
    cheapFingerprint: () => {
      const head = checkoutHeadStamp(deps.repoRoot, clock);
      const report = gateFireRatesPath(deps.stateDir);
      return `${head}:${existsSync(report) ? readFileSync(report, "utf8").length : 0}:${clock.iso().slice(0, 10)}`;
    },
    inventory: () => {
      const inv = localInventory(sources);
      if (!falsePositiveOff()) {
        const repairs = falsePositiveInventory(deps, probes, sources);
        inv.candidates.push(...repairs.actions);
        inv.repairTally = repairs.tally;
      }
      return inv;
    },
    // W1-T9049: the daemon's pass reads GitHub for repair evidence awaited, never as a blocking spawn.
    ...(sources.openOrigins ? {} : { inventoryAsync: async () => {
      let input = sources;
      if (!sources.openOrigins && !existsSync(join(deps.stateDir, "GATE_OFF-compress")) &&
          commentCompressionCandidates(deps, probes, { ...sources, openOrigins: () => [] }).length > 0) {
        const origins = await readGateFollowupOrigins(deps.repoRoot);
        input = { ...sources, openOrigins: () => origins };
      }
      const inv = localInventory(input);
      if (!falsePositiveOff()) {
        const repairs = await falsePositiveInventoryAsync(deps, probes, sources);
        inv.candidates.push(...repairs.actions);
        inv.repairTally = repairs.tally;
      }
      return inv;
    } }),
    fingerprint: (inv) => inv.candidates.map((a) => a.target).join(","),
    metric: (inv, actionClass) => actionClass === "false-positive" ? inv.repairTally ?? { trials: 0, successes: 0 } : inv.tally,
    candidates: (inv) => inv.candidates,
    scorecard: (inv, plan) => ({ candidates: inv.candidates.length, tally: inv.tally, proposed: plan.actions.length }),
    prepare: (ws, plan, async) => {
      const actions = plan.acting[0] === "defuse" || plan.acting[0] === "false-positive" || plan.acting[0] === "compress" ? plan.actions : [];
      for (const action of actions) assertDefuseAdmission(action, deps, sources);
      return prepareDefuseTaskIds(ws, actions.length, deps, sources, async);
    },
    apply: (ws, plan, _scorecard, heldIds) => {
      if (plan.acting[0] === "defuse" || plan.acting[0] === "false-positive" || plan.acting[0] === "compress") return applyDefuseActions(ws, plan.actions, deps, sources, heldIds);
      const heading = `## Pass ${clock.iso()}`;
      const paths = applyGateActions(ws.root, plan.actions, heading, probes);
      return { paths, title: `chore(gates): the gate gardener proposes to ${plan.acting[0]} ${plan.actions.length} gate row(s)`, body: prBody(plan.actions, heading) };
    },
  };
}
