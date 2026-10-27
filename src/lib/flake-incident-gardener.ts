/**
 * lib/flake-incident-gardener.ts — W1-T6406: one test failing across unrelated PRs is ONE incident.
 *
 * OBSERVED 2026-10-08: `after a rotation lands the emergency status answers within budget and sees the
 * new stop` failed CI on #10058, #10077, #10084 and #10089 — four PRs whose diffs do not touch it —
 * and a person filed it by hand (W1-T6402). The SRE ruling (2026-09-23) is that CI flakes are
 * incidents. Every other ci-friction filer prices a GATE; none is keyed on a test.
 *
 * The evidence is the `test.flake_retry` rows the selector-shadow gardener ledgers from the coverage
 * shard logs (selectorShadowFlakeLedger): file, titles when the log names them, the PR, the shas, and
 * whether the retry recovered or ALSO failed. This gardener only reads that union; it reads nothing new
 * from GitHub except the changed-file list of a PR that already looks like part of an incident.
 *
 * W1-T9589: a fix round that rerouted a red its PR's diff cannot reach (W1-T9561) writes a `source:
 * "fix-round"` row too, with no CI run, shard or base sha. Its clear verdict is the `fix.scope_rerouted`
 * row of the same round, joined on task and head, so it never spends a changed-path read.
 *
 * A test counts toward an incident on a PR only when that PR's diff touches neither the test file nor a
 * source module the test itself imports — a PR that edits the test is a candidate cause, not evidence of
 * a flake. A PR whose file list cannot be read counts as touching, so it is never counted.
 *
 * W1-T9551: a red that never recovers on retry is not a flake. W1-T9532 (#11790) and W1-T9668 (#12057)
 * were each filed for a test main itself failed (0 of 3 and 0 of 9 retries recovered). Such a group is
 * MAIN-INHERITED: it files nothing and writes one `flake_incident.main_inherited` row the main-health
 * rung reads.
 *
 * W1-T9708: a census walks the tree and imports none of it, so a PR adding a site it reports reds it
 * untouched (W1-T7532, W1-T7765). A retry that also failed, on a PR whose diff enters the census's
 * walk ({@link censusWalksOf}), is that PR's own red; a recovered retry is timing and keeps the rule above.
 */
import { dirname, join, normalize } from "node:path/posix";
import { censusWalksOf } from "./ci-parity.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import type { GardenerDeps } from "./gardener.js";
import { ledgerRotationDigests, readLedgerUnionRecordsSync } from "./ledger-union.js";
import { machineShardLandingGuard, renderMachineShard } from "./machine-filing.js";
import { retirementHoldsOrigin, taskLandedOnMain } from "./plan.js";
import {
  selectorShadowPlanTasksAsync, type SelectorShadowMainFailures, type SelectorShadowTaskIdMinter,
} from "./selector-shadow-gardener.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";
import { sameTestFile } from "./test-path-resolver.js";
import { runtimeSpecifiers } from "./source-text-readers.js";

export const FLAKE_INCIDENT_GARDEN_NAME = "flake-incident";

/** The ledger step the evidence rows carry (selectorShadowFlakeLedger writes them). */
export const FLAKE_RETRY_STEP = "test.flake_retry";

/** The step a rerouted fix round writes before its `fix-round` flake rows: the round's own clear verdict (W1-T9589). */
export const FIX_SCOPE_REROUTED_STEP = "fix.scope_rerouted";

/** W1-T9551: a group with no recovered retry, routed to the main-health rung instead of filed. */
export const FLAKE_INCIDENT_MAIN_INHERITED_STEP = "flake_incident.main_inherited";

/** Every step a pass reads: the evidence, the reroutes that clear a fix-round row, and the gardener's own prior answers. */
export const FLAKE_INCIDENT_EVIDENCE_STEPS: readonly string[] = [FLAKE_RETRY_STEP, FIX_SCOPE_REROUTED_STEP, "flake_incident.filed", "flake_incident.skipped", "flake_incident.watch", FLAKE_INCIDENT_MAIN_INHERITED_STEP];

/** Bump whenever {@link FLAKE_INCIDENT_EVIDENCE_STEPS} changes: it keys the durable per-rotation digests. */
export const FLAKE_INCIDENT_DIGEST_VERSION = "3";

/**
 * The tiered response, as policy values with this one home. One PR is noise; `watchPrs` distinct
 * unrelated PRs write a `flake_incident.watch` row; `filePrs` file the incident. Chosen 2026-10-08 from
 * the incident above: four PRs failed the test inside a day, so three leaves room for the gardener to
 * act one PR before a person would have, while two PRs failing one test in a week is common enough to
 * only watch.
 */
export const FLAKE_INCIDENT_POLICY = Object.freeze({
  /** Evidence older than this is not read. */
  windowMs: 7 * 24 * 3_600_000,
  watchPrs: 2,
  filePrs: 3,
  /** A filed task whose PR has not reached the plan yet counts as open for this long. */
  pendingFilingHoldMs: 24 * 3_600_000,
  /** Changed-file reads (one GitHub compare each) a single pass may spend. */
  changedPathReadsPerPass: 24,
  /** New tasks a single pass may file, so one bad day cannot flood the plan. */
  filingsPerPass: 1,
});

export type FlakeIncidentPolicy = { -readonly [K in keyof typeof FLAKE_INCIDENT_POLICY]: number };

type PlanTaskLite = { id: string; origin?: string; status?: string; retirement?: string; superseded_by?: string };

/** What the gardener reads beyond the ledger union: all injected, so a pass is testable without GitHub. */
export interface FlakeIncidentSources {
  mintTaskId: SelectorShadowTaskIdMinter;
  /** The changed files of base...head. A throw (or an incomplete list) means the list is unreadable. */
  readChangedPaths: (baseSha: string, headSha: string) => string[] | Promise<string[]>;
  /** The plan's tasks, read only when an incident is ready to file. Absent: the daemon checkout's plan. */
  planTasks?: () => PlanTaskLite[] | Promise<PlanTaskLite[]>;
  /** A test file's source, to name the modules it imports. Absent: read from the daemon checkout. */
  readSource?: (file: string) => string | undefined;
  /** Test files main's own CI failed at a base sha; `undefined` is unread (W1-T9551). Absent: never read. */
  mainFailures?: SelectorShadowMainFailures;
  /** Whether a superseding task has landed (W1-T9729). Absent: its `Remudero-Task:` trailer on the checkout's origin/main. */
  isLanded?: (taskId: string) => boolean | Promise<boolean>;
  policy?: Partial<FlakeIncidentPolicy>;
}

type RetryOutcome = "recovered" | "also_failed";

interface FlakeObservation {
  file: string;
  title: string;
  prs: number[];
  source: "selector-shadow" | "fix-round";
  /** The CI run and shard a coverage-shard log names. A fix-round observation has neither. */
  runId?: number;
  shard?: number;
  outcome: RetryOutcome;
  headSha?: string;
  baseSha?: string;
  /** The fix round's task, for the join to its own `fix.scope_rerouted` row. */
  taskId?: string;
  /** A fix-round observation of a retry a coverage shard also logged: it still names its PR, but adds no retry. */
  duplicate?: true;
  tsMs: number;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The `test.flake_retry` rows that can attribute a failure to a PR, expanded to one per (file, title). */
function observationsOf(rows: readonly Record<string, unknown>[]): FlakeObservation[] {
  const seen = new Set<string>();
  const out: FlakeObservation[] = [];
  const common = (row: Record<string, unknown>) => {
    const outcome = row.retry_outcome;
    if (typeof row.file !== "string" || (outcome !== "recovered" && outcome !== "also_failed")) return undefined;
    const prs = Array.isArray(row.pr_numbers) ? row.pr_numbers.filter(isCount) : [];
    if (prs.length === 0) return undefined;
    const tsMs = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(tsMs)) return undefined;
    return { file: row.file, outcome: outcome as RetryOutcome, prs, tsMs };
  };
  for (const row of rows) {
    if (row.source !== "selector-shadow" || !isCount(row.ci_run_id) || !isCount(row.shard)) continue;
    const base = common(row);
    if (base === undefined) continue;
    const titles = Array.isArray(row.titles) ? row.titles.filter((t): t is string => typeof t === "string" && t !== "") : [];
    for (const title of titles.length > 0 ? titles : [""]) {
      const key = `${row.ci_run_id}|${row.shard}|${base.file}|${base.outcome}|${title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...base, title, source: "selector-shadow", runId: row.ci_run_id, shard: row.shard,
        ...(typeof row.head_sha === "string" ? { headSha: row.head_sha } : {}),
        ...(typeof row.base_sha === "string" ? { baseSha: row.base_sha } : {}),
      });
    }
  }
  // One retry seen by a coverage shard and by the fix round that rerouted it is one retry: the fix-round
  // observation keeps its PR (a set) and its own clear verdict, but adds nothing to the retry counts.
  const shardSaw = (file: string, head: string, prs: readonly number[]) =>
    out.some((o) => o.source === "selector-shadow" && o.file === file && o.headSha === head && o.prs.some((pr) => prs.includes(pr)));
  for (const row of rows) {
    if (row.source !== "fix-round" || typeof row.head_sha !== "string") continue;
    const base = common(row);
    if (base === undefined) continue;
    const key = `fix-round|${base.prs.join(",")}|${row.head_sha}|${base.file}|${base.outcome}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...base, title: "", source: "fix-round", headSha: row.head_sha,
      ...(typeof row.task_id === "string" ? { taskId: row.task_id } : {}),
      ...(shardSaw(base.file, row.head_sha, base.prs) ? { duplicate: true as const } : {}),
    });
  }
  return out;
}

/** The fix rounds whose reroute found the PR's diff cannot reach a failing file, keyed by task, head and
 *  file. Only these clear a fix-round observation; with no such row it is not clear (W1-T9589). */
function unreachableByReroute(rows: readonly Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.attribution !== "diff-cannot-reach" || typeof row.task_id !== "string" || typeof row.head_sha !== "string") continue;
    if (!Array.isArray(row.failing_test_files)) continue;
    for (const file of row.failing_test_files) if (typeof file === "string") out.add(JSON.stringify([row.task_id, row.head_sha, file]));
  }
  return out;
}

export function flakeIncidentOrigin(file: string, title: string): string {
  return `flake-incident:${file}${title === "" ? "" : `#${title}`}`;
}

/** The test file an origin names. A file-level incident and a per-title incident on the same file are
 *  one incident: the same CI runs fail both, and one repair of the file answers both (W1-T7269/W1-T7270). */
export function flakeIncidentOriginFile(origin: string): string | undefined {
  if (!origin.startsWith("flake-incident:")) return undefined;
  return origin.slice("flake-incident:".length).split("#")[0];
}

function sameIncidentOrigin(a: string, b: string): boolean {
  const fileA = flakeIncidentOriginFile(a), fileB = flakeIncidentOriginFile(b);
  return a === b || (fileA !== undefined && fileB !== undefined && sameTestFile(fileA, fileB));
}

/** The repo paths a test file's relative or package-alias imports name — the source its failure could come from.
 *  A `.js` specifier names its `.ts` source (this repo's ESM convention). A `.mjs` specifier names a
 *  real `.mjs` file (scripts/*.mjs), so it is kept as written, beside the `.mts` a TypeScript build
 *  would resolve it to: rewriting it to `.ts` named a file that does not exist, and the ci-friction
 *  gardener then had no source owner for the failing test (#11716). Runtime owner inference opts
 *  into executable imports; historical flake membership retains its existing import population. */
export function testSourcePaths(file: string, source: string | undefined, options: { runtimeOnly?: boolean } = {}): string[] {
  if (source === undefined) return [];
  const out = new Set<string>();
  const specifier = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']((?:\.{1,2}\/|#(?:src|scripts|test)\/)[^"']+)["']/g;
  const imports = options.runtimeOnly ? runtimeSpecifiers(source) : [...source.matchAll(specifier)].map(match => match[1]!);
  for (const spec of imports) {
    if (!/^(?:\.{1,2}\/|#(?:src|scripts|test)\/)/.test(spec)) continue;
    // package.json maps these three aliases from the repository root, not the test's folder.
    // Invalid alias path segments cannot nominate a different source owner after normalization.
    if (spec.startsWith("#") && spec.split("/").slice(1).some(part => ["", ".", "..", "node_modules"].includes(part))) continue;
    const resolved = spec.startsWith("#") ? spec.slice(1) : normalize(join(dirname(file), spec));
    if (resolved.endsWith(".mjs")) {
      out.add(resolved);
      out.add(resolved.replace(/\.mjs$/, ".mts"));
    } else out.add(resolved.replace(/\.js$/, ".ts"));
    if (!/\.\w+$/.test(resolved)) out.add(`${resolved}.ts`);
  }
  return [...out].sort();
}

interface Evidence {
  prs: number[];
  /** Newest evidence row per PR, for "new since the last filing". */
  latestMs: Map<number, number>;
  /** W1-T9730: per PR, the newest CI run a coverage-shard log names, and the newest fix-round row. */
  latestRunId: Map<number, number>;
  latestFixRoundMs: Map<number, number>;
  runs: Set<number>;
  recovered: number;
  alsoFailed: number;
  /** Distinct counted PRs with an `also_failed` retry, and the base shas the counted observations name. */
  alsoFailedPrs: number;
  baseShas: string[];
  /** Counted observations per source: coverage-shard logs and fix-round reroutes. */
  coverageShard: number;
  fixRound: number;
}

/** Every {@link FLAKE_INCIDENT_EVIDENCE_STEPS} row since `sinceIso`. A pass runs in a fresh child, so each
 *  archive in the window is answered from its durable digest and only a rotation cut since is decompressed. */
export function readFlakeIncidentRows(stateDir: string, sinceIso: string): Record<string, unknown>[] {
  const steps = new Set(FLAKE_INCIDENT_EVIDENCE_STEPS);
  return readLedgerUnionRecordsSync(stateDir, {
    step: FLAKE_INCIDENT_EVIDENCE_STEPS, since: sinceIso,
    rotationRecords: ledgerRotationDigests(stateDir, (all) => all.filter((r) => steps.has(r.step as string)),
      { holder: FLAKE_INCIDENT_GARDEN_NAME, reducerVersion: FLAKE_INCIDENT_DIGEST_VERSION }).rotationRecords,
  }).rows;
}

/** One pass. Never throws on a single group's trouble: an unreadable PR is simply not counted. */
export async function runFlakeIncidentGardener(deps: GardenerDeps, sources: FlakeIncidentSources): Promise<void> {
  const policy: FlakeIncidentPolicy = { ...FLAKE_INCIDENT_POLICY, ...sources.policy };
  const clock = deps.clock ?? systemClock;
  const nowMs = clock.now();
  const sinceIso = fixedClock(nowMs - policy.windowMs).iso();
  const rows = readFlakeIncidentRows(deps.stateDir, sinceIso);
  const byStep = (step: string) => rows.filter((r) => r.step === step);
  const observations = observationsOf(byStep(FLAKE_RETRY_STEP));
  const rerouted = unreachableByReroute(byStep(FIX_SCOPE_REROUTED_STEP));

  const groups = new Map<string, FlakeObservation[]>();
  for (const o of observations) groups.set(JSON.stringify([o.file, o.title]), [...(groups.get(JSON.stringify([o.file, o.title])) ?? []), o]);

  // A cheap prefilter: a group short of the watch tier on raw PR count never costs a GitHub read.
  const candidates = [...groups.values()]
    .filter((g) => new Set(g.flatMap((o) => o.prs)).size >= policy.watchPrs)
    .sort((a, b) => new Set(b.flatMap((o) => o.prs)).size - new Set(a.flatMap((o) => o.prs)).size ||
      flakeIncidentOrigin(a[0]!.file, a[0]!.title).localeCompare(flakeIncidentOrigin(b[0]!.file, b[0]!.title)));
  if (candidates.length === 0) return;

  const pathReads = new Map<string, Promise<ReadonlySet<string> | undefined>>();
  let reads = 0;
  const changedPaths = (base: string, head: string): Promise<ReadonlySet<string> | undefined> => {
    const key = `${base}...${head}`;
    let read = pathReads.get(key);
    if (read === undefined) {
      if (reads >= policy.changedPathReadsPerPass) {
        read = Promise.resolve(undefined);
      } else {
        reads++;
        read = Promise.resolve().then(() => sources.readChangedPaths(base, head)).then(
          (paths) => (Array.isArray(paths) ? new Set(paths) : undefined),
          (error: unknown) => {
            deps.log("flake_incident.paths_unread", { base_sha: base, head_sha: head, error: String((error as Error)?.message ?? error) });
            return undefined;
          },
        );
      }
      pathReads.set(key, read);
    }
    return read;
  };
  const readSource = sources.readSource ?? ((file: string) => readFileIfExists(join(deps.repoRoot, file)));

  const evidenceOf = async (group: readonly FlakeObservation[]): Promise<Evidence> => {
    const { file } = group[0]!;
    const source = readSource(file);
    const own = new Set([file, ...testSourcePaths(file, source)]);
    const walks = censusWalksOf(file, source);
    const entersWalk = (paths: ReadonlySet<string>) => [...paths].some((p) => walks.some((w) => p.startsWith(w)));
    // A PR counts only when EVERY row it has in the group is clear of the test and its source.
    const verdict = new Map<number, boolean>();
    for (const o of group) {
      let clear = false;
      if (o.source === "fix-round") {
        clear = o.taskId !== undefined && o.headSha !== undefined && rerouted.has(JSON.stringify([o.taskId, o.headSha, o.file]));
      } else if (o.baseSha !== undefined && o.headSha !== undefined) {
        const paths = await changedPaths(o.baseSha, o.headSha);
        clear = paths !== undefined && ![...own].some((p) => paths.has(p)) && !(o.outcome === "also_failed" && entersWalk(paths));
      }
      for (const pr of o.prs) verdict.set(pr, (verdict.get(pr) ?? true) && clear);
    }
    const counted = group.filter((o) => o.prs.some((pr) => verdict.get(pr) === true));
    const prs = [...new Set(counted.flatMap((o) => o.prs.filter((pr) => verdict.get(pr) === true)))].sort((a, b) => a - b);
    const retries = counted.filter((o) => o.duplicate !== true);
    const latestMs = new Map<number, number>();
    const alsoFailedPrs = new Set(retries.filter((o) => o.outcome === "also_failed").flatMap((o) => o.prs.filter((pr) => verdict.get(pr) === true)));
    const latestRunId = new Map<number, number>();
    const latestFixRoundMs = new Map<number, number>();
    for (const o of counted) {
      for (const pr of o.prs) {
        if (verdict.get(pr) !== true) continue;
        latestMs.set(pr, Math.max(latestMs.get(pr) ?? 0, o.tsMs));
        if (o.runId !== undefined) latestRunId.set(pr, Math.max(latestRunId.get(pr) ?? 0, o.runId));
        else latestFixRoundMs.set(pr, Math.max(latestFixRoundMs.get(pr) ?? 0, o.tsMs));
      }
    }
    return {
      prs, latestMs, latestRunId, latestFixRoundMs, runs: new Set(counted.flatMap((o) => (o.runId === undefined ? [] : [o.runId]))),
      recovered: retries.filter((o) => o.outcome === "recovered").length,
      alsoFailed: retries.filter((o) => o.outcome === "also_failed").length,
      alsoFailedPrs: alsoFailedPrs.size,
      baseShas: [...new Set(counted.flatMap((o) => (o.baseSha === undefined ? [] : [o.baseSha])))].sort(),
      coverageShard: retries.filter((o) => o.source === "selector-shadow").length,
      fixRound: retries.filter((o) => o.source === "fix-round").length,
    };
  };

  /** Whether main's own CI failed `file` at any base sha: an unread or cancelled base is no evidence. */
  let plan: PlanTaskLite[] | undefined;
  const planTasks = async (): Promise<PlanTaskLite[]> => (plan ??= await (sources.planTasks ?? (() => selectorShadowPlanTasksAsync(deps.repoRoot)))());
  const closed = new Set(["merged", "done"]);
  const isLanded = sources.isLanded ?? ((id: string) => taskLandedOnMain(id, (args) => hostWorktreeGitAsync(deps.repoRoot, args)));
  /** Why an origin is already held, as the skip reason: a plan task neither merged nor retired, a retirement
   *  whose superseding task has not landed (W1-T9729), or a recent filing whose PR may not have landed. */
  const openTaskFor = async (origin: string): Promise<string | undefined> => {
    const tasks = await planTasks();
    const file = flakeIncidentOriginFile(origin);
    const sameFile = (o: unknown) => typeof o === "string" && sameIncidentOrigin(o, origin);
    const open = tasks.find((t) => sameFile(t.origin) && !closed.has(t.status ?? "") && t.retirement === undefined);
    if (open) return `open-task ${open.id}`;
    for (const t of tasks) {
      if (!sameFile(t.origin) || t.superseded_by === undefined) continue;
      const landed = await isLanded(t.superseded_by);
      if (retirementHoldsOrigin(t, () => landed)) return `superseded-by ${t.superseded_by}`;
    }
    if (byStep(FLAKE_INCIDENT_MAIN_INHERITED_STEP).some((r) => sameFile(r.origin))) return MAIN_INHERITED_HANDLED;
    const held = file === undefined ? undefined : [...filedThisPass].find(([path]) => sameTestFile(path, file));
    if (held) return `open-task ${held[1]}`;
    const filed = byStep("flake_incident.filed").filter((r) => sameFile(r.origin) && typeof r.task_id === "string")
      .sort((a, b) => Date.parse(String(b.ts)) - Date.parse(String(a.ts)))[0];
    if (filed && !tasks.some((t) => t.id === filed.task_id) && nowMs - Date.parse(String(filed.ts)) < policy.pendingFilingHoldMs) {
      return `open-task ${filed.task_id as string}`;
    }
    return undefined;
  };
  /** The origin's newest filing: when it was written, and the newest CI run it cited (absent on an older row). */
  const lastFiling = (origin: string): { ms: number; maxRunId?: number } => {
    const last = byStep("flake_incident.filed")
      .filter((r) => typeof r.origin === "string" && sameIncidentOrigin(r.origin, origin))
      .map((r) => ({ ms: Date.parse(String(r.ts)), runs: Array.isArray(r.run_ids) ? r.run_ids.filter(isCount) : [] }))
      .filter((r) => Number.isFinite(r.ms)).sort((a, b) => b.ms - a.ms)[0];
    if (last === undefined) return { ms: 0 };
    return last.runs.length > 0 ? { ms: last.ms, maxRunId: Math.max(...last.runs) } : { ms: last.ms };
  };
  const filedThisPass = new Map<string, string>();

  let filed = 0;
  for (const group of candidates) {
    const { file, title } = group[0]!;
    const origin = flakeIncidentOrigin(file, title);
    const evidence = await evidenceOf(group);
    if (evidence.prs.length < policy.watchPrs) continue;
    // W1-T9551: a group no retry recovered is main's red when it failed on watchPrs PRs or on main at their base.
    if (evidence.recovered === 0) {
      // Re-written only when its PR set grows, like the watch row; an unchanged one costs no main read.
      if (byStep(FLAKE_INCIDENT_MAIN_INHERITED_STEP).some((r) => r.origin === origin && isCount(r.prs_count) && r.prs_count >= evidence.prs.length)) continue;
      const { mainRed, redSha } = await flakeMainRedAt(file, evidence.baseShas, sources.mainFailures, deps.log);
      if (flakeIncidentMainInherited({ ...evidence, mainRed }, policy)) {
        deps.log(FLAKE_INCIDENT_MAIN_INHERITED_STEP, {
          origin, file, title, prs: evidence.prs, prs_count: evidence.prs.length, runs: [...evidence.runs].sort((a, b) => a - b),
          base_shas: evidence.baseShas, main_red: mainRed, ...(redSha ? { main_red_base_sha: redSha } : {}), also_failed: evidence.alsoFailed, route: "main-health",
        });
        continue;
      }
    }
    if (evidence.prs.length < policy.filePrs) {
      const watched = byStep("flake_incident.watch").some((r) => r.origin === origin && isCount(r.prs_count) && r.prs_count >= evidence.prs.length);
      if (!watched) deps.log("flake_incident.watch", { origin, file, title, prs: evidence.prs, prs_count: evidence.prs.length, k: policy.filePrs });
      continue;
    }
    try {
      const reason = await openTaskFor(origin);
      if (reason !== undefined) {
        const said = byStep("flake_incident.skipped").some((r) => r.origin === origin && r.reason === reason);
        if (!said) deps.log("flake_incident.skipped", { origin, file, title, reason, prs: evidence.prs });
        continue;
      }
      // After a merged repair, only PRs that failed AFTER the last filing can reopen the incident. W1-T9730: a
      // coverage-shard row is written when its log is read, so it is fresh only for a CI run newer than every run
      // the filing cited. A fix-round row, or any row against a filing that cited no run, is judged by its ts.
      const last = lastFiling(origin);
      const fresh = evidence.prs.filter((pr) => last.maxRunId === undefined
        ? (evidence.latestMs.get(pr) ?? 0) > last.ms
        : (evidence.latestRunId.get(pr) ?? 0) > last.maxRunId || (evidence.latestFixRoundMs.get(pr) ?? 0) > last.ms);
      if (fresh.length < policy.filePrs || filed >= policy.filingsPerPass) continue;
      filedThisPass.set(file, await fileIncident(deps, sources, { origin, file, title, evidence, prs: evidence.prs }));
      filed++;
    } catch (error) {
      deps.log("flake_incident.filing_failed", { origin, error: String((error as Error)?.message ?? error) });
    }
  }
}

/** Whether main's own CI failed the test at a base: `"unread"` when no base could be read, never shown as false. */
export type MainRedAtBase = boolean | "unread";

/** Whether main's own CI failed `file` at any base sha: an unread or cancelled base is no evidence. */
export async function flakeMainRedAt(
  file: string, baseShas: readonly string[], mainFailures: SelectorShadowMainFailures | undefined, log: GardenerDeps["log"],
): Promise<{ mainRed: MainRedAtBase; redSha?: string }> {
  if (mainFailures === undefined || baseShas.length === 0) return { mainRed: "unread" };
  let unread = false;
  for (const sha of baseShas) {
    let failed: readonly string[] | undefined;
    try {
      failed = await mainFailures(sha);
    } catch (error) {
      log("flake_incident.main_unread", { file, base_sha: sha, error: String((error as Error)?.message ?? error) });
    }
    if (failed === undefined) unread = true;
    else if (failed.some((f) => f === file || f.endsWith(`/${file}`))) return { mainRed: true, redSha: sha };
  }
  return { mainRed: unread ? "unread" : false };
}

/** W1-T9694 — THE one main-inherited test, called by this gardener and by the machine-filing judge, so the two
 *  cannot disagree: no retry recovered, and the red failed on `watchPrs` PRs or main's own CI failed it at a base. */
export function flakeIncidentMainInherited(
  evidence: { recovered: number; alsoFailedPrs: number; mainRed: MainRedAtBase },
  policy: Pick<FlakeIncidentPolicy, "watchPrs"> = FLAKE_INCIDENT_POLICY,
): boolean {
  return evidence.recovered === 0 && (evidence.alsoFailedPrs >= policy.watchPrs || evidence.mainRed === true);
}

/** W1-T9694: the harness's own facts about flake-incident records, for the machine-filing judge's evidence line. */
export interface FlakeJudgeEvidencePort {
  /** Each record's retry outcomes from the ledger, read once per pass; a record missing from the map is unread. */
  retries: (tasks: readonly { id: string; origin?: string }[]) => ReadonlyMap<string, FlakeIncidentRecordEvidence>;
  /** Whether main's own CI failed the test at one of the PRs' bases. Absent: unread. */
  mainRedAt?: (file: string, baseShas: readonly string[]) => Promise<{ mainRed: MainRedAtBase; redSha?: string }>;
  /** A main-health repair whose red names the test. */
  repairFor?: (file: string, title: string) => { offendingSha: string; fixPrUrl?: string } | undefined;
}

/** The fields of a main-health repair record a flake judgement reads: what it fixed and the red it named. */
export interface FlakeRepairRecord {
  offendingSha: string;
  fixPrUrl?: string;
  red?: { detail?: readonly string[] };
  inherited?: { testFiles: readonly string[] };
}

/** The judge's facts from the rows and main CI this gardener reads. A completed main verdict at a sha never
 *  changes, so each is read once; `repairs` is read at most once per pass, and a repair names the test as
 *  W1-T9551's rung matches a hint: by its `not ok <title>` line, or for a file-level incident, the file. */
export function flakeJudgeEvidencePort(o: {
  stateDir: string;
  log: GardenerDeps["log"];
  clock: Clock;
  mainFailures: SelectorShadowMainFailures;
  repairs: () => readonly FlakeRepairRecord[];
}): FlakeJudgeEvidencePort {
  const mainReads = new Map<string, readonly string[]>();
  const mainFailures = async (sha: string): Promise<readonly string[] | undefined> => {
    const read = mainReads.get(sha) ?? (await o.mainFailures(sha));
    if (read !== undefined) mainReads.set(sha, read);
    return read;
  };
  let repairs: readonly FlakeRepairRecord[] | undefined;
  return {
    retries: (tasks) => {
      repairs = undefined;
      const rows = readFlakeIncidentRows(o.stateDir, fixedClock(o.clock.now() - FLAKE_INCIDENT_POLICY.windowMs).iso());
      return new Map(tasks.flatMap((t) => {
        const evidence = flakeIncidentRecordEvidence(rows, t.origin ?? "", t.id);
        return evidence === undefined ? [] : [[t.id, evidence] as const];
      }));
    },
    mainRedAt: (file, baseShas) => flakeMainRedAt(file, baseShas, mainFailures, o.log),
    repairFor: (file, title) => {
      repairs ??= o.repairs();
      const hit = repairs.find((r) => (title !== "" ? r.red?.detail?.includes(`not ok ${title}`) : r.inherited?.testFiles.includes(file)) === true);
      return hit === undefined ? undefined : { offendingSha: hit.offendingSha, ...(hit.fixPrUrl ? { fixPrUrl: hit.fixPrUrl } : {}) };
    },
  };
}

/** W1-T9694: a filed flake incident's retry outcomes, as the harness's own ledger rows state them. */
export interface FlakeIncidentRecordEvidence {
  file: string;
  title: string;
  prs: number[];
  recovered: number;
  alsoFailed: number;
  /** Distinct filed PRs with a retry that also failed. */
  alsoFailedPrs: number;
  baseShas: string[];
  runs: number[];
}

/** The evidence for the incident `taskId` filed: the `test.flake_retry` rows of its filed PRs still in the
 *  window, or, when none is, the counts its `flake_incident.filed` row carries. Undefined with no filing row. */
export function flakeIncidentRecordEvidence(
  rows: readonly Record<string, unknown>[], origin: string, taskId: string,
): FlakeIncidentRecordEvidence | undefined {
  const file = flakeIncidentOriginFile(origin);
  const filed = rows.filter((r) => r.step === "flake_incident.filed" && r.task_id === taskId)
    .sort((a, b) => Date.parse(String(b.ts)) - Date.parse(String(a.ts)))[0];
  if (file === undefined || filed === undefined) return undefined;
  const title = origin.slice(`flake-incident:${file}`.length).replace(/^#/, "");
  const prs = (Array.isArray(filed.prs) ? filed.prs.filter(isCount) : []).sort((a, b) => a - b);
  const mine = new Set(prs);
  const seen = observationsOf(rows.filter((r) => r.step === FLAKE_RETRY_STEP))
    .filter((o) => o.file === file && o.title === title && o.prs.some((pr) => mine.has(pr)));
  const retries = seen.filter((o) => o.duplicate !== true);
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter(isCount) : []);
  if (retries.length === 0) {
    return {
      file, title, prs, recovered: isCount(filed.recovered) ? filed.recovered : 0, alsoFailed: isCount(filed.also_failed) ? filed.also_failed : 0,
      alsoFailedPrs: isCount(filed.also_failed_prs) ? filed.also_failed_prs : 0,
      baseShas: Array.isArray(filed.base_shas) ? filed.base_shas.filter((s): s is string => typeof s === "string") : [], runs: ids(filed.run_ids),
    };
  }
  const failed = retries.filter((o) => o.outcome === "also_failed");
  return {
    file, title, prs,
    recovered: retries.length - failed.length,
    alsoFailed: failed.length,
    alsoFailedPrs: new Set(failed.flatMap((o) => o.prs.filter((pr) => mine.has(pr)))).size,
    baseShas: [...new Set(seen.flatMap((o) => (o.baseSha === undefined ? [] : [o.baseSha])))].sort(),
    runs: [...new Set(seen.flatMap((o) => (o.runId === undefined ? [] : [o.runId])))].sort((a, b) => a - b),
  };
}

/** The skip reason {@link runFlakeIncidentGardener}'s open-task read gives an origin already routed to main-health. */
const MAIN_INHERITED_HANDLED = "main-inherited";

/** The title of the test a flake incident's fix adds: both of its proofs name it. Plain words, so it is its own BRE. */
export function flakeIncidentTestTitle(taskId: string): string {
  return `${taskId} pins the cause of the intermittent failure`;
}

async function fileIncident(
  deps: GardenerDeps, sources: FlakeIncidentSources,
  incident: { origin: string; file: string; title: string; evidence: Evidence; prs: number[] },
): Promise<string> {
  const { origin, file, title, evidence, prs } = incident;
  const workspace = await deps.openWorkspace();
  try {
    if (!workspace.branch) throw new Error("flake-incident: filing workspace has no branch for task-id reservation");
    const taskId = await (sources.mintTaskId.async ?? sources.mintTaskId)(workspace.branch);
    const subject = title === "" ? file : `'${title}' (${file})`;
    const runs = [...evidence.runs].sort((a, b) => a - b);
    const rendered = renderMachineShard({
      taskId,
      title: `FLAKE INCIDENT — ${title === "" ? file : `'${title}'`} failed CI on ${prs.length} pull requests whose diffs do not touch it`,
      origin,
      files: [file],
      cost: prs.length,
      // #10298: never `grep: <id> in <file>` — only a comment carries the id, and review caps a comment-only match.
      // 2026-10-10: a `unit test:` proof alone on a test-only record is proof-test-only-discrimination, which
      // lint-plan --base blocks once the judge releases it to verify: auto, so every incident went to a person.
      // The grep reads the pinning test's own `test(` line, code the fix must add, which misses at base.
      // 2026-10-10: Rule 19 sizing reads claim text, so the failing test's TITLE stays out of it: "W1-T4064: the
      // daemon reads filing dates…" read as a second concern. The id names the incident; the rationale quotes the title.
      acceptance: [{
        claim: `the cause of the intermittent failure ${taskId} records in ${file} is fixed, pinned by a test that forces the failing order`,
        proof: `unit test: ${flakeIncidentTestTitle(taskId)}`,
      }, {
        claim: `the test that pins the cause is added to ${file}, beside the test that failed`,
        proof: `grep: test("${flakeIncidentTestTitle(taskId)}" in ${file}`,
      }],
      note: `Filed by the flake-incident gardener (W1-T6406). MACHINE-AUTHORED — the machine-filing judge releases it or escalates it to a person. The SRE ruling of 2026-09-23 is that a CI flake is an incident.`,
      rationale: [
        `Test: ${subject}`,
        `Failed CI on ${prs.length} distinct pull requests whose changed files include neither the test file nor a module it imports: ${prs.map((n) => `#${n}`).join(", ")}.`,
        runs.length > 0 ? `CI runs: ${runs.join(", ")}.` : "CI runs: none; every observation came from a fix round that rerouted the red.",
        `Retry outcomes: ${evidence.recovered} recovered on retry, ${evidence.alsoFailed} also failed on retry${evidence.alsoFailed > 0 ? " (the case that reds a PR)" : ""}.`,
        `Evidence: test.flake_retry ledger rows, ${evidence.coverageShard} read from the PR coverage-shard logs and ${evidence.fixRound} from fix-round reroutes the PR's diff cannot reach.`,
      ],
    });
    if (rendered.refused !== undefined) throw new Error(`flake-incident: task failed lint: ${rendered.refused}`);
    const relativePath = join("plan", "tasks.d", `${taskId.toLowerCase()}-flake-incident.yaml`);
    writeAtomic(join(workspace.root, relativePath), rendered.text);
    const refused = machineShardLandingGuard(deps)(workspace.root, [relativePath]);
    if (refused !== undefined) throw new Error(`flake-incident: task failed lint-plan's machine-filing admission: ${refused}`);
    const stem = (title === "" ? file.split("/").at(-1)! : title).slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const prUrl = await workspace.land({
      paths: [relativePath],
      title: `chore(plan): file ${taskId}, a flake incident in ${stem}`.slice(0, 100),
      body: `${subject} failed CI on ${prs.length} pull requests that do not touch it (${prs.map((n) => `#${n}`).join(", ")}), so it is filed once as a flake incident.\n\n## Acceptance\n\n- claim: the incident is recorded as one machine task\n  proof: grep: ${origin.replace(/[.\[\]*^$\\()+?{}|]/g, "\\$&")} in ${relativePath}`,
    });
    if (!prUrl) throw new Error("flake-incident: task PR was not opened");
    deps.log("flake_incident.filed", {
      origin, task_id: taskId, pr_url: prUrl, file, title, prs, run_ids: runs,
      recovered: evidence.recovered, also_failed: evidence.alsoFailed, also_failed_prs: evidence.alsoFailedPrs, base_shas: evidence.baseShas,
    });
    return taskId;
  } finally {
    await workspace.dispose();
  }
}
