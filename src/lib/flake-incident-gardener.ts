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
 * A test counts toward an incident on a PR only when that PR's diff touches neither the test file nor a
 * source module the test itself imports — a PR that edits the test is a candidate cause, not evidence of
 * a flake. A PR whose file list cannot be read counts as touching, so it is never counted.
 */
import { dirname, join, normalize } from "node:path/posix";
import { fixedClock, systemClock } from "./clock.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import type { GardenerDeps } from "./gardener.js";
import { ledgerRotationDigests, readLedgerUnionRecordsSync } from "./ledger-union.js";
import { machineShardLandingGuard, renderMachineShard } from "./machine-filing.js";
import { selectorShadowPlanTasksAsync, type SelectorShadowTaskIdMinter } from "./selector-shadow-gardener.js";

export const FLAKE_INCIDENT_GARDEN_NAME = "flake-incident";

/** The ledger step the evidence rows carry (selectorShadowFlakeLedger writes them). */
export const FLAKE_RETRY_STEP = "test.flake_retry";

/** Every step a pass reads: the evidence and the gardener's own prior answers. */
export const FLAKE_INCIDENT_EVIDENCE_STEPS: readonly string[] = [FLAKE_RETRY_STEP, "flake_incident.filed", "flake_incident.skipped", "flake_incident.watch"];

/** Bump whenever {@link FLAKE_INCIDENT_EVIDENCE_STEPS} changes: it keys the durable per-rotation digests. */
export const FLAKE_INCIDENT_DIGEST_VERSION = "1";

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

type PlanTaskLite = { id: string; origin?: string; status?: string; retirement?: string };

/** What the gardener reads beyond the ledger union: all injected, so a pass is testable without GitHub. */
export interface FlakeIncidentSources {
  mintTaskId: SelectorShadowTaskIdMinter;
  /** The changed files of base...head. A throw (or an incomplete list) means the list is unreadable. */
  readChangedPaths: (baseSha: string, headSha: string) => string[] | Promise<string[]>;
  /** The plan's tasks, read only when an incident is ready to file. Absent: the daemon checkout's plan. */
  planTasks?: () => PlanTaskLite[] | Promise<PlanTaskLite[]>;
  /** A test file's source, to name the modules it imports. Absent: read from the daemon checkout. */
  readSource?: (file: string) => string | undefined;
  policy?: Partial<FlakeIncidentPolicy>;
}

type RetryOutcome = "recovered" | "also_failed";

interface FlakeObservation {
  file: string;
  title: string;
  prs: number[];
  runId: number;
  shard: number;
  outcome: RetryOutcome;
  headSha?: string;
  baseSha?: string;
  tsMs: number;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The `test.flake_retry` rows that can attribute a failure to a PR, expanded to one per (file, title). */
function observationsOf(rows: readonly Record<string, unknown>[]): FlakeObservation[] {
  const seen = new Set<string>();
  const out: FlakeObservation[] = [];
  for (const row of rows) {
    if (row.source !== "selector-shadow" || typeof row.file !== "string") continue;
    const outcome = row.retry_outcome;
    if ((outcome !== "recovered" && outcome !== "also_failed") || !isCount(row.ci_run_id) || !isCount(row.shard)) continue;
    const prs = Array.isArray(row.pr_numbers) ? row.pr_numbers.filter(isCount) : [];
    if (prs.length === 0) continue;
    const tsMs = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(tsMs)) continue;
    const titles = Array.isArray(row.titles) ? row.titles.filter((t): t is string => typeof t === "string" && t !== "") : [];
    for (const title of titles.length > 0 ? titles : [""]) {
      const key = `${row.ci_run_id}|${row.shard}|${row.file}|${outcome}|${title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        file: row.file, title, prs, runId: row.ci_run_id, shard: row.shard, outcome, tsMs,
        ...(typeof row.head_sha === "string" ? { headSha: row.head_sha } : {}),
        ...(typeof row.base_sha === "string" ? { baseSha: row.base_sha } : {}),
      });
    }
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

/** The repo paths a test file's own relative imports name — the source its failure could come from. */
export function testSourcePaths(file: string, source: string | undefined): string[] {
  if (source === undefined) return [];
  const out = new Set<string>();
  const specifier = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of source.matchAll(specifier)) {
    const resolved = normalize(join(dirname(file), match[1]!));
    out.add(resolved.replace(/\.(?:js|mjs)$/, ".ts"));
    if (!/\.\w+$/.test(resolved)) out.add(`${resolved}.ts`);
  }
  return [...out].sort();
}

interface Evidence {
  prs: number[];
  /** Newest evidence row per PR, for "new since the last filing". */
  latestMs: Map<number, number>;
  runs: Set<number>;
  recovered: number;
  alsoFailed: number;
}

/** One pass. Never throws on a single group's trouble: an unreadable PR is simply not counted. */
export async function runFlakeIncidentGardener(deps: GardenerDeps, sources: FlakeIncidentSources): Promise<void> {
  const policy: FlakeIncidentPolicy = { ...FLAKE_INCIDENT_POLICY, ...sources.policy };
  const clock = deps.clock ?? systemClock;
  const nowMs = clock.now();
  const sinceIso = fixedClock(nowMs - policy.windowMs).iso();
  const steps = new Set(FLAKE_INCIDENT_EVIDENCE_STEPS);
  // The pass runs in a fresh child every time, so each archive in the window is answered from its durable
  // digest and only a rotation cut since the last pass is decompressed.
  const { rows } = readLedgerUnionRecordsSync(deps.stateDir, {
    step: FLAKE_INCIDENT_EVIDENCE_STEPS, since: sinceIso,
    rotationRecords: ledgerRotationDigests(deps.stateDir, (all) => all.filter((r) => steps.has(r.step as string)),
      { holder: FLAKE_INCIDENT_GARDEN_NAME, reducerVersion: FLAKE_INCIDENT_DIGEST_VERSION }).rotationRecords,
  });
  const byStep = (step: string) => rows.filter((r) => r.step === step);
  const observations = observationsOf(byStep(FLAKE_RETRY_STEP));

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
    const own = new Set([file, ...testSourcePaths(file, readSource(file))]);
    // A PR counts only when EVERY row it has in the group is clear of the test and its source.
    const verdict = new Map<number, boolean>();
    for (const o of group) {
      let clear = false;
      if (o.baseSha !== undefined && o.headSha !== undefined) {
        const paths = await changedPaths(o.baseSha, o.headSha);
        clear = paths !== undefined && ![...own].some((p) => paths.has(p));
      }
      for (const pr of o.prs) verdict.set(pr, (verdict.get(pr) ?? true) && clear);
    }
    const counted = group.filter((o) => o.prs.some((pr) => verdict.get(pr) === true));
    const prs = [...new Set(counted.flatMap((o) => o.prs.filter((pr) => verdict.get(pr) === true)))].sort((a, b) => a - b);
    const latestMs = new Map<number, number>();
    for (const o of counted) for (const pr of o.prs) if (verdict.get(pr) === true) latestMs.set(pr, Math.max(latestMs.get(pr) ?? 0, o.tsMs));
    return {
      prs, latestMs, runs: new Set(counted.map((o) => o.runId)),
      recovered: counted.filter((o) => o.outcome === "recovered").length,
      alsoFailed: counted.filter((o) => o.outcome === "also_failed").length,
    };
  };

  let plan: PlanTaskLite[] | undefined;
  const planTasks = async (): Promise<PlanTaskLite[]> => (plan ??= await (sources.planTasks ?? (() => selectorShadowPlanTasksAsync(deps.repoRoot)))());
  const closed = new Set(["merged", "done"]);
  /** The open task for an origin: in the plan and neither merged nor retired, or filed by this gardener
   *  recently enough that its PR may not have landed. */
  const openTaskFor = async (origin: string): Promise<string | undefined> => {
    const tasks = await planTasks();
    const file = flakeIncidentOriginFile(origin);
    const sameFile = (o: unknown) => typeof o === "string" && (o === origin || (file !== undefined && flakeIncidentOriginFile(o) === file));
    const open = tasks.find((t) => sameFile(t.origin) && !closed.has(t.status ?? "") && t.retirement === undefined);
    if (open) return open.id;
    if (file !== undefined && filedThisPass.has(file)) return filedThisPass.get(file);
    const filed = byStep("flake_incident.filed").filter((r) => sameFile(r.origin) && typeof r.task_id === "string")
      .sort((a, b) => Date.parse(String(b.ts)) - Date.parse(String(a.ts)))[0];
    if (filed && !tasks.some((t) => t.id === filed.task_id) && nowMs - Date.parse(String(filed.ts)) < policy.pendingFilingHoldMs) {
      return filed.task_id as string;
    }
    return undefined;
  };
  const lastFiledMs = (origin: string): number => Math.max(0, ...byStep("flake_incident.filed")
    .filter((r) => r.origin === origin || (typeof r.origin === "string" && flakeIncidentOriginFile(r.origin) === flakeIncidentOriginFile(origin)))
    .map((r) => Date.parse(String(r.ts))).filter(Number.isFinite));
  const filedThisPass = new Map<string, string>();

  let filed = 0;
  for (const group of candidates) {
    const { file, title } = group[0]!;
    const origin = flakeIncidentOrigin(file, title);
    const evidence = await evidenceOf(group);
    if (evidence.prs.length < policy.watchPrs) continue;
    if (evidence.prs.length < policy.filePrs) {
      const watched = byStep("flake_incident.watch").some((r) => r.origin === origin && isCount(r.prs_count) && r.prs_count >= evidence.prs.length);
      if (!watched) deps.log("flake_incident.watch", { origin, file, title, prs: evidence.prs, prs_count: evidence.prs.length, k: policy.filePrs });
      continue;
    }
    try {
      const open = await openTaskFor(origin);
      if (open !== undefined) {
        const reason = `open-task ${open}`;
        const said = byStep("flake_incident.skipped").some((r) => r.origin === origin && r.reason === reason);
        if (!said) deps.log("flake_incident.skipped", { origin, file, title, reason, prs: evidence.prs });
        continue;
      }
      // After a merged repair, only PRs that failed AFTER the last filing can reopen the incident.
      const since = lastFiledMs(origin);
      const fresh = evidence.prs.filter((pr) => (evidence.latestMs.get(pr) ?? 0) > since);
      if (fresh.length < policy.filePrs || filed >= policy.filingsPerPass) continue;
      filedThisPass.set(file, await fileIncident(deps, sources, { origin, file, title, evidence, prs: evidence.prs }));
      filed++;
    } catch (error) {
      deps.log("flake_incident.filing_failed", { origin, error: String((error as Error)?.message ?? error) });
    }
  }
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
      acceptance: [{
        claim: `the cause of ${subject}'s intermittent failure is fixed in ${file}, pinned by a test that forces the failing order`,
        proof: `unit test: ${taskId} pins the cause of the intermittent failure`,
      }],
      note: `Filed by the flake-incident gardener (W1-T6406). MACHINE-AUTHORED — the machine-filing judge releases it or escalates it to a person. The SRE ruling of 2026-09-23 is that a CI flake is an incident.`,
      rationale: [
        `Test: ${subject}`,
        `Failed CI on ${prs.length} distinct pull requests whose changed files include neither the test file nor a module it imports: ${prs.map((n) => `#${n}`).join(", ")}.`,
        `CI runs: ${runs.join(", ")}.`,
        `Retry outcomes: ${evidence.recovered} recovered on retry, ${evidence.alsoFailed} also failed on retry${evidence.alsoFailed > 0 ? " (the case that reds a PR)" : ""}.`,
        "Evidence: test.flake_retry ledger rows read from the PR coverage-shard logs.",
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
      recovered: evidence.recovered, also_failed: evidence.alsoFailed,
    });
    return taskId;
  } finally {
    await workspace.dispose();
  }
}
