import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";

import { backlogCitedSteps } from "./backlog-gardener.js";
import { clockFromMillisFn, systemClock, type Clock } from "./clock.js";
import { CI_FRICTION_LEDGER_STEPS } from "./ci-friction-gardener.js";
import { slug } from "./feedback-docket.js";
import { loadPlanFromYaml, newTestPath, type Task } from "./plan.js";
import { prepareGardenTaskIds, gardenLedgerBucket, type GardenTaskIdMinter, type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec, type Outcome } from "./gardener.js";
import { readMainHistory } from "./hot-file-gardener.js";
import { ghTextAsync } from "./github-transport.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import {
  machineShardDesign, machineShardFilingRefusal, machineShardInvariantClaims, machineShardLandingGuard,
  machineShardLintRefusal, renderMachineShard, withoutRulingBlock, type MachineShardInvariant, type MachineShardPaths,
} from "./machine-filing.js";
import { INVARIANT_DECL_RE, NO_INVARIANTS_RE } from "./task-linter.js";
import { planCheapFingerprint, planInventory, type PlanInventory } from "./plan-gardener.js";
import { parseOwnerRepoFromRemoteUrl } from "./onboard/inventory.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { hostWorktreeGit, hostWorktreeGitAsync } from "./worktree-git.js";

/**
 * lib/scout-gardener.ts (W1-T5454) — the fleet looks for work nobody has asked for.
 *
 * Every other gardener tends what already exists and reacts to one narrow signal. This one starts from
 * the ledger as a whole: a step whose name carries a failure shape (`failed`, `refused`, `unavailable`,
 * `escalated`, `unhealthy`) that keeps landing rows in BOTH halves of the trailing window, and that no
 * queued task, no recently merged task and no gardener's own scorecard accounts for, is filed through
 * the shared machine-filing path. The machine-filing judge rules on the record; this module never
 * chooses `verify:` or `risk:`.
 *
 * One class only (`file-uncovered-symptom`). It is judged by SURVIVAL, not by merge: after a scout-filed
 * task merges and a full window has passed, the symptom's rows in that window against the window before
 * the merge decide the verdict, so the class's Beta record cannot be earned by churn.
 */

/** The one class this gardener acts in. */
export type ScoutClass = "file-uncovered-symptom";
export const SCOUT_CLASSES: readonly ScoutClass[] = ["file-uncovered-symptom"];

/** The trailing window the inventory reads; each half of it is counted separately. */
export const SCOUT_WINDOW_MS = 7 * 24 * 3_600_000;
/** How long after a scout-filed task merges its symptom is measured, and the window it is measured against. */
export const SCOUT_SURVIVAL_WINDOW_MS = SCOUT_WINDOW_MS;
/** A merged task covers a symptom for this long; also how far back merged tasks are read. */
export const SCOUT_MERGED_COVERAGE_MS = SCOUT_WINDOW_MS;
/** A scout pass is at most hourly: the signal it reads moves in days, not minutes. */
export const SCOUT_MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * BACKSTOP, not the control (W1-T5454): the scout files nothing while more than this share of the open
 * queue carries no declared priority. The queue grew 225 to 266 in a day while 32 tasks merged
 * (W1-T4941), so a producer needs a bound that does not depend on its own judgement being right. The
 * backlog gardener places every unprioritized task but names no share target of its own at this HEAD,
 * so this is the scout's own figure; a backlog target, if one is ever added, should replace it.
 */
export const SCOUT_UNPRIORITIZED_SHARE_BOUND = 0.25;

/** Step names that carry a failure shape. Only dotted names are considered: a cited step must be citable. */
const FAILURE_SHAPE = /failed|refused|unavailable|escalated|unhealthy/;
const DOTTED_STEP = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const EXPECTED_RECOVERY_STEP = "inbox.draft_escalated";
const DRAFT_ERROR_STEPS = new Set(["inbox.draft_error", "inbox.draft_escalation_error"]);
/** W1-T12842: the author preflight's own verdict rows (scripts/preflight-author.mjs), named so a rename cannot drop them. */
export const AUTHOR_PREFLIGHT_SYMPTOM_STEPS: readonly string[] = ["author_preflight.refused", "author_preflight.failed"];
/** A raw-line prefilter for the ledger read, so only failure-shaped rows are ever parsed. */
const FAILURE_ROW = /"step":"(?:inbox\.draft_(?:escalation_)?error|[^"]*(?:failed|refused|unavailable|escalated|unhealthy)[^"]*)"/;

export const scoutOrigin = (step: string): string => `scout:${step}`;

export function isFailureShapedStep(step: string): boolean {
  return DOTTED_STEP.test(step) && step !== EXPECTED_RECOVERY_STEP &&
    (DRAFT_ERROR_STEPS.has(step) || AUTHOR_PREFLIGHT_SYMPTOM_STEPS.includes(step) || FAILURE_SHAPE.test(step));
}

export interface ScoutSymptom {
  step: string;
  /** Rows in the older half of the window. */
  older: number;
  /** Rows in the newer half. */
  newer: number;
  total: number;
  /** Repo paths the rows themselves name in `file` or `module`, when they exist. */
  files: string[];
  /** W1-T13208: `files` came from a merged investigation of this step, not from the rows. */
  investigated?: boolean;
}

export interface ScoutAction extends GardenAction<ScoutClass> {
  symptom: ScoutSymptom;
  origin: string;
  draft?: { id: string; path: string; files: string[]; investigation?: boolean };
}

export interface ScoutInventory {
  rederive: ScoutAction[];
  /** W1-T13208: the queued fix drafts that declare only a test file, by why each was left alone. */
  testOnlyDrafts: ScoutLeftDrafts;
  symptoms: ScoutSymptom[];
  covered: string[];
  uncovered: ScoutSymptom[];
  /** The uncovered symptoms this pass may file, costliest first, at most `budget`. */
  selected: ScoutSymptom[];
  /** Tasks the fleet merged in the trailing day: the most one pass may file. */
  budget: number;
  openQueue: number;
  unprioritizedShare: number;
  blocked: boolean;
  survival: Outcome;
  tracked: Array<{ step: string; task: string; verdict: "credit" | "debit" | "pending" | "unmerged" | "investigation"; before?: number; after?: number }>;
}

export interface ScoutSources {
  clock: Clock;
  repoRoot: string;
  /** Failure-shaped rows since the given instant, or exactly the given steps' rows when `steps` is set. */
  ledger: (sinceIso: string, steps?: readonly string[]) => readonly Record<string, unknown>[];
  plan: () => PlanInventory;
  /** Task id → the instant its merge reached main, for merges since the given instant. */
  mergedTasks: (sinceIso: string) => ReadonlyMap<string, number>;
  mergedLastDay: () => number;
  /** Steps a gardener's own scorecard already prices: covered by definition. */
  pricedSteps: () => ReadonlySet<string>;
  fileExists: (path: string) => boolean;
  /** THE RESERVATION PATH (`ciLearningTaskIdMinter`, run-task.ts), never `max(id)+1`. */
  mintTaskId: GardenTaskIdMinter;
  /** Open run PRs, read completely; a failed read must stop draft rewrites. */
  openRunTasks?: () => ReadonlySet<string>;
}

/** Rank only tracked source string literals, never paths guessed from the step name. */
function scoutSourceTexts(repoRoot: string): Array<{ path: string; text: string }> {
  const paths = hostWorktreeGit(repoRoot, ["ls-files", "-z", "--", "src/", "scripts/"]).split("\0").filter(Boolean);
  return paths.map((path) => ({ path, text: readFileSync(join(repoRoot, path), "utf8") }));
}

/** Count only scanner literals; an unrecognized non-advancing token is unavailable evidence. */
export function countScoutStepLiterals(path: string, text: string, step: string,
  scanner = createScanner(true, undefined, text)): number {
  let count = 0;
  const templateBraces: number[] = [];
  let previous = "=";
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    if ((token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) &&
        /^(?:=|\(|\[|\{|,|:|\?|return|case|=>|!|&&|\|\||\?\?)$/.test(previous)) token = scanner.reScanSlashToken();
    if (token === SyntaxKind.PrivateIdentifier && scanner.getTokenEnd() === scanner.getTokenStart()) {
      token = scanner.reScanHashToken();
      // A bare hash is a script comment; private identifiers already advance normally.
      const newline = text.indexOf("\n", scanner.getTokenEnd());
      scanner.resetTokenState(newline < 0 ? text.length : newline + 1);
      continue;
    }
    if (token === SyntaxKind.TemplateHead) templateBraces.push(0);
    else if (token === SyntaxKind.OpenBraceToken && templateBraces.length > 0) templateBraces[templateBraces.length - 1]++;
    else if (token === SyntaxKind.CloseBraceToken && templateBraces.length > 0) {
      if (templateBraces[templateBraces.length - 1] === 0) {
        token = scanner.reScanTemplateToken(false);
        if (token === SyntaxKind.TemplateTail) templateBraces.pop();
      } else templateBraces[templateBraces.length - 1]--;
    }
    if (scanner.getTokenEnd() <= scanner.getTokenStart()) {
      throw new Error(`scout gardener: source scanner did not advance in ${path} at ${scanner.getTokenStart()}`);
    }
    if ((token === SyntaxKind.StringLiteral || token === SyntaxKind.NoSubstitutionTemplateLiteral) && scanner.getTokenValue() === step) count++;
    previous = scanner.getTokenText();
  }
  return count;
}

function scoutWriters(repoRoot: string, step: string, corpus = scoutSourceTexts(repoRoot)): string[] {
  return corpus.map(({ path, text }) => ({ path, count: countScoutStepLiterals(path, text, step) }))
    .filter((f) => f.count > 0).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, 3).map((f) => f.path);
}

async function openScoutRuns(repoRoot: string): Promise<ReadonlySet<string>> {
  const remote = await hostWorktreeGitAsync(repoRoot, ["remote", "get-url", "origin"]);
  const repo = parseOwnerRepoFromRemoteUrl(remote.trim());
  if (!repo) throw new Error("scout gardener: origin does not identify a GitHub repository");
  const heads = await ghTextAsync(["api", "--paginate", `repos/${repo.owner}/${repo.repo}/pulls?state=open&per_page=100`, "--jq", ".[].head.ref"]);
  return new Set(heads.split("\n").flatMap((head) => /^run-(W\d+-T\d+)-\d+$/.exec(head.trim())?.[1] ?? []));
}

function requireScoutRuns(sources: ScoutSources): ReadonlySet<string> {
  if (!sources.openRunTasks) throw new Error("scout gardener: draft re-derivation requires an awaited open-run listing");
  return sources.openRunTasks();
}

/** W1-T13208: an investigation's one claim; a record whose first claim reads so asks for no fix. */
const investigationClaim = (step: string): string => `the code that writes ${step} is located and named`;
export const isScoutInvestigation = (t: Task): boolean => /^the code that writes \S+ is located and named$/.test(t.acceptance?.[0]?.claim ?? "");
const INVESTIGATION_NOTE = "Filed by the scout gardener (W1-T5454) as an INVESTIGATION (W1-T13208): its builder locates and names the code that writes this step and changes no source. The scout files the fix record from the writer it names once this merges, and never debits an investigation for rows that continued. MACHINE-AUTHORED — the machine-filing judge releases it or escalates it to a person.";
const NO_WRITER_LINE = "The rows name no file of their own: locate the code that writes this step first, then fix its cause.";
const investigationTitle = (step: string): string => `THE SCOUT'S INVESTIGATION OF AN UNCOVERED RECURRING SYMPTOM — ${step}: locate and name the code that writes it, with no fix`;
const investigationLine = (step: string): string =>
  `This record is an INVESTIGATION: the code that writes ${step} was not located, so a builder delivers a test that drives the located writer and names its file as a line \`scout-writer: <path>\`, and no fix. The scout files the fix record from that file once this merges.`;

const symptomInvariant = (step: string, taskId: string, testPath: string): MachineShardInvariant => ({
  slug: "symptom-still-recorded",
  statement: `${step} is still written to the ledger whenever its failure really occurs; the fix ends the cause, not the record of it.`,
  claim: `${step} is still written to the ledger when its failure occurs`,
  proof: `grep: test("${taskId}: the symptom is still recorded when its failure occurs" in ${testPath}`,
});

/** The queued, unretired, never-attempted machine draft whose one declared file is its own scout test. */
function isTestOnlyScoutShape(t: Task): boolean {
  return t.status === "queued" && t.attempts === 0 && !t.retirement &&
    t.author_class === "machine" && t.origin?.startsWith("scout:") === true && t.files?.length === 1 &&
    /^test\/(?:[\w-]+\/){0,2}scout-[\w.-]+\.test\.ts$/.test(t.files[0]!);
}
const operatorRuled = (t: Task): boolean => t.risk_ruling?.verdict === "operator" || t.risk_ruling?.operator_release_pin !== undefined;

/** A test-only scout draft the scout may rewrite: an operator-ruled draft is left as it is. */
function isTestOnlyScout(t: Task): boolean {
  return isTestOnlyScoutShape(t) && !operatorRuled(t);
}

/** The files a merged investigation of `step` named, as `scout-writer: <path>` lines in its own test. */
function scoutInvestigatedWriters(sources: ScoutSources, plan: PlanInventory, merged: ReadonlyMap<string, number>, step: string): string[] {
  const named = new Set<string>();
  for (const t of plan.all) {
    const test = t.files?.[0];
    if (t.origin !== scoutOrigin(step) || !isScoutInvestigation(t) || test === undefined) continue;
    if (!(merged.has(t.id) || t.status === "merged" || t.status === "done") || !sources.fileExists(test)) continue;
    for (const m of readFileSync(join(sources.repoRoot, test), "utf8").matchAll(/^\s*(?:\/\/|#|\*)?\s*scout-writer:\s*((?:src|scripts)\/[\w./@-]+)\s*$/gm)) {
      if (sources.fileExists(m[1]!)) named.add(m[1]!);
    }
  }
  return [...named].slice(0, 3);
}

/** Replace (or insert before `before`, else append) one top-level `  key:` field of a single-record shard. */
function setField(lines: string[], key: string, block: string[], before?: string): string[] {
  const isField = (l: string): boolean => /^ {2}[A-Za-z_]+:/.test(l);
  const start = lines.findIndex((l) => l.startsWith(`  ${key}:`));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !isField(lines[end]!)) end++;
    return [...lines.slice(0, start), ...block, ...lines.slice(end)];
  }
  const at = before === undefined ? -1 : lines.findIndex((l) => l.startsWith(`  ${before}:`));
  return at >= 0 ? [...lines.slice(0, at), ...block, ...lines.slice(at)] : [...lines, ...block];
}

type DraftSpec = NonNullable<ScoutAction["draft"]> & { step: string; origin: string };
type DraftRewrite = { text: string } | { refused: string } | { skipped: true };

/** The text a queued test-only fix draft becomes: its writers declared, or, with none located, an investigation. */
function scoutDraftRewrite(original: string, draft: DraftSpec, paths: MachineShardPaths): DraftRewrite {
  const task = loadPlanFromYaml(original, draft.path).tasks;
  const only = task[0]!;
  if (task.length !== 1 || only.id !== draft.id || !isTestOnlyScout(only) || only.origin !== draft.origin || only.files![0] !== draft.files.at(-1)) return { skipped: true };
  const q = (v: string): string => JSON.stringify(v);
  const testPath = draft.files.at(-1)!;
  let lines = withoutRulingBlock(original.trimEnd().split("\n"))
    .map((l) => (/^ {2}verify:/.test(l) ? "  verify: human" : l));
  lines = setField(lines, "files", ["  files:", ...draft.files.map((f) => `    - ${f}`)]);
  const declared = INVARIANT_DECL_RE.test(only.design ?? "") || NO_INVARIANTS_RE.test(only.design ?? "");
  const invariants = { declared: [symptomInvariant(draft.step, draft.id, testPath)] };
  if (!declared) lines = setField(lines, "design", [`  design: ${q(machineShardDesign(only.design, invariants))}`], "acceptance");
  const kept = only.acceptance ?? [];
  const acceptance = [
    ...(draft.investigation ? [{ claim: investigationClaim(draft.step), proof: `grep: test("${draft.id}: the writer of ${draft.step} is located and named" in ${testPath}` },
      ...kept.filter((c) => /^invariant:/.test(c.claim))] : kept),
    ...(declared ? [] : machineShardInvariantClaims(invariants)),
  ];
  if (draft.investigation || !declared) {
    lines = setField(lines, "acceptance", ["  acceptance:", ...acceptance.flatMap((c) => [`    - claim: ${q(c.claim)}`, `      proof: ${q(c.proof)}`])]);
  }
  const found = draft.files.slice(0, -1);
  const prose = (only.rationale ?? "").split("\n").filter((l, i, all) => l !== "" || i < all.length - 1);
  const rationale = draft.investigation ? [...prose.filter((l) => l !== NO_WRITER_LINE), investigationLine(draft.step)]
    : prose.map((l) => (l === NO_WRITER_LINE ? `The rows name no file; tracked source literals locate this step in: ${found.join(", ")}. Start there.` : l));
  if (draft.investigation) {
    lines = setField(lines, "title", [`  title: ${q(investigationTitle(draft.step))}`]);
    lines = setField(lines, "note", [`  note: ${q(INVESTIGATION_NOTE)}`]);
  }
  if (draft.investigation || prose.includes(NO_WRITER_LINE)) {
    const style = /^[ \t]/.test(rationale.find((l) => l !== "") ?? "") ? "|2" : "|";
    lines = setField(lines, "rationale", [`  rationale: ${style}`, ...rationale.map((l) => (l === "" ? "" : `    ${l}`))]);
  }
  const text = lines.join("\n");
  const refused = machineShardFilingRefusal(text, draft.path, paths) ?? machineShardLintRefusal(text, draft.path);
  return refused === undefined ? { text } : { refused };
}

/** W1-T13208: the queued fix drafts that declare only a test, by the reason each is left alone. */
export interface ScoutLeftDrafts {
  total: number;
  operator_ruled: number;
  no_shard: number;
  open_run: number;
  /** Passes every record-side condition and is rewritten by this pass. */
  rewritable: number;
  /** The rewrite was tried and refused: the refusing checks, by name. */
  rewrite_refused: Record<string, number>;
}

/** The checks that refused a rewrite, by name, without the task ids or messages that vary per draft. */
const refusalReason = (refused: string): string =>
  [...new Set(refused.split("; ").map((r) => r.replace(/^W\d+-T\d+: /, "").split(":")[0]!.trim()))].join(", ");

function scoutDrafts(sources: ScoutSources, plan: PlanInventory, merged: ReadonlyMap<string, number>): { rederive: ScoutAction[]; left: ScoutLeftDrafts } {
  const left: ScoutLeftDrafts = { total: 0, operator_ruled: 0, no_shard: 0, open_run: 0, rewritable: 0, rewrite_refused: {} };
  const demanding = plan.open.filter((t) => isTestOnlyScoutShape(t) && !isScoutInvestigation(t));
  left.total = demanding.length;
  left.operator_ruled = demanding.filter(operatorRuled).length;
  const drafts = plan.open.filter((t) => isTestOnlyScout(t) && plan.shards.has(t.id));
  left.no_shard = demanding.filter((t) => !operatorRuled(t) && !plan.shards.has(t.id)).length;
  if (drafts.length === 0) return { rederive: [], left };
  const active = requireScoutRuns(sources);
  let corpus: ReturnType<typeof scoutSourceTexts> | undefined;
  const paths: MachineShardPaths = { pathExists: (path) => existsSync(join(sources.repoRoot, path)) };
  const rederive = drafts.flatMap((task): ScoutAction[] => {
    // An investigation keeps its claim: it is rewritten only to declare a writer the source now locates.
    const investigating = isScoutInvestigation(task);
    if (active.has(task.id)) { if (!investigating) left.open_run++; return []; }
    const step = task.origin!.slice("scout:".length);
    const located = scoutWriters(sources.repoRoot, step, corpus ??= scoutSourceTexts(sources.repoRoot));
    const files = located.length > 0 ? located : scoutInvestigatedWriters(sources, plan, merged, step);
    if (investigating && files.length === 0) return [];
    const draft: DraftSpec = { id: task.id, path: plan.shards.get(task.id)!, files: [...files, task.files![0]!], investigation: files.length === 0, step, origin: task.origin! };
    let reason: string | undefined;
    try {
      const rewrite = scoutDraftRewrite(readFileSync(join(sources.repoRoot, draft.path), "utf8"), draft, paths);
      if ("refused" in rewrite) reason = refusalReason(rewrite.refused);
    } catch (error) {
      reason = `unreadable: ${error instanceof Error ? error.name : "error"}`;
    }
    if (investigating) { /* an investigation is no fix demand: it is not counted */ }
    else if (reason === undefined) left.rewritable++;
    else left.rewrite_refused[reason] = (left.rewrite_refused[reason] ?? 0) + 1;
    return [{ class: "file-uncovered-symptom", target: step, origin: task.origin!,
      reason: files.length === 0
        ? `${task.id} declares only its test and its writer is not located; return it as an investigation to the machine-filing judge.`
        : `${task.id} declares only its test; return its writer scope to the machine-filing judge.`,
      symptom: { step, older: 0, newer: 0, total: 0, files },
      draft: { id: task.id, path: draft.path, files: draft.files, investigation: draft.investigation } }];
  });
  return { rederive, left };
}

const iso = (ms: number): string => clockFromMillisFn(() => ms).iso();
const rowMs = (r: Record<string, unknown>): number => (typeof r.ts === "string" ? Date.parse(r.ts) : NaN);

/** Repo-looking paths a ledger row names in its own `file` or `module` field. */
function rowFiles(r: Record<string, unknown>): string[] {
  return [r.file, r.module].filter((v): v is string => typeof v === "string" && /^[\w.@-]+(?:\/[\w.@-]+)+$/.test(v) && !v.startsWith("/") && !v.includes(".."));
}

/** W1-T13428: a row the scout gardener itself wrote, which is never a symptom. */
const scoutWrote = (r: Record<string, unknown>): boolean => (r.gardener_origin as { name?: unknown } | undefined)?.name === "scout";

/** Failure-shaped steps whose rows both halves of the window hold, the newer at least as many as the older. */
export function scoutSymptoms(rows: readonly Record<string, unknown>[], nowMs: number, fileExists: (path: string) => boolean): ScoutSymptom[] {
  const since = nowMs - SCOUT_WINDOW_MS;
  const mid = nowMs - SCOUT_WINDOW_MS / 2;
  const by = new Map<string, { older: number; newer: number; files: Map<string, number> }>();
  for (const r of rows) {
    const step = r.step;
    const t = rowMs(r);
    if (typeof step !== "string" || !isFailureShapedStep(step) || !Number.isFinite(t) || t < since || t > nowMs || scoutWrote(r)) continue;
    const e = by.get(step) ?? { older: 0, newer: 0, files: new Map<string, number>() };
    if (t < mid) e.older += 1;
    else e.newer += 1;
    for (const f of rowFiles(r)) e.files.set(f, (e.files.get(f) ?? 0) + 1);
    by.set(step, e);
  }
  return [...by.entries()]
    .filter(([, e]) => e.older > 0 && e.newer >= e.older)
    .map(([step, e]) => ({
      step, older: e.older, newer: e.newer, total: e.older + e.newer,
      files: [...e.files.entries()].filter(([f]) => fileExists(f)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f).slice(0, 3),
    }))
    .sort((a, b) => b.total - a.total || a.step.localeCompare(b.step));
}

/**
 * The steps a queued task, or a task merged in the trailing window, already cites (the backlog gardener's
 * own citation rule), plus the steps a gardener's scorecard prices. A covered symptom is never filed.
 */
export function scoutCoveredSteps(plan: PlanInventory, merged: ReadonlyMap<string, number>, nowMs: number, priced: ReadonlySet<string>): Set<string> {
  const covered = new Set<string>(priced);
  const since = nowMs - SCOUT_MERGED_COVERAGE_MS;
  const openIds = new Set(plan.open.map((o) => o.id));
  for (const task of plan.all) {
    const queued = openIds.has(task.id);
    const at = merged.get(task.id);
    if (!queued && !(at !== undefined && at >= since)) continue;
    for (const step of backlogCitedSteps(task)) covered.add(step);
    if (typeof task.origin === "string" && task.origin.startsWith("scout:")) covered.add(task.origin.slice("scout:".length));
  }
  return covered;
}

/** Survival of every scout-filed task: credit when its symptom's rows fell after the merge, debit when they held or grew. */
export function scoutSurvival(
  plan: PlanInventory, merged: ReadonlyMap<string, number>, rows: readonly Record<string, unknown>[], nowMs: number,
): { outcome: Outcome; tracked: ScoutInventory["tracked"] } {
  const tracked: ScoutInventory["tracked"] = [];
  let trials = 0;
  let successes = 0;
  for (const task of plan.all) {
    if (typeof task.origin !== "string" || !task.origin.startsWith("scout:")) continue;
    const step = task.origin.slice("scout:".length);
    // An investigation was never asked to stop the rows: it is neither credited nor debited (W1-T13208).
    if (isScoutInvestigation(task)) { tracked.push({ step, task: task.id, verdict: "investigation" }); continue; }
    const at = merged.get(task.id);
    if (at === undefined) { tracked.push({ step, task: task.id, verdict: "unmerged" }); continue; }
    // The symptom is judged only once a full window has passed since the merge.
    if (nowMs - at < SCOUT_SURVIVAL_WINDOW_MS) { tracked.push({ step, task: task.id, verdict: "pending" }); continue; }
    const count = (from: number, to: number): number => rows.filter((r) => r.step === step && rowMs(r) >= from && rowMs(r) < to).length;
    const before = count(at - SCOUT_SURVIVAL_WINDOW_MS, at);
    const after = count(at, at + SCOUT_SURVIVAL_WINDOW_MS);
    const stopped = after < before;
    trials += 1;
    if (stopped) successes += 1;
    tracked.push({ step, task: task.id, verdict: stopped ? "credit" : "debit", before, after });
  }
  return { outcome: { trials, successes }, tracked };
}

export function scoutInventory(sources: ScoutSources): ScoutInventory {
  const nowMs = sources.clock.now();
  const plan = sources.plan();
  const merged = sources.mergedTasks(iso(nowMs - Math.max(SCOUT_MERGED_COVERAGE_MS, 4 * SCOUT_SURVIVAL_WINDOW_MS)));
  const symptoms = scoutSymptoms(sources.ledger(iso(nowMs - SCOUT_WINDOW_MS)), nowMs, sources.fileExists).map((s) => {
    if (s.files.length > 0) return s;
    const files = scoutInvestigatedWriters(sources, plan, merged, s.step);
    return files.length > 0 ? { ...s, files, investigated: true } : s;
  });
  const covered = scoutCoveredSteps(plan, merged, nowMs, sources.pricedSteps());
  const uncovered = symptoms.filter((s) => !covered.has(s.step));
  const budget = Math.max(0, Math.floor(sources.mergedLastDay()));
  const unprioritized = plan.open.filter((t) => t.priority === undefined).length;
  const unprioritizedShare = plan.open.length === 0 ? 0 : unprioritized / plan.open.length;
  const blocked = unprioritizedShare > SCOUT_UNPRIORITIZED_SHARE_BOUND;
  const selected = blocked ? [] : uncovered.slice(0, budget);
  // Survival reads only the steps a scout-filed task names, from before the oldest tracked merge.
  const scoutSteps = [...new Set(plan.all.flatMap((t) => (typeof t.origin === "string" && t.origin.startsWith("scout:") ? [t.origin.slice("scout:".length)] : [])))];
  const survivalRows = scoutSteps.length === 0 ? [] : sources.ledger(iso(nowMs - 4 * SCOUT_SURVIVAL_WINDOW_MS - SCOUT_SURVIVAL_WINDOW_MS), scoutSteps);
  const { outcome, tracked } = scoutSurvival(plan, merged, survivalRows, nowMs);
  const { rederive, left } = scoutDrafts(sources, plan, merged);
  return { rederive, testOnlyDrafts: left, symptoms, covered: symptoms.filter((s) => covered.has(s.step)).map((s) => s.step), uncovered, selected, budget, openQueue: plan.open.length, unprioritizedShare, blocked, survival: outcome, tracked };
}

/** The test a filed record's acceptance proof names, one per symptom. */
const scoutTestPath = (step: string, files: readonly string[]): string => newTestPath(`scout-${slug(step, 60).replace(/-+$/, "")}`, files, "scout-gardener");

/** Render ONE uncovered symptom as a single-record shard; `refused` names the lint checks that blocked it. */
export function scoutShard(symptom: ScoutSymptom, taskId: string, population: readonly number[], repoRoot?: string): { text: string; refused?: string } {
  const files = symptom.files.length > 0 || repoRoot === undefined ? symptom.files : scoutWriters(repoRoot, symptom.step);
  const testPath = scoutTestPath(symptom.step, files);
  const recon = symptom.files.length === 0 && !symptom.investigated;
  const investigation = files.length === 0;
  const acceptance = investigation
    ? [{ claim: investigationClaim(symptom.step), proof: `grep: test("${taskId}: the writer of ${symptom.step} is located and named" in ${testPath}` }]
    : [{
      claim: `${symptom.step} stops recurring: its cause is fixed rather than its rows hidden`,
      proof: `grep: test("${taskId}: ${symptom.step} no longer recurs" in ${testPath}`,
    }];
  return renderMachineShard({
    taskId,
    title: investigation
      ? investigationTitle(symptom.step)
      : `THE SCOUT'S UNCOVERED RECURRING SYMPTOM — ${symptom.step} landed ${symptom.total} ledger rows across the trailing window and no task cites it`,
    origin: scoutOrigin(symptom.step),
    files: [...files, testPath],
    cost: symptom.total,
    costPopulation: population,
    acceptance,
    invariants: { declared: [symptomInvariant(symptom.step, taskId, testPath)] },
    note: investigation ? INVESTIGATION_NOTE
      : `Filed by the scout gardener (W1-T5454). The scout measures this step again once the build merges and credits or debits its class by whether the rows stopped. MACHINE-AUTHORED — the machine-filing judge releases it or escalates it to a person.`,
    rationale: [
      `The ledger step ${symptom.step} carries a failure shape and landed rows in both halves of the trailing ${SCOUT_WINDOW_MS / 86_400_000} days: ${symptom.older} in the older half, ${symptom.newer} in the newer.`,
      "No queued task and no task merged in that window cites this step, and no gardener scorecard prices it.",
      ...(investigation ? [investigationLine(symptom.step)] : [
        symptom.investigated ? `A merged investigation of this step named its writer: ${files.join(", ")}. Start there.`
          : recon ? `The rows name no file; tracked source literals locate this step in: ${files.join(", ")}. Start there.`
            : `The rows themselves name these files: ${symptom.files.join(", ")}. Start there.`,
      ]),
    ],
  });
}

/** The records one pass would file, as the pure core: ids are minted by the caller, one per symptom. */
export function scoutFilings(selected: readonly ScoutSymptom[], mint: () => string, repoRoot?: string): Array<{ symptom: ScoutSymptom; taskId: string; text: string; refused?: string }> {
  const population = selected.map((s) => s.total);
  const minted = new Set<string>();
  return selected.map((symptom) => {
    const taskId = mint();
    if (minted.has(taskId)) throw new Error(`scout gardener: the id minter returned ${taskId} twice in one pass`);
    minted.add(taskId);
    const initial = scoutShard(symptom, taskId, population);
    if (initial.refused !== undefined) return { symptom, taskId, ...initial };
    return { symptom, taskId, ...scoutShard(symptom, taskId, population, repoRoot) };
  });
}

/** Tasks that reached main in `sinceIso..`, by their `Remudero-Task:` trailer, with the instant they merged. */
export function readMergedTasks(repoRoot: string, sinceIso: string): Map<string, number> {
  const git = (args: string[]) => hostWorktreeGit(repoRoot, args, { maxBuffer: 64 * 1024 * 1024 });
  let ref = "HEAD";
  try {
    git(["rev-parse", "--verify", "--quiet", "origin/main"]);
    ref = "origin/main";
  } catch {
    // origin/main is absent here (a fresh clone or a fixture repo): the scout reads HEAD's history instead.
  }
  let stdout: string;
  try {
    stdout = git(["log", ref, `--since=${sinceIso}`, "--grep=^Remudero-Task:", "--format=%x01%cI%n%B"]);
  } catch (error) {
    throw new Error(`scout gardener: git log ${ref} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const merged = new Map<string, number>();
  for (const chunk of stdout.split("\u0001")) {
    const [stamp, ...body] = chunk.split("\n");
    const at = Date.parse(stamp ?? "");
    if (!Number.isFinite(at)) continue;
    for (const m of body.join("\n").matchAll(/^Remudero-Task:\s*(\S+)\s*$/gm)) {
      const id = m[1]!;
      if (!merged.has(id) || at < merged.get(id)!) merged.set(id, at);
    }
  }
  return merged;
}

export function scoutGardenSpec(
  deps: GardenerDeps,
  sources: Partial<ScoutSources> & Pick<ScoutSources, "mintTaskId">,
  reader: typeof readLedgerUnionRecordsSync = readLedgerUnionRecordsSync,
): GardenSpec<ScoutClass, ScoutInventory, ScoutAction, GardenCheckout> {
  const clock = sources.clock ?? deps.clock ?? systemClock;
  const full: ScoutSources = {
    clock,
    repoRoot: deps.repoRoot,
    ledger: (sinceIso, steps) => {
      const read = reader(deps.stateDir, steps === undefined
        ? { sinceTs: sinceIso, pattern: FAILURE_ROW, refuseIncomplete: true }
        : { sinceTs: sinceIso, step: steps, refuseIncomplete: true });
      if (!read.ok) throw new Error(`scout gardener: incomplete ledger union: ${read.unread.join(", ")}`);
      return read.rows;
    },
    plan: () => planInventory(deps.repoRoot, deps.stateDir),
    mergedTasks: (since) => readMergedTasks(deps.repoRoot, since),
    mergedLastDay: () => readMainHistory(deps.repoRoot, iso(clock.now() - 24 * 3_600_000)).filter((c) => /\(#\d+\)$/.test(c.subject)).length,
    pricedSteps: () => new Set(CI_FRICTION_LEDGER_STEPS),
    fileExists: (path) => existsSync(join(deps.repoRoot, path)),
    ...sources,
  };
  let preparedRuns: ReadonlySet<string> | undefined;
  return {
    name: "scout",
    landingRefusal: machineShardLandingGuard(deps),
    classes: SCOUT_CLASSES,
    cheapFingerprint: () => `${planCheapFingerprint(deps.repoRoot, deps.stateDir)}:${gardenLedgerBucket(clock)}`,
    inventory: () => scoutInventory(full),
    inventoryAsync: async () => {
      const plan = full.plan();
      const active = plan.open.some(isTestOnlyScout)
        ? full.openRunTasks ? full.openRunTasks() : await openScoutRuns(full.repoRoot) : new Set<string>();
      return scoutInventory({ ...full, plan: () => plan, openRunTasks: () => active });
    },
    fingerprint: (i) => `${i.selected.map((s) => `${s.step}:${s.total}`).join("|")}:${JSON.stringify(i.rederive)}:${i.budget}:${i.blocked}`,
    unfinished: (i) => i.selected.length > 0 || i.rederive.length > 0,
    metric: (i) => i.survival,
    candidates: (i) => [...i.rederive, ...i.selected.map((symptom) => ({
      class: "file-uncovered-symptom" as const, target: symptom.step, origin: scoutOrigin(symptom.step), symptom,
      reason: `${symptom.step} landed ${symptom.total} ledger rows (${symptom.older} then ${symptom.newer}) and no task or scorecard covers it.`,
    }))],
    scorecard: (i) => ({
      symptoms: i.symptoms.length, covered: i.covered.length, uncovered: i.uncovered.length, proposed: i.selected.length,
      merge_budget: i.budget, open: i.openQueue, unprioritized_share: Math.round(i.unprioritizedShare * 1000) / 1000, blocked: i.blocked,
      survival: i.tracked,
      // Absent while the plan holds no such draft, so a scorecard with none is the one it always was.
      ...(i.testOnlyDrafts.total > 0 ? { test_only_fix_drafts: i.testOnlyDrafts } : {}),
    }),
    prepare: (ws, plan, async) => {
      const count = plan.actions.filter((a) => !a.draft).length;
      preparedRuns = undefined;
      if (plan.actions.some((a) => a.draft) && !full.openRunTasks) {
        if (!async) requireScoutRuns(full);
        return (async () => {
          preparedRuns = await openScoutRuns(full.repoRoot);
          return prepareGardenTaskIds(ws, count, full.mintTaskId, true);
        })();
      }
      return prepareGardenTaskIds(ws, count, full.mintTaskId, async);
    },
    apply: (ws, plan, _scorecard, heldIds) => {
      if (plan.actions.length === 0) return undefined;
      if (!ws.branch) throw new Error("scout gardener: filing workspace has no branch for task-id reservation");
      const fresh = plan.actions.filter((a) => !a.draft);
      const ids = heldIds ?? prepareGardenTaskIds(ws, fresh.length, full.mintTaskId) as string[];
      let index = 0;
      const filings = scoutFilings(fresh.map((a) => a.symptom), () => ids[index++]!, ws.root);
      const shardDir = join(resolveRepoLayout(ws.root).planDir, "tasks.d");
      const written: Array<{ rel: string; step: string; origin: string }> = [];
      const drafts = plan.actions.flatMap((a) => a.draft ? [{ ...a.draft, step: a.symptom.step, origin: a.origin }] : []);
      const active = drafts.length === 0 ? new Set<string>() : preparedRuns ?? requireScoutRuns(full);
      preparedRuns = undefined;
      for (const draft of drafts) {
        if (active.has(draft.id)) continue;
        const path = join(ws.root, draft.path);
        const rewrite = scoutDraftRewrite(readFileSync(path, "utf8"), draft, {
          pathExists: path => existsSync(join(ws.root, path)),
          pathExistsAtBase: path => existsSync(join(deps.repoRoot, path)),
        });
        if ("skipped" in rewrite) continue;
        if ("refused" in rewrite) {
          deps.log("scout.record_refused", { symptom_step: draft.step, refused_task_id: draft.id, reason: rewrite.refused });
          continue;
        }
        const text = rewrite.text;
        writeFileSync(path, text + "\n");
        written.push({ rel: draft.path, step: draft.step, origin: draft.origin });
      }
      for (const f of filings) {
        if (f.refused !== undefined) {
          deps.log("scout.record_refused", { symptom_step: f.symptom.step, refused_task_id: f.taskId, reason: f.refused });
          continue;
        }
        mkdirSync(shardDir, { recursive: true });
        const path = join(shardDir, `${f.taskId}-scout-${slug(f.symptom.step, 60).replace(/-+$/, "")}.yaml`);
        writeFileSync(path, f.text);
        written.push({ rel: relative(ws.root, path), step: f.symptom.step, origin: scoutOrigin(f.symptom.step) });
      }
      if (written.length === 0) return undefined;
      return {
        paths: written.map((w) => w.rel),
        title: `chore(plan): the scout gardener scopes ${written.length} recurring symptom(s)`,
        body: [
          "The scout gardener (W1-T5454) files recurring failure-shaped ledger steps that no task or scorecard covers. Close this PR to decline them.",
          "",
          ...written.map((w) => `- **${w.step}**: \`${w.rel}\``),
          "",
          "## Acceptance",
          ...written.map((w) => `- claim: ${w.step} is filed as a parked, machine-judged task\n  proof: grep: ${w.origin} in ${w.rel}`),
        ].join("\n"),
      };
    },
  };
}
