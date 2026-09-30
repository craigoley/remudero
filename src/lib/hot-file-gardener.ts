import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { systemClock, type Clock } from "./clock.js";
import {
  PR_URL_RE,
  ciFrictionRecencyWeight,
  ciFrictionRecordVerdict,
  ciFrictionRoundsFromLedger,
  headPrIndex,
  runPrIndex,
} from "./ci-friction-gardener.js";
import { slug as kebabSlug } from "./feedback-docket.js";
import type { GardenAction, GardenCheckout, GardenerDeps, GardenSpec, Outcome } from "./gardener.js";
import { gardenLedgerBucket } from "./gardener.js";
import { ledgerLivePath, ledgerRotationEntries } from "./ledger-union.js";
import { renderMachineShard } from "./machine-filing.js";
import { resolveRepoLayout } from "./repo-layout.js";
import type { LedgerRecord } from "./retro.js";

/**
 * lib/hot-file-gardener.ts (W1-T4803) — the fleet finds the files its pull requests collide on.
 *
 * The ci-friction gardener prices `merge-conflict` as ONE cause; this one asks WHICH FILES. Every
 * merge-conflict fix round now records its `conflicted_files` ({@link conflictedFilePaths}); a round
 * recorded before that shipped carries none, so a local-git backfill attributes it and MARKS it
 * `inferred` — recorded and inferred minutes are never summed silently into one number.
 *
 * INVARIANT: files are ranked by recency-weighted PR MINUTES their conflicts cost, never by conflict
 * count — ten one-minute conflicts must not outrank two forty-minute ones (this module's falsifier).
 *
 * The costliest file with no task tracking it is filed as ONE plan-only shard naming the remedy that
 * fits its shape ({@link hotFileRemedy}); the four remedies are the spec's classes, so each earns its
 * own Beta record, judged on {@link HotFileGardenSpec}'s metric: the share of merged changes to the
 * files it filed that did NOT strand a pull request in a conflict. Source modules and anything under
 * plan/tasks.d are priced and reported, never filed ({@link hotFileRemedy} returns undefined).
 */

// ── Recording: the fix rung's own row ────────────────────────────────────────────────────────

/** The paths of a merge-conflict fix round's evidence, for the `fix.dispatch` row's
 *  `conflicted_files`. `undefined` when the round carries no conflict evidence (any other mode). */
export function conflictedFilePaths(evidence: { files?: ReadonlyArray<string | { path?: unknown }> } | undefined): string[] | undefined {
  if (evidence === undefined) return undefined;
  const paths = (evidence.files ?? []).map((f) => (typeof f === "string" ? f : f.path)).filter((p): p is string => typeof p === "string" && p !== "");
  return [...new Set(paths)];
}

// ── Attribution: a round's minutes, split across its files ──────────────────────────────────

/** One file's share of one merge-conflict round. */
export interface HotFileRound {
  pr: number;
  file: string;
  minutes: number;
  at?: string;
  /** True when the path came from git history, not from the round's own recorded row. */
  inferred: boolean;
}

/** What the backfill is asked: the PR, when it opened, and when the conflicted round ran. */
export interface HotFileBackfillQuery {
  pr: number;
  openedAt: string;
  at: string;
}
export type HotFileBackfill = (query: HotFileBackfillQuery) => readonly string[];

/**
 * Every merge-conflict round of the ledger, priced exactly as `ciFrictionRoundsFromLedger` prices it
 * and split evenly across the files the round recorded. A round without recorded paths asks
 * `backfill`; what it returns is marked `inferred`, and a round it cannot attribute is counted in
 * `unattributedMinutes` — never dropped, never guessed.
 */
export function hotFileRoundsFromLedger(
  records: readonly LedgerRecord[],
  backfill?: HotFileBackfill,
): { rounds: HotFileRound[]; unattributedMinutes: number } {
  const prByRun = runPrIndex(records);
  const prByHead = headPrIndex(records);
  const openedAt = new Map<number, string>();
  const recorded = new Map<string, string[]>();
  for (const r of records) {
    if (typeof r.ts !== "string") continue;
    if (r.step === "pr.opened" && typeof r.pr_url === "string") {
      const pr = Number(PR_URL_RE.exec(r.pr_url)?.[1]);
      if (Number.isFinite(pr) && !openedAt.has(pr)) openedAt.set(pr, r.ts);
    } else if (r.step === "fix.dispatch" && r.mode === "merge-conflict" && Array.isArray(r.conflicted_files)) {
      const pr = (typeof r.run_id === "string" ? prByRun.get(r.run_id) : undefined) ?? (typeof r.head_sha === "string" ? prByHead.get(r.head_sha) : undefined);
      if (pr !== undefined) recorded.set(`${pr}@${r.ts}`, (r.conflicted_files as unknown[]).filter((p): p is string => typeof p === "string" && p !== ""));
    }
  }
  const rounds: HotFileRound[] = [];
  let unattributedMinutes = 0;
  for (const round of ciFrictionRoundsFromLedger(records)) {
    if (round.cause.kind !== "conflict") continue;
    const own = round.at === undefined ? undefined : recorded.get(`${round.pr}@${round.at}`);
    const opened = openedAt.get(round.pr);
    const inferred = own && own.length > 0 ? [] : round.at !== undefined && opened !== undefined ? [...(backfill?.({ pr: round.pr, openedAt: opened, at: round.at }) ?? [])] : [];
    const files = own && own.length > 0 ? own : inferred;
    if (files.length === 0) {
      unattributedMinutes += round.minutes;
      continue;
    }
    for (const file of files) rounds.push({ pr: round.pr, file, minutes: round.minutes / files.length, at: round.at, inferred: !(own && own.length > 0) });
  }
  return { rounds, unattributedMinutes: Math.round(unattributedMinutes * 10) / 10 };
}

// ── Backfill from local git ─────────────────────────────────────────────────────────────────

/** One commit on main, with the paths it changed. */
export interface MainCommit {
  sha: string;
  at: string;
  subject: string;
  files: string[];
}

/** Main's history since `sinceIso`, read once. `origin/main` when the checkout has it, else HEAD. A
 *  failed read throws: an unreadable history must fail the pass, never read as a quiet main. */
export function readMainHistory(repoRoot: string, sinceIso: string): MainCommit[] {
  const git = (args: string[]) => spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const ref = git(["rev-parse", "--verify", "--quiet", "origin/main"]).status === 0 ? "origin/main" : "HEAD";
  const out = git(["log", ref, `--since=${sinceIso}`, "--format=%x01%H%x09%cI%x09%s", "--name-only"]);
  if (out.status !== 0) throw new Error(`hot-file gardener: git log ${ref} failed: ${String(out.stderr).trim()}`);
  const commits: MainCommit[] = [];
  for (const chunk of String(out.stdout).split("\u0001")) {
    const lines = chunk.split("\n");
    const [sha, at, ...subject] = (lines[0] ?? "").split("\t");
    if (!sha || !at) continue;
    commits.push({ sha, at, subject: subject.join("\t"), files: lines.slice(1).map((l) => l.trim()).filter((l) => l !== "") });
  }
  return commits;
}

/**
 * The files a conflicted PR changed that main ALSO changed between the PR's open and that round — the
 * only files that could have collided. The PR's own changes are those of the squash commit whose
 * subject ends `(#<pr>)`; a PR that never merged has no such commit and yields nothing, never a guess.
 */
export function backfillConflictedFiles(history: readonly MainCommit[], query: HotFileBackfillQuery): string[] {
  const own = history.find((c) => c.subject.trimEnd().endsWith(`(#${query.pr})`));
  if (!own) return [];
  const from = Date.parse(query.openedAt);
  const to = Date.parse(query.at);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  const mainTouched = new Set<string>();
  for (const c of history) {
    const t = Date.parse(c.at);
    if (c.sha !== own.sha && t > from && t <= to) for (const f of c.files) mainTouched.add(f);
  }
  return own.files.filter((f) => mainTouched.has(f)).sort();
}

// ── Pricing: files ranked by PR minutes ─────────────────────────────────────────────────────

export interface HotFilePrice {
  file: string;
  /** Recency-weighted PR minutes this file's conflicts cost — the ONLY field the ranking reads. */
  minutes: number;
  /** The part of `minutes` a round recorded itself, and the part git history inferred. */
  recordedMinutes: number;
  inferredMinutes: number;
  rounds: number;
  prs: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Sum rounds into one row per file, ranked by MINUTES lost, never by how many conflicts. */
export function priceHotFiles(rounds: readonly HotFileRound[], nowMs: number): HotFilePrice[] {
  const rows = new Map<string, { recorded: number; inferred: number; rounds: number; prs: Set<number> }>();
  for (const r of rounds) {
    const row = rows.get(r.file) ?? { recorded: 0, inferred: 0, rounds: 0, prs: new Set<number>() };
    const weighted = r.minutes * ciFrictionRecencyWeight(r.at, nowMs);
    if (r.inferred) row.inferred += weighted;
    else row.recorded += weighted;
    row.rounds += 1;
    row.prs.add(r.pr);
    rows.set(r.file, row);
  }
  return [...rows.entries()]
    .map(([file, r]) => ({ file, minutes: round1(r.recorded + r.inferred), recordedMinutes: round1(r.recorded), inferredMinutes: round1(r.inferred), rounds: r.rounds, prs: r.prs.size }))
    .sort((a, b) => b.minutes - a.minutes || b.rounds - a.rounds || a.file.localeCompare(b.file));
}

// ── Remedies: the four classes ──────────────────────────────────────────────────────────────

export type HotFileRemedy = "generate-in-ci" | "split-per-entry" | "append-only" | "merge-driver";
export const HOT_FILE_REMEDIES: readonly HotFileRemedy[] = ["generate-in-ci", "split-per-entry", "append-only", "merge-driver"];

/** What each remedy asks of the file, in the shard's own words. */
export const HOT_FILE_REMEDY_TEXT: Record<HotFileRemedy, string> = {
  "generate-in-ci": "GENERATE-IN-CI: the file is derivable from the tree, so CI regenerates it and no pull request edits it by hand",
  "split-per-entry": "SPLIT-PER-ENTRY: the file is a keyed map many pull requests each add one key to, so it becomes one file per entry",
  "append-only": "APPEND-ONLY: the file is log-shaped, so entries are only ever appended and two appends never overlap",
  "merge-driver": "MERGE-DRIVER: the file's conflicts are mechanically resolvable, so a .gitattributes merge driver resolves them",
};

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

/**
 * The remedy that fits a file's shape, or `undefined` for a file this gardener must NEVER restructure:
 * a source module (large, not conflict-shaped — priced and reported only) or anything under
 * plan/tasks.d (the plan's own shards).
 */
export function hotFileRemedy(path: string): HotFileRemedy | undefined {
  if (path.startsWith("plan/tasks.d/") || SOURCE_EXT.test(path)) return undefined;
  const name = basename(path).toLowerCase();
  if (/(^|[-_.])(log|logs|ledger|changelog|history)([-_.]|$)|\.(jsonl|ndjson|log)$/.test(name)) return "append-only";
  if (/index|manifest|census|inventory|generated|package-lock|\.lock$/.test(name)) return "generate-in-ci";
  if (/baseline|ratchet|registry|map|ceiling|allowlist/.test(name)) return "split-per-entry";
  return "merge-driver";
}

/** The idempotency key a filed task's `origin:` carries. */
export function hotFileOrigin(file: string): string {
  return `hot-file:${file}`;
}

/** Where a restructuring's landing is recorded — a shard's acceptance proof points here. */
export const HOT_FILE_REMEDIES_FILE = "docs/hot-file-remedies.md";
const HOT_FILE_SLUG_MAX = 72;
/** A file this cheap is noise, not a hot file: nothing is filed below it. */
export const HOT_FILE_MIN_MINUTES = 10;
/** The window of main's history the metric and the backfill read. */
export const HOT_FILE_WINDOW_MS = 28 * 24 * 3_600_000;

/** The costliest file worth restructuring that no plan task tracks — never a source module. */
export function costliestUntrackedHotFile(
  ranked: readonly HotFilePrice[],
  planOrigins: readonly string[],
  exists: (file: string) => boolean = () => true,
): HotFilePrice | undefined {
  const held = new Set(planOrigins);
  return ranked.find((p) => p.minutes >= HOT_FILE_MIN_MINUTES && hotFileRemedy(p.file) !== undefined && !held.has(hotFileOrigin(p.file)) && exists(p.file));
}

/** Render ONE restructuring proposal as a single-record shard — the shard file's whole contents. */
export function hotFileShardYaml(price: HotFilePrice, taskId: string): string {
  const remedy = hotFileRemedy(price.file);
  if (!remedy) throw new Error(`hot-file gardener: ${price.file} is never filed for restructuring`);
  const origin = hotFileOrigin(price.file);
  const inferredNote = price.inferredMinutes > 0 ? ` (${price.inferredMinutes} of them inferred from git history, ${price.recordedMinutes} recorded)` : "";
  const rendered = renderMachineShard({
    taskId,
    title: `HOT FILE ${price.file} — its merge conflicts cost ${price.minutes} PR minute(s) across ${price.rounds} round(s) on ${price.prs} pull request(s), and nothing restructures it: ${remedy}`,
    origin,
    files: [HOT_FILE_REMEDIES_FILE],
    cost: price.minutes,
    acceptance: [{ claim: `${price.file} no longer strands pull requests in merge conflicts: ${HOT_FILE_REMEDY_TEXT[remedy]}`, proof: `grep: ${origin} in ${HOT_FILE_REMEDIES_FILE}` }],
    note: `Filed by the hot-file gardener (W1-T4803). BEFORE: ${price.file} cost ${price.minutes} recency-weighted PR minute(s) across ${price.rounds} conflict round(s) on ${price.prs} pull request(s)${inferredNote}. Remedy: ${HOT_FILE_REMEDY_TEXT[remedy]}. The gardener measures the same file again once this lands and credits or debits the ${remedy} class by whether it stopped conflicting. MACHINE-AUTHORED — the machine-filing judge releases it or escalates it to a person.`,
  });
  if (rendered.refused) throw new Error(`hot-file gardener: drafted record refused by lint (${rendered.refused})`);
  return rendered.text;
}

// ── The gardener spec ───────────────────────────────────────────────────────────────────────

export interface HotFileGardenAction extends GardenAction<HotFileRemedy> {
  price: HotFilePrice;
  origin: string;
}

export interface HotFileInventory {
  ranked: HotFilePrice[];
  unattributedMinutes: number;
  untracked?: HotFilePrice;
  /** Each tracked file's merged changes and how many of them stranded a pull request: the metric. */
  tracked: Array<{ file: string; remedy: HotFileRemedy; merged: number; conflictedPrs: number; minutes: number }>;
}

export interface HotFileGardenSources {
  /** The ledger union's own records — read once per pass. */
  ledgerRecords: () => readonly LedgerRecord[];
  /** Main's history since the given ISO instant — read at most once per pass. */
  mainHistory: (sinceIso: string) => readonly MainCommit[];
  /** Every `origin:` the plan already holds. */
  planOrigins: () => readonly string[];
  /** THE RESERVATION PATH (`ciLearningTaskIdMinter`, run-task.ts), never `max(id)+1`. */
  mintTaskId: (filingBranch?: string) => string;
  /** Whether a ledger-named file still exists in the checkout; a deleted file needs no restructuring. */
  fileExists?: (file: string) => boolean;
}

export function hotFileInventory(sources: HotFileGardenSources, nowMs: number): HotFileInventory {
  const sinceIso = new Date(nowMs - HOT_FILE_WINDOW_MS).toISOString();
  let history: readonly MainCommit[] | undefined;
  const readHistory = (): readonly MainCommit[] => (history ??= sources.mainHistory(sinceIso));
  const { rounds, unattributedMinutes } = hotFileRoundsFromLedger(sources.ledgerRecords(), (q) => backfillConflictedFiles(readHistory(), q));
  const ranked = priceHotFiles(rounds, nowMs);
  const origins = sources.planOrigins();
  const sinceMs = nowMs - HOT_FILE_WINDOW_MS;
  const tracked: HotFileInventory["tracked"] = [];
  for (const origin of origins) {
    if (!origin.startsWith("hot-file:")) continue;
    const file = origin.slice("hot-file:".length);
    const remedy = hotFileRemedy(file);
    if (!remedy) continue;
    const conflictedPrs = new Set(rounds.filter((r) => r.file === file && (r.at === undefined || Date.parse(r.at) >= sinceMs)).map((r) => r.pr)).size;
    tracked.push({ file, remedy, merged: readHistory().filter((c) => c.files.includes(file)).length, conflictedPrs, minutes: ranked.find((p) => p.file === file)?.minutes ?? 0 });
  }
  return { ranked, unattributedMinutes, untracked: costliestUntrackedHotFile(ranked, origins, sources.fileExists), tracked };
}

/** A class's evidence: of the merged changes to the files it filed, how many did NOT strand a pull
 *  request in a conflict. A restructuring that works raises this; one that does not, lowers it. */
export function hotFileMetric(inv: HotFileInventory, remedy: HotFileRemedy): Outcome {
  const mine = inv.tracked.filter((t) => t.remedy === remedy);
  const trials = mine.reduce((s, t) => s + Math.max(t.merged, t.conflictedPrs), 0);
  const conflicted = mine.reduce((s, t) => s + t.conflictedPrs, 0);
  return { trials, successes: Math.max(0, trials - conflicted) };
}

/** The scorecard lists this many ranked files; the rest are counted in `files`. */
const SCORECARD_FILES = 25;

/** The repo's own hot files as a gardener spec (gardener.ts, W1-T4110). */
export function hotFileGardenSpec(
  deps: GardenerDeps,
  sources: HotFileGardenSources,
): GardenSpec<HotFileRemedy, HotFileInventory, HotFileGardenAction, GardenCheckout> {
  const clock: Clock = deps.clock ?? systemClock;
  return {
    name: "hot-file",
    classes: HOT_FILE_REMEDIES,
    cheapFingerprint: () => {
      const head = spawnSync("git", ["-C", deps.repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const live = ledgerLivePath(deps.stateDir);
      const liveStamp = existsSync(live) ? `${statSync(live).ino}:${statSync(live).mode}` : "absent";
      const archives = ledgerRotationEntries(readdirSync(deps.stateDir), deps.stateDir)
        .map((entry) => {
          const stat = statSync(entry.path);
          return `${basename(entry.path)}:${stat.size}:${stat.mtimeMs}`;
        })
        .join("|");
      return `${head}:${gardenLedgerBucket(clock)}:${liveStamp}:${archives}`;
    },
    inventory: () => hotFileInventory(sources, clock.now()),
    // The plan's own `origin:` lines decide whether a file is filed, never a recorded fingerprint alone.
    unfinished: (inv) => inv.untracked !== undefined,
    metric: (inv, remedy) => hotFileMetric(inv, remedy),
    fingerprint: (inv) => `${inv.ranked.map((p) => `${p.file}:${p.minutes}`).join(",")}|${inv.untracked?.file ?? ""}|${inv.tracked.map((t) => `${t.file}:${t.merged}:${t.conflictedPrs}`).join(",")}`,
    candidates: (inv) => {
      const remedy = inv.untracked ? hotFileRemedy(inv.untracked.file) : undefined;
      if (!inv.untracked || !remedy) return [];
      return [
        {
          class: remedy,
          target: inv.untracked.file,
          origin: hotFileOrigin(inv.untracked.file),
          price: inv.untracked,
          reason: `${inv.untracked.file} cost ${inv.untracked.minutes} PR minute(s) in merge conflicts across ${inv.untracked.rounds} round(s) on ${inv.untracked.prs} pull request(s) — the costliest file no task restructures.`,
        },
      ];
    },
    scorecard: (inv) => ({
      files: inv.ranked.length,
      total_minutes: round1(inv.ranked.reduce((s, p) => s + p.minutes, 0)),
      unattributed_minutes: inv.unattributedMinutes,
      untracked: inv.untracked?.file ?? null,
      // Each file's minutes are the BEFORE a later pass reads against; `remedy: null` is a file
      // (a source module, a plan shard) that is priced and reported but never filed.
      ranked: inv.ranked.slice(0, SCORECARD_FILES).map((p) => ({ ...p, remedy: hotFileRemedy(p.file) ?? null })),
      tracked: inv.tracked,
    }),
    apply: (ws, plan) => {
      const action = plan.actions[0];
      if (!action) return undefined;
      if (!ws.branch) throw new Error("hot-file gardener: filing workspace has no branch for task-id reservation");
      const taskId = sources.mintTaskId(ws.branch);
      const contents = hotFileShardYaml(action.price, taskId);
      const verdict = ciFrictionRecordVerdict(contents, `hot-file:${taskId}`);
      if (!verdict.ok) throw new Error(`hot-file gardener: drafted record failed lint (${verdict.reason})`);
      const stem = kebabSlug(`hot-file-${action.price.file}`, HOT_FILE_SLUG_MAX).replace(/-+$/, "");
      const shardDir = join(resolveRepoLayout(ws.root).planDir, "tasks.d");
      const shardPath = join(shardDir, `${taskId}-${stem}.yaml`);
      const relPath = relative(ws.root, shardPath);
      mkdirSync(shardDir, { recursive: true });
      writeFileSync(shardPath, contents);
      const body = [
        "The hot-file gardener (W1-T4803) ranks the files merge conflicts strand pull requests on by the PR minutes they cost.",
        "",
        `- **${action.class}** \`${action.target}\`: ${action.reason}`,
        "",
        "## Acceptance",
        "- claim: the costliest untracked hot file is filed as a parked restructuring task",
        `  proof: grep: ${action.origin} in ${relPath}`,
      ].join("\n");
      // PLAN-ONLY: the shard alone, so Standing rule 15's filing exemption applies.
      return { paths: [relPath], title: `chore(plan): the hot-file gardener files a ${action.class} fix for ${action.target}`, body };
    },
  };
}
